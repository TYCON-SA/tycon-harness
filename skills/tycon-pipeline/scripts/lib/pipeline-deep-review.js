/**
 * pipeline-deep-review.js — una parte de pipeline.js (el despachador la carga para sus subcomandos).
 *
 * Responsabilidad: la revisión profunda: cuándo hace falta y con qué criterio.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { estadoPipeline, MODELOS, STEPS_TABLE, codeFiles, companionLib, deepReviewConfig, ejecucionDeLaCorrida, esLaStoryDelMarcador, exists, fs, logGate, nn, path, pedidoDeSalteo, readSessionMarker, readText, sessionIdFileKey, stackConfig } = require('./pipeline-shared.js');
const { computeModelHint, conModelosDeLaCorrida, decirModelos } = require('./pipeline-models.js');
const { computeDelicate, computeRiskClass, computeRunSize, deepReviewAlwaysPaths, parseFrontmatterList, repoDeLaStory, runSizeDelMarcador, runSizeLib, tocaSuperficieCompartida } = require('./pipeline-risk.js');

/** Las dos señales de lib/batch-scope.js, con el repo de la story y sus compañeros; lo que no se puede leer, nada. */
function senalesDe(story, repoArg, batch) {
  try {
    if (!story || !fs.existsSync(story)) return [];
    const repo = repoDeLaStory(story, repoArg && fs.existsSync(repoArg) ? repoArg : null);
    if (!repo) return [];
    let raices;
    try { raices = [repo, ...companionLib.companionRoots(repo, story, { onMissing: () => {} })]; } catch (e) {
      // sin los compañeros, «ninguna prueba lo ataja» avisaría por pruebas que viven en ellos: no se mide, y se dice
      const sinCompaneros = require('./batch-scope.js').senales({ story, repo, batch, raices: [repo] }).filter((w) => !w.startsWith('ninguna prueba lo ataja: '));
      return [...sinCompaneros, `ninguna prueba lo ataja: no medido, no pude leer los repos compañeros (${String(e.message || e).split('\n')[0]})`];
    }
    return require('./batch-scope.js').senales({ story, repo, batch, raices });
  } catch (e) { return [`ninguna prueba lo ataja: no medido, las señales fallaron (${String(e.message || e).split('\n')[0]})`]; }
}

// El portón del pase. `args.adversarialSkipRecord` es la constancia que la línea de comandos leyó para esta ejecución
// (`lib/adversarial-skip.js` `vigente`); esta función no lee la máquina. Con una que vale, saltea (decisión 26); sin
// ella, el pedido no apaga nada y el veredicto lo dice (`skip_request`).
function computeDeepReviewGate(args) {
  estadoPipeline.avisosDelPorton = [];
  const constancia = args.adversarialSkipRecord || null;
  const pedido = pedidoDeSalteo(args);
  if (constancia && constancia.ok && constancia.linea) {
    const l = constancia.linea;
    return {
      run: false, model: null,
      adversarial_skip: { via: l.via, quien: l.quien, cuando: l.ts, huella: l.huella, camino: l.camino },
      reason: `salteado con la constancia firmada por el ${l.quien} (vía ${l.via}, ${l.ts}, huella ${l.huella}): ${l.motivo}`,
    };
  }
  const r = criterioDelPase(args);
  if (!pedido || !r || r.run === null) return r;
  // Sin el pedido el pase ya no corría: no hay nada que firmar, y pedir la firma sería mentirle al dueño.
  if (r.run === false) {
    r.reason = `${pedido} no hace falta: el pase no corre por el criterio de siempre · ${r.reason}`;
    return r;
  }
  const porque = (constancia && constancia.motivo) || 'no hay constancia firmada';
  r.skip_request = { camino: pedido, firmado: false, motivo: porque };
  r.reason = `${pedido} es un pedido de saltear sin la firma de una persona (${porque}): el pase sigue el criterio de siempre · ${r.reason}`;
  return r;
}

// El portón con la constancia de la corrida leída de la máquina. Con un pedido sin constancia que valga, anota la
// muestra (si `mostrar`) y devuelve los dos comandos de la firma en `sign_commands`. `{ result, texto }`.
function deepReviewGateDeLaCorrida({ args, corrida, casa, userInfo, mostrar = false } = {}) {
  const sk = require('./adversarial-skip.js');
  const ej = ejecucionDeLaCorrida(args, corrida);
  const constancia = ej ? sk.vigente({ ...ej, casa, userInfo })
    : { ok: false, motivo: 'no hay una ejecución abierta de esta story', ninguna: true };
  const result = computeDeepReviewGate({ ...args, adversarialSkipRecord: constancia, marcador: corrida || null });
  let texto = '';
  // Sin corrida no hay ejecución que firmar: la constancia nombra carpeta y comienzo, y no se ofrecen comandos.
  if (result.skip_request && mostrar && !ej) {
    result.skip_request.muestra = 'sin corrida abierta: la firma se pide dentro de una corrida de esta story (pipeline.js start)';
  } else if (result.skip_request && mostrar) {
    const m = sk.muestra({ story: ej.story, carpeta: ej.carpeta, ejecucion: ej.ejecucion,
      camino: result.skip_request.camino, casa, userInfo });
    texto = m.texto;
    result.sign_commands = m.comandos;
    if (m.error) result.skip_request.muestra = `no anotada (${m.error})`;
  }
  return { result, texto };
}

