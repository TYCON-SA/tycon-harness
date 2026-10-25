#!/usr/bin/env node
'use strict';
/**
 * nightly-dependencies.js — la revisión nocturna de dependencias del arnés TYCON.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * De los tres controles de seguridad del pipeline —dependencias, secretos y código—, **sólo el
 * primero pregunta AFUERA**: compara los paquetes del proyecto contra la base pública de avisos de
 * GitHub, en vivo. Los otros dos miran sólo el repo, así que el mismo código da siempre el mismo
 * resultado.
 *
 * Consecuencia: **el veredicto del primero puede cambiar sin que cambie una línea de código.**
 *
 * Ejemplo: un pipeline pasa en verde a las 15:56. A las 16:42
 * los mantenedores de `browserslist` publican un aviso de gravedad alta. Mismo código, misma
 * versión instalada, veredicto opuesto. Nadie se habría enterado hasta que a alguien se le
 * ocurriera abrir un pull request — y ese análisis SÓLO corre en los pull requests.
 *
 * ── LAS CINCO DECISIONES QUE NO SE DISCUTEN ─────────────────────────────────────────────────────
 * 1. **AVISA, NO FRENA.** El código no cambió: no hay nada que bloquear. Frenar algo que ayer
 *    estaba bien y hoy no, sin que nadie haya hecho nada, es la vía rápida a que se apague. El
 *    control del pull request sigue frenando y NO se toca.
 * 2. **REUSA EL CRITERIO QUE YA EXISTE**, no uno nuevo: llama a `scripts/ci/audit-dependencies.js`,
 *    que es el mismo guión que el análisis del pull request está llamado a usar. Un solo criterio.
 * 3. **SI NO PUDO CORRER, LO DICE.** Una tarea nocturna que falla en silencio es peor que no
 *    tenerla: se cree que hay vigilancia y no la hay. El snapshot lleva la fecha y lo INCOMPLETO se
 *    marca; `scripts/hooks/dependencies-notice.js` denuncia al arranque cuando el último es viejo.
 *    Mismo patrón que `scripts/controls-bench/periodic-exam.js`.
 * 4. **HONRA LA DEUDA DECLARADA.** Lo que está en el `vulnerabilidades-pendientes.json` del repo,
 *    vigente, no despierta a nadie. Lo que NO está declarado, sí. Una declaración VENCIDA vuelve a
 *    contar como nueva. (Lo resuelve el guión; acá sólo se respeta el veredicto.)
 * 5. **PRESUPUESTO DE RUIDO, ESCRITO** (`repos.json`). Tope de avisos por noche, y la expectativa
 *    de cuántas noches tienen que ser mudas. 🔴 El tope NO pierde hallazgos: lo que no entra queda
 *    `anunciado: false` y entra PRIMERO la noche siguiente. Sin eso, un aviso que toca cinco
 *    paquetes a la vez enterraría tres para siempre — dejarían de ser "nuevos" sin haberse
 *    anunciado nunca, que es el modo de falla más silencioso que puede tener un tope.
 *
 * ── QUÉ ES "NUEVO" ──────────────────────────────────────────────────────────────────────────────
 * Se compara contra el snapshot de la noche anterior. La huella de un hallazgo es
 * `paquete|severidad|avisos`, SIN el repo: si un aviso nuevo toca cinco repos, es UN hecho y UN
 * aviso, no cinco. Sólo las altas/críticas NO declaradas generan hallazgo; el resto queda en el
 * snapshot (que es la línea base) sin despertar a nadie.
 *
 * ── USO ─────────────────────────────────────────────────────────────────────────────────────────
 *   node nightly-dependencies.js run       [--root <dir>] [--config <f>] [--out <dir>]
 *                                           [--pending <dir>] [--json] [--dry-run] [--today <fecha>]
 *                                           [--bugs <bugs-<fecha>.json>]   (por defecto <out>/bugs-<hoy>.json)
 *                                           [--operations <operations.json>] (por defecto el de la raíz)
 *   node nightly-dependencies.js pr-text   --draft <archivo> [--destination pr|pr-github] [--pr-repo <dueño>/<repo>]
 *   node nightly-dependencies.js report    [--pending <dir>] [--json]
 *   node nightly-dependencies.js clone-list [--config <f>]   (lo que el pipeline clona, cada ruta una vez)
 *
 * Exit en `run`: 0 = MIDIÓ (aunque encuentre cosas: una vulnerabilidad no es un pipeline roto) ·
 *                1 = NO PUDO medir NINGÚN repo · 2 = error de uso.
 *   Un repo suelto que no se pudo medir NO tumba la corrida: se reporta y la noche sigue. Pero
 *   nunca se calla — "no medido" y "limpio" son cosas distintas.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const cycle = require('../findings/cycle.js');
const sources = require('../findings/sources.js');

const RAIZ_REPO = path.resolve(__dirname, '..', '..', '..');
// repos.json vive al lado de este guion, en scripts/nightly/dependencies/, y las
// fichas en inbox/dependencies/. La foto de cada noche vive en .dashboard/dependencias.
const CONFIG_DEF = path.join(RAIZ_REPO, 'scripts', 'nightly', 'dependencies', 'repos.json');
const OUT_DEF = path.join(RAIZ_REPO, '.dashboard', 'dependencias');
const PENDING_DEF = path.join(RAIZ_REPO, 'inbox', 'dependencies');
// de acá sale N, las noches medidas sin aparecer que resuelven una ficha (findings.resolve_after_nights)
const OPERATIONS_DEF = path.join(RAIZ_REPO, 'operations.json');
const GUION = path.join(RAIZ_REPO, 'scripts', 'ci', 'audit-dependencies.js');
const DIAS_PARA_IGNORADO = 7;
// el archivo de la deuda declarada de un repo (el mismo nombre que lee audit-dependencies.js por defecto)
const ARCHIVO_DEUDA = 'vulnerabilidades-pendientes.json';

// ── utilidades ─────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { cmd: argv[2] || 'help', raiz: null, config: CONFIG_DEF, out: OUT_DEF, pending: PENDING_DEF, operations: OPERATIONS_DEF,
              borrador: null, json: false, dryRun: false, hoy: null, guion: GUION,
              ficha: null, pr: null, rechazado: null, motivo: null, prCerrado: null, quitarRechazo: false, bugs: null };
  for (let i = 3; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--root') a.raiz = argv[++i];
    else if (v === '--config') a.config = path.resolve(argv[++i]);
    else if (v === '--out') a.out = path.resolve(argv[++i]);
    else if (v === '--pending') a.pending = path.resolve(argv[++i]);
    else if (v === '--operations') a.operations = path.resolve(argv[++i]);
    else if (v === '--draft') a.borrador = path.resolve(argv[++i]);
    else if (v === '--script') a.guion = path.resolve(argv[++i]);
    else if (v === '--bugs') a.bugs = path.resolve(argv[++i]);
    else if (v === '--today') a.hoy = argv[++i];
    // `note`: lo único que ESCRIBE la ficha. El guion compartido del pipeline decide
    // y delega acá — nunca hace `sed` sobre una ficha, porque el formato lo conoce esta cola.
    else if (v === '--card') a.ficha = path.resolve(argv[++i]);
    else if (v === '--pr') a.pr = argv[++i];
    else if (v === '--pr-repo') a.prRepo = argv[++i];
    else if (v === '--aligned') a.alineado = argv[++i];
    else if (v === '--destination') a.destino = argv[++i];
    else if (v === '--rejected') a.rechazado = argv[++i];
    else if (v === '--reason') a.motivo = argv[++i];
    else if (v === '--pr-closed') a.prCerrado = argv[++i];
    else if (v === '--clear-rejection') a.quitarRechazo = true;
    else if (v === '--json') a.json = true;
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--help' || v === '-h') a.cmd = 'help';
    else if (v.startsWith('--')) a.error = `opción desconocida: ${v}`;
  }
  return a;
}

const leerJson = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };
const expandir = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

/** La huella agrupa por HECHO, no por repo: un aviso que toca cinco repos es un solo hallazgo. */
function huella(paquete, severidad, advisories) {
  const base = [String(paquete).toLowerCase(), severidad, [...(advisories || [])].sort().join(',')].join('|');
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 8);
}

// ── la ficha: lectura y escritura POR SECCIÓN ──────────────────────────────────────────────────
//
// El formato vive en la pieza común del ciclo (scripts/nightly/findings/cycle.js): dependencias lo usa con
// su orden de claves y sus listas de hoy (sources.js). El porqué de cada regla está ahí.

const { reEscalar, listaDe, leerFicha, quitarClave, ponerEscalar, ponerLista, renombrarClave } = sources.FUENTES.dependencias.formato;

const soloRepo = (linea) => String(linea).replace(/\s*\(vence[^)]*\)\s*$/, '').trim();

const diasEntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// ── identidad de una entrada ───────────────────────────────────────────────────────────────────
// 🔴 Una entrada puede ser una SUBCARPETA de un repo (`subruta`): el gateway de
// mensajería de Acme vive en `Acme/BackEnd/tools/chat-gateway`, es Node, tiene su propio
// lockfile y corre en producción. Con dos entradas que comparten `ruta` —la raíz y la subcarpeta— la
// etiqueta `producto/basename(ruta)` colisionaría: los hallazgos del gateway se mezclarían con los del
// plugin y un borrador abierto de uno taparía al otro. La etiqueta suma la subruta SÓLO cuando la
// hay: la de las entradas que ya existen no cambia (si cambiara, la noche siguiente todo parecería
// nuevo y se comería el presupuesto de ruido).
const etiqueta = (r) => `${r.producto}/${path.basename(r.ruta)}${r.subruta ? `/${r.subruta}` : ''}`;
const rutaCompleta = (r) => (r.subruta ? `${r.ruta}/${r.subruta}` : r.ruta);

/**
 * Dónde está REALMENTE el repo de una entrada en esta máquina.
 *
 * 🔴 `ruta` no es el nombre de la carpeta: es la ETIQUETA. En Azure da igual —el
 * pipeline clona en `<raiz>/<ruta>`, así que la carpeta existe por construcción—, pero en la
 * máquina de un dev cada uno clonó con el nombre que quiso, y varias entradas NO coinciden:
 * `Acme/FrontEnd` está en `Acme/AcmeFrontEnd`, `Globex/GlobexPluginfrontend`
 * en `Globex/GlobexFrontend`. Sin esto, esos repos saldrían NO MEDIDO con «el repo no está en …», que
 * es verdad pero inútil: el repo está, con otro nombre.
 *
 * NO se arregla renombrando `ruta`: la etiqueta de una entrada es `producto/basename(ruta)`, las
 * fichas abiertas nombran a sus repos con ella, y cambiarla haría ver todo como novedad la noche
 * siguiente —comiéndose el presupuesto de ruido— además de romper las fichas vivas. Tampoco se
 * arregla anotando la carpeta de alguien: la carpeta de una máquina no es un dato compartible.
 *
 * Se resuelve por IDENTIDAD: si `<raiz>/<ruta>` no está, se busca entre los vecinos un repo git
 * cuyo `origin` apunte al MISMO repo de Azure que declara `ado`. El remoto es la identidad; el
 * nombre de la carpeta es una preferencia. Sin `ado` no se busca nada: sin identidad, adivinar
 * por parecido de nombre es exactamente cómo se termina auditando el repo equivocado.
 */
