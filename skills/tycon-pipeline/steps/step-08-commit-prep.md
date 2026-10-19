# Preparar el commit

**Objetivo**: armar un mensaje de commit bien formado según las convenciones TYCON. **NO ejecuta `git commit`**. Deja el mensaje listo para que el dev lo revise y commitee manualmente.

## Inputs

- `story_id` y `story_title` del frontmatter del story
- `modified_files` del Step 4
- `consolidated_report` del Step 6 (para derivar el `what + why` del mensaje)
- `had_override` del Step 7 (si hubo override de CRITICAL, se anota)

## 🔴 PRE-CONDICIÓN — protocolo de cierre ACCOV-C7..C10

**Read obligatorio** (si no se leyó en Step 7c): `~/.claude/tycon-harness/guides/accov-governance-protocol.md`.
En particular **ACCOV-C7**: el cierre NO entrega un "checklist manual a probar" al user —
cada criterio de verificación que el agente definió debe estar automatizado (Playwright/xUnit/curl
del macro). Si el mensaje de cierre incluye "podés probar X, Y, Z", el pipeline falló.

## 🔴 PRE-CONDICIÓN OBLIGATORIA (regla D.i — re-loop advisors)

**Antes de armar el mensaje de commit**, verificar que **NO hay fixes pendientes desde la última corrida de advisors**. Esto es el contrato del Step 7b — si el dev aplicó cambios al código después del último Step 5/6, el orquestador DEBE volver al Step 5 (re-correr advisors paralelos) hasta convergencia O waiver explícito.

**Validación inmediata en este Step 8**:

```
diff_at_last_step_06 := snapshot del diff cuando se corrieron los advisors
diff_now := snapshot del diff actual

si diff_at_last_step_06 != diff_now:
  STOP — no seguir preparando el commit.
  Mensaje al usuario: "Detecté cambios al código desde la última corrida de revisores.
  Antes de armar el commit, vuelvo a «Revisores» para re-auditar el diff actualizado."
  GOTO «Revisores» con iteration: N+1.

si diff_at_last_step_06 == diff_now:
  Seguir preparando el commit.
```

**Por qué**: después de fixes mayores sobre lo que reportaron los advisors, arrancar el Step 8 SIN re-correrlos deja ese código nuevo sin auditar, y sólo lo nota una persona. El pipeline DEBE evitar este pattern automáticamente.

**Excepción**: si el cambio post-Step 6 fue **solo a archivos fuera del diff** (ej: editar `tasks/lessons.md`, `tasks/todo.md`, o el Change Log de la spec) sin tocar `src/` o `tests/`, no es necesario re-correr advisors. Documentar la excepción en `step-08-precondition-check.md`.

> El loop GOTO Step 5 post-fixes tiene su referencia de flujo en `step-07b-rerun-advisors-if-fixes.md` — esta pre-condición queda acá como validación de último recurso.

## 🔴 PRE-CONDICIÓN — checks del marker con provenance `run-check` (2026-06-09)

Los checks del marker (build/tests) deben estar **GREEN con `provenance: run-check`**
(seteados vía `marker.js run-check <name> -- <cmd>`, exit code real capturado).
Si algún check GREEN tiene `provenance: manual` (set-check directo), **anunciarlo
explícitamente en el commit prep** como:
`⚠ check '<name>' no verificado mecánicamente (provenance=manual — ver gates.log)`.
No bloquea, pero el dev tiene que verlo antes de commitear.

## 🔴 PRE-CONDICIÓN — matriz de verificación runtime VERDE (DODRT-C6, 2026-07-10)

`checks.acmatrix` debe estar **GREEN con `provenance: run-check`** (lo valida
`marker.js complete-step 8` — bloquea si falta). Se puebla en el sub-step 7c.6:

```bash
marker.js run-check acmatrix -- node <skill>/scripts/runtime-matrix.js --story <abs spec.md>
```

