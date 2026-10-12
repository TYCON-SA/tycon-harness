# Protocolo de governance ACCOV-C7..C10 — cierre de story

> **Extraído de `tycon-ac-coverage-checker.md` el 2026-06-09**: estas 4 reglas
> son protocolo de CIERRE de story (self-audit,
> meta-audit, convergencia, checklist-manual prohibido), no checks de cobertura
> AC↔código. Vivían dentro del advisor más pesado del hot path del Step 5
> (~30KB releídos en CADA iteración) aunque solo aplican 1 vez, al transicionar
> a `review`/`done`. Ahora el ORQUESTADOR (tycon-pipeline step-07c/step-08) lee
> este doc on-demand en el cierre; el advisor conserva C1/C2/C3/C5/C4/W1/W2.
>
> Los rule IDs NO cambian (ACCOV-C7..C10) — el catálogo y los reportes los citan igual.
>
> **Recorte del 2026-09-16**: **C9 queda retirada** (el meta-audit con modelo del
> self-audit) y **C8 pasa a opcional** (el hook no frena si falta; si existe a medias, avisa). C7 y C10
> siguen. Motivo medido: cero hallazgos ACCOV-C7..C10 en los 286 registrados, y desde el 2026-07-10 la
> matriz por AC (DODRT-C6) cruza cada criterio con una ejecución real — lo que el meta-audit hacía
> releyendo la prosa del agente.

### CRITICAL

**[ACCOV-C7] El agente pasa un "checklist manual" al user al cerrar la story** (post-2026-05-20).

**Regla**: el output del pipeline al cerrar una story es el resultado de
`npx playwright test` + `dotnet test`. **Cero checklist manual al user.**

Si el agente le pasa al user un mensaje del tipo *"podés probar X, Y, Z para
verificar que está completa"*, **el pipeline falló** — significa que el
agente declaró done sin haber automatizado lo que él mismo definió como
criterio de "está bien hecho". El user es el **release approver**, NO el
QA manual. Si el user tiene que abrir el browser para verificar algo, falló
el agente + falló el pipeline.

**Por qué**: una story puede cerrar con sus Playwright en verde y, aun así,
dejar sin automatizar la mayor parte de lo que el propio agente pide probar.
Lo que haga falta probar para dar la historia por completa es exactamente lo
que tiene que cubrir el Playwright automático, sin participación del user.

**Cómo se detecta** (heurísticas combinadas):

1. **Heurística 1 — keyword scan del mensaje final del agente**:
   Si el último output del agente al user (antes de declarar done) contiene
   alguno de estos patterns:
   - `"verificá X"`, `"probá X"`, `"asegurate de X"`
   - `"checklist a probar"`, `"items a verificar"`, `"para que veas que..."`
   - `"abrir el browser"`, `"hacer click en"`, `"navegar a"`
   - `"checkear visualmente"`, `"smoke manual"`

   → CRITICAL.

2. **Heurística 2 — gap entre Playwright + manual instructions**:
   Si el agente entrega evidencia DoD que cuenta `N` Playwright tests Y
   también un texto narrativo con `M` items a probar (M > 0), donde `M`
   incluye ASSERTS que NO están en los `N` tests, → CRITICAL.

   El advisor mapea los asserts del checklist (extraídos del texto del
   agente) contra los `expect(...)` y locator queries de cada Playwright
   test. Si `assert ∈ checklist ∧ assert ∉ playwright_tests` → finding.

3. **Heurística 3 — cobertura por interacción declarada en Tasks**:
   Toda interacción user-visible mencionada en `## Tasks / Subtasks` del
   spec (verbos `click`, `escribir`, `seleccionar`, `cerrar`, `abrir`, `ver`,
   `filtrar`, `hover`) debe tener un Playwright test que la ejerza. Si
   `interaction ∈ tasks ∧ interaction ∉ playwright_tests` → CRITICAL.

**Excepción**: cobertura runtime de un endpoint puramente backend sin UI
(ej: VencimientosWorker corriendo background) que requiere DODRT-C1 curl pero
NO requiere Playwright (no hay user-visible interaction). Ese case usa la
DODRT-C1 directa sin Playwright extra.

**Output esperado** (advisor encuentra checklist en mensaje final):

```
[ACCOV-C7] El agente le pasó al user un "checklist a probar" de 13 items
manualmente, donde solo 5 están cubiertos por los Playwright tests existentes.
Items sin coverage:
  - "ListadoToolbar muestra dot rojo en cada item" → NO está en ningún expect()
  - "Click en ⓘ OR-186 muestra Instrucciones IHC" → solo cubierto OR-185
  - "Filter input '185' → 1 fila" → no asertado
  - ...
Acción: agregar Playwright tests que cubran esos asserts. NO transicionar
a done hasta que cada item del checklist tenga su test ejerciéndolo.
```

