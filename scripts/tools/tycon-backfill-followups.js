#!/usr/bin/env node
/**
 * tycon-backfill-followups.js — sincroniza back-links `followed_up_by:` en
 * stories Mary+GOLD basándose en los `followup_of:` declarados en las hijas.
 *
 * Convención: ~/.claude/tycon-harness/story-format.md §1.2.
 *
 * Uso:
 *   node tycon-backfill-followups.js [--dir <path>] [--apply] [--story <id>] [--render-table] [--detect]
 *
 * Flags:
 *   --dir <path>      Raíz desde la que descubrir stories, RECURSIVA. Default: cwd.
 *                     (Hasta 2026-08-15 era "directorio con stories `.md`" y NO bajaba niveles:
 *                     contra un repo con las stories anidadas avisaba "0 stories encontradas".)
 *   --apply           Aplicar los cambios. Default: dry-run (solo reporta).
 *   --story <id>      Procesar solo follow-ups que involucren la story <id>
 *                     (filtro — útil para back-fillear UNA padre puntual).
 *   --render-table    En vez de patch, imprime una tabla markdown de la cascada
 *                     (padre <id> + sus follow-ups + nietos). Requiere --story.
 *   --detect          Modo heurístico: escanea stories que NO declaran
 *                     `followup_of:` pero que LUCEN como follow-ups (title con
 *                     keyword, approach [MODIFY], depends_on no vacío) y emite
 *                     un reporte de CANDIDATOS para que el dev curate y agregue
 *                     `followup_of:` manualmente. NO escribe nada — es output
 *                     informativo. Útil para back-fill de repos viejos antes
 *                     de tener la convención.
 *
 * Output (dry-run):
 *   - Lista de back-links que faltan agregar (padre → entry propuesta).
 *   - Lista de back-links orphan (padre tiene un id que no resuelve a hija).
 *   - Lista de desync (recíproco existe pero type/summary difieren).
 *
 * Output (--apply):
 *   - Lo de arriba + edita los archivos in-place.
 *   - Exit code 0 si OK, 1 si algún archivo no se pudo escribir.
 *
 * Idempotente: corre N veces sin duplicar entries.
 * Sin dependencias de npm a propósito (sin lib YAML — parser minimalista local). La ÚNICA
 * dependencia externa es `lib/story-discovery.js` del skill `tycon-pipeline`, resuelto por ruta
 * fija con fail-open: es el descubridor único del arnés, y tenerlo duplicado acá fue el bug.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ============================================================
// Args
// ============================================================

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return null;
  return args[idx + 1] || '';
}
function hasFlag(name) {
  return args.indexOf(`--${name}`) >= 0;
}

const dir = getFlag('dir') || process.cwd();
const apply = hasFlag('apply');
const filterStory = getFlag('story') || null;
const renderTable = hasFlag('render-table');
const detect = hasFlag('detect');

if (renderTable && !filterStory) {
  console.error('error: --render-table requiere --story <id>');
  process.exit(2);
}
if (detect && apply) {
  console.error('error: --detect es report-only por diseño (no edita archivos). No combina con --apply.');
  process.exit(2);
}

if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`error: --dir '${dir}' no es un directorio`);
  process.exit(2);
}

const VALID_TYPES = new Set(['fix', 'scope-change', 'recalibration', 'gap-fill', 'extension']);

// ============================================================
// Frontmatter parsing (minimalista, sin libs)
// ============================================================

function readStory(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const trimmed = content.replace(/^﻿/, '');
  if (!trimmed.startsWith('---')) return null;
  const end = trimmed.indexOf('\n---', 3);
  if (end < 0) return null;
  const fm = trimmed.slice(3, end);
  const body = trimmed.slice(end + 4);
  return { content, fm, body, raw: trimmed };
}

function scalar(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}

/**
 * Parsea `depends_on: ["X.Y", "Z.W"]` (inline list) o `depends_on: []`.
 * Devuelve array de strings. [] si el campo no existe o está vacío.
 */
