# Correr las pruebas

**Objetivo**: con el build verde (`step-05-implement.md`), correr la suite y la cobertura UNA sola vez con `test-gate.sh`,
resolver las dependencias nuevas y, si corresponde, lanzar el pase adversarial antes de los revisores. Cierra con
`marker.js complete-step run-tests`, que exige el verde de `test-gate.sh`.

## Inputs

- Build verde y archivos modificados por «Implementar»
- La story (`story_path`) y el repo (`repo_path`)

## Corrida liviana — las pruebas van acotadas

Si el marcador dice `size: liviana` (`pipeline.js next` lo recuerda en la nota), las tandas de la story se hacen en UNA
sola implementación y una sola vuelta de pruebas: no se corta por tanda. `test-gate.sh` corre sólo las suites que leen
algún archivo tocado (las que lo nombran, la suite misma, o las de su carpeta); las demás quedan en `deferred_suites`
como «diferida por ejecución liviana». El lanzamiento temprano del pase adversarial no aplica: el portón dice
«ejecución liviana».

## Test gate — suite + cobertura UNA sola vez

```bash
bash ~/.claude/agent-skills/skills/tycon-pipeline/scripts/test-gate.sh <repo_path> <story_path>
```

🔴 **Pasar la RUTA de la story, no el id**. Con la ruta, el gate deduce solo qué proyecto testear a partir de lo que la
story declara (`files_to_create` / `files_to_modify`) y saca el id del frontmatter. Con un id no tiene de dónde deducir
y, en un repo con más de un proyecto, **frena** (ver abajo).

En una sola corrida: suite de tests + cobertura, exit code REAL → `marker.checks.tests` (vía `run-check`), y escribe
`<repo>/.advisors/tests-result.json` (totales + cobertura por archivo NUEVO + `meets_threshold` 75% + `scope`/
`scope_source`: qué proyecto se miró y quién lo decidió). **El revisor `tycon-plugin-tests-coverage` de «Revisores» ya
NO corre tests él mismo: LEE ese artefacto**. NO re-correr la suite después de esto (regla
`test-execution-discipline.md`: suite completa máximo 1 vez).

Si el gate sale en rojo → mismo tratamiento que un build fallido: pausar, mostrar el resultado, corregir y re-correr.

**Story de dos repos**: si la story declara en `files_to_create`/`files_to_modify` archivos de un repo hermano
(`.tycon/advisors.yaml → evidence.companion_repos`; escritos relativos al hermano o con `<nombre>/` adelante), el gate
corre al terminar el mismo gate sobre ese hermano, con el alcance deducido de esos archivos. Su resultado va a
`companions` de `tests-result.json` y `all_green` dice el total; la salida es la del repo si falló, si no la del primer
hermano rojo (un repo sin pruebas con el hermano verde sale `0`), y un total rojo deja el check `tests` en rojo. La
copia sellada de evidencia es sólo la del repo de la story.

**Repos con `scripts/tests/suites.json` (el arnés):** las suites corren en paralelo (núcleos menos dos, o menos si
la máquina está cargada, y esperan si la carga pasa el doble de los núcleos; en la CI, la mitad;
`TYCON_SUITES_MAX_WORKERS=N` lo cambia, `=1` es la serie de antes), las `exclusive` corren solas al final, y las que
declaran `gate_only_when_touching` se DIFIEREN si la story no toca esas carpetas (hoy export-real: sólo corre si la
story toca `scripts/publishing/**`). Lo diferido queda en `tests-result.json` → `totals.deferred_suites`, con el motivo.
Si el repo declara `test_gate` en `.test-gate.yaml`, en su raíz (commiteado), corren sólo las suites que leen lo tocado y la
completa la corre la CI del pedido; si ninguna lo lee, sale 0 y lo dice. Un repo cuya suite no debe correr en la máquina
(le pega a la base de otra persona, a un servicio compartido) lo declara con `scope: none`, `full_suite_by` (quién la
corre) y `reason` (por qué): el portón no corre nada ahí y sale 3, «sin medir», con el motivo; los repos hermanos corren
igual. Es la forma de decirlo, en vez de un alcance falso, y cambiarlo pide la firma del dueño. Si lo tocado incluye una pieza central (un
archivo de código que nombran 40 suites o más), de las que la nombran corren sólo las que nombran la función o el
subcomando que cambió, o se llaman como ella; las demás quedan diferidas para la CI del pedido, y la salida dice
«<pieza>: corrieron k de las N suites que la nombran (para correrlas todas: TYCON_GATE_ALL_SUITES=1)». Si no se sabe qué
cambió adentro, corren todas las que la nombran, hasta el tope de la máquina.
**La suite completa no corre en la máquina del dev.** Con esa clave corren como mucho 60 suites (el repo lo cambia con
`test_gate.max_local_suites`): si las que leen lo tocado son más (un archivo de control, una pieza central), corren las
más cercanas al cambio y las demás quedan diferidas para la CI del pedido; la salida dice «tope de la máquina: N suites
leen lo tocado; corren las 60 más cercanas y K quedan para la CI del pedido», y el cierre repite que la completa la
corre esa CI. Las suites tocadas y las repetidas que quedaron viejas corren siempre. «Correr las pruebas» cierra con
eso. Si el gate no puede saber qué toca la story, no corre nada y sale 7, también con esa clave (como la corrida del
repo hermano y el árbol armado del privado), y dice cómo dar la base (`TYCON_COVERAGE_BASE`).
`TYCON_GATE_ALL_SUITES=1` corre todo: sólo a pedido de una persona. El nocturno y el control del PR no cambian.

