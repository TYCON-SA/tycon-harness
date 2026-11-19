#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * scripts/tools/catch-up-main.js — pone al día con main una rama que choca sólo en los índices de historias y en las
 * firmas.
 *
 * POR QUÉ EXISTE. Dos historias en paralelo suman cada una su renglón en `specs/epics.md` y `specs/sprint-status.yaml`,
 * y su firma en `.tycon/runtime-waivers.jsonl`. La que entra segunda choca en esos tres archivos aunque los dos lados
 * sólo sumaron renglones, y el servidor de pedidos no aplica la unión de `.gitattributes`. Este guion hace a mano esa
 * unión y nada más.
 *
 * QUÉ HACE. `node scripts/tools/catch-up-main.js --repo <dir> [--push]`
 *   1. Trae `origin/main` y lo mezcla en la rama actual sin commitear.
 *   2. Si choca sólo en esos tres archivos, junta los dos lados de cada uno con `git merge-file --union` sobre sus tres
 *      versiones (base, rama, main). En los índices, cada historia queda con lo que le hizo cada lado: la que cambió
 *      un solo lado queda con ese cambio, una vez; si los dos cambiaron su renglón, cada uno a su manera, queda el de
 *      la rama. En las firmas, cada línea una vez, en orden de hora, y ninguna firma
 *      que era válida en un lado queda descartada por la cadena. Si los índices de main son generados (traen la
 *      cabecera de `scripts/tools/story-index.js`), no se unen: se regeneran desde el frontmatter ya mezclado.
 *   3. Commitea el merge con un commit normal, con todos los controles, y con `--push` lo empuja sin forzar.
 *
 * CÓDIGOS DE SALIDA. 0 hecho, o la rama ya estaba al día · 1 un choque que no resuelve (otro archivo, un lado borró uno
 * de los tres, una firma que se perdería): deshace el merge · 2 hay cambios sin commitear o un merge en curso: no
 * empieza · 3 el remoto rechazó el empuje · 4 un control rechazó el commit: deshace el merge · 5 git falló sin dejar
 * choques (sin red, sin `origin/main`, historias sin relación): deshace lo que haya empezado.
 *
 * Nunca fuerza un empuje ni saltea un control. Todo git va con el idioma fijo: el guion lee sus errores.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const { idiomaFijo, sinGitDelPadre } = require(path.join(RAIZ, 'scripts', 'lib', 'clean-git-env.js'));
const waivers = () => require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'runtime-waiver.js'));

const EPICS = 'specs/epics.md';
const SPRINT = 'specs/sprint-status.yaml';
const FIRMAS = '.tycon/runtime-waivers.jsonl';
const LOS_TRES = [EPICS, SPRINT, FIRMAS];

const AYUDA = `Uso: node scripts/tools/catch-up-main.js --repo <dir> [--push]

Trae origin/main a la rama actual. Si el merge choca sólo en ${LOS_TRES.join(', ')},
junta los dos lados y commitea el merge con los controles de siempre. Con --push empuja la rama sin forzar.

Salidas: 0 hecho o al día · 1 choque que no resuelve · 2 cambios sin commitear · 3 empuje rechazado ·
4 un control rechazó el commit · 5 git falló sin choques.`;

class Salida extends Error {
  constructor(code, mensaje) { super(mensaje); this.code = code; }
}

function crearGit(repo) {
  const env = idiomaFijo(sinGitDelPadre());
  return (args, opts = {}) => {
    const r = spawnSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, ...opts });
    return { code: r.status === null ? -1 : r.status, out: r.stdout || '', err: (r.stderr || '') + (r.error ? String(r.error.message) : '') };
  };
}

// La clave de historia de un renglón: el id de la tabla de `epics.md` (`| 8.206 |`) o la de `sprint-status.yaml`
// (`8-206-algo:`). Un renglón sin clave no se toca.
function claveDe(renglon) {
  const m = renglon.match(/^\|\s*(\d+\.\d+(?:\.\d+)?)\s*\|/) || renglon.match(/^\s*(\d+-\d+(?:-\d+)?-[\w.-]+):/);
  return m ? m[1] : null;
}

function porClave(texto) {
  const m = new Map();
  for (const r of texto.split('\n')) {
    const k = claveDe(r);
    if (k) m.set(k, [...(m.get(k) || []), r]);
  }
  return m;
}

const contar = (rs) => {
  const c = new Map();
  for (const r of rs || []) c.set(r, (c.get(r) || 0) + 1);
  return c;
};