// Los archivos que la story declara (`files_to_create` y `files_to_modify`), el alcance de risk-class sin `--files`.
function historiaDeclara(story) {
  if (!story || !fs.existsSync(story)) return [];
  const content = readText(story);
  // un comentario al final del renglón (`- a.js   # por qué`) no es parte de la ruta
  return [...parseFrontmatterList(content, 'files_to_create'), ...parseFrontmatterList(content, 'files_to_modify')]
    .map((f) => String(f).replace(/\s+#.*$/, '').trim()).filter(Boolean);
}

// El criterio de siempre (riesgo, superficie compartida, tamaño, densidad) y la matriz de la organización, sin los
// pedidos de saltear.
function criterioDelPase(args) {
  // Modelo — escalación mecánica por complejidad.
  // Default sonnet (recorta el $ ~5x vs Opus); story pesada (model-hint ≥2 señales)
  // → opus AUTOMÁTICO (anunciado). Fable no se ofrece nunca: sólo corre con --deep-review-fable,
  // el pedido explícito de quien corre el pipeline. Precedencia:
  // fable(flag) > opus(flag) > opus(ultracode) > opus(story pesada) > sonnet.
  const hint = computeModelHint({ ...args, orgModels: null });
  // El modelo sale de lib/models.js con la configuración de la organización y el pedido de la corrida, que llegan por
  // argumento (`args.orgModels`, `args.modelRequests`). Esta función no lee la máquina.
  // Precedencia: fable(flag) > opus(flag) > opus(ultracode) > pedido > organización > opus(pesada) > sonnet.
  const org = args.orgModels && args.orgModels.declared ? args.orgModels.data : null;
  const avisos = [];
  const adv = MODELOS.resolveAdversarial({
    org, requests: args.modelRequests || null, heavy: hint.heavy, warnings: avisos,
    flags: { fable: !!args.deepReviewFable, opus: !!args.deepReviewOpus, ultracode: !!args.ultracode },
  });
  const model = adv.model;
  let modelReason;
  if (adv.capped || (adv.origin !== 'default' && !adv.fromFlag)) modelReason = adv.reason;
  else if (args.deepReviewFable) modelReason = '--deep-review-fable (autorización explícita del user)';
  else if (args.deepReviewOpus) modelReason = '--deep-review-opus';
  else if (args.ultracode) modelReason = 'ultracode ON → hunters en Opus';
  else if (hint.heavy) modelReason = `story pesada (${hint.heavy_signal_count} señales model-hint) → hunters escalan a Opus (anunciar)`;
  else modelReason = 'default (recorta $ ~5x vs Opus)';
  // Lanzamiento temprano del pase adversarial al cierre de «Correr las pruebas» — DEFAULT ON con
  // kill-switch (las mitigaciones
  // están cableadas — cap 2 de ventana, verificadores en ventana de 3, candado
  // anti-full-suite — y la primera corrida NORMAL ES la medición del cap). El switch queda
  // MECÁNICO acá (mismo patrón que TYCON_NO_DEEP_REVIEW), no en prosa que nadie lee:
  // export TYCON_5B_EARLY=0 → lanzamiento clásico en su paso; sin la env → temprano al cerrar «Correr las pruebas».
  const extras = {
    model_reason: modelReason,
    early_launch: process.env.TYCON_5B_EARLY !== '0',
  };
  // los avisos del techo los dice la línea de comandos (una vez por corrida): se dejan a mano, sin tocar la salida
  estadoPipeline.avisosDelPorton = avisos;
  // 2) Config por repo (`off` es un pedido: lo mira computeDeepReviewGate).
  const cfg = deepReviewConfig(args.repo);
  if (cfg === 'always') return { run: true, model, ...extras, reason: '.tycon/advisors.yaml deep_review: always' };
  // La política de la organización (`args.orgDeepReview`, que lee la línea de comandos de team-repos.json →
  // deep_review.default) entra en el mismo lugar que el `always` del repo; el `auto` del repo gana. No hay `off` de la
  // organización: saltear el pase lo firma el dueño, así que cualquier otro valor no cambia nada.
  if (args.orgDeepReview === 'always' && cfg !== 'auto') {
    return { run: true, model, ...extras, reason: 'la organización lo pide siempre (team-repos.json → deep_review.default: always)' };
  }
  // 3) Force-on explícito.
  if (args.deepReview) return { run: true, model, ...extras, reason: 'forzado ON (--deep-review)' };
  if (args.ultracode) return { run: true, model, ...extras, reason: 'ultracode ON → fuerza deep-review (hunters en Opus)' };
  // 4) Superficie compartida declarada por el repo — gana sobre el LOW por tamaño.
  const compartida = tocaSuperficieCompartida(args.repo, args.files);
  if (compartida) {
    return {
      run: true, risk: 'shared-surface', model, ...extras,
      shared_surface: compartida,
      reason: `el diff toca superficie compartida declarada por el repo (${compartida.file} ` +
              `matchea \`${compartida.pattern}\`) → corre aunque el risk-class sea LOW: ` +
              'una falla ahí no rompe una pantalla, se lleva puesto el proceso del host.',
    };
  }

  // 4c) Corrida liviana: sólo documentación → sin pase adversarial. Las superficies del repo ya
  //     decidieron arriba y además vuelven completa la corrida (lib/run-size.js).
  const runSize = computeRunSize(args);
  if (runSize.size === 'liviana') {
    return { run: false, risk: 'liviana', model: null, run_size: 'liviana', reason: `corrida liviana (${runSize.reason}) → sin pase adversarial; override: --deep-review o marker.js set-size completa --reason "<por qué>"` };
  }
  // 5) La matriz de la organización (lib/review-policy.js `codeReview`): delicada o no, chica o grande.
  const rc = computeRiskClass(args);
  // `computeRiskClass` devuelve `{risk:'NORMAL', error, ...}` SIN `criteria` cuando --story es
  // inválido/inexistente. Sin este guard, el `.filter` de abajo tiraría un TypeError con stack —
  // fail-ugly en un GATE es justo lo que empuja al bypass. Fail-loud legible: run:true (NORMAL es
  // el default seguro) + el error a la vista.
  if (!Array.isArray(rc.criteria)) {
    return {
      run: true, risk: 'NORMAL', model, ...extras,
      reason: `risk-class no computable (${rc.error || 'sin criteria'}) → deep-review corre por default seguro (NORMAL)`,
    };
  }
  // NORMAL por otro criterio que el tamaño (una migración, el alcance firmado, un camino sensible, un freno): cuenta
  // como grande. El tamaño lo cuenta la matriz por su cuenta, con `small_max_files`.
  const porOtro = rc.criteria.filter((c) => !c.pass && c.name !== 'superficie-chica').map((c) => c.name);
  const POLITICA = require('./review-policy.js');
  const config = args.reviewConfig || POLITICA.normalize({}).values;
  // el tamaño se cuenta sobre el mismo alcance que risk-class: los archivos del diff o, sin ellos, los de la story. Sin
  // alcance declarado no se sabe el tamaño: cuenta como grande, como hoy cuenta NORMAL
  const alcance = Array.isArray(args.files) && args.files.length ? args.files : historiaDeclara(args.story);
  const archivosDeCodigo = alcance.filter((f) => codeFiles.isCode(f, { extra: stackConfig.orgExtra() })).length;
  const delicada = args.delicate || computeDelicate({ story: args.story, repo: args.repo, planText: '' });
  // todo documentación según el tamaño de la corrida: sólo así una historia sin archivos de código se queda sin pase
  const soloDocumentacion = alcance.length > 0 && alcance.every((f) => runSizeLib.classifyFile(f).kind === 'doc');
  const celda = (dense) => POLITICA.codeReview({ delicate: !!delicada.value, codeFiles: archivosDeCodigo, onlyDocs: soloDocumentacion,
    normalByOtherCriterion: rc.risk === 'NORMAL' && (porOtro.length > 0 || !alcance.length), dense, ownerAway: !!args.ownerAway, config });
  const sinDensidad = celda(false);
  // La densidad decide sólo un cambio chico que no es delicado: una delicada, o un cambio que ya es grande, no la espera.
  const hayQueMedir = !delicada.value && sinDensidad.size === 'small';
  // 6) Sin `--files` no hay nada que medir, y la celda depende de la medición.
  // 🔴 «No me dijiste qué mirar» NO es «no cambió nada».
  //
  // `densidadDelDiff` recorre `args.files`. Con la lista vacía el resultado es 0, y el
  // gate lo publicaría como `lineas_agregadas: 0` y saltaría el pase con el motivo «0 líneas
  // agregadas < 300». Eso se lee como una medición y no lo es. Por ejemplo, una invocación
  // sin `--files` sobre un cambio de 839 líneas contesta cero;
  // el salto sólo se evita si el dev pidió la revisión a mano.
  //
  // Se CORTA en vez de «correr por las dudas»: una corrida del pase midió 6,5 M de tokens y 30
  // minutos, así que revisar de más no es el lado barato. El error está en la llamada y se arregla
  // ahí; las dos invocaciones reales de los steps ya pasan `--files`. Los overrides explícitos del
  // dev (`--deep-review`, `deep_review: always` del repo) ya decidieron más arriba y no
  // llegan hasta acá: el corte no puede tapar la puerta que alguien usa a propósito.
  // 🔴 Devuelve el veredicto; NO mata el proceso. `computeDeepReviewGate` es una función pura que
  //    el banco llama directo — un `process.exit` acá se lleva puesto al test que la ejercita.
  //    Quien decide el código de salida es la rama de línea de comandos, más abajo.
  //
  //    Y distingue «no me pasaste `--files`» (`filesDeclarado` ausente) de «me pasaste la lista
  //    vacía a propósito», que es lo que hacen los casos del banco al probar el skip por LOW.
  if (hayQueMedir && args.filesDeclarado === false) {
    return {
      run: null, risk: 'no-medible', model: null, ...extras,
      densidad_medida: false,
      reason: 'no pude medir la densidad del diff: me invocaste sin `--files`. Sin la lista de '
        + 'archivos de código no hay nada que contar, y un «0 líneas» acá sería un número que nadie '
        + 'calculó — se usaría para saltear el pase adversarial sin haber mirado. Pasá los archivos '
        + 'del diff (ver la guía del pase adversarial §Lanzamiento temprano), o pedí el pase con '
        + '`--deep-review` (saltearlo lo firma una persona: `marker.js sign-adversarial-skip`).',
    };
  }
  // Densidad: el tamaño cuenta ARCHIVOS, no lógica. Una story de 4 archivos de código puede tener 6 defectos reales en
  // esos mismos 4 archivos: un diff angosto pero denso —muchas líneas agregadas en archivos de código— cuenta como
  // grande. Umbral: `TYCON_DEEP_REVIEW_DENSE_LINES` (default 300); la medición viaja en el veredicto.
  const densidad = hayQueMedir ? densidadDelDiff(args.repo, args.files, { allowMissing: Boolean(args.allowMissingFiles), marcador: args.marcador || null })
    : { lineas: 0, umbral: 0, noMedidos: [], ausentes: [], avisosBase: [], noHaceFalta: true };
  const noMedidos = {
    ...(densidad.noMedidos.length ? { archivos_no_medidos: densidad.noMedidos } : {}),
    ...(densidad.ausentes.length ? { archivos_ausentes_permitidos: densidad.ausentes } : {}),
    ...(densidad.avisosBase.length ? { base_descartada: densidad.avisosBase } : {}),
  };
  const denso = hayQueMedir && densidad.lineas >= densidad.umbral;
  // 🔴 Un archivo que no se pudo medir no es «0 líneas». Lo medido es un piso: si ya pasa el umbral cuenta como denso;
  //    si no, decidir con archivos sin medir sería decidir a ciegas, igual que sin `--files`. Se corta con las rutas y el
  //    motivo a la vista.
  if (hayQueMedir && !denso && densidad.noMedidos.length) {
    return {
      run: null, risk: 'no-medible', model: null, ...extras,
      densidad_medida: false,
      lineas_agregadas_medidas: densidad.lineas, umbral_lineas: densidad.umbral, ...noMedidos,
      reason: `no pude medir ${densidad.noMedidos.length} archivo(s) de código del diff `
        + `(${densidad.noMedidos.map((n) => `${n.file}: ${n.motivo}`).join(' · ')}); lo medido da `
        + `${densidad.lineas} líneas agregadas (umbral ${densidad.umbral}), pero lo que no se midió no cuenta `
        + 'como 0. Pasá rutas que estén dentro de un repo git (el de la story o un companion), o pedí '
        + 'el pase con `--deep-review` (saltearlo lo firma una persona: `marker.js sign-adversarial-skip`).',
    };
  }
  const m = denso ? celda(true) : sinDensidad;
  const medida = densidad.noHaceFalta ? {} : { lineas_agregadas: densidad.lineas, umbral_lineas: densidad.umbral, ...noMedidos };
  const comun = { size: m.size, decision: m.decision, delicate: { value: !!delicada.value, reason: delicada.reason || null },
    verifiers: config.review_runner.verifiers, blocking_severity: config.review.blocking_severity, ...medida };
  const risk = delicada.value ? 'delicate' : denso && rc.risk !== 'NORMAL' ? 'dense' : rc.risk;
  const porque = `risk-class ${rc.risk}${rc.risk === 'NORMAL' && porOtro.length ? ` (${porOtro.join(', ')})` : ''} → ${m.reason}`;
  if (m.decision === 'run') return { run: true, risk, model, ...extras, ...comun, reason: porque };
  // una celda que preguntaba o esperaba la decide la respuesta anotada para este mismo diff (marker.js review-answer)
  if ((m.decision === 'ask' || m.decision === 'wait') && args.codeAnswer === 'review') {
    return { run: true, risk, model, ...extras, ...comun, decision: 'run', reason: `${porque} → contestaron «review» (review-answer)` };
  }
  const contestoSkip = (m.decision === 'ask' || m.decision === 'wait') && args.codeAnswer === 'skip';
  // Constancia de que se decidió A CIEGAS.
  // La lista de superficie compartida es opt-in por repo, así que un repo que nunca la declaró NO
  // está cubierto — y sin esta línea eso se lee igual que "no hacía falta". Queda escrito en el
  // veredicto y en gates.log: "no está cubierto" tiene que ser visible, no silencioso.
  const sinDeclarar = deepReviewAlwaysPaths(args.repo).length === 0;
  if (sinDeclarar) {
    logGate({
      repoPath: args.repo, name: 'deep-review-gate', check: 'shared-surface', status: 'undeclared',
      decision: m.decision === 'skip' ? 'skip-por-LOW' : m.decision, files: Array.isArray(args.files) ? args.files.length : 0,
    });
  }
  const superficie = sinDeclarar ? {
    shared_surface_declared: false,
    shared_surface_note:
      'este repo NO declaró `deep_review_always_paths` en .tycon/advisors.yaml, así que el skip se ' +
      'decidió SÓLO por tamaño de diff: si el cambio toca código que corre en nombre de todos los ' +
      'plugins/clientes, este gate no lo puede saber. Declararlo es de una vez por repo.',
  } : { shared_surface_declared: true };
  const lineas = densidad.noHaceFalta ? 'sin medir la densidad: no cambia la celda' : `${densidad.lineas} líneas agregadas < ${densidad.umbral}`;
  // preguntar o esperar no es «no medible» (`run: null`, que corta con 2): el pase no corre todavía y la salida es 0
  if (contestoSkip) return { run: false, risk, model: null, ...comun, ...superficie, decision: 'skip', reason: `${porque} → contestaron «skip» (review-answer)` };
  if (m.decision === 'ask') {
    return { run: false, risk, model: null, ...comun, ...superficie, question: '¿Corro el pase adversarial sobre este cambio? (antes de preguntar: marker.js review-ask --kind code)',
      reason: `${porque} (${lineas}): se le pregunta a la persona` };
  }
  if (m.decision === 'wait') return { run: false, risk, model: null, ...comun, ...superficie, reason: `${porque} (${lineas}): espera a la persona` };
  return { run: false, risk, model: null, ...comun, ...superficie, reason: `${porque} → skip (${lineas}; override: --deep-review)` };
}

/**
 * Líneas AGREGADAS en los archivos de código del diff. Cada archivo se mide en SU
 * repo git, el de su propia carpeta (`companionLib.ownerOf`, la misma pieza que usa el pipeline para leer el diff de
 * un repo hermano): tracked → `git diff --numstat <base>` contra la base de la corrida (0 si no cambió); sin
 * trackear en su repo → el archivo entero (es nuevo). Sólo extensiones de código: un HTML generado o
 * un JSON de datos no es lógica que un hunter tenga que ejecutar.
 *
 * 🔴 Stories de dos repos: la story vive en el backend y el código en el
 *    frontend, un repo companion. Medido con `git -C <repo de la story>`, cada archivo del frontend daría
 *    «no trackeado» y se sumaría ENTERO (1464 líneas contra 221 reales), y el portón correría el pase por
 *    «denso». Lo que no se puede medir (fuera de todo repo git, git que no contesta, un numstat que no es
 *    un número) NO se cuenta como archivo entero ni como 0: vuelve en `noMedidos`, y el portón lo dice.
 */
function densidadDelDiff(repo, files, { allowMissing = false, marcador = null } = {}) {
  const env = Number(process.env.TYCON_DEEP_REVIEW_DENSE_LINES);
  const umbral = Number.isFinite(env) && env > 0 ? env : 300;
  const { spawnSync: sp } = require('child_process');
  // Lo commiteado durante la corrida también es del diff: cada repo se mide contra la base de la corrida (`baseSha` del
  // marcador, si es de ese repo) o contra su bifurcación con la rama principal; HEAD sólo si no hay ninguna.
  // Una base descartada (un marcador que no sirve) se dice en `avisosBase`; el marcador de otro repo no, porque es lo
  // normal en un repo hermano.
  const bases = new Map();
  const avisosBase = [];
  const baseDe = (raiz) => {
    if (!bases.has(raiz)) {
      const b = require('./coverage-base.js').resolver({ repo: raiz, env: process.env, marker: marcador });
      for (const d of b.descartadas) if (!/otro repo/.test(d.motivo)) avisosBase.push(`${raiz}: ${d.source}: ${d.motivo}`);
      bases.set(raiz, b.ref || 'HEAD');
    }
    return bases.get(raiz);
  };
  let lineas = 0;
  const noMedidos = [];
  const ausentes = [];   // con --allow-missing-files: ausentes y sin trackear, contados 0 a sabiendas
  for (const f of (Array.isArray(files) ? files : [])) {
    // el código de lib/code-files.js (con lo que sume la organización) más `.sql`
    if (!codeFiles.isCode(f, { extra: stackConfig.orgExtra() }) && !/\.sql$/i.test(f)) continue;
    const o = companionLib.ownerOf(f, repo || process.cwd());
    const abs = o.abs;
    if (!o.root) {
      // `ownerOf` sube un número fijo de carpetas buscando `.git`: un archivo más hondo se le escapa. Se le pregunta a git
      // desde la carpeta existente más cercana.
      let dir = path.dirname(abs);
      while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
      const top = sp('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const raiz = top.status === 0 ? String(top.stdout || '').trim() : '';
      if (raiz) {
        o.root = raiz;
        o.rel = path.relative(fs.realpathSync(raiz), path.join(fs.realpathSync(dir), path.relative(dir, abs))).split(path.sep).join('/');
      }
    }
    // `ownerOf` da como raíz la carpeta de `--repo` aunque no sea un repo git: eso tampoco se puede medir
    if (!o.root || !companionLib.gitRootOf(o.root)) { noMedidos.push({ file: f, motivo: 'no está dentro de ningún repo git' }); continue; }
    const ls = sp('git', ['-C', o.root, 'ls-files', '--error-unmatch', '--', o.rel], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (ls.error) { noMedidos.push({ file: f, motivo: `no pude correr git (${ls.error.message})` }); continue; }
    // `ls-files --error-unmatch`: 0 = trackeado, 1 = no trackeado. Cualquier otra salida (128 por safe.directory o un repo
    // roto, una señal) es «git no pudo decir», no «no trackeado»: sumarlo entero sería un error.
    if (ls.status !== 0 && ls.status !== 1) { noMedidos.push({ file: f, motivo: `git no pudo decir si está trackeado en ${o.root} (salida ${ls.status === null ? `señal ${ls.signal}` : ls.status})` }); continue; }
    const tracked = ls.status === 0;
    if (tracked) {
      const r = sp('git', ['-C', o.root, 'diff', '--numstat', baseDe(o.root), '--', o.rel], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const salida = String(r.stdout || '').trim();
      if (r.status !== 0) { noMedidos.push({ file: f, motivo: `git diff falló en ${o.root}` }); continue; }
      if (!salida) continue;   // tracked y sin cambios respecto de la base: 0 agregadas, medido
      const a = Number(salida.split(/\s+/)[0]);
      if (Number.isFinite(a)) lineas += a;
      else noMedidos.push({ file: f, motivo: `git diff --numstat no dio un número («${salida.split(/\s+/)[0]}»: ¿binario?)` });
    } else {
      let texto;
      try { texto = fs.readFileSync(abs, 'utf8'); } catch (e) {
        // con `--allow-missing-files` quien llama ya dijo que puede haber archivos que no están (borrados): ausente = 0
        // borrado por el cambio (`git rm`, o el nombre viejo de un `git mv`): no está en el índice ni en el disco, pero
        // sí en HEAD. Agrega 0 líneas, medido (sin esto, cortaría stories de un solo repo).
        if (e.code === 'ENOENT' && sp('git', ['-C', o.root, 'cat-file', '-e', `HEAD:${o.rel}`], { windowsHide: true, stdio: 'ignore' }).status === 0) continue;
        if (allowMissing && e.code === 'ENOENT') { ausentes.push(f); continue; }
        noMedidos.push({ file: f, motivo: `no está trackeado en ${o.root} y no lo pude leer (${e.code || e.message})` });
        continue;
      }
      lineas += texto.split('\n').length;
    }
  }
  return { lineas, umbral, noMedidos, ausentes, avisosBase };
}

// ── Validación de --files ─────────────────────────────
// Un --files mal expandido por el shell (p.ej. zsh NO hace word-split de
// variables sin comillas → N paths llegan como UN argumento inexistente) haría
// que detectStack viera 0 archivos de código → onlyDocs=true → set degradado a 3
// advisors, PERSISTIDO como expected[] (check-count validaría contra 3 con 13
// faltantes — fail-open silencioso). Acá: si >0 files no existen → ABORT exit 2.
// Override consciente para diffs con archivos borrados: --allow-missing-files.
/**
 * ¿`--files` llegó como UN solo argumento con espacios? (word-split del shell fallado)
 *
 * Vive aparte de `validateFilesExist`: los gates
 * `risk-class` y `deep-review-gate` necesitan ESTA guarda y NO la validación de existencia
 * (un diff que borra archivos pasa paths que ya no existen — legítimo, y con la validación de existencia esos
 * dos comandos abortarían en un diff válido). `advisors` y `smart-reloop` siguen corriendo las dos.
 *
 * @returns {string|null} el mensaje de error, o null si está bien
 */
function detectarWordSplit(args) {
  if (!args || !Array.isArray(args.files) || args.files.length !== 1) return null;
  const uno = args.files[0];
  // Las DOS condiciones son necesarias: un solo argumento CON espacios que además NO existe en
  // disco. Sin la de los espacios, un diff que borra su único archivo abortaría (caso legítimo);
  // sin la de existencia, un path real con espacios (macOS) abortaría también.
  if (!/\s/.test(String(uno))) return null;
  const absUno = path.isAbsolute(uno) ? uno : path.join(args.repo || '.', uno);
  if (!exists(absUno)) {
    const pedazos = uno.split(/\s+/).filter(Boolean);
    const existen = pedazos.filter((f) => exists(path.isAbsolute(f) ? f : path.join(args.repo || '.', f)));
    return (
    '🛑 --files llegó como UN SOLO argumento con espacios (word-split fallado).\n' +
    `  recibido: ${uno.length > 200 ? `${uno.slice(0, 200)}…` : uno}\n` +
    `  partido por espacios: ${pedazos.length} paths, ${existen.length} existen en disco.\n` +
    'Causa: zsh NO word-splitea $VAR sin comillas — usá ${=VAR} o pasá los paths explícitos.\n' +
    'Por qué ABORTA y no sigue: con 1 archivo contado, risk-class da LOW y eso apaga DOS frenos\n' +
    'a la vez — la revisión adversarial de la story y el pase adversarial\n' +
    '(deep-review-gate) — sin dejar rastro de que se apagaron por un error de parseo.\n'
    );
  }

  return null;
}

/**
 * ¿Algún `--files` es un FANTASMA?
 *
 * Fantasma = no está en el disco Y git no lo conoce en `HEAD` del repo que lo contiene. Un archivo que el cambio BORRÓ
 * está en `HEAD`: es legítimo y pasa. Lo que no está en
 * ningún lado es una lista rota: `--files a.cs,b.cs` en un solo argumento, sin espacios, que `detectarWordSplit` no ve.
 * Con esa entrada `densidadDelDiff` contaría 0 líneas, el gate daría LOW y
 * `run:false` sobre un cambio de ~955 líneas, y nada lo diría. Las rutas absolutas de otro repo se juzgan en SU repo.
 * Override consciente: `--allow-missing-files`.
 *
 * @returns {string|null} el mensaje de error, o null si está bien
 */
function archivosFantasma(args) {
  if (!args || args.allowMissingFiles || !Array.isArray(args.files) || !args.files.length) return null;
  const { execFileSync } = require('child_process');
  // 'si' = git lo conoce en HEAD (un borrado) · 'no' = git respondió y no lo conoce · 'sin-git' = no hubo a quién
  // preguntarle (fuera de un repo, sin git, sin HEAD). Los dos últimos frenan, pero el mensaje dice cuál fue.
  const enHead = (abs) => {
    // el ancestro más cercano que existe: ahí se le pregunta a git (un archivo borrado puede dejar su carpeta vacía)
    let dir = path.dirname(abs);
    while (!exists(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    let raiz;
    try {
      raiz = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      execFileSync('git', ['-C', raiz, 'rev-parse', '--verify', '--quiet', 'HEAD'], { windowsHide: true, stdio: 'ignore' });
    } catch { return 'sin-git'; }
    const rel = path.relative(fs.realpathSync(raiz), path.join(fs.realpathSync(dir), path.relative(dir, abs))).split(path.sep).join('/');
    if (!rel || rel.startsWith('../')) return 'no';
    try { execFileSync('git', ['-C', raiz, 'cat-file', '-e', `HEAD:${rel}`], { windowsHide: true, stdio: 'ignore' }); return 'si'; } catch { return 'no'; }
  };
  const fantasmas = [];
  let sinGit = 0;
  for (const f of args.files) {
    const abs = path.isAbsolute(f) ? f : path.join(args.repo || '.', f);
    if (exists(abs)) continue;
    const v = enHead(path.resolve(abs));
    if (v === 'si') continue;
    if (v === 'sin-git') sinGit++;
    fantasmas.push(f);
  }
  if (!fantasmas.length) return null;
  return (
    `🛑 ${fantasmas.length}/${args.files.length} de los --files no están en el disco NI en HEAD (no son archivos borrados):\n` +
    fantasmas.slice(0, 8).map((m) => `  - ${m}`).join('\n') +
    (fantasmas.length > 8 ? `\n  ... y ${fantasmas.length - 8} más` : '') +
    '\n\nCausa típica: la lista separada por comas en un solo argumento, o una expansión de shell rota (zsh NO\n' +
    'word-splitea $VAR sin comillas — usá ${=VAR} o pasá los paths explícitos, separados por espacio).\n' +
    'Por qué FRENA: un archivo que no existe cuenta 0 líneas, y con 0 líneas el veredicto da LOW — eso apaga el\n' +
    'checkpoint del plan y el pase adversarial sin dejar rastro de que la entrada estaba rota.\n' +
    (sinGit ? `Ojo: para ${sinGit} de ellos no pude preguntarle a git (fuera de un repo, sin git o sin commits): si son\n` +
      'archivos BORRADOS por el cambio, no pude confirmarlo — revisá la lista y, si está bien, --allow-missing-files.\n' : '') +
    'Si de verdad hay que seguir con archivos que no están: --allow-missing-files.\n'
  );
}

function cmdDeepReviewGate(cmd, args) {
  // Pase adversarial: ¿corre el pase adversarial reproduce-or-refute? {run, model, reason}. Gate = risk-class
  // NORMAL + overrides. Exit 0: el orquestador lee `run`. Exit 3: corre, pero otra sesión tiene su pase en vuelo y va
  // uno por vez (`waiting_turn`): no se lanza todavía.
  // Misma guarda que risk-class: el default de este gate ES risk-class, así que
  // un --files mal expandido produce un LOW silencioso y sella el pase adversarial como hecho
  // (`deepReviewDone`). Abortar es correcto AUNQUE el comando sea informativo: un veredicto
  // computado sobre entrada rota es peor que no tener veredicto.
  const wsErr = detectarWordSplit(args);   // ídem risk-class: la guarda de aridad…
  if (wsErr) { process.stderr.write(wsErr); process.exit(2); }
  const fantasmaErr = archivosFantasma(args);   // …y la de archivos fantasma
  if (fantasmaErr) { process.stderr.write(fantasmaErr); process.exit(2); }
  // Sólo esta rama lee la máquina —la configuración de la organización y el pedido de la corrida— y se los pasa al
  // portón; los avisos también salen de acá.
  const conModelos = conModelosDeLaCorrida({ ...args, runSize: runSizeDelMarcador(args.story) });
  const corrida = readSessionMarker();
  // La constancia del salteo se lee acá, de la corrida y del registro de la cuenta; un pedido sin ella se muestra.
  const { result, texto: textoDelPedido } = deepReviewGateDeLaCorrida({ args: conModelos, corrida, mostrar: true });
  if (textoDelPedido) process.stderr.write(textoDelPedido);
  if (conModelos.orgDeepReviewProblem) process.stderr.write(`deep-review-gate: ${conModelos.orgDeepReviewProblem}\n`);
  for (const p of conModelos.reviewConfigProblems || []) process.stderr.write(`deep-review-gate: ${p.path}: ${p.message}\n`);
  if (result && result.decision === 'ask' && result.question) process.stderr.write(`deep-review-gate: ${result.question}\n`);
  if (result) decirModelos(result, conModelos.orgModels, estadoPipeline.avisosDelPorton);
  if (result && result.run === null) {
    // 🔴 No se pudo medir: se dice y se CORTA. «Correr por las dudas» tampoco es gratis — una
    // corrida del pase adversarial midió 6,5 M de tokens y 30 minutos, así que el lado barato no
    // es revisar de más: es arreglar la llamada, que es donde está el error.
    process.stderr.write(`deep-review-gate: ${result.reason}\n`);
    process.exit(2);
  }
  // Con una corrida activa de ESTA story y «Correr las pruebas» cerrado, el veredicto queda anotado
  // (`adversarialGate`) para que `next` pida el lanzamiento sin recalcular el portón. Lo escribe marker.js (un
  // solo escritor del marker); `computeDeepReviewGate` sigue sin tocarlo. Sin corrida no se anota ni se avisa. El
  // temprano que se imprime es el que vale para la corrida: visto apagado una vez, sigue apagado.
  const mismaStory = !corrida || esLaStoryDelMarcador(args.story, corrida);
  // Un pase que quedó NO MEDIDO (alguna lente sin su cazador, algún hallazgo sin su verificador) es un
  // pase que falta. El portón dice que corre —así el salteo se niega— salvo la constancia firmada por el dueño.
  if (corrida && mismaStory && !result.adversarial_skip && result && typeof result.run === 'boolean') {
    const { veredictoPaseAdversarial, SALIDA_APROBADA } = require('./adversarial-verdict.js');
    const v = veredictoPaseAdversarial(corrida);
    if (v.motivo === 'pase-no-medido') {
      const p = v.pase || {};
      const porque = `el pase anterior quedó NO MEDIDO (${p.motivo_no_medido || 'no revisó todo'}): un pase que no revisó todo es un pase que falta — relanzalo (--relaunch), o ${SALIDA_APROBADA}`;
      result.reason = result.run ? `${porque} · ${result.reason}` : `${porque} · el portón por sí solo decía: ${result.reason}`;
      if (!result.run) { result.run = true; result.model = result.model || p.modelo || MODELOS.DEFAULTS.adversarial.model; }
      result.previous_pass = 'no-medido';
    }
  }
  if (corrida && corrida.storyId && mismaStory && STEPS_TABLE.isDone(corrida, 'run-tests')
      && Array.isArray(args.files) && args.files.length && typeof result.run === 'boolean') {
    try {
      const out = require('child_process').execFileSync(process.execPath, [path.join(estadoPipeline.SCRIPTS_DIR, 'marker.js'), 'mark-adversarial-gate',
        JSON.stringify({ run: result.run, files: args.files, decision: result.decision || null, early_env: nn(process.env.TYCON_5B_EARLY, null) })],
      { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
      const anotado = JSON.parse(out || '{}');
      if ('early_launch' in result && typeof anotado.early_launch === 'boolean' && anotado.early_launch !== result.early_launch) {
        result.early_launch = anotado.early_launch;
        result.early_launch_origin = anotado.early_origin || 'la corrida';
      }
    } catch (e) {
      process.stderr.write(`deep-review-gate: no pude anotar el veredicto en la corrida (${e.message.split('\n')[0]}) — \`next\` va a pedir consultar el portón otra vez\n`);
    }
  }
  // Con otra sesión en su pase adversarial, o una ejecución grande de pruebas en curso, va una tarea pesada por vez
  // (guides/coordination.md): sale 3 y dice quién tiene el lugar.
  // Sin coordinadora designada, o sin ninguna de las dos, el veredicto sale igual que siempre.
  if (result && result.run === true) {
    try {
      const turno = require(path.join(estadoPipeline.SCRIPTS_DIR, '..', '..', '..', 'scripts', 'tools', 'coordination.js'))
        .adversarialTurn({ sessionId: (corrida && corrida.sessionId) || sessionIdFileKey() });
      if (turno) Object.assign(result, turno);
    } catch (e) {
      process.stderr.write(`deep-review-gate: no pude ver si hay otro pase adversarial en vuelo o una ejecución grande de pruebas (${String(e.message).split('\n')[0]})\n`);
    }
  }
  // las dos señales, como aviso y por la historia entera: no cambian el pase
  if (result && typeof result === 'object') {
    const avisos = senalesDe(args.story, args.repo, undefined);
    if (avisos.length) result.warnings = [...(result.warnings || []), ...avisos];
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result && result.waiting_turn === true) {
    process.stderr.write(`deep-review-gate: ${result.turn}\n`);
    process.exit(3);
  }
  process.exit(0);
}

module.exports = { cmdDeepReviewGate, deepReviewGateDeLaCorrida, densidadDelDiff, archivosFantasma, computeDeepReviewGate, detectarWordSplit, senalesDe };
