#!/usr/bin/env node
'use strict';
/**
 * scripts/tools/merge-pr.js — lo que el skill de merge necesita saber y hacer cuando el repo vive en GitHub.
 *
 * POR QUÉ EXISTE. El skill de merge creaba un pedido sólo en Azure DevOps, donde el servidor lo completa solo cuando
 * sus controles dan verde. En GitHub eso no está siempre (un repo privado sin plan pago no lo permite), un pedido trae
 * VARIOS controles (el de la corrida de la validación, uno por cada trabajo y los de otras herramientas) y el número de
 * `version.json` —lo que una máquina instalada compara para saber si hay algo nuevo— ya no lo pone una sincronización:
 * subía con cada pedido. Desde que `version.json` trae `numbering: "merge-tag"`, el número lo pone el merge (una etiqueta
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
 * Quien mantiene el arnés trabaja en ese clon, que no trae `.tycon/`: leído como «no declara nada», el plan mandaba a un
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
 * Cada orden imprime un JSON en la salida y sale con su `code`. Uso: node scripts/tools/merge-pr.js --help
 *
 * Sin dependencias, en Windows y en Mac. `gh` se llama por su nombre; `TYCON_GH` lo reemplaza y es SÓLO de las pruebas
 * (un guion de Node, que corre igual en las dos plataformas).
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

const USAGE = `uso: merge-pr.js <orden> [opciones]   (cada orden imprime un JSON y sale con su «code»)
  plan           --repo <dir> --source <rama> --target <rama>
  update-branch  --repo <dir> --source <rama> --target <rama>
  bump-version   --repo <dir> --source <rama> --target <rama> [--write]
  wait-checks    --repo <dir> --pr <n> --head <sha> --target <rama> [--check <nombre>] [--timeout-min 90] [--interval-s 30]
  message        --pr <n> --from <archivo del cuerpo> --to <archivo>
  check-version  --repo <dir> --base <ref> --head <ref>
plan dice de dónde leyó merge.mode y merge.check («configFrom»): «repo» (el .tycon/advisors.yaml del repo) o «maintainers»
(un clon del repo público del arnés, que no trae ese archivo: lo commiteado en la rama principal remota del clon de
mantenimiento que declara la máquina, paths.maintainers). wait-checks, sin --check, lee el control por el mismo camino.
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

/** Corre `gh`. Por defecto el de la máquina; `TYCON_GH` (sólo pruebas) lo reemplaza, y si es un `.js` corre con Node. */
function realGh(args, { cwd, env } = {}) {
  const bin = (env || process.env).TYCON_GH || 'gh';
  const viaNode = /\.[cm]?js$/i.test(bin);
  const r = spawnSync(viaNode ? process.execPath : bin, viaNode ? [bin, ...args] : args, { encoding: 'utf8', cwd, env: env || process.env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.error ? -1 : r.status, stdout: r.stdout || '', stderr: String((r.error && r.error.message) || r.stderr || '').trim() };
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
const withoutCredentials = (url) => String(url || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1');

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

/**
 * Qué paso del skill sigue, y con qué: el servidor lo decide el remoto; el modo y el control los declara el repo — o,
 * para el clon del público del arnés, el clon de mantenimiento (`mergeConfigFor`). `configFrom` dice de dónde salieron.
 */
function plan({ repo: given, source, target }, deps = {}) {
  const at = rootOf(given, deps);
  if (at.problem) return stop(at.problem);
  const repo = at.root;
  const where = hostOf(repo, deps);
  if (where.problem) return stop(where.problem);
  const config = mergeConfigFor(repo, () => where, deps);
  if (config.problem) return stop(config.problem);
  const notes = config.note ? [config.note] : [];
  let step = '9';
  let canMerge = false;
  if (config.mode !== 'pr') {
    notes.push(config.configFrom === 'maintainers'
      ? `${config.declaredIn} declara merge.mode: ${config.mode}, no pr: el merge se empuja (paso 9)`
      : `el repo no declara merge.mode: pr en ${CONFIG_FILE}: el merge se empuja (paso 9)`);
  } else if (where.host === 'azure') {
    step = '9b';
  } else if (where.host === 'github') {
    step = '9c';
    canMerge = Boolean(config.check);
    if (!canMerge) notes.push(`falta declarar merge.check en ${config.declaredIn} (el nombre exacto del control de la validación): el pedido se crea y NO se mergea — un pedido trae varios controles y no se elige uno por cuenta propia`);
  } else if (where.host === 'local') {
    notes.push('origin es una carpeta de esta máquina: el empuje va a esa carpeta, no a un servidor (paso 9)');
  } else if (where.host === 'none') {
    notes.push('el repo no tiene origin: no hay a dónde crear un pedido (paso 9)');
  } else {
    notes.push(`en el servidor de origin (${where.url}) no sé crear pedidos: paso 9. Si es un alias de ssh de GitHub que ssh no resuelve, revisá «ssh -G» de ese alias`);
  }
  const version = step === '9c' ? bumpVersion({ repo, source, target }, deps) : null;
  // un número que no se pudo calcular se DICE: `version: null` solo se leería como «este repo no numera versiones»
  if (version && version.code !== 0) notes.push(`no pude calcular la versión que subiría: ${version.reason}`);
  return Object.assign({ code: 0, host: where.host, mode: config.mode, check: config.check, configFrom: config.configFrom, step, canMerge, notes },
    where.host === 'azure' ? { org: where.org, project: where.project, name: where.name } : {},
    where.host === 'github' ? { ghRepo: where.ghRepo, name: where.name } : {},
    bodyFiles(repo, source),
    { version: version && version.code === 0 ? { action: version.action, from: version.from || null, to: version.to || null, reason: version.reason || null } : null });
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
  '--check': 'check', '--from': 'from', '--to': 'to', '--timeout-min': 'timeoutMin', '--interval-s': 'intervalS' };

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
  if (opts.repo) opts.repo = path.resolve(opts.repo);
  const result = order.run(opts);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.code !== 0 && result.reason) process.stderr.write(`merge-pr ${argv[0]}: ${result.reason}\n`);
  return result.code;
}

if (require.main === module) process.exitCode = main();

module.exports = { main, plan, hostOf, rootOf, readMergeConfig, parseMergeConfig, mergeConfigFor, bodyFiles, parseSshHostname, updateBranch, bumpVersion, checkVersion, versionAt,
  waitChecks, judgeCheck, message, withoutCiSkip, cleanTopic, USAGE };
