'use strict';
/**
 * scripts/lib/repos-root.js — dónde viven los repos del equipo en ESTA máquina.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 * Los chequeos de memoria de engram recorren los repos para encontrar los `.engram/`. Hasta el
 * 2026-08-25 cada uno hardcodeaba la carpeta de UNA máquina. Eso funciona en la máquina donde se
 * escribió y falla EN SILENCIO en cualquier otra: el escaneo devuelve cero repos, y cero repos se lee
 * exactamente igual que "está todo bien". Es el mismo modo de falla que estos chequeos vinieron a
 * cazar, en la herramienta que los caza — y el equipo tiene máquinas con otra estructura y con Windows.
 *
 * ── UNA SOLA VARIABLE (2026-09-05) ────────────────────────────────────────────────────────────
 * `TYCON_REPOS_ROOT` es LA salida explícita para "dónde están los repos del equipo", y la leen
 * también los revisores que descubren plugins hermanos (`tycon-sibling-pattern-reviewer`,
 * `tycon-story-validator`). El banco de controles la apunta al corral de hermanos en cada corrida
 * (`envDeCorrida` en advisor-runner.js): un revisor bajo el banco NO puede salir a leer los repos
 * reales del dev.
 *
 * ── CÓMO SE RESUELVE (en orden) ──────────────────────────────────────────────────────────────
 *   1. `TYCON_REPOS_ROOT` — explícita. Gana siempre.
 *   2. **El archivo de la máquina** (`~/.claude/tycon.json` → `rutas.repos`, story 8.3): lo que toda
 *      sesión ve, incluidas las de la extensión de VS Code, que no cargan el rc del shell. Un archivo
 *      ROTO no se lee como «sin raíz»: tira `ConfigError` (un comando frena; un hook la atrapa, avisa
 *      y sigue sin raíz — nunca deniega nada por un archivo de configuración).
 *   3. **Las sesiones de la persona.** Cada sesión de Claude Code deja su transcripción en
 *      `~/.claude/projects/<cwd codificado>/` y la cabeza de cada transcripción dice el `cwd`. O sea
 *      que el disco ya sabe en qué repos trabaja esta persona: se toman los repos de esos cwd —el repo que contiene al
 *      cwd, o los repos que el cwd tiene adentro si es la carpeta que los junta—, sin sandboxes del banco ni
 *      temporales, sin `~/.claude`, sin el arnés ni agent-skills (infraestructura), y la raíz es el ancestro MÁS
 *      ALTO por debajo del home (y de sus carpetas personales: Escritorio, Documentos, OneDrive) que contiene a la
 *      mayoría (≥ 50 %) de esos repos. En Windows las rutas se comparan sin distinguir mayúsculas (la letra de
 *      unidad). Se deduce de lo que la persona hace, no de dónde se clonó nada.
 *   4. **La carpeta padre del arnés** — la premisa del onboarding (INSTALL.md) es que el arnés se
 *      clona al lado de los repos. Pero SÓLO si ahí hay al menos otro repo git DE TRABAJO (el clon de
 *      las skills, como el del arnés, es infraestructura y no cuenta): el 2026-09-05 una
 *      máquina tenía el arnés en su carpeta de repos y los proyectos en otra, y esta regla elegía
 *      una carpeta con un solo repo (el arnés) como "la raíz" — cero repos que auditar, y cero se lee
 *      como "todo bien".
 *   5. **La carpeta del clon desde el que se MUDÓ la máquina** (2026-10-14): el estado la recuerda (`migrate_home.from`).
 *      Antes de la mudanza esa carpeta salía en el paso 4; con el arnés en `~/.tycon` se perdía. Mismas condiciones que
 *      el vecino: existe y tiene otros repos de trabajo. (La mudanza, además, la anota en `paths.repos`.)
 *   6. **Sin raíz** (story 8.3, AC 6): `root: null`, `fuente: 'sin-raiz'` y el motivo. Hasta la 8.3
 *      acá había un último recurso escrito a mano —la carpeta de una máquina— que en cualquier otra
 *      inventaba una raíz que no existía; las auditorías que la usan reportan «no medido: sin raíz».
 *
 * Quien lo llama recibe `{ root, fuente, evidencia, motivo }` y puede decir de dónde salió: "raíz
 * deducida de tus sesiones (7 repos)" no es lo mismo que "sin raíz".
 *
 * Uso: node scripts/lib/repos-root.js            → imprime la raíz y de dónde salió (o «sin raíz» y por qué)
 *      node scripts/lib/repos-root.js --plain    → sólo la raíz; exit 3 sin raíz, 2 con la config rota
 *      node scripts/lib/repos-root.js --selftest → se prueba contra casas fabricadas
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV = 'TYCON_REPOS_ROOT';

function real(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }
function esRepoGit(p) { try { return fs.existsSync(path.join(p, '.git')); } catch (_) { return false; } }

/**
 * Las rutas según la plataforma. 🔴 En Windows (2026-10-14) la extensión de VS Code abre Claude Code con la letra de
 * unidad en MINÚSCULA (`c:\Users\…`, como la escribe VS Code), y eso queda en el `cwd` de cada transcripción; el home
 * (`os.homedir()`) viene con mayúscula (`C:\Users\…`) y `fs.realpathSync` no corrige la letra. Comparando con `===`
 * ningún repo quedaba «debajo del home»: cada uno votaba sólo por su carpeta padre, y con los repos repartidos en
 * carpetas de producto ninguna llegaba a la mayoría — «sin sesiones con repos» en una máquina que usa Claude Code todos
 * los días. En otra máquina andaba por casualidad: sus repos estaban en `d:\workspace`, fuera del home, todos con el
 * mismo padre. En Windows las rutas se comparan sin distinguir mayúsculas, y la letra de unidad se escribe en mayúscula.
 */
