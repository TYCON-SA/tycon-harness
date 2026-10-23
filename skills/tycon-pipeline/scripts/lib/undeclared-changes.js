'use strict';
/**
 * undeclared-changes.js — el control al cerrar: lo que cambió de verdad en el repo de la ejecución contra lo declarado.
 *
 * Lo cambiado sale de git, relativo a la carpeta de la ejecución (que puede ser una subcarpeta del repo): el diff contra
 * el commit de arranque más lo no rastreado. Lo declarado es lo que pasó por Edit/Write (el registro del marcador),
 * `files_to_create`, `files_to_modify` y el File List del Dev Agent Record; un lock cuenta como declarado si su
 * manifiesto lo está. Lo que sobra es lo que cambió por otro camino —un `node -e`, un gestor de paquetes, un comando que
 * el freno no reconoce— y nadie nombró.
 * Lo que ya estaba cambiado o sin rastrear antes de arrancar (su fecha es anterior al arranque) no es de la ejecución:
 * sale como aviso. Las líneas que el propio arranque agrega al `.gitignore` (las de `.advisors`) tampoco cuentan.
 * Lo borrado por la terminal que el freno deja pasar (node_modules) no aparece en git: sale de `console-writes`, como aviso.
 * Sin commit de arranque o sin git, no se mide y se dice: «no pude mirar» no es «no sobra nada».
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseDeclaredFiles } = require('./test-scope.js');

// lock → los manifiestos que lo producen, en la misma carpeta
const LOCK_OF = {
  'package-lock.json': ['package.json'],
  'npm-shrinkwrap.json': ['package.json'],
  'yarn.lock': ['package.json'],
  'pnpm-lock.yaml': ['package.json'],
  'packages.lock.json': ['*.csproj', 'Directory.Packages.props'],
};

const toPosix = (p) => String(p).replace(/\\/g, '/');

function real(p) {
  try { return fs.realpathSync(p); } catch (_) { /* no existe: su carpeta */ }
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch (_) { return p; }
}

/**
 * Las rutas del File List del Dev Agent Record: cada ruta entre comillas invertidas (en lista o en prosa) y la primera
 * palabra de un renglón de lista sin comillas. La sección sigue en sus sub-encabezados (`#### Nuevos`) y termina en el
 * próximo encabezado de su mismo nivel o de uno más alto.
 */
