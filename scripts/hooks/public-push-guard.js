#!/usr/bin/env node
'use strict';
// public-push-guard.js — el freno antes de publicar
//
// 🔴 POR QUÉ EXISTE. El arnés se mantiene directo en su repo público: una rama empujada ya es pública, antes de cualquier
// pedido o merge, y lo publicado no se retira (borrar la rama no borra los commits). Sin exportador entre medio, este
// freno es lo único que hay ANTES de que algo llegue al público. Tres decisiones lo mantienen útil en el camino normal:
//   · mira CADA commit nuevo, no la diferencia neta: un commit que mete un nombre y otro que lo saca dejan el nombre en la
//     historia empujada;
//   · corre el detector COMPLETO (scripts/publishing/detector.js), no sólo los términos de la lista: un token, un correo
//     o una ruta de máquina también son lo que no puede salir;
//   · «no pude mirar» —sin la lista en una máquina del equipo, un objeto ilegible, el tope de tiempo— nunca es verde.
//
// QUÉ MIRA, en un empuje del arnés a un remoto PÚBLICO. Es «del arnés» por cualquiera de tres señales: el árbol de
// trabajo trae scripts/install-tycon-hooks.sh, lo que se empuja lo trae, o el remoto es un repo que el arnés declara suyo:
//   · el contenido y la ruta de cada archivo que agrega o cambia cualquiera de los commits nuevos (los que ese remoto no
//     tiene: contra la punta remota que informa git y lo que el propio remoto dice tener; si no contesta, todo). Un binario
//     sin permiso, un enlace simbólico y un submódulo cuentan como «sin leer»;
//   · el mensaje, el autor y el committer de cada commit, y el nombre, el mensaje y el firmante de una marca anotada: el
//     nombre contra la lista, y el correo tiene que ser un `noreply` de GitHub;
//   · el nombre de la rama o de la marca, y que la ref sea una rama o una marca (una nota o un guardado no se publican);
//   · un número de pedido en un mensaje o en un nombre de ref (la forma la define scripts/publishing/internal-history.js;
//     un nombre de ref se mira además con sus separadores vueltos espacios). Un pedido del repo público no cuenta —el
//     asunto con que GitHub mergea, «Merge pull request #N from …», es uno—: el control le pregunta al repo público
//     (al remoto al que se empuja; en un rango o en un `gh`, al `origin` de GitHub) y, si no contesta, cuenta;
//   · las rutas vedadas: las seis carpetas que nunca son públicas y las que sume la lista privada (`forbiddenPaths`).
// PÚBLICO es todo remoto que no sea de Azure DevOps ni una carpeta local (que se sigue hasta su `origin`). Se decide con
// la dirección que git le pasa al hook, nunca con `origin`; una dirección que no se sabe leer es pública.
//
// DE DÓNDE SALE LA LISTA, en orden: TYCON_PUBLISH_DENYLIST (un archivo) · el clon de mantenimiento que declara la máquina
// (`harness.js config set paths.maintainers <carpeta>`) · el clon que la máquina mantiene (`paths.maintained`) · el arnés
// desde el que corre este guion. De un clon se lee la lista de su rama principal remota, como la conoce el clon
// (`origin/HEAD`, o `origin/main`; sin traer nada): la del disco sólo si el clon no tiene esa rama o la rama no trae la
// lista. NUNCA el árbol que se empuja: la rama elegiría con qué lista se la mira. Los dos
// primeros son una declaración: si están declarados y la lista no está, es «no pude mirar». En una máquina con el perfil
// del equipo (`team-profile.json`, o `perfil-equipo.json`) la lista es obligatoria. Sin perfil y sin lista (alguien de afuera con su copia)
// corre lo que no necesita lista, y lo dice.
//
// ¿ESA LISTA ESTÁ AL DÍA? La lista se lee del disco de un clon: si ese clon está
// atrasado respecto de su remoto, frena por su propia firma lo que una excepción ya
// publicada deja pasar — y al revés, con una lista vieja se escapa el término que se sumó ayer. Se MIDE y
// se AVISA; nunca cambia un veredicto ni un código de salida. Tres medidas, de la más barata a la más cara:
//   · el archivo del disco contra el de la rama principal remota como la conoce el clon (`origin/HEAD`, o `origin/main`):
//     ve el clon parado en una rama de trabajo, un `HEAD` suelto y la lista editada a mano; y cuántos commits atrás está;
//   · la edad de la última traída (la fecha de `FETCH_HEAD`), sin red: con 3 días cumplidos, avisa;
//   · sólo al empujar —que ya sale a la red— y con `status --fetch`: se le pregunta al remoto del clon por la punta de
//     su rama principal, con un tope corto y sin pedir claves. Es lo único que ve el atraso real: un clon que nadie trajo
//     está «al día» con lo que él conoce.
// Lo que avisa, además del atraso: una última traída que FALLÓ (git deja vacío su `FETCH_HEAD`: no es «traído hoy») y un
// clon que está ADELANTE de su remoto (una excepción commiteada sin subir: ahí no dice «atrasado» ni «traelo», dice
// «subilo»). La edad avisa con 3 días cumplidos.
// LO QUE NO VE: sin preguntarle al remoto, lo que el remoto sumó desde la última traída; si los commits que faltan tocan
// la lista (pregunta por la punta, no trae nada); una lista suelta fuera de un clon; un clon sin rama principal remota.
// CUÁNDO SE DICE QUE NO SE PUDO MEDIR: en `status` y en `doctor` («no pude medir si la lista está al día: <por qué>»).
// En el EMPUJE, no: ahí sólo se suman líneas cuando hay algo que avisar, y lo que no se pudo medir calla (el dato queda
// en `list.freshness` de `--json`). El aviso lleva sólo cuentas (commits, días) y la ruta del clon en esta máquina:
// nunca el asunto de un commit ni el nombre de una rama, que son del repo privado. No mide el modo `range` (ahí la
// lista llega por variable) ni el freno de `gh` (correría en cada comando).
// Medir no ejecuta nada de lo que el clon de la lista configure: toda llamada a git sobre él va con el vigía del
// sistema de archivos y el protocolo `ext::` apagados, la lista se compara leyéndola (sin los filtros del clon), y la
// pregunta al remoto va siempre sin interacción (`BatchMode` también sobre el comando de ssh de la persona).
//
// LO QUE NO TIENE: una variable que lo apague. De un freno falso se sale con una excepción con motivo en la lista
// privada (`permitidos`), como en el exportador. Las variables que dicen de dónde salen la lista y el freno
// (TYCON_PUBLISH_DENYLIST, TYCON_GUIDES_DIR, TYCON_HOME) son de las pruebas y de la validación: el freno de la sesión no
// deja correr un `git push` ni un `gh` que publica con una de ellas puesta en la misma línea. La salida dice DÓNDE
// (archivo y línea, «el mensaje del commit X») y la categoría; nunca el texto encontrado, ni una ruta o un nombre de
// rama que sean ellos mismos el hallazgo.
//
// MODOS:
//   node public-push-guard.js pre-push <remoto> <dirección> [--json]   (las líneas de git por la entrada; lo llama
//        scripts/hooks/git-pre-push-global.sh, que el instalador deja como `pre-push` global de git)
//   node public-push-guard.js range --base <commit> --head <commit> [--branch <nombre>] [--title-file <archivo>]
//        [--body-file <archivo>] [--json]       (un PEDIDO, en su validación — cada commit que suma a
//        su rama destino, el nombre de la rama, el título y el cuerpo. No le pregunta nada al remoto y la lista es
//        siempre obligatoria; lo llama el paso «El freno de publicación sobre el pedido» de pipelines/azure-pipelines-maintainers-pr.yml)
//   node public-push-guard.js pre-commit                               (lo que agrega este commit, dentro del control del
//        commit: lo llama .githooks/pre-commit-checks. Más abajo, `preCommit`)
//   node public-push-guard.js status [--fetch]                       (¿está puesto?, ¿de dónde sale la lista?, ¿está al
//        día?; con `--fetch` se le pregunta además al remoto del clon de la lista. Su código no cambia por la frescura)
//   node public-push-guard.js                                          (sin argumentos: el freno previo a la herramienta
//        de Claude Code y de Codex, con el evento por la entrada; mira los `gh` que publican sin empujar — más abajo)
// Códigos de `pre-push`: 0 pasa, o no es asunto de este freno · 1 hay hallazgos · 2 no pude mirar. `status`: 0 · 1.
// Códigos de `range`: 0 limpio · 1 hay hallazgos · 2 no pude mirar (sin lista, sin el control de historia interna, una
// base que git no conoce, el tope de tiempo sin hallazgos).
// Como freno previo a la herramienta: 2 = el comando no corre · 0 = pasa.
// TYCON_PUBLIC_PUSH_TREAT_AS_PUBLIC (carpetas, separadas como el PATH) AGREGA remotos locales a mirar: es de las pruebas.
// TYCON_PUBLIC_PUSH_LIMIT_MS cambia el tope de tiempo (120 s). Guía: guides/maintaining/publicacion-espejo.md §«El freno antes de publicar».

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const detector = () => require(path.join(ROOT, 'scripts', 'publishing', 'detector.js'));
const harnessRepo = () => require(path.join(ROOT, 'scripts', 'lib', 'harness-repo.js'));

const TREE_MARK = 'scripts/install-tycon-hooks.sh';
// el perfil del equipo con su nombre de hoy o el de antes (los dos dicen «este árbol es del equipo»)
const PROFILES = ['team-profile.json', 'perfil-equipo.json'];
const hasProfile = (dir) => PROFILES.some((n) => fs.existsSync(path.join(dir, n)));
const LIST_PATH = 'scripts/publishing/denylist.json';
const HISTORY_PATH = 'scripts/publishing/internal-history.js';
const HOOK_MARK = 'git-pre-push-global.sh';
const FORBIDDEN = Object.freeze(['.engram/', 'specs/', 'tasks/', 'inbox/', '.advisors/', '.dashboard/']);
const DEFAULT_LIMIT_MS = 120000;
const REMOTE_ANSWER_MS = 20000;   // cuánto se espera a que el remoto diga qué tiene; si no contesta, se mira todo
// la frescura de la lista: es un aviso, así que sus topes son cortos — nunca alarga un empuje de verdad
const LIST_STALE_DAYS = 3;            // con estos días CUMPLIDOS desde la última traída del clon de la lista, se avisa
const LIST_REMOTE_ANSWER_MS = 8000;   // cuánto se espera a que el remoto de ese clon diga su punta; si no contesta, no se dice nada de él
const LIST_LOCAL_GIT_MS = 10000;      // cada pregunta a git sobre ese clon, sin red: si no contesta, «no se pudo medir»
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SHOWN = 40;
const MAX_HOPS = 4;
// las mismas rutas ficticias con que la verificación de lo publicado (scripts/publishing/mirror.js) revisa lo que no es
// un archivo: una excepción de la lista escrita para una vale para las dos
const ROUTES = Object.freeze({ pullRequest: '<pull-request>', identity: '<commit-identity>', message: '<commit-message>', paths: 'rutas-de-la-copia.txt' });
// (el guion bajo es de las cuentas que administra una empresa: `usuario_empresa`)
const NOREPLY = /^(?:\d+\+)?[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\[bot\])?@users\.noreply\.github\.com$/i;
const GITHUB_ITSELF = 'noreply@github.com';   // el committer de un merge hecho en GitHub
const ZERO = /^0+$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MODE_LINK = '120000';
const MODE_SUBMODULE = '160000';

/** «No pude mirar»: nunca verde. El mensaje va a la salida: no lleva texto de un archivo, de un commit ni de la lista. */
class Blind extends Error {}
/** El tope de tiempo. Si para entonces ya había hallazgos, se dicen (y que no se terminó de mirar); si no, es «no pude mirar». */
class OutOfTime extends Blind {}
const CHUNK = 200;   // cuántos archivos se leen de git por vez: un empuje enorme no carga todo en memoria

const short = (sha) => String(sha).slice(0, 10);

function git(cwd, args, { input, binary = false, env = null } = {}) {
  // la entrada va como bytes: con `encoding: 'buffer'` Node no sabe convertir un texto
  // GIT_NO_REPLACE_OBJECTS: se lee el objeto de VERDAD. Con un reemplazo (`git replace`) git muestra otro objeto en su
  // lugar, pero el empuje manda el original: un commit sucio «arreglado» con un reemplazo se miraría limpio y saldría tal cual.
  return spawnSync('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], {
    input: input === undefined ? undefined : Buffer.from(input), ...(binary ? {} : { encoding: 'utf8' }), maxBuffer: 1024 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', ...env },
  });
}
/** La salida de git, o «no pude mirar» nombrando sólo el subcomando (el error de git puede repetir un nombre de rama). */
function gitOut(cwd, args, opts) {
  const r = git(cwd, args, opts);
  if (r.error || r.status !== 0) throw new Blind(`no pude leer el repo (git ${args[0]} salió ${r.status === null ? 'sin código' : r.status})`);
  return r.stdout;
}

/** git sobre OTRO repo (seguir una carpeta local hasta su `origin`): sin las variables con que git corre un hook, que
 *  apuntan al repo que se está empujando (con `GIT_DIR` puesta, `git -C <otro>` seguiría leyendo el de acá). */
const GIT_OF_THE_PUSH = /^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR|NAMESPACE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/;
/** FIRMA: gitElsewhere(dir, args, { env = process.env, extra = null, timeout, maxBuffer } = {}) → lo que devuelve
 *  `spawnSync`. `extra`: variables que se suman después de limpiar; `timeout`: el tope, en milisegundos (sin tope si no
 *  se pasa); `maxBuffer`: cuánta salida se acepta (la de Node si no se pasa). */
function gitElsewhere(dir, args, { env = process.env, extra = null, timeout = undefined, maxBuffer = undefined } = {}) {
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !GIT_OF_THE_PUSH.test(k)));
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: extra ? { ...clean, ...extra } : clean, windowsHide: true,
    ...(timeout ? { timeout } : {}), ...(maxBuffer ? { maxBuffer } : {}) });
}

/** La raíz del árbol de trabajo, o null (un repo desnudo no tiene; ahí git igual corre parado en el repo). */
function toplevel(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.status === 0 && String(r.stdout).trim() ? path.resolve(String(r.stdout).trim()) : null;
}
/**
 * Lo mismo, diciendo además si se SABE: `{ top, known }`. «Esta carpeta no es un repo» es una respuesta; «git no pudo
 * contestar» (un clon de otro dueño que git no quiere abrir, un repo desnudo, una carpeta que no está, git ausente) no
 * lo es — leído como «no es un clon», el `gh` corrido ahí saldría sin mirar. Se le pide a git en inglés para poder leerlo.
 */
function repoAt(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  if (!r.error && r.status === 0 && String(r.stdout).trim()) return { top: path.resolve(String(r.stdout).trim()), known: true };
  return { top: null, known: !r.error && r.status === 128 && /not a git repository/i.test(String(r.stderr || '')) };
}
const isHarnessTree = (top) => Boolean(top) && fs.existsSync(path.join(top, TREE_MARK));

// ── qué remoto es público ────────────────────────────────────────────────────────────────────────────────────────
/**
 * La ruta REAL de algo del disco, para comparar dos rutas. 🔴 La variante nativa, siempre: `fs.realpathSync` a secas
 * resuelve los enlaces pero deja las mayúsculas como se ESCRIBIERON, y en un disco que no las distingue (la Mac por
 * defecto, Windows) la misma carpeta nombrada con otra caja da otra ruta. Con eso «¿está adentro de?» decidiría letra
 * por letra: la lista saldría del propio árbol que se empuja si la máquina lo declara con otra caja, y el aviso de la
 * lista atrasada no podría medir. git y la variante nativa devuelven la caja del disco. Toda comparación de rutas de
 * este archivo pasa por acá o por `isInside`.
 */
