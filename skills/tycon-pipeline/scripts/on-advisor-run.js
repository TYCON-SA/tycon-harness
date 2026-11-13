#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse hook (matcher: Task) — log de invocaciones de subagents
 * + freno advisory sobre los spawns AD-HOC de la primera mitad del pipeline.
 *
 * El determinismo de la SELECCIÓN (pipeline.js computa el set) no alcanza: `check-count`
 * confiaría en el `--ran` que el LLM REDACTA — el LLM podría pasar el set esperado sin haberlo
 * corrido. Este hook registra cada subagent realmente spawneado, y `pipeline.js check-count` lo lee
 * como ground-truth en vez de confiar en el self-report. Así el conteo deja de ser "disciplina con asistencia".
 *
 * GOBIERNO DE SPAWNS AD-HOC — medición sobre 58 runs / 795 spawns:
 *   - El subagent más spawneado del pipeline NO es un advisor: es `general-purpose`,
 *     156 de 795 (20%). Sumando `Explore` (30) son 186 — el 23% del total.
 *   - 133 de esos 156 ocurren ANTES del `step5-start`, o sea en los pasos de «Arranque» a «Correr las pruebas», donde
 *     NO hay ninguna de las reglas de costo del pipeline (ni context curado, ni
 *     model hints, ni mech-check, ni batch_rule).
 *   - Un spawn cuesta ~60.000-100.000 tokens ANTES de leer nada (baseline medido):
 *     el más barato medido consumió 67K con un contexto de apenas 6K. El contexto es
 *     como mucho un cuarto del costo — la palanca es abrir MENOS agentes, no alimentarlos
 *     mejor.
 * Por eso este hook, además de loguear, AVISA (nunca bloquea) cuando:
 *   (a) se abre un agente de exploración en un repo que tiene índice de código local
 *       (`.codegraph/`), que contesta lo mismo por ~0 tokens;
 *   (b) se acumulan más de N agentes ad-hoc en la fase actual;
 *   (c) el spawn no declara `model:` — para buscar alcanza uno barato.
 * Es advisory a propósito: las reglas de costo mandatorias
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
const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // la carpeta del estado, de una sola pieza
const { sessionIdFileKey } = require('./lib/session-id.js');
const { attribution } = require('./lib/repo-attrib.js');

// Subagents de exploración libre: no tienen contexto curado ni superficie declarada.
const ADHOC = new Set(['general-purpose', 'Explore', 'Plan', 'claude']);

