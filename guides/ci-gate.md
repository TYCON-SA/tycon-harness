# El portón de CI — lo que igual se verifica cuando el commit ya llegó al servidor

> ## ✅ Estado: ADOPTADO Y **BLOQUEANTE** en el piloto (frontend y backend de un producto del equipo, 2026-08-30)
>
> Con "un solo dev, siempre en la misma máquina, con el arnés puesto", un control cuyo caso no
> existe es ceremonia. El portón se adopta porque **el equipo son varias personas, a veces sobre
> el mismo proyecto**.
>
> **Bloqueante desde el primer día**, no en modo aviso: en modo aviso, si el portón no puede ni
> arrancar (un permiso), el merge pasa igual, con apariencia de control instalado. "No pude ni
> arrancar" y "corrí y avisé" son resultados distintos, y el aviso no los distingue.
>
> ## ✅ Rollout COMPLETO en los cuatro productos (2026-08-31) — **13 repos**
>
> Totora, Ceibo, URUTAU y Lapacho, código **y especificaciones**. Cobertura medida:
> **33 de 470 stories → 470 de 470**.
>
> 🔴 Ese salto no es del rollout: es de haber corregido **dónde** estaba instalado. Ver la
> trampa (c) más abajo — el portón llevaba un día instalado y vigilaba el 7% de las stories.

## Qué chequea — y por qué sólo esto

`scripts/ci/tycon-ci-gate.js`, 0 dependencias, sin red, sin modelo. Únicamente lo que se puede
decidir **con el repo y nada más**: un control que necesita el estado de la sesión
(`~/.claude/…`), la base de engram o un servidor local **no puede correr acá**, y fingir que sí
sería peor que no tenerlo.

| Chequeo | Qué atrapa |
|---|---|
| **Frontmatter legible** | Una story cuyo frontmatter no cierra. Las tools del arnés no dan error con eso: la **saltean en silencio** (medido en un producto del equipo: 4 stories invisibles durante 2 meses, una tapando una deuda de evidencia). |
| **Evidencia de cierre** | Una story que pasa a `review`/`done` sin su `.advisors/dod-runtime/<id>-*.md` **en el repo** (un `.md` real: la matriz por AC, el self-audit y el plan manual no cuentan — 2026-09-05). Es la mitad del gate local que no depende de la sesión. Si el código vive en otro repo, la evidencia igual nace acá: ver §"Stories en un repo, código en otro". Escape declarado: `dod_runtime_exempt: true` + razón, que lo decide la persona (el arnés le pide la firma `marker.js sign-file dod_runtime_exempt <historia>` en cualquier estado, también al crear la story). |
| **Constancia de revisores** | Una story que pasa a `done` sin una corrida del pipeline en el repo (`.advisors/pipeline-runs/<id>-…`). Es el ADVISORS-GATE del pre-commit en su mitad verificable desde el servidor (la otra mitad vive en el `gates.log` local). Escape: `advisors_exempt: true` + razón. |

