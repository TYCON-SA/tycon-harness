/**
 * pipeline-rounds.js — una parte de pipeline.js (el despachador la carga para sus subcomandos).
 *
 * Responsabilidad: las vueltas de revisores: la ronda y la vuelta inteligente.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { STEPS_TABLE, at, companionLib, deriveStoryId, fs, logGate, os, path, readSessionMarker, resolveRunDir, sessionIdFileKey, stateDirOf } = require('./pipeline-shared.js');
const { PRECHEQUEO, aplicarModelosDeRevisores, buildAdvisorContext, conLanzadorCodex, congelarVuelta, contextoConLaCopia, emptyWorkGate, logStep5Start, reglasRevisores, reloopHintsFor, resumenReglas, rethinkGate, salidaDelFreno, validateFilesExist, fotoAlLanzar } = require('./pipeline-advisor-context.js');
const { MECH_NUNCA_SACA, advisorAffectedByDelta, aplicarDecisionValidador, computeAdvisorSet, computeMechDiscount, readSessionMarkerStrict, revisoresPorConfirmar, salidaGrande, sumarPorConfirmar } = require('./pipeline-advisor-set.js');
const { conModelosDeLaCorrida, decirModelos } = require('./pipeline-models.js');
const honesty = require('./ledger-honesty.js');

/**
 * Los críticos que findings.json da por arreglados (o abiertos) y que no reportó ningún revisor de la corrida: salieron
 * de mech-check, van directo al reporte y el cruce de «Hallazgos» no los mira, porque sólo mira el registro. Los vuelve a
 * comprobar mech-check en la vuelta. `{ reglas, error }`; sin marcador de esta historia, ninguno. Un registro o un
 * findings.json que no se leen dan `error`: no se puede saber cuáles son.
 */
function criticosMecanicos(args) {
  const vacio = { reglas: [], error: null };
  if (!args.story) return vacio;
  const leido = readSessionMarkerStrict();
  if (leido.estado === 'ilegible') return { ...vacio, error: `el marcador de la sesión (${leido.motivo})` };
  const marker = leido.marcador;
  if (!marker || !marker.storyPath) return vacio;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const suya = path.isAbsolute(marker.storyPath) ? marker.storyPath : path.resolve(marker.repoPath || process.cwd(), marker.storyPath);
  if (real(suya) !== real(args.story)) return vacio;
  const rc = require('./reported-criticals.js');
  const runDir = marker.runDir ? path.resolve(marker.repoPath || args.repo || process.cwd(), marker.runDir)
    : resolveRunDir(marker.repoPath || args.repo || process.cwd(), String(marker.storyId), false, suya, { marker });
  const h = require('./review-rounds.js').hallazgosDe(runDir);
  if (h.error && h.existe) return { ...vacio, error: `los hallazgos de la corrida (${h.error})` };
  const vivos = (h.lista || []).filter((f) => String(f.severity || '').toUpperCase() === 'CRITICAL'
    && ['fixed', 'open'].includes(String(f.disposition || '').toLowerCase()) && (f.rule_id || f.rule));
  if (!vivos.length) return vacio;
  const all = rc.readAll(stateDirOf(os.homedir()));
  if (all.error) return { ...vacio, error: `el registro de críticos (${all.error})` };
  const lines = rc.linesOfRun(all.lines, { story: marker.storyId, since: marker.startedAt || null, ...rc.corridaDelMarcador(marker, runDir) });
  const reportadas = new Set(lines.filter((l) => l.kind === 'report').flatMap((l) => (l.criticals || []).map((c) => c.rule)));
  const reglas = [...new Set(vivos.map((f) => String(f.rule_id || f.rule)).filter((r) => !reportadas.has(r)))];
  // por regla, cuántos tienen ya su destino (diferido, refutado, eximido): mech-check los puede seguir reportando
  const conDestino = {};
  for (const r of reglas) {
    conDestino[r] = (h.lista || []).filter((f) => String(f.rule_id || f.rule) === r && String(f.severity || '').toUpperCase() === 'CRITICAL'
      && ['deferred', 'refuted', 'waived'].includes(String(f.disposition || '').toLowerCase())).length;
  }
  // Las reglas del pase adversarial ya arregladas con su prueba: el pase no se repite y ningún revisor las tiene, así que
  // su prueba es lo que las confirma. Todas sus instancias vivas tienen que ser del pase, `fixed` y con una prueba que
  // está en el repo. El firmante del pase lo puede escribir cualquiera en findings.json: lo que lo ata al pase es su
  // anotación en el marcador (mark-adversarial-result), medida, que dice cuántos confirmados quedaron con su prueba. Si
  // hay más críticos firmados por el pase que esos, ninguno cuenta (uno de ellos no es del pase).
  const delPase = /^(adversarial-verify|pase adversarial)(\s|:|\(|-|$)/i;
  const raiz = marker.repoPath || args.repo || process.cwd();
  const pruebaEnElRepo = (f) => {
    const p = String(f.test || f.prueba || '').trim().split('::')[0].trim();
    if (!p || path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) return false;
    try { return fs.statSync(path.join(raiz, p)).isFile(); } catch { return false; }
  };
  const pase = (Array.isArray(marker.adversarialPasses) ? marker.adversarialPasses : [])
    .filter((p) => p && p.tipo === '5b' && p.veredicto !== 'no-medido').pop();
  const cupo = pase ? (Number(pase.pruebas) || 0) + (Number(pase.propias) || 0) : 0;
  const firmadosPorElPase = vivos.filter((f) => delPase.test(String(f.advisor || '').trim()));
  const candidatas = reglas.filter((r) => vivos.filter((f) => String(f.rule_id || f.rule) === r).every((f) => delPase.test(String(f.advisor || '').trim())
    && String(f.disposition || '').toLowerCase() === 'fixed' && pruebaEnElRepo(f)));
  const conPruebaDelPase = firmadosPorElPase.length <= cupo ? candidatas : [];
  return { ...vacio, reglas, conDestino, conPruebaDelPase };
}

// Las reglas que mech-check mira siempre sobre la historia, haga lo que haga el cambio: su ausencia en una vuelta quiere
// decir que se arregló. Las demás (DEFTR mira los archivos que se le pasan, WIRING depende del paquete, las de los
// revisores no las corre) no se pueden comprobar así.
const REGLAS_QUE_MECH_COMPRUEBA = new Set(['ACCOV-C1', 'ACCOV-C5']);

// ── Lo que ve GIT — la 4ta fuente del delta, y la única que no depende del hook ──
// Las otras tres (nombres nuevos, fileEvents, mtime) salen todas de `marker.filesTouched`, que
// escribe on-edit.js desde PostToolUse matcher Edit|Write. Incluso el fallback por mtime ITERA
// sobre filesTouched — o sea que cubre "un archivo que el hook ya vio y se re-editó por fuera",
// NO "un archivo que el hook no vio nunca". Ese agujero deja ciego al re-loop (ver
// lib/ledger-honesty.js). git no tiene ese punto ciego: ve el working tree.
function gitArchivosDelWorkingTree(repo) {
  const { execFileSync } = require('child_process');
  const correr = (args) => {
    try {
      return execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/).filter(Boolean);
    } catch { return []; }   // sin git / no es repo → fail-open: la ceguera no se puede diagnosticar
  };
  // 🔴 La base de los paths es la RAÍZ del repo git, NO el `--repo` que nos pasaron.
  // Con `--repo` apuntando a un subdirectorio —un monorepo, o el caso
  // normal de estos repos con varios proyectos adentro— `path.join(repo, f)` armaría rutas
  // inexistentes: la 4ta fuente quedaría inerte (ningún statSync encontraría nada) justo en los
  // repos donde más falta hace. Se pregunta la raíz y se recorta a lo que cae dentro de --repo.
  const raizGit = (correr(['rev-parse', '--show-toplevel'])[0] || repo);
  const rel = [
    ...correr(['diff', '--name-only', 'HEAD']),
    ...correr(['ls-files', '--others', '--exclude-standard']),
  ];
  // realpath en las DOS puntas: en macOS `os.tmpdir()` y `/tmp` son symlinks a `/private/...`, y
  // `git rev-parse --show-toplevel` devuelve el path YA resuelto. Comparar uno resuelto contra uno
  // sin resolver descartaría TODOS los archivos y dejaría la 4ta fuente inerte.
  const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const dentro = real(repo);
  return [...new Set(rel)]
    .map((f) => real(path.resolve(raizGit, f)))
    .filter((abs) => abs === dentro || abs.startsWith(`${dentro}${path.sep}`));
}

