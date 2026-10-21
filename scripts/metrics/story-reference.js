#!/usr/bin/env node
/**
 * story-reference.js — cuántos cambios de código llegaron a main sin nombrar su historia. Sólo mide: no frena ni le
 * avisa a nadie. El número va al tablero y al sitio, para que quien mantiene decida si hay que hablar con alguien.
 *
 * El portón (`guides/ci-gate.md`) vigila el CIERRE de una historia, no que el código nombre una: un cambio que no toca
 * ninguna historia pasa sin que nadie lo vea. Esta cuenta dice cuántos son.
 *
 * La regla (Casos: scripts/tests/story-reference.test.js):
 *   - Una entrada a main es cada commit de su línea principal (`--first-parent`) en los 28 días que terminan hoy. Si tiene
 *     dos padres entró por pedido; si no, directo.
 *   - Cuenta si toca algún archivo fuera de lo documental (`.md`, `specs/`, `docs/`, `.advisors/`, `.engram/`, `.tycon/`,
 *     `stories/`, `tasks/`, `.txt`) y no es un aumento de versión automático (`[skip ci]` en el título).
 *   - Nombra una historia si el título de la entrada (que trae el nombre de la rama del merge) o el de algún commit que
 *     trae el merge tiene `story <N.M>` / `historia <N.M>`, una rama `story/<N.M>-…`, `feature/<N.M>-…` o
 *     `fix/<N.M>-…`, el número solo entre paréntesis (`(<N.M>)`) o un código como `<XX>-<N>`. El cuerpo del commit no
 *     cuenta (ahí una historia se cita de pasada), ni un número de versión.
 *   - La persona es el autor más frecuente de los commits que trae el merge (sin los `[skip ci]`), o el del commit
 *     directo. Va su nombre de git con el `.mailmap` del repo leído del objeto (el clon del nocturno es `--no-checkout`),
 *     nunca su correo: para decidir con quién hablar hace falta saber quién es. Al sitio llega sólo el número. (La
 *     concentración por persona, `author-concentration.js`, sigue sin nombres: es otra pregunta.)
 *   - Un clon superficial, un repo sin clon o un error de git: «no medido» con su motivo, nunca 0. Un error de git se
 *     dice con su código de salida, nunca con la salida del comando (trae autores y correos).
 *
 * CLI (el nocturno de métricas, en el paso de la concentración): node story-reference.js --scan <raíz de clones
 *   Proyecto__Repo> --products <repos.json> --out <archivo>   ·   exit 0 escribió · 1 argumentos · 2 no pudo leer o escribir.
 * Módulo: nombra, tipo, clasificar, entradasDe, contarRepo, contar.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readEnv } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));
const { resolverNocturno } = require(path.join(__dirname, 'author-concentration.js'));

const DIAS = 28;
const TIPOS = Object.freeze(['hotfix', 'dependencias', 'arnes_ci', 'merge_dev', 'otro']);

const DOCUMENTAL = /(\.md$|^docs?\/|^\.?specs?\/|^\.advisors\/|^\.engram\/|^\.tycon\/|^stories\/|^tasks\/|\.txt$)/i;
const HISTORIA = [
  /\b(story|historia|stories)[\s\-_/:#]*\d+([.-]\d+)*/i,                           // «story <N.M>», «story/<N-M-K>»
  /\b(feature|feat|fix|story|chore)\/\d+([.-]\d+)+/i,                               // una rama `<tipo>/<N.M>-…`
  /\(\s*\d+\.\d+[a-z]?(?:\s*[+,y]\s*\d+\.\d+[a-z]?)*\s*[,)]/,                        // «(<N.M> + <N.M>)», «(<N.M>, …)»
  // un código `<XX>-<N>`. Los bordes son de Unicode y no `\b`, que en JS sólo ve letras ASCII: «ÉXITO-2» daría «XITO-2»
  /(?<![\p{L}\p{N}_])(?!CVE|UTF|ISO|SHA|TLS|HTTP|API|SQL)[A-Z]{1,4}-\d+(\.\d+)?(?![\p{L}\p{N}_])/u,
];
// el título que deja un pedido cerrado con squash: en la línea principal tiene un solo padre, pero entró por pedido
const SQUASH = /^Merged PR \d+:|\(#\d+\)\s*$/;
const VERSION = /\(\s*v?\d+\.\d+\.\d+/g;   // «(4.1.2)» es una versión, no una historia

const isoDia = (d) => d.toISOString().slice(0, 10);
function hoy(today) { return today || readEnv('TYCON_TODAY', { where: 'scripts/metrics/story-reference.js' }) || isoDia(new Date()); }
function ventana(today) {
  const hasta = hoy(today);
  const d = new Date(`${hasta}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (DIAS - 1));
  return { desde: isoDia(d), hasta, dias: DIAS };
}

/** Si el texto nombra una historia (D3). */
function nombra(texto) {
  const t = String(texto || '').replace(VERSION, '');
  return HISTORIA.some((p) => p.test(t));
}

/** El tipo de una entrada que no nombra historia (D5), por sus títulos (los de un merge, con los que trae) y su rama. */
function tipo(asunto, rama) {
  const t = String(asunto || '').toLowerCase();
  const r = String(rama || '').toLowerCase();
  if (/(arn[eé]s|claude\.md|pipeline|\bci\b|\bci\/|deploy|staging|port[oó]n|harness)/.test(t)) return 'arnes_ci';
  if (/(deuda|dependenc|\bdeps?\b|bump|renov|vulnerab|cve|imagesharp|\bnpm\b|nuget|\d+\.\d+\.\d+)/.test(t)) return 'dependencias';
  if (/^(fix|hotfix)\//.test(r) || /(\bfix|hotfix|arregl|corrig|correcci)/.test(t)) return 'hotfix';
  if (r === 'dev' || /from dev into main|merge dev|dev → main|dev->main/.test(t)) return 'merge_dev';
  return 'otro';
}

/** La rama de un merge, por su título (Azure DevOps, GitHub o `git merge`). */
function ramaDe(asunto) {
  const s = String(asunto || '');
  const m = s.match(/^Merge pull request #?\d+ from (\S+)/) || s.match(/^Merge (?:remote-tracking )?branch '([^']+)'/);
  if (!m) return null;
  // GitHub escribe «dueño/rama»; la rama es lo que va después del dueño cuando el resto no trae otra barra útil
  return m[1].replace(/^[^/]+\/(?=(story|feature|feat|fix|hotfix|chore|docs)\/)/i, '');
}

// core.quotePath=false: sin eso git escribe entre comillas y con escapes octales una ruta con tilde o ñ, y lo documental
// no la reconoce
function git(dir, args) {
  return spawnSync('git', ['-c', 'mailmap.blob=HEAD:.mailmap', '-c', 'core.quotePath=false', '-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
}
class NoMedido extends Error {}
function gitOk(dir, args, que) {
  const r = git(dir, args);
  if (r.error || r.status !== 0) throw new NoMedido(`git no pudo ${que} (salió ${r.error ? r.error.code || 'error' : r.status})`);
  return r.stdout;
}

/** La punta de main de un clon: `origin/main` si está, si no `HEAD` sólo si el clon está parado en `main`. */
function puntaDe(dir) {
  if (git(dir, ['rev-parse', '--verify', '-q', 'origin/main^{commit}']).status === 0) return 'origin/main';
  const rama = git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (rama.status === 0 && rama.stdout.trim() === 'main' && git(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).status === 0) return 'HEAD';
  throw new NoMedido('el clon no tiene origin/main ni está parado en main');
}

/** Las entradas a main de la ventana: { sha, asunto, rama, via, autor, titulos, archivos }, en memoria. */
function entradasDe(dir, { today } = {}) {
  const v = ventana(today);
  const sup = git(dir, ['rev-parse', '--is-shallow-repository']);
  if (sup.status !== 0) throw new NoMedido(`no es un repo git (git salió ${sup.status})`);
  if (sup.stdout.trim() === 'true') throw new NoMedido('el clon es superficial: no trae la historia de la ventana');
  const punta = puntaDe(dir);
  // Sin --since: git deja de recorrer en el primer commit de la línea principal más viejo que el corte, y un
  // fast-forward de commits viejos escondía todo lo de antes dentro de la ventana. Se recorre entero y se corta acá
  // (el costo es una línea de log por commit; los archivos se piden sólo de lo que cae en la ventana).
  const log = gitOk(dir, ['log', punta, '--first-parent', '--format=%H%x00%P%x00%cI%x00%aN%x00%s%x1e'], 'leer la historia de main');
  const out = [];
  for (const reg of log.split('\x1e')) {
    const r = reg.replace(/^\n+/, '');
    if (!r) continue;
    const [sha, padres, fecha, autor, asunto] = r.split('\x00');
    const t = new Date(fecha);
    if (Number.isNaN(t.getTime())) throw new NoMedido('git devolvió una fecha que no se puede leer');
    const dia = isoDia(t);
    if (dia < v.desde || dia > v.hasta) continue;
    const ps = padres.split(' ').filter(Boolean);
    const archivos = (ps.length
      ? gitOk(dir, ['diff', '--name-only', `${sha}^1`, sha], 'listar los archivos de una entrada')
      : gitOk(dir, ['show', '--name-only', '--format=', sha], 'listar los archivos de una entrada')).split('\n').filter(Boolean);
    const titulos = [];
    const autores = [];
    if (ps.length > 1) {
      const traidos = gitOk(dir, ['log', `${ps[0]}..${ps[1]}`, '--format=%aN%x00%s%x1e'], 'leer los commits de un merge');
      for (const t of traidos.split('\x1e')) {
        const x = t.replace(/^\n+/, '');
        if (!x) continue;
        const [a, s] = x.split('\x00');
        // un aumento de versión automático no dice nada del cambio: ni su persona ni su tipo ni si nombra historia
        if (/skip ci/i.test(s)) continue;
        titulos.push(s);
        autores.push(a);
      }
    }
    const via = ps.length > 1 || SQUASH.test(asunto) ? 'pedido' : 'directo';
    out.push({ sha, asunto, rama: ps.length > 1 ? ramaDe(asunto) : null, via, autor, autores, titulos, archivos });
  }
  return out;
}

function masFrecuente(lista) {
  const n = new Map();
  for (const x of lista) n.set(x, (n.get(x) || 0) + 1);
  let mejor = null;
  for (const [x, c] of n) if (mejor === null || c > n.get(mejor)) mejor = x;
  return mejor;
}

/**
 * Una entrada: si cuenta (D4), si nombra historia (D3), su tipo si no (D5), su persona y su vía. El tipo de un merge sale
 * también de los títulos que trae: el del merge suele ser «Merge pull request N from <rama>», sin detalle.
 */
function clasificar(e) {
  const cuenta = !/\[skip ci\]/i.test(e.asunto) && e.archivos.some((f) => !DOCUMENTAL.test(f));
  const texto = [e.asunto, ...e.titulos].join('\n');
  const con = nombra(`${texto}\n${e.rama || ''}`);
  const persona = (e.autores && e.autores.length ? masFrecuente(e.autores) : null) || e.autor;
  return { asunto: e.asunto, cuenta, nombra: con, tipo: con ? null : tipo(texto, e.rama), persona, via: e.via };
}

// `por_persona` se cuenta en un objeto sin prototipo (el nombre lo pone quien commitea: `__proto__` o `constructor`
// no pueden tocar Object.prototype) y sale como objeto común con `personasComoObjeto`.
function vacio() {
  return { codigo: 0, con: 0, sin: 0, por_persona: Object.create(null), por_tipo: Object.fromEntries(TIPOS.map((t) => [t, 0])),
    por_via: { pedido: { con: 0, sin: 0 }, directo: { con: 0, sin: 0 } } };
}
function sumar(t, c) {
  const k = c.nombra ? 'con' : 'sin';
  t.codigo += 1; t[k] += 1;
  const p = t.por_persona[c.persona] || (t.por_persona[c.persona] = { con: 0, sin: 0 });
  p[k] += 1;
  t.por_via[c.via][k] += 1;
  if (!c.nombra) t.por_tipo[c.tipo] += 1;
}
function sumarCuenta(t, r) {
  t.codigo += r.codigo; t.con += r.con; t.sin += r.sin;
  for (const [n, p] of Object.entries(r.por_persona)) {
    const q = t.por_persona[n] || (t.por_persona[n] = { con: 0, sin: 0 });
    q.con += p.con; q.sin += p.sin;
  }
  for (const k of TIPOS) t.por_tipo[k] += r.por_tipo[k];
  for (const v of ['pedido', 'directo']) { t.por_via[v].con += r.por_via[v].con; t.por_via[v].sin += r.por_via[v].sin; }
}

// Object.fromEntries define cada nombre como propiedad propia, también `__proto__`
const personasComoObjeto = (t) => ({ ...t, por_persona: Object.fromEntries(Object.entries(t.por_persona)) });

/** La cuenta de un repo en la ventana, o «no medido» con su motivo. */
function contarRepo(dir, { today } = {}) {
  const v = ventana(today);
  try {
    const t = vacio();
    for (const e of entradasDe(dir, { today })) { const c = clasificar(e); if (c.cuenta) sumar(t, c); }
    return { estado: 'medido', motivo: null, ventana: v, ...personasComoObjeto(t) };
  } catch (e) {
    if (!(e instanceof NoMedido)) throw e;
    return { estado: 'no_medido', motivo: e.message, ventana: v, codigo: null, con: null, sin: null };
  }
}

/** La cuenta de todos los repos (`{ producto, repo, dir, motivo }`, cada repo una vez) y sus totales. */
function contar({ repos, today }) {
  const v = ventana(today);
  const vistos = new Set();
  const totales = vacio();
  const lista = [];
  for (const r of repos) {
    if (vistos.has(r.repo)) continue;
    vistos.add(r.repo);
    if (!r.dir) { lista.push({ producto: r.producto, repo: r.repo, estado: 'no_medido', motivo: r.motivo || 'sin clon', codigo: null, con: null, sin: null }); continue; }
    const c = contarRepo(r.dir, { today });
    if (c.estado === 'medido') sumarCuenta(totales, c);
    const { ventana: _v, ...resto } = c;
    lista.push({ producto: r.producto, repo: r.repo, ...resto });
  }
  return { ventana: v, totales: personasComoObjeto(totales), repos: lista, cobertura: { repos_declarados: lista.length, repos_medidos: lista.filter((x) => x.estado === 'medido').length } };
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const scan = opt('--scan'); const prods = opt('--products'); const out = opt('--out');
  if (!scan || !prods || !out) {
    console.error('uso: story-reference.js --scan <raíz de clones> --products <repos.json> --out <archivo>');
    process.exit(1);
  }
  let entries;
  try {
    const d = JSON.parse(fs.readFileSync(prods, 'utf8'));
    entries = Array.isArray(d) ? d : d && Array.isArray(d.repos) ? d.repos : null;
  } catch (e) {
    console.error(`story-reference: no pude leer la lista de repos (${e instanceof SyntaxError ? 'no es JSON válido' : e.code || e.name})`);
    process.exit(2);
  }
  if (!entries) { console.error('story-reference: la lista de repos no trae `repos`'); process.exit(2); }
  try { if (!fs.statSync(scan).isDirectory()) throw new Error('no es carpeta'); } catch (e) {
    console.error(`story-reference: no encontré la carpeta de clones (${e.code || e.message})`);
    process.exit(2);
  }
  const r = contar({ repos: resolverNocturno(entries.filter((e) => e && e.activo !== false), scan), today: hoy(null) });
  for (const x of r.repos) if (x.estado !== 'medido') console.error(`story-reference: ${x.repo}: no medido — ${x.motivo}`);
  const doc = { v: 1, generated_at: new Date().toISOString(), ventana: r.ventana, cobertura: r.cobertura, totales: r.totales, repos: r.repos };
  const tmp = `${out}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmp, out);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* no quedó */ }
    console.error(`story-reference: no pude escribir el archivo (${e.code || e.name})`);
    process.exit(2);
  }
  const t = r.totales;
  console.log(`story-reference: ${t.sin} de ${t.codigo} entradas de código sin historia en ${r.ventana.dias} días (${r.cobertura.repos_medidos} de ${r.cobertura.repos_declarados} repos medidos) → ${path.basename(out)}`);
}

if (require.main === module) main();
module.exports = { nombra, tipo, ramaDe, clasificar, entradasDe, contarRepo, contar, ventana, TIPOS, DIAS };
