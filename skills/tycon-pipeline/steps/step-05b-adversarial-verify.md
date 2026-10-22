# Pase adversarial

**Objetivo**: correr un pase adversarial que **EJECUTA** el código del diff (bundlea/compila/parsea + corre
probes contra datos/corpus reales) para CONFIRMAR o REFUTAR bugs de correctitud — la capa que los 6 advisors
single-pass del Step 5 **no** pueden dar porque ellos LEEN el diff, no lo ejecutan.

Sus findings CONFIRMADOS se foldean al reporte consolidado del Step 6 con tag `adversarial-verify` y
disparan el re-loop D.i igual que los de un advisor.

## 🔀 Desde 2026-07-30 este step es un JOIN, no un lanzamiento (Fase B paralelización)

El workflow se lanza **al cierre del Step 4** (ver step-04 §Lanzamiento temprano) para que sus
~20-40 min corran en paralelo con el Step 5. Este step, que sigue viviendo entre el Step 5 y el
Step 6 en la máquina de estados, decide qué hacer según `marker.adversarial` (leer con
`marker.js get`):

- **`marker.adversarial` existe y `adversarial_is_ours: true`** (lo trae `pipeline.js next`) → el
  workflow es NUESTRO. **Join PASIVO**:
  - **Si la notificación YA llegó** (el Step 5 dejó el output escrito en
    `<RUN_DIR>/step-05b-adversarial.md` — ver step-05 §Cap reducido) → procesar ESE archivo
    (§Decisiones post-output).
  - **Si la notificación todavía NO llegó**: anunciar en 1 línea *"esperando el pase adversarial —
    llega solo, ~N min restantes"* y **CERRAR el turno** — no encadenar más tool calls, no avanzar
    al Step 6, no anotar nada del 5b, no `Monitor`, no polling. La notificación reactiva la
    sesión sola; ahí se retoma en §Decisiones post-output.
- **`marker.adversarial` existe pero `adversarial_is_ours: false`** → lo lanzó OTRA sesión (el resume
  de un Workflow no cruza sesiones — no hay forma de joinearlo). **No se pregunta: decide la regla** que
  trae `pipeline.js next` en `pending_action` (preguntar sería sumar una espera por una persona): si el
  lanzamiento tiene menos de 45 min y esa sesión sigue viva (su conversación cambió hace menos de 10
  min), **ESPERAR** su resultado (`esperar-pase-ajeno`: lo anota esa sesión; acá se cierra el turno
  como en el join pasivo); si no, **RELANZAR** (`relanzar-pase-ajeno`). Si ya tiene resultado, está
  atendido y no se relanza (relanzar un pase cerrado bloquea el paso 8). Para relanzar, ANUNCIAR en 1
  línea *"el pase adversarial de la sesión <id> quedó sin resultado — lo relanzo (~20-40 min): <why>"*
  y, como en un retome NO están en contexto ni el gate ni las decisiones: **(a)** re-evaluar el gate
  (§Cuándo corre) para obtener el `model` fresco, **(b)** recuperar `decisions` del
  Change Log / Completion Notes de la story y de `<RUN_DIR>/step-03-*.md`, **(c)** recién ahí relanzar
  con §Acción y registrar `mark-adversarial-launched <runId nuevo> 5b` (el overwrite cross-session está
  permitido).
- **`marker.adversarial` NO existe** (kill-switch `TYCON_5B_EARLY=0`, o pipeline pre-fase-B) →
  comportamiento clásico: evaluar el gate y lanzar ACÁ (§Cuándo corre + §Acción), registrando
  igual `mark-adversarial-launched <runId> 5b`.
- Nota: si el Step 4 ya anotó el salteo con `mark-adversarial-skipped` (gate `run:false`), este
  step no se alcanza (`next` lo da por atendido) — es el no-op esperado, no un caso de esta lista.

### Cómo se cierra el 5b — con constancia, nunca con una bandera suelta

- **El pase corrió** → `mark-adversarial-result` (§Decisiones post-output): anota qué encontró y a
  dónde fue cada hallazgo, y cierra el 5b en la misma escritura.
