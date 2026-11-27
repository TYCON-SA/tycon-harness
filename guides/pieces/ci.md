# Los controles de CI, las versiones y los despliegues

Las fichas de este grupo de [las piezas del arnés](../harness-pieces.md). Cada una dice **qué es** la pieza,
**por qué existe**, **quién la usa** y **dónde se prueba**. El detalle de cada pieza está en
[la guía de detalle](../maintaining/pieces-in-detail.md), bajo el mismo título.

## scripts/lib/tycon-telegram-notify.sh

**Qué es:** Un guion que avisa por Telegram desde Claude Code o Codex: imprime el `message_id`, y `--edit <id>` reescribe el mismo aviso.

**Por qué existe:** Permite un aviso por tanda en vez de una catarata. Es sólo de salida a propósito: un segundo consumidor de entrada le rompería el canal al otro. Sin configuración sale con código 3 y lo dice.

**Quién la usa:** Cualquier sesión o proceso del arnés que deba avisar.

**Dónde se prueba:** `scripts/tests/telegram-notify.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptslibtycon-telegram-notifysh)

## scripts/ci/release-notes.sh

**Qué es:** El `release-notes.sh` canónico: arma las notas de versión que lee el administrador que instala un plugin. La bandera `--type plugin|formulario` elige el caso.

**Por qué existe:** Copiado en cada repo, nada mantiene iguales las copias, y a la que le falta un filtro le publica «Merged PR…» al administrador.

**Quién la usa:** Los pipelines de los productos.

**Dónde se prueba:** `scripts/tests/release-notes.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscirelease-notessh)

## scripts/ci/recompute-zip-notes.sh

**Qué es:** El paso de despliegue de formularios: por cada ZIP pregunta al host qué versión está publicada y reescribe la nota adentro del paquete.

**Por qué existe:** La nota debe decir qué cambia respecto de lo instalado, no del build anterior. Sale con código 3 cuando no pudo, para que el paso quede naranja y no verde.

**Quién la usa:** Los pipelines de formularios de los productos.

**Dónde se prueba:** `scripts/tests/recompute-zip-notes.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscirecompute-zip-notessh)

## scripts/tools/release-notes-parity.js

**Qué es:** Un control que compara el comportamiento del filtro de ruido de cada copia de `release-notes.sh` contra un corpus fijo de mensajes de commit.

**Por qué existe:** Una copia sin filtrar deja pasar ruido a la nota, o peor, borra un cambio real. Juzga contra lo esperado, no contra la mayoría, y una copia ilegible falla.

**Quién la usa:** La suite diaria, que lanza `install-tycon-hooks.sh`.

**Dónde se prueba:** `scripts/tests/release-notes-parity.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptstoolsrelease-notes-parityjs)

## scripts/ci/publish-bump.sh

**Qué es:** El guion único que commitea y publica el aumento de versión de los formularios para los cinco productos.

**Por qué existe:** Cuando dos construcciones terminan cerca, el segundo push rebota. Conserva la marca `Commit: <sha>`; sin ella un formulario puede no versionarse nunca.

**Quién la usa:** Los pipelines de los cinco productos, vía `forms-to-version.sh`.

**Dónde se prueba:** `scripts/tests/publish-bump.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscipublish-bumpsh)

## scripts/lib/meter-backup.sh

**Qué es:** Una función que decide si el respaldo local del medidor de etapas del SDLC debe correr ahora.

**Por qué existe:** Si corre antes de que el nocturno de Azure tenga su turno, deja un archivo suelto en `.dashboard/` que rompe el `pull` del arranque.

**Quién la usa:** El instalador, que la carga.

**Dónde se prueba:** `scripts/tests/meter-backup.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptslibmeter-backupsh)

## packs/bizuit/guides/deuda-de-pruebas-formularios.md

**Qué es:** La guía para dejar un formulario sin pruebas sin que el pipeline falle: se declara en `pending-tests.json` con motivo y fecha de revisión. Es del paquete bizuit.

**Por qué existe:** Borrar la entrada sin agregar pruebas deja `main` rojo, por eso se borra en el mismo pull request.

**Quién la usa:** Cualquier dev que declare o pague una deuda de pruebas.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/pieces-in-detail.md)

## scripts/ci/affected-forms.js

**Qué es:** El cálculo de qué formularios probar y construir por un cambio: lo cambiado más su cono de dependientes, derivado de los imports reales.

