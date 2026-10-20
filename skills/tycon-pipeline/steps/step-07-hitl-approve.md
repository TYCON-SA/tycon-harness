# Hallazgos: la decisión

**Objetivo**: decidir si el pipeline se pausa para aprobación del usuario o fluye directo al commit prep.

**B.ii**: el checkpoint final solo pausa si hay
CRITICAL. Si el reporte tiene SOLO WARNINGs (cero CRITICAL), el pipeline **AUTO-FLUYE** a
Step 8 listándolos. Si todo OK, idem.


> ⏱️ **Espera humana**: este paso es uno de los dos que miden cuánto se esperó a una
> persona. Antes de presentar los hallazgos: cerrá el paso anterior y consultá `pipeline.js next` (anota el
> arranque del paso 7). Si se presenta primero y se cierra el anterior después, la espera queda
> contada como trabajo del paso anterior.

## Inputs

- `consolidated_report` del Step 6
- `has_critical: bool`
- `has_warning: bool`
- `.tycon/advisors.yaml` del repo (`auto_waive:` + `warnings_pause:`, si existe)

## Lógica de decisión

```
if has_critical:
    → MOSTRAR reporte completo
    → PAUSAR SIEMPRE: "Hay N CRITICAL. ¿Querés corregir antes del commit o hacer override?"
    → Esperar decisión del usuario
elif has_warning:
    → Auto-waive (con anuncio explícito) los warnings que:
        (a) tengan su rule ID en la lista `auto_waive:` de .tycon/advisors.yaml del repo, O
        (b) referencien líneas FUERA del diff (código pre-existente no tocado por la story)
    → si `warnings_pause: true` en .tycon/advisors.yaml (knob opt-out):
        → MOSTRAR reporte + PAUSAR (comportamiento pre-2026-06-09)
    → si no:
        → AUTO-FLUIR a Step 8, listando TODOS los warnings (incl. auto-waived, marcados)
          en el reporte consolidado Y en el cuerpo del commit message (sección
          "Warnings auto-waived" — ver step-08). Visibilidad sin fricción.
else:
    → Mostrar resumen "✅ Todo OK" (1-2 líneas)
    → NO PAUSAR — saltar directo a Step 8
```

**Los warnings auto-waived NUNCA se silencian**: quedan SIEMPRE listados en el reporte y en
el commit message, con la razón del waive (`auto_waive` list / fuera del diff). El auto-flow
quita la fricción, no la trazabilidad.

## Respuestas del usuario

### Si hay CRITICAL:

- **"corrijo"** → **NO se termina el pipeline**: se aplican los fixes y, por la regla D.i
  (no-negociable — los revisores auditaron la versión ANTERIOR al fix), se vuelve al Step 5 con
  `iteration: N+1` sobre el diff actualizado, siguiendo `step-07b-rerun-advisors-if-fixes.md`.
  🔴 `pipeline.js next` **hoy no conoce el 7b**: esa vuelta la aplica el orquestador por la regla,
  no por el mapa. Si el dev prefiere cortar acá y retomar después, el marker queda activo.
