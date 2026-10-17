# Engram — Workflow TYCON

Guía team-wide para usar **engram** (memoria persistente del arnés — la misma bajo Claude Code
y Codex) en todos los proyectos del equipo. Esta convención es común a Pacara, Totora, FRESNO, los repos de la plataforma, Yatay y cualquier otro repo que tenga `.engram/` versionado.

Documentación oficial: https://github.com/Gentleman-Programming/engram

---

## 1. Setup inicial (una vez por máquina)

Estos pasos se corren **una sola vez por máquina de trabajo**, no por proyecto.

```bash
# 1. Instalar engram (macOS, via tap oficial)
brew install Gentleman-Programming/tap/engram

# 2. Verificar instalación
engram --version

# 3. Configurar engram como MCP server en Claude Code
engram setup claude-code
```

Después de `engram setup claude-code`, **reiniciar la sesión** para que los tools `mcp__plugin_engram_engram__*` queden disponibles (bajo Codex, el deployer los re-traduce solo en el próximo arranque; ojo el saneo de guiones — la tabla de nombres del lado Codex es la referencia).

Si en alguna sesión `which engram` devuelve vacío → **bloqueante**: pedirle al usuario que instale engram antes de continuar. Sin engram se pierde todo el contexto operativo (arquitectura, bugs resueltos, decisiones, constraints) que fue migrado desde los `CLAUDE.md` de cada repo.

---

## 2. Regla crítica: el `project name` es explícito

**Esta es la convención más importante del equipo.** Romperla invalida silenciosamente toda la memoria.

### Por qué

Engram **auto-detecta el nombre del proyecto a partir del directorio de trabajo**. Pero en TYCON los directorios casi nunca coinciden con el nombre canónico del proyecto:

La tabla de cada repo del equipo con su nombre canónico vive en los datos internos del equipo
(«Proyectos de memoria (engram) por repo»). El del arnés es `tycon` (memoria del **harness**, no de un producto), fijado en
`.engram/config.json` + `.engram-project`.

> **`tycon` es el proyecto del harness** (2026-07-25): decisiones sobre el pipeline, los
> advisors, las convenciones de stories, los hooks, los bloques de `CLAUDE.md`. Vive acá
> porque este repo es el único que todo el equipo clona en todas sus máquinas. Si estás
> tocando el harness — aunque el `cwd` sea el repo de un producto — guardá con
> `project: "tycon"`, no con el del producto. Regla práctica: si el cambio le sirve al
> equipo en cualquier proyecto, es `tycon`.

Si dejás que engram autodetecte, las memorias quedan guardadas bajo un nombre incorrecto (ej: `BackEnd`, `FrontEnd`) y **nunca se encuentran después** desde otra máquina, desde otro repo hermano, o cuando el directorio se renombra.

> **Notas de engram v1.20 (2026-08-22)**: los project names se guardan **lowercaseados** y el
> filtro por proyecto es **case-insensitive** (`totora` y `TotoraBackend` ya no se distinguen
> por mayúsculas — el nombre distinto sigue fragmentando igual). Y 🔴 **NO usar
> `engram projects consolidate --all`**: su agrupación automática mete proyectos distintos en el
> mismo grupo (Totora+Ceibo+Nimbo juntos, medido en la consolidación de Totora) — las
> consolidaciones se hacen por proyecto explícito.

> 🤖 **Desde 2026-08-25 esto se chequea solo.** El hook `engram-drift-notice.js` (SessionStart,
> throttle diario) avisa si algún repo tiene `.engram/` **sin `project_name` fijado**, si un
> directorio quedó con la memoria **repartida en varios nombres**, o si hay observaciones que
> **nunca se exportaron** a `.engram/chunks` (o sea: viven en una sola máquina y se pierden con el
> disco). Silencio total en verde; apagar con `TYCON_ENGRAM_DRIFT=0`. Reusa los chequeos de
> `harness-audit.js` (categoría Memory Persistence) en vez de duplicarlos.
>
> Existe como hook y no sólo como check del scorecard porque ese script **sólo corre si alguien se
> acuerda de correrlo** — y el modo de falla de engram es SILENCIOSO: buscar con el nombre
> equivocado devuelve *"no memories found"*, idéntico a lo que devuelve un repo sin historia. Es la
> misma regla que el resto del arnés: *un control que hay que acordarse de invocar es un control que
> no corre.* Casos que lo motivaron (2026-08-24/25): 4 repos con la memoria partida —
> el repo del framework (74 obs en 6 nombres, por un rename de carpeta), el arnés (135 en 7,
> porque esta guía mandaba un nombre y `.engram-project` declaraba otro), Ceibo (1151 en 4) y
> un repo del equipo (507 en 4) — más ~1000 observaciones que nunca habían salido de una máquina.
>
> 🔴 **Al unificar: selección EXPLÍCITA por número, NUNCA `engram projects consolidate --all`.** En
> las tres corridas reales el dry-run ofreció mezclar proyectos ajenos: los 108 obs del arnés dentro
> de un producto, y 488 obs de BPMN dentro de otro. Y después de consolidar, correr
> `engram sync --project <nombre>` + commitear `.engram/`: **el rename NO re-exporta solo**, así que
> las observaciones mudadas se quedan sin viajar hasta que alguien las toca.

