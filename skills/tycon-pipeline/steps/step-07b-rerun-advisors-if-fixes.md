# Step 7b — Re-correr advisors si hubo fixes (decisión automática)

**Objetivo**: cerrar el loop post-Step 7 — si la decisión del usuario (o el auto-flow)
resultó en **fixes de código aplicados**, el diff que los advisors auditaron ya no es el
diff actual. NO se avanza a Step 7c/8 con auditoría vieja.

## Decisión (automática, sin preguntar)

```
si se aplicaron fixes de código tras Step 7:
  → GOTO Step 5 con iteration: N+1, usando:
    node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js smart-reloop \
      --iter N+1 --repo <repo_path> --story <story_path> --files <modified_files...>
  (el delta cubre re-ediciones vía fileEvents — escritos por on-edit.js desde
   2026-06-11 — con fallback por mtime de filesystem para markers sin fileEvents;
   los --files se VALIDAN: paths fantasma → abort exit 2, corregir el quoting.
   --force-full-reloop si se sospecha regresión silenciosa.
   🔴 APLICAR `reloop_model_hints` del output: pasar `model: <hint>` a cada
   Agent() — única excepción: el delta toca specs. Ver SKILL.md "Model hints".)
si NO hubo cambios de código:
  → continuar a Step 7c.
```

**Condición de exit del loop**: cero fixes nuevos en la iteración, O CRITICAL residuales
waiveados explícitamente por el user (con razón registrada — `had_override: true`).

**El validador de stories en el re-loop**: `smart-reloop` lo saca
del set cuando ya devolvió **dos veredictos limpios seguidos** después de implementar; lo dice en
`validador_reloop` y en `skipped`, y deja la línea `validador-reloop` en `gates.log` también cuando
decide invocarlo. No lo agregues a mano: si los chequeos sin modelo de VAL-C5/VAL-C6 encuentran algo,
o no se pueden leer sus veredictos, el script ya lo deja adentro. Con `--force-full-reloop` corre siempre.

## Al salir del loop: ¿el verde de la suite completa sigue midiendo ESTE código?

Antes de continuar a Step 7c, correr (barato — ~50ms, no ejecuta ningún test):

```
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/lib/suite-freshness.js check <repo_path>
```

- **exit 0 (FRESCO)** → el verde del cierre del Step 4 midió exactamente el código actual →
  continuar a Step 7c. Es el caso común (1 sola iteración, sin fixes): cero corridas extra.
- **exit 5 (STALE)** → hubo cambios de código desde ese verde: re-correr
  `test-gate.sh <repo_path> <story_path>` **UNA vez** (anunciando "suite completa, ~90s") y
  seguir con su resultado. Esta re-corrida ES la corrida del pipeline de
  `test-execution-discipline.md` regla 2, desplazada al código final — no una segunda: se paga
  una sola vez al converger, NUNCA una por iteración.
- **exit 6 (SIN DATOS)** → artefacto viejo (sin `code_state`), un freno, o repo sin git:
  avisar en una línea y continuar — el DoD checker (Step 7c) sigue de red, como hasta ahora.

**Por qué acá y no en cada iteración**: en una story que itera varias veces, el verde del Step 4
queda describiendo un código que ya no existe, y sin este chequeo lo detecta recién el DoD checker —
la segunda corrida completa hace falta igual, pero tarde y de casualidad. Chequear al SALIR del loop adelanta la
detección sin agregar corridas respecto de lo que ya pasaba, y el hash por contenido (index +
working tree) hace que commitear la story NO dispare un stale falso.

**La foto de cada iteración la toma el arnés solo**, al lanzar el último revisor de la vuelta (aviso
`📸`) — es lo que habilita el smart-reloop de la iteración siguiente. **No la repitas después de
arreglar**: si la llamás con código editado, se niega o conserva la anterior y lo deja en `gates.log`.
Sólo si el aviso no apareció (foto automática apagada) corré `snapshot-iter N` — antes de tocar código.

🔴 **Por qué el momento importa**: la foto es el estado AUDITADO, y el delta
de iter N+1 es "qué cambió desde esa foto". Si se fecha DESPUÉS de los arreglos, los arreglos quedan
adentro → el delta sale VACÍO → "todo skip por surface" → `--force-full-reloop` (el set completo, el
caso más caro). Y una llamada manual con código editado en el medio pisa la foto automática: los
revisores que miran ese código se saltean. Si `smart-reloop` devuelve
`suspect_empty_delta: true`, no saltes a force-full a ciegas; si además trae `suspect_late_snapshot:
true`, el delta ya se recalculó cortando por el último lanzamiento de revisores y esta vuelta incluye
lo que la foto había tapado.

🔴 **Cerrá la CLASE, no el síntoma (regla D.i.2)**: si un advisor reportó un finding de clase (mismo
hazard en varios sitios), aplicá TODOS los fixes de la clase en ESTA iteración antes de re-loopear — no
fixees el primer sitio y re-loopees, porque el advisor re-descubre el próximo sitio en la iteración
siguiente (whack-a-mole). Ver SKILL.md §D.i.2.

## Relación con la pre-condición de Step 8 (regla D.i)

La misma lógica GOTO vive como **pre-condición de último recurso en `step-08-commit-prep.md`**
(`diff_at_last_step_06 != diff_now` → STOP + GOTO Step 5 con iteration N+1). Este stub es la
referencia del flujo; la pre-condición de Step 8 atrapa el caso en que este step se haya
salteado por inferencia: sin ella, el Step 8 arranca sin re-auditar los fixes hechos después de los revisores.
