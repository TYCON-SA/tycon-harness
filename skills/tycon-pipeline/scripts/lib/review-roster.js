'use strict';
/**
 * review-roster — el registro de AUTORÍA de una story: quién implementó y quiénes revisaron.
 *
 * ── Por qué existe (decisión del dev, 2026-08-30) ────────────────────────────────────────────
 * El AI-Native SDLC Playbook pide que un revisor con IA mire cada PR **en el servidor**. El arnés
 * ya hace algo mejor y antes: implementa la sesión principal y revisan ~28 advisors que son
 * SUBAGENTES con contexto propio — la independencia ya existe. Lo que faltaba es que el rastro
 * committeado la NOMBRE, para que el portón de CI pueda EXIGIRLA en vez de confiar en ella.
 *
 * Antes de esto, `.advisors/pipeline-runs/<story>/` decía "estos advisors corrieron y encontraron
 * esto" — nunca quién escribió el código. El portón podía verificar que hubo revisión, no que la
 * hizo otro. Esta lib cierra esa distancia sin gastar un token: proyecta a un archivo committeable
 * el ledger que el hook `on-advisor-run.js` YA escribe en cada spawn real.
 *
 * ── Tres restricciones de la casa que explican el diseño ─────────────────────────────────────
 * 1. **Lo escribe el harness, no el LLM ni los advisors.** 15 de 16 advisors son read-only
 *    (`tools: [Read, Grep, Glob]`): pedirles que escriban es una instrucción imposible, y bajo esa
 *    contradicción el modelo vuelca al chat (caso 2026-07-27). El roster lo escribe un hook.
 * 2. **Mecánico, no invocado.** Un control que hay que acordarse de correr no corre
 *    (`incident-log#retro-multi-repo-2026-08-24`).
 * 3. **Vista derivada, no segunda fuente de verdad.** El roster se REGENERA del ledger; si se
 *    pierde, se reconstruye. Nada que sincronizar a mano.
 *
 * ── Qué NO garantiza (dicho acá para que nadie lo lea de más) ────────────────────────────────
 * Es una constancia auto-declarada por la máquina del dev, endurecida por el hook — no una firma.
 * CI no ve `~/.claude/`, así que server-side sólo se verifica coherencia interna. El cruce contra
 * el ledger vivo (infalsificable sin desinstalar el hook) lo hace el pre-commit, en la máquina.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROSTER_FILE = 'review-roster.json';
const VERSION = 1;

/**
 * Sella el ÁRBOL que los revisores están mirando — el working tree, que en el momento de la
 * revisión todavía no está commiteado.
 *
 * Por qué hace falta (2026-09-06): el roster publicaba `head_sha`, el HEAD al correr los
 * revisores. No es falso, es INÚTIL para auditar: en el pipeline la implementación se commitea
 * DESPUÉS de la revisión, así que ese sha apunta al árbol previo. Medido en la story 2.3 del
 * arnés: de los 25 archivos que tocó, 12 no existían en ese árbol y los otros 13 tenían otro
 * contenido — cero idénticos. Quien quisiera auditar qué se revisó no tenía con qué.
 *
 * `git write-tree` sobre una COPIA del índice: la copia es lo que lo hace barato. Con un índice
 * vacío, `git add -A` re-hashea el repo entero (esto corre en cada spawn de advisor); partiendo
 * del índice real, la caché de stat de git ya está caliente y sólo se hashea lo que cambió.
 * El árbol resultante se audita solo: `git ls-tree <tree_sha>` contra el árbol del commit de la
 * story tiene que dar lo mismo.
 *
 * Devuelve null ante cualquier problema — nunca un valor inventado. Un sello que miente es peor
 * que la ausencia de sello, porque la ausencia se ve.
 */
