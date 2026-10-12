#!/usr/bin/env node
'use strict';
// harness-repo.js — ¿este repo es uno de los repos DEL arnés? Lo dice el REMOTO, no la carpeta.
// (2026-09-17, el pendiente (a) de incident-log#retro-por-push-sin-story-2026-09-16)
//
// POR QUÉ EXISTE: los repos del arnés (agent-skills / el arnés) se trabajan directo en
// main, sin story ni pipeline, así que varios controles los excluyen. Esa exclusión estaba escrita
// TRES veces —retro-pending.js, unpushed-work-notice.js y lib/story-gate.js de agent-skills— y las
// tres miraban si algún segmento de la RUTA se llamaba `agent-skills` o el arnés. O sea
// que el mismo repo era o no «del arnés» según la carpeta desde la que se trabajaba: un clon
// descartable (`…/scratchpad/tcg`, que es como se trabaja cuando hay otra sesión viva en el checkout)
// NO quedaba excluido, y un repo de producto clonado debajo de una carpeta con ese nombre quedaba
// excluido sin serlo — la cara: un control que no corre y nada lo dice.
//
// EL CRITERIO, en un solo lugar:
//   1. El `origin` del repo juzgado, normalizado (`identidadRemoto`: host + ruta, sin usuario, sin
//      `.git`, sin caja; las formas de Azure DevOps que lee `identidadAzure` se normalizan a
//      `dev.azure.com/<org>/<proyecto>/<repo>`, así `<org>.visualstudio.com/P/_git/R` y
//      `dev.azure.com/<org>/P/_git/R` son el mismo repo; `git@github.com:o/r.git` ≡
//      `https://github.com/o/r`), comparado EXACTO contra las identidades del arnés. Nunca por
//      substring: un repo que sólo empieza con el mismo nombre no es el arnés.
//   2. Un `origin` que es una RUTA local (clon de un checkout, `file://`) se sigue hasta el repo de
//      verdad, con tope de saltos.
//   3. SÓLO si el repo no tiene `origin` (o la ruta no está en ningún repo git) decide el nombre de
//      la carpeta: no hay otra identidad que leer.
//   4. Un remoto que no se sabe leer (no es una URL de git) NO es el arnés — la duda va hacia más control.
//
// QUÉ ES «EL ARNÉS» (story 8.3, AC 7 — antes eran dos URLs de una organización escritas acá):
//   las identidades de referencia salen del `origin` del PROPIO clon del arnés (este archivo vive en
//   `<clon>/scripts/lib/`) y del `origin` de agent-skills (`~/.claude/agent-skills`, o `TYCON_SKILLS_DIR`),
//   cada uno seguido con la MISMA cadena que el repo juzgado (el propio clon puede ser descartable, con
//   `origin` local). Así un clon del arnés alojado en otro servidor (un fork en GitHub) se reconoce a sí
//   mismo. Sin `origin` legible en el propio clon no hay identidad: decide la carpeta, como siempre, y se
//   dice (`por: 'carpeta-sin-identidad-propia'`). Para las pruebas —y para quien quiera fijarlas— se
//   inyectan: `TYCON_HARNESS_IDENTITIES="url1,url2"` o `opts.identidades`.
//
// LAS TRES FORMAS DE MÁQUINA (story 8.18, contrato C5 — lo usa el carril de las máquinas; no se cambia sin avisar):
//   el arnés y agent-skills pasan a ser UN repo, y mientras dura la mudanza una máquina puede tener
//     (a) un árbol: el clon del repo unido, con `~/.claude/agent-skills` enlazado a él;
//     (b) dos clones, el viejo de agent-skills ya re-apuntado al remoto del arnés (mismo `origin`);
//     (c) dos clones, el viejo sin re-apuntar (su `origin` es el remoto viejo).
//   En las tres, los dos clones son «del arnés». (a) y (b) salen solas: es el `origin` del propio clon. La (c) no:
//   «dónde están las skills» lo contesta `resolveSkillsDirs()`, que desde esta story dice EL PROPIO CLON cuando trae
//   `skills/` —después del corte, el clon del arnés de toda máquina—, y el remoto viejo se quedaba sin nadie que lo
//   nombrara: el clon instalado de las skills pasaba a tratarse como un repo de producto. Por eso la referencia suma
//   SIEMPRE el `origin` de lo instalado en `~/.claude/agent-skills`, además del propio clon y de lo que diga la regla.
//   Con `TYCON_SKILLS_DIR` puesta manda la variable, como en todo el arnés: lo instalado no suma.
//   El remoto viejo es «del arnés» mientras exista ese clon instalado con ese `origin`: no hay ninguna URL escrita acá,
//   y una máquina que ya re-apuntó deja de reconocer, sola, un clon suelto que siga en el remoto viejo.
//
// LOS OTROS REPOS DEL ARNÉS (story 8.26, AC 21): desde el corte a GitHub, el dueño escribe en el repo PÚBLICO y lo interno
//   vive en el repo de MANTENIMIENTO. Los dos se trabajan como el arnés, y ninguno es el `origin` del clon que corre. Su
//   identidad la DECLARA ese clon, junto a él (nunca escrita acá): en el interno, `scripts/publishing/public-repos.json`
//   (`org`/`repo` del público en GitHub y `maintainers`, la dirección del de mantenimiento); en la copia,
//   `scripts/setup/public-remotes.json` (los remotos públicos, con el nombre ya puesto). Una declaración que está y no se
//   deja leer no suma nada —la duda va hacia más control— y la CLI la nombra (`declaraciones_ilegibles`). Con
//   identidades inyectadas no se suma lo declarado: mandan las inyectadas.
// LO QUE DECLARA LA MÁQUINA (story 8.26, tanda H1c · AC 65): después del corte, quien mantiene trabaja en un clon del
//   PÚBLICO, que no trae `public-repos.json`: la dirección del repo de mantenimiento ya no la puede declarar el árbol.
//   La declara la máquina (`paths.maintainers` de su configuración: el clon privado, que hasta la tanda J es el del
//   interno), y cuenta el `origin` de ESE clon, seguido como cualquier otro. A diferencia de lo que declara el árbol,
//   vale también cuando el clon que corre NO tiene identidad propia: una versión instalada no es un clon (medido el
//   2026-10-11: su referencia quedaba vacía y decidía el nombre de la carpeta, así que un clon descartable del repo
//   interno salía «no»), y la declaración de la máquina no es un archivo suelto junto al árbol: es la persona diciendo
//   cuál es su clon. Con ella en la referencia, lo que el árbol declara se suma como siempre.
//   🔴 Lo que eso cambia: en esa máquina, todo clon de un repo del arnés pasa a serlo por su remoto, esté donde esté, y
//   ahí dejan de correr los controles que excluyen a los repos del arnés (el portón de carril, el registro de
//   retrospectivas, el aviso de trabajo sin subir). Sin la declaración, nada cambia.
//   La ruta la da scripts/setup/harness/tycon-home.js, que se carga SI ESTÁ: una copia suelta de este archivo (el banco,
//   un laboratorio) no lee la configuración de la máquina. Sólo cuenta si la carpeta declarada es la RAÍZ de su repo: si
//   dejó de ser un clon, git subiría al repo de arriba y ése pasaría a ser «del arnés». Una declaración que no sirve no
//   suma nada y la CLI la nombra (`declaracion_de_maquina`). Con identidades inyectadas tampoco se suma.
// git se llama SIN las variables que deja un hook de git (GIT_DIR y compañía): con ellas puestas, `git -C <otro>` lee el
//   repo del hook, y un repo de producto salía «del arnés» con el remoto del repo que se estaba commiteando.
// Límites declarados: mira `origin` aunque se trabaje contra otro remoto.
//
// A mano:  node scripts/lib/harness-repo.js [dir|archivo]   → dice qué decidió, por qué, y qué es «el arnés» acá.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readEnv } = require('./legacy-names.js');

