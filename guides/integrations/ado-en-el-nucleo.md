# Azure DevOps en los textos del núcleo

Los textos del núcleo (guías, pasos, skills y comandos) hablan de la plataforma del equipo: el pedido de trabajo, el
pedido de cambio, la CI. Lo que es sólo de Azure DevOps —sus comandos, sus direcciones, sus campos— vive acá, cada
cosa con el texto que la nombra; el de GitHub, en `github-platform.md`. Cada sección trae los renglones tal como
estaban en ese texto: quien lo sigue con Azure DevOps viene acá y los usa igual.

## Abrir el pedido de cambio: Azure DevOps

De `skills/tycon-merge-to-main/steps/step-09b-create-change-request.md`:

- **Azure DevOps**: la misma secuencia de `az repos pr` de siempre (reusa el pedido abierto de ese par de ramas o lo
  crea, fija el mensaje de merge «Merged PR N: asunto», prende el auto-completar sin aplastar y lo verifica releyendo
  el pedido). El modo es siempre `auto`: el servidor lo completa cuando sus políticas dan verde.

## Abrir el pedido de cambio: los frenos

De `skills/tycon-merge-to-main/steps/step-09b-create-change-request.md`, lo que miran los frenos antes de publicar:

`--auto-complete` va siempre en la línea: sin él la capa no abre, y los frenos lo leen ahí. Los frenos de antes de
publicar miran esta línea igual que un `az repos pr create` o un `gh pr create`: uno por repo con el control de otro
pedido corriendo, la retrospectiva pendiente al apuntar a `main`. En GitHub, el conector pasa además el título y el

## Cerrar la historia: la corrida de la CI después del merge

De «Recolección de CI run» en `skills/tycon-pipeline/steps/close-work-item.md`:

# Azure DevOps Pipelines:
az pipelines runs list --organization https://dev.azure.com/<org> --project <project> \
  --branch main --top 5 --query "[?contains(sourceVersion, '<merge-sha>')].{id:id, status:status, result:result, web:_links.web.href}"

## El Arranque: buscar el pedido de trabajo por título

Del paso 1 de «el pedido de trabajo» en `skills/tycon-pipeline/steps/step-01-start.md`, después de `platform.js choose work-item update` con `azure-devops`:

   ```bash
   az boards query --organization <ado_org> --project <ado_project> --output json \
     --wiql "SELECT [System.Id], [System.Title], [System.State] FROM workitems WHERE [System.TeamProject] = '<ado_project>' AND [System.Title] CONTAINS '<story_id>'"
   ```

## El catálogo de reglas: BANCO-C1

La fila de `guides/advisor-rules-catalog.md`, con su ejemplo de Azure DevOps:

| **BANCO-C1** | El doble de un servicio externo **ignora un filtro** que el código real sí usa, así que el caso no puede reproducir el defecto | Honrar en el doble los parámetros de los que depende la decisión (ejemplo: `--status` de `az repos pr list`) |

## El catálogo de reglas: DODRT-C2

La fila de `guides/advisor-rules-catalog.md`, con su heurística de Azure DevOps:

| **DODRT-C2** | CI run post-push no verificado — commit pusheado pero no hay evidencia de que CI pasó verde. Heurística: `az pipelines runs list --branch <branch> --query "[?triggerInfo.\"ci.sourceSha\"=='<sha>']"` o `gh run list --commit <sha> --json conclusion`. Si vacío → CRITICAL (puede ser FRESNO-pattern: trigger no fired); si `failed` → CRITICAL | (a) verificar `azure-pipelines.yml` triggers matchean paths del diff; (b) si FRESNO-pattern, agregar commit trivial sobre `.cs` para forzar trigger; (c) re-correr advisor cuando CI termine |

## El portón de la CI: los dos permisos

De `guides/ci-gate.md`:

## 🔴 Los DOS permisos que hay que dar en Azure DevOps — y el segundo NO da error claro

Copiar el YAML
no alcanza: el pipeline necesita **dos** permisos distintos sobre el arnés, y
si falta cualquiera de los dos el run se cae de una manera que no dice qué le falta.

