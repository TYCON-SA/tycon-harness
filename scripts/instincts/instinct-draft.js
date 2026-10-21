/**
 * instinct-draft.js — generador de drafts cuando un instinct aprobado
 * tiene `tycon_artifact_suggestion`. Output a `drafts/` del lugar donde vive el
 * instinct aprobado (inbox/instincts/drafts/ en un árbol que trae su buzón; la
 * casa de la persona si no — lo dice instinct-dirs.js).
 *
 * Tipos de draft soportados:
 *   - advisor:<rule-id>      → markdown block listo para advisor-rules-catalog.md
 *   - skill:<name>           → SKILL.md skeleton
 *   - hook:<event>           → script .sh skeleton + entry para settings.json
 *   - guide:<topic>          → markdown skeleton para guides/<topic>.md
 *
 * IMPORTANT: drafts NUNCA se commitean automáticamente. Solo se generan en
 * esa carpeta y el operador humano decide qué hacer con ellos.
 */

const fs = require('fs');
const path = require('path');

// Dónde van los borradores lo dice quien llama (la carpeta `drafts/` del lugar del instinct aprobado) o, si no lo dice,
// instinct-dirs.js. No se resuelve al cargar este archivo —otras piezas lo requieren sólo por `ownerDePrefijo`— y la
// carpeta se crea recién al escribir el borrador.

// Prefijo de regla → revisor dueño. Sólo el NÚCLEO va escrito acá; los prefijos de los revisores de
// un producto o de un cliente (DOTNET/REACT/NEXT, XPAT…) los declaran sus manifiestos en los
// paquetes de revisores instalados y se suman leyéndolos. Sin el paquete, el prefijo no
// tiene dueño — y eso se ve en el borrador como UNKNOWN-ADVISOR, no como un nombre inventado.
const OWNER_NUCLEO = {
  SEC: 'tycon-plugin-security-basics',
  TEST: 'tycon-plugin-tests-coverage',
  LLMCOST: 'llm-cost-reviewer',
  SILENT: 'tycon-silent-failure-hunter',
  SPEC: 'tycon-spec-first-checker',
  REAL: 'tycon-e2e-realness-checker',
  DEFTR: 'tycon-deferral-tracker',
  DODRT: 'tycon-dod-runtime-checker',
};

function ownerDePrefijo(prefix) {
  if (OWNER_NUCLEO[prefix]) return OWNER_NUCLEO[prefix];
  const dePaquetes = require('../lib/installed-packs.js').prefijosDePaquetes();
  return dePaquetes[prefix] || 'UNKNOWN-ADVISOR';
}

// El prefijo de un id de regla (DOTNET-C7 → DOTNET). Con dígitos también (V2-C1 → V2): el vocabulario
// de los manifiestos los admite, y `/^[A-Z]+/` los dejaría sin dueño.
function prefijoDeRegla(ruleId) {
  return String(ruleId || '').match(/^([A-Z][A-Z0-9]*)/)?.[1] || 'UNKNOWN';
}

