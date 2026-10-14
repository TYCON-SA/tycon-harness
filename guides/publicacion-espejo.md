# Publicación con espejo: el exportador

> Script: `scripts/publishing/export.js`. Pruebas: `scripts/tests/export.test.js` (repos y configuraciones de mentira)
> y, en el repo del equipo, la prueba contra los repos reales (§«La prueba de verdad»).

## Qué es y qué no es

El arnés se publica con **espejo**: los repos internos —el arnés
y `agent-skills`— siguen siendo la fuente, con su memoria institucional y sus casos nominados, y **lo público es una
copia que se arma cada vez**. El exportador arma esa copia para un paquete (`nucleo` o `bizuit`) y la deja en una
carpeta local. **No publica nada**: no tiene remoto, no llama a ningún servicio y no toca los repos internos. Publicar
es otro paso (§«La publicación»); el equipo sigue trabajando con los internos y nada del arnés lee la copia. Los dos
internos son **un solo repo**, que el exportador lee como dos fuentes partidas por ruta: donde esta guía dice «los dos
repos» o «cada repo», vale para las dos fuentes (§«Un solo repo interno»).

## Cómo se corre

```bash
# la copia del núcleo, desde origin/main de los dos repos (la salida NO puede existir)
node scripts/publishing/export.js --package core --output /tmp/copia-nucleo
# con el resultado entero en JSON, desde otros commits
node scripts/publishing/export.js --package bizuit --output /tmp/copia-bizuit --harness <ref> --agent-skills <ref> --json
# el primer nivel de cada repo clasificado, las exclusiones fijas y las transformaciones (no escribe nada)
node scripts/publishing/export.js --explain
```

- Los repos se ubican como en el resto del arnés: `TYCON_GUIDES_DIR` (o el clon donde vive el script) y
  `TYCON_SKILLS_DIR` (o `~/.claude/agent-skills`). Si el commit del arnés es del repo único, hay una
  fuente física y un solo commit: el otro clon no se busca, y `--agent-skills` distinto de `--harness` sale 2
  (§«Un solo repo interno»).
- Las tres configuraciones son, por defecto, las de `scripts/publishing/`: `allowlist.json` (pública),
  `replacements.json` y `denylist.json` (**privadas**). Las pruebas pasan unas sintéticas con `--allowlist`,
  `--replacements` y `--denied`.
- **Salida**: `0` copia lista en `--output` (un repo git por fuente, `arnes/` y `agent-skills/`, con UN commit cada
  uno) · `1` hallazgos: la copia se descarta y `--output` no se crea; el informe va a la salida estándar · `2` no pudo
  armarla o mirarla (una configuración rota, una referencia que no es un commit, un repo que no está, un paquete
  desconocido o el privado `clientes`, un glob de «in» muerto, una entrada del primer nivel sin clasificar, una
  exclusión fija que ya no coincide con nada…). «No pude mirar» nunca es «limpio».
- Al lado de la salida queda el **listado de reemplazos**, `<salida>.reemplazos.md` (o `--report`). Es PRIVADO: nombra a
  los reales. Nunca queda adentro de la copia; se escribe ANTES de renombrar la copia a `--output` (si no se puede
  escribir, no hay copia: el renombre es el único punto sin retorno); un `--report` que apunta a un archivo que no es un
  listado del exportador, o a una carpeta, es un 2 y no se pisa; y si una corrida sale 2 se borra el listado viejo de esa
  ruta (sólo si es un listado del exportador; si frena antes de ubicar los repos fuente y el listado cae dentro de un repo
  de git, no lo toca y avisa).
- Un valor vacío (`--harness ""`) es un error, no «el default».

## Qué entra: la lista blanca

`allowlist.json` dice, por paquete y por fuente, los globs que **entran** (`in`) y los que quedan **afuera** (`out`, cada uno
con su motivo en `reason`; `until` = la story que lo trae). Los globs son los del detector: `**` cruza carpetas, `*` y `?` no. Lo que no
cubre ningún «in» no sale: es una lista blanca.

Para que nada quede afuera ni adentro en silencio, **toda entrada del primer nivel de cada repo tiene que estar
clasificada**: la toma un «in» de algún paquete, o la cubre entera un «out» o una exclusión fija. Un archivo o
una carpeta nueva en la raíz hace salir 2 hasta que alguien decida. La tabla viva la imprime `--explain`; ésta la
compara con su salida la prueba `scripts/tests/publishing-guide-tables.test.js`, así que no se desactualiza en silencio.
En «Decisión», la primera palabra es la regla que manda sobre la entrada, y los globs de adentro son lo que entra o
queda afuera dentro de ella:

| Repo | Entrada | Decisión |
|---|---|---|
| arnes | `.advisors/` `.dashboard/` `.engram/` `_bmad/` `inbox/` _(del repo del equipo; no está en esta copia)_ `qa/` `specs/` `tasks/` | fija (ver abajo) |
| arnes | `pipelines/` | entra (núcleo): `pipelines/azure-pipelines-pr.yml` `pipelines/templates/correr-suites.yml` `pipelines/templates/fetch-snapshot.yml` `pipelines/templates/traer-repos.yml` (la validación de cada pedido y sus plantillas: después del corte viven en el repo público); el resto de la carpeta, fija (ver abajo) |
| arnes | `perfil-equipo.json` _(del repo del equipo; no está en esta copia)_ | fija (ver abajo) |
| arnes | `README.md` `INSTALL.md` `story-format.md` `engram-version` `.gitignore` `.gitattributes` `.githooks/` `adapters/` `build/` `claude-md-blocks/` `commands/` | entra (núcleo) |
| arnes | `scripts/` | entra (núcleo), menos `scripts/tools/harness-map/*.json` _(del repo del equipo; no está en esta copia)_ (las exclusiones del mapa y la configuración de su versión pública: datos del mapa interno, que queda afuera; el código de la carpeta sí sale) `scripts/tests/fixtures/legacy-names-d1/` _(del repo del equipo; no está en esta copia)_ (nombra a propósito los nombres viejos), `scripts/tests/fixtures/legacy-names-f/` _(del repo del equipo; no está en esta copia)_ (la clasificación de los nombres viejos: su prueba se saltea sin el mapa del equipo), `scripts/publishing/public-files/` _(del repo del equipo; no está en esta copia)_ (los papeles: llegan a su destino por un sintético), `scripts/publishing/public-repos.json` _(del repo del equipo; no está en esta copia)_ (lo leen el exportador, la sincronización y el reconocedor de repos del arnés, en el interno), `scripts/publishing/split.json` _(del repo del equipo; no está en esta copia)_ y `scripts/publishing/split.js` _(del repo del equipo; no está en esta copia)_ (el reparto del corte a GitHub: nombra las carpetas privadas y corre una vez, en el interno), `scripts/publishing/team-repo.js` _(del repo del equipo; no está en esta copia)_ y `scripts/publishing/team-layer.json` _(del repo del equipo; no está en esta copia)_ (publican la capa del equipo al repo privado del equipo: los corre el dueño), `scripts/ci/overlay-harness.js` _(del repo del equipo; no está en esta copia)_ (pone la copia de GitHub encima del checkout de Azure en los nocturnos del equipo, que quedan afuera, y usa el reparto), `scripts/controls-bench/evidence/` _(del repo del equipo; no está en esta copia)_ (salida cruda de corridas reales; las conclusiones están en las guías) `scripts/tests/fixtures/product-pipeline/` _(del repo del equipo; no está en esta copia)_ (los pipelines de un producto del equipo; sólo los usa una prueba que no viaja) y `scripts/nightly/dashboard/declared.json` (datos operativos del equipo: la copia lleva un sintético) |
| arnes | `guides/` | entra (núcleo), menos `guides/bizuit/*.md` (van al paquete bizuit, las cuatro), `guides/decisions/vuelta-atras-2026-08-31.md` _(del repo del equipo; no está en esta copia)_ (inventario de riesgo de la producción de un cliente) y `guides/decisions/revision-adversarial-engram-2026-08-25-codex.md` _(del repo del equipo; no está en esta copia)_ (fechado, y nada de lo que sale lo nombra) |
| arnes | `.engram-project` | afuera: prende la memoria del equipo; sin él, apagada es el default documentado |
| arnes | `.tycon/` | afuera: la configuración del equipo para este repo (revisores, portones, servidores de producción) |
| arnes | `artifacts/` _(del repo del equipo; no está en esta copia)_ `onboarding/` _(del repo del equipo; no está en esta copia)_ | afuera: páginas, charlas y onboarding del equipo |
| arnes | `new-product-templates/` _(del repo del equipo; no está en esta copia)_ | afuera: la copia vieja de las plantillas del alta de un producto, que se borra del repo del equipo; las que viajan están en `packs/bizuit/new-product-templates/` |
| agent-skills | `.githooks/` | entra (núcleo) |
| agent-skills | `agents/` | entra: `agents/*.md` en el núcleo; los tres revisores de Bizuit (`agents/tycon-plugin-*-conventions.md`) en su paquete |
| agent-skills | `skills/` | entra: en el núcleo `skills/tycon-*/`, `skills/check-story-drift/`, `skills/clocki/` y `skills/tycon-create-story/`; en bizuit `skills/{bizuit-backend-plugin-system,bizuit-custom-forms-system,bizuit-sdk-integration,safe-query-builder,esbuild-bundling,feature-based-crud-endpoints,dotnet-dapper-sqlserver,bizuit-new-product}/` (las tres últimas desde el 2026-10-05: las guías de Bizuit que salen las citan). Afuera: `skills/bizuit-sdd/` _(del repo del equipo; no está en esta copia)_ (deprecada, no se publica), `skills/core/signalr-realtime/` _(del repo del equipo; no está en esta copia)_ (describe el producto de un cliente; sólo serviría reescrita), `skills/tycon-alta-de-producto/` _(del repo del equipo; no está en esta copia)_ (infraestructura del equipo y las plantillas que quedan afuera) y `skills/tycon-pipeline/HISTORIA.md` _(del repo del equipo; no está en esta copia)_ (la historia de la skill, con casos del equipo) |
| agent-skills | `packs/` | afuera en el núcleo · entra en bizuit `packs/bizuit/pack.json` y `packs/bizuit/new-product-templates/` (las plantillas del alta de un producto); el de clientes no sale nunca |
| agent-skills | `.tycon/` | afuera: la configuración del equipo para este repo |

«Repo» es la fuente: las dos son partes de un mismo repo, partido por ruta (§«Un solo repo
interno»). Por eso agent-skills ya no trae un `.gitignore` ni un `README.md` propios —el del repo es el de la fila del
arnés—, y de `.githooks/` y `.tycon/` le toca un archivo de cada una: `pre-commit-skills` y `post-commit-ignore`.

`skills/tycon-create-story` sale: es de BMAD (MIT), modificada por el equipo, y viaja con su `LICENSE`
original y un `NOTICE.md` de lo que cambió (la licencia del espejo es Apache-2.0). La copia la publica
renombrada (§«Lo que se renombra o se poda en la copia»). La skill de SDD de Bizuit está deprecada y no
se publica (sus dos suites se van con ella). Las
skills de terceros no figuran: agent-skills no las versiona (§«Las skills de terceros»).

## Exclusiones fijas

Viven en el código (`EXCLUIDOS_SIEMPRE`), por repo y con su motivo, y **nunca salen, cubra lo que cubra «in»**: un
`**` o un `scripts/**` no es error, se filtran y se cuentan (`excluidosFijos`). Dos reglas las protegen:

- Una entrada de «in» que **nombra** una exclusión fija (el perfil del equipo, `tasks/x/**`) es un error de la lista.
- Una exclusión fija que cae bajo un glob de «in» en uso **tiene que coincidir con algún archivo** del commit. Si no,
  sale 2 con «exclusión fija sin archivo: … — ¿se renombró?»: así un renombre no publica en
  silencio lo que antes quedaba afuera. Las de «clase» (lo privado de la publicación en agent-skills, que hoy no tiene
  ninguno; el mapa de renombres, que el retiro borra; y las de nombre viejo) no piden archivo. Lo mismo vale para cada «out» de la lista y cada `afuera` privado que cae bajo un glob de «in»:
  sin archivo, «afuera sin archivo: … — ¿se renombró?».
- Un glob con `**` pegado a un nombre (`scripts/**.json`) es un 2: el detector lo lee como «cualquier cosa, cruzando
  carpetas» y la cuenta de qué exclusión cae bajo qué «in» no, así que dirían cosas distintas. Se escribe
  `scripts/**/*.json`. Tampoco se aceptan rutas absolutas ni segmentos `..`.

| Repo | Nunca sale | Por qué |
|---|---|---|
| arnes | `.engram/` `.dashboard/` `.advisors/` `inbox/` _(del repo del equipo; no está en esta copia)_ `tasks/` `specs/` `qa/` `_bmad/` | memoria, series, evidencia, hallazgos y planes del equipo |
| arnes | `guides/incident-log.md` `guides/guide-update-proposals.md` _(del repo del equipo; no está en esta copia)_ `guides/decisions/telemetria-produccion-inventario-*.md` | casos nominados, propuestas internas, inventario de producción |
| arnes | `scripts/metrics/censo-*.json` `scripts/ci/product-parity.json` `scripts/ci/pipeline-debt.json` `scripts/metrics/corridas-buzon.json` _(del repo del equipo; no está en esta copia)_ | censos, productos y deuda por repo de cliente, la llave del buzón |
| arnes | `team-profile.json` _(del repo del equipo; no está en esta copia)_ `perfil-equipo.json` _(del repo del equipo; no está en esta copia)_ (de «clase»: el clon tiene uno de los dos, o los dos en la transición) | el perfil del equipo, con su nombre de hoy y el de antes, que sigue valiendo |
| arnes | `pipelines/**` | los pipelines del equipo (los nocturnos, el de pull request y sus pedazos compartidos) |
| arnes | `scripts/nightly/dependencies/` _(del repo del equipo; no está en esta copia)_ `scripts/nightly/watcher/` _(del repo del equipo; no está en esta copia)_ `commands/tycon-vigilante.md` _(del repo del equipo; no está en esta copia)_ `scripts/controls-bench/ultimo-*.json` | operación interna y resultados del equipo |
| arnes | `**/denylist*.json` `**/replacements*.json` | lo privado de la publicación: la lista de denegación y la tabla de reemplazos |
| arnes | `scripts/lib/renames.json` _(del repo del equipo; no está en esta copia)_ (de «clase»: el retiro lo borra) | el mapa de renombres a inglés: los nombres viejos no viajan |
| agent-skills | `skills/projects/` _(del repo del equipo; no está en esta copia)_ `skills/infrastructure/` _(del repo del equipo; no está en esta copia)_ | skills de proyectos de clientes y de la infraestructura de la empresa |
| agent-skills | `**/denylist*.json` `**/replacements*.json` (de «clase»: agent-skills hoy no tiene ninguno) | lo privado de la publicación, por si algún día aparece |
| los dos | los archivos privados de la publicación con su nombre viejo (de «clase») | el exportador las arma en cada corrida desde el mapa de renombres, así que esta tabla no las enumera: nombrarlas sería escribir las rutas viejas en una guía que viaja |

## Transformaciones con nombre

Lo que describe algo que no viaja se adapta por transformaciones deterministas, con nombre, y cada ajuste queda en el
listado de la corrida:

| Transformación | Qué hace |
|---|---|
| `revisores-de-paquete` | Un revisor de paquete sale entero o no sale. En el núcleo no va ninguna superficie de un revisor que declare un `packs/*/pack.json` del commit (su `.md`, sus traducciones a Codex, su caso del banco). En la unión `core,bizuit` sale entero; en `bizuit` solo va el `.md` y lo demás queda en `pendientes` con `hasta: "core,bizuit"`. |
| `manifiesto-codex` · `linea-base-banco` · `catalogo-de-reglas` | Los archivos que mezclan revisores pierden la entrada, las entradas `<revisor>::*` o la sección de los que no salen, con el orden y el formato del resto. |
| `suites-json` · `suites-y-casos-fuera` | La entrada de `scripts/tests/suites.json` de toda suite cuyo archivo no sale se va con él. Las que salen como archivo pero no andarían afuera se declaran en `suitesOutside` / `casesOutside` (con motivo) y salen juntas, suite y entrada. |
| `suite-parts-json` | La entrada de `scripts/tests/suite-parts.json` (el registro de las suites partidas) de toda suite que no viaja se va con ella; el resto del archivo queda igual. Sin esto, dentro de la copia la suite figuraba «partida» sin estar y dos suites daban rojo (medido). |
| `vaciar` | Una clave declarada en `empty` queda vacía y el resto del archivo igual; una ruta con puntos (`reducer.expected_machines`) llega a una clave anidada, y una que no existe sale 2 (hoy: la máquina designada del examen de revisores y las máquinas esperadas del tablero). |
| `sinteticos` | El archivo de la copia es el sintético declarado en `synthetic` (entre otros: `scripts/ci/pipeline-debt.json`, que `pipeline-debt.test.js` necesita; `scripts/nightly/dashboard/declared.json`, con una declaración de ejemplo sin fecha de revisión, que el tablero muestra como «no medido»; y `scripts/ci/product-parity.json`, que dice a propósito `sin_productos`: los dos controles de paridad salen 0 diciendo que no compararon nada, y sin esa marca siguen saliendo 2). |
| `public-texts` | En un archivo de código, el texto **exacto** declarado en `publicTexts` (puede ocupar varios renglones) pasa a su versión pública, las veces declaradas; si no aparece esas veces, sale 2. Es para los mensajes que en el repo del equipo diagnostican una integración del equipo (la llave del buzón de corridas, el guion nocturno de dependencias, la lista de repos de producto; el bloque del mapa del pre-commit no: lo prueba una suite que viaja y, sin el generador, sólo avisa) y en la copia mandarían a una pieza que no viaja. Los bloques internos no sirven acá: sólo existen en los `.md`. |
| `gitignore-publico` | Se quitan las líneas `!…` que re-incluyen algo de una exclusión fija: adentro hacen viajar la evidencia y la serie del medidor; afuera sólo dejarían sin ignorar lo que escribe la máquina de quien instaló. Con `--single-repo`, además, el `.gitignore` de la copia gana al final una línea `/<carpeta>/` por cada carpeta de primer nivel del repo fuente en la que la copia no trae ningún archivo: en el repo que nace de la copia, lo que dejan ahí las herramientas de quien lo mantiene no entra con un `git add`. Se mira la copia ya armada, no una lista aparte: una carpeta de la que sale una parte, o que la copia sólo recibe por un papel, no entra. El nombre de esas carpetas pasa a un archivo que se publica: lo miran el detector y el control de nombres pegados, y uno que no puede salir frena la copia. También la frenan una carpeta que sólo difiere en mayúsculas de una que la copia trae (en un disco que no distingue la caja, ignorar una ignora la otra) y una con un salto de línea en el nombre. |
| `nombres-viejos` | El reemplazo de cada ruta vieja de archivo o carpeta ya movida del mapa de renombres no sale: la copia nace con los nombres nuevos, y `legacy-names.*`, que sí viaja, sin el mapa es paso directo. Una entrada todavía no movida (su nuevo no está en el árbol) no cuenta: su archivo es el real y sale. |
| `traducciones-codex` | Los `.toml` de `adapters/codex/agents*/` no se reemplazan: se **regeneran** con el `build/generate.js` de la copia desde los `.md` ya reemplazados, y `--check` tiene que dar 0. |
| `skill-rename` | Una skill de `skillRenames` sale con otro nombre: su carpeta, su `name:` y el identificador en los archivos de texto que salen, con su lista cerrada de excepciones. |
| `public-third-party` | El manifiesto de terceros de la copia deja sólo las que el arnés usa o que traen `publish: true`, con licencia MIT o Apache-2.0. |
| `internal-blocks` | Sale el texto de los bloques internos de los `.md` y se ve el de los sólo-públicos. |
| `not-in-copy` | En un `.md` que sale, una ruta entre comillas invertidas que existe en el repo del equipo y no en la copia queda tal cual y lleva al lado una marca corta: «_(del repo del equipo; no está en esta copia)_» (§«Las rutas que no viajan»). |
| `public-name` | `{{public-org}}` y `{{public-repo}}` de un papel, con los valores de `public-repos.json`. |
| `merged-gitignore` · `merged-hooks` | Con `--single-repo`: los dos `.gitignore` en uno, y los dos `pre-commit` detrás de un despachador que corre los dos. Con una sola fuente física no hacen nada: el repo ya los trae juntos. |
| `generated` | Un archivo declarado en `generated` no sale de ninguna fuente: lo arma el exportador. Hoy es `version.json`, y sólo con `--stamp-version` (§«El repo único»). |

Los JSON se editan en su lugar, sin re-serializarlos: los arreglos en una línea y las sangrías quedan como estaban.

## Los reemplazos

