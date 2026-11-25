# La medición: el banco, las métricas, la oficina y el tablero

Las fichas de este grupo de [las piezas del arnés](../piezas-del-arnes.md). Cada una dice **qué es** la pieza,
**por qué existe**, **quién la usa** y **dónde se prueba**. El detalle de cada pieza está en
[la guía de detalle](../maintaining/piezas-en-detalle.md), bajo el mismo título.

## scripts/nightly/watcher/vigilante.js

_(scripts/nightly/watcher/vigilante.js + inbox/watcher/)_

**Qué es:** El vigilante de producción: mira producción cada noche y deja un borrador con lo que huele mal para decidir a la mañana.

**Por qué existe:** Cubre lo que quedó bajo el umbral de las alertas de Azure, con cuatro reglas (goteo, desagregación, salud y deriva). No toca nada. Cada ficha recuerda su pull request (`pr:`) y lo rechazado no vuelve a abrirse. Lo decidido se registra antes de contar.

**Quién la usa:** El nocturno del vigilante y el dev, con `/tycon-vigilante`; los dos YAML llaman a `scripts/ci/open-pr-per-finding.sh`.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsnightlywatchervigilantejs)

## scripts/controls-bench/periodic-exam.js

**Qué es:** El examen periódico de los revisores: corre solo en la máquina designada por `exam-config.json` y denuncia cuando no corre.

**Por qué existe:** Un lanzador con condiciones anidadas dejaba de correr sin que nadie lo notara. Sella la semana al terminar, guarda dos archivos de resultado y sale 0 si midió. Lo que no pudo medir lo dice, no lo pinta de cero.

**Quién la usa:** El disparador del sistema que genera desde `exam-config.json` y el aviso de arranque; `--dry-run` diagnostica sin gastar.

**Dónde se prueba:** `periodic-exam.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptscontrols-benchperiodic-examjs)

## scripts/ci/push-nightly-data.js

**Qué es:** El guion que guarda en `main` lo que escribieron los nocturnos, con `save` y `sync`.

**Por qué existe:** Empujar `HEAD` subía un commit local que no existía en el remoto y movía el checkout. Ahora el checkout no se mueve: arma un commit sólo con las rutas del paso y no empuja si alguna comprobación falla. Nada nuevo no es todo bien, y no pude no es no hay.

**Quién la usa:** Los pipelines nocturnos y `open-pr-per-finding.sh`.

**Dónde se prueba:** `scripts/tests/push-nightly-data.test.js`, `scripts/tests/pipelines-push-guard.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptscipush-nightly-datajs)

## scripts/lib/result-travel.js

**Qué es:** Cómo viajan los resultados de la noche que produce una máquina (el examen de revisores, los casos de guía y la revisión semanal): cada uno va como una entrada nueva a la rama `night-results`.

**Por qué existe:** La máquina no puede empujar a `main` del repo de mantenimiento. Publica sin tocar el clon, guarda el resultado primero en la carpeta de estado y anota si viajó o no, para que un empuje fallido se vea al arrancar.

**Quién la usa:** `periodic-exam.js`, `guide-runner`, la revisión semanal y el aviso `bench-notice.js`.

**Dónde se prueba:** `scripts/tests/result-travel.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibresult-traveljs)

## scripts/ci/carry-night-results.js

**Qué es:** El guion que lleva a un checkout de `main` las entradas de `night-results` que todavía no llevó, de la más vieja a la más nueva.

**Por qué existe:** Es el otro extremo de `result-travel.js`. Escribe en `main` y cualquiera puede empujar a la rama, así que aplica sólo lo que tiene forma de resultado. Un archivo viejo no pisa uno nuevo, y lo llevado se anota en `carried.json`.

**Quién la usa:** Un nocturno del repo de mantenimiento, entre `push-nightly-data.js sync` y `save`.

**Dónde se prueba:** `scripts/tests/carry-night-results.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptscicarry-night-resultsjs)

## pipelines/azure-pipelines-banco.yml

