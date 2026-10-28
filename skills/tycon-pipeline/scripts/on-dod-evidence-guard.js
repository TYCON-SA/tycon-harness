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
 * Override de la persona (one-shot, auditable): el archivo `ALLOW_DOD_EVIDENCE_WRITE` en la carpeta del estado del
 * pipeline, autorizado por la persona. Vale sólo con una de dos: la constancia que escribe el freno de seguridad al
 * dejar crearlo con «autorizo ALLOW_DOD_EVIDENCE_WRITE» (ESC-C5, de esta sesión, dentro de los 30 minutos antes del
 * archivo), o esa frase de la persona en la conversación (lo creó ella en su terminal). El archivo solo no alcanza: el
 * agente lo puede crear con la herramienta de escribir archivos, que el freno no ve. Una línea imitada en
 * `frenos.jsonl` no vale: tiene que ser de ese freno, esa regla, esa sesión y esa ventana, y la carpeta del estado no
 * se escribe a mano. El hook CONSUME (borra) el archivo al permitir UNA escritura y la registra en bypass.log con quién
 * lo autorizó. (No es provenance criptográfica: el agente tiene Bash y puede escribir la evidencia por fuera del hook —
 * pero ese camino también es auditable en el transcript.)
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
const FLAG = path.join(STATE_DIR, 'ALLOW_DOD_EVIDENCE_WRITE');

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

function handle(event) {
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

  // Override one-shot: el permiso presente Y autorizado por la persona → permitir UNA vez, consumir, loguear. Crear el
  // archivo solo no alcanza (lo puede crear el agente con la herramienta de escribir archivos, que el freno no ve).
  const { via, paso } = fs.existsSync(FLAG) ? permisoAutorizado(event) : { via: null };
  if (via) {
    try { fs.unlinkSync(FLAG); } catch { /* ignore */ }
    appendBypassLog({ type: 'DOD_EVIDENCE_MANUAL_WRITE', file: filePath, sessionId: event.session_id || null, via });
    anotar('escritura-manual', 'aviso', filePath);
    return {
      reminder:
        `⚠ Escritura MANUAL de evidencia DoD permitida por flag one-shot (consumido) y registrada en bypass.log: ${filePath}. ` +
        'La evidencia manual NO tiene la garantía de un run real — preferí el gate E2E del proyecto (pipeline.js e2e-config → e2e.gate) / step-7c-macro.js.',
    };
  }

  anotar('escritura-manual', 'bloqueo', filePath);
  if (paso && paso.reintento) {
    return { block: ['🚨 BLOQUEADO — el permiso de escribir la evidencia DoD a mano no se pudo verificar', '', `  File: ${filePath}`, '', paso.cartel].join('\n') + '\n' };
  }
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
      'lo decide la persona, no el agente: crea el permiso de una escritura en su terminal y lo dice en su',
      'mensaje («autorizo ALLOW_DOD_EVIDENCE_WRITE»). El permiso se consume y queda en bypass.log.',
      ...(fs.existsSync(FLAG) ? ['', 'El permiso existe, pero la persona no lo autorizó en esta sesión: no se consume.'] : []),
      ...(paso && paso.cartel ? [paso.cartel] : []),
    ].join('\n') + '\n',
  };
}

const VENTANA_MS = 30 * 60 * 1000;
/**
 * ¿Quién autorizó el permiso? 'freno' si `frenos.jsonl` tiene la constancia que escribe el freno de seguridad al dejar
 * crearlo con la frase (ESC-C5, escape ALLOW_DOD_EVIDENCE_WRITE) de esta misma sesión, dentro de los 30 minutos antes
 * del archivo (se anota antes de que el comando corra); 'persona' si la persona escribió «autorizo
 * ALLOW_DOD_EVIDENCE_WRITE» en esta conversación (lo creó en su terminal); null si ninguna. Vuelve `{ via, paso? }`:
 * `paso` es lo que la búsqueda de la frase dijo del pedido que se juzga cuando no lo ubicó (escape-ok.js `cartelDelPaso`).
 */
function permisoAutorizado(event) {
  const sid = event.session_id;
  if (sid) {
    try {
      const creado = fs.statSync(FLAG).mtimeMs;
      for (const l of fs.readFileSync(path.join(STATE_DIR, 'frenos.jsonl'), 'utf8').split('\n')) {
        let x;
        try { x = JSON.parse(l); } catch { continue; }
        if (!x || x.freno !== 'safety-guard' || x.regla !== 'ESC-C5' || x.veredicto !== 'escape') continue;
        if (x.sesion !== sid || x.escape !== 'ALLOW_DOD_EVIDENCE_WRITE') continue;
        const t = Date.parse(x.ts);
        // un minuto de margen: la constancia y el archivo se escriben casi juntos
        if (t <= creado + 60000 && t >= creado - VENTANA_MS) return { via: 'freno' };
      }
    } catch { /* sin registro, se mira la frase */ }
  }
  try {
    const { escapeAutorizado, cartelDelPaso } = require('./lib/escape-ok.js');
    const r = escapeAutorizado({ variable: 'ALLOW_DOD_EVIDENCE_WRITE', sesion: sid, pedido: event.tool_use_id });
    if (r.ok) return { via: 'persona' };
    return { via: null, paso: { reintento: r.pasoNoUbicado === true, cartel: cartelDelPaso(r) } };
  } catch (e) {
    // sin la biblioteca no hay frase que buscar: se dice eso, no «el agente no escribe evidencia»
    return { via: null, paso: { reintento: true, cartel: `falló la búsqueda de la frase (${e.message}): el permiso no se puede verificar. Avisale a la persona.` } };
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
