# Cerrar la historia

**Objetivo**: dejar trazabilidad regulatoria-grade en el work item de Azure DevOps al momento de marcar una story como `done`. Postea un comment con los commit SHA(s), CI run y PR link que dieron cierre a la story, y transiciona el state del WI a `Closed` / `Done`.

**Disparo**: NO se ejecuta en el flujo principal del pipeline. Se invoca cuando el dev dice explícitamente:

- "cerrá la story X en ADO"
- "marco done la story X"
- "post-DoD, cerrar ADO"
- "/tycon-pipeline close <story-path>"

Si el dev solo dice "marcá done en el frontmatter", también disparar este step (cuando la story tiene id de pedido de trabajo, `work_item:` o su nombre viejo `ado_work_item:` — ver más abajo).

## 🔴 Pre-condiciones (NO skipear)

Antes de postear nada en ADO, validar que se cumple TODO esto:

1. **El portón de «terminado» pasó** — y el que manda es la **matriz de verificación por criterio de
   aceptación**, no una lista de chequeos sueltos:
   - `marker.js run-check acmatrix -- node <skill>/scripts/runtime-matrix.js --story <abs spec.md>`
     en VERDE. Verde quiere decir: cada AC con evidencia de EJECUCIÓN real (gate E2E o
     `smoke-run.sh` con exit code capturado), o declarado imposible en el frontmatter
     `runtime_not_verifiable:` (con `reason:` + `covered_by:`) **y firmado por el dev desde su
     terminal** con `marker.js runtime-waiver <abs spec.md>`.
   - 🔴 Un AC `SIN CORRER` **no se waivea**: lo corre el agente. Sólo los `imposibles-declarados`
     son elegibles para la firma del dev.
   - 🔴 **El registro de esa firma NO va al frontmatter.** El `ack` escribible por el agente fue el
     agujero que se cerró el 2026-07-10 y no se reintroduce: la firma la produce el comando TTY y
     vive en `.tycon/runtime-waivers.jsonl` del repo de la story.
   - Si la story es de UI, además la guía de prueba manual del tester (DODRT-C7) tiene que estar
     lista: `node <skill>/scripts/qa-guide.js --check --story <abs spec.md>`.
   - Contexto y criterio: `~/.claude/tycon-harness/guides/definition-of-done.md`.
2. **Sin deudas abiertas** — pre-condición MECÁNICA. Antes, cada tanda del bloque `pipelines:` que ya está en
   main pasa a `done` con el orquestador, nunca editando el archivo:
   `node <skill>/scripts/marker.js update-pipeline-status <abs spec.md> <tanda> done` (todas a la vez: `--all`,
   sólo si TODAS están en main). Una tanda que no está en main no se pasa: es la deuda que este punto frena.
   ```bash
   node <skill>/scripts/pipeline.js deferrals-open --story <abs spec.md> --repo <repo>
   ```
   - exit 0 → seguir. **exit 3 → STOP** con la lista que imprime: tags `[story-{N}-*]` vivos en
     `tasks/todo.md` (ni dentro de `~~…~~` ni `[x]`; con el id tal cual o con guiones: `[story-<N.M>-…]` o
     `[story-<N>-<M>-…]`) o tandas `pipelines.X` con `status != done`. El dev cierra
     esos deferrals O los ratifica con un CR aprobado antes de continuar. **exit 1** (no pudo leer la
     story o el `todo.md`) → STOP: «no pude mirar» no es «no hay deuda».
3. *(Retirada el 2026-09-16.)* Hasta esa fecha este paso relanzaba dos revisores
   con modelo —el checker de DoD y el de cobertura de ACs en modo transición a done— sobre una story
   ya cerrada. No se relanzan: lo que contestaban es el grep del punto 2, la matriz por AC ya corrió
   en verde (punto 1), y el control local de `review → done` (hoy avisa) y el portón de CI siguen mirando. Medido: cero
   hallazgos en todo el registro.