**Qué es:** El pipeline `pipelines/azure-pipelines-banco.yml` que corre de noche el banco de controles y las suites de prueba del arnés.

**Por qué existe:** Lanzarlos desde el arranque de cada máquina los superponía y el aviso gritaba regresiones sin un defecto real. El reporte viaja por git para que todas las máquinas lean la misma foto. Un no medido es aviso naranja, nunca verde.

**Quién la usa:** El nocturno de Azure; `bench-notice.js` lee el reporte. La lista de suites vive en `scripts/tests/suites.json`.

**Dónde se prueba:** `scripts/tests/bench-unmeasured.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#pipelinesazure-pipelines-bancoyml)

## scripts/ci/suites-shard.js

_(scripts/ci/suites-shard.js + scripts/ci/suites-weights.json)_

**Qué es:** El guion que reparte las suites en trabajos paralelos por peso y junta sus resultados.

**Por qué existe:** Un solo trabajo largo se cortaba sin escribir el reporte. Un trabajo que no terminó nunca se da por verde: sus suites quedan como no medidas. Un pedido mal formado sale 2 sin lista.

**Quién la usa:** El nocturno, la validación de pedidos de merge y el veredicto `pr-verdict.js`.

**Dónde se prueba:** `scripts/tests/suites-shard.test.js`, `scripts/tests/pr-suites-shards.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptscisuites-shardjs)

## scripts/ci/suites-over-limit.json

_(scripts/ci/suites-over-limit.json + scripts/tests/lib/suite-parts.js + scripts/tests/lib/suite-parts.sh)_

**Qué es:** La lista de decisiones sobre las suites que pasan de 45 segundos en la validación de una rama.

**Por qué existe:** Sin decisión la validación se alarga. Cada suite se parte en partes, se manda al nocturno o lleva una excepción firmada por el dueño. Las del laboratorio del instalador corren en la rama sólo si el cambio toca el instalador, según `scripts/ci/heavy-suites.json`.

**Quién la usa:** La validación de ramas, `suites-for-change.js` y quien suma una suite nueva.

**Dónde se prueba:** `scripts/tests/suite-parts.test.js`, `suites-coverage.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptscisuites-over-limitjson)

## scripts/tests/lib/product-lab.js

_(scripts/tests/lib/product-lab.js + scripts/tests/product-lab-known-gaps.json + scripts/tools/compare-matrix.js)_

**Qué es:** Un producto de prueba de tres repos, con fusiones reales, sobre el que corren la matriz y los cierres. `compare-matrix.js` cuenta cuántas historias cambian de resultado entre dos versiones.

**Por qué existe:** Lo que depende de la forma de un producto no se ve en la prueba de una regla. Al cambiar la matriz o los cierres, la medida se corre antes y después, y los totales van en la historia. Un defecto de cierre hallado en un producto suma su caso en el mismo cambio, con nombres inventados.

**Quién la usa:** La cola, la noche y quien cambia un control de cierre.

**Dónde se prueba:** `scripts/tests/product-lab.test.js`, `compare-matrix.test.js`

## scripts/metrics/sdlc-stage-metrics.js

_(scripts/metrics/sdlc-stage-metrics.js + scripts/nightly/dashboard/dashboard.js + scripts/nightly/projects/snapshot.js + scripts/nightly/projects/state-age.js + scripts/metrics/author-concentration.js)_

**Qué es:** El medidor de etapas del SDLC y el tablero que lo muestra.

**Por qué existe:** Un número sin denominador es el problema que existe; `null` con motivo nunca se cambia por 0. Deriva el tiempo por etapa del historial de git y usa los estados de `scripts/metrics/states.json`.

**Quién la usa:** El nocturno de métricas y el tablero del equipo.

**Dónde se prueba:** `scripts/tests/sdlc-transitions.test.js`, `scripts/tests/dashboard.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsmetricssdlc-stage-metricsjs)

## scripts/metrics/tokens-digest.js

**Qué es:** Rescata de cada corrida del pipeline su consumo y el hilo comprimido de la conversación, y los guarda junto al volcado de la corrida.

