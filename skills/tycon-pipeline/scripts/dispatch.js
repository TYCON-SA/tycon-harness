#!/usr/bin/env node
/**
 * tycon hook dispatcher (H10 2026-05-21).
 *
 * Corre múltiples handlers de hook en UN solo proceso Node por evento, en vez de
 * spawnear un proceso por hook. Reduce los ~4 cold-starts de Node por Edit a ~2
 * (medido: ~219ms → ~110ms en el critical path síncrono).
 *
 * Uso (desde ~/.claude/settings.json):
 *   node .../dispatch.js pre-edit      # PreToolUse  matcher Edit|Write
 *   node .../dispatch.js post-edit     # PostToolUse matcher Edit|Write
 *
 * Contrato de los handlers (cada módulo exporta handle(event)):
 *   null            → nada
 *   { reminder: t } → advisory → se envuelve en <system-reminder> a stdout
 *   { systemMessage: t } → se le muestra a la PERSONA en pantalla (solo PostToolUse). Con algo que mostrar, la salida
 *                   es el JSON de Claude Code ({ systemMessage, hookSpecificOutput.additionalContext } con los
 *                   reminders adentro), salvo que un handler lanzado aparte ya haya escrito: ahí va como reminder
 *   { block: msg }  → BLOQUEAR → stderr + exit 2 (solo válido en PreToolUse)
 *
 * Fail-open + VISIBLE (H19): si un handler tira, se loguea a
 * ~/.claude/.tycon-pipeline/hook-errors.log y se sigue con el resto — un bug de
 * un handler no debe romper el Edit ni esconder en silencio que un gate no corrió.
 *
 * NOTA: `touch-activity` (clocki, matcher all-tools async) NO se dispatcha acá —
 * tiene matcher distinto (corre en CADA tool, no solo Edit|Write) y es async.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
// Normalización apply_patch→Edit/Write (Etapa E2 Codex, 2026-08-22): en Codex la tool de
// edición es `apply_patch` y su tool_input es un TEXTO de patch — editEventsFrom() lo convierte
// en N eventos claude-shaped (uno por archivo) y las hojas de la cadena no se enteran.
// Require con FALLBACK deliberado: si la lib no está en esta máquina (el branch de
// el arnés todavía no mergeó), todo se comporta EXACTAMENTE como hoy — el rollout
// cross-repo es seguro por orden. Lado Claude: editEventsFrom es identidad, cero cambio.
let editEventsFrom = null;
let ARNES_DIR = null;
try {
  // Dónde está el arnés lo dice UN lector (lib/harness-path.js, story 8.3): TYCON_GUIDES_DIR (o TCG, que
  // exporta el runner del banco, cuyo HOME va sandboxeado) › el lugar `~/.claude/tycon-harness`.
  // Nunca una carpeta escrita a mano. Un hook no frena por esto: lo dice y sigue (fail-open).
  const r = require('./lib/harness-path.js').rutaArnesHook();
  if (r.dir) { ARNES_DIR = r.dir; ({ editEventsFrom } = require(path.join(r.dir, 'scripts', 'lib', 'hook-io.js'))); }
  else process.stderr.write(r.aviso + '\n');
} catch { /* fallback: sin normalización, conducta actual */ }

// Clockify (story 8.3 del arnés, AC 9): este despachador es un hook COMPARTIDO con el núcleo — no se desregistra;
// con la llave `integraciones.clockify` apagada saltea `clocki-enforce` (los otros dos hooks de clocki los deja sin
// registrar el instalador). Configuración ROTA: el aviso en cada edición y sin clocki-enforce (AC 2). Sin arnés, o
// con un arnés anterior a la tanda B (sin `integracionParaHook`): como hoy — fail-open.
function integrationOn(key) {
  if (!ARNES_DIR) return true;
  try {
    const cfg = require(path.join(ARNES_DIR, 'scripts', 'lib', 'tycon-config.js'));
    if (typeof cfg.integracionParaHook !== 'function') return true;
    const c = cfg.integracionParaHook(key);
    if (!c.ok) process.stderr.write(c.aviso + '\n');
    return c.prendida;
  } catch { return true; }
}
const clockifyPrendida = () => integrationOn('clockify');

