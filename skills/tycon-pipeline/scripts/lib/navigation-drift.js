'use strict';

/**
 * navigation-drift.js — el mapa de navegación cambió y las pantallas ya escritas no se
 * volvieron a mirar (FIX-8, caso C7 de la auditoría del 2026-08-25).
 *
 * ── QUÉ SE ROMPE HOY ────────────────────────────────────────────────────────────────────────────
 * `WIRING-C5` compara el layout y la navegación del código contra el documento de arquitectura de
 * información del repo, y funciona en UN SOLO SENTIDO: **código nuevo → se compara contra el
 * documento**. Al revés no. Si el documento cambia, el código ya escrito **no se vuelve a revisar
 * nunca**. La mitigación que existía no cerraba el hueco: sólo se disparaba al CREAR el documento
 * (nunca al editarlo), era un aviso que jamás bloquea, y pedía otra cosa —declarar qué reconcilia—
 * en vez de volver a correr la regla.
 *
 * ── CÓMO SE CIERRA, BARATO ──────────────────────────────────────────────────────────────────────
 * Editar el documento deja una MARCA en `.advisors/`. El cierre de la próxima story de interfaz la
 * lee y avisa. **Cero revisores extra**: la opción cara —seleccionar el revisor de wiring cuando el
 * diff toca el documento— pondría un revisor caro a mirar código que ese commit no tocó, o sea
 * ruido casi garantizado.
 *
 * ── POR QUÉ SE LIMPIA SOLA, Y CON QUÉ ────────────────────────────────────────────────────────────
 * Un aviso que no se apaga nunca se aprende a ignorar. La marca se levanta cuando el revisor de
 * wiring CORRIÓ DE VERDAD en este repo después del cambio — dato que existe desde el mismo día en
 * el registro de arranques (`lib/advisor-ledger.js`, Tema 2): spawns reales, no self-report. Es la
 * primera cosa que se apoya en ese registro, y muestra para qué servía tenerlo atribuido por repo.
 */

const fs = require('fs');
const path = require('path');

const WIRING = 'tycon-feature-wiring-checker';

function rutaMarca(repoRoot) {
  return path.join(repoRoot, '.advisors', 'navigation-drift.json');
}

/** ¿Este artefacto de planning ES el modelo de navegación / arquitectura de información? */
function esMapaDeNavegacion(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  if (!/\/specs\/planning-artifacts\/[^/]+\.md$/.test(p)) return false;
  const base = p.split('/').pop();
  return /(navigation|navegaci[oó]n|sitemap|information[-_]architecture|arquitectura[-_]de[-_]informaci[oó]n|mapa)/i.test(base);
}

/** Deja la marca. Best-effort: nunca rompe la edición que la disparó. */
function marcar(repoRoot, artefacto, evento) {
  if (!repoRoot) return false;
  try {
    fs.mkdirSync(path.join(repoRoot, '.advisors'), { recursive: true });
    fs.writeFileSync(rutaMarca(repoRoot), JSON.stringify({
      ts: new Date().toISOString(),
      artefacto: String(artefacto || '').replace(/\\/g, '/'),
      evento: evento || null,
    }, null, 2) + '\n', 'utf8');
    return true;
  } catch (_e) { return false; }
}

function leerMarca(repoRoot) {
  try {
    const m = JSON.parse(fs.readFileSync(rutaMarca(repoRoot), 'utf8'));
    return m && m.ts ? m : null;
  } catch (_e) { return null; }
}

/** ¿Corrió el revisor de wiring en ESTE repo después de `desdeIso`? Fuente: spawns REALES. */
function reauditadoDespuesDe(repoRoot, desdeIso, opts) {
  let led;
  try { led = require('./advisor-ledger.js'); } catch (_e) { return false; }
  const r = led.query({ repo: repoRoot, runsDir: opts && opts.runsDir, summaryPath: opts && opts.summaryPath });
  const t = new Date(desdeIso).getTime();
  if (r.vivos.some((v) => v.advisor === WIRING && v.ts && new Date(v.ts).getTime() > t)) return true;
  // El detalle vivo dura 7 días; después queda el resumen durable. Sin mirarlo, una corrida real
  // de hace más de una semana quedaría invisible y la marca no se levantaría nunca.
  return r.archivo.some((s) => (s.advisors || {})[WIRING] && s.to && new Date(s.to).getTime() > t);
}

/**
 * El aviso, o null. Levanta la marca sola cuando ya se re-auditó.
 * @returns {string|null}
 */
function avisoPendiente(repoRoot, opts) {
  const m = leerMarca(repoRoot);
  if (!m) return null;
  if (reauditadoDespuesDe(repoRoot, m.ts, opts)) {
    try { fs.unlinkSync(rutaMarca(repoRoot)); } catch (_e) { /* ya no estaba */ }
    return null;
  }
  return (
    `⚠ tycon-navigation-drift\nEl modelo de navegación cambió el ${m.ts.slice(0, 10)} (\`${m.artefacto}\`) y ` +
    'desde entonces NO volvió a correr el revisor de wiring en este repo.\n' +
    '  La regla WIRING-C5 compara el layout del código contra ese documento, pero **sólo mira código nuevo**: ' +
    'las pantallas ya escritas no se revisan de nuevo cuando el documento cambia.\n' +
    '  Esta story toca interfaz, así que es el momento de mirarlo: corré `tycon-feature-wiring-checker` ' +
    'sobre las pantallas que el cambio afecta. La marca se levanta sola cuando ese revisor corra.\n' +
    `  Apagar: borrar \`${path.join('.advisors', 'navigation-drift.json')}\`.`
  );
}

module.exports = { esMapaDeNavegacion, marcar, leerMarca, avisoPendiente, reauditadoDespuesDe, rutaMarca, WIRING };
