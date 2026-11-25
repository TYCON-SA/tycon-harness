# Los procesos de la noche y el sitio

Las fichas de este grupo de [las piezas del arnés](../harness-pieces.md). Cada una dice **qué es** la pieza,
**por qué existe**, **quién la usa** y **dónde se prueba**. El detalle de cada pieza está en
[la guía de detalle](../maintaining/pieces-in-detail.md), bajo el mismo título.

## scripts/ci/check-stage-dependencies.js

**Qué es:** Un control que verifica que la condición de cada etapa de un pipeline diga de qué depende de verdad.

**Por qué existe:** En Azure DevOps una etapa mal enganchada no da error: puede empaquetar con las pruebas en rojo o quedar verde con la etapa anterior saltada. Sin condición explícita no hay hallazgo.

**Quién la usa:** La CI y la suite diaria, sobre los pipelines de los productos.

**Dónde se prueba:** `scripts/tests/stage-dependencies.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscicheck-stage-dependenciesjs)

## scripts/nightly/dependencies/

_(scripts/nightly/dependencies/ + scripts/ci/audit-dependencies.js)_

**Qué es:** La revisión nocturna de dependencias: mira `main` de cada repo, y de cada formulario con su lockfile, y abre un pull request por cada hallazgo nuevo.

**Por qué existe:** El veredicto del control de dependencias cambia sin que cambie el código, y sólo corría en pull requests. Avisa y no frena. Lo declarado no despierta, lo vencido vuelve a contar, y no medido nunca es limpio.

**Quién la usa:** Los pipelines nocturnos de Azure y GitHub, y el dev que decide cada pull request.

**Dónde se prueba:** `scripts/tests/audit-dependencies.test.sh`, `scripts/tests/nightly-dependencies.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptsnightlydependencies)

## scripts/nightly/dependencies/work-items.js

**Qué es:** El paso que crea un Bug en el proyecto de Azure DevOps del equipo dueño por cada vulnerabilidad viva, asignado y con el dev mencionado.

**Por qué existe:** El único aviso era el pull request del arnés, que ve sólo quien mantiene. Se enciende con `azure.pedidos_activos: true` en `repos.json`; nunca crea dos veces el mismo pedido y, si no pudo consultar, no crea nada.

**Quién la usa:** La revisión nocturna de dependencias, antes del commit de la noche.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptsnightlydependencieswork-itemsjs)

## work-items.js state

_(work-items.js state + el cruce de scripts/nightly/dependencies/nightly-dependencies.js)_

**Qué es:** El cruce entre el estado de cada Bug de dependencias y la medición de la noche.

**Por qué existe:** Un Bug cerrado por error dejaba la vulnerabilidad viva y el tablero decía listo. Tras una noche de gracia deja un comentario al dev y nunca cambia el estado. Un pedido no leído nunca cuenta como coincidencia.

**Quién la usa:** El nocturno de dependencias y el resumen diario.

**Dónde se prueba:** `scripts/tests/nightly-dependencies.test.sh`, `scripts/tests/daily-summary.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#work-itemsjs-state)

## scripts/nightly/dependencies/daily-summary.js

**Qué es:** El resumen diario: un único mensaje de Telegram con lo que dejaron las dos colas nocturnas, con lo que cambió arriba.

**Por qué existe:** Varias cosas no llegaban a ningún canal. Y una noche que midió bien pero no entregó el resumen se leía como que no había nada. Deja constancia de la entrega en el snapshot y el hook de arranque cobra si falta.

**Quién la usa:** Las colas de dependencias y del vigilante, y el hook `dependencies-notice.js`.

**Dónde se prueba:** `scripts/tests/daily-summary.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptsnightlydependenciesdaily-summaryjs)

## scripts/nightly/open-prs/open-prs.js

**Qué es:** El paso que lista los pull requests de toda la organización con más de 2 días abiertos y los pega al final del resumen diario.

**Por qué existe:** Un pull request con auto-completar y el build roto queda esperando un verde imposible y nadie se entera. Avisa por antigüedad, sólo al dev. Si Azure no contesta, lo dice: no medido no es cero.

Con `--outside-from` deja además el renglón «De afuera: …» (`scripts/lib/outside-contributions.js`).

**Quién la usa:** El pipeline del vigilante y `daily-summary.js deliver --extra`; con `--json` lo lee el sitio.

**Dónde se prueba:** `scripts/tests/open-prs.test.sh`, `scripts/tests/daily-summary.test.sh`, `scripts/tests/outside-contributions.test.js`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptsnightlyopen-prsopen-prsjs)

## scripts/nightly/assigned/assigned-items.js

**Qué es:** El guion que deja cada noche lo asignado a cada persona en `.dashboard/assigned/`.

**Por qué existe:** El sitio de la organización muestra a cada dev sus pedidos abiertos sin consultar la plataforma en vivo. Guarda una lista blanca (nunca el título) y, si una consulta falla, dice no medido con el motivo.

**Quién la usa:** El nocturno del tablero y el sitio de la organización.

**Dónde se prueba:** `scripts/tests/assigned-items.test.js`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptsnightlyassignedassigned-itemsjs)

## scripts/nightly/deployments/deployments.js

