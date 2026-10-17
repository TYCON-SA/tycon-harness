#!/usr/bin/env node
// retro-staleness-notice.js — SessionStart hook: avisa si el retrospective capturer
// lleva demasiado sin correr.
//
// POR QUÉ EXISTE (2026-08-04): el único trigger del tycon-retrospective-capturer es el
// step 10b de /tycon-merge-to-main — un paso al FINAL del flujo, después del push, cuando
// el trabajo "ya terminó". Se salteó en silencio 2 veces: 2026-05-03→06-09 (1 corrida en
// 37 días) y 2026-07-17→08-04 (17 días, 6 merges a main sin retro en backend y frontend de un producto)
// — guides/maintaining/incident-log.md#case-retro-capturer-skipped-2026-08-04.
// El único mecanismo que detectaba la ausencia del capturer era el capturer mismo.
// Este hook rompe esa circularidad: chequeo independiente en el arranque de sesión.
// Regla de la casa que implementa: "un control que hay que acordarse de invocar es un
// control que no corre" (bizuit-bpmn-spec-contract, 2026-08-01).
//
// CÓMO MIDE: fecha de la última corrida = la más nueva entre los archivos del CAPTURER en
// ~/.claude/tycon-harness/.dashboard/ — sólo los `metrics-*.json`, que es lo que escribe, uno por
// corrida. La fecha se saca del NOMBRE del archivo (metrics-YYYY-MM-DD-*.json) — no del mtime,
// porque un clone/pull fresco pisa los mtime y escondería el staleness justo cuando importa.
// Fallback: mtime.
//
// 🔴 POR QUÉ EL PREFIJO (2026-09-05): miraba TODO `.json` de la carpeta. Desde el 2026-08-30 el
// nocturno escribe ahí `sdlc-stage-<hoy>.json` todos los días, así que "la última corrida del
// capturer" daba siempre HOY y el aviso no podía disparar nunca más — ciego seis días, con el
// banco de controles certificándolo en verde porque sus casos sembraban sólo `metrics-*`. El
// mismo modo de falla que este hook existe para cazar: un control apagado sin que nada lo diga.
// La carpeta es compartida (etapas, vigilante, dependencias, banco): lo que no es del capturer
// no dice nada sobre el capturer. Caso: incident-log#aviso-cegado-por-un-vecino-2026-09-05.
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
  // .dashboard del nocturno lo decide tycon-home.js (story 8.23, A2, AC 6: hoy, éste; desde la B, el clon que se
  // mantiene, o ninguno y el aviso calla); si este archivo viaja suelto, éste
  const own = path.resolve(__dirname, '..', '..');
  const homeLib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
  // Desde la story 8.26 (tanda J) los registros de cada merge viven donde dice scripts/lib/night-data.js: en una versión
  // bajada, el clon de mantenimiento que la máquina declara. Sin uno que sirva quedan en la carpeta del estado, que no
  // viaja y trae la copia congelada que dejó la mudanza: ahí este aviso calla (mediría una serie que nadie alimenta).
  const nightLib = path.join(__dirname, '..', 'lib', 'night-data.js');
  const machine = fs.existsSync(nightLib) ? require(nightLib).machineDashboard(own) : null;
  // «no pude saber dónde están» no es «no viajan»: se dice (callar acá se vería igual que una serie al día)
  if (machine && !machine.dir) { console.log(`⚠️ retro capturer: ${machine.why} — no pude mirar si la serie de retrospectivas está al día`); process.exit(0); }
  if (machine && !machine.travels) process.exit(0);
  const TH = !machine && fs.existsSync(homeLib) ? require(homeLib) : null;   // sin la biblioteca nueva al lado: lo de antes
  const tree = machine ? own : (TH ? TH.maintainedDir(os.homedir(), own) : own);
  if (!tree) process.exit(0);
  // en una instalación bajada (story 8.23, tanda D) el .dashboard vive en ~/.tycon/state/dashboard
  const dashboardDir = machine && machine.dir ? machine.dir
    : TH && typeof TH.dashboardDir === 'function' ? TH.dashboardDir(os.homedir(), tree) : path.join(tree, '.dashboard');
  if (!fs.existsSync(dashboardDir)) process.exit(0);

  // Sólo lo que escribe el capturer: la carpeta la comparten otros nocturnos (ver cabecera).
  const files = fs.readdirSync(dashboardDir).filter((f) => /^metrics-.*\.json$/.test(f));
  if (files.length === 0) process.exit(0);

  let lastRunMs = 0;
  for (const f of files) {
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
    `⚠️ retro capturer: última corrida hace ${staleDays} días (threshold ${thresholdDays}). ` +
    `Los merges a main de esa ventana pueden haber quedado sin retrospectiva — el trigger es el ` +
    `step 10b de /tycon-merge-to-main y ya se salteó en silencio otras veces. ` +
    `Si hay merges recientes sin retro, correr el capturer sobre ellos (uno por merge, con repo + ` +
    `rango de commits). Off: TYCON_RETRO_STALENESS=0.`
  );
  process.exit(0);
} catch {
  process.exit(0); // fail-open: nunca romper el arranque de sesión
}
