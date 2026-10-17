# Nombres en inglés — lo que ejecuta la máquina se nombra en inglés; lo que lee una persona, en castellano

Convención del arnés desde 2026-09-29. Alguien de afuera tiene que poder **usar** el núcleo sin leer
castellano: lo que escribe en una terminal o en un archivo de configuración va en inglés. Lo que **lee** —la prosa, los
mensajes, las guías— sigue en castellano, que es como trabaja el equipo.

La cuida un freno al commitear (`scripts/publishing/spanish-names.js`, en el pre-commit del repo, una vez por fuente, y
en el pull request del arnés): no deja entrar un nombre **nuevo** en castellano en lo que se publica. Un nombre castellano que ya
existe pasa hasta que se lo renombre. Y un termómetro nocturno cuenta lo que queda
(`spanishNames` en el `--json` del exportador, contra `scripts/publishing/spanish-names-ceiling.json`, que sólo baja).

## Qué va en inglés

Todo lo que la máquina ejecuta o lee como nombre, en lo que sale en la copia pública:

- archivos y carpetas que se ejecutan o se leen como configuración, pruebas incluidas;
- opciones y subcomandos de línea de comandos, y sus valores fijos;
- variables de entorno;
- claves de los archivos de configuración (las de `schemaFiles` en `scripts/lib/spanish-words.json`);
- nombres de los archivos de estado.

Ejemplo: `--sin-sudo` pasa a `--without-sudo`; `instalar-freno.sh` a `install-guard.sh`; `TYCON_NO_SUBIR_CORRIDAS` a
`TYCON_NO_UPLOAD_RUNS`; la clave `motivo` de un archivo de esquema, a `reason`.

## Qué sigue en castellano

- La prosa, los comentarios y los mensajes que imprimen los scripts.
- Las guías, con su nombre de archivo (esta misma).
- Las descripciones de las pruebas y los ids y archivos de los casos del banco de controles.
- Los campos y valores de los registros (`frenos.jsonl` y compañía) y de las salidas `--json`: tienen historia en el
  buzón y en el tablero.
- Los vocabularios que son datos con historia: las causas de `followup_reason`, los ids de las métricas de
  `sources.json`, los estados de las stories.

Ejemplo: el mensaje `⛔ nombres en castellano: no pude mirar` queda así; el campo `"veredicto":"bloqueo"` de la
constancia de un freno también.

## Ruta o valor

Antes de renombrar una palabra, se clasifica **cada aparición** en ruta, valor o prosa, y sólo cambia el papel que el
mapa de renombres declara. La misma palabra puede ser las tres cosas: `dependencias` es una carpeta (ruta), un valor de
`--fuente` y una palabra de una guía. Renombrar la carpeta no cambia el valor ni la prosa.

Ejemplo: al pasar la carpeta `publicacion/` de `scripts/` a `scripts/publishing/`, cambiaron los globs de la lista blanca y los
comandos de las guías que la nombran; `--paquete nucleo` (un valor) y la frase «la publicación del núcleo» (prosa) no.

## Entre repos

El arnés y agent-skills se actualizan con pulls separados: en cada máquina puede haber uno adelantado y el otro no. Una
referencia de un repo a un archivo del otro usa el nombre **viejo**, o prueba el nuevo y el viejo, hasta la fecha de
retiro. Nunca se cambia al nombre nuevo sin probar los dos.

Ejemplo: el pre-commit de agent-skills llamaba `${TCG}/scripts/publicacion/new-names.js`; desde que esa carpeta pasó a
`scripts/publishing/` prueba la ruta nueva y, si no está (un arnés un pull atrás), la vieja, hasta el retiro.

### Un archivo que vive en el repo del equipo