function rutasDe(platform) {
  const win = platform === 'win32';
  const P = win ? path.win32 : path;
  const llave = (p) => (win ? String(p).toLowerCase() : String(p));
  const canon = (p) => {
    if (!p) return p;
    let s = P.normalize(String(p));
    if (win) s = s.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
    while (s.length > P.parse(s).root.length && /[\\/]$/.test(s)) s = s.slice(0, -1);
    return s;
  };
  const igual = (a, b) => !!a && !!b && llave(a) === llave(b);
  const dentroDe = (p, dir) => {
    if (!p || !dir) return false;
    const a = llave(p), d = llave(dir);
    return a === d || a.startsWith(d.endsWith(P.sep) ? d : d + P.sep);
  };
  return { win, P, llave, canon, igual, dentroDe };
}

/** Las carpetas hijas de `dir` que son repos git (sin las de `excluir`). */
function reposAlLado(dir, { R, fsx, excluir = [] }) {
  return fsx.hijos(dir).filter((p) => fsx.esRepo(p) && !excluir.some((e) => R.dentroDe(fsx.real(p) || p, e)));
}

/**
 * Los repos donde trabajan las sesiones (no infraestructura, no temporales). Un `cwd` cuenta por el repo que lo contiene
 * (una sesión abierta en `<repo>/src` trabaja en `<repo>`) o, si no está dentro de ninguno, por los repos que tiene adentro
 * (una sesión abierta en la carpeta que junta varios repos trabaja en ellos). La sesión abierta en el home no cuenta: no
 * es trabajo en los repos que cuelgan de él.
 * @returns {{ repos: string[], diag: { carpetas: number, cwds: number, sinRepo: number } }}
 */