### 🔴 El verde de `tests` tiene que venir de ACÁ, y de la suite COMPLETA

**`marker.js complete-step run-tests` BLOQUEA si `checks.tests` está verde y no lo puso este gate.** O sea: NO cerrar
el paso con un `run-check tests -- node --test <lista de archivos de la story>` a mano.

Por qué, medido en el cierre de una story: el check quedó verde con **872 de 2400** tests (los que la story
declaraba). La suite completa salía en **rojo con 13 fallas, dos de la propia story que se estaba cerrando**. La
diferencia entre «los tests que la story declara» y «todos» es exactamente donde se esconden las regresiones que la
story causó en otro lado. Cuesta ~2 min; aparecer todas juntas recién en el merge cuesta mucho más.

- El gate exporta `TYCON_TEST_GATE=1` → `run-check` anota `provenance=test-gate`.
- Si el repo no tiene suite completa, o hay que cerrar igual: declarar el control a mano lo decide la persona, no el
  agente; queda en `gates.log`. Se firma como las firmas de guion, también en Windows: la persona aprueba con el click o
  el «aprobado», y el agente corre `marker.js set-check <control> <estado> --force-manual` solo y en su forma exacta, sin
  un tubo atrás (`2>&1 | tail`) ni `cd … &&`. Fuera de su forma, el freno lo niega y pide correrlo solo; la terminal
  queda para quien la prefiera. `TYCON_TEST_GATE` escrita por el agente la frena el freno de seguridad: la pone sólo el
  gate.

### Salidas del gate