function parseDependsOn(fm) {
  const m = fm.match(/^depends_on:\s*\[([^\]]*)\]\s*$/m);
  if (!m) return [];
  const inner = m[1].trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, ''))
    .filter((s) => s.length > 0);
}

function parseListField(fm, fieldName) {
  // Soporta:
  //   <field>:
  //     - id: "X.Y"
  //       type: "fix"
  //       summary: "..."
  //       date: "YYYY-MM-DD"     (solo en followed_up_by:)
  const startRegex = new RegExp(`^${fieldName}:\\s*$`, 'm');
  const startMatch = fm.match(startRegex);
  if (!startMatch) return [];
  const startIdx = startMatch.index + startMatch[0].length;
  const rest = fm.slice(startIdx);
  const lines = rest.split('\n').slice(1);
  const blockLines = [];
  for (const line of lines) {
    if (/^[^\s-].*:/.test(line)) break;
    if (/^---\s*$/.test(line)) break;
    blockLines.push(line);
  }
  const items = [];
  let current = null;
  for (const line of blockLines) {
    const itemStart = line.match(/^\s*-\s*id:\s*"?([^"\n]+?)"?\s*$/);
    if (itemStart) {
      if (current) items.push(current);
      current = { id: itemStart[1].trim() };
      continue;
    }
    if (!current) continue;
    const typeM = line.match(/^\s*type:\s*"?([^"\n]+?)"?\s*$/);
    if (typeM) {
      current.type = typeM[1].trim();
      continue;
    }
    const sumM = line.match(/^\s*summary:\s*"?([^"\n]+?)"?\s*$/);
    if (sumM) {
      current.summary = sumM[1].trim();
      continue;
    }
    const dateM = line.match(/^\s*date:\s*"?([^"\n]+?)"?\s*$/);
    if (dateM) {
      current.date = dateM[1].trim();
      continue;
    }
  }
  if (current) items.push(current);
  return items;
}

// ============================================================
// Scan: build index of stories in dir
// ============================================================

// ── Descubrimiento: EL MISMO del resto del arnés, no uno propio (2026-08-15) ─────────────────
// Este script tenía su propio buscador: un `readdirSync(dir)` PLANO, que sólo veía los `.md`
// sueltos del directorio recibido. En un repo del equipo —stories en `specs/bizuit-bpmn-mcp/`— corrido
// desde la raíz del repo avisaba "0 stories Mary+GOLD encontradas". El arnés tenía DOS buscadores
// en dos repos distintos, así que arreglar uno dejaba el otro roto: es lo que efectivamente pasó.
// Ahora delega en `lib/story-discovery.js` del skill `tycon-pipeline` (fuente única), con la misma
// convención de referencia-por-path que `lint-story-frontmatter.js`: el módulo vive en un solo
// lado y se resuelve por ruta fija, con override por env y fail-open RUIDOSO si no está.
const SKILLS_DIR = process.env.TYCON_SKILLS_DIR || path.join(os.homedir(), '.claude', 'agent-skills', 'skills');
const DISCOVERY_PATH = path.join(SKILLS_DIR, 'tycon-pipeline', 'scripts', 'lib', 'story-discovery.js');
let discovery = null;
try {
  discovery = require(DISCOVERY_PATH);
} catch (e) {
  console.error(`⚠️  no pude cargar el descubridor de stories del arnés (${DISCOVERY_PATH}): ${e.message}`);
  console.error('    Se cae al escaneo PLANO del directorio (sólo los .md sueltos, sin bajar niveles).');
  console.error('    Instalá el skill tycon-pipeline (onboarding) o exportá TYCON_SKILLS_DIR.');
}

/** Los `.md` que son stories bajo `root`. Fallback plano si el descubridor no está disponible. */
function storyFilesUnder(root) {
  if (discovery) {
    // `--dir` puede apuntar a un subárbol; el `.tycon/advisors.yaml` que manda es el DEL REPO.
    const configRoot = discovery.findRepoRoot(root) || root;
    const found = discovery.discoverStories(root, { configRoot, budgetMs: 15000, cache: false });
    for (const w of found.warnings) console.error(`⚠️  ${w}`);
    return found.stories.map((s) => s.path);
  }
  try {
    return fs.readdirSync(root).filter((f) => f.endsWith('.md')).map((f) => path.join(root, f));
  } catch {
    return [];
  }
}

