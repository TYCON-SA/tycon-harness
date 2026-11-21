# Las historias, el portón y la publicación

Las fichas de este grupo de [las piezas del arnés](../piezas-del-arnes.md). Cada una dice **qué es** la pieza,
**por qué existe**, **quién la usa** y **dónde se prueba**. El detalle de cada pieza está en
[la guía de detalle](../maintaining/piezas-en-detalle.md), bajo el mismo título.

## scripts/tools/tycon-backfill-followups.js

**Qué es:** Script Node sin dependencias que sincroniza los back-links `followed_up_by:` de las stories padre a partir del `followup_of:` de las hijas. Tiene modo de ensayo, `--apply` y `--render-table`.

**Por qué existe:** Una story firmada puede juntar follow-ups en otra épica sin un back-link visible desde la padre.

**Quién la usa:** Quien mantiene stories; complementa al hook `tycon-story-followup-link` y a la regla del validador de stories.

**Dónde se prueba:** `scripts/tests/backfill-discovery.test.js`

**Guía:** [story-format.md](../../story-format.md)

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptstoolstycon-backfill-followupsjs)

## scripts/lib/lint-story-frontmatter.js

**Qué es:** Script Node sin dependencias que verifica que el frontmatter de cada story sea legible por el arnés, con el mismo criterio que usan las demás herramientas.

**Por qué existe:** Cuando el frontmatter no se puede leer, las herramientas saltean la story en silencio. Decide por la identidad declarada, no por el nombre del archivo.

**Quién la usa:** El `.githooks/pre-commit` de cada repo, sobre las stories del commit.

**Dónde se prueba:** `scripts/tests/lint-story-detector.test.sh`

**Guía:** [story-format.md](../../story-format.md)

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsliblint-story-frontmatterjs)

## guides/wiki-topics.md

_guides/wiki-topics.md + scripts/tools/lint-wiki.sh_

**Qué es:** Patrón de wiki por temas: un resumen vivo del repo de specs, con alineación en ambos sentidos entre story y tema, controlada por `lint-wiki.sh`.

**Por qué existe:** Mantiene el resumen del repo alineado con sus stories sin copiar el script a cada repo.

**Quién la usa:** El `.githooks/pre-commit` de los repos de specs que lo adoptan.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#guideswiki-topicsmd)

## scripts/hooks/engram-pre-commit.sh

**Qué es:** Hook `PreToolUse` que, antes de `git commit`, corre `engram sync --project <name>` y agrega `.engram/` al commit.

**Por qué existe:** Para que los chunks de memoria viajen con el commit. Sólo actúa si el repo tiene `.engram-project`, y falla abierto. En `git push` no hace nada. Cruza el índice contra sus archivos con `scripts/lib/manifest-engram.js`.

**Quién la usa:** El instalador `install-tycon-hooks.sh` lo registra; corre solo ante cada commit.

**Dónde se prueba:** sin suite propia

**Guía:** [engram-workflow.md](../integrations/engram-workflow.md)

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshooksengram-pre-commitsh)

## scripts/lib/manifest-engram.js

**Qué es:** `scripts/lib/manifest-engram.js`, el criterio único de si el índice de memoria declara todos sus archivos.

**Por qué existe:** Un archivo de memoria sin entrada en el índice no existe para las demás máquinas y no da error. Tiene un comando de reparación que rescata la entrada exacta de la historia de git.

**Quién la usa:** El hook del commit, el aviso diario y el chequeo del portón de CI.

**Dónde se prueba:** su propia suite y el caso `04-rebuild-engram.json` del banco

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibmanifest-engramjs)

## guides/ci-gate.md

_guides/ci-gate.md + scripts/ci/tycon-ci-gate.js_

**Qué es:** El portón de CI: los controles del arnés que se pueden decidir con el repo y nada más.

**Por qué existe:** Los controles locales dependen de la máquina; un commit desde la web o sin el arnés los saltea. Chequea frontmatter, evidencia de cierre y constancia de revisores.

**Quién la usa:** Los pipelines de los repos de specs y su `.githooks/pre-commit` (con `--staged`).

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#guidesci-gatemd)

## scripts/hooks/lane-llm-notice.js

