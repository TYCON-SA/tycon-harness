# El mecanismo de instalación y actualización del arnés (`harness.js`)

## Qué es

Un programa —`scripts/setup/harness.js`, Node ≥ 20, sin dependencias, uno solo para Mac, Linux y Windows— que toma el lugar de
la línea de arranque que cada dev escribía a mano. Instala con un comando, sigue un canal, se actualiza solo o avisa según la
política, deja estado, y arranca desde una copia fija que no vive en el árbol que actualiza. **El instalador de siempre
(`scripts/install-tycon-hooks.sh` y su gemelo `.ps1`) sigue siendo el que aplica** los hooks, bloques y enlaces en la máquina:
`harness.js` lo llama.

| Comando | Qué hace | Toca la máquina |
|---|---|---|
| `install [--channel <c>] [--local <clon>] [--from-existing] [--source <url>]` | primera instalación desde un clon: enlace, estado, copia fija de arranque, línea de arranque, `@import`, aplicador. `--from-existing`: sólo el estado y la línea sobre un clon y un enlace que ya están (lo llama el aplicador) | sí |
| `startup [--force]` | lo que corre la línea de arranque de cada sesión: engram si está prendido, `update` según la política, **el aplicador siempre**, comprobación de salud; sale 0 siempre | sí (según política) |
| `update [--check] [--dry-run] [--yes]` | trae la punta del canal de **cada fuente**; con versión nueva: mueve los árboles, aplicador, salud. `--check`: 0 al día · 3 hay nueva · 2 no pude mirar | sí / no |
| `apply` | corre el aplicador | sí |
| `version [--json]` | versión instalada, canal, modo, fuentes, shas | no |
| `doctor [--json] [--fetch]` | diagnóstico de sólo lectura (`--fetch` es la única excepción: escribe `FETCH_HEAD`) | no |
| `channel [latest\|stable]` | muestra o fija el canal en `~/.claude/tycon.json` | sólo `tycon.json` |
| `rollback …` · `uninstall …` | la vuelta atrás que se queda y la desinstalación de sólo lo registrado | sí |
| `link --local <clon> [--allow-temporary]` / `link --managed` | modo desarrollador: el enlace apunta a un clon propio y `update` no toca su git | enlace y estado |

## Dónde vive cada cosa

- **El estado**: `~/.claude/.tycon-pipeline/harness-state.json` (`schema: 1`): `mode` (`managed` | `developer`), `tree`,
  `sources` (en los repos internos son dos: `harness` y `agent_skills`, cada una con `url`, `ref`, `rewrites`, `commit`,
  `previous`), `channel`, `version`, `managed` (las piezas registradas), `hold` (la retención que deja un
  `rollback`), `notice` (el aviso pendiente que imprime el hook síncrono), `last_fetch`, `last_apply`,
  `last_health`, `failed`, `bootstrap` (sha256 de la copia fija), `repoint` (la mudanza del clon de skills: ver «La llave
  de las skills»). Un estado ilegible **no** es «no instalado»: los comandos
  salen 2 nombrando el problema; `startup` avisa y no toca nada.
- **El candado**: `~/.claude/.tycon-pipeline/harness/harness.lock` (`mkdir`, pid adentro, huérfano a los 10 minutos). Todo
  comando que escribe lo toma y relee el estado adentro. La segunda sesión que llega mientras la primera trabaja se va en
  silencio con 0 (`startup`) o sale 3 «otra sesión está actualizando». El aplicador lanzado por `harness.js` recibe
  `TYCON_HARNESS_LOCK_HELD=1` y no toma el suyo.
- **El registro**: `~/.claude/.tycon-pipeline/harness/startup.log` (rotado a 1 MB). `startup` manda todo error ahí y a
  **una** línea por stdout.
- **La copia fija de arranque**: `~/.claude/.tycon-pipeline/harness/{bootstrap.js, bootstrap-fallback.sh, bootstrap-fallback.ps1}`.
  La línea de arranque llama a **esa copia**, no al árbol:
  - Mac/Linux: `node "$HOME/.claude/.tycon-pipeline/harness/bootstrap.js" || bash "$HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh"`
  - Windows: `pwsh -NoProfile -ExecutionPolicy Bypass -Command "node '<HOME>/.claude/.tycon-pipeline/harness/bootstrap.js' || & '<HOME>/.claude/.tycon-pipeline/harness/bootstrap-fallback.ps1'"` — sin ningún `$`: en Windows, Claude Code lanza los hooks por Git Bash, que se come lo que empieza con `$`; la forma anterior (`if ($LASTEXITCODE -ne 0)`) salía 1 en cada sesión, y `startup` la pasa sola a ésta

  `bootstrap.js` comprueba el piso de Node, que el enlace resuelve y que el árbol tiene `harness.js`, y lanza `harness.js
  startup`; si algo de eso falla, el respaldo en shell hace el `git pull --ff-only --autostash` de siempre sobre los dos
  repos y corre el aplicador. Así un `harness.js` roto, un enlace colgado o una versión que no arranca no dejan una máquina
  quieta. La copia **sólo se refresca** desde el árbol cuando un `update` pasó la comprobación de salud, o en `install`. Es la
  doctrina «lo durable no viaja por el camino roto».

## La política: canal y aplicación

Dos claves de la configuración (`scripts/lib/tycon-config.js`; variable › `~/.claude/tycon.json` › perfil del equipo › por
defecto): `update.channel` (`latest` | `stable`, por defecto `stable`) y `update.apply` (`auto` | `ask`, por defecto `ask`).
Variables: `TYCON_UPDATE_CHANNEL`, `TYCON_UPDATE_APPLY`, `TYCON_UPDATE=0` (apagado del todo). El perfil del equipo trae
`latest` + `auto`; sin perfil (la copia pública no lo trae) una máquina queda en `stable` + `ask`. Mientras el equipo instala
desde los repos internos, `stable` y `latest` son lo mismo (`main`), y `doctor` avisa si una máquina con remoto interno quedó
en `ask` («una máquina del equipo sin el perfil»).

«Preguntar» desde un hook de arranque —que no tiene terminal— es un **aviso** que `startup` deja en el estado (`notice`) y que
imprime el hook síncrono `branch-guard-notice.js`, dirigido a la persona: «decile a la persona; no lo apliques sin que te lo
pida». La decisión es de la persona, nunca del agente. El grito «arnés atrasado» de ese hook sólo suena en `managed` con
`apply: auto`: en `developer`, en `ask` o con `TYCON_UPDATE=0` el atraso es decisión de esa persona y lo dice `doctor`.

Con `ask`:

- **El aviso** trae el número de la versión nueva con su sha corto, la instalada, el canal, el comando para aplicarla y
  dónde ver los cambios: en `stable`, la comparación entre lo instalado y lo nuevo; en `latest`, entre la punta de `main` y lo
  nuevo (nunca entre dos commits de `mirror/sync`: el viejo pudo ser reescrito); con un remoto interno no hay enlace, y va el
  `git log a..b` listo para pegar. La base del enlace sale del origen fijado, nunca de una constante.
- **Cada cuánto mira**: una vez cada 6 horas como mucho. Con `auto` siguen los 10 minutos. Un intento que no pudo mirar (sin
  red) no cuenta: se reintenta a los 10 minutos. `update` a mano mira siempre.
- **`update` sin `--yes`** no aplica: dice que hay una versión nueva y suma la misma línea «cambios: …» del aviso.
- **`update --yes` pide una terminal.** Sin terminal —la herramienta Bash de un agente— sale 2: «`--yes` necesita una
  terminal, o `apply: auto` en la configuración». Con `auto` no la pide: ahí la persona ya decidió.

**`latest` + `auto` en una copia pública** es recibir lo que el equipo del arnés empuja, en minutos y sin revisión propia. Por
eso el programa no deja llegar a esa combinación sin que la persona lo diga: escribir `auto` de puño y letra (la variable, o
`update.apply` en el `tycon.json` propio) ya es confirmarlo; y `channel latest` o `install --channel latest`, cuando la
aplicación ya es `auto` por archivo, preguntan en la terminal (sin terminal, 2). `doctor` lo recuerda en cada corrida.

## Cómo actualiza

`update` trabaja sobre **todas las fuentes** del estado, `agent_skills` primero y `harness` después, y sólo corre el aplicador
cuando las dos avanzaron; si una no puede, no mueve ninguna y nombra el motivo. Por fuente: sobre una ref que **no se
reescribe** (`main` interno) hace `git fetch origin <ref>` y avanza con `merge --ff-only` (lo local se aparta en un stash
propio; sólo los no trackeados de `.dashboard/` se apartan solos; si divergió no toca nada); sobre una ref que **se reescribe**
(las dos del repo público: ver «Los canales y las versiones») trabaja sobre una rama local `tycon/installed` y la lleva a lo
traído con `reset --hard`, sólo sin cambios en los archivos seguidos; lo que la persona creó aparte no lo traba. Antes de mover guarda `previous` en el estado y en
`refs/tycon/previous/<fuente>`. Nunca `git pull`. Sin red termina en ≤ 15 s (`TYCON_UPDATE_NETWORK_BUDGET_S`) y dice «sin
red». Se niega si el `origin` de una fuente no es el que `install` fijó (`sources[].url`); si el cambio es a propósito,
`install --source <url>` re-fija la fuente cuyo `origin` actual es esa URL.

## Los canales y las versiones

- **Qué ref sigue cada canal** en un clon del repo público: `latest` es `refs/heads/mirror/sync` y `stable` es
  `refs/heads/main`. Las dos se consumen igual —rama local `tycon/installed` y `reset --hard` a lo traído—, porque el commit de
  `mirror/sync` que alguien instaló deja de ser ancestro de todo cuando la rama se reescribe. La ref sale de la política vigente
  en cada `update`, `startup` y `doctor --fetch`: cambiar el canal por la variable, por `tycon.json` o por el perfil vale igual
  que `channel`. Si `mirror/sync` no está, o su número es menor que el de `main`, `latest` lee `main`.
- **Cómo se reconoce un clon del público**: por su remoto, comparado contra la lista que el exportador deja en la copia
  (`scripts/setup/public-remotes.json`; en los repos internos ese archivo no existe). Con cualquier otro remoto, los dos canales
  son `main` sin reescritura: es un clon interno, y `doctor` lo dice.
- **El número**: `YYYY.MM.DD.N`, estampado en `version.json` por **la sincronización** y sólo cuando el árbol publicable
  cambió. La fecha es la del commit (la mayor fecha de committer de los dos internos, en UTC), nunca el reloj de la corrida; `N`
  es el orden en el día, contado sobre la punta de `main` y la de `mirror/sync`. El merge del pull request no cambia el número:
  la versión estable **es** la que había en la rama.
