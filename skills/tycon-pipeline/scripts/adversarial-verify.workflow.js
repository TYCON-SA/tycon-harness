// adversarial-verify.workflow.js — el paso «Pase adversarial» del tycon-pipeline.
//
// Pase adversarial reproduce-or-refute que corre DESPUÉS de los 6 advisors single-pass del paso de revisores.
// La diferencia clave: los advisors LEEN el diff; este workflow EJECUTA el código (bundlea, parsea,
// corre probes contra datos/corpus reales) para CONFIRMAR o REFUTAR cada finding. Atrapa lo que la
// lectura no ve, por ejemplo un falso negativo de recorrido (un tipo de nodo que no se escanea).
//
// Invocación (desde el paso «Pase adversarial», vía la tool Workflow):
//   Workflow({ scriptPath: '<este archivo>', args: {
//     repo:      '<abs repo path>',
//     files:     ['path/a.ts', 'path/b.ts', ...],   // archivos del diff (código, no docs)
//     storyPath: '<abs story .md>',                 // opcional (contexto)
//     decisions: '<texto de decisiones de diseño APROBADAS que NO se re-flagean>',
//     model:     'sonnet' | 'opus' | 'fable',       // default sonnet (lo decide deep-review-gate; fable SOLO con autorización explícita del user)
//     runDir:    '<abs repo>/.advisors/pipeline-runs/<story>-<ts>',  // dónde se guardan las pruebas confirmadas
//   }})
//
// Devuelve { confirmed: [...], all_lenses: [{lens, count}], probes_dir }. Los CONFIRMED se foldean al
// reporte consolidado del paso de hallazgos con tag `adversarial-verify` y disparan el re-loop D.i si se aplican
// fixes. Cada CONFIRMED trae `probe_dir`: la carpeta donde quedó la prueba que lo reprodujo.
//
// 🔴 LAS PRUEBAS QUE CONFIRMAN SE GUARDAN. El verificador borra su prueba al terminar —bien: no
// puede quedar en el repo—, y sin copia del hallazgo queda el relato y nunca el código: una prueba de
// integración que devuelve 200 donde la story pide 403, lista para volverse la de regresión, se
// perdería. Por eso, ANTES de borrarla, el
// verificador copia sus archivos y el comando a `<runDir>/step-05b-probes/<lente>-<n>/`, con `.txt`
// agregado al nombre (así ningún compilador ni corredor de pruebas los levanta) y las credenciales
// tapadas. La carpeta de la corrida está en el `.gitignore` canónico: no viaja por git.

export const meta = {
  name: 'adversarial-verify',
  description: 'Pase adversarial reproduce-or-refute sobre el diff (6 lentes de correctitud, cada finding reproducido por un skeptic) — paso «Pase adversarial» del tycon-pipeline',
  phases: [
    { title: 'Hunt', detail: 'una lente por dimensión de correctitud; cada hunter lee el código real + corre probes' },
    { title: 'Verify', detail: 'un skeptic independiente debe REPRODUCIR cada finding con un probe (default REFUTED)' },
  ],
}

// Normalización defensiva: la tool Workflow a veces entrega `args` como STRING JSON en vez de objeto
// Parse-guard para no degradar a FILES=[] (no-op silencioso).
const A = (typeof args === 'string')
  ? ((() => { try { return JSON.parse(args) } catch { return {} } })())
  : (args || {})

const REPO = (A && A.repo) || '.'
const FILES = (A && Array.isArray(A.files)) ? A.files : []
const STORY = (A && A.storyPath) || '(no provista)'
const DECISIONS = (A && A.decisions) || '(ninguna declarada — usá el criterio: no re-flaggees lo que el diff documenta como decisión intencional)'
const MODEL = (A && A.model) || 'sonnet'
// Sin runDir (lanzado a mano, fuera de una corrida) igual se guarda: en una carpeta fija dentro de
// `pipeline-runs/`, que el .gitignore canónico también cubre. Nada con fecha acá: el prompt tiene que
// ser el mismo entre reanudaciones del Workflow o se pierde su caché.
const RUN_DIR = String((A && A.runDir) || `${REPO}/.advisors/pipeline-runs/adversarial-sin-corrida`).replace(/\/+$/, '')
const PROBES_DIR = `${RUN_DIR}/step-05b-probes`

// Agrupar los hallazgos por causa antes de verificarlos. Se apaga con la variable
// TYCON_5B_GROUP=0 —como los demás recortes del arnés— o con `agrupar: false` en los args (que es
// como se lo pasa el step cuando la variable está puesta y el guion corre en una caja sin env). Acá se lee
// directo porque la caja no tiene `require`: el nombre viejo de la variable lo resuelve el step con
// `legacy_env` al armar los args.
// Apagado = un verificador por hallazgo.
const AGRUPAR = (A && A.agrupar === false)
  ? false
  : !(typeof process !== 'undefined' && process && process.env && process.env.TYCON_5B_GROUP === '0')

// 🔴 Copia LITERAL de `SALIDA_APROBADA` de lib/adversarial-verdict.js (la caja no tiene `require`). La prueba T9 de
// tests/adversarial-unmeasured.test.js compara las dos: si una cambia, se cambia la otra.
const SALIDA_APROBADA = 'la salida aprobada: un pase propio con agentes de Claude — cazadores con Sonnet, un verificador aparte por hallazgo que corre el código, juicio con Opus, nunca Fable (workflow-lite.js --agents-dir, step-08-adversarial-pass.md §«Sin Codex ni Workflow»)'

