#!/usr/bin/env node
/**
 * harness-audit.js — check-up determinístico del harness TYCON.
 *
 * Score 0-10 sobre 8 categorías + reporte de findings + top 3 acciones.
 *
 * Inspirado en ECC harness-audit. Categorías adaptadas al stack TYCON:
 *   1. Advisor Coverage — cantidad de advisors instalados vs esperado
 *   2. Context Efficiency — overhead del harness vs context window
 *   3. Quality Gates — hooks bloqueantes (DoD, frontmatter, pre-commit)
 *   4. Memory Persistence — engram + recencia de observations
 *   5. Catalog Integrity — usa rules-distill internamente
 *   6. Security Guardrails — safety-guard + signed-scope + las guías de los paquetes instalados
 *   7. Pipeline Wiring — coherencia entre SKILL.md + step-05 + pipeline.js
 *   8. Learning Loop — features de aprendizaje vivos (anti feature-dead:
 *      instinct-mining prendido, capturer con trigger, run-check en uso)
 *
 * Cada categoría tiene checks específicos. Score por categoría se calcula
 * como (passed / total) * 10. Score total = average de las 8 categorías.
 *
 * Uso:
 *   node ~/.claude/tycon-harness/scripts/lib/harness-audit.js          # reporte text
 *   node ~/.claude/tycon-harness/scripts/lib/harness-audit.js --json   # output JSON
 *   node ~/.claude/tycon-harness/scripts/lib/harness-audit.js --verbose # detalle por check
 *
 * Rubric version: 2026-05-23 (TYCON v1).
 */

'use strict';

const fs = require('fs');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const os = require('os');
const { execSync, execFileSync } = require('child_process');

const HOME = os.homedir();
const JSON_OUT = process.argv.includes('--json');

// ── Paridad de instalación Claude↔Codex (Etapa H) ────────────────────────────────────────────
// Una sola herramienta de diagnóstico: el scorecard mide el lado Claude; `--parity` mide que el
// lado Codex de ESTA máquina refleje el canónico (11 superficies fs-only, detalle en
// scripts/lib/harness-parity.js). Se corre acá y no en un doctor aparte a propósito.
if (process.argv.includes('--parity')) {
  process.exit(require('./harness-parity.js').runParity({ json: JSON_OUT }));
}
const VERBOSE = process.argv.includes('--verbose');

// `TYCON_AGENTS_DIR` (story 8.2): la misma variable que lee el cargador de paquetes del pipeline;
// la usan las pruebas para auditar contra una carpeta de agentes de mentira.
const AGENTS_DIR = process.env.TYCON_AGENTS_DIR || path.join(HOME, '.claude/agents');
const SKILLS_DIR = path.join(HOME, '.claude/agent-skills/skills');
const SETTINGS = path.join(HOME, '.claude/settings.json');
const TCG_ROOT = path.resolve(__dirname, '..', '..');   // el clon donde vive este archivo, en scripts/lib/ (story 8.3: ninguna carpeta escrita a mano)
const TCG_GUIDES = path.join(TCG_ROOT, 'guides');
const TCG_SCRIPTS = path.join(TCG_ROOT, 'scripts');
const CATALOG = path.join(TCG_GUIDES, 'advisor-rules-catalog.md');

// Dónde viven los repos del equipo en ESTA máquina. Hardcodear la carpeta de una máquina hacía que los
// chequeos de memoria devolvieran cero repos en cualquier otra máquina — y cero repos se lee
// igual que "está todo bien". Ver scripts/lib/repos-root.js.
// El binario de sqlite3. Configurable porque no siempre está en el PATH ni en el mismo lugar:
// engram NO lo instala (lleva su propio SQLite compilado adentro, modernc.org/sqlite), así que en
// Windows suele faltar o vivir en una ruta propia. También es lo que permite testear el camino
// "no puedo verificar" sin romper el PATH entero del sandbox.
const SQLITE = process.env.TYCON_SQLITE_BIN || 'sqlite3';

// 🔴 `execFileSync` con ARRAY, nunca un string de shell (corregido 2026-08-25 por la revisión
// adversarial). El string armaba una línea de shell: un binario con ESPACIOS en la ruta —
// `C:\\Program Files\\sqlite3.exe`, que es el caso NORMAL en Windows— pasaba el chequeo de
// existencia y después fallaba al consultar, devolviendo null. Y null, río abajo, se leía como
// "no hay nada raro". El caso se reprodujo: con espacios el binario ni siquiera se invocaba.
function consultar(db, query, timeout) {
  return execFileSync(SQLITE, ['-readonly', db, query],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeout || 15000 });
}

// todas las carpetas de repos de la máquina (puede haber más de una); REPOS_ROOT es la primera
const REPOS_ROOTS = (() => {
  try { return require('./repos-root.js').resolveReposRoot().roots || []; }
  catch (e) {
    // ~/.claude/tycon.json roto: un comando frena (story 8.3) — como CLI, con el archivo, la clave y el motivo y exit 2, no con
    // una traza (pase adversarial de la tanda B); como módulo, el que lo carga decide. Sin raíz → null y cada chequeo dice «no medido».
    if (e && e.name === 'ConfigError') { if (require.main === module) { console.error(e.message); process.exit(2); } throw e; }
    return [];
  }
})();
const REPOS_ROOT = REPOS_ROOTS[0] || null;
/** Con varias raíces y sin una pedida, la función corre en cada una y junta lo que da. */
const enCadaRaiz = (override, fn, juntar) => (!override && REPOS_ROOTS.length > 1 ? juntar(REPOS_ROOTS.map((r) => fn(r))) : null);
const juntarListas = (xs) => (xs.some((x) => x === null) ? null : [].concat(...xs));

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const safeRead = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// ============================================================
// Helpers
// ============================================================

function readSettings() {
  try { return JSON.parse(safeRead(SETTINGS)); } catch { return {}; }
}

