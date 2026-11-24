'use strict';
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * delegated-pass.js — el pase adversarial que le toca a la corrida del repo hermano (@story-8.238).
 *
 * Una historia que vive en un repo y cambia el código de otro (el hermano de `.tycon/advisors.yaml →
 * evidence.companion_repos`) tiene dos corridas: la del repo de la historia, sin código, y la del hermano, con su propio
 * portón y su propio pase. La del repo de la historia le deja el pase a la del hermano sólo si se cumple todo:
 *
 *   - la corrida trae `--files`, y ninguno es de código;
 *   - el repo de la corrida no tiene código cambiado desde la base de SU marcador (commiteado, sin commitear o nuevo).
 *     Otra base (la variable, la bifurcación, HEAD) no sirve: un `.md` sin commitear sobre código commiteado parecería
 *     sólo documentación;
 *   - la historia no declara código en el repo de la corrida, y sí en algún hermano declarado en lo commiteado (dejarle
 *     el pase a otro afloja un control: el hermano se lee como lo lee la evidencia de cierre);
 *   - por cada hermano con código declarado se ve, en la carpeta del estado de esta máquina, una ejecución abierta de la
 *     misma historia (la misma ruta, no sólo el número) sobre ese repo (o una copia suya, un worktree), de otra sesión
 *     que vive (su registro de Claude Code con el proceso vivo) y tocada en las últimas 6 horas, el mismo plazo con que
 *     se podan los marcadores ajenos. Una sesión sin registro (cerrada, o de Codex) no cuenta: ante la duda, el pase se
 *     decide acá.
 *
 * Los nombres de archivo se leen como los da git con `-z`: sin las comillas y los octales con que cita un nombre no
 * ASCII, y sin la detección de renombres, que esconde el nombre viejo de un archivo de código renombrado.
 *
 * Lo que no se puede mirar no deja el pase: `{ ok: false, motivo }`. Con todo, `{ ok: true, hermanos: [{ repo, sesion,
 * story }] }`. Esta función lee git y la carpeta del estado; el portón (`pipeline.js criterioDelPase`) recibe lo que
 * devuelve.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const codeFiles = require('./code-files.js');
const stackConfig = require('./stack-config.js');
const companionLib = require('./companion-repos.js');
const { parseEvidenceConfig, discoverRepoRoot } = require('./evidence-config.js');
const { stateDir } = require('./state-dir.js');
const { liveness } = require('./session-liveness.js');

// el plazo de un marcador ajeno, como en on-prompt.js y story-gate-io.js
const STALE_HOURS = 6;

const no = (motivo) => ({ ok: false, motivo });

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.quotePath=off', '-C', cwd, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  if (r.error || r.status !== 0) return { error: (r.error && (r.error.code || r.error.message)) || String(r.stderr || '').trim().split('\n')[0] || `git salió ${r.status}` };
  return { out: String(r.stdout || '') };
}

// el código del arnés (lib/code-files.js, con lo que sume la organización) más `.sql`, como lo cuenta la densidad
const esCodigo = (f) => codeFiles.isCode(f, { extra: stackConfig.orgExtra() }) || /\.sql$/i.test(f);

// la carpeta común de git: la misma para un repo y sus worktrees
function comunDe(dir) {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.error ? null : companionLib.real(r.out.trim());
}

/** Los archivos de código cambiados en `top` desde `base`: commiteados, sin commitear y nuevos. `{ archivos }` o `{ error }`. */
function codigoCambiado(top, base) {
  const d = git(top, ['diff', '--name-only', '--no-renames', '-z', base, '--']);
  if (d.error) return { error: `git diff contra la base falló (${d.error})` };
  const n = git(top, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (n.error) return { error: `git no pudo listar los archivos nuevos (${n.error})` };
  const todos = [...d.out.split('\0'), ...n.out.split('\0')].filter(Boolean);
  return { archivos: [...new Set(todos.filter(esCodigo))] };
}

/**
 * Las ejecuciones abiertas de la carpeta del estado: los marcadores de `active/` que se pueden leer, sin cierre, tocados
 * en las últimas `STALE_HOURS` horas. Uno sin hora de último toque que se lea no cuenta.
 */
function ejecucionesAbiertas(estado, { ahora = Date.now() } = {}) {
  let nombres = [];
  try { nombres = fs.readdirSync(path.join(estado, 'active')).filter((f) => f.endsWith('.json')); } catch (_) { return []; }
  const out = [];
  for (const f of nombres) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(estado, 'active', f), 'utf8')); } catch (_) { continue; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || m.cierre) continue;
    const toque = Date.parse(m.lastTouch || '');
    if (!Number.isFinite(toque) || ahora - toque > STALE_HOURS * 3600 * 1000) continue;
    out.push(m);
  }
  return out;
}

