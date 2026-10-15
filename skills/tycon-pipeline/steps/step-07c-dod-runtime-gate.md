# Step 7c — DoD Runtime Gate (MANDATORY)

**Objetivo**: bloquear el avance a Step 8 (commit prep) hasta que exista evidencia
de Definition of Done runtime — smoke check ejecutado, E2E specs corridos,
artefacto persistido en `.advisors/dod-runtime/<story-id>-<timestamp>.md`.

**Capa 3 de defense-in-depth.**

**📖 Read obligatorio al entrar a este step**:
`~/.claude/tycon-harness/guides/accov-governance-protocol.md` — el
protocolo de cierre ACCOV-C7..C10 (cero checklist-manual al user, self-audit
C8 —opcional desde 2026-09-16—, meta-audit C9 —retirada el 2026-09-16—,
convergencia C10) vive fuera del advisor
y SOLO aplica acá y en Step 8: si no se lee en este momento, es invisible.


## 📍 Dónde va la evidencia — se RESUELVE, no se adivina (2026-09-05)

`<evidence-dir>` es **el repo git que CONTIENE la story**, no el repo donde corre el pipeline. En
productos con las stories en un repo (URUTAU/Project) y el código en otros (Backend, FrontEnd,
VidrieraWeb), el portón de CI que exige la evidencia al pasar la story a `review`/`done` es el del
repo de la story, y sólo mira su propio checkout: evidencia dejada en el repo del código no la ve. Con
story y código en el mismo repo es el mismo directorio de siempre. Se resuelve UNA vez y se usa en
todos los comandos de este step (macro, gate E2E, smoke-run, ui-smoke):

```bash
EVID=$(node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js evidence-dir \
  --story <spec.md> --repo <repo> --plain)
# El marker también lo trae: `marker.js get` → evidenceDir. Sin --plain devuelve JSON con
# story_repo / cross_repo y, si el .gitignore de ese repo se traga la evidencia, el aviso PIPE-C2.
```

🔴 No se copia evidencia de un repo a otro: el ledger de smokes crece con cada corrida y dos copias
divergen. Un solo original, en el repo de la story. El registro de revisores (`review-roster.json`)
y `findings.json` de la corrida sí se PROYECTAN solos al repo de la story (los escribe el arnés:
`write-findings` y el hook `on-advisor-run.js`), porque el portón los exige ahí para `done`.

🔴 Y cuando la story vive en OTRO repo, esa evidencia hay que COMMITEARLA AHÍ: el Step 8 stagea en
`repoPath` (el código); en el repo de la story quedan untracked `.advisors/dod-runtime/<id>-*` y
`.advisors/pipeline-runs/<corrida>/{review-roster,findings}.json`, y el portón de CI sólo ve lo que
viaja en el PR de ese repo. Van en el mismo commit que cambia el `status:` de la story
(`git -C <repo-de-la-story> add .advisors/dod-runtime .advisors/pipeline-runs/<corrida>/`).


## DODRT-C8 — un AC de ACCIÓN se cierra ejecutando la acción, no mirándola (2026-08-05)

**Por qué**: un AC que dice *"desde un item, el encargado puede … asignar una ruta"* se puede
"cubrir" con un E2E que abre el modal y aserta que el botón está visible. La matriz lo da
🟢 RUNTIME y el pipeline cierra verde — y la acción falla en la app real. El agujero no es el
test: es una matriz que no distingue **mirar** de **ejecutar**, así que "verificado corriendo"
miente. Y cerrar el hueco con tests **mockeados** tampoco sirve: por construcción no pueden cazarlo.

**La regla (mecánica, en `runtime-matrix.js`)**: si el texto del AC tiene un verbo que muta
estado (asignar, iniciar, crear, confirmar, enviar, descartar, eliminar…), la evidencia
runtime debe mostrar que la mutación se EJECUTÓ:

- un test del gate E2E cuyo **título** tenga `@mutates` y el `@ac-N` de ese AC, **o**
- un smoke con método de escritura (`-X POST|PUT|PATCH|DELETE`, `--data`) vía `smoke-run.sh`.

Sin eso el AC queda **`RUNTIME-PARCIAL` (🟠) y BLOQUEA** igual que NOT-RUN, con su propia
salida: ejecutar la acción, o declarar el AC en `runtime_not_verifiable:` con su `covered_by:`
para que lo apruebe el usuario.

**Contrato que esto le agrega al gate E2E del repo**: la evidencia debe incluir una sección
`## Tests corridos` con los títulos completos de los tests que pasaron (el gate los saca del
reporter JSON de Playwright). Sin esa sección la matriz no puede distinguir mirar de ejecutar.

**Calibración** (los verbos se eligieron midiendo sobre stories reales): sólo formas verbales,
nunca sustantivos derivados — "sin importar su asignación" o "el cierre de ruta" describen
un criterio de lectura y no deben disparar la regla. Escotilla con rastro:
`TYCON_RUNTIME_MATRIX_NO_MUTATION_CHECK=1`.

**Al escribir un E2E**: si el AC dice que el usuario puede hacer algo, el test lo hace —
aprieta el botón y verifica qué pasó de verdad. Un `expect(boton).toBeVisible()` no cubre
un AC de acción.

## Por qué este step existe

Sin un step explícito para verificar el gate DoD declarado en
`~/.claude/tycon-harness/guides/definition-of-done.md`, el orquestador puede declarar una tanda
`done` y producir commits SIN ejecutar nunca los E2E Playwright que él mismo escribió, y marcar
`tests_done_playwright_spec` en el frontmatter con tests jamás corridos. Eso sólo se detecta
después, cuando alguien pregunta si se corrieron.

Step 7c es la inserción canónica que cierra ese loop dentro del pipeline
declarado. Es no-skipable per regla **E.i (no-skip-by-inference)** del propio
skill (ver `SKILL.md` sección "Configuración de diseño").

## Trigger del step

Step 7c corre **siempre que Step 7 (HITL approve) avanza con `approved: true`**
y antes de Step 8 (commit prep). No es opcional: el marker.js bloquea
`complete-step 8` si `dodRuntimeChecked !== true`.

## Skip-conditions (documentadas — usar SOLO si verificablemente aplica)

El step se puede skipear ÚNICAMENTE si una de estas condiciones se cumple
verificablemente (no por inferencia conversacional):

1. **Story exempta declarada en frontmatter**: el spec tiene
   ```yaml
   dod_runtime_exempt: true
   dod_runtime_exempt_reason: "<razón concreta>"
   ```
   Solo aceptable cuando la story NO toca UI ni endpoints (puro docs,
   migraciones DB SOLAS, refactor interno sin surface, etc).

