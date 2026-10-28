# Hallazgos

**Objetivo**: un solo paso: (1) juntar los outputs de los revisores en un informe, (2) escribir `findings.json` con `pipeline.js write-findings`, y (3) frenar para la persona SÓLO si hay críticos. Aquí NO corre nada nuevo: es lógica del orquestador. Las dos partes de abajo («El informe» y «La decisión») eran antes dos pasos.

> ⏱️ **Espera humana**: este paso mide cuánto se esperó a una persona, y sólo cuenta cuando de verdad pregunta (la anota sola el Stop-hook o la pregunta). Antes de presentar los hallazgos: cerrá «Pase adversarial» y consultá `pipeline.js next`. Si se presenta primero y se cierra el anterior después, la espera queda contada como trabajo del paso anterior.

# El informe

## Inputs

- `advisor_reports[]`: lista de reportes individuales de «Revisores»
- `adversarial_confirmed[]` (si «Pase adversarial» corrió): los findings CONFIRMED del pase reproduce-or-refute. Se
  foldean al reporte como una "fuente" más: cada uno se cita `[adversarial-verify:<lens>]` con `file:line` +
  `summary` + el `repro` observado. `severity: bug` → cuenta como **CRITICAL de correctitud**; `robustness` →
  WARNING. Disparan el re-loop D.i igual que un finding de advisor (pero el pase adversarial NO se re-corre — ver `step-08-adversarial-pass.md`).

## Lógica de consolidación

**Formato uniforme**: TODOS los advisors emiten el mismo formato markdown
(`# {advisor}` + `**Status**: 🔴/🟡/✅` + secciones `## 🔴 CRITICAL` / `## 🟡 WARNING` con
items `- [RULE-ID] ...`). Ya NO hay advisors que emitan JSON — el parseo es uno solo, no
"JSON o markdown según el advisor".

Para cada reporte de advisor, parsear:
- Count de `CRITICAL` (items bajo `## 🔴 CRITICAL`)
- Count de `WARNING` (items bajo `## 🟡 WARNING`)
- Lista de items `CRITICAL`
- Lista de items `WARNING`
- Lista de items `OK` (opcional en el reporte final)

## Cómo se refuta un hallazgo (un «falso» lo confirma otro, corriendo el código)

Quien implementó puede proponer que un hallazgo es falso, pero no lo decide: `refuted` sólo se escribe con la constancia
de un verificador independiente. Sin ella `write-findings` lo deja `open` y lo dice.

1. Escribí el hallazgo en un JSON: `{reviewer, rule, file, line, summary, author_reason}` (el motivo es el tuyo).
2. `pipeline.js verify-finding --finding <json> --repo <repo> [--model opus]` imprime el lanzamiento: lanzá UN agente
   `general-purpose` con ese prompt y modelo. El verificador corre el código y devuelve `{refuted, command, output}`; ante
   la duda, `refuted: false`.
3. `pipeline.js record-refutation --finding <json> --result <json> --verifier <agente@ts> --verifier-model <m> --run-dir <corrida>`
   valida la constancia (el verificador tiene que figurar en el registro de spawns y no ser quien implementó) y la guarda
   en `<corrida>/refutations/`. `<agente@ts>` es el agente y la hora de su lanzamiento en ese registro.
4. Después, `write-findings`: con veredicto `refutado` acepta `refuted`; con `reproducido` el hallazgo es real y queda
   `fixed` u `open`, nunca `refuted` ni `waived` (la escritura se rechaza). El `fixed` de un hallazgo reproducido
   exige su prueba: agregá al hallazgo `test` con la ruta o el nombre de la prueba que lo cubre (`"test": "tests/a.test.js::devuelve 403"`);
   sin ella queda `open` y lo dice.

`write-findings` vuelve a revisar la constancia, no confía en que `record-refutation` la haya dejado bien: el verificador tiene que
figurar en el registro de spawns, y el roster tiene que poder leerse para saber quién implementó. Si cualquiera de los dos no se
puede leer, lo dice («no se pudo verificar quién verificó / quién implementó») y el `refuted` queda `open`. Una constancia
que está pero no se puede leer («constancia ilegible») no es «sin constancia»: `refuted` y `waived` se rechazan, porque no
se puede descartar que diga «reproducido». En `findings.json` el comando va acotado a 200 caracteres y sin credenciales;
la constancia completa queda en `<corrida>/refutations/`.

Sin verificador disponible el hallazgo queda `open`: nunca «falso» por omisión. `write-findings` también avisa
«marcado para revisión» cuando un revisor tiene más del 30 % de falsos confirmados en las últimas 20 corridas: ponelo en el
informe de Hallazgos. No se apaga a nadie por eso; lo decide una persona.