- **"override" (eximir el crítico)** → un crítico lo decide una persona: **el agente nunca se exime solo**, ni
  firmando como `orquestador`, ni con «hacé lo que recomiendes». Tres caminos, en este orden:
  1. **El ok del dev en el chat** (el principal). El crítico se lo muestra el arnés, no vos: corré
     `marker.js waive-critical --rule <regla> --file <archivo> --reason "<por qué>"` y, antes de que corra, el arnés le
     pone en pantalla un bloque «Te piden eximir un crítico» con la regla, su nombre en llano, el archivo, lo que dijo
     el revisor y tu motivo. El comando frena hasta que el dev conteste a ESE bloque. Si el bloque no apareció (la
     instalación mínima no trae la puerta de comandos), escribí con Write `exencion-pedida.json` en la carpeta de la
     corrida con `{ "rule", "file", "reason" }` y el arnés lo muestra. Con su respuesta,
     `marker.js waive-critical … --approved-by "<el dev>" --quote "<sus palabras, textuales>"`. La cita vale si está
     en un mensaje escrito por el dev (no en lo que escribiste vos, una herramienta, un subagente u otra sesión),
     **posterior a la muestra**, y si ese mensaje **dice que exime ese crítico**: una frase con «exim…» y su regla
     («eximo TEST-C1») o el nombre en llano que le enseñó el bloque («eximo la suite completa»); si la regla está en
     más de un archivo, también el archivo. Un «apruebo, seguí» o un «dale» suelto no exime: es un ok a algo, no a este crítico. Tampoco un ok de
     antes de la muestra, uno a otro crítico, una pregunta, ni uno con una negación o una condición en cualquier parte
     («no», «nunca», «si lo arreglás…»): ante la duda no exime, y el arnés dice qué escribir. Queda manual, con la cita y su hora.
  2. **Reenviado por la sesión coordinadora**, si la organización la declara en `approvals.relay_session` (perfil del
     equipo; por defecto ninguna): lo mismo con `--relayed-by <sesión>`. La cita tiene que llegar textual en un
     mensaje de esa sesión, posterior a la muestra y nombrando el crítico. Queda automático, por delegación del dev.
  3. **Desde su terminal**, si el dev prefiere: `marker.js waive-critical … --terminal` (lo corre el dev).

  Recién con la constancia, el hallazgo se anota `waived` en `pipeline.js write-findings`: sin ella, `write-findings`
  no escribe, y `complete-step 7` y `complete-step 8` frenan. Proceder a Step 8 con flag `had_override: true`.
  El límite: comprobar la cita prueba que el mensaje está en la conversación; no prueba quién está detrás de la
  sesión que reenvía.
- **"cancelar"** → terminar el pipeline.

### Si hay solo WARNING:

- Default (sin `warnings_pause: true`): **no hay pregunta** — auto-flow a Step 8 con los
  warnings anunciados y listados. Si el usuario interviene ("ajusto X") → volver a Step 4.
- Con `warnings_pause: true`: **"procedo" / "dale"** → Step 8; **"ajusto X"** → Step 4;
  **"cancelar"** → terminar el pipeline.

### Si todo OK (no hay checkpoint):

- Automático a Step 8 con mensaje breve: "Advisors OK. Preparando commit."

## Razón de diseño B.ii

Evitar HITL fatigue. Si cada story sin issues (o con warnings advisory) obliga al dev a
aprobar un reporte, después de 5 stories el dev aprueba sin leer. Mejor **silencio positivo
con trazabilidad**: si no hay CRITICAL, el pipeline fluye y los warnings viajan visibles en
reporte + commit message. CRITICAL pausa SIEMPRE — ahí sí hay decisión humana real.

## Persistir la disposición final en los Review Follow-ups (adopción BMAD 2026-07-02)

Cuando este step resuelve con una **disposición final** que avanza a Step 8 —un CRITICAL
**waived** por override, o WARNINGs que se dejan abiertos/diferidos— re-correr `write-followups`
con el `findings.json` actualizado (el que refleja la disposición final del Step 6/7), para que
la story registre en su body qué quedó waived/abierto:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js write-followups \
  --story <story_path> --findings <...>/findings.json
```

Así, si el pipeline avanza a commit con un CRITICAL waived, la próxima sesión ve ese waive en la
story (no solo en el pipeline log) y Step 0/1 lo levanta. Idempotente — si Step 6 ya lo escribió
esta corrida, re-correrlo solo actualiza dispociones. (En un re-loop D.i el write de Step 6 de la
siguiente iteración ya cubre esto; este write explícito es para el caso "waive + avanzar" sin
re-loop.)

## Cierre del step

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js complete-step 7
```

## Output de este step

- `should_proceed: true|false`
- `had_override: true|false` (si hubo override de CRITICAL)
- `auto_flowed_with_warnings: true|false` + lista de warnings (incl. auto-waived con razón) — Step 8 los incluye en el commit message
- `user_feedback` si pidió cambios

Con `should_proceed: true`, el próximo paso **NO es el 8**: primero el **7b** si hubo fixes (regla
D.i — volver al Step 5 con `iteration: N+1`; esa vuelta la aplica el orquestador, `next` no la
conoce), y después el **7c** (portón de «terminado» runtime), que es lo que `pipeline.js next`
indica. El Step 8 sólo se abre con el 7c cerrado.
