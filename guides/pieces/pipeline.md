# Las bibliotecas del pipeline

Las fichas de este grupo de [las piezas del arnés](../harness-pieces.md). Cada una dice **qué es** la pieza,
**por qué existe**, **quién la usa** y **dónde se prueba**. El detalle de cada pieza está en
[la guía de detalle](../maintaining/pieces-in-detail.md), bajo el mismo título.

## skills/tycon-pipeline/scripts/lib/first-story.js — la primera historia de la máquina

**Qué es:** Dice si una historia es la primera que cierra la máquina, por evidencia, y al cerrarla ofrece una sola vez la instalación completa en tres renglones.

**Por qué existe:** La instalación por defecto es la mínima: quien no lee la portada nunca veía un freno. La oferta llega cuando ya vio funcionar el arnés.

**Quién la usa:** `marker.js clear` (la oferta, después de archivar el volcado), el paso «preparar el pull request» (la respuesta) y la corrida de primera vez (`isFirstStory`).

**Dónde se prueba:** `scripts/tests/first-story.test.js`, T7 de `harness-state.test.js` y el grupo `UPGRADE` de `harness-questions.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#skillstycon-pipelinescriptslibfirst-storyjs--la-primera-historia-de-la-máquina)

## skills/tycon-pipeline/scripts/lib/models.js — el modelo de cada trabajo del pipeline

**Qué es:** El único lugar donde se define el modelo de cada trabajo del pipeline y cómo lo cambia la organización (`models`).

**Por qué existe:** Estaba escrito en seis lugares y una organización no podía decir quién paga. Con `mandatory_ceiling: true` el tope baja el modelo y avisa, sin frenar.

**Quién la usa:** El pipeline, el control de lanzamientos, el despliegue de Codex, la paridad y la pestaña Configuración del sitio.

**Dónde se prueba:** `skills/tycon-pipeline/scripts/tests/models.test.js`

**Guía:** [harness-cost-tiering](../harness-cost-tiering.md)

**Detalle:** [ver](../maintaining/pieces-in-detail.md#skillstycon-pipelinescriptslibmodelsjs--el-modelo-de-cada-trabajo-del-pipeline)

## scripts/lib/models-env.js — las variables de Claude Code sobre otro proveedor

**Qué es:** Imprime las variables `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` que Claude Code necesita para que cada nivel use el modelo de la tabla del proveedor de la máquina (`team-repos.json → models.providers`). Con `--format json` o `vscode`, las mismas en JSON.

**Por qué existe:** Los revisores piden `haiku`, `sonnet` u `opus`. Con Claude Code sobre Ollama, cada alias recibe un modelo que existe sólo si su variable está puesta, y el arnés no puede ponerla: el entorno de la sesión vive antes de que arranque.

**Quién la usa:** La función `claude-ollama` de la guía de Ollama, y quien quiera ver qué modelo es cada nivel en su máquina.

**Dónde se prueba:** `scripts/tests/models-env.test.js`

**Guía:** [ollama](../integrations/ollama.md)

## scripts/lib/nightly-model.js — el modelo del proceso de la noche

**Qué es:** Dice con qué proveedor y qué modelo corre un proceso de la noche (`team-repos.json → models.nightly`, traducido con la tabla de su proveedor, con el tope y la lista de permitidos) y qué llave necesita. Sin configuración, sin modelo, fuera de la lista o sin llave devuelve un estado y no corre.

**Por qué existe:** Un proceso de la noche no es la máquina de un dev: no tiene proveedor ni sesión, así que «el modelo del dev» no vale. El modelo se cambia desde el sitio, no con un pedido de código.

**Quién la usa:** El proceso de la noche que redacta los aprendizajes del equipo.

**Dónde se prueba:** `scripts/tests/nightly-model.test.js`

**Guía:** [organization-site](../organization-site.md)

## skills/tycon-pipeline/scripts/lib/run-size.js — el tamaño de la corrida

**Qué es:** Decide si una corrida del pipeline es liviana (la story sólo declara documentación o textos) o completa (lo demás), y estima cuánto va a tardar con las corridas anteriores de la máquina.

**Por qué existe:** Una story que sólo reescribía una guía salía con pase adversarial y cuatro horas estimadas: el riesgo contaba archivos, no lo que tocan.

**Quién la usa:** `pipeline.js` (el arranque, el riesgo, la sugerencia de modelo, el portón del pase y los revisores), `marker.js set-size` y `test-gate.sh` (las suites de una liviana).

**Dónde se prueba:** `skills/tycon-pipeline/scripts/tests/run-size.test.js` y los casos `7.32` de `unit.test.js`

**Guía:** [harness-cost-tiering](../harness-cost-tiering.md#el-tamaño-de-la-corrida-liviana-o-completa)

## skills/tycon-pipeline/scripts/lib/suite-times.js — tiempos y suites a la vez

**Qué es:** Los segundos de cada suite y cuántas corren a la vez: núcleos menos dos o menos la carga; dos núcleos para la persona.

**Por qué existe:** `suite-times.js slow` lista las lentas; un portón a mano acota desde la bifurcación con main.

**Quién la usa:** El portón y las portables.

**Dónde se prueba:** `suite-times.test.js`, `suite-workers.test.js`

**Guía:** [test-execution-discipline](../test-execution-discipline.md)

## skills/tycon-pipeline/scripts/lib/story-review-record.js — la revisión de la historia antes de programar

**Qué es:** La constancia de la revisión de una historia antes de programar: un revisor la lee una vez y quien orquesta la corrige. La escribe sólo `story-review-record`; `story-review-gate` decide si corre.

**Por qué existe:** La única revisión adversarial corría después de programar: una historia rota se descubría programando.

**Quién la usa:** El paso 6 de `tycon-create-story`, el paso 1 del pipeline y el cierre de la ejecución.

**Dónde se prueba:** `skills/tycon-pipeline/scripts/tests/story-review.test.js` y el examen del revisor (`scripts/controls-bench/reviewer-exams/tycon-story-adversarial-reviewer.json`)

**Guía:** [harness-cost-tiering](../harness-cost-tiering.md#de-dónde-sale-cada-modelo-y-cómo-lo-cambia-una-organización)

## skills/tycon-pipeline/scripts/lib/runtime-waiver.js — el registro de firmas de la matriz

**Qué es:** El registro de firmas con el que el dev perdona un criterio que no se puede verificar corriendo, en `.tycon/runtime-waivers.jsonl`.

**Por qué existe:** Perdonar sin firma abriría la puerta a saltear la matriz. La firma la da la persona (en la ventana de permiso, con un click o un «aprobado» donde la ventana no llega, o en su terminal) y lleva una cadena de hash que detecta ediciones a mano. Una firma descartada se dice, con el motivo.

**Quién la usa:** El comando `marker.js runtime-waiver`, la matriz, el paso 8 y el freno del commit.

**Dónde se prueba:** `unit.test.js`, `test-runtime-matrix.js`, `dod-hook-smoke-test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#skillstycon-pipelinescriptslibruntime-waiverjs--el-registro-de-firmas-de-la-matriz)