function countFiles(dir, ext) {
  if (!exists(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith(ext)).length;
}

// ============================================================
// Categorías de check
// ============================================================

function checkAdvisorCoverage() {
  const checks = [];
  // Sólo el NÚCLEO del pipeline va escrito acá. Los revisores de un producto o de un cliente
  // (convenciones de plugins Bizuit; plugins hermanos; el adaptador de un cliente) viven en los paquetes de revisores
  // (story 8.2) y se exigen leyendo los manifiestos instalados, más abajo: sin paquetes, no se exigen.
  const expectedCoreAdvisors = [
    'tycon-plugin-tests-coverage',
    'tycon-plugin-security-basics',
    'tycon-story-validator',
    'tycon-ac-coverage-checker',
    'tycon-deferral-tracker',
    'tycon-spec-first-checker',
  ];
  const expectedConditional = [
    'tycon-e2e-realness-checker',
    'tycon-dod-runtime-checker',
    'tycon-retrospective-capturer',
    'tycon-silent-failure-hunter',
    'llm-cost-reviewer',
  ];

  for (const a of expectedCoreAdvisors) {
    const p = path.join(AGENTS_DIR, `${a}.md`);
    checks.push({
      name: `Core advisor "${a}" instalado`,
      passed: exists(p),
      file: p,
      severity: 'critical',
    });
  }
  let conditionalPresent = 0;
  for (const a of expectedConditional) {
    if (exists(path.join(AGENTS_DIR, `${a}.md`))) conditionalPresent++;
  }
  // los condicionales de un stack viven en sus paquetes (story 8.41) y se exigen abajo, leyendo los manifiestos
  checks.push({
    name: `Advisors condicionales del núcleo (${conditionalPresent}/${expectedConditional.length})`,
    passed: conditionalPresent === expectedConditional.length,
    file: AGENTS_DIR,
    severity: 'warning',
  });

  // Los revisores de los paquetes instalados (story 8.2): cada agente que un manifiesto declara
  // tiene que estar; y un manifiesto ilegible es una FALLA, no «sin paquete».
  const { paquetes, errores } = require('./installed-packs.js').leerPaquetes();
  for (const e of errores) {
    checks.push({
      name: `Paquete de revisores ilegible: ${e.archivo} — ${e.motivo}`,
      passed: false,
      file: e.archivo,
      severity: 'critical',
    });
  }
  // los que la organización activa (packs.default): un paquete apagado no enlaza sus revisores, y no se le exigen; uno
  // activado que no está, o una configuración ilegible, es una falla (story 8.41)
  let activos = null;
  try {
    const C = require('./tycon-config.js');
    const v = C.valor(C.leer({}), 'packs.default');
    const instalados = paquetes.map((p) => p.nombre);
    if (v === 'all') activos = instalados;
    else if (v === 'none' || v == null) activos = [];
    else {
      activos = v;
      const faltan = v.filter((n) => !instalados.includes(n));
      if (faltan.length) checks.push({ name: `Paquetes de la organización: activa ${faltan.join(', ')} y no está(n) instalado(s)`, passed: false, file: require('./installed-packs.js').leerPaquetes().dir, severity: 'critical' });
    }
  } catch (e) {
    checks.push({ name: `Paquetes de la organización: no pude leer packs.default (${String(e.message).split('\n')[0]})`, passed: false, file: path.join(TCG_ROOT, 'packs'), severity: 'critical' });
  }
  for (const paq of paquetes) {
    if (activos && !activos.includes(paq.nombre)) continue;
    const vistos = new Set();
    for (const r of paq.revisores) {
      if (vistos.has(r.agente)) continue;
      vistos.add(r.agente);
      // instalado = enlazado donde Claude lo carga (~/.claude/agents), venga de la raíz o de la carpeta de su paquete: que
      // el fuente exista en el paquete no prueba que el aplicador lo haya enlazado
      const p = path.join(AGENTS_DIR, `${r.agente}.md`);
      checks.push({
        name: `Revisor "${r.agente}" del paquete ${paq.nombre} instalado`,
        passed: exists(p),
        file: p,
        severity: 'critical',
      });
    }
  }

  return { name: 'Advisor Coverage', checks };
}

function checkContextEfficiency() {
  const checks = [];
  // Reusa heurística de context-budget.js (chars/4 over descriptions + 500/tool MCP)
  let skillsTokens = 0;
  let skillsCount = 0;
  if (exists(SKILLS_DIR)) {
    for (const d of fs.readdirSync(SKILLS_DIR)) {
      const p = path.join(SKILLS_DIR, d, 'SKILL.md');
      if (!exists(p)) continue;
      const content = safeRead(p).slice(0, 3000);
      const m = /^description:\s*(.+?)(?:\n[a-z_]+:|\n---)/ms.exec(content);
      if (m) {
        skillsTokens += Math.round(m[1].trim().length / 4);
        skillsCount++;
      }
    }
  }
  let agentsTokens = 0;
  let agentsCount = 0;
  if (exists(AGENTS_DIR)) {
    for (const f of fs.readdirSync(AGENTS_DIR)) {
      if (!f.endsWith('.md')) continue;
      const content = safeRead(path.join(AGENTS_DIR, f)).slice(0, 3000);
      const m = /^description:\s*(.+?)(?:\n[a-z_]+:|\n---)/ms.exec(content);
      if (m) {
        agentsTokens += Math.round(m[1].trim().length / 4);
        agentsCount++;
      }
    }
  }
  // MCP tools: heurística hardcoded (mismo set que context-budget)
  const knownMCPTokens = {
    'engram': 6500, 'codegraph-frontend': 4500, 'codegraph-backend': 4500,
    'clockify': 4000, 'chrome-devtools': 12500, 'telegram': 2000,
  };
  const s = readSettings();
  const servers = s.mcpServers || (s.mcp && s.mcp.servers) || {};
  let mcpTokens = 0;
  for (const name of Object.keys(servers)) {
    mcpTokens += knownMCPTokens[name] ?? 4000;
  }
  // Anthropic Connectors inferidos
  const inferredConnectors = ['claude_ai_Docu_de_MS', 'claude_ai_Gamma', 'claude_ai_Gmail', 'claude_ai_Google_Calendar', 'claude_ai_Google_Drive', 'claude_ai_Wix'];
  const connectorTokens = { 'claude_ai_Docu_de_MS': 1500, 'claude_ai_Gamma': 4000, 'claude_ai_Gmail': 6500, 'claude_ai_Google_Calendar': 4000, 'claude_ai_Google_Drive': 4000, 'claude_ai_Wix': 9500 };
  // 🔴 Lo NO autorizado no carga esquemas (CONTEXT-BUDGET-TOOLS-DIFERIDAS-1, 2026-09-06): cobrarlo
  // entero inflaba la cuenta a 48.500, puntuaba 0/10 y empujaba a desconectar conectores por un
  // ahorro que no existía. Claude Code deja la lista en `~/.claude/mcp-needs-auth-cache.json`.
  // Misma regla que context-budget.js (dos copias de la cuenta — ver scripts/tests/context-budget.test.sh).
  let sinAutorizar = new Set();
  try {
    const cache = JSON.parse(safeRead(path.join(HOME, '.claude/mcp-needs-auth-cache.json')));
    sinAutorizar = new Set(Object.keys(cache).filter((k) => k.startsWith('claude.ai ')).map((k) => k.slice('claude.ai '.length)));
  } catch { /* sin cache: se asume todo cargado, como antes */ }
  const TOKENS_PER_UNLOADED_TOOL = 12;
  for (const c of inferredConnectors) {
    const nombre = c.replace(/^claude_ai_/, '').replace(/_/g, ' ');
    mcpTokens += sinAutorizar.has(nombre) ? Math.round(connectorTokens[c] / 500) * TOKENS_PER_UNLOADED_TOOL : connectorTokens[c];
  }

  const totalOverhead = skillsTokens + agentsTokens + mcpTokens;
  // Presupuesto que se fija el arnés, no la ventana del modelo (Sonnet 5 / Opus 5 / Fable 5.1 = 1M):
  // ver context-budget.js.
  const windowSize = 200_000;
  const pctOfWindow = (totalOverhead / windowSize) * 100;

  checks.push({
    name: `Overhead total < 25% del presupuesto de 200K (actual: ${pctOfWindow.toFixed(1)}%, ${totalOverhead.toLocaleString()} tok)`,
    passed: pctOfWindow < 25,
    file: '(varios)',
    severity: 'warning',
    detail: { skillsTokens, agentsTokens, mcpTokens, totalOverhead, pctOfWindow: pctOfWindow.toFixed(1) },
  });
  checks.push({
    name: `MCP overhead < 35,000 tokens (actual: ${mcpTokens.toLocaleString()})`,
    passed: mcpTokens < 35_000,
    file: SETTINGS,
    severity: 'warning',
  });
  // ── La cadena del CLAUDE.md, con sus @imports (story 7.4, 2026-09-17) ──────────────────────
  // Esta categoría sumaba skills + agentes + MCP y NO contaba el CLAUDE.md: decía «overhead < 25 %
  // de la ventana» con un piso real del 62 % de 200 mil, porque el README del arnés —235.771 bytes
  // ≈ 76 mil tokens, importado entero en cada sesión y en cada subagente— no entraba en ninguna
  // cuenta. Otra aparición de «verde que significa no miré nada», esta vez en la pieza que existe
  // para medir esto. Medición: tasks/medicion-7.4-piso-de-contexto-2026-09-17.md.
  //
  // 🔴 La cuenta se IMPORTA de context-budget.js, no se copia: el precio de las herramientas MCP ya
  // vive duplicado acá y el caso C-05 de la suite existe justamente para cazar cuando las dos copias
  // divergen. Una segunda copia del mismo criterio es una segunda cosa que se puede separar sola.
  // Si el módulo no se puede cargar, el chequeo dice que NO pudo medir — nunca un 0 que parece verde.
  let cadena = null, cadenaError = null;
  try { cadena = require('../tools/context-budget.js').inventoryClaudeMd(); }
  catch (e) { cadenaError = e.message; }
  const CADENA_MAX = 30_000;
  checks.push(cadena ? {
    // 🔴 «estimado» en el nombre a propósito: la cuenta es chars/4 y subestima ~30 % (medido:
    // 3,02–3,08 bytes/token en este contenido). El error va hacia ABAJO, así que un rojo es rojo de
    // verdad, pero el número no se puede citar como medido. El medido sale de `context-budget.js --measured`.
    name: `Cadena del CLAUDE.md con sus @imports < ${CADENA_MAX.toLocaleString('en-US')} tokens (actual: ${cadena.totalTokens.toLocaleString('en-US')} estimado — chars/4 subestima ~30 %)`,
    passed: cadena.totalTokens < CADENA_MAX,
    file: '~/.claude/CLAUDE.md',
    severity: 'warning',
    detail: { totalTokens: cadena.totalTokens, estimacion: 'chars/4 — subestima ~30 % (medido 3,02–3,08 bytes/token); el real: context-budget.js --measured', items: cadena.items.map((i) => ({ path: i.path, tokens: i.tokens, scope: i.scope, missing: !!i.missing })) },
  } : {
    name: `Cadena del CLAUDE.md con sus @imports: NO se pudo medir (${cadenaError})`,
    passed: false,
    file: '~/.claude/CLAUDE.md',
    severity: 'warning',
    detail: { error: cadenaError },
  });

  checks.push({
    name: `Skills count < 100 (actual: ${skillsCount})`,
    passed: skillsCount < 100,
    file: SKILLS_DIR,
    severity: 'info',
  });

  return { name: 'Context Efficiency', checks };
}

function checkQualityGates() {
  const checks = [];
  const s = readSettings();
  const hooks = s.hooks || {};
  const preEdit = JSON.stringify(hooks.PreToolUse || []);
  const preBash = JSON.stringify(hooks.PreToolUse || []);
  const stopHooks = JSON.stringify(hooks.Stop || []);

  checks.push({
    name: 'Hook PreToolUse Edit|Write para DoD frontmatter gate',
    passed: preEdit.includes('hook-pre-edit') || preEdit.includes('on-frontmatter-write'),
    file: SETTINGS,
    severity: 'critical',
  });
  checks.push({
    name: 'Hook PreToolUse Bash para DoD pre-commit gate',
    passed: preBash.includes('on-pre-commit'),
    file: SETTINGS,
    severity: 'critical',
  });
  checks.push({
    name: 'Hook PreToolUse Task|Agent para advisor logging (CF-2)',
    passed: preEdit.includes('on-advisor-run'),
    file: SETTINGS,
    severity: 'warning',
  });
  checks.push({
    name: 'Hook Stop para autonomous DoD gate',
    passed: stopHooks.includes('on-stop-dod-gate'),
    file: SETTINGS,
    severity: 'warning',
  });
  checks.push({
    name: 'Definition of Done guide existe',
    passed: exists(path.join(TCG_GUIDES, 'definition-of-done.md')),
    file: path.join(TCG_GUIDES, 'definition-of-done.md'),
    severity: 'critical',
  });
  return { name: 'Quality Gates', checks };
}

// ── Pinning del project name de engram (ENGRAM-PROJECT-NAME-DRIFT-1, 2026-08-25) ─────────────
// Por qué existe: engram autodetecta el project name desde el basename del cwd cuando el repo no
// lo fija. Eso fragmenta la memoria SIN dar error — `mem_search` con el nombre equivocado devuelve
// "no memories found", que es indistinguible de "este repo todavía no tiene historia". Medido el
// 2026-08-24 en dos repos el mismo día: el repo del framework (74 obs en 6 nombres, disparado por un
// rename de carpeta) y el arnés (135 obs en 7 nombres, porque la guía mandaba `tycon` y
// `.engram-project` declaraba el nombre del repo como proyecto; 11 de esas obs NUNCA se exportaron a un chunk,
// o sea que existían en UNA sola máquina).
//
// Dos checks, a propósito: el pin PREVIENE (barato, sin tocar la DB) y el conteo por directorio
// DETECTA lo que ya se fragmentó. El segundo es fail-open total: si no hay sqlite3 o no está la DB,
// no inventa un rojo.
function pinDe(dir) {
  let name = '';
  try {
    const cfg = JSON.parse(safeRead(path.join(dir, '.engram', 'config.json')));
    if (cfg && typeof cfg.project_name === 'string') name = cfg.project_name.trim();
  } catch {}
  if (!name) name = safeRead(path.join(dir, '.engram-project')).trim();
  return name || null;
}

// 🔴 Recorre DOS niveles, no uno (corregido 2026-08-25). La primera versión miraba sólo los hijos
// directos de la raíz de repos y por eso era ciega justo donde estaban los casos: Ceibo, Totora,
// Pacara, FRESNO y URUTAU son CONTENEDORES —la carpeta de arriba no es un repo git— y sus repos de
// verdad viven un nivel más abajo. Con un solo nivel se perdían 4 repos sin pin y 2 que declaran
// el nombre desde hace meses sin haber exportado jamás. Un detector que no mira donde pasan las
// cosas es un detector que no detecta.
//
// Distingue TRES estados, no dos: con pin y exportando · con pin pero SIN un solo chunk (declaró y
// nunca sincronizó — el pin engaña, el repo parece cubierto) · sin pin.
function scanEngramRepos(rootOverride) {
  const varias = enCadaRaiz(rootOverride, scanEngramRepos, (xs) => ({
    pinned: [].concat(...xs.map((x) => x.pinned)), unpinned: [].concat(...xs.map((x) => x.unpinned)),
    nuncaSincronizo: [].concat(...xs.map((x) => x.nuncaSincronizo)),
    error: xs.map((x) => x.error).filter(Boolean).join(' · ') || null, root: REPOS_ROOT, roots: REPOS_ROOTS,
  }));
  if (varias) return varias;
  const root = rootOverride || REPOS_ROOT;
  // 🔴 `error` distingue "miré y no hay nada" de "no pude mirar" (2026-08-25, revisión
  // adversarial). Antes una raíz inexistente o ilegible devolvía las MISMAS listas vacías que una
  // raíz sana sin repos — y cero repos se lee igual que "está todo bien". El consumidor tiene que
  // poder notar la diferencia; el hook la convierte en un aviso.
  const out = { pinned: [], unpinned: [], nuncaSincronizo: [], error: null, root };
  if (!root) { out.error = 'sin raíz de repos (TYCON_REPOS_ROOT, o rutas.repos en ~/.claude/tycon.json): no medido'; return out; }
  if (!exists(root)) {
    out.error = `la raíz de repos no existe: ${root}`;
    return out;
  }

  const mirar = (dir, etiqueta) => {
    if (!exists(path.join(dir, '.engram'))) return;
    const name = pinDe(dir);
    if (!name) { out.unpinned.push({ repo: etiqueta, project: null, dir }); return; }
    const chunks = path.join(dir, '.engram', 'chunks');
    let n = 0;
    try { n = exists(chunks) ? fs.readdirSync(chunks).filter((f) => f.endsWith('.jsonl.gz')).length : 0; } catch {}
    const fila = { repo: etiqueta, project: name, dir };
    out.pinned.push(fila);
    // Sólo cuenta como "nunca sincronizó" si además es un repo git: una carpeta contenedora sin
    // .git no tiene por qué llevar chunks — los suyos viven en los sub-repos.
    if (n === 0 && exists(path.join(dir, '.git'))) out.nuncaSincronizo.push(fila);
  };

  // 🔴 El recorrido baja hasta 4 niveles (story 1.6, 2026-09-17). Antes miraba 2, y por eso el
  // clon de DevB —`Proyectos/FRESNO/Codigo/FRESNOProyecto`, tres niveles— no aparecía NUNCA en el
  // aviso diario: sus 18 recuerdos llevaban tres semanas invisibles y el chequeo lo daba por sano.
  //
  // La regla de corte tiene una asimetría deliberada, medida el 2026-09-17 sobre la raíz de repos del autor:
  // **los niveles 1 y 2 se recorren siempre**, aunque la carpeta madre sea ella misma un repo. Si
  // se cortara ahí, se perderían 14 repos que hoy se ven (Ceibo ×4, Pacara ×3, Totora ×3,
  // Ebano ×3, aula-demo/web): sus contenedores tienen `.engram/` propio y sus repos adentro
  // también. Recién para bajar al 3º y al 4º se corta al entrar en algo que ya es un repo, que es
  // donde aparecen `vendor/` y compañía. Así el conjunto nuevo CONTIENE al viejo por construcción.
  const EXCLUIDAS = new Set(['node_modules', 'bin', 'obj']);
  const HONDO = 4;
  const esRepo = (dir) => exists(path.join(dir, '.engram')) || exists(path.join(dir, '.engram-project')) || exists(path.join(dir, '.git'));

  const bajar = (dir, etiqueta, nivel) => {
    if (nivel > HONDO) return;
    let subs = [];
    try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const sub of subs) {
      if (!sub.isDirectory() || sub.name.startsWith('.') || EXCLUIDAS.has(sub.name)) continue;
      const hijo = path.join(dir, sub.name);
      const etiquetaHijo = `${etiqueta}/${sub.name}`;
      mirar(hijo, etiquetaHijo);
      // A partir del nivel 2, no se entra adentro de algo que ya es un repo.
      if (nivel >= 2 && esRepo(hijo)) continue;
      bajar(hijo, etiquetaHijo, nivel + 1);
    }
  };

  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (e) { out.error = `no se pudo leer la raíz de repos (${root}): ${e.message}`; return out; }
  for (const e of entries) {
    if (!e.isDirectory() || EXCLUIDAS.has(e.name)) continue;
    const dir = path.join(root, e.name);
    mirar(dir, e.name);
    bajar(dir, e.name, 2);
  }
  return out;
}