4. **Merge a main hecho** (vía `/tycon-merge-to-main` o manual) — para tener el CI run definitivo y, si aplica, el PR link.
5. **Frontmatter `status:`** debe estar en `review` (después de «Preparar el commit») o `done` (si dev ya lo movió manualmente). NO ejecutar este cierre sobre `ready-for-dev`/`in-progress` — es señal de que el flujo no completó «Preparar el commit».
6. **Si la story NO tiene id de pedido de trabajo** → NO skipear el pedido con "N/A". Resolver en este orden (ver sección "Creación retroactiva del pedido" abajo):
   a. Si el repo tiene la configuración del pedido de trabajo (`.tycon/work-items.yaml` o `.tycon/ado-config.yaml`) → **CREAR el pedido retroactivamente** (hijo del Epic mapeado en `epic_links`), escribir `work_item:` en el frontmatter, y continuar con el cierre normal (comment + cierre + horas). NO preguntar al dev por un ID que no existe.
   b. Si el dev SABE que ya existe un WI (creado a mano fuera del flujo) → preguntar el ID, NO grep por título (puede haber WIs con títulos similares).
   c. Si el repo NO tiene ninguno de los dos archivos → el pedido genuinamente N/A, skip esa parte (solo entonces).

   **🔴 Anti-pattern**: leer "sin id → el pedido no aplica" y skipear toda esa parte cuando el repo SÍ tiene su configuración con `epic_links` (y las stories hermanas tienen pedido). El skip deja stories `done` y mergeadas sin pedido ni horas cargadas. **"Sin id" NO significa "no aplica" — significa "falta crear el pedido" cuando hay configuración.** El fix es crear retroactivamente, no skipear.

Si alguna condición falla → STOP. Pedir al dev que complete la pre-condición faltante. No postear comment parcial.

## Inputs

- `story_path` — path al .md de la story
- `id` del pedido de trabajo — del frontmatter (`work-item-field.js get`) o preguntado al dev
- `commit_shas[]` — lista de commit SHAs que implementaron la story (ver "Recolección de commits")
- `ci_run` — número/link del CI run post-merge que validó el build verde (ver "Recolección de CI run")
- `pr_link` — URL del PR si la story se mergeó vía PR (opcional — algunos proyectos pushean directo a `main`)
- dónde vive el pedido — lo resuelve la capa de plataforma (ver "Dónde vive el pedido" abajo)
- `time_tracked` — el tiempo registrado para la story en la herramienta de horas de la organización (ver "Recolección de tiempo: el aviso de trabajo")

## Recolección de commits

Los commits que dieron cierre a la story son **todos los commits del implementador entre el inicio de la story y el merge a main**, NO solo el último. Story típica tiene 3-15 commits (init + iteraciones + fixes post-advisors + tests + DoD adjustments).

Estrategia:

```bash
# Si la story tiene un frontmatter `branch:` con el nombre de la branch:
git log <branch>..main --reverse --pretty=format:"%H %s" | grep -i "<story-id>"

# Si no hay branch tracking, usar fecha de creación del .md como anchor:
story_start=$(git log --reverse --pretty=format:"%aI" -- <story_path> | head -1)
git log --since="$story_start" --pretty=format:"%H %s" | grep -iE "(story <id>|<short-title>)"

# Fallback: pedir al dev los SHAs explícitamente.
```

Mostrar la lista al dev y pedir confirmación: *"Estos son los commits que detecté para esta story. ¿Correcto? ¿Falta alguno?"* — el dev SIEMPRE valida antes de postear.

## Recolección de CI run

El CI run relevante es el **post-merge a main** (ya con todo el código integrado), NO los runs de feature branch.

Estrategia según provider:

