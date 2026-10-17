#!/usr/bin/env node
'use strict';
/**
 * evidence-key.js — la CLAVE con que se nombra la evidencia de cierre de una story (story 1.17).
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────
 * La evidencia de `.advisors/dod-runtime/` se nombraba con el número de la story y nada más
 * (`<id>-smoke-ledger.jsonl`, `<id>-runtime-matrix.md`, `<id>-e2e-gate-<ts>.md`…). Eso supone que el
 * número identifica UNA story en el repo, y en dos repos del equipo no es así: numeran por tema y cada
 * tema arranca en 1.1. La matriz de verificación por criterio contó un criterio como CORRIDO con el
 * registro de OTRA story del mismo número (2026-10-05, guides/maintaining/incident-log.md#evidencia-pisada-entre-stories-2026-10-05).
 * Medido ese día: 35 de 88 evidencias de un repo y 20 de 79 de otro bajo un número compartido.
 *
 * ── LA REGLA ─────────────────────────────────────────────────────────────────────────────────────
 * - Número ÚNICO en el repo de la story → la clave es el número solo, como siempre. Así no cambia nada
 *   en el arnés ni en ningún repo que ya numera bien.
 * - Número REPETIDO → `<tema>__<número>`. El tema es la carpeta de la story, o la de arriba si esa
 *   carpeta se llama `stories` (`.specs/cobranza-deudor/stories/x.md` → `cobranza-deudor`;
 *   `docs/voz/epic-05/x.md` → `epic-05`). Si dos stories del mismo número comparten además el tema (aunque sea en
 *   áreas distintas, o sólo por mayúsculas), esas usan la ruta del archivo: `+p+docs~voz~epic-05~1-1-x`
 *   (`labelsForGroup`). `__` porque no aparece en ningún nombre de carpeta del equipo y se lee al abrir la carpeta
 *   (nada de hashes: la clave la lee una persona). Lo que no es letra sin tilde, número, punto o guion se escribe
 *   `+<hex>+` (`clean`): dos nombres distintos nunca dan la misma clave.
 *
 * Por qué NO «la carpeta que contiene `stories/` es el tema»: medido el mismo día, un repo con 178
 * stories en carpetas `stories/` y números únicos tenía 106 evidencias que esa regla dejaba huérfanas
 * sin motivo, y otro repo con números repetidos no usa carpetas `stories/`, así que no lo arreglaba.
 *
 * El costo, dicho: cuando un número único se repite (alguien crea la 1.1 de un tema nuevo), la story
 * vieja cambia de clave y su evidencia anterior pasa a huérfana. Es lo correcto: desde ese momento esa
 * evidencia es ambigua. `legacyFiles()` la nombra; nadie la borra.
 *
 * ── RECORRIDO COMPLETO O NADA ────────────────────────────────────────────────────────────────────
 * Saber si el número se repite exige ver TODAS las stories del repo. Se usa el descubridor del arnés
 * (`story-discovery.js`) SIN caché —una story creada hace un minuto tiene que contar ya— y con un tope
 * amplio. Si el recorrido sale incompleto se LANZA (`code: 'RECORRIDO_INCOMPLETO'`): devolver el número
 * solo «por las dudas» es exactamente la mentira que esta story cierra.
 *
 * La evidencia puede vivir en un repo distinto al de la story (un backend con la evidencia de stories
 * de un repo de proyecto): por eso la clave sale SIEMPRE de la ruta de la story, nunca de la carpeta de
 * evidencia.
 *
 * CLI: `node evidence-key.js <story.md>` imprime la clave (exit 0) o el motivo por el que no puede
 * decidirla (exit 2). `pipeline.js evidence-key --story <ruta>` es el mismo cálculo.
 */

const fs = require('fs');
const path = require('path');
const discovery = require(path.join(__dirname, 'story-discovery.js'));