2. **Story con scope puramente backend integration tests** y los tests
   integration ya corren contra DB real con DatabaseFixture. En ese caso
   los tests integration son el smoke runtime; agregar evidencia es
   redundante. El skill verifica que existan tests con
   `[Trait("Category", "Integration")]` cubriendo el código nuevo.

3. **Story `[REVERT]`/`[ROLLBACK]`** (approach declarado): el smoke runtime
   se hace por la story que se está revirtiendo, no acá.

Si ninguna condición se cumple → **el step DEBE correr**.

🔴 **El salteo deja constancia** (2026-10-03): `complete-step 8` pide `dodRuntimeChecked` siempre, también cuando
el step no corre. Por eso `pipeline.js next` devuelve el 7c aunque la story esté exenta, con el comando en su nota:
`marker.js mark-dod-runtime-checked '{"verdict":"PASS","evidencePath":"exenta: <la razón del frontmatter>"}'`. Antes
`next` lo daba por salteado y mandaba al 8, y el freno aparecía recién ahí.

## 🟢 Pre-flight hook check (SPEED-2, recomendado ANTES del Edit del frontmatter)

Cuando termines el smoke runtime y vayas a Edit el frontmatter para transicionar
`status` o `pipelines.X.status` a `review`/`done`, los hooks (`on-frontmatter-write.js`
+ `hook-pre-edit.js` + `on-pre-commit.js`) validan pre-condiciones y bloquean si
faltan. Para evitar el ciclo "Edit → block → leer error → ajustar → retry" (~30-60s
por ciclo), corré PRIMERO:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js preflight-frontmatter \
  --story-path <path/to/spec.md> \
  --target-status done       # OR
  --target-pipeline-done A-backend
```

**Output**: JSON con `ready_to_edit: bool` + `preconditions: [{id, type, satisfied, how_to_satisfy}]`.

**Exit codes**: 0 = ready (proceder con Edit), 1 = preconditions faltan (resolver primero).

Pre-condiciones evaluadas (MVP):
- **PRE-1**: evidence file existe en `<evidence-dir>/<storyId>-*.md` (el repo de la story, o alguno de sus compañeros declarados).
- **PRE-2**: si story declara E2E reales (`FullUI-`/`E2E-`/`tests_done_playwright_spec`/`tests/e2e/`), el evidence file debe contener bloque `## Playwright Run` con substrings literales `verdict=PASS` + `failed=0` (regex del hook).

Skip-cases: target ya == current / target NO es review-done / `dod_runtime_exempt: true` / story sin runtime tests → `ready_to_edit: true` con razón.

Por qué: sin preflight, cada precondition que falta cuesta un ciclo de hook-block entre el Step 7c y el 8. Con preflight: una llamada upfront identifica TODAS las preconditions + cómo satisfacerlas.

## 🟢 Macro determinístico (SPEED-3, recomendado para stories backend)

Para stories backend con secuencia de curls determinista (POST orden + scan +
verify + ...), usá el macro `step-7c-macro.js` en vez de ejecutar cada paso a
mano. Captura responses, asserts status + body, escribe evidence file con
formato hook-compliant (incluye bloque `## Playwright Run` con substrings
literales `verdict=PASS` + `failed=0` que `on-frontmatter-write.js` requiere).

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/step-7c-macro.js \
  --story <id> \
  --scenario <path/to/scenario.json> \
  --evidence-dir "$EVID"
# Opcional: --base-url http://localhost:5001 --bearer-token admin --dry-run
```

Exit 0 = todos los steps PASS + evidence file escrito. Exit ≠ 0 = abort.

**Ubicación de scenarios**: convención `<repo>/.tycon/dod-scenarios/<story>.json`
o per-skill ejemplo en `~/.claude/agent-skills/skills/tycon-pipeline/scripts/scenarios/example-scan-reception.json`.

**Schema scenario JSON** (mínimo):
```json
{
  "name": "<scenario-name>",
  "story": "<id>",
  "acs_covered": [1, 4],
  "preflight": { "devhost_health_url": "/api/health/ready" },
  "steps": [
    { "name": "...", "method": "POST", "path": "/api/...", "body": {...},
      "expect_status": 201, "capture": {"varName": "$.id"},
      "assert_body": {...} },
    { "name": "...", "method": "GET", "path": "/api/.../{varName}",
      "expect_status": 200, "assert_body": {...} }
  ],
  "evidence": {
    "ac_summary": { "1": "...", "4": "..." },
    "playwright_run": { "verdict": "PASS", "failed": 0,
                        "rationale": "Backend-only — E2E en pipeline B pending." }
  }
}
```

Variables capturadas (`$.path.to.field`) se substituyen en steps subsiguientes con
sintaxis `{varName}` en `path` y `body`. Soporta `$.arr[0].field` para arrays.

**Cuándo NO usar el macro**:
- Story toca frontend UI con E2E reales → usar el gate E2E del proyecto (`.tycon/advisors.yaml` → `e2e.gate`, scoped por default en este step — ver 7c.3 two-tier).
- Story toca BackgroundService/Worker → trigger manual del cycle + assert event log.
- Pattern transaccional complejo → runtime verification manual (rollback en exception).

Por qué SPEED-3, medido: el Step 7c manual toma ~2 min
(devhost restart + curl orden + curl scan + curl verify + curl confirmar +
escribir evidence file desde cero + recordar substrings hook-compliant). Con
macro: ~10s + scenario JSON una sola vez.

## Acciones del step (en orden)

### 7c.1 — Detección automática del scope

El orquestador determina qué tipo de runtime check aplica:

| Story toca | Smoke action |
|---|---|
| Frontend UI (`.tsx`/`.vue`/`.razor`) | E2E Playwright/Cypress + axe-core smoke |
| Backend endpoint (`.cs`/`.go`/`.ts` API route) | curl/HTTP client contra DevHost vivo |
| BackgroundService/Worker | Trigger 1 cycle real + assert event log |
| Migraciones DB | Apply + rollback + apply en test DB |
| Pattern transaccional (TransactionScope + Dapper) | Runtime verification — rollback en exception |

Si la story toca múltiples → todas las verificaciones aplican.

### 7c.2 — Invocar `tycon-dod-runtime-checker` advisor (opt-in por superficie desde 2026-09-16)

**Lo decide un helper, no el orquestador** (regla E.i — skip documentado y verificable, nunca inferido):

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js dod-checker-needed --story <abs spec.md> --repo <repo>
```

