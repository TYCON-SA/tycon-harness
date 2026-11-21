#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * compare-matrix.js — cuántas historias cambian de resultado entre dos versiones de la matriz, sobre repos reales.
 *
 * Por qué existe: el laboratorio (scripts/tests/lib/product-lab.js) prueba la forma de un producto, y esto mide los productos
 * de verdad. Se corre antes y después de cambiar la matriz o los cierres, y los totales se anotan en la historia. En la CI no
 * corre: ahí no están los repos.
 *
 * Sólo lee: `compute` de la matriz no escribe. Calcula de a una historia, con pausa, para no cargar la máquina. Por salida da
 * sólo rótulos, porque la lista de historias nombra proyectos: esa lista va a `--detail`, fuera de los repos medidos.
 *
 * Límite: la evidencia se confirma contra el espejo de esta máquina. Una historia probada en otra sale en rojo acá, con las
 * dos versiones: el número de cambios es un piso.
 *
 * Una historia que una versión no pudo calcular va a `error`, y nunca cuenta como igual. Una exenta pasa el cierre igual que
 * una verde: si lo es en una sola versión, el cambio se cuenta como de verde a rojo o de rojo a verde.
 *
 * Uso: node scripts/tools/compare-matrix.js --before <arnés> --after <arnés> --repo <rótulo>=<carpeta> ...
 *        [--detail <archivo>] [--json]
 * Sale 0 si midió todo. Sale 2, sin imprimir totales, si un repo o una versión no se pudo medir: una carpeta que no es un
 * repo, un repo sin historias, uno en el que ninguna historia se pudo calcular o una matriz que no carga. Nunca cuenta
 * como «sin cambios».
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PAUSA_MS = 250;
const PRESUPUESTO_MS = 120000;

function salir(mensaje) {
  process.stderr.write(`compare-matrix: ${mensaje}\n`);
  process.exit(2);
}

function leerArgumentos(argv) {
  const uno = (n) => {
    const i = argv.indexOf(n);
    if (i < 0) return null;
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) salir(`${n} necesita un valor`);
    return argv[i + 1];
  };
  const repos = [];
  argv.forEach((a, i) => {
    if (a !== '--repo') return;
    const par = String(argv[i + 1] || '');
    const corte = par.indexOf('=');
    if (corte < 1) salir('--repo va como <rótulo>=<carpeta>');
    const rotulo = par.slice(0, corte);
    if (repos.some((r) => r.rotulo === rotulo)) salir(`el rótulo ${rotulo} se repite: los totales no cuadrarían`);
    repos.push({ rotulo, carpeta: path.resolve(par.slice(corte + 1)) });
  });
  if (!uno('--before') || !uno('--after') || !repos.length) salir('uso: --before <arnés> --after <arnés> --repo <rótulo>=<carpeta> [--detail <archivo>] [--json]');
  return { before: uno('--before'), after: uno('--after'), repos, detail: uno('--detail'), json: argv.includes('--json') };
}

function cargarMatriz(nombre, harness) {
  try {
    return require(path.join(path.resolve(harness), 'skills', 'tycon-pipeline', 'scripts', 'runtime-matrix.js'));
  } catch (e) {
    return salir(`no pude cargar la matriz de ${nombre}: ${e.code || e.message}`);
  }
}

