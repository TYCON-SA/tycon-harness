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

- **risk=LOW** (criterios: sin `.sql`/drizzle en scope, sin `signed_for_sprint` ni `signed_ac_ref`, ≤6 archivos en scope, sin paths auth/security/payment, sin bloque `pipelines:`) → el plan se **AUTO-APRUEBA**: anunciar al user "Plan auto-aprobado (Nivel 2, story LOW-risk: <criterios>)", listar el plan completo, y continuar a Step 4 **sin esperar respuesta**. El gate adicional de backend "patrón de referencia verificado" (abajo) aplica igual antes de auto-aprobar.
- **risk=NORMAL** → checkpoint HITL exactamente como se describe abajo.
- El user puede forzar HITL siempre con `warnings_pause: true` en `.tycon/advisors.yaml` del repo.
- 🔴 `git push` y cambios de scope firmado NUNCA se auto-aprueban — siguen human-gate sin excepción.

## Acción

Presentar al usuario:
1. El plan generado por BMAD en Step 2
2. La lista de archivos que va a modificar/crear
3. Pregunta explícita: "¿Apruebo el plan para proceder con la implementación?"

Usar la tool `AskUserQuestion` si está disponible, o simplemente pedir respuesta en texto.

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
```

Sin `--approved`/`--auto-approved` el comando bloquea. Queda en `marker.planApproval` y en `gates.log`. No se codea "mientras tanto": el orden es plan aprobado → tests (4.0 ATDD) → código.

## Output de este step

- `approved: true|false`
- Feedback del usuario si pidió cambios
- Path al plan aprobado (para referencia en Step 4)
- `marker.planApproval` seteado (`complete-step 3 --approved|--auto-approved`)

Pasar al Step 4 solo si `approved: true`.