function realOf(p) {
  const abs = path.resolve(p);
  // lo que no está en el disco no tiene ruta real: se toma la de la carpeta más cercana que sí está, más lo que falta
  // (así una ruta a un archivo que todavía no existe tampoco se compara como se escribió)
  const rest = [];
  for (let cur = abs; ;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch (_) { /* no está: se prueba con su carpeta */ }
    const up = path.dirname(cur);
    if (up === cur) return abs;
    rest.unshift(path.basename(cur));
    cur = up;
  }
}
/** ¿`file` está adentro de la carpeta `dir`? Con las rutas reales de los dos lados (nunca como están escritas). */
function isInside(file, dir) { return realOf(file).startsWith(realOf(dir) + path.sep); }
function treatedAsPublic(dir, env) {
  const real = realOf(dir);
  return String(env.TYCON_PUBLIC_PUSH_TREAT_AS_PUBLIC || '').split(path.delimiter).filter(Boolean).map(realOf)
    .some((p) => real === p || real.startsWith(p + path.sep));
}
/**
 * `{ kind: 'public' | 'private' | 'local' }`. Privado: Azure DevOps. Local: una carpeta de esta máquina cuya cadena de
 * `origin` termina en una carpeta sin `origin`. Todo lo demás —GitHub, un alias de ssh, otro servidor, una dirección
 * que no se sabe leer, una cadena de clones que no termina— es público: ante la duda se mira.
 */
function judgeRemote(url, cwd, env = process.env) {
  const H = harnessRepo();
  let u = String(url || '').trim();
  let dir = cwd;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    // sin dirección: al seguir una carpeta, es «no tiene origin» (no sale de esta máquina). De entrada no es eso: git
    // siempre le pasa una al hook, así que vacía es una dirección que no se sabe leer — y ésa es pública
    if (!u) return { kind: hop === 0 ? 'public' : 'local' };
    if (H.identidadAzure(u)) return { kind: 'private' };
    const local = H.rutaLocalDe(u, dir);
    if (!local) return { kind: 'public' };
    if (treatedAsPublic(local, env)) return { kind: 'public' };
    const r = gitElsewhere(local, ['config', '--get', 'remote.origin.url']);
    if (r.error || (r.status !== 0 && r.status !== 1)) return { kind: 'public' };   // git no pudo contestar: no es «sin origin»
    u = r.status === 0 ? String(r.stdout).trim() : '';
    dir = local;
  }
  return { kind: 'public' };
}

// ── la lista ─────────────────────────────────────────────────────────────────────────────────────────────────────
function machinePaths(env) {
  // la ruta del archivo la sabe scripts/setup/harness/tycon-home.js; se carga si está (un laboratorio puede no traerla)
  const lib = path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js');
  let file = path.join(env.HOME || os.homedir(), '.tycon', 'config.json');
  if (fs.existsSync(lib)) {
    try { file = require(lib).ownPaths({ env }).config; } catch (_) { throw new Blind('no pude ubicar la configuración de esta máquina (TYCON_HOME no es una ruta válida)'); }
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw new Blind('la configuración de esta máquina (config.json del arnés) no se puede leer: no sé dónde declaró la lista');
  }
  const paths = data && typeof data === 'object' && data.paths && typeof data.paths === 'object' ? data.paths : {};
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { maintainers: clean(paths.maintainers), maintained: clean(paths.maintained) };
}

/**
 * FIRMA: listPlaces(env) → [{ source, label, file, declared }], en el orden en que se buscan. Tira `Blind` si la
 * configuración de la máquina está y no se deja leer.
 * Los lugares de la lista, en orden. `declared`: quien lo puso dijo «la lista está acá»; si no está, es «no pude mirar».
 * El árbol que se empuja NO es un lugar: la rama elegiría con qué lista se la mira (una lista adelgazada en la rama
 * dejaría pasar lo que sacó). Un clon del interno empujado por error a un remoto público, en una máquina que no declara
 * la lista, es «no pude mirar»: no sale.
 */
function listPlaces(env) {
  const out = [];
  if (env.TYCON_PUBLISH_DENYLIST) out.push({ source: 'env', label: 'TYCON_PUBLISH_DENYLIST', file: path.resolve(env.TYCON_PUBLISH_DENYLIST), declared: true });
  const m = machinePaths(env);
  if (m.maintainers) out.push({ source: 'maintainers', label: 'el clon de mantenimiento (paths.maintainers)', file: path.join(m.maintainers, LIST_PATH), declared: true });
  if (m.maintained) out.push({ source: 'maintained', label: 'el clon que esta máquina mantiene (paths.maintained)', file: path.join(m.maintained, LIST_PATH), declared: false });
  out.push({ source: 'harness', label: 'el arnés desde el que corre el freno', file: path.join(ROOT, LIST_PATH), declared: false });
  return out;
}

const isTeamMachine = (top) => hasProfile(ROOT) || (Boolean(top) && hasProfile(top));

/**
 * La lista con que se mira. Tira `Blind` si la máquina tiene que tener lista y no la tiene, o si la que hay no se deja
 * leer (una lista ilegible no es una lista vacía).
 *
 * FIRMA (la usan también `harness.js doctor` y el freno de nombres del commit, scripts/publishing/new-names.js):
 *   resolveList(top, env = process.env, { pushing = false, optional = false, required = false } = {})
 *     top       la raíz del árbol que se mira, o null. Sólo decide dos cosas: con `pushing`, que la lista no salga de
 *               ese mismo árbol; y si la máquina «es del equipo» por un perfil que ese árbol traiga.
 *     pushing   se está por publicar `top`: un lugar que cae adentro de él no cuenta.
 *     optional  sin lista en una máquina del equipo no es «no pude mirar»: devuelve la genérica.
 *     required  sin lista es siempre «no pude mirar» (la validación de un pedido).
 *   → { cfg, forbidden, source, label, file, generic, terms, extraForbidden }
 *     source    'env' | 'maintainers' | 'maintained' | 'harness' (el lugar de `listPlaces` que ganó), o null
 *     file      la ruta del archivo de la lista en esta máquina, o null — es lo que se le pasa a `listFreshness`
 *     readFrom  'remote' (la rama principal remota del clon de `file`) | 'disk' — también se le pasa a `listFreshness`
 *     generic   true = no hay lista: sólo lo que no la necesita (source, label y file en null; terms en 0)
 *     cfg, forbidden, termList   lo que usa el detector y los términos tal como están escritos; nunca se imprimen
 * Un `Blind` por una lista que está y no se deja leer lleva `listFile` y `listSource` (para poder decir si ese clon
 * está al día: una lista con las marcas de un merge a medias es justo un clon que no se terminó de traer).
 */
function resolveList(top, env = process.env, { pushing = false, optional = false, required = false } = {}) {
  const D = detector();
  const generic = () => ({ cfg: D.cargarConfig('<sin lista>', '{}'), forbidden: [], source: null, label: null, file: null, generic: true, terms: 0, extraForbidden: 0 });
  const unreadable = (place, message) => Object.assign(new Blind(message), { listFile: place.file, listSource: place.source });
  const inPushedTree = (file) => pushing && Boolean(top) && isInside(file, top);
  for (const place of listPlaces(env)) {
    // Al empujar, un lugar que cae ADENTRO del árbol que se empuja no cuenta, lo nombre quien lo nombre (el clon que la
    // máquina mantiene puede ser ése mismo): la rama elegiría con qué lista se la mira. También TYCON_PUBLISH_DENYLIST:
    // un archivo del árbol de trabajo lo dejó ahí la rama que está sacada, que es la que se empuja.
    if (inPushedTree(place.file)) {
      if (place.declared) throw new Blind(`sin la lista: ${place.label} es el mismo árbol que se empuja, y la lista no puede salir de ahí`);
      continue;
    }
    if (!fs.existsSync(place.file)) {
      if (place.declared) throw new Blind(`sin la lista: ${place.label} está declarado y ahí no hay lista`);
      continue;
    }
    // la lista de la rama principal remota del clon, como la conoce el clon: un clon compartido parado atrás (o en otra
    // rama) frenaba por su propia firma lo que una excepción ya mergeada deja pasar. Sin esa rama, la del disco.
    // TYCON_PUBLISH_DENYLIST es un archivo, y se lee tal cual.
    let atRemote = null;
    try { atRemote = place.source === 'env' ? null : listClone(place.file, env); } catch (_) { atRemote = null; }
    const readFrom = atRemote && !atRemote.why ? 'remote' : 'disk';
    let raw;
    let cfg;
    try {
      raw = JSON.parse(readFrom === 'remote' ? atRemote.published : fs.readFileSync(place.file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('no es un objeto');
      if (!Array.isArray(raw.terminos) || raw.terminos.length === 0) throw new Error('no trae términos');
      cfg = D.cargarConfig(place.file, JSON.stringify(raw));
    } catch (_) {
      // el motivo de un error de la lista puede nombrar un término: no se imprime
      throw Object.assign(unreadable(place, `la lista de ${place.label} no se puede leer (no es una lista válida)`), { listReadFrom: readFrom });
    }
    const globs = raw.forbiddenPaths === undefined ? [] : raw.forbiddenPaths;
    if (!Array.isArray(globs) || globs.some((g) => typeof g !== 'string' || !g.trim())) throw Object.assign(unreadable(place, `la lista de ${place.label} trae "forbiddenPaths" mal escritas (es una lista de rutas)`), { listReadFrom: readFrom });
    return { cfg, forbidden: globs.map((g) => D.globARegex(g)), source: place.source, label: place.label, file: place.file, readFrom, termList: raw.terminos, generic: false, terms: raw.terminos.length, extraForbidden: globs.length };
  }
  // `optional`: quien llama no sabe si lo que mira va al repo público del arnés (un `gh` de destino desconocido). En la
  // máquina de alguien del equipo que no mantiene —tiene el perfil, no tiene la lista— exigirla ahí frenaría un `gh`
  // común en un repo de producto, con una instrucción que esa persona no puede cumplir. Se mira lo que no necesita lista.
  // `required`: la validación de un pedido (el modo de rango). Ahí no existe «sólo lo que no necesita lista»: el agente
  // que la corre no tiene perfil ni máquina, y un pedido mirado sin la lista saldría verde con cualquier nombre adentro.
  if (required) throw new Blind('sin la lista: un pedido se mira siempre con la lista privada, y no llegó ninguna que no salga del propio pedido (va en TYCON_PUBLISH_DENYLIST, fuera del árbol)');
  if (isTeamMachine(top) && !optional) throw new Blind('sin la lista: esta máquina es del equipo (tiene su perfil) y no encontré la lista privada en ningún lugar — declarala con `harness.js config set paths.maintainers <clon de mantenimiento>`');
  return generic();
}

// ── ¿la lista está al día? ──────────────────────────────────────
// Lo que se le antepone a TODA llamada a git sobre el clon de la lista. Ese clon es de otro repo y su configuración no
// la escribió este freno: medir no puede ejecutar lo que ahí esté configurado. `core.fsmonitor` es un programa que git
// lanza cada vez que refresca el índice; el protocolo `ext::` hace de una dirección de remoto un comando. (El ayudante
// de credenciales NO se apaga: sin él, el remoto privado no contesta.) Por lo mismo la lista del disco no se compara
// con `git hash-object`, que le pasa los filtros `clean` que ese clon configure: se lee y se compara acá.
const LIST_CLONE_GIT = Object.freeze(['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never']);
const LIST_MAX_BYTES = 64 * 1024 * 1024;
/** Dos textos de la lista, iguales salvo el fin de línea (un clon de Windows la tiene con CRLF: no es «la lista cambió»). */
const sameList = (a, b) => String(a).replace(/\r\n/g, '\n') === String(b).replace(/\r\n/g, '\n');
/** Una dirección de remoto como git la anota en `FETCH_HEAD`: sin credenciales, sin la barra ni el `.git` del final. */
const fetchedUrl = (u) => String(u || '').trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1').replace(/^[^/@:]+@(?=[^/:]+:)/, '')
  .replace(/[\\/]+$/, '').replace(/\.git$/, '').replace(/[\\/]+$/, '');

/**
 * La última traída de un clon: `{ at, failed }`. `at`: la fecha (ms) de la última traída BUENA de `origin` que consta,
 * o null. `failed`: el último intento falló. Sale de `FETCH_HEAD`, que git reescribe en cada traída; un clon recién
 * hecho no tiene, y cada árbol enlazado (`git worktree`) anota el suyo: se miran todos, del más nuevo al más viejo.
 * 🔴 La fecha de ese archivo sola no alcanza: git lo VACÍA antes de conectarse, así que una traída que falla lo deja en
 * 0 bytes y con fecha de hoy — leído como «traído hoy», el aviso por edad no saldría nunca justo con el remoto
 * inalcanzable. Y la traída de OTRO remoto del clon lo reescribe igual: ésa no dice nada de la rama principal de la
 * lista, y no cuenta (sólo cuando se reconoce con certeza que es de otro remoto del clon; ante la duda, cuenta).
 */
function lastFetch(clone, ask, said) {
  const files = [];
  const own = said(ask(clone, ['rev-parse', '--git-path', 'FETCH_HEAD']));
  if (own) files.push(path.resolve(clone, own));
  const common = said(ask(clone, ['rev-parse', '--git-common-dir']));
  if (common) {
    const dir = path.resolve(clone, common);
    files.push(path.join(dir, 'FETCH_HEAD'));
    try { for (const name of fs.readdirSync(path.join(dir, 'worktrees'))) files.push(path.join(dir, 'worktrees', name, 'FETCH_HEAD')); } catch (_) { /* sin árboles enlazados */ }
  }
  const found = [];
  for (const f of new Set(files)) {
    try { found.push({ file: f, at: fs.statSync(f).mtimeMs }); } catch (_) { /* ése no trajo nunca */ }
  }
  found.sort((a, b) => b.at - a.at);
  let remotes = null;   // { origin, others }: se le pregunta a git sólo si hace falta
  const ofAnotherRemote = (text) => {
    const urls = [...new Set(text.split('\n').map((l) => { const i = l.lastIndexOf(' of '); return i < 0 ? '' : fetchedUrl(l.slice(i + 4)); }).filter(Boolean))];
    if (!urls.length) return false;
    if (!remotes) {
      const urlOf = (name) => fetchedUrl(said(ask(clone, ['remote', 'get-url', name])));
      const names = String(said(ask(clone, ['remote'])) || '').split('\n').map((s) => s.trim()).filter((n) => n && n !== 'origin');
      remotes = { origin: urlOf('origin'), others: names.map(urlOf).filter(Boolean) };
    }
    return Boolean(remotes.origin) && !urls.includes(remotes.origin) && urls.every((u) => remotes.others.includes(u));
  };
  for (const { file, at } of found) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return { at, failed: false }; }   // está y no se deja leer: vale su fecha
    if (!text.trim()) return { at: null, failed: true };
    if (!ofAnotherRemote(text)) return { at, failed: false };
  }
  return { at: null, failed: false };
}

