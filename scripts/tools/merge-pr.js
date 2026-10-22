#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * scripts/tools/merge-pr.js — lo que el skill de merge necesita saber y hacer cuando el repo vive en GitHub.
 *
 * POR QUÉ EXISTE. En Azure DevOps el servidor completa el pedido solo cuando sus controles dan verde. En GitHub eso
 * no está siempre (un repo privado sin plan pago no lo permite), un pedido trae VARIOS controles (el de la corrida de
 * la validación, uno por cada trabajo y los de otras herramientas) y el número de `version.json` —lo que una máquina
 * instalada compara para saber si hay algo nuevo— no lo pone una sincronización ni cada pedido. Con
 * `numbering: "merge-tag"` en `version.json`, el número lo pone el merge (una etiqueta
 * `v<número>`, scripts/ci/version-tag.js) y el pedido no lo toca: `bump-version` no hace nada y `check-version` pide que
 * el archivo quede igual. Este guion junta las partes mecánicas de ese camino, para que el skill no las haga a ojo:
 *
 *   plan            de qué servidor es `origin`, qué modo y qué control declara el repo, y qué paso del skill sigue.
 *                   Dice de dónde leyó el modo y el control (`configFrom`): `repo` o `maintainers` (ver abajo)
 *   update-branch  trae la rama destino a la rama de trabajo (lo único que resuelve solo: un choque en `version.json`)
 *   bump-version    el número que sigue; con --write lo deja en `version.json` (cambia SÓLO ese valor)
 *   wait-checks     espera EL control declarado sobre la punta del pedido y dice cómo terminó. Nunca mergea
 *   message         el título («asunto (#N)») y el cuerpo del commit de merge, sin marcas que salteen la CI
 *   check-version   ¿el número de `head` es mayor que el de `base`? Sólo lee: sirve de control en una validación
 *
 * LO QUE NO HACE, a propósito: no crea el pedido ni lo mergea. Esos dos `gh` los escribe el agente en la terminal, a la
 * vista del freno antes de publicar (scripts/hooks/public-push-guard.js), que lee la línea de comando y no lo que corre
 * adentro de un guion.
 *
 * HACIA DÓNDE FALLA. «No pude leer» nunca es «está bien»: un remoto ilegible, un `version.json` roto, un `gh` que no
 * contesta o una rama que no es la esperada salen 2 con su motivo. `wait-checks` da verde (0) sólo con el control
 * declarado en `SUCCESS` sobre la punta esperada; sin control declarado no elige uno.
 *
 * DE DÓNDE SALE LA CONFIGURACIÓN DEL MERGE (`merge.mode` y `merge.check`). De `.tycon/advisors.yaml` del repo, como
 * siempre (`configFrom: repo`); sin ese archivo, «empuje directo». Con UNA excepción: el clon del repo PÚBLICO del arnés.
 * Quien mantiene el arnés trabaja en ese clon, que no trae `.tycon/`: leído como «no declara nada», el plan mandaría a un
 * empuje directo a la rama principal del público. Su configuración vive en el clon PRIVADO de mantenimiento que la
 * máquina declara (`paths.maintainers`), y se lee de lo COMMITEADO en la rama principal remota de ese clon —nunca de su
 * árbol de trabajo: no depende de en qué rama esté parado ni de una edición sin commitear— (`configFrom: maintainers`).
 * Para ese repo, «no encontré la configuración» (la máquina no declara el clon, la carpeta no sirve, falta la rama, el
 * archivo, el bloque o el modo) sale 2 con el motivo: nunca termina en un empuje directo. `plan` y `wait-checks` leen
 * por el mismo camino. Esa lectura no trae nada del servidor: vale lo último que el clon de mantenimiento trajo.
 * «No sé si este repo es el público» tampoco es «no declara nada»: un `origin` que trae la ruta del público por una
 * dirección que no se reconoce como la suya, o una declaración del público que no se deja leer, salen 2 (la tabla
 * entera está en `mergeConfigFor`).
 *
 * DÓNDE CORREN LAS SUITES COMPLETAS. `plan` dice también si las suites completas del merge las corre el
 * servidor (`suites: "server"`) o esta máquina (`"machine"`), con qué regla y por qué (`suitesReason`, una línea). La
 * regla sale de `team-repos.json → merge_suites` de la raíz de este árbol (la configuración de la organización:
 * `automatico`, `siempre-en-la-maquina` o `confiar-en-el-servidor`, por repo o para toda la organización); sin esa
 * clave, `merge.mode: pr` del repo vale como `confiar-en-el-servidor` (la forma vieja, con `legacyNote`). Con
 * `automatico`, el plan le PREGUNTA a la plataforma —las políticas de la rama en Azure DevOps, las reglas de la rama en
 * GitHub— si la rama exige el pipeline de pruebas completas que la organización declaró para el repo. «No pude
 * preguntar» (sin `az`/`gh`, sin sesión, otra salida, algo que no es JSON, el tope de 30 s por llamada o de 90 s por
 * plan) nunca es «las corre el servidor»: es `machine`, y lo dice. Un `team-repos.json` ilegible tampoco frena el merge:
 * `machine` con el motivo. Dejarle las suites al servidor exige pedido: un empuje directo es siempre `machine`.
 * `--keep-mode <push|pr>` es para los planes posteriores al paso 0 del skill: el modo no cambia, y `suites` sólo puede
 * bajar de `server` a `machine` (si cambiara el modo a mitad de camino, el merge aprobado no ocurriría).
 *
 * Cada orden imprime un JSON en la salida y sale con su `code`. Uso: node scripts/tools/merge-pr.js --help
 *
 * Sin dependencias, en Windows y en Mac. `gh` se llama por su nombre; `TYCON_GH` lo reemplaza y es SÓLO de las pruebas
 * (un guion de Node, que corre igual en las dos plataformas). `az` igual, con `TYCON_ADO_CMD`; en Windows, `az` es un
 * `.cmd` que Node no lanza sin shell: va por el bash de Git (`runCheckLaunch` de portable-tools.js), nunca por `cmd /c`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const VO = require(path.join(__dirname, '..', 'setup', 'harness', 'version-order.js'));
const { identidadAzure, identidadRemoto, rutaLocalDe, esPublicoDeclarado, declaradas } = require(path.join(__dirname, '..', 'lib', 'harness-repo.js'));

const VERSION_FILE = 'version.json';
const CONFIG_FILE = path.join('.tycon', 'advisors.yaml');
// el mismo archivo como lo nombra git: con barras hacia adelante, también en Windows
const CONFIG_IN_GIT = '.tycon/advisors.yaml';
// GitHub atiende ssh también en `ssh.github.com` (el del puerto 443, para redes que cierran el 22)
const GITHUB_HOSTS = new Set(['github.com', 'ssh.github.com']);

const TREE = path.join(__dirname, '..', '..');
const TEAM_REPOS_FILE = 'team-repos.json';
// la política de «build validation» se reconoce por el nombre de su tipo, que la API devuelve igual en toda organización
const isBuildPolicy = (p) => Boolean(p && p.type && String(p.type.displayName || '').toLowerCase() === 'build');
const CALL_MS = 30000;
const PLAN_MS = 90000;

const USAGE = `uso: merge-pr.js <orden> [opciones]   (cada orden imprime un JSON y sale con su «code»)
  plan           --repo <dir> --source <rama> --target <rama> [--keep-mode <push|pr>]
  update-branch  --repo <dir> --source <rama> --target <rama>
  bump-version   --repo <dir> --source <rama> --target <rama> [--write]
  wait-checks    --repo <dir> --pr <n> --head <sha> --target <rama> [--check <nombre>] [--timeout-min 90] [--interval-s 30]
  message        --pr <n> --from <archivo del cuerpo> --to <archivo>
  check-version  --repo <dir> --base <ref> --head <ref>
plan dice de dónde leyó merge.mode y merge.check («configFrom»): «repo» (el .tycon/advisors.yaml del repo) o «maintainers»
(un clon del repo público del arnés, que no trae ese archivo: lo commiteado en la rama principal remota del clon de
mantenimiento que declara la máquina, paths.maintainers). wait-checks, sin --check, lee el control por el mismo camino.
plan dice además dónde corren las suites completas («suites»: server o machine), con qué regla («suitesRule», de
team-repos.json → merge_suites o de la forma vieja) y por qué («suitesReason»). --keep-mode fija el modo que decidió el
paso 0 del skill: el plan sólo recalcula «suites», que puede bajar de server a machine y nunca cambia el paso.
`;

// ── git y gh ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** El ambiente para git: sin lo que deja puesto un hook de git (correría contra OTRO repo sin avisar). */
function cleanEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || process.env)) {
    if (!['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'].includes(k)) out[k] = v;
  }
  // un `fetch` que pide una clave se quedaría esperando para siempre: que falle y se diga
  if (out.GIT_TERMINAL_PROMPT === undefined) out.GIT_TERMINAL_PROMPT = '0';
  return out;
}

/** Corre git en `repo`. Devuelve `{ ok, status, out, err }`: `out` sin recortar (un archivo se lee tal cual). */
function realGit(repo, args, deps = {}) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: cleanEnv(deps.env), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const status = r.error ? -1 : r.status;
  return { ok: status === 0, status, out: r.stdout || '', err: String((r.error && r.error.message) || r.stderr || '').trim() };
}
/** Lo mismo, pasando por `deps.git` si viene: las pruebas lo usan para hacer fallar UNA llamada (un git que no contesta). */
function git(repo, args, deps = {}) {
  return deps.git ? deps.git(repo, args, () => realGit(repo, args, deps)) : realGit(repo, args, deps);
}

/**
 * La raíz del repo de una carpeta. Todo lo demás trabaja sobre ELLA: `git -C` acepta una subcarpeta, pero la
 * configuración del repo y `version.json` viven en la raíz, y leídos desde una subcarpeta «no están» — que se leería
 * como «este repo no declara nada» o «no numera versiones».
 */
function rootOf(repo, deps = {}) {
  const top = git(repo, ['rev-parse', '--show-toplevel'], deps);
  if (!top.ok || !top.out.trim()) return { problem: `no pude leer el repo ${repo}: ${firstLine(top.err) || 'git no contestó'}` };
  return { root: top.out.trim() };
}

/** Lo que devuelve `spawnSync`, con la forma de las demás llamadas: `timedOut` y `notFound` dicen cómo falló. */
function spawned(r) {
  const code = r.error && r.error.code;
  return { status: r.error ? -1 : r.status, stdout: r.stdout || '', stderr: String((r.error && r.error.message) || r.stderr || '').trim(),
    timedOut: code === 'ETIMEDOUT', notFound: code === 'ENOENT' };
}