const RAIZ = path.resolve(__dirname, '..', '..');
// la carpeta del clon por su nombre (respaldo sin `origin`): agent-skills, el repo interno y el público, que se clona en
// una carpeta con el nombre del lugar (story 8.19, AC 12: los dos nombres, siempre como segmento de ruta). Escritos acá:
// el banco y varias suites copian este archivo suelto a un árbol de juguete (reconocedor declarado en
// scripts/tests/fixtures/harness-place-names.json).
const SEGMENTOS_DEL_ARNES = ['agent-skills', 'tycon-claude-guides', 'tycon-harness'];
const MAX_SALTOS = 4; // un clon de un clon de un clon alcanza; un ciclo de `origin` locales no cuelga a nadie
const ENV_IDENTIDADES = 'TYCON_HARNESS_IDENTITIES';

// la ruta REAL, con la caja del disco: `realpathSync` a secas resuelve los enlaces pero deja las mayúsculas como se
// escribieron; en un disco que no las distingue (Mac, Windows) la misma carpeta tipeada con otra caja no era «la misma»
// que la que contesta git, que sí la corrige (pase adversarial de la story 8.26, tanda H1c)
function real(p) { try { return fs.realpathSync.native(String(p)); } catch { return String(p); } }
// lo que git le deja puesto a un hook: apunta al repo del hook, no al que se pregunta (cabecera)
const GIT_OF_A_HOOK = /^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR|NAMESPACE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/;
function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !GIT_OF_A_HOOK.test(k)));
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, env, windowsHide: true }).trim(); }
  catch { return ''; }
}
/** Lo mismo, diciendo si git CONTESTÓ: `{ answered, out }`. Salir con un código es una respuesta («no es un repo»);
 *  no estar en el PATH o pasar el tope no lo es, y leído como una respuesta el motivo que se informa es falso. */