// `.native` devuelve la ruta como la guarda el disco: en uno que no distingue mayúsculas, dos escrituras dan la misma
function raizDeGit(carpeta) {
  return fs.realpathSync.native(execFileSync('git', ['-C', carpeta, 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
}

const dormir = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** `compute` avisa con rutas por las dos salidas: acá no se imprime nada de eso, y la salida estándar es la de los totales. */
function callado(fn) {
  const err = process.stderr.write;
  const out = process.stdout.write;
  process.stderr.write = () => true;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stderr.write = err; process.stdout.write = out; }
}

/** Lo que una versión dijo de una historia. `motivo` dice por qué no se pudo calcular, sin rutas. */
function resumen(matriz, storyPath) {
  let r;
  try { r = callado(() => matriz.compute({ storyPath })); } catch (e) { return { error: true, motivo: e.code || (e.constructor && e.constructor.name) || 'error' }; }
  if (!r || typeof r !== 'object') return { error: true, motivo: 'sin resultado' };
  if (r.structuralError) return { error: true, motivo: 'error de estructura' };
  if (r.exempt) return { exenta: true, verde: true };
  if (typeof r.green !== 'boolean' || !Array.isArray(r.acs) || !r.perAc) return { error: true, motivo: 'resultado sin green, acs o perAc' };
  const estados = r.acs.map((n) => [n, r.perAc[n] && r.perAc[n].verdict]);
  if (!estados.length || estados.some(([, v]) => typeof v !== 'string')) return { error: true, motivo: 'sin un veredicto por criterio' };
  return { verde: r.green, estados: JSON.stringify(estados) };
}

function clasificar(a, b) {
  if (a.error || b.error) return 'error';
  if (a.exenta && b.exenta) return 'exenta';
  if (a.verde && !b.verde) return 'verdeARojo';
  if (!a.verde && b.verde) return 'rojoAVerde';
  if (a.verde) return 'verdeIgual';
  return a.estados === b.estados ? 'rojoARojoIgual' : 'rojoARojoCambia';
}

const NOMBRE_DEL_CAMBIO = { verdeARojo: 'verde-a-rojo', rojoAVerde: 'rojo-a-verde', verdeIgual: 'igual', rojoARojoIgual: 'igual', rojoARojoCambia: 'rojo-a-rojo-cambia', error: 'error', exenta: 'exenta' };
const vacio = () => ({ historias: 0, verdeARojo: 0, rojoAVerde: 0, rojoARojoCambia: 0, rojoARojoIgual: 0, verdeIgual: 0, exenta: 0, error: 0 });

/** La lista nombra proyectos: sólo la lee quien la escribe, y no se sigue un enlace puesto mientras se calculaba. */
function escribirDetalle(destino, texto) {
  let fd;
  try {
    fd = fs.openSync(destino, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, texto);
  } catch (e) {
    salir(`no pude escribir --detail (${e.code || 'error'})`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function main() {
  const a = leerArgumentos(process.argv.slice(2));
  const antes = cargarMatriz('--before', a.before);
  const despues = cargarMatriz('--after', a.after);
  const { discoverStories } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-discovery.js'));

  const repos = [];
  for (const { rotulo, carpeta } of a.repos) {
    let raiz;
    try { raiz = raizDeGit(carpeta); } catch (_) { salir(`${rotulo}: no es un repo de git, o no existe`); }
    const otro = repos.find((r) => r.raiz === raiz);
    if (otro) salir(`${rotulo} y ${otro.rotulo} son el mismo repo: los totales no cuadrarían`);
    repos.push({ rotulo, raiz });
  }
  let destino = null;
  if (a.detail) {
    let carpetaDestino;
    try { carpetaDestino = fs.realpathSync.native(path.dirname(path.resolve(a.detail))); } catch (_) { salir('la carpeta de --detail no existe'); }
    destino = path.join(carpetaDestino, path.basename(a.detail));
    let enlace = false;
    try { enlace = fs.lstatSync(destino).isSymbolicLink(); } catch (_) { /* no existe todavía: se crea */ }
    if (enlace) salir('--detail es un enlace: la lista se escribe en un archivo común, fuera de los repos medidos');
    for (const { rotulo, raiz } of repos) {
      if (carpetaDestino === raiz || carpetaDestino.startsWith(raiz + path.sep)) salir(`--detail está dentro del repo ${rotulo}: esa lista no se escribe en un repo medido`);
    }
  }

  const porRepo = {};
  const total = vacio();
  const lineas = [];
  for (const { rotulo, raiz } of repos) {
    const hallado = discoverStories(raiz, { cache: false, budgetMs: PRESUPUESTO_MS });
    if (hallado.partial) salir(`${rotulo}: no pude recorrer todas las historias`);
    if (!hallado.stories.length) salir(`${rotulo}: no tiene historias; ¿es la carpeta correcta?`);
    const c = vacio();
    const historias = [...hallado.stories].sort((x, y) => x.path.localeCompare(y.path));
    for (const s of historias) {
      c.historias += 1;
      const ra = resumen(antes, s.path);
      const rb = resumen(despues, s.path);
      const clase = clasificar(ra, rb);
      c[clase] += 1;
      const linea = { rotulo, ruta: path.relative(raiz, s.path).split(path.sep).join('/'), status: s.status, cambio: NOMBRE_DEL_CAMBIO[clase] };
      if (clase === 'error') linea.motivo = [ra.motivo && `antes: ${ra.motivo}`, rb.motivo && `después: ${rb.motivo}`].filter(Boolean).join(' · ');
      lineas.push(linea);
      dormir(PAUSA_MS);
    }
    if (c.error === c.historias) salir(`${rotulo}: ninguna de sus ${c.historias} historias se pudo calcular`);
    porRepo[rotulo] = c;
    for (const k of Object.keys(total)) total[k] += c[k];
  }

  if (destino) escribirDetalle(destino, lineas.map((l) => `${JSON.stringify(l)}\n`).join(''));
  if (a.json) process.stdout.write(`${JSON.stringify({ repos: porRepo, total }, null, 1)}\n`);
  else {
    for (const [rotulo, c] of Object.entries(porRepo)) process.stdout.write(`${rotulo} ${JSON.stringify(c)}\n`);
    process.stdout.write(`total ${JSON.stringify(total)}\n`);
  }
}

main();