function ubicarRepo(entrada, raiz) {
  const directo = path.join(raiz, entrada.ruta);
  if (fs.existsSync(directo)) return { dir: directo };
  if (!entrada.ado && entrada.github) return ubicarRepoDeGithub(entrada, raiz, directo);
  if (!entrada.ado) return { dir: directo };

  const clave = (proj, repo) => `${decodeURIComponent(proj)}/${decodeURIComponent(repo)}`.toLowerCase();
  const partes = String(entrada.ado).split('/');
  if (partes.length < 2) return { dir: directo };
  const buscada = clave(partes[0], partes[partes.length - 1]);

  // Sólo donde razonablemente puede estar: al lado de donde decía `ruta`, y un nivel arriba.
  const candidatos = [];
  for (const base of [path.dirname(directo), raiz]) {
    let hijos = [];
    try { hijos = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { continue; }
    for (const h of hijos) if (h.isDirectory()) candidatos.push(path.join(base, h.name));
  }

  for (const c of candidatos) {
    const r = spawnSync('git', ['-C', c, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) continue;
    // Las dos formas del mismo servidor: .../<proyecto>/_git/<repo> — con o sin _apis, con
    // dev.azure.com o con visualstudio.com, con credenciales adelante o sin ellas.
    const m = String(r.stdout || '').trim().match(/\/([^/]+)\/_git\/([^/\s]+?)(?:\.git)?$/);
    if (m && clave(m[1], m[2]) === buscada) return { dir: c, reubicado: true };
  }
  return { dir: directo };
}

/** Lo mismo para una entrada de GitHub: el remoto `github.com[:/]<dueño>/<repo>(.git)` es la identidad. */
function ubicarRepoDeGithub(entrada, raiz, directo) {
  const buscada = String(entrada.github).toLowerCase();
  if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(buscada)) return { dir: directo };
  const candidatos = [];
  for (const base of [path.dirname(directo), raiz]) {
    let hijos = [];
    try { hijos = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { continue; }
    for (const h of hijos) if (h.isDirectory()) candidatos.push(path.join(base, h.name));
  }
  for (const c of candidatos) {
    const r = spawnSync('git', ['-C', c, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) continue;
    const m = String(r.stdout || '').trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
    if (m && `${m[1]}/${m[2]}`.toLowerCase() === buscada) return { dir: c, reubicado: true };
  }
  return { dir: directo };
}

// ── la corrida ─────────────────────────────────────────────────────────────────────────────────

function auditarRepo(entrada, raiz, guion, hoy) {
  const p = prepararPublicado(entrada, raiz);
  if (!p.pub) return { ...p.base, medido: false, motivo_no_medido: p.motivo };
  try {
    return auditarEn(p.base, p.pub, entrada, guion, hoy);
  } finally {
    p.pub.limpiar();
  }
}

/** La parte común de una entrada medida: producto, ruta, tipo y su subruta si la tiene. */
function baseDe(entrada) {
  const base = { producto: entrada.producto, ruta: entrada.ruta, tipo: entrada.tipo };
  if (entrada.subruta) base.subruta = entrada.subruta;
  return base;
}

/** Ubica el repo de una entrada y prepara lo publicado. Devuelve `{ base, pub }` o `{ base, motivo }` (no medido). */
function prepararPublicado(entrada, raiz) {
  const ubic = ubicarRepo(entrada, raiz);
  const dir = ubic.dir;
  const base = baseDe(entrada);
  // 🔴 Si el repo no estaba donde decía `ruta`, el informe lo dice: un número medido en otra
  // carpeta que la declarada no puede parecer medido en la declarada.
  if (ubic.reubicado) base.carpeta_real = dir;
  if (!fs.existsSync(dir)) {
    // 🔴 Un repo que no está en la máquina NO se lee como "coincide" ni como "limpio": se cuenta
    // aparte y se dice. Misma regla que check-product-parity.js.
    return { base, motivo: `el repo no está en ${dir}` };
  }
  // 🔴 SE AUDITA LO PUBLICADO, NO LA RAMA QUE QUEDÓ EN EL DISCO.
  //
  // Este nocturno promete mirar `main` —es lo que corre en producción—; auditar el árbol de
  // trabajo miraría la rama en la que quedó el checkout de cada repo. En las máquinas del equipo eso
  // suele ser `dev`: se reportarían vulnerabilidades que producción no tiene, o peor, se PERDERÍAN
  // las que sí.
  //
  // Se resuelve con un árbol de trabajo TEMPORAL parado en `origin/main`, que se borra al terminar.
  // No se toca el checkout del dev: un árbol aparte no cambia la rama en la que está trabajando.
  //
  // 🔴 SI NO SE PUDO PREPARAR ESE ÁRBOL, ES "NO MEDIDO" — nunca "limpio". Un repo sin remoto, sin
  // `origin/main`, o que no es un repo git, no se audita desde el disco "por las dudas": eso sería
  // auditar la rama equivocada, y en silencio.
  const pub = arbolPublicado(dir);
  if (!pub.ok) return { base, motivo: `no se pudo preparar lo publicado (origin/main): ${pub.motivo}` };
  return { base: { ...base, ...datosDeLoPublicado(pub) }, pub };
}

function datosDeLoPublicado(pub) {
  // trajo_lo_ultimo: false = se auditó el origin/main que había en el disco
  return { rama_auditada: 'origin/main', commit_auditado: pub.commit, es_lo_publicado: true, trajo_lo_ultimo: pub.fetch };
}

/** Audita una entrada adentro de un árbol publicado ya preparado (la raíz o su `subruta`). */
function auditarEn(base, pub, entrada, guion, hoy) {
  // 🔴 SUBCARPETA: el árbol se prepara desde la RAÍZ (`ruta`) y lo que se audita es
  // `subruta` adentro de ese árbol. Si la subcarpeta no está en lo publicado, es NO MEDIDO con el
  // motivo — nunca "limpio", y nunca la raíz por consuelo: eso sería un número de otra cosa con
  // la etiqueta del gateway, que es exactamente la mentira que este campo evita.
  let dirAuditado = pub.dir;
  if (entrada.subruta) {
    const sub = path.resolve(pub.dir, entrada.subruta);
    if (!(sub + path.sep).startsWith(pub.dir + path.sep)) {
      return { ...base, medido: false, motivo_no_medido: `la subruta "${entrada.subruta}" sale del repo: no se audita` };
    }
    let esCarpeta = false;
    try { esCarpeta = fs.statSync(sub).isDirectory(); } catch (_) { esCarpeta = false; }
    if (!esCarpeta) {
      return { ...base, medido: false, motivo_no_medido: `la subruta "${entrada.subruta}" no existe en origin/main (${pub.commit.slice(0, 8)}) — no se audita la raíz en su lugar` };
    }
    dirAuditado = sub;
  }
  // 🔴 UN FORMULARIO DESCUBIERTO HEREDA LA DEUDA DEL REPO. La deuda se declara una vez, en la raíz, para todo el repo:
  // sin heredarla, el primer día que la noche mira cada formulario, todo lo declarado vuelve a aparecer «sin declarar»
  // en cada uno —y las fichas archivadas por esa deuda se reactivan solas. Si el formulario declara la suya, manda.
  let declaradaEn = null;
  if (entrada.heredaDeuda && dirAuditado !== pub.dir) {
    const propia = path.join(dirAuditado, ARCHIVO_DEUDA);
    const deLaRaiz = path.join(pub.dir, ARCHIVO_DEUDA);
    if (!fs.existsSync(propia) && fs.existsSync(deLaRaiz)) declaradaEn = path.relative(dirAuditado, deLaRaiz);
  }
  return auditarArbol({ ...base, dirAuditado, declaradaEn }, entrada, guion, hoy);
}

// ── cada formulario ────────────────────────────────────────────────────────────────────────────
//
// Un repo de formularios tiene un `package-lock.json` POR FORMULARIO. Mirar sólo el de la raíz deja afuera
// una alta en un formulario, y el resumen dice «nada esperando decisión» mientras el análisis de un pull
// request la encuentra. Declarar cada formulario en repos.json no alcanza: el día que nace uno nuevo nadie
// se acuerda, y queda afuera sin que nada lo diga. La lista sale del repo publicado.
//
// Se descubre sólo en un repo cuya RAÍZ está declarada como npm: un repo que sólo declara subcarpetas
// puede tener la raíz de otro tipo (un backend nuget), y una raíz npm descubierta chocaría con su etiqueta.

/** `path` de una exclusión o de una subruta, comparable: sin `./` adelante ni `/` al final. */
const carpetaNormal = (c) => String(c || '').trim().replace(/^\.\/+/, '').replace(/\/+$/, '');

/** Lo que está mal en las `exclude` de repos.json: cada una necesita `path` y `reason`. Lista vacía = bien. */
function problemasDeExclusiones(cfg) {
  const P = [];
  for (const r of (cfg && cfg.repos) || []) {
    if (r.exclude === undefined) continue;
    const et = etiqueta(r);
    if (!Array.isArray(r.exclude)) { P.push(`${et}: "exclude" tiene que ser una lista de { "path", "reason" }`); continue; }
    r.exclude.forEach((x, i) => {
      const ruta = x && typeof x.path === 'string' ? carpetaNormal(x.path) : '';
      const motivo = x && typeof x.reason === 'string' ? x.reason.trim() : '';
      if (!ruta) P.push(`${et}: exclude[${i}] sin "path"`);
      else if (!motivo) P.push(`${et}: exclude[${i}] ("${ruta}") sin "reason" — una carpeta no se deja de mirar sin decir por qué`);
    });
  }
  return P;
}

/**
 * Las carpetas con `package-lock.json` en un commit, fuera de `node_modules` ('' es la raíz). `raras` son las que
 * tienen un carácter de control en el nombre: git lo permite, y escrita en una ficha una carpeta con un salto de línea
 * agregaría claves. No se auditan: salen NO MEDIDO.
 */
function carpetasConLockfile(dir, commit) {
  const r = spawnSync('git', ['-C', dir, 'ls-tree', '-r', '-z', '--name-only', commit], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  if (r.status !== 0) return { ok: false, motivo: `git ls-tree falló: ${(r.stderr || (r.error && r.error.message) || '').trim().slice(0, 200)}` };
  const todas = [...new Set(String(r.stdout || '').split('\0').filter(Boolean)
    .filter((f) => path.posix.basename(f) === 'package-lock.json' && !f.split('/').includes('node_modules'))
    .map((f) => (path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f))))].sort();
  const rara = (c) => /[\x00-\x1f\x7f]/.test(c);
  return { ok: true, carpetas: todas.filter((c) => !rara(c)), raras: todas.filter(rara) };
}

/**
 * Un repo con la raíz npm: la raíz, sus subcarpetas declaradas y cada carpeta con lockfile que el repo
 * publicado trae, en UN árbol temporal. Devuelve `{ resultados, carpetas }`; `carpetas` es la cuenta del
 * resumen: `{ repo, miradas, total, excluidas, sin_efecto }` (`total: null` = no se pudo contar). Una subcarpeta
 * apagada a propósito (`activo: false`) no vuelve por el descubrimiento: no se audita ni se cuenta.
 */
function auditarRepoConFormularios(entrada, declaradas, apagadas, raiz, guion, hoy) {
  const pedidas = (entrada.exclude || []).map((x) => ({ path: carpetaNormal(x.path), reason: String(x.reason).trim() }));
  const cuenta = { repo: etiqueta(entrada), miradas: 0, total: null, excluidas: [], sin_efecto: [] };
  const p = prepararPublicado(entrada, raiz);
  if (!p.pub) {
    const resultados = [entrada, ...declaradas].map((e) => ({ ...baseDe(e), ...(p.base.carpeta_real ? { carpeta_real: p.base.carpeta_real } : {}), medido: false, motivo_no_medido: p.motivo }));
    return { resultados, carpetas: cuenta };
  }
  try {
    const comun = datosDeLoPublicado(p.pub);
    if (p.base.carpeta_real) comun.carpeta_real = p.base.carpeta_real;
    const en = (e) => auditarEn({ ...baseDe(e), ...comun }, p.pub, e, guion, hoy);
    const resultados = [en(entrada), ...declaradas.map(en)];
    const lista = carpetasConLockfile(p.pub.dir, p.pub.commit);
    if (!lista.ok) {
      // 🔴 No poder listar no es «no hay formularios»: se dice, con la raíz medida igual.
      resultados.push({ ...baseDe(entrada), ...comun, subruta: '*', medido: false, motivo_no_medido: `no se pudieron listar los lockfiles de los formularios: ${lista.motivo}` });
      return { resultados, carpetas: cuenta };
    }
    const declaradasPorCarpeta = new Map(declaradas.map((e, i) => [carpetaNormal(e.subruta), resultados[i + 1]]));
    const apagadasSet = new Set(apagadas.map((e) => carpetaNormal(e.subruta)));
    // 🔴 Una exclusión se cuenta como tal sólo si se aplicó: sobre una carpeta sin lockfile, o declarada como entrada
    // (que se mira igual), no tuvo efecto y se dice. Si no, el informe diría «excluida» de algo que se auditó.
    const conLockfile = new Set(lista.carpetas);
    for (const x of pedidas) {
      if (declaradasPorCarpeta.has(x.path) || x.path === '') cuenta.sin_efecto.push({ ...x, motivo: 'la carpeta es una entrada declarada: se mira igual' });
      else if (!conLockfile.has(x.path)) cuenta.sin_efecto.push({ ...x, motivo: 'no hay package-lock.json en esa carpeta' });
      else cuenta.excluidas.push(x);
    }
    const fuera = new Set(cuenta.excluidas.map((x) => x.path));
    const miradas = [];
    for (const c of lista.raras) {
      const r = { ...baseDe(entrada), ...comun, subruta: JSON.stringify(c).slice(1, -1), medido: false,
        motivo_no_medido: 'el nombre de la carpeta tiene caracteres de control: no se audita (escrito en una ficha agregaría líneas)' };
      resultados.push(r);
      miradas.push(r);
    }
    for (const c of lista.carpetas) {
      if (c === '') { miradas.push(resultados[0]); continue; }
      if (declaradasPorCarpeta.has(c)) { miradas.push(declaradasPorCarpeta.get(c)); continue; }
      if (fuera.has(c) || apagadasSet.has(c)) continue;
      // La carpeta nace de la entrada de la raíz: mismo producto y proyecto (ado/github). `proyecto` es la opción de
      // nuget y pip, y `exclude` es de la raíz: no se heredan.
      const { proyecto, exclude, ...resto } = entrada;
      const r = en({ ...resto, subruta: c, heredaDeuda: true });
      r.descubierta = true;
      resultados.push(r);
      miradas.push(r);
    }
    cuenta.total = miradas.length;
    cuenta.miradas = miradas.filter((r) => r.medido).length;
    return { resultados, carpetas: cuenta };
  } finally {
    p.pub.limpiar();
  }
}

/** Todas las entradas activas: las raíces npm descubren sus formularios; el resto, como siempre. */
function auditarTodo(todas, raiz, guion, hoy) {
  const activos = todas.filter((r) => r.activo !== false);
  const esRaizNpm = (e) => e.tipo === 'npm' && !e.subruta;
  const rutasDescubiertas = new Set(activos.filter(esRaizNpm).map((e) => e.ruta));
  const repos = [];
  const carpetas = [];
  for (const e of activos) {
    if (esRaizNpm(e)) {
      const subDe = (x) => x !== e && x.ruta === e.ruta && x.tipo === 'npm' && x.subruta;
      const declaradas = activos.filter(subDe);
      const apagadas = todas.filter((x) => subDe(x) && x.activo === false);
      const r = auditarRepoConFormularios(e, declaradas, apagadas, raiz, guion, hoy);
      repos.push(...r.resultados);
      carpetas.push(r.carpetas);
    } else if (!(rutasDescubiertas.has(e.ruta) && e.tipo === 'npm')) {
      repos.push(auditarRepo(e, raiz, guion, hoy));
    }
  }
  return { repos, carpetas };
}

/**
 * Un árbol de trabajo temporal parado en `origin/main`, para auditar lo PUBLICADO.
 * Devuelve { ok, dir, commit, fetch, limpiar } o { ok:false, motivo }.
 * El `fetch` es de mejor esfuerzo: si no hay red se audita el `origin/main` que haya en el disco,
 * y eso queda DICHO en el informe — "no pude traer lo último" y "lo traje" no son lo mismo.
 */
function arbolPublicado(dir) {
  const git = (args, opts = {}) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 120000, ...opts });
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) return { ok: false, motivo: 'no es un repo git' };
  // 🔴 `git -C <subcarpeta>` resuelve la raíz del repo desde cualquier subcarpeta, y el árbol
  // temporal se arma desde esa raíz. Una `ruta` que apunta adentro de un repo
  // NO falla: audita la raíz y rotula el resultado con el nombre de la subcarpeta — un número
  // equivocado con la etiqueta correcta. Una subcarpeta se declara con `ruta` (la raíz) + `subruta`.
  const raizReal = (git(['rev-parse', '--show-toplevel']).stdout || '').trim();
  let esRaiz = false;
  try { esRaiz = !!raizReal && fs.realpathSync(raizReal) === fs.realpathSync(dir); } catch (_) { esRaiz = false; }
  if (!esRaiz) {
    return { ok: false, motivo: `"${dir}" es una SUBCARPETA del repo cuya raíz es ${raizReal || '?'}: se auditaría la raíz con esta etiqueta. Declarala con "ruta" en la raíz y "subruta" con la subcarpeta` };
  }
  const fetch = git(['fetch', '--quiet', 'origin', 'main']).status === 0;
  const commit = (git(['rev-parse', 'origin/main']).stdout || '').trim();
  if (!commit) return { ok: false, motivo: 'no tiene origin/main' };
  const destino = path.join(os.tmpdir(), `nocturno-deps-${path.basename(dir)}-${process.pid}-${Date.now()}`);
  const add = git(['worktree', 'add', '--detach', '--quiet', destino, commit]);
  if (add.status !== 0) return { ok: false, motivo: `git worktree add falló: ${(add.stderr || '').trim().slice(0, 200)}` };
  const limpiar = () => {
    try { git(['worktree', 'remove', '--force', destino]); } catch (_) { /* se intenta igual la poda */ }
    try { fs.rmSync(destino, { recursive: true, force: true }); } catch (_) { /* ya no está */ }
    try { git(['worktree', 'prune']); } catch (_) { /* nada que podar */ }
  };
  return { ok: true, dir: destino, commit, fetch, limpiar };
}

function auditarArbol(base, entrada, guion, hoy) {
  const dir = base.dirAuditado;
  const args = [guion, '--repo', dir, '--type', entrada.tipo, '--json'];
  if (entrada.proyecto) args.push('--project', entrada.proyecto);
  if (base.declaradaEn) args.push('--declared', base.declaradaEn);
  delete base.declaradaEn;
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TYCON_DEP_TODAY: hoy },
  });
  if (r.error) { delete base.dirAuditado; return { ...base, medido: false, motivo_no_medido: `no se pudo ejecutar el guión: ${r.error.message}` }; }
  let inf;
  try { inf = JSON.parse(r.stdout); }
  catch { delete base.dirAuditado; return { ...base, medido: false, motivo_no_medido: `el guión no devolvió JSON legible (exit ${r.status}): ${(r.stderr || '').slice(0, 200)}` }; }
  if (!inf.medido) { delete base.dirAuditado; return { ...base, medido: false, motivo_no_medido: inf.motivo_no_medido }; }

  const graves = (inf.hallazgos || []).filter((h) => ['high', 'critical'].includes(h.severidad));
  delete base.dirAuditado;
  return {
    ...base, medido: true, resumen: inf.resumen,
    declaracion: inf.declaracion,
    graves: graves.map((h) => ({ paquete: h.paquete, severidad: h.severidad, advisories: h.advisories, declarada: h.declarada,
      ...(h.gravedad_sin_dato ? { gravedad_sin_dato: true } : {}) })),
    no_declaradas: inf.no_declaradas || [],
  };
}

/** Agrupa las altas/críticas NO declaradas de todos los repos en hallazgos por HECHO. */
function agruparHallazgos(repos) {
  const m = new Map();
  for (const r of repos) {
    if (!r.medido) continue;
    for (const g of r.graves || []) {
      if (g.declarada) continue;                 // lo declarado no despierta a nadie
      const id = huella(g.paquete, g.severidad, g.advisories);
      if (!m.has(id)) m.set(id, { id, paquete: g.paquete, severidad: g.severidad, advisories: g.advisories, repos: [], sinDato: [] });
      m.get(id).repos.push(etiqueta(r));
      m.get(id).sinDato.push(!!g.gravedad_sin_dato);
    }
  }
  const orden = { critical: 2, high: 1 };
  // «alta por falta de dato» sólo si ningún repo informó la gravedad: con uno que la informa, el dato existe
  return [...m.values()]
    .map(({ sinDato, ...h }) => ({ ...h, repos: [...new Set(h.repos)].sort(), ...(sinDato.every(Boolean) ? { gravedad_sin_dato: true } : {}) }))
    .sort((a, b) => (orden[b.severidad] - orden[a.severidad]) || (b.repos.length - a.repos.length) || a.paquete.localeCompare(b.paquete));
}

/**
 * La PRESENCIA de cada hecho en cada repo — declarada o no.
 *
 * `agruparHallazgos` descarta lo declarado ANTES de comparar, y eso es correcto para decidir a
 * quién se DESPIERTA. Pero usar esa misma lista para decidir si una ficha se RESOLVIÓ hace que el
 * id declarado desaparezca de `hallazgos` y se lea como "ya no
 * está", o sea que declarar una deuda salga como haberla pagado. Declarar no es pagar.
 */
function agruparPresencias(repos) {
  const m = new Map();
  for (const r of repos) {
    if (!r.medido) continue;
    const vence = (r.declaracion && r.declaracion.vence) || null;
    for (const g of r.graves || []) {
      const id = huella(g.paquete, g.severidad, g.advisories);
      if (!m.has(id)) m.set(id, { id, paquete: g.paquete, severidad: g.severidad, advisories: g.advisories, repos: [] });
      const en = m.get(id).repos;
      if (!en.some((x) => x.repo === etiqueta(r))) {
        en.push({ repo: etiqueta(r), declarada: !!g.declarada, vence: g.declarada ? vence : null });
      }
    }
  }
  return [...m.values()]
    .map((p) => ({ ...p, repos: p.repos.sort((a, b) => a.repo.localeCompare(b.repo)) }))
    .sort((a, b) => a.paquete.localeCompare(b.paquete) || a.id.localeCompare(b.id));
}

/**
 * El PROYECTO de Azure DevOps al que pertenece un repo, por su etiqueta.
 *
 * Es lo que decide si dos hallazgos del mismo paquete son la misma ficha (por ejemplo,
 * `js-yaml` en Globex y en Acme son dos fichas porque el pedido de trabajo es uno por
 * proyecto). La reusa work-items.js — por eso va en `module.exports`.
 */
/**
 * La entrada de repos.json de una etiqueta. Una carpeta descubierta no está en la lista: es de la
 * entrada npm de la raíz de su repo, y su proyecto es ése. Sin esto, sus pedidos irían a un proyecto inventado.
 */
function entradaDe(etiquetaRepo, cfg) {
  const repos = (cfg && cfg.repos) || [];
  return repos.find((r) => etiqueta(r) === etiquetaRepo)
    || repos.find((r) => r.tipo === 'npm' && !r.subruta && String(etiquetaRepo).startsWith(`${etiqueta(r)}/`));
}