`replacements.json` (privada) tiene un par por real: su categoría (la de `denylist.json`), sus **formas** —cada grafía con
su propio anónimo y la misma caja, `AcmeCorp`→`ClienteA`, `ACME`→`CLIENTEA`, `acmecorp`→`clientea`, así un identificador,
una clave o una variable siguen andando— y, opcional, `anonimoProsa` («Cliente A»), que se aplica sólo en `.md` a la forma
cuyo texto es el real. Un anónimo con espacio rompía código (medido: 3 `.js` y dos suites). Los pares se aplican de a
uno y en orden; `palabra` usa el mismo borde que el detector, y `mayusculas` significa lo mismo que allá: sin
`mayusculas: true` el real no distingue caja, así que después de las formas exactas lo que quede con OTRA caja
(`GLOBEX` cuando sólo se declaró `Globex`) toma el anónimo de su forma con la caja de lo encontrado (`CLIENTEB`).
**Otra caja, dentro de un identificador**: un real con `palabra` y `mayusculas`
—un nombre corto que en minúscula es una palabra común— también se reemplaza en OTRA caja cuando está dentro de un
identificador: pegado a `-`, `_`, `/`, `\`, `@` o `.` por algún lado (la barra invertida, por una ruta de
Windows; la arroba, por la parte local de un email), después de un `=`, o solo entre dos comillas iguales
(`repos/backend-acme` → `repos/backend-beta`, `'acme'` → `'beta'`), con el anónimo en la caja de lo encontrado; y
escrito entero en mayúsculas como palabra, también. En prosa la palabra común queda como está. Un cliente de varias
partes (`AcmeCorp`) se reemplaza también separado (`acme-corp`, «Acme Corp»). Lo pegado a letras en otra caja no lo
alcanza ninguna regla general —en minúscula la palabra suelta es común—: se declara como forma. El detector mira
exactamente las mismas variantes, con las mismas funciones (`regexOtraCaja`, `regexMayusculas`, `regexPartes` de
`detector.js`): lo que ve es lo que la tabla no alcanzó. Medido: sin esto, la copia real salía con el
detector en cero y unas 590 menciones de clientes dentro de identificadores.

El `--json` nombra a cada par por su número en la tabla (`par-1`…), nunca por el real: la salida estándar no es un canal
privado. Si la tabla es inválida (dos reales con el mismo anónimo —contando también lo que la tabla PRODUCE: la caja de
lo encontrado, las variantes de arriba y el reemplazo en cadena, cuando un par posterior reescribe el anónimo de uno
anterior—,
una marca —TYCON o Bizuit— como palabra suelta, un anónimo que agrega espacios o signos fuera de `.md`, una categoría
inventada, una forma sin anónimo), sale 2 antes de escribir nada. Un anónimo puede llevar un espacio, una comilla o un
paréntesis sólo si su forma los tiene en el mismo orden: `org: 'x'` → `org: 'y'` conserva la
forma y no rompe nada; `AcmeCorp` → `Cliente A` agrega un espacio donde no había y sigue rechazado. Texto o binario se
decide con la regla del detector (un byte nulo en los primeros 8000), nunca por extensión: un binario se copia tal cual
y el detector decide.

### La tabla real

Se armó con los términos de `denylist.json` y de las auditorías internas,
los autores humanos del historial de los dos repos (nombre, parte local del correo, forma corta), los nombres que las
suites ya tratan como personales (C-11 de `dashboard.test.sh`) y los usuarios de cada línea donde el detector marcó una
persona. Todo lo que entró a la tabla entró también a `denylist.json`, así el detector lo sigue viendo si una forma
nueva se escapa. El orden importa, porque los pares se aplican de a uno: primero la organización y los servidores;
después correos, nombres completos, usuarios y máquinas; recién después los nombres sueltos; y en cada familia de un
cliente, lo compuesto antes que lo corto (`AcmeBackend` antes que `Acme`, `ACME Portal` antes que `ACME`).

| Qué | Cómo queda | Por qué así |
|---|---|---|
| Clientes | un nombre inventado, una sola palabra, con la misma caja en cada forma (`Acme`, `ACME`, `acme`) | un identificador sigue siendo un identificador (`AcmeBackend`). Las palabras que ya usa el repo (`delta`, `radio`…) no se eligieron |
| Personas | `DevA`/`deva`, `Dev A`; en prosa, «el dev» y «otro dev»; correos a `…@example.com`; usuarios a `usuarioa`, `usuario-c` | las guías ya dicen «el dev»; los dominios de ejemplo (RFC 2606) no son correos de nadie |
| Máquinas | `Devas-Mac`, `equipo-deva` | conservan la forma de un nombre de host |
| Una forma que deriva de otra | la misma caja en las dos (`ACME Portal` → `BETA Portal`, como `ACME` → `BETA`) | una prueba arma el enlace desde el nombre del proyecto y lo compara con uno escrito a mano: si las dos formas se anonimizan distinto, el enlace no coincide |
| La organización de Azure DevOps | `org-del-equipo`, **por forma**: `dev.azure.com/…` y sus subdominios, `….visualstudio.com`, los remotos SSH, el usuario `…@`, `Build Service (…)` y la clave `org: '…'`; el GUID de la colección a un GUID de mentira | se reemplaza donde aparece como organización (una URL, un remoto, un usuario), nunca como palabra suelta |
| Servidores internos | un host de un dominio reservado (`.example`) | los servidores son internos; la web pública del producto sale tal cual. Con un dominio reservado la tabla de rutas del README (regla BZURL) se sigue leyendo igual |
| Un cliente cuyo nombre, en minúscula, está dentro de una palabra común | distingue mayúsculas en el detector | en minúscula disparaba dentro de esa palabra; la forma en minúscula la cubre la tabla |
| `database.windows.net`, `azurewebsites.net` | ya no son términos: son patrones que encuentran el **host entero** | el sufijo es infraestructura pública; lo que nombra a alguien es el host, y así una excepción puede distinguir un host de mentira de uno real |
| Los clientes | cada término `cliente` de la lista de denegación con su par; si falta uno, el exportador sale 2 nombrándolo por su posición | la lista de clientes es una sola: los términos `cliente` de `denylist.json`, que también son los nombres que se tachan antes de mandar a un modelo. Una segunda lista, en otra guía, se desfasaba: medido, siete de sus nombres no estaban ni en la lista de denegación ni en la tabla |
| Abreviaturas y proyectos de un cliente | con su propio par, como el cliente: el prefijo de tablas y formularios, el nombre de un proyecto | aparecen como prefijo (`X_Tabla`) o solos, y ninguna regla general los deriva del nombre del cliente |

La tabla es privada: en lo que se publica no queda ninguna correspondencia entre un inventado y su real.


### Las excepciones del detector (`permitidos`)

Cada excepción nombra el **valor exacto** que permite, con su motivo — nunca un archivo entero: un secreto o un nombre
real nuevo en ese mismo archivo sigue saltando. Son de tres clases, las únicas admitidas:

1. **Valores inventados**: los que usan las pruebas —sembrados a propósito para probar que algo se detecta o se
   enmascara (la cadena de conexión de mentira de las suites del tablero, el JWT de ejemplo de jwt.io, la llave de ejemplo
   de la documentación de AWS, los correos del dominio de mentira `cliente-secreto`…), nombres de archivo o autores de
   commits de mentira— y los de ejemplo en la documentación (un servidor o un usuario de ejemplo).
2. **Código o documentación que nombra una clave sin tener ninguna**: la asignación que lee la clave de la
   configuración o la pide por teclado, dos constantes de la cuenta de tokens, el marcador que indica el largo de una
   llave en la documentación del SDK.
3. **Lo que la tabla ya anonimizó y el patrón genérico igual reconoce por su forma**: una ruta `/Users/usuarioa/`, el
   usuario@host de una URL de git de `org-del-equipo`. Un servidor de un cliente no entra acá: en lo que se publica va
   un host inventado entero (clase 1), nunca el real con una parte cambiada.

Un valor que codifica un nombre donde el detector no lo puede ver no se permite: se corrige en el interno. Por ejemplo,
un JWT de mentira que lleva un nombre en base64 pasa a llevar `{"sub":"dev"}`.

Aparte de las excepciones, dos correos que no son de una persona pasan en cualquier archivo (`emailsPermitidos`):
`arnes@tycon.com.ar`, el autor del único commit de cada copia, y `azure-pipelines@dev.azure.com`, la identidad de
servicio pública con que Azure Pipelines firma los commits nocturnos.

## Los controles

Se corren todos y recién después se decide; cualquier hallazgo es un 1 y la copia se descarta:

- **Nombres pegados**: el borde de palabra deja pasar `<Término>Project`, y como el detector usa el mismo borde, un nombre
  pegado pasaría los dos. Se buscan los términos con `palabra: true` como prefijo de un identificador (todos) y en
  cualquier posición (los que no distinguen caja), en el contenido **y en las rutas**. Para los que distinguen caja,
  prefijo es lo que sigue con mayúscula o dígito (`<Término>Project`, `<TÉRMINO>2`): con una minúscula es otra palabra
  —un nombre corto no marca a la palabra que empieza igual—. Un término con tilde se busca también sin ella, pero sólo en
  el borde de un CamelCase (`AlmacenService` de `Almacén`): en cualquier posición sería cada palabra que lo
  empieza. Se resuelve con una forma que nombre el identificador entero o con un «out». Un pegado que **tiene que
  quedar** (el nombre funcional de un sitio que lleva pegado el de un repo) se declara en
  `permitidos` con su archivo y el identificador entero: el control —y el freno de nombres, que usa el mismo— lo respeta;
  con la excepción de otro archivo, o con otro identificador en el mismo, sigue frenando. En una ruta no hay excepción.
- **La lista de clientes del arnés**: son los términos `cliente` de la lista de denegación.
  Cada término necesita su par en la tabla: si falta, 2 antes de escribir
  nada, nombrándolo por su posición y su categoría.
- **Compila**: `node --check` de cada `.js`, `bash -O extglob -n` de cada `.sh` (un guion que prende extglob es
  legítimo), `py_compile` de cada `.py` (con la caché afuera). Un `package.json` «module» arriba de `--output` no cambia
  nada: la copia se arma con un `package.json` sin «type» en su raíz, fuera de los dos repos, que corta la búsqueda
  hacia arriba y deja que node decida por el contenido, como en el interno; se va antes del commit.
- **Comandos colgados**: todo `node <ruta>.js` o `bash <ruta>.sh` de un `.md` de `commands/` o de `skills/` —también
  con opciones en el medio, `node --test <ruta>.js` o `bash -x <ruta>.sh`— tiene que resolver a un archivo de la copia. Los marcadores con un solo sentido se resuelven (`<skill>` es la skill del `.md`,
  `<arnés>` el arnés, `<repo>` en un comando del arnés es el arnés); una variable u otro marcador no se juzgan.
- **Nombres viejos**: ningún archivo que sale puede nombrar la ruta vieja **completa** de un archivo o una
  carpeta del mapa de renombres (salvo `guides/nombres-en-ingles.md`, que explica la convención): afuera ese archivo no
  existe. Se resuelve nombrando el nuevo.
- **El detector**, una vez por repo con `--base` en su raíz (los `permitidos` valen igual que sobre el interno):
  todos en cero, ningún archivo excluido y la cuenta exacta; después, sobre las **rutas** de la copia (un nombre en una
  ruta no se esconde) y sobre los **metadatos** del commit — también esas dos listas tienen que haberse mirado (un
  `excluir` que las cubra es un 2, no un «limpio»).

Antes de escribir nada en disco, además: una ruta del árbol con un segmento `..`, `.`, vacío o `.git`, o que empieza con
comillas, es un 2 (un árbol armado a mano podría escribir fuera de la copia o pisar su `.git`); y dos rutas —o dos
carpetas— que sólo difieren en mayúsculas o en la forma de sus acentos (NFC/NFD) también: en el disco de macOS se pisan.

## El commit: por plomería, reproducible

Cada repo de la copia es un `git init -b main` con **un** commit armado por plomería (`hash-object --no-filters`,
`update-index --index-info` con el modo de cada archivo, `write-tree`, `commit-tree`, `update-ref`), autor y committer
`TYCON <arnes@tycon.com.ar>`, con la fecha más reciente de los commits fuente (`+0000`), sin reflog (git lo firmaría con
el nombre y el host de quien corre) y con el árbol de trabajo verificado contra el commit con `git status` (el
`update-index -q --refresh` no sirve de control: con `-q` sale 0 aunque haya diferencias). Todo `git` corre sin la
configuración de la máquina ni las variables `GIT_*` heredadas. Mismos commits fuente → mismo árbol, mismo commit, mismo
`--json` y mismo listado, sin importar la máquina, el huso, el idioma, la umask ni la configuración de git.

**Por qué no `git archive` ni `git commit`**: medido, cada atajo dependía de la máquina. `git archive` aplica los
atributos locales de cada clon (`export-ignore`, `export-subst`, `autocrlf`) y, en un pipe, se traga el error. `git
commit` corre hooks, firma, respeta los ignores globales y usa la identidad y el huso de quien lo corre. `git init` sin
`-b` da `master` o `main` según la máquina.

## Cómo se lee el listado de reemplazos

`<salida>.reemplazos.md` empieza con la marca PRIVADO, el paquete y los commits fuente (sin fecha: dos corridas iguales dan
el mismo listado), y el número de cada par (`par-1: <real>`…), que es como los nombra el `--json`. Después vienen: por
archivo, en orden de ruta, qué pares se aplicaron y cuántas veces, en el orden de
la tabla; los ajustes de la copia (cada transformación, con el archivo); y los pares que no se usaron, que son sólo
informativos. Sirve para revisar a ojo los archivos con más reemplazos, que es donde un anónimo puede romper el sentido.

## Qué quedó afuera y por qué

Además de las exclusiones fijas y de los «out» del primer nivel (las dos tablas de arriba), sale **sin** la copia lo que
no andaría afuera. La suite y su entrada de `suites.json` se van juntas (`suitesOutside`), y un archivo de casos del banco se
lleva sus entradas de la línea base (`casesOutside`). Salieron de medir: son las que dan otro veredicto
en la copia que en el interno. Eso se arregla en la tabla, en una exclusión o en la derivación, nunca
en la prueba. Cada una que se podría hacer portable queda para una story aparte.

| Por qué no viaja | Qué |
|---|---|
| Su código o sus datos quedan afuera | `vigilante`, `nightly-dependencies`, `work-items`, `work-item-status`, `daily-summary`, `open-pr-per-finding`, `nightly-publishes-report`, `suites-report`, `pr-verdict`, `nightly-dashboard`; el caso `hooks/31-vigilante.json` |
| Usa lo privado de la publicación | `export-real.test.sh` (la tabla y la lista de denegación no viajan) |
| Espera a otra story (`pendientes` del `--json`) | de bizuit, sus traducciones a Codex, sus casos del banco y sus secciones del catálogo |

Dos pruebas declaran la llave de su integración en vez de contar con que el perfil del equipo la prende:
`engram-rescue.test.js` (memoria) y dos casos de `hooks/07-clocki-postedit.json` (Clockify). Se arreglaron
en vez de quedar afuera: el archivo de casos no se podía sacar sin llevarse los únicos casos
de dos hooks, y la copia dejaba de pasar su control de paridad.

Ningún documento del núcleo quedó afuera por ser inventario o estado de la producción de un cliente además de los ya
excluidos (un inventario de riesgo de la producción de un cliente y los inventarios de telemetría). Se revisaron los 15 archivos con más
reemplazos del listado:

| Reemplazos | Archivo | Decisión |
|---|---|---|
| 343 | `arnes/scripts/controls-bench/cases/hooks/40-prod-access-guard.json` | se publica: los casos del freno de producción; los servidores quedan anonimizados |
| 134 | `arnes/scripts/tests/smoke.test.sh` | se publica: la prueba de humo usa los productos del equipo como datos de prueba |
| 123 | `agent-skills/skills/tycon-pipeline/scripts/tests/unit.test.js` | se publica: la suite unitaria del pipeline; los clientes eran datos de prueba |
| 89 | `arnes/guides/piezas-del-arnes.md` | se publica: cada ficha dice su regla y su porqué; el caso vive en el registro de incidentes del equipo |
| 70 | `arnes/scripts/controls-bench/cases/hooks/39-consulta-fallida-notice.json` | se publica: consultas fallidas contra Azure DevOps, con la organización y los proyectos anonimizados |
| 65 | `arnes/scripts/tests/dashboard-runs.test.sh` | se publica: corridas de mentira de varias máquinas |
| 63 | `arnes/scripts/tests/download-runs.test.sh` | se publica: las máquinas del buzón, anonimizadas |
| 56 | `arnes/scripts/tests/engram-autoheal.test.js` | se publica: proyectos de memoria de mentira |
| 55 | `arnes/guides/advisor-rules-catalog.md` | se publica: el catálogo; cada regla conserva su porqué, sin el caso |
| 44 | `arnes/guides/ci-gate.md` | se publica: el portón de CI, con la organización y el GUID de la colección anonimizados |
| 43 | `agent-skills/skills/tycon-pipeline/scripts/pipeline.js` | se publica: los nombres estaban en comentarios de casos |
| 40 | `arnes/guides/engram-workflow.md` | se publica: los nombres de proyecto de memoria por cliente quedan anonimizados |
| 40 | `arnes/scripts/controls-bench/cases/advisors/tycon-feature-wiring-checker.json` | se publica: un caso del revisor de cableado con el código de un cliente de ejemplo |
| 39 | `arnes/story-format.md` | se publica: ejemplos del formato de story |
| 38 | `arnes/guides/decisions/controles-apagables-por-config-2026-08-25.md` | se publica: el diseño de los controles apagables; no inventaría producción |

## Los papeles

La copia lleva en su raíz lo que un repo público necesita, y los repos internos no lo llevan (su
árbol trae lo que nunca sale: una `LICENSE` en su raíz diría que todo es Apache-2.0):

- `LICENSE` (Apache License 2.0, el texto canónico de la ASF byte a byte) y `NOTICE` (titular, marcas y una línea
  `* <ruta>` por cada derivada que sale, con su origen, su licencia, su copyright y el aviso MIT).
- `README.md` (inglés) y `README.es.md` (castellano): la portada, en la raíz desde el 2026-10-14. El índice de guías
  que carga cada sesión pasó a `INDEX.md`.
- `.github/CONTRIBUTING.md`, `.github/CODE_OF_CONDUCT.md` y `.github/SECURITY.md`.
- `.github/workflows/ci.yml`: la CI del repo público (ver «La CI pública»).
- `guides/incident-log.md` público: una página que dice que los casos con nombre viven en el repo del equipo.
- `scripts/setup/public-remotes.json`: la lista de remotos públicos, `{ "remotes": ["https://github.com/<organización>/<repo>"] }`,
  con el nombre ya puesto. Con ella el programa de instalación reconoce un clon del público y sabe
  de qué repo baja la versión publicada (`install --version`, la mudanza, la portada sin git). En los repos internos ese
  archivo no existe en `scripts/setup/` —sólo su plantilla, entre los papeles—: un clon interno nunca cuenta como público.
- `scripts/setup/get-harness.sh` y `scripts/setup/get-harness.ps1`: los guiones de entrada de la
  portada (el bloque `install:script`), con la dirección del repo público ya puesta. Como la lista de remotos, en los
  repos internos sólo existen sus plantillas, entre los papeles. `--explain --json` lista cada sintético en `synthetic`
  (destino, origen, paquetes y motivo).

Viven en la carpeta de papeles de `scripts/publishing/`, con la ruta de su destino adentro; esa carpeta queda afuera y cada papel
llega a su lugar por un sintético con `packages` (el sintético aplica en esas exportaciones aunque ningún «in» cubra su
destino). El nombre público vive en un solo archivo, `public-repos.json`, que no viaja: los papeles
escriben `{{public-org}}` y `{{public-repo}}` y el exportador los reemplaza al ponerlos (un marcador desconocido sale
2; una URL del repo público escrita a mano es un hallazgo). El lector es `readPublicRepo()` de `export.js`. Los dos frenos
de nombres miran los papeles como a cualquier archivo que sale: `whatShips` cuenta el `from` de cada sintético.

## El repo único

`--single-repo` arma UN repo con UN commit: cada archivo del arnés y de agent-skills va a su misma ruta desde la raíz
(agent-skills aporta `agents/`, `skills/` y `packs/`). Una ruta que llega de las dos fuentes sale 2, salvo las dos que
existen hoy: `.gitignore` (`merged-gitignore`: las líneas del arnés y después las de agent-skills que falten) y
`.githooks/pre-commit` (`merged-hooks`: quedan `pre-commit-harness` y `pre-commit-skills`, y el `pre-commit` es un
despachador que corre los dos siempre, cada uno en su proceso). Ningún archivo cambia sin su ajuste: cada uno es el blob
de su fuente, un papel o figura en `ajustes`. El `--json` suma `renamed`. Sin `--single-repo`, la copia sale como antes,
un repo por fuente. Cuando lo interno ya es un solo repo, esas dos rutas llegan de una sola fuente y no hay nada que
juntar (§«Un solo repo interno»).

**La versión numerada**. El repo que se publica lleva en su raíz `version.json`, que lee el programa de
instalación:

```json
{
  "version": "2026.10.03.1",
  "source": {
    "harness": "<sha del arnés>",
    "agent_skills": "<sha de agent-skills>"
  }
}
```

`version` es `YYYY.MM.DD.N` y `source` es un mapa de fuente a commit. No lleva la fecha de la corrida ni el canal: las
mismas entradas dan los mismos bytes. Los arma **una** función, `versionFileBytes()` de `export.js` (dos espacios de
sangría, ese orden de claves, un salto de línea final), que usan los dos que escriben el archivo:

- **La sincronización** (`mirror.js`), que es quien numera: el número depende de lo que el público tiene, y el
  exportador corre antes de leerlo (§«La publicación», «La versión»).
- **El exportador**, para una copia suelta —la máquina limpia, una prueba—: `--stamp-version <YYYY.MM.DD.N>` estampa el
  número que se le da. Sólo con `--single-repo` (la copia de dos repos no tiene una raíz: sale 2), y con un número sin
  forma sale 2. **Sin la opción la copia no cambia**: ni un byte, ni el commit.

El archivo no sale de ninguna fuente, así que la lista blanca lo declara aparte, en `generated` (`{ target, reason }`).
`--explain --json` lista esa clave. Un generado sin motivo, repetido o que el exportador no sabe armar es un 2; y si una
fuente o un sintético **ya trae ese destino** —con cualquier caja— también, en toda exportación: en la sincronización
el archivo se agrega encima de la copia, y pisaría el de la fuente sin avisar. El `--json` de la exportación dice en
`generated` cuáles trae la copia (sin la opción, ninguno).

## La unión de paquetes

`--package core,bizuit` es la copia del núcleo más la del paquete del stack, con sus revisores enteros (su `.md`, sus
traducciones a Codex, sus casos del banco, sus entradas en la línea base y en el manifiesto, sus secciones del catálogo),
sin pendientes y sin nada de `clients`. El orden de la lista no cambia el commit; una lista sin `core`, con `clients` o
con un paquete desconocido sale 2. Afuera el paquete viene apagado: un repo que no declara `packs:` activa los que diga
`packs.default` (en este orden: `TYCON_PACKS_DEFAULT`, el perfil del equipo —que dice `all`— y el archivo de la
máquina; sin nadie, ninguno). En esta clave el perfil del equipo gana sobre el archivo de la máquina.

## Bloques internos y enlaces

En los `.md`, el texto entre los marcadores `tycon:internal-start` y `tycon:internal-end` (comentarios HTML, cada uno solo
en su línea, fuera de un bloque de código y de una tabla) no sale; el de un comentario `tycon:public-only` sale visible
(en el interno es un comentario y no se ve). Así el `README.md` y el `INSTALL.md` siguen siendo los del equipo y en la
copia no dicen nada falso. Un marcador sin par, anidado, dentro de un cerco o de una tabla, o fuera de un `.md` sale 2.
También sale 2 un marcador **casi** bien escrito: un espacio de más o de menos, otra caja, un guion bajo,
adentro de una cita o de un ítem de lista, o con texto en la misma línea. Si no fuera ni marcador ni error, con la misma
errata en la apertura y el cierre el bloque entero saldría en la copia con todo en verde.
Se compara el contenido del comentario, sólo sus letras, contra el de cada marcador: frena hasta con dos letras de
diferencia (`intenral`, `interal`, la primera palabra mal escrita o ausente), y también el comentario partido en
renglones (el `<!--` solo y el resto abajo). Un comentario común que nombra «internal» o «public» (`internal endpoints:
…`, `public only for beta`) no frena: trae texto de más. Un comentario que trae la palabra del arnés seguida de algo
parecido a «internal» o «public», en cualquier lugar de su renglón (también con una etiqueta delante: `BEGIN`,
`marker:`), sí frena: esa pareja queda reservada para los marcadores. Es una falsa alarma aceptada a conciencia
(un comentario que diga «see tycon internal docs» frena; se reescribe con otras palabras): falla del lado seguro, nunca deja salir nada.
Dos deformaciones apiladas a la vez (una etiqueta y además el marcador partido en varios renglones) todavía se escapan:
es un límite conocido. Un comentario que
queda abierto sigue hasta su cierre (hasta cinco renglones), y un renglón que es sólo el cuerpo de un marcador con la
palabra del arnés frena aunque no esté en un comentario: así no se escapa un marcador partido ni uno cuyo comentario se
cerró antes. Nombrarlo en una frase no frena. El armado mira todo archivo de texto, no sólo los que traen el marcador
bien escrito.

Cuatro controles miran la copia ya armada: `links` (un enlace relativo de Markdown, fuera de bloques de código, que apunta
a algo que no está), `readmePaths` (una ruta entre comillas invertidas del `README.md` o del `INSTALL.md` que empieza con
una entrada de primer nivel y no está), `pathsNotInCopy` (una ruta del repo del equipo que quedó sin su marca: ver abajo)
y `attributions` (el `NOTICE` contra las derivadas que salen). Cada uno es un hallazgo (exit 1) con archivo y línea.

### Las rutas que no viajan

Las guías nombran archivos del repo del equipo que la copia no trae: un plan en `tasks/`, una medición, el perfil del
equipo, la lista privada de nombres. Afuera esa ruta no lleva a nada, y sin aviso parece un archivo que falta. La
transformación `not-in-copy` le pone al lado, en la copia, una marca corta que dice de dónde es; la ruta queda tal cual y
la guía del repo no cambia. La marca vive en un solo lugar (`NOT_IN_COPY_MARK` de `scripts/publishing/public-copy.js`).

- **Qué se marca**: en un `.md` que sale, una ruta entre comillas invertidas, en prosa, que existe en el repo del equipo
  (archivo o carpeta) y no en la copia. Se mira el primer pedazo del código en línea, sin `#…` ni `:N`; la ruta puede
  estar escrita desde la raíz, relativa a la carpeta del propio archivo, o con el prefijo del arnés instalado
  (`~/.claude/tycon-harness/…`). El código en línea se lee como CommonMark: por párrafo, y una tanda de comillas
  invertidas sin su pareja del mismo largo es texto.