/**
 * El re-loop reducido, con los modelos de la organización: en sus tres caminos, `reviewer_models` para
 * los revisores que se vuelven a correr cuando hay configuración o pedido (`args.orgModels`, `args.modelRequests`);
 * sin eso, `reloop_model_hints`. Los avisos quedan en `_avisos` (los dice la línea de comandos).
 */
function computeSmartReloop(args) {
  const out = computeSmartReloopBase(args);
  const avisos = aplicarModelosDeRevisores(out, out.rerun || out.all || [], args, out.all || out.rerun || []);
  if (avisos.length) Object.defineProperty(out, '_avisos', { value: avisos, enumerable: false });
  return out;
}

function computeSmartReloopBase({ repo, story, files, iter, forceFullReloop, costTier }) {
  const fullSet = computeAdvisorSet({ repo, story, files });

  if (forceFullReloop || iter <= 1) {
    const out = {
      ...fullSet,
      iter,
      mode: forceFullReloop ? 'force-full-reloop' : 'iter1-full',
      rerun: fullSet.all,
      skipped: [],
      delta_files: [],
    };
    // El path force-full (el MÁS caro — set completo en
    // re-loop) sin reloop_model_hints haría que los tier deep corrieran a Opus pleno.
    const hints = reloopHintsFor(fullSet.all, iter, costTier);
    if (hints) {
      out.reloop_model_hints = hints;
      out.reloop_model_hints_note = 'tier deep (Opus) → sonnet en re-loop: el juicio de scope grande ya corrió en iter 1; ignorá el hint SOLO si el delta toca specs.';
    }
    return out;
  }

  const marker = readSessionMarker();
  // La vuelta de antes es la última que dejó foto: una vuelta sin agentes (todos salteados, o cerrada sola porque el cambio
  // no traía código) no la deja, y caer al set completo relanzaba a todos los revisores. Comparar contra una foto
  // anterior sólo suma lo cambiado desde ella: nunca saltea a un revisor que tenga algo nuevo para ver.
  // La foto de una vuelta: la de siempre (`iterations`, al lanzar su último revisor) o, si su ronda no se completó, la que
  // guardó al lanzarse (`fotosAlLanzar`), sólo si es de esta historia
  const fotoDe = (n) => {
    const it = at(at(marker, 'iterations'), String(n));
    if (it && Array.isArray(it.filesSnapshot)) return it;
    const al = at(at(marker, 'fotosAlLanzar'), String(n));
    if (al && Array.isArray(al.filesSnapshot) && String(al.story) === String(at(marker, 'storyId') || null)) return { ...al, alLanzar: true };
    return null;
  };
  let prev = iter - 1;
  while (prev > 1 && !fotoDe(prev)) prev -= 1;
  const fotoPrevia = fotoDe(prev);
  // se dice: una vuelta que sí lanzó revisores y no guardó su foto también cae acá, y no tiene que pasar callada
  if (prev < iter - 1 && fotoPrevia) {
    process.stderr.write(`⚠️  la vuelta ${iter - 1} no dejó foto (sin agentes): mido lo cambiado desde la foto de la vuelta ${prev}.\n`);
  }
  const prevSnapshot = fotoPrevia && fotoPrevia.filesSnapshot;
  if (!prevSnapshot) {
    const out = {
      ...fullSet,
      iter,
      mode: 'no-prev-snapshot-fallback',
      // sin la foto de la vuelta anterior, el set completo; tomarla ahora sellaría como revisado lo que cambió después
      warning: `no hay foto de la vuelta ${prev} (marker.iterations[${prev}].filesSnapshot): se re-corre el set completo. ` +
               'No la tomes ahora con snapshot-iter: quedaría como revisado lo que cambió después de esa vuelta.',
      rerun: fullSet.all,
      skipped: [],
      delta_files: [],
    };
    // Este es un path iter>1 con set
    // COMPLETO (el más caro) — también emite hints: TODA invocación iter>1 los emite.
    const hints = reloopHintsFor(fullSet.all, iter, costTier);
    if (hints) {
      out.reloop_model_hints = hints;
      out.reloop_model_hints_note = 'tier deep (Opus) → sonnet en re-loop: el juicio de scope grande ya corrió en iter 1; ignorá el hint SOLO si el delta toca specs.';
    }
    return out;
  }

  // 🔴 Los probes se filtran ACÁ, no sólo en la foto. Filtrar
  // únicamente el `filesSnapshot` dejaría `filesTouched` con los probes adentro, y `deltaByName`
  // compara uno contra otro: cada probe aparecería como "archivo nuevo" en la iteración 2 — y en la
  // 3, y en todas, porque la foto se re-filtra y la lista cruda no. Efecto: delta fantasma
  // de 3 archivos sin que nadie haya editado nada, un advisor de más por iteración, y de yapa
  // apagaría el guard `suspect_empty_delta`. O sea que filtrar a medias reintroduciría la contaminación que viene a cerrar.
  // 🔴 Lo que cae FUERA del repo tampoco es trabajo del repo: los cazadores del pase adversarial escriben
  // `/tmp/probe.*`, el hook de ediciones los registra y la
  // iteración 2 los contaría en el delta. Esos nombres no siguen la convención de probes, así que el filtro
  // por nombre no los ve; el filtro por lugar sí. Se conserva la carpeta de la story: en los productos
  // con repo de specs aparte, la story vive fuera de `--repo` y editarla es trabajo de la corrida.
  // 🔴 Los repos hermanos también: en una story de dos repos, los arreglos del hermano quedarían afuera del
  // delta y los revisores de su superficie se saltearían por «superficie no tocada».
  // Sus archivos entran por las mismas fuentes que los del repo.
  const hermanosDelDelta = companionLib.companionRoots(repo, story, {
    onMissing: (nombre, quien) => process.stderr.write(`⚠ el repo hermano «${nombre}» que declara ${companionLib.label(quien)}/.tycon/advisors.yaml no está en disco: sus ediciones no entran al delta\n`),
  });
  const raicesDelDelta = [repo, ...(story ? [path.dirname(path.resolve(String(story)))] : []), ...hermanosDelDelta];
  const workingTreeDeTodos = () => [repo, ...hermanosDelDelta].flatMap((r) => gitArchivosDelWorkingTree(r));
  const delRepo = (files) => files.filter((f) => raicesDelDelta.some((r) => honesty.esDelRepo(f, r)));
  // sin los probes del pase adversarial ni lo que el pipeline escribe en .advisors/: no es trabajo del repo
  const currentFiles = delRepo(honesty.sinRuido(marker.filesTouched || []));
  const prevSet = new Set(prevSnapshot);
  // Delta por NOMBRES nuevos (legacy) — atrapa archivos que aparecieron en iter N.
  const deltaByName = currentFiles.filter((f) => !prevSet.has(f));
  // Delta por EVENTOS de edición: un archivo YA tocado
  // en iter N-1 que se RE-EDITA en iter N (el caso típico del fix-loop) no aparece
  // en deltaByName porque filesTouched dedupea — sin eventos, el advisor que
  // reportó el finding NUNCA re-auditaría su propio fix.
  // marker.fileEvents (escritos por on-edit.js directo; marker.js append-file existe como CLI manual)
  // conserva cada edición con ts; delta = ediciones POSTERIORES al snapshot previo.
  const prevTs = fotoPrevia.ts;
  // ── SEGUNDA CAPA: el corte es el ÚLTIMO REVISOR, no la hora de la foto ────────────
  // La hora de la foto es justamente el dato que puede estar mal: si fecha la foto de una iteración a las 17:03 con
  // un arreglo de las 16:58 adentro, el delta de la siguiente
  // sale VACÍO → `security-basics` y `silent-failure-hunter` se saltean por «superficie no
  // tocada». La guarda de `marker.js snapshot-iter` cierra el caso en origen; ésta es la que cubre
  // lo que aquélla no puede ver: TYCON_SNAPSHOT_GUARD=0, una foto escrita a mano en el marker, o un
  // `snapshot-iter` viejo de una máquina con el arnés atrasado. Al momento de calcular, el último
  // `step5-start` del registro ES el de `iter-1` (acá se calcula; `logStep5Start` anota el nuevo
  // después). Sin registro → corte = la foto, como siempre.
  let ultimoRevisorMs = null;
  let lineasRegistro = null;
  try {
    const lp = path.join(stateDirOf(os.homedir()), 'advisor-runs', `${sessionIdFileKey()}.jsonl`);
    lineasRegistro = fs.readFileSync(lp, 'utf8').split('\n');
  } catch { /* sin registro de spawns → el corte sigue siendo la foto, y la vista por revisor no se mide */ }
  try {
    const { ultimoRevisorDeLaRonda } = require('./late-snapshot.js');
    const ur = ultimoRevisorDeLaRonda(lineasRegistro || [], prev);
    if (Number.isFinite(ur.ts)) ultimoRevisorMs = ur.ts;
  } catch { /* ídem */ }
  // El PRIMER revisor de la vuelta: un arreglo hecho después de que salió el primero y antes del
  // último quedaba adentro de la foto; cortando en el último, el delta no lo traía y la vuelta se cerraba sola con el
  // texto de la historia. Sólo revisores (`esRevisor`): una exploración lanzada antes no mueve el corte. Qué revisores se
  // re-corren lo sigue decidiendo la vista por revisor
  let primerRevisorMs = null;
  try {
    const ls = require('./late-snapshot.js');
    const v = ls.vistaPorRevisor(lineasRegistro || [], prev);
    for (const [adv, t] of v.lanzamientos || []) if (ls.esRevisor(adv) && Number.isFinite(t) && (primerRevisorMs === null || t < primerRevisorMs)) primerRevisorMs = t;
  } catch { /* sin registro, el corte es la foto o el último revisor, como antes */ }
  // Delta = UNIÓN de TRES fuentes (si fileEvents y mtime fueran either/or,
  // un fileEvents truncado, p.ej. por un
  // `marker.js set` mid-pipeline, o ediciones hechas SOLO por Bash
  // (sed/heredoc, fuera del hook Edit|Write), SUPRIMIRÍA el fallback por mtime y
  // las re-ediciones caerían del delta en silencio):
  //   1. nombres nuevos (deltaByName — archivos que aparecieron en iter N),
  //   2. fileEvents posteriores al snapshot (escritos por on-edit.js),
  //   3. mtime de filesystem > ts del snapshot (cubre ediciones fuera del hook).
  // Conservador en la dirección correcta: un falso positivo = un advisor de más;
  // un falso negativo = un fix sin re-auditar.
  let deltaByEvents = [];
  let deltaByMtime = [];
  const deltaByGit = [];
  const sources = ['nombres nuevos'];
  const prevTsMs = prevTs ? new Date(prevTs).getTime() : NaN;
  // ¿La foto se fechó DESPUÉS del último revisor? Entonces el corte honesto es el último revisor:
  // lo editado en el medio no lo vio nadie. Nunca al revés — un corte MÁS TARDE que la foto perdería
  // ediciones, que es exactamente el defecto.
  const fotoTardia = Number.isFinite(ultimoRevisorMs) && Number.isFinite(prevTsMs) && ultimoRevisorMs < prevTsMs;
  const horaDe = new Map();          // path → ms de la edición que lo mete en el delta
  if (prevTs) {
    const cutoff = Number.isFinite(primerRevisorMs) && Number.isFinite(prevTsMs) ? Math.min(primerRevisorMs, prevTsMs) : fotoTardia ? ultimoRevisorMs : prevTsMs;
    if (Array.isArray(marker.fileEvents) && marker.fileEvents.length) {
      deltaByEvents = delRepo(honesty.sinRuido([...new Set(
        marker.fileEvents
          .filter((e) => e && e.path && e.ts && new Date(e.ts).getTime() > cutoff)
          .map((e) => e.path),
      )]));
      for (const e of marker.fileEvents) {
        if (!e || !e.path || !e.ts) continue;
        const t = new Date(e.ts).getTime();
        if (Number.isFinite(t) && t > cutoff && !horaDe.has(e.path)) horaDe.set(e.path, t);
      }
      sources.push('fileEvents post-snapshot');
    }
    for (const f of currentFiles) {
      try {
        const mt = fs.statSync(f).mtimeMs;
        if (mt > cutoff) { deltaByMtime.push(f); if (!horaDe.has(f)) horaDe.set(f, mt); }
      } catch { /* archivo borrado/inaccesible → names-only lo cubre si es nuevo */ }
    }
    sources.push('mtime de filesystem post-snapshot');
    // 4ta fuente: el working tree según git, filtrado por mtime posterior a la foto.
    // Las tres de arriba iteran sobre `filesTouched` — si el hook nunca vio el archivo, ninguna lo
    // encuentra. Ésta sí. Los probes del pase adversarial NO cuentan (no son trabajo del repo).
    for (const f of honesty.sinRuido(workingTreeDeTodos())) {
      try {
        const mt = fs.statSync(f).mtimeMs;
        if (mt > cutoff) { deltaByGit.push(f); if (!horaDe.has(f)) horaDe.set(f, mt); }
      } catch { /* ídem */ }
    }
    if (deltaByGit.length) sources.push('git working-tree post-snapshot');
    if (Number.isFinite(primerRevisorMs) && primerRevisorMs < prevTsMs) sources.push('corte en el primer revisor de la vuelta (lo editado mientras corría no se da por visto)');
    else if (fotoTardia) sources.push('corte movido al último revisor (la foto se fechó después)');
  }
  const deltaSource = prevTs
    ? `unión(${sources.join(' ∪ ')})`
    : 'names-only (sin ts de snapshot previo — el delta puede PERDER re-ediciones → usá --force-full-reloop si hubo fixes sobre archivos existentes)';
  const delta = [...new Set([...deltaByName, ...deltaByEvents, ...deltaByMtime, ...deltaByGit])];

  // ── ¿El registro ve lo que ve git? ──
  // Antes de devolver un delta "chico", la pregunta honesta: ¿el registro de ediciones aportó
  // ALGO del repo? Si git ve trabajo y el registro no aporta nada, el delta no es chico: es
  // ciego, y el modo correcto es el set COMPLETO **anunciado con la razón**. Sin eso el orquestador
  // llegaría igual a force-full, pero a ciegas y más tarde, sin saber por qué.
  const diag = honesty.diagnosticar({
    repoPath: repo,
    registro: [...currentFiles, ...(Array.isArray(marker.fileEvents) ? marker.fileEvents.map((e) => e && e.path) : [])],
    gitCambiados: gitArchivosDelWorkingTree(repo),
  });
  if (diag.ciego) {
    logGate({
      repoPath: repo, name: 'smart-reloop', check: 'ledger-honesty', status: 'blind', iter,
      gitFiles: diag.gitUtil.length, registroFiles: 0,
      probesDescartados: diag.probesDescartados.length, fueraDelRepo: diag.fueraDelRepo.length,
    });
    const out = {
      ...fullSet,
      iter,
      mode: 'force-full-reloop',
      ledger_blind: true,
      ledger_blind_reason: diag.razon,
      git_sees: diag.gitUtil,
      rerun: fullSet.all,
      skipped: [],
      delta_files: [],
      note: 'set COMPLETO por registro ciego, no por elección — ver ledger_blind_reason. ' +
            'El delta que se habría devuelto NO medía nada: los archivos del repo no estaban en el registro.',
    };
    const hintsCiego = reloopHintsFor(fullSet.all, iter, costTier);
    if (hintsCiego) {
      out.reloop_model_hints = hintsCiego;
      out.reloop_model_hints_note = 'tier deep (Opus) → sonnet en re-loop: el juicio de scope grande ya corrió en iter 1; ignorá el hint SOLO si el delta toca specs.';
    }
    return out;
  }

  // ── La versión del cambio que vio CADA revisor ─────────────────────────────────────
  // 🔴 El delta de arriba es de la VUELTA: mira desde la foto, y la foto se toma sola al lanzar el
  // último revisor. Un arreglo hecho mientras corrían los demás, antes de ese último lanzamiento, queda
  // adentro de la foto: el delta no lo trae y el revisor que se había lanzado ANTES del arreglo —que no
  // lo vio— se saltearía por «superficie no tocada». Por eso, para cada revisor, también cuenta lo
  // editado después de SU lanzamiento (la hora la escribe el hook en cada spawn real).
  // Sólo SUMA: el delta de la vuelta se sigue aplicando igual a todos, así que nadie que entre por él
  // puede quedar afuera por esto.
  //   · lanzado en la vuelta anterior → lo editado después de su lanzamiento;
  //   · no estaba en esa vuelta (la anterior lo había salteado) → lo editado desde que arrancó la vuelta;
  //   · estaba en la vuelta y no consta su lanzamiento, o no hay registro de la vuelta → no se sabe qué
  //     vio: se re-corre por las dudas, y se dice.
  let vista;
  try {
    vista = require('./late-snapshot.js').vistaPorRevisor(lineasRegistro || [], prev);
  } catch (e) {
    vista = { medible: false, motivo: `no se pudo leer el registro de lanzamientos (${(e && e.message) || e})` };
  }
  // Cada revisor leyó la copia sellada de su vuelta, así que un arreglo hecho después del sello no lo vio aunque se haya
  // lanzado más tarde: su lanzamiento no cuenta después de la hora del sello. La hora es la de la foto al lanzar de esa
  // vuelta (de esta historia), también cuando la ronda se completó y la base es la foto de siempre.
  const alLanzarDeLaPrevia = fotoPrevia.alLanzar ? fotoPrevia : (() => {
    const al = at(at(marker, 'fotosAlLanzar'), String(prev));
    return al && String(al.story) === String(at(marker, 'storyId') || null) ? al : null;
  })();
  if (vista.medible && alLanzarDeLaPrevia && vista.lanzamientos instanceof Map) {
    const selloMs = Date.parse(alLanzarDeLaPrevia.ts);
    if (Number.isFinite(selloMs)) for (const [adv, t] of vista.lanzamientos) if (Number.isFinite(t) && t > selloMs) vista.lanzamientos.set(adv, selloMs);
  }
  const ultimaEdicion = new Map();     // path → ms de su edición más reciente, por cualquiera de las fuentes
  if (vista.medible) {
    const anotarEdicion = (p, t) => {
      if (!p || !Number.isFinite(t)) return;
      const v = ultimaEdicion.get(p);
      if (v === undefined || t > v) ultimaEdicion.set(p, t);
    };
    // Las mismas fuentes que el delta (registro de ediciones, mtime, git), con los mismos filtros.
    for (const e of Array.isArray(marker.fileEvents) ? marker.fileEvents : []) {
      if (e && e.path && e.ts && delRepo(honesty.sinRuido([e.path])).length) anotarEdicion(e.path, new Date(e.ts).getTime());
    }
    for (const f of [...currentFiles, ...honesty.sinRuido(workingTreeDeTodos())]) {
      try { anotarEdicion(f, fs.statSync(f).mtimeMs); } catch { /* borrado → si es nuevo, lo cubre el delta por nombre */ }
    }
  }
  const enElDelta = new Set(delta);
  const noVistosDesde = (ms) => [...ultimaEdicion].filter(([p, t]) => t > ms && !enElDelta.has(p)).map(([p]) => p);

  // ── Sin código en el cambio, la vuelta se cierra sola ─────────────────────────────────
  // Lo que pide otra vuelta lo decide lib/reloop-code.js, igual que `next`: la historia (sus marcas, su
  // `runtime_not_verifiable:`) y su carpeta qa no repiten revisores. Un delta vacío del todo sigue abajo: ése es
  // una foto mal fechada. No se cierra si a algún revisor le queda código de su alcance sin ver: lo editado antes del
  // primer lanzamiento queda afuera del corte, y el revisor que la vuelta salteó no lo vio nunca.
  const pideVuelta = (f) => require('./reloop-code.js').pideOtraVuelta(f, { storyPath: story, repoPath: repo });
  const tieneCodigoSinVer = (adv) => {
    const lanzado = vista.lanzamientos.get(adv);
    return noVistosDesde(lanzado !== undefined ? lanzado : vista.inicioMs).some((f) => pideVuelta(f) && advisorAffectedByDelta(adv, [f]).affected);
  };
  // Lo que cambió adentro de cada archivo desde la última vuelta cerrada, contra su sello (lib/change-kind.js): sólo
  // comentarios no pide vuelta, y sólo textos pide la vuelta chica (lib/review-change-policy.js). Lo que no se pudo
  // mirar cuenta como código. Comparar contra el sello vale sólo si cada revisor de la vuelta leyó ese sello: consta el
  // lanzamiento de cada uno y todos se lanzaron después de sellarla (pedir el set otra vez a mitad de la vuelta la vuelve
  // a sellar con un arreglo que los primeros no vieron). Si no, todo archivo de código cuenta como código, como antes.
  const politica = require('./review-change-policy.js');
  let selloMs = NaN;
  try {
    const sellada = require('./frozen-tree.js').vueltaCerradaDeLosRevisores(marker, STEPS_TABLE.reviewersClose(marker));
    if (sellada) selloMs = Date.parse(sellada.ts);
  } catch { /* sin sello: como antes */ }
  const deLaVuelta = vista.medible ? [...vista.esperados].filter((a) => require('./late-snapshot.js').esRevisor(a)) : [];
  const todosLeyeronElSello = Number.isFinite(selloMs) && deLaVuelta.length > 0
    && deLaVuelta.every((a) => { const t = vista.lanzamientos.get(a); return Number.isFinite(t) && t >= selloMs; });
  let tipos = new Map();
  const porRuta = delta.filter(pideVuelta);
  if (porRuta.length && todosLeyeronElSello) {
    try {
      tipos = require('./frozen-tree.js').tiposDesdeLaVuelta({ marker, cierre: STEPS_TABLE.reviewersClose(marker), archivos: porRuta.map((f) => path.resolve(f)) });
    } catch { /* sin mirar: todo cuenta como código */ }
  }
  const tipoDe = (f) => (tipos.get(path.resolve(f)) || {}).tipo || 'codigo';
  const pideVueltaAdentro = (f) => pideVuelta(f) && politica.pideVuelta(tipoDe(f));
  // lo que cuenta siempre (una instrucción para un agente, una imagen de una prueba visual) no deja cerrar sola la vuelta
  const cuentaSiempre = require('./reloop-code.js').cuentaSiempre;
  // ni con la foto al lanzar de base: esa vuelta no completó su ronda, y lo sellado puede no haberlo visto nadie
  // ni con una ronda de la base que el registro muestra sin terminar: un revisor que esperaba no consta lanzado (una foto
  // tomada a mano sobre una ronda que nadie lanzó, o lanzada a medias, no cuenta como vista). Sin registro, la foto de
  // siempre la toma el arnés al lanzar el último revisor, y vale como antes
  const rondaVista = !vista.medible || deLaVuelta.every((a) => Number.isFinite(vista.lanzamientos.get(a)));
  if (delta.length && rondaVista && !fotoPrevia.alLanzar && !delta.some(pideVueltaAdentro) && !delta.some((f) => cuentaSiempre(f)) && !(vista.medible && fullSet.all.some(tieneCodigoSinVer))) {
    logGate({ repoPath: repo, name: 'smart-reloop', check: 'smart-reloop-sin-codigo', status: 'closed', iter, delta });
    return {
      ...fullSet,
      iter,
      mode: 'smart-reloop',
      all_iter1: fullSet.all,
      rerun_count: 0,
      rerun: [],
      rerun_reasons: [],
      skipped_count: fullSet.all.length,
      skipped: fullSet.all.map((name) => ({ name, reason: 'el cambio no trae código: la vuelta se cierra sola' })),
      delta_files: delta,
      delta_source: deltaSource,
      no_code_delta: true,
    };
  }

  // ── Sólo textos: la vuelta chica ──────────────────────────────────────────────────────
  // Si todo lo que pide la vuelta son textos (y a ningún revisor le queda código sin ver), vuelven sólo los revisores de
  // la vuelta chica: una cadena puede ser una consulta o una ruta. Pasa el tope sin firma (topeDeVueltas).
  const conCodigo = delta.filter(pideVueltaAdentro);
  if (conCodigo.length && conCodigo.every((f) => tipoDe(f) === 'textos') && !(vista.medible && fullSet.all.some(tieneCodigoSinVer))) {
    const chicos = fullSet.all.filter((a) => politica.REVISORES_DE_LA_VUELTA_CHICA.includes(a));
    if (chicos.length) {
      logGate({ repoPath: repo, name: 'smart-reloop', check: 'small-round', status: 'small', iter, textos: conCodigo.length });
      const nombres = conCodigo.slice(0, 3).map((f) => path.basename(f)).join(', ') + (conCodigo.length > 3 ? ` y ${conCodigo.length - 3} más` : '');
      return {
        ...fullSet,
        iter,
        mode: 'small-round',
        all_iter1: fullSet.all,
        rerun_count: chicos.length,
        rerun: chicos,
        rerun_reasons: chicos.map((name) => ({ name, reason: 'sólo cambiaron textos: una cadena puede ser una consulta o una ruta' })),
        skipped_count: fullSet.all.length - chicos.length,
        skipped: fullSet.all.filter((a) => !chicos.includes(a)).map((name) => ({ name, reason: 'sólo cambiaron textos: los revisa la vuelta chica' })),
        delta_files: delta,
        delta_source: deltaSource,
        small_round: true,
        textos: conCodigo,
        note: `vuelta chica: en ${nombres} sólo cambiaron textos desde la última vuelta; re-corre ${chicos.join(', ')}.`,
      };
    }
  }

  const noVistosPorRevisor = {};       // revisor → archivos de su alcance editados después de su lanzamiento
  const sinVista = [];                 // revisores re-corridos porque no se sabe qué versión vieron

  const rerun = [];
  const skipped = [];
  for (const adv of fullSet.all) {
    let { affected, reason } = advisorAffectedByDelta(adv, delta);
    // con el corte en el primer revisor, el delta trae lo editado mientras corría la vuelta: el revisor que se lanzó
    // después de la última edición de un archivo ya vio esa versión, y ese archivo no lo repite
    const lanzadoAdv = vista.medible ? vista.lanzamientos.get(adv) : undefined;
    if (affected && lanzadoAdv !== undefined) {
      const sinVer = delta.filter((f) => { const t = ultimaEdicion.get(f); return !(Number.isFinite(t) && t <= lanzadoAdv); });
      if (!advisorAffectedByDelta(adv, sinVer).affected) {
        affected = false;
        reason = `ya vio lo que cambió: se lanzó en la vuelta ${prev} (${new Date(lanzadoAdv).toISOString()}) después de la última edición de su alcance`;
      } else {
        // lo de su alcance que se editó después de su lanzamiento y quedó adentro de la foto: no lo vio
        const tapados = sinVer.filter((f) => { const t = ultimaEdicion.get(f); return Number.isFinite(t) && t <= prevTsMs && advisorAffectedByDelta(adv, [f]).affected; });
        if (tapados.length) noVistosPorRevisor[adv] = tapados;
      }
    }
    if (!affected && !vista.medible) {
      affected = true;
      reason = `no se sabe qué versión del cambio vio en la vuelta ${prev} (${vista.motivo}) → se re-corre por las dudas`;
      sinVista.push(adv);
    } else if (!affected) {
      const lanzado = vista.lanzamientos.get(adv);
      if (lanzado === undefined && vista.esperados.has(adv)) {
        affected = true;
        reason = `estaba en la vuelta ${prev} y no consta su lanzamiento → no se sabe qué vio: se re-corre por las dudas`;
        sinVista.push(adv);
      } else {
        const desde = lanzado !== undefined ? lanzado : vista.inicioMs;
        const enSuAlcance = noVistosDesde(desde).filter((f) => advisorAffectedByDelta(adv, [f]).affected);
        if (enSuAlcance.length) {
          affected = true;
          noVistosPorRevisor[adv] = enSuAlcance;
          reason = lanzado !== undefined
            ? `'${enSuAlcance[0]}' se editó después de su lanzamiento en la vuelta ${prev} (${new Date(lanzado).toISOString()}): no lo vio`
            : `'${enSuAlcance[0]}' se editó durante la vuelta ${prev}, que lo había salteado: no lo vio`;
        }
      }
    }
    if (affected) {
      rerun.push({ name: adv, reason });
    } else {
      skipped.push({ name: adv, reason });
    }
  }

  // Hint de modelo para re-loops:
  // los advisors tier 'deep' (Opus) corren en CADA iteración por ser always:true.
  // El juicio sintético grande ya pasó en iter 1; el re-check sobre un delta de fix
  // es más angosto → Sonnet alcanza. El orquestador DEBE aplicarlo (paso de revisores) salvo
  // que el delta incluya specs editadas.
  const reloopModelHints = reloopHintsFor(rerun.map((r) => r.name), iter, costTier) || {};

  // GUARD delta-vacío: un smart-reloop es POR
  // DEFINICIÓN un re-loop que sigue a fixes de código — un delta VACÍO ahí casi siempre significa
  // que `snapshot-iter ${iter-1}` se tomó DESPUÉS de aplicar los fixes (la foto ya los contiene, así
  // que "qué cambió desde la foto" da vacío). Sin este guard el orquestador ve "N/M skip por surface
  // intacta", lo toma como legítimo y cae a --force-full-reloop (el set COMPLETO — el caso más caro),
  // repetido en cada iteración. El warning lo hace accionable en vez de degradar en silencio.
  // ── ¿La foto de la iteración anterior se fechó TARDE, y tapó código? ─────────────────────
  // Los archivos que entran al delta SÓLO porque el corte se movió al último revisor son, literalmente,
  // los que ningún revisor vio y la foto escondió. Con el corte en la hora de la foto el delta saldría
  // vacío (o más corto) y esos revisores se saltearían por «superficie no tocada».
  // 🔴 El aviso sale TAMBIÉN por stderr: el orquestador puede filtrar este JSON con un
  // `python3 -c` que imprime sólo `correr/hints/ctx`, y entonces la advertencia existe y no la lee nadie.
  // Un aviso que vive sólo dentro de un JSON que el llamador puede filtrar no es un control.
  // Sólo lo editado entre el último lanzamiento y la foto: lo de antes del último lanzamiento lo vio ese revisor.
  const entreUltimoYFoto = (t) => Number.isFinite(t) && t > ultimoRevisorMs && t <= prevTsMs;
  const eventosDe = (f) => (Array.isArray(marker.fileEvents) ? marker.fileEvents : []).filter((e) => e && e.path === f && e.ts);
  const lateSnapshotFiles = fotoTardia
    ? delta.filter((f) => entreUltimoYFoto(horaDe.get(f)) || entreUltimoYFoto(ultimaEdicion.get(f))
      || eventosDe(f).some((e) => entreUltimoYFoto(new Date(e.ts).getTime())))
    : [];
  if (lateSnapshotFiles.length) {
    process.stderr.write(
      `⚠ la foto de la iteración ${prev} se fechó DESPUÉS del último revisor y tapó ` +
      `${lateSnapshotFiles.length} archivo(s) de código que nadie auditó: ` +
      `${lateSnapshotFiles.slice(0, 10).map((f) => path.basename(f)).join(', ')}` +
      `${lateSnapshotFiles.length > 10 ? ` y ${lateSnapshotFiles.length - 10} más` : ''}.\n` +
      `   El delta se calculó desde el último lanzamiento de revisores, así que ESTA vuelta los incluye.\n` +
      `   No repitas \`snapshot-iter\` después de arreglar: la foto se toma sola al lanzar el último revisor.\n`,
    );
  }

  // Por stderr también, por la misma razón que el aviso de arriba: el JSON lo puede filtrar quien llama.
  const revisoresNoVieron = Object.keys(noVistosPorRevisor);
  if (revisoresNoVieron.length) {
    process.stderr.write(
      `⚠ ${revisoresNoVieron.length} revisor(es) de la vuelta ${prev} no vieron un arreglo hecho después de ` +
      `lanzarse (quedó adentro de la foto): ` +
      `${revisoresNoVieron.map((a) => `${a} (${noVistosPorRevisor[a].slice(0, 3).map((f) => path.basename(f)).join(', ')})`).join('; ')}.\n` +
      `   ESTA vuelta los re-corre.\n`,
    );
  }
  if (sinVista.length) {
    process.stderr.write(
      `⚠ no se sabe qué versión del cambio vieron ${sinVista.length} revisor(es) en la vuelta ${prev}` +
      `${vista.medible ? ' (estaban en la vuelta y no consta su lanzamiento)' : ` (${vista.motivo})`}: ` +
      `se re-corren por las dudas — ${sinVista.join(', ')}.\n`,
    );
  }

  const suspectEmptyDelta = delta.length === 0;
  const emptyDeltaWarning = suspectEmptyDelta
    ? `⚠ DELTA VACÍO en un re-loop (iter ${iter}) — un re-loop sigue a fixes, así que un delta vacío ` +
      `casi siempre = 'snapshot-iter ${prev}' tomado DESPUÉS de los fixes (debe tomarse al cierre ` +
      `de la tanda de advisors, ANTES de fixear). NO tomes el "todo skip por surface" como legítimo. ` +
      `Acción: re-snapshotear en el momento correcto la próxima iteración; para ESTA, --force-full-reloop.`
    : null;

  return {
    ...fullSet,
    iter,
    mode: 'smart-reloop',
    all_iter1: fullSet.all,
    rerun_count: rerun.length,
    rerun: rerun.map((r) => r.name),
    rerun_reasons: rerun,
    skipped_count: skipped.length,
    skipped,
    delta_files: delta,
    delta_source: deltaSource,
    ...(suspectEmptyDelta ? { suspect_empty_delta: true, warning: emptyDeltaWarning } : {}),
    ...(lateSnapshotFiles.length ? {
      suspect_late_snapshot: true,
      late_snapshot_files: lateSnapshotFiles,
      late_snapshot_note: `la foto de iter ${prev} se fechó después del último lanzamiento de revisores: ` +
        `el delta se cortó por el último revisor y esos archivos entraron igual. La foto se toma SOLA al ` +
        `lanzar el último revisor — no la repitas a mano después de arreglar.`,
    } : {}),
    ...(Object.keys(reloopModelHints).length ? { reloop_model_hints: reloopModelHints, reloop_model_hints_note: 'tier deep (Opus) → sonnet en re-loop: el juicio de scope grande ya corrió en iter 1; ignorá el hint si el delta toca specs.' } : {}),
    ...(revisoresNoVieron.length ? { no_vistos_por_revisor: noVistosPorRevisor } : {}),
    vista_por_revisor: vista.medible
      ? { medible: true, ...(sinVista.length ? { sin_vista: sinVista } : {}) }
      : { medible: false, motivo: vista.motivo, sin_vista: sinVista },
    note: !vista.medible && sinVista.length
      ? `no se sabe qué versión del cambio vio cada revisor en la vuelta ${prev} (${vista.motivo}): se re-corren todos los que el delta no traía. Ver vista_por_revisor.`
      : suspectEmptyDelta
      ? `delta vacío en un re-loop → ver "warning": snapshot probablemente post-fixes. NO degradar a "todo skip" en silencio.`
      : skipped.length > 0
        ? `${skipped.length}/${fullSet.all.length} advisors skip por surface intacta. Override con --force-full-reloop si dudás.`
        : `Todos los advisors de iter 1 tienen surface tocada en iter ${iter} delta → re-correr set completo.`,
  };
}