**(1) Autorizar el RECURSO para ese pipeline.** Sin esto el run queda con un `Checkpoint` en
`inProgress` y **ninguna etapa arranca** — el tablero muestra todo en `pending` sin un solo
mensaje de error. Se guarda en el proyecto que CONSUME (no en el del arnés):

```
PATCH /{proyecto-que-consume}/_apis/pipelines/pipelinePermissions/repository/{projIdArnes}.{repoIdArnes}?api-version=7.1-preview.1
{"pipelines":[{"id":<id del pipeline>,"authorized":true}]}
```

**(2) Dar LECTURA del repo del arnés a la identidad de compilación del proyecto.** Éste es el que
sorprende: con el (1) puesto, el checkpoint pasa y el run arranca… y muere en
`Checkout tycon-claude-guides@main to tcg` con `Git fetch failed with exit code 128`. Ese 128 no
dice "te falta un permiso": parece un problema de red o de rama.

La identidad es una por proyecto y su descriptor se arma solo:
`Microsoft.TeamFoundation.ServiceIdentity;<collectionId>:Build:<projectId>`. Se le da el bit
`2` (GenericRead) sobre `repoV2/{projIdArnes}/{repoIdArnes}` en el espacio de nombres
`2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87` (Git Repositories), vía
`POST /_apis/accesscontrolentries/{ns}`.

Para verificar de antemano: listar quién tiene lectura sobre ese token y contar. Al 2026-09-01 son
**siete** identidades de compilación, una por producto que consume el arnés. Si el proyecto nuevo
no está en esa lista, va a fallar — antes de correr nada.

### El permiso del BUMP, que es otro y va ANTES de la política

Los pipelines que suben el número de versión pushean a `main`. Al poner la política de rama, ese
push queda bloqueado y **todos los builds de main se ponen rojos**. La salida es darle a esa misma
identidad de compilación el bit `128` (*saltear políticas al pushear*) sobre el repo de código.
Verificación: sobre cada repo tiene que haber **exactamente una** identidad con ese bit.
Hacerlo **antes** de crear la política, no después.


## El portón de la CI: permisos entre proyectos

De `guides/ci-gate.md`:

## Permisos cross-project — con el scope de jobs CERRADO (medido en un producto del equipo, 2026-08-31)

El portón clona el repo de guías, que vive en **otro proyecto** de ADO. Hay dos caminos para que el
job pueda hacerlo, y el equipo eligió el cerrado:

| | Scope abierto (`enforceJobAuthScope: false`) | **Scope cerrado (`true`) — el elegido** |
|---|---|---|
| Identidad del job | `Project Collection Build Service` (toda la org) | `<Proyecto> Build Service (org-del-equipo)` (solo el proyecto) |
| Clonar el repo de guías | anda solo | Read (bit 2) sobre el repo **+ membresía en `[tycon-claude-guides]\Readers`** — el Read solo da `TF401019 … does not exist or you do not have permissions` |
| Push del bump a `main` (bypass de políticas) | `PolicyExempt` (128) en `refs/heads/main` alcanza | `PolicyExempt` (128) **a nivel repo** (`repoV2/<proj>/<repo>`) — el de rama solo NO alcanza: da `TF402455`, y verde a los minutos del grant de repo |
| Feed de Pacara | reader | reader a la identidad de proyecto (ya estaba) |

Cómo se aplica (namespace `Git Repositories` = `2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87`; el `Content-Length: 0`
es obligatorio en el PUT de membresía — sin él, 411):