// El aviso de un pase que no revisó todo. Nunca «limpio»: no medido, con qué faltó y cómo seguir.
function avisoNoMedido(sinMedir, sinVeredicto) {
  const partes = []
  if (sinMedir.length) partes.push(`${sinMedir.length} lente(s) SIN MEDIR (${sinMedir.join(', ')}): su cazador no contestó`)
  if (sinVeredicto) partes.push(`${sinVeredicto} hallazgo(s) SIN VEREDICTO: su verificador no contestó (el texto está en detalle)`)
  return `adversarial-verify: 🔴 pase NO MEDIDO — ${partes.join('; ')}. No es verde ni «sin hallazgos»: relanzá el pase, o ${SALIDA_APROBADA}.`
}

const COMMON = `
Repo: ${REPO}
Story: ${STORY}
Archivos del diff a auditar (LEÉ EL CÓDIGO REAL EN DISCO, no asumas):
${FILES.map((f) => '- ' + f).join('\n')}

Sos un verificador ADVERSARIAL de correctitud. A diferencia de un linter que lee el diff, vos EJECUTÁS
el código: bundleá/compilá/parseá y corré PROBES reales (usá la misma forma en que los tests del proyecto
ejercen el código — mirá los test files del diff/repo para el patrón de bundle/import/parse). Observá el
comportamiento REAL, no el que "debería" tener. Si el proyecto tiene un corpus/fixtures reales, probá contra
ellos (los bugs de verdad viven en los datos reales, no en el happy-path sintético).

🔴 DISCIPLINA DE RECURSOS (no-negociable, 2026-07-30): NUNCA corras la suite completa del repo como
probe (nada de \`npm test\` / \`vitest run\` / \`dotnet test\` sin filtro). Sos uno de VARIOS verificadores
concurrentes en la máquina del dev (8 cores/16GB) — una suite completa en paralelo con el resto la
congela (incidente medido 2 veces). Legal: correr UN test file puntual con filtro
(\`npm test -- <patrón>\` / \`dotnet test --filter "FullyQualifiedName~<Clase>"\`) o un script standalone
tuyo que importe solo lo que auditás. Si tu probe necesita un build, buildeá el proyecto puntual, no la
solución entera.

🔴 DÓNDE CORRE TU GUION (no-negociable, 2026-10-02 — un guion sin laboratorio creó una rama y dos commits en la
copia de trabajo del equipo):
1. Corré cada guion PARADO en una carpeta temporal tuya, fuera de cualquier repo. Armá ahí tu laboratorio con
   \`mktemp -d /tmp/probe.XXXXXX\` (base fija /tmp: la carpeta temporal de la sesión puede llevar el nombre del repo
   en la ruta, y hay armadores de laboratorio que se niegan ahí y te dejan las variables vacías).
2. Todo guion de shell empieza con \`set -euo pipefail\` y corta si el laboratorio no se armó: mirá el resultado del
   armador antes de usar lo que dejó.
3. Nunca llames a git sin una carpeta: \`git -C ""\` NO cambia de carpeta, opera sobre el repo donde estás parado. Antes
   de un \`git -C "<variable>"\`, comprobá que la variable tenga valor y que la carpeta exista.
4. El repo bajo revisión es de SÓLO LECTURA para git: ni commit, ni checkout, ni add, ni stash, ni reset ahí. Si
   necesitás un repo con historia, cloná o copiá lo que te haga falta a tu laboratorio.

HERRAMIENTAS DE CÓDIGO (usá la mejor disponible, en este orden): (1) si el harness expone tools
mcp__codegraph*__* o mcp__codebase_memory__* (buscalas con ToolSearch), usalas para lookup de símbolos,
callers, callees e impact — son sub-ms y más precisas que grep; (2) si no están pero el binario existe,
CLI vía Bash: \`codegraph query "<símbolo>" | codegraph context "<task>"\` o
\`codebase-memory-mcp cli search_graph '<json>'\`; (3) último recurso: grep. NO gastes turnos re-derivando
un call-graph a mano si (1) o (2) están disponibles.

DECISIONES DE DISEÑO YA APROBADAS — NO las reportes como bugs (son intencionales y documentadas):
${DECISIONS}

REPORTÁ SOLO BUGS REALES de correctitud: falso negativo (algo que debería detectarse/manejarse y NO se
detecta), falso positivo (se dispara sobre input legítimo), no-determinismo, crash/excepción no intencional,
o un edge case de correctitud roto. Robustez con impacto real es válida. NO reportes: nits de estilo, las
decisiones aprobadas de arriba, micro-branches inalcanzables ya cubiertas por statement-coverage, ni
"podría mejorarse". Cada finding: {severity: 'bug'|'robustness'|'nit', file, line, summary, repro (inputs
concretos → comportamiento incorrecto observado), confidence}. Si tu lente está limpio, findings: [].`