```bash
# Azure DevOps Pipelines:
az pipelines runs list --organization https://dev.azure.com/<org> --project <project> \
  --branch main --top 5 --query "[?contains(sourceVersion, '<merge-sha>')].{id:id, status:status, result:result, web:_links.web.href}"

# GitHub Actions (si aplica):
gh run list --branch main --limit 5 --json databaseId,headSha,status,conclusion,url \
  | jq '.[] | select(.headSha | startswith("<merge-sha-prefix>"))'
```

Tomar el primer run verde (`result=succeeded` / `conclusion=success`) post-merge. Si no hay run verde → STOP, dev debe arreglar CI antes de cerrar la story.

**Repo sin CI** (2026-10-05): si el repo no tiene NINGÚN archivo de CI (ni `azure-pipelines*.yml`, ni `.github/workflows/*.yml`, ni `.gitlab-ci.yml`), no hay corrida que buscar: **no es STOP**. `ci_run` queda «sin CI en el repo» y el cierre sigue con la evidencia local (build y pruebas de «Implementar» y «Correr las pruebas»). El STOP de arriba vale para un repo que SÍ tiene CI y no muestra una corrida verde.

## Recolección de tiempo: el aviso de trabajo

El pipeline no sabe con qué herramienta se registran las horas: le avisa a la integración elegida que el trabajo de la
story terminó, y ella cierra lo que tenga abierto e informa el tiempo.

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js work-signal stop --story <abs spec.md> --repo <repo>
# → { ran, seconds?, hours?, action?, warnings }
```

1. **`hours`** (los `seconds` que informó la herramienta, en horas) → es el tiempo a sumar a `CompletedWork`.
2. **`action`** → una herramienta que maneja el agente (con su servidor de MCP) dice qué hacer: cerrar su entrada
   abierta y sumar las de la story, con su skill. El total que da es el tiempo a sumar.
3. **Ninguno de los dos** (sin herramienta elegida, o nada registrado) → no hay tiempo: el comment va sin el campo.

Si vienen los dos, se suman: lo informado más lo que da la acción. Mostrarle al dev el total y lo que lo compone antes
de postear.

### Lo real en el registro de estimaciones

Después del `stop`, se anota lo real de la historia en el registro de estimaciones de su repo de historias
(`.tycon/estimates.jsonl`), con el sha del merge a main que la cerró (el de "Recolección de commits"):

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js estimate-real --story <abs spec.md> --run <sha del merge>
# → { ok: true, linea } · { ok: true, reason: "ya_anotado" } · { ok: false, reason: "sin_horas", motivo }
```

- Las horas no se pasan: salen de la constancia que dejó el `stop` con los segundos que informó la herramienta. Una
  herramienta que informa por una acción no deja segundos, y lo real no se anota (`sin_horas`, con el motivo).
- Reintentar el cierre repite el sha y no duplica la línea (`ya_anotado`); reabrir la historia y volver a cerrarla trae
  otro sha y suma.
- El resultado se dice en una línea y el cierre sigue, salga lo que salga: la estimación nunca frena el cierre.
- La línea queda en el árbol del repo de historias: se suma al commit que se le propone al dev, que pide autorización
  como todo commit.

Formato del output: `Xh YYm` (ej. `4h 32m`). Si la story tomó menos de 1h, mostrar `XX min` (ej. `47 min`).

**Casos a manejar**:

- **Sin tiempo registrado**: log "no se encontró tiempo registrado para esta story". Comment va sin el campo de tiempo. NO inventar duración. NO calcular `merge_date - first_commit` (eso es wall-clock, no trabajo real).
- **Un aviso de la integración** (falta configurar algo, la herramienta no contestó): decirlo en una línea y seguir sin el campo; el cierre no se frena por las horas.
- **El dev quiere overridear el total**: aceptar override manual (ej. "ponele 5h en vez de 4h32m" — el dev sabe si hubo trabajo offline no trackeado).

## Dónde vive el pedido