## Formato del reporte consolidado (ARTEFACTO — no es el mensaje al chat)

🔴 **Leer antes de usar este formato (regla COMM.ii del SKILL.md)**: lo que sigue es el formato del
**archivo** `step-06-consolidated-report.md` que se escribe en `.advisors/pipeline-runs/<run-dir>/`.
Es la auditoría: va completo, con todos los rule IDs, `file:line` y fixes. **NO se vuelca al chat.**

Al chat va un **resumen ejecutivo de 3-6 bullets en castellano llano** (ver "Qué va al chat" abajo).
El volcado crudo de este reporte al chat es un anti-pattern explícito — enterraba el resumen real.

```markdown
# Advisor Report — Story {story_id}

**Status**: {🟢 OK / 🟡 N WARNING / 🔴 N CRITICAL}
**Advisors que corrieron**: {N}/{total}
**Tiempo total**: {s}s

---

## 🔴 CRITICAL (N)

{Por cada CRITICAL, formato "- [advisor-name] {mensaje}"}

### Ejemplos (con rule ID citado):
- [SEC-C1] `Features/Voice/PacaraService.cs:147` callId interpolado raw en URL. Fix: `Uri.EscapeDataString(callId)` + route constraint `{callId:guid}`.
- [DOTNET-C2] `Features/Auth/AuthEndpoints.cs:18` `HttpContext.User.FindFirst("sub")` usado. Fix: inyectar `IUserIdResolver` y usar `GetRequiredUserIdAsync()`.
- [TEST-C2] `PacaraService.IniciarLlamadaVozAsync` (línea 124) tiene 0% coverage. Fix: mockear `HttpMessageHandler`, no el service.

**Regla crítica del reporte consolidado**: todo finding DEBE citar su rule ID entre corchetes al inicio (ver `guides/advisor-rules-catalog.md`). Si un advisor reportó un finding sin rule ID, el consolidator lo marca como `[NO-ID]` y agrega una nota al final del reporte indicando que el advisor está mal calibrado.

## 🟡 WARNING (N)

{Agrupados por advisor, formato "### tycon-plugin-X \n - item1 \n - item2"}

### Ejemplo:
### tycon-plugin-tests-coverage
- AC3 (rate-limiting) no tiene test asociado
- Coverage de `OrderSyncHandler.cs` = 68% (threshold 75%)

### tycon-silent-failure-hunter
- `LineManager.ReleaseLineIfHeldAsync` traga la excepción sin log

## ⚪ Sin medir (N)

{Sólo si `write-findings` devolvió `sin_medir`: una línea por cada uno, «- {que}: {motivo}». Sin `sin_medir`, la
sección no va. Lo que no se midió no pasa a «OK».}

## ✅ OK
- Full test suite: X/X PASS, 0 regresiones
- Sin secretos detectables
- {otros items OK resumidos}

---

**Reportes completos** en `.advisors/pipeline-runs/<clave>-<sello>/`
```

## Qué va al chat (regla COMM.ii)

El artefacto de arriba se escribe SIEMPRE completo. Al usuario le llega esto:

```markdown
**Advisors: {🟢 limpio | 🟡 N warnings | 🔴 N críticos}**

- {qué se revisó, en llano: "revisé seguridad, convenciones .NET, cobertura y wiring"}
- {hallazgo 1 en llano, sin rule ID ni file:line — qué pasa y por qué importa}
- {hallazgo 2 ...}
- {qué quedó OK que valga la pena decir: "la suite pasó entera, sin regresiones"}
- {si `write-findings` trajo `sin_medir`: «no pude medir: {que, en llano} — {motivo}», una línea por cada uno}

{Si hay CRITICAL → acá manda COMM.i: resumen + pregunta + detalle. Si no hay CRITICAL → una línea:}
Detalle completo (rule IDs, archivos, fixes propuestos) en `.advisors/pipeline-runs/<run-dir>/`
— decime si querés que te lo pegue acá.
```

**Traducción obligatoria de jerga a llano** en los bullets del chat:

| En el artefacto | En el chat |
|---|---|
| `[SEC-C1] Features/Voice/X.cs:147 callId interpolado raw en URL` | "un parámetro de la URL entra sin escapar — riesgo de inyección" |
| `[TEST-C2] X.IniciarLlamadaAsync (línea 124) 0% coverage` | "el método nuevo de iniciar llamada no tiene tests" |
| `[WIRING-C2] store action sin callsites` | "el botón está hecho pero no está conectado a nada" |