- **Qué no**: una ruta que está en la copia (desde la raíz, o desde la carpeta del propio archivo); lo que no existe en el
  repo (un ejemplo); lo que está dentro de un cerco de código (rompería un comando que se copia); un ancla al registro de
  incidentes; el `README.md` y el `INSTALL.md` (los gobierna `readmePaths`); y las **convenciones del repo del lector**.
- **Las convenciones del repo del lector** se declaran en `allowlist.json → readerConventions`, cada una con su motivo:
  son rutas que el arnés crea o lee en el repo de quien lo usa (`.tycon/`, `.advisors/`, `.engram/`, `.dashboard/`,
  `_bmad/`, `qa/`, `tasks/todo.md`, …). Con `/` al final, la carpeta entera; sin ella, sólo esa ruta: `specs` y `tasks`
  son la carpeta suelta, y una story concreta del equipo bajo `specs/` se marca.
- **El orden**: después de `internal-blocks` y de traducir las rutas viejas a su nombre nuevo, y antes de los reemplazos
  y de regenerar las traducciones a Codex (así `generate.js --check` da lo mismo en la copia). Sólo con el núcleo.
- **El control** `pathsNotInCopy` cuenta por su cuenta —no llama a la función de la marca— las rutas que tendrían que
  llevarla y no la llevan: si queda una, exit 1 con archivo y línea. Comparte con la marca sólo el lector de código en línea, y
  una prueba los compara sobre un mismo corpus: lo que la marca marca es exactamente lo que el control vería sin marcar.
  Un `.md` que no es UTF-8 válido no se reescribe: sale 2.

### La historia interna

Lo publicado explica cada regla y su porqué; no cuenta la historia del equipo. El número de una story, el código de una
tanda, quién decidió algo y cuándo, el caso que motivó la regla con su enlace al registro de incidentes, una rama de
trabajo, un commit, una corrida o un número de pull request no llevan a nada desde afuera, y dicen con quién y sobre qué
trabaja el equipo. El caso concreto —qué producto, qué story, qué pasó— vive en el registro de incidentes, que no se
publica; la guía queda con la regla, escrita de modo que se entienda sin él.

Lo cuidan dos controles, y los dos viajan:

- **En la prosa**, `scripts/publishing/internal-history.js` mira lo que cada commit **agrega**: corre en el pre-commit
  y sobre el diff de cada pedido de cambio. «Prosa» son los `.md` de `guides/`, de la raíz, `getting-started/`,
  `.github/`, `claude-md-blocks/`, `skills/`, `commands/`, `agents/` y `packs/`, por la ruta con que salen; se mira el
  archivo entero, también los cercos de código.
- **En todo lo publicado**, también el código y las pruebas, `scripts/tests/internal-history.test.js` no deja pasar un
  número de pull request.

Las formas que el control de la prosa busca (el nombre de cada una es el que aparece en su mensaje):

| Forma | Qué ve | Qué se escribe en su lugar |
|---|---|---|
| `product-story` | una story con su número, atribuida a un producto, un repo o un cliente del equipo | qué pasó, sin el número ni de quién era |
| `story-number`, `story-bare` | el número de una story o de una épica del propio arnés, con la palabra o sin ella | nada: la regla se explica sola; un ejemplo genérico va como `story <N.M>` |
| `batch-code` | el código de una tanda de trabajo | nada |
| `owner-decision` | quién decidió algo, entre paréntesis o con su fecha | el motivo de la decisión |
| `case-label` | el rótulo con que una guía presentaba el caso que disparó una regla | «Por qué:» y el motivo |
| `incident-log` | un enlace o un ancla al registro de incidentes | el registro nombrado, sin enlace, o nada |
| `team-path` | una ruta, entre comillas invertidas, a un archivo del equipo que no se publica | lo que ese archivo decía, o un marcador (`specs/<story>.md`) |
| `pr-number`, `azure-run`, `private-commit`, `work-branch`, `debt-id` | un número de pull request o de corrida, un commit, una rama de trabajo, el identificador de una deuda | qué se midió o qué cambió, sin el número |

Cómo cuenta: por archivo, por forma y por lo que la identifica (el número de la story, el ancla del caso, el código de
la tanda), lo de después contra lo de antes. Busca por párrafo: una forma partida por el corte de renglón se ve igual.
Retocar un párrafo que ya traía una forma, renombrar una guía o mudarla dejando un talón no frena; lo que llega desde
un archivo que no era prosa o no se publicaba, sí; en un merge no es nuevo lo que traía cualquiera de las ramas; y un
archivo que empieza a publicarse se mira entero. Si el commit toca lo que decide qué se publica —la lista blanca, la
tabla, el manifiesto de un paquete, el exportador— se miran todos los archivos de prosa, no sólo los tocados. En el repo
del equipo «se publica» lo dice el exportador y se lee el texto como sale (sin los bloques internos; un papel, con la
ruta de su destino; y también lo que un paquete deja pendiente para la copia que une los paquetes); en el repo
público, todo lo versionado.

Cómo falla. Sale 0 si no hay nada, 1 con hallazgos y 2 si no pudo mirar; el mensaje dice el archivo, la línea y la
forma, nunca el texto encontrado. Qué hace con eso lo decide el modo, escrito en `scripts/publishing/internal-history.json`
(uno para el control y uno por forma: vale el más bajo): `block` no deja crear el commit, con 1 y con 2; `warn` dice lo
mismo y sale 0. La variable `TYCON_INTERNAL_HISTORY` (`block`, `warn`, `0`) pisa el modo del control: un valor que no se
entiende frena, apagado lo dice en cada commit, y bajarlo por variable también se dice. **El control frena**: la prosa
que se publica mide cero, la cuenta la da `node scripts/publishing/internal-history.js --all` y una prueba que viaja la
exige. En el pre-commit, si falta el guion en un clon del equipo el commit no se crea: no poder mirar no es verde. Un
error del propio control también es «no pude mirar», nunca un 1 que parezca un hallazgo. La última línea de su salida
normal son siempre las cuentas (`internal-history: findings=… cannot_look=… mode=…`); en la validación un hallazgo o un
«no pude mirar» suman a las fallas, y una forma que quedó escrita en aviso se ve como un aviso de la corrida con la
cuenta; también se avisa si esa línea falta o si el control está apagado. El detalle queda en el registro del paso.
Cada commit que tocó prosa que se publica deja su decisión, por código, en el registro de frenos
(`scripts/lib/guard-record.js`, freno `internal-history`): frenó, avisó, pasó o se lo bajó con la variable.

Cómo se sale de un hallazgo: reescribir sin la forma; si es un ejemplo genérico, un marcador; y si es un **dato** —el
asunto de un merge que el filtro de las notas de versión tiene que reconocer, el ejemplo de la salida que una skill
tiene que producir— se declara en `scripts/tests/fixtures/internal-history-allowed.json` con su archivo, su forma, el
valor exacto y el motivo. Nunca un archivo entero, y una declaración que deja de aparecer donde dice es un error.

Lo que este control no mira: los guiones, las pruebas, los datos y los YAML (ahí la cita del caso en la cabecera de una
pieza sigue siendo la convención), y lo que la lista de formas no nombra. Para otra herramienta —el freno que mira el
nombre de una rama o un mensaje antes de publicarlos— exporta `scan(text, zone)`, que no toca el disco.

### Los nombres de repos y proyectos internos

Lo publicado no nombra los repos ni los proyectos internos del equipo y de la plataforma: desde afuera no llevan a nada, y
dicen con quién y sobre qué trabaja el equipo. Cada aparición cae en una de tres clases:

- **(a) Un repo o un proyecto del equipo** — se reescribe **en la fuente**: «un repo del equipo», «el repo del framework
  de plugins», «el repo de formularios de la plataforma». La lección queda. Un dato de
  prueba que necesita un nombre usa uno neutro con la misma propiedad (el mismo nombre en dos cajas, un proyecto con
  `%20`). Los dos nombres inequívocos —el repo del framework, pegado, y el repo del modelador de procesos— son además
  términos de la lista de denegación, de caja exacta, con su par en la tabla: la tabla queda de red, no de arreglo.
- **(b) El nombre de un producto público de la plataforma** — queda. Es la marca: el producto de formularios, el tablero,
  las extensiones como capacidad («trabajar con … Extensions»), el servidor de procesos por MCP (`bizuit-bpmn-mcp`, y la
  carpeta de stories que lleva su nombre en los datos de prueba) y el rol de administradores. Por eso los otros repos de
  la plataforma no son término: comparten grafía con el producto, y un término obligaría a declarar como excepción cada
  uso legítimo de la marca. Nombrados como repo, se reescriben igual.
- **(c) Un uso funcional** — queda, declarado. El nombre del sitio del host de plugins en cada servidor lleva pegado el
  del repo del framework, y quien lee la regla lo busca así en su servidor: tiene una excepción en `permitidos` con su
  archivo y el identificador entero, que el control de nombres pegados respeta (abajo). El reconocedor del paso que sube el paquete en los pipelines de producto ya no lleva el
  nombre: reconoce el paso por su forma. El espacio de nombres del host (`….WebApi`) y los nombres de sitio de ejemplo del producto de
  formularios son código de la plataforma que un plugin ve en su traza: quedan.

Vale también para los archivos de la instalación (un comentario del instalador, el rótulo de un hook). La regla es la de
siempre: con la tabla real, el núcleo sale sin ningún reemplazo, y eso lo mide `export-real.test.sh`; una mención
«cubierta por el par» la pone en rojo.

### Los ejemplos con código real

Un ejemplo no lleva nombres del código de un producto. Los componentes, hooks, servicios, pantallas, stories y archivos
de un producto no nombran al cliente, pero
delatan a quien tenga el código. Se inventan todos, con cuatro reglas:

- **Un vocabulario neutro, parejo.** Pedidos, artículos, remitos, bolsas, etiquetas, rutas y sucursales de una «Acme»
  genérica. Dentro de un caso del banco, su revisor y su prueba, el mismo identificador real tiene el mismo neutro: un
  caso que corre con modelo se vuelve a correr a mano el día del cambio.
- **Cada real, un neutro distinto, que no lo delata.** No conserva la inicial ni el largo del real, fuera del
  prefijo que pide la convención del código (`use…`, `I…`, `story-…`). La regla completa del inventado, con su
  prueba, está en «Los nombres inventados», más abajo. Donde el ejemplo
  ponía un identificador al lado del nombre inventado de un cliente, la frase queda en general («un producto del
  equipo»).
- **Se reescribe la fuente; la lista queda de red.** Cada identificador real es un término de la lista de denegación
  —de caja exacta, y vale también pegado a otra palabra— con su par en la tabla. El freno de nombres no deja entrar uno
  en un commit, y `export-real.test.sh` los busca en la copia con `scripts/publishing/code-identifiers.js`:
  cada nombre aplanado —sin guiones, puntos ni guiones bajos, y sin caja—, en el contenido y en los nombres de archivos
  y carpetas, así que la misma cosa escrita con otra grafía también es un rojo. Coincide sólo entre bordes de palabra
  (`abrirAlgoModal` sí, una palabra más larga que lo contiene no), y un identificador que pegado y en minúscula es una
  palabra corriente la declara en el `noVe` de su término. Un nombre partido entre carpetas es otro nombre. El buscador
  no da verde si no pudo mirar —una lista de otra forma o una copia que no se deja leer son una línea roja con su
  motivo—, y su lógica tiene prueba propia (`code-identifiers.test.js`), que corre en cada cambio.
- **Un valor por defecto no es el archivo de un cliente.** El revisor de alcance firmado busca la propuesta y el plan
  por carpeta, no por el nombre de archivo de un producto, y dice cuál usó.

Con el mismo criterio:

- **Las stories de juguete del pipeline** (`skills/tycon-pipeline/scripts/tests/fixtures/stories/`) son stories de
  ejemplo inventadas, no stories de un producto recortadas: conservan la forma que
  mide su prueba —el prefijo de cada renglón, los títulos, la numeración, la tabla de pruebas con los criterios que cita
  cada fila— y esa forma está fijada en `stories-shape.json`. Nada las regenera: se editan en su archivo.
- **El ejemplo largo de `story-format.md`**, y el mismo ejemplo en la guía de .NET y en la de commits: cuenta un pedido
  y su despacho, no una funcionalidad de un producto propio.
- **Los revisores de un paquete privado.** El núcleo no los nombra, y sus pruebas no escriben la lista a mano: dos suites la leen de
  los manifiestos instalados y otras dos reconocen, en la copia, al que no viaja porque le falta su definición. (El
  revisor de plugins hermanos sigue nombrado en las pruebas que miden algo de él: no es el nombre de un cliente.) Un paquete que elige
  a un revisor por la ruta de un producto trae sus casos de equivalencia y su foto en su propia carpeta
  (`packs/<paquete>/equivalence-cases.js` y `equivalence-main.json`); la foto que viaja no los trae. El nombre de la
  plataforma de comercio electrónico de un cliente es un término más de la lista.
- **Lo suelto**: una marca como ejemplo de búsqueda, el prefijo real de dos letras en un paquete de juguete, un caso con
  su commit, un dominio de nube en una URL de ejemplo (va `example.com`), el estándar de intercambio del rubro de un
  producto (la regla quedó en general: un SDK estricto con el esquema) y dos formularios de ejemplo.

**Lo que queda, a propósito.** Un nombre genérico que también existe como archivo en algún producto (`ErrorBoundary`,
`access_token`, `playwright.config`) no delata a nadie y no es término: obligaría a declarar como excepción cada uso
corriente. El cruce contra los nombres de archivo de los repos de producto se repite antes de publicar; lo que se suma
a la lista es lo que tiene dos partes o más y es de un solo producto.

### Los nombres inventados

Un nombre inventado no puede parecerse al real que tapa. Medido con la regla de abajo: 80 pares de 217
(clientes, personas, máquinas y ejemplos) traían un inventado que se parecía.

- **La regla.** Un inventado no conserva del real la inicial, el largo exacto ni una palabra de cuatro letras o más, y
  dos reales no comparten inventado. Se mide cada forma del par y su forma de prosa.
  - *La inicial* se compara sin mayúsculas ni tildes. No cuenta el prefijo neutro del inventado (`acme`, `globex`,
    `demo`, `sample`), suelto o pegado, ni lo que las dos formas traen igual al principio por convención (`use…`,
    `I…`, `story-…`) o por estructura (`Backend…`).
  - *El largo*: el de la forma declarada y, para un cliente de varias partes, también el de su nombre escrito pegado o
    con un separador entre las partes, que el exportador reemplaza igual. Un identificador de formato fijo (un UUID)
    no puede cambiar de largo: queda eximido.
  - *Una palabra*: la misma, o cinco letras seguidas en común entre una parte del real y una del inventado (un
    plural, otra flexión, o un tramo dentro de un nombre escrito todo pegado). No cuenta una palabra **estructural**, que nombra la
    clase de cosa y no la cosa (`Repository`, `Service`, `Backend`, `Tests`, `Modal`, `Story`…).
  - *Una forma intermedia* —el nombre real de una aplicación escrito ya con el inventado de su cliente— se mide sin
    contar ese inventado, que no es del real. Cuando cambia el inventado de un cliente, sus formas intermedias y sus
    términos de la lista de denegación llevan una gemela con el nombre nuevo: si no, el nombre real de la aplicación
    saldría pegado al inventado nuevo.
- **La prueba.** Una prueba del repo del equipo mide la tabla entera y trae la regla y sus listas, cada
  una con su motivo. Un par que no cumple sale nombrado por su número y su categoría, nunca por su valor. No viaja en
  la copia (lee la tabla privada). Sale 2 —«no pude medir»—, nunca un verde, si falta la tabla, si no se puede leer, si
  un par trae una categoría que la regla no conoce, ninguna forma o un inventado vacío, o si no hay ningún par que medir.