- **No bajar**: se decide por número (partes numéricas: `2026.09.30.10` es mayor que `2026.09.30.9`), no por ancestría. Pasar a
  `stable` con una versión instalada más nueva no baja: «instalada X, estable Y: no se baja; para volver, `rollback`», y aplica
  la próxima estable mayor o igual. Número igual con sha distinto se aplica (es el commit de merge).
- **Lo que la persona creó dentro del clon** (una skill propia en `skills/`, por ejemplo) no traba el movimiento. Lo traba
  sólo un archivo sin seguir cuya ruta choca con una que la versión nueva trae: ahí no se toca nada y se nombra la ruta.
  Choca también lo que en disco es el mismo archivo aunque difiera en mayúsculas o en la forma de un acento (Mac y
  Windows no las distinguen), y una carpeta propia que es un repo de git entero, si la versión nueva trae cualquier ruta
  bajo ella. Si no se puede listar lo sin seguir, tampoco se mueve. Lo **ignorado** por git no cuenta: se supone
  regenerable.
- **Con ref reescrita se mueve sólo desde `tycon/installed`**, o la primera vez: con `HEAD` en el commit registrado, o en un
  avance simple de la rama por defecto (un `git pull` a mano, o el respaldo en shell del arranque), que se re-registra y
  sigue. En una rama propia o con commits propios no toca nada y avisa; el remedio que imprime nunca nombra una rama
  que no existe (antes de la primera actualización: `git -C <clon> checkout -b tycon/installed <commit registrado>`).
  Ojo: `tycon/installed` es del mecanismo; un commit propio hecho sobre ella sale de la rama en la próxima actualización
  (queda en `refs/tycon/previous/<fuente>`), y `doctor` lo dice.
- **Si el número de una versión no se puede leer** (un `version.json` roto, un objeto dañado, el tope de tiempo), no es «sin
  número»: `update` no mueve nada, sale 2 y nombra la ref y el archivo, en los dos canales.
- **Una ref que no se puede leer no es una ref que no existe.** Si la rama del mecanismo, `HEAD` o una ref traída están
  dañadas o git no contesta a tiempo, `update`, `rollback` y `doctor` no mueven nada y nombran qué no pudieron leer. El
  aviso de arranque lo dice en una línea —qué no pudo leer de qué clon— y no juzga la rama ni aconseja nada.
- **Dónde se dice cada cosa**: «no se baja» lo dicen `update`, `update --check` (sale 0), `doctor --fetch` y `channel
  stable` en el momento; `startup` lo deja sólo en su registro, no en el aviso (lo repetiría en cada sesión por un estado
  que es normal). Que el remoto no es el público lo dicen `doctor` y `channel`, nunca `startup`. Y «una máquina del equipo
  sin el perfil» sale sólo en un clon interno de verdad: un árbol sin la lista de remotos del público.
- **Un clon de antes de que la copia trajera la lista** se reconoce como público solo, la primera vez que su árbol la trae
  y su origen fijado está en ella. Nunca al revés.
- **Cambiar de canal deja libre la próxima mirada** —por `channel`, por el archivo a mano o por la variable—, incluida la
  de un intento que no pudo mirar: si no, en `ask` el cambio no se vería hasta 6 horas después. El aviso del canal
  anterior no sobrevive al cambio, y un `update` que encuentra el arnés al día también saca el «disponible» viejo.
- **El re-registro** de un avance simple vale hasta la punta y hasta un commit publicado que no es la punta; queda en el
  registro (`startup.log`), no en la salida.

## La llave de las skills: dos clones, re-apuntar y volver

Los dos repos internos —el arnés y agent-skills— se unieron en uno, con las dos historias enteras: desde ese corte el clon
del arnés trae `skills/`, `agents/` y `packs/` en su raíz. Las máquinas no se mudan ese día. Quedan tres formas de
máquina, y todos los comandos del mecanismo (`version`, `doctor`, la salud, `rollback`, `uninstall`) andan en las tres:

| Forma | Qué hay en la máquina | Fuentes en el estado |
|---|---|---|
| Dos clones (la transición) | el clon del arnés, que ya trae las skills, y `~/.claude/agent-skills`, el clon viejo, del que la máquina las sigue leyendo | `harness` y `agent_skills`, cada una con su repo |
| Dos clones, el viejo re-apuntado | lo mismo, pero el clon viejo sigue al repo unificado y está en el mismo commit que el arnés | `harness` y `agent_skills`, las dos con el repo unificado |
| Un solo árbol (la máquina nueva) | un clon; `~/.claude/agent-skills`, `skills` y `agents` son enlaces a él | `harness` |

**En la transición no se nota nada.** El instalador no imprime ni mueve nada por ese estado (lo decide
`separateSkillsClone()` de `scripts/lib/canonical-path.js`, igual para el `.sh` y para el `.ps1`), `settings.json` queda
como estaba, y `doctor` lo dice una vez, como dato: «dos clones: en transición». Una carpeta real en
`~/.claude/agent-skills` que no es un clon de agent-skills sigue avisando, como siempre.

**La llave** es `update.skills_source` (`scripts/lib/tycon-config.js`; variable `TYCON_UPDATE_SKILLS_SOURCE` ›
`~/.claude/tycon.json` › perfil del equipo › por defecto). Vale `separate` (por defecto: cada clon sigue a su repo) o
`unified`. Otro valor es un error de la política: `update` no mueve nada y lo dice. La variable vale sólo para ese
comando —una ida hecha con ella se deshace en la sesión siguiente—: para dejar una máquina re-apuntada, la llave va en
`tycon.json` o en el perfil. Y la línea de la máquina le gana al perfil: una máquina con `separate` en su `tycon.json` no
re-apunta aunque el perfil diga `unified`.

**La ida** (`scripts/setup/harness/repoint.js`) corre sola con la llave en `unified`, la máquina en `managed` y la
política en `auto`, desde `startup` o `update`, antes de mirar si hay versión nueva. Como la historia está unida, el clon
viejo avanza **en línea recta** al repo unificado y nada se mueve en el disco:

- Primero sólo mira, y si algo no cierra **no toca nada** y nombra la causa con su comando: el clon del arnés ya trae las
  skills, los dos clones están en `main` y sin commits propios, y el repo unificado contesta (la única salida a la red).
- Los commits salen del **clon del arnés de la misma máquina**, por su carpeta: es el mismo repo y ya está bajado.
- Toma la copia de seguridad, anota la mudanza «en curso» en el estado y recién ahí mueve: la vista reducida, el avance
  (`merge --ff-only`) y el `origin`. Si un paso falla deshace lo hecho; si la sesión muere en el medio, el arranque
  siguiente la encuentra «en curso» y la deshace antes de decidir nada.
- Queda el clon viejo en el mismo commit que el arnés, mostrando sólo `agents/`, `skills/`, `packs/` y los archivos de la
  raíz (así nadie corre el instalador desde ahí), con lo sin versionar, lo ignorado y los stash donde estaban. De dónde
  venía —repo, commit y configuración de git— queda en el estado (`repoint.applied.from`) y en `.git/tycon-repoint.json`
  del propio clon: el estado se pierde al desinstalar y el clon no.
- Con la política en `ask` no se muda sola: deja el aviso y se aplica con `update --yes`. En modo desarrollador o con
  `TYCON_UPDATE=0`, tampoco.

**Cuando no puede pasar**, no se actualiza **ninguna** fuente, `doctor` queda en rojo («la llave pide el repo unificado y
este clon sigue en el viejo») y el aviso sale en cada sesión, con la causa y su comando. Esa máquina queda congelada
—arnés y skills— hasta que la persona la arregle. Las causas permanentes no se reintentan solas mientras no cambie lo
que se miró (`harness.js update` a mano reintenta siempre): el clon viejo en otra rama o con commits propios; un archivo
de la persona —sin versionar, ignorado o modificado sin commitear— en el camino de lo que llega (frena, no se aparta
solo); una historia sin unir. Las pasajeras se reintentan en cada arranque: sin red, o un archivo del clon tomado por
otro programa (lo corriente en Windows).

**La guarda: nadie queda sin skills.** Una versión cuyo árbol no trae `skills/tycon-pipeline` no se aplica a la fuente
de la que esa máquina saca las skills —el clon re-apuntado, o el único árbol—: se avisa y la máquina sigue con lo que
tiene. Vale en los tres actualizadores: `harness.js update`, el respaldo en shell del arranque y la sanadora del
pipeline (`guides-heal.js`). En la máquina de dos clones sin re-apuntar el arnés sí sigue a `main` aunque `main` vuelva
a un árbol de antes de la unión: ahí las skills salen del otro clon.

### Cómo se vuelve

Poner `update.skills_source` en `separate` (en el perfil, por pull request; o en `~/.claude/tycon.json` de una máquina).
En su próxima sesión cada máquina vuelve sola: el clon viejo a su repo y a su commit de antes, mostrando todo; ida y
vuelta dejan la máquina byte a byte como estaba. Si el repo viejo no contesta, no toca nada y lo dice: por eso
agent-skills no se deshabilita mientras quede una máquina re-apuntada. A mano:
`node ~/.claude/tycon-harness/scripts/setup/harness.js update`. Y `main` puede volver a un árbol sin skills sin
dejar a nadie sin ellas: las máquinas re-apuntadas y las de un solo árbol no aplican esa versión, y lo avisan.

`rollback` **no** deshace la mudanza (vuelve las dos fuentes a su commit anterior; el clon sigue re-apuntado), y
`uninstall` tampoco: se deshace con la llave. Si el estado se pierde (desinstalar y volver a instalar), el arranque
reconoce el clon re-apuntado por su constancia.

### De dónde saca las skills el instalador

`install-tycon-hooks.sh` y su gemelo `.ps1` no traen la ruta de las skills escrita: se la preguntan a
`scripts/lib/skills-dir.js`, de dos formas. Para **escribir** en la máquina (los hooks de `settings.json`, el paso de
terceros, el informe de piezas) usan lo instalado (`~/.claude/agent-skills`) mientras exista, y no leen
`TYCON_SKILLS_DIR`: una variable que apunta a un clon de trabajo no re-apunta los hooks de una máquina. Para **correr**
las seis suites rápidas de cada arranque, el `.sh` sigue la regla de quien lee —la variable › el propio clon si trae las
skills › lo instalado—, y si dan rojo la línea dice de qué raíz salieron. En la transición eso quiere decir: los hooks
siguen corriendo desde el clon viejo, y las suites rápidas prueban las skills que trae el clon del arnés.

### Los hooks que ya quedaron repetidos