Si la matriz dio ROJO, la salida NO es "avanzar igual": los ACs `SIN CORRER` los corre el
agente (no se waivean) y los imposibles-declarados se le presentan al dev con la lista y el
resumen llano.
El waiver de los ACs imposibles-declarados lo firma **el dev desde su terminal**
(`marker.js runtime-waiver <abs spec.md>`, TTY-only) y vive en `.tycon/runtime-waivers.jsonl`
del repo de la story — **no en el frontmatter**. Se vence solo: está anclado al hash de la
declaración (`reason` + `covered_by`), así que si alguien reescribe la justificación hay que
volver a firmar.
Además, el commit message DEBE listar los ACs diferidos a prueba manual (visibilidad:
no desaparecen, viajan con el commit). Por qué: un `dod` verde con sólo una parte de los ACs
ejercitados se narra como "listo" si la lista no se muestra.

## 🔴 PRE-CONDICIÓN — findings.json del Step 6 presente

Antes de armar el mensaje, verificar que el `findings.json` del Step 6 existe (es el insumo
machine-parseable del `tycon-retrospective-capturer`; un write manual se olvida, por eso es
enforced acá):

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js findings-status \
  --story <story_path> --repo <repo>
```

🔴 **Desde el 2026-09-18 esto NO depende de que el orquestador se acuerde**: `marker.js complete-step 8`
lo computa él mismo (con el mismo `computeFindingsStatus`) y **BLOQUEA** si el run dir existe y el
archivo falta o no es un array. Medido antes de cablearlo: 4 de las 35 corridas desde el 01-09 no lo
dejaron, una de ellas ese mismo día. Sin run dir no bloquea —no hay dónde buscar— pero lo dice y lo
anota en `gates.log` (`name: findings-json`). Correr este comando igual sirve para verlo antes del gate.

- **exit 0** (`✅ findings.json presente`) → continuar.
- **exit 3** (`🛑 findings.json FALTA`) → escribirlo AHORA con `pipeline.js write-findings` (ver
  step-06 §findings.json — el array de findings sale del reporte consolidado del Step 6, con la
  `disposition` final de cada uno) y **después** correr `write-followups` para persistir los no-resueltos
  EN la story. Recién entonces seguir con el commit-prep. NO commitear sin el artefacto.

## 🔴 PRE-CONDICIÓN — el pase adversarial atendido

`marker.js complete-step 8` corre también el freno **`adversarial-result-gate`**, que se evalúa SIEMPRE
(aunque otro freno ya haya bloqueado: los dos mensajes salen juntos) y deja su línea en `gates.log`:

- **pase lanzado** → hace falta su resultado `--type 5b` anotado en o después del ÚLTIMO lanzamiento:
  ```bash
  node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js mark-adversarial-result <N confirmados> --type 5b --run <runId> --model <modelo> \
    --tests <k promovidas> [--own <p> --in "<rutas>"] [--deferred <d> --reason "<por qué>"]
  ```
  (un resultado de un lanzamiento anterior —pase relanzado— no cuenta: `resultado-de-otro-lanzamiento`).
- **pase no lanzado** → hace falta el salteo que decidió el portón:
  `marker.js mark-adversarial-skipped --files <archivos de código del diff>`.
- **ninguno de los dos** (incluida la bandera `deepReviewDone` de una corrida vieja, que se escribía a mano)
  → bloquea con `no-atendido`.

**No se abre con `DOD_BYPASS`**: el arreglo siempre está a mano y esa variable la puede poner el agente.
Por qué: medido en cuatro días, 4 de las 9 corridas con el pase lanzado cerraron el paso 8 sin su resultado.

## Formato del mensaje

Seguir `guides/git-commit-conventions.md`:

```
<tipo>(<scope>): <subject short>

<cuerpo explicando el qué y el por qué>