function scanStories(dir) {
  const stories = [];
  const byId = new Map();
  for (const abs of storyFilesUnder(dir)) {
    const f = path.basename(abs);
    const parsed = readStory(abs);
    if (!parsed) continue;
    const storyId = scalar(parsed.fm, 'story');
    const statusVal = scalar(parsed.fm, 'status');
    if (!storyId || !statusVal) continue;
    const followupOf = parseListField(parsed.fm, 'followup_of');
    const followedUpBy = parseListField(parsed.fm, 'followed_up_by');
    const dependsOn = parseDependsOn(parsed.fm);
    const approach = scalar(parsed.fm, 'approach') || '';
    const s = {
      id: storyId,
      path: abs,
      filename: f,
      title: scalar(parsed.fm, 'title') || '(sin título)',
      status: statusVal,
      approach,
      dependsOn,
      followupOf,
      followedUpBy,
      parsed,
    };
    stories.push(s);
    byId.set(storyId, s);
  }
  return { stories, byId };
}

// ============================================================
// Analyze: detect missing back-links + orphans + desync + invalid types
// ============================================================

function analyze({ stories, byId }) {
  const issues = []; // { kind, parent, child, item, expected? }

  for (const child of stories) {
    for (const item of child.followupOf) {
      if (!item.id) continue;
      // Type check
      if (item.type && !VALID_TYPES.has(item.type)) {
        issues.push({
          kind: 'invalid-type-in-followup_of',
          child,
          item,
          parentId: item.id,
        });
      }
      const parent = byId.get(item.id);
      if (!parent) {
        issues.push({
          kind: 'parent-not-found',
          child,
          item,
          parentId: item.id,
        });
        continue;
      }
      const reciprocal = parent.followedUpBy.find((e) => e.id === child.id);
      if (!reciprocal) {
        issues.push({
          kind: 'missing-backlink',
          parent,
          child,
          item,
        });
      } else {
        // Desync check
        if (item.type && reciprocal.type && item.type !== reciprocal.type) {
          issues.push({
            kind: 'desync-type',
            parent,
            child,
            item,
            reciprocal,
          });
        }
        if (item.summary && reciprocal.summary && item.summary !== reciprocal.summary) {
          issues.push({
            kind: 'desync-summary',
            parent,
            child,
            item,
            reciprocal,
          });
        }
      }
    }
  }

  // Reverse check: orphan back-links in parents
  for (const parent of stories) {
    for (const entry of parent.followedUpBy) {
      if (!entry.id) continue;
      if (entry.type && !VALID_TYPES.has(entry.type)) {
        issues.push({
          kind: 'invalid-type-in-followed_up_by',
          parent,
          entry,
        });
      }
      const child = byId.get(entry.id);
      if (!child) {
        issues.push({
          kind: 'orphan-backlink-child-not-found',
          parent,
          entry,
          childId: entry.id,
        });
        continue;
      }
      const reciprocal = child.followupOf.find((e) => e.id === parent.id);
      if (!reciprocal) {
        issues.push({
          kind: 'orphan-backlink-no-reciprocal',
          parent,
          child,
          entry,
        });
      }
    }
  }
  return issues;
}

// ============================================================
// Detect: heurístico para identificar stories que LUCEN como follow-ups
// pero no declaran `followup_of:`. Output: report-only.
// ============================================================