El perfil del equipo pasó de `perfil-equipo.json` a `team-profile.json` sin entrada en el mapa. Ese archivo vive en el
repo del perfil de cada organización, que el arnés no controla, y una máquina con una versión anterior sólo conoce el
nombre de antes. Por eso el arnés lee los dos sin fecha de retiro: primero el nuevo; si no está, el de antes, con un
aviso de una línea que dice cómo renombrarlo; con los dos, gana el nuevo y el de antes no se apila. La pareja de nombres
está escrita en `scripts/setup/harness/team.js` y en `scripts/lib/tycon-config.js`. Un repo del equipo que renombra el
suyo sube en el mismo commit `requires.harness` de `team-layer.json` a la versión que trae el nombre nuevo: una máquina
anterior rechazaría el perfil entero.

## Cómo se renombra: el mapa y los nombres viejos

Cada renombre sale de una entrada del mapa de renombres (`renames.json`) —nunca de un `sed` sobre una palabra suelta—, y el
nombre viejo sigue andando, sin decir nada, hasta la fecha de retiro (`retire_after`):

| Qué se renombra | Cómo sigue andando el viejo |
|---|---|
| Un archivo que llaman de afuera (la máquina, el otro repo, los productos, las guías) | Un **reemplazo** en la ruta vieja que lanza al nuevo, generado con `node scripts/lib/legacy-names.js --write-shims` (nunca a mano; su segunda línea dice `tycon-legacy-shim: <nuevo>`), también cuando cambia de carpeta. Una guía movida deja un `.md` de dos líneas («Movida a …» y la marca). El instalador de cada máquina reescribe la ruta vieja en `settings.json`, permisos, Codex, `~/.git-hooks` y el LaunchAgent del examen. Un archivo que sólo llama su repo cambia con sus `require` y no deja reemplazo; uno que nombra un pipeline de Azure DevOps (`callers: ado`) tampoco: su cambio es una tarea humana. |
| Una variable | El script la lee con `readEnv('TYCON_NUEVA')` (JS), `legacy_env TYCON_NUEVA` (bash) o `Get-LegacyEnv` (PowerShell): sólo la vieja, vale la vieja; las dos distintas, gana la nueva. |
| Una opción, un subcomando o un valor | En JS, una línea al entrar al script: `aliasArgv(where, { exitCode })` reescribe `process.argv` con `aliasOptions` antes de que el script lo lea, así sirve lea sus opciones como las lea (con el viejo y el nuevo juntos, sale con el código de opción desconocida del script). En bash, `legacy_args "$@"` + `set -- …`; en PowerShell, `Get-LegacyArgs`. La ayuda y los errores nombran sólo el nuevo; el viejo y el nuevo juntos es «la misma opción dos veces». Un valor dice de qué opción es (`"option"` en su entrada) y se traduce sólo detrás de ella: `--package nucleo` pasa a `--package core`, un `nucleo` suelto no. Un valor que además se graba en un registro se acepta con el nombre nuevo y se sigue grabando con el viejo. |
| Un archivo de configuración o de estado, o una clave | `resolveFile`, `readKeys` y `prepareStateWrite`: se lee el nuevo o el viejo, se escribe el nuevo. |
| El valor de una clave o de una variable | Una entrada `value` cuyo `option` nombra la clave o la variable de la que es valor. Lo traduce quien lo lee, preguntándole al mapa (`usableEntries(loadMap())`): el lector de configuración (`"detect"` en `integrations.codex` y en `TYCON_CODEX`), el examen (los días de `scheduled_days`). En `scripts/ci`, con el par declarado en el guion, como las opciones (`block` en las dos llaves del portón). Sin mapa sólo vale el nuevo, salvo el del portón: su valor de antes no sale del mapa (va en el par del guion y, en agent-skills, en una lista fija del hook de commit), así que sigue valiendo hasta el retiro también en la copia pública. |

Ejemplo: si `scripts/metrics/corridas.js` pasara a `runs.js`, la entrada es
`{ "kind": "file", "old": "scripts/metrics/corridas.js", "new": "scripts/metrics/runs.js", "callers": ["machine"], "batch": "C1" }`;
el instalador cambia esa ruta en cada máquina comparando la ruta **completa** (así otro archivo cuyo nombre termine en `corridas.js` no se toca).

