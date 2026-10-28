#!/usr/bin/env node
/**
 * tycon hook dispatcher.
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
 * Fail-open + VISIBLE: si un handler tira, se loguea a
 * ~/.claude/.tycon-pipeline/hook-errors.log y se sigue con el resto — un bug de
 * un handler no debe romper el Edit ni esconder en silencio que un gate no corrió.
 *
 * Los hooks de una integración que corren en CADA tool (y de fondo) no pasan por acá: tienen otro matcher, y los
 * registra el instalador desde el manifiesto de la integración.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // La carpeta del estado, de una sola pieza
// Normalización apply_patch→Edit/Write (Codex): en Codex la tool de
// edición es `apply_patch` y su tool_input es un TEXTO de patch — editEventsFrom() lo convierte
// en N eventos claude-shaped (uno por archivo) y las hojas de la cadena no se enteran.
// Require con FALLBACK deliberado: si la lib no está en esta máquina, todo se comporta
// EXACTAMENTE igual que sin esta normalización — el rollout
// cross-repo es seguro por orden. Lado Claude: editEventsFrom es identidad, cero cambio.
let editEventsFrom = null;
let ARNES_DIR = null;
let AVISO_SIN_ARNES = null;
try {
  // Dónde está el arnés lo dice UN lector (lib/harness-path.js): TYCON_GUIDES_DIR (o TCG, que
  // exporta el runner del banco, cuyo HOME va sandboxeado) › el lugar `~/.claude/tycon-harness`.
  // Nunca una carpeta escrita a mano. Un hook no frena por esto: lo dice y sigue (fail-open).
  const r = require('./lib/harness-path.js').rutaArnesHook();
  if (r.dir) { ARNES_DIR = r.dir; ({ editEventsFrom } = require(path.join(r.dir, 'scripts', 'lib', 'hook-io.js'))); }
  // el aviso lo da dispatch(), cuando corre un gancho; quien sólo carga el archivo para leer sus cadenas (el sitio,
  // al armar «Cómo trabaja») no corre ninguno, y en su registro sería ruido en cada carga
  else AVISO_SIN_ARNES = r.aviso;
} catch { /* fallback: sin normalización, conducta actual */ }

// Una llave de integración del arnés. Configuración ROTA: el aviso en cada edición y apagada. Sin arnés, o con un arnés
// sin `integracionParaHook`: fail-open.
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

// Las entradas de la integración de horas elegida para este modo (su manifiesto en integrations/ del arnés):
// `[{ name, path, steps, effect, integration }]`. Sin arnés, sin elegir o con la configuración rota, ninguna (rota: el
// aviso, como integrationOn). El despachador no conoce ninguna herramienta por su nombre.
function integrationEntries(mode) {
  if (!ARNES_DIR) return [];
  // cada salida sin entradas que no sea «ninguna elegida» se dice: la herramienta elegida quedaría sin su control
  const warn = (why) => { process.stderr.write(`dispatch: la integración de horas no suma sus controles (${why})\n`); return []; };
  try {
    const TC = require(path.join(ARNES_DIR, 'scripts', 'lib', 'tycon-config.js'));
    const INT = require(path.join(ARNES_DIR, 'scripts', 'lib', 'integrations.js'));
    if (typeof TC.timeTracking !== 'function' || typeof TC.leerParaHook !== 'function') return [];
    const r = TC.leerParaHook();
    if (!r.ok) { if (r.aviso) process.stderr.write(r.aviso + '\n'); return []; }
    const chosen = TC.timeTracking(r.config).value;
    if (chosen === 'none') return [];
    const m = INT.find(chosen, { kind: 'timeTracking' });
    if (m) return INT.dispatchEntries(m, mode);
    const broken = INT.listManifests().problems.find((p) => p.name === chosen);
    return warn(broken ? `«${chosen}» tiene el manifiesto roto: ${broken.reasons.join('; ')}` : `no encuentro «${chosen}» en integrations/`);
  } catch (e) { return warn(`falló al leerla: ${(e && (e.code || e.message)) || e}`); }
}

// Azure DevOps (la copia para un dev de otra organización): la hoja que pide el work item de una story nueva
// corre sólo si la máquina tiene la integración ado prendida (ado.org o TYCON_ADO_ORG) o si el repo de la story declara
// su Azure DevOps (`.tycon/ado-config.yaml`, la primera fuente de la skill). Sin ninguna de las dos, la skill se
// saltea sola después de un turno de aviso: ruido para quien no usa Azure DevOps. Sin arnés: fail-open.
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

