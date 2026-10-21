#!/usr/bin/env node
'use strict';
/**
 * ¿Los formularios compilan sus tipos? `tsc --noEmit` por formulario, con un veredicto que no confunde «no pude
 * mirar» con «está limpio».
 *
 * 🔴 POR QUÉ EXISTE. Los formularios se empaquetan con esbuild, que transpila y NO chequea tipos, y las pruebas
 * tampoco lo cazan. Un repo puede estar en verde en las dos cosas que el pipeline mira y tener el `tsc` rojo: un tipo
 * importado que nunca se declaró pasa el empaquetado y las pruebas sin que nada lo diga.
 *
 * Cuatro veredictos por formulario, y sólo uno es verde:
 *   · LIMPIO       — tsc salió 0 sin ningún `error TS`.
 *   · CON ERRORES  — al menos un `error TS` que no sea un paquete sin instalar. Se cuentan y se nombra el formulario.
 *   · SIN TSCONFIG — no tiene `tsconfig.json`: no chequeado. Un formulario en JavaScript es legítimo, así que avisa y
 *                    no frena en ningún modo; pero nunca sale como limpio.
 *   · NO MEDIDO    — no se pudo chequear: sin `node_modules`, sin typescript, un tsc que termina mal sin un solo
 *                    `error TS` (configuración ilegible), o un paquete que tsc no encuentra (`TS2307` sobre un nombre
 *                    de paquete, no sobre una ruta relativa).
 *
 * 🔴 «NO ENCUENTRO EL PAQUETE X» ES NO MEDIDO, NO UN ERROR DE TIPOS. Un formulario que importa código de otro
 * formulario, chequeado sin las dependencias de ése, cuenta como error cada paquete que tsc no encuentra: pueden ser
 * cientos, y con el otro formulario instalado, ninguno. Por eso, antes de chequear, se
 * instalan los formularios de los que importa cada uno (el mismo grafo de imports que usa affected-forms.js) y la
 * raíz. Un import RELATIVO que no existe sí es un error: es el caso que motivó el control.
 *
 * El modo lo declara quien llama, con su fecha:
 *   · warn  — sale 0 siempre; cada formulario con errores o sin medir es un aviso de Azure con su nombre y su cuenta.
 *             Exige `--review`: un aviso sin fecha no es una decisión. Pasada la fecha, lo dice en cada corrida.
 *   · block — sale 1 si hay CON ERRORES o NO MEDIDO.
 *
 * Uso:
 *   typecheck-forms.js --repo <dir> --forms "<a b c>" --mode warn|block [--review AAAA-MM-DD] [--today AAAA-MM-DD]
 * Sale 0 (sin freno) · 1 (modo block con algo que frena) · 2 (uso inválido: modo desconocido, aviso sin fecha).
 * `TYCON_TYPECHECK_NPM` reemplaza al `npm` que instala (para las pruebas).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    o[k.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return o;
}

const warn = (msg) => process.stdout.write(`##vso[task.logissue type=warning]${msg}\n`);

function loadGraph() {
  try { return require('./affected-forms.js'); } catch (e) {
    warn(`affected-forms.js no cargó (${e && e.message}): no se instalan los formularios importados, y los que importan de otro pueden salir NO MEDIDO`);
    return null;
  }
}

/** Los formularios de los que importa cada uno, en cadena (sin incluirse a sí mismo). */
function importedForms(af, repo, forms) {
  if (!af) return [];
  let g;
  try { g = af.grafo(repo, af.formularios(repo)); } catch (e) {
    warn(`no pude leer los imports entre formularios (${e && e.message}): no se instalan los formularios importados`);
    return [];
  }
  const out = new Set();
  const pending = forms.filter((f) => g[f]);
  while (pending.length) {
    const f = pending.pop();
    for (const d of g[f] || []) if (!out.has(d) && !forms.includes(d)) { out.add(d); pending.push(d); }
  }
  return [...out].sort();
}

