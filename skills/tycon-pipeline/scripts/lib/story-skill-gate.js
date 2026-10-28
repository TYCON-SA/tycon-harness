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
 * ── LA CONSTANCIA ES EL VALIDADOR, NO LA LLAMADA A LA SKILL ─────────────────────────────────────
 * Llamar a la skill no prueba que se siguieron sus pasos: un modelo abierto la invocó, no hizo nada de lo
 * que dice, escribió la historia y dijo «creada y verificada». Lo que prueba que la historia se revisó es
 * que el validador de historias corrió sobre ese archivo después de su última escritura, y eso queda en la
 * cadena de la conversación que guarda la herramienta, donde el agente no escribe (`validator-record.js`).
 * Por eso: una historia nueva sin esa constancia sólo nace en borrador (`status: draft`), y pasar un
 * borrador a cualquier otro estado la pide. El pipeline no arranca sobre un borrador, y el cierre del turno
 * insiste con la orden concreta mientras quede uno sin validar (`story-claim-check.js`).
 *
 * ── CALIBRADO (dónde NO frena — cada punto es un falso positivo que mataría el control) ─────────
 *   1. EDITAR ≠ CREAR. El pipeline edita stories existentes todo el tiempo (status, Change Log,
 *      follow-ups, Dev Agent Record, `ado_work_item:`). Una historia que existe y no está en borrador pasa
 *      siempre; un borrador se edita libre mientras no le cambien el estado.
 *   2. Sólo lo que DECLARA identidad de story (`story:` en el frontmatter cerrado — el criterio
 *      canónico de `lib/story-discovery.js`, jamás la ruta). Un PRD, un épico, una guía: pasan.
 *   3. La forma del id NO abre el portón: un id que no sigue la numeración del repo (`isWorkStoryId` +
 *      `stories.id_pattern`) se frena igual, y el mensaje lo dice. Un modelo que se saltea la skill
 *      también inventa el número; las veces que eximir esos ids dejó pasar algo, eran historias de
 *      trabajo. El material de evaluación vive en los repos del arnés (punto 4) o pasa con el escape.
 *   4. Sólo en repos bajo el arnés (`.tycon/` o stories Mary+GOLD descubiertas). Un repo suelto
 *      pasa (medido como `unknown`). Los repos del propio harness pasan siempre (plantillas, casos).
 *   5. Escapes: «autorizo story-skill-bypass» escrita por la persona en un turno suyo (`escape-ok.js`;
 *      auditado en bypass.log; `marker.js story-skill-bypass` ya no deja constancia) · env `TYCON_STORY_SKILL_GATE=off` (el dev; el agente no setea env de hooks) ·
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
 * · La constancia prueba que el validador corrió, no qué dijo: una respuesta con problemas cuenta igual.
 *   Y se busca en la conversación de la sesión que escribe: un validador de otra sesión no se ve.
 * · Codex:
 * Codex no expone la llamada a un revisor como evento ni deja leer la conversación, así que del lado
 * Codex NO hay constancia mecánica posible. Frenar ahí obligaría al escape en CADA story legítima.
 * Decisión: bajo Codex el freno NO bloquea y deja la línea `unknown-codex` en gates.log (asimetría
 * DECLARADA en `adapters/codex/hooks.json`).
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
 * El `status:` del frontmatter de un texto, o null si no lo declara. Es LA lectura del estado para el freno, el cierre
 * del turno y el arranque del pipeline: si leyeran distinto, un borrador podría pasar el freno como borrador y arrancar
 * como listo. Acepta el BOM, `---` con espacios al final, un espacio antes de `:` y un comentario `# …`. Con dos
 * renglones `status:` distintos devuelve `mixed`: no es un borrador limpio, y en disco cuenta como borrador.
 */