<trailers>
```

### Tipo

Derivar del frontmatter del story:
- Story con `approach: [CREATE]` → `feat`
- Story con `approach: [EXTRACT]` / `[ADAPT]` → `feat` si agrega capability nueva, `refactor` si reorganiza
- Story marcada como bug fix → `fix`
- Cambios de docs → `docs`

### Scope

Derivar del primer path modificado (ej: `Features/Voice` → scope `voice`).

### Subject

Primera línea corta (<72 chars) — tomar del `title` del story truncado.

### Cuerpo

Incluir:
- 1-2 líneas de qué hace la story (del "Como X, quiero Y, para Z")
- Resumen de los cambios principales
- ACs implementados (referenciados por número)
- Si `had_override: true`: línea explícita "OVERRIDE: CRITICAL de {advisor} aprobado por usuario — razón: {razón}"
- Si Step 7 auto-fluyó con warnings (`auto_flowed_with_warnings: true`): sección **"Warnings auto-waived"** listando cada warning (rule ID + archivo + razón del waive: `auto_waive` list / fuera del diff). Visibilidad sin fricción.

### Trailers

Siempre agregar (línea en blanco separada) el trailer `Co-Authored-By:` con **el modelo
exacto que implementó**, tal como lo informa la sesión — bajo Codex, el modelo gpt que corresponda
(regla canónica: `~/.claude/tycon-harness/guides/git-commit-conventions.md`). Nunca el de un ejemplo:

```
Co-Authored-By: <modelo exacto de la sesión> <noreply@anthropic.com>
```

## Acción

1. Armar el mensaje completo con el formato de arriba.

2. Mostrar al usuario:
   ```
   Listo. Mensaje de commit preparado:

   ```
   {mensaje aquí}
   ```

   Archivos a commitear: {lista}
   (story con maqueta aprobada: van también `<carpeta qa>/<clave>-mockup.html` y
   `<clave>-mockup-approval.json`; tienen que viajar con la story para que la revisión de la pantalla los encuentre)

   Para commitear, correr:
   git add {archivos}
   git commit -m "$(cat <<'EOF'
   {mensaje completo}
   EOF
   )"

   O pedíme a mí que lo ejecute (requiere tu confirmación explícita según `guides/git-commit-conventions.md`).
   ```

3. **NO ejecutar `git commit` ni `git push` automático.** Esperar instrucción explícita del usuario.

## Decisiones

- **Si el usuario dice "commiteá"**: ejecutar `git commit` con el mensaje. No `git push` (eso es separado).
- **Si el usuario dice "push"**: ejecutar después del commit.
- **Si el usuario dice "no, cambiá X del mensaje"**: editar y re-mostrar.
- **Si el usuario no responde**: esperar. No hacer nada proactivo.

## Post-commit

Si el usuario commitea y mergea a main (vía `/tycon-merge-to-main` o manual):
- La métrica del merge la escribe el **latido** en el paso 10b del skill de merge (`scripts/metrics/retro-heartbeat.js` del arnés: un segundo, sin modelo); `retro-pending.js` no deja cerrar el turno sin ese archivo. El `tycon-retrospective-capturer` queda a pedido («retro con modelo»): no corre en cada push.
- 🔴 **Los aprendizajes a engram se guardan ACÁ, al cierre de la story** — no en cada push: `mem_save(project: <canónico>, …)` con las decisiones, gotchas y hallazgos no obvios de esta corrida (lo que los revisores cazaron, lo que la salvaguarda corrigió, lo que costó más de lo esperado). Es el único momento con la conversación completa a mano; el latido no lee nada de eso y el agente de retro ya no se lanza solo.

## Definition of Done — recordatorio crítico

**El pipeline TYCON termina aquí con el commit hecho, pero la story sigue en status `review` (NO `done`).**

Antes de transicionar `review` → `done` (o mergear a main como "story terminada"), el dev DEBE ejecutar el checklist de:

📖 **`~/.claude/tycon-harness/guides/definition-of-done.md`**

Resumen ejecutivo del gate (no skipear):

1. **Smoke check runtime** — `curl` real contra cada endpoint que la story toca, contra DevHost levantado, con auth. Verificar HTTP 200 esperado, NO 400/500.
2. **E2E fail-loud** — correr Playwright con la env var `*_REQUIRED=1` apropiada (e.g. `E2E_AUDIT_REQUIRED=1`). Si los tests skipean en este modo, hay un bug oculto.
3. **Dev panel** (si existe `dev.html`) — abrirlo y verificar que los botones de health-check estén verdes.
4. **Verificación cruzada** — si la story `depends_on` otra que está en `review`/`done`, validar runtime que sus artifacts siguen funcionando.

**Anti-pattern explícito**: marcar `done` solo porque "build verde + tests verdes" es insuficiente. El patrón `skip-on-not-ok` en specs E2E puede esconder bugs reales del backend (por ejemplo, una configuración del backend que causa un 400 silencioso).

**Output del recordatorio en la salida del pipeline**: el recordatorio de DoD va en el cierre, en UNA
línea — ver la sección "Output del pipeline al usuario" abajo, que es la fuente única del formato de
cierre (regla COMM.ii). El bloque de 5 líneas que estaba acá quedó consolidado allá; no repetir ambos.

## Output de este step

- `commit_message` (texto completo)
- `status: prepared | committed | committed-and-pushed`

Fin de la preparación del commit. 🔴 **El step NO termina acá**: faltan las tres secciones de abajo
(el timer de Clockify NO se cierra · `marker.js clear` · dejar la story en `status: review`). Recién
con las tres el step está cerrado.

## 🚨 CRITICAL — NO cerrar el clocki timer

**El pipeline NO cierra el timer de Clockify al finalizar Step 8.** Este es un error
recurrente que rompe el tracking de horas reales.

**Reglas explícitas (NO violar):**

1. **NO ejecutar** `mcp__clockify__update-clockify-time-entry` (bajo Codex: `..._update_clockify_time_entry` con guiones bajos) con un `end` que sea el
   tiempo actual al final del pipeline. El timer queda **running**.
2. **NO borrar** `~/.claude/clocki/active.json` al terminar Step 8. El estado local
   refleja que sigue activo.
3. El timer **solo se cierra** en estas 4 condiciones, en este orden de precedencia:
   - **(a)** El usuario tipea explícitamente `/clocki stop` → cerrar con `end = lastActivity`.
   - **(b)** El usuario arranca otra tarea con `/clocki start "..."` o invoca otra
     story con `tycon-pipeline` → el `clocki:start` del nuevo flujo **cierra el previo**
     automáticamente (ver `~/.claude/skills/clocki/SKILL.md` flujo `start` paso 2).
   - **(c)** El sweep idle del hook (15min sin activity) lo cierra retroactivamente
     a `lastActivity`.
   - **(d)** El **Step 9** cierra la story en ADO (`step-09-ado-story-closure.md` §"cerrar clocki
     timer"). Ahí sí terminó el trabajo lógico, y por eso es la única vía del pipeline que lo cierra.

**Por qué importa:** después del commit pipeline, el usuario suele pedir trabajo
adicional (smoke check DoD Gate 2, debugging, ajustes a la spec, integration tests
fix-up). Si el timer ya se cerró, ese trabajo no se trackea y el dev pierde horas
facturables.

**Patrón observado (2026-05-12):** post-Step 8 commit prep, Claude cerró el timer
"por prolijidad". Después el usuario pidió 27min adicionales de DoD smoke + commits +
integration tests, todos sin tracking. Tuvo que recuperarse manualmente con un entry
retroactivo. **No vuelva a pasar.**

## Output del pipeline al usuario (cierre ejecutivo — regla COMM.ii)

**Fuente única del formato de cierre.** Antes eran 3 bloques fijos de ~20 líneas que se repetían
idénticos en cada corrida y enterraban el resumen real (feedback del dev 2026-07-25). Ahora:

```markdown
**{Story id} lista.** {UNA frase en llano: qué hace ahora el sistema que antes no hacía.}