function generateAdvisorDraft(inst, ruleId) {
  const prefix = prefijoDeRegla(ruleId);
  const severity = inst.confidence >= 0.9 ? 'CRITICAL' : 'WARNING';
  const ownerHint = ownerDePrefijo(prefix);

  return `# Draft: nueva regla ${ruleId} para advisor-rules-catalog.md
# Generado por instinct-mining 2026-05-23 desde instinct hash:${inst.hash}
# ACCIÓN HUMANA REQUERIDA:
#   1. Revisar este draft
#   2. Editar (especialmente ejemplos código y heurística de detección)
#   3. Decidir si va a CRITICAL/WARNING/INFO
#   4. Verificar que el owner está bien (${ownerHint})
#   5. Si te convence: copiar el block markdown abajo a guides/advisor-rules-catalog.md
#      en la sección del owner correspondiente
#   6. Actualizar el advisor (~/.claude/agent-skills/skills/${ownerHint}/SKILL.md)
#      para que enforce la nueva regla
#   7. Mergear a git

---

### ${ruleId} — ${inst.trigger}

**Owner**: \`${ownerHint}\`
**Severity**: ${severity}
**Confidence**: ${inst.confidence} (evidencia: ${inst.evidence_count} ocurrencias)
**Disparador**: instinct mining ${new Date().toISOString().slice(0, 10)} — patrón repetido detectado automáticamente

**Regla**: ${inst.action}

**Razón**: ${inst.reasoning}

**Heurística de detección** (TODO completar):
- [ ] Patrón regex / AST / dependency para detectar la violación
- [ ] Falsos positivos esperables
- [ ] Cómo el advisor reporta el finding (formato del output)

**Ejemplo violación**:
\`\`\`<lang>
// TODO: ejemplo concreto
\`\`\`

**Ejemplo corregido**:
\`\`\`<lang>
// TODO: cómo debería ser
\`\`\`

**Referencias**:
- Instinct hash: \`${inst.hash}\`
- Domain: \`${inst.domain}\`
- Scope: \`${inst.scope}${inst.project ? ` (project: ${inst.project})` : ''}\`
`;
}

function generateSkillDraft(inst, skillName) {
  return `# Draft: nueva skill \`${skillName}\`
# Generado por instinct-mining ${new Date().toISOString().slice(0, 10)} desde instinct hash:${inst.hash}
# ACCIÓN HUMANA REQUERIDA:
#   1. Revisar este skeleton
#   2. Completar la lógica concreta (esto es solo un placeholder)
#   3. Decidir si va en ~/.claude/skills/${skillName}/ o en agent-skills (team-wide)
#   4. Crear SKILL.md final + scripts auxiliares
#   5. Probar manualmente
#   6. Mergear a git

---

# SKILL.md skeleton

\`\`\`markdown
---
name: ${skillName}
description: ${inst.action}
allowed-tools: [Read, Edit, Bash]  # TODO: ajustar permisos mínimos
---

# ${skillName}

**Disparador detectado**: ${inst.trigger}

**Qué hace esta skill**: ${inst.action}

**Razón** (de instinct mining): ${inst.reasoning}

**Confidence**: ${inst.confidence} (${inst.evidence_count} ocurrencias)

## Workflow

TODO completar:
1. Paso 1
2. Paso 2
3. Paso 3

## Output esperado

TODO: describir qué retorna la skill al user
\`\`\`

**Referencias**:
- Instinct hash: \`${inst.hash}\`
- Domain: \`${inst.domain}\`
`;
}

/**
 * El comando que el borrador propone registrar: el script bajo el lugar del arnés. En Windows, la ruta
 * absoluta con `/` y sin `$`: un `$` en un comando de settings.json no lo expande el shell que lo corre ahí.
 */
function hookCommand(fname, { platform = process.platform, home = require('os').homedir() } = {}) {
  const place = require('../setup/harness/place.js').PLACE_NAME;
  if (platform === 'win32') return `${String(home).replace(/\\/g, '/')}/.claude/${place}/scripts/hooks/${fname}`;
  return `$HOME/.claude/${place}/scripts/hooks/${fname}`;
}