/**
 * Los renglones que le tocan a una historia después del merge, juntando lo que hizo cada lado sobre la base: un renglón
 * que un lado sacó o cambió no vuelve aunque el otro lado lo traiga sin tocar, y uno que los dos sumaron igual queda una
 * vez. Si los dos lados cambiaron el único renglón de la historia, cada uno a su manera, queda el de la rama.
 */
function renglonesDe(b, r, m) {
  if ((r || []).length === 1 && (m || []).length === 1 && (b || []).length <= 1 && r[0] !== m[0] && r[0] !== (b || [])[0] && m[0] !== (b || [])[0]) {
    return contar([r[0]]);
  }
  const cb = contar(b);
  const cr = contar(r);
  const cm = contar(m);
  const quedan = new Map();
  for (const l of new Set([...cb.keys(), ...cr.keys(), ...cm.keys()])) {
    const nb = cb.get(l) || 0;
    const dr = (cr.get(l) || 0) - nb;
    const dm = (cm.get(l) || 0) - nb;
    const d = dr > 0 && dm > 0 ? Math.max(dr, dm) : dr < 0 && dm < 0 ? Math.min(dr, dm) : dr + dm;
    if (nb + d > 0) quedan.set(l, nb + d);
  }
  return quedan;
}

/**
 * Deja en cada historia los renglones que le tocan juntando los dos lados (renglonesDe), en el lugar donde los puso la
 * unión: la unión de git repite los dos lados de un choque, y con eso una historia que la rama no tocó quedaba dos
 * veces, con su renglón viejo primero. Lo que no es renglón de historia queda como lo dejó la unión.
 */
function unRenglonPorHistoria(unido, base, rama, main) {
  const enBase = porClave(base);
  const enRama = porClave(rama);
  const enMain = porClave(main);
  const quedan = new Map();
  for (const k of new Set([...enBase.keys(), ...enRama.keys(), ...enMain.keys()])) {
    quedan.set(k, renglonesDe(enBase.get(k), enRama.get(k), enMain.get(k)));
  }
  const salida = [];
  for (const r of unido.split('\n')) {
    const k = claveDe(r);
    if (k) {
      const q = quedan.get(k);
      const n = (q && q.get(r)) || 0;
      if (!n) continue;
      q.set(r, n - 1);
    }
    salida.push(r);
  }
  const faltan = [...quedan.values()].flatMap((q) => [...q].filter(([, n]) => n > 0).map(([l]) => l));
  if (faltan.length) throw new Salida(1, `la unión no dejó lugar para ${faltan.length} renglón(es) de historia: ${faltan[0].slice(0, 80)}`);
  return salida.join('\n');
}

/** Las firmas de los dos lados, cada línea una vez y en orden de hora; frena si la cadena descartaría una válida. */
function unirFirmas(unido, rama, main, tmp) {
  const lineas = [...new Set(unido.split('\n').filter((l) => l.trim()))];
  const conHora = lineas.map((l) => {
    let ts;
    try { ts = JSON.parse(l).ts; } catch { /* abajo */ }
    if (typeof ts !== 'string') throw new Salida(1, `${FIRMAS}: una línea no es una firma con hora (ts): ${l.slice(0, 80)}`);
    return { l, ts };
  });
  conHora.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const texto = conHora.map((x) => x.l).join('\n') + '\n';
  const validas = (contenido, nombre) => {
    const f = path.join(tmp, nombre);
    fs.writeFileSync(f, contenido);
    return new Set(waivers().verifyChain(f).entries.map((e) => e.chain));
  };
  const antes = new Set([...validas(rama, 'rama.jsonl'), ...validas(main, 'main.jsonl')]);
  const despues = validas(texto, 'unido.jsonl');
  const perdidas = [...antes].filter((c) => !despues.has(c));
  if (perdidas.length) throw new Salida(1, `${FIRMAS}: la unión dejaría ${perdidas.length} firma(s) válida(s) fuera de la cadena`);
  return texto;
}