function proyectoDe(etiquetaRepo, cfg) {
  const e = entradaDe(etiquetaRepo, cfg);
  // En GitHub el «proyecto» es el repo (`github: <dueño>/<repo>`): un issue vive en un repo, como un Bug en
  // su proyecto. Una ficha de GitHub es (paquete, repo).
  if (e && !e.ado && e.github) return String(e.github);
  const crudo = e && e.ado ? String(e.ado).split('/')[0]
    : e && e.producto ? String(e.producto)
    : String(etiquetaRepo).split('/')[0];
  try { return decodeURIComponent(crudo); } catch { return crudo; }
}

/**
 * El proyecto de Azure DevOps de un repo SÓLO si la config lo declara (`ado`); si no, `null`.
 *
 * `proyectoDe` cae en el `producto` cuando la etiqueta no está en `repos.json`, y para decidir si dos
 * hallazgos son la misma ficha eso sirve. Para PEDIRLE algo a Azure no: el producto no es el proyecto
 * (Acme → «Acme Web», Globex → GlobexCore), y un repo que salió de la config generaría un pedido a un
 * proyecto inexistente que fallaría todas las noches.
 */
function proyectoAzureDe(etiquetaRepo, cfg) {
  const e = entradaDe(etiquetaRepo, cfg);
  // El lugar al que se le PIDE, también en GitHub (el repo `<dueño>/<repo>`, donde se abre el issue). El
  // nombre se conserva: lo usan los guiones de pedidos de las dos plataformas, y cada uno rechaza la entrada ajena.
  if (e && !e.ado && e.github) return String(e.github);
  if (!e || !e.ado) return null;
  const crudo = String(e.ado).split('/')[0];
  try { return decodeURIComponent(crudo); } catch { return crudo; }
}

/**
 * El snapshot completo más reciente ANTERIOR a `hoy`. Si no hay, la corrida es la línea base.
 * Con `{ completa: false }`, el más reciente aunque haya quedado incompleto: sirve para saber qué carpetas ya
 * se vieron, no para comparar hallazgos.
 */
function snapshotAnterior(outDir, hoy, { completa = true } = {}) {
  if (!fs.existsSync(outDir)) return null;
  const files = fs.readdirSync(outDir)
    .filter((f) => /^dependencias-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .filter((f) => f.slice('dependencias-'.length, -'.json'.length) < hoy)
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const j = leerJson(path.join(outDir, files[i]), null);
    // 🔴 Sólo una corrida COMPLETA sirve de línea base. Comparar contra una noche que sólo pudo
    // mirar 2 de los repos declarados haría ver el resto como "novedad" y abriría un aluvión de avisos.
    if (j && (j.corrida_completa || !completa)) return j;
  }
  return null;
}

function correr(a) {
  const cfg = leerJson(a.config, null);
  if (!cfg) { console.error(`error: no se pudo leer la configuración ${a.config}`); return 2; }
  const malas = problemasDeExclusiones(cfg);
  if (malas.length) {
    for (const m of malas) console.error(`error: ${a.config}: ${m}`);
    return 2;
  }
  const hoy = a.hoy || new Date().toISOString().slice(0, 10);
  // las decisiones confirmadas en el sitio que otra persona aprobó, antes de mirar las fichas; a la
  // salida de error, para no romper la de --json
  if (!a.dryRun) for (const l of cycle.aplicarDecisiones({ fuente: 'dependencias', dir: a.pending }).lineas) console.error(l);
  const raiz = expandir(a.raiz || cfg.raiz_por_defecto || '~/SourceCode');
  const pres = cfg.presupuesto_de_ruido || {};
  const tope = Number.isInteger(pres.tope_pr_por_noche) ? pres.tope_pr_por_noche : 2;

  const activos = (cfg.repos || []).filter((r) => r.activo !== false);
  const apagados = (cfg.repos || []).filter((r) => r.activo === false).map(rutaCompleta);
  // Las MISMAS etiquetas que usa una ficha para nombrar sus repos: `repos_apagados` guarda la
  // ruta (su forma no cambia), pero la ficha dice `producto/repo`, y hay que comparar eso.
  const apagadosEtiq = new Set((cfg.repos || []).filter((r) => r.activo === false).map(etiqueta));

  const { repos, carpetas } = auditarTodo(cfg.repos || [], raiz, a.guion, hoy);
  const medidos = repos.filter((r) => r.medido);
  const noMedidos = repos.filter((r) => !r.medido);
  // "Completa" quiere decir que se pudo mirar TODO lo activo. Una corrida a medias sigue siendo
  // útil para avisar, pero NO puede convertirse en la línea base de mañana.
  const completa = noMedidos.length === 0 && activos.length > 0;

  const previo = snapshotAnterior(a.out, hoy);
  const vigentesPrevios = new Map((previo ? previo.hallazgos || [] : []).map((h) => [h.id, h]));

  const detectados = agruparHallazgos(repos);
  const hallazgos = detectados.map((h) => {
    const p = vigentesPrevios.get(h.id);
    return {
      ...h,
      primera_noche: p ? p.primera_noche : hoy,
      noches: p ? (p.noches || 1) + 1 : 1,
      anunciado: p ? !!p.anunciado : false,
      // Sin snapshot previo COMPLETO no hay con qué comparar: la primera corrida es la LÍNEA BASE
      // y no anuncia nada. Decirlo es la diferencia entre "no había nada" y "no sabía".
      nuevo: !!previo && !p,
    };
  });

  // A anunciar: lo detectado que todavía no se anunció. Los que el tope postergó anoche entran
  // PRIMERO hoy (llevan más noches encima) — por eso el orden es por noches y después gravedad.
  // 🔴 LA PRIMERA NOCHE DE UNA CARPETA DESCUBIERTA NO ES NOVEDAD. Encender decenas de formularios de golpe
  // traería semanas de altas viejas por el tope de ruido. Las altas que
  // sólo aparecen en carpetas nuevas no se anuncian esa noche: el resumen dice cuántas hay por repo y quedan sin
  // anunciar, así que la noche siguiente entran con el tope y primero (ya suman noches). Una crítica no espera.
  // Las carpetas ya vistas salen de la última noche aunque haya quedado incompleta: con un formulario que nunca se
  // puede auditar, ninguna noche es completa, y las altas de los demás formularios nuevos esperarían para siempre.
  const ultima = previo ? (snapshotAnterior(a.out, hoy, { completa: false }) || previo) : null;
  const vistasAntes = new Set(ultima ? [...(previo.repos || []), ...(ultima.repos || [])].map(etiqueta) : []);
  const nuevas = new Set(previo ? repos.filter((r) => r.descubierta && !vistasAntes.has(etiqueta(r))).map(etiqueta) : []);
  const enEspera = new Set(hallazgos
    .filter((h) => h.nuevo && h.severidad !== 'critical' && h.repos.every((r) => nuevas.has(r)))
    .map((h) => h.id));
  for (const c of carpetas) {
    const suyas = new Set([...nuevas].filter((et) => et.startsWith(`${c.repo}/`)));
    c.nuevas = suyas.size;
    c.altas_nuevas = hallazgos.filter((h) => h.repos.some((r) => suyas.has(r))).length;
  }

  const orden = { critical: 2, high: 1 };
  const pendientesDeAnuncio = hallazgos
    .filter((h) => !h.anunciado && !enEspera.has(h.id))
    .sort((x, y) => (y.noches - x.noches) || (orden[y.severidad] - orden[x.severidad]) || (y.repos.length - x.repos.length));

  // 🔴 ANTES DE CREAR NADA se busca en las tres carpetas: un hecho no puede tener dos fichas.
  // Un id nuevo del mismo paquete en el mismo proyecto se ANEXA a la ficha que ya está (y no
  // consume el tope de ruido: no es una novedad para nadie, es el mismo problema con otro aviso).
  // Una ficha CERRADA que vuelve se REACTIVA (eso sí es novedad, y sí consume tope).
  const anexados = [];
  const reaparecidos = [];
  const candidatos = [];
  if (!a.dryRun) {
    const fichas = leerTodasLasFichas(a.pending);
    for (const h of pendientesDeAnuncio) {
      const f = fichaDe(fichas, h, cfg);
      if (f && f.viva) {
        // 🔴 La antigüedad se calcula ANTES de anexar: anexar refresca `f.ids` desde el disco, y con
        // el id nuevo ya adentro la ficha se creería recién nacida (`noche 1`) cada vez que le
        // cambia el identificador — justo lo que este anexo existe para evitar.
        const idsPrevios = f.ids.filter((i) => i !== h.id);
        // Si algún id de la ficha TAMBIÉN aparece hoy, ése ya trae la cuenta al día y se copia. Si
        // ninguno aparece (el aviso nuevo reemplazó al viejo), se cuenta una noche más sobre la de
        // anoche — si no, la ficha volvería a "noche 1" cada vez que le cambian el identificador.
        const hoyDeLaFicha = idsPrevios.map((i) => hallazgos.find((x) => x.id === i)).filter(Boolean);
        const previosDeLaFicha = idsPrevios.map((i) => vigentesPrevios.get(i)).filter(Boolean);
        anexarAFicha(f, h);
        h.anunciado = true;
        h.ficha = f.idFicha;
        if (hoyDeLaFicha.length) {
          h.primera_noche = hoyDeLaFicha.map((x) => x.primera_noche).sort()[0];
          h.noches = Math.max(h.noches, ...hoyDeLaFicha.map((x) => x.noches || 1));
        } else if (previosDeLaFicha.length) {
          h.primera_noche = previosDeLaFicha.map((x) => x.primera_noche).sort()[0];
          h.noches = Math.max(h.noches, ...previosDeLaFicha.map((x) => (x.noches || 1) + 1));
        }
        anexados.push({ id: h.id, ficha: f.idFicha });
        continue;
      }
      // 🔴 Tampoco dos fichas NUEVAS del mismo hecho en la misma noche: `fichaDe` sólo conoce las fichas de antes de
      // esta corrida. Un segundo aviso del mismo paquete en el mismo proyecto se suma al primero, que es el que se
      // escribe (con los dos ids y los avisos de los dos) y el que ocupa el cupo.
      if (!f) {
        const proyectos = new Set(h.repos.map((r) => proyectoDe(r, cfg)));
        const mismo = candidatos.find((x) => !x.ficha
          && String(x.h.paquete).toLowerCase() === String(h.paquete).toLowerCase()
          && x.h.repos.some((r) => proyectos.has(proyectoDe(r, cfg))));
        if (mismo) {
          // la unión va aparte: el hallazgo de la foto queda como se midió (su id es la huella de sus avisos)
          mismo.h.idsJuntos = [...new Set([...(mismo.h.idsJuntos || [mismo.h.id]), h.id])];
          mismo.h.avisosJuntos = [...new Set([...(mismo.h.avisosJuntos || mismo.h.advisories || []), ...(h.advisories || [])])].sort();
          mismo.h.reposJuntos = [...new Set([...(mismo.h.reposJuntos || mismo.h.repos), ...h.repos])].sort();
          h.anunciado = true;
          h.ficha = mismo.h.id;
          anexados.push({ id: h.id, ficha: mismo.h.id });
          continue;
        }
      }
      candidatos.push({ h, ficha: f || null });
    }
  } else {
    for (const h of pendientesDeAnuncio) candidatos.push({ h, ficha: null });
  }

  // El tope se reparte DESPUÉS de descontar los anexos: si no, un aviso nuevo sobre un problema ya
  // anunciado le comería el turno a un hallazgo que nadie vio todavía.
  // 🔴 Una CRÍTICA no espera turno: no consume el tope y se anuncia la
  // misma noche. Con el orden «más noches primero», una crítica recién aparecida quedaría detrás de altas
  // viejas y podría esperar varias noches. El tope existe para no aturdir con altas.
  const conCupo = candidatos.filter((x) => x.h.severidad !== 'critical');
  const elegidos = previo ? [...candidatos.filter((x) => x.h.severidad === 'critical'), ...conCupo.slice(0, tope)] : [];
  const postergados = (previo ? conCupo.slice(tope) : candidatos).map((x) => x.h);
  const aAnunciar = elegidos.map((x) => x.h);
  for (const x of elegidos) {
    x.h.anunciado = true;
    if (!x.ficha) continue;
    // Cerrada que vuelve: se reactiva ESA, y lo que se anuncia es el id de la FICHA (el pipeline
    // busca `pending/<id>.yaml` para abrirle el pull request).
    reactivarFicha(x.ficha, x.h, hoy, a.pending);
    x.h.ficha = x.ficha.idFicha;
    if (!reaparecidos.includes(x.ficha.idFicha)) reaparecidos.push(x.ficha.idFicha);
  }
  // dos avisos que reactivan la misma ficha son UN anuncio: la lista no repite
  const idsAnunciados = [...new Set(elegidos.map((x) => (x.ficha ? x.ficha.idFicha : x.h.id)))];
  const aCrear = elegidos.filter((x) => !x.ficha).map((x) => x.h);

  const snapshot = {
    fecha: hoy,
    corrida_completa: completa,
    linea_base: !previo,
    comparado_contra: previo ? previo.fecha : null,
    repos_activos: activos.length,
    repos_apagados: apagados,
    repos,
    no_medidos: noMedidos.map((r) => ({ ruta: rutaCompleta(r), motivo: r.motivo_no_medido })),
    // Por repo con la raíz npm, cuántas carpetas con lockfile miró de cuántas, las excluidas con su
    // motivo, y las nuevas de esta noche con sus altas/críticas. El resumen diario lo dice: así un hueco se ve.
    carpetas,
    // el total para el resumen, sin contar dos veces un hallazgo que aparece en carpetas nuevas de varios repos
    graves_en_carpetas_nuevas: hallazgos.filter((h) => h.repos.some((r) => nuevas.has(r))).length,
    primera_noche_de_carpeta: [...enEspera].sort(),
    hallazgos,
    // 🔴 `hallazgos` es lo que DESPIERTA a alguien (sin lo declarado). `presencias` es lo que HAY
    // en cada repo, declarado o no: es lo único con lo que se puede decidir si una ficha se
    // resolvió. Confundirlos es leer "declarado" como "pagado".
    presencias: agruparPresencias(repos),
    anunciados_hoy: idsAnunciados,
    postergados_por_presupuesto: postergados.map((h) => h.id),
    anexados,
    reaparecidos_ids: [...reaparecidos].sort(),
    presupuesto: { tope_pr_por_noche: tope },
  };

  // Se crean fichas SÓLO para lo que se anuncia hoy (tope de ruido). El REFRESCO de los hechos de
  // cada noche no vive acá: lo hace `vigilarFichas`, que además es la única que decide — tener
  // dos lugares que escriben la misma ficha en la misma corrida es cómo se pisan las decisiones.
  if (!a.dryRun) escribirBorradores(a.pending, aCrear, snapshot);
  // 🔴 La vigilancia de las fichas VIVAS —las pendientes y también las ya ACEPTADAS— corre acá,
  // después de crear las nuevas. Es lo único que escribe `resuelto:`, y sólo por medición: ni un
  // pull request mergeado, ni una deuda declarada, ni un id que se movió resuelven nada.
  // lo que vuelve comparte el tope con lo nuevo: el cupo de altas que dejó el camino del tope
  const cupo = { restante: previo ? Math.max(0, tope - elegidos.filter((x) => x.h.severidad !== 'critical').length) : 0, nuevas };
  // N se lee cada noche: si cambió, rige desde hoy y lo ya contado se conserva.
  const resolver = cycle.nochesParaResolver(a.operations);
  const vig = a.dryRun
    ? { resueltos: [], descartados: [], aceptadas_sin_resolver: [], reaparecidos: [], rechazadas_sin_deuda: [], postergados: [],
      esperando_resolver: [], sin_resolver_por_configuracion: [], ilegibles: [] }
    : vigilarFichas(a.pending, hoy, snapshot, apagadosEtiq, cfg, new Set(reaparecidos), cupo, resolver);
  for (const id of vig.postergados) if (!snapshot.postergados_por_presupuesto.includes(id)) snapshot.postergados_por_presupuesto.push(id);
  snapshot.resueltos_ids = vig.resueltos;
  snapshot.resolver_tras = resolver.ok ? { n: resolver.n, origen: resolver.origen } : { n: null, motivo: resolver.motivo };
  snapshot.esperando_resolver = vig.esperando_resolver;
  snapshot.sin_resolver_por_configuracion = vig.sin_resolver_por_configuracion;
  snapshot.fichas_ilegibles = [...new Set([...vig.ilegibles, ...leerTodasLasFichas(a.pending).ilegibles])].sort();
  snapshot.descartados_ids = vig.descartados;
  snapshot.aceptadas_sin_resolver = vig.aceptadas_sin_resolver;
  // Siempre presente, aunque vacía: una clave ausente y una lista vacía se leen igual desde
  // afuera, y el resumen diario lee justamente ésta.
  snapshot.rechazadas_sin_deuda_ids = vig.rechazadas_sin_deuda || [];
  // Una ficha cerrada que la vigilancia encontró de vuelta también es novedad: se anuncia igual que
  // la que detecta el camino del tope. NO consume tope — no es un hallazgo nuevo, es uno que volvió.
  for (const id of vig.reaparecidos) {
    if (!snapshot.reaparecidos_ids.includes(id)) snapshot.reaparecidos_ids.push(id);
    if (!snapshot.anunciados_hoy.includes(id)) snapshot.anunciados_hoy.push(id);
  }
  snapshot.reaparecidos_ids.sort(); snapshot.anunciados_hoy.sort();
  // 🔴 EL CRUCE: después de vigilar (necesita las fichas ya refrescadas y movidas) y antes de
  // archivar ignoradas (que mira el estado de los pedidos). La clave `cruce` está SIEMPRE: una
  // clave ausente se leería igual que «ningún pedido cerrado», y eso es lo que esta pieza no puede decir
  // sin haber mirado. En `--dry-run` se calcula sin escribir marcadores.
  const volcado = leerVolcado(a.bugs || path.join(a.out, `bugs-${hoy}.json`));
  snapshot.cruce = cruzarPedidos({ pendingDir: a.pending, hoy, snapshot, volcado, cfg, apagadosEtiq, escribir: !a.dryRun });
  const frenados = [];
  const ignorados = a.dryRun ? [] : archivarIgnorados(a.pending, hoy, cfg, volcado, frenados);
  snapshot.cruce.ignorado_frenado = frenados;
  snapshot.ignorados_ids = ignorados;
  // El snapshot se escribe DESPUÉS de decidir resueltos e ignorados: si se
  // escribiera antes, `ignorados_ids` —que el pipeline lee del ARCHIVO para abandonar los PR
  // de lo ignorado— no llegaría al disco: quedaría sólo en la salida. Los PR ignorados no se
  // abandonarían nunca.
  if (!a.dryRun) {
    fs.mkdirSync(a.out, { recursive: true });
    fs.writeFileSync(path.join(a.out, `dependencias-${hoy}.json`), JSON.stringify(snapshot, null, 2) + '\n');
  }

  if (a.json) console.log(JSON.stringify(snapshot, null, 2));
  else imprimirCorrida(snapshot, aAnunciar, postergados);

  // 🔴 Sale 1 SÓLO si no se pudo medir NADA. Un repo caído no puede tumbar la vigilancia de los
  // otros nueve; pero una noche en que no se miró nada no puede salir en verde.
  return medidos.length === 0 ? 1 : 0;
}

