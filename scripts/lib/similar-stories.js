#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * similar-stories.js — las historias cerradas más parecidas a una nueva, con sus horas reales. Es la base con que el
 * agente propone la estimación de una historia al escribirla; el valor lo decide la persona.
 *
 * POR QUÉ EXISTE: una estimación mejora si se apoya en lo que tardaron historias parecidas, medido con el reloj. El
 * parecido fino lo juzga el modelo leyendo; este guion sólo trae las candidatas medidas, con un puntaje simple que se
 * puede explicar (`PUNTOS`): la misma épica vale más que un tema (`topics`) en común, y un tema más que un archivo
 * declarado o una palabra del título en común. Sólo entran las historias en `done` con horas reales en el registro (`.tycon/estimates.jsonl`) y
 * con algo en común; sin ninguna, la lista sale vacía con su motivo: nunca se inventa una candidata.
 *
 * Uso: node scripts/lib/similar-stories.js --repo <repo de historias> --story <ruta de la historia nueva> [--json]
 * Salidas: 0 listo (también con la lista vacía) · 2 entrada inválida · 3 no se pudo buscar (registro que no se lee,
 * búsqueda de historias incompleta).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DISCOVERY = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-discovery.js');
const E = require(path.join(__dirname, 'estimates.js'));

const MAXIMO = 5;
const PUNTOS = Object.freeze({ epica: 3, topic: 2, archivo: 1, palabra: 1 });
const SIN_CANDIDATAS = 'sin historias cerradas con horas reales';
const SIN_PARECIDAS = 'hay historias cerradas con horas reales; ninguna se parece';
const SIN_FRONTMATTER = 'no pude leer el frontmatter de la historia nueva';
// palabras de cuatro letras o más que no dicen de qué trata una historia
const VACIAS = new Set(['para', 'como', 'desde', 'hasta', 'sobre', 'entre', 'cada', 'todo', 'todos', 'todas', 'esta', 'este', 'estos', 'estas', 'pero', 'cuando', 'donde', 'with', 'from', 'that', 'this', 'into', 'when', 'what']);

class Problema extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

/**
 * El frontmatter de una historia: épica, título, temas y archivos declarados. Se lee como lo escriben las historias de
 * verdad: listas con líneas de comentario y comentarios al final, títulos con comillas o apóstrofos adentro.
 */
function rasgos(texto) {
  // los finales de renglón de Windows, fuera: con `\r` las listas con guiones no se leen
  const limpio = String(texto).replace(/^﻿/, '').replace(/\r/g, '');
  const fin = limpio.startsWith('---') ? limpio.indexOf('\n---', 3) : -1;
  const fm = fin === -1 ? '' : limpio.slice(3, fin);
  const crudo = (k) => {
    const m = fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm'));
    return m ? m[1] : null;
  };
  const epica = escalar(crudo('epic'));
  return {
    legible: fin !== -1,
    epica: epica === '' ? null : epica,
    titulo: escalar(crudo('title')) || '',
    topics: [...new Set(temas(fm))],
    archivos: [...new Set([...lista(fm, 'files_to_create'), ...lista(fm, 'files_to_modify'), ...anidados(fm, 'files')])].sort(),
  };
}
/** Un valor escalar de YAML: entre comillas dobles (con `\"`), simples (con `''`) o suelto (sin el comentario final). */
function escalar(v) {
  if (v === null) return null;
  const s = v.trim();
  if (s.startsWith('"')) {
    const m = s.match(/^"((?:[^"\\]|\\.)*)"/);
    return m ? m[1].replace(/\\(.)/g, '$1') : s.slice(1);
  }
  if (s.startsWith("'")) {
    const m = s.match(/^'((?:[^']|'')*)'/);
    return m ? m[1].replace(/''/g, "'") : s.slice(1);
  }
  return s.replace(/\s+#.*$/, '').trim();
}
/** Los ítems de una lista con guiones bajo `clave:`; las líneas en blanco y de comentario no la cortan. */
function lista(fm, clave) {
  const lineas = fm.split('\n');
  const i = lineas.findIndex((l) => new RegExp(`^${clave}:\\s*(#.*)?$`).test(l));
  if (i === -1) return [];
  const out = [];
  for (const l of lineas.slice(i + 1)) {
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const m = l.match(/^\s+-\s*(.*)$/);
    if (!m) break;
    const v = escalar(m[1]);
    if (v) out.push(v);
  }
  return out;
}
/**
 * Los ítems de las listas que cuelgan de `clave:` (la forma `files:` con `create:` y `modify:` adentro, que el arnés
 * acepta como archivos declarados): todo renglón con guión hasta la próxima clave sin sangría.
 */