// Las tres formas de una ruta de Windows: el evento llega a los portones con su ruta ya
// nativa. Sin la lib (un skill a medias): el evento tal cual.
let nativeEvent = (event) => event;
try { ({ nativeEvent } = require('./lib/path-shape.js')); } catch { /* sin normalización de rutas: conducta previa */ }

const PIPELINE_SCRIPTS = __dirname;
const SKILLS_DIR = path.join(__dirname, '..', '..');
// integrations/ del mismo árbol que las skills; si las skills vienen de un clon que sólo trae skills/, agents/ y packs/,
// la del arnés
const INTEGRATIONS_DIR = [path.join(SKILLS_DIR, '..', 'integrations'), ARNES_DIR && path.join(ARNES_DIR, 'integrations')]
  .find((d) => d && fs.existsSync(d)) || path.join(SKILLS_DIR, '..', 'integrations');

// mode → lista ORDENADA de handlers. El blocking (on-dod-evidence-guard +
// on-frontmatter-write) va primero en pre-edit: si bloquea, no tiene sentido
// acumular reminders advisory.
//
// Entries `spawn: true`: scripts top-level
// de OTROS skills que no exportan handle() — se spawnean como subproceso, pero
// SOLO si spawnIf(event) matchea. Si no, correrían como hooks standalone en CADA
// Write (2 spawns Node extra por evento); sólo cuando el Write toca una
// story Mary+GOLD (el único caso que les importa).
//
// Qué es "una story" lo decide la IDENTIDAD DECLARADA (`story:` en el frontmatter del content),
// con el criterio del descubridor canónico (lib/story-discovery.js, el mismo del lint).
// Un regex de RUTA (`/specs/stories/`) no sirve: 13 de los 15 repos con stories del equipo
// (751 de 1083 stories) usan otro layout, así que los dos hooks de story-create no correrían
// fuera de ese layout — sin un solo error. Las hojas ya detectan por contenido; un pre-filtro
// por ruta las dejaría sin spawnear.
//
// Por qué NO genera falsos positivos caros (esto corre en CADA Write): el 99% de los Writes se
// descartan por extensión sin mirar content; un `.md` se decide con un regex EN MEMORIA sobre el
// content que ya vino en el evento — sin IO, sin spawn. PRDs/épicos/arquitectura declaran
// `status:` pero no `story:` (medido: 0 de los 13 docs de planning del corpus).
// Plantillas y material de evals sí declaran `story:` y pasan el pre-filtro: las HOJAS deciden
// (mismo comportamiento que bajo specs/stories/; el skill ADO además pide
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
    return false; // el archivo no está / no se puede leer → no es un Write real de una story
  }
};