- **El portón dice que no corre** → `mark-adversarial-skipped --files <archivos de código del diff>`:
  el comando le vuelve a preguntar al portón y, si el portón dice que corre, se niega.
- **Abandonar un pase ya lanzado** es una decisión, no un salteo:
  `TYCON_NO_DEEP_REVIEW=1 marker.js mark-adversarial-skipped --files …` (queda en `bypass.log` como
  `ADVERSARIAL_ABANDONADO`, con el runId).

La bandera que lee `pipeline.js next` no se escribe a mano, y `complete-step 8` **frena** si el pase
se lanzó y su resultado no está (freno `adversarial-result-gate`; `DOD_BYPASS` no lo abre). Medido antes
de cablearlo: 4 de 9 corridas que lanzaron el pase lo cerraron con la bandera y sin
anotar qué encontró, y 3 de esas 4 pasaron el paso 8 igual. Anotar el resultado sin haber procesado la
notificación sigue siendo mentira: el número de confirmados es el real.

> **Por qué existe**: un review adversarial multi-agente *después* del pipeline caza bugs reales que los
> advisors single-pass no ven (por ejemplo, un falso negativo de traversal que deja inalcanzable parte del
> corpus real y sobre el que los advisors dan 0 CRITICAL). Es un step gateado para que ese valor no dependa
> de acordarse de correrlo a mano.

## Cuándo corre / Cuándo saltear (gate mecánico — regla E.i, verificable)

Correr `deep-review-gate` y respetar `run`:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js deep-review-gate \
  --repo <repo> --story <story_path> --files <archivos-de-código-del-diff> \
  [--ultracode] [--deep-review-opus] [--deep-review-fable]
