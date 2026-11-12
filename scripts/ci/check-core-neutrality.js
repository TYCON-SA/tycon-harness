#!/usr/bin/env node
'use strict';
/**
 * check-core-neutrality.js — el candado de las plataformas: el núcleo no suma comandos ni direcciones de una plataforma.
 *
 * El núcleo del arnés dice qué se hace; cómo se hace en cada plataforma lo dice su conector (guides/constitucion.md). Este
 * control cuenta, por archivo, las líneas de lo que va al commit (el índice de git) que casan con alguna señal dura de
 * plataforma: un comando o una dirección real. Las señales no están escritas acá: las declara cada conector en su
 * manifiesto (`hardSignals` de `integrations/<n>/integration.json`, `kind: "platform"`).
 *
 * Qué no es núcleo, y no se cuenta: `integrations/` y `guides/integrations/`; las pruebas (una carpeta `tests/` o `test/`,
 * un `*.test.*`) y sus fotos (`fixtures/`); los casos y los exámenes del banco de controles (son datos de prueba; el resto
 * del banco, su corredor y sus guiones, sí cuenta); los registros de firma de los controles (`.github|.tycon/control-changes/`);
 * y lo que no viaja al público (en el árbol armado de los nocturnos, lo propio del repo de mantenimiento).
 *
 * Lo que queda tiene que estar en la lista (scripts/ci/neutrality-allowlist.json): cada entrada es un archivo exacto con
 * su techo (cuántas líneas puede tener) y su motivo. Un archivo con señales que no está en la lista, o uno que pasa su
 * techo, frena con el archivo y la línea. La lista sólo baja: un techo que sobra se avisa, y una entrada cuyo archivo ya no
 * tiene señales frena hasta que se saque. `signals_at_least` es cuántos patrones tienen que salir de los manifiestos: un
 * conector que desaparece o pierde sus señales no apaga el control en silencio. La lista y los manifiestos de plataforma
 * son reglas del control en scripts/ci/controls-from-base.json: sacar un patrón o subir un techo es aflojarlo.
 *
 * Uso: node scripts/ci/check-core-neutrality.js --repo <dir> [--measure] [--json] [--skip-thin]
 *   sale 0 dentro de la lista · 1 algo sube o una entrada está mal · 2 no pude mirar (git, la lista o los manifiestos)
 *   --measure imprime lo que cuenta cada archivo del núcleo (para armar la lista) y sale 0
 *   --skip-thin lo pasa sólo el pre-commit propio del repo de mantenimiento adelgazado: si el árbol lo es
 *     (`.tycon/internal-forms.json` con `layout: "thin"`), no cuenta y lo dice; lo que se publica lo mira el repo público
 * Casos: scripts/tests/platform-neutrality.test.js
 */

const path = require('path');
const { spawnSync } = require('child_process');

const RULES = 'scripts/ci/neutrality-allowlist.json';
const MAX_BUFFER = 512 * 1024 * 1024;
// lo que no es texto: una imagen, un video o un comprimido no nombra nada que se lea
const MEDIA = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp4|webm|mov|wav|mp3)$/i;

class LookError extends Error {}

// el color de git apagado: con `color.ui=always` en la configuración de una máquina, la salida trae escapes y no se lee
function git(repo, args, input) {
  const r = spawnSync('git', ['-C', repo, '-c', 'color.ui=never', ...args], { encoding: input === undefined ? 'utf8' : 'buffer', maxBuffer: MAX_BUFFER, input });
  if (r.error) throw new LookError(`git no corrió (${r.error.code || r.error.message})`);
  return r;
}
/** El contenido de un archivo en el índice, o null si no está. Uno que está y no se puede leer no es «no está»: tira. */
function indexed(repo, rel) {
  if (git(repo, ['ls-files', '--error-unmatch', '--', rel]).status !== 0) return null;
  const r = git(repo, ['show', `:${rel}`]);
  if (r.status !== 0) throw new LookError(`${rel} está en el índice y no se puede leer (git show salió con ${r.status})`);
  return r.stdout;
}

/** ¿Es núcleo? Fuera quedan los conectores, sus guías, las pruebas y sus fotos, los datos del banco y las firmas. */
function core(rel) {
  return !(rel.startsWith('integrations/') || rel.startsWith('guides/integrations/')
    || /(^|\/)tests?\//.test(rel) || /\.test\.[A-Za-z0-9]+$/.test(rel) || /(^|\/)fixtures\//.test(rel)
    || rel.startsWith('scripts/controls-bench/cases/') || rel.startsWith('scripts/controls-bench/reviewer-exams/')
    || /^\.(github|tycon)\/control-changes\/[^/]+\.json$/.test(rel) || MEDIA.test(rel));
}

/** ¿El repo de mantenimiento adelgazado? Ahí viven las stories y los registros, que nombran plataformas con derecho. */
function thinLayout(repo) {
  try { return JSON.parse(indexed(repo, '.tycon/internal-forms.json') || '').layout === 'thin'; } catch (_) { return false; }
}

/**
 * Los manifiestos de los conectores en el índice: los de primer nivel de integrations/, como los lee el lector de
 * integraciones. El `*` de git cruza carpetas, así que el manifiesto de una foto dentro de un conector no cuenta.
 */
