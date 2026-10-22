#!/usr/bin/env node
/**
 * context-budget.js — audit de consumo de tokens del harness TYCON.
 *
 * Escanea lo que se carga en CADA sesión nueva de Claude Code:
 *   - Skills: ~/.claude/agent-skills/skills/<n>/SKILL.md (descripciones cargadas)
 *   - Agents: ~/.claude/agents/*.md (descripciones cargadas)
 *   - MCPs: ~/.claude/settings.json + <cwd>/.mcp.json (schemas de tools)
 *   - CLAUDE.md: user-global + cwd chain
 *   - Engram observations cargadas en SessionStart
 *
 * Output: reporte con totales por categoría + top heavy hitters + recomendaciones.
 *
 * Uso:
 *   node ~/.claude/tycon-harness/scripts/tools/context-budget.js          # reporte default
 *   node ~/.claude/tycon-harness/scripts/tools/context-budget.js --verbose # con per-file breakdown
 *   node ~/.claude/tycon-harness/scripts/tools/context-budget.js --json   # output JSON
 *   node ~/.claude/tycon-harness/scripts/tools/context-budget.js --measured [--days N]   # el piso real de los lanzamientos
 *
 * Inspirado en ECC skills/context-budget/SKILL.md, adaptado al stack TYCON.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Los nombres viejos de las opciones se traducen ANTES de leer argv, y sólo por línea de comandos:
// harness-audit.js carga este archivo como biblioteca, con su propio argv.
if (require.main === module) require('../lib/legacy-names.js').aliasArgv('scripts/tools/context-budget.js');

const HOME = os.homedir();
const VERBOSE = process.argv.includes('--verbose');
const JSON_OUT = process.argv.includes('--json');
// `--measured [--days N]`: el piso REAL de los lanzamientos, al lado del estimado.
const MEDIDO = process.argv.includes('--measured');
// `--main-session`: el arranque REAL de la sesión principal (el primer pedido de cada sesión), al lado del estimado.
const SESION_PRINCIPAL = process.argv.includes('--main-session');
const DIAS = (() => { const i = process.argv.indexOf('--days'); const v = i >= 0 ? Number(process.argv[i + 1]) : NaN; return Number.isFinite(v) && v > 0 ? v : 7; })();
const CWD = process.cwd();

// --exclude-mcps "name1,name2" — fuerza a NO contar esos MCP servers. Útil
// cuando apagaste un Anthropic Connector desde claude.ai/settings/connectors
// y el script no tiene cómo detectarlo (los Connectors no viven en settings.json).
// Match es por substring case-insensitive — "Wix" matchea "claude_ai_Wix".
function getExcludeMCPs() {
  const i = process.argv.indexOf('--exclude-mcps');
  if (i === -1 || !process.argv[i + 1]) return [];
  return process.argv[i + 1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
const EXCLUDE_MCPS = getExcludeMCPs();

// Heurísticas de estimación (ECC: words×1.3 prosa, chars/4 código).
// Usamos chars/4 universal — over-estima un poco prosa pero es más predecible.
const tokensFor = (s) => Math.round(s.length / 4);

// Average tokens por tool schema MCP (ECC: ~500 tokens/tool).
const TOKENS_PER_MCP_TOOL = 500;
// 🔴 Un servidor que la cuenta NO tiene autorizado no carga sus esquemas: cobrarlo a 500/tool
// inflaría la cuenta a 48.500, puntuaría 0/10 y recomendaría desconectar conectores. Claude Code escribe la lista
// de los que piden autorización en `~/.claude/mcp-needs-auth-cache.json`; ésos se cobran un
// MÍNIMO (el nombre, no el esquema). Cuánto cuesta exactamente un nombre diferido NO se midió: el
// número de abajo es un piso declarado, no una medición — y el reporte lo dice.
// 🔴 Esta cuenta está COPIADA en scripts/lib/harness-audit.js (su categoría «Context Efficiency»): quien
// toque el precio de una herramienta o el criterio de «sin autorizar» toca las dos, y el caso C-05 de
// scripts/tests/context-budget.test.sh compara los dos números.
const TOKENS_PER_UNLOADED_TOOL = 12;
function serversSinAutorizar() {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(HOME, '.claude/mcp-needs-auth-cache.json'), 'utf8'));
    return new Set(Object.keys(cache).filter((k) => k.startsWith('claude.ai ')).map((k) => k.slice('claude.ai '.length)));
  } catch { return new Set(); }
}
// «claude_ai_Docu_de_MS» ↔ «Docu de MS»
const nombreDeConector = (name) => String(name).replace(/^claude_ai_/, '').replace(/_/g, ' ');

// Conocidos MCP tool counts (observados en sesiones reales). Si el server
// no está acá, usamos default 8 tools.
const MCP_KNOWN_TOOL_COUNTS = {
  'engram': 13,
  'plugin_engram': 13,
  'plugin_engram_engram': 13,
  'chrome-devtools': 25,
  'codegraph': 9,
  'codegraph-frontend': 9,
  'codegraph-backend': 9,
  'clockify': 8,
  'telegram': 4,
  'plugin_telegram': 4,
  'plugin_telegram_telegram': 4,
  'claude_ai_Docu_de_MS': 3,
  'claude_ai_Gamma': 8,
  'claude_ai_Gmail': 13,
  'claude_ai_Google_Calendar': 8,
  'claude_ai_Google_Drive': 8,
  'claude_ai_Wix': 19,
};
const DEFAULT_MCP_TOOL_COUNT = 8;

// Categorización: qué consideramos "core TYCON" vs "domain irrelevant".
const TYCON_CORE_MCPS = new Set([
  'engram', 'plugin_engram', 'plugin_engram_engram',
  'codegraph', 'codegraph-frontend', 'codegraph-backend',
  'clockify', 'telegram', 'plugin_telegram', 'plugin_telegram_telegram',
  'claude_ai_Docu_de_MS', // .NET docs útil
]);
const TYCON_IRRELEVANT_MCPS = new Set([
  'claude_ai_Wix', 'claude_ai_Gamma', 'claude_ai_Gmail',
  'claude_ai_Google_Calendar', 'claude_ai_Google_Drive',
]);

// Prefijos de skills no relacionadas al stack TYCON (.NET, Next.js, React, BMAD).
// Estos NO bloqueamos — solo flageamos como "considerar deshabilitar".
const SKILL_DOMAIN_PATTERNS = {
  irrelevant: [
    'algorithmic-art', 'manim', 'blender', 'kotlin-coroutines',
    'compose-multiplatform', 'gan-style', 'foundation-models-on-device',
    'swift-actor', 'swift-concurrency', 'swift-protocol', 'swiftui',
    'harmonyos', 'dart-flutter', 'flutter-', 'remotion-', 'videodb',
    'fal-ai-media', 'nutrient-document', 'visa-doc',
    'scientific-', 'healthcare-', 'cisco-', 'network-', 'homelab-',
    'energy-procurement', 'carrier-relationship', 'customs-trade',
    'inventory-demand', 'production-scheduling', 'quality-nonconformance',
    'returns-reverse', 'logistics-exception',
    'kotlin-exposed', 'kotlin-ktor', 'kotlin-testing', 'kotlin-patterns',
    'perl-', 'fsharp-',
    'spring-boot', 'springboot-', 'quarkus-',
    'tinystruct', 'jpa-patterns',
    'laravel-',
    'django-',
    'rust-patterns', 'rust-testing',
    'golang-patterns', 'golang-testing',
    'angular-developer', 'nuxt4-', 'nestjs-', 'vite-patterns',
    'redis-patterns', 'prisma-patterns', 'mysql-patterns',
    'fastapi-patterns', 'pytorch-patterns',
    'java-coding', 'cpp-', 'csharp-testing',
  ],
};

// ============================================================
// Helpers
// ============================================================

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

function readFrontmatterDescription(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8').slice(0, 3000);
    const m = /^description:\s*(.+?)(?:\n[a-z_]+:|\n---)/ms.exec(content);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function countLines(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').split('\n').length; }
  catch { return 0; }
}

function isIrrelevantSkill(name) {
  return SKILL_DOMAIN_PATTERNS.irrelevant.some(p => name.startsWith(p) || name === p);
}

// ============================================================
// Inventory
// ============================================================

function inventorySkills() {
  const skillsDir = path.join(HOME, '.claude/agent-skills/skills');
  if (!exists(skillsDir)) return { items: [], totalTokens: 0, count: 0 };

  const items = [];
  for (const name of fs.readdirSync(skillsDir).sort()) {
    const skillMd = path.join(skillsDir, name, 'SKILL.md');
    if (!exists(skillMd)) continue;
    const desc = readFrontmatterDescription(skillMd);
    if (!desc) continue;
    const tokens = tokensFor(desc);
    items.push({
      name,
      descChars: desc.length,
      tokens,
      lines: countLines(skillMd),
      irrelevant: isIrrelevantSkill(name),
    });
  }
  const totalTokens = items.reduce((a, x) => a + x.tokens, 0);
  return { items, totalTokens, count: items.length };
}

function inventoryAgents() {
  const agentsDir = path.join(HOME, '.claude/agents');
  if (!exists(agentsDir)) return { items: [], totalTokens: 0, count: 0 };

  const items = [];
  for (const f of fs.readdirSync(agentsDir).sort()) {
    if (!f.endsWith('.md')) continue;
    const p = path.join(agentsDir, f);
    const desc = readFrontmatterDescription(p);
    if (!desc) continue;
    const tokens = tokensFor(desc);
    items.push({
      name: f.replace('.md', ''),
      descChars: desc.length,
      tokens,
      lines: countLines(p),
    });
  }
  const totalTokens = items.reduce((a, x) => a + x.tokens, 0);
  return { items, totalTokens, count: items.length };
}

/** Las transcripciones de las sesiones principales (`projects/<proyecto>/<sesión>.jsonl`, no las de subagentes),
 *  de la más nueva a la más vieja, de los últimos `dias`. */
