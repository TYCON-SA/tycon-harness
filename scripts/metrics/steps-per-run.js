#!/usr/bin/env node
/**
 * steps-per-run.js — cuántos PASOS da una corrida del pipeline, que es lo que determina su costo.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 * Medido sobre **146 corridas** del buzón del equipo: el consumo de una corrida lo
 * explica **enteramente** la cantidad de pasos que da — correlación **0,99** — y el **98,9 %** de
 * esos tokens son **relecturas del contexto acumulado** (`cache_read`), no contenido nuevo.
 *
 *   corridas cortas (226 pasos)  →   95 M tokens
 *   corridas medianas (344)      →  174 M
 *   corridas largas (520)        →  281 M
 *
 * La consecuencia incómoda: todas las palancas de ahorro de septiembre —respuestas breves, cargar
 * menos al arrancar, la retro sin modelo— pelean por el **1,1 %** que NO son relecturas. Y se nota:
 * el consumo por corrida casi no se movió (173,9 M antes de esas palancas · 175,8 M después).
 *
 * Por eso este medidor no publica tokens: publica **pasos**. Es la única variable sobre la que una
 * palanca puede mostrar efecto, y ninguna otra pieza la mira.
 *
 * ── LO QUE NO HACE, A PROPÓSITO ──────────────────────────────────────────────────────────────
 * No propone un tope ni frena nada. Primero la línea base, después —si alguna palanca la mueve— se
 * discute un umbral. Poner un número antes de tener la serie es exactamente la estimación disfrazada
 * que esta misma medición existe para desarmar.
 *
 * ── LA LÍNEA BASE, Y DE QUÉ FECHA ES ─────────────────────────────────────────────────────────
 * Medida sobre el buzón del equipo (su fecha está en `LINEA_BASE`): mediana **345** pasos por corrida (p25 259 ·
 * p75 454 · rango 61–2274), **146** corridas con consumo medido y **170** sin medir, que se declaran
 * y no se estiman. Es el número contra el que se compara cualquier palanca de ahorro de ahí en más.
 * Vive en `LINEA_BASE`, más abajo, y el tablero la toma DE AHÍ: tipeada en una página envejece sin que
 * nadie lo note. Si algún día se vuelve a fijar, se cambia acá —constante y cabecera juntas— con su
 * fecha nueva, y la vieja queda en el historial de git, no en un comentario.
 *
 * ── DÓNDE SE VE ──────────────────────────────────────────────────────────────────────────────
 * Un medidor que hay que acordarse de correr es un medidor que no corre. Este número sale en el
 * tablero de seis preguntas (`scripts/nightly/dashboard/dashboard.js` → `pasosPorCorrida()`, pregunta 4, al
 * lado de cuánto dura una corrida) y en la vista de corridas (`scripts/nightly/dashboard/runs.js`, pegado a los
 * tokens y recalculado por el filtro). La fuente está declarada en `scripts/nightly/dashboard/sources.json`
 * (`pasos-corrida`): si alguien la saca de la lista, la ficha lo dice en vez de leer igual.
 *
 * ── DE DÓNDE SALE EL DATO ────────────────────────────────────────────────────────────────────
 * De `consumo.respuestas` de cada volcado archivado (lo escribe `tokens-digest.js`):
 * cuántas respuestas dio el modelo en el hilo de esa corrida. Una corrida sin `consumo.estado ==
 * "medido"` NO se cuenta ni se estima: se declara en `sin_medir`. «No pude preguntar» no es «no hay».
 *
 * Uso:
 *   node scripts/metrics/steps-per-run.js                 # resumen legible
 *   node scripts/metrics/steps-per-run.js --json          # para el tablero
 *   node scripts/metrics/steps-per-run.js --mailbox <dir> # otro buzón (los tests usan uno falso)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const BUZON_DEFAULT = path.join(stateDirOf(os.homedir()), 'corridas-buzon');

// La línea base: contra qué se compara la serie. Una sola copia — la cabecera explica de dónde sale.
const LINEA_BASE = Object.freeze({ mediana: 345, p25: 259, p75: 454, corridas: 146, sin_medir: 170, fecha: '2026-09-20' });

// 🔴 Una carpeta que no se puede leer NO es una carpeta vacía: se anota en `malas` (con el CÓDIGO del error, nunca
//    su mensaje, que trae la ruta). Devolver lo acumulado y seguir haría que una máquina sin
//    permiso de lectura desaparezca de la mediana «del equipo» sin dejar rastro.
// 🔴 Un ENLACE no es ni archivo ni carpeta para el Dirent (`isDirectory()` da false): se decide con statSync, que lo
//    sigue — igual que `leerRegistro()` de runs.js sobre esta misma carpeta. Sin esto, una carpeta de máquina
//    enlazada se saltearía entera. Un enlace roto se CUENTA como carpeta ilegible: no
//    se sabe qué había. `vistas` (rutas reales) corta un enlace que vuelve sobre el propio buzón: ni cuelga ni duplica.
function caminar(dir, out, malas, vistas = new Set()) {
  let real;
  try { real = fs.realpathSync(dir); } catch (err) { malas.push({ dir, codigo: String((err && err.code) || 'ilegible') }); return out; }
  if (vistas.has(real)) return out;
  vistas.add(real);
  let e = [];
  try { e = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (err) { malas.push({ dir, codigo: String((err && err.code) || 'ilegible') }); return out; }
  for (const it of e) {
    const p = path.join(dir, it.name);
    let esCarpeta = it.isDirectory(), esArchivo = it.isFile();
    if (it.isSymbolicLink()) {
      try { const st = fs.statSync(p); esCarpeta = st.isDirectory(); esArchivo = st.isFile(); }
      catch (err) { malas.push({ dir: p, codigo: String((err && err.code) || 'ilegible') }); continue; }
    }
    // `<maquina>/registros/` nunca trae volcados, y su place.json trae el correo de git de la persona: no se abre
    if (esCarpeta) { if (it.name !== 'registros') caminar(p, out, malas, vistas); }
    else if (esArchivo && it.name.endsWith('.json')) out.push(p);
  }
  return out;
}

function percentil(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/**
 * Devuelve { corridas, sin_medir, ilegibles, carpetas_ilegibles, legible, motivo_ilegible,
 *            pasos:{mediana,p25,p75,min,max}, por_mes:[...], filas:[...] }.
 *   · `legible: false` → la carpeta del buzón ni se pudo listar (`motivo_ilegible` = código del error): NO es un buzón vacío.
 *   · `carpetas_ilegibles` → subcarpetas (de máquina) que no se pudieron leer: sus corridas faltan, no son cero.
 *   · `ilegibles` → archivos .json que no se pudieron leer o parsear (una subida cortada): pueden ser corridas,
 *     así que quien publique los tiene que dejar en el denominador. Un JSON sano SIN `marker` (por ejemplo el
 *     `cobertura.json` que cada máquina sube al lado) no es un volcado: no cuenta como nada.
 */