// ── los subcomandos (cada uno era un bloque de main) ──


// La línea del cierre: cuántas vueltas de revisores hubo, el tope y qué quedó abierto (lib/review-rounds.js).
function cmdReviewRounds(cmd, args) {
  const rr = require('./review-rounds.js');
  const { marcador } = readSessionMarkerStrict();
  const repoAbs = path.resolve(args.repo || (marcador && marcador.repoPath) || '.');
  const storyArg = args.story || (marcador && marcador.storyPath) || null;
  const storyAbs = storyArg ? (path.isAbsolute(storyArg) ? storyArg : path.join(repoAbs, storyArg)) : null;
  const storyId = storyAbs ? deriveStoryId(storyAbs) : null;
  const runDir = storyId ? resolveRunDir(repoAbs, storyId, false, storyAbs, { marker: marcador || null }) : null;
  const tope = rr.tope({ repo: repoAbs });
  const h = rr.hallazgosDe(runDir);
  const pre = rr.prefijos();
  const ab = rr.abiertos(h.lista, { prefijos: pre });
  // «no pude mirar» no es «no quedó nada abierto»
  const noMirado = h.error || (!runDir ? 'no encontré la carpeta de la corrida' : null);
  const out = { vueltas: rr.vueltas(marcador), tope: tope.value, tope_de: tope.source, problemas: [...tope.problems, ...pre.problems, ...(noMirado ? [noMirado] : [])], abiertos: ab };
  out.linea = rr.linea({ n: out.vueltas, max: out.tope, abiertos: ab, noMirado, de: tope.source });
  if (args.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else {
    process.stdout.write(`${out.linea}\n`);
    for (const p of out.problemas) process.stderr.write(`⚠️  ${p}\n`);
  }
  process.exit(0);
}


// Smart re-loop de advisors en iter N>1.
// Usage:
//   node pipeline.js smart-reloop --iter 2 --repo <r> --story <s> --files a.cs b.tsx
//     → JSON con { rerun: [...], skipped: [{name, reason}], delta_files }.
//     Lee marker.iterations[iter-1].filesSnapshot para computar el delta.
//   Flag --force-full-reloop overridea y devuelve set completo.
//
// Workflow esperado:
//   1. iter 1: pipeline.js advisors → set completo, orquestador corre todos.
//   2. marker.js snapshot-iter 1 → snapshot filesTouched al cierre de iter 1.
//   3. ...HITL + fixes...
//   4. iter 2: pipeline.js smart-reloop --iter 2 → set reducido. Orquestador
//      corre solo `rerun` + anuncia `skipped` con razones (regla B verbosity).
//   5. marker.js snapshot-iter 2 (si hay más iters previstas).
function cmdSmartReloop(cmd, args) {
  // Desde la tercera vuelta (y en cada una de las siguientes) hace falta la nota de «repensar el enfoque» de ESA vuelta,
  // también con --force-full-reloop. Sin ella no se devuelve ningún set.
  // Misma validación que `advisors` — files fantasma
  // corromperían el recompute de force-full-reloop.
  const filesErr = validateFilesExist(args);
  if (filesErr) { process.stderr.write(filesErr); process.exit(2); }
  const emptyWork = emptyWorkGate(args);
  if (emptyWork) { process.stderr.write(emptyWork); process.exit(2); }
  // el set se calcula antes del freno de vueltas: una vuelta chica (sólo textos) pasa el tope sin firma, y una sin código
  // se cierra sola
  const conModelos = conModelosDeLaCorrida(args);
  const result = computeSmartReloop(conModelos);
  const avisosModelos = result._avisos || [];
  // El descuento aplica también al subset rerun del re-loop. Sin poder leer los críticos de la corrida, no se descuenta.
  const pc = revisoresPorConfirmar(args);
  const disc = pc.error ? null : computeMechDiscount(result.rerun, args);
  if (disc && disc.discounted.length) {
    if (result.reviewer_models) for (const d of disc.discounted) delete result.reviewer_models[d.name];
    result.rerun = disc.kept;
    result.rerun_count = disc.kept.length;
    result.mech_discounted = disc.discounted;
    result.mech_findings = disc.mech_findings;
    result.mech_note = `mech-check descontó ${disc.discounted.length} advisor(s) del rerun/expected. ` +
      (disc.mech_findings.length ? `⚠️ ${disc.mech_findings.length} finding(s) mecánicos CONFIRMADOS — al reporte del paso de hallazgos.` : 'Sin findings mecánicos.') +
      ` ${MECH_NUNCA_SACA}`;
  } else if (disc && disc.mech_findings.length) {
    result.mech_findings = disc.mech_findings;
    result.mech_note = `⚠️ ${disc.mech_findings.length} finding(s) mecánicos CONFIRMADOS (mech-check) — al reporte del paso de hallazgos.`;
  }
  // Una vuelta sin código no se cierra sola con un crítico de mech-check dado por arreglado sin volver a comprobarlo:
  // mech-check ya corrió arriba (el descuento); si el crítico sigue, o no se pudo mirar, la vuelta no se cierra
  if (result.no_code_delta) {
    const cm = criticosMecanicos(args);
    const noSe = cm.error ? `no pude saber cuáles son (${cm.error})` : cm.reglas.length && !disc ? 'no pude volver a correr mech-check' : null;
    if (noSe) {
      result.no_code_delta = false;
      result.mech_still_open = [{ rule: null, reason: noSe }];
    } else if (cm.reglas.length) {
      // por instancia: los que mech-check sigue reportando, menos los que ya tienen su destino en findings.json
      const vivos = (regla) => disc.mech_findings.filter((f) => f.rule === regla && String(f.severity || '').toUpperCase() === 'CRITICAL').length;
      const ambiguas = new Set(disc.mech_ambiguous_rules || []);
      const abiertos = [];
      for (const rule of cm.reglas) {
        if (cm.conPruebaDelPase.includes(rule)) continue;
        if (!REGLAS_QUE_MECH_COMPRUEBA.has(rule)) abiertos.push({ rule, reason: 'mech-check no la evalúa: no la puedo comprobar sin un revisor' });
        else if (ambiguas.has(rule)) abiertos.push({ rule, reason: 'mech-check la deja ambigua: no la puedo comprobar sin un revisor' });
        else if (vivos(rule) > (cm.conDestino[rule] || 0)) abiertos.push({ rule, reason: 'findings.json lo da por arreglado y mech-check lo sigue reportando' });
      }
      if (abiertos.length) {
        result.no_code_delta = false;
        result.mech_still_open = abiertos;
      } else result.mech_confirmed = cm.reglas;
    }
    if (result.mech_still_open) {
      result.mech_note = `${result.mech_note ? `${result.mech_note} ` : ''}🛑 La vuelta sin código no se cierra: ${result.mech_still_open.map((m) => (m.rule ? `${m.rule} (${m.reason})` : m.reason)).join('; ')}. Arreglalo y volvé a pedir la vuelta.`;
      logGate({ repoPath: args.repo, name: 'smart-reloop', check: 'smart-reloop-sin-codigo', status: 'reopened', iter: args.iter, mech: result.mech_still_open });
    }
  }
  // el revisor de un crítico arreglado vuelve aunque el descuento o el cálculo por diferencias lo dejen afuera; lleva el
  // modelo que le da la corrida. `no_code_delta` y el aviso del registro ciego se conservan: vuelve sólo a confirmar
  {
    const antes = result.rerun || [];
    result.rerun = sumarPorConfirmar(antes, result, pc);
    result.rerun_count = result.rerun.length;
    const nuevos = result.rerun.filter((n) => !antes.includes(n));
    if (nuevos.length && result.reviewer_models) {
      const suyos = {};
      aplicarModelosDeRevisores(suyos, nuevos, conModelos);
      Object.assign(result.reviewer_models, suyos.reviewer_models || {});
    }
    for (const l of [...(pc.error ? [`no pude leer los críticos de la corrida (${pc.error}): no descuento`] : []), ...pc.fuera]) process.stderr.write(`⚠️  ${l}\n`);
  }
  // El tope de vueltas, con el set ya decidido: una vuelta chica (sólo textos) lo pasa sin firma, y una vuelta sin código
  // (sin revisores que lanzar, ni uno que vuelva a confirmar un crítico) se cierra sola, sin tope, sin firma ni nota
  const sinCodigo = !!result.no_code_delta && !(result.rerun || []).length;
  salidaDelFreno(rethinkGate(args, { vueltaChica: result.mode === 'small-round', sinCodigo }));
  // el chequeo antes de la ventana termina en la firma (owner-window.js): si llegó acá sin pasar por ella, no dice que sí
  if (process.env[PRECHEQUEO] === '1') process.exit(0);
  // una vuelta extra que firmó el dueño no sale sin revisores: si el set quedó vacío (lo cambiado no es código por su
  // extensión: la configuración, un workflow), vuelve al menos el revisor de la vuelta chica
  if (args.extraRound && !(result.rerun || []).length) {
    const chicos = (result.all || []).filter((a) => require('./review-change-policy.js').REVISORES_DE_LA_VUELTA_CHICA.includes(a));
    result.rerun = chicos;
    result.rerun_count = chicos.length;
    result.no_code_delta = false;
    result.rerun_reasons = chicos.map((name) => ({ name, reason: 'vuelta extra firmada por el dueño: alguien mira lo cambiado' }));
  }
  // Lo que se revisa, congelado: sin sello o sin copia, la vuelta no se lanza.
  const horaDelSello = new Date().toISOString();
  const congelada = congelarVuelta({ story: args.story, repo: args.repo, iter: args.iter });
  if (congelada.error) {
    process.stderr.write(`🛑 pipeline.js smart-reloop: la vuelta no se lanza — ${congelada.error}. Los revisores no leen la carpeta viva.\n`);
    process.exitCode = 2;
    return;
  }
  if (congelada.aviso) process.stderr.write(`⚠️  pipeline.js smart-reloop: ${congelada.aviso}.\n`);
  result.frozen = congelada.repos;
  // una vuelta sin revisores no deja foto: no hay ronda que mirar
  if ((result.rerun || []).length) fotoAlLanzar(args.iter, horaDelSello);
  const ctx = buildAdvisorContext({ repo: args.repo, story: args.story, files: args.files, iter: args.iter });
  contextoConLaCopia(ctx, congelada.repos);
  result.reglas_revisores = resumenReglas(ctx && ctx.reglas ? ctx.reglas : reglasRevisores(args.repo));
  if (ctx) {
    result.context_file = ctx.context_file;
    result.context_file_overrides = ctx.overrides;
  }
  result.batch_rule = 'Ventana deslizante: MÁXIMO 4 subagentes VIVOS a la vez (máquina 8c/16GB); reponer el slot al llegar cada notificación de término. ⚠️ Cap 2 si el pase adversarial sigue en vuelo (manda la guía del paso de revisores §Cap reducido).';
  conLanzadorCodex(result, args);
  // expected = el SUBSET legítimo de esta iteración (rerun) — check-count valida
  // contra esto, no contra el set completo.
  // El validador de stories en los re-loops: se decide ANTES de persistir el expected.
  aplicarDecisionValidador(result, 'rerun', args);
  if (result.reviewer_models) {
    // el validador de stories puede entrar o salir en la decisión de arriba: el modelo va para cada uno del rerun
    const faltan = (result.rerun || []).filter((r) => !result.reviewer_models[r]);
    if (faltan.length) {
      const extra = {};
      avisosModelos.push(...aplicarModelosDeRevisores(extra, faltan, conModelos, result.all || result.rerun));
      Object.assign(result.reviewer_models, extra.reviewer_models || {});
    }
    for (const r of Object.keys(result.reviewer_models)) if (!(result.rerun || []).includes(r)) delete result.reviewer_models[r];
  }
  decirModelos(result, conModelos.orgModels, avisosModelos);
  logStep5Start(result.rerun, { mode: result.mode, iter: args.iter, story: args.story ? deriveStoryId(path.resolve(args.repo || '.', args.story)) : null, context_file: result.context_file, context_file_overrides: result.context_file_overrides });
  salidaGrande(JSON.stringify(result, null, 2) + '\n', 0);
  return;
}

module.exports = { cmdReviewRounds, cmdSmartReloop, computeSmartReloop, gitArchivosDelWorkingTree };
