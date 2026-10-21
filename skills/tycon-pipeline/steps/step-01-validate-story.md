# Validar la historia

**Objetivo**: invocar el advisor `tycon-story-validator` sobre el path del story que el user pasó. Reportar issues. Si hay CRITICAL, pausar antes de seguir.

## Inputs

- `story_path`: path absoluto al archivo `.md` del story
- `repo_path`: path del repo donde se va a implementar (para verificar archivos referenciados)

## Pre-check — Review Follow-ups abiertos de una corrida previa (adopción BMAD 2026-07-02)

Antes de PROCESAR el reporte del validator (o antes de lanzarlo, si no hubo fan-out — con
fan-out el validator ya está en vuelo desde 0b), chequear si la story tiene review follow-ups de advisors sin resolver de una
corrida anterior (típico si un pipeline previo murió post-Step 6 con un CRITICAL waived o
WARNINGs abiertos). Es el gancho de detección del ciclo dev↔review-en-el-artefacto que adopta
`bmad-dev-story` (su Step 3 detecta la sección "Review Follow-ups (AI)" y **prioriza resolverla
antes que tasks nuevas**).

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js followups-status --story <story_path>
```

- **exit 0 / `has_section: false` o `open: 0`** → no hay deuda de review; seguir normal.
- **exit 3 / `open > 0`** → ANUNCIAR al user: *"Esta story tiene {open} review follow-up(s) de
  advisors sin resolver de una corrida previa: {items}. Los priorizamos antes de re-implementar
  (regla de bmad-dev-story: los follow-ups de revisión van antes que las tareas nuevas)."* El dev decide: resolverlos primero (marcar `[x]` al arreglar
  cada uno en el código) o waivearlos explícitamente. NO arrancar coding nuevo ignorándolos.

## Acción

**🔀 Fan-out del arranque (2026-07-30)**: los subagentes de este step se lanzan en background
**al principio de 0b** (después de emitir el aviso de trabajo y resolver lo que su acción pregunte — ver step-00b
§Fan-out), y 0b/0c completan inline mientras corren. Este step es entonces el **JOIN**: al llegar la
notificación del validator (y de los revisores de validación de los paquetes, si aplican), se procesan los reportes y las
decisiones de abajo. La reversión si acá se decide cancelar: cerrar el registro de horas (`work-signal stop`; si la
integración devuelve una acción, con descripción `[cancelado]`) y devolver el WI de ADO a su estado previo (los side-effects de 0b/0c
ya corrieron — mismo tratamiento que una cancelación en Step 3). Si por cualquier razón el
fan-out no ocurrió (0b/0c skippeados, orden secuencial), lanzar los subagentes acá como siempre.

1. Leer las reglas de la organización (el validador no corre comandos: se las pasa el pedido):
   ```bash
   node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js org-rules --story {story_path}
   ```
   e invocar el subagente `tycon-story-validator` usando la tool `Agent`, con `test_names`, `screen_test`, el veredicto
   de pantalla (`screen`: `ui` y `why`) y la ruta de la guía de historias (`story_format`, absoluta; el validador no
   corre comandos y con `~` adivina la carpeta personal) en el pedido. El veredicto lo calcula el mismo detector que los
   controles del cierre: el validador no lo deduce por su cuenta. Si `screen` es `null`, sacá del pedido la frase de la
   pantalla: el validador lo dice y no exige la fila de prueba de pantalla.
   Si `story_format` es `null`, sacá del pedido la frase «La guía de historias está en …»: el validador la busca solo y
   lo dice si no la encuentra.
   ```
   Agent(
     subagent_type: "tycon-story-validator",
     prompt: "Validar la story en {story_path} contra el repo {repo_path}. La guía de historias está en {story_format}. Reglas de la organización: test_names={test_names}, screen_test={screen_test}. La historia tiene pantalla según el arnés: {sí|no} ({screen.why}). Retornar reporte estructurado con severity CRITICAL/WARNING/OK por cada item del checklist Mary+GOLD."
   )
   ```

2. **Los revisores de validación de los paquetes** (lo decide el comando; el núcleo no nombra a
   ningún revisor de paquete):
   ```bash
   node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js validators --story {story_path} --repo {repo_path}
   ```
   Devuelve `validadores` (el validador de stories + los del grupo `validacion` de los paquetes
   activos cuya condición se cumple — hoy, con el paquete `clients` instalado, el revisor de plugins
   hermanos en toda story de backend: la story nombra `.cs`, o el repo tiene `*.csproj`/`*Plugin.cs`)
   y `lanzamientos`: por cada uno, `agente`, `prompt` ya rendido con los paths, `modelo` y `nota`.
   Invocar CADA lanzamiento **en el mismo mensaje paralelo** que el validador, tal cual viene:
   ```
   Agent(
     subagent_type: "{lanzamiento.agente}",
     model: "{lanzamiento.modelo}",
     prompt: "{lanzamiento.prompt}"
   )
   ```
   - `packs: []` en la salida = ningún paquete ACTIVO: corre sólo el validador, y eso se DICE en el anuncio
     con el motivo que trae `packs_nota` (que el equipo corra sin su paquete se ve en la primera corrida, no
     al mes). Son dos cosas distintas y la nota dice cuál: «ningún paquete instalado en <carpeta>», o «N
     paquetes instalados (…) y ninguno activo: packs.default es none y el repo no declara packs:» — lo
     segundo es una máquina del equipo SIN su perfil, no
     una máquina sin paquetes; el anuncio lo dice tal cual, nunca «no hay paquetes instalados».
   - Exit ≠ 0 = un paquete roto, o uno que el repo nombra en `packs:` y no está instalado: el comando
     dice archivo, revisor y motivo. **Se frena el paso**; no se «sigue sin él».
   - `tycon-story-validator` (`VAL-C8`) chequea que la sección «Patrón de referencia verificado»
     exista y que las anclas resuelvan; el revisor de validación del paquete confirma la semántica
     (el patrón citado está realmente en el código hermano, no es un "(asumo)"). Los dos gates juntos
     cierran el loop: una story de backend no avanza con un patrón asumido.

   - **`dependencias_de_pruebas`**: la misma salida trae lo que las pruebas de la story necesitan y el
     proyecto no declara —el proveedor de cobertura de vitest que exige el portón, `@playwright/test`, `@types/node` y
     `node` en `compilerOptions.types`, los paquetes `@scope/nombre` que la story nombra—, cada uno con `paquete`,
     `herramienta`, `motivo`, `caso` y `donde`. Lo calcula un programa, no el validador. Cada faltante se suma al reporte del
     paso como **`VAL-W18`** (WARNING: pausa como cualquier WARNING fuera de la whitelist, no bloquea). Una entrada
     `no_medido` («no medido: <archivo>, <motivo>») se muestra igual: es «no pude mirar», nunca «está todo». Lista
     vacía = no falta nada.

3. Recibir los reportes de los subagentes.

   **Cost tiering**: el `modelo` de cada lanzamiento viene del manifiesto del paquete (para el
   revisor de hermanos, `sonnet` de base: medido, con Opus era el spawn
   más caro del pre-flight, 2× Opus ≈ 200K tokens para confirmar anclas que VAL-C8 ya resolvía).
   La única excepción para pasar `model: "opus"` explícito viene en su `nota` (la story NO tiene
   sección «Patrón de referencia verificado» o sus anclas son dudosas/nuevas) — anunciarlo.

4. Los reportes de los subagentes YA llegan como resumen ejecutivo (su formato vive en la
   definición de cada agente — §"Cómo se devuelve un reporte" — y en la regla madre de comunicación
   del `CLAUDE.md`): **NO re-transcribirlos ni expandirlos**. Al chat va la conclusión en llano;
   el detalle queda a pedido.

## Decisiones

- **Si hay CRITICAL** (del validador de stories **o** de cualquier revisor de validación de un paquete): pausar. Decir al usuario: "la story tiene {N} issues CRITICAL — típicamente archivos/paths referenciados que no existen (`VAL-C1`), o la sección 'Patrón de referencia verificado' ausente / con anclas que no resuelven / basada en una asunción (`VAL-C8`), o un patrón hermano citado que no está realmente ahí (`XPAT-C1`/`XPAT-C3`). ¿Querés corregir la story antes de seguir o hacer override y proceder?"
  - Si el usuario pide corregir → bloquear el pipeline hasta que actualice la story y re-ejecute.
  - 🔴 **`VAL-C8` / `XPAT-C1` / `XPAT-C3` no se deberían waiver a la ligera**: significan que la story de backend no nace anclada a un patrón hermano verificado — la condición de la que sale un fix inventado. El camino correcto es corregir la story (abrir los archivos hermanos, citar el patrón real). Un override acá debe quedar registrado con justificación explícita del usuario en el pipeline log.
  - Si el usuario hace override → continuar a Step 2 con nota explícita en el pipeline log.

- **Si hay `VAL-W17`** (un criterio pide algo que el código ya hace): se trata antes que los demás warnings, porque
  puede volverlos irrelevantes. PAUSAR y mostrarle a la persona, en llano, cada criterio con el `archivo:línea` y lo
  que el código ya hace ahí (tal como lo trae el reporte, sin agregar ni sacar), y preguntar:
  ```
  Parte de lo que pide la historia ya lo hace el código:
  - Criterio {N}: ya lo hace {archivo}:{línea} — {qué hace}. {Entero | En parte: falta …}

  ¿Cómo seguimos?
  (a) Seguir igual: la historia queda como está
  (b) Ajustar la historia: saco o reescribo esos criterios y la vuelvo a validar
  (c) Descartar la historia: no hay nada que hacer
  ```
  - **(a) Seguir igual** → anotar `val_w17_acknowledged: <criterios>` en el log del paso y seguir con los demás warnings.
  - **(b) Ajustar** → reescribir los criterios con la persona, guardar la story y re-correr el validador.
  - **(c) Descartar** → `marker.js update-story-status <spec> abandoned`, el motivo en el Change Log de la story
    («el código ya lo hace: {archivo}:{línea}»), y terminar el pipeline (con la reversión de 0b/0c de arriba).
  Con modo autónomo y coordinadora, la pregunta va a quien aprueba (la coordinadora), no se decide sola.

- **Si hay WARNING (sin CRITICAL)**: chequear primero la **whitelist de formato cosmético**: si TODOS los warnings son `VAL-W1` (frontmatter incompleto no-contractual), `VAL-W2` o `VAL-W9` (reglas de formato puro) → el pipeline **AUTO-CONTINÚA** a Step 2 sin pausa, registrando `warnings_acknowledged: <lista de rule IDs>` en el log del step y listándolos en el anuncio al usuario. Si hay CUALQUIER warning fuera de la whitelist → PAUSAR y preguntar al usuario:
  ```
  La story tiene {N} warnings (no bloquean implementación pero afectan calidad/formato Mary+GOLD):

  {listar warnings con su rule ID y descripción breve, máximo 1 línea cada uno}

  ¿Cómo procedemos?
  (a) Arreglar los warnings antes de implementar (recomendado — re-escribir la story al formato canónico)
  (b) Continuar al Step 2 sin arreglar (los warnings quedan registrados en el log del pipeline)
  (c) Cancelar el pipeline
  ```

  Respuestas:
  - **(a) Arreglar** → arreglar la story (con base en la guía `story-format.md` y los rule IDs `VAL-W*` reportados), guardar el archivo, y re-correr el validator. Si después del fix queda OK → continuar Step 2. Si quedan warnings residuales → volver a preguntar.
  - **(b) Continuar** → registrar `warnings_acknowledged: true` y la lista de rule IDs en el pipeline log, continuar a Step 2.
  - **(c) Cancelar** → terminar pipeline.

- **Si todo OK**: proceder sin interrupciones.

## Edge cases

- Si el story no tiene frontmatter válido: el validator reporta un CRITICAL específico. Tratar como caso "corregir antes de seguir".
- Si el repo_path no se puede determinar: preguntar al usuario. No asumir `cwd`.

## Output de este step

- Path al reporte completo (puede guardarse en `.advisors/pipeline-runs/<clave>-<sello>/step-01-validator.md`).
- Flag `should_continue: true|false`.
- Flag `warnings_acknowledged: true|false` (opción b en el branch WARNING, o auto-continue por whitelist cosmética — en ese caso con la lista de rule IDs).
- Flag `story_was_fixed: true|false` (solo si se eligió opción a y el fix se completó in-line).

Pasar al Step 2 solo si `should_continue: true`.

## Cierre del step

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js complete-step 1
```