| exit | qué pasó | qué hacer |
|---|---|---|
| `0` | suite verde | seguir |
| `!=0` (1,2,…) | suite roja | pausar, corregir, re-correr |
| `3` | **sin medir**: el portón no reconoce ninguna herramienta de pruebas en el repo y no corrió nada. Deja `tests-result.json` con `no_stack: true` y el motivo en llano (`no_stack_reason`); el check `tests` queda `sin-medir`, también sobre un verde anterior. Un solo proyecto con pruebas en una subcarpeta ya no sale 3: se corre con ese alcance | seguir anunciándolo: `complete-step run-tests` y `step-11-prepare-commit.md` dicen «pruebas no medidas», y el cierre de la historia lo copia en una línea. Para medirlas, declarar el comando en el sitio de la organización (Configuración → Tu tecnología → Cómo se corren las pruebas) |
| `4` | **FRENO**: el repo tiene más de un proyecto testeable y no se pudo deducir cuál | pasar el alcance a mano: `test-gate.sh <repo> <story> <subdir>` |
| `5` | **no pude correr las pruebas**: falta el corredor (`npx`, `dotnet`, `npm`), o el shell lo ve pero no se puede lanzar. No se corrió nada (`halted: true`, `missing_tool`) | NO tocar las pruebas: instalar la herramienta o abrir la sesión con un PATH que la vea, y re-correr el gate |
| `6` | la suite salió 0 pero **no corrió ninguna prueba** (o no dejó un resumen que las cuente): no es verde | mirar `no_tests_run` en `tests-result.json`: alcance vacío, todas saltadas o `todo`, o un resumen ilegible; corregir eso y re-correr |
| `7` | **sin acotar**: la corrida del repo hermano no pudo acotarse a lo tocado (no se supo qué se tocó, o ninguna suite lo lee) y no corrió nada. El portón acotado por el repo (`test_gate`) sale 7 sólo si no se supo qué se tocó (la completa no corre en la máquina); si ninguna suite lee lo tocado sale 0. No es verde ni rojo (`unscoped: true` con el motivo, `merge_requires_ci: true`; el check `tests` queda `sin-acotar`) | seguir anunciándolo: la cubre la CI del pedido, y antes del merge hay que mirar que salga verde. Nada en la máquina lo comprueba: `merge_requires_ci` es un dato del informe, no un freno. No forzar la completa en la máquina (`TYCON_GATE_ALL_SUITES=1`) salvo pedido del dev |
| `8` | **entorno sin preparar**: la organización declara un entorno de pruebas para el repo (`stack.test_environments`: una base local, un servidor, variables) y no quedó listo: la preparación falló, pasó su tope o no dejó una variable que pide. No se corrió nada (`env_not_ready: true` con el motivo en `tests-result.json`; el check `tests` queda en rojo con la salida 8, para que un verde viejo no valga). No es un rojo de la historia. Un 8 sin `env_not_ready` en el informe es la salida de la propia suite: un rojo como cualquier otro | NO tocar las pruebas ni el código: preparar lo que dice el motivo (levantar el contenedor, liberar el puerto) o arreglar la receta, y re-correr el gate |
| `75` | **no corrió nada**: otra corrida de las pruebas ya está en marcha en este repo (`run-check tests` lo dice con la hora de inicio, su pid y su sesión), o no hay lugar en el turno de las ejecuciones grandes de la máquina, que se pide desde 100 suites por correr: ya corren dos, o corre una y la memoria no alcanza para la segunda (debajo del piso, 50 % si nadie lo cambia, o sin poder medirla; la negativa dice quién corre, la memoria y el piso; o hay un pase adversarial en vuelo y el portón no puede ir a su lado: corre más de 40 suites, ya hay otro portón al lado del pase, o la memoria libre está debajo del 40 %; el check `tests` queda `sin-turno`, ni verde ni rojo, para que un verde viejo no valga: los cierres de los pasos frenan pidiendo el turno, y el cierre del turno deja parar). No es verde ni rojo: no escribe `tests-result.json` ni corre los repos hermanos | esperar el resultado de esa corrida, no relanzar. Si quedó colgada, la negativa dice cómo destrabarla |
| `77` | no sale del portón: es lo que sale el corredor de las suites con el turno de las ejecuciones grandes en manos de otra sesión, y el portón lo da como `75` | lo mismo que `75` |
| `76` | **no corrió nada**: en la última corrida completa fallaron suites que todavía no salieron verdes solas (la lista vive en el marcador, `testsFailed`). No escribe `tests-result.json` ni toca el check `tests` | después de un rojo, repetir primero la suite que falló: `bash …/test-gate.sh <repo> <story> --suite <ruta>` (la negativa da el comando de cada una). En verde sale de la lista; con la lista vacía, se corre otra vez el portón completo. En un repo que acota el portón (`test_gate` en `.test-gate.yaml`) o en el árbol armado del privado (ahí se compara cada repo), ese portón no siempre corre todo: si la carpeta no cambió desde la completa roja ni desde cada repetición, cierra con lo guardado sin correr ninguna suite; si cambió desde la completa (también por traer main), corren sólo las suites que leen lo cambiado, y cada repetida cuya carpeta cambió después de repetirla vuelve a correr; si cambió el recorte o la lista de suites, o lo cambiado toca un control, el instalador o lo compartido, corre la completa como siempre. Una suite sola, por sí misma, no cierra este paso, salvo en una corrida acotada (la cruzada, el árbol armado del privado o el repo que acota) sin lo guardado de la completa roja: cuando la repetición saca la última roja y la constancia queda en verde, el portón deja `tests` en verde, porque la completa la corre la CI del pedido. Si queda otra roja, una ausente, una sin medir o un repo hermano rojo, sigue en rojo |
| `78` | **espera a main**: lo que quedó rojo está roto también en la última versión de `main`, con los mismos casos (el tercer juez, `lib/main-check.js`, lo midió en una copia de main que se reusa, o reusó lo que otra sesión ya midió). No es un rojo de la historia ni es verde: el check `tests` queda `espera-main`, la espera queda anotada en el marcador (`waitingOnMain`) y en el registro de main roto del repo (`main-<n>`, con las sesiones que esperan; `main-check.js status --repo <r>` lo muestra), y no escribe `tests-result.json`. En la mezcla (alguna de main y alguna de la historia) sale rojo como siempre, con las de main nombradas aparte y marcadas en la lista de la 76 (no hay que repetirlas): la historia arregla las suyas y, cuando sólo quedan las de main, la corrida siguiente sale 78 | **NO** tocar esas pruebas ni el código por ese rojo; **NO** pedir una vuelta extra ni preguntarle al dueño: no es un hallazgo de la historia ni una vuelta. Decirle a la persona en una línea «main está roto en <suites>: espero a main (<id>)» y cerrar el turno: el cierre del turno deja parar con la espera anotada. La historia no avanza («Correr las pruebas», «Preparar el pull request», `review` y `done` se frenan) hasta que main pase y su portón salga verde. En Claude Code, dejar de fondo `node …/skills/tycon-pipeline/scripts/lib/main-check.js wait --repo <r> --id <id>`: mira `origin/main` cada 5 minutos, mide las suites del registro sólo con una punta nueva y la memoria sobre el piso, y sale 0 con «main pasó: <sha>; traé main y repetí el portón» (entonces traer `main` a la rama y volver a correr el portón) o 3 a las 8 horas («main sigue roto hace 8 h (<id>)», en una línea a la persona, y volver a dejarla). En Codex (sin ejecución de fondo con aviso), al empezar cada turno correr `node …/skills/tycon-pipeline/scripts/lib/main-check.js status --repo <r>`: si dice que el registro se cerró (main pasó), traer `main` y volver a correr el portón. Con repos hermanos, la espera es una por repo y un rojo de cualquier repo gana sobre ella. Si el portón dice «main ya pasó (<sha>) y esta rama no lo trae», traer `main` antes de tocar la suite. Quien toma el arreglo de main lo anota con `main-check.js fix --repo <r> --id <id> --session <sesión> [--pr <n>]`: es uno solo para todas las que esperan |
| `129` | la corrida se cortó (la terminal se cerró) mientras medía el repo privado adelgazado: la carpeta del árbol armado se borró y la corrida de las suites se cortó. No es verde | re-correr el gate |
| `130` | la corrida se cortó con Ctrl-C mientras medía el repo privado adelgazado; lo mismo que el `129` | re-correr el gate |
| `143` | la corrida se cortó con una señal de terminación mientras medía el repo privado adelgazado; lo mismo que el `129` | re-correr el gate |