// la ruta real de la historia de un marcador (relativa a su repo, o absoluta), o null
function historiaDe(m) {
  if (!m || typeof m.storyPath !== 'string' || !m.storyPath) return null;
  return companionLib.real(path.resolve(m.repoPath || '/', m.storyPath));
}

function paseDelegado({ repo, story, files, filesDeclarado, marcador, estado, home, env = process.env } = {}) {
  if (!marcador || !marcador.storyId) return no('no hay una ejecución de esta historia en esta sesión');
  if (!repo || !story) return no('falta el repo o la historia de la corrida');
  if (!filesDeclarado) return no('sin --files no se sabe qué código trae la corrida');
  const conCodigo = (Array.isArray(files) ? files : []).filter(esCodigo);
  if (conCodigo.length) return no(`el --files trae código (${conCodigo.slice(0, 3).join(', ')}): ese pase es de esta corrida`);

  // la base de la corrida: sólo la de su marcador
  const b = require('./coverage-base.js').resolver({ repo, env, marker: marcador });
  if (b.source !== 'marcador' || !b.ref) {
    const porque = b.descartadas.filter((x) => x.source === 'marcador').map((x) => x.motivo)[0] || 'el marcador no trae la base';
    return no(`la base no sale del marcador de la corrida (${porque}): no se puede saber qué código cambió`);
  }
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (top.error) return no(`el repo de la corrida no es un repo git (${top.error})`);
  const propio = codigoCambiado(top.out.trim(), b.ref);
  if (propio.error) return no(propio.error);
  if (propio.archivos.length) return no(`el repo de la corrida tiene código cambiado (${propio.archivos.slice(0, 3).join(', ')}): ese pase es de esta corrida`);

  // los hermanos declarados en lo commiteado, del repo de la corrida y del de la historia. El repo de la corrida, o una
  // copia suya (la misma carpeta común de git), nunca es su propio hermano: dos sesiones en el mismo repo se dejarían el
  // pase una a la otra y ninguna lo correría
  const repoDeLaStory = discoverRepoRoot(story) || repo;
  const comunPropio = comunDe(repo);
  if (!comunPropio) return no('no pude leer la carpeta común de git del repo de la corrida');
  const raices = [];
  for (const r of [repo, repoDeLaStory]) {
    for (const c of parseEvidenceConfig(r, { freno: true }).roots) {
      if (comunDe(c) === comunPropio) continue;
      if (!raices.some((x) => companionLib.real(x) === companionLib.real(c))) raices.push(c);
    }
  }
  // el código que la historia declara en el repo de la corrida: visto desde el repo de la historia, sea éste o un hermano
  let declaradoAca;
  try {
    declaradoAca = companionLib.declaredFor(repoDeLaStory, story, repo).filter(esCodigo);
    if (comunDe(repoDeLaStory) === comunPropio) declaradoAca.push(...companionLib.declaredFor(repoDeLaStory, story, repoDeLaStory).filter(esCodigo));
  } catch (e) {
    return no(`no pude leer lo que declara la historia (${e.message})`);
  }
  if (declaradoAca.length) return no(`la historia declara código en el repo de la corrida (${declaradoAca.slice(0, 3).join(', ')}): ese pase es de esta corrida`);
  const conCodigoDeclarado = [];
  for (const c of raices) {
    let d;
    try { d = companionLib.declaredFor(repoDeLaStory, story, c).filter(esCodigo); } catch (e) { return no(`no pude leer lo que declara la historia (${e.message})`); }
    if (d.length) conCodigoDeclarado.push(c);
  }
  if (!conCodigoDeclarado.length) return no('la historia no declara código en un repo hermano commiteado en .tycon/advisors.yaml');

  // por cada hermano con código, su ejecución abierta de la misma historia, de otra sesión
  const abiertas = ejecucionesAbiertas(estado || stateDir(home));
  const laHistoria = companionLib.real(path.resolve(story));
  const vive = (sid) => { try { return liveness(sid, home ? { home } : {}).alive === true; } catch (_) { return false; } };
  const hermanos = [];
  for (const c of conCodigoDeclarado) {
    const comun = comunDe(c);
    const nombre = companionLib.label(c);
    const vista = comun && abiertas.find((m) => String(m.storyId) === String(marcador.storyId) && historiaDe(m) === laHistoria
      && m.sessionId && m.sessionId !== marcador.sessionId && m.repoPath && comunDe(m.repoPath) === comun && vive(m.sessionId));
    if (!vista) return no(`no veo una ejecución abierta de la historia ${marcador.storyId} en ${nombre}: el pase se decide acá`);
    hermanos.push({ repo: vista.repoPath, nombre, sesion: vista.sessionId || null, story: String(vista.storyId) });
  }
  return { ok: true, hermanos, motivo: `el código va a ${hermanos.map((h) => h.nombre).join(', ')}, y su corrida decide el pase` };
}

module.exports = { paseDelegado, codigoCambiado, ejecucionesAbiertas };
