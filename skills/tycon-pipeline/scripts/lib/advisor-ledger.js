'use strict';

/**
 * advisor-ledger.js — el registro de corridas de revisores, legible y DURABLE.
 *
 * ── POR QUÉ EXISTE (auditoría 2026-08-25, Tema 2 del plan de controles apagables) ───────────────
 * No se podía contestar mecánicamente **"¿corrieron los revisores automáticos de la story X?"**.
 * Había dos registros y a los dos les faltaba algo:
 *
 *   1. `gates.log` (`check=advisors`) — el registro VOLUNTARIO: sólo se escribe si alguien tipea el
 *      comando que lo escribe. Medido: 149 entradas históricas, **142 sin repo atribuido**. Y como
 *      no hay diferencia entre "no corrieron" y "corrieron sin registrarse", **el silencio se lee
 *      como incumplimiento**.
 *   2. `advisor-runs/<sid>.jsonl` — el registro AUTOMÁTICO (lo escribe el hook `on-advisor-run.js`
 *      en cada spawn REAL, no hay forma de saltearlo sin desinstalar el hook). Tenía el dato de que
 *      corrieron, pero **sin repo, sin story, y se borraba solo a los 7 días**: 756 líneas medidas,
 *      CERO con repo.
 *
 * O sea: el registro confiable no servía para preguntar, y el que servía para preguntar no era
 * confiable. Este módulo cierra las dos mitades sobre el registro automático:
 *   · el hook estampa `repo` y `story` en cada línea (ver lib/repo-attrib.js);
 *   · antes de que la limpieza de 7 días borre un archivo, acá se vuelca un **resumen durable**
 *     que no se borra nunca (`advisor-runs-summary.jsonl`);
 *   · `pipeline.js advisor-runs` lee las dos capas y contesta la pregunta.
 *
 * 🔴 **Escribe, no bloquea — a propósito.** La lección del 2026-08-25 (un hook bloqueante revertido
 * tras dos bloqueos equivocados en cinco minutos) manda: un control que no interrumpe a nadie no se
 * apaga por molesto, y por eso sigue estando cuando importa. **Medir primero, bloquear después —
 * si alguna vez.**
 *
 * ── RETENCIÓN (decisión D2 del dev, 2026-08-25) ────────────────────────────────────────────────
 * Se eligió **resumen durable antes de borrar**, no subir la retención de 7 a 90 días:
 * el volumen medido es ~10 KB/semana (menos de 1 MB al año en resúmenes) y **no toca la lógica que
 * hoy depende de los 7 días** (`check-count` sólo mira la corrida actual).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./state-dir.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
const { execFileSync } = require('child_process');

// Resolución PEREZOSA (mismo motivo que en repo-attrib.js): con las rutas congeladas al cargar el
// módulo, un test no puede aislarse del estado real — o lo ensucia, o se salta sus aserciones sin
// fallar. Las dos cosas pasaron al escribir esta suite.
function stateDir() {
  return path.join(stateDirOf(os.homedir()));
}
function runsDirPath() { return path.join(stateDir(), 'advisor-runs'); }
function summaryPath() { return path.join(stateDir(), 'advisor-runs-summary.jsonl'); }

/** Parsea un jsonl a objetos, ignorando líneas corruptas (nunca tira). */
function parseJsonl(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch (_e) { /* línea corrupta: se ignora */ }
  }
  return out;
}

/**
 * Resumen de UN archivo de sesión. `null` si no hay nada que preservar
 * (archivo vacío o sólo líneas corruptas) — en ese caso borrar no pierde información.
 *
 * @param {string} rawText contenido crudo del `advisor-runs/<sid>.jsonl`
 * @param {string} sessionId
 */
function summarize(rawText, sessionId) {
  const recs = parseJsonl(rawText);
  if (recs.length === 0) return null;

  const advisors = {};
  const repos = new Set();
  const stories = new Set();
  let spawns = 0;
  let rondas = 0;
  let from = null;
  let to = null;

  for (const r of recs) {
    if (r.ts) {
      if (from === null || r.ts < from) from = r.ts;
      if (to === null || r.ts > to) to = r.ts;
    }
    if (r.event === 'step5-start') rondas++;
    if (typeof r.advisor === 'string') {
      spawns++;
      advisors[r.advisor] = (advisors[r.advisor] || 0) + 1;
    }
    if (r.repo) repos.add(r.repo);
    if (r.story) stories.add(String(r.story));
  }

  return {
    ts: new Date().toISOString(),
    sessionId: String(sessionId),
    from,
    to,
    repos: [...repos].sort(),
    stories: [...stories].sort(),
    advisors,
    spawns,
    rondas,
  };
}

/**
 * Vuelca el resumen durable de un archivo de sesión.
 *
 * @returns {boolean} `true` si el archivo se puede borrar sin perder información — o sea, si el
 *   resumen quedó escrito, o si no había nada que resumir. **`false` si el resumen NO se pudo
 *   escribir**: en ese caso el llamador NO debe borrar. La dirección de falla es a propósito —
 *   entre "borrar en silencio" y "juntar unos KB de más hasta la próxima pasada", el arnés elige
 *   no perder la constancia (misma regla que el banco de controles: salir limpio sin constancia
 *   es una falla, no un éxito).
 */
function archive(fullPath, sessionId, destino) {
  let raw;
  try { raw = fs.readFileSync(fullPath, 'utf8'); } catch (_e) { return true; } // ilegible: nada que perder
  const sum = summarize(raw, sessionId);
  if (!sum) return true;
  const dest = destino || summaryPath();
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.appendFileSync(dest, JSON.stringify(sum) + '\n', 'utf8');
    return true;
  } catch (_e) {
    return false;
  }
}