function resolver(git, repo, archivo, tmp) {
  const etapas = new Map();
  for (const reg of git(['ls-files', '-u', '-z', '--', archivo]).out.split('\0').filter(Boolean)) {
    const [modo, objeto, etapa] = reg.slice(0, reg.indexOf('\t')).split(' ');
    etapas.set(etapa, { modo, objeto });
  }
  if (!etapas.has('2') || !etapas.has('3')) throw new Salida(1, `${archivo}: un lado lo borró y el otro lo cambió; la unión no lo resuelve`);
  const leer = (etapa) => {
    if (!etapas.has(etapa)) return '';
    const r = git(['cat-file', 'blob', etapas.get(etapa).objeto]);
    if (r.code !== 0) throw new Salida(5, `no pude leer la versión ${etapa} de ${archivo}: ${r.err.trim()}`);
    return r.out;
  };
  const base = leer('1');
  const rama = leer('2');
  const main = leer('3');
  const f = (n, c) => { const p = path.join(tmp, n); fs.writeFileSync(p, c); return p; };
  const m = git(['merge-file', '--union', '-p', f('rama', rama), f('base', base), f('main', main)]);
  if (m.code < 0 || m.code > 127) throw new Salida(5, `git merge-file falló con ${archivo}: ${m.err.trim()}`);
  const unido = archivo === FIRMAS ? unirFirmas(m.out, rama, main, tmp) : unRenglonPorHistoria(m.out, base, rama, main);
  fs.writeFileSync(path.join(repo, archivo), unido);
  const a = git(['add', '--', archivo]);
  if (a.code !== 0) throw new Salida(5, `git add ${archivo} falló: ${a.err.trim()}`);
}

// la marca que escribe scripts/tools/story-index.js en los dos índices: el índice de ese repo se genera desde el frontmatter
const GENERADO = /Generado por scripts\/tools\/story-index\.js/;

/**
 * ¿Los índices de origin/main son generados? true si alguno de los dos trae la marca, false si ninguno (o no están),
 * null si uno está y no se pudo leer, o si git falló al preguntar si está: eso no es «escrito a mano». Con null, el
 * motivo queda en `salida.motivo`.
 */
function esGenerado(git, salida = {}) {
  let alguno = false;
  for (const f of [SPRINT, EPICS]) {
    // `cat-file -e` sale 128 tanto si la ruta no está como si git falla; `ls-tree` sale 0 y vacío cuando no está
    const est = git(['ls-tree', '--name-only', 'origin/main', '--', f]);
    if (est.code !== 0) { salida.motivo = `git ls-tree origin/main -- ${f}: ${String(est.err || '').trim() || `salió ${est.code}`}`; return null; }
    if (!est.out.trim()) continue;
    const r = git(['show', `origin/main:${f}`]);
    if (r.code !== 0) { salida.motivo = `git show origin/main:${f}: ${String(r.err || '').trim() || `salió ${r.code}`}`; return null; }
    if (GENERADO.test(r.out.split('\n').slice(0, 5).join('\n'))) alguno = true;
  }
  return alguno;
}

/**
 * Regenera los dos índices desde las historias del árbol mezclado —lo preparado para el commit del merge, no el disco:
 * un borrador sin seguir no entra— y los agrega al merge.
 */
function regenerar(git, repo) {
  const index = require(path.join(RAIZ, 'scripts', 'tools', 'story-index.js'));
  const b = index.buildFromIndex(repo);
  if (b.problems.length) throw new Salida(1, `los índices se generan desde el frontmatter y no pude regenerarlos: ${b.problems.join('; ')}`);
  index.writeFiles(repo, b.files);
  const a = git(['add', '--', EPICS, SPRINT]);
  if (a.code !== 0) throw new Salida(5, `git add de los índices falló: ${a.err.trim()}`);
}

