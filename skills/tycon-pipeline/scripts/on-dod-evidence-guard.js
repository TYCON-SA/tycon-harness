#!/usr/bin/env node
/**
 * on-dod-evidence-guard.js — provenance de la evidencia DoD.
 *
 * La evidencia de `.advisors/dod-runtime/*.md` es el insumo que desbloquea las
 * transiciones a review/done (on-frontmatter-write.js) y el commit (on-pre-commit.js).
 * Sin esto, NADA impide que el agente la escriba con Write/Edit — el gate más
 * fakeable del harness: el LLM podía redactar un "## Playwright Run verdict=PASS
 * failed=0" sin haber corrido nada.
 *
 * Este handler (chain pre-edit del dispatcher) BLOQUEA Write/Edit del agente sobre
 * `.advisors/dod-runtime/*.md`. Los únicos escritores legítimos son los scripts
 * (el gate E2E del proyecto, step-7c-macro.js) vía Bash — que no pasan por este hook.
 *
 * Override de la persona (one-shot, auditable): la firma `ALLOW_DOD_EVIDENCE_WRITE` sobre ese archivo, dada en la ventana de
 * permiso (`marker.js sign-file ALLOW_DOD_EVIDENCE_WRITE <archivo>`, scripts/lib/owner-window.js) o en la terminal del dueño.
 * El hook CONSUME la constancia al permitir UNA escritura de esa sesión sobre ese archivo, dentro de los 30 minutos, y
 * la registra en bypass.log con la vía. (No es provenance criptográfica: el agente tiene Bash y puede escribir la
 * evidencia por fuera del hook; ese camino lo frena el freno de seguridad, ESC-C5.)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // La carpeta del estado, de una sola pieza
const STATE_DIR = path.join(stateDirOf(os.homedir()));
// Cada decisión sobre una escritura a la carpeta de evidencia deja una línea en
// frenos.jsonl (sólo la huella de la ruta). Ayuda, no evidencia: no cambia ni la decisión ni la salida.
// La lib se carga adentro y envuelta: si faltara (instalación a medias), el guard frena igual.
function anotar(regla, veredicto, filePath) {
  try {
    require('./lib/closing-record.js').anotarCierre({ freno: 'on-dod-evidence-guard', regla, veredicto, huella: filePath });
  } catch { /* ayuda, no evidencia */ }
}

function appendBypassLog(obj) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(STATE_DIR, 'bypass.log'),
      JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n',
      'utf8',
    );
  } catch { /* logging nunca rompe */ }
}