const CHAINS = {
  'pre-edit': [
    // Sacar un control del arnés de la configuración de la herramienta (disableAllHooks, un interruptor en env, un hook
    // del arnés) frena antes, en cualquier paso. Ver lib/controls-off.js; la terminal la mira safety-guard-pre.sh.
    { name: 'on-controls-off', path: path.join(PIPELINE_SCRIPTS, 'on-controls-off.js'), steps: ['all'], effect: 'blocks' },
    // Portón de CARRIL: deniega código sin pipeline/ad-hoc, código antes del plan aprobado,
    // y escrituras directas al estado del pipeline. Va PRIMERO: es el más amplio. Ver lib/story-gate.js.
    // `steps` (los pasos del pipeline donde actúa, o 'all') y `effect` (blocks · warns · records) no los usa el
    // despachador: los muestra «Cómo trabaja», en el sitio de la organización, en lugar del despachador mismo.
    { name: 'on-story-gate', path: path.join(PIPELINE_SCRIPTS, 'on-story-gate.js'), steps: ['approve-plan', 'implement'], effect: 'blocks' },
    // Freno de STORY A MANO: deniega CREAR un .md con identidad de story sin constancia
    // de tycon-create-story en la sesión (la deja on-skill-invoke.js, PostToolUse Skill). Editar una
    // story existente pasa siempre. Ver lib/story-skill-gate.js.
    { name: 'on-story-skill-gate', path: path.join(PIPELINE_SCRIPTS, 'on-story-skill-gate.js'), steps: ['validate-story'], effect: 'blocks' },
    { name: 'on-dod-evidence-guard', path: path.join(PIPELINE_SCRIPTS, 'on-dod-evidence-guard.js'), steps: ['live-check'], effect: 'blocks' },
    { name: 'on-frontmatter-write', path: path.join(PIPELINE_SCRIPTS, 'on-frontmatter-write.js'), steps: ['live-check', 'prepare-commit'], effect: 'blocks' },
    // Portón ATDD preventivo: deniega el PRIMER archivo de código de una corrida de
    // pipeline si no se tocó ningún test antes. Las capas post-mortem (complete-step run-tests, commit)
    // detectan; ésta impide. Ver on-atdd-preedit.js + lib/atdd-preedit.js.
    { name: 'on-atdd-preedit', path: path.join(PIPELINE_SCRIPTS, 'on-atdd-preedit.js'), steps: ['implement'], effect: 'blocks' },
    { name: 'on-write-collision', path: path.join(PIPELINE_SCRIPTS, 'on-write-collision.js'), steps: ['implement'], effect: 'warns' },
    { name: 'on-planning-artifact', path: path.join(PIPELINE_SCRIPTS, 'on-planning-artifact.js'), steps: ['plan'], effect: 'warns' },
    // Código deprecado del repo (lib/deprecated.js): con `deprecated.edit: block`, editarlo sin una historia que lo pida
    // frena acá; con `warn`, el aviso sale después de editar (en post-edit), que es el que le llega al modelo.
    { name: 'on-deprecated-edit', path: path.join(PIPELINE_SCRIPTS, 'on-deprecated-edit.js'), steps: ['all'], effect: 'blocks' },
  ],
  'post-edit': [
    // antes de esta tabla van las entradas de la integración de horas elegida (integrationEntries)
    { name: 'on-edit', path: path.join(PIPELINE_SCRIPTS, 'on-edit.js'), steps: ['all'], effect: 'records' },
    // Lint de la config del repo: `.tycon/advisors.yaml` es la única
    // superficie que puede apagar frenos y NO dispara revisores (un commit que sólo la toca se
    // clasifica como docs). Determinístico, sin modelo, avisa y nunca bloquea.
    { name: 'on-config-lint', path: path.join(PIPELINE_SCRIPTS, 'on-config-lint.js'), steps: ['all'], effect: 'warns' },
    // Código deprecado editado sin una historia que lo pida, con `deprecated.edit: warn`: se le dice a la persona y al modelo
    { name: 'on-deprecated-edit', path: path.join(PIPELINE_SCRIPTS, 'on-deprecated-edit.js'), steps: ['all'], effect: 'warns' },
    // El plan escrito se lo muestra el arnés a la persona en pantalla (el agente no siempre lo hace: medido)
    { name: 'plan-display', path: path.join(PIPELINE_SCRIPTS, 'lib', 'plan-display.js'), steps: ['plan', 'approve-plan'], effect: 'warns' },
    // El crítico que se quiere eximir se lo muestra el arnés a la persona al escribirse el pedido (instalación mínima)
    { name: 'critical-display', path: path.join(PIPELINE_SCRIPTS, 'lib', 'critical-display.js'), steps: ['all'], effect: 'warns' },
    // Los criterios que se van a marcar como probados a mano se los muestra el arnés a la persona (instalación mínima)
    { name: 'manual-check-display', path: path.join(PIPELINE_SCRIPTS, 'lib', 'manual-checks.js'), steps: ['all'], effect: 'warns' },
    // El criterio que se quiere firmar como imposible de probar en vivo, al escribirse el pedido (instalación mínima)
    { name: 'waiver-display', path: path.join(PIPELINE_SCRIPTS, 'lib', 'waiver-display.js'), steps: ['all'], effect: 'warns' },
    // Una historia con pantalla en un repo sin prueba con navegador: el arnés le ofrece a la persona prepararla
    { name: 'browser-test-offer', path: path.join(PIPELINE_SCRIPTS, 'lib', 'browser-test.js'), steps: ['plan', 'approve-plan'], effect: 'warns' },
    // crea el pedido de trabajo en ADO: `integration` lo dice para «Cómo trabaja» (lo apagado en la organización no se muestra)
    { name: 'ado-story-create', path: path.join(INTEGRATIONS_DIR, 'azure-devops', 'scripts', 'on-story-create.js'), spawn: true, spawnIf: (event) => isStoryWrite(event) && adoForStory(event), steps: ['validate-story'], effect: 'records', integration: 'ado' },
    { name: 'followup-story-create', path: path.join(SKILLS_DIR, 'tycon-story-followup-link', 'scripts', 'on-story-create.js'), spawn: true, spawnIf: isStoryWrite, steps: ['validate-story'], effect: 'records' },
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
 * de Git Bash (`/c/a/b`) no encontraría su repo y los portones dejarían pasar.
 */
function prepareEvents(rawEvent, platform = process.platform) {
  const events = editEventsFrom ? editEventsFrom(rawEvent) : [rawEvent];
  return events.map((event) => nativeEvent(event, platform));
}

/**
 * Las firmas sobre un archivo (scripts/lib/owner-window.js) se gastan sólo si la escritura pasa la cadena entera: con
 * los consumos abiertos, la regla que valida una firma la reserva, y al terminar se gastan (pasó) o vuelven a su lugar
 * (frenó otra regla, de este u otro handler). Un gancho de otro proceso que frena después no se entera: ése la gasta igual.
 * Devuelve las que no se pudieron cerrar; cada una queda en el registro de errores de los ganchos.
 */
const CONSUMOS = Symbol.for('tycon.consumos-diferidos');
function abrirConsumos() { globalThis[CONSUMOS] = []; }
function cerrarConsumos({ paso }) {
  const lista = globalThis[CONSUMOS];
  delete globalThis[CONSUMOS];
  if (!Array.isArray(lista) || !lista.length) return [];
  let errores;
  try {
    errores = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'owner-window.js')).confirmarConsumos(lista, { paso: !!paso });
  } catch (e) {
    errores = lista.map(({ f }) => ({ f, error: e.message }));
  }
  for (const { f, error } of errores) logHookError('consumos-de-firmas', new Error(`la firma ${path.basename(f)} no se pudo ${paso ? 'gastar' : 'devolver'} (${error}): queda reservada, no se reusa`));
  return errores;
}