/** `npm ci` en la carpeta. `{ ok, why }`: el motivo trae las últimas líneas de npm, para que el aviso diga la causa. */
function install(npm, dir) {
  const r = spawnSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8' });
  if (r.status === 0) return { ok: true };
  if (r.error) return { ok: false, why: r.error.message };
  const tail = `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').slice(-3).join(' · ');
  return { ok: false, why: `npm ci salió ${r.status === null ? `por la señal ${r.signal}` : r.status}${tail ? `: ${tail}` : ''}` };
}

function findTsc(repo, dir) {
  for (const base of [dir, repo]) {
    const p = path.join(base, 'node_modules', '.bin', 'tsc');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * El tsconfig leído como lo acepta tsc: con BOM, comentarios y comas finales. `{ cfg }` o `{ error }`: uno ilegible no
 * puede leerse como «sin referencias», porque un tsconfig de solución chequeado con `-p .` sale limpio sin mirar.
 */
function readTsconfig(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8')
      .replace(/^﻿/, '')
      .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, s) => s || '')
      .replace(/,(\s*[}\]])/g, '$1');
    return { cfg: JSON.parse(txt) };
  } catch (e) { return { error: e.message }; }
}

/**
 * Qué proyectos chequear. Un tsconfig «de solución» (`files: []` y `references`, el que genera la plantilla de Vite)
 * no compila nada con `-p .` y sale 0: hay que chequear cada referencia, o sale limpio sin haber mirado.
 */
function projects(dir, cfg) {
  const refs = cfg && Array.isArray(cfg.references) ? cfg.references.map((r) => r && r.path).filter(Boolean) : [];
  if (!refs.length) return ['.'];
  const own = !(Array.isArray(cfg.files) && cfg.files.length === 0 && !cfg.include);
  const out = own ? ['.'] : [];
  for (const r of refs) {
    const p = path.resolve(dir, r);
    out.push(path.relative(dir, /\.json$/i.test(p) ? p : path.join(p, 'tsconfig.json')) || '.');
  }
  return out;
}

/**
 * ¿El módulo que tsc no encontró es un paquete de npm? Sólo un nombre de paquete (`x`, `x/y`, `@scope/x`) que no sea
 * un alias de `paths` del tsconfig. `@/x`, `~/x` y las rutas son código del formulario: si no resuelven, es un error.
 */
function isPackage(spec, cfg) {
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/.*)?$/i.test(spec)) return false;
  const paths = cfg && cfg.compilerOptions && cfg.compilerOptions.paths;
  if (paths && typeof paths === 'object') {
    for (const k of Object.keys(paths)) {
      const prefix = k.replace(/\*.*$/, '');
      if (k.includes('*') ? spec.startsWith(prefix) : spec === k) return false;
    }
  }
  return true;
}

function check(repo, f, installFailed) {
  const dir = path.join(repo, f);
  if (!fs.existsSync(path.join(dir, 'tsconfig.json'))) return { verdict: 'SIN TSCONFIG', why: 'no chequeado' };
  if (installFailed.has(f)) return { verdict: 'NO MEDIDO', why: 'falló la instalación de un formulario del que importa' };
  if (!fs.existsSync(path.join(dir, 'node_modules'))) return { verdict: 'NO MEDIDO', why: 'sin node_modules (falló la instalación de dependencias)' };
  const tsc = findTsc(repo, dir);
  if (!tsc) return { verdict: 'NO MEDIDO', why: 'typescript no está en sus dependencias ni en la raíz' };
  const root = readTsconfig(path.join(dir, 'tsconfig.json'));
  if (root.error) return { verdict: 'NO MEDIDO', why: `tsconfig.json ilegible (${root.error})` };
  const cfg = root.cfg;
  const missing = new Set();
  let errors = 0;
  let failedClean = null;
  for (const p of projects(dir, cfg)) {
    let pcfg = cfg;
    if (p !== '.') {
      const ref = readTsconfig(path.join(dir, p));
      if (ref.error) return { verdict: 'NO MEDIDO', why: `${p} ilegible (${ref.error})` };
      pcfg = ref.cfg;
    }
    const r = spawnSync(tsc, ['--noEmit', '-p', p], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const lines = `${r.stdout || ''}${r.stderr || ''}`.split('\n').filter((l) => /error TS\d+/.test(l));
    for (const l of lines) {
      const m = l.match(/error TS2307: Cannot find module '([^']+)'/);
      if (m && isPackage(m[1], pcfg)) missing.add(m[1]);
      else errors++;
    }
    if (!lines.length && r.status !== 0 && failedClean === null) failedClean = { project: p, r };
  }
  if (missing.size) return { verdict: 'NO MEDIDO', why: `falta instalar ${[...missing].sort().join(', ')}${errors ? ` (y ${errors} error(es) más, que pueden ser consecuencia)` : ''}` };
  if (errors) return { verdict: 'CON ERRORES', errors };
  if (failedClean) {
    const { r } = failedClean;
    const how = r.error ? `sin poder correr (${r.error.message})` : r.status === null ? `por la señal ${r.signal}` : r.status;
    return { verdict: 'NO MEDIDO', why: `tsc salió ${how}${failedClean.project === '.' ? '' : ` en ${failedClean.project}`} sin un solo error de tipos` };
  }
  return { verdict: 'LIMPIO' };
}

function main(argv) {
  const o = args(argv);
  const mode = o.mode;
  const fail = (msg) => { process.stdout.write(`##vso[task.logissue type=error]${msg}\n`); return 2; };
  if (mode !== 'warn' && mode !== 'block') return fail(`--mode tiene que ser warn o block (llegó «${mode === true ? '' : mode || ''}»)`);
  if (mode === 'warn' && (typeof o.review !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.review))) {
    return fail('modo aviso sin fecha de revisión (--review AAAA-MM-DD): un aviso sin fecha no es una decisión');
  }
  if (typeof o.repo !== 'string') return fail('falta --repo');
  const repo = path.resolve(o.repo);
  const forms = typeof o.forms === 'string' ? o.forms.trim().split(/\s+/).filter(Boolean) : [];
  if (!forms.length) return fail('falta --forms: sin formularios no hay nada que chequear, y eso no es «limpio»');
  const today = typeof o.today === 'string' ? o.today : new Date().toISOString().slice(0, 10);
  const npm = process.env.TYCON_TYPECHECK_NPM || 'npm';
  const af = loadGraph();

  // Lo que el formulario importa tiene que estar instalado, o tsc cuenta como errores los paquetes que no encuentra.
  const installFailed = new Set();
  const needs = [];
  if (fs.existsSync(path.join(repo, 'package-lock.json')) && !fs.existsSync(path.join(repo, 'node_modules'))) needs.push('.');
  for (const d of importedForms(af, repo, forms)) {
    if (!fs.existsSync(path.join(repo, d, 'node_modules')) && fs.existsSync(path.join(repo, d, 'package-lock.json'))) needs.push(d);
  }
  for (const d of needs) {
    const name = d === '.' ? 'la raíz' : d;
    process.stdout.write(`📦 instalo ${name} (lo usa un formulario que se chequea)\n`);
    const r = install(npm, path.join(repo, d));
    if (r.ok) continue;
    warn(`no se pudo instalar ${name} para el chequeo de tipos — ${r.why}`);
    if (d !== '.') installFailed.add(d);
  }
  // Un formulario que importa de uno cuya instalación falló no se puede medir.
  if (af && installFailed.size) {
    for (const f of forms) if (importedForms(af, repo, [f]).some((d) => installFailed.has(d))) installFailed.add(f);
  }

  const level = mode === 'block' ? 'error' : 'warning';
  const counts = { LIMPIO: 0, 'CON ERRORES': 0, 'SIN TSCONFIG': 0, 'NO MEDIDO': 0 };
  let stops = 0;
  for (const f of forms) {
    const r = check(repo, f, installFailed);
    counts[r.verdict]++;
    if (r.verdict === 'LIMPIO') { process.stdout.write(`  ✅ ${f}: LIMPIO\n`); continue; }
    if (r.verdict === 'SIN TSCONFIG') {
      process.stdout.write(`  ⚪ ${f}: SIN TSCONFIG — no chequeado\n`);
      process.stdout.write(`##vso[task.logissue type=warning]${f}: sin tsconfig.json — no chequeado (no es «limpio»)\n`);
      continue;
    }
    stops++;
    if (r.verdict === 'CON ERRORES') {
      process.stdout.write(`  ❌ ${f}: CON ERRORES (${r.errors})\n`);
      process.stdout.write(`##vso[task.logissue type=${level}]${f}: ${r.errors} errores de tipos (tsc --noEmit)\n`);
    } else {
      process.stdout.write(`  ⚠️  ${f}: NO MEDIDO — ${r.why}\n`);
      process.stdout.write(`##vso[task.logissue type=${level}]${f}: chequeo de tipos NO MEDIDO — ${r.why}. No medido no es limpio.\n`);
    }
  }
  process.stdout.write(`\n${forms.length} formulario(s): ${counts.LIMPIO} limpio(s), ${counts['CON ERRORES']} con errores, ${counts['SIN TSCONFIG']} sin tsconfig, ${counts['NO MEDIDO']} sin medir.\n`);
  if (mode === 'warn') {
    if (o.review < today) {
      process.stdout.write(`##vso[task.logissue type=warning]venció la revisión del modo aviso el ${o.review}: decidir si el chequeo de tipos pasa a bloqueante, o renovar la fecha con su motivo\n`);
    }
    if (stops) process.stdout.write(`Modo aviso hasta el ${o.review}: no frena.\n`);
    return 0;
  }
  return stops ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { check, importedForms };