/**
 * Corre `gh`. Por defecto el de la máquina; `TYCON_GH` (sólo pruebas) lo reemplaza, y si es un `.js` corre con Node.
 * Con `timeoutMs` (las consultas del plan), además con la entrada cerrada: un `gh` que pide algo falla en vez de esperar.
 */
function realGh(args, { cwd, env, timeoutMs } = {}) {
  const bin = (env || process.env).TYCON_GH || 'gh';
  const viaNode = /\.[cm]?js$/i.test(bin);
  const opts = { encoding: 'utf8', cwd, env: env || process.env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  if (timeoutMs) Object.assign(opts, { timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  return spawned(spawnSync(viaNode ? process.execPath : bin, viaNode ? [bin, ...args] : args, opts));
}

/**
 * Con qué se lanza `az`: `TYCON_ADO_CMD` (sólo pruebas; un `.js` corre con Node) o `az`. En Windows `az` es un `.cmd`, que
 * Node no lanza sin shell: va por el bash de Git con `runCheckLaunch` (portable-tools.js explica por qué no `cmd /c`).
 * `{ file: null, error }` = no se lanza. `ctx` (`platform`, `env`, `exists`, `findGitBash`) es para las pruebas.
 */
function azLaunch(args, ctx = {}) {
  const env = ctx.env || process.env;
  const bin = env.TYCON_ADO_CMD || 'az';
  if (/\.[cm]?js$/i.test(bin)) return { file: process.execPath, args: [bin, ...args], error: null };
  const platform = ctx.platform || process.platform;
  if (platform !== 'win32') return { file: bin, args, error: null };
  let tools;
  try { tools = require(path.join(TREE, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'portable-tools.js')); } catch (e) {
    return { file: null, args, error: `no encuentro cómo lanzar az en Windows (skills/tycon-pipeline/scripts/lib/portable-tools.js: ${(e && e.code) || firstLine(e && e.message)})` };
  }
  const launch = tools.runCheckLaunch([bin, ...args], { platform, env, harnessDir: TREE, exists: ctx.exists, findGitBash: ctx.findGitBash });
  // «no lo encontré» en el PATH: que lo diga el error de spawn (ENOENT), como en Mac
  return launch;
}

/** Corre `az` sin esperar nada de nadie: la entrada cerrada, sin colores, sin instalar extensiones, con un tope. */
function realAz(args, ctx = {}) {
  const launch = azLaunch(args, ctx);
  if (!launch.file) return { status: -1, stdout: '', stderr: launch.error, notLaunched: true };
  const env = Object.assign({}, ctx.env || process.env, { AZURE_CORE_NO_COLOR: '1', AZURE_CORE_ONLY_SHOW_ERRORS: '1', AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no' });
  return spawned(spawnSync(launch.file, launch.args, { encoding: 'utf8', env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: ctx.timeoutMs || CALL_MS, maxBuffer: 64 * 1024 * 1024 }));
}

/** El servidor que dice la salida de `ssh -G <alias>` (su renglón `hostname …`), en minúsculas; `null` si no lo trae. */
function parseSshHostname(text) {
  const m = /^hostname[ \t]+(\S+)[ \t]*$/im.exec(String(text || ''));
  return m ? m[1].toLowerCase() : null;
}

/** A qué servidor lleva un alias de ssh (`git@trabajo:…`): lo dice `ssh -G`, sin conectarse. `null` = no se sabe. */
function realSshHost(host, { env } = {}) {
  // el alias sale de la dirección del remoto, que es texto de afuera: nunca como una opción de ssh
  if (!host || /^-/.test(host)) return null;
  const r = spawnSync('ssh', ['-G', '--', host], { encoding: 'utf8', env: env || process.env, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return parseSshHostname(r.stdout);
}

function realSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const stop = (reason, extra = {}) => Object.assign({ code: 2, reason }, extra);
const firstLine = (text) => String(text || '').split('\n')[0];

// ── la configuración del repo ────────────────────────────────────────────────────────────────────────────────────────

/**
 * El valor de `clave: valor`: con sus comillas afuera; sin comillas, lo que sigue a un `#` suelto es un comentario, y
 * `null`, `~` o nada es «sin valor» (`null`). Una forma que este lector no sabe leer —un bloque `|` o `>`, una lista o
 * un mapa en la misma línea— TIRA: leída a medias sería otro valor, y acá el valor es el nombre de un control.
 */
function scalar(raw, key) {
  const v = String(raw).trim();
  const quoted = /^(["'])([\s\S]*?)\1\s*(#.*)?$/.exec(v);
  if (quoted) return quoted[2];
  const bare = v.replace(/(^|\s)#.*$/, '').trim();
  if (bare === '' || bare === '~' || /^null$/i.test(bare)) return null;
  if (/^[|>[{&*!]/.test(bare)) throw new Error(`merge.${key}: no sé leer ese valor (${bare.slice(0, 20)}): escribilo en una línea, entre comillas`);
  return bare;
}

/**
 * `merge.mode` y `merge.check` de `.tycon/advisors.yaml` (el de la RAÍZ del repo). Sin archivo o sin la llave:
 * `{ mode: 'push', check: null }`. El nombre del control se devuelve TAL CUAL (los de verdad traen espacios y
 * paréntesis). Sólo mira el bloque `merge:` de primer nivel: un `check:` de otro bloque no es éste. Un renglón vacío o
 * un comentario —también en la primera columna— no cierra el bloque. Lo que no sabe leer (`merge:` con su valor en la
 * misma línea, un valor en bloque) tira: no se lee como «el repo no declara nada».
 */
function readMergeConfig(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { mode: 'push', check: null }; throw e; }
  return parseMergeConfig(text);
}

/** Lo mismo, del TEXTO del archivo: venga del disco o de un commit (`git show`). */
function parseMergeConfig(text) {
  const found = scanMergeBlock(text);
  return { mode: found.mode || 'push', check: found.check };
}

/**
 * Lo que el texto DICE, sin el valor de siempre: `block` (¿trae el bloque `merge:`?), `mode` (`null` si no lo declara) y
 * `check`. Quien lee la configuración de otro repo necesita distinguir «declara push» de «no declara nada».
 */
function scanMergeBlock(text) {
  const out = { block: false, mode: null, check: null };
  let inside = false;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;   // vacío o comentario, esté donde esté
    if (/^\S/.test(line)) {
      const top = /^merge\s*:(.*)$/.exec(line);
      inside = Boolean(top);
      if (top) out.block = true;
      if (top && top[1].replace(/(^|\s)#.*$/, '').trim()) throw new Error('merge: con su valor en la misma línea no lo sé leer: escribilo como un bloque (mode y check, cada uno en su renglón)');
      continue;
    }
    if (!inside) continue;
    const m = /^\s+(mode|check)\s*:(.*)$/.exec(line);
    if (!m) continue;
    const value = scalar(m[2], m[1]);
    // un modo que no se conoce (`PR`, `pull-request`) no es «el repo no declara nada»: leído así, el skill empujaría directo
    if (m[1] === 'mode' && value && value !== 'push' && value !== 'pr') throw new Error(`merge.mode: «${value}» no es push ni pr`);
    if (m[1] === 'mode' && value) out.mode = value;
    if (m[1] === 'check') out.check = value || null;   // `check: ""` tampoco es un control
  }
  return out;
}

// ── de dónde sale la configuración del merge ─────────────────────────────────────────────────────────────────────────

/** Una dirección que va por ssh: toda la que no trae esquema (la forma `[usuario@]servidor:ruta`) y las `ssh://`. */
const isSshUrl = (url) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(ssh|git\+ssh|ssh\+git):\/\//i.test(url);

/** La carpeta de verdad (sin enlaces, con la caja del disco): para comparar la que declara la máquina con la que dice git. */
function realPath(p) {
  try { return fs.realpathSync.native(String(p)); } catch (_) { return path.resolve(String(p)); }
}

/** Lo que la máquina declara como su clon de mantenimiento: `{ declared, path, problem }` (scripts/setup/harness/tycon-home.js). */
function machineMaintainers({ env }) {
  return require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')).maintainersClone({ env });
}

/**
 * La configuración del merge de un repo (su raíz) y de dónde salió: `{ mode, check, configFrom, declaredIn, note? }`, o
 * `{ problem }` si no se pudo leer. `whereOf()` dice de qué servidor es `origin` (lo de `hostOf`): sólo se le pregunta
 * si el repo no trae el archivo. El por qué del camino del clon de mantenimiento está en la cabecera.
 *   · el repo trae `.tycon/advisors.yaml` → el suyo (`configFrom: 'repo'`), declare lo que declare la máquina;
 *   · no lo trae y es el repo PÚBLICO que el arnés declara → el del clon de mantenimiento, o un problema;
 *   · no lo trae y es cualquier otro repo → `mode: 'push'`, como siempre.
 * `deps.isPublic`, `deps.publicDeclarations` y `deps.maintainers` reemplazan al reconocedor, a las declaraciones del
 * árbol que no se dejaron leer y a la declaración de la máquina: SÓLO las pruebas.
 */
function mergeConfigFor(repo, whereOf, deps = {}) {
  let text = null;
  try { text = fs.readFileSync(path.join(repo, CONFIG_FILE), 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') return { problem: `no pude leer ${CONFIG_FILE}: ${e.message}` };
  }
  if (text !== null) {
    try { return Object.assign(parseMergeConfig(text), { configFrom: 'repo', declaredIn: CONFIG_FILE }); } catch (e) { return { problem: `no pude leer ${CONFIG_FILE}: ${e.message}` }; }
  }
  const where = whereOf();
  if (where.problem) return { problem: where.problem };
  // Sin archivo propio decide de qué servidor es `origin` y qué se sabe del público. La tabla entera (cada celda tiene
  // su caso en la prueba T78 «la tabla entera»); «duda» es salir 2, nunca un empuje directo:
  //
  //   servidor de origin            | declaración LEGIBLE                              | declaración ILEGIBLE
  //   ------------------------------+--------------------------------------------------+----------------------------------
  //   GitHub                        | es el público → clon de mantenimiento (o duda)   | lo que se reconoce, igual;
  //                                 | otro repo → push                                 | lo demás → duda (la nombra)
  //   no reconocido («other»)       | trae la ruta del público → duda                  | duda (la nombra)
  //                                 | otra ruta → push                                 |
  //   Azure · una carpeta · ninguno | push                                             | push
  //
  // «No reconocido» es todo lo que `hostOf` no supo llamar GitHub: un alias de ssh que ssh no resuelve, y también otro
  // NOMBRE del mismo servidor por https (`www.github.com`, `github.com.` con el punto final: GitHub los redirige y el
  // empuje entra igual). Por eso la duda no mira el esquema de la dirección: mira su ruta.
  const isPublic = (ghRepo) => Boolean(ghRepo) && Boolean((deps.isPublic || esPublicoDeclarado)(identidadRemoto(`https://github.com/${ghRepo}`)));
  // Por su identidad de GitHub, armada con el nombre que ya resolvió `hostOf`: un alias de ssh y el servidor del puerto
  // 443 nombran al mismo repo que `github.com/<dueño>/<repo>`, y comparados por su dirección no serían el público.
  if (where.host === 'github' && where.ghRepo && isPublic(where.ghRepo)) return maintainersMergeConfig(deps);
  if (where.host !== 'github' && where.host !== 'other') return { mode: 'push', check: null, configFrom: 'repo', declaredIn: CONFIG_FILE };
  // De acá en más, dos formas de «no sé si es el público», que tampoco son «no declara nada»:
  //   · la dirección trae la RUTA del público y no se la reconoce como la suya;
  if (isPublic(ownerRepoOf(where.url))) {
    return { problem: `no sé si este repo es el público del arnés: origin (${withoutCredentials(where.url)}) trae su ruta (dueño/repo), pero no reconozco esa dirección como la suya en GitHub. Si lo es, escribila con github.com («git remote set-url origin …») o, si es un alias de ssh, revisá «ssh -G» de ese alias. Sin saberlo, y sin ${CONFIG_FILE} en el repo, no elijo un empuje directo` };
  }
  //   · una declaración del público que está y no se deja leer: el reconocedor contesta «no» por no poder leerla, así
  //     que tampoco se sabe qué ruta es la del público.
  const unreadable = (deps.publicDeclarations || (() => declaradas().ilegibles))();
  if (Array.isArray(unreadable) && unreadable.length) return { problem: `no pude leer cuál es el repo público que el arnés declara (${unreadable.map((u) => u.ruta).join(', ')}): sin saber si este clon lo es, y sin ${CONFIG_FILE} en el repo, no elijo un empuje directo` };
  return { mode: 'push', check: null, configFrom: 'repo', declaredIn: CONFIG_FILE };
}

/**
 * El `dueño/repo` que nombra una dirección: los DOS ÚLTIMOS tramos de su ruta, sin caja, sin `.git` y sin lo que siga a
 * un `?` o un `#`. `null` si no trae dos. Sirve para sospechar, no para reconocer: vale también para una dirección que
 * el lector de remotos no sabe leer, y para una ruta con algo adelante (un espejo bajo un grupo).
 */
function ownerRepoOf(url) {
  const id = identidadRemoto(url);
  const route = id ? id.ruta : String(url || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/i, '');
  const parts = String(route).replace(/[?#].*$/, '').replace(/[\\/]+$/, '').replace(/\.git$/i, '').split(/[\\/:]+/).filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase() : null;
}

/** Una dirección sin el usuario ni la clave que traiga escritos (`https://usuario:clave@servidor/…`): para un mensaje. */
// hasta el ÚLTIMO `@` antes de la primera `/` del servidor: una clave puede traer un `@` escrito (`usuario:p@ss@servidor`)
const withoutCredentials = (url) => String(url || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1');

/**
 * La configuración del merge del clon del PÚBLICO: el bloque `merge:` de lo commiteado en la rama principal remota del
 * clon de mantenimiento que la máquina declara. Cada forma de no encontrarla es un problema que dice qué falta.
 */
function maintainersMergeConfig(deps = {}) {
  const fix = '«harness.js config set paths.maintainers <la carpeta de tu clon de mantenimiento>»';
  const whose = `este clon es el del repo público del arnés y no trae ${CONFIG_FILE}: su configuración del merge se lee del clon de mantenimiento que declara la máquina (paths.maintainers)`;
  const missing = (what) => ({ problem: `${whose}, y ${what}. No elijo un empuje directo a la rama principal del público` });
  let declared;
  try { declared = (deps.maintainers || machineMaintainers)({ env: deps.env || process.env }); } catch (e) { return missing(`no pude leer lo que la máquina declara (${firstLine(e && e.message)})`); }
  if (!declared || (!declared.declared && !declared.problem)) return missing(`esta máquina no declara ninguno. Declaralo con ${fix}`);
  if (declared.problem || !declared.path) return missing(`esa declaración no sirve: ${declared.problem || 'no trae una carpeta'}. Corregila con ${fix}`);
  const clone = declared.path;
  // sólo la RAÍZ de un clon: desde una carpeta que dejó de serlo, git contestaría con el repo de arriba
  const top = git(clone, ['rev-parse', '--show-toplevel'], deps);
  if (!top.ok || !top.out.trim() || realPath(top.out.trim()) !== realPath(clone)) return missing(`la carpeta declarada (${clone}) no es la raíz de un clon de git. Corregila con ${fix}`);
  // La rama principal del remoto: la que dejó escrita el `git clone` (`origin/HEAD`); sin ella, `origin/main`. El nombre
  // de la rama no va a ningún mensaje: es del repo privado.
  let ref = 'refs/remotes/origin/main';
  const head = git(clone, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], deps);
  if (head.ok) {
    if (!/^refs\/remotes\/origin\/\S+$/.test(head.out.trim())) return missing(`no entiendo cuál es la rama principal remota de ese clon (${clone})`);
    ref = head.out.trim();
  } else if (head.status !== 1) {
    return missing(`git no pudo decir cuál es la rama principal remota de ese clon (${clone}): ${firstLine(head.err) || `salió ${head.status}`}`);
  }
  const tip = commitOf(clone, ref, deps);
  if (tip.problem) return missing(`git no pudo leer la rama principal remota de ese clon (${clone}): ${tip.problem}`);
  if (!tip.sha) return missing(`ese clon (${clone}) no conoce su rama principal remota: traela con «git -C ${clone} fetch origin»`);
  // el archivo se mira y se lee del MISMO commit
  const ls = git(clone, ['ls-tree', '--end-of-options', tip.sha, '--', CONFIG_IN_GIT], deps);
  if (!ls.ok) return missing(`no pude mirar ${CONFIG_IN_GIT} en la rama principal remota de ese clon (${clone}): ${firstLine(ls.err) || `git salió ${ls.status}`}`);
  if (!ls.out.trim()) return missing(`lo commiteado en la rama principal remota de ese clon (${clone}) no trae ${CONFIG_IN_GIT}`);
  const show = git(clone, ['show', '--end-of-options', `${tip.sha}:${CONFIG_IN_GIT}`], deps);
  if (!show.ok) return missing(`no pude leer ${CONFIG_IN_GIT} de la rama principal remota de ese clon (${clone}): ${firstLine(show.err) || `git salió ${show.status}`}`);
  const declaredIn = `${CONFIG_IN_GIT} del clon de mantenimiento (paths.maintainers: ${clone}; lo commiteado en su rama principal remota)`;
  let found;
  // un archivo que está y no se deja leer no es «no declara nada», tampoco acá
  try { found = scanMergeBlock(show.out); } catch (e) { return { problem: `no pude leer ${declaredIn}: ${e.message}` }; }
  if (!found.block) return missing(`${declaredIn} no trae el bloque merge: (mode y check)`);
  if (!found.mode) return missing(`el bloque merge: de ${declaredIn} no declara merge.mode`);
  return { mode: found.mode, check: found.check, configFrom: 'maintainers', declaredIn,
    note: `este clon es el del repo público del arnés y no trae ${CONFIG_FILE}: merge.mode y merge.check se leyeron de ${declaredIn}, como ese clon la trajo por última vez` };
}

// ── de qué servidor es el repo ───────────────────────────────────────────────────────────────────────────────────────

/**
 * De qué servidor es `origin`: `azure`, `github`, `local` (una carpeta: el clon de un clon), `other` o `none` (sin
 * `origin`). Con `problem` si no se pudo leer — que no es lo mismo que no tener remoto.
 */
function hostOf(repo, deps = {}) {
  const at = rootOf(repo, deps);
  if (at.problem) return { problem: at.problem };
  const remotes = git(repo, ['remote'], deps);
  if (!remotes.ok) return { problem: `no pude leer los remotos de ${repo}: ${firstLine(remotes.err) || 'git no contestó'}` };
  if (!remotes.out.split(/\r?\n/).map((l) => l.trim()).includes('origin')) return { host: 'none' };
  const got = git(repo, ['remote', 'get-url', 'origin'], deps);
  if (!got.ok) return { problem: `no pude leer la dirección de origin: ${firstLine(got.err) || 'git no contestó'}` };
  const url = got.out.trim();
  const azure = identidadAzure(url);
  if (azure) return { host: 'azure', url, org: azure.org, project: azure.proyecto, name: azure.nombre };
  if (rutaLocalDe(url, at.root)) return { host: 'local', url };
  const id = identidadRemoto(url);
  if (!id) return { host: 'other', url };
  const parts = id.ruta.split('/');
  const asGithub = () => (parts.length === 2 ? { host: 'github', url, ghRepo: `${parts[0]}/${parts[1]}`, owner: parts[0], name: id.nombre } : { host: 'other', url });
  if (GITHUB_HOSTS.has(id.host)) return asGithub();
  // un alias de ssh (`git@trabajo:dueño/repo` o `trabajo:dueño/repo`, el de quien tiene varias cuentas): lo que es lo
  // dice ssh, no el nombre. Va por ssh toda dirección sin esquema (la forma `[usuario@]servidor:ruta`) y las `ssh://`
  if (isSshUrl(url) &&!/^-/.test(id.host) && GITHUB_HOSTS.has((deps.sshHost || realSshHost)(id.host, { env: deps.env }))) return asGithub();
  return { host: 'other', url };
}

/** El archivo donde va el cuerpo del pedido (y el del commit de merge): en la carpeta temporal de la MÁQUINA —la que ven
 *  igual bash y Node, también en Windows—, uno por repo y por rama, con barras hacia adelante. */
function bodyFiles(repo, source) {
  let real = repo;
  try { real = fs.realpathSync(repo); } catch (_) { /* una carpeta que no está: vale su ruta */ }
  const print = crypto.createHash('sha256').update(`${real}\n${source}`).digest('hex').slice(0, 12);
  const at = (suffix) => path.join(os.tmpdir(), `tycon-merge-pr-${print}${suffix}.md`).split(path.sep).join('/');
  return { bodyFile: at(''), mergeBodyFile: at('-merge') };
}

// ── dónde corren las suites completas ───────────────────────────────────────────────────────────────────

/** `team-repos.json` de la raíz de este árbol: `{ absent: true }` si no está; si no, lo que da su lector (`load`). */
function readTeamRepos() {
  const file = path.join(TREE, TEAM_REPOS_FILE);
  // sólo «no existe» es ausente: un archivo que está y no se deja mirar (permisos) es «no pude leer»
  try { fs.statSync(file); } catch (e) {
    if (e && e.code === 'ENOENT') return { absent: true };
    return { ok: false, problems: [{ path: '', message: `no pude mirarlo: ${(e && e.code) || firstLine(e && e.message)}` }] };
  }
  return require(path.join(TREE, 'scripts', 'lib', 'team-repos.js')).load(file);
}

/**
 * Un preguntador a un CLI que devuelve JSON, con los dos topes (por llamada y por plan) y la regla de la primera falla:
 * después de una, no pregunta más. `ask(args)` → `{ ok: true, data }` o `{ ok: false, why }`.
 */
function asker(run, name, budget, now) {
  return (args) => {
    if (budget.failed) return { ok: false, why: budget.failed };
    const left = budget.end - now();
    const fail = (why) => { budget.failed = why; return { ok: false, why }; };
    if (left <= 0) return fail(`pasó el tope de ${PLAN_MS / 1000} s del plan`);
    const r = run(args, Math.min(CALL_MS, left)) || {};
    if (r.timedOut) return fail(`pasó el tope de ${CALL_MS / 1000} s por llamada`);
    if (r.notFound) return fail(`${name} no está instalado o no está en el PATH`);
    if (r.status !== 0) return fail(firstLine(r.stderr) || `${name} salió ${r.status}`);
    try { return { ok: true, data: JSON.parse(r.stdout) }; } catch (_) { return fail(`${name} contestó algo que no es JSON`); }
  };
}

/** ¿Esta política de build de Azure frena la rama `target` de este repo? `[]` si cuenta; si no, por qué no. */
function policyFaults(p, repoId, target, defaultBranch) {
  const s = (p && p.settings) || {};
  const out = [];
  if (p.isEnabled !== true) out.push('apagada');
  if (p.isBlocking !== true) out.push('opcional');
  if (p.isDeleted === true) out.push('borrada');
  if (Array.isArray(s.filenamePatterns) ? s.filenamePatterns.length : s.filenamePatterns !== undefined && s.filenamePatterns !== null) {
    out.push(`con filtros de archivos (${[].concat(s.filenamePatterns).join(', ')}): no corre para todo cambio`);
  }
  const ref = `refs/heads/${target}`;
  const covers = (Array.isArray(s.scope) ? s.scope : []).some((sc) => {
    if (!sc || (sc.repositoryId !== undefined && sc.repositoryId !== null && sc.repositoryId !== repoId)) return false;
    const kind = String(sc.matchKind || '').toLowerCase();
    if (kind === 'exact') return String(sc.refName || '') === ref;
    if (kind === 'prefix') return Boolean(sc.refName) && ref.startsWith(String(sc.refName));
    if (kind === 'defaultbranch') return Boolean(defaultBranch) && ref === defaultBranch;
    return false;
  });
  if (!covers) out.push(`su alcance no cubre este repo y la rama ${target}`);
  return out;
}

/**
 * Lo que contesta Azure DevOps sobre la rama destino: `{ answer, detail, pipeline }`. `pipeline` es lo declarado (texto o
 * número; `null` con `confiar`, que sólo pregunta si la rama exige algún control). Corta en la primera falla.
 */
function azureBranchAnswer(where, target, declared, ask) {
  const couldNot = (why) => ({ answer: 'could-not-ask', detail: `no pude preguntarle a Azure DevOps (${why})`, pipeline: null });
  // Los nombres salen del remoto (texto de afuera): la organización va escapada en la dirección, y cada valor se pasa
  // pegado a su opción (`--opción=valor`), así uno que empieza con `-` no se lee como otra opción
  const odd = [where.org, where.project, where.name, target].find((v) => !v || /[\u0000-\u001f]/.test(String(v)));
  if (odd !== undefined) return couldNot('el remoto o la rama traen un nombre vacío o con caracteres de control');
  const common = [`--org=https://dev.azure.com/${encodeURIComponent(where.org)}`, `--project=${where.project}`, '-o', 'json'];
  const repo = ask(['repos', 'show', `--repository=${where.name}`, ...common]);
  if (!repo.ok) return couldNot(repo.why);
  if (!repo.data || typeof repo.data.id !== 'string') return couldNot('no dijo el id del repo');
  const list = ask(['repos', 'policy', 'list', `--repository-id=${repo.data.id}`, `--branch=refs/heads/${target}`, ...common]);
  if (!list.ok) return couldNot(list.why);
  if (!Array.isArray(list.data)) return couldNot('la lista de políticas no es una lista');
  // una política que nombra un pipeline y no dice que es de build (sin nombre de tipo, o traducido) no se descarta en
  // silencio: no se sabe qué es, así que no se puede juzgar la rama
  if (list.data.some((p) => p && !isBuildPolicy(p) && p.settings && p.settings.buildDefinitionId !== undefined)) {
    return couldNot('una política de la rama nombra un pipeline y no dice que sea de build');
  }
  const builds = list.data.filter(isBuildPolicy);
  // una política de build que no dice qué pipeline exige no se puede juzgar: no se adivina
  // sólo un entero mayor que cero, o un texto de dígitos: `true` o `[7]` también pasarían por Number()
  const idOf = (v) => (Number.isInteger(v) && v > 0 ? v : typeof v === 'string' && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null);
  if (builds.some((p) => idOf(p.settings && p.settings.buildDefinitionId) === null)) {
    return couldNot('una política de build de la rama no dice qué pipeline exige');
  }
  const judged = builds.map((p) => ({ p, id: idOf(p.settings.buildDefinitionId), faults: policyFaults(p, repo.data.id, target, repo.data.defaultBranch) }));
  const counting = judged.filter((j) => !j.faults.length);
  if (declared === null) {
    // `confiar`: ¿la rama exige algún control?
    if (counting.length) return { answer: 'requires-other', detail: `la rama ${target} exige ${counting.length === 1 ? 'el pipeline' : 'los pipelines'} ${counting.map((j) => j.id).join(', ')}`, pipeline: null };
    return { answer: 'requires-none', detail: `la rama ${target} no exige ningún control`, pipeline: null };
  }
  // el pipeline declarado: un id (número, o texto sólo de dígitos) o un nombre exacto
  let pipeline;
  if (Number.isInteger(declared) || /^\d+$/.test(String(declared))) {
    pipeline = { declared, id: Number(declared), name: null };
  } else {
    const found = ask(['pipelines', 'list', `--name=${declared}`, ...common]);
    if (!found.ok) return couldNot(found.why);
    if (!Array.isArray(found.data)) return couldNot('la lista de pipelines no es una lista');
    const same = found.data.filter((d) => d && typeof d.name === 'string' && d.name.toLowerCase() === String(declared).toLowerCase());
    if (!same.length) return { answer: 'not-effective', detail: `el pipeline «${declared}» no existe en el proyecto ${where.project}`, pipeline: { declared, id: null, name: null } };
    if (same.length > 1) return { answer: 'not-effective', detail: `hay ${same.length} pipelines que se llaman «${declared}» en el proyecto ${where.project} (${same.map((d) => d.id).join(', ')}): declaralo por id`, pipeline: { declared, id: null, name: null } };
    pipeline = { declared, id: Number(same[0].id), name: same[0].name };
  }
  const label = () => `«${pipeline.name || pipeline.declared}»${pipeline.name && String(pipeline.declared) !== String(pipeline.id) ? ` (id ${pipeline.id})` : ''}`;
  const mine = judged.filter((j) => j.id === pipeline.id);
  const required = mine.find((j) => !j.faults.length);
  if (required) {
    if (pipeline.name === null) {
      // el nombre sólo para decirlo: si no se lee, la decisión no cambia
      const shown = ask(['pipelines', 'show', `--id=${pipeline.id}`, ...common]);
      if (shown.ok && shown.data && typeof shown.data.name === 'string') pipeline.name = shown.data.name;
    }
    const manual = required.p.settings && required.p.settings.manualQueueOnly ? ' (la política la encola a mano: el pedido espera a que alguien la corra)' : '';
    return { answer: 'requires-declared', detail: `la rama ${target} exige el pipeline de pruebas completas ${label()}${manual}`, pipeline };
  }
  if (mine.length) return { answer: 'not-effective', detail: `la política de la rama ${target} que nombra el pipeline ${label()} no cuenta: ${mine[0].faults.join(', ')}`, pipeline };
  if (counting.length) return { answer: 'requires-other', detail: `la rama ${target} exige otro pipeline (${counting.map((j) => j.id).join(', ')}), no el de pruebas completas ${label()}`, pipeline };
  return { answer: 'requires-none', detail: `la rama ${target} no exige ningún pipeline`, pipeline };
}

/** Lo que contesta GitHub sobre la rama destino: los controles obligatorios (reglas activas + protección clásica) y la cola. */
function githubBranchAnswer(where, target, declared, ask) {
  const [owner, name] = String(where.ghRepo).split('/');
  const couldNot = (why) => ({ answer: 'could-not-ask', detail: `no pude preguntarle a GitHub (${why})`, pipeline: null, mergeQueue: null });
  // el dueño y el repo salen del remoto: sólo los nombres que GitHub acepta, y escapados en la ruta de la API
  const ghName = /^[A-Za-z0-9._-]+$/;
  if (!ghName.test(owner || '') || !ghName.test(name || '') || owner === '..' || name === '..' || !target) return couldNot(`el repo del remoto («${where.ghRepo}») no tiene la forma dueño/repo de GitHub`);
  const branch = encodeURIComponent(target);
  // GitHub pagina las reglas de la rama (30 por defecto): se piden de a 100 hasta una página incompleta. Un control
  // obligatorio en la página 2 que no se leyera sería un «no exige» falso. `--paginate` no sirve: pega las listas.
  const all = [];
  for (let page = 1; ; page += 1) {
    const got = ask(['api', `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/rules/branches/${branch}?per_page=100&page=${page}`]);
    if (!got.ok) return couldNot(got.why);
    if (!Array.isArray(got.data)) return couldNot('las reglas de la rama no son una lista');
    all.push(...got.data);
    if (got.data.length < 100) break;
    if (page >= 20) return couldNot('la rama trae más de 2000 reglas: no las leo todas');
  }
  const rules = { data: all };
  const info = ask(['api', `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/${branch}`]);
  if (!info.ok) return couldNot(info.why);
  // una respuesta con otra forma no es «no exige nada»: es «no entendí lo que contestó»
  const odd = (what) => couldNot(`contestó ${what} con una forma que no conozco`);
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const listOr = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : null);
  if (!isObj(info.data)) return odd('la rama');
  const required = new Set();
  for (const r of rules.data) {
    if (!r || r.type !== 'required_status_checks') continue;
    const checks = listOr(isObj(r.parameters) ? r.parameters.required_status_checks : undefined);
    if (checks === null) return odd('las reglas de la rama');
    for (const c of checks) if (c && c.context) required.add(c.context);
  }
  if (info.data.protection !== undefined && info.data.protection !== null && !isObj(info.data.protection)) return odd('la protección de la rama');
  const classic = info.data.protection ? info.data.protection.required_status_checks : undefined;
  if (classic !== undefined && classic !== null && !isObj(classic)) return odd('la protección de la rama');
  if (classic && classic.enforcement_level !== 'off') {
    const contexts = listOr(classic.contexts);
    const checks = listOr(classic.checks);
    if (contexts === null || checks === null) return odd('la protección de la rama');
    for (const c of contexts) required.add(c);
    for (const c of checks) if (c && c.context) required.add(c.context);
  }
  const mergeQueue = rules.data.some((r) => r && r.type === 'merge_queue');
  const pipeline = declared === null ? null : { declared, id: null, name: String(declared) };
  const queue = mergeQueue ? ' (la cola de merge sola no alcanza: mergea sin correr nada si ningún control es obligatorio)' : '';
  if (declared === null) {
    if (required.size) return { answer: 'requires-other', detail: `la rama ${target} exige ${[...required].map((c) => `«${c}»`).join(', ')}`, pipeline, mergeQueue };
    return { answer: 'requires-none', detail: `la rama ${target} no exige ningún control${queue}`, pipeline, mergeQueue };
  }
  if (required.has(String(declared))) return { answer: 'requires-declared', detail: `la rama ${target} exige el control de pruebas completas «${declared}»${mergeQueue ? ' (con cola de merge)' : ''}`, pipeline, mergeQueue };
  if (required.size) return { answer: 'requires-other', detail: `la rama ${target} no exige «${declared}»: exige ${[...required].map((c) => `«${c}»`).join(', ')}`, pipeline, mergeQueue };
  return { answer: 'requires-none', detail: `la rama ${target} no exige «${declared}»${queue}`, pipeline, mergeQueue };
}

const RULE_FROM = {
  repo: 'declarada para este repo en team-repos.json → merge_suites',
  organization: 'la de la organización en team-repos.json → merge_suites.default',
  default: 'la regla por defecto: team-repos.json → merge_suites no declara otra para este repo',
};

/**
 * Qué declara la organización para el repo: `{ declared, rule, ruleFrom, pipeline, unreadable }`. Sin `merge_suites`,
 * `merge.mode: pr` del repo vale como `confiar-en-el-servidor` (`legacy`); sin nada, `automatico` sin pipeline.
 */
function suitesRuleFor(where, config, deps) {
  let read;
  try { read = (deps.teamRepos || readTeamRepos)(); } catch (e) { read = { ok: false, problems: [{ path: '', message: firstLine(e && e.message) }] }; }
  // una lectura sin respuesta no es «no está»: sólo `{ absent: true }` lo es
  if (!read || typeof read !== 'object') read = { ok: false, problems: [{ path: '', message: 'la lectura no devolvió nada' }] };
  if (read.absent === true) read = null;
  if (read && !read.ok) {
    const p = (read.problems || [])[0] || {};
    return { unreadable: `${TEAM_REPOS_FILE}: ${p.path ? `${p.path}: ` : ''}${p.message || 'no se pudo leer'}` };
  }
  // la identidad del repo (con su plataforma) la arma la capa de plataforma, el único lugar que la traduce
  let identity = null;
  try { identity = require(path.join(TREE, 'scripts', 'lib', 'platform', 'platform.js')).identityFromRemote(where); } catch (e) {
    return { unreadable: `no pude cargar la capa de plataforma (${(e && e.code) || firstLine(e && e.message)})` };
  }
  let found = { declared: false };
  if (read) {
    // el lector del árbol que no carga tampoco frena el merge: es «no pude leer»
    try { found = require(path.join(TREE, 'scripts', 'lib', 'team-repos.js')).mergeSuitesFor(read.data, identity); } catch (e) {
      return { unreadable: `${TEAM_REPOS_FILE}: no pude cargar su lector (${(e && e.code) || firstLine(e && e.message)})` };
    }
  }
  if (found.declared) return found;
  if (config.mode === 'pr') return { declared: false, rule: 'confiar-en-el-servidor', ruleFrom: 'legacy', pipeline: null };
  return { declared: false, rule: 'automatico', ruleFrom: 'default', pipeline: null };
}

/**
 * Dónde corren las suites: `{ mode, suites, rule, ruleFrom, pipeline, platform, reason, legacyNote }`. `keepMode` fija
 * el modo (los planes posteriores al paso 0). El orden de las comprobaciones va de lo que no necesita preguntar a lo
 * que sí: configuración ilegible, empuje directo, `siempre`, `automatico` sin pipeline; recién después, la plataforma.
 */
function suitesDecision(where, config, target, deps = {}, keepMode = null) {
  const machine = (why) => `las suites corren en esta máquina: ${why}`;
  const notAsked = { asked: false, answer: 'not-asked', detail: null, mergeQueue: null };
  const canPr = where.host === 'azure' || where.host === 'github';
  const r = suitesRuleFor(where, config, deps);
  if (r.unreadable) {
    return { mode: keepMode || config.mode, suites: 'machine', rule: null, ruleFrom: null, pipeline: null, platform: notAsked, legacyNote: null,
      reason: machine(`no pude leer la configuración de la organización (${r.unreadable})`) };
  }
  const from = r.ruleFrom === 'legacy' ? `merge.mode: pr de ${config.declaredIn}, la forma vieja` : RULE_FROM[r.ruleFrom];
  const legacyNote = r.ruleFrom === 'legacy'
    ? `la parte de las suites se declara ahora en ${TEAM_REPOS_FILE} → merge_suites (la configuración de la organización); merge.mode y merge.check del repo siguen valiendo para el modo y el control`
    : null;
  const pipelineOf = (declared) => (declared === null || declared === undefined ? null : { declared, id: Number.isInteger(declared) || /^\d+$/.test(String(declared)) ? Number(declared) : null, name: where.host === 'github' ? String(declared) : null });
  const out = (mode, suites, reason, extra = {}) => Object.assign({ mode, suites, rule: r.rule, ruleFrom: r.ruleFrom, pipeline: pipelineOf(r.pipeline), platform: notAsked, legacyNote, reason }, extra);
  const tag = `regla ${r.rule}, ${from}`;
  // el modo antes de preguntar: lo fijado, o lo que pide la regla; con `automatico` puede subir a pr después
  let mode = keepMode || (r.rule === 'confiar-en-el-servidor' && canPr ? 'pr' : config.mode);
  if (!canPr || mode !== 'pr' && (keepMode || r.rule !== 'automatico')) {
    const why = !canPr ? (where.host === 'local' ? 'origin es una carpeta' : where.host === 'none' ? 'el repo no tiene origin' : 'en el servidor de origin no sé crear pedidos') : 'el modo es push';
    const cant = r.rule === 'confiar-en-el-servidor' ? `; la regla confiar-en-el-servidor no se puede cumplir sin pedido` : '';
    // el modo que fijó el paso 0 se respeta también donde no se crean pedidos (el paso es 9 igual)
    return out(keepMode || (canPr ? mode : config.mode), 'machine', machine(`el merge se empuja directo (${why}): sin pedido, nadie más las corre${cant} (${tag})`));
  }
  if (r.rule === 'siempre-en-la-maquina') return out(mode, 'machine', machine(`la regla es siempre-en-la-maquina (${from})`));
  if (r.rule === 'automatico' && (r.pipeline === null || r.pipeline === undefined)) {
    return out(mode, 'machine', machine(`no hay pipeline de pruebas completas declarado para este repo en ${TEAM_REPOS_FILE} → merge_suites (${tag})`));
  }
  // preguntarle a la plataforma
  const now = deps.now || Date.now;
  const budget = { end: now() + PLAN_MS, failed: null };
  const declared = r.rule === 'automatico' ? r.pipeline : null;
  const answer = where.host === 'azure'
    ? azureBranchAnswer(where, target, declared, asker(deps.az || ((args, t) => realAz(args, { env: deps.env, timeoutMs: t })), 'az', budget, now))
    : githubBranchAnswer(where, target, declared, asker(deps.gh || ((args, t) => realGh(args, { env: deps.env, timeoutMs: t })), 'gh', budget, now));
  const platform = { asked: true, answer: answer.answer, detail: answer.detail, mergeQueue: answer.mergeQueue === undefined ? null : answer.mergeQueue };
  const pipeline = answer.pipeline || pipelineOf(r.pipeline);
  if (r.rule === 'confiar-en-el-servidor') {
    if (answer.answer === 'requires-none') return out('pr', 'machine', machine(`la regla confiar-en-el-servidor no se pudo cumplir: la rama no exige ningún control (${from})`), { platform, pipeline });
    if (answer.answer === 'could-not-ask') {
      return out('pr', 'server', `las suites las corre el servidor (${tag}): no pude confirmar que la rama exija un control: si no exige ninguno, el pedido se completa sin pruebas (${answer.detail})`, { platform, pipeline });
    }
    return out('pr', 'server', `las suites las corre el servidor: ${answer.detail} (${tag})`, { platform, pipeline });
  }
  if (answer.answer === 'requires-declared') return out('pr', 'server', `las suites las corre el servidor: ${answer.detail} (${tag})`, { platform, pipeline });
  return out(mode, 'machine', machine(`${answer.detail} (${tag})`), { platform, pipeline });
}

/**
 * Qué paso del skill sigue, y con qué: el servidor lo decide el remoto; el modo y el control los declara el repo — o,
 * para el clon del público del arnés, el clon de mantenimiento (`mergeConfigFor`). `configFrom` dice de dónde salieron.
 * Dónde corren las suites lo decide `suitesDecision`; `keepMode` fija el modo del paso 0.
 */
function plan({ repo: given, source, target, keepMode = null }, deps = {}) {
  const at = rootOf(given, deps);
  if (at.problem) return stop(at.problem);
  const repo = at.root;
  const where = hostOf(repo, deps);
  if (where.problem) return stop(where.problem);
  const config = mergeConfigFor(repo, () => where, deps);
  if (config.problem) return stop(config.problem);
  const decided = suitesDecision(where, config, target, deps, keepMode);
  const mode = decided.mode;
  const check = checkOf(decided, where, config);
  const notes = config.note ? [config.note] : [];
  let step = '9';
  let canMerge = false;
  if (mode !== 'pr') {
    notes.push(keepMode ? `el modo lo fijó el paso 0 del skill (--keep-mode ${keepMode}): el merge se empuja (paso 9)`
      : config.configFrom === 'maintainers'
        ? `${config.declaredIn} declara merge.mode: ${config.mode}, no pr: el merge se empuja (paso 9)`
        : `el repo no declara merge.mode: pr en ${CONFIG_FILE}: el merge se empuja (paso 9)`);
  } else if (where.host === 'azure') {
    step = '9b';
  } else if (where.host === 'github') {
    step = '9c';
    canMerge = Boolean(check);
    if (!canMerge) notes.push(`falta declarar merge.check en ${config.declaredIn} (el nombre exacto del control de la validación): el pedido se crea y NO se mergea — un pedido trae varios controles y no se elige uno por cuenta propia`);
  } else if (where.host === 'local') {
    notes.push('origin es una carpeta de esta máquina: el empuje va a esa carpeta, no a un servidor (paso 9)');
  } else if (where.host === 'none') {
    notes.push('el repo no tiene origin: no hay a dónde crear un pedido (paso 9)');
  } else {
    notes.push(`en el servidor de origin (${withoutCredentials(where.url)}) no sé crear pedidos: paso 9. Si es un alias de ssh de GitHub que ssh no resuelve, revisá «ssh -G» de ese alias`);
  }
  const version = step === '9c' ? bumpVersion({ repo, source, target }, deps) : null;
  // un número que no se pudo calcular se DICE: `version: null` solo se leería como «este repo no numera versiones»
  if (version && version.code !== 0) notes.push(`no pude calcular la versión que subiría: ${version.reason}`);
  return Object.assign({ code: 0, host: where.host, mode, check, configFrom: config.configFrom, step, canMerge, notes },
    where.host === 'azure' ? { org: where.org, project: where.project, name: where.name } : {},
    where.host === 'github' ? { ghRepo: where.ghRepo, name: where.name } : {},
    bodyFiles(repo, source),
    { version: version && version.code === 0 ? { action: version.action, from: version.from || null, to: version.to || null, reason: version.reason || null } : null },
    { suites: decided.suites, suitesRule: decided.rule, suitesRuleFrom: decided.ruleFrom, suitesPipeline: decided.pipeline, platform: decided.platform,
      suitesReason: decided.reason.replace(/\s*\r?\n\s*/g, ' '), legacyNote: decided.legacyNote });
}

/**
 * El control a esperar: con las suites en el servidor y un pipeline declarado en un repo de GitHub, el
 * declarado —esperar otro no prueba que se corrieron—; si no, `merge.check` del repo, como siempre.
 */
function checkOf(decided, where, config) {
  if (decided.suites === 'server' && where.host === 'github' && decided.pipeline && decided.pipeline.declared !== null && decided.pipeline.declared !== undefined) return String(decided.pipeline.declared);
  return config.check;
}

// ── la versión ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** El commit de una referencia, o `null` si no existe; `{ problem }` si git no pudo contestar. */
function commitOf(repo, ref, deps) {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], deps);
  if (r.ok) return { sha: r.out.trim() };
  if (r.status === 1) return { sha: null };
  return { problem: `git no pudo resolver ${ref}: ${firstLine(r.err) || `salió ${r.status}`}` };
}

/**
 * El `version.json` de un commit: `{ present: false }` si no lo trae; `{ present: true, version, text }` si se lee; con
 * `problem` si está y no se deja leer (no es JSON, no es un objeto, no trae un número con la forma publicada).
 */
function versionAt(repo, ref, deps) {
  const ls = git(repo, ['ls-tree', '--end-of-options', ref, '--', VERSION_FILE], deps);
  if (!ls.ok) return { problem: `no pude mirar ${VERSION_FILE} en ${ref}: ${firstLine(ls.err) || `git salió ${ls.status}`}` };
  if (!ls.out.trim()) return { present: false };
  const show = git(repo, ['show', '--end-of-options', `${ref}:${VERSION_FILE}`], deps);
  if (!show.ok) return { problem: `no pude leer ${VERSION_FILE} de ${ref}: ${firstLine(show.err) || `git salió ${show.status}`}` };
  return Object.assign(parseVersion(show.out, ref), { text: show.out });
}

function parseVersion(text, where) {
  let data;
  try { data = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch (e) { return { present: true, problem: `${VERSION_FILE} de ${where} no es JSON (${firstLine(e.message)})` }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { present: true, problem: `${VERSION_FILE} de ${where} no es un objeto` };
  if (typeof data.version !== 'string') return { present: true, problem: `${VERSION_FILE} de ${where} no trae «version»` };
  if (!VO.isOrdered(data.version)) return { present: true, problem: `${VERSION_FILE} de ${where}: la versión ${JSON.stringify(data.version)} no tiene la forma YYYY.MM.DD.N` };
  return { present: true, version: data.version, data };
}

/** ¿En qué rama está parado el árbol de trabajo? `null` si no está en una rama. */
function currentBranch(repo, deps) {
  const r = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], deps);
  return r.ok ? r.out.trim() : null;
}

/**
 * El número que sigue para la rama `source` contra `origin/<target>`. Sin --write sólo lo dice (lee la rama, no el
 * árbol de trabajo). Con --write cambia en `version.json` SÓLO el valor de `version` —sobre el texto, sin volver a
 * escribir el JSON: el orden, los fines de línea y lo demás quedan byte a byte— y exige estar parado en `source`.
 * La fecha sale del commit de la punta de la rama, nunca del reloj, y nunca es anterior a la del número publicado: así
 * el número no baja.
 */
function bumpVersion({ repo: given, source, target, write = false }, deps = {}) {
  const at = rootOf(given, deps);
  if (at.problem) return stop(at.problem);
  const repo = at.root;
  const targetRef = `refs/remotes/origin/${target}`;
  const sourceRef = `refs/heads/${source}`;
  for (const [ref, what] of [[targetRef, `la rama destino (origin/${target})`], [sourceRef, `la rama ${source}`]]) {
    const c = commitOf(repo, ref, deps);
    if (c.problem) return stop(c.problem);
    if (!c.sha) return stop(`no encuentro ${what} en ${repo}`);
  }
  if (write) {
    const here = currentBranch(repo, deps);
    if (here !== source) return stop(`el árbol de trabajo está en ${here ? `la rama ${here}` : 'un commit suelto'}, no en ${source}: no escribo ${VERSION_FILE} en otra rama`);
  }
  const published = versionAt(repo, targetRef, deps);
  if (published.problem) return stop(published.problem);
  if (!published.present) return { code: 0, action: 'none', written: false, reason: `este repo no numera versiones: origin/${target} no trae ${VERSION_FILE}` };
  // el número lo pone el merge (una etiqueta sobre cada merge a la rama destino): el pedido no toca version.json
  if (VO.numberedByTag(published.data)) return { code: 0, action: 'none', written: false, target: published.version, reason: `el número lo pone el merge (la etiqueta ${VO.TAG_PREFIX}<número>): el pedido no toca ${VERSION_FILE}` };
  const mine = versionAt(repo, sourceRef, deps);
  if (mine.problem) return stop(mine.problem);
  if (!mine.present) return stop(`la rama ${source} no trae ${VERSION_FILE} y origin/${target} sí: traé la rama destino antes de numerar`);
  if (VO.compare(mine.version, published.version) > 0) {
    return { code: 0, action: 'none', written: false, from: mine.version, target: published.version, reason: `el número de la rama (${mine.version}) ya es mayor que el de origin/${target} (${published.version})` };
  }
  const stamp = git(repo, ['log', '-1', '--format=%ct', sourceRef], deps);
  if (!stamp.ok) return stop(`no pude leer la fecha del commit de ${source}: ${firstLine(stamp.err)}`);
  let to;
  try {
    const ofCommit = VO.day(Number(stamp.out.trim()));
    const ofPublished = VO.parts(published.version).day;
    to = VO.next(ofCommit > ofPublished ? ofCommit : ofPublished, [published.version, mine.version]);
  } catch (e) { return stop(e.message); }
  const result = { code: 0, action: 'bump', from: mine.version, to, target: published.version, written: false };
  if (!write) return result;

  const dirty = git(repo, ['status', '--porcelain', '--', VERSION_FILE], deps);
  if (!dirty.ok) return stop(`no pude mirar el estado de ${VERSION_FILE}: ${firstLine(dirty.err)}`);
  if (dirty.out.trim()) return stop(`${VERSION_FILE} tiene cambios sin commitear: no lo piso`);
  const file = path.join(repo, VERSION_FILE);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return stop(`no pude leer ${VERSION_FILE}: ${e.message}`); }
  const before = parseVersion(text, 'el árbol de trabajo');
  if (before.problem) return stop(before.problem);
  if (before.version !== mine.version) return stop(`${VERSION_FILE} del árbol de trabajo dice ${before.version} y la rama ${source} dice ${mine.version}`);
  // el valor de la clave `version`, donde esté escrito así: tiene que haber uno solo
  const found = [...text.matchAll(/("version"\s*:\s*")([^"\\]*)(")/g)].filter((m) => m[2] === mine.version);
  if (found.length !== 1) return stop(`no pude ubicar el valor de «version» en ${VERSION_FILE} (lo encontré ${found.length} veces): no lo reescribo a ciegas`);
  const m = found[0];
  const next = text.slice(0, m.index) + m[1] + to + m[3] + text.slice(m.index + m[0].length);
  const after = parseVersion(next, 'lo que iba a escribir');
  if (after.problem || JSON.stringify(Object.assign({}, after.data, { version: mine.version })) !== JSON.stringify(before.data)) {
    return stop(`el cambio en ${VERSION_FILE} tocaría algo más que «version»: no lo escribo`);
  }
  try { fs.writeFileSync(file, next, 'utf8'); } catch (e) { return stop(`no pude escribir ${VERSION_FILE}: ${e.message}`); }
  return Object.assign(result, { written: true });
}

/** ¿El número de `head` es mayor que el de `base`? 0 sí (o la base no numera versiones) · 1 no · 2 no se pudo leer. */
function checkVersion({ repo: given, base, head }, deps = {}) {
  const at = rootOf(given, deps);
  if (at.problem) return stop(at.problem);
  const repo = at.root;
  for (const ref of [base, head]) {
    const c = commitOf(repo, ref, deps);
    if (c.problem) return stop(c.problem);
    if (!c.sha) return stop(`no encuentro ${ref} en ${repo}`);
  }
  const b = versionAt(repo, base, deps);
  if (b.problem) return stop(b.problem);
  if (!b.present) return { code: 0, base: null, head: null, reason: `${base} no trae ${VERSION_FILE}: este repo no numera versiones` };
  const h = versionAt(repo, head, deps);
  if (h.problem) return stop(h.problem);
  if (!h.present) return { code: 1, base: b.version, head: null, reason: `${head} no trae ${VERSION_FILE} y ${base} sí (${b.version})` };
  // con el número del merge, el pedido deja version.json como está (el piso y la marca): la etiqueta la pone el merge
  if (VO.numberedByTag(b.data)) {
    if (VO.numberedByTag(h.data) && h.version === b.version) return { code: 0, base: b.version, head: h.version, reason: `el número lo pone el merge (la etiqueta ${VO.TAG_PREFIX}<número>); ${VERSION_FILE} sigue en ${b.version}` };
    return { code: 1, base: b.version, head: h.version, reason: `${head} cambia ${VERSION_FILE} (${h.version}${VO.numberedByTag(h.data) ? '' : ', sin la marca del número por etiqueta'}) y en ${base} el número lo pone el merge: el pedido no lo toca` };
  }
  if (VO.compare(h.version, b.version) > 0) return { code: 0, base: b.version, head: h.version, reason: `la versión sube de ${b.version} a ${h.version}` };
  return { code: 1, base: b.version, head: h.version, reason: `la versión de ${head} (${h.version}) no es mayor que la de ${base} (${b.version}): un cambio que no sube el número no llega a las máquinas instaladas` };
}

// ── poner la rama al día ─────────────────────────────────────────────────────────────────────────────────────────────

const fetchTarget = (repo, target, deps) => git(repo, ['fetch', '--quiet', 'origin', `+refs/heads/${target}:refs/remotes/origin/${target}`], deps);

/**
 * Trae `origin/<target>` y la mergea en `source`. Ya al día: nada. Con conflictos SÓLO en `version.json`: toma el de la
 * destino y cierra el merge (el número se sube después; es lo único que se resuelve solo). Con cualquier otro: deshace
 * el merge, nombra los archivos y sale 5. No toca nada si el árbol no está en `source` o tiene cambios sin commitear.
 */
function updateBranch({ repo: given, source, target }, deps = {}) {
  const at = rootOf(given, deps);
  if (at.problem) return stop(at.problem);
  const repo = at.root;
  const here = currentBranch(repo, deps);
  if (here !== source) return stop(`el árbol de trabajo está en ${here ? `la rama ${here}` : 'un commit suelto'}, no en ${source}: no traigo la rama destino a otra rama`);
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=no'], deps);
  if (!dirty.ok) return stop(`no pude mirar el estado del árbol: ${firstLine(dirty.err)}`);
  if (dirty.out.trim()) return stop('el árbol de trabajo tiene cambios sin commitear: no traigo la rama destino encima');
  const fetched = fetchTarget(repo, target, deps);
  if (!fetched.ok) return stop(`no pude traer origin/${target}: ${firstLine(fetched.err) || `git salió ${fetched.status}`}`);
  const upstream = `refs/remotes/origin/${target}`;
  const contained = git(repo, ['merge-base', '--is-ancestor', upstream, 'HEAD'], deps);
  if (contained.status === 0) return { code: 0, action: 'none', resolved: [], reason: `${source} ya trae la punta de origin/${target}` };
  if (contained.status !== 1) return stop(`git no pudo comparar ${source} con origin/${target}: ${firstLine(contained.err) || `salió ${contained.status}`}`);

  const merged = git(repo, ['merge', '--no-edit', upstream], deps);
  if (merged.ok) return { code: 0, action: 'merged', resolved: [], reason: `origin/${target} quedó mergeada en ${source}` };
  // Deshacer el merge también puede fallar, y ahí el árbol queda a medias: se dice SIEMPRE cómo quedó. (Si git cortó
  // antes de empezar a mergear —un archivo sin trackear que el merge pisaría— no hay nada que deshacer.)
  let stuck = false;   // ¿quedó un merge a medias que no se pudo deshacer?
  const undo = () => {
    const pending = git(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], deps);
    if (pending.status === 1) return ' (no quedó ningún merge a medias)';
    const undone = git(repo, ['merge', '--abort'], deps);
    if (undone.ok) return ' (el merge quedó deshecho)';
    stuck = true;
    return ` — y NO pude deshacer el merge (${firstLine(undone.err) || `git salió ${undone.status}`}): el árbol quedó a medias, revisalo antes de seguir`;
  };
  const unmerged = git(repo, ['diff', '--name-only', '--diff-filter=U'], deps);
  if (!unmerged.ok) return stop(`el merge de origin/${target} falló y no pude leer qué archivos chocan (${firstLine(unmerged.err) || `git salió ${unmerged.status}`})${undo()}`);
  const conflicts = unmerged.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort();
  if (!conflicts.length) return stop(`el merge de origin/${target} falló sin dejar archivos en conflicto: ${firstLine(merged.err || merged.out) || `git salió ${merged.status}`}${undo()}`);
  if (conflicts.length === 1 && conflicts[0] === VERSION_FILE) {
    // el único choque es el número, que cambia en todo pedido: vale el de la destino (después se sube de nuevo)
    for (const args of [['checkout', '--theirs', '--', VERSION_FILE], ['add', '--', VERSION_FILE], ['commit', '--quiet', '--no-edit']]) {
      const step = git(repo, args, deps);
      if (!step.ok) return stop(`no pude cerrar el merge tomando ${VERSION_FILE} de origin/${target} (git ${args[0]}): ${firstLine(step.err || step.out) || `git salió ${step.status}`}${undo()}`);
    }
    return { code: 0, action: 'merged', resolved: [VERSION_FILE], reason: `origin/${target} quedó mergeada en ${source}; ${VERSION_FILE} chocaba y se tomó el de la destino` };
  }
  const how = undo();
  const reason = `${source} tiene conflictos con origin/${target} en ${conflicts.join(', ')}: los resuelve una persona${how}`;
  // 5 es «hay conflictos y el árbol quedó como estaba». Si no se pudo deshacer, no es eso: 2, con los archivos a la vista
  if (stuck) return stop(reason, { action: 'stuck', conflicts, resolved: [] });
  return { code: 5, action: 'aborted', conflicts, resolved: [], reason };
}

// ── la espera del control ────────────────────────────────────────────────────────────────────────────────────────────

const VIEW_FIELDS = ['state', 'isDraft', 'mergeable', 'mergeStateStatus', 'headRefOid', 'baseRefName', 'statusCheckRollup'];
const WAITING = new Set(['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED', 'STALE']);

/** Cómo está EL control declarado en la lista de un pedido: `{ kind: 'missing' | 'waiting' | 'unordered' | 'green' | 'red', state, link }`. */
function judgeCheck(rollup, check) {
  const mine = (Array.isArray(rollup) ? rollup : []).filter((c) => c && (c.name === check || c.context === check));
  if (!mine.length) return { kind: 'missing' };
  let latest = mine[0];
  if (mine.length > 1) {
    // un control vuelto a correr aparece más de una vez: vale el más reciente. Si no se pueden ordenar, no se elige
    const when = (c) => Date.parse(c.startedAt || c.createdAt || '');
    if (mine.some((c) => !Number.isFinite(when(c)))) return { kind: 'unordered' };
    const sorted = [...mine].sort((a, b) => when(b) - when(a));
    if (when(sorted[0]) === when(sorted[1])) return { kind: 'unordered' };
    latest = sorted[0];
  }
  const link = latest.detailsUrl || latest.targetUrl || null;
  // un control (CheckRun) trae `status` y `conclusion`; un estado de commit (StatusContext), `state`
  const state = String(latest.context !== undefined && latest.name === undefined ? latest.state || '' : (String(latest.status || '').toUpperCase() === 'COMPLETED' ? latest.conclusion || '' : latest.status || '')).toUpperCase();
  if (state === 'SUCCESS') return { kind: 'green', state, link };
  if (WAITING.has(state)) return { kind: 'waiting', state, link };
  return { kind: 'red', state, link };
}

/**
 * Espera el control declarado sobre la punta `head` del pedido `pr`. Pregunta cada `intervalS` segundos, con la punta y
 * los controles de la MISMA respuesta. Devuelve `{ code, outcome, reason, … }`; los códigos están en la ayuda del skill
 * (paso 9c): 0 verde · 1 rojo · 2 no se pudo preguntar · 3 plazo · 4 cerrado · 5 conflictos · 6 la punta se movió ·
 * 7 la versión quedó atrás · 8 borrador · 9 atrás de la destino o bloqueado por la regla. Nunca mergea.
 */
function waitChecks({ repo: given, pr, head, target, check, timeoutMin = 90, intervalS = 30 }, deps = {}) {
  const at = rootOf(given, deps);
  if (at.problem) return stop(at.problem, { outcome: 'cannot-ask' });
  const repo = at.root;
  const gh = deps.gh || ((args) => realGh(args, { cwd: repo, env: deps.env }));
  const sleep = deps.sleep || realSleep;
  const now = deps.now || Date.now;
  const number = Number(pr);
  if (!Number.isInteger(number) || number <= 0) return stop(`el número del pedido no es un número: ${JSON.stringify(pr)}`, { outcome: 'cannot-ask' });
  // de qué servidor es `origin` se averigua una sola vez (`deps.hostOf`: sólo las pruebas, cuyo `origin` es una carpeta)
  let asked = null;
  const whereOf = () => asked || (asked = (deps.hostOf || hostOf)(repo, deps));
  let name = check;
  let from = null;   // de dónde se leyó el control, si no vino con --check
  if (name === undefined) {
    // el mismo lector que el plan: en un clon del público del arnés, el control sale del clon de mantenimiento
    const config = mergeConfigFor(repo, whereOf, deps);
    if (config.problem) return stop(config.problem, { outcome: 'cannot-ask' });
    name = config.check;
    from = config;
    // el mismo control que daría el plan. Sólo hace falta preguntarle a la rama si la organización declara
    // un pipeline para este repo con una regla que lo usa; si no, es `merge.check`, sin consultar nada
    const where = whereOf();
    if (!where.problem && where.host === 'github') {
      const r = suitesRuleFor(where, config, deps);
      if (!r.unreadable && r.pipeline !== null && r.pipeline !== undefined && r.rule !== 'siempre-en-la-maquina') {
        name = checkOf(suitesDecision(where, config, target, deps, 'pr'), where, config);
      }
    }
  }
  if (!name) {
    return stop(from && from.configFrom === 'maintainers'
      ? `falta declarar merge.check en ${from.declaredIn}: no espero ni elijo un control por cuenta propia`
      : `el repo no declara merge.check en ${CONFIG_FILE}: no espero ni elijo un control por cuenta propia`, { outcome: 'cannot-ask' });
  }
  const local = commitOf(repo, head, deps);
  if (local.problem || !local.sha) return stop(local.problem || `la punta ${head} no está en este clon: no puedo comparar su versión`, { outcome: 'cannot-ask' });
  // a qué repo se le pregunta: al de `origin`, nombrado. Sin poder leerlo, `gh` lo elegiría por su cuenta: no se pregunta
  const where = whereOf();
  if (where.problem) return stop(where.problem, { outcome: 'cannot-ask' });
  if (where.host !== 'github' || !where.ghRepo) return stop(`origin no es un repo de GitHub (${where.host}): no le pregunto a gh por un pedido sin nombrar el repo, porque elegiría uno por su cuenta`, { outcome: 'cannot-ask' });
  const args = ['pr', 'view', String(number), '--json', VIEW_FIELDS.join(','), '--repo', where.ghRepo];
  const base = { check: name, head: local.sha, pr: number };
  const done = (code, outcome, reason, extra = {}) => Object.assign({ code, outcome, reason }, base, extra);

  const started = now();
  let failures = 0;
  let last = 'el control todavía no llegó al pedido';
  for (;;) {
    const r = gh(args);
    let v = null;
    if (r.status !== 0) {
      failures += 1;
      if (failures >= 3) return done(2, 'cannot-ask', `no pude preguntarle a gh por el pedido ${number} (tres veces seguidas): ${firstLine(r.stderr) || `salió ${r.status}`}`);
    } else {
      failures = 0;
      try { v = JSON.parse(r.stdout); } catch (_) { return done(2, 'cannot-ask', `gh contestó algo que no es JSON al preguntar por el pedido ${number}`); }
      if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.state !== 'string') return done(2, 'cannot-ask', `gh contestó algo que no es un pedido al preguntar por el ${number}`);
    }
    if (v) {
      if (v.state !== 'OPEN') return done(4, 'closed', `el pedido ${number} ya no está abierto (${v.state}): no hay nada que mergear`);
      // la versión se compara contra `--target`: si el pedido va a OTRA rama, la comparación sería contra la equivocada
      if (typeof v.baseRefName !== 'string' || !v.baseRefName) return done(2, 'cannot-ask', `gh no dijo hacia qué rama va el pedido ${number}: no comparo la versión sin saberlo`);
      if (v.baseRefName !== target) return done(2, 'cannot-ask', `el pedido ${number} va hacia ${v.baseRefName} y se pidió esperar contra ${target}: no comparo la versión contra otra rama que la del pedido`);
      if (v.headRefOid !== local.sha) return done(6, 'head-moved', `la punta del pedido ${number} se movió (es ${String(v.headRefOid).slice(0, 12)}, se esperaba ${local.sha.slice(0, 12)}): lo validado no es lo que se iba a mergear`);
      if (v.isDraft) return done(8, 'draft', `el pedido ${number} está en borrador: GitHub no lo deja mergear hasta marcarlo listo`);
      if (v.mergeable === 'CONFLICTING') return done(5, 'conflicts', `el pedido ${number} tiene conflictos con ${v.baseRefName || target}: hay que traer la rama destino`);
      const c = judgeCheck(v.statusCheckRollup, name);
      if (c.kind === 'red') return done(1, 'red', `el control «${name}» terminó en ${c.state}${c.link ? `: ${c.link}` : ''}`, { state: c.state, link: c.link });
      if (c.kind === 'green') {
        const merge = String(v.mergeStateStatus || '').toUpperCase();
        if (v.mergeable === 'UNKNOWN' || merge === 'UNKNOWN') last = 'el control está en verde y GitHub todavía no calculó si el pedido se puede mergear';
        else if (merge === 'BEHIND') return done(9, 'behind', `el control «${name}» está en verde, pero la rama quedó atrás de ${v.baseRefName || target}: hay que traerla y validar de nuevo`, { state: c.state, link: c.link });
        else if (merge === 'BLOCKED') return done(9, 'blocked', `el control «${name}» está en verde, pero la regla de la rama ${v.baseRefName || target} no deja mergear el pedido ${number}`, { state: c.state, link: c.link });
        else {
          const fetched = fetchTarget(repo, target, deps);
          if (!fetched.ok) return done(2, 'cannot-ask', `no pude traer origin/${target} para comparar la versión: ${firstLine(fetched.err) || `git salió ${fetched.status}`}`);
          const ver = checkVersion({ repo, base: `refs/remotes/origin/${target}`, head: local.sha }, deps);
          if (ver.code === 2) return done(2, 'cannot-ask', ver.reason);
          if (ver.code === 1) return done(7, 'version-behind', ver.reason, { state: c.state, link: c.link });
          return done(0, 'green', `el control «${name}» está en verde sobre ${local.sha.slice(0, 12)}`, { state: c.state, link: c.link, version: ver.head });
        }
      } else if (c.kind === 'missing') last = `el control «${name}» no llegó al pedido`;
      else if (c.kind === 'unordered') last = `hay más de un control «${name}» y no se pueden ordenar por fecha: no elijo uno`;
      else last = `el control «${name}» no terminó (${c.state || 'sin estado'})`;
    }
    if (now() - started >= timeoutMin * 60000) return done(3, 'timeout', `${last} en ${timeoutMin} minuto(s)`);
    sleep(intervalS * 1000);
  }
}

// ── el texto del commit de merge ─────────────────────────────────────────────────────────────────────────────────────

// Lo que, puesto en el mensaje de un commit, hace que una CI no corra: las de Azure Pipelines y las de GitHub. Un
// commit de merge con una de éstas deja la rama principal sin construir.
const CI_SKIP = () => /\[(?:skip ci|ci skip|no ci|skip actions|actions skip|skip azurepipelines|azurepipelines skip|skip azpipelines|azpipelines skip|skip azp|azp skip)\]|skip-checks:\s?true|\*\*\*NO_CI\*\*\*/gi;

/**
 * Un texto sin ninguna marca que saltee la CI. Se repite hasta que no queda ninguna: sacar una puede dejar armada otra
 * que venía partida (`[skip [skip ci]ci]`). No toca nada más: los espacios y la sangría del texto quedan como estaban.
 */
function withoutCiSkip(text) {
  let out = String(text);
  for (let guard = 0; guard < 1000 && CI_SKIP().test(out); guard += 1) out = out.replace(CI_SKIP(), '');
  return out;
}

/** El asunto en una línea prolija y sin marcas. Juntar espacios puede ARMAR una marca (`[skip  ci]`): se vuelve a sacar. */
function cleanTopic(line) {
  let out = String(line);
  for (let guard = 0; guard < 1000; guard += 1) {
    const next = withoutCiSkip(out).replace(/\s{2,}/g, ' ').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * El título y el cuerpo del commit de merge de un pedido de GitHub. El título es «asunto (#N)»: el asunto es la primera
 * línea del mensaje del pedido, sin el prefijo `merge: a -> b — ` del skill. Ninguna marca que saltee la CI, ni en el
 * título ni en el cuerpo. El cuerpo limpio queda en `to`.
 */
function message({ pr, from, to }) {
  const number = Number(pr);
  if (!Number.isInteger(number) || number <= 0) return stop(`el número del pedido no es un número: ${JSON.stringify(pr)}`);
  let text;
  try { text = fs.readFileSync(from, 'utf8'); } catch (e) { return stop(`no pude leer el mensaje del pedido (${from}): ${e.message}`); }
  const topic = cleanTopic(String(text.split('\n')[0] || '').replace(/\r$/, '').replace(/^merge: \S+ -> \S+ — /, ''));
  if (!topic) return stop('el mensaje del pedido no tiene asunto en su primera línea: no invento un título');
  const body = withoutCiSkip(text);
  if (CI_SKIP().test(body) || CI_SKIP().test(topic)) return stop('no pude dejar el texto del merge sin marcas que salteen la CI');
  // Se escribe al lado y se renombra: si en `to` había un enlace simbólico (la carpeta temporal es de todos), el
  // renombre lo reemplaza en vez de escribir a través de él.
  const side = `${to}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(side, body, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(side, to);
  } catch (e) {
    try { fs.rmSync(side, { force: true }); } catch (_) { /* no quedó nada que borrar */ }
    return stop(`no pude escribir el cuerpo del merge (${to}): ${e.message}`);
  }
  return { code: 0, subject: `${topic} (#${number})`, bodyFile: String(to).split(path.sep).join('/') };
}

// ── la línea de comandos ─────────────────────────────────────────────────────────────────────────────────────────────

const ORDERS = {
  plan: { needs: ['repo', 'source', 'target'], run: (o) => plan(o) },
  'update-branch': { needs: ['repo', 'source', 'target'], run: (o) => updateBranch(o) },
  'bump-version': { needs: ['repo', 'source', 'target'], run: (o) => bumpVersion(o) },
  'wait-checks': { needs: ['repo', 'pr', 'head', 'target'], run: (o) => waitChecks(o) },
  message: { needs: ['pr', 'from', 'to'], run: (o) => message(o) },
  'check-version': { needs: ['repo', 'base', 'head'], run: (o) => checkVersion(o) },
};
const VALUE_OPTIONS = { '--repo': 'repo', '--source': 'source', '--target': 'target', '--pr': 'pr', '--head': 'head', '--base': 'base',
  '--check': 'check', '--from': 'from', '--to': 'to', '--timeout-min': 'timeoutMin', '--interval-s': 'intervalS', '--keep-mode': 'keepMode' };

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE); return 0; }
  const usage = (why) => { process.stderr.write(`merge-pr: ${why}\n${USAGE}`); return 2; };
  const order = ORDERS[argv[0]];
  if (!order) return usage(argv[0] ? `no conozco la orden «${argv[0]}»` : 'falta la orden');
  const opts = {};
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write') { opts.write = true; continue; }
    const key = VALUE_OPTIONS[a];
    if (!key) return usage(`no conozco la opción «${a}»`);
    if (i + 1 >= argv.length) return usage(`a ${a} le falta su valor`);
    opts[key] = argv[i += 1];
  }
  const missing = order.needs.filter((k) => opts[k] === undefined || opts[k] === '');
  if (missing.length) return usage(`a «${argv[0]}» le falta ${missing.map((k) => Object.keys(VALUE_OPTIONS).find((o) => VALUE_OPTIONS[o] === k)).join(', ')}`);
  for (const k of ['timeoutMin', 'intervalS']) {
    if (opts[k] === undefined) continue;
    const n = Number(opts[k]);
    if (!Number.isFinite(n) || n <= 0) return usage(`el valor de ${Object.keys(VALUE_OPTIONS).find((o) => VALUE_OPTIONS[o] === k)} no es un número mayor que cero`);
    opts[k] = n;
  }
  if (opts.keepMode !== undefined && (argv[0] !== 'plan' || !['push', 'pr'].includes(opts.keepMode))) {
    return usage(argv[0] !== 'plan' ? '--keep-mode es sólo de plan' : `--keep-mode es push o pr (es «${opts.keepMode}»)`);
  }
  if (opts.repo) opts.repo = path.resolve(opts.repo);
  const result = order.run(opts);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.code !== 0 && result.reason) process.stderr.write(`merge-pr ${argv[0]}: ${result.reason}\n`);
  return result.code;
}

if (require.main === module) process.exitCode = main();

module.exports = { main, plan, hostOf, rootOf, readMergeConfig, parseMergeConfig, mergeConfigFor, bodyFiles, parseSshHostname, updateBranch, bumpVersion, checkVersion, versionAt,
  waitChecks, judgeCheck, message, withoutCiSkip, cleanTopic, azLaunch, realAz, suitesDecision, USAGE };