function manifestsOf(repo) {
  const ls = git(repo, ['ls-files', '-z', '--', 'integrations/*/integration.json']);
  if (ls.status !== 0) throw new LookError(`git ls-files salió con ${ls.status}: ${(ls.stderr || '').trim().slice(0, 200)}`);
  return ls.stdout.split('\0').filter((rel) => rel && rel.split('/').length === 3);
}

/** Los patrones que declaran los conectores de plataforma del índice; cada uno con el conector que lo trae. */
function signalsOf(repo) {
  const out = [];
  for (const rel of manifestsOf(repo)) {
    let m;
    try { m = JSON.parse(indexed(repo, rel) || ''); } catch (e) { throw new LookError(`${rel} no se puede leer (${e.message}): no sé qué señales buscar`); }
    if (!m || m.kind !== 'platform' || m.hardSignals === undefined) continue;
    if (!Array.isArray(m.hardSignals)) throw new LookError(`${rel}: «hardSignals» no es una lista`);
    for (const s of m.hardSignals) {
      // un patrón vacío contaría cualquier línea; uno que no compila, ninguna
      if (typeof s !== 'string' || !s.trim()) throw new LookError(`${rel}: un patrón de «hardSignals» vacío`);
      try { out.push({ re: new RegExp(s), connector: m.name, source: s }); } catch (e) { throw new LookError(`${rel}: el patrón ${JSON.stringify(s)} no compila (${e.message})`); }
    }
  }
  return out;
}

function readRules(repo) {
  const text = indexed(repo, RULES);
  if (text === null) throw new LookError(`falta ${RULES}: sin la lista no sé qué archivos del núcleo tienen derecho a nombrar una plataforma`);
  let r;
  try { r = JSON.parse(text); } catch (e) { throw new LookError(`${RULES} no es JSON (${e.message})`); }
  if (!r || typeof r !== 'object' || !Array.isArray(r.entries)) throw new LookError(`${RULES}: «entries» es una lista`);
  if (!Number.isInteger(r.signals_at_least) || r.signals_at_least < 1) throw new LookError(`${RULES}: «signals_at_least» es un entero ≥ 1`);
  return { entries: r.entries, signalsAtLeast: r.signals_at_least };
}

/** Lo que viaja de una lista de rutas: en el árbol armado, sin lo propio del repo de mantenimiento. */
function travelling(repo, files) {
  let IH;
  try { IH = require(path.join(__dirname, '..', 'publishing', 'internal-history.js')); } catch (e) { throw new LookError(`no pude cargar internal-history.js (${e.code || e.message}): no sé qué viaja`); }
  try { return IH.travelling(repo, files, 'el núcleo'); } catch (e) { throw new LookError(e.message); }
}

/** Los textos de los archivos del índice, en una sola llamada a git (`cat-file --batch`). */
function contents(repo, files) {
  const ls = git(repo, ['ls-files', '-s', '-z']);
  if (ls.status !== 0) throw new LookError(`git ls-files salió con ${ls.status}`);
  const wanted = new Set(files);
  const blobs = [];
  for (const rec of ls.stdout.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [mode, sha] = rec.slice(0, tab).split(' ');
    const file = rec.slice(tab + 1);
    // un submódulo (160000) apunta a un commit de otro repo: no es un archivo que se lea
    if (wanted.has(file) && mode !== '160000') blobs.push({ file, sha });
  }
  const r = git(repo, ['cat-file', '--batch'], Buffer.from(blobs.map((b) => `${b.sha}\n`).join('')));
  if (r.status !== 0) throw new LookError(`git cat-file salió con ${r.status}`);
  const out = new Map();
  let at = 0;
  for (const b of blobs) {
    const nl = r.stdout.indexOf(0x0a, at);
    const head = r.stdout.slice(at, nl).toString('utf8').split(' ');
    if (head[1] !== 'blob') throw new LookError(`${b.file}: git cat-file no lo devolvió como archivo (${head.join(' ')})`);
    const size = Number(head[2]);
    out.set(b.file, r.stdout.slice(nl + 1, nl + 1 + size).toString('utf8'));
    at = nl + 1 + size + 1;
  }
  return out;
}

/**
 * El control sobre el índice de `repo`: `{ ok, problems, perFile, mentions, notes }`. `perFile` es cuántas líneas con
 * señales tiene cada archivo del núcleo; `mentions`, cada una. Tira LookError si no puede mirar.
 */
