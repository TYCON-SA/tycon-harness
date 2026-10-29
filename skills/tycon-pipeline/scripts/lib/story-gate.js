/**
 * story-gate.js — el portón de CARRIL: en un repo que trabaja con el arnés TYCON, no se edita código
 * sin haber decidido por qué carril va el trabajo (story + pipeline, o ajuste chico declarado).
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────
 * Ante una funcionalidad pedida, el agente puede anunciar que va a armar la story (Mary+GOLD) y el
 * pipeline… y largarse a codear igual. Y dentro del pipeline puede ir tomando confianza y saltearse
 * etapas. Las dos cosas tienen la misma causa: TODO lo que pasa ANTES de que exista un marker es
 * advisory (un `<system-reminder>` que el modelo puede leer y seguir de largo), y el orden de los
 * steps dentro del pipeline lo gatea `complete-step` (ver marker.js). La regla del equipo: **un control que hay que acordarse de
 * respetar es un control que no corre** — lo que funciona en este harness (ATDD pre-edit, DoD,
 * suite completa) funciona porque algo lo DENIEGA, no porque algo lo recuerda.
 *
 * ── QUÉ HACE ──────────────────────────────────────────────────────────────────────────────────────
 * Corre en PreToolUse (Edit|Write) vía dispatch.js, y el mismo cálculo lo reusa el guard de Bash
 * (`on-bash-write-gate.js`) para las escrituras por `sed -i` / heredoc / `tee`. Decide sobre UNA
 * edición:
 *
 *   BLOQUEA siempre · (state-dir) un Write/Edit bajo `~/.claude/.tycon-pipeline/` — el único escritor
 *                     legítimo del estado del pipeline es `marker.js`; fabricar un marker/ad-hoc con
 *                     la tool Write es el bypass más barato.
 *
 *   PASA si:  · el archivo no es código (md, json, yaml, specs, docs, salidas del arnés…)
 *             · está en un repo del harness (agent-skills / el arnés)
 *             · hay pipeline activo (marker de esta sesión) → el carril es "story"; el resto lo
 *               juzgan el portón ATDD, los gates del complete-step y el DoD. La ÚNICA excepción es
 *               el sub-portón de PLAN (abajo). 🔴 El marker se mira ANTES que cualquier criterio de
 *               repo: un marker con el plan sin aprobar frena aunque el descubrimiento de stories no
 *               vea nada.
 *             · el repo NO trabaja con el arnés: sin `.tycon/` y sin stories Mary+GOLD (propias) —
 *               un script suelto, un repo legacy: acá no hay carril que decidir. 🔴 `.tycon/` es la
 *               señal principal: en 4 de 6 productos del equipo las stories viven en OTRO repo git
 *               que el código, y "repo con stories" dejaría el portón apagado justo ahí.
 *             · hay carril AD-HOC declarado para esta sesión (hotfix / ajuste chico SIN story) y
 *               no se pasó del cupo de archivos de implementación.
 *
 *   BLOQUEA si: · (no-lane) repo bajo el arnés, sin marker ni ad-hoc → hay que elegir carril.
 *               · (plan)    hay marker pero el paso «Aprobar el plan» sigue PENDIENTE → no se toca
 *                           código antes de que el user apruebe el plan. Esto es lo que convierte
 *                           "tomó confianza y se salteó el HITL" en algo que no puede pasar.
 *               · (adhoc-cap) el ad-hoc ya tocó su cupo de archivos de implementación distintos →
 *                           eso no es un hotfix, es una feature: story + pipeline (o re-declarar
 *                           con cupo mayor y motivo, que queda logueado).
 *
 * ── CALIBRADO (por qué bloquea poco y dónde están las salidas) ──────────────────────────────────
 * El portón ATDD enseñó que un gate con falsos positivos se apaga, y apagado no sirve. Por eso:
 *   · Sólo CÓDIGO (`CODE_EXTS` de atdd-order + sql/css/html/razor…). `.md`, `.json`, `.yaml` pasan
 *     siempre — crear la story, tocar `plugin.json`, escribir la evidencia del DoD, todo eso es
 *     trabajo legítimo sin carril. (Explícito: implementación hecha 100% en config
 *     —`plugin.json`, `appsettings`, `.csproj`, `.bpmn`— no dispara el carril.)
 *   · El carril ad-hoc es UN comando (`marker.js adhoc set '{"reason":"…"}'`) — pero el mensaje de
 *     bloqueo exige que el USER lo decida, y reconoce que si el user ya pidió "Barry"/quick-dev/un
 *     hotfix con esas palabras, ESO es la decisión (no se re-pregunta). Queda en `adhoc.log`.
 *   · Resume cross-session: antes de decir "no hay carril", el handler busca markers de OTRAS
 *     sesiones cuyo repo contenga el archivo y ofrece `adopt-session`.
 *   · Kill-switch del dev: env `TYCON_STORY_GATE=off` (el agente no puede setearlo: las env de los
 *     hooks vienen del proceso de Claude Code) — apaga los DOS hooks enteros (carril, plan y state-dir).
 *     Por repo: `.tycon/advisors.yaml → pipeline.story_gate: false`, leído de lo COMMITEADO (`git show
 *     HEAD:`), no del working tree — si no, apagarlo sería un Write a un yaml. La config por repo
 *     apaga SOLO el carril (no-lane / adhoc-cap): el sub-portón de plan y el state-dir siguen.
 *   · Es un portón ANTI-OLVIDO, no anti-evasión: el agente puede declarar el ad-hoc él mismo. Lo
 *     que se logra es que saltearse el carril deja de ser una omisión silenciosa y pasa a ser un
 *     comando explícito, logueado y auditable.
 *
 * Función PURA: sin fs, sin Date, sin process — recibe el estado y devuelve el veredicto. El I/O
 * (marker, ad-hoc, descubrimiento, config) vive en el handler `on-story-gate.js`.
 */