- **Cómo se cambia la fuente.** Con un guion, una sola vez: la forma más larga primero, cada forma sólo entre bordes de
  palabra (un nombre corto no se toca dentro de una palabra más larga que lo contiene), y los inventados que no cambian
  quedan protegidos. Un nombre propio que además es una palabra de diccionario va por el mismo guion, con su
  inventario —archivo y renglón— revisado antes. Un sustantivo común del dominio de ejemplo se decide renglón
  por renglón: sólo cambia donde es el inventado (medido: 471 apariciones eran el inventado y 324 eran la palabra).
  El sustantivo nuevo conserva el género del viejo, así las
  frases siguen bien escritas. Entre clientes, y entre máquinas, los
  nombres nuevos conservan el orden de los viejos: las suites que ordenan nombres dan el mismo veredicto.
- **Lo que un renombre masivo rompe.** El guion puede cambiar algo que no es un nombre: una
  abreviatura de tres letras dentro de una expresión regular, una palabra común escrita en mayúsculas para enfatizar, o
  dejar una conjunción que ya no corresponde delante del nombre nuevo. Y no ve lo que está escrito de otra manera: el
  nombre todo en mayúsculas
  o en minúsculas, pegado a otra palabra, o con `%20`. Después de un renombre así se busca cada nombre viejo **sin
  bordes y sin distinguir mayúsculas**, y se lee lo que queda.
- **Los viejos no vuelven.** Los inventados viejos entraron a la lista de denegación como **patrones**
  (`inventado-viejo-…`), uno por nombre, con su caja, entre bordes y con las letras que un renglón tiene que traer para
  que valga la pena mirarlo. Además de cada forma declarada entran la misma en mayúsculas y en minúsculas, que la tabla
  vieja también producía. Van como patrones y no como términos porque un término pide su par, y un par viejo → nuevo
  haría que dos reales compartan inventado. Un patrón de ocho alternativas o más lleva esas letras (`pistas`) o la
  prueba de la lista lo frena: sin ellas recorre todos los renglones de la copia. Quedaron afuera 26 formas que, escritas tal cual, son una palabra de todos
  los días o un nombre de pila: un patrón con ellas frenaría texto legítimo. De ésas entran sólo los compuestos (el
  nombre pegado a un sufijo de repo o de clase, o seguido de la carpeta de un repo).
- **Un cambio escrito antes del renombre** que llega con un inventado viejo lo frena el detector, con el archivo y el
  renglón: se escribe el nombre nuevo. No lo frena si el nombre es uno de los 26 y está solo, ni si es una sigla vieja
  pegada a otra sigla en mayúsculas: eso lo tiene que ver quien revisa.


## Lo que se renombra o se poda en la copia

- `skill-rename`: `skills/tycon-create-story` sale como `skills/tycon-create-story` (la política de marca de BMad pide
  otro nombre para una versión propia): la carpeta, su `name:` y el identificador en los archivos de texto que salen. Se
  declara en `skillRenames` de la lista blanca. Excepciones, lista cerrada: el `NOTICE`, el `NOTICE.md` y el `LICENSE` de
  la carpeta y, en el manifiesto de terceros, `based_on` y `license_source`. Un resto del nombre viejo es un hallazgo.
- `public-third-party`: el manifiesto de terceros de la copia deja sólo las skills con licencia MIT o Apache-2.0 que el
  arnés usa, directa o indirectamente, o que traen `publish: true` (desde el 2026-10-05: BMAD completo y las de .NET,
  React, pruebas, seguridad y depuración que se le ofrecen a quien trabaja con el paquete bizuit); `own` y `derived`
  quedan. El instalador de la copia baja sólo ésas, de su origen. `publish: true` en una con otra licencia, o que no se
  baja, la rechaza `third-party-coverage.js`.
- Las rutas viejas que un repo nombra del otro las sigue reescribiendo `rutas-del-otro-repo`; un reemplazo
  generado sin entrada en el mapa que algo de lo que sale nombra frena con 2.

## La CI pública

Lo que corre la CI del repo público es UN guion del repo, `scripts/ci/public-ci.sh`, y el workflow
sólo lo llama: quien manda un cambio de afuera corre en su máquina lo mismo que la CI.

```bash
bash scripts/ci/public-ci.sh                                          # los siete pasos de siempre
bash scripts/ci/public-ci.sh --range origin/main...HEAD               # además, el freno de nombres en castellano
bash scripts/ci/public-ci.sh --clean-machine                          # además, la máquina limpia (usa la red)
bash scripts/ci/public-ci.sh --root <otro-clon>                       # sobre otro repo (por defecto, el del guion)
```

Los pasos, en orden y con una línea cada uno: `node --check` de cada `.js` versionado (`git ls-files`, no lo que haya en
disco) · `build/check.js` · `build/generate.js --check` · `suites-coverage.test.js` · `portable-suites.test.sh` · las
suites de `suites.json` que piden exactamente `["agent-skills"]` (de a cuatro, cada una en su HOME vacía y sin las
herramientas del vocabulario en el PATH, como las portables) · el banco de controles (`--tool both --baseline check`,
como el nocturno) · con `--range`, `spanish-names.js --range` · con `--clean-machine`, `clean-machine.test.sh` en su
modo público (`TYCON_CLEAN_MACHINE=1` y `TYCON_CLEAN_MACHINE_SOURCE=<raíz>`: pedida de forma explícita y sobre ese repo).

- **No corta en el primer rojo**: corre todos y sale 1 si alguno no quedó verde; 0 sólo con todos verdes.
- **Un paso que no pudo correr es rojo**, con «no pude correr» y el motivo —falta su archivo o su herramienta, la
  historia no alcanza para `--range`, no hay ninguna suite que correr—. Nunca un salto.
- **No corre el detector** (necesita la lista privada, que no viaja) y no lee ningún secreto.
- **Sirve en los dos layouts**: en el repo único las skills son `<raíz>/skills`; en el repo del equipo se ubican con
  `scripts/lib/skills-dir.js`. En los dos exporta `TYCON_GUIDES_DIR` y `TYCON_SKILLS_DIR` para toda la corrida.
- **`TYCON_PUBLIC_CI_OUT=<carpeta>`** (opcional): la salida de cada paso (`<n>-<paso>.log`), el veredicto por suite del
  sexto (`agent-skills-suites.tsv`, una línea `✅|❌<TAB>raiz/ruta`, ordenadas; la salida de cada una en
  `agent-skills-suites/`) y el reporte del banco (`bench.json`). Sin la variable va a una carpeta temporal, que el
  resumen nombra. El resto de las variables está en la cabecera del guion.
- **`TYCON_PUBLIC_CI_PART=<parte>`** (opcional, 2026-10-14): corre sólo una parte de los pasos, para repartirlos en
  trabajos que corren a la vez. `checks` es todo menos las portables; `suites-<i>-of-<n>` es sólo la parte `<i>` de las
  portables, repartidas por peso con `scripts/ci/suites-shard.js` (juego `pr`). `checks` y las `<n>` partes de las
  suites juntas son la corrida entera; una parte sola no es el veredicto, y el resumen lo dice. La CI de GitHub corre
  así: una matriz Node × parte, con tres partes de las suites, y el job `public-ci` junta todas.
- El sexto paso no corre `export-real.test.sh`: es la suite que corre este guion, y adentro de él sería infinita.
- **El repo lo decide `--root`, no el entorno de quien llama.** El guion saca al arrancar las variables que git le pasa a
  lo que lanza un hook (`GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`…): con ellas puestas listaría los
  archivos de otro repo, y una suite que arma repos de prueba commitearía en la rama de quien llama. Un `--root` vacío
  (la variable sin definir de quien llama) sale 2 con el uso: no cae al repo del guion.

El workflow es `.github/workflows/ci.yml` (adentro vive entre los papeles y llega
por un sintético, como los demás). Lo que tiene que cumplir lo verifica **por texto**
`scripts/ci/check-public-workflow.js <archivo>` —el repo no tiene un lector de YAML—, una línea por regla rota (0 limpio
· 1 reglas rotas · 2 no pudo leer):

| Regla | Qué exige |
|---|---|
| `triggers` | Corre en `pull_request` y en `push` a `main`, y en nada más. |
| `pull-request-target` | Ese disparador no aparece en ninguna parte: corre el código del pull request con los permisos del repo. |
| `secrets` | No lee ningún secreto, tampoco el token por otro camino (con punto, por índice o volcando el contexto entero). |
| `uses-by-sha` | Cada `uses:` va fijado por el sha completo de su commit, con el tag como comentario. |
| `permissions` | Un solo bloque `permissions`, arriba de todo, con `contents: read`. |
| `fetch-depth` | El checkout trae la historia completa (`fetch-depth: 0`): la necesita `--range`. |
| `node-matrix` | La matriz (`strategy: matrix:`) es Node 22 y 24, y es la que se instala. |
| `range` | En un pull request, `public-ci.sh` corre con `--range origin/<base>...HEAD`. |
| `clean-machine` | Toda llamada a `public-ci.sh` lleva `--clean-machine`. |
| `aggregate-job` | El job `public-ci` corre siempre (`if: always()`), depende de todos los demás y falla si alguno no dio `success`. |
| `parts` | La matriz parte la corrida en `checks` y `suites-1-of-<n>` … `suites-<n>-of-<n>`, todas, en orden y una vez, y la parte llega al guion desde la matriz: una que falta deja suites sin correr y el veredicto igual verde. |
| `shape` | Las líneas de código del archivo son EXACTAMENTE las que el control lleva adentro (`SHAPE`), en ese orden. |

🔴 **El job `public-ci` es el chequeo con nombre estable** que las reglas de la rama exigen: renombrarlo
deja los merges esperando un chequeo que no llega. Corre siempre porque un job que depende de otro que falló se saltea,
y un chequeo salteado cuenta como aprobado.

🔴 **`shape` es la red, y es a propósito.** Las diez primeras reglas dicen por qué algo está mal; pero una regla que busca
«lo prohibido» por texto siempre deja pasar otra forma de escribirlo —la opción dentro de un comentario de shell, la
llamada con otra ruta, un `|| true` que se traga el rojo, un `exclude` en la matriz, un `if:` en un paso, un job en estilo
flujo (`{ … }`), el token por índice, un escape `\x65`, un retorno de carro suelto que para YAML es un salto de línea—.
Medido: una revisión adversarial encontró trece clases así. En vez de una regla más por cada forma, el control lleva
adentro la forma exacta del `ci.yml` que hay: sacadas las líneas vacías y las que son sólo comentario, las líneas del
archivo tienen que ser las de `SHAPE`, literales (con su sangría y sin un comentario al final) y en ese orden. Sólo en las
dos líneas `uses:` el sha completo y el tag (`# vX.Y.Z`) pueden ser otros. Un `\r` que no va seguido de `\n`, un tabulador
o un carácter de control son rojo antes de mirar nada más; los finales de línea de Windows se aceptan. El rojo dice la
primera línea que no coincide: su número, lo que hay y lo que se esperaba.

**Cambiar el `ci.yml` es cambiar dos archivos en el mismo commit**: el `ci.yml` y `SHAPE` en
`scripts/ci/check-public-workflow.js`. No se arregla relajando la regla. Las dos reglas que buscan algo prohibido
(`pull-request-target`, `secrets`) miran además los comentarios. Al subir la versión de una acción no hace falta tocar
`SHAPE`: el sha se lee del tag (`git ls-remote https://github.com/actions/checkout 'refs/tags/v*'`) y el tag queda al lado.

Red: `scripts/tests/public-ci.test.sh` (portable; corre también adentro de la copia) —el guion sobre un repo de mentira
con un guion mínimo por paso, y el `ci.yml` real más copias alteradas: una por regla y una por cada una de esas
clases—. La suite corre entera con `GIT_DIR` y compañía apuntando a un repo de afuera, que al final tiene que estar
idéntico. El guion real sobre el repo entero lo corre `export-real.test.sh`, en la copia y en el interno, y compara los dos
veredictos: en el gate del commit de quien toca la publicación; en el nocturno está apagado hasta el corte (no entraba).

Con `--clean-machine` el guion corre además `scripts/tests/clean-machine.test.sh` en su modo público (ver «La máquina
limpia»). Si ese archivo falta, el paso es rojo «no pude correr», como cualquier archivo que falta: no hay un
interruptor para saltearlo.

## La máquina limpia

`scripts/tests/clean-machine.test.sh` instala el arnés en un contenedor que trae sólo lo que la
portada declara como requisito —los dos `Dockerfile` de `scripts/tests/clean-machine/` son esa lista hecha ejecutable—,
con el bloque de instalación de la portada tal cual, y corre el esqueleto mecánico del pipeline sobre un repo de ejemplo
y sobre el plugin de ejemplo del paquete del stack. Mide también lo que pasa sin red, sin `python3` y sin `node`, y que
desinstalar deje la máquina como estaba. No trae Claude Code: su papel lo cumple la prueba.

```bash
TYCON_CLEAN_MACHINE=1 bash scripts/tests/clean-machine.test.sh   # modo interno: exporta las dos copias del árbol de trabajo
bash scripts/ci/public-ci.sh --clean-machine                     # modo público: sobre ese repo, como la CI pública
```

- **Cuándo mide**: en el nocturno, en la CI pública y cuando se la pide con `TYCON_CLEAN_MACHINE=1`. En la máquina de un
  dev y en el control de cada cambio corre sólo lo que no usa Docker y sale NO MEDIDO con su motivo (salida 0): nadie
  construye imágenes sin pedirlo. Pedida y sin Docker, sale 1 diciendo por qué. Nunca verde sin haber medido.
- **Nunca se cuelga**: cada paso corre bajo un tope y hay un presupuesto total; el que se pasa sale en rojo con su nombre.
- **La copia entra a la imagen en una capa, nunca montada**, y el listado privado de reemplazos queda fuera de lo que
  ve Docker.
- En `suites.json` pide `["docker", "red"]` y corre sola (`exclusive`).

Qué mide caso por caso, las variables y los topes: la cabecera de la prueba. Su ficha, con la duración
medida: [piezas-del-arnes.md](piezas-del-arnes.md) §`scripts/tests/clean-machine.test.sh`.

**Los bloques que requieren una integración.** Un bloque de `claude-md-blocks/` que declara en su primera línea
`<!-- requires-integration: <integración> -->` se escribe en `~/.claude/CLAUDE.md` (y en su espejo de Codex) sólo con
esa integración prendida: afuera, nadie recibe una regla sobre un servicio que no usa. El comentario nunca llega al
`CLAUDE.md` ni al espejo; al apagar la integración el bloque se quita solo en la corrida siguiente; y si no se puede
saber (configuración rota, sin `node`, integración que el lector no conoce, o un marcador casi bien escrito) no se agrega ni se quita nada, y el sync lo
dice. Sólo `ado-runs-list-lag` lleva el marcador: es una regla sobre cómo operar Azure DevOps y, sin ese servicio, no
tiene a qué aplicarse. `tool-names` y `background-execution` no lo llevan aunque nombran integraciones que se pueden
apagar, porque no dependen de ninguna. El primero es una tabla de nombres: dice cómo se llama cada herramienta si está,
y la fila de una que no está no manda a hacer nada. El segundo ofrece avisar por Telegram como una opción dentro de una
regla —correr en segundo plano lo que tarda— que vale igual sin él. Partirlos por integración sería cambiarles el
contenido, no decidir si se cargan. El mecanismo acepta cualquier integración: si mañana un bloque entero pasa a
depender de una, se marca en su primera línea y nada más. Red: `scripts/tests/integrations-off.test.sh` (T32).

## La prueba de verdad: `export-real.test.sh`

`export.test.js` prueba el mecanismo con repos de mentira; esta prueba lo corre sobre los repos reales y mide lo que sólo se
ve ahí. Exporta `nucleo` y `bizuit` y verifica, en una carpeta de base fija (`/tmp/tycon-exportador.XXXXXX`, nunca el
TMPDIR de quien corre):

- **T20** — las dos copias salen (exit 0) con el detector en cero sobre el contenido, las rutas y los metadatos, sin
  ningún secreto, la lista blanca misma en cero, los repos fuente intactos y sin una sola llamada de red.
- **T21** — la copia del núcleo instala y arranca en una HOME vacía como la de alguien de afuera (enlaces sólo a la
  copia, `env -i`, herramientas de mentira que anotan cada llamada, `launchctl` de mentira): el instalador sale 0 con las
  ocho integraciones apagadas y sin alarmas, cada hook de arranque calla, `build/check.js` y `generate.js --check` dan 0
  (y con los `.toml` del interno, «DESACTUALIZADO»: la prueba ve lo que dice mirar), el control de commit de la copia
  rechaza `$VAR` pegado a una ñ, y después del medidor y del capturer no queda ningún archivo suelto.
- **T22** — desde la copia, las suites portables, `suites-coverage` y el banco de controles dan el mismo veredicto que
  el interno a los mismos commits (el interno corre en un clon `--shared`, limpio). La
  corrida larga es `scripts/ci/public-ci.sh` —lo que corre la CI pública— sobre la copia `core,bizuit --single-repo` y
  sobre el interno, y se comparan las portables, las suites que piden agent-skills y los casos del banco. Corre en el
  gate del commit. En Azure sale NO MEDIDO con su motivo: en el control de cada cambio, como siempre, y desde el
  2026-10-10 también en el nocturno, hasta el corte (tardaba 112 minutos y dejaba a la suite entera sin medir).
- **T23** — `bizuit` superpuesto al núcleo se carga sin variables (`packs: ["bizuit"]`, su revisor en el set, la
  auditoría del arnés sin faltantes) y el núcleo solo con `packs: [bizuit]` frena nombrando el paquete.
- **T33** — el commit exportado trae la misma lista blanca, tabla y denegación que el disco (las
  que usa el exportador); T21 espera el punto del medidor sin calcular su fecha (con la fecha local daba rojo todos los
  días de 21 a 24 hs en UTC-3); un bloque que arma un veredicto y no termina bien, o una HOME de prueba que no se arma,
  dan rojo (ensayado antes de medir); y lo que corre sólo en el interno está declarado o no sale.

```bash
bash scripts/tests/export-real.test.sh                       # el árbol de trabajo del arnés y origin/main de agent-skills
TYCON_EXPORTADOR_T22=0 bash scripts/tests/export-real.test.sh    # sin la parte larga (dicho: NO MEDIDO)
```

El exportador sólo lee commits, y su configuración la lee del disco. Por eso, sin variable, el arnés se exporta desde un
commit SUELTO de su árbol de trabajo, armado con `commit-tree` desde un índice temporal —sin rama, sin push, sin tocar el
índice—: contenido y configuración salen del mismo lugar. Con `origin/main`, el chequeo de un PR medía el contenido de
la base con la configuración del cambio, y un nombre real que el cambio agregara pasaba. `TYCON_EXPORTADOR_ARNES_REF` y
`TYCON_EXPORTADOR_SKILLS_REF` fijan otro commit.

## El núcleo sin nombres

**La regla**: lo que sale en la copia pública —código, pruebas, guías, catálogo de reglas,
instrucciones de revisores, pasos y comandos— se escribe sin nombres reales. Pruebas y ejemplos usan **nombres
neutros** (`acme` o «Cliente A» para un cliente, `acme-sql.database.windows.net` para un servidor, `example.com` para un
dominio, «el dev» para una persona); un caso real vive con su nombre sólo en `guides/incident-log.md` (no se publica).
La tabla de reemplazos queda como red: tapa lo que se escape.

**Un nombre neutro no delata al real**: no conserva su inicial, ni su sufijo, ni su largo
exacto, ni una palabra suya, ni el rubro del cliente. Una tabla, un proceso, un proyecto o una clase de ejemplo es un
nombre entero nuevo, nunca «prefijo nuevo + nombre real»; y una lista de ejemplo no sigue a la real ni uno a uno ni en el
mismo orden. Los inventados de la tabla de reemplazos **no** se usan para escribir algo nuevo: cada uno corresponde a un
real, y la tabla sólo tapa lo que quedó escrito. Por qué: la lista de
nombres puede dar cero y la copia traer datos internos que la lista no ve.

**Lo que la lista ve de cada término**: no hace falta escribir cada forma. El detector deriva de cada
término sus formas partidas —con guion, guion bajo, pegado o `%20`; con tilde o sin ella; en singular y en plural; el
host sin sus puntos; después de un escape (`\n`) dentro de una cadena; partido con comillas o concatenado; y partido en
dos renglones—. También: la ñ y la ç escritas en ASCII; el singular en «e» de un plural en «-es»
(`Deportes` → «Deporte»); una sigla en otra caja junto a una barra invertida o antes de una arroba; como el valor de una
clave con `=`, entre llaves o con un comentario detrás; y una sigla pegada con su propia grafía en mayúsculas
(`DeployZORBStaging`) o en el valor de una clave de proyecto en cualquier caja (`ENGRAM_PROJECT=zorbviejo`). La sigla
pegada no se busca dentro de una tira de base64 (40 o más caracteres de ese alfabeto con al menos cuatro dígitos: el
`integrity` de un lockfile, una imagen embebida), donde aparece por azar. Apagar las formas pegadas de una sigla
(`"glued": false`) en el mismo commit que trae un nombre pegado es una excepción, como sacar el término: va aparte. Un término de caja exacta (`mayusculas`) es un nombre y no se parte en una frase: `QuickReview` no
prohíbe «quick review». Cada patrón de la lista declara las muestras que tiene que ver (`ve`) y las que no (`noVe`), y una
prueba las corre; `internal-data-leftovers.test.js` barre las mismas formas con una lista sintética.

