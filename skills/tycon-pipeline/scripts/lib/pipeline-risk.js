/**
 * pipeline-risk.js — una parte de pipeline.js (la cargan otras partes).
 *
 * Responsabilidad: el tamaño y el riesgo de una corrida.
 *
 * Lo que cambia mientras corre (los avisos del portón, la sesión para la que se trabaja) y las rutas del despachador
 * se leen de `estadoPipeline`, en el módulo compartido, en el momento de usarlos.
 */
const { estadoPipeline, companionLib, deepReviewConfig, esLaStoryDelMarcador, fs, matchGlob, parseFrontmatterPipeline, path, readSessionMarker, readText } = require('./pipeline-shared.js');

// ── Frontmatter helpers para next/start/risk-class ───────────────────────────
// parseFrontmatterPipeline (más abajo) es single-line; esto extrae LISTAS yaml
// (`files_to_modify:` seguido de `  - path`) del frontmatter.
function parseFrontmatterList(content, key) {
  const m = (content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  const out = [];
  let inKey = false;
  let keyIndent = 0;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (!inKey) {
      const km = line.match(new RegExp(`^(\\s*)${key}\\s*:\\s*$`));
      if (km) { inKey = true; keyIndent = km[1].length; }
      continue;
    }
    if (line.trim() === '') continue;
    if (indent <= keyIndent) break;
    const im = line.match(/^\s*-\s*(.+?)\s*$/);
    if (im) out.push(im[1].replace(/^["']|["']$/g, ''));
  }
  return out;
}

// ── pipeline.js risk-class ───
// Clasifica la story en LOW o NORMAL: lo usan la revisión adversarial de la story y el tamaño de la corrida. Ningún
// plan se aprueba solo por ser LOW: lo aprueba una persona, o la coordinadora con la revisión automática.
// Además dice si la story es delicada (`computeDelicate`): el plan de una delicada lo aprueba siempre el dev.
// ── El tamaño de la corrida: liviana (sólo documentación) o completa. Lo clasifica lib/run-size.js por
// lo que la story DECLARA; `args.runSize` (el forzado del marcador, que sólo leen las ramas de línea de comandos)
// manda. Sin story legible, completa. El repo aporta sus superficies del pase adversarial.
const runSizeLib = require('./run-size.js');
function computeRunSize(args) {
  if (args.runSize && runSizeLib.SIZES.includes(args.runSize.size)) {
    const forzado = { size: args.runSize.size, reason: `forzado a mano: ${args.runSize.reason || '(sin motivo)'}`, first_code_file: null, forced: true };
    // `set-size` sólo ve lo que la story declara: si el cambio toca código, liviana sin la firma del dueño apagaría el
    // pase. Ahí manda lo que el cambio toca, y el forzado no vale.
    if (forzado.size !== 'liviana' || args.runSize.firmado) return forzado;
    const real = computeRunSize({ ...args, runSize: null });
    if (real.size === 'liviana') return forzado;
    return { ...real, reason: `forzada a liviana sin la firma de una persona, y el cambio toca código: no vale · ${real.reason}`, forced_ignored: true };
  }
  const content = args.story && fs.existsSync(args.story) ? readText(args.story) : '';
  const repo = args.repo && fs.existsSync(args.repo) ? args.repo : null;
  // Lo declarado Y lo que el cambio toca de verdad (`--files`, el diff): una story que declara un .md y toca código no
  // puede salir liviana (pase adversarial). Sin story no hay tamaño: sólo con el diff no se sabe qué faltó declarar.
  // con una parte válida (sólo como argumento explícito: el plan), lo declarado es su lista
  const parte = parteDelArg(args);
  const declared = parte ? parte.files : runSizeLib.declaredFiles(content);
  const rel = (f) => (repo && path.isAbsolute(f) && !path.relative(repo, f).startsWith('..') ? path.relative(repo, f) : f);
  const touched = Array.isArray(args.files) ? args.files.map(rel) : [];
  if (!declared.length) return runSizeLib.classifyStory({ files: [] });
  const files = [...new Set([...declared, ...touched])];
  return runSizeLib.classifyStory({
    files,
    alwaysPaths: repo ? deepReviewAlwaysPaths(repo) : [],
    deepReviewCfg: repo ? deepReviewConfig(repo) : null,
    roots: repo ? [repo] : [],
  });
}

/**
 * La parte con la que se mide (lib/batch-scope.js), sólo si viene como argumento explícito (`args.batch`): la pasan el
 * comando `risk-class` y la revisión del plan, nadie más. Sin ella, o con una que no vale, null: la historia entera.
 */
function parteDelArg(args) {
  if (!args || !args.batch) return null;
  return require('./batch-scope.js').parteMedible(args.story, args.batch);
}

/** El tamaño forzado a mano en el marcador de esta sesión, si es de la misma story: `{ size, reason }` o null. */
function runSizeDelMarcador(storyPath) {
  const m = readSessionMarker();
  if (!m || !m.sizeForced || !runSizeLib.SIZES.includes(m.size)) return null;
  if (!esLaStoryDelMarcador(storyPath, m)) return null;
  return { size: m.size, reason: m.sizeForced.reason, firmado: !!m.sizeForced.firmado };
}

function computeRiskClass(args) {
  const storyPath = args.story;
  if (!storyPath || !fs.existsSync(storyPath)) {
    return { risk: 'NORMAL', error: `--story inválido: ${storyPath}`, delicate: computeDelicate(args) };
  }
  const content = readText(storyPath);
  const fm = parseFrontmatterPipeline(content);
  // con una parte válida, su lista MÁS lo que el cambio toca (une); sin ella, `--files` reemplaza lo declarado, como siempre
  const parte = parteDelArg(args);
  const scopeFiles = parte
    ? [...new Set([...parte.files, ...(args.files || [])])]
    : args.files && args.files.length
      ? args.files
      : [...parseFrontmatterList(content, 'files_to_create'), ...parseFrontmatterList(content, 'files_to_modify')];

  const criteria = [];
  const add = (name, pass, detail) => criteria.push({ name, pass, detail });

  add('sin-migraciones-sql', !scopeFiles.some((f) => /\.sql$|(^|\/)drizzle\//i.test(f)),
    'migraciones de schema cambian datos — siempre plan HITL');
  add('sin-scope-firmado', !fm.signed_for_sprint && !fm.signed_ac_ref,
    `signed_for_sprint=${fm.signed_for_sprint || '(ausente)'} signed_ac_ref=${fm.signed_ac_ref || '(ausente)'} — stories firmadas con cliente siempre plan HITL`);
  // en una corrida liviana (sólo documentación) el tamaño solo no sube el riesgo.
  const runSize = computeRunSize(args);
  if (runSize.size === 'liviana') {
    add('superficie-chica', scopeFiles.length > 0,
      `${scopeFiles.length} archivos en scope, todos documentación: corrida liviana, el tamaño no cuenta`);
  } else {
    add('superficie-chica', scopeFiles.length > 0 && scopeFiles.length <= 6,
      `${scopeFiles.length} archivos en scope (límite 6; 0 archivos = scope no declarado → NORMAL)`);
  }
  add('sin-paths-sensibles', !scopeFiles.some((f) => /auth|security|payment|crypto|secret|credential/i.test(f)),
    'archivos de auth/seguridad/pagos siempre plan HITL');
  if (parte) {
    add('sin-pipelines-multi-tanda', true, `la parte ${parte.nombre} es válida: la dependencia entre partes la dice blocked_by`);
  } else {
    add('sin-pipelines-multi-tanda', !/^pipelines:/m.test(content),
      'stories con entregas en tandas tienen interdependencias — plan HITL');
  }
  // un freno del repo (lo que nombra su manifiesto de controles) no es una historia chica; sin manifiesto, no aplica
  const repoDeLosFrenos = args.repo && fs.existsSync(args.repo) ? args.repo : repoDeLaStory(storyPath);
  const frenos = frenosDelManifiesto(repoDeLosFrenos);
  if (frenos && frenos.error) {
    add('sin-frenos', false, `no pude leer el manifiesto de controles (scripts/ci/controls-from-base.json: ${frenos.error}): en duda, la corrida es NORMAL`);
  } else if (frenos) {
    const tocados = [...new Set(scopeFiles.map((f) => rutaComparable(f, [repoDeLosFrenos]).rel).filter((r) => frenos.files.has(r)))];
    add('sin-frenos', tocados.length === 0, tocados.length
      ? `el alcance toca frenos del manifiesto de controles (${tocados.join(', ')}) — plan HITL y pase adversarial`
      : 'ningún archivo del alcance es un freno del manifiesto de controles');
  }

  const allPass = criteria.every((c) => c.pass);
  return {
    risk: allPass ? 'LOW' : 'NORMAL',
    run_size: runSize.size,
    criteria,
    delicate: computeDelicate(args),
    ...(args.batch ? { batch: parte ? { name: parte.nombre, valid: true } : { name: args.batch, valid: false, reason: 'la parte no vale: se mide la historia entera' } } : {}),
    note: allPass
      ? 'LOW-risk: la revisión adversarial de la story se saltea. El plan lo aprueba una persona, o la coordinadora con la revisión automática.'
      : 'NORMAL: «Aprobar el plan» con la persona, o la coordinadora con la revisión automática si la story no es delicada.',
  };
}

/**
 * Los frenos que nombra el manifiesto de controles de un repo (scripts/ci/controls-from-base.json): `controls[].script`,
 * `controls[].rules` (una cadena o un objeto con `path`, también los `optional`) y `workflows[].path`. `content` no
 * cuenta: es lo que el manifiesto declara que no es regla. Más angosto que `archivosDeControles` a propósito: esa suma
 * el código que cargan los guiones (bibliotecas compartidas que no son frenos). `{ files: Set }`, `{ error }` si no se
 * puede leer, o null sin manifiesto. Nunca tira.
 */
function frenosDelManifiesto(raiz) {
  if (!raiz) return null;
  const f = path.join(raiz, 'scripts', 'ci', 'controls-from-base.json');
  let texto;
  try { texto = fs.readFileSync(f, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? null : { error: (e && e.code) || String(e) }; }
  let inv;
  try { inv = JSON.parse(texto); } catch (e) { return { error: `no es JSON válido (${String((e && e.message) || e).split('\n')[0]})` }; }
  if (!inv || !Array.isArray(inv.controls)) return { error: 'no tiene «controls»' };
  const ruta = (r) => (typeof r === 'string' ? r : r && typeof r.path === 'string' ? r.path : null);
  const files = new Set([
    ...inv.controls.flatMap((c) => (c && typeof c === 'object' ? [c.script, ...(Array.isArray(c.rules) ? c.rules.map(ruta) : [])] : [])),
    ...(Array.isArray(inv.workflows) ? inv.workflows.map(ruta) : []),
  ].filter((x) => typeof x === 'string' && x).map((x) => x.replace(/\\/g, '/').replace(/^\.\//, '')));
  return { files };
}

// ── ¿La story es delicada? ──
// Su plan es nivel 2: lo aprueba siempre el dev, nunca la coordinadora con la revisión automática. Las reglas por
// archivo (de los archivos de la story y de las rutas que nombra el plan, `args.planText`) son las de lib/risk-paths.js,
// las mismas del camino rápido; la historia suma las suyas: `riesgo_alto_por:` primero, `sensible:` antes de los
// controles y los archivos de dependencias al final. La primera que se cumple da el motivo. En duda, delicada: lo que no
// se puede leer cuenta como delicado, con «no pude saber».
const riskPaths = require('./risk-paths.js');
// rutas que nombra un plan: absolutas o relativas, con `/` o con `\` (Windows), una carpeta, o un nombre suelto con una
// extensión conocida
const RE_RUTA_DEL_PLAN = /(?:[A-Za-z]:)?[\\/]?(?:[\w.@-]+[\\/])+[\w.@-]*|[\w@-]+\.(?:c?js|mjs|ts|tsx|jsx|sh|ps1|ya?ml|json|sql|cs|csproj|md|py)\b/g;

function rutasDelPlan(texto) {
  const out = new Set();
  for (const m of String(texto || '').matchAll(RE_RUTA_DEL_PLAN)) {
    const r = m[0].replace(/[.,;:)]+$/, '');
    if (r.replace(/[\\/]/g, '')) out.add(r);
  }
  return [...out];
}

// Lo que un plan sólo corre no lo vuelve delicado. Una ruta cuenta si «## Archivos» la nombra, o si aparece fuera de
// esa sección de cualquier forma que no sea el comando que la ejecuta: en código (entre comillas invertidas, o un
// renglón de un bloque cercado), un comando simple, con uno de estos programas delante, y la ruta como lo que ejecuta.
// La ruta sola entre comillas es un nombre: «Cambio `x`» y «Corro `x`» no se distinguen sin leer el verbo.
const PROGRAMAS_QUE_CORREN = new Set(['node', 'bash', 'sh', 'zsh', 'pwsh', 'python', 'python3']);
// un segundo comando, una tubería o una redirección pueden esconder un cambio: ese código cuenta entero
const RE_COMANDO_COMPUESTO = /[;&|<>]|\$\(/;
const RE_GANCHO_DE_GIT = /(^|\/)\.githooks(\/|$)/;

/** El plan en piezas `{ codigo, texto }`: la prosa, cada código entre comillas invertidas y cada renglón cercado. */
function piezasDelPlan(texto) {
  const piezas = [];
  let cercado = false;
  for (const renglon of String(texto || '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(renglon)) { cercado = !cercado; continue; }
    if (cercado) { piezas.push({ codigo: true, texto: renglon }); continue; }
    // el código en línea va entre una o más comillas invertidas
    const partes = renglon.split(/`+/);
    // una comilla sin cerrar deja lo que sigue del lado de la prosa
    const cerradas = partes.length % 2 === 1 ? partes.length : partes.length - 1;
    partes.forEach((p, i) => piezas.push({ codigo: i % 2 === 1 && i < cerradas, texto: p }));
  }
  return piezas;
}

/**
 * Las palabras de un código que el comando ejecuta: `{ palabras, corre }`, con `corre` los índices de las que ejecuta
 * (después de `node --test`, todas las que no son opciones; si no, la primera que no es opción). null si el código no es
 * un comando simple con un programa que ejecuta delante.
 */
function loQueSeCorre(codigo) {
  if (RE_COMANDO_COMPUESTO.test(codigo)) return null;
  const todas = codigo.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, '')).filter(Boolean);
  if (!todas.length || !PROGRAMAS_QUE_CORREN.has(todas[0])) return null;
  const palabras = todas.slice(1);
  const noOpciones = palabras.map((w, i) => (w.startsWith('-') ? -1 : i)).filter((i) => i >= 0);
  const conTest = todas[0] === 'node' && palabras.includes('--test');
  return { palabras, corre: new Set(conTest ? noOpciones : noOpciones.slice(0, 1)) };
}

/**
 * Las rutas del plan que cuentan para la marca de delicada. Sin «## Archivos», o sin ninguna ruta en ella, todas: sin la
 * lista de lo que se cambia no se sabe qué sólo se corre. Una ruta que sólo se corre se descuenta si, sola, no es
 * delicada, o lo es por los controles o por el gancho de git: correr un instalador, una migración, algo de producción o
 * de la superficie compartida escribe en lo que el plan no declaró, y cuenta.
 */
function rutasQueCuentanDelPlan(texto, { repo = null, raices = [] } = {}) {
  const { seccion } = require(path.join(estadoPipeline.SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'signature-sources.js'));
  const archivos = texto ? seccion(texto, 'Archivos') : null;
  const deArchivos = archivos ? rutasDelPlan(archivos.join('\n')) : [];
  if (!deArchivos.length) return rutasDelPlan(texto);
  const cuentan = new Set(deArchivos);
  const seCorren = new Set();
  for (const pieza of piezasDelPlan(texto)) {
    const corrida = pieza.codigo ? loQueSeCorre(pieza.texto) : null;
    if (!corrida) { for (const r of rutasDelPlan(pieza.texto)) cuentan.add(r); continue; }
    // lo que se ejecuta es una ruta entera: código en línea (`node -e "…"`) o rutas unidas por coma la nombran y cuentan
    corrida.palabras.forEach((w, i) => {
      const rutas = rutasDelPlan(w);
      const ejecuta = corrida.corre.has(i) && rutas.length === 1 && rutas[0] === w.replace(/[.,;:)]+$/, '');
      for (const r of rutas) (ejecuta ? seCorren : cuentan).add(r);
    });
  }
  const soloSeCorre = (ruta) => {
    // relativa a la raíz que la contiene, como las demás rutas: la absoluta de un repo hermano no queda afuera
    const r = riskPaths.riesgoDeArchivos([rutaComparable(ruta, raices)], { repo, raices, superficie: tocaSuperficieCompartida });
    return !r.value || r.rule === 'controles' || (r.rule === 'porton-instalador-migracion' && RE_GANCHO_DE_GIT.test(r.file || ''));
  };
  for (const r of seCorren) if (!cuentan.has(r) && !soloSeCorre(r)) cuentan.add(r);
  return [...cuentan];
}

/**
 * Una ruta de la story o del plan, en la forma en que se compara: sin el comentario del renglón (`- ruta   # nota`), sin
 * comillas, con `/`, y relativa a la raíz que la contiene cuando es absoluta. `{ rel, abs, base }`.
 */
function rutaComparable(f, raices) {
  let s = String(f).replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  const absoluta = path.isAbsolute(s) || /^[A-Za-z]:\//.test(s);
  let rel = s.replace(/^\.\//, '');
  if (absoluta) {
    for (const r of raices) {
      const x = path.relative(r, s).replace(/\\/g, '/');
      if (x && !x.startsWith('..') && !path.isAbsolute(x)) { rel = x; break; }
    }
  }
  return { rel, abs: absoluta ? s : null, base: path.posix.basename(rel.replace(/\/$/, '')) };
}

/** El repo de la story: el `--repo`, o la carpeta con `.git` más cercana hacia arriba. null si no hay. */
function repoDeLaStory(storyPath, repo) {
  if (repo) return repo;
  let d = path.dirname(path.resolve(storyPath));
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const arriba = path.dirname(d);
    if (arriba === d) return null;
    d = arriba;
  }
}

function computeDelicate(args) {
  const si = (rule, detalle) => ({ value: true, rule, reason: `${rule}: ${detalle}` });
  const noPude = (motivo) => ({ value: true, rule: 'no-pude-saber', reason: `no pude saber: ${motivo}` });
  const storyPath = args && args.story;
  let content;
  try { content = fs.readFileSync(storyPath, 'utf8'); } catch (e) { return noPude(`no pude leer la story (${storyPath}: ${e.code || e.message})`); }
  const repo = repoDeLaStory(storyPath, args.repo);
  let raices = repo ? [repo] : [];
  if (repo) {
    const faltan = [];
    try { raices = [repo, ...companionLib.companionRoots(repo, storyPath, { onMissing: (m) => faltan.push(m) })]; } catch (e) { return noPude(`no pude leer los repos compañeros (${e.message})`); }
    // un compañero declarado que no está en disco: sus controles no se pueden mirar
    if (faltan.length) return noPude(`el repo declara ${faltan.join(', ')} y no está en disco`);
  }
  // sin parte ni --files, un plan con su «## Archivos» se mide por lo que el plan cambia, no por lo que la historia
  // declara: un cierre en papel de una historia cuyo código ya entró no es delicado. Lo que la corrida cambie de verdad
  // lo vuelve a medir el freno del cierre (lib/batch-scope.js frenoDelCierre) sobre el diff entero
  const delPlan = args.planText ? rutasQueCuentanDelPlan(args.planText, { repo, raices }) : [];
  const conLista = !!(args.planText && (require(path.join(estadoPipeline.SCRIPTS_DIR, '..', '..', '..', 'scripts', 'lib', 'signature-sources.js')).seccion(args.planText, 'Archivos') || []).some((l) => rutasDelPlan(l).length));
  const deLaHistoria = conLista ? [] : [...parseFrontmatterList(content, 'files_to_create'), ...parseFrontmatterList(content, 'files_to_modify')];
  // con una parte válida (argumento explícito), su lista MÁS lo que el cambio toca; sin ella, como siempre
  const parte = parteDelArg(args);
  const comparables = (lista) => [...new Map(lista.map((f) => rutaComparable(f, raices)).filter((x) => x.rel).map((x) => [x.rel, x])).values()];
  const files = comparables([
    ...(parte ? [...parte.files, ...(args.files || [])] : args.files && args.files.length ? args.files : deLaHistoria),
    ...delPlan,
  ]);
  const fmTexto = ((content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
  // la decisión escrita en la historia gana sobre las reglas por archivo: lo que la máquina no lee (plata, clientes…)
  const porDecision = riskPaths.leerRiesgoAltoPor(fmTexto);
  if (porDecision && porDecision.valores.length) return si('riesgo-alto-por', `la historia declara riesgo_alto_por: ${porDecision.valores.join(', ')}`);
  // `sensible:` con cualquier valor no vacío: en el renglón, o como lista de YAML en los renglones de abajo. Va entre el
  // portón y lo sensible del arnés, donde estuvo siempre.
  const sensibleDeclarado = () => {
    const decl = fmTexto.match(/^sensible[ \t]*:[ \t]*(.*)$/m);
    if (!decl) return null;
    const valor = decl[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '').trim();
    const lista = fmTexto.slice(decl.index + decl[0].length).match(/^\r?\n[ \t]+-[ \t]*(\S.*)$/m);
    if ((valor && valor !== '[]') || (!valor && lista)) return si('sensible', `la story declara sensible: ${valor || lista[1]}`);
    return null;
  };
  // el de arriba marca todas las partes y una parte no lo deshace; sin él, el de la parte marca sólo esa
  const sensibleDeLaParte = () => {
    const arriba = sensibleDeclarado();
    if (arriba || !parte) return arriba;
    const v = require('./batch-scope.js').sensibleDeclarado(parte.sensible);
    return v ? si('sensible', `la parte ${parte.nombre} declara sensible: ${v}`) : null;
  };
  const r = riskPaths.riesgoDeArchivos(files, { repo, raices, superficie: tocaSuperficieCompartida, antesDeLosControles: sensibleDeLaParte });
  if (r.value) return { value: true, rule: r.rule, reason: r.reason };
  // un archivo de dependencias puede traer una dependencia nueva: ante la duda, riesgo alto. Es de la historia entera:
  // con una parte, también cuentan los de las otras
  const dep = (parte ? comparables([...deLaHistoria, ...files.map((f) => f.rel)]) : files).find((f) => riskPaths.esManifiesto(f.rel));
  if (dep) return si('dependencias', `${dep.rel} (archivo de dependencias)`);
  return { value: false, rule: null, reason: 'ninguna' };
}

// ── Superficie compartida declarada por repo ─────────────────────
// El gate por risk-class mide TAMAÑO de diff (≤6 archivos → LOW → se saltea el pase adversarial).
// Hay defectos que no son función del tamaño sino de QUIÉN
// ejecuta el código roto: pueden terminar el proceso del host, o sea que se
// llevan puestos a todos los plugins cargados. Dos archivos en Services/Plugins/ no tienen el
// mismo radio de daño que dos archivos en una pantalla.
//
// Se declara POR REPO y no se adivina con una heurística global de nombres: el dueño del repo sabe
// cuál es su superficie compartida, y una regla que adivina acierta en unos repos y molesta en
// otros — un control que molesta se termina apagando. Costo de un falso positivo: un pase
// adversarial de más (~25 min, en background). Costo de un falso negativo: un hotfix.
//
//   .tycon/advisors.yaml
//   deep_review_always_paths:
//     - custom-forms/.../Services/Plugins/**
//
// La llave está dada de alta en lib/config-lint.js (si no, el lint la reportaría como desconocida
// en todos los repos que la usen — un control que grita en falso se apaga).
function deepReviewAlwaysPaths(repo) {
  const txt = readText(path.join(repo, '.tycon', 'advisors.yaml')) ||
              readText(path.join(repo, '.tycon', 'advisors.yml'));
  if (!txt) return [];
  // 🔴 La lista se lee en sus tres formas, no sólo una. Leer UNA sola forma
  // de escribir la lista (bloque con guiones) descartaría en silencio las otras dos que YAML
  // acepta — y que el propio lib/config-lint.js ya soporta en su helper `lista()`:
  //     deep_review_always_paths: [Services/Plugins/**]      ← flow,    se leería VACÍA
  //     deep_review_always_paths: Services/Plugins/**        ← escalar, se leería VACÍA
  // Y un comentario al final del item quedaría pegado al glob (`- Services/Plugins/**  # el cargador`),
  // así que el patrón no matchearía nunca. Los tres casos terminan igual: el repo declaró su
  // superficie, el pase adversarial se saltea lo mismo, y el veredicto AFIRMA que no había nada
  // declarado. Una falla silenciosa en el control que existe para que no haya fallas silenciosas.
  const limpiar = (v) => String(v).replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '').trim();
  const out = [];
  let dentro = false;
  for (const linea of txt.split(/\r?\n/)) {
    if (/^\s*#/.test(linea) || linea.trim() === '') continue;
    const cab = linea.match(/^deep_review_always_paths\s*:\s*(.*)$/);
    if (cab) {
      const valor = limpiar(cab[1]);
      const flow = valor.match(/^\[(.*)\]$/);
      if (flow) {                        // forma [a, b]
        for (const it of flow[1].split(',')) { const v = limpiar(it); if (v) out.push(v); }
        dentro = false;
      } else if (valor) {                // forma escalar en el mismo renglón
        out.push(valor);
        dentro = false;
      } else {                           // bloque: los items vienen abajo
        dentro = true;
      }
      continue;
    }
    if (dentro) {
      const item = linea.match(/^\s+-\s*(.+)$/);
      if (item) { const v = limpiar(item[1]); if (v) out.push(v); continue; }
      if (/^\S/.test(linea)) dentro = false;   // arrancó otra llave de primer nivel
    }
  }
  return out;
}

/** ¿Alguno de los archivos del diff cae en la superficie compartida declarada? */
function tocaSuperficieCompartida(repo, files) {
  const patrones = deepReviewAlwaysPaths(repo);
  if (!Array.isArray(files) || !files.length) return null;
  // 🔴 Stories de dos repos: un archivo de un repo hermano se juzga contra la superficie compartida que
  //    declara SU repo (su `.tycon/advisors.yaml`). Sin esto se saltearía («fuera del repo»): un cambio en la superficie
  //    compartida del frontend hermano nunca pediría el pase adversarial.
  for (const f of files) {
    const o = companionLib.ownerOf(f, repo);
    if (o.propio || !o.root) continue;
    for (const pat of deepReviewAlwaysPaths(o.root)) {
      if (matchGlob(o.rel, pat)) return { file: `${path.basename(o.root)}/${o.rel}`, pattern: pat, repo: o.root };
    }
  }
  if (!patrones.length) return null;
  // Normalizar antes de comparar: un absoluto con otro prefijo,
  // un `./` adelante o un `..` en el medio no matchearían NINGÚN patrón — falso negativo mudo, que
  // es justo el modo de falla que este control existe para cerrar.
  const raiz = path.resolve(repo);
  for (const f of files) {
    const abs = path.isAbsolute(f) ? path.resolve(f) : path.resolve(raiz, f);
    const rel = path.relative(raiz, abs).replace(/\\/g, '/');
    if (rel.startsWith('../')) continue;        // fuera del repo: no es superficie de ESTE repo
    for (const pat of patrones) {
      if (matchGlob(rel, pat)) return { file: rel, pattern: pat };
    }
  }
  return null;
}

module.exports = { frenosDelManifiesto, parseFrontmatterList, computeRiskClass, computeDelicate, tocaSuperficieCompartida, computeRunSize, runSizeDelMarcador, repoDeLaStory, runSizeLib, deepReviewAlwaysPaths };
