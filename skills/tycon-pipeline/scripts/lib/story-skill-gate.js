/**
 * story-skill-gate.js — el freno que impide CREAR una story Mary+GOLD a mano, sin pasar por el
 * skill que la crea (`tycon-create-story` y familia). Lógica PURA: sin fs, sin Date, sin process.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────
 * Un agente puede escribir la story completa con un
 * heredoc de Bash (`cat > specs/story-as1-….md <<'STORYEOF'`), siguiendo `story-format.md` de
 * memoria, sin que nadie avise. Esas stories quedan
 * BIEN FORMADAS: pasan el lint de frontmatter y el validator no les encuentra un CRITICAL. O sea que
 * el resultado se ve igual y por eso ninguna capa existente lo nota. Lo que se pierde al saltear
 * el skill no es el formato, es el PROCESO: el análisis de artefactos, la inteligencia de la story
 * previa y, sobre todo, el checklist de validación en contexto fresco (`checklist.md` del skill),
 * que existe justamente para atrapar lo que el que escribió la story no puede ver.
 *
 * El patrón de falla es específico y conviene tenerlo escrito: **cuanto MÁS contexto tiene ya
 * relevado el agente, más "sobra" el skill** — el relevamiento previo da la sensación de que sólo
 * falta tipear el archivo. Es exactamente al revés: ese contexto es el input ideal del skill. Por
 * eso un aviso pasivo no lo frena: en ese momento no se siente como un salteo sino como eficiencia.
 * La regla del equipo es la de siempre: un control que hay que acordarse de respetar es un control
 * que no corre — así que esto DENIEGA, como el portón de carril y el gate de ATDD.
 *
 * ── DISEÑO A: la constancia la escribe el HARNESS, no el agente ─────────────────────────────────
 * Claude Code SÍ emite
 * PreToolUse/PostToolUse para la tool `Skill`, con `tool_name: "Skill"` y `tool_input.skill` = el
 * nombre del skill (se ve en el grabador de instincts, `~/.claude/tycon-observations`,
 * un PostToolUse sin matcher). Entonces `on-skill-invoke.js`
 * (PostToolUse, matcher `Skill`) deja una MARCA por sesión cuando el skill invocado es uno de los
 * que crean stories, y este freno exige esa marca para dejar nacer un `.md` con identidad de story.
 * El agente no puede fabricar la marca con Write/heredoc: vive bajo `~/.claude/.tycon-pipeline/`,
 * que el portón de carril bloquea en las dos puertas (state-dir). Las formas legítimas de obtenerla
 * son la tool Skill, el slash del user (`/tycon-create-story` — lo ve `on-prompt.js`, porque el slash
 * NO pasa por la tool) y el escape explícito (`marker.js story-skill-bypass "<razón>"`, `bypass.log`).
 * Sí se puede fabricar alimentando a mano el hook por stdin —esto es anti-olvido, no anti-evasión—;
 * por eso TODA marca deja una línea `mark-written` en gates.log con su `via`: se puede auditar.
 *
 * ── CALIBRADO (dónde NO frena — cada punto es un falso positivo que mataría el control) ─────────
 *   1. EDITAR ≠ CREAR. El pipeline edita stories existentes todo el tiempo (status, Change Log,
 *      follow-ups, Dev Agent Record, `ado_work_item:`). El discriminante es que el archivo NO exista
 *      en disco. Un `>>` a una story existente también pasa.
 *   2. Sólo lo que DECLARA identidad de story (`story:` en el frontmatter cerrado — el criterio
 *      canónico de `lib/story-discovery.js`, jamás la ruta). Un PRD, un épico, una guía: pasan.
 *   3. Sólo ids con FORMA DE TRABAJO del repo (`isWorkStoryId` + `stories.id_pattern` del repo, la
 *      versión para frenos que une lo commiteado y la carpeta). El material de evals que LUCE como
 *      story (`EV-1`) pasa — y queda medido como `unknown` en gates.log, no en silencio.
 *   4. Sólo en repos bajo el arnés (`.tycon/` o stories Mary+GOLD descubiertas). Un repo suelto
 *      pasa (medido como `unknown`). Los repos del propio harness pasan siempre (plantillas, casos).
 *   5. La marca vence: TTL de 2 horas por default (`TYCON_STORY_SKILL_MARK_TTL_MIN`). Es largo a
 *      propósito — un `tycon-create-story` con elicitación puede durar más de media hora, y una
 *      marca que vence a mitad del flujo frena la story legítima. El costo de una marca vieja es
 *      chico: habilita una story a mano dentro de la MISMA sesión que ya invocó el skill hace <2h.
 *   6. Escapes: `marker.js story-skill-bypass "<razón en palabras del user>"` (auditado en
 *      bypass.log) · env `TYCON_STORY_SKILL_GATE=off` (el dev; el agente no setea env de hooks) ·
 *      `.tycon/advisors.yaml → pipeline.story_skill_gate: false` COMMITEADO (misma regla que el
 *      portón de carril: leído con `git show HEAD:`, nunca del working tree).
 *
 * ── LÍMITES CONOCIDOS Y ASUMIDOS ────────────────────────────────────────────────────────────────
 * · Creación en DOS pasos (esqueleto sin frontmatter + Write completo; `touch` y después heredoc;
 *   frontmatter sin cerrar y un Edit que lo cierra) esquiva el discriminante "no existe en disco".
 *   Es consecuencia directa de "editar ≠ crear" y se acepta: cerrar eso obligaría a juzgar cada Edit
 *   de cada `.md`, o sea el ruido que apaga un control. Igual que el resto del arnés: anti-olvido.
 * · Por Bash, sin contenido legible (`cp`/`mv`/`tee` de un pipe), se decide por NOMBRE (`story-*.md`,
 *   `stories/*.md`): puede frenar un índice o una nota con ese nombre. El mensaje lo dice ("por el
 *   nombre parece") y el log lo distingue (`*-by-name`) para medir cuánto ruido mete. Renombrar o
 *   copiar una story EXISTENTE (`mv a.md b.md`) pasa y queda medido (`unknown-rename`).
 * · Codex:
 * Codex no expone la invocación de skills como tool call (un skill se carga por mención, sin evento
 * de hook), así que del lado Codex NO hay constancia mecánica posible. Frenar ahí obligaría al
 * bypass en CADA story legítima — el comando se volvería rutina y el log, ruido. Decisión: bajo
 * Codex el freno NO bloquea y deja la línea `unknown` en gates.log (asimetría DECLARADA en
 * `adapters/codex/hooks.json`). Si algún día Codex emite el evento, se saca la excepción y listo.
 *
 * ── ANTI-OLVIDO, NO ANTI-EVASIÓN ────────────────────────────────────────────────────────────────
 * El agente puede correr el bypass él mismo. Lo que cambia es que saltear el skill deja de ser una
 * omisión silenciosa —"sólo falta tipear el archivo"— y pasa a ser un comando explícito, logueado,
 * con una razón que tiene que venir del user. Mismo contrato que el carril ad-hoc.
 */