// Azure DevOps (2026-10-05, la copia para un dev de otra organización): la hoja que pide el work item de una story nueva
// corre sólo si la máquina tiene la integración ado prendida (ado.org o TYCON_ADO_ORG) o si el repo de la story declara
// su Azure DevOps (`.tycon/ado-config.yaml`, la primera fuente de la skill). Sin ninguna de las dos, la skill se
// salteaba sola después de un turno de aviso: ruido para quien no usa Azure DevOps. Sin arnés: como antes (fail-open).
function repoDeclaresAdo(filePath) {
  let dir = path.dirname(path.resolve(String(filePath || '.')));
  for (;;) {
    if (fs.existsSync(path.join(dir, '.tycon', 'ado-config.yaml'))) return true;
    if (fs.existsSync(path.join(dir, '.git'))) return false;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}
const adoForStory = (event) => repoDeclaresAdo(event?.tool_input?.file_path) || integrationOn('ado');

// Las tres formas de una ruta de Windows (story 8.17 del arnés, W1): el evento llega a los portones con su ruta ya
// nativa. Sin la lib (un skill a medias), como antes: el evento tal cual.
let nativeEvent = (event) => event;
try { ({ nativeEvent } = require('./lib/path-shape.js')); } catch { /* sin normalización de rutas: conducta previa */ }

const PIPELINE_SCRIPTS = __dirname;
const CLOCKI_SCRIPTS = path.join(__dirname, '..', '..', 'clocki', 'scripts');
const SKILLS_DIR = path.join(__dirname, '..', '..');

// mode → lista ORDENADA de handlers. El blocking (on-dod-evidence-guard +
// on-frontmatter-write) va primero en pre-edit: si bloquea, no tiene sentido
// acumular reminders advisory.
//
// Entries `spawn: true` (H10 residual, auditoría 2026-06-09): scripts top-level
// de OTROS skills que no exportan handle() — se spawnean como subproceso, pero
// SOLO si spawnIf(event) matchea. Antes corrían como hooks standalone en CADA
// Write (2 spawns Node extra por evento); ahora solo cuando el Write toca una
// story Mary+GOLD (el único caso que les importa).
//
// Qué es "una story" lo decide la IDENTIDAD DECLARADA (`story:` en el frontmatter del content),
// con el criterio del descubridor canónico (lib/story-discovery.js — el mismo del lint del
// 2026-08-23). Hasta 2026-08-28 acá había un regex de RUTA (`/specs/stories/`): medido ese día,
// 13 de los 15 repos con stories del equipo (751 de 1083 stories) usan otro layout, o sea que
// los dos hooks de story-create no corrían NUNCA fuera de CeiboProject — sin un solo error.
// Las hojas ya detectaban por contenido; el pre-filtro las dejaba sin spawnear. El barrido del
// 2026-08-15 (incident-log#story-discovery-nombres) arregló 3 gates con este mismo defecto y a
// éste no lo vio. Caso: el arnés incident-log#story-write-spawn-2026-08-28.
//
// Por qué NO genera falsos positivos caros (esto corre en CADA Write): el 99% de los Writes se
// descartan por extensión sin mirar content; un `.md` se decide con un regex EN MEMORIA sobre el
// content que ya vino en el evento — sin IO, sin spawn. PRDs/épicos/arquitectura declaran
// `status:` pero no `story:` (medición 2026-08-23: 0 de los 13 docs de planning del corpus).
// Plantillas y material de evals sí declaran `story:` y pasan el pre-filtro: las HOJAS deciden
// (mismo comportamiento que siempre tuvieron bajo specs/stories/; el skill ADO además pide
// confirmación al dev). El disco se lee SOLO si el evento no trae content (forma Codex
// apply_patch→Write sin la extracción de hook-io): esto es PostToolUse — el archivo ya existe.
let declaresStoryIdentity = null;
try {
  ({ declaresStoryIdentity } = require(path.join(__dirname, 'lib', 'story-discovery.js')));
} catch { /* sin la lib (skill roto a medias): fallback abajo a la conducta previa por ruta */ }

const isStoryWrite = (event) => {
  if (event?.tool_name !== 'Write') return false;
  const fp = String(event?.tool_input?.file_path || '');
  if (!/\.md$/i.test(fp)) return false;
  if (!declaresStoryIdentity) return /\/specs\/stories\/[^/]+\.md$/.test(fp.replace(/\\/g, '/'));
  const content = event?.tool_input?.content;
  if (typeof content === 'string' && content.length) return declaresStoryIdentity(content);
  try {
    return declaresStoryIdentity(fs.readFileSync(fp, 'utf8'));
  } catch {
    return false; // el archivo no está / no se puede leer → no era un Write real de una story
  }
};

const CHAINS = {
  'pre-edit': [
    // Portón de CARRIL (2026-08-19): deniega código sin pipeline/ad-hoc, código antes del plan aprobado,
    // y escrituras directas al estado del pipeline. Va PRIMERO: es el más amplio. Ver lib/story-gate.js.
    // `steps` (los pasos del pipeline donde actúa, o 'all') y `effect` (blocks · warns · records) no los usa el
    // despachador: los muestra «Cómo trabaja», en el sitio de la organización, en lugar del despachador mismo.
    { name: 'on-story-gate', path: path.join(PIPELINE_SCRIPTS, 'on-story-gate.js'), steps: ['3', '4'], effect: 'blocks' },
    // Freno de STORY A MANO (2026-08-30): deniega CREAR un .md con identidad de story sin constancia
    // de tycon-create-story en la sesión (la deja on-skill-invoke.js, PostToolUse Skill). Editar una
    // story existente pasa siempre. Ver lib/story-skill-gate.js. Caso: stories AS-1 / PERF-1 de un producto del equipo — guides/maintaining/incident-log.md#story-a-mano-sin-skill-2026-08-30.
    { name: 'on-story-skill-gate', path: path.join(PIPELINE_SCRIPTS, 'on-story-skill-gate.js'), steps: ['1'], effect: 'blocks' },
    { name: 'on-dod-evidence-guard', path: path.join(PIPELINE_SCRIPTS, 'on-dod-evidence-guard.js'), steps: ['7c'], effect: 'blocks' },
    { name: 'on-frontmatter-write', path: path.join(PIPELINE_SCRIPTS, 'on-frontmatter-write.js'), steps: ['7c', '8'], effect: 'blocks' },
    // Portón ATDD preventivo (2026-07-30): deniega el PRIMER archivo de código de una corrida de
    // pipeline si no se tocó ningún test antes. Las capas post-mortem (complete-step 4, commit)
    // detectan; ésta impide. Ver on-atdd-preedit.js + lib/atdd-preedit.js.
    { name: 'on-atdd-preedit', path: path.join(PIPELINE_SCRIPTS, 'on-atdd-preedit.js'), steps: ['4'], effect: 'blocks' },
    { name: 'on-write-collision', path: path.join(PIPELINE_SCRIPTS, 'on-write-collision.js'), steps: ['4'], effect: 'warns' },
    { name: 'on-planning-artifact', path: path.join(PIPELINE_SCRIPTS, 'on-planning-artifact.js'), steps: ['2'], effect: 'warns' },
  ],
  'post-edit': [
    // sin la integración clockify no corre (`saltarClocki`, más abajo): `integration` lo dice para «Cómo trabaja»
    { name: 'clocki-enforce', path: path.join(CLOCKI_SCRIPTS, 'clocki-enforce.js'), steps: ['all'], effect: 'warns', integration: 'clockify' },
    { name: 'on-edit', path: path.join(PIPELINE_SCRIPTS, 'on-edit.js'), steps: ['all'], effect: 'records' },
    // Lint de la config del repo (FIX-4(c), 2026-08-25): `.tycon/advisors.yaml` es la única
    // superficie que puede apagar frenos y NO dispara revisores (un commit que sólo la toca se
    // clasifica como docs). Determinístico, sin modelo, avisa y nunca bloquea.
    { name: 'on-config-lint', path: path.join(PIPELINE_SCRIPTS, 'on-config-lint.js'), steps: ['all'], effect: 'warns' },
    // El plan escrito se lo muestra el arnés a la persona en pantalla (el agente no siempre lo hace: medido)
    { name: 'plan-display', path: path.join(PIPELINE_SCRIPTS, 'lib', 'plan-display.js'), steps: ['2', '3'], effect: 'warns' },
    // Una historia con pantalla en un repo sin prueba con navegador: el arnés le ofrece a la persona prepararla
    { name: 'browser-test-offer', path: path.join(PIPELINE_SCRIPTS, 'lib', 'browser-test.js'), steps: ['2', '3'], effect: 'warns' },
    { name: 'ado-story-create', path: path.join(SKILLS_DIR, 'tycon-ado-story-wi', 'scripts', 'on-story-create.js'), spawn: true, spawnIf: (event) => isStoryWrite(event) && adoForStory(event), steps: ['1'], effect: 'records' },
    { name: 'followup-story-create', path: path.join(SKILLS_DIR, 'tycon-story-followup-link', 'scripts', 'on-story-create.js'), spawn: true, spawnIf: isStoryWrite, steps: ['1'], effect: 'records' },
  ],
};

function logHookError(name, e) {
  const msg = (e && (e.stack || e.message)) || String(e);
  try {
    process.stderr.write(`⚠ tycon dispatch: handler "${name}" error (failing open): ${msg}\n`);
  } catch { /* noop */ }
  try {
    const logDir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'hook-errors.log'),
      `[${new Date().toISOString()}] dispatch handler "${name}" FAILED OPEN: ${msg}\n\n`,
      'utf8',
    );
  } catch { /* noop */ }
}

