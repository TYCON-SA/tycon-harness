#!/usr/bin/env node
'use strict';
// harness.js — UN solo mecanismo para instalar y mantener al día el arnés, para el equipo y para el público (story 8.13).
//
// Hoy (2026-09-30, medición en tasks/measurement-8.13-un-solo-mecanismo/) el arnés se instala con una línea de arranque que
// cada dev escribe a mano y un instalador de 115 KB en bash sin versión, sin vuelta atrás, sin registro de lo que escribió
// y con 22 copias de seguridad sin tope. Este programa toma el lugar de la línea de arranque y envuelve al instalador —que
// sigue siendo EL QUE APLICA los hooks, bloques y enlaces en la máquina—: estado con fuentes, candado propio, copia fija de
// arranque fuera del árbol que actualiza (doctrina «lo durable no viaja por el camino roto»), política por configuración
// (canal `latest`|`stable`, aplicación `auto`|`ask`), y un diagnóstico que no toca nada.
//
// Corre con Node ≥ 20 (el piso real del equipo y del nocturno; la portada pública pide 22, que es más), sin dependencias,
// una sola implementación para Mac, Linux y Windows. Es núcleo público: no lee el perfil del equipo ni el mapa de
// renombres; sólo `scripts/lib/tycon-config.js` (la configuración) y `scripts/lib/canonical-path.js` (el enlace).
//
// Subcomandos (la tabla de §Cómo funciona de la story; ninguno más):
//   install [--channel <c>] [--local <clon>] [--from-existing] [--source <url>]
//   startup [--force]            · update [--check] [--dry-run] [--yes]   · apply
//   version [--json]             · doctor [--json] [--fetch]              · channel [latest|stable]
//   rollback [--to <copia>] [--list] [--release]  · uninstall [--dry-run] [--yes]   (llegan en la tanda C)
//   link --local <clon> [--allow-temporary] | link --managed
//   team-config [--no-open] [--team-clone <c>] [--operations-clone <c>]   (la página local, de sólo lectura, de la
//                                configuración de la organización; harness/team-config.js)
//   relocate [--check]           (story 8.19: muda a mano lo registrado por el nombre viejo del lugar; harness/relocate.js)
//   layer [--check] [--list] [--json] [--public <copia>] [--harness-clone <clon>]   (story 8.13.1: la capa privada, sólo
//                                leyendo; harness/layer.js) · install --harness-clone <clon> (de dónde se lee la capa)
//
// Story 8.13.1, tanda A (AC 5): en una máquina con fuentes `layer`, `doctor` prueba sin escribir que público + capa =
// interno (`layerFacts`: cada archivo del commit de la capa en el árbol con su contenido, lo que no viene de ninguna
// fuente, la compatibilidad por la lista de transformados de version.json y por lo que el interno publica, el clon de
// lectura, el árbol gestionado y la capa al mínimo). Las líneas van aparte de las del lugar. Sin fuentes `layer`, doctor es el de siempre.
// (AC 7-9) En `source: public` con fuentes `layer`, `update` trae también `main` del interno a su clon de lectura (--bare,
// ~/.claude/.tycon-pipeline/harness/sources/internal, con --reference al clon de la persona), elige el commit de la capa
// por compatibilidad (`pickLayerCommit`) y mueve las dos fuentes o ninguna; con el público al día mueve «sólo la capa».
// Los topes de red valen para las dos juntas. `install --harness-clone <clon>` sobre una copia pública arma esa fuente y
// apila la capa antes del aplicador. Sin fuentes `layer`, update e install son los de la 8.13.
//
// Salidas: 0 bien · 1 falta un requisito (install) o la actualización no quedó sana · 2 uso, o un estado que no sirve ·
// 3 no instalado, otra sesión, o «hay versión nueva» (update --check). `startup` sale 0 siempre: una sesión nunca se
// frena por el arnés.
//
// Estado: ~/.claude/.tycon-pipeline/harness-state.json · candado y registro: ~/.claude/.tycon-pipeline/harness/ ·
// la copia fija de arranque: ~/.claude/.tycon-pipeline/harness/bootstrap.js (+ los dos respaldos en shell) ·
// las copias de seguridad (tanda B): ~/.claude/.tycon-pipeline/harness/backups/<fecha>/, una ANTES de cada cambio.
// Los módulos: scripts/setup/harness/{state,lock,sources,channel,report,startup-line,managed,snapshot,shared}.js.
//
// Tanda B (AC 15-18): el aplicador corre con `--report-json` y `TYCON_HARNESS_SNAPSHOT_DIR` (sin sus `.bak` propios: la
// copia ya la tomó el mecanismo); lo que reporta se funde en `managed` (managed.js) y `doctor` lo compara con la máquina.
//
// Tanda D (AC 28): tres piezas son COMPARTIDAS con el aplicador —`cleanupPeriodDays`, la variable de `env` y los comandos
// de barra—. Las hace este programa antes de lanzarlo (shared.js), se lo avisa con `TYCON_HARNESS_SHARED_DONE=1` para que
// las saltee, y las anota en `managed`. `install --from-existing` no las hace: ahí el aplicador corre suelto.
//
// Tanda D (AC 25, 26, 29): los canales deciden. Un clon cuyo `origin` está en la lista que trae el árbol
// (`scripts/setup/public-remotes.json`; en un clon interno no existe) es «el público»: `latest` lee `mirror/sync` y
// `stable` lee `main`, los dos con rama local `tycon/installed` + `reset --hard`, y «no bajar» se decide por número
// (sources.js, version-order.js). El canal tiene UNA verdad —la configuración— y el estado la copia en cada `startup` y
// `update`. Con `apply: ask`, `startup` deja el aviso (número, sha, comando y dónde ver los cambios) y mira la red una vez
// cada 6 horas; `update --yes` pide una terminal. En una copia pública, `latest` + `auto` pide confirmación y `doctor` lo
// recuerda. `install --source <url>` re-fija la fuente cuyo `origin` es esa URL.
//
// Story 8.18 (AC 31 a 35): los dos repos internos se unieron. Con la llave `update.skills_source` en `unified`, `startup`
// y `update` re-apuntan el clon viejo de agent-skills al repo unificado ANTES de mirar si hay versión nueva, y lo deshacen
// si la llave vuelve a `separate` (harness/repoint.js: ahí está el cómo y el porqué). Si ese clon no puede pasar, no se
// mueve NINGUNA fuente. Y una fuente de la que salen las skills nunca avanza a una punta que no las trae (`doUpdate`).
// Lo que cerró el pase adversarial del tramo 3 de este lado: `install` sobre el mismo árbol vuelve a detectar las fuentes
// (`redetectSources`: la máquina de dos clones que pasó a un solo árbol); `update` pedido a mano destraba el freno «no
// avanza en línea recta» cuando el repo unificado ya lo arregló (`unblockStraightLine`); y «no pude leer si de esa fuente
// salen las skills» no es «no salen»: no se mueve nada y se dice.

// ── el piso de Node, ANTES de cargar nada (AC 1): un node viejo imprime una línea y sale 2 ────────────────────────────
const NODE_FLOOR = 20;
{
  const major = parseInt(String(process.versions.node).split('.')[0], 10);
  if (!(major >= NODE_FLOOR)) {
    process.stderr.write(`harness.js: Node ${process.versions.node} < ${NODE_FLOOR} — instalá Node ${NODE_FLOOR}+ (la portada pública pide 22) y volvé a correrlo\n`);
    process.exit(2);
  }
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TREE = path.resolve(__dirname, '..', '..');   // el clon donde vive este archivo
// el lugar del arnés y el nombre viejo (story 8.19): una sola definición, en harness/place.js (viaja con la copia fija)
const PLACE = require('./harness/place.js');
const LINK_NAME = PLACE.PLACE_NAME;
// Cada cuánto sale `startup` a la red, según la política (tanda D, AC 26): en `auto` una sesión que arranca < 10 min
// después de otra no vuelve a salir; en `ask` como mucho una vez cada 6 horas (lo que encontró queda en `notice`). Un
// intento que no pudo mirar NO cuenta como mirada: se reintenta pasados 10 min (`last_fetch_failed`), no a las 6 horas.
const FETCH_WINDOW_MS = { auto: 10 * 60 * 1000, ask: 6 * 60 * 60 * 1000 };
const FETCH_RETRY_MS = 10 * 60 * 1000;
const BOOTSTRAP_FILES = ['bootstrap.js', 'bootstrap-fallback.sh', 'bootstrap-fallback.ps1'];
const PROGRAM_DIR = 'program';                      // la copia fija del programa (tanda C): harness/program/
// la línea que carga el índice (INDEX.md desde 2026-10-14); escrita con el nombre viejo del lugar (story 8.19, AC 11) o
// apuntando al README.md de antes, ya está: se reescribe a la de hoy en su lugar (import-line.js)
const IMPORT = require('./harness/import-line.js');
const IMPORT_LINE = IMPORT.IMPORT_LINE;
const IMPORT_LINES = IMPORT.ALL_FORMS;
const APPLIER_TIMEOUT_MS = 15 * 60 * 1000;

// La tabla cerrada: subcomando → opciones (flag | value) y, si acepta, los valores sueltos (positional).
const COMMANDS = {
  install:   { opts: { '--channel': 'value', '--local': 'value', '--from-existing': 'flag', '--source': 'value', '--dry-run': 'flag', '--yes': 'flag', '--profile': 'value', '--integrations': 'value', '--packs': 'value', '--harness-clone': 'value', '--version': 'value', '--repo': 'value', '--tool': 'list', '--team': 'value', '--defaults': 'flag' }, help: 'primera instalación desde un clon: pregunta lo que no puede decidir solo (con terminal), muestra el plan y pide conformidad (--dry-run sólo lo muestra; --yes lo acepta sin terminal pero no elige; --defaults contesta solo lo que nadie fijó —instalación mínima, ninguna integración, sin paquete— y, con la versión bajada, muestra el plan corto de cinco renglones; lo fijado por opción, variable, archivo o perfil del equipo gana; --profile minimal|full elige cuánto se instala; --integrations <lista|none> y --packs all|none|<a,b> contestan las otras dos preguntas; --harness-clone <clon> dice de qué clon interno se lee la capa privada); después enlace, estado, copia fija de arranque, línea de arranque, @import, aplicador. --version <número|latest> (story 8.23, tanda B): en una máquina SIN arnés, baja esa versión publicada de GitHub como archivos verificados a ~/.tycon/harness, sin git (--repo <org/nombre> si el árbol no declara el repo). --tool claude|codex (repetible; story 8.23, tanda C): qué herramientas enchufar; sin la opción, las que detecta en la máquina (el plan las nombra). --team <org>/<repo> (story 8.25): baja también la capa del equipo —el perfil y la llave del buzón— de ese repo privado, con el mismo permiso, y la apila sobre la versión bajada; el estado la recuerda y update la lleva a cada versión nueva' },
  // `freeAfter: 2` (story 8.23, tanda G · AC 43): después del verbo y la clave, un valor suelto (`config set paths.maintained <ruta>`);
  // el secreto no va por ahí (cmdConfig lo rechaza con el motivo)
  // las claves de la tabla salen de github-auth.js (KEYS): una clave que cmdConfig acepta y la tabla no, se rechaza antes de llegar
  // (pase adversarial 8.25 A1a-azure: `config set azure.token` —la acción que recomiendan todos los mensajes— salía 2 acá)
  config:    { opts: {}, positional: ['set', 'unset', 'show', 'github.token', 'azure.token', 'paths.maintained', 'paths.maintainers', 'paths.team', 'paths.operations'], freeAfter: 2, help: 'la configuración propia del arnés en ~/.tycon/config.json (story 8.23, tanda B): `config set <clave> [<valor>]` guarda el valor (por argumento, por stdin, o pedido en la terminal); `config set github.token` lee el permiso de sólo lectura de GitHub por stdin o lo pide en la terminal SIN eco —nunca por argumento, nunca lo imprime— y lo guarda sólo para tu usuario; `config set azure.token` hace lo mismo con el PAT de Azure DevOps del repo del equipo (story 8.25); `config unset <clave>` lo saca; `config show` dice qué claves hay (sin valores)' },
  startup:   { opts: { '--force': 'flag' }, help: 'lo que corre la línea de arranque de cada sesión (sale 0 siempre)' },
  update:    { opts: { '--check': 'flag', '--dry-run': 'flag', '--yes': 'flag' }, help: 'trae la punta del canal de cada fuente y, si hay versión nueva, la aplica (0 al día · 3 hay nueva · 2 no pude mirar, con --check)' },
  apply:     { opts: { '--dry-run': 'flag' }, help: 'corre el aplicador (install-tycon-hooks.sh / .ps1); --dry-run muestra lo que cambiaría, sin escribir' },
  version:   { opts: { '--json': 'flag' }, help: 'versión instalada, canal, modo, fuentes y shas' },
  doctor:    { opts: { '--json': 'flag', '--fetch': 'flag' }, help: 'diagnóstico de sólo lectura (--fetch es la única excepción: escribe FETCH_HEAD; además le pregunta al remoto del clon de la lista del freno antes de publicar si está al día, sin escribir nada)' },
  channel:   { opts: {}, positional: ['latest', 'stable'], help: 'muestra o fija el canal en ~/.claude/tycon.json' },
  rollback:  { opts: { '--to': 'value', '--list': 'flag', '--release': 'flag' }, help: 'vuelve atrás por piezas y deja una retención (tanda C)' },
  uninstall: { opts: { '--dry-run': 'flag', '--yes': 'flag', '--tool': 'list' }, help: 'quita sólo lo registrado (tanda C); --tool claude|codex desenchufa sólo esa herramienta y deja el arnés (story 8.23, tanda C)' },
  link:      { opts: { '--local': 'value', '--allow-temporary': 'flag', '--managed': 'flag' }, help: 'modo desarrollador: el enlace apunta a un clon propio (--local) o vuelve a managed (--managed)' },
  migrate:   { opts: { '--to-home': 'flag', '--dry-run': 'flag', '--repo': 'value', '--team': 'value' }, help: `muda esta máquina del clon a ~/.tycon: la versión bajada en ~/.tycon/harness, el estado y la configuración en ~/.tycon, los enchufes al árbol nuevo, el clon intacto (story 8.23, tanda D); --dry-run dice el plan sin escribir; --team <org>/<repo> (story 8.25) apila la capa del equipo sobre la versión bajada (sin la opción, la clave team de public-repos.json del clon; con capa, el perfil del clon no se funde en la configuración)` },
  relocate:  { opts: { '--check': 'flag' }, help: `muda a mano lo registrado por el nombre viejo ~/.claude/${PLACE.LEGACY_PLACE_NAME} al lugar ~/.claude/${PLACE.PLACE_NAME} (--check dice qué cambiaría, sin escribir)` },
  'team-config': { opts: { '--no-open': 'flag', '--team-clone': 'value', '--operations-clone': 'value' }, help: 'abre en el navegador la página local que muestra, de sólo lectura, la configuración de la organización: dónde vive cada repo (team-repos.json, en el clon del perfil del equipo), a quién se asignan los avisos (operations.json, en el clon de operaciones) y el resto de sus secciones, con los problemas que ven los lectores. Se edita en el sitio de la organización, o con un pedido al repo de operaciones si no hay sitio. Las carpetas de los clones se guardan como paths.team y paths.operations; --team-clone y --operations-clone las usan sólo esta vez, sin guardarlas. --no-open imprime la dirección sin abrir el navegador' },
  'team-init': { opts: { '--dir': 'value', '--name': 'value', '--platform': 'value', '--profile-repo': 'value', '--dry-run': 'flag', '--stories': 'value', '--no-stories': 'flag', '--stories-only': 'flag', '--local': 'flag' }, help: 'da de alta tu organización (story 8.40): pregunta el nombre, la plataforma (github|azure|local), la dirección del repo del perfil y la carpeta (lo que no vino por opción), baja el ejemplo publicado y deja en la carpeta los tres archivos obligatorios del perfil del equipo, validados con los lectores de la versión instalada; después dice cómo crear el repo vacío, ofrece subirlo con git y ofrece instalar esta máquina con --team. Al final ofrece el repo de historias del equipo con su portón (las plantillas de scripts/setup/harness/team-stories/, al lado de la carpeta del perfil): --stories <nombre> lo arma sin preguntar, --no-stories lo saltea y --stories-only arma sólo ese repo (en --dir). No crea repos ni pide credenciales. --dry-run muestra los archivos sin escribir. --local (o «local» como plataforma) arma el perfil de una persona sola en esta máquina, sin dirección ni cuenta: la declaración y el perfil con git y un commit en main; el arnés lo lee de esa carpeta (install --team <carpeta>) y se puede subir después. Sin arnés instalado sale 2' },
  layer:     { opts: { '--check': 'flag', '--list': 'flag', '--json': 'flag', '--public': 'value', '--harness-clone': 'value' }, help: 'la capa privada, sólo leyendo: qué agregó, qué pisó, qué está editado a mano (--check sale 0 si está entera, 1 si falta o sobra algo, 3 si no hay capa; --list nombra cada archivo; --public <copia> y --harness-clone <clon> calculan contra esa copia y ese clon sin tocar el estado)' },
};

function usage() {
  const L = ['uso: node scripts/setup/harness.js <subcomando> [opciones]', ''];
  for (const [name, c] of Object.entries(COMMANDS)) {
    const opts = Object.entries(c.opts).map(([o, k]) => (k === 'value' || k === 'list' ? `${o} <valor>` : o));
    const pos = c.positional ? [`[${c.positional.join('|')}]`] : [];
    L.push(`  ${[name, ...pos, ...opts].join(' ')}`);
    L.push(`      ${c.help}`);
  }
  L.push('', 'variables: TYCON_UPDATE_CHANNEL · TYCON_UPDATE_APPLY · TYCON_UPDATE=0 · TYCON_UPDATE_NETWORK_BUDGET_S (15) · TYCON_UPDATE_SKILLS_SOURCE (separate | unified) · TYCON_INSTALL_PROFILE (minimal | full)');
  return L.join('\n');
}

/** Parsea argv contra la tabla. Devuelve { cmd, opts, args } o { error }. */
function parse(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { help: true };
  const cmd = argv[0];
  const spec = COMMANDS[cmd];
  if (!spec) return { error: `subcomando desconocido: «${cmd}». Los que existen: ${Object.keys(COMMANDS).join(', ')}` };
  const opts = {};
  const args = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true, cmd };
    if (a.startsWith('-')) {
      const kind = spec.opts[a];
      if (!kind) return { error: `opción desconocida «${a}» para ${cmd}. Opciones: ${Object.keys(spec.opts).join(', ') || '(ninguna)'}` };
      if (kind === 'value' || kind === 'list') {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('-')) return { error: `${a} necesita un valor` };
        // `list`: la opción es repetible y junta sus valores (story 8.23, tanda C: `--tool claude --tool codex`)
        if (kind === 'list') (opts[a.slice(2)] = opts[a.slice(2)] || []).push(v); else opts[a.slice(2)] = v;
        i++;
      } else opts[a.slice(2)] = true;
      continue;
    }
    if (spec.positional && spec.positional.includes(a)) { args.push(a); continue; }
    // un valor suelto después de los posicionales reconocidos, donde el comando lo admite (`freeAfter`)
    if (spec.freeAfter && args.length >= spec.freeAfter) { args.push(a); continue; }
    return { error: `valor inesperado «${a}» para ${cmd}${spec.positional ? ` (acepta: ${spec.positional.join(' | ')})` : ''}` };
  }
  return { cmd, opts, args };
}

// ── módulos (carga perezosa: `--help` y un error de uso no cargan nada) ─────────────────────────────────────────────
const mod = (name) => require(`./harness/${name}.js`);

// ── ayudantes ───────────────────────────────────────────────────────────────────────────────────────────────────────
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const isWin = (ctx) => ctx.platform === 'win32';
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** ¿Dos archivos de texto con el mismo contenido salvo los finales de línea (`\r\n` contra `\n`)? Uno con un byte nulo
 *  es binario y no se iguala; uno ilegible, tampoco (no se da por igual lo que no se pudo leer). */
function sameTextIgnoringEol(a, b) {
  try {
    const [x, y] = [fs.readFileSync(a), fs.readFileSync(b)];
    if (x.includes(0) || y.includes(0)) return false;
    return x.toString('latin1').replace(/\r\n/g, '\n') === y.toString('latin1').replace(/\r\n/g, '\n');
  } catch (_) { return false; }
}
const sha7 = (s) => (s ? String(s).slice(0, 7) : '—');
const nowIso = () => new Date().toISOString();
// El tope de red de `update` (8.13 AC 3, 8.13.1 AC 9) es del comando ENTERO: se cuenta desde que arrancó el proceso
// (con el arranque de node), y la última salida a la red deja medio segundo para cerrar (grabar el estado y salir).
// Antes cada fuente contaba desde que empezaba `doUpdate`, en segundos enteros, y el total pasaba de 15 s (pase
// adversarial de la tanda A, C7).
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const UPDATE_WRAPUP_MS = 500;
/** Desde cuándo corre el tope de `update`: el arranque del proceso; si el proceso es más viejo que el tope entero (quien
 *  carga harness.js como módulo y lo llama varias veces, como las pruebas), desde ahora. */
const commandClockStart = (env) => (Date.now() - PROCESS_STARTED_AT < mod('sources').budgetOf(null, env) * 1000 ? PROCESS_STARTED_AT : Date.now());
const linkPath = (home) => path.join(home, '.claude', LINK_NAME);
const settingsPath = (ctx) => ctx.env.TYCON_SETTINGS_PATH || path.join(ctx.home, '.claude', 'settings.json');
const claudeMdPath = (ctx) => ctx.env.CLAUDE_MD_PATH || path.join(ctx.home, '.claude', 'CLAUDE.md');
const isHarnessClone = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, 'scripts', 'install-tycon-hooks.sh'));
const applierPath = (ctx, tree) => path.join(tree, 'scripts', isWin(ctx) ? 'install-tycon-hooks.ps1' : 'install-tycon-hooks.sh');

/** ¿`name` está en el PATH? Devuelve la ruta o null (`command -v` / `where`, sin shell). En Windows reconoce el alias de
 *  ejecución de la Microsoft Store (`tools.runnableAt`); el sistema y `fsApi` se inyectan sólo en las pruebas. */
function findInPath(name, env, { platform = process.platform, fsApi = fs } = {}) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const { runnableAt } = mod('tools');
  for (const d of dirs) for (const ext of exts) {
    const p = path.join(d, name + ext);
    if (runnableAt(p, platform, fsApi)) return p;
  }
  return null;
}
function versionOf(bin, env, args = ['--version']) {
  const r = spawnSync(bin, args, { windowsHide: true, encoding: 'utf8', env, timeout: 10000 });
  return r.status === 0 ? String(r.stdout || r.stderr || '').trim().split('\n')[0] : null;
}

/** Lo que el aplicador necesita en el PATH, por sistema. En Windows NO se pide `python3`: el aplicador de ahí
 *  (`install-tycon-hooks.ps1`) no usa Python (tanda D, A28: la misma decisión que la 8.7 tomó para el `.ps1`). */
function requirementsFor(platform, { release = false } = {}) {
  const list = platform === 'win32' ? ['git', 'pwsh'] : ['git', 'python3', 'bash'];
  // la versión bajada (story 8.23, tanda B) no usa git para nada: no es un requisito de esa máquina
  return release ? list.filter((n) => n !== 'git') : list;
}
/** Cómo se instala cada requisito en Windows (story 8.17): el mensaje de «falta» lo trae, para que la persona no tenga
 *  que ir a buscarlo. Sólo Windows: es donde el equipo llega con una máquina sin PowerShell 7 (trae el 5.1). */
const INSTALL_HINT = { win32: { git: 'winget install Git.Git', pwsh: 'winget install Microsoft.PowerShell' } };
const installHint = (platform, name) => { const h = (INSTALL_HINT[platform] || {})[name]; return h ? ` — instalar: ${h}` : ''; };
/** Cada requisito del aplicador con lo que hay en la máquina: `{ name, path, version, problem }` (`problem` es null si
 *  está bien). Una sola lectura para `install` (frena con el primero que falla) y para `doctor` (los lista todos). */
function requirementChecks(ctx, { release = false } = {}) {
  const all = isWin(ctx) ? `${release ? '' : 'Git, '}PowerShell 7 (pwsh) y Node ${NODE_FLOOR}+` : `${release ? '' : 'Git, '}Bash, Python 3 y Node ${NODE_FLOOR}+`;
  return requirementsFor(ctx.platform, { release }).map((n) => {
    const p = findInPath(n, ctx.env);
    if (!p) return { name: n, path: null, version: null, problem: `falta ${n} en el PATH — requisitos: ${all} (ver los requisitos de la portada)${installHint(ctx.platform, n)}` };
    // cada uno con su versión (AC 4 paso 0): uno que está y no arranca cuenta como faltante
    const v = versionOf(p, ctx.env);
    if (!v) return { name: n, path: p, version: null, problem: `${n} está en el PATH (${p}) pero no responde a --version — requisitos: ${all}${installHint(ctx.platform, n)}` };
    // `pwsh` también se llama así en PowerShell 6: el aplicador pide 7 (y lo rechaza con su propio mensaje)
    const major = n === 'pwsh' ? parseInt((/(\d+)\.\d+/.exec(v) || [])[1], 10) : null;
    if (n === 'pwsh' && major < 7) return { name: n, path: p, version: v, problem: `pwsh está en el PATH (${p}) pero es ${v}: hace falta PowerShell 7 o más nuevo — requisitos: ${all}${installHint(ctx.platform, n)}` };
    return { name: n, path: p, version: v, problem: null };
  });
}
/** Los requisitos del aplicador (AC 4 paso 0): node (el piso ya se comprobó), git, y bash + python3 | pwsh. */
function missingRequirement(ctx, { release = false } = {}) {
  const bad = requirementChecks(ctx, { release }).find((r) => r.problem);
  return bad ? bad.problem : null;
}

/** agent-skills: ~/.claude/agent-skills/skills/tycon-pipeline, o skills/ y agents/ en la raíz del clon (8.7 AC 18). */
function skillsPresent(ctx, tree) {
  if (fs.existsSync(path.join(ctx.home, '.claude', 'agent-skills', 'skills', 'tycon-pipeline'))) return true;
  return fs.existsSync(path.join(tree, 'skills')) && fs.existsSync(path.join(tree, 'agents'));
}

/** El enlace estable, con la biblioteca del árbol (crea / repara / re-apunta con --link; nunca pisa una carpeta real). */
function ensureLink(ctx, tree, { link = null, check = false, prefer = null } = {}) {
  const lib = path.join(tree, 'scripts', 'lib', 'canonical-path.js');
  if (!fs.existsSync(lib)) return { ok: false, out: `sin ${lib}: no puedo asegurar el enlace` };
  const args = [lib, '--ensure-link', '--clone', tree, '--home', ctx.home];
  if (link) args.push('--link', link);
  if (prefer && !link) args.push('--prefer', prefer);   // el destino de nacimiento que dice el estado (8.19, AC 5)
  if (check) args.push('--check');
  const r = spawnSync(process.execPath, args, { windowsHide: true, encoding: 'utf8', env: ctx.env, timeout: 30000 });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}
/** ¿El arnés de la máquina —el lugar, o el nombre viejo si el lugar no resuelve— es este árbol? (8.19, AC 9) */
function linkResolvesTo(ctx, tree) {
  const l = PLACE.resolvePlace({ home: ctx.home }).dir;
  const t = real(tree);
  return Boolean(l && t && PLACE.samePath(l, t, ctx.platform));
}

/**
 * La máquina del equipo en la transición (story 8.18, AC 28): el árbol ya trae skills/ y agents/ y la máquina sigue
 * leyéndolas de OTRO clon, el viejo de agent-skills. Devuelve ese clon, o null. Lo contesta la biblioteca del árbol
 * (`canonical-path.js --separate-skills-clone`): una sola definición del estado, la misma que hace callar al aplicador.
 * Una biblioteca de antes de la 8.18 no conoce la opción y contesta con su aviso de siempre: sólo vale una ruta que
 * existe. Sin poder preguntar, null: es un dato de `doctor`, no decide nada.
 */
function separateSkills(ctx, tree) {
  const lib = path.join(tree, 'scripts', 'lib', 'canonical-path.js');
  if (!fs.existsSync(lib)) return null;
  const r = spawnSync(process.execPath, [lib, '--separate-skills-clone', '--clone', tree, '--home', ctx.home], { windowsHide: true, encoding: 'utf8', env: ctx.env, timeout: 30000 });
  const out = String(r.stdout || '').trim();
  if (r.status !== 0 || !out || out.includes('\n') || !path.isAbsolute(out)) return null;
  try { return fs.statSync(out).isDirectory() ? out : null; } catch (_) { return null; }
}

/** ¿El aplicador del árbol conoce `--report-json`? Uno viejo (un árbol de antes de la tanda B) no se rompe por la opción. */
function applierKnowsReport(script) {
  try { return fs.readFileSync(script, 'utf8').includes('--report-json'); } catch (_) { return false; }
}

/**
 * Lo anotado antes de esta corrida (`state.managed`): las reglas de lectura del arnés lo usan para sacar la que ya no
 * es suya. Un registro que no se lee es `[]`, y se dice: esa corrida no saca ninguna regla vieja.
 */
function managedBefore(ctx, log) {
  const say = (why) => { if (log) log(`piezas compartidas: no pude leer el registro (${why}): esta vez no saco permisos de lectura viejos`); };
  try {
    // `read` devuelve `{ status, state }`: lo anotado está en `state.managed`, y sirve aunque el estado tenga otro
    // problema (un árbol que no está, un campo de más); sólo un archivo que no se pudo leer no trae nada
    const r = loadState(ctx);
    const st = r && r.state;
    if (st && Array.isArray(st.managed)) return st.managed;
    if (r && r.status !== 'missing') say(r.reason || r.status);
    return [];
  } catch (e) { say((e && e.code) || (e && e.message) || e); return []; }
}

/**
 * Las reglas de lectura de las carpetas del arnés, DESPUÉS del aplicador: los enlaces de ~/.claude que
 * cubren (agent-skills, cada skill) los crea él, y antes no existen. Devuelve `{ pieces, notes }`: sus piezas y lo que
 * sumó o sacó, en llano (vacío si no cambió nada), para el cierre de `update`. Nunca tira.
 */
function readPieces(ctx, tree, { log, snapshotDir }) {
  if (ctx.env.TYCON_NO_AUTOINSTALL === '1') return { pieces: [], notes: [] };
  try {
    const r = mod('shared').applyReadRules({ home: ctx.home, env: ctx.env, tree, backup: !snapshotDir, log, previous: managedBefore(ctx, log) });
    // todo lo que sumó, sacó o no pudo hacer; el apagado a propósito (TYCON_NO_READ_PERMISSIONS=1) no se repite en cada cierre
    const off = mod('read-permissions').OFF_ENV;
    const notes = r && Array.isArray(r.notes) ? r.notes.filter((n) => !n.startsWith(`${off}=1`)) : [];
    if (r && !r.ok && r.reason && !notes.includes(r.reason)) notes.push(r.reason);
    return { pieces: r && Array.isArray(r.pieces) ? r.pieces : [], notes };
  } catch (e) {
    if (log) log(`piezas compartidas: las reglas de lectura no se pudieron sumar (${String((e && e.message) || e).split('\n')[0]})`);
    return { pieces: [], notes: [] };
  }
}

/** La variable con que se le avisa al aplicador que las piezas compartidas YA están hechas (la de `shared.DONE_ENV`). */
const SHARED_DONE_ENV = 'TYCON_HARNESS_SHARED_DONE';
/** La variable con que se le dice al aplicador qué hacer con Codex (story 8.23, tanda C): `done` · `off`. */
const CODEX_BY_HARNESS_ENV = 'TYCON_HARNESS_CODEX';
/**
 * Las piezas compartidas (tanda D, AC 28): `cleanupPeriodDays`, la variable de `env` y los comandos de barra, hechas
 * desde Node para que existan también donde el aplicador no las hace (Windows). Devuelve las que quedan en la máquina
 * y son del arnés (van al registro), o `null` si no se pudieron hacer —ahí las hace el aplicador, como siempre—. Nunca
 * tira: lo que pasa va al registro, no a la salida.
 */
function sharedPieces(ctx, tree, { log, snapshotDir, reads = true }) {
  // TYCON_NO_AUTOINSTALL=1 apaga al aplicador entero (sale sin escribir nada): tampoco se hacen por él
  if (ctx.env.TYCON_NO_AUTOINSTALL === '1') return null;
  try {
    // los dos ajustes son de full (story 8.16, tanda C): en minimal, o con el perfil sin saber, no se escriben.
    // `reads: false`: las reglas de lectura las suma readPieces, después del aplicador
    const r = mod('shared').applyShared({ home: ctx.home, env: ctx.env, tree, backup: !snapshotDir, log, settings: profileFull(profileOf(ctx, tree)), reads, previous: reads ? managedBefore(ctx, log) : [] });
    return r && r.ok && Array.isArray(r.pieces) ? r.pieces : null;
  } catch (e) {
    // «sin shared.js» sólo si lo que falta ES ese módulo —un árbol de antes de la tanda D (una vuelta atrás corrida desde
    // el clon) no lo trae—: la primera línea del error nombra al módulo que no se encontró; las siguientes son la pila de
    // quién lo pidió, y ahí shared.js aparece también cuando lo que falta es una dependencia SUYA. Cualquier otro error
    // (el módulo está y tira) se dice como lo que es: el registro no apunta a una causa falsa.
    const first = String((e && e.message) || e).split('\n')[0];
    const absent = Boolean(e && e.code === 'MODULE_NOT_FOUND' && /shared\.js/.test(first));
    if (log) {
      log(absent
        ? `piezas compartidas: sin shared.js en esta versión (${e.code}): las hace el aplicador`
        : `piezas compartidas: applyShared falló (${first}): las hace el aplicador`);
    }
    return null;
  }
}

/**
 * Corre el aplicador del árbol con el candado del padre; la salida va al registro. Con `snapshotDir` (la copia que el
 * mecanismo ya tomó) el aplicador no escribe sus `.bak` propios (AC 18); si conoce `--report-json`, devuelve las piezas
 * que dejó en la máquina (AC 15): `report` = lista, o `null` si no hubo reporte.
 *
 * ANTES de lanzarlo hace las piezas compartidas (AC 28) y, si salieron bien, se lo avisa con `TYCON_HARNESS_SHARED_DONE=1`
 * para que él las saltee; van en `shared` (lista; vacía si no las hizo). La variable nunca se hereda de quien nos lanzó:
 * sólo la pone quien las hizo. La excepción es un settings.json que NO existe: el esqueleto con que el aplicador lo crea
 * trae `"$schema"` y el módulo no, así que ahí corre primero el aplicador (sin la variable: las hace él, como suelto) y el
 * módulo después — no escribe nada donde ya están, las hace donde el aplicador no (Windows), y las anota igual.
 */
/**
 * Los finales de línea del clon de Windows (story 8.17, AC 71): el paso de `runApplier`, aparte, porque también lo
 * necesita el plan de `install` (story 8.16): el plan corre el aplicador con `--check`, y un aplicador con `\r\n` no
 * corre. Toca el clon, no la HOME. Nunca tira.
 */
function normalizeTreeEol(ctx, tree, log = null) {
  // lo que corrigió el paso del plan (sin registro: el plan no escribe en la HOME) se anota en el registro acá, cuando
  // corre el aplicador de verdad, así el orden queda dicho: los finales de línea antes que el aplicador
  if (log && ctx.eolPendingLog) { log(`finales de línea: ${ctx.eolPendingLog}`); ctx.eolPendingLog = null; }
  // el aviso de la corrida anterior del paso en este mismo proceso (el plan) vale hasta que una corrida diga otro
  if (ctx.eolNotice === undefined) ctx.eolNotice = null;
  try {
    const st = loadState(ctx);
    const mode = st.status === 'ok' && st.state ? st.state.mode : (st.status === 'missing' ? 'managed' : 'unknown');
    const eol = mod('sources').normalizeEol(tree, { env: ctx.env, platform: ctx.env.TYCON_HARNESS_EOL_PLATFORM || ctx.platform, mode });
    if (eol.line) { if (log) log(`finales de línea: ${eol.line}`); else ctx.eolPendingLog = eol.line; if (!ctx.eolQuiet) process.stderr.write(`arnés: finales de línea: ${eol.line}\n`); }
    if (eol.line && eol.status !== 'normalized') ctx.eolNotice = eol.line;
  } catch (e) { if (log) log(`finales de línea: el paso se cortó (${e && e.message ? e.message : e}): sigo con el aplicador`); }
}

/**
 * Enchufa las herramientas de la máquina desde `tree` (story 8.23, tanda C): el aplicador, que es el enchufe de Claude
 * Code, y el de Codex (`tools.plugCodex`, en Node). Mismo resultado que siempre —`{ ok, status, out, report, shared,
 * warnings, reason }`—, con las piezas de Codex sumadas al reporte.
 *
 * `tools`: las herramientas a enchufar. Sin decirlas, las que el ESTADO tiene escritas (`state.tools`); un estado sin
 * ellas (una máquina de antes de la tanda C) es `null`: corre el aplicador solo, como siempre, y él decide lo de Codex.
 * Con la lista escrita: sin Claude Code el aplicador NO corre (no se escribe nada en su carpeta, AC 22); con Codex en la
 * lista lo enchufa este programa y al aplicador se le avisa (`TYCON_HARNESS_CODEX=done`) para que saltee su bloque; sin
 * Codex, que no lo despliegue (`off`).
 */
function runApplier(ctx, tree, { log, snapshotDir = null, tools = undefined, force = false, hooksPath = false } = {}) {
  const a = runApplierOnly(ctx, tree, { log, snapshotDir, tools, force });
  // la carpeta global de hooks de git (2026-10-14): sólo en lo que pide una persona (`install`, `apply`, la mudanza), nunca
  // en el arranque. El aplicador sólo avisa que git no tiene ninguna; acá se pone, si corresponde (git-hooks-path.js)
  if (hooksPath && a.ok) {
    const prof = profileOf(ctx, tree);
    const G = mod('git-hooks-path');
    const g = G.ensure({ home: ctx.home, env: ctx.env, platform: ctx.platform, profile: prof.ok ? prof.value : null, log });
    if (g.status === 'set' || g.status === 'failed') {
      a.warnings = G.withoutUnsetWarning(a.warnings);
      a.out = G.withoutUnsetWarning(String(a.out || '').split('\n')).join('\n');
    }
    if (g.status === 'failed') a.warnings = [...a.warnings, ...g.line.split('\n')];
    a.gitHooksPath = g;
  }
  return a;
}

/** La carpeta global de hooks de git que puso esta corrida (`runApplier` con `hooksPath`), anotada en el estado: la línea
 *  para la persona, o null. `uninstall` y el paso al perfil mínimo la sacan sólo si sigue siendo ésa. */
function noteHooksPath(state, a) {
  const g = a && a.gitHooksPath;
  if (!g || g.status !== 'set') return null;
  state.git_hooks_path = { value: g.value, at: nowIso() };
  return g.line;
}

/**
 * La carpeta global de hooks de git en lo que corre SOLO (el arranque, `update`) — 2026-10-14, a pedido del dueño: que sea
 * transparente, que ningún dev tenga que correr nada. Las máquinas ya instaladas sin ella nunca la recibían (sólo la ponían
 * `install`, `apply` y la mudanza). Mismas reglas que `ensure` (no pisa otra, full, el pre-push del arnés en su lugar), más:
 *   · `mode: 'startup'` con la política `auto` (la del perfil del equipo): la pone y devuelve el aviso de una línea, que
 *     se dice una vez (el arranque siguiente ya la encuentra puesta); con `ask`, sólo el aviso que pide `update --yes`;
 *   · `mode: 'update'` (`update` que aplica: `--yes`, o `auto`): la pone y devuelve la línea para la salida;
 *   · si la puso el arnés y hoy no está, la sacó la persona: no se vuelve a poner sola (lo dice el registro).
 * Devuelve `{ notice, line }`; los avisos anteriores de esta pieza que viajaban en `notice` salen (cada arranque decide).
 * Nunca tira.
 */
function hooksPathUnattended(ctx, state, tree, policy, { mode, log, notice = null }) {
  const G = mod('git-hooks-path');
  const out = { notice: G.stripNotices(notice), line: null };
  const add = (t) => { out.notice = out.notice ? `${out.notice} · ${t}` : t; };
  try {
    if (state.mode === 'developer' || !policy || !policy.enabled || (policy.errors && policy.errors.length)) return out;
    const prof = profileOf(ctx, tree);
    const profile = prof.ok ? prof.value : null;
    if (!G.wouldSet({ home: ctx.home, env: ctx.env, profile })) return out;
    if (state.git_hooks_path && state.git_hooks_path.value) {
      if (log) log(`carpeta global de hooks de git: la puso el arnés (${state.git_hooks_path.value}) y hoy no está — la sacó la persona: no la vuelvo a poner sola (harness.js apply la pone)`);
      return out;
    }
    if (mode === 'startup' && policy.apply !== 'auto') {
      if (log) log('carpeta global de hooks de git: falta; con la política «ask» la pone update --yes (queda en el aviso)');
      add(G.NOTICE_ASK);
      return out;
    }
    const g = G.ensure({ home: ctx.home, env: ctx.env, platform: ctx.platform, profile, log });
    if (g.status === 'set') {
      noteHooksPath(state, { gitHooksPath: g });
      out.line = g.line;
      if (mode === 'startup') add(g.notice);
    } else if (g.status === 'failed') {
      out.line = g.line;
      if (mode === 'startup') add(g.notice);
    }
  } catch (e) { if (log) log(`carpeta global de hooks de git: no pude mirarla (${(e && e.message) || e})`); }
  return out;
}

/**
 * El Node propio del arnés (story 8.39), ANTES de los dos aplicadores: `install`, `update`, `apply` y el arranque pasan
 * todos por acá. El arranque aparte del hook (`detach.js`) baja con sus ventanas (`startup`); el arranque que corre en el
 * lugar no baja nada (`none`, AC 4); lo demás, a mano, intenta siempre (`manual`). Devuelve el resultado de
 * harness-node.js#ensure (con su `notice`) y el ambiente de los aplicadores con `TYCON_NODE_BIN` como atajo cuando el
 * Node del arnés quedó sano. Nunca tira: un problema acá nunca deja la máquina sin aplicador.
 */
function ensureHarnessNode(ctx, tree, log) {
  try {
    const HN = mod('harness-node');
    const r = HN.ensure({ tree, env: ctx.env, mode: ctx.harnessNodeMode || 'manual', log: (l) => { if (log) log(l); } });
    const interp = HN.interpreter({ tree, env: ctx.env });
    const env = Object.assign({}, ctx.env);
    if (interp.present) env.TYCON_NODE_BIN = interp.bin; else delete env.TYCON_NODE_BIN;
    return { result: r, env };
  } catch (e) {
    if (log) log(`node del arnés: no se pudo mirar (${e.message}): los aplicadores siguen con el Node del PATH`);
    // el aviso también sale (no sólo el registro): el arranque lo dice como cualquier otra falla del Node del arnés
    const notice = `el arnés corre con el Node del PATH (${process.version}): no pude bajar su Node propio (no se pudo mirar: ${e.message}) — harness.js doctor lo detalla`;
    return { result: { status: 'failed', reason: e.message, notice }, env: ctx.env };
  }
}

/**
 * La línea con que el aplicador dice que sacó las skills y agentes de un paquete que la organización no activa, sin su
 * marca, o null. La salida del aplicador no llega a la persona: esta línea sí (en la salida de `update` y en el aviso del
 * arranque), porque una pieza que desaparece sin que nadie lo diga es exactamente lo que no puede pasar.
 */
// la frase la arma y la reconoce scripts/lib/pack-pieces.js (una sola fuente); sin esa biblioteca, la misma frase
const PACK_RETIRED_RX = (() => { try { return require(path.join(__dirname, '..', 'lib', 'pack-pieces.js')).RETIRED_RX; } catch (_) { return /pieza\(s\) de paquete\(s\) que la organización no activa/; } })();
function packRetiredLine(a) {
  const l = String((a && a.out) || '').split('\n').find((x) => PACK_RETIRED_RX.test(x));
  return l ? l.replace(/^(?:\(--check\) )?✓ tycon: /, '').trim() : null;
}

/** `notice` con el aviso del Node del arnés de ESTE arranque al final (el de uno anterior no se arrastra). */
const HARNESS_NODE_NOTICE_RX = /(?:^| · )el arnés corre con el Node del PATH \([^)]*\): no pude bajar su Node propio[\s\S]*?— harness\.js doctor lo detalla/g;
function harnessNodeNotice(notice, a) {
  const clean = notice ? notice.replace(HARNESS_NODE_NOTICE_RX, '').replace(/^ · /, '') || null : null;
  const add = a && a.harnessNode && a.harnessNode.notice;
  return add ? (clean ? `${clean} · ${add}` : add) : clean;
}

function runApplierOnly(ctx, tree, { log, snapshotDir = null, tools = undefined, force = false } = {}) {
  const T = mod('tools');
  if (tools === undefined) {
    const st = loadState(ctx);
    tools = st.state && T.recorded(st.state) ? T.plugged(st.state, { home: ctx.home, env: ctx.env }) : null;
  }
  const hn = ensureHarnessNode(ctx, tree, log);
  const withClaude = !tools || tools.includes('claude');
  const withCodex = Boolean(tools && tools.includes('codex'));
  const a = withClaude
    ? runClaudeApplier(ctx, tree, { log, snapshotDir, codex: tools ? (withCodex ? 'done' : 'off') : null, env: hn.env })
    : { ok: true, status: 0, out: '', report: [], shared: [], warnings: [], reason: null };
  a.harnessNode = hn.result;
  if (!a.ok || !withCodex) return a;
  const c = T.plugCodex({ tree, home: ctx.home, env: hn.env, log, snapshotDir, force });
  // sin reporte del aplicador (uno viejo, o que no lo dejó) el registro queda como estaba: no se arma uno a medias
  if (Array.isArray(a.report)) a.report = [...a.report, ...c.pieces];
  a.out = [a.out, c.out].filter(Boolean).join('\n');
  a.warnings = [...(a.warnings || []), ...c.warnings];
  if (!c.ok) { a.ok = false; a.reason = c.reason; }
  return a;
}

function runClaudeApplier(ctx, tree, { log, snapshotDir = null, codex = null, env: baseEnv = ctx.env }) {
  const script = applierPath(ctx, tree);
  if (!fs.existsSync(script)) return { ok: false, status: null, out: '', report: null, shared: [], reason: `sin aplicador en ${script}` };
  // story 8.17 (AC 71): un clon de Windows anterior a `.gitattributes` conserva `\r\n` en lo que el pull no toca, y un
  // hook `.sh` así no corre (un freno sale distinto de 2 y no frena). En Windows y en modo instalado se corrige ACÁ, el
  // punto único por el que pasan install, apply, startup y update, antes de aplicar. Nunca frena: lo que pase se dice
  // (registro y stderr) y el aplicador corre igual. `TYCON_HARNESS_EOL_PLATFORM` deja probar el paso sin Windows; el
  // modo sale del estado (sin estado es la primera instalación: `managed`; un estado ilegible no se toca).
  // Lo que la persona tiene que hacer (todo menos «normalicé») queda además en `ctx.eolNotice` —el de la ÚLTIMA corrida
  // del paso—: en `startup` la salida no llega a la conversación y `cmdStartup` lo pasa a `notice` (pase adversarial de
  // la W3a, B2). Con `ctx.eolQuiet` (lo pone `startup`) no se escribe por stderr: ahí nadie lo ve.
  // la versión bajada (story 8.23, tanda B) no es un repo: el paso de finales de línea pregunta a git, y acá git no se
  // invoca nunca; el comprimido ya trae los bytes del commit (con `.gitattributes` del repo, finales `\n`)
  if (fs.existsSync(path.join(tree, '.git'))) normalizeTreeEol(ctx, tree, log);
  // `TYCON_HARNESS_GIT_BASH_HEALTH=1`: la salud que va a juzgar esta corrida (la de ESTE programa) revisa un `.sh` con
  // el bash de Git en Windows (AC 72). Un harness.js de antes de la W3a no la pone, y el `.ps1` deja entonces los `.sh`
  // para la corrida siguiente: su salud los revisaba con el primer `bash` del PATH (pase adversarial de la W3a, B1)
  // (en la forma con enlaces —story 8.33, Windows— los Node que lance el aplicador conservan `~/.tycon/harness` en
  // `__dirname`: lo que escriban nombra el enlace, no la carpeta numerada)
  // (`baseEnv` trae `TYCON_NODE_BIN` cuando el Node del arnés quedó sano: un atajo para el aplicador, story 8.39)
  const env = Object.assign({}, mod('tycon-home').keepLinkPathsEnv(baseEnv), { TYCON_HARNESS_LOCK_HELD: '1', TYCON_HARNESS_GIT_BASH_HEALTH: '1' });
  if (snapshotDir) env.TYCON_HARNESS_SNAPSHOT_DIR = snapshotDir; else delete env.TYCON_HARNESS_SNAPSHOT_DIR;
  delete env[SHARED_DONE_ENV];
  // lo de Codex (story 8.23, tanda C): `done` = lo enchufa este programa, salteá tu bloque; `off` = esta máquina no lo
  // enchufa. Nunca se hereda de quien nos lanzó: sin lista de herramientas escrita, el aplicador decide como siempre
  if (codex) env[CODEX_BY_HARNESS_ENV] = codex; else delete env[CODEX_BY_HARNESS_ENV];
  const settingsThere = fs.existsSync(settingsPath(ctx));
  // las reglas de lectura van después del aplicador (crea los enlaces que cubren): acá, sin ellas
  let shared = settingsThere ? sharedPieces(ctx, tree, { log, snapshotDir, reads: false }) : null;
  if (shared) env[SHARED_DONE_ENV] = '1';
  let reportDir = null;
  const extra = [];
  if (applierKnowsReport(script)) {
    // sin carpeta temporal usable el aplicador corre igual, sin reporte (el registro queda como estaba): antes de la
    // tanda B no necesitaba temporal, y un arranque no se puede caer por eso (pase adversarial, iteración 2)
    try { reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-harness-report-')); } catch (e) {
      if (log) log(`aplicador: sin carpeta temporal para el reporte de piezas (${e.code || e.message}): corre sin reporte`);
    }
    if (reportDir) extra.push('--report-json', path.join(reportDir, 'report.json'));
  }
  const [bin, args] = isWin(ctx)
    ? ['pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra]]
    : ['bash', [script, ...extra]];
  const r = spawnSync(bin, args, { windowsHide: true, encoding: 'utf8', env, timeout: APPLIER_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const ok = r.status === 0 && !r.error;
  if (log) log(`aplicador ${script} → ${ok ? 'ok' : `rc ${r.status}${r.error ? ` (${r.error.message})` : ''}`}${out ? ` · ${out.split('\n').slice(-3).join(' | ').slice(0, 400)}` : ''}`);
  let report = null;
  if (reportDir) {
    const file = path.join(reportDir, 'report.json');
    if (ok && fs.existsSync(file)) {
      const p = mod('managed').parseReport(fs.readFileSync(file, 'utf8'));
      if (p.ok) report = p.pieces; else if (log) log(`aplicador: el reporte de piezas no sirve: ${p.reason} (el registro queda como estaba)`);
    } else if (ok && log) log('aplicador: salió 0 sin escribir el reporte de piezas (el registro queda como estaba)');
    try { fs.rmSync(reportDir, { recursive: true, force: true }); } catch (_) { /* el temporal ya no está */ }
  }
  if (!settingsThere && ok) shared = sharedPieces(ctx, tree, { log, snapshotDir, reads: false });
  // las reglas de lectura del arnés, con los enlaces ya hechos; van con las compartidas al registro
  const reads = ok ? readPieces(ctx, tree, { log, snapshotDir }) : { pieces: [], notes: [] };
  if (ok) shared = [...(shared || []), ...reads.pieces];
  // los avisos del aplicador para la persona (story 8.16, AC 8): el registro se queda con las últimas tres líneas, y un
  // aviso de más arriba se perdía; `install` los repite tal cual
  const warnings = mod('report').warningLines(out, { windows: isWin(ctx) });
  return { ok, status: r.status, out, report, shared: shared || [], readNotes: reads.notes, warnings, reason: ok ? null : `el aplicador salió ${r.status === null ? 'matado' : r.status}` };
}

/** Cuántas skills de terceros baja el instalador según la lista del árbol, o null si no se puede leer (story 8.16, AC 8). */
function thirdPartyDeclared(tree) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(tree, 'scripts', 'publishing', 'third-party-skills.json'), 'utf8'));
    return Array.isArray(j.third_party) ? j.third_party.filter((e) => e && e.install === 'download').length : null;
  } catch (_) { return null; }
}
/** La copia `reason: install` más vieja: «cómo estaba la máquina antes del arnés», que no rota nunca. */
function installBaseline(ctx) {
  try {
    const installs = mod('snapshot').list(ctx.home).filter((b) => b.manifest && b.manifest.reason === 'install');
    return installs.length ? installs[installs.length - 1].dir : null;
  } catch (_) { return null; }
}

// ── el plan antes de escribir (story 8.16, tanda B · AC 11 a 17) ─────────────────────────────────────────────────────

/** ¿El aplicador del árbol sabe decir su plan? Uno viejo (de antes de la tanda B) no nombra la opción. */
function applierKnowsPlan(script) {
  try { return fs.readFileSync(script, 'utf8').includes('plan-json'); } catch (_) { return false; }
}

/**
 * El plan del aplicador: lo corre con `--check --plan-json` a un temporal bajo `os.tmpdir()` (que se borra) y lee
 * `[{kind, where, id, action}]`. Sin escribir nada en la HOME: vale el contrato de `--check` (AC 3). `known: false` es un
 * aplicador que no sabe mostrar su plan (el plan lo dice y la conformidad se pide igual); `ok: false`, un `--check` que
 * salió distinto de 0 o un plan ilegible: no se instala (AC 15). Con `TYCON_NO_AUTOINSTALL=1` el aplicador no escribe nada:
 * su plan es vacío.
 */
function applierPlan(ctx, tree) {
  if (ctx.env.TYCON_NO_AUTOINSTALL === '1') return { ok: true, known: true, pieces: [], off: true };
  // una máquina que no enchufa a Claude Code no corre el aplicador, tampoco para preguntarle su plan (story 8.23, tanda C)
  {
    const st = loadState(ctx);
    const T = mod('tools');
    if (st.state && T.recorded(st.state) && !T.plugged(st.state, { home: ctx.home, env: ctx.env }).includes('claude')) return { ok: true, known: true, pieces: [] };
  }
  const script = applierPath(ctx, tree);
  if (!fs.existsSync(script)) return { ok: false, reason: `sin aplicador en ${script}` };
  if (!applierKnowsPlan(script)) return { ok: true, known: false, pieces: [] };
  // el mismo paso que antes de aplicar: un aplicador con `\r\n` (un clon de Windows viejo) no corre ni para dar su plan
  normalizeTreeEol(ctx, tree);
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-harness-plan-')); } catch (e) { return { ok: false, reason: `sin carpeta temporal para el plan (${e.code || e.message})` }; }
  const file = path.join(dir, 'plan.json');
  // el plan es el de una corrida suelta: nada de lo que un padre le pasaría a una instalación de verdad
  const env = Object.assign({}, ctx.env);
  for (const k of ['TYCON_HARNESS_LOCK_HELD', 'TYCON_HARNESS_SNAPSHOT_DIR', SHARED_DONE_ENV, CODEX_BY_HARNESS_ENV, 'TYCON_REPORT_PIECES', 'TYCON_PLAN_PIECES']) delete env[k];
  const [bin, args] = isWin(ctx)
    ? ['pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Check', '-PlanJson', file]]
    : ['bash', [script, '--check', '--plan-json', file]];
  try {
    const r = spawnSync(bin, args, { windowsHide: true, encoding: 'utf8', env, timeout: APPLIER_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').slice(-2).join(' | ').slice(0, 300);
    if (r.status !== 0 || r.error) {
      // el motivo trae las últimas líneas del aplicador (stdout y stderr): las dos últimas no alcanzaban para saber por qué
      // salió 1 (la instalación en una carpeta con acento en Windows, 182 #12408: el motivo quedaba tapado por un aviso
      // posterior). Nada se escribe en la HOME: un plan que falla no deja rastro (harness-plan T20, «nada escrito»)
      const whole = `${r.stdout || ''}\n--- stderr ---\n${r.stderr || ''}`.trim();
      const more = whole.split('\n').map((l) => l.trim()).filter(Boolean).slice(-14).join(' | ').slice(0, 1500);
      return { ok: false, reason: `el aplicador salió ${r.status === null ? `matado${r.error ? ` (${r.error.message})` : ''}` : r.status} al armar su plan${tail ? ` (${tail})` : ''} — últimas líneas: ${more}` };
    }
    // una pieza que alguno de sus pasos no pudo anotar deja el plan incompleto: no se muestra como si estuviera entero
    const lost = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').find((l) => /no pude anotar .*en el plan/.test(l));
    if (lost) return { ok: false, reason: `el plan quedó incompleto: ${lost.replace(/^\W*tycon:\s*/, '').trim()}` };
    if (!fs.existsSync(file)) return { ok: false, reason: 'el aplicador salió 0 sin dejar su plan' };
    let pieces;
    try { pieces = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, reason: `el plan del aplicador es ilegible (${e.message})` }; }
    const ACTIONS = mod('plan').ACTIONS;
    const bad = !Array.isArray(pieces) || pieces.some((p) => !p || typeof p.kind !== 'string' || typeof p.where !== 'string' || typeof p.id !== 'string' || !ACTIONS.has(p.action));
    if (bad) return { ok: false, reason: 'el plan del aplicador no tiene la forma [{kind, where, id, action}]' };
    return { ok: true, known: true, pieces };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* el temporal ya no está */ }
  }
}

/**
 * El perfil de instalación vigente para el árbol (story 8.16, tanda C · AC 21 y 25): `{ ok, value, origin, chosen }` o
 * `{ ok: false, reason }` si la configuración está rota. Sin escribir nada. Un árbol de antes de los perfiles (sin
 * profile.js) se comporta como siempre: full.
 */
function profileOf(ctx, tree) {
  try { return mod('profile').resolve({ tree, home: ctx.home, env: ctx.env }); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /profile\.js/.test(String(e.message).split('\n')[0])) return { ok: true, value: 'full', origin: 'sin-valor', chosen: false };
    return { ok: false, reason: `no pude leer el perfil (${(e && e.message) || e})` };
  }
}
const profileFull = (r) => Boolean(r && r.ok && r.value === 'full');

/**
 * Las integraciones prendidas, para saber qué tareas de fondo corren (tycon-config del árbol; rota → ninguna). Se lee
 * sin anotar los nombres viejos (`sinAnotar`): el plan no escribe en la HOME (AC 3; pase adversarial de la tanda B,
 * clase 7). Un tycon-config de antes, sin esa forma de leer, no se usa: ninguna integración.
 */
function integrationsOf(ctx, tree) {
  try {
    const C = require(path.join(tree, 'scripts', 'lib', 'tycon-config.js'));
    if (typeof C.sinAnotar !== 'function') return {};
    return C.sinAnotar(() => C.integraciones(C.leer({ home: ctx.home, env: ctx.env })));
  } catch (_) { return {}; }
}

/**
 * Qué herramientas enchufa esta corrida de `install` (story 8.23, tanda C · AC 21): las de `--tool`, o las detectadas
 * según sus llaves. `{ ok: false, code, line }` si `--tool` no vale (2) o no hay ninguna (1); si no, `{ ok, tools, line,
 * choice, detected }` con la línea del plan. Sin escribir nada y sin red. Las llaves salen de la configuración del árbol
 * (`toolKeys`); un tycon-config de antes, o una configuración que no se puede leer, es «sin decir»: decide lo detectado.
 */
/**
 * El mismo `ctx` con lo contestado en las preguntas de `install` puesto en su entorno (cada respuesta viaja por la
 * variable de su llave). Así quien elige las herramientas ve la integración de Codex que la persona acaba de prender o
 * apagar, y no la de antes de preguntar.
 */
function withAnswers(ctx, asked) {
  const writes = (asked && asked.writes) || [];
  if (!writes.some((w) => w.envVar)) return ctx;
  const env = Object.assign({}, ctx.env);
  for (const w of writes) if (w.envVar) env[w.envVar] = w.envValue;
  return Object.assign({}, ctx, { env });
}

function toolChoice(ctx, tree, { always = [], state = null, legacyDeploy = false } = {}) {
  const T = mod('tools');
  const opt = T.parseOption(ctx.opts.tool);
  if (!opt.ok) return { ok: false, code: 2, line: opt.reason };
  // desde un clon (hasta la mudanza de la tanda D) Claude Code va siempre: `--tool codex` solo no lo puede sacar
  const dropped = opt.tools ? always.filter((t) => !opt.tools.includes(t)) : [];
  if (dropped.length) {
    return { ok: false, code: 2, line: `--tool ${opt.tools.join(' --tool ')}: una instalación desde un clon vive en la carpeta de Claude Code y lo enchufa siempre (${T.names(dropped)}). Para sumar otra herramienta: --tool ${[...dropped, ...opt.tools].join(' --tool ')}; una máquina sólo con Codex se instala con la versión bajada (install --version latest --tool codex)` };
  }
  let keys = {};
  try {
    const C = require(path.join(tree, 'scripts', 'lib', 'tycon-config.js'));
    if (typeof C.toolKeys === 'function' && typeof C.sinAnotar === 'function') keys = C.sinAnotar(() => C.toolKeys(C.cargar({ home: ctx.home, env: ctx.env })));
  } catch (_) { keys = {}; }
  const detected = T.detect({ home: ctx.home, env: ctx.env, platform: ctx.platform });
  const choice = T.choose({ option: opt.tools, keys, detected, always });
  // `install` nunca DESENCHUFA (eso es `uninstall --tool`): sobre una máquina ya instalada, lo que estaba enchufado se
  // conserva aunque esta corrida no lo elija —no detectar a Codex desde una app gráfica no puede dejar su lado sin
  // mantener (la señal no vive sólo en el entorno, caso 2026-09-04)—. Salvo lo que su llave apaga a propósito: eso deja de
  // mantenerse, y se dice cómo quitar sus piezas.
  const offByKey = (t) => { const k = keys[t]; return Boolean(k && k.value === false && k.origin !== 'apagado' && k.origin !== undefined); };
  // (`legacyDeploy`, sólo desde un clon: sin estado todavía —la primera corrida del mecanismo en una máquina que el
  // instalador de antes ya desplegó—, lo enchufado de Codex es su despliegue. Una instalación nueva de la versión bajada
  // no lo mira: ahí «ya desplegado» no es «instalada», AC 24)
  const before = state ? T.plugged(state, { home: ctx.home, env: ctx.env }) : (legacyDeploy && T.codexDeployed({ home: ctx.home, env: ctx.env }) ? ['codex'] : []);
  const kept = before.filter((t) => !choice.tools.includes(t) && !offByKey(t));
  const unkept = before.filter((t) => !choice.tools.includes(t) && offByKey(t));
  const tools = T.TOOLS.filter((t) => choice.tools.includes(t) || kept.includes(t));
  if (!tools.length) return { ok: false, code: 1, line: T.noneFound(ctx.platform) };
  let line = T.planLine(Object.assign({}, choice, { tools: choice.tools }), detected);
  if (!choice.tools.length) line = 'herramientas a enchufar: ninguna nueva';
  if (kept.length) line += ` — ya ${kept.length === 1 ? 'enchufada, se conserva' : 'enchufadas, se conservan'}: ${T.names(kept)} (para sacarla: harness.js uninstall --tool ${kept[0]})`;
  if (unkept.length) line += ` — ${T.names(unkept)} deja de mantenerse (integrations.${unkept[0]} apagada); sus piezas quedan hasta harness.js uninstall --tool ${unkept[0]}`;
  return { ok: true, tools, line, choice, detected, kept };
}

/**
 * Las piezas que escribe el propio programa, con lo que `install` les haría, sin escribir nada: el enlace, el estado, la
 * copia fija, la línea de arranque y el import (y el canal, si `--channel` lo cambia).
 */
function ownPlan(ctx, tree, existing, { pinned = null, notes = [] } = {}) {
  const M = mod('managed'), S = mod('state'), SRC = mod('sources');
  const own = [];
  const lp = linkPath(ctx.home);
  let st = null;
  try { st = fs.lstatSync(lp); } catch (_) { st = null; }
  if (!st) own.push({ kind: 'link', where: lp, id: LINK_NAME, action: 'add' });
  else if (st.isSymbolicLink()) {
    const to = real(lp);
    const action = !to ? 'update' : to === tree ? 'keep' : ctx.opts.local ? 'update' : (isHarnessClone(to) ? 'keep' : 'update');
    own.push({ kind: 'link', where: lp, id: LINK_NAME, action });
    // un enlace a OTRO clon que sirve no se mueve, y la instalación corre igual desde este: no es «nada que escribir»
    if (action === 'keep' && to !== tree) notes.push(`el enlace ${lp} apunta a otro clon (${to}) y no se mueve; la instalación corre igual desde ${tree} (para que apunte acá: install --local ${tree})`);
  }
  // el estado
  let stateAction = 'keep';
  if (!existing) stateAction = 'add';
  else if (real(existing.tree) !== tree) stateAction = 'update';
  else {
    const probe = JSON.parse(JSON.stringify(existing));
    // una fuente que no se pudo mirar (story 8.18): install va a salir 1 diciéndolo; no es «nada que escribir»
    const probeNotes = [], probeBlind = [];
    if (redetectSources(probe, SRC.detect({ tree, home: ctx.home, env: ctx.env }), tree, probeNotes, probeBlind)) stateAction = 'update';
    if (probeBlind.length) notes.push(...probeNotes.filter((n) => /^no pude mirar la fuente/.test(n)));
    if (pinned && (existing.sources || []).some((s) => s && s.name === pinned.name && s.url !== pinned.url)) stateAction = 'update';
  }
  const policy = ctx.opts.channel ? policyOf(ctx, tree) : null;
  if (policy && policy.channel !== ctx.opts.channel) {
    own.push({ kind: 'channel', where: path.join(ctx.home, '.claude', 'tycon.json'), id: 'channel', action: 'update' });
    if (existing) stateAction = 'update';
  }
  // el canal del estado distinto del de la política: install lo reescribe (lo mismo que hace adentro del candado)
  if (policy && existing && existing.channel !== policy.channel) stateAction = 'update';
  // `--profile` (story 8.16, tanda C · AC 25): se escribe en ~/.claude/tycon.json si el archivo no dice ya ese valor
  if (ctx.opts.profile) {
    const had = machineProfile(ctx);
    if (had !== ctx.opts.profile) own.push({ kind: 'profile', where: path.join(ctx.home, '.claude', 'tycon.json'), id: 'install.profile', action: had ? 'update' : 'add' });
  }
  // lo contestado en las preguntas de la tanda D (integraciones, paquete del stack): también va a ~/.claude/tycon.json
  for (const w of ctx.configWrites || []) own.push({ kind: 'config', where: path.join(ctx.home, '.claude', 'tycon.json'), id: w.key, action: w.had ? 'update' : 'add' });
  // la copia fija registrada en el estado distinta de la del árbol: install reescribe el estado (copyBootstrap)
  if (existing && JSON.stringify((existing.bootstrap && existing.bootstrap.sha256) || null) !== JSON.stringify(bootstrapSha(tree))) stateAction = 'update';
  own.push({ kind: 'state', where: S.paths(ctx.home).file, id: path.basename(S.paths(ctx.home).file), action: stateAction });
  // la copia fija de arranque: lo que falta o cambió, y los módulos que el árbol ya no trae (copyBootstrap los borra)
  const { bootstrapDir } = S.paths(ctx.home);
  const files = fixedCopyFiles(tree);
  for (const f of files) {
    if (!fs.existsSync(f.src)) continue;
    const dst = path.join(bootstrapDir, f.id);
    const action = !fs.existsSync(dst) ? 'add' : (sha256(dst) === sha256(f.src) ? 'keep' : 'update');
    own.push({ kind: 'file', where: dst, id: f.id, action });
  }
  const progMods = path.join(bootstrapDir, PROGRAM_DIR, 'harness');
  const shipped = new Set(files.map((f) => path.basename(f.id)));
  let present = [];
  try { present = fs.readdirSync(progMods).filter((n) => n.endsWith('.js')); } catch (_) { present = []; }
  for (const n of present.filter((x) => !shipped.has(x))) own.push({ kind: 'file', where: path.join(progMods, n), id: `${PROGRAM_DIR}/harness/${n}`, action: 'remove' });
  // la línea de arranque (con lo que haría la migración: una vieja, repetidas, la forma anterior de Windows) y el import
  const sl = startupLineAction(ctx);
  if (sl.note) notes.push(sl.note);
  if (sl.action) own.push({ kind: 'startup-line', where: settingsPath(ctx), id: 'SessionStart:bootstrap.js', action: sl.action });
  const imp = { kind: 'import', where: claudeMdPath(ctx), id: IMPORT_LINE };
  own.push(Object.assign(imp, { action: M.present(imp, { home: ctx.home, env: ctx.env }) === true ? 'keep' : 'add' }));
  own.push(...sharedPlan(ctx, tree));
  return own;
}

/**
 * Las piezas compartidas en el plan (story 8.16, AC 20): `cleanupPeriodDays`, la variable de `env` y los comandos de
 * barra, que en Windows hace este programa y no el aplicador (shared.js; en Mac y Linux el aplicador también las anota en
 * su plan, con los mismos `kind`, `where` e `id`: no se repiten). Falta → add; con el valor del arnés → keep; con otro
 * valor es del dev y no se anota. Un comando distinto → update. Nunca tira.
 */
function sharedPlan(ctx, tree) {
  if (ctx.env.TYCON_NO_AUTOINSTALL === '1') return [];
  const out = [];
  try {
    const SH = mod('shared');
    const file = settingsPath(ctx);
    let s = {};
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { s = {}; }
    const env = s && typeof s.env === 'object' && s.env ? s.env : {};
    // los dos ajustes, sólo en full (story 8.16, tanda C): en minimal no se escriben (si estaban, los saca el cambio de
    // perfil: está en «quita:»), y con el perfil sin saber tampoco
    const withSettings = profileFull(profileOf(ctx, tree));
    for (const [k, v] of Object.entries(withSettings ? SH.TOP_CANONICAL : {})) {
      if (!(k in s)) out.push({ kind: 'setting', where: file, id: k, action: 'add' });
      else if (s[k] === v) out.push({ kind: 'setting', where: file, id: k, action: 'keep' });
    }
    for (const [k, v] of Object.entries(withSettings ? SH.ENV_CANONICAL : {})) {
      if (!(k in env)) out.push({ kind: 'setting', where: file, id: `env.${k}`, action: 'add' });
      else if (env[k] === v) out.push({ kind: 'setting', where: file, id: `env.${k}`, action: 'keep' });
    }
    // la carpeta de los mods del arnés (story 7.27): se suma a las del dev, así que el plan mira la carpeta, no el valor
    if (withSettings && ctx.env.TYCON_NO_MODS !== '1') {
      const PD = mod('plugin-dirs');
      const has = PD.hasDir(env[PD.PLUGIN_DIRS_KEY], PD.ourDir(ctx.home), { sep: PD.separator(ctx.platform), home: ctx.home });
      out.push({ kind: 'setting', where: file, id: PD.PLUGIN_DIRS_ID, action: has ? 'keep' : 'add' });
    }
    // las reglas de lectura de las carpetas del arnés: en los dos perfiles, una línea por regla
    if (ctx.env.TYCON_NO_READ_PERMISSIONS !== '1') {
      const RP = mod('read-permissions');
      for (const rule of RP.plannedRules({ home: ctx.home, tree, platform: ctx.platform })) out.push({ kind: 'setting', where: file, id: RP.pieceId(rule), action: RP.hasRule(s, rule) ? 'keep' : 'add' });
    }
    const src = path.join(tree, 'commands');
    if (ctx.env.TYCON_NO_COMMANDS_SYNC !== '1' && fs.existsSync(src)) {
      for (const name of fs.readdirSync(src).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort()) {
        const to = path.resolve(ctx.home, '.claude', 'commands', name);
        const action = !fs.existsSync(to) ? 'add' : (fs.readFileSync(to).equals(fs.readFileSync(path.join(src, name))) ? 'keep' : 'update');
        out.push({ kind: 'command', where: to, id: name, action });
      }
    }
  } catch (e) {
    // sin shared.js (un árbol viejo): las hace y las anota el aplicador. Cualquier otra falla deja el plan incompleto, y
    // un plan incompleto no se muestra como si estuviera entero (revisor de fallos silenciosos)
    if (e && e.code === 'MODULE_NOT_FOUND' && /shared\.js/.test(String(e.message).split('\n')[0])) return [];
    throw new Error(`no pude anotar en el plan las piezas compartidas (${(e && e.message) || e})`);
  }
  return out;
}

/**
 * Lo que `startup-line.migrate` haría con la línea de arranque, sin escribir (pase adversarial de la tanda B, clase 4):
 * `add` si no hay ninguna del arnés; `update` si hay una forma vieja, varias nuevas repetidas o la nueva en su forma
 * anterior de Windows; `keep` si hay exactamente una nueva. Una del arnés con forma desconocida no se toca, y se dice.
 */
function startupLineAction(ctx) {
  const SL = mod('startup-line');
  const file = settingsPath(ctx);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return { action: 'add' }; }
  if (!raw.trim()) return { action: 'add' };
  let s;
  try { s = JSON.parse(raw); } catch (e) { return { action: null, note: `${file} es ilegible (${e.message}): la línea de arranque no se toca` }; }
  const cmds = [];
  for (const entry of (s && s.hooks && Array.isArray(s.hooks.SessionStart)) ? s.hooks.SessionStart : []) {
    for (const h of (entry && Array.isArray(entry.hooks)) ? entry.hooks : []) if (h && typeof h.command === 'string' && h.command) cmds.push(h.command);
  }
  const known = cmds.filter((c) => SL.classify(c));
  const news = cmds.filter((c) => !SL.classify(c) && SL.isNew(c));
  const unknown = cmds.filter((c) => !SL.classify(c) && !SL.isNew(c) && SL.mentionsHarness(c));
  if (known.length || news.length > 1 || (isWin(ctx) && news.some((c) => SL.isSuperseded(c)))) return { action: 'update' };
  if (news.length === 1) return { action: 'keep' };
  if (unknown.length) return { action: null, note: `la línea de arranque del arnés en ${file} tiene una forma que no reconozco: no la toco` };
  return { action: 'add' };
}

/** El estado tal como está en el disco (el texto), para saber si otra sesión lo cambió mientras se confirmaba. */
function stateFingerprint(ctx) {
  try { return fs.readFileSync(mod('state').paths(ctx.home).file, 'utf8'); } catch (_) { return null; }
}

/**
 * El plan de `install` sin escribir nada (lo usan `install`, `install --dry-run` y las pruebas): la lista de efectos (rota
 * o ausente → `ok: false`, sale 2: una lista rota no se lee como «no cambia nada»), el plan del aplicador y las piezas
 * propias. `ctx.tree` es el árbol ya resuelto.
 * @returns {{ ok: boolean, code?: number, lines?: string[], plan?: object, existing?: object|null, fingerprint?: string|null }}
 */
function installPlan(ctx, { pinned = null } = {}) {
  const tree = real(ctx.tree) || ctx.tree;
  const eff = mod('managed').readEffects(tree);
  if (!eff.ok) return { ok: false, code: 2, lines: [`harness.js install: la lista de lo que la instalación cambia no sirve: ${eff.reason}. Sin ella no puedo mostrarte qué va a cambiar, y no escribo nada`] };
  const fingerprint = stateFingerprint(ctx);
  const read = loadState(ctx);
  const existing = read.status === 'ok' ? read.state : null;
  const ap = applierPlan(ctx, tree);
  if (!ap.ok) return { ok: false, code: 2, lines: [`harness.js install: no pude armar el plan: ${ap.reason}. No escribí nada`] };
  // `notes`: lo que la instalación va a decir aunque no escriba esa pieza (un enlace a otro clon, una línea de arranque
  // que no reconoce): con alguna, no es «nada que escribir» y se pide conformidad
  const notes = [];
  let own;
  try { own = ownPlan(ctx, tree, existing, { pinned, notes }); } catch (e) {
    return { ok: false, code: 2, lines: [`harness.js install: no pude armar el plan: ${(e && e.message) || e}. No escribí nada`] };
  }
  // el perfil (story 8.16, tanda C · AC 25 y 26): el que va a quedar (con `--profile`, `ctx.env` ya lo trae en su variable).
  // Una configuración rota no se lee como full: sin saber el perfil no se puede decir qué cambia
  const profile = profileOf(ctx, tree);
  if (!profile.ok) return { ok: false, code: 2, lines: [`harness.js install: la configuración del arnés está rota: ${profile.reason}. Sin saber el perfil de instalación no puedo mostrarte qué va a cambiar, y no escribo nada (node scripts/lib/tycon-config.js validate)`] };
  // un cambio de perfil: lo registrado que el plan nuevo ya no trae se quita (sin las piezas propias ni las de terceros)
  const PR = mod('profile');
  const switching = Boolean(existing && PR.installedValue(existing) !== profile.value);
  if (switching) {
    const staying = [...ap.pieces, ...own].filter((p) => p.action !== 'remove');
    for (const p of PR.toRemove(existing.managed, staying, (x) => isOwnPiece(ctx, x), { effects: eff.effects, profile: profile.value })) own.push({ kind: p.kind, where: p.where, id: p.id, action: 'remove' });
  }
  const plan = mod('plan').build({
    applier: ap, own, effects: eff.effects, home: ctx.home, env: ctx.env,
    platform: ctx.platform, integrations: integrationsOf(ctx, tree), first: !existing,
    backupRoot: mod('snapshot').backupsRoot(ctx.home), profile: profile.value,
  });
  return { ok: true, plan, existing, fingerprint, notes, profile, switching };
}

/**
 * Las preguntas de la instalación y las opciones que las contestan (story 8.16, tanda D · AC 30 a 33), ANTES del plan y
 * sin escribir nada: lo que se contesta se escribe recién después de la conformidad (`writeAnswers`).
 *
 *   · `--integrations <lista|none>` y `--packs <all|none|a,b>` se validan primero (un valor inválido, o uno que contradice a
 *     su variable de entorno, sale 2 sin preguntar nada);
 *   · el perfil se pregunta en una PRIMERA instalación cuando nadie lo dijo (ni `--profile`, ni variable, ni archivo, ni
 *     perfil del equipo): con terminal, sin valor por defecto; sin terminal sale 2 con las dos opciones, también con
 *     `--yes` (`--yes` acepta el plan, no elige). Con `--defaults` no se pregunta: queda `minimal` («por defecto»). Una
 *     instalación que ya existe sigue con la regla de la tanda C (sin elegir se comporta como full) y `doctor` lo avisa;
 *   · las integraciones y el paquete se preguntan en esa misma primera instalación con terminal, sólo si el perfil no lo
 *     fija la configuración (una máquina configurada —el perfil del equipo, el archivo, una variable— no se pregunta) y
 *     sólo lo que nadie fijó ni vino por opción. Con `--defaults` no se preguntan: quedan como están (ninguna prendida,
 *     sin paquete), igual que sin terminal.
 *
 * La misma lógica en cualquier sistema (T52). Nunca tira.
 * @returns {{ code?: number, lines?: string[], profile?: string, profileVia?: string, writes: object[], over: object,
 *             head: string[], guided: boolean, eof: boolean, config?: object, order: string[] }}
 */
/**
 * Instala CodeGraph con el instalador del árbol (`install-codegraph.sh`, o `.ps1` en Windows), después del «¿Instalo?».
 * Nunca frena la instalación del arnés: si falla, devuelve `{ ok: false, note }` con qué pasó y cómo reintentar.
 * @returns {{ ok: boolean, note: string|null }}
 */
function codegraphInstall({ tree, env = process.env, platform = process.platform }) {
  const win = platform === 'win32';
  const script = path.join(tree, 'scripts', 'setup', win ? 'install-codegraph.ps1' : 'install-codegraph.sh');
  // `--tool-only`: el CLI y el hook de arranque, sin indexar ninguna carpeta (el hook arma el índice de cada repo que se abre)
  const retry = win ? `pwsh -File "${script}" -ToolOnly` : `bash "${script}" --tool-only`;
  if (!fs.existsSync(script)) return { ok: false, note: `CodeGraph no se pudo instalar (no está ${script}); el arnés quedó instalado` };
  const r = spawnSync(win ? 'pwsh' : 'bash', win ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ToolOnly'] : [script, '--tool-only'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60 * 1000, windowsHide: true });
  if (r.status === 0) return { ok: true, note: 'CodeGraph: instalado (lo usa tu organización)' };
  const why = r.error ? r.error.message : String(r.stderr || r.stdout || `salió con ${r.status}`).trim().split('\n').pop().slice(0, 200);
  return { ok: false, note: `CodeGraph no se pudo instalar (${why}); el arnés quedó instalado — reintentá con: ${retry}` };
}

function installQuestions(ctx, tree, existing) {
  const out = { writes: [], over: {}, head: [], guided: false, eof: false, order: [] };
  const Q = mod('questions'), P = mod('prompt'), PR = mod('profile');
  let C, config;
  try {
    C = require(path.join(tree, 'scripts', 'lib', 'tycon-config.js'));
    if (!(C.VOCABULARIO && C.VOCABULARIO.install && typeof C.setKey === 'function')) return out;   // un árbol de antes de los perfiles
    config = (C.sinAnotar || ((f) => f()))(() => C.cargar({ home: ctx.home, env: ctx.env, arnes: tree }));
  } catch (_) { return out; }
  // una configuración rota la dice el plan (sale 2 con el motivo): acá no se decide nada sobre ella
  if (config.errores && config.errores.length) return out;
  out.config = config;
  out.order = Array.isArray(C.LAS_OCHO) ? [...C.LAS_OCHO] : [];
  const offered = Q.offeredIntegrations(mod('managed').readIntegrations(tree));
  const keys = offered.map((x) => x.key);
  const v = config.valores, o = config.origenes, vars = config.variables || {};
  const fail = (line) => Object.assign(out, { code: 2, lines: [`harness.js install: ${line}`] });

  // (1) las opciones, antes de preguntar nada
  const wantI = Q.checkIntegrationsOption(ctx.opts.integrations, keys);
  if (wantI && wantI.error) return fail(wantI.error);
  const installedPacks = (() => { try { const PP = require(path.join(tree, 'scripts', 'lib', 'pack-pieces.js')); return PP.listPacks(PP.packsDirOf(tree)).packs.map((x) => x.name); } catch (_) { return null; } })();
  const wantP = Q.checkPacksOption(ctx.opts.packs, installedPacks);
  if (wantP && wantP.error) return fail(wantP.error);
  const desiredI = {};   // integración → true/false (lo pedido)
  if (wantI) for (const k of keys) desiredI[k] = wantI.names.includes(k);
  for (const k of Object.keys(desiredI)) {
    const ruta = `integraciones.${k}`;
    const cur = v.integraciones[k];
    if (o[ruta] === 'env' && (cur === true || cur === 'detect') !== desiredI[k]) {
      return fail(`--integrations ${ctx.opts.integrations} y la variable ${vars[ruta]}=${ctx.env[vars[ruta]]} dicen cosas distintas de ${k}: la variable le ganaría a lo que escriba (sacala, o cambiá --integrations)`);
    }
  }
  if (wantP && o['packs.default'] === 'env' && !Q.samePacks(v.packs.default, wantP.value)) {
    return fail(`--packs ${Q.packsText(wantP.value)} y la variable ${vars['packs.default']}=${Q.packsText(v.packs.default)} dicen cosas distintas: la variable le ganaría a lo que escriba (sacala, o pedí --packs ${Q.packsText(v.packs.default)})`);
  }

  // (2) el perfil
  const effects = mod('managed').readEffects(tree);
  const fixedByConfig = ['env', 'maquina', 'perfil'].includes(o[PR.KEY]);
  const first = !existing;
  if (first && !ctx.opts.profile && !fixedByConfig && ctx.opts.defaults) {
    out.profile = 'minimal';
    out.profileVia = 'por defecto';
  } else if (first && !ctx.opts.profile && !fixedByConfig) {
    const lines = Q.profileLines(effects.ok ? effects.effects : []);
    // sin terminal, o con `--yes` (el modo desatendido: no pregunta nada aunque haya terminal), no hay a quién preguntarle
    if (!P.isTerminal() || ctx.opts.yes) return Object.assign(out, { code: 2, lines: ['harness.js install: elegí el perfil: `--profile minimal` o `--profile full` (sin terminal, o con `--yes`, no pregunto: `--yes` acepta el plan pero no elige el perfil)', ...lines] });
    const write = (s) => process.stdout.write(s);
    const r = Q.askProfile({ effects: effects.ok ? effects.effects : [], read: () => P.readAnswer(), write });
    if (!r.value) return fail('sin perfil elegido no escribo nada (sin terminal: --profile minimal o --profile full)');
    out.profile = r.value;
    out.profileVia = 'respuesta';
  }
  out.guided = first && !fixedByConfig;

  // (3) las integraciones y el paquete: en la primera instalación guiada, con terminal, lo que nadie fijó
  const write = (s) => process.stdout.write(s);
  const asked = {};
  // con `--yes` no se pregunta nada aunque haya terminal (decisión del dueño, 2026-10-05): lo que no vino por opción queda
  // como está, igual que sin terminal
  if (out.guided && P.isTerminal() && !ctx.opts.yes && !ctx.opts.defaults) {
    if (!wantI) {
      const open = offered.filter((x) => o[`integraciones.${x.key}`] === 'apagado');
      if (open.length) {
        out.asked = true;
        const r = Q.askIntegrations({ offered: open, read: () => P.readAnswer(), write });
        if (r.names === null) return fail('sin una respuesta válida a las integraciones no escribo nada (sin terminal: --integrations <lista|none>)');
        for (const k of r.names) asked[k] = true;
        if (r.eof) out.eof = true;
      }
    }
    if (!wantP && o['packs.default'] === 'default' && !out.eof) {
      out.asked = true;
      write(Q.PACKS_QUESTION);
      const r = P.readAnswer();
      if (r.eof) { write('\n'); out.eof = true; }
      if (P.saidYes(r.text)) out.answeredPacks = 'all';
    }
  }

  // (4) lo que se va a escribir, con de dónde vino
  const VAR = (ruta) => ((C.VARIABLES || {})[ruta] || [])[0];
  for (const k of keys) {
    const ruta = `integraciones.${k}`;
    const cur = v.integraciones[k];
    let want = null, via = null;
    if (wantI) { want = desiredI[k]; via = '--integrations'; } else if (asked[k]) { want = true; via = 'respuesta'; }
    if (want === null || o[ruta] === 'env') continue;
    if ((want && cur !== true) || (!want && (cur === true || cur === 'detect'))) {
      out.writes.push({ key: `integrations.${k}`, ruta, value: want, via, had: o[ruta] === 'maquina', envVar: VAR(ruta), envValue: want ? '1' : '0' });
      out.over[ruta] = { value: want, via };
    }
  }
  const packsWant = wantP ? wantP.value : (out.answeredPacks || null);
  // el perfil del equipo gana sobre los paquetes elegidos al instalar (story 8.29): con un perfil que los declara, lo que
  // se escriba en el archivo de la máquina no hace efecto, así que no se escribe —sería una mentira en un archivo de la
  // persona— y se dice en una línea. No frena (con la variable sí: ahí la persona está y la puede sacar; acá frenar
  // rompería la página pública, que pasa `--packs all`, en un equipo cuyo perfil diga `none`). Sólo con un lector que ya
  // conoce la regla (`PROFILE_WINS`): en un árbol anterior la máquina todavía le gana al perfil, y se escribe como siempre.
  const packsByProfile = Array.isArray(C.PROFILE_WINS) && C.PROFILE_WINS.includes('packs.default') && o['packs.default'] === 'perfil';
  let packsNote = null;
  // (sólo puede venir de `--packs`: la pregunta de los paquetes no se hace cuando el perfil los fija, porque se pregunta
  // nada más que con el origen `default`)
  if (wantP && !Q.samePacks(v.packs.default, packsWant) && packsByProfile) {
    packsNote = `paquete del stack: el perfil del equipo lo fija en ${Q.packsText(v.packs.default)} — --packs ${Q.packsText(packsWant)} no se escribe (para cambiarlo en esta máquina: la variable ${VAR('packs.default')})`;
  } else if (packsWant && !Q.samePacks(v.packs.default, packsWant) && o['packs.default'] !== 'env') {
    const via = wantP ? '--packs' : 'respuesta';
    out.writes.push({ key: 'packs.default', ruta: 'packs.default', value: packsWant, via, had: o['packs.default'] === 'maquina', envVar: VAR('packs.default'), envValue: Q.packsText(packsWant) });
    out.over['packs.default'] = { value: packsWant, via };
  }
  out.head = Q.configLines(config, out.over, out.order);
  if (packsNote) out.head.push(packsNote);
  // CodeGraph prendido por la organización y sin el binario: un renglón más del plan, cubierto por el mismo «¿Instalo?»
  // (sin pregunta nueva). Lo instala `codegraphInstall` después del sí.
  if (v.integraciones && v.integraciones.codegraph === true && o['integraciones.codegraph'] === 'perfil' && !findInPath('codegraph', ctx.env)) {
    out.head.push('CodeGraph: tu organización lo usa — se instala (scripts/setup/install-codegraph); el índice lo arma esta máquina');
    out.codegraphInstall = true;
  }
  // cuando no se preguntaron las integraciones (el perfil lo fija la configuración, la instalación ya existe, `--yes`, sin
  // terminal), UNA línea al final con cómo cambiar el perfil y las integraciones (decisión del dueño, 2026-10-05)
  if (!out.asked) out.hint = Q.CHANGE_HINT;
  return out;
}

/**
 * Escribe lo contestado (o pedido por opción) en ~/.claude/tycon.json, con el escritor único de la configuración (story
 * 8.16, tanda D · AC 33): ya con la conformidad, adentro del candado y antes del aplicador. `{ ok, warnings }` o
 * `{ ok: false, reason }`.
 */
function writeAnswers(ctx, tree, writes) {
  const warnings = [];
  if (!writes || !writes.length) return { ok: true, warnings };
  let C;
  try { C = require(path.join(tree, 'scripts', 'lib', 'tycon-config.js')); } catch (e) { return { ok: false, reason: e.message }; }
  for (const w of writes) {
    let r;
    try { r = C.setKey(ctx.home, w.key, w.value, { env: ctx.env }); } catch (e) { r = { ok: false, reason: e.message }; }
    if (!r || !r.ok) return { ok: false, reason: `${w.key}: ${r ? r.reason : 'sin escritor'}` };
    if (r.warning) warnings.push(r.warning);
  }
  return { ok: true, warnings: [...new Set(warnings)] };
}

/** La línea del cierre de una primera instalación guiada: cómo se prenden las dos integraciones que piden un dato. */
function askLaterNote(asked) {
  if (!asked || !asked.guided || !asked.config) return [];
  const v = asked.config.valores || {};
  const cmd = `node ~/.claude/${PLACE.PLACE_NAME}/scripts/lib/tycon-config.js set`;
  const off = [];
  if (!(v.ado && v.ado.org)) off.push(`Azure DevOps: ${cmd} ado.org <url>`);
  if (!(v.telegram && v.telegram.chat_id)) off.push(`Telegram: ${cmd} telegram.chat_id <chat>`);
  if (!off.length) return [];
  return ['no se preguntaron porque piden un dato, y se prenden así:', ...off.map((l) => `  ${l}`)];
}

/** Lo que `~/.claude/tycon.json` dice de `install.profile`, tal cual (o null si no está, o el archivo no se lee). */
function machineProfile(ctx) {
  try {
    const d = JSON.parse(fs.readFileSync(mod('tycon-home').configFile(ctx.home), 'utf8').replace(/^﻿/, ''));
    return d && d.install && typeof d.install.profile === 'string' ? d.install.profile.trim() : null;
  } catch (_) { return null; }
}

/** La cabecera del plan: desde qué clon, el perfil, si la instalación anterior quedó a medias (story 8.16, AC 9, 14 y
 *  25) y las notas. */
function planHead(existing, tree, notes = [], profileLine = null) {
  const L = [`antes de escribir nada, esto es lo que hace la instalación desde ${tree}:`];
  // el perfil y, desde la tanda D, las integraciones y el paquete del stack, cada uno con su origen
  for (const l of [].concat(profileLine || [])) if (l) L.push(l);
  if (existing && !existing.last_health) L.push('la instalación anterior quedó a medias: se vuelven a correr el aplicador y la comprobación de salud');
  for (const n of notes) L.push(`ojo: ${n}`);
  return L;
}

// ── las copias de seguridad (AC 17) y el registro de piezas (AC 15-16) ──────────────────────────────────────────────

/**
 * La copia ANTES de un cambio: `{ dir, created }` o `null`. Si no se pudo, se anota y el cambio sigue SIN la variable,
 * así el aplicador hace sus `.bak` de siempre: nunca un cambio sin ninguna copia.
 */
function takeSnapshot(ctx, tree, { reason, from = null, to = null, log = null, force = false, state = null, protect = [] }) {
  try {
    // tanda C: los commits de cada fuente van al manifiesto (a dónde rollback lleva los árboles), y `force` (al mover
    // árboles, en rollback y en uninstall) crea una copia nueva aunque el conjunto sea el mismo (decisiones 1 y 2)
    const sources = state ? currentSources(ctx, state) : null;
    const snap = mod('snapshot').take({ home: ctx.home, env: ctx.env, tree, reason, from, to, force, sources, protect });   // ya aplica la retención
    return snap && snap.dir ? snap : null;
  } catch (e) {
    if (log) log(`copia de seguridad (${reason}): no se pudo (${e.message}) — el aplicador hace sus .bak de siempre`);
    return null;
  }
}
/** `{ <fuente>: <HEAD completo> }` de cada fuente del estado que es un clon de git (las demás no entran). */
function currentSources(ctx, state) {
  const out = {};
  for (const s of (state && state.sources) || []) {
    // la capa (story 8.13.1): su commit es el del estado (el HEAD de un clon de lectura --bare no dice nada)
    const h = mod('state').kindOf(s) === 'layer' ? (s.commit || null) : (s && s.dir ? mod('sources').head(s.dir, { env: ctx.env }) : null);
    if (h && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(h)) out[s.name] = h;
  }
  return Object.keys(out).length ? out : null;
}
/**
 * Después del cambio: el `sha256_after` de cada archivo de la copia. Sólo en una copia recién creada: una reutilizada
 * (mismo conjunto que la anterior) ya tiene el «después» de SU cambio, que la vuelta atrás compara (y por eso, al mover
 * árboles, la copia es siempre nueva: tanda C, decisión 1). Nunca tira.
 */
function finishSnapshot(ctx, snap, log = null) {
  if (!snap || !snap.created) return;
  try { mod('snapshot').finish(snap.dir, { home: ctx.home, env: ctx.env }); } catch (e) { if (log) log(`copia de seguridad: no pude anotar el después (${e.message})`); }
}

/** Los archivos de la copia fija que registra el estado (los de su `bootstrap.sha256`), o los tres de arranque. */
function fixedCopyIds(state) {
  const reg = state && state.bootstrap && state.bootstrap.sha256;
  return reg && typeof reg === 'object' && Object.keys(reg).length ? Object.keys(reg) : BOOTSTRAP_FILES;
}
/** Las piezas que escribe `harness.js` mismo: el `@import`, la línea de arranque y los archivos de la copia fija. */
function ownCandidates(ctx, state) {
  const dir = mod('state').paths(ctx.home).bootstrapDir;
  return [
    { kind: 'import', where: claudeMdPath(ctx), id: IMPORT_LINE },
    { kind: 'startup-line', where: settingsPath(ctx), id: 'SessionStart:bootstrap.js' },
    ...fixedCopyIds(state).map((f) => ({ kind: 'file', where: path.join(dir, f), id: f })),
  ];
}
/** ¿Es una pieza de `harness.js` (no del aplicador)? Ésas las repone `install`, no `apply`. Un archivo de la copia
 *  fija lo es por estar en su carpeta: la lista crece con el programa (tanda C) y cambia entre versiones. */
function isOwnPiece(ctx, p) {
  // el `@import` del índice es propio en TODAS sus formas (la de hoy y las heredadas, import-line.js): la vuelta atrás de una versión lo
  // quitaba como «pieza que esta versión ya no trae» cuando el CLAUDE.md del dev tenía la forma vieja, y nadie lo reponía
  // (máquina Windows de un dev, 2026-10-07): la máquina quedaba sin las guías cargadas
  if (p.kind === 'import') return IMPORT_LINES.includes(String(p.id)) && path.resolve(String(p.where)) === path.resolve(claudeMdPath(ctx));
  if (p.kind === 'file') {
    const dir = mod('state').paths(ctx.home).bootstrapDir;
    return path.resolve(p.where).startsWith(path.resolve(dir) + path.sep);
  }
  return ownCandidates(ctx, null).some((o) => o.kind === p.kind && o.where === p.where && o.id === p.id);
}
function ownPieces(ctx, state) {
  const M = mod('managed'), SL = mod('startup-line');
  return ownCandidates(ctx, state).filter((p) => M.present(p, { home: ctx.home, env: ctx.env, isStartupLine: SL.isNew }) === true);
}

/**
 * Funde en `state.managed` el reporte del aplicador (o `null`: sin reporte), las piezas compartidas que hizo `harness.js`
 * antes de lanzarlo (`shared`; AC 28) y las piezas propias. Las compartidas entran con `union`: un aplicador viejo —el de
 * una vuelta atrás— no conoce la variable y las reporta también, y la fusión del registro no quita repetidos de lo
 * reportado. No son propias: las repone `apply` y se caen del registro si dejan de estar con su valor.
 */
function recordPieces(ctx, state, report, shared = []) {
  const M = mod('managed'), SL = mod('startup-line');
  const opts = { home: ctx.home, env: ctx.env, isStartupLine: SL.isNew };
  const version = state.version && state.version.number;
  const reported = shared && shared.length ? mod('shared').union(report, shared) : (report || []);
  const pieces = [...reported, ...ownPieces(ctx, state)];
  // sin reporte no se sabe qué sacó el aplicador: no se cae nada. Las piezas propias de harness.js tampoco se caen al
  // faltar: el aplicador no las saca ni las repone, y doctor tiene que seguir viéndolas (pase adversarial, iteración 2)
  state.managed = M.merge(state.managed, pieces, { version, present: report ? (p) => (isOwnPiece(ctx, p) ? true : M.present(p, opts)) : null });
  return state.managed;
}

/**
 * El cambio de perfil (story 8.16, tanda C · AC 26): lo registrado que el reporte del aplicador del perfil nuevo ya no
 * trae se quita con `removePieces` —la mecánica de la vuelta atrás: lo ajeno no se toca, un ajuste que el dev cambió
 * queda, un hook de git devuelve su `.local`—. Las piezas propias de harness.js no entran. Sin reporte (un aplicador
 * viejo) no se sabe qué sobra: no se quita nada, y se dice. Se llama ANTES de `recordPieces`. Nunca tira.
 * @returns {{ removed: object[], kept: object[] } | null}  null = no se pudo saber qué sobra
 */
function dropForProfile(ctx, state, tree, applied, log, profileValue) {
  try {
    if (!Array.isArray(applied.report)) { if (log) log('perfil: el aplicador no entregó su reporte de piezas: no sé qué sobra, no quito nada'); return null; }
    const eff = mod('managed').readEffects(tree);
    if (!eff.ok) { if (log) log(`perfil: no pude leer qué trae cada perfil (${eff.reason}): no quito nada`); return null; }
    const drop = mod('profile').toRemove(state.managed, mod('shared').union(applied.report, applied.shared), (p) => isOwnPiece(ctx, p), { effects: eff.effects, profile: profileValue });
    const r = drop.length ? mod('remove').removePieces(drop, { home: ctx.home, env: ctx.env, tree, log, platform: ctx.platform }) : { removed: [], kept: [] };
    if (drop.length && log) log(`perfil: quité ${r.removed.length} pieza(s) que el perfil nuevo no trae${r.kept.length ? `; quedaron ${r.kept.length}: ${r.kept.map((k) => k.why).join(' · ')}` : ''}`);
    // fuera de full no hay hooks de git del arnés: la carpeta global que puso el arnés se saca (2026-10-14), si sigue siendo ésa
    if (profileValue !== 'full' && state.git_hooks_path) {
      const g = mod('git-hooks-path').release({ env: ctx.env, recorded: state.git_hooks_path, log });
      if (g.status === 'removed' || g.status === 'none' || g.status === 'kept') state.git_hooks_path = null;
      if (g.line && g.status !== 'removed') r.kept = [...(r.kept || []), { why: g.line }];
    }
    return r;
  } catch (e) {
    if (log) log(`perfil: no pude quitar lo que el perfil nuevo no trae (${(e && e.message) || e})`);
    return null;
  }
}
/**
 * ¿Cambió el perfil desde la última instalación? (story 8.16, tanda C · AC 26 y 27) Para `startup` y `apply`, que no
 * preguntan: si el perfil vigente difiere del registrado (`full` si la instalación es anterior a los perfiles), toma la
 * copia nueva (`reason: profile`) y devuelve `switching: true`; quien llama corre el aplicador con esa copia y después
 * `dropForProfile`. Con la configuración rota, el aviso (lo del perfil queda como está). Nunca tira.
 */
function profileSwitch(ctx, state, tree, log) {
  const profile = profileOf(ctx, tree);
  if (!profile.ok) return { profile, switching: false, snap: null, notice: `el perfil de instalación no se pudo leer (${profile.reason}): lo del perfil queda como está — node ~/.claude/${PLACE.PLACE_NAME}/scripts/lib/tycon-config.js validate` };
  const was = mod('profile').installedValue(state);
  if (was === profile.value) return { profile, switching: false, snap: null, notice: null };
  const snap = takeSnapshot(ctx, tree, { reason: 'profile', from: state.version && state.version.number, log, force: true, state });
  if (log) log(`perfil de instalación: ${was} → ${profile.value} (${profile.origin}): lo aplico${snap ? ` · copia de antes en ${snap.dir}` : ''}`);
  return { profile, switching: true, snap, notice: null };
}
/** Lo que la persona tiene que saber de un cambio de perfil: lo que no se pudo quitar, o que no se supo qué sobraba. */
function profileSwitchNotes(r) {
  if (r === null) return ['ojo: cambió el perfil y no supe qué sobraba (el aplicador no entregó su reporte): harness.js doctor muestra lo que hay'];
  return (r.kept || []).map((k) => `quedó: ${k.why}`);
}

/**
 * La copia fija de arranque, archivo por archivo: `[{ id, src }]` — `id` es la ruta dentro de
 * ~/.claude/.tycon-pipeline/harness/. Los tres de arranque y, desde la tanda C (decisión 7 del dueño), el PROGRAMA:
 * `program/harness.js` y `program/harness/*.js`, con la misma forma que en el árbol (así `require('./harness/…')`
 * resuelve igual). Es lo que corre `bootstrap.js rollback|uninstall` cuando el árbol no arranca o no está.
 */
/**
 * Los módulos del programa con cada uno DESPUÉS de los que carga (`require('./x')` de la misma carpeta), y si no, en
 * orden alfabético. Una copia cortada a mitad de camino nunca deja un módulo que pide otro que todavía no llegó (story
 * 8.23, pase adversarial de la A1: place.js, state.js y snapshot.js cargan tycon-home.js, que alfabéticamente iba
 * después, y una copia cortada ahí dejaba `rollback`/`uninstall` de emergencia sin arrancar). Un ciclo no frena la copia:
 * el módulo que lo cierra queda donde caiga.
 */
function depsFirst(dir, mods) {
  const set = new Set(mods);
  const deps = (m) => {
    let src = '';
    try { src = fs.readFileSync(path.join(dir, m), 'utf8'); } catch (_) { return []; }
    return [...src.matchAll(/require\(\s*['"]\.\/([^'"/]+?)(?:\.js)?['"]\s*\)/g)].map((x) => `${x[1]}.js`).filter((d) => set.has(d));
  };
  const out = []; const seen = new Set();
  const visit = (m) => { if (seen.has(m)) return; seen.add(m); for (const d of deps(m)) visit(d); out.push(m); };
  for (const m of mods) visit(m);
  return out;
}
function fixedCopyFiles(tree) {
  const setup = path.join(tree, 'scripts', 'setup');
  const out = BOOTSTRAP_FILES.map((f) => ({ id: f, src: path.join(setup, 'harness', f) }));
  // la lista fija de skills con algo más que texto (story 8.25, tanda A2c): un dato que team.js lee de su carpeta; sin ella,
  // uninstall y rollback —que corren desde esta copia— no sabrían qué guardar de esas skills
  out.push({ id: `${PROGRAM_DIR}/harness/team-skill-extras.json`, src: path.join(setup, 'harness', 'team-skill-extras.json') });
  let mods = [];
  try { mods = fs.readdirSync(path.join(setup, 'harness')).filter((n) => n.endsWith('.js')).sort(); } catch (_) { mods = []; }
  for (const m of depsFirst(path.join(setup, 'harness'), mods)) out.push({ id: `${PROGRAM_DIR}/harness/${m}`, src: path.join(setup, 'harness', m) });
  // el programa, DESPUÉS de sus módulos: una copia cortada a mitad de camino no deja un harness.js nuevo sin el place.js
  // que carga al arrancar (rollback y uninstall corren desde acá; segunda vuelta, M3)
  out.push({ id: `${PROGRAM_DIR}/harness.js`, src: path.join(setup, 'harness.js') });
  return out;
}
function bootstrapSha(tree) {
  const out = {};
  for (const f of fixedCopyFiles(tree)) out[f.id] = fs.existsSync(f.src) ? sha256(f.src) : null;
  return out;
}
/** Copia (temporal + rename: una copia fija a medias no arranca) los archivos del árbol a la copia fija y deja sus sha256
 *  en el estado; los módulos del programa que el árbol ya no trae se borran (la copia es la del árbol, no una suma). */
function copyBootstrap(ctx, tree, state, { version = null } = {}) {
  const { bootstrapDir } = mod('state').paths(ctx.home);
  fs.mkdirSync(bootstrapDir, { recursive: true });
  const before = JSON.stringify(state.bootstrap && state.bootstrap.sha256);
  let changed = false;
  const sha = {};
  const files = fixedCopyFiles(tree);
  for (const f of files) {
    const dst = path.join(bootstrapDir, f.id);
    if (!fs.existsSync(f.src)) { sha[f.id] = null; continue; }
    const s = sha256(f.src);
    if (!fs.existsSync(dst) || sha256(dst) !== s) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const tmp = `${dst}.tmp-${process.pid}`;
      fs.copyFileSync(f.src, tmp);
      fs.renameSync(tmp, dst);
      changed = true;
    }
    try { fs.chmodSync(dst, 0o755); } catch (_) { /* Windows */ }
    sha[f.id] = s;
  }
  const keep = new Set(files.map((f) => path.basename(f.id)));
  const progMods = path.join(bootstrapDir, PROGRAM_DIR, 'harness');
  let stale = [];
  try { stale = fs.readdirSync(progMods).filter((n) => n.endsWith('.js') && !keep.has(n)); } catch (_) { stale = []; }
  for (const n of stale) { try { fs.rmSync(path.join(progMods, n), { force: true }); changed = true; } catch (_) { /* queda: doctor no la cuenta */ } }
  // la versión bajada (story 8.23, tanda B) no tiene git que preguntar: quien llama pasa el número
  state.bootstrap = { version: version || sha7(mod('sources').head(tree, { env: ctx.env })), sha256: sha };
  return changed || before !== JSON.stringify(sha);
}
/** La copia fija contra el estado y contra el árbol (los ids del estado y los del árbol). */
function bootstrapStatus(ctx, tree, state) {
  const { bootstrapDir } = mod('state').paths(ctx.home);
  const registered = (state.bootstrap && state.bootstrap.sha256) || {};
  const inTree = bootstrapSha(tree);
  const ids = [...new Set([...BOOTSTRAP_FILES, ...Object.keys(registered).filter((k) => registered[k])])];
  const installed = {};
  for (const f of ids) { const p = path.join(bootstrapDir, f); installed[f] = fs.existsSync(p) ? sha256(p) : null; }
  const missing = ids.filter((f) => !installed[f]);
  const vsState = ids.filter((f) => installed[f] && registered[f] && installed[f] !== registered[f]);
  // vieja respecto del árbol: un archivo distinto, o uno que el árbol trae y la copia todavía no (una versión con el
  // programa sobre una copia fija de antes de la C). Los finales de línea no cuentan (seguimiento de la W3a, punto 12): la
  // copia de un clon viejo se tomó con \r\n, el paso de finales de línea deja el árbol con \n, y la copia se refresca a
  // propósito sólo tras una salud en verde — sin esto, doctor la daba «vieja» en cada sesión con el mismo contenido.
  const srcOf = Object.fromEntries(fixedCopyFiles(tree).map((f) => [f.id, f.src]));
  const vsTree = Object.keys(inTree).filter((f) => inTree[f] && (installed[f] === undefined ? !fs.existsSync(path.join(bootstrapDir, f)) : installed[f] && installed[f] !== inTree[f] && !sameTextIgnoringEol(path.join(bootstrapDir, f), srcOf[f])));
  return { missing, vsState, vsTree };
}

/** El `@import` de ~/.claude/CLAUDE.md, una sola vez. */
function ensureImport(ctx) {
  const file = claudeMdPath(ctx);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { text = ''; }
  if (text.split('\n').some(IMPORT.isIndexLine)) {
    // una forma vieja (nombre viejo del lugar, o el README.md que era el índice) pasa a la de hoy en su lugar; con varias
    // (el código de antes, corrido después de una vuelta atrás, agrega la suya) queda una
    const d = IMPORT.rewrite(text);
    if (d.changed) mod('state').writeAtomic(file, d.text);
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  mod('state').writeAtomic(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${IMPORT_LINE}\n`);
  return true;
}

/** ¿Está prendida la integración engram? (tycon-config, modo hook: nunca tira). */
function engramOn(ctx, tree) {
  try {
    const cfg = require(path.join(tree, 'scripts', 'lib', 'tycon-config.js'));
    const r = cfg.integracionParaHook('engram', { env: ctx.env, home: ctx.home, arnes: tree });
    return Boolean(r && r.ok && r.prendida);
  } catch (_) { return false; }
}

const applyHint = `node ~/.claude/${PLACE.PLACE_NAME}/scripts/setup/harness.js update --yes`;
const isTemporary = (ctx, dir) => {
  const d = real(dir) || path.resolve(dir);
  const roots = ['/tmp', '/private/tmp', ctx.env.TMPDIR, ctx.env.TEMP, ctx.env.TMP].filter(Boolean).map((r) => real(r) || path.resolve(r));
  return roots.some((r) => d === r || d.startsWith(r + path.sep));
};

// ── el estado como lo ve un comando ─────────────────────────────────────────────────────────────────────────────────
function loadState(ctx) { return mod('state').read(ctx.home); }
/** Para los comandos que exigen estado sano: devuelve `{ fail }` con código y línea, o `{ state }`. */
function needState(ctx) {
  const r = loadState(ctx);
  if (r.status === 'ok') return { state: r.state, read: r };
  return { fail: mod('state').fail(r, { home: ctx.home }), read: r };
}
const busy = (lock) => ({ code: 3, lines: [`harness.js: ${lock.reason || 'otra sesión está actualizando'}`] });

function policyOf(ctx, tree) {
  const p = mod('channel').read(ctx.home, ctx.env, { tree });
  return p;
}
function versionNumber(ctx, state) { return mod('report').derive(state, { env: ctx.env }).number; }

// ── story 8.18: la llave de la transición a un solo repo ─────────────────────────────────────────────────────────────

/** `repoint.js`, o `null` si esta versión no lo trae (un árbol de antes de la 8.18, corrido en una vuelta atrás). */
function repointModule(log) {
  try { return mod('repoint'); } catch (e) {
    if (log) log(`repoint: sin repoint.js en esta versión (${(e && e.code) || (e && e.message)}): la llave update.skills_source no se mira`);
    return null;
  }
}
/**
 * Re-apunta el clon viejo de agent-skills al repo unificado, o lo deshace, según la llave (AC 31 a 33). Corre antes de
 * mirar si hay versión nueva. `apply: false` = la política es `ask` y nadie dijo `--yes`: avisa y no muda nada.
 * `proceed: false` = ese clon no pudo pasar y en esta corrida no se mueve NINGUNA fuente (AC 32).
 * @returns {{ status: string, proceed: boolean, lines: string[], notice: string|null }}
 */
function runRepoint(ctx, state, policy, { log = null, manual = false, apply = true, dryRun = false } = {}) {
  const none = { status: 'none', proceed: true, lines: [], notice: null };
  const RP = repointModule(log);
  if (!RP || typeof RP.run !== 'function') return none;
  try {
    return RP.run(ctx, state, {
      want: policy.skillsSource || 'separate', manual, apply, dryRun, log,
      // la copia ANTES de mover, nueva y con los commits de cada fuente; sin copia no se muda. Un intento que se corta a
      // mitad de camino y se reintenta en cada arranque no puede ir comiéndose las copias (quedan 5): si la más nueva ya
      // es la de esta misma mudanza y nada cambió desde entonces, sirve ésa
      backup: (reason, to) => {
        let again = false;
        try { const last = mod('snapshot').list(ctx.home)[0]; again = Boolean(last && last.manifest && last.manifest.reason === reason && last.manifest.to === to); } catch (_) { again = false; }
        return takeSnapshot(ctx, state.tree, { reason, from: state.version && state.version.number, to, log, force: !again, state });
      },
      finish: (snap) => finishSnapshot(ctx, snap, log),
      write: () => mod('state').write(ctx.home, state),
    }) || none;
  } catch (e) {
    // nunca una pila, y nunca un arranque caído por la llave: se dice, y no se mueve ninguna fuente en esta corrida
    const text = `una mudanza del clon de skills no se pudo mirar (falla interna: ${e && e.message ? e.message : e}): no se mueve ninguna fuente; harness.js doctor lo detalla`;
    if (log) log(`repoint: ${text}${e && e.stack ? ` ${e.stack}` : ''}`);
    return { status: 'blocked', proceed: false, lines: [text], notice: text };
  }
}

/**
 * El freno «no avanza en línea recta» de la llave, pedido a mano (pase adversarial del tramo 3, clase 2). El caso: el
 * repo viejo de agent-skills recibió un commit después de la unión y el clon de skills lo bajó; el destino de la mudanza
 * sale del clon LOCAL del arnés, y con el clon de skills frenado no se actualiza ninguna fuente (AC 32). Aunque el repo
 * unificado mergee ese commit, el clon del arnés no lo baja nunca: la máquina no se destrababa ni con el comando que el
 * propio aviso nombra. Decisión (2026-10-04, a confirmar por el dueño): el arranque automático sigue sin mover nada;
 * `harness.js update` corrido por una persona trae primero la fuente del arnés y reintenta la mudanza en el mismo comando.
 * Con una condición, para no romper el AC 32 de gusto: el arnés avanza SÓLO si lo publicado ya contiene el commit del
 * clon de skills (se trae, que no mueve nada, y se mira). Si todavía no lo contiene, la mudanza no pasaría igual: no se
 * mueve ninguna fuente, como siempre. «Lo contiene» contesta en tres estados: si no se pudo traer o comparar, no se
 * mueve nada y se DICE que no se pudo, con la causa — antes salía como «todavía no lo contiene» (segunda vuelta del
 * revisor de fallos silenciosos del tramo 3).
 * @returns el resultado de `doUpdate` sobre la fuente del arnés; `{ status: 'unknown', lines }` si no se pudo mirar; o
 *   `null` si no había con qué destrabar (o todavía no lo contiene: el aviso de la llave ya lo dice)
 */
function unblockStraightLine(ctx, state, policy, { log = null, yes = false } = {}) {
  const SRC = mod('sources');
  const env = ctx.env;
  const hs = harnessSource(state);
  const skills = (state.sources || []).find((s) => s && s.name === 'agent_skills');
  if (!hs || !skills || hs === skills) return null;
  const said = (l) => { if (log) log(`update: ${l}`); };
  const unknown = (l) => { said(l); return { status: 'unknown', lines: [l] }; };
  const brought = SRC.fetch(hs, { env });
  const mine = SRC.head(skills.dir, { env });
  if (!brought.ok || !brought.to || !mine) return unknown(`no pude mirar si lo publicado del arnés ya contiene el commit del clon de skills (${brought.ok && brought.to ? `no pude leer HEAD de ${skills.dir}` : brought.reason || 'no pude traer lo publicado'}): no se mueve ninguna fuente`);
  const has = SRC.commitState(hs.dir, mine, { env });
  const contains = has.status === 'ok' ? SRC.ancestorState(hs.dir, mine, brought.to, env)
    : (has.status === 'absent' ? { status: 'no', reason: null } : { status: 'unknown', reason: has.reason });
  if (contains.status === 'unknown') return unknown(`no pude comparar lo publicado del repo unificado (${sha7(brought.to)}) con el commit del clon de skills (${sha7(mine)}): ${contains.reason}; no se mueve ninguna fuente (se reintenta con este mismo comando)`);
  if (contains.status === 'no') { said(`lo publicado del repo unificado (${sha7(brought.to)}) todavía no contiene el commit del clon de skills (${sha7(mine)}): no se mueve ninguna fuente`); return null; }
  said(`lo publicado del repo unificado (${sha7(brought.to)}) ya contiene el commit del clon de skills (${sha7(mine)}): traigo primero el arnés y reintento la mudanza`);
  return doUpdate(ctx, state, { mode: 'apply', log, yes, policy, only: hs.name });
}

// ── tanda D: los canales, el repo público y la confirmación de `latest` + `auto` ─────────────────────────────────────

/** La fuente del arnés (el clon al que apunta el enlace): la que se llama así, o la primera de la lista. */
function harnessSource(state) {
  const list = (state && state.sources) || [];
  return list.find((s) => s && s.name === 'harness') || list[0] || null;
}
/** ¿Es una copia del repo público? UN solo criterio (A1): el origen fijado del arnés está en la lista que trae el árbol. */
function isPublicCopy(ctx, state) {
  const hs = harnessSource(state);
  return Boolean(hs && mod('sources').isPublicRemote(state.tree, hs.url));
}
const NOT_PUBLIC_NOTE = 'el remoto de este clon no es el repo público: latest y stable leen main, sin reescritura';

/**
 * La política vigente, puesta en el estado (A2, A9): hay UNA verdad para el canal —la configuración—, y `state.channel`
 * la copia; una fuente cuyo origen fijado es el repo público queda marcada como «se reescribe» (sólo se prende: el árbol
 * puede haber empezado a declarar su remoto después de instalar; una marca ya puesta no se saca). La ref de cada fuente
 * la calcula `sources.check` con ese canal, cada vez que se mira.
 *
 * Si el canal vigente CAMBIÓ respecto del que guardaba el estado —por `channel`, por el archivo a mano, por la variable o
 * por el perfil—, lo que se sabía de la última mirada ya no vale: se sueltan las dos ventanas (`last_fetch` y
 * `last_fetch_failed`), así el arranque siguiente mira sin esperar las 6 horas de `ask`, y se saca el aviso que salió de
 * mirar el canal anterior («arnés X disponible … canal latest» con el estado ya en `stable`). Antes sólo `channel`
 * soltaba la mirada (pase adversarial de la tanda D, causa E).
 * @returns {{ channelChanged: boolean }}
 */
function applyPolicy(ctx, state, policy) {
  const SRC = mod('sources');
  const channelChanged = Boolean(state.channel) && state.channel !== policy.channel;
  if (channelChanged) {
    state.last_fetch = null;
    state.last_fetch_failed = null;
    if (state.notice && !REEVALUATED_NOTICE.test(state.notice)) state.notice = null;
  }
  state.channel = policy.channel;
  for (const src of state.sources || []) {
    if (src && !src.rewrites && SRC.isPublicRemote(state.tree, src.url)) src.rewrites = true;
  }
  return { channelChanged };
}
// Los avisos que CADA arranque re-evalúa sí o sí, del estado o de lo que corre (el aplicador, la política, la retención,
// el intento fallido, el respaldo en shell). Los demás salen de MIRAR la red (versión nueva, fuente bloqueada o divergida,
// origin cambiado) y se conservan mientras no se vuelva a mirar — salvo que cambie el canal, o que otra mirada diga otra cosa.
// (los de la llave de la 8.18 también: `repoint.run` los vuelve a decir en cada arranque mientras valgan)
const REEVALUATED_NOTICE = /^(el aplicador falló|la instalación quedó a medias|la actualización .* no quedó sana|la actualización quedó a medias|la versión .* no quedó sana|retención:|la comprobación de salud no pasó|la política de actualización está mal escrita|respaldo en shell|skills re-apuntadas|skills de vuelta en el repo viejo|la llave pide el repo unificado|la llave volvió a «separate»|la llave update\.skills_source|una mudanza del clon de skills|el perfil de instalación no se pudo leer|el arnés corre con el Node del PATH)/;

/** El aviso de una versión nueva que no se aplica sola (AC 26): qué versión, cómo aplicarla y dónde ver los cambios. Lo
 *  deja `startup` y también un `update` sin `--yes` en `ask` (el hook síncrono lo imprime en la sesión siguiente). */
function availableText(state, policy, u) {
  const a = u.available || { label: u.lines[0].replace(/^hay versión nueva: /, ''), changes: '' };
  return `arnés ${a.label} disponible (instalada ${state.version.number}, canal ${policy.channel}) · aplicar: ${applyHint}${a.changes ? ` · cambios: ${a.changes}` : ''}`;
}

/** «instalada X, estable Y: no se baja; para volver, rollback» (AC 25): lo traído es más viejo que lo instalado. */
function noDowngradeText(x, channel) {
  const n = (x.c.numbers) || {};
  const who = x.src.name === 'harness' ? '' : `${x.src.name}: `;
  return `${who}instalada ${n.from || sha7(x.c.from)}, ${channel === 'latest' ? 'latest' : 'estable'} ${n.to || sha7(x.c.to)}: no se baja; para volver, harness.js rollback`;
}

/**
 * Lo que dice el aviso de una versión nueva (AC 26): su nombre —el número de la versión nueva del arnés con su sha corto;
 * varias versiones de `latest` pueden compartir número— y dónde ver los cambios. El enlace sale de la URL fijada de la
 * fuente, nunca de una constante: en `stable`, instalado contra nuevo (los dos viven en `main`, que no se reescribe); en
 * `latest`, la punta de `main` contra el nuevo (nunca entre dos commits de `mirror/sync`: el viejo pudo ser reescrito);
 * con un remoto que no es el público, sin enlace: el `git log` listo para pegar.
 */
function describeAvailable(ctx, state, fresh, channel) {
  const SRC = mod('sources'), R = mod('report');
  const env = ctx.env;
  const hs = harnessSource(state);
  const hx = fresh.find((x) => hs && x.src.name === hs.name);
  let label = state.version && state.version.number;
  if (hx) {
    // estampado: número + sha corto; derivado (el commit no trae version.json): ya lleva el sha; y si el archivo está
    // pero no se pudo leer, NO se le inventa el derivado: se nombra por su sha y se dice (una fuente de ref fija se
    // ofrece igual —va por ancestría—; en una que se reescribe, `check` ya la frenó como «no pude mirar»)
    const n = R.numberAt(hx.src.dir, hx.c.to, { env });
    if (n.problem) label = `${sha7(hx.c.to)} (su número no se pudo leer: ${n.problem})`;
    else label = n.stamped ? `${n.number} (${sha7(hx.c.to)})` : n.number;
  }
  const others = fresh.filter((x) => x !== hx).map((x) => `${x.src.name.replace(/_/g, '-')} ${sha7(x.c.to)}`);
  if (others.length) label = `${label} · ${others.join(' · ')}`;
  const changes = fresh.map(({ src, c }) => {
    const web = src.rewrites ? SRC.webBase(src.url) : null;
    if (!web) return `git -C ${src.dir} log ${sha7(c.from)}..${sha7(c.to)}`;
    let base = channel === 'latest' && c.mainTip && c.mainTip !== c.to ? c.mainTip : null;
    // lo instalado contra lo nuevo; si lo instalado no es ancestro (venía de la rama reescrita), desde donde se separan
    if (!base) base = SRC.git(src.dir, ['merge-base', c.from, c.to], { env }).out || c.from;
    return `${web}/compare/${base}...${c.to}`;
  });
  return { label, changes: changes.join(' ; ') };
}

const LATEST_AUTO_REMINDER = 'latest + auto en una copia pública: recibís lo que el equipo del arnés empuja, en minutos, sin revisión tuya';
const saidYes = (answer) => mod('prompt').saidYes(answer);
const readLine = () => mod('prompt').readLine();
/**
 * La confirmación de `latest` + `auto` afuera (AC 29b, D2): en una copia pública, pasar a `latest` no produce esa
 * combinación sin preguntar. Aplicación `auto` puesta por archivo → pregunta en la terminal (sin terminal, 2); `auto` por
 * variable (`TYCON_UPDATE_APPLY=auto`, puesta por la persona) → ya es su confirmación; `ask` → pasa. Fuera de una copia
 * pública, o si el canal ya era `latest`, no hay nada que confirmar.
 * @returns {{ ok: boolean, code?: number, declined?: boolean, lines: string[] }}
 */
function confirmLatestAuto(ctx, { value, policy, publicCopy, cmd, probe = false }) {
  if (value !== 'latest' || !publicCopy || policy.channel === 'latest') return { ok: true, lines: [] };
  if (policy.apply !== 'auto') return { ok: true, lines: ['aplicación ask: cada versión nueva de latest se te avisa y la aplicás vos (con auto recibirías lo que el equipo del arnés empuja, en minutos, sin revisión tuya)'] };
  if (policy.origins.apply === 'env') return { ok: true, lines: [`${LATEST_AUTO_REMINDER} (TYCON_UPDATE_APPLY=auto es tu confirmación)`] };
  // `probe` (install --dry-run, story 8.16): sólo decir si hace falta la confirmación, sin preguntar
  if (probe) return { ok: true, needs: true, lines: [] };
  if (!process.stdin.isTTY) {
    return { ok: false, code: 2, lines: [`harness.js ${cmd}: ${LATEST_AUTO_REMINDER}. Hace falta tu confirmación: corrélo en una terminal, o poné TYCON_UPDATE_APPLY=auto vos (esa variable ya es tu confirmación)`] };
  }
  process.stdout.write(`${LATEST_AUTO_REMINDER}.\n¿Paso a latest? [s/N] `);
  if (!saidYes(readLine())) return { ok: false, code: 0, declined: true, lines: [] };
  return { ok: true, lines: [] };
}

// ── los comandos ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Volver a instalar sobre el MISMO árbol vuelve a detectar las fuentes (pase adversarial del tramo 3 de la 8.18, clase
 * 20). El caso: una máquina de dos clones pasa a un solo árbol —el dev borra su clon viejo y el aplicador enlaza
 * `~/.claude/agent-skills` al clon del arnés—. El estado seguía listando la fuente `agent_skills` con la URL vieja:
 * `update` salía 2 («el origin de agent_skills cambió… install --source <url>») y ese remedio contestaba «sin cambios»,
 * porque las fuentes sólo se detectaban la primera vez o al instalar desde OTRO clon. Era, además, la antesala de la
 * clase 1: con la llave en `unified`, esa fuente vieja disparaba la mudanza sobre el clon del arnés.
 *   · una fuente del estado que ya no se detecta se SUELTA sólo si su carpeta ya no existe o es el árbol mismo (o está
 *     adentro). Si la carpeta sigue ahí y es otra cosa —un clon roto— no se suelta: es un rojo de `doctor`, no un cambio
 *     de forma de la máquina. Con ella se va lo que el estado anotó de la mudanza de ESE clon;
 *   · «ya no existe» lo dice el disco (ENOENT), no cualquier falla: si la carpeta no se pudo MIRAR (permisos, un disco
 *     que no responde) la fuente queda, lo anotado de su mudanza también, y se dice con la causa. Antes cualquier falla
 *     al resolverla se leía como «ya no existe», y se soltaba la fuente de skills y se borraba de dónde venía su clon
 *     —también una mudanza a medias— (segunda vuelta del revisor de fallos silenciosos del tramo 3);
 *   · una fuente que se detecta y el estado no tenía (un clon aparte que antes no estaba) se SUMA.
 * Las que siguen estando no se tocan: su URL fijada sólo la cambia `--source`. Cambia `state` y agrega a `notes`; el
 * nombre de cada fuente que no pudo mirar va a `blind`: con alguna, `install` sale 1 (tercera vuelta del revisor de
 * fallos silenciosos: salía 0 con la nota cuando la salud no corría o pasaba — «no pude mirar» no es «instalado»).
 * @returns {boolean} si cambió algo
 */
function redetectSources(state, detected, tree, notes, blind = []) {
  let changed = false;
  const now = new Set(detected.map((s) => s.name));
  for (const old of [...(state.sources || [])]) {
    if (!old || now.has(old.name)) continue;
    // una fuente de capa (story 8.13.1) no es un clon que `detect` vea: su clon de lectura es del mecanismo y, si falta,
    // se vuelve a armar. Nunca se saca de acá (pase adversarial de la tanda A, clase 16)
    if (mod('state').kindOf(old) === 'layer') continue;
    let at = null;
    if (old.dir) {
      try { at = fs.realpathSync(old.dir); } catch (e) {
        if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) {
          notes.push(`no pude mirar la fuente ${old.name} (${old.dir}: ${(e && (e.code || e.message)) || e}): no la saco del estado ni toco lo anotado de su mudanza; install la vuelve a mirar la próxima vez`);
          blind.push(old.name);
          continue;
        }
      }
    }
    if (at && at !== tree && !at.startsWith(tree + path.sep)) continue;
    state.sources = state.sources.filter((s) => s !== old);
    const dropped = old.name === 'agent_skills' && state.repoint ? ' (y lo anotado de la mudanza de ese clon)' : '';
    if (dropped) delete state.repoint;
    notes.push(`la fuente ${old.name} ya no es un clon aparte (${old.dir} ${at ? 'es el clon del arnés' : 'ya no existe'}): se saca del estado${dropped}; ${state.sources.length === 1 ? 'queda una sola fuente' : `quedan ${state.sources.length} fuentes`}`);
    changed = true;
  }
  for (const fresh of detected) {
    if ((state.sources || []).some((s) => s && s.name === fresh.name)) continue;
    state.sources.push(fresh);
    notes.push(`la fuente ${fresh.name} se suma al estado: ${fresh.dir} es un clon aparte (origin ${fresh.url || '(ninguno)'})`);
    changed = true;
  }
  return changed;
}

/**
 * Las piezas de este archivo que la instalación `release` (story 8.23, tanda B · scripts/setup/harness/release.js) reusa:
 * todo lo que no sabe de git. Lo que sí sabe de git (sources.js, report.derive, currentSources sobre un clon) no entra.
 */
function releaseHelpers(ctx) {
  const S = mod('state');
  return {
    takeSnapshot, finishSnapshot, runApplier, noteHooksPath, hooksPathUnattended, runHealth, recordPieces, ensureLink, linkResolvesTo, ensureImport, copyBootstrap,
    settingsPath, policyOf, applyPolicy, installQuestions, codegraphInstall, writeAnswers, profileOf, machineProfile, holdText, availableText,
    applyHint, REEVALUATED_NOTICE, engramOn, missingRequirement, profileSwitch, dropForProfile, profileSwitchNotes, toolChoice, withAnswers, toolNotice,
    harnessNodeNotice, packRetiredLine,
    engramSync: (c) => {
      if (!findInPath('engram', c.env)) return;
      const e = spawnSync('engram', ['sync', '--import'], { windowsHide: true, encoding: 'utf8', env: c.env, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
      if (e.status !== 0) mod('report').log(c.home, `startup: engram sync --import salió ${e.status === null ? 'matado' : e.status}`);
    },
    isRelease: (state) => S.isRelease(state),
  };
}

/** Las piezas de este programa que usa `move-home.js` (la mudanza a ~/.tycon; story 8.23, tanda D): las de release más las de las herramientas. */
function migrateHelpers(ctx) { return Object.assign({}, releaseHelpers(ctx), toolHelpers()); }

/**
 * `migrate --to-home [--dry-run]` (story 8.23, tanda D · AC 27-29): la mudanza de esta máquina del clon a ~/.tycon. Vive en
 * move-home.js; acá sólo se exige la opción (sin `--to-home` no hay otra mudanza que hacer: se dice).
 */
function cmdMigrate(ctx) {
  if (!ctx.opts['to-home']) return { code: 2, lines: ['harness.js migrate: hace falta --to-home (la única mudanza que existe: del clon a ~/.tycon); --dry-run dice el plan sin escribir'] };
  const r = mod('move-home').migrate(ctx, migrateHelpers(ctx));
  return { code: r.code, lines: r.lines };
}

/** Las piezas de este programa que usa `tool-change.js` (sumar o sacar una herramienta; story 8.23, tanda C). */
function toolHelpers() {
  return { takeSnapshot, finishSnapshot, runClaudeApplier, runHealth, recordPieces, ensureLink, ensureImport, settingsPath, linkPath, busy };
}

/**
 * El aviso de una herramienta instalada y sin enchufar (story 8.23, tanda C · AC 24), o null. Las llaves salen de la
 * configuración del árbol; sin poder leerlas, «sin decir». Nunca tira.
 */
function toolNotice(ctx, tree, state) {
  try {
    const T = mod('tools');
    let keys = {};
    try {
      const C = require(path.join(tree, 'scripts', 'lib', 'tycon-config.js'));
      if (typeof C.toolKeys === 'function' && typeof C.sinAnotar === 'function') keys = C.sinAnotar(() => C.toolKeys(C.cargar({ home: ctx.home, env: ctx.env })));
    } catch (_) { keys = {}; }
    return T.unpluggedNotice({ state, detected: T.detect({ home: ctx.home, env: ctx.env, platform: ctx.platform }), keys, home: ctx.home, env: ctx.env });
  } catch (_) { return null; }
}

function cmdInstall(ctx) {
  const S = mod('state'), L = mod('lock'), SRC = mod('sources'), R = mod('report'), SL = mod('startup-line');
  // la versión bajada (story 8.23, tanda B · AC 8): otra forma de instalación, en su propio módulo
  // (y con `--team` solo, story 8.25: la capa del equipo es de la versión bajada)
  if (ctx.opts.version !== undefined || ctx.opts.repo !== undefined || ctx.opts.team !== undefined) return mod('release').cmdInstall(ctx, releaseHelpers(ctx));
  // una herramienta que llega después (story 8.23, tanda C · AC 26): `install --tool <la nueva>` sobre una máquina que YA
  // está instalada enchufa sólo ésa —sin red, sin otra versión, sin tocar la otra—. Con cualquier otra opción de install
  // (o sin estado) es una instalación, como siempre.
  if (ctx.opts.tool !== undefined && !['channel', 'local', 'from-existing', 'source', 'profile', 'integrations', 'packs', 'harness-clone'].some((k) => ctx.opts[k] !== undefined)) {
    const st = loadState(ctx);
    if (st.status === 'ok') return mod('tool-change').add(ctx, st.state, toolHelpers(ctx));
  }
  const fromExisting = Boolean(ctx.opts['from-existing']);
  let tree = ctx.opts.local ? real(ctx.opts.local) : ctx.tree;
  if (ctx.opts.local && !isHarnessClone(tree)) return { code: 2, lines: [`harness.js install: ${ctx.opts.local} no es un clon del arnés (sin scripts/install-tycon-hooks.sh)`] };
  // `--harness-clone` (story 8.13.1, AC 1): de qué clon interno se lee la capa privada. Se valida antes de escribir nada.
  // La capa se apila sólo en una máquina que instala desde la copia pública; en `source: internal` (la de hoy) el árbol
  // ya es el clon interno y no hay capa: se dice, y la instalación sigue como siempre.
  const cloneNote = [];
  let layerWanted = null;   // sobre una copia pública: { reference } — de qué clon interno se lee la capa (AC 1, 7)
  if (ctx.opts['harness-clone'] !== undefined) {
    const hc = real(ctx.opts['harness-clone']);
    if (!hc || !isHarnessClone(hc) || !mod('sources').isRepo(hc, { env: ctx.env })) return { code: 2, lines: [`harness.js install: --harness-clone ${ctx.opts['harness-clone']} no es un clon de git del arnés (sin scripts/install-tycon-hooks.sh)`] };
    if (fromExisting) return { code: 2, lines: ['harness.js install: --harness-clone no va con --from-existing (esa corrida no instala nada)'] };
    // sobre una copia pública la máquina queda en `source: public` con la fuente `internal` (la capa): su clon de lectura
    // (--bare, con --reference a ése, que no se toca) se arma, se elige el commit (AC 7) y la capa se apila antes del
    // aplicador. Si la capa no se puede preparar, no se instala nada (no se instala a medias, sin la capa pedida)
    if (mod('sources').publicRemotes(tree) !== null) {
      layerWanted = { reference: hc };
      cloneNote.push(`capa privada: se lee de ${hc} (clon de lectura ${path.join(mod('state').paths(ctx.home).sourcesDir, mod('state').LAYER_SOURCE)}, --bare con --reference a tu clon, que no se toca) y se apila sobre la copia pública`);
    } else {
      cloneNote.push(`capa privada: --harness-clone ${hc} queda sin efecto en esta máquina, que instala desde el clon interno (source: internal), que ya lo trae todo; la capa se apila al instalar desde la copia pública. Para calcularla sin tocar nada: harness.js layer --public <copia> --harness-clone ${hc}`);
    }
  }
  if (fromExisting) {
    // sobre un clon y un enlace que ya están: el árbol es el que apunta el enlace (si es un clon válido), si no, éste
    const linked = PLACE.resolvePlace({ home: ctx.home }).dir;   // el lugar, o el nombre viejo (8.19)
    if (linked && isHarnessClone(linked)) tree = linked;
  }
  tree = real(tree) || tree;

  // (0) antes de escribir nada: los requisitos del aplicador y agent-skills
  const missing = missingRequirement(ctx);
  if (missing) return { code: 1, lines: [`harness.js install: ${missing}`] };
  if (!skillsPresent(ctx, tree)) {
    return { code: 1, lines: [`✗ tycon: agent-skills no encontrado en ${path.join(ctx.home, '.claude', 'agent-skills', 'skills')} (ni skills/ y agents/ en la raíz del clon) — ver el README.md del arnés, 'Instalación'`] };
  }
  const read = loadState(ctx);
  if (read.status !== 'ok' && read.status !== 'missing') return { code: S.fail(read, { home: ctx.home }).code, lines: [S.fail(read, { home: ctx.home }).line] };
  // la capa que la máquina YA tiene (story 8.13.1; pase adversarial de la tanda A, clase 16 y C3): sin --harness-clone,
  // install no la suelta. Si el árbol es otro (--local) o falta su clon de lectura, se vuelve a preparar como con
  // --harness-clone, desde la misma fuente; si no se puede, no se instala nada (como con --harness-clone). Sobre un clon
  // interno (no una copia pública) la capa no tiene dónde ir: sale del estado y se dice (más abajo)
  let layerDropNote = null;
  if (layerWanted === null && ctx.opts['harness-clone'] === undefined && !fromExisting && read.status === 'ok' && read.state.source === 'public') {
    const had = S.layerSources(read.state).find((s) => s.name === S.LAYER_SOURCE);
    if (had) {
      const moved = real(read.state.tree) !== tree;
      const noClone = !SRC.isBare(had.dir, { env: ctx.env });
      if (SRC.publicRemotes(tree) === null) {
        if (moved) layerDropNote = `capa privada: ${tree} es un clon interno, que ya lo trae todo (source: internal): la fuente ${had.name} sale del estado y la capa no se apila acá`;
      } else if (moved || noClone) {
        layerWanted = { reference: had.reference || null, implicit: true };
        cloneNote.push(`capa privada: ${moved ? `el árbol cambia a ${tree}` : `falta su clon de lectura (${had.dir})`} — se vuelve a preparar desde la fuente ${had.name} del estado (${had.reference || had.url}), sin --harness-clone`);
      }
    }
  }

  // lo que se decide ANTES de escribir nada (tanda D)
  const early = [...cloneNote];
  if (ctx.opts.channel && !['latest', 'stable'].includes(ctx.opts.channel)) return { code: 2, lines: [`harness.js install: canal «${ctx.opts.channel}»: tiene que ser latest o stable`] };
  // `--source <url>` re-fija la fuente cuyo `origin` ES esa URL (A10): antes pisaba siempre la del arnés, y seguir el
  // consejo de `update` para agent-skills dejaba las dos fuentes en rojo. Una URL que no es el origin de ninguna no se fija
  let pinned = null;
  if (ctx.opts.source) {
    const detected = SRC.detect({ tree, home: ctx.home, env: ctx.env });
    const want = SRC.remoteIdentity(ctx.opts.source);
    const hit = detected.find((s) => s.url === ctx.opts.source) || detected.find((s) => want && SRC.remoteIdentity(s.url) === want);
    if (!hit) {
      return { code: 2, lines: [`harness.js install: --source ${ctx.opts.source}: ninguna fuente tiene ese origin (${detected.map((s) => `${s.name}: ${s.url || '(ninguno)'}`).join(' · ')}) — --source re-fija la fuente cuyo origin YA es esa URL: primero cambiá el remoto del clon (git -C <clon> remote set-url origin <url>)`] };
    }
    pinned = { name: hit.name, url: hit.url };
  }
  // `--channel latest` en una copia pública no deja `latest` + `auto` sin preguntar (AC 29b, D2). Con `--dry-run` no se
  // pregunta nada: el plan dice el cambio de canal y avisa que, al instalar de verdad, se pide esa confirmación (pase
  // adversarial de la tanda B, clase 9)
  const dryRunNotes = [];
  if (ctx.opts.channel && ctx.opts['dry-run'] && !fromExisting) {
    const confirm = confirmLatestAuto(ctx, { value: ctx.opts.channel, policy: policyOf(ctx, tree), publicCopy: SRC.isPublicRemote(tree, SRC.origin(tree, { env: ctx.env })), cmd: 'install', probe: true });
    if (confirm.needs) dryRunNotes.push(`al instalar de verdad con --channel ${ctx.opts.channel} se te pide confirmarlo: ${LATEST_AUTO_REMINDER}`);
  } else if (ctx.opts.channel) {
    const confirm = confirmLatestAuto(ctx, { value: ctx.opts.channel, policy: policyOf(ctx, tree), publicCopy: SRC.isPublicRemote(tree, SRC.origin(tree, { env: ctx.env })), cmd: 'install' });
    if (confirm.declined) return { code: 0, lines: ['no se instaló nada: latest + auto quedó sin confirmar (install sin --channel latest, o con la aplicación en ask)'] };
    if (!confirm.ok) return { code: confirm.code, lines: confirm.lines };
    early.push(...confirm.lines);
  }

  // (story 8.16, tanda B · AC 13 a 16) el plan ANTES de escribir, sin candado y sin crear carpetas; después, la
  // conformidad: `--dry-run` sólo lo muestra (gana sobre `--yes`), `--yes` sigue, una terminal pregunta una vez, y sin
  // terminal ni `--yes` no se escribe nada (2). `--from-existing` no pregunta: lo llama el aplicador sobre una instalación
  // que ya existe y no hay nadie para contestar.
  // `--profile` (story 8.16, tanda C · AC 25 y 27): un valor fuera de la lista, o una variable que dice otro, sale 2 sin
  // escribir. El plan se arma con el perfil pedido (por su variable, sólo para el plan: no se escribe nada antes de la
  // conformidad); la clave se escribe en ~/.claude/tycon.json adentro del candado, antes del aplicador.
  const PR = mod('profile');
  // `--from-existing` lo lanza el aplicador sobre lo que ya está y no corre el aplicador: `--profile` ahí no haría nada, y
  // una opción que no hace efecto no pasa en silencio (pase adversarial de la tanda C, clase 6)
  if (fromExisting && ctx.opts.profile !== undefined) return { code: 2, lines: ['harness.js install: --profile no va con --from-existing (esa corrida no aplica nada): el perfil se elige con install --profile, o con install.profile en ~/.claude/tycon.json'] };
  const profileError = PR.checkOption(ctx.opts.profile, ctx.env);
  if (profileError) return { code: 2, lines: [`harness.js install: ${profileError}`] };
  // (story 8.16, tanda D · AC 30 a 33) las preguntas, y las opciones que las contestan, ANTES del plan: lo contestado
  // viaja como si hubiera venido por opción (el plan lo muestra) y se escribe recién después de la conformidad
  let asked = { writes: [], over: {}, head: [], guided: false, eof: false };
  if (fromExisting && (ctx.opts.integrations !== undefined || ctx.opts.packs !== undefined)) return { code: 2, lines: [`harness.js install: --integrations y --packs no van con --from-existing (esa corrida no aplica nada): se contestan con install, o con node ~/.claude/${PLACE.PLACE_NAME}/scripts/lib/tycon-config.js set`] };
  if (!fromExisting) {
    asked = installQuestions(ctx, tree, read.status === 'ok' ? read.state : null);
    if (asked.code !== undefined) return { code: asked.code, lines: asked.lines };
    if (asked.profile) ctx = Object.assign({}, ctx, { opts: Object.assign({}, ctx.opts, { profile: asked.profile }) });
  }
  const profileVia = asked.profileVia || '--profile';
  const viaOption = Boolean(ctx.opts.profile) && !fromExisting;
  // (story 8.23, tanda C · AC 21) qué herramientas se enchufan: el plan las nombra. Desde un clon, Claude Code siempre
  // (el clon vive en su carpeta); Codex, si se pidió con `--tool` o está instalado y su llave no lo apaga
  let tc = null;
  if (ctx.opts.tool !== undefined && fromExisting) return { code: 2, lines: ['harness.js install: --tool no va con --from-existing (esa corrida no aplica nada)'] };
  // una máquina que vive en la casa propia del arnés (se instaló sin Claude Code) no se instala desde un clon: el
  // aplicador en shell tiene escrito el lugar de antes y el estado quedaría partido en dos (DEF-8.23-D)
  if (!fromExisting && mod('tycon-home').livesInOwnHome(ctx.home) && !mod('tycon-home').ownHomeStale(ctx.home)) {
    // dos máquinas distintas viven ahí (story 8.25, arreglo de H7): la MUDADA, con Claude Code (su estado lo dice), y la que nació
    // sólo con Codex. Ninguna se instala desde un clon —el estado quedaría partido en dos—, pero cada una tiene su camino
    const st0 = read.status === 'ok' || read.state ? read.state : null;
    const migrated = Boolean(st0 && Array.isArray(st0.tools) && st0.tools.includes('claude'));
    if (migrated) return { code: 2, lines: [`harness.js install: esta máquina se mudó a la casa propia del arnés (${mod('tycon-home').ownStateDir(ctx.home)}): se instala y se actualiza con la versión bajada, no desde un clon. Para reinstalarla: harness.js install --version latest (con --team <URL del repo del equipo> para sumarle la capa del equipo). No escribí nada`] };
    return { code: 2, lines: [`harness.js install: esta máquina vive en la casa propia del arnés (${mod('tycon-home').ownStateDir(ctx.home)}) y se instaló sin Claude Code (sólo Codex), con la versión bajada. Una instalación desde un clon enchufa a Claude Code y escribe en su carpeta: en una máquina así todavía no se puede —la mudanza a ~/.tycon es la de una máquina con clon—. Para reinstalar: harness.js install --version latest --tool codex. No escribí nada`] };
  }
  if (!fromExisting) {
    tc = toolChoice(withAnswers(ctx, asked), tree, { always: ['claude'], state: read.status === 'ok' ? read.state : null, legacyDeploy: true });
    if (!tc.ok) return { code: tc.code, lines: [`harness.js install: ${tc.line}`] };
  }
  let planned = null;
  let quiet = false;   // nada que escribir sobre una instalación sana: «sin cambios», sin preguntar ni tomar copia
  if (!fromExisting) {
    // lo contestado (o pedido por opción) va al plan por sus variables, sólo para armarlo: no se escribe nada todavía
    const planEnv = Object.assign({}, ctx.env, viaOption ? { [PR.ENV_VAR]: ctx.opts.profile } : {});
    for (const w of asked.writes) if (w.envVar) planEnv[w.envVar] = w.envValue;
    const planCtx = Object.assign({}, ctx, { tree, env: planEnv, configWrites: asked.writes });
    planned = installPlan(planCtx, { pinned });
    // lo que el paso de finales de línea corrigió al armar el plan va al registro cuando corre el aplicador (story 8.17)
    if (planCtx.eolPendingLog) ctx.eolPendingLog = planCtx.eolPendingLog;
    if (planCtx.eolNotice) ctx.eolNotice = planCtx.eolNotice;
    if (!planned.ok) return { code: planned.code, lines: planned.lines };
    const PL = mod('plan');
    const was = planned.existing;
    // con la capa pedida sobre una copia pública siempre hay algo que hacer: sumarla (o re-apilarla) es parte de install
    // con una herramienta que todavía no está enchufada hay algo que hacer, aunque el plan del aplicador no escriba nada
    const sameTools = Boolean(was) && mod('tools').same(tc.tools, mod('tools').plugged(was, { home: ctx.home, env: ctx.env }));
    quiet = PL.nothingToWrite(planned.plan) && !planned.notes.length && Boolean(was && was.last_health) && real(was.tree) === tree && !layerWanted && sameTools;
    const profileLine = [PR.label(planned.profile, { viaOption, via: profileVia }), ...asked.head, tc.line];
    if (ctx.opts['dry-run']) {
      if (quiet) return { code: 0, lines: [`arnés ya instalado en modo ${was.mode} · ${tree}`, ...profileLine, 'sin cambios: no hay nada que escribir', ...(asked.hint ? [asked.hint] : []), ...cloneNote] };
      return { code: 0, lines: [...planHead(was, tree, planned.notes, profileLine), ...PL.describe(planned.plan), ...dryRunNotes, ...cloneNote] };
    }
    if (!quiet && !ctx.opts.yes) {
      const shown = [...planHead(was, tree, planned.notes, profileLine), ...PL.describe(planned.plan)];
      const P = mod('prompt');
      // el remedio, con las opciones que vinieron (si no, copiarlo tal cual podría volver a salir 2: «elegí el perfil»)
      const keep = ['profile', 'integrations', 'packs', 'channel', 'local', 'source', 'harness-clone'].filter((k) => ctx.opts[k] !== undefined && !(k === 'profile' && asked.profileVia)).map((k) => `--${k} ${ctx.opts[k]}`);
      if (!P.isTerminal()) return { code: 2, lines: [...shown, `harness.js install: sin \`--yes\` y sin terminal no escribo nada: harness.js install ${[...keep, '--yes'].join(' ')}`] };
      process.stdout.write(`${shown.join('\n')}\n`);
      // una entrada que se terminó en una de las preguntas es un «no» también acá: una terminal no vuelve a contestar
      if (asked.eof) return { code: 0, lines: ['no se instaló nada (la entrada se terminó antes de la conformidad)'] };
      if (!P.ask('¿Instalo? [s/N] ')) return { code: 0, lines: ['no se instaló nada'] };
    }
  }

  return L.withLock(ctx.home, () => {
    const pieces = [];
    const notes = [...early];
    const blind = [];   // las fuentes que `redetectSources` no pudo mirar: con alguna, install sale 1
    // releído adentro del candado: si otra sesión instaló o actualizó mientras se confirmaba, el plan ya no es éste
    if (planned && stateFingerprint(ctx) !== planned.fingerprint) {
      return { code: 3, lines: ['harness.js install: la instalación cambió mientras confirmabas: volvé a correr'] };
    }
    const current = loadState(ctx);
    const existing = current.status === 'ok' ? current.state : null;
    let state = existing;
    // la copia ANTES de tocar nada (AC 17), ya con la conformidad y bajo el candado (story 8.16, AC 16): la primera
    // `install` es «cómo estaba la máquina antes del arnés» y no rota. Sin nada que escribir no se toma
    const R0 = mod('report');
    // un cambio de perfil (story 8.16, AC 26) toma su copia nueva siempre (`reason: profile`): es la vuelta atrás de ese cambio
    const switching = Boolean(planned && planned.switching);
    const snap = quiet ? null : takeSnapshot(ctx, tree, { reason: switching ? 'profile' : 'install', from: existing && existing.version ? existing.version.number : null, log: (l) => R0.log(ctx.home, `install: ${l}`), state: existing, force: switching });
    // nada que escribir (lo dijo el plan, y por eso no se preguntó ni se tomó copia): no se toca ninguna pieza; sólo se
    // graba la política vigente en el estado, como siempre hizo este atajo (y el perfil vigente: story 8.16)
    if (quiet && existing) {
      const policy0 = policyOf(ctx, tree);
      state.policy = { channel: policy0.channel, apply: policy0.apply, enabled: policy0.enabled };
      applyPolicy(ctx, state, policy0);
      const prof0 = profileOf(ctx, tree);
      if (prof0.ok) state.profile = { value: prof0.value, origin: prof0.origin };
      S.write(ctx.home, state);
      return { code: 0, lines: [`arnés ya instalado en modo ${state.mode} · ${tree}`, ...R.installSummary({ version: state.version.number, channel: state.channel, apply: policy0.apply, changed: false, baseline: installBaseline(ctx), profile: PR.label(prof0), configLines: asked.head, notes: [...(asked.hint ? [asked.hint] : []), ...cloneNote] })] };
    }

    // (a0) la capa pedida (story 8.13.1, AC 1 y 7): antes de escribir nada en la máquina, el clon de lectura, la fuente y
    // el commit de la capa. Si no se puede (sin acceso al interno, sin commit compatible), no se instala nada
    let layerPrep = null;
    if (layerWanted) {
      const SS = mod('state');
      const had = existing ? SS.layerSources(existing).find((s) => s.name === SS.LAYER_SOURCE) : null;
      const src = had ? Object.assign({}, had, { reference: layerWanted.reference || had.reference || null })
        : { name: SS.LAYER_SOURCE, kind: 'layer', url: SRC.origin(layerWanted.reference, { env: ctx.env }) || layerWanted.reference, ref: SRC.MAIN_REF, rewrites: false,
          dir: path.join(SS.paths(ctx.home).sourcesDir, SS.LAYER_SOURCE), reference: layerWanted.reference, commit: null, previous: null };
      // sin el interno, el motivo es de install, no «la actualización pública espera» de update (C4)
      const pick = pickLayerCommit(ctx, src, { publicDir: tree, publicCommit: 'HEAD', waiting: null });
      if (pick.status !== 'ok') {
        finishSnapshot(ctx, snap, (l) => R0.log(ctx.home, `install: ${l}`));
        const again = layerWanted.implicit ? 'harness.js install' : `harness.js install --harness-clone ${layerWanted.reference}`;
        return { code: 1, lines: [`harness.js install: la capa privada no se pudo preparar — ${pick.reason}. No instalé nada: la máquina sigue como estaba; cuando ${pick.status === 'unknown' ? 'haya acceso al repo interno' : 'haya un commit de la capa compatible'}, ${again}`] };
      }
      layerPrep = { src, pick };
    }

    // (a) el enlace
    if (!fromExisting) {
      // `install` fija el árbol: el lugar nace hacia el que se instala (el que va a decir el estado), no hacia el árbol viejo
      // del estado; la protección contra un clon descartable vale para el aplicador suelto (segunda vuelta, C4). Un nombre
      // viejo que apunta a un clon válido sigue ganando: la regla de nacimiento no cambia
      const l = ensureLink(ctx, tree, { link: ctx.opts.local ? tree : null, prefer: tree });
      if (!l.ok) return { code: 2, lines: [`harness.js install: no pude asegurar el enlace: ${l.out || l.err}`] };
      if (/cre|repar|re-apunt/i.test(l.out)) pieces.push('link');
      if (!linkResolvesTo(ctx, tree)) notes.push(`el enlace ${linkPath(ctx.home)} apunta a otro clon: ${l.out}`);
    }

    // (b) el estado
    const sources = SRC.detect({ tree, home: ctx.home, env: ctx.env });   // la url de cada una ES su origin de ahora
    let policy = policyOf(ctx, tree);
    // --channel va a la configuración, donde vive la política (AC 12); el canal del estado es el VIGENTE (A9: una sola
    // verdad), que puede no ser el pedido si una variable le gana — y se dice
    if (ctx.opts.channel && policy.channel !== ctx.opts.channel) {
      const set = mod('channel').set(ctx.home, ctx.opts.channel);
      if (!set.ok) return { code: 2, lines: [`harness.js install: ${set.reason}`] };
      if (set.warning) notes.push(set.warning);
      pieces.push('channel');
      policy = policyOf(ctx, tree);
      if (policy.channel !== ctx.opts.channel) notes.push(`ojo: la variable ${mod('channel').VARS.channel}=${policy.channel} le gana a ${set.file}: el canal vigente sigue siendo ${policy.channel}`);
    }
    const channel = policy.channel;
    if (!state) {
      state = S.defaults({ tree, sources, channel });
      state.version.number = versionNumber(ctx, state);
      state.first_install = S.firstInstall(ctx.home, state.version.number);   // sólo al crear el estado: dice si la instalación es nueva
      pieces.push('state');
    } else if (real(state.tree) !== tree && !fromExisting) {
      // se vuelve a instalar desde otro clon: el estado apunta al nuevo
      // la capa no se suelta en silencio (C3): sobre otra copia pública vuelve con (b2), apilada en el árbol nuevo; sobre
      // un clon interno no tiene dónde ir, y se dice
      state.tree = tree; state.sources = sources; state.mode = 'managed'; state.tree_before = null;
      if (layerDropNote) { state.source = 'internal'; state.layer = null; notes.push(layerDropNote); }
      state.version.number = versionNumber(ctx, state);
      pieces.push('state');
    } else if (real(state.tree) === tree && redetectSources(state, sources, tree, notes, blind)) {
      // el mismo árbol y otra forma de máquina (dos clones → un solo árbol, o al revés): las fuentes son las de ahora
      state.version.number = versionNumber(ctx, state);
      pieces.push('state');
    }
    state.policy = { channel: policy.channel, apply: policy.apply, enabled: policy.enabled };
    // qué herramientas enchufa esta máquina queda ESCRITO (story 8.23, tanda C): el arranque no vuelve a detectar
    if (tc) state.tools = [...tc.tools];
    // --source con estado: es el remedio que nombran update y doctor cuando el origin cambió (pase adversarial, clases
    // 14 y 17: antes sólo valía sobre una instalación nueva). Re-fija la fuente que tiene ese origin (A10)
    if (pinned) {
      const st = state.sources.find((s) => s.name === pinned.name);
      if (st && st.url !== pinned.url) { st.url = pinned.url; if (!pieces.includes('state')) pieces.push('state'); notes.push(`origen de ${st.name} fijado en ${pinned.url}`); }
    }
    // el canal del estado es el de la política, y lo que es del repo público queda marcado (A2, A9)
    if (ctx.opts.channel && state.channel !== policy.channel && !pieces.includes('state')) pieces.push('state');
    applyPolicy(ctx, state, policy);

    // (b2) la capa (story 8.13.1): la máquina instala desde la copia pública, con la fuente `internal` apilada encima
    if (layerPrep) {
      const SS = mod('state');
      state.source = 'public';
      state.sources = state.sources.filter((s) => SS.kindOf(s) !== 'layer').concat([layerPrep.src]);
      const st = stackLayer(ctx, state, layerPrep.src, layerPrep.pick.result);
      if (!st.ok) {
        finishSnapshot(ctx, snap, (l) => R0.log(ctx.home, `install: ${l}`));
        return { code: 1, lines: [`harness.js install: ${st.reason}. No corrí el aplicador`] };
      }
      recordLayer(ctx, state, layerPrep.src, layerPrep.pick, st.manifest);
      pieces.push('layer');
      notes.push(`capa privada en ${sha7(layerPrep.pick.commit)} (de ${layerPrep.src.reference})${layerPrep.pick.note ? ` · ${layerPrep.pick.note}` : ''}`);
    }

    // (c) la copia fija de arranque
    if (copyBootstrap(ctx, tree, state)) pieces.push('bootstrap');

    // (d) la línea de arranque: nueva si no hay ninguna del arnés, o migrada una sola vez
    const n = SL.checkNode({ env: ctx.env });
    const m = SL.migrate(settingsPath(ctx), { home: ctx.home, platform: ctx.platform, nodeOk: n.ok, nodeVersion: n.version, addIfMissing: !fromExisting, backup: !snap });
    if (m.changed) pieces.push('startup-line');
    if (!m.changed && m.reason && !/sin cambios|nada que migrar/.test(m.reason)) notes.push(m.reason);

    // (e) el @import, una vez (no en --from-existing: ya está en la máquina)
    if (!fromExisting && ensureImport(ctx)) pieces.push('import');

    // `--from-existing` sobre lo mismo: nada cambió, y se dice; no corre el aplicador ni la salud (su atajo es el de
    // siempre, sin la línea de la copia: AC 44 de la 8.16). Sin `--from-existing`, «sin cambios» lo decide el PLAN (más
    // arriba, `quiet`), no las piezas propias: un hook borrado a mano no es una pieza propia, y el atajo viejo decía «sin
    // cambios» después de que el plan prometiera reponerlo (pase adversarial de la tanda B, clase 1)
    if (fromExisting && existing && !pieces.length && real(existing.tree) === tree && !notes.length) {
      S.write(ctx.home, state);   // la política vigente (state.policy) puede haber cambiado sin que nada más cambie
      finishSnapshot(ctx, snap, (l) => R0.log(ctx.home, `install: ${l}`));
      return { code: 0, lines: [`arnés ya instalado en modo ${state.mode} · ${tree}`, ...R.installSummary({ version: state.version.number, channel: state.channel, apply: policy.apply, changed: false, baseline: fromExisting ? null : installBaseline(ctx) })] };
    }

    // (e2) el perfil pedido con `--profile` (story 8.16, tanda C · AC 25): ya con la conformidad, antes del aplicador, en
    // ~/.claude/tycon.json con el escritor único de la configuración. Si no se puede escribir, no se sigue: el aplicador
    // instalaría otro perfil que el que se mostró
    if (viaOption && machineProfile(ctx) !== ctx.opts.profile) {
      let sk;
      try { sk = require(path.join(tree, 'scripts', 'lib', 'tycon-config.js')).setKey(ctx.home, PR.KEY, ctx.opts.profile, { env: ctx.env }); } catch (e) { sk = { ok: false, reason: e.message }; }
      if (!sk || !sk.ok) {
        finishSnapshot(ctx, snap, (l) => R0.log(ctx.home, `install: ${l}`));
        return { code: 2, lines: [`harness.js install: no pude escribir el perfil en ~/.claude/tycon.json: ${sk ? sk.reason : 'sin escritor'}. No corrí el aplicador`] };
      }
      if (sk.warning) notes.push(sk.warning);
      pieces.push('profile');
    }

    // (e3) lo contestado en las preguntas (o pedido con --integrations / --packs; story 8.16, tanda D · AC 33): con la
    // conformidad, antes del aplicador, con el mismo escritor. Si no se puede, no se sigue: el aplicador instalaría otra
    // cosa que lo que se mostró
    if (asked.writes.length) {
      const wa = writeAnswers(ctx, tree, asked.writes);
      if (!wa.ok) {
        finishSnapshot(ctx, snap, (l) => R0.log(ctx.home, `install: ${l}`));
        return { code: 2, lines: [`harness.js install: no pude escribir tus respuestas en ~/.claude/tycon.json: ${wa.reason}. No corrí el aplicador`] };
      }
      notes.push(...wa.warnings);
      pieces.push('config');
    }

    // (f) el aplicador (no en --from-existing: lo tiene su padre) y el registro de lo que dejó (AC 15-16)
    let applied = null;
    if (!fromExisting) {
      // con las herramientas que eligió ESTA corrida (story 8.23, tanda C): el estado todavía no las tiene escritas
      const a = runApplier(ctx, tree, { log: (l) => R.log(ctx.home, `install: ${l}`), snapshotDir: snap && snap.dir, tools: tc ? tc.tools : undefined, force: true, hooksPath: true });
      applied = a;
      state.last_apply = nowIso();
      if (!a.ok) {
        state.last_health = null;   // a medias: `install` otra vez la retoma en vez de decir «sin cambios»
        // …y queda dicho en el estado, como cuando falla la salud: el cierre manda a `doctor` por el detalle, y un
        // `doctor` corrido después, en otra sesión, tiene que verlo (lo saca la corrida de `install` que termine bien)
        state.failed = { commit: state.version.number, sources: currentSources(ctx, state), at: nowIso(), log: S.paths(ctx.home).log, reason: 'applier', stage: 'install' };
        S.write(ctx.home, state);
        finishSnapshot(ctx, snap, (l) => R0.log(ctx.home, `install: ${l}`));
        // quedó a medias (story 8.16, AC 9): qué falló, el registro, la copia y las dos salidas; y las notas (story 8.18:
        // la causa puede ser una de ellas, «no pude mirar la fuente…»)
        return { code: 1, lines: [...R.installFailure({ what: a.reason, log: S.paths(ctx.home).log, backup: snap && snap.dir, warnings: a.warnings }), ...notes] };
      }
      pieces.push('applier');
      // un cambio de perfil (story 8.16, AC 26): lo registrado que el reporte del perfil nuevo ya no trae se quita, con la
      // mecánica de la vuelta atrás (y antes de fundir el registro: así se cae lo que se fue)
      const profNow = profileOf(ctx, tree);
      const dropped = switching ? dropForProfile(ctx, state, tree, a, (l) => R.log(ctx.home, `install: ${l}`), profNow.ok ? profNow.value : null) : true;
      if (switching) notes.push(...profileSwitchNotes(dropped));
      recordPieces(ctx, state, a.report, a.shared);
      { const hp = noteHooksPath(state, a); if (hp) notes.push(hp); }
      // el perfil nuevo se anota sólo si el cambio se pudo hacer entero: si no se supo qué sobraba (sin reporte), queda el
      // de antes y la próxima corrida lo reintenta (pase adversarial de la tanda C, clases 7 y 14)
      if (profNow.ok && dropped !== null) state.profile = { value: profNow.value, origin: profNow.origin };
      // la comprobación de salud (tanda C, AC 21): en install no hay versión anterior a la que volver —la vuelta atrás de
      // una instalación es `uninstall`—; si falla, sale 1 con lo que falló y `doctor` queda en rojo (`failed`)
      // el doctor de la salud lee el estado del disco; se graba con la constancia de salud pendiente, como en update: si
      // la sesión muere en el medio, el arranque siguiente la corre (fallos silenciosos, iteración 2)
      state.failed = pendingHealth(ctx, { commit: versionLabel(ctx, state), sources: currentSources(ctx, state), applierOut: a.out });
      S.write(ctx.home, state);
      const h = runHealth(ctx, state, { report: a.report, applierOut: a.out, log: (l) => R.log(ctx.home, `install: ${l}`) });
      if (!h.ok) {
        state.failed = { commit: state.version.number, sources: currentSources(ctx, state), at: nowIso(), log: S.paths(ctx.home).log, reason: 'health', stage: 'install' };
        state.last_health = null;   // a medias: `install` otra vez la retoma en vez de decir «sin cambios»
        S.write(ctx.home, state);
        finishSnapshot(ctx, snap, (l) => R0.log(ctx.home, `install: ${l}`));
        // las notas van igual: la causa de la salud que no pasó puede ser justo una de ellas («no pude mirar la fuente…»)
        return { code: 1, lines: [...R.installFailure({ what: `la comprobación de salud no pasó: ${h.failures.join(' · ')}`, log: S.paths(ctx.home).log, backup: snap && snap.dir, warnings: a.warnings }), ...notes] };
      }
      state.failed = null;
      state.last_health = nowIso();
    } else {
      // el aplicador que nos llamó no reporta: sólo las piezas propias. Las compartidas tampoco se hacen acá (AC 28): él
      // corre suelto, ya escribió las dos claves y copia los comandos al seguir; las anota el arranque siguiente
      recordPieces(ctx, state, null);
    }

    const changed = pieces.length > 0 || JSON.stringify(existing) !== JSON.stringify(state);
    if (changed) S.write(ctx.home, state);
    // una instalación que salió bien deja la máquina al día: el aviso «no se pudo actualizar desde …» de antes ya no vale
    // (con una fuente que no se pudo mirar la instalación sale 1, y el aviso queda)
    if (!blind.length) mod('report').clearUpdateFailure(ctx.home);
    finishSnapshot(ctx, snap, (l) => R0.log(ctx.home, `install: ${l}`));
    const head = `arnés ${existing && !pieces.length ? 'ya instalado' : 'instalado'} en modo ${state.mode} · ${tree}`;
    // lo demás quedó hecho, pero hay una fuente que no se pudo mirar: sale 1 (la nota de arriba dice cuál y por qué)
    const blindLine = blind.length ? `harness.js install: sale 1 — no pude mirar ${blind.length === 1 ? 'la fuente' : 'las fuentes'} ${blind.join(', ')}; corré install otra vez cuando se pueda mirar` : null;
    // --from-existing lo llama el aplicador sobre una instalación que ya está: su salida es la de siempre (AC 44 de la
    // 8.16: no cambia nada), los pasos que hizo el programa o «sin cambios»
    // CodeGraph, si la organización lo prende y faltaba: lo cubrió el «¿Instalo?»; si falla, el arnés sigue y lo dice
    const cgLine = asked.codegraphInstall ? codegraphInstall({ tree, env: ctx.env }).note : null;
    if (!applied) {
      const steps = pieces.length ? `piezas escritas: ${pieces.join(', ')}` : 'sin cambios: ya estaba instalado así';
      const lines = [head, `versión: ${state.version.number}`, `canal: ${state.channel} · aplicación: ${policy.apply}`, steps, ...notes, ...(cgLine ? [cgLine] : [])];
      return blindLine ? { code: 1, lines: [...lines, blindLine] } : { code: 0, lines };
    }
    // el cierre (story 8.16, AC 8): qué quedó, contado desde el reporte del aplicador y las piezas que hizo el programa;
    // los avisos del aplicador tal cual; la copia, el registro y qué sigue
    const summary = R.installSummary({
      version: state.version.number, channel: state.channel, apply: policy.apply, changed: true, notes: [...notes, ...askLaterNote(asked), ...(asked.hint ? [asked.hint] : [])],
      profile: PR.label(profileOf(ctx, tree), { viaOption, via: profileVia }), configLines: asked.head,
      // sin repetidos: un aplicador de antes de las piezas compartidas las reporta él también (lo mismo que el registro)
      pieces: mod('shared').union(applied.report, applied.shared), reported: Array.isArray(applied.report),
      // el instalador apagado a propósito sale 0 sin registrar nada: el cierre lo dice, y no cuenta skills pendientes
      applierOff: ctx.env.TYCON_NO_AUTOINSTALL === '1',
      // con el paso de terceros apagado el aplicador no reporta ninguna: no se cuentan ni «en su lugar» ni «pendientes»
      effects: mod('managed').readEffects(tree),
      thirdParty: ctx.env.TYCON_NO_AUTOINSTALL === '1' ? null : (ctx.env.TYCON_THIRD_PARTY === '0' ? 'off' : thirdPartyDeclared(tree)),
      warnings: applied.warnings, backup: snap && snap.dir, log: S.paths(ctx.home).log,
    });
    if (blindLine) return { code: 1, lines: [head, ...summary, ...(cgLine ? [cgLine] : []), blindLine] };
    return { code: 0, lines: [head, ...summary, ...(cgLine ? [cgLine] : [])] };
  }, { env: ctx.env, onBusy: busy });
}

// ── tanda C: la salud, la vuelta atrás automática, la retención y el intento fallido ─────────────────────────────────

/** El texto de la retención que dejó un `rollback` (el aviso de cada arranque y lo que dice `update`). */
function holdText(state) {
  const h = state.hold || {};
  return `retención: deshiciste la versión ${h.commit || '—'} (${h.at || '—'}); el arnés no se actualiza solo hasta levantarla: harness.js rollback --release (o ${applyHint})`;
}
/** El nombre de una versión para los mensajes, `failed` y `hold`: el número (que sale del arnés) más el agent-skills,
 *  así una actualización sólo de agent-skills no se lee «X → X» (pase adversarial H19). */
function versionLabel(ctx, state) {
  // con capa (story 8.13.1): el número del público y el commit de la capa, así «sólo la capa» no se lee «X → X»
  const lay = mod('state').layerSources(state)[0];
  if (lay && state.source === 'public') return `${versionNumber(ctx, state)} · capa ${sha7(lay.commit) || '—'}`;
  const n = versionNumber(ctx, state);
  const as = (state.sources || []).find((s) => s && s.name === 'agent_skills');
  const h = as && as.dir ? mod('sources').head(as.dir, { env: ctx.env }) : null;
  // con el clon de skills re-apuntado los dos clones están en el mismo commit: se nombra uno solo (8.18, AC 35)
  const hs = harnessSource(state);
  if (h && hs && hs.dir && h === mod('sources').head(hs.dir, { env: ctx.env })) return n;
  return h ? `${n} · agent-skills ${sha7(h)}` : n;
}
/** ¿Las puntas de ahora son las mismas que fallaron? (`{ <fuente>: sha }` contra `failed.sources`) */
function sameTips(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}
/** Los módulos de la tanda C, cargados ANTES de mover los árboles: la salud y la vuelta atrás que corren son las de la
 *  versión que estaba (la que se sabe sana), no las que trae la actualización. Un árbol de antes de la C no los tiene:
 *  la salud queda en «el aplicador salió 0» (lo de la tanda A) y se dice en el registro. */
function preloadRecovery(log) {
  const out = {};
  for (const name of ['health', 'rollback', 'remove']) {
    try { out[name] = mod(name); } catch (e) { out[name] = null; if (log) log(`update: sin ${name}.js en esta versión (${e.code || e.message})`); }
  }
  return out;
}
/** La comprobación de salud (AC 21) sobre el árbol del estado; nunca tira. */
function runHealth(ctx, state, { report, applierOut, log, health = null }) {
  const H = health || (() => { try { return mod('health'); } catch (_) { return null; } })();
  if (!H || typeof H.check !== 'function') return { ok: true, failures: [], warnings: ['sin health.js: la salud es «el aplicador salió 0»'] };
  try {
    // los hooks de agent-skills viven donde los apunta settings.json: el clon de la fuente, o ~/.claude/agent-skills aunque
    // no sea un clon de git (una sola fuente); `skills/` en la raíz del árbol sólo en el repo único (8.7 AC 18)
    const skills = (state.sources || []).find((s) => s && s.name === 'agent_skills');
    const homeSkills = path.join(ctx.home, '.claude', 'agent-skills', 'skills');
    const skillsDir = skills && skills.dir ? path.join(skills.dir, 'skills') : (fs.existsSync(homeSkills) ? homeSkills : path.join(state.tree, 'skills'));
    // con Codex enchufado (story 8.23, tanda C) la salud mira también SUS hooks: en una máquina sin Claude Code son los únicos
    const T = mod('tools');
    const pluggedNow = T.plugged(state, { home: ctx.home, env: ctx.env });
    // sólo con `tools` en el estado (de la tanda C en adelante): en una máquina de antes, con la llave de Codex apagada, un
    // hooks.json viejo que nombra un hook que la versión nueva ya no trae hacía fallar la salud y volver atrás (clase 28)
    const codexHooks = pluggedNow.includes('codex') && T.recorded(state) ? path.join(T.codexHome({ home: ctx.home, env: ctx.env }), 'hooks.json') : null;
    const r = H.check(Object.assign({}, ctx, { tree: state.tree }), {
      tree: state.tree, skillsDir, report, applierOut, harnessJs: path.join(state.tree, 'scripts', 'setup', 'harness.js'), log, codexHooks,
      // sin Claude Code enchufado, los hooks se lanzan con una carpeta de usuario temporal: nada cae en la suya (AC 22)
      isolateHome: !pluggedNow.includes('claude'),
      // la versión bajada (story 8.23, tanda B) no invoca git nunca, tampoco para la caja de prueba de los hooks
      noGit: mod('state').isRelease(state),
    });
    return r && typeof r.ok === 'boolean' ? r : { ok: false, failures: ['la comprobación de salud no devolvió un resultado'], warnings: [] };
  } catch (e) {
    return { ok: false, failures: [`la comprobación de salud no corrió: ${e.message}`], warnings: [] };
  }
}
/** Después de la restauración: cada fuente queda registrada en lo que tiene el clon (el commit de la copia). Una fuente
 *  `layer` no: su clon de lectura es --bare y su commit lo deja el re-apilado (story 8.13.1). */
function syncSourceCommits(ctx, state) {
  for (const s of state.sources || []) {
    if (mod('state').kindOf(s) === 'layer') continue;
    const h = s && s.dir ? mod('sources').head(s.dir, { env: ctx.env }) : null;
    if (h) s.commit = h;
  }
}
/**
 * La versión nueva no quedó sana (AC 21): el «después» de la copia es lo que quedó roto, se restaura por piezas a esa
 * copia (mismo camino que `rollback`), se anota `failed` con las puntas que fallaron y se deja el aviso. La copia fija
 * NO se refresca. Devuelve el resultado de `doUpdate`.
 */
function failUpdate(ctx, state, { snap, rec, before, after, tips, failures, reason, log }) {
  const S = mod('state'), R = mod('report'), SN = mod('snapshot');
  if (snap) { try { SN.finish(snap.dir, { home: ctx.home, env: ctx.env }); } catch (e) { if (log) log(`update: no pude anotar el después de la copia (${e.message})`); } }
  let restored = { ok: false, lines: ['sin copia de la actualización: no hubo vuelta atrás automática'] };
  const copy = snap ? SN.list(ctx.home).find((c) => c.dir === snap.dir) : null;
  const RB = rec && rec.rollback;
  // con capa, el mismo freno que `rollback` (C8): si volver sola pisaría un agregado editado a mano (o no se puede leer
  // el manifiesto), no vuelve; la versión queda marcada `failed` y el aviso dice por qué y cómo seguir
  // el freno mismo puede fallar (un agregado que no se deja leer): entonces tampoco se vuelve, y se dice por qué, como el
  // restore de al lado; así la versión igual queda marcada `failed` y no se reintenta sola (revisión del paso 5, vuelta 3)
  let stop = null;
  try {
    stop = copy && RB && typeof RB.restore === 'function' ? layerBackBlock(ctx, state, copy, 'harness.js rollback') : null;
  } catch (e) { stop = `el freno no pudo correr: ${e.message}`; }
  if (stop) {
    restored = { ok: false, lines: [stop] };
  } else if (copy && RB && typeof RB.restore === 'function') {
    try {
      // con capa (story 8.13.1): la vuelta también re-apila la capa en el commit de la copia
      restored = RB.restore(Object.assign({}, ctx, { tree: state.tree }), state, copy, Object.assign({
        why: reason, runApplier, log, snapshotDir: snap.dir, isOwnPiece: (p) => isOwnPiece(ctx, p),
      }, layerHooks(ctx, state, log))) || restored;
    } catch (e) { restored = { ok: false, lines: [`la vuelta atrás automática falló: ${e.message}`] }; }
  } else if (!RB) {
    restored = { ok: false, lines: ['sin rollback.js en esta versión: no hubo vuelta atrás automática'] };
  }
  syncSourceCommits(ctx, state);
  state.version.number = versionNumber(ctx, state);
  // la copia fija vuelve con el árbol: si quedó la de la versión que falló (la salud pasó, la copia se refrescó y el
  // proceso murió antes de grabar), sin esto toda actualización siguiente fallaba por «copia fija adulterada»
  if (restored.ok) { try { copyBootstrap(ctx, state.tree, state); } catch (e) { if (log) log(`update: no pude reponer la copia fija tras la vuelta atrás (${e.message})`); } }
  state.failed = { commit: after, sources: tips, at: nowIso(), log: S.paths(ctx.home).log, reason };
  const back = restored.ok ? `volvió sola a ${state.version.number}` : `NO pudo volver sola (${(restored.lines || [])[0] || 'sin detalle'}): harness.js rollback`;
  R.setNotice(state, `la actualización ${before} → ${after} no quedó sana (${failures[0]}): ${back}; esa versión no se reintenta sola (cuando cambie la punta, o con ${applyHint}) — detalle en ${S.paths(ctx.home).log}`);
  if (log) log(`update: ${reason}: ${failures.join(' · ')} · ${(restored.lines || []).join(' · ')}`);
  return { status: 'failed', code: 1, lines: [`harness.js update: la versión ${after} no quedó sana (${failures.join(' · ')}) — ${back}`, ...(restored.lines || []).slice(0, 5)] };
}

// ── la capa en update e install (story 8.13.1, tanda A · AC 7, 8 y 9) ────────────────────────────────────────────────
// El commit de la capa lo decide la máquina: trae `main` del interno a su clon de lectura (--bare, con --reference al
// clon de la persona, que no se toca) y recorre desde la punta hacia atrás hasta el primer commit COMPATIBLE con la
// versión pública (la comprobación de `layer.js computeLayer`, la misma de doctor). La búsqueda se corta en el commit
// de la capa actual y en el piso de version.json (`source.harness`); sin ninguno, el piso es el mínimo. El elegido queda
// en `refs/tycon/layer/<versión>` del clon de lectura (local: nada se escribe en ningún repo interno ni público).
const NO_INTERNAL = 'sin acceso al repo interno del arnés';
const layerStayed = (sha) => `capa en ${sha7(sha)}: main interno trae un cambio publicable que el público todavía no tiene`;
const layerAtMinimum = (h, sha) => `capa al mínimo: ${h === null ? '—' : h} horas detrás de main interno (${sha7(sha)}, el commit de version.json)`;
const layerRef = (version, commit) => `refs/tycon/layer/${version || `sin-numero-${sha7(commit)}`}`;

/** El clon de lectura de una fuente `layer`: si no está, se crea --bare (con --reference al clon de la persona, si es un
 *  clon de git: no se bajan los objetos dos veces), dentro del tope de red. Una carpeta que está y no es un --bare no se
 *  toca. @returns {{ ok, reason, offline }} */
function ensureReadClone(ctx, src, { budgetS = null } = {}) {
  const SRC = mod('sources');
  const env = ctx.env;
  if (!src.dir) return { ok: false, reason: 'la fuente no dice dónde va su clon de lectura' };
  if (SRC.isBare(src.dir, { env })) return { ok: true, reason: null };
  if (fs.existsSync(src.dir)) return { ok: false, reason: `${src.dir} existe y no es un clon de lectura (--bare): no lo toco` };
  if (!src.url) return { ok: false, reason: 'la fuente no tiene url' };
  fs.mkdirSync(path.dirname(src.dir), { recursive: true });
  const args = ['clone', '-q', '--bare'];
  if (src.reference && SRC.isRepo(src.reference, { env })) args.push('--reference', src.reference);
  const budget = SRC.budgetOf(budgetS, env);
  const r = SRC.git(path.dirname(src.dir), [...args, src.url, src.dir], { env, timeout: Math.round(budget * 1000) });
  if (r.ok) return { ok: true, reason: null };
  try { fs.rmSync(src.dir, { recursive: true, force: true }); } catch (_) { /* el clon a medias es nuestro */ }
  const offline = r.timedOut || SRC.isNetworkError(r.err);
  return { ok: false, offline, reason: r.timedOut ? `sin red: el clon del interno no contestó en ${SRC.secondsText(budget)} s` : (offline ? `sin red: ${String(r.err).split('\n')[0]}` : `no pude clonar ${src.url}: ${String(r.err).split('\n')[0] || `git salió ${r.status}`}`) };
}

/** El piso de version.json de un commit público: `source.harness` (o `source.agent_skills` en una versión de antes del
 *  corte de la 8.18, que trae sólo ésa). null si no lo trae. */
function layerFloor(ctx, publicDir, publicCommit) {
  const r = mod('sources').git(publicDir, ['show', `${publicCommit}:version.json`], { env: ctx.env, timeout: 10000 });
  if (!r.ok) return null;
  try {
    const s = (JSON.parse(r.out.replace(/^﻿/, '')) || {}).source || {};
    const sha = s.harness || s.agent_skills || null;
    return typeof sha === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null;
  } catch (_) { return null; }
}

/**
 * El commit de la capa (AC 7), sin escribir nada fuera del clon de lectura (el fetch). Contra `publicCommit` del árbol.
 * @returns {{ status: 'ok'|'unknown'|'blocked', reason, commit, tip, floor, minimum, lagHours, note, result, version }}
 *   `unknown` = no se pudo traer (sin red, sin credencial, clon de lectura roto): no se mueve ninguna fuente;
 *   `blocked` = se trajo y no hay commit compatible (o version.json no trae la lista): tampoco.
 */
// `waiting`: qué espera sin el interno, dicho por quien llama — «la actualización pública espera» es de `update`; install
// dice lo suyo (pase adversarial de la tanda A, C4). El tope (`budgetS`) es de las dos salidas a la red juntas.
function pickLayerCommit(ctx, src, { publicDir, publicCommit, budgetS = null, waiting = 'la actualización pública espera' } = {}) {
  const SRC = mod('sources'), L = mod('layer');
  const env = ctx.env;
  const lost = (why) => ({ status: 'unknown', reason: `${NO_INTERNAL} (${why})${waiting ? `: ${waiting}` : ''}` });
  const until = Date.now() + SRC.budgetOf(budgetS, env) * 1000;
  const leftS = () => Math.max(0.5, (until - Date.now()) / 1000);
  const rc = ensureReadClone(ctx, src, { budgetS: leftS() });
  if (!rc.ok) return lost(rc.reason);
  const f = SRC.fetch(Object.assign({}, src, { ref: src.ref || SRC.MAIN_REF }), { env, budgetS: leftS() });
  if (!f.ok) return lost(f.reason);
  const tip = f.to;
  const pub = L.readPublicVersion(publicDir, publicCommit);
  if (!pub.ok) return { status: 'blocked', reason: `${pub.reason}: no se mueve nada`, tip };
  // el piso tiene que estar en el clon de lectura; si main no lo contiene, se trae por su sha (Azure DevOps lo deja)
  let floor = layerFloor(ctx, publicDir, publicCommit);
  if (floor && SRC.commitState(src.dir, floor, { env }).status !== 'ok') {
    SRC.git(src.dir, ['fetch', '-q', 'origin', floor], { env, timeout: Math.round(leftS() * 1000) });
    if (SRC.commitState(src.dir, floor, { env }).status !== 'ok') floor = null;
  }
  const check = (sha) => { try { return L.computeLayer({ internalDir: src.dir, internalCommit: sha, publicDir, publicCommit }); } catch (e) { return { ok: false, problem: 'git', reason: e.message, otherVersion: [] }; } };
  const walk = SRC.git(src.dir, ['rev-list', '--first-parent', tip], { env, timeout: 30000 });
  if (!walk.ok) return lost(`no pude recorrer main del clon de lectura ${src.dir}: ${String(walk.err).split('\n')[0]}`);
  const stops = new Set([src.commit, floor].filter(Boolean));
  let chosen = null; let result = null; let first = null; let seenFloor = false;
  for (const sha of walk.out.split('\n').filter(Boolean)) {
    const r = check(sha);
    if (r.problem === 'git') return lost(`el clon de lectura no se deja leer: ${r.reason}`);
    if (!first) first = r;
    if (sha === floor) seenFloor = true;
    if (r.ok) { chosen = sha; result = r; break; }
    if (stops.has(sha)) break;
  }
  // el piso, si la búsqueda no pasó por él (main no lo tiene en su línea): un candidato más, con la misma comprobación
  if (!chosen && floor && !seenFloor) { const r = check(floor); if (r.ok) { chosen = floor; result = r; } else if (!first) first = r; }
  if (!chosen) {
    const why = first && first.reason ? first.reason : 'sin commits que mirar';
    return { status: 'blocked', tip, reason: `ningún commit de main interno es compatible con la versión pública ${pub.version || sha7(publicCommit)} (${why}): la capa no se usa y no se mueve nada` };
  }
  const { minimum, lagHours } = layerMinimum(ctx, src, chosen, { floor, tip });
  const note = chosen === tip ? null : (minimum ? layerAtMinimum(lagHours, chosen) : layerStayed(chosen));
  return { status: 'ok', reason: null, commit: chosen, tip, floor, minimum, lagHours, note, result, version: result.version };
}

/** ¿Ese commit de la capa está «al mínimo»? Es el piso de version.json (`floor`) y `main` interno (`tip`, lo traído al
 *  clon de lectura) ya va más adelante; con las horas de atraso. Sin `floor`/`tip`, se leen del árbol y del clon de lectura
 *  (sin red): así una vuelta atrás conserva la marca de la versión a la que vuelve (pase adversarial de la tanda A, C2). */
function layerMinimum(ctx, src, commit, { floor, tip, publicDir = null } = {}) {
  const SRC = mod('sources');
  const f = floor !== undefined ? floor : layerFloor(ctx, publicDir, 'HEAD');
  const t = tip !== undefined ? tip : SRC.refState(src.dir, `refs/remotes/origin/${src.ref || SRC.MAIN_REF}`, { env: ctx.env }).sha;
  const minimum = Boolean(commit && f && commit === f && t && commit !== t);
  let lagHours = null;
  if (minimum) {
    const t0 = commitTime(ctx, src.dir, commit), t1 = commitTime(ctx, src.dir, t);
    if (t0 !== null && t1 !== null) lagHours = Math.max(0, Math.round((t1 - t0) / 3600));
  }
  return { minimum, lagHours };
}

/**
 * El manifiesto de la capa (`layer.json`): `{ ok, data, file, problem }`. Que no esté (ENOENT) es «todavía no se apiló»
 * (`data: null`); cualquier otra cosa —JSON roto, sin «files», sin permiso— es un problema que se dice, nunca «no hay
 * capa» (pase adversarial de la tanda A, C6: antes `ownOverwrites` y `layerFacts` lo tragaban, y update veía lo pisado
 * como cambios de la persona y doctor clasificaba todo sin manifiesto).
 */
function readLayerManifest(ctx, state) {
  const file = (state.layer && state.layer.manifest) || mod('state').paths(ctx.home).layerManifest;
  const broken = (why) => ({ ok: false, data: null, file, problem: `el manifiesto de la capa no se puede leer: ${file} (${why})` });
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, data: null, file, problem: null };
    return broken((e && (e.code || e.message)) || String(e));
  }
  let data;
  try { data = JSON.parse(raw); } catch (e) { return broken(e.message); }
  if (!data || !Array.isArray(data.files)) return broken('no trae «files»');
  // sus rutas terminan en rutas del árbol (lo que se lee, se devuelve al público o se compara): la misma regla de
  // layer.js para la lista y para su lectura del manifiesto. Una que sale del árbol hace al manifiesto inservible, y
  // quien mueve el árbol lo mira acá antes de tocar nada (revisión del paso 5, vuelta 2)
  const bad = data.files.find((f) => !mod('layer').isSafeLayerPath(f && f.path));
  if (bad !== undefined) {
    const shown = bad && typeof bad.path === 'string' ? bad.path : JSON.stringify(bad && bad.path !== undefined ? bad.path : bad);
    return { ok: false, data: null, file, problem: `ruta inválida en el manifiesto de la capa: ${shown} (${file})` };
  }
  return { ok: true, data, file, problem: null };
}

/**
 * Los agregados de la capa que la persona editó a mano (su contenido ya no es el del manifiesto) y que el commit
 * `commit` del árbol SIGUE: ir a ese commit (el reset o el merge de update, la vuelta atrás) los pisaría sin avisar, porque
 * git trata lo ignorado por el bloque de la capa como descartable (pase adversarial de la tanda A, clase 3). Uno cuyo
 * contenido ya es el de ese commit no se pierde y no cuenta. @returns {{ paths: string[], problem: string|null }}
 */
function editedAddsTrackedAt(ctx, state, manifest, commit) {
  const L = mod('layer');
  const adds = (manifest && manifest.data ? manifest.data.files : []).filter((f) => f && f.kind === 'add' && typeof f.path === 'string');
  if (!adds.length || !commit) return { paths: [], problem: null };
  let there;
  try { there = L.readTree(state.tree, commit); } catch (e) { return { paths: [], problem: `no pude leer el commit ${sha7(commit)} del árbol: ${String(e.message).split('\n')[0]}` }; }
  const out = [];
  for (const f of adds) {
    const e = there.get(f.path);
    if (!e) continue;
    const file = path.join(state.tree, ...f.path.split('/'));
    let st = null;
    try { st = fs.lstatSync(file); } catch (_) { continue; }   // no está: no hay nada que perder
    if (!st.isFile()) { out.push(f.path); continue; }
    const buf = fs.readFileSync(file);
    if (crypto.createHash('sha256').update(buf).digest('hex') === f.sha256) continue;
    if (e.type === 'blob' && L.gitBlobId(buf, e.blob) === e.blob) continue;
    out.push(f.path);
  }
  return { paths: out.sort(), problem: null };
}
const editedAddsText = (paths) => `${paths.length === 1 ? 'sigue' : 'siguen'} ${paths.join(', ')}, que la capa agregó y ${paths.length === 1 ? 'está editado' : 'están editados'} a mano: git ${paths.length === 1 ? 'lo pisaría' : 'los pisaría'} sin avisar. Guardá tu edición en otro lado (o devolvé el archivo a como lo dejó la capa) y volvé a correr`;

/**
 * El freno de toda vuelta atrás con capa —la de `rollback` y la automática de un update que no quedó sano—, el mismo
 * para las dos (revisión del paso 5, vuelta 2, C8: la automática no lo tenía y el reset pisaba lo editado a mano): sin
 * manifiesto legible no se sabe qué pisó la capa (C6), y un agregado editado a mano que la versión de la copia sigue lo
 * pisaría el reset (clase 3). `again` es el comando que se nombra para volver a correr. Devuelve null si se puede
 * volver; si no, la línea que lo dice (sin el nombre del comando delante). No escribe nada.
 */
function layerBackBlock(ctx, state, copy, again) {
  if (state.source !== 'public' || !mod('state').layerSources(state).length) return null;
  const man = readLayerManifest(ctx, state);
  if (!man.ok) return `${man.problem} — no vuelvo nada atrás`;
  const hs = harnessSource(state);
  const target = hs && copy && copy.manifest && copy.manifest.sources ? copy.manifest.sources[hs.name] : null;
  if (!target) return null;
  const ed = editedAddsTrackedAt(ctx, state, man, target);
  if (ed.problem) return `no vuelvo nada atrás — ${ed.problem}`;
  if (ed.paths.length) return `no vuelvo nada atrás — la versión a la que se vuelve ${editedAddsText(ed.paths)} ${again}`;
  return null;
}

/** Apila la capa calculada (`result` de computeLayer) sobre el árbol, desde el clon de lectura. Nunca tira.
 *  @returns {{ ok, reason, manifest, applied }} */
function stackLayer(ctx, state, src, result) {
  const L = mod('layer'), S = mod('state');
  const manifest = (state.layer && state.layer.manifest) || S.paths(ctx.home).layerManifest;
  try {
    const r = L.applyLayer({ tree: real(state.tree) || state.tree, from: src.dir, list: JSON.parse(L.serializeList(result)), manifest, platform: ctx.platform });
    if (!r.ok) return { ok: false, reason: `la capa trae ${r.refused.map((x) => `${x.path} (${x.what})`).join(', ')}: nunca se crea un enlace; no se escribió nada`, manifest };
    return { ok: true, reason: null, manifest, applied: r };
  } catch (e) { return { ok: false, reason: `no pude apilar la capa: ${e.message}`, manifest }; }
}

/** Registra la capa apilada: el commit en la fuente (con `previous` y `refs/tycon/previous/<fuente>` si cambió), la ref
 *  local de la versión y `state.layer`. Sólo escribe en el clon de lectura (refs propias) y en el estado. */
function recordLayer(ctx, state, src, pick, manifest) {
  const SRC = mod('sources');
  const env = ctx.env;
  if (src.commit && src.commit !== pick.commit) {
    SRC.git(src.dir, ['update-ref', SRC.previousRef(src.name), src.commit], { env });
    src.previous = src.commit;
  }
  src.commit = pick.commit;
  SRC.git(src.dir, ['update-ref', layerRef(pick.version, pick.commit), pick.commit], { env });
  state.layer = { manifest, version: pick.version || null, at: nowIso(), minimum: Boolean(pick.minimum), lag_hours: pick.minimum ? pick.lagHours : null };
}

/** Los archivos que la capa pisó a propósito y siguen como los dejó (su sha256 es el del manifiesto): son del mecanismo,
 *  no cambios de la persona. Lo editado a mano no entra. */
//  Con el manifiesto ilegible devuelve [] — quien mueve el árbol lo mira antes con `readLayerManifest` y no se mueve (C6).
function ownOverwrites(ctx, state) {
  const man = readLayerManifest(ctx, state);
  if (!man.ok || !man.data) return [];
  const out = [];
  for (const f of man.data.files) {
    if (!f || f.kind !== 'overwrite') continue;
    try { if (sha256(path.join(state.tree, ...f.path.split('/'))) === f.sha256) out.push(f.path); } catch (_) { /* no está: nada que sacar */ }
  }
  return out;
}
/** Antes de mover el árbol: lo pisado por la capa vuelve a lo del público (`checkout`), así el árbol queda limpio y la
 *  capa se re-apila después sobre la versión nueva. */
function unstackOverwrites(ctx, state, log = null) {
  const own = ownOverwrites(ctx, state);
  if (!own.length) return [];
  // como pathspec literal: un «*» o un «:(…)» en una ruta no puede devolver al público otros archivos que los de la capa
  const r = mod('sources').git(state.tree, ['checkout', '-q', '--', ...own.map((p) => `:(literal)${p}`)], { env: ctx.env });
  if (!r.ok && log) log(`update: no pude devolver al público lo pisado por la capa (${String(r.err).split('\n')[0]})`);
  return own;
}

/** La capa a un commit dado contra lo que el árbol tiene AHORA (HEAD): para volver (rollback, vuelta atrás automática,
 *  un avance que falló a mitad). Sin pasar la comprobación no se apila. @returns {{ ok, reason, from, to }} */
function restackLayerAt(ctx, state, src, commit) {
  const L = mod('layer');
  const from = src.commit;
  let result;
  try { result = L.computeLayer({ internalDir: src.dir, internalCommit: commit, publicDir: state.tree, publicCommit: 'HEAD' }); } catch (e) { return { ok: false, reason: `no pude calcular la capa en ${sha7(commit)}: ${e.message}`, from, to: commit }; }
  if (!result.ok) return { ok: false, reason: `la capa en ${sha7(commit)} no es compatible con el árbol: ${result.reason}`, from, to: commit };
  const st = stackLayer(ctx, state, src, result);
  if (!st.ok) return { ok: false, reason: st.reason, from, to: commit };
  // la marca del mínimo es la de la versión a la que se vuelve, no `false` (C2)
  const m = layerMinimum(ctx, src, commit, { publicDir: state.tree });
  recordLayer(ctx, state, src, { commit, version: result.version, minimum: m.minimum, lagHours: m.lagHours }, st.manifest);
  return { ok: true, reason: null, from, to: commit };
}

/** Lo que `rollback.restore` llama alrededor de los árboles (story 8.13.1, AC 17): antes, lo pisado vuelve al público;
 *  después, la capa se re-apila en el commit de la copia (o donde estaba, si los árboles no se movieron). */
function layerHooks(ctx, state, log = null) {
  const S = mod('state');
  if (state.source !== 'public' || !S.layerSources(state).length) return {};
  return {
    beforeTrees: () => { unstackOverwrites(ctx, state, log); },
    afterTrees: (copy) => {
      const moved = [];
      for (const src of S.layerSources(state)) {
        const want = (copy && copy.manifest && copy.manifest.sources && copy.manifest.sources[src.name]) || src.commit;
        if (!want) continue;
        const was = src.commit;
        const r = restackLayerAt(ctx, state, src, want);
        if (!r.ok) throw new Error(r.reason);
        if (was !== want) moved.push({ name: src.name, from: was, to: want });
      }
      return moved;
    },
  };
}

/**
 * Trae y, si hay versión nueva, avanza TODAS las fuentes (agent_skills primero, harness después), corre el aplicador, la
 * comprobación de salud (tanda C) y refresca la copia fija si quedó sano; si no, vuelve sola. `mode`: 'apply' (mueve) ·
 * 'check' (sólo mira) · 'dry-run' (lista). `yes`: aplica aunque haya una retención o un intento fallido sobre esas puntas.
 * @returns {{ status: 'up_to_date'|'new'|'unknown'|'applied'|'failed'|'busy'|'held'|'skipped', lines: string[], code: number, from, to }}
 */
// `persist: false` = quien llama no va a grabar el estado (update --check): los mensajes no prometen lo que no queda.
// `policy`: la política vigente; su canal decide la ref de cada fuente que se reescribe (tanda D). Sin ella, el del estado.
// `only`: el nombre de UNA fuente — se mira y se mueve sólo ésa (la usa `unblockStraightLine`; las demás ni se tocan).
// `startedAt`: desde cuándo corre el tope de red (C7). `update` pasa el arranque del proceso; `startup`, que tiene su
// propio tope de 35 s, no pasa nada y el tope corre desde acá.
function doUpdate(ctx, state, { mode = 'apply', log = null, snapshot = null, persist = true, yes = false, policy = null, only = null, startedAt = null } = {}) {
  const SRC = mod('sources'), R = mod('report'), S = mod('state');
  const env = ctx.env;
  const channel = (policy && policy.channel) || state.channel || 'stable';
  const deadline = (startedAt || Date.now()) + SRC.budgetOf(null, env) * 1000 - UPDATE_WRAPUP_MS;
  const leftS = () => Math.max(0.5, (deadline - Date.now()) / 1000);
  // story 8.13.1: las fuentes `layer` (la capa) no son árboles: se miran y se mueven aparte, abajo. Sin ninguna (una
  // máquina de afuera, o la de hoy en `source: internal`) esto es exactamente el update de la 8.13
  const layers = state.source === 'public' && !only ? S.layerSources(state) : [];
  const order = state.sources.filter((s) => S.kindOf(s) !== 'layer').filter((s) => !only || (s && s.name === only)).sort((a, b) => (a.name === 'agent_skills' ? -1 : b.name === 'agent_skills' ? 1 : 0));
  // una fuente que no está parada donde se la actualiza (un clon en una rama de trabajo) no se toca y se avisa (AC 8);
  // antes de salir a la red, para que el motivo sea ése y no un efecto del fetch. Ref fija: su ref (`main`); ref que se
  // reescribe: `tycon/installed`, o la primera vez, el commit registrado o un avance simple de la rama por defecto (A5)
  const off = [];
  for (const src of order) {
    if (src.rewrites) { const why = SRC.offInstalledBranch(src, { env, home: ctx.home }); if (why) off.push(`harness.js update: ${why}`); continue; }
    const b = SRC.branch(src.dir, { env });
    if (b !== SRC.MAIN_REF) off.push(`harness.js update: ${src.name} está en la rama ${b || '(sin rama)'} y no en ${SRC.MAIN_REF}: no se toca (volver: git -C ${src.dir} checkout ${SRC.MAIN_REF}; branch-guard-notice lo sigue avisando)`);
  }
  if (off.length) return { status: 'blocked', code: 2, lines: off };
  // con capa, su manifiesto tiene que poder leerse ANTES de mirar nada: sin él no se sabe qué pisó la capa a propósito,
  // y lo pisado se leería como cambios de la persona (C6). No se mueve nada y se dice
  const layerManifest = layers.length ? readLayerManifest(ctx, state) : null;
  if (layerManifest && !layerManifest.ok) return { status: 'blocked', code: 2, lines: [`harness.js update: ${layerManifest.problem} — no se mueve ninguna fuente`] };
  // lo que `doctor` promete se decide con lo mismo que él ve, ANTES de traer: una fuente que se reescribe cuyo HEAD no es
  // el commit registrado y es un commit PUBLICADO (nada suyo falta en lo traído de origin: un pull a mano, el respaldo en
  // shell) se re-registra abajo, cuando se pudo mirar. Un commit propio no se registra como versión
  const published = new Set(order.filter((src) => src.rewrites && SRC.head(src.dir, { env }) !== src.commit && SRC.ownCommits(src.dir, env) === 0).map((src) => src.name));
  // con capa, el árbol también mira dentro del tope común (AC 9: las dos fuentes juntas); sin capa, como en la 8.13
  const checks = order.map((src) => ({ src, c: SRC.check(src, layers.length ? { env, channel, budgetS: leftS() } : { env, channel }) }));
  // la MIRADA (`last_fetch`) se sella sólo si se pudo mirar (A7): con la ventana de 6 horas de `ask`, un arranque sin red
  // a la mañana no puede tapar la mirada hasta la tarde. El intento que no pudo queda aparte (`last_fetch_failed`), para
  // reintentar pasados 10 minutos y no en cada sesión
  const unknown = checks.filter((x) => x.c.status === 'unknown');
  if (unknown.length) {
    state.last_fetch_failed = nowIso();
    return { status: 'unknown', code: 2, lines: unknown.map((x) => `harness.js update: ${x.c.reason}`) };
  }
  // story 8.18 (AC 35): dos fuentes que siguen EL MISMO repo (el clon de skills re-apuntado) van a la misma punta o no
  // se mueve ninguna. Entre un fetch y el otro pudo entrar un commit: se vuelve a mirar la primera, una vez
  const twinSkills = checks.find((x) => x.src.name === 'agent_skills');
  const twinHarness = checks.find((x) => x.src.name === 'harness');
  if (twinSkills && twinHarness && twinSkills.c.to && twinHarness.c.to && twinSkills.c.to !== twinHarness.c.to
    && SRC.remoteIdentity(twinSkills.src.url) && SRC.remoteIdentity(twinSkills.src.url) === SRC.remoteIdentity(twinHarness.src.url)) {
    twinSkills.c = SRC.check(twinSkills.src, { env, channel });
    if (twinSkills.c.status === 'unknown' || twinSkills.c.to !== twinHarness.c.to) {
      state.last_fetch_failed = nowIso();
      return { status: 'unknown', code: 2, lines: [`harness.js update: ${twinSkills.c.status === 'unknown' ? twinSkills.c.reason : `las dos fuentes siguen el mismo repo y no vieron la misma punta (agent_skills ${sha7(twinSkills.c.to)}, harness ${sha7(twinHarness.c.to)}): no se mueve ninguna; se reintenta en el próximo arranque`}`] };
    }
  }
  // story 8.13.1 (AC 7-9): la capa se trae y se elige ANTES de sellar la mirada —`last_fetch` cubre las dos fuentes— y
  // contra la versión pública que va a quedar (la nueva si la hay). El fetch del interno usa lo que queda del tope: las
  // dos juntas no pasan de TYCON_UPDATE_NETWORK_BUDGET_S. Si no se puede traer, no se mueve ninguna
  const layerChecks = [];
  if (layers.length) {
    const hx = checks.find((x) => x.src.name === 'harness') || checks[0];
    const publicCommit = hx ? (hx.c.status === 'new' ? hx.c.to : hx.c.from) : 'HEAD';
    for (const src of layers) layerChecks.push({ src, p: pickLayerCommit(ctx, src, { publicDir: state.tree, publicCommit, budgetS: leftS() }) });
    const lost = layerChecks.filter((x) => x.p.status === 'unknown');
    if (lost.length) {
      state.last_fetch_failed = nowIso();
      return { status: 'unknown', code: 2, lines: lost.map((x) => `harness.js update: ${x.p.reason}`) };
    }
  }
  state.last_fetch = nowIso();
  state.last_fetch_failed = null;
  for (const x of checks) if (x.c.note && log) log(`update: ${x.src.name}: ${x.c.note}`);
  // una capa sin commit compatible, o una versión pública sin la lista de transformados: no se mueve nada (AC 5, 8)
  const layerBlocked = layerChecks.filter((x) => x.p.status === 'blocked');
  if (layerBlocked.length) return { status: 'blocked', code: 2, lines: layerBlocked.map((x) => `harness.js update: ${x.p.reason}`) };
  const layerNotes = layerChecks.map((x) => x.p.note).filter(Boolean);
  for (const n of layerNotes) if (log) log(`update: ${n}`);
  // una fuente que se REESCRIBE cuyo clon alguien movió a mano a un commit publicado —o a la punta de lo traído— no
  // coincide con el commit registrado: `doctor` lo pone en rojo y remite acá, así que acá se re-registra, haya o no
  // versión nueva (pase adversarial de la tanda D, causa B: este lazo las salteaba, y el consejo de `doctor` era falso;
  // con `ask` y versión nueva el rojo duraba hasta que la persona aplicara). Las de ref fija, abajo, como siempre
  const reregistered = [];
  for (const { src, c } of checks) {
    if (!src.rewrites || !c.from || src.commit === c.from) continue;
    if (c.from !== c.to && !published.has(src.name)) continue;
    reregistered.push(`${src.name} ${sha7(src.commit)} → ${sha7(c.from)}`);
    src.commit = c.from;
  }
  if (reregistered.length) {
    state.version.number = versionNumber(ctx, state);
    if (log) log(`update: commit re-registrado (el clon ya estaba en un commit publicado): ${reregistered.join(', ')}`);
  }
  const fresh = checks.filter((x) => x.c.status === 'new');
  // story 8.18 (AC 34): una fuente de la que salen las skills NUNCA avanza a una punta que no las trae (`main` devuelto a
  // un árbol de antes de la unión): esa versión no se aplica ni se ofrece, y ninguna fuente se mueve. «No pude mirar» no
  // es «las trae». En la máquina de dos clones sin re-apuntar el arnés no es una de esas fuentes: sigue a `main`
  const guard = repointModule(log);
  for (const x of guard ? fresh : []) {
    // en tres estados: «no pude leer si de esta fuente salen las skills» no es «no salen» (ahí la guarda se salteaba y
    // la punta sin skills seguía su camino): no se mueve nada y se dice con su causa
    const provides = guard.skillsFrom(state, x.src, { env });
    if (provides.status === 'unknown') return { status: 'unknown', code: 2, lines: [`harness.js update: no pude mirar si de ${x.src.name} salen las skills de esta máquina — ${provides.reason}: no se mueve ninguna fuente`] };
    if (provides.status !== 'yes') continue;
    const brings = guard.hasSkills(x.src.dir, x.c.to, { env });
    if (brings === true) continue;
    const tip = `origin/${x.c.ref || x.src.ref} de ${x.src.name} (${sha7(x.c.to)})`;
    if (brings === null) return { status: 'unknown', code: 2, lines: [`harness.js update: no pude mirar si ${tip} trae las skills: no se mueve ninguna fuente`] };
    return { status: 'blocked', code: 2, lines: [`harness.js update: la versión nueva no trae las skills: no se aplica — ${tip} no trae ${guard.SKILLS_MARK}; ninguna fuente se mueve y esta máquina sigue en ${sha7(x.c.from)}, con sus skills`] };
  }
  // lo traído es MÁS VIEJO que lo instalado (por número; AC 25): no se baja, y se dice
  const older = checks.filter((x) => x.c.status === 'older').map((x) => noDowngradeText(x, channel));
  // una fuente con commits propios (divergió) se avisa aunque no haya nada nuevo: update no la va a tocar nunca (AC 8)
  const own = order.filter((src) => !src.rewrites).map((src) => {
    // una cuenta que git no pudo hacer no es «cero commits propios»: se dice
    const counted = SRC.git(src.dir, ['rev-list', '--count', `refs/remotes/origin/${src.ref}..HEAD`], { env });
    const n = counted.ok ? parseInt(counted.out, 10) : NaN;
    if (!Number.isFinite(n)) return `no pude contar los commits propios de ${src.name} sobre origin/${src.ref}: no se sabe si divergió`;
    return n > 0 ? `${src.name} divergió: ${n} commit(s) propios sobre ${src.ref} que origin no tiene — no se toca` : null;
  }).filter(Boolean);
  // la capa que se mueve (story 8.13.1, AC 8): con el público nuevo, se re-apila siempre (aunque el commit sea el mismo);
  // con el público al día, sólo si hay un commit de capa más nuevo compatible («sólo la capa»)
  const layerMoves = layerChecks.filter((x) => fresh.length || x.p.commit !== x.src.commit);
  const layerLines = layerMoves.filter((x) => x.p.commit !== x.src.commit).map((x) => `capa ${sha7(x.src.commit)} → ${sha7(x.p.commit)}`);
  if (!fresh.length && !layerMoves.length) {
    // al día, pero un clon que alguien llevó a mano a la punta de origin (un pull, el respaldo en shell) no coincide con
    // el commit registrado: doctor lo pone en rojo y remite acá, así que acá se re-registra (pase adversarial, iter. 2).
    // Sólo si HEAD ES la punta de origin: un commit propio no se registra como versión. (Las que se reescriben ya se
    // re-registraron arriba, apenas se pudo mirar.)
    const fixed = [];
    for (const src of order) {
      if (src.rewrites) continue;
      const h = SRC.head(src.dir, { env });
      const tip = SRC.refState(src.dir, `refs/remotes/origin/${src.ref}`, { env }).sha;   // ilegible o ausente: no se registra nada
      const st = state.sources.find((s) => s.name === src.name);
      if (st && h && tip && h === tip && st.commit !== h) { fixed.push(`${src.name} ${sha7(st.commit)} → ${sha7(h)}`); st.commit = h; }
    }
    if (fixed.length) {
      reregistered.push(...fixed);
      state.version.number = versionNumber(ctx, state);
      if (log) log(`update: commit re-registrado (el clon ya estaba en la punta de origin): ${fixed.join(', ')}`);
    }
    // con --check nadie graba el estado: se dice que se re-registraría (startup sí lo graba, aun en «ask»)
    const said = !persist ? (r) => `commit a re-registrar: ${r} (se re-registraría con harness.js update)` : (r) => `commit re-registrado: ${r}`;
    // «al día» no es lo que pasa cuando lo publicado es más viejo: se dice eso, y sale 0 igual (no hay nada que aplicar)
    return { status: 'up_to_date', code: 0, older: older.length > 0, lines: [...(older.length ? older : ['arnés al día']), ...layerNotes, ...reregistered.map(said), ...own.map((o) => `harness.js update: ${o}`)] };
  }
  const what = [...fresh.map((x) => `${x.src.name} ${sha7(x.c.from)} → ${sha7(x.c.to)}`), ...layerLines].join(', ');
  // las puntas que se aplicarían (las de cada fuente: la nueva, o la de ahora si no cambió o si no se baja)
  const tips = {};
  for (const x of checks) tips[x.src.name] = x.c.status === 'older' ? x.c.from : (x.c.to || x.c.from);
  for (const x of layerChecks) tips[x.src.name] = x.p.commit;
  // la retención de un rollback (AC 19): ni con `apply: auto` se avanza hasta `rollback --release` o `update --yes`; con
  // `apply: ask` tampoco se ofrece la versión deshecha como «disponible» (pase adversarial H8)
  if (state.hold && !yes && mode !== 'dry-run') return { status: 'held', code: 0, lines: [`hay versión nueva (${what}), pero ${holdText(state)}`] };
  // un intento que ya falló sobre ESTAS puntas no se repite solo, ni se ofrece (AC 21, H8); `interrupted` sí se reintenta
  if (state.failed && state.failed.reason !== 'interrupted' && !yes && mode !== 'dry-run' && sameTips(state.failed.sources, tips)) {
    return { status: 'skipped', code: 0, lines: [`la versión ${state.failed.commit} ya falló (${state.failed.reason || 'salud'}, ${state.failed.at || '—'}): no se reintenta sola hasta que cambie la punta (o ${applyHint})`] };
  }
  // (sólo la capa: el aviso se arma con la línea «capa a → b», no con el número del público, que no cambia)
  if (mode === 'check') return { status: 'new', code: 3, lines: [`hay versión nueva: ${what}`, ...older, ...layerNotes], available: fresh.length ? describeAvailable(ctx, state, fresh, channel) : null, fresh };

  // todas o ninguna: primero el plan de cada una (la que no se baja no se mueve). Con capa, lo que ella pisó a propósito
  // no cuenta como «cambios sin commitear» del árbol: vuelve al público antes de mover y se re-apila después
  const notMoving = new Set(checks.filter((x) => x.c.status === 'older').map((x) => x.src.name));
  // un agregado de la capa editado a mano que la versión nueva del árbol empieza a seguir: el reset (o el merge) lo
  // pisaría sin avisar —git trata lo ignorado como descartable— y la edición se perdería (clase 3; AC 4 y 8: lo editado no
  // se pisa, todas o ninguna). No se mueve nada y se nombra
  if (layers.length) {
    for (const x of fresh.filter((y) => y.src.dir === state.tree && !notMoving.has(y.src.name))) {
      const ed = editedAddsTrackedAt(ctx, state, layerManifest, x.c.to);
      if (ed.problem) return { status: 'unknown', code: 2, lines: [`harness.js update: no se mueve ninguna fuente — ${ed.problem}`] };
      if (ed.paths.length) return { status: 'blocked', code: 2, lines: [`harness.js update: no se mueve ninguna fuente — la versión nueva ${editedAddsText(ed.paths)} update`] };
    }
  }
  const layerOwned = layerMoves.length ? ownOverwrites(ctx, state) : [];
  const plans = order.map((src) => ({ src, p: notMoving.has(src.name) ? { ok: true, upToDate: true } : SRC.plan(src, { env, home: ctx.home, also: src.dir === state.tree ? layerOwned : [] }) }));
  const blocked = plans.filter((x) => !x.p.ok);
  if (blocked.length) {
    const lockHit = blocked.find((x) => /index\.lock/i.test(x.p.reason || ''));
    if (lockHit) return { status: 'busy', code: 3, lines: [`harness.js update: otra sesión está usando el clon de ${lockHit.src.name} (index.lock) — no se mueve nada`] };
    return { status: 'blocked', code: 2, lines: blocked.map((x) => `harness.js update: no se mueve ninguna fuente — ${x.p.reason}`) };
  }
  if (mode === 'dry-run') return { status: 'new', code: 0, lines: [`se actualizaría: ${what}`, ...plans.filter((x) => !x.p.upToDate).map((x) => `  ${x.src.name}: ${x.p.from} → ${x.p.to}${x.p.dirty ? ' (lo local se guarda aparte y se reaplica)' : ''}`), ...layerMoves.map((x) => `  ${x.src.name}: ${x.src.commit} → ${x.p.commit} (la capa, re-apilada)`)] };

  // la salud y la vuelta atrás que corren son las de esta versión (la que se sabe sana), cargadas antes de mover
  const rec = preloadRecovery(log);
  // la copia ANTES de mover nada (AC 17), SIEMPRE nueva al mover árboles (tanda C, decisión 1): la de `startup` sirve si
  // la acaba de crear; si la reutilizó, se toma otra, así su «después» es el de esta actualización
  const ownSnap = snapshot && snapshot.created ? null
    : takeSnapshot(ctx, state.tree, { reason: 'update', from: state.version.number, to: [...fresh.map((x) => `${x.src.name}@${sha7(x.c.to)}`), ...layerMoves.map((x) => `${x.src.name}@${sha7(x.p.commit)}`)].join(' '), log, force: true, state });
  const snap = ownSnap || snapshot;
  const before = versionLabel(ctx, state);
  // con capa y público nuevo: lo pisado vuelve al público antes del reset (así el árbol está limpio), y si algo falla a
  // mitad de camino la capa vuelve a apilarse donde estaba
  const unstacked = layerMoves.length && fresh.length ? unstackOverwrites(ctx, state, log) : null;
  const restackBack = () => {
    if (!unstacked) return [];
    return layers.map((src) => restackLayerAt(ctx, state, src, src.commit)).filter((r) => !r.ok).map((r) => `la capa no se pudo volver a apilar en ${sha7(r.to)}: ${r.reason}`);
  };

  // mover, en orden; si la segunda falla, la primera vuelve
  const moved = [];
  for (const { src, p } of plans) {
    if (p.upToDate) continue;
    const a = SRC.advance(src, { env, home: ctx.home });
    if (!a.ok) {
      // un reset/merge a medias (Windows: «unable to unlink»; tanda C, AC 21) deja ESTA fuente a mitad de camino: también
      // vuelve, y se anota `interrupted` para reintentar en la sesión siguiente
      const interrupted = /unable to unlink/i.test(a.reason || '');
      const back = interrupted && a.from ? [...moved, { src, from: a.from }] : moved;
      // revert aparta y reaplica lo local de cada una (pase adversarial, clases 9 y 23); si no pudo, lo dice
      const kept = [];
      for (const m of back) {
        const rv = SRC.revert(m.src, m.from, { env });
        const st = state.sources.find((s) => s.name === m.src.name);
        if (st) { st.commit = m.from; st.previous = null; }
        if (!rv.ok || rv.kept) kept.push(rv.reason);
      }
      kept.push(...restackBack());
      if (/index\.lock/i.test(a.reason || '')) return { status: 'busy', code: 3, lines: [`harness.js update: otra sesión está usando el clon de ${src.name} (index.lock) — no se movió nada`, ...kept] };
      if (interrupted) {
        finishSnapshot(ctx, ownSnap, log);
        state.failed = { commit: fresh.map((x) => `${x.src.name}@${sha7(x.c.to)}`).join(' '), sources: tips, at: nowIso(), log: S.paths(ctx.home).log, reason: 'interrupted' };
        R.setNotice(state, `la actualización quedó a medias (${a.reason}): las fuentes volvieron a ${before}; se reintenta en la próxima sesión`);
        if (log) log(`update: interrupted: ${a.reason}`);
        return { status: 'failed', code: 1, lines: [`harness.js update: quedó a medias (${a.reason}) — volvió a ${before}; se reintenta en la próxima sesión`, ...kept.filter(Boolean)] };
      }
      return { status: 'blocked', code: 2, lines: [`harness.js update: ${a.reason}${moved.length ? ` — ${moved.map((m) => m.src.name).join(', ')} volvió a su versión` : ''}`, ...kept] };
    }
    moved.push({ src, from: a.from, to: a.to, a });
    const st = state.sources.find((s) => s.name === src.name);
    if (st) { st.previous = a.from; st.commit = a.to; }
  }
  // la capa, re-apilada sobre el árbol que quedó (story 8.13.1, AC 8): si no se puede, el árbol vuelve y la capa también
  for (const x of layerMoves) {
    const st = stackLayer(ctx, state, x.src, x.p.result);
    if (!st.ok) {
      const kept = [];
      for (const m of moved) {
        const rv = SRC.revert(m.src, m.from, { env });
        const s0 = state.sources.find((s) => s.name === m.src.name);
        if (s0) { s0.commit = m.from; s0.previous = null; }
        if (!rv.ok || rv.kept) kept.push(rv.reason);
      }
      // la capa vuelve a donde estaba (un apilado que se cortó a mitad pudo dejar parte escrita)
      kept.push(...layers.map((src) => restackLayerAt(ctx, state, src, src.commit)).filter((r) => !r.ok).map((r) => `la capa no se pudo volver a apilar en ${sha7(r.to)}: ${r.reason}`));
      finishSnapshot(ctx, ownSnap, log);
      return { status: 'blocked', code: 2, lines: [`harness.js update: ${st.reason} — no se mueve ninguna fuente${moved.length ? ` (${moved.map((m) => m.src.name).join(', ')} volvió a su versión)` : ''}`, ...kept.filter(Boolean)] };
    }
    recordLayer(ctx, state, x.src, x.p, st.manifest);
  }
  if (log) log(`update: ${what}`);

  // el aplicador, ya con las dos fuentes nuevas, y la comprobación de salud (AC 21) antes de dar por buena la versión.
  // Con capa, desde la ruta real del árbol (story 8.13.1)
  const applier = runApplier(ctx, layers.length ? (real(state.tree) || state.tree) : state.tree, { log, snapshotDir: snap && snap.dir });
  state.last_apply = nowIso();
  const after = versionLabel(ctx, state);
  if (!applier.ok) return failUpdate(ctx, state, { snap, rec, before, after, tips, failures: [applier.reason], reason: 'applier', log });
  state.version.number = versionNumber(ctx, state);
  recordPieces(ctx, state, applier.report, applier.shared);   // con la versión nueva: lo que entra ahora es de ésta
  // el `doctor` del árbol nuevo (parte de la salud) lee el estado del disco: se graba antes, con la constancia de que la
  // salud quedó PENDIENTE — si la sesión muere en el medio, el arranque siguiente la corre (pase adversarial H18)
  state.failed = pendingHealth(ctx, { commit: after, sources: tips, applierOut: applier.out });
  try { S.write(ctx.home, state); } catch (e) { if (log) log(`update: no pude grabar el estado antes de la salud (${e.message})`); }
  const done = finishHealth(ctx, state, { snap, ownSnap, rec, before, after, tips, report: applier.report, applierOut: applier.out, log, moved });
  if (done.status === 'applied' && layerMoves.length) done.lines = [done.lines[0], ...layerLines, ...layerNotes, ...done.lines.slice(1)];
  if (done.status === 'applied') { const pl = packRetiredLine(applier); if (pl) { done.lines.push(pl); if (log) log(`update: ${pl}`); } }
  return done;
}

/** La constancia de «salud pendiente» que se graba ANTES de correrla (H18): si la sesión muere en el medio, el arranque
 *  siguiente la retoma. Guarda las líneas «FALLÓ» de la suite rápida del aplicador, que no se vuelven a producir (fallos
 *  silenciosos, iteración 2: sin ellas la salud retomada quedaba ciega a la suite). */
function pendingHealth(ctx, { commit, sources, applierOut }) {
  const failedLines = String(applierOut || '').split('\n').filter((l) => /FALLÓ/.test(l)).slice(0, 20);
  return { commit, sources, at: nowIso(), log: mod('state').paths(ctx.home).log, reason: 'interrupted', pending: 'health', applier_failed: failedLines };
}

/** La comprobación de salud de una versión ya aplicada y su desenlace: verde → `last_health`, copia fija refrescada,
 *  `failed` fuera; rojo → la vuelta atrás automática (`failUpdate`). La usa `doUpdate` y el arranque que encuentra una
 *  salud pendiente (la sesión anterior murió en el medio: H18). */
function finishHealth(ctx, state, { snap, ownSnap = null, rec, before, after, tips, report, applierOut, log, moved = [] }) {
  const health = runHealth(ctx, state, { report, applierOut, log, health: rec && rec.health });
  for (const w of health.warnings || []) if (log) log(`update: salud: ${w}`);
  if (!health.ok) return failUpdate(ctx, state, { snap, rec, before, after, tips, failures: health.failures.length ? health.failures : ['la salud no pasó'], reason: 'health', log });
  state.failed = null;
  state.version.installed_at = nowIso();
  state.last_health = nowIso();
  // sólo con la salud en verde se refresca la copia fija (AC 13c, AC 21): desde la C trae el programa
  copyBootstrap(ctx, state.tree, state);
  // y el estado se graba YA: un corte entre la copia nueva y el S.write de cierre (un reinicio de Windows en medio del
  // aplicador, 2026-10-07) dejaba la copia fija de la versión nueva con el estado de la vieja, y el arranque siguiente lo
  // leía como «alguien la tocó», daba la salud por roja y volvía atrás
  try { mod('state').write(ctx.home, state); } catch (e) { if (log) log(`update: no pude grabar el estado tras refrescar la copia fija (${e.message})`); }
  finishSnapshot(ctx, ownSnap, log);
  const stashNotes = moved.filter((m) => m.a && m.a.kept).map((m) => `${m.src.name}: lo local no se pudo reaplicar y quedó en git stash list`);
  return { status: 'applied', code: 0, lines: [`arnés ${before} → ${after}`, ...stashNotes], from: before, to: after, backup: snap && snap.dir ? snap.dir : null };
}

function cmdStartup(ctx) {
  const S = mod('state'), L = mod('lock'), R = mod('report');
  const log = (l) => R.log(ctx.home, l);
  const say = (line) => ({ code: 0, lines: line ? [line] : [] });
  // story 8.23, tanda L (AC 38): lo largo corre APARTE del hook de arranque, que Claude Code corta por su tope —con el
  // candado tomado, y en una máquina con mucho atraso en CADA arranque—. El hook espera hasta 20 s: si termina, sale con
  // su código (un error temprano sigue cayendo al respaldo en shell); si no, sale 0 y la actualización sigue sola.
  // Apagable con TYCON_STARTUP_DETACH=0 (corre en el lugar, como antes).
  const D = mod('detach');
  if (!D.isDetachedRun() && String(ctx.env.TYCON_STARTUP_DETACH || '') !== '0') {
    const dir = S.paths(ctx.home).harnessDir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* lo dice el resto */ }
    D.sweep(dir);
    // TYCON_STARTUP_WAIT_MS: sólo para las pruebas (cuánto espera el hook antes de dejarla seguir sola)
    const waitMs = Number(ctx.env.TYCON_STARTUP_WAIT_MS) > 0 ? Number(ctx.env.TYCON_STARTUP_WAIT_MS) : 20000;
    const r = D.runDetached({ script: __filename, args: ['startup', ...(ctx.opts.force ? ['--force'] : [])], env: ctx.env, resultFile: path.join(dir, `startup-result.${process.pid}.json`), waitMs });
    if (r) {
      if (r.detached) log(`startup: la actualización sigue aparte del hook (pid ${r.pid}); el resultado, en este registro`);
      // no arrancó: lo dice el registro y queda anotado (AC 39); sale ≠ 0 y la línea cae al respaldo en shell
      if (r.notStarted) { log(`startup: ${r.lines[0]}`); R.recordUpdateFailure(ctx.home, r.lines[0]); }
      return { code: r.code, lines: r.lines };
    }
    log('startup: no pude lanzar la actualización aparte: corre acá, dentro del tope del hook');
  }
  // el Node del arnés (story 8.39, AC 4): sólo la parte que va aparte del hook baja (con su tope de 180 s y sus
  // ventanas); el arranque que corre en el lugar, dentro de los 20 s del hook, no baja nada y lo deja para el siguiente
  ctx.harnessNodeMode = D.isDetachedRun() ? 'startup' : 'none';
  ctx.eolQuiet = true;   // el aviso de finales de línea va a `notice`, no a stderr (B2: ver runApplier)
  // el de un arranque anterior se recalcula en éste: va siempre al final de `notice` y no se arrastra
  const EOL_NOTICE_TAIL = /(?:^| · )finales de línea: [\s\S]*$/;
  const read = loadState(ctx);
  if (read.status !== 'ok') {
    const f = S.fail(read, { home: ctx.home });
    log(`startup: ${f.line}`);
    // un estado legible que apunta a un árbol que ya no está: el aviso queda en `notice` (AC 2); uno ilegible o de una
    // versión más nueva no se reescribe —no es nuestro—: lo dice el hook síncrono, que lo detecta solo
    if (read.status === 'tree_missing' && read.state) {
      L.withLock(ctx.home, () => {
        const again = loadState(ctx);
        if (again.status === 'tree_missing' && again.state) { R.setNotice(again.state, `${f.line} — el arranque no hace nada hasta arreglarlo`); S.write(ctx.home, again.state); }
      }, { env: ctx.env, onBusy: () => null });
    }
    return say(read.status === 'missing' ? f.line : `${f.line} — no toco nada`);
  }
  // (un candado de un arranque que murió sin soltarlo se pisa en el acto y lo dice el registro: lock.js, AC 37)
  return L.withLock(ctx.home, () => {
    // una mudanza a ~/.tycon cortada (story 8.23, tanda D · AC 28): antes de leer el estado, se completa o se deshace
    // desde su diario; el estado puede estar en cualquiera de los dos lugares hasta que termine
    try {
      const rep = mod('move-home').repair(ctx, migrateHelpers(ctx), { log });
      if (rep.repaired) log(`startup: ${rep.lines.join(' · ')}`);
    } catch (e) { log(`startup: la reparación de la mudanza falló: ${e.message}`); }
    const r = loadState(ctx);
    if (r.status !== 'ok') { log(`startup: ${S.fail(r, { home: ctx.home }).line}`); return say(); }
    const state = r.state;
    // la versión bajada (story 8.23, tanda B): su arranque no hace git; vive en release.js
    // el aviso de una herramienta sin enchufar (story 8.23, tanda C) se recalcula en cada arranque: el de antes no se arrastra
    if (state.notice && mod('tools').NOTICE_TAIL.test(state.notice)) state.notice = state.notice.replace(mod('tools').NOTICE_TAIL, '') || null;
    if (S.isRelease(state)) return mod('release').startup(ctx, state, releaseHelpers(ctx), { log });
    if (state.notice && EOL_NOTICE_TAIL.test(state.notice)) state.notice = state.notice.replace(EOL_NOTICE_TAIL, '') || null;
    const tree = state.tree;
    let line = null;
    // El aviso se RECALCULA en cada arranque: lo que hoy no se vuelve a dar se borra (antes un aviso de falla quedaba para
    // siempre y el hook síncrono lo repetía en cada sesión — pase adversarial, clases 2, 11 y 25). La excepción es el
    // «disponible» de una versión nueva en ask: se conserva mientras no se vuelva a salir a la red.
    let notice = null;
    // lo que sale de MIRAR (versión nueva, fuente bloqueada o divergida, origin cambiado) se conserva mientras un arranque
    // no vuelva a mirar: sin mirar no se sabe si se resolvió (revisor de fallos silenciosos, iteración 2). Lo que cada
    // arranque re-evalúa sí o sí —el aplicador, la política, el respaldo en shell— no se arrastra.
    // («la actualización … no quedó sana» también: lo que falló es el aplicador, y el aplicador corre en cada arranque —
    // revisor de fallos silenciosos, iteración 3)
    // (la retención y el intento fallido de la tanda C también: salen del estado en cada arranque)
    let keepFromLastLook = Boolean(state.notice && !REEVALUATED_NOTICE.test(state.notice));
    let fetched = false;
    const policy = policyOf(ctx, tree);
    state.policy = { channel: policy.channel, apply: policy.apply, enabled: policy.enabled };
    if (policy.errors.length) { log(`startup: política inválida: ${policy.errors.join(' · ')}`); notice = `la política de actualización está mal escrita (${policy.errors[0]}): no se actualiza hasta arreglarla`; }
    // el canal del estado es el de la configuración (A9): pudo cambiar por la variable, por el archivo a mano o por el
    // perfil. Si cambió, este arranque mira (las ventanas quedaron sueltas) y lo que dejó la mirada del canal anterior
    // no se arrastra (causa E)
    else if (applyPolicy(ctx, state, policy).channelChanged) { keepFromLastLook = false; log(`startup: el canal vigente cambió a ${policy.channel}: se vuelve a mirar`); }

    // la copia ANTES de tocar nada (AC 17): cubre la migración, la actualización y el aplicador de este arranque; si el
    // conjunto es el mismo de la copia anterior —lo normal entre dos sesiones— no se crea otra
    const snap = takeSnapshot(ctx, tree, { reason: 'startup', from: state.version && state.version.number, log, state });

    // 0. la línea de arranque vieja que haya quedado en una máquina que ya tiene estado (AC 7: «el aplicador o startup»)
    try {
      const SL = mod('startup-line');
      const m = SL.migrate(settingsPath(ctx), { home: ctx.home, platform: ctx.platform, nodeOk: true, nodeVersion: process.versions.node, backup: !snap });
      if (m.changed) log(`startup: ${m.reason}`);
    } catch (e) { log(`startup: la migración de la línea de arranque falló: ${e.message}`); }

    // 0b. una comprobación de salud que quedó PENDIENTE (la sesión anterior murió después de mover los árboles y antes de
    // terminarla): se corre ahora, y si no pasa, la versión vuelve sola como siempre (pase adversarial H18)
    if (state.failed && state.failed.pending === 'health' && state.mode !== 'developer') {
      const f = state.failed;
      log(`startup: la comprobación de salud de ${f.commit} quedó pendiente: la corro ahora`);
      const rec = preloadRecovery(log);
      const pick = rec.rollback ? rec.rollback.pickTarget(mod('snapshot').list(ctx.home), { currentSources: currentSources(ctx, state) || {} }) : null;
      const copy = pick && pick.copy && !pick.filesOnly ? pick.copy : null;
      const u = finishHealth(ctx, state, { snap: copy ? { dir: copy.dir } : null, rec, before: copy ? copy.manifest.from : '—', after: f.commit, tips: f.sources, report: Array.isArray(state.managed) ? state.managed : [], applierOut: (Array.isArray(f.applier_failed) ? f.applier_failed : []).join('\n'), log });
      if (u.status === 'failed') { notice = state.notice; line = u.lines[0]; }
      log(`startup: salud pendiente: ${u.lines.join(' · ')}`);
    }

    // 1. engram, sólo con la integración prendida
    if (engramOn(ctx, tree) && findInPath('engram', ctx.env)) {
      const e = spawnSync('engram', ['sync', '--import'], { windowsHide: true, encoding: 'utf8', env: ctx.env, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
      if (e.status !== 0) log(`startup: engram sync --import salió ${e.status === null ? 'matado' : e.status}`);
    }

    // 1b. la llave de la transición a un solo repo (story 8.18): re-apuntar el clon viejo de skills, o deshacerlo, ANTES
    // de mirar si hay versión nueva. Con la política en `ask` no se muda sola: queda el aviso. Si ese clon no pudo pasar,
    // en este arranque no se mueve NINGUNA fuente (AC 32)
    let repointHeld = false;
    if (state.mode !== 'developer' && policy.enabled && !policy.errors.length) {
      const rp = runRepoint(ctx, state, policy, { log, apply: policy.apply === 'auto' });
      if (rp.lines.length) line = line || rp.lines[0];
      if (rp.notice) notice = notice || rp.notice;
      repointHeld = !rp.proceed;
    }

    // 1c. la mudanza a ~/.tycon por la llave del perfil (story 8.23, tanda D · AC 32): `install.home: tycon` muda esta
    // máquina sola, una vez, acá adentro (aparte del hook y con el candado). Una precondición que falla se avisa y se vuelve
    // a intentar en cada sesión; un fallo DURANTE deshace, queda `failed` y no se reintenta solo (migrate --to-home a mano)
    if (state.mode !== 'developer' && policy.enabled && !policy.errors.length && !repointHeld && !(state.migrate_home && state.migrate_home.status === 'failed')) {
      const MH = mod('move-home');
      const want = MH.homeKey(ctx, tree, { log: (l) => log(`startup: ${l}`) });
      if (want === 'tycon') {
        const m = MH.migrate(ctx, migrateHelpers(ctx), { log: (l) => log(`startup: ${l}`), auto: true, state });
        if (m.migrated) {
          // la máquina ya es una versión bajada y el estado lo escribió la mudanza: este arranque termina acá
          log(`startup: ${m.lines.join(' · ')}`);
          finishSnapshot(ctx, snap, log);
          return say(m.lines[0]);
        }
        if (m.precondition) notice = notice || `mudanza a ~/.tycon pendiente (install.home: tycon): ${m.lines[0].replace(/^harness\.js migrate: /, '')}`;
        else if (m.failed) notice = notice || m.notice;
      } else if (want === null) log('startup: install.home no se pudo leer (configuración rota): la mudanza no se decide');
    }

    // 2. update según la política (y sin salir a la red si se miró hace poco: 10 min en auto, 6 horas en ask — AC 26)
    const treeBefore = mod('sources').head(tree, { env: ctx.env });
    if (state.mode === 'developer') log(`startup: modo desarrollador (${tree}): no se actualiza`);
    else if (!policy.enabled) log('startup: TYCON_UPDATE=0: sin actualización');
    else if (policy.errors.length) { /* ya anotado */ }
    else if (repointHeld) log('startup: el clon de skills no pudo pasar (la llave update.skills_source): no se actualiza ninguna fuente en este arranque');
    else {
      const window = FETCH_WINDOW_MS[policy.apply] || FETCH_WINDOW_MS.auto;
      const sinceLook = Date.now() - (Date.parse(state.last_fetch || '') || 0);
      const sinceTry = Date.now() - (Date.parse(state.last_fetch_failed || '') || 0);
      if (sinceLook < window) log(`startup: última mirada a la red hace menos de ${policy.apply === 'ask' ? '6 horas (política ask)' : '10 min'}: sin fetch`);
      else if (sinceTry < FETCH_RETRY_MS) log('startup: el último intento de mirar (que no pudo) fue hace menos de 10 min: sin fetch');
      else {
        fetched = true;
        const u = doUpdate(ctx, state, { mode: policy.apply === 'auto' ? 'apply' : 'check', log, snapshot: snap, policy });
        // story 8.23, tanda L (AC 39): mirar y quedar al día (o aplicar) borra la falla; no poder mirar o aplicar la anota
        if (['new', 'applied', 'up_to_date'].includes(u.status)) R.clearUpdateFailure(ctx.home);
        else if (!['held', 'skipped'].includes(u.status)) R.recordUpdateFailure(ctx.home, String(u.lines[0] || u.status).replace(/^harness\.js update: /, ''));
        if (u.status === 'new') {
          // el aviso que el hook síncrono le imprime a la persona en la sesión siguiente (AC 26): qué versión, cómo
          // aplicarla y dónde ver los cambios (también es la única línea de este arranque, como desde la tanda A)
          const text = availableText(state, policy, u);
          notice = notice || text; log(`startup: ${text}`); line = text;
        } else if (u.status === 'applied') {
          line = u.lines[0]; log(`startup: ${u.lines.join(' · ')}`);
          // las piezas de un paquete que salieron: se le dicen a la persona en la sesión siguiente
          const pl = u.lines.find((l) => PACK_RETIRED_RX.test(l));
          if (pl) notice = notice ? `${notice} · ${pl}` : pl;
        }
        else if (u.status === 'up_to_date') { if (u.older) log(`startup: ${u.lines.join(' · ')}`);   /* si no, nada que decir */ }
        else if (u.status === 'failed') { notice = notice || state.notice; line = u.lines[0]; log(`startup: ${u.lines.join(' · ')}`); }
        else if (u.status === 'held' || u.status === 'skipped') log(`startup: ${u.lines.join(' · ')}`);   // el aviso sale del estado, abajo
        else if (u.status === 'busy') log(`startup: ${u.lines.join(' · ')}`);
        else if (u.status === 'unknown' && /sin red/.test(u.lines[0])) { log(`startup: ${u.lines.join(' · ')}`); line = 'arnés: sin red, no se actualizó'; }
        else {
          // bloqueada, divergida, otra rama, o un «no pude mirar» que no es la red (el origin cambió): la persona tiene que
          // enterarse —la línea de arranque es async y su stdout no llega a la conversación— (pase adversarial, clase 27)
          log(`startup: ${u.lines.join(' · ')}`);
          notice = notice || u.lines[0].replace(/^harness\.js update: /, '');
          line = u.lines[0];
        }
      }
    }

    // 2b. el perfil de instalación (story 8.16, tanda C · AC 26 y 27): si cambió por el archivo o la variable desde la
    // última vez, este arranque lo aplica —copia nueva `reason: profile`, el aplicador en el perfil nuevo, y se quita lo
    // registrado que su reporte ya no trae—, sin preguntar. Roto: lo del perfil queda como está, y el aviso lo dice
    const sw = profileSwitch(ctx, state, tree, log);
    if (sw.notice) notice = notice || sw.notice;

    // 3. el aplicador, SIEMPRE (idempotente; de él cuelgan las tareas diarias), y el registro de lo que dejó (AC 15-16)
    const a = runApplier(ctx, tree, { log, snapshotDir: (sw.snap || snap) && (sw.snap || snap).dir });
    state.last_apply = nowIso();
    if (!a.ok) {
      const text = `el aplicador falló (${a.reason}): detalle en ${S.paths(ctx.home).log}`;
      notice = notice || text; log(`startup: ${text}`); line = line || text;
    } else {
      const dropped = sw.switching ? dropForProfile(ctx, state, tree, a, (l) => log(`startup: ${l}`), sw.profile.value) : true;
      if (sw.switching) profileSwitchNotes(dropped).forEach((n) => log(`startup: ${n}`));
      recordPieces(ctx, state, a.report, a.shared);
      { const pl = packRetiredLine(a); if (pl) { log(`startup: ${pl}`); notice = notice ? `${notice} · ${pl}` : pl; } }
      // el `@import` del índice: si falta (una vuelta atrás de otra versión lo quitó, 2026-10-07), se repone acá, en cada
      // arranque, como la pieza propia que es; nadie más lo reponía y la máquina quedaba sin las guías cargadas. Con una
      // forma vieja (el README.md que era el índice), la pasa a la de hoy
      if (state.mode !== 'developer') { try { if (ensureImport(ctx)) log('startup: el @import del índice faltaba en CLAUDE.md: repuesto'); } catch (e) { log(`startup: no pude reponer el @import (${e.message})`); } }
      // sin saber qué sobraba, el perfil de antes queda anotado y el próximo arranque lo reintenta (clases 7 y 14)
      if (sw.profile && sw.profile.ok && dropped !== null) state.profile = { value: sw.profile.value, origin: sw.profile.origin };
      if (ctx.opts.force) {
        // 4. `--force` repite la comprobación de salud entera (tanda C, AC 21) aunque nada cambió; si falla, lo dice (no
        // hay versión nueva que deshacer: `rollback` es de la persona)
        const h = runHealth(ctx, state, { report: a.report, applierOut: a.out, log });
        if (h.ok) state.last_health = nowIso();
        else { const text = `la comprobación de salud no pasó (${h.failures[0]}): harness.js doctor lo detalla; para volver a la versión anterior, harness.js rollback`; notice = notice || text; line = line || text; log(`startup: ${h.failures.join(' · ')}`); }
      } else if (mod('sources').head(tree, { env: ctx.env }) !== treeBefore) {
        // el árbol cambió por otro camino que update (que ya corrió su salud): la salud mínima, el aplicador salió 0
        state.last_health = nowIso();
      }
    }
    // la retención y el intento fallido se dicen en CADA arranque mientras duren (salen del estado, no de este arranque)
    if (!notice && state.hold) notice = holdText(state);
    // una falla de `install` (story 8.16, AC 9) no es una actualización que volvió atrás: no se movió nada, y lo que la
    // retoma es `install` otra vez
    if (!notice && state.failed && state.failed.stage === 'install') notice = `la instalación quedó a medias (${state.failed.reason === 'applier' ? 'el aplicador falló' : 'la comprobación de salud no pasó'}, ${state.failed.at || '—'}): node ~/.claude/${PLACE.PLACE_NAME}/scripts/setup/harness.js install otra vez la retoma — harness.js doctor lo detalla`;
    if (!notice && state.failed) notice = `la versión ${state.failed.commit} no quedó sana (${state.failed.reason || 'salud'}, ${state.failed.at || '—'}) y volvió sola a ${state.version && state.version.number}; ${state.failed.reason === 'interrupted' ? 'se reintenta en el próximo arranque' : `no se reintenta sola hasta que cambie la punta (o ${applyHint})`} — harness.js doctor lo detalla`;
    if (!notice && keepFromLastLook && !fetched && policy.enabled && state.mode !== 'developer') notice = state.notice;
    // una herramienta instalada y sin enchufar (story 8.23, tanda C · AC 24): se dice en cada arranque, sin pisar otro
    // aviso; se enchufa en la próxima instalación, no sola
    { const tn = toolNotice(ctx, tree, state); if (tn) notice = notice ? `${notice} · ${tn}` : tn; }
    // el aviso de finales de línea de este arranque (árbol sucio, o el paso falló), al final y sin pisar otro (B2)
    if (ctx.eolNotice) notice = notice ? `${notice} · finales de línea: ${ctx.eolNotice}` : `finales de línea: ${ctx.eolNotice}`;
    // el Node del arnés (story 8.39, AC 11): mientras no lo pudo bajar, se dice en cada arranque, sin pisar otro aviso
    notice = harnessNodeNotice(notice, a);
    // la carpeta global de hooks de git (2026-10-14): con `auto` la pone este arranque y lo dice una vez; con `ask`, el
    // aviso la pide. Sólo con el aplicador sano (el pre-push tiene que estar en su lugar)
    if (a.ok) notice = hooksPathUnattended(ctx, state, tree, policy, { mode: 'startup', log: (l) => log(`startup: ${l}`), notice }).notice;
    else notice = mod('git-hooks-path').stripNotices(notice);
    if (notice) R.setNotice(state, notice); else R.clearNotice(state);
    S.write(ctx.home, state);
    // este arranque tuvo el candado y llegó al final: lo anotado por «candado ocupado» ya no vale (AC 39; lo de la red
    // lo borra sólo una mirada sana, más arriba)
    R.clearUpdateFailure(ctx.home, { kind: 'busy' });
    finishSnapshot(ctx, snap, log);
    finishSnapshot(ctx, sw.snap, log);
    return say(line);
  }, { env: ctx.env, onBusy: (lock) => {
    log(`startup: ${lock.reason} — me voy`);
    // el que se va sin poder actualizar lo anota (AC 39) si el otro lo tiene hace rato (un choque de dos sesiones que
    // arrancan juntas no es una falla); desde el segundo arranque así, lo dicen el aviso y doctor
    if (R.busyIsFailure(lock)) R.recordUpdateFailure(ctx.home, `${lock.reason} hace ${Math.round(lock.ageMs / 60000)} min`, { kind: 'busy' });
    return say();
  } });
}

function cmdUpdate(ctx) {
  const S = mod('state'), L = mod('lock'), R = mod('report');
  const need = needState(ctx);
  if (need.fail) return { code: need.fail.code, lines: [need.fail.line] };
  const log = (l) => R.log(ctx.home, l);
  if (need.state.mode === 'developer') return { code: 0, lines: [`modo desarrollador: ${need.state.tree}; actualizar es tuyo (link --managed vuelve a managed)`] };
  // la versión bajada (story 8.23, tanda B): mira la API y cambia la carpeta con diario; sin git
  if (S.isRelease(need.state)) {
    return L.withLock(ctx.home, () => {
      const r = loadState(ctx);
      if (r.status !== 'ok') { const f = S.fail(r, { home: ctx.home }); return { code: f.code, lines: [f.line] }; }
      return mod('release').cmdUpdate(ctx, r.state, releaseHelpers(ctx), { log });
    }, { env: ctx.env, onBusy: busy });
  }
  if (ctx.opts.check) {
    // sólo mira (nada se graba): con el canal de la política vigente, que decide la ref de lo que se reescribe
    const policy = policyOf(ctx, need.state.tree);
    if (!policy.errors.length) applyPolicy(ctx, need.state, policy);
    const u = doUpdate(ctx, need.state, { mode: 'check', log, persist: false, policy: policy.errors.length ? null : policy, startedAt: commandClockStart(ctx.env) });
    return { code: u.code, lines: u.lines };
  }
  // (story 8.16, tanda B · AC 18) con la política `ask`, sin `--yes` y CON terminal: antes de tomar el candado se mira (como
  // `--check`, sin grabar nada), se dice qué fuentes se mueven y qué cambia en el comportamiento, y se pregunta. Con sí se
  // sigue el camino de aplicar SIN levantar la retención ni reintentar un intento fallido (eso es de `--yes`); con no, la
  // salida de siempre. Sin terminal, nada de esto: igual que la tanda D de la 8.13.
  let asked = null;
  if (!ctx.opts.yes && !ctx.opts['dry-run'] && mod('prompt').isTerminal()) {
    const policy = policyOf(ctx, need.state.tree);
    if (!policy.errors.length && policy.enabled && policy.apply === 'ask') {
      const look = JSON.parse(JSON.stringify(need.state));
      applyPolicy(ctx, look, policy);
      const u = doUpdate(ctx, look, { mode: 'check', log, persist: false, policy });
      if (u.status === 'new') {
        const changes = u.available && u.available.changes ? [`cambios: ${u.available.changes}`] : [];
        process.stdout.write(`${[...u.lines, ...changes, ...behaviorDiff(ctx, look, u)].join('\n')}\n`);
        asked = mod('prompt').ask('¿Aplico ahora? [s/N] ');
      }
    }
  }
  return L.withLock(ctx.home, () => {
    const r = loadState(ctx);
    if (r.status !== 'ok') { const f = S.fail(r, { home: ctx.home }); return { code: f.code, lines: [f.line] }; }
    const state = r.state;
    const policy = policyOf(ctx, state.tree);
    if (policy.errors.length) return { code: 2, lines: [`harness.js update: la política de actualización está mal escrita: ${policy.errors.join(' · ')}`] };
    // TYCON_UPDATE=0 apaga del todo (AC 3 y 12): tampoco --yes actualiza (revisor de alcance, iteración 1)
    if (!policy.enabled) return { code: 0, lines: ['TYCON_UPDATE=0: la actualización está apagada del todo (sacá la variable para actualizar)'] };
    const mode = ctx.opts['dry-run'] ? 'dry-run' : (policy.apply === 'ask' && !ctx.opts.yes && asked !== true ? 'check' : 'apply');
    // con la política en `ask`, `--yes` es la decisión de una PERSONA: pide una terminal (AC 26). Sin ella —la herramienta
    // Bash de un agente— no aplica nada; quien quiere que se aplique sin nadie delante lo dice en la configuración
    // (`apply: auto`). Es un escalón contra el descuido, no una barrera: una terminal se puede fabricar.
    if (ctx.opts.yes && mode === 'apply' && policy.apply === 'ask' && !process.stdin.isTTY) {
      return { code: 2, lines: ['harness.js update: `--yes` necesita una terminal, o `apply: auto` en la configuración (la política es «ask»: aplicar una versión nueva lo decide una persona)'] };
    }
    applyPolicy(ctx, state, policy);
    // `--yes` levanta la retención de un rollback y aplica, también sobre puntas que ya fallaron (tanda C, AC 19 y 21)
    const lifted = [];
    if (ctx.opts.yes && mode === 'apply' && state.hold) { lifted.push(`retención levantada (había deshecho ${state.hold.commit})`); state.hold = null; }
    // story 8.18: la llave, antes de mirar si hay versión nueva. A mano se reintenta siempre; si el clon de skills no
    // pudo pasar no se mueve ninguna fuente (AC 32), y el aviso queda para el hook síncrono
    let rp = runRepoint(ctx, state, policy, { log, manual: true, apply: mode === 'apply', dryRun: mode === 'dry-run' });
    // «no avanza en línea recta», pedido a mano: si lo publicado ya lo arregla, primero el arnés y la mudanza otra vez
    let harnessFirst = null;
    if (!rp.proceed && rp.cause === 'not-fast-forward' && mode === 'apply') {
      harnessFirst = unblockStraightLine(ctx, state, policy, { log, yes: Boolean(ctx.opts.yes) });
      if (harnessFirst && harnessFirst.status === 'applied') {
        rp = runRepoint(ctx, state, policy, { log, manual: true, apply: true });
        rp.lines = [...harnessFirst.lines, ...rp.lines];
      } else if (harnessFirst && harnessFirst.status !== 'up_to_date') rp.lines = [...rp.lines, ...harnessFirst.lines];
    }
    const RPm = repointModule(null);
    if (mode !== 'dry-run' && state.notice && RPm && RPm.NOTICE.test(state.notice)) R.clearNotice(state);
    // el aviso de lo que no pasó queda para el hook síncrono; también el de «sin constancia», que no frena y sigue valiendo
    if (mode !== 'dry-run' && rp.notice && (!rp.proceed || rp.status === 'waiting' || rp.status === 'blocked')) R.setNotice(state, rp.notice);
    if (!rp.proceed) {
      S.write(ctx.home, state);
      return { code: 2, lines: rp.lines.map((l) => (/^harness\.js update: /.test(l) ? l : `harness.js update: ${l}`)) };
    }
    // el tope corre desde que arrancó el comando (C7); si se le preguntó a la persona, desde que contestó
    const u = doUpdate(ctx, state, { mode, log, yes: Boolean(ctx.opts.yes), policy, startedAt: asked === null ? commandClockStart(ctx.env) : null });
    // el arnés ya avanzó en este mismo comando: «arnés al día» después de «arnés X → Y» no dice nada
    if (harnessFirst && harnessFirst.status === 'applied' && u.status === 'up_to_date') u.lines = u.lines.filter((l) => l !== 'arnés al día');
    if (rp.lines.length) u.lines = [...rp.lines, ...u.lines];
    if (u.status === 'applied') {
      R.clearNotice(state);
      // dónde quedó la copia de antes y cómo volver (story 8.16, AC 8). Sólo `update` lo dice: `startup` sigue en una línea
      if (u.backup) u.lines = [...u.lines, R.updateBackupLine(u.backup)];
    }
    // esta corrida MIRÓ y selló la mirada: el aviso del estado queda como lo dejaría el arranque que mira (causa F). Con
    // versión nueva que no se aplica (`ask` sin `--yes`), el mismo «disponible» —si no, con la ventana de 6 horas el hook
    // de arranque no la recuerda—; «al día», sin el aviso que dejó una mirada anterior. Lo que no sale de mirar no se toca
    else if (mode === 'check' && u.status === 'new') R.setNotice(state, availableText(state, policy, u));
    else if (u.status === 'up_to_date' && state.notice && !REEVALUATED_NOTICE.test(state.notice)) R.clearNotice(state);
    // una mirada sana a mano borra la falla anotada por arranques anteriores, como lo hace el arranque (2026-10-15)
    if (mode !== 'dry-run' && ['new', 'applied', 'up_to_date'].includes(u.status)) R.clearUpdateFailure(ctx.home);
    if (lifted.length) u.lines = [...lifted, ...u.lines];
    // la carpeta global de hooks de git (2026-10-14): un update que aplica la pone si falta (el aviso de `ask` la pedía)
    if (mode === 'apply' && !['failed', 'busy'].includes(u.status)) {
      const hp = hooksPathUnattended(ctx, state, state.tree, policy, { mode: 'update', log: (l) => log(`update: ${l}`), notice: state.notice });
      if (hp.line) u.lines = [...u.lines, ...hp.line.split('\n')];
      if (hp.notice) R.setNotice(state, hp.notice); else R.clearNotice(state);
    }
    S.write(ctx.home, state);
    if (mode === 'check' && u.status === 'new') {
      // la persona ya vio las fuentes y la diferencia arriba, y contestó que no: sólo la línea de siempre
      if (asked === false) return { code: 3, lines: [`la política es «ask»: aplicá con ${applyHint}`] };
      const changes = u.available && u.available.changes ? [`cambios: ${u.available.changes}`] : [];
      return { code: 3, lines: [...u.lines, ...changes, `la política es «ask»: aplicá con ${applyHint}`] };
    }
    return { code: u.code, lines: u.lines };
  }, { env: ctx.env, onBusy: busy });
}

/**
 * Qué cambia en el comportamiento con la versión nueva (story 8.16, AC 18): la lista de efectos instalada contra la de
 * la versión nueva del arnés, leída con `git show <commit nuevo>:scripts/setup/install-effects.json`. Si el arnés no se
 * mueve (sólo las skills) o alguna de las dos no se puede leer, lo dice.
 */
function behaviorDiff(ctx, state, u) {
  const M = mod('managed'), PL = mod('plan');
  const head = 'qué cambia en el comportamiento:';
  const h = (u.fresh || []).find((x) => x && x.src && x.src.name === 'harness' && x.c && x.c.to);
  if (!h) return [`${head} el arnés no se mueve en esta versión (sólo cambian las skills)`];
  const before = M.readEffects(state.tree);
  if (!before.ok) return [`${head} no pude leer la lista de efectos instalada (${before.reason})`];
  const rel = M.EFFECTS_FILE.split(path.sep).join('/');
  const r = spawnSync('git', ['-C', h.src.dir, 'show', `${h.c.to}:${rel}`], { windowsHide: true, encoding: 'utf8', env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) return [`${head} no pude leer la lista de efectos de la versión nueva (${(r.stderr || '').trim().split('\n')[0] || `git salió ${r.status}`})`];
  let doc;
  try { doc = JSON.parse(String(r.stdout).replace(/^﻿/, '')); } catch (e) { return [`${head} la lista de efectos de la versión nueva es ilegible (${e.message})`]; }
  const problems = M.effectProblems(doc);
  if (problems.length) return [`${head} la lista de efectos de la versión nueva no pasa su validación (${problems[0]})`];
  return PL.describeEffectsDiff(PL.effectsDiff(before.effects, doc.effects));
}

function cmdApply(ctx) {
  const S = mod('state'), L = mod('lock'), R = mod('report');
  const need = needState(ctx);
  if (need.fail) return { code: need.fail.code, lines: [need.fail.line] };
  // `apply --dry-run` (story 8.16, AC 17): lo que el aplicador cambiaría ahora, con la forma del plan de install, sin
  // candado ni escritura. `apply` solo no pregunta nada: es lo que hace cada arranque
  if (ctx.opts['dry-run']) {
    const tree = need.state.tree;
    const ap = applierPlan(ctx, tree);
    if (!ap.ok) return { code: 2, lines: [`harness.js apply: no pude armar el plan: ${ap.reason}`] };
    const eff = mod('managed').readEffects(tree);
    const PL = mod('plan');
    // un cambio de perfil pendiente (story 8.16, AC 26; pase adversarial de la tanda C, clases 5 y 9): `apply` quita lo
    // registrado que el perfil nuevo no trae; el plan lo muestra en «quita:» y lo dice arriba
    const own = [];
    const profNote = [];
    const prof = profileOf(ctx, tree);
    if (!prof.ok) profNote.push(`ojo: el perfil de instalación no se pudo leer (${prof.reason}): lo del perfil queda como está`);
    else if (mod('profile').installedValue(need.state) !== prof.value) {
      profNote.push(`el perfil de instalación pasa de ${mod('profile').installedValue(need.state)} a ${prof.value}: apply quita lo que ${prof.value} no trae (con su copia de respaldo)`);
      const staying = (ap.pieces || []).filter((p) => p.action !== 'remove');
      for (const p of mod('profile').toRemove(need.state.managed, staying, (x) => isOwnPiece(ctx, x), { effects: eff.ok ? eff.effects : [], profile: prof.value })) own.push({ kind: p.kind, where: p.where, id: p.id, action: 'remove' });
    }
    const plan = PL.build({ applier: ap, own, effects: eff.ok ? eff.effects : [], home: ctx.home, env: ctx.env, platform: ctx.platform,
      integrations: integrationsOf(ctx, tree), first: false, backupRoot: mod('snapshot').backupsRoot(ctx.home), profile: prof.ok ? prof.value : null });
    // una lista de efectos rota no se lee como «nada cambia en el asistente»: se dice (revisor de alcance, tanda B)
    const effNote = [...profNote, ...(eff.ok ? [] : [`ojo: no pude leer la lista de lo que la instalación cambia (${eff.reason}): el plan no dice qué cambia en cómo trabaja tu asistente`])];
    if (PL.nothingToWrite(plan)) return { code: 0, lines: [`apply --dry-run: el aplicador de ${tree} no cambiaría nada`, ...effNote] };
    return { code: 0, lines: [`apply --dry-run: lo que el aplicador de ${tree} cambiaría ahora (no escribí nada):`, ...effNote, ...PL.describe(plan)] };
  }
  return L.withLock(ctx.home, () => {
    const r = loadState(ctx);
    if (r.status !== 'ok') { const f = S.fail(r, { home: ctx.home }); return { code: f.code, lines: [f.line] }; }
    const log = (l) => R.log(ctx.home, `apply: ${l}`);
    // el cambio de perfil por el archivo o la variable (story 8.16, AC 26): como en startup, con su copia y sin preguntar
    const sw = profileSwitch(ctx, r.state, r.state.tree, log);
    const snap = sw.snap || takeSnapshot(ctx, r.state.tree, { reason: 'apply', from: r.state.version && r.state.version.number, log, state: r.state });
    const a = runApplier(ctx, r.state.tree, { log, snapshotDir: snap && snap.dir, hooksPath: true });
    r.state.last_apply = nowIso();
    const extra = [];
    if (a.ok) {
      r.state.last_health = nowIso();
      const dropped = sw.switching ? dropForProfile(ctx, r.state, r.state.tree, a, log, sw.profile.value) : true;
      if (sw.switching) extra.push(...profileSwitchNotes(dropped));
      recordPieces(ctx, r.state, a.report, a.shared);
      // la carpeta global de hooks de git, si `apply` la puso (doctor manda acá cuando git no tiene ninguna); y si git no
      // la dejó escribir, el aviso con el comando a mano
      const hp = noteHooksPath(r.state, a);
      if (hp) extra.push(hp);
      else if (a.gitHooksPath && a.gitHooksPath.status === 'failed') extra.push(...a.gitHooksPath.line.split('\n'));
      if (sw.profile && sw.profile.ok && dropped !== null) r.state.profile = { value: sw.profile.value, origin: sw.profile.origin };
    }
    S.write(ctx.home, r.state);
    finishSnapshot(ctx, snap, log);
    if (a.ok && (sw.switching || sw.notice)) return { code: 0, lines: [`aplicador corrido desde ${r.state.tree}`, ...(sw.switching ? [`perfil de instalación: ${sw.profile.value} (copia de antes en ${snap ? snap.dir : '—'})`] : []), ...(sw.notice ? [sw.notice] : []), ...extra] };
    return { code: a.ok ? 0 : 1, lines: a.ok ? [`aplicador corrido desde ${r.state.tree}`, ...extra] : [`harness.js apply: ${a.reason}`, ...(a.out ? a.out.split('\n').slice(-5) : [])] };
  }, { env: ctx.env, onBusy: busy });
}

function cmdVersion(ctx) {
  const R = mod('report');
  const need = needState(ctx);
  if (need.fail) return { code: need.fail.code, lines: [need.fail.line] };
  // el canal que se muestra es el de la política vigente (A9), no el que quedó guardado en el último arranque
  const policy = policyOf(ctx, need.state.tree);
  const opts = { env: ctx.env, channel: policy.errors.length ? null : policy.channel };
  const where = PLACE.resolvePlace({ home: ctx.home });   // dónde vive el arnés (story 8.19, AC 19)
  // la versión bajada (story 8.23, tanda B): el número y el commit salen del estado, no de git
  if (mod('state').isRelease(need.state)) {
    const RL = mod('release');
    if (ctx.opts.json) return { code: 0, lines: [JSON.stringify(Object.assign(RL.versionJson(need.state, opts), { place: { path: linkPath(ctx.home), dir: need.state.tree, kind: 'release' } }), null, 2)] };
    return { code: 0, lines: [`${RL.versionLine(need.state, opts)} · arnés en ${tildePath(ctx, need.state.tree)}`] };
  }
  if (ctx.opts.json) return { code: 0, lines: [JSON.stringify(Object.assign(R.versionJson(need.state, opts), { place: placeFacts(ctx, need.state.tree, { count: false }).place }), null, 2)] };
  return { code: 0, lines: [`${R.versionLine(need.state, opts)} · arnés en ${where.path ? tildePath(ctx, where.path) : '(ningún nombre resuelve)'}`] };
}

/**
 * Qué va a pasar con una fuente cuyo HEAD no es el commit registrado, dicho por `doctor`. Tiene que ser CIERTO: sale de
 * las mismas preguntas que se hace `update` (pase adversarial de la tanda D, causa B: antes prometía un re-registro que
 * para las fuentes que se reescriben no ocurría nunca).
 *   · ref fija: como siempre (en la punta de origin se re-registra; con commits propios no se toca);
 *   · ref que se reescribe, parada donde `update` no la mueve: el motivo de `offInstalledBranch`, con su remedio;
 *   · en un commit publicado (nada suyo falta en lo traído de origin): `update` la re-registra;
 *   · con commits que origin no tiene, en `tycon/installed`: no se registran como versión, y la próxima actualización
 *     hace `reset --hard` — quedan en `refs/tycon/previous/<fuente>`.
 */
function movedHeadAdvice(ctx, src) {
  const SRC = mod('sources');
  const rereg = 'harness.js update (o el próximo arranque que salga a la red) lo re-registra';
  if (!src.rewrites) return `si el clon está en la punta de origin, ${rereg}; si tiene commits propios, update no lo toca`;
  const off = SRC.offInstalledBranch(src, { env: ctx.env, home: ctx.home });
  if (off) return `update no lo mueve ni lo re-registra — ${off}`;
  const own = SRC.ownCommits(src.dir, ctx.env);
  if (own === 0) return `es un commit publicado: ${rereg}`;
  const count = own === null ? 'no pude ver si tiene commits' : `tiene ${own} commit(s)`;
  return `${count} que lo último traído de origin no tiene: si son tuyos, update no los registra como versión y la próxima actualización los saca de ${SRC.INSTALLED_BRANCH} (quedan en ${SRC.previousRef(src.name)}) — guardalos antes en una rama tuya (git -C ${src.dir} branch <nombre>)`;
}

// ── dónde vive el arnés (story 8.19, tanda B · AC 19) ───────────────────────────────────────────────────────────────
/** `~/…` para mostrar una ruta de la HOME. */
function tildePath(ctx, p) {
  const h = path.resolve(ctx.home);
  const x = path.resolve(p);
  return x === h ? '~' : (x.startsWith(h + path.sep) ? `~/${x.slice(h.length + 1).split(path.sep).join('/')}` : x);
}
/** Qué es una ruta, sin seguir el enlace: link | folder | file | null. En Windows un junction es un link para Node. */
function kindOf(p) {
  try { const st = fs.lstatSync(p); return st.isSymbolicLink() ? 'link' : (st.isDirectory() ? 'folder' : 'file'); } catch (_) { return null; }
}
/**
 * Los hechos del lugar, sólo leyendo: en qué nombre vive el arnés, cómo está el nombre viejo y cuánto queda registrado
 * por él (con la misma expresión que `--reroot`: `countRegistered` de legacy-names.js del árbol). `count: false` no
 * cuenta (version).
 */
function placeFacts(ctx, tree, { count = true } = {}) {
  const where = PLACE.resolvePlace({ home: ctx.home });
  const place = {
    name: where.via === 'place' ? PLACE.PLACE_NAME : (where.via === 'legacy' ? PLACE.LEGACY_PLACE_NAME : null),
    path: where.path, kind: where.path ? kindOf(where.path) : null, target: where.dir,
  };
  const lp = PLACE.legacyPlacePath(ctx.home);
  const lk = kindOf(lp);
  let legacy = null;
  if (lk) {
    const target = real(lp);
    let direct = null;
    try { direct = lk === 'link' ? path.resolve(path.dirname(lp), fs.readlinkSync(lp)) : null; } catch (_) { direct = null; }
    legacy = {
      path: lp, kind: lk === 'link' && !target ? 'dangling' : lk, target,
      to_place: Boolean(direct && PLACE.samePath(direct, linkPath(ctx.home), ctx.platform)),
      clone: Boolean(target && isHarnessClone(target)),
    };
  }
  let registered = null;
  if (count) {
    const RL = mod('relocate').rerootLib(tree || ctx.tree);
    if (RL.problem) registered = { problem: RL.problem };
    else {
      try {
        registered = RL.lib.countRegistered({ from: lp, home: ctx.home, env: ctx.env, platform: ctx.platform, tree: where.dir || tree });
        // de CLAUDE.md cuenta SÓLO la línea de arranque, que es lo que relocate muda (pase adversarial de la tanda B, C3)
        let md = '';
        try { md = fs.readFileSync(claudeMdPath(ctx), 'utf8'); } catch (_) { md = ''; }
        const lines = md.split('\n').filter((l) => IMPORT.LEGACY_PLACE_FORMS.includes(l.trim())).length;
        if (lines) { registered.files.push({ file: 'CLAUDE.md', count: lines, permissions: 0 }); registered.total += lines; }
      } catch (e) { registered = { problem: e && e.message ? e.message : String(e) }; }
    }
  }
  return { place, legacy, registered };
}
/** Las líneas de doctor sobre el lugar. El conflicto y «ningún nombre resuelve» (rojo) los dice el bloque del enlace. */
function placeItems(ctx, f, add) {
  if (f.place.path && f.place.target) {
    add('ok', `arnés en ${tildePath(ctx, f.place.path)}${f.place.kind === 'folder' ? ' (carpeta: tu clon)' : ''} → ${f.place.target}${f.place.name === PLACE.LEGACY_PLACE_NAME ? ' (por el nombre viejo: el lugar todavía no existe; harness.js install lo crea)' : ''}`);
  }
  const L = f.legacy;
  if (L) {
    const name = tildePath(ctx, L.path);
    if (L.kind === 'dangling') add('warn', `el nombre viejo ${name} está colgado: harness.js install lo repara (o borralo si nada lo usa)`);
    else if (L.kind === 'file') add('ok', `el nombre viejo ${name} es un archivo: no lo toco; los lectores usan el lugar`);
    else if (!L.clone) add('ok', `el nombre viejo ${name} es ${L.kind === 'link' ? `un enlace a ${L.target}` : 'una carpeta'}, que no es un clon del arnés: no lo toco; los lectores usan el lugar`);
    else if (L.to_place) add('ok', `el nombre viejo ${name} sigue andando y apunta al lugar`);
    else if (L.kind === 'folder') add('ok', `el nombre viejo ${name} es una carpeta real (tu clon): no la toco`);
    else add('ok', `el nombre viejo ${name} sigue andando (apunta directo a ${L.target})`);
  }
  const R = f.registered;
  if (!R) return;
  if (R.problem) { add('warn', `lo registrado por el nombre viejo: no pude contarlo (${R.problem})`); return; }
  for (const n of R.notes || []) add('warn', `lo registrado por el nombre viejo: ${n}`);
  if (!R.total) return;
  const list = R.files.map((x) => `${x.file} ${x.count}${x.permissions ? ` (${x.permissions === x.count ? 'permisos' : `${x.permissions} en permisos`})` : ''}`).join(' · ');
  if (R.files.every((x) => x.count === x.permissions)) add('ok', `registrado por el nombre viejo, sólo permisos: ${list} — quedan con las dos formas a propósito; los saca el retiro del nombre viejo`);
  else if (L && L.kind === 'folder' && L.clone) add('ok', `registrado por el nombre viejo, que es tu clon: ${list} — es lo registrado por tu clon; no hay nada que mudar`);
  else if (!L || L.kind === 'dangling') add('warn', `registrado por un nombre que ya no resuelve (${tildePath(ctx, PLACE.legacyPlacePath(ctx.home))}): ${list} — eso está roto; harness.js relocate lo muda al lugar (--check dice qué cambiaría)`);
  else add('ok', `registrado por el nombre viejo: ${list} — sigue andando (el viejo resuelve); se muda a mano con harness.js relocate (--check dice qué cambiaría)`);
}
/** Lo que `doctor --json` suma: `place` siempre; `legacy` y `registered_by_legacy` sólo si el viejo existe o algo lo nombra. */
function placeJson(f) {
  const out = { place: { name: f.place.name, path: f.place.path, kind: f.place.kind, target: f.place.target } };
  const total = f.registered && !f.registered.problem ? f.registered.total : null;
  if (f.legacy || (total !== null && total > 0) || (f.registered && f.registered.problem)) {
    if (f.legacy) out.legacy = { path: f.legacy.path, kind: f.legacy.kind, target: f.legacy.target, to_place: f.legacy.to_place };
    out.registered_by_legacy = f.registered && f.registered.problem ? { status: 'no_medido', reason: f.registered.problem } : { total: total || 0, files: (f.registered && f.registered.files) || [] };
  }
  return out;
}

// ── la capa privada (story 8.13.1, tanda A · AC 5): público + capa = interno, sólo leyendo ──────────────────────────
// La marca del árbol gestionado: `<árbol>/.git/tycon-managed` (la deja la migración de la tanda B; en la tanda A existe
// sólo en un laboratorio). Sólo en ese árbol se mira que no pueda empujar: `pushurl` = no_push y un `pre-push`.
const MANAGED_TREE_MARK = 'tycon-managed';
const NO_PUSH = 'no_push';
// cuántas horas de atraso de la capa al mínimo pasan a ser un aviso (revisión I12)
const LAYER_LAG_WARN_HOURS = 24;

/** Una ruta dentro del `.git` de un clon tal como la usa git (`rev-parse --git-path`), sin pisar `core.hooksPath`: el
 *  `pre-push` que importa es el que git correría de verdad. null si git no contesta. */
function gitPathOf(ctx, dir, what) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--git-path', what], { windowsHide: true, encoding: 'utf8', timeout: 10000, env: Object.assign({}, ctx.env, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }) });
  return r.status === 0 && String(r.stdout).trim() ? path.resolve(dir, String(r.stdout).trim()) : null;
}
/** La fecha de un commit en segundos, o null si el clon no lo tiene. */
function commitTime(ctx, dir, rev) {
  const r = mod('sources').git(dir, ['show', '-s', '--format=%ct', rev], { env: ctx.env, timeout: 10000 });
  const n = r.ok ? parseInt(r.out, 10) : NaN;
  return Number.isFinite(n) ? n : null;
}
/** El clon interno de donde se lee la capa (AC 1, A13): el de `--harness-clone`; si no, mientras la máquina siga en
 *  `source: internal`, el del árbol (que es el clon de la persona); en `source: public`, el de la persona que anotó la capa. */
function harnessCloneOf(ctx, state) {
  if (ctx.opts['harness-clone'] !== undefined) return ctx.opts['harness-clone'];
  if (!state) return null;
  if ((state.source || 'internal') === 'internal') { const h = harnessSource(state); return h ? h.dir : null; }
  const own = mod('state').layerSources(state).find((s) => s.reference);
  return own ? own.reference : null;
}

/**
 * Los hechos de la capa, sin escribir nada (AC 5; los chequeos viven acá, report.js sólo arma el texto y el JSON):
 *   · el clon de lectura tiene el commit de la capa;
 *   · la compatibilidad: ese commit contra la versión pública instalada, por la lista de transformados de version.json
 *     (layer.js computeLayer: una ruta pública con otro contenido que no está en la lista es «capa de otra versión», y
 *     también un archivo que ese commit publica y la copia no trae —lo dice la clasificación del exportador, con las
 *     listas del commit—; un version.json sin la lista no deja apilar);
 *   · la igualdad: cada archivo del commit interno está en el árbol con su contenido —por el hash de git, el que da
 *     ls-tree—, salvo «el público manda» y lo que escribe la máquina. Lo que no está, «falta»; lo distinto que la persona
 *     tocó (otro que el que dejó la capa, según el manifiesto, o un archivo del público), «a mano»; lo distinto que sigue
 *     como lo dejó la capa, o lo del complemento que nunca se apiló, es una capa de otro commit;
 *   · lo no ignorado del árbol (`ls-files --cached --others --exclude-standard`) que no viene del interno: en «sólo
 *     afuera», de los escritores, o «no viene de ninguna fuente»;
 *   · en un árbol gestionado, `pushurl` y `pre-push`;
 *   · con `layer.minimum`, cuántas horas está detrás de `main` interno (ls-remote; la fecha, del clon de lectura).
 */
function layerFacts(ctx, state) {
  const S = mod('state'), SRC = mod('sources'), L = mod('layer');
  const env = ctx.env;
  const tree = state.tree;
  const treeSrc = harnessSource(state);
  const publicCommit = (treeSrc && treeSrc.commit) || 'HEAD';
  // un manifiesto que no está es «todavía no se apiló»; uno ilegible es un problema que se dice (C6)
  const man = readLayerManifest(ctx, state);
  const manifestFile = man.file;
  const manifest = man.ok ? man.data : null;
  const recorded = new Map((manifest ? manifest.files : []).map((x) => [x.path, x]));

  const sources = S.layerSources(state).map((src) => {
    const f = { name: src.name, commit: src.commit || null, dir: src.dir || null, problem: null, compat: null,
      addedPaths: null, overwrittenPaths: null, missing: [], hand: [], stale: [], foreign: [], writers: 0, listProblem: null,
      manifest: manifest ? manifestFile : null, minimum: null };
    if (!man.ok) { f.problem = man.problem; return f; }
    const c = src.dir && src.commit ? SRC.commitState(src.dir, src.commit, { env }) : null;
    if (!c) { f.problem = 'el estado no dice el clon de lectura ni el commit de la capa'; return f; }
    if (c.status === 'absent') { f.problem = `el clon de lectura ${src.dir} no tiene el commit de la capa ${sha7(src.commit)}`; return f; }
    if (c.status !== 'ok') { f.problem = `no pude leer el commit de la capa en ${src.dir} (${c.reason})`; return f; }
    let lists, internal, complement, published;
    try {
      internal = L.readTree(src.dir, src.commit);
      // «sólo afuera»: la lista a mano MÁS lo que el exportador agrega sólo a la copia según la lista blanca de ese commit
      // interno —la misma regla que computeLayer (clases 1 y 15)—
      lists = { wins: L.matcher(L.loadPatterns(L.DEFAULT_LISTS.publicWins)), outside: L.outsideMatcher({ internalDir: src.dir, internalCommit: src.commit, tree: internal }), writers: L.matcher(L.loadPatterns(L.DEFAULT_LISTS.writers)) };
      const r = L.computeLayer({ internalDir: src.dir, internalCommit: src.commit, publicDir: tree, publicCommit });
      f.compat = { ok: r.ok, problem: r.problem, reason: r.reason, otherVersion: r.otherVersion, unpublished: r.unpublished || [] };
      complement = new Set(r.entries.map((e) => e.path));
      if (r.ok || r.problem === 'other-version') {
        const own = r.entries.filter((e) => !lists.writers(e.path));
        f.addedPaths = own.filter((e) => e.kind === 'add').map((e) => e.path);
        f.overwrittenPaths = own.filter((e) => e.kind === 'overwrite').map((e) => e.path);
      }
      // lo que sigue el commit público instalado: viene de la copia (clase 12), y es el contenido al que vuelve un pisado
      // tras un checkout o un reset (clase 8)
      published = L.readTree(tree, publicCommit);
    } catch (e) { f.problem = `no pude calcular la capa: ${e.message}`; return f; }
    const other = new Set(f.compat.otherVersion);
    for (const [p, e] of internal) {
      if (e.type !== 'blob' || lists.wins(p) || lists.writers(p) || other.has(p)) continue;
      const file = path.join(tree, ...p.split('/'));
      let st = null;
      try { st = fs.lstatSync(file); } catch (_) { st = null; }
      if (!st) { f.missing.push(p); continue; }
      let buf = null;
      try { buf = st.isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : (st.isFile() ? fs.readFileSync(file) : null); } catch (_) { buf = null; }
      if (buf && L.gitBlobId(buf, e.blob) === e.blob) continue;
      const rec = recorded.get(p);
      // un pisado que volvió al contenido público (un checkout, un reset): a la capa le falta ese archivo —la capa lo vuelve
      // a pisar—; no es «a mano» (clase 8)
      const pub = published.get(p);
      const backToPublic = Boolean(rec && rec.kind === 'overwrite' && !rec.held && buf && pub && pub.type === 'blob' && L.gitBlobId(buf, pub.blob) === pub.blob);
      if (backToPublic || (rec ? Boolean(buf) && crypto.createHash('sha256').update(buf).digest('hex') === rec.sha256 : complement.has(p))) f.stale.push(p);
      else f.hand.push(p);
    }
    // lo que dejó de ser de la capa y quedó porque está editado a mano: el manifiesto lo marca `held` (layer.js) y sigue
    // siendo «a mano» aunque su carpeta siga excluida y ya no esté en el commit interno (clase 6)
    for (const rec of recorded.values()) if (rec && rec.held && !f.hand.includes(rec.path)) f.hand.push(rec.path);
    f.hand.sort();
    const listed = SRC.git(tree, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { env });
    if (!listed.ok) f.listProblem = listed.timedOut ? 'git no contestó a tiempo' : (String(listed.err).split('\n')[0] || `git salió ${listed.status}`);
    else {
      for (const p of [...new Set(listed.raw.split('\0').filter(Boolean))].sort()) {
        if (lists.writers(p)) { f.writers++; continue; }
        // lo marcado `held` ya se dice como «a mano» (arriba): no se repite como «de ninguna fuente»
        if (internal.has(p) || published.has(p) || lists.outside(p) || (recorded.get(p) && recorded.get(p).held)) continue;
        f.foreign.push(p);
      }
    }
    if (state.layer && state.layer.minimum) {
      const ref = `refs/heads/${src.ref || SRC.MAIN_REF}`;
      const tip = src.url ? SRC.git(src.dir, ['ls-remote', src.url, ref], { env, timeout: SRC.budgetOf(null, env) * 1000 }) : null;
      const tipSha = tip && tip.ok ? (tip.out.split(/\s+/)[0] || null) : null;
      const t0 = commitTime(ctx, src.dir, src.commit);
      const t1 = tipSha ? commitTime(ctx, src.dir, tipSha) : null;
      const m = { hours: null, measured: false, reason: null };
      if (t0 !== null && t1 !== null) Object.assign(m, { hours: Math.max(0, Math.round((t1 - t0) / 3600)), measured: true });
      else {
        m.reason = !tip ? 'la fuente no tiene url' : (!tipSha ? `no pude mirar ${ref} del interno (${tip.timedOut ? 'git no contestó a tiempo' : (String(tip.err).split('\n')[0] || 'sin respuesta')})` : `el clon de lectura todavía no tiene la punta ${sha7(tipSha)}`);
        if (typeof state.layer.lag_hours === 'number') m.hours = state.layer.lag_hours;
      }
      f.minimum = m;
    }
    return f;
  });

  // el árbol gestionado: sólo con su marca
  let managed = null;
  const mark = gitPathOf(ctx, tree, MANAGED_TREE_MARK);
  if (mark && fs.existsSync(mark)) {
    const push = SRC.git(tree, ['config', '--get', 'remote.origin.pushurl'], { env });
    const hook = gitPathOf(ctx, tree, 'hooks/pre-push');
    let hookOk = false;
    try { const st = fs.statSync(hook); hookOk = st.isFile() && (isWin(ctx) || (st.mode & 0o111) !== 0); } catch (_) { hookOk = false; }
    managed = { tree, pushurl: push.ok ? push.out : null, no_push: push.ok && push.out === NO_PUSH, pre_push: hookOk, hook };
  }
  return { tree, sources, managed, lagWarnHours: LAYER_LAG_WARN_HOURS, noPush: NO_PUSH };
}

function cmdDoctor(ctx) {
  const S = mod('state'), SRC = mod('sources'), R = mod('report');
  const read = loadState(ctx);
  const items = [];
  const add = (level, text) => items.push({ level, text });
  // las claves que suma la tanda D de la 8.16 a `--json` (el perfil, las integraciones, el paquete y los frenos): null
  // mientras no se pudieron mirar
  const extra = { profile: null, integrations: null, packs: null, brakes: null };
  // el diagnóstico va SIEMPRE por stdout (también en rojo): `--json` lo consume un programa
  // dónde vive el arnés (story 8.19, AC 19): va también en el JSON (`place` y, si el viejo existe o algo lo nombra,
  // `legacy` y `registered_by_legacy`)
  let facts = null;
  const out = (mode, code) => ({ code, stdout: true, lines: [ctx.opts.json ? JSON.stringify(Object.assign(R.doctorJson({ mode, items, extra }), facts ? placeJson(facts) : {}), null, 2) : R.doctorText({ mode, items })] });
  // los requisitos van primero y SIEMPRE (story 8.17): también sin instalar, que es cuando más falta saberlo
  // Dentro de la comprobación de salud de una actualización (TYCON_HARNESS_HEALTH=1) un requisito que falta es un AVISO:
  // ahí doctor juzga el árbol nuevo, y un `--version` lento o un PATH de sesión corto no pueden tirar abajo una
  // actualización sana ni hacerla volver atrás. Corrido por una persona, es rojo.
  const requirementLevel = ctx.env.TYCON_HARNESS_HEALTH === '1' ? 'warn' : 'fail';
  const requirementItems = () => { for (const r of requirementChecks(ctx, { release: read.status === 'ok' && S.isRelease(read.state) })) add(r.problem ? requirementLevel : 'ok', r.problem || `requisito ${r.name}: ${r.version} (${r.path})`); };
  // la línea de arranque en su forma VIEJA (story 8.17): doctor daba «nada en rojo» en una máquina que no se actualiza
  // sola —en Windows esa línea ni corre: Claude Code lanza los hooks por Git Bash—. `startup` la migra.
  const startupLineItem = () => {
    try {
      const SLd = mod('startup-line');
      const conf = JSON.parse(fs.readFileSync(settingsPath(ctx), 'utf8'));
      const starts = ((conf.hooks && conf.hooks.SessionStart) || []).flatMap((e) => (e && Array.isArray(e.hooks) ? e.hooks : [])).map((h) => (h && typeof h.command === 'string' ? h.command : '')).filter(Boolean);
      const old = starts.filter((c) => SLd.classify(c) || SLd.isSuperseded(c) || (!SLd.isNew(c) && SLd.mentionsHarness(c)));
      if (old.length) add(requirementLevel, `la línea de arranque de ${settingsPath(ctx)} está en una forma vieja (${old.length}): esta máquina no se actualiza sola${isWin(ctx) ? ' (en Windows esa línea no llega a correr)' : ''} — harness.js startup la pasa a la nueva`);
    } catch (_) { /* sin settings.json legible: lo dicen las piezas, más abajo */ }
  };
  if (read.status === 'missing') {
    requirementItems();
    startupLineItem();
    facts = placeFacts(ctx, ctx.tree);
    placeItems(ctx, facts, add);
    add('warn', 'no instalado: harness.js install (primera instalación desde un clon)');
    return out('no instalado', 3);
  }
  if (read.status !== 'ok') { add('fail', `estado ${read.file}: ${read.reason}`); return out(read.state && read.state.mode ? `${read.state.mode} (estado que no sirve)` : 'estado ilegible', 1); }
  const state = read.state;
  const tree = state.tree;
  const env = ctx.env;

  // qué herramientas enchufa esta máquina (story 8.23, tanda C): lo que es de Claude Code —los requisitos del aplicador,
  // el lugar, el aplicador, la línea de arranque— no se le pide a una máquina que no lo enchufa. Un estado sin `tools`
  // (de antes de la tanda C) es Claude Code, como siempre, y no se dice nada nuevo.
  const TOOLS = mod('tools');
  const plugged = TOOLS.plugged(state, { home: ctx.home, env });
  const withClaude = plugged.includes('claude');
  // Node y los demás requisitos del aplicador
  add('ok', `Node ${process.versions.node} (piso ${NODE_FLOOR})`);
  if (withClaude) requirementItems();
  if (TOOLS.recorded(state)) add('ok', `herramientas enchufadas: ${TOOLS.names(plugged)}`);
  // una herramienta instalada y sin enchufar (AC 24): se enchufa en la próxima instalación, no sola; se dice antes
  { const tn = toolNotice(ctx, tree, state); if (tn) add('ok', tn); }
  // la versión bajada (story 8.23, tanda B · AC 17): nada se compara con git; el árbol, contra su manifiesto
  if (S.isRelease(state)) {
    if (!withClaude) add('ok', `el arnés vive en ${tree} (sin Claude Code no hay enlace en su carpeta)`);
    else if (!linkResolvesTo(ctx, tree)) add('fail', `el enlace ${linkPath(ctx.home)} no apunta al árbol ${tree}: harness.js install --version latest lo repone`);
    else add('ok', `el lugar ${linkPath(ctx.home)} → ${tree}`);
    const policy = policyOf(ctx, tree);
    if (policy.errors.length) add('fail', `política de actualización mal escrita: ${policy.errors.join(' · ')}`);
    else add('ok', `política: canal ${policy.channel} (${policy.origins.channel}) · aplicación ${policy.apply} (${policy.origins.apply})${policy.enabled ? '' : ' · TYCON_UPDATE=0'}`);
    for (const it of mod('release').doctorItems(ctx, state, { fetch: Boolean(ctx.opts.fetch), channel: policy.errors.length ? null : policy.channel })) add(it.level, it.text);
    // el clon que esta máquina MANTIENE (story 8.23, tanda D · AC 29). Los avisos de los nocturnos ya no leen de ahí: leen
    // del clon de MANTENIMIENTO (`paths.maintainers`, scripts/lib/night-data.js), que esta misma orden nombra más abajo
    { const mp = mod('tycon-home').maintainedPath({ env }); add('ok', mp ? `clon que esta máquina mantiene: ${mp} (paths.maintained)` : 'sin clon declarado como el que esta máquina mantiene (no mantiene el arnés) — si lo mantenés: harness.js config set paths.maintained <ruta de tu clon>'); }
    if (state.migrate_home && state.migrate_home.status === 'done') add('ok', `mudada a ${tree} el ${state.migrate_home.at || '—'} desde el clon ${state.migrate_home.from || '—'} (que quedó donde estaba)`);
    // el freno de producción de antes de la mudanza (AC 30): anda por los enlaces; reinstalarlo es humano (sudo)
    { const g = mod('move-home').guardStatus({ env }); if (g.installed && g.old) add('warn', `el freno de producción instalado (${g.dir}) es anterior a la mudanza (su origen de confianza no trae el repo de GitHub): sigue andando por los enlaces; cuando puedas, reinstalalo: sudo bash ${path.join(tree, 'scripts', 'production', 'install-guard.sh')}`); }
    if (withClaude) {
      if (fs.existsSync(applierPath(ctx, tree))) add('ok', `aplicador ${applierPath(ctx, tree)}`); else add('fail', `falta el aplicador en ${tree}`);
      startupLineItem();
    }
    // el enchufe de Codex (tanda C): lo que dejó en su carpeta, contra lo que debería haber
    if (plugged.includes('codex')) {
      const cdir = TOOLS.codexHome({ home: ctx.home, env });
      const cpieces = TOOLS.codexPieces({ tree, home: ctx.home, env });
      const has = (id) => cpieces.some((p) => p.id === id);
      // AGENTS.md sólo se exige si algún bloque aplica a esta máquina (perfil `minimal`: ninguno, a propósito; clase 8)
      const blocksApply = (() => { try { const r = require(path.join(tree, 'scripts', 'setup', 'agents-md-blocks.js')).sync({ check: true, quiet: true, home: ctx.home, env: Object.assign({}, env, { TYCON_PLAN_PIECES: '' }) }); return !(r && r.ok && !r.pending && r.present.length === 0); } catch (_) { return true; } })();
      const lacks = ['hooks.json', 'config.toml', 'AGENTS.md'].filter((id) => !has(id) && (id !== 'AGENTS.md' || blocksApply));
      if (lacks.length) add('warn', `enchufe de Codex incompleto en ${cdir}: falta ${lacks.join(', ')} — harness.js apply lo repone`);
      else add('ok', `enchufe de Codex en ${cdir}: ${cpieces.length} piezas (hooks, servidores MCP, reglas en AGENTS.md, skills y revisores)`);
      // story 8.25 (A2b): sin el registro de los revisores de la capa, sus archivos en Codex no se cuentan ni se quitan solos
      if (cpieces.teamRecordProblem) add('warn', cpieces.teamRecordProblem);
    }
    { const t = R.updateFailureText(R.readUpdateFailure(ctx.home)); if (t) add('warn', t); }
    const bs = bootstrapStatus(ctx, tree, state);
    if (bs.missing.length) add('fail', `copia fija de arranque incompleta: faltan ${bs.missing.join(', ')}`);
    else if (bs.vsState.length) add('warn', `copia fija de arranque distinta de lo registrado: ${bs.vsState.join(', ')}`);
    else add('ok', `copia fija de arranque en ${S.paths(ctx.home).bootstrapDir}${bs.vsTree.length ? ` (se refresca con la próxima salud en verde: ${bs.vsTree.length} archivo(s) distintos del árbol)` : ''}`);
    const prof = profileOf(ctx, tree);
    // la línea del perfil de instalación, como en una máquina con clon (story 8.23, tanda G · AC 44 c: con el rótulo del
    // archivo que la máquina lee de verdad)
    if (prof.ok) add('ok', mod('profile').label(prof));
    doctorConfigItems(ctx, tree, state, prof, add, extra);
    // el freno antes de publicar (story 8.26, tanda H1c · AC 65 d): dato o aviso, nunca rojo
    doctorPublishGuardItems(ctx, tree, prof, add, extra);
    // los repos que declara la organización, contra este disco (story 2.21): dato o aviso, nunca rojo
    doctorDeclaredReposItems(ctx, tree, add, extra);
    // el Node propio del arnés (story 8.39): dato o aviso, nunca rojo
    doctorHarnessNodeItems(ctx, tree, add, extra);
    if (state.notice) add('warn', `aviso pendiente: ${state.notice}`);
    if (state.hold) add('warn', `${holdText(state)}`);
    if (state.failed) {
      const f = state.failed;
      const level = env.TYCON_HARNESS_HEALTH === '1' ? 'warn' : 'fail';
      if (f.pending === 'health') add(level, `la comprobación de salud de ${f.commit || '—'} quedó pendiente (${f.at || '—'}): el próximo arranque la corre; ya: harness.js startup --force`);
      else if (f.stage === 'install') add(level, `la instalación quedó a medias: ${f.reason === 'applier' ? 'el aplicador falló' : 'la comprobación de salud no pasó'} (${f.at || '—'}; detalle en ${f.log || S.paths(ctx.home).log}) — harness.js install --version latest otra vez la retoma`);
      else add(level, `última actualización fallida: ${f.commit || '—'} (${f.reason || 'salud'}, ${f.at || '—'}; detalle en ${f.log || S.paths(ctx.home).log}) — no se reintenta sola hasta que cambie la punta; reintentar ya: ${applyHint}`);
    }
    add('ok', `versión ${state.version.number} (bajada) · instalada ${state.version && state.version.installed_at ? state.version.installed_at : '—'}`);
    // sin Claude Code no hay enlace en su carpeta: el lugar del arnés es su árbol
    facts = { place: { path: withClaude ? linkPath(ctx.home) : tree, dir: tree, kind: 'release' } };
    return out('managed (versión bajada)', items.some((i) => i.level === 'fail') ? 1 : 0);
  }
  // el enlace
  const where = PLACE.resolvePlace({ home: ctx.home });
  const legacyReal = real(PLACE.legacyPlacePath(ctx.home));
  const placeReal = real(linkPath(ctx.home));
  if (placeReal && legacyReal && isHarnessClone(placeReal) && isHarnessClone(legacyReal) && !PLACE.samePath(placeReal, legacyReal, ctx.platform)) {
    add('fail', `el lugar ${linkPath(ctx.home)} (→ ${placeReal}) y el nombre viejo ${PLACE.legacyPlacePath(ctx.home)} (→ ${legacyReal}) son clones distintos: elegí uno con install-tycon-hooks.sh --link <ruta>`);
  } else if (!linkResolvesTo(ctx, tree)) add('fail', `el enlace ${linkPath(ctx.home)} no apunta al árbol ${tree} (${where.dir || 'colgado o ausente'}): harness.js install, o link --local`);
  facts = placeFacts(ctx, tree);
  placeItems(ctx, facts, add);
  // la mudanza a ~/.tycon (story 8.23, tanda D): una que falló y se deshizo no se reintenta sola; una cortada, la repara el arranque
  if (state.migrate_home && state.migrate_home.status === 'failed') add('warn', `la mudanza a ~/.tycon falló (${state.migrate_home.reason || '—'}, ${state.migrate_home.at || '—'}) y se deshizo: no se reintenta sola — a mano: harness.js migrate --to-home`);
  { const MH = mod('move-home'); const j = MH.readJournal(ctx); if (j) add('fail', `hay una mudanza a ~/.tycon a medias (${MH.journalPath(ctx)}, etapa «${j.stage}»): el próximo arranque la completa o la deshace`); }
  // la política se lee antes que las fuentes: su canal decide la ref de lo que se reescribe (tanda D), y su llave
  // `update.skills_source`, lo que se dice de los dos clones (8.18)
  const policy = policyOf(ctx, tree);
  // la transición de la 8.18 (AC 28): el aplicador calla en cada arranque, así que el dato se dice acá, una vez. Con la
  // llave en `unified` (AC 31 a 33) lo que se dice es otra cosa: re-apuntado, pendiente, o —en rojo— por qué no pudo pasar
  const separate = separateSkills(ctx, tree);
  const skillsKey = policy.errors.length ? null : policy.skillsSource;
  const RP = repointModule(null);
  if (separate && !(state.repoint && state.repoint.applied) && skillsKey !== 'unified') add('ok', `dos clones: en transición — el árbol ya trae skills/ y agents/, y esta máquina sigue leyéndolas de ${separate} (su clon de agent-skills); nada se mueve hasta que la llave update.skills_source pase a «unified»`);
  // quién hace una mudanza pendiente: el próximo arranque, salvo que la política diga otra cosa
  const repointWhen = state.mode === 'developer' ? 'en modo desarrollador el mecanismo no lo mueve (harness.js link --managed)'
    : !policy.enabled ? 'con TYCON_UPDATE=0 la actualización está apagada: no lo mueve nadie'
      : policy.apply !== 'auto' ? `la política es «ask»: aplicalo con ${applyHint}` : null;
  for (const it of RP ? RP.doctorItems(state, skillsKey, { health: env.TYCON_HARNESS_HEALTH === '1', when: repointWhen, env }) : []) add(it.level, it.text);
  // el aplicador
  if (fs.existsSync(applierPath(ctx, tree))) add('ok', `aplicador ${applierPath(ctx, tree)}`); else add('fail', `falta el aplicador en ${tree}`);
  startupLineItem();
  // «no se pudo actualizar desde» (story 8.23, tanda L, AC 39): un aviso con la fecha y el motivo, no un rojo (la máquina
  // anda con la versión que tiene)
  { const t = R.updateFailureText(R.readUpdateFailure(ctx.home)); if (t) add('warn', t); }
  // las fuentes (las `layer` van aparte, abajo: su `dir` es el clon de lectura, sin árbol de trabajo)
  for (const src of state.sources || []) {
    if (S.kindOf(src) === 'layer') continue;
    if (!SRC.isRepo(src.dir, { env })) { add('fail', `fuente ${src.name}: ${src.dir} no es un clon de git`); continue; }
    const o = SRC.origin(src.dir, { env });
    if (src.url && o !== src.url) add('fail', `fuente ${src.name}: el origen cambió: ${src.url} → ${o || '(ninguno)'}; si es a propósito, harness.js install --source <url>`);
    else add('ok', `fuente ${src.name}: origin ${o || '—'} · ref ${src.ref}${src.rewrites ? ' (se reescribe)' : ''}`);
    const h = SRC.head(src.dir, { env });
    const rewrites = Boolean(src.rewrites) || SRC.isPublicRemote(tree, src.url);
    // rojo: una ref que no se puede LEER no es «no existe» (segunda vuelta de revisores de la tanda D). Sin poder leer la
    // rama del mecanismo —o HEAD— `update` y `rollback` no mueven el clon: se dice acá, antes de que la persona los corra
    const installed = rewrites && state.mode === 'managed' ? SRC.refState(src.dir, `refs/heads/${SRC.INSTALLED_BRANCH}`, { env }) : null;
    if (installed && installed.status === 'problem') add('fail', `fuente ${src.name}: no pude leer refs/heads/${SRC.INSTALLED_BRANCH} en ${src.dir} (${installed.reason}): update y rollback no mueven el clon hasta que esa rama se pueda leer`);
    // rojo (AC 16, T19): lo instalado no es lo registrado —un pull a mano, el respaldo en shell, un commit propio—, y la
    // vuelta atrás de la tanda C se apoya en ese commit
    if (!h) add('fail', `fuente ${src.name}: no pude leer HEAD de ${src.dir} (${SRC.refState(src.dir, 'HEAD', { env }).reason || 'no apunta a ningún commit'}): no se sabe qué hay instalado`);
    else if (state.mode === 'managed' && src.commit && h !== src.commit) add('fail', `fuente ${src.name}: HEAD ${sha7(h)} no es el commit registrado ${sha7(src.commit)} (alguien movió el clon a mano, o arrancó por el respaldo en shell): ${movedHeadAdvice(ctx, Object.assign({}, src, { rewrites }))}`);
    if (ctx.opts.fetch) {
      // sobre una copia de la fuente: doctor no graba nada, y `check` anota la ref que leyó
      const probe = Object.assign({}, src, { rewrites: Boolean(src.rewrites) || SRC.isPublicRemote(tree, src.url) });
      const c = SRC.check(probe, { env, channel: policy.errors.length ? (state.channel || 'stable') : policy.channel });
      if (c.status === 'new') add('warn', `fuente ${src.name}: hay versión nueva (${sha7(c.from)} → ${sha7(c.to)}): ${applyHint}`);
      else if (c.status === 'older') add('warn', `fuente ${src.name}: ${noDowngradeText({ src: { name: 'harness' }, c }, policy.channel)}`);
      else if (c.status === 'unknown') add('warn', `fuente ${src.name}: no pude mirar: ${String(c.reason || '').replace(/^no pude mirar [^:]+: /, '')}`);
      else add('ok', `fuente ${src.name}: al día con origin/${c.ref}`);
      if (c.note) add('ok', `fuente ${src.name}: ${c.note}`);
    }
    // la guarda de la 8.18 (AC 34): lo último traído no trae las skills y por eso no se aplica — con lo que hay en el clon
    const withoutSkills = RP ? RP.withoutSkillsNote(state, src, { env }) : null;
    if (withoutSkills) add('warn', withoutSkills);
  }
  // la capa privada (story 8.13.1, AC 5): público + capa = interno, sólo leyendo. Va en sus propias líneas y en la clave
  // `layer` de --json; no toca las del lugar. Sin fuentes `layer`, nada de esto aparece
  if (S.layerSources(state).length) {
    const lf = layerFacts(ctx, state);
    for (const it of R.layerItems(lf)) add(it.level, it.text);
    extra.layer = R.layerJson(lf);
  }
  // las piezas: lo registrado contra la máquina (AC 16) — sólo lectura
  const M = mod('managed'), SL = mod('startup-line');
  const managed = Array.isArray(state.managed) ? state.managed : [];
  const pieceOpts = { home: ctx.home, env, isStartupLine: SL.isNew };
  const gone = M.missing(managed, pieceOpts);
  const skillsDir = path.join(ctx.home, '.claude', 'agent-skills', 'skills');
  const roots = [...new Set([tree, real(tree), linkPath(ctx.home), PLACE.legacyPlacePath(ctx.home), skillsDir, real(skillsDir)].filter(Boolean))];
  const loose = M.unregistered(managed, Object.assign({ roots, tree }, pieceOpts));
  for (const p of gone) add('warn', `pieza registrada que falta: ${M.describe(p)} — harness.js ${isOwnPiece(ctx, p) ? 'install' : 'apply'} la repone`);
  for (const u of loose) add('warn', `sin registrar: ${u.text} — harness.js apply`);
  if (!managed.length) add('warn', 'sin registro de piezas todavía: harness.js apply lo arma');
  else if (!gone.length && !loose.length) add('ok', `${managed.length} piezas, todas en su lugar`);
  // los hooks del arnés que ya quedaron registrados más de una vez (story 8.18; decisión del dueño, 2026-10-04: «avisa
  // y no toca»): un dato, una vez, con cómo se sacan a mano. No es rojo ni aviso, y nada se escribe (report.js). Un
  // settings.json que está y no se puede leer no es «sin repetidos»: se dice que no se pudo mirar. Si falta, no hay hooks.
  let hookSettings = null, hookSettingsProblem = null;
  try {
    const raw = fs.readFileSync(settingsPath(ctx), 'utf8');
    hookSettings = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) { if (e.code !== 'ENOENT') hookSettingsProblem = e.message; }
  if (hookSettingsProblem) add('warn', `hooks repetidos: no pude mirar — ${settingsPath(ctx)} no se pudo leer (${hookSettingsProblem})`);
  else if (hookSettings) {
    const repeated = R.repeatedHooks(hookSettings, [tree, skillsDir]);
    if (repeated.length) add('ok', R.repeatedHooksText(repeated, settingsPath(ctx)));
  }
  // los controles ESPERADOS contra la máquina (story 8.17, AC 70): la lista del aplicador de esta plataforma para esta
  // configuración. Lo que el aplicador nunca registró no está en `managed`, y lo de arriba no lo ve. Siempre un AVISO,
  // nunca un rojo: la comprobación de salud llama a doctor, y un rojo acá haría volver atrás una actualización sana
  const integrations = (() => {
    try { const cfg = require(path.join(tree, 'scripts', 'lib', 'tycon-config.js')); return cfg.integraciones(cfg.leer({ env, home: ctx.home, arnes: tree })); } catch (_) { return null; }
  })();
  // el perfil de instalación (story 8.16, tanda C · AC 28): se dice con su origen, y lo que el perfil no trae no es un
  // control que falta. Con la configuración rota no se sabe: lo que depende del perfil no se cuenta, y se avisa
  const prof = profileOf(ctx, tree);
  if (prof.ok) add('ok', mod('profile').label(prof));
  else add('warn', `perfil de instalación: no se pudo leer (${prof.reason}) — lo que depende del perfil no se cuenta`);
  doctorConfigItems(ctx, tree, state, prof, add, extra);
  // el freno antes de publicar (story 8.26, tanda H1c · AC 65 d): dato o aviso, nunca rojo
  doctorPublishGuardItems(ctx, tree, prof, add, extra);
  // los repos que declara la organización, contra este disco (story 2.21): dato o aviso, nunca rojo
  doctorDeclaredReposItems(ctx, tree, add, extra);
  // el Node propio del arnés (story 8.39): dato o aviso, nunca rojo
  doctorHarnessNodeItems(ctx, tree, add, extra);
  const controls = M.expectedControls({ platform: ctx.platform, tree, integrations, env, home: ctx.home, profile: prof.ok ? prof.value : null });
  for (const t of controls.problems) add('warn', `controles esperados: ${t}`);
  for (const x of controls.excluded) add('ok', `fuera en Windows: ${x.id} — ${x.reason}`);
  if (controls.missing.length) add('warn', `${controls.missing.length === 1 ? 'falta' : 'faltan'} ${controls.missing.length} de ${controls.expected.length} controles esperados en ${settingsPath(ctx)} (la lista de scripts/${controls.source}): ${controls.missing.map((c) => c.label || `${c.event} ${c.relpath}`).join(', ')} — harness.js apply los registra; si alguno sigue faltando, la salida del aplicador dice por qué${controls.caveat ? ` · ${controls.caveat}` : ''}`);
  else if (controls.listed !== null) add('ok', `controles esperados: ${controls.expected.length}, todos registrados${controls.unknown.length ? ` (${controls.unknown.length} sin poder decidir: ${controls.unknown[0].why})` : ''}`);
  // las copias de seguridad del mecanismo, y los .bak sueltos que NO gestiona (AC 17)
  try {
    const SN = mod('snapshot');
    const copies = typeof SN.list === 'function' ? SN.list(ctx.home) : [];
    add('ok', `copias de seguridad del mecanismo: ${copies.length}${copies.length ? ` (la más reciente: ${path.basename(copies[0].dir || String(copies[0]))})` : ''}`);
    const bak = typeof SN.countBak === 'function' ? SN.countBak({ home: ctx.home, env, tree }) : 0;
    if (bak) add('ok', `${bak} copia(s) .bak sueltas al lado de tus archivos: el mecanismo no las gestiona (no las toca ni las borra)`);
  } catch (e) { add('warn', `copias de seguridad: no pude mirarlas (${e.message})`); }
  // la copia fija de arranque
  const b = bootstrapStatus(ctx, tree, state);
  if (b.missing.length) add('fail', `copia fija de arranque incompleta: faltan ${b.missing.join(', ')} en ${S.paths(ctx.home).bootstrapDir} (harness.js install la repone)`);
  // con una actualización a medias (salud pendiente o en curso) la copia fija puede ser la de la versión que se juzga y
  // el estado el de la anterior: no es una mano ajena, es el corte; la refresca finishHealth al pasar la salud
  else if (b.vsState.length && state.failed && state.failed.pending === 'health') add('warn', `copia fija de arranque: ${b.vsState.join(', ')} difiere de lo registrado en el estado por una actualización cortada (${state.failed.commit || '—'}); se refresca al terminar la comprobación de salud`);
  else if (b.vsState.length) add('fail', `copia fija de arranque: ${b.vsState.join(', ')} difiere de lo registrado en el estado (alguien la tocó; harness.js install la repone)`);
  // sólo la refresca un update que TRAE versión nueva y pasa la salud (finishHealth): el que sólo re-registra el commit
  // de un clon ya al día no corre la salud y la deja como está. `install` la repone del árbol cuando se la pide
  else if (b.vsTree.length) add('warn', `copia fija de arranque vieja respecto del árbol (${b.vsTree.join(', ')}): a propósito, se refresca con la próxima actualización que traiga una versión nueva y pase la comprobación de salud (un update sin versión nueva no la toca); para refrescarla ya: harness.js install`);
  else add('ok', 'copia fija de arranque (bootstrap) al día con el estado y con el árbol');
  // la política
  for (const e of policy.errors) add('fail', `política de actualización: ${e}`);
  if (!policy.errors.length) {
    // un solo criterio de «público» (A1): el origen fijado del arnés está en la lista que trae el árbol. Con otro remoto
    // —un clon interno, o una copia servida desde otro lado— los dos canales son `main` sin reescritura, y se dice (AC 25)
    const publicCopy = isPublicCopy(ctx, state);
    add('ok', `política: canal ${policy.channel} (${policy.origins.channel}) · aplicación ${policy.apply} (${policy.origins.apply})${policy.enabled ? '' : ' · TYCON_UPDATE=0'}${publicCopy ? '' : ` · ${NOT_PUBLIC_NOTE}`}`);
    // «una máquina del equipo sin el perfil» sólo en un clon INTERNO de verdad: un árbol que no trae la lista de remotos
    // públicos (la deja el exportador en la copia). Un fork de la copia, o la copia servida desde una carpeta local, trae
    // la lista y su remoto no está en ella: no es una máquina del equipo, y arriba ya se dijo que su remoto no es el
    // público. (Antes se miraba `version.json`, y después «el remoto no es el público»: a una persona de afuera le salía.)
    const internalClone = SRC.publicRemotes(tree) === null;
    if (internalClone && policy.apply === 'ask' && policy.origins.apply === 'default') add('warn', 'remoto interno con la política en ask: una máquina del equipo sin el perfil (TYCON_PROFILE=0 o perfil no resuelto) — con el perfil, el equipo va en latest + auto');
    // AC 29b: afuera, `latest` + `auto` se recuerda en cada corrida
    if (publicCopy && policy.channel === 'latest' && policy.apply === 'auto') add('warn', `${LATEST_AUTO_REMINDER} (para revisar cada versión antes: update.apply «ask» en ~/.claude/tycon.json, o harness.js channel stable)`);
  }
  if (state.mode === 'developer') add('warn', `modo desarrollador sobre ${tree}: update no toca su git; la versión es la del clon`);
  if (state.notice) add('warn', `aviso pendiente: ${state.notice}`);
  if (state.hold) add('warn', `${holdText(state)}`);
  if (state.failed) {
    const f = state.failed;
    // bajo la comprobación de salud (TYCON_HARNESS_HEALTH=1) un intento registrado es historia, no la salud de este árbol
    const level = env.TYCON_HARNESS_HEALTH === '1' ? 'warn' : 'fail';
    if (f.pending === 'health') add(level, `la comprobación de salud de ${f.commit || '—'} quedó pendiente (la sesión se cortó en el medio, ${f.at || '—'}): el próximo arranque la corre; ya: harness.js startup --force`);
    else if (f.stage === 'install') add(level, `la instalación quedó a medias: ${f.reason === 'applier' ? 'el aplicador falló' : 'la comprobación de salud no pasó'} (${f.at || '—'}; detalle en ${f.log || S.paths(ctx.home).log}) — node ~/.claude/${PLACE.PLACE_NAME}/scripts/setup/harness.js install otra vez la retoma, o harness.js uninstall la saca`);
    else add(level, `última actualización fallida: ${f.commit || '—'} (${f.reason || 'salud'}, ${f.at || '—'}; detalle en ${f.log || S.paths(ctx.home).log}) — ${f.reason === 'interrupted' ? 'se reintenta sola en el próximo arranque' : 'no se reintenta sola hasta que cambie la punta'}; reintentar ya: ${applyHint}`);
  }
  const vsn = R.derive(state, { env });
  add('ok', `versión ${vsn.number}${vsn.stamped ? ' (estampada)' : ''} · instalada ${state.version && state.version.installed_at ? state.version.installed_at : '—'}`);
  const fails = items.filter((i) => i.level === 'fail').length;
  return out(state.mode, fails ? 1 : 0);
}

/**
 * Lo que `doctor` dice de la configuración de la instalación (story 8.16, tanda D · AC 35), sin escribir nada: el aviso
 * de un perfil sin elegir (una instalación anterior a los perfiles, que se comporta como full), las integraciones
 * prendidas y apagadas con su origen, el paquete del stack por defecto, y cuántos controles que frenan están registrados,
 * nombrando los que frenan en cualquier repo. Llena `extra` (las claves de `--json`). Nunca tira.
 */
function doctorConfigItems(ctx, tree, state, prof, add, extra) {
  if (prof.ok) {
    extra.profile = { value: prof.value, origin: prof.origin, chosen: Boolean(prof.chosen) };
    if (!prof.chosen) add('warn', `perfil sin elegir: esta instalación se comporta como full — elegí con node ~/.claude/${PLACE.PLACE_NAME}/scripts/setup/harness.js install --profile minimal|full`);
  }
  try {
    const C = require(path.join(tree, 'scripts', 'lib', 'tycon-config.js'));
    const config = (C.sinAnotar || ((f) => f()))(() => C.cargar({ home: ctx.home, env: ctx.env, arnes: tree }));
    if (!(config.errores && config.errores.length)) {
      const Q = mod('questions');
      const order = Array.isArray(C.LAS_OCHO) ? C.LAS_OCHO : [];
      for (const l of Q.configLines(config, {}, order)) add('ok', l);
      extra.integrations = {};
      for (const k of order) {
        const e = C.estadoIntegracion(config, k);
        extra.integrations[k] = { state: e.estado, origin: e.origen };
      }
      if (config.valores.packs) extra.packs = { value: config.valores.packs.default, origin: config.origenes['packs.default'] };
      // CodeGraph prendido (por la organización o la máquina) y sin el binario: aviso con cómo instalarlo; no frena
      if (config.valores.integraciones && config.valores.integraciones.codegraph === true && !findInPath('codegraph', ctx.env)) {
        const quien = config.origenes['integraciones.codegraph'] === 'perfil' ? 'tu organización usa' : 'esta máquina tiene prendido';
        add('warn', `CodeGraph: ${quien} CodeGraph y esta máquina no lo tiene — instalalo con bash ~/.claude/${PLACE.PLACE_NAME}/scripts/setup/install-codegraph.sh --tool-only (en Windows: pwsh -File ~\\.claude\\${PLACE.PLACE_NAME}\\scripts\\setup\\install-codegraph.ps1 -ToolOnly)`);
      }
    }
  } catch (e) { add('warn', `integraciones y paquete: no pude leer la configuración (${(e && e.message) || e})`); }
  // el perfil de una persona sola, en un repo de esta máquina: amarillo, nunca rojo, y no frena nada
  if (state && state.team && state.team.host === 'local') add('warn', `el perfil de tu equipo vive sólo en esta máquina (${state.team.repo}): no tiene copia de respaldo. Para tenerla, subilo a GitHub o a Azure DevOps (un repo privado vacío, git remote add y git push desde esa carpeta) y después harness.js install --team <dirección del repo>, para que el arnés lo lea de ahí`);
  // los paquetes del árbol: cuáles activa la organización y cuántas de sus skills y agentes están enlazados (story 8.41)
  const ppLib = path.join(tree, 'scripts', 'lib', 'pack-pieces.js');
  if (fs.existsSync(ppLib)) {
    try {
      const PP = require(ppLib);
      const { packs, errores } = PP.listPacks(PP.packsDirOf(tree));
      for (const e of errores) add('warn', `paquete roto: ${e.archivo} (${e.motivo}) — sus skills y agentes no se enlazan`);
      // un paquete activo que falta es rojo aunque no haya ninguno instalado: el pipeline frena por eso, así
      // que doctor no puede dar verde (el caso medido: la actualización borró el paquete y doctor siguió mostrando ✓)
      const org = PP.orgActive({ tree, home: ctx.home, env: ctx.env });
      if (Array.isArray(org.missing) && org.missing.length) add('fail', `paquetes: ${org.error} — ${typeof PP.missingPackHint === 'function' ? PP.missingPackHint(org.origin) : 'sacalo de packs.default o instalalo'}`);
      else if (packs.length) {
        if (org.error) add('warn', `paquetes: ${org.error}`);
        else {
          // la misma lista que enlaza el aplicador (sin los nombres repetidos, que se dicen aparte); un enlace duro cuenta
          const pz = PP.piecesOf({ packsDir: PP.packsDirOf(tree), agentsDir: path.join(tree, 'agents'), coreSkillsDir: path.join(tree, 'skills'), names: org.names });
          for (const e of pz.errores) if (!errores.some((x) => x.archivo === e.archivo && x.motivo === e.motivo)) add('warn', `paquetes: ${e.motivo}`);
          const linked = (side, list) => list.filter((x) => PP.linkedTo(path.join(ctx.home, '.claude', side, x.name), x.src)).length;
          const s = linked('skills', pz.skills); const a = linked('agents', pz.agents);
          const faltan = (pz.skills.length - s) + (pz.agents.length - a);
          extra.pack_pieces = { active: org.names, skills: pz.skills.length, agents: pz.agents.length, missing: faltan };
          add(faltan ? 'warn' : 'ok', `paquetes activos: ${org.names.join(', ') || 'ninguno'} (packs.default ${PP.valueText(org.value)}, ${org.origin}) · enlazadas ${s} de ${pz.skills.length} skills y ${a} de ${pz.agents.length} agentes${faltan ? ` — faltan ${faltan}: harness.js apply los enlaza` : ''}`);
        }
      }
    } catch (e) { add('warn', `paquetes: no pude mirarlos (${(e && e.message) || e})`); }
  }
  try {
    const M = mod('managed'), SL = mod('startup-line');
    const eff = M.readEffects(tree);
    if (!eff.ok) { add('warn', `controles que frenan: no pude leer la lista de efectos (${eff.reason})`); return; }
    const { effectFor } = mod('plan');
    const opts = { home: ctx.home, env: ctx.env, isStartupLine: SL.isNew };
    const registered = (Array.isArray(state.managed) ? state.managed : [])
      .filter((p) => p && p.kind === 'hook' && M.present(p, opts) === true)
      .map((p) => ({ p, e: effectFor(p, eff.effects) }))
      .filter((x) => x.e && x.e.blocks && x.e.blocks !== 'no');
    const name = (id) => String(id).split(/[/:]/).pop();
    const anyRepo = [...new Set(registered.filter((x) => x.e.blocks === 'any-repo').map((x) => name(x.p.id)))];
    extra.brakes = { registered: registered.length, any_repo: anyRepo };
    add('ok', `controles que frenan registrados: ${registered.length}${anyRepo.length ? ` (en cualquier repo: ${anyRepo.join(', ')})` : ''}`);
  } catch (e) { add('warn', `controles que frenan: no pude contarlos (${(e && e.message) || e})`); }
}

/**
 * Los repos que la organización declara, contra los que hay en este disco (story 2.21, decisión G7 · AC 16-17). Vivía
 * como ficha de la página del tablero y comparaba lo que no debía: la lista del árbol instalado (que en una máquina del
 * equipo no trae ninguna) contra la carpeta padre del arnés (que desde la mudanza a ~/.tycon no tiene repos). Es un dato
 * de cada máquina, así que lo dice doctor:
 *   · la lista es la de la ORGANIZACIÓN: `scripts/nightly/dependencies/repos.json` del clon de operaciones que la máquina
 *     declara (`paths.operations`, la clave que guarda `team-config`). Sin esa clave o sin el archivo, es un dato;
 *   · los repos del disco son los de la raíz de `repos-root.js`, hasta profundidad 2 (la forma `<producto>/<repo>` de
 *     `ruta`). Uno cuenta como declarado si su `origin` —leído de .git/config, sin invocar git— apunta al `ado`
 *     (`<proyecto>/<repo>`) de una entrada, sin distinguir mayúsculas y con los espacios decodificados. La carpeta no
 *     importa: `ruta` es una etiqueta (scripts/nightly/dependencies/nightly-dependencies.js, `ubicarRepo`). Una entrada
 *     con `activo: false` cuenta como declarada;
 *   · «con huella del arnés sin declarar»: los del disco con `.tycon/` que ninguna entrada nombra.
 * 🔴 NUNCA en rojo (la comprobación de salud corre `doctor --json`), y bajo la salud (TYCON_HARNESS_HEALTH=1) no corre:
 *    `declared_repos` en null, como `publish_guard`. Fuera de eso, `declared_repos` va siempre en `--json`: con los cuatro
 *    números, o con ellos en null y su `reason`. Nunca tira.
 */
function doctorDeclaredReposItems(ctx, tree, add, extra) {
  if (ctx.env.TYCON_HARNESS_HEALTH === '1') { extra.declared_repos = null; return; }
  const sinMedir = (reason) => { extra.declared_repos = { declared: null, on_disk: null, matched: null, undeclared_with_harness: null, reason }; };
  try {
    let ops = null;
    try { ops = mod('team-config').declaredClones({ env: ctx.env }).operations; }
    catch (e) {
      // «no pude leer la configuración» no es «la máquina no tiene la lista»: se dice
      const t = `no pude leer qué clon de operaciones declara esta máquina (${(e && (e.code || e.name)) || 'error'})`;
      sinMedir(t); add('warn', `repos declarados: ${t}`); return;
    }
    const lista = ops ? path.join(ops, 'scripts', 'nightly', 'dependencies', 'repos.json') : null;
    if (!lista || !fs.existsSync(lista)) {
      const t = 'esta máquina no tiene la lista de la organización; `harness.js team-config` la pide';
      sinMedir(t); add('ok', `repos declarados: no medido — ${t}`); return;
    }
    let entradas;
    try {
      const j = JSON.parse(fs.readFileSync(lista, 'utf8'));
      entradas = j && Array.isArray(j.repos) ? j.repos : (Array.isArray(j) ? j : null);
      if (!entradas) throw new Error('no trae la lista «repos»');
    } catch (e) {
      const t = `no pude leer la lista de la organización (${lista}: ${e instanceof SyntaxError ? 'no es JSON válido' : e.message})`;
      sinMedir(t); add('warn', `repos declarados: ${t}`); return;
    }
    let raiz = null, porQue = null;
    try {
      const RR = require(path.join(tree, 'scripts', 'lib', 'repos-root.js'));
      const r = RR.resolveReposRoot(undefined, { env: ctx.env, home: ctx.home });
      raiz = r && r.root ? r.root : null;
      if (!raiz) porQue = typeof RR.describir === 'function' ? RR.describir(r) : 'sin raíz';
      else if (!fs.existsSync(raiz)) { porQue = `la raíz de repos ${raiz} no existe`; raiz = null; }
    } catch (e) { porQue = `no pude saber dónde están los repos (${(e && (e.code || e.message)) || 'error'})`; }
    if (!raiz) { sinMedir(porQue); add('warn', `repos declarados: ${porQue}`); return; }
    // La identidad de un repo de Azure sale de la pieza que ya la sabe leer en todas sus formas —HTTPS con proyecto, la
    // corta `_git/<repo>`, SSH `v3/…`, visualstudio.com— (scripts/lib/harness-repo.js `identidadAzure`): con una sola
    // forma, los clones por SSH caían en «sin declarar» (pase adversarial de la story 2.21).
    let identidadAzure = null;
    try { identidadAzure = require(path.join(tree, 'scripts', 'lib', 'harness-repo.js')).identidadAzure; } catch (_) { identidadAzure = null; }
    if (typeof identidadAzure !== 'function') { const t = 'el árbol no trae el lector de remotos (scripts/lib/harness-repo.js): no sé comparar los origin'; sinMedir(t); add('warn', `repos declarados: ${t}`); return; }
    const limpio = (s) => { try { return decodeURIComponent(s).toLowerCase(); } catch (_) { return String(s).toLowerCase(); } };
    // Las entradas se cuentan por REPO, no por renglón: repos.json declara un mismo repo dos veces cuando lo audita en
    // dos subcarpetas (`subruta`) o con dos herramientas, y con un mapa de clave a UN índice la segunda pisaba a la
    // primera — «K de D» no llegaba nunca a D (pase adversarial). Una entrada sin `ado` no se puede reconocer en el
    // disco: cuenta como un repo declarado, aparte.
    const declaradas = new Set();
    let sinAdo = 0;
    for (const e of entradas) {
      const p = e && typeof e.ado === 'string' ? e.ado.split('/') : [];
      if (p.length >= 2) declaradas.add(`${limpio(p[0])}/${limpio(p[p.length - 1])}`);
      else sinAdo += 1;
    }
    const totalDeclarados = declaradas.size + sinAdo;
    // el repo de una carpeta: su carpeta de git COMÚN (un worktree apunta a la del clon: el mismo repo no se cuenta una
    // vez por worktree) y su `origin`. Devuelve { comun, url } (url null: sin `origin`) o { ilegible: código } — «no pude
    // leer» no es «sin origin»
    const repoDe = (dir) => {
      try {
        let gd = path.join(dir, '.git');
        if (fs.statSync(gd).isFile()) {
          const m = fs.readFileSync(gd, 'utf8').match(/^gitdir:\s*(.+)$/m);
          if (!m) return { ilegible: 'gitdir sin forma' };
          gd = path.resolve(dir, m[1].trim());
          const comun = path.join(gd, 'commondir');
          if (fs.existsSync(comun)) gd = path.resolve(gd, fs.readFileSync(comun, 'utf8').trim());
        }
        const cfg = fs.readFileSync(path.join(gd, 'config'), 'utf8');
        const sec = cfg.split(/^\s*\[/m).find((s) => /^remote\s+"origin"\s*\]/.test(s));
        const u = sec && sec.match(/^\s*url\s*=\s*(.+?)\s*$/m);
        let comun = gd;
        try { comun = fs.realpathSync(gd); } catch (_) { /* la ruta tal cual: alcanza para no contarlo dos veces */ }
        return { comun, url: u ? u[1] : null };
      } catch (e) { return { ilegible: (e && e.code) || 'error' }; }
    };
    const enDisco = [];
    const ilegibles = [];   // carpetas y configuraciones que no se pudieron leer: faltan, no son «no está»
    const mirar = (dir, prof) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { ilegibles.push((e && e.code) || 'error'); return; }
      for (const e of ents) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (fs.existsSync(path.join(p, '.git'))) enDisco.push(p);
        else if (prof < 2) mirar(p, prof + 1);
      }
    };
    mirar(raiz, 1);
    // por repo (carpeta de git común): las carpetas que lo clonan o son sus worktrees, si alguna tiene la huella
    const repos = new Map();   // comun → { url, huella }
    for (const dir of enDisco) {
      const r = repoDe(dir);
      if (r.ilegible) { ilegibles.push(r.ilegible); continue; }
      const ya = repos.get(r.comun) || { url: r.url, huella: false };
      if (fs.existsSync(path.join(dir, '.tycon'))) ya.huella = true;
      repos.set(r.comun, ya);
    }
    const encontradas = new Set();
    let sinDeclarar = 0;
    for (const r of repos.values()) {
      const id = r.url ? identidadAzure(r.url) : null;
      const clave = id ? `${id.proyecto}/${id.repo}` : null;
      if (clave && declaradas.has(clave)) encontradas.add(clave);
      else if (r.huella) sinDeclarar += 1;
    }
    extra.declared_repos = { declared: totalDeclarados, on_disk: repos.size, matched: encontradas.size, undeclared_with_harness: sinDeclarar };
    const linea = `repos declarados por la organización: ${encontradas.size} de ${totalDeclarados} en este disco (raíz ${raiz}) · con huella del arnés sin declarar: ${sinDeclarar}`;
    // con algo que no se pudo leer los números quedan cortos: es un aviso (nunca un rojo), con los códigos
    if (ilegibles.length) {
      extra.declared_repos.unreadable = ilegibles.length;
      add('warn', `${linea} · ${ilegibles.length} carpeta(s) o configuración(es) que no se pudieron leer (${[...new Set(ilegibles)].join(', ')}): los números pueden quedar cortos`);
    } else add('ok', linea);
  } catch (e) {
    const t = `no pude compararlos (${(e && (e.code || e.message)) || 'error'})`;
    sinMedir(t); add('warn', `repos declarados: ${t}`);
  }
}

/**
 * Lo que `doctor` dice del freno antes de publicar (story 8.26, tanda H1c · AC 65 d), sin escribir nada. Es lo único que
 * hay entre un nombre real y el repo público, y doctor no decía nada de él. Cinco cosas, en las dos formas de máquina (con
 * un clon, y con una versión bajada):
 *   · si el `pre-push` del arnés está en la carpeta GLOBAL de hooks de git y git lo puede correr. La global, no la del
 *     repo de la carpeta actual (lo que mira `public-push-guard.js status`): doctor contesta lo mismo se corra donde se corra;
 *   · de dónde sale la lista y cuántos términos trae (nunca cuáles);
 *   · qué clon de mantenimiento declara la máquina (`paths.maintainers`), o que no declara ninguno. Una máquina que
 *     mantiene (`paths.maintained`) sin esa clave se avisa con el comando: sin ella el clon de mantenimiento no se
 *     reconoce desde un clon del público, su merge no encuentra la configuración y el freno de nombres del commit no
 *     tiene lista — y las tres cosas degradan calladas;
 *   · si esa lista está al día (lo mide el freno: `listFreshness`; con `--fetch`, preguntándole al remoto de su clon);
 *   · con el clon de mantenimiento declarado, por dónde viaja la memoria de lo trabajado en un clon del público.
 *
 * 🔴 NUNCA en rojo: todo es dato (`ok`) o aviso (`warn`). La comprobación de salud de una actualización corre
 * `doctor --json` (health.js) y un `fail` la tira abajo: un rojo acá frenaría las actualizaciones de toda máquina sin el
 * `pre-push` —perfil mínimo, TYCON_NO_GIT_HOOKS=1, sin carpeta global de hooks—. Donde el freno no se espera (el perfil
 * no es `full`, o ese interruptor: lo que dice install-effects.json de la pieza), que falte es un dato.
 *
 * El freno se carga del ÁRBOL instalado (su lista y su perfil del equipo se buscan desde ahí). Un árbol que no lo trae
 * —una versión anterior— no dice nada ni suma la clave `publish_guard` a `--json`. Nunca tira.
 */
/**
 * El Node propio del arnés en `doctor` (story 8.39, AC 20 y 21): qué versión usa el arnés, si es la propia, si su huella
 * es la de la lista y cuántos hooks `.js` corren con él. 🔴 NUNCA en rojo (la comprobación de salud de cada
 * actualización corre `doctor --json`: un rojo acá haría volver atrás una versión sana por una red caída). Bajo la salud
 * no recalcula la huella del binario (`verified: null`). La clave `harness_node` va a `--json`. La línea de siempre
 * «Node <x> (piso 20)» se queda: dice con qué corre doctor.
 */
function doctorHarnessNodeItems(ctx, tree, add, extra) {
  let f;
  try { f = mod('harness-node').doctorFacts({ tree, env: ctx.env, platform: ctx.platform, health: ctx.env.TYCON_HARNESS_HEALTH === '1', settingsFile: settingsPath(ctx) }); } catch (e) {
    extra.harness_node = { own: null, reason: `no se pudo mirar (${e.message})` };
    add('warn', `Node del arnés: no se pudo mirar (${e.message})`);
    return;
  }
  extra.harness_node = f.json;
  add(f.level === 'warn' ? 'warn' : 'ok', f.line);
}

function doctorPublishGuardItems(ctx, tree, prof, add, extra) {
  const file = path.join(tree, 'scripts', 'hooks', 'public-push-guard.js');
  if (!fs.existsSync(file)) return;
  // 🔴 Bajo la comprobación de salud de una actualización (TYCON_HARNESS_HEALTH=1) este bloque NO corre: ni una lectura
  // de git, ni la lista, ni la frescura. Dos motivos. Una versión bajada se instala y se actualiza sin invocar git (la
  // máquina puede no tenerlo, y esa es la regla de la story 8.23): la salud de `install --version` corre este doctor, y
  // con el freno en el árbol le preguntaba a git por la carpeta global de hooks. Y la salud juzga el ÁRBOL nuevo: nada de
  // lo que este bloque mira —cómo dejó la persona su git, en qué quedó su clon de mantenimiento— es del árbol, así que
  // nada de acá puede cambiarla. La clave va en null, como las otras «mientras no se pudieron mirar». Corrido por una
  // persona, en cualquier forma de máquina, corre entero.
  if (ctx.env.TYCON_HARNESS_HEALTH === '1') { extra.publish_guard = null; return; }
  const say = (level, text) => add(level === 'warn' ? 'warn' : 'ok', `freno antes de publicar: ${text}`);
  const kind = (e) => (e && (e.code || e.message)) || 'error';
  let G;
  // (la clave va en null: está el freno y no se pudo mirar — no es lo mismo que un árbol que no lo trae)
  try { G = require(file); } catch (e) { extra.publish_guard = null; say('warn', `está en el árbol y no carga (${kind(e)}): no sé cómo está en esta máquina`); return; }
  const env = ctx.env;
  const out = { hook: { placed: false, runnable: false, path: null, expected: false }, list: null, maintainers: { declared: false, path: null, problem: null }, freshness: null };
  extra.publish_guard = out;
  const setCommand = 'harness.js config set paths.maintainers <clon de mantenimiento>';

  // 1 · el `pre-push`, en la carpeta global de hooks de git
  try {
    const off = env.TYCON_NO_GIT_HOOKS === '1';
    out.hook.expected = !off && Boolean(prof && prof.ok && prof.value === 'full');
    const notExpected = off ? 'TYCON_NO_GIT_HOOKS=1' : (prof && prof.ok ? `el perfil es ${prof.value}` : 'no se pudo leer el perfil');
    const level = out.hook.expected ? 'warn' : 'ok';
    const tail = out.hook.expected ? ' — harness.js apply lo pone' : ` — acá no se espera (${notExpected})`;
    // la carpeta que llena el aplicador; si git mira OTRA, apply no la cambia (puede ser de otra herramienta)
    const G2 = mod('git-hooks-path');
    const oursDir = G2.hooksDir({ home: ctx.home, env });
    const sameDir = (d) => { try { return path.resolve(d) === path.resolve(oursDir) || (fs.existsSync(d) && fs.existsSync(oursDir) && fs.realpathSync(d) === fs.realpathSync(oursDir)); } catch (_) { return false; } };
    const otherTail = () => ` — harness.js apply no la cambia (puede ser de otra herramienta): para usar la del arnés, git config --global core.hooksPath "${G2.valueFor(oursDir, ctx.platform)}"`;
    // `--type=path`: git expande `~` como lo va a usar. Lee la configuración global de quien corre (HOME, GIT_CONFIG_GLOBAL)
    // `--includes`: con `--global` git NO sigue los archivos incluidos (`[include]`) salvo que se lo pidan, y al correr un
    // hook sí los sigue: con la carpeta puesta desde un archivo incluido esto decía «git no tiene carpeta global de
    // hooks» con el freno puesto. Es la misma lectura que hacen los dos instaladores y `status` del freno.
    const r = spawnSync('git', ['config', '--global', '--includes', '--type=path', 'core.hooksPath'], { windowsHide: true, encoding: 'utf8', timeout: 10000, env: Object.assign({}, env, { GIT_TERMINAL_PROMPT: '0' }) });
    let dir = !r.error && r.status === 0 ? String(r.stdout || '').trim() : '';
    // en Windows, escrita con forma de Unix (`/c/Users/…`): es la misma carpeta
    if (dir && isWin(ctx) && /^\/[A-Za-z]\//.test(dir)) dir = `${dir[1]}:${dir.slice(2)}`;
    if (r.error && r.error.code === 'ENOENT') say('ok', 'no pude mirar la carpeta global de hooks: git no está en esta máquina (sin git no hay empuje que frenar)');
    else if (r.error || (r.status !== 0 && r.status !== 1)) say(level, `no pude mirar la carpeta global de hooks de git (git config ${r.error ? 'no contestó' : `salió ${r.status}`})`);
    else if (!dir) say(level, `el pre-push del arnés NO está puesto: git no tiene carpeta global de hooks (core.hooksPath)${tail}`);
    // una carpeta que ya está puesta (otra herramienta, una relativa) `apply` no la cambia: el aviso dice cómo apuntarla a
    // mano, no «apply lo pone» (2026-10-14: doctor mandaba a apply y el aviso seguía igual)
    else if (!path.isAbsolute(dir)) say(level, `el pre-push del arnés NO está puesto para todos los repos: la carpeta global de hooks de git es relativa (${dir}), y entonces cada repo mira la suya${out.hook.expected ? otherTail() : tail}`);
    else {
      const hook = path.join(dir, 'pre-push');
      out.hook.path = hook;
      let placed = false;
      try { placed = fs.readFileSync(hook, 'utf8').includes(G.HOOK_MARK || 'git-pre-push-global.sh'); } catch (_) { placed = false; }
      // git no corre un hook sin permiso de ejecución (en Windows no mira ese permiso)
      let runnable = placed;
      if (placed && !isWin(ctx)) { try { fs.accessSync(hook, fs.constants.X_OK); } catch (_) { runnable = false; } }
      Object.assign(out.hook, { placed, runnable });
      if (placed && runnable) say('ok', `el pre-push del arnés está en la carpeta global de hooks de git (${hook})`);
      else if (placed) say(level, `el pre-push del arnés está en la carpeta global de hooks de git (${hook}) pero sin permiso de ejecución: git no lo corre${out.hook.expected ? ' — chmod +x, o harness.js apply' : tail}`);
      else say(level, `el pre-push del arnés NO está en la carpeta global de hooks de git (git mira ${hook}, y ése no es el del arnés)${out.hook.expected && !sameDir(dir) ? otherTail() : tail}`);
    }
  } catch (e) { say('warn', `no pude mirar el pre-push (${kind(e)})`); }

  // 2 · la lista: de dónde sale y cuántos términos. `optional`: una máquina del equipo que no mantiene no tiene lista,
  //     y eso no es algo que le falte (la tiene quien mantiene)
  let listFile = null, listSource = null;
  try {
    const list = G.resolveList(null, env, { optional: true });
    if (list.generic) {
      say('ok', G.isTeamMachine(null) ? 'sin lista en esta máquina (la tiene quien mantiene): un empuje del arnés a un remoto público desde acá se frena por «no pude mirar»'
        : 'sin lista en esta máquina: mira lo que no la necesita (secretos, correos, rutas de máquina, binarios y rutas vedadas)');
    } else {
      out.list = { source: list.source, terms: list.terms };
      listFile = list.file || null; listSource = list.source;
      say('ok', `la lista: ${list.label} — ${list.terms} término(s)`);
    }
  } catch (e) {
    // el mensaje de un «no pude mirar» del freno no cita nada de la lista; el de otro error no se imprime
    const blind = G.Blind && e instanceof G.Blind;
    if (blind && e.listFile) { listFile = e.listFile; listSource = e.listSource || null; }
    say('warn', `la lista no se puede usar — ${blind ? e.message : `no se pudo leer (${(e && (e.code || e.name)) || 'error'})`}`);
  }

  // 3 · el clon de mantenimiento que la máquina declara
  let maintainers = null;
  try {
    const TH = mod('tycon-home');
    let m = typeof TH.maintainersClone === 'function' ? TH.maintainersClone({ env }) : { declared: false, path: null, problem: null };
    // declarado y en su lugar: además tiene que ser la raíz de un clon con un remoto que se lea (lo sabe el reconocedor
    // de repos del árbol); si no, los repos del arnés se vuelven a reconocer por el nombre de su carpeta
    if (m.declared && !m.problem) {
      try {
        const H = require(path.join(tree, 'scripts', 'lib', 'harness-repo.js'));
        const d = typeof H.deLaMaquina === 'function' ? H.deLaMaquina(env) : null;
        if (d && d.declared && d.problem) m = { declared: true, path: m.path, problem: d.problem };
      } catch (_) { /* un árbol sin el reconocedor: vale lo que dijo tycon-home */ }
    }
    out.maintainers = { declared: Boolean(m.declared), path: m.path || null, problem: m.problem || null };
    let maintains = false;
    try { maintains = G.listPlaces(env).some((p) => p.source === 'maintained'); } catch (_) { maintains = Boolean(TH.maintainedPath({ env })); }
    if (m.declared && !m.problem) { maintainers = m.path; say('ok', `clon de mantenimiento declarado: ${m.path} (paths.maintainers)`); }
    else if (m.declared) say('warn', `el clon de mantenimiento declarado no sirve (${m.path}): ${m.problem} — mientras tanto los repos del arnés se reconocen por el nombre de su carpeta, no por su remoto; corregilo con ${setCommand}`);
    else if (m.problem) say('warn', m.problem);
    else if (maintains) say('warn', `esta máquina mantiene un clon (paths.maintained) y no declara el de mantenimiento (paths.maintainers): sin esa clave el clon de mantenimiento no se reconoce desde un clon del público, su merge no encuentra la configuración y el freno de nombres del commit no tiene lista — ${setCommand}`);
    else say('ok', 'esta máquina no declara un clon de mantenimiento (paths.maintainers): no mantiene el arnés');
  } catch (e) { say('warn', `no pude mirar el clon de mantenimiento (${kind(e)})`); }

  // 4 · ¿la lista está al día? Sin red, salvo `doctor --fetch`
  try {
    if (listFile && typeof G.listFreshness === 'function' && typeof G.freshnessText === 'function') {
      const fetch = Boolean(ctx.opts.fetch);
      const f = G.listFreshness(listFile, { env, askRemote: fetch });
      out.freshness = f;
      const t = G.freshnessText(f);
      // «no pude medir» es un aviso sólo donde la lista sale de un clon que la máquina declaró: ahí se esperaba poder
      const level = t.level === 'warn' || (t.level === 'unknown' && (listSource === 'maintainers' || listSource === 'maintained')) ? 'warn' : 'ok';
      // qué hacer lo dice el freno (`advice`): traerlo, mirarlo primero o —si está adelante de su remoto— subir lo propio
      say(level, `${t.text}${t.level === 'warn' ? ` — ${t.advice || `traé ese clon (git -C "${f.clone}" pull)`}` : ''}${t.level !== 'unknown' && !fetch ? ' · doctor --fetch le pregunta además a su remoto' : ''}`);
    }
  } catch (e) { say('warn', `no pude medir si la lista está al día (${kind(e)})`); }

  // 5 · la memoria: al commitear en un clon del público no se exporta nada; viaja con el clon de mantenimiento
  if (maintainers) add('ok', `la memoria del trabajo hecho en un clon del público viaja con el próximo commit del clon de mantenimiento (${maintainers})`);
}

function cmdChannel(ctx) {
  const CH = mod('channel');
  const need = needState(ctx);
  if (need.fail) return { code: need.fail.code, lines: [need.fail.line] };
  const value = ctx.args[0];
  const SRC = mod('sources');
  const tree = need.state.tree;
  const before = policyOf(ctx, tree);
  // con otro remoto que el público, los dos canales son `main` sin reescritura: se dice acá, donde se elige (AC 25)
  const publicCopy = isPublicCopy(ctx, need.state);
  const remoteNote = publicCopy ? [] : [NOT_PUBLIC_NOTE];
  if (!value) {
    if (before.errors.length) return { code: 2, lines: before.errors.map((e) => `harness.js channel: ${e}`) };
    return { code: 0, lines: [`canal: ${before.channel} (${before.origins.channel}) · aplicación: ${before.apply} (${before.origins.apply})`, ...remoteNote] };
  }
  // en una copia pública, pasar a `latest` con la aplicación en `auto` pide confirmación (AC 29b, D2)
  const confirm = confirmLatestAuto(ctx, { value, policy: before, publicCopy, cmd: 'channel' });
  if (confirm.declined) return { code: 0, lines: ['no se cambió el canal'] };
  if (!confirm.ok) return { code: confirm.code, lines: confirm.lines };
  const r = CH.set(ctx.home, value);
  if (!r.ok) return { code: 2, lines: [`harness.js channel: ${r.reason}`] };
  // UNA verdad para el canal: la política (A9). El archivo quedó escrito, pero si una variable le gana, el canal vigente
  // es el de la variable: se dice, y el estado guarda el vigente
  const after = policyOf(ctx, tree);
  const lines = [`canal: ${r.before || '(por defecto)'} → ${r.after} en ${r.file}`];
  if (!after.errors.length && after.channel !== value) lines.push(`ojo: la variable ${CH.VARS.channel}=${after.channel} le gana a ese archivo: el canal vigente sigue siendo ${after.channel} (sacá la variable para que valga ${value})`);
  lines.push(...confirm.lines, ...remoteNote);
  const S = mod('state'), L = mod('lock');
  return L.withLock(ctx.home, () => {
    const rr = loadState(ctx);
    if (rr.status === 'ok' && !after.errors.length) {
      const state = rr.state;
      // el cambio de canal se mira en el próximo arranque, sin esperar la ventana de la mirada anterior
      if (state.channel !== after.channel) state.last_fetch = null;
      applyPolicy(ctx, state, after);
      S.write(ctx.home, state);
      // «no bajar», dicho ya si se puede saber sin salir a la red (con lo último que se trajo de `main`): quien pasa a
      // `stable` con lo instalado más nuevo se entera ahí; si no hay nada traído, lo dice el próximo `update`
      if (after.channel === 'stable') {
        for (const src of state.sources || []) {
          if (!src || !src.rewrites) continue;
          // la versión bajada (story 8.23, tanda B) no tiene clon que mirar: lo dice el próximo update, sin git
          if (mod('state').kindOf(src) === 'release') { lines.push('si la estable es más vieja que lo instalado lo dice el próximo update'); continue; }
          const from = SRC.head(src.dir, { env: ctx.env });
          // lo último traído de `main`, en tres estados: sin nada traído no hay qué decir; ilegible, se dice que no se sabe
          const tip = SRC.refState(src.dir, `refs/remotes/origin/${SRC.MAIN_REF}`, { env: ctx.env });
          if (tip.status === 'problem' || !from) { lines.push(`no pude leer ${from ? `origin/${SRC.MAIN_REF}` : 'HEAD'} de ${src.name}${tip.reason ? ` (${tip.reason})` : ''}: si la estable es más vieja que lo instalado lo dice el próximo update`); continue; }
          const to = tip.sha;
          if (!to) continue;
          const a = SRC.assess(src, from, to, { env: ctx.env, channel: 'stable', labels: { to: `origin/${SRC.MAIN_REF}` } });
          if (a.status === 'older') lines.push(noDowngradeText({ src, c: { from, to, numbers: a.numbers } }, 'stable'));
          // un número que no se pudo leer no es «no hay nada que decir»: se dice que no se sabe
          else if (a.status === 'unknown') lines.push(`${a.reason} (si la estable es más vieja que lo instalado lo dice el próximo update)`);        }
      }
    }
    return { code: 0, lines };
  }, { env: ctx.env, onBusy: busy });
}

function cmdLink(ctx) {
  const S = mod('state'), L = mod('lock');
  const need = needState(ctx);
  if (need.fail) return { code: need.fail.code, lines: [need.fail.line] };
  if (!ctx.opts.local && !ctx.opts.managed) return { code: 2, lines: ['harness.js link: hace falta --local <clon> o --managed'] };
  if (ctx.opts.local && ctx.opts.managed) return { code: 2, lines: ['harness.js link: --local y --managed no van juntos'] };
  if (ctx.opts.local) {
    const clone = real(ctx.opts.local);
    if (!clone || !isHarnessClone(clone)) return { code: 2, lines: [`harness.js link: ${ctx.opts.local} no es un clon del arnés (sin scripts/install-tycon-hooks.sh)`] };
    if (isTemporary(ctx, clone) && !ctx.opts['allow-temporary']) {
      return { code: 2, lines: [`harness.js link: ${clone} es un clon descartable (carpeta temporal): se borra al reiniciar y deja el enlace y los hooks colgados — si igual lo querés, --allow-temporary`] };
    }
    return L.withLock(ctx.home, () => {
      const r = loadState(ctx);
      if (r.status !== 'ok') { const f = S.fail(r, { home: ctx.home }); return { code: f.code, lines: [f.line] }; }
      const state = r.state;
      const l = ensureLink(ctx, clone, { link: clone });
      if (!l.ok || !linkResolvesTo(ctx, clone)) return { code: 2, lines: [`harness.js link: no pude re-apuntar el enlace: ${l.out || l.err}`] };
      if (state.mode !== 'developer') state.tree_before = state.tree;
      state.mode = 'developer';
      state.tree = clone;
      const hs = state.sources.find((s) => s.name === 'harness');
      if (hs) hs.dir = clone;
      S.write(ctx.home, state);
      return { code: 0, lines: [`modo desarrollador: ${clone}; actualizar es tuyo (update y startup no tocan su git; el aplicador corre desde ahí). Volver: harness.js link --managed`] };
    }, { env: ctx.env, onBusy: busy });
  }
  return L.withLock(ctx.home, () => {
    const r = loadState(ctx);
    if (r.status !== 'ok') { const f = S.fail(r, { home: ctx.home }); return { code: f.code, lines: [f.line] }; }
    const state = r.state;
    if (state.mode === 'managed') return { code: 0, lines: [`ya en modo managed sobre ${state.tree}`] };
    // (en la forma con enlaces —story 8.33— `tree_before` es `~/.tycon/harness`, un enlace: se vuelve a ESE nombre, no a la
    // carpeta numerada a la que lleva hoy; con real() quedaban el estado y el lugar atados a una versión — pase adversarial)
    const before = state.tree_before && mod('tycon-home').isLink(state.tree_before) ? path.resolve(state.tree_before) : null;
    const target = before || (state.tree_before && real(state.tree_before));
    if (!target || !isHarnessClone(target)) return { code: 2, lines: [`harness.js link --managed: no hay un árbol anterior al que volver (${state.tree_before || 'sin tree_before'}): harness.js install desde un clon`] };
    const l = ensureLink(ctx, target, { link: target });
    if (!l.ok || !linkResolvesTo(ctx, target)) return { code: 2, lines: [`harness.js link --managed: no pude re-apuntar el enlace: ${l.out || l.err}`] };
    state.mode = 'managed';
    state.tree = target;
    state.tree_before = null;
    const hs = state.sources.find((s) => s.name === 'harness');
    if (hs) hs.dir = target;
    S.write(ctx.home, state);
    return { code: 0, lines: [`modo managed sobre ${target}`] };
  }, { env: ctx.env, onBusy: busy });
}

/**
 * `rollback [--to <copia>] [--list] [--release]` (tanda C, AC 19-20): vuelve por piezas a una copia —por defecto la de
 * antes de la versión instalada—, lleva los árboles a sus `sources`, y deja una RETENCIÓN para que el arranque no vuelva a
 * subir solo. Antes de tocar nada toma una copia `before-rollback` siempre nueva: un rollback se deshace con otro. Corre
 * también desde la copia fija (`bootstrap.js rollback`): sólo usa el estado y los módulos de su carpeta.
 */
/** Tras restaurar una copia: si Codex quedó desplegado y `tools` no lo nombra, entra con sus piezas registradas; si
 *  `tools` lo nombra y su despliegue ya no está, sale (y sus piezas del registro). Sin `tools` en el estado (de antes
 *  de la tanda C) no se toca nada. */
function reconcileToolsAfterRestore(ctx, state, log) {
  if (!Array.isArray(state.tools)) return;
  const T = mod('tools');
  const where = { home: ctx.home, env: ctx.env };
  const deployed = T.codexDeployed(where);
  const has = state.tools.includes('codex');
  const M = mod('managed');
  const isCodex = (p) => p && p.kind === 'codex';
  if (deployed && !has) {
    state.tools = T.TOOLS.filter((t) => t === 'codex' || state.tools.includes(t));
    const pieces = T.codexPieces({ tree: state.tree, home: ctx.home, env: ctx.env });
    const prev = Array.isArray(state.managed) ? state.managed : [];
    state.managed = M.merge(prev.filter((p) => !isCodex(p)), pieces, { version: state.version && state.version.number, present: () => true });
    log([`la copia dejó a Codex enchufado: vuelve a tools con ${pieces.length} pieza(s) registradas`]);
  } else if (!deployed && has) {
    state.tools = state.tools.filter((t) => t !== 'codex');
    state.managed = (Array.isArray(state.managed) ? state.managed : []).filter((p) => !isCodex(p));
    log(['la copia dejó a Codex sin enchufar: sale de tools y del registro']);
  }
}

function cmdRollback(ctx) {
  const S = mod('state'), L = mod('lock'), R = mod('report'), SN = mod('snapshot');
  if (ctx.opts.list) {
    const copies = SN.list(ctx.home);
    if (!copies.length) return { code: 0, lines: ['no hay copias de seguridad del mecanismo'] };
    return { code: 0, lines: copies.map((c) => {
      const m = c.manifest || {};
      return `${c.name} · seq ${m.seq || '—'} · ${m.from || '—'} → ${m.to || '—'} · ${m.reason || '—'} · ${m.at || '—'}${m.sources ? '' : ' · sin sources (sólo restauraría archivos)'}`;
    }) };
  }
  const need = needState(ctx);
  if (need.fail) return { code: need.fail.code, lines: [need.fail.line] };
  const log = (l) => R.log(ctx.home, `rollback: ${l}`);
  if (ctx.opts.release) {
    if (ctx.opts.to) return { code: 2, lines: ['harness.js rollback: --release y --to no van juntos'] };
    return L.withLock(ctx.home, () => {
      const r = loadState(ctx);
      if (r.status !== 'ok') { const f = S.fail(r, { home: ctx.home }); return { code: f.code, lines: [f.line] }; }
      if (!r.state.hold) return { code: 0, lines: ['no hay retención: el arnés ya se actualiza según su política'] };
      const was = r.state.hold.commit;
      r.state.hold = null;
      if (r.state.notice && /^retención:/.test(r.state.notice)) R.clearNotice(r.state);
      S.write(ctx.home, r.state);
      log(`retención levantada (había deshecho ${was})`);
      return { code: 0, lines: [`retención levantada (había deshecho ${was}): el próximo arranque actualiza según la política`] };
    }, { env: ctx.env, onBusy: busy });
  }
  return L.withLock(ctx.home, () => {
    const r = loadState(ctx);
    if (r.status !== 'ok') { const f = S.fail(r, { home: ctx.home }); return { code: f.code, lines: [f.line] }; }
    const state = r.state;
    // la versión bajada (story 8.23, tanda B · AC 15): el cambio al revés (harness/ ↔ previous/), sin bajar nada; con
    // `--to <copia>` sigue lo de la 8.13 (sólo archivos), más abajo
    if (S.isRelease(state) && !ctx.opts.to) {
      const res = mod('release').rollback(ctx, state, releaseHelpers(ctx), { log });
      if (!res.ok) return { code: 2, lines: res.lines };
      if (state.hold && res.undone && state.hold.commit === state.version.number) {
        res.lines.push(`deshiciste la vuelta atrás: retención levantada (había deshecho ${state.hold.commit})`);
        state.hold = null; R.clearNotice(state);
      } else {
        state.hold = { commit: res.undone, sources: { harness: res.undone }, at: nowIso(), reason: 'rollback' };
        R.setNotice(state, holdText(state));
        res.lines.push(holdText(state));
      }
      S.write(ctx.home, state);
      log(`${res.undone} → ${state.version.number} (versión bajada)`);
      return { code: 0, lines: res.lines };
    }
    const RB = mod('rollback');
    const current = currentSources(ctx, state) || {};
    const pick = RB.pickTarget(SN.list(ctx.home), { to: ctx.opts.to || null, currentSources: current });
    if (!pick.copy) return { code: ctx.opts.to ? 2 : 0, lines: [`harness.js rollback: ${pick.reason}`] };
    // con capa (story 8.13.1): sin manifiesto legible no se sabe qué pisó la capa (C6), y un agregado editado a mano que la
    // versión a la que se vuelve sigue lo pisaría el reset (clase 3). En los dos casos no se vuelve nada atrás y se dice
    let stop = null;
    try { stop = pick.filesOnly ? null : layerBackBlock(ctx, state, pick.copy, 'rollback'); } catch (e) { stop = `el freno no pudo correr: ${e.message}`; }
    if (stop) return { code: 2, lines: [`harness.js rollback: ${stop}`] };
    const undone = versionLabel(ctx, state);
    // la copia de ANTES de volver, siempre nueva (decisión 1): con ella un rollback se deshace con otro. Su retención no
    // puede borrar la copia destino (pase adversarial H9/H10)
    const before = takeSnapshot(ctx, state.tree, { reason: 'before-rollback', from: state.version && state.version.number, to: pick.copy.manifest.from || null, log, force: true, state, protect: [pick.copy.dir] });
    // con capa (story 8.13.1, AC 8 y 17): el público vuelve con su reset y la capa se re-apila desde el commit anterior
    const res = RB.restore(Object.assign({}, ctx, { tree: state.tree }), state, pick.copy, Object.assign({
      why: 'rollback', runApplier, log, filesOnly: pick.filesOnly, snapshotDir: before && before.dir, isOwnPiece: (p) => isOwnPiece(ctx, p),
    }, layerHooks(ctx, state, log)));
    const moved = Array.isArray(res.moved) ? res.moved : [];
    // las herramientas, por lo que la copia dejó en la máquina (pase adversarial de la C, clase 31): una vuelta a la copia
    // que tomó `uninstall --tool codex` restaura hooks.json, config.toml y AGENTS.md de Codex, y sin esto `tools` seguía en
    // ['claude'] y el registro sin esas piezas: nadie las mantenía, doctor no las veía y uninstall no las quitaba
    reconcileToolsAfterRestore(ctx, state, lines => lines.forEach((l) => log(`rollback: ${l}`)));
    // sólo si los árboles se movieron cambia lo registrado: una vuelta atrás frenada (una fuente en otra rama, con commits
    // propios) no re-registra ese clon como la versión instalada (pase adversarial H17)
    if (moved.length) {
      syncSourceCommits(ctx, state);
      state.version.number = versionNumber(ctx, state);
      state.version.installed_at = nowIso();
    }
    state.last_apply = nowIso();
    const lines = [`vuelta atrás a ${pick.reason}`];
    if (state.mode === 'developer') lines.push(`modo desarrollador: restauré piezas y archivos; el git de ${state.tree} no se tocó`);
    // un rollback que vuelve a lo que la retención había deshecho (la copia `before-rollback` del anterior) la LEVANTA:
    // deshacer un rollback no deja una retención sobre la versión vieja (pase adversarial H11/H12)
    const undoing = Boolean(state.hold && moved.length && sameTips(state.hold.sources, pick.copy.manifest.sources));
    if (undoing) {
      lines.push(`deshiciste la vuelta atrás: retención levantada (había deshecho ${state.hold.commit})`);
      state.hold = null;
      R.clearNotice(state);
    } else if (moved.length && state.mode !== 'developer') {
      // la retención: el arranque no vuelve a subir a lo deshecho hasta `--release` o `update --yes` (en developer no hay
      // actualización que frenar)
      state.hold = { commit: undone, sources: current, at: nowIso(), reason: 'rollback' };
      R.setNotice(state, holdText(state));
      lines.push(`arnés ${undone} → ${versionLabel(ctx, state)}`, holdText(state));
    } else if (!moved.length) {
      lines.push(pick.filesOnly ? 'los árboles no se movieron (la copia no sabe a qué commits)' : `los árboles quedaron en ${state.version.number}`);
    }
    S.write(ctx.home, state);
    finishSnapshot(ctx, before, log);
    log(`${undone} → ${state.version.number} · ${(res.lines || []).join(' · ')}`);
    return { code: res.ok ? 0 : 1, lines: [...lines, ...(res.lines || [])] };
  }, { env: ctx.env, onBusy: busy });
}

/**
 * `uninstall [--dry-run] [--yes]` (tanda C, AC 22-23): quita SÓLO lo registrado y dice lo que deja. Sin `--yes` y sin
 * terminal no hace nada (sale 2); en una terminal pregunta. Funciona sin árbol (el estado en `tree_missing`), desde la
 * copia fija (`bootstrap.js uninstall`). Sin estado: «nada que quitar», 0 (la segunda corrida).
 */
function cmdUninstall(ctx) {
  const S = mod('state'), L = mod('lock'), R = mod('report');
  const read = loadState(ctx);
  if (read.status === 'missing') return { code: 0, lines: ['nada que quitar: el arnés no está instalado (no hay estado)'] };
  if (read.status !== 'ok' && !(read.status === 'tree_missing' && read.state)) { const f = S.fail(read, { home: ctx.home }); return { code: f.code, lines: [f.line] }; }
  // `uninstall --tool <una>` (story 8.23, tanda C · AC 26): desenchufa sólo esa herramienta; el arnés y la otra quedan
  if (ctx.opts.tool !== undefined) return mod('tool-change').remove(ctx, read.state, toolHelpers(ctx));
  const U = mod('uninstall');
  const noTree = read.status === 'tree_missing';
  const head = noTree ? [`el árbol ${read.state.tree} no está: trabajo con el registro`] : [];
  const uctx = Object.assign({}, ctx, { tree: read.state.tree });
  const plan = U.plan(uctx, read.state);
  const planLines = typeof U.describePlan === 'function' ? U.describePlan(plan) : planText(plan);
  // la carpeta global de hooks de git que puso el arnés (2026-10-14): el plan la nombra si sigue siendo ésa
  { const rec = read.state.git_hooks_path; if (rec && rec.value) { const now = mod('git-hooks-path').read({ env: ctx.env }); if (now.status === 'set' && now.value === rec.value) planLines.push(`quita también la carpeta global de hooks de git que puso el arnés (core.hooksPath = ${rec.value})`); } }
  if (ctx.opts['dry-run']) return { code: 0, lines: [...head, ...planLines] };
  if (!ctx.opts.yes) {
    if (!process.stdin.isTTY) return { code: 2, lines: [...head, ...planLines, 'harness.js uninstall: sin --yes y sin terminal no hago nada (harness.js uninstall --yes)'] };
    process.stdout.write(`${[...head, ...planLines].join('\n')}\n¿Desinstalo? [s/N] `);
    if (!saidYes(readLine())) return { code: 0, lines: ['no se desinstaló nada'] };
  }
  const wasOwnHome = mod('tycon-home').livesInOwnHome(ctx.home);
  const done = L.withLock(ctx.home, () => {
    const again = loadState(ctx);
    if (again.status === 'missing') return { code: 0, lines: ['nada que quitar: el arnés no está instalado (no hay estado)'] };
    const state = again.state;
    if (!state) { const f = S.fail(again, { home: ctx.home }); return { code: f.code, lines: [f.line] }; }
    const log = (l) => R.log(ctx.home, `uninstall: ${l}`);
    // la copia antes de quitar nada, siempre nueva (decisión 1)
    const snap = takeSnapshot(ctx, state.tree, { reason: 'uninstall', from: state.version && state.version.number, log, force: true, state: noTree ? null : state });
    // la capa del equipo (story 8.25, A1b · AC 12): lo editado a mano en harness/ o previous/ se copia a ~/.tycon/team/kept-…/
    // ANTES de quitar nada —también antes de U.run, que quita la copia fija de arranque de la que este programa puede estar
    // corriendo (sus módulos ya no se podrían cargar después)—. team.js calcula el blob solo, sin scripts/lib/ (C2)
    const relOwn = S.isRelease(state) ? mod('tycon-home').ownPaths({ env: ctx.env }) : null;
    const teamDir = relOwn ? path.join(relOwn.root, 'team') : null;
    let keep = { copied: [], failedTrees: [], problems: [], dir: null };
    // (y lo ajeno dentro de la carpeta de una skill de la lista fija —una spec escrita ahí por error—: tanda A2c · AC 36)
    if (relOwn) { try { keep = mod('team').keepEdited([['harness', relOwn.harness], ['previous', relOwn.previous]], teamDir, { foreign: true }); } catch (e) { keep = { copied: [], failedTrees: ['harness', 'previous'], problems: [e.message], dir: null }; } }
    // la casa de los datos de las skills de la lista fija que la capa trae (AC 34): nada del arnés la borra; se nombra si existe
    let dataHomes = [];
    if (relOwn) { try { const TM = mod('team'); const lay = TM.readTeamManifest(relOwn.harness); dataHomes = TM.extrasInLayer(lay ? lay.files.map((f) => f.path) : []).map((e) => ({ e, dh: TM.dataHomeOf(e, { home: ctx.home, env: ctx.env }) })).filter((x) => fs.existsSync(x.dh.dir)).map((x) => `${x.dh.dir} (los datos de ${x.e.skill.slice('skills/'.length)}: tu conexión)`); } catch (e) { dataHomes = [`la casa de los datos de las skills de la lista fija (no pude calcularla: ${e.message}; nada del arnés la borra)`]; } }
    // el módulo de la carpeta global de hooks de git se carga ANTES de U.run: corriendo desde la copia fija de arranque,
    // U.run quita sus módulos y después ya no se podría cargar (harness-team.test.sh, «uninstall por la copia fija»)
    const GHP = mod('git-hooks-path');
    const res = U.run(Object.assign({}, uctx, { snapshotDir: snap && snap.dir }), state, { log });
    finishSnapshot(ctx, snap, log);
    const lines = [...head, ...(res.lines || [])];
    // la carpeta global de hooks de git que puso el arnés (2026-10-14): con los hooks quitados, si quedara git no correría
    // ni los del arnés ni el .git/hooks/ de cada repo. Sólo si sigue siendo la que se puso
    { const g = GHP.release({ env: ctx.env, recorded: state.git_hooks_path, log }); if (g.line) lines.push(g.line); }
    // la versión bajada (story 8.23, tanda B · AC 8): además de lo registrado, las carpetas de versiones de ~/.tycon y los
    // enlaces que apuntan adentro; quedan y se nombran el permiso (config.json) y la caché de terceros
    if (S.isRelease(state)) {
      const own = mod('tycon-home').ownPaths({ env: ctx.env });
      // (lo editado de la capa ya se copió antes de U.run; un árbol con algo que no se pudo copiar no se quita)
      if (keep.copied.length) lines.push(`capa del equipo: editado(s) a mano o dentro de una skill de la lista fija, conservado(s) en ${keep.dir}: ${keep.copied.join(', ')}`);
      const spared = new Set(keep.failedTrees.map((t) => (t === 'harness' ? own.harness : own.previous)));
      if (keep.problems.length) lines.push(`capa del equipo: no pude conservar ${keep.problems.join(' · ')} — ${[...spared].join(' y ')} queda(n) sin quitar`);
      // (en la forma con enlaces —story 8.33, Windows— `harness` y `previous` son enlaces: se quita el ENLACE, nunca se
      // borra a través de él; las versiones viven en versions/, que se quita después)
      const TH = mod('tycon-home');
      const versionsSpared = [...spared].filter((d) => TH.isLink(d)).map((d) => TH.linkTarget(d)).filter(Boolean);
      for (const d of [own.harness, own.previous, own.incoming, own.trash, own.journal, own.linkJournal]) {
        if (spared.has(d)) continue;
        try {
          if (TH.isLink(d)) { TH.removeLink(d); lines.push(`quitado el enlace: ${d}`); }
          else if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true }); lines.push(`quitado: ${d}`); }
        } catch (e) { lines.push(`no pude quitar ${d}: ${e.message}`); }
      }
      try {
        if (fs.existsSync(own.versions)) {
          for (const n of fs.readdirSync(own.versions)) {
            const v = path.join(own.versions, n);
            if (versionsSpared.some((s) => path.resolve(s) === path.resolve(v))) { lines.push(`queda ${v}: tiene lo editado que no se pudo conservar`); continue; }
            if (TH.isLink(v)) TH.removeLink(v); else fs.rmSync(v, { recursive: true, force: true });
          }
          if (!fs.readdirSync(own.versions).length) fs.rmdirSync(own.versions);
          lines.push(`quitado: ${own.versions}`);
        }
      } catch (e) { lines.push(`no pude quitar todo ${own.versions} (${e.code || e.message}): si un programa tiene abierta una versión, cerralo y borrala a mano`); }
      for (const l of [linkPath(ctx.home), mod('tycon-home').installedSkillsDir(ctx.home)]) {
        try {
          const st = fs.lstatSync(l);
          // a dónde APUNTA (readlink), no a dónde resuelve: con harness/ ya quitada el enlace cuelga y realpath no contesta
          // contra la casa del arnés como se la nombra y resuelta (story 8.23, tanda C): con la HOME detrás de un enlace
          // (en Mac, la carpeta temporal) el enlace guarda la ruta resuelta y quedaba colgado
          const to = st.isSymbolicLink() ? path.resolve(path.dirname(l), fs.readlinkSync(l)) : null;
          if (to && [own.root, real(own.root)].filter(Boolean).some((r) => to === r || to.startsWith(r + path.sep))) { mod('tycon-home').removeLink(l); lines.push(`quitado el enlace: ${l}`); }
        } catch (_) { /* no está */ }
      }
      // ~/.tycon/team (la caché de la capa del equipo y lo conservado) se nombra sólo si existe: sin capa, la línea de siempre (AC 16)
      const homes = dataHomes.length ? `, ${dataHomes.join(', ')}` : '';
      if (fs.existsSync(teamDir)) lines.push(`deja: ${own.config} (el permiso de GitHub), ${own.thirdParty} (la caché de skills de terceros)${homes} y ${teamDir} (la caché de la capa del equipo${keep.copied.length ? ' y lo editado a mano que se conservó' : ''}) — borralos a mano si no los querés`);
      else lines.push(`deja: ${own.config} (el permiso de GitHub)${homes} y ${own.thirdParty} (la caché de skills de terceros) — borralos a mano si no los querés`);
    }
    return { code: res.ok ? 0 : 1, lines, uninstalled: res.ok };
  }, { env: ctx.env, onBusy: busy });
  // Una máquina que vivía en la casa propia del arnés (story 8.23, tanda C) deja de vivir ahí: con el arnés quitado se va
  // la carpeta del estado entera (lo que queda adentro es el registro de arranque; las copias de seguridad están aparte,
  // en ~/.tycon/backups). Si quedara, la máquina seguiría «viviendo en ~/.tycon» y una instalación con Claude Code se
  // negaría. Fuera del candado: el candado vive adentro de esa carpeta.
  const TH = mod('tycon-home');
  // la ruta de las copias se decide ANTES de borrar la carpeta: borrada, backupsDir() contestaba la de Claude Code (clase 6)
  const backupsWhere = TH.backupsDir(ctx.home);
  if (done && done.uninstalled && wasOwnHome && TH.livesInOwnHome(ctx.home) && !fs.existsSync(path.join(TH.ownStateDir(ctx.home), 'harness-state.json'))) {
    try { fs.rmSync(TH.ownStateDir(ctx.home), { recursive: true, force: true }); done.lines.push(`quitado: ${TH.ownStateDir(ctx.home)} (el estado; las copias de seguridad quedan en ${backupsWhere || TH.backupsDir(ctx.home)})`); } catch (e) { done.lines.push(`no pude quitar ${TH.ownStateDir(ctx.home)}: ${e.message}`); }
  }
  return done;
}
/**
 * `relocate [--check]` (story 8.19, tanda B · AC 17 y 18): muda A MANO lo registrado por el nombre viejo del lugar
 * (harness/relocate.js). Nunca lo llaman `startup`, `update` ni `apply`. Sin estado propio: una corrida cortada se
 * termina corriéndolo otra vez.
 */
function cmdRelocate(ctx) {
  const need = needState(ctx);
  if (need.fail) return { code: need.fail.code, lines: [need.fail.line] };
  const RL = mod('relocate');
  const pre0 = RL.preconditions(ctx, need.state, { bootstrap: bootstrapStatus(ctx, need.state.tree, need.state) });
  if (pre0.nothing) return { code: 0, lines: [pre0.nothing] };
  if (pre0.problems.length) return { code: 1, lines: [...pre0.problems.map((p) => `harness.js relocate: ${p}`), 'no toqué nada'] };
  if (ctx.opts.check) return { code: 0, lines: RL.describe(RL.measure(ctx, need.state, pre0)) };
  const S = mod('state'), L = mod('lock'), R = mod('report');
  return L.withLock(ctx.home, () => {
    const r = loadState(ctx);
    if (r.status !== 'ok') { const f = S.fail(r, { home: ctx.home }); return { code: f.code, lines: [f.line] }; }
    const state = r.state;
    // otra vez con el candado tomado: entre la primera mirada y el candado otra sesión pudo cambiar algo
    const pre = RL.preconditions(ctx, state, { bootstrap: bootstrapStatus(ctx, state.tree, state) });
    if (pre.nothing) return { code: 0, lines: [pre.nothing] };
    if (pre.problems.length) return { code: 1, lines: [...pre.problems.map((p) => `harness.js relocate: ${p}`), 'no toqué nada'] };
    const plan = RL.measure(ctx, state, pre);
    if (!plan.total) return { code: 0, lines: RL.describe(plan) };
    const log = (l) => R.log(ctx.home, `relocate: ${l}`);
    const version = state.version && state.version.number;
    const snap = takeSnapshot(ctx, state.tree, { reason: 'relocate', from: version, to: version, log, force: true, state });
    RL.dieAt(ctx, 'after-snapshot');
    const res = RL.apply(ctx, state, pre);
    if (res.pieces) S.write(ctx.home, state);
    finishSnapshot(ctx, snap, log);
    log(`${res.total} cambio(s): ${res.reroot.files.map((f) => `${f.label} ${f.rerooted}`).concat(res.import ? ['CLAUDE.md'] : []).join(', ')}`);
    return { code: 0, lines: RL.describe(res, { snapshot: snap ? `${snap.dir} (harness.js rollback --to ${path.basename(snap.dir)} vuelve a ella lo que nadie tocó después)` : null }) };
  }, { env: ctx.env, onBusy: busy });
}

/**
 * `layer` (story 8.13.1, AC 1, 5 y 10): la capa privada, sólo leyendo. Nunca escribe nada ni toma el candado.
 *   · Sin rutas: el mismo chequeo de `doctor` sobre la capa del estado. `--check` sale 0 si está entera (público + capa =
 *     interno, compatible, nada que falte, sobre ni esté editado a mano), 1 si no, y 3 si la máquina no tiene capa.
 *   · Con `--public <copia>` y/o `--harness-clone <clon>`: calcula el complemento de ese clon interno sobre esa copia (los
 *     dos en su HEAD) sin mirar ni tocar el estado; es lo que corre la prueba de sólo lectura en la máquina del dueño
 *     (T10). `--check` sale 1 si la capa sería de otra versión, si la copia no trae la lista de transformados o si hay
 *     algo sólo en la copia sin declarar. Sin `--harness-clone`, el clon sale de `harnessCloneOf`.
 */
function cmdLayer(ctx) {
  const S = mod('state'), SRC = mod('sources'), R = mod('report');
  const o = ctx.opts;
  const read = loadState(ctx);
  const broken = () => { const f = S.fail(read, { home: ctx.home }); return { code: f.code, lines: [f.line] }; };
  if (o.public !== undefined || o['harness-clone'] !== undefined) {
    if (read.status !== 'ok' && read.status !== 'missing') return broken();
    const state = read.status === 'ok' ? read.state : null;
    const pub = o.public !== undefined ? o.public : (state && state.source === 'public' ? state.tree : null);
    const clone = harnessCloneOf(ctx, state);
    if (!pub) return { code: 2, lines: ['harness.js layer: falta --public <copia>: en source internal el árbol es el clon interno y no hay copia pública contra la que calcular'] };
    if (!clone) return { code: 2, lines: ['harness.js layer: falta --harness-clone <clon interno>: el estado no dice cuál es tu clon'] };
    for (const [flag, dir] of [['--public', pub], ['--harness-clone', clone]]) {
      if (!SRC.isRepo(dir, { env: ctx.env })) return { code: 2, lines: [`harness.js layer: ${flag} ${dir} no es un clon de git`] };
    }
    let r;
    try { r = mod('layer').computeLayer({ internalDir: clone, publicDir: pub }); } catch (e) { return { code: 2, lines: [`harness.js layer: ${e.message}`] }; }
    const code = !r.ok || (o.check && r.onlyPublic.undeclared.length) ? 1 : 0;
    if (o.json) return { code, stdout: true, lines: [JSON.stringify(R.layerComputeJson(r), null, 2)] };
    return { code, stdout: true, lines: R.layerComputeText(r, { list: Boolean(o.list) }) };
  }
  if (read.status === 'missing') return { code: 3, lines: ['sin capa: el arnés no está instalado (harness.js install)'] };
  if (read.status !== 'ok') return broken();
  const state = read.state;
  if (!S.layerSources(state).length) {
    return { code: 3, lines: [`sin capa: esta máquina instala ${state.source === 'public' ? 'desde la copia pública, sin capa privada' : 'desde el clon interno, que ya lo trae todo'} (source: ${state.source})`] };
  }
  const facts = layerFacts(ctx, state);
  const code = o.check && !R.layerWhole(facts) ? 1 : 0;
  if (o.json) return { code, stdout: true, lines: [JSON.stringify(R.layerJson(facts, { list: Boolean(o.list) }), null, 2)] };
  return { code, stdout: true, lines: R.layerText(facts, { list: Boolean(o.list) }) };
}
function planText(plan) {
  const L = [];
  const list = (title, xs) => { if (xs && xs.length) { L.push(title); for (const x of xs) L.push(`  - ${typeof x === 'string' ? x : mod('managed').describe(x)}`); } };
  list('quita:', plan.remove);
  list('deja:', plan.keep);
  list('revisalo:', plan.review);
  list('AGENTS.md puntero en repos de producto (los quitás con un commit):', plan.pointers);
  if (!L.length) L.push('nada que quitar');
  return L;
}
/**
 * `config set|unset|show <clave>` (story 8.23, tanda B · AC 11): la configuración propia del arnés en ~/.tycon/config.json.
 * `set github.token` lee el valor de stdin (una tubería) o lo pide en la terminal, sin eco; nunca lo imprime ni lo
 * recibe por la línea de comandos (quedaría en el historial del shell). `paths.maintained` es la ruta del clon que la
 * máquina mantiene (de ahí leen los avisos lo que escriben los nocturnos; AC 18).
 */
function cmdConfig(ctx) {
  const GA = mod('github-auth');
  const [verb, key, argValue, ...rest] = ctx.args;
  if (!verb || !['set', 'unset', 'show'].includes(verb)) return { code: 2, lines: ['harness.js config: uso: config set <clave> [<valor>] (sin valor: por stdin, o pedido en la terminal) · config unset <clave> · config show'] };
  if (rest.length) return { code: 2, lines: [`harness.js config: un solo valor para ${key || 'la clave'} (sobran: ${rest.join(' ')})`] };
  if (verb === 'show') {
    const c = GA.readConfig({ env: ctx.env });
    if (!c.ok) return { code: 2, lines: [`harness.js config: ${c.reason}`] };
    const keys = [];
    for (const [section, v] of Object.entries(c.data)) if (v && typeof v === 'object') for (const k of Object.keys(v)) keys.push(`${section}.${k}`);
    return { code: 0, stdout: true, lines: [`${c.file}: ${keys.length ? `claves guardadas: ${keys.join(', ')} (los valores no se muestran)` : 'sin claves'}`] };
  }
  if (!key || !GA.KEYS.includes(key)) return { code: 2, lines: [`harness.js config: la clave tiene que ser una de ${GA.KEYS.join(', ')}${key ? ` (dice «${key}»)` : ''}`] };
  if (verb === 'unset') {
    const r = GA.setKey(key, null, { env: ctx.env, platform: ctx.platform });
    return r.ok ? { code: 0, lines: [`${key} sacada de ${r.file}`] } : { code: 2, lines: [`harness.js config: ${r.reason}`] };
  }
  // De dónde viene el valor (story 8.23, tanda G · AC 43; lo que la primera máquina migrada encontró el 2026-10-08):
  //   · por ARGUMENTO, para toda clave que no sea secreta: el permiso de GitHub no (quedaría en el historial del shell);
  //   · por STDIN (una tubería): hasta el fin de la entrada o el primer salto, ESPERANDO si todavía no hay nada —
  //     `gh auth token | … config set github.token` daba «EAGAIN … read» con fs.readFileSync(0): el escritor seguía vivo;
  //   · en la TERMINAL: el secreto sin eco y sin las marcas del pegado (prompt.readSecret); las demás claves con eco.
  const P = mod('prompt');
  let value = '';
  let secretNote = null;
  const unset = argValue === undefined || argValue === null;
  if (!unset) {
    if (GA.SECRET_KEYS.includes(key)) return { code: 2, lines: [`harness.js config: ${key === 'github.token' ? 'el permiso de GitHub' : 'el PAT de Azure DevOps'} no va por la línea de comandos (quedaría en el historial del shell): pegalo en la terminal —harness.js config set ${key} y Enter— o pasalo por stdin: printf '%s' '<permiso>' | harness.js config set ${key}`] };
    value = String(argValue);
  } else if (!P.isTerminal()) {
    const r = P.readAnswer();
    if (r.error) return { code: 2, lines: [`harness.js config: no pude leer el valor por stdin (${r.error})`] };
    value = r.text;
  } else if (GA.SECRET_KEYS.includes(key)) {
    process.stdout.write(`pegá ${key === 'github.token' ? 'el permiso de GitHub' : 'el PAT de Azure DevOps'} y Enter (no se muestra): `);
    const r = P.readSecret();
    if (r.error) return { code: 2, lines: [`harness.js config: no pude leer la terminal (${r.error}); no escribí nada`] };
    if (r.aborted) return { code: 130, lines: ['harness.js config: cancelado; no escribí nada'] };
    value = r.text;
    if (r.echoed) secretNote = 'ojo: esta terminal no deja apagar el eco: el permiso se vio en pantalla (si hay alguien más mirando, revocalo y creá otro)';
  } else {
    process.stdout.write(`valor para ${key}: `);
    value = P.readLine() || '';
  }
  value = String(value).replace(/\r?\n$/, '').trim();
  if (!value) return { code: 2, lines: [`harness.js config: el valor de ${key} llegó vacío; pasalo por stdin: printf '%s' '<valor>' | harness.js config set ${key}`] };
  if (GA.SECRET_KEYS.includes(key) && /\s/.test(value)) return { code: 2, lines: [`harness.js config: ${key === 'github.token' ? 'el permiso de GitHub' : 'el PAT de Azure DevOps'} no lleva espacios ni saltos de línea: ¿pegaste otra cosa?`] };
  // la ruta del clon que se mantiene tiene que ser absoluta y existir: una que no vale se diría «guardada» y los avisos
  // callarían sin que nadie sepa por qué (pase adversarial de la B)
  // `paths.maintainers` (story 8.26, tanda F1), lo mismo: el freno antes de publicar lee de ahí la lista privada, y una ruta
  // que no vale dejaría a la máquina de quien mantiene sin lista sin que nadie sepa por qué
  // `paths.team` y `paths.operations` (la página de configuración de la organización), lo mismo: una carpeta que no es un
  // clon se diría «guardada» y la página volvería a pedirla sin decir por qué
  const CLONE_KEYS = { 'paths.maintained': 'el clon que esta máquina mantiene', 'paths.maintainers': 'el clon del repo de mantenimiento', 'paths.team': 'el clon del perfil del equipo', 'paths.operations': 'el clon del repo de operaciones' };
  if (CLONE_KEYS[key]) {
    const what = CLONE_KEYS[key];
    const p = value.replace(/^~(?=\/|$)/, ctx.home);
    if (!path.isAbsolute(p)) return { code: 2, lines: [`harness.js config: ${key} tiene que ser una ruta absoluta (dice «${value}»)`] };
    if (!fs.existsSync(p)) return { code: 2, lines: [`harness.js config: ${key} apunta a una carpeta que no existe (${p})`] };
    if (!fs.existsSync(path.join(p, '.git'))) return { code: 2, lines: [`harness.js config: ${p} no es un clon de git: ${key} es ${what}`] };
    value = p;
  }
  // El archivo que queda tiene que poder leerlo quien lo lee (story 8.26, arreglo de la F1): el lector de configuración
  // de este arnés y, en la cuenta real de la máquina, la copia que el freno de producción tiene instalada. Si alguno lo
  // rechaza, no se escribe. Antes decía «guardada» y la configuración de la máquina quedaba inválida. Si quien rechaza es
  // el freno de producción (se actualiza sólo reinstalándolo, con permisos de administrador), se dice cómo seguir.
  const r = GA.setKeyChecked(key, value, { env: ctx.env, platform: ctx.platform });
  if (!r.ok) {
    const [first, ...more] = r.rejectedBy ? GA.rejectionLines(key, r) : [r.reason];
    return { code: 2, lines: [`harness.js config: ${first}`, ...more] };
  }
  return { code: 0, lines: [`${key} guardada en ${r.file} (sólo para tu usuario)`, ...(r.warning ? [r.warning] : []), ...(secretNote ? [secretNote] : [])] };
}

/**
 * `team-config` — la página local que muestra, de sólo lectura, la configuración de la organización (harness/team-config.js). Arranca un servidor en
 * 127.0.0.1, imprime la dirección (con su llave) y abre el navegador; el proceso sigue vivo hasta que la página se cierra
 * (botón «Cerrar la página») o Ctrl+C. Las carpetas de los clones salen de `--team-clone`/`--operations-clone` (sólo esta
 * vez) o de `paths.team`/`paths.operations`; si faltan, la página las pide y se guardan con `config set` (el mismo
 * camino y los mismos lectores que desde la terminal).
 */
function cmdTeamConfig(ctx) {
  const TC = mod('team-config');
  const clones = TC.declaredClones({ env: ctx.env });
  for (const [opt, id] of [['team-clone', 'repos'], ['operations-clone', 'operations']]) {
    if (ctx.opts[opt] === undefined) continue;
    const dir = path.resolve(String(ctx.opts[opt]).replace(/^~(?=[\\/]|$)/, ctx.home));
    const why = TC.cloneProblem(dir);
    if (why) return { code: 2, lines: [`harness.js team-config: --${opt}: ${why}`] };
    clones[id] = dir;
  }
  const setClone = (target, dir) => {
    const r = cmdConfig({ ...ctx, args: ['set', target.configKey, dir] });
    return { ok: r.code === 0, message: (r.lines || []).join(' ') };
  };
  TC.start({ tree: ctx.tree, clones, setClone, env: ctx.env, home: ctx.home }).then((p) => {
    process.stdout.write(`página de configuración de la organización: ${p.url}\n(sólo en esta máquina; se cierra con el botón «Cerrar la página» o con Ctrl+C)\n`);
    if (ctx.opts['no-open']) return;
    const [cmd, args] = TC.browserCommand(ctx.platform, p.url);
    const { spawn } = require('child_process');
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => process.stdout.write('no pude abrir el navegador: copiá la dirección de arriba\n'));
    child.unref();
  }, (e) => {
    process.stderr.write(`harness.js team-config: no pude abrir la página (${e && e.message ? e.message : e})\n`);
    process.exitCode = 2;
  });
  return { code: 0, lines: [] };
}

/** `team-init` (story 8.40, tanda B): el alta guiada, con los lectores del árbol INSTALADO (scripts/setup/harness/team-init.js). */
function cmdTeamInit(ctx) {
  const need = needState(ctx);
  if (need.fail) return { code: 2, lines: [`harness.js team-init: instalá primero el arnés (el alta valida con los lectores de la versión instalada): ${need.fail.line}`] };
  // la versión INSTALADA: en una máquina por versión publicada, la del estado (la que install guardó); el número derivado
  // del árbol daría el piso de version.json con `numbering: merge-tag`, y `install --version <piso>` bajaría a un commit
  // viejo (pase adversarial de la 8.40, clase 11). Desde un clon, el derivado (la etiqueta de HEAD, o el piso)
  const S = mod('state');
  const version = (S.isRelease(need.state) && need.state.version && need.state.version.number) || versionNumber(ctx, need.state);
  return mod('team-init').run({ ...ctx, tree: need.state.tree || ctx.tree, state: need.state, version });
}

const HANDLERS = {
  install: cmdInstall,
  startup: cmdStartup,
  config: cmdConfig,
  update: cmdUpdate,
  apply: cmdApply,
  version: cmdVersion,
  doctor: cmdDoctor,
  channel: cmdChannel,
  link: cmdLink,
  rollback: cmdRollback,
  uninstall: cmdUninstall,
  relocate: cmdRelocate,
  layer: cmdLayer,
  migrate: cmdMigrate,
  'team-config': cmdTeamConfig,
  'team-init': cmdTeamInit,
};

function main(argv) {
  const p = parse(argv);
  if (p.help) { process.stdout.write(usage() + '\n'); return 0; }
  if (p.error) { process.stderr.write(`harness.js: ${p.error}\n`); return 2; }
  const ctx = { tree: real(TREE) || TREE, home: os.homedir(), env: process.env, opts: p.opts, args: p.args, platform: process.platform };
  // la corrida desprendida de `startup` (story 8.23, tanda L) le anota su resultado al hook que la lanzó; también si sale
  // por un error que no pasa por acá
  const detachedRun = p.cmd === 'startup' && mod('detach').adoptDetachedRun();
  let r;
  try {
    r = HANDLERS[p.cmd](ctx) || { code: 0 };
  } catch (e) {
    // nunca una pila: una línea con el motivo (startup sale 0 igual: una sesión no se frena por el arnés)
    const line = `harness.js ${p.cmd}: falla interna: ${e && e.message ? e.message : e}`;
    try { mod('report').log(ctx.home, `${line}\n${e && e.stack ? e.stack : ''}`); } catch (_) { /* sin registro */ }
    r = { code: p.cmd === 'startup' ? 0 : 2, lines: [line] };
  }
  if (detachedRun) mod('detach').writeResult(r.code, r.lines || []);
  for (const l of r.lines || []) (r.code === 0 || r.stdout ? process.stdout : process.stderr).write(l + '\n');
  return r.code;
}

if (require.main === module) {
  // `process.exitCode`, no `process.exit()`: una escritura grande a una tubería se corta con exit() (incident-log 2026-09-28)
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { COMMANDS, NODE_FLOOR, TREE, parse, usage, main, requirementsFor, requirementChecks, findInPath, installPlan, fixedCopyFiles, managedBefore, installQuestions, codegraphInstall, doctorConfigItems };