'use strict';

const path = require('path');

/** Skills cuya invocación HABILITA crear stories en la sesión (la familia que las crea). */
const CREATOR_SKILLS = Object.freeze([
  'tycon-create-story',
  'bmad-create-epics-and-stories',
  'bmad-correct-course',
  'gds-create-story',
  'gds-create-epics-and-stories',
]);

const DEFAULT_TTL_MIN = 120;
const MARKER_JS = '~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js';

/**
 * ¿Este skill HABILITA crear stories?
 *
 * 🔴 Acepta el nombre PELADO y el CALIFICADO por directorio. Cuando un repo tiene
 * skills en `<repo>/.claude/skills/`, Claude Code expone variantes `<dir>:<skill>` —p. ej.
 * `Backend:tycon-create-story`— y su propio system-reminder RECOMIENDA usar la variante
 * cuando los archivos están bajo ese subdirectorio. Con una comparación exacta, esa forma
 * —la que el sistema sugiere— dejaría ciego al control: el skill corre, `on-skill-invoke.js` no
 * escribe la marca, y el portón de story-a-mano sigue cerrado sin explicar por qué.
 *
 * Caso: se invoca `Backend:tycon-create-story`, el skill corre entero, y la escritura se deniega igual;
 * habría que repetir toda la invocación con el nombre pelado para que apareciera la marca.
 *
 * Sólo se recorta el prefijo hasta el ÚLTIMO `:`, y el resto tiene que ser un creator exacto: así
 * `Backend:tycon-pipeline` sigue siendo `false` y `tycon-create-story:algo-mas` también
 * (el sufijo es lo que manda, no el hecho de contener el nombre).
 */