function gitAnswer(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !GIT_OF_A_HOOK.test(k)));
  try { return { answered: true, out: execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, env, windowsHide: true }).trim() }; }
  catch (e) { return { answered: Boolean(e) && typeof e.status === 'number', out: '' }; }
}

/** (org, proyecto, repo) de una URL de Azure DevOps en cualquiera de sus formas, o null.
 *  `_git/<repo>` sin proyecto es la forma corta que Azure acepta cuando se llaman igual.
 *  Queda para quien parsea remotos de PRODUCTO en Azure (step-09b-create-pr.md arma la PR con esto). */
function identidadAzure(url) {
  const u = String(url || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const crudo = (s) => { try { return decodeURIComponent(s); } catch { return String(s); } };
  const limpio = (s) => crudo(s).toLowerCase();
  // `nombre`: el repo como lo escribe el remoto (con su caja), para quien necesite NOMBRARLO.
  const id = (org, proyecto, repo) => ({ org: limpio(org), proyecto: limpio(proyecto || repo), repo: limpio(repo), nombre: crudo(repo) });
  let m = u.match(/^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/(?:([^/]+)\/)?_git\/(?:_(?:optimized|full)\/)?([^/]+)$/i);
  if (m) return id(m[1], m[2], m[3]);
  m = u.match(/^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?(?:([^/]+)\/)?_git\/(?:_(?:optimized|full)\/)?([^/]+)$/i);
  if (m) return id(m[1], m[2], m[3]);
  m = u.match(/^(?:ssh:\/\/)?[^@/]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::\d+)?[:/]v3\/([^/]+)\/([^/]+)\/([^/]+)$/i);
  if (m) return id(m[1], m[2], m[3]);
  return null;
}

/** Identidad normalizada de CUALQUIER remoto de git: `{ host, ruta, nombre }` (+ org/proyecto/repo si es
 *  Azure), o null si no es una URL de git legible. */