function transcripcionesPrincipales({ home = HOME, dias = 7 } = {}) {
  const raiz = path.join(home, '.claude/projects');
  const desde = Date.now() - dias * 864e5;
  let proyectos;
  try { proyectos = fs.readdirSync(raiz, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return null; }
  const out = [];
  for (const p of proyectos) {
    let entradas;
    try { entradas = fs.readdirSync(path.join(raiz, p), { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const ruta = path.join(raiz, p, e.name);
      let mtime; try { mtime = fs.statSync(ruta).mtimeMs; } catch { continue; }
      if (mtime >= desde) out.push({ ruta, mtime });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime || a.ruta.localeCompare(b.ruta)).map((x) => x.ruta);
}

/**
 * ¿Claude Code difiere las herramientas de los MCP en esta máquina? Lo dice la transcripción: con las herramientas
 * diferidas, el arranque trae un adjunto `deferred_tools_delta` con sus nombres y no sus esquemas. Mira las 20 sesiones
 * más nuevas; difiere si la mayoría lo trae. Sin transcripciones devuelve `null`: no se sabe, y no es «no diferidos».
 */
function mcpsDiferidos({ home = HOME, dias = 7 } = {}) {
  const rutas = (transcripcionesPrincipales({ home, dias }) || []).slice(0, 20);
  if (!rutas.length) return null;
  let con = 0;
  for (const r of rutas) {
    try { if (fs.readFileSync(r, 'utf8').includes('"deferred_tools_delta"')) con++; } catch { /* ilegible: no cuenta */ }
  }
  return con * 2 > rutas.length;
}

/**
 * El arranque REAL de la sesión principal (`--main-session`): el total del primer pedido de cada sesión (entrada +
 * caché creada + caché leída), que es todo lo fijo más el primer mensaje. Sólo números; ninguna ruta ni texto.
 */
function medirSesionPrincipal({ home = HOME, dias = 7 } = {}) {
  const desde = new Date(Date.now() - dias * 864e5).toISOString();
  const rutas = transcripcionesPrincipales({ home, dias });
  if (rutas === null) return { estado: 'no_medido', motivo: `no pude leer ${path.join(home, '.claude/projects').replace(home, '~')}`, n: null, mediana: null, desde };
  const totales = [];
  let ilegibles = 0;
  for (const r of rutas) {
    let txt; try { txt = fs.readFileSync(r, 'utf8'); } catch { ilegibles++; continue; }
    for (const linea of txt.split('\n')) {
      if (!linea.includes('"assistant"')) continue;
      let o; try { o = JSON.parse(linea); } catch { continue; }
      if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
      const u = o.message.usage;
      const t = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      if (t > 0) totales.push(t);
      break;
    }
  }
  if (!totales.length) return { estado: 'no_medido', motivo: `sin sesiones principales con un primer pedido en los últimos ${dias} día(s)`, n: null, mediana: null, ilegibles, desde };
  const s = [...totales].sort((a, b) => a - b);
  return { estado: 'medido', n: s.length, mediana: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], min: s[0], max: s[s.length - 1], ilegibles, desde };
}

function inventoryMCPs({ diferidos = false } = {}) {
  const sources = [];

  // User-global settings.json
  const userSettings = path.join(HOME, '.claude/settings.json');
  if (exists(userSettings)) {
    try {
      const s = JSON.parse(fs.readFileSync(userSettings, 'utf8'));
      const servers = s.mcpServers || (s.mcp && s.mcp.servers) || {};
      for (const name of Object.keys(servers)) {
        sources.push({ name, source: 'user-global', config: servers[name] });
      }
    } catch {}
  }

  // CWD .mcp.json
  const cwdMcp = path.join(CWD, '.mcp.json');
  if (exists(cwdMcp)) {
    try {
      const s = JSON.parse(fs.readFileSync(cwdMcp, 'utf8'));
      const servers = s.mcpServers || {};
      for (const name of Object.keys(servers)) {
        sources.push({ name, source: 'project', config: servers[name] });
      }
    } catch {}
  }

  // Enabled plugins (de settings.json enabledPlugins) — cada plugin puede
  // contribuir MCPs no listados explícitamente. Marcamos esto.
  let pluginCount = 0;
  if (exists(userSettings)) {
    try {
      const s = JSON.parse(fs.readFileSync(userSettings, 'utf8'));
      pluginCount = Object.keys(s.enabledPlugins || {}).length;
    } catch {}
  }

  // Heurística: MCPs vistos en system reminders pero NO en settings (cargados
  // via plugins externos como claude_ai_*). Estos son los Anthropic Connectors.
  // No los podemos leer del filesystem — los marcamos como "inferred".
  const inferredMCPs = [
    'claude_ai_Docu_de_MS', 'claude_ai_Gamma', 'claude_ai_Gmail',
    'claude_ai_Google_Calendar', 'claude_ai_Google_Drive', 'claude_ai_Wix',
  ];
  for (const name of inferredMCPs) {
    if (!sources.find(s => s.name === name)) {
      sources.push({ name, source: 'inferred-anthropic-connector', config: null });
    }
  }

  const sinAutorizar = serversSinAutorizar();
  const items = sources
    .filter(s => !EXCLUDE_MCPS.some(ex => s.name.toLowerCase().includes(ex)))
    .map(s => {
      const toolCount = MCP_KNOWN_TOOL_COUNTS[s.name] ?? DEFAULT_MCP_TOOL_COUNT;
      const noAutorizado = s.source === 'inferred-anthropic-connector' && sinAutorizar.has(nombreDeConector(s.name));
      const tokens = toolCount * (noAutorizado || diferidos ? TOKENS_PER_UNLOADED_TOOL : TOKENS_PER_MCP_TOOL);
      return {
        name: s.name,
        source: s.source,
        toolCount,
        tokens,
        sinAutorizar: noAutorizado,
        isCore: TYCON_CORE_MCPS.has(s.name),
        isIrrelevant: TYCON_IRRELEVANT_MCPS.has(s.name),
        hardcoded: MCP_KNOWN_TOOL_COUNTS[s.name] !== undefined,
      };
    });

  const totalTokens = items.reduce((a, x) => a + x.tokens, 0);
  return { items, totalTokens, count: items.length, pluginCount, diferidos };
}

// 🔴 Los `@imports` se SIGUEN. Si esta función leyera sólo los archivos `CLAUDE.md` y no sus imports,
// reportaría 4.724 tokens para una cadena de ~276 KB, con el README del arnés —235.771 bytes ≈ 76 mil
// tokens, el 61 % del piso de un revisor— INVISIBLE: la herramienta con la que se decide qué recortar
// del arranque no vería el ítem más grande.
const MAX_PROFUNDIDAD = 5;

// Las líneas `@ruta` de un archivo, resueltas contra HOME o contra la carpeta del que importa.
function importsDe(contenido, archivo) {
  const out = [];
  for (const linea of contenido.split('\n')) {
    const m = /^@(\S+)\s*$/.exec(linea);
    if (!m) continue;
    let ruta = m[1];
    if (ruta.startsWith('~/')) ruta = path.join(HOME, ruta.slice(2));
    else if (!path.isAbsolute(ruta)) ruta = path.resolve(path.dirname(archivo), ruta);
    out.push(ruta);
  }
  return out;
}

function inventoryClaudeMd() {
  const items = [];
  const vistos = new Set();   // por ruta REAL: el mismo archivo importado dos veces se carga una

  // Agrega un archivo y, recursivamente, lo que él importa.
  const agregar = (archivo, scope, profundidad, fueraDeCasa = false) => {
    let real;
    try { real = fs.realpathSync(archivo); } catch { real = archivo; }
    if (vistos.has(real)) return;
    vistos.add(real);
    const content = fs.readFileSync(archivo, 'utf8');
    items.push({
      path: archivo.replace(HOME, '~'),
      lines: content.split('\n').length,
      tokens: tokensFor(content),
      scope,
      ...(fueraDeCasa ? { fueraDeCasa: true } : {}),
    });
    if (profundidad >= MAX_PROFUNDIDAD) return;
    for (const imp of importsDe(content, archivo)) {
      const desde = `import de ${path.basename(archivo)}`;
      // 🔴 Un `@import` puede apuntar a donde sea, incluso fuera del home. NO se excluye: Claude Code lo carga igual, y saltearlo haría que
      // esta medición subestime lo que de verdad pesa el arranque. Se MARCA, para que se vea en el reporte.
      const fueraDeCasa = path.relative(HOME, imp).startsWith('..');
      if (!exists(imp)) {
        // Un import que no está NO corta el reporte: se lista, con 0 tokens y dicho.
        let realImp; try { realImp = fs.realpathSync(imp); } catch { realImp = imp; }
        if (vistos.has(realImp)) continue;
        vistos.add(realImp);
        items.push({ path: imp.replace(HOME, '~'), lines: 0, tokens: 0, scope: desde, missing: true, fueraDeCasa });
        continue;
      }
      agregar(imp, desde, profundidad + 1, fueraDeCasa);
    }
  };

  // User-global + su cadena de imports
  const userMd = path.join(HOME, '.claude/CLAUDE.md');
  if (exists(userMd)) agregar(userMd, 'user-global', 0);

  // CWD chain (walk up looking for CLAUDE.md) + la cadena de imports de cada uno
  let dir = CWD;
  while (dir !== '/' && dir !== HOME) {
    const md = path.join(dir, 'CLAUDE.md');
    if (exists(md)) agregar(md, 'project', 0);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const totalTokens = items.reduce((a, x) => a + x.tokens, 0);
  return { items, totalTokens, count: items.length };
}

// ── El piso MEDIDO de cada lanzamiento (`--measured`) ─────────────────────────────────
// Todo lo de arriba es una ESTIMACIÓN (`chars/4`). Medido, el contenido del arnés tokeniza a 3,08
// bytes/token: la estimación queda ~30 % por debajo, y con ella se decide qué recortar. Esto pone al
// lado el número REAL: los tokens del PRIMER pedido de cada subagente —lo que carga antes de leer un
// archivo—, leídos de `~/.claude/projects/<slug>/<sesión>/subagents/agent-*.jsonl`.
// Nunca imprime una ruta de transcripción ni un prompt: sólo números y el tipo de agente.
function medirPiso({ home = HOME, dias = 7 } = {}) {
  const raiz = path.join(home, '.claude/projects');
  const desde = new Date(Date.now() - dias * 864e5).toISOString();
  const pisos = [];
  const porTipo = {};
  let ilegibles = 0;
  let sinConsumo = 0;   // primer pedido con el consumo en cero: no es un piso de 0, es «no se pudo medir»
  let huboRaiz = false;

  // 🔴 `.sort()` en cada listado de directorio: sin él, dos tipos con la MISMA mediana saldrían en el
  // orden incidental con que el sistema de archivos devuelve las carpetas, y con más de 8 tipos un
  // empate en el borde del corte haría aparecer o desaparecer un tipo del listado. Las otras dos
  // lecturas de directorio de este archivo (inventorySkills, inventoryAgents) también ordenan.
  const dirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return null; } };

  // 🔴 Las transcripciones de subagentes NO están todas en `subagents/*.jsonl`: las de los lanzados
  // por la tool Workflow (los hunters del pase adversarial, por ejemplo) viven un nivel más abajo, en
  // `subagents/workflows/<id>/*.jsonl`. Mirar sólo los hijos directos se saltearía EN SILENCIO la mayoría
  // de los lanzamientos reales (513 contados contra 874 ignorados en una máquina): el «piso medido»
  // saldría de una minoría no aleatoria y sin un solo aviso — un «verde que significa no miré nada».
  // Caso: C-07c.
  const transcripciones = (raizSub) => {
    const out = [];
    const bajar = (d, prof) => {
      let entradas;
      try { entradas = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entradas.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.isDirectory()) { if (prof < 3) bajar(path.join(d, e.name), prof + 1); continue; }
        if (e.name.endsWith('.jsonl')) out.push(path.join(d, e.name));
      }
    };
    bajar(raizSub, 0);
    return out;
  };
  const proyectos = dirs(raiz);
  if (proyectos === null) return { estado: 'no_medido', motivo: `no pude leer ${raiz.replace(home, '~')} (¿esta máquina no corrió subagentes?)`, n: null, desde };
  huboRaiz = true;

  for (const proy of proyectos) {
    for (const ses of dirs(path.join(raiz, proy)) || []) {
      const sub = path.join(raiz, proy, ses, 'subagents');
      for (const ruta of transcripciones(sub)) {
        const f = path.basename(ruta);
        let txt; try { txt = fs.readFileSync(ruta, 'utf8'); } catch { ilegibles++; continue; }
        let primero = null, ts = null, roto = false;
        for (const linea of txt.split('\n')) {
          if (!linea.trim()) continue;
          let o; try { o = JSON.parse(linea); } catch { roto = true; continue; }
          if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
          const u = o.message.usage;
          primero = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          ts = o.timestamp || null;
          break;
        }
        if (primero === null) { if (roto) ilegibles++; continue; }
        if (ts && ts < desde) continue;
        // 🔴 Un primer pedido de 0 tokens es imposible: el agente nunca llegó a pedir nada. Medido:
        // 120 de 1.372 transcripciones de una máquina vienen así, y entrarían a la muestra arrastrando
        // el mínimo a 0 y la mediana hacia abajo. Se cuentan APARTE: un cero publicado como medición
        // sería un dato falso. Caso: C-07c2.
        if (primero === 0) { sinConsumo++; continue; }
        let tipo = '?';
        try { tipo = JSON.parse(fs.readFileSync(ruta.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType || '?'; } catch { /* sin meta: '?' */ }
        pisos.push(primero);
        (porTipo[tipo] ||= { n: 0, pisos: [] }).pisos.push(primero);
        porTipo[tipo].n++;
      }
    }
  }
  const mediana = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  if (!pisos.length) {
    return { estado: 'no_medido', n: null, ilegibles, sin_consumo: sinConsumo, desde,
      motivo: huboRaiz ? `sin transcripciones de subagentes en los últimos ${dias} día(s)` : 'no pude leer las transcripciones' };
  }
  for (const t of Object.keys(porTipo)) { porTipo[t].mediana = mediana(porTipo[t].pisos); delete porTipo[t].pisos; }
  // `por_tipo` se devuelve con las claves ORDENADAS: así el JSON es el mismo con los mismos datos,
  // sin depender del orden en que se insertaron (que es el orden del recorrido del disco).
  const porTipoOrdenado = {};
  for (const t of Object.keys(porTipo).sort()) porTipoOrdenado[t] = porTipo[t];
  return { estado: 'medido', n: pisos.length, mediana: mediana(pisos), min: Math.min(...pisos), max: Math.max(...pisos), por_tipo: porTipoOrdenado, ilegibles, sin_consumo: sinConsumo, desde };
}

// ============================================================
// Report
// ============================================================

function fmt(n) { return n.toLocaleString('en-US'); }
function pct(part, total) { return total === 0 ? '0%' : `${Math.round((part / total) * 100)}%`; }

function renderReport({ skills, agents, mcps, claudemd, medido, sesion }) {
  const grand = skills.totalTokens + agents.totalTokens + mcps.totalTokens + claudemd.totalTokens;
  // Presupuesto que se fija el arnés, NO la ventana del modelo: Sonnet 5, Opus 5 y Fable 5.1 llegan a
  // 1M; 200K es la ventana de Haiku 4.5, el modelo de los revisores baratos (subagentes, que sí cargan
  // este contexto). Pasarlo a 1M aflojaría 5× el tope del 25 % de harness-audit sin que
  // el piso real baje.
  const contextWindow = 200_000;
  const headroomPct = Math.round(((contextWindow - grand) / contextWindow) * 100);

  const lines = [];
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('   TYCON Context Budget Report');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  cwd: ${CWD}`);
  lines.push(`  presupuesto de contexto: ${fmt(contextWindow)} tokens (fijado por el arnés; la ventana de Sonnet 5 / Opus 5 / Fable 5.1 es 1M)`);
  lines.push(`  harness overhead: ~${fmt(grand)} tokens (${pct(grand, contextWindow)} del presupuesto)`);
  lines.push(`  headroom efectivo: ~${fmt(contextWindow - grand)} tokens (${headroomPct}%)`);
  lines.push('');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('  Breakdown por categoría');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');
  const rows = [
    ['Skills (descripciones)',   skills.count,   skills.totalTokens],
    ['Agents (descripciones)',   agents.count,   agents.totalTokens],
    ['MCP servers (schemas)',    mcps.count,     mcps.totalTokens],
    ['CLAUDE.md chain',          claudemd.count, claudemd.totalTokens],
  ];
  for (const [cat, count, tokens] of rows) {
    const bar = '█'.repeat(Math.min(40, Math.round((tokens / grand) * 40)));
    lines.push(`  ${cat.padEnd(28)}  ${String(count).padStart(3)}  ~${fmt(tokens).padStart(7)} tok  ${pct(tokens, grand).padStart(4)}  ${bar}`);
  }
  lines.push('');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('  Top heavy hitters');
  lines.push('───────────────────────────────────────────────────────────────');

  // Top 5 MCPs (biggest lever — ECC dixit)
  lines.push('');
  lines.push(mcps.diferidos
    ? '  MCP servers (herramientas DIFERIDAS: Claude Code trae el esquema a pedido; se cobra sólo el nombre):'
    : mcps.diferidos === null
      ? '  MCP servers (no medido si están diferidos — sin transcripciones; se cobra el esquema entero, ~500 tok por tool):'
      : '  MCP servers (~500 tok por tool schema; «sin autorizar» = esquemas NO cargados, se cobra un piso):');
  for (const m of mcps.items.sort((a,b) => b.tokens - a.tokens).slice(0, 8)) {
    const tag = (m.sinAutorizar ? '⏸ sin autorizar (esquemas no cargados) · ' : '') + (m.isCore ? '✓ core' : (m.isIrrelevant ? '✗ irrelevante TYCON' : '— neutral'));
    const inferred = m.source === 'inferred-anthropic-connector' ? ' [Anthropic Connector]' : '';
    lines.push(`    ~${fmt(m.tokens).padStart(6)} tok  ${m.name.padEnd(35)}  ${m.toolCount} tools  ${tag}${inferred}`);
  }

  // Top 5 skills
  lines.push('');
  lines.push('  Skills (top 5 descripciones más pesadas):');
  for (const s of skills.items.sort((a,b) => b.tokens - a.tokens).slice(0, 5)) {
    const flag = s.irrelevant ? '  ⚠ off-stack' : '';
    lines.push(`    ~${String(s.tokens).padStart(4)} tok  ${s.name.padEnd(45)}${flag}`);
  }

  // Top 5 agents
  lines.push('');
  lines.push('  Agents (top 5 descripciones más pesadas):');
  for (const a of agents.items.sort((x,y) => y.tokens - x.tokens).slice(0, 5)) {
    lines.push(`    ~${String(a.tokens).padStart(4)} tok  ${a.name}`);
  }

  // CLAUDE.md
  lines.push('');
  lines.push('  CLAUDE.md cargados:');
  for (const md of claudemd.items) {
    const nota = md.missing ? '  ⚠ declarado y NO encontrado'
      : md.fueraDeCasa ? '  ⚠ importado desde FUERA de tu carpeta personal' : '';
    lines.push(`    ~${String(md.tokens).padStart(6)} tok  ${String(md.lines).padStart(5)} líneas  ${md.path}  [${md.scope}]${nota}`);
  }
  lines.push(`    ── cadena completa (con sus @imports): ~${fmt(claudemd.totalTokens)} tok  (ESTIMADO chars/4)`);
  // 🔴 Este número es un ESTIMADO y subestima. Medido con claude -p sobre el README del arnés:
  // 3,02–3,08 bytes/token contra los 4 que asume chars/4, o sea ~30 % de más real.
  // Se dice acá porque con esta cuenta se decide qué recortar, y la del techo de harness-audit sale
  // de la misma función. El número que NO estima es `--measured`.
  lines.push('       ⚠ chars/4 SUBESTIMA ~30 % (medido: 3,02–3,08 bytes/token en el contenido del arnés).');
  lines.push('         El número real de lo que carga un lanzamiento: --measured.');

  // El arranque REAL de la sesión principal: todo lo fijo (la herramienta, el arnés y lo del dev) más el primer mensaje.
  if (sesion) {
    lines.push('');
    lines.push('  Arranque MEDIDO de la sesión principal (primer pedido de cada sesión — no estimado):');
    if (sesion.estado !== 'medido') lines.push(`    arranque: no medido — ${sesion.motivo}`);
    else lines.push(`    mediana ${fmt(sesion.mediana)} tok  ·  p90 ${fmt(sesion.p90)}  ·  min ${fmt(sesion.min)}  ·  max ${fmt(sesion.max)}  ·  n=${sesion.n} desde ${String(sesion.desde).slice(0, 10)}`);
  }

  // El piso MEDIDO, al lado del estimado. Un estimado solo decide recortes a ciegas.
  if (medido) {
    lines.push('');
    lines.push('  Piso MEDIDO de cada lanzamiento (primer pedido de cada subagente — no estimado):');
    if (medido.estado !== 'medido') {
      lines.push(`    piso medido: no medido — ${medido.motivo}`);
    } else {
      lines.push(`    mediana ${fmt(medido.mediana)} tok  ·  min ${fmt(medido.min)}  ·  max ${fmt(medido.max)}  ·  n=${medido.n} desde ${String(medido.desde).slice(0, 10)}${medido.ilegibles ? `  ·  ${medido.ilegibles} ilegible(s)` : ''}${medido.sin_consumo ? `  ·  ${medido.sin_consumo} sin consumo (no llegaron a pedir nada — no cuentan como piso 0)` : ''}`);
      // el desempate por nombre hace que el listado sea el MISMO en dos máquinas con los mismos datos
      for (const [tipo, v] of Object.entries(medido.por_tipo).sort((a, b) => b[1].mediana - a[1].mediana || a[0].localeCompare(b[0])).slice(0, 8)) {
        lines.push(`      ~${String(fmt(v.mediana)).padStart(8)} tok  n=${String(v.n).padStart(3)}  ${tipo}`);
      }
    }
  }

  // Recomendaciones
  lines.push('');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('  Recomendaciones (ranqueadas por ahorro estimado)');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');

  const recs = recomendaciones({ skills, agents, mcps, claudemd });

  if (recs.length === 0) {
    lines.push('  ✓ No se detectaron optimizaciones obvias. El harness está bien dimensionado.');
  } else {
    const totalSavings = recs.reduce((a,x) => a + x.savings, 0);
    recs.forEach((r, i) => {
      lines.push(`  ${i+1}. ${r.action}`);
      lines.push(`     → ahorro estimado: ~${fmt(r.savings)} tokens (${pct(r.savings, grand)})`);
      lines.push(`     → ${r.how}`);
      lines.push('');
    });
    lines.push(`  Ahorro potencial total: ~${fmt(totalSavings)} tokens (${pct(totalSavings, grand)} del overhead actual)`);
    lines.push(`  Overhead final estimado: ~${fmt(grand - totalSavings)} tokens (${pct(grand - totalSavings, contextWindow)} del presupuesto)`);
  }
  return cerrarReporte(lines, { skills, agents });
}

/** Las recomendaciones de recorte, de mayor a menor ahorro. Las comparten el reporte y la salida JSON. */
function recomendaciones({ skills, agents, mcps, claudemd }) {
  const recs = [];

  // El archivo IMPORTADO más pesado de la cadena entra en la cuenta y en las recomendaciones: sin esto,
  // el ítem más grande del arranque no podría salir sugerido nunca.
  const importados = claudemd.items.filter((i) => String(i.scope).startsWith('import de') && !i.missing);
  const peor = importados.sort((a, b) => b.tokens - a.tokens)[0];
  if (peor && peor.tokens > 20000) {
    recs.push({
      savings: peor.tokens,
      action: `Recortar ${peor.path} — se importa ENTERO en cada sesión y en cada subagente`,
      how: 'Dejarlo como índice y mover el detalle a una guía de lectura a demanda. Si es el README del arnés, su techo vive en claude-md-blocks/budget.json → imported (story 7.4).',
    });
  }

  // Con las herramientas diferidas, desconectar un MCP no ahorra lo que pesaba su esquema: sólo su nombre. Si no se
  // sabe (sin transcripciones), tampoco se promete el ahorro.
  const irrelevantMCPs = mcps.diferidos === false ? mcps.items.filter(m => m.isIrrelevant) : [];
  if (irrelevantMCPs.length > 0) {
    const savings = irrelevantMCPs.reduce((a,x) => a + x.tokens, 0);
    recs.push({
      savings,
      action: `Desconectar ${irrelevantMCPs.length} MCPs irrelevantes para TYCON (${irrelevantMCPs.map(m => m.name.replace(/^claude_ai_/,'')).join(', ')})`,
      how: 'Settings → Connectors en Claude.ai, o /mcp disable en Claude Code.',
    });
  }

  const irrelevantSkills = skills.items.filter(s => s.irrelevant);
  if (irrelevantSkills.length > 5) {
    const savings = irrelevantSkills.reduce((a,x) => a + x.tokens, 0);
    recs.push({
      savings,
      action: `Deshabilitar ${irrelevantSkills.length} skills off-stack (Kotlin/Swift/Spring/Django/etc.)`,
      how: 'Editar enabledPlugins en ~/.claude/settings.json o desinstalar packs no usados.',
    });
  }

  const heavyAgents = agents.items.filter(a => a.descChars > 400);
  if (heavyAgents.length > 0) {
    const savings = heavyAgents.reduce((a,x) => a + (x.tokens - tokensFor('x'.repeat(200))), 0);
    recs.push({
      savings,
      action: `Recortar descripciones de ${heavyAgents.length} agents con >400 chars (target: 200 chars)`,
      how: 'Editar el frontmatter description: de cada advisor. Mantener el "cuándo invocarlo" + 1 ej concreto; mover ejemplos largos al body.',
    });
  }

  const heavySkills = skills.items.filter(s => s.descChars > 400);
  if (heavySkills.length > 0) {
    const savings = heavySkills.reduce((a,x) => a + (x.tokens - tokensFor('x'.repeat(200))), 0);
    recs.push({
      savings,
      action: `Recortar descripciones de ${heavySkills.length} skills con >400 chars`,
      how: 'Idem agents. Top: ' + heavySkills.sort((a,b)=>b.descChars-a.descChars).slice(0,3).map(s => s.name).join(', '),
    });
  }
  return recs.sort((a,b) => b.savings - a.savings);
}

function cerrarReporte(lines, { skills, agents }) {
  // Verbose mode: per-file breakdown
  if (VERBOSE) {
    lines.push('');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('  Verbose: per-file breakdown');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('');
    lines.push('  Todos los skills ordenados por tokens:');
    for (const s of skills.items.sort((a,b) => b.tokens - a.tokens)) {
      lines.push(`    ~${String(s.tokens).padStart(4)} tok  ${s.descChars.toString().padStart(4)} chars  ${s.lines.toString().padStart(4)} lines  ${s.name}${s.irrelevant ? '  [off-stack]' : ''}`);
    }
    lines.push('');
    lines.push('  Todos los agents ordenados por tokens:');
    for (const a of agents.items.sort((x,y) => y.tokens - x.tokens)) {
      lines.push(`    ~${String(a.tokens).padStart(4)} tok  ${a.descChars.toString().padStart(4)} chars  ${a.lines.toString().padStart(4)} lines  ${a.name}`);
    }
  }

  lines.push('');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('  Notas');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push('  • Las estimaciones usan chars/4 (precision ±15% vs tokenizer real).');
  lines.push('  • MCP tools por server: hardcoded para servers conocidos; default 8 para unknown. Si las');
  lines.push('    transcripciones muestran herramientas diferidas, se cobra sólo el nombre de cada una.');
  lines.push('  • Esto mide LO QUE SE CARGA SIEMPRE (descripciones, schemas). El body de');
  lines.push('    las skills solo se carga si el agente las invoca activamente.');
  lines.push('  • Engram observations cargadas en SessionStart no están incluidas (rotan).');
  lines.push('  • Re-correr post-cambio: node ~/.claude/tycon-harness/scripts/tools/context-budget.js');
  lines.push('');

  return lines.join('\n');
}

// ============================================================
// Main
// ============================================================

function main() {
  const data = {
    skills: inventorySkills(),
    agents: inventoryAgents(),
    mcps: inventoryMCPs({ diferidos: mcpsDiferidos({ home: HOME, dias: DIAS }) }),
    claudemd: inventoryClaudeMd(),
  };
  if (MEDIDO) data.medido = medirPiso({ home: HOME, dias: DIAS });
  if (SESION_PRINCIPAL) data.sesion = medirSesionPrincipal({ home: HOME, dias: DIAS });
  if (JSON_OUT) {
    const { sesion, ...resto } = data;
    console.log(JSON.stringify({ ...resto, ...(sesion ? { sesion_principal: sesion } : {}), recomendaciones: recomendaciones(data) }, null, 2));
  } else console.log(renderReport(data));
}

module.exports = { inventoryClaudeMd, inventorySkills, inventoryAgents, inventoryMCPs, mcpsDiferidos, medirSesionPrincipal, medirPiso, tokensFor, importsDe };
// 🔴 La guarda es necesaria para que `harness-audit.js` pueda IMPORTAR la cuenta de la cadena en vez
// de copiarla: sin ella, requerir este archivo imprimiría el reporte entero.
if (require.main === module) main();