function isCreatorSkill(name) {
  const limpio = String(name || '').trim();
  if (!limpio) return false;
  const sinPrefijo = limpio.slice(limpio.lastIndexOf(':') + 1);
  return CREATOR_SKILLS.includes(sinPrefijo);
}

/** TTL efectivo en ms: env del dev (minutos) o el default. Un valor inválido cae al default. */
function ttlMsFrom(envValue) {
  const n = Number(envValue);
  const min = Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MIN;
  return min * 60 * 1000;
}

/**
 * ¿La marca sigue vigente? `mark` = { skill, at (ISO), … } o null. Una marca sin `at` legible no
 * vale (mejor frenar y que se vea, que aceptar una marca corrupta como salvoconducto).
 */
function markState(mark, nowMs, ttlMs) {
  if (!mark || typeof mark !== 'object') return 'none';
  const t = Date.parse(mark.at);
  if (!Number.isFinite(t)) return 'none';
  return nowMs - t <= ttlMs ? 'valid' : 'expired';
}

/**
 * Veredicto del freno. PURA — recibe todo lo que necesita y devuelve la decisión.
 *
 * @param {object} a
 * @param {string}  a.filePath          archivo que el tool call quiere escribir
 * @param {boolean} a.existsOnDisk      ya existe → editar, no crear
 * @param {boolean} a.isStoryCandidate  el contenido (o, por Bash, el nombre) declara identidad de story
 * @param {boolean} a.isHarness         vive en un repo del propio harness
 * @param {boolean} a.repoUnderHarness  el repo trabaja con el arnés (.tycon/ o stories descubiertas)
 * @param {boolean} a.idIsWork          el id declarado tiene forma de trabajo del repo (null = no se pudo leer → se asume true)
 * @param {object|null} a.mark          marca de la sesión ({skill, at}) o null
 * @param {number}  a.nowMs
 * @param {number}  a.ttlMs
 * @param {boolean} [a.gateEnabled]     config commiteada del repo (default true)
 * @param {boolean} [a.isCodex]         herramienta sin evento de skill → no se frena (unknown)
 * @returns {{action:'pass'|'block', kind:string, reason:string}}
 */
