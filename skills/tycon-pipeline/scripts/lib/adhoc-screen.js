'use strict';
/**
 * adhoc-screen.js — la pantalla en el camino rápido: un arreglo sin historia que toca una pantalla no guarda sin su
 * maqueta aprobada y una captura de lo construido. Lo pide el freno de guardar (save-brake.js) y lo anota `marker.js
 * adhoc`: la maqueta y su aprobación con `adhoc set` (firmado), la captura con `adhoc capture` (sin firma: no aprueba
 * nada, y acá se mide).
 *
 *   revisar(adhoc, repos)     `{ pantallas, faltan, mostrar }`, o `{ sinMedir }` si no se pudo medir: sin medir no guarda.
 *   problemaDeLaMaqueta(ruta) `{ sha256 }` o `{ problema }`: que exista y pase `mockup.js check`.
 *   problemaDeLaCaptura(ruta) el problema en una frase, o null: que sea una imagen de verdad y no esté vacía.
 *   pedidoPorBanderas(args)   `{ payload }` o `{ problema }`: el pedido de `adhoc set --reason …`, sin JSON.
 *   motivoSeCita(motivo)      ¿el motivo va en `--reason "<motivo>"`, y `pedidoPorBanderas` lo acepta?
 *
 * Qué es una pantalla lo dice el pipeline (`ui-signal.js`, con la regla `screen_test` de la organización), archivo por
 * archivo; una prueba no lo es. La captura vale si es más nueva que el último cambio de los archivos del carril.
 *
 * Con las dos, lo construido se compara con la maqueta (`compararConLaMaqueta`): compara textos, no el dibujo, y un texto
 * que ya existe en otra pantalla del repo pasa. Una diferencia se declara en `<maqueta>-diferencias.md`, al lado de ella.
 *
 * Lo que no ve: la fecha de un archivo se puede cambiar, y una imagen de verdad puede no mostrar esa pantalla. Sin la base
 * del carril (sin red al abrirlo) mide lo anotado y el commit, no el resto de la rama: sigue y lo avisa, como el resto del
 * camino rápido.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FIRMAS_DE_IMAGEN = {
  '.png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  '.jpeg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

const rutaReal = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(String(p)); } };
// una ruta en un renglón: va al texto que lee la persona antes de aprobar, y no puede armar renglones falsos
const enUnRenglon = (s) => String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');

/**
 * El pedido de `adhoc set --reason <motivo> [--max-files N] --terminal [--for-session <id>]`, la forma sin JSON para la
 * consola de la persona: el PowerShell que viene con Windows rompe las comillas del JSON al pasarlo. `args` son los
 * argumentos después de `set`. `{ payload }` o `{ problema }`. Va sólo con `--terminal`: la ventana de permiso, la
 * delegación y el tope leen el JSON. Un motivo que empieza con `-` se rechaza, para que no se haga pasar por una bandera.
 */
function pedidoPorBanderas(args) {
  const payload = {};
  let terminal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--terminal') terminal = true;
    else if (a === '--for-session') i++;
    else if (a === '--reason' || a === '--max-files') {
      const clave = a === '--reason' ? 'reason' : 'maxFiles';
      const v = args[++i];
      if (clave in payload) return { problema: `${a} va una sola vez` };
      if (v === undefined || v.startsWith('-')) return { problema: `${a} necesita un valor, y no puede empezar con «-»` };
      if (clave === 'maxFiles' && !/^\d+$/.test(v)) return { problema: '--max-files es un número entero' };
      payload[clave] = clave === 'maxFiles' ? Number(v) : v;
    } else return { problema: `no conozco «${enUnRenglon(a)}»` };
  }
  if (!('reason' in payload)) return { problema: 'falta --reason' };
  if (!terminal) return { problema: 'esta forma va sólo con --terminal; desde una sesión, el pedido va en JSON' };
  return { payload };
}

/**
 * ¿El motivo se puede dar en `--reason "<motivo>"`? No, si empieza con `-` (`pedidoPorBanderas` lo rechaza), si trae lo que
 * bash, PowerShell o cmd leen adentro de unas comillas (PowerShell toma las comillas tipográficas como comillas normales,
 * y una cerraría el motivo), si termina en una barra (escapa la comilla de cierre) o si trae un carácter de control (parte
 * el renglón).
 */