function identidadRemoto(url) {
  const az = identidadAzure(url);
  if (az) return { host: 'dev.azure.com', ruta: `${az.org}/${az.proyecto}/${az.repo}`, nombre: az.nombre, org: az.org, proyecto: az.proyecto, repo: az.repo };
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return null;
  let host = null;
  let ruta = null;
  let m = u.match(/^(?:ssh|git|https?|git\+ssh|ssh\+git|ftps?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);   // esquema://[usuario@]host[:puerto]/ruta
  if (m) { host = m[1]; ruta = m[2]; }
  else {
    // usuario@host:ruta (scp). Un host sin punto (`git@gitserver:o/r.git`, un servidor interno) también vale — AC 7,
    // «cualquier host» (pase adversarial, vuelta 1); lo que NO es un remoto es una ruta de Windows: una sola letra
    // sin usuario seguida de `\` o `/` (`C:\repos`, `C:/repos`).
    m = u.match(/^(?:([^@/\\]+)@)?([^/\\:]+):(?![\\/]{2})(.+)$/);
    if (m && !(m[2].length === 1 && !m[1] && /^[\\/]/.test(m[3]))) { host = m[2]; ruta = m[3]; }
  }
  if (!host || !ruta) return null;
  ruta = ruta.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!ruta) return null;
  const crudo = (s) => { try { return decodeURIComponent(s); } catch { return String(s); } };
  return { host: host.toLowerCase(), ruta: crudo(ruta).toLowerCase(), nombre: crudo(ruta.split('/').pop()) };
}
/** Un id de `identidadAzure` (sin host) se lleva a la forma normalizada. */
function normalizar(id) {
  if (!id) return null;
  if (id.host) return id;
  if (id.org) return { host: 'dev.azure.com', ruta: `${id.org}/${id.proyecto}/${id.repo}`, nombre: id.nombre, org: id.org, proyecto: id.proyecto, repo: id.repo };
  return null;
}
function mismaIdentidad(a, b) { a = normalizar(a); b = normalizar(b); return !!a && !!b && a.host === b.host && a.ruta === b.ruta; }

// Un `origin` que es una RUTA: el repo es lo que sea ESE otro.
function rutaLocalDe(url, desde) {
  let u = String(url || '').trim();
  if (/^file:\/\//i.test(u)) { try { u = decodeURIComponent(u.replace(/^file:\/\//i, '')); } catch { return null; } }
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^[^/\\]+@[^/\\:]+:/.test(u)) return null; // otra URL, o `user@host:ruta`
  const p = path.resolve(desde, u.replace(/^~(?=$|\/)/, os.homedir()));
  return fs.existsSync(p) ? p : null;
}
/** El respaldo: ¿algún segmento de la ruta se llama como un repo del arnés? */
function porNombreDeCarpeta(p) {
  return String(p || '').split(/[\\/]/).some((seg) => SEGMENTOS_DEL_ARNES.includes(seg));
}

/** Sigue el `origin` de un repo hasta un remoto legible (o hasta donde se pueda).
 *  @returns {{url:string, id:object|null, por:'remoto'|'sin-origin'|'remoto-ilegible'|'tope-de-saltos', saltos:number, dir:string}} */
function resolverRemoto(root) {
  let dir = root;
  for (let salto = 0; salto < MAX_SALTOS; salto++) {
    const url = git(dir, ['remote', 'get-url', 'origin']);
    if (!url) return { url: '', id: null, por: 'sin-origin', saltos: salto, dir };
    const id = identidadRemoto(url);
    if (id) return { url, id, por: 'remoto', saltos: salto, dir };
    const local = rutaLocalDe(url, dir);
    if (!local) return { url, id: null, por: 'remoto-ilegible', saltos: salto, dir };
    dir = local;
  }
  return { url: '', id: null, por: 'tope-de-saltos', saltos: MAX_SALTOS, dir };
}