**Por qué existe:** La conversación de Claude Code se borra sola, y sin ella no se sabe por qué costó cada corrida. El rescate la conserva, cuenta el consumo una vez por respuesta y recupera el mensaje de error de cada freno en rojo.

**Quién la usa:** El archivador del cierre (`marker.js`), el arranque de sesión y `marker.js run-check`, que guarda la cola de la salida en `gates.log`.

**Dónde se prueba:** `scripts/tests/tokens-digest.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsmetricstokens-digestjs)

## scripts/metrics/reviewers-cost.js

**Qué es:** Mide, por corrida y por revisor, cuántos revisores se lanzaron, cuánto tardó cada uno, cuánto devolvió y cuánto consumió.

**Por qué existe:** El arnés lanzaba muchos revisores y no sabía qué costaban. Lo medido y lo estimado nunca se suman; el supuesto de la estimación vive en `reviewers-cost-assumption.json` y vence.

**Quién la usa:** Va encadenado al barrido de `tokens-digest.js` al arrancar la sesión; lo muestra la vista de corridas. A mano: `--run` o `--all`.

**Dónde se prueba:** `scripts/tests/reviewers-cost.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsmetricsreviewers-costjs)

## scripts/metrics/run-change.js

**Qué es:** Registra qué cambió cada corrida según git: los commits que creó y lo que dejó sin commitear, en cada repo donde escribió.

**Por qué existe:** La conversación guarda el comando de consola pero no el cambio que hizo, así que dejaba afuera la mayor parte. Git sí lo sabe.

**Quién la usa:** El archivador del cierre (`marker.js clear`) lo llama y deja `<volcado>.cambio.json.gz`; lo muestra la vista de corridas.

**Dónde se prueba:** `scripts/tests/run-change.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsmetricsrun-changejs)

## scripts/metrics/retro-heartbeat.js

**Qué es:** Escribe, sin modelo, el archivo de retrospectiva de cada merge a main, en la carpeta de estado de la máquina (nunca en un clon). De ahí viaja por el buzón; sin llave, lo dice.

**Por qué existe:** Lanzar el capturador con modelo en cada merge costaba mucho tiempo y consumo para archivos casi vacíos. Acá sale la identidad del merge y la última vuelta de revisión; el resto queda en null con quién lo cubre.

**Quién la usa:** El paso 10b de `/tycon-merge-to-main`, tras consultar `retro-pending.js --judge`. El capturador queda a pedido («retro con modelo»).

Un pedido se reclama cuando entra, por su commit en main; el latido sólo acepta commits de la línea de main y se anula con `retro-heartbeat.js --annul --sha`.

**Dónde se prueba:** `scripts/tests/retro-heartbeat.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsmetricsretro-heartbeatjs)

## pipeline.js dod-checker-needed

_(pipeline.js dod-checker-needed · deferrals-open · qa-legibilidad (AgentSkills) + la ficha «los hooks del cierre»)_

**Qué es:** Decide si el cierre de una story necesita el revisor de DoD con modelo, y anota cada decisión de los hooks del cierre.

**Por qué existe:** El cierre releía con modelo lo que ya corre código y casi nunca encontraba algo. Ahora el revisor se invoca sólo si el diff trae un worker, una transacción compleja o tandas en vuelo; ante la duda, invoca.

**Quién la usa:** El pipeline en el cierre; los hooks del cierre dejan constancia en `frenos.jsonl`, que cuenta el reductor del tablero.

**Dónde se prueba:** `scripts/tests/guard-record.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#pipelinejs-dod-checker-needed)

## scripts/lib/validator-verdict.js

_(scripts/lib/validator-verdict.js + el re-loop del validador en pipeline.js (AgentSkills))_

**Qué es:** Deja el veredicto del validador de stories al cierre de cada informe y saca al validador del re-loop tras dos veredictos limpios seguidos.

**Por qué existe:** Era el revisor más caro y los re-loops casi nunca traían algo nuevo. Ante cualquier duda se invoca igual.

**Quién la usa:** `pipeline.js` (línea `validador-reloop` en `gates.log`), el medidor de revisores y la vista de corridas.

**Dónde se prueba:** `scripts/tests/validator-verdict.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibvalidator-verdictjs)

