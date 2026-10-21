#!/usr/bin/env node
/**
 * build/generate.js — ÚNICA pieza de traducción del harness (plan codex-migration.md §3).
 *
 * Familia única que traduce: los advisors. Canónico: agents/<name>.md (markdown con
 * frontmatter YAML, repo agent-skills). Emite: adapters/codex/agents/<name>.toml — un
 * config-overlay de Codex que se despliega como profile ($CODEX_HOME/<name>.config.toml)
 * y se invoca con `codex exec -p <name>` (verificado: -p layerea ese archivo sobre la
 * config base, Codex CLI 0.149.0).
 *
 * Qué traduce (todo lo de nombre sale de build/equivalences.json — categoría ②):
 *   - model (sonnet/opus/haiku → slug de Codex)
 *   - tools: → sandbox_mode (la lista blanca por-tool no existe en Codex; asimetría
 *     declarada)
 *   - tools mcp__<etiqueta>__<tool> → tablas [mcp_servers.<etiqueta>]. La etiqueta se REPLICA
 *     de Claude a propósito: el modelo ve mcp__<etiqueta>__<tool>, así que el nombre sale
 *     idéntico en las dos herramientas y la prosa del advisor NO se traduce.
 *     Un servidor que no se puede declarar en un perfil estático (codegraph: la ruta del índice
 *     cambia por repo) se OMITE y queda escrito en la cabecera del .toml — asimetría declarada,
 *     nunca silencio. Una etiqueta sin decisión hace fallar al generador.
 *   - features de Codex que un advisor no necesita → features.<name> = false (apps: ~160 tools
 *     de servicios externos que el sandbox de disco no frena porque no pasan por el disco).
 *   - el cuerpo del advisor → developer_instructions (system prompt del subagente),
 *     con las menciones de tools de Claude sustituidas por su descripción funcional
 *
 * ⚠️ ORDEN DEL TOML — no es cosmético: toda clave suelta va ANTES de la primera tabla, o TOML
 * se la come adentro de esa tabla y el perfil no carga. assertLooseKeysFirst() lo hace fallar
 * acá, en el generador, en vez de a los minutos de un `codex exec` que no arranca.
 *
 * Qué NO hace: no toca hooks, ni skills, ni guías, ni CLAUDE.md (principio 2: un solo
 * generador para una sola familia — si esto crece a otra familia, se convierte en un
 * compilador y hay que frenar).
 *
 * El set de advisors migrados vive en adapters/codex/agents/MANIFEST.json — un advisor
 * entra al manifest cuando entra CON sus casos en el banco (regla dura B2).
 *
 * Uso:
 *   node build/generate.js                  regenera todos los del manifest
 *   node build/generate.js --add <name>     suma un advisor al manifest y lo genera
 *   node build/generate.js --check          ¿adapters al día con el canónico? exit 1 si no (pre-commit)
 *   node build/generate.js --deploy         copia los .toml generados a $CODEX_HOME/<name>.config.toml
 *   node build/generate.js --deploy-only    copia los .toml QUE YA ESTÁN en adapters/ a $CODEX_HOME, sin regenerar nada
 *                                           (en una versión bajada el árbol no se escribe —cada
 *                                           archivo tiene el hash con que se bajó, y regenerar un .toml lo dejaría
 *                                           «editado»—; lo publicado ya viene generado). Y los revisores de la capa del
 *                                           equipo: la capa no trae .toml —un .toml puede
 *                                           declarar comandos que Codex lanza—, así que se GENERAN acá desde su .md, con
 *                                           el generador y las equivalencias de esta versión, directo a $CODEX_HOME
 *                                           (nunca al árbol). Un revisor de la capa que no se puede generar se dice y no
 *                                           frena nada (sale 0): un defecto de la capa no vuelve atrás una versión.
 *
 * Exporta `generateOne(root, name)` (los agentes y las equivalencias de ESA raíz, nunca de una constante del módulo ni de
 * TYCON_AGENTS_DIR) y `advisorsToDeploy(root)` → `{ manifest, team }`: la misma lista la usan este despliegue y la paridad.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
// Las equivalencias de una raíz (la capa del equipo se genera con las de
// la versión INSTALADA, y team-repo.js con las de la versión publicada). Guardado: si equivalences.json está roto
// (mid-merge, truncado), REQUERIR este módulo no puede tirar — el audit de paridad lo importa y su regla es "el reporte se
// escribe siempre". main() falla claro con el error; deployPairs() no lo necesita.
function loadEq(root) { try { return JSON.parse(fs.readFileSync(path.join(root, 'build', 'equivalences.json'), 'utf8')); } catch (e) { return { __error: e.message }; } }
const EQ = loadEq(ROOT);
// La carpeta de agentes: TYCON_AGENTS_DIR, o la de agent-skills que resuelve el arnés (scripts/lib/skills-dir.js:
// TYCON_SKILLS_DIR o ~/.claude/agent-skills). Si ignorara TYCON_SKILLS_DIR, compararía las traducciones contra el
// checkout compartido aunque las suites corrieran sobre un clon.
const AGENTS_DIR = process.env.TYCON_AGENTS_DIR
  || path.join(require(path.join(ROOT, 'scripts', 'lib', 'skills-dir.js')).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR).repo, 'agents');
const OUT_DIR = path.join(ROOT, 'adapters', 'codex', 'agents');
// 2ª salida: el MISMO advisor, en formato de
// SUBAGENTE NATIVO de codex (~/.codex/agents/<name>.toml) — lo que una sesión codex spawnea
// con collaborationspawn_agent. Mismo generador, misma familia, segundo FORMATO.
const NATIVE_DIR = path.join(ROOT, 'adapters', 'codex', 'agents-native');
const MANIFEST = path.join(OUT_DIR, 'MANIFEST.json');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// ---------- frontmatter ----------
// El lector es el de la capa del equipo (scripts/setup/harness/team.js): BOM, CRLF, claves entre comillas, el
// comentario de un valor. Un agente que pasó la validación de la máquina no puede caerse acá por leerse distinto.
// Sobre todos los agentes del arnés da lo mismo que el lector plano.
// Un árbol sin el instalador (los árboles parciales de las pruebas del exportador, que copian sólo build/) no puede traer
// una capa del equipo —la apila el instalador—: ahí se lee con el lector plano, que da lo mismo sobre los agentes
// del arnés (medido). Sólo «no está»: cualquier otro error al cargar team.js sube.
const FRONTMATTER = /^(?:﻿)?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const TEAM_JS = path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js');
function plainFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const keys = {};
  for (const line of m[1].split('\n')) { const kv = line.match(/^(\w[\w-]*):\s*(.*)$/); if (kv) keys[kv[1]] = kv[2].trim(); }
  return { keys, dupes: [], exotic: [], flow: false };
}
const readFrontmatter = (raw) => (fs.existsSync(TEAM_JS) ? require(TEAM_JS).frontmatterKeys(raw) : plainFrontmatter(raw));
function parseAdvisor(mdPath) {
  const raw = fs.readFileSync(mdPath, 'utf8');
  const m = FRONTMATTER.exec(raw);
  const read = m ? readFrontmatter(raw) : null;
  if (!m || !read) throw new Error(`${mdPath}: sin frontmatter YAML`);
  if (read.flow || read.exotic.length || read.dupes.length) {
    throw new Error(`${mdPath}: el frontmatter no se lee igual que lo lee Claude Code (${read.flow ? 'forma de flujo' : read.dupes.length ? `repite ${read.dupes.join(', ')}` : read.exotic.slice(0, 2).join(' · ')})`);
  }
  // un valor de varias líneas (entre comillas que no cierran en su línea) llega como null: no es un valor de una línea
  const fm = {};
  for (const [k, v] of Object.entries(read.keys)) if (typeof v === 'string') fm[k] = v;
  // `tools:` (o `model:`) en forma de lista o de varias líneas se leería vacío y la traducción saldría con otros permisos sin
  // decirlo: no se traduce, y se dice
  for (const k of ['tools', 'model']) {
    if (Object.prototype.hasOwnProperty.call(read.keys, k) && (read.keys[k] === null || read.keys[k] === '')) {
      throw new Error(`${mdPath}: «${k}:» no está en una línea (lista o texto de varias líneas): el generador no lo traduce; escribilo como «${k}: a, b»`);
    }
  }
  const body = raw.slice(m.index + m[0].length).replace(/\r\n/g, '\n');
  // tools: tolera "Read, Grep, Glob" Y "[Read, Grep, Glob]" (inventario §B.3)
  let tools = [];
  if (fm.tools) tools = fm.tools.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean);
  // etiquetas de servidor MCP declaradas en tools: mcp__<etiqueta>__<tool>. La etiqueta puede
  // llevar guiones ("codebase-memory") y guiones bajos simples ("plugin_engram_engram"), por eso
  // el corte es en el PRIMER "__" después del prefijo.
  const mcpServers = [];
  const mcpToolsByServer = {};
  for (const t of tools) {
    const mm = t.match(/^mcp__(.+?)__(.+)$/);
    if (!mm) continue;
    if (!mcpServers.includes(mm[1])) { mcpServers.push(mm[1]); mcpToolsByServer[mm[1]] = []; }
    if (!mcpToolsByServer[mm[1]].includes(mm[2])) mcpToolsByServer[mm[1]].push(mm[2]);
  }
  return { name: fm.name, description: fm.description || '', model: fm.model || defaultReviewerModel(), tools, mcpServers, mcpToolsByServer, body: body.trim(), raw };
}

// ---------- el modelo de la organización ----------
// Los valores de hoy y la configuración de la organización viven en lib/models.js del skill: un árbol parcial (las pruebas
// del exportador copian sólo build/) no lo trae, y ahí vale lo de siempre.
const MODELS_JS = (root) => path.join(root, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'models.js');
function modelsLib(root = ROOT) {
  try { return require(MODELS_JS(root)); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null;
    throw e;
  }
}
function defaultReviewerModel() {
  const M = modelsLib();
  return M ? M.DEFAULTS.reviewers : 'sonnet';
}

/**
 * La línea `model = …` de una traducción (antes de la primera tabla): reemplazada por `slug`, o sacada con `slug: null`
 * (el modelo por defecto de Codex). Las claves sueltas siguen antes de las tablas.
 */