**Después de un verde, el portón corre sólo lo que cambió desde el último verde de la historia.** En un repo que acota
el portón (`test_gate` en `.test-gate.yaml`) o en el árbol armado del privado, una completa verde que midió todo lo suyo
queda guardada, y un cierre en verde con lo guardado (también desde una roja con sus rojas repetidas solas) guarda su
resumen juntado como el nuevo verde: «guardé este verde (juntado con la completa de las HH:MM): la próxima corrida corre
sólo lo que cambie desde acá». Nunca queda como punto de partida una acotada sola: el juntado trae una suite por cada una
de la completa de origen. Un cierre rojo deja lo guardado como estaba; uno en verde que no se puede guardar (una ausente,
una sin medir, una roja perdonada en lo guardado sin el resumen de antes del perdón, un guardado que falla) también, y
lo dice en «no guardo este cierre: …». Si la carpeta cambió mientras corría, guarda igual con la foto del arranque («la
carpeta cambió mientras corría: guardo con la foto del arranque…»): la próxima corrida vuelve a correr lo que lee lo
cambiado durante la corrida. Esa foto no sirve para acotar por lo que trajo main, que sigue pidiendo la carpeta quieta.
La corrida siguiente compara la carpeta con la del último verde:
- Si no cambió nada, cierra con lo guardado sin correr ninguna suite («cierra con la completa de las HH:MM: la carpeta
  no cambió»).