Hace tres preguntas sobre lo que **sólo este advisor** cubre —donde los scripts y los hooks no
llegan—, las imprime y deja la decisión en `gates.log` (`name: dod-checker-decision`, con `invoca` y
los motivos):
1. ¿El diff de la corrida (contra la base del marcador) toca un **worker**? (`BackgroundService` /
   `IHostedService` en un archivo **.NET** —`.cs`, `.vb`, `.fs`— del repo, o en uno que la corrida tocó
   en un repo compañero según el marcador: ciclos que hay que disparar a mano).
2. ¿Los ACs declaran una **transacción compleja**? (`TransactionScope`, o transacción con rollback o
   compensación: verificación runtime del rollback).
3. ¿Hay una **tanda** del bloque `pipelines:` en `in-progress` o `blocked`? (multi-pipeline).

- **exit 3** (ninguna) → **NO invocar**. Anunciar el salteo en 1 línea citando la salida del helper.
- **exit 0** (alguna — o no pudo mirar: diff roto, sin base de la corrida, story ilegible) → invocar
  como siempre. La duda va hacia más control.

Por qué, medido:
en 286 hallazgos registrados dejó **uno** (DODRT-C6, la regla que la matriz ya corre sola) y cuesta
~2,8 min y ~120 mil tokens por corrida. Lo que frena de verdad en el cierre es mecánico: la matriz por
AC (7c.6) y el gate E2E (7c.3). La regla anterior lo salteaba cuando la evidencia ya estaba verde —o
sea, decidía por lo que los scripts y los hooks ya prueban— y dejaba la superficie, que era lo único
que importaba, como una condición más. No se borró: «sin rastro» no es «no cazó nada» (sus veredictos
no viajan a `findings.json`).

Cuando se invoca, el advisor (definido en
`~/.claude/agent-skills/agents/tycon-dod-runtime-checker.md`)
ejecuta los gates per `definition-of-done.md`:
- DODRT-C1: smoke check curl real contra DevHost (no mock).
- DODRT-C2: CI run verde post-push (si ya hay push) o build-gate local.
- DODRT-C3: evidencia transaccional con runtime verification.
- DODRT-W1/W2: cobertura y trazabilidad.

Output del advisor: report markdown con FAIL/PASS por gate + evidencia
capturada (curl outputs, E2E run logs, screenshots si aplica).

### 🚨 7c.2.1 — Anti-pattern HARD STOP: "mocks NO cuentan como DODRT-C1"

**Por qué**: capturar evidencia DoD declarando "4/4 Playwright PASS" cuando los 4 specs usan
`page.route()` mocks 100% no prueba nada del backend. Los mocks
verifican el CONTRATO del frontend asumiendo un shape backend que YO asumí
correctamente — NO verifican que el backend REAL devuelva ese shape.

Cuando se ejecutó DODRT-C1 efectivo (curl real contra DevHost vivo), se
atrapó un bug REAL: `GetBoxDetailAsync` ejecutaba SQL con dos columnas
inexistentes en `CEIX_Bolsas` → HTTP 500
en runtime real. Bug iba a llegar a producción si solo se confiaba en
mocks Playwright + xUnit (ninguno de los dos ejerce el path completo
endpoint público).

**Regla — DODRT-C1 EFECTIVO requiere TODOS estos elementos**:

1. ✅ **Stack runtime levantado**: DevHost vivo (no devhost.sh status diciendo
   "no está corriendo" Y el puerto respondiendo — chequear con `curl :5001/api/health`
   directamente).

2. ✅ **Curl/HTTP client real**: el comando que ejerce el endpoint debe ser
   `curl`/`fetch`/`Invoke-RestMethod` REAL, NO `page.route()`/`mockResolvedValue`/
   `Mock.Of<HttpClient>()`/`vi.fn()`. Si el caller frontend interceptó una
   "respuesta" producida por TU código de test, **NO es DODRT-C1**.

3. ✅ **Captura del response REAL**: el archivo de evidencia debe incluir
   el output literal del comando (`status_code`, `content_type`, body JSON
   completo o snippet con ID real). Si la evidencia dice "passed" sin el
   body JSON capturado, **NO es DODRT-C1**.

4. ✅ **Comparison vs DTO contractual**: el JSON real capturado debe
   compararse explícitamente contra el `interface` TS / `class` C# del DTO
   esperado. Drift detectado (campo extra, campo faltante, type mismatch,
   case mismatch camelCase vs PascalCase) → fix antes de avanzar.

5. ✅ **Cada endpoint público con caller frontend**: si la story agrega o
   modifica N endpoints (`MapGet`, `MapPost`, etc.) que tienen caller
   frontend declarado, **TODOS los N requieren DODRT-C1**. No solo el "happy
   path principal": un endpoint con integration test + smoke no cubre al de al lado que no los tiene.

**Anti-pattern explícito a rechazar**:

```
❌ "Capturé evidencia DoD: 4/4 Playwright PASS"
    → si los 4 specs usan page.route() mocks, NO es DODRT-C1, es DODRT-C2.
```

```
❌ "DODRT-C1 N/A — la story usa solo integration tests xUnit"
    → integration tests xUnit verifican el SQL contra DB, pero NO verifican
      que el endpoint HTTP exponga ese SQL correctamente, ni que el JSON
      serialization produzca el shape esperado, ni que el routing funcione.
      Bug de endpoint path / serializer / middleware NO se atrapa.
```

```
❌ "DODRT-C1 difered — no levanté DevHost porque toma 2 min más"
    → exactamente el patrón que la regla F.i del SKILL.md prohíbe.
      2 min más vs 1 bug en producción: el bug cuesta 100x más.
```

**Verificación obligatoria del archivo de evidencia**:

El archivo `.advisors/dod-runtime/<storyId>-<timestamp>.md` DEBE incluir,
para cada endpoint nuevo/modificado de la story:

- Bash command exacto (`curl -H ... URL`).
- HTTP status code real (200, 4xx, 5xx).
- Content-type real.
- Body (JSON snippet con AL MENOS un ID/timestamp del entorno target — eso
  prueba que NO es un mock).
- Comparison "✓ shape coincide con `<DTO name>` TS" o "❌ drift detectado: ...".

Si la evidencia NO tiene esos elementos por cada endpoint, **el step no se
considera ejecutado**. El hook `on-pre-commit.js` se puede extender en futura
iteración para parsear la evidencia y verificar este checklist programáticamente
(TODO en este step file).

### 🔴 7c.3 — EJECUTAR EL GATE PLAYWRIGHT SCOPED (gate duro vía script, two-tier)

**MANDATORY si la story toca frontend (`.tsx`/`.vue`/`.razor`) o tiene specs en
`tests/e2e/`.** No es "ejecutar si declarados" — es **ejecutar el gate** y fallar
duro si algo está rojo.