function treeShaDe(repo) {
  const { execFileSync } = require('child_process');
  let tmpIndex = null;
  try {
    const gitDir = execFileSync('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'],
      { encoding: 'utf8', timeout: 5000 }).trim();
    tmpIndex = path.join(os.tmpdir(), `tycon-roster-index-${process.pid}-${VERSION}`);
    try { fs.copyFileSync(path.join(gitDir, 'index'), tmpIndex); } catch { /* repo sin índice: se arma de cero */ }
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    execFileSync('git', ['-C', repo, 'add', '-A'], { env, timeout: 20000, stdio: 'ignore' });
    const tree = execFileSync('git', ['-C', repo, 'write-tree'], { env, encoding: 'utf8', timeout: 20000 }).trim();
    return /^[0-9a-f]{40}$/.test(tree) ? tree.slice(0, 12) : null;
  } catch {
    return null;
  } finally {
    if (tmpIndex) { try { fs.unlinkSync(tmpIndex); } catch { /* ya no está */ } }
  }
}

/**
 * Cuenta las RONDAS de revisión del ledger: cada `step5-start` que produjo al menos un spawn de
 * ESTA story. Devuelve null si el ledger no trae ninguna marca — ahí la ronda no se puede medir,
 * y un número inventado sería peor que decir que no se sabe.
 *
 * 🔴 No alcanza con contar los `step5-start` a secas (que es lo que hace `advisor-ledger.js` para
 * otra cosa): sobre el ledger real de la story 2.3 eso da **51**, porque la suite
 * `advisor-set-config.test.js` escribía ráfagas de 12 marcas peladas en el ledger de la sesión
 * viva. Las rondas reales fueron 3. Por eso una marca sólo cuenta si produjo trabajo.
 */
function contarRondas(lines, story, esAdhoc) {
  let hayMarcas = false;
  let rondas = 0;
  let abierta = false;
  let conSpawn = false;
  for (const r of lines) {
    if (!r) continue;
    if (r.event === 'step5-start') {
      hayMarcas = true;
      if (abierta && conSpawn) rondas++;
      abierta = true; conSpawn = false;
      continue;
    }
    if (typeof r.advisor !== 'string' || !r.advisor) continue;
    if (esAdhoc(r.advisor)) continue;
    if (story != null && String(r.story) !== story) continue;
    if (abierta) conSpawn = true;
  }
  if (abierta && conSpawn) rondas++;
  return hayMarcas ? rondas : null;
}

/** Exploración libre: no son revisores (mismo set que on-advisor-run.js). */
const ADHOC = new Set(['general-purpose', 'Explore', 'Plan', 'claude']);

/**
 * Fuentes de hallazgos que NUNCA son un spawn: las escribe el propio pipeline. Exigirles asiento
 * en el roster frenaba prácticamente toda story real con hallazgos — el cruce findings↔roster es
 * para cazar un advisor inventado, no para pelearse con la contabilidad interna del pipeline.
 * (Medido en Pacara: casi todos los runs traen `mech-check` y `adversarial-verify:*`.)
 */
