#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse hook (matcher: Task) — log de invocaciones de subagents
 * + freno advisory sobre los spawns AD-HOC de la primera mitad del pipeline.
 *
 * CF-2 (auditoría fresca 2026-05-21): el determinismo de H17 §4 era de SELECCIÓN
 * (pipeline.js computa el set), pero `check-count` confiaba en el `--ran` que el LLM
 * REDACTA — el LLM podía pasar el set esperado sin haberlo corrido. Este hook registra
 * cada subagent realmente spawneado, y `pipeline.js check-count` lo lee como ground-truth
 * en vez de confiar en el self-report. Así el conteo deja de ser "disciplina con asistencia".
 *
 * GOBIERNO DE SPAWNS AD-HOC (2026-07-28) — medición sobre 58 runs / 795 spawns:
 *   - El subagent más spawneado del pipeline NO es un advisor: es `general-purpose`,
 *     156 de 795 (20%). Sumando `Explore` (30) son 186 — el 23% del total.
 *   - 133 de esos 156 ocurren ANTES del `step5-start`, o sea en los Steps 0-4, donde
 *     NO hay ninguna de las reglas de costo del pipeline (ni context curado, ni
 *     model hints, ni mech-check, ni batch_rule).
 *   - Un spawn cuesta ~60.000-100.000 tokens ANTES de leer nada (baseline 2026-07-28):
 *     el más barato medido consumió 67K con un contexto de apenas 6K. El contexto es
 *     como mucho un cuarto del costo — la palanca es abrir MENOS agentes, no alimentarlos
 *     mejor.
 * Por eso este hook, además de loguear, AVISA (nunca bloquea) cuando:
 *   (a) se abre un agente de exploración en un repo que tiene índice de código local
 *       (`.codegraph/`), que contesta lo mismo por ~0 tokens;
 *   (b) se acumulan más de N agentes ad-hoc en la fase actual;
 *   (c) el spawn no declara `model:` — para buscar alcanza uno barato.
 * Es advisory a propósito: la lección del run 9.4 es que las reglas de costo mandatorias
 * mal calibradas degradan el sistema. Acá se mide y se avisa; decide el dev.
 *
 * Append-only, per-session: ~/.claude/.tycon-pipeline/advisor-runs/<sessionId>.jsonl
 * Cada línea: {"ts": <iso>, "advisor": <subagent_type>, "model": <model|null>,
 *              "repo": <raíz del repo|null>, "story": <id de story|null>}.
 * El repo y la story los resuelve lib/repo-attrib.js (marker de la sesión → raíz de git del cwd).
 * Lo lee `pipeline.js advisor-runs`, que contesta "¿corrieron los revisores de la story X?".
 * Exit 0 SIEMPRE (advisory — nunca bloquea un spawn).
 *
 * Env:
 *   TYCON_ADHOC_SPAWN_WARN=<n>   umbral de aviso por fase (default 5; 0 = desactiva)
 *   TYCON_SPAWN_GOVERNANCE=0     apaga los avisos (el log sigue igual)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
const { sessionIdFileKey } = require('./lib/session-id.js');
const { attribution } = require('./lib/repo-attrib.js');

// Subagents de exploración libre: no tienen contexto curado ni superficie declarada.
const ADHOC = new Set(['general-purpose', 'Explore', 'Plan', 'claude']);

/**
 * Escribe el registro de autoría (`review-roster.json`) en el run dir de la story.
 *
 * 🔴 Best-effort PERO con constancia de falla: si no se pudo escribir, queda un evento
 * `roster-write-failed` en el ledger. "Salió limpio sin dejar constancia" es la falla que el banco
 * de controles busca — un roster que no se escribió Y no dejó rastro se leería igual que uno que sí.
 * Nunca rompe el spawn (el freno real está en el portón, no acá).
 */