**TWO-TIER**: en este step el default es **SCOPED** — los specs de la story
según su tabla `### Tests` + un smoke transversal corto, pasados como
`[spec-filter]`. La **suite COMPLETA corre 1 sola vez en `/tycon-merge-to-main`
pre-merge** (catch de regresiones cross-feature donde corresponde, sin pagar la
suite entera por iteración). La evidencia incluye `scope=scoped|full`
machine-parseable: **`scope=scoped` alcanza para pasar la story a `review`/`done`;
el merge a main exige `scope=full`**.

**NO ejecutar los E2E a mano comando-por-comando** (eso es exactamente donde el
orquestador "se olvida" o "finge"). El gate E2E lo OWNea el PROYECTO
(`.tycon/advisors.yaml` → `e2e.gate`); este step lo RESUELVE (agnóstico — no
hardcodea specs/puertos de ningún repo):

```bash
# --changed = los archivos que la STORY tocó (files_to_create/modify o marker.filesTouched).
# En un monorepo con varias apps declaradas (e2e.frontend_dirs) elige la que corresponde;
# en un repo con el `frontend_dir:` escalar de siempre devuelve esa sola.
# La ruta del archivo sale de tmp-path.js: la misma para bash (que escribe) y Node (que lee) en Mac, Linux y Windows,
# y una por repo y por sesión (dos pipelines a la vez no se pisan la configuración).
E2ECFG=$(node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/lib/tmp-path.js e2ecfg <repo>)
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js e2e-config --repo <repo> \
  --changed <archivos-de-la-story...> > "$E2ECFG"
# si la configuración no se puede leer, se DICE (antes un catch vacío lo volvía «sin gate configurado»)
GATE=$(node -e 'try{process.stdout.write(require(process.argv[1]).gate||"")}catch(e){process.stderr.write("⚠️ no pude leer la configuración de E2E ("+process.argv[1]+"): "+e.message+"\n")}' "$E2ECFG")
GAP=$(node -e 'try{process.stdout.write(require(process.argv[1]).warning||"")}catch(e){process.stderr.write("⚠️ no pude leer la configuración de E2E ("+process.argv[1]+"): "+e.message+"\n")}' "$E2ECFG")
# TODAS las apps que la story tocó, una por línea (no sólo la primera — ver el 🔴 de abajo).
APPS=$(node -e 'const c=require(process.argv[1]);process.stdout.write((c.frontend_dirs_selected||[c.frontend_dir].filter(Boolean)).join("\n"))' "$E2ECFG")
# GAP no vacío → el repo TIENE specs Playwright pero NO declaró el gate → avisar FUERTE al user
#   (relayear $GAP), no skip silencioso. GATE vacío sin GAP → el repo no tiene E2E (skip ok).
echo "$APPS" | while read -r FE; do
  [ -n "$FE" ] || continue
  bash "$GATE" "$FE" <ruta-de-la-story.md> "$EVID" [spec-filter-de-esa-app...] || exit 1
done
```

🔴 **En un monorepo, la app NO es "la del repo": son TODAS las que ESTA story tocó**. `frontend_dir` a secas devuelve la PRIMERA app declarada, que puede no ser la que la
story tocó — el gate correría los specs de una app contra el directorio de otra, o peor: verificaría
una app que la story no toca y daría verde sin haber probado nada de lo entregado.

**Y quedarse con `frontend_dirs_selected[0]` tiene el MISMO defecto** cuando la entrega toca dos
apps: se verifica una y la otra pasa sin control. Es la misma clase de bug que este mecanismo vino a
arreglar, un nivel más arriba — cazado por el hunter de fallos silenciosos en la propia corrida de
QA-1, sobre el primer intento de este fix. Por eso acá se ITERA, igual que en el paso 7b de
`/tycon-merge-to-main`, y un rojo en cualquier app frena el gate.

- **Con `[spec-filter]`** (default en este step) → scoped a los specs de la story
  (tabla `### Tests`) + smoke transversal corto. Evidencia con `scope=scoped`.
- **Sin `[spec-filter]`** → corre la **SUITE COMPLETA** (`scope=full`) — el tier
  que `/tycon-merge-to-main` ejecuta pre-merge. Acá solo si el dev lo pide.

El gate del proyecto (el script que el repo declaró en `e2e.gate`) hace, por contrato:
1. Chequea que el stack que el proyecto declare esté vivo (sus puertos/servicios).
2. Si está down → **lo levanta solo** (el comando de arranque que el proyecto defina,
   con un timeout). Si no levanta → escribe evidencia `FAIL` + exit 3.
3. Corre `npx playwright test [filter] --reporter=json` con workers POR SCOPE:
   **scoped → 1 worker** (los specs de una story
   suelen mutar estado compartido del tenant — a 8 workers se pisan entre sí),
   **full → 8**. Override explícito: env `PLAYWRIGHT_WORKERS`.
4. Parsea `expected`/`unexpected`/`flaky`/`skipped` del JSON.
4-bis. Corre **en modo exigente**: exporta `E2E_REQUIRED=1` (paraguas del arnés) más lo que el repo
   declare en `e2e.required_env`, para que un spec que se saltea solo cuando el entorno no le da lo
   que necesita **lance** en vez de saltear (`REAL-C8`). La evidencia registra con qué llaves corrió
   (`- llave_exigente:`) y la salida nombra los salteos que quedaron: mientras un spec no honre la
   llave, eso es deuda visible, no un verde limpio.
5. **Gate duro**, TRES veredictos y un código por causa (el orquestador actúa según
   el número — el mapa único vive en `veredicto()`, `scripts/lib/e2e-evidence.js`):
   `failed > 0` → `FAIL` exit 1 · `0 tests` → `SIN_EJERCER` exit 2 (en scoped, típico
   filtro que no matchea ningún spec — typo en el nombre) · servers down → `FAIL`
   exit 3 · **había tests y TODOS se saltearon solos → `SIN_EJERCER` exit 4**.
   Solo `PASS` con `failed=0` y al menos un test EJECUTADO → exit 0.
   🔴 `SIN_EJERCER` (2 y 4) no es un verde con asterisco: el gate no ejerció nada, así
   que no hay evidencia runtime — `runtime-matrix.js` sólo cuenta `verdict=PASS`.
   Nació el 2026-09-27 porque Playwright devuelve 0 cuando todos los tests se saltean y
   el gate reportaba `PASS (0/4)`: verde, merge habilitado, cero flujos ejercidos.
6. Escribe `<clave>-e2e-gate-<ts>.md` (la clave de la evidencia) con el bloque `## Playwright Run`
   machine-parseable (verdict/total/passed/failed/duration/scope).