function withCodexModel(toml, slug) {
  const lines = String(toml).split('\n');
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const end = firstTable < 0 ? lines.length : firstTable;
  for (let i = 0; i < end; i++) {
    if (/^model\s*=/.test(lines[i])) {
      if (slug === null) lines.splice(i, 1);
      else lines[i] = `model = ${tomlString(slug)}`;
      return lines.join('\n');
    }
  }
  return toml;
}

/**
 * El slug de Codex del modelo resuelto de la organización para un revisor (primera vuelta, con techo):
 * `{ declared, slug, lines }`. `declared: false` = no hay `models` (o no se pudo leer): lo desplegado queda como hoy.
 * `slug: null` = el modelo no tiene equivalente: sin línea `model =`. `lines`: lo que hay que decir. Nunca tira.
 */
const orgCache = new Map();
function orgCodexModel(root, name, { agentsDir = null } = {}) {
  const out = { declared: false, slug: undefined, lines: [] };
  try {
    const M = modelsLib(root) || modelsLib();
    if (!M) return out;
    if (!orgCache.has(root)) {
      let teamRepos = null;
      let sinLector = null;
      try { teamRepos = require(path.join(root, 'scripts', 'lib', 'team-repos.js')); } catch (e) { sinLector = (e && e.code) || (e && e.message) || String(e); }
      const archivo = path.join(root, 'team-repos.json');
      // sin lector y con un team-repos.json: no se puede validar, y se dice (un `models` o un techo no se pierden callados)
      orgCache.set(root, teamRepos ? M.readOrgModels({ dir: root, teamRepos })
        : { declared: false, data: null, problem: fs.existsSync(archivo) ? `no pude leer la configuración de la organización (${archivo}: el árbol no trae su lector, ${sinLector}): uso los valores de hoy` : null });
    }
    const org = orgCache.get(root);
    if (org.problem) { out.lines.push(`⚠ tycon/codex: ${org.problem}`); return out; }
    if (!org.declared) return out;
    const models = M.resolveReviewers({ org: org.data, set: [name], iter: 1, agentsDir: agentsDir || path.join(root, 'agents') });
    const model = models[name].model;
    const eq = loadEq(root);
    const slug = eq.models && Object.prototype.hasOwnProperty.call(eq.models, model) ? eq.models[model] : null;
    if (slug === null) out.lines.push(`⚠ tycon/codex: el modelo ${model} de ${name} no tiene equivalente en Codex: se despliega sin «model =» (el modelo por defecto de Codex)`);
    return Object.assign(out, { declared: true, slug });
  } catch (e) {
    out.lines.push(`⚠ tycon/codex: no pude resolver el modelo de la organización para ${name} (${e.message}): queda el de hoy`);
    return out;
  }
}
/** Lo que se despliega de una traducción: con el modelo de la organización si está declarado; si no, tal cual. */
function deployedContent(content, org) {
  return org && org.declared ? withCodexModel(content, org.slug) : content;
}