function reposDeSesiones({ projectsDir, home, tmp, excluir, R, fsx }) {
  const out = new Map();   // llave → ruta
  const diag = { carpetas: 0, cwds: 0, sinRepo: 0 };
  let carpetas;
  try { carpetas = fs.readdirSync(projectsDir); } catch (_) { return { repos: [], diag }; }
  for (const nombre of carpetas) {
    // Filtro barato por el NOMBRE codificado (cada `/` del cwd es un `-`): los sandboxes del banco y
    // los temporales son la mayoría de las ~2000 carpetas de una máquina que corre el banco, y no
    // hace falta abrir ni uno para descartarlos.
    if (/^-(private-)?(var-folders|tmp)(-|$)/.test(nombre) || /--claude(-|$)/.test(nombre)) continue;
    const dir = path.join(projectsDir, nombre);
    let archivos;
    try { archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    if (!archivos.length) continue;
    diag.carpetas++;
    // La transcripción más nueva alcanza: el cwd de una carpeta es siempre el mismo.
    const masNueva = archivos.map((f) => path.join(dir, f))
      .map((f) => { let m = 0; try { m = fs.statSync(f).mtimeMs; } catch (_) { /* 0 */ } return [f, m]; })
      .sort((a, b) => b[1] - a[1])[0][0];
    let cabeza;
    try {
      const fd = fs.openSync(masNueva, 'r'); const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      cabeza = buf.toString('utf8', 0, n);
    } catch (_) { continue; }
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(cabeza);
    if (!m) continue;
    let cwd;
    try { cwd = JSON.parse(`"${m[1]}"`); } catch (_) { continue; }
    const r = fsx.real(cwd);
    if (!r) continue;
    diag.cwds++;
    let candidatos = [];
    if (fsx.esRepo(r)) candidatos = [r];
    else {
      for (let p = R.P.dirname(r); p !== R.P.dirname(p) && !R.igual(p, home); p = R.P.dirname(p)) {
        if (fsx.esRepo(p)) { candidatos = [p]; break; }
      }
      if (!candidatos.length && !R.igual(r, home) && !R.dentroDe(home, r)) candidatos = reposAlLado(r, { R, fsx });
    }
    const validos = candidatos.filter((c) => !R.dentroDe(c, tmp) && !R.dentroDe(c, R.P.join(home, '.claude')) && !excluir.some((e) => R.dentroDe(c, e)));
    if (!candidatos.length) diag.sinRepo++;
    for (const c of validos) if (!out.has(R.llave(c))) out.set(R.llave(c), c);
  }
  return { repos: [...out.values()], diag };
}

// Las carpetas personales que el sistema pone en el home (el Escritorio, Documentos, OneDrive y sus nombres en castellano)
// cuentan como el home: nadie las elige como «la carpeta de los repos», y si la raíz fuera el Escritorio entero los
// repos de `Escritorio/<carpeta>/<producto>/<repo>` quedarían más hondo de lo que miran las auditorías (2026-10-14).
const CARPETA_PERSONAL = /^(desktop|documents|escritorio|documentos|onedrive( - .+)?)$/i;
/** El tope de la subida de un repo bajo el home: el home, o la carpeta personal más honda que lo contiene. */
function topeEnElHome(r, home, R) {
  let tope = home;
  for (;;) {
    const resto = r.slice(tope.length).replace(/^[\\/]+/, '');
    const primera = resto.split(/[\\/]+/)[0];
    if (!primera || !CARPETA_PERSONAL.test(primera) || R.igual(R.P.join(tope, primera), r)) return tope;
    tope = R.P.join(tope, primera);
  }
}

/** El ancestro más alto por debajo del home (y de sus carpetas personales) que contiene a la mayoría de los repos. */
function raizPorMayoria(repos, home, R = rutasDe(process.platform)) {
  if (!repos.length) return null;
  const P = R.P;
  const votos = new Map();   // llave del ancestro → { ruta, n }
  for (const r of repos) {
    const bajoElHome = R.dentroDe(r, home) && !R.igual(r, home);
    let p = P.dirname(r);
    const tope = bajoElHome ? topeEnElHome(r, home, R) : P.dirname(p);   // fuera del home: sólo el padre directo
    while (p && !R.igual(p, tope) && p !== P.dirname(p)) {
      const k = R.llave(p);
      const v = votos.get(k) || { ruta: p, n: 0 };
      v.n++; votos.set(k, v);
      p = P.dirname(p);
    }
  }
  const minimo = Math.ceil(repos.length / 2);
  const hondura = (x) => x.split(/[\\/]+/).filter(Boolean).length;
  const candidatos = [...votos.values()].filter((v) => v.n >= minimo)
    .sort((a, b) => (hondura(a.ruta) - hondura(b.ruta)) || (b.n - a.n) || a.ruta.localeCompare(b.ruta));
  if (candidatos.length) return { root: candidatos[0].ruta, repos: candidatos[0].n };
  // Todos los repos cuelgan DIRECTO del home (o de la misma carpeta personal): la raíz es esa carpeta (sin este caso
  // quedaría sin voto).
  const padre = P.dirname(repos[0]);
  if (repos.every((r) => R.igual(P.dirname(r), padre) && R.igual(padre, R.dentroDe(r, home) ? topeEnElHome(r, home, R) : home))) return { root: padre, repos: repos.length };
  return null;
}

/** `rutas.repos` del archivo de la máquina (nivel 2). Tira ConfigError si el archivo está roto. */
function raizDeLaMaquina({ env, home, clon }) {
  const cfg = require('./tycon-config.js');
  const c = cfg.cargar({ env, home, arnes: clon });
  if (c.errores.length) throw new cfg.ConfigError(c.errores);
  return c.origenes['rutas.repos'] === 'maquina' ? c.valores.rutas.repos : null;
}

/**
 * El clon desde el que se mudó esta máquina a `~/.tycon` (lo anota la mudanza en el estado: `migrate_home.from`; `doctor`
 * lo muestra como «mudada … desde el clon X»), o null. Sólo lee; nunca tira.
 */
function clonDeLaMudanza(home) {
  try {
    const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
    if (!fs.existsSync(lib)) return null;
    const s = JSON.parse(fs.readFileSync(path.join(require(lib).stateDir(home), 'harness-state.json'), 'utf8').replace(/^﻿/, ''));
    const mh = s && s.migrate_home;
    return mh && mh.status === 'done' && typeof mh.from === 'string' && mh.from ? mh.from : null;
  } catch (_) { return null; }
}

/**
 * @param {string} [envValue] override explícito (para tests) — `undefined` lee process.env
 * @param {object} [opts]     home · projectsDir · clon (el arnés) · tmp · env · sinConfig · platform · fsx — inyección para las pruebas
 * @returns {{root: string|null, fuente: 'env'|'maquina'|'sesiones'|'vecino'|'mudanza'|'sin-raiz', evidencia?: number, motivo?: string}}
 * @throws {ConfigError} si `~/.claude/tycon.json` está roto (nivel 2): un comando frena, un hook lo atrapa y avisa
 */
function resolveReposRoot(envValue, opts = {}) {
  const env = opts.env || process.env;
  const R = rutasDe(opts.platform || process.platform);
  const P = R.P;
  // las operaciones de disco que dependen de la forma de las rutas, inyectables para probar las de Windows en otra máquina
  const fsx = Object.assign({
    real: (p) => { const r = real(p); return r ? R.canon(r) : null; },
    esRepo: esRepoGit,
    hijos: (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => P.join(dir, e.name)); } catch (_) { return []; } },
  }, opts.fsx || {});
  const home0 = opts.home || os.homedir();
  const home = fsx.real(home0) || R.canon(home0);
  const v = envValue !== undefined ? envValue : env[ENV];
  // `~` se expande igual que en el lector de configuración (tycon-config.js): una `~` literal llega a la variable
  // por el bloque `env` de settings.json o por `export X="~/…"` con comillas (pase adversarial, vuelta 1).
  if (v && String(v).trim()) {
    const e = String(v).trim().replace(/^~(?=$|[\\/])/, home);
    return { root: P.isAbsolute(e) ? P.normalize(e) : P.join(home, e), fuente: 'env' };   // relativa: contra el HOME, como el lector
  }

  const clon = opts.clon || path.resolve(__dirname, '..', '..');      // <clon>/scripts/lib → el clon
  const projectsDir = opts.projectsDir || path.join(home, '.claude', 'projects');
  const tmp = fsx.real(opts.tmp || os.tmpdir());

  // 2. el archivo de la máquina
  if (!opts.sinConfig) {
    const m = raizDeLaMaquina({ env, home, clon });
    if (m) return { root: m, fuente: 'maquina' };
  }

  // La infraestructura son los DOS clones, en las tres formas de máquina (story 8.18): el del arnés, «donde están las
  // skills» según la regla, y lo INSTALADO en `~/.claude/agent-skills`. Lo instalado va siempre y por su ruta real:
  // desde la 8.18 la regla contesta el propio clon cuando trae `skills/`, y un clon de skills instalado que vive fuera
  // de `~/.claude` (un enlace) dejaba de estar excluido — con un solo producto, su carpeta salía como «la raíz».
  const installed = P.join(home, '.claude', 'agent-skills');
  let skills = installed;
  // 🔴 El valor de siempre (lo instalado) es SÓLO para la copia que viaja sin skills-dir.js al lado. Antes un `catch`
  //    tragaba CUALQUIER error de la regla (segunda vuelta de los revisores del tramo 1 de la story 8.18, 2026-10-04):
  //    skills-dir.js TIRA cuando su vecina canonical-path.js está y no carga, y acá se tapaba — medido: con la regla
  //    rota salía una raíz tranquila, con código 0 y sin una línea. Se mira si el archivo ESTÁ, no el mensaje del
  //    error (el «Require stack» de un MODULE_NOT_FOUND nombra a skills-dir.js aunque falte otro). Mismo criterio que
  //    harness-repo.js y legacy-names.js.
  if (fs.existsSync(path.join(__dirname, 'skills-dir.js'))) skills = require('./skills-dir.js').resolveSkillsDirs(env.TYCON_SKILLS_DIR).repo;
  const infra = [...new Set([fsx.real(clon), fsx.real(skills), fsx.real(installed)].filter(Boolean))];

  // 3. lo que la persona hace
  const ses = reposDeSesiones({ projectsDir, home, tmp, excluir: infra, R, fsx });
  const mayoria = raizPorMayoria(ses.repos, home, R);
  if (mayoria) return { root: mayoria.root, fuente: 'sesiones', evidencia: mayoria.repos };

  // 4. el vecino del arnés — sólo si de verdad hay vecinos. Un vecino es un repo de TRABAJO: la infraestructura que
  //    el paso 3 dejó afuera tampoco cuenta acá, y se compara por ruta real (lo instalado puede ser un enlace). Hasta
  //    el pase adversarial del tramo 1 de la 8.18 (hallazgo 1) este paso sólo descartaba al clon del arnés: con el clon
  //    de las skills como único repo al lado, su carpeta salía como «la raíz» con evidencia 1 —cero repos que auditar,
  //    y aguas abajo «no pude mirar» se leía «miré y no hay nada»— en vez de «sin raíz».
  const vecino = P.dirname(clon);
  try {
    if (fs.existsSync(P.join(clon, 'scripts')) && fs.statSync(vecino).isDirectory()) {
      const otros = reposAlLado(vecino, { R, fsx, excluir: infra }).filter((p) => !R.igual(p, clon));
      if (otros.length) return { root: vecino, fuente: 'vecino', evidencia: otros.length };
    }
  } catch (_) { /* sigue */ }

  // 5. la carpeta del clon desde el que se MUDÓ la máquina (2026-10-14). Antes de la mudanza esa carpeta salía en el paso
  //    4 (el arnés vivía ahí); mudado a `~/.tycon`, el vecino es `~/.tycon` y la raíz se perdía sin que nada cambiara en
  //    los repos. Vale con las mismas condiciones que el vecino: la carpeta existe y tiene OTROS repos de trabajo.
  const desde = opts.clonMudanza !== undefined ? opts.clonMudanza : clonDeLaMudanza(home);
  const padreMudanza = desde ? P.dirname(desde) : null;
  if (padreMudanza) {
    const viejo = fsx.real(desde) || desde;
    const otros = reposAlLado(padreMudanza, { R, fsx, excluir: infra }).filter((p) => !R.igual(p, desde) && !R.igual(fsx.real(p) || p, viejo));
    if (otros.length) return { root: padreMudanza, fuente: 'mudanza', evidencia: otros.length };
  }

  // 6. sin raíz, dicho como tal — nunca una ruta inventada. Lo que se leyó de las sesiones va en el motivo: «0 carpetas»
  //    no es lo mismo que «12 sesiones, ninguna en un repo».
  const sesTxt = ses.diag.carpetas
    ? `sin mayoría de repos en las sesiones de ${projectsDir} (${ses.diag.carpetas} carpeta(s) de sesión, ${ses.diag.cwds} con su carpeta de trabajo en el disco, ${ses.repos.length} repo(s) de trabajo)`
    : `sin sesiones con repos en ${projectsDir}`;
  return {
    root: null, fuente: 'sin-raiz',
    motivo: `sin TYCON_REPOS_ROOT, sin rutas.repos en ${path.join(home, '.claude', 'tycon.json')}, ${sesTxt} y sin otro repo al lado del arnés (${vecino})${padreMudanza ? ` ni del clon desde el que se mudó la máquina (${padreMudanza})` : ''}`,
  };
}