**Por qué existe:** Probar sólo lo cambiado pierde roturas; construir todos desperdicia. En `main` se prueba y construye todo. Ante cualquier duda devuelve todos, y si no encuentra formularios sale con código 3.

**Quién la usa:** Los pipelines de formularios y `forms-to-version.sh`.

**Dónde se prueba:** `scripts/tests/affected-forms.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptsciaffected-formsjs)

## scripts/ci/typecheck-forms.js

**Qué es:** El chequeo de tipos (`tsc --noEmit`) de cada formulario que se prueba. Dice limpio, con errores, sin tsconfig o no medido.

**Por qué existe:** El empaquetado de los formularios no chequea tipos, así que un error de tipos podía vivir meses en `main` con las pruebas en verde. Un paquete que tsc no encuentra sale «no medido», nunca como error; por eso instala antes los formularios de los que importa cada uno.

**Quién la usa:** La etapa de pruebas de los pipelines de formularios, en modo aviso con fecha de revisión.

**Dónde se prueba:** `scripts/tests/typecheck-forms.test.js`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscitypecheck-formsjs)

## scripts/ci/forms-to-version.sh

**Qué es:** El cálculo de a qué formularios subirles la versión en una corrida.

**Por qué existe:** Mirar sólo `HEAD~1` pierde el primer merge de un lote agrupado y el cambio nunca llega. Nunca sale 0 sin poder decidir.

**Quién la usa:** Los pipelines de los cinco productos; corre en la suite diaria desde `install-tycon-hooks.sh`.

**Dónde se prueba:** su propia suite de pruebas, bajo `scripts/tests/`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptsciforms-to-versionsh)

## scripts/ci/backend-to-version.sh

**Qué es:** La decisión de si una corrida del backend trae algo nuevo desde la última versión.

**Por qué existe:** Sin ella, repetir una corrida o probar el arnés dejaba una versión vacía en staging, el bump del bot en `main` y un pedido de producción. Ante la duda versiona y avisa; la casilla `versionarYDesplegar` fuerza el camino de siempre.

**Quién la usa:** El pipeline de backend de cada producto y el canónico del paquete bizuit.

**Dónde se prueba:** `scripts/tests/backend-to-version.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscibackend-to-versionsh)

## scripts/ci/label-prs.sh

_scripts/ci/label-prs.sh + scripts/ci/run-base.sh_

**Qué es:** El guion que etiqueta cada corrida de `main` con `PR-<id>` y escribe un resumen con el enlace a cada pull request. Comparte la base con `forms-to-version.sh` a través de `scripts/ci/run-base.sh`.

**Por qué existe:** Con `batch: true` la corrida junta varios merges y su título no dice cuáles. Es trazabilidad, no un control: sale 0 y avisa si no pudo etiquetar.

**Quién la usa:** El job de construcción de `main` de cada producto.

**Dónde se prueba:** `scripts/tests/label-prs.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscilabel-prssh)

## scripts/ci/nightly-dod-notice.sh

**Qué es:** El aviso por Telegram de la evidencia DoD que mide el nocturno: compara el snapshot de hoy con el anterior y avisa sólo si se movió.

**Por qué existe:** Lee lo publicado en `origin/main` y no toca el checkout; leer el disco avisaba «no corrió» por error. Un envío que no llega se reintenta en la corrida siguiente.

**Quién la usa:** Un LaunchAgent en la Mac del dev.

**Dónde se prueba:** `scripts/tests/nightly-dod-notice.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscinightly-dod-noticesh)

## scripts/ci/sql-compile.js

**Qué es:** Un control que compila sin ejecutar cada migración SQL nueva o modificada (`database/` o `BD/`) antes del commit, y avisa sin frenar.

**Por qué existe:** Un error de sintaxis frena el despliegue entero y nada más toca un `.sql` suelto. «Sin compilar» nunca se lee como «compila». Se apaga con `TYCON_SQL_COMPILE=0`.

**Quién la usa:** El pre-commit global de git.