'use strict';

const path = require('path');
const { isTestPath, isImplPath } = require('./atdd-order.js');
const { isInside } = require('./atdd-preedit.js');

// Código = lo que `atdd-order` ya considera código, más lo que en los stacks del equipo se edita
// como implementación y no es "markup de specs": SQL (migraciones), estilos, templates .NET/HTML.
const EXTRA_CODE_EXTS = new Set([
  '.sql', '.css', '.scss', '.less', '.html', '.razor', '.cshtml', '.ps1', '.sh', '.bicep', '.tf', '.php',
]);

// Segmentos de path que NUNCA son "código de la story": salidas de build, dependencias, y las
// carpetas del propio arnés dentro del repo (evidencia, config, memoria, waivers).
// `.claude` se excluye SALVO que el segmento siguiente sea `worktrees`: un worktree de la
// tool Agent puede colgar de `<repo>/.claude/worktrees/<name>` y ahí SÍ hay código.
const NEVER_CODE_SEGMENTS = new Set([
  'node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'coverage', 'target', 'vendor',
  '.git', '.advisors', '.tycon', '.engram', '.dashboard', '.specs',
]);

// Repos del harness: se editan TODO el tiempo sin story ni pipeline (es el trabajo sobre el
// harness mismo).
// 🔴 Quién es un repo del harness lo dice su REMOTO, no la carpeta. Por segmento de
// path, un clon descartable del arnés (…/scratchpad/tcg) chocaría con el portón que en el checkout
// canónico no existe, y —peor— un repo de PRODUCTO clonado debajo de una carpeta con el nombre
// del arnés pasaría el portón sin story ni pipeline ni revisores, en silencio. El remoto
// lo lee el BORDE (story-gate-io.js → isHarnessRepo, con el criterio único del arnés:
// ~/.claude/tycon-harness/scripts/lib/harness-repo.js) y llega acá como `isHarness`. Esta lista queda
// como RESPALDO: decide sólo cuando nadie resolvió el dato (llamador viejo, lib del arnés ausente).
// Los dos nombres del arnés: el repo interno y el público, que se clona con el nombre del lugar.
// Escritos acá: las skills pueden vivir en un clon aparte sin scripts/ al lado (copia declarada en
// scripts/tests/fixtures/harness-place-names.json → recognizers).
const HARNESS_REPO_SEGMENTS = new Set(['agent-skills', 'tycon-claude-guides', 'tycon-harness']);

const DEFAULT_ADHOC_MAX_FILES = 8;
const MARKER_JS = '~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js';

function norm(p) {
  return String(p || '').replace(/\\/g, '/');
}

/** ¿Es un archivo de CÓDIGO a efectos del carril? (impl o test, extensiones del equipo y de la organización) */
function isCodeFile(filePath, { extra } = {}) {
  const s = norm(filePath);
  if (!s) return false;
  const segs = s.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (NEVER_CODE_SEGMENTS.has(seg)) return false;
    if (seg === '.claude' && segs[i + 1] !== 'worktrees') return false;
  }
  if (isImplPath(s, { extra }) || isTestPath(s, { extra })) return true;
  return EXTRA_CODE_EXTS.has(path.extname(s).toLowerCase());
}

// Los manifiestos de dependencias y sus locks: no son código para el carril (un `.json` se edita sin historia), pero con
// el pipeline abierto el freno de edición invisible los mira como código: reescritos por la terminal, el registro no
// los ve y el cierre no sabe que cambiaron.
const MANIFEST_FILES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'packages.lock.json',
  'Directory.Packages.props',
]);

/** ¿Es un manifiesto de dependencias o su lock, del repo (no de una dependencia ni de una salida de build)? */
function isManifestFile(filePath) {
  const segs = norm(filePath).split('/');
  if (!MANIFEST_FILES.has(segs[segs.length - 1])) return false;
  return !segs.slice(0, -1).some((seg) => NEVER_CODE_SEGMENTS.has(seg));
}