// ── borradores ─────────────────────────────────────────────────────────────────────────────────

function escribirBorradores(pendingDir, aAnunciar, snapshot) {
  if (!aAnunciar.length) return;
  const dir = path.join(pendingDir, 'pending');
  fs.mkdirSync(dir, { recursive: true });
  for (const h of aAnunciar) {
    const p = path.join(dir, `${h.id}.yaml`);
    if (fs.existsSync(p)) continue;          // ya existe: la decisión de alguien no se pisa
    const y = [
      `id: ${h.id}`,
      `detectado: ${snapshot.fecha}`,
      `veredicto: pendiente`,
      `paquete: ${h.paquete}`,
      `severidad: ${h.severidad}`,
      ...(h.gravedad_sin_dato ? ['# alta por falta de dato: el gestor de paquetes no informó la gravedad (se cuenta alta para no callarla)'] : []),
      `noches: ${h.noches}`,
      `ids:`,
      ...(h.idsJuntos || [h.id]).map((i) => `  - ${i}`),
      `repos:`,
      ...(h.reposJuntos || h.repos).map((r) => `  - ${r}`),
      `avisos:`,
      ...((h.avisosJuntos || h.advisories).length ? (h.avisosJuntos || h.advisories).map((u) => `  - ${u}`) : ['  - (el informe no trajo enlace)']),
      `# Qué decidir: se arregla (subir el paquete) o se declara como deuda en el`,
      `# vulnerabilidades-pendientes.json del repo, con motivo y fecha de revisión.`,
      `# Lo que NO se decide vuelve a aparecer todas las noches, y a los ${DIAS_PARA_IGNORADO} días`,
      `# se archiva como 'ignorado' — que cuenta PEOR que descartado con motivo.`,
      '',
    ].join('\n');
    fs.writeFileSync(p, y);
  }
}

// ── antes de crear una ficha, se busca en las TRES carpetas ────────────────────────────────────
//
// 🔴 EL IDENTIFICADOR SE MUEVE SOLO. La huella es `paquete|severidad|avisos`,
// así que un aviso NUEVO sobre el mismo paquete produce OTRO id: el viejo desaparece de los
// hallazgos —y se daría por resuelto, falso— y el nuevo nacería como ficha nueva, con su propio pull
// request: dos pull requests y un "arreglo" fantasma por el mismo hecho.
//
// La identidad de una ficha es (paquete, PROYECTO de Azure DevOps), porque el pedido de trabajo es
// uno por proyecto: el mismo paquete en dos proyectos distintos son dos fichas, y eso no cambia.

const ESTADOS_FICHA = ['pending', 'promoted', 'archived'];

/**
 * Las fichas de las tres carpetas. Una que no se puede leer no tumba a quien llama: va a `out.ilegibles`
 * (`carpeta/archivo`), que la corrida publica. `contando`: dejó de aparecer y está contando
 * sus noches para resolverse; no se le pide un pedido de trabajo.
 */
function leerTodasLasFichas(pendingDir) {
  const out = [];
  out.ilegibles = [];
  for (const estado of ESTADOS_FICHA) {
    const dir = path.join(pendingDir, estado);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
      const p = path.join(dir, f);
      let txt;
      try { txt = fs.readFileSync(p, 'utf8'); } catch { out.ilegibles.push(`${estado}/${f}`); continue; }
      const fi = leerFicha(txt);
      const idFicha = fi.escalares.id || f.replace(/\.yaml$/, '');
      const viva = estado === 'pending' ? fi.escalares.veredicto === 'pendiente'
        : estado === 'promoted' ? !fi.escalares.resuelto
        : false;
      out.push({ archivo: p, nombre: f, estado, txt, fi, idFicha, viva, contando: !!fi.escalares.noches_sin_aparecer,
                 ids: fi.listas.ids.length ? fi.listas.ids : [idFicha] });
    }
  }
  return out;
}

/** La ficha que ya representa este hecho: por id, y si no, por paquete + proyecto. */
function fichaDe(fichas, h, cfg) {
  const porId = fichas.find((x) => x.ids.includes(h.id));
  if (porId) return porId;
  const proyectosDelHallazgo = new Set(h.repos.map((r) => proyectoDe(r, cfg)));
  return fichas.find((x) => {
    if (String(x.fi.escalares.paquete || '').toLowerCase() !== String(h.paquete).toLowerCase()) return false;
    const suyos = [...x.fi.listas.repos, ...x.fi.listas.declarada_en.map(soloRepo)].filter(Boolean);
    return suyos.some((r) => proyectosDelHallazgo.has(proyectoDe(r, cfg)));
  }) || null;
}

/**
 * Anexa un id (y sus avisos) a una ficha VIVA. No la mueve ni cambia su veredicto.
 *
 * 🔴 RELEE DEL DISCO Y ACTUALIZA EL OBJETO EN MEMORIA. La lista de fichas se arma UNA vez antes del
 * bucle, así que dos avisos nuevos del mismo paquete y proyecto en la MISMA noche escribirían los dos
 * sobre el texto leído al principio: el segundo pisaría al primero. El resumen diría «los dos
 * anexados» y el archivo tendría uno solo — el identificador perdido quedaría marcado como anunciado,
 * sin pull request, y nadie se enteraría.
 */
function anexarAFicha(f, h) {
  refrescarFicha(f);
  let txt = ponerLista(f.txt, 'ids', [...new Set([...f.ids, h.id])]);
  txt = ponerLista(txt, 'avisos', [...new Set([...f.fi.listas.avisos, ...(h.advisories || [])])]
    .filter((x) => x !== '(el informe no trajo enlace)').sort());
  fs.writeFileSync(f.archivo, txt);
  refrescarFicha(f);
}

/** Vuelve a leer la ficha de su ubicación ACTUAL (otra decisión de esta misma noche pudo moverla). */
function refrescarFicha(f) {
  if (!fs.existsSync(f.archivo)) {
    // La movió una decisión anterior de esta corrida: se busca por nombre en las tres carpetas.
    const base = path.dirname(path.dirname(f.archivo));
    const donde = ESTADOS_FICHA.map((e) => path.join(base, e, f.nombre)).find((x) => fs.existsSync(x));
    if (!donde) return;                       // desapareció de verdad: quien llama ya no escribe
    f.archivo = donde;
    f.estado = path.basename(path.dirname(donde));
  }
  f.txt = fs.readFileSync(f.archivo, 'utf8');
  f.fi = leerFicha(f.txt);
  f.idFicha = f.fi.escalares.id || f.nombre.replace(/\.yaml$/, '');
  f.ids = f.fi.listas.ids.length ? f.fi.listas.ids : [f.idFicha];
  f.viva = f.estado === 'pending' ? f.fi.escalares.veredicto === 'pendiente'
    : f.estado === 'promoted' ? !f.fi.escalares.resuelto
    : false;
  f.contando = !!f.fi.escalares.noches_sin_aparecer;
}

/**
 * Una ficha CERRADA cuyo hecho vuelve a aparecer se REACTIVA — no nace una segunda.
 * Los campos de cierre se conservan con sufijo `_antes`: la historia de la ficha es el dato que
 * hace visible que esto ya había pasado.
 */
/** La ficha sin la propuesta del modelo ni sus fallas. */
function sinPropuesta(txt) {
  return sources.CLAVES_DE_PROPUESTA.reduce((t, k) => quitarClave(t, k), txt);
}

function reactivarFicha(f, h, hoy, pendingDir) {
  // 🔴 Misma relectura que el anexo, y por el mismo motivo: si dos avisos nuevos reactivan la MISMA
  // ficha cerrada esta noche, la segunda llamada trabajaría sobre el texto viejo e intentaría borrar
  // un archivo que la primera ya movió — excepción sin capturar que tumbaría la corrida
  // ENTERA, con los diez repos ya auditados y nada escrito. Reactivar dos veces la
  // misma ficha tiene que ser inofensivo: la segunda sólo anexa.
  refrescarFicha(f);
  if (!fs.existsSync(f.archivo)) return;
  let txt = f.txt;
  // 🔴 Y la historia del pull request se corta acá: la ficha reactivada NO puede
  // conservar `pr:`, porque el pipeline consultaría el pull request de su vida anterior —cerrado o
  // completado— y no abriría ninguno nuevo. El hecho volvió: necesita su propio lugar donde
  // decidirse. La historia no se pierde, se renombra, y `pr-text` la cuenta en el texto del PR
  // nuevo para que nadie vuelva a decidir a ciegas lo que ya decidió una vez.
  for (const [de, a] of [['resuelto', 'resuelto_antes'], ['descartado', 'descartado_antes'],
    ['motivo', 'motivo_antes'], ['pr', 'pr_antes'], ['pr_repo', 'pr_repo_antes'], ['rechazado', 'rechazado_antes'],
    ['motivo_rechazo', 'motivo_rechazo_antes']]) {
    txt = renombrarClave(txt, de, a);
  }
  // `alineado:` dice qué decisión del pull request ya se reflejó en los issues: la ficha que vuelve tiene otra por tomar.
  txt = quitarClave(quitarClave(txt, 'pr_cerrado'), 'alineado');
  // Los marcadores del CRUCE son de un episodio: una ficha que vuelve empieza de cero. Si no, el
  // Bug cerrado con la vulnerabilidad de vuelta saldría «ya avisado» y el aviso nuevo no saldría nunca. `pedidos:`
  // se conserva: el Bug es el mismo. 🔴 `pagado_avisado:` NO se borra acá: es por proyecto, y borrarlo entero
  // repetiría «ya no aparece» en el proyecto donde nada cambió. Lo
  // borra el guion de pedidos en el proyecto donde la vulnerabilidad vuelve a aparecer.
  for (const k of ['visto_cerrado', 'avisado_cerrado_vivo']) txt = ponerLista(txt, k, []);
  // la propuesta del modelo era de la vida anterior: se le vuelve a pedir
  txt = sinPropuesta(txt);
  txt = ponerEscalar(txt, 'veredicto', 'pendiente');
  txt = ponerEscalar(txt, 'reaparecido', hoy);
  if (h && !f.ids.includes(h.id)) {
    txt = ponerLista(txt, 'ids', [...new Set([...f.ids, h.id])]);
    txt = ponerLista(txt, 'avisos', [...new Set([...f.fi.listas.avisos, ...(h.advisories || [])])]
      .filter((x) => x !== '(el informe no trajo enlace)').sort());
  }
  const destino = path.join(pendingDir, 'pending', f.nombre);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const origen = f.archivo;
  fs.writeFileSync(destino, txt);
  if (path.resolve(origen) !== path.resolve(destino)) fs.unlinkSync(origen);
  f.archivo = destino; f.estado = 'pending';
  refrescarFicha(f);
}

/**
 * LA VIGILANCIA VA POR FICHA, NO POR HALLAZGO.
 *
 * Recorrer por hallazgo y buscar `pending/<id>.yaml` dejaría sin mirar a una ficha ACEPTADA
 * —que el pipeline mueve a `promoted/` al mergear su pull request—: nunca recibiría `resuelto:` y
 * sus datos quedarían congelados en la primera noche.
 *
 * Se recorren las fichas VIVAS (`pending/` con veredicto pendiente + `promoted/` sin `resuelto:`),
 * se une la presencia de TODOS sus ids, y se decide EN ESTE ORDEN — el orden es la regla:
 *
 *   (a) algún repo de la ficha apagado o no medido  → NINGUNA decisión ("no medido" nunca es "limpio")
 *   (b) ningún id presente en ningún repo           → `resuelto:` (lo único que resuelve es la medición)
 *   (c) presente, y declarada en TODOS los repos    → `archived/` como descartado por deuda (declarar no es pagar)
 *   (d) presente sin declarar en alguno             → viva: se refrescan los hechos de esta noche
 */
