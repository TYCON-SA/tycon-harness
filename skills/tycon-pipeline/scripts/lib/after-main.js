#!/usr/bin/env node
'use strict';
/**
 * after-main.js — ¿lo único que cambió desde la última corrida del portón es lo que trajo main?
 *
 * Una corrida acotada puede tardar casi una hora, y traer main no la vuelve inútil: si lo que había se mezcla con main y da
 * exactamente lo que hay ahora, lo único por medir es lo que main cambió. Entonces corren las suites que fallaron la vez
 * anterior y las que nombran archivos que trajo main; la suite completa la sigue corriendo la CI del pedido. Quien llama
 * pregunta sólo si el portón ya está acotado por esa CI: un repo que no tiene quién corra la completa corre todo.
 *
 * Se compara el árbol de la carpeta, no los commits: lo medido puede no estar commiteado, o estar sólo preparado. Cualquier
 * otra diferencia, por chica que sea (un conflicto arreglado a mano, un retoque, un `.json`), corre lo de siempre. El papeleo
 * que no vence el ok de guardar (save-ok.js, `esPapeleoDeLaHuella`) no apaga el acotado, pero entra en lo tocado: corren las
 * suites que lo nombran. Lo que no se pudo comparar corre lo de siempre, y lo mismo un submódulo con cambios adentro o una
 * suite que vive fuera del repo: el árbol no los ve.
 *
 * Lo que NO ve, y queda para la CI del pedido: un archivo ignorado que lee una suite, el destino de un enlace fuera del
 * repo y un cambio de modo con `core.fileMode=false`. Tampoco consulta la red: que main esté en verde, y que `origin/main`
 * no se haya movido a mano, lo garantiza la cola de merge.
 *
 * Uso:
 *   node after-main.js snapshot <repo>                                  → imprime { head, tree } de la carpeta
 *   node after-main.js record <repo> <snapshot> <resumen> <exit> <salida> → anota lo medido si la corrida midió todo lo
 *        suyo y la carpeta no cambió mientras corría; si no, no deja nada
 *   node after-main.js decide <repo> <medido> <snapshot> <salida>       → sale 0 y escribe lo tocado (la forma de
 *        touched-files.js) si sólo cambió main; sale 10 y dice por qué, si no
 *
 * Casos: skills/tycon-pipeline/scripts/tests/test-gate-after-main.test.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { esPapeleoDeLaHuella } = require('./save-ok.js');

const BASE = 'origin/main';
const NO_APLICA = 10;
const IDENTIDAD = { GIT_AUTHOR_NAME: 'portón', GIT_AUTHOR_EMAIL: 'gate@localhost', GIT_COMMITTER_NAME: 'portón', GIT_COMMITTER_EMAIL: 'gate@localhost' };

function git(repo, args, env) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, out: String(r.stdout || '').trim(), crudo: String(r.stdout || ''), err: String(r.stderr || '').trim() };
}

/** El árbol de todo lo del disco, en un índice aparte desde HEAD: el índice de la persona no se toca. Tira si no se pudo. */
function arbolDeLaCarpeta(repo) {
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir.ok) throw new Error(gitDir.err || 'no es un repo de git');
  const indice = path.join(gitDir.out, `after-main-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: indice };
  try {
    for (const args of [['read-tree', 'HEAD'], ['add', '-A'], ['write-tree']]) {
      const r = git(repo, args, env);
      if (!r.ok) throw new Error(`git ${args[0]}: ${r.err}`);
      if (args[0] === 'write-tree') return r.out;
    }
    return null;
  } finally {
    try { fs.unlinkSync(indice); } catch (_) { /* no llegó a existir */ }
  }
}

function foto(repo) {
  const head = git(repo, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) throw new Error(head.err || 'el repo no tiene HEAD');
  return { head: head.out, tree: arbolDeLaCarpeta(repo) };
}

const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
/** La ruta de una suite relativa al repo, con la ruta real de las dos puntas: la carpeta se puede nombrar de otra forma. */
const relativaAlRepo = (repo, ruta) => path.relative(real(repo), real(ruta)).split(path.sep).join('/');

/**
 * Lo que queda anotado de una corrida, o `{ no }`: una corrida que no midió todo lo suyo (sin medir, una suite ausente, una
 * salida que no es verde ni rojo), durante la que la carpeta cambió o con suites fuera del repo no dice qué midió. Lo que
 * falló incluye lo heredado del nocturno: esa foto puede cambiar con lo que trae main.
 */
function medido({ repo, inicio, resumen, exit }) {
  if (exit !== 0 && exit !== 1) return { no: `la corrida salió ${exit}` };
  if (!resumen || resumen.no_medido) return { no: 'la corrida no midió' };
  const pendientes = ['ausentes', 'unmeasured_suites'].find((k) => !Array.isArray(resumen[k]) || resumen[k].length);
  if (pendientes) return { no: `el resumen trae ${pendientes}` };
  const fallas = Array.isArray(resumen.fallas) ? resumen.fallas : [];
  if (exit === 1 && !fallas.length) return { no: 'salió en rojo sin una suite con nombre' };
  const heredadas = (resumen.inherited && Array.isArray(resumen.inherited.suites)) ? resumen.inherited.suites : [];
  const todas = [...fallas, ...heredadas, ...(resumen.suites || []), ...(resumen.deferred_suites || []).map((d) => ({ ruta: d && d.suite }))];
  if (todas.some((s) => s && s.ruta && relativaAlRepo(repo, s.ruta).startsWith('../'))) return { no: 'hay suites fuera del repo' };
  if (arbolDeLaCarpeta(repo) !== inicio.tree) return { no: 'la carpeta cambió mientras corría' };
  return { head: inicio.head, tree: inicio.tree, failed: [...new Set([...fallas, ...heredadas].map((f) => f && f.ruta).filter(Boolean).map((r) => relativaAlRepo(repo, r)))] };
}

/** ¿Algún submódulo tiene cambios adentro? El árbol sólo ve su commit. Tira si no se pudo mirar. */
function submoduloSucio(repo) {
  const r = git(repo, ['status', '--porcelain=v2', '--ignore-submodules=none']);
  if (!r.ok) throw new Error(`git status: ${r.err}`);
  return r.out.split('\n').some((l) => { const c = l.split(' '); return (c[0] === '1' || c[0] === '2') && /^S(?!\.\.\.$)/.test(c[2] || ''); });
}

/** Las diferencias entre dos árboles: `[{ rel, modo }]`, sin renombres (origen y destino cuentan). */
function diferencias(repo, a, b) {
  const r = git(repo, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', a, b]);
  if (!r.ok) throw new Error(`git diff-tree: ${r.err}`);
  const partes = r.crudo.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < partes.length; i += 2) out.push({ rel: partes[i + 1], modo: partes[i].split(' ')[1] });
  return out;
}

/** `{ files, base }` si lo único que cambió es lo que trajo main, o `{ no }` con el motivo. */
function decidir({ repo, anotado, ahora }) {
  const no = (m) => ({ no: m });
  if (!anotado || !anotado.head || !anotado.tree || !Array.isArray(anotado.failed)) return no('la corrida anterior no dejó qué midió');
  if (ahora === anotado.tree) return no('no cambió nada desde la corrida anterior');
  if (submoduloSucio(repo)) return no('un submódulo tiene cambios adentro, y el árbol no los ve');
  const main = git(repo, ['merge-base', BASE, 'HEAD']);
  if (!main.ok || !main.out) return no(`no pude ubicar ${BASE} en esta rama (${main.err || 'sin salida'})`);
  if (git(repo, ['merge-base', '--is-ancestor', main.out, anotado.head]).status !== 1) return no('esta rama no trajo nada nuevo de main');
  const previo = git(repo, ['commit-tree', anotado.tree, '-p', anotado.head, '-m', 'lo medido'], IDENTIDAD);
  if (!previo.ok) return no(`no pude rearmar lo medido (${previo.err})`);
  const mezcla = git(repo, ['merge-tree', '--write-tree', previo.out, main.out], IDENTIDAD);
  if (!mezcla.ok) return no(mezcla.status === 1 ? 'lo medido choca con main' : `no pude mezclar con main (${mezcla.err})`);
  const esperado = mezcla.out.split('\n')[0];
  const otras = diferencias(repo, esperado, ahora);
  if (otras.some((d) => !esPapeleoDeLaHuella(d.rel, d.modo))) return no('hay otro cambio además de lo que trajo main');
  const deMain = diferencias(repo, anotado.tree, esperado).map((d) => d.rel);
  if (!deMain.length) return no('main no cambió nada de lo medido');
  // el papeleo no apaga el acotado, pero una suite que lo nombra corre: si no, un cambio ahí quedaría anotado como medido
  return { files: [...new Set([...deMain, ...otras.map((d) => d.rel), ...anotado.failed])], deMain: deMain.length, fallaron: anotado.failed.length };
}

const leer = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function main(argv) {
  const [cmd, repo, ...resto] = argv;
  const uso = 'uso: after-main.js snapshot <repo> · record <repo> <snapshot> <resumen> <exit> <salida> · decide <repo> <medido> <snapshot> <salida>';
  if (!repo) { console.error(uso); return 2; }
  if (cmd === 'snapshot') { process.stdout.write(`${JSON.stringify(foto(repo))}\n`); return 0; }
  if (cmd === 'record') {
    const [inicioF, resumenF, exit, salida] = resto;
    const m = medido({ repo, inicio: leer(inicioF), resumen: leer(resumenF), exit: Number(exit) });
    if (m.no) { console.error(`[test-gate] no anoto lo medido: ${m.no}: si después se trae main, corre lo de siempre`); return 0; }
    fs.writeFileSync(salida, `${JSON.stringify(m)}\n`);
    return 0;
  }
  if (cmd === 'decide') {
    const [medidoF, inicioF, salida] = resto;
    let anotado = null;
    try { anotado = leer(medidoF); } catch (e) { if (e.code !== 'ENOENT') console.error(`[test-gate] no pude leer lo medido (${e.message})`); }
    const d = decidir({ repo, anotado, ahora: leer(inicioF).tree });
    if (d.no) { console.error(`[test-gate] corre lo de siempre: ${d.no}`); return NO_APLICA; }
    fs.writeFileSync(salida, `${JSON.stringify({ known: true, files: d.files, sources: { after_main: d.files }, reason: null })}\n`);
    console.log(`[test-gate] lo único que cambió es lo que trajo main (${d.deMain} archivo(s)): corren las ${d.fallaron} suite(s) que fallaron y las que nombran esos archivos`);
    return 0;
  }
  console.error(uso);
  return 2;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    // no poder comparar nunca acota
    console.error(`[test-gate] corre lo de siempre: no pude comparar con la corrida anterior (${e.message})`);
    process.exitCode = process.argv[2] === 'decide' ? NO_APLICA : 1;
  }
}

module.exports = { foto, medido, decidir, NO_APLICA };