function escribirRoster({ logPath, repo, story, sessionId, transcriptPath }) {
  if (process.env.TYCON_REVIEW_ROSTER === '0') return;
  if (!repo || !story) return; // sin marker no hay run dir al que pertenecer
  let motivo = null;
  try {
    const roster = require('./lib/review-roster.js');
    const { resolveRunDir } = require('./pipeline.js');
    // Con la ruta de la story: si su número se repite en el repo, la carpeta lleva la clave (story 1.17.1). La
    // misma ruta sirve después para proyectar la corrida al repo de la story.
    const m = require('./lib/repo-attrib.js').readMarkerFile(sessionId);
    const storyPath = m && m.storyPath ? (path.isAbsolute(m.storyPath) ? m.storyPath : path.join(m.repoPath || repo, m.storyPath)) : null;
    const runDir = resolveRunDir(repo, String(story), true, storyPath || undefined);
    if (!runDir) {
      const k = storyPath ? require('./lib/evidence-key.js').keyInfoOr(storyPath, String(story)) : null;
      motivo = k && k.error ? `run dir no resuelto: sin clave de la story (${String(k.error).slice(0, 160)})` : 'run dir no resuelto';
    } else {
      const { parseJsonl } = require('./lib/advisor-ledger.js');
      const lines = parseJsonl(fs.readFileSync(logPath, 'utf8'));
      let headSha = null;
      try {
        headSha = require('child_process')
          .execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 5000 })
          .trim() || null;
      } catch { /* repo sin commits todavía */ }
      // El sello del ÁRBOL que los revisores están mirando. `headSha` sólo dice sobre qué commit
      // se apoya: la implementación se commitea DESPUÉS de la revisión, así que por sí solo no
      // sirve para auditar qué se revisó (medido en la story 2.3: de los 25 archivos que tocó,
      // cero coincidían con ese árbol). Medido acá: ~130 ms por spawn en repos reales, y null
      // limpio cuando no se puede — nunca un sello inventado.
      const treeSha = roster.treeShaDe(repo);
      roster.write(runDir, {
        lines,
        story: String(story),
        sessionId,
        headSha,
        treeSha,
        implementerModel: roster.modelFromTranscript(transcriptPath),
      });
      // Story en OTRO repo (URUTAU: stories en Project, código en Backend/VidrieraWeb) → el portón de
      // CI del repo de la story exige esta constancia AHÍ (2026-09-05). Se proyectan sólo roster y
      // findings; una copia que falla deja constancia en el ledger como cualquier otra falla.
      // Un fallo acá NO se disfraza de `roster-write-failed` (el roster SÍ se escribió): evento propio.
      let motivoProyeccion = null;
      try {
        const { projectRunToStoryRepo } = require('./pipeline.js');
        const pr = projectRunToStoryRepo(runDir, storyPath);
        if (pr.reason && pr.reason.startsWith('no se pudo')) motivoProyeccion = pr.reason;
      } catch (e) { motivoProyeccion = String(e.message || e).slice(0, 200); }
      if (motivoProyeccion) {
        try {
          fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), event: 'roster-projection-failed', motivo: motivoProyeccion }) + '\n', 'utf8');
        } catch { /* el stderr es lo último que queda */ }
        process.stderr.write(`⚠️ tycon-pipeline: el registro de autoría no se pudo proyectar al repo de la story (${motivoProyeccion}).\n`);
      }
    }
  } catch (e) {
    motivo = (e && e.message) ? String(e.message).slice(0, 200) : 'error desconocido';
  }
  if (!motivo) return;
  try {
    fs.appendFileSync(
      logPath,
      JSON.stringify({ ts: new Date().toISOString(), event: 'roster-write-failed', motivo }) + '\n',
      'utf8',
    );
  } catch { /* si tampoco se puede escribir el ledger, el stderr es lo último que queda */ }
  process.stderr.write(
    `⚠️ tycon-pipeline: no se pudo escribir el registro de autoría (${motivo}).\n` +
    '   El portón de CI lo va a pedir al cerrar la story: revisá el run dir antes de commitear.\n',
  );
}

