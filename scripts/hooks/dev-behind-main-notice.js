#!/usr/bin/env node
'use strict';
// dev-behind-main-notice.js — SessionStart: en un repo de producto, dice en una línea si a `dev` le faltan commits de
// `main` y si hay trabajo en `dev` que hace días no llega a `main`. Reemplaza al paso «Warn if dev fell behind main» de
// los pipelines de producto, que avisaba en el log de una ejecución verde que nadie abre.
//
// A QUÉ REPOS MIRA: el del `cwd`, si tiene `origin`, no es un repo del arnés (scripts/lib/harness-repo.js), tiene
// `origin/main` y `origin/dev`, y su `origin` es de la organización de Azure DevOps del equipo (`ado.org`). Fuera de eso
// calla: no es «al día», es «no aplica». Sin `ado.org` configurado también calla (la integración apagada).
//
// QUÉ CUENTA, sin merges y sin los commits copiados por contenido del otro lado (`--cherry-pick`):
//   · el atraso: lo que `main` tiene y `dev` no, partido en lo del bot (los commits de versión, mismos asuntos que
//     scripts/ci/label-prs.sh) y lo real. Lo del bot solo no se avisa: cada despliegue lo deja.
//   · el trabajo trabado: lo que `dev` tiene y `main` no, si el más viejo tiene 7 días o más. Lo más nuevo está en curso.
//
// LA FRESCURA: no sale a la red; lee las refs del último fetch. La edad de esos datos es la de `FETCH_HEAD`: con más de
// 24 h, o sin `FETCH_HEAD`, nunca calla por «al día»: dice que no sabe.
//
// LA OFERTA: cuando habla, le pide al agente ofrecer poner `dev` al día (guides/git-commit-conventions.md §«Poner `dev`
// al día»), sin hacerlo hasta que la persona diga que sí; si hay trabajo trabado, también llevarlo a `main`. La oferta
// sale una vez por estado (repo + punta de `main` + punta de `dev`); la línea, en cada sesión mientras siga el atraso.
//
// Nunca rompe el arranque: sale 0 siempre. Cada `git` lleva tope de 3 s.
// Variables: TYCON_DEV_BEHIND_STUCK_DAYS (7) · TYCON_DEV_BEHIND_STALE_HOURS (24). Off: TYCON_DEV_BEHIND_NOTICE=0.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const GIT_TIMEOUT_MS = 3000;
const BOT_SUBJECTS = ['chore: bump version', 'chore: update form versions', 'chore: update versions'];
const DAY_MS = 86400000;
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js, si está al lado (el banco copia este hook suelto).
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const readVar = (() => {
  try {
    const { readEnv } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));
    return (n) => readEnv(n, { where: 'scripts/hooks/dev-behind-main-notice.js' });
  } catch { return (n) => process.env[n]; }
})();

// git sin las variables que deja un hook de git, sin preguntar nada por la terminal y con mensajes en inglés
const GIT_ENV = (() => {
  const e = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete e[k];
  return e;
})();
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS, env: GIT_ENV }).trim();
}
function gitOr(cwd, args, fallback = '') { try { return git(cwd, args); } catch { return fallback; } }
const hasRef = (root, ref) => gitOr(root, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]) !== '';
/** Como `hasRef`, pero sólo «no está» (git sale 1) es `false`: un tope vencido o un error tiran, para decirlo. */
function refExists(root, ref) {
  try { git(root, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]); return true; } catch (e) {
    if (e && e.status === 1 && !e.signal) return false;
    throw e;
  }
}
/** Las líneas de una clave de configuración; `[]` si no está (git sale 1). Un tope vencido o un error tiran. */
function configLines(root, key) {
  try { return git(root, ['config', '--get-all', key]).split('\n').filter(Boolean); } catch (e) {
    if (e && e.status === 1 && !e.signal) return [];
    throw e;
  }
}
const motivoDe = (e) => (e && (e.signal || e.code === 'ETIMEDOUT') ? `git tardó más de ${GIT_TIMEOUT_MS / 1000} s`
  : String((e && (e.stderr || e.message)) || 'git falló').trim().split('\n')[0]);

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
function edad(ms) {
  const h = ms / 3600000;
  if (h < 1) return `hace ${Math.max(1, Math.round(ms / 60000))} min`;
  if (h < 48) return `hace ${Math.round(h)} h`;
  return `hace ${Math.floor(ms / DAY_MS)} días`;
}
function numero(nombre, porDefecto) {
  const v = Number(readVar(nombre));
  return readVar(nombre) !== undefined && readVar(nombre) !== '' && Number.isFinite(v) && v >= 0 ? v : porDefecto;
}