**El orquestador DEBE chequear el exit code del script**:
- exit 0 → continuar (gate verde).
- exit != 0 → **STOP. NO avanzar a Step 8. NO escribir `status: done`.** El remedio
  lo dice el código, y confundirlos hace perder el run arreglando lo que no está roto:
  **1** → loop a Step 4 (fix los tests rojos) · **3** → levantar el stack y re-correr ·
  **2** → el filtro no matcheó: corregir el nombre del spec · **4** → los specs se
  saltearon solos porque el entorno no tiene los datos que necesitan: **sembrar los
  datos y re-correr** (el stack ESTÁ arriba — levantarlo otra vez devuelve 4 de nuevo).

**El bloque `## Playwright Run` del archivo de evidencia es lo que el hook
`on-frontmatter-write.js` verifica** antes de permitir `status: done` /
`pipelines.X.status: done`. Sin un run fresco + verde, el hook bloquea.

### 7c.3-escape — Cuándo se permite NO correr el gate (estrictísimo)

El ÚNICO escape es `dod_runtime_exempt: true` en frontmatter (story sin UI/E2E
reales — ver Skip-conditions arriba). **El viejo escape `review-pending-smoke`
queda ELIMINADO**: era el loophole por el que los E2E "quedaban pendientes" y
nunca se corrían. Si el stack no levanta, el fix es **levantar el stack**, no
diferir el gate. Una story que toca UI NO pasa a `done` sin gate Playwright verde
(scoped como mínimo; el full corre en `/tycon-merge-to-main`).

### 🔴 7c.3-deferred — UI story con E2E `tests_pending`/diferidos a un sub-pipeline

**Caso**: una story que toca frontend UI declara sus specs E2E como diferidos
(`pipelines.X.tests_pending: [E2E-...]` o `tests_pending_runtime:`) — los specs
Playwright **todavía NO están escritos** — y el run se commitea con `status: in-progress`
(no transiciona a review/done en este run).

**Regla (no-negociable)**: diferir la **escritura** de los specs E2E **NO** waivea la
verificación runtime. En este caso 7c.3 EXIGE un **smoke DRIVEN de la UI** (en vez del
gate de specs, que no existen todavía):

- Un script Playwright (o driver equivalente) que **maneje la app REAL** (`dev.html`
  contra el stack vivo — dev-proxy + DevHost + **datos seedeados reales**, NO
  `page.route()` mocks — mismo principio que 7c.2.1) y **asserte CADA AC de UI de la
  story**, no un subconjunto: cada modal/pantalla/estado que la story declara, cada
  acción, cada gate RBAC, cada validación visible.
- Evidencia obligatoria en `<evidence-dir>/<storyId>-ui-smoke-<ts>.md`:
  **mapeo AC → assertion ejecutada → PASS/FAIL** + screenshots por caso, generada desde
  el run del script (no fabricada a mano — misma provenance que 7c.4).
- **Curl NO cuenta** para ACs de UI (ejerce el endpoint, no el render). El smoke driven
  es *adicional* al DODRT-C1 curl de los endpoints nuevos (si los hay).

**Sin ese smoke driven → 7c = INCOMPLETE → bloquea Step 8**, AUNQUE el `status` quede
`in-progress`. El "commit WIP de una UI cableada" NO es un escape: si la feature está
montada en la app (feature-wiring positivo), su render se verifica driven en este run.

**🚫 Regla anti pre-claim (la que faltó en 11.1)**: el orquestador **NO puede narrarle
al user "DoD complete / probado / verificado / anda / smoke passed"** —ni entregar una
guía "cómo probar X" como si la hubiera ejecutado— **antes** de que este gate esté en
verde con evidencia. Toda afirmación de verificación va DESPUÉS de la ejecución, citando
la evidencia. Una guía de prueba entregada al user etiqueta CADA caso explícito:
`✅ verificado por el agente (evidencia: <path>)` vs `🔲 pendiente de que lo pruebe el
user`. Mezclar los dos = mentira al user (mismo peso que la mentira al spec del
anti-pattern de 7c.2.1 / abajo).

**Por qué**: correr un smoke parcial, declarar "DoD complete ✅", entregar una guía de prueba
de TODOS los casos como si se hubieran verificado, y racionalizar el gate Playwright con
"E2E diferido al merge gate" deja la verificación driven sin correr hasta que alguien la exige.

### 7c.4 — Persistir evidencia

**🔒 NOTA de provenance (hook `on-dod-evidence-guard.js`)**: la evidencia de **run real**
(`<storyId>-<ts>.md` del macro + `<storyId>-e2e-gate-*.md` del gate, con el bloque
`## Playwright Run verdict=PASS`) **NO se escribe a mano** — el hook BLOQUEA Write/Edit del
agente sobre esos `.advisors/dod-runtime/*.md`; la escriben SOLO los scripts (el gate E2E del
proyecto / `step-7c-macro.js`). **EXCEPCIÓN PERMANENTE: el self-audit (`*-self-audit*.md`, ACCOV-C8) SÍ lo
escribe el agente** — es su auto-revisión estructurada (no un verdict de test fakeable), su
honestidad la cierra la convergencia C10 (el meta-audit C9 se retiró el 2026-09-16). NO requiere `touch` (fix
2026-06-14). El override one-shot (`touch ~/.claude/.tycon-pipeline/ALLOW_DOD_EVIDENCE_WRITE`,
ejecutado por el **USER**, consumido + logueado en `bypass.log`) queda SOLO para el caso raro de
escribir a mano evidencia de run (ej: evidencia vacua de E2E diferidos a un pipeline pending).

**⏱ Freshness**: evidencia Playwright verde con mtime ANTERIOR al último cambio de
código de la corrida = **STALE** → el hook `on-frontmatter-write.js` la rechaza.
Tras aplicar fixes, re-correr el gate — la evidencia vieja no satisface.

El archivo `<evidence-dir>/<storyId>-<UTC-timestamp>.md` (generado
por los scripts) contiene:

```markdown
# DoD Runtime Evidence — Story <id>

**Timestamp**: <ISO 8601>
**Pipeline iteration**: Step 7c
**Story spec**: <abs path>
**Repo root**: <abs path>

## Gates ejecutados

### DODRT-C1 — Smoke curl real contra DevHost
- Endpoint: <method> <url>
- Status: <200/4xx/5xx>
- Output: <snippet>
- VERDICT: PASS/FAIL

### DODRT-C2 — E2E specs ejecutados
- Spec: <path>
- Command: `npx playwright test ...`
- Resultado: <N/M passing>
- VERDICT: PASS/FAIL

### DODRT-C3 — Pattern transaccional (si aplica)
- ...

## Verdict global

PASS / FAIL / PARTIAL

## Notas

<observaciones, gotchas detectadas, items pending para next iter>
```