function vigilarFichas(pendingDir, hoy, snapshot, apagadosEtiq, cfg, yaReactivados, cupo = { restante: Infinity, nuevas: new Set() },
  resolver = { ok: true, n: cycle.NOCHES_POR_DEFECTO }) {
  const res = { resueltos: [], descartados: [], aceptadas_sin_resolver: [], reaparecidos: [],
    rechazadas_sin_deuda: [], postergados: [], esperando_resolver: [], sin_resolver_por_configuracion: [], ilegibles: [] };
  // Una ficha que esta misma corrida ya movió (a `archived/` por deuda, a `promoted/` al resolverse)
  // NO se vuelve a juzgar cuando el recorrido llega a esa carpeta: se decidió hace un instante.
  const decididasHoy = new Set();
  const dirPending = path.join(pendingDir, 'pending');
  const dirPromoted = path.join(pendingDir, 'promoted');
  const presencias = new Map((snapshot.presencias || []).map((p) => [p.id, p]));
  const porId = new Map((snapshot.hallazgos || []).map((h) => [h.id, h]));
  const medidos = new Set((snapshot.repos || []).filter((r) => r.medido).map(etiqueta));

  const dirArchived = path.join(pendingDir, 'archived');
  for (const [estado, dir] of [['pending', dirPending], ['promoted', dirPromoted], ['archived', dirArchived]]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
      const p = path.join(dir, f);
      let txt;
      // 🔴 Una ficha que no se puede leer se cuenta y la noche sigue con las demás: una sola
      // tumbaba la corrida entera, con los repos ya auditados y nada escrito.
      try { txt = fs.readFileSync(p, 'utf8'); } catch { res.ilegibles.push(`${estado}/${f}`); continue; }
      const fi = leerFicha(txt);
      // 🔴 LAS FICHAS CERRADAS TAMBIÉN SE MIRAN, para detectar que el problema VOLVIÓ.
      //
      // Mirar sólo las vivas dejaría la reactivación en el otro camino —el del tope de
      // anuncios—, que decide contra el último snapshot COMPLETO. Serían dos líneas base distintas para la
      // misma pregunta: bastaría que UN repo de los veinte no se midiera la noche en que otra ficha se
      // cura, y esa ficha quedaría `resuelto:` PARA SIEMPRE aunque la vulnerabilidad volviera —
      // contada como trabajo real, sin que nadie volviera a ser avisado.
      if (decididasHoy.has(f)) continue;
      const cerrada = (estado === 'promoted' && !!fi.escalares.resuelto)
        || (estado === 'archived' && fi.escalares.veredicto !== 'pendiente');
      if (estado === 'pending' && fi.escalares.veredicto !== 'pendiente') continue;

      // 🔴 Compatibilidad con las fichas que ya existen: sin `ids:`, el id es el suyo. Sin esto, la
      // la primera noche ninguna ficha vieja tendría ids y todas se resolverían.
      const idFicha = fi.escalares.id || f.replace(/\.yaml$/, '');
      const ids = fi.listas.ids.length ? fi.listas.ids : [idFicha];

      // Presencia = la UNIÓN sobre todos los ids… y sobre el MISMO PAQUETE en el mismo PROYECTO.
      //
      // 🔴 Por qué no alcanza con los ids: la declaración de deuda ampara por AVISO, no por
      // severidad. Si el mismo aviso se re-puntúa de alto a crítico, nace otra huella —ya
      // amparada— que nunca entra a la lista de anuncios (lo declarado no despierta a nadie) y por
      // eso nunca se anexa a la ficha. La ficha no la vería, creería que su paquete desapareció,
      // y escribiría `resuelto:` donde corresponde «descartado por deuda».
      //
      // La identidad es la MISMA que usa `fichaDe` para decidir si dos hechos son la misma ficha
      // (paquete sin distinguir mayúsculas + proyecto de Azure), así que las dos preguntas
      // —«¿es la misma ficha?» y «¿sigue estando?»— se contestan con el mismo criterio.
      // (Es `presenciaDeFicha`: el cruce por proyecto usa la MISMA regla.)
      const porRepo = presenciaDeFicha(fi, ids, snapshot, cfg);

      // Los repos "de la ficha": los que decía anoche (sin declarar y declarados) más donde está hoy.
      // Un repo que salió de la lista porque se limpió no bloquea; uno que no se midió, sí.
      const reposFicha = new Set([
        ...fi.listas.repos, ...fi.listas.declarada_en.map(soloRepo), ...porRepo.keys(),
      ].filter(Boolean));
      const apagados = [...reposFicha].filter((r) => apagadosEtiq.has(r)).sort();
      const sinMedir = [...reposFicha].filter((r) => !apagadosEtiq.has(r) && !medidos.has(r)).sort();

      // Los hechos de esta noche se refrescan SIEMPRE (también en una aceptada, y también cuando la
      // decisión queda bloqueada): el pull request transporta la decisión, los datos son los de hoy.
      //
      // 🔴 PERO UN REPO QUE NO SE PUDO MEDIR NO SE BORRA DE LA FICHA. La presencia sólo conoce los
      // repos MEDIDOS, así que escribir `repos:` con lo presente sacaría de la ficha al repo que esa
      // noche no se pudo mirar. La noche siguiente ya no sería «de la ficha», no bloquearía nada, y la
      // ficha se resolvería —o se archivaría por deuda— con ese repo JAMÁS medido: el «no medido =
      // limpio» de vuelta por la puerta de atrás. Hacen falta
      // DOS noches para verlo, así que un caso de una sola noche no lo ve.
      const sinMirar = (r) => !medidos.has(r) || apagadosEtiq.has(r);
      const sinDeclarar = [...new Set([
        ...[...porRepo.values()].filter((x) => !x.declarada).map((x) => x.repo),
        ...fi.listas.repos.filter(sinMirar),
      ])].sort();
      const declaradas = [...new Set([
        ...[...porRepo.values()].filter((x) => x.declarada).map((x) => `${x.repo} (vence ${x.vence || 'sin fecha'})`),
        ...fi.listas.declarada_en.filter((l) => sinMirar(soloRepo(l))),
      ])].sort();
      const noches = Math.max(0, ...ids.map((i) => (porId.get(i) || {}).noches || 0));
      if (noches) txt = ponerEscalar(txt, 'noches', noches);
      if (sinDeclarar.length || declaradas.length) {
        txt = ponerLista(txt, 'repos', sinDeclarar);
        txt = ponerLista(txt, 'declarada_en', declaradas);
      }

      // Una ficha CERRADA sólo tiene una pregunta: ¿volvió? Si no volvió, se deja como está.
      //
      // 🔴 «Volvió» quiere decir presente y SIN DECLARAR en algún repo. Una ficha archivada porque
      // se declaró la deuda sigue teniendo su paquete ahí todas las noches, amparado y con plazo:
      // reactivarla sería despertar cada noche por la decisión que alguien ya tomó — exactamente
      // el ruido que la declaración existe para evitar. Vuelve cuando la declaración vence, que es
      // cuando el paquete reaparece sin amparo.
      if (cerrada) {
        if (![...porRepo.values()].some((x) => !x.declarada)) continue;
        if ((yaReactivados || new Set()).has(idFicha)) continue;   // el otro camino ya la reactivó
        // 🔴 Lo que vuelve también pasa por el tope y por la primera noche de una carpeta: una alta que reaparece
        // es un aviso más esa noche, igual que una nueva. Si no entra, queda cerrada: mañana se la vuelve a mirar
        // y entra primero (lleva más noches). Una crítica no espera.
        const critica = String(fi.escalares.severidad || '').toLowerCase() === 'critical';
        if (!critica) {
          const sinDeclararHoy = [...porRepo.values()].filter((x) => !x.declarada).map((x) => x.repo);
          const soloEnNuevas = sinDeclararHoy.length > 0 && sinDeclararHoy.every((r) => (cupo.nuevas || new Set()).has(r));
          if (soloEnNuevas || cupo.restante <= 0) { res.postergados.push(idFicha); continue; }
          cupo.restante -= 1;
        }
        // 🔴 Los hechos de hoy se guardan ANTES de reactivar: `reactivarFicha` relee la ficha del disco, y con el
        // texto viejo la ficha volvería a `pending/` con los repos de cuando se cerró (por deuda: ninguno).
        fs.writeFileSync(p, txt);
        reactivarFicha({ archivo: p, nombre: f, estado, txt, fi, idFicha, ids }, null, hoy, pendingDir);
        res.reaparecidos.push(idFicha);
        continue;
      }

      // 🔴 UNA RECHAZADA VIVA SE PUBLICA ACÁ, antes de las cuatro ramas — no en la (d).
      //
      // Estando en la (d) se perdería por el `continue` de la (a): si CUALQUIER repo de la ficha
      // quedara apagado o sin medir esa noche, la ficha desaparecería de `rechazadas_sin_deuda_ids`
      // y de la línea ⚠️ del aviso **sin decir nada**, en una corrida que se lee como normal — y
      // contradiciendo a `report`, que sí la seguiría contando. Ejemplo: noche con el repo
      // medido → la lista trae la ficha; noche siguiente con `activo:false` → lista vacía, con la
      // ficha todavía en `pending/`, `veredicto: pendiente` y `rechazado:`. El consumidor de esa
      // clave (el resumen diario) leería «no hay rechazadas», que es el cero silencioso
      // que esta pieza existe para no cometer.
      //
      // El hecho es de la FICHA, no de la noche: está rechazada y está viva. Que un repo no se
      // haya podido medir no cambia ninguna de las dos cosas.
      if (estado !== 'archived' && /^rechazado:/m.test(txt)) res.rechazadas_sin_deuda.push(idFicha);

      // (a) sin medir todo: no se decide nada. El repo APAGADO se dice (es un estado, no una alarma);
      //     el marcador se borra la noche en que ese repo vuelve a medirse.
      if (apagados.length || sinMedir.length) {
        // La causa se vio en un repo medido: el contador de noches sin aparecer vuelve a cero aunque la noche no
        // decida nada. Si no, la próxima noche limpia la resolvería con menos de N noches seguidas.
        if (porRepo.size) txt = quitarClave(quitarClave(txt, 'noches_sin_aparecer'), 'noche_contada');
        txt = apagados.length
          ? ponerEscalar(txt, 'bloqueada_por', `"repo apagado: ${apagados.join(', ')}"`)
          : quitarClave(txt, 'bloqueada_por');
        escribirSiCambio(p, txt);
        if (estado === 'promoted') {
          res.aceptadas_sin_resolver.push({
            id: idFicha, paquete: fi.escalares.paquete || null, desde: fi.escalares.detectado || null,
            bloqueada_por: apagados.length ? `repo apagado: ${apagados.join(', ')}` : null,
          });
        }
        continue;
      }
      txt = quitarClave(txt, 'bloqueada_por');

      // (b) ningún id aparece en ningún repo, y TODOS los repos de la ficha se midieron: una noche sin aparecer.
      //     Se pagó recién a las N noches medidas seguidas: una noche de suerte no es un arreglo.
      //     Sin N confiable (operations.json que no valida) no se resuelve nada ni se cuenta la noche.
      if (porRepo.size === 0) {
        const cuenta = resolver.ok
          ? cycle.contarNoche({ contador: Number(fi.escalares.noches_sin_aparecer) || 0, presente: false, medida: true,
            n: resolver.n, hoy, nocheContada: fi.escalares.noche_contada })
          : null;
        if (!cuenta || !cuenta.resuelta) {
          if (cuenta) {
            txt = ponerEscalar(txt, 'noches_sin_aparecer', cuenta.contador);
            txt = ponerEscalar(txt, 'noche_contada', hoy);
            res.esperando_resolver.push({ id: idFicha, noches_sin_aparecer: cuenta.contador, n: resolver.n });
          } else {
            res.sin_resolver_por_configuracion.push(idFicha);
          }
          escribirSiCambio(p, txt);
          if (estado === 'promoted') {
            res.aceptadas_sin_resolver.push({
              id: idFicha, paquete: fi.escalares.paquete || null, desde: fi.escalares.detectado || null, bloqueada_por: null,
            });
          }
          continue;
        }
        txt = quitarClave(quitarClave(txt, 'noches_sin_aparecer'), 'noche_contada');
        txt = ponerEscalar(txt, 'resuelto', hoy);
        txt = ponerEscalar(txt, 'motivo', '"la vulnerabilidad dejó de aparecer en todos sus repos, medidos esta noche"');
        if (estado === 'pending') {
          txt = ponerEscalar(txt, 'veredicto', 'util');
          fs.mkdirSync(dirPromoted, { recursive: true });
          fs.writeFileSync(path.join(dirPromoted, f), txt);
          fs.unlinkSync(p);
          decididasHoy.add(f);
        } else {
          escribirSiCambio(p, txt);   // una aceptada que se resuelve SE QUEDA donde está
        }
        res.resueltos.push(idFicha);
        continue;
      }

      // La causa sigue apareciendo: el contador de noches sin aparecer vuelve a cero.
      txt = quitarClave(quitarClave(txt, 'noches_sin_aparecer'), 'noche_contada');

      // (c) presente en todos lados pero DECLARADA en todos ellos: no se pagó, se decidió postergar.
      if (!sinDeclarar.length) {
        txt = ponerEscalar(txt, 'veredicto', 'descartado');
        txt = ponerEscalar(txt, 'descartado', hoy);
        txt = ponerEscalar(txt, 'motivo', `"declarada como deuda en ${declaradas.join(', ')}"`);
        const arch = path.join(pendingDir, 'archived');
        fs.mkdirSync(arch, { recursive: true });
        fs.writeFileSync(path.join(arch, f), txt);
        fs.unlinkSync(p);
        decididasHoy.add(f);
        res.descartados.push(idFicha);
        continue;
      }

      // (d) sigue viva.
      // 🔴 Y si una persona rechazó su pull request, eso se PUBLICA. Rechazar el aviso
      // no arregla la vulnerabilidad: la ficha sigue viva y su única salida es la medición o la
      // deuda declarada en todos sus repos. Sin publicarla, una rechazada sería indistinguible de
      // una resuelta en todos los contadores — el mismo error de confundir «declarado» con «resuelto».
      if (/^rechazado:/m.test(txt)) res.rechazadas_sin_deuda.push(idFicha);
      escribirSiCambio(p, txt);
      if (estado === 'promoted') {
        res.aceptadas_sin_resolver.push({
          id: idFicha, paquete: fi.escalares.paquete || null,
          desde: fi.escalares.detectado || null, bloqueada_por: null,
        });
      }
    }
  }
  res.resueltos.sort(); res.descartados.sort(); res.reaparecidos.sort(); res.ilegibles.sort();
  res.sin_resolver_por_configuracion.sort();
  res.esperando_resolver.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  // Y sale de la lista la que ESTA MISMA noche se cerró: resuelta por medición (b) o archivada por
  // deuda declarada en todos sus repos (c). Rechazar no la saca de `main`, pero cerrarla sí.
  const cerradasHoy = new Set([...res.resueltos, ...res.descartados]);
  res.rechazadas_sin_deuda = [...new Set(res.rechazadas_sin_deuda)]
    .filter((id) => !cerradasHoy.has(id)).sort();
  res.aceptadas_sin_resolver.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return res;
}

const escribirSiCambio = (p, txt) => { if (fs.readFileSync(p, 'utf8') !== txt) fs.writeFileSync(p, txt); };

/**
 * Un borrador que nadie miró en 7 días pasa solo a archivado como `ignorado`.
 *
 * 🔴 El reloj arranca en la última vez que la ficha PIDIÓ una decisión, no en la primera. Una ficha
 * cerrada que reaparece conserva su `detectado:` original — y una deuda vence a meses, así
 * que el caso normal es que reaparezca con más de 7 días encima. Sin esto, la reactivación y el
 * archivado como ignorada ocurrirían la MISMA noche: la ficha quedaría anunciada pero fuera de
 * `pending/`, el pipeline la saltearía («no está el borrador»), y la noche siguiente el hallazgo
 * heredaría `anunciado: true` y no se anunciaría nunca más. La vulnerabilidad volvería y la métrica
 * diría «nadie la miró». El corte de 7 días no cambia: cambia desde cuándo se cuenta.
 *
 * 🔴 UNA FICHA SIN PEDIDO NO PUEDE SER «NADIE LA MIRÓ»: si el pedido de trabajo
 * del líder no se pudo crear en alguno de sus proyectos, nadie PUDO mirarla — archivarla como
 * ignorada taparía un fallo de creación con el único número que juzga a la pieza. Queda en
 * `pending/` y el guion de pedidos la publica en `sin_pedido`. Aplica SÓLO con
 * `azure.pedidos_activos: true`: con la pieza apagada ninguna ficha
 * tiene pedido, y la protección haría que ninguna volviera a ignorarse desde el merge.
 */
/**
 * ¿Los pedidos están prendidos? Los Bugs de Azure (`azure.pedidos_activos`) o los issues de GitHub
 * (`github.issues_enabled`). Con cualquiera de los dos, una ficha sin pedido no es «nadie la miró».
 */
const pedidosActivos = (cfg) => !!(cfg && ((cfg.azure && cfg.azure.pedidos_activos === true)
  || (cfg.github && cfg.github.issues_enabled === true)));

/**
 * La clave de un pedido en el volcado. En Azure, el número: un id de work item es único en la
 * organización. En GitHub el número de un issue se repite entre repos: `<dueño>/<repo>#<n>`. Lo dice el volcado
 * (`plataforma: "github"`); sin esa clave, el número, como siempre.
 */
const claveDePedido = (volcado, proyecto, id) => (volcado && volcado.plataforma === 'github' ? `${proyecto}#${id}` : String(id));

/** Los motivos de cierre que cuentan como arreglado: fijos en GitHub (`completed`); en Azure, los de repos.json. */
function vocabularioDeCierre(cfg, volcado) {
  if (volcado && volcado.plataforma === 'github') return ['completed'];
  return cfg && cfg.azure && Array.isArray(cfg.azure.motivos_arreglado) && cfg.azure.motivos_arreglado.length
    && cfg.azure.motivos_arreglado.every((x) => typeof x === 'string') ? cfg.azure.motivos_arreglado : null;
}

function archivarIgnorados(pendingDir, hoy, cfg, volcado, frenados = []) {
  const dir = path.join(pendingDir, 'pending');
  if (!fs.existsSync(dir)) return [];
  const arch = path.join(pendingDir, 'archived');
  const exigirPedido = pedidosActivos(cfg);
  const ids = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
    let txt;
    try { txt = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }   // ilegible: ya la publicó la corrida
    // 🔴 RECHAZAR ES MIRAR. `ignorado` cuenta PEOR que descartado porque mide "a nadie
    // le importó"; una ficha cuyo pull request una persona se tomó el trabajo de rechazar es
    // exactamente lo contrario, y archivarla ahí mentiría en el único número que juzga a la pieza.
    if (/^rechazado:/m.test(txt)) continue;
    // 🔴 La que está contando sus noches sin aparecer tampoco: dejó de aparecer porque alguien la arregló, y en N
    // noches se resuelve sola. Archivarla como ignorada contaría un arreglo como «nadie la miró».
    if (/^noches_sin_aparecer:/m.test(txt)) continue;
    if (exigirPedido) {
      const conPedido = new Set(leerPedidos(txt).map((x) => x.proyecto));
      // Sólo los proyectos a los que se les PUEDE pedir: un repo fuera de la config nunca va a tener
      // pedido, y protegerlo de `ignorado` lo dejaría pendiente para siempre.
      const proyectos = new Set(leerFicha(txt).listas.repos.map((r) => proyectoAzureDe(r, cfg)).filter(Boolean));
      if ([...proyectos].some((p) => !conPedido.has(p))) continue;
    }
    const det = txt.match(/^detectado:\s*(\d{4}-\d{2}-\d{2})/m);
    const rea = txt.match(/^reaparecido:\s*(\d{4}-\d{2}-\d{2})/m);
    const desde = [det && det[1], rea && rea[1]].filter(Boolean).sort().pop();
    const m = desde ? [null, desde] : null;
    if (!m || diasEntre(m[1], hoy) < DIAS_PARA_IGNORADO) continue;
    // 🔴 CON PEDIDOS, «NADIE LA MIRÓ» SE LEE DEL PEDIDO: el reloj es «7 días sin cambios
    // de una PERSONA en el pedido», no «7 días desde que nació». Un comentario del pipeline no cuenta
    // (lo resuelve el volcado); un pedido no leído, cerrado, o una noche sin volcado NO ignoran nada, y
    // se dice por qué. Sin pedidos (los pedidos apagados) rige la regla de los 7 días desde que nació.
    const pedidosFicha = leerPedidos(txt);
    if (pedidosFicha.length) {
      const motivo = motivoParaNoIgnorar(pedidosFicha, volcado, hoy);
      if (motivo) { frenados.push({ ficha: f.replace(/\.yaml$/, ''), motivo }); continue; }
    }
    fs.mkdirSync(arch, { recursive: true });
    fs.writeFileSync(path.join(arch, f), txt.replace(/^veredicto:.*$/m, 'veredicto: ignorado'));
    fs.unlinkSync(path.join(dir, f));
    ids.push(f.replace(/\.yaml$/, ''));
  }
  // Ordenados: van a `ignorados_ids` del snapshot que se commitea, y `readdirSync` no garantiza orden.
  frenados.sort((a, b) => String(a.ficha).localeCompare(String(b.ficha)));
  return ids.sort();
}