function statusOf(text) {
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text || '').replace(/^﻿/, ''));
  if (!fm) return null;
  const vals = [];
  for (const l of fm[1].split(/\r?\n/)) {
    const m = /^status[ \t]*:[ \t]*(.*)$/.exec(l);
    if (m) vals.push(m[1].replace(/[ \t]+#.*$/, '').trim().replace(/^["']|["']$/g, '').trim().toLowerCase());
  }
  if (!vals.length) return null;
  return vals.every((v) => v === vals[0]) ? vals[0] : 'mixed';
}

/** ¿El estado en disco es de borrador? (`mixed` también: pasarlo a otro estado pide la constancia) */
const isDraftStatus = (s) => s === 'draft' || s === 'mixed';

/**
 * Veredicto del freno. PURA — recibe todo lo que necesita y devuelve la decisión.
 *
 * Una historia nueva sin la constancia del validador nace sólo en borrador (`status: draft`); pasar un borrador a
 * cualquier otro estado pide la constancia (`record`: el validador corrió sobre ese archivo después de su última
 * escritura, `validator-record.js`). Una historia que ya existe y no está en borrador se edita siempre: el pipeline la
 * toca todo el tiempo. La llamada a la skill no abre el freno: no prueba que se siguieron sus pasos.
 *
 * @param {object} a
 * @param {string}  a.filePath          archivo que el tool call quiere escribir
 * @param {boolean} a.existsOnDisk      ya existe → editar, no crear
 * @param {string|null} a.prevStatus    el estado en disco (si existe)
 * @param {string|null} a.status        el estado que queda después de escribir (null = no se puede ver: terminal)
 * @param {boolean} a.isStoryCandidate  el contenido (o, por Bash, el nombre) declara identidad de story
 * @param {boolean} a.isHarness         vive en un repo del propio harness
 * @param {boolean} a.repoUnderHarness  el repo trabaja con el arnés (.tycon/ o stories descubiertas)
 * @param {boolean} a.idIsWork          el id declarado sigue la numeración del repo (null = no se pudo leer); sólo cambia el texto
 * @param {boolean} [a.record]          hay constancia del validador
 * @param {boolean} [a.gateEnabled]     config commiteada del repo (default true)
 * @param {boolean} [a.isCodex]         herramienta sin la conversación legible → no se frena (unknown)
 * @returns {{action:'pass'|'block', kind:string, reason:string}}
 */
function computeStorySkillGate({
  filePath, existsOnDisk, prevStatus = null, status = null, isStoryCandidate, isHarness, repoUnderHarness, idIsWork,
  record = false, gateEnabled = true, isCodex = false,
}) {
  if (!isStoryCandidate) return { action: 'pass', kind: 'not-story', reason: 'no declara identidad de story' };
  if (existsOnDisk && !isDraftStatus(prevStatus)) return { action: 'pass', kind: 'exists', reason: 'la story ya existe y no está en borrador — editar no es crear' };
  if (isHarness) return { action: 'pass', kind: 'harness', reason: 'repo del propio harness (plantillas, casos del banco)' };
  if (!gateEnabled) return { action: 'pass', kind: 'repo-off', reason: 'apagado por .tycon/advisors.yaml (pipeline.story_skill_gate: false, commiteado)' };
  if (repoUnderHarness === false) return { action: 'pass', kind: 'unknown-no-harness', reason: 'el repo no trabaja con el arnés (sin .tycon/ ni stories) — no se frena, queda medido' };
  const name = path.basename(String(filePath || ''));
  if (existsOnDisk) {
    if (status === 'draft') return { action: 'pass', kind: 'draft-edit', reason: 'editar un borrador sin cambiarle el estado' };
    if (record) return { action: 'pass', kind: 'validated', reason: 'el validador corrió sobre la historia después de su última escritura' };
    if (isCodex) return { action: 'pass', kind: 'unknown-codex', reason: 'Codex no deja leer la conversación — sin constancia posible del validador, no se frena, queda medido' };
    return {
      action: 'block', kind: 'draft-promote',
      reason: status == null
        ? `escribir sobre el borrador ${name} desde la terminal (no se ve qué cambia) sin constancia del validador`
        : `pasar el borrador ${name} a ${status} sin constancia del validador`,
    };
  }
  // Un id con otra forma que la del repo no abre el portón: un modelo que se saltea la skill también inventa el número
  // (G-1 en un repo que numera por épica); el mensaje lo dice.
  if (status === 'draft') return { action: 'pass', kind: 'new-draft', reason: 'historia nueva en borrador' };
  if (record) return { action: 'pass', kind: 'validated', reason: 'el validador corrió sobre la historia después de su última escritura' };
  if (isCodex) return { action: 'pass', kind: 'unknown-codex', reason: 'Codex no deja leer la conversación — sin constancia posible del validador, no se frena, queda medido' };
  return {
    action: 'block', kind: 'new-not-draft',
    reason: `story nueva (${name}) en ${status || 'un estado que no se ve'} sin constancia del validador` +
      (idIsWork === false ? ' (y su número no sigue la numeración de las historias del repo)' : ''),
  };
}

/** Texto del bloqueo: qué pasó, por qué frena, y la salida concreta. */
// `paso`: el pedido que se juzga no se ubicó en la conversación (escape-ok.js `cartelDelPaso`). Con `reintento`, el
// renglón todavía no estaba escrito: el cartel pide reintentar y no la frase; si no, suma el motivo.
function blockMessage(r, { filePath, via, byName = false, paso = null } = {}) {
  const rel = path.basename(String(filePath || ''));
  const promote = /^draft-promote/.test(r.kind);
  const terminal = promote && /terminal/.test(r.reason || '');
  const what = promote
    ? (terminal ? `está en borrador (status: draft) y este comando escribe sobre ella` : `está en borrador y la querés pasar a otro estado`)
    : byName
      ? 'por el NOMBRE parece una story Mary+GOLD NUEVA (no pude leer su contenido desde este comando)'
      : 'es una story Mary+GOLD NUEVA que no está en borrador';
  return [
    `🔴 HISTORIA SIN VALIDAR — escritura DENEGADA: "${rel}" ${what}, y en esta conversación no consta que el validador`,
    '   de historias (tycon-story-validator) haya corrido sobre ese archivo después de su última escritura.',
    via ? `   (vía ${via})` : '',
    /numeración/.test(r.reason || '') ? '   Además, su número no sigue la numeración de las historias del repo: el que corresponde lo elige la skill.' : '',
    byName ? '   Si NO es una story (un índice, una nota): escribila con la tool Write, o renombrala con `git mv` — el nombre es lo único que este comando deja ver.' : '',
    '',
    '   Por qué frena: una historia escrita sin los pasos de la skill (tycon-create-story) llegaba al pipeline como si',
    '   estuviera revisada, y el agente decía «creada y verificada» sin que el validador la hubiera visto.',
    '',
    '   Qué hacer AHORA:',
    '',
    promote
      ? (terminal ? '   (a) Editala con la tool Edit, no por la terminal. Para pasarla a ready-for-dev, primero corré el validador.'
        : '   (a) Corré el validador de historias (tycon-story-validator) sobre ese archivo y, si pasa, volvé a hacer este cambio.')
      : '   (a) Escribila con `status: draft`. Después corré el validador de historias (tycon-story-validator) sobre ese\n' +
        '       archivo y, si pasa, pasala a ready-for-dev. La skill tycon-create-story hace esos pasos en orden.',
    '',
    ...(paso && paso.reintento ? [`   (b) ${paso.cartel}`] : [
      '   (b) Saltear el validador lo decide la persona, no vos. Si te lo pide, tiene que escribir en su mensaje',
      '       «autorizo story-skill-bypass»; con esa frase suya, este freno la deja pasar solo y lo anota.',
      paso && paso.cartel ? `   ${paso.cartel}` : '',
    ]),
  ].filter((l) => l !== '').join('\n');
}

module.exports = {
  CREATOR_SKILLS, DEFAULT_TTL_MIN, MARKER_JS,
  isCreatorSkill, ttlMsFrom, markState, statusOf, isDraftStatus, computeStorySkillGate, blockMessage,
};