El `new` puede estar en otra carpeta, anidada y todavía inexistente (una carpeta de `scripts/` que pasa a
`scripts/nightly/dashboard`): una entrada cuyo archivo todavía no se movió es válida y no
hace nada hasta la mudanza. Así nacen, con sus `callers` medidos, las de
todo lo que cambia de carpeta.
«Mudada» es: el nuevo existe **y** el viejo ya no es el de verdad (no está, o quedan sólo reemplazos) —
`legacy-names.js` → `isMoved`, el mismo criterio en el validador, el instalador, `--write-shims`, `--stale-mentions` y
el exportador—; que exista la carpeta nueva no alcanza, porque un archivo renombrado puede llegar a su destino antes que
el resto de su carpeta. Las rutas del mapa van relativas a la raíz del repo, sin `..`, `.` ni barras de más, y sólo
con letras, dígitos, `.`, `_`, `-` y `/` (el validador rechaza cualquier otra).

Una guía privada protegida por su nombre de archivo (una exclusión fija de `export.js` o un «afuera») se mueve **con su
glob**: si no, sale en la copia por su ruta nueva. La exportación sale 2 y `export.js --explain --json` la lista en
`exclusionesSinArchivo`; el reemplazo `.md` que deja la mudanza en la ruta vieja no cuenta como archivo cubierto.

Cada uso de un nombre viejo queda anotado, una línea por nombre, script y día, en
`~/.claude/.tycon-pipeline/legacy-names.jsonl` (sin valores ni rutas de la máquina); en Azure DevOps deja además un
warning en la corrida. El mapa lo valida `node scripts/publishing/spanish-names.js --check-map`, también en el
pre-commit cuando cambia. **La copia pública no lleva el mapa ni los reemplazos** y ningún archivo que sale puede
nombrar una ruta vieja: afuera nacen con los nombres nuevos y `legacy-names.*` es paso directo.

### El traductor de scripts/ci

Los pipelines de los productos corren los guiones de `scripts/ci` también desde el artefacto `arnes-ci`, que es **sólo
esa carpeta**: en la etapa de producción no hay `scripts/lib` ni el mapa, y `aliasOptions`/`legacy_args` no alcanzan.
Por eso las opciones de esos guiones las traduce `scripts/ci/legacy-options.sh` (bash 3.2, sin node) o
`scripts/ci/legacy-options.js`, que viven en la misma carpeta, con los pares **declarados en el guion**:

    . "$(dirname "${BASH_SOURCE[0]}")/legacy-options.sh"
    legacy_options 'usuario:user clave:password' "$@" || exit 2     # el código de «opción desconocida» del guion
    set -- ${LEGACY_OPTIONS[@]+"${LEGACY_OPTIONS[@]}"}

    argv = aliasLegacyOptions(argv, 'tipo:type proyecto:project', 'scripts/ci/<guion>.js');

Un **valor** viejo de una opción se declara como `opcion=viejo:nuevo` (con el nombre nuevo de la opción): el traductor lo
pasa al nuevo cuando va detrás de esa opción (`--environment produccion` o `--environment=produccion`), y sólo ahí:

    legacy_options 'entorno:environment environment=produccion:production' "$@" || exit 2

El mapa sigue siendo la lista oficial: `--check-map` sale 2 si una entrada `option` o `value` con `where` en
`scripts/ci/` no tiene su par declarado en el guion, o si un par declarado no tiene su entrada. En Azure DevOps cada nombre viejo deja un
warning en la corrida, **salvo** que la salida normal y la de error vayan al mismo lugar: eso es quien llama guardando la
salida como dato (`NOTAS=$(release-notes.sh … 2>&1 | …)`), y el warning terminaría adentro de la nota de versión. Lo
prueba `legacy-names-product-pipeline.test.sh` corriendo las líneas reales de un pipeline de producto. En el retiro se
sacan los pares del mapa y de los guiones; sin pares, el traductor se borra.

### El sufijo de rol de los hooks