// ── Por qué NO hay un chequeo de "pin que apunta al project equivocado" (evaluado y DESCARTADO
// 2026-08-25) ─────────────────────────────────────────────────────────────────────────────────
// La idea era comparar el pin declarado contra el project que las sesiones de ese directorio usan
// de verdad. Se implementó y se midió: **5 hallazgos, 4 falsos**. `Pacara/BackEnd` declara
// `NimboBackEnd` y sus sesiones dicen `backend`; `Totora/FrontEnd` declara `totora` y sus
// sesiones dicen `frontend`. En los dos casos el pin está BIEN y lo que "usan de verdad" es la
// autodetección por basename — o sea que el chequeo acusaba justo a los repos bien configurados.
//
// El caso que motivó la idea (`Ceibo/Ceibo` declarando `Yatay`
// — guides/maintaining/incident-log.md#case-engram-pin-differs-from-basename-2026-08-25) es estructuralmente
// idéntico a esos falsos positivos —pin ≠ basename— y además NO está claro que esté mal: es el
// repo archivo del producto bajo su nombre anterior, 1 commit en 90 días, con memorias de esa era.
// Sin una señal que separe "archivo legítimo" de "pin equivocado", el chequeo sería ruido. Un
// control que acusa a los repos correctos se apaga, y se lleva puestos los casos donde sí
// importaba. Si aparece esa señal, el lugar es acá.