```bash
SUBJ="Microsoft.TeamFoundation.ServiceIdentity;c0000000-0000-4000-8000-00000000000c:Build:<projectId>"
# 1) Readers del proyecto de guías (Graph API; descriptor svc.* del Build Service vía graph/subjectquery)
curl -u ":$PAT" -X PUT -H "Content-Length: 0" \
  "https://vssps.dev.azure.com/org-del-equipo/_apis/graph/memberships/<svc.descriptor>/<vssgp.Readers de tycon-claude-guides>?api-version=7.1-preview.1"
# 2) Read sobre el repo de guías + PolicyExempt a nivel repo en el propio proyecto
curl -u ":$PAT" -X POST -H "Content-Type: application/json" \
  "https://dev.azure.com/org-del-equipo/_apis/accesscontrolentries/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87?api-version=7.1" \
  -d '{"token":"repoV2/<projId>/<repoId>","merge":true,"accessControlEntries":[{"descriptor":"'"$SUBJ"'","allow":128,"deny":0}]}'
# 3) Cerrar el scope
curl -u ":$PAT" -X PATCH -H "Content-Type: application/json" \
  "https://dev.azure.com/org-del-equipo/<Proyecto>/_apis/build/generalsettings?api-version=7.1" -d '{"enforceJobAuthScope": true}'
```

Verificación: `GET _apis/accesscontrollists/<ns>?token=…&includeExtendedInfo=true` (el `effectiveAllow` de la
identidad tiene que incluir el 128), y un run de `main` que pushee el bump. 🔴 Para re-probar el bump NO
sirve reintentar el stage Build de un run que ya publicó artefacto ("Artifact … already exists for build N"):
encolar un run nuevo.


## El portón de la CI: validar una rama del arnés

De `guides/ci-gate.md`:

### Validar una rama del arnés en Azure (2026-10-05)

```bash
node scripts/ci/queue-validation.js              # la rama actual, con el pipeline declarado para el repo
node scripts/ci/queue-validation.js --dry-run    # qué cortaría y qué encolaría, sin tocar nada
```

El pipeline sale de la configuración: el `full_tests_pipeline` del repo en `team-repos.json`
(`merge_suites.repos[]`, el número de la definición de Azure), o `--pipeline <número>`. Sin ninguno de los dos no
encola nada y sale 2 con la línea que hay que declarar.

En lugar de `az pipelines run --id <número> --branch <rama>`: antes de encolar, corta las validaciones de **esa misma
rama** que todavía no terminaron (la nueva prueba lo mismo y más) y borra sus pedidos que esperan carril. Las de otras
ramas no las toca. Si no puede leer la lista, no corta ni encola nada (sale 2). Por qué: con 4 carriles para toda
la organización, varias sesiones validando a la vez traban la fila de Azure.

En esa validación, las suites largas (`scripts/ci/heavy-suites.json`: la copia pública de verdad, la máquina limpia y
las ~18 del instalador) corren sólo si el cambio toca lo que miden; el banco nocturno las corre siempre.

---



## El revisor de retrospectivas: la CI de un repo

De `agents/tycon-retrospective-capturer.md`, cuando el repo vive en Azure DevOps:

   - si el repo expone el estado de su CI (`az pipelines runs list`, `gh run list`): un run **failed**
     sobre la rama de integración dentro de la ventana. 🔴 La ausencia de un run en el LISTADO no es
     evidencia de que no existió (el listado laguea minutos) — ver la regla ADO del `CLAUDE.md`.

## El tablero (`/tycon-dashboard`): lanzarlo y seguirlo

Del punto 1 de `commands/tycon-dashboard.md`, con `operations.platform` en `azure`:

**azure** (`ORG=https://dev.azure.com/<org>`, `PROJ=<project>`, `REPO=<repo>`):

```bash
# el proceso es el del repo de operaciones cuyo YAML es pipelines/team-dashboard.yml (no se adivina por el nombre)
for id in $(az pipelines list --org "$ORG" --project "$PROJ" --repository "$REPO" --repository-type tfsgit --query "[].id" -o tsv < /dev/null); do
  [ "$(az pipelines show --org "$ORG" --project "$PROJ" --id "$id" --query process.yamlFilename -o tsv < /dev/null)" = "pipelines/team-dashboard.yml" ] && echo "def=$id"
done
# ¿ya hay una corrida en marcha? Entonces se sigue ésa: no se encola otra
az pipelines runs list --org "$ORG" --project "$PROJ" --pipeline-ids "$DEF" --top 5 --query "[?status!='completed'].id" -o tsv < /dev/null; echo "rc=$?"
# si no hay ninguna:
az pipelines run --org "$ORG" --project "$PROJ" --id "$DEF" --branch main --query id -o tsv < /dev/null; echo "rc=$?"
```