// ── el cruce «pedido cerrado, vulnerabilidad viva» ─────────────────────────────────
//
// Hay DOS fuentes sobre el mismo hecho: el estado del Bug (lo que una persona decidió) y
// la medición de esta noche (lo que hay en `origin/main`). Sin compararlas, un Bug cerrado por error,
// por limpiar el tablero o por darlo por hecho antes del merge quedaría cerrado para siempre con la
// vulnerabilidad viva — y el tablero diría «listo». Acá se comparan POR PROYECTO, sobre el volcado que
// dejó `work-items.js state`. Este guion no habla con Azure: lee un archivo.

/** Categorías de estado de Azure DevOps (las de los procesos Agile y Scrum). */
const CATEGORIAS_ABIERTAS = ['Proposed', 'InProgress'];
const CATEGORIAS_CERRADAS = ['Resolved', 'Completed', 'Removed'];

/**
 * La presencia de una ficha en cada repo, esta noche: `Map<repo, { repo, declarada, vence }>`.
 *
 * Es la UNIÓN sobre todos sus ids y sobre el mismo paquete en el mismo proyecto — el criterio de
 * `vigilarFichas`, compartido para que el cruce lo use sin copiarlo: «¿sigue estando?» y «¿sigue
 * estando en este proyecto?» tienen que contestarse con la misma regla.
 */
function presenciaDeFicha(fi, ids, snapshot, cfg) {
  const paqueteFicha = String(fi.escalares.paquete || '').toLowerCase();
  const proyectosFicha = new Set([...fi.listas.repos, ...fi.listas.declarada_en.map(soloRepo)]
    .filter(Boolean).map((r) => proyectoDe(r, cfg)));
  const porRepo = new Map();
  const sumar = (x) => {
    const prev = porRepo.get(x.repo);
    if (!prev || (prev.declarada && !x.declarada)) porRepo.set(x.repo, x);
  };
  for (const pres of snapshot.presencias || []) {
    if (ids.includes(pres.id)) { for (const x of pres.repos) sumar(x); continue; }
    if (!paqueteFicha || String(pres.paquete).toLowerCase() !== paqueteFicha) continue;
    for (const x of pres.repos) if (proyectosFicha.has(proyectoDe(x.repo, cfg))) sumar(x);
  }
  return porRepo;
}

/**
 * El volcado de la noche: `{ archivo, consultado, motivo, pedidos, huerfanos, huerfanos_no_consultados }`.
 * 🔴 Ausente, ilegible o sin consultar son TRES motivos distintos, y ninguno es «no hay pedidos cerrados».
 */
function leerVolcado(ruta) {
  const nombre = path.basename(ruta);
  let t;
  try { t = fs.readFileSync(ruta, 'utf8'); } catch { return { archivo: null, consultado: false, motivo: `sin volcado ${nombre}` }; }
  let v;
  try { v = JSON.parse(t); } catch { return { archivo: nombre, consultado: false, motivo: `volcado ilegible (${nombre})` }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { archivo: nombre, consultado: false, motivo: `volcado ilegible (${nombre})` };
  if (v.consultado !== true) {
    return { archivo: nombre, consultado: false, motivo: String(v.motivo || `el volcado ${nombre} no consultó Azure y no dice por qué`) };
  }
  if (!v.pedidos || typeof v.pedidos !== 'object' || Array.isArray(v.pedidos)) {
    return { archivo: nombre, consultado: false, motivo: `volcado ilegible (${nombre}: no trae «pedidos»)` };
  }
  const lista = (x) => (Array.isArray(x) ? x.filter((y) => y && typeof y === 'object') : []);
  return { archivo: nombre, consultado: true, motivo: null, pedidos: v.pedidos,
    // La plataforma decide la clave de cada pedido y el vocabulario de cierre
    plataforma: v.plataforma === 'github' ? 'github' : 'azure',
    huerfanos: lista(v.huerfanos), huerfanos_no_consultados: lista(v.huerfanos_no_consultados) };
}

/**
 * El cruce, por par (ficha, proyecto). Devuelve la sección `cruce` del snapshot y escribe (salvo
 * `escribir: false`) los marcadores `visto_cerrado:` (`  - <Proyecto>: <fecha>`) y
 * `avisado_cerrado_vivo:` (`  - <Proyecto> (<fecha>)`) — el segundo lo escribe el guion de pedidos
 * DESPUÉS de comentar; acá sólo se borra cuando el pedido se reabre.
 *
 * Las reglas, en el orden en que se aplican:
 *   · «NO LEÍDO» NUNCA ES «COINCIDE»: sin volcado legible, o con el pedido sin leer, el par va a
 *     `no_leidos` y sus marcadores no se tocan (la gracia ni se consume ni se extiende).
 *   · la ficha RESUELTA sólo tiene una pregunta: ¿su pedido sigue abierto? (el espejo, se lista).
 *   · sin el vocabulario `motivos_arreglado` ningún cerrado se clasifica — nunca «arreglado» por defecto.
 *   · un repo del proyecto sin medir (o apagado) → `no_evaluados`: no medido no es pagado.
 *   · abierto → si había marcadores, se borran (`reabiertos`): un cierre nuevo empieza de cero.
 *   · cerrado y PAGADA en el proyecto → coinciden, nada. DECLARADA → `cerrados_con_deuda`, sin aviso.
 *   · cerrado y VIVA → la primera noche se anota y espera (`en_gracia`: el arreglo puede estar
 *     mergeándose); una noche posterior → `cerrados_vivos`, con `avisar` hasta que el aviso salga.
 *   · NUNCA escribe `resuelto:`, `veredicto:` ni `motivo:`: un Bug cerrado no resuelve nada.
 */
function cruzarPedidos({ pendingDir, hoy, snapshot, volcado, cfg, apagadosEtiq = new Set(), escribir = true }) {
  const legible = !!(volcado && volcado.consultado === true && volcado.pedidos && typeof volcado.pedidos === 'object');
  const c = {
    volcado: (volcado && volcado.archivo) || null,
    consultado: legible,
    motivo: legible ? null : ((volcado && volcado.motivo) || 'sin volcado'),
    evaluados: 0, cerrados_vivos: [], en_gracia: [], cerrados_con_deuda: [], reabiertos: [],
    resueltas_con_pedido_abierto: [], no_leidos: [], no_evaluados: [], ignorado_frenado: [],
    huerfanos: legible ? (volcado.huerfanos || []) : [],
    huerfanos_no_consultados: legible ? (volcado.huerfanos_no_consultados || []) : [],
  };
  const voc = vocabularioDeCierre(cfg, volcado);
  const medidos = new Set((snapshot.repos || []).filter((r) => r.medido).map(etiqueta));
  const enConfig = new Set(((cfg && cfg.repos) || []).map(etiqueta));

  for (const estado of ['pending', 'promoted']) {
    const dir = path.join(pendingDir, estado);
    if (!fs.existsSync(dir)) continue;
    for (const nombre of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml')).sort()) {
      const archivo = path.join(dir, nombre);
      let txt;
      try { txt = fs.readFileSync(archivo, 'utf8'); } catch { continue; }   // ilegible: ya la publicó la corrida
      const fi = leerFicha(txt);
      if (estado === 'pending' && fi.escalares.veredicto !== 'pendiente') continue;
      const idFicha = fi.escalares.id || nombre.replace(/\.yaml$/, '');
      const ids = fi.listas.ids.length ? fi.listas.ids : [idFicha];
      const resuelta = estado === 'promoted' && !!fi.escalares.resuelto;
      const pedidos = leerPedidos(txt);
      if (!resuelta) {
        const conPedido = new Set(pedidos.map((x) => x.proyecto));
        const pedibles = [...new Set(fi.listas.repos.map((r) => proyectoAzureDe(r, cfg)).filter(Boolean))].sort();
        for (const p of pedibles.filter((x) => !conPedido.has(x))) c.no_evaluados.push({ ficha: idFicha, proyecto: p, motivo: `sin pedido en ${p}` });
      }
      if (!pedidos.length) continue;
      const porRepo = resuelta ? new Map() : presenciaDeFicha(fi, ids, snapshot, cfg);
      let t = txt;
      for (const { proyecto: X, id } of pedidos) {
        const par = { ficha: idFicha, proyecto: X, pedido: id };
        if (!legible) { c.no_leidos.push({ ...par, motivo: c.motivo }); continue; }
        const e = volcado.pedidos[claveDePedido(volcado, X, id)];
        if (!e || typeof e !== 'object') { c.no_leidos.push({ ...par, motivo: `el volcado no trae el pedido ${id}` }); continue; }
        if (e.leido !== true) { c.no_leidos.push({ ...par, motivo: String(e.motivo_no_leido || 'no leído, sin motivo escrito') }); continue; }
        const abierto = CATEGORIAS_ABIERTAS.includes(e.categoria);
        const cerrado = CATEGORIAS_CERRADAS.includes(e.categoria);
        if (!abierto && !cerrado) { c.no_leidos.push({ ...par, motivo: `categoría de estado desconocida: ${e.categoria}` }); continue; }

        if (resuelta) {
          c.evaluados++;
          if (abierto) {
            c.resueltas_con_pedido_abierto.push({ ...par, resuelto: fi.escalares.resuelto, dias: diasEntre(fi.escalares.resuelto, hoy) });
          }
          continue;
        }
        if (cerrado && !voc) { c.no_leidos.push({ ...par, motivo: 'sin vocabulario `motivos_arreglado` en repos.json: no se puede decir si se cerró como arreglado' }); continue; }

        const vistos = listaDe(t, 'visto_cerrado');
        const visto = vistos.find((l) => l.startsWith(`${X}: `));
        const avisados = listaDe(t, 'avisado_cerrado_vivo');
        // 🔴 Reabierto se decide ANTES de mirar la medición: saber que el Bug se reabrió no necesita
        // presencias, y esperar a que se midan todos los repos dejaría vivos los marcadores del cierre
        // anterior.
        if (abierto) {
          if (visto || avisados.some((l) => l.startsWith(`${X} (`))) {
            t = ponerLista(t, 'visto_cerrado', vistos.filter((l) => !l.startsWith(`${X}: `)));
            t = ponerLista(t, 'avisado_cerrado_vivo', avisados.filter((l) => !l.startsWith(`${X} (`)));
            c.reabiertos.push({ ...par, estado: e.estado });
          }
          c.evaluados++;
          continue;
        }

        // 🔴 Un repo de la ficha que ya no está en repos.json no tiene proyecto conocido
        // (`proyectoDe` caería en el producto, y el producto no es el proyecto: Acme ≠ «Acme Web»). No
        // se puede afirmar que NO sea de este proyecto, así que cuenta — y como no se mide, bloquea el par:
        // «no medido» nunca sale «coincide».
        const reposX = [...new Set([...fi.listas.repos, ...fi.listas.declarada_en.map(soloRepo), ...porRepo.keys()])]
          .filter((r) => r && (!enConfig.has(r) || proyectoDe(r, cfg) === X)).sort();
        const sinMirar = reposX.filter((r) => apagadosEtiq.has(r) || !medidos.has(r));
        if (sinMirar.length) { c.no_evaluados.push({ ficha: idFicha, proyecto: X, motivo: `${sinMirar.join(', ')} sin medir esta noche` }); continue; }
        c.evaluados++;

        const clase = e.categoria === 'Removed' || !voc.includes(e.motivo) ? 'no-aplica' : 'arreglado';
        const presentes = [...porRepo.values()].filter((x) => proyectoDe(x.repo, cfg) === X);
        const vivas = presentes.filter((x) => !x.declarada);
        if (!presentes.length) continue;                          // pagada en X: el tablero y la medición coinciden
        const anotar = () => { if (!visto) t = ponerLista(t, 'visto_cerrado', [...vistos, `${X}: ${hoy}`]); };
        if (!vivas.length) {
          anotar();
          c.cerrados_con_deuda.push({ ...par, estado: e.estado, motivo: e.motivo, clase,
            vence: presentes.map((x) => x.vence || 'sin fecha').sort()[0] });
          continue;
        }
        let desde = visto ? visto.slice(X.length + 2).trim() : null;
        if (desde !== null && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
          // Una fecha que no se puede leer (editada a mano, vacía) no puede trabar la gracia para siempre:
          // se reescribe con hoy y la gracia vuelve a empezar.
          t = ponerLista(t, 'visto_cerrado', [...vistos.filter((l) => !l.startsWith(`${X}: `) && l !== `${X}:`), `${X}: ${hoy}`]);
          desde = null;
          c.en_gracia.push({ ...par, estado: e.estado, motivo: e.motivo, clase, visto_cerrado: hoy });
          continue;
        }
        if (!desde || !(hoy > desde)) {
          anotar();
          c.en_gracia.push({ ...par, estado: e.estado, motivo: e.motivo, clase, visto_cerrado: desde || hoy });
          continue;
        }
        c.cerrados_vivos.push({ ...par, estado: e.estado, motivo: e.motivo, clase, visto_cerrado: desde,
          repos: vivas.map((x) => x.repo).sort(), avisar: !avisados.some((l) => l.startsWith(`${X} (`)) });
      }
      if (escribir && t !== txt) fs.writeFileSync(archivo, t);
    }
  }
  const orden = (a, b) => String(a.ficha).localeCompare(String(b.ficha)) || String(a.proyecto).localeCompare(String(b.proyecto));
  for (const k of ['cerrados_vivos', 'en_gracia', 'cerrados_con_deuda', 'reabiertos', 'resueltas_con_pedido_abierto', 'no_leidos', 'no_evaluados']) c[k].sort(orden);
  return c;
}

/**
 * ¿Algo del estado de los pedidos impide archivar esta ficha como `ignorado`? El motivo, o `null`.
 * `ignorado` mide «nadie la miró»: con pedidos, eso sólo se puede afirmar habiendo MIRADO el pedido.
 */
function motivoParaNoIgnorar(pedidos, volcado, hoy) {
  if (!(volcado && volcado.consultado === true && volcado.pedidos && typeof volcado.pedidos === 'object')) {
    return `sin volcado legible del estado de los pedidos (${(volcado && volcado.motivo) || 'sin volcado'})`;
  }
  for (const { proyecto, id } of pedidos) {
    const e = volcado.pedidos[claveDePedido(volcado, proyecto, id)];
    if (!e || e.leido !== true) return `no pude leer el pedido de ${proyecto}`;
    if (CATEGORIAS_CERRADAS.includes(e.categoria)) return `el pedido de ${proyecto} está cerrado`;
    if (!CATEGORIAS_ABIERTAS.includes(e.categoria)) return `no pude leer el pedido de ${proyecto} (categoría ${e.categoria})`;
    if (e.cambiado_por_persona_el) {
      const d = diasEntre(String(e.cambiado_por_persona_el).slice(0, 10), hoy);
      if (!(d >= DIAS_PARA_IGNORADO)) return `${proyecto}: una persona lo tocó hace ${d} días`;
    }
  }
  return null;
}

function imprimirCorrida(s, aAnunciar, postergados) {
  console.log(`Revisión nocturna de dependencias — ${s.fecha}`);
  // Con los formularios descubiertos hay más carpetas medidas que entradas: se cuenta sobre lo auditado.
  console.log(`Repos mirados: ${s.repos.filter((r) => r.medido).length}/${s.repos.length}${s.repos_apagados.length ? ` (${s.repos_apagados.length} apagado[s] a propósito)` : ''}`);
  if ((s.carpetas || []).length) {
    console.log(`Carpetas con lockfile: ${s.carpetas.map((c) => (c.total === null ? `${c.repo} sin contar` : `${c.repo} ${c.miradas} de ${c.total}`)).join(' · ')}`);
    for (const c of s.carpetas) for (const x of c.excluidas) console.log(`   ${c.repo}/${x.path} excluida: ${x.reason}`);
    for (const c of s.carpetas) for (const x of c.sin_efecto || []) console.log(`   ⚠️ ${c.repo}/${x.path}: exclusión sin efecto — ${x.motivo}`);
    for (const c of s.carpetas.filter((x) => x.nuevas)) {
      console.log(`🆕 ${c.repo}: ${c.nuevas} carpeta(s) nueva(s), ${c.altas_nuevas} alta(s) o crítica(s) que nadie miraba — las altas entran a la cola desde mañana`);
    }
  }
  if (s.linea_base) console.log('🟡 Primera ejecución: esto es la LÍNEA BASE. No se anuncia nada — no hay contra qué comparar.');
  else console.log(`Comparado contra ${s.comparado_contra}.`);
  for (const nm of s.no_medidos) console.log(`🚧 NO MEDIDO — ${nm.ruta}: ${nm.motivo}`);
  // 🔴 Se dice QUÉ se auditó. "Miré lo publicado con lo último traído" y "miré el origin/main que
  // había en el disco" no son lo mismo, y un informe que no los distingue deja creer lo primero.
  const sinTraer = (s.repos || []).filter((r) => r.medido && r.trajo_lo_ultimo === false).map(rutaCompleta);
  if ((s.repos || []).some((r) => r.medido)) {
    console.log(`Se auditó lo PUBLICADO (origin/main) de cada repo, en un árbol temporal.`);
    if (sinTraer.length) console.log(`   ⚠️ sin poder traer lo último de: ${sinTraer.join(', ')} — se auditó el origin/main que había en el disco.`);
  }
  if (!s.corrida_completa && !s.linea_base) console.log('⚠️ Ejecución INCOMPLETA: no sirve de línea base para mañana.');

  const graves = s.hallazgos.length;
  if (!graves) { console.log('✅ Sin altas ni críticas fuera de lo declarado.'); }
  else {
    console.log(`\n${graves} hallazgo(s) alto/crítico fuera de lo declarado:`);
    for (const h of s.hallazgos) {
      const marca = aAnunciar.includes(h) ? '📣' : (h.anunciado ? '·' : '⏳');
      console.log(`  ${marca} ${h.paquete} [${h.severidad}] · ${h.repos.length} repo(s): ${h.repos.join(', ')} · noche ${h.noches}`);
    }
  }
  if (postergados.length) console.log(`\n⏳ ${postergados.length} postergado(s) por el presupuesto de ruido — entran primero mañana, no se pierden.`);
  if (s.resueltos_ids && s.resueltos_ids.length) console.log(`\n✅ ${s.resueltos_ids.length} borrador(es) RESUELTO(s): la vulnerabilidad dejó de aparecer con todos sus repos medidos — ${s.resueltos_ids.join(', ')}`);
  const rt = s.resolver_tras || {};
  if (rt.n === null) console.log(`⚠️ ${rt.motivo}: esta noche no se resolvió ninguna ficha (${(s.sin_resolver_por_configuracion || []).length} esperaban). No medido nunca es limpio.`);
  if ((s.esperando_resolver || []).length) console.log(`⏳ ${s.esperando_resolver.length} ficha(s) sin aparecer, contando sus ${rt.n} noches para darse por resueltas: ${s.esperando_resolver.map((x) => `${x.id} (${x.noches_sin_aparecer}/${x.n})`).join(', ')}`);
  if ((s.fichas_ilegibles || []).length) console.log(`⚠️ ${s.fichas_ilegibles.length} ficha(s) que no se pudieron leer (las demás siguieron): ${s.fichas_ilegibles.join(', ')}`);
  // 🔴 Descartar por deuda declarada NO es un arreglo: es una decisión de postergar, con fecha. Se
  // dice con otras palabras a propósito, porque contarlo como trabajo real es el defecto 2.
  if (s.descartados_ids && s.descartados_ids.length) console.log(`\n🗂️ ${s.descartados_ids.length} ficha(s) DESCARTADO por deuda declarada (la vulnerabilidad sigue ahí, con plazo) — ${s.descartados_ids.join(', ')}`);
  if (s.reaparecidos_ids && s.reaparecidos_ids.length) console.log(`\n♻️ ${s.reaparecidos_ids.length} ficha(s) cerrada(s) que REAPARECIÓ: se reactiva la misma, no nace otra — ${s.reaparecidos_ids.join(', ')}`);
  for (const x of s.anexados || []) console.log(`\n🔗 aviso nuevo ${x.id} anexado a la ficha ${x.ficha}: es el mismo paquete en el mismo proyecto, no una ficha nueva.`);
  const bloqueadas = (s.aceptadas_sin_resolver || []).filter((x) => x.bloqueada_por);
  for (const x of bloqueadas) console.log(`\n⏸️ ${x.id} (${x.paquete}) aceptada sin resolver, bloqueada por repo apagado: ${x.bloqueada_por}`);
  if (s.rechazadas_sin_deuda_ids && s.rechazadas_sin_deuda_ids.length) console.log(`\n⚠️ ${s.rechazadas_sin_deuda_ids.length} ficha(s) rechazada(s) sin deuda declarada — siguen vivas: ${s.rechazadas_sin_deuda_ids.join(', ')}`);
  if (s.ignorados_ids && s.ignorados_ids.length) console.log(`\n🗄️ ${s.ignorados_ids.length} borrador(es) archivado(s) como IGNORADO: nadie los miró en ${DIAS_PARA_IGNORADO} días.`);
  const cr = s.cruce;
  if (cr) {
    const L = (xs) => xs.map((x) => `${x.ficha} en ${x.proyecto} (Bug ${x.pedido}${x.clase ? `, ${x.clase}` : ''})`).join(' · ');
    if (cr.cerrados_vivos.length) console.log(`\n🔴 ${cr.cerrados_vivos.length} pedido(s) CERRADO(s) con la vulnerabilidad VIVA — ${L(cr.cerrados_vivos)}`);
    if (cr.en_gracia.length) console.log(`\n⏳ ${cr.en_gracia.length} en gracia (pedido cerrado con la vulnerabilidad viva: se avisa si la noche que viene sigue igual) — ${L(cr.en_gracia)}`);
    if (cr.reabiertos.length) console.log(`\n↩️ ${cr.reabiertos.length} reabierto(s) — ${L(cr.reabiertos)}`);
    if (cr.resueltas_con_pedido_abierto.length) console.log(`\n🟡 ${cr.resueltas_con_pedido_abierto.length} resuelta(s) con pedido abierto — ${L(cr.resueltas_con_pedido_abierto)}`);
    if (cr.no_leidos.length) console.log(`\n🚧 ${cr.no_leidos.length} pedido(s) NO LEÍDO(s) — no se puede decir que coincidan${cr.consultado ? '' : `: ${cr.motivo}`}`);
    if (cr.huerfanos.length) console.log(`\n🧷 ${cr.huerfanos.length} Bug(s) del arnés que ninguna ficha nombra — ${cr.huerfanos.map((x) => `${x.id} en ${x.proyecto}`).join(' · ')}`);
    if (cr.huerfanos_no_consultados.length) console.log(`\n🚧 no se pudo buscar Bugs sueltos en ${cr.huerfanos_no_consultados.map((x) => x.proyecto).join(', ')} — no se puede decir que no haya`);
  }
  console.log(`\n--- anunciar ---`);
  for (const h of aAnunciar) console.log(h.id);
}

// ── el texto del pull request ──────────────────────────────────────────────────────────────────

/**
 * `note` — LO ÚNICO QUE ESCRIBE LA FICHA desde afuera de una corrida.
 *
 * El paso de pull request de los dos pipelines vive en un guion compartido
 * (`scripts/ci/open-pr-per-finding.sh`) que no conoce el formato de ninguna de las dos colas: lee
 * `pr:` y `veredicto:` por línea y para TODO lo demás llama acá. Si el compartido escribiera la
 * ficha con `sed`, el formato quedaría descrito en dos lugares y se separarían solos.
 *
 * 🔴 El rechazo NO archiva la ficha: la vulnerabilidad es un hecho MEDIDO y
 * rechazar el aviso no la saca de `main`. La ficha sigue viva y sale por medición (`resuelto:`) o
 * por deuda declarada en todos sus repos. Es lo contrario que en el vigilante, donde un borrador
 * es una hipótesis y descartarla es una decisión completa — cada cola tiene su consecuencia.
 */
function anotar(a) {
  if (!a.ficha || !fs.existsSync(a.ficha)) {
    console.error(`error: falta --card <archivo existente>\n\n${AYUDA}`); return 2;
  }
  const acciones = [a.pr !== null, a.rechazado !== null, a.prCerrado !== null, a.quitarRechazo, !!a.alineado];
  if (!acciones.some(Boolean)) { console.error(`error: note sin acción\n\n${AYUDA}`); return 2; }
  if (a.pr !== null && !/^\d+$/.test(String(a.pr))) {
    console.error(`error: --pr tiene que ser el número del pull request, no «${a.pr}»`); return 2;
  }
  if (a.prRepo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(a.prRepo))) {
    console.error(`error: --pr-repo espera <dueño>/<repo>, no «${a.prRepo}»`); return 2;
  }
  if (a.alineado !== undefined && !/^\d+:(merged|closed|reopened)$/.test(String(a.alineado))) {
    console.error(`error: --aligned espera <número>:<merged|closed|reopened>, no «${a.alineado}»`); return 2;
  }
  if (a.rechazado !== null && !/^\d{4}-\d{2}-\d{2}$/.test(a.rechazado)) {
    console.error(`error: --rejected espera una fecha YYYY-MM-DD, no «${a.rechazado}»`); return 2;
  }

  let txt = fs.readFileSync(a.ficha, 'utf8');
  if (a.pr !== null) txt = ponerEscalar(txt, 'pr', String(Number(a.pr)));
  // El repo del pull request (GitHub): sin él, el `pr:` es de Azure o de otro repo y no se consulta.
  if (a.prRepo !== undefined) txt = ponerEscalar(txt, 'pr_repo', a.prRepo);
  if (a.alineado) txt = ponerEscalar(txt, 'alineado', a.alineado);
  if (a.quitarRechazo) { txt = quitarClave(txt, 'rechazado'); txt = quitarClave(txt, 'motivo_rechazo'); }
  if (a.rechazado !== null) {
    // Idempotente a propósito: la segunda noche vuelve a ver el mismo PR abandonado y no puede
    // reescribir el motivo (un `note` que reescribe hace ruido en el diff de `main` cada noche).
    if (!reEscalar('rechazado').test(txt)) {
      txt = ponerEscalar(txt, 'rechazado', a.rechazado);
      txt = ponerEscalar(txt, 'motivo_rechazo', unaLinea(a.motivo || 'sin motivo escrito'));
    }
  }
  if (a.prCerrado !== null) txt = ponerEscalar(txt, 'pr_cerrado', a.prCerrado);
  escribirSiCambio(a.ficha, txt);
  return 0;
}

