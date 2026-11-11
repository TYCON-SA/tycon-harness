'use strict';
/**
 * Lo que se revisa, congelado (historia 8.161).
 *
 * Al lanzar una vuelta de revisores, o el pase adversarial, se sella el árbol de cada repo de la corrida: la huella de
 * `git write-tree` sobre una copia del índice con todo lo del disco que git no ignora (la misma forma que el registro de
 * autoría). Con ese sello se arma una copia de sólo lectura en la carpeta de estado del pipeline, fuera del repo, desde
 * lo que git guardó: un índice aparte con `read-tree <sello>` volcado con `checkout-index`. No se usa `git archive`,
 * que aplica `export-ignore` y `export-subst`: la copia no volvería a dar el mismo sello. Los revisores leen la copia.
 *
 * El permiso de sólo lectura no alcanza solo: `verify` vuelve a sellar la copia y dice si no coincide. Al guardar,
 * `changed` dice qué archivos difieren entre el sello revisado y el de ahora, sin el papeleo.
 *
 * En el repo sólo se escriben objetos en la base de git (como un `git add`): ni el árbol de trabajo ni el índice real.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..', '..', '..');
const entornoDeGit = () => require(path.join(RAIZ, 'scripts', 'lib', 'clean-git-env.js'));

// sin las variables de git del proceso padre (un hook las exporta y ganan sobre `-C`), y con el idioma fijo
function git(args, env) {
  const e = entornoDeGit();
  const r = spawnSync('git', args, { encoding: 'utf8', env: e.idiomaFijo(e.sinGitDelPadre(process.env), env || {}), maxBuffer: 256 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, out: String(r.stdout || '').trim(), crudo: String(r.stdout || ''), err: String((r.error && r.error.message) || r.stderr || '').trim() };
}
const unaLinea = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || 'sin detalle';
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };

/** Un índice aparte, en la carpeta temporal; se borra al terminar. */
function conIndiceAparte(fn) {
  const indice = path.join(os.tmpdir(), `tycon-frozen-index-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try { return fn(indice); } finally { try { fs.unlinkSync(indice); } catch (_) { /* no llegó a existir */ } }
}

function gitDirDe(repo) {
  const r = git(['-C', repo, 'rev-parse', '--absolute-git-dir']);
  return r.ok ? { dir: r.out } : { error: `${repo} no es un repo de git (${unaLinea(r.err)})` };
}

/**
 * El sello del árbol de un repo: `{ tree }` (40 caracteres) o `{ error }` con el motivo en una línea. Una copia del
 * índice real, `add -A` y `write-tree`: lo sin commitear y lo nuevo que git no ignora entran.
 */
function seal(repo) {
  const g = gitDirDe(repo);
  if (g.error) return { error: `no pude sellar ${repo}: ${g.error}` };
  return conIndiceAparte((indice) => {
    try {
      const original = path.join(g.dir, 'index');
      fs.copyFileSync(original, indice);
      // con la hora del índice original: git compara por contenido un archivo cambiado en el mismo segundo que su
      // entrada («racily clean») sólo si el índice no es más nuevo que ella; con la hora de la copia, lo daría por igual
      const st = fs.statSync(original);
      fs.utimesSync(indice, st.atime, st.mtime);
    } catch (_) { /* repo sin índice: se arma de cero */ }
    const env = { GIT_INDEX_FILE: indice };
    const add = git(['-C', repo, 'add', '-A'], env);
    if (!add.ok) return { error: `no pude sellar ${repo}: git add (${unaLinea(add.err)})` };
    const w = git(['-C', repo, 'write-tree'], env);
    if (!w.ok || !/^[0-9a-f]{40}$/.test(w.out)) return { error: `no pude sellar ${repo}: git write-tree (${unaLinea(w.err || w.out)})` };
    return { tree: w.out };
  });
}

/**
 * Deja los archivos de una carpeta de sólo lectura (o, con `escribible`, les devuelve el permiso al dueño). Las carpetas
 * quedan escribibles por su dueño: así cualquiera que limpia su carpeta temporal la puede borrar; un archivo agregado o
 * cambiado lo atrapa `verify`, que vuelve a sellar la copia.
 */
function permisos(dir, escribible) {
  const ir = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (_) { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      fs.chmodSync(p, 0o755);
      for (const e of fs.readdirSync(p)) ir(path.join(p, e));
    } else {
      fs.chmodSync(p, escribible ? (st.mode & 0o111 ? 0o755 : 0o644) : (st.mode & 0o111 ? 0o555 : 0o444));
    }
  };
  ir(dir);
}

/**
 * La copia de sólo lectura del árbol `tree` de `repo` en `dir` (que no tiene que existir): `{ copy }` o `{ error }`.
 * Una copia a medias se borra: nunca queda una que no sea la del sello.
 */
function freeze(repo, tree, dir) {
  const g = gitDirDe(repo);
  if (g.error) return { error: `no pude armar la copia de ${repo}: ${g.error}` };
  if (fs.existsSync(dir)) remover(dir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { error: `no pude armar la copia de ${repo} en ${dir}: ${unaLinea(e.message)}` }; }
  const r = conIndiceAparte((indice) => {
    const env = { GIT_INDEX_FILE: indice };
    const rt = git([`--git-dir=${g.dir}`, 'read-tree', tree], env);
    if (!rt.ok) return { error: `no pude armar la copia de ${repo}: git read-tree ${tree} (${unaLinea(rt.err)})` };
    const co = git([`--git-dir=${g.dir}`, `--work-tree=${dir}`, 'checkout-index', '-a', '-f'], env);
    if (!co.ok) return { error: `no pude armar la copia de ${repo} en ${dir}: git checkout-index (${unaLinea(co.err)})` };
    return { copy: dir };
  });
  if (r.error) { remover(dir); return r; }
  try { permisos(dir, false); } catch (e) { remover(dir); return { error: `no pude dejar de sólo lectura la copia de ${repo}: ${unaLinea(e.message)}` }; }
  return r;
}

/**
 * ¿La copia sigue siendo la del sello? Se vuelve a sellar sobre la copia (un índice aparte desde el sello, `add -A` con
 * la copia como árbol de trabajo). `{ ok: true }` o `{ ok: false, error }`.
 */
function verify(repo, copy, tree) {
  const g = gitDirDe(repo);
  if (g.error) return { ok: false, error: `no pude comprobar la copia de ${repo}: ${g.error}` };
  if (!fs.existsSync(copy)) return { ok: false, error: `la copia de la vuelta no está (${copy}): repo ${repo}, sello ${tree}` };
  return conIndiceAparte((indice) => {
    const env = { GIT_INDEX_FILE: indice };
    const base = [`--git-dir=${g.dir}`, `--work-tree=${copy}`];
    const rt = git([...base, 'read-tree', tree], env);
    if (!rt.ok) return { ok: false, error: `no pude comprobar la copia de ${repo}: git read-tree ${tree} (${unaLinea(rt.err)})` };
    const add = git([...base, 'add', '-A'], env);
    const w = add.ok ? git([...base, 'write-tree'], env) : add;
    if (!w.ok) return { ok: false, error: `no pude comprobar la copia de ${repo}: ${unaLinea(w.err)}` };
    return w.out === tree ? { ok: true }
      : { ok: false, error: `la copia de la vuelta no coincide con su sello: repo ${repo}, sello ${tree}, la copia da ${w.out}` };
  });
}

/** Borra una carpeta de copias aunque sea de sólo lectura. */
function remover(dir) {
  try { permisos(dir, true); } catch (_) { /* lo que no se pudo, lo intenta el borrado */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

// un nombre que se vuelve carpeta: sin barras, y nunca «.», «..» ni con punto adelante (saldría de su carpeta)
const seguro = (s) => { const t = String(s).replace(/[^\w.-]/g, '_') || '_'; return t.startsWith('.') ? `_${t}` : t; };
const raizDeCopias = (stateDir) => path.join(stateDir, 'frozen');
/** ¿`p` queda dentro de `base`? Se mira antes de borrar o escribir en una carpeta armada con un nombre. */
const dentroDe = (base, p) => { const r = path.relative(path.resolve(base), path.resolve(p)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

/** La carpeta de la copia de un repo en una vuelta: `<estado>/frozen/<sesión>/<vuelta>/<nombre>-<8 del hash de la ruta>`. */
function copyDir(stateDir, sid, etiqueta, repo) {
  const h = crypto.createHash('sha256').update(real(repo)).digest('hex').slice(0, 8);
  const d = path.join(raizDeCopias(stateDir), seguro(sid), seguro(etiqueta), `${seguro(path.basename(repo))}-${h}`);
  if (!dentroDe(raizDeCopias(stateDir), d)) throw new Error(`la copia (${d}) no queda dentro de ${raizDeCopias(stateDir)}`);
  return d;
}

/** Borra las copias de una sesión (al cerrar su corrida). */
function remove(stateDir, sid) {
  const d = path.join(raizDeCopias(stateDir), seguro(sid));
  if (!dentroDe(raizDeCopias(stateDir), d)) throw new Error(`remove: ${d} no queda dentro de ${raizDeCopias(stateDir)}`);
  if (fs.existsSync(d)) remover(d);
}

/**
 * Borra las copias de las corridas que ya no están abiertas (sin marcador en `active/`): las de una corrida cortada o
 * cerrada con `clear-session --lost`. Devuelve las sesiones barridas.
 */
function sweep(stateDir) {
  const raiz = raizDeCopias(stateDir);
  let sesiones = [];
  try { sesiones = fs.readdirSync(raiz); } catch (_) { return []; }
  const barridas = [];
  for (const sid of sesiones) {
    // sólo lo que pudo crear este módulo: un nombre que ya es seguro y queda dentro de la carpeta de las copias
    if (sid !== seguro(sid) || !dentroDe(raiz, path.join(raiz, sid))) continue;
    if (fs.existsSync(path.join(stateDir, 'active', `${sid}.json`))) continue;
    try { remover(path.join(raiz, sid)); barridas.push(sid); } catch (_) { /* la próxima vuelta lo vuelve a intentar */ }
  }
  return barridas.sort();
}

/**
 * Los repos de una vuelta: la raíz de git de cada ruta (la historia y el repo del código), sin repetir. `{ repos }` o
 * `{ error }`; una ruta fuera de todo repo de git no tiene árbol que sellar y no suma.
 */
function reposDe(rutas) {
  const so = require('./save-ok.js');
  const repos = [];
  for (const p of rutas.filter(Boolean)) {
    let r = null;
    try { r = so.raizDe(path.resolve(p)); } catch (e) { return { error: `no pude saber el repo de ${p}: ${unaLinea(e.message)}` }; }
    if (r && !repos.includes(r)) repos.push(r);
  }
  return { repos };
}

// El registro de las vueltas congeladas de una sesión, junto a sus copias: se borra con ellas.
const registroDeVueltas = (stateDir, sid) => path.join(raizDeCopias(stateDir), seguro(sid), 'vueltas.jsonl');

/** Las vueltas congeladas de una sesión, en orden: `[{ ts, tipo, etiqueta, repos: [{ repo, tree, copy }] }]`. */
function vueltas(stateDir, sid) {
  let txt = '';
  try { txt = fs.readFileSync(registroDeVueltas(stateDir, sid), 'utf8'); } catch (_) { return []; }
  return txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

/** La última vuelta congelada de un tipo (`revisores` o `pase`), o null. */
function ultimaVuelta(stateDir, sid, tipo) {
  return vueltas(stateDir, sid).filter((v) => v.tipo === tipo).pop() || null;
}

/**
 * Sella y congela cada repo de una vuelta y la anota: `{ repos: [{ repo, tree, copy }] }` o `{ error }` con el primer
 * motivo. Una vuelta no se lanza a medias: si un repo falla, se borran las copias que ya se armaron. Antes barre las
 * copias de las corridas que ya no están abiertas; una vuelta de revisores nueva borra las copias de las anteriores
 * (al guardar se compara contra la última).
 */
function sealAndFreeze({ stateDir, sid, etiqueta, repos, tipo = 'revisores', story = null }) {
  sweep(stateDir);
  const out = [];
  for (const repo of repos) {
    const s = seal(repo);
    if (s.error) { for (const r of out) remover(r.copy); return { error: s.error }; }
    const f = freeze(repo, s.tree, copyDir(stateDir, sid, etiqueta, repo));
    if (f.error) { for (const r of out) remover(r.copy); return { error: f.error }; }
    out.push({ repo, tree: s.tree, copy: f.copy });
  }
  if (tipo === 'revisores') {
    for (const v of vueltas(stateDir, sid).filter((x) => x.tipo === 'revisores' && x.etiqueta !== etiqueta)) {
      for (const r of v.repos || []) { try { if (r.copy && fs.existsSync(r.copy)) remover(r.copy); } catch (_) { /* la barre la próxima */ } }
    }
  }
  try {
    fs.appendFileSync(registroDeVueltas(stateDir, sid), `${JSON.stringify({ ts: new Date().toISOString(), tipo, etiqueta, story, repos: out })}\n`, 'utf8');
  } catch (e) {
    for (const r of out) remover(r.copy);
    return { error: `no pude anotar la vuelta congelada: ${unaLinea(e.message)}` };
  }
  return { repos: out };
}

/**
 * La sección del contexto de los revisores: la copia y el sello de cada repo, y que la carpeta viva no se lee.
 */
function seccionDelContexto(repos) {
  return ['', '## Lo que se revisa: la versión congelada', '',
    'Leé la copia de cada repo, no la carpeta viva: la carpeta viva puede cambiar mientras revisás, y lo que se guarda',
    'se compara con este sello. Las rutas del diff son relativas a la raíz de cada copia.', '',
    ...repos.map((r) => `- ${r.repo} → copia: ${r.copy} (sello ${r.tree})`), ''].join('\n');
}

// La historia de la corrida: no cuentan como cambio su estado (en el frontmatter o en el cuerpo), sus tildes, su Change
// Log, su Dev Agent Record ni sus «Cambios de comportamiento» (declarar una diferencia con main es papeleo: no vuelve a
// los revisores). Tampoco la sección de seguimientos que escribe «Hallazgos» (`pipeline.js write-followups`) después de
// la vuelta: se reconoce por su título entero, no por un prefijo, así que «(AI)» o un título con texto de más siguen
// contando (con el `\b` del patrón de arriba, un título que termina en «)» nunca coincidiría). Cada una de esas
// secciones llega, con sus subtítulos, hasta el próximo título de su nivel o de uno mayor.
const SECCION_DE_PAPELEO = /^(Change Log|Dev Agent Record|Cambios de comportamiento)\b/i;
const SECCION_DE_SEGUIMIENTOS = /^Review Follow-ups \(Advisors\)$/i;
function sinPapeleoDeLaHistoria(txt) {
  const out = [];
  let nivel = 0;
  for (const l of String(txt).split('\n')) {
    const titulo = l.match(/^(#{1,6})\s+(.*)$/);
    if (titulo) {
      const n = titulo[1].length;
      const nombre = titulo[2].trim();
      if (nivel && n <= nivel) nivel = 0;
      if (!nivel && n === 2 && (SECCION_DE_PAPELEO.test(nombre) || SECCION_DE_SEGUIMIENTOS.test(nombre))) nivel = n;
    }
    if (nivel) continue;
    if (/^\**status\**\s*:/i.test(l)) continue;
    out.push(l.replace(/^(\s*[-*]\s*)\[[ xX]\]/, '$1[ ]'));
  }
  return out.join('\n');
}

// El renglón de la historia en el estado del sprint (`<épica>-<número>-…: <estado>   # comentario`): la clave sale del
// `story:` del frontmatter, sin comillas, y tiene que ser `<épica>.<número>`; si no, no hay clave y no se perdona nada.
function claveDeLaHistoria(txt) {
  const fm = String(txt || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const m = fm && fm[1].match(/^story:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m);
  return m && /^\d+\.\d+$/.test(m[1]) ? `${m[1].replace('.', '-')}-` : null;
}
// El renglón propio empieza con la clave y no sigue con `<número>-`: ése es el de una sub-historia (`9-9-1-…`), que cuenta.
const sinRenglonDeLaHistoria = (txt, clave) => String(txt).split('\n')
  .filter((l) => { const t = l.trimStart(); return !(t.startsWith(clave) && !/^\d+-/.test(t.slice(clave.length))); }).join('\n');

/**
 * Los archivos que difieren entre dos sellos de un repo: `{ files, papeleo }` o `{ error }`. Papeleo es lo que no cuenta
 * para el ok de guardar (`esPapeleoDeLaHuella`), `tasks/todo.md`, la historia de la corrida (`storyRel`, relativa al
 * repo) cuando sólo cambió su estado, sus tildes, su Change Log, su Dev Agent Record, sus «Cambios de comportamiento» o
 * su sección de seguimientos, y el `sprint-status.yaml` de la carpeta de la historia cuando sólo cambió el renglón de
 * esa historia (lo pasa a review el cierre). Si el estado del sprint no está en alguno de los dos sellos, o la historia no
 * dice qué número es, cuenta como cambio.
 */
function changed(repo, treeA, treeB, { storyRel } = {}) {
  if (treeA === treeB) return { files: [], papeleo: [] };
  const d = git(['-C', repo, 'diff-tree', '-r', '-z', '--no-renames', treeA, treeB]);
  if (!d.ok) return { error: `no pude comparar ${repo} entre ${treeA} y ${treeB}: ${unaLinea(d.err)}` };
  const { esPapeleoDeLaHuella, esEvidenciaEnVivo } = require('./save-ok.js');
  const partes = d.crudo.split('\0');
  const files = [];
  const papeleo = [];
  const leer = (t, rel) => { const r = git(['-C', repo, 'show', `${t}:${rel}`]); return r.ok ? r.crudo : null; };
  const estadoDelSprint = storyRel ? path.posix.join(path.posix.dirname(storyRel), 'sprint-status.yaml') : null;
  for (let i = 0; i + 1 < partes.length; i += 2) {
    const meta = partes[i].replace(/^:/, '').split(' ');
    const rel = partes[i + 1];
    if (!rel) continue;
    const modo = meta[1] && meta[1] !== '000000' ? meta[1] : meta[0];
    let esPapeleo;
    if (storyRel && rel === storyRel) {
      // la historia de la corrida, por su regla: la lista de papeleo la daría por papeleo entera (`specs/`)
      const a = leer(treeA, rel);
      const b = leer(treeB, rel);
      esPapeleo = a !== null && b !== null && sinPapeleoDeLaHistoria(a) === sinPapeleoDeLaHistoria(b);
    } else if (rel === estadoDelSprint) {
      // el estado del sprint: sólo el renglón de la historia de la corrida, con el número que dice la historia de ahora
      const clave = claveDeLaHistoria(leer(treeB, storyRel));
      const a = leer(treeA, rel);
      const b = leer(treeB, rel);
      esPapeleo = !!clave && a !== null && b !== null && sinRenglonDeLaHistoria(a, clave) === sinRenglonDeLaHistoria(b, clave);
    } else {
      // la salida o la captura de un humo que su registro nombra con la misma huella: «Probar en vivo» corre después de
      // los revisores y deja esa evidencia; no es código
      esPapeleo = rel === 'tasks/todo.md' || esPapeleoDeLaHuella(rel, modo) || esEvidenciaEnVivo(repo, rel);
    }
    (esPapeleo ? papeleo : files).push(rel);
  }
  return { files, papeleo };
}

/**
 * La procedencia de una prueba (historia 8.161, decisión 4): de qué corrida es (su carpeta), qué árbol probó (el sello
 * del repo, o `tree: null` con `tree_error`) y sobre qué commit, en qué entorno (sistema, node, herramienta) y quién la
 * corrió (la sesión y su modelo, o el proceso). La escriben las herramientas que prueban, no quien las corre.
 */
function procedencia(repo, { env = process.env, home = os.homedir(), proceso = 'sin-nombre' } = {}) {
  const s = repo ? seal(repo) : { error: 'sin repo' };
  const head = repo ? git(['-C', repo, 'rev-parse', '--verify', '-q', 'HEAD']) : { ok: false };
  const sesion = env.CLAUDE_CODE_SESSION_ID || env.TYCON_SESSION_ID || env.CODEX_SESSION_ID || null;
  let marcador = null;
  let run = null;
  let runError = sesion ? null : 'sin sesión: la prueba no corrió dentro de una corrida';
  if (sesion) {
    try {
      const dir = require('./state-dir.js').stateDir(home);
      marcador = JSON.parse(fs.readFileSync(path.join(dir, 'active', `${String(sesion).replace(/[/\\]/g, '_')}.json`), 'utf8'));
    } catch (e) { marcador = null; runError = `no pude leer el marcador de la sesión (${e.code || e.message})`; }
  }
  // la carpeta de la corrida: la que guarda el marcador, o la que calcula el pipeline para su historia
  if (marcador) {
    run = marcador.runDir || null;
    if (!run && marcador.storyId) {
      try {
        const repoM = marcador.repoPath || process.cwd();
        const story = marcador.storyPath ? (path.isAbsolute(marcador.storyPath) ? marcador.storyPath : path.resolve(repoM, marcador.storyPath)) : undefined;
        // de `run-dir.js`, no de `pipeline.js`: el tablero del sitio carga esto y su imagen no lleva el pipeline entero
        run = require('./run-dir.js').resolveRunDir(repoM, String(marcador.storyId), false, story, { marker: marcador }) || null;
        if (!run) runError = 'la historia del marcador todavía no tiene carpeta de corrida';
      } catch (e) { runError = `no pude calcular la carpeta de la corrida (${String(e.message || e).split('\n')[0]})`; }
    } else if (!run) runError = 'el marcador no nombra una historia';
  }
  const herramienta = env.CLAUDE_CODE_SESSION_ID ? 'claude-code' : env.CODEX_SESSION_ID ? 'codex' : env.TYCON_SESSION_ID ? 'banco' : null;
  return {
    run,
    ...(run ? {} : { run_error: runError }),
    tree: s.tree || null,
    ...(s.error ? { tree_error: s.error } : {}),
    commit: head.ok && head.out ? head.out : null,
    env: { os: process.platform, node: process.version, tool: herramienta },
    // sin sesión, el nombre de la herramienta que corrió la prueba: un número de proceso cambiaría en cada corrida
    by: sesion ? { session: String(sesion), model: (marcador && marcador.sessionModel) || env.ANTHROPIC_MODEL || null } : { process: proceso },
  };
}

module.exports = { seal, freeze, verify, changed, copyDir, remove, sweep, reposDe, sealAndFreeze, vueltas, ultimaVuelta, seccionDelContexto, sinPapeleoDeLaHistoria, procedencia };

// `node frozen-tree.js procedencia <repo>`: la procedencia como fragmento JSON (`"run":…,"tree":…`), para sumar a un
// renglón que arma un guion de bash. Nunca falla: sin node que conteste, el guion sigue sin ella.
if (require.main === module && process.argv[2] === 'procedencia') {
  const p = procedencia(process.argv[3] || null, { proceso: process.argv[4] || 'sin-nombre' });
  process.stdout.write(JSON.stringify(p).slice(1, -1));
}