**Dónde se prueba:** `scripts/tests/sql-compile.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscisql-compilejs)

## scripts/ci/check-bash32-quoting.sh

**Qué es:** Un lint que marca `$variable` pegada a un carácter fuera de ASCII en guiones de shell.

**Por qué existe:** El bash 3.2 de macOS parte la variable y rompe el texto, y las suites no lo ven en otros intérpretes. Es una regla que no se puede recordar, necesita un control.

**Quién la usa:** El pre-commit (sobre lo stageado) y a mano sobre el repo.

**Dónde se prueba:** `scripts/tests/bash32-quoting.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscicheck-bash32-quotingsh)

## scripts/ci/public-ci.sh

_scripts/ci/public-ci.sh + scripts/ci/check-public-workflow.js + el `ci.yml` de la copia_

**Qué es:** La CI del repo público en un guion que cualquiera corre en su máquina, más `scripts/ci/check-public-workflow.js`, que verifica la forma exacta del `ci.yml`. La corrida termina en un job estable llamado `public-ci`.

**Por qué existe:** El repo público acepta cambios de desconocidos y la CI no puede ser una lista de comandos sin prueba. No corta en el primer rojo, y un paso que no pudo correr es rojo.

**Quién la usa:** El workflow `ci.yml` de la copia, la prueba nocturna y quien contribuye.

**Dónde se prueba:** `scripts/tests/public-ci.test.sh`

**Guía:** [mirror-publishing.md](../maintaining/mirror-publishing.md)

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscipublic-cish)

## scripts/ci/run-base-controls.sh

_(scripts/ci/run-base-controls.sh + scripts/ci/controls-from-base.json + scripts/ci/bench-against-base.js + el paso `repo-lint` de public-ci.sh con `--base`)_

**Qué es:** El guion que revisa un pedido con los controles de la base, según `scripts/ci/controls-from-base.json`, y el banco con los casos de la base.

**Por qué existe:** Un pedido podía aflojar el control que lo frenaba y saltearlo. Aflojarlo exige la constancia del dueño; si no se puede correr, es rojo.

**Quién la usa:** La CI de GitHub (`ci.yml` vía `public-ci.sh --base`) y la validación de pedidos del repo de mantenimiento.

**Dónde se prueba:** `scripts/tests/base-controls.test.sh`, `scripts/tests/public-ci.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscirun-base-controlssh)

## scripts/tests/clean-machine.test.sh

_(scripts/tests/clean-machine.test.sh + scripts/tests/clean-machine/ + scripts/tests/fixtures/example-repo/)_

**Qué es:** La prueba que instala el arnés en un contenedor con sólo lo que pide la portada y comprueba que todo anda.

**Por qué existe:** Una carpeta de usuario vacía no es una máquina vacía: lo que el arnés usa sin declararlo sólo se ve donde no está. Si no puede medir, lo dice y no da verde.

**Quién la usa:** El proceso nocturno, la CI pública y quien la corre a mano con `TYCON_CLEAN_MACHINE=1`.

**Dónde se prueba:** `scripts/tests/clean-machine.test.sh`

**Guía:** [mirror-publishing.md](../maintaining/mirror-publishing.md)

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptstestsclean-machinetestsh)

## scripts/ci/check-artifact-paths.js

**Qué es:** Un control que marca los pipelines que LEEN de una carpeta que nunca LLENAN.

**Por qué existe:** Un despliegue a producción que busca su artefacto donde nadie lo deja falla siempre y gasta una aprobación en cada intento. El control no juzga cuál carpeta es la correcta: sólo la incoherencia dentro de un archivo.

**Quién la usa:** La CI y la suite diaria, sobre los pipelines publicados.

**Dónde se prueba:** `scripts/tests/artifact-paths.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscicheck-artifact-pathsjs)

## scripts/ci/rollback-guard.sh

**Qué es:** El freno que impide promover a producción un paquete de versión menor que el instalado.

**Por qué existe:** Encolar a mano un run viejo promovía ese paquete y el humo salía verde igual. Corre antes de subir nada, compara con la versión instalada en el host y sale 2 si el paquete es menor. Si no puede mirar, tampoco deja pasar. No existe forzar el retroceso.

**Quién la usa:** Los cuatro pipelines de producción.