/**
 * El comentario de una persona, en UNA línea y entrecomillado.
 *
 * 🔴 Los cuatro lectores por expresión regular de la ficha leen línea a línea, así que un motivo
 * con saltos rompería a todos. Y el `#` de un comentario de pull request se leería como comentario
 * de YAML —`leerFicha` corta ahí— dejando el motivo mutilado justo en el dato que explica la
 * decisión: por eso va entre comillas. Las comillas dobles de adentro pasan a simples (comillas
 * anidadas cortarían el valor) y se recorta a 200: la ficha viaja por git a todas las máquinas.
 */
function unaLinea(t) {
  const limpio = String(t).replace(/[\r\n\t]+/g, ' / ').replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  return `"${(limpio.length > 198 ? `${limpio.slice(0, 195)}...` : limpio) || 'sin motivo escrito'}"`;
}

function prTexto(a) {
  if (!a.borrador || !fs.existsSync(a.borrador)) { console.error('error: falta --draft <archivo> existente'); return 2; }
  const destino = a.destino === undefined ? 'pr' : a.destino;
  if (destino !== 'pr' && destino !== 'pr-github') {
    console.error(`error: --destination espera pr o pr-github, no «${destino}»`); return 2;
  }
  const txt = fs.readFileSync(a.borrador, 'utf8');
  const campo = (k) => (txt.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [, ''])[1].trim();
  const lista = (k) => {
    const re = new RegExp(`^${k}:\\n((?:\\s+- .*\\n)+)`, 'm');
    const m = txt.match(re);
    return m ? m[1].split('\n').filter(Boolean).map((l) => l.replace(/^\s*-\s*/, '')) : [];
  };
  const paquete = campo('paquete'), sev = campo('severidad'), noches = campo('noches');
  const repos = lista('repos'), avisos = lista('avisos');
  // 🔴 Una ficha sin repos no es un pedido: no hay dónde arreglar nada. Sin texto, el guion de pull requests no abre
  // uno vacío y lo cuenta como fallo — que una ficha llegue así es un error de la noche, no algo para decidir.
  if (!repos.length) {
    console.error(`error: la ficha ${a.borrador} no nombra ningún repo (repos: vacío): no se arma el texto del pull request`);
    return 1;
  }

  console.log(`Dependencia vulnerable: ${paquete} (${sev}) — ${repos.length} repo(s)`);
  console.log('---CUERPO---');
  const prAntes = campo('pr_antes'), rechAntes = campo('rechazado_antes');
  const porQue = campo('motivo_rechazo_antes').replace(/^"([\s\S]*)"$/, '$1');
  const prRepoAntes = campo('pr_repo_antes');
  const pedidos = leerPedidos(txt);
  const d = { paquete, sev, noches, repos, avisos, prAntes, rechAntes, porQue, prRepoAntes, prRepo: a.prRepo, pedidos };
  for (const l of cuerpoDeFicha(d, { destino })) {
    console.log(l);
  }
  return 0;
}

/**
 * El texto de una ficha, en LÍNEAS — UNA sola generación para los dos lugares donde se lee.
 *
 * El pedido de trabajo del líder (un Bug en el proyecto del cliente) cuenta lo
 * mismo que el pull request del arnés, y dos plantillas del mismo texto se separan solas. La parte común
 * —paquete, repos, avisos, noches— es UNA; lo que cambia es qué se decide y dónde:
 *
 *   destino 'pr'      → markdown. 🔴 La salida de `pr-text` es BYTE A BYTE la del texto dorado
 *                       (caso T26 de scripts/tests/work-items.test.sh).
 *   destino 'pr-github' → el pull request de GitHub: los nombres de afuera escapados como en 'issue',
 *                       `#N` en vez de `!N` y los issues de la ficha (`pedidos:`) en una lista sin
 *                       palabras de cierre: mergearlo no cierra el issue del producto.
 *   destino 'pedido'  → las mismas líneas para el Bug; `aHtml` las convierte, porque Repro Steps y
 *                       Descripción son campos HTML y el markdown se vería crudo en el formulario.
 *
 * `repos` es la lista que corresponde AL DESTINO: el pedido de un proyecto lleva sólo sus repos.
 */
function cuerpoDeFicha(d, { destino = 'pr' } = {}) {
  const repos = d.repos || [], avisos = d.avisos || [];
  // En un issue de GitHub, un `@algo` de un nombre de paquete menciona a una cuenta y un `#123` enlaza otro
  // issue. Los nombres que vienen de afuera van en código: ahí GitHub no hace ninguna de las dos cosas.
  const issue = destino === 'issue';
  const github = destino === 'pr-github';
  const cod = (s) => (issue || github ?`\`${String(s).replace(/`/g, "'")}\`` : s);
  // En el pull request de GitHub, además, todo lo que la ficha trae como texto libre va en código: la severidad, las
  // noches y el motivo de un rechazo anterior (que escribió cualquiera que comente) no pueden mencionar a nadie.
  const gh = (s) => (github ? cod(s) : s);
  const L = [
    `Se publicó un aviso de seguridad que alcanza a **${cod(d.paquete)}** (severidad ${gh(d.sev)}) y que`,
    `hoy toca ${repos.length} repo(s) del equipo. El código no cambió: cambió lo que se sabe del paquete.`,
    '',
    '**Repos alcanzados**',
    ...repos.map((r) => `- ${cod(r)}`),
    '',
    '**Avisos**',
    // Sin enlaces, el mismo marcador que escribe la ficha: un título «Avisos» sin nada debajo se lee
    // como un texto roto. Con la ficha de siempre esto no cambia nada.
    // un enlace a la base de avisos de GitHub no menciona ni enlaza nada más: va como enlace; lo demás, en código
    ...(avisos.length ? avisos.map((u) => (/^https:\/\/github\.com\/advisories\/GHSA-[A-Za-z0-9-]+$/.test(String(u)) ? u : cod(u)))
      : ['(el informe no trajo enlace)']).map((u) => `- ${u}`),
    '',
    `Detectado hace ${gh(d.noches)} noche(s) seguida(s).`,
    '',
  ];
  if (issue) {
    const ids = avisos.map((u) => String(u).split('/').pop()).filter((x) => /^GHSA-/i.test(x));
    L.push(
      '**Qué hacer**',
      '- **Arreglarlo** = subir el paquete en este repo hasta una versión que el aviso dé por corregida. Cuando la revisión nocturna deje de verlo en `main`, este issue se cierra solo, con un comentario: cuándo llega a producción lo decide el equipo.',
      '- **Declararlo como deuda** = si no viaja al navegador ni al servidor, anotarlo en el `vulnerabilidades-pendientes.json` del repo, con motivo y fecha de revisión (el issue queda abierto: la deuda no es un arreglo):',
      '```',
      JSON.stringify({ revision: 'AAAA-MM-DD', paquetes: [{ paquete: d.paquete, advisories: ids, motivo: 'por qué no aplica' }] }, null, 2),
      '```',
      '- **No aplica** = cerrarlo como «not planned». La revisión nocturna lo va a decir una vez mientras la vulnerabilidad siga en `main`: la salida sin arreglo es declarar la deuda.',
      '',
      `_Lo abrió la revisión nocturna de dependencias del arnés (ficha \`arnes:${d.id}\`). Cerrarlo como arreglado a mano no cierra el hallazgo: se cierra cuando la vulnerabilidad deja de aparecer, medida de noche._`,
    );
    return L;
  }
  if (destino === 'pedido') {
    // El formato de la deuda es el REAL de `vulnerabilidades-pendientes.json` (revision, paquetes[],
    // advisories por identificador, motivo): una declaración que no nombra los avisos no ampara nada.
    const ids = avisos.map((u) => String(u).split('/').pop()).filter((x) => /^GHSA-/i.test(x));
    L.push(
      '**Qué hacer**',
      '- **Arreglarlo** = subir el paquete en los repos de arriba hasta una versión que el aviso dé por corregida. Cuando la revisión nocturna deje de verlo en `main` en este proyecto, este Bug se cierra solo, con un comentario: cuándo llega a producción lo decide el equipo.',
      '- **Declararlo como deuda** = si no viaja al navegador ni al servidor, anotarlo en el `vulnerabilidades-pendientes.json` del repo, con motivo y fecha de revisión (el Bug queda abierto: la deuda no es un arreglo):',
      '```',
      JSON.stringify({ revision: 'AAAA-MM-DD', paquetes: [{ paquete: d.paquete, advisories: ids, motivo: 'por qué no aplica' }] }, null, 2),
      '```',
      '',
      `_Lo abrió la revisión nocturna de dependencias del arnés (ficha \`arnes:${d.id}\`). Cerrarlo a mano no cierra el hallazgo: se cierra cuando la vulnerabilidad deja de aparecer, medida de noche._`,
    );
    return L;
  }
  // 🔴 Una ficha REACTIVADA no llega virgen: ya se decidió una vez sobre ella. Sin
  // decirlo, quien recibe este pull request vuelve a decidir a ciegas lo mismo que ya decidió, y
  // el arnés parece insistir sin memoria — la forma más rápida de que se deje de mirar la lista.
  if (d.prAntes && d.rechAntes) {
    // En GitHub el número va con `#`; si el pull request anterior era de otro repo, con el repo delante.
    const antes = github
      ? `${d.prRepoAntes && d.prRepoAntes !== d.prRepo ? d.prRepoAntes : ''}#${d.prAntes}` : `!${d.prAntes}`;
    L.push(`⚠️ Ya se había rechazado el ${gh(d.rechAntes)} (PR ${antes}): «${gh(d.porQue)}»`, '');
  }
  // sólo los pedidos que nombran un repo `<dueño>/<repo>`: el enlace al issue es lo único que se escribe sin código
  const issuesGh = github ? (d.pedidos || []).filter((p) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.proyecto)) : [];
  if (issuesGh.length) {
    L.push('**Issues de este hallazgo**', ...issuesGh.map((p) => `- ${p.proyecto}#${p.id}`),
      '_Mergear o cerrar este pull request decide el hallazgo; la revisión nocturna actualiza esos issues para que coincidan._', '');
  }
  L.push(
    '**Qué decidir acá**',
    '- **Mergear** = es trabajo real: hay que subir el paquete. El borrador pasa a `promoted/`.',
    '- **Rechazar** = no aplica, y el comentario es el motivo. Si la razón es que no viaja al',
    '  navegador ni al servidor, lo correcto es **declararlo** en el `vulnerabilidades-pendientes.json`',
    '  del repo, con motivo y fecha de revisión — así deja de despertar a nadie sin volverse',
    '  permanente en silencio.',
    '',
    '_Este pull request no cambia código: transporta la decisión. Lo abrió la revisión nocturna',
    'de dependencias (`scripts/nightly/dependencies/`)._',
  );
  return L;
}

