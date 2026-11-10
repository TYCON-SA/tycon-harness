#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse (cadena `pre-edit`, cualquier paso de una corrida abierta) — una prueba vieja en rojo no se
 * edita en silencio.
 *
 * Una prueba que ya existía en `origin/main` y figura en las fallas del último `.advisors/tests-result.json` de esta
 * sesión frena: se para y se anota por qué (`marker.js note-red-test --test <ruta> --reason "<motivo>"`); la nota va al
 * contexto de los revisores y al mensaje del commit. Si la prueba nombra un archivo de un control
 * (`scripts/ci/controls-from-base.json`), la nota no alcanza: la edición la firma el dueño (`red-control-test-edit`).
 * Lo que no se puede saber (sin reporte, sin la entrada de cada falla, sin sesión, raíz desconocida, git que no
 * contesta) no frena y queda en `gates.log` como no medido. La decisión vive en `lib/red-test-edit.js`.
 *
 * Contrato del despachador: handle(event, opts) → null (pasa) | { block: msg }.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { stateDir: stateDirOf } = require('./lib/state-dir.js');
const { resolveSessionId } = require('./lib/session-id.js');
const rte = require('./lib/red-test-edit.js');

const RAIZ_DEL_ARNES = path.join(__dirname, '..', '..', '..');
const MARKER = path.join(__dirname, 'marker.js');

/** El marcador de la sesión: `{ marker }`; sin archivo, `{ marker: null }` (no hay corrida); ilegible, `{ marker: null, motivo }`. */
function leerMarcador(stateDir, sessionId) {
  const safe = String(sessionId || '_nosession').replace(/[/\\]/g, '_');
  let texto;
  try { texto = fs.readFileSync(path.join(stateDir, 'active', `${safe}.json`), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { marker: null } : { marker: null, motivo: `el marcador de la sesión no se puede leer (${e.code || e.message})` };
  }
  try {
    const m = JSON.parse(texto);
    return { marker: m && m.storyId ? m : null };
  } catch (e) {
    return { marker: null, motivo: `el marcador de la sesión no es un JSON legible (${e.message})` };
  }
}

function anotar(stateDir, sessionId, obj) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({ ts: new Date().toISOString(), sessionId, name: rte.NOMBRE, ...obj }) + '\n', 'utf8');
  } catch (e) {
    // anotar nunca rompe el freno, pero lo que no se pudo anotar se dice
    process.stderr.write(`⚠️  on-red-test-edit: no pude anotar en gates.log (${e.code || e.message}): ${obj.status || ''} ${obj.reason || ''}\n`);
  }
}