// Directorios que aparecen en la tabla `sessions` de engram con MÁS DE UN project name.
// Mismo directorio + dos nombres = memoria partida, garantizado. Devuelve null si no se pudo mirar
// (sin sqlite3, sin DB, query rota) — null significa "no sé", nunca "está limpio".
const CROSS_CUTTING_PROJECTS = new Set(['tycon', 'tycon-claude-guides', 'agent-skills', 'tycon-global']);

function engramDirsWithMultipleProjects(dbOverride, scopeOverride) {
  const varias = enCadaRaiz(scopeOverride, (r) => engramDirsWithMultipleProjects(dbOverride, r), (xs) => juntarListas(xs) || 'nulo');
  if (varias) return varias === 'nulo' ? null : varias;
  const db = dbOverride || path.join(HOME, '.engram', 'engram.db');
  if (!scopeOverride && !REPOS_ROOT) return null;   // sin raíz no se puede mirar: null = «no sé» (story 8.3)
  const scope = (scopeOverride || REPOS_ROOT) + path.sep;
  if (!exists(db)) return null;
  try {
    // 🔴 Se agrupa en JS y NO en SQL a propósito: engram 1.20 guarda los project names
    // lowercaseados y filtra case-insensitive, así que `FRESNO` y `fresno` son EL MISMO cajón. Un
    // COUNT(DISTINCT project) crudo los cuenta como dos y el check grita por 17 repos de los
    // cuales ~10 no tienen nada roto. Un control que cría lobos se termina ignorando, y se lleva
    // puestos los casos donde sí importaba — así que la normalización es parte del control, no un
    // detalle cosmético. Medido: 17 → 6 al normalizar.
    // 🔴 Sólo cuentan los nombres que TODAVÍA tienen observaciones vivas. Tras consolidar, las
    // filas viejas de `sessions` conservan su etiqueta original aunque las observaciones ya se
    // hayan mudado — sin este filtro el chequeo seguiría en rojo para siempre sobre memoria que
    // ya está unificada, y un rojo permanente se aprende a ignorar. Medido: 4 falsos positivos
    // (dos de un producto, el de formularios y el del framework) apenas terminó la
    // consolidación del 2026-08-25.
    const q = "SELECT s.directory || ' :: ' || s.project FROM sessions s "
            + "WHERE s.directory IS NOT NULL AND s.directory <> '' AND s.project IS NOT NULL AND s.project <> '' "
            + "AND EXISTS (SELECT 1 FROM observations o WHERE o.project = s.project AND o.deleted_at IS NULL);";
    const raw = consultar(db, q, 10000);
    const porDir = new Map();
    for (const line of raw.split('\n')) {
      const i = line.indexOf(' :: ');
      if (i < 0) continue;
      const dir = line.slice(0, i).trim();
      const proj = line.slice(i + 4).trim();
      if (!dir || !proj) continue;
      // Sólo repos: una sesión suelta desde ~ o Downloads no es un repo que haya que arreglar.
      if (!dir.startsWith(scope)) continue;
      // 🔴 Proyectos TRANSVERSALES: guardar bajo `tycon` desde el cwd de cualquier producto es la
      // convención del equipo, no drift (engram-workflow.md §2: "si el cambio le sirve al equipo en
      // cualquier proyecto, es `tycon`"). Sin esta exclusión el check acusa de memoria partida a
      // todo repo donde alguien tocó el arnés — o sea, a los repos donde MÁS se trabajó. Un control
      // que castiga el comportamiento correcto no sobrevive a la segunda corrida.
      if (CROSS_CUTTING_PROJECTS.has(proj.toLowerCase())) continue;
      if (!porDir.has(dir)) porDir.set(dir, new Map());
      // key normalizada (lo que engram realmente distingue) → primer forma vista, para mostrarla.
      const m = porDir.get(dir);
      if (!m.has(proj.toLowerCase())) m.set(proj.toLowerCase(), proj);
    }
    return [...porDir.entries()]
      .filter(([, m]) => m.size > 1)
      .map(([dir, m]) => ({ dir, count: m.size, names: [...m.values()] }))
      .sort((a, b) => b.count - a.count);
  } catch { return null; }
}

