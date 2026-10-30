#!/usr/bin/env node
'use strict';
// rehearsal-index.js — lo que un nocturno habría guardado, para el ensayo sin efectos.
//
// Uso:  node scripts/ci/rehearsal-index.js --out <carpeta> [--repo <checkout>] [--summary <archivo>] -- <ruta>...
//
// POR QUÉ EXISTE. Una corrida con `efectos: false` no guarda nada; sin esto, el ensayo sólo prueba que no se cayó. Las
// rutas son las mismas que el paso de guardar del modelo, y la cuenta es la misma que haría ese paso
// (push-nightly-data.js → readState y stepCommit): desde la misma base —la punta de main que dejó anotada `sync`, o
// HEAD si no corrió—, lo que el nocturno escribió, cambió o borró en esas rutas. Lo que ya estaba y no cambió no cuenta;
// la basura de la máquina tampoco. Lo que el paso de guardar acomoda antes de guardar (la marca de la configuración del
// tablero, por ejemplo) lo acomoda también el paso del ensayo, antes de llamar a esto.
//
// QUÉ DEJA en --out (se publica como el artefacto `ensayo-datos`):
//   · index.json: { generated_at, base, files: [{ path, size }], empty, markers, deleted, untouched, summary }
//     `files` son los escritos y no vacíos; los vacíos van aparte, porque el ensayo los cuenta como falla. Los `.gitkeep`
//     (las carpetas que un modelo crea a propósito la primera noche) van en `markers`, no en `empty`. Los enlaces
//     simbólicos no llegan: stepCommit no los guarda (y lo avisa), así que tampoco se copian. `untouched` son las rutas
//     del guardado donde la noche no dejó nada: una ruta mal escrita se ve ahí aunque las otras tengan datos.
//   · files/<ruta>: una copia de cada uno de `files`.
//   · summary/<nombre>: el resumen de la corrida, si se pasó --summary y existe (si no existe, lo avisa).
//
// Salida: 0 hecho (también sin nada escrito: un índice vacío, con un aviso, porque puede ser una ruta mal escrita) ·
// 1 no pude leer el repo · 2 uso.
// Casos: scripts/tests/operations-pipelines.test.js (RehearsalIndex_*).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readState, stepCommit, cleanPaths, withIdentity, Red, Usage } = require('./push-nightly-data.js');

function parse(argv) {
  const o = { out: null, repo: process.cwd(), summary: null, paths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { o.paths = argv.slice(i + 1); break; }
    if (a === '--out' || a === '--repo' || a === '--summary') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Usage(`${a} necesita un valor`);
      o[a.slice(2)] = v;
      i += 1;
    } else throw new Usage(`no conozco ${a}`);
  }
  if (!o.out) throw new Usage('falta --out <carpeta>');
  if (!o.paths.length) throw new Usage('faltan las rutas del guardado, después de --');
  return o;
}

/** ¿La ruta del guardado `spec` (una carpeta, un archivo o un patrón con `*`) cubre el archivo `rel`? */
function covers(spec, rel) {
  if (!spec.includes('*')) return rel === spec || rel.startsWith(`${spec}/`);
  const re = new RegExp(`^${spec.split('**').map((p) => p.split('*').map((q) => q.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}(/|$)`);
  return re.test(rel);
}

function index(o, say) {
  const repo = path.resolve(o.repo);
  const specs = cleanPaths(o.paths, 'las rutas del ensayo');
  const head = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' });
  if (head.status !== 0) throw new Red(`no pude leer HEAD de ${repo}`);
  const env = withIdentity(repo, process.env);
  const { base } = readState(repo, head.stdout.trim(), env, say);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-'));
  const out = path.resolve(o.out);
  const result = { generated_at: new Date().toISOString(), base, files: [], empty: [], markers: [], deleted: [], summary: null };
  try {
    const commit = stepCommit(repo, base, specs, 'ensayo [no se empuja]', env, tmp, say);
    if (commit) {
      const diff = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', 'diff', '--name-status', '--no-renames', '-z', base, commit], { maxBuffer: 1 << 30 });
      if (diff.status !== 0) throw new Red('no pude listar lo que se habría guardado');
      const fields = diff.stdout.toString('utf8').split('\0').filter(Boolean);
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const [status, rel] = [fields[i], fields[i + 1]];
        if (status === 'D') { result.deleted.push(rel); continue; }
        const st = fs.statSync(path.join(repo, rel));
        if (st.size === 0) { result[path.basename(rel) === '.gitkeep' ? 'markers' : 'empty'].push(rel); continue; }
        result.files.push({ path: rel, size: st.size });
        fs.mkdirSync(path.dirname(path.join(out, 'files', rel)), { recursive: true });
        fs.copyFileSync(path.join(repo, rel), path.join(out, 'files', rel));
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const k of ['files', 'empty', 'markers', 'deleted']) result[k].sort((a, b) => String(a.path || a).localeCompare(String(b.path || b)));
  const touched = [...result.files.map((f) => f.path), ...result.empty, ...result.markers, ...result.deleted];
  result.untouched = specs.filter((s) => !touched.some((p) => covers(s, p)));
  fs.mkdirSync(out, { recursive: true });
  if (o.summary && fs.existsSync(o.summary)) {
    result.summary = path.basename(o.summary);
    fs.mkdirSync(path.join(out, 'summary'), { recursive: true });
    fs.copyFileSync(o.summary, path.join(out, 'summary', result.summary));
  } else if (o.summary) {
    say(`##vso[task.logissue type=warning]ensayo: no está el resumen de la noche (${path.basename(o.summary)}): ¿el paso que lo escribe no llegó a correr?`);
  }
  fs.writeFileSync(path.join(out, 'index.json'), `${JSON.stringify(result, null, 2)}\n`);
  // una ruta sin nada no es un error (hay noches sin hallazgos), pero una ruta mal escrita se ve igual: se nombra
  if (result.untouched.length && result.untouched.length < specs.length) say(`ensayo: sin nada esta noche en ${result.untouched.join(', ')}`);
  if (!result.files.length && !result.empty.length && !result.markers.length && !result.deleted.length) {
    // una noche que no escribió nada y una ruta mal escrita se ven igual: el aviso deja que lo mire una persona
    say(`##vso[task.logissue type=warning]ensayo: nada que se habría guardado en ${specs.join(', ')}: ¿la noche no escribió nada, o una ruta no es la del guardado?`);
  }
  say(`ensayo: ${result.files.length} archivo(s) que se habrían guardado, ${result.empty.length} vacío(s), ${result.markers.length} marca(s) de carpeta, ${result.deleted.length} borrado(s)`);
  return result;
}

function main(argv, { log = (m) => console.log(m) } = {}) {
  try {
    index(parse(argv), log);
    return 0;
  } catch (e) {
    if (e instanceof Usage) { console.error(`rehearsal-index: ${e.message}`); return 2; }
    if (e instanceof Red) { console.error(`rehearsal-index: ${e.message}`); return 1; }
    throw e;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, index };