// ---------- traducción ----------
// Las seis funciones de abajo reciben las equivalencias (`eq`) de la raíz que se genera: nunca la constante del módulo.
function codexModel(claudeModel, eq) {
  const slug = eq.models && Object.prototype.hasOwnProperty.call(eq.models, claudeModel) ? eq.models[claudeModel] : null;
  if (!slug) throw new Error(`modelo sin equivalencia en equivalences.json: "${claudeModel}"`);
  return slug;
}

function codexSandbox(tools, eq) {
  const writes = tools.some((t) => eq.advisor_permissions.write.claude_tools.includes(t.split('(')[0]));
  return writes ? eq.advisor_permissions.write.codex.sandbox_mode : eq.advisor_permissions['read-only'].codex.sandbox_mode;
}

/**
 * Etiquetas del frontmatter → tablas a emitir + omitidas con su motivo.
 * Falla RUIDOSO si aparece una etiqueta que no está en ninguna de las dos listas: un servidor
 * nuevo se decide a mano, no desaparece del perfil sin que nadie se entere. Es el mismo patrón
 * que ya destapó dos inputs muertos (registros D.3 y D.4).
 */
function codexMcpServers(labels, eq) {
  const declared = [], omitted = [];
  const has = (obj, k) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, k) && !k.startsWith('__');
  for (const label of labels) {
    if (has(eq.mcp_servers, label)) declared.push([label, eq.mcp_servers[label]]);
    else if (has(eq.mcp_servers_not_declarable, label)) omitted.push([label, eq.mcp_servers_not_declarable[label]]);
    else throw new Error(
      `servidor MCP sin decisión en equivalences.json: "${label}". Agregalo a mcp_servers ` +
      `(con su comando) o a mcp_servers_not_declarable (con el motivo). No se omite en silencio.`);
  }
  return { declared, omitted };
}

/**
 * El gotcha del orden, cableado: TODA clave de RAÍZ tiene que quedar antes de la primera tabla.
 * (Las claves de adentro de una tabla son legítimas — lo que TOML se come es la clave de raíz
 * que quedó debajo de un [header]. Prohibir cualquier clave después de una tabla se dispararía
 * contra el `command` de [mcp_servers.*]: el freno tiene que atrapar el pecado real, no cualquier
 * cosa que se le parezca.)
 */