```

- **`run: true`** → ejecutar el pase (secciones abajo). Pasá `--ultracode` si ultracode está ON en la sesión
  (fuerza `run` + sube el modelo a Opus).
- **Modelo de los hunters (escalación por complejidad — 2026-07-06)**: el gate lo resuelve solo y lo devuelve
  en `model` + `model_reason`: `sonnet` default · story pesada (model-hint ≥2 señales) o ultracode → `opus`
  automático (anunciarlo en 1 línea). **Fable no se ofrece ni se pregunta**: corre
  sólo con `--deep-review-fable` en el comando, el pedido explícito de quien corre el pipeline.
  **Con la configuración de la organización** (`team-repos.json → models`): el `model` sale del gate igual
  —`models.adversarial.model`/`heavy`, el pedido de la corrida (`marker.js set-models adversarial=<x>`), el techo— y
  `model_reason` dice de dónde salió. `models.adversarial.fable_question` y la clave de la máquina
  (`adversarial.model_question`) se siguen leyendo e informando, pero ya no cambian nada. No elijas el modelo por tu
  cuenta: usá el que da el gate.
- **`run: false`** → **SKIP mecánico legítimo** (documentado, verificable — no es inferencia). Anunciarlo en 1 línea
  con el `reason` que devuelve el gate, anotarlo (abajo) y saltar al Step 6.

**En AMBOS casos** (corrió el workflow O skip), el step se cierra con su constancia — es lo que `pipeline.js next`
lee para saber que 5b fue atendido (si no, `next` te devuelve 5b de nuevo en loop). Ver §Cómo se cierra el 5b:

```bash
# corrió el workflow → su resultado (§Decisiones post-output):
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js mark-adversarial-result <N confirmados> --type 5b --result <RUN_DIR>/step-05b-adversarial.json --run <runId> --model <modelo> --classes <clases> --tests <k> …
# el gate dio run:false → el salteo (el comando le vuelve a preguntar al portón):
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js mark-adversarial-skipped --files <archivos de código del diff>
```

El gate (decisión "siempre en NORMAL"): **risk-class NORMAL → corre**; **LOW → skip** (superficie chica ≤6 files,
ya barata). Overrides, en precedencia: (1) `--no-deep-review` / `TYCON_NO_DEEP_REVIEW=1` kill-switch; (2)
`.tycon/advisors.yaml deep_review: always|off|auto`; (3) `--deep-review` / `--ultracode` fuerza on; (4) risk-class.

**Corre UNA sola vez por corrida** (lanzado al cierre del Step 4 — o acá como fallback), **NUNCA por cada
re-loop D.i** — re-correr el workflow sería ~N× su costo. Los fixes de sus findings los re-verifican los
advisors del re-loop (que sí re-corren). Audita el diff ORIGINAL del Step 4 a propósito (contrato vigente).
Doble seguro anti-relanzamiento: `deepReviewDone` (ya procesado) y el guard de `mark-adversarial-launched`
(ya lanzado en esta sesión → exit 2). La única re-invocación legítima es la adopción de un huérfano
cross-session (ver §JOIN arriba).

### Corrida liviana

Con la story liviana (sólo documentación), el portón da `run: false` con «corrida liviana» y el pase se cierra con
`marker.js mark-adversarial-skipped --files …`, como cualquier skip del portón. Mandan antes: el kill-switch,
`deep_review: off|always`, `--deep-review` y la superficie compartida (que además vuelve completa la corrida). Para
correrlo igual: `--deep-review`, o `marker.js set-size completa --reason "<por qué>"`.

## Acción — invocar el Workflow

Si `run: true`, armar `args.decisions` con las decisiones de diseño ya APROBADas de esta story (del bloque de
Completion Notes / HITL del Step 3 / Change Log — R1/R2/D3/etc.) para que los hunters **no las re-flaggeen**, y
invocar la tool `Workflow`:

> **Bajo Codex** (la sesión no tiene la tool `Workflow`): correr EL MISMO
> script vía el runner propio, EN SEGUNDO PLANO:
> `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/workflow-lite.js <mismo scriptPath> --args '<mismo JSON de args>' --out <RUN_DIR>/step-05b-adversarial.json`
> Todo lo demás del step es idéntico (marker, join, decisiones post-output). Paridad verificada
> con bug plantado confirmado por ambas vías. Sin resume cross-sesión:
> un workflow huérfano bajo codex cae SIEMPRE en la rama "relanzar" de este step.
> Sale 3 si el pase quedó **no medido** (§Pase no medido); el archivo de `--out` se escribe igual.

🔴 **El resultado se guarda en `<RUN_DIR>/step-05b-adversarial.json` en las dos rutas**: bajo Codex lo
escribe `workflow-lite.js --out`; con la herramienta Workflow, el orquestador escribe ahí, tal cual, el JSON que devolvió
la herramienta, ANTES de procesarlo. Es el archivo que se anota con `mark-adversarial-result --result`: trae el texto de
cada hallazgo (`detalle`), el estado de cada lente (`lentes`) y si el pase revisó todo (`medido`).

⚠️ `scriptPath` es un path LITERAL (la tool Workflow no expande `~`): pasá el ABSOLUTO
(`$HOME/.claude/agent-skills/skills/tycon-pipeline/scripts/adversarial-verify.workflow.js` con `$HOME` resuelto).

```
Workflow({
  scriptPath: "<$HOME>/.claude/agent-skills/skills/tycon-pipeline/scripts/adversarial-verify.workflow.js",
  args: {
    repo:      "<abs repo>",
    files:     ["<archivos de CÓDIGO del diff — no docs/fixtures>"],
    storyPath: "<abs story .md>",
    decisions: "<las decisiones aprobadas, textual — ej: 'D3: escanea solo $attrs bizuit:*; R2: sidecar fail-loud; ...'>",
    model:     "<el `model` que devolvió deep-review-gate: sonnet|opus — o 'fable' SOLO con --deep-review-fable>",
    runDir:    "<abs RUN_DIR — .advisors/pipeline-runs/<clave>-<sello>/ de ESTA corrida>",
    agrupar:   <false SÓLO si TYCON_5B_GROUP vale 0 — leela con la biblioteca del arnés, que acepta también su nombre viejo:
               `. "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/lib/legacy-names.sh"; legacy_env TYCON_5B_GROUP; echo "${TYCON_5B_GROUP:-}"`; si no, omitirlo>
  }
})
```

`runDir` es donde el verificador **guarda la prueba que confirmó** cada hallazgo:
`<RUN_DIR>/step-05b-probes/<lente>-<n>/` con los archivos de la prueba (con `.txt` agregado al
nombre, para que nada los compile) y un `COMO-SE-CORRIO.txt` con el comando y la salida. Si el
verificador borra la prueba al terminar, del hallazgo queda el relato y nunca el código: se pierde la
prueba que ya estaba lista para ser la de regresión. La carpeta de la corrida
está fuera de git por el `.gitignore` canónico (PIPE-C2): las pruebas traen código de cliente y no
viajan. Sin `runDir` (lanzado a mano) se guardan bajo `pipeline-runs/adversarial-sin-corrida/`.

El workflow corre 6 lentes de correctitud (traversal/completitud · determinismo · falso-negativo · falso-positivo/
edge · correctitud-algorítmica · integración/contratos); cada hunter lee el código real + corre probes, y cada
**CLASE de hallazgos** la **reproduce un skeptic** independiente (reproduce-or-refute, **default REFUTED** si no
reproduce → cero ruido). Devuelve `{ confirmed: [...], all_lenses: [...], probes_dir, hallazgos, clases, agentes_ahorrados, dudas, sin_veredicto, hallazgos_sin_veredicto, a_verificar_aparte }`; cada CONFIRMED trae `probe_dir`
(la carpeta con su prueba; `""` si el verificador no pudo guardarla — su `verify_reasoning` dice por
qué). Al terminar, anotar el resultado con `mark-adversarial-result` (§Decisiones post-output): eso cierra el 5b.

## Pase no medido

`agent()` devuelve `null` cuando un agente muere o no contesta lo pedido, en la herramienta Workflow y en
`workflow-lite.js` por igual. Antes el guion leía un cazador muerto como una lente sin hallazgos: con Codex en
su tope, un pase que no revisó nada salió «6 lentes limpias». Ahora:

- Una lente cuyo cazador no contestó queda **`sin-medir`** (en `lentes` y en `lentes_sin_medir`).
- Un hallazgo cuyo verificador no contestó queda **`sin-veredicto`** en `detalle`, con su texto entero. Nunca es
  refutado ni limpio.
- Con alguno de los dos, el pase sale **`medido: false`** y su `aviso` lo dice. **No medido no es verde**:
  `mark-adversarial-result` lo anota `no-medido` y no cierra el 5b, `complete-step 8` frena (`pase-no-medido`, y
  `DOD_BYPASS` no lo abre), `deep-review-gate` dice que corre (el salteo se niega) y `next` pide relanzarlo.
- Para destrabar: relanzar (`mark-adversarial-launched <runId nuevo> 5b --relaunch`) y anotar el resultado nuevo con
  `--result`. Abandonarlo sigue siendo una decisión del dev con el interruptor (`TYCON_NO_DEEP_REVIEW=1`, queda en
  `bypass.log`).
- Bajo Codex, `corredor.muertos` dice la causa de cada agente y la hora. Con el tope de uso no se reintenta y los
  agentes que faltan no se lanzan.

## Sin Codex ni Workflow: el pase propio con agentes de Claude

La salida aprobada cuando Codex no contesta y la sesión no tiene la herramienta Workflow:
**un pase propio con agentes de Claude — cazadores con Sonnet, un verificador aparte por hallazgo que corre el código,
juicio con Opus, nunca Fable**. Corre EL MISMO guion; `workflow-lite.js --agents-dir` no lanza nada: arma los pedidos y
lee las respuestas, y el archivo de resultado sale del guion, no se escribe a mano.

```bash
W=~/.claude/agent-skills/skills/tycon-pipeline/scripts
node $W/marker.js mark-adversarial-launched claude-<sello> 5b --relaunch   # --relaunch sólo si ya había un lanzamiento
# vuelta 1: deja seis pedidos (uno por cazador) y sale 3
node $W/workflow-lite.js $W/adversarial-verify.workflow.js --args '<mismo JSON de args, model: "sonnet">' \
  --out <RUN_DIR>/step-05b-adversarial.json --agents-dir <RUN_DIR>/step-05b-agentes