/** El reporte de pruebas: `{ reporte }`; sin archivo, `{ reporte: null }`; uno que está y no se lee, además `error`. */
function leerReporte(p) {
  let texto;
  try { texto = fs.readFileSync(p, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? { reporte: null } : { reporte: null, error: `el reporte de pruebas ${p} no se lee (${e.code || e.message})` };
  }
  try { return { reporte: JSON.parse(texto) }; } catch (e) {
    return { reporte: null, error: `el reporte de pruebas ${p} no es un JSON legible (${e.message})` };
  }
}

const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** El repo de git del archivo, o null. */
function repoDe(archivo) {
  const r = git(path.dirname(archivo), ['rev-parse', '--show-toplevel']);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** ¿La prueba existía en `origin/main` de su repo? true | false | null (git no contestó). */
function existiaEnMain(archivo) {
  const repo = repoDe(archivo);
  if (!repo) return null;
  if (git(repo, ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']).status !== 0) return null;
  const rel = path.relative(rte.rutaReal(repo), archivo).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return null;
  return git(repo, ['cat-file', '-e', `origin/main:${rel}`]).status === 0;
}

/**
 * La carpeta de skills del repo que corrió las pruebas, con la misma función que usó el corredor de `suites.json` para
 * escribir las fallas (`resolveSkillsRoot`): `{ dir }`, o `{ dir: null, motivo }` si no se puede saber.
 */
function carpetaDeSkills(repo) {
  try {
    const dir = require('./lib/run-suites-json.js').resolveSkillsRoot(repo || process.cwd(), null, process.env).dir;
    return dir ? { dir } : { dir: null, motivo: 'el corredor de suites.json no dio la carpeta de skills' };
  } catch (e) { return { dir: null, motivo: `no pude resolver la carpeta de skills (${e.message})` }; }
}

/**
 * Los reportes de los repos hermanos que nombra el principal (`companions[]`). El reporte lo puede escribir cualquiera:
 * de cada hermano se lee sólo su reporte en el lugar fijo (`<repo>/.advisors/tests-result.json`) de un repo git, y no se
 * carga ningún guion suyo (su carpeta de skills es la de la corrida).
 */
function reportesHermanos(reporte, skillsDir) {
  const lista = reporte && Array.isArray(reporte.companions) ? reporte.companions : [];
  const out = [];
  for (const c of lista) {
    // un hermano que no se puede ubicar deja su motivo: `decidir` lo anota para las pruebas de esa carpeta
    if (!c || typeof c.root !== 'string' || !c.root) {
      out.push({ reporte: null, repo: null, skillsDir, error: 'un hermano de companions[] no dice su carpeta (root)' });
      continue;
    }
    const repo = repoDe(path.join(c.root, '.advisors', 'tests-result.json'));
    if (!repo || rte.rutaReal(repo) !== rte.rutaReal(c.root)) {
      out.push({ reporte: null, repo: c.root, skillsDir, error: `la carpeta del repo hermano ${c.root} no es la raíz de un repo git: no leo su reporte` });
      continue;
    }
    const p = path.join(repo, '.advisors', 'tests-result.json');
    let texto = null;
    try { texto = fs.readFileSync(p, 'utf8'); } catch (e) {
      out.push({ reporte: null, repo, skillsDir, error: `el reporte del repo hermano ${repo} no se lee (${e.code || e.message})` });
      continue;
    }
    try { out.push({ reporte: JSON.parse(texto), repo, skillsDir }); } catch (e) {
      out.push({ reporte: null, repo, skillsDir, error: `el reporte del repo hermano ${repo} no es un JSON legible (${e.message})` });
    }
  }
  return out;
}

/** La ruta como la escribe un comando para la consola: entre comillas simples si trae algo que la consola partiría. */
const paraLaConsola = (p) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(p) ? p : `'${String(p).replace(/'/g, "'\\''")}'`);

/**
 * El inventario de controles del repo del archivo; si ese repo no lo tiene, el del arnés que corre este freno. Si el
 * que corresponde está y no se lee, `{ error }`: no se cae a otro, que podría no nombrar los controles de este repo.
 */
function controlesPara(archivo) {
  const leer = (p) => {
    let texto;
    try { texto = fs.readFileSync(p, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? null : { error: `${p}: ${e.code || e.message}` }; }
    try { return JSON.parse(texto); } catch (e) { return { error: `${p}: ${e.message}` }; }
  };
  const repo = repoDe(archivo);
  const enSuRepo = repo ? leer(path.join(repo, 'scripts', 'ci', 'controls-from-base.json')) : null;
  if (enSuRepo) return enSuRepo;
  return leer(path.join(RAIZ_DEL_ARNES, 'scripts', 'ci', 'controls-from-base.json')) || { error: 'ni el repo del archivo ni el arnés tienen scripts/ci/controls-from-base.json' };
}

function cartelDeNota(prueba) {
  return [
    `🔴 PRUEBA EN ROJO — edición frenada: "${path.basename(prueba)}" ya existía en origin/main y está en rojo en el último`,
    '   reporte de pruebas de esta corrida.',
    '   Una prueba que ya existía y estaba en rojo no se edita para que pase: se para y se dice por qué.',
    '   Por qué frena: corregir la prueba en vez del código esconde el defecto que la prueba medía, y nadie se entera.',
    '   Qué hacer AHORA: si lo que está mal es el código, arreglá el código. Si lo que está mal es la prueba, anotá por qué',
    '   y repetí esta edición:',
    `     node "${MARKER}" note-red-test --test ${paraLaConsola(prueba)} --reason "<por qué la prueba está mal>"`,
    '   La razón va al contexto de los revisores y al mensaje del commit.',
  ].join('\n');
}

function cartelDeFirma(prueba, control, renglones, motivo) {
  return [
    `🔴 PRUEBA DE UN CONTROL EN ROJO — edición frenada: "${path.basename(prueba)}" ya existía en origin/main, está en rojo en`,
    `   el último reporte de esta corrida y nombra ${control}, un archivo de un control.`,
    '   Una prueba que ya existía y estaba en rojo no se edita para que pase: se para y se dice por qué.',
    '   Por qué frena: si la prueba de un control se corrige para que pase, el control puede quedar apagado sin que nadie',
    '   lo decida. Por eso una nota no alcanza: la edición la decide la persona.',
    '   Qué hacer AHORA: pará y contale a la persona por qué la prueba está mal. Si está de acuerdo, la firma:',
    ...renglones.map((l) => `     · ${l}`),
    '   y, con su «Sí», repetí esta edición. La firma vale una vez y queda anotada.',
    motivo ? `   (No hay firma: ${motivo}.)` : '',
  ].filter((l) => l !== '').join('\n');
}

/**
 * @param {object} event evento PreToolUse (Edit/Write, o el parche de Codex ya normalizado por el despachador)
 * @param {object} [opts] { stateDir, casa, skillsDir } — para las pruebas
 */
function handle(event, opts = {}) {
  const filePath = event && event.tool_input && event.tool_input.file_path;
  if (!filePath) return null;
  const stateDir = opts.stateDir || stateDirOf(os.homedir());
  const sessionId = resolveSessionId(event.session_id);
  const lm = leerMarcador(stateDir, sessionId);
  if (lm.motivo) {
    // un marcador que no se lee no es «sin corrida»: no se frena a ciegas, pero queda dicho
    anotar(stateDir, sessionId, { status: 'not-measured', file: filePath, reason: lm.motivo });
    return null;
  }
  const marker = lm.marker;
  if (!marker) return null;

  const archivo = path.isAbsolute(filePath) ? filePath : path.resolve(event.cwd || process.cwd(), filePath);
  const repoDelReporte = marker.repoPath || null;
  const lr = repoDelReporte ? leerReporte(path.join(repoDelReporte, '.advisors', 'tests-result.json')) : { reporte: null };
  const reporte = lr.reporte;
  const cs = opts.skillsDir ? { dir: opts.skillsDir } : carpetaDeSkills(repoDelReporte);
  const skillsDir = cs.dir;
  const r = rte.decidir({
    archivo, marker, sessionId, reporte, reporteError: lr.error || null, repoDelReporte,
    hermanos: reportesHermanos(reporte, skillsDir),
    controles: controlesPara(archivo),
    existiaEnMain,
    textoDeLaPrueba: (p) => fs.readFileSync(p, 'utf8'),
    skillsDir,
    skillsMotivo: cs.motivo || null,
  });

  if (r.decision === 'no-medido') {
    anotar(stateDir, sessionId, { repoPath: repoDelReporte, status: 'not-measured', story: marker.storyId, file: r.prueba, reason: r.motivo });
    return null;
  }
  if (r.controlSinMedir) {
    anotar(stateDir, sessionId, { repoPath: repoDelReporte, status: 'not-measured', story: marker.storyId, file: r.prueba,
      reason: `no pude ver si es la prueba de un control: ${r.controlSinMedir}` });
  }
  if (r.decision === 'nota') {
    anotar(stateDir, sessionId, { repoPath: repoDelReporte, status: 'blocked', story: marker.storyId, file: r.prueba, reason: 'falta la nota' });
    // el cartel nombra la prueba como la escribió el agente: la nota y la firma se comparan por la ruta real
    return { block: cartelDeNota(archivo) + '\n' };
  }
  if (r.decision === 'firma') {
    const f = firmaDelDueno(event, sessionId, archivo, opts.casa);
    if (f.ok) return null;
    anotar(stateDir, sessionId, { repoPath: repoDelReporte, status: 'blocked', story: marker.storyId, file: r.prueba, reason: `prueba de un control (${r.control}): falta la firma` });
    return { block: cartelDeFirma(archivo, r.control, f.renglones, f.motivo) + '\n' };
  }
  return null;
}

/** La firma del dueño sobre esta prueba: `{ ok }` la consume; si no, las dos formas de pedirla y el motivo. */
function firmaDelDueno(event, sesion, prueba, casa) {
  let ow = null;
  try { ow = require(path.join(RAIZ_DEL_ARNES, 'scripts', 'lib', 'owner-window.js')); } catch (e) {
    return { ok: false, motivo: `no pude consultar la ventana (${e.message})`,
      renglones: [`la firma de archivo ${rte.FIRMA} sobre ${prueba}, en la ventana de permiso`] };
  }
  const renglones = ow.formasDeFirmar(rte.FIRMA, prueba, sesion).renglones;
  try {
    return { ...ow.consumirArchivo({ firma: rte.FIRMA, sesion, archivo: prueba, cwd: event.cwd, casa }), renglones };
  } catch (e) {
    return { ok: false, motivo: `no pude consultar la ventana (${e.message})`, renglones };
  }
}

module.exports = { handle, reportesHermanos };

if (require.main === module) {
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    const r = handle(stdin ? JSON.parse(stdin) : null);
    if (r && r.block) { process.stderr.write(r.block); process.exit(2); }
    process.exit(0);
  } catch (e) {
    // falla abierta, pero con constancia: un error del freno no se lee como «no había nada que frenar»
    process.stderr.write(`⚠ on-red-test-edit: error (failing open): ${e.message}\n`);
    anotar(stateDirOf(os.homedir()), resolveSessionId(), { status: 'not-measured', reason: `el freno falló: ${e.message}` });
    process.exit(0);
  }
}
