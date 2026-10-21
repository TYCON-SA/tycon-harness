#!/usr/bin/env node
'use strict';
/**
 * ¿Este cambio toca sólo comentarios? Compara cada archivo tocado sin sus comentarios, con el mismo lector de la zona
 * `comment` del freno de historia interna (`codeOf` de internal-history.js), y sale 0 sólo si todos dan igual.
 *
 * Uso:   node scripts/publishing/comment-only-diff.js --range <base>...<punta> [--json] [--repo <dir>]
 *        node scripts/publishing/comment-only-diff.js --against <ref> [--json] [--repo <dir>]   (contra el árbol de trabajo)
 * Con `...` la base es el punto donde se separaron las dos ramas, como en `git diff`.
 * Salida: 0 sólo comentarios · 1 algún archivo cambia código (o se agrega, se borra o no es código) · 2 no se pudo mirar
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { codeOf } = require('./internal-history.js');

function parseArgs(argv) {
  const args = { json: false, repo: process.cwd(), range: null, against: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--range' || a === '--against' || a === '--repo') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} pide un valor`);
      args[a.slice(2)] = v;
    } else throw new Error(`argumento desconocido: ${a}`);
  }
  if (!args.range === !args.against) throw new Error('hace falta --range <base>...<punta> o --against <ref>, uno de los dos');
  return args;
}

const git = (repo, list) => execFileSync('git', ['-C', repo, ...list], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** El contenido de un archivo en un commit, o en el árbol de trabajo cuando `ref` es `null`. */
function contentAt(repo, ref, file) {
  if (ref === null) return fs.readFileSync(path.join(repo, file), 'utf8');
  return git(repo, ['show', `${ref}:${file}`]);
}

/** La primera línea (contada en el código sin comentarios) donde dos versiones difieren. */
function firstDifference(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return i + 1;
  return 0;
}

/**
 * Los archivos que se copian al freno de producción (`ARCHIVOS` de scripts/production/install-guard.sh, leído en la
 * base). El aviso de arranque compara cada copia instalada entera contra `main`: cambiarles un comentario pide reinstalar
 * el freno con permiso de administrador en cada máquina, así que un cambio de sólo comentarios no los toca. Sin el
 * instalador en la base (un repo sin freno), ninguno.
 */
function guardCopies(repo, base) {
  const installer = 'scripts/production/install-guard.sh';
  // sólo «no está en la base» es «repo sin freno»; cualquier otra falla de git sale como «no pude mirar»
  if (spawnSync('git', ['-C', repo, 'cat-file', '-e', `${base}:${installer}`]).status !== 0) return new Set();
  const src = contentAt(repo, base, installer).replace(/\r/g, '');
  const m = /^ARCHIVOS=\(\n([\s\S]*?)\n\)/m.exec(src);
  if (!m) throw new Error(`${installer} no trae la lista ARCHIVOS: no sé qué se copia al freno`);
  const entries = m[1].split('\n').map((l) => l.replace(/\s#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2')).filter((l) => l && !l.startsWith('#'));
  // una entrada que no parece una ruta no coincidiría con ningún archivo del diff y el freno quedaría sin cuidar, callado
  const odd = entries.find((e) => !/^[\w.@+/-]+$/.test(e));
  if (odd) throw new Error(`${installer}: una entrada de ARCHIVOS no parece una ruta («${odd}»)`);
  return new Set(entries);
}

function compare(args) {
  let base;
  let tip;
  if (args.range) {
    const m = /^(.+?)(\.\.\.?)(.+)$/.exec(args.range);
    if (!m) throw new Error(`rango inválido: ${args.range} (se espera <base>...<punta>)`);
    tip = git(args.repo, ['rev-parse', '--verify', `${m[3]}^{commit}`]).trim();
    base = m[2] === '...'
      ? git(args.repo, ['merge-base', m[1], tip]).trim()
      : git(args.repo, ['rev-parse', '--verify', `${m[1]}^{commit}`]).trim();
  } else {
    base = git(args.repo, ['rev-parse', '--verify', `${args.against}^{commit}`]).trim();
    tip = null;
  }
  const diffArgs = ['diff', '--name-status', '-z', '--no-renames', base];
  if (tip) diffArgs.push(tip);
  const parts = git(args.repo, diffArgs).split('\0').filter(Boolean);
  const guard = guardCopies(args.repo, base);
  const files = [];
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i][0];
    const file = parts[i + 1];
    if (guard.has(file)) { files.push({ file, result: 'differs', reason: 'se copia al freno de producción: cambiarlo, aunque sea un comentario, pide reinstalar el freno en cada máquina' }); continue; }
    if (status !== 'M') { files.push({ file, result: 'differs', reason: status === 'A' ? 'archivo nuevo' : status === 'D' ? 'archivo borrado' : `cambio ${status}` }); continue; }
    const before = codeOf(contentAt(args.repo, base, file), file);
    const after = codeOf(contentAt(args.repo, tip, file), file);
    if (before === null || after === null) { files.push({ file, result: 'differs', reason: 'no es código que este lector sepa leer: no se puede comparar sin comentarios' }); continue; }
    if (before === after) files.push({ file, result: 'same' });
    else files.push({ file, result: 'differs', reason: `el código cambia (línea ${firstDifference(before, after)} del código sin comentarios)` });
  }
  return { base, tip: tip || 'árbol de trabajo', files };
}

function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { process.stderr.write(`comment-only-diff: ${e.message}\n`); return 2; }
  let r;
  try { r = compare(args); } catch (e) {
    process.stderr.write(`⛔ comment-only-diff: no pude mirar — ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
  const differs = r.files.filter((f) => f.result === 'differs');
  if (args.json) process.stdout.write(`${JSON.stringify({ ...r, differs: differs.length }, null, 2)}\n`);
  else if (!r.files.length) process.stdout.write('comment-only-diff: el rango no toca archivos\n');
  else if (!differs.length) process.stdout.write(`✅ comment-only-diff: ${r.files.length} archivo(s), sólo comentarios\n`);
  else {
    process.stdout.write(`⛔ comment-only-diff: ${differs.length} de ${r.files.length} archivo(s) cambian algo más que comentarios:\n`);
    for (const f of differs) process.stdout.write(`   · ${f.file}: ${f.reason}\n`);
  }
  return differs.length ? 1 : 0;
}

module.exports = { compare, parseArgs };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