// Observaciones que existen en la DB local pero NO están en ningún chunk de `.engram/chunks/` del
// repo — o sea: memoria que vive en UNA sola máquina y no llegó a nadie más. Es la falla más cara
// de las tres, porque no se recupera: si se pierde el disco, se perdió. Medido el 2026-08-25:
// 11 obs varadas en el arnés y 91 en un repo del equipo, ambas invisibles hasta que alguien
// las buscó a mano. Devuelve null si no se pudo mirar (sin sqlite3 / sin DB): "no sé" no es "está limpio".
function engramUnexportedByRepo(rootOverride, dbOverride) {
  const varias = enCadaRaiz(rootOverride, (r) => engramUnexportedByRepo(r, dbOverride), (xs) => juntarListas(xs) || 'nulo');
  if (varias) return varias === 'nulo' ? null : varias;
  const db = dbOverride || path.join(HOME, '.engram', 'engram.db');
  if (!exists(db)) return null;
  const root = rootOverride || REPOS_ROOT;
  if (!root) return null;   // sin raíz: «no sé» (story 8.3)
  const { pinned } = scanEngramRepos(rootOverride);
  if (!pinned.length) return [];

  // 🔴 Se agrupa POR PROJECT, no por repo (corregido 2026-08-25, apenas el escaneo pasó a dos
  // niveles). Varios repos comparten un mismo cajón a propósito — los 3 de Ceibo sincronizan
  // `ceibo`, los 5 de Totora sincronizan `totora` — así que una observación viaja si está en
  // los chunks de CUALQUIERA de ellos. Mirando repo por repo, la primera versión reportó 2442
  // observaciones "varadas" que sí habían viajado, sólo que por el `.engram/` de un hermano.
  const porProject = new Map();
  for (const r of pinned) {
    const k = String(r.project).toLowerCase();
    if (!porProject.has(k)) porProject.set(k, { project: r.project, repos: [] });
    porProject.get(k).repos.push(r.repo);
  }

  const zlib = require('zlib');
  const out = [];
  for (const [, grupo] of porProject) {
    let vivos;
    try {
      const q = 'SELECT sync_id FROM observations WHERE deleted_at IS NULL AND sync_id IS NOT NULL '
              + `AND lower(project) = lower('${String(grupo.project).replace(/'/g, "''")}');`;
      const raw = consultar(db, q, 15000);
      vivos = new Set(raw.split('\n').map((x) => x.trim()).filter(Boolean));
    } catch { return null; }   // DB ilegible → "no sé" para TODO, nunca un verde parcial
    if (!vivos.size) continue;

    const exportados = new Set();
    for (const repo of grupo.repos) {
      const d = path.join(root, repo, '.engram', 'chunks');
      if (!exists(d)) continue;
      let archivos = [];
      try { archivos = fs.readdirSync(d); } catch { continue; }
      for (const f of archivos) {
        if (!f.endsWith('.jsonl.gz')) continue;
        let txt;
        try { txt = zlib.gunzipSync(fs.readFileSync(path.join(d, f))).toString('utf8'); } catch { continue; }
        for (const linea of txt.split('\n')) {
          if (!linea.trim()) continue;
          let o; try { o = JSON.parse(linea); } catch { continue; }
          for (const x of (o.observations || [])) if (x && x.sync_id) exportados.add(x.sync_id);
        }
      }
    }

    const varadas = [...vivos].filter((id) => !exportados.has(id)).length;
    if (varadas) out.push({ repo: grupo.repos[0], repos: grupo.repos, project: grupo.project, varadas, total: vivos.size });
  }
  return out.sort((a, b) => b.varadas - a.varadas);
}

// Chunks que están en disco pero NO en el índice (`manifest.json`) — y al revés. El índice NO es
// decorativo: `engram sync --import` lo usa para saber qué levantar, así que un chunk commiteado
// pero sin entrada es memoria que viajó por git y que NADIE puede leer. Verificado el 2026-08-25 en
// FRESNO/FRESNOBZExtBackend: el chunk `14b4f99a` (8 observaciones reales de otro dev sobre bugs de
// conciliación) estaba en `main` desde el 24/08 y sus observaciones NO estaban en la DB local ni
// figuraban en `sync_chunks` — invisibles para todo el equipo.
//
// 🔴 Por qué hace falta este chequeo aparte: el caso NO lo agarra ninguno de los otros tres. No es
// falta de pin (el repo lo tiene), no es memoria partida en dos nombres, y no es "sin exportar" —
// el chunk SÍ se exportó y SÍ se commiteó. El agujero está entre el archivo y el índice, y se abrió
// en un commit normal, sin conflicto de por medio (que es el único caso que ENGRAM-MANIFEST-1
// cubría). Un archivo presente que el índice no nombra se lee, desde afuera, exactamente igual que
// un archivo que no existe.
// 🔴 El cruce NO se decide acá (story 1.6, 2026-09-17): lo decide `scripts/lib/manifest-engram.js`,
// que es el mismo criterio que usan el hook del commit y el portón de CI. Antes vivía escrito tres
// veces; la copia que quedara vieja mentiría en silencio, que es justo el modo de falla que esta
// familia de controles persigue. Es la regla que ya estaba escrita en la cabecera de
// `engram-drift-notice.js`: reusar los chequeos, no reimplementarlos.
//
// La FORMA de salida no cambia —`{repo, sinIndexar, fantasma}` más los bordes `sinManifest`,
// `manifestIlegible` y `error`— porque la consumen el chequeo 3 del aviso diario y el scorecard.
// El criterio se carga tarde (sólo si hay algún repo que cruzar) para que los casos del banco que
// no tienen repos con nombre fijado sigan sin necesitar el archivo en su fixture.
function engramChunksSinIndexar(rootOverride) {
  const varias = enCadaRaiz(rootOverride, engramChunksSinIndexar, (xs) => [].concat(...xs));
  if (varias) return varias;
  const root = rootOverride || REPOS_ROOT;
  if (!root) return [{ repo: '(sin raíz)', sinIndexar: [], fantasma: [], error: 'sin raíz de repos: no medido (TYCON_REPOS_ROOT, o rutas.repos en ~/.claude/tycon.json)' }];
  const { pinned } = scanEngramRepos(rootOverride);
  const out = [];
  let criterio = null;
  for (const { repo, dir: suDir } of pinned) {
    const dir = suDir || path.join(root, repo);
    const base = path.join(dir, '.engram');
    if (!exists(path.join(base, 'chunks')) && !exists(path.join(base, 'manifest.json'))) continue; // repo sin memoria
    // Si el criterio no está, se DICE y se corta: devolver la lista a medias (o vacía) se leería
    // como «miré y está todo bien», que es exactamente la mentira que no se puede publicar.
    if (!criterio) criterio = require('./manifest-engram.js');
    // Sin referencia de git: el aviso diario mira el estado del checkout, no lo que rompió un commit.
    const r = criterio.cruzar(dir, { contra: null });
    if (r.estado === 'no-medido') {
      // Los dos bordes que antes salían por `continue` y se leían como «este repo está sano»
      // (2026-08-25, revisión adversarial): chunks SIN índice —o sea que NINGUNO es importable, el
      // peor caso y el que menos ruido hacía— e índice SIN carpeta de chunks.
      if (r.codigo === 'sin-manifest') {
        // Sin índice, NINGUNO de sus archivos es importable: se nombran todos (es el peor caso y
        // el que menos ruido hacía antes de 2026-08-25).
        if (r.archivos) out.push({ repo, dir, sinManifest: true, sinIndexar: r.archivosIds || [], fantasma: [] });
        continue;
      }
      // Índice que declara entradas y carpeta de archivos que no está: TODAS sus entradas apuntan
      // a la nada. Se reporta como fantasmas —la forma de siempre— y no como «no pude medir»: acá
      // sí se sabe qué falta, y nombrarlo es lo único que permite arreglarlo.
      if (r.codigo === 'sin-carpeta-chunks') { out.push({ repo, dir, sinIndexar: [], fantasma: r.declaradosIds || [] }); continue; }
      if (r.codigo === 'chunks-ilegibles' || r.codigo === 'ilegible') { out.push({ repo, dir, error: r.motivo, sinIndexar: [], fantasma: [] }); continue; }
      // Un índice que no parsea es su propio problema (ENGRAM-MANIFEST-1 lo cubre en el commit);
      // acá se declara y se sigue, sin inventar que hay huérfanos.
      out.push({ repo, dir, manifestIlegible: true, sinIndexar: [], fantasma: [] });
      continue;
    }
    if (r.huerfanos.length || r.fantasmas.length) out.push({ repo, dir, sinIndexar: r.huerfanos, fantasma: r.fantasmas });
  }
  return out;
}