function dispatch(mode) {
  if (AVISO_SIN_ARNES) process.stderr.write(AVISO_SIN_ARNES + '\n');
  const chain = CHAINS[mode];
  if (!chain) {
    // modo desconocido → no-op (nunca romper el tool call por esto)
    process.exit(0);
  }
  abrirConsumos();

  const rawEvent = readEvent();
  // Un block en CUALQUIER archivo de un patch bloquea el patch entero (es un solo tool call
  // atómico — semántica correcta).
  const events = prepareEvents(rawEvent);
  const reminders = [];
  const paraLaPersona = [];
  let escribioAparte = false;
  const fullChain = integrationEntries(mode).concat(chain);

  for (const event of events) for (const h of fullChain) {
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
            // el mismo Node que corre este despachador (el del arnés, si lo lanzó así), no el del PATH
            const out = execFileSync(process.execPath, [h.path], {
              input: JSON.stringify(spawnEvent || {}),
              encoding: 'utf8',
              timeout: 15000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            if (out && out.trim()) { process.stdout.write(out); escribioAparte = true; }
          } else if (h.integration) {
            // el control de una integración que no está donde se lo busca se dice, como el que no carga
            process.stderr.write(`despachador: el control «${h.name}» de la integración ${h.integration} no está: ${h.path}\n`);
          }
        }
      } catch (e) {
        logHookError(h.name, e); // fail-open + visible (PostToolUse: nunca bloquea)
      }
      continue;
    }

    let mod;
    try {
      mod = require(h.path);
    } catch (e) {
      // el control de una integración elegida que no carga se dice: elegida y sin su control es un error a la vista
      if (h.integration) process.stderr.write(`despachador: el control «${h.name}» de la integración ${h.integration} no carga (${(e && e.code) || 'error'}): ${h.path}\n`);
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
      // (el tool call va a ser denegado de todas formas). Las firmas que validaron las reglas anteriores no se gastan.
      cerrarConsumos({ paso: false });
      process.stderr.write(result.block);
      process.exit(2);
    }
    if (result.reminder) {
      reminders.push(result.reminder);
    }
    if (result.systemMessage && mode === 'post-edit') paraLaPersona.push({ texto: String(result.systemMessage), alMostrar: result.alMostrar, name: h.name });
  }
  // ninguna regla frenó: la escritura pasa y las firmas que la dejaron pasar quedan usadas
  cerrarConsumos({ paso: true });

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

module.exports = { dispatch, prepareEvents, CHAINS, integrationEntries, abrirConsumos, cerrarConsumos };

// CLI: `node dispatch.js pre-edit|post-edit` (los entry-scripts hook-*.js lo llaman).
if (require.main === module) {
  dispatch(process.argv[2]);
}