const LENSES = [
  {
    key: 'traversal-completeness',
    prompt: `LENTE: completitud del recorrido / cobertura de casos. Si el código RECORRE una estructura (árbol, grafo,
lista anidada, colección de entidades) o CLASIFICA/mapea inputs: ¿alcanza TODOS los casos donde el dato relevante
puede vivir? Buscá ramas/contenedores/variantes que la iteración se salta → falso negativo silencioso. Probá con
un input que ejercite un caso "raro pero real" (anidamiento, variante de esquema, colección secundaria). Si un
elemento/caso que debería procesarse NO se procesa = bug real, confirmalo con probe.`,
  },
  {
    key: 'determinism-ordering',
    prompt: `LENTE: determinismo y orden. ¿La salida es byte-idéntica entre corridas del mismo input? Buscá: orden de
iteración dependiente de Map/Set/Object.keys sin sort, ties resueltos de forma no-estable, timestamps/random/entorno
filtrándose a la salida. Corré la operación DOS veces sobre el mismo input y compará. Si difieren = bug.`,
  },
  {
    key: 'false-negative-classification',
    prompt: `LENTE: falsos negativos en detección/validación/clasificación. Si el código EMITE findings/decisiones sobre un
input: ¿hay un input que DEBERÍA disparar el finding pero NO lo hace? Atacá los límites del predicado (umbral exacto,
near-match, colisión de nombres, precedencia entre fuentes de datos). Construí el input que debería fallar y verificá
que el código efectivamente lo detecta. Si se lo pierde = bug.`,
  },
  {
    key: 'false-positive-edge',
    prompt: `LENTE: falsos positivos y edge cases. ¿Hay un input LEGÍTIMO que dispara un finding/error que no debería?
Probá: valor ausente vs vacío explícito, casing/prefijo/namespace, campos opcionales, colección vacía, cero/negativos,
unicode. También el revés: ¿un input degenerado (vacío, un solo elemento, gigante) rompe o da resultado incorrecto?
Confirmá con probe el input concreto.`,
  },
  {
    key: 'algorithmic-correctness',
    prompt: `LENTE: correctitud algorítmica de las funciones puras/de cómputo del diff (parsers, distancias, transformaciones,
DP, comparadores, serializadores). Auditá la lógica línea por línea Y validá contra una implementación de referencia:
corré la función y una versión de referencia (más simple/lenta) sobre ~100-200 inputs aleatorios + edge, y compará
igualdad. Cualquier discrepancia = bug. Chequeá off-by-one, swaps de índices/filas, early-returns, condiciones límite.`,
  },
  {
    key: 'integration-contracts',
    prompt: `LENTE: integración y contratos entre módulos. ¿La firma/opciones nuevas se cablean bien con los callers
existentes (no rompen su contrato)? ¿El caller propaga errores correctamente (no los traga)? ¿La feature nueva
corre sobre el MISMO estado/objeto que el resto del pipeline (no re-parsea/duplica)? ¿Un flag/opción nueva excluye
correctamente lo que debe? Probá el flujo integrado (no solo la unidad) con true/false del flag y con el error path.`,
  },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['bug', 'robustness', 'nit'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          summary: { type: 'string' },
          repro: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['severity', 'file', 'summary', 'repro', 'confidence'],
      },
    },
  },
  required: ['lens', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED'] },
    reasoning: { type: 'string' },
    adjusted_severity: { type: 'string', enum: ['bug', 'robustness', 'nit', 'not-a-bug'] },
    // La carpeta donde quedó guardada la prueba que lo reprodujo; '' si REFUTED o si no se pudo
    // guardar (y entonces `reasoning` dice por qué). Requerido: bajo Codex el esquema estricto exige
    // todas las propiedades, y así las dos herramientas devuelven lo mismo.
    probe_dir: { type: 'string' },
    // 🔴 El escape hatch tiene lugar en la respuesta. El prompt pide avisar si algún miembro de la
    // clase NO era el mismo defecto: sin este campo, ese aviso caería en un texto que nadie lee, y un
    // bug real quedaría marcado como verificado sin que nadie lo hubiera reproducido.
    todos_el_mismo_defecto: { type: 'boolean' },
  },
  required: ['verdict', 'reasoning', 'adjusted_severity', 'probe_dir', 'todos_el_mismo_defecto'],
}

// Qué hacer con la prueba cuando el verificador CONFIRMA. Función aparte para que el test la lea.
function guardarPrueba(dir) {
  return `

SI CONFIRMÁS, GUARDÁ LA PRUEBA ANTES DE BORRARLA (obligatorio — es lo único que queda del hallazgo):
1. Creá la carpeta ${dir}
2. Copiá ahí CADA archivo que escribiste o modificaste para reproducirlo (la prueba, el script, los
   datos de entrada), con el nombre original MÁS ".txt" al final (ZZProbeRutas.cs → ZZProbeRutas.cs.txt,
   probe.test.ts → probe.test.ts.txt). El ".txt" es a propósito: que ningún compilador ni corredor de
   pruebas del repo lo levante. Si modificaste un archivo existente del repo, guardá sólo tu parte o el
   diff (git diff > cambio.diff.txt), no el archivo entero.
3. Escribí ${dir}/COMO-SE-CORRIO.txt con: el comando EXACTO que corriste, desde qué carpeta, y la parte de
   la salida que muestra el comportamiento incorrecto (lo esperado contra lo observado; unas líneas, no el log entero).
4. Tapá credenciales en lo que guardás: cadenas de conexión, contraseñas, tokens, claves → <REDACTED>.
5. Recién después borrá la prueba del repo (y verificá que no quedó nada en git status), como siempre.
6. Devolvé probe_dir = ${dir}. Si REFUTED, no guardes nada y devolvé probe_dir = "". Si no pudiste
   guardar, devolvé probe_dir = "" y decí por qué en reasoning — no inventes una ruta.`
}