function medir(opts) {
  const o = opts || {};
  const buzon = o.buzon || BUZON_DEFAULT;
  const filas = [];
  const malas = [];
  let sinMedir = 0;
  let ilegibles = 0;
  // Una máquina vuelve a subir lo de su disco a su carpeta nueva `<nombre>-<código>`, así que la
  // misma corrida puede estar en la carpeta vieja y en la nueva: cuenta UNA vez (la sesión; sin sesión, el archivo y su fecha).
  // Entre una copia sin medir y una medida de la misma corrida, vale la medida.
  const vistas = new Map();   // clave → 'medida' | 'sin'
  for (const f of caminar(buzon, [], malas)) {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_e) { ilegibles++; continue; }
    if (!d || typeof d !== 'object' || !d.marker) continue;
    const clave = typeof d.marker.sessionId === 'string' && d.marker.sessionId ? `s:${d.marker.sessionId}` : `a:${path.basename(f)}|${d.archivedAt || ''}`;
    if (vistas.get(clave) === 'medida') continue;
    const m = d.marker, c = d.consumo || {};
    // «Medida» es un ENTERO POSITIVO, el mismo criterio que el cliente de runs.js (`pasosMedidos`). Con
    // `if (!pasos)` pasaría un negativo (en JS es «verdadero»), un texto o un decimal: un volcado
    // con un valor absurdo entraría a la mediana y a la línea base como si fuera un dato.
    const pasos = c.estado === 'medido' && Number.isInteger(c.respuestas) && c.respuestas > 0 ? c.respuestas : null;
    if (pasos === null) { if (!vistas.has(clave)) { vistas.set(clave, 'sin'); sinMedir++; } continue; }
    if (vistas.get(clave) === 'sin') sinMedir--;
    vistas.set(clave, 'medida');
    const t = c.tokens || {};
    const tokens = (t.in || 0) + (t.out || 0) + (t.cache_new || 0) + (t.cache_read || 0);
    filas.push({
      story: String(m.storyId || ''),
      repo: path.basename(String(m.repoPath || '')),
      inicio: String(m.startedAt || d.archivedAt || '').slice(0, 10),
      pasos,
      tokens: tokens || null,
    });
  }
  filas.sort((a, b) => a.inicio.localeCompare(b.inicio));

  const v = filas.map((x) => x.pasos);
  const meses = new Map();
  for (const x of filas) {
    const k = x.inicio.slice(0, 7);
    if (!meses.has(k)) meses.set(k, []);
    meses.get(k).push(x.pasos);
  }

  const raiz = malas.find((m) => m.dir === buzon) || null;
  return {
    buzon,
    corridas: filas.length,
    // Una corrida sin consumo medido no se estima ni se promedia: se cuenta aparte.
    sin_medir: sinMedir,
    // Y lo que no se pudo LEER tampoco desaparece: se cuenta, y quien publica decide si calla el número.
    ilegibles,
    carpetas_ilegibles: malas.filter((m) => m.dir !== buzon).length,
    legible: !raiz,
    motivo_ilegible: raiz ? raiz.codigo : null,
    pasos: {
      mediana: percentil(v, 0.5),
      p25: percentil(v, 0.25),
      p75: percentil(v, 0.75),
      min: v.length ? Math.min(...v) : null,
      max: v.length ? Math.max(...v) : null,
    },
    por_mes: [...meses.entries()].sort().map(([mes, xs]) => ({ mes, n: xs.length, mediana: percentil(xs, 0.5) })),
    filas,
  };
}