const memo = new Map();
/** Qué es «el arnés» acá: las identidades de referencia (inyectadas, o las del propio clon y de agent-skills). */
function identidadesDelArnes(opts = {}) {
  if (Array.isArray(opts.identidades)) return opts.identidades.map((u) => (typeof u === 'string' ? identidadRemoto(u) : normalizar(u))).filter(Boolean);
  const env = opts.env || process.env;
  const crudas = readEnv(ENV_IDENTIDADES, { env, where: 'scripts/lib/harness-repo.js' });
  const inyectadas = crudas ? String(crudas).trim() : '';
  const installed = path.join(os.homedir(), '.claude', 'agent-skills');
  // lo que declara la máquina entra en la clave: la respuesta de una configuración no vale para otra
  const maquina = inyectadas ? null : declaracionDeMaquina(env);
  const clave = `${inyectadas}|${env.TYCON_SKILLS_DIR || ''}|${installed}|${maquina ? `${maquina.path || ''}|${maquina.problem || ''}` : ''}`;
  if (memo.has(clave)) return memo.get(clave);
  let ids;
  if (inyectadas) ids = inyectadas.split(',').map((s) => identidadRemoto(s.trim())).filter(Boolean);
  else {
    // 🔴 El valor de siempre (lo instalado) es SÓLO para la copia que viaja sin skills-dir.js al lado. Antes era un
    //    `catch` que tragaba cualquier error (pase adversarial del tramo 1 de la story 8.18, 2026-10-04). Medido: con la
    //    variable puesta y un skills-dir.js que está y no carga, la referencia salía de lo instalado en vez de la
    //    variable —un clon suelto con el remoto viejo pasaba a ser «del arnés»— con código 0 y sin una línea; y el
    //    error que skills-dir.js tira cuando su vecina canonical-path.js está y no carga se perdía acá. Se mira si el
    //    archivo ESTÁ, no el mensaje del error (el «Require stack» nombra a skills-dir.js aunque falte otro).
    let skills = installed;
    if (fs.existsSync(path.join(__dirname, 'skills-dir.js'))) skills = require('./skills-dir.js').resolveSkillsDirs(env.TYCON_SKILLS_DIR).repo;
    // Las tres formas de máquina (cabecera): sin la variable, lo instalado suma su identidad aunque «las skills» sean
    // las del propio clon. `resolveSkillsDirs(undefined)` lee la variable del proceso: acá se mira la misma.
    const withVariable = !!(env.TYCON_SKILLS_DIR !== undefined ? env.TYCON_SKILLS_DIR : process.env.TYCON_SKILLS_DIR);
    const dirs = withVariable ? [RAIZ, skills] : [RAIZ, skills, installed];
    ids = [];
    for (const d of dirs) {
      const id = resolverRemoto(d).id;
      if (id && !ids.some((x) => mismaIdentidad(x, id))) ids.push(id);
    }
    // lo que declara la MÁQUINA (cabecera): vale también sin identidad propia
    for (const id of deLaMaquina(env).ids) if (!ids.some((x) => mismaIdentidad(x, id))) ids.push(id);
    // lo declarado se suma a una referencia que YA existe: sin identidad propia legible, decide la carpeta (y se dice),
    // y una declaración suelta no puede armar por sí sola qué es «el arnés»
    if (ids.length) for (const id of declaradas().ids) if (!ids.some((x) => mismaIdentidad(x, id))) ids.push(id);
  }
  memo.set(clave, ids);
  return ids;
}

// Las declaraciones de los otros repos del arnés (cabecera, «LOS OTROS REPOS DEL ARNÉS»), relativas al clon que corre.
const DECLARACIONES = [
  { ruta: 'scripts/publishing/public-repos.json',
    urls: (d) => {
      const out = [];
      const nombre = /^[A-Za-z0-9._-]+$/;
      if (typeof d.org === 'string' && typeof d.repo === 'string' && nombre.test(d.org) && nombre.test(d.repo)) out.push(`https://github.com/${d.org}/${d.repo}`);
      if (typeof d.maintainers === 'string') out.push(d.maintainers);
      return out;
    },
    // cuál de ésas es el PÚBLICO: el org/repo de GitHub (`maintainers` es el privado)
    publicas: (d) => {
      const nombre = /^[A-Za-z0-9._-]+$/;
      return typeof d.org === 'string' && typeof d.repo === 'string' && nombre.test(d.org) && nombre.test(d.repo) ? [`https://github.com/${d.org}/${d.repo}`] : [];
    } },
  { ruta: 'scripts/setup/public-remotes.json',
    urls: (d) => (Array.isArray(d.remotes) ? d.remotes.filter((u) => typeof u === 'string' && !u.includes('{{')) : []),
    publicas: (d) => (Array.isArray(d.remotes) ? d.remotes.filter((u) => typeof u === 'string' && !u.includes('{{')) : []) },
];
let memoDeclaradas = null;
/** Las identidades que declara el clon que corre (`ids`), cuáles de ellas son el repo PÚBLICO (`publicas`), y las
 *  declaraciones que están y no se dejan leer. */