**El freno** (`scripts/publishing/new-names.js`, en el pre-commit del arnés y en el de agent-skills): un commit que
mete un nombre de cliente, persona, servidor o máquina en un archivo que sale **no se crea**. Lo que mira:

- **Lo neto, no lo agregado.** Por archivo, una categoría y texto que aparece más veces después que antes; en un merge,
  más que en cualquiera de los padres. Retocar, mover, reindentar o renombrar lo que ya tenía el nombre no frena, y
  traer `main` a una rama tampoco.
- **Lo que sale, como sale.** La clasificación y las transformaciones son las del exportador (`whatShips`): una clave
  vaciada, la sección del catálogo de un revisor de clientes o una traducción a Codex no cuentan; lo que un paquete deja
  en `pendientes`, sí. Además, los nombres pegados a un identificador y la ruta de un archivo nuevo.
- **El índice de verdad.** Lee el índice que git le pasa al hook: con `git commit -a` o `git commit <ruta>` no es el de
  siempre, y el git aislado del exportador (que borra todo `GIT_*`) no lo vería.
- **La lista al día.** Frena también un término de `denylist.json` sin su par en `replacements.json` (sin par, un nombre
  con una excepción sale en la copia con el detector en cero: medido en laboratorio), un producto nuevo de
  `scripts/ci/product-parity.json` que la lista no ve (el alta trae su término en el mismo commit), una carpeta nueva
  de primer nivel sin clasificar, y el techo del termómetro que sube sin un término nuevo.

**Cómo salir**, en el orden en que lo dice el mensaje: (a) un nombre neutro, o un sujeto genérico («un cliente», «un
servidor interno»); el mensaje muestra al lado de cada hallazgo con qué lo taparía la tabla si quedara, pero ese inventado
no es para escribirlo (sin par: el sujeto genérico o un par nuevo); (b) si es un caso, la regla y su porqué sin el nombre (el
caso vive en el registro de incidentes del equipo); (c) sólo si lo decide una persona y en un commit aparte, un `out` con motivo o una excepción
de valor exacto en `permitidos`. Una excepción que viaja en el mismo commit que el nombre que la necesita frena igual:
la excepción va aparte.

**Cuándo no mira y lo dice**: «no pude mirar» (la lista no se lee, git falla, la clasificación tira) frena; apagado con
`TYCON_NEW_NAMES=0` pasa y lo dice en cada commit; sin el otro repo (agent-skills para un commit del arnés, o el arnés
atrasado para uno de agent-skills) avisa fuerte y deja pasar. En la copia pública, sin la lista ni el perfil del equipo,
calla: ahí no hay lista por diseño. Cada commit que tuvo algo que mirar deja una línea de conteos —nunca un texto
encontrado— en `~/.claude/.tycon-pipeline/new-names.jsonl` y en el registro de frenos que sube al buzón (freno
`new-names`). En el repo unido no hay otro repo: cada corrida mira su fuente lógica, partida por ruta, y
cada hallazgo sale una vez. Un rango cuya base es de antes de la unión compara la mitad que esa base no trae con su
propia historia (el padre, con la forma del otro repo, del merge de la unión).

**En el pull request del arnés**, el paso «Controles de lint (siempre)» corre el mismo freno sobre el diff del cambio
(`--range <base>...HEAD`). Sin rango —una corrida que no es de PR, sobre `main`— avisa «no medido» y no suma a las
fallas.

**El termómetro**: `export-real.test.sh` exporta las dos copias con la tabla **vacía** y compara, por
paquete, los nombres que ve el detector (contenido y rutas) más los pegados contra
`scripts/publishing/names-ceiling.json`. Por encima es rojo, con las dos cifras y los cinco archivos con más; igual,
verde; por debajo, verde con «bajó a N: bajá el techo». El techo sólo baja —cada tanda de limpieza lo baja a lo que
mide— salvo en el commit que le enseña un nombre a la lista, donde se re-mide y sube diciendo cuántos términos.

**Lo que el freno no cubre** (y por eso existe el termómetro): lo que entra con el freno apagado, desde la web de Azure
DevOps o desde una máquina sin los hooks del arnés; y el paso del pull request no protege `main` mientras no haya una
política de rama que encole ese pipeline (hoy un PR no lo encola). Todo eso ya está en `main` al
commit siguiente y no vuelve a frenar: el termómetro lo pone en rojo esa noche.

**Con el núcleo limpio**: el techo está en 0 en los dos paquetes y exportar con la
tabla real no reemplaza nada —todos los pares quedan en `paresSinUso`, y `export-real.test.sh` lo exige (T46)—. Los
dos archivos privados quedan, no se borran ni se vacían, y cada uno cumple otro papel: **la lista (`denylist.json`) es
el control** —con ella miran el freno, el termómetro y el detector—; **la tabla (`replacements.json`) es la red** —tapa al
exportar lo que se escapó—. Un reemplazo al exportar es un nombre que pasó el freno, y el termómetro ya lo puso en rojo:
se arregla en el archivo, no en la tabla. Lo que cada paquete deja en `pendientes` también está en 0 (T45), así que entra
limpio cuando su story lo publique; la excepción listada en la prueba es lo que otra story saca del árbol.

## Las skills de terceros

**Lo ajeno se referencia, no se copia**. agent-skills traía unos 2.000 archivos de otros —cuatro skills con
licencia propietaria, que prohíbe guardar copias fuera de los servicios de su dueño y redistribuirlas— y la copia
pública no puede llevar nada de eso. La contrapartida es que cada dev tenga, carpeta por carpeta, el mismo contenido que
hoy; y eso se mide por contenido, no por nombre.

- **El manifiesto**: `scripts/publishing/third-party-skills.json`. Reparte todo lo versionado en agent-skills en tres
  universos: `own` (del equipo, por glob), `derived` (ajeno con cambios del equipo, como `skills/tycon-create-story` —que sale en la copia con su `LICENSE` y su
  `NOTICE.md`—, y
  las piezas del arnés que acreditan a otro, con licencia, copyright y de dónde se leyó) y `third_party` (ajeno: UNA
  entrada por carpeta, con `origin`, `commit` de 40 hexadecimales, `path` en el origen, `tree` —el hash de árbol de git
  de lo que tiene que quedar—, `omit`, licencia e `install`). La licencia no decide qué se baja: decide qué podría
  viajar en una copia, y para lo ajeno es nada. `install` sí: `download` (lo baja el paso), `official-plugin` (las
  propietarias: el paso no las baja nunca; vienen con el plugin oficial) o `retire` (se deja de declarar con el retiro).
- **El control sin red**: `node scripts/publishing/third-party-coverage.js [--json]` — cada ruta versionada en un solo
  universo, ninguna declaración muerta, ningún enlace simbólico versionado sin declarar y, mientras lo ajeno siga en el
  árbol, cada carpeta con el árbol declarado. Exit 0/1/2, como el detector. El pre-commit de agent-skills lo corre (sin
  el contenido, en milisegundos) cuando un commit toca `skills/`, `agents/`, `.agents/`, `.claude/` o un enlace: una
  skill de internet copiada sin declarar frena el día que se copia.
- **El paso del instalador**: `scripts/publishing/install-third-party.js`, desde `install-tycon-hooks.sh` y su gemelo
  de Windows en cada arranque. Restituye primero desde la historia de git del clon (sin red: el pull del retiro borra
  los archivos, no los objetos) y después, con el retiro hecho, desde el origen, verificando el árbol antes de escribir.
  Nunca borra ni pisa lo que no escribió; archivo por archivo con temporal y renombre; cerrojo contra dos arranques a la
  vez (el cerrojo es por clon, por su ruta real: por el enlace y por la ruta real es el mismo); tope de red de 20 s (`TYCON_THIRD_PARTY_NETWORK_BUDGET_S`); apagado con `TYCON_THIRD_PARTY=0`, y lo dice. Sin el
  plugin de las propietarias, una línea por día con los dos comandos para instalarlo
  (`TYCON_THIRD_PARTY_PROPRIETARY_NOTICE=0` la apaga). Su estado: `~/.claude/.tycon-pipeline/third-party-state.json`.
  **Si el pull del retiro quedó trabado** —el retiro borró un archivo ajeno que el dev tenía modificado y el pull con
  `--autostash` de la línea de arranque dejó el índice en conflicto—, saca del índice sólo esas rutas: el archivo del dev
  queda en el disco (y se nombra como modificado), el stash también. Otro conflicto lo nombra y no lo toca.
- **La prueba contra los orígenes**: `scripts/tests/third-party-origin.test.sh`, nocturna y con red: cada entrada tiene
  que dar su árbol en su origen; sin red sale NO MEDIDO, nunca verde. `third-party-real.test.sh` compara el manifiesto
  con el agent-skills real; `pipeline.js tooling-expected` avisa si falta una skill que el pipeline invoca.
- **El detector** suma el patrón `foreign-license`: una línea con el aviso de copyright y la reserva de todos los
  derechos juntos, o el frontmatter de una skill propietaria, es hallazgo; la frase citada en prosa no.

**Agregar una skill de internet**: una entrada en `third_party`, nunca la carpeta copiada (INSTALL.md §«Agregar una
skill team-wide»). **Moverla de versión**: otro `commit` y otro `tree` en su entrada, revisados como cualquier cambio;
nada se actualiza solo. Hoy agent-skills
versiona sólo lo propio y lo derivado, cada destino de lo ajeno está en su `.gitignore`, y `.agents/`, `.claude/` y
`skills-lock.json` no se versionan. La equivalencia, carpeta por carpeta y con la tabla de diferencias
declaradas, la mide `third-party-real.test.sh` (T24, y T25
con la línea de arranque real). La copia pública no tiene la historia de agent-skills: su paso baja de los orígenes
(`export-real.test.sh` lo corre sin red y exige el «no pude preguntar»).

## Lo que la publicación recibe

Lo que la primera publicación toma de acá, sin volver a decidirlo:

- **Qué se publica**: la exportación `--package core,bizuit --single-repo` (el núcleo más el paquete del stack, en un
  solo repo).
- **A qué repo**: al que devuelve `readPublicRepo()` de `export.js`. El nombre vive sólo en
  `public-repos.json`, que no viaja, y acá no se repite.
- **La correspondencia de rutas** entre lo interno y lo publicado: `ajustes` y `renamed` del `--json` del exportador.
- **Antes de anunciar** el repo hay que activar el reporte privado de vulnerabilidades de GitHub: `SECURITY.md` lo da
  como canal y, sin activarlo, el botón no existe.
- **El chequeo que el ruleset exige** se llama `public-ci`: es el job agregador del `ci.yml` (ver «La CI pública»).
- **Las contribuciones**: el flujo de contribuciones que describe `CONTRIBUTING.md` —un pull request no se mergea en
  GitHub; lo aceptado entra al repo interno y vuelve en la próxima sincronización, y lo demás se cierra con su motivo—
  es el que la publicación implementa.

Y lo que le suma el programa de instalación:

- La copia trae el programa de instalación: `scripts/setup/harness.js` y `scripts/setup/harness/`, con la copia fija de
  arranque.
- `version.json` lo estampa la sincronización, y sólo cuando el árbol publicable cambió. El número es
  `YYYY.MM.DD.N`: la fecha del commit de la sincronización y el orden en ese día, contando lo que ya traen `main` y
  `mirror/sync` (§«La publicación», «La versión»). El árbol del commit, y su trailer `Mirror-Tree`, es el final: el de
  la exportación más ese archivo.
- En el `--json` de `plan`, `first` y `sync`, `tree` es ese árbol final, `version` es el número y `exportedTree` es el
  árbol que dejó el exportador, sin el archivo.
- `verify` valida el archivo en una parte propia, la (i): contra los trailers de su sincronización y contra la regla
  del número. No exporta nada ni compara árboles, y un `main` que nunca trajo el archivo no es un hallazgo.
- La copia trae `scripts/setup/public-remotes.json`, con el que el programa de instalación reconoce un clon del
  público y sabe de qué repo baja la versión publicada (§«Los papeles»). Usar el arnés no necesita
  clon: la portada baja el guion por la API, sin credencial, y el guion instala la versión en `~/.tycon/harness`.
- Las dos ramas del repo público son los dos canales de instalación: `mirror/sync` es «al día» y `main` es «estable».
  Marcar estable es mergear el pull request de sincronización, sin etiquetas.

Si la publicación o el programa de instalación cambian algo de esto, cambia acá en el mismo commit. Red: una prueba
del repo del equipo busca cada punto en esta sección.

## Un solo repo interno

El arnés y agent-skills eran dos repos internos y pasaron a ser **uno**: el del arnés, con `agents/`,
`skills/` y `packs/` en su raíz y las dos historias unidas, sin reescribir ningún commit. Lo que se publica no cambia:
es el mismo árbol, y sus commits dicen lo mismo que antes. Cambia de dónde sale.

**Una fuente física, dos lógicas.** La lista blanca sigue partida por fuente (`arnes` y `agent-skills`), y las tablas
de esta guía también. En el repo único, la fuente de un archivo la dice su ruta: `agents/**`, `skills/**`, `packs/**`,
`.tycon/post-commit-ignore` y `.githooks/pre-commit-skills` son de `agent-skills`; todo lo demás, de `arnes`. El
repo ya trae un solo `.gitignore` y el pre-commit ya partido detrás de su despachador, así que `merged-gitignore` y
`merged-hooks` no tienen nada que juntar: lo que sale es lo que hay. Con dos repos físicos —las pruebas de juguete—
el exportador y la sincronización siguen como antes.

**Qué es el repo único** lo dice el árbol del commit del arnés que se publica, no el disco: si trae
`skills/tycon-pipeline/`, `agents/` y la lista blanca (`scripts/publishing/allowlist.json`) en la misma raíz, las dos
fuentes salen de ese commit. El exportador y `mirror.js` usan el mismo criterio —`mirror.test.js` los cruza—, y ahí
ninguno de los dos mira otro clon, diga lo que diga `TYCON_SKILLS_DIR`: en una máquina que todavía tiene el clon viejo
de agent-skills, la copia no sale de él. Un commit de antes de la unión no tiene esa forma, y se lee con dos repos.

**Un commit, dos trailers.** En el repo único `mirror.js` toma **un** commit, el del arnés —por defecto su `HEAD`—, y
lo usa para las dos fuentes:

- los dos trailers, `Mirror-Harness-Commit` y `Mirror-Agent-Skills-Commit`, nombran ese mismo commit;
- `version.json` conserva sus dos claves, `harness` y `agent_skills`, con el mismo valor;
- la fecha del commit de la sincronización es la de ese commit;
- `--agent-skills` sobra: si nombra otro commit, sale 2 diciendo los dos (de un repo no salen dos commits);
- el `--json` trae `singleRepo: true`, y la salida de texto dice «un solo repo interno».

Nada de lo publicado cambia de forma: un commit de la sincronización se sigue reconociendo por sus dos trailers, y
`verify` sigue comparando cada fuente de `version.json` con el suyo. Dejar un solo trailer queda para cuando se retire
el modo de dos repos.

**La primera sincronización después de la unión.** Lo publicado desde dos repos nombra dos commits internos
distintos, y los dos están en la historia unida. Por eso la sincronización desde el repo único lo reconoce como lo
anterior y arma su commit encima, con la punta pública de padre. Antes de leer las marcas de los cambios ajenos
comprueba que este repo tenga, en la historia de lo que publica, cada commit que nombra la sincronización anterior
(la última mergeada en `main` público, o la publicación raíz):

| La sincronización anterior nombra… | Qué pasa |
|---|---|
| el mismo commit, o uno anterior al que se publica | sigue: es lo normal |
| uno posterior al que se publica | sigue: es una corrida vieja, y la decide lo de siempre («hay una sincronización más nueva») |
| uno que este repo no conoce | 2, nombrando el commit y la causa —el clon es superficial, o la historia de agent-skills no está unida—, sin empujar nada |
| uno que conoce y que no está en la historia del que se publica | 2: se estaría publicando desde una rama que no trae lo ya publicado |

El motivo es el de siempre: en esa historia viven las marcas de los cambios ajenos ya traídos (§«Cambios ajenos»), y
lo que no se ve no es «no hay». Vale para `plan` y para `sync`. Qué hacer: correr desde un clon entero de `main` del
repo interno, que trae las dos historias (un clon superficial se completa con `git fetch --unshallow`). Con dos repos
físicos esta comprobación no corre.

El pipeline no declara el repo de agent-skills como recurso: lo que toca `agents/`, `skills/` o `packs/` se publica
como cualquier otro cambio (§«El pipeline de publicación»). Lo prueban dos casos de `scripts/tests/mirror.test.js`,
`Mirror_OneCommit_BothTrailersSame_VersionJsonShapeKept` y
`Mirror_FirstSyncAfterUnion_RecognizesPrevious_StopsIfUnknown`, con un repo único de juguete armado como el de verdad:
un merge de dos historias sin relación.

## La publicación

Hasta el corte a GitHub el exportador armaba la copia y `scripts/publishing/mirror.js` la llevaba al repo público y
absorbía los cambios ajenos (`plan`, `first` y `sync`). Desde el corte el repo público es la **fuente**: no hay copia
que llevar, y esa mitad del guion se sacó. `plan`, `first` y `sync` salen 2 diciendo que ya no existen.

Queda `verify`: clona lo publicado y lo revisa con la lista privada, con toda su historia. El repo que revisa es el de
`public-repos.json` —el único lugar con su nombre—, leído con `readPublicRepo()` de `export.js`. Se prueba sin red
contra un repo de mentira (`scripts/tests/mirror.test.js`) y lo corre solo su pipeline (§«El pipeline de
publicación»).

```bash
# lo publicado, contra la lista privada (sin token revisa lo que es público)
node scripts/publishing/mirror.js verify [--json] [--strict] [--report <archivo>] [--denied <f>] [--public-repos <f>]
```

**Empujar es instalar**. Las dos ramas del repo público son los dos canales de instalación:
`mirror/sync` es el canal «al día» (`latest`) y `main` el «estable» (`stable`). Marcar una versión estable **es**
mergear el pull request de sincronización: sin etiquetas ni releases. La consecuencia: quien pueda empujar a `main`
del interno, o cambiar el pipeline de publicación, llega a las máquinas que siguen el canal «al día» (§«La llave de la
App»). Como `mirror/sync` se reescribe en cada sincronización, se consume con una rama local y `reset`, no con
`pull`.

**Quien mergea** lo hace con el correo anónimo que GitHub le da a su cuenta (la forma `<id>+<usuario>@…`, con la
opción de mantener privado el correo), y el commit de merge queda firmado por el firmante automático de los commits
web de GitHub, que no es una persona. El nombre de quien mergea queda en la historia pública: su excepción —acotada
a la identidad de los commits, nunca al contenido ni a los mensajes— la escribe una persona.

**Qué mira `verify`.** Clona el repo entero, con **todas las refs que el servidor sirve** —ramas, etiquetas, las de
los pull requests y cualquier otra—, y revisa con el detector y la lista privada, todo en cero. Ante la duda mira de
más: lo que no se mira sale como limpio.