**Qué es:** El aviso de arranque de los arreglos rápidos, con `--report`: cuántos hubo y cómo se firmaron.

**Por qué existe:** El arreglo rápido abre el portón sin story, y lo puede firmar la coordinadora sin preguntar. Su rastro queda en un archivo que nadie leería; este aviso lo cuenta, sólo cuando hay alguno nuevo.

**Quién la usa:** El hook de arranque y el dueño, que mira lo que firmó la coordinadora. Se apaga con `TYCON_LANE_LLM_NOTICE=0`.

**Dónde se prueba:** `scripts/tests/lane-llm-notice.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshookslane-llm-noticejs)

## guides/maintaining/controls-bench.md

_guides/maintaining/controls-bench.md + scripts/controls-bench/_

**Qué es:** El banco de pruebas de los controles del arnés, en Claude Code y en Codex.

**Por qué existe:** Un control que hay que acordarse de invocar no corre; los controles necesitan su propio control. Corre casos deterministas (`runner.js`) y disparo real (`live-fire.js`).

**Quién la usa:** Quien mantiene el arnés; el instalador lo chequea a diario y `bench-notice.js` avisa al arranque.

**Dónde se prueba:** `scripts/controls-bench/`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#guidesmaintainingcontrols-benchmd)

## build/

_build/ + adapters/_

**Qué es:** El generador de la migración a Codex: `build/generate.js` traduce los advisors canónicos a configuraciones de Codex.

**Por qué existe:** Los advisors se escriben una vez y Codex los consume traducidos. `build/equivalences.json` es la única tabla de nombres.

**Quién la usa:** El pre-commit del arnés y del repo de skills; `build/check.js` verifica la frescura y `build/check-hook-coverage.js` exige casos en el banco.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#build)

## guides/maintaining/codex-divergence-inventory.md

**Qué es:** El inventario pieza por pieza de lo que cambia entre Claude Code y Codex: hooks, advisors, pasos, servidores MCP, guías y skills.

**Por qué existe:** Clasifica cada pieza como envoltorio, nombre o inexistente, para que ninguna asimetría exista sin estar escrita.

**Quién la usa:** Quien porta una pieza a Codex, antes de portarla.

**Dónde se prueba:** sin suite propia

**Guía:** [codex-divergence-inventory.md](../maintaining/codex-divergence-inventory.md)

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#guidesmaintainingcodex-divergence-inventorymd)

## scripts/publishing/detector.js

_scripts/publishing/_

**Qué es:** El detector de lo que no puede salir en una publicación de código abierto: términos de la lista de denegación privada y patrones genéricos como credenciales, rutas de máquina y emails reales.

**Por qué existe:** Revisarlo a ojo antes de cada publicación no escala. Sale 0 limpio, 1 con hallazgos, 2 si no pudo mirar.

**Quién la usa:** El exportador, la CI del repo público y los frenos de publicación.

**Dónde se prueba:** `scripts/tests/publishing-detector.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptspublishingdetectorjs)

## scripts/publishing/third-party-skills.json

_scripts/publishing/ + guides/maintaining/publicacion-espejo.md_

**Qué es:** El manifiesto `third-party-skills.json` de las skills de terceros: de quién es cada carpeta y, para lo ajeno, repo de origen, commit y hash de árbol.

**Por qué existe:** Lo ajeno se referencia y no se copia, porque la copia pública no puede llevarlo (algunas tienen licencia propietaria) y cada máquina debe tener el mismo contenido.

**Quién la usa:** `third-party-coverage.js`, `install-third-party.js` (dentro de `install-tycon-hooks.sh`) y `pipeline.js tooling-expected`.

**Dónde se prueba:** `third-party-skills.test.js`, `install-third-party.test.sh`, `third-party-real.test.sh` y `third-party-origin.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptspublishingthird-party-skillsjson)

## scripts/publishing/export.js

_scripts/publishing/ + guides/maintaining/publicacion-espejo.md_

**Qué es:** El exportador de la copia pública: arma en una carpeta local una copia sin nombres reales, a partir de los objetos de git. No publica.

**Por qué existe:** Los repos internos siguen siendo la fuente y la historia no se puede publicar. Copia sólo lo que cubre `allowlist.json` y reemplaza nombres reales por anónimos según `replacements.json`.

**Quién la usa:** `mirror.js` y la CI del repo público.

**Dónde se prueba:** `scripts/tests/export.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptspublishingexportjs)