function declaradas() {
  if (memoDeclaradas) return memoDeclaradas;
  const ids = [];
  const publicas = [];
  const ilegibles = [];
  for (const dec of DECLARACIONES) {
    const abs = path.join(RAIZ, dec.ruta);
    if (!fs.existsSync(abs)) continue;
    let datos;
    try {
      datos = JSON.parse(fs.readFileSync(abs, 'utf8'));
      if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw new Error('no es un objeto');
    } catch (e) {
      ilegibles.push({ ruta: dec.ruta, motivo: String(e.message).split('\n')[0] });
      continue;
    }
    for (const u of dec.urls(datos)) {
      const id = identidadRemoto(u);
      if (id && !ids.some((x) => mismaIdentidad(x, id))) ids.push(id);
    }
    for (const u of dec.publicas(datos)) {
      const id = identidadRemoto(u);
      if (id && !publicas.some((x) => mismaIdentidad(x, id))) publicas.push(id);
    }
  }
  memoDeclaradas = { ids, publicas, ilegibles };
  return memoDeclaradas;
}
/** ¿Es el repo PÚBLICO del arnés, el que el clon que corre declara? (story 8.26, tanda H1c: de quién es la
 *  configuración del merge que se lee del clon de mantenimiento). Nunca por lo que declara la máquina. */
function esPublicoDeclarado(id) {
  const n = normalizar(id);
  return !!n && declaradas().publicas.some((x) => mismaIdentidad(x, n));
}
/** Lo que la máquina declara como su clon de mantenimiento: `{ declared, path, problem }` (de tycon-home.js, si está). */
function declaracionDeMaquina(env = process.env) {
  const lib = path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js');
  if (!fs.existsSync(lib)) return { declared: false, path: null, problem: null };
  try {
    const fn = require(lib).maintainersClone;
    if (typeof fn !== 'function') return { declared: false, path: null, problem: null };   // un tycon-home.js anterior a la clave
    return fn({ env });
  } catch (e) { return { declared: false, path: null, problem: `no pude leer lo que declara la máquina (${String((e && e.message) || e).split('\n')[0]})` }; }
}
/** La identidad que suma la declaración de la máquina: `{ ids, declared, path, problem }`. Sin declaración, o con una
 *  que no sirve, `ids` viene vacía (y `problem` dice por qué). */
function deLaMaquina(env = process.env) {
  const d = declaracionDeMaquina(env);
  const out = (ids, problem) => ({ ids, declared: d.declared, path: d.path, problem: problem || null });
  if (!d.declared || d.problem) return out([], d.problem);
  // sólo la RAÍZ de un repo: desde una carpeta que dejó de ser un clon, git contesta con el repo de arriba
  const asked = gitAnswer(d.path, ['rev-parse', '--show-toplevel']);
  // un git que no contesta (no está, o pasó su tope) no es «no es un clon»: el motivo dice lo que pasó
  if (!asked.answered) return out([], 'git no contestó si paths.maintainers es un clon (no está en el PATH, o tardó demasiado)');
  const top = asked.out;
  if (!top || real(top) !== real(d.path)) return out([], 'paths.maintainers no es la raíz de un clon de git');
  const r = resolverRemoto(d.path);
  if (!r.id) return out([], 'el clon de paths.maintainers no tiene un remoto que se pueda leer');
  return out([r.id], null);
}
function esIdentidadDelArnes(id, opts) {
  const n = normalizar(id);
  return !!n && identidadesDelArnes(opts).some((r) => mismaIdentidad(r, n));
}