/** El repo como se nombra: relativo a la raíz de repos si está debajo; si no, el nombre de la carpeta. */
function nombreDelRepo(root) {
  const raiz = readVar('TYCON_REPOS_ROOT');
  if (raiz) {
    const rel = path.relative(path.resolve(raiz), root);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return path.basename(root);
}

/** ¿El `origin` es de la organización del equipo? `null` = no aplica (callar); `{ aviso }` = configuración rota. */
function delEquipo(url) {
  const cfg = require(path.join(__dirname, '..', 'lib', 'tycon-config.js'));
  const { identidadAzure } = require(path.join(__dirname, '..', 'lib', 'harness-repo.js'));
  const r = cfg.leerParaHook();
  if (!r.ok) return { aviso: r.aviso };
  const org = cfg.valor(r.config, 'ado.org');
  if (!org) return null;
  const id = identidadAzure(url);
  return id && id.org === cfg.nombreDeOrganizacion(org).toLowerCase() ? { ok: true } : null;
}

/** ¿Alguna línea de `remote.origin.fetch` trae `dev`? Un nombre corto (`dev`) es `refs/heads/dev`, como lo lee git, y un
 *  refspec negativo (`^refs/heads/dev`) lo saca aunque otra línea lo traiga. */
function refspecTraeDev(refspecs) {
  const fuente = (r) => { const s = r.replace(/^[+^]/, '').split(':')[0]; return s.startsWith('refs/') ? s : `refs/heads/${s}`; };
  const cubre = (src) => {
    if (src === 'refs/heads/dev') return true;
    if (!src.includes('*')) return false;
    const [antes, despues] = src.split('*');
    return 'refs/heads/dev'.startsWith(antes) && 'refs/heads/dev'.endsWith(despues);
  };
  if (refspecs.some((r) => r.startsWith('^') && cubre(fuente(r)))) return false;
  return refspecs.some((r) => !r.startsWith('^') && cubre(fuente(r)));
}

/** Los commits de un lado de `origin/main...origin/dev`, sin merges ni copias: `[{ ct, asunto }]`. El asunto puede venir
 *  vacío (y el recorte de la salida le saca el tab final): la fecha se lee sola, nunca cortando a ciegas. */
function lado(root, cual) {
  const out = git(root, ['log', '--no-merges', `--${cual}-only`, '--cherry-pick', '--format=%ct%x09%s', 'origin/main...origin/dev']);
  return out ? out.split('\n').map((l) => { const m = /^(\d+)\t?(.*)$/.exec(l); return { ct: m ? Number(m[1]) : NaN, asunto: m ? m[2] : l }; }) : [];
}

/** La edad de lo último que se trajo de origin: el `FETCH_HEAD` más nuevo entre el de este checkout, el del repo común y
 *  el de cada worktree. Las refs de origin son una sola para todos, y cada worktree escribe su propio `FETCH_HEAD`. */
function edadDelFetch(root) {
  const propio = path.resolve(root, git(root, ['rev-parse', '--git-path', 'FETCH_HEAD']));
  const comunDir = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
  let otros = [];
  try { otros = fs.readdirSync(path.join(comunDir, 'worktrees')).map((w) => path.join(comunDir, 'worktrees', w, 'FETCH_HEAD')); } catch { otros = []; }
  const tiempos = [propio, path.join(comunDir, 'FETCH_HEAD'), ...otros].map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } }).filter((t) => t !== null);
  return tiempos.length ? Date.now() - Math.max(...tiempos) : null;
}

function cargarEstado(file) { try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; } catch { return {}; } }
function guardarEstado(file, s) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(s)); } catch { /* el arranque no se rompe por esto */ } }