```

1. Leer `<RUN_DIR>/step-05b-agentes/PEDIDOS.json`: por cada pedido pendiente, lanzar UN `Agent(...)` de Claude
   (`model` del pedido: `sonnet`; en segundo plano, ventana de 3 vivos) con el texto de `prompt_file`, y la orden de
   escribir en `answer_file` SÓLO el JSON que pide `schema_file`.
2. Con todas las respuestas escritas, volver a correr el mismo comando. La segunda vuelta deja los pedidos de los
   verificadores (uno por clase de hallazgo, que reproduce o refuta corriendo el código); se lanzan igual.
3. Repetir hasta que el comando salga 0 y `PEDIDOS.json` quede vacío. El juicio lo hace la sesión (Opus): leer
   `detalle` y decidir qué se arregla.
4. Anotar como siempre: `mark-adversarial-result <N> --type 5b --result <RUN_DIR>/step-05b-adversarial.json …`. El
   resultado trae `corredor.nombre: agentes-claude`.

Una respuesta que falta o que no trae las claves del esquema cuenta como agente muerto: la lente queda sin medir o el
hallazgo sin veredicto, igual que con Codex.

## Superficie compartida — el 4to override del gate (2026-08-26)

`deep-review-gate` decidía por **tamaño de diff** (≤6 archivos → LOW → skip). Desde hoy, un repo
puede declarar qué carpetas son **superficie compartida** —código que corre en nombre de todos los
plugins/clientes a la vez, donde una falla no rompe una pantalla sino que se lleva puesto el proceso
del host— y un diff que las toca corre el pase adversarial **aunque sea chico**:

```yaml
# .tycon/advisors.yaml
deep_review_always_paths:
  - custom-forms/.../Services/Plugins/**
```

Precedencia completa que aplica el gate, en orden: kill-switch `--no-deep-review` → `deep_review:
always|off` del repo → `--deep-review` / `--ultracode` → **superficie compartida** → risk-class.
O sea: no pisa el freno del dev ni el `off` del dueño del repo, pero sí gana sobre el tamaño de diff.

Dos cosas que el orquestador tiene que saber leer del veredicto:

- `risk: "shared-surface"` — corrió por esto, no por NORMAL. El `reason` dice qué archivo matcheó y
  con qué patrón.
- `shared_surface_declared: false` — el repo **no declaró nada**, así que el skip por LOW se decidió
  sólo por tamaño. No es «no hacía falta»: es «no se sabe». Queda también en `gates.log`.

Por qué: con el skip decidido sólo por tamaño, un cambio chico sobre una superficie compartida se
mergea con la regresión que tumba al host, y el hotfix —también chico— vuelve a saltear el pase.

## 🔴 Dónde se escriben los probes (convención obligatoria)

Los hunters y los skeptics **ejecutan** el código: bundlean, parsean, corren un proceso, y a
propósito lo tumban (`EXIT=134`, `IsTerminating=True`). Para eso escriben archivos de prueba
descartables. Si el step no dice dónde, el default emergente es el peor: **dentro del proyecto de
tests del repo bajo revisión**. Dos daños medidos:

- **Un lente tiene que rodear el daño que otro le hace al working tree compartido.** `CS2001`/`CS0246`
  es el síntoma esperado de archivos `.cs` que aparecen y desaparecen del `<Compile Include>` implícito
  mientras otro proceso compila.
- **Los probes se cuelan en el estado del propio pipeline**: el `filesSnapshot` de una iteración queda
  con archivos `__probe*` / `_probe_*` que ningún humano escribió, y contaminan el insumo del re-loop
  de advisors.

### La regla

1. **Por default, el probe vive AFUERA del repo**: un proyecto propio en el scratchpad de la
   sesión que referencia el ensamblado **ya compilado** (`.dll`/`bundle`). No es teoría: medido en
   una corrida, **5 de los 6 lentes** ya lo hacían así por su cuenta — el camino limpio
   alcanza para casi todo.
2. **Sólo si el probe necesita el fixture de la suite** (un test xUnit que use el mismo
   `IClassFixture`, un `setup` de vitest) se escribe dentro del proyecto de tests, y entonces:
   - **nombre reservado** — `.NET`: `ZZProbe*.cs` / `ZZVerify*.cs` · `JS/TS`: `__probe*.test.*`
     / `_probe_*.test.*` / `__adv_probe*`. Los reconoce `lib/ledger-honesty.js` y por eso el
     pipeline los deja fuera de la foto de la iteración. **Un probe con nombre libre es un probe
     que el pipeline va a contar como trabajo del repo.**
   - **entrada en `.gitignore`** del repo.
   - **borrado en `finally`, no al final del camino feliz** — estos probes tumban el proceso a
     propósito, o sea que el camino feliz es exactamente el que no se ejecuta.
3. **Nunca se corre la suite completa desde un probe** (el candado anti-full-suite del 5b sigue
   valiendo).
4. **El guion corre parado fuera de cualquier repo, y git nunca va sin carpeta.** Si el laboratorio no se
   arma, las variables quedan vacías, y `git -C ""` —que **no cambia de carpeta**— crea ramas y commits en la
   copia de trabajo desde la que corre la sesión. Por eso cada
   agente del pase recibe, en el texto común del guion (`adversarial-verify.workflow.js`, «DÓNDE CORRE TU GUION»):
   laboratorio con `mktemp -d /tmp/…` (base fija), `set -euo pipefail` y cortar si no se armó, comprobar la
   carpeta antes de cada `git -C`, y el repo bajo revisión de sólo lectura para git. Red:
   `tests/adversarial-probes.test.js`.

### Por qué la convención sola no alcanzaba, y qué la respalda

Pedirlo en el prompt ya se intentó: la mención a «corpus real» estaba y el daño pasó igual. Por eso
la regla viene con un freno **mecánico** que no depende de que nadie se acuerde: `snapshot-iter`
excluye los nombres reservados del `filesSnapshot`, y el diagnóstico de registro ciego
(`lib/ledger-honesty.js`) no cuenta un probe como trabajo del repo. Red: `tests/ledger-honesty.test.js`
y `tests/smart-reloop-blindness.test.js`.

**Lo que esta convención NO resuelve**: dos pipelines corriendo a la vez sobre el mismo repo se
siguen pisando el working tree. La copia aislada por corrida (`isolation: 'worktree'`) se evaluó y
**se descartó como default**: paga instalación de dependencias de
cero en todas las corridas para un problema que sólo aparece con concurrencia. Si vas a correr dos
pipelines a la vez sobre el mismo repo, usá un worktree por story — `guides/git-worktrees.md`.

## Decisiones post-output

**Primero, cada CONFIRMED entra a la suite o se difiere con motivo.**
El verificador dejó la prueba que reprodujo el bug en su `probe_dir`; por cada hallazgo que se va a
arreglar en esta corrida, promoverla a la suite como prueba de regresión — archivo NUEVO, nombre real
del framework del repo (nunca `ZZProbe*`/`__probe*`: el pipeline los ignora):

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js promote-probe <probe_dir> --file <ZZProbeX.cs.txt> --a <tests/…/XRegresionTests.cs>
```

Después ajustala (nombre de clase, afirmar el comportamiento CORRECTO). Nace en rojo: el fix la pone
en verde y el test-gate del re-loop la corre. Lo que NO se arregla acá (código preexistente que va a
una story de seguimiento) se **difiere con motivo** y su `probe_dir`
queda citado en la story de seguimiento — no se promueve (entraría en rojo sin fix).

**O con una prueba escrita a mano** — cuando la regresión va mejor dentro de
una suite que ya existe (lo que `promote-probe` manda a hacer con «editalo a mano»), escribila ahí y
declarala como **propia**. Cuenta igual que una promovida, y tampoco se cree: el comando verifica que
cada ruta esté en el repo, exista, sea una prueba (el criterio del freno ATDD) y se haya editado en esta
corrida DESPUÉS del lanzamiento del pase (un evento de edición posterior, o la fecha del archivo
posterior: la edición por consola también cuenta). Una misma ruta cubre varios hallazgos. En una story de dos repos, la prueba puede vivir en el repo hermano si la corrida
editó ese repo: se anota como `(<repo>) <ruta>` —`<repo>` es el nombre del hermano declarado, una ruta relativa
al repo de la corrida (`../FrontEnd`) o el nombre de una carpeta vecina— o con la ruta absoluta. Sin esta casilla habría que anotar como «diferido» lo que
está arreglado con prueba. Igual que la promovida, se escribe ACÁ, al procesar el resultado y en
rojo: el fix del re-loop la pone en verde. Así el resultado se anota en el join y `next` avanza.

**Después, anotar el resultado** — una línea en `gates.log` con el número de confirmados,
de la que sale el veredicto (`listo` con 0, `no-listo` con más). Anotarlo **cierra el 5b** y
es lo que `complete-step 8` busca. Con confirmados, el comando **se niega** si no se declara el destino de
cada uno: `--tests k` tiene que coincidir con lo promovido para el lanzamiento vigente (tras un
relanzamiento, las del pase anterior no cuentan), `--own p` va con
`--in` (las rutas), `k + p + d = N`, y todo diferido lleva `--reason`:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js mark-adversarial-result <N confirmados> --type 5b --result <RUN_DIR>/step-05b-adversarial.json --run <runId> --model <modelo> --classes <clases> \
  --tests <k promovidas> [--own <p> --in "<ruta>[,<ruta>…]"] [--deferred <d> --reason "<por qué y a qué story>"]
```

🔴 **Vale también para toda revisión adversarial lanzada a mano** fuera del 5b —un «abogado del
diablo», un pase antes del push, uno después del cierre formal—: `--type revision`, y `--story <id>`
si la sesión no tiene corrida del pipeline. Por qué: si sólo las iteraciones de revisores dejan rastro,
una ronda hecha después del cierre formal que encuentra defectos graves no queda en ningún lado, y el
merge sale igual.

- **`confirmed` vacío** → anunciar "adversarial deep-verify: 0 CONFIRMED sobre 6 lentes" y seguir al Step 6.
- **`confirmed` con bugs** → tratarlos como findings del Step 6:
  - Cada uno cita su `lens` como "advisor" (`[adversarial-verify:<lens>]`), con `file:line` + `summary` + el
    `repro` observado. `severity: bug` → tratarlo como CRITICAL de correctitud; `robustness` → WARNING.
  - Aplicar los fixes (con el juicio del dev). Como es un cambio de código en respuesta a findings → **regla D.i**:
    volver al Step 5 (advisors, `smart-reloop --iter N+1`) sobre el diff actualizado. **NO** re-correr 5b (ya corrió).
  - La prueba de regresión de cada bug ya está en la suite (promovida arriba con `promote-probe`, o
    escrita a mano y declarada con `--own`); el fix la pone en verde. Un bug sin prueba que lo
    fije es un bug que vuelve.
  - Al escribir `<RUN_DIR>/step-05b-adversarial.md`, cada hallazgo lleva su `probe_dir` y, si se
    promovió, la ruta de su prueba en la suite.

## Un verificador por CAUSA, no por hallazgo

🔴 **Por qué, medido**: un pase abrió **25 agentes y 2.668.124 tokens**. Seis cazadores
reportaron **19 hallazgos que eran 9 problemas distintos** — el mismo defecto visto por varias lentes, con otra
redacción, y cada copia se llevó su propio verificador. Medido después sobre **14 pases** de la serie archivada
(`node scripts/metrics/adversarial-duplication.js` en el arnés): **el 40 % de los verificadores reproduce
algo que otro ya reprodujo**.

**Cómo corre el guion**: hay **barrera** (no `pipeline(LENSES, cazar, verificar)`, donde cada lente verifica lo
suyo apenas termina de cazar): cazan las 6 lentes, se juntan todos los hallazgos, se agrupan por causa
(`lib/group-findings.js`) y se abre **un escéptico por clase**, en una ventana de 3 (como mucho tres
vivos y, apenas termina uno, entra el siguiente — `lib/sliding-window.js`, copiada en el guion). El veredicto de la
clase baja a CADA hallazgo, con `clase`, `verificado_via` (cuál se reprodujo) y `agrupado_por` (por qué se juntaron).
Lo que se paga: la cola del cazador más lento, porque se pierde el solapamiento entre cazar y verificar.

**El criterio es conservador a propósito** — separar de más cuesta un agente; juntar de más PIERDE un defecto real y
el pase sale igual de verde. Sólo junta con **mismo archivo** + **misma línea declarada** (o, si ninguno declara línea,
el mismo identificador de código), y **veta por síntoma** si los dos tienen síntomas reconocidos y distintos. Una clase
es un clique: un hallazgo entra sólo si es compatible con todos sus miembros. Sobre un pase real: 19 → 12
clases, **cero hallazgos perdidos** (`scripts/tests/test-group-findings.js`, casos T3/T4/T5).

⚠️ El núcleo del criterio está **copiado literal** dentro de `adversarial-verify.workflow.js`: el guion corre en una
caja sin `require`. El caso `anti-deriva` de esa suite compara las dos copias carácter por carácter y se pone rojo si
se separan. Re-sincronizar: `node scripts/lib/group-findings.js --emit-core`.

**Cómo se apaga**: `TYCON_5B_GROUP=0` (o `agrupar: false` en los args del Workflow, que es como se lo pasa este step
cuando la variable está puesta — la tool Workflow no necesariamente le pasa el entorno al guion). Apagado, el pase se
comporta **exactamente** como antes: un verificador por hallazgo, y `agentes_ahorrados: 0`.

🔴 **`a_verificar_aparte` son hallazgos que NADIE miró.** El verificador reproduce UNO por clase; si al
hacerlo declara que los demás no eran el mismo defecto (`todos_el_mismo_defecto: false`, o cualquier
respuesta que no sea un `true` limpio), esos hallazgos **no heredan** su veredicto y salen en este
contador. No están confirmados ni refutados. Tratarlos como refutados es marcar como verificado algo
que nadie reprodujo — el defecto que el agrupamiento existe para NO cometer. Si vuelve
`a_verificar_aparte > 0`: relanzar el pase sobre ellos o verificarlos a mano antes de cerrar.

🔴 **`sin_veredicto` no es «refutado»**: son las clases cuyo verificador murió o no contestó JSON válido. Sus
hallazgos quedan `sin-veredicto` en `detalle`, con su texto, y el pase sale no medido (§Pase no medido): no se
confirman, pero tampoco se dan por limpios. No se cierra el 5b haciendo de cuenta que no había nada.

**Al cerrar el pase**, pasarle las causas al volcado para que el ratio se siga midiendo solo, y los
hallazgos que quedaron sin verificar para que no desaparezcan:
`mark-adversarial-result <N> --type 5b --classes <clases> [--separate <a_verificar_aparte>] …`.
⚠️ `--separate` hoy se ANOTA pero no frena el cierre: el freno
sigue siendo humano, leyendo el aviso del pase.

## check-count / accounting (no interfiere con los advisors)

El pase 5b es un **Workflow**, no spawns de `Agent` trackeados por `on-advisor-run.js` — por eso **NO** entra en el
`check-count` de los advisors (que valida el `expected[]` de advisors del Step 5). El step loguea aparte el runId del
workflow + el `confirmed` count en `.advisors/pipeline-runs/<clave>-<sello>/step-05b-adversarial.md`.

## Costo (honesto)

En NORMAL con `sonnet` (default), son ~6 hunters + M verifiers (M = nº de findings). Menos que una corrida Opus, pero
es una capa real de tokens. Escala con la cantidad de findings (más hallazgos → más skeptics). `--no-deep-review` es el
escape por corrida; `.tycon/advisors.yaml deep_review: off` lo apaga para un repo entero.

Escalación de modelo (2026-07-06): story pesada → Opus (~1.7x sonnet) automático — es el run donde el pase adversarial
más paga. Fable (~2x opus) no se ofrece: corre sólo con `--deep-review-fable` — ese nivel nunca se gasta en silencio.

## Output de este step

- `deep_review_ran: true|false` (+ `reason` del gate si false)
- `confirmed[]` (findings reproducidos, cada uno con su `probe_dir`) → insumo del Step 6
- `<RUN_DIR>/step-05b-probes/<lente>-<n>/` — la prueba que reprodujo cada CONFIRMED (no viaja por git)
- Log en `.advisors/pipeline-runs/<clave>-<sello>/step-05b-adversarial.md`

Pasar al Step 6 (los CONFIRMED se foldean al reporte consolidado).
