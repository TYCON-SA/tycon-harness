#!/usr/bin/env node
'use strict';
/**
 * merge-metrics.js — el archivo de métricas de cada merge (`metrics-*.json`, lo escribe retro-heartbeat.js), desde la
 * máquina hasta el tablero.
 *
 * Cada máquina lo escribe en su carpeta de estado (`<stateDir>/dashboard`), upload-runs.js lo sube al buzón y el
 * nocturno del tablero lo baja y lo junta en `.dashboard/merges/` de operaciones. Nadie lo commitea a mano.
 *
 *   · `carpetaLocal(stateDir)` — dónde lo escribe la máquina.
 *   · `pendientes(dir)` — los `metrics-*.json` de una carpeta, sin entrar a subcarpetas. Sin la carpeta, ninguno; si
 *     no se puede leer, tira el error: no es «nada que subir».
 *   · `paraSubir(dir, { historia })` — los de `dir` que van al buzón: sólo los 2.0 válidos y que no están ya en la
 *     carpeta de la historia (los de antes, que siguen versionados). Cuenta los `invalidos` y los `enLaHistoria`.
 *   · `colgados(clon)` — los que quedaron sin versionar en `<clon>/.dashboard/` (de antes de esta carpeta). Si git no
 *     puede decir cuáles están versionados, o la carpeta no se puede leer, devuelve `error` y ninguno: un archivo
 *     versionado no se mueve nunca.
 *   · `mudar(clon, destino)` — muda los colgados válidos a `destino`. Copia a un temporal, lo enlaza con el nombre
 *     final (nunca pisa otro archivo), lo relee byte a byte y recién entonces borra el original. Con `simular`, sólo
 *     cuenta lo que mudaría y dice lo que dejaría.
 *   · `mismoMerge(a, b)` / `unoPorMerge(items)` — dos máquinas pueden mandar el mismo merge (con otra ruta del repo,
 *     o con el nombre de un worktree). Gana el que trae las vueltas de los revisores; entre iguales, el más nuevo.
 *   · `constancia(dir, ahora)` — la constancia `bajada.json` que deja `juntar`: sirve sólo completa y de las últimas
 *     36 horas. Sin ella, el nocturno publica «no medido» con el motivo, nunca el número de lo viejo.
 *
 * Línea de comandos (la corre el nocturno del tablero después de traer los datos de operaciones):
 *   node scripts/lib/merge-metrics.js juntar --from <dir> --to <dir> --result <bajada.json de download-runs>
 *   Junta lo bajado en `--to` (un archivo por merge) y escribe siempre `<hacia>/bajada.json`:
 *   `{ fecha, estado, completo, juntados, repetidos, invalidos }`. Sin un resultado legible no toca lo juntado y la
 *   constancia dice `estado: sin_resultado`, `completo: false`. Sale 0 salvo que no pueda escribir (1) o le falten
 *   argumentos (2).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validate } = require('./dashboard-metrics.js');

const PATRON = /^metrics-.*\.json$/;
const CONSTANCIA = 'bajada.json';
const VIGENCIA_H = 36;

const carpetaLocal = (stateDir) => path.join(stateDir, 'dashboard');

function pendientes(dir) {
  let fs_ = [];
  // una carpeta que no existe es «nada»; una que no se puede leer, no: el error sube para que se diga
  try { fs_ = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return fs_.filter((e) => e.isFile() && PATRON.test(e.name)).map((e) => e.name).sort().map((f) => ({ f, ruta: path.join(dir, f) }));
}

function paraSubir(dir, opts = {}) {
  const res = { archivos: [], invalidos: 0, enLaHistoria: 0 };
  for (const x of pendientes(dir)) {
    // ya está en la historia (la mudanza de la casa dejó en la carpeta de estado una copia del `.dashboard` del clon)
    if (opts.historia && fs.existsSync(path.join(opts.historia, x.f))) { res.enLaHistoria += 1; continue; }
    let d;
    try { d = JSON.parse(fs.readFileSync(x.ruta, 'utf8')); } catch (_) { res.invalidos += 1; continue; }
    const v = validate(d);
    if (v.legacy || !v.ok) { res.invalidos += 1; continue; }
    res.archivos.push(x);
  }
  return res;
}

function gitPorDefecto(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { status: r.error ? -1 : r.status, stdout: r.stdout || '', stderr: r.error ? r.error.message : (r.stderr || '') };
}

function colgados(clon, opts = {}) {
  const correr = opts.git ? (args) => opts.git(args) : (args) => gitPorDefecto(clon, args);
  const top = correr(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return { archivos: [], error: (top.stderr || `git salió ${top.status}`).trim().split('\n')[0] };
  let real;
  try { real = fs.realpathSync(clon); } catch (e) { return { archivos: [], error: e.code || e.message }; }
  if (top.stdout.trim() && fs.realpathSync(top.stdout.trim()) !== real) return { archivos: [], error: `${clon} no es la raíz de un repo` };
  const ls = correr(['ls-files', '-z', '--', '.dashboard']);
  if (ls.status !== 0) return { archivos: [], error: (ls.stderr || `git salió ${ls.status}`).trim().split('\n')[0] };
  const versionados = new Set(ls.stdout.split('\0').filter(Boolean));
  let todos;
  try { todos = pendientes(path.join(clon, '.dashboard')); } catch (e) { return { archivos: [], error: `no se pudo leer .dashboard (${e.code || e.message})` }; }
  const archivos = todos.filter((x) => !versionados.has(`.dashboard/${x.f}`)).map((x) => x.ruta);
  return { archivos, error: null };
}

function mudar(clon, destino, opts = {}) {
  const f_ = opts.fs || fs;
  const res = { migrados: 0, dejados: [] };
  const col = colgados(clon, opts);
  if (col.error) {
    res.dejados.push({ archivo: '.dashboard', motivo: `no pude saber cuáles están sin versionar (${col.error}): no se movió ninguno` });
    return res;
  }
  for (const origen of col.archivos) {
    const f = path.basename(origen);
    const deja = (motivo) => res.dejados.push({ archivo: f, motivo });
    let cuerpo, d;
    // ENOENT: otra sesión lo mudó entre la lista y la lectura; no es un error ni algo que quedó atrás
    try { cuerpo = f_.readFileSync(origen); } catch (e) { if (e.code !== 'ENOENT') deja(`no se pudo leer (${e.code || e.message})`); continue; }
    try { d = JSON.parse(cuerpo.toString('utf8')); } catch (_) { deja('no es un archivo 2.0 (no es JSON)'); continue; }
    const v = validate(d);
    if (v.legacy) { deja(`no es un archivo 2.0 (versión ${v.version})`); continue; }
    if (!v.ok) { deja(`no pasa la validación: ${v.errors.slice(0, 2).join('; ')}`); continue; }
    const final = path.join(destino, f);
    try {
      if (f_.existsSync(final)) {
        if (!f_.readFileSync(final).equals(cuerpo)) { deja('ya hay otro con ese nombre y distinto contenido en la carpeta de estado: no se pisa'); continue; }
      } else if (opts.simular) {
        // --dry-run: se cuenta lo que se mudaría, sin escribir ni borrar nada
      } else {
        f_.mkdirSync(destino, { recursive: true });
        const temporal = path.join(destino, `.${f}.${process.pid}.tmp`);
        f_.writeFileSync(temporal, cuerpo, { flag: 'wx' });
        // EEXIST: otra sesión lo enlazó primero; si quedó igual, cuenta como mudado
        let choco = false;
        try { f_.linkSync(temporal, final); } catch (e) { if (e.code !== 'EEXIST') throw e; choco = true; } finally { try { f_.unlinkSync(temporal); } catch (_) { /* ya no está */ } }
        if (!f_.readFileSync(final).equals(cuerpo)) { deja(choco ? 'ya hay otro con ese nombre y distinto contenido en la carpeta de estado: no se pisa' : 'la copia no salió igual: el original queda'); continue; }
      }
    } catch (e) { deja(`no se pudo copiar (${e.code || e.message})`); continue; }
    if (opts.simular) { res.migrados += 1; continue; }
    try { f_.unlinkSync(origen); } catch (e) { if (e.code !== 'ENOENT') { deja(`copiado, pero el original no se pudo borrar (${e.code || e.message})`); continue; } }
    res.migrados += 1;
  }
  return res;
}