function generateHookDraft(inst, hookEvent) {
  const fname = `${hookEvent.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${inst.hash.slice(0, 6)}.sh`;
  return `# Draft: nuevo hook ${hookEvent}
# Generado por instinct-mining ${new Date().toISOString().slice(0, 10)} desde instinct hash:${inst.hash}
# ACCIÓN HUMANA REQUERIDA:
#   1. Revisar este skeleton
#   2. Decidir si va en scripts/hooks/ (team-wide) o ~/.claude/scripts/ (personal)
#   3. Implementar la lógica concreta
#   4. Agregar entry a ~/.claude/settings.json bajo "hooks.${hookEvent}"
#   5. Update install-tycon-hooks.sh si es team-wide
#   6. Probar manualmente

---

# Script: scripts/hooks/${fname}

\`\`\`bash
#!/usr/bin/env bash
# ${fname} — ${inst.action}
# Disparador (instinct mining): ${inst.trigger}
# Razón: ${inst.reasoning}

set -u
# Fail-open: cualquier excepción exit 0 silencioso
trap 'exit 0' ERR

# Input (stdin): JSON event del hook ${hookEvent}
PAYLOAD="$(cat 2>/dev/null || echo '{}')"

# TODO: implementar la lógica concreta acá

exit 0
\`\`\`

# Entry para ~/.claude/settings.json:

\`\`\`json
{
  "hooks": {
    "${hookEvent}": [
      {
        "matcher": "TODO: ajustar matcher (ej Bash, Edit|Write, etc)",
        "hooks": [
          {
            "type": "command",
            "command": "${hookCommand(fname)}"
          }
        ]
      }
    ]
  }
}
\`\`\`

**Referencias**:
- Instinct hash: \`${inst.hash}\`
- Domain: \`${inst.domain}\`
- Confidence: ${inst.confidence} (${inst.evidence_count} ocurrencias)
`;
}

function generateGuideDraft(inst, topic) {
  return `# Draft: nueva guía ${topic}.md
# Generado por instinct-mining ${new Date().toISOString().slice(0, 10)} desde instinct hash:${inst.hash}
# ACCIÓN HUMANA REQUERIDA:
#   1. Revisar este skeleton
#   2. Expandir las secciones con contenido real
#   3. Mover a guides/${topic}.md
#   4. Agregar entry en README.md (tabla "Cuándo leer cada guía")
#   5. Mergear a git

---

# ${topic}

**Disparador (de instinct mining)**: ${inst.trigger}

**Por qué documentar esto**: ${inst.reasoning}

## TL;DR

${inst.action}

## Contexto

TODO: situación donde aplica esta guía

## Regla / pattern

TODO: descripción detallada

## Ejemplos

### Buen ejemplo

TODO

### Mal ejemplo

TODO

## Excepciones

TODO

## Referencias

- Instinct hash: \`${inst.hash}\`
- Confidence: ${inst.confidence} (${inst.evidence_count} ocurrencias)
- Domain: \`${inst.domain}\`
`;
}

/**
 * Genera un draft para el instinct dado, basado en su tycon_artifact_suggestion.
 * Retorna { type, path, content } o null si no hay sugerencia.
 * `dir`: la carpeta de borradores; sin ella, `drafts/` del lugar donde se escribe.
 */
function generateDraft(inst, dir = null) {
  const suggestion = inst.tycon_artifact_suggestion;
  if (!suggestion || suggestion === 'null') return null;

  const m = suggestion.match(/^(advisor|skill|hook|guide):(.+)$/);
  if (!m) return null;
  const [, type, target] = m;

  let content;
  let suffix;
  if (type === 'advisor') {
    content = generateAdvisorDraft(inst, target);
    suffix = `advisor-${target.toLowerCase()}`;
  } else if (type === 'skill') {
    content = generateSkillDraft(inst, target);
    suffix = `skill-${target}`;
  } else if (type === 'hook') {
    content = generateHookDraft(inst, target);
    suffix = `hook-${target.toLowerCase()}`;
  } else if (type === 'guide') {
    content = generateGuideDraft(inst, target);
    suffix = `guide-${target}`;
  } else {
    return null;
  }

  const fname = `${inst.hash}-${suffix}.md`;
  const draftsDir = dir || path.join(require('./instinct-dirs.js').writePlace(), 'drafts');
  const fpath = path.join(draftsDir, fname);
  fs.mkdirSync(draftsDir, { recursive: true });
  fs.writeFileSync(fpath, content);
  return { type, path: fpath, content };
}

module.exports = { generateDraft, ownerDePrefijo, prefijoDeRegla, hookCommand };