function checkMemoryPersistence() {
  const checks = [];
  // engram (story 8.3, AC 9/10): con la integración apagada los chequeos de memoria NO se miden y se dice — nunca «0
  // repos» en verde. Configuración rota → NO MEDIDO con el motivo (una auditoría informa, no frena). Sin lector: como hoy.
  try {
    const cfg = require(path.join(__dirname, 'tycon-config.js'));
    // configuración rota: no llega acá — el módulo ya frenó al cargar (REPOS_ROOT), como todo comando (AC 2)
    const e = cfg.integracionParaHook('engram');
    if (!e.prendida) {
      return { name: 'Memory Persistence', checks: [{ name: `Memoria persistente (engram): NO MEDIDO — ${e.apagada}`, passed: true, file: '~/.claude/tycon.json', severity: 'info', detail: { checked: false } }] };
    }
  } catch (e) {
    // sin la lib al lado: como hoy. Otro error del lector es un hallazgo, no silencio.
    if (!(e && e.code === 'MODULE_NOT_FOUND')) checks.push({ name: `Memoria persistente (engram): el lector de configuración falló (${e && e.message})`, passed: false, file: 'scripts/lib/tycon-config.js', severity: 'warning' });
  }
  const s = readSettings();
  const servers = s.mcpServers || {};
  const ep = s.enabledPlugins || {};

  checks.push({
    name: 'Engram MCP configurado',
    passed: 'engram' in servers || Object.keys(ep).some(k => k.includes('engram')),
    file: SETTINGS,
    severity: 'critical',
  });
  checks.push({
    name: 'Engram workflow guide existe',
    passed: exists(path.join(TCG_GUIDES, 'integrations', 'engram-workflow.md')),
    file: path.join(TCG_GUIDES, 'integrations', 'engram-workflow.md'),
    severity: 'warning',
  });

  // Recencia de observations: chequear si hay archivos modificados recientes en
  // ~/.claude/projects/-Users-*/memory/ (heurística — proxy de "estás usando engram")
  let recentMemory = false;
  try {
    const projDir = path.join(HOME, '.claude/projects');
    if (exists(projDir)) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const projects = fs.readdirSync(projDir);
      for (const p of projects) {
        const memoryDir = path.join(projDir, p, 'memory');
        if (!exists(memoryDir)) continue;
        const files = fs.readdirSync(memoryDir);
        for (const f of files) {
          const stat = fs.statSync(path.join(memoryDir, f));
          if (stat.mtimeMs > cutoff) { recentMemory = true; break; }
        }
        if (recentMemory) break;
      }
    }
  } catch {}
  checks.push({
    name: 'Memory activity en los últimos 7 días (proxy: archivo en ~/.claude/projects/*/memory/)',
    passed: recentMemory,
    file: '~/.claude/projects/',
    severity: 'info',
  });

  // ENGRAM-PROJECT-NAME-DRIFT-1 — el pin previene, el conteo detecta.
  const eng = scanEngramRepos();
  if (eng.error) {
    // 🔴 «No pude mirar» no es «está todo bien» (story 8.3, AC 6): sin raíz de repos (o raíz ilegible) los dos
    // chequeos de abajo salían VERDES con «0 repos». Cero repos se lee igual que «todo cubierto» — la frase que
    // este archivo repite en sus comentarios y que acá no se cumplía (cazador de fallos silenciosos, vuelta 1).
    checks.push({
      name: `Memoria de los repos (pin y chunks exportados): NO MEDIDO — ${eng.error}`,
      passed: true,
      file: '<raíz de repos>/*/.engram/',
      severity: 'info',
      detail: { checked: false, error: eng.error },
    });
  } else {
  checks.push({
    name: eng.nuncaSincronizo.length
      ? `Repos que DECLARAN su project name y nunca exportaron un solo chunk: ${eng.nuncaSincronizo.length} (${eng.nuncaSincronizo.map(r => r.repo).join(', ')}) — el pin engaña: parecen cubiertos y su memoria no viaja`
      : 'Todo repo con pin exportó al menos un chunk',
    passed: eng.nuncaSincronizo.length === 0,
    file: '<repo>/.engram/chunks/',
    severity: 'warning',
    detail: eng.nuncaSincronizo,
  });
  checks.push({
    name: eng.unpinned.length
      ? `Repos con .engram/ SIN project name fijado: ${eng.unpinned.length} (${eng.unpinned.map(r => r.repo).join(', ')}) — fijalo en <repo>/.engram/config.json`
      : `Todo repo con .engram/ fija su project name (${eng.pinned.length} repos)`,
    passed: eng.unpinned.length === 0,
    file: '<raíz de repos>/*/.engram/config.json',
    severity: 'warning',
    detail: { pinned: eng.pinned, unpinned: eng.unpinned.map(r => r.repo) },
  });
  }

  const drift = engramDirsWithMultipleProjects();
  if (drift === null) {
    // No se pudo mirar la DB. Se declara como info y NO como verde — "no sé" no es "está limpio".
    checks.push({
      name: 'Drift de project name por directorio: no verificable (falta sqlite3 o ~/.engram/engram.db)',
      passed: true,
      file: '~/.engram/engram.db',
      severity: 'info',
      detail: { checked: false },
    });
  } else {
    checks.push({
      name: drift.length
        ? `Directorios con MÁS de un project name en engram: ${drift.length} — memoria partida (${drift.map(d => path.basename(d.dir)).join(', ')})`
        : 'Ningún directorio usa más de un project name en engram',
      passed: drift.length === 0,
      file: '~/.engram/engram.db',
      severity: 'warning',
      detail: drift.slice(0, 10),
    });
  }

  const desindexados = engramChunksSinIndexar();
  const totSin = desindexados.reduce((a, r) => a + (r.sinIndexar || []).length, 0);
  const totFant = desindexados.reduce((a, r) => a + (r.fantasma || []).length, 0);
  checks.push({
    name: desindexados.length
      ? `Chunks de memoria fuera del índice: ${totSin} en disco sin entrada${totFant ? ` y ${totFant} en el índice sin archivo` : ''} (${desindexados.map(r => r.repo).join(', ')}) — commiteados pero ILEGIBLES para el equipo`
      : 'Todo chunk en disco está en el índice de su repo',
    passed: desindexados.length === 0,
    file: '<repo>/.engram/manifest.json',
    severity: 'warning',
    detail: desindexados,
  });

  const varadas = engramUnexportedByRepo();
  if (varadas === null) {
    checks.push({
      name: 'Memoria sin exportar: no verificable (falta sqlite3 o ~/.engram/engram.db)',
      passed: true, file: '~/.engram/engram.db', severity: 'info', detail: { checked: false },
    });
  } else {
    const tot = varadas.reduce((a, r) => a + r.varadas, 0);
    checks.push({
      name: varadas.length
        ? `Memoria que NUNCA salió de esta máquina: ${tot} obs en ${varadas.length} repo(s) (${varadas.map(r => r.repo + ':' + r.varadas).join(', ')}) — corré \`engram sync --project <nombre>\` y commiteá .engram/`
        : 'Toda la memoria de los repos con pin está exportada a .engram/chunks',
      passed: varadas.length === 0,
      file: '<repo>/.engram/chunks/',
      severity: 'warning',
      detail: varadas,
    });
  }

  return { name: 'Memory Persistence', checks };
}