**Qué es:** El guion `deployments.js` que registra qué llegó a staging y qué a producción en cada producto, leyendo el timeline de cada corrida.

**Por qué existe:** Una corrida `succeeded` no prueba nada sobre producción: sin aprobación el stage queda `skipped`. Cuenta por el identificador exacto del stage declarado en `operations.json → deployments`, nunca por texto. Sin permiso o con `az` caído, dice no medido.

**Quién la usa:** El nocturno del tablero, la ficha de despliegues y la pestaña Proyectos del sitio; la prueba corre con `nightly-deployments`.

**Dónde se prueba:** `scripts/tests/nightly-deployments.test.js`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptsnightlydeploymentsdeploymentsjs)

## scripts/site/ — el sitio de la organización

**Qué es:** una página web para toda la organización, donde cada persona entra con la cuenta de la organización y ve lo
suyo (sus pedidos, sus pull requests, sus corridas), y quienes mantienen el arnés ven todo.

**Para qué sirve:** es el punto de entrada de cada día. El aviso de la mañana trae el enlace, y quien mantiene ve ahí qué
decidir; en la pestaña **Configuración** se personaliza la organización sin clonar nada.

**Quién lo usa:** cada persona de la organización, para ver lo suyo; quienes mantienen el arnés, para verlo todo, editar
la configuración e instalarlo. Quién entra lo decide sólo la lista `site.access`, con el inicio de sesión que elija.

**Dónde leer más:** para personas, la guía: cómo se usa cada pestaña, la configuración sección por sección, qué ve
cada rol, los problemas comunes, cómo se instala y cómo está hecho por dentro, en
[guides/organization-site.md](../organization-site.md) (en inglés,
[guides/organization-site.en.md](../organization-site.en.md)). Sus capturas las saca
`scripts/tools/site-guide-captures.js` del sitio corriendo con una organización de laboratorio. Las piezas que lo acompañan: la imagen
(`.github/workflows/site-image.yml`), las instalaciones (`scripts/site/deploy/`: Azure Container Apps en dos fases,
Render y una máquina propia), la prueba sin sesión (`scripts/site/check-deploy.js`) y el canal del aviso
(`scripts/lib/notify.js`); invitar desde Personas, `scripts/site/invitations.js`. Red: las suites `site-*` y `notify`.

**El sitio demo**: con `SITE_DEMO=1` el mismo servidor arranca sin proveedor de inicio de sesión ni credenciales, sobre los datos de ejemplo de «acme» (`scripts/site/demo.js` y `scripts/site/demo/`, los mismos que muestran las capturas de la guía), abierto con un link y de sólo lectura: un freno central no deja abrir conexiones, lanzar procesos ni escribir fuera de su carpeta temporal, y los botones que cambian algo muestran lo que pasaría. Se instala aparte con la fase `demo` del instalador de Azure Container Apps (`--phase ambiente` y después `--phase demo`). Red: `site-demo.test.js`. **La copia de operaciones**: con `SITE_OPERATIONS_SOURCE=copy`, `pipelines/operations/site-copy.yml` sube a
un contenedor sólo lo que el sitio lee (`RUTAS` de `scripts/site/operations-copy.js`, más el logo de `site.brand.logo`)
y el sitio lo lee con su identidad, sin permiso del repo (lo sano que no lee lo ignora; lo peligroso rechaza la foto). «Al día» es el mismo commit con la misma lista de archivos: si la foto cambia sin commit nuevo, se re-sube con otro nombre (sin pisar la que nombra el índice), y el sitio la reabre por su huella; la edad de la copia frena como `operations.json`. Red: `site-operations-copy.test.js`. **Al día con `stable`**: la imagen llega a `stable` sólo escaneada y firmada; `scripts/site/deploy/update-site.js` la instala por huella, prueba y vuelve atrás (`site.update`). Red: `site-latest-release.test.js` y `site-update.test.js`. **Las fichas del tablero**: llegan a Arnés, Proyectos y Corridas por `scripts/site/tabs/cards.js`, que llama al mismo cálculo que arma la página del tablero (`colectar()` de `scripts/nightly/dashboard/dashboard.js`), toma de cada ficha sólo lo de su lista blanca y oculta las que la organización destildó en Configuración (`site.hidden_cards`); la página del tablero ya no se sirve en el sitio, sólo su sello. Red: `site-cards.test.js`. **La pestaña Aprendizajes** (`scripts/site/tabs/learnings.js`): sólo para quien mantiene, muestra las propuestas que deja la noche de los instintos del equipo en la carpeta de propuestas del repo de operaciones y las decide como Mantenimiento, en un envío. Cada tarjeta dice qué recomienda la noche y por qué (`recomendaciones.json`), con el botón resaltado; se puede seguir la recomendación o rechazar varias con un motivo, hasta 200 decisiones por envío. Lo aprobado va por pedido al bloque `team-learnings.md` de un paquete del perfil (con techo de 4.000 bytes y la huella de cada regla, que no se repite) y llega a todas las máquinas con su próxima actualización; las decisiones van por pedido al repo de operaciones, escritas con `archivoDecidido` de la noche, que las lee igual. Red: `site-learnings.test.js`.