function main() {
  if (readVar('TYCON_DEV_BEHIND_NOTICE') === '0') return;
  let event = {};
  try { const s = fs.readFileSync(0, 'utf8'); event = s ? JSON.parse(s) : {}; } catch { event = {}; }
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd();

  // ── ¿aplica? Una falla acá es «no sé si aplica»: se calla ─────────────────────────────────────────────
  let root; let url;
  try {
    root = git(cwd, ['rev-parse', '--show-toplevel']);
    // `remote get-url` aplica los alias de `url.<base>.insteadOf` (sin salir a la red): el remoto como lo usa git
    url = gitOr(root, ['remote', 'get-url', 'origin']);
    if (!root || !url) return;
    if (require(path.join(__dirname, '..', 'lib', 'harness-repo.js')).esRepoDelArnes(root)) return;
    if (!hasRef(root, 'refs/remotes/origin/main')) return;
  } catch { return; }
  let equipo;
  try { equipo = delEquipo(url); } catch { return; }
  if (equipo && equipo.aviso) { process.stderr.write(`${equipo.aviso}\n`); return; }
  if (!equipo) return;

  // ── aplica: de acá en adelante, una falla se dice ────────────────────────────────────────────────────────
  aplica = true;
  const repo = nombreDelRepo(root);
  let atraso; let enDev; let mainSha; let devSha; let fetchMs = null;
  try {
    if (!refExists(root, 'refs/remotes/origin/dev')) {
      // `git config --get-all` sale 1 cuando la clave no está: eso es «ninguna línea», no una falla
      const refspecs = (configLines(root, 'remote.origin.fetch') || []);
      if (refspecs.length && !refspecTraeDev(refspecs)) console.log(`dev: no puedo mirar — este clon sólo trae \`${refspecs.join(' ')}\` de origin`);
      return;
    }
    atraso = lado(root, 'left');
    enDev = lado(root, 'right');
    mainSha = git(root, ['rev-parse', 'refs/remotes/origin/main']);
    devSha = git(root, ['rev-parse', 'refs/remotes/origin/dev']);
    fetchMs = edadDelFetch(root);
  } catch (e) {
    console.log(`dev: no pude mirar si está al día (${motivoDe(e)})`);
    return;
  }
  const delBot = atraso.filter((c) => BOT_SUBJECTS.some((b) => c.asunto.startsWith(b))).length;
  const reales = atraso.length - delBot;
  const diasTrabado = numero('TYCON_DEV_BEHIND_STUCK_DAYS', 7);
  const fechas = enDev.map((c) => c.ct).filter(Number.isFinite);
  const masViejo = fechas.length ? Math.min(...fechas) : null;
  const dias = masViejo === null ? null : Math.floor((Date.now() - masViejo * 1000) / DAY_MS);
  const trabado = dias !== null && dias >= diasTrabado;
  const viejos = fetchMs === null || fetchMs > numero('TYCON_DEV_BEHIND_STALE_HOURS', 24) * 3600000;
  const edadDatos = fetchMs === null ? 'de fecha desconocida' : edad(fetchMs);

  if (reales === 0 && !trabado) {
    if (viejos) console.log(`dev: no sé si está al día en ${repo} — lo último que este clon trajo de origin es ${edadDatos}; \`git fetch\` para mirar`);
    return;
  }
  const partes = [];
  if (reales > 0) partes.push(`${reales === 1 ? 'le falta' : 'le faltan'} ${plural(reales, 'commit', 'commits')} de main${delBot ? ` (y ${delBot} de versión del bot)` : ''}`);
  if (trabado) partes.push(`${plural(enDev.length, 'commit', 'commits')} en dev sin llegar a main, el más viejo de hace ${plural(dias, 'día', 'días')}`);
  partes.push(`datos del último fetch, ${edadDatos}`);
  // la línea sale primero: lo que pase después con el estado de la oferta no la puede tapar
  console.log(`⚠️ ${reales > 0 ? 'dev atrasada' : 'dev con trabajo trabado'} en ${repo}: ${partes.join(' · ')}`);
  aplica = false;

  // la clave es el repo sin usuario ni clave (una URL de origin puede traer credenciales): su resumen, no la URL
  let ofrecer;
  try {
    const archivo = path.join(stateDirOf(os.homedir()), 'dev-behind-notice.json');
    const estado = cargarEstado(archivo);
    const clave = crypto.createHash('sha256').update(url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1')).digest('hex').slice(0, 32);
    const ahora = `${mainSha}:${devSha}`;
    ofrecer = estado[clave] !== ahora;
    if (ofrecer) { estado[clave] = ahora; guardarEstado(archivo, estado); }
  } catch { ofrecer = true; }
  if (ofrecer) {
    console.log('Para el agente: ofrecele a la persona poner `dev` al día con el procedimiento de guides/git-commit-conventions.md'
      + ' §«Poner `dev` al día», y no lo hagas hasta que diga que sí.'
      + (trabado ? ' Ofrecé también llevar a main lo trabado con /tycon-merge-to-main: poner dev al día no lo destraba.' : ''));
  }
}

// Si algo falla después de saber que el repo aplica, se dice; antes, se calla. El arranque nunca se rompe.
let aplica = false;
try { main(); } catch (e) {
  if (aplica) { try { console.log(`dev: no pude mirar si está al día (${motivoDe(e)})`); } catch { /* nada más que hacer */ } }
}
process.exit(0);