- Si cambió algo, corren sólo las suites que leen lo cambiado y se juntan con lo guardado («la completa de las HH:MM
  más N suites por lo cambiado (…)»).
- Si lo cambiado toca la carpeta de una suite de carpeta (`gate_only_when_touching`), o el instalador con lo guardado
  rojo, esa suite también corre, sin pasar por los filtros, aunque la completa la haya diferido o ya medido («… y las que
  vuelven por sus carpetas (…)», con el renglón «VUELVE» del corredor); una que ya no está en la lista cuenta como
  ausente. Lo guardado deja de tenerla como diferida cuando corrió.
- Corre de nuevo todo lo que lee lo tocado (la «completa» de esta sección, siempre dentro del tope de la máquina), y
  la línea dice por qué, si cambió un control (`scripts/ci/controls-from-base.json`),
  el instalador o algo compartido (`scripts/ci/heavy-suites.json`), la lista de suites, la base o el recorte; en el
  privado, algo bajo `pipelines/`, `scripts/ci/`, `scripts/hooks/` o `.githooks/`; si lo guardado es de otra historia
  o está tocado; o si algo no se pudo comparar.

`tests-result.json` dice `suite_green_by: "completa-guardada"`, la hora de esa completa (`completa_at`) y lo cambiado
(`changed_since_full`). Para forzar la completa: `TYCON_GATE_ALL_SUITES=1`. La completa la sigue corriendo la CI del
pedido y la cola de main.

**Cada corrida dice por qué corre lo que corre.** El portón de arriba imprime un solo renglón «modo <primera | entera |
acotada | sin correr> · <motivo>». Sin nada guardado lo dice («no hay un verde guardado de esta historia en esta
sesión»), con el motivo de la última corrida que no guardó si la hubo. Cada corrida terminada en verde o en rojo anota su
nota en el marcador (`testsSavedNote`, una por repo, con la historia) y un renglón `test-gate-run` en `gates.log`; la
cortada, la sin turno y la ocupada no anotan. Las horas de repetición por día, con las enteras agrupadas por motivo:
`node {raiz}/scripts/tools/suite-times.js repeats [--since <fecha u hora>] [--until <fecha u hora>] [--json]` (los días
de antes del renglón se clasifican por el comando, «sin motivo: de antes del registro»; sale 3 si no hay corridas).

Una suite roja que ya estaba roja en el nocturno de esa mañana avisa y no frena, con la misma regla que la validación
de cada pedido: el portón pasa su resumen por el juez de los pedidos con la foto nocturna que viaja en el árbol armado
(`lib/inherited-reds.js`). Lo heredado sale de la lista de «repetir primero» y queda escrito en `inherited`; lo nuevo
frena como siempre. Lo mismo al repetir una sola con `--suite`: si ya estaba roja en la foto, sale de la lista y deja
en verde `tests-suite`. Sin foto (el repo público solo), o si la foto no sirve (vieja, tocada o ilegible), lo rojo se
mide en la base, en el momento: cada roja corre sola sobre la bifurcación con `origin/main`, sin el cambio. Roja también
ahí, es heredada (`measured_on: "base"`); verde ahí, el rojo es del cambio y frena; sin poder medirla (sin
`origin/main`, la suite no está en la base, pasó el tope, el árbol armado del privado), sigue roja y dice «no medido» y
por qué. Queda escrito en `base_check`. Topes: `TYCON_INHERITED_BASE_MAX` suites (3; 0 la apaga) y
`TYCON_INHERITED_BASE_TIMEOUT_S` segundos por suite (600).

Con .NET (y con otra herramienta que deja un trx) y con jest o vitest, `tests-result.json` dice además cuáles
pruebas fallaron: `failed_tests`, con el nombre de cada una. En jest y vitest va también el archivo; en el trx, el
resultado (`outcome`), porque la lista suma las que dieron error o se cortaron y el total del trx no. Va hasta 100, y
`failed_tests_more` dice cuántas más hubo. Un archivo de jest que falló sin ninguna prueba fallida va igual: con
`did_not_run: true` si no corrió ninguna, y con `file_failed: true` si corrieron todas y pasaron. Sirve
para comparar con las que ya fallaban antes del cambio. Hoy no perdona nada: en estos repos, una falla de antes
todavía frena.

