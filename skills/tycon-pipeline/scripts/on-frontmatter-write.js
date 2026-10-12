#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse hook (matcher: Edit|Write) — DoD frontmatter gate.
 *
 * Capa 2 de defense-in-depth (caso disparador Story 4.2 Sprint 4 2026-05-20).
 * Atrapa el problema MÁS TEMPRANO que Capa 1 (`on-pre-commit.js`): cuando
 * Claude/dev hace Edit o Write de un spec Mary+GOLD y la modificación cambia
 * `status:` a `review`/`done` o pone `pipelines.X.status: done` sin que exista
 * la evidencia DoD.
 *
 * Diferencia con Capa 1:
 *   - Capa 1 atrapa en `git commit` — el dev no puede shipear sin evidencia.
 *   - Capa 2 atrapa en el Edit/Write mismo — al agente le impide siquiera
 *     escribir la mentira al filesystem. Mejor UX (feedback inmediato).
 *
 * Lógica:
 *   1. Lee el evento PreToolUse Edit|Write.
 *   2. Si el Edit/Write no es de un `.md` -> exit 0; que SEA una story lo decide
 *      el frontmatter, mas abajo (2026-08-15 — ya no se filtra por ruta).
 *   3. Si la operación es Edit → reconstruir el NEW state aplicando el patch
 *      sobre el current. Si Write → el new_string del tool_input ES el state final.
 *   4. Detectar transición de status frontmatter o líneas `status: done`/`review`
 *      en bloques `pipelines.X` que NO existían antes.
 *   5. Si la story requiere runtime evidence (markers Playwright/E2E/smoke
 *      detectados en el contenido) y NO existe `.advisors/dod-runtime/<storyId>-*.md`
 *      → BLOQUEAR (exit 2) con mensaje accionable.
 *
 * Exit codes:
 *   0 → permitir Edit/Write
 *   2 → BLOQUEAR (stderr = mensaje al agente)
 *
 * H10 2026-05-21: refactor a `handle(event)` exportable (devuelve {block} en vez
 * de process.exit(2)) para que el dispatcher lo corra in-process. El shim CLI del
 * fondo preserva el comportamiento standalone idéntico (incl. fail-open H19).
 *
 * Fail-open: errores del hook propio no bloquean operaciones válidas (pero quedan
 * logueados — H19 2026-05-21 — para que un gate caído sea visible).
 */

const fs = require('fs');
const path = require('path');
const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
const os = require('os');
const { sessionIdFileKey } = require('./lib/session-id.js');

function readEvent() {
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (!stdin) return null;
    return JSON.parse(stdin);
  } catch {
    return null;
  }
}

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split('\n');
  const out = {};
  for (const line of lines) {
    const mm = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.+)$/);
    if (!mm) continue;
    let val = mm[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[mm[1]] = val;
  }
  return out;
}

function storyRequiresRuntimeEvidence(content) {
  if (!content) return false;
  const markers = [
    'tests_done_playwright_spec',
    'tests_pending_runtime',
    'playwright',
    'Playwright',
    'E2E',
    'e2e-tests',
    'smoke runtime',
  ];
  return markers.some(m => content.includes(m));
}

function storyIsExempt(content) {
  return /^dod_runtime_exempt:\s*true\b/m.test(content);
}

// 🔴 Qué es «evidencia de cierre» lo decide UNA función compartida (2026-09-06). Este hook
// aceptaba cualquier `<id>-*.md` —matriz y self-audit incluidos— mientras el freno del commit y el
// portón de CI los excluían: una story pasaba acá y rebotaba dos capas después. Ver
// `lib/closing-evidence.js` (criterio y motivo de cada exclusión).
const { esEvidenciaDeCierre } = require('./lib/closing-evidence.js');

// El prefijo de la evidencia de una story (story 1.17): con la ruta de la story, su CLAVE
// (lib/evidence-key.js) — con un número repetido en el repo, `<id>-*` es la evidencia de cualquiera de las
// stories que lo comparten. Si la clave no se puede decidir: null = no hay evidencia (fail-closed). Sin ruta, el id.
// La regla es `evidencePrefix`, la MISMA que el portón de Azure (story 1.17.1, tanda 2): antes, con la story todavía
// fuera del disco (un Write que la crea ya en `done`), caía al número solo y aceptaba la evidencia de otra story.
function prefijoDe(storyId, storyPath) {
  const { prefix, error } = require('./lib/evidence-key.js').evidencePrefix(storyPath, storyId);
  // «No pude calcular la clave» no es «no hay evidencia»: el motivo se dice (y el bloqueo lo repite).
  if (!prefix) process.stderr.write(`⚠️ tycon-dod-runtime (frontmatter): ${error} — sin clave no doy evidencia por buena.\n`);
  return prefix;
}