function assertLooseKeysFirst(toml, name, rootKeys) {
  const lines = toml.split('\n');
  const TRIPLE = /"""/g;
  let firstTable = -1, inMultiline = false;
  const seen = new Map();
  for (let i = 0; i < lines.length; i++) {
    const odd = ((lines[i].match(TRIPLE) || []).length % 2) === 1;
    if (inMultiline) { if (odd) inMultiline = false; continue; }
    if (odd) { inMultiline = true; }
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { if (firstTable < 0) firstTable = i; continue; }
    const kv = line.match(/^([A-Za-z0-9_."-]+)\s*=/);
    if (kv && !seen.has(kv[1])) seen.set(kv[1], i);
  }
  for (const k of rootKeys) {
    if (!seen.has(k)) throw new Error(`${name}: falta la clave de raíz "${k}" en el .toml generado`);
    if (firstTable >= 0 && seen.get(k) > firstTable)
      throw new Error(`${name}: la clave de raíz "${k}" (línea ${seen.get(k) + 1}) quedó después de la tabla de la línea ${firstTable + 1} — TOML se la come adentro de esa tabla y el perfil no carga`);
  }
}

function substituteToolNames(text, eq) {
  let out = text;
  for (const [from, to] of Object.entries(eq.text_substitutions || {})) {
    if (from.startsWith('__')) continue;
    out = out.split(from).join(to);
  }
  return out;
}

// TOML multiline basic string: escapar \ y " vale siempre y no depende del contenido. Los caracteres de control que TOML no
// admite crudos (en la de una línea, todos salvo el tabulador; en la de varias, además el salto de línea) salen como \uXXXX
// (un escape en el frontmatter de un revisor de la capa los puede traer, y Codex no cargaría el .toml).
const ctl = (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
function tomlMultiline(s) {
  // (un \r suelto no es salto de línea en TOML: CRLF se deja como LF y el resto sale como \r)
  return '"""\n' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r\n/g, '\n').replace(/\r/g, '\\r').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ctl) + '\n"""';
}
function tomlString(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ctl) + '"';
}
// Clave de tabla: TOML acepta A-Za-z0-9_- sin comillas; cualquier otra cosa va citada.
function tomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

function renderToml(adv, sourceRel, sourceHash, eq) {
  // Cláusula de conducta Codex (equivalences.json → codex_conduct_clause, registro D.7):
  // el modelo de Codex saltea pasos de verificación caros que el procedimiento manda —
  // la cláusula va PRIMERA en las instrucciones para pesar más que el cuerpo.
  const conduct = (eq.codex_conduct_clause && eq.codex_conduct_clause.text) ? eq.codex_conduct_clause.text + '\n\n---\n\n' : '';
  const instructions = conduct + substituteToolNames(adv.body, eq);
  const { declared, omitted } = codexMcpServers(adv.mcpServers, eq);

  const head = [
    `# ⚙️ GENERADO por build/generate.js — NO EDITAR A MANO (se pisa en la próxima corrida)`,
    `# canónico: ${sourceRel}`,
    `# source_sha256: ${sourceHash}`,
    `# Se despliega como $CODEX_HOME/${adv.name}.config.toml y se invoca: codex exec -p ${adv.name}`,
    `# ⚠️ codex exec se cuelga para siempre si le queda stdin abierto: invocarlo SIEMPRE con < /dev/null`,
  ];
  for (const [label, why] of omitted)
    head.push(`# ⚠️ ASIMETRÍA DECLARADA — servidor MCP "${label}" NO se declara acá: ${why}`);

  // --- claves sueltas PRIMERO (ver assertLooseKeysFirst) ---
  const loose = [
    ``,
    `model = ${tomlString(codexModel(adv.model, eq))}`,
    `sandbox_mode = ${tomlString(codexSandbox(adv.tools, eq))}`,
  ];
  for (const feat of Object.keys(eq.codex_features_off || {})) {
    if (feat.startsWith('__')) continue;
    loose.push(`features.${feat} = false`);
  }
  loose.push(``, `developer_instructions = ${tomlMultiline(instructions)}`, ``);

  // --- tablas DESPUÉS ---
  const tables = [];
  for (const [label, cfg] of declared) {
    tables.push(`[mcp_servers.${tomlKey(label)}]`);
    tables.push(`command = ${tomlString(cfg.command)}`);
    tables.push(`args = [${(cfg.args || []).map(tomlString).join(', ')}]`);
    // approval: 'approve' = nunca pide (mcp_tool_call.rs: Approve→false). El default 'auto'
    // decide por las ANOTACIONES de cada tool — si el server no las trae, pide permiso, y con
    // approval_policy=never (advisor headless) eso DENIEGA la llamada: el advisor cae a otro
    // camino sin declararlo (canarios 1-3, registro D.5).
    if (cfg.approval_mode) tables.push(`default_tools_approval_mode = ${tomlString(cfg.approval_mode)}`);
    // lista blanca por-tool: el perfil expone SOLO las tools que el frontmatter declara para
    // este server — misma superficie que en Claude. Existe para MCP (mcp_types.rs enabled_tools);
    // sigue sin existir para las built-in (esa mitad de la asimetría §B.1 queda).
    const allow = (adv.mcpToolsByServer && adv.mcpToolsByServer[label]) || [];
    if (allow.length) tables.push(`enabled_tools = [${allow.map(tomlString).join(', ')}]`);
    tables.push(``);
  }

  const rootKeys = ['model', 'sandbox_mode', 'developer_instructions']
    .concat(Object.keys(eq.codex_features_off || {}).filter((f) => !f.startsWith('__')).map((f) => `features.${f}`));
  const toml = head.concat(loose, tables).join('\n');
  assertLooseKeysFirst(toml, adv.name, rootKeys);
  return toml;
}

function renderNativeToml(adv, sourceRel, sourceHash, eq) {
  // Mismas piezas que el perfil (cláusula de conducta primero, cuerpo con nombres sustituidos,
  // mismos servers MCP con approve + enabled_tools). Diferencias del formato agent nativo:
  // name/description son OBLIGATORIAS (la identidad que viaja en agent_type — sonda G-1);
  // sin features.* (apps-off es de SESIÓN, la lleva la sesión del pipeline, no el subagente).
  const conduct = (eq.codex_conduct_clause && eq.codex_conduct_clause.text) ? eq.codex_conduct_clause.text + '\n\n---\n\n' : '';
  const instructions = conduct + substituteToolNames(adv.body, eq);
  const { declared, omitted } = codexMcpServers(adv.mcpServers, eq);

  const head = [
    `# ⚙️ GENERADO por build/generate.js — NO EDITAR A MANO (se pisa en la próxima corrida)`,
    `# canónico: ${sourceRel}`,
    `# source_sha256: ${sourceHash}`,
    `# Formato SUBAGENTE NATIVO: se despliega como $CODEX_HOME/agents/${adv.name}.toml y una`,
    `# sesión codex lo spawnea (collaborationspawn_agent → tool_input.agent_type = "${adv.name}").`,
    `# El ledger de check-count lo registra on-advisor-run.js por agent_type (sonda G-1).`,
  ];
  for (const [label, why] of omitted)
    head.push(`# ⚠️ ASIMETRÍA DECLARADA — servidor MCP "${label}" NO se declara acá: ${why}`);

  const loose = [
    ``,
    `name = ${tomlString(adv.name)}`,
    `description = ${tomlString(adv.description || adv.name)}`,
    `model = ${tomlString(codexModel(adv.model, eq))}`,
    `sandbox_mode = ${tomlString(codexSandbox(adv.tools, eq))}`,
    ``,
    `developer_instructions = ${tomlMultiline(instructions)}`,
    ``,
  ];

  const tables = [];
  for (const [label, cfg] of declared) {
    tables.push(`[mcp_servers.${tomlKey(label)}]`);
    tables.push(`command = ${tomlString(cfg.command)}`);
    tables.push(`args = [${(cfg.args || []).map(tomlString).join(', ')}]`);
    if (cfg.approval_mode) tables.push(`default_tools_approval_mode = ${tomlString(cfg.approval_mode)}`);
    const allow = (adv.mcpToolsByServer && adv.mcpToolsByServer[label]) || [];
    if (allow.length) tables.push(`enabled_tools = [${allow.map(tomlString).join(', ')}]`);
    tables.push(``);
  }

  const rootKeys = ['name', 'description', 'model', 'sandbox_mode', 'developer_instructions'];
  const toml = head.concat(loose, tables).join('\n');
  assertLooseKeysFirst(toml, adv.name + ' (nativo)', rootKeys);
  return toml;
}

// ---------- main ----------
function loadManifest() {
  if (!fs.existsSync(MANIFEST)) return { advisors: [] };
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

/**
 * Las dos traducciones de un agente: `{ name, toml, nativeToml }`. Los agentes salen de `<root>/agents` (o de `agentsDir`,
 * que pasa sólo el clon: su carpeta de agentes de siempre) y las equivalencias de `<root>/build/equivalences.json`. Tira con
 * el motivo si el agente no se puede generar (no existe, frontmatter que no se lee, modelo o servidor MCP sin equivalencia).
 */
/**
 * La ruta con que se nombra el canónico: la del paquete si la carpeta de agentes es la de uno (su pack.json está arriba, hasta
 * seis niveles), o `agents/<r>.md` para cualquier otra carpeta (la del árbol, la de un clon, TYCON_AGENTS_DIR). Una carpeta
 * dentro de `packs/<p>/` sin pack.json a la vista tira: la procedencia del .toml nombraría un archivo que no existe.
 */
function canonicalOf(name, agentsDir) {
  if (!agentsDir) return `agents/${name}.md`;
  for (let d = agentsDir, rel = ''; d !== path.dirname(d) && rel.split('/').length <= 6; rel = path.basename(d) + (rel ? `/${rel}` : ''), d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'pack.json'))) return `packs/${path.basename(d)}/${rel ? `${rel}/` : ''}${name}.md`;
  }
  if (path.resolve(agentsDir).split(path.sep).slice(0, -1).includes('packs')) throw new Error(`${agentsDir} está dentro de packs/ y no encuentro el pack.json de su paquete: no sé cómo nombrar el canónico de ${name}`);
  return `agents/${name}.md`;
}
function generateOne(root, name, { agentsDir = null } = {}) {
  const eq = loadEq(root);
  if (eq.__error) throw new Error(`equivalences.json de ${root} ilegible (${eq.__error})`);
  const mdPath = path.join(agentsDir || path.join(root, 'agents'), `${name}.md`);
  if (!fs.existsSync(mdPath)) throw new Error(`canónico no existe: ${mdPath}`);
  const adv = parseAdvisor(mdPath);
  if (adv.name !== name)
    throw new Error(`${mdPath}: frontmatter name="${adv.name}" no coincide con el archivo`);
  const hash = crypto.createHash('sha256').update(adv.raw).digest('hex');
  // el canónico se nombra `agents/<r>.md`; el de un paquete, `packs/<paquete>/<su carpeta de agentes>/<r>.md`, el mismo
  // esté el paquete en el árbol o en TYCON_PACKS_DIR (no depende de dónde vive en el disco)
  const canonical = canonicalOf(name, agentsDir);
  return {
    name,
    toml: renderToml(adv, canonical, hash, eq),
    nativeToml: renderNativeToml(adv, canonical, hash, eq),
  };
}

const TEAM_MANIFEST = '.tycon-team.json';
const TEAM_PENDING = '.tycon-team.pending.json';
const teamLib = () => require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js'));
const toolsLib = () => require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tools.js'));

/**
 * Qué revisores se despliegan a Codex desde un árbol: `{ manifest, team, teamDirs, teamProblem, halfDone }`. `manifest`: los
 * del `MANIFEST.json` del árbol; `team`: los agentes que nombra el manifiesto de la capa del equipo (`.tycon-team.json`):
 * los de `agents/<r>.md` y los de `packs/<p>/agents/<r>.md` de un paquete que la organización activa (los mismos que se
 * enlazan del lado de Claude); nunca de TYCON_PACKS_DIR ni TYCON_AGENTS_DIR. `teamDirs`: la carpeta de cada revisor de un
 * paquete (para `generateOne`). Sin capa, `team: []`; con su manifiesto ilegible, o sin poder saber qué paquetes están
 * activos, `team: null` y el motivo (no se despliega ni se borra nada); `halfDone`: un refresco de la capa a medias (su
 * pendiente está en el árbol y es de OTRO commit que el del manifiesto: uno que quedó de un refresco terminado no cuenta;
 * uno ilegible, sí).
 */
function advisorsToDeploy(root) {
  const mf = path.join(root, 'adapters', 'codex', 'agents', 'MANIFEST.json');
  const manifest = fs.existsSync(mf) ? (JSON.parse(fs.readFileSync(mf, 'utf8')).advisors || []) : [];
  // teamDirs sin prototipo: un agente que se llame `constructor` o `toString` es un nombre más
  const out = { manifest, team: [], teamDirs: Object.create(null), teamProblem: null, halfDone: false, lines: [] };
  const pendingFile = path.join(root, TEAM_PENDING);
  if (!fs.existsSync(path.join(root, TEAM_MANIFEST))) { out.halfDone = fs.existsSync(pendingFile); return out; }
  const m = teamLib().readTeamManifest(root);
  if (fs.existsSync(pendingFile)) {
    let pending = null;
    try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch (_) { pending = null; }
    out.halfDone = !(m && pending && typeof pending.commit === 'string' && pending.commit === m.commit);
  }
  if (!m) return Object.assign(out, { team: null, teamProblem: `${path.join(root, TEAM_MANIFEST)} no se lee o no tiene la forma del manifiesto de la capa: lo arregla el próximo refresco de la capa (o harness.js update)` });
  const paths = m.files.map((f) => f.path);
  const team = paths.filter((p) => /^agents\/[^/]+\.md$/.test(p)).map((p) => p.slice('agents/'.length, -'.md'.length));
  if (paths.some((p) => /^packs\/[^/]+\//.test(p))) {
    const PP = require(path.join(ROOT, 'scripts', 'lib', 'pack-pieces.js'));
    // un paquete de la capa con el manifiesto roto no es «ausente»: no se sabe qué revisores trae, y sin saberlo no se
    // despliega ni se borra nada de la capa en Codex (los que tenía quedan); se dice cuál
    const listed = PP.listPacks(path.join(root, 'packs'));
    const brokenInLayer = listed.errores.filter((e) => paths.includes(path.relative(root, e.archivo).split(path.sep).join('/')));
    if (brokenInLayer.length) return Object.assign(out, { team: null, teamProblem: `paquete(s) de la capa con el manifiesto roto (${brokenInLayer.map((e) => `${e.archivo}: ${e.motivo}`).join('; ')}): los revisores de la capa no se despliegan ni se borran en Codex` });
    const active = PP.orgActive({ tree: root });
    if (!active.names) return Object.assign(out, { team: null, teamProblem: `no se sabe qué paquetes activa la organización (${active.error}): los revisores de la capa no se despliegan ni se borran en Codex` });
    // los agentes de cada paquete activo que llegan por la capa, en la carpeta que declara su manifiesto (clave `agents`);
    // un nombre repetido —con la raíz o entre paquetes— se queda con el primero y se dice (del lado de Claude pack-pieces.js
    // lo frena; acá un defecto de la capa no hace volver atrás el despliegue, pero tampoco se calla)
    for (const p of listed.packs.filter((x) => active.names.includes(x.name) && x.agentsDir)) {
      const rel = path.relative(root, p.agentsDir).split(path.sep).join('/');
      for (const f of paths) {
        if (!f.startsWith(`${rel}/`) || !f.endsWith('.md') || f.slice(rel.length + 1).includes('/')) continue;
        const name = f.slice(rel.length + 1, -'.md'.length);
        if (team.includes(name) || name in out.teamDirs) {
          const first = name in out.teamDirs ? path.relative(root, out.teamDirs[name]).split(path.sep).join('/') : 'agents';
          out.lines.push(`⚠ tycon/codex: el revisor ${name} está en ${rel} y en ${first}: en Codex queda el de ${first}`);
          continue;
        }
        // uno de un paquete con el nombre de uno de la versión: en Codex queda el de la versión, y se dice (del lado de Claude
        // pack-pieces.js lo frena)
        if (manifest.includes(name)) { out.lines.push(`⚠ tycon/codex: el revisor ${name} de ${rel} tiene el nombre de uno de la versión: en Codex queda el de la versión`); continue; }
        team.push(name);
        out.teamDirs[name] = p.agentsDir;
      }
    }
  }
  out.team = [...new Set(team)].filter((n) => !manifest.includes(n)).sort();
  return out;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Los revisores de la capa del equipo en Codex: genera los dos archivos de cada uno con
 * `generateOne(root)` directo a `codexHome`, sin pasar por el árbol; no pisa un archivo que ya está, no lo escribió el arnés
 * (no está en el registro) y tiene otro contenido —es de la persona—; anota en el registro (`recordFile`) el nombre y el
 * hash de lo que escribió, después de cada escritura o borrado; y borra lo que la capa sacó sólo si su hash es el que
 * escribió. Sin manifiesto de la capa legible, con un refresco a medias o sin un registro legible, no borra nada y lo dice.
 * Sin registro legible, o con un registro de OTRA carpeta de Codex, tampoco despliega (lo que escribiera no quedaría anotado,
 * y lo de allá se perdería). Las rutas se comparan sin caja (en Mac y Windows `Rev-Uno` y `rev-uno` son el mismo archivo); un
 * revisor que pasó de la capa a la versión (MANIFEST) sale del registro sin borrar nada; un archivo con la cabecera del
 * generador es del arnés aunque no esté anotado (un revisor que pasó de la versión a la capa).
 * `{ written, removed, kept, skipped: [{ name, reason }], devFiles, lines }`: las líneas con ⚠ son avisos. Nunca tira.
 */
const GENERATED_HEAD = '# ⚙️ GENERADO por build/generate.js';
function deployTeam({ root = ROOT, codexHome = CODEX_HOME, recordFile = null } = {}) {
  const out = { written: [], removed: [], kept: [], skipped: [], devFiles: [], lines: [] };
  const say = (l) => out.lines.push(l);
  try {
    const set = advisorsToDeploy(root);
    for (const l of set.lines || []) say(l);
    const T = toolsLib();
    const file = recordFile || T.codexTeamRecordPath({ home: os.homedir() });
    const rec = T.readCodexTeamRecord(file);
    if (rec.problem) { say(`⚠ tycon/codex: el registro de los revisores de la capa en Codex no se lee (${rec.problem}): la capa no se despliega ni se borra nada hasta arreglarlo (borralo para empezar de cero: los archivos que ya están quedan como tuyos)`); return out; }
    if (rec.codex_home && path.resolve(rec.codex_home) !== path.resolve(codexHome)) { say(`⚠ tycon/codex: el registro de la capa es de otra carpeta de Codex (${rec.codex_home}): la capa no se despliega en ${codexHome} y lo de allá no se toca (uninstall lo quita)`); return out; }
    if (rec.invalid.length) say(`⚠ tycon/codex: ${rec.invalid.length} entrada(s) del registro de la capa sin la forma de un archivo suyo (${rec.invalid.slice(0, 3).join(', ')}): no se borran`);
    const files = Object.assign({}, rec.files);
    const fold = (rel) => rel.toLowerCase();
    const recordedAs = (rel) => Object.keys(files).filter((k) => fold(k) === fold(rel));
    const save = () => { try { T.writeCodexTeamRecord(file, { codexHome, files, keep: rec.invalidRaw }); } catch (e) { say(`⚠ tycon/codex: no pude escribir el registro de la capa (${e.code || e.message}): lo desplegado no se va a poder borrar solo`); } };
    if (!fs.existsSync(path.join(root, TEAM_MANIFEST))) {
      // una versión sin capa (rollback, una capa retirada): nada se borra sin su manifiesto, pero se dice
      const left = Object.keys(files).filter((rel) => fs.existsSync(path.join(codexHome, ...rel.split('/'))));
      if (left.length) say(`⚠ tycon/codex: esta versión no trae capa del equipo y ${left.length} archivo(s) de sus revisores quedan en ${codexHome} (${left.slice(0, 3).join(', ')}): se quitan con uninstall, o solos cuando la capa vuelva y no los traiga`);
      return out;
    }
    const keep = new Set();
    for (const name of set.team || []) {
      if (!T.TEAM_AGENT_NAME.test(name) || name.includes('..')) {
        out.skipped.push({ name, reason: 'el nombre no tiene la forma de un revisor de la capa en Codex ([A-Za-z0-9_-] al principio, hasta 100)' });
        say(`⚠ tycon/codex: revisor de la capa ${JSON.stringify(name)} no desplegado: el nombre no tiene la forma que el registro acepta`);
        continue;
      }
      keep.add(fold(`${name}.config.toml`)); keep.add(fold(`agents/${name}.toml`));
      let g;
      try { g = generateOne(root, name, { agentsDir: set.teamDirs[name] || null }); } catch (e) {
        out.skipped.push({ name, reason: e.message });
        say(`⚠ tycon/codex: revisor de la capa ${name} no desplegado: ${e.message}`);
        continue;
      }
      const org = orgCodexModel(root, name, { agentsDir: set.teamDirs[name] || null });
      for (const l of org.lines) say(l);
      for (const [rel, content] of [[`${name}.config.toml`, deployedContent(g.toml, org)], [`agents/${name}.toml`, deployedContent(g.nativeToml, org)]]) {
        const dst = path.join(codexHome, ...rel.split('/'));
        const want = Buffer.from(content);
        let have = null;
        try { have = fs.readFileSync(dst); } catch (e) {
          if (!e || e.code !== 'ENOENT') { say(`⚠ tycon/codex: no pude leer ${dst} (${(e && e.code) || e}): el revisor de la capa ${name} queda sin ese archivo`); continue; }
        }
        const ours = recordedAs(rel).length > 0 || (have && have.toString('utf8').startsWith(GENERATED_HEAD));
        if (have && !ours && !have.equals(want)) {
          out.devFiles.push(rel);
          say(`⚠ tycon/codex: ${dst} ya existe y no lo escribió el arnés: es tuyo y no se pisa (el revisor de la capa ${name} queda sin ese archivo en Codex)`);
          continue;
        }
        if (!have || !have.equals(want)) {
          const tmp = `${dst}.tmp-${process.pid}`;
          try {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.writeFileSync(tmp, want);
            fs.renameSync(tmp, dst);
            out.written.push(rel);
          } catch (e) {
            try { fs.rmSync(tmp, { force: true }); } catch (_) { /* queda el temporal */ }
            say(`⚠ tycon/codex: no pude escribir ${dst} (${e.code || e.message}): el revisor de la capa ${name} queda sin ese archivo`);
            continue;
          }
        }
        for (const k of recordedAs(rel)) delete files[k];   // la misma ruta con otra caja: una sola entrada
        files[rel] = { agent: name, sha256: sha256(want) };
        save();
      }
    }
    // lo que la capa sacó: sólo con la lista de la capa leída entera y sin refresco a medias
    const gone = Object.keys(files).filter((rel) => !keep.has(fold(rel))).sort();
    if (set.team === null || (set.halfDone && gone.length)) {
      say(`⚠ tycon/codex: no se borra nada de la capa en Codex: ${set.team === null ? set.teamProblem : 'la capa quedó a medio refrescar'}`);
      return out;
    }
    const manifestFold = new Set(set.manifest.map((n) => n.toLowerCase()));
    for (const rel of gone) {
      // un revisor que pasó a la versión: sus archivos ahora son de la versión (deployOnly ya los dejó)
      if (manifestFold.has(String(files[rel].agent).toLowerCase())) { delete files[rel]; save(); continue; }
      const dst = path.join(codexHome, ...rel.split('/'));
      let have = null;
      try { have = fs.readFileSync(dst); } catch (e) {
        if (!e || e.code !== 'ENOENT') { say(`⚠ tycon/codex: no pude leer ${dst} (${(e && e.code) || e}): queda, y sigue en el registro`); continue; }
      }
      if (have && sha256(have) === files[rel].sha256) {
        try { fs.unlinkSync(dst); out.removed.push(rel); } catch (e) { say(`⚠ tycon/codex: no pude borrar ${dst} (${e.code || e.message}): queda, y sigue en el registro`); continue; }
      } else if (have) {
        out.kept.push(rel);
        say(`⚠ tycon/codex: ${dst} era de un revisor que la capa sacó y está editado a mano: queda (es tuyo desde ahora)`);
      }
      delete files[rel];
      save();
    }
  } catch (e) {
    say(`⚠ tycon/codex: el despliegue de los revisores de la capa se cortó (${e.message}): lo que no se hizo queda para el próximo arranque`);
  }
  return out;
}

function main() {
  if (EQ && EQ.__error) { console.error(`generate.js: equivalences.json ilegible (${EQ.__error})`); return 1; }
  const argv = process.argv.slice(2);
  const CHECK = argv.includes('--check');
  const DEPLOY = argv.includes('--deploy');
  const addIdx = argv.indexOf('--add');
  const manifest = loadManifest();
  if (argv.includes('--deploy-only')) return deployOnly(manifest);

  if (addIdx >= 0) {
    const name = argv[addIdx + 1];
    if (!name) throw new Error('--add requiere <name>');
    if (!manifest.advisors.includes(name)) manifest.advisors.push(name);
  }
  if (!manifest.advisors.length) {
    console.error('manifest vacío — nada que generar (usar --add <name>)');
    return 1;
  }

  let stale = 0;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(NATIVE_DIR, { recursive: true });
  for (const name of manifest.advisors) {
    // el canónico: en la carpeta de agentes, o en la de su paquete (los revisores de un stack viven ahí)
    const agentsDir = fs.existsSync(path.join(AGENTS_DIR, `${name}.md`)) ? AGENTS_DIR
      : (require(path.join(ROOT, 'scripts', 'lib', 'pack-pieces.js')).agentDirInPacks(process.env.TYCON_PACKS_DIR || path.join(ROOT, 'packs'), name) || AGENTS_DIR);
    const { toml, nativeToml } = generateOne(ROOT, name, { agentsDir });
    // lo desplegado lleva el modelo de la organización; lo generado en adapters/, el de hoy
    const org = DEPLOY ? orgCodexModel(ROOT, name, { agentsDir }) : null;
    if (org) for (const l of org.lines) console.log(l);
    // las DOS salidas del mismo canónico se tratan igual: check, write, deploy
    const outputs = [
      { outPath: path.join(OUT_DIR, `${name}.toml`), content: toml, deployTo: path.join(CODEX_HOME, `${name}.config.toml`) },
      { outPath: path.join(NATIVE_DIR, `${name}.toml`), content: nativeToml, deployTo: path.join(CODEX_HOME, 'agents', `${name}.toml`) },
    ];
    let copiados = 0;
    for (const o of outputs) {
      const current = fs.existsSync(o.outPath) ? fs.readFileSync(o.outPath, 'utf8') : null;
      if (CHECK) {
        if (current !== o.content) {
          stale++;
          console.error(`❌ DESACTUALIZADO: ${path.relative(ROOT, o.outPath)} no refleja el canónico agents/${name}.md — corré: node build/generate.js`);
        } else console.log(`✅ al día: ${path.relative(ROOT, o.outPath)}`);
        continue;
      }
      if (current !== o.content) {
        fs.writeFileSync(o.outPath, o.content);
        console.log(`📝 generado: ${path.relative(ROOT, o.outPath)}`);
      }
      if (DEPLOY) {
        // Copiar sólo si los bytes difieren: esto corre en cada deploy y copiar todo
        // sin condición churnearía mtimes en ~/.codex sin cambiar nada.
        const desplegado = fs.existsSync(o.deployTo) ? fs.readFileSync(o.deployTo, 'utf8') : null;
        const quiero = deployedContent(o.content, org);
        if (desplegado !== quiero) {
          fs.mkdirSync(path.dirname(o.deployTo), { recursive: true });
          fs.writeFileSync(o.deployTo, quiero);
          copiados++;
        }
      }
    }
    if (DEPLOY && copiados) console.log(`🚀 desplegado: ${name} (perfil + agent nativo)`);
  }
  if (!CHECK) {
    // Sólo si cambió: reescribirlo incondicionalmente dejaría un archivo git-tracked con mtime
    // fresco en cada corrida — ruido para watchers y para el staging selectivo del repo.
    const manifestNuevo = JSON.stringify(manifest, null, 2) + '\n';
    const manifestActual = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, 'utf8') : null;
    if (manifestActual !== manifestNuevo) fs.writeFileSync(MANIFEST, manifestNuevo);
  }
  return stale > 0 ? 1 : 0;
}

/**
 * Sólo desplegar: lo que ya está generado en adapters/ va a $CODEX_HOME tal cual. No lee el
 * canónico, no escribe en el árbol. Un adapter que falta se dice y cuenta como falla (lo publicado tiene que traerlo).
 */
function deployOnly(manifest) {
  let missing = 0;
  for (const name of manifest.advisors) {
    let copied = 0;
    const org = orgCodexModel(ROOT, name);
    for (const l of org.lines) console.log(l);
    for (const o of deployPairs(name, CODEX_HOME)) {
      if (!fs.existsSync(o.outPath)) { missing++; console.error(`❌ generate.js --deploy-only: falta ${path.relative(ROOT, o.outPath)} (esta versión no lo trae generado)`); continue; }
      const want = Buffer.from(deployedContent(fs.readFileSync(o.outPath, 'utf8'), org));
      const have = fs.existsSync(o.deployTo) ? fs.readFileSync(o.deployTo) : null;
      if (have && Buffer.compare(want, have) === 0) continue;
      fs.mkdirSync(path.dirname(o.deployTo), { recursive: true });
      fs.writeFileSync(o.deployTo, want);
      copied++;
    }
    if (copied) console.log(`🚀 desplegado: ${name} (perfil + agent nativo)`);
  }
  // los revisores de la capa del equipo: sólo con capa en el árbol. Lo que no se pudo se dice y
  // NO suma a `missing`: un defecto de la capa no hace que la actualización vuelva atrás
  // (también sin capa en el árbol si quedó un registro: una versión sin capa lo dice, y no borra nada)
  const toolsJs = path.join(ROOT, 'scripts', 'setup', 'harness', 'tools.js');
  const recorded = fs.existsSync(toolsJs) && fs.existsSync(toolsLib().codexTeamRecordPath({ home: os.homedir() }));
  let kept = [];
  if (fs.existsSync(path.join(ROOT, TEAM_MANIFEST)) || recorded) {
    const t = deployTeam({ root: ROOT, codexHome: CODEX_HOME });
    for (const l of t.lines) console.log(l);
    if (t.written.length || t.removed.length) console.log(`🚀 desplegado: revisores de la capa del equipo (${t.written.length} escrito(s), ${t.removed.length} quitado(s))`);
    kept = t.kept.concat(t.devFiles);
  }
  for (const l of removeRetired({ root: ROOT, codexHome: CODEX_HOME, manifest: manifest.advisors, kept }).lines) console.log(l);
  return missing ? 1 : 0;
}

/**
 * Lo que el arnés desplegó en Codex para un revisor que salió de la versión (`build/retired-reviewers.json`: los
 * revisores de un stack viven en su paquete, no en el MANIFEST) y hoy no es de la versión ni de la capa: en una máquina sin ese
 * paquete activo, o sin capa, quedaría para siempre. Sólo esos nombres, sólo los archivos con la cabecera del generador —son
 * del arnés, no de la persona— y nunca uno que `deployTeam` acaba de dejar como de la persona (`kept`). Con un manifiesto de
 * la capa roto o a medio refrescar, o con el registro de la capa ilegible o de otra carpeta de Codex, no se borra nada, y se
 * dice. `{ removed, lines }`; nunca tira.
 */
function removeRetired({ root = ROOT, codexHome = CODEX_HOME, manifest = [], recordFile = null, retired = null, kept = [] } = {}) {
  const out = { removed: [], lines: [] };
  const stop = (why) => { out.lines.push(`⚠ tycon/codex: no se quitan revisores viejos de Codex: ${why}`); return out; };
  try {
    let gone = retired;
    if (!gone) {
      const file = path.join(root, 'build', 'retired-reviewers.json');
      if (!fs.existsSync(file)) return out;
      try { gone = JSON.parse(fs.readFileSync(file, 'utf8')).reviewers; } catch (e) { return stop(`${file} no se lee (${e.message})`); }
      if (!Array.isArray(gone)) return stop(`${file} no trae la lista «reviewers»`);
    }
    const candidates = new Set(gone.map((n) => String(n).toLowerCase()));
    if (!candidates.size) return out;
    const set = advisorsToDeploy(root);
    if (set.team === null || set.halfDone) return stop(set.team === null ? set.teamProblem : 'la capa quedó a medio refrescar');
    const keep = new Set([...manifest, ...set.team].map((n) => n.toLowerCase()));
    const T = toolsLib();
    const rec = T.readCodexTeamRecord(recordFile || T.codexTeamRecordPath({ home: os.homedir() }));
    if (rec.problem) return stop(`el registro de la capa no se lee (${rec.problem})`);
    if (rec.codex_home && path.resolve(rec.codex_home) !== path.resolve(codexHome)) return stop(`el registro de la capa es de otra carpeta de Codex (${rec.codex_home})`);
    for (const f of Object.values(rec.files)) if (f && f.agent) keep.add(String(f.agent).toLowerCase());
    const keptFold = new Set(kept.map((rel) => rel.toLowerCase()));
    for (const [dir, ext, prefix] of [[codexHome, '.config.toml', ''], [path.join(codexHome, 'agents'), '.toml', 'agents/']]) {
      let names = [];
      try { names = fs.readdirSync(dir).filter((f) => f.endsWith(ext)); } catch (_) { continue; }
      for (const f of names) {
        const name = f.slice(0, -ext.length);
        if (!name || !candidates.has(name.toLowerCase()) || keep.has(name.toLowerCase()) || keptFold.has(`${prefix}${f}`.toLowerCase())) continue;
        const file = path.join(dir, f);
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
        if (!text.startsWith(GENERATED_HEAD)) continue;   // no lo escribió el arnés: es de la persona
        // sólo lo que la VERSIÓN desplegó (su canónico era `agents/<r>.md`): lo que vino de un paquete de la capa lo maneja
        // deployTeam con su registro, y si lo dejó como de la persona («es tuyo desde ahora») queda en este arranque y en los
        // siguientes
        if (!text.split('\n', 12).includes(`# canónico: agents/${name}.md`)) continue;
        try { fs.unlinkSync(file); out.removed.push(path.relative(codexHome, file)); } catch (e) { out.lines.push(`⚠ tycon/codex: no pude quitar ${file} (${e.code || e.message})`); }
      }
    }
    if (out.removed.length) out.lines.push(`tycon/codex: quité ${out.removed.length} archivo(s) de revisores que ya no son de esta versión ni de la capa (${out.removed.slice(0, 4).join(', ')}${out.removed.length > 4 ? ', …' : ''})`);
  } catch (e) { out.lines.push(`⚠ tycon/codex: no pude mirar los revisores viejos en Codex (${e.message})`); }
  return out;
}

// El mapa src→dst del despliegue, EXPORTADO para que el audit de paridad itere el mismo layout
// que este generador escribe — si hay una tercera salida, el audit la hereda solo
// (re-codificar el layout a mano dejaría un output nuevo sin superficie que lo mida).
function deployPairs(name, codexHome) {
  return [
    { outPath: path.join(OUT_DIR, `${name}.toml`), deployTo: path.join(codexHome, `${name}.config.toml`) },
    { outPath: path.join(NATIVE_DIR, `${name}.toml`), deployTo: path.join(codexHome, 'agents', `${name}.toml`) },
  ];
}

module.exports = { deployPairs, MANIFEST, generateOne, advisorsToDeploy, deployTeam, removeRetired, loadEq, parseAdvisor, withCodexModel, orgCodexModel, deployedContent };
if (require.main === module) {
  try { process.exit(main()); } catch (e) { console.error(`generate.js: ${e.message}`); process.exit(1); }
}