function fileListOf(content) {
  const out = [];
  let nivel = 0;
  const agregar = (p) => { const x = toPosix(p).trim().replace(/^\.\//, ''); if (/[/.]/.test(x) && !/\s/.test(x)) out.push(x); };
  for (const linea of String(content || '').split(/\r?\n/)) {
    const h = /^(#{1,6})\s/.exec(linea);
    if (h && /^#{1,6}\s+File List\b/i.test(linea)) { nivel = h[1].length; continue; }
    if (nivel && h && h[1].length <= nivel) break;
    if (!nivel) continue;
    const comillas = [...linea.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const c of comillas) agregar(c);
    const m = !comillas.length && linea.match(/^\s*[-*]\s+(?:\[[ x]\]\s+)?(\S+)/);
    if (m) agregar(m[1]);
  }
  return out;
}

function lockDeclarado(rel, declarados) {
  const base = path.posix.basename(rel);
  const fuentes = LOCK_OF[base];
  if (!fuentes) return false;
  const dir = path.posix.dirname(rel);
  return [...declarados].some((d) => path.posix.dirname(d) === dir && fuentes.some((f) => (f.startsWith('*')
    ? path.posix.basename(d).endsWith(f.slice(1)) : path.posix.basename(d) === f)));
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  if (r.error) return { error: `git no se pudo ejecutar (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { error: `git ${args[0]} salió ${r.status}: ${(r.stderr || '').trim().split('\n')[0]}` };
  return { out: r.stdout };
}
const lineas = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

/** ¿El `.gitignore` sólo ganó líneas del propio arranque (las de `.advisors`, comentarios o vacías)? */
function gitignoreDelArranque(repo, baseSha) {
  const delArranque = (l) => /\.advisors/.test(l) || /^\+?\s*(#.*)?$/.test(l);
  const d = git(repo, ['diff', '-U0', '--relative', baseSha, '--', '.gitignore']);
  if (d.error) return false;
  const cambios = String(d.out).split('\n').filter((l) => /^[+-](?![+-]{2} )/.test(l));
  if (cambios.length) return cambios.every((l) => l.startsWith('+') && delArranque(l));
  // nuevo, sin rastrear: lo escribió entero el arranque si todas sus líneas son suyas
  try { return fs.readFileSync(path.join(repo, '.gitignore'), 'utf8').split(/\r?\n/).every(delArranque); } catch (_) { return false; }
}

/**
 * @param {object} a
 * @param {string} a.repo            el repo de la ejecución (puede ser una subcarpeta del repo de git)
 * @param {string|null} a.baseSha    el commit de arranque
 * @param {string|null} a.storyPath  la historia (puede vivir en otro repo)
 * @param {string|null} a.startedAt  cuándo arrancó la ejecución (ISO): lo cambiado antes no es suyo
 * @param {string[]} a.registrados   rutas absolutas que pasaron por Edit/Write
 * @param {object[]} a.consola       líneas de console-writes de la sesión ({path, kind})
 * @param {boolean} a.consolaApagada TYCON_NO_RUN_CHANGE=1: el registro de la consola no se escribe
 * @param {string[]} a.consolaProblemas lo que no se pudo leer del registro de la consola
 * @returns {{medido:boolean, motivo:string|null, sobra:string[], previos:string[], borrados:string[], avisos:string[]}}
 */
function computeUndeclared({ repo, baseSha, storyPath, startedAt = null, registrados = [], consola = [], consolaApagada = false, consolaProblemas = [] }) {
  const avisos = consolaProblemas.map((p) => `los borrados por la terminal pueden estar incompletos: ${p}`);
  const repoReal = repo ? real(repo) : null;
  const relDe = (abs) => {
    const r = toPosix(path.relative(repoReal, real(abs)));
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : null;
  };
  const borrados = repoReal ? consola.filter((l) => l && l.kind === 'delete' && l.path && relDe(l.path) !== null).map((l) => relDe(l.path) || '.') : [];
  if (consolaApagada) avisos.push('los borrados por la terminal no se registraron (TYCON_NO_RUN_CHANGE=1): no sé si se borró algo por fuera de git');
  for (const b of [...new Set(borrados)]) avisos.push(`borrado por la terminal: ${b}`);
  const noMedido = (motivo) => ({ medido: false, motivo, sobra: [], previos: [], borrados, avisos });
  if (!repo || !fs.existsSync(repo)) return noMedido(`el repo de la ejecución no está (${repo || 'sin ruta en el marcador'})`);
  if (!baseSha) return noMedido('el marcador no tiene el commit de arranque');
  // --relative: rutas contra la carpeta de la ejecución, aunque sea una subcarpeta (y sólo lo de adentro)
  const d = git(repo, ['diff', '--name-only', '--no-renames', '--relative', baseSha, '--']);
  if (d.error) return noMedido(d.error);
  const u = git(repo, ['ls-files', '--others', '--exclude-standard']);
  if (u.error) return noMedido(u.error);
  const cambiados = [...new Set([...lineas(d.out), ...lineas(u.out)].map(toPosix))];

  let content = '';
  if (storyPath) {
    try { content = fs.readFileSync(storyPath, 'utf8'); } catch (e) { return noMedido(`no pude leer la historia ${storyPath} (${e.code || e.message})`); }
  }
  const declarados = new Set([
    ...parseDeclaredFiles(content).filter((f) => !/^\(/.test(f)).map(toPosix),
    ...fileListOf(content),
    ...registrados.map(relDe).filter(Boolean),
  ]);
  const historiaRel = storyPath ? relDe(path.resolve(storyPath)) : null;
  const desde = Date.parse(startedAt || '');
  // un archivo que ya estaba así antes de arrancar: su última escritura es anterior al arranque
  const previo = (f) => {
    if (!Number.isFinite(desde)) return false;
    try { return fs.statSync(path.join(repoReal, f)).mtimeMs < desde; } catch (_) { return false; }
  };
  const sinDeclarar = cambiados.filter((f) => !f.split('/').includes('.advisors') && f !== historiaRel
    && !declarados.has(f) && !lockDeclarado(f, declarados) && !(path.posix.basename(f) === '.gitignore' && gitignoreDelArranque(repo, baseSha)));
  const previos = sinDeclarar.filter(previo).sort();
  if (previos.length) avisos.push(`ya estaba(n) cambiado(s) antes de arrancar (no cuenta(n) como de esta ejecución): ${previos.join(', ')}`);
  const sobra = sinDeclarar.filter((f) => !previos.includes(f)).sort();
  return { medido: true, motivo: null, sobra, previos, borrados, avisos };
}

/**
 * Las líneas de console-writes de una sesión (con la carpeta del nombre viejo, mientras dure el renombre):
 * `{ lineas, problemas }`. Un archivo que está y no se lee, o una línea rota, va a `problemas`: el aviso del cierre lo
 * dice, para que una lista incompleta no se lea como «no se borró nada más».
 */
function consoleWritesOf(stateDir, sessionId) {
  const sid = String(sessionId || 'sin-sesion').replace(/[^\w.-]/g, '_');
  const dirs = [path.join(stateDir, 'console-writes')];
  const problemas = [];
  try {
    const vieja = require('./legacy-names.js').legacyStatePath(dirs[0]);
    if (vieja && vieja !== dirs[0]) dirs.push(vieja);
  } catch (e) { problemas.push(`no pude saber el nombre viejo del registro (${e.code || e.message})`); }
  const lineas = [];
  for (const d of dirs) {
    const f = path.join(d, `${sid}.jsonl`);
    let texto = '';
    try { texto = fs.readFileSync(f, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') problemas.push(`no pude leer ${f} (${e.code || e.message})`);
      continue;
    }
    let rotas = 0;
    for (const l of texto.split('\n')) { try { if (l.trim()) lineas.push(JSON.parse(l)); } catch (_) { rotas++; } }
    if (rotas) problemas.push(`${rotas} línea(s) ilegible(s) en ${f}`);
  }
  return { lineas, problemas };
}

module.exports = { computeUndeclared, consoleWritesOf, fileListOf, LOCK_OF };