---

### CRITICAL

**[ACCOV-C8] Pre-flight self-audit** (post-2026-05-20 · **opcional desde 2026-09-16**).

> **Opcional desde 2026-09-16.** El hook `on-pre-commit.js` ya **no frena** si falta,
> y si existe con secciones de menos **avisa sin frenar**. Si existe, C10 (convergencia) sigue corriendo.
> Motivo: era prosa del agente sobre sí mismo validada por regex, y el portón de CI ya no la contaba
> como evidencia; lo que frena el cierre es la matriz por AC. Lo de abajo describe el formato para
> quien lo escriba.

**Regla (hasta 2026-09-16)**: antes de declarar una story como `review` o `done`, el agente DEBE
producir un archivo `.advisors/dod-runtime/<storyId>-self-audit.md` que enumere
EXPLÍCITAMENTE lo siguiente. Sin ese archivo en el diff staged, el hook
`on-pre-commit.js` BLOQUEABA el commit.

> **Provenance**: este artefacto lo escribe **el agente** (a diferencia de la evidencia de
> run real `<storyId>-<ts>.md` / `<storyId>-e2e-gate-*.md`, que la escriben los scripts y el
> guard `on-dod-evidence-guard.js` protege). El guard **exime** `*-self-audit*.md` (fix
> 2026-06-14): es auto-revisión estructurada, no un verdict de test fakeable — su honestidad
> la cerraban ACCOV-C9 (meta-audit, retirada 2026-09-16) + C10 (convergencia), no provenance. NO requiere `touch`.

**Por qué**: cada repregunta del user pidiendo confirmación destapa gaps nuevos
(E2E no corridos, mocks-only, un AC sin Playwright, checklist manual al user,
UI no probada, etc.). Patrón: el agente declara done
con coverage prematura y deja que el user haga el QA preguntando. ACCOV-C8
fuerza self-audit antes del declare-done, no después de que el user pregunte.

**Estructura mandatoria del self-audit**:

```markdown
# Self-Audit Story <id>

**Timestamp**: <ISO 8601>
**Status target**: review | done
**Agent**: <model-id>

## 1. Cobertura por AC

Para CADA AC declarado en `## Acceptance Criteria` del spec:

| AC | Implementado | Tests que lo cubren | Tipo (mock-only / runtime-real) | Gaps |
|----|--------------|---------------------|----------------------------------|------|
| #1 | ✓ código en X.tsx | T1 vitest, T2 Playwright | runtime-real (E2E sin mock endpoint) | ninguno |
| #2 | ✓ ... | ... | ... | ... |
| #N | ✓ | ... | ... | ... |

## 2. Cobertura por interacción del UI

Para CADA interacción enumerada en `## Tasks / Subtasks` (verbos: click,
escribir, seleccionar, cerrar, abrir, ver, filtrar, hover):

| Interacción | Test que la ejerce | Gaps |
|---|---|---|
| Click dropdown stage | T-Dropdown Playwright | ninguno |
| Cerrar Dialog X / ESC / click-fuera | T-Dialog-close-{X,ESC,backdrop} | ninguno |
| ... | ... | ... |

## 3. Gaps conocidos NO cerrados

Enumerar TODOS los gaps detectados que NO se cierran en esta iteración,
con razón concreta + plan de cierre.

| Gap | Razón no cerrado | Plan |
|---|---|---|
| SignalR real (no mock) | Requiere WebSocket integration test setup | Story X.Y.Z follow-up |
| NFR2 backend real | Requiere seed 500 items en BD | Story X.Y.Z |
| ... | ... | ... |

## 4. Verificación de no-regresión

- vitest full suite: <N>/<N> PASS
- xUnit full suite (unit + integration): <N>/<N> PASS  
- type-check: verde
- build: verde
- Playwright: <N>/<N> PASS

## 5. Confianza del agente (escala 1-10)

