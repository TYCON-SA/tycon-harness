#!/usr/bin/env node
/**
 * rules-distill.js — audit estructural del catálogo de reglas TYCON.
 *
 * Aprovechando que TYCON ya tiene rule IDs estables (SEC-C1, DOTNET-W3, etc.),
 * este script hace un check determinístico (no LLM) sobre:
 *
 *   1. ZOMBIES: rule ID en `advisor-rules-catalog.md` que NINGÚN advisor cita.
 *      → regla documentada sin enforcement.
 *
 *   2. ORPHANS: rule ID citado en advisor pero NO en el catálogo.
 *      → regla enforced sin documentar.
 *
 *   3. MULTI-OWNER: rule ID citado en >1 advisor distinto.
 *      → posible regla compartida que debería vivir en un advisor base.
 *
 *   4. OWNER-MISMATCH: el catálogo asigna la regla al advisor X (por sección)
 *      pero el advisor X NO la cita en su body.
 *      → el dueño cambió y nadie actualizó docs.
 *
 * Inspirado en ECC rules-distill, simplificado a check estructural para TYCON.
 * El ECC original usa LLM cross-read para extraer principios — TYCON ya tiene
 * los principios formalizados como rule IDs, así que el LLM es overkill.
 *
 * Uso:
 *   node ~/.claude/tycon-harness/scripts/tools/rules-distill.js          # reporte
 *   node ~/.claude/tycon-harness/scripts/tools/rules-distill.js --json   # output JSON
 *   node ~/.claude/tycon-harness/scripts/tools/rules-distill.js --verbose # extra detail
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const JSON_OUT = process.argv.includes('--json');
const VERBOSE = process.argv.includes('--verbose');

// 🔴 El catálogo y los scripts se leen del REPO DONDE VIVE ESTE GUION (o de TYCON_GUIDES_DIR), no de una
//    ruta fija bajo el home: un clon se lee a sí mismo, y no el catálogo de otro checkout sin decirlo.
const GUIDES_DIR = process.env.TYCON_GUIDES_DIR || path.resolve(__dirname, '..', '..');
const CATALOG_PATH = path.join(GUIDES_DIR, 'guides/advisor-rules-catalog.md');
const AGENTS_DIR = path.join(HOME, '.claude/agents');
// los revisores de un paquete que trae este árbol (packs/<p>/agents/): citan reglas del catálogo igual que los del núcleo
// (con el paquete, una regla que sólo cita un revisor de paquete cuenta como cualquiera)
const PACKS_DIR = path.join(GUIDES_DIR, 'packs');
// Una carpeta de paquete sin pack.json es un paquete roto, no uno ausente: se dice una vez por stderr (las reglas que sólo
// citan sus revisores van a contar como no citadas). Uno sin agents/ es legítimo: un paquete puede traer sólo skills.
const brokenPacksSaid = new Set();
const packAgentDirs = () => (fs.existsSync(PACKS_DIR) ? fs.readdirSync(PACKS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  .filter((p) => {
    if (fs.existsSync(path.join(PACKS_DIR, p, 'pack.json'))) return true;
    if (!brokenPacksSaid.has(p)) {
      brokenPacksSaid.add(p);
      process.stderr.write(`⚠ rules-distill: packs/${p}/ no trae pack.json — es un paquete roto: no leo sus revisores, y las reglas que sólo citan ellos cuentan como no citadas\n`);
    }
    return false;
  })
  .map((p) => path.join(PACKS_DIR, p, 'agents')).filter((d) => fs.existsSync(d)) : []);
const SKILLS_DIR = path.join(HOME, '.claude/agent-skills/skills');
const TCG_SCRIPTS_DIR = path.join(GUIDES_DIR, 'scripts');

// Tipos de owner detectables. Determinan si una sección del catalog enforcea
// vía advisor (~/.claude/agents/), skill (~/.claude/agent-skills/skills/),
// hook (script .sh/.js/.ps1 en ~/.claude/tycon-harness/scripts/), o desconocido.
function classifyOwner(ownerStr) {
  // Quitar prefijo opcional "tycon-" no afecta el lookup.
  const o = ownerStr.trim();

  // Si termina en extensión de script → hook (enforcement runtime, no advisor).
  if (/\.(sh|js|ps1|py)$/.test(o)) {
    // Verificar que el archivo exista en scripts/ o scripts/hooks/.
    const candidates = [
      path.join(TCG_SCRIPTS_DIR, o),
      path.join(TCG_SCRIPTS_DIR, 'hooks', o),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return { type: 'hook', path: c };
    }
    return { type: 'hook', path: null, missing: true };
  }

  // Buscar como advisor.
  const advisorPath = [AGENTS_DIR, ...packAgentDirs()].map((d) => path.join(d, `${o}.md`)).find((p) => fs.existsSync(p));
  if (advisorPath) return { type: 'advisor', path: advisorPath };

  // Buscar como skill.
  const skillPath = path.join(SKILLS_DIR, o, 'SKILL.md');
  if (fs.existsSync(skillPath)) return { type: 'skill', path: skillPath };

  return { type: 'unknown', path: null };
}

// Regex para rule IDs: PREFIX-Cn / PREFIX-Wn (1-2 dígitos). Acepta también
// formas como `SEC-C1` y `**SEC-C1**` (markdown bold).
//
// 🔴 El prefijo admite DÍGITOS después de la primera letra. Con `[A-Z]{2,12}`, el área `I18N` (tiene un 1 y un 8)
//    quedaría invisible: sus reglas no figurarían, su revisor aparecería como dueño de nada y el total saldría
//    corto. Como no las vería, tampoco podría acusarlas de nada: el agujero se taparía a sí mismo. El criterio
//    vive en scripts/lib/rules-catalog.js.
// El catálogo se lee con la gramática del parser único: con dos gramáticas, un identificador
// con sufijo (ACCOV-C1-EXT) se definiría con una y se citaría con otra, y saldría como zombi falso.
const catalogoDeReglas = require('../lib/rules-catalog.js');
const RULE_ID_RE = new RegExp(`\\b(${catalogoDeReglas.ID})\\b`, 'g');

// IDs en catalog que están explícitamente RETIRED (tachados con ~~ID~~).
// Estos NO cuentan como zombies — fueron retirados a propósito.
const RETIRED_MARKER = new RegExp(`~~(${catalogoDeReglas.ID})~~`, 'g');

// El parser ÚNICO del catálogo es el que decide QUÉ reglas hay y DE QUIÉN son: una regla
// existe si está DEFINIDA (primera columna en negrita de una fila). El escaneo por menciones de abajo se
// conserva sólo para `owners[]`: «quién la cita» y «de quién es» son dos preguntas distintas.

// ============================================================
// Parser: catálogo
// ============================================================

function parseCatalog() {
  if (!fs.existsSync(CATALOG_PATH)) {
    throw new Error(`Catalog not found: ${CATALOG_PATH}`);
  }
  const content = fs.readFileSync(CATALOG_PATH, 'utf8');

  // Detectar IDs retirados primero (para no contarlos como activos).
  const retired = new Set();
  let m;
  while ((m = RETIRED_MARKER.exec(content)) !== null) {
    retired.add(m[1]);
  }

  // Partir por secciones (cada `## <Advisor Name> — \`<advisor-id>\``).
  // El advisor-id en backticks identifica al dueño declarado de las reglas
  // que vienen después.
  const sectionRe = /^##\s+(.+?)\s+—\s+`([^`]+)`/gm;
  const sections = [];
  let lastIdx = 0;
  let lastName = null, lastAdvisor = null;
  let s;
  while ((s = sectionRe.exec(content)) !== null) {
    if (lastName !== null) {
      sections.push({
        name: lastName,
        advisor: lastAdvisor,
        body: content.slice(lastIdx, s.index),
      });
    }
    lastName = s[1];
    lastAdvisor = s[2];
    lastIdx = s.index + s[0].length;
  }
  if (lastName !== null) {
    sections.push({ name: lastName, advisor: lastAdvisor, body: content.slice(lastIdx) });
  }

  // Extraer rule IDs de cada sección, con el advisor declarado como owner.
  // NOTA: una misma sección puede declarar IDs para varios "subadvisors"
  // (ej: Safety Guard agrupa FS-*, GIT-*, SUP-*, PUB-*, SQL-*, SEC-*). El
  // owner del catálogo es el advisor-id de la sección.
  const catalogIds = new Map(); // ruleId → { owner: advisorId, sectionName: str }
  for (const sec of sections) {
    const found = new Set();
    let ri;
    RULE_ID_RE.lastIndex = 0;
    while ((ri = RULE_ID_RE.exec(sec.body)) !== null) {
      const id = ri[1];
      if (retired.has(id)) continue;
      // Solo registrar la PRIMERA mención en cada sección (header de tabla típicamente).
      if (!found.has(id)) {
        found.add(id);
        // Si el ID ya existía en catalog desde otra sección, registramos
        // todos los owners (sí, multi-section es legítimo a veces).
        if (catalogIds.has(id)) {
          const prev = catalogIds.get(id);
          prev.owners = prev.owners || [prev.owner];
          if (!prev.owners.includes(sec.advisor)) prev.owners.push(sec.advisor);
        } else {
          catalogIds.set(id, { owner: sec.advisor, sectionName: sec.name });
        }
      }
    }
  }

  // ── Overlay de DEFINICIONES ──────────────────────────────────────────────────────
  // El dueño de una regla es quien la DEFINE, no quien la menciona primero. Y una regla definida
  // que nadie menciona en prosa existe igual: sin este overlay, las de `I18N` quedarían fuera.
  const def = catalogoDeReglas.leer({ catalogo: CATALOG_PATH });
  let definedPairs = null, collisions = [];
  let reusedIds = [];
  if (def.estado === 'medido') {
    definedPairs = def.reglas;
    collisions = def.colisiones;
    reusedIds = def.reutilizadas;
    // 🔴 Las retiradas las decide el lector, que ignora los bloques de código. El escaneo global de
    //    arriba tomaría como retirada el EJEMPLO de la guía «Retirar una regla» y escondería a SEC-W4, una
    //    regla viva. Y un identificador retirado que volvió a definirse es una regla viva: no se retira.
    retired.clear();
    for (const r of def.retiradas) retired.add(r.regla);
    for (const id of reusedIds) retired.delete(id);
    // 🔴 Sólo lo DEFINIDO es regla del catálogo. Un identificador que el catálogo sólo menciona no es
    //    una regla: si un revisor lo cita, eso es un huérfano (se cita y no está definido).
    // 🔴 Una fila definida fuera de una sección con dueño no tiene a quién atribuirse: queda afuera
    //    (el lector la cuenta en `sin_dueno`). Copiarla con dueño null tumbaría classifyOwner.
    const conDueno = def.lista.filter((r) => typeof r.dueno === 'string' && r.dueno);
    const definidos = new Set(conDueno.map((r) => r.regla));
    for (const id of [...catalogIds.keys()]) if (!definidos.has(id)) catalogIds.delete(id);
    for (const r of conDueno) {
      const prev = catalogIds.get(r.regla);
      if (!prev) {
        catalogIds.set(r.regla, { owner: r.dueno, sectionName: r.seccion, defined: true });
      } else {
        // El dueño declarado gana sobre el primero que la mencionó.
        prev.owner = prev.defined ? prev.owner : r.dueno;
        prev.defined = true;
        if (prev.owners && !prev.owners.includes(r.dueno)) prev.owners.push(r.dueno);
      }
    }
  } else {
    // 🔴 Sin el lector único, lo de arriba es el escaneo viejo (menciones, retiradas por texto): se dice, no
    //    se sigue en silencio como si fuera la misma medición.
    console.error(`rules-distill: ⚠ el lector único del catálogo no midió (${def.motivo}); este informe usa el escaneo por menciones y puede diferir`);
  }

  const catalogoUnico = def.estado === 'medido' ? 'medido' : `no_medido: ${def.motivo}`;
  return { catalogIds, retired, sections, definedPairs, collisions, reusedIds, catalogoUnico };
}

// ============================================================
// Parser: agents
// ============================================================

function parseAgents() {
  if (!fs.existsSync(AGENTS_DIR)) {
    throw new Error(`Agents dir not found: ${AGENTS_DIR}`);
  }
  const usage = new Map(); // ruleId → Set(advisorNames)
  const advisors = [];

  const files = [];
  for (const dir of [AGENTS_DIR, ...packAgentDirs()]) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.md') || files.some((x) => x.f === f)) continue;   // el mismo revisor en dos lugares: cuenta una vez
      files.push({ dir, f });
    }
  }
  for (const { dir, f } of files) {
    const advisorName = f.replace('.md', '');
    advisors.push(advisorName);
    const content = fs.readFileSync(path.join(dir, f), 'utf8');

    // Excluir markdown bold/italic markers + headings con backticks que sean ejemplos.
    // Para v1, no filtro contextos especiales — todo match cuenta. False positives
    // raros (ej: mencionar SEC-C1 en un anti-pattern como "NO inventes IDs").
    const found = new Set();
    let ri;
    RULE_ID_RE.lastIndex = 0;
    while ((ri = RULE_ID_RE.exec(content)) !== null) {
      const id = ri[1];
      found.add(id);
    }

    for (const id of found) {
      if (!usage.has(id)) usage.set(id, new Set());
      usage.get(id).add(advisorName);
    }
  }

  return { usage, advisors };
}

// ============================================================
// Cross-check
// ============================================================

function distill() {
  const { catalogIds, retired, reusedIds, catalogoUnico } = parseCatalog();
  const { usage, advisors } = parseAgents();

  // 1. ZOMBIES: en catalog, no en usage. Refinado por tipo de owner:
  //    - owner = advisor → si no lo cita, es ZOMBIE real (regla docs sin enforcement)
  //    - owner = hook/skill → la regla la enforcea otro mecanismo (no .md en agents/)
  //      → marcar como "non-advisor enforced" (informational, no error)
  //    - owner = unknown → BROKEN-REF (catalog cita un advisor que no existe)
  const zombies = [];
  const nonAdvisorEnforced = [];
  const brokenRefs = [];
  for (const [id, meta] of catalogIds) {
    if (usage.has(id)) continue;
    const ownerInfo = classifyOwner(meta.owner);
    const entry = { id, owner: meta.owner, sectionName: meta.sectionName, ownerType: ownerInfo.type };
    if (ownerInfo.type === 'advisor') {
      zombies.push(entry);
    } else if (ownerInfo.type === 'hook' || ownerInfo.type === 'skill') {
      nonAdvisorEnforced.push(entry);
    } else {
      brokenRefs.push(entry);
    }
  }

  // 2. ORPHANS: en usage, no en catalog.
  const orphans = [];
  for (const [id, users] of usage) {
    if (!catalogIds.has(id) && !retired.has(id)) {
      orphans.push({ id, users: [...users] });
    }
  }

  // 3. MULTI-OWNER: id usado por >1 advisor.
  const multiOwner = [];
  for (const [id, users] of usage) {
    if (users.size > 1) {
      const catalogOwner = catalogIds.get(id)?.owner || '(uncatalogued)';
      multiOwner.push({ id, users: [...users], catalogOwner });
    }
  }

  // 4. OWNER-MISMATCH: catalog dice X, X no lo cita.
  const ownerMismatch = [];
  for (const [id, meta] of catalogIds) {
    const owner = meta.owner;
    if (usage.has(id)) {
      const realUsers = usage.get(id);
      // Permitir matching parcial: el owner del catalog puede tener prefijo
      // distinto (ej: catalog dice 'http-resilience-reviewer', advisor file
      // se llama 'http-resilience-reviewer.md' → match exacto).
      // Si NO está en realUsers, es mismatch.
      if (!realUsers.has(owner)) {
        ownerMismatch.push({
          id,
          declaredOwner: owner,
          actualOwners: [...realUsers],
        });
      }
    }
  }

  return {
    summary: {
      catalogIdsCount: catalogIds.size,
      retiredCount: retired.size,
      reusedIds: reusedIds || [],
      catalogoUnico,
      advisorsCount: advisors.length,
      uniqueIdsUsedCount: usage.size,
    },
    zombies,
    nonAdvisorEnforced,
    brokenRefs,
    orphans,
    multiOwner,
    ownerMismatch,
  };
}

// ============================================================
// Render
// ============================================================

function render(result) {
  const lines = [];
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('   TYCON Rules Distill — catálogo vs advisors');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  Catálogo: ${CATALOG_PATH.replace(HOME, '~')}`);
  lines.push(`  Advisors: ${AGENTS_DIR.replace(HOME, '~')}`);
  lines.push('');
  lines.push('  Inventory:');
  lines.push(`    Rule IDs activos en catalog: ${result.summary.catalogIdsCount}`);
  lines.push(`    Rule IDs retired (~~tachado~~): ${result.summary.retiredCount}`);
  lines.push(`    Advisors escaneados: ${result.summary.advisorsCount}`);
  lines.push(`    Unique IDs mencionados en advisors: ${result.summary.uniqueIdsUsedCount}`);
  lines.push('');

  // Zombies (REAL — owner es advisor que no cita la regla)
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push(`  ZOMBIES (${result.zombies.length}) — owner es advisor que NO cita la regla`);
  lines.push('───────────────────────────────────────────────────────────────');
  if (result.zombies.length === 0) {
    lines.push('  ✓ Sin zombies. Todas las reglas con owner advisor están citadas por su dueño.');
  } else {
    lines.push('  Fix: (a) agregar la regla al body del advisor, (b) reasignar owner, (c) retirar con ~~ID~~.');
    lines.push('');
    for (const z of result.zombies.slice(0, VERBOSE ? 999 : 20)) {
      lines.push(`    ${z.id.padEnd(16)} owner: ${z.owner}   [sección: ${z.sectionName}]`);
    }
    if (!VERBOSE && result.zombies.length > 20) {
      lines.push(`    ... y ${result.zombies.length - 20} más (--verbose para ver todos)`);
    }
  }
  lines.push('');

  // Non-advisor enforced (informational — owner es hook/skill, no advisor)
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push(`  NON-ADVISOR ENFORCED (${result.nonAdvisorEnforced.length}) — owner es hook o skill, no advisor`);
  lines.push('───────────────────────────────────────────────────────────────');
  if (result.nonAdvisorEnforced.length === 0) {
    lines.push('  (ninguna)');
  } else {
    lines.push('  Esto NO es error — la regla la enforcea un hook/skill en runtime, no un advisor en review.');
    lines.push('  Verificación: el archivo del owner existe y la regla está implementada ahí.');
    lines.push('');
    for (const z of result.nonAdvisorEnforced.slice(0, VERBOSE ? 999 : 20)) {
      lines.push(`    ${z.id.padEnd(16)} owner: ${z.owner}  [${z.ownerType}]   [sección: ${z.sectionName}]`);
    }
    if (!VERBOSE && result.nonAdvisorEnforced.length > 20) {
      lines.push(`    ... y ${result.nonAdvisorEnforced.length - 20} más (--verbose para ver todos)`);
    }
  }
  lines.push('');

  // Broken refs (catalog cita owner que no existe en ningún lado)
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push(`  BROKEN-REFS (${result.brokenRefs.length}) — catalog cita owner inexistente`);
  lines.push('───────────────────────────────────────────────────────────────');
  if (result.brokenRefs.length === 0) {
    lines.push('  ✓ Todos los owners declarados en catalog existen en filesystem.');
  } else {
    lines.push('  Fix: corregir el owner en el catalog (typo, advisor renombrado o removido).');
    lines.push('');
    for (const z of result.brokenRefs.slice(0, VERBOSE ? 999 : 20)) {
      lines.push(`    ${z.id.padEnd(16)} owner declarado (inexistente): ${z.owner}   [sección: ${z.sectionName}]`);
    }
    if (!VERBOSE && result.brokenRefs.length > 20) {
      lines.push(`    ... y ${result.brokenRefs.length - 20} más (--verbose para ver todos)`);
    }
  }
  lines.push('');

  // Orphans
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push(`  ORPHANS (${result.orphans.length}) — advisor cita pero no está en catalog`);
  lines.push('───────────────────────────────────────────────────────────────');
  if (result.orphans.length === 0) {
    lines.push('  ✓ Sin orphans. Todas las reglas mencionadas en advisors están documentadas.');
  } else {
    lines.push('  Fix: agregar al catálogo. Si es uncatalogued intencional, marcar explícito.');
    lines.push('');
    for (const o of result.orphans.slice(0, VERBOSE ? 999 : 20)) {
      lines.push(`    ${o.id.padEnd(16)} citado por: ${o.users.join(', ')}`);
    }
    if (!VERBOSE && result.orphans.length > 20) {
      lines.push(`    ... y ${result.orphans.length - 20} más (--verbose para ver todos)`);
    }
  }
  lines.push('');

  // Multi-owner
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push(`  MULTI-OWNER (${result.multiOwner.length}) — citado por >1 advisor`);
  lines.push('───────────────────────────────────────────────────────────────');
  if (result.multiOwner.length === 0) {
    lines.push('  ✓ Sin reglas multi-owner.');
  } else {
    lines.push('  Esto suele ser OK (regla compartida cross-advisor). Revisar si:');
    lines.push('  - El owner declarado en catalog está entre los que la citan.');
    lines.push('  - Los advisors la enforcean de la misma forma (consistencia).');
    lines.push('');
    for (const m of result.multiOwner.slice(0, VERBOSE ? 999 : 20)) {
      const catalogOk = m.users.includes(m.catalogOwner) ? '✓' : '⚠';
      lines.push(`    ${m.id.padEnd(16)} ${catalogOk} catalog: ${m.catalogOwner}  |  citan: ${m.users.join(', ')}`);
    }
    if (!VERBOSE && result.multiOwner.length > 20) {
      lines.push(`    ... y ${result.multiOwner.length - 20} más (--verbose para ver todos)`);
    }
  }
  lines.push('');

  // Owner mismatch
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push(`  OWNER-MISMATCH (${result.ownerMismatch.length}) — catalog dice X, X no la cita`);
  lines.push('───────────────────────────────────────────────────────────────');
  if (result.ownerMismatch.length === 0) {
    lines.push('  ✓ Todos los owners declarados en catalog citan sus reglas.');
  } else {
    lines.push('  Fix: actualizar el owner en el catalog al advisor que la enforce de verdad.');
    lines.push('');
    for (const om of result.ownerMismatch.slice(0, VERBOSE ? 999 : 20)) {
      lines.push(`    ${om.id.padEnd(16)} catalog: ${om.declaredOwner}   real: ${om.actualOwners.join(', ')}`);
    }
    if (!VERBOSE && result.ownerMismatch.length > 20) {
      lines.push(`    ... y ${result.ownerMismatch.length - 20} más (--verbose para ver todos)`);
    }
  }
  lines.push('');

  // Resumen accionable
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('  Resumen accionable');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');
  const total = result.zombies.length + result.brokenRefs.length + result.orphans.length + result.ownerMismatch.length;
  if (total === 0) {
    lines.push('  ✓ Catálogo sincronizado con advisors. Cero drift estructural.');
  } else {
    lines.push(`  ${result.zombies.length} zombies (advisor no cita regla declarada como suya)`);
    lines.push(`  ${result.brokenRefs.length} broken-refs (owner inexistente)`);
    lines.push(`  ${result.orphans.length} orphans (advisor cita regla no documentada)`);
    lines.push(`  ${result.ownerMismatch.length} owner-mismatches`);
    lines.push(`  ${result.nonAdvisorEnforced.length} non-advisor enforced (informativo, no error)`);
    lines.push('');
    lines.push('  Prioridad sugerida: BROKEN-REFS (catalog miente) → ORPHANS (regla invisible)');
    lines.push('  → ZOMBIES (regla doc sin advisor que la cite) → OWNER-MISMATCH.');
  }
  lines.push('');
  lines.push('  Notas:');
  lines.push('  - Falsos positivos típicos: mención del ID en anti-pattern ("NO inventes SEC-C1")');
  lines.push('    cuenta como cita. Filtrá manualmente si el orphan es claramente meta.');
  lines.push('  - Retired IDs (~~SEC-W4~~) NO se reportan como zombies — están retirados a propósito.');
  lines.push('  - Multi-owner es WARNING informativo, no error. Vale la pena si la regla es compartida.');
  lines.push('  - Re-correr post-cambio: node ~/.claude/tycon-harness/scripts/tools/rules-distill.js');
  lines.push('');

  return lines.join('\n');
}

// ============================================================
// Main
// ============================================================

const result = distill();
if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(render(result));
}