/** Spawns todavía "vivos" (los últimos 7 días), de TODAS las sesiones. */
function readLive(runsDir) {
  const dir = runsDir || runsDirPath();
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch (_e) { return out; }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const sessionId = f.replace(/\.jsonl$/, '');
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_e) { continue; }
    for (const r of parseJsonl(raw)) {
      if (typeof r.advisor !== 'string') continue;
      out.push({
        ts: r.ts || null,
        advisor: r.advisor,
        model: r.model || null,
        repo: r.repo || null,
        story: r.story == null ? null : String(r.story),
        sessionId,
        fuente: 'vivo',
      });
    }
  }
  return out;
}

/** Resúmenes durables (sesiones ya podadas). Deduplicados por sesión + arranque. */
function readSummaries(archivo) {
  const p = archivo || summaryPath();
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch (_e) { return []; }
  const seen = new Set();
  const out = [];
  for (const s of parseJsonl(raw)) {
    // Puede haber duplicado si el borrado falló DESPUÉS de escribir el resumen y la próxima
    // pasada volvió a resumir el mismo archivo. Se dedupe acá, no al escribir: leer el archivo
    // entero en cada poda sería pagar el costo siempre para un caso de borde.
    const key = `${s.sessionId}|${s.from || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...s, fuente: 'archivo' });
  }
  return out;
}

// El `origin` de un directorio, normalizado, o null si no es un repo git (o git no contesta).
// Se cachea por proceso: `query` compara el mismo par de rutas una vez por cada línea del ledger.
const ORIGEN = new Map();
function origenDe(dir) {
  if (ORIGEN.has(dir)) return ORIGEN.get(dir);
  let url = null;
  try {
    url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_e) { url = null; }
  // Misma identidad escrita de varias formas: mayúsculas, `.git` al final, credenciales en la URL.
  const norm = url
    ? url.toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '').replace(/^(https?:\/\/)[^@/]*@/, '$1')
    : null;
  ORIGEN.set(dir, norm);
  return norm;
}

/**
 * ¿Las dos rutas son el MISMO repo?
 *
 * 🔴 La señal es el `origin`, no la ruta ni el nombre de la carpeta (deuda ROSTER-CLON-DESCARTABLE,
 * medida el 2026-09-07 al cerrar la story 2.3): una story implementada en un clon descartable del
 * scratchpad —el patrón que el arnés recomienda cuando hay otras sesiones vivas sobre el checkout—
 * queda estampada en el ledger con la ruta del clon, y la consulta por el repo real devolvía 0
 * revisores. Los 14 spawns estaban ahí, en la misma máquina, invisibles; el portón pedía
 * `sin_testigo` con un motivo que no era el real, y un escape que se usa por rutina deja de
 * significar algo.
 *
 * El basename NO alcanza y tampoco es inofensivo: `Totora/Backend` y `FRESNO/Backend` se llaman
 * igual y son repos distintos. Por eso el orden es: misma ruta → mismo origin → y recién si
 * alguno de los dos no es un repo git (clon ya borrado, ruta de otra máquina) se cae al nombre
 * de la carpeta, que es lo que había antes.
 */
function mismoRepo(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const oa = origenDe(a), ob = origenDe(b);
  if (oa && ob) return oa === ob;
  return path.basename(a) === path.basename(b);
}

/**
 * Contesta la pregunta. Filtra por story y/o repo y/o ventana de días.
 * @param {{story?:string, repo?:string, days?:number, runsDir?:string, summaryPath?:string}} q
 */
function query(q) {
  const opts = q || {};
  const desde = opts.days ? Date.now() - opts.days * 24 * 3600 * 1000 : null;

  let vivos = readLive(opts.runsDir);
  if (opts.story) vivos = vivos.filter((r) => r.story === String(opts.story));
  if (opts.repo) vivos = vivos.filter((r) => mismoRepo(r.repo, opts.repo));
  if (desde) vivos = vivos.filter((r) => r.ts && new Date(r.ts).getTime() >= desde);

  let archivo = readSummaries(opts.summaryPath);
  if (opts.story) archivo = archivo.filter((s) => (s.stories || []).includes(String(opts.story)));
  if (opts.repo) archivo = archivo.filter((s) => (s.repos || []).some((r) => mismoRepo(r, opts.repo)));
  if (desde) archivo = archivo.filter((s) => s.to && new Date(s.to).getTime() >= desde);

  const advisores = {};
  for (const r of vivos) advisores[r.advisor] = (advisores[r.advisor] || 0) + 1;
  for (const s of archivo) {
    for (const [a, n] of Object.entries(s.advisors || {})) advisores[a] = (advisores[a] || 0) + n;
  }

  const sesiones = new Set([...vivos.map((r) => r.sessionId), ...archivo.map((s) => s.sessionId)]);
  const repos = new Set([...vivos.map((r) => r.repo).filter(Boolean),
    ...archivo.flatMap((s) => s.repos || [])]);
  const stories = new Set([...vivos.map((r) => r.story).filter(Boolean),
    ...archivo.flatMap((s) => s.stories || [])]);

  const spawns = vivos.length + archivo.reduce((n, s) => n + (s.spawns || 0), 0);
  const sinAtribuir = vivos.filter((r) => !r.repo).length;

  return {
    spawns,
    sesiones: [...sesiones].sort(),
    repos: [...repos].sort(),
    stories: [...stories].sort(),
    advisores,
    vivos,
    archivo,
    sinAtribuir,
  };
}

module.exports = {
  stateDir, runsDirPath, summaryPath,
  parseJsonl, summarize, archive, readLive, readSummaries, query,
};