function ponerAlDia({ repo, push }, log) {
  const git = crearGit(repo);
  const raiz = git(['rev-parse', '--show-toplevel']);
  if (raiz.code !== 0) throw new Salida(5, `${repo} no es un repo de git: ${raiz.err.trim()}`);
  const enCurso = () => git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code === 0;
  if (enCurso()) throw new Salida(2, 'ya hay un merge en curso: terminalo o deshacelo (git merge --abort) antes');
  const sucio = git(['status', '--porcelain', '--untracked-files=no']);
  if (sucio.code !== 0) throw new Salida(5, `git status falló: ${sucio.err.trim()}`);
  if (sucio.out.trim()) throw new Salida(2, `hay cambios sin commitear; commitealos o guardalos antes:\n${sucio.out.trimEnd()}`);
  const rama = git(['symbolic-ref', '-q', '--short', 'HEAD']);
  if (rama.code !== 0) throw new Salida(5, 'HEAD no está en una rama: no hay qué poner al día');
  const nombre = rama.out.trim();

  const fetch = git(['fetch', 'origin']);
  if (fetch.code !== 0) throw new Salida(5, `git fetch origin falló:\n${fetch.err.trim()}`);
  if (git(['rev-parse', '-q', '--verify', 'origin/main^{commit}']).code !== 0) throw new Salida(5, 'no existe origin/main');
  if (git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD']).code === 0) {
    log(`${nombre} ya está al día con origin/main: no hice nada.`);
    return 0;
  }

  // Deshace el merge y dice cómo quedó la rama: si el aborto falla, eso se dice, nunca «quedó como estaba».
  const deshacer = () => {
    if (!enCurso()) return 'Dejé la rama como estaba.';
    const a = git(['merge', '--abort']);
    if (a.code === 0) return 'Dejé la rama como estaba.';
    return `⚠ NO pude deshacer el merge (git merge --abort salió ${a.code}: ${a.err.trim()}): la rama quedó con el merge a medias; deshacelo a mano.`;
  };
  const merge = git(['merge', '--no-commit', '--no-ff', 'origin/main']);
  let resueltos = [];
  let regenerados = [];
  if (merge.code !== 0) {
    const u = git(['diff', '--name-only', '--diff-filter=U', '-z']);
    if (u.code !== 0) throw new Salida(5, `no pude listar los choques (git diff salió ${u.code}: ${u.err.trim()}). ${deshacer()}`);
    const chocan = u.out.split('\0').filter(Boolean);
    if (chocan.length === 0) {
      throw new Salida(5, `git merge no terminó y no dejó choques:\n${(merge.err || merge.out).trim()}\n${deshacer()}`);
    }
    const otros = chocan.filter((f) => !LOS_TRES.includes(f));
    if (otros.length) {
      throw new Salida(1, `el merge choca en archivos que no resuelvo: ${otros.join(', ')}. ${deshacer()}`);
    }
    // con los índices generados (la cabecera de story-index.js en la versión de main) no se unen: se regeneran desde el
    // frontmatter ya mezclado, que es la única fuente
    const porQue = {};
    const indiceGenerado = esGenerado(git, porQue);
    if (indiceGenerado === null) throw new Salida(5, `no pude leer los índices de origin/main para saber si son generados (${porQue.motivo}). ${deshacer()}`);
    const aRegenerar = indiceGenerado ? chocan.filter((f) => f === EPICS || f === SPRINT) : [];
    let tmp = null;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catch-up-main-'));
      for (const f of chocan.filter((x) => !aRegenerar.includes(x))) resolver(git, repo, f, tmp);
      if (aRegenerar.length) regenerar(git, repo);
    } catch (e) {
      const como = deshacer();
      if (e instanceof Salida) { e.message += `. ${como}`; throw e; }
      throw new Salida(5, `${(e && e.message) || e}. ${como}`);
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
    resueltos = chocan;
    regenerados = aRegenerar;
  }

  const mensaje = [`Merge origin/main en ${nombre}`];
  if (resueltos.length) mensaje.push('', `Choques resueltos juntando los dos lados: ${resueltos.join(', ')}`);
  const commit = git(['commit', '-q', '-m', mensaje.join('\n')]);
  if (commit.code !== 0) {
    throw new Salida(4, `el commit del merge no pasó (lo rechazó un control, o git falló: la salida de abajo dice cuál). ${deshacer()} Dijo:\n${(commit.out + commit.err).trimEnd()}`);
  }
  log(resueltos.length ? `Merge de origin/main commiteado; choques resueltos: ${resueltos.join(', ')}.` : 'Merge de origin/main commiteado, sin choques.');
  if (regenerados.length) log(`Los índices (${regenerados.join(', ')}) se regeneraron desde el frontmatter mezclado: en este repo son generados.`);

  if (!push) {
    log(`Para empujar: git -C ${repo} push origin ${nombre}`);
    return 0;
  }
  const empuje = git(['push', 'origin', nombre]);
  if (empuje.code !== 0) throw new Salida(3, `el empuje no pasó (lo rechazó el remoto o no hubo conexión: la salida de abajo dice cuál). El merge quedó commiteado en la rama local; no reintento ni fuerzo:\n${empuje.err.trim()}`);
  log(`Empujé ${nombre} a origin.`);
  return 0;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(AYUDA); return 0; }
  const i = argv.indexOf('--repo');
  const repo = i >= 0 ? argv[i + 1] : null;
  const desconocidos = argv.filter((a, j) => a.startsWith('--') && !['--repo', '--push'].includes(a) && argv[j - 1] !== '--repo');
  if (!repo || desconocidos.length) {
    console.error(desconocidos.length ? `opción desconocida: ${desconocidos.join(' ')}\n\n${AYUDA}` : AYUDA);
    return 2;
  }
  try {
    return ponerAlDia({ repo: path.resolve(repo), push: argv.includes('--push') }, (m) => console.log(m));
  } catch (e) {
    if (!(e instanceof Salida)) throw e;
    console.error(e.message);
    return e.code;
  }
}

module.exports = { claveDe, unRenglonPorHistoria, ponerAlDia, esGenerado };

if (require.main === module) process.exitCode = main();