| **Índice de memoria** (2026-09-17) | Un cambio que deja la memoria de engram a medio declarar: entradas que la rama base declara y este cambio ya no, o archivos de memoria nuevos sin entrada. `engram sync --import` lee el ÍNDICE, no la carpeta, así que un archivo sin entrada **no existe para las demás máquinas y no da error**; y una entrada perdida no vuelve sola. Mismo criterio que el freno del commit (`scripts/lib/manifest-engram.js`) y misma asimetría: lo que este cambio ROMPE frena, lo heredado y lo no comparable avisan. Sólo lee algo si el diff toca `.engram/`. **Acá importa especialmente**: es lo único que ve los commits hechos fuera del asistente — la web de Azure, otra máquina, un hook salteado. |
| **Registro de autoría** (2026-08-30) | Una story que pasa a `done` sin decir **quién la implementó y quiénes la revisaron** — o diciéndolo mal. Es la respuesta del arnés al *play* del playbook "que un revisor con IA mire cada PR en CI": acá la revisión ya ocurre antes del PR y con más contexto, así que en vez de re-revisar en el servidor se **verifica** que la hizo otro. Frena si: falta el `review-roster.json` del run (a partir del corte), si el que implementó figura como revisor, o si el archivo no se puede leer. **Un advisor con hallazgos que el registro no lista AVISA y no frena desde el 2026-09-22**: en sus dos apariciones falló la regla y no lo que vigila —una vez con las fuentes que escribe el propio pipeline; otra, con la vuelta o el modelo pegados al nombre del revisor, frenando 5 stories sanas de un pull request—, y cero atrapadas reales. Se baja y no se borra porque un control cuyas únicas fallas son propias termina apagado entero con `advisors_exempt: true`, y ahí se pierden las tres que sí sirven. Vuelve a frenar con `TYCON_ROSTER_NAMES=block`; la causa se ataca eligiendo el firmante de los revisores que corrieron, en vez de tipearlo, y con eso se revisa si vuelve a frenar o si sobra. Escape: el mismo `advisors_exempt: true` + razón. |
| **Registro de aprobaciones** (2026-10-19) | Una story que pasa a `review`/`done` con una aprobación de un **agente anotada como de una persona**. Cada corrida deja `approvals.jsonl`: qué se aprobó (el plan, la maqueta, cada AC imposible de verificar, la exención de un CRITICAL), cuándo, el commit, el tipo y quién. Dos tipos: **manual** (una persona con nombre, `--approved-by <correo o usuario>`) y **automática** (un agente con cuál y su modelo, o una regla). Lo que aprueba un agente por delegación de una persona es automático y nombra la delegación (`--delegated-by <persona> --agent "<nombre> (<modelo>)"`); sin tipo o sin quién, automática «sin nombrar». Frena siempre si una línea manual nombra a un agente, una regla, una delegación o a nadie, o si el registro no se lee. Frena también si una corrida que llegó a los revisores **y declara anotar aprobaciones** (su `review-roster.json` trae `registro_aprobaciones`, que pone el arnés desde que anota aprobaciones) no trae el registro, o lo trae sin la línea del plan. Sin esa marca —un dev con el arnés de antes, cuyo portón en CI ya es el nuevo— la falta avisa y no frena: la fecha no dice qué arnés corrió en la máquina. Lista cuántas fueron manuales y cuántas automáticas. Ante la duda, automática: quien es persona se nombra con su correo. **Límite**: el registro distingue tipos, no prueba identidad — un agente que escribe el correo de una persona en `--approved-by` queda manual; lo único firmado de verdad es lo que pasa por la terminal (la matriz, `runtime-waiver`). `advisors_exempt: true` + razón perdona que falte el registro, no una línea mala. |

🔴 **El corte por fecha es mecánico y sin configuración**: el nombre del run dir trae su timestamp
(`<id>-YYYYMMDD…`). Un run anterior al estreno de la pieza no puede tener registro, así que su
ausencia sólo avisa; de ahí en adelante frena. Un registro **presente y malo** frena siempre, haya
corte o no: dato malo es peor que dato ausente. (Override sólo para pruebas: `TYCON_ROSTER_CUTOFF`.)

🔴 **Lo que el portón NO puede verificar, dicho acá para que nadie lo lea de más**: el registro es
una constancia **auto-declarada por la máquina** del dev — CI no ve `~/.claude/`. Server-side sólo
se comprueba coherencia interna (que el registro exista, sea válido, y concuerde con los hallazgos
del mismo run). El cruce que de verdad lo hace difícil de falsificar —el registro committeado
contra el ledger de spawns REALES que escribe el hook— vive en el pre-commit, en la máquina, y
tiene su propia salida escrita (`"sin_testigo": "<motivo>"` dentro del archivo, que viaja en el
diff y se puede contar). Ver `lib/review-roster.js` del skill `tycon-pipeline`.

**Qué NO chequea, a propósito**: el criterio de los revisores (eso es otro problema),
el lint de config (vive en el pipeline, que no está en CI), y nada que necesite correr la
app. Un portón que promete más de lo que puede cumplir es el mismo defecto que vino a cerrar.