## scripts/metrics/step-times.js

_(scripts/metrics/step-times.js + el carril de cada commit en scripts/hooks/unpushed-work-notice.js)_

**Qué es:** Es la única cuenta de cuánto trabajó y cuánto esperó una corrida, separando trabajo, espera humana y tiempo entre pasos; además anota por qué carril entró cada commit.

**Por qué existe:** Antes sólo se marcaba el fin de cada paso, y el tiempo muerto antes de arrancar caía entero en el paso siguiente. También permite comparar el reproceso entre carriles, con el criterio fijado en `scripts/metrics/lane-hypothesis.json`.

**Quién la usa:** La vista de corridas y el tablero; `pipeline.js next` anota el arranque de cada paso.

**Dónde se prueba:** `scripts/tests/step-times.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsmetricsstep-timesjs)

## scripts/lib/office-messages.js

_(scripts/lib/office-messages.js + la ruta de la oficina scripts/tools/office/messages.js + los ganchos scripts/hooks/office-inbox-watch.js y office-message-rule.js + scripts/tools/office-message.js)_

**Qué es:** Lo que la persona le escribe a una sesión desde `/office`: el buzón, el vigilante que la despierta y `office-message.js verify`, que la sesión corre antes de obedecer.

**Por qué existe:** Darle indicaciones a una sesión sin buscar su pestaña. Llega como aviso del sistema, nunca como la persona: por eso no firma.

**Quién la usa:** La ventana de una sesión en `/office` y cada sesión de Claude. Off: `TYCON_OFFICE_MESSAGES=0`.

**Dónde se prueba:** `scripts/tests/office-messages.test.js`, `office-inbox-watch.test.js` y `owner-approvals.test.js`

## scripts/tools/work-in-progress.js

_(scripts/tools/work-in-progress.js + commands/wip.md; en 3D y en vivo: scripts/tools/office.js; el estado de cada sesión: scripts/hooks/session-state.js)_

**Qué es:** `/wip`: el trabajo en curso de la máquina (story, paso, hora y sesión), lo que espera entrar a los repos, las notas (`marker.js doing`), las libres y lo que quedó a medio camino.

**Por qué existe:** Saber qué hace cada sesión pedía leer los marcadores. La hora de fin es la mediana de los pasos medidos, fija al entrar a cada paso; sin datos, lo dice.

**Quién la usa:** Quien coordina varias sesiones. Sólo lee: no limpia ni adopta.

**Dónde se prueba:** `scripts/tests/`: `work-in-progress`, `office*`, `session-state`, `session-transcript`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptstoolswork-in-progressjs)

## scripts/hooks/office-link-start.js

_(scripts/hooks/office-link-start.js + `harness.js team-refresh`; la conexión: scripts/tools/office/site-link.js)_

**Qué es:** Lo que enlaza la oficina de la máquina con el sitio de la organización sin que el dev haga nada: el alta con
la huella al abrir una sesión, y la capa del equipo al día cada 30 min mientras se trabaja.

**Por qué existe:** Una máquina con el arnés al día quedó sin oficina porque su capa del equipo seguía sin la dirección
del sitio, y sólo un `update --yes` a mano la trajo.

**Quién la usa:** Cada máquina del equipo, sola. Quien mantiene aprueba cada máquina una vez en el sitio.

**Dónde se prueba:** `scripts/tests/`: `office-site-link`, `harness-team` (T43); el banco, caso 79

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshooksoffice-link-startjs)

## scripts/metrics/upload-runs.js

_(scripts/metrics/upload-runs.js + scripts/metrics/download-runs.js)_

**Qué es:** Sube las corridas de cada máquina a un buzón privado: un contenedor de Azure Storage o un bucket de Google Cloud Storage, según el `provider` de la llave (`integrations/gcs/`, `guides/integrations/gcs-mailbox.md`). `download-runs.js` las baja, por ahora sólo de Azure. También sube las métricas de cada merge.

**Por qué existe:** El hilo trae prompts, rutas del disco y código de cliente, así que no puede viajar por git. La llave de subida sólo crea objetos nuevos: no lee, no lista, no pisa ni borra (en Google Cloud Storage, una clave HMAC de una cuenta con sólo `storage.objects.create`).

**Quién la usa:** El instalador lo lanza de fondo en cada arranque, tras el barrido de `tokens-digest.js`. La vista de corridas lee lo bajado.

**Dónde se prueba:** `scripts/tests/upload-runs.test.sh`, `scripts/tests/download-runs.test.sh`, `scripts/tests/mailbox-gcs.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsmetricsupload-runsjs)