El paso no arma comandos de ninguna plataforma: le pide a la capa de plataforma
(`node ~/.claude/tycon-harness/scripts/lib/platform/platform.js work-item create|close`). La plataforma la elige el perfil
del equipo (`integrations.platform`); el destino (organización, proyecto o repo, tipo, estados, épicas), la
configuración del repo: `.tycon/work-items.yaml`, o `.tycon/ado-config.yaml` (el nombre viejo, que se sigue leyendo; con
los dos gana el nuevo). En Azure DevOps la organización es la del archivo y, si no la tiene, `ado.org` de la máquina.

**Sin plataforma elegida o sin credencial** la capa contesta `ok: false` con un `summary` de una línea que dice qué falta
y cómo ponerlo: se muestra esa línea, el pedido no se toca y el resto del cierre sigue (exit 0).
**Azure DevOps apagado** (sin `ado.org` en la configuración del arnés ni organización en la del repo) es el mismo caso:
una línea, sin llamar a `az`.

El id, con el lector común (lee `work_item:` y su nombre viejo `ado_work_item:`; una historia vieja con sólo el viejo
se cierra igual): `node ~/.claude/tycon-harness/scripts/lib/platform/work-item-field.js get <story_path>` (sale 3 si no
tiene).

## Creación retroactiva del pedido (cuando la historia no tiene id y el repo tiene configuración)

Disparado por pre-condición 6.a. Cuando la story está `done`/`review`, no tiene id de pedido y el repo tiene su
configuración del pedido de trabajo:

1. **El título**: `Story <id>: <title>`. **La épica**: `epic:` del frontmatter (la capa la cuelga de su Epic si la
   configuración la mapea en `epic_links`; si no, la crea suelta y lo dice en `warnings`).
2. **Crear**:
   ```bash
   node ~/.claude/tycon-harness/scripts/lib/platform/platform.js work-item create \
     --args '{"repoDir": "<repo>", "title": "Story <id>: <title>", "epic": "<epic>", "sprint": <sprint>}'
   # → {"ok": true, "value": {"id", "url", "warnings", "unsupported"}, "summary": "…"}
   ```
3. **Escribir el id** en el frontmatter, con el campo neutro (nadie escribe `ado_work_item`):
   `node ~/.claude/tycon-harness/scripts/lib/platform/work-item-field.js set <story_path> <id>`. NO dispara el hook
   `on-frontmatter-write.js` (no es transición de `status:`/`pipelines.status:`).
4. **Continuar con el cierre normal** (comment + cierre con las horas). El comment anota "**Pedido creado
   retroactivamente** <fecha> (la story se cerró sin la skill de creación)".
5. **Preparar** el commit del frontmatter actualizado y **pedir autorización al dev** antes de
   ejecutarlo — igual que «Preparar el commit», y por la misma regla (`SKILL.md` §"Anti-patterns (lo que NO
   hace)" y `guides/git-commit-conventions.md`: el pipeline NO ejecuta `git commit` ni `git push`
   sin aprobación explícita). Mensaje sugerido: `chore(story-<id>): link work_item`.

**Idempotencia**: si ya existe un pedido para esa story (el dev confirma el id en 6.b), saltear
la creación y usar ese id. NO crear duplicados.

## Acción — postear closing comment

Armar el comment en este formato fijo:

```markdown
**Story cerrada — trazabilidad de implementación**

- **Story spec**: `<story_path>` (status: `done`)
- **Commits que implementaron la story** (<N> commits):
  - `<sha1>` — <subject corto>
  - `<sha2>` — <subject corto>
  - ...
- **CI run que validó** (post-merge a `main`): [<run-id>](<run-url>) — `<status>`
- **PR**: [<pr-id>](<pr-url>) <!-- omitir esta línea si la story se mergeó directo a main -->
- **Tiempo dedicado** (<herramienta de horas>): `Xh YYm` <!-- omitir si no se encontró tiempo registrado -->
- **DoD gate**: ✅ smoke + E2E fail-loud + cross-check
- **Cerrada por**: <dev-name> el <YYYY-MM-DD>

🤖 Cierre automático vía tycon-pipeline close-work-item.
```