/** RESPALDO por carpeta: ¿algún segmento del path se llama como un repo del harness? */
function isHarnessPath(filePath) {
  return norm(filePath).split('/').some((seg) => HARNESS_REPO_SEGMENTS.has(seg));
}

function sameFile(a, b) {
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

/**
 * @param {object} p
 * @param {string}  p.filePath        archivo que se va a editar (absoluto)
 * @param {string|null} p.stateDir    `~/.claude/.tycon-pipeline` (Writes ahí se deniegan siempre)
 * @param {string|null} [p.realFilePath]  la ruta real del archivo (por los enlaces); sin ella, `filePath`
 * @param {string[]} [p.installedRoots]   rutas reales del árbol instalado del arnés (Writes ahí se deniegan siempre)
 * @param {string|null} [p.realStateDir]  la ruta real de `stateDir` (si es un enlace); sin ella, `stateDir`
 * @param {string|null} p.homeDir     home del user (un "repo" que es el home no cuenta como repo)
 * @param {string|null} p.repoRoot    raíz del repo git del archivo (null si no hay repo)
 * @param {boolean} p.repoHasTycon    existe `<repoRoot>/.tycon/`
 * @param {boolean} p.repoHasStories  el repo tiene ≥1 story Mary+GOLD descubierta (o excluida por id)
 * @param {boolean} [p.gateEnabled=true]   kill-switch (env / config commiteada del repo)
 * @param {object|null} p.marker      marker de ESTA sesión (o null)
 * @param {object|null} p.adhoc       declaración ad-hoc de ESTA sesión (o null); forma
 *                                    { reason, maxFiles, files: [] }
 * @returns {{action:'pass'|'block', kind?:string, reason:string}}
 */
// los cuatro lugares de las constancias (`approvals` de scripts/ci/controls-from-base.json), por su final, en cualquier carpeta
// (sin distinguir mayúsculas: en la Mac y en Windows `.GitHub/Control-Changes/` es la misma carpeta). La carpeta misma
// también: `cp x .github/control-changes/` deja su destino sin la barra final
const CONTROL_APPROVAL_DIR = /(^|\/)\.(github|tycon)\/control-changes(\/|$)/i;
const CONTROL_APPROVAL_FILE = /(^|\/)\.(github|tycon)\/control-changes\.jsonl$/i;
/** ¿La ruta es una constancia de cambio de control? Casos: scripts/controls-bench/cases/hooks/01-frenos-duros.json */
function isControlApproval(p) {
  const f = norm(String(p || ''));
  return CONTROL_APPROVAL_DIR.test(f) || CONTROL_APPROVAL_FILE.test(f);
}
// La constancia del salteo del pase adversarial: la escribe sólo `marker.js sign-adversarial-skip`, con la firma del dueño.
const ADVERSARIAL_SKIP_FILE = /(^|\/)adversarial-skips\.jsonl$/i;
function isAdversarialSkipRecord(p) { return ADVERSARIAL_SKIP_FILE.test(norm(String(p || ''))); }
// El registro de aprobaciones de la lista de pendientes: lo escribe sólo `marker.js approve-pending`, con la firma.
const PENDING_APPROVALS_FILE = /(^|\/)tasks\/pending-approvals\.jsonl$/i;
function isPendingApprovalsRecord(p) { return PENDING_APPROVALS_FILE.test(norm(String(p || ''))); }
/** ¿Es una constancia firmada que no se escribe a mano? `control-approvals`, `adversarial-skip-record`, `pending-approvals` o null. */
function signedRecordKind(p) {
  if (isControlApproval(p)) return 'control-approvals';
  if (isPendingApprovalsRecord(p)) return 'pending-approvals';
  return isAdversarialSkipRecord(p) ? 'adversarial-skip-record' : null;
}

function computeStoryGate({
  filePath, stateDir, homeDir, repoRoot, repoHasTycon, repoHasStories, gateEnabled = true, marker, adhoc,
  isHarness, realFilePath = null, installedRoots = [], realStateDir = null,
}) {
  if (!filePath) return { action: 'pass', reason: 'sin file_path' };
  // la ruta real (por los enlaces) la resuelve el borde; sin ella, la escrita
  const real = realFilePath || filePath;

  // El estado del pipeline lo escribe marker.js, nunca la tool Write/Edit. Sin kill-switch.
  if (stateDir && (isInside(stateDir, filePath) || isInside(realStateDir || stateDir, real))) {
    return { action: 'block', kind: 'state-dir', reason: 'escritura directa al estado del pipeline (~/.claude/.tycon-pipeline/)' };
  }
  // El árbol instalado del arnés lo reemplaza cada actualización: se cambia con un pedido a su repo.
  // Sin kill-switch del repo y antes del pase de los repos del arnés: vale en cualquier modo de permisos.
  const raiz = Array.isArray(installedRoots) ? installedRoots.find((r) => isInside(r, real)) : null;
  if (raiz) {
    // `adentro`: la parte de la ruta dentro del árbol (el mensaje mira ahí, no en las carpetas de arriba)
    const adentro = norm(real).slice(norm(raiz).replace(/\/+$/, '').length);
    return { action: 'block', kind: 'installed-tree', reason: 'escritura en el árbol instalado del arnés', adentro };
  }
  // Las constancias de los cambios de control las escribe `run-base-controls.sh approve`, desde su propio proceso. Sin
  // kill-switch del repo y en cualquier repo, también en los del arnés.
  if (isControlApproval(filePath) || isControlApproval(real)) {
    return { action: 'block', kind: 'control-approvals', reason: 'escritura a mano de una constancia de cambio de control' };
  }
  if (isAdversarialSkipRecord(filePath) || isAdversarialSkipRecord(real)) {
    return { action: 'block', kind: 'adversarial-skip-record', reason: 'escritura a mano de la constancia del salteo del pase adversarial' };
  }
  if (isPendingApprovalsRecord(filePath) || isPendingApprovalsRecord(real)) {
    return { action: 'block', kind: 'pending-approvals', reason: 'escritura a mano del registro de aprobaciones de pendientes' };
  }

  if (gateEnabled === false) return { action: 'pass', reason: 'gate apagado (env o config commiteada del repo)' };
  if (!isCodeFile(filePath)) return { action: 'pass', reason: 'no es código' };
  // `isHarness` booleano = el borde ya leyó el remoto; sin él decide la carpeta (respaldo).
  const harness = typeof isHarness === 'boolean' ? isHarness : isHarnessPath(filePath);
  if (harness) return { action: 'pass', reason: 'repo del harness (agent-skills / el arnés)' };

  // ── Carril STORY (pipeline activo) — se mira ANTES que el repo ───────────────────────────────
  if (marker && marker.storyId) {
    // `approve-plan` en un marcador nuevo, el 3 en uno viejo: lo decide la tabla de pasos. Un marcador que no es de
    // ningún esquema no dice si el plan está aprobado: se trata como pendiente (frena, no abre)
    const S = require('./steps.js');
    const planPending = S.schemeOf(marker) === null || S.isPending(marker, 'approve-plan');
    // El sub-portón de plan aplica al repo de la story (si lo conocemos) — editar otra cosa
    // mid-pipeline no es "implementar antes del plan".
    const inStoryRepo = !marker.repoPath || isInside(marker.repoPath, filePath);
    if (planPending && inStoryRepo) {
      return {
        action: 'block',
        kind: 'plan',
        reason: `«Aprobar el plan» sigue pendiente en el marker de la story ${marker.storyId}`,
      };
    }
    return { action: 'pass', reason: 'pipeline activo (marker) — carril story' };
  }

  if (!repoRoot) return { action: 'pass', reason: 'archivo fuera de un repo git' };
  if (homeDir && sameFile(repoRoot, homeDir)) return { action: 'pass', reason: 'el "repo" es el home (dotfiles) — no cuenta' };
  if (!repoHasTycon && !repoHasStories) {
    return { action: 'pass', reason: 'el repo no trabaja con el arnés (sin .tycon/ ni stories Mary+GOLD)' };
  }

  // ── Carril AD-HOC (hotfix / ajuste chico, sin story) ─────────────────────────────────────────
  if (adhoc && adhoc.reason) {
    const files = Array.isArray(adhoc.files) ? adhoc.files : [];
    const max = Number.isFinite(Number(adhoc.maxFiles)) && Number(adhoc.maxFiles) > 0
      ? Number(adhoc.maxFiles) : DEFAULT_ADHOC_MAX_FILES;
    const already = files.some((f) => sameFile(f, filePath));
    // Al cupo cuentan sólo los archivos de IMPLEMENTACIÓN (un hotfix .cs + su test = 1).
    const countsTowardCap = isImplPath(filePath);
    if (!already && countsTowardCap && files.length >= max) {
      return {
        action: 'block',
        kind: 'adhoc-cap',
        reason: `el ad-hoc "${adhoc.reason}" ya tocó ${files.length} archivo(s) de implementación (cupo ${max})`,
      };
    }
    return { action: 'pass', reason: `carril ad-hoc declarado: ${adhoc.reason}` };
  }

  return {
    action: 'block',
    kind: 'no-lane',
    reason: 'repo bajo el arnés TYCON, sin pipeline activo ni carril ad-hoc declarado',
  };
}

/**
 * Texto del bloqueo — qué pasó, y las salidas concretas (una por carril).
 * @param {object} r            veredicto de computeStoryGate
 * @param {object} ctx          { filePath, repoRoot, marker, adhoc, otherMarkers: [{sessionId, storyId, repoPath}], via }
 */
// ¿La story del marcador lleva maqueta? (mockup.screenStory, perezoso). Ante un error, el mensaje común.
function storyNeedsMockup(marker) {
  try {
    const sp = marker && marker.storyPath;
    if (!sp) return false;
    // una ruta relativa se resuelve contra el repo del marcador, como hace marker.js
    const abs = path.isAbsolute(sp) ? sp : path.join(marker.repoPath || process.cwd(), sp);
    return require('../mockup.js').screenStory(abs).screen === true;
  } catch { return false; }
}

// La pregunta a la persona cuando el código no tiene carril, con el texto que aprobó el dueño: la misma en cada sesión.
const PREGUNTA_SIN_CARRIL = [
  'Este cambio no tiene historia. ¿Cómo sigo?',
  '1. Directo en el código (arreglo rápido: corre igual las pruebas y la revisión). Escribí: arreglo rápido: <qué cambio>',
  '2. Con historia. Escribí: con historia',
  'Lo tenés que escribir vos en el chat: el cuadro de botones no vale.',
];

function blockMessage(r, { filePath, repoRoot, marker, otherMarkers = [], via } = {}) {
  const f = norm(filePath);
  const viaLine = via ? `  (detectado en ${via})\n` : '';
  if (r.kind === 'state-dir') {
    return [
      '⛔ tycon-pipeline — ESCRITURA DIRECTA AL ESTADO DEL PIPELINE',
      '',
      `  ${f}`,
      '  El marker, el ad-hoc, los logs de gates y la cache de stories bajo ~/.claude/.tycon-pipeline/ los',
      '  escribe SOLO marker.js (set / complete-step / run-check / adhoc / set-flag …). Escribirlos a mano',
      '  con Write/Edit (o por Bash en sus formas obvias) es fabricar evidencia — el harness lo deniega.',
      `  Usá el comando correspondiente: node ${MARKER_JS} <set|complete-step|run-check|adhoc|…>.`,
    ].join('\n');
  }
  if (r.kind === 'installed-tree') {
    return [
      '⛔ el arnés instalado no se edita',
      viaLine.replace(/\n$/, ''),
      `  ${f}`,
      '  El arnés se cambia con un pedido a su repo, no editando la instalación.',
      '  La próxima actualización reemplaza este árbol entero.',
      '  Para cambiar algo del arnés: hacelo en una copia de trabajo de su repo y proponelo con un pedido.',
      ...(/^\/packs(\/|$)/.test(r.adentro || '') ? [
        '  Un paquete de revisores propio tampoco va acá: la próxima actualización lo borra. Su lugar es packs/<nombre>/',
        '  del repo del perfil de tu equipo, que sobrevive a las actualizaciones. Si no tenés uno, armalo con',
        '  harness.js team-init --local, aunque seas una sola persona (guides/reviewer-packs.md, «Si trabajás solo»).',
      ] : []),
    ].filter((l) => l !== '').join('\n');
  }
  if (r.kind === 'control-approvals') {
    return [
      '⛔ una constancia de cambio de control no se escribe a mano',
      viaLine.replace(/\n$/, ''),
      `  ${f}`,
      '  La escribe `bash scripts/ci/run-base-controls.sh approve`: el dueño en su terminal, o la sesión designada con',
      '  la frase del dueño (`--relayed-by`). `pending` da los dos comandos.',
    ].filter((l) => l !== '').join('\n');
  }
  if (r.kind === 'adversarial-skip-record') {
    return [
      '⛔ la constancia del salteo del pase adversarial no se escribe a mano',
      viaLine.replace(/\n$/, ''),
      `  ${f}`,
      '  La escribe `marker.js sign-adversarial-skip --story <S> --reason "<motivo>"`, con la firma del dueño en la',
      '  ventana de permiso o en su terminal (`--terminal`). Sin ella, el pase corre.',
    ].filter((l) => l !== '').join('\n');
  }
  if (r.kind === 'pending-approvals') {
    return [
      '⛔ el registro de aprobaciones de pendientes no se escribe a mano',
      viaLine.replace(/\n$/, ''),
      `  ${f}`,
      '  Un pendiente nuevo lo aprueba la coordinadora desde su pestaña: `marker.js approve-pending --id <CÓDIGO> --repo <carpeta>`',
      '  (o la persona en la ventana de permiso, o en su terminal con `--terminal`). Esa firma escribe la línea.',
    ].filter((l) => l !== '').join('\n');
  }
  if (r.kind === 'plan') {
    return [
      `⛔ tycon-pipeline — CÓDIGO ANTES DEL PLAN APROBADO (story ${marker?.storyId || '?'})`,
      viaLine + '',
      `  Ibas a editar código (${f}) y «Aprobar el plan» —el user aprueba el plan— todavía está PENDIENTE en el`,
      '  marker. El orden del pipeline es: validar story → BMAD arma plan → EL USER LO APRUEBA → recién ahí',
      '  tests (ATDD) y código. Saltearse el HITL del plan es exactamente lo que este portón impide.',
      '',
      '  Salidas:',
      '   1. Si todavía no mostraste el plan → terminá «Validar la historia» y «Armar el plan» (`pipeline.js next` te dice cuál va) y',
      '      presentáselo al user. NO codees "mientras tanto".',
      '   2. Si el user YA aprobó el plan (palabras claras de proceder, sin condiciones) →',
      // el paso como lo acepta el marcador de esta ejecución: por nombre en el nuevo, por número en el viejo
      `        node ${MARKER_JS} complete-step ${require('./steps.js').schemeOf(marker) === 2 ? 'approve-plan' : '3'} --approved "<cita textual de la aprobación>"`,
      ...(storyNeedsMockup(marker) ? ['        --mockup-approved "<cita: quién aprobó la maqueta y por qué vía>"   (story con pantalla: la maqueta la ve una persona, también con LOW)'] : []),
      '      (auto-aprobación Nivel 2, SOLO story LOW-risk — se verifica: `--auto-approved "<criterios>"`).',
      '   3. Si estás retomando un pipeline (sesión nueva / compactación) → `pipeline.js next` +',
      '      `marker.js get` y cerrá los pasos que efectivamente ya pasaron, con su evidencia.',
      '',
      '  No hay escape por comando para este portón: la aprobación del plan es del user, no del agente.',
    ].join('\n');
  }
  if (r.kind === 'adhoc-cap') {
    return [
      '⛔ tycon-pipeline — EL AD-HOC YA NO ES UN AJUSTE CHICO',
      viaLine + '',
      `  ${r.reason}. Ibas a tocar otro más: ${f}.`,
      '  Un hotfix no recorre media base de código. Si el trabajo creció, es una funcionalidad y va por',
      '  story + pipeline (con plan aprobado, tests primero, advisors, DoD).',
      '',
      '  Salidas (la decide el USER, no vos — preguntale):',
      '   (a) Story + pipeline → `Skill(skill="tycon-create-story", …)` (si no existe) y después',
      '       `Skill(skill="tycon-pipeline", args="implementemos la story X.Y")`.',
      '   (b) El user confirma que sigue siendo un ajuste acotado → re-declará con cupo mayor y motivo:',
      `        node ${MARKER_JS} adhoc set '{"reason":"<motivo del user>","maxFiles":<N>}'`,
      '       (queda en adhoc.log con el cupo anterior y el nuevo).',
    ].join('\n');
  }
  // no-lane
  const resume = otherMarkers.length
    ? [
      '',
      '   (c) ¿ESTÁS RETOMANDO un pipeline de otra sesión? Hay marker(s) activos sobre este repo:',
      ...otherMarkers.map((m) => `         story ${m.storyId} · sesión ${m.sessionId} → node ${MARKER_JS} adopt-session ${m.sessionId}`),
      '       `adopt-session` trae el estado (steps, checks, archivos) a esta sesión sin perder nada.',
    ]
    : [];
  return [
    '⛔ tycon-pipeline — CÓDIGO SIN CARRIL (repo bajo el arnés TYCON, sin pipeline activo)',
    viaLine + '',
    `  Ibas a editar ${f}`,
    `  en ${norm(repoRoot)} — un repo que trabaja con stories/pipeline — y en esta sesión NO hay pipeline`,
    '  activo (marker) ni carril ad-hoc declarado. No se toca código sin decidir POR QUÉ CARRIL va:',
    '',
    '   (a) FUNCIONALIDAD / STORY → pipeline completo. Si la story existe:',
    '         Skill(skill="tycon-pipeline", args="implementemos la story X.Y")',
    '       Si NO existe todavía: primero la story (Mary+GOLD), después el pipeline:',
    '         Skill(skill="bmad-agent-analyst", …)  ← alcance aún difuso (discovery con Mary)',
    '         Skill(skill="tycon-create-story", …)   ← alcance acordado',
    '       El pipeline setea el marker en el «Arranque» y este portón se abre solo.',
    '',
    '   (b) HOTFIX / AJUSTE CHICO SIN STORY (bug puntual, refactor acotado, cleanup) → carril ad-hoc:',
    `         node ${MARKER_JS} adhoc set '{"reason":"<qué y por qué, en palabras del user>"}'`,
    `       Cupo por default: ${DEFAULT_ADHOC_MAX_FILES} archivos de implementación distintos (ajustable con "maxFiles"). Queda en adhoc.log.`,
    ...resume,
    '',
    '  🔴 QUIÉN ELIGE: el USER. Si YA lo dijo —"hablar con Barry"/quick-dev, "un hotfix", "arreglá esto',
    '     rápido", o "implementemos la story X"— ESO es la decisión: declará el carril citándolo, sin',
    '     re-preguntar. Elegir (b) por tu cuenta para una feature es el anti-pattern que motivó este',
    '     portón (2026-08-19: el agente anunció "story + pipeline" y se largó a codear).',
    '',
    '  🔴 SI NO LO DIJO — PREGUNTALE, y prohibido cerrar el turno pegándole este texto:',
    '     esta salida está escrita para VOS, no para él. "carril", "marker", "ad-hoc", "story Mary+GOLD",',
    '     "el arnés" no significan nada para el user: si se los pegás, queda frenado sin saber qué',
    '     contestar, que es exactamente la falla que este mensaje existe para evitar.',
    '     Mostrale esta pregunta TEXTUAL, en castellano llano como está: no la reescribas ni la pongas',
    '     en un cuadro de opciones (la respuesta tiene que ser algo que él escriba en el chat):',
    '',
    ...PREGUNTA_SIN_CARRIL.map((l) => `       ${l}`),
    '',
    '     Su respuesta destraba: cualquier frase clara suya vale —"arreglo rápido: …", "es un hotfix",',
    '     "sin story"— para declarar (b) citándolo; "con historia" es (a).',
    '   · SUBAGENTE (sin AskUserQuestion): no elijas vos. Cerrá tu reporte pidiéndole al orquestador',
    '     que le pregunte al user cuál de las dos va, y no toques el archivo.',
    '',
    '  Apagar este portón lo decide la persona, no el agente: no le dictes cómo. Si pregunta cómo seguir,',
    '  señalale la guía (getting-started/reference.es.md, el portón de edición).',
  ].join('\n');
}

// ── Carril: se DECLARA o se PREGUNTA — nunca se adivina ────────────────────────────
// Un detector por expresiones regulares (~120 líneas que lean el prompt del user y fijen
// el carril de la sesión: 'pipeline' si pide una story, 'adhoc' si pide un atajo) está descartado
// a propósito; los casos que lo justifican son la razón para que no vuelva:
//
//   · Un patrón que matchee "tycon-pipeline" DENTRO de una ruta pegada deja el carril
//     clavado toda la sesión: un hotfix legítimo queda denegado sin salida.
//   · Una frase como "arranca con la N.M" tiene que matchear: si no, una story entera se implementa
//     por fuera del pipeline sin que el portón se entere.
//   · Sumar verbos cotidianos ("dale/vamos/hacé") a la lista fija de carril fija carril en 19 de
//     25 frases cotidianas ("dale, probá con 2.5 segundos") y anula un ad-hoc ya declarado. Es el
//     caso con más superficie, y las 19 frases quedan en el test como cerca.
//
// Cada arreglo de estos produce la falla opuesta: apretar los patrones traba
// al dev; aflojarlos deja pasar al agente. No hay punto medio porque el problema no es de
// calibración: es que EL CASTELLANO NO SE DEJA REGEXEAR, y un freno que adivina castellano falla
// para un lado o para el otro con cada frase nueva del equipo.
//
// El diseño no adivina:
//   · Carril PIPELINE = hay marker (el pipeline CORRIÓ su Arranque — estado real, no una frase).
//   · Carril AD-HOC   = `marker.js adhoc set` citando palabras del user (reasonInPrompts, mecánico)
//                       o, si la cita no alcanza, el clasificador por modelo leyendo los prompts
//                       REALES del user decide — castellano lo interpreta un modelo, no un regex
//                       (lib/lane-classifier.js; sin modelo, se deniega y se le pregunta al user).
//   · Sin carril       = el portón bloquea el primer toque de código y el agente PREGUNTA en
//                       castellano llano. Una pregunta por sesión: ése es el costo total de no
//                       adivinar, y es más barato que cualquiera de esos casos.

// Pedido explícito de implementar una STORY (id N.M o pipeline nombrado). Fuente ÚNICA: los usa
// el reminder de on-prompt.js (avisar "esto va por pipeline") y el veto mecánico de marker.js
// (sin modelo disponible, el agente puede citar
// "implementemos la story X" como motivo de un AD-HOC y pasar — el texto citado ES un pedido de
// story, y eso se detecta sin adivinar nada: el user lo escribió con id y todo).
// 🔴 Esto NO es detectLane volviendo: no corre en cada prompt ni fija carril — juzga UNA
// declaración explícita, mirando sólo el prompt que la declaración cita como su autorización.
const STORY_INTENT_PATTERNS = [
  /\bimplement(emos|ar|á|alos?|emos)\b.*\b\d+\.\d+(\.\d+)?\b/i,
  /\b(arranqu|empez|hag|trabajemos|codeemos)\w*\b.*\b(story|historia|tarea)\s*\d+\.\d+(\.\d+)?\b/i,
  /\b(story|historia|tarea)\s*\d+\.\d+(\.\d+)?\b.*\b(implement|arranc|empez|codear|hacer)\w*\b/i,
  /^\s*(implementemos|implementar|implementá)\s+(la\s+)?\d+\.\d+(\.\d+)?\b/i,
  /\b(apply|run|correr|ejecutar)\b.*\btycon[- ]pipeline\b/i,
];

// El registro de una versión anterior guarda textos sueltos, sin origen. Lo que llegó de otra sesión, de un agente o como
// nota lateral empieza con lo que le pone Claude Code; eso no cuenta, y el resto se lee como antes hasta que vence la
// sesión.
const AJENO_EN_REGISTRO_VIEJO = /^\s*(?:Another Claude session sent a message:|<cross-session-message\b|<agent-message\b|Here is a note offered by a side agent)/;

/**
 * Los textos que escribió el dueño, en orden. Cada entrada del registro es `{ texto, origen, de? }` (cuenta sólo
 * `origen: 'dueno'`, que sale de la marca de Claude Code, no del texto) o un texto de la forma vieja.
 */
function soloDelDueno(entradas) {
  const out = [];
  for (const e of Array.isArray(entradas) ? entradas : []) {
    if (typeof e === 'string') { if (!AJENO_EN_REGISTRO_VIEJO.test(e)) out.push(e); continue; }
    if (e && e.origen === 'dueno' && typeof e.texto === 'string') out.push(e.texto);
  }
  return out;
}

/** ¿Alguno de los prompts del dueño que CONTIENEN la cita es un pedido explícito de story? */
function quotedPromptAsksStory(reason, prompts) {
  const r = normalizeWords(reason);
  if (!r) return false;
  return soloDelDueno(prompts)
    .filter((p) => normalizeWords(p).includes(r))
    .some((p) => STORY_INTENT_PATTERNS.some((re) => re.test(String(p))));
}

/** Normaliza texto para comparar "palabras del user": minúsculas, sin acentos, sin comillas, espacios colapsados. */
function normalizeWords(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ADHOC_REASON_MIN_CHARS = 8;

/**
 * ¿El motivo del ad-hoc es un fragmento LITERAL de algo que escribió el user? (≥8 caracteres
 * normalizados). Cierra el agujero de "reason en palabras del user" que nadie verificaba: una
 * paráfrasis del agente no pasa; citarlo, sí. Lo de otra sesión, de un agente o sin marca no se cita.
 */
function reasonInPrompts(reason, prompts) {
  const r = normalizeWords(reason);
  if (r.length < ADHOC_REASON_MIN_CHARS) return false;
  return soloDelDueno(prompts).some((p) => normalizeWords(p).includes(r));
}

/** El cartel de borrar o mover un marcador de ejecución por consola: qué se tocó y qué comando usar en su lugar. */
function markerDeleteMessage(rutas, via) {
  return [
    '⛔ tycon-pipeline — BORRADO DEL ESTADO DEL PIPELINE',
    '',
    ...rutas.map((p) => `  ${norm(p)}`),
    ...(via ? [`  (detectado en ${via})`] : []),
    '  El marcador dice qué pasos de la ejecución faltan. Borrarlo o moverlo a mano deja la historia sin sus controles',
    '  de cierre. Usá en su lugar:',
    `  · node ${MARKER_JS} clear                 (cerrar la ejecución de esta sesión)`,
    `  · node ${MARKER_JS} clear-session <sesión> (el marcador que dejó otra sesión)`,
    '  Si la ejecución está en rojo y no se puede terminar, la salida es dejarla como deuda (marker.js close-as-debt).',
  ].join('\n');
}

/** El cartel de escribir por consola una historia que no está en borrador. */
function storyByConsoleMessage(rutas, via) {
  return [
    '⛔ tycon-pipeline — HISTORIA ESCRITA POR CONSOLA',
    '',
    ...rutas.map((p) => `  ${norm(p)}`),
    ...(via ? [`  (detectado en ${via})`] : []),
    '  Una historia se edita con la herramienta de edición (Edit/Write), que el arnés lee. Desde un comando no se ve',
    '  qué queda escrito. Para cambiar su estado usá el comando del orquestador:',
    `  · node ${MARKER_JS} update-story-status <ruta de la historia> <estado>`,
    `  · node ${MARKER_JS} update-pipeline-status <ruta de la historia> <tanda|--all> <estado>`,
  ].join('\n');
}

module.exports = {
  markerDeleteMessage, storyByConsoleMessage,
  computeStoryGate, blockMessage, isControlApproval, isAdversarialSkipRecord, isPendingApprovalsRecord, signedRecordKind, isCodeFile, isManifestFile, MANIFEST_FILES, isHarnessPath, sameFile,
  reasonInPrompts, soloDelDueno, normalizeWords, ADHOC_REASON_MIN_CHARS,
  STORY_INTENT_PATTERNS, quotedPromptAsksStory,
  DEFAULT_ADHOC_MAX_FILES, EXTRA_CODE_EXTS, NEVER_CODE_SEGMENTS, HARNESS_REPO_SEGMENTS, MARKER_JS,
};