El instalador reconoce un hook suyo por el archivo real que nombra, así que no registra el mismo dos veces aunque se lo
llame por la carpeta del clon o por el enlace. Los repetidos que una máquina ya tenía de antes **no se sacan solos**:
`doctor` dice una vez cuántos hay y cómo sacarlos a mano, como dato,
sin poner el diagnóstico en rojo y sin tocar `settings.json`.

### En Windows

Re-apuntar y deshacer viven en Node: es el mismo código en los tres sistemas. En una máquina Windows real, la ida y la
vuelta **no están medidas todavía**. Por eso la llave entra a Windows así: primero en
**una** máquina Windows real, con una persona mirando; si va y vuelve bien, entra al perfil del equipo y pasan todas.

## La integridad: qué garantiza y qué no (no hay firma)

git sobre https garantiza que lo que llegó es lo que el servidor sirvió, y `doctor` que nadie lo tocó después en la máquina.
**No garantiza quién lo empujó.** El origen fijado al instalar cierra el cambio de remoto sin aviso; nada cierra una cuenta
con permiso de escritura comprometida. La línea de arranque ejecuta código recién traído —el aplicador de la versión nueva—
sin suma de control ni commit fijado: es un riesgo **aceptado** (la decisión es de 2026-06-09, escrita
para un equipo chico con dos repos privados), y se sostiene por tres cosas: afuera el valor por defecto es `stable` + `ask`
(la persona decide, sobre lo que el equipo ya aprobó), antes de cada cambio hay copia y vuelta atrás, y la combinación sin
revisión (`latest` + `auto`) pide confirmación. La terminal que pide `update --yes` es un escalón contra el descuido de un
agente, no una barrera: un proceso puede fabricar una.

Se reabre la firma —se deja de aceptar el riesgo sin más— si pasa cualquiera de estas seis cosas:

1. Hay un segundo publicador.
2. Un contribuyente externo tiene permiso de merge.
3. Un servidor sirve la copia fuera de GitHub.
4. `main` interno queda sin política de rama, o con robots que empujan directo. **Hoy es así**: 209 commits nocturnos en 30
   días y el control de cada cambio con `pr: none`.
5. Alguien fuera del equipo usa `latest` o `auto`.
6. Cambia quién puede editar el pipeline de publicación: quien pueda cambiar su YAML en `main` puede usar la credencial.

Lo que el mecanismo no cubre y queda escrito: el respaldo en shell del arranque hace `git pull` en la rama actual, y en
`tycon/installed` no actualiza (sólo corre el aplicador); un clon superficial (`--depth 1`) no está contemplado.

## Cómo llega a una máquina que ya tiene el arnés

Nadie hace nada. La línea de arranque vieja hace el `git pull` y llama al aplicador; el aplicador, al terminar su escritura de
`settings.json` y ver que no hay estado, corre `harness.js install --from-existing`: escribe el estado sobre el clon, el enlace
y el agent-skills que ya están, copia el arranque fijo y **reemplaza la línea vieja por la nueva una sola vez** (con copia de
seguridad de `settings.json`) — sólo si el `node` de la sesión alcanza el piso; si no, la vieja queda y avisa. Las formas
conocidas de la línea viven en `scripts/tests/fixtures/startup-lines.json`; una forma que no reconoce no se toca (se avisa con
la línea entera y el texto de la nueva). Desde la sesión siguiente arranca `bootstrap.js`. Los tres reparadores de antes se
hacen a un lado cuando hay estado (`guides-heal.js` registra `delegated`; `harness-bootstrap-heal.sh` considera sana la línea
nueva); se retiran cuando la copia fija, la salud y la retención lleven un nocturno verde.

## Lo que la instalación cambia, declarado

`scripts/setup/install-effects.json` es **la** lista de lo que la instalación cambia en la máquina y en cómo trabaja el
asistente: una entrada por hook del instalador (con el mismo nombre que el reporte de piezas), por bloque de
`claude-md-blocks/`, por ajuste de `settings.json`, por pieza del aplicador y del propio mecanismo, y por cada cosa que
corre sola (`kind: task`). Cada entrada dice en una oración qué cambia para la persona (`does`), dónde frena (`blocks`:
en ningún lado, en cualquier repo, sólo en un repo bajo el arnés, o sólo en modo autónomo), cuándo existe (`when`), su
interruptor, si sale a la red, dónde guarda algo, si el instalador de Windows la hace hoy, y si la portada la nombra.

La leen tres: las dos portadas públicas (por su prueba: cada entrada marcada para la portada
tiene que estar nombrada en los dos idiomas), el cierre de `harness.js install` (cuántos hooks pueden frenar) y
el plan que se muestra antes de escribir. `scripts/tests/install-effects.test.js` la cruza con el
instalador en los dos sentidos: un hook, un bloque, un ajuste o un lanzamiento de fondo sin entrada da rojo, y una
entrada que nombra algo que ya no existe, también. Su forma la valida `effectProblems` (`scripts/setup/harness/managed.js`).
**Una lista que falta o está rota no se lee como «no cambia nada»**: quien la usa lo dice.

**Al agregar un hook, un bloque o un lanzamiento de fondo al instalador**, sumá su entrada a la lista en el mismo commit:
la prueba lo exige. Si lo que agregás cambia cómo contesta el asistente, frena en cualquier repo, corre solo o guarda algo
en disco, marcá `front_page: true` y nombralo en las dos portadas.

### El cierre de `install`

`harness.js install` termina diciendo, en este orden: la versión, el canal y la política; **qué quedó**, contado por tipo
desde el reporte del aplicador (hooks —y cuántos pueden frenar, según la lista—, bloques, ajustes, hooks de git, comandos,
enlaces, skills de terceros en su lugar y pendientes —con el paso de terceros apagado lo dice, y no cuenta ninguna—);
**cada aviso del aplicador tal cual** (el renglón que empieza con `⚠`, `🔴` o `🛑` y los renglones sangrados que lo
siguen; en Windows, también los que el `.ps1` escribe con `! ` y `!! `: antes sólo llegaban al registro las últimas tres
líneas de su salida); dónde quedó la copia de respaldo y cómo volver (o que no se pudo tomar: no promete una que no
existe); la ruta del registro; y tres líneas de «qué sigue». Una segunda corrida dice «sin cambios» y
repite dónde está la copia de antes de instalar. Un `update` que aplica una versión suma dónde quedó la copia de antes.
`startup` no imprime nada de esto: sigue en una línea como mucho.

Si el aplicador sale distinto de 0, o la comprobación de salud no pasa, `install` sale 1 y dice qué falló, que la
instalación **quedó a medias** (el estado está escrito y `doctor` lo detalla), dónde están el registro y la copia, y las
dos salidas: `install` otra vez, o `uninstall`. `install` otra vez la retoma de verdad: el atajo «sin cambios» sólo vale
para una instalación que ya pasó su comprobación de salud.

## El plan antes de escribir

`install` ya no escribe nada sin conformidad. El orden: los requisitos (como antes) → **el plan** → la conformidad → el
candado → la copia de respaldo → las escrituras.

- **El plan** junta tres cosas: lo que el aplicador haría (`install-tycon-hooks.sh --check --plan-json <archivo>`: cada
  pieza con `add`, `update`, `remove` o `keep`, con los mismos `kind` e `id` que `--report-json`; el python de
  `settings.json`, `sync-claude-md-blocks.sh` y `canonical-path.js` anotan por `TYCON_PLAN_PIECES`), las piezas del propio
  programa (el enlace, el estado, la copia fija, la línea de arranque, el import) y la lista de efectos. `plan.js` lo dice
  en ocho secciones: escribe · cambia en cómo trabaja tu asistente · corre solo · red · guarda en disco · no toca · copia
  de respaldo · quita. Se arma sin candado, sin crear carpetas y sin escribir en la HOME (sólo un temporal bajo
  `os.tmpdir()`, que se borra).
- **La conformidad**: `--dry-run` sólo muestra el plan y sale 0 (gana sobre `--yes`); `--yes` la da por escrito; con
  terminal, una pregunta «¿Instalo? [s/N]» (`prompt.js`: sí es `s`, `si`, `sí`, `y` o `yes`; cualquier otra cosa es no);
  sin terminal y sin `--yes`, el plan y una línea, y sale 2. Nada que escribir sobre una instalación sana: «sin cambios»,
  sin preguntar ni tomar copia. `--from-existing` no pregunta: lo llama el aplicador sobre una instalación que ya existe.
- **Nunca se instala sin un plan**: una lista de efectos rota o ausente sale 2 nombrando el archivo; un `--check` que sale
  distinto de 0, un plan ilegible o uno al que algún paso no pudo anotarle una pieza («no pude anotar … en el plan»), 2
  («no pude armar el plan»). Un aplicador viejo, que no conoce `--plan-json`, no es «nada que escribir»: el plan lo dice
  y la conformidad se pide igual.
- **«Sin cambios» lo decide el plan**, no las piezas del programa: con todo en `keep` (también lo que `install` mismo
  escribiría: la copia fija y sus módulos viejos, la línea de arranque y sus repetidas, el canal) no se pregunta ni se
  toca ninguna pieza; con algo que reponer, se repone. Un enlace a otro clon o una línea de arranque que no reconoce
  salen como «ojo:» arriba del plan y piden conformidad. Armar el plan no escribe nada, tampoco el registro de nombres
  viejos de la configuración (`tycon-config.sinAnotar`).
- **El candado y la copia**, después de la conformidad: si el estado cambió mientras la persona confirmaba (otra sesión
  instaló o actualizó), sale 3 sin escribir; la copia `reason: install` se toma ahí, antes de la primera escritura.
- **`apply --dry-run`** muestra lo que el aplicador cambiaría ahora, sin escribir. `apply` solo no pregunta.
- **`update`** con la política `ask`, sin `--yes` y con terminal: dice qué fuentes se mueven y **qué cambia en el
  comportamiento** (la lista de efectos instalada contra la de la versión nueva, por `git show`), y pregunta «¿Aplico
  ahora? [s/N]». Con sí aplica sin levantar la retención ni reintentar un intento fallido (eso es de `--yes`); con no,
  sale 3. Sin terminal, como antes.
- **Windows**: el `.ps1` da su plan con `-Check -PlanJson` (hooks, enlaces, bloques y skills de terceros; las piezas compartidas las anota harness.js; el espejo de Codex todavía no). Un `.ps1` viejo, que no conoce la opción,
  no es «nada que escribir»: el plan dice «este aplicador no sabe mostrar su plan» y la conformidad se pide igual.