Cerrar el pedido con el comment y las horas, en un solo pedido a la capa:

```bash
node ~/.claude/tycon-harness/scripts/lib/platform/platform.js work-item close \
  --args @<run dir>/cierre-pedido.json
# cierre-pedido.json: {"repoDir": "<repo>", "id": <id>, "comment": "<comment-text>", "hours": <horas>}
# → {"ok": true, "value": {"id", "hours", "hoursAs", "unsupported", "warnings"}, "summary": "…"}
```

La capa postea el comment, pasa el pedido al estado cerrado (`state_closed` de la configuración; por defecto `Closed`) y
carga las horas donde la plataforma las tiene: en Azure DevOps, en el campo de horas completadas (`CompletedWork`, en
**horas**; NUNCA en `Effort`, que son story points), en la misma invocación que el estado; en GitHub, como un comentario
de formato fijo («Horas completadas: N h»), porque un issue no tiene ese campo (`hoursAs: "comment"`).

### 🔴 Las horas, MANDATORY

**Cerrar el pedido SIN cargar las horas es un cierre incompleto.** `hours` sale de "Recolección de tiempo: el aviso de
trabajo" (`pipeline.js work-signal stop`, ya en horas). Sin tiempo registrado, `hours` no se manda (no inventar un
valor) y el `summary` dice «sin horas».

### 🔴 La línea del cierre llega al dev

El `summary` de la capa va TAL CUAL al mensaje de cierre al dev (sección «Output»), no sólo al registro: dice dónde
quedaron las horas (en el campo, o como comentario cuando la plataforma no tiene el campo) y lo que la plataforma no
soporta (`no soportado en GitHub: …`). Así nadie cree que se cargaron horas o campos que no se cargaron.

**Un «no» no frena el cierre**: `ok: false` (sin plataforma, sin credencial, el pedido no existe, la plataforma lo
rechazó) → la línea del `summary` y seguir con el resto del cierre; el pedido queda como «acción pendiente» en el
mensaje final.

## Acción — cerrar el registro de horas (2026-05-13)

El registro de la story se cierra con el mismo `work-signal stop` de "Recolección de tiempo: el aviso de trabajo": la
integración cierra su entrada abierta en ese momento (o, si la maneja el agente, se lo pide en `action`, con el fin
ahora). No hay un segundo paso: la story está done y no hay más trabajo lógico.

**Casos a manejar**:

- **No había nada abierto**: la integración no tiene nada que cerrar; no es error.
- **Algo abierto en OTRA carpeta o sesión**: la integración no lo toca — pertenece a otro flujo.
- **La herramienta falla** (red, 401): un aviso de una línea, NO bloquear el cierre del step. La trazabilidad ADO queda
  posteada igual; lo abierto lo cierra el cierre por inactividad de la integración.

**Por qué el fin es ahora y no la última actividad**: el cierre por inactividad usa la última actividad para no contar
tiempo quieto (detecta abandono). Acá el cierre es **explícito por finalización del trabajo** — el dev acaba de pasar la
story a `done`, todo el tiempo hasta ahora es trabajo real.

## Acción — setear `status: done` en el frontmatter (MANDATORY fix robusto 2026-05-20)

Tras postear el comment en ADO y transicionar el WI a `Closed`, **mutar el frontmatter de la story a `status: done`**. Source of truth durable cross-sesión:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js update-story-status \
  "$STORY_PATH" "done"