- {qué cambió de comportamiento observable, en llano}
- {qué se verificó DE VERDAD — corrido, no leído: "la suite pasó entera", "el endpoint respondió 200 contra DevHost"}
- {qué quedó pendiente o diferido, si hay algo}
- Advisors: {🟢 limpio | 🟡 N warnings, ninguno bloqueante}

Está listo para commitear — decime y lo hago.

Pendiente tuyo: smoke check de DoD antes de pasarla a `done` (build verde no alcanza) · timer de clocki sigue abierto · el cierre en ADO va después del merge.
Detalle técnico (findings, archivos, mensaje de commit completo) — pedímelo y te lo pego.
```

**Story de pantalla: el dev la VE antes de pedir el commit.** 🔴 Por qué (2026-10-14): si el cierre entrega
sólo el mensaje de commit, una pantalla inentendible pasa todos los controles y se ve recién en staging. Para una story de pantalla (la que pide la guía del tester), antes de pedir el commit:
listar las capturas de la sección `## Capturas` de la ÚLTIMA evidencia del gate E2E de la story (carpeta de
evidencia, `<sid>-e2e-gate-<ts>.md`) como enlaces que se abren con un clic —un enlace markdown por captura con la
ruta ABSOLUTA, `[01-la-lista](/ruta/absoluta/01-la-lista.png)`: el editor lo abre al tocarlo y en la terminal
queda la ruta para copiar—, y debajo la línea
**«Así se ve: ¿se entiende?»**. Sin capturas, esa misma línea dice el motivo que trae la evidencia. Va arriba del
«Está listo para commitear», no en el detalle diferido.