function anidados(fm, clave) {
  const lineas = fm.split('\n');
  const i = lineas.findIndex((l) => new RegExp(`^${clave}:\\s*(#.*)?$`).test(l));
  if (i === -1) return [];
  const out = [];
  for (const l of lineas.slice(i + 1)) {
    if (!l.trim() || /^\s*#/.test(l)) continue;
    if (!/^\s/.test(l)) break;
    const m = l.match(/^\s+-\s*(.*)$/);
    const v = m ? escalar(m[1]) : '';
    if (v) out.push(v);
  }
  return out;
}
/** Los temas: `topics: [a, b]` (con o sin comentario al final) o la lista con guiones debajo. */
function temas(fm) {
  const enLinea = fm.match(/^topics:\s*\[([^\]]*)\]/m);
  if (enLinea) return enLinea[1].split(',').map((x) => escalar(x)).filter(Boolean);
  return lista(fm, 'topics');
}
/** Las palabras de un título que dicen algo: minúsculas, sin acentos, de cuatro letras o más. */
function palabras(titulo) {
  const norm = String(titulo).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return [...new Set(norm.split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 4 && !VACIAS.has(w)))];
}
const comunes = (a, b) => [...new Set(a)].filter((x) => b.includes(x)).sort();
function porId(a, b) {
  const pa = String(a).split(/[.-]/).map(Number);
  const pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return String(a).localeCompare(String(b));
}

/**
 * Las parecidas a la historia nueva (`storyPath`) en `repo`. `D` es el buscador de historias (se cambia en las pruebas).
 * Devuelve `{ ok, story, candidatas, motivo, unreadable }`; tira `Problema` si no se puede buscar.
 */