// Keywords case-insensitive (sin acentos) que sugieren follow-up en el title.
// Cada keyword sugiere un `type:` por default — el dev refina.
const FOLLOWUP_KEYWORDS = [
  { pattern: /\bfollow[-_ ]?up\b/i, type: 'fix' },
  { pattern: /\bfixe?(?:o|ar|s)?\b/i, type: 'fix' },
  { pattern: /\bbug[-_ ]?fix\b/i, type: 'fix' },
  { pattern: /\bcorreccion(?:es)?\b/i, type: 'fix' },
  { pattern: /\bcorreccion[oóeéa]\b/i, type: 'fix' },
  { pattern: /\bcorrige?\b/i, type: 'fix' },
  { pattern: /\bpolish(?:ing)?\b/i, type: 'fix' },
  { pattern: /\bhardening\b/i, type: 'fix' },
  { pattern: /\bconsistencia\b/i, type: 'fix' },
  { pattern: /\bconsistency\b/i, type: 'fix' },
  { pattern: /\breconciliaci[oó]n\b/i, type: 'fix' },
  { pattern: /\breconciliation\b/i, type: 'fix' },
  { pattern: /\bgap[-_ ]?fill\b/i, type: 'gap-fill' },
  { pattern: /\bgap\b/i, type: 'gap-fill' },
  { pattern: /\brecalibraci[oó]n\b/i, type: 'recalibration' },
  { pattern: /\brecalibration\b/i, type: 'recalibration' },
  { pattern: /\bscope[-_ ]?change\b/i, type: 'scope-change' },
  { pattern: /\bcambio[-_ ]?scope\b/i, type: 'scope-change' },
  { pattern: /\bextension\b/i, type: 'extension' },
  { pattern: /\brework\b/i, type: 'recalibration' },
];

function detectFollowupSignals(story) {
  const signals = [];
  let inferredType = null;
  for (const kw of FOLLOWUP_KEYWORDS) {
    if (kw.pattern.test(story.title)) {
      signals.push(`title-keyword: ${kw.pattern.source.replace(/\\b/g, '')}`);
      if (!inferredType) inferredType = kw.type;
    }
  }
  if (story.approach === '[MODIFY]') {
    signals.push('approach: [MODIFY]');
    if (!inferredType) inferredType = 'fix';
  }
  // [ADAPT] alone (no title keyword) NO marca — falso positivo común
  // (se usa para adaptar patrones de proyectos hermanos, NO para modificar
  // una story previa).
  return { signals, inferredType };
}

function detectCandidates({ stories, byId }) {
  const candidates = [];
  for (const s of stories) {
    if (s.followupOf.length > 0) continue; // ya declarado — no es candidato
    if (s.dependsOn.length === 0) continue; // sin depends_on, no hay padre posible
    const { signals, inferredType } = detectFollowupSignals(s);
    if (signals.length === 0) continue;
    // Resolver depends_on contra stories del dir
    const potentialParents = s.dependsOn.map((parentId) => {
      const parent = byId.get(parentId);
      return {
        id: parentId,
        found: !!parent,
        title: parent ? parent.title : null,
        status: parent ? parent.status : null,
      };
    });
    candidates.push({
      story: s,
      signals,
      inferredType: inferredType || 'fix',
      potentialParents,
    });
  }
  return candidates;
}

// ============================================================
// Patch: inject `followed_up_by:` entry into parent frontmatter
// ============================================================

/**
 * Devuelve el nuevo contenido completo del archivo padre con el back-link
 * agregado. Idempotente (si ya existe, no-op).
 *
 * Estrategia simple: trabajar sobre el bloque de frontmatter (entre los dos
 * `---`), insertar/extender el campo `followed_up_by:`, y reconstruir.
 */