🔴 **El detector de "esto es una story" se IMPORTA de `lint-story-frontmatter.js`, no se
reescribe.** Un detector propio da falsos positivos:
toma por story rota un reporte de medición que declara `story:` en el cuerpo, sin frontmatter.
Medido en el lint local: su criterio anterior habría rechazado 331 de
los 1608 `.md` de un repo del equipo. Hay un caso del autotest que lo fija.

## Lo que este control NO cubre — vigila el CIERRE, no el ENVÍO

El portón se activa cuando un cambio **declara** una historia `review`/`done`. Si alguien
implementa, sube el código y **no toca la historia**, no hay declaración: el portón no pide nada y
el cambio pasa. Verificado en laboratorio el 2026-08-31 con el portón real (`0 .md mirados`,
exit 0).

🔴 **Y el hueco cae justo sobre el caso que el portón vino a cubrir.** Existe para el que NO tiene
el arnés puesto —otra máquina, la web de ADO, hooks salteados—, y ése es el mismo que tampoco se
va a acordar de cerrar la historia. Cubre a quien sigue el proceso a medias, no a quien no lo
sigue.

Lo cerraría otra regla —**un cambio de código tiene que nombrar una historia**—, que ataca el
envío en vez del cierre. Antes de escribirla hay que **medir** cuántos cambios reales del equipo
hoy no nombran ninguna: si son muchos, frena a todos el primer día y termina apagada.

**Se mide cada noche, sin frenar ni avisar a nadie.** El nocturno de métricas corre
`scripts/metrics/story-reference.js` sobre los repos de código de `repos.json`: cuenta las entradas a
`main` de los últimos 28 días que no nombran una historia, por repo, por persona y por tipo. El número
se ve en la ficha «Cambios de código sin historia» del tablero (pestaña Proyectos; al abrirla, las
tablas) y en la misma ficha del sitio. Con ese número se decide si hace falta la regla que frena.

## Stories en un repo, código en otro — la evidencia nace en el repo de la STORY (2026-09-05)