Si no aparece ningún `def=`, decí que el repo de operaciones no tiene dado de alta el proceso del tablero
(`pipelines/team-dashboard.yml`) y seguí con el punto 2. Si encolar falla, decí el error tal cual: no reintentes.

Seguí la corrida **de fondo** (en Claude Code, Bash con `run_in_background`), con un tope de 40 minutos:

```bash
for i in $(seq 1 120); do
  R="$(az pipelines runs show --org "$ORG" --project "$PROJ" --id "$RUN" --query "[status,result]" -o tsv < /dev/null)" || { echo "NO PUDE MIRAR la corrida $RUN"; exit 2; }
  case "$R" in completed*) echo "terminó: $R"; exit 0 ;; esac
  sleep 20
done
echo "SIGUE CORRIENDO después de 40 minutos: corrida $RUN"; exit 3
```

## El tablero (`/tycon-dashboard`): traer la página sin clon

Del punto 1 de `commands/tycon-dashboard.md`, adentro del bloque que trae la página de `main` del repo de operaciones:

# sin clon, Azure:
az devops invoke --org "$ORG" --area git --resource items --route-parameters project="$PROJ" repositoryId="$REPO" \
  --query-parameters path=/artifacts/tablero-del-arnes.html versionDescriptor.version=main versionDescriptor.versionType=branch download=true '$format=octetStream' \
  --api-version 7.1 --accept-media-type application/octet-stream --out-file "$DIR/tablero-del-arnes.html" -o none < /dev/null; echo "rc=$?"

## El vigilante (`/tycon-vigilante`)

De `approve <id>` en `commands/tycon-vigilante.md`:

> **Mirá primero si hay un PR abierto de ese hallazgo** (`az repos pr list --source-branch
> vigilante/<id>`). El nocturno abre un PR por hallazgo y **ahí es donde se decide**: mergearlo

## La orquestación: el trigger que no matchea

De `guides/workflow-orchestration.md`, cómo se verifica en Azure DevOps:

`azure-pipelines.yml` nuevo con `paths.include` que cubre `*/src/**` y poco más, y un commit
legítimo que se mergea a `main` **sin que corra un solo pipeline** — sin error, sin aviso, porque
un trigger que no matchea no falla: no existe. Un commit que arregla un bug real de
`shared/` entra sin CI; se verifica con `az pipelines runs show` (el commit no aparece en NINGÚN
run). Y cada vez se redescubre desde cero.

## La skill de creación (`tycon-story-work-item`): lo que pide

De las pre-condiciones de `skills/tycon-story-work-item/SKILL.md`:

- `az` CLI instalado con la extensión `azure-devops` (`az extension add --name azure-devops`).
- `AZURE_DEVOPS_EXT_PAT` exportada (token con scope **Work Items: Read & Write**). Es la
  misma variable que usan los pasos «Arranque» y «Cerrar la historia» del pipeline.

## La skill de creación (`tycon-story-work-item`): los pasos 1 a 3

De `skills/tycon-story-work-item/SKILL.md`, los tres pasos antes de confirmar con el dev:

## Paso 1 — Resolver la config ADO del repo

Mismo orden de prioridad que `tycon-pipeline/steps/step-01-start.md` y
`step-09`. Walk-up desde la story `.md` hasta encontrar el root del repo
(`.git/` o `.tycon/`):

1. **`.tycon/ado-config.yaml`** en el root del repo — fuente de verdad preferida (un repo de
   cliente puede vivir en otra organización).
2. **La configuración del arnés** — `ado.org`:
   `node ~/.claude/tycon-harness/scripts/lib/tycon-config.js get ado.org` (lee `TYCON_ADO_ORG`,
   `~/.claude/tycon.json` y el perfil del equipo, en ese orden; exit 3 = sin organización; exit 2 =
   configuración rota, y se dice con archivo, clave y motivo). El project: `TYCON_ADO_PROJECT`, o
   preguntar al dev.