## scripts/publishing/mirror.js

_scripts/publishing/ + guides/maintaining/publicacion-espejo.md_

**Qué es:** `mirror.js` lleva la copia del exportador al repo público de GitHub por un solo camino, con los subcomandos `plan`, `first`, `sync` y `verify`.

**Por qué existe:** Evita pushes a mano y nombres que se cuelen. El nombre del repo público sale de `public-repos.json`; el token, de `TYCON_MIRROR_TOKEN`.

**Quién la usa:** El pipeline de publicación, con su token emitido por `scripts/publishing/github-app-token.js`.

**Dónde se prueba:** `scripts/tests/mirror.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptspublishingmirrorjs)

## pipelines/azure-pipelines-public-leak-check.yml

_pipelines/azure-pipelines-public-leak-check.yml + scripts/tests/mirror-pipeline.test.sh + scripts/ci/verify-notice.js + guides/maintaining/publicacion-espejo.md_

**Qué es:** El pipeline que corre `mirror.js`, en dos etapas: una decide y otra publica o verifica.

**Por qué existe:** Nadie publica desde su máquina ni tiene la credencial. La etapa que usa la llave sólo arranca si la primera lo autoriza.

**Quién la usa:** Cada merge a `main`, la corrida diaria y quien lo encola a mano. `scripts/ci/verify-notice.js` arma el aviso por Telegram.

**Dónde se prueba:** `scripts/tests/mirror-pipeline.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#pipelinesazure-pipelines-public-leak-checkyml)

## scripts/hooks/public-push-guard.js

_scripts/hooks/public-push-guard.js + scripts/hooks/git-pre-push-global.sh + .githooks/pre-push + integrations/github/scripts/command-reader.js + scripts/ci/pr-texts.js + guides/maintaining/publicacion-espejo.md_

**Qué es:** El freno antes de publicar: un `pre-push` de git y un freno de `gh` que revisan lo que va a un remoto público.

**Por qué existe:** Con el arnés escrito directo en el repo público, una rama empujada ya es pública y no hay exportador en el medio.

**Quién la usa:** Git en cada empuje (hook global), el freno de `gh` y la validación de cada pedido, en modo `range`.

**Dónde se prueba:** `scripts/tests/public-push-guard.test.js`, `scripts/tests/githook-pre-push.test.sh` y `scripts/tests/gh-pr.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptshookspublic-push-guardjs)

## scripts/tools/merge-pr.js

_scripts/tools/merge-pr.js + scripts/tests/merge-pr.test.js + skills/tycon-merge-to-main/steps/step-09b-create-change-request.md + scripts/setup/harness/version-order.js_

**Qué es:** Herramienta con seis órdenes (`plan`, `update-branch`, `bump-version`, `wait-checks`, `message`, `check-version`) que el skill de merge usa cuando el repo vive en GitHub. No crea ni mergea el pedido.

**Por qué existe:** En GitHub el servidor no completa solo un pedido y el número de versión lo pone el merge. Además dice dónde corren las suites completas, según `merge_suites` en `team-repos.json`.

**Quién la usa:** El skill `tycon-merge-to-main`.

**Dónde se prueba:** `scripts/tests/merge-pr.test.js` y `scripts/tests/team-repos.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptstoolsmerge-prjs)

## scripts/ci/version-tag.js

_scripts/ci/version-tag.js + .github/workflows/version-tag.yml + scripts/setup/harness/version-order.js + scripts/tests/version-by-merge.test.js_

**Qué es:** `version-tag.js tag` pone la etiqueta `v<número>` en la punta de `main` cuando entra un merge.

**Por qué existe:** El número de versión lo pone el merge y no cada pedido: así dos pedidos en paralelo nunca toman el mismo número.

**Quién la usa:** El workflow `version-tag.yml`; las máquinas instaladas leen la etiqueta al buscar novedades.