**Dónde se prueba:** `scripts/tests/rollback-guard.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscirollback-guardsh)

## scripts/ci/smoke-plugin.sh

_(scripts/ci/smoke-plugin.sh + scripts/ci/smoke-forms.sh)_

**Qué es:** Los humos que verifican el paquete instalado en el servidor y validan todo lo que trae el paquete antes de consultar.

**Por qué existe:** El nombre, la versión o el peso que vienen en el ZIP podían alterar la URL, ejecutar comandos o dar verde sin haber verificado. Lo que no pasa la lista blanca no se consulta y el humo sale rojo; cuando un formulario falla, dice por qué.

**Quién la usa:** Los pipelines de despliegue de cada producto, que publican `scripts/ci` desde `main`.

**Dónde se prueba:** `scripts/tests/smoke.test.sh`, `scripts/tests/smoke-forms-reason.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscismoke-pluginsh)

## scripts/ci/deploy-plugin.sh

**Qué es:** El guion que despliega un plugin en su servidor: sube sin marcar, pregunta, migra, activa y recién al final marca como actual.

**Por qué existe:** Cada orden distinto dejaba producción rota con la corrida en verde. Frena si a la versión le faltan opciones de configuración, también en la re-corrida; si el servidor no puede decirlo, avisa que no pudo medir en vez de dar verde.

**Quién la usa:** Los pipelines de despliegue de cada producto, que publican `scripts/ci` desde `main`.

**Dónde se prueba:** `scripts/tests/deploy-plugin.test.sh`, `scripts/tests/deploy-plugin-config.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscideploy-pluginsh)

## scripts/ci/deploy-record.sh

**Qué es:** El ayudante que anota cada despliegue aprobado en su propia corrida, con una línea de registro y etiquetas.

**Por qué existe:** Sin esto el arnés no sabía qué llegó a cada servidor ni cuándo. Anotar nunca cambia el veredicto del humo.

**Quién la usa:** Los humos y `deploy-plugin.sh`, que lo cargan dentro de una corrida de Azure.

**Dónde se prueba:** `scripts/tests/deploy-record.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscideploy-recordsh)

## scripts/ci/check-product-parity.js

**Qué es:** Un control que compara los pipelines de los productos y dice si hacen lo mismo, leyendo lo publicado en `origin/main`.

**Por qué existe:** Comparar a mano no alcanza y ninguna revisión encontraba las diferencias. Una diferencia legítima se declara con motivo y fecha de revisión; lo que no se pudo medir nunca sale verde.

**Quién la usa:** La revisión nocturna y la suite diaria; la lista de productos vive en `scripts/ci/product-parity.json`.

**Dónde se prueba:** `scripts/tests/product-parity.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscicheck-product-parityjs)

## scripts/ci/check-trigger-without-docs.js

**Qué es:** Un control que prueba si un merge de sólo documentación dispararía build, despliegue y pedido de producción, y si el mismo pipeline sí dispara con código.

**Por qué existe:** Un cambio sin una línea de código subía la versión y pedía aprobación de producción, por rutas de `.tycon/**` en el filtro o por pipelines sin filtro de rutas.

**Quién la usa:** La suite diaria, sobre el disparador publicado de cada pipeline; los repos salen de `product-parity.json`.

**Dónde se prueba:** `scripts/tests/trigger-without-docs.test.sh`

**Detalle:** [ver](../maintaining/pieces-in-detail.md#scriptscicheck-trigger-without-docsjs)

## scripts/ci/check-tests-without-ci.js

**Qué es:** Un control que dice, repo por repo, si hay pruebas de navegador que ningún pipeline corre, y si al menos las cubre el portón del merge.

**Por qué existe:** Pruebas escritas quedaron casi un mes sin correr porque el pipeline nunca las cableó; el aviso de antes miraba el portón, no el pipeline.

**Quién la usa:** Quien escribe pruebas de navegador, a mano; los repos salen de `product-parity.json`. Avisa y no frena.

**Dónde se prueba:** `scripts/tests/tests-without-ci.test.sh`

## scripts/tests/hidden-window.test.js

**Qué es:** El control que frena todo lanzamiento de un proceso, en el código que corre en la máquina de quien desarrolla, que no pida la ventana oculta (`windowsHide`).

**Por qué existe:** En Windows, un proceso sin consola que lanza un programa de consola sin esa opción abre una ventana visible: con cientos de git por minuto, una lluvia de ventanas. Cada carpeta de `scripts/` se declara adentro o afuera, con su motivo.

**Quién la usa:** La CI del público, en cada pedido.

**Dónde se prueba:** `scripts/tests/hidden-window.test.js`, con su lector en `scripts/tests/lib/hidden-window-scan.js`