function readEvent() {
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    return stdin ? JSON.parse(stdin) : null;
  } catch {
    return null;
  }
}

/**
 * Los eventos que va a ver la cadena: apply_patch (Codex) → N eventos claude-shaped, uno por archivo del patch;
 * cualquier otro pasa como identidad. Y en Windows, cada uno con su ruta en forma nativa: un `file_path` en la forma
 * de Git Bash (`/c/a/b`) no encontraba su repo y los portones dejaban pasar (medido, corrida 11694).
 */
function prepareEvents(rawEvent, platform = process.platform) {
  const events = editEventsFrom ? editEventsFrom(rawEvent) : [rawEvent];
  return events.map((event) => nativeEvent(event, platform));
}

function dispatch(mode) {
  const chain = CHAINS[mode];
  if (!chain) {
    // modo desconocido → no-op (nunca romper el tool call por esto)
    process.exit(0);
  }

  const rawEvent = readEvent();
  // Un block en CUALQUIER archivo de un patch bloquea el patch entero (es un solo tool call
  // atómico — semántica correcta).
  const events = prepareEvents(rawEvent);
  const reminders = [];
  const paraLaPersona = [];
  let escribioAparte = false;
  const saltarClocki = mode === 'post-edit' && !clockifyPrendida();

  for (const event of events) for (const h of chain) {
    if (saltarClocki && h.name === 'clocki-enforce') continue;   // Clockify apagada: el despachador sigue, sin su parte
    // Scripts top-level de otros skills (sin handle()) — spawn condicional por contenido.
    if (h.spawn) {
      try {
        // Las hojas deciden por tool_input.content. Un Write de `.md` sin content (evento Codex
        // normalizado por un hook-io viejo, sin extracción de Add File) las dejaría mudas: esto
        // es PostToolUse — el archivo ya está en disco — así que se completa acá UNA vez, y
        // spawnIf y las hojas siguen siendo content-based.
        let spawnEvent = event;
        const ti = event?.tool_input;
        if (event?.tool_name === 'Write' && ti && typeof ti.content !== 'string'
            && /\.md$/i.test(String(ti.file_path || ''))) {
          try {
            spawnEvent = Object.assign({}, event, {
              tool_input: Object.assign({}, ti, { content: fs.readFileSync(String(ti.file_path), 'utf8') }),
            });
          } catch { /* archivo ilegible: el evento sigue tal cual y spawnIf decide */ }
        }
        if (!h.spawnIf || h.spawnIf(spawnEvent)) {
          if (fs.existsSync(h.path)) {
            const { execFileSync } = require('child_process');
            // el mismo Node que corre este despachador (el del arnés, si lo lanzó así: story 8.39), no el del PATH
            const out = execFileSync(process.execPath, [h.path], {
              input: JSON.stringify(spawnEvent || {}),
              encoding: 'utf8',
              timeout: 15000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            if (out && out.trim()) { process.stdout.write(out); escribioAparte = true; }
          }
        }
      } catch (e) {
        logHookError(h.name, e); // fail-open + visible (PostToolUse: nunca bloquea)
      }
      continue;
    }

    let mod;
    try {
      mod = require(h.path); // skip silencioso si el archivo no existe (ej: clocki no instalado)
    } catch {
      continue;
    }
    if (!mod || typeof mod.handle !== 'function') continue;

    let result;
    try {
      result = mod.handle(event);
    } catch (e) {
      logHookError(h.name, e); // fail-open + visible
      continue;
    }

    if (!result) continue;

    if (result.block) {
      // BLOQUEAR inmediatamente. Los reminders advisory acumulados se descartan
      // (el tool call va a ser denegado de todas formas).
      process.stderr.write(result.block);
      process.exit(2);
    }
    if (result.reminder) {
      reminders.push(result.reminder);
    }
    if (result.systemMessage && mode === 'post-edit') paraLaPersona.push({ texto: String(result.systemMessage), alMostrar: result.alMostrar, name: h.name });
  }

  if (paraLaPersona.length && !escribioAparte) {
    const contexto = reminders.map((t) => `<system-reminder>\n${String(t).trim()}\n</system-reminder>`).join('\n');
    process.stdout.write(JSON.stringify({
      systemMessage: paraLaPersona.map((p) => p.texto).join('\n\n'),
      ...(contexto ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: contexto } } : {}),
    }));
    // recién mostrado, se anota (`alMostrar`): lo que bajó a reminder abajo lo lee sólo el agente y no se anota
    for (const p of paraLaPersona) if (typeof p.alMostrar === 'function') { try { p.alMostrar(); } catch (e) { logHookError(p.name, e); } }
    process.exit(0);
  }
  for (const p of paraLaPersona) reminders.push(p.texto);
  if (reminders.length > 0) {
    const out = reminders
      .map((t) => `<system-reminder>\n${String(t).trim()}\n</system-reminder>\n`)
      .join('');
    process.stdout.write(out);
  }
  process.exit(0);
}

module.exports = { dispatch, prepareEvents, CHAINS };

// CLI: `node dispatch.js pre-edit|post-edit` (los entry-scripts hook-*.js lo llaman).
if (require.main === module) {
  dispatch(process.argv[2]);
}