function checkCatalogIntegrity() {
  const checks = [];
  try {
    const out = execSync(`node ${path.join(TCG_SCRIPTS, 'tools', 'rules-distill.js')} --json`, { encoding: 'utf8' });
    const data = JSON.parse(out);
    checks.push({
      name: 'Catalog: 0 BROKEN-REFS',
      passed: data.brokenRefs.length === 0,
      file: CATALOG,
      severity: 'critical',
      detail: { count: data.brokenRefs.length },
    });
    checks.push({
      name: 'Catalog: 0 ORPHANS (regla enforced sin documentar)',
      passed: data.orphans.length === 0,
      file: CATALOG,
      severity: 'critical',
      detail: { count: data.orphans.length },
    });
    checks.push({
      name: 'Catalog: ≤ 5 ZOMBIES (regla doc sin advisor que la cite)',
      passed: data.zombies.length <= 5,
      file: CATALOG,
      severity: 'warning',
      detail: { count: data.zombies.length },
    });
    checks.push({
      name: 'Catalog: 0 OWNER-MISMATCH',
      passed: data.ownerMismatch.length === 0,
      file: CATALOG,
      severity: 'critical',
      detail: { count: data.ownerMismatch.length },
    });
    checks.push({
      name: 'Catalog tiene ≥ 200 rule IDs activos',
      passed: data.summary.catalogIdsCount >= 200,
      file: CATALOG,
      severity: 'info',
      detail: { count: data.summary.catalogIdsCount },
    });
  } catch (e) {
    checks.push({
      name: 'rules-distill.js corre OK',
      passed: false,
      file: path.join(TCG_SCRIPTS, 'tools', 'rules-distill.js'),
      severity: 'critical',
      detail: { error: e.message },
    });
  }
  return { name: 'Catalog Integrity', checks };
}

function checkSecurityGuardrails() {
  const checks = [];
  const s = readSettings();
  const hooks = JSON.stringify(s.hooks || {});

  checks.push({
    name: 'safety-guard hook activo (PreToolUse Bash con safety-guard-pre.sh)',
    passed: hooks.includes('safety-guard-pre.sh'),
    file: SETTINGS,
    severity: 'warning',
  });
  checks.push({
    name: 'safety-guard guide existe',
    passed: exists(path.join(TCG_GUIDES, 'safety-guard.md')),
    file: path.join(TCG_GUIDES, 'safety-guard.md'),
    severity: 'warning',
  });
  // las guías de cada paquete instalado (la de hooks de .NET, anti-mutación de migraciones, vive en el paquete bizuit)
  for (const paq of require('./installed-packs.js').leerPaquetes().paquetes) {
    for (const g of paq.guias) {
      checks.push({
        name: `guía ${g} del paquete ${paq.nombre} existe`,
        passed: exists(path.join(TCG_ROOT, g)),
        file: path.join(TCG_ROOT, g),
        severity: 'warning',
      });
    }
  }
  checks.push({
    name: 'signed-scope-guardrails guide existe',
    passed: exists(path.join(TCG_GUIDES, 'signed-scope-guardrails.md')),
    file: path.join(TCG_GUIDES, 'signed-scope-guardrails.md'),
    severity: 'warning',
  });
  checks.push({
    name: 'git-commit-conventions guide existe (anti --no-verify)',
    passed: exists(path.join(TCG_GUIDES, 'git-commit-conventions.md')),
    file: path.join(TCG_GUIDES, 'git-commit-conventions.md'),
    severity: 'critical',
  });
  return { name: 'Security Guardrails', checks };
}

function checkPipelineWiring() {
  const checks = [];
  const pipelineSkillPath = path.join(SKILLS_DIR, 'tycon-pipeline/SKILL.md');
  const stepFile = path.join(SKILLS_DIR, 'tycon-pipeline/steps/step-05-advisors-parallel.md');
  const pipelineJs = path.join(SKILLS_DIR, 'tycon-pipeline/scripts/pipeline.js');

  checks.push({
    name: 'tycon-pipeline SKILL.md existe',
    passed: exists(pipelineSkillPath),
    file: pipelineSkillPath,
    severity: 'critical',
  });
  checks.push({
    name: 'step-05-advisors-parallel.md existe',
    passed: exists(stepFile),
    file: stepFile,
    severity: 'critical',
  });
  checks.push({
    name: 'pipeline.js existe',
    passed: exists(pipelineJs),
    file: pipelineJs,
    severity: 'critical',
  });

  // Coherencia: desde que el set de advisors se computa mecánicamente
  // (`pipeline.js mech-check` / `advisors`), pipeline.js ES la fuente de verdad
  // del wiring — SKILL.md/step-05 solo narran ejemplos y no tienen por qué
  // nombrar cada advisor (actualización 2026-08-13; antes el check exigía los 3
  // archivos y daba falsos rojos). El guard anti-drop es test-pipeline-coverage.js:
  // un advisor cableado debe estar en pipeline.js Y en el expected-set del test.
  const coverageTest = path.join(SKILLS_DIR, 'tycon-pipeline/scripts/tests/test-pipeline-coverage.js');
  // (del núcleo: los de un stack viven en su paquete y no se nombran en pipeline.js, story 8.41)
  const probe = ['tycon-e2e-realness-checker', 'tycon-silent-failure-hunter', 'llm-cost-reviewer'];
  for (const a of probe) {
    const inJs = exists(pipelineJs) && safeRead(pipelineJs).includes(a);
    const inCoverageTest = exists(coverageTest) && safeRead(coverageTest).includes(a);
    checks.push({
      name: `Advisor "${a}" cableado en pipeline.js + guardado por test-pipeline-coverage.js`,
      passed: inJs && inCoverageTest,
      file: '(varios)',
      severity: 'warning',
      detail: { inJs, inCoverageTest },
    });
  }
  return { name: 'Pipeline Wiring', checks };
}

// ============================================================
// Categoría 8 — Learning Loop (auditoría 2026-06-09: "nadie vigila al
// vigilante"). El escenario que esta categoría detecta YA OCURRIÓ sin que
// nada lo viera: instinct-mining 17 días registrado-pero-apagado (0
// observations) y retrospective-capturer sin trigger (1 corrida en 37 días).
// Checks condicionados al estado DECLARADO de cada feature: si un feature
// está apagado a propósito (Camino B), su check se reporta como passed con
// detail 'feature off' — un rojo perpetuo entrenaría a ignorar la categoría.
// ============================================================