Quien instala sin terminal (un pipeline, una prueba, el asistente en el alta del equipo) pasa `--yes` escrito: el
ayudante del laboratorio no lo agrega solo. En el alta, el asistente corre `--dry-run`, le muestra el plan al dev y
sólo con su sí corre `--yes`. Sin terminal hace falta además el perfil, que `--yes` no elige: en un
clon del equipo lo fija el perfil del equipo (`full`); afuera, `--profile minimal` o `--profile full`. El laboratorio de
las suites (`harness-lab.sh`) trae su propio perfil del equipo con `full` y nada más.

## Los perfiles

Dos perfiles: `minimal` y `full`. Qué trae cada uno lo dice `scripts/setup/install-effects.json` (`profiles` en cada
entrada); la regla: sólo en `full` queda lo que puede frenar, lo que cambia cómo contesta el asistente, lo que toca git
fuera del clon y lo que corre solo de fondo sin ser de una integración. Lo de una integración prendida va en los dos.

- **La clave**: `install.profile` en la configuración del arnés (`TYCON_INSTALL_PROFILE` › `~/.claude/tycon.json` ›
  perfil del equipo). **Sin valor por defecto**: sin elegir se comporta como `full`, que es lo de siempre;
  `install` lo pregunta en una primera instalación (§«Las preguntas»). El perfil del equipo fija `full`. Un valor fuera de la lista es configuración ROTA, nunca `full`.
  `tycon-config.js` exporta `setKey`, el escritor de `~/.claude/tycon.json`: valida, escribe atómico conservando el resto
  y avisa si una variable le gana o si el freno de producción instalado no conoce la sección.
- **El aplicador** (`.sh` y `.ps1`) lee el perfil una vez: en `minimal` registra sólo los hooks de `minimal` (siete: seis que anotan y el freno
  de comandos destructivos, más los de cada integración prendida) y saca los demás con el motivo «fuera del perfil minimal»; el freno de comandos
  destructivos (`safety-guard-pre.sh`) está en los dos perfiles y se apaga sólo con su variable en `0`;
  los dos que nacen prendidos y son de `full` (`test-scope-guard-pre.sh`,
  `telegram-zombie-sweep.sh`) entran sólo con su variable en `1`; no
  escribe los dos ajustes (tampoco `shared.js`), no instala los hooks de git y no lanza las tareas de fondo de `full`. Con
  la configuración rota, lo del perfil queda como está, y se dice; la excepción son los dos frenos de comandos, que se
  registran igual (una máquina nueva no queda sin frenos por un archivo mal escrito). Su plan y su
  reporte hablan según el perfil.
- **Los bloques**: `<!-- requires-profile: full -->` en las primeras líneas (solo o con `requires-integration`). Lo llevan
  `response-style`, `tool-names` y `background-execution`. Con `full` o sin valor, `CLAUDE.md` queda byte a byte igual.
- **`install --profile minimal|full`**: el plan muestra lo de ese perfil, con «perfil: minimal (--profile)» arriba; la
  clave se escribe después de la conformidad y antes del aplicador; el estado guarda `profile: { value, origin }`. Si la
  variable dice otro valor, sale 2. **El cambio de perfil** (`full` → `minimal`): «quita:» en el plan; copia nueva
  `reason: profile`; el aplicador en el perfil nuevo; y se quita con `removePieces` lo registrado que su reporte ya no
  trae (los ajustes que conservan el valor del arnés, los hooks de git —vuelve el propio desde su `.local`—, el
  disparador del examen). Lo ajeno no se toca. Si el perfil cambia por el archivo, la misma rutina corre en el próximo
  `startup` o `apply`, sin preguntar.
- **`doctor`** dice «perfil: <valor> (<origen>)» y no da por faltante lo que el perfil no trae. La salud ya tolera eventos
  sin hooks.
- **Windows**: el `.ps1` y su sync filtran **sus** listas; lo que en Windows no registra en `full` tampoco
  aparece en `minimal`.

## Las preguntas

En una **primera instalación**, `install` pregunta lo que no puede decidir solo, **antes** del plan, y escribe las
respuestas recién **después** de la conformidad (con `setKey`, antes del aplicador). Si la persona dice que no, no queda
ni `~/.claude/tycon.json`. El texto y la lectura de cada respuesta viven en `scripts/setup/harness/questions.js`; cuándo
se pregunta, en `installQuestions` de `harness.js`. El mismo código en cualquier sistema.

- **El perfil**, cuando nadie lo dijo (ni `--profile`, ni `TYCON_INSTALL_PROFILE`, ni el archivo, ni el perfil del
  equipo): dos opciones con dos renglones de lo que trae cada una, contados desde la lista de efectos, y **sin valor por
  defecto** (Enter vuelve a preguntar; acepta `1`, `2`, `minimal` o `full`). A la tercera respuesta vacía o inválida, o con
  fin de entrada, sale 2 «sin perfil elegido no escribo nada». **Sin terminal** sale 2 pidiendo `--profile minimal` o
  `--profile full`, también con `--yes`: `--yes` acepta el plan, no elige. `--dry-run` sigue la misma regla.
- **Las integraciones**: sólo las que la lista de efectos ofrece (`integrations[].offered`: hoy `clockify`, `engram`,
  `codegraph` y `codex`), cada una con qué hace y qué pide; ninguna marcada, Enter es «ninguna», nombres separados por
  coma; un nombre que no se ofrece vuelve a preguntar. `ado` y `telegram` no se preguntan porque piden un dato: el cierre
  dice cómo se prenden (`tycon-config.js set ado.org <url>`). `mailbox` y `nightly` no se ofrecen: son del equipo.
- **El paquete del stack**: «¿Usás el paquete del stack en todos tus repos? [s/N]» → `packs.default` en `all` (con no,
  queda el de fábrica, `none`, sin escribir nada).
- **Cuándo no pregunta**: sobre una instalación que ya existe (sin perfil elegido sigue la regla de «Los perfiles»: se
  comporta como `full`, y `doctor` lo avisa); y las integraciones y el paquete tampoco cuando el perfil lo fija la
  configuración — una máquina configurada (el perfil del equipo, el archivo, una variable) no se pregunta nada; y con
  `--yes` no pregunta nada aunque haya terminal (sin perfil sale 2, como sin terminal). Nunca en `startup`, `apply` ni
  `--from-existing`. Cuando no preguntó las integraciones, el cierre deja UNA línea con cómo cambiar el perfil y las
  integraciones (`install --profile … --integrations … --packs …`, o `tycon-config.js set`).
  `--profile` en una primera instalación con terminal sí pregunta las integraciones: no viene de la configuración.
- **Las opciones que las contestan**: `--profile minimal|full`, `--integrations <lista|none>` y `--packs all|none`. Con
  las cuatro (y `--yes`) no hay ninguna pregunta ni hace falta terminal; sin terminal, lo que no vino por opción no se
  escribe. Un valor inválido sale 2 con los válidos; una opción que contradice a su variable de entorno, 2 nombrándola.
- **La cabecera del plan** (y el cierre) dicen el perfil, las integraciones y el paquete, cada uno con su origen
  (`respuesta`, la opción, `~/.claude/tycon.json`, `perfil`, la variable, `de fábrica`).
- **`node scripts/lib/tycon-config.js set <clave> <valor>`**: lo que antes se editaba a mano, con `setKey` (una llave
  acepta `true`, `false`, `1` o `0`, y `integrations.codex` además `detect`); dice «antes → después» y que se aplica en el
  próximo arranque o con `harness.js apply`. `channel` también escribe por `setKey`: un solo escritor del archivo.
- **`doctor`** suma las integraciones con su origen, el paquete por defecto, cuántos controles que frenan están
  registrados (nombrando los que frenan en cualquier repo) y, sin perfil elegido, el aviso de que se comporta como `full`.
  `--json` gana `profile`, `integrations`, `packs` y `brakes`.
- **Windows**: el mismo código de Node; contestarlas en una terminal de Windows de verdad queda pendiente.

## Los guiones de entrada: la portada sin git

La portada pública entra por UN camino: el bloque `install:core` son tres líneas por sistema —bajar el guion de
`raw.githubusercontent.com`, sin credencial (el repo es público), leerlo, correrlo—: `get-harness.sh` para bash y
`get-harness.ps1` para PowerShell 7. **Nunca** una tubería hacia un shell: el freno de comandos la bloquea (`SUP-C1`,
`guides/safety-guard.md`), y con tubería la entrada estándar es el guion y nadie podría contestar las preguntas de la
instalación. El guion **no usa git ni lo pide**: usar el arnés no es mantenerlo.
El clon quedó como modo desarrollador (`install:clone` en la portada, para quien cambia el arnés).

Qué hace el guion, en orden:

1. Revisa los requisitos: `node` con el mismo piso que `NODE_FLOOR` de `harness.js`, `bash`, `python3` y `tar` (el de
   PowerShell: PowerShell 7, `node` y `tar`; fuera de Windows también `bash` y `python3`). Si falta alguno, sale 1 con
   una línea por cada uno y un comando **sugerido** según el sistema (Homebrew en Mac, `apt` en Debian y Ubuntu,
   `winget` en Windows, la página oficial en el resto), que se imprime y nunca se corre. No baja nada. En una Mac sin
   las herramientas de línea de comandos, `/usr/bin/python3` existe pero sólo pide instalarlas: si `xcode-select -p`
   falla se nombra como faltante, con `xcode-select --install`.
2. La credencial, **antes de bajar**: el repo es público y no hace falta. Si hay un permiso de lectura —el de
   `TYCON_GITHUB_TOKEN`, o el guardado en `~/.tycon/config.json`— lo usa; si no hay y el repo no se puede leer sin él
   (401 o 404), en una terminal lo pide sin eco; sin terminal sale 1 con la única acción (crear el permiso —el enlace—
   y pasarlo). Un permiso que no vale sale 1 diciéndolo.
3. Baja el comprimido de `main`. **Sin permiso** no usa la API: lee el commit de `main` de `info/refs` y
   baja de codeload (`tar.gz/<commit>`); si `github.com` no contesta, cae a la API. **Con permiso**, por la API
   (`/repos/<org>/<nombre>/tarball/<commit>`): la credencial viaja sólo al host de la API y la redirección a codeload se
   sigue **sin** ella (el guion hace los dos GET a mano). Un 403 del tope de la API dice hasta qué hora, en hora local.
   Lo desempaqueta con `tar` en una carpeta temporal, que se borra al terminar. `TYCON_RELEASE_API`, `TYCON_RELEASE_GIT`
   y `TYCON_RELEASE_ARCHIVE` (sólo pruebas) apuntan al servidor de juguete, como en release.js.