<número> — <razón>. Si <8, listar lo que FALTA para llegar a 10.
```

**Heurísticas anti-falso-positivo del advisor** (histórico: las aplicaba el meta-audit ACCOV-C9,
retirado el 2026-09-16 — sólo corren si el dev pide el meta-audit a mano; un §4 con «no re-corrí»
no pide re-correr nada fuera del test-gate):

1. **Sección 3 con "ninguno" o vacía + checklist > 5 items en sección 2**:
   sospechoso. El agente NO está auditando — está rellenando. CRITICAL.
2. **Confianza >= 9 con gaps documentados en sección 3**: contradicción.
   CRITICAL — o subir gaps a fixed o bajar confianza con razón.
3. **AC declarado en spec NO mencionado en sección 1**: CRITICAL.
4. **Sección 4 dice "no re-corrí" o "skipped"**: CRITICAL — re-correr antes
   de declare done.

**Anti-pattern al rellenar el archivo**:

El agente DEBE escribir el self-audit ANTES de proponer el commit final al
user. NO después de que el user pregunte "¿seguro?". Si el agente nota a
mitad de escribir el self-audit que un gap es serio (ej. SignalR real
mockeado), DEBE pausar + reportar al user + decidir si fixea o documenta —
no entregar y esperar la pregunta.

**Cómo el hook `on-pre-commit.js` lo enforce**:

Cuando detecta una transición frontmatter a `review`/`done` en el diff
staged, AHORA chequea 2 cosas (post-2026-05-20):

a) Existe `.advisors/dod-runtime/<storyId>-<timestamp>.md` (regla original).
b) Existe `.advisors/dod-runtime/<storyId>-self-audit.md` (nuevo).

Si (b) NO existe → desde 2026-09-16 **no bloquea** (antes bloqueaba).

Si (b) existe pero falta sección obligatoria (1-5) → desde 2026-09-16 **avisa sin bloquear** (antes bloqueaba).

---

### CRITICAL

**~~[ACCOV-C9] Meta-audit del self-audit obligatorio~~** (post-2026-05-20) — **RETIRADA 2026-09-16**.

> **Retirada el 2026-09-16**: ya no es obligatoria ni la corre el cierre. Cero
> hallazgos en los 286 registrados; y el agujero que tapaba —gaps que el agente no lista de sí mismo—
> lo cierra desde el 2026-07-10 la matriz por AC (un AC sin ejecución real es rojo, lo diga o no el
> self-audit) más C10. El texto queda como historia: se puede pedir a mano («meta-audit del self-audit»)
> y el ID no se reusa. Cómo se mide si vuelve a hacer falta: `evidencia_rechazada_por_hook` en el
> tablero y los `NOT-RUN` de la matriz.

**Por qué**: un self-audit ACCOV-C8 con confianza y gaps declarados puede omitir
otros gaps que el agente sólo reconoce ante una repregunta. Ejemplos de lo que omite:
- un hook nuevo que nunca fue smoke-tested;
- un hook que verifica secciones por regex pero no profundidad de contenido;
- una regla "antes del commit" que es cultural, no enforcement programático.

**Patrón**: el self-audit del agente tiene SUS PROPIOS gaps (meta-gap). El
agente NO puede escapar su propio sesgo "esto está terminado". Necesita un
auditor **externo** del self-audit.

**Regla**: cuando el agente produce un self-audit ACCOV-C8, este advisor
(`tycon-ac-coverage-checker`) DEBE ejecutar un meta-pass:

1. **Cross-check AC vs self-audit §1**: cada AC del `## Acceptance Criteria`
   del spec → debe estar en la tabla §1 del self-audit. Si falta → CRITICAL.

2. **Cross-check Tasks vs self-audit §2**: cada verbo de interacción
   (`click`, `selecciona`, `escribe`, `cierra`, `filtra`, `hover`, etc.) en
   `## Tasks / Subtasks` → debe estar en §2 del self-audit. Si falta → CRITICAL.

3. **Confidence vs gaps coherence**: si §5 declara confianza ≥ 9 Y §3 lista
   gaps no cerrados → CONTRADICTION CRITICAL.

4. **Hook modification smoke test**: si el diff staged incluye cambios a
   `scripts/on-pre-commit.js` o `scripts/on-frontmatter-write.js` o cualquier
   PreToolUse hook bloqueante TYCON → el self-audit §3 o §4 DEBE mencionar
   "smoke test ejecutado del hook nuevo" + casos cubiertos (positivos +
   negativos). Si no → CRITICAL.

5. **Infra changes coverage**: si el diff modifica un advisor markdown o
   un step file del pipeline → §4 del self-audit DEBE declarar verificación
   ejecutada del cambio (no solo "ok, lo escribí"). Si no → CRITICAL.

6. **"Ninguno" en §3 con UI compleja**: si §3 dice "ningún gap" PERO la story
   tiene >5 archivos UI nuevos/modificados + >3 ACs UI-related → flag
   automático CRITICAL "self-audit sospechoso de superficial".

7. **Gaps documented sin plan**: si §3 lista gaps pero alguno no tiene
   "Plan" concreto (story id, schedule, condition de cierre) → WARNING.