function hasDodEvidence(repoRoots, storyId, storyPath) {
  const expectedPrefix = prefijoDe(storyId, storyPath);
  if (!expectedPrefix) return false;
  for (const root of repoRoots) {
    const dir = path.join(root, '.advisors', 'dod-runtime');
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      if (files.some(f => f.startsWith(expectedPrefix) && esEvidenciaDeCierre(f))) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

// Story con E2E reales (markers fuertes de test IDs Playwright en el frontmatter).
// Distinto de storyRequiresRuntimeEvidence (que matchea cualquier mención de "E2E"):
// acá buscamos IDs concretos de tests E2E declarados como cobertura.
function storyNeedsPlaywrightRun(content) {
  if (!content) return false;
  // Test IDs E2E típicos: E1, E6, FullUI-2, E2E-4.3.1, etc. en tests_done/tests del frontmatter.
  return /\b(FullUI-\d|E2E-\d|E\d+-[a-z])/.test(content) ||
         /tests_done_playwright_spec/.test(content) ||
         /tests\/e2e\//.test(content);
}

// FRESHNESS floor (auditoría 2026-06-09): pese al nombre, hasFreshPlaywrightPass
// solo chequeaba substrings — evidencia VIEJA satisfacía el gate para siempre
// (un run verde de hace 3 iteraciones "validaba" código que cambió después).
// El floor = mtime más nuevo de los archivos de CÓDIGO tocados por el pipeline
// (marker.filesTouched de la sesión). Evidencia con mtime anterior al último
// cambio de código = STALE → no satisface el gate. Sin marker → sin floor
// (comportamiento previo, no rompe edits fuera de pipeline).
/**
 * ¿Cuándo cambió DE VERDAD el código que esta sesión tocó? (el «piso de frescura»)
 *
 * 🔴 Se decide por CONTENIDO, no por fechas (tercera versión, 2026-09-06). Las dos anteriores
 * fallaban en direcciones opuestas y las dos las mostró la revisión adversarial:
 *   - la fecha del DISCO (mtime) sube sola con un `git checkout`, un rebase o un `stash pop` que
 *     dejan el MISMO contenido → el freno rechazaba una corrida de Playwright válida
 *     (FRESHNESSFLOOR-CHECKOUT-MTIME-1, decidido por el dev el 2026-09-06);
 *   - la fecha del COMMIT (%ct) es cuándo ALGUIEN commiteó, no cuándo ese contenido llegó a este
 *     disco: un `pull` que trae un commit ajeno fechado antes de la corrida dejaba pasar evidencia
 *     vieja como fresca (verde falso), un rebase o un --amend la ponían en «hoy», y un commit
 *     posterior a la evidencia —el orden normal del pipeline— la invalidaba.
 *
 * El dato que sí responde la pregunta lo escribe `on-edit.js` en el marker en cada toque:
 * `filesTouchedAt[archivo] = { hash, ts }` — el sello del contenido que ESA edición dejó y su hora.
 * Entonces, por archivo:
 *   - si el contenido actual tiene el MISMO hash que el último toque de la sesión → cambió en ese
 *     toque (`ts`): un checkout, un rebase, un amend, un stash pop o un commit posterior no lo mueven;
 *   - si el hash es OTRO → alguien más lo cambió después (un pull, un script, una mano ajena) y
 *     la única señal de cuándo es la fecha del disco, que en ese caso es verdad;
 *   - sin sello (marker viejo, archivo tocado por Bash) → fecha del disco, el comportamiento
 *     conservador de siempre.
 * Cero llamadas a git: un hash por archivo. Un archivo ignorado por git cuenta igual que cualquiera.
 * Y sigue valiendo lo de `ACCOV-C11`: la fecha del archivo no prueba frescura — acá sólo se usa
 * cuando el contenido demuestra que cambió.
 */
function pisoDeArchivos(files, registro) {
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const sello = (f) => {
    try { return require('crypto').createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch { return null; }
  };
  const reg = registro && typeof registro === 'object' ? registro : {};
  let piso = 0;
  for (const f of files) {
    const r = reg[f] || reg[(() => { try { return fs.realpathSync(f); } catch { return f; } })()];
    if (r && typeof r.hash === 'string' && Number.isFinite(Number(r.ts))) {
      const h = sello(f);
      if (h === null) continue;                                 // borrado: no cuenta
      piso = Math.max(piso, h === r.hash ? Number(r.ts) : mtime(f));
    } else {
      piso = Math.max(piso, mtime(f));
    }
  }
  return piso;
}

/** La fecha de cambio de UN archivo — el mismo criterio, para poder probarlo de a uno. */
function fechaDeCambio(f, registro) {
  try { fs.statSync(f); } catch { return 0; }   // borrado: no cuenta
  return pisoDeArchivos([f], registro);
}

function computeFreshnessFloor(sessionId) {
  try {
    const sid = sessionIdFileKey(sessionId);
    const markerPath = path.join(stateDirOf(os.homedir()), 'active', `${sid}.json`);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const codeFiles = (marker.filesTouched || [])
      .filter((f) => !/\.md$/i.test(f) && !/\/specs\//.test(f))
      .filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    return pisoDeArchivos(codeFiles, marker.filesTouchedAt) || null;
  } catch {
    return null;
  }
}

// Verifica que exista AL MENOS un archivo de evidencia con un bloque
// "## Playwright Run" verdict=PASS + failed=0 (macro backend) o "- failed: 0" (e2e-gate.sh genérico
// — fix 2026-08-25: el gate genérico escribe `- failed: 0` y el regex literal `failed=0` lo rechazaba;
// ninguna story verificada con el gate genérico podía pasar a review/done por Edit)
// Y (si hay freshnessFloor) con mtime POSTERIOR al último cambio de código.
/**
 * ¿Cuándo se GENERÓ la evidencia? No es la fecha del archivo: un merge o un checkout la reescriben y
 * la rejuvenecen, y una corrida vieja pasaba en main lo que en dev era STALE (crítico del pase de
 * Fable 2026-09-06, D5). La evidencia lleva su hora adentro (`**Generado**: <iso>`, `ts: <iso>`, o el
 * sello compacto del nombre o del encabezado, `20260710T031538Z`, que es el que escribe e2e-gate.sh):
 * la más nueva de las que trae es la de generación, y la fecha del archivo sólo
 * puede ser POSTERIOR a ésa — así que vale la menor de las dos. Sin hora adentro, la del archivo.
 */
function tiempoDeEvidencia(full, contenido) {
  let t = Infinity;
  try { t = fs.statSync(full).mtimeMs; } catch { /* sin stat: sólo lo de adentro */ }
  const texto = `${path.basename(full)}\n${contenido || ''}`;
  const isos = texto.match(/\b20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?\b/g) || [];
  // 🔴 El sello COMPACTO `20260710T031538Z` es el que escribe `e2e-gate.sh` —el único productor de
  // evidencia Playwright del pipeline— en el nombre del archivo y en su encabezado, y no lo escribe
  // en ningún otro formato. Sin esto, 234 de las 296 evidencias reales caían al mtime y el defecto
  // que esta función vino a cerrar seguía abierto para el 79 % de la población (2do pase con Fable).
  for (const c of texto.match(/\b(20\d\d)(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z?\b/g) || []) {
    isos.push(`${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}T${c.slice(9, 11)}:${c.slice(11, 13)}:${c.slice(13, 15)}Z`);
  }
  // y el sello con guion (`20260603-194420`) que usan otros escritores
  for (const c of texto.match(/\b(20\d\d)(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)\b/g) || []) {
    isos.push(`${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}T${c.slice(9, 11)}:${c.slice(11, 13)}:${c.slice(13, 15)}Z`);
  }
  // y la fecha con guiones pero la hora pegada (`2026-05-27T003941`), del DoD checker
  for (const c of texto.match(/\b20\d\d-\d\d-\d\dT\d{6}\b/g) || []) {
    isos.push(`${c.slice(0, 11)}${c.slice(11, 13)}:${c.slice(13, 15)}:${c.slice(15, 17)}Z`);
  }
  const dentro = isos.map((x) => Date.parse(x)).filter((x) => Number.isFinite(x));
  if (dentro.length) t = Math.min(t, Math.max(...dentro));
  return Number.isFinite(t) ? t : 0;
}

function hasFreshPlaywrightPass(repoRoots, storyId, freshnessFloor, storyPath) {
  const expectedPrefix = prefijoDe(storyId, storyPath);
  if (!expectedPrefix) return { pass: false, stale: false };
  let foundStale = false;
  for (const root of repoRoots) {
    const dir = path.join(root, '.advisors', 'dod-runtime');
    if (!fs.existsSync(dir)) continue;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(expectedPrefix) || !f.endsWith('.md')) continue;
        const full = path.join(dir, f);
        const c = fs.readFileSync(full, 'utf8');
        if (/##\s*Playwright Run/i.test(c) && /verdict=PASS/.test(c) && /failed(?:=|:\s*)0\b/.test(c)) {
          if (freshnessFloor && tiempoDeEvidencia(full, c) < freshnessFloor) {
            foundStale = true;
            continue; // verde pero STALE — seguir buscando una fresca
          }
          return { pass: true };
        }
      }
    } catch {
      // ignore
    }
  }
  return { pass: false, stale: foundStale };
}

// Roots donde puede vivir la evidencia de ESTA story (fix atribución 2026-08-14): el repo git
// que contiene el spec + sus companions declarados (`.tycon/advisors.yaml →
// evidence.companion_repos`) + subproyectos con evidencia — criterio único en
// lib/evidence-config.js, el mismo de runtime-matrix.js y on-pre-commit.js. Antes se sumaban
// TODOS los hermanos git del padre: los story-id colisionan entre productos y un `<sid>-*.md`
// ajeno satisfacía el check de evidencia (falso pase del hook).
function findRepoRoots(filePath) {
  const ec = require('./lib/evidence-config.js');
  const repo = ec.discoverRepoRoot(filePath);
  if (!repo) return []; // sin repo no hay atribución segura: el hook queda fail-closed
  // Modo FRENO (FIX-1 — caso C3): los hermanos declarados sólo cuentan si están commiteados.
  for (const aviso of ec.parseEvidenceConfig(repo, { freno: true }).warnings) process.stderr.write(`${aviso}\n`);
  return ec.productEvidenceRoots(repo, { freno: true });
}

function isCriticalStatus(s) {
  return s === 'review' || s === 'done';
}

// ── Constancia (story 7.2 del arnés, 2026-09-16) ─────────────────────────────────────────────────
// Cada decisión sobre una transición a review/done deja UNA línea en frenos.jsonl (sólo la huella:
// id de story + estado nuevo). Ayuda, no evidencia: no toca la decisión ni la salida del hook.
// La lib se carga acá adentro y envuelta: si faltara (instalación a medias), el hook frena igual.
function anotarDecision(regla, veredicto, storyId, estado) {
  try {
    require('./lib/closing-record.js').anotarCierre({ freno: 'on-frontmatter-write', regla, veredicto, huella: `${storyId}\0${estado || ''}` });
  } catch { /* ayuda, no evidencia */ }
}

const fmBlock = (c) => { const m = c.match(/^---\r?\n([\s\S]*?)\r?\n---/); return m ? m[1] : ''; };

/**
 * ¿El Edit/Write transiciona una STORY a review/done? Pura y sin salida: la usa la constancia de la
 * rama de exención, que corta ANTES de que el flujo principal lea la config del repo (y sus avisos).
 * Mismo criterio que el flujo principal: story declarada + id con forma de trabajo + transición de
 * `status:` o un `status: done` nuevo en el bloque `pipelines`.
 */
function transicionDeStory(filePath, oldContent, newContent) {
  try {
    const oldFm = parseFrontmatter(oldContent);
    const newFm = parseFrontmatter(newContent);
    const declaredId = newFm.story;
    if (!declaredId || !newFm.status) return null;
    const { isWorkStoryId, storiesConfigForGate, findRepoRoot } = require('./lib/story-discovery.js');
    if (!isWorkStoryId(String(declaredId), storiesConfigForGate(findRepoRoot(filePath)).idPattern)) return null;
    const oldS = (oldFm.status || '').toLowerCase();
    const newS = (newFm.status || '').toLowerCase();
    const statusTransition = isCriticalStatus(newS) && newS !== oldS;
    const pipelineTransition = (fmBlock(newContent).match(/^\s+status:\s*done\b/gm) || []).length
      > (fmBlock(oldContent).match(/^\s+status:\s*done\b/gm) || []).length;
    return statusTransition || pipelineTransition ? { storyId: String(declaredId), estado: newS } : null;
  } catch {
    return null; // la constancia nunca decide nada: ante la duda, no anota
  }
}

/**
 * Handler dispatchable. Recibe el evento RAW y devuelve:
 *   null              → permitir (exit 0)
 *   { block: msg }    → BLOQUEAR (el caller escribe msg a stderr + exit 2)
 * Lee el archivo del filesystem (oldContent) — eso es intencional.
 */
function handle(event) {
  if (!event) return null;

  const tool = event.tool_name;
  if (tool !== 'Edit' && tool !== 'Write') return null;

  const filePath = event.tool_input?.file_path;
  if (!filePath) return null;

  // 2026-08-15 — sólo `.md`; que SEA una story lo decide el frontmatter, más abajo.
  // Antes acá había `/\/specs\/stories\/[^/]+\.md$/`: en un repo con otro layout —un repo del equipo,
  // `specs/bizuit-bpmn-mcp/`— este gate no se disparaba NUNCA. El freno que impide cerrar una
  // story sin evidencia estaba apagado para todo el repo, sin un solo mensaje.
  if (!/\.md$/i.test(filePath)) return null;

  // Reconstruir el NEW state.
  let newContent;
  const oldContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

  if (tool === 'Write') {
    newContent = event.tool_input.content || '';
  } else {
    // Edit — aplicar mentalmente el reemplazo.
    const oldStr = event.tool_input.old_string || '';
    const newStr = event.tool_input.new_string || '';
    if (!oldContent.includes(oldStr)) {
      // El Edit va a fallar de todas formas (old_string no matchea). Dejá pasar
      // — Claude Code va a reportar el error real.
      return null;
    }
    // CF-5 2026-05-21: usar función de reemplazo — `String.replace(str, newStr)` interpreta
    // `$&`/`$1`/`$$` en newStr como patrones especiales, así que un new_string con `$` daría
    // un newContent distinto al que Edit escribe realmente. La forma `() => newStr` lo evita.
    newContent = event.tool_input.replace_all === true
      ? oldContent.split(oldStr).join(newStr)
      : oldContent.replace(oldStr, () => newStr);
  }

  // Exención explícita.
  if (storyIsExempt(newContent)) {
    const t = transicionDeStory(filePath, oldContent, newContent);
    if (t) anotarDecision('exenta', 'paso', t.storyId, t.estado);
    return null;
  }

  const oldFm = parseFrontmatter(oldContent);
  const newFm = parseFrontmatter(newContent);

  // El criterio ESTRUCTURAL de "esto es una story": su frontmatter declara `story:` y `status:`,
  // y el id tiene FORMA de trabajo. Un `.md` de documentación con `status: publicado` no entra
  // (le falta `story:`), y el material de un banco de evals tampoco (`story: "EV-1"` no es un id
  // de trabajo) — el repo puede declarar otra forma en `.tycon/advisors.yaml → stories.id_pattern`.
  const declaredId = newFm.story;
  if (!declaredId || !newFm.status) return null;
  const { isWorkStoryId, storiesConfigForGate, findRepoRoot } = require('./lib/story-discovery.js');
  const repoOfStory = findRepoRoot(filePath);
  // Modo FRENO — misma razón que en on-pre-commit.js (FIX-1, caso C1): este hook es la SEGUNDA
  // capa del mismo control, y se apagaba con el mismo archivo sin commitear.
  const cfgFreno = storiesConfigForGate(repoOfStory);
  for (const aviso of cfgFreno.warnings) process.stderr.write(`${aviso}\n`);
  if (!isWorkStoryId(String(declaredId), cfgFreno.idPattern)) return null;

  // Trigger 1: top-level status transition. Atrapamos:
  //   - in-progress/ready-for-dev/blocked → review  (entrar a review)
  //   - in-progress/ready-for-dev/blocked → done    (entrar a done)
  //   - review → done                                (escalar a done)
  // No atrapamos done → review (revertir) ni review → review (no-op).
  const oldS = (oldFm.status || '').toLowerCase();
  const newS = (newFm.status || '').toLowerCase();
  const statusTransition =
    isCriticalStatus(newS) && newS !== oldS;

  // Trigger 2: pipeline.X.status: done en el new state que NO estaba antes.
  // Heurística: contamos ocurrencias de `status: done` indentado (block pipelines).
  // H12 2026-05-21: contar SOLO dentro del bloque frontmatter (entre los dos `---`),
  // no en todo el contenido — un spec que documente el pipeline con un `status: done`
  // indentado en prosa/code-block NO debe disparar el gate (falso positivo que bloqueaba
  // edits no relacionados).
  const oldDoneCount = (fmBlock(oldContent).match(/^\s+status:\s*done\b/gm) || []).length;
  const newDoneCount = (fmBlock(newContent).match(/^\s+status:\s*done\b/gm) || []).length;
  const pipelineTransition = newDoneCount > oldDoneCount;

  if (!statusTransition && !pipelineTransition) return null;

  const storyId = newFm.story || path.basename(filePath, '.md');

  // Story requiere runtime evidence?
  if (!storyRequiresRuntimeEvidence(newContent)) {
    anotarDecision('sin-superficie-runtime', 'paso', storyId, newS);
    return null;
  }

  const repoRoots = findRepoRoots(filePath);
  const needsPlaywright = storyNeedsPlaywrightRun(newContent);

  if (hasDodEvidence(repoRoots, storyId, filePath)) {
    // Evidencia genérica existe. Pero si la story tiene E2E reales, ADEMÁS exigir
    // un bloque "## Playwright Run" verdict=PASS (escrito por el gate E2E del proyecto)
    // FRESCO (posterior al último cambio de código de esta corrida — auditoría 2026-06-09).
    const freshnessFloor = computeFreshnessFloor(event.session_id);
    const pw = needsPlaywright ? hasFreshPlaywrightPass(repoRoots, storyId, freshnessFloor, filePath) : { pass: true };
    if (needsPlaywright && !pw.pass) {
      const pl = [];
      pl.push('🚨 BLOQUEADO — story con E2E reales pasa a review/done SIN suite Playwright verde' + (pw.stale ? ' FRESCA' : ''));
      pl.push('');
      pl.push(`  File: ${filePath}`);
      pl.push(`  Story: ${storyId}`);
      pl.push('');
      if (pw.stale) {
        pl.push('Hay evidencia Playwright verde pero es STALE: su mtime es ANTERIOR al último');
        pl.push('cambio de código de esta corrida (marker.filesTouched). Un run verde de hace');
        pl.push('N iteraciones no valida el código que cambió después — re-corré el gate.');
      } else {
        pl.push('Existe evidencia DoD genérica, PERO la story declara tests E2E (FullUI-/E2E-/');
        pl.push('tests_done_playwright_spec) y NO hay un bloque "## Playwright Run" con verdict=PASS');
        pl.push(`en .advisors/dod-runtime/${prefijoDe(storyId, filePath) || '(sin clave: ver el aviso de arriba) '}*.md.`);
      }
      pl.push('');
      pl.push('Correr el gate determinístico del PROYECTO (.tycon/advisors.yaml → e2e.gate):');
      pl.push('');
      // La ruta del archivo sale de tmp-path.js (story 8.17, W6): con una ruta fija bajo /tmp, en Windows bash escribía
      // en la carpeta temporal del usuario y Node leía C:\tmp — quien escribe y quien lee usan "$E2ECFG".
      pl.push('  E2ECFG=$(node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/lib/tmp-path.js e2ecfg <repo>)');
      pl.push('  node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js e2e-config --repo <repo> > "$E2ECFG"');
      pl.push('  GATE=$(node -e \'process.stdout.write(require(process.argv[1]).gate||"")\' "$E2ECFG")');
      pl.push('  FE=$(node -e \'process.stdout.write(require(process.argv[1]).frontend_dir||"")\' "$E2ECFG")');
      // En un monorepo `APPS` puede traer MÁS DE UNA app: el gate va una vez por app tocada
      // (Story QA-1, 2026-08-15). Sugerir el comando de una sola app manda a repetir el bug.
      pl.push(`  EVID=$(node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js evidence-dir --story <spec> --repo <repo> --plain)   # el repo de la STORY`);
      pl.push(`  echo "$APPS" | while read -r FE; do [ -n "$FE" ] || continue; \\`);
      pl.push(`    bash "$GATE" "$FE" ${storyId} "$EVID" || exit 1; done   # [spec-filter...] = scoped`);
      pl.push('');
      pl.push('Por default corre los specs SCOPED a la story (two-tier 2026-06-09); la suite');
      pl.push('COMPLETA corre 1 vez en /tycon-merge-to-main. Exit !=0 si hay rojos → fix antes de done.');
      pl.push('');
      pl.push('Escape único: dod_runtime_exempt: true (solo si la story NO tiene UI/E2E reales).');
      pl.push('');
      pl.push('Caso disparador: Ceibo Stories 4.2 + 4.3.1 (2026-05-20) — E2E declarados "PASS"');
      pl.push('sin correrse / con mocks. Freshness agregada 2026-06-09 (evidencia vieja');
      pl.push('satisfacía el gate para siempre).');
      anotarDecision(pw.stale ? 'evidencia-vieja' : 'e2e-gate-rojo', 'bloqueo', storyId, newS);
      return { block: pl.join('\n') + '\n' };
    }
    anotarDecision('evidencia-ok', 'paso', storyId, newS);
    return null;
  }

  // ============================================================
  // BLOQUEAR (exit 2)
  // ============================================================
  const lines = [];
  lines.push('🚨 BLOQUEADO — Edit/Write transiciona story a review/done sin DoD evidence');
  lines.push('');
  lines.push(`  File: ${filePath}`);
  lines.push(`  Story: ${storyId}`);
  lines.push(`  ${statusTransition ? '→ status: ' + (oldFm.status || '?') + ' → ' + (newFm.status || '?') : ''}`);
  lines.push(`  ${pipelineTransition ? `→ pipelines.*.status: done added (${oldDoneCount} → ${newDoneCount})` : ''}`);
  lines.push('');
  lines.push('La story declara tests runtime-dependent (Playwright/E2E/smoke) pero no');
  lines.push(`existe archivo de evidencia .advisors/dod-runtime/${prefijoDe(storyId, filePath) || '(sin clave: no se pudo calcular, ver el aviso de arriba) '}*.md en:`);
  for (const r of repoRoots) {
    lines.push(`  - ${path.join(r, '.advisors', 'dod-runtime')}`);
  }
  lines.push('');
  lines.push('Acciones (en orden de preferencia):');
  lines.push('  (a) Invocar tycon-dod-runtime-checker advisor (auto-captura evidencia).');
  lines.push('  (b) Ejecutar E2E specs + capturar log → escribir manualmente el archivo.');
  lines.push('  (c) Si la story NO tiene UI/E2E reales → agregar al frontmatter:');
  lines.push('        dod_runtime_exempt: true');
  lines.push('        dod_runtime_exempt_reason: "<razón concreta>"');
  lines.push('');
  lines.push('Caso disparador: Ceibo Story 4.2 2026-05-20 — Claude marcó done sin');
  lines.push('ejecutar E2E. Este hook es la infra que lo enforce. Docs:');
  lines.push('  ~/.claude/tycon-harness/guides/definition-of-done.md');

  anotarDecision('evidencia-ausente', 'bloqueo', storyId, newS);
  return { block: lines.join('\n') + '\n' };
}

module.exports = { handle, prefijoDe, findRepoRoots, hasFreshPlaywrightPass, hasDodEvidence, fechaDeCambio, computeFreshnessFloor, tiempoDeEvidencia };

// ── CLI shim (standalone) — preserva exit 2 (block) + fail-open logueado (H19) ──
if (require.main === module) {
  try {
    const r = handle(readEvent());
    if (r && r.block) {
      process.stderr.write(r.block);
      process.exit(2);
    }
    process.exit(0);
  } catch (e) {
    // Fail-open (no bloquear edits válidos por un bug del hook) PERO visible (H19):
    // un gate desactivado en silencio era el riesgo marcado por la auditoría.
    const msg = (e && (e.stack || e.message)) || String(e);
    process.stderr.write(`⚠ tycon-dod-runtime (frontmatter): hook error (FAILING OPEN — gate NO aplicado): ${msg}\n`);
    try {
      const logDir = path.join(stateDirOf(os.homedir()));
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, 'hook-errors.log'),
        `[${new Date().toISOString()}] on-frontmatter-write.js FAILED OPEN — DoD gate NO aplicado:\n${msg}\n\n`,
        'utf8',
      );
    } catch { /* stderr ya quedó emitido */ }
    process.exit(0);
  }
}