3. **Sin organización = Azure DevOps apagada en esta máquina** — decirlo en UNA línea («Azure DevOps
   apagado en esta máquina — el work item no se crea; prender: ado.org en ~/.claude/tycon.json o
   TYCON_ADO_ORG»), no llamar a `az` y terminar bien. Ya no hay un nivel «tabla por proyecto».

Schema completo de `.tycon/ado-config.yaml` (ver también `~/.claude/tycon-harness/guides/integrations/ado-projects.md`):

```yaml
ado_org: https://dev.azure.com/<organizacion>
ado_project: Ceibo
ado_wi_type: ""                 # opcional — override del tipo de WI. Vacío = auto-detectar.
ado_area_path: "Ceibo"         # opcional — default = nombre del project.
ado_iteration_path: ""          # opcional — override LITERAL del iteration. Si está seteado, pisa la auto-derivación desde `sprint:` del frontmatter.
ado_iteration_root: ""          # opcional — root del template Sprint N. Default = `ado_project` (ej "Ceibo"). Combinado con `sprint:` del frontmatter da `<root>\\Sprint <N>`.
ado_iteration_auto_from_frontmatter: true  # opcional — default true. Si la story tiene `sprint: N` en el frontmatter, setea automáticamente `IterationPath=<root>\\Sprint <N>`. Override con `ado_iteration_path` literal o flag en `false`.
ado_state_active: "Active"      # consumido por «Arranque» del pipeline
ado_state_closed: "Closed"      # consumido por «Cerrar la historia»
ado_auto_assign: false          # si true, asigna el WI a git config user.email
ado_default_tags: "tycon-pipeline"  # opcional — tags separados por ;
epic_links:                     # opcional — mapeo epic (frontmatter) → WI id del Epic/Feature en ADO
  1: 12001
  2: 12002
  3: 12003
```

**Si la config NO resuelve por ninguna vía** → log "tycon-story-work-item: repo sin config ADO,
WI no creado para story <id>" y terminar. No es error: hay repos TYCON que no trackean en ADO.

Si la config resuelve por env vars o por respuesta del dev (no por archivo), **ofrecer crear
`.tycon/ado-config.yaml`** con lo resuelto para que las próximas corridas no pregunten.

---

## Paso 2 — Auto-detectar el tipo de work item

Si `ado_wi_type` está seteado en la config → usar ese valor, saltar la detección.

Si no, detectar por process template del project:

```bash
process=$(az devops project show \
  --organization <ado_org> --project <ado_project> \
  --query "capabilities.processTemplate.templateName" --output tsv)
```

⚠️ Los projects TYCON suelen usar un nombre de process **custom** derivado de un base
process — ej: Ceibo reporta `Ceibo Scrum`, no `Scrum`. Por eso el mapeo es por
**substring case-insensitive**, NO por igualdad exacta:

| Si el nombre del template contiene… | Tipo de WI | `ado_state_active` | `ado_state_closed` |
|---|---|---|---|
| `Scrum` | `Product Backlog Item` | `Committed` | `Done` |
| `Agile` | `User Story` | `Active` | `Closed` |
| `CMMI`  | `Requirement` | `Active` | `Closed` |
| `Basic` | `Issue` | `Doing` | `Done` |
| (ninguno matchea) | preguntar al dev + sugerir fijar `ado_wi_type` en la config | — | — |

Si la detección falla (token, red, nombre no mapeable) → preguntar al dev el tipo y sugerir
fijarlo en `ado_wi_type` de la config. El CLI no lista los tipos de WI directo; si hace
falta enumerarlos: `az devops invoke --area wit --resource workitemtypes --route-parameters
project=<project> --organization <ado_org>`.

---

## Paso 3 — Armar los campos del WI desde la story

Parsear el frontmatter + cuerpo de la story `.md`:

| Campo ADO | Origen en la story |
|---|---|
| `System.Title` | `Story {story}: {title}` del frontmatter (ej: `Story <N.M>: POST /voice/calls ...`) |
| `System.Description` | el bloque `## Story` (el "Como X, quiero Y, para Z") + una línea `Spec: <ruta de la story .md>` |
| `Microsoft.VSTS.Common.AcceptanceCriteria` | la sección `## Acceptance Criteria` completa, convertida a HTML simple (los campos rich-text de ADO son HTML) |
| `Microsoft.VSTS.Common.Priority` | mapear `priority` del frontmatter: `P0`→`1`, `P1`→`2`, `P2`→`3`, `P3`→`4` |
| `System.AreaPath` | `ado_area_path` de la config (o el project) |
| `System.IterationPath` | ver "Resolución del IterationPath" abajo |
| `System.Tags` | `ado_default_tags` de la config + `sprint-{N}` si la story tiene `sprint:` |

Notas:
- Los campos rich-text (`Description`, `AcceptanceCriteria`) son **HTML** en ADO. Convertir
  el markdown a HTML básico: párrafos `<p>`, listas `<ul><li>`, `<br>` para saltos. No hace
  falta nada sofisticado — preservar el texto y la estructura de lista.
- Escapar comillas en los valores antes de pasarlos a `--fields`.

### Resolución del IterationPath (orden de prioridad)

Para evitar que los WIs caigan en el backlog general cuando la story ya declara su sprint en el frontmatter (`sprint: N`), aplicar este orden:

1. **`ado_iteration_path` de la config** — si está seteado (string literal no vacío), usar **textual** ese valor. Es el override más fuerte (útil para sprints con nombre custom o casos especiales).
2. **Auto-derivar desde `sprint:` del frontmatter** — si `ado_iteration_auto_from_frontmatter` es `true` (default) **y** la story tiene `sprint: N` en el frontmatter (entero), construir el path:
   ```
   <ado_iteration_root o ado_project>\Sprint <N>
   ```
   Ej: con `ado_iteration_root="Ceibo"` (o `ado_project="Ceibo"`) y `sprint: 5` → `Ceibo\Sprint 5`. Asume convención TYCON `Sprint <N>` como nombre del iteration (verificable con `az boards iteration project list --project <p>`).
3. **Si nada de lo anterior aplica** → omitir el campo (cae en backlog general del project).

**Best-effort de validación**: si la auto-derivación produce un path, una vez por sesión chequear que el iteration exista (`az boards iteration project list --project <p>`). Si NO existe, fallback a backlog + warning al dev. NO bloquear creación del WI.

**Tag `sprint-<N>` sigue agregándose** independientemente del IterationPath resuelto — el tag es trazabilidad spec-side, el IterationPath es scheduling-side. Pueden divergir si el WI se mueve en ADO sin actualizar la spec.

**Por qué**: con `ado_iteration_path: ""` en la config, un WI cae en el backlog (`IterationPath=<proyecto>`) aunque la story tenga `sprint: <N>` en el frontmatter, y hay que moverlo a mano con `az boards work-item update --iteration "<proyecto>\Sprint <N>"`. Resolver el IterationPath desde el sprint de la story cierra ese gap.

---


## La skill de creación (`tycon-story-work-item`): no duplicar

De los anti-patterns de `skills/tycon-story-work-item/SKILL.md`:

- ❌ NO duplicar: antes de crear, si la config resuelve, considerar una `az boards query` por
  el story id en el título (igual que el respaldo de «Arranque») — si ya existe un WI para
  esa story, proponer linkear ese en vez de crear uno nuevo.

## Las convenciones de git: borrar la rama al mergear

De `guides/git-commit-conventions.md`, para un pedido a `main` armado a mano en Azure DevOps:

- **Azure DevOps**: un pedido a `main` armado a mano con auto-completar dice explícito si borra la rama:
  `--auto-complete true --squash false --delete-source-branch true`. `false` sólo desde una rama de larga vida (`dev`,
  `develop`, `main`, `master`, la lista de §9b.4 del paso de merge), y escrita en `--source-branch`; `true` desde una
  de esas ramas la borraría. Un `az repos pr update` no dice la rama de origen: para publicar un borrador va
  `--delete-source-branch false`, y con `true` el freno frena. El freno de pedidos lo exige; el skill de merge ya lo
  hace solo.