function injectBacklink(parentParsed, child, item, today) {
  const fm = parentParsed.fm;
  const body = parentParsed.body;
  const newEntry = `  - id: "${child.id}"
    date: "${today}"
    type: "${item.type || 'fix'}"
    summary: "${(item.summary || '').replace(/"/g, "'")}"`;

  // ¿Ya existe followed_up_by:?
  const existingMatch = fm.match(/^followed_up_by:\s*$/m);
  let newFm;
  if (existingMatch) {
    // Encontrar fin del bloque
    const startIdx = existingMatch.index + existingMatch[0].length;
    const rest = fm.slice(startIdx);
    const lines = rest.split('\n');
    // endLineIdx = índice de la ÚLTIMA línea NO-VACÍA del bloque
    // (los empty lines no cuentan — así el newEntry se inserta inmediatamente
    // después de la última entry real, sin blank line intermedia).
    let endLineIdx = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^[^\s-].*:/.test(line)) break; // otro field del frontmatter
      if (/^---\s*$/.test(line)) break;
      if (line !== '') endLineIdx = i; // ignora trailing/internal empties
    }
    // Insertar newEntry justo después de la última entry real
    const before = lines.slice(0, endLineIdx + 1).join('\n');
    const after = lines.slice(endLineIdx + 1).join('\n');
    const newBlock = before + '\n' + newEntry + (after ? '\n' + after : '');
    newFm = fm.slice(0, startIdx) + newBlock;
  } else {
    // Crear el campo nuevo. Lo agregamos al final del frontmatter, antes del cierre.
    // El frontmatter en parsed.fm es el CONTENIDO entre los `---`, sin los delimitadores.
    // Si termina en newline, mantener. NO agregamos trailing \n al final — el
    // return statement abajo (`'\n---' + body`) provee el separator del closing
    // delimiter; un \n extra acá crearía una blank line antes del `---`.
    const sep = fm.endsWith('\n') ? '' : '\n';
    newFm = fm + sep + 'followed_up_by:\n' + newEntry;
  }
  return '---' + newFm + '\n---' + body;
}

// ============================================================
// Render: cascade table for one parent id
// ============================================================

/**
 * `from` = carpeta desde la que se leerá la tabla (la de la story raíz de la cascada). Desde que el
 * descubrimiento es recursivo (2026-08-15), padre e hija pueden vivir en carpetas distintas: un
 * link `./<basename>` sólo era correcto cuando todas las stories estaban en un mismo directorio
 * plano. Se calcula relativo de verdad, y en POSIX porque es markdown, no filesystem.
 */
function renderCascade(byId, storyId, depth = 0, visited = new Set(), from = null) {
  const lines = [];
  if (visited.has(storyId)) return lines;
  visited.add(storyId);
  const s = byId.get(storyId);
  if (!s) {
    lines.push(`${'  '.repeat(depth)}- ${storyId} *(no encontrado)*`);
    return lines;
  }
  const base = from || path.dirname(s.path);
  const rel = path.relative(base, s.path).split(path.sep).join('/');
  const href = rel.startsWith('.') ? rel : `./${rel}`;
  const prefix = '  '.repeat(depth);
  lines.push(`${prefix}- **${s.id}** — ${s.title} *(${s.status})* · [\`${s.filename}\`](${href})`);
  for (const entry of s.followedUpBy) {
    const childLines = renderCascade(byId, entry.id, depth + 1, visited, base);
    lines.push(...childLines);
  }
  return lines;
}

// ============================================================
// Main
// ============================================================

const index = scanStories(dir);
if (index.stories.length === 0) {
  // Un cero acá casi nunca significa "el repo no tiene stories": significa que no las encontró.
  // Por eso el mensaje dice QUÉ está buscando y con qué comando ver el detalle.
  console.error(`warn: 0 stories Mary+GOLD encontradas en ${dir}`);
  console.error('      Una story es un .md cuyo frontmatter declara `story:` y `status:`, con un id de forma');
  console.error('      jerárquica numérica (4.43). Si este repo usa otra forma, declarala en');
  console.error('      .tycon/advisors.yaml → stories.id_pattern. Diagnóstico:');
  console.error(`      node ${DISCOVERY_PATH} --doctor --repo ${dir}`);
  process.exit(0);
}