Una repetición sola que sale verde también saca su falla de la constancia de la completa (`tests-result.json`, la que
lee el revisor de pruebas, y su copia que viaja), si es de esa misma completa: cuando no queda ninguna otra causa de
rojo, la constancia queda en verde con `suite_green_by: "repeticiones"`. Si la constancia es de otra corrida, de antes
de este cambio o no está, no se toca y la salida dice por qué.

El `4`, el `5` y el `6` dejan además el check `tests` del marcador en **rojo** con su código: un verde de una corrida
anterior no queda en pie cuando esta corrida no pudo correr o no contó nada.

El `4` **no corre ninguna suite** y deja `tests-result.json` con `halted: true` — constancia del freno, no de un
resultado. Avisar por stderr y correr igual el stack equivocado deja una constancia en rojo, con el id de la story
puesto, de código que la story jamás tocó. Un control que avisa y sigue se aprende a ignorar, y una constancia del
proyecto equivocado es peor que ninguna porque **parece** verificación.

## Modo autónomo — registrar checks build + tests (Nivel 1)

**Esta sección corre por DEFAULT** (`marker.autonomous === true`, que es lo que el Arranque deja puesto salvo
`--no-autonomous`). 🔴 **No la saltees «porque no viste el flag»**: el Stop-hook del modo autónomo sólo mira los checks
REGISTRADOS, así que un build en rojo sin su `run-check build` le queda **invisible al portón** y el turno cierra como
si todo hubiera pasado. Si la ejecución es con persona explícita (`marker.autonomous !== true`), saltear.

Tras correr el build gate **y** el test gate, los checks quedan registrados con el resultado REAL (exit code
capturado, NO lo que «parece»):

```bash
# build: ground-truth vía run-check (execFileSync sin shell — exit code real → marker.checks.build=green|red:exit=N).
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js run-check build -- dotnet build
#   o: ... run-check build -- npm run build  /  ... run-check build -- npx tsc --noEmit
#   (si no hay build definido → ... set-check build green --manual — salteo no bloqueante, queda
#    logueado como provenance=manual)

# tests: los registra test-gate.sh (run-check interno → marker.checks.tests).
#   NO usar set-check directo para tests — set-check queda solo para excepciones con --manual.
```

🔴 **Ground-truth**: el estado sale del exit code real del comando capturado por `run-check` (provenance=run-check +
entrada en gates.log), no de lo que el agente dice (mismo principio que CF-2). Si build/tests quedan en `red:...`, el
Stop-hook DoD gate **bloquea el cierre del turno** y fuerza el ciclo: el agente arregla, vuelve a correr build/tests y
re-registra el check. Cuando ambos pasan a `green`, el portón deja avanzar.

## Dep-gate — dependencias nuevas no declaradas (adopción BMAD 2026-07-02)

Con build verde, ANTES de «Revisores», correr el gate mecánico de dependencias nuevas. Adopta el HALT de
`bmad-dev-story` (*«new dependencies beyond story specifications → need user approval»*) que TYCON no tenía: los
revisores de seguridad atrapan un paquete **vulnerable**, no un paquete **legítimo que nadie aprobó**.

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js dep-gate \
  --repo <repo_path> --story <story_path>