// El pedido al verificador de UN hallazgo que el autor propone descartar como falso. Es el mismo criterio del pase
// (reproducir o refutar; ante la duda, reproducido) con la salida pedida como constancia: el comando que corrió y lo
// que vio. Lo usa el modo `single-finding` de abajo y `pipeline.js verify-finding` (que corre este guion sólo para
// armar el texto, `soloPedido`).
function pedidoUnHallazgo(h) {
  const f = h || {}
  return `${COMMON}\n\nQuien implementó propone descartar este hallazgo de un revisor como FALSO. Tu trabajo es decidir con una` +
    ` prueba REAL si se da o no: intentá REPRODUCIRLO (bundleá/compilá/corré el código tal como está en disco). Sólo si corriste` +
    ` algo y observaste que el comportamiento incorrecto NO se da, devolvé refuted = true, con el comando EXACTO que corriste` +
    ` y la parte de la salida que lo muestra. Si lo reprodujiste, si no pudiste correr nada, o si no podés demostrar que no` +
    ` se da → refuted = false (ante la duda, el hallazgo es real). No te fíes del motivo del autor: es lo que tenés que comprobar.` +
    `\n\nHALLAZGO (revisor ${f.reviewer || '?'}, regla ${f.rule || '?'}):\nfile=${f.file || '?'}${f.line ? ':' + f.line : ''}\n` +
    `summary=${f.summary || '(sin resumen)'}\n\nMOTIVO DEL AUTOR PARA DESCARTARLO:\n${f.author_reason || '(sin motivo)'}`
}

const REFUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    refuted: { type: 'boolean' },
    command: { type: 'string' },
    output: { type: 'string' },
    reasoning: { type: 'string' },
  },
  required: ['refuted', 'command', 'output', 'reasoning'],
}

// Modo «un hallazgo»: sin cazadores ni lentes, un solo verificador independiente. Con `soloPedido` no lanza nada y
// devuelve el texto y el modelo, que es lo que imprime `pipeline.js verify-finding`.
if (A && A.modo === 'single-finding') {
  const pedido = pedidoUnHallazgo(A.hallazgo)
  if (A.soloPedido === true) return { prompt: pedido, model: MODEL }
  const v = await agent(pedido, { label: 'verify:single-finding', phase: 'Verify', schema: REFUTE_SCHEMA, agentType: 'general-purpose', model: MODEL })
  return { refuted: !!(v && v.refuted === true), command: (v && v.command) || '', output: (v && v.output) || '', reasoning: (v && v.reasoning) || '' }
}