4. Desde ese árbol temporal: guarda el permiso si lo pidió (`harness.js config set github.token`, por stdin, 0600) y
   corre `harness.js install --version latest --repo <org/nombre> <opciones>` (las que vienen después de `--`) en la
   misma terminal, sin tocar la entrada estándar: la bajada VERIFICADA (tar-reader + el árbol de git contra el commit) y
   la instalación en `~/.tycon` son las de «La versión bajada, sin git». Se baja dos veces (la del guion, para tener el instalador, y la
   verificada): aceptado por simplicidad, y dicho.
   El de PowerShell también acepta las opciones de `install` sin el `--`: llamado desde una sesión de PowerShell
   (`./get-harness.ps1 --yes`), PowerShell se come el `--` antes de que llegue al guion.

No instala paquetes, no usa `sudo` y no escribe fuera de la carpeta temporal y de `~/.tycon`. El valor del permiso no viaja
en la línea de comandos ni queda en nada escrito salvo `config.json`. El de bash tiene 120 líneas como mucho, para que se
lea entero, y corre con el bash 3.2 de una Mac. El de PowerShell lleva BOM UTF-8 y no usa nada que Windows PowerShell 5.1
no lea antes del chequeo de versión: corrido con `powershell`, dice que pide PowerShell 7 en vez de cortar con un error
de sintaxis.

En el repo del equipo viven aparte, con la dirección por marcadores (`{{public-org}}` y
`{{public-repo}}`) y llegan a `scripts/setup/` de la copia por dos sintéticos de `allowlist.json`; en los repos internos
no existen ahí, y ningún archivo interno escribe el nombre del repo público. El guion se baja sin credencial (el repo es
público) de `raw.githubusercontent.com/<org>/<repo>/main/scripts/setup/`, no de la API: es la primera línea de la
portada, nunca lleva la cabecera del permiso y no gasta del tope de 60 consultas por hora de la API sin credencial, que
antes dejaba a una máquina nueva sin poder empezar. La dirección por rama queda hasta 5 minutos en caché: justo después
de un merge puede bajar el guion anterior, que igual instala el `main` del momento (lo lee de `info/refs`).
Pruebas: `scripts/tests/get-harness.test.sh` (T54-T57, contra el «GitHub» de juguete y un `git` testigo).
**Qué falta**: correr las tres líneas tal cual en Windows de punta a punta (el 182 corre hoy el bloque del clon) y en
una Mac y un Linux después de la primera publicación.

## Lo único que el equipo no prueba como afuera: los transformados

El equipo va a instalar lo mismo que instala una persona de afuera —la copia pública— y encima una **capa privada**:
los archivos que la copia deja afuera (planes, la memoria del equipo, las skills de cada producto…), copiados del repo
interno. Así, casi todo lo que el equipo usa es exactamente lo que se publica: si algo se rompe afuera, se rompe primero
adentro.

Hay una excepción, y es una sola: **los transformados**. Son los archivos que el exportador cambia al publicarlos (le
saca una parte privada, le cambia un nombre). En esos la capa pone la versión interna encima de la pública, así que el
equipo usa la interna y **nadie del equipo prueba la versión que sale afuera**. Son pocos y vienen nombrados: el
`version.json` de cada versión pública trae la lista (`transformed`, cada ruta con el nombre de su ajuste), y `doctor` los
cuenta en su línea de la capa («M pisados (transformados)»). Si un cambio rompe sólo la versión pública de uno de esos
archivos, la máquina del equipo no se entera: eso lo tiene que atrapar la prueba de la copia pública, no el uso diario.

Lo que `doctor` comprueba de la capa, sin escribir nada:

- que la copia más la capa den el repo interno, archivo por archivo (lo que falta, lo editado a mano y lo que no viene
  de ninguna fuente, cada cosa con su ruta; lo ignorado por git y lo que escribe la máquina no se cuentan);
- que la capa sea de **la misma versión** que la copia instalada: un archivo público con otro contenido que no está en
  la lista de transformados es «capa de otra versión», en rojo; un `version.json` sin la lista también es rojo, porque
  sin ella no se puede distinguir un ajuste del exportador de un cambio de otra versión;
- y, si la capa quedó en el commit mínimo, cuántas horas está detrás del repo interno (aviso pasadas las 24).

`harness.js layer --check` hace el mismo chequeo y sale 0 si la capa está entera, 1 si falta o sobra algo y 3 si la
máquina no tiene capa. Con `--public <copia> --harness-clone <clon interno>` calcula la capa contra esa copia y ese clon,
sin mirar ni tocar el estado. Nadie instala todavía desde la copia con esta capa: esto existe para poder probarlo.

## Modo desarrollador

`link --local <clon>` apunta el enlace a un clon propio, guarda `tree_before`, escribe `mode: developer`, y desde ahí `update`
y `startup` **no tocan el git de ese clon** (ni fetch, ni merge, ni stash): «modo desarrollador: <ruta>; actualizar es tuyo».
El aplicador sigue corriendo desde ese clon en cada arranque (así quien mantiene el arnés prueba sus hooks al toque). Rechaza
una ruta bajo `/tmp`, `/private/tmp`, `$TMPDIR` o `%TEMP%` salvo `--allow-temporary` (un clon descartable se borra al
reiniciar y deja el enlace y los hooks colgados). `link --managed` vuelve sobre `tree_before`. Si el árbol de `developer`
desapareció, `bootstrap.js` vuelve solo a `managed` sobre `tree_before` y deja el aviso.

## La versión bajada, sin git

Al lado del clon (`kind: tree`, todo lo de arriba) existe otra forma de instalación: **una versión publicada bajada
como archivos** (`kind: release`). La usan las máquinas nuevas que instalan con `harness.js install --version
<número|latest>` (y las que se mudan); una máquina con clon no cambia nada.

- **Dónde**: `~/.tycon/harness` (la activa, siempre en la misma ruta real), `~/.tycon/previous` (la anterior, para volver
  sin red), `~/.tycon/incoming/<v>` (donde se arma una nueva), `~/.tycon/trash` (lo que se borra en el arranque
  siguiente), `~/.tycon/third-party` (la caché de las skills de terceros) y `~/.tycon/config.json` (el permiso de GitHub
  y `paths.maintained`). El estado y la copia fija de arranque viven en `stateDir()`. `TYCON_HOME` cambia la
  carpeta.
- **De dónde**: de GitHub, sin git. La ref del canal (`stable` → `main`; `latest` → `mirror/sync` si trae un número
  mayor), su `version.json` y el comprimido **de ese commit**. **Sin permiso guardado**, por las rutas
  públicas, que no cuentan contra el tope de la API: las dos ramas de UN pedido a `github.com/<org>/<repo>.git/info/refs`
  (lo que lee `git ls-remote`, leído por el cliente propio: no hace falta git), el número del raw **por commit**
  (`raw.githubusercontent.com/<org>/<repo>/<sha>/version.json`; nunca por rama, que queda 5 min en caché), y sólo si la
  punta cambió desde la última vista; el comprimido, de `codeload.github.com/<org>/<repo>/tar.gz/<sha>`. A la API le
  queda **una consulta por bajada**: `git/commits/<sha>`, el árbol con el que se verifica: una consulta a cambio de que el árbol lo diga GitHub, sin un lector propio de objetos de git. Si
  `github.com` no contesta o `info/refs` no se puede leer, se mira por la API como antes y queda en el registro; un 401
  o 404 de `info/refs` es «el repo no está o no se ve», sin caer a la API. **Con permiso**, todo por la API, igual que
  antes (lo prueba la línea de base de `release-api-count.test.sh`). El comprimido se lee con un lector propio (`scripts/lib/tar-reader.js`) que rechaza enlaces, dispositivos y rutas que salen ANTES de
  escribir, y verificado: el árbol de git calculado tiene que ser el del commit, si no no instala nada. El modo de cada
  archivo sale de la cabecera del comprimido, nunca del disco (Windows no guarda el bit de ejecutable).
- **La credencial**: no hace falta, el repo es público. Si la persona pegó un permiso de sólo lectura (`harness.js config
  set github.token`, por stdin; queda 0600 y nunca se imprime), se manda en cada pedido a la API. Sirve para un repo
  privado (la capa del equipo); para el público es opcional. No se lee la de git ni la de `gh`. Un 404 nombra sus tres
  causas; un 401 dice que el permiso venció.
- **El tope de la API**: sin permiso, GitHub limita la API a 60 consultas por hora **por conexión** (toda
  una oficina comparte una), y un 304 sin permiso también gasta. Un 403 con `X-RateLimit-Remaining: 0` deja en el estado
  `api_limited_until` (la hora de renovación que dice GitHub): hasta esa hora el arranque no le pide nada a la API
  —mirar sigue andando, porque no la usa—, avisa **una vez** («hay versión nueva (X); GitHub limita las consultas sin
  permiso de esta conexión hasta las HH:MM; se baja sola en el primer arranque después de esa hora. No hace falta hacer
  nada»), no lo cuenta como «no se pudo actualizar», y `doctor` lo muestra. Pasada la hora, el primer arranque baja sin
  esperar la ventana de 10 minutos. `update` a mano intenta una vez y, si sigue el tope, sale 2 con el mismo texto.
  `install --version <n>` (un comando manual y raro) sigue por la API y dice el tope y la hora si llega.
- **El cambio con diario**: `~/.tycon/swap.json` se escribe antes de mover; `harness/` → `previous/`, `incoming/<v>/` →
  `harness/`. Un corte lo repara el arranque siguiente (también `bootstrap.js` y los respaldos en shell, sin git ni Node).
  Una `previous/` que todavía está se aparta a `trash/`; si no se puede (Windows, un archivo tomado) la actualización
  espera. Salud roja → vuelve a `previous/` y la versión queda `failed`.
- **Comandos**: `update --check` (0 al día · 3 nueva · 2 sin poder mirar, con el motivo: sin red, proxy sin respuesta, sin
  permiso, 404, el tope con su hora), `rollback` (el cambio al revés, sin bajar nada; sin `previous/` manda a `install --version`),
  `doctor` (cada archivo contra su manifiesto `.tycon-release.json`; sin git; red sólo con `--fetch`), `uninstall` (quita
  además las carpetas de versiones y los enlaces; deja el permiso y la caché de terceros, y lo dice).
- **Los avisos** que miran el repo (`dependencias`, `tablero`, `producción`, `guides-heal`, `branch-guard`) no corren git
  sobre `~/.tycon`: leen el clon que la máquina declara mantener (`config set paths.maintained`) o callan.
- **El repo interno** no puede traer lo que rompería la verificación: `scripts/ci/check-publishable-tree.js` (pre-commit y
  validación de cada rama) frena `export-ignore`/`export-subst`, enlaces y submódulos en rutas publicadas.