**Reglas del cierre:**

- **Máximo ~10 líneas** salvo que haya CRITICAL sin resolver (ahí manda COMM.i) o algo haya fallado.
- **El mensaje de commit SÍ va completo al chat** — es lo que el dev tiene que leer para aprobar.
  Es la única excepción al "detalle a pedido".
- **Los 3 recordatorios (DoD / clocki / ADO) van en UNA línea combinada**, no en 3 bloques con
  emoji y sangría. El contenido normativo no cambia — sigue vigente todo lo de arriba (el timer NO
  se cierra, el DoD es obligatorio, ADO se cierra post-merge); lo que cambia es cuánto espacio ocupan.
- **Sin conteos de líneas, sin listas de archivos tocados, sin rule IDs** en el cierre. Todo eso
  vive en `.advisors/pipeline-runs/<run-dir>/` y en el diff.

## 🟢 Limpieza del marker file (MANDATORY post-2026-05-15)

Una vez que el commit message fue presentado al user y aprobado (`marker.js complete-step 8` ya quedó marcado), **limpiar el marker del pipeline** para que los hooks dejen de emitir reminders sobre esta story:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js clear
```

Si el flujo va straight a Step 9 (ADO closure) sin pausa, el clear ocurre allá. Si el flujo termina en Step 8 (commit prep + dev decide commitear/no commitear manualmente), clear acá.

### Si el cierre ofreció la instalación completa

La primera vez que una máquina nueva con la instalación mínima cierra una historia, `marker.js clear` imprime una
oferta: un título, tres renglones (qué cambia, dónde, cómo se vuelve atrás) y las dos órdenes para contestar. Sale una
sola vez por máquina y la decide el cierre, no vos.

1. Mostrá el título y los tres renglones **tal cual**, sin resumirlos ni agregarles nada, y preguntá sí o no (con
   `AskUserQuestion` bajo Claude Code; con una pregunta llana en otra herramienta). La recomendación no la das vos: es
   decisión de la persona.
2. Con «sí», corré la orden de `offer accept` que imprimió el cierre (instala la completa; la salida dice si terminó).
   Con «no», la de `offer decline` (queda anotado y no se vuelve a ofrecer).
3. Sin respuesta, no insistas: la oferta ya quedó anotada como mostrada.

No se ofrece ni se pregunta en otro momento: si el cierre no imprimió la oferta, no hay nada que hacer. Si imprimió un
solo renglón con la orden (sesión sin persona delante), no se pregunta: se deja el renglón en el cierre.

**Salteable** si el dev pidió pausa explícita ("dejá el marker, voy a iterar más") — pero entonces el marker queda activo y los hooks van a seguir recordando los steps pendientes hasta que se complete el flujo o se cleane manualmente.

## 🟢 Setear `status: review` en el frontmatter (MANDATORY fix robusto 2026-05-20)

Tras `marker.js clear`, mutar el frontmatter de la story de `in-progress` a `review`. Source of truth durable cross-sesión:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js update-story-status \
  "$STORY_PATH" "review"
```

**Por qué**: si el flujo termina en Step 8 (no llega a Step 9 ADO closure), la story queda lista para review pero el `status:` previo (`in-progress`) reflejaría mal el estado real. Otra sesión que abra `tycon-pipeline` sobre esta story va a leer `review` y NO va a re-arrancar Step 0 (PIPE-C5 lo detecta).

**Si Step 9 (ADO closure) sigue inmediatamente** después de Step 8: el `status: review` se sobreescribe a `done` allá. NO es un step opcional saltearlo — siempre mutá `review` acá aunque vayas a Step 9 después; el costo del double-write es trivial y deja el log de mutación más auditable.

**Si el update falla** (frontmatter sin línea `status:` por algún motivo raro): WARNING al usuario pero NO bloquear el commit prep — el dev puede setearlo manualmente.
