# Aprobar el plan

**Objetivo**: pedir aprobación explícita del usuario antes de que BMAD ejecute el plan.


> ⏱️ **Espera humana**: este paso es uno de los dos que miden cuánto se esperó a una
> persona. Antes de presentar el plan: cerrá el paso anterior y consultá `pipeline.js next` (anota el
> arranque del paso 3). Si se presenta primero y se cierra el anterior después, la espera queda
> contada como trabajo del paso anterior.

## Política Nivel 2 — auto-aprobación de planes LOW-risk

ANTES de pausar, correr:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js risk-class --story <story_path>
```

- **risk=LOW** (criterios: sin `.sql`/drizzle en scope, sin `signed_for_sprint` ni `signed_ac_ref`, ≤6 archivos en scope, sin paths auth/security/payment, sin bloque `pipelines:`) → el plan se **AUTO-APRUEBA** y continúa a Step 4 **sin esperar respuesta**. El gate adicional de backend "patrón de referencia verificado" (abajo) aplica igual antes de auto-aprobar.
- 📋 **El plan se muestra siempre, aunque se apruebe solo.** Es lo único que la persona ve de qué se va a hacer. Con
  LOW, el orden es: (1) el plan escrito en `step-02-bmad-plan.md` de la carpeta de la corrida; (2) **un mensaje de texto
  tuyo** con una línea «El plan se aprobó solo (riesgo bajo: <criterios en llano>)» y debajo ese plan tal cual, sin
  resumirlo — la persona no ve el archivo, ni la salida de los comandos, ni tu razonamiento: sólo tus mensajes;
  (3) recién después, `complete-step 3 --auto-approved`. El comando lee la conversación de la sesión y no cierra si el
  plan no está en tus mensajes. Si no puede leer la conversación (Codex, u otra herramienta que no la guarda), falla
  cerrado: el plan no se aprueba solo, se le muestra a la persona, se le pregunta y se cierra con `--approved`. Por
  qué: medido en la primera historia de un dev nuevo, con riesgo bajo el plan se aprobaba y no aparecía, aunque el
  cierre del paso lo imprimiera; el dev no veía qué se iba a hacer.
- 🗣️ **La pregunta a la persona trae el plan entero**: en tu mensaje o dentro de la pregunta con opciones (en su texto
  o en la vista previa de una opción). Nunca un «¿lo apruebo?» a secas. Cuando el comando frena, su salida normal trae
  el bloque «Mostrale esto a la persona» con el plan: copialo tal cual. Si creés que ya lo mostraste y el comando dice
  que no, no alcanza: escribilo de nuevo. Con riesgo bajo, `--approved` también comprueba que el plan se vio: si la
  conversación se lee y el plan no está en lo que la persona vio, no cierra. Por qué: medido en un laboratorio, el
  agente dijo que el plan ya estaba en sus mensajes sin haberlo mostrado, preguntó a secas y la persona aprobó sin
  verlo.
- 🖥️ **Si no lo mostraste, lo muestra el arnés.** En Claude Code, antes de que corra `complete-step 3`, el arnés le
  pone el plan en pantalla a la persona («El plan de la historia … (te lo muestra el arnés, tal cual está escrito)») y
  lo anota; el paso lo cuenta como mostrado. No reemplaza tu mensaje: si la persona pregunta por el plan, es ése. Por
  qué: en el mismo laboratorio el agente recibió el plan tres veces y no lo escribió nunca.
- **risk=NORMAL** → checkpoint HITL exactamente como se describe abajo.
- El user puede forzar HITL siempre con `warnings_pause: true` en `.tycon/advisors.yaml` del repo.
- 🔴 `git push` y cambios de scope firmado NUNCA se auto-aprueban — siguen human-gate sin excepción.
- 🖼️ **Excepción de pantalla**: si la story tiene pantalla (`risk-class` trae `mockup_required: true`),
  con LOW se anuncia el plan auto-aprobado pero **se espera la respuesta sobre la maqueta** (§La maqueta, abajo):
  una pantalla la ve una persona antes de construirla.

## Acción

Presentar al usuario:
1. El plan generado por BMAD en Step 2
2. La lista de archivos que va a modificar/crear
3. Pregunta explícita: "¿Apruebo el plan para proceder con la implementación?"

Usar la tool `AskUserQuestion` si está disponible, o simplemente pedir respuesta en texto.

## La maqueta (stories con pantalla)

Hoy la pantalla se ve recién construida, y un error de diseño se descubre cuando ya está programado. En una story que
agrega o cambia una pantalla, el pipeline arma una **maqueta**: un HTML local, de un archivo, sin red y sin código, con
los textos reales de la pantalla. Se aprueba junto con el plan, y la revisión de la pantalla (paso 7c.7, capas 9 y 10)
compara lo construido contra ella.

1. **¿Corre?** `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/mockup.js status --story <spec> --json`. Con
   `screen: false` este apartado no corre. Usa la misma detección que la revisión de la pantalla; si no puede leer la
   story, sale 2 (no es «sin pantalla»).
2. **Armarla**: el modelo (JSON) sale de la story y del plan: cada pantalla con su nombre y su estado (los de falla
   —vacío, error— van como otra pantalla), y cada elemento con su texto literal. La forma: `mockup.js schema`.
   ```bash
   node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/mockup.js render --data - --story <spec> --open <<'JSON'
   { ...el modelo... }
   JSON
   ```
   Sin `--out` la escribe donde la busca la revisión (`<carpeta qa>/<clave>-mockup.html`). Rechaza el texto de relleno
   (lorem ipsum, TBD, TODO, «...»): los textos son los que va a leer el usuario.
3. **Presentarla con el plan, en el chat**: la ruta del archivo y la lista de `mockup.js texts <ruta>` por pantalla. El
   navegador puede no abrirse (sesión remota, Linux sin escritorio, la jaula de Codex) o estar en otra máquina: la lista
   en el chat es lo que se aprueba seguro.
4. **La pregunta**: va en el mismo momento que la del plan. Con `AskUserQuestion` si está; sin ella (Codex), en texto
   con opciones numeradas: «1. Apruebo la maqueta · 2. Cambiá esto: … · 3. Cancelar». Con LOW el plan se anuncia
   auto-aprobado, pero la respuesta sobre la maqueta se espera igual.
5. **Quién la aprueba**: quien aprueba el plan. Es el dueño o, si el dueño dejó el modo autónomo, quien tenga su
   **delegación** (la coordinadora). La cita dice quién aprobó y por qué vía, por ejemplo «aprobada por la
   coordinadora, por delegación del dueño». El guion no valida quién es: la cita es la constancia.
6. **Cierre**: `complete-step 3 --approved "<cita del plan>" --mockup-approved "<cita de la maqueta>"` (o
   `--auto-approved "<criterios>" --mockup-approved "<cita>"` con LOW). Sin la maqueta, con una maqueta que no pasa
   `mockup.js check`, o sin `--mockup-approved`, el paso 3 no cierra. Queda la huella en el marcador y en
   `<clave>-mockup-approval.json` (sin la cita), que va en el commit con la maqueta.

Si la maqueta cambia después (un arreglo de legibilidad cambió un texto), se le muestra de nuevo a quien la aprueba y
`marker.js approve-mockup --approved "<cita>"`. Es el mismo comando si la story ganó una pantalla después de aprobar el
plan: el paso 8 lo frena hasta que esté.

## Superficie visual del plan (opt-in — `visual_plan`)

Es una superficie HTML offline (single-file, 0-deps, sin red) que renderiza el plan como
documento interactivo: objetivo, mapa de archivos, flujo, pasos con semáforo, snippets,
**preguntas abiertas** y el bloque de aprobación. El usuario marca/responde en el browser y
exporta su feedback por copy-paste. Reemplaza el patrón hosted de `BuilderIO/skills · visual-plan`
sin mandar nada a `plan.agent-native.com` — el plan del cliente NUNCA sale de la máquina.

**Cuándo se activa (las dos condiciones):**

1. **Opt-in**: el repo tiene `visual_plan: true` en `.tycon/advisors.yaml`, **o** el pipeline se
   invocó con el flag `--visual-plan`. Sin esto, presentar el plan en texto como siempre (default).
2. **Hay pausa HITL real**: `risk-class` dio **NORMAL** (con LOW el plan se auto-aprueba por G.i/Nivel 2
   y no hay nada que revisar visualmente → NO generar el HTML aunque el opt-in esté prendido).

**Flujo cuando aplica:**

1. Construir un JSON con el contenido del plan BMAD (Step 2). Schema: `node scripts/visual-plan.js schema`.
   Mapear: `objetivo`, `fileMap` (de la lista de archivos a crear/modificar), `tasks` (de las Tasks/Subtasks
   de la story), `flow` si el plan tiene un pipeline de datos claro, `code` para 1-2 snippets clave, y
   **`questions`** con las decisiones genuinas que el plan deja abiertas (contradicciones de la story,
   diferimientos a confirmar, ambigüedades de scope) — no inventar preguntas si no las hay.
2. Renderizar y abrir (`--open` lo abre el guion en el navegador, en Mac, Linux y Windows; si no puede,
   dice la ruta para abrirlo a mano):
   ```bash
   node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/visual-plan.js render \
     --data - --out .advisors/pipeline-runs/<clave>-<sello>/step-03-visual-plan.html \
     --story <spec.md> --open <<'JSON'
   { ...el JSON... }
   JSON
   ```
   `--story` autocompleta los pills (priority/sprint/epic/approach/ADO) desde el frontmatter.
3. Pedir al usuario que revise, marque y toque **"Exportar feedback"**, y **pegue el texto de vuelta**.
4. Parsear el feedback pegado: el campo **Decisión** mapea a las decisiones de abajo
   (`APROBADO…` → aprobado; `CAMBIOS…` → volver a Step 2 con las respuestas como feedback;
   `BLOQUEADO…` → tratar como cancelar/escalar). Las respuestas a las preguntas abiertas se
   incorporan al plan antes de ejecutar.

El plan en texto se sigue presentando como respaldo — el HTML es una superficie adicional, no
un reemplazo del registro textual del Step 2 (que queda en `step-02-bmad-plan.md`).

## Decisiones del usuario

- **"Sí" / "dale" / "adelante"**: proceder a Step 4.
- **"No" / "esperá" / "cambiá X"**: **volver a Step 2** con el feedback del usuario. BMAD re-itera el plan.
- **"cancelar" / "ya no"**: terminar el pipeline limpiamente. Registrar en el log de la corrida.

## Criterio de aprobación

**No asumir aprobación** por cualquier respuesta positiva ambigua. Si el usuario dice algo tipo "ok, pero..." o "sí, pero cambia...", tratar como cambio pedido, no como aprobación.

**Aprobación explícita** es requisito: palabras claras de "proceder" sin condiciones.

### Gate adicional para stories de backend — patrón de referencia verificado

🔴 Antes de presentar el plan al usuario, para una story de backend confirmar las dos condiciones:

- [ ] Toda decisión estructural del plan está respaldada por un patrón hermano **verificado** — `archivo:línea` (o `grep` con comando exacto) en NimboBackend / TotoraBackend / FRESNOBZExtBackend / el repo del framework, abierto/corrido y citado. **Ninguna decisión estructural se apoya en una asunción** ("asumo", "probablemente", "no pude confirmar").
- [ ] El plan es consistente con la sección "Patrón de referencia verificado" de la story (§9.2).

Si alguna no se cumple → **no presentar el plan como aprobable**: volver a Step 2 con el feedback "verificar el patrón hermano con evidencia dura antes de aprobar". El plan de un backend story con una decisión estructural sin patrón verificado **no se aprueba**: es el escenario del que sale un fix inventado.

### Gate adicional para toda story — lo que el plan agrega

Antes de presentar el plan, con cualquier stack:

- [ ] El plan enumera cada excepción, filtro, campo de respuesta y servicio/hook nuevo con el AC que lo declara; lo que no cite AC se le muestra al usuario y se suma a la story sólo con su visto bueno. Vale también con risk=LOW: si el plan trae algo sin AC, no se auto-aprueba (Nivel 2) — se presenta y se espera la respuesta. Es el momento barato: en el paso 4 el ejecutor no puede tocar los AC y lo no declarado lo frena el revisor de alcance (SPEC-C3/C5/C7/C9).

## Edge cases

- Si el plan toca más de 10 archivos: antes de preguntar aprobación, alertar explícito al usuario que es un cambio grande y preguntar si quiere subdividir.
- Si el plan incluye acciones destructivas (borrar archivos, cambios de schema DB): destacar en el prompt de aprobación.

## Cierre del step — la aprobación queda CITADA en el marker (2026-08-19)

🔒 El portón de carril DENIEGA cualquier Edit/Write de código del repo mientras el Step 3 siga pendiente en el marker. Cerrarlo exige decir quién aprobó:

```bash
# HITL — el user aprobó con palabras claras de proceder:
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js complete-step 3 --approved "<cita textual de la aprobación>"
# Nivel 2 — auto-aprobación: SOLO si risk-class = LOW (se verifica en proceso; si no es LOW, bloquea):
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js complete-step 3 --auto-approved "<criterios LOW cumplidos>"
# Story con pantalla (con cualquiera de los dos): además la aprobación de la maqueta (§La maqueta):
#   … --mockup-approved "<cita: quién aprobó la maqueta y por qué vía>"
```

Sin `--approved`/`--auto-approved` el comando bloquea; en una story con pantalla, también sin `--mockup-approved`. Queda en `marker.planApproval` y en `gates.log`. No se codea "mientras tanto": el orden es plan aprobado → tests (4.0 ATDD) → código.

### Quién aprobó: manual o automática

Cada aprobación queda además en `approvals.jsonl`, en la carpeta de la corrida, con qué se aprobó, cuándo, el commit,
el tipo y quién. Hay dos tipos:

- **manual**: la dio una persona con nombre. Se nombra con `--approved-by <correo o usuario>`.
- **automática**: la dio un agente (con cuál y su modelo) o una regla. Lo que aprueba un agente **por delegación** de
  una persona es automático: se anota con `--delegated-by <persona> --agent "<nombre> (<modelo>)"`, y la línea nombra
  de quién es la delegación. `--auto-approved` es la regla de riesgo bajo.

```bash
# la aprobó el dueño:
… complete-step 3 --approved "<cita>" --approved-by ana@example.com
# la aprobó la coordinadora por delegación del dueño:
… complete-step 3 --approved "<cita>" --delegated-by ana@example.com --agent "coordinadora (claude-opus-5-5)"
```

La aprobación de un agente nunca cuenta como la de una persona: un agente anotado con `--approved-by` queda
automático igual. Ante la duda, automática: **quien es persona se nombra con su correo** (un usuario suelto con nombre
de rol de agente, como «coordinadora» o «claude», queda automático; un correo `noreply` también).

El límite, dicho para que nadie le pida más: el registro distingue tipos, **no prueba identidad**. Un agente que escribe
el correo de una persona en `--approved-by` queda anotado como manual. Lo único firmado de verdad por una persona es lo
que pasa por la terminal (la firma de los AC imposibles de verificar, `runtime-waiver`). Sin `--approved-by` ni `--delegated-by`, la línea queda automática «sin nombrar». La maqueta la
aprueba quien aprobó el plan, en el mismo comando; `approve-mockup` acepta las mismas opciones. No se pide nada nuevo:
si la línea no se puede escribir, el marcador avisa y el paso sigue. El portón de CI la exige en el merge (ver
`guides/ci-gate.md`, «Registro de aprobaciones»). La misma forma vale para la exención de un CRITICAL al cerrar el
paso 7 (`complete-step 7 --approved-by …` o `--delegated-by …`); los AC firmados por terminal (`runtime-waiver`) son
manuales, a nombre del usuario de la terminal.

## Output de este step

- `approved: true|false`
- Feedback del usuario si pidió cambios
- Path al plan aprobado (para referencia en Step 4)
- `marker.planApproval` seteado (`complete-step 3 --approved|--auto-approved`) y la línea `plan` en `approvals.jsonl`

Pasar al Step 4 solo si `approved: true`.