function handle(event, { casa } = {}) {
  if (!event) return null;
  const tool = event.tool_name;
  if (tool !== 'Edit' && tool !== 'Write') return null;
  const filePath = event.tool_input?.file_path || '';
  const normPath = filePath.replace(/\\/g, '/');
  if (!/\.advisors\/dod-runtime\/[^/]+\.md$/.test(normPath)) return null;

  // EXENCIÓN — el self-audit (ACCOV-C8) lo AUTORIZA el protocolo a escribir el agente:
  // es su auto-revisión estructurada (§1-5 de accov-governance-protocol.md), NO evidencia de un
  // test-run fakeable (esa es <storyId>-<ts>.md del macro + <storyId>-e2e-gate-*.md del gate, con
  // el bloque `## Playwright Run verdict=PASS`, que SÍ se siguen bloqueando). La honestidad del
  // self-audit la cierra la convergencia ACCOV-C10 (no hay meta-audit ACCOV-C9,
  // y el self-audit es opcional) — no este provenance guard. Sin la exención, escribir el artefacto que
  // el propio protocolo manda producir requeriría un `touch` manual del user en cada story (fricción
  // sin valor — el self-audit no es el gate fakeable).
  if (/-self-audit(-iter\d+)?\.md$/.test(normPath)) { anotar('archivo-exento', 'paso', filePath); return null; }

  // EXENCIÓN — el plan de prueba manual (DODRT-C6) también lo escribe el agente: es la guía
  // que el USUARIO va a ejecutar para los ACs diferidos, no evidencia de un run fakeable.
  // Su honestidad la cierran runtime-matrix.js (exige que mencione CADA AC diferido) + el
  // ack hash-pinneado que aprueba el humano. La MATRIZ (`-runtime-matrix.md`) NO está exenta:
  // esa la escribe SOLO el script (a mano sería el fakeo exacto que este guard impide).
  if (/-manual-test-plan\.md$/.test(normPath)) { anotar('archivo-exento', 'paso', filePath); return null; }

  // Override one-shot: la firma de la ventana sobre este archivo → permitir UNA vez, consumirla, loguear.
  const firma = firmaDeLaVentana(event, filePath, casa);
  if (firma.ok) {
    appendBypassLog({ type: 'DOD_EVIDENCE_MANUAL_WRITE', file: filePath, sessionId: event.session_id || null, via: firma.constancia.via });
    anotar('escritura-manual', 'aviso', filePath);
    return {
      reminder:
        `⚠ Escritura MANUAL de evidencia DoD permitida por la firma de la ventana (consumida) y registrada en bypass.log: ${filePath}. ` +
        'La evidencia manual NO tiene la garantía de un run real — preferí el gate E2E del proyecto (pipeline.js e2e-config → e2e.gate) / step-7c-macro.js.',
    };
  }

  anotar('escritura-manual', 'bloqueo', filePath);
  return {
    block: [
      '🚨 BLOQUEADO — el agente no escribe evidencia DoD a mano (provenance, auditoría 2026-06-09)',
      '',
      `  File: ${filePath}`,
      '',
      'Los archivos de .advisors/dod-runtime/ son el insumo que desbloquea review/done y',
      'el commit. Los escriben los SCRIPTS que corren los tests de verdad:',
      '',
      '  - Suite Playwright:  gate E2E del proyecto (.tycon/advisors.yaml → e2e.gate); resolver: pipeline.js e2e-config --repo <repo> --changed <archivos-de-la-story...> → correr `bash <gate> <app> <storyId> <evidence-dir>` UNA VEZ POR APP (<evidence-dir> = `pipeline.js evidence-dir --story <spec> --repo <repo> --plain`: el repo de la STORY) de frontend_dirs_selected (en un monorepo puede ser más de una)',
      '  - Smoke backend:     node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/step-7c-macro.js --story <id> --scenario <s.json> --evidence-dir <dir>',
      '',
      'Escribirla a mano (caso excepcional, p.ej. evidencia vacua de E2E diferidos a un pipeline pending)',
      'lo decide la persona, no el agente: la firma en la ventana de permiso, para este archivo, con',
      `  ${firma.comando}`,
      'y con su «Sí» se repite esta escritura. La firma vale una vez y queda en bypass.log.',
      `(No hay firma: ${firma.motivo}.)`,
    ].join('\n') + '\n',
  };
}

/**
 * La firma de la ventana sobre este archivo: `{ ok: true, constancia }` la consume; `{ ok: false, motivo }` si no la hay.
 * Siempre con `comando`, el que la pide. `casa`: la de las pruebas.
 */
function firmaDeLaVentana(event, filePath, casa) {
  try {
    const ow = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
    return { ...ow.consumirArchivo({ firma: 'ALLOW_DOD_EVIDENCE_WRITE', sesion: event.session_id, archivo: filePath, cwd: event.cwd, casa }), comando: ow.comoSeFirma('ALLOW_DOD_EVIDENCE_WRITE', filePath) };
  } catch (e) {
    return { ok: false, motivo: `no pude consultar la ventana (${e.message})`, comando: `marker.js sign-file ALLOW_DOD_EVIDENCE_WRITE ${filePath}` };
  }
}

module.exports = { handle };

// CLI shim standalone (mismo contrato que los demás handlers del dispatcher).
if (require.main === module) {
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    const r = handle(stdin ? JSON.parse(stdin) : null);
    if (r && r.block) { process.stderr.write(r.block); process.exit(2); }
    if (r && r.reminder) process.stdout.write(`<system-reminder>\n${r.reminder}\n</system-reminder>\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`⚠ on-dod-evidence-guard: error (failing open): ${e.message}\n`);
    process.exit(0);
  }
}