Pruebas: `scripts/tests/harness-release.test.sh` (máquina de juguete con el «GitHub» de juguete,
`scripts/tests/fixtures/toy-release-server.js`, que atiende también las rutas públicas y cobra el 304 sin credencial),
`release-api-count.test.sh` (cuántas consultas a la API gasta cada operación, y con permiso los mismos pedidos que la
línea de base), `tar-reader.test.js`, `http-get.test.js`, `check-publishable-tree.test.js`; en Windows, el escenario
`no-clone` del pipeline 182, que además mide contra el GitHub real con el registro de pedidos (`TYCON_HTTP_TRACE`).

## Cada herramienta, sus enchufes — y Codex solo

El arnés enchufa **las herramientas que la máquina tiene**: Claude Code, Codex, o las dos. Hasta acá escribía siempre en
la carpeta de Claude Code, y el lado Codex se armaba leyendo archivos de Claude: un dev que sólo usa Codex no podía
instalarlo.

- **Cuáles**: `install` las detecta (`scripts/setup/harness/tools.js`): una herramienta está si su ejecutable está en el
  `PATH` o existe su configuración propia —la que crea ELLA, nunca el arnés: `~/.claude.json`, y `auth.json` en la
  carpeta de Codex—. Lo que el arnés despliega no cuenta. El plan las nombra y se pide la conformidad de siempre;
  `--tool claude|codex` (repetible) las fija sin mirar; sin ninguna, sale 1 sin escribir ni salir a la red.
  Las llaves `integrations.claude` e `integrations.codex` (`true` · `false` · `detect`) lo deciden por máquina o por
  equipo: prendida enchufa aunque no se detecte, apagada a propósito no enchufa aunque esté, y `detect` —o nadie
  diciendo nada— sigue a la herramienta **instalada**, no a «ya desplegada».
- **Queda escrito**: `tools` en el estado. El arranque no vuelve a detectar (su `PATH` no es el de la persona); una
  herramienta instalada y sin enchufar se **avisa** en el arranque y en `doctor`, y se enchufa con `install --tool`. Un
  estado sin `tools` —una máquina de antes— es lo de siempre: Claude Code, y Codex si ya estaba desplegado.
- **El enchufe de cada una**:

  | Herramienta | Qué se escribe | Quién lo hace |
  |---|---|---|
  | Claude Code | hooks de `settings.json`, la línea de arranque, el `@import`, bloques en `CLAUDE.md`, los enlaces de su carpeta | el aplicador (`install-tycon-hooks.sh` / `.ps1`) y `harness.js` |
  | Codex | `hooks.json` (con su hook de arranque), los bloques en `AGENTS.md`, los enlaces de `~/.codex/skills`, perfiles y subagentes, los servidores MCP y `writable_roots` | `tools.js` en Node — el mismo camino en Mac, Linux y Windows |

  Bajo el mecanismo, al aplicador se le dice qué hacer con Codex (`TYCON_HARNESS_CODEX=done|off`) y saltea su bloque;
  corrido suelto, sigue como siempre.
- **Las reglas de Codex**: `AGENTS.md` lleva los bloques de `claude-md-blocks/` **entre sus marcas**
  (`scripts/setup/agents-md-blocks.js`), con la variante `names/<bloque>.codex.md` donde existe. Ya no es copia del
  `CLAUDE.md`: lo que la persona escribe fuera de las marcas no se toca (lo que venía copiado queda, y deja de
  actualizarse solo), no viaja ningún `@import`, y Windows lo recibe igual.
- **El arranque de Codex actualiza**: su hook `scripts/hooks/harness-startup.js` corre la copia fija de arranque
  (`harness.js startup`, con sus topes), como la línea de arranque de Claude Code. Ocupa en `hooks.json` el lugar que
  tenía `harness-maintain.sh`: en una máquina que ya tenía Codex, es **una** entrada a re-aprobar con `/hooks`.
- **Una máquina sin Claude Code vive entera en `~/.tycon`**: su estado es `~/.tycon/state`, las copias de seguridad
  `~/.tycon/backups` y su configuración `~/.tycon/config.json` (la misma del permiso de GitHub, que `tycon-config.js`
  conoce y nunca muestra). La regla es una sola y la lee el disco (`tycon-home.js`): **si existe `~/.tycon/state`, todo
  es de ahí; si no, lo de siempre**. Ahí no corre el aplicador ni se crea nada en `~/.claude`; `uninstall` quita esa
  carpeta y la máquina queda libre. Es la regla con que la mudanza pasa a las demás.
- **El MCP de Codex**: qué servidores espera sale de las integraciones prendidas y de `build/equivalences.json`;
  `~/.claude.json` sólo aporta la definición de los que son de cada máquina, si existe. Un servidor esperado que no se
  puede registrar **se dice** con su motivo. `writable_roots` lleva el estado vigente y `~/.tycon/state`, por su ruta real: una raíz del arnés que pasa por un enlace (la carpeta vieja del estado tras la mudanza) se saca, porque con una sola Codex rechaza todos los comandos de shell; una ajena no se toca y se avisa.
- **Sumar y sacar**: `install --tool <la nueva>` en una máquina instalada enchufa sólo esa (sin red, sin otra versión,
  sin tocar la otra); `uninstall --tool <una>` quita sólo sus piezas registradas. Sacar la única es `uninstall` entero.
- **La paridad** (`harness-audit.js --parity`) mide por herramienta enchufada: una máquina sólo con Codex no da rojo
  por un `CLAUDE.md`, un `~/.claude.json` o una llave en el rc que no tiene.

Lo que espera a la mudanza: los registros que los hooks en shell escriben al usarse siguen cayendo donde
siempre; a una máquina nacida sin Claude Code no se le suma Claude Code (`install --tool claude` sale 2 y lo dice); en
una instalación desde un clon Claude Code no se saca; y una máquina sólo con Codex no tiene el hook global de git ni las
tareas diarias de fondo, que hoy pone el aplicador.

Pruebas: `scripts/tests/harness-tools.test.sh` (T21, T22, T23, T26), `agents-md-blocks.test.js`, `tycon-config.test.js`
(T24), `harness-parity.test.sh` (T25); en Windows, el escenario `codex-only` del pipeline 182.

## La capa del equipo sobre la versión bajada

La versión publicada es la copia pública: no trae lo que es **del equipo** —el perfil ni la
llave del buzón de corridas—, porque el exportador los deja afuera a propósito.
Una máquina que instala o se muda a la versión bajada quedaba de fábrica: integraciones apagadas, paquete de revisores
`none`, política `stable` + `ask`. La capa del equipo lo resuelve sin git y sin fundir nada en la configuración de la
máquina: esos archivos viven en **un segundo repo privado de GitHub, chico**, y el programa los baja con el mismo
permiso que el arnés y los apila sobre la versión pública.

**Cómo se declara.** Por URL, con una de dos fuentes: `--team https://dev.azure.com/<org>/<proyecto>/_git/<repo>` (Azure
DevOps) o `--team https://github.com/<org>/<repo>` (GitHub; también la forma corta `org/nombre`), en `install --version` y
en `migrate --to-home`. Sin la opción, el estado (`team`, si la máquina ya la registró) y, sólo en la mudanza, la clave
`team` del `public-repos.json` del clon que la máquina deja (ese archivo no viaja en la copia). Cada empresa declara la
suya; lo que la capa es y cómo se apila es el mismo código para las dos. El nombre del repo del equipo **no está escrito
en el programa ni en esta guía**: la ayuda y los mensajes dicen `<org>/<repo>` o el valor leído; el nombre real lo tiene el
equipo en su onboarding.

**La fuente Azure DevOps, sin zip.** La ref `main` → el commit y su `treeId` → el árbol recursivo (cada ruta con modo,
tipo y `objectId`): el hash del árbol se **recalcula** de esa lista y tiene que dar el `treeId` del commit (una lista
cortada o alterada no se usa); la lista cerrada se juzga ahí; cada archivo de la capa se baja por `items` en ese commit y
su blob tiene que ser el `objectId` de la lista. La credencial sale, en orden, de un PAT guardado en `~/.tycon/config.json`
(`harness.js config set azure.token`, sin eco) o del gestor de credenciales de git **sin interacción**; si no hay ninguna,
**se dice** (el repo y las dos formas de ponerla): `install` y `migrate` salen 1 sin escribir, `update` sigue con la capa
instalada y el arranque lo avisa. Azure contesta la página de login (302) tanto a un anónimo como a un PAT inválido: las
dos son «sin credencial o no vale», nunca «sin red»; 403 es «sin permiso de lectura (Code: Read)»; 404 nombra el repo o el
proyecto. El valor del PAT no aparece en ninguna salida ni registro.

**Qué trae la capa (lista cerrada).** Tres rutas exactas —el perfil, `team-profile.json` _(del repo del equipo; no está en esta copia)_ (o `perfil-equipo.json`, su nombre de antes, que sigue valiendo: con los dos, gana el nuevo y el de antes no se apila), `scripts/metrics/corridas-buzon.json` _(del repo del equipo; no está en esta copia)_ y
el mapa de renombres `scripts/lib/renames.json` _(del repo del equipo; no está en esta copia)_ (hasta su retiro, 2026-11-17)— y
revisores y skills del equipo por patrón: `packs/<paquete>/pack.json`, `agents/<nombre>.md` y los `.md`
de una skill bajo `skills/` (su carpeta, con `SKILL.md`, a una, dos o tres carpetas de `skills/`: `skills/<s>`,
`skills/<grupo>/<s>`, `skills/projects/<cliente>/<s>`). Y el texto del alta del equipo, `onboarding/<nombre>.md`: sólo
los `.md` de la raíz de esa carpeta (lo que una persona nueva le pega al asistente); una subcarpeta u otro tipo de
archivo ahí rechazan la capa, y también un nombre que un asistente carga solo como instrucciones (`CLAUDE.md`,
`AGENTS.md` y parecidos, con la caja que sea). Nadie los ejecuta ni los carga solo: quedan en el árbol para leerlos. Más `team-layer.json` en la raíz del repo del equipo, que es su
declaración —`schema: 1`, `name` y `requires.harness` (`>= YYYY.MM.DD.N`: la versión mínima del arnés que la entiende)— y
no se apila. Cualquier otra ruta o extensión, un modo que no sea `100644`, un enlace, un submódulo, una ruta que la versión
pública ya trae (sin distinguir mayúsculas: en Mac y Windows son el mismo archivo), una skill dentro de una carpeta de la
versión o de una skill de terceros, un agente o una skill que se llama como uno de la versión, un `name:` que no es el de su
archivo o carpeta, un `hooks:` en un frontmatter, más de 1 MB o más de 300 archivos **rechaza la capa entera**, nombrando
cada caso. Nada ejecutable entra por acá: ni hooks, ni guiones, ni comandos, ni las traducciones a Codex. Un paquete se valida
con el cargador de la versión que va a quedar (`packs.js validateTree`, sobre sus paquetes y agentes más los de la capa):
si no vale, pasa lo mismo que con un perfil que no vale, y en `update` la versión queda anotada `team-invalid` para no
volver a bajarla en cada arranque. La lista que leen las personas: `scripts/tests/fixtures/team-layer-paths.json`.