Con **más de 5-6 hallazgos**, no los listes uno por uno: agrupá por tema ("4 cosas de cobertura,
2 de convenciones") y ofrecé el detalle. La lista exhaustiva es exactamente lo que el artefacto
ya guarda.

## `findings.json` estructurado — write DETERMINISTA

Además del `.md`, el step ESCRIBE `findings.json` en el dir de pipeline-runs: un array de
`{rule_id, severity, advisor, file, disposition, reason}` con `disposition` ∈
`"fixed" | "waived" | "deferred" | "open"`. Es el insumo del `tycon-retrospective-capturer`
para las métricas `advisor_warnings_per_story` / `actioned_ratio` (determinista, sin LLM).

🔴 **NO lo escribas a mano** (un write manual del orquestador se olvida, y sin el archivo el conteo
se rompe). Usá el comando, que
valida el schema y resuelve/crea el run dir solo:

```bash
# El array de findings va por --findings (archivo JSON o '-' = stdin).
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js write-findings \
  --story <story_path> --repo <repo> --findings <array.json | ->
```

`write-findings` también copia al informe las notas de «repensar el enfoque» de la corrida (`rethink`, ya saneadas) y la cantidad de vueltas de revisores (`rethink.rounds`); una nota ilegible o incompleta sale en `warnings` y no cuenta.

### 🔴 El `advisor` se ELIGE de los que corrieron — no se escribe libre

`write-findings` valida el firmante de cada hallazgo contra el `review-roster.json` de ESA corrida.
No hay que hacer nada nuevo: se escribe el nombre del advisor y el comando resuelve el resto.

- **Vale**: un revisor de la ronda de Revisores, un agente de los pasos previos («Validar la historia», validación de
  la story), o una fuente propia del pipeline (`mech-check`, `pase adversarial`, `orquestador`,
  `runtime-matrix`, `e2e-runtime`, `ensayo runtime`, `adversarial-verify`, `pipeline`).
- **No vale**: cualquier otro texto. El comando FALLA, nombra el valor que recibió, lista los
  firmantes válidos de la corrida y **no escribe nada**. Si el hallazgo lo firmó el propio pipeline
  (no un subagente), la firma es una fuente propia — típicamente `orquestador`.
- **La anotación se puede seguir escribiendo** y no se pierde: `tycon-silent-failure-hunter (iter 3)`
  se guarda como `advisor: "tycon-silent-failure-hunter"` + `iter: 3`. El modelo va a `model` y
  cualquier otra cosa a `nota`. Además cada hallazgo queda con su `tramo`
  (`revision` | `previo` | `pipeline`), que es contra qué lista lo compara el portón.
- **Si el roster todavía no existe** (se escribe cuando el hook cierra la ronda de revisores), o es
  ilegible, o no trae lista de revisores: **no frena** — escribe igual y AVISA cuál de los tres casos
  es. Un control que no puede correr no aprueba, pero tampoco deja al dev sin anotar lo que encontró.

Por qué: el nombre se escribía en dos lados con dos criterios (el roster, mecánico desde el ledger
de spawns; el `advisor`, tipeado) y el cruce del portón los comparaba letra por letra: frenaba
stories sanas con hallazgos que eran del propio control.

- Cada finding: `{rule_id, severity(CRITICAL|WARNING), advisor, file, disposition(fixed|waived|deferred|open|refuted), reason}`
  (+ `tramo`, y `iter`/`model`/`nota` cuando el nombre traía anotación — los pone el comando, no vos).
  🔴 **Un hallazgo de `mech-check` que el advisor especializado de esa misma regla confirma como FALSO**
  (limitación del matcher, no gap real — por ejemplo ACCOV-C1 sobre una suite bash) va con
  `disposition: refuted` y la razón del advisor como `reason`. NO es `open` (no queda deuda) ni `waived`
  (nadie lo aceptó: se refutó). `false-positive` se acepta como sinónimo. Con `open` la story queda
  penalizada en `advisor_warnings_actioned_ratio` por un hallazgo que sí se investigó y cerró.
  Tolera `ruleId`/`rule`/`summary` como alias; normaliza severity/disposition inválidos.
- `disposition: fixed` = resuelto en esta corrida; `waived` = aceptado por el user / refutado; `deferred`
  = follow-up documentado; `open` = accionable sin resolver.
- Escribe `<run-dir>/findings.json` (mismo dir que `step-06-consolidated-report.md`). Devuelve counts
  (critical/warning + por disposition). Un run con 0 findings igual escribe `[]` (el artefacto SIEMPRE existe).
- **Enforcement**: «Preparar el commit» corre `pipeline.js findings-status` como pre-condición (exit 3 si falta) — no
  se puede llegar al commit-prep sin el artefacto.

```json
[
  { "rule_id": "SEC-W1", "severity": "WARNING", "advisor": "tycon-plugin-security-basics",
    "file": "Features/Armado/ArmadoService.cs", "disposition": "waived", "reason": "auto_waive en .tycon/advisors.yaml" }
]
```

## Persistir Review Follow-ups EN la story (adopción BMAD 2026-07-02)

Después de escribir `findings.json`, persistir los findings **no resueltos** (disposition
`waived` / `deferred` / `open`) como sección checkbox DENTRO de la story. Es la mejor idea de
`bmad-dev-story`: el ciclo dev↔review vive en el artefacto y sobrevive sesiones — si el
pipeline muere post-Hallazgos con un CRITICAL waived o WARNINGs abiertos, la próxima sesión los
ve en la story (el Arranque y «Validar la historia» los detectan), no hay que arqueologizar `.advisors/pipeline-runs/`.

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js write-followups \
  --story <story_path> \
  --findings <repo>/.advisors/pipeline-runs/<clave>-<sello>/findings.json
```

- **Idempotente por `fkey` (`ruleId|file`)**: en re-loops (Hallazgos → Revisores vuelta N+1 → Hallazgos) re-correr
  esto NO duplica ni pierde el estado — preserva los `[x]` que el dev marcó al resolver, agrega
  los findings nuevos abiertos, y conserva los ya resueltos como historial.
- **`disposition: fixed` → `[x]`** automático (finding ya resuelto en esta corrida). `waived` /
  `deferred` / `open` → `[ ]` (accionables).
- **Solo toca el BODY** de la story (sección `## Review Follow-ups (Advisors)`). NUNCA el
  frontmatter contractual — esa transición sigue siendo exclusiva del orquestador vía `marker.js`.
- Anunciar al user el conteo (`open` / `resolved`) que devuelve el comando.

## Decisiones

- **Orden de CRITICAL primero**: los CRITICALs van al tope del reporte, antes que warnings. El usuario debe verlos primero.

- **Agrupar por advisor** en WARNINGs ayuda a entender contexto. En CRITICALs no se agrupa porque cada uno es importante individual.

- **Si algún advisor falló**: incluir una sección "⚠️ Advisors que no pudieron correr" al final con la razón.

---

# La decisión (sólo si hay críticos)

**Objetivo**: decidir si el paso se pausa para aprobación del usuario o fluye directo.

**B.ii**: sólo pausa si hay CRITICAL. Si el reporte tiene SOLO WARNINGs (cero CRITICAL), el pipeline **AUTO-FLUYE** a «Probar en vivo» listándolos. Si todo OK, idem.

### Inputs de la decisión

- `consolidated_report` (el informe de arriba)
- `has_critical: bool`
- `has_warning: bool`
- `.tycon/advisors.yaml` del repo (`auto_waive:` + `warnings_pause:`, si existe)

### Lógica de decisión

```
if has_critical:
    → MOSTRAR reporte completo
    → PAUSAR SIEMPRE, con la forma de la decisión importante: "Recomiendo {corregir|eximir}: {por qué}.
      Hay N CRITICAL: {el contexto: qué encontró el revisor, en llano, y qué pasa si se deja}.
      Corregir — {lo que gana y lo que cuesta}. Eximir — {lo que gana y lo que cuesta}.
      ¿Querés corregir antes del commit o hacer override?"
    → Esperar decisión del usuario
elif has_warning:
    → Auto-waive (con anuncio explícito) los warnings que:
        (a) tengan su rule ID en la lista `auto_waive:` de .tycon/advisors.yaml del repo, O
        (b) referencien líneas FUERA del diff (código pre-existente no tocado por la story)
    → si `warnings_pause: true` en .tycon/advisors.yaml (knob opt-out):
        → MOSTRAR reporte + PAUSAR (comportamiento pre-2026-06-09)
    → si no:
        → AUTO-FLUIR al paso siguiente, listando TODOS los warnings (incl. auto-waived, marcados)
          en el reporte consolidado Y en el cuerpo del commit message (sección
          "Warnings auto-waived" — ver step-11-prepare-commit.md). Visibilidad sin fricción.
else:
    → Mostrar resumen "✅ Todo OK" (1-2 líneas)
    → NO PAUSAR — seguir al paso siguiente
```

**Los warnings auto-waived NUNCA se silencian**: quedan SIEMPRE listados en el reporte y en
el commit message, con la razón del waive (`auto_waive` list / fuera del diff). El auto-flow
quita la fricción, no la trazabilidad.

### Respuestas del usuario

#### Si hay CRITICAL:

- **"corrijo"** → **NO se termina el pipeline**: se aplican los fixes y, por la regla D.i
  (no-negociable — los revisores auditaron la versión ANTERIOR al fix), se vuelve a «Revisores» (vuelta N+1) sobre el diff actualizado, siguiendo la sección «Otra vuelta» de `step-07-reviewers.md`.
  `pipeline.js next` la pide solo («Revisores, vuelta N») cuando hay ediciones de código posteriores. Si el dev prefiere cortar acá y retomar después, el marcador queda activo.
- **"override" (eximir el crítico)** → un crítico lo decide una persona: **el agente nunca se exime solo**, ni
  firmando como `orquestador`, ni con «hacé lo que recomiendes». Dos caminos:
  1. **La ventana de permiso** (el principal). Corré
     `marker.js waive-critical --rule <regla> --file <archivo> --reason "<por qué>" --approved-by "<el dev>"`, sin
     `--quote` ni `--relayed-by`. La herramienta le abre al dev la ventana de permiso con el comando: ahí ve la regla,
     el archivo y tu motivo, y lo aprueba o no. El guion comprueba que lo lanzó la herramienta con ese comando; si no
     pasó por la ventana, frena y dice cómo firmarlo en la terminal. Lo que el dev escriba en el chat, o lo que reenvíe
     otra sesión, ya no exime: el comando con `--quote` o `--relayed-by` se niega. Queda manual, a nombre del dev, con
     `via: ventana`.
  2. **Desde su terminal**, si el dev prefiere o la herramienta no tiene ventana: `marker.js waive-critical … --terminal`
     (lo corre el dev).

  Recién con la constancia, el hallazgo se anota `waived` en `pipeline.js write-findings`: sin ella, `write-findings`
  no escribe, y `complete-step findings` y `complete-step prepare-commit` frenan. Proceder con flag `had_override: true`.
- **"cancelar"** → terminar el pipeline.

#### Si hay solo WARNING:

- Default (sin `warnings_pause: true`): **no hay pregunta** — auto-flow con los
  warnings anunciados y listados. Si el usuario interviene ("ajusto X") → volver a «Implementar».
- Con `warnings_pause: true`: **"procedo" / "dale"** → seguir; **"ajusto X"** → «Implementar»;
  **"cancelar"** → terminar el pipeline.

#### Si todo OK (no hay checkpoint):

- Automático al paso siguiente con mensaje breve: "Advisors OK. Preparando commit."

### Razón de diseño B.ii

Evitar HITL fatigue. Si cada story sin issues (o con warnings advisory) obliga al dev a
aprobar un reporte, después de 5 stories el dev aprueba sin leer. Mejor **silencio positivo
con trazabilidad**: si no hay CRITICAL, el pipeline fluye y los warnings viajan visibles en
reporte + commit message. CRITICAL pausa SIEMPRE — ahí sí hay decisión humana real.

### Persistir la disposición final en los Review Follow-ups (adopción BMAD 2026-07-02)

Cuando este step resuelve con una **disposición final** que avanza —un CRITICAL
**waived** por override, o WARNINGs que se dejan abiertos/diferidos— re-correr `write-followups`
con el `findings.json` actualizado (el que refleja la disposición final del este paso), para que
la story registre en su body qué quedó waived/abierto:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js write-followups \
  --story <story_path> --findings <...>/findings.json
```

Así, si el pipeline avanza a commit con un CRITICAL waived, la próxima sesión ve ese waive en la
story (no solo en el pipeline log) y «Arranque» lo levanta. Idempotente — si «Hallazgos» ya lo escribió
esta corrida, re-correrlo solo actualiza dispociones. (En un re-loop D.i el write del informe de la
siguiente iteración ya cubre esto; este write explícito es para el caso "waive + avanzar" sin
re-loop.)

## Cierre del step

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js complete-step findings
```

`complete-step findings` frena sin `findings.json` o con un crítico eximido sin el ok de una persona.

## Output de este step

- `consolidated_report` (markdown completo)
- `findings.json` (array estructurado en el dir de pipeline-runs)
- `has_critical`, `has_warning`, `total_issues: N`
- `should_proceed: true|false`, `had_override: true|false`
- `auto_flowed_with_warnings: true|false` + lista de warnings (incl. auto-waived con razón): «Preparar el commit» los incluye en el commit message
- `user_feedback` si pidió cambios

Siguiente: lo que indique `pipeline.js next`. Si hubo arreglos de código, primero «Revisores, vuelta N+1» (regla D.i); después «Probar en vivo» (`step-10-live-check.md`). «Preparar el commit» sólo se abre con «Probar en vivo» cerrado.