function similar(repo, storyPath, D = require(DISCOVERY)) {
  let texto;
  try { texto = fs.readFileSync(storyPath, 'utf8'); } catch (e) {
    throw new Problema(`no pude leer la historia nueva ${storyPath}: ${(e && e.code) || e}`);
  }
  const nueva = rasgos(texto);
  const nuevaId = D.declaredStoryId(texto);
  // sin frontmatter no hay con qué comparar: decir «no hay parecidas» sería inventar un resultado
  if (!nueva.legible) {
    let ilegibles = [];
    try { ilegibles = E.read(repo).unreadable; } catch (e) { throw new Problema(e.message, 3); }
    return { ok: true, story: nuevaId, candidatas: [], motivo: SIN_FRONTMATTER, unreadable: ilegibles };
  }
  let registro;
  try { registro = E.read(repo); } catch (e) { throw new Problema(e.message, 3); }
  const { lines, unreadable } = registro;
  const reales = new Map();
  for (const l of lines) if (l.nivel === 'real') reales.set(String(l.historia), (reales.get(String(l.historia)) || 0) + l.valor);
  const vacia = { ok: true, story: nuevaId, candidatas: [], motivo: SIN_CANDIDATAS, unreadable };
  if (!reales.size) return vacia;

  const { stories, partial } = D.discoverStories(repo, { cache: false });
  if (partial) throw new Problema(`la búsqueda de historias en ${repo} no terminó (quedó incompleta por su tope de tiempo): no sé cuáles están cerradas; volvé a correrlo o subí TYCON_STORY_SCAN_BUDGET_MS`, 3);
  const misPalabras = palabras(nueva.titulo);
  const candidatas = [];
  let cerradas = 0;
  let sinLeer = 0;
  for (const s of stories) {
    const id = String(s.id);
    if (id === String(nuevaId) || path.resolve(s.path) === path.resolve(storyPath)) continue;
    if (String(s.status).toLowerCase() !== 'done' || !reales.has(id)) continue;
    cerradas++;
    let suya;
    try { suya = rasgos(fs.readFileSync(s.path, 'utf8')); } catch (_) { sinLeer++; continue; }
    const motivos = {
      misma_epica: nueva.epica !== null && suya.epica !== null && String(nueva.epica) === String(suya.epica),
      topics: comunes(suya.topics, nueva.topics),
      archivos: comunes(suya.archivos, nueva.archivos),
      palabras: comunes(palabras(suya.titulo), misPalabras),
    };
    const puntaje = (motivos.misma_epica ? PUNTOS.epica : 0) + motivos.topics.length * PUNTOS.topic
      + motivos.archivos.length * PUNTOS.archivo + motivos.palabras.length * PUNTOS.palabra;
    if (!puntaje) continue;
    const est = E.current(lines, { nivel: 'historia', historia: id });
    candidatas.push({
      id,
      titulo: suya.titulo,
      real_horas: Math.round(reales.get(id) * 100) / 100,
      estimacion: est ? { valor: est.valor, unidad: est.unidad } : null,
      motivos,
      puntaje,
    });
  }
  candidatas.sort((a, b) => b.puntaje - a.puntaje || porId(a.id, b.id));
  if (!candidatas.length) {
    if (sinLeer) return { ...vacia, motivo: `no pude leer ${sinLeer} historia${sinLeer > 1 ? 's' : ''} cerrada${sinLeer > 1 ? 's' : ''} con horas reales; ninguna de las otras se parece` };
    return cerradas ? { ...vacia, motivo: SIN_PARECIDAS } : vacia;
  }
  return { ok: true, story: nuevaId, candidatas: candidatas.slice(0, MAXIMO), motivo: null, unreadable };
}

function opciones(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--repo' || a === '--story') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Problema(`${a} necesita un valor`);
      o[a.slice(2)] = v;
      i++;
    } else throw new Problema(`argumento desconocido: ${a}`);
  }
  if (!o.repo) throw new Problema('falta --repo');
  if (!o.story) throw new Problema('falta --story');
  return o;
}

function texto(r) {
  if (!r.ok) return `similar-stories: ${r.reason}`;
  const ilegibles = r.unreadable && r.unreadable.length ? `\nsimilar-stories: líneas ilegibles: ${r.unreadable.join(', ')}` : '';
  if (!r.candidatas.length) return `similar-stories: ${r.motivo}${ilegibles}`;
  return r.candidatas.map((c) => `${c.id} · ${c.titulo} · ${c.real_horas} h reales · puntaje ${c.puntaje}`).join('\n') + ilegibles;
}

if (require.main === module) {
  const json = process.argv.includes('--json');
  let r;
  let code = 0;
  try {
    const o = opciones(process.argv.slice(2));
    const repo = path.resolve(o.repo);
    if (!fs.existsSync(repo)) throw new Problema(`no existe ${repo}`);
    r = similar(repo, path.resolve(o.story));
  } catch (e) {
    if (!(e instanceof Problema)) throw e;
    r = { ok: false, reason: e.message };
    code = e.code;
  }
  process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : `${texto(r)}\n`);
  process.exitCode = code;
}

module.exports = { similar, rasgos, palabras, PUNTOS, MAXIMO, SIN_CANDIDATAS, SIN_PARECIDAS, SIN_FRONTMATTER };