**El mapa de renombres.** Sin él, una máquina instalada no entiende los nombres viejos de variables,
opciones, subcomandos y archivos de estado. Se valida contra la versión que va a quedar con el lector de ESA versión
(`scripts/lib/legacy-names.js`): la forma del mapa (`entries`, `retire_after` como fecha o `null`), la de cada entrada
(un `kind` que el lector conoce, `old` y `new` distintos, rutas que pasan su regla, sin un tramo `.git` y, si son
de la HOME, bajo `~/.claude/`; nombres con la forma de su tipo; `where` y `repo` sanos) y el nombre nuevo presente en lo que
la versión lista —un archivo o una carpeta cuyo nuevo no está sólo entra si el viejo tampoco (herramientas del
mantenedor que no viajan); una opción, subcomando, valor o clave de un guion de la versión, con su nombre nuevo en el
texto de ese guion—. Variables y archivos de estado, sólo por su forma. Una entrada mala rechaza la capa entera
nombrándola (`entries[i]`). Consecuencia: si una versión saca un nombre que el mapa todavía nombra, esa versión no
acepta la capa instalada hasta que se publique el mapa nuevo (`team-repo.js` lo valida contra la versión publicada:
publicar la versión y enseguida la capa). El freno de producción en `/opt` no recibe el mapa de la capa (sólo entra
lo verificado contra la versión): sigue con los nombres nuevos.

**Dos momentos.** Primero se **resuelve y valida** sin escribir ni registrar nada: la punta de `main` del repo del
equipo, su commit, la lista del árbol según GitHub (ahí se ven los modos: enlaces y submódulos), la declaración contra la
versión que va a quedar, y el perfil con el lector de esa versión (sobre una carpeta temporal, sin que la variable
`TYCON_PROFILE` desvíe la lectura). Sin acceso al repo del equipo —404 o 403, las dos son «sin acceso»—, `install` y
`migrate` salen 1 con la máquina idéntica y una sola acción: el permiso tiene que ver **los dos** repos, y el mensaje
nombra cuál no se ve. Después del «¿Instalo?» y de las skills de terceros se **baja y apila**: el comprimido se verifica
por el árbol del commit (cortado o alterado, se rechaza sin dejar nada), queda en `~/.tycon/team/<commit>/` con su
manifiesto (la segunda vez con el mismo commit no se vuelve a pedir), y los archivos se copian a `incoming/<versión>/`
antes del cambio, con `.tycon-team.json` al lado. La política se relee del árbol que quedó, así el estado dice el canal
del perfil del equipo. El estado guarda `team` (repo, commit, árbol, cuántos archivos).

**Actualizar.** `update` lleva la capa a cada versión nueva: la punta del repo del equipo si se puede leer y valida; si
no (sin red, sin permiso, o un perfil nuevo que el lector rechaza), **la que ya está** en `harness/`, comprobada contra su
manifiesto, y lo dice («capa del equipo: sin acceso…, sigue en `<sha7>`»). Una versión pública que trae una ruta de la
capa no se instala: la máquina queda donde estaba, se dice con qué ruta choca y la versión queda anotada como fallida
(`team-collision`) para no volver a bajarla en cada arranque.

**La mudanza con repo del equipo** no funde el perfil del clon en `~/.tycon/config.json` (lo que hace sin repo del
equipo): el perfil llega por la capa con origen «perfil», así un cambio futuro del repo del
equipo le llega a todas las máquinas. El plan lo dice: «perfil del equipo: viaja en la capa del equipo (…), no se funde».

**Los paquetes los decide el perfil.** En toda otra clave el archivo de la máquina le gana al perfil del equipo (apagar
una integración en la propia máquina es legítimo). En `packs.default` el perfil del equipo gana: el orden es la variable
`TYCON_PACKS_DEFAULT`, el perfil del equipo y recién después el archivo de la máquina. La página pública instala con
`--packs all`, y eso queda escrito en la máquina antes de que llegue la capa: si ganara, el día que el equipo cambie
su perfil esas máquinas no se enterarían. El archivo de la máquina no se toca; `tycon-config.js explain` dice lo que
quedó escrito ahí y no se usa, cuando difiere. Con un perfil que declara los paquetes, `install --packs` con otro
valor no se escribe y el plan lo dice en una línea. Para otros paquetes en una sola máquina: la variable, o `packs:`
en el repo. Sin capa del equipo no hay perfil que gane: vale lo que la máquina eligió al instalar.

**Un cambio sólo del equipo.** Sin versión pública nueva, la capa se refresca **dentro de `harness/`**: en el
arranque fuera de la ventana de red (10 minutos con `auto`, 6 horas con `ask`) y en `update` (con cualquier política, salvo
`--check` y `--dry-run`); también cuando la copia pública no se pudo mirar, porque la capa no depende de GitHub. Primero se
pide sólo la ref: si da el commit de `harness/.tycon-team.json` (o uno ya rechazado), no se pide nada más. Un commit nuevo
se valida igual que en `update`, contra la versión instalada y su lector, y se aplica como **una transacción chica**: cada
archivo se arma en un temporal al lado de su destino (`.tycon-team.tmp-…`, que `doctor` no cuenta y el refresco siguiente
borra), se renombra con reintento corto, y si uno no se puede reemplazar (en Windows, un archivo tomado) se repone lo ya
cambiado y se dice «no pude reemplazar…». El manifiesto se escribe último. Un archivo editado a mano no se pisa; lo que
el commit ya no trae se borra sólo si conserva su blob (si no, se conserva y queda en `kept` del manifiesto); y sólo se
toca una ruta de la lista cerrada que la versión pública no trae. Un archivo de la capa que falta se repone desde la caché
del mismo commit, sin pedidos. Lo que no se puede (sin acceso, una punta que no valida, un choque) no cambia nada: el
motivo queda en `state.team.last_error` y en el aviso de la sesión, que se suma a otro aviso; una punta rechazada queda en
`state.team.rejected` y no se revalida hasta que cambie. Si el perfil nuevo cambia la política, se relee en ese mismo
arranque. El aplicador corre después, así una integración que el perfil prende registra sus hooks en esa sesión.

**`doctor`, `rollback` y `uninstall`.** `doctor` dice la capa en una línea (nombre, repo, commit, cuántos
archivos, si está entera) y avisa —nunca en rojo: `doctor` corre dentro de la comprobación de salud— un archivo editado o
faltante, la capa declarada y ausente, el último refresco que no se pudo y que el paquete de revisores del
equipo todavía no está; en una máquina sin capa o en modo desarrollador no dice nada nuevo. `rollback` deja en el estado la
capa del árbol que quedó (o el repo sin commit, si ese árbol no la traía: el arranque siguiente la trae). `uninstall` deja
y nombra `~/.tycon/team` (si existe) y, antes de quitar nada, copia lo editado a mano de la capa a
`~/.tycon/team/kept-YYYYMMDD-HHMMSS/{harness,previous}/`; un árbol con algo que no pudo copiar no lo quita. También corre
desde la copia fija de arranque.

**Los revisores de la capa en Codex.** La capa no trae traducciones a Codex —un `.toml` puede declarar comandos
que Codex lanza—: la máquina las genera. Con Codex enchufado, el despliegue (`build/generate.js --deploy-only`, que corre
`deploy-codex-all.js`) escribe las dos traducciones de cada agente que nombra `.tycon-team.json` —`$CODEX_HOME/<r>.config.toml`
y `$CODEX_HOME/agents/<r>.toml`— con el generador y `build/equivalences.json` **de la versión instalada**, directo a la carpeta
de Codex: nunca al árbol, así `doctor` no las ve «editadas». Lo que Codex lanza (el modelo, los servidores MCP) sale de las
equivalencias de la versión, nunca de la capa. Un revisor de la capa que no se puede generar —un modelo o un servidor MCP sin
equivalencia, un frontmatter que no se lee— **no frena nada**: se dice (`⚠ tycon/codex: revisor de la capa <r> no
desplegado: <motivo>`), los demás se despliegan, el despliegue sale 0 y la actualización no vuelve atrás. Un archivo que ya
está en esa carpeta con el nombre de un revisor de la capa y no lo escribió el arnés es de la persona: no se pisa y se dice.
Lo escrito queda en un registro (`codex-team-deploy.json`, en la carpeta del estado, al lado del sello): nombre y hash de cada
archivo. Cuando la capa saca un revisor, sus dos archivos se borran **en ese mismo arranque** —la huella del despliegue incluye
el commit de la capa, así un cambio sólo de la capa redespliega— y sólo si siguen siendo los que se escribieron; uno editado
a mano queda y se dice. Sin un `.tycon-team.json` legible o con un refresco a medias no se borra nada. La paridad
(`harness-audit.js --parity`) compara cada revisor de la capa contra lo que el generador escribiría ahora, y `uninstall` y
`doctor` cuentan esos archivos como piezas de Codex. Una máquina con clon (`generate.js --deploy`) hace lo de siempre.

**Publicar la capa.** El repo del equipo se llena desde el interno con `node scripts/publishing/team-repo.js plan`
(no escribe: dice qué entra, cambia o sale y sobre qué punta del repo del equipo se calculó) y `push --expect <esa punta>`
(sin forzar: si la punta cambió, sale 2). Lo que va es una sola lista —lo que `split.js` manda a `team` en un commit
alcanzable desde `origin/main`— y se valida con los validadores **de la versión publicada** en el canal del perfil, bajada
como la bajan las máquinas: si una ruta, un nombre, un paquete o un revisor que Codex no traduciría no pasaría en las
máquinas, no se publica. `requires.harness` no puede ser mayor que esa versión ni menor que el que el repo del equipo ya
declara; el perfil sale sin `update.source`, `update.skills_source` ni `install.home`; los papeles de la raíz del repo del
equipo (`README*`, `LICENSE*`, `.gitignore`) no se tocan. Lo corre el dueño, con su git y su credencial: el guion no guarda
ninguna, y no viaja en la copia.

El onboarding interno (`onboarding/**`) es del repo de mantenimiento, no de la capa.