const shaDe = (d) => String((d && d.merge_commit) || '').trim().toLowerCase();

function mismoMerge(a, b) {
  const sa = shaDe(a); const sb = shaDe(b);
  if (sa.length < 7 || sb.length < 7) return false;
  const n = Math.min(sa.length, sb.length);
  if (sa.slice(0, n) !== sb.slice(0, n)) return false;
  return (sa.length === 40 && sb.length === 40) || (!!a.project && a.project === b.project);
}

const conVueltas = (d) => {
  const m = d && d.metrics && d.metrics.advisor_rerun_loop_iterations;
  return !!m && m.value !== null && m.value !== undefined;
};
const momento = (d) => {
  const t = Date.parse((d && (d.ts || d.captured_at)) || '');
  return Number.isFinite(t) ? t : 0;
};
const mejor = (x, y) => {
  if (conVueltas(x) !== conVueltas(y)) return conVueltas(x);
  return momento(x) >= momento(y);
};

/** `items`: documentos, o `{ doc, ... }`. Devuelve `{ elegidos, repetidos }`, en el orden en que apareció cada merge. */
function unoPorMerge(items) {
  const docDe = (x) => (x && x.doc) || x;
  // `mismoMerge` no es transitiva (un sha corto se une por proyecto; dos completos, sin mirarlo): el que llega junta
  // TODOS los grupos que toca, así el resultado no depende del orden
  const grupos = [];
  for (const it of items) {
    const tocados = [];
    grupos.forEach((gr, i) => { if (gr.some((o) => mismoMerge(docDe(o), docDe(it)))) tocados.push(i); });
    if (!tocados.length) { grupos.push([it]); continue; }
    grupos[tocados[0]] = [...tocados.flatMap((i) => grupos[i]), it];
    for (const i of tocados.slice(1).reverse()) grupos.splice(i, 1);
  }
  const elegidos = grupos.map((g) => g.reduce((a, b) => (mejor(docDe(a), docDe(b)) ? a : b)));
  return { elegidos, repetidos: items.length - elegidos.length };
}