## scripts/lib/merge-metrics.js

**Qué es:** Lleva el archivo de métricas de cada merge desde la máquina que lo escribió hasta el tablero, sin que nadie lo commitee.

**Por qué existe:** El latido dejaba el archivo en el `.dashboard/` del clon: ensuciaba el checkout compartido, frenaba su actualización y, sin subir, el tablero y la retro no veían ese merge. Ahora cada máquina lo escribe en su carpeta de estado y `upload-runs.js` lo sube al buzón. La misma pasada muda los que quedaron colgados en un clon: nunca toca uno versionado ni pisa otro distinto.

**Quién la usa:** `upload-runs.js` (la mudanza y la fase de merges).

**Dónde se prueba:** `scripts/tests/merge-metrics.test.js`, `scripts/tests/upload-runs.test.sh`

## scripts/lib/people.js

**Qué es:** Es la regla única de quién ve qué corridas en el sitio de la organización.

**Por qué existe:** Cada máquina informa el correo de git de su dev, y hasta que un mantenedor confirma de quién es (en `operations.json`, sólo con la huella del correo) sus corridas las ven sólo quienes mantienen. Así una máquina que cambió de manos no muestra corridas ajenas.

**Quién la usa:** El sitio de la organización, en cada pedido.

**Dónde se prueba:** `scripts/tests/people.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibpeoplejs)

## scripts/lib/guard-record.js

**Qué es:** Hace que cada freno previo a la herramienta deje una línea por decisión (bloqueo, paso, escape o aviso) en `frenos.jsonl`, con sólo la huella del comando.

**Por qué existe:** El tablero sabía cuántas veces se salteó un freno, pero no cuántas veces frenó, y ése es el dato que decide si una regla se retira. Si no puede escribir, el freno decide igual.

**Quién la usa:** Los frenos que corren antes de cada comando; el reductor y el tablero cuentan lo que dejan.

**Dónde se prueba:** `scripts/tests/guard-record.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibguard-recordjs)

## scripts/metrics/controls-table.js

**Qué es:** La tabla de los controles de esta máquina, por freno y por modelo: cuánto frenó, avisó, pasó con firma y dejó pasar, los controles del pipeline que frenaron, las fallas de cada freno y si es exigencia o preferencia.

**Por qué existe:** Para decidir qué freno se relaja y para qué modelo hace falta saber cuánto frena y cuánto se firma igual. Sólo lee.

**Quién la usa:** Quien mantiene el arnés, a mano. La clasificación vive en `controls-classification.json`.

**Dónde se prueba:** `scripts/tests/controls-table.test.js`

## scripts/nightly/dashboard/reducer.js

**Qué es:** Cuenta los frenos y los escapes de todas las máquinas desde el buzón de corridas y publica sólo las cuentas. También junta qué máquina tiene una vuelta atrás vigente (no se actualiza sola), qué versión deshizo y desde cuándo.

**Por qué existe:** El tablero contaba una sola máquina. Como lo publicado lo ve todo el equipo, el reductor usa una lista blanca de campos y de valores (en `sources.json`), un piso mínimo y alias sin persona.