**Las skills con algo más que texto: la lista fija de la versión.** Una skill de la capa trae sólo `.md`, salvo
las que nombra `scripts/setup/harness/team-skill-extras.json` —un dato **de la versión**, al lado de `team.js`, que el repo del
equipo no puede cambiar ni ampliar: `team-layer.json` no gana claves—. Como máximo 3 entradas; hoy una, la skill `bizuit-sdd`.
Cada entrada trae su motivo, su **lista blanca** (los `.md` de su raíz y de sus carpetas, salvo las excluidas, y sus archivos de
datos por ruta exacta, todo con modo `100644` y verificado por su blob), su **presupuesto propio** (`maxBytes`: esos archivos no
cuentan en el tope de 1 MB del resto de la capa; los 300 archivos siguen siendo para todo), la **casa de sus datos** y lo que
la skill escribía en su carpeta. Para una skill de la lista, cualquier otra ruta —sus guiones, sus pruebas, su `.gitignore`, una
spec en `processes/`, una conexión— rechaza la capa entera, nombrándola. Nada de la lista se engancha como hook. Sumar una
entrada, una carpeta o una ruta es un cambio de la versión, con su prueba.

**La revisión y el retiro.** Cada entrada lleva una revisión cada tres meses (`review.next`), informativa: pasada la fecha,
`doctor` lo avisa (`warn`) y quien revisa corre la fecha o decide el retiro. El retiro va en este orden: (1) un commit del repo
del equipo saca la skill; (2) `doctor --json` de cada máquina muestra esa punta; (3) una versión del arnés saca la entrada. Al
revés, cada `update` quedaría `team-invalid` en toda máquina hasta que el repo del equipo la saque.

**La casa de los datos.** Lo que es de la persona —para `bizuit-sdd`, su conexión a BIZUIT— vive **fuera de la skill y fuera
del arnés**: `~/.bizuit-sdd/config.yaml` (en Windows, `%USERPROFILE%\.bizuit-sdd\config.yaml`); `BIZUIT_SDD_HOME` la cambia sólo
si es una ruta absoluta. Nada del arnés la borra (ni `update`, ni `rollback`, ni `uninstall`, ni la mudanza), y la línea `deja:`
de `uninstall` la nombra. Una máquina que ya usaba la skill tenía la conexión en la carpeta de la skill (`.bizuit-config.yaml`):
en `install --team` y `update` después de un cambio sano, y en la mudanza después de su etapa de enlaces, el arnés la copia sola
**una vez por skill** (`state.team.data_moved`) desde el primero que encuentra en este orden —la carpeta propia del dev en
`~/.claude/skills/<s>`, la carpeta que apartó la mudanza (`state.migrate_home.aside` y las `.before-migrate-*`, la más nueva
primero), el clon que la máquina dejó, `previous/`— y nombra los demás. Sólo si la casa no tiene una (si difieren, gana la casa);
sólo un archivo regular de hasta 64 KB; carpeta 700 y archivo 600; el original queda. **El contenido nunca va a una salida, un
registro ni al estado**; una clave sensible se avisa sin su valor. Lo que no se pudo copiar se dice y no frena. El plan de
`--dry-run` lo anticipa. El refresco en el lugar no copia nada.

**`doctor` y lo ajeno.** Con la capa, `doctor` avisa (nunca en rojo): lo que hay dentro de la carpeta de una skill de
la lista y no es de la versión ni de la capa (la conexión, con «su lugar es…»; lo demás, «se pierde con la próxima versión»),
en lugar de la línea «de más»; una carpeta propia que tapa la de la capa en `~/.claude/skills/<s>` (y en `~/.codex/skills/<s>`
con Codex), con las dos versiones y lo que trae que no es de la skill —sacarla es del dev—; el original que ya se copió; y la
casa resuelta. Antes de mandar `previous/` a `trash/` y antes de quitar un árbol en `uninstall`, lo ajeno de esas carpetas se
guarda en `~/.tycon/team/kept-<fecha>/<árbol>/<ruta>` y la salida lo nombra.

**Azure no pide dos veces lo que ya tiene.** Un archivo cuyo blob ya está en `harness/` o en otra caché
`~/.tycon/team/*` (verificado por su blob al leerlo) se copia de ahí y no se pide: un commit que sólo cambia el perfil cuesta la
lista (ref, commit, árbol) más un pedido. La declaración también queda en la caché de cada commit.

**Mirar es corto, bajar es largo.** Mirar si la punta del repo del equipo cambió usa el reloj de mirar. La bajada de la capa
arranca un reloj propio cuando empieza: 120 s, o 3 s por archivo que falte si eso da más (Azure baja de a un archivo), o lo que
diga `TYCON_RELEASE_DOWNLOAD_BUDGET_S`. Cada pedido de la bajada espera, como mucho, lo que un pedido de mirar
(`TYCON_UPDATE_NETWORK_BUDGET_S`): un servidor mudo sigue siendo «sin red», y rápido. Si el reloj de la bajada no alcanza, la
salida dice «se acabó el tiempo: bajé N de M archivo(s)», nunca «sin red». Lo ya bajado de Azure queda en
`~/.tycon/team/<commit>.partial/`, verificado por su blob, y el intento siguiente sigue desde ahí; la caché entera lo reemplaza.

**Publicar una skill de la lista.** `team-repo.js` juzga cada ruta dos veces: con la pertenencia del interno (si no pasa, sale 2)
y con la de la versión publicada que bajó. Una skill con alguna ruta que el interno admite y la versión publicada todavía no
(entre el merge que la admite y su publicación) queda **entera** afuera del `push`, dicha («espera la versión que la admite»),
sin frenar el resto; lo que el repo del equipo ya tenga de ella no se toca. Una versión anterior a la lista fija rechazaría la capa
que trae esas rutas y conservaría la suya.

**Lo que la capa no hace todavía:**
`uninstall --dry-run` no anticipa la capa; un commit malo del equipo se arregla con otro commit (o `TYCON_UPDATE=0`
mientras tanto); la llave del buzón entra sin validar su forma.

## Lo que todavía no está

- Dos pruebas de una persona: el día con una máquina Windows del equipo, y las dos corridas del
  pipeline de publicación con el repo ya público.
- Esta guía como fuente única, las nueve contradicciones de `INSTALL.md`/onboarding, el mapa, el retiro de los reparadores.

## Qué queda fuera en Windows (constancia)

Los hooks globales de git y los LaunchAgents son paridad del aplicador, no del mecanismo. El instalador de
Windows registra los mismos controles que el de bash, y lo que queda afuera está declarado con su motivo en
`scripts/setup/windows-support.json` (`excluded`). Los dos aplicadores leen una sola lista (`scripts/setup/hooks-list.json`);
`scripts/tests/hooks-lists-parity.test.js` frena si la lista y lo excluido se desfasan. Lo que eso le sumó al mecanismo:

- **`doctor` cuenta lo que falta.** Además de las piezas que el aplicador reportó, dice cuántos controles ESPERADOS para
  esta plataforma y esta configuración no están en `settings.json`, y cuáles (lo apagado y lo de una integración apagada
  no se espera); en Windows muestra lo excluido como «fuera en Windows: <motivo>». Es un aviso, nunca un rojo: un rojo de
  `doctor` hace volver atrás una actualización.
- **Los finales de línea, antes de aplicar.** En Windows y en modo instalado, justo antes de lanzar el aplicador, mira
  `git ls-files --eol` del clon del arnés: un clon anterior al `.gitattributes` conserva `\r\n` en lo que el `pull` no
  toca, y un freno `.sh` con `\r\n` sale 255 y no frena. Con el árbol limpio lo normaliza (`git rm --cached -r -q .` y
  `git reset --hard -q`) y lo dice; con cambios sin commitear no toca nada y avisa qué correr; si falla, lo dice y sigue.
  En modo `developer`, en Mac y en Linux no corre. `TYCON_HARNESS_EOL_PLATFORM` existe sólo para probarlo sin Windows.
  Después de normalizar, `doctor` no cuenta como cambio el paso de `\r\n` a `\n`: ni la copia fija sale «vieja» ni los
  bloques de `CLAUDE.md` salen «sin registrar» por eso; otro contenido sí sigue dando el aviso.
- **La salud y el bash.** En Windows revisa la sintaxis de un hook `.sh` con el bash de Git (el primero del PATH puede ser
  el lanzador de WSL); si no lo encuentra avisa «sin comprobar» y no falla. Un `.sh` con `\r\n` es un AVISO de la salud,
  no un rojo: el `\r\n` está en el disco del clon y volver atrás la actualización no lo arregla.
- **La primera actualización que trae esto.** La juzga la salud de la versión anterior, que no sabía usar el bash de Git.
  Por eso `harness.js` le pasa al aplicador `TYCON_HARNESS_GIT_BASH_HEALTH=1`; sin ella (lo lanzó un `harness.js` de
  antes), el `.ps1` deja los hooks `.sh` para la corrida siguiente y lo dice. Hasta el arranque siguiente, en Windows
  faltan los dos frenos; `doctor` lo muestra.
- **Lo que el paso de finales de línea no toca.** Si hay archivos marcados `--assume-unchanged` o `--skip-worktree`
  (cambios que `git status` no muestra), no toca nada y dice cuáles. Reescribe sólo los archivos con `\r\n`, sin vaciar el
  índice; un índice vacío con archivos en `HEAD` se dice como estado roto, también en `doctor`. En `startup` su aviso va a
  `notice`, que es lo que la persona ve al abrir una sesión.

Lo que sí es igual en los dos sistemas: tres piezas que antes escribía sólo el instalador de bash
—`cleanupPeriodDays`, la variable de `env` y la copia de `commands/` a `~/.claude/commands/`— las hace y las anota en el
registro `harness.js` cuando lanza el aplicador (`scripts/setup/harness/shared.js`; el instalador corrido suelto las sigue
haciendo él). `harness.js` se lo avisa al aplicador con `TYCON_HARNESS_SHARED_DONE=1`, que sólo pone cuando ya las hizo:
un programa anterior no la pone, y el instalador las hace como siempre. Tres precisiones: si `settings.json`
todavía no existe, corre primero el aplicador (su esqueleto trae el `"$schema"`) y el módulo después; `TYCON_NO_AUTOINSTALL=1`
apaga también estas piezas; y si la persona ya fijó otro valor, gana el suyo y no se anota. Y en Windows `harness.js` no
pide `python3`: nada de lo que corre ahí bajo el mecanismo lo usa. Si `settings.json` está ocupado por otro programa
(`EPERM`, `EACCES`, `EBUSY`: lo corriente en Windows), la escritura espera 50 ms y después 100 ms antes de rendirse; si
se rinde no deja nada a medias, lo dice, y las tres piezas las hace el aplicador. Si tampoco pudo borrar su temporal o
su `.bak`, el motivo nombra la ruta de lo que quedó.