**Output esperado del meta-audit**:

```
[ACCOV-C9] Meta-audit del self-audit detectó:
  - §1 missing AC #4 (declarado en spec, no enumerado en tabla AC del self-audit)
  - §2 missing interaction: "click Imprimir lista" mencionado en Task 7
    pero no en tabla §2 del self-audit
  - §3 vs §5 coherence: confianza 9/10 con gap "SignalR transport real no probado"
    → contradicción, bajar a ≤7 o cerrar gap
  - §4 missing smoke test del hook nuevo (on-pre-commit.js fue modificado pero
    el self-audit no menciona verificación del bloqueo)
```

**Excepción**: si el self-audit declara explícitamente `dod_meta_audit_exempt:
true` + razón concreta (ej. "story es puro docs/config, no hay infra ni UI")
→ skip ACCOV-C9.

---

### CRITICAL

**[ACCOV-C10] Convergencia del self-audit entre iteraciones** (post-2026-05-20).

**Por qué**: si el agente descubre gaps nuevos CADA VEZ que el user pregunta
"¿segurísimo?", hace falta saber cuándo se cierra el ciclo. Se cierra **cuando el
self-audit converge** — cuando el set de gaps en iter N es subset del set
de iter N-1 (cero nuevos). Es lo que el agente solo NO puede detectar (su
propio sesgo). Hook lo automatiza.

**Regla**: la transición `review → done` requiere CONVERGENCIA del self-audit.

**Algoritmo**:

1. Cada self-audit se guarda como `<clave>-self-audit-iter{N}.md` (la clave de la evidencia: el número de la story,
   o `<tema>__<número>` si el número se repite en el repo — `pipeline.js evidence-key --story <ruta>`) con
   metadata `iter: N` en frontmatter o como heading H1 explícito.

2. El hook `on-pre-commit.js`, al detectar transición a `done`:
   - Lee los últimos 2 self-audits (`iter-N` y `iter-{N-1}`).
   - Extrae el set de gaps de §3 (heading `## 3. Gaps conocidos`).
   - Heurística de extracción: cada row de tabla con columna `Gap` o cada
     bullet point `- **<letra/nombre>**:` cuenta como un gap. Normalizar
     por nombre (case-insensitive, trim).
   - Compara:
     - `gaps_N ⊆ gaps_{N-1}` (cero nuevos, posiblemente cerró algunos):
       → **CONVERGED**, permite `done`.
     - `gaps_N ⊃ gaps_{N-1}` (al menos un gap nuevo):
       → **NOT CONVERGED**, bloquea `done` con detalle.
     - `gaps_N == gaps_{N-1}` (mismo set):
       → **CONVERGED**, permite `done`.

3. Edge cases:
   - Solo existe iter 1 (primera self-audit): permite si confidence ≥ 8/10
     declarado en §5 + no critical gaps en §3 (todos con `non-blocking`
     en columna impact).
   - iter N existe pero iter N-1 no: probably renamed/skipped numbering.
     Buscar el penúltimo más reciente por timestamp del archivo.

**Output esperado del hook cuando NO converge**:

```
[ACCOV-C10] Self-audit NO convergido — gaps nuevos en iter 7 vs iter 6:
  + Gap L: ACCOV-C9 mismo no smoke-tested
  + Gap M: confidence threshold no parametrizable

Convergencia requiere: gaps_iter_N ⊆ gaps_iter_{N-1}. Acción:
  (a) Cerrar los gaps nuevos en código antes del próximo iter.
  (b) Si los gaps son aceptables non-blocking, agregarlos también al iter
      anterior + re-escribir como base + re-iter.
  (c) Transicionar a 'review' (no 'done') hasta convergencia.
```

**Output cuando converge**:

```
[ACCOV-C10] Self-audit CONVERGIDO — iter 7 sin gaps nuevos vs iter 6.
Gaps documentados (C, D, E, K): plan concreto Story <N.M>. Transition
to 'done' permitida.
```

**Excepción**: stories con `dod_convergence_exempt: true` en frontmatter +
razón (típico para hotfixes urgentes donde se aceptan gaps sin convergencia).
Queda log `had_convergence_exempt=true` en commit notes.

**Por qué este criterio termina las iteraciones**:

Iteraciones del user "¿segurísimo?" producen información cuando revelan
gaps no detectados. Cuando el agente y el user convergen en el mismo set
de gaps (sin agregar nuevos), el aporte marginal de iterar más cae a cero
— el sistema está en equilibrio epistémico. ACCOV-C10 automatiza la
detección de ese equilibrio.

---

**[ACCOV-C11] Una guarda de frescura no se cierra sin verse verde en un checkout LIMPIO**
(post-2026-08-25).