### Regla

**En TODA llamada a engram (MCP o CLI) pasar el `project` explícito.**

Llamadas MCP (desde la sesión del agente):

```
mem_save(project: "NimboBackEnd", key: "...", content: "...")
mem_search(project: "NimboBackEnd", query: "...")
mem_context(project: "NimboBackEnd")
mem_session_start(project: "NimboBackEnd")
mem_session_summary(project: "NimboBackEnd")
mem_session_end(project: "NimboBackEnd")
```

CLI:

```bash
engram sync --project NimboBackEnd
engram search --project NimboBackEnd "query"
```

### Cómo descubrir el `project name` canónico

Al entrar a un repo nuevo, determinar el nombre correcto **antes** de llamar a cualquier `mem_*`:

1. **Primero: leer el `CLAUDE.md` del proyecto.** Todos los repos TYCON declaran su project name al inicio, típicamente en una sección `## Engram` o similar. Buscar frases como:
   - `Nombre de proyecto en engram: \`XXX\``
   - `proyecto = "XXX"`
   - `project: "XXX"`

2. **Segundo (fallback): inspeccionar el repo `.engram/`.** Mirar los chunks existentes en `.engram/chunks/` — cada uno lleva metadata con el `project_name` que usó quien lo exportó. Esto confirma bajo qué nombre están las memorias históricas.

3. **Nunca asumir desde el nombre del directorio.** Si el `CLAUDE.md` no lo dice y `.engram/` está vacío, preguntarle al usuario cuál es el project name antes de guardar la primera memoria.

---

## 3. Ciclo de sesión

### Inicio de sesión — importar memorias

**SIEMPRE** al empezar a trabajar, antes de cualquier otra cosa:

```bash
git pull                    # primero traer chunks nuevos del equipo
engram sync --import        # carga los chunks de .engram/ a la DB local
```

`engram sync --import` es **idempotente** — chunks ya importados se ignoran. Auto-detecta los chunks en `.engram/` del directorio actual.

Después, desde la sesión del agente, levantar el contexto relevante:

```
mem_context(project: "ProjectName")
mem_search(project: "ProjectName", query: "tema sobre el que voy a trabajar")
```

### Durante la sesión — guardar proactivamente

**No esperar a que el usuario pida guardar.** El protocolo engram es *always-active*: guardá con `mem_save` apenas aparezca algo que valga la pena recordar entre sesiones.

**Qué guardar:**
- Decisiones de arquitectura y su razón
- Bugs encontrados y cómo se resolvieron (especialmente los no-obvios)
- Convenciones del proyecto descubiertas durante el trabajo
- Configuraciones de entorno (connection strings de test, URLs, puertos)
- Problemas recurrentes y sus soluciones (lecciones para el próximo)
- Estado de tareas en progreso al final de la sesión
- Spec anchors descubiertos al implementar stories (story decía X, realidad es Y)

**Qué NO guardar:**
- Código fuente (ya está en git)
- Información que ya vive en `CLAUDE.md` o en un skill
- Credenciales productivas o secretos

### Fin de sesión — las memorias viajan con el próximo commit autorizado

Al cerrar la sesión no se exporta a mano: lo que se exporta se commitea en el mismo acto, o no se
exporta (un `.engram/` stageado sin commit choca con el `pull --autostash` del arranque siguiente). Con `.engram-project` en la raíz, el hook de pre-commit exporta y
stagea `.engram/` dentro del próximo commit que el dev autorice. Sin ese archivo, inmediatamente
antes de ese commit y en el mismo acto:

```bash
engram sync --project ProjectName   # escribe chunks nuevos a .engram/
git add .engram/                    # y el commit autorizado, a continuación
```

El commit y el push siguen la Regla #0 de `git-commit-conventions.md`: van cuando el dev los autoriza, junto con el resto del trabajo — no un commit propio al cerrar la sesión.

El directorio **`.engram/` está versionado en git** — así se sincronizan las memorias entre máquinas y entre devs. Sin el commit + push, la memoria queda sólo en tu laptop.

> **Automatizado desde 2026-07-13**: el hook [`scripts/hooks/engram-pre-commit.sh`](../../scripts/hooks/engram-pre-commit.sh) (instalado por default por `install-tycon-hooks.sh`) corre el `engram sync` + `git add .engram/` solo, antes de cada `git commit` desde la sesión del agente (en `git push` no hace nada desde 2026-09-16: sincronizar ahí deja el índice modificado sin commit y el arranque siguiente choca) (el hook está registrado en las dos herramientas). **Requiere un archivo `.engram-project` en la raíz del repo** con el project name canónico (ej: `echo "NimboBackEnd" > .engram-project`) — sin ese archivo el hook no hace nada y el paso sigue siendo manual. Opt-out global: `TYCON_ENGRAM_HOOK=0`.

**Cuando el repo donde se commitea no guarda memoria y el proyecto la guarda en otro** (el repo público de un proyecto
cuya memoria vive en un repo privado, por ejemplo): un commit ahí no exporta nada, en ningún lado. El hook no escribe en
un repo sin `.engram-project`, y tampoco exporta al otro clon desde ahí: lo que queda sin preparar en un repo donde no se
está commiteando no viaja nunca. `engram sync --project X` exporta todo lo pendiente del proyecto, se haya guardado
desde la sesión que sea: lo exporta y lo prepara el próximo commit hecho **en** el clon que guarda la memoria. Se
pierde demora, no memoria. Dos cosas a cuidar: la sesión que trabaja en el repo sin memoria tiene que guardar con el
`project` del proyecto (ahí no hay `.engram/config.json` que lo diga: es la regla de la sección 2, y acá no hay red), y
`harness.js doctor` recuerda dónde viaja esa memoria cuando la máquina declara su clon privado (`paths.maintainers`).

Opcional antes del commit, cerrar la sesión formalmente para que quede un resumen de la sesión:

```
mem_session_summary(project: "ProjectName")
mem_session_end(project: "ProjectName")
```

---

## 4. Quick reference de tools MCP

Todos los tools viven bajo el prefijo `mcp__plugin_engram_engram__`. Todos aceptan (y requieren) el campo `project`.

| Tool | Cuándo usarlo |
|------|---------------|
| `mem_session_start` | Al arrancar una sesión de trabajo en un proyecto (opcional si vas a usar `mem_context` directamente). |
| `mem_context` | Primera llamada de la sesión: trae contexto reciente del proyecto. Úsalo como "warm up". |
| `mem_search` | Buscar memorias por texto/tema. Úsalo ANTES de empezar una tarea para ver si ya hay contexto previo. |
| `mem_save` | Guardar una decisión, bug, convención o descubrimiento. Usar PROACTIVAMENTE durante la sesión. |
| `mem_update` | Actualizar una memoria existente cuando la realidad cambia (ej: URL, versión, decisión revocada). |
| `mem_get_observation` | Leer una observación puntual por ID cuando `mem_search` devolvió un hit y querés el contenido completo. |
| `mem_suggest_topic_key` | Sugerir una `key` canónica para un topic (útil antes de `mem_save` para mantener naming consistente). |
| `mem_save_prompt` | Guardar un prompt reutilizable (menos común en día a día). |
| `mem_capture_passive` | Captura pasiva de contexto; dejar al harness. |
| `mem_session_summary` | Al cerrar sesión: resumen de lo trabajado. |
| `mem_session_end` | Cierre formal de sesión (después de `mem_session_summary`). |

Flujo típico mínimo de una sesión:

```
1. engram sync --import                                    (shell, una vez)
2. mem_context(project: "X")                               (el agente, inicio)
3. mem_search(project: "X", query: "tema")                 (el agente, al empezar cada tarea)
4. mem_save(project: "X", key: "...", content: "...")      (el agente, durante el trabajo)
5. mem_session_summary(project: "X")                       (el agente, al terminar)
6. (el export viaja con el próximo commit autorizado: el hook, o sync + add justo antes de ese commit)
```