```

**Idempotente** — si el dev ya lo seteó manual a `done` antes de invocar este cierre, el comando re-escribe el mismo valor sin error.

**Garantiza** que el cierre ADO y el frontmatter quedan en lockstep. Una sesión futura que abra `tycon-pipeline` sobre esta story va a leer `done` y NO va a re-arrancar el pipeline (PIPE-C5 del Arranque lo detecta y rechaza).

## Acción — llevar el `done` a main

`update-story-status` deja el cambio en el disco; sin esto, el work item queda cerrado y la story en main sigue en
`review`. El cambio nace después del merge (`done` es «en main y desplegado»), así que su commit es parte del cierre,
no un olvido.

**La autorización es la del checkpoint del cierre.** El punto 1 de abajo corre ANTES de ese checkpoint: cuando se le
muestra al dev la lista de commits para el comentario, ese mismo mensaje dice que el cierre va a commitear el `done` y
llevarlo a main, y lo que contestó el guion sobre la CI. Su ok cubre el comentario, el cierre del work item y este commit:
no se pregunta de nuevo. Sin ese ok, el pipeline no commitea ni empuja nada (regla de `guides/git-commit-conventions.md`).

1. **¿Dispara la CI?** Antes de commitear, con `origin` recién traído (el guion lee `origin/main`) y el archivo de la
   story relativo a la raíz del repo, se lo pregunta al guion, no a la memoria:

   ```bash
   git -C <repo> fetch origin
   node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/ci/check-trigger-without-docs.js" \
     --repo <repo> --changed <ruta de la story>
   ```

   Sale 0 → «no dispara la CI»; 1 → «dispara la CI» con el pipeline y el patrón que dio; 2 → «no pude saber si dispara
   la CI», con el motivo. Una salida 2 nunca se dice como «no dispara». El guion habla del CI que corre al entrar a
   `main` y sólo ve los `azure-pipelines*.yml`; si el repo tiene un pipeline creado en la web, o la validación de pedidos
   de su política de rama, eso corre aparte y se dice así.
2. **El commit, en una rama propia desde `origin/main`**, nunca en el checkout del dev (puede tener trabajo ajeno):

   ```bash
   git -C <repo> worktree add -b chore/<id>-done <carpeta-temporal> origin/main
   # la story de main contra la del checkout: sólo puede cambiar el status
   git -C <carpeta-temporal> diff --no-index -U0 <ruta de la story> <story en el checkout> | grep '^[-+][^-+]'
   cp <story en el checkout> <carpeta-temporal>/<ruta de la story>
   git -C <carpeta-temporal> add <ruta de la story>
   git -C <carpeta-temporal> commit -m "docs(specs): <id> — status done"
   git -C <carpeta-temporal> push -u origin chore/<id>-done
   ```

   Se copia sólo el archivo de la story. Si la comparación muestra algún renglón distinto de `status:` (o del `Status:`
   del cuerpo), se para y se le muestra la diferencia al dev: copiar el archivo entero pisaría lo que haya en main.
3. **El camino a main es el del repo**: el que da `merge-pr.js plan` (el mismo de `/tycon-merge-to-main`). En modo `pr`
   sobre Azure DevOps, un pedido con `--auto-complete true --squash false`; en GitHub, un pedido a la fila; en modo
   `push`, el empuje directo de la rama a `main`. Después, se borra la carpeta temporal y su rama local.
4. **Sin el ok del dev**, o si algo de lo anterior falla: no se dice «status: done» como si estuviera en main. El
   mensaje final lo deja como **acción pendiente**, con los comandos de arriba ya armados para esa story.

**Después de esto, `marker.js clear`** para limpiar el marker per-session de esta sesión:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js clear
```

(Si «Preparar el commit» ya lo había cleaneado y este cierre viene independiente, el clear acá es no-op silencioso.)

## Acción — borrar las carpetas de trabajo de la story (2026-10-16)