// Sin corrida abierta ni ronda de revisores en el registro, la fase es la última hora.
const NO_RUN_WINDOW_MS = 60 * 60 * 1000;
// Una ruta dentro del pedido de un agente: absoluta, con `/` o con `\` (Windows).
const RE_PATH = /(?:[A-Za-z]:)?[\\/][^\s'"`«»()<>]+/g;

/**
 * La lectura curada de un agente de tipo libre, o null. Un agente cuyo pedido nombra un archivo que existe y que es su
 * lectura no sale a explorar: un `.prompt.txt` del pase (los pedidos de workflow-lite.js --agents-dir) o el archivo de
 * contexto de los revisores que anotó la ronda (`context_file` y `context_file_overrides` de sus step5-start).
 */
function curatedReading(prompt, lines) {
  const texto = String(prompt || '');
  if (!texto) return null;
  const contextFiles = new Set();
  for (const l of lines) {
    if (!l.includes('"step5-start"')) continue;
    try {
      const d = JSON.parse(l);
      if (typeof d.context_file === 'string') contextFiles.add(d.context_file);
      for (const v of Object.values(d.context_file_overrides || {})) if (typeof v === 'string') contextFiles.add(v);
    } catch { /* línea corrupta: ignorar */ }
  }
  for (const m of texto.matchAll(RE_PATH)) {
    const file = m[0].replace(/[.,;:]+$/, '');
    // una ruta de red (`\\host\…`, `//host/…`) no se mira: en Windows abriría una conexión al equipo que nombre el pedido
    if (/^[\\/]{2}/.test(file)) continue;
    if (!/\.prompt\.txt$/.test(file) && !contextFiles.has(file)) continue;
    try { if (fs.statSync(file).isFile()) return file; } catch { /* no existe: no cuenta */ }
  }
  return null;
}

/**
 * Dónde empieza la fase en el registro de la sesión: `{ idx, since, lastHour, markerUnreadable }`. Cuenta lo que está
 * después del último corte del registro (la ronda de revisores, `step5-start`, o una corrida nueva, `run-start`) y, si
 * la sesión tiene corrida, desde el comienzo de su paso abierto: lo más nuevo de los dos. Sin ninguno, la última hora:
 * `lastHour` dice que no hay corrida; `markerUnreadable`, que el marcador está pero no se pudo leer (también cuenta la
 * última hora, sin afirmar que no hay corrida).
 */
function phaseStart(lines, sessionId, now = Date.now()) {
  let idx = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('"step5-start"') || lines[i].includes('"run-start"')) { idx = i + 1; break; }
  }
  let since = null;
  let markerUnreadable = false;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(stateDirOf(os.homedir()), 'active', `${sessionId}.json`), 'utf8'));
    for (const t of Object.values((m && m.stepTimings) || {})) {
      if (!t || !t.startedAt || t.completedAt) continue;
      const x = Date.parse(t.startedAt);
      if (Number.isNaN(x)) { markerUnreadable = true; continue; }
      if (since === null || x > since) since = x;
    }
  } catch (e) {
    if (!e || e.code !== 'ENOENT') markerUnreadable = true;
  }
  if (since !== null || idx > 0) return { idx, since, lastHour: false, markerUnreadable };
  return { idx: 0, since: now - NO_RUN_WINDOW_MS, lastHour: !markerUnreadable, markerUnreadable };
}

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
    // Con la ruta de la story: si su número se repite en el repo, la carpeta lleva la clave. La
    // misma ruta sirve después para proyectar la corrida al repo de la story.
    const m = require('./lib/repo-attrib.js').readMarkerFile(sessionId);
    const storyPath = m && m.storyPath ? (path.isAbsolute(m.storyPath) ? m.storyPath : path.join(m.repoPath || repo, m.storyPath)) : null;
    // la carpeta de ESTA corrida: la del marcador de la sesión que lanzó al revisor (lib/run-dir.js)
    const runDir = resolveRunDir(repo, String(story), true, storyPath || undefined, { marker: m });
    if (!runDir) {
      const k = storyPath ? require('./lib/evidence-key.js').keyInfoOr(storyPath, String(story)) : null;
      motivo = k && k.error ? `run dir no resuelto: sin clave de la story (${String(k.error).slice(0, 160)})` : 'run dir no resuelto';
    } else {
      const { parseJsonl } = require('./lib/advisor-ledger.js');
      const lines = parseJsonl(fs.readFileSync(logPath, 'utf8'));
      let headSha = null;
      try {
        headSha = require('child_process')
          .execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { windowsHide: true, encoding: 'utf8', timeout: 5000 })
          .trim() || null;
      } catch { /* repo sin commits todavía */ }
      // El sello del ÁRBOL que los revisores están mirando. `headSha` sólo dice sobre qué commit
      // se apoya: la implementación se commitea DESPUÉS de la revisión, así que por sí solo no
      // sirve para auditar qué se revisó (el commit base no coincide con el contenido de los
      // archivos que toca la story). Medido acá: ~130 ms por spawn en repos reales, y null
      // limpio cuando no se puede — nunca un sello inventado.
      // Con la vuelta congelada (historia 8.161), el sello es el de su lanzamiento: lo que leyeron los revisores. Sin
      // vuelta congelada (lanzada fuera de `pipeline.js advisors`), el de la carpeta, como antes.
      let treeSha = null;
      try {
        const ft = require('./lib/frozen-tree.js');
        const v = ft.ultimaVuelta(require('./lib/state-dir.js').stateDir(require('os').homedir()), String(sessionId || '').replace(/[/\\]/g, '_'), 'revisores');
        const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
        const delRepo = v && (v.repos || []).find((r) => real(r.repo) === real(repo));
        if (delRepo) treeSha = delRepo.tree;
      } catch { treeSha = null; }
      if (!treeSha) treeSha = roster.treeShaDe(repo);
      roster.write(runDir, {
        lines,
        story: String(story),
        sessionId,
        headSha,
        treeSha,
        implementerModel: roster.implementerModel({ marker: m, transcriptPath }),
        // El salteo firmado del pase, si la ejecución ya lo tiene: un roster que nace después no lo pierde.
        adversarialSkip: (require('./lib/adversarial-skip.js').firmasDelSalteo(m)[0] || {}).firmado,
      });
      // Story en OTRO repo (las stories en un repo, el código en otro) → el portón de
      // CI del repo de la story exige esta constancia AHÍ. Se proyectan sólo roster y
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
// cualquier orden y se toleran comillas; si el prompt no lo dice, se devuelve null y el freno cae al
// comportamiento sin blanco declarado (nunca inventa un repo: un blanco inventado es peor que ninguno).
function retroTarget(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  const mRepo = prompt.match(/\brepo[:=\s]+["'`]?((?:[A-Za-z]:[\\/]|[\\/])[^\s,;"'`)]+)/i);
  const mSha = prompt.match(/\bmerge[:=\s]+["'`]?([0-9a-f]{7,40})\b/i);
  const repo = mRepo ? mRepo[1].replace(/[.,;:]+$/, '') : null;
  return (repo || mSha) ? { repo, sha: mSha ? mSha[1] : null } : null;
}

/**
 * La constancia de un lanzamiento de revisor: la línea del registro de la sesión (la que lee `check-count`), el
 * registro de autoría y la foto de la vuelta cuando la ronda se completa, y la vuelta manual. La llaman este gancho (al
 * lanzar un agente) y el lanzador de revisores de Codex (`lib/codex-reviewers.js`, al terminar cada proceso), para
 * que los dos caminos dejen lo mismo. `o.extra` va a la línea del registro (el lanzador suma `launcher`, `exit` y
 * `report`). Nunca tira: un fallo de registro no rompe un lanzamiento.
 *
 * @param {{sessionId?: string, cwd?: string, advisor: string, model?: string|null, transcriptPath?: string|null,
 *          prompt?: string|null, extra?: object}} o
 * @returns {{sessionId: string, cwd: string, logPath: string, repo: string|null, story: string|null, ok: boolean,
 *            error?: string}} `ok: false` si la línea del registro no se pudo escribir
 */
/**
 * El nombre de la carpeta de la corrida del marcador de la sesión (`lib/run-dir.js`, sin crearla), o null sin marcador de
 * esa historia o sin carpeta. Nunca tira: sin la corrida, el renglón queda como antes.
 */
function runDeLaSesion(sessionId, story) {
  try {
    const m = require('./lib/repo-attrib.js').readMarkerFile(sessionId);
    if (!m || !story || String(m.storyId) !== String(story) || !m.repoPath) return null;
    const storyPath = m.storyPath ? (path.isAbsolute(m.storyPath) ? m.storyPath : path.join(m.repoPath, m.storyPath)) : undefined;
    const dir = require('./lib/run-dir.js').resolveRunDir(m.repoPath, String(m.storyId), false, storyPath, { marker: m });
    return dir ? path.basename(dir) : null;
  } catch (e) {
    // el renglón queda con `run: null` y el cruce cae a las sesiones de la corrida: se dice por qué
    process.stderr.write(`[on-advisor-run] no pude resolver la carpeta de la corrida de ${sessionId}: ${(e && e.message) || e}\n`);
    return null;
  }
}

function recordLaunch(o) {
  const advisor = o.advisor;
  const model = o.model || null;
  const sessionId = sessionIdFileKey(o.sessionId);
  const cwd = o.cwd || process.cwd();
  const dir = path.join(stateDirOf(os.homedir()), 'advisor-runs');
  const logPath = path.join(dir, `${sessionId}.jsonl`);
  // REPO y STORY en cada línea. Sin esto el registro no puede contestar "¿corrieron los revisores
  // de la story X?". El dato está a mano — el marker de la sesión lo tiene, y si no
  // hay marker la raíz de git del cwd alcanza para el repo. Se estampa acá, en el momento del
  // spawn REAL, no en un comando que alguien tiene que acordarse de tipear.
  const { repo, story } = attribution(sessionId, cwd);
  // 🔴 EL BLANCO de una retrospectiva no es el repo de la sesión. `attribution()` contesta "¿en qué repo
  // está trabajando esta sesión?" — perfecto para los advisors, MENTIRA para el capturer: se lanza
  // POST-merge, muchas veces desde el workspace-root (que no es repo git → `repo: null`, en cerca de
  // la mitad de los spawns del capturer) o con el marker de una story de OTRO repo, que gana sobre el
  // cwd. Sobre ese dato, el freno de retrospectiva (retro-pending.js) empareja merge↔retro: con
  // `null` empareja cualquier cosa, y con el repo del marker empareja la equivocada.
  // El dato correcto ya viaja en el prompt del propio spawn (lo arma `launchHint`): a qué repo y a
  // qué merge apunta la retrospectiva. Se estampa aparte, sin tocar `repo`/`story` — de los que
  // dependen el roster de revisores y el snapshot de iteración.
  const retro = advisor === 'tycon-retrospective-capturer' ? retroTarget(o.prompt) : null;
  // la corrida, por el nombre de su carpeta (como la anota Codex): el cierre cruza sólo lo de su corrida, y una
  // ayudante que comparte el marcador escribe la misma. Sin marcador o sin carpeta, null
  const run = runDeLaSesion(sessionId, story);
  let lineError = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        ts: new Date().toISOString(), advisor, model, repo, story, run,
        ...(o.extra || {}),
        ...(retro && retro.repo ? { retro_repo: retro.repo } : {}),
        ...(retro && retro.sha ? { retro_sha: retro.sha } : {}),
      }) + '\n',
      'utf8',
    );
  } catch (e) {
    // best-effort — un fallo de log nunca debe romper el spawn del subagent; quien llama se entera por `ok: false`
    lineError = (e && e.message) || String(e);
  }

  // ── El lanzamiento en el registro de críticos reportados ──────────────────
  // Un revisor del set de la ronda abierta deja su renglón `launched`: sin él, el cierre no sabría que de este revisor
  // falta el reporte (lib/reported-criticals.js). `reviewers-run` anota el suyo al lanzar el proceso, y no pasa por acá.
  // El set sale de la marca `step5-start` de la ronda (sólo su posición y su `expected`, no su `iter`).
  if (!o.extra || o.extra.launcher !== 'pipeline') {
    try {
      const parsed = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
      const idx = require('./lib/advisor-round.js').inicioDeLaRonda(parsed);
      const expected = idx >= 0 && Array.isArray(parsed[idx].expected) ? parsed[idx].expected : [];
      if (expected.includes(advisor)) {
        require('./lib/reported-criticals.js').recordLaunched({
          stateDir: stateDirOf(os.homedir()), sessionKey: sessionId, advisor, story, run, launcher: o.launcher || 'claude',
        });
      }
    } catch (e) {
      // sin el renglón, el cierre dice «no tiene registro» o «no pude leer»: nunca «no reportó nada». Queda dicho
      try { process.stderr.write(`on-advisor-run: no pude anotar el lanzamiento de ${advisor} en el registro de críticos (${(e && e.message) || e})\n`); } catch { /* nada */ }
    }
  }

  // ── La FOTO del estado auditado, tomada sola ──────────────────────────────
  // 🔴 `snapshot-iter N` tiene un único momento correcto: ronda de advisors terminada, ANTES del
  // primer fix. Depender de que el orquestador se acuerde falla con el mismo síntoma:
  // delta vacío en el re-loop y recuperación a mano con `--force-full-reloop` — el set completo de
  // advisors donde el delta real son dos archivos.
  // El dato para detectarlo vive en este mismo log.
  // Se dispara en el SPAWN del último advisor esperado: entre ese spawn y el primer fix no se toca
  // código, así que la foto sale del estado correcto. Kill-switch: TYCON_AUTO_SNAPSHOT=0.
  // 🔴 Dos cosas cuelgan del MISMO momento (ronda completa) pero tienen interruptores distintos y
  // a propósito: apagar la foto no puede apagar el registro de autoría, que es la evidencia que el
  // portón de CI exige para cerrar una story. Meterlos bajo el mismo `if` dejaría el control
  // sin cobertura con sólo poner TYCON_AUTO_SNAPSHOT=0 (que es exactamente lo que hace el banco de controles).
  try {
    const { rondaCompleta } = require('./lib/advisor-round.js');
    const r = rondaCompleta(fs.readFileSync(logPath, 'utf8').split('\n'));
    if (r.completa && !r.yaFotografiada && r.iter !== null) {
      // 🔴 El registro de autoría va PRIMERO, y en su propio try: es EVIDENCIA (el portón la
      // exige), la foto es una optimización. Al revés, un fallo del snapshot (timeout de 10 s en un
      // repo grande, marker.js con exit ≠ 0) tragaría todo y el roster no se escribiría NI dejaría
      // constancia, que es justo la falla que esta pieza predica evitar.
      escribirRoster({ logPath, repo, story, sessionId, transcriptPath: o.transcriptPath });
      let rechazada = false;
      if (process.env.TYCON_AUTO_SNAPSHOT !== '0') {
        const { execFileSync } = require('child_process');
        try {
          execFileSync(process.execPath, [path.join(__dirname, 'marker.js'), 'snapshot-iter', String(r.iter)], {
            windowsHide: true,
            stdio: 'ignore', timeout: 10000, env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId },
          });
        } catch (e) {
          // Salida 2 es una DECISIÓN de snapshot-iter, ya anotada en gates.log: hay código posterior al último
          // revisor y no hay foto buena que conservar, así que el re-loop corre el set completo. Reintentarla en
          // cada spawn siguiente no la cambia, y el reintento que llegaba después del `start` de otra corrida
          // tomaba la foto sobre el marcador nuevo. Cualquier otra falla (sin marcador, tiempo agotado) se reintenta.
          if (!(e && e.status === 2)) throw e;
          rechazada = true;
        }
        process.stderr.write(rechazada
          ? `📸 tycon-pipeline: la foto de la iteración ${r.iter} no se tomó (hay código editado después del último revisor; ` +
            'el motivo quedó en gates.log). La próxima vuelta corre el set completo de revisores.\n'
          : `📸 tycon-pipeline: foto del estado auditado tomada sola (iteración ${r.iter}, ${r.esperados} advisors).\n` +
            '   Es el insumo del re-loop reducido. Si arreglás algo ahora, el delta de la próxima vuelta sale bien.\n');
      }
      // El sello que impide repetir la ronda. Va DESPUÉS de las dos: si alguna falla, la ronda
      // queda sin sellar y el próximo spawn lo reintenta.
      fs.appendFileSync(
        logPath,
        JSON.stringify({ ts: new Date().toISOString(), event: 'auto-snapshot', iter: r.iter, ...(rechazada ? { foto: 'rechazada' } : {}) }) + '\n',
        'utf8',
      );
    } else if (r.completa && r.yaFotografiada && !ADHOC.has(advisor)) {
      // 🔴 Un revisor llamado DESPUÉS del sello (el de la prueba en vivo, o una vuelta manual) también entra
      // al registro de autoría: sin eso, `write-findings` lo rechaza como firmante y su hallazgo termina firmado como
      // «orquestador». La escritura mezcla con el registro anterior.
      escribirRoster({ logPath, repo, story, sessionId, transcriptPath: o.transcriptPath });
    }
  } catch { /* fail-open: nada de esto puede romper un spawn — el freno real vive en el portón */ }

  // ── Las VUELTAS MANUALES también cuentan ──
  // Después del sello de la ronda formal, los revisores que se vuelven a llamar «a mano» (dos o tres
  // puntuales tras el pase adversarial, hasta que confirman limpio) no completan ninguna ronda y no
  // dejarían rastro (con cinco vueltas reales, la métrica daría dos). Cada vuelta manual
  // sella `manual-iter` en el ledger y escribe su `advisors-iter` en gates.log con iter `<N>.<k>`,
  // que el capturador cuenta como un iter distinto sin cambiar su fórmula. Sin foto: la foto es
  // del re-loop formal. Kill-switch compartido con la foto: TYCON_AUTO_SNAPSHOT=0 apaga las dos.
  if (process.env.TYCON_AUTO_SNAPSHOT !== '0') {
    try {
      const { vueltaManual } = require('./lib/advisor-round.js');
      const v = vueltaManual(fs.readFileSync(logPath, 'utf8').split('\n'));
      if (v.abre) {
        // sin `advisor`: en el ledger «línea con advisor» ES un spawn para summarize/cost-report/contarRondas
        fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), event: 'manual-iter', iter: v.iter, abierta_por: advisor }) + '\n', 'utf8');
        fs.appendFileSync(
          path.join(path.dirname(dir), 'gates.log'),
          JSON.stringify({ ts: new Date().toISOString(), sessionId, name: 'advisors-iter', storyId: story || null, iter: v.iter, manual: true, repoPath: repo || null, advisor }) + '\n',
          'utf8',
        );
      }
    } catch { /* fail-open: un fallo de conteo no puede romper un spawn */ }
  }

  return { sessionId, cwd, logPath, repo, story, ok: !lineError, ...(lineError ? { error: lineError } : {}) };
}