function constancia(dir, ahora = Date.now()) {
  const ruta = path.join(dir, CONSTANCIA);
  let c;
  try { c = JSON.parse(fs.readFileSync(ruta, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return { al_dia: false, motivo: `no hay constancia de la bajada de los merges (${ruta}): el nocturno del tablero todavía no la dejó`, fecha: null, estado: null };
    return { al_dia: false, motivo: `la constancia de la bajada de los merges no se puede leer (${e.code || 'JSON roto'})`, fecha: null, estado: null };
  }
  const fecha = c && typeof c.fecha === 'string' ? c.fecha : null;
  const estado = c && typeof c.estado === 'string' ? c.estado : null;
  if (!c || c.completo !== true) return { al_dia: false, motivo: `la bajada de los merges no se completó (estado ${estado || 'desconocido'})`, fecha, estado };
  const t = Date.parse(fecha || '');
  if (!Number.isFinite(t)) return { al_dia: false, motivo: 'la constancia de la bajada de los merges no se puede leer (sin fecha)', fecha, estado };
  const horas = Math.round((ahora - t) / 3600000);
  if (ahora - t > VIGENCIA_H * 3600000) return { al_dia: false, motivo: `la última bajada completa de los merges es de hace ${horas} h (más de ${VIGENCIA_H})`, fecha, estado };
  return { al_dia: true, motivo: null, fecha, estado };
}

function escribirAtomico(ruta, cuerpo) {
  const temporal = `${ruta}.${process.pid}.tmp`;
  fs.writeFileSync(temporal, cuerpo);
  fs.renameSync(temporal, ruta);
}

function leerValidos(dir, desde) {
  const validos = []; let invalidos = 0;
  for (const { f, ruta } of pendientes(dir)) {
    let d;
    try { d = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (_) { invalidos += 1; continue; }
    const v = validate(d);
    if (v.legacy || !v.ok) { invalidos += 1; continue; }
    validos.push({ doc: d, f, ruta, desde });
  }
  return { validos, invalidos };
}

function juntar({ desde, hacia, resultado }) {
  fs.mkdirSync(hacia, { recursive: true });
  let r = null;
  try { r = JSON.parse(fs.readFileSync(resultado, 'utf8')); } catch (_) { r = null; }
  if (!r || typeof r !== 'object') {
    const c = { fecha: new Date().toISOString(), estado: 'sin_resultado', completo: false, juntados: 0, repetidos: 0, invalidos: 0 };
    escribirAtomico(path.join(hacia, CONSTANCIA), `${JSON.stringify(c, null, 2)}\n`);
    return c;
  }
  const estado = typeof r.estado === 'string' && /^[a-z_]+$/.test(r.estado) ? r.estado : 'desconocido';
  const ya = leerValidos(hacia, false);
  const nuevos = leerValidos(desde, true);
  const { elegidos, repetidos } = unoPorMerge([...ya.validos, ...nuevos.validos]);
  const queda = new Set();
  let juntados = 0;
  for (const e of elegidos) {
    queda.add(e.f);
    if (!e.desde) continue;
    escribirAtomico(path.join(hacia, e.f), fs.readFileSync(e.ruta));
    juntados += 1;
  }
  for (const v of ya.validos) if (!queda.has(v.f)) fs.unlinkSync(v.ruta);
  const c = { fecha: new Date().toISOString(), estado, completo: r.completo === true, juntados, repetidos, invalidos: nuevos.invalidos };
  escribirAtomico(path.join(hacia, CONSTANCIA), `${JSON.stringify(c, null, 2)}\n`);
  return c;
}

module.exports = { CONSTANCIA, VIGENCIA_H, carpetaLocal, pendientes, paraSubir, colgados, mudar, mismoMerge, unoPorMerge, constancia, juntar };

if (require.main === module) {
  const [orden, ...resto] = process.argv.slice(2);
  const arg = (n) => { const i = resto.indexOf(n); return i >= 0 ? resto[i + 1] : undefined; };
  const desde = arg('--from'); const hacia = arg('--to'); const resultado = arg('--result');
  if (orden !== 'juntar' || !desde || !hacia || !resultado) {
    process.stderr.write('uso: merge-metrics.js juntar --from <dir> --to <dir> --result <bajada.json>\n');
    process.exit(2);
  }
  try {
    const c = juntar({ desde, hacia, resultado });
    process.stdout.write(`merges: ${c.juntados} juntado(s), ${c.repetidos} repetido(s), ${c.invalidos} inválido(s) · bajada ${c.estado}${c.completo ? ', completa' : ', INCOMPLETA: el tablero y las métricas dicen «no medido»'}\n`);
  } catch (e) {
    process.stderr.write(`merge-metrics: no pude juntar los merges en ${hacia} (${e.code || e.message})\n`);
    process.exit(1);
  }
}