**Por qué.** Un producto puede tener las stories en un repo y el código en otros.
Si el pipeline corre parado en el repo del código, ahí deja la evidencia de cierre;
el freno local la acepta porque el `.tycon/advisors.yaml` del repo de stories declara esos repos como
compañeros. Pero **este portón sólo mira el checkout del PR**, a propósito (arriba: "sólo lo que
se decide con el repo y nada más"), así que cuando la story pasa a `review` en su repo el
servidor no encuentra nada y el pull request sale rojo. Copiar los archivos a mano no es salida:
si el `.gitignore` del repo de stories excluye `.advisors/` entero, ni siquiera se pueden subir sin forzar.
Medido: **los cinco repos de specs** de la organización tenían el mismo muro.

**La regla.** La evidencia de cierre **nace en el repo git que CONTIENE la story**, aunque el
código esté en otro. No se copia: el ledger de smokes crece con cada corrida y dos copias
divergen. El pipeline lo resuelve solo (`pipeline.js evidence-dir --story <spec> --repo <repo>
--plain`, y el marker lo guarda en `evidenceDir`); el paso «Probar en vivo» usa ese directorio en todos los
runners (macro, gate E2E, smoke-run). Para el freno local no cambia nada: la evidencia del repo
de la story es "propia" por definición. Para `done`, el arnés **proyecta** al repo de la story
sólo `review-roster.json` y `findings.json` de la corrida (`write-findings` y el hook
`on-advisor-run.js`), y `approvals.jsonl` (marker.js), que es lo que este portón exige; los reportes pesados de cada advisor se
quedan donde corrió el pipeline.

**Lo que tiene que dejar viajar el `.gitignore` del repo de specs** (es el bloque canónico que el
preflight agrega a un repo sin decisión previa; a uno que ya tiene `.advisors/` a secas sólo le
AVISA, no se lo pisa):

```gitignore
**/.advisors/*
!**/.advisors/dod-runtime/
!**/.advisors/pipeline-runs/
**/.advisors/pipeline-runs/*
!**/.advisors/pipeline-runs/*/
**/.advisors/pipeline-runs/*/*
!**/.advisors/pipeline-runs/*/review-roster.json
!**/.advisors/pipeline-runs/*/findings.json
!**/.advisors/pipeline-runs/*/approvals.jsonl
.dashboard/
```

(Las dos líneas del medio —tapar los hijos directos de `pipeline-runs/` y re-incluir sólo los
directorios de corrida— hacen falta: sin ellas viajan archivos
sueltos como `timing-dump-*.json`, y la sonda del preflight cae justo en ese hueco y vuelve a
agregar el bloque en cada `start`.)

`.advisors/` a secas **anula** cualquier negación de abajo (git no re-incluye nada dentro de un
directorio excluido).

**Y el portón no acepta *cualquier* `<id>-*` como evidencia.**
Una copia de sólo `<id>-runtime-matrix.md` —que lista los ACs
**incluidos los sin evidencia**— o un `<id>-self-audit.md`, que el agente escribe libremente, lo
pondrían verde sin una corrida real detrás. Aplica el mismo criterio que el freno local: un
`.md` con el prefijo de la story que no sea la matriz, el self-audit ni el plan de prueba manual.
Rojo previo verificado en el selftest.

## Adopción — las dos trampas

**(a) El `--base` tiene que ser el destino del PR, no un punto viejo de la historia.** El portón
juzga UN DIFF, no el repo. Corriéndolo contra `HEAD~40` en repos reales aparecen decenas de
hallazgos — pero son historia anterior a que los gates locales existieran, no deuda del PR. Con el
base correcto (la rama destino, o el commit anterior en un build de `main`), sólo se juzga lo que
ese cambio trae.

**(b) Encenderlo bloqueando el primer día pone en rojo lo que ya está en `main`.** Misma lección
que la deuda declarada del censo de hooks: un control que frena a todo el mundo el primer día es la
vía rápida a que alguien lo apague. Camino recomendado: entrar **avisando** (paso con
`continueOnError`), mirar una o dos semanas de PRs reales, y recién ahí volverlo bloqueante.

**(c) 🔴 EL PORTÓN SE INSTALA DONDE VIVEN LAS STORIES, NO DONDE VIVE EL CÓDIGO.**

Es la trampa más cara de las tres, porque **no se ve**: el portón se instala, corre, no encuentra
nada y sale **verde**. La etapa dice "Controles del arnés: OK" y eso se lee como *revisé y está
bien*, cuando en realidad significa *no había nada que revisar*.

El portón juzga **un diff**: busca stories que se declaran `review`/`done` en ESE cambio. Si las
stories del producto viven en el repo de especificaciones —que es lo habitual en el equipo— y el
portón está sólo en el repo de código, entonces **el cambio que hay que frenar ocurre en un repo
donde el portón no está**. Medido el 2026-08-31, con el portón ya instalado un día antes:

| Producto | Stories en repos de CÓDIGO | Stories en repos de ESPECIFICACIONES | Cubiertas |
|---|---|---|---|
| Totora | 33 (Backend) | 23 | 33 de 56 |
| Ceibo | 0 | 345 | **0 de 345** |
| URUTAU | 0 | 49 | **0 de 49** |
| Lapacho | 0 | 20 | **0 de 20** |

**Antes de instalarlo, contá.** Uno por repo del producto, sobre `origin/main` (no sobre la copia
local — una rama atrasada da un número plausible y equivocado):

```bash
git ls-tree -r origin/main --name-only | grep '\.md$' | while read f; do
  git show "origin/main:$f" | head -12 | grep -q '^story:' && echo x
done | wc -l
```

El repo de especificaciones no compila nada: su pipeline es **una sola etapa**, el portón, con
`trigger: none` + `pr: none` (lo encola la política de validación por build). Y necesita su propia
política de rama, si no el cambio entra por push directo y no pasa por nada.

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

## El snippet (Azure DevOps)

Éste es el que corre de verdad en los 13 repos (2026-08-31). 🔴 Va **DENTRO** del bloque
`resources:` que el repo ya tenga: un segundo `resources:` de primer nivel es error de compilación
y el run muere sin dejar rastro de etapas.

```yaml
resources:
  repositories:
    - repository: tcg
      type: git
      name: tycon-claude-guides/tycon-claude-guides
      ref: refs/heads/main

stages:
  - stage: HarnessGate
    displayName: 'Controles del arnés (solo PRs)'
    dependsOn: []
    condition: eq(variables['Build.Reason'], 'PullRequest')
    jobs:
      - job: TyconGate
        displayName: 'tycon-ci-gate (bloqueante)'
        steps:
          # Con DOS checkouts, cada repo cae en su propia subcarpeta de $(Build.SourcesDirectory)
          # — por eso las rutas de abajo NO usan $(Build.SourcesDirectory) a secas.
          - checkout: self
            fetchDepth: 0
            # 🔴 Sin esto el `git fetch` de abajo NO tiene credenciales y falla con
            # "could not read Username". Con `|| true` encima, ese fallo era invisible y el
            # portón funcionaba de casualidad (fetchDepth: 0 ya trae la rama destino).
            persistCredentials: true
          - checkout: tcg
          - task: NodeTool@0
            inputs:
              versionSpec: '24.x'
          - script: |
              set -u
              GATE="$(Build.SourcesDirectory)/tycon-claude-guides/scripts/ci/tycon-ci-gate.js"
              REPO="$(Build.SourcesDirectory)/$(Build.Repository.Name)"
              # La variable trae a veces `refs/heads/main` y a veces `main`: se normaliza, porque
              # un --base mal armado hace que el portón juzgue historia vieja y no este cambio.
              TARGET="$(System.PullRequest.TargetBranch)"
              TARGET="${TARGET#refs/heads/}"
              if [ ! -f "$GATE" ]; then
                echo "##vso[task.logissue type=error]No se encontró el portón en $GATE — un control ausente NO es un control aprobado"
                exit 1
              fi
              if ! git -C "$REPO" fetch --no-tags origin "$TARGET"; then
                echo "##vso[task.logissue type=warning]No se pudo actualizar origin/$TARGET — se usa lo que trajo el checkout"
              fi
              if ! git -C "$REPO" rev-parse --verify -q "origin/$TARGET" >/dev/null; then
                echo "##vso[task.logissue type=error]No existe origin/$TARGET en el clon — el portón no puede comparar contra la rama destino del PR"
                exit 1
              fi
              node "$GATE" --repo "$REPO" --base "origin/$TARGET"
            displayName: 'tycon-ci-gate (--base = rama destino del PR)'
```

🔴 **`condition` y no `succeeded()` en los stages que dependen de éste.** En `main` el portón queda
`Skipped`, y `succeeded()` evalúa la CADENA entera: un `Skipped` la envenena y el stage siguiente
no corre NUNCA en `main` — sin error visible. Se chequea el resultado de la dependencia DIRECTA y
se acepta `Skipped` explícitamente:

```yaml
    dependsOn: [HarnessGate]
    condition: in(dependencies.HarnessGate.result, 'Succeeded', 'SucceededWithIssues', 'Skipped')
```

Y **todo stage que declaraba `dependsOn` implícito hay que revisarlo**: un stage sin `dependsOn`
depende del ANTERIOR, así que al insertar el portón cambia de padre. Medido tres veces (URUTAU,
Ceibo, Lapacho): el stage de `Build` colgaba de `SecurityScan`, y al volver ése "solo PRs",
`main` habría dejado de construir NADA, sin un solo error.

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

## El mismo control, ANTES del commit (`--staged`, 2026-09-04)

Con `--staged` el portón mira **lo que está por commitearse** (el índice de git) en vez del diff
contra una rama. Mismo criterio, mismo mensaje, mismos escapes — diez segundos antes y en la
máquina. Va en el `.githooks/pre-commit` del repo, que el hook global del arnés ya delega:

```bash
GATE="$TYCON_GUIDES_DIR/scripts/ci/tycon-ci-gate.js"
if [ ! -f "$GATE" ]; then
  echo "⚠️  No encontré $GATE — se saltea el portón del arnés (el del pull request igual lo mira)." >&2
  exit 0
fi
if ! node "$GATE" --repo "$(git rev-parse --show-toplevel)" --staged; then
  echo "⛔ COMMIT RECHAZADO — el portón del arnés (el motivo está arriba)." >&2
  exit 1
fi
```

🔴 **Por qué hace falta, si el freno local ya existía.** El freno equivalente
(`on-pre-commit.js` del skill `tycon-pipeline`) es un hook **de Claude Code**: sólo se dispara si
el `git commit` pasa por su herramienta. Un commit desde la terminal, desde el botón de VS Code,
desde Codex o desde la web de Azure DevOps se lo saltea **sin enterarse** — no hay error, no hay
rastro, el commit sale y listo. Esto lo corre **git**, que corre siempre.

Sin el freno en git, una story puede entrar
declarándose `review` con su código sin pushear a ningún repo, y el rojo llega
recién al pull request, después del push. Con el freno en git, ese commit no se hace.

**Diferencias con el modo servidor, todas deliberadas:**

| | servidor (`--base`) | máquina (`--staged`) |
|---|---|---|
| lo nuevo | el commit (`HEAD`) | el índice (`git show :ruta`) |
| lo de antes | la rama destino del pull request | el último commit (`HEAD`) |
| alcance | todo lo que el pull request agrega | sólo lo que este commit agrega |

Lo ya commiteado **no se vuelve a reclamar**: si mordiera en cada commit por una story cerrada hace
semanas, el freno se apagaría en una semana. Y `--staged` **ignora `--base`** a propósito: en un
pre-commit lo de antes es siempre el último commit, no una rama remota.

## Correrlo a mano

```bash
node scripts/ci/tycon-ci-gate.js --repo ~/SourceCode/MiRepo --base origin/main
node scripts/ci/tycon-ci-gate.js --repo ~/SourceCode/MiRepo --base origin/main --json
node scripts/ci/tycon-ci-gate.js --repo ~/SourceCode/MiRepo --staged   # lo que estás por commitear
node scripts/ci/tycon-ci-gate.js --selftest      # 22 casos, sin tocar nada
```

Exit 0 = al día · exit 1 = hay stories que no deberían haber llegado al servidor, **o no se pudo
comparar** (no poder mirar nunca se reporta como limpio).

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


## Límite conocido: el portón mira que la evidencia EXISTA, no lo que dice adentro (2026-09-06)

Un `<id>-dod-runtime-checker.md` que dice literalmente «🔴 1 CRITICAL (bloquea `review`)» cuenta
para el portón como evidencia válida: sólo mira el **nombre** del archivo. No es una regresión —siempre fue
así—, pero con el criterio de nombres endurecido (matriz, self-audit y plan manual ya no cuentan), el
de contenido es el agujero que queda.

**Se declara, no se cierra todavía.** Para leer el veredicto hace
falta que todos los generadores lo escriban igual, y hoy conviven dos formatos de tags de AC
(`AC #N` y `@ac-N`). Un lector de contenido sobre formatos
que divergen sería un tercer lector parcial: más deuda, no menos. Primero un formato de veredicto
ÚNICO, después el chequeo.

Mientras tanto, la división de trabajo es ésta: el portón verifica que la evidencia **existe** en el
repo de la story. El freno local (`on-pre-commit.js`) sí lee el contenido, y
lo hace en dos partes: `evidenciaDeclaraFail` descarta una corrida que
declara **FAIL** en cualquiera de los tres formatos que escribe el pipeline (`verdict=FAIL`,
`- verdict: FAIL`, `## Verdict global` + FAIL) — si es la única, bloquea diciéndolo—, y
`parseAcsFromEvidence` cuenta qué ACs **menciona** (no si cada mención es un ✅:
`AC #1 ❌` cuenta como mención). Quien lea un ✅ del portón tiene que
saber que es «hay evidencia», no «la evidencia aprobó».