if (detect) {
  const candidates = detectCandidates(index);
  console.log(`# tycon-backfill-followups --detect — Candidatos heurísticos\n`);
  console.log(`**Dir**: ${dir}`);
  console.log(`**Stories revisadas**: ${index.stories.length}`);
  console.log(`**Candidatos encontrados**: ${candidates.length}`);
  if (filterStory) console.log(`**Filtro**: --story ${filterStory}`);
  console.log('');
  console.log(`> ⚠ **Esto es heurístico — NO escribe nada.** Revisá cada candidato y agregá `);
  console.log(`> \`followup_of:\` a mano en las stories que sean follow-ups reales. Después corré`);
  console.log(`> \`tycon-backfill-followups.js --apply\` (sin --detect) para que se propaguen los `);
  console.log(`> back-links \`followed_up_by:\` automáticamente.\n`);
  console.log(`**Heurística**: title contiene keyword de fix/recalibration/gap/polish/etc.`);
  console.log(`**OR** \`approach: [MODIFY]\`. \`[ADAPT]\` solo NO marca (alto falso positivo —`);
  console.log(`se usa para adaptar patrones de proyectos hermanos).\n`);

  let filtered = candidates;
  if (filterStory) {
    filtered = candidates.filter((c) =>
      c.story.id === filterStory || c.potentialParents.some((p) => p.id === filterStory),
    );
  }
  if (filtered.length === 0) {
    console.log(`✓ Sin candidatos.\n`);
    process.exit(0);
  }
  // Tabla resumen
  console.log(`## Resumen\n`);
  console.log(`| Story | Title | Approach | Signals | depends_on candidatos (parent) |`);
  console.log(`|---|---|---|---|---|`);
  for (const c of filtered) {
    const parents = c.potentialParents.map((p) => p.found ? `**${p.id}**` : `~~${p.id}~~`).join(', ');
    console.log(
      `| \`${c.story.id}\` | ${c.story.title.slice(0, 60)} | ${c.story.approach} | ${c.signals.length} | ${parents} |`,
    );
  }
  console.log('');
  console.log(`> Negrita = padre encontrada en el dir. ~~Tachado~~ = padre no encontrada (id en depends_on que no existe).\n`);

  console.log(`## Detalle por candidato\n`);
  for (const c of filtered) {
    console.log(`### \`${c.story.id}\` — ${c.story.title}\n`);
    console.log(`- **Archivo**: \`${c.story.path}\``);
    console.log(`- **Approach**: \`${c.story.approach}\``);
    console.log(`- **Status**: \`${c.story.status}\``);
    console.log(`- **Señales detectadas**:`);
    for (const s of c.signals) console.log(`  - ${s}`);
    console.log(`- **Type inferido por heurística**: \`${c.inferredType}\` *(refinar a mano si no aplica)*`);
    console.log(`- **depends_on declarado**: ${c.story.dependsOn.map((id) => `\`${id}\``).join(', ') || '(vacío)'}`);
    console.log(`- **Padres potenciales**:`);
    for (const p of c.potentialParents) {
      if (p.found) {
        console.log(`  - \`${p.id}\` — ${p.title} *(${p.status})*`);
      } else {
        console.log(`  - \`${p.id}\` — *(no encontrada en este dir)*`);
      }
    }
    console.log('');
    const foundParents = c.potentialParents.filter((p) => p.found);
    if (foundParents.length > 0) {
      console.log(`**Sugerencia de \`followup_of:\` a agregar en el frontmatter de \`${c.story.filename}\`**:\n`);
      console.log('```yaml');
      console.log('followup_of:');
      for (const p of foundParents) {
        console.log(`  - id: "${p.id}"`);
        console.log(`    type: "${c.inferredType}"`);
        console.log(`    summary: "<COMPLETAR — qué cambia respecto a lo que entregó la padre>"`);
      }
      console.log('```\n');
    }
    console.log('---\n');
  }
  console.log(`\n**Próximo paso**:`);
  console.log(`1. Revisar cada candidato — ¿es realmente follow-up de su(s) padre(s)?`);
  console.log(`2. Si sí: editar la hija agregando \`followup_of:\` con type + summary curados.`);
  console.log(`3. Si NO (falso positivo): ignorar — no agregar nada.`);
  console.log(`4. Al terminar, correr \`tycon-backfill-followups.js --dir ${dir} --apply\` para`);
  console.log(`   propagar los back-links \`followed_up_by:\` a las padres automáticamente.`);
  process.exit(0);
}