**Por qué**: una *guarda de frescura* es un control que
impide que un AC pase leyendo la foto de una medición vieja. Un fix así puede marcarse
`disposition: fixed`, pasar la re-verificación D.i, el commit y el merge… y **romper CI
sobre `main`**. El defecto típico: para saber si el producto cambió desde la medición, la guarda compara
un timestamp commiteado contra `statSync(<archivo del producto>).mtimeMs`. En la máquina donde se
escribió eso funciona —ahí el mtime ES la hora de la edición—; **en cualquier checkout limpio el
mtime es la hora en que git escribió el archivo**, o sea siempre posterior a la medición. La
guarda acusa SIEMPRE, sin que nadie haya tocado el producto.

**Regla**: cuando un fix agrega (o modifica) un control que compara *"lo medido"* contra *"el
estado del producto"*, `disposition: fixed` exige haberlo visto **en un checkout o worktree
limpio**, en las DOS direcciones:

1. **camino feliz verde** — clon nuevo, nadie tocó nada, el control NO acusa;
2. **rojo por la razón correcta** — se cambia el producto de verdad y el control lo dice, citando
   la causa (no otro assert del mismo test cayéndose por otro motivo).

El (1) es el que se saltea: un control que sólo se probó donde se escribió no está probado.

🔴 **Instrumento PROHIBIDO**: `mtime`/`birthtime` de un archivo versionado como proxy de *"cuándo
cambió el producto"*. Ese dato no sobrevive a un clon. **Instrumentos válidos**: un hash del
CONTENIDO estampado por la propia medición, o la fecha del commit del archivo
(`git log -1 --format=%cI -- <path>`) **sólo** si el clon garantiza profundidad — con un clon
shallow puede volver vacío y caer de nuevo al mtime, que es el defecto original con otra cara.

**Excepción**: ninguna. Si no se puede probar en un checkout limpio, el finding no se cierra como
`fixed` — se declara **no verificado**, con el motivo.

**Por qué es una regla y no una anécdota**: el patrón *"un aviso que compara tiene que probar su
camino feliz"* puede estar escrito en la memoria del proyecto y, aun así, el fix
escribirse sin aplicarlo (`prevention_missed`). Una nota que se recuerda cuando conviene no es un
control; esta regla la vuelve verificable en el cierre.

## 6. Precedente ACCOV-C5 — AC cubierto por una medición local que no viaja (2026-09-06)

Aplica a un AC que mide una propiedad de una corrida de medición sobre población local (`eval/mediciones/`,
`eval/corridas-sin-respaldo/`), **gitignoreada** — no ejecutable en CI ni en otra máquina —, sin fila
propia en `### Tests`. Sin precedente escrito, el revisor de cierre lo acepta citando de
memoria una corrida anterior y hay que argumentarlo de cero en cada checkpoint. Escrito
acá, el revisor lo cita y el dev lo reconoce sin discusión.

**Camino PREFERIDO — promover a fixture lo que sostiene un veredicto firmado.** Antes de declarar
el AC como `runtime_not_verifiable`, evaluar promover los pares de la población (spec + IR) a
fixtures versionadas (molde `tests/roundtrip/fixtures/`): la medición se vuelve re-corrible en
cualquier máquina y puede convertirse en test — desaparece el waiver. Costos a evaluar en cada caso:
(a) mantenimiento — los IR archivados envejecen (un IR puede dejar de
validar contra el parser actual), y toda fixture promovida entra a la tabla de firmas byte a byte
o a sus exclusiones declaradas (`_byte-baseline-exclusiones.json` — quedar afuera es una decisión,
no un olvido); (b) contenido — verificar que el par no traiga datos que no deban viajar.

**Camino de EXCEPCIÓN — sólo cuando la promoción no aplica.** El AC puede cerrarse como
`runtime_not_verifiable` si se cumplen las cuatro condiciones, **juntas**:

1. El AC mide una propiedad de una corrida de medición sobre población local, gitignoreada.
2. Existe evidencia generada de esa corrida (`resultados.md` con población declarada y números).
3. El mecanismo que la medición ejercita a escala poblacional **ya está cubierto por otro T-ID con
   las tools reales** (no mockeado): la medición es la variante «sobre población real», no la única
   prueba del mecanismo.
4. Waiver explícito del dev en el checkpoint — nunca automático.

`covered_by:` en un AC `runtime_not_verifiable` tiene que ser un **T-ID con tag `@ac-N`**, nunca una
ruta de archivo: `runtime-matrix.js` degrada una ruta a NOT-RUN en vez de WAIVED-USER.