Un hook de `scripts/hooks/` dice en su nombre qué hace: **`-guard`** si frena, **`-notice`** si avisa, **`-meter`** si
mide; el resto (repara, sincroniza, dispara otra cosa) va sin sufijo. Toda entrada `file` del mapa cuyo `new` cae en
`scripts/hooks/` lleva `role` (`guard`, `notice`, `meter` o `none`), y `--check-map` sale 2 si con `role` distinto de
`none` el nombre nuevo no termina en `-<role>`. La regla vale para lo que se renombra **desde ahora**: un hook que ya
está en inglés no se renombra sólo para ganar el sufijo, porque cuesta su clave en el banco, el `settings.json` de cada
máquina y Codex. Esos quedan como están, con constancia en la tabla de abajo. Una entrada que ya estaba cargada antes de
la regla y no cumple lleva `role_waiver: "<motivo>"`, que `--check-map` acepta sólo para los `old` de una lista fija en
`spanish-names.js`: una excepción nueva pide cambiar el código, no el mapa.

| Hook (en `scripts/hooks/`) | Rol | Por qué no lleva sufijo |
|---|---|---|
| `advisor-liveness-on-change.js` | frena (`guard`) | se renombró antes de esta regla: sin segundo renombre (`role_waiver`) |
| `safety-guard-pre.sh` · `test-scope-guard-pre.sh` | frenan | ya dicen `guard`; el `-pre` dice cuándo corren (antes de la herramienta) |
| `git-pre-commit-global.sh` | frena | en inglés desde antes de la regla |
| `git-post-commit-global.sh` | avisa | en inglés desde antes de la regla |
| `retro-pending.js` | avisa | en inglés desde antes de la regla |
| `instinct-observe.sh` · `instinct-observe.py` | miden | en inglés desde antes de la regla |
| `artifact-archive.js` · `engram-pre-commit.sh` · `harness-bootstrap-heal.sh` · `harness-maintain.sh` · `harness-startup.js` · `instinct-trigger.sh` · `rebuild-before-verify.js` · `telegram-zombie-sweep.sh` | ninguno (`none`) | no frenan, no avisan ni miden: copian, sincronizan, reparan o disparan otra cosa |
| `codegraph-session-hook.sh` · `codegraph-session-hook.ps1` | ninguno (`none`) | entraron a `scripts/hooks/` con su nombre; configuran CodeGraph |

## El glosario

Castellano → inglés. Es **inyectivo**: dos palabras castellanas nunca van a la misma inglesa (por eso `constancia` es
`record` y `registro` es `log`). Vive
en `scripts/lib/spanish-words.json` → `glossary`, y el freno lo usa para proponer el nombre en inglés.

Ejemplo: el freno ve `--sin-copia` y propone `--without-copy`, porque el glosario tiene `sin` y `copia`.

| Castellano | Inglés | Castellano | Inglés | Castellano | Inglés |
|---|---|---|---|---|---|
| `corrida` | `run` | `buzon` | `mailbox` | `tablero` | `dashboard` |
| `revisores` | `reviewers` | `hallazgos` | `findings` | `examen` | `exam` |
| `freno` | `guard` | `produccion` | `production` | `publicacion` | `publishing` |
| `aviso` | `notice` | `vida` | `liveness` | `latido` | `heartbeat` |
| `constancia` | `record` | `veredicto` | `verdict` | `nocturno` | `nightly` |
| `banco` | `bench` | `sonda` | `probe` | `foto` | `snapshot` |
| `deuda` | `debt` | `perfil` | `profile` | `paquete` | `package` |
| `nucleo` | `core` | `registro` | `log` | `consulta` | `query` |
| `fallida` | `failed` | `archivo` | `file` | `sesion` | `session` |
| `comando` | `command` | `reporte` | `report` | `clon` | `clone` |
| `dependencias` | `dependencies` | `proyecto` | `project` | `ruta` | `path` |
| `carpeta` | `folder` | `evidencia` | `evidence` | `lectura` | `read` |
| `carril` | `lane` | `codigo` | `code` | `hoy` | `today` |
| `salida` | `output` | `entrada` | `input` | `estado` | `state` |
| `rama` | `branch` | `maquina` | `machine` | `sello` | `seal` |
| `pasos` | `steps` | `cambio` | `change` | `reglas` | `rules` |
| `captura` | `capture` | `dias` | `days` | `casos` | `cases` |
| `sin` | `without` | `copia` | `copy` | `cargar` | `load` |
| `datos` | `data` | `bajar` | `download` | `subir` | `upload` |
| `motivo` | `reason` | `limpiar` | `clean` | `pendientes` | `pending` |