/**
 * Las líneas de `cuerpoDeFicha` en HTML, para un campo de Azure DevOps.
 *
 * Sólo el subconjunto que el generador usa: párrafos, listas `- `, bloques ```, `**negrita**`,
 * `código`, enlaces y la línea entera entre `_…_`. Todo se escapa ANTES de marcar: el texto trae
 * nombres de paquete y URLs que vienen de afuera, y un `<` suelto rompería el campo.
 */
function aHtml(lineas) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const enLinea = (s) => {
    if (/^_.+_$/.test(s)) return `<em>${enLinea(s.slice(1, -1))}</em>`;
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  };
  const out = [];
  let parrafo = [], lista = null, pre = null;
  const cerrarParrafo = () => { if (parrafo.length) out.push(`<p>${enLinea(parrafo.join(' '))}</p>`); parrafo = []; };
  const cerrarLista = () => { if (lista) out.push(`<ul>${lista.map((li) => `<li>${enLinea(li)}</li>`).join('')}</ul>`); lista = null; };
  for (const l of lineas) {
    if (pre) {
      if (/^```/.test(l)) { out.push(`<pre>${esc(pre.join('\n'))}</pre>`); pre = null; } else pre.push(l);
      continue;
    }
    if (/^```/.test(l)) { cerrarParrafo(); cerrarLista(); pre = []; continue; }
    if (/^- /.test(l)) { cerrarParrafo(); (lista = lista || []).push(l.slice(2)); continue; }
    if (lista && /^\s+\S/.test(l)) { lista[lista.length - 1] += ` ${l.trim()}`; continue; }
    if (!l.trim()) { cerrarParrafo(); cerrarLista(); continue; }
    cerrarLista();
    parrafo.push(l);
  }
  if (pre) out.push(`<pre>${esc(pre.join('\n'))}</pre>`);
  cerrarParrafo(); cerrarLista();
  return out.join('\n');
}

/**
 * La lista `pedidos:` de una ficha → `[{ proyecto, id }]`.
 *
 * Cada línea es `<Proyecto>: <id>` y el proyecto PUEDE tener espacios (`Acme Web: 123`), así que
 * se parte en el ÚLTIMO `: `. Una línea que no termina en un número no es un pedido: se ignora acá y
 * el guion de pedidos la trata como «sin pedido» (mejor volver a preguntar —la etiqueta en Azure
 * evita el duplicado— que dar por pedido algo que no se puede leer).
 */
function leerPedidos(txt) {
  return listaDe(txt, 'pedidos').map((l) => {
    const i = l.lastIndexOf(': ');
    if (i <= 0) return null;
    const id = l.slice(i + 2).trim();
    return /^\d+$/.test(id) ? { proyecto: l.slice(0, i).trim(), id: Number(id) } : null;
  }).filter(Boolean);
}

// ── qué clona el pipeline ──────────────────────────────────────────────────────────────────────

/**
 * La lista de clones para Azure DevOps: `ruta<TAB>ado` por cada repo ACTIVO, cada ruta UNA vez.
 * Dos entradas que comparten `ruta` (la raíz y una subcarpeta) son un solo clon: si el pipeline
 * clonara por entrada, el segundo `git clone` fallaría con "destination path already exists" y el
 * repo figuraría como NO clonado siendo que sí está. Un apagado no se clona.
 */
function clones(a) {
  const cfg = leerJson(a.config, null);
  if (!cfg) { console.error(`error: no se pudo leer la configuración ${a.config}`); return 2; }
  const vistas = new Set();
  for (const r of cfg.repos || []) {
    if (r.activo === false || !r.ruta || vistas.has(r.ruta)) continue;
    vistas.add(r.ruta);
    // Una entrada de GitHub da `<dueño>/<repo>`. Dos columnas siempre: el modelo de Azure lee dos.
    console.log(`${r.ruta}\t${r.ado || r.github || ''}`);
  }
  return 0;
}

// ── la medición de la propia pieza ─────────────────────────────────────────────────────────────

function report(a) {
  const leerDir = (sub) => {
    const d = path.join(a.pending, sub);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith('.yaml')).flatMap((f) => {
      let t;
      try { t = fs.readFileSync(path.join(d, f), 'utf8'); } catch {
        console.error(`⚠️ ficha que no se pudo leer: ${sub}/${f} (no entra en la cuenta)`);
        return [];
      }
      const fi = leerFicha(t);
      return [{
        id: f.replace(/\.yaml$/, ''), estado: sub,
        veredicto: fi.escalares.veredicto || '', severidad: fi.escalares.severidad || '',
        paquete: fi.escalares.paquete || '', resuelto: fi.escalares.resuelto || '',
        motivo: fi.escalares.motivo || '', bloqueada_por: fi.escalares.bloqueada_por || '',
        rechazado: fi.escalares.rechazado || '',
      }];
    });
  };
  const todos = [...leerDir('pending'), ...leerDir('promoted'), ...leerDir('archived')];

  // 🔴 EL CONTADOR CUENTA ARREGLOS, NO DECISIONES.
  //
  // El "trabajo real" NO es toda la carpeta `promoted/`, o sea toda ficha cuyo pull
  // request alguien mergeó: mergear ese pull request quiere decir "sí, hay que arreglarlo",
  // no "está arreglado".
  // Un tablero que llama "trabajo real" a una intención mide
  // exactamente lo contrario de lo que promete.
  const promovidas = todos.filter((x) => x.estado === 'promoted');
  const trabajo_real = promovidas.filter((x) => x.resuelto).length;
  const sinResolver = promovidas.filter((x) => !x.resuelto);
  const aceptadas_sin_resolver = sinResolver.length;
  const bloqueadas_por_repo_apagado = sinResolver.filter((x) => x.bloqueada_por).length;
  const archivadas = todos.filter((x) => x.veredicto === 'descartado');
  // Una deuda declarada se archiva con un motivo exacto que escribe el guion. El descarte de una
  // PERSONA es cualquier otro motivo.
  const porDeuda = archivadas.filter((x) => /^declarada/.test(x.motivo));
  const descartadas_por_deuda = porDeuda.length;
  const descartadas = archivadas.length - descartadas_por_deuda;
  const ignoradas = todos.filter((x) => x.veredicto === 'ignorado').length;
  const pendientes = todos.filter((x) => x.estado === 'pending').length;
  // 🔴 Se cuenta ADEMÁS dentro de `pendientes`, no aparte: son fichas vivas, y sacarlas del total
  // haría que rechazar el aviso pareciera cerrarlo — que es exactamente lo que NO pasa (la
  // vulnerabilidad sigue en `main`). Una rechazada cuya deuda se declara en todos sus repos se
  // archiva por deuda y sale sola de esta lista.
  const rechazadas_sin_deuda = todos.filter((x) => x.estado === 'pending' && x.rechazado).length;

  if (a.json) {
    console.log(JSON.stringify({
      total: todos.length, trabajo_real, aceptadas_sin_resolver, bloqueadas_por_repo_apagado,
      descartadas, descartadas_por_deuda, ignoradas, pendientes, rechazadas_sin_deuda,
    }, null, 2));
    return 0;
  }

  console.log('¿Sirve la revisión nocturna de dependencias?\n');
  console.log(`  Hallazgos totales      : ${todos.length}`);
  console.log(`  Trabajo real           : ${trabajo_real}   (la vulnerabilidad DESAPARECIÓ, medida)`);
  console.log(`  Aceptadas sin resolver : ${aceptadas_sin_resolver}   (se decidió arreglarlas y todavía aparecen${bloqueadas_por_repo_apagado ? `; ${bloqueadas_por_repo_apagado} bloqueada(s) por repo apagado` : ''})`);
  console.log(`  Descartadas            : ${descartadas}   (veredicto 'descartado' con motivo — señal BUENA: alguien lo leyó y decidió)`);
  console.log(`  Descartadas por deuda  : ${descartadas_por_deuda}   (declarada con plazo — NO es un arreglo, y no cuenta en el denominador)`);
  console.log(`  🔴 Ignoradas           : ${ignoradas}   (veredicto 'ignorado': nadie las miró en ${DIAS_PARA_IGNORADO} días — cuenta PEOR que descartado)`);
  console.log(`  Pendientes             : ${pendientes}`);
  console.log(`  Rechazadas sin deuda   : ${rechazadas_sin_deuda}   (una persona rechazó el PR y nadie declaró la deuda: sigue viva)`);

  // 🔴 Lo descartado por deuda no cuenta ni como trabajo real ni como ignorado NI en el
  // denominador: nadie decidió que la pieza se equivocó, se decidió postergar con fecha.
  const decididos = trabajo_real + aceptadas_sin_resolver + descartadas + ignoradas;
  if (decididos >= 10 && (trabajo_real / decididos) < 0.2) {
    console.log('\n🔴 Sobre 10 o más decididos, menos del 20% terminó en trabajo real: el umbral está mal.');
    console.log('   La pieza NO se ajusta sola — proponer el cambio y que una persona lo confirme con un commit.');
  }
  if (ignoradas > trabajo_real && decididos >= 5) {
    console.log('\n🔴 Se ignoran más de las que se usan: eso es la casilla que nadie mira. Criterio de retiro.');
  }
  return 0;
}

const AYUDA = `nightly-dependencies.js — la revisión nocturna de dependencias del arnés.

  run       mira los repos de repos.json, compara contra anoche y deja los borradores
  pr-text   --draft <archivo> [--destination pr|pr-github] [--pr-repo <dueño>/<repo>]
                                   arma título y cuerpo del pull request (por defecto el de Azure)
  note      --card <archivo>       escribe en la ficha lo que decidió una persona sobre su PR
  report    ¿sirve esta pieza? — desglosado, con criterio de retiro
  clone-list lista "ruta<TAB>ado" de lo que el pipeline tiene que clonar (cada ruta una vez)

Una entrada de repos.json puede llevar "subruta" (2026-09-05): "ruta" sigue siendo la raíz del repo
—de ahí se prepara el árbol de origin/main— y se audita la subcarpeta adentro de ese árbol, con su
propio lockfile y su propio vulnerabilidades-pendientes.json (caso: el gateway de mensajería de
Acme, tools/chat-gateway). Si la subcarpeta no está en lo publicado: NO MEDIDO, nunca la raíz.

En un repo cuya raíz es una entrada npm, la noche audita además cada carpeta con package-lock.json
de origin/main, fuera de node_modules (cada formulario, con la etiqueta producto/repo/carpeta). Para
no mirar una: "exclude": [{ "path": "<carpeta>", "reason": "<motivo>" }] en esa entrada; sin
"reason" la ejecución sale 2.

  --root <dir>     dónde están los repos (por defecto, el de repos.json)
  --out <dir>      dónde va el snapshot (por defecto .dashboard/dependencias)
  --pending <dir>  dónde van los borradores (por defecto inbox/dependencies/)
  --operations <f> de dónde sale N, las noches medidas sin aparecer que resuelven una ficha
                   (findings.resolve_after_nights; por defecto operations.json de la raíz; sin él, 3)
  --today <fecha>  fija la fecha de la ejecución (sólo para pruebas)
  --dry-run        dice qué haría sin escribir nada
  --json           salida en JSON

Opciones de note (las usa scripts/ci/open-pr-per-finding.sh, el guion que comparten los dos
pipelines nocturnos; ninguna toca la red):
  --pr <n>                       la ficha recuerda cuál es su pull request
  --rejected <fecha> --reason <texto> [--pr <n>]
                                 una persona lo rechazó: se anota y la ficha SIGUE VIVA (la
                                 vulnerabilidad es un hecho medido; rechazar el aviso no la arregla)
  --pr-repo <dueño>/<repo>       con --pr: el repo de GitHub donde vive el pull request
  --aligned <n>:<estado>         el issue ya sigue la decisión del pull request n (merged, closed o reopened)
  --clear-rejection              alguien reactivó el pull request en Azure: se borra el rechazo
  --pr-closed <fecha>            cuándo se cerró el pull request de una ficha archivada
Exit en note: 0 escribio (idempotente) · 2 error de uso

Exit en run: 0 midió · 1 no se pudo medir NINGÚN repo · 2 error de uso`;

function main() {
  const a = parseArgs(process.argv);
  if (a.error) { console.error(`error: ${a.error}\n\n${AYUDA}`); return 2; }
  switch (a.cmd) {
    case 'run': return correr(a);
    case 'pr-text': return prTexto(a);
    case 'note': return anotar(a);
    case 'report': return report(a);
    case 'clone-list': return clones(a);
    default: console.log(AYUDA); return a.cmd === 'help' ? 0 : 2;
  }
}

// 🔴 `process.exitCode`, NO `process.exit()`. Este guión lo ejecuta otro proceso y le parsea la
// salida; en Node las escrituras a una tubería son ASINCRÓNICAS y `process.exit()` mata el proceso
// con parte de lo escrito todavía en el aire: un
// informe de 9782 bytes llega cortado en 8192 y el consumidor lo lee como «no pude», nunca como
// un error. `main` acá es sincrónica y no deja manejadores abiertos, así que con `exitCode` el
// proceso termina solo, cuando terminó de escribir.
if (require.main === module) {
  // Los nombres viejos (subcomandos y opciones en castellano) siguen andando hasta el retiro
  require('../../lib/legacy-names.js').aliasArgv('scripts/nightly/dependencies/nightly-dependencies.js', { exitCode: 2, prefix: 'error: ' });
  process.exitCode = main();
}
// Lo que sigue a `parseArgs` lo reusa `work-items.js`: la ficha se lee y se
// escribe con UN solo código, y el texto del Bug sale del mismo generador que el del pull request.
module.exports = { huella, agruparHallazgos, agruparPresencias, proyectoDe, leerFicha, snapshotAnterior, parseArgs, ubicarRepo,
  listaDe, ponerLista, etiqueta, soloRepo, leerTodasLasFichas, leerPedidos, cuerpoDeFicha, aHtml, archivarIgnorados, vigilarFichas,
  proyectoAzureDe, sinPropuesta,
  // el cruce
  presenciaDeFicha, leerVolcado, cruzarPedidos, motivoParaNoIgnorar, CATEGORIAS_ABIERTAS, CATEGORIAS_CERRADAS,
  // GitHub
  pedidosActivos, claveDePedido, vocabularioDeCierre };