/** Texto para la persona: de dónde salió la raíz (o por qué no hay). */
function describir(r) {
  return {
    env: `la variable ${ENV}`,
    maquina: 'el archivo de la máquina (~/.claude/tycon.json → rutas.repos)',
    sesiones: `tus sesiones (${r.evidencia} repos)`,
    vecino: `la carpeta del arnés (${r.evidencia} repos al lado)`,
    mudanza: `la carpeta del clon desde el que se mudó la máquina (${r.evidencia} repos al lado)`,
    'sin-raiz': `sin raíz — ${r.motivo}. Definí TYCON_REPOS_ROOT o rutas.repos en ~/.claude/tycon.json`,
  }[r.fuente];
}

// ---------------------------------------------------------------- selftest
function selftest() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-root-'));
  const mk = (...p) => { const d = path.join(t, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const repo = (...p) => { const d = mk(...p); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };
  const casa = real(mk('casa'));
  mk('casa', '.claude');
  const tmpFalso = real(mk('tmp-falso'));
  const clon = real(repo('casa', 'Repos', 'tycon-claude-guides')); mk('casa', 'Repos', 'tycon-claude-guides', 'scripts');
  const skills = repo('casa', '.claude', 'agent-skills');
  // Un ~/.claude/projects fabricado. 🔴 Los nombres de carpeta imitan una casa REAL (/Users/<dev>/…): el
  // fixture entero vive bajo el temporal del sistema, y si los nombres se codificaran del cwd real
  // empezarían por "-var-folders-…" y el filtro barato por nombre los descartaría a todos — el
  // selftest mediría el filtro, no la deducción (pasó en la primera versión: 5/8 en rojo).
  let n = 0;
  const sesionEn = (dir, cwd, nombre) => {
    const d = path.join(dir, nombre || `-Users-dev-repo-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'x.jsonl'), JSON.stringify({ type: 'bridge-session' }) + '\n' + JSON.stringify({ type: 'user', cwd }) + '\n');
  };
  const projects = mk('casa', '.claude', 'projects');
  const A = repo('casa', 'Proyectos', 'A'), B = repo('casa', 'Proyectos', 'B'), X = repo('casa', 'Proyectos', 'FRESNO', 'X');
  const C = repo('casa', 'Proyectos', 'C');
  [A, B, X, clon, skills, mk('casa', 'Proyectos', 'notas'), repo('tmp-falso', 'advbench-abc'), path.join(casa, 'borrado')]
    .forEach((c) => sesionEn(projects, c));
  const o = { home: casa, clon, tmp: tmpFalso, projectsDir: projects, env: {} };
  const P = path.join(casa, 'Proyectos'), SC = path.join(casa, 'Repos');

  const casos = [];
  const r1 = resolveReposRoot('/x/y', o);
  casos.push(['la variable explícita gana siempre', r1.fuente === 'env' && r1.root === path.resolve('/x/y')]);
  const r1t = resolveReposRoot('~/Proyectos', o);
  casos.push(['la `~` en la variable se expande al home, igual que en el lector de configuración (pase adversarial, vuelta 1)', r1t.fuente === 'env' && r1t.root === P]);
  const r1r = resolveReposRoot('Proyectos', o);
  casos.push(['una ruta relativa en la variable va contra el home, como en el lector (no contra el cwd — vuelta 2)', r1r.fuente === 'env' && r1r.root === P]);
  const r2 = resolveReposRoot('', o);
  casos.push(['la variable vacía NO es una salida explícita', r2.fuente !== 'env']);
  casos.push(['por sesiones: la raíz es la carpeta que contiene a la mayoría de los repos donde trabaja la persona',
    r2.fuente === 'sesiones' && r2.root === P]);
  casos.push(['…contando SÓLO repos de trabajo: ni el arnés, ni agent-skills, ni un cwd que no es repo, ni uno borrado, ni un sandbox del temporal (evidencia 3 de 8 sesiones)',
    r2.evidencia === 3]);
  // Una carpeta con NOMBRE de sandbox no se abre aunque adentro apunte a un repo real: sin evidencia, no hay "sesiones".
  const soloTmp = mk('casa', 'projects-nombre-tmp');
  sesionEn(soloTmp, C, '-private-var-folders-xx-advbench-1');
  const r2b = resolveReposRoot('', Object.assign({}, o, { projectsDir: soloTmp }));
  casos.push(['una carpeta con nombre de temporal no se abre aunque adentro apunte a un repo real', r2b.fuente !== 'sesiones']);
  // Todos bajo un contenedor de producto: la raíz es la más ALTA con mayoría, no el contenedor.
  const proj2 = mk('casa', 'projects-2');
  [repo('casa', 'Repos', 'Totora', 'Backend'), repo('casa', 'Repos', 'Totora', 'Project')].forEach((c) => sesionEn(proj2, c));
  const r3 = resolveReposRoot('', Object.assign({}, o, { projectsDir: proj2 }));
  casos.push(['todos los repos dentro de un contenedor de producto: la raíz es la carpeta de arriba, no el contenedor',
    r3.fuente === 'sesiones' && r3.root === SC]);
  // ── story 8.18: el clon instalado de las skills vive FUERA de ~/.claude (un enlace) — sigue siendo infraestructura ──
  // Otra casa: un producto, y el clon de skills en `Infra/`, enlazado desde ~/.claude/agent-skills. Sin la exclusión
  // explícita de lo instalado la raíz salía `Infra` (un repo contra uno, desempata el nombre).
  const casa2 = real(mk('casa2')); mk('casa2', '.claude');
  const prod2 = repo('casa2', 'Proyectos', 'A');
  const skills2 = repo('casa2', 'Infra', 'skills-clone');
  fs.symlinkSync(skills2, path.join(casa2, '.claude', 'agent-skills'), 'dir');
  const proj3 = mk('casa2', '.claude', 'projects');
  [prod2, skills2].forEach((c) => sesionEn(proj3, c));
  const r3b = resolveReposRoot('', { home: casa2, clon, tmp: tmpFalso, projectsDir: proj3, env: {}, sinConfig: true });
  casos.push(['🔴 el clon instalado de las skills, enlazado desde ~/.claude/agent-skills, no cuenta como repo de trabajo aunque viva fuera de ~/.claude',
    r3b.fuente === 'sesiones' && r3b.root === path.join(casa2, 'Proyectos') && r3b.evidencia === 1]);
  // ── pase adversarial del tramo 1 de la 8.18 (hallazgo 1): el paso «vecino» tampoco cuenta a la infraestructura ──
  // Cada forma en su propia casa, sin sesiones de producto, sin variable y sin archivo. Lo esperado en las cuatro es
  // «sin raíz»: al lado del arnés sólo está el clon de las skills, y una raíz con cero repos que auditar se lee «todo bien».
  const house = (name) => { const h = real(mk(name)); mk(name, '.claude'); return { h, projectsDir: mk(name, '.claude', 'projects'), name }; };
  const harnessAt = (...p) => { const c = real(repo(...p)); mk(...p, 'scripts'); return c; };
  const ask = (hs, c) => resolveReposRoot('', { home: hs.h, clon: c, tmp: tmpFalso, projectsDir: hs.projectsDir, env: {}, sinConfig: true });
  const noRoot = (r) => r.fuente === 'sin-raiz' && r.root === null;
  // A: el arnés y el clon de las skills, vecinos en Infra/; el de las skills, enlazado desde ~/.claude/agent-skills
  const hA = house('casaA'); const clonA = harnessAt('casaA', 'Infra', 'tycon-claude-guides');
  fs.symlinkSync(repo('casaA', 'Infra', 'agent-skills'), path.join(hA.h, '.claude', 'agent-skills'), 'junction');
  casos.push(['🔴 vecino: el clon de las skills (enlazado desde ~/.claude/agent-skills) como ÚNICO repo al lado del arnés no hace de su carpeta «la raíz»: sin raíz',
    noRoot(ask(hA, clonA))]);
  // B: los dos clones, carpetas reales dentro de ~/.claude
  const hB = house('casaB'); const clonB = harnessAt('casaB', '.claude', 'tycon-harness');
  repo('casaB', '.claude', 'agent-skills');
  casos.push(['🔴 vecino: el arnés y agent-skills como carpetas reales dentro de ~/.claude: ~/.claude no es «la raíz»', noRoot(ask(hB, clonB))]);
  // C: como A, con sesiones SÓLO en los dos clones — el paso 3 las descarta, y el paso 4 no las vuelve a meter
  const hC = house('casaC'); const clonC = harnessAt('casaC', 'Infra', 'tycon-claude-guides');
  const skillsC = real(repo('casaC', 'Infra', 'agent-skills'));
  fs.symlinkSync(skillsC, path.join(hC.h, '.claude', 'agent-skills'), 'junction');
  [clonC, skillsC].forEach((c) => sesionEn(hC.projectsDir, c));
  casos.push(['🔴 vecino: con sesiones sólo en los dos clones, lo que el paso de las sesiones dejó afuera no vuelve a entrar como vecino', noRoot(ask(hC, clonC))]);
  // D: el clon unido (trae skills/ y agents/) con el clon viejo de las skills al lado, todavía instalado por enlace
  const hD = house('casaD'); const clonD = harnessAt('casaD', 'Infra', 'tycon-claude-guides');
  ['skills', 'agents', 'packs'].forEach((s) => mk('casaD', 'Infra', 'tycon-claude-guides', s));
  fs.symlinkSync(repo('casaD', 'Infra', 'skills-old'), path.join(hD.h, '.claude', 'agent-skills'), 'junction');
  casos.push(['🔴 vecino: el clon unido con el clon viejo de las skills al lado (instalado por enlace): sin raíz', noRoot(ask(hD, clonD))]);
  // el espejo sano: un PRODUCTO al lado sí hace de la carpeta la raíz, y la evidencia cuenta sólo al producto
  repo('casaA', 'Infra', 'ProductoA');
  const rAp = ask(hA, clonA);
  casos.push(['(espejo) con un producto al lado, además del clon de las skills: vecino, y la evidencia cuenta al producto y no a la infraestructura (1, no 2)',
    rAp.fuente === 'vecino' && rAp.root === path.join(hA.h, 'Infra') && rAp.evidencia === 1]);
  // ── Windows (2026-10-14): la extensión de VS Code deja el cwd con la letra de unidad en MINÚSCULA (`c:\Users\…`) y el
  //    home viene con mayúscula. Comparando con `===` ningún repo quedaba bajo el home, cada uno votaba sólo por su padre
  //    y, con los repos repartidos en carpetas de producto, ninguna carpeta llegaba a la mayoría: «sin raíz» en una máquina
  //    que usa Claude Code todos los días. Las rutas de Windows se prueban acá con un disco inyectado (corre en cualquier
  //    máquina); los nombres de carpeta de las sesiones son los que Claude Code crea en Windows.
  {
    const RW = rutasDe('win32');
    const W = 'C:\\Users\\dev';
    const PR = `${W}\\Desktop\\proyectos`;
    const carpetasW = [W, `${W}\\.claude`, `${W}\\AppData\\Local\\Temp`, `${W}\\.tycon\\harness`, `${W}\\Desktop`, PR,
      `${PR}\\Totora`, `${PR}\\Totora\\Backend`, `${PR}\\Ceibo`, `${PR}\\Ceibo\\Backend`, `${PR}\\Ceibo\\Backend\\src`, `${PR}\\Fresno`, `${PR}\\Fresno\\Api`];
    const reposW = new Set([`${PR}\\Totora\\Backend`, `${PR}\\Ceibo\\Backend`, `${PR}\\Fresno\\Api`].map((x) => x.toLowerCase()));
    const porLlave = new Map(carpetasW.map((x) => [x.toLowerCase(), x]));
    const fsxW = {
      real: (p) => porLlave.get(RW.canon(p).toLowerCase()) || null,
      esRepo: (p) => reposW.has(String(p).toLowerCase()),
      hijos: (d) => carpetasW.filter((x) => path.win32.dirname(x).toLowerCase() === String(d).toLowerCase()),
    };
    const projW = mk('casaW-projects');
    // tres repos, cada uno en su carpeta de producto: una sesión en el repo, otra en una subcarpeta del repo, otra en la
    // carpeta del producto (que no es un repo); y la misma del repo abierta desde la terminal, con la C mayúscula
    sesionEn(projW, 'c:\\Users\\dev\\Desktop\\proyectos\\Totora\\Backend', 'c--Users-dev-Desktop-proyectos-Totora-Backend');
    sesionEn(projW, 'C:\\Users\\dev\\Desktop\\proyectos\\Totora\\Backend', 'C--Users-dev-Desktop-proyectos-Totora-Backend');
    sesionEn(projW, 'c:\\Users\\dev\\Desktop\\proyectos\\Ceibo\\Backend\\src', 'c--Users-dev-Desktop-proyectos-Ceibo-Backend-src');
    sesionEn(projW, 'c:\\Users\\dev\\Desktop\\proyectos\\Fresno', 'c--Users-dev-Desktop-proyectos-Fresno');
    const rW = resolveReposRoot('', { platform: 'win32', fsx: fsxW, home: W, clon: `${W}\\.tycon\\harness`, tmp: `${W}\\AppData\\Local\\Temp`, projectsDir: projW, env: {}, sinConfig: true, clonMudanza: null });
    casos.push(['🔴 Windows: cwd con `c:` minúscula y home con `C:` — los repos bajo el Escritorio cuentan como bajo el home y la raíz es la carpeta que los junta, no «sin raíz»',
      rW.fuente === 'sesiones' && rW.root === PR]);
    casos.push(['Windows: el mismo repo con `c:` y con `C:` es UN repo; la sesión en una subcarpeta cuenta por su repo y la de la carpeta del producto por los repos que tiene adentro (evidencia 3)',
      rW.evidencia === 3]);
    casos.push(['Windows: el Escritorio no es «la raíz» aunque contenga a todos (es una carpeta personal, como el home)', rW.root !== `${W}\\Desktop`]);
  }
  // ── la máquina mudada (2026-10-14): el arnés vive en ~/.tycon y los repos siguen al lado del clon viejo ──
  {
    const hM = house('casaM'); const clonM = harnessAt('casaM', '.tycon', 'harness');
    const viejoM = real(repo('casaM', 'Fuentes', 'tycon-claude-guides'));
    fs.mkdirSync(path.join(hM.h, '.tycon', 'state'), { recursive: true });
    fs.writeFileSync(path.join(hM.h, '.tycon', 'state', 'harness-state.json'), JSON.stringify({ migrate_home: { status: 'done', from: viejoM } }));
    const sinOtros = ask(hM, clonM);
    casos.push(['mudada: con el clon viejo SOLO en su carpeta, esa carpeta no es la raíz (cero repos que auditar): sin raíz, y el motivo nombra la carpeta del clon viejo',
      noRoot(sinOtros) && sinOtros.motivo.includes(path.dirname(viejoM))]);
    repo('casaM', 'Fuentes', 'ProductoA');
    const rM = ask(hM, clonM);
    casos.push(['🔴 mudada: sin sesiones ni archivo, la carpeta del clon desde el que se mudó la máquina da la raíz si tiene otros repos (evidencia: los otros, no el clon viejo)',
      rM.fuente === 'mudanza' && rM.root === path.join(hM.h, 'Fuentes') && rM.evidencia === 1]);
    casos.push(['mudada: la descripción dice de dónde salió', /se mudó/.test(describir(rM))]);
    fs.writeFileSync(path.join(hM.h, '.tycon', 'state', 'harness-state.json'), JSON.stringify({ migrate_home: { status: 'failed', from: viejoM } }));
    casos.push(['mudada: una mudanza que falló no da raíz (la máquina sigue en su clon)', noRoot(ask(hM, clonM))]);
  }
  // ── T6 (story 8.3): sin sesiones, sin vecino, sin variable, sin archivo → SIN RAÍZ, con motivo ──
  const vacio = mk('casa', 'projects-vacio');
  const r4 = resolveReposRoot('', Object.assign({}, o, { projectsDir: vacio }));
  casos.push(['🔴 T6 sin sesiones y con el arnés SOLO en su carpeta: NO se elige por ser el vecino (sería cero repos que auditar) — «sin raíz», con motivo, sin inventar ninguna ruta',
    r4.fuente === 'sin-raiz' && r4.root === null && /TYCON_REPOS_ROOT/.test(r4.motivo) && /tycon\.json/.test(r4.motivo) && /sesiones/.test(r4.motivo)]);
  casos.push(['T6 la descripción para la persona dice «sin raíz» y cómo definirla', /sin raíz/.test(describir(r4)) && /TYCON_REPOS_ROOT/.test(describir(r4))]);
  repo('casa', 'Repos', 'Otro');
  const r5 = resolveReposRoot('', Object.assign({}, o, { projectsDir: vacio }));
  casos.push(['sin sesiones pero con OTRO repo al lado del arnés: vecino, con la cantidad de vecinos como evidencia',
    r5.fuente === 'vecino' && r5.root === SC && r5.evidencia === 1]);
  // ── el archivo de la máquina (nivel 2) ──
  const cfgPath = path.join(casa, '.claude', 'tycon.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ rutas: { repos: '~/Proyectos' } }));
  const r6 = resolveReposRoot('', o);
  casos.push(['rutas.repos en ~/.claude/tycon.json gana sobre las sesiones y el vecino (la `~` se expande al home)', r6.fuente === 'maquina' && r6.root === P]);
  const r6b = resolveReposRoot('/z', o);
  casos.push(['…pero la variable le gana al archivo', r6b.fuente === 'env']);
  fs.writeFileSync(cfgPath, '{ roto');
  let tiro = null;
  try { resolveReposRoot('', o); } catch (e) { tiro = e; }
  casos.push(['🔴 un tycon.json roto NO es «sin raíz»: tira ConfigError nombrando el archivo', !!tiro && tiro.name === 'ConfigError' && tiro.message.includes(cfgPath)]);
  fs.unlinkSync(cfgPath);
  fs.rmSync(t, { recursive: true, force: true });

  let malos = 0;
  for (const [nombre, ok] of casos) { if (!ok) malos++; console.log(`${ok ? '✅' : '❌'} ${nombre}`); }
  console.log(malos ? `❌ repos-root selftest: ${malos}/${casos.length} mal` : `✅ repos-root selftest: ${casos.length}/${casos.length}`);
  return malos ? 1 : 0;
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) process.exit(selftest());
  let r;
  try { r = resolveReposRoot(); }
  catch (e) { process.stderr.write((e && e.message) + '\n'); process.exit(2); }
  if (process.argv.includes('--plain')) {
    if (!r.root) { process.stderr.write(`sin raíz de repos — ${r.motivo}\n`); process.exit(3); }
    process.stdout.write(r.root + '\n');
    process.exit(0);
  }
  console.log(`raíz de repos: ${r.root || '(sin raíz)'} · fuente: ${describir(r)}`);
  process.exit(0);
}

/**
 * Los repos en los que trabaja esta persona, sacados de sus sesiones (el paso 3 de resolveReposRoot, sin votar una raíz):
 * lo usan quienes necesitan los repos y no una carpeta, como las corridas sin cerrar. Sin la infraestructura (el clon del
 * arnés y el de las skills), sin temporales ni `~/.claude`. Devuelve rutas reales.
 */
function sessionRepos(opts = {}) {
  const env = opts.env || process.env;
  const R = rutasDe(opts.platform || process.platform);
  const P = R.P;
  const fsx = {
    real: (p) => { const r = real(p); return r ? R.canon(r) : null; },
    esRepo: esRepoGit,
    hijos: (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => P.join(dir, e.name)); } catch (_) { return []; } },
  };
  const home0 = opts.home || os.homedir();
  const home = fsx.real(home0) || R.canon(home0);
  const clon = opts.clon || path.resolve(__dirname, '..', '..');
  const installed = P.join(home, '.claude', 'agent-skills');
  let skills = installed;
  if (fs.existsSync(path.join(__dirname, 'skills-dir.js'))) skills = require('./skills-dir.js').resolveSkillsDirs(env.TYCON_SKILLS_DIR).repo;
  const infra = [...new Set([fsx.real(clon), fsx.real(skills), fsx.real(installed)].filter(Boolean))];
  const tmp = fsx.real(opts.tmp || os.tmpdir()) || (opts.tmp || os.tmpdir());
  return reposDeSesiones({ projectsDir: opts.projectsDir || path.join(home, '.claude', 'projects'), home, tmp, excluir: infra, R, fsx }).repos;
}

module.exports = { resolveReposRoot, sessionRepos, describir, ENV, __test: { rutasDe, raizPorMayoria, reposDeSesiones } };