## Qué es «castellano» para el freno

Cada nombre se parte en palabras (guiones, guiones bajos, puntos, dígitos y mayúsculas internas; un sha no es una
palabra). Una palabra cuenta si:

1. está en `words` (las castellanas ya medidas), o
2. no está en el diccionario inglés del sistema ni en `allowed` —así una palabra nueva como `guardar` también cuenta—,
   salvo que tenga menos de 3 letras (una sigla como `js` o `id` no frena);
3. o es una de las `ambiguous` (castellanas que también se leen en inglés: `para`, `con`, `valor`, `en`, `es`…)
   **y** el nombre tiene otra castellana. `sin`, `solo`, `vista` y `de` no son ambiguas:
   pegadas a una palabra inglesa (`--sin-local`, `--alias-de`) pasarían sin contar, y en un nombre de
   este repo nunca son inglés.

El plural simple (`-s`, `-es`) se normaliza, y para decidir «es inglés» se prueban también las formas `-ed`, `-ing`,
`-ies`, `-ly`: el diccionario de macOS es de 1934 y no trae `navigated` ni `email`. Sin diccionario en la máquina
(Windows, un contenedor mínimo) el freno usa sólo `words` y lo dice.

Qué mira: lo que sale en alguna copia pública y, de eso, ejecutables, configuración y pruebas; nunca `.md` ni los casos
del banco. Frena un nombre en castellano que **no existe en ninguna parte de lo que salía antes** del commit (en los dos
repos; en un merge, en ningún padre): una ruta nueva o un `git mv`, una opción `--x`, un subcomando del despacho, un
valor que el mapa de renombres declara, una variable de entorno leída (en shell, sólo `TYCON_*` o exportadas) o una
clave de `schemaFiles`. Renombrar de castellano a inglés pasa; de inglés a castellano, o de castellano a castellano,
frena.

## Cuando frena

El mensaje dice, por hallazgo, dónde (`archivo:línea` o la ruta), la categoría, el nombre, sus palabras en castellano y
la propuesta en inglés si el glosario tiene todas. Las salidas, en orden:

1. El nombre en inglés.
2. Si la palabra es inglés técnico, un nombre propio o un slug ajeno: un `allowed` con su `reason` en
   `scripts/lib/spanish-words.json`, **en un commit aparte** y decidido por una persona (una excepción que llega en el
   mismo commit que el nombre que la necesita no vale).

`TYCON_SPANISH_NAMES=0` lo apaga: lo dice en cada commit y deja constancia de escape. «No pude mirar» (la lista rota,
el exportador que no clasifica, un archivo de `schemaFiles` que no parsea) sale 2 y el commit no se crea. Sin el otro
repo, avisa fuerte y deja pasar. En la copia pública (sin el perfil del equipo) todo lo del repo cuenta como que sale.

A mano:

```bash
node scripts/publishing/spanish-names.js                      # lo stageado
node scripts/publishing/spanish-names.js --range main...HEAD  # un rango
node scripts/publishing/spanish-names.js --count --json       # el conteo del termómetro
```

## El techo

`scripts/publishing/spanish-names-ceiling.json` guarda lo medido por paquete. `export-real.test.sh` sale rojo si la
copia supera el techo y verde con «bajó a N» si baja: cada renombre lo baja en su pull request. Sube sólo
en el commit que suma palabras a `words` (el freno frena el resto). Es un techo aparte del de nombres reales
(`names-ceiling.json`): miran cosas distintas y no pueden chocar.