// ===== NUCLEO-AGRUPAR: INICIO =====
// 🔴 Este bloque está COPIADO LITERAL dentro de adversarial-verify.workflow.js: el pase corre en
// una caja sin `require`, así que no puede importarlo. `tests/test-group-findings.js` compara las
// dos copias carácter por carácter y se pone rojo si se separan: es el defecto de una lista
// duplicada y desincronizada.
// Para re-sincronizar: node lib/group-findings.js --emit-core > /tmp/n.js y pegarlo.
// Categorías de síntoma. Cerradas a propósito: una lista abierta se vuelve parecido de texto con
// otro nombre. Cada una se reconoce por marcas de CÓDIGO (identificadores, operadores, literales),
// no por adjetivos. Un hallazgo puede caer en varias; se comparan como conjuntos.
const SINTOMAS = [
  ['exports', /module\.exports|require\.main|process\.exit|inalcanzable/i],
  ['exencion', /lectura-entera-ok|marcaExencion|exenci[oó]n/i],
  ['heredoc', /heredoc|<<-?\s*['"]?[A-Z]/],
  ['redireccion', /2>&1|2>\/dev\/null|stderr|redirecci[oó]n de salida|>>?\\?s/i],
  ['offset', /offset/i],
  ['conteo', /acotad[ao]s?\b|CONFIG\.acotadores|contador|--report/i],
  ['comentario', /comentario/i],
  ['nombre-archivo', /archivoDe|nombre del archivo|paths? entre comillas/i],
];

// Palabras que parecen identificadores pero no distinguen nada.
const GENERICOS = new Set([
  'null', 'true', 'false', 'undefined', 'string', 'number', 'object', 'array', 'function', 'return',
  'console', 'error', 'value', 'result', 'archivo', 'comando', 'linea', 'texto', 'prueba',
]);

function texto(h) {
  return `${(h && h.summary) || ''}\n${(h && h.repro) || ''}`;
}

/** Las categorías de síntoma que se reconocen en un hallazgo. Conjunto, posiblemente vacío. */
function sintomasDe(h) {
  const t = texto(h);
  const out = new Set();
  for (const [nombre, re] of SINTOMAS) if (re.test(t)) out.add(nombre);
  return out;
}

/**
 * Identificadores de código nombrados en el texto: `entre backticks`, `foo(`, `CONFIG.algo` y
 * camelCase. NO son palabras del idioma: son los nombres que el código usa de verdad.
 */
function simbolosDe(h) {
  const t = texto(h);
  const out = new Set();
  const agregar = (s) => {
    const v = String(s || '').replace(/[^A-Za-z0-9_.]/g, '');
    if (v.length >= 4 && !GENERICOS.has(v.toLowerCase()) && /[A-Za-z]/.test(v)) out.add(v);
  };
  for (const m of t.matchAll(/`([^`]{2,60})`/g)) agregar(m[1]);
  for (const m of t.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) agregar(m[1]);
  for (const m of t.matchAll(/\b([A-Z][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\b/g)) agregar(m[1]);
  for (const m of t.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]*)\b/g)) agregar(m[1]);
  return out;
}

function interseca(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function sitio(h) {
  const f = String((h && h.file) || '').trim();
  const l = h && h.line !== null && h.line !== undefined && h.line !== '' ? String(h.line) : null;
  return { file: f, line: l };
}

/**
 * ¿Estos dos hallazgos son el mismo problema? Devuelve {ok, motivo}. `motivo` explica tanto el sí
 * como el no: es lo que después se lee en el informe y en la lista de dudas.
 */
function compatibles(a, b, ctx) {
  const sa = sitio(a);
  const sb = sitio(b);
  if (!sa.file || !sb.file || sa.file !== sb.file) return { ok: false, motivo: 'archivos distintos' };

  const symA = ctx.simbolos.get(a);
  const symB = ctx.simbolos.get(b);
  const sinA = ctx.sintomas.get(a);
  const sinB = ctx.sintomas.get(b);

  // Veto por síntoma: los dos reconocidos y sin nada en común → son cosas distintas.
  if (sinA.size && sinB.size && !interseca(sinA, sinB)) {
    return { ok: false, motivo: `mismo archivo, pero síntomas distintos (${[...sinA].join('/')} vs ${[...sinB].join('/')})`, cerca: true };
  }

  // Señales POSITIVAS de que son el mismo defecto. Ninguna de las dos es suficiente sola en todos
  // los casos; cuáles hacen falta lo decide la rama de abajo.
  const sintomasEnComun = [...sinA].filter((x) => sinB.has(x));
  const simbolosEnComun = [...symA].filter((x) => symB.has(x) && !ctx.genericos.has(x));

  if (sa.line && sb.line) {
    if (sa.line !== sb.line) {
      return { ok: false, motivo: `mismo archivo pero líneas declaradas distintas (${sa.line} vs ${sb.line})`, cerca: true };
    }
    // 🔴 El sitio SOLO no alcanza (un bug de índice y una
    // condición de carrera en la misma línea): hace falta algo más que compartan.
    if (sintomasEnComun.length) {
      return { ok: true, motivo: `mismo sitio (${sa.file}:${sa.line}) y mismo síntoma (${sintomasEnComun.join('/')})` };
    }
    if (simbolosEnComun.length) {
      return { ok: true, motivo: `mismo sitio (${sa.file}:${sa.line}) y nombran el mismo código (${simbolosEnComun.slice(0, 3).join(', ')})` };
    }
    return { ok: false, motivo: `mismo sitio (${sa.file}:${sa.line}) pero nada más en común: ante la duda, separados`, cerca: true };
  }

  if (!sa.line && !sb.line) {
    // Sin sitio, una sola señal es demasiado poco: el nombre de la función que los contiene lo
    // comparten TODOS los defectos de esa función, que es justo el caso que el pase reprodujo.
    if (simbolosEnComun.length && sintomasEnComun.length) {
      return { ok: true, motivo: `ninguno declara línea, pero nombran el mismo código (${simbolosEnComun.slice(0, 3).join(', ')}) y comparten síntoma (${sintomasEnComun.join('/')})` };
    }
    const falta = !simbolosEnComun.length ? 'no nombran el mismo código' : 'no comparten síntoma reconocido';
    return { ok: false, motivo: `ninguno declara línea y ${falta}`, cerca: true };
  }

  // Uno declara línea y el otro no: no hay con qué compararlos. Ante la duda, separados.
  return { ok: false, motivo: 'uno declara línea y el otro no: no hay con qué compararlos', cerca: true };
}

/**
 * Agrupa. Devuelve { clases, dudas, resumen }.
 *   clases: [{ id, miembros:[índices], representante:índice, motivo, file, line }]
 *   dudas:  [{ a, b, motivo }] — los pares que ESTUVIERON CERCA y no se juntaron.
 *   resumen: { hallazgos, clases, agentes_ahorrados }
 */
function agrupar(hallazgos, opts) {
  const hs = Array.isArray(hallazgos) ? hallazgos : [];
  const o = opts || {};
  const simbolos = new Map();
  const sintomas = new Map();
  const cuenta = new Map();
  for (const h of hs) {
    const s = simbolosDe(h);
    simbolos.set(h, s);
    sintomas.set(h, sintomasDe(h));
    for (const x of s) cuenta.set(x, (cuenta.get(x) || 0) + 1);
  }
  // Un símbolo que aparece en buena parte de los hallazgos no distingue nada: es el nombre del
  // módulo que todos tocan. Un corte en la MITAD sería demasiado permisivo con pases chicos (con 2
  // hallazgos, un símbolo compartido por los dos nunca llegaría a «genérico»); el corte es un tercio.
  const tope = Math.max(1, Math.ceil(hs.length / 3));
  const genericos = new Set([...cuenta.entries()].filter(([, n]) => n > tope).map(([k]) => k));
  const ctx = { simbolos, sintomas, genericos };

  const clases = [];
  const dudas = [];
  for (let i = 0; i < hs.length; i++) {
    let destino = null;
    for (const c of clases) {
      // CLIQUE: compatible con TODOS los miembros, no con uno.
      let todos = true;
      let motivo = '';
      for (const j of c.miembros) {
        const r = compatibles(hs[i], hs[j], ctx);
        if (!r.ok) { todos = false; if (r.cerca) dudas.push({ a: j, b: i, motivo: r.motivo }); break; }
        motivo = r.motivo;
      }
      if (todos) { destino = c; c.motivo = motivo || c.motivo; break; }
    }
    if (destino) destino.miembros.push(i);
    else {
      const s = sitio(hs[i]);
      clases.push({ id: clases.length + 1, miembros: [i], representante: i, motivo: 'no se juntó con ninguna otra: queda sola', file: s.file, line: s.line });
    }
  }
  // El representante es el primero de la clase: es el que se verifica, y el que todos citan.
  for (const c of clases) c.representante = c.miembros[0];

  return {
    clases,
    dudas,
    resumen: { hallazgos: hs.length, clases: clases.length, agentes_ahorrados: Math.max(0, hs.length - clases.length) },
    __opts: o,
  };
}
// ===== NUCLEO-AGRUPAR: FIN =====

if (FILES.length === 0) {
  log('adversarial-verify: sin archivos de código en args.files → nada que auditar (pase NO MEDIDO).')
  return { confirmed: [], all_lenses: [], lentes: [], lentes_sin_medir: [], detalle: [], medido: false,
    aviso: 'adversarial-verify: 🔴 pase NO MEDIDO — sin archivos de código en args.files, no se revisó nada.' }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fase 1 — los 6 cazadores, en paralelo.
//
// 🔴 ACÁ HAY UNA BARRERA: los cazadores terminan antes de verificar. Con `pipeline(LENSES, cazar,
// verificar)` cada lente empezaría a verificar apenas terminara de cazar, y la agrupación NO PUEDE
// cruzar lentes si cada lente ya verificó lo suyo — y el grueso de los duplicados medidos son el
// mismo defecto visto por lentes distintas. Lo que se paga: la cola del cazador más lento. Lo que se
// gana: ~40 % de los verificadores.
const hunts = await parallel(
  LENSES.map((lens) => () =>
    agent(`${COMMON}\n\n${lens.prompt}`, {
      label: `hunt:${lens.key}`,
      phase: 'Hunt',
      schema: FINDINGS_SCHEMA,
      agentType: 'general-purpose',
      model: MODEL,
    }).then((h) => ({ lens: lens.key, hunt: h }))
  )
)

// 🔴 UN CAZADOR MUERTO NO ES UNA LENTE LIMPIA. `agent()` devuelve null cuando el agente
// muere o no contesta lo pedido —en la herramienta Workflow y en workflow-lite.js por igual—, y eso
// se leería como «cero hallazgos»: un pase con todos los cazadores muertos saldría «6 lentes limpias» sin haber revisado nada. Una lente vale
// `medida` sólo con una respuesta que trae su lista de hallazgos (vacía o no); si no, `sin-medir`.
const lentes = LENSES.map((lens, i) => {
  const r = hunts[i]
  const ok = !!(r && r.hunt && Array.isArray(r.hunt.findings))
  return { lens: lens.key, estado: ok ? 'medida' : 'sin-medir', count: ok ? r.hunt.findings.length : 0 }
})
const lentesSinMedir = lentes.filter((l) => l.estado === 'sin-medir').map((l) => l.lens)

// Los hallazgos de todas las lentes, en una sola lista. `idxEnLente` conserva la numeración por
// lente: es la que nombra la carpeta de la prueba (`<lente>-<n>`), contrato del paso «Pase adversarial».
const todos = []
for (const r of hunts.filter(Boolean)) {
  const fs = (r.hunt && Array.isArray(r.hunt.findings)) ? r.hunt.findings : []
  fs.forEach((f, i) => todos.push({ ...f, lens: r.lens, idxEnLente: i + 1 }))
}

// El texto de un hallazgo, tal cual lo reportó su cazador: lo que queda en `detalle`.
const textoDe = (f) => ({ lens: f.lens, idxEnLente: f.idxEnLente, severity: f.severity, file: f.file, line: f.line ?? null,
  summary: f.summary, repro: f.repro, confidence: f.confidence })

if (todos.length === 0) {
  if (lentesSinMedir.length) {
    const aviso = avisoNoMedido(lentesSinMedir, 0)
    log(aviso)
    return { confirmed: [], probes_dir: PROBES_DIR, all_lenses: [], lentes, lentes_sin_medir: lentesSinMedir, detalle: [], medido: false, aviso,
      hallazgos: 0, clases: 0, agentes_ahorrados: 0, sin_veredicto: 0, hallazgos_sin_veredicto: 0, a_verificar_aparte: 0 }
  }
  log(`adversarial-verify: ${LENSES.length} lentes medidas y limpias, nada que verificar.`)
  return { confirmed: [], probes_dir: PROBES_DIR, all_lenses: lentes.map((l) => ({ lens: l.lens, count: 0 })), lentes, lentes_sin_medir: [], detalle: [], medido: true,
    hallazgos: 0, clases: 0, agentes_ahorrados: 0, sin_veredicto: 0, hallazgos_sin_veredicto: 0, a_verificar_aparte: 0 }
}

// Fase 1b — agrupar por causa. Con el agrupamiento apagado, cada hallazgo es su propia clase y el
// pase corre un verificador por hallazgo.
const grupos = AGRUPAR
  ? agrupar(todos)
  : {
      clases: todos.map((_f, i) => ({ id: i + 1, miembros: [i], representante: i, motivo: 'agrupamiento apagado (TYCON_5B_GROUP=0)' })),
      dudas: [],
      resumen: { hallazgos: todos.length, clases: todos.length, agentes_ahorrados: 0 },
    }

log(`adversarial-verify: ${todos.length} hallazgos → ${grupos.clases.length} clases` +
  (AGRUPAR ? ` (se ahorran ${grupos.resumen.agentes_ahorrados} verificadores; ${grupos.dudas.length} pares quedaron separados por las dudas)` : ' (agrupamiento APAGADO)'))

// ===== NUCLEO-VENTANA: INICIO =====
// La ventana: como mucho `size` tareas vivas a la vez; apenas termina una, entra la siguiente. Cada carril está
// aislado: una tarea que tira deja `null` en su lugar y las demás se intentan igual; el motivo va a `onError(k, e)`
// (sin él, la causa se perdía). El resultado sale en el orden de las tareas, no en el de llegada.
async function runWindow(tareas, opts = {}) {
  const size = Math.max(1, Math.floor(opts.size || 3))
  const onError = typeof opts.onError === 'function' ? opts.onError : null
  const lista = Array.isArray(tareas) ? tareas : []
  const resultados = new Array(lista.length).fill(null)
  let siguiente = 0
  const carril = async () => {
    while (siguiente < lista.length) {
      const k = siguiente
      siguiente += 1
      try {
        resultados[k] = await lista[k]()
      } catch (e) {
        resultados[k] = null
        if (onError) { try { onError(k, e) } catch (_e) { /* el aviso nunca corta la ventana */ } }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, lista.length) }, () => carril()))
  return resultados
}
// ===== NUCLEO-VENTANA: FIN =====

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fase 2 — UN escéptico por CLASE, en una ventana de 3: el cap de concurrencia sigue valiendo
// —cada verificador abre Bash en la máquina del dev—, pero apenas termina uno entra el siguiente;
// con tandas fijas cada tanda espera a su más lento. La ventana se arma acá, sobre promesas
// sueltas de `agent()`, y NO con el `parallel` del corredor: con él el tope pasaría a ser el suyo.
const veredictos = await runWindow(
  grupos.clases.map((c) => () => {
    const rep = todos[c.representante]
    const otros = c.miembros.filter((m) => m !== c.representante).map((m) => todos[m])
    const mismaClase = otros.length
      ? `\n\nOTRAS ${otros.length} LENTE(S) REPORTARON LO QUE PARECE EL MISMO PROBLEMA (agrupados por: ${c.motivo}).` +
        ` Si al reproducirlo ves que alguno NO es el mismo defecto, devolvé todos_el_mismo_defecto = false y decí cuál en reasoning:` +
        ` ese hallazgo NO se da por verificado y se verifica aparte. Si los reprodujiste a todos como el mismo, devolvé true.\n` +
        otros.map((o) => `- [${o.lens}] ${o.summary}`).join('\n')
      : ''
    // Sin otros miembros, el campo igual se pide (el esquema lo exige): con una clase de uno, la
    // respuesta honesta es `true`.
    return agent(
      `${COMMON}\n\nUn hunter (lente ${rep.lens}) reportó este posible bug. Tu trabajo es REFUTARLO adversarialmente:` +
        ` intentá REPRODUCIRLO con un probe real (bundleá/compilá + ejecutá). Si NO podés reproducir el comportamiento` +
        ` incorrecto, o si es una de las decisiones de diseño aprobadas, o si el hunter erró la semántica → REFUTED.` +
        ` Solo CONFIRMED si reprodujiste el bug con inputs concretos observados. Ante la duda: REFUTED.\n\nFINDING:\n` +
        `severity=${rep.severity}\nfile=${rep.file}${rep.line ? ':' + rep.line : ''}\nsummary=${rep.summary}\nrepro=${rep.repro}\nconfidence=${rep.confidence}` +
        mismaClase +
        guardarPrueba(`${PROBES_DIR}/${rep.lens}-${rep.idxEnLente}`),
      {
        label: `verify:${rep.lens}`,
        phase: 'Verify',
        schema: VERDICT_SCHEMA,
        agentType: 'general-purpose',
        model: MODEL,
      }
    )
  }),
  {
    size: 3,
    // el verificador que tira queda «sin veredicto» (abajo se cuenta); acá se dice por qué, que si no se pierde
    onError: (k, e) => log(`adversarial-verify: el verificador de la clase ${k + 1} tiró: ${(e && e.message) || e}`),
  }
)

// 🔴 UN VERIFICADOR MUERTO NO ES UN «REFUTED». `agent()`
// devuelve null cuando el agente muere o no contesta JSON válido, y eso se tomaría por un
// veredicto real. Sin agrupación costaría un hallazgo; con la agrupación cuesta la CLASE ENTERA — varios
// hallazgos de lentes distintas desaparecen del reporte y el pase sale igual de verde. El default
// es REFUTED (no se confirma lo que no se reprodujo), pero se cuenta y se dice.
const sinVeredicto = []
veredictos.forEach((v, k) => { if (!v || (v.verdict !== 'CONFIRMED' && v.verdict !== 'REFUTED')) sinVeredicto.push(grupos.clases[k]) })
if (sinVeredicto.length) {
  log(`adversarial-verify: 🔴 ${sinVeredicto.length} clase(s) SIN VEREDICTO — el verificador no contestó` +
    ` (arrastran ${sinVeredicto.reduce((a, c) => a + c.miembros.length, 0)} hallazgo(s), que quedan sin confirmar).` +
    ` NO es lo mismo que refutado: relanzá el pase o verificá esas clases a mano.`)
}

// El veredicto de la clase baja a CADA hallazgo de la clase, con constancia de cuál se reprodujo.
const confirmed = []
const aVerificarAparte = []
grupos.clases.forEach((c, k) => {
  const v = veredictos[k]
  if (!v || v.verdict !== 'CONFIRMED') return
  const rep = todos[c.representante]
  // El verificador reprodujo UNO. Si dice que los demás no eran lo mismo, los demás no están
  // verificados por nadie: se listan aparte en vez de heredar un veredicto que no les corresponde.
  // 🔴 `!== true`, no `=== false`. El esquema exige la clave, pero el validador sólo mira que ESTÉ,
  // no su tipo: con `null`, `""` o el string `"false"`, un `=== false` daría falso y la clase entera
  // heredaría CONFIRMED sin que nadie la hubiera reproducido. Ante la duda se SEPARA: no se hereda.
  const soloElRepresentante = v.todos_el_mismo_defecto !== true
  for (const m of c.miembros) {
    if (soloElRepresentante && m !== c.representante) { aVerificarAparte.push(todos[m]); continue }
    const f = todos[m]
    confirmed.push({
      lens: f.lens,
      ...f,
      clase: c.id,
      verificado_via: `${rep.lens}-${rep.idxEnLente}`,
      agrupado_por: c.motivo,
      adjusted_severity: v.adjusted_severity,
      verify_reasoning: v.reasoning,
      probe_dir: v.probe_dir || '',
    })
  }
})

// El detalle de cada hallazgo: su texto, su estado y lo que dijo el verificador de su clase, si
// contestó. Un verificador muerto deja `sin-veredicto` —nunca refutado— y el pase no medido.
const detalle = []
grupos.clases.forEach((c, k) => {
  const v = veredictos[k]
  // Contestó sólo con un veredicto de los dos que existen: `confirmed` en minúscula, `UNSURE` o basura no son un
  // refutado: quedan sin veredicto y el pase no medido.
  const contesto = !!(v && (v.verdict === 'CONFIRMED' || v.verdict === 'REFUTED'))
  const rep = todos[c.representante]
  const verificador = contesto
    ? { verdict: v.verdict, reasoning: v.reasoning || '', adjusted_severity: v.adjusted_severity || null, probe_dir: v.probe_dir || '',
        todos_el_mismo_defecto: v.todos_el_mismo_defecto === true, verificado_via: `${rep.lens}-${rep.idxEnLente}` }
    : null
  for (const m of c.miembros) {
    let estadoH
    if (!contesto) estadoH = 'sin-veredicto'
    else if (v.verdict === 'CONFIRMED') estadoH = (v.todos_el_mismo_defecto !== true && m !== c.representante) ? 'a-verificar-aparte' : 'confirmado'
    else estadoH = 'refutado'
    detalle.push({ ...textoDe(todos[m]), clase: c.id, estado: estadoH, verificador })
  }
})
const hallazgosSinVeredicto = detalle.filter((d) => d.estado === 'sin-veredicto').length
const medido = lentesSinMedir.length === 0 && hallazgosSinVeredicto === 0
const aviso = medido ? null : avisoNoMedido(lentesSinMedir, hallazgosSinVeredicto)
if (aviso) log(aviso)

const porLente = new Map()
for (const f of todos) porLente.set(f.lens, (porLente.get(f.lens) || 0) + 1)
const results = [...porLente.entries()].map(([lens, count]) => ({ lens, count }))

if (aVerificarAparte.length) {
  log(`adversarial-verify: 🔴 ${aVerificarAparte.length} hallazgo(s) A VERIFICAR APARTE — el verificador dijo que NO son el mismo` +
    ` defecto que el que reprodujo. No están confirmados ni refutados: nadie los miró. Relanzá el pase sobre ellos o verificalos a mano.`)
}

const sinPrueba = confirmed.filter((c) => !c.probe_dir).length
log(`adversarial-verify: ${confirmed.length} CONFIRMED sobre ${LENSES.length} lentes (model=${MODEL}), ` +
  `${grupos.clases.length} verificadores para ${todos.length} hallazgos.` +
  (confirmed.length ? ` Pruebas en ${PROBES_DIR}${sinPrueba ? ` — ${sinPrueba} sin guardar (ver su reasoning)` : ''}.` : ''))
return {
  confirmed,
  probes_dir: PROBES_DIR,
  all_lenses: results,
  // Para que el ratio de duplicación se mida solo: estos tres números
  // los anota el step con `marker.js mark-adversarial-result --classes <k>`.
  hallazgos: todos.length,
  clases: grupos.clases.length,
  agentes_ahorrados: grupos.resumen.agentes_ahorrados,
  dudas: grupos.dudas.length,
  // Clases cuyo verificador no contestó: no están confirmadas NI refutadas. Sin este número, una
  // muerte técnica se ve igual que «lo miramos y no era nada».
  sin_veredicto: sinVeredicto.length,
  hallazgos_sin_veredicto: sinVeredicto.reduce((a, c) => a + c.miembros.length, 0),
  // Hallazgos que el verificador declaró distintos del que reprodujo: no heredan su veredicto.
  a_verificar_aparte: aVerificarAparte.length,
  // Qué se revisó de verdad. `medido: false` si alguna lente quedó sin su cazador o algún hallazgo sin
  // su verificador; `detalle` guarda el texto de cada hallazgo y la constancia del verificador.
  lentes,
  lentes_sin_medir: lentesSinMedir,
  detalle,
  medido,
  aviso,
}