| Parte | Qué |
|---|---|
| (a) | el contenido de `main`, archivo por archivo |
| (a') | cada archivo de cada árbol alcanzable desde cualquier ref, **y el nombre de su ruta**: la historia pública conserva cada árbol mergeado y la lista aprende nombres nuevos |
| (b) | la lista de rutas de `main` |
| (c) | la identidad (autor y committer) y el mensaje de todos los commits y etiquetas —también las etiquetas anidadas, con el nombre que cada una declara—, el nombre de cada ref, y que el servidor no sirva ninguna ref de reemplazo |
| (d) | la descripción, el sitio y los temas del repo |
| (e) | el título, el cuerpo y la rama del pull request abierto de `mirror/sync` |
| (f) | ningún cambio ajeno sin absorber (§«Cambios ajenos») |
| (g) | ninguna alerta **abierta** del escaneo de secretos de GitHub (§«Alertas de prueba en GitHub») |
| (h) | con el repo público, el reporte privado de vulnerabilidades prendido, porque `SECURITY.md` lo ofrece como canal |
| (i) | el número de versión: el `version.json` de `main` y el de `mirror/sync`, cada uno contra su sincronización |
| (k) | las versiones: el título, la marca y las notas de cada una, la rama o el commit de donde se cortó, y el nombre de cada adjunto. Un adjunto subido es «sin leer»: su contenido no se baja |
| (l) | el título y el cuerpo de **todos** los pedidos y los issues, abiertos y cerrados; el nombre de la rama de cada pedido y el de su rama destino (siguen en la página del pedido con la rama ya borrada); lo que conserva la línea de tiempo —el título anterior de uno renombrado, una etiqueta o un hito ya borrados, el motivo con que se descartó una revisión—; y las etiquetas y los hitos del repo |
| (m) | los comentarios, de las cuatro clases: los de la conversación de un pedido o de un issue, los de revisión (en una línea del cambio, con el fragmento del cambio y la ruta que muestran), el cuerpo de cada revisión y los que se dejan sobre un commit (con la ruta del archivo, si la traen) |

**Las partes (k), (l) y (m)** son lo publicado que no es git: lo que un `gh` tecleado en una terminal o la web de
GitHub publican sin pasar por ningún freno de la máquina. Se leen por la API, y cada lista **hasta su última página**:
quedarse con la primera sería dar por limpio lo viejo, que es donde la lista aprende nombres nuevos. Una página que no
se pudo leer deja su parte en «no pude mirar» (2) y las otras se miran igual; lo mismo un elemento que no se puede
leer (no se saltea: salteado, la lista se daría por leída con uno menos). El lugar se dice por un número que dio
la API —el del pedido, el identificador del comentario—, nunca por un texto. Quedan afuera, a sabiendas, las
discusiones y la wiki: el repo no las usa y se apagan en su configuración.

Las revisiones no tienen una lista de todo el repo: la parte (m) las pide **pedido por pedido**, una llamada por cada
pedido que existió. Por eso las alertas de secretos y el reporte de vulnerabilidades —(g) y (h), dos llamadas— se leen
antes que estas listas: si un día el cupo de la hora no alcanza, (m) queda en «no pude mirar» y las alertas ya se
leyeron. Pasar a una consulta por lotes queda pendiente (para ese día faltan miles de pedidos).

**Hasta dónde llegó un archivo se dice por los commits que lo traen**, no por su objeto: un submódulo que estuvo en
`main` (su objeto es un commit de otro repo) sale como «llegó a main», y el nombre de una ruta que estuvo en `main` y
además está en una rama se dice una vez, con lo que hay que hacer para el sitio que más lejos llegó.

**La identidad con el correo `noreply` de GitHub no es un hallazgo** en la parte (c): es la identidad con que se
escribe en el público, y la misma que exige el freno al empujar (§«El freno antes de publicar»; la regla vive en el
detector, que comparten los dos).
Lo que sí se sigue mirando contra la lista son el nombre con que se firma y la cuenta que va adentro de ese correo.

**Con el público como fuente.** Las partes atadas a la sincronización desde lo interno —(f), (i) y (j)— comparaban
lo publicado con lo interno: ya no hay contra qué, y el informe las da siempre como «no aplica». Un commit del dueño
escrito directo en `main` no es un «cambio ajeno». La opción `--direct`, que antes las apagaba, se sigue aceptando y no
cambia nada.

**El informe: `--report <archivo>`** deja en un archivo lo mismo que `--json` —el veredicto, cada lugar con lo que hay
que hacer, lo que no se pudo mirar; nunca el texto hallado—, también si `verify` frenó antes de mirar nada. De ahí arma
su aviso el pipeline (§«El pipeline de publicación», «El aviso»).

Lo que no es un archivo se revisa bajo una ruta ficticia, que ninguna excepción por ruta de un archivo de verdad
cubre: `<commit-identity>` (la identidad de los commits: ahí vive la única excepción de nombre de persona, la de
quien mergea), `<commit-message>` (los mensajes y los nombres de las refs), `<pull-request>` (los textos del pull
request) y `<repository-about>` (la descripción, el sitio y los temas).

**La identidad de terceros en pull requests ajenos.** Un pull request de alguien de afuera trae commits con su
identidad de git de siempre, y el equipo no puede borrar esa ref. En los commits que cuelgan **sólo** de las refs de
pull requests, la identidad no se juzga con la regla genérica de correos; los términos de la lista sí se buscan ahí,
igual que en el mensaje y en el contenido. En lo alcanzable desde una rama, una etiqueta o cualquier otra ref no
cambia nada. La salida dice cuántos commits son, y el `--json` los cuenta en `pullOnlyCommits`.

**Refs de reemplazo.** Git deja declarar que un objeto se lea en lugar de otro (una ref de reemplazo). `verify` arma
su clon sin aplicarlas: lee el objeto publicado, no el que lo tapa. Y cada ref de reemplazo que el servidor sirve es
un hallazgo de la parte (c), de categoría `replace-ref`, tape algo o no: la salida la ubica por su número en
`git for-each-ref`.

**Un commit o una etiqueta que no se puede leer con certeza.** Cada uno se lee en UTF-8 y, si declara otra
codificación, también en ésa (lo declarado puede no ser lo escrito); una de 16 bits, en los dos órdenes de bytes. Si
la codificación no se puede leer —una que node no sabe leer, o bytes nulos sin una de 16 bits declarada—, su identidad
y su mensaje **no se dan por revisados**: la parte (c) queda en «no pude mirar» y `verify` sale 2. El motivo dice
cuántos objetos son y cuál es el primero.

La salida nombra parte, categoría y lugar (archivo y línea, o commit), **nunca el texto hallado**. Una ruta que es un
hallazgo no se imprime: si está en `main` la ubica la parte (b) por su número, y si no, la (a') por su objeto. Lo que
viene del repo se imprime saneado (arriba, «Lo que no se imprime»). Se refiere al repo
como «el repo de public-repos.json», sin su URL: el registro de una corrida no es un canal privado. Sale 1 con
hallazgos (§«Si `verify` da 1»), aunque además no haya podido mirar algo: dice las dos cosas. Sale 2 si no pudo mirar
alguna de (a) a (f) o la (i); con un clon interno superficial, la (f) queda en «no pude mirar». Y sale 0 si no hay hallazgos en lo que miró, con lo que no pudo medir —(g) sin un token que lea
alertas, (g) o (h) sin permiso— listado como «NO MEDIDO» en la salida y en `notMeasured` del `--json`, nunca callado.
Con `--strict`, cualquier «NO MEDIDO» es 2. En un repo privado —cualquiera, sea cual sea su plan: lo dice la
respuesta de GitHub— (g) y (h) no existen: salen como «no aplica» (`notApplicable`), no como «NO MEDIDO», y no
cuentan para `--strict`.

**Las claves de `--json`**, todas en inglés; el mensaje en castellano va en `message`:

- Toda corrida: `command`, `exit` y `message`, también cuando sale 0.
- `plan`: `state`, `harness` y `agentSkills` (`{ ref, sha }`), `singleRepo` (`true` si los dos salen de un
  solo repo interno, y entonces los dos `sha` son el mismo; viene también en `first` y `sync`), `warnings`, `tree`,
  `version`, `exportedTree`,
  `publicTip`, `counts` (`{ added, modified, deleted }`), `paths` (hasta 50, `{ status, path }`), `pathsOmitted`,
  `pathsHidden` (cuántas de las rutas listadas no se imprimen), `foreign` (`{ commit, paths, absorbed, discarded }`) y
  `replacements`.
- `tree`, `version` y `exportedTree`, en `plan`, `first` y `sync`: `exportedTree` es siempre el árbol que
  dejó el exportador, sin `version.json`. `tree` es el **final** —ése más `version.json`— y `version`, su número: lo
  que se publicaría (`unpublished`, `changes`) o lo que se publicó. En «sin cambios» son los de `main` (`version` es
  `null` si `main` salió sin el archivo). Son `null` cuando la corrida no llega a numerar: «cambios ajenos sin traer»
  y, en `sync`, «hay una sincronización más nueva». En `sync` sobre un repo sin publicar no vienen: esa corrida no
  exporta.
- `first` y `sync`: `outcome` —`published` en `first`; `unpublished`, `unchanged`, `newer-sync`, `foreign-changes`,
  `synced` o `incomplete` en `sync`; `rejected` en los dos—. `sync` trae además lo de `plan`, y `syncTip`, `commit`,
  `pushed` y `pullRequest` (`{ number, action }`, con `action` = `created`, `updated`, `unchanged` o `closed`). Con
  `incomplete`, `pullRequest` es `null` (no quedó ninguno abierto) o trae `action` = `not-updated`, `commented` o
  `not-closed`, y `closed` lista los que esa corrida sí llegó a cerrar. `first` trae `commit`, `tree`, `version`,
  `exportedTree`, `replacements` y `verify`, con el resultado de su `verify --strict`.
- `verify`: `strict`, `private`, `findings` (`{ part, category, place }`), `notMeasured`, `notApplicable` y
  `couldNotLook` (`{ part, reason }`), `looked` y `pullOnlyCommits` (un número; `null` si no pudo mirar el clon).
- Cuando frena: `exporter`, `secretShapes` (`{ file, line, rule, masked }`), `rules` (`{ missing }`), `textFindings`
  o `push`.

**Los carriles de la organización.** Cada merge a `main` del repo interno y cada empuje nocturno encolan una corrida
del pipeline de publicación, y la organización de Azure DevOps del equipo tiene pocos carriles (trabajos
simultáneos): la publicación compite con los nocturnos y con el control de cada pull request. Apagada, se espera que
la corrida dure alrededor de medio minuto y no haga fila en el candado: el pipeline todavía no corrió, y eso no está
medido (§«El pipeline de publicación», «Lo que todavía no está medido»). Prendida, una corrida que no cambia el árbol
termina en «sin cambios» después de exportar (medido sin el pipeline: entre 40 segundos y algo más de dos minutos), y
corre una por vez. Las exclusiones del exportador no se copian al pipeline para filtrar disparos: serían
dos listas que se separan solas. Si los carriles molestan, se mide primero con la primera sincronización de verdad y
se resuelve en una story aparte.

## El pipeline de publicación

`mirror.js` no se corre a mano: lo corre el pipeline de publicación del equipo, registrado
en Azure DevOps como `publicacion-espejo`. Así nadie tiene la credencial en su máquina y nadie empuja al repo público
por su cuenta. El archivo no nombra el repo destino: es el de `public-repos.json`.

**Cuándo corre**

- Todos los días a las 09:00 UTC, después del tablero.
- A mano, eligiendo el modo.

**Un merge a `main` del repo interno no lo dispara** (`trigger: none`, desde poco después del corte). Hasta el corte a GitHub
lo disparaba cada merge, en ráfaga y sin filtro de rutas: el interno era la fuente y cada cambio tenía que llegar a la
copia. Desde el corte la fuente es el público, y aquel disparo sólo encolaba corridas que terminaban en la guarda sin
hacer nada (47 el 2026-10-13). Volver a escribir en el interno —la vuelta atrás del corte— es también volver a poner el
disparo, sin filtro de rutas: copiar al pipeline las exclusiones del exportador serían dos listas que se separan solas.
El control de disparadores del arnés (`scripts/ci/check-trigger-without-docs.js`) mide los pipelines de los productos,
que construyen y piden producción; éste no hace ninguna de las dos cosas y no está en su lista. Corrido a mano sobre
este YAML (`--file`) da 2: con `trigger: none` no tiene nada que medir. Queda fijado en
`scripts/tests/trigger-without-docs.test.sh` y en la prueba del pipeline (abajo, «El contrato»): quien le vuelva a poner
un disparo tiene que hacerlo a propósito.

**Los modos** (el parámetro `mode`)

| `mode` | Qué corre | Quién lo encola |
|---|---|---|
| `sync` (por defecto) | En la corrida diaria, `mirror.js verify --strict`. A mano, nada: sale 2 (no se sincroniza desde lo interno) | los disparos automáticos |
| `verify` | `mirror.js verify --strict` | una persona |
| `plan`, `first` | nada: salen 2. Eran el ensayo y la primera publicación, de cuando el público era una copia | — |

Desde el corte el grupo de variables trae el modo directo (`TYCON_MIRROR_DIRECT=1`): el pipeline sólo verifica, y
`mirror.js` ya no tiene otra cosa que hacer.

La corrida diaria es la única que mide sola las alertas del escaneo de secretos de GitHub: hace falta el token, y el
banco nocturno no lo tiene ni lo debe tener. Por eso verifica aunque la sincronización esté frenada por un cambio
ajeno.

**Con la publicación apagada, la corrida diaria no verifica.** Es una corrida automática: termina en su primera etapa
(abajo, «El encendido»). Pasa en dos momentos: entre que el repo se hace público y el encendido, y durante un
incidente, mientras la publicación está apagada (§«Si `verify` da 1»). En los dos, las alertas se miden encolando
`mode: verify` a mano, que no mira el encendido. Si nadie lo encola, nadie las mide.

**Los frenos, en el orden en que corren**

1. **La primera etapa no baja nada ni toca la llave.** Sale 2 si la corrida no es de `refs/heads/main`. Sale 2 si
   `first` o `plan` no fueron encolados a mano.
2. **El encendido.** Una corrida automática termina en esa primera etapa, en verde y con el aviso «publicación
   apagada», si la variable `TYCON_MIRROR_ENABLED` no es exactamente `1`. Las corridas a mano no miran esa variable:
   por eso el ensayo y la primera publicación se pueden hacer con la publicación apagada.
3. **Una corrida apagada no hace fila.** La segunda etapa, la que usa el candado y la llave, sólo arranca si la
   primera dijo que sí. Que Azure no pida el candado para una etapa que se saltea es lo que se espera: todavía no
   está medido (abajo).
4. **Una corrida por vez.** El entorno `publicacion-github` tiene un candado exclusivo, y las corridas esperan en
   orden: ninguna se saltea.
5. **El commit que se publica tiene que estar en `main`.** Se comprueba en el clon, antes de bajar la llave. El
   pipeline no le pasa ningún commit a `mirror.js`, que exporta el de su propio clon: con un solo repo interno, ese
   commit es el de las dos fuentes (§«Un solo repo interno»).
6. **Sin configuración por opción.** `mirror.js` publica con los archivos de `scripts/publishing/` de ese mismo
   commit. El pipeline no le pasa `--allowlist`, `--replacements`, `--denied` ni `--public-repos`.
7. **Ambiente sellado.** Los dos guiones que usan la credencial —el que pide el token y `mirror.js`— corren con una
   lista cerrada de variables: `PATH`, `HOME` y lo suyo (las tres variables del token para uno; la carpeta temporal
   y el token para el otro). De todo lo demás que tenga el paso no les llega nada: ni otra base de la API o de git
   —por ahí saldrían la firma de la llave o el token hacia otro servidor—, ni otra ubicación de los repos internos,
   ni opciones de node, ni intermediarios o certificados. Es una lista de lo permitido, no de lo prohibido: una
   variable que un guion empiece a leer mañana tampoco llega. `PATH` y `HOME` sí se heredan, porque sin ellos no hay
   `node` ni agent-skills. Lo que impide cambiarlos al encolar es una opción del proyecto; lo que impide cambiarlos
   por adentro —una variable agregada al grupo o a la definición del pipeline llega al paso antes de que se selle
   el ambiente— son los permisos (abajo, «Qué necesita en Azure DevOps»).
8. **El encendido se mira dos veces**: en la primera etapa y, de nuevo, en el paso que corre `mirror.js`. Ese paso
   repite los frenos de la primera etapa menos el de la rama, que lo cubre el punto 5. Relanzar la segunda etapa de
   una corrida vieja no reusa el «sí» de aquella vez: si la publicación está apagada, el paso termina en verde, con
   el aviso y sin llamar a `mirror.js`. A mano no lo mira, igual que la primera etapa. Ese segundo vistazo llega
   después de pedir el token: una corrida que se apaga entre uno y otro no publica, pero el token ya se emitió. No
   se revoca: vence solo, en una hora.
9. **No escribe en lo interno.** Saca una foto antes y otra después (el commit y el estado del árbol de trabajo), del
   clon y de la ruta donde se busca agent-skills —`~/.claude/agent-skills`, que con un solo repo interno es un enlace
   al mismo clon—; si difieren, la corrida queda roja. El clon no guarda la credencial de Azure.
10. **Un 1 o un 2 de `mirror.js` deja la corrida en rojo**, con su resumen en el registro del paso. Ningún paso
    tolera fallos.
11. **Tres frenos defensivos**, para que la corrida no decida a ciegas ni quede colgada. Si Azure no informa cómo
    se encoló la corrida, sale 2 la primera etapa, y también el paso que corre `mirror.js`. Si la ruta donde se
    busca agent-skills no es un repo con la historia entera y con `origin/main`, sale 2 antes de bajar la llave
    (con un solo repo interno esa ruta lleva al clon, que ya se bajó entero: el paso queda mientras la plantilla
    compartida no lo garantice ella misma). Y cada etapa tiene un tope de tiempo: 5 minutos la primera y 45 la
    segunda.

**Lo que no sale de la corrida.** El token se registra como secreto antes de cualquier eco, y ningún paso deja rastro
de lo que ejecuta. A `mirror.js` le llega por una tubería, no en un argumento: un argumento lo ve cualquier proceso
de la máquina. La llave es un archivo seguro, y sólo la usa el paso que pide el token: ese paso la borra apenas
volvió el guion, haya salido bien o mal, y también si lo cortan en el medio. No espera al final del trabajo. Si la
llave no se deja borrar, el paso sale 2 **sin registrar el token**. El listado privado de reemplazos queda en la
carpeta temporal de `mirror.js`, que se borra al final: el pipeline no sube ningún artefacto.

**Qué necesita en Azure DevOps**

- El grupo de variables `publicacion-github`: `TYCON_MIRROR_APP_ID`, `TYCON_MIRROR_INSTALLATION_ID` y
  `TYCON_MIRROR_ENABLED`.
- El archivo seguro `publicacion-github.private-key.pem`: la llave de la App (§«La llave de la App»).
- El entorno `publicacion-github`, con su candado exclusivo.
- Los tres autorizados **sólo** para este pipeline. El archivo y el grupo tienen además control de rama: sólo se
  entregan a una corrida de `refs/heads/main`. Ese control es el que vale. El freno del punto 1 está para que la
  corrida diga por qué termina, pero el YAML de una rama se puede editar.
- El pipeline no declara ningún repositorio de otro proyecto como recurso: el permiso que tenía
  para leer el repo de agent-skills ya no hace falta y se puede retirar. Que Azure dejó de pedirlo se mira en su
  primera corrida sobre `main` después de la unión.
- **Al darlo de alta**, antes de la primera corrida, tres cosas más:
  - El proyecto tiene que limitar las variables que se pueden fijar al encolar una corrida (en Azure DevOps, «Limit
    variables that can be set at queue time»): es lo que protege al encolar a `PATH` y `HOME`, que los dos guiones
    de la credencial heredan. Medido el 2026-10-03: el proyecto ya las limita.
  - El permiso de **encolar** corridas de este pipeline queda sólo para el dueño del arnés, negado a las cuentas de
    servicio de los otros pipelines. El motivo: una corrida a mano de `sync` o de `first` no mira el encendido, y
    para Azure «a mano» es también una corrida que encola otro pipeline o la API.
  - Sólo el dueño del arnés puede **editar** el pipeline y **administrar** el grupo de variables, el archivo seguro
    y el entorno; negado a las cuentas de servicio. El motivo: una variable agregada al grupo o a la definición del
    pipeline llega al paso antes de que se selle el ambiente, con la llave y el token a mano.

**El modo directo.** Desde el corte el público es la fuente, y sincronizar desde lo interno sería pisarlo. Lo prende
`TYCON_MIRROR_DIRECT=1` en el grupo de variables (o, para una corrida a mano, el parámetro `direct`). Con él:

- la corrida diaria **no sincroniza**: corre sólo `verify --strict --direct`, y lo hace aunque la publicación esté
  apagada —`TYCON_MIRROR_ENABLED` apaga publicar, no mirar—;
- `mode: verify` corre lo mismo; `sync` a mano, `first` y `plan` salen 2;
- un merge a `main` del repo interno no publica nada: la corrida termina en su primera etapa, en verde.

El modo se lee dos veces, como el encendido: en la guarda y otra vez en el paso que corre `mirror.js`.

**El aviso.** Toda verificación que corre deja su informe en la carpeta temporal de la corrida, y el paso «Avisar lo
que encontró la verificación» —que corre aunque el anterior haya fallado— le manda al dueño del arnés, por Telegram,
lo que encontró: cada lugar (nunca el texto hallado) y qué hacer con él, con lo que hay que rotar primero. **En verde
calla.** También avisa un «no pude mirar», y una verificación que falló sin dejar un informe que se pueda leer: eso no
es «limpio» —tampoco lo es un 0 sin informe—. Y si la corrida **tenía que verificar** y la verificación no dejó ni su
código (el paso anterior falló, la cortó el tope del trabajo), avisa igual: ése es el silencio que más cuesta. Si había
algo que avisar y el aviso no salió, el paso es **rojo** y lo dice. **Con el repo privado**, lo que quedó sólo en la
historia de `main` —que ahí se acepta (§«Si `verify` da 1»)— no dispara el aviso: se cuenta en el registro del paso, y
el aviso sale sólo si hay algo más (otro hallazgo, un secreto, algo que nadie leyó —un binario sin permiso, un
submódulo—, una parte sin mirar), diciendo cuántos quedaron aparte. Un aviso de todas las noches por algo que no tiene
arreglo se deja de leer. La verificación no cambia: mira lo mismo y la corrida sigue roja. El texto lo arma
`scripts/ci/verify-notice.js`; lo manda `scripts/lib/tycon-telegram-notify.sh`, con `TELEGRAM_BOT_TOKEN` (secreta) y `TYCON_TELEGRAM_CHAT_ID` del grupo
de variables de este pipeline. Los dos corren con el ambiente sellado: al que arma el texto no le llega la credencial,
y al que manda no le llega otra cosa que la credencial y el chat (ni otra base de la API de Telegram). Los otros nocturnos
avisan con un pedido; acá no hay pedido que abrir, y lo publicado no se retira solo.

**Cómo se apaga y cómo se prende.** `TYCON_MIRROR_ENABLED` en el grupo de variables: `1` prende, cualquier otro valor
apaga. Apagada, cada merge sigue dando una corrida que termina en su primera etapa; se espera que dure alrededor de
medio minuto, todavía sin medir. Apagada tampoco corre la verificación diaria (arriba, «Los modos»). Es el paso 2 de
§«Si `verify` da 1».

**Cómo se encola a mano**

```bash
# <id>: el número del pipeline publicacion-espejo en Azure DevOps
az pipelines run --id <id> --branch main --project tycon-claude-guides --parameters mode=plan
```

Encolar una corrida la decide el dueño del arnés. Una corrida vieja relanzada no hace retroceder el pull request:
`mirror.js` ve que la rama ya trae una sincronización más nueva y termina sin tocar nada.

**Una corrida en rojo.** El paso que falló dice cuál fue el código de `mirror.js`. Con 1 hay hallazgos: un cambio
ajeno sin traer (§«Cambios ajenos»), algo que el exportador no deja salir, un empuje que GitHub rechazó, o los de
`verify` (§«Si `verify` da 1»). Con 2 no pudo: faltó una precondición o GitHub no contestó. El registro dice dónde,
nunca el texto hallado.

Los frenos del propio pipeline dicen por qué terminan, antes de llegar a `mirror.js`:

| Mensaje | Qué pasó | Cómo termina |
|---|---|---|
| «publicación apagada: TYCON_MIRROR_ENABLED no es 1…» | una corrida automática con la publicación apagada. Si agrega «la guarda la dejó pasar; al volver a mirar, está apagada», lo dijo el paso que corre `mirror.js` | verde, con aviso |
| «La publicación sólo corre desde refs/heads/main…» | la corrida es de otra rama | 2 |
| «No sé cómo se encoló esta corrida (Build.Reason vacío)…» | Azure no informó el motivo de la corrida: ni la primera etapa ni el paso que corre `mirror.js` deciden a ciegas | 2 |
| «mode: … sólo se encola a mano» · «mode desconocido…» | `first` o `plan` en una corrida automática, o un modo que no existe | 2 |
| «El commit bajado del arnés … no está en main…» | el clon no bajó un commit de `main` | 2 |
| «El clon de AgentSkills no tiene origin/main…» | la ruta donde se busca agent-skills no trae `origin/main` (con un solo repo interno, el propio clon) | 2 |
| «No se pudo pedir el token de la App…» | el guion del token falló; su motivo está arriba en el registro | 2 |
| «No pude borrar la llave de la App después de usarla: el token no se registra y la corrida termina acá» | la llave quedó en el disco | 2 |
| «La corrida cambió un repo interno…» | la foto de después no es igual a la de antes | 1 |

**El contrato.** Una prueba del repo del equipo, `mirror-pipeline.test.sh`, lee el yml y además **corre sus pasos**, sacados por su
`displayName`, con un `node` de mentira y repos de juguete. Por eso los guiones del yml leen todo del ambiente y no
llevan macros de Azure adentro: lo que corre la prueba es, letra por letra, lo que corre Azure. Quien cambie un paso
corre esa prueba. No viaja en la copia: prueba un archivo que queda afuera.

**La prueba fija la forma del yml**, por listas cerradas: las claves de la raíz, de cada etapa y de cada trabajo, y
los pasos de cada trabajo uno por uno, en su orden y con todas sus claves. Lo que no reconoce frena: un paso escrito
con otra clave que `script:`, un paso de más, una variable declarada fuera de la raíz, una condición en el paso del
token, un parámetro de más en la plantilla, un comando al agente que no sea de los dos que el yml usa. El costo es a
propósito: **agregar un paso, una clave o un parámetro al pipeline obliga a tocar la lista de la prueba**. De los
dos pasos que usan la credencial mide además qué variables le llegan a `node` —la lista entera, no una muestra—,
que la llave no queda en el disco y que el encendido se vuelve a mirar.

**Lo que la prueba sigue sin ver**: un `git` armado por partes (el nombre del comando guardado en una variable);
algunas diferencias de lectura entre su lector y el de python, que con la forma fijada no cambian ningún veredicto;
y lo que Azure hace con el yml (abajo). Antes de la primera corrida de un cambio:

```bash
bash scripts/tests/mirror-pipeline.test.sh
node scripts/ci/check-tolerant-steps.js pipelines/azure-pipelines-public-leak-check.yml
node scripts/ci/check-stage-dependencies.js pipelines/azure-pipelines-public-leak-check.yml
# contra Azure, sin ejecutar ni hacer cola
bash scripts/ci/validate-pipeline-in-ado.sh --project tycon-claude-guides --pipeline <id> \
  --yaml pipelines/azure-pipelines-public-leak-check.yml
```

**Lo que todavía no está medido.** La prueba corre los pasos, no a Azure. Lo que sigue sólo se ve en una corrida de
verdad, y no todo en la misma:

- **En la primera corrida a mano, `mode: plan`** (un ensayo: no escribe nada): en qué carpeta trabaja un trabajo de
  despliegue; si Azure tacha el token en la misma línea que lo registra; si a `node` y a git les falta alguna
  variable con el ambiente sellado (no se les pasa ninguna de idioma); y si la limpieza propia de la tarea que baja
  la llave, al final del trabajo, tolera que la llave ya no esté. Y, encolada desde otra rama —la prueba del control
  de rama—, si ese control frena la corrida antes que el freno del punto 1 (da rojo igual, sin su mensaje).
- **En la primera corrida automática con la publicación apagada** (el primer merge a `main` después del alta): que
  la etapa salteada no pide el candado ni la llave. Una corrida a mano no lo muestra: no mira el encendido, y su
  segunda etapa nunca se saltea.
- **En la primera corrida sobre `main` después de la unión de los dos repos**: que Azure ya no pida
  autorizar el repositorio del otro proyecto; que la plantilla compartida deje `~/.claude/agent-skills` como un enlace
  al clon, con la historia entera; y que `mirror.js` diga «un solo repo interno» y nombre un solo commit.
- **Al relanzar a mano la segunda etapa de una corrida vieja**: si el paso que corre `mirror.js` lee el valor de hoy
  del encendido. El yml lo vuelve a mirar ahí (punto 8); de que Azure le dé el valor de hoy depende que sirva.

## Cambios ajenos

*Esta sección es de antes del corte a GitHub: hoy el público es la fuente y `verify` da la parte (f) como «no aplica».
Queda para entender lo publicado hasta entonces.*

El interno era la fuente. Un **cambio ajeno** es un commit del `main` público que no salió de una sincronización: cada
commit de la cadena de primer padre de `main` que la última sincronización mergeada no contiene —un merge cuyo segundo
padre es un commit de la sincronización, o la publicación raíz— y que no es él mismo una sincronización mergeada.
Aparece cuando alguien mergea en GitHub otro pull request o edita un archivo desde la web.

`mirror.js` reconoce un commit de la sincronización por su forma, no por su origen: alcanza contra el descuido, no
contra un pull request armado a propósito para parecerse a uno. Por eso **en GitHub se mergea sólo el pull request de
sincronización**, nunca otro; la comprobación de origen todavía no existe.

Los cambios ajenos se absorben, no se comparan. Uno está **absorbido** cuando su sha aparece en una marca
`Public-Commit:` de algún commit de la historia interna (del arnés o de agent-skills), hasta los commits que se
publican. La marca dice que el interno ya decidió qué hacer con ese cambio: traerlo o descartarlo.

- **Sin absorber**: `plan` dice `foreign-changes` y sale 1; `sync` sale 1 con «cambios ajenos sin traer», el sha, las
  rutas y la marca que falta, sin empujar ni abrir nada; y `verify` lo cuenta como hallazgo en su parte (f).
- **Con un clon interno superficial** no se puede saber: una marca puede estar en la historia que el clon no trajo.
  `plan` y `sync` salen 2 («no pude leer la historia») y `verify` deja la parte (f) en «no pude mirar».
- **Todos absorbidos**: `sync` sigue normal. El commit nuevo tiene como padre la punta pública, que ya los contiene, y
  su árbol es la exportación. Si lo absorbido quedó distinto en el interno, el pull request lo muestra y el público
  vuelve a ser igual al interno.

**Cómo se pone la marca a mano.** Los dos comandos que la escriben, `import --commit <sha>` e
`import --commit <sha> --discard "<motivo>"`, todavía no existen. Hasta entonces la marca se escribe a mano en un
commit del interno, y `sync` la lee igual: no le importa quién la puso. Es la salida para cuando el repo ya es público
y esos comandos todavía no existen.

- **Para traer el cambio**: se hace el mismo cambio en el repo interno donde vive el archivo, por el camino de
  siempre (rama, hooks, pull request), y el commit lleva la marca:

  ```bash
  git commit -m "fix: lo que arregla el cambio" --trailer "Public-Commit: <sha completo del commit público>"
  ```

- **Para descartarlo**: un commit vacío con las dos marcas, la del sha y la del motivo:

  ```bash
  git commit --allow-empty -m "chore: descarta un cambio ajeno del repo público" \
    --trailer "Public-Commit: <sha completo del commit público>" \
    --trailer "Public-Commit-Discarded: <motivo, en una línea>"
  ```

  La sincronización siguiente lo deshace en el público: el pull request muestra la vuelta atrás.

Cinco cuidados. `mirror.js` busca la marca en cualquier línea del mensaje: tiene que ir **sola en su línea** y con
el sha **completo** (el corto no cuenta); `--trailer` la deja así, y además como trailer de git. La del descarte va en
el **mismo commit** que la del sha (en `--json` sale como `discarded`). La marca cuenta cuando su commit está en la
historia que se publica: mergeado a `main` del interno. Va una marca por cada commit ajeno, con su sha. Y poner la
marca sin traer el cambio **es** descartarlo: el público vuelve a quedar igual al interno, así que el descarte se
escribe con su motivo.

Lo que evita llegar acá: en GitHub no se mergea ningún pull request que no sea el de sincronización. Una contribución
de afuera entra al interno y vuelve por la sincronización; el comando que la trae (`import`) tampoco existe todavía.

## Si `verify` da 1

Primero, qué parte dio 1 (la salida la nombra). Dos no son un nombre ni un secreto publicado, y tienen su salida
propia: (g), una alerta abierta del escaneo de secretos (§«Alertas de prueba en GitHub»; si el secreto es de verdad,
sigue acá), y (h), el reporte privado de vulnerabilidades apagado, que se prende en la configuración del repo. Las
partes (f), (i) y (j) ya no dan 1: con el público como fuente no corren (§«La publicación»).

Las demás —(a) a (e), y (k), (l) y (m)— dicen que en lo publicado hay algo que la lista privada no deja salir: un
nombre real, un correo o un secreto, en el contenido, en una ruta, en la historia, en la identidad o el mensaje de un
commit, en un texto del repo, o en una versión, un pedido, un issue o un comentario.

**Cada hallazgo dice qué hacer**, en el renglón de abajo de su lugar (y en el aviso que llega por Telegram). Depende
de hasta dónde llegó lo hallado, no de qué es:

| Hasta dónde llegó | Qué se hace |
|---|---|
| Es un secreto, esté donde esté | **Se rota primero**: publicado, se da por comprometido. Después, lo que diga su fila |
| Cuelga sólo de una rama o de una marca | Se borra esa rama o esa marca: con eso deja de servirse |
| Está en una versión (su título, sus notas, un adjunto) | Se borra la versión, o el adjunto |
| Llegó a `main` | Se saca, y además se pide la purga al soporte de GitHub |
| Está en un pedido —en sus commits, su título, su cuerpo— | Se cierra el pedido y se borra su rama, y además se pide la purga: la referencia del pedido lo sigue sirviendo aunque la rama no esté |
| Está en un issue o en un comentario | Se borra o se corrige, y además se pide la purga: GitHub guarda el historial de ediciones |
| Está en la descripción, un tema, una etiqueta o un hito | Se corrige en la configuración del repo |

Qué más se hace depende de si el repo ya es público:

**Con el repo privado: no se recrea nunca**. Lo que se escapó se arregla en el
interno y sale de lo publicado con la sincronización siguiente; en la historia del repo privado queda, y eso se acepta.
Si lo que se escapó es un secreto (una clave, un token, una contraseña), se rota el secreto: el repo no se toca.
Ninguna story, tarea ni revisión pide recrearlo por algo que ya se publicó. Mientras el repo es privado, el renglón de
«qué hacer» de cada hallazgo dice esto mismo —no pide la purga, que es para lo que ya es público— y el aviso por
Telegram cuenta aparte lo que quedó sólo en la historia de `main`.

**Se recrea una sola vez: al pasarlo a público.** Lo público nace vacío, sin la historia del privado (el corte
abierto va sin historial), y `first` se corre con el interno ya limpio. Nunca se pasa a público un repo
con historia previa ni uno que dio 1.

Recrearlo tiene **dos pasos que no son obvios** (medido en una corrida del pipeline de publicación):

1. **La App queda desinstalada.** Está instalada sólo en ese repo; al borrarlo, GitHub le quita la instalación entera
   a la organización (la página de la instalación da 404 y `orgs/<org>/installations` devuelve cero). El pipeline falla
   en «Pedir el token de la App» con «la API contestó 404 al pedir el token (se esperaba 201)». La reinstala **el dueño
   de la organización**, desde la página de la App → «Install» → «Only select repositories» → el repo recreado. El
   token de `gh` de una persona no puede hacerlo: sumar un repo a una instalación pide otro tipo de credencial.
2. **La instalación nueva trae otro número.** Hay que ponerlo en `TYCON_MIRROR_INSTALLATION_ID` del grupo de variables
   `publicacion-github` (se lee con `gh api orgs/<org>/installations`). La llave de la App y `TYCON_MIRROR_APP_ID` no
   cambian.

Después, en este orden: `mode: plan` a mano (tiene que decir «no publicado»; comprueba el token y la exportación sin
escribir nada) y recién entonces `mode: first`. Antes de borrar el repo conviene comprobar que el dueño está para el
paso 1: sin él, la publicación queda frenada.

**Con el repo público**, en este orden:

1. Si lo hallado es un secreto, **primero se revoca** en su proveedor. Publicado, ya está comprometido.
2. Se apaga la publicación: `TYCON_MIRROR_ENABLED=0` en las variables del pipeline de publicación (con cualquier
   valor que no sea `1`, las corridas automáticas terminan en su primera etapa: §«El pipeline de publicación»).
   Apagada tampoco corre la verificación diaria: mientras dure, `verify` se encola a mano (`mode: verify`).
3. Nadie mergea el pull request de sincronización abierto.
4. Se arregla en el interno, por el camino de siempre.
5. Decide **el dueño del arnés**, entre las dos salidas que hay: crear el repo de nuevo —se pierden los issues, las
   estrellas y los pull requests— o pedirle a GitHub que purgue sus copias.

Si lo hallado es el **nombre de una ruta** que la lista aprendió después de publicada, el arreglo del interno —borrarla
o renombrarla— llega al público con una sincronización, que la saca de `main` sin nombrarla (§«La publicación», «Una
ruta cuyo nombre hay que ocultar»). El nombre sigue en la historia, y la parte (a') lo sigue diciendo: la decisión del
paso 5 hace falta igual.

Dos casos de la parte (c) tienen su salida propia. Una **ref de reemplazo** (categoría `replace-ref`) se borra del
repo público —la borra quien lo administra—, y `verify` vuelve a 0: lo publicado no cambió, sólo se dejó de tapar. Y
un commit o una etiqueta con una **codificación que no se puede leer** no da 1 sino 2 («no pude mirar»): `verify`
sigue en 2 hasta que ese objeto deje de ser alcanzable desde alguna ref.

La historia pública **no se reescribe**: el ruleset de `main` prohíbe el force push, y una copia que alguien ya
descargó no se retira. Por eso el filtro es lo que corre antes de empujar (§«La publicación», «Empujar es publicar») y
`verify` mira lo que GitHub sirve, con toda su historia.

## Alertas de prueba en GitHub

GitHub escanea los repos públicos buscando valores con forma de secreto de un proveedor (una llave, un token), y no
lee la lista de excepciones del equipo (`permitidos`). En un repo privado del plan gratis no escanea: el primer
escaneo llega al pasarlo a público, que no tiene vuelta. Las pruebas del arnés siembran valores así a propósito, para
probar que algo se detecta o se enmascara.

- **Lo que lo evita**: el control de formas de secreto de proveedor de `plan`, `first` y `sync` (§«La publicación»),
  que no acepta excepciones. Un valor de prueba **se arma por partes** —dos literales unidos, de modo que ninguna
  línea del archivo traiga el valor entero—, y en ejecución da lo mismo.
- **Si igual aparece una alerta por un valor de prueba**: en GitHub, en la pestaña de seguridad del repo, se abre la
  alerta del escaneo de secretos y se cierra con el motivo «used in tests» y un comentario. Lo hace una persona con
  permiso sobre el repo, no la App (su permiso sobre las alertas es de sólo lectura). Después el valor se arma por
  partes en el interno, para que la sincronización siguiente no lo lleve entero.
- **La parte (g) de `verify` cuenta sólo las alertas abiertas**: una cerrada como «used in tests» deja de contar. Sin
  un token que lea alertas, (g) sale «NO MEDIDO», nunca «limpio».
- **Si GitHub rechaza un push de `sync`** por su protección contra secretos: `sync` sale 1 con el mensaje de GitHub,
  nombra el archivo que GitHub cita y no reintenta. El valor se arma por partes en el interno y la sincronización
  siguiente sale limpia.
- **Si el secreto es de verdad**, no es una alerta de prueba: primero se revoca, y sigue §«Si `verify` da 1».

## Cómo se cambia el nombre público

El nombre del repo público es provisorio. La publicación lo lee de un solo lugar:
`public-repos.json`, que no viaja en la copia. Cambiarlo son tres pasos, en este orden:

1. **Renombrar el repo en GitHub.** GitHub redirige la URL vieja para git y para la API, y la instalación de la App
   sigue al repo: mientras tanto la sincronización sigue andando.
2. **Cambiar la línea de `public-repos.json`**, en un commit del interno.
3. **Actualizar las guías que lo nombran** en prosa.

Para la publicación, cambiarlo **no toca código**: `mirror.js` y `github-app-token.js` lo leen con `readPublicRepo()`
de `export.js`, y los papeles lo escriben con los marcadores `{{public-org}}` y `{{public-repo}}` (§«Los papeles»). La
copia publicada se reconoce a sí misma por su remoto (`scripts/lib/harness-repo.js`), no por su nombre. Lo prueba
`Mirror_RenamePublicRepo_OnlyTheFileChanges` de `scripts/tests/mirror.test.js`: con sólo esa línea cambiada, `plan`,
`sync` y el pedido del token apuntan al repo nuevo.

Que el nombre no se cuele en otro lado lo cuida `MirrorPipeline_PublicNameOnlyInOneFile`, de
`mirror-pipeline.test.sh`: recorre todo lo versionado de lo interno que no es prosa —todo
menos los `.md` y los binarios, no una lista de extensiones— y frena si algún archivo lo trae. Con un solo repo
interno es una pasada, que ya trae `agents/`, `skills/` y `packs/`; con dos repos, una por repo. Ningún archivo lo
trae escrito como dirección del repo. Doce que ya lo traían como etiqueta del producto o como nombre de una carpeta
—el instalador, sus pruebas, las de la portada, dos archivos de la prueba de la máquina limpia y un comentario de
planificación— están declarados ahí como excepción, cada uno con su motivo. La prosa que puede nombrarlo es la de
los `.md`: un `.txt` o un `.html` versionado, no.
Con el nombre nuevo esas excepciones dejan de hacer falta y la prueba lo avisa, sin frenar: sacarlas queda
pendiente. Hasta entonces, cambiar el nombre pide un cuarto paso:
una prueba del repo del equipo compara el archivo contra el nombre escrito en ella, y hay que cambiarlo
ahí también.

## La llave de la App

La credencial de la publicación es una GitHub App de la organización, no el token personal de nadie: el pull request
lo abre la App, y por eso lo puede aprobar una persona (nadie aprueba un pull request propio). La App está instalada
sólo en el repo público, con los permisos que usa la sincronización: contenido, pull requests y workflows (escritura),
y metadatos, administración, alertas del escaneo de secretos e issues (lectura). El de issues es de la verificación:
sin él no puede leer la lista de pedidos e issues ni su línea de tiempo.

Una App no tiene un token fijo: tiene una **llave privada**. Con ella `scripts/publishing/github-app-token.js` le pide
a GitHub, una vez por corrida, un token de instalación limitado al repo de `public-repos.json` y a esos permisos, que
vence solo en una hora. Los pide **por nombre**: un permiso que se le suma a la App no llega a la corrida hasta que
se suma también a la lista de ese guion (y uno que se le suma a la App de más, tampoco). Lee `TYCON_MIRROR_APP_ID`,
`TYCON_MIRROR_INSTALLATION_ID` y `TYCON_MIRROR_APP_KEY_FILE` (el
archivo de la llave) y, con `TYCON_MIRROR_API_URL`, otra base de la API (sin cifrar sólo hacia la propia máquina, para
las pruebas). Imprime el token solo, por la salida estándar, para que quien lo llama lo capture y lo registre como
secreto; toda falla sale 2 con el motivo, sin la llave ni el token. `mirror.js` lo recibe en `TYCON_MIRROR_TOKEN`.

La llave se guarda en un solo lugar, como archivo seguro de Azure DevOps, y no queda copia en ninguna máquina; la
usa sólo el pipeline de publicación, y sólo desde `main`: el archivo seguro se llama
`publicacion-github.private-key.pem`. Lo que sigue es lo que ya se sabe; el procedimiento completo, ensayado,
todavía no está escrito.

- **Dónde se revoca**: en GitHub, en la configuración de la App, sección de llaves privadas: se borra la llave. Sin
  ella no se piden tokens nuevos, y los ya emitidos vencen solos.
- **Cómo se rota**: se genera una llave nueva en la App, se reemplaza el archivo seguro por ella y recién entonces se
  borra la vieja.
- **Qué se revisa en el repo público si se filtró**: las ramas, las etiquetas, los releases y los cambios de
  workflows que no hizo `mirror.js` (lo que la sincronización escribe es `mirror/sync` y su pull request, nada más), y
  se corre `verify`.
- **Antes de darle a alguien permiso de escritura sobre `main` del arnés**, se revisa quién lo tiene: quien pueda
  cambiar el pipeline de publicación en `main` puede usar la credencial y lo que empuja llega a
  las máquinas que siguen el canal «al día» («Empujar es instalar»).

## El freno antes de publicar

Cuando el arnés se mantiene directo en su repo público, **una rama empujada ya es pública**: antes de cualquier pedido
o merge, y sin vuelta atrás (borrar la rama no borra los commits; siguen alcanzables por su identificador y, si hubo un
pedido, por la ref del pedido). El exportador y su detector dejan de estar en el medio. Lo que queda antes de publicar
es este freno, en tres lugares que comparten guion (`scripts/hooks/public-push-guard.js`):

| Mitad | Cuándo corre | Qué mira |
|---|---|---|
| El `pre-push` de git | En cada `git push`, con cualquier herramienta | Cada commit nuevo del empuje |
| El freno de `gh` | Antes de cada comando de una sesión del agente | El texto que un `gh` publica sin empujar |
| El paso de la validación | En la validación de cada pedido, siempre | Cada commit del pedido, su rama, su título y su cuerpo |

**Qué remoto es público.** Todo el que no sea de Azure DevOps ni una carpeta local (una carpeta se sigue hasta su
`origin`). Se decide con la dirección que git le pasa al hook, nunca con `origin`, y una dirección que no se sabe leer
es pública: comparar contra «el repo público» dejaría pasar un alias de ssh, una dirección suelta o una copia propia.
Sólo se mira un **empuje del arnés**, y lo es por cualquiera de tres señales: el árbol de trabajo trae
`scripts/install-tycon-hooks.sh`, lo que se empuja lo trae (una rama del arnés empujada parado en otra, o desde un repo
sin árbol de trabajo), o el remoto es un repo que el arnés declara suyo. En cualquier otro empuje, y hacia un remoto
que no es público, sale exactamente como sin el freno, sin leer la lista y sin una línea.

**Qué mira el `pre-push`**, en cada commit que ese remoto todavía no tiene —no en la diferencia neta: un commit que
mete un nombre y otro que lo saca dejan el nombre en la historia—. «Lo que ya tiene» sale de la punta remota que
informa git y de **lo que el propio remoto contesta** (el freno se lo pregunta en cada empuje). Las ramas de
seguimiento no se usan: no guardan de qué repo salieron, y después de re-apuntar un clon al repo público seguían
siendo las del repo anterior. Si el remoto no contesta —el freno espera 20 segundos y no pide claves—, se mira todo.

- el contenido y la ruta de cada archivo que el commit agrega o cambia, con el **detector completo** (los términos de
  la lista, y los patrones que no necesitan lista: secretos, correos, rutas de máquina). Un binario sin permiso, un
  enlace simbólico y un submódulo cuentan como «sin leer»;
- el mensaje, y el autor y el committer: el nombre contra la lista, y el correo tiene que ser un `noreply` de GitHub
  (`…@users.noreply.github.com`, o `noreply@github.com` como committer de un merge hecho en GitHub);
- el nombre de la rama o de la marca; en una marca anotada, además, el nombre que declara, su mensaje y quién la firmó;
- un número de pedido en un mensaje o en un nombre de rama (la forma la define `scripts/publishing/internal-history.js`;
  los números de story del arnés pasan). Esa forma pide un espacio antes del número y un nombre de rama no tiene
  espacios: el nombre se mira además con los separadores vueltos espacios (`arreglo/pr-123` cuenta). No cuenta el
  número del asunto que GitHub le pone a un merge hecho en su web («Merge pull request #N from …»): es de un pedido
  que ya es público. Si ese control no está en el arnés que corre, los números no se miden y el freno lo dice;
- una cabecera de más en un commit (la marca que un merge incrusta): es texto que se publica con él;
- las **rutas vedadas**: `.engram/`, `specs/`, `tasks/`, `inbox/` _(del repo del equipo; no está en esta copia)_, `.advisors/`, `.dashboard/`, y las que sume la lista
  privada en `forbiddenPaths`;
- que la ref sea una rama o una marca: una nota, un guardado a medias o lo que publica `--mirror` no salen.

En un merge cuenta lo que no viene de ninguno de sus padres: lo que trae de la otra rama ya se miró en sus commits, o
ya está publicado. Borrar una ref remota no publica nada y pasa.

**De dónde sale la lista**, en orden: `TYCON_PUBLISH_DENYLIST` (un archivo) · el clon de mantenimiento que declara la
máquina (`harness.js config set paths.maintainers <carpeta>`) · el clon que la máquina mantiene (`paths.maintained`) ·
el arnés desde el que corre el freno. **Nunca el árbol que se empuja** (tampoco si la máquina declara ese árbol como su
clon): la rama elegiría con qué lista se la mira. Los dos primeros son una declaración: declarados y sin
lista es «no pude mirar», aunque más abajo haya otra. En una máquina **con el perfil del equipo** la lista es
obligatoria: sin lista, no sale. Sin perfil y sin lista —alguien de afuera con su copia— corre lo que no necesita
lista, y lo dice en una línea.

**Casi nunca hace falta declarar nada.** En la máquina de quien mantiene, el clon interno ya está declarado como el
que la máquina mantiene (`paths.maintained`) y el freno encuentra la lista ahí. `paths.maintainers` es para cuando
ese clon deja de traerla (después del corte, cuando el que se mantiene es el público), y desde entonces hace más
que dar la lista: ver «La máquina de quien mantiene», más abajo. Al guardar cualquier clave,
`harness.js config set` les pregunta antes a los lectores de la configuración —el de este arnés y, en la cuenta real de
la máquina, la copia que el freno de producción tiene instalada en `/opt/tycon`—: si uno que aceptaba el archivo de hoy
rechaza el nuevo, no escribe nada y dice quién. Uno que ya lo rechazaba, o al que no se le pudo preguntar, no frena: se
escribe y se avisa. La copia del freno de producción se actualiza sólo reinstalándolo, con su propio
instalador: con una vieja, la clave nueva no se guarda hasta reinstalarlo, y mientras
tanto la lista se declara con `TYCON_PUBLISH_DENYLIST` en el perfil de la terminal. Por qué: una clave
guardada sin que el lector la conozca deja inválida la configuración de la máquina.

**Cuándo no sale**, y con qué código: `1` hay hallazgos · `2` no pude mirar (sin la lista, un objeto que no se deja
leer, el tope de tiempo de 120 segundos —`TYCON_PUBLIC_PUSH_LIMIT_MS` lo cambia; vencido, no sale—, las líneas de git
mal formadas o que no se pudieron leer, el control de números de pedido roto). «No pude mirar» nunca es verde. La salida
dice **dónde** —archivo y línea, «el mensaje del commit X», «la ref nº N del empuje»— y la categoría; nunca el texto
encontrado, ni una ruta o un nombre de rama que sean ellos mismos el hallazgo.

**Cómo se sale de un freno falso.** Con una excepción con motivo en la lista privada (`permitidos`), como en el
exportador (§«Las excepciones del detector»). No hay variable que apague el freno, y las que dicen de dónde salen la
lista y el freno (`TYCON_PUBLISH_DENYLIST`, `TYCON_GUIDES_DIR`, `TYCON_HOME`) son de las pruebas: el freno de la sesión
no deja correr un `push` ni un `gh` que publica con una de ellas en la misma línea; tampoco con las que le sacan a git
su carpeta de hooks (`HOME`, `GIT_CONFIG_GLOBAL`, `-c core.hooksPath=…`). Si lo frenado es de verdad, se
saca de la **historia** de la rama, no sólo de la punta; y un secreto que llegó a un commit se da por comprometido: se rota.

**Por qué lo pone el instalador.** Con una carpeta global de hooks (`core.hooksPath`), git ignora el `.githooks/` de
cada repo: un `pre-push` del repo no lo llamaría nadie. El instalador deja `scripts/hooks/git-pre-push-global.sh` como
`pre-push` de esa carpeta, así corre desde cualquier clon, también uno recién hecho. El `pre-push` que la persona ya
tenía pasa a `pre-push.local` y corre primero, con la misma entrada; si rechaza, rechaza (y si está y no se puede
ejecutar, se dice). El despachador llama al freno del arnés **instalado**, no al del árbol que se empuja: una rama no
se juzga con su propia versión del freno. Y no decide nada más: si el remoto es público y si el empuje es del arnés lo
decide el freno. Sólo si el freno no se puede correr (falta el guion, falta `node`) decide él, y el empuje sale
únicamente hacia lo que claramente no es público, o cuando nada dice que es del arnés. `.githooks/pre-push` hace lo
mismo en un clon con carpeta de hooks propia; sin arnés instalado le presta al despachador el freno de su propio árbol
(con un argumento, no con una variable).

**El freno de `gh`.** Un pedido, un comentario o una versión creados con `gh` publican texto sin pasar por `git push`.
Todo `gh` que no esté en la lista cerrada de **lectura** (`view`, `list`, `status`, `checks`, `diff`, `checkout`,
`download`, `clone`, `gh api` con `GET`, una consulta de GraphQL, y los grupos que no publican texto; la lista vive en
`scripts/lib/gh-pr.js`) y que apunte al repo público del arnés —porque se corre en un clon con un
remoto público, o porque lo nombra con `--repo`, `GH_REPO` o la ruta de `gh api`— se revisa: cada valor de opción
(salvo lo que elige algo que ya existe: el repo, la rama base, un commit),
cada archivo que lee (`--body-file`, `--notes-file`, `--input`, `campo=@archivo`) y cada archivo que sube, con su
nombre. Lo que la terminal arma antes de correr no se puede leer, y lo que no se puede leer no sale: una sustitución
`$(…)`, una variable, la entrada estándar, el editor, la web. Tampoco un `gh` que publica pasado como texto a una
terminal (`bash -c "gh …"`, `iex "gh …"`, `cmd /c`, `eval`, `ssh`; por una tubería o en un bloque; guardado en una
variable de la misma línea), ni el código de una línea que lo ejecuta dado a un intérprete (`python3 -c
'os.system("gh …")'`, `node -e`, `ruby -e 'system "gh …"'`): se corre el `gh` directamente. Un `gh` de lectura corrido de esas formas pasa. El mismo texto dado a otro programa —`git commit -m "… gh pr create …"`, un `grep`, un `sed`— es un dato
y pasa.

**Qué cubre y qué no.** El freno de `gh` cubre el accidente, no la evasión. Lee la línea de comando: no ve un `gh`
adentro de un guion que esa línea corre, ni armado a pedazos adentro de un texto, ni un programa que no es una terminal
y ejecuta una opción suya (un alias de git que empieza con `!`). Tampoco un `gh` tecleado en una terminal, ni la web de
GitHub. Todo eso lo mira después la verificación de lo publicado, y del lado de GitHub las protecciones del repo.

**Cuando no se sabe a qué repo va**, se mira igual, como si fuera al público: un `cd` a una variable, a una carpeta que
no está o con un comodín, o adentro de un subshell, un repo en una variable, `GH_REPO` puesto de una forma que el freno no sigue (como lo pone PowerShell), una
mutación de GraphQL. Un texto limpio pasa; uno con un hallazgo, no. Sólo lo que se sabe que va a otro repo no se mira.

**Un archivo se mira si el `gh` corre solo.** El archivo se lee antes de que corra el comando: si otro comando de la
misma línea puede escribirlo (`echo … > cuerpo.md && gh pr create --body-file cuerpo.md`), lo que se miró no es lo que
se publica, y no sale. La forma que sí se lee:

```bash
# el texto en un archivo escrito antes, en otra llamada
gh pr create --title "feat: el título" --body-file cuerpo.md
# o el bloque con el delimitador entre comillas
gh pr create --title "feat: el título" --body "$(cat <<'EOF'
El cuerpo, tal cual.
EOF
)"
```

Es un freno de la sesión del agente: un `gh` tecleado en una terminal, la web de GitHub u otra herramienta no pasan por
él. Eso lo mira la verificación de lo publicado, de noche (§«Si `verify` da 1»).

**En Windows, hoy**, el freno de `gh` frena cuando el asistente lanza el hook por el bash de Git, que es lo usual. Si
lo lanza por PowerShell, avisa y no frena: PowerShell no devuelve el código de salida del programa. Les pasa a todos
los frenos que frenan por código de salida; está declarado en `scripts/tests/windows/known-gaps.json` y se cierra con
la forma de registrar los hooks que no depende del shell.

**En la validación de cada pedido.** Las dos mitades de arriba corren en la máquina de quien escribe; un pedido
abierto desde otra máquina, o con el freno salteado, llega igual. Por eso la validación corre el mismo freno, en su
modo de rango (`public-push-guard.js range --base <commit> --head <commit> …`), en el trabajo que corre **siempre**
—también con sólo documentación—: cada commit que el pedido suma a su rama destino, el nombre de la rama, y el título y
el cuerpo, que `scripts/ci/pr-texts.js` trae de la API de GitHub. A diferencia del `pre-push`:

- **la lista es siempre obligatoria**: sale del repo privado a una carpeta temporal de ese trabajo —nunca a un
  artefacto, que cualquiera baja— y el paso la borra al terminar. Sin lista, rojo; y sin el control de historia
  interna (el de los números de pedido), también;
- **no frena la publicación, frena el merge**: la rama de un pedido ya es pública. Por eso dice qué hacer, en orden:
  cerrar el pedido, borrar la rama y pedir la purga al soporte de GitHub; y un secreto se rota primero;
- si el título y el cuerpo no se pueden leer, rojo. En una corrida que no es de un pedido (a mano, sobre una rama) se
  miran los commits y la rama, y el freno dice que no hubo título ni cuerpo;
- en un pedido, **sin el nombre de su rama también es rojo**: ese nombre figura en la página del pedido. La última
  línea del freno dice qué miró (`branch=`, `title=`, `body=`, cada uno 0 o 1) y el paso sólo da verde si coincide
  con lo que le pidió mirar;
- **el clon tiene que traer la historia entera**: en uno superficial los commits del pedido que faltan no se pueden
  mirar, y eso es «no pude mirar», no «limpio». Y un submódulo se dice siempre, aunque el `.gitmodules` del propio
  árbol le pida a git que lo ignore;
- con el repo propio en Azure —el interno, que no se publica tal cual— el paso dice «no aplica» y no juzga. Con
  cualquier otro proveedor, juzga.

El aviso de la corrida lleva texto fijo y la cuenta; el lugar de cada hallazgo va en el registro del paso. Un límite:
el paso corre el freno del propio pedido, porque el YAML que lo llama también es del pedido. Lo que eso deje pasar lo
mira la verificación de lo publicado, de noche.

**Cómo saber si está puesto.** `node scripts/hooks/public-push-guard.js status` dice si el `pre-push` que git corre es
el del arnés y tiene permiso de ejecución, de dónde sale la lista, si se puede leer, si está al día y si los números de
pedido se miden; sale `1` si algo falta. `harness.js doctor` dice lo mismo como dato o como aviso —nunca en rojo, y
durante una instalación o una actualización no lo mira: un rojo ahí frenaría las actualizaciones de toda máquina que
no tiene el freno, y la instalación no llama a git—, mirando la carpeta **global** de hooks, no la del repo donde se
esté parado.

**Si la lista está atrasada, el freno lo avisa.** La lista se lee del disco de un clon, y un clon que nadie trae se
queda viejo: una excepción ya publicada no está en la lista que se lee, y el freno frena lo que ya tenía permiso. El
aviso se arma con tres medidas: si el archivo del disco es el de la rama principal remota como la conoce ese clon
(cubre un clon parado en una rama de trabajo y una lista editada a mano), cuántos días hace que no se trae (avisa
pasados tres), y —sólo al empujar, que ya sale a la red— si el remoto tiene commits que el clon no trajo. Sale en el
empuje, pase o frene, en `status` (con `status --fetch` le pregunta al remoto) y en `doctor` (`doctor --fetch`). Es un
aviso: nunca cambia el veredicto ni el código de salida. Lleva sólo cuentas —cuántos commits, cuántos días— y la
carpeta del clon; nunca el asunto de un commit ni el nombre de una rama del repo privado. Qué no ve: sin red y sin que
nadie haya traído el clon, sólo la edad.

**La carpeta global de hooks.** El freno corre porque git tiene como carpeta global de hooks la que el instalador
llena. Si git apunta a otra —la de otra herramienta, una vieja—, el instalador llena la suya y ningún hook del arnés
corre. Los dos instaladores lo dicen, con las dos rutas y el comando para apuntarla, y distinguen una carpeta que no
existe y una que no se puede comparar (relativa, o con forma de Unix en Windows). No la cambian solos.

### La máquina de quien mantiene

Quien mantiene el arnés trabaja en un clon del repo público, que no trae nada privado: ni la lista, ni la
configuración del arnés para el propio repo, ni la memoria. Todo eso vive en un clon privado, y la máquina dice cuál
es:

```bash
node scripts/setup/harness.js config set paths.maintainers <carpeta del clon privado>
```

Con esa clave puesta:

- **Los repos del arnés se reconocen por su remoto**, también cuando el arnés que corre es una versión instalada (que
  no es un clon y no tiene remoto propio). Cuenta el remoto del clon declarado, y con él lo que el arnés declara como
  su repo público. En esa máquina, en todo clon de esos repos —esté en la carpeta que esté— dejan de correr los
  controles que excluyen a los repos del arnés: el portón que exige story o carril, el registro de retrospectivas y
  el aviso de trabajo sin subir. Sin la clave, decide el nombre de la carpeta, como siempre. A mano:
  `node scripts/lib/harness-repo.js <carpeta>` dice qué decidió y de dónde salió cada identidad.
- **El merge de un clon del público encuentra su configuración.** `merge.mode` y `merge.check` se leen de lo
  commiteado en la rama principal remota del clon privado (no de su árbol de trabajo: no depende de en qué rama esté
  ni de ediciones sueltas). Para el repo público, no encontrarla sale 2 con el motivo: nunca termina en un empuje
  directo. `merge-pr.js plan` dice de dónde leyó (`configFrom`).
- **El freno de nombres del commit mira con la lista de la máquina.** En un clon del público el árbol no trae lista,
  y todo lo que se commitea se publica tal cual: no hay exportador que saque nada. El freno busca la lista en los
  mismos lugares que el freno antes de publicar, nunca en el árbol que se commitea, y mira lo que el commit agrega
  en cualquier archivo. Sólo nombres: secretos, correos, binarios y enlaces los mira el freno al empujar. Declarada y
  sin lista es «no pude mirar» y el commit no se crea; sin declarar, en una máquina del equipo lo dice en una línea y
  deja pasar.
- **La memoria no se exporta al commitear en el público**: viaja con el próximo commit hecho en el clon privado
  (`guides/engram-workflow.md`, «Fin de sesión»).

`doctor` nombra el clon declarado, avisa si la carpeta no está o no es la raíz de un clon, y avisa cuando una máquina
que mantiene (`paths.maintained`) todavía no declaró `paths.maintainers`.

## Estado

- **El exportador**: las dos copias salen con el detector en cero y sin un solo nombre de cliente en identificadores;
  la del núcleo instala y arranca limpia y pasa sus propias pruebas, y bizuit se superpone al núcleo.
- **Los nombres**: el freno de nombres corre al commitear y en el pull request del arnés, y el termómetro tiene su
  techo en 0 (§«El núcleo sin nombres»).
- **La publicación**: `mirror.js` (`plan`, `first`, `sync` y `verify`), `github-app-token.js`, la versión numerada y
  el repo interno único están probados sin red, contra repos y una API de juguete. La primera sincronización de verdad
  desde el repo único queda para la republicación.
- **El freno en el pedido y la verificación de noche**: la validación de cada pedido corre el freno de
  publicación en su modo de rango, y `verify` mira además las versiones, los pedidos, los issues y los comentarios.
  Probado sin red, contra repos y una API de juguete: falta la primera corrida de verdad sobre el repo público.
- **Lo que todavía no existe**: `import` y el remoto propio de la copia (§«Cambios ajenos»).