function checkLearningLoop() {
  const checks = [];
  const settingsRaw = safeRead(SETTINGS);
  const DAY = 24 * 3600 * 1000;

  // (a) Si el hook instinct-observe está registrado, la env var debe estar prendida.
  const miningRegistered = settingsRaw.includes('instinct-observe.sh');
  const miningOn = process.env.TYCON_INSTINCT_MINING === '1';
  checks.push({
    name: 'instinct-mining: hook registrado ⇒ env var TYCON_INSTINCT_MINING=1 (no feature-dead)',
    passed: !miningRegistered || miningOn,
    file: SETTINGS,
    severity: 'warning',
    detail: { miningRegistered, miningOn },
  });

  // (b) Si mining está prendido, debe haber observations recientes (<14d).
  if (miningRegistered && miningOn) {
    const obsDir = path.join(HOME, '.claude/tycon-observations');
    let fresh = false;
    try {
      fresh = fs.readdirSync(obsDir).some((f) => {
        try { return Date.now() - fs.statSync(path.join(obsDir, f)).mtimeMs < 14 * DAY; } catch { return false; }
      });
    } catch { /* dir ausente */ }
    checks.push({
      name: 'instinct-mining: observations con actividad <14 días',
      passed: fresh,
      file: obsDir,
      severity: 'warning',
    });
  }

  // (c) retrospective-capturer: su doc no debe declarar ACTIVO si no hay
  // rastro de corridas recientes (la mentira "Status: ACTIVO" con 1 corrida
  // en 37 días es el caso disparador).
  const capturerDoc = safeRead(path.join(AGENTS_DIR, 'tycon-retrospective-capturer.md'));
  const declaresActive = /Status:\s*ACTIVO/i.test(capturerDoc);
  let capturerEvidence = false;
  try {
    // Trigger wireado en merge-to-main O métricas recientes en algún .dashboard/.
    capturerEvidence = safeRead(path.join(SKILLS_DIR, 'tycon-merge-to-main/SKILL.md')).includes('retrospective-capturer');
  } catch { /* ignore */ }
  checks.push({
    name: 'retrospective-capturer: doc coherente (si declara ACTIVO, tiene trigger real en merge-to-main)',
    passed: !declaresActive || capturerEvidence,
    file: path.join(AGENTS_DIR, 'tycon-retrospective-capturer.md'),
    severity: 'warning',
    detail: { declaresActive, triggerWired: capturerEvidence },
  });

  // (d) gates.log con actividad reciente cuando hubo pipelines (proxy de que
  // run-check / ground-truth se está usando — no bloqueante, info).
  const gatesLog = path.join(stateDirOf(HOME), 'gates.log');
  let gatesFresh = false;
  try { gatesFresh = Date.now() - fs.statSync(gatesLog).mtimeMs < 30 * DAY; } catch { /* nunca corrió */ }
  checks.push({
    name: 'gates.log con actividad <30 días (run-check en uso)',
    passed: gatesFresh,
    file: gatesLog,
    severity: 'info',
  });

  return { name: 'Learning Loop', checks };
}

// ============================================================
// Main audit
// ============================================================

function audit() {
  const categories = [
    checkAdvisorCoverage(),
    checkContextEfficiency(),
    checkQualityGates(),
    checkMemoryPersistence(),
    checkCatalogIntegrity(),
    checkSecurityGuardrails(),
    checkPipelineWiring(),
    checkLearningLoop(),
  ];

  for (const c of categories) {
    const total = c.checks.length;
    const passed = c.checks.filter(x => x.passed).length;
    c.score = total === 0 ? 0 : Math.round((passed / total) * 10);
    c.passed = passed;
    c.total = total;
  }

  const overall = categories.reduce((a, c) => a + c.score, 0);
  const maxOverall = categories.length * 10;

  // Top 3 acciones: failed checks ordenados por severity (critical > warning > info)
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  const failed = categories.flatMap(c =>
    c.checks.filter(x => !x.passed).map(x => ({ ...x, category: c.name }))
  ).sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    rubricVersion: '2026-06-09 (+Learning Loop)',
    overall,
    maxOverall,
    categories,
    topActions: failed.slice(0, 5),
  };
}

// ============================================================
// Render
// ============================================================

function render(result) {
  const lines = [];
  const pct = Math.round((result.overall / result.maxOverall) * 100);

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('   TYCON Harness Audit Scorecard');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  Score total: ${result.overall}/${result.maxOverall} (${pct}%)`);
  lines.push(`  Rubric: ${result.rubricVersion}`);
  lines.push('');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('  Score por categoría');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');
  for (const c of result.categories) {
    const bar = '█'.repeat(c.score) + '░'.repeat(10 - c.score);
    const flag = c.score >= 8 ? '✓' : c.score >= 5 ? '⚠' : '✗';
    lines.push(`  ${flag} ${c.name.padEnd(26)} ${c.score}/10  ${bar}  (${c.passed}/${c.total} checks)`);
  }
  lines.push('');

  if (VERBOSE) {
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('  Detalle por check');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('');
    for (const c of result.categories) {
      lines.push(`  ${c.name}:`);
      for (const ch of c.checks) {
        const mark = ch.passed ? '✓' : '✗';
        lines.push(`    ${mark} [${ch.severity}] ${ch.name}`);
        if (ch.detail) lines.push(`        ${JSON.stringify(ch.detail)}`);
      }
      lines.push('');
    }
  }

  lines.push('───────────────────────────────────────────────────────────────');
  lines.push(`  Top ${Math.min(5, result.topActions.length)} acciones (failed checks por severity)`);
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');
  if (result.topActions.length === 0) {
    lines.push('  ✓ Cero failed checks. Harness en estado óptimo.');
  } else {
    result.topActions.forEach((a, i) => {
      const sevTag = a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '🟡' : '⚪';
      lines.push(`  ${i + 1}. ${sevTag} [${a.category}] ${a.name}`);
      lines.push(`     Path: ${a.file}`);
      if (a.detail) lines.push(`     Detail: ${JSON.stringify(a.detail)}`);
      lines.push('');
    });
  }

  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('  Notas');
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push('  • Score por categoría: passed_checks / total_checks * 10');
  lines.push('  • Cada categoría pesa lo mismo (no hay weighting).');
  lines.push('  • Catalog Integrity invoca rules-distill.js — debe estar funcional.');
  lines.push('  • Context Efficiency usa heurística chars/4 + 500 tok/MCP tool.');
  lines.push('  • Este scorecard mide el lado CLAUDE; la paridad de instalación Claude↔Codex es `--parity`.');
  lines.push('  • Re-correr post-cambios: node scripts/lib/harness-audit.js');
  lines.push('  • Para ver cada check individualmente: --verbose');
  lines.push('');

  return lines.join('\n');
}

// ============================================================
// Main
// ============================================================

// Los helpers de ENGRAM-PROJECT-NAME-DRIFT-1 se exportan para que su test los ejerza sin correr
// el scorecard entero (que mide la máquina real y por eso no es determinístico). El guard
// `require.main` mantiene intacto el uso como CLI.
module.exports = { scanEngramRepos, pinDe, engramDirsWithMultipleProjects, engramUnexportedByRepo, engramChunksSinIndexar, CROSS_CUTTING_PROJECTS, checkAdvisorCoverage, checkPipelineWiring };

if (require.main === module) {
  const result = audit();
  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(render(result));
  }
}