El archivo es git-tracked (no .gitignore) para que viaje con el commit como
auditable trail.

### 7c.5 — Actualizar marker.js

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js \
  mark-dod-runtime-checked '{"evidencePath": "<abs path>", "verdict": "PASS"}'
```

Esto setea `marker.dodRuntimeChecked = true` y registra la evidencia. Step 8
chequea este flag antes de proceder.

**Registrar el check `dod` — SIEMPRE, independientemente del modo autónomo**: es lo que
`complete-step 8` exige para toda story de UI (el candado mira `checks.dod` verde con
provenance `run-check`, sin mirar si la corrida es `--autonomous`). 🔴 Saltearlo «porque
estoy en HITL» frena el Step 8 más adelante, sin que se entienda por qué.
**Forma canónica: `run-check`** — ejecuta el comando del gate, captura el exit code REAL
él mismo y setea el check con `provenance=run-check` (queda en `gates.log`). NO es self-report:

```bash
# Resolver el gate del PROYECTO (.tycon/advisors.yaml → e2e.gate):
E2ECFG=$(node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/lib/tmp-path.js e2ecfg <repo>)
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js e2e-config --repo <repo> \
  --changed <archivos-de-la-story...> > "$E2ECFG"
GATE=$(node -e 'process.stdout.write(require(process.argv[1]).gate||"")' "$E2ECFG")
APPS=$(node -e 'const c=require(process.argv[1]);process.stdout.write((c.frontend_dirs_selected||[c.frontend_dir].filter(Boolean)).join("\n"))' "$E2ECFG")
# El check `dod` sale del exit code REAL del gate. Con UNA sola app tocada es un run y listo:
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js run-check dod -- \
  bash "$GATE" "$(echo "$APPS" | head -1)" <ruta-de-la-story.md> "$EVID" <spec-filter...>
```

🔴 **Si `APPS` trae MÁS DE UNA, ese `head -1` NO alcanza**: el check `dod`
es el que le da luz verde al cierre de la story, así que verificar una app y dejar la otra sin
control es el mismo agujero que el gate multi-app vino a tapar. Con varias apps, correr el gate
**una vez por app** y registrar el check con un comando compuesto que falle si falla cualquiera:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js run-check dod -- \
  bash -c 'echo "$0" | while read -r FE; do [ -n "$FE" ] || continue;
             bash "$1" "$FE" '"<ruta-de-la-story.md>"' '"$EVID"' || exit 1; done' \
  "$APPS" "$GATE"
```

El `run-check` sigue capturando UN exit code real (el del `bash -c`), que es 0 sólo si TODAS las
apps dieron 0 — la garantía anti-self-report no se afloja.

`set-check dod green --manual` queda SOLO para excepciones: veredicto COMPUESTO
que no es un único comando (ej: DODRT-C1 curl real + gate e2e combinados) o story
con `dod_runtime_exempt: true` (la exención cuenta como satisfecha, no como rojo).
Queda marcado `provenance=manual` y logueado — Step 8 lo anuncia como "check no
verificado mecánicamente".

🔴 Si `dod` queda `red:...`, el Stop-hook DoD gate bloquea el cierre del turno →
el agente vuelve al Step 4 a arreglar el path roto y re-corre el gate runtime. Cuando
el verdict es PASS, el check pasa a `green` y el portón deja avanzar a Step 8.

### 🔴 7c.6 — Matriz de verificación runtime por AC (DODRT-C6, MANDATORY — 2026-07-10)

El gate `dod` verde de 7c.3 prueba que **el spec declarado pasó** — NO qué ACs quedaron
ejercitados: un `dod` verde puede tener evidencia runtime de una parte de los ACs, sin
que exista la lista de lo no-probado. Después del gate, SIEMPRE:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js run-check acmatrix -- \
  node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/runtime-matrix.js --story <abs spec.md>
```

- **VERDE** → todos los ACs tienen evidencia runtime (gate E2E / smokes vía
  `smoke-run.sh`) o son imposibles-declarados con la firma del dev vigente → avanzar.
- **ROJO** → el artefacto `<sid>-runtime-matrix.md` lista los ACs `CODE-ONLY` /
  `SIN-EVIDENCIA`. Hay **dos clases, y se tratan distinto**:
  - **AC `SIN CORRER` (NOT-RUN)** → 🔴 **no se pregunta nada y no se waivea: lo corre el
    agente.** El waiver los rechaza y el portón bloquea. Automatizarlos es el trabajo.
  - **AC imposible de verificar en runtime** → se declara en el frontmatter de la story con
    `runtime_not_verifiable:` (`reason:` + `covered_by:`), se le presenta al dev **uno por
    uno en el chat** con el resumen llano ("probado corriendo: N de T; solo tests de
    código: M; sin evidencia: K"), y la firma la pone **el dev desde su terminal**:
    `node <skill>/scripts/marker.js runtime-waiver <abs spec.md>` (pide confirmación AC
    por AC; es TTY-only, el agente no la puede producir) + re-correr el `run-check acmatrix`
    (ahora verde).
  - 🔴 **NO se escribe `runtime_verification_ack` en el frontmatter**: el ack escribible por
    el agente fue el agujero que se cerró el 2026-07-10 y no se reintroduce. La firma vive
    en `.tycon/runtime-waivers.jsonl` del repo de la story, anclada al hash de la
    declaración (`reason` + `covered_by`): si alguien reescribe la justificación, hay que
    volver a firmar.
  - La guía de prueba manual del tester (`<sid>-manual-test-plan.md`, DODRT-C7 vía
    `qa-guide.js`) es un artefacto de las stories de UI — **no es condición del waiver**.
- Los smokes por curl SOLO cuentan si corrieron vía
  `scripts/smoke-run.sh <evidence-dir> <ruta-de-la-story.md> --acs N,M -- <cmd>` (ledger + espejo
  gates.log). Un curl narrado en el Debug Log es prosa, no evidencia.
- 🔴 **A `smoke-run.sh`, a `e2e-gate.sh` y a `step-7c-macro.js --story` se les pasa la RUTA de la
  story, no el número**. Con la ruta calculan solos la clave de la evidencia: el número
  si es único en su repo, `<tema>__<número>` si se repite (`pipeline.js evidence-key --story <ruta>`
  la imprime). Con el número a mano, en un repo que numera por tema la evidencia queda **huérfana**:
  la matriz la nombra y no la cuenta.

`complete-step 8` exige `checks.acmatrix=green` (provenance run-check) — sin este
sub-step el pipeline NO llega a commit prep. `on-pre-commit.js` además RE-COMPUTA
la matriz en las transiciones a review/done (el .md escrito no se confía).

**Dos categorías (DODRT-C6, 2026-07-10)**: la matriz separa `NOT-RUN` (sin evidencia y NO
declarado imposible → **el agente DEBE correrlo**, no waiveable) de `NOT-VERIFIABLE` (declarado
en el frontmatter `runtime_not_verifiable:` con `reason:`+`covered_by:` → imposible de ejercer
corriendo la app → waiveable por el usuario). El agente presenta CADA `NOT-VERIFIABLE` en la
conversación (razón + test que lo cubre) y el usuario decide AC por AC; el waiver TTY
(`marker.js runtime-waiver`) pide confirmación por-AC (no un rubber-stamp). Ver SKILL.md F.ii.

### 🟢 7c.7 — Guía QA para tester (HTML, DODRT-C7, 2026-07-10)

Además de la verificación automática, el pipeline deja armada una **guía de prueba manual en
HTML pensada para un tester humano** (segundo control de calidad), almacenada en los documentos
de trabajo de la story. Tras la matriz:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/qa-guide.js --story <abs spec.md> --open
```