// Tope del recorrido. El repo más grande del equipo se recorre en ~330 ms; esto es un techo, no un
// costo. La variable existe para la prueba del recorrido incompleto y para un repo enorme.
const BUDGET_MS = (() => {
  const v = parseInt(process.env.TYCON_EVIDENCE_KEY_BUDGET_MS || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 15000;
})();

/** El número de la story: `story:` del frontmatter, con respaldo al nombre del archivo. */
function storyIdFrom(fm, storyPath) {
  // IDs alfanuméricos también: hay repos con 'R-9'/'O-3' (fix 2026-07-10 — el patrón numérico-only
  // [\d.]+ no matcheaba y el sid degradaba al basename completo → ledger de smoke-run.sh
  // (registrado con el story: del frontmatter) quedaba invisible para la matriz).
  const m = String(fm || '').match(/^story:\s*["']?([A-Za-z0-9][\w.-]*)/m);
  if (m) return m[1];
  const base = path.basename(storyPath, '.md');
  const bm = base.match(/^(\d+)-(\d+(?:-\d+)?)/);
  if (bm) return `${bm[1]}.${bm[2].replace(/-/g, '.')}`;
  return base;
}

function frontmatterOf(storyPath) {
  const content = fs.readFileSync(storyPath, 'utf8');
  const m = content.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}

// Un nombre de carpeta pasado a algo que sirve en un nombre de archivo, SIN PERDER información: letras sin tilde,
// números, punto y guion quedan como están; todo lo demás (tildes, espacios, guion bajo, `+`) se escribe `+<hex>+`
// con su código. Como `+` nunca queda suelto, dos nombres distintos nunca dan el mismo (pase adversarial de la 1.17:
// con el saneo anterior, `gestión` y `gestiòn` daban los dos `gesti-n` y compartían la evidencia).
function clean(s) {
  let out = '';
  for (const ch of String(s)) out += /^[A-Za-z0-9.-]$/.test(ch) ? ch : `+${ch.codePointAt(0).toString(16)}+`; // `~` también: lo usa labelsForGroup
  return out || '+0+';
}

/** El tema de una story: su carpeta, o la de arriba si su carpeta se llama `stories`. */
function topicOf(storyPath) {
  let dir = path.dirname(path.resolve(storyPath));
  if (path.basename(dir).toLowerCase() === 'stories') dir = path.dirname(dir);
  return clean(path.basename(dir));
}

/**
 * La etiqueta de cada story de un GRUPO (todas las del repo con el mismo número). Regla:
 * - el tema (`topicOf`), si ninguna otra del grupo tiene el mismo —ignorando mayúsculas: en Windows y en Mac
 *   `Foo__1.1-…` y `foo__1.1-…` son el mismo archivo—;
 * - si dos o más lo comparten, esas usan la ruta del archivo dentro del repo (sin `.md`, las carpetas unidas con `~`),
 *   con el prefijo `+p+`: `+p+docs~voz~epic-05~1-1-x`.
 * Por qué así (pase adversarial de la 1.17): el desempate anterior, `<tema>-<archivo>`, podía dar justo el nombre de
 * otro tema (`foo` + `bar` = `foo-bar`) o repetirse entre dos áreas con la misma carpeta (`voz/epic-05` y
 * `mensajes/epic-05`). La ruta es única por definición; `clean` no pierde nada; y `+p+` no lo produce `clean`
 * (`p` no es un dígito hexadecimal), así que una etiqueta por ruta nunca coincide con una por tema.
 */
function labelsForGroup(paths, repoRoot) {
  const temas = new Map(paths.map((p) => [p, topicOf(p)]));
  const cuenta = new Map();
  for (const t of temas.values()) cuenta.set(t.toLowerCase(), (cuenta.get(t.toLowerCase()) || 0) + 1);
  const out = new Map();
  for (const p of paths) {
    const t = temas.get(p);
    if (cuenta.get(t.toLowerCase()) === 1) { out.set(p, t); continue; }
    // Cada carpeta saneada y unidas con `~`, que `clean` nunca deja suelto: sigue sin ambigüedad y se lee.
    const rel = path.relative(repoRoot || path.dirname(p), p).replace(/\.md$/i, '').split(path.sep);
    out.set(p, `+p+${rel.map(clean).join('~')}`);
  }
  return out;
}

class EvidenceKeyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * La clave de la evidencia de una story.
 * `storyPath` es la ruta REAL de la story (de ahí salen el repo, las hermanas y el tema): quien computa sobre una
 * copia —el freno del commit lee el contenido staged desde un temporal— pasa la real y, si hace falta, `opts.id`.
 * Sin repo git no hay hermanas que mirar: la clave es el número (`noRepo: true`); recorrer la carpeta de un
 * archivo suelto —un temporal— recorrería la carpeta temporal entera de la máquina.
 * @returns {{ key, id, topic, repeated, siblings: string[], repoRoot, noRepo? }}
 * @throws EvidenceKeyError — RECORRIDO_INCOMPLETO / STORY_ILEGIBLE
 */
// La ruta como la guarda el disco. En Mac y Windows la misma story se puede nombrar con otras mayúsculas o con la
// tilde en otra forma Unicode (Git en Mac la da compuesta, el disco la guarda descompuesta): sin esto la story se
// contaba como su propia hermana y el tema salía distinto según quién preguntara (pase adversarial de la 1.17.1).
function canonica(p) {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

function evidenceKey(storyPath, opts = {}) {
  const abs = canonica(path.resolve(storyPath));
  let id = opts.id;
  if (!id) {
    let fm;
    try { fm = frontmatterOf(abs); } catch (e) {
      throw new EvidenceKeyError('STORY_ILEGIBLE', `no pude leer la story ${abs}: ${e.message}`);
    }
    id = storyIdFrom(fm, abs);
  }
  const repoRoot = discovery.findRepoRoot(abs);
  if (!repoRoot) return { key: id, id, topic: null, repeated: false, siblings: [], repoRoot: null, noRepo: true };
  const d = discovery.discoverStories(repoRoot, { cache: false, budgetMs: opts.budgetMs ?? BUDGET_MS });
  if (d.partial) {
    throw new EvidenceKeyError('RECORRIDO_INCOMPLETO',
      `no pude recorrer todas las stories de ${repoRoot} (tope ${opts.budgetMs ?? BUDGET_MS} ms) para saber si el número ${id} se repite. ` +
      'Sin eso no hay clave: elegir una a ciegas puede mezclar la evidencia de dos stories. ' +
      'Subí el tope con TYCON_EVIDENCE_KEY_BUDGET_MS y volvé a correr.');
  }
  // Las hermanas salen de las stories Y de lo que el descubridor apartó por la forma del id: un repo que numera
  // `R-9`/`O-3` sin declarar su forma en `.tycon/advisors.yaml` tiene sus stories en `excluded`, y sin esto
  // dos `R-9` de temas distintos se veían únicas (pase adversarial de la 1.17). Contar de más sólo agrega el tema.
  const siblings = [...d.stories, ...(d.excluded || [])].filter((s) => s && s.path && String(s.id) === String(id))
    .map((s) => canonica(path.resolve(s.path))).filter((p) => p !== abs);
  return { ...keyWithSiblings(abs, id, siblings, repoRoot), repoRoot };
}

/** La regla, pura: la clave de una story dado su número y las OTRAS stories del repo con ese número. */
function keyWithSiblings(abs, id, siblings, repoRoot) {
  if (!siblings.length) return { key: id, id, topic: null, repeated: false, siblings };
  const topic = labelsForGroup([abs, ...siblings], repoRoot).get(abs);
  return { key: `${topic}__${id}`, id, topic, folder: topicOf(abs), repeated: true, siblings };
}

/**
 * Las claves de TODAS las stories de un repo de una vez, para quien ya tiene la lista completa (el medidor
 * nocturno): misma regla que `evidenceKey`, sin recorrer el repo una vez por story.
 * @param {{path: string, id: string}[]} stories — la lista COMPLETA del repo (si falta una, la regla miente)
 * @returns {Map<string, string>} ruta absoluta → clave
 */
function keysForStories(stories, repoRoot) {
  const porId = new Map();
  for (const s of stories) {
    const k = String(s.id);
    if (!porId.has(k)) porId.set(k, []);
    porId.get(k).push(path.resolve(s.path));
  }
  const out = new Map();
  for (const [id, rutas] of porId) {
    const raiz = repoRoot || discovery.findRepoRoot(rutas[0]);
    for (const r of rutas) out.set(r, keyWithSiblings(r, id, rutas.filter((x) => x !== r), raiz).key);
  }
  return out;
}

/**
 * La clave, o `fallback` si no se puede calcular — para los lectores que tienen que seguir andando.
 * Devuelve `{ key, error }`: el que llama decide si un `error` lo frena o lo avisa.
 */
function keyOr(storyPath, fallback) {
  if (!storyPath) return { key: fallback, error: null };
  try { return { key: evidenceKey(storyPath).key, error: null }; } catch (e) {
    return { key: null, error: e.message };
  }
}

/**
 * La evidencia VIEJA de una story de número repetido: archivos `<id>-*` en las carpetas de evidencia.
 * No cuentan para ninguna story (pertenecer ahora es explícito y estos no dicen a cuál) y NO se tocan.
 * `handRenamed`: los que alguien ya renombró con el tema de ESTA story: el tema entero (`1.1-cobranza-deudor-*`), o
 * su primera palabra (`1.1-cobranza-*` para `cobranza-deudor`) sólo si ninguna hermana tiene un tema que empiece igual —
 * con `cobranza-deudor` y `cobranza-acreedor` como hermanas, `1.1-cobranza-*` no se sabe de cuál es y queda huérfana.
 * Con número único (clave = id) no hay nada viejo: devuelve listas vacías.
 */
function legacyFiles(evidenceDirs, info) {
  const out = { unowned: [], handRenamed: [] };
  if (!info || !info.repeated) return out;
  const prefijo = `${info.id}-`;
  const tema = info.folder || '';
  const tramo = tema.split('-')[0];
  const tramoAmbiguo = (info.siblings || []).some((h) => topicOf(h).split('-')[0] === tramo);
  for (const dir of evidenceDirs || []) {
    let entradas = [];
    try { entradas = fs.readdirSync(dir); } catch { continue; }
    for (const f of entradas.sort()) {
      if (!f.startsWith(prefijo)) continue;
      const resto = f.slice(prefijo.length);
      const full = path.join(dir, f);
      if (tema && resto.startsWith(`${tema}-`)) out.handRenamed.push(full);
      else if (tramo && !tramoAmbiguo && resto.startsWith(`${tramo}-`)) out.handRenamed.push(full);
      else out.unowned.push(full);
    }
  }
  return out;
}

/**
 * La misma regla, aplicada a lo demás que el arnés nombra por story (story 1.17.1): la carpeta de corrida
 * (`.advisors/pipeline-runs/<clave>-<sello>/`), la guía del tester (`qa/<clave>-pasos.md`) y las aprobaciones de la
 * matriz (`story: <clave>`). No es otra regla: es la clave de arriba más la forma de reconocer un nombre.
 */

/** ¿El nombre `name` es de la story de clave `key`? Exacto o `<clave>-…`; con número único también `story-<id>-…`, que ya se aceptaba. */
function ownsName(name, key, id) {
  const n = String(name);
  if (n === key || n.startsWith(`${key}-`)) return true;
  return key === id && n.startsWith(`story-${id}-`);
}

/**
 * La clave con todo lo que hace falta para nombrar y para avisar: `{ key, info, error }`. Sin ruta de story (quien
 * sólo tiene el número) la clave es el número, como siempre. Con ruta y sin poder calcularla, `key: null` y el
 * motivo: el que llama decide si eso frena o avisa, pero nunca elige un nombre a ciegas.
 */
// Un número de story que sirve para nombrar una carpeta o un archivo: la misma forma que reconoce `storyIdFrom`, sin
// `..`. El `story:` del frontmatter llegaba tal cual a `mkdirSync`: con `story: "../../x"` la carpeta de corrida se
// creaba fuera de `pipeline-runs/` (pase de seguridad de la 1.17.1; la causa es anterior, la 1.17.1 la usaba en más lados).
const ID_NOMBRABLE = /^[A-Za-z0-9][\w.-]*$/;
function idNombrable(id) { return ID_NOMBRABLE.test(String(id)) && !String(id).includes('..'); }

function keyInfoOr(storyPath, id) {
  if (id != null && !idNombrable(id)) {
    return { key: null, info: null, error: `el número de story ${JSON.stringify(String(id))} no sirve para nombrar archivos (sólo letras, números, punto, guion y guion bajo, sin «..»)` };
  }
  if (!storyPath) return { key: id, info: null, error: null };
  try {
    const info = evidenceKey(storyPath, id ? { id } : {});
    return { key: info.key, info, error: null };
  } catch (e) {
    return { key: null, info: null, error: e.message };
  }
}

/**
 * El prefijo con que se busca la evidencia de una story (`<clave>-`), con el motivo cuando no se puede: `{ prefix, error }`.
 * Una sola regla para el portón de Azure y el freno del frontmatter (story 1.17.1, tanda 2): cada uno tenía la suya, y
 * el freno caía al número solo si la story no estaba en disco — justo el chequeo que la tanda 1 cerró en el portón.
 * - sin ruta (quien sólo tiene el número): el número, como siempre;
 * - con ruta y sin archivo (un Write que crea la story): null — sin la story no se sabe si el número se repite;
 * - sin clave calculable: null y el motivo. `null` nunca es «no hay evidencia»: es «no la puedo buscar», y se dice.
 */
function evidencePrefix(storyPath, id) {
  if (!storyPath) return { prefix: `${id}-`, error: null };
  if (!fs.existsSync(storyPath)) {
    return { prefix: null, error: `no encuentro la story ${storyPath} — sin ella no sé si el número ${id} se repite` };
  }
  const k = keyInfoOr(storyPath, id);
  return k.key ? { prefix: `${k.key}-`, error: null }
    : { prefix: null, error: `no pude calcular la clave de la evidencia de ${id} (${storyPath}): ${k.error}` };
}

module.exports = { evidenceKey, keyOr, keyInfoOr, evidencePrefix, ownsName, keysForStories, legacyFiles, storyIdFrom, topicOf, EvidenceKeyError };

if (require.main === module) {
  const ruta = process.argv[2];
  if (!ruta) { console.error('uso: evidence-key.js <story.md>'); process.exit(2); }
  try {
    process.stdout.write(evidenceKey(ruta).key + '\n');
  } catch (e) {
    console.error(`evidence-key: ${e.message}`);
    process.exitCode = 2;
  }
}