function motivoSeCita(motivo) {
  return !/^-|["`$%!\u2018-\u201F]|\\$|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(String(motivo));
}

function problemaDeLaMaqueta(ruta) {
  const mk = require('../mockup.js');
  let html;
  try { html = fs.readFileSync(ruta, 'utf8'); } catch (e) { return { problema: `no pude leer la maqueta ${enUnRenglon(ruta)} (${e.code || e.message})` }; }
  const v = mk.validateMockupHtml(html);
  if (!v.ok) return { problema: `la maqueta ${enUnRenglon(ruta)} no pasa mockup.js check (${v.findings[0].what})` };
  return { sha256: mk.mockupHash(html) };
}

function problemaDeLaCaptura(ruta) {
  const firma = FIRMAS_DE_IMAGEN[path.extname(String(ruta)).toLowerCase()];
  const dicha = enUnRenglon(ruta);
  if (!firma) return `la captura ${dicha} no es una imagen .png, .jpg o .webp`;
  let fd;
  try {
    fd = fs.openSync(ruta, 'r');
    const buf = Buffer.alloc(12);
    const n = fs.readSync(fd, buf, 0, 12, 0);
    if (!firma(buf.subarray(0, n))) return `la captura ${dicha} no es una imagen: está vacía o su contenido no coincide con su extensión`;
  } catch (e) {
    return `no pude leer la captura ${dicha} (${e.code || e.message})`;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

// El nombre del repo, también desde un worktree: en una historia la entrada lleva el del repo (`(FrontEnd) x.ts`), no el
// de la carpeta de trabajo.
function nombreDelRepo(repo) {
  const comun = execFileSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
  return path.basename(path.dirname(path.resolve(repo, comun)));
}

function reglaDePantalla() {
  return require('./stack-config.js').orgRules().rules.screen_test.value;
}

// Lo que le falta a la maqueta y a la captura anotadas, cada cosa en una frase.
function faltantes(adhoc, ultimaEdicion) {
  const faltan = [];
  const maqueta = adhoc.mockup;
  if (!maqueta || typeof maqueta.file !== 'string' || !maqueta.approval) {
    faltan.push('la maqueta aprobada');
  } else {
    const m = problemaDeLaMaqueta(maqueta.file);
    if (m.problema) faltan.push(m.problema);
    else if (m.sha256 !== maqueta.sha256) faltan.push(`volver a aprobar la maqueta: ${enUnRenglon(maqueta.file)} cambió después de aprobada`);
  }
  const captura = adhoc.capture;
  if (!captura || typeof captura.file !== 'string') {
    faltan.push('la captura de lo construido');
    return faltan;
  }
  const p = problemaDeLaCaptura(captura.file);
  if (p) { faltan.push(p); return faltan; }
  if (fs.statSync(captura.file).mtimeMs <= ultimaEdicion) faltan.push(`una captura nueva: ${enUnRenglon(captura.file)} es anterior al último cambio del carril`);
  return faltan;
}

// La fecha de un archivo del carril. Uno borrado no tiene: vale la de su carpeta, que cambió al borrarlo (o la de la primera
// que siga en pie). Otro cambio en esa carpeta también la mueve: del lado seguro, pide otra captura.
function fechaDelCambio(abs) {
  for (let p = abs; ; p = path.dirname(p)) {
    try { return fs.statSync(p).mtimeMs; } catch (e) {
      if (!['ENOENT', 'ENOTDIR'].includes(e.code) || path.dirname(p) === p) throw e;
    }
  }
}

// Una prueba por su nombre o por una carpeta de pruebas o de ejemplos. Una carpeta `test/`, `specs/` o `fixtures/` más adentro
// puede ser una pantalla de verdad (la ruta `/test` de `src/app/test/page.tsx`): ésas cuentan como prueba sólo en la raíz.
const esPrueba = (rel) => /\.(test|spec|cy|stories)\.[^./]+$/i.test(rel) || /(^|\/)(__tests__|__mocks__|__fixtures__|tests|e2e|cypress|playwright)\//i.test(rel) || /^(test|specs?|fixtures)\//i.test(rel);

const TANDA_DE_PANTALLAS = 50;
const MAS_NOMBRADOS = 5;
const TOPE_COMPARAR_MS = 20000;
// se lee al comparar, y un 0 vale: las pruebas agotan el tiempo con él
const topeDeComparar = () => { const v = process.env.TYCON_ADHOC_COMPARE_TIMEOUT_MS; return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : TOPE_COMPARAR_MS; };

/** El archivo de las diferencias, al lado de la maqueta. */
const archivoDeDiferencias = (maqueta) => `${String(maqueta).replace(/\.html?$/i, '')}-diferencias.md`;

const esArchivo = (f) => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } };

/**
 * El resto de las pantallas de un repo: las mismas extensiones que busca la revisión de una historia, sin las pruebas. Lo
 * que git sigue y no está en el disco (borrado, o afuera por sparse-checkout) no tiene nada que comparar.
 */
function otrasPantallas(repo, yaMiradas) {
  const lista = execFileSync('git', ['-C', repo, '-c', 'core.quotepath=false', 'ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
  return lista.split('\0').filter((rel) => rel && /\.(tsx|jsx|vue|svelte)$/i.test(rel) && !esPrueba(rel))
    .map((rel) => ({ rel, abs: path.join(repo, rel) })).filter((s) => !yaMiradas.has(s.abs) && esArchivo(s.abs));
}

/**
 * Lo construido contra la maqueta aprobada, con la misma comparación que una historia (`compareWithScreens`): primero en
 * las pantallas del carril y lo que falta en el resto de las pantallas de sus repos, por tandas, hasta que no falte nada o
 * se acabe el tiempo. `{ faltan, declaradas, imposible }` o `{ sinMedir }`. Compara textos, no el dibujo: un texto que ya
 * existe en otra pantalla pasa.
 */
function compararConLaMaqueta(adhoc, pantallas, repos) {
  const mk = require('../mockup.js');
  const desde = Date.now();
  const tope = topeDeComparar();
  const dif = archivoDeDiferencias(adhoc.mockup.file);
  const agotado = () => ({ sinMedir: `se agotaron los ${Math.round(tope / 1000)} segundos de la comparación: repetí el comando, o declará en ${enUnRenglon(dif)} la línea \`mockup-compare: no — <motivo>\`` });
  let md = '';
  // un editor de Windows lo deja con BOM y CRLF: se lee igual
  try { md = fs.readFileSync(dif, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'); } catch (e) {
    if (e.code !== 'ENOENT') return { sinMedir: `no pude leer ${enUnRenglon(dif)} (${e.code || e.message})` };
  }
  // la misma línea que lee la revisión de una historia (qa-guide.js): el motivo va en ese renglón
  const imposible = md.match(/^[ \t]*[-*]?[ \t]*mockup-compare:[ \t]*no[ \t]*[—–-]+[ \t]*(\S.*?)[ \t]*$/im);
  if (imposible) return { faltan: [], declaradas: [], imposible: imposible[1] };
  let textos;
  try { textos = mk.mockupTexts(fs.readFileSync(adhoc.mockup.file, 'utf8')); } catch (e) { return { sinMedir: `no pude leer la maqueta (${e.code || e.message})` }; }
  if (!textos) return { sinMedir: `${enUnRenglon(adhoc.mockup.file)} no es una maqueta de mockup.js` };
  const legibles = pantallas.filter(esArchivo).map((abs) => ({ rel: abs, abs }));
  if (!legibles.length) return { sinMedir: `el carril no tiene pantallas que se puedan leer: si sólo borró una, declará en ${enUnRenglon(dif)} la línea \`mockup-compare: no — <motivo>\`` };
  if (Date.now() - desde >= tope) return agotado();
  const delCarril = mk.compareWithScreens({ texts: textos, screens: legibles, md });
  if (delCarril.unreadable.length) return { sinMedir: `no pude leer la pantalla ${enUnRenglon(delCarril.unreadable[0].rel)} (${delCarril.unreadable[0].error})` };
  let faltan = delCarril.missing;
  const declaradas = delCarril.declared;
  if (!faltan.length) return { faltan, declaradas, imposible: null };
  const yaMiradas = new Set(legibles.map((s) => s.abs));
  let ilegible = null;
  for (const repo of repos) {
    let resto;
    try { resto = otrasPantallas(repo, yaMiradas); } catch (e) { return { sinMedir: `git no contestó en ${enUnRenglon(repo)} (${String(e.message || e).split('\n')[0]})` }; }
    for (let i = 0; i < resto.length && faltan.length; i += TANDA_DE_PANTALLAS) {
      if (Date.now() - desde >= tope) return agotado();
      const c = mk.compareWithScreens({ texts: faltan, screens: resto.slice(i, i + TANDA_DE_PANTALLAS), md });
      if (c.unreadable.length && !ilegible) ilegible = c.unreadable[0];
      faltan = c.missing;
    }
  }
  // una pantalla sin leer podría tener lo que falta: no mirar no es «falta»
  if (faltan.length && ilegible) return { sinMedir: `no pude leer la pantalla ${enUnRenglon(ilegible.rel)} (${ilegible.error})` };
  return { faltan, declaradas, imposible: null };
}

function revisar(adhoc, repos = []) {
  const { propiosDelCarril } = require('./adhoc-base.js');
  const { isCodeFile } = require('./story-gate.js');
  const { fileTouchesUi } = require('./ui-signal.js');
  // lo que el arreglo cambió de verdad: lo traído de `main` no pide maqueta ni captura
  const regla = reglaDePantalla();
  const esDePantalla = (rel, repo) => !esPrueba(rel) && fileTouchesUi(rel, repo, regla, nombreDelRepo(repo));
  const { porRepo, fallas, avisos } = propiosDelCarril(adhoc, { repos, sinSeguir: true, soloCambiados: true, suma: esDePantalla });
  if (fallas.length) return { sinMedir: fallas[0] };
  const anotadas = new Set([adhoc.mockup, adhoc.capture].filter((x) => x && typeof x.file === 'string').map((x) => rutaReal(x.file)));
  const pantallas = [];
  // `pantallas` va al texto que lee la persona; la comparación abre las rutas tal cual
  const rutasDePantallas = [];
  let ultimaEdicion = -Infinity;
  for (const repo of Object.keys(porRepo)) {
    for (const rel of porRepo[repo]) {
      const abs = path.join(repo, rel);
      if (anotadas.has(rutaReal(abs))) continue;
      const esPantalla = esDePantalla(rel, repo);
      // un worktree dentro de otro repo del carril muestra la misma pantalla en los dos
      if (esPantalla && !rutasDePantallas.includes(abs)) { pantallas.push(enUnRenglon(abs)); rutasDePantallas.push(abs); }
      if (!esPantalla && !isCodeFile(rel)) continue;
      ultimaEdicion = Math.max(ultimaEdicion, fechaDelCambio(abs));
    }
  }
  if (!pantallas.length) return { pantallas, faltan: [], mostrar: null, avisos };
  const dicha = (x) => (x && typeof x.file === 'string' ? enUnRenglon(x.file) : 'sin anotar');
  const mostrar = `Maqueta: ${dicha(adhoc.mockup)} · captura: ${dicha(adhoc.capture)}.`;
  const faltan = faltantes(adhoc, ultimaEdicion);
  if (faltan.length) return { pantallas, faltan, mostrar, avisos };
  const c = compararConLaMaqueta(adhoc, rutasDePantallas, Object.keys(porRepo));
  if (c.sinMedir) return { sinMedir: c.sinMedir, deLaMaqueta: true };
  if (c.faltan.length) {
    return { pantallas, mostrar, avisos, faltan: [...new Set(c.faltan.map((x) => x.text))].slice(0, MAS_NOMBRADOS).map((x) => `el texto «${enUnRenglon(x)}» de la maqueta`),
      textosQueFaltan: { total: new Set(c.faltan.map((x) => x.text)).size, diferencias: archivoDeDiferencias(adhoc.mockup.file) } };
  }
  // lo que no se comparó queda a la vista: en la pregunta de guardar y en el registro
  const registro = c.imposible ? [`comparación con la maqueta declarada imposible: ${enUnRenglon(c.imposible)}`]
    : c.declaradas.map((d) => `diferencia declarada con la maqueta: «${enUnRenglon(d.text)}» — differs: ${enUnRenglon(d.motivo)}`);
  return { pantallas, faltan: [], mostrar: [mostrar, ...registro].join(' '), registro, avisos };
}

module.exports = { revisar, problemaDeLaMaqueta, problemaDeLaCaptura, enUnRenglon, pedidoPorBanderas, motivoSeCita };