// 🔴 Por PREFIJO, no por nombre exacto (2026-09-06). Medido sobre los runs reales del disco,
// faltaban cinco fuentes —`orquestador`, `orquestador (smoke AC 15)`, `runtime-matrix (smoke AC
// 14)`, `ensayo runtime (no advisor)` y `adversarial-verify (3 lentes)`— y con la story 2.1 el
// portón daba `roster-incoherente` ×3 por ellas. La quinta es una variante escrita distinto de un
// patrón que YA estaba: una lista literal vuelve a morder con la próxima variante. El prefijo
// termina en espacio, paréntesis, dos puntos o fin: `orquestadorx` NO es el orquestador.
// La copia del portón de CI (`tycon-ci-gate.js`) es idéntica; `roster-validate-parity.test.js` lo cuida.
const FUENTES_SINTETICAS = [
  /^mech-check$/, /^pipeline$/,
  /^adversarial-verify(\s|:|\(|-|$)/,   // `-fable`, `-opus`: nombres reales de la 4.4 (2026-09-14)
  /^pase adversarial(\s|:|\(|-|$)/,     // el mismo paso 5b nombrado en castellano (AG-2, 2026-09-22)
  /^orquestador(\s|\(|$)/,
  /^runtime-matrix(\s|\(|$)/,
  /^e2e-runtime(\s|:|\(|-|$)/,          // el gate de E2E del step 7c: tampoco es un spawn (AG-3, 2026-09-22)
  /^ensayo runtime(\s|\(|$)/,
];

// 🔴 Ver el comentario gemelo en `scripts/ci/tycon-ci-gate.js` (2026-09-22, un pull request de un producto del equipo — guides/maintaining/incident-log.md#case-reviewer-name-mismatch-2026-09-22):
// el roster nombra al revisor desde el ledger (`tycon-silent-failure-hunter`) y el `advisor` de
// `findings.json` lo tipea el orquestador con la vuelta pegada (`... (iter 3)`). Comparar esos dos
// textos letra por letra frena PRs sanos. El paréntesis final es una anotación, nunca parte del id
// de un agente: se recorta sólo al final, así que no puede fusionar dos agentes distintos.
function nombreCanonico(nombre) {
  return String(nombre || '').replace(/\s*\([^()]*\)\s*$/, '').trim();
}
function esFuenteSintetica(nombre) {
  const n = String(nombre || '');
  const canon = nombreCanonico(n);
  return FUENTES_SINTETICAS.some((re) => re.test(n) || re.test(canon));
}

/**
 * Los TRAMOS de una corrida. Existen porque el roster y `findings.json` NO cubren el mismo pedazo:
 * el roster arranca en el último `step5-start` (la ronda de revisión) y los hallazgos son de toda
 * la corrida. Un hallazgo del paso 1 —la validación de la story, antes de implementar— quedaba
 * siempre como "revisor ausente" (un pull request de un producto del equipo, 2026-09-22 — guides/maintaining/incident-log.md#case-reviewer-name-mismatch-2026-09-22).
 *
 * 🔴 La salida NO es ensanchar la ventana del roster: ahí adentro está `general-purpose`, que tiene
 * Write y en los pasos 0-4 a veces IMPLEMENTA — certificarlo como revisor volvería falsa la
 * afirmación central de la pieza (lo cazó el pase adversarial). La salida es que cada hallazgo diga
 * de qué tramo viene y que el cruce compare tramo contra tramo.
 */
const TRAMO = { REVISION: 'revision', PREVIO: 'previo', PIPELINE: 'pipeline' };

/** Modelos que el orquestador pega al nombre. No es una lista de capacidades: es vocabulario. */
const MODELOS = new Set(['opus', 'sonnet', 'haiku', 'fable']);

/**
 * Separa el id del agente de la anotación que el orquestador le pega para que un humano la lea:
 * `tycon-silent-failure-hunter (iter 3)` → `{ advisor: 'tycon-silent-failure-hunter', iter: 3 }`.
 *
 * La anotación NO se pierde, se muda: la vuelta va a `iter`, el modelo a `model`, y cualquier otra
 * cosa a `nota`. Un finding no pierde nada y el cruce gana un id comparable — que es exactamente lo
 * que faltaba. Sólo se mira el paréntesis FINAL: los ids de agente son kebab-case y no llevan
 * paréntesis, así que esto no puede fusionar dos agentes distintos.
 */
function separarAnotacion(nombre) {
  const crudo = String(nombre || '').trim();
  const m = crudo.match(/^(.*?)\s*\(([^()]*)\)$/);
  if (!m) return { advisor: crudo };
  const out = { advisor: m[1].trim() };
  const restos = [];
  for (const parte of m[2].split(',').map((x) => x.trim()).filter(Boolean)) {
    const it = parte.match(/^iter\s*(\d+)$/i);
    if (it) { out.iter = Number(it[1]); continue; }
    if (MODELOS.has(parte.toLowerCase())) { out.model = parte.toLowerCase(); continue; }
    restos.push(parte);
  }
  if (restos.length) out.nota = restos.join(', ');
  return out.advisor ? out : { advisor: crudo };
}

/** Los nombres de una lista de revisores, con y sin su anotación. */
function nombresDe(lista) {
  const out = new Set();
  for (const r of (Array.isArray(lista) ? lista : [])) {
    if (!r || !r.agent) continue;
    out.add(r.agent);
    out.add(nombreCanonico(r.agent));
  }
  return out;
}

/**
 * ¿De qué tramo es este firmante en ESTA corrida? `null` = de ninguno, o sea que no corrió.
 * Es la pregunta que `write-findings` le hace al roster antes de escribir, y la que el cruce le
 * hace después. Una sola definición para los dos lados.
 */
function tramoDeFirmante(roster, nombre) {
  const n = String(nombre || '').trim();
  if (!n) return null;
  if (esFuenteSintetica(n)) return TRAMO.PIPELINE;
  const canon = nombreCanonico(n);
  if (nombresDe(roster && roster.reviewers).has(n) || nombresDe(roster && roster.reviewers).has(canon)) return TRAMO.REVISION;
  if (nombresDe(roster && roster.agentes_previos).has(n) || nombresDe(roster && roster.agentes_previos).has(canon)) return TRAMO.PREVIO;
  return null;
}

/** Los firmantes que esta corrida admite, para el mensaje de error de `write-findings`. */
function firmantesValidos(roster) {
  return {
    revision: [...new Set((roster && roster.reviewers || []).map((r) => r && r.agent).filter(Boolean))],
    previo: [...new Set((roster && roster.agentes_previos || []).map((r) => r && r.agent).filter(Boolean))],
    pipeline: FUENTES_SINTETICAS.map((re) => re.source),
  };
}

/** Nombre del archivo dentro del run dir. */
function rosterPath(runDir) { return path.join(runDir, ROSTER_FILE); }

/**
 * Modelo de un revisor, resuelto MECÁNICAMENTE en cascada. `source` dice cuál ganó — es la
 * diferencia entre un dato y una adivinanza (y el que lee el roster necesita saberlo).
 *   spawn  → el `model` del propio spawn, que el ledger ya registró (el más confiable)
 *   agente → el `model:` del frontmatter de ~/.claude/agents/<agente>.md
 *   heredado → ninguno de los dos: el subagente corrió con el modelo de la sesión
 */
function resolveModel(agentName, spawnModel, agentsDir) {
  if (spawnModel) return { model: String(spawnModel), model_source: 'spawn' };
  const dir = agentsDir || path.join(os.homedir(), '.claude', 'agents');
  try {
    const raw = fs.readFileSync(path.join(dir, `${agentName}.md`), 'utf8').slice(0, 4096);
    const m = raw.match(/^model:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m);
    if (m) return { model: m[1], model_source: 'agente' };
  } catch { /* el agente puede no existir en disco (Codex, agente ad-hoc) */ }
  return { model: null, model_source: 'heredado' };
}

/**
 * Modelo del IMPLEMENTADOR: se lee la cola del transcript de la sesión (últimos ~64 KB) y se toma
 * el `model` del último mensaje del asistente. Mecánico y barato — no lo redacta nadie.
 * Si el transcript no está o rotó, devuelve null: el campo es informativo y la regla del portón
 * no depende de él (nunca falla por esto).
 */
function modelFromTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const st = fs.statSync(transcriptPath);
    const size = st.size;
    const start = Math.max(0, size - 65536);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l.startsWith('{')) continue;
      try {
        const r = JSON.parse(l);
        const model = r && r.message && r.message.model;
        if (typeof model === 'string' && model) return model;
      } catch { /* línea partida por el corte de 64 KB: normal, se sigue */ }
    }
  } catch { /* sin transcript: campo informativo, no rompe nada */ }
  return null;
}

/**
 * Arma el roster desde las líneas del ledger de la sesión. PURA y testeable.
 *
 * @param {object} o
 * @param {Array<object>} o.lines  registros del ledger ({ts, advisor, model, repo, story} y eventos)
 * @param {string} o.story         story del marker (filtra: una sesión puede tocar varias)
 * @param {string} o.sessionId     sesión que implementó (la principal — los spawns son suyos)
 * @param {string} [o.implementerModel]
 * @param {string} [o.headSha]
 * @param {string} [o.agentsDir]
 * @param {object} [o.previo]      roster anterior, para mergear en el re-loop
 */
function build(o) {
  const story = o.story == null ? null : String(o.story);
  const iterPrevias = o.previo && Number.isFinite(o.previo.iterations) ? o.previo.iterations : 0;
  // `iter` marca en qué vuelta se vio a cada revisor. Sigue siendo la cuenta de escrituras: para
  // ESO sirve (es un ordinal interno, no una afirmación publicada).
  const iter = iterPrevias + 1;

  // 🔴 No todo spawn es un revisor. Dos filtros, y los dos son la pieza — sin ellos el roster
  // certificaba como "revisor" a `general-purpose` (el spawn MÁS frecuente del pipeline, que tiene
  // Write y en los pasos previos a veces IMPLEMENTA) y la afirmación central quedaba falsa:
  // un agente que escribió código figurando como quien lo revisó, firmado por el arnés.
  // Lo cazó el pase adversarial de la pieza, no la lectura del código.
  //   (a) sólo lo spawneado DESPUÉS del último `step5-start` — o sea la ronda de revisión, no la
  //       exploración ni la implementación de los pasos 0-4;
  //   (b) nunca los agentes de exploración libre (mismo set ADHOC que usa el hook).
  const todas = Array.isArray(o.lines) ? o.lines : [];
  let desde = 0;
  let hayCorte = false;
  for (let i = todas.length - 1; i >= 0; i--) {
    if (todas[i] && todas[i].event === 'step5-start') { desde = i + 1; hayCorte = true; break; }
  }
  // 🔴 «Previo» se mide contra la PRIMERA ronda, no contra la última (2026-09-22, lo confirmó el
  // pase adversarial). `reviewers` arranca en la ÚLTIMA marca a propósito (D2: no ensanchar), pero
  // para el otro tramo esa misma marca es el corte equivocado: entre la primera y la última hay
  // rondas de revisión ANTERIORES, y sus revisores son revisores, no agentes de los pasos 0-4.
  // Cortando por la última, un revisor real de la ronda 1 terminaba etiquetado «previo» en una
  // regeneración desde cero — y con eso, un `roster-incoherente` falso contra alguien que sí
  // revisó. El mismo falso positivo que esta story vino a matar, reencarnado un nivel más abajo.
  let desdePrimera = 0;
  for (let i = 0; i < todas.length; i++) {
    if (todas[i] && todas[i].event === 'step5-start') { desdePrimera = i; break; }
  }
  const relevantes = todas.slice(desde);
  // Los pasos 0-4 (validación de la story, exploración, implementación). NO son revisores y no se
  // los llama así: van a su propia lista para que un hallazgo de ese tramo tenga contra qué
  // compararse. El filtro ADHOC es el mismo, y es la salvaguarda: `general-purpose` no entra acá
  // tampoco. Sale del MISMO ledger — sigue siendo vista derivada, no una segunda fuente de verdad.
  //
  // 🔴 SIN marca de ronda no hay tramos (2026-09-22, lo confirmó el pase adversarial ejecutando el
  // caso). Cuando el roster se REGENERA desde el freno local, las líneas llegan por
  // `advisor-ledger.query().vivos`, que ya descartó los eventos: sin ningún `step5-start`, `desde`
  // queda en 0 y TODO parece ronda de revisión. Si igual se publicara `agentes_previos`, saldría
  // vacío y un hallazgo del paso 1 volvería a contarse como revisor ausente — el defecto original,
  // de vuelta y por una puerta lateral. Sin corte, el roster no afirma tramos: no publica la lista,
  // y el cruce cae solo a comparar contra las dos (que es lo que hace sin `tramo`).
  const previosVistos = new Map();
  for (const r of (hayCorte ? todas.slice(0, desdePrimera) : [])) {
    if (!r || typeof r.advisor !== 'string' || !r.advisor) continue;
    if (ADHOC.has(r.advisor)) continue;
    if (story != null && String(r.story) !== story) continue;
    if (previosVistos.has(r.advisor)) continue;
    const { model, model_source } = resolveModel(r.advisor, r.model, o.agentsDir);
    previosVistos.set(r.advisor, { agent: r.advisor, kind: 'subagente', model, model_source, ts: r.ts || null, tramo: 'previo' });
  }
  const vistos = new Map();
  for (const r of relevantes) {
    if (!r || typeof r.advisor !== 'string' || !r.advisor) continue;
    if (ADHOC.has(r.advisor)) continue;
    // Un spawn sin story NO se adopta: antes entraba al roster de cualquier story de la sesión.
    if (story != null && String(r.story) !== story) continue;
    const { model, model_source } = resolveModel(r.advisor, r.model, o.agentsDir);
    // Un mismo advisor puede correr en varias iteraciones: se conserva la PRIMERA vez que se lo vio
    // (cuándo entró a mirar) y se anota la última iteración en la que participó.
    const prev = vistos.get(r.advisor);
    if (prev) { prev.iter = iter; continue; }
    vistos.set(r.advisor, { agent: r.advisor, kind: 'subagente', model, model_source, ts: r.ts || null, iter });
  }

  // Merge con el roster previo (re-loop): los revisores de la vuelta anterior no se pisan.
  const reviewers = [];
  const yaEn = new Set();
  for (const rev of (o.previo && Array.isArray(o.previo.reviewers) ? o.previo.reviewers : [])) {
    if (!rev || typeof rev.agent !== 'string') continue;
    reviewers.push(rev); yaEn.add(rev.agent);
  }
  for (const [agent, rev] of vistos) {
    if (yaEn.has(agent)) {
      const ex = reviewers.find((x) => x.agent === agent);
      if (ex) ex.iter = rev.iter;
      continue;
    }
    reviewers.push(rev);
  }

  // ── Cuántas RONDAS de revisión hubo ────────────────────────────────────────────────────────
  // Antes se publicaba `iter` (la cuenta de ESCRITURAS del archivo) como si fueran rondas. En la
  // story 2.3 eso publicó `iterations: 2` habiendo habido 3 rondas: el roster se escribe cuando el
  // hook pasa, no una vez por vuelta. Ahora sale del ledger, que es donde está el dato — y el
  // roster DICE de dónde salió, igual que `model_source` dos campos más arriba: un número medido y
  // uno estimado no pueden verse iguales.
  const rondas = contarRondas(todas, story, (a) => ADHOC.has(a));
  const iterationsSource = rondas == null ? 'escrituras' : 'ledger';
  // Las rondas nunca bajan: si una vuelta anterior (otra sesión, otro ledger) contó más, se respeta.
  const iterations = rondas == null ? iter : Math.max(rondas, iterPrevias);

  const roster = {
    version: VERSION,
    story,
    written_by: 'on-advisor-run.js',
    ts: new Date().toISOString(),
    // `base_sha` — el commit SOBRE EL QUE se revisó. Se llamaba `head_sha`, y ese nombre invitaba
    // a leerlo como "el árbol revisado", que es justo lo que NO es: la implementación se commitea
    // después de la revisión. Lo que se revisó lo sella `tree_sha`.
    base_sha: o.headSha || null,
    tree_sha: o.treeSha || null,
    implementer: {
      kind: 'sesion-principal',
      session_id: o.sessionId || null,
      model: o.implementerModel || (o.previo && o.previo.implementer && o.previo.implementer.model) || null,
    },
    reviewers,
    iterations,
    iterations_source: iterationsSource,
    // Esta corrida la hizo un arnés que anota cada aprobación en `approvals.jsonl`. El portón de CI exige
    // el registro (y su línea del plan) sólo con esta marca: un roster de un arnés anterior no la trae, y ahí la falta
    // avisa. Campo opcional: `VERSION` no se toca.
    registro_aprobaciones: 1,
  };
  // Se publica sólo si hay algo que decir: un roster sin hallazgos de los pasos 0-4 no gana una
  // lista vacía, y los rosters ya commiteados se siguen leyendo igual (el campo es opcional, y por
  // eso `VERSION` NO se toca — bumpearla invalidaría todos los rosters que ya viajaron).
  const previosMerge = new Map();
  for (const p of (o.previo && Array.isArray(o.previo.agentes_previos) ? o.previo.agentes_previos : [])) {
    if (p && typeof p.agent === 'string') previosMerge.set(p.agent, p);
  }
  for (const [agent, p] of previosVistos) if (!previosMerge.has(agent)) previosMerge.set(agent, p);
  // 🔴 Nadie está en las dos listas, y ante la duda gana REVISOR (2026-09-22, lo confirmó el pase
  // adversarial). En un re-loop, los revisores de la ronda anterior quedan ANTES del último
  // `step5-start`, así que el barrido de arriba los clasifica como «previos». Mientras el roster
  // anterior exista eso no se nota (el merge de `reviewers` los conserva), pero en una regeneración
  // desde cero salían de `reviewers` y aparecían en `agentes_previos`: un revisor REAL degradado de
  // tramo, y un `roster-incoherente` falso contra él la próxima vez que firmara un hallazgo. Es el
  // mismo falso positivo que la story vino a matar, reencarnado. Con el roster previo o sin él, el
  // resultado tiene que ser el mismo.
  const yaEsRevisor = new Set(reviewers.map((r) => r && r.agent).filter(Boolean));
  for (const agent of [...previosMerge.keys()]) if (yaEsRevisor.has(agent)) previosMerge.delete(agent);
  if (previosMerge.size) roster.agentes_previos = [...previosMerge.values()];
  // La excusa escrita, si el run anterior la traía, viaja (la escribe una persona a mano —
  // ver `validate` y el gate local).
  if (o.previo && typeof o.previo.sin_testigo === 'string') roster.sin_testigo = o.previo.sin_testigo;
  return roster;
}

/** Lee el roster de un run dir. Devuelve null si no está; lanza si está y no parsea. */
function read(runDir) {
  let raw;
  try { raw = fs.readFileSync(rosterPath(runDir), 'utf8'); } catch { return null; }
  return JSON.parse(raw);
}

/** Escribe (idempotente: mergea con el previo si existe). Devuelve el roster escrito. */
function write(runDir, o) {
  let previo = null;
  try { previo = read(runDir); } catch { previo = null; } // roster roto: se reescribe entero
  const roster = build({ ...o, previo });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(rosterPath(runDir), `${JSON.stringify(roster, null, 2)}\n`, 'utf8');
  return roster;
}

/**
 * Validación compartida por el gate local y el portón de CI — una sola definición de "válido",
 * para que las dos capas no puedan opinar distinto.
 * @returns {{ok:boolean, problemas:Array<{regla:string, detalle:string}>}}
 */
function validate(roster, opts) {
  const problemas = [];
  const add = (regla, detalle) => problemas.push({ regla, detalle });
  if (!roster || typeof roster !== 'object') {
    add('registro-de-autoria-invalido', 'el roster no es un objeto JSON');
    return { ok: false, problemas };
  }
  if (roster.version !== VERSION) {
    add('registro-de-autoria-invalido', `version ${JSON.stringify(roster.version)} desconocida (esperada ${VERSION})`);
  }
  const impl = roster.implementer;
  if (!impl || typeof impl !== 'object' || !impl.kind) {
    add('registro-de-autoria-invalido', 'falta el bloque implementer');
  }
  const revs = Array.isArray(roster.reviewers) ? roster.reviewers : null;
  if (!revs) {
    add('registro-de-autoria-invalido', 'reviewers no es una lista');
  } else if (revs.length === 0) {
    add('sin-revisores', 'el roster no lista ningún revisor');
  } else {
    for (const r of revs) {
      if (!r || typeof r.agent !== 'string' || !r.agent) {
        add('registro-de-autoria-invalido', 'hay un revisor sin nombre de agente');
        continue;
      }
      // 🔴 La regla que da nombre a la pieza: el que escribió el código no puede ser el que lo
      // revisa. En el pipeline eso es estructural (revisores = subagentes), así que un revisor
      // marcado como la sesión principal sólo puede venir de un roster escrito a mano.
      if (r.kind === 'sesion-principal' || (impl && impl.session_id && r.session_id && r.session_id === impl.session_id && r.kind !== 'subagente')) {
        add('revisor-es-el-autor', `"${r.agent}" figura como revisor pero es la sesión que implementó`);
      }
    }
  }
  // Coherencia con los hallazgos: si findings nombra un advisor que el roster no lista, uno de los
  // dos miente. Es lo único de la verificación cruzada que se puede hacer del lado del servidor.
  const advisoresEnFindings = (opts && Array.isArray(opts.advisoresEnFindings)) ? opts.advisoresEnFindings : null;
  if (advisoresEnFindings && revs) {
    // Cada firmante puede venir como texto pelado (la forma vieja, que sigue valiendo) o como
    // `{advisor, tramo}` — que es lo que escribe `write-findings` desde la story 7.13. Con el tramo
    // declarado se compara contra la lista de ESE tramo; sin él, contra las dos.
    const enRevision = nombresDe(revs);
    const enPrevios = nombresDe(roster.agentes_previos);
    for (const item of advisoresEnFindings) {
      const a = (item && typeof item === 'object') ? item.advisor : item;
      const tramo = (item && typeof item === 'object') ? item.tramo : null;
      if (!a || typeof a !== 'string') continue;
      if (esFuenteSintetica(a)) continue;
      const canon = nombreCanonico(a);
      const listas = tramo === TRAMO.PREVIO ? [enPrevios]
        : tramo === TRAMO.REVISION ? [enRevision]
          : [enRevision, enPrevios];
      if (!listas.some((set) => set.has(a) || set.has(canon))) {
        // 🔴 Ver el comentario gemelo en `scripts/ci/tycon-ci-gate.js`: `validado` dice que este
        // hallazgo traía su `tramo`, y el tramo lo escribe `write-findings` sólo cuando la
        // validación contra el registro ocurrió de verdad. Con eso el canal puede distinguir una
        // incoherencia REAL de una del formato viejo, que nadie validó y sigue avisando.
        const p = { regla: 'roster-incoherente', detalle: tramo === TRAMO.PREVIO
          ? `"${a}" reportó hallazgos del tramo previo al paso 5 y no figura entre los agentes de ese tramo`
          : `"${a}" reportó hallazgos pero no figura entre los revisores` };
        if (tramo) p.validado = true;
        problemas.push(p);
      }
    }
  }
  return { ok: problemas.length === 0, problemas };
}

module.exports = {
  FUENTES_SINTETICAS,   // exportada para el test de paridad con el portón de CI (2026-09-06)
  nombreCanonico,
  TRAMO, separarAnotacion, tramoDeFirmante, firmantesValidos, esFuenteSintetica,
  ROSTER_FILE, VERSION,
  rosterPath, resolveModel, modelFromTranscript, treeShaDe, build, read, write, validate,
};