**Dónde se prueba:** `scripts/tests/version-by-merge.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsciversion-tagjs)

## scripts/setup/npm/index.js

_scripts/setup/npm/index.js + home-paths.json + package.json + README.md_

**Qué es:** El instalador del paquete de npm `@tyconsa/harness` (binario `tycon-harness`), que corre con `npx`.

**Por qué existe:** Da una sola línea de instalación igual en Windows, Mac y Linux. El paquete no trae el arnés: lo baja de GitHub y termina en `harness.js install`.

**Quién la usa:** Quien prueba el arnés desde otra organización.

**Dónde se prueba:** `scripts/tests/npx-installer.test.sh` y `scripts/tests/npm-package.test.js`

**Guía:** [paquete-npm.md](../maintaining/paquete-npm.md)

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptssetupnpmindexjs)

## .github/workflows/npm-publish.yml

_.github/workflows/npm-publish.yml + scripts/ci/check-public-workflow.js `--publisher` + scripts/tests/npm-publish-workflow.test.js_

**Qué es:** Workflow que publica el paquete del instalador desde la CI pública, sin token guardado, con la constancia de procedencia de npm.

**Por qué existe:** Evita guardar credenciales. Publica en etapas: la versión espera la aprobación de una persona con 2FA. Se habilita con la variable `NPM_PUBLISH_ENABLED`.

**Quién la usa:** La CI pública, en cada push a `main` que toca `scripts/setup/npm/**` o a mano.

**Dónde se prueba:** `scripts/tests/npm-publish-workflow.test.js`

**Guía:** [guides/maintaining/paquete-npm.md](../maintaining/paquete-npm.md)

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#githubworkflowsnpm-publishyml)

## scripts/ci/npm-package-version.js

_scripts/ci/npm-package-version.js + el paso `version` de scripts/ci/public-ci.sh_

**Qué es:** Regla que exige subir la versión semver del paquete de npm cuando un pedido toca `scripts/setup/npm/`.

**Por qué existe:** npm rechaza republicar una versión, y conviene enterarse en el pedido y no después del merge.

**Quién la usa:** El paso `version` de la CI pública.

**Dónde se prueba:** `scripts/tests/npm-package.test.js` y `scripts/tests/public-ci.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptscinpm-package-versionjs)

## scripts/setup/harness/team-init.js

_scripts/setup/harness/team-init.js + el comando `harness.js team-init` + getting-started/reference.md_

**Qué es:** El alta guiada de una organización: arma el repo del perfil del equipo con `team-layer.json`, `team-profile.json` y `team-repos.json`.

**Por qué existe:** Copiar el ejemplo a mano es fácil de romper y el error aparece recién al instalar con `--team`. Valida con los mismos lectores que apilan la capa y no escribe nada si algo falla.

**Quién la usa:** Quien da de alta una organización.

**Dónde se prueba:** `scripts/tests/harness-team-init.test.sh` y `scripts/tests/team-stories-templates.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptssetupharnessteam-initjs)

## scripts/setup/harness/team-local.js

_scripts/setup/harness/team-local.js + `harness.js team-init --local` + `--team <carpeta>`_

**Qué es:** La capa del equipo leída de un repo git de la máquina: el perfil de una persona que trabaja sola, sin cuenta ni repo remoto.

**Por qué existe:** Los revisores propios de un dev solo quedaban en la instalación y la actualización los borraba. Su lugar es el repo del perfil. Se lee como un repo remoto: sólo lo commiteado en `main`, con la misma lista cerrada y validación, sin ejecutar nada del repo.

**Quién la usa:** El instalador y la actualización, cuando el perfil es una carpeta.

**Dónde se prueba:** `scripts/tests/harness-team-local.test.js` y `scripts/tests/harness-team-init.test.sh` (T46 a T48)

## scripts/publishing/new-names.js

_scripts/publishing/ + guides/maintaining/publicacion-espejo.md_

**Qué es:** El freno de nombres reales nuevos en lo que se publica.

**Por qué existe:** Un commit que mete un nombre de cliente, persona, servidor o máquina en un archivo público no se crea. Mira lo neto por archivo, para no frenar retoques. Se apaga con `TYCON_NEW_NAMES=0`.

**Quién la usa:** El pre-commit del arnés y de agent-skills, y el diff de cada pedido. Qué sale lo decide el exportador.

**Dónde se prueba:** `scripts/tests/new-names.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptspublishingnew-namesjs)

## scripts/lib/legacy-names.js

_scripts/lib/legacy-names.js/.sh/.ps1 + scripts/lib/renames.json + guides/maintaining/nombres-en-ingles.md_

**Qué es:** Biblioteca que hace que un nombre viejo siga andando mientras dura el renombre a inglés, según el mapa `renames.json`.

**Por qué existe:** Renombrar sin romper a nadie: variables, opciones, archivos y claves viejos hacen lo mismo que los nuevos hasta `retire_after`.

**Quién la usa:** Los guiones renombrados y el instalador, que reescribe las rutas viejas de la máquina con `--migrate-machine`.

**Dónde se prueba:** `scripts/tests/legacy-names.test.js` y `scripts/tests/legacy-names-install.test.sh`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptsliblegacy-namesjs)

## scripts/ci/legacy-options.sh y legacy-options.js

_scripts/ci/legacy-options.sh/.js + guides/maintaining/nombres-en-ingles.md_

**Qué es:** Traductor que pasa las opciones viejas de los pipelines de producto a las nuevas en los guiones de `scripts/ci`.

**Por qué existe:** Las opciones viejas siguen andando hasta el retiro, también desde el artefacto `arnes-ci`, que no lleva la biblioteca general.

**Quién la usa:** Los guiones de `scripts/ci` llamados por los pipelines de los productos.

**Dónde se prueba:** sin suite propia

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptscilegacy-optionssh-y-legacy-optionsjs)

## scripts/publishing/spanish-names.js

_scripts/publishing/ + scripts/lib/spanish-words.json + guides/maintaining/nombres-en-ingles.md_

**Qué es:** El freno de nombres nuevos en castellano en lo que ejecuta la máquina: rutas, opciones, subcomandos, variables y claves.

**Por qué existe:** Alguien de afuera tiene que poder usar el núcleo sin leer castellano. Un nombre castellano que ya existía pasa y se renombra por tandas. Se apaga con `TYCON_SPANISH_NAMES=0`.

**Quién la usa:** El pre-commit del arnés y de agent-skills, y el diff de cada pedido.

**Dónde se prueba:** `scripts/tests/spanish-names.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptspublishingspanish-namesjs)

## scripts/publishing/internal-history.js

_scripts/publishing/internal-history.js + internal-history.json + guides/maintaining/publicacion-espejo.md_

**Qué es:** El control de historia interna en la prosa que se publica, y en los comentarios con `--zone comment`.

**Por qué existe:** Un número de story, un código de tanda o un caso con su enlace no llevan a nada desde afuera. Al escribir directo en el repo público, lo escrito es lo que sale.

**Quién la usa:** El pre-commit y el diff de cada pedido de cambio.

**Dónde se prueba:** `scripts/tests/internal-history-guard.test.js` y `scripts/tests/code-comments.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptspublishinginternal-historyjs)

## scripts/lib/estimates.js

**Qué es:** El registro de estimaciones de cada repo: sólo crece y vale el último renglón.

**Por qué existe:** Sin él, el error de una estimación no se mide.

**Quién la usa:** `tycon-create-story`, el pipeline, el sitio y el pedido.

**Dónde se prueba:** `scripts/tests/estimates.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibestimatesjs)

## scripts/lib/similar-stories.js

**Qué es:** Historias cerradas parecidas a una nueva, con sus horas reales.

**Por qué existe:** Dan con qué comparar al estimar; sin horas medidas, nada.

**Quién la usa:** `tycon-create-story`.

**Dónde se prueba:** `scripts/tests/similar-stories.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#scriptslibsimilar-storiesjs)

## skills/tycon-pipeline/scripts/lib/real-hours.js

**Qué es:** Las horas reales de una historia, según el reloj.

**Por qué existe:** El error se mide contra horas registradas, nunca adivinadas.

**Quién la usa:** `pipeline.js estimate-real`.

**Dónde se prueba:** `skills/tycon-pipeline/scripts/tests/estimate-real.test.js`

**Detalle:** [ver](../maintaining/piezas-en-detalle.md#skillstycon-pipelinescriptslibreal-hoursjs)