/**
 * ¿El freno de lanzamiento de revisores está registrado en la configuración de Claude Code? Mira las cuatro: la de la
 * casa y la del repo, con sus `.local`. Un archivo que no se lee no lo registra.
 */
function reviewerGateRegistered(cwd) {
  const bases = [os.homedir(), ...(cwd ? [cwd] : [])];
  for (const b of bases) {
    for (const archivo of [path.join(b, '.claude', 'settings.json'), path.join(b, '.claude', 'settings.local.json')]) {
      let conf;
      try { conf = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { continue; }
      const grupos = conf && conf.hooks && Array.isArray(conf.hooks.PreToolUse) ? conf.hooks.PreToolUse : [];
      for (const g of grupos) {
        for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
          if (h && /reviewer-launch-gate\.js/.test(String(h.command || ''))) return true;
        }
      }
    }
  }
  return false;
}

function main() {
  let event;
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : null;
  } catch {
    return;
  }
  // El spawn de subagents se llama `Agent` (VSCode/Agent-SDK) o `Task` (CLI). Aceptar ambos:
  // si solo escuchara 'Task', en el entorno de TYCON (VSCode) el hook nunca dispararía y
  // check-count caería al --ran self-reportado.
  // Codex (sonda con payload real): el spawn es la tool `collaborationspawn_agent` y el nombre
  // del agente viaja en tool_input.task_name (Codex lo underscorea: "tycon_plugin_security_basics").
  // El evento SubagentStart NO sirve acá: su payload trae solo agent_id + agent_type="default", sin
  // el nombre — por eso este hook se registra en Codex como PreToolUse + matcher
  // collaborationspawn_agent, no como SubagentStart.
  const TOOLS = new Set(['Task', 'Agent', 'collaborationspawn_agent']);
  if (!event || !TOOLS.has(event.tool_name)) return;

  // Codex (payload completo): la IDENTIDAD del agent viaja en
  // tool_input.agent_type (el nombre EXACTO del TOML, con guiones); task_name es una etiqueta
  // LIBRE que elige el orquestador (puede no coincidir con el agente real) —
  // como ground truth de check-count es falsificable. agent_type gana; task_name queda de
  // fallback (underscoreado → se normaliza) para payloads sin agent_type.
  const ti = event.tool_input || {};
  const rawName = ti.subagent_type || (event.tool_name === 'collaborationspawn_agent' && ti.agent_type) || ti.task_name;
  if (!rawName || typeof rawName !== 'string') return;
  const advisor = event.tool_name === 'collaborationspawn_agent' && !ti.agent_type ? rawName.replace(/_/g, '-') : rawName;
  const model = (event.tool_input && event.tool_input.model) || null;

  // ── El lanzamiento que niega el freno de revisores no se anota ────────────
  // El freno (`reviewer-launch-gate.js`) y este registro corren en el mismo PreToolUse, en cualquier orden: deciden con
  // la misma función sobre el mismo marcador. Un lanzamiento negado no corrió, y anotarlo lo haría contar en
  // `check-count`, en el registro de autoría y en la foto de la vuelta. Se descuenta sólo con el freno registrado en la
  // configuración: con los guiones nuevos y la configuración vieja nadie lo frena, y entonces se anota y se avisa.
  // Codex no pasa por el freno; su lanzador llama a `recordLaunch` directo.
  let notaFreno = null;
  if (event.tool_name !== 'collaborationspawn_agent') {
    try {
      const d = require('./reviewer-launch-gate.js').decide(event);
      if (d.deny) {
        if (reviewerGateRegistered(event.cwd)) return;
        notaFreno = 'el freno de lanzamiento de revisores (reviewer-launch-gate.js) no está registrado en la configuración de Claude Code: '
          + `este revisor salió sin el pase adversarial en vuelo (${d.kind}). El perfil minimal no lo trae; en full, lo instala install-tycon-hooks.`;
      }
    } catch (err) {
      // la consulta rota no cambia nada: se anota como siempre, y queda dicho que no se pudo consultar
      try {
        fs.appendFileSync(path.join(stateDirOf(os.homedir()), 'gates.log'), `${JSON.stringify({
          ts: new Date().toISOString(), sessionId: event.session_id || null, name: 'reviewer-launch-gate-unreadable',
          motivo: 'error', via: 'on-advisor-run', detail: String((err && err.message) || err).split('\n')[0].slice(0, 200),
        })}\n`, 'utf8');
      } catch { /* sin registro, se anota igual */ }
    }
  }

  // el registro de antes de este lanzamiento: dice si el pedido trae su lectura curada (y entonces no explora)
  const fileKey = sessionIdFileKey(event.session_id);
  let prevLines = [];
  let logUnreadable = false;
  try { prevLines = fs.readFileSync(path.join(stateDirOf(os.homedir()), 'advisor-runs', `${fileKey}.jsonl`), 'utf8').split('\n'); } catch (e) {
    // sin log todavía es lo normal; otro error queda anotado: sin el registro, el archivo de contexto de la ronda no se reconoce
    if (!e || e.code !== 'ENOENT') logUnreadable = true;
  }
  const curated = ADHOC.has(advisor) ? curatedReading(ti.prompt, prevLines) : null;
  const extra = curated ? { curated: true } : (logUnreadable && ADHOC.has(advisor) ? { curated_check: 'log-unreadable' } : undefined);

  const { cwd, logPath } = recordLaunch({ sessionId: event.session_id, cwd: event.cwd, advisor, model, transcriptPath: event.transcript_path, prompt: ti.prompt, extra,
    launcher: event.tool_name === 'collaborationspawn_agent' ? 'codex-agent' : 'claude' });
  if (process.env.TYCON_SPAWN_GOVERNANCE === '0') {
    if (notaFreno) {
      try { process.stdout.write(JSON.stringify({ systemMessage: `[tycon-pipeline] lanzamiento \`${advisor}\`: ${notaFreno}` })); } catch { /* nunca romper el spawn */ }
    }
    return;
  }

  // ── El techo de la organización ───────────────────────────────────────────
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

  if (!ADHOC.has(advisor) || curated) {
    const notas = [notaFreno, notaTecho].filter(Boolean);
    if (notas.length) {
      try { process.stdout.write(JSON.stringify({ systemMessage: `[tycon-pipeline] lanzamiento \`${advisor}\`: ${notas.join(' · ')}` })); } catch { /* nunca romper el spawn */ }
    }
    return;
  }

  const notes = [];
  if (notaTecho) notes.push(notaTecho);

  // ── Aviso (a) — hay índice de código local ────────────────────────────────
  let hasCodegraph = false;
  try { hasCodegraph = fs.existsSync(path.join(cwd, '.codegraph')); } catch {}

  // ── Aviso (b) — cuántos ad-hoc van en esta fase ───────────────────────────
  // La fase la dice phaseStart: el paso abierto de la corrida o la ronda de revisores, lo más nuevo; sin ninguno,
  // la última hora. Los lanzamientos con su lectura curada no cuentan: no exploran. Una línea sin fecha cuenta si está
  // después del corte del registro (su lugar ya la ubica en la fase); sin corte no se puede ubicar, y el aviso la nombra.
  let adhocEnFase = 0;
  let lastHour = false;
  let markerUnreadable = false;
  let undated = 0;
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    const phase = phaseStart(lines, fileKey);
    lastHour = phase.lastHour;
    markerUnreadable = phase.markerUnreadable;
    for (let i = phase.idx; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const d = JSON.parse(lines[i]);
        if (!d.advisor || !ADHOC.has(d.advisor) || d.curated) continue;
        const t = Date.parse(d.ts);
        if (Number.isNaN(t)) {
          if (phase.idx > 0) adhocEnFase++;
          else undated++;
          continue;
        }
        if (phase.since !== null && t < phase.since) continue;
        adhocEnFase++;
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
    const donde = lastHour ? 'en la última hora (sin corrida abierta)'
      : markerUnreadable ? 'en esta fase (no pude leer el marcador de la corrida: cuento desde el último corte o la última hora)'
        : 'en esta fase';
    notes.push(
      `van ${adhocEnFase} agentes de exploración libre ${donde} (umbral ${umbral})` +
      (undated ? `; ${undated} sin fecha en el registro, no contados` : '') +
      ' — cada uno cuesta ~60-100K tokens antes de leer nada',
    );
  }
  if (!model && (hasCodegraph || pasoUmbral)) {
    // con la configuración de la organización, el modelo de los ayudantes
    let barato = 'uno barato';
    if (org && org.declared) {
      try {
        const h = require('./lib/models.js').resolveHelpers({ org: org.data });
        barato = `\`${h.model}\` (${h.origin === 'default' ? 'valor de hoy' : 'configuración de la organización'})`;
      } catch { /* queda `uno barato` */ }
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

module.exports = { recordLaunch, curatedReading, phaseStart };

if (require.main === module) {
  try { main(); } catch { /* fail-safe */ }
  process.exit(0);
}