function computeStorySkillGate({
  filePath, existsOnDisk, isStoryCandidate, isHarness, repoUnderHarness, idIsWork,
  mark, nowMs, ttlMs, gateEnabled = true, isCodex = false,
}) {
  if (!isStoryCandidate) return { action: 'pass', kind: 'not-story', reason: 'no declara identidad de story' };
  if (existsOnDisk) return { action: 'pass', kind: 'exists', reason: 'la story ya existe — editar no es crear' };
  if (isHarness) return { action: 'pass', kind: 'harness', reason: 'repo del propio harness (plantillas, casos del banco)' };
  if (!gateEnabled) return { action: 'pass', kind: 'repo-off', reason: 'apagado por .tycon/advisors.yaml (pipeline.story_skill_gate: false, commiteado)' };
  if (repoUnderHarness === false) return { action: 'pass', kind: 'unknown-no-harness', reason: 'el repo no trabaja con el arnés (sin .tycon/ ni stories) — no se frena, queda medido' };
  if (idIsWork === false) return { action: 'pass', kind: 'unknown-material', reason: 'el id declarado no tiene forma de trabajo del repo (material tipo evals) — no se frena, queda medido' };

  // La marca vigente se mira ANTES de la excepción de Codex: un bypass declarado con marker.js (que
  // en Codex también corre) tiene que quedar auditado como bypass, no diluido en `unknown-codex`.
  const st = markState(mark, nowMs, ttlMs);
  if (st === 'valid') {
    return mark.skill === 'bypass'
      ? { action: 'pass', kind: 'bypass', reason: `bypass declarado: ${mark.reason || '(sin razón)'}` }
      : { action: 'pass', kind: 'mark', reason: `constancia de ${mark.skill} en esta sesión` };
  }
  if (isCodex) return { action: 'pass', kind: 'unknown-codex', reason: 'Codex no expone la invocación de skills como tool call — sin constancia mecánica posible, no se frena, queda medido' };
  if (st === 'expired') {
    return { action: 'block', kind: 'mark-expired', reason: `la constancia de ${mark.skill} venció (TTL ${Math.round(ttlMs / 60000)} min)` };
  }
  return { action: 'block', kind: 'no-skill', reason: `story nueva (${path.basename(String(filePath || ''))}) sin constancia de tycon-create-story en esta sesión` };
}

/** Texto del bloqueo: qué pasó, por qué frena, y las salidas concretas. */
function blockMessage(r, { filePath, via, ttlMs, byName = false } = {}) {
  const rel = path.basename(String(filePath || ''));
  const cause = /^mark-expired/.test(r.kind)
    ? `la constancia del skill en esta sesión VENCIÓ (TTL ${Math.round((ttlMs || 0) / 60000) || DEFAULT_TTL_MIN} min)`
    : 'en esta sesión NO consta que se haya invocado el skill que crea stories';
  const what = byName
    ? `por el NOMBRE parece una story Mary+GOLD NUEVA (no pude leer su contenido desde este comando)`
    : 'es una story Mary+GOLD NUEVA';
  return [
    `🔴 STORY A MANO — escritura DENEGADA: "${rel}" ${what} y ${cause}.`,
    via ? `   (vía ${via})` : '',
    byName ? '   Si NO es una story (un índice, una nota): escribila con la tool Write, o renombrala con `git mv` — el nombre es lo único que este comando deja ver.' : '',
    '',
    '   Por qué frena: dos veces en dos días (AS-1 y PERF-1, Totora 2026-08-28/30) la story se escribió',
    '   con un heredoc siguiendo story-format.md de memoria. Quedó bien formada — y sin el análisis de',
    '   artefactos, la inteligencia de la story previa ni el checklist de validación en contexto fresco',
    '   que el skill hace. El contexto que ya relevaste NO reemplaza al skill: es su input ideal.',
    '',
    '   Qué hacer AHORA:',
    '',
    '   (a) Invocá el skill y dejá que ÉL escriba el archivo:  Skill → tycon-create-story',
    '       (Bob/SM "CS", bmad-create-epics-and-stories o bmad-correct-course también valen).',
    '       Pasale todo lo que ya relevaste — anclas, mediciones, decisiones del dev — como contexto.',
    '       La constancia la deja el harness solo (hook PostToolUse sobre la tool Skill): el portón se abre.',
    '',
    '   (b) Si el USER decidió explícitamente que esta story se escriba a mano (y con esas palabras),',
    '       declaralo — queda en bypass.log con la razón, no es un skip silencioso:',
    '',
    `         node ${MARKER_JS} story-skill-bypass "<la razón, en palabras del user>"`,
    '',
    '   Kill-switch del dev: TYCON_STORY_SKILL_GATE=off · por repo (commiteado): .tycon/advisors.yaml →',
    '   pipeline.story_skill_gate: false.',
  ].filter((l) => l !== '').join('\n');
}

module.exports = {
  CREATOR_SKILLS, DEFAULT_TTL_MIN, MARKER_JS,
  isCreatorSkill, ttlMsFrom, markState, computeStorySkillGate, blockMessage,
};