function resumen(r) {
  const L = [];
  const p = r.pasos;
  L.push(`Pasos por ejecución — ${r.corridas} ejecución(es) con consumo medido` + (r.sin_medir ? ` · ${r.sin_medir} sin medir (no se estiman)` : ''));
  if (r.legible === false) L.push(`🔴 La carpeta del buzón no se pudo leer (${r.motivo_ilegible}): no es un buzón vacío.`);
  if (r.carpetas_ilegibles) L.push(`🔴 ${r.carpetas_ilegibles} carpeta(s) del buzón no se pudieron leer: sus ejecuciones FALTAN en este número, no son cero.`);
  if (r.ilegibles) L.push(`🔴 ${r.ilegibles} volcado(s) no se pudieron leer (¿subida cortada?): no están en la mediana.`);
  if (!r.corridas) { L.push('🔴 Ninguna ejecución con consumo medido: no hay línea base que publicar.'); return L.join('\n'); }
  L.push(`  mediana ${Math.round(p.mediana)} · p25 ${Math.round(p.p25)} · p75 ${Math.round(p.p75)} · rango ${p.min}–${p.max}`);
  L.push('');
  L.push('  mes      ejecuciones   mediana');
  for (const m of r.por_mes) L.push(`  ${m.mes}     ${String(m.n).padStart(5)}   ${String(Math.round(m.mediana)).padStart(7)}`);
  L.push('');
  L.push('  🔴 El consumo de una ejecución lo explica la cantidad de pasos (correlación 0,99 sobre 146');
  L.push('     ejecuciones, 2026-09-20) y el 98,9 % son relecturas del contexto. Este número es la palanca;');
  L.push('     los tokens son su consecuencia.');
  return L.join('\n');
}

module.exports = { medir, resumen, LINEA_BASE, BUZON_DEFAULT };

if (require.main === module) {
  require('../lib/legacy-names.js').aliasArgv('scripts/metrics/steps-per-run.js');
  const argv = process.argv.slice(2);
  const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const r = medir({ buzon: flag('--mailbox') });
  process.stdout.write(argv.includes('--json') ? JSON.stringify(r, null, 2) + '\n' : resumen(r) + '\n');
}