/**
 * ¿La lista que se lee del disco es la del remoto de su clon? Mide; no decide nada (quien llama avisa).
 *
 * FIRMA (la usan también `harness.js doctor` y el freno de nombres del commit, scripts/publishing/new-names.js):
 *   listFreshness(file, { env = process.env, askRemote = false, remoteMs = LIST_REMOTE_ANSWER_MS } = {})
 *     file        la ruta del archivo de la lista: el `file` que devuelve `resolveList` (o el de un lugar de `listPlaces`)
 *     askRemote   true = además se le pregunta al remoto del clon por la punta de su rama principal. SALE A LA RED:
 *                 sólo donde ya se sale (un empuje) o donde la persona lo pide (`status --fetch`, `doctor --fetch`)
 *     remoteMs    el tope de esa pregunta
 *     readFrom    de dónde leyó la lista el freno (el `readFrom` de `resolveList`): con 'remote', `differs` es false
 *   → {
 *       measured,         ¿se pudo medir? Si no, `why` dice por qué y las medidas vienen en null
 *       why,              el motivo (no es un clon · sin rama principal remota conocida · git no contestó · …), o null
 *       clone,            la raíz del clon donde vive la lista (una ruta de esta máquina), o null
 *       differs,          el archivo del DISCO no es el de la rama principal remota como la conoce el clon (comparados
 *                         como texto, sin contar el fin de línea)
 *       behind,           cuántos commits tiene esa rama que el HEAD del clon no (null si git no los pudo contar)
 *       ahead,            cuántos commits tiene el HEAD del clon que esa rama no: lo propio sin subir (null ídem)
 *       edited,           el archivo del disco no es el del HEAD del clon: cambios a mano sin commitear (null si el
 *                         HEAD no trae la lista)
 *       onMain,           el clon está parado en su rama principal (false también con el HEAD suelto)
 *       fetchedDaysAgo,   días enteros desde la última traída buena de `origin`; null si no consta ninguna
 *       fetchFailed,      el último intento de traer ese clon falló (y entonces `fetchedDaysAgo` es null)
 *       remoteAsked,      (sólo con askRemote) ¿el remoto contestó a tiempo? Que no conteste no es un error
 *       remoteAhead,      (sólo con askRemote) true si la punta remota no es la que el clon conoce; null si no contestó
 *     }
 * Nunca tira: cualquier falla es «no se pudo medir». No escribe nada en ese clon (ni trae: preguntar no es traer), no
 * ejecuta nada de lo que ese clon configure (`LIST_CLONE_GIT`), y lo que devuelve no lleva el nombre de ninguna rama ni
 * el asunto de ningún commit —son del repo privado—: sólo cuentas y la ruta del clon. Todo `git` corre sin las variables
 * con que git lanza un hook (`gitElsewhere`), y la pregunta al remoto va SIEMPRE sin interacción.
 */
/**
 * El clon donde vive el archivo de la lista y su rama principal remota, como la conoce el clon: `{ real, clone, rel, ref,
 * tip, ask, said, blobOf, published }`, o `{ why, clone }` si no se puede ubicar. No trae ni escribe nada en ese clon, ni
 * ejecuta lo que configure (`LIST_CLONE_GIT`). `published`: la lista de esa rama, leída sin filtros (`cat-file blob`).
 */
