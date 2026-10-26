#!/usr/bin/env node
// retro-staleness-notice.js — SessionStart hook: avisa si el retrospective capturer
// lleva demasiado sin correr.
//
// POR QUÉ EXISTE: el único trigger del tycon-retrospective-capturer es el step 10b de /tycon-merge-to-main — un paso
// al FINAL del flujo, después del push, cuando el trabajo "ya terminó". Si se saltea, nada lo dice: el único
// mecanismo que detectaba la ausencia del capturer era el capturer mismo.
// Este hook rompe esa circularidad: chequeo independiente en el arranque de sesión.
// Regla que implementa: "un control que hay que acordarse de invocar es un control que no corre".
//
// CÓMO MIDE: fecha de la última corrida = la más nueva entre los archivos del CAPTURER en
// ~/.claude/tycon-harness/.dashboard/ — sólo los `metrics-*.json`, que es lo que escribe, uno por
// corrida. La fecha se saca del NOMBRE del archivo (metrics-YYYY-MM-DD-*.json) — no del mtime,
// porque un clone/pull fresco pisa los mtime y escondería el staleness justo cuando importa.
// Fallback: mtime.
//
// 🔴 POR QUÉ EL PREFIJO: la carpeta es compartida (etapas, vigilante, dependencias, banco) y el nocturno escribe ahí
// `sdlc-stage-<hoy>.json` todos los días. Si se mirara todo `.json`, "la última corrida del capturer" daría siempre
// HOY y el aviso no podría disparar nunca: el mismo modo de falla que este hook existe para cazar, un control apagado
// sin que nada lo diga. Lo que no es del capturer no dice nada sobre el capturer.
//
// RUIDO CONTROLADO: avisa como mucho 1 vez cada 24h por máquina (state file), y solo si
// se cruzó el threshold. Silencio total en el caso sano.
//
// Off: TYCON_RETRO_STALENESS=0 · Threshold: TYCON_RETRO_STALENESS_DAYS (default 7)
// Fail-open total: cualquier error → exit 0 sin output (nunca rompe el arranque).

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

try {
  if (process.env.TYCON_RETRO_STALENESS === '0') process.exit(0);

  const thresholdDays = Number(process.env.TYCON_RETRO_STALENESS_DAYS || 7);
  // El script vive en ~/.claude/tycon-harness/scripts/hooks/ → la raíz del repo es ../../. De qué árbol se leen los
  // .dashboard del nocturno lo decide tycon-home.js (el clon que se mantiene, o ninguno y el aviso calla); si este
  // archivo viaja suelto, éste
  const own = path.resolve(__dirname, '..', '..');
  const homeLib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
  // Los registros de cada merge viven donde dice scripts/lib/night-data.js: la carpeta de estado de la máquina, que el
  // latido alimenta en cada merge (viajen o no por el buzón), y la de la historia, con los de antes. Se miran las dos.
  const nightLib = path.join(__dirname, '..', 'lib', 'night-data.js');
  const machine = fs.existsSync(nightLib) ? require(nightLib).machineDashboard(own) : null;
  // «no pude saber dónde están» no es «no hay»: se dice (callar acá se vería igual que una serie al día)
  if (machine && !machine.dir) { console.log(`⚠️ retro capturer: ${machine.why} — no pude mirar si la serie de retrospectivas está al día`); process.exit(0); }
  if (machine && machine.historyWhy) console.log(`⚠️ retro capturer: ${machine.historyWhy} — la cuenta de abajo sale sin ella`);
  const TH = !machine && fs.existsSync(homeLib) ? require(homeLib) : null;   // sin la biblioteca al lado: el árbol propio
  const tree = machine ? own : (TH ? TH.maintainedDir(os.homedir(), own) : own);
  if (!tree) process.exit(0);
  // en una instalación bajada el .dashboard vive en ~/.tycon/state/dashboard
  const dashboardDirs = machine ? [machine.dir, machine.history].filter(Boolean)
    : [TH && typeof TH.dashboardDir === 'function' ? TH.dashboardDir(os.homedir(), tree) : path.join(tree, '.dashboard')];

  // Sólo lo que escribe el capturer: la carpeta la comparten otros nocturnos (ver cabecera).
  const files = [];
  for (const d of dashboardDirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (/^metrics-.*\.json$/.test(f)) files.push({ f, dir: d });
  }
  if (files.length === 0) process.exit(0);

  let lastRunMs = 0;
  for (const { f, dir: dashboardDir } of files) {
    const m = f.match(/(\d{4})-(\d{2})-(\d{2})/);
    let ts = 0;
    if (m) {
      ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`); // mediodía UTC: evita off-by-one por TZ
    }
    if (!ts) {
      try { ts = fs.statSync(path.join(dashboardDir, f)).mtimeMs; } catch { ts = 0; }
    }
    if (ts > lastRunMs) lastRunMs = ts;
  }
  if (!lastRunMs) process.exit(0);

  const staleDays = Math.floor((Date.now() - lastRunMs) / 86400000);
  if (staleDays <= thresholdDays) process.exit(0);

  // Throttle 24h por máquina.
  const stateFile = path.join(os.homedir(), '.claude', '.tycon-retro-staleness-last-notice');
  try {
    const last = Number(fs.readFileSync(stateFile, 'utf8').trim());
    if (Number.isFinite(last) && Date.now() - last < 86400000) process.exit(0);
  } catch { /* sin state previo → avisar */ }
  try { fs.writeFileSync(stateFile, String(Date.now())); } catch { /* fail-open */ }

  console.log(
    `⚠️ retro capturer: última ejecución hace ${staleDays} días (threshold ${thresholdDays}). ` +
    `Los merges a main de esa ventana pueden haber quedado sin retrospectiva — el trigger es el ` +
    `step 10b de /tycon-merge-to-main y ya se salteó en silencio otras veces. ` +
    `Si hay merges recientes sin retro, correr el capturer sobre ellos (uno por merge, con repo + ` +
    `rango de commits). Off: TYCON_RETRO_STALENESS=0.`
  );
  process.exit(0);
} catch {
  process.exit(0); // fail-open: nunca romper el arranque de sesión
}