if (renderTable) {
  console.log(`# Cascada de follow-ups para Story ${filterStory}\n`);
  console.log(`*(Generado por \`tycon-backfill-followups.js --render-table\` · ${new Date().toISOString().slice(0, 10)})*\n`);
  const lines = renderCascade(index.byId, filterStory);
  if (lines.length === 0) {
    console.log(`Story \`${filterStory}\` no encontrada en \`${dir}\`.`);
    process.exit(1);
  }
  console.log(lines.join('\n'));
  // Tabla resumen plana
  const root = index.byId.get(filterStory);
  if (root && root.followedUpBy.length > 0) {
    console.log('\n## Follow-ups directos\n');
    console.log('| # | Story | Fecha | Tipo | Qué cambia |');
    console.log('|---|---|---|---|---|');
    let i = 1;
    for (const entry of root.followedUpBy) {
      const child = index.byId.get(entry.id);
      const href = child ? `[\`${entry.id}\`](./${child.filename})` : `\`${entry.id}\``;
      console.log(
        `| ${i++} | ${href} | ${entry.date || '?'} | ${entry.type || '?'} | ${entry.summary || '?'} |`,
      );
    }
  }
  process.exit(0);
}

// Modo análisis + (opcional) apply
let issues = analyze(index);

if (filterStory) {
  issues = issues.filter((iss) => {
    const ids = [
      iss.child?.id,
      iss.parent?.id,
      iss.parentId,
      iss.childId,
    ].filter(Boolean);
    return ids.includes(filterStory);
  });
}

if (issues.length === 0) {
  console.log(`✓ tycon-backfill-followups: nada que sincronizar en ${dir} (${index.stories.length} stories revisadas).`);
  process.exit(0);
}

// ============================================================
// Report by kind
// ============================================================

const byKind = {};
for (const iss of issues) {
  byKind[iss.kind] = byKind[iss.kind] || [];
  byKind[iss.kind].push(iss);
}

console.log(`# tycon-backfill-followups — Reporte\n`);
console.log(`**Dir**: ${dir}`);
console.log(`**Stories revisadas**: ${index.stories.length}`);
console.log(`**Issues encontrados**: ${issues.length}`);
console.log(`**Modo**: ${apply ? '🔧 APPLY (edita archivos)' : '🔍 DRY-RUN (solo reporta)'}`);
if (filterStory) console.log(`**Filtro**: --story ${filterStory}`);
console.log('');

const KIND_LABELS = {
  'missing-backlink': '🔗 Back-links faltantes (hija → padre sin recíproco)',
  'parent-not-found': '❓ followup_of: a una padre que NO existe en el dir',
  'orphan-backlink-child-not-found': '👻 followed_up_by: con id de hija que NO existe',
  'orphan-backlink-no-reciprocal': '⚠ followed_up_by: con hija que no declara `followup_of:` recíproco',
  'desync-type': '🔀 type desincronizado entre hija y padre',
  'desync-summary': '🔀 summary desincronizado entre hija y padre',
  'invalid-type-in-followup_of': '🏷 type inválido en `followup_of:` (no enumerado)',
  'invalid-type-in-followed_up_by': '🏷 type inválido en `followed_up_by:` (no enumerado)',
};

let applied = 0;
let applyErrors = 0;