Último paso del cierre: las carpetas de trabajo (worktrees) de la story que ya están mergeadas se borran, con su rama
local. Pedido del dueño: ese día había 30 carpetas `<repo>-wt-*` en una máquina y 28 ya estaban mergeadas.

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/hooks/worktree-sweep.js" --story <N.M>
```

Trae origin en cada repo conocido y mira las carpetas cuya rama nombra la story (`feat/<N.M>-a-…`, `story/<N>-<M>`). Borra
(`git worktree remove` sin `--force` + `git branch -d`) sólo las **limpias y con su HEAD ya en origin/main**. Las que
tienen cambios, commits sin mergear, están bloqueadas o son el cwd de esta sesión las **nombra y no las toca**: esas
líneas van tal cual al mensaje final, para que el dev decida. Nunca toca el checkout principal. Con
`TYCON_WORKTREE_SWEEP=0` no hace nada. Para lo que no pasa por el pipeline, el mismo guion corre al arrancar sesión una
vez por día (`guides/git-worktrees.md` §7).

## Output

Mensaje al dev al final:

```
✅ Story <id> cerrada.
- Pedido de trabajo: <url del pedido>
- <el `summary` de la capa, tal cual: «pedido de trabajo #<id> cerrado en <plataforma> · <horas y dónde> · no soportado: …»>
- Comment posteado con: <N> commits + CI run #<run-id> + PR <pr-id-o-N/A> + tiempo <Xh YYm>
- Registro de horas cerrado: duración total <Xh YYm>   (omitir línea si no había herramienta ni tiempo registrado)
- Story → status: done: commit <sha> · <«en main» si se empujó directo | «pedido <n>, entra solo» si quedó en un pedido> · CI: <no dispara | dispara <pipeline> | no pude saber si dispara la CI (<motivo>)>
  (sin el ok, o si falló: «acción pendiente: llevar el done a main» con los comandos ya armados)
- Marker pipeline → cleared.
- Carpetas de trabajo: <lo que dijo worktree-sweep.js — borradas, o las que quedaron y por qué>

Listo.
```

## Anti-patterns

- ❌ NO postear el comment ANTES del merge a main — los SHAs y CI run no están disponibles aún.
- ❌ NO inventar SHAs ni CI runs. Si no podés obtenerlos automáticamente, preguntá al dev.
- ❌ NO transicionar state sin postear comment — el comment es la evidencia de auditoría.
- ❌ NO postear comment sin confirmar la lista de commits con el dev — falsos positivos del grep llenan ADO de basura.
- ❌ NO cerrar work items que NO sean User Story (Epic, Feature, Task siguen reglas distintas — este step es específico a stories).
- ❌ NO ejecutar este step sobre una story en `ready-for-dev` o `in-progress` — es señal de que el flujo no completó «Preparar el commit». `review` (lo normal, después de «Preparar el commit») y `done` (si el dev ya lo movió a mano) son los DOS estados válidos de entrada, y están en la pre-condición 5.
- ❌ NO inventar `time_tracked` cuando la herramienta de horas no informa tiempo. Mejor omitir el campo que postear un número fabricado — la trazabilidad de horas es billing-grade.
- ❌ NO usar wall-clock (`merge_date - first_commit_date`) como sustituto del tiempo registrado. Eso es lead time, NO trabajo real.

## Por qué existe

El nivel de trazabilidad que se deja al cerrar es commit SHA(s) + CI run + PR link, como mínimo regulatorio (hay clientes con requirements de auditoría). El step está documentado acá para que sea consistente entre stories y no dependa de la memoria del dev.


## Timing dump del run (automático desde 2026-06-11)

`marker.js clear` (el cierre del pipeline) archiva automáticamente el marker completo +
los gates de la sesión en `~/.claude/.tycon-pipeline/timing-history/<storyId>-<ts>.json`
y una copia en `<repo>/.advisors/pipeline-runs/<run>/timing-dump-<ts>.json` — la curva de
costo por run (steps, iteraciones, gates con duración) sin auditoría forense. Citarlo en
el comment de cierre de ADO / la retro si el run fue anómalo. `pipeline.js timing-report`
sigue disponible para el desglose human-readable DURANTE la corrida.