**Quién la usa:** El tablero nocturno (`dashboard.js`).

**Dónde se prueba:** `scripts/tests/reducer.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsnightlydashboardreducerjs)

## lib/installed-tree.js

**Qué es:** Dice cuál es el árbol instalado del arnés (`~/.tycon/harness` y sus vecinas) y si una ruta cae adentro, también por los enlaces de `~/.claude`. Con eso el portón de escrituras niega que el agente escriba ahí, en cualquier modo de permisos: el arnés se cambia con un pedido a su repo, no editando la instalación.

**Por qué existe:** En el modo automático de Claude Code una escritura fuera del proyecto se aprueba sola; además cada actualización reemplaza el árbol. Un clon de trabajo enlazado no cuenta. En Codex frena su sandbox; con acceso total escribe.

**Quién la usa:** `lib/story-gate.js`, por `on-story-gate.js` y `on-bash-write-gate.js`.

**Dónde se prueba:** `tycon-pipeline/scripts/tests/installed-tree.test.js` y el banco `59-arbol-instalado.json`.

## test-gate.sh

_(test-gate.sh (AgentSkills) + la ficha «evaluaron el umbral»)_

**Qué es:** Mide la cobertura de pruebas sobre las líneas que la story agregó o modificó y evalúa el 75 % sobre ese número.

**Por qué existe:** Exigirlo sólo sobre archivos nuevos casi nunca juzgaba nada. Sin base, diff o reporte, el resultado es `null` con motivo, nunca 0. El umbral sale de `TYCON_COVERAGE_MIN`, de `team-repos.json` o del valor por defecto.

**Quién la usa:** El control de pruebas del pipeline; el reductor y el tablero cuentan las corridas. En el arnés usa `lib/coverage-wrapper.js` y `lib/node-coverage.js`.

**Dónde se prueba:** `tycon-pipeline/scripts/tests/test-coverage-parser.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#test-gatesh)

## scripts/nightly/dashboard/prune.js

_(scripts/nightly/dashboard/prune.js + scripts/metrics/collect-findings.js + scripts/lib/rules-catalog.js)_

**Qué es:** Reparte cada regla del catálogo en estados (candidata a retiro, rota, activa, sin probar…) cruzando hallazgos, corridas de su revisor y el banco.

**Por qué existe:** El catálogo sólo podía crecer: «nunca encontró nada» y «nadie la miró» se veían igual. Nunca retira nada: marca, y decide una persona.

**Quién la usa:** El tablero (pregunta 4). Lo alimentan `scripts/metrics/collect-findings.js`, que lanza el instalador, y `scripts/lib/rules-catalog.js`.

**Dónde se prueba:** `scripts/tests/prune.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsnightlydashboardprunejs)

## pipelines/azure-pipelines-tablero.yml

_(pipelines/azure-pipelines-tablero.yml + scripts/nightly/dashboard/seal.js + scripts/hooks/dashboard-notice.js)_

**Qué es:** Es el pipeline nocturno de Azure DevOps que genera y publica la página del tablero del equipo, con un sello de fecha y fuentes.

**Por qué existe:** La página se generaba a mano en una máquina, quedaba vieja y mostraba datos de una sola máquina sin avisarlo.

**Quién la usa:** Azure DevOps cada noche; `scripts/hooks/dashboard-notice.js` lee el sello (`seal.js`) al arrancar la sesión y dice de cuándo es.

**Dónde se prueba:** `scripts/tests/dashboard.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#pipelinesazure-pipelines-tableroyml)

## scripts/controls-bench/report-name.js

**Qué es:** Decide el nombre del archivo de la foto del banco según el alcance de la corrida.

**Por qué existe:** Una corrida acotada escribía en el mismo archivo que la foto completa y la pisaba, y el aviso la mostraba como el estado general. Depender de que alguien pase `--json` es un control que no corre. Vive aparte porque requerir `advisor-runner.js` arranca el banco entero.

**Quién la usa:** El banco de controles (`advisor-runner.js`).

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptscontrols-benchreport-namejs)