---

## 5. Anti-patrones

Cosas que **NO** hacer, con la razón:

### NO asumir el project name desde el directorio

Si el directorio se llama `BackEnd` y guardás con `project: "BackEnd"` (o peor, sin pasar `project`), las memorias quedan huérfanas. Siempre leer el `CLAUDE.md` del repo o los chunks en `.engram/` para descubrir el nombre canónico. Ver sección 2.

### NO dejar `.engram/` fuera del commit

Si `engram sync --project X` corre pero `.engram/` no entra en el commit que el dev autoriza, las memorias nuevas quedan sólo en tu máquina: el resto del equipo (y vos mismo desde otra máquina) no las ve. Con `.engram-project` en la raíz, el hook lo agrega solo; sin él, `git add .engram/` antes de ese commit.

### NO saltarse `engram sync --import` al inicio de sesión

Si alguien del equipo pusheó memorias nuevas y vos no importás, trabajás con contexto viejo. Peor: si guardás memorias sobre un tema que ya fue resuelto por otro, vas a duplicar o contradecir lo existente. **Primero `git pull`, después `engram sync --import`, después trabajar.**

### NO guardar código, credenciales productivas o contenido ya versionado

Engram es para **metadatos sobre el código** (decisiones, bugs, convenciones), no para el código en sí. El código ya está en git. Credenciales productivas nunca van a engram (quedan en gestores de secretos). Tampoco duplicar lo que ya está en `CLAUDE.md` o en un skill — eso ya se carga automáticamente.

### NO llamar a `mem_*` sin `project`

Aunque engram tenga un default por directorio, **nunca confiar en eso** en TYCON. El default casi siempre es incorrecto para nuestros repos. Pasar `project: "X"` explícito siempre, en cada llamada, sin excepciones.

### NO esperar a que el usuario pida `mem_save`

El protocolo engram del equipo es proactivo. Si resolviste un bug no-obvio, descubriste una convención, o tomaste una decisión de arquitectura, **guardalo ahora** — no al final, no "cuando haga falta". En 3 meses nadie se va a acordar (ni vos).

### NO cambiar el `project name` histórico (sin consolidar de verdad)

Un rename "de palabra" deja las memorias históricas bajo el nombre viejo, inaccesibles. Si un
nombre tiene que cambiar, el cambio es una **consolidación completa**: migrar las observaciones
al nombre nuevo + pin de `.engram/config.json` en cada repo + actualizar los `CLAUDE.md`. El
nombre canónico es el que está en el `CLAUDE.md` del repo, punto.

**Totora ya se consolidó (2026-08-20/22)**: los 4 repos usan el proyecto único `totora`
(pin `.engram/config.json` en raíz, `Backend/`, `FrontEnd/` y `Project/`), y las ~250
observaciones históricas repartidas en 11 nombres (`TotoraBackend`, `TotoraCustomForms`,
`TotoraProject`, etc.) se migraron a `totora` el 2026-08-22. **Los nombres viejos NO se usan
más**: un `project: "TotoraBackend"` explícito hoy re-fragmenta la memoria que se acaba de
juntar — con el pin puesto, lo correcto es no pasar override o pasar `totora`.


## Conflicto en `.engram/manifest.json` — la maniobra correcta (ENGRAM-MANIFEST-1, 2026-08-22)

El manifest es una lista donde cada rama/sesión que sincroniza agrega su entrada al final — dos
ramas que tocaron memoria van a conflictuar ahí CASI SIEMPRE al mergear (medido: pasó en los dos
merges del 2026-08-22). **La resolución correcta NO es mergear el JSON a mano**:

```bash
# 1. Quedarse con el manifest de la rama que MÁS entradas tenga (casi siempre main)
git checkout --theirs .engram/manifest.json    # o --ours según de qué lado venga el histórico
python3 -c "import json;print(len(json.load(open('.engram/manifest.json'))['chunks']),'entradas')"
ls .engram/chunks/*.jsonl.gz | wc -l           # ¿cuántos chunks hay en disco?

# 2. Si faltan entradas, agregarlas a mano (el formato no tiene checksums):
#    {"id":"<nombre del .jsonl.gz sin extensión>", "created_by":"<vos>",
#     "created_at":"<ISO Z>", "sessions":0, "memories":<líneas del chunk>, "prompts":0}

# 3. Verificar ANTES de commitear que un importador ve TODOS los chunks:
T=$(mktemp -d); cp -R .engram "$T/.engram"; (cd "$T" && engram sync --import --project <nombre>)
#   → tiene que decir el número de chunks que hay en disco. Si dice menos, el manifest está corto.

git add .engram/ && git commit
```