// Blanco declarado de una retrospectiva, leído del prompt del spawn. Formato que emite el propio
// aviso del freno: "Post-merge retrospective: repo <ruta absoluta>, merge <sha> …". Se acepta
// cualquier orden y se toleran comillas; si el prompt no lo dice, se devuelve null y el freno cae a
// su comportamiento anterior (nunca inventa un repo: un blanco inventado es peor que ninguno).
function retroTarget(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  const mRepo = prompt.match(/\brepo[:=\s]+["'`]?((?:[A-Za-z]:[\\/]|[\\/])[^\s,;"'`)]+)/i);
  const mSha = prompt.match(/\bmerge[:=\s]+["'`]?([0-9a-f]{7,40})\b/i);
  const repo = mRepo ? mRepo[1].replace(/[.,;:]+$/, '') : null;
  return (repo || mSha) ? { repo, sha: mSha ? mSha[1] : null } : null;
}

function main() {
  let event;
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : null;
  } catch {
    return;
  }
  // CF-2 re-check: el spawn de subagents se llama `Agent` (VSCode/Agent-SDK) o `Task`
  // (CLI). Aceptar ambos — si solo escuchara 'Task', en el entorno de TYCON (VSCode) el
  // hook nunca dispararía y check-count caería al --ran self-reportado.
  // Codex (Etapa E2, 2026-08-22, sonda con payload real): el spawn es la tool
  // `collaborationspawn_agent` y el nombre del agente viaja en tool_input.task_name
  // (Codex lo underscorea: "tycon_plugin_security_basics"). El evento SubagentStart NO
  // sirve acá: su payload trae solo agent_id + agent_type="default", sin el nombre —
  // por eso este hook se registra en Codex como PreToolUse + matcher
  // collaborationspawn_agent, no como SubagentStart (revierte la apuesta del inventario
  // §A.2 con la evidencia de la sonda E2: guides/codex-migration.md, Registro E2).
  const TOOLS = new Set(['Task', 'Agent', 'collaborationspawn_agent']);
  if (!event || !TOOLS.has(event.tool_name)) return;

  // Codex (sonda G-1, 2026-08-22, payload completo): la IDENTIDAD del agent viaja en
  // tool_input.agent_type (el nombre EXACTO del TOML, con guiones); task_name es una etiqueta
  // LIBRE que elige el orquestador (se midió "sonda-alfa" para un agent llamado otra cosa) —
  // como ground truth de check-count es falsificable. agent_type gana; task_name queda de
  // fallback (underscoreado → se normaliza) para payloads viejos.
  const ti = event.tool_input || {};
  const rawName = ti.subagent_type || (event.tool_name === 'collaborationspawn_agent' && ti.agent_type) || ti.task_name;
  if (!rawName || typeof rawName !== 'string') return;
  const advisor = event.tool_name === 'collaborationspawn_agent' && !ti.agent_type ? rawName.replace(/_/g, '-') : rawName;
  const model = (event.tool_input && event.tool_input.model) || null;

  const sessionId = sessionIdFileKey(event.session_id);
  const cwd = event.cwd || process.cwd();
  const dir = path.join(stateDirOf(os.homedir()), 'advisor-runs');
  const logPath = path.join(dir, `${sessionId}.jsonl`);
  // REPO y STORY en cada línea (2026-08-25, Tema 2 del plan de controles apagables). Sin esto el
  // registro no puede contestar "¿corrieron los revisores de la story X?": se medían 756 líneas
  // acumuladas con CERO repo. El dato ya estaba a mano — el marker de la sesión lo tiene, y si no
  // hay marker la raíz de git del cwd alcanza para el repo. Se estampa acá, en el momento del
  // spawn REAL, no en un comando que alguien tiene que acordarse de tipear.
  const { repo, story } = attribution(sessionId, cwd);
  // 🔴 EL BLANCO de una retrospectiva no es el repo de la sesión (2026-08-31,
  // incident-log#retro-gate-cuenta-sin-repo-2026-08-31). `attribution()` contesta "¿en qué repo
  // está trabajando esta sesión?" — perfecto para los advisors, MENTIRA para el capturer: se lanza
  // POST-merge, muchas veces desde el workspace-root (que no es repo git → `repo: null`: medido,
  // 46 de 90 spawns del capturer, 51%) o con el marker de una story de OTRO repo, que gana sobre el
  // cwd. Sobre ese dato, el freno de retrospectiva (retro-pending.js) empareja merge↔retro: con
  // `null` empareja cualquier cosa, y con el repo del marker empareja la equivocada.
  // El dato correcto ya viaja en el prompt del propio spawn (lo arma `launchHint`): a qué repo y a
  // qué merge apunta la retrospectiva. Se estampa aparte, sin tocar `repo`/`story` — de los que
  // dependen el roster de revisores y el snapshot de iteración.
  const retro = advisor === 'tycon-retrospective-capturer' ? retroTarget(ti.prompt) : null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        ts: new Date().toISOString(), advisor, model, repo, story,
        ...(retro && retro.repo ? { retro_repo: retro.repo } : {}),
        ...(retro && retro.sha ? { retro_sha: retro.sha } : {}),
      }) + '\n',
      'utf8',
    );
  } catch {
    // best-effort — un fallo de log nunca debe romper el spawn del subagent.
  }

  // ── La FOTO del estado auditado, tomada sola ──────────────────────────────
  // 🔴 `snapshot-iter N` tiene un único momento correcto: ronda de advisors terminada, ANTES del
  // primer fix. Dependía de que el orquestador se acordara, y falló DOS veces en cinco semanas
  // (stories 3.25 y 4.42) con el mismo síntoma: delta vacío en el re-loop y recuperación a mano con
  // `--force-full-reloop` — el set completo de advisors donde el delta real eran dos archivos.
  // El dato para detectarlo ya vivía en este mismo log; nadie lo cruzaba.
  // Se dispara en el SPAWN del último advisor esperado: entre ese spawn y el primer fix no se toca
  // código, así que la foto sale del estado correcto. Kill-switch: TYCON_AUTO_SNAPSHOT=0.
  // 🔴 Dos cosas cuelgan del MISMO momento (ronda completa) pero tienen interruptores distintos y
  // a propósito: apagar la foto no puede apagar el registro de autoría, que es la evidencia que el
  // portón de CI exige para cerrar una story. Meterlos bajo el mismo `if` fue el primer intento —
  // y habría dejado el control sin cobertura con sólo poner TYCON_AUTO_SNAPSHOT=0 (que es
  // exactamente lo que hace el banco de pruebas de otros casos).
  try {
    const { rondaCompleta } = require('./lib/advisor-round.js');
    const r = rondaCompleta(fs.readFileSync(logPath, 'utf8').split('\n'));
    if (r.completa && !r.yaFotografiada && r.iter !== null) {
      // 🔴 El registro de autoría va PRIMERO, y en su propio try: es EVIDENCIA (el portón la
      // exige), la foto es una optimización. Al revés —como estaba— un fallo del snapshot
      // (timeout de 10 s en un repo grande, marker.js con exit ≠ 0) se tragaba todo y el roster
      // no se escribía NI dejaba constancia, que es justo la falla que esta pieza predica evitar.
      escribirRoster({ logPath, repo, story, sessionId, transcriptPath: event.transcript_path });
      if (process.env.TYCON_AUTO_SNAPSHOT !== '0') {
        const { execFileSync } = require('child_process');
        execFileSync(process.execPath, [path.join(__dirname, 'marker.js'), 'snapshot-iter', String(r.iter)], {
          stdio: 'ignore', timeout: 10000, env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId },
        });
        process.stderr.write(
          `📸 tycon-pipeline: foto del estado auditado tomada sola (iteración ${r.iter}, ${r.esperados} advisors).\n` +
          '   Es el insumo del re-loop reducido. Si arreglás algo ahora, el delta de la próxima vuelta sale bien.\n',
        );
      }
      // El sello que impide repetir la ronda. Va DESPUÉS de las dos: si alguna falla, la ronda
      // queda sin sellar y el próximo spawn lo reintenta.
      fs.appendFileSync(
        logPath,
        JSON.stringify({ ts: new Date().toISOString(), event: 'auto-snapshot', iter: r.iter }) + '\n',
        'utf8',
      );
    } else if (r.completa && r.yaFotografiada && !ADHOC.has(advisor)) {
      // 🔴 Un revisor llamado DESPUÉS del sello (el de la prueba en vivo del paso 7c, o una vuelta manual) también entra
      // al registro de autoría: sin eso, `write-findings` lo rechaza como firmante y su hallazgo termina firmado como
      // «orquestador». La escritura mezcla con el registro anterior.
      escribirRoster({ logPath, repo, story, sessionId, transcriptPath: event.transcript_path });
    }
  } catch { /* fail-open: nada de esto puede romper un spawn — el freno real vive en el portón */ }

  // ── Las VUELTAS MANUALES también cuentan (2026-09-06, ADVISORS-ITER-MANUAL-RELOOP-UNDERCOUNT-1) ──
  // Después del sello de la ronda formal, los revisores que se vuelven a llamar «a mano» (dos o tres
  // puntuales tras el pase adversarial, hasta que confirman limpio) no completan ninguna ronda y no
  // dejaban rastro: la story 1.1 tuvo 5 vueltas reales y la métrica dio 2. Acá cada vuelta manual
  // sella `manual-iter` en el ledger y escribe su `advisors-iter` en gates.log con iter `<N>.<k>`,
  // que el capturador cuenta como un iter distinto sin cambiar su fórmula. Sin foto: la foto es
  // del re-loop formal. Kill-switch compartido con la foto: TYCON_AUTO_SNAPSHOT=0 apaga las dos.
  if (process.env.TYCON_AUTO_SNAPSHOT !== '0') {
    try {
      const { vueltaManual } = require('./lib/advisor-round.js');
      const v = vueltaManual(fs.readFileSync(logPath, 'utf8').split('\n'));
      if (v.abre) {
        // sin `advisor`: en el ledger «línea con advisor» ES un spawn para summarize/cost-report/contarRondas (#31)
        fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), event: 'manual-iter', iter: v.iter, abierta_por: advisor }) + '\n', 'utf8');
        fs.appendFileSync(
          path.join(path.dirname(dir), 'gates.log'),
          JSON.stringify({ ts: new Date().toISOString(), sessionId, name: 'advisors-iter', storyId: story || null, iter: v.iter, manual: true, repoPath: repo || null, advisor }) + '\n',
          'utf8',
        );
      }
    } catch { /* fail-open: un fallo de conteo no puede romper un spawn */ }
  }

  if (process.env.TYCON_SPAWN_GOVERNANCE === '0') return;

  // ── El techo de la organización (story 7.29, decisión 20) ─────────────────
  // En Claude el techo lo cumple el modelo que da el pipeline; si un lanzamiento lo pasa (con `model:` o, sin él, el
  // `model:` de su `.md` instalado), se AVISA: no se frena ni se cambia el pedido. Vale para cualquier agente (revisor
  // o ad hoc), por eso va antes del corte por tipo. En Codex no: el modelo ya se recortó al desplegar, y
  // `tool_input.model` no viene (leer el `.md` daría un aviso falso). La configuración, por el mismo lector que el
  // pipeline (orgModels → readOrgModels), nunca por cuenta propia.
  let org = null;
  let notaTecho = null;
  if (event.tool_name !== 'collaborationspawn_agent') {
    try {
      org = require('./pipeline.js').orgModels();
      // la configuración no se pudo leer: el techo no se controla en este lanzamiento, y se dice (no es «sin techo»)
      if (org && org.problem) notaTecho = `${org.problem}; el techo de la organización no se controla en este lanzamiento`;
      if (org && org.declared) {
        const M = require('./lib/models.js');
        const techo = M.ceilingOf(org.data);
        const usa = model || M.frontmatterModel(advisor);
        if (techo && M.isModel(usa) && M.rank(usa) > M.rank(techo)) notaTecho = `este lanzamiento usa ${usa}, por encima del techo de la organización (${techo})`;
      }
    } catch { org = null; }
  }

  if (!ADHOC.has(advisor)) {
    if (notaTecho) {
      try { process.stdout.write(JSON.stringify({ systemMessage: `[tycon-pipeline] lanzamiento \`${advisor}\`: ${notaTecho}` })); } catch { /* nunca romper el spawn */ }
    }
    return;
  }

  const notes = [];
  if (notaTecho) notes.push(notaTecho);

  // ── Aviso (a) — hay índice de código local ────────────────────────────────
  let hasCodegraph = false;
  try { hasCodegraph = fs.existsSync(path.join(cwd, '.codegraph')); } catch {}

  // ── Aviso (b) — cuántos ad-hoc van en esta fase ───────────────────────────
  // "Fase" = desde el último step5-start (o desde el arranque de la sesión si no hubo).
  // Es exactamente el corte que usó la medición: Steps 0-4 vs la revisión.
  let adhocEnFase = 0;
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    let desde = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('"step5-start"')) { desde = i + 1; break; }
    }
    for (let i = desde; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const d = JSON.parse(lines[i]);
        if (d.advisor && ADHOC.has(d.advisor)) adhocEnFase++;
      } catch { /* línea corrupta: ignorar */ }
    }
  } catch { /* sin log todavía */ }

  const umbral = Number.parseInt(process.env.TYCON_ADHOC_SPAWN_WARN ?? '5', 10);
  const pasoUmbral = umbral > 0 && adhocEnFase >= umbral;

  if (hasCodegraph) {
    notes.push(
      'este repo tiene índice de código local (.codegraph/): si este agente sale a BUSCAR ' +
      'dónde está algo, codegraph_search/codegraph_context contesta lo mismo por ~0 tokens',
    );
  }
  if (pasoUmbral) {
    notes.push(
      `van ${adhocEnFase} agentes de exploración libre en esta fase (umbral ${umbral}) — ` +
      'cada uno cuesta ~60-100K tokens antes de leer nada',
    );
  }
  if (!model && (hasCodegraph || pasoUmbral)) {
    // con la configuración de la organización, el modelo de los ayudantes (story 7.29, AC 9)
    let barato = 'uno barato';
    if (org && org.declared) {
      try {
        const h = require('./lib/models.js').resolveHelpers({ org: org.data });
        barato = `\`${h.model}\` (${h.origin === 'default' ? 'valor de hoy' : 'configuración de la organización'})`;
      } catch { /* queda el texto de hoy */ }
    }
    notes.push(`este spawn no declara \`model:\` — para buscar/explorar alcanza ${barato}`);
  }

  if (!notes.length) return;
  try {
    process.stdout.write(JSON.stringify({
      systemMessage: `[tycon-pipeline] spawn ad-hoc \`${advisor}\`: ` + notes.join(' · '),
    }));
  } catch { /* nunca romper el spawn */ }
}

try { main(); } catch { /* fail-safe */ }
process.exit(0);
