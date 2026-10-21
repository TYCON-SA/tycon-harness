#!/usr/bin/env node
/**
 * on-planning-artifact.js — Regla 12.1 de workflow-orchestration.md (advisory).
 *
 * La regla "todo artefacto de planning nuevo o
 * reescrito sobre dominio ya cubierto por un artefacto APROBADO declara
 * `reconciles:`/`supersedes_in:` en frontmatter" vive solo en la guía —
 * invisible en el momento del Write. Caso: un UX spec
 * escrito ignorando el catálogo de pantallas aprobado por el cliente;
 * el drift es invisible hasta varias stories después.
 *
 * Handler ADVISORY del dispatcher pre-edit (nunca bloquea — el overlap de
 * dominio es juicio, no regex): si el Write apunta a specs/planning-artifacts/
 * con contenido tipo spec/mapa/architecture/PRD y el frontmatter NO tiene
 * `reconciles:`, emite reminder con la regla. Silencioso en todo lo demás.
 */

const fs = require('fs');
const path = require('path');

// Tipos de artefacto que la Regla 12.1 cubre (heurística por nombre/contenido).
const ARTIFACT_NAME_RE = /(ux|design|navigation|architecture|arquitectura|prd|catalogo|catálogo|pantallas|spec)/i;

function handle(event) {
  // 🔴 `Edit` TAMBIÉN: con `tool_name !== 'Write'` el hook sólo vería la CREACIÓN del artefacto y nunca su
  // edición — que es la forma normal de cambiar un mapa de navegación ya existente.
  if (!event || (event.tool_name !== 'Write' && event.tool_name !== 'Edit')) return null;
  const filePath = String(event.tool_input?.file_path || '').replace(/\\/g, '/');
  if (!/\/specs\/planning-artifacts\/[^/]+\.md$/.test(filePath)) return null;
  if (!ARTIFACT_NAME_RE.test(filePath.split('/').pop())) return null;

  // La MARCA de deriva de navegación: WIRING-C5 compara el código contra este documento en un solo
  // sentido (código nuevo → documento). Si el documento cambia, las pantallas ya escritas no se
  // revisan nunca más. La marca la lee el cierre de la próxima story de interfaz.
  // Va ANTES del `return null` de la regla 12.1: un artefacto que SÍ declara `reconciles:` cumple
  // esa regla y aun así cambió el modelo de navegación.
  try {
    const nd = require('./lib/navigation-drift.js');
    if (nd.esMapaDeNavegacion(filePath)) {
      const raiz = require('./lib/evidence-config.js').discoverRepoRoot(filePath);
      if (raiz) nd.marcar(raiz, path.relative(raiz, filePath), event.tool_name);
    }
  } catch (_e) { /* la marca es best-effort: nunca rompe la edición */ }

  const content = event.tool_input?.content || event.tool_input?.new_string || '';
  const fm = (content.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
  if (/^reconciles\s*:/m.test(fm)) return null; // cumple la regla

  const isNew = !fs.existsSync(filePath);
  return {
    reminder:
      `Regla 12.1 (workflow-orchestration.md §12): estás ${isNew ? 'creando' : 'reescribiendo'} un artefacto de planning ` +
      `(${filePath.split('/').pop()}) SIN bloque \`reconciles:\` en el frontmatter. Si toca un dominio ya cubierto por un ` +
      `artefacto APROBADO previo (catálogo de pantallas, UX spec, architecture, PRD), DEBE declarar:\n` +
      `  reconciles:\n    - "<path artefacto previo> (<aprobado-cliente|interno>)"\n  supersedes_in:   # opcional\n` +
      `y resolver cada divergencia en una sección "Reconciliación". Sin eso el artefacto no pasa de draft. ` +
      `Si cambia un modelo FIRMADO por el cliente → CR registrado (Regla 12.3). ` +
      `Si NO hay artefacto previo del dominio → ignorá este reminder (es advisory). ` +
      `Caso disparador: UX spec V7 ignoró el catálogo firmado → drift invisible hasta Story 13.0.`,
  };
}

module.exports = { handle };

if (require.main === module) {
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    const r = handle(stdin ? JSON.parse(stdin) : null);
    if (r && r.reminder) process.stdout.write(`<system-reminder>\n${r.reminder}\n</system-reminder>\n`);
    process.exit(0);
  } catch {
    process.exit(0); // advisory: nunca romper el Write
  }
}