🔴 **NO borres el manifest esperando que se regenere.** Parece que
`git rm .engram/manifest.json && engram sync` "regenera el índice desde
los .jsonl.gz". **Medido el 2026-08-22 y es falso**: `engram sync` **exporta lo pendiente**, no
reconstruye — y si ya había exportado, deja un manifest de **1 entrada con 19 chunks en disco**.
El daño es del tipo peor: un manifest corto **no da error**. Las otras máquinas importan de menos
y el síntoma es un tranquilizador `no new chunks`, o sea memoria del equipo perdida en silencio.

Los datos reales viven en los chunks (`.engram/chunks/*.jsonl.gz`); el manifest es el índice que
dice cuáles existen, y **si un chunk no está listado, para las demás máquinas no existe**. Red que lo acompaña: `engram-pre-commit.sh` valida el manifest
ANTES de stagearlo (marcadores de conflicto o JSON inválido → NO se stagea, el commit se frena
visible y el aviso trae esta maniobra). Por qué: un `git add` incondicional "resuelve" el conflicto
sin mirar, y el merge llega a main con marcadores adentro del JSON.

## Te frenó el commit: «el índice de memoria PERDIÓ entradas» (2026-09-17)

Antes de cada commit, el arnés cruza el índice (`.engram/manifest.json`) contra los archivos de
`.engram/chunks/`. Si **este** commit está por dejar afuera una entrada que `HEAD` declara —o por
meter un archivo de memoria sin declararlo—, el commit se **frena**. El mensaje trae el comando
exacto. No repara solo, a propósito: cambiar el índice sin que se vea es el mismo silencio que el
freno combate.

```bash
# El comando que el bloqueo nombra (ruta absoluta, funciona desde cualquier carpeta):
node <clon del arnés>/scripts/lib/manifest-engram.js repair --apply --repo <el repo>
git commit …          # de nuevo: la reparación deja el índice stageado
```

**Qué hace `reparar`**: por cada archivo sin entrada busca la entrada **exacta** que engram escribió
alguna vez, recorriendo toda la historia de git del índice —incluidos el otro lado de un merge y las
ramas sin mergear—, y sólo si nadie la tuvo nunca la reconstruye contando el propio chunk. **Nunca
inventa** (lo ilegible lo dice y no lo toca), **nunca borra** (una entrada cuyo archivo no está, o
repetida, se lista para que decidas vos) y **no reordena** las que ya están. Sin `--apply` te dice
qué haría y de dónde saldría cada una, sin escribir nada.

**Qué NO frena** (a propósito — un freno que muerde por algo que rompió otro se apaga en una semana):
la deriva que ya venía de antes, y lo que no se pudo medir. Las dos avisan con el mismo comando.

| Situación | Qué pasa |
|---|---|
| Este commit pierde una entrada, o deja un archivo sin declarar | 🛑 **frena** |
| El índice ya venía incompleto y este commit no lo empeora | ⚠️ avisa, pasa |
| No se pudo medir (índice roto, sin `jq`, sin `node`) | ⚠️ dice «no pude medir» — nunca «sano» |
| Todo cierra | silencio |

**Escapes** (los dos quedan registrados): `TYCON_ENGRAM_MANIFEST_GUARD=0` en el entorno apaga el
bloqueo pero no el aviso; `TYCON_ENGRAM_MANIFEST_OK=1 git commit …`, pegado al comando, vale sólo
para ese commit.

**El mismo criterio corre en otros dos momentos**: el aviso de la mañana lo publica para todos tus
repos (y te da el comando por repo), y el control del servidor lo aplica a cada pull request — que
es lo único que ve los commits hechos fuera del asistente: la web de Azure, otra máquina, un hook
salteado. Los tres preguntan al mismo archivo (`scripts/lib/manifest-engram.js`): si el criterio
cambia, cambia en los tres a la vez.

**Para mirarlo sin commitear nada:**

```bash
node <clon del arnés>/scripts/lib/manifest-engram.js cross --repo <el repo>    # 0 sano · 1 deriva · 3 no medido
```

> **Multi-modelo**: engram se configura UNA vez (lado Claude); el deployer de Codex traduce el server solo. La memoria es LA MISMA para las dos herramientas.