for (const kind of Object.keys(byKind)) {
  const list = byKind[kind];
  console.log(`## ${KIND_LABELS[kind] || kind} (${list.length})\n`);
  for (const iss of list) {
    if (kind === 'missing-backlink') {
      console.log(`- **Hija** \`${iss.child.id}\` declara followup_of \`${iss.item.id}\`, **padre** \`${iss.parent.id}\` no tiene back-link.`);
      console.log(`  - Padre: \`${iss.parent.path}\``);
      console.log(`  - Hija: \`${iss.child.path}\``);
      console.log(`  - Patch propuesto:`);
      console.log('    ```yaml');
      console.log(`    followed_up_by:`);
      console.log(`      - id: "${iss.child.id}"`);
      const today = new Date().toISOString().slice(0, 10);
      console.log(`        date: "${today}"`);
      console.log(`        type: "${iss.item.type || 'fix'}"`);
      console.log(`        summary: "${(iss.item.summary || '').replace(/"/g, "'")}"`);
      console.log('    ```');
      if (apply) {
        try {
          const today = new Date().toISOString().slice(0, 10);
          const newContent = injectBacklink(iss.parent.parsed, iss.child, iss.item, today);
          fs.writeFileSync(iss.parent.path, newContent, 'utf8');
          console.log(`  - ✓ APPLIED`);
          applied++;
          // Refresh parent parsed so subsequent inserts to the same parent stack on top
          const refreshed = readStory(iss.parent.path);
          if (refreshed) iss.parent.parsed = refreshed;
        } catch (e) {
          console.log(`  - ✗ ERROR al escribir: ${e.message}`);
          applyErrors++;
        }
      }
    } else if (kind === 'parent-not-found') {
      console.log(`- **Hija** \`${iss.child.id}\` declara followup_of \`${iss.parentId}\` — padre NO encontrada en ${dir}.`);
      console.log(`  - Hija: \`${iss.child.path}\``);
      console.log(`  - Acción: verificar id, o documentar en prosa si la padre vive en otro repo.`);
    } else if (kind === 'orphan-backlink-child-not-found') {
      console.log(`- **Padre** \`${iss.parent.id}\` tiene followed_up_by con id \`${iss.childId}\` — hija NO encontrada.`);
      console.log(`  - Padre: \`${iss.parent.path}\``);
      console.log(`  - Acción: la hija se renombró/borró. Verificar id o remover el entry orphan.`);
    } else if (kind === 'orphan-backlink-no-reciprocal') {
      console.log(`- **Padre** \`${iss.parent.id}\` linkea a hija \`${iss.child.id}\` que NO tiene followup_of recíproco.`);
      console.log(`  - Padre: \`${iss.parent.path}\``);
      console.log(`  - Hija: \`${iss.child.path}\``);
      console.log(`  - Acción: (a) agregar followup_of a la hija, o (b) remover el entry del followed_up_by de la padre.`);
    } else if (kind === 'desync-type' || kind === 'desync-summary') {
      const field = kind === 'desync-type' ? 'type' : 'summary';
      console.log(`- **${field}** desync entre hija \`${iss.child.id}\` y padre \`${iss.parent.id}\`.`);
      console.log(`  - Hija (followup_of): ${field}=\`${iss.item[field]}\``);
      console.log(`  - Padre (followed_up_by): ${field}=\`${iss.reciprocal[field]}\``);
      console.log(`  - Acción: sincronizar (la hija es source-of-truth — actualizar la padre).`);
    } else if (kind === 'invalid-type-in-followup_of') {
      console.log(`- **Hija** \`${iss.child.id}\` followup_of con type=\`${iss.item.type}\` inválido (válidos: ${[...VALID_TYPES].join(', ')}).`);
      console.log(`  - Hija: \`${iss.child.path}\``);
    } else if (kind === 'invalid-type-in-followed_up_by') {
      console.log(`- **Padre** \`${iss.parent.id}\` followed_up_by con type=\`${iss.entry.type}\` inválido.`);
      console.log(`  - Padre: \`${iss.parent.path}\``);
    }
    console.log('');
  }
}

console.log('---\n');
if (apply) {
  console.log(`✓ Aplicados: ${applied} · ✗ Errores: ${applyErrors}`);
  if (applyErrors > 0) process.exit(1);
} else {
  const fixable = (byKind['missing-backlink'] || []).length;
  if (fixable > 0) {
    console.log(`Para aplicar los ${fixable} back-link(s) faltante(s) automáticamente:`);
    console.log(`  node ${path.basename(__filename)} --dir ${dir}${filterStory ? ' --story ' + filterStory : ''} --apply`);
  }
  console.log(`\nOtros issues (desync, orphans, types inválidos, padre no encontrada) requieren intervención manual.`);
}

process.exit(0);