/** @returns {{arnes:boolean, por:'remoto'|'carpeta'|'carpeta-sin-identidad-propia'|'remoto-ilegible'|'tope-de-saltos', url:string, saltos:number, id?:object}} */
function juzgarRepo(root, opts) {
  const r = resolverRemoto(root);
  if (r.por === 'sin-origin') return { arnes: porNombreDeCarpeta(real(r.dir)), por: 'carpeta', url: '', saltos: r.saltos };
  if (r.por === 'remoto-ilegible') return { arnes: false, por: 'remoto-ilegible', url: r.url, saltos: r.saltos };
  if (r.por === 'tope-de-saltos') return { arnes: false, por: 'tope-de-saltos', url: '', saltos: r.saltos };
  const refs = identidadesDelArnes(opts);
  if (!refs.length) return { arnes: porNombreDeCarpeta(real(root)), por: 'carpeta-sin-identidad-propia', url: r.url, saltos: r.saltos, id: r.id };
  return { arnes: refs.some((x) => mismaIdentidad(x, r.id)), por: 'remoto', url: r.url, saltos: r.saltos, id: r.id };
}
/** ¿La raíz de este repo git es un repo del arnés? */
function esRepoDelArnes(root, opts) { return juzgarRepo(root, opts).arnes; }
/** Cómo se LLAMA este repo según su remoto (siguiendo un `origin` local), o null si no hay remoto
 *  legible. Para nombrar cosas por el repo y no por la carpeta desde la que se trabajó. */
function nombreDeRepo(root, opts) { const j = juzgarRepo(root, opts); return j.id ? j.id.nombre : null; }

/** Lo mismo para la ruta de un ARCHIVO (que puede no existir todavía: un Write de algo nuevo).
 *  Sube hasta la primera carpeta que exista, le pregunta a git la raíz, y juzga el repo. Una ruta
 *  que no está en ningún repo git no tiene remoto que leer: decide la carpeta, como siempre. */
function juzgarRuta(filePath, opts) {
  let dir = path.resolve(String(filePath || '.'));
  for (let i = 0; i < 64; i++) {
    let st = null;
    try { st = fs.statSync(dir); } catch { st = null; }
    if (st && st.isDirectory()) break;
    const arriba = path.dirname(dir);
    if (arriba === dir) break;
    dir = arriba;
  }
  const root = git(dir, ['rev-parse', '--show-toplevel']);
  if (!root) return { arnes: porNombreDeCarpeta(filePath), por: 'carpeta', url: '', saltos: 0 };
  return juzgarRepo(root, opts);
}
function esRutaDelArnes(filePath, opts) { return juzgarRuta(filePath, opts).arnes; }

module.exports = {
  SEGMENTOS_DEL_ARNES, ENV_IDENTIDADES,
  identidadAzure, identidadRemoto, mismaIdentidad, esIdentidadDelArnes, identidadesDelArnes, declaradas, esPublicoDeclarado, deLaMaquina, resolverRemoto,
  rutaLocalDe, porNombreDeCarpeta,
  juzgarRepo, esRepoDelArnes, nombreDeRepo, juzgarRuta, esRutaDelArnes,
};

if (require.main === module) {
  const objetivo = process.argv[2] || process.cwd();
  const identidades = identidadesDelArnes().map((i) => `${i.host}/${i.ruta}`);
  const ilegibles = declaradas().ilegibles;
  // lo que declara la máquina, si declara algo o si no se pudo leer: de dónde salió una identidad, o por qué no sumó
  const m = process.env[ENV_IDENTIDADES] ? null : deLaMaquina();
  const maquina = m && (m.declared || m.problem)
    ? { declaracion_de_maquina: { clave: 'paths.maintainers', ruta: m.path, ...(m.problem ? { problema: m.problem } : { identidad: m.ids.map((i) => `${i.host}/${i.ruta}`)[0] }) } } : {};
  process.stdout.write(JSON.stringify({ objetivo, ...juzgarRuta(objetivo), identidades_del_arnes: identidades,
    ...(ilegibles.length ? { declaraciones_ilegibles: ilegibles } : {}), ...maquina }, null, 2) + '\n');
}