function listClone(file, env) {
  if (!file) return { why: 'no hay un archivo de lista que medir', clone: null };
  // la ruta real NATIVA: con la caja del disco, que es la que devuelve git (ver `realOf`)
  let real;
  try { real = fs.realpathSync.native(file); } catch (_) { return { why: 'el archivo de la lista no está', clone: null }; }
  // a git se le pregunta en inglés (hay que leerle un error) y sin tomar candados: es una lectura
  const local = { env, timeout: LIST_LOCAL_GIT_MS, extra: { LC_ALL: 'C', LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } };
  const ask = (dir, args, more = {}) => gitElsewhere(dir, [...LIST_CLONE_GIT, ...args], { ...local, ...more });
  const said = (r) => (!r.error && r.status === 0 ? String(r.stdout || '').trim() : null);
  const where = ask(path.dirname(real), ['rev-parse', '--show-toplevel']);
  const top = said(where);
  if (!top) {
    const notARepo = !where.error && where.status === 128 && /not a git repository/i.test(String(where.stderr || ''));
    return { why: notARepo ? 'la lista no vive en un clon de git' : 'git no contestó dónde vive la lista', clone: null };
  }
  const clone = path.resolve(top);
  const rel = path.relative(realOf(clone), real).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { why: 'git no contestó dónde vive la lista', clone };
  // la rama principal del remoto, como la conoce este clon: la que `origin/HEAD` nombra; sin eso, `origin/main`
  const tipOf = (name) => { const sha = said(ask(clone, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${name}^{commit}`])); return sha && SHA.test(sha) ? sha : null; };
  let ref = said(ask(clone, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']));
  let tip = ref && ref.startsWith('refs/remotes/origin/') ? tipOf(ref) : null;
  if (!tip) { ref = 'refs/remotes/origin/main'; tip = tipOf(ref); }
  if (!tip) return { why: 'ese clon no tiene una rama principal remota conocida (ni origin/HEAD ni origin/main)', clone };
  const blobOf = (rev) => { const r = ask(clone, ['cat-file', 'blob', `${rev}:${rel}`], { maxBuffer: LIST_MAX_BYTES }); return !r.error && r.status === 0 ? String(r.stdout) : null; };
  const published = blobOf(tip);
  if (published === null) return { why: 'la rama principal remota de ese clon no trae la lista en esa ruta', clone };
  return { real, clone, rel, ref, tip, ask, said, blobOf, published };
}

function listFreshness(file, { env = process.env, askRemote = false, remoteMs = LIST_REMOTE_ANSWER_MS, readFrom = 'disk' } = {}) {
  const none = (why, clone = null) => ({ measured: false, why, clone, differs: null, behind: null, ahead: null, edited: null, onMain: null, fetchedDaysAgo: null, fetchFailed: null,
    ...(askRemote ? { remoteAsked: false, remoteAhead: null } : {}) });
  try {
    const c = listClone(file, env);
    if (c.why) return none(c.why, c.clone);
    const { real, clone, ref, tip, ask, said, blobOf, published } = c;
    // 1 · el archivo del disco contra el de esa rama, comparados ACÁ como texto: el del disco se lee tal cual y el de la
    //     rama se le pide a git sin pasar por ningún filtro (`cat-file blob`). Ni un filtro del clon corre, ni depende
    //     de cómo ese clon tenga configurados los fines de línea. Si el freno leyó la lista de esa rama (`readFrom:
    //     'remote'`), lo que tenga el disco no cambia nada de lo que miró: no es un aviso
    const onDisk = fs.readFileSync(real, 'utf8');
    const committed = blobOf('HEAD');
    const countOf = (range) => { const n = said(ask(clone, ['rev-list', '--count', range])); return n !== null && /^\d+$/.test(n) ? Number(n) : null; };
    const branch = ref.slice('refs/remotes/origin/'.length);
    const out = { measured: true, why: null, clone, differs: readFrom === 'remote' ? false : !sameList(onDisk, published), behind: countOf(`HEAD..${tip}`), ahead: countOf(`${tip}..HEAD`),
      edited: committed === null ? null : !sameList(onDisk, committed), onMain: said(ask(clone, ['symbolic-ref', '--quiet', 'HEAD'])) === `refs/heads/${branch}`,
      fetchedDaysAgo: null, fetchFailed: false };
    // 2 · la edad de la última traída, sin red (y si el último intento falló)
    const last = lastFetch(clone, ask, said);
    out.fetchFailed = last.failed;
    if (last.at !== null) out.fetchedDaysAgo = Math.max(0, Math.floor((Date.now() - last.at) / DAY_MS));
    // 3 · sólo si lo piden: la punta de esa rama en el remoto, HOY. 🔴 SIEMPRE sin interacción: esto corre en medio de
    //     un empuje, y si hace falta una clave que nadie puede tipear acá, no contesta, y no pasa nada (no se dice nada
    //     del remoto). También cuando la persona trae su propio comando de ssh (GIT_SSH_COMMAND, `core.sshCommand`,
    //     GIT_SSH): sin `BatchMode`, ssh pedía la clave o confirmaba un host por la terminal. Se le agrega al final
    //     del comando de ella (git usaría el suyo de todos modos; acá sólo se le saca la interacción).
    //     Límite asumido (revisor de seguridad, vuelta 2): esta pregunta obedece la configuración del PROPIO clon de la
    //     lista para llegar a su remoto (`core.sshCommand`, `remote.origin.*`, `url.*.insteadOf`, su ayudante de
    //     credenciales): es el clon que la persona declaró como suyo, y sin eso un remoto privado no contesta. Lo que
    //     no corre nunca es lo que ese clon configure para OTRAS cosas (`core.fsmonitor`, protocolos externos, filtros).
    if (askRemote) {
      const quiet = Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'GIT_ASKPASS' && k !== 'SSH_ASKPASS'));
      const extra = { LC_ALL: 'C', LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
      const ssh = quiet.GIT_SSH_COMMAND || said(ask(clone, ['config', '--get', 'core.sshCommand'])) || (quiet.GIT_SSH ? `"${quiet.GIT_SSH}"` : 'ssh');
      extra.GIT_SSH_COMMAND = `${ssh} ${/plink/i.test(ssh) ? '-batch' : '-oBatchMode=yes -oConnectTimeout=5'}`;
      const r = ask(clone, ['-c', 'core.askPass=', 'ls-remote', 'origin', `refs/heads/${branch}`], { env: quiet, extra, timeout: remoteMs });
      const answer = !r.error && r.status === 0 ? String(r.stdout || '').split('\n').map((l) => l.split('\t')).find((p) => p.length === 2 && p[1].trim() === `refs/heads/${branch}`) : null;
      const remoteTip = answer && SHA.test(answer[0].trim()) ? answer[0].trim() : null;
      out.remoteAsked = remoteTip !== null;
      out.remoteAhead = remoteTip === null ? null : remoteTip !== tip;
    }
    return out;
  } catch (_) {
    return none('no se pudo medir');
  }
}

/**
 * Lo medido, en una línea para una persona.
 * FIRMA: freshnessText(f) → { level: 'ok' | 'warn' | 'unknown', kind, advice, text }   (`f`: lo de `listFreshness`)
 *   level 'warn'     la lista no es la del remoto, el remoto tiene novedades, la última traída es vieja o falló
 *   level 'unknown'  no se pudo medir (y el texto dice por qué)
 *   kind             sólo con 'warn': 'stale' (atrasado, en otra rama o tocado a mano) · 'ahead' (adelante de su remoto:
 *                    commits propios sin subir, y nada más) · 'fetch-failed' (lo único que se sabe es que no se pudo traer)
 *   advice           sólo con 'warn': qué hacer, con su comando (traerlo · mirarlo primero · subir lo propio). Quien
 *                    arme su propio texto usa ESTE consejo: «traelo» no sirve para un clon que está adelante
 *   text             una línea, sin sangría
 * Sólo cuentas —commits, días— y la ruta del clon.
 */
function freshnessText(f) {
  if (!f || !f.measured) return { level: 'unknown', kind: null, advice: null, text: `no pude medir si la lista está al día: ${(f && f.why) || 'no se pudo medir'}` };
  const pull = `git -C "${f.clone}" pull`;
  const push = `git -C "${f.clone}" push`;
  const behind = f.behind > 0;
  const ahead = f.ahead > 0;
  const tidy = f.onMain === true && f.edited !== true;   // parado en su rama principal y sin cambios a mano en la lista
  // si el remoto acaba de contestar que no tiene nada nuevo, cuándo fue la última traída —o que falló— ya no dice nada
  const nothingNew = f.remoteAsked === true && f.remoteAhead === false;
  const parts = [];
  let advice = `traé ese clon (${pull})`;
  // 🔴 ADELANTE de su remoto, y nada más: en su rama principal, ningún commit atrás, commits propios sin subir (una
  // excepción commiteada en la lista). No está «atrasado» y traerlo no cambia nada: lo que sirve es subirlos.
  // (`f.behind === 0`: un cero MEDIDO. Un conteo que git no pudo hacer llega como null, y eso no es «ninguno atrás».)
  const onlyAhead = Boolean(f.differs) && f.behind === 0 && ahead && tidy;
  if (f.differs && !onlyAhead) {
    if (behind && !ahead && tidy) parts.push(`${f.behind} commit(s) atrás de su rama principal remota, y la lista cambió`);
    else if (behind && ahead && tidy) {
      parts.push(`${f.behind} commit(s) atrás de su rama principal remota y ${f.ahead} commit(s) propios sin subir, y la lista no es la de esa rama`);
      advice = `traé ese clon y subí lo tuyo (${pull}, y después ${push})`;
    } else {
      // en otra rama, con el HEAD suelto o con la lista tocada a mano: traer no alcanza, primero hay que ver cómo está
      const why = [];
      if (f.edited === true) why.push('la lista tiene cambios a mano sin commitear');
      if (f.onMain !== true) why.push('el clon no está parado en su rama principal');
      if (behind) why.push(`${f.behind} commit(s) atrás`);
      parts.push(`la lista del disco no es la de su rama principal remota${why.length ? ` (${why.join('; ')})` : ''}`);
      advice = `mirá cómo está ese clon (git -C "${f.clone}" status), dejalo en su rama principal y traelo (${pull})`;
    }
  }
  if (f.remoteAhead === true) parts.push('su remoto tiene commits que este clon todavía no trajo');
  const fetchSaysNothing = f.remoteAhead === true || nothingNew;
  // una traída que falló no es una traída: no se sabe. Y la edad: «pasados N días» es con N días CUMPLIDOS (la cuenta
  // es un piso en días enteros; comparada con «más de N» avisaba recién al día siguiente)
  const fetchFailed = !fetchSaysNothing && f.fetchFailed === true;
  if (fetchFailed) parts.push('la última traída de ese clon falló: no sé si la lista está al día');
  else if (!fetchSaysNothing && f.fetchedDaysAgo !== null && f.fetchedDaysAgo >= LIST_STALE_DAYS) parts.push(`la última traída fue hace ${f.fetchedDaysAgo} día(s)`);
  if (onlyAhead && !parts.length) {
    return { level: 'warn', kind: 'ahead', advice: `subí esos commits (${push})`,
      text: `la lista sale de un clon que tiene cambios que su remoto todavía no tiene (${f.clone}): ${f.ahead} commit(s) sin subir` };
  }
  if (onlyAhead) {
    parts.push(`y ${f.ahead} commit(s) propios sin subir, con la lista cambiada`);
    advice = `traé ese clon y subí lo tuyo (${pull}, y después ${push})`;
  }
  if (parts.length === 1 && fetchFailed) return { level: 'warn', kind: 'fetch-failed', advice, text: `la lista sale de un clon que no se pudo traer (${f.clone}): ${parts[0]}` };
  if (parts.length) return { level: 'warn', kind: 'stale', advice, text: `la lista sale de un clon atrasado (${f.clone}): ${parts.join('; ')}` };
  if (nothingNew) return { level: 'ok', kind: null, advice: null, text: `la lista está al día: es la de la rama principal remota de su clon (${f.clone}), y su remoto no tiene nada nuevo` };
  const fetched = f.fetchedDaysAgo === null ? 'no consta cuándo se trajo por última vez' : `última traída: hace ${f.fetchedDaysAgo} día(s)`;
  return { level: 'ok', kind: null, advice: null, text: `la lista está al día con lo que conoce su clon (${f.clone}): es la de su rama principal remota; ${fetched}${f.remoteAsked === false ? '; su remoto no contestó' : ''}` };
}

/**
 * El aviso de un empuje: las líneas que se suman a lo que el freno ya dice. Ninguna si no hay nada que avisar — y
 * tampoco cuando no se pudo medir: en el empuje, «no pude medir» calla (lo dicen `status` y `doctor`).
 * FIRMA: freshnessLines(f, { verdict = 'pass' } = {}) → string[]   (`verdict`: 'pass' | 'findings' | 'blind')
 */
function freshnessLines(f, { verdict = 'pass' } = {}) {
  const t = freshnessText(f);
  if (t.level !== 'warn') return [];
  // qué hacer lo dice `freshnessText` (traerlo, mirarlo primero, o —adelante de su remoto— subir lo propio)
  const say = `${t.advice.charAt(0).toUpperCase()}${t.advice.slice(1)}`;
  const then = t.kind === 'ahead' ? `${say}: hasta entonces la validación de un pedido y el resto del equipo miran con la lista de antes.`
    : verdict === 'findings' ? `Si este freno es por algo que ya tiene su excepción, ${t.advice} y empujá de nuevo.`
      : verdict === 'blind' ? `Para descartar que sea por eso, ${t.advice} y empujá de nuevo.`
        : `Con una lista vieja se puede escapar un término que se sumó después: ${t.advice}.`;
  return [`⚠ ${t.text.replace(/^la lista sale/, 'la lista de este freno sale')}.`, `   ${then}`];
}

/** ¿Es uno de los repos del arnés? Lo que dice harness-repo.js, más lo que el arnés que corre DECLARA como suyo. */
function isDeclared(id, env) {
  if (!id) return false;
  const H = harnessRepo();
  if (H.esIdentidadDelArnes(id, { env })) return true;
  // 🔴 harness-repo.js sólo suma lo declarado cuando el arnés que corre tiene un remoto propio que leer (para no decidir
  // «esto es el arnés» por una declaración suelta). Un arnés INSTALADO no es un clon: ahí la tercera señal no se
  // cumple nunca, y un `gh` que nombra el repo público desde otra carpeta saldría sin mirar. Para ESTE freno, lo
  // declarado alcanza: de más se mira un repo; de menos se publica sin mirar.
  // …y vale también con TYCON_HARNESS_IDENTITIES puesta: esa variable SUMA repos a los que se miran, nunca saca uno
  // declarado (con ella sola como fuente, ponerla alcanzaría para que el repo público dejara de contar).
  if (typeof H.declaradas !== 'function') return false;
  return H.declaradas().ids.some((x) => H.mismaIdentidad(x, id));
}

/**
 * El lector de números de pedido (la forma es de scripts/publishing/internal-history.js). Sin el archivo, no se mide.
 * `from`: `{ top, remote }`, de dónde preguntar qué pedidos son del repo público (`remote` null = el `origin` de
 * GitHub de `top`). Un pedido del público no es historia interna; si el público no contesta, cuenta, y
 * `scan.publicProblem()` dice por qué. Sin `from`, o con un control anterior al lector, todo número cuenta.
 */
function historyScanner(from = null) {
  const file = path.join(ROOT, HISTORY_PATH);
  if (!fs.existsSync(file)) return null;
  let mod;
  try { mod = require(file); } catch (_) { throw new Blind('el control de historia interna (internal-history.js) está y no carga'); }
  if (!mod || typeof mod.scan !== 'function') throw new Blind('el control de historia interna (internal-history.js) no trae `scan`');
  const lookup = from && from.top && typeof mod.publicLookup === 'function' ? mod.publicLookup(from.top, from.remote || null) : null;
  const scan = (text) => {
    try {
      const found = mod.scan(String(text), 'message', lookup);
      if (!Array.isArray(found)) throw new TypeError('scan no devolvió una lista');
      return found;
    } catch (_) { throw new Blind('el control de historia interna no pudo mirar un texto'); }
  };
  scan.publicProblem = () => (lookup ? lookup.problem() : null);
  return scan;
}
/** La línea que explica por qué un número de pedido no se pudo distinguir del repo público, si hace falta. */
function publicProblemLines(findings, scan) {
  const problem = scan && typeof scan.publicProblem === 'function' ? scan.publicProblem() : null;
  if (!problem || !findings.some((f) => f.category === 'historia-interna')) return [];
  return [`   (no pude preguntarle al repo público qué pedidos tiene — ${problem}: un número de pedido suyo cuenta como interno)`];
}

// ── leer objetos de git ──────────────────────────────────────────────────────────────────────────────────────────
/** Varios objetos en una sola llamada: sha → { type, data } (o `null` si git no lo tiene). */
function readObjects(top, shas) {
  const out = new Map();
  const wanted = [...new Set(shas)];
  if (!wanted.length) return out;
  const buf = gitOut(top, ['cat-file', '--batch'], { input: `${wanted.join('\n')}\n`, binary: true });
  let at = 0;
  for (const sha of wanted) {
    const eol = buf.indexOf(0x0a, at);
    if (eol < 0) throw new Blind('no pude leer los objetos del repo (la respuesta de git se cortó)');
    const head = buf.slice(at, eol).toString('utf8').split(' ');
    at = eol + 1;
    if (head[1] === 'missing' || head.length < 3) { out.set(sha, null); continue; }
    const size = Number(head[2]);
    out.set(sha, { type: head[1], data: buf.slice(at, at + size) });
    at += size + 1;
  }
  return out;
}

/** La cabecera y el cuerpo de un commit o de una marca, en cada lectura que hay que revisar (UTF-8 y la que declara). */
function parseObject(data) {
  const cut = data.indexOf('\n\n');
  const headBytes = cut < 0 ? data : data.slice(0, cut);
  const bodyBytes = cut < 0 ? Buffer.alloc(0) : data.slice(cut + 2);
  const head = headBytes.toString('utf8');
  const header = (key) => { const m = new RegExp(`^${key} (.*)$`, 'm').exec(head); return m ? m[1] : null; };
  const readings = [{ head, body: bodyBytes.toString('utf8') }];
  const declared = header('encoding');
  if (declared && !/^utf-?8$/i.test(declared)) {
    let decoder;
    try { decoder = new TextDecoder(declared); } catch (_) { throw new Blind('un commit declara una codificación que no sé leer: su mensaje no se da por revisado'); }
    readings.push({ head: decoder.decode(headBytes), body: decoder.decode(bodyBytes) });
  }
  return { header, readings, parents: [...head.matchAll(/^parent ([0-9a-f]+)$/gm)].map((m) => m[1]) };
}

// Las cabeceras de un commit que se revisan por su cuenta (identidad) o que no son texto (el árbol, los padres, la
// codificación, una firma). Cualquier OTRA —la marca que un merge incrusta (`mergetag`), una que alguien agregó— es
// texto que se publica con el commit.
const KNOWN_HEADERS = new Set(['tree', 'parent', 'author', 'committer', 'encoding', 'gpgsig', 'gpgsig-sha256']);
/** El texto de las cabeceras de más de un commit (las líneas que siguen con un espacio son de la misma cabecera). */
function otherHeaders(head) {
  const out = [];
  let keep = false;
  for (const line of String(head).split('\n')) {
    if (line.startsWith(' ')) { if (keep) out.push(line.slice(1)); continue; }
    const cut = line.indexOf(' ');
    const key = cut < 0 ? line : line.slice(0, cut);
    keep = !KNOWN_HEADERS.has(key);
    if (keep) out.push(cut < 0 ? '' : line.slice(cut + 1));
  }
  return out.join('\n');
}

// ── la revisión ──────────────────────────────────────────────────────────────────────────────────────────────────
function makeReview(list, scan) {
  const D = detector();
  const generic = new Set(D.PATRONES_GENERICOS.map((p) => p.nombre));
  const findings = [];
  const seen = new Set();
  /** El nombre de una regla de la lista ES el término: sólo se dice el de una regla genérica (`token-github`), o el de
   *  una forma de historia interna (`pr-number`), que quien llama pasa en `form`. */
  const add = (category, rule, place, form = null) => {
    const shown = form && /^[a-z0-9-]+$/.test(form) ? form : (rule && generic.has(rule) ? rule : null);
    const key = `${category}\0${shown}\0${place}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ category, rule: shown, place });
  };
  const text = (value, route) => D.reviewText(list.cfg, String(value == null ? '' : value), route).hallazgos;
  const history = (value, where) => {
    if (scan) for (const f of scan(String(value == null ? '' : value))) add('historia-interna', null, where(f.line), typeof f.form === 'string' ? f.form : null);
  };
  /** Un texto que no es un archivo (un mensaje, un título): el detector y el número de pedido. */
  const message = (value, where, route = ROUTES.message) => {
    for (const h of text(value, route)) add(h.categoria, h.regla, where(h.linea));
    history(value, where);
  };
  /**
   * El nombre de una rama o de una marca. El detector lo mira tal cual. El número de pedido no: la forma que define el
   * control de historia interna es la de la prosa (la sigla, un espacio y el número), y en un nombre de ref no hay espacios
   * (`arreglo/pr-123`, `PR#123`). Se mira también con los separadores vueltos espacios, y en mayúsculas y minúsculas.
   */
  const refName = (value, where) => {
    const name = String(value == null ? '' : value);
    for (const h of text(name, ROUTES.message)) add(h.categoria, h.regla, where(h.linea));
    const spaced = name.replace(/[^A-Za-z0-9]+/g, ' ').replace(/([A-Za-z])(?=\d)/g, '$1 ').trim();
    for (const variant of new Set([name, spaced, spaced.toUpperCase(), spaced.toLowerCase()])) history(variant, where);
  };
  return { D, findings, add, text, message, refName };
}

/** `Nombre <correo> fecha zona` → el nombre contra la lista, y el correo: un `noreply` de GitHub. */
function reviewIdentity(R, line, who, where) {
  const m = /^(.*?) ?<([^<>]*)>(?: \d+ [+-]\d{4})?$/.exec(String(line || ''));
  if (!m) { R.add('identidad', null, `${where}: no se puede leer quién es`); return; }
  const email = m[2].trim().toLowerCase();
  const fine = NOREPLY.test(email) || (who === 'committer' && email === GITHUB_ITSELF);
  if (!fine) R.add('identidad', null, `${where}: su correo no es un \`noreply\` de GitHub`);
  for (const h of R.text(m[1], ROUTES.identity)) R.add(h.categoria, h.regla, where);
  // y el nombre de la cuenta que va adentro del `noreply` (`<número>+<cuenta>@…`): también es un nombre que se publica
  const account = fine ? email.replace(/@.*$/, '').replace(/^\d+\+/, '') : '';
  if (account) for (const h of R.text(account, ROUTES.identity)) R.add(h.categoria, h.regla, `${where} (la cuenta de su correo)`);
}

const isForbidden = (list, rel) => FORBIDDEN.some((p) => rel.startsWith(p)) || list.forbidden.some((g) => g.test(rel));

/**
 * Todo lo que un empuje publica. `lines`: lo que git manda al `pre-push`. Devuelve `{ findings, looked, partial }`; tira
 * `Blind`. `partial`: se pasó el tope de tiempo con hallazgos ya encontrados (se dicen esos, y que faltó mirar).
 */
function reviewPush({ top, url, lines, list, deadline, limitMs }) {
  const scan = historyScanner({ top, remote: url });
  const R = makeReview(list, scan);
  const looked = { commits: 0, objects: 0, refs: 0, tags: 0 };
  try {
    reviewPushInto(R, looked, { top, url, lines, list, deadline, limitMs });
  } catch (e) {
    if (!(e instanceof OutOfTime) || !R.findings.length) throw e;
    return { findings: R.findings, looked, partial: e.message, history: Boolean(scan), publicProblem: publicProblemLines(R.findings, scan) };
  }
  return { findings: R.findings, looked, partial: null, history: Boolean(scan), publicProblem: publicProblemLines(R.findings, scan) };
}

/** `top`: la carpeta desde la que se le habla a git (la raíz del árbol de trabajo, o el repo desnudo). */
function reviewPushInto(R, looked, { top, url, lines, list, deadline, limitMs }) {
  const tick =() => { if (Date.now() >= deadline) throw new OutOfTime(`pasé el tope de tiempo (${Math.round(limitMs / 1000)} s) sin terminar de mirar: empujá de a menos commits, o subilo con TYCON_PUBLIC_PUSH_LIMIT_MS`); };

  // 1 · las refs: sólo ramas y marcas, y su nombre
  const tips = [];
  const excludes = new Set();
  const typesOf = readObjects(top, lines.filter((l) => !ZERO.test(l.localSha)).map((l) => l.localSha));
  lines.forEach((l, i) => {
    if (ZERO.test(l.localSha)) return;   // borrar una ref remota no publica nada
    looked.refs += 1;
    const n = i + 1;
    const m = /^refs\/(heads|tags)\/(.+)$/.exec(l.remoteRef);
    if (!m) {
      R.add('ref-no-publicable', null, `la ref nº ${n} del empuje: no es una rama ni una marca (una nota, un guardado a medias o un reemplazo no se publican)`);
      return;
    }
    R.refName(m[2], () => `el nombre de la ref nº ${n} del empuje`);
    const obj = typesOf.get(l.localSha);
    if (!obj) throw new Blind(`no pude leer el objeto que empuja la ref nº ${n}`);
    // una marca anotada: su nombre, su mensaje y quién la firmó; y la cadena hasta el commit
    let target = { sha: l.localSha, obj };
    for (let depth = 0; target.obj.type === 'tag'; depth += 1) {
      if (depth > 10) throw new Blind(`la marca de la ref nº ${n} apunta a una cadena de marcas que no termina`);
      looked.tags += 1;
      const tag = parseObject(target.obj.data);
      const where = `la marca anotada de la ref nº ${n}`;
      for (const r of tag.readings) {
        const header = (key) => { const x = new RegExp(`^${key} (.*)$`, 'm').exec(r.head); return x ? x[1] : ''; };
        R.refName(header('tag'), () => `${where} (el nombre que declara)`);
        R.message(r.body, (linea) => `${where} (mensaje, línea ${linea})`);
        reviewIdentity(R, header('tagger'), 'tagger', `${where} (quien la firmó)`);
      }
      const next = tag.header('object');
      if (!next || !SHA.test(next)) throw new Blind(`no pude leer a qué apunta la marca de la ref nº ${n}`);
      const got = readObjects(top, [next]).get(next);
      if (!got) throw new Blind(`no pude leer el objeto al que apunta la marca de la ref nº ${n}`);
      target = { sha: next, obj: got };
    }
    if (target.obj.type !== 'commit') {
      R.add('sin-leer', null, `la ref nº ${n} del empuje: no apunta a un commit (una marca sobre un archivo o una carpeta suelta)`);
      return;
    }
    tips.push(target.sha);
    if (!ZERO.test(l.remoteSha) && git(top, ['cat-file', '-e', `${l.remoteSha}^{commit}`]).status === 0) excludes.add(l.remoteSha);
  });

  tick();
  // 2 · los commits nuevos: lo que ESE remoto no tiene
  if (tips.length) {
    const has = remoteHas(top, url);
    looked.askedRemote = has !== null;
    for (const sha of has || []) excludes.add(sha);
    reviewCommitsInto(R, looked, { top, tips, excludes, list, tick });
  }
}

/**
 * Los commits que alcanzan `tips` y no alcanzan `excludes`: su identidad, su mensaje, sus cabeceras de más, y cada
 * archivo que agregan o cambian. Es lo que comparten el empuje (lo que el remoto no tiene) y el pedido (lo que la rama
 * destino no tiene): la exclusión la decide quien llama.
 */
function reviewCommitsInto(R, looked, { top, tips, excludes, list, tick }) {
  const D = R.D;
  const revs = [...new Set(tips), ...[...excludes].map((s) => `^${s}`)].join('\n');
  const commits = gitOut(top, ['rev-list', '--stdin'], { input: `${revs}\n` }).split('\n').filter(Boolean);
  looked.commits = commits.length;
  const objects = readObjects(top, commits);
  const parentsOf = new Map();
  for (const sha of commits) {
    tick();
    const got = objects.get(sha);
    if (!got || got.type !== 'commit') throw new Blind(`no pude leer el commit ${short(sha)}`);
    const c = parseObject(got.data);
    parentsOf.set(sha, c.parents.length);
    for (const r of c.readings) {
      const header = (key) => { const x = new RegExp(`^${key} (.*)$`, 'm').exec(r.head); return x ? x[1] : ''; };
      reviewIdentity(R, header('author'), 'author', `el autor del commit ${short(sha)}`);
      reviewIdentity(R, header('committer'), 'committer', `el committer del commit ${short(sha)}`);
      // el asunto con que GitHub mergea («Merge pull request #N from …») no tiene salvedad propia: su número es un pedido
      // del repo público, y el control lo distingue preguntándole a ese repo
      R.message(r.body, (linea) => `el mensaje del commit ${short(sha)} (línea ${linea})`);
      const extra = otherHeaders(r.head);
      if (extra) R.message(extra, () => `la cabecera del commit ${short(sha)} (una marca incrustada u otra cabecera de más)`);
    }
  }

  // 3 · cada archivo que agrega o cambia cada commit, con SU ruta. En un merge cuenta lo que no viene de NINGUNO de
  //     sus padres (lo que trae de la otra rama ya se miró en sus propios commits, o ya está publicado)
  const pairs = newPairs(top, commits, parentsOf);
  tick();
  const nameFindings = new Map();
  const nameOf = (rel) => { if (!nameFindings.has(rel)) nameFindings.set(rel, R.text(rel, ROUTES.paths)); return nameFindings.get(rel); };
  // una ruta con un hallazgo ES lo hallado: no se imprime
  const shown = (p) => (nameOf(p.rel).length ? `una ruta que no se imprime (el objeto ${short(p.sha)})` : p.rel);
  const at = (p) => `(commit ${short(p.commit)})`;
  // primero lo que no necesita leer el archivo —la ruta, y qué clase de entrada es—: es barato, y en un empuje enorme
  // (el árbol entero de otro repo, por error) alcanza para decir por qué no sale antes del tope de tiempo
  const readable = [];
  for (const p of pairs) {
    for (const category of new Set(nameOf(p.rel).map((h) => h.categoria))) R.add(category, null, `${shown(p)} ${at(p)}`);
    if (isForbidden(list, p.rel)) R.add('ruta-vedada', null, `${shown(p)} ${at(p)}: esa ruta no es del repo público`);
    if (p.mode === MODE_LINK) R.add('sin-leer', null, `${shown(p)} ${at(p)}: un enlace simbólico`);
    else if (p.mode === MODE_SUBMODULE) R.add('sin-leer', null, `${shown(p)} ${at(p)}: un submódulo`);
    else readable.push(p);
  }
  looked.objects = pairs.length - readable.length;
  // después el contenido, de a tandas
  for (let i = 0; i < readable.length; i += CHUNK) {
    tick();
    const chunk = readable.slice(i, i + CHUNK);
    const blobs = readObjects(top, chunk.map((p) => p.sha));
    for (const p of chunk) {
      looked.objects += 1;
      const blob = blobs.get(p.sha);
      if (!blob) throw new Blind(`no pude leer el objeto ${short(p.sha)} (un archivo del commit ${short(p.commit)})`);
      if (D.esBinario(blob.data)) {
        const allowed = list.cfg.binariosPermitidos.some((g) => g.test(p.rel)) || list.cfg.permitidos.some((x) => !x.patron && x.archivo.test(p.rel));
        if (!allowed) R.add('sin-leer', null, `${shown(p)} ${at(p)}: un binario`);
        continue;
      }
      for (const h of D.reviewText(list.cfg, blob.data.toString('utf8'), p.rel).hallazgos) R.add(h.categoria, h.regla, `${shown(p)}:${h.linea} ${at(p)}`);
    }
  }
}

/**
 * Lo que ESE remoto tiene HOY, preguntándoselo a él (`git ls-remote <dirección>`): los commits de sus ramas y marcas
 * que este repo también tiene. `null` si no contestó — y entonces no se da nada por publicado: se mira todo.
 *
 * 🔴 POR QUÉ SE LE PREGUNTA, y no se usan las ramas de seguimiento (`refs/remotes/<nombre>/*`). Esas ramas no guardan
 * de qué repo salieron, y darían por «ya publicado» lo que el público no tiene: con un remoto que trae de un
 * lado y empuja a otro (`url` privada, `pushurl` pública), y —peor— después de
 * re-apuntar el remoto de siempre al repo público (`git remote set-url origin <público>`): las ramas de seguimiento
 * seguirían siendo las del repo interno, toda esa historia se excluiría, el freno diría «1 commit mirado» y git publicaría
 * la historia entera. Lo único que dice la verdad sobre el remoto es el remoto. Cuesta una ida y vuelta por empuje,
 * hacia el mismo servidor al que el empuje ya le está hablando.
 */
function remoteHas(top, url) {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
  // sin preguntas: si hace falta una clave que nadie puede tipear acá, no contesta (y se mira todo)
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes -oConnectTimeout=10';
  const r = spawnSync('git', ['-C', top, 'ls-remote', '--', String(url || '')], { encoding: 'utf8', env, timeout: REMOTE_ANSWER_MS, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  const shas = [...new Set(String(r.stdout || '').split('\n').map((l) => l.split('\t')[0].trim()).filter((s) => SHA.test(s)))];
  if (!shas.length) return [];
  // de esos, los que este repo tiene y son commits (una marca anotada se anuncia también pelada, `…^{}`)
  const check = git(top, ['cat-file', '--batch-check'], { input: `${shas.join('\n')}\n` });
  if (check.error || check.status !== 0) throw new Blind('no pude leer el repo (git cat-file salió mal al comparar con lo que tiene el remoto)');
  return String(check.stdout || '').split('\n').map((l) => l.split(' ')).filter((p) => p[1] === 'commit').map((p) => p[0]);
}

/** Los pares (objeto, ruta) que cada commit agrega o cambia; cada par una vez, con el primer commit que lo trae. */
function newPairs(top, commits, parentsOf) {
  if (!commits.length) return [];
  // `--ignore-submodules=none`: sin eso git obedece el `ignore` del `.gitmodules` del árbol de trabajo —que viene en lo
  // mismo que se mira— y con `ignore = all` no lista el submódulo: el «sin leer» no saldría, y el veredicto de los
  // MISMOS commits dependería de dónde está parado el árbol.
  const raw = gitOut(top, ['diff-tree', '--stdin', '-r', '-m', '--root', '--no-renames', '--no-abbrev', '--ignore-submodules=none', '-z'], { input: `${commits.join('\n')}\n` });
  const tokens = raw.split('\0');
  const count = new Map();   // commit\0objeto\0ruta → en cuántas de las diferencias contra sus padres aparece
  const info = new Map();
  let commit = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i].replace(/^\n+/, '');
    if (!tok) continue;
    if (SHA.test(tok)) { commit = tok; continue; }
    const m = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*$/.exec(tok);
    // lo que no es un commit ni la cabecera de un archivo no se saltea: una respuesta de git que no sé leer, leída como
    // «nada que mirar», dejaría salir el empuje sin haber mirado sus archivos
    if (!m) throw new Blind('git contestó la lista de archivos de los commits en una forma que no sé leer');
    i += 1;   // lo que sigue a esa cabecera es su ruta, traiga lo que traiga
    if (!commit || ZERO.test(m[2])) continue;   // un borrado no publica contenido
    const key = `${commit}\0${m[2]}\0${tokens[i]}`;
    count.set(key, (count.get(key) || 0) + 1);
    info.set(key, { commit, sha: m[2], rel: tokens[i], mode: m[1] });
  }
  const out = new Map();
  // en el orden de `rev-list` (del más nuevo al más viejo): se recorre al revés para quedarse con el primero que lo trae
  const order = new Map(commits.map((c, i) => [c, i]));
  for (const [key, n] of count) {
    const p = info.get(key);
    if (n < Math.max(1, parentsOf.get(p.commit) || 0)) continue;
    const id = `${p.sha}\0${p.rel}`;
    const have = out.get(id);
    if (!have || order.get(p.commit) > order.get(have.commit)) out.set(id, p);
  }
  return [...out.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.sha < b.sha ? -1 : 1));
}

/** Las líneas que git le manda al `pre-push`: `<ref local> <sha local> <ref remota> <sha remoto>`. */
function parseLines(input) {
  const out = [];
  for (const raw of String(input || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    // Se lee desde el FINAL: los tres últimos campos no llevan espacios, y el primero —la ref local, que git escribe
    // tal como se tipeó— puede llevarlos (`git push origin "main@{1 day ago}:rama"`).
    const parts = line.split(' ');
    const [localSha, remoteRef, remoteSha] = parts.slice(-3);
    if (parts.length < 4 || !SHA.test(localSha) || !SHA.test(remoteSha) || !remoteRef.startsWith('refs/')) {
      throw new Blind('las líneas que git le pasó al hook no tienen la forma esperada: no sé qué se está empujando');
    }
    out.push({ localRef: parts.slice(0, -3).join(' '), localSha, remoteRef, remoteSha });
  }
  return out;
}

function limitOf(env) {
  const n = Number(env.TYCON_PUBLIC_PUSH_LIMIT_MS);
  return env.TYCON_PUBLIC_PUSH_LIMIT_MS !== undefined && env.TYCON_PUBLIC_PUSH_LIMIT_MS !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT_MS;
}

/** La constancia: freno, regla y veredicto. Nunca el comando ni un texto. Es ayuda: si no se puede anotar, se sigue. */
function record(rule, verdict) {
  try {
    const lib = path.join(ROOT, 'scripts', 'lib', 'guard-record.js');
    if (fs.existsSync(lib)) require(lib).anotar({ freno: 'public-push-guard', regla: rule, veredicto: verdict });
  } catch (_) { /* la decisión ya está tomada */ }
}

/**
 * ¿Este empuje es del arnés? Tres señales, cualquiera alcanza: el árbol de trabajo trae la marca; lo que se empuja la
 * trae (se puede empujar una rama del arnés parado en otra que no la tiene, o desde un repo desnudo); o el remoto es
 * uno de los repos que el arnés declara como suyos. Mirar sólo el árbol de trabajo dejaría salir sin freno todo empuje
 * hecho desde un estado sin ese archivo.
 */
function concernsHarness({ repo, top, lines, url, env }) {
  if (isHarnessTree(top)) return true;
  const H = harnessRepo();
  if (isDeclared(H.identidadRemoto(String(url || '')), env)) return true;
  for (const l of lines) {
    if (ZERO.test(l.localSha)) continue;
    if (git(repo, ['cat-file', '-e', `${l.localSha}^{commit}:${TREE_MARK}`]).status === 0) return true;
    // «no trae ese archivo» y «no pude leer lo que se empuja» salen con el mismo código: se distinguen preguntando por
    // el objeto. Lo que no se puede leer no es «no es del arnés». (Una marca sobre un archivo suelto no es un commit:
    // por eso se pregunta por el objeto, no por el commit.)
    const there = git(repo, ['cat-file', '-e', l.localSha]);
    if (there.error || there.status !== 0) throw new Blind('no pude leer lo que se empuja (un objeto que git no encuentra): no sé si es un empuje del arnés');
  }
  return false;
}

/** El modo `pre-push`. `input`: lo que git manda (null si no se pudo leer). Devuelve `{ code, result }`. */
function prePush({ remoteName, url, input, cwd = process.cwd(), env = process.env }) {
  const result = { verdict: 'skip', remote: null, reason: null, findings: [], looked: { commits: 0, objects: 0, refs: 0, tags: 0 }, list: null, generic_only: false };
  try {
    // git corre el hook parado en el repo: la raíz del árbol de trabajo, o el repo mismo si es desnudo
    const top = toplevel(cwd);
    const repo = top || cwd;
    const target = url || remoteName;
    result.remote = judgeRemote(target, repo, env).kind;
    if (result.remote !== 'public') { result.reason = 'el remoto no es público'; return { code: 0, result }; }
    if (input === null) throw new Blind('no pude leer lo que git le pasó al hook (su entrada): no sé qué se está empujando');
    const lines = parseLines(input);
    if (!concernsHarness({ repo, top, lines, url: target, env })) { result.reason = 'no es un empuje del arnés'; return { code: 0, result }; }
    result.verdict = 'pass';
    if (!lines.some((l) => !ZERO.test(l.localSha))) return { code: 0, result };   // nada que publicar (o sólo borrados)
    const list = resolveList(top, env, { pushing: true });
    result.list = { source: list.source };
    result.generic_only = list.generic;
    // ¿esa lista está al día? Recién acá —un empuje del arnés a un remoto público, con algo que publicar y una lista
    // elegida—: un empuje que no es asunto de este freno no espera a nadie. Se le pregunta al remoto del clon de la
    // lista porque este empuje ya sale a la red. Es un dato para el aviso: de acá en más nada lo mira para decidir.
    if (!list.generic) result.list.freshness = listFreshness(list.file, { env, askRemote: true, readFrom: list.readFrom });
    const limitMs = limitOf(env);
    const r = reviewPush({ top: repo, url: target, lines, list, deadline: Date.now() + limitMs, limitMs });
    result.findings = r.findings;
    result.looked = r.looked;
    result.history = r.history;
    if (r.publicProblem.length) result.publicProblem = r.publicProblem;
    if (r.partial) result.partial = r.partial;
    if (r.findings.length) { result.verdict = 'findings'; record('finding', 'bloqueo'); return { code: 1, result }; }
    record(list.generic ? 'generic-only' : 'clean', 'paso');
    return { code: 0, result };
  } catch (e) {
    result.verdict = 'blind';
    // un error que no es de los previstos tampoco es verde; se nombra por su clase, no por su texto
    result.reason = e instanceof Blind ? e.message : `el freno falló por dentro (${(e && (e.code || e.name)) || 'error'})`;
    // una lista que está y no se deja leer: si su clon quedó a medio traer, eso es lo que hay que saber
    if (e instanceof Blind && e.listFile && !result.list) result.list = { source: e.listSource || null, freshness: listFreshness(e.listFile, { env, askRemote: true, readFrom: e.listReadFrom }) };
    record('could-not-look', 'bloqueo');
    return { code: 2, result };
  }
}

function prePushMessage(result) {
  const L = [];
  // el aviso de la lista atrasada: se suma a lo que ya se dice, pase, frene o no se haya podido mirar
  const stale = () => (result.list && result.list.freshness ? freshnessLines(result.list.freshness, { verdict: result.verdict }) : []);
  if (result.verdict === 'pass') {
    if (!result.looked.refs) return L;
    L.push(`✓ freno de publicación: ${result.looked.commits} commit(s) y ${result.looked.objects} archivo(s) mirados antes de publicar${result.generic_only
      ? ' — sin lista en esta máquina: sólo secretos, correos, rutas de máquina, binarios y rutas vedadas' : ''}`);
    // lo que no se midió se dice: que falte el control no puede verse igual que «no había números de pedido»
    if (result.history === false) L.push(`   (los números de pedido en mensajes y nombres de rama NO se miraron: falta ${HISTORY_PATH})`);
    if (result.looked.askedRemote === false) L.push('   (el remoto no contestó qué tiene: se miró todo lo que este empuje alcanza, no sólo lo nuevo)');
    L.push(...stale());
    return L;
  }
  if (result.verdict === 'blind') {
    L.push(`⛔ EMPUJE FRENADO — no pude mirar lo que este empuje publica: ${result.reason}.`);
    L.push('   «No pude mirar» no es «limpio»: nada salió. El remoto es público, y lo que se empuja ahí queda publicado.');
    L.push(...stale());
    return L;
  }
  if (result.verdict === 'findings') {
    const n = result.findings.length;
    L.push(`⛔ EMPUJE FRENADO — el remoto es público y ${n} cosa(s) de lo que este empuje publica no pueden salir:`);
    for (const f of result.findings.slice(0, MAX_SHOWN)) L.push(`   · [${f.category}${f.rule ? `/${f.rule}` : ''}] ${f.place}`);
    if (n > MAX_SHOWN) L.push(`   · … y ${n - MAX_SHOWN} más`);
    if (result.publicProblem) L.push(...result.publicProblem);
    if (result.partial) L.push(`   Y no terminé de mirar: ${result.partial}. Puede haber más.`);
    L.push('   Nada salió. Lo que se empuja a un remoto público queda publicado aunque después se borre la rama.');
    L.push('   Cómo seguir:');
    L.push('     · sacalo de la HISTORIA de la rama, no sólo de la punta (se mira cada commit nuevo): reescribí esos commits y volvé a empujar;');
    L.push('     · un secreto que llegó a un commit se da por comprometido: rotalo, además de sacarlo;');
    L.push('     · si es un freno falso, la salida es una excepción con motivo en la lista privada (`permitidos`), como en el exportador; el freno la lee de la rama principal remota de su clon, así que la excepción vale cuando está mergeada.');
    // acá es donde más importa: la excepción que falta puede estar en los commits que ese clon no tiene
    L.push(...stale());
  }
  return L;
}

// ── el modo del commit: lo que este commit agrega, antes de que exista ────────────────────────
// La identidad con que se arma el commit: la de verdad la mira el empuje. Va por el ambiente porque git le exporta el autor al
// gancho en todo commit, y ese ambiente le gana a la configuración.
const LOOK_WHO = 'public-push-guard';
const LOOK_EMAIL = `${LOOK_WHO}@users.noreply.github.com`;
const LOOK_IDENTITY = { GIT_AUTHOR_NAME: LOOK_WHO, GIT_AUTHOR_EMAIL: LOOK_EMAIL, GIT_COMMITTER_NAME: LOOK_WHO, GIT_COMMITTER_EMAIL: LOOK_EMAIL };
const LOOK_MESSAGE = 'lo que guardaría el commit';
const COMMIT_MARK = / ?\(commit [0-9a-f]+\)/;

/**
 * Lo que este commit agrega, mirado por el freno como lo miraría al empujar. Corre dentro del control del commit, donde git
 * ya sabe qué entra (el índice que deja en GIT_INDEX_FILE vale para `git add`, `-a` y las rutas). Se arma el commit con sus
 * padres de verdad, también los de un merge en curso, y se mira sólo él: lo que ya está en un padre no es de este commit,
 * así que un `--amend` que saca un dato pasa, y un dato de un commit anterior lo sigue frenando el empuje. No le pregunta
 * nada al remoto, no mira el mensaje ni el autor y no anota en el registro: nada se publicó ni se frenó todavía.
 * Sin la lista (la CI pública, alguien de afuera) no mira: tampoco están sus excepciones, y frenaría lo que ya está permitido.
 * Mira sólo `origin`; otro remoto público lo mira el empuje.
 * Devuelve `{ code, result }`: 0 limpio, o no es asunto de este freno · 1 hallazgos · 2 no pude mirar.
 */
function preCommit({ cwd = process.cwd(), env = process.env } = {}) {
  const result = { verdict: 'skip', reason: null, findings: [], looked: { commits: 0, objects: 0, refs: 0, tags: 0 }, list: null };
  try {
    const top = toplevel(cwd);
    if (!top) { result.reason = 'no es un árbol de trabajo'; return { code: 0, result }; }
    const remote = git(top, ['remote', 'get-url', '--push', 'origin']);
    const url = remote.status === 0 ? String(remote.stdout || '').trim() : '';
    if (!url) { result.reason = 'sin origin: lo mira el empuje'; return { code: 0, result }; }
    if (judgeRemote(url, top, env).kind !== 'public') { result.reason = 'el remoto no es público'; return { code: 0, result }; }
    if (!isHarnessTree(top) && !isDeclared(harnessRepo().identidadRemoto(url), env)) { result.reason = 'no es un commit del arnés'; return { code: 0, result }; }
    result.verdict = 'pass';
    const tree = gitOut(top, ['write-tree']).trim();
    const head = git(top, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    const parents = head.status === 0 ? [String(head.stdout).trim()] : [];
    const merging = gitOut(top, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD']).trim();
    if (fs.existsSync(merging)) parents.push(...fs.readFileSync(merging, 'utf8').split('\n').map((s) => s.trim()).filter((s) => SHA.test(s)));
    if (parents.length === 1 && gitOut(top, ['rev-parse', 'HEAD^{tree}']).trim() === tree) return { code: 0, result };
    const list = resolveList(top, env, { pushing: true });
    result.list = { source: list.source };
    if (list.generic) { result.verdict = 'skip'; result.reason = 'sin la lista no están sus excepciones: lo mira el empuje'; return { code: 0, result }; }
    const scan = historyScanner({ top, remote: null });
    const R = makeReview(list, scan);
    const tip = gitOut(top, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', LOOK_MESSAGE], { env: LOOK_IDENTITY }).trim();
    const limitMs = limitOf(env);
    const deadline = Date.now() + limitMs;
    const tick = () => { if (Date.now() >= deadline) throw new OutOfTime(`pasé el tope de tiempo (${Math.round(limitMs / 1000)} s) sin terminar de mirar el commit`); };
    try {
      reviewCommitsInto(R, result.looked, { top, tips: [tip], excludes: new Set(parents), list, tick });
    } catch (e) {
      if (!(e instanceof OutOfTime) || !R.findings.length) throw e;
      result.partial = e.message;
    }
    // el commit armado no existe en la historia de nadie: su sha no le dice nada a quien lee
    result.findings = R.findings.map((f) => ({ ...f, place: f.place.replace(COMMIT_MARK, '') }));
    if (result.findings.length) { result.verdict = 'findings'; return { code: 1, result }; }
    return { code: 0, result };
  } catch (e) {
    result.verdict = 'blind';
    result.reason = e instanceof Blind ? e.message : `el freno falló por dentro (${(e && (e.code || e.name)) || 'error'})`;
    return { code: 2, result };
  }
}

function preCommitMessage(result) {
  const L = [];
  if (result.verdict === 'blind') {
    L.push(`⚠️  freno de publicación: no pude mirar lo que lleva este commit (${result.reason}). El empuje lo vuelve a mirar.`);
    return L;
  }
  if (result.verdict !== 'findings') return L;
  L.push(`⛔ COMMIT FRENADO — el remoto es público y ${result.findings.length} cosa(s) de este commit no podrían salir al empujar:`);
  for (const f of result.findings.slice(0, MAX_SHOWN)) L.push(`   · [${f.category}${f.rule ? `/${f.rule}` : ''}] ${f.place}`);
  if (result.findings.length > MAX_SHOWN) L.push(`   · … y ${result.findings.length - MAX_SHOWN} más`);
  if (result.partial) L.push(`   Y no terminé de mirar: ${result.partial}. Puede haber más.`);
  L.push('   El commit no se hizo. Sacalo de lo preparado y volvé a commitear.');
  L.push('   Un secreto de verdad se da por comprometido: rotalo. Si es un freno falso, la salida es una excepción con motivo en la lista privada (`permitidos`).');
  return L;
}

// ── el modo de rango: un pedido, en su validación ─────────────────────────────────────────────
/**
 * Lo que un PEDIDO publica, mirado en la validación que corre antes del merge: cada commit que alcanza `head` y no
 * alcanza `base` (los que el pedido suma a su rama destino), el nombre de la rama, y el título y el cuerpo.
 *
 * Qué lo separa del `pre-push`, y por qué:
 *   · no le pregunta nada al remoto: la base la da quien llama (la rama destino, ya traída);
 *   · la lista es SIEMPRE obligatoria: el agente que lo corre no tiene perfil ni máquina, y sin lista todo pedido
 *     saldría verde. Tampoco sale del árbol del pedido (el pedido elegiría con qué lista se lo mira);
 *   · no decide si «es del arnés»: lo llama la validación del arnés.
 * La rama de un pedido YA es pública cuando esto corre: no frena la publicación, frena el merge, y dice qué hacer.
 * `titleFile`/`bodyFile`: los archivos con el título y el cuerpo (los deja scripts/ci/pr-texts.js). Sin ninguno —una
 * corrida que no es de un pedido— se miran los commits y la rama, y el resultado lo dice (`texts`).
 * Devuelve `{ code, result }`: 0 limpio · 1 hallazgos · 2 no pude mirar.
 */
function rangeMode({ base, head, branch = null, titleFile = null, bodyFile = null, cwd = process.cwd(), env = process.env }) {
  const result = { verdict: 'pass', reason: null, findings: [], looked: { commits: 0, objects: 0, refs: 0, tags: 0 }, list: null, texts: { title: false, body: false } };
  try {
    if (!base || !head) throw new Blind('faltan la base y la punta del rango (--base y --head): no sé qué commits son del pedido');
    const at = repoAt(cwd);
    if (!at.top) throw new Blind('no estoy parado en un repo de git con árbol de trabajo: no sé dónde están los commits del pedido');
    const top = at.top;
    // la base y la punta, resueltas a un commit: un nombre que git no conoce no es «un pedido sin commits». Con `--`
    // delante de nada: un valor que empieza con guion no puede leerse como una opción de git (`--end-of-options`).
    const commitOf = (name, what) => {
      const r = git(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${name}^{commit}`]);
      const sha = String(r.stdout || '').trim();
      if (r.error || r.status !== 0 || !SHA.test(sha)) throw new Blind(`no pude leer ${what} del rango: git no la conoce como un commit`);
      return sha;
    };
    // 🔴 Un clon al que le falta historia (superficial) no trae todos los commits del pedido: `rev-list` devuelve los
    // que hay, y los que faltan saldrían como «limpios». La validación baja la historia entera; si alguien le baja la
    // profundidad, o esto se corre a mano en un clon superficial, es «no pude mirar».
    const shallow = git(top, ['rev-parse', '--is-shallow-repository']);
    if (shallow.error || shallow.status !== 0) throw new Blind('no pude leer el repo (git no dijo si el clon trae la historia entera)');
    if (String(shallow.stdout || '').trim() !== 'false') throw new Blind('este clon no trae la historia entera (es superficial): los commits del pedido que faltan no se pueden mirar, y no se dan por limpios');
    const baseSha = commitOf(base, 'la base');
    const headSha = commitOf(head, 'la punta');
    const readText = (file, what) => {
      try { return fs.readFileSync(file, 'utf8'); } catch (_) { throw new Blind(`no pude leer ${what} del pedido (su archivo no está o no se deja leer): no se da por revisado`); }
    };
    const title = titleFile ? readText(titleFile, 'el título') : null;
    const body = bodyFile ? readText(bodyFile, 'el cuerpo') : null;

    const list = resolveList(top, env, { pushing: true, required: true });
    result.list = { source: list.source };
    // 🔴 Acá el control de historia interna es obligatorio. En el `pre-push` de una máquina puede faltar (un arnés
    // instalado anterior a ese control) y se dice; en la validación corre el árbol del propio repo, que lo trae: si
    // falta, alguien lo sacó, y un pedido mirado sin él saldría verde con un número de pedido en el título.
    const scan = historyScanner({ top, remote: null });
    if (!scan) throw new Blind(`falta el control de historia interna (${HISTORY_PATH}): los números de pedido no se pueden mirar, y un pedido no se da por revisado sin eso`);
    result.history = true;
    const R = makeReview(list, scan);
    const limitMs = limitOf(env);
    const deadline = Date.now() + limitMs;
    const tick = () => { if (Date.now() >= deadline) throw new OutOfTime(`pasé el tope de tiempo (${Math.round(limitMs / 1000)} s) sin terminar de mirar el pedido`); };
    try {
      // primero lo que no cuesta nada —la rama, el título, el cuerpo—: si después se vence el tope mirando commits,
      // lo que ya se encontró se dice (y que faltó mirar)
      if (branch) { result.looked.refs = 1; R.refName(branch, () => 'el nombre de la rama del pedido'); }
      if (title !== null) { result.texts.title = true; R.message(title, () => 'el título del pedido', ROUTES.pullRequest); }
      if (body !== null) { result.texts.body = true; R.message(body, (linea) => `el cuerpo del pedido (línea ${linea})`, ROUTES.pullRequest); }
      reviewCommitsInto(R, result.looked, { top, tips: [headSha], excludes: new Set([baseSha]), list, tick });
    } catch (e) {
      // el tope de tiempo con hallazgos ya encontrados: se dicen esos, y que faltó mirar (como en el empuje)
      if (!(e instanceof OutOfTime) || !R.findings.length) throw e;
      result.partial = e.message;
    }
    result.findings = R.findings;
    const problem = publicProblemLines(R.findings, scan);
    if (problem.length) result.publicProblem = problem;
    if (R.findings.length) { result.verdict = 'findings'; record('finding', 'bloqueo'); return { code: 1, result }; }
    record('clean', 'paso');
    return { code: 0, result };
  } catch (e) {
    result.verdict = 'blind';
    result.reason = e instanceof Blind ? e.message : `el freno falló por dentro (${(e && (e.code || e.name)) || 'error'})`;
    record('could-not-look', 'bloqueo');
    return { code: 2, result };
  }
}

/** Lo que el modo de rango dice. La última línea son las cuentas: el paso de la validación arma con ella su aviso de
 *  texto fijo (un aviso de esa validación no interpola nada de lo que se miró). */
function rangeMessage(result) {
  const L = [];
  // cada cosa se dice por lo que pasó con ELLA: «el título y el cuerpo, mirados» con uno solo de los dos era inexacto
  const { title, body } = result.texts;
  const texts = title && body ? 'el título y el cuerpo, mirados'
    : title ? 'el título, mirado (sin cuerpo que mirar)'
      : body ? 'el cuerpo, mirado (sin título que mirar)'
        : 'sin título ni cuerpo que mirar: esta ejecución no es de un pedido';
  const branch = result.looked.refs ? 'el nombre de la rama, mirado' : 'sin nombre de rama que mirar';
  if (result.verdict === 'pass') {
    L.push(`✓ freno de publicación: ${result.looked.commits} commit(s) y ${result.looked.objects} archivo(s) del pedido mirados; ${branch}; ${texts}`);
  } else if (result.verdict === 'blind') {
    L.push(`⛔ PEDIDO FRENADO — no pude mirar lo que este pedido publica: ${result.reason}.`);
    L.push('   «No pude mirar» no es «limpio»: el pedido no se mergea así.');
  } else {
    const n = result.findings.length;
    L.push(`⛔ PEDIDO FRENADO — ${n} cosa(s) de lo que este pedido publica no pueden estar en el repo público:`);
    for (const f of result.findings.slice(0, MAX_SHOWN)) L.push(`   · [${f.category}${f.rule ? `/${f.rule}` : ''}] ${f.place}`);
    if (n > MAX_SHOWN) L.push(`   · … y ${n - MAX_SHOWN} más`);
    if (result.publicProblem) L.push(...result.publicProblem);
    if (result.partial) L.push(`   Y no terminé de mirar: ${result.partial}. Puede haber más.`);
    L.push('   La rama de un pedido YA es pública: no mergear no la despublica. Qué hacer, en este orden:');
    L.push('     1. cerrar el pedido (sin mergearlo);');
    L.push('     2. borrar la rama del repo público;');
    L.push('     3. pedir la purga al soporte de GitHub: borrar la rama no borra sus commits, que siguen alcanzables por la referencia del pedido;');
    L.push('     · si lo hallado es un secreto, se rota PRIMERO: publicado, se da por comprometido;');
    L.push('     · el cambio vuelve en una rama nueva, con la historia limpia (se mira cada commit, no la diferencia neta);');
    L.push('     · si es un freno falso, la salida es una excepción con motivo en la lista privada (`permitidos`), como en el exportador.');
  }
  // `branch`: si se miró el nombre de una rama. El paso de la validación lo exige en 1 en un pedido —ese nombre figura
  // en su página—, igual que el título y el cuerpo: lo que no se miró no puede salir en verde sin que conste.
  L.push(`public-push-guard: verdict=${result.verdict} findings=${result.findings.length} commits=${result.looked.commits} branch=${result.looked.refs ? 1 : 0} title=${title ? 1 : 0} body=${body ? 1 : 0}`);
  return L;
}

// ── status ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** `fetch`: además se le pregunta al remoto del clon de la lista (`status --fetch`). La frescura de la lista es una
 *  línea más: nunca cambia el código de salida. */
function status({ cwd = process.cwd(), env = process.env, fetch = false } = {}) {
  const L = ['freno antes de publicar — cómo está en esta máquina'];
  let ok = true;
  const top = toplevel(cwd);
  // el `pre-push` que git corre acá: el de la carpeta de hooks que rige (la global, o la del repo)
  let hook = null;
  // 🔴 «git no contestó» no es «git no tiene carpeta de hooks»: la clave que no está es un código 1 de `git config`;
  // cualquier otra cosa —git que falla, git que no está— es no haber podido leer, y se dice eso (leído como «no
  // tiene», mandaba a correr el instalador por un error de git).
  let unread = null;
  if (top) {
    const r = git(top, ['rev-parse', '--git-path', 'hooks/pre-push']);
    if (r.status === 0 && String(r.stdout).trim()) hook = path.resolve(top, String(r.stdout).trim());
    else unread = 'no pude leer qué carpeta de hooks usa git en este repo';
  } else {
    // `--includes`: con `--global` git no sigue los archivos incluidos (`[include]`) salvo que se lo pidan, y al correr
    // un hook sí: la carpeta puesta desde un archivo incluido se leería como «git no tiene». `--type=path`: con `~` expandido.
    // Es la misma lectura que hacen los dos instaladores y `harness.js doctor`.
    const r = spawnSync('git', ['config', '--global', '--includes', '--type=path', 'core.hooksPath'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && String(r.stdout).trim()) hook = path.join(String(r.stdout).trim().replace(/^~(?=$|[\\/])/, os.homedir()), 'pre-push');
    else if (r.error || (r.status !== 0 && r.status !== 1)) unread = `no pude leer la carpeta global de hooks de git (${r.error && r.error.code === 'ENOENT' ? 'git no está en esta máquina' : r.error ? 'git no contestó' : `git config salió ${r.status}`})`;
  }
  let placed = false;
  try { placed = Boolean(hook) && fs.readFileSync(hook, 'utf8').includes(HOOK_MARK); } catch (_) { placed = false; }
  // git no corre un hook sin permiso de ejecución (apenas deja una pista al empujar): con el contenido correcto y sin
  // ese permiso, el freno NO está puesto. En Windows git no mira ese permiso.
  let runnable = placed;
  if (placed && process.platform !== 'win32') { try { fs.accessSync(hook, fs.constants.X_OK); } catch (_) { runnable = false; } }
  if (placed && runnable) L.push(`  el pre-push: está puesto (${hook})`);
  else if (placed) { ok = false; L.push(`  el pre-push: NO corre — ${hook} es el del arnés pero no tiene permiso de ejecución (chmod +x, o corré el instalador)`); }
  else if (unread) { ok = false; L.push(`  el pre-push: no sé si está puesto — ${unread}`); }
  else { ok = false; L.push(`  el pre-push: NO está puesto${hook ? ` (git mira ${hook}, y ése no es el del arnés)` : ' (git no tiene carpeta global de hooks)'} — corré el instalador del arnés`); }
  const team = isTeamMachine(top);
  try {
    const list = resolveList(top, env);
    if (list.generic) L.push('  la lista: no hay, y esta máquina no es del equipo: corre sólo lo que no necesita lista (secretos, correos, rutas de máquina, binarios, rutas vedadas)');
    else {
      L.push(`  la lista: ${list.label} — ${list.terms} término(s), ${FORBIDDEN.length + list.extraForbidden} ruta(s) vedada(s)`);
      // ¿está al día? Sin red, salvo que lo pidan. Es un dato: `ok` no se toca
      const f = listFreshness(list.file, { env, askRemote: fetch, readFrom: list.readFrom });
      const t = freshnessText(f);
      L.push(`  ${t.level === 'warn' ? '⚠ ' : ''}${t.text}${t.level === 'warn' ? ` — ${t.advice}` : ''}${t.level !== 'unknown' && !fetch ? ' · status --fetch le pregunta además a su remoto' : ''}`);
    }
  } catch (e) {
    ok = false;
    L.push(`  la lista: NO — ${e instanceof Blind ? e.message : 'no se pudo leer'}`);
  }
  L.push(`  máquina del equipo: ${team ? 'sí (la lista es obligatoria)' : 'no'}`);
  try {
    if (historyScanner()) L.push('  números de pedido: se miden');
    else { ok = false; L.push(`  números de pedido: NO se miden (falta ${HISTORY_PATH})`); }
  } catch (e) { ok = false; L.push(`  números de pedido: NO — ${e.message}`); }
  return { code: ok ? 0 : 1, lines: L };
}

// ── el freno de `gh`: lo que se publica sin empujar (un freno previo a la herramienta, de Claude Code y de Codex) ────
// Un pedido, un comentario o una versión creados con `gh` publican texto sin pasar por `git push`. Acá se mira el TEXTO
// DEL COMANDO (scripts/lib/gh-pr.js): todo `gh` que no es de lectura y que apunta al repo público del arnés —porque lo
// nombra (`--repo`, `GH_REPO`, la ruta de `gh api`) o porque se corre en un clon del arnés con un remoto público—.
// Límite declarado: es un freno de la sesión del agente. Un `gh` tecleado en una terminal, la web de GitHub u otra
// herramienta no pasan por acá; eso lo mira la verificación de lo publicado, de noche.
const ghReader = () => require(path.join(ROOT, 'scripts', 'lib', 'gh-pr.js'));
const READABLE_FORM = 'La forma que este freno sí lee: el texto en un archivo escrito ANTES (en otra llamada) y pasado con `--body-file <archivo>` '
  + '(`--notes-file` en una versión), o el bloque "$(cat <<\'EOF\' … EOF)" con el delimitador entre comillas.';

/** ¿A qué repos públicos empuja este clon? Las identidades (host/ruta) de sus remotos públicos. */
function publicRemotesOf(top, env) {
  const H = harnessRepo();
  const r = git(top, ['remote']);
  if (r.error || r.status !== 0) throw new Blind('no pude leer los remotos del repo');
  const out = [];
  for (const name of String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
    // las direcciones de traída y las de empuje, como git las usa de verdad (ya con `insteadOf` y `pushInsteadOf`)
    for (const which of [['--all'], ['--push', '--all']]) {
      const g = git(top, ['remote', 'get-url', ...which, name]);
      if (g.error) throw new Blind('no pude leer la dirección de un remoto del repo');
      // Un «remoto» SIN dirección no es un remoto: git lista uno cuando la configuración global trae una sección con
      // ese nombre (`remote.origin.prune=true`) y el repo no lo tiene; no se puede empujar a él. (git contesta con un
      // error, o con el nombre mismo como dirección.) Tomarlo por «no pude mirar» frenaría todo `gh` de ese repo.
      if (g.status !== 0) continue;
      for (const u of String(g.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
        if (u === name) continue;
        if (judgeRemote(u, top, env).kind === 'public') out.push(H.identidadRemoto(u));   // null: público que no se sabe leer
      }
    }
  }
  return out;
}

// Las variables que cambian de dónde salen la lista o el freno. Son de las pruebas y de la validación: puestas en la
// misma línea que un `git push` o un `gh` que publica, cambian el veredicto de ESE comando, que es justo lo que ninguna
// variable puede hacer. Un agente no las usa para publicar.
// Y las que le sacan a git su configuración global —donde está la carpeta de hooks—: con otra `HOME` o con
// `GIT_CONFIG_GLOBAL` el `pre-push` no corre, que es lo mismo que `--no-verify` sin escribirlo.
const GUARD_NAMES = '(TYCON_PUBLISH_DENYLIST|TYCON_GUIDES_DIR|TYCON_HOME|HOME|USERPROFILE|XDG_CONFIG_HOME|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS)';
// `NOMBRE=…` (con o sin comillas alrededor: la ficha ya llega sin ellas), y como las pone PowerShell: `$env:NOMBRE`,
// `env:NOMBRE` (el de `Set-Item`). Y la carpeta de hooks cambiada para un solo comando: `-c core.hooksPath=…`.
const GUARD_VARIABLES = new RegExp(`^${GUARD_NAMES}=|^\\$env:${GUARD_NAMES}(=|$)|^env:${GUARD_NAMES}$|core\\.hookspath`, 'i');
/**
 * `{ sets: bool, pushes: bool }`: ¿la línea pone una de esas variables?, ¿trae un `push`? Se mira TODA ficha, lleve
 * comillas o no: `export "TYCON_GUIDES_DIR=…"`, `"git" push` y `git "push"` son lo mismo para la terminal. De más
 * (cualquier `push` de la línea cuenta, no sólo el de git): de menos, el empuje saldría con un freno ajeno.
 */
function lineFacts(command) {
  const az = require(path.join(ROOT, 'scripts', 'lib', 'az-pr.js'));
  let sets = false;
  let pushes = false;
  for (const seg of az.segmentos(command)) {
    if (seg.some((f) => GUARD_VARIABLES.test(f.texto))) sets = true;
    if (seg.some((f) => f.texto === 'push')) pushes = true;
  }
  return { sets, pushes };
}

/**
 * ¿Un `push` de esta línea PUEDE ser un empuje del arnés? Sí si la carpeta del evento es un clon del arnés (por su
 * árbol o por un remoto público que el arnés declara suyo), si no se sabe (git no pudo decir, un remoto ilegible), o si
 * la línea se va a otra carpeta o a otro repo de una forma que acá no se sigue (`cd`, `git -C`, `--git-dir`). Sólo un
 * repo que se SABE que no es del arnés queda afuera.
 */
const GOES_ELSEWHERE = /^(cd|pushd|popd|chdir|set-location|sl|push-location|pop-location|-C|--git-dir(=.*)?|--work-tree(=.*)?|GIT_(DIR|WORK_TREE)=.*)$/i;
function pushMayBeHarness(command, cwd, env) {
  try {
    const az = require(path.join(ROOT, 'scripts', 'lib', 'az-pr.js'));
    if (az.segmentos(command).some((seg) => seg.some((f) => GOES_ELSEWHERE.test(f.texto)))) return true;
    const { top, known } = repoAt(cwd);
    if (!known) return true;
    if (!top) return false;
    if (isHarnessTree(top)) return true;
    return publicRemotesOf(top, env).some((x) => x === null || isDeclared(x, env));
  } catch (_) { return true; }
}

/**
 * Desde dónde corre un `gh` de la línea: `{ dir, candidates }`. `dir`: la carpeta del evento más los `cd` literales de
 * antes, o null si no se sabe. `candidates`: todas las carpetas desde las que PUEDE correr — con un `cd` que puede
 * fallar sin cortar la línea (`cd x; gh …`), también las de antes de cada uno; si no se sabe, al menos la del evento.
 */
function whereItRuns(cwd, c, env = process.env) {
  const steps = [cwd];
  let known = !c.cwdDesconocido;
  for (const step of c.cds) {
    const text = String(step);
    const next = path.resolve(steps[steps.length - 1], text.replace(/^~(?=$|[\\/])/, os.homedir()));
    // Una carpeta que no está no es «una carpeta que no es un clon»: el `cd` va a fallar, o la terminal la busca en
    // otro lado (con CDPATH, un nombre suelto se busca primero en esas carpetas). No se sabe dónde corre lo que sigue.
    const searched = Boolean(env.CDPATH) && !path.isAbsolute(text) && !/^(~|\.\.?)($|[\\/])/.test(text);
    let there = false;
    try { there = fs.statSync(next).isDirectory(); } catch (_) { there = false; }
    if (!there || searched) known = false;
    steps.push(next);
  }
  const dir = known ? steps[steps.length - 1] : null;
  const sure = dir !== null && !c.cdIncierto;
  return { dir, candidates: sure ? [dir] : [...new Set(steps)] };
}

/**
 * Revisa los `gh` de un comando (y que la línea no ponga las variables del freno junto a algo que publica). Devuelve
 * `{ code: 0 | 2, lines }` (2 = el comando no corre). Tira si algo falla por dentro: quien llama decide (no deja pasar).
 *
 * A QUÉ REPO VA CADA `gh`, en este orden: el que nombra (`--repo`, `GH_REPO`, la ruta de `gh api`); si no nombra
 * ninguno, el de la carpeta desde la que corre (la del evento más los `cd` literales de la línea). Es «del arnés» si
 * ese repo es uno de los que el arnés declara como suyos, o si la carpeta es un clon del arnés con un remoto público.
 * Cuando NO SE SABE —un `cd` a una variable, un repo en una variable, una mutación de GraphQL— el comando se revisa
 * igual, como si fuera al público: un texto limpio pasa, uno con un hallazgo no. Sólo lo que se sabe que va a OTRO repo
 * no se mira.
 */
function reviewGhCommand(command, { cwd = process.cwd(), env = process.env, powershell = false } = {}) {
  const G = ghReader();
  const looksLikeGh = G.pareceGh(command);
  const facts = lineFacts(command);
  if (!looksLikeGh && !(facts.sets && facts.pushes)) return { code: 0, lines: [] };
  const publishing = looksLikeGh ? G.comandosGh(command, 0, { powershell }).filter((c) => !c.lectura) : [];
  const blockedByVariables = () => {
    record('could-not-look', 'bloqueo');
    return { code: 2, lines: [
      '⛔ FRENADO — esta línea cambia de dónde salen la lista o el freno (TYCON_PUBLISH_DENYLIST, TYCON_GUIDES_DIR, TYCON_HOME), o la',
      '   configuración con que git encuentra sus hooks (HOME, GIT_CONFIG_GLOBAL, core.hooksPath…), junto a un comando que publica (`push` o un `gh`).',
      '   Con eso el comando se juzga con otro freno, o con ninguno: son de las pruebas, no para publicar. Corré el comando sin ellas;',
      '   si el freno frena de más, la salida es una excepción con motivo en la lista privada (`permitidos`).',
    ] };
  };
  // Sólo cuando el empuje PUEDE ser del arnés: en un repo de producto esas variables junto a un `push` no son asunto
  // de este freno (frenarlas ahí era frenar a un repo que no es del arnés, contra lo que el freno promete).
  if (facts.sets && facts.pushes && pushMayBeHarness(command, cwd, env)) return blockedByVariables();
  if (!publishing.length) return { code: 0, lines: [] };
  const names = [...new Set(publishing.map((c) => `\`${c.resumen}\``))].join(', ');
  try {
    const H = harnessRepo();
    // cada `gh`, con la carpeta desde la que corre y si le toca a este freno
    const mine = [];
    let anyTop = null;   // un árbol del arnés desde el que corre alguno: decide si la máquina «del equipo» por su perfil
    let unknown = false;
    let certain = false;   // de alguno se SABE que va al repo público del arnés
    const declared = (id) => isDeclared(id, env);
    // el repo que la SESIÓN ya traía puesto en su entorno: `gh` lo usa aunque la línea no lo nombre
    const sessionRepo = typeof env.GH_REPO === 'string' && env.GH_REPO.trim() ? G.repoDe(env.GH_REPO) : null;
    const sessionBlurry = Boolean(env.GH_HOST) || (typeof env.GH_REPO === 'string' && env.GH_REPO.trim() !== '' && !sessionRepo);
    for (const c of publishing) {
      const { dir, candidates } = whereItRuns(cwd, c, env);
      // cada carpeta desde la que puede correr: ¿es un clon del arnés con un remoto público?
      const places = candidates.map((d) => {
        const { top: t, known } = repoAt(d);
        const remotes = t ? publicRemotesOf(t, env) : [];
        // `blurry`: no se sabe de quién es ese lugar — git no pudo decir si es un repo, o tiene un remoto público cuya
        // dirección no se sabe leer (un alias de ssh)
        return { top: t, remotes, clone: remotes.length > 0 && (isHarnessTree(t) || remotes.some(declared)), blurry: !known || remotes.some((x) => x === null) };
      });
      const clone = places.find((p) => p.clone) || null;
      const blurry = dir === null || places.some((p) => p.blurry);
      let verdict;
      if (c.repo && !c.repoAmbiente) {
        // lo nombra el propio comando (su opción, su variable, la ruta de `gh api`): va ahí, corra donde corra
        const id = H.identidadRemoto(`https://github.com/${c.repo}`);
        verdict = declared(id) || places.some((p) => p.clone && p.remotes.some((x) => x && H.mismaIdentidad(x, id))) ? 'mine' : 'other';
      } else if (c.repoDesconocido) {
        // el comando nombra un repo que no se puede leer (o no se pudo leer el comando): ni la carpeta ni el repo de
        // la sesión dicen a dónde va
        verdict = clone ? 'mine' : 'unknown';
      } else if (c.repo || sessionRepo) {
        // lo puso un comando anterior de la línea, o la sesión: si no llegó a valer, decide la carpeta. Se miran las dos cosas
        verdict = declared(H.identidadRemoto(`https://github.com/${c.repo || sessionRepo}`)) || clone ? 'mine' : (blurry ? 'unknown' : 'other');
      } else if (clone) verdict = 'mine';
      else verdict = sessionBlurry || blurry ? 'unknown' : 'other';
      if (verdict === 'other') continue;
      if (verdict === 'unknown') unknown = true; else certain = true;
      if (clone) anyTop = clone.top;
      mine.push({ c, dir, top: dir ? toplevel(dir) : null });
    }
    if (!mine.length) return { code: 0, lines: [] };
    if (facts.sets) return blockedByVariables();
    const where = unknown ? 'no se sabe a qué repo va (se mira como si fuera al repo público del arnés)' : 'publica en el repo público del arnés';

    const unreadable = [...new Set(mine.flatMap(({ c, dir }) => {
      const out = [...c.ilegible];
      // un archivo se lee AHORA y `gh` lo lee después: si otro comando de la misma línea puede escribirlo, o no se sabe
      // en qué carpeta va a correr, lo que se mira no es lo que se publica
      if (c.archivos.length && c.otros > 0) out.push('otro comando de la misma línea puede cambiar el archivo que el `gh` publica después de que se lo miró: corré el `gh` solo, en su propia llamada');
      const relative = c.archivos.some((a) => !path.isAbsolute(String(a.ruta).replace(/^~(?=$|[\\/])/, os.homedir())));
      if (relative && dir === null) out.push('no se sabe desde qué carpeta corre el `gh`, así que tampoco qué archivo va a leer');
      else if (relative && c.cdIncierto) out.push('un `cd` de la misma línea puede fallar sin cortarla, y entonces el `gh` lee el archivo de otra carpeta: uní el `cd` con `&&`, o pasá la ruta completa del archivo');
      return out;
    }))];
    if (unreadable.length) {
      record('unreadable-text', 'bloqueo');
      return { code: 2, lines: [
        `⛔ ${names} FRENADO — ${where} y no pude mirar lo que publica: ${unreadable.join('; ')}.`,
        `   «No pude mirar» no es «limpio»: nada se publicó. ${READABLE_FORM}`,
      ] };
    }

    // la lista es obligatoria cuando se SABE que alguno va al repo público del arnés; si de todos sólo «no se sabe», en
    // una máquina sin lista se mira lo que no la necesita (y se dice)
    const list = resolveList(anyTop, env, { optional: !certain });
    const scan = historyScanner(anyTop ? { top: anyTop, remote: null } : null);
    const R = makeReview(list, scan);
    for (const { c, dir, top } of mine) {
      for (const t of c.textos) R.message(t.texto, (linea) => `el texto de ${t.de === 'argumento' ? 'un argumento' : t.de} de \`${c.resumen}\` (línea ${linea})`, ROUTES.pullRequest);
      for (const a of c.archivos) reviewLocalFile(R, list, a, c, dir, top);
    }
    if (R.findings.length) {
      record('finding', 'bloqueo');
      const L = [`⛔ ${names} FRENADO — ${where} y ${R.findings.length} cosa(s) de lo que publica no pueden salir:`];
      for (const f of R.findings.slice(0, MAX_SHOWN)) L.push(`   · [${f.category}${f.rule ? `/${f.rule}` : ''}] ${f.place}`);
      if (R.findings.length > MAX_SHOWN) L.push(`   · … y ${R.findings.length - MAX_SHOWN} más`);
      L.push(...publicProblemLines(R.findings, scan));
      L.push('   Nada se publicó. Corregí el texto y volvé a correr el comando; si es un freno falso, la salida es una excepción');
      L.push('   con motivo en la lista privada (`permitidos`), como en el exportador.');
      return { code: 2, lines: L };
    }
    record(list.generic ? 'generic-only' : 'clean', 'paso');
    // lo que no se midió se dice, igual que al empujar: que falte el control —o la lista, en una máquina que no es del
    // equipo— no puede verse igual que «se miró todo y estaba limpio»
    const said = [];
    if (list.generic) said.push(`[public-push-guard] ${names} pasa; sin lista en esta máquina: sólo se miraron secretos, correos, rutas de máquina y binarios.`);
    if (!scan) said.push(`[public-push-guard] ${names} pasa; los números de pedido NO se miraron (falta ${HISTORY_PATH}).`);
    return { code: 0, lines: said };
  } catch (e) {
    record('could-not-look', 'bloqueo');
    const reason = e instanceof Blind ? e.message : `el freno falló por dentro (${(e && (e.code || e.name)) || 'error'})`;
    return { code: 2, lines: [
      `⛔ ${names} FRENADO — no pude mirar lo que publica: ${reason}.`,
      '   «No pude mirar» no es «limpio»: nada se publicó.',
    ] };
  }
}

/** Un archivo local que `gh` lee o sube: su contenido con el detector completo, y su nombre si se publica (un adjunto). */
function reviewLocalFile(R, list, file, c, dir, top) {
  const D = R.D;
  const abs = path.resolve(dir || process.cwd(), String(file.ruta).replace(/^~(?=$|[\\/])/, os.homedir()));
  const uploaded = file.de === 'adjunto' || file.de === 'archivo';   // se publica con su nombre
  const base = path.basename(abs);
  const nameFindings = R.text(base, ROUTES.paths);
  const shown = nameFindings.length ? 'un archivo cuyo nombre no se imprime' : base;
  const where = `el archivo de ${uploaded ? `\`${c.resumen}\`` : file.de} (${shown})`;
  if (uploaded) for (const category of new Set(nameFindings.map((h) => h.categoria))) R.add(category, null, `${where}: su nombre`);
  // sólo un archivo común: la entrada estándar por su nombre (`/dev/stdin`), una tubería o un dispositivo entregan otra
  // cosa cuando los lee `gh` — leídos acá dan vacío, y vacío se leería como limpio
  let data;
  try {
    if (/^\/(dev|proc)\//.test(abs) || !fs.statSync(abs).isFile()) throw Object.assign(new Error('no es un archivo común'), { code: 'no es un archivo común: una tubería, un dispositivo o una carpeta' });
    data = fs.readFileSync(abs);
  } catch (e) { throw new Blind(`no pude leer ${where} (${(e && e.code) || 'error'})`); }
  // la ruta con que la lista decide sus excepciones: la del repo si el archivo vive en él; si no, la del texto de un pedido
  // (con las rutas REALES de los dos lados: el archivo nombrado con otras mayúsculas es el mismo, y su excepción vale)
  const inside = top && isInside(abs, top) ? path.relative(realOf(top), realOf(abs)).split(path.sep).join('/') : null;
  const route = uploaded ? (inside || base) : ROUTES.pullRequest;
  if (D.esBinario(data)) {
    const allowed = list.cfg.binariosPermitidos.some((g) => g.test(route)) || list.cfg.permitidos.some((x) => !x.patron && x.archivo.test(route));
    if (!allowed) R.add('sin-leer', null, `${where}: un binario`);
    return;
  }
  R.message(data.toString('utf8'), (linea) => `${where}, línea ${linea}`, route);
}

// la forma de un `gh` que publica, buscada en el texto de un evento que no se pudo leer como siempre
const GH_IN_RAW = /(^|[^A-Za-z0-9_.-])gh(\.exe)?["',\s\\]+(pr|issue|release|api|gist|repo|label)\b/i;

/**
 * El modo freno: la entrada es el evento de la herramienta (JSON; null si no se pudo leer). Sale 2 para que el comando no
 * corra. Lo que no puede pasar es que deje pasar SIN decirlo: un evento que no trae el comando en la forma de siempre se
 * dice siempre, y si su texto trae un `gh` que publica, no corre; y un error propio con un `gh` a la vista tampoco.
 */
function hookMode(payloadText, env = process.env) {
  const said = (what) => `[public-push-guard] ${what}: no freno, pero tampoco miré.`;
  if (payloadText === null) return { code: 0, lines: [said('no pude leer la entrada del hook')] };
  let payload;
  try { payload = JSON.parse(payloadText || 'null'); } catch (_) { payload = undefined; }
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.tool_input : undefined;
  const command = input && typeof input === 'object' && typeof input.command === 'string' ? input.command : null;
  if (command === null) {
    if (GH_IN_RAW.test(String(payloadText))) {
      return { code: 2, lines: ['⛔ FRENADO — no pude leer el comando de este evento y su texto trae un `gh` que puede publicar: lo que no pude mirar no sale.'] };
    }
    return { code: 0, lines: [said('el evento no trae un comando que yo sepa leer')] };
  }
  if (!command) return { code: 0, lines: [] };
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  try {
    // la herramienta de PowerShell escribe sus comandos con otras reglas (la barra invertida no escapa, los bloques de
    // texto son `@'…'@`): el lector tiene que saberlo
    return reviewGhCommand(command, { cwd, env, powershell: /powershell|pwsh/i.test(String(payload.tool_name || '')) });
  } catch (e) {
    // un error propio: para la herramienta, cualquier código que no sea 2 deja correr el comando
    const kind = (e && (e.code || e.name)) || 'error';
    if (GH_IN_RAW.test(command) || /push/.test(command)) {
      return { code: 2, lines: [`⛔ FRENADO — el freno de publicación falló por dentro (${kind}) con un comando que puede publicar: lo que no pude mirar no sale.`] };
    }
    return { code: 0, lines: [said(`el freno falló por dentro (${kind})`)] };
  }
}

function main(argv) {
  const [mode, ...rest] = argv;
  // Una entrada que no se pudo LEER es null, nunca '': vacía quiere decir «git no empuja nada» o «un evento sin
  // comando», y leer así un error de lectura dejaría salir un empuje sin mirarlo.
  const readInput = () => { try { return fs.readFileSync(0, 'utf8'); } catch (_) { return null; } };
  if (mode === undefined) {
    // 🔴 se lee la entrada ANTES de decidir nada: salir sin drenarla rompe la tubería de quien escribe
    let r;
    try { r = hookMode(readInput()); } catch (e) {
      // para la herramienta sólo el 2 frena: un error acá no puede terminar en un código que deje correr un `gh`
      r = { code: 2, lines: [`⛔ FRENADO — el freno de publicación falló por dentro (${(e && (e.code || e.name)) || 'error'}): lo que no pude mirar no sale.`] };
    }
    for (const l of r.lines) process.stderr.write(`${l}\n`);
    return r.code;
  }
  if (mode === 'pre-push') {
    const json = rest.includes('--json');
    const [remoteName, url] = rest.filter((a) => !a.startsWith('--'));
    // `--input-unreadable`: quien llama (el despachador) no pudo leer lo que git le pasó. Se dice con un argumento:
    // cerrarle la entrada a Node no alcanza (reabre el descriptor sobre nada y lee vacío, que es «nada que empujar»).
    const { code, result } = prePush({ remoteName, url, input: rest.includes('--input-unreadable') ? null : readInput() });
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else for (const l of prePushMessage(result)) process.stderr.write(`${l}\n`);
    return code;
  }
  if (mode === 'pre-commit') {
    const { code, result } = preCommit();
    for (const l of preCommitMessage(result)) process.stderr.write(`${l}\n`);
    if (code === 1) return 1;
    // no poder mirar: el commit se deshace y el empuje vuelve a mirar. El chequeo previo de un ok de guardar, en cambio, no firma
    return code === 2 && process.env.TYCON_PRECOMMIT_READ_ONLY === '1' ? 2 : 0;
  }
  if (mode === 'status') {
    const s = status({ fetch: rest.includes('--fetch') });
    process.stdout.write(`${s.lines.join('\n')}\n`);
    return s.code;
  }
  if (mode === 'range') {
    // Opciones con valor, y nada más: un argumento que no se conoce no se saltea (un `--base` mal escrito dejaría el
    // rango sin base, y eso no puede terminar en «nada que mirar»).
    const valued = new Map([['--base', 'base'], ['--head', 'head'], ['--branch', 'branch'], ['--title-file', 'titleFile'], ['--body-file', 'bodyFile']]);
    const opts = {};
    let json = false;
    let bad = null;
    for (let i = 0; i < rest.length && !bad; i += 1) {
      if (rest[i] === '--json') json = true;
      // el valor es lo que sigue, empiece como empiece (una rama se puede llamar `--json`); vacío no es un valor: una
      // variable del pipeline que quedó vacía no puede terminar en «sin rama» o «sin título» sin que nadie lo vea
      else if (valued.has(rest[i]) && rest[i + 1] !== undefined && rest[i + 1] !== '') { opts[valued.get(rest[i])] = rest[i + 1]; i += 1; }
      else bad = rest[i];
    }
    if (bad !== null) {
      process.stderr.write('uso: public-push-guard.js range --base <commit> --head <commit> [--branch <nombre>] [--title-file <archivo>] [--body-file <archivo>] [--json]\n');
      return 2;
    }
    const { code, result } = rangeMode(opts);
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${rangeMessage(result).join('\n')}\n`);
    return code;
  }
  process.stderr.write('uso: public-push-guard.js pre-push <remoto> <dirección> [--json] | range --base <commit> --head <commit> […] | status [--fetch]\n');
  return 2;
}

module.exports = {
  FORBIDDEN, ROUTES, Blind, judgeRemote, isHarnessTree, toplevel, listPlaces, resolveList, isTeamMachine, historyScanner,
  parseLines, reviewPush, newPairs, prePush, prePushMessage, status, makeReview, reviewIdentity, main,
  publicRemotesOf, reviewGhCommand, reviewLocalFile, hookMode, concernsHarness, lineFacts, whereItRuns, otherHeaders,
  remoteHas, readObjects, repoAt, pushMayBeHarness, isDeclared,
  // el modo de rango (la validación de un pedido)
  rangeMode, rangeMessage,
  // el modo del commit (dentro del control del commit)
  preCommit, preCommitMessage,
  // ¿la lista está al día? (lo usan también `harness.js doctor` y scripts/publishing/new-names.js; las
  // firmas, en el comentario de cada función)
  listFreshness, freshnessText, freshnessLines, gitElsewhere, HOOK_MARK, LIST_PATH, LIST_STALE_DAYS, LIST_REMOTE_ANSWER_MS,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