function check({ repo: dir, skipThin = false }) {
  // desde una subcarpeta, git lista las rutas relativas a ella: se mide siempre el repo entero
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new LookError(`${dir} no es un repo git (${(top.stderr || '').trim().slice(0, 200)})`);
  const repo = top.stdout.trim();
  if (skipThin && thinLayout(repo)) return { ok: true, skipped: true, problems: [], perFile: {}, mentions: [], notes: ['el repo de mantenimiento adelgazado no se publica: lo mira el control del repo público'] };
  // un árbol sin la lista y sin ningún manifiesto de conector no es el arnés (un repo de juguete con su pre-commit): no
  // tiene nada que contar. Con cualquiera de los dos, la lista y el piso de señales valen
  if (!manifestsOf(repo).length && indexed(repo, RULES) === null) return { ok: true, problems: [], perFile: {}, mentions: [], notes: ['el árbol no trae la lista ni integraciones: nada que contar'] };
  const { entries, signalsAtLeast } = readRules(repo);
  const signals = signalsOf(repo);
  if (signals.length < signalsAtLeast) throw new LookError(`los conectores declaran ${signals.length} patrón(es) en «hardSignals» y la lista espera al menos ${signalsAtLeast} (signals_at_least de ${RULES}): ¿se borró un conector o perdió sus señales?`);
  const ls = git(repo, ['ls-files', '-z']);
  if (ls.status !== 0) throw new LookError(`git ls-files salió con ${ls.status}`);
  const all = ls.stdout.split('\0').filter((f) => f && core(f));
  const files = travelling(repo, all);
  // en el árbol armado de los nocturnos, lo que tiene su versión privada no viaja: su entrada la mide el repo público
  const kept = new Set(files);
  const notTravelling = new Set(all.filter((f) => !kept.has(f)));
  const texts = contents(repo, files);
  const perFile = {};
  const mentions = [];
  for (const [file, text] of texts) {
    text.split('\n').forEach((line, i) => {
      if (!signals.some((s) => s.re.test(line))) return;
      perFile[file] = (perFile[file] || 0) + 1;
      mentions.push({ file, line: i + 1 });
    });
  }
  const problems = [];
  const notes = [];
  const listed = new Map();
  for (const e of entries) {
    const p = e && typeof e.path === 'string' ? e.path : null;
    if (!p) { problems.push(`${RULES}: una entrada sin «path»`); continue; }
    if (/[*?[\]{}]/.test(p)) { problems.push(`${RULES}: «${p}» lleva comodines: va el archivo exacto (un comodín abre archivos que nadie miró)`); continue; }
    if (p.endsWith('/')) { problems.push(`${RULES}: «${p}» es una carpeta: va el archivo exacto`); continue; }
    if (listed.has(p)) { problems.push(`${RULES}: «${p}» está dos veces`); continue; }
    if (!(typeof e.reason === 'string' && e.reason.trim())) problems.push(`${RULES}: ${p} está sin motivo: cada entrada dice por qué ese archivo del núcleo nombra una plataforma`);
    if (!Number.isInteger(e.ceiling) || e.ceiling < 1) { problems.push(`${RULES}: el techo de ${p} es un entero ≥ 1`); continue; }
    listed.set(p, e.ceiling);
    const n = perFile[p] || 0;
    if (!n && notTravelling.has(p)) continue;
    if (!n) problems.push(`${RULES}: la entrada de ${p} ya no hace falta (el archivo no tiene señales, o no está en el núcleo): sacala`);
    else if (n < e.ceiling) notes.push(`${p}: tiene ${n} línea(s) con señales y su techo es ${e.ceiling}: bajalo en ${RULES}`);
  }
  for (const [file, n] of Object.entries(perFile)) {
    const top = listed.has(file) ? listed.get(file) : 0;
    if (n <= top) continue;
    const where = mentions.filter((m) => m.file === file).map((m) => `${file}:${m.line}`).join(', ');
    problems.push(listed.has(file)
      ? `${file}: ${n} línea(s) con un comando o una dirección de plataforma y su techo es ${top}. Dónde: ${where}`
      : `${file}: nombra un comando o una dirección de plataforma y no está en la lista (regla: el núcleo dice qué se hace; cómo, el conector en integrations/). Dónde: ${where}`);
  }
  return { ok: problems.length === 0, problems, perFile, mentions, notes };
}

function main(argv) {
  const repoAt = argv.indexOf('--repo');
  const repo = path.resolve(repoAt >= 0 && argv[repoAt + 1] ? argv[repoAt + 1] : '.');
  let r;
  try { r = check({ repo, skipThin: argv.includes('--skip-thin') }); } catch (e) {
    if (!(e instanceof LookError)) throw e;
    process.stderr.write(`⛔ core-neutrality: no pude mirar — ${e.message}\n`);
    return 2;
  }
  if (argv.includes('--measure')) { process.stdout.write(`${JSON.stringify(r.perFile, null, 2)}\n`); return 0; }
  if (argv.includes('--json')) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return r.ok ? 0 : 1; }
  if (r.skipped) { process.stdout.write(`⏭ core-neutrality: SALTEADO — ${r.notes.join(' · ')}\n`); return 0; }
  for (const n of r.notes) process.stdout.write(`ℹ core-neutrality: ${n}\n`);
  if (r.ok) {
    const total = Object.values(r.perFile).reduce((a, b) => a + b, 0);
    process.stdout.write(`✅ core-neutrality: ${total} línea(s) con señales de plataforma en ${Object.keys(r.perFile).length} archivo(s) del núcleo, todas dentro de la lista\n`);
    return 0;
  }
  for (const p of r.problems) process.stderr.write(`🛑 core-neutrality: ${p}\n`);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { check, core, signalsOf, main, RULES };