Genera `<...>/specs/qa/<story>-guia-qa.html` (self-contained, sin red): una card por AC con el
texto del AC, cómo se verificó automáticamente, pasos para reproducirlo a mano, y controles
pasó/falló/notas + un botón **Limpiar** por AC.

**`--open`**: en la ÚLTIMA generación de la corrida (la que queda
vigente al cerrar el pipeline), pasar `--open` para que la guía se abra sola en el navegador —
el dev la ve sin que nadie le pase la ruta. Es un flag explícito: los hooks y el modo `--check`
no abren nada. Si la guía se re-genera varias veces en la corrida (pasos nuevos, matriz que
cambia), abrir solo la última.

🔴 **Pasos EN LENGUAJE DE TESTER (no dev)**: la tabla `### Tests` es dev-facing (dice "3 filas
CEIX_Articulos", "asserts del DOM", `Foo:891`) — NO sirve para un tester. Los pasos del tester van en
un archivo aparte **`<repo>/specs/qa/<sid>-pasos.md`** (formato: `## AC N` + `- <acción>` / `→ <lo
que tenés que ver>`, en criollo), que el orquestador ESCRIBE como parte del step (los ACs de UI
son directos; para los técnicos/no-observables se escribe una nota honesta). Si un AC RUNTIME no
tiene pasos-tester, la guía lo marca "faltan pasos" (y el generador lo avisa por stdout). El detalle
técnico de la tabla + el comando del smoke van a un `<details>` colapsado "para el dev".

🔴 **Usuario de prueba por AC (DODRT-C7, 2026-07-13)**: cada AC declara CON QUÉ USUARIO se prueba —
la guía lo pinta como un badge en el header. Formato:
- **Default a nivel archivo** (la mayoría comparte actor): una línea `Usuario por defecto: <rol>`
  al tope del `-pasos.md` (ej. `Usuario por defecto: Encargado general`). Se aplica a todo AC que no
  declare el suyo.
- **Override por AC**: una línea `Usuario: <rol>` como PRIMERA línea del bloque `## AC N` (antes de
  la descripción). Varios roles separados por `;` (ej. `Usuario: Encargado general (pestaña 1); Admin
  (pestaña 2)` para una prueba de 2 pestañas).
- **Sin login**: `Usuario: —` (o `ninguno`/`sistema`) para los AC que verifica el sistema y el
  tester no opera a mano → badge "Sin login — lo verifica el sistema". Los AC `NOT-VERIFIABLE`/`WAIVED`
  ya toman ese badge automáticamente (no hace falta la línea).

**Guardar** (botón): escribe las selecciones del tester DENTRO del mismo HTML (`showSaveFilePicker`
o descarga) para que viajen con la historia — no depende de localStorage. Los `NOT-VERIFIABLE`
muestran su razón + el test que los cubre. Preámbulo de setup: `<repo>/specs/qa/preamble.md`
(ofrece que el dev/agente levante el entorno, no que el tester corra comandos).

🔴 **CANDADO por capas (obligatorio para stories de UI)** — `qa-guide.js --check --story <spec>`
verifica que la guía esté LISTA antes de cerrar, y `marker.js complete-step 8` lo corre (bloquea
si falla, sin bypass por env var — igual que la matriz):
1. **Existe** el archivo de pasos-tester `specs/qa/<sid>-pasos.md`.
2. **Cubre** cada AC verificado corriendo (`RUNTIME`) con su bloque de pasos.
3. **Sin jerga de software** (determinístico): `detectJargon` frena si un paso tiene identificadores
   de código (`camelCase`/`PascalCase`), `CONSTANTES`, tablas `CEIX_`/snake_case, `archivo:línea`,
   `.metodo()`, backticks o HTTP crudo (`422`/`403`). El vocabulario del dominio del producto está
   permitido; para sus siglas hay una lista de permitidas.
4. **Review de legibilidad independiente**: un sub-agente que hace de "tester no técnico" (persona
   de QA de laboratorio, sin saber programar) lee cada paso y marca lo que lo dejaría preguntándole a
   un dev — jerga sutil, ambigüedad ("buscá una orden" sin decir cómo), dependencias de conocimiento.
   El orquestador RESUELVE cada marca y guarda el resultado en `specs/qa/<sid>-legibilidad.md` con
   `veredicto: OK`. 1-3 son candados duros infakeables (chequean el texto real); 4 es evidencia
   (tier DoD) — atrapa lo que el detector no puede (frases sin jerga pero confusas: "forzar por otra vía", "buscá una
   orden" sin cómo, un usuario sin origen), pasos que un tester no puede seguir.
   **Marca medible**: al resolver las marcas, dejar la línea con
   `node <skill>/scripts/pipeline.js qa-readability --story <abs spec.md> --repo <repo> --marks <n>`
   (`qa-legibilidad` en `gates.log`, n = marcas resueltas). Sin esa línea la capa 4 no se distingue en
   el registro de agentes y no se puede juzgar si rinde. Stories sin UI: no corre (como siempre).
   **Cada marca se anota en su línea, citando el texto entre «»**: `- «<texto citado>» — qué confunde — resuelta
   en: <archivo>`. Si el texto citado sigue en una pantalla de la story, el candado lo frena (capa 8): la marca se
   resolvió en la guía y no en la pantalla.
4b. **Review de legibilidad de la PANTALLA** — el mismo sub-agente "tester no técnico", ahora sobre lo que ve
   el usuario. 🔴 Por qué (2026-10-14): una pantalla puede pasar todos sus AC, los revisores, el pase adversarial
   y E2E reales, y aun así ser inentendible para quien la usa (números internos en lugar de nombres, frases
   como «Tiene 1 facturas sin pagar»). Si la capa 4 sólo lee la guía, sus marcas se resuelven reescribiendo la
   guía y el texto malo sigue en la pantalla. Cómo:
   - Insumos: `node <skill>/scripts/qa-guide.js --story <abs spec.md> --ui-texts` (los textos visibles de cada
     pantalla de la story, sin el código) y las capturas de la última evidencia del gate E2E (sección
     `## Capturas`). El sub-agente juzga si se entiende y si anticipa el resultado — no la estética.
   - Las marcas se resuelven **EN LA PANTALLA** (el código). Si cambia la pantalla, re-correr el gate E2E
     (scoped) para que las capturas y la matriz queden al día.
   - Resultado en `specs/qa/<sid>-legibilidad-ui.md` (misma carpeta y clave que la guía) con `veredicto: OK`,
     `screens:` (cada pantalla que leyó) y `captures:` (las rutas que miró, o `ninguna — <motivo>`). Marcas
     citadas con «» como en la capa 4; un texto que se queda a propósito lleva `keep: <por qué>` en su línea.
   - Marca medible: `node <skill>/scripts/pipeline.js qa-readability --story <abs spec.md> --repo <repo> --marks <n> --scope ui`
     (`qa-legibilidad-ui` en `gates.log`).
5. **Usuario de prueba declarado** (determinístico, DODRT-C7 2026-07-13): cada AC `RUNTIME` resuelve
   un usuario — `Usuario:` propio, `Usuario por defecto:` del archivo, o `Usuario: —` (sin login).
   Frena si alguno queda sin declarar (así ninguna guía se cierra sin decir con qué rol probar cada
   AC).
7. **La pantalla revisada**: existe `<sid>-legibilidad-ui.md` con `veredicto: OK`, `captures:` (las
   rutas que nombra existen) y `screens:` que nombra cada pantalla de la story (`.tsx/.jsx/.vue/.svelte` de
   `files_to_create`, `files_to_modify` y del File List). Una pantalla declarada que no está en el disco —buscada
   en el repo de la story, en la carpeta que lo contiene y en los repos acompañantes— frena: o se saca de la
   lista, o se declara el repo donde vive.
8. **Ninguna marca tapada** (determinístico): una cita «…» de tres palabras o más, en cualquiera de los
   dos archivos de legibilidad, que sigue en una pantalla de la story —literal o como mensaje armado— frena,
   salvo que su línea traiga `keep: <por qué>` (no frena y el candado la imprime siempre).

## Output del step

```json
{
  "step": "7c",
  "verdict": "PASS",
  "evidence_path": ".advisors/dod-runtime/4.2-2026-05-20T16-00-00Z.md",
  "gates_run": ["DODRT-C1", "DODRT-C2"],
  "gates_passed": ["DODRT-C1", "DODRT-C2"],
  "gates_failed": []
}
```

Si verdict === "FAIL" → loop a Step 4 (re-implementar el path roto) o cancelar
pipeline. Si el FAIL del gate del proyecto fue por servers down (exit 3) →
levantar el stack y re-correr el script (NO diferir).

Si verdict === "SIN_EJERCER" (exit 2 o 4) → **el gate NO ejerció nada: trátalo como
bloqueante, no como PASS**, y NO se difiere. Con **2** el filtro no matcheó ningún
spec (corregir el nombre). Con **4** los specs existen y se saltearon solos porque el
entorno no tiene los datos que consumen: sembrar los datos y re-correr. 🔴 Acá el
stack está ARRIBA — diagnosticarlo como "servers down" y re-levantarlo devuelve 4 otra
vez (por eso el 4 no comparte código con el 3).

Si verdict === "PASS" (gate del proyecto exit 0 + DODRT-C1 curl real verde) → marker
actualizado → avanzar a Step 8.

**`PARTIAL` / `review-pending-smoke` ELIMINADO** (2026-05-20): ya no existe el
estado intermedio "E2E pendientes". O el gate Playwright corre verde (scoped en
este step; full en `/tycon-merge-to-main`), o el gate bloquea. La única salida
sin correr E2E es `dod_runtime_exempt: true` (story sin UI).

## Hooks que enforzan este step

Aunque el orquestador respete el step, hay 2 hooks de defense-in-depth:

1. **`on-frontmatter-write.js`** (PreToolUse Edit|Write) — bloquea al agente
   antes de poder escribir `status: review` o `pipelines.X.status: done` en el
   spec si falta evidencia o si la evidencia es STALE (mtime anterior al último
   cambio de código — re-correr el gate tras fixes).

2. **`on-pre-commit.js`** (PreToolUse Bash matcher git commit) — bloquea
   `git commit` si el diff incluye transición frontmatter sin evidencia.

3. **`on-dod-evidence-guard.js`** (PreToolUse Write|Edit) — bloquea la escritura
   manual de la evidencia misma (ver NOTA de provenance en 7c.4).

Los tres son fail-safe: si el agente skipea este step por inferencia, los hooks
lo atrapan al primer Edit/commit.

## Logging

Escribir log a `.advisors/pipeline-runs/<clave>-<sello>/step-07c-dod-gate.md`
con el resultado.

## Anti-patterns explícitos

- ❌ Marcar `tests_done_playwright_spec: [...]` con tests no ejecutados,
  anotando `(Run manual pending DevHost.)`. Eso es **una mentira al spec**.
  Si los tests no se corrieron → `tests_pending_runtime: [...]`.

- ❌ Skipear el step alegando "los advisors Step 5 corrieron verde, eso es DoD".
  No — los advisors LEEN el código. DoD runtime requiere EJECUCIÓN.

- ❌ Skipear alegando "Step 4 build-gate verde, eso es smoke runtime". No —
  build verde compila, no ejerce el flujo end-to-end.

- ❌ Saltar este step "porque la sesión es larga y querés cerrar". El skip
  reintroduce exactamente el problema que el step existe para prevenir.

- ❌ Narrarle al user "DoD complete / probado / verificado / smoke passed" —o
  entregar una guía "cómo probar X" como si se hubiera ejecutado— ANTES de correr
  el gate 7c en verde. Afirmar cobertura no ejecutada = mentira al user (ver
  7c.3-deferred, regla anti pre-claim).

- ❌ Racionalizar el skip del smoke driven con "es un commit WIP / in-progress, no
  transiciono a done". El status `in-progress` NO waivea 7c: una UI cableada se
  verifica driven en el run que la cablea (ver 7c.3-deferred).

- ❌ Correr un smoke DRIVEN parcial (algunos de los casos/ACs de UI) y presentarlo
  como verificación completa. 7c.3-deferred exige **cada** AC de UI aserteado, no
  un subconjunto representativo.