```

Diffea las dependencias AGREGADAS (`package.json` / `*.csproj` / `Directory.Packages.props`) contra HEAD y contra el
texto de la story. Sin commits todavía, contra el árbol vacío (todo es nuevo); un manifiesto sin trackear cuenta
entero. Deja su resultado en `dep-gate.json`, en la carpeta de la ejecución. Un paquete es **nuevo** solo si su nombre
aparece en líneas `+` pero no en `−` (filtra churn de coma y bumps de versión). «Declarado» = el nombre del paquete
aparece textualmente en la story (match conservador, verificable — no inferencia).

**Decisión post-output**:
- **`gate: pass`** (exit 0) → seguir.
- **`gate: no-medido`** (exit 0; la carpeta no tiene git o `git diff` falló) → decírselo a la persona en una línea, con
  el `reason`, y seguir. No es «sin dependencias nuevas»: `write-findings` lo levanta de `dep-gate.json` y el informe
  de «Hallazgos» lo lleva en «Sin medir».
- **`gate: pause`** (exit 2, hay `undeclared[]`) → **PAUSAR**. Mostrar la lista: *«La implementación agregó estas
  dependencias no declaradas en la story: {undeclared}. ¿Las aprobás? Si sí, las agrego al spec antes del commit.»*
  Tres caminos: (a) aprobar + agregar al spec (frontmatter/AC) y re-correr, (b) override consciente si es falso
  positivo (paquete mencionado con otro nombre) anotándolo, (c) revertir la dependencia.

**Cuándo no mide** (verificable, no inferencia — regla E.i): el gate devuelve `no-medido` solo si el repo no tiene git
o `git diff` falla. NO se saltea «porque parece que no agregó nada»: si no agregó nada, el propio comando devuelve
`pass` con `new_deps: []`.

## 🔀 Lanzamiento TEMPRANO del pase adversarial (Fase B paralelización, 2026-07-30 — DEFAULT ON)

**Prendido por defecto**, con las mitigaciones ya cableadas (tope 2 de ventana en «Revisores», verificadores en ventana
de 3, candado anti-suite-completa en los cazadores). Kill-switch: `export TYCON_5B_EARLY=0` → lanzamiento clásico en
`step-08-adversarial-pass.md`. El switch es MECÁNICO: `deep-review-gate` lee la variable y devuelve
**`early_launch: true|false`** en su JSON. **`early_launch: false` → saltear esta sección entera.**

> 🔴 **`pipeline.js next` es el que lo recuerda.** Con `run-tests` cerrado, `next` trae `pending_action`:
> `consultar-porton` (falta el veredicto: correr el portón, punto 1 de abajo) o `lanzar-pase` (el portón dijo «corre»:
> lanzar, puntos 3 y 4), ANTES del primer revisor. El portón deja su veredicto anotado en la ejecución
> (`adversarialGate`), y el apagado visto una vez vale para toda la ejecución (un `TYCON_5B_EARLY=0` en un comando suelto
> alcanza; `=1` explícito lo vuelve a prender). Medido antes: 52 de 208 ejecuciones con pase lo lanzaron más de 2 min
> después del primer revisor. Si el pase ya salió en este turno y falta anotarlo, se anota con
> `mark-adversarial-launched` y no se relanza. Lo que sigue es el detalle de qué hacer en cada caso. 🔴 **La primera ejecución NORMAL con
> esto activo ES la de medición**: contar procesos pesados simultáneos (no solo cronometrar) y con eso ajustar el tope 2
> de «Revisores»; si la máquina sufre, `TYCON_5B_EARLY=0` y se recalibra.

**Precondiciones duras, en este orden** (cada una puede cambiar el diff o frenar; lanzar antes de resolverlas quema el
único lanzamiento sobre un diff que va a cambiar): build verde → `test-gate.sh` verde → `dep-gate` resuelto (es una
PAUSA con persona: si el dev revierte una dependencia, el diff cambia) → **`marker.js complete-step run-tests` VERDE**
(el mismo comando que pide la nota de `pipeline.js next`; corrido acá, `next` sigue coherente). **Solo con los CUATRO
resueltos, lanzar.**

1. Evaluar el gate: `pipeline.js deep-review-gate --repo <r> --story <s> --files <archivos de código del diff>`.
   **`run: false`** → anunciar el salteo en 1 línea y anotarlo con
   `node .../scripts/marker.js mark-adversarial-skipped --files <los mismos archivos>`: el comando le vuelve a
   preguntar al portón y sólo anota si el portón dice que no corre (salteo + cierre del pase en una sola escritura,
   línea `adversarial-skip` en `gates.log`). Dejar además el `reason` en `<RUN_DIR>/step-05b-adversarial.md` (el paso
   `step-08-adversarial-pass.md` no se alcanza: `next` lo da por atendido; es el no-op esperado). 🔴 La bandera del
   pase no se escribe a mano, y `complete-step adversarial-pass` frena sin esta constancia. **`run: true` +
   `early_launch: true`** → seguir. **Sale 3 (`waiting_turn: true`)** → otra sesión tiene su pase en vuelo y va uno por
   vez: no lances. El texto (`turn`) dice quién tiene el lugar. Seguí con los revisores. La coordinadora te avisa cuando
   se libera, y `pipeline.js next` deja de pedir esperar (`esperar-turno-pase`): ahí lanzá.
2. Lanzar con el `model` que devuelve el gate: no se pregunta por otro modelo.
3. 🔴 **Validar `files` NO vacío y de CÓDIGO antes de invocar**: si la lista quedó vacía o mal armada, el workflow
   retorna un no-op instantáneo y el lanzamiento se quema (el guard bloquea relanzar sin `--relaunch`). La lista debe
   ser **EXACTAMENTE la misma que después se pasa a `pipeline.js advisors` en «Revisores»**: si divergen, el pase
   audita otro diff que los revisores, en silencio.
4. Congelar lo que va a mirar el pase, armar la lista de sus repos y pasarle sus sellos:
   ```bash
   node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js freeze-adversarial > <RUN_DIR>/congelado.json
   node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/lib/frozen-tree.js lista-del-pase <RUN_DIR>/congelado.json
   ```
   `freeze-adversarial` sella cada repo de la corrida y arma su copia de sólo lectura en la carpeta de estado. Devuelve
   `{ sellos, copias, repos }`, con la base de cada repo. Sale 2 si no puede sellar o copiar: el pase no se lanza sobre
   la carpeta viva. `lista-del-pase` da los `repos` del `Workflow`, y sale 2 si un repo con código no tiene base: el
   pase no se lanza, y se dice qué repo es y por qué (`step-08-adversarial-pass.md` §Acción). Invocar la tool `Workflow` (args
   idénticos a `step-08-adversarial-pass.md` §Acción, incluido `runDir`, el RUN_DIR de esta ejecución, y los `sellos`
   y las `copias` de arriba: sin `runDir` las pruebas que confirman los hallazgos caen en una carpeta genérica, sin
   `sellos` su resultado no se anota, y sin `copias` el pase lee la carpeta viva y no lo congelado) e **INMEDIATAMENTE después (mismo turno)** registrar el estado con el runId que devolvió la
   tool:
   ```bash
   node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js mark-adversarial-launched <runId> 4
   ```
   (el `4` es un identificador guardado que se conserva tal cual). Sin este registro, un retome de sesión no puede
   detectar el workflow huérfano y el join de `step-08-adversarial-pass.md` se rompe. Exit 2 = ya se lanzó en esta
   sesión (guard). Relanzamiento LEGÍTIMO (no-op por files vacío, diff viejo): repetir con `--relaunch` — queda auditado
   en `bypass.log`.
5. **Cancelación del pipeline con el pase en vuelo**: intentar `TaskStop` sobre la tarea del Workflow. ⚠️ No está
   verificado que `TaskStop` cancele Workflows; si no lo cancela, anotar en el log «workflow huérfano, termina solo y
   su resultado se descarta» y seguir con la cancelación normal (no es bloqueante).

**Consecuencia para «Revisores»** (ver `step-07-reviewers.md` §Cap reducido): mientras el workflow esté en vuelo, la
ventana de revisores baja a ≤2 (el workflow son 6 cazadores + verificadores en ventana de 3, no 1 proceso).

**Riesgo asumido — multi-sesión**: PIPE-C0 detecta conflicto de STORY, no de recursos; no hay tope entre sesiones
(mecanismo nuevo, fuera de alcance). Regla operativa mientras tanto: **no correr dos pipelines con el pase temprano a la
vez en la misma máquina**: si ya hay otro pipeline activo (`marker.js list-all`), exportar `TYCON_5B_EARLY=0` en esta
ejecución. Y si el otro pipeline corre sobre el MISMO repo, el tope no alcanza: **un worktree por story** (árbol
compartido = `git diff HEAD` contaminado + `.advisors/tests-result.json` pisado); ver PIPE-C0 §Stories distintas en
paralelo en `step-01-start.md` y `~/.claude/tycon-harness/guides/git-worktrees.md`.

## Cerrar el paso

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js complete-step run-tests
```

Exige el verde de `test-gate.sh` en `checks.tests` (con la salvedad de «pruebas no medidas», «sin acotar» o mutantes
que el comando dice, y que se anuncian). Pasar a «Revisores» (`step-07-reviewers.md`) con `marker.checks.tests` en
verde (o el test gate saltado por no haber suite: anotarlo en el log).

## Output de este paso

- `<repo>/.advisors/tests-result.json` (artefacto de `test-gate.sh`; lo consume «Revisores»)
- `dep-gate.json` en la carpeta de la ejecución
- Si el pase adversarial se lanzó acá: el `runId` registrado con `mark-adversarial-launched`
