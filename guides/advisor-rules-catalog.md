# Catálogo maestro de reglas de advisors TYCON

Índice único de todas las reglas que los advisors pueden reportar. Cada regla tiene un **ID estable** que se cita en cada finding.

---

## 📚 Referencia canónica: el repo del framework de plugins

**Cualquier duda sobre cómo funciona el framework de plugins Bizuit** (backend .NET o frontend), **la fuente de verdad es el repo del framework de plugins** (un repo del equipo).

Incluye el código real de `Bizuit.Backend.Core`, `Bizuit.Backend.Abstractions`, `IBackendPlugin`, `SafeQueryBuilder`, `BizuitUserContext`, `IUserIdResolver`, plugins de ejemplo (backend y frontend), y la infraestructura de runtime.

**Cuándo consultarlo:**
- Al agregar una regla nueva al catálogo y no estar seguro del patrón canónico
- Cuando un finding genera duda ("¿esto es realmente la convención o solo en Totora?")
- Para ver implementaciones de referencia de lifecycle, routing, auth, transacciones
- Antes de retirar una regla por "falso positivo sistémico" (puede ser que el repo de referencia confirme la regla)
- Cuando BMAD sube de versión y hay dudas sobre qué interfaces cambian

**Si leés el código del repo del framework y detectás que una regla del catálogo no matchea la realidad del framework**, actualizá la regla acá (con fecha + nota) para mantener consistencia.

---

**Convención de naming**: `<AREA>-<SEVERITY><NUM>`
- Áreas: `SEC` (security), `DOTNET` (dotnet conventions), `TEST` (tests coverage), `REACT` (react conventions), `NEXT` (next.js conventions), `VAL` (story validator), `SIGNALR` (signalr hubs server-side), `SIGNALRC` (signalr clients .NET + JS/TS), `MIGRATION` (sql migrations), `HTTP` (HTTP client resilience .NET), `WORKER` (.NET BackgroundService / IHostedService lifecycle), `WIRING` (feature wiring checker — React 18 + Zustand + .NET 9 Minimal API + Bizuit Plugin stack), `SPEC` (spec-first checker — detecta scope creep entre story Mary+GOLD y código), `SCOPE` (signed scope audit — compara el PLAN de sprints contra lo que el cliente FIRMÓ en la propuesta comercial), `XPAT` (sibling pattern reviewer — verifica que stories/diffs de backend Bizuit se anclen al patrón hermano y no lo reinventen)
- ⚠️ **`SPEC` vs `SCOPE` no son lo mismo**: `SPEC-*` compara la **story contra el código** (¿implementamos algo que ningún AC pide?); `SCOPE-*` compara el **plan contra lo firmado por el cliente** (¿movimos, agregamos o dejamos de entregar algo que el cliente firmó?). Distinto insumo, distinto dueño, distinto momento.
- Severities: `C` (CRITICAL), `W` (WARNING)
- Números secuenciales por área+severity. Los IDs son **estables** — si una regla se retira, su ID no se reutiliza.

**Regla de oro**: ningún advisor debe emitir findings sin citar un rule ID. Si un finding no tiene ID, el advisor tiene un bug.

---

## Cómo leer un finding

Cada finding en el reporte consolidado tiene este formato:

```
[<RULE-ID>] `<file>:<line>` <descripción>. Fix: <acción>.
```

Si ves algo tipo `[SEC-C1] VoiceEndpoints.cs:47 callId interpolado raw...`, podés:

1. Buscar `SEC-C1` en este documento → ver la regla completa con patrón y fix
2. Ir al advisor correspondiente (`tycon-plugin-security-basics.md`) para ver detalles del detector
3. Si no estás de acuerdo con la regla, discutir la regla acá — no caso por caso en cada PR

---

## Story Validator — `tycon-story-validator`

Archivo del advisor: `~/.claude/agent-skills/agents/tycon-story-validator.md`
Guía canónica de formato: `story-format.md` (Mary+GOLD).

### CRITICAL

| ID | Nombre | Fix típico |
|---|---|---|
| **VAL-C1** | Archivo/path referenciado en "Que existe hoy" NO existe en el codebase | Corregir path en la story antes de pasar a dev |
| **VAL-C2** | Pseudocódigo de la story inyecta `IConfiguration` en ctor de plugin service O usa `sp.GetRequiredService<IConfiguration>()` dentro de factory delegate | Refactor del plan antes de implementar. Opción A (preferida): `IOptions<T>` con POCO + `services.Configure<T>`. Opción B (factories): closure sobre `configuration` del param `ConfigureServices`. El plugin loader de Bizuit NO registra `IConfiguration` resolvable via SP. Ver DOTNET-C4/C5 |
| **VAL-C3** | Pseudocódigo incluye dependency del host no whitelisted (ver DOTNET-C5) | Refactor del plan al patrón soportado antes de implementar |
| **VAL-C5** | Story marcada `review` (o pasando a `review` en el pipeline) tiene **deferrals abiertos del propio story** en código creado/modificado por la implementación. Patterns detectados: `TODO(Story-{N}-deferral)`, `FIXME: Story {N}`, `HACK: Story {N}`, `[DEF-{N}-`, `DEFERRED-{N}`, `Story {N} deferred`, `pendiente Story {N}`. Ver `guides/definition-of-done.md` Gate 1. Corre también sin modelo (`runValidatorChecks` en `lib/story-checks.js`, agent-skills): en un re-loop, el validador sólo se deja de relanzar si este chequeo sale limpio | 3 caminos válidos: (a) cerrar el deferral (implementar el work pendiente), (b) mover a story aparte con `depends_on: [{N}]`, (c) status sigue `in-progress`, NO avanza a `review`. Está prohibido marcar `review` con TODOs `Story-{N}-deferral` abiertos en propio código |
| **VAL-C6** | Story con bloque `pipelines:` declara un pipeline con `status: blocked` SIN `blocked_by` no-vacío. Trace: stories entregadas en tandas donde una tanda quedó diferida sin documentar la causa concreta (ver story-format.md §1.1). Corre también sin modelo (`runValidatorChecks`), con la misma condición para no relanzar al validador en un re-loop | Completar `blocked_by` con descripción concreta del bloqueo (e.g. `"Story <N.M> Task 5.5 backend — endpoint GET /api/ceibo/ordenes/{id}/arbol no mergeado"`). NO se permite valor `"TBD"`, `"unknown"` o cadena vacía |
| **VAL-C7** | Signed scope mismatch — story declara `signed_for_sprint: N` en frontmatter pero `sprint: M` (M ≠ N) SIN `change_request_ref: CR-XXX` apuntando a CR aprobado en `specs/planning-artifacts/change-requests/`. Por qué: sin este cruce, un shift no autorizado de sprint viola la propuesta firmada sin que nadie lo detecte. Ver `guides/signed-scope-guardrails.md`. **Owner: `tycon-story-validator`** (aplicación per-story, dentro del pipeline) · **Co-enforced: `tycon-signed-scope-audit`** (aplicación global sobre todas las stories del repo, en el audit on-demand). Es UNA regla con dos puntos de aplicación — el ID no se duplica ni se renombra a `SCOPE-*` | 3 caminos válidos: (a) revertir `sprint` al `signed_for_sprint`, (b) crear `cr-NNN-*.md` con `status: approved` + decision_evidence + agregar `change_request_ref: CR-NNN` al frontmatter, (c) agregar `signed_scope_notes: "razón"` si la divergencia es legítima sin requerir CR (emite WARNING en vez de CRITICAL — en el audit global ese escape tiene ID propio, ver la sección Signed Scope Audit) |
| **VAL-C8** | Story de **backend** sin la sección obligatoria "Patrón de referencia verificado" (§9.2 de `story-format.md`), **O** la sección cita anclas `archivo:línea` que no resuelven (archivo inexistente en repos hermanos / línea fuera de rango), **O** la sección está basada en una asunción no verificada (`asumo`, `probablemente`, `creo que`, `no pude confirmar`), **O** la afirmación "no aplica" no trae razón ni evidencia de búsqueda. Verifica presencia + resolución estructural — la confirmación semántica profunda la hace `tycon-sibling-pattern-reviewer` (`XPAT-*`). Por qué: una story escrita y validada sin citar ni verificar el patrón hermano puede proponer el fix opuesto al patrón real de los plugins hermanos. Ver `story-format.md` §9.2 + regla GOLD #9 | Agregar/corregir la sección "Patrón de referencia verificado": citar el patrón hermano con anclas `archivo:línea` o `grep` que resuelvan y hayan sido abiertas/corridas — O afirmar explícitamente "no aplica" con la razón concreta y la evidencia de haber buscado. Prohibido basar la sección en una asunción de research agent |

### WARNING

| ID | Nombre | Fix típico |
|---|---|---|
| **VAL-W1** | Frontmatter incompleto (falta `epic`, `story`, `title`, `status`, `sprint`, `priority`, `approach`, `depends_on`) | Completar campos faltantes |
| **VAL-W2** | ACs no agrupados con `### H3` | Agrupar por área |
| **VAL-W3** | Tabla de tests sin columna de naming PascalCase o resultado esperado concreto | Reformatear tabla |
| **VAL-W4** | Primera task no es "Salvaguarda de BD/estado" | Agregar task de salvaguarda o justificar |
| **VAL-W5** | Dev Agent Record ausente en story ready-for-dev | Agregar placeholder vacío |
| **VAL-W6** | Método/línea referenciada NO matchea en el archivo (grep vacío) | Verificar si fue renombrado, actualizar referencia |
| **VAL-W7** | Story con bloque `pipelines:` tiene un AC declarado en `## Acceptance Criteria` que NO aparece en ningún `pipelines[].acs` ni `pipelines[].acs_pending` (orphan AC). Equivale a "AC sin dueño — alguna tanda debe declararlo cubierto o explícitamente pendiente" | Asignar el AC al pipeline correspondiente. Si no aplica a ninguno → revisar si el AC sigue siendo válido o moverlo a story aparte |
| **VAL-W8** | Story cubre AC firmado (heurística: badge "NUEVA V6/V7" en title O referencia textual a "AC §18 #" O nombrada en gate de sprint firmado) PERO no declara `signed_for_sprint` en frontmatter. **Owner único: `tycon-story-validator`** (per-story, dentro del pipeline); `tycon-signed-scope-audit` NO la aplica — la nombra sólo como referencia cruzada (su §"Fuera del namespace SCOPE-*"). Dueño fijado 2026-08-22 | Backfill `signed_for_sprint` + `signed_ac_ref` con cita exacta de la propuesta firmada |
| **VAL-W9** | Story usa `P{n}` (n=2..8) en el cuerpo sin calificar con `Pantalla` / `Etapa` ni reemplazar por el nombre. Por qué: `P{n}` puede tener 2 lecturas firmadas que se solapan (Pantalla vs Etapa); el `prd.md` §Glosario del producto las documenta. Aplica solo en validación pre-impl o stories en estado `draft`/`ready-for-dev`/`in-progress`; stories `done`/`review` quedan exentas (fix-forward). Excluye matches en frontmatter, fenced code blocks, inline code, secciones Notas/Changelog/History/Dev Agent Record, rangos (`P2-P8`), y matches ya precedidos por `Pantalla`/`Etapa` | Calificar con prefijo: `Pantalla P{n}` (vista UI) o `Etapa P{n}` (pipeline operativo), o reemplazar por el nombre de la etapa (`Recepción`, `Armado`, `Despacho`, …). Ver `prd.md` §Glosario y Convenciones de Numeración |
| **VAL-W10** | Drift bidireccional entre `followup_of:` (declarado en la story hija) y `followed_up_by:` (declarado en la story padre). 5 sub-casos: **(a)** hija declara `followup_of: [{id}]` pero NO existe story con ese id en el directorio; **(b)** hija declara `followup_of: [{id}]` y la padre existe pero NO tiene a la hija en su `followed_up_by:` (caso típico — el hook `tycon-story-followup-link` lo previene al crear, pero aparece si se editó el `followup_of:` post-create o si se skippeó el reminder); **(c)** padre tiene entry en `followed_up_by: [{id}]` pero la hija NO declara recíproco en `followup_of:` (orphan back-link); **(d)** entries recíprocos existen pero `type` o `summary` desincronizados entre los dos lados (single-source-of-truth roto); **(e)** `type:` no enumerado (válidos: `fix`, `scope-change`, `recalibration`, `gap-fill`, `extension`). Convención `story-format.md` §1.2. Por qué: sin back-link en la padre, quien abre una story firmada no sabe qué cambió post-firma | 5 caminos según sub-caso: **(a)** corregir id, o documentar la relación en prosa si la padre vive en otro repo (el back-link automático solo cubre same-dir); **(b)** editar frontmatter de la padre agregando entry recíproco en `followed_up_by:` — automatizar con `tycon-backfill-followups.js --apply`; **(c)** decidir: si la hija sí es follow-up → agregar `followup_of:` a la hija, si NO → remover entry de la padre; **(d)** sincronizar (la hija es source-of-truth — la padre solo replica el `type` y `summary` del `followup_of:` de la hija); **(e)** usar un type enumerado |
| **VAL-W11** | (2026-06-09 contrato AC↔test) AC numerado de `## Acceptance Criteria` sin test asignado en la tabla `### Tests` (columna `AC` per story-format §6; refs texto-libre `(AC #N)` cuentan en stories pre-formato con nota de migración) y sin deferral declarado en `pipelines.X.acs_pending`. Atrapado en Step 1 — descubrirlo post-implementación era ACCOV-C5, demasiado tarde. Check determinístico: `pipeline.js mech-check` (parser `lib/story-checks.js`) | Agregar fila a la tabla `### Tests` con columna AC={n}, o declarar el AC en `pipelines.X.acs_pending` si se difiere |
| **VAL-W12** | (2026-06-09) Story `ready-for-dev` sin heading "Lo que NO hay que hacer" con ≥1 bullet — el ejecutor queda sin guardrails de scope y spec-first-checker pierde su ancla | Agregar la sección con los anti-objetivos concretos de la story |
| **VAL-W13** | (2026-06-09) Story `ready-for-dev` sin sección "Cómo verificar que funciona" con ≥1 fenced block bash copy-paste — el DoD runtime gate (Step 7c) improvisa curls en vez de ejecutar los comandos canónicos declarados | Agregar la sección con los comandos de verificación reales (curl contra DevHost, npm test scoped, etc.) |
| **VAL-W14** | La story cita `archivo:línea` sobre un archivo que ELLA MISMA va a modificar (figura en su File List/Tasks o en su diff). Cualquier fix que la propia story aplique sobre ese archivo desplaza las líneas que cita sobre sí misma (medido: una story se desincronizó 3 veces en una misma corrida, una de ellas CRITICAL en el Step 1). No aplica a archivos que la story no modifica (ahí la línea es estable) ni a citas que ya nombran el miembro. Owner: `tycon-story-validator`. | Citar el MIEMBRO (método/propiedad/clase) como identidad estable — «`ValidatePayload` en `Boundary/PluginBoundary.cs`» — con la línea, si va, como ayuda y no como referencia autoritativa (`story-format.md` §9 Dev Notes) |
| **VAL-W15** | (2026-09-17) **La story no dice lo que se implementó** — sólo después de implementar: archivos tocados que la story no declara (`files_to_create`/`files_to_modify`/File List), conteos de tests que no coinciden con la tabla `### Tests` o con el código, tareas tildadas o sin tildar que contradicen lo hecho, o un Dev Agent Record que describe otra cosa. Medido: es lo que más encuentra el validador después de implementar (37 veces en la primera vuelta y 46 en los re-loops, en 30 días) y hasta esta regla no tenía identificador, así que no llegaba a `findings.json` ni a la poda. Owner: `tycon-story-validator`. | Actualizar la story para que diga lo que se hizo (lista de archivos, tabla de tests, tareas, Dev Agent Record) antes de pasar a `review` |
| **VAL-W16** | (2026-10-14) **El AC le muestra a un usuario de negocio identificadores internos** — un AC de pantalla promete mostrar `id…`, `…Id`, `instanceId` o números de fila sin un dato legible al lado (nombre, descripción, fecha). Por qué: si el AC ya define la respuesta con identificadores internos, la pantalla los muestra tal cual y pasa todos los controles; se ve recién cuando alguien de negocio la abre. No marca un identificador que el usuario conoce y usa (número de factura impreso, CUIT) ni un AC sin pantalla. No es de formato: pausa el paso 1. Owner: `tycon-story-validator`. | Sumar al AC el dato legible que acompaña a cada identificador, o decir por qué el usuario sí lo reconoce |

---

## Signed Scope Audit — `tycon-signed-scope-audit`

Archivo del advisor: `~/.claude/agent-skills/agents/tycon-signed-scope-audit.md`
Guía canónica: `guides/signed-scope-guardrails.md` (los 4 mecanismos anti-regresión del firmado del cliente).

Auditoría **global y on-demand** (pre-demo comercial, post-cambio de `sprint-plan.md`, sprint kick-off): compara el plan de sprints actual contra la propuesta comercial que el cliente FIRMÓ. No corre dentro del pipeline de story — el per-story es `VAL-C7`, que este advisor **co-enforcea** a nivel repo (ver fila `VAL-C7` arriba; el ID no se duplica en `SCOPE-*`).

### CRITICAL

| ID | Nombre | Fix típico |
|---|---|---|
| **SCOPE-C1** | Entregable firmado sin ninguna story que lo cubra — por cada sprint del texto firmado (`pdftotext -layout` sobre `comercial/*FINAL*.pdf`) se extraen los bloques `Entregable:` / `Gate de aceptación:` y sus referencias `AC §18 #NN`; si un entregable no tiene NINGUNA story asociada en `specs/stories/**.md` (ni por `signed_ac_ref` que cite la referencia, ni por título/ACs que contengan el ancla), el cliente firmó algo que nadie está construyendo. El match es **semántico, no literal**: un entregable parafraseado en la story NO es finding; un entregable ausente con una story de nombre parecido SÍ lo es. Owner: `tycon-signed-scope-audit` | Declarar la cobertura en el `signed_ac_ref` de la story que ya lo cubre, crear la story faltante, o —si el cliente aceptó por escrito no entregarlo— registrar el CR correspondiente |
| **SCOPE-C2** | `change_request_ref: CR-NNN` que apunta a un CR **inexistente, rechazado o todavía sin decidir**. Finding si `change-requests/cr-NNN-*.md` (a) no existe, (b) tiene `status:` ∈ {`rejected`, `superseded`}, (c) tiene `status: proposed` — el cambio se ejecutó antes de la decisión del cliente, (d) su `affected_stories:` no incluye la story que lo cita, o (e) tiene `superseded_by:` no nulo. **Los tres estados inválidos (no existe / rechazado / pendiente) son CRITICAL por igual**: citar un cambio aprobado que no existe es tan grave como no citar ninguno — en los dos casos el alcance firmado se movió sin respaldo, y no se quiere zona gris. Resuelve la contradicción histórica del advisor, que decía WARNING en su §3 y CRITICAL en sus severity rules. Owner: `tycon-signed-scope-audit` | Apuntar al CR vigente, obtener la aprobación escrita del cliente, o revertir el `sprint` al `signed_for_sprint` mientras tanto |
| **SCOPE-C3** | CR con `status: approved` sin evidencia verificable de la decisión del cliente — `decision_evidence:` nulo, vacío, o texto genérico sin referencia verificable (sin fecha, sin asunto de mail, sin nombre de archivo/adjunto); también `date_decided:` ausente o anterior a `date_proposed:`. El papel dice "aprobado" pero es un sello puesto por nosotros mismos. Owner: `tycon-signed-scope-audit` | Adjuntar la evidencia real (asunto + fecha del mail del cliente, o el archivo firmado), o bajar el CR a `proposed` hasta tenerla |
| **SCOPE-C4** | Story que cubre un entregable firmado del sprint N pero fue **creada directamente** en el sprint M (M ≠ N), sin declarar `signed_for_sprint` (si lo declarara sería `VAL-C7`) y sin `change_request_ref` a un CR aprobado. La story no *se movió*: nació en el sprint equivocado, así que no hay `signed_for_sprint` que contradiga nada y el control per-story no ve nada. Hasta 2026-08-21 este caso sólo producía un WARNING de backfill. **Anti-falso-positivo obligatorio**: excluir splits internos (`X.Y.Z` cuyo padre `X.Y` declara `signed_for_sprint: N`), stories con `followup_of:` a una padre firmada, y stories de test/coverage/refactor. Owner: `tycon-signed-scope-audit` | Backfillear `signed_for_sprint` + `signed_ac_ref` y mover la story al sprint firmado, o tramitar el CR |
| **SCOPE-C5** | Veredicto emitido sin haber podido leer los insumos firmados (auto-chequeo — corre siempre y primero). Finding si: el `proposal_path` no resuelve o no es legible; es PDF y falta `pdftotext` o su salida es 0 bytes; la extracción produjo 0 sprints con `Entregable`/`Gate`; o `stories_dir` no tiene ninguna story con frontmatter parseable. **Por qué es CRITICAL**: con 0 sprints extraídos el cross-check devuelve 0 divergencias y el veredicto sale PASS — el control que no corrió se ve idéntico al control que salió limpio, el modo de falla que el arnés combate explícitamente. Cuando dispara, el veredicto obligatorio es **INCONCLUSO**, nunca PASS. Calibración: un `.txt` ya extraído CUMPLE el chequeo (el insumo es el texto, no el formato) — un INCONCLUSO crónico se lee como "esta herramienta no anda" y es peor que el PASS falso. Owner: `tycon-signed-scope-audit` | Instalar `poppler` (`brew install poppler`), corregir el `proposal_path`, o pasar el texto ya extraído (`.txt`) |
| **SCOPE-C6** | Las fuentes del plan actual se contradicen entre sí — el sprint de una story sale distinto según se lea el frontmatter `sprint:`, la sección `## Sprint N` de `sprint-plan.md`, o `sprint-status.yaml`. Sin esta regla el auditor elige una fuente en silencio y `VAL-C7`, `SCOPE-C1` y `SCOPE-C4` pueden dar veredictos opuestos según qué archivo se consultó (el `sprint-status.yaml` estaba declarado como input del advisor y no se abría nunca). **Precedencia declarada**: el frontmatter de la story manda — es lo que leen las tools del arnés; las otras fuentes son derivadas. Owner: `tycon-signed-scope-audit` | Sincronizar `sprint-plan.md` / `sprint-status.yaml` con el frontmatter, o corregir el frontmatter si el equivocado es ése |

### WARNING

| ID | Nombre | Fix típico |
|---|---|---|
| **SCOPE-W1** | Story agregada que parece alcance nuevo, no infraestructura — presente en el sprint N del plan actual, sin matchear ningún entregable/gate firmado de N (el complemento de `SCOPE-C1`) y sin señales de infra en frontmatter/título (`test`, `coverage`, `refactor`, `closure`, `chore`, `infra`, `spike`, `bugfix`, o `followup_of:` presente → NO es finding). Apareció trabajo que el cliente no firmó y que tampoco es plomería interna. Owner: `tycon-signed-scope-audit` | Registrar el CR (o la nota comercial) que respalda la feature, o reclasificarla si es infra |
| **SCOPE-W2** | Divergencia justificada sólo con `signed_scope_notes` — story con `sprint` ≠ `signed_for_sprint`, sin `change_request_ref`, **con** `signed_scope_notes:` no vacío. Es el escape declarado de `VAL-C7` (camino (c) de su fix): degrada la severidad a WARNING, no la silencia, para que quede auditable. Owner: `tycon-signed-scope-audit` | Ninguno automático — ítem de revisión humana del audit periódico. Si la nota resulta insuficiente, se convierte en CR |
| **SCOPE-W3** | `signed_ac_ref` que no se encuentra en el documento firmado — normalizar la cita (minúsculas, colapsar espacios, quitar acentos y `§`/`#`) y buscar sus anclas (la referencia de AC + ≥1 sintagma de ≥3 palabras) sobre el texto extraído de la propuesta; finding si no hay match, o si la referencia de AC existe pero apunta a un sprint distinto al `signed_for_sprint` declarado. Señal barata de que el documento firmado cambió o la cita fue inventada. Owner: `tycon-signed-scope-audit` | Corregir la cita con el texto real del PDF firmado (copiar/pegar del `pdftotext`) |
| **SCOPE-W4** | Cambio de alcance documentado como nota suelta en `sprint-plan.md` / `sprint-status.yaml`, sin CR formal — texto que describe un movimiento de scope (`movid[ao] a Sprint`, `postergad[ao]`, `cambio de alcance`, `change request`) que (a) no nombra ningún `CR-NNN`, o (b) nombra uno sin archivo en `change-requests/`. El cambio está "explicado" donde nadie lo audita. Owner: `tycon-signed-scope-audit` | Crear la entrada formal en `change-requests/` con el template, y dejar la nota del `sprint-plan.md` apuntando a ella |

**Nivel INFO sin rule ID (a propósito)**: las stories agregadas que son infraestructura, test coverage, refactor o split interno son legítimas y NO reciben ID — el catálogo sólo tiene severidades `C` y `W`, y un ID INFO sería la primera excepción. Se listan como texto sin ID en la sección ✅ OK del reporte; su valor auditable son los casos *must-not-flag* de `SCOPE-W1`.

**Fuera del namespace `SCOPE-*` a propósito**: story que cubre un AC firmado sin declarar `signed_for_sprint` → `VAL-W8` (del validator). Cambios sutiles DENTRO de un AC (ej. "200 OK con persistencia transaccional" degradado a "200 OK") → **ninguna regla los cubre**; el cross-check es a nivel scope/sprint, no AC-level, y `SCOPE-W3` sólo detecta que la cita dejó de existir, no que su contenido se ablandó.

---

## Deferral Tracker — `tycon-deferral-tracker`

Cierra el loop entre lo que la story declaró diferir (`acs_pending` / `tasks_pending` / `tests_pending` en bloque `pipelines:`) y la trazabilidad concreta en código + repo + engram. Corre en Step 5 del `tycon-pipeline`, en paralelo con los otros advisors post-build. CRITICAL inmediato — bloquea commit prep.

### CRITICAL

| ID | Nombre | Fix típico |
|---|---|---|
| **DEFTR-C1** | Story con bloque `pipelines:` declara un AC/task/test como pending (`acs_pending`, `tasks_pending`, `tests_pending`) **pero NO existe ni una línea en `tasks/todo.md` del repo bajo patrón `[DEF-{N.M}-...]` NI una observation de engram con `type=decision` y keyword `Story {N.M}` que documente el bloqueo**. Equivale a "diferimos algo y nadie lo escribió en los lugares acordados — la deuda es fantasma" | Agregar entrada en `tasks/todo.md` del repo con formato `### [DEF-{N.M}-{slug}]` + bloqueador concreto + cómo desbloquear. **Y** guardar engram observation `mem_save type=decision content="Story {N.M} — ..."`. Mínimo 1 de 2. Recomendado los 2 |
| **DEFTR-C2** | `it.skip(...)`, `describe.skip(...)`, `xit(...)`, `[Fact(Skip="...")]`, `[Theory(Skip="...")]` en código modificado/creado por la implementación SIN comentario inmediatamente arriba con patrón `TODO(Story-{N}-deferral: ...)` o `// DEFERRED Story {N} — ...`. Aplica a archivos de tests del diff. Trace: tests skipped sin razón documentada se acumulan y nadie los reactiva | Agregar comentario inmediatamente arriba del `skip` referenciando la story owner + AC/Task + blocker. Ejemplo: `// TODO(Story-<N.M>-deferral: AC#7 ListadoEditor — blocked by backend Task 5.5)` |

### WARNING

| ID | Nombre | Fix típico |
|---|---|---|
| **DEFTR-W1** | `TODO(Story-{N}-deferral)` sin formato canónico esperado. El patrón completo es: `TODO(Story-{N.M}-deferral: AC#X \| Task y.z \| blocker: descripción concreta)`. Si el TODO existe pero no incluye `AC#`, `Task`, o `blocker:` → WARNING (el TODO es legible para humano pero el advisor no puede correlacionar con la story) | Completar el TODO con los 3 campos. Si la story no tiene AC asociado al deferral, omitir `AC#` y dejar `Task y.z` + `blocker:` |
| **DEFTR-W2** | Engram observation que documenta el deferral existe pero `tasks/todo.md` NO tiene línea correspondiente. Ambos lugares son canonical: engram para retro/correlación, `tasks/todo.md` para el dev que abre el repo. Si solo está en engram, el dev no lo ve al `cat tasks/todo.md` | Agregar la línea `[DEF-{N.M}-...]` también en `tasks/todo.md` |
| **DEFTR-W3** | Documentación de deferral en `tasks/todo.md`/engram menciona AC/Task que NO está declarado en `pipelines:` del frontmatter (desincronización inversa). Cross-check inverso: por cada `[DEF-{N.M}-...]` en `tasks/todo.md` y por cada engram obs `type=decision` keyword `Story {N.M}`, verificar que mencione algún item de `acs_pending`/`tasks_pending`/`tests_pending` del bloque `pipelines:` actual | Sincronizar el frontmatter — agregar el AC/Task al bloque `pipelines:` correspondiente, O remover la entrada de `tasks/todo.md`/engram si el deferral ya no aplica |

---

## AC Coverage Checker — `tycon-ac-coverage-checker`

Cross-checkea CADA AC + CADA Test declarado en la tabla `### Tests` de una story Mary+GOLD contra implementación concreta en código. Cierra el gap entre "spec firmado" y "código merged" que el DoD Gate 2 §1-§5 + Gate 1 no cubren (chequean cosas estructurales pero NO que cada AC literal esté implementado). Corre en Step 5 del `tycon-pipeline`, en paralelo con los otros advisors post-build. CRITICAL inmediato — bloquea commit prep si encuentra ACs/Tests sin evidencia.

**Por qué**: una story puede quedar `done` con el DoD Gate 2 y el Gate 1 en verde y tener ACs/Tests sin implementación (un broadcast SignalR que no se emite, catálogos hardcoded en vez de `useConfigStore`, un test con un id de relleno, un test cross-tenant que falta, un debounce que no es real). Sin este advisor, ningún otro detecta estos gaps.

### CRITICAL

| ID | Nombre | Fix típico |
|---|---|---|
| **ACCOV-C1** | Test `T-N` declarado en la tabla `### Tests` de la story sin test correspondiente en código. Heurística: grep en `**/__tests__/**.test.ts(x)` + `**/Tests/**.cs` + `**/test/**.{spec,test}.ts(x)` por el nombre PascalCase del test (o substring del título descriptivo). Excepción: si la story marca el test como `~~T37~~` o `[DEFERRED]` (strikethrough), saltearlo | Crear el test con nombre matching el `T-N` declarado. Si el test queda diferido, marcar strikethrough en la story + entry en `tasks/todo.md` (cae bajo DEFTR-C1) |
| **ACCOV-C2** | AC con keyword crítico declarado en `## Acceptance Criteria` pero sin implementación grep-able. Tabla de keywords cubre: "SignalR broadcast"→`BroadcastAsync`, "audit event"→`LogAsync`, "FluentValidation"→`AbstractValidator<`, "TenantId filter"→`WHERE TenantId`, "useConfigStore"→import + `loadCatalogos`, "500ms debounce"→`setTimeout.*500`+`useRef`, "CEIX_* dropdown"→`<select>` con map dinámico (no hardcoded), "audit con oldValue/newValue"→`LogAsync(...)` con args matching | Implementar el comportamiento que falta. Si el AC realmente NO requiere implementación grep-able (falso positivo de heurística), justificar en PR + override explícito |
| **ACCOV-C3** | Test marcado como `[Fact]` o `it()` con nombre matching un AC, pero body SOLO contiene `Assert.NotNull` / `expect(x).toBeDefined()` sin verificación semántica de comportamiento. Es decir, el test existe en nombre pero no verifica nada útil — pasa con cualquier implementación incluso vacía | Agregar assertions semánticas: `Equal(`, `Contains(`, `Verify(... Times.Once)`, `toEqual(`, `toHaveBeenCalledWith(` validando el comportamiento esperado por el AC |
| **ACCOV-C4** | (2026-05-13) Modo `transition-to-done`: deferred-tracked items NO se aceptan como advisory cuando la story transiciona a `done`. Si hay tags `[story-{N}-*]` activos en `tasks/todo.md` O `pipelines.X` con `status != done` → BLOQUEA transición. Por qué: los tests trackeados como deferred que el modo `review` marca advisory pasarían a `done` sin cerrarse | Cerrar todos los deferrals activos antes de transicionar a `done`, O ratificar con CR aprobado documentado en engram + commit |
| **ACCOV-C1-EXT** | (2026-05-13) Tests requeridos mencionados en **Task descriptions** del spec sin implementación. Amplía ACCOV-C1 más allá de la tabla `### Tests` — patterns: `"Test paridad ... vs ..."`, `"Test [nombre]"`, `"agregar test para"`, `"escribir test que verifique"`, `"verificar via test"`, `"covered by test"`. Por qué: un test pedido solo en una Task description (ej. *"Test paridad PUT vs POST event-discriminator"*), y no en la tabla `### Tests`, escapa a ACCOV-C1 | Implementar el test mencionado en la Task description, O mover el test a la tabla `### Tests` para tracking estructurado |
| **ACCOV-C5** | (2026-05-20) AC declarado en `## Acceptance Criteria` sin NINGÚN T-ID asignado en la tabla `### Tests`. Por qué: si un AC se agrega a la story y la tabla `### Tests` no se actualiza, el orquestador usa la tabla como guía y ese AC queda sin coverage E2E | Agregar a la tabla `### Tests` un T-ID dedicado al AC, citando `(AC #N)` en la columna "Resultado esperado". Excepción: si el AC dice "(implementación deferida — sin test esperado)" literal, saltearlo **Precedente escrito (2026-09-06)**: AC cubierto por una medición local que no viaja → `accov-governance-protocol.md` §6 (promover a fixture primero; la excepción exige 4 condiciones y waiver del dev). |
| **ACCOV-C6** | (2026-05-20) AC implementado solo con tests MOCKEADOS sin runtime equivalente. Por qué: con tests mockeados (`vi.fn().mockResolvedValue(...)`) el path real (button → fetch → SQL) nunca se ejerce, y un bug SQL (HTTP 500 por columnas inexistentes) llega a prod | Agregar Playwright E2E sin `page.route()` del endpoint involucrado + xUnit integration test del repo method (no solo mock). Excepción: story con `dod_runtime_exempt: true` en frontmatter |
| **ACCOV-C7** | (2026-05-20) El agente pasa un "checklist manual" al user al cerrar la story. La regla: el output del cierre es el resultado de `playwright test` + `dotnet test`, cero checklist manual. Si el agente dice "podés probar X, Y, Z para verificar", el pipeline falló — declaró done sin automatizar lo que él mismo definió como criterio "está bien hecho" | Convertir CADA item del checklist manual en un Playwright/xUnit test. Toda interacción user-visible mencionada en Tasks (click/escribir/seleccionar/ver/filtrar/hover) debe tener test que la ejerza. Excepción: cobertura runtime de endpoint puramente backend sin UI (usa DODRT-C1 + curl) |
| **ACCOV-C8** | (2026-05-20; **opcional desde 2026-09-16**: el hook ya no frena si falta, y si existe a medias avisa sin frenar — lo que frena el cierre es la matriz por AC) Self-audit `.advisors/dod-runtime/<storyId>-self-audit.md` al transicionar a `review`/`done`. Archivo debe enumerar (1) cobertura por AC, (2) cobertura por interacción UI, (3) gaps no cerrados con plan, (4) verificación no-regresión, (5) confianza 1-10 con razón. Hook `on-pre-commit.js` bloquea commit sin este archivo | Generar el self-audit ANTES de proponer el commit final. Estructura obligatoria documentada en el agent file. Heurística anti-rellenar: §3 "ninguno" + §2 con >5 items = sospechoso (CRITICAL). Confianza ≥9 con gaps documentados = contradicción (CRITICAL) |
| ~~ACCOV-C9~~ | ~~Meta-audit del self-audit obligatorio (2026-05-20)~~ | **RETIRADA 2026-09-16.** Cero hallazgos ACCOV-C7..C10 en los 286 registrados y anterior a la matriz por AC (DODRT-C6, 2026-07-10), que cruza cada AC con una ejecución real en vez de releer la prosa del agente. El `tycon-ac-coverage-checker` ya no la corre por default; queda a pedido. No se reusa el ID. |
| **ACCOV-C10** | (2026-05-20) Convergencia del self-audit entre iteraciones. Transición `review → done` requiere CONVERGENCIA: `gaps_iter_N ⊆ gaps_iter_{N-1}` (cero gaps nuevos). Si iter N descubre gaps que iter N-1 no tenía → bloquea done. Por qué: si cada "¿segurísimo?" descubre gaps nuevos, hace falta un criterio que cierre el ciclo | Cerrar gaps nuevos en código antes del próximo iter, O si son non-blocking aceptables, agregarlos al iter anterior + re-escribir como base + re-iter. Edge: solo existe iter 1 → permite si confidence ≥8 + no critical gaps. Excepción: `dod_convergence_exempt: true` + razón (típico hotfix urgente) |
| **ACCOV-C11** | (2026-08-25) Fix que agrega o modifica una **guarda de frescura** (un control que compara «lo medido» contra «el estado del producto») marcado `disposition: fixed` sin haberse visto en un checkout/worktree LIMPIO, en las dos direcciones: camino feliz verde (clon nuevo, nadie tocó nada → NO acusa) y rojo por la razón correcta. 🔴 Instrumento PROHIBIDO: `mtime`/`birthtime` de un archivo versionado como proxy de «cuándo cambió el producto» — en cualquier clon ese dato es la hora del checkout. Por qué: una guarda así pasa todo el pipeline (incluida la re-verificación D.i) porque en la máquina del dev el mtime SÍ es la edición; en CI acusa siempre y traba la publicación | Estampar un hash del CONTENIDO desde la propia medición y comparar hashes, o la fecha de commit del archivo (`git log -1 --format=%cI -- <path>`) sólo si el clon garantiza profundidad (con shallow vuelve vacío y cae al mtime otra vez). Probarlo en un worktree limpio ANTES de cerrar. Sin excepción: si no se puede probar así, el finding NO se cierra como `fixed` — se declara no verificado, con el motivo. Detalle: `accov-governance-protocol.md` |

### WARNING

| ID | Nombre | Fix típico |
|---|---|---|
| **ACCOV-W1** | AC declarado en `## Acceptance Criteria` que no aparece literalmente en ningún test del repo (búsqueda fuzzy por 3 keywords distintivos del AC). Si menos de 2 keywords matchean → WARNING (no CRITICAL porque heurística es laxa). Trace: AC sin coverage en test puede pasar el grep de ACCOV-C2 pero no tiene test que regrese si se rompe en el futuro | Agregar test cubriendo el AC o agregar el AC a la tabla `### Tests` |
| **ACCOV-W2** | Story declara `pipelines:.X.acs: [N1, N2, ...]` como `done` pero alguno de esos ACs falla ACCOV-C1 o ACCOV-C2 → eleva el WARNING a CRITICAL. Es decir, declarar un pipeline `done` con ACs cuya implementación falta el grep es bloqueante (no solo informativo) | Revertir el pipeline a `pending` o `review` hasta que ACCOV-C1/C2 estén verdes, O documentar override en commit + engram (raro — la heurística de ACCOV-C2 es robusta) |

**Heurística de ACCOV-C2** (tabla canónica de keywords → grep esperado):

| Keyword en AC | Grep esperado | Tipo |
|---|---|---|
| "SignalR `evento` broadcast" / "emite `evento`" | `BroadcastAsync(.*"evento"` o `SendAsync(.*"evento"` | backend |
| "audit event" / "IAuditService.LogAsync" | `LogAsync(` en el service relevante | backend |
| "FluentValidation" / "validation rule X" | `AbstractValidator<{Type}>` o `RuleFor(x => x.{Prop})` | backend |
| "TenantId" / "tenant scoping" / "filtra por tenant" | `WHERE TenantId` en repo queries | backend |
| "catálogos via `useConfigStore`" / "CEIX_Categorias via API" | `useConfigStore` import + `loadCatalogos` call | frontend |
| "dropdown dinámico" / "from CEIX_*" | `<select>` con `.map(` sobre catálogo (no `<option value="X">` literal) | frontend |
| "500ms debounce" / "anti double-click" | `setTimeout.*500` + `useRef` lock o `DebouncedButton` import | frontend |
| "SignalR `evento` listener" / "scan.validated listener" | `signalrService.on(` con el event name | frontend |
| "audit registra `{ACTION}` con `oldValue` y `newValue`" | `LogAsync("{ACTION}"...oldValue...newValue` | backend |
| "transición de estado" / "rechaza con 409" | `Status = ...` o `CeiboConflictException` matching code | backend |

Anti-patterns (lo que NO hace este advisor):
- NO ejecuta los tests (eso es `tycon-plugin-tests-coverage`).
- NO valida que el endpoint responda 200 (eso es DoD Gate 2 §1 smoke check).
- NO escribe tests faltantes (solo reporta).
- NO entiende semántica de código — es heurística de grep. Falsos positivos posibles cuando el AC usa keyword no canonical.

---

## Pipeline Preflight (Step 0 del pipeline) — `tycon-pipeline`

Archivo del step: `~/.claude/agent-skills/skills/tycon-pipeline/steps/step-00-preflight.md`

Reglas que se ejecutan ANTES de arrancar el pipeline. Guards de workflow, no del código.

Forma canónica: `pipeline.js start --story <spec> --repo <dir>` corre C0/C1/C2/C4/C5 (+C6/C7/C8/C9) en 1 comando y pausa solo ante conflicto cross-sesión, rama protegida o pipeline abandonado.

### CRITICAL

| ID | Nombre | Fix típico |
|---|---|---|
| **PIPE-C0** | Story ya tiene pipeline activo en OTRA sesión (`marker.js find-by-story`) | Retomar con `marker.js adopt-session <sid>` (recomendado si la sesión vive); `clear-session <sid>` si murió; paralelo intencional documentado en engram. NO arrancar Step 0 fresh. |
| **PIPE-C1** | Rama protegida detectada (`main`/`master`/`production`/`prod`/`release`) | `git checkout -b feat/{story-id}-{slug}` antes de implementar. Override requiere "continuar en main" explícito. |
| **PIPE-C5** (caso crítico) | `status: in-progress` en frontmatter SIN marker activo → pipeline abandonado (sesión previa murió sin cerrar) | Pausa con 3 opciones: retomar (engram summary + git status), reset a `ready-for-dev`, o cancelar. |

### WARNING

| ID | Nombre | Fix |
|---|---|---|
| **PIPE-C2** | `.gitignore` no contiene `.advisors/` o `.dashboard/` | Auto-append al `.gitignore` del repo (no pregunta — son artifacts locales del pipeline) |
| **PIPE-C3** | Working tree no limpio (cambios sin commitear) | Opcional, solo con `--strict-working-tree`. Advertir al usuario. |
| **PIPE-C4** | Marker file del pipeline no se pudo setear (`marker.js set`) — los hooks anti-bypass quedan ciegos | Avisar y NO bloquear; reintentar en Step 1. (Marker per-sessionId, 2026-05-15/17.) |
| **PIPE-C5** (caso normal) | Update de `status:` a `in-progress` falló (frontmatter sin línea `status:`, permisos) | Avisar y NO bloquear — el marker per-session sigue vigente; solo afecta detección cross-sesión futura. |
| **PIPE-C6** | Modo autónomo Nivel 1 no se pudo activar (`marker.js set-autonomous`) — default ON desde 2026-06-23 | Avisar y NO bloquear: cae a HITL puro. Opt-out: `--no-autonomous` / `TYCON_PIPELINE_NO_AUTONOMOUS=1`. |
| **PIPE-C7** | Repo TIENE specs Playwright pero NO declaró su gate E2E en `.tycon/advisors.yaml` (discoverability 2026-06-23) | Avisar al arrancar (`pipeline.js start` emite `E2E-GAP`): declarar `e2e.gate` + `frontend_dir` en `.tycon/advisors.yaml` — sin eso el Step 7c no puede correr los E2E scoped. |
| **PIPE-C9** | Tooling esperado no disponible (codegraph / engram / workflow-tool / MCPs declarados por el repo) | AVISAR SIEMPRE (nunca degradar en silencio — regla TOOL.i) + escalera `raise_it`: CLI vía Bash si el binario está, fallback documentado si no. `workflow-tool` ausente → PREGUNTAR (se pierde el Step 5b adversarial). |

### ADVISORY (nunca bloquea)

| ID | Nombre | Acción |
|---|---|---|
| **PIPE-C8** | Modelo y/o reasoning effort de sesión no matchea la complejidad de la story (`pipeline.js model-hint`: LOW→sonnet/`medium` · NORMAL→opus/`high` · heavy→fable/`xhigh` · `max` nunca automático) | Sugerir `/model` en 1 línea (a lo sumo UN anuncio, solo-effort si el modelo ya matchea en banda LOW/heavy; en NORMAL común el effort default se calla). El user decide, override no se re-discute. (Modelo 2026-07-06; effort 2026-07-11.) |

---

## React Conventions — `tycon-plugin-react-conventions`

Archivo del advisor: `~/.claude/agent-skills/agents/tycon-plugin-react-conventions.md`
Guía canónica: `guides/bizuit/bizuit-plugin-react.md`

**Skipea automático** si no hay `.tsx`/`.ts` en el diff o si `package.json` no tiene React como dep.

### CRITICAL

| ID | Nombre | Fix típico |
|---|---|---|
| **REACT-C1** | Código incompleto / placeholders | Código completo obligatorio, no `// TODO` ni `// resto del código` |
| **REACT-C2** | Token auth expuesto | Token solo en memoria + headers Bearer, nunca en localStorage/logs/URL |
| **REACT-C3** | `any` explícito en API pública de componente/hook | `unknown` + type guard, o interface específica |
| **REACT-C4** | Rename de componente sin preservar contrato de props | Incluir props legacy como optional+`@deprecated` O actualizar todos los call-sites en el mismo commit |
| **REACT-C5** | `dangerouslySetInnerHTML` con `__html` no envuelto por `DOMPurify.sanitize(...)` (XSS) | Importar `DOMPurify from 'dompurify'` y envolver: `__html: DOMPurify.sanitize(rawHtml, { ALLOWED_TAGS: [...], ALLOWED_ATTR: [...] })`. Excepción literal estático sin interpolación → WARNING revisión manual |
| **REACT-C6** | Llamada al backend del plugin desde la raíz del servidor (`fetch('/api/…')`, `fetch('/…')`, o un cliente con base `'/api'`) en vez de la base que da el host | La base sale de `dashboardParams.pluginApiUrl` (en desarrollo `devPluginApiUrl`) y el código le agrega `/<plugin>/<ruta>`: `` fetch(`${pluginApiUrl}/${PLUGIN_NAME}/ruta`) ``. Desde la raíz anda en desarrollo (el proxy local atiende `/api`) y en el host da **503** o 404. Silenciosa: URLs absolutas a otro servicio, sitios Next.js y archivos de prueba |

### WARNING

| ID | Nombre | Fix típico |
|---|---|---|
| **REACT-W1** | Input sin `text-gray-900` | Agregar `text-gray-900` a className |
| **REACT-W2** | Clase Tailwind prohibida en prod (`sm:*`, `backdrop-blur-*`, `bg-*/N`, `peer-*`, etc.) | Inline style con `style={{}}` |
| **REACT-W3** | Emoji 3D en icono | SVG inline, Lucide, o Heroicons |
| **REACT-W4** | Input padding no estándar | `px-3 py-2 text-sm` (no `px-4 py-3`) |
| **REACT-W5** | `useEffect` para state derivable | `useMemo` o calcular en render |
| **REACT-W6** | `useEffect` para fetch sin abstracción | Hook `useX` con AsyncState pattern |
| **REACT-W7** | Modal sin `flex-shrink-0`/`overflow-auto` | Patrón sección 8 de `bizuit/bizuit-plugin-react.md` |
| **REACT-W8** | Naming incorrecto de componente/hook/archivo | PascalCase componente, `use*` hook, `.tsx` con JSX |
| **REACT-W9** | Endpoint con `/v1` (o la versión) agregado a mano | La versión la resuelve el host: `${pluginApiUrl}/<plugin>/<ruta>`, sin `/v1` (ver `REACT-C6`) |
| **REACT-W10** | Token sin conversión Bearer | `Bearer ${authToken.replace(/^Basic\s+/i, '')}` |
| **REACT-W11** | Naming engañoso en helpers de auth | Si `getBearerToken()` devuelve token pelado → renombrar a `stripAuthPrefix` / `getRawToken`. Alineación nombre ↔ valor devuelto |
| **REACT-W12** | Props deprecadas sin `@deprecated` JSDoc per-prop | Cada prop legacy con `/** @deprecated Story X.Y */` individual, no sólo comentario de bloque |
| **REACT-W13** | Jest `moduleNameMapper` sin entry CSS/assets del SDK | Configurar central: `"\\.(css\|scss)$": "<rootDir>/src/__mocks__/styleMock.js"` |
| **REACT-W14** | Peer `react` desalineado con deps `-react` del plugin | Alinear versiones peer react entre plugin y todas las deps react-aware. Check manual o en `build-form.js` |
| **REACT-W15** | `DOMPurify.sanitize` sin allowlist explícita (`{ ALLOWED_TAGS, ALLOWED_ATTR }`) | Pasar config explícita con tags+attrs mínimos según contexto (chat: `['b','i','em','strong','a','p','br','ul','ol','li']` + `['href','target','rel']`). Excepción contenido 100% interno → comentario explicando |
| **REACT-W16** | POST/PUT/PATCH sin body con `Content-Type: application/json` → host proxy hace `JSON.parse('')` → 500 | Request de escritura **sin body** mientras el cliente HTTP setea `Content-Type: application/json` fijo. El proxy Next.js del host Bizuit (`custom-forms/runtime-app/app/api/plugins/[...path]/route.ts` → `await request.json()`) parsea el body vacío → **HTTP 500 `{"error":"Unexpected end of JSON input"}`** (rompe deactivate/reactivate/reset y todo POST sin payload). Quitar el `Content-Type` NO sirve: IIS responde **411 Length Required**. Detectar: (a) call sites `.post`/`.put`/`.patch` con un solo argumento (sin body); (b) apiClient con `'Content-Type': 'application/json'` fijo + `body: x !== undefined ? JSON.stringify(x) : undefined` sin default `{}` para escrituras. Fix: el apiClient manda `'{}'` cuando body es undefined en POST/PUT/PATCH (`body: x !== undefined ? JSON.stringify(x) : isWriteMethod ? '{}' : undefined`), o cada call site pasa `{}` explícito. |
| **REACT-W17** | DELETE con payload en el body → host Bizuit dropea el body → `[FromBody]` null/NRE | Hermano de W16 (misma familia "host mangonea el body según método"): el host prod **dropea el body de los DELETE** antes de llegar al plugin .NET → el `[FromBody]` del endpoint queda null → NullReferenceException. Detectar: `.delete(path, body)` con segundo argumento, o endpoint .NET `MapDelete` con `[FromBody]`. Fix: mandar el payload del DELETE por **query string** (patrón `deleteBolsa`/`deleteArticulo`), nunca en el body. |
| **REACT-W18** | Color hex hardcodeado en JSX/TSX en vez de token de tema | Hex literal (`#RGB`/`#RRGGBB`, ej `'#3B82F6'`) en `.tsx`/`.ts` de UI (estilos inline, objetos de estilo, props de color) en vez de un **token de tema del proyecto** (CSS var `var(--token)` o constante de paleta). Los hex hardcodeados escapan el pipeline normal de advisors — hoy solo los atrapa el grep-gate de `/tycon-merge-to-main`, demasiado tarde para frenar sin revert; con esta regla se detectan EN LA STORY. Detectar: `/#[0-9a-fA-F]{3,6}\b/` en `.tsx`/`.ts` de UI **FUERA** de los archivos de definición de tokens del proyecto (`*tokens*`/`*theme*`/`*palette*`/`.css` de variables). Fix: reemplazar por el token de tema del proyecto. Excepción: `// @hex-ok <razón>`. Owner: tycon-plugin-react-conventions. |

---

## Next.js — `tycon-plugin-nextjs-conventions`

Guía canónica: `guides/bizuit/bizuit-plugin-nextjs.md`

**Skipea automático** si no hay `"next"` en `package.json` o no hay `app/`/`pages/` en el repo.

### CRITICAL

| ID | Nombre | Fix típico |
|---|---|---|
| **NEXT-C1** | Secreto expuesto via `NEXT_PUBLIC_*` | Mover var a sin prefijo (server-only), exponer al cliente solo lo no-sensible |
| **NEXT-C2** | Server Action / Route Handler sin validación de input | Zod.parse(body) antes de procesar |
| **NEXT-C3** | `"use client"` con `await` top-level en body | Remove `"use client"` o mover await a `useEffect` / React Query |
| **NEXT-C4** | Código incompleto / placeholders | Código completo obligatorio, no stubs |

### WARNING

| ID | Nombre | Fix típico |
|---|---|---|
| **NEXT-W1** | `"use client"` en page/layout alto sin justificación | Extraer interactividad a child Client Component |
| **NEXT-W2** | `useEffect + fetch + useState` para data fetching | Server Component o React Query / SWR |
| **NEXT-W3** | `<Head>` del pages router en `app/` | Metadata API (`export const metadata` o `generateMetadata`) |
| **NEXT-W4** | `<img>` raw en vez de `<Image>` de next | `next/image` con width/height |
| **NEXT-W5** | `<script>` raw en vez de `<Script>` de next | `next/script` con strategy |
| **NEXT-W6** | Mixing App Router y Pages Router | Consolidar en App Router |
| **NEXT-W7** | `cache: 'no-store'` sin justificación | Cachear o documentar el no-store |
| **NEXT-W8** | Hydration mismatch risks (`Date.now`, `Math.random`) | Mover a `useEffect` o aceptar SSR value estable |
| **NEXT-W9** | Hardcoded API URL sin `NEXT_PUBLIC_*` | `process.env.NEXT_PUBLIC_API_URL` |
| **NEXT-W10** | `params`/`searchParams` sin `await` en Next 15+ | `const { id } = await params` |
| **NEXT-W11** | `any` en API pública Server Action/Route/Component | `unknown` + type guard o interface |
| **NEXT-W12** | `revalidate: 0` silencioso con `generateMetadata` | Documentar o ajustar |
| **NEXT-W13** | `<Image priority>` below-the-fold | Solo para LCP |
| **NEXT-W14** | Hook React en Server Component | Agregar `"use client"` o refactor |
| **NEXT-W15** | Route Handler con método HTTP minúscula | `GET` / `POST` mayúsculas |

---

## Security — `tycon-plugin-security-basics`

Archivo del advisor: `~/.claude/agent-skills/agents/tycon-plugin-security-basics.md`

### CRITICAL

| ID | Nombre | Fix típico |
|---|---|---|
| **SEC-C1** | Path/URL injection via raw interpolation | `Uri.EscapeDataString(v)` + route constraint `{id:guid}` |
| **SEC-C2** | Secretos hardcoded en código | Mover a `IOptions<T>` o secret manager |
| **SEC-C3** | Inputs sin validación en POST/PUT/PATCH | FluentValidation + `[Required]` en DTOs |
| **SEC-C4** | Datos sensibles en respuestas sin sanitizar | Mapear a DTO con allow-list de campos |
| **SEC-C5** | Log statements con data de usuario | Loggear IDs opacos, no PII |
| **SEC-C6** | Uso criptográfico incorrecto | `RandomNumberGenerator.GetBytes` / `Argon2id` / `GCM` |
| **SEC-C7** | Path traversal en file operations | `Path.GetFullPath` + whitelist de directory root |
| **SEC-C8** | Connection string hardcoded | `IConnectionFactory` + config |
| **SEC-C9** | Config de seguridad crítica con fallback hardcodeado silencioso | `throw`/fail-fast en startup si falta la key/credencial — nunca un default operativo. Espejo .NET de AUTH-C6 |

### WARNING

| ID | Nombre | Fix típico |
|---|---|---|
| **SEC-W1** | CORS muy permisivo (`AllowAnyOrigin` + `AllowCredentials`) | Enumerar origins explícitos |
| **SEC-W2** | SQL dinámico sin SafeQueryBuilder | `SafeQueryBuilder.Query/Insert/Update/Delete` |
| **SEC-W3** | Deserialización débil (`Deserialize<dynamic>`) | Tipos estrictos |
| **SEC-W4** | Webhook handler sin validación de firma del provider | Validar firma del provider con su SDK (Twilio, Meta, Stripe, etc.) o HMAC contra secret de config antes de procesar |
| **SEC-W5** | Webhook handler sin idempotency-key / dedupe | Verificar `<provider>EventId` (`MessageSid`, `EventId`) antes de procesar para evitar double-process en retransmits |
| **SEC-W6** | Log statements con tokens del webhook | Loggear solo metadata segura (provider, projectId, eventType, ts). NO body completo, NO signature, NO headers de auth |
| **SEC-W8** | Texto que viene de un ARCHIVO EXTERNO al código (volcados, logs, registros, JSON de otra pieza) publicado en una página o reporte con el saneado aplicado sólo a «el mensaje» | Sanear **campo por campo** todo lo que se publique de esa fuente —motivos, títulos, notas, no sólo el campo obvio— con el mismo saneador (`sanear` de `tokens-digest.js` o el del repo), y un caso que cargue cada campo con un marcador. Por qué: un campo que parece prosa fija (el «motivo» de una conversación borrada) puede llevar identificadores de sesión a la página |
| **SEC-W7** | Servicio HTTP/socket local-only bindeado a todas las interfaces | `listen(port, '127.0.0.1')` / `UseUrls("http://127.0.0.1:port")` por default (escala a CRITICAL si expone endpoints sin auth) |

---

## .NET Conventions — `tycon-plugin-dotnet-conventions`

Archivo del advisor: `~/.claude/agent-skills/agents/tycon-plugin-dotnet-conventions.md`

Las reglas de esta área están canónicamente documentadas en `guides/bizuit/bizuit-plugin-dotnet.md`. El advisor lee esa guía en runtime — los IDs de abajo son el mapeo estable a las reglas.

### CRITICAL

| ID | Nombre | Fix típico |
|---|---|---|
| **DOTNET-C1** | SQL injection via raw concat | `SafeQueryBuilder.Query/Insert/Update/Delete` |
| **DOTNET-C2** | `ClaimsPrincipal` usado para user context | `BizuitUserContext` + `IUserIdResolver.GetRequiredUserIdAsync()` |
| **DOTNET-C3** | Connection string hardcoded | `IConnectionFactory` + `IOptions<T>` |
| **DOTNET-C4** | `IConfiguration` inyectado en ctor de plugin service O `sp.GetRequiredService<IConfiguration>()` dentro de factory delegate | Dos antipatrones equivalentes: (a) ctor `IConfiguration` sin factory que lo pase via closure → runtime `InvalidOperationException: Unable to resolve service for type 'IConfiguration' while attempting to activate 'X'`. (b) Factory `AddXxx<T>(sp => ... sp.GetRequiredService<IConfiguration>())` → `No service for type 'IConfiguration' has been registered.`. Ambos en el plugin loader del host (`*BIZUITExtensionsAPI`) → HTTP 500 al primer request/resolve. Fix preferido: `IOptions<MyConfig>` con POCO + `services.Configure<MyConfig>(configuration.GetSection("X"))`. Fix aceptable para factories: **closure sobre el param `configuration` de `ConfigureServices`** (patrón `PluginLogger`). |
| **DOTNET-C5** | Servicio del plugin depende de DI del host no expuesto al plugin scope | Plugin loader solo inyecta dependencias whitelisted. Cualquier `I*` en ctor debe resolverse desde el scope del plugin. Safe: `IOptions<T>`, repos registrados por el plugin, `HttpClient` via named factory. Unsafe: `IConfiguration`, `ILogger<T>` ASP.NET nativo (usar `PluginLogger`), `IHostApplicationLifetime`, `IWebHostEnvironment`. Fix: adaptar al patrón soportado (ej: `IOptions<T>` en vez de `IConfiguration`) |
| **DOTNET-C6** | Setting key usada en código (`configuration["X:Y"]`) faltante en `plugin.json.example` → `defaultSettings` | En producción Bizuit Backend Host expone settings al admin **solo si están en `defaultSettings`** del ZIP. Una key usada por el código pero no declarada → resuelve a `null` silente — bug latente (worker que no arranca, integración 404 sin contexto). Fix: agregar la key al `defaultSettings` con default sensato. Excepción: keys del host (`Urls`, `ApplicationInsights:ConnectionString`, `System:TenantId`, `System:BizuitApiBaseUrl`) inyectadas por el host — allowlist documentada en `bizuit/bizuit-plugin-dotnet.md` |
| **DOTNET-C7** | `catch (Microsoft.Data.SqlClient.SqlException)` por TIPO CONCRETO en código del plugin | El plugin corre en un AssemblyLoadContext del host; la conexión SQL la crea el host (su MDS), así que la `SqlException` viene de OTRA carga de `Microsoft.Data.SqlClient`. El `catch (SqlException)` del plugin compara por identidad de tipo → en runtime NO matchea (aunque MDS esté en `SharedAssemblies` del loader) → la excepción ESCAPA → **INTERNAL_ERROR**. Rompe toda idempotencia/retry por `SqlException` (unique 2627/2601, deadlock 1205). Local (un ALC/MDS) matchea → "anda en local, falla en el host" (mismo perfil que C4). Fix: `catch (System.Data.Common.DbException ex) when (ex.IsUniqueViolation())` / `.IsDeadlock()` — `DbException` es shared-framework (identidad única entre ALCs) + `Number` por reflection (helper `Shared/SqlExceptionExtensions`). Owner: `tycon-plugin-dotnet-conventions` |
| **DOTNET-C8** | Read/write-while-tx-open: 2da conexión sobre la MISMA tabla que la tx tiene lockeada → self-block | Un método abre `conn.BeginTransaction()` y dentro del bloque (antes del `Commit`) llama un repo/service que NO recibe `(IDbConnection, IDbTransaction)` y abre su propia conexión (`_connectionFactory.CreateConnection()`). Si esa 2da conexión toca la MISMA tabla que la tx mutó sin commitear, choca con sus locks; la conn de la tx await-ea a la conn nueva → ciclo a través de la capa async de la app, INVISIBLE al deadlock detector de SQL (sin deadlock graph) → cuelga hasta CommandTimeout (~30s) → `SqlException -2` (típicamente tragado) → HTTP 200 con operación a medias. **CRITICAL** si la 2da conexión toca la misma tabla (o la tx es `Serializable`); **WARNING** si toca tabla distinta bajo READ COMMITTED (deuda latente, no cuelga). Fix: read-first (mover los reads antes del `BeginTransaction`, tx write-only) o pasar `(conn, tran)` (patrón dual conn/transaction canónico). Owner: `tycon-plugin-dotnet-conventions` |
| **DOTNET-C9** | API de librería compartida con el host usada sin verificar la versión CARGADA — rompe solo en prod | El plugin corre DENTRO del host de Bizuit: para todo paquete que el host también carga (Polly*, Microsoft.Extensions.Http.Resilience, Microsoft.Extensions.*, ApplicationInsights, Newtonsoft…), la versión efectiva la deciden las DLLs YA CARGADAS del host — no el csproj del plugin ni el ZIP. Una API que existe al compilar puede NO existir en runtime → `MissingMethodException`/`TypeLoadException` SOLO contra el host desplegado: build, tests y CI verdes no prueban nada. Detección: el diff introduce llamadas nuevas a superficie de esos paquetes (extension methods de conveniencia, APIs recientes) sin (a) verificación citada contra la versión real cargada (`GET diagnostics/assemblies` en staging, o manifiesto del host) ni (b) fail-closed en el call-site (catch `MissingMethodException` + degradación segura). Preferir primitivas estables (base Polly.Core 8.x, BCL) o lectura de datos crudos (property keys) en vez de extensiones nuevas. **CRITICAL**. Ejemplo: `GetRequestMessage()` de Http.Resilience 9.0.0 no existe en el host de prod → todas las llamadas que pasan por ese cliente mueren, disfrazadas de error de conexión. Owner: `tycon-plugin-dotnet-conventions` |

### WARNING

| ID | Nombre | Fix típico |
|---|---|---|
| **DOTNET-W1** | Layer-based folders | Reorganizar a feature-based (`Features/{Name}/...`) |
| **DOTNET-W2** | Orchestrator pattern roto (Service → Repo de otro feature) | Services call Services |
| **DOTNET-W3** | Endpoint sin `IPluginEndpointBuilder` | Registrar via builder |
| **DOTNET-W4** | Test naming no sigue `MethodName_Scenario_ExpectedResult` | Renombrar tests |
| **DOTNET-W5** | Lifetime de DI incorrecto | Revisar Singleton/Scoped/Transient |
| **DOTNET-W6** | `[NoTransaction]` sin justificación | Comentario explicando razón |
| **DOTNET-W7** | `plugin.json` vs `.example` desincronizados | Sincronizar manualmente |
| **DOTNET-W8** | Service con método público mockeado en vez de ejercitado | `Mock<HttpMessageHandler>` pattern, service real |
| **DOTNET-W9** | Schema de BD asumido sin verificar contra BD real | Advisor conecta a BD de dev (`appsettings.Development.json`), valida tablas/columnas/FKs contra `INFORMATION_SCHEMA`. Sin acceso → WARNING "schema no verificado". Con mismatch → WARNING específico por cada diferencia |
| **DOTNET-W10** | Setting key declarada en `plugin.json.example` pero no usada en código (dead config) | Genera ruido de configuración para admins (campos UI sin efecto). Fix: remover del `defaultSettings` o documentar uso planeado. El detector mapea keys leídas via indexer **+** keys derivadas de POCOs `IOptions<T>` (`services.Configure<T>(configuration.GetSection("Section"))` → `Section:PropertyName` por cada property pública del POCO) |
| **DOTNET-W11** | Write-path sin audit injection declarada por el proyecto (**PROJECT-gated**, 2026-08-13) | Solo si el repo declara `.tycon/advisors.yaml → audit.interface` (ej `IAuditService`); sin la key, silenciosa. Clase `*Service.cs`/`*Repository.cs` del diff que NO inyecta esa interface NI está anotada con el atributo de exclusión (`audit.exclude_attribute`, default `[ExcludeFromAuditCoverage]`). Write-paths DEBEN auditar; read-only se excluye anotado (la anotación es la constancia). Por qué: los bugs de audit-wiring solo los cazaba la full suite; esto los atrapa en el diff. Fix: inyectar la interface o anotar la exclusión con razón |
| **DOTNET-W12** | `DateTime` leído de SQL y devuelto por la API sin `Kind=Utc` explícito (2026-08-27) | `DATETIME2` no guarda offset → Dapper materializa `Kind=Unspecified` → `System.Text.Json` serializa **sin** `Z` → el navegador lo lee como hora local y no convierte. **No da error: da una hora equivocada**, que se lee igual que una correcta. Detecta materialización Dapper (`Query*<T>` async y síncrona, multi-mapping —el tipo es el ÚLTIMO genérico—, `QueryMultiple`+`GridReader`) de un tipo con props `DateTime` **que mapean a columna** y que sale hacia un controller, sin `SpecifyKind` y sin `DATETIMEOFFSET`. **Tres condiciones obligatorias**: columna UTC + no `DATETIMEOFFSET` + sale por HTTP. 🔴 La condición "columna UTC" **no se decide por el `DEFAULT`**: la columna puede no tener default y la prueba vivir en otro archivo — se verifica por DDL, por write-path buscado por nombre de tabla, o por convención del repo (sin ningún `GETDATE()`). Si guarda hora local, marcar `Kind=Utc` **introduce** un bug; **decisión por columna, nunca por repo** (hay repos que mezclan UTC y local). Si no se puede verificar → finding **"no verificable"**, nunca silencio (patrón de `DOTNET-W9`). Silenciosa sólo con converter global **confirmado semánticamente** (uno de `DateTimeOffset` no cuenta). **WARNING y no CRITICAL a propósito**: la condición 1 no es verificable en repos sin DDL local, y un control que bloquea sobre incertidumbre termina muteado. Por qué: sin esto se parchea a mano pantalla por pantalla en el frontend, y alguna se olvida. Fix: `SpecifyKind` a la salida del repositorio, o (preferido) converter global |
| **DOTNET-W13** | Token de concurrencia optimista (`DateTime`) comparado por **igualdad** contra columna `datetime2`, con Dapper sin `DbType.DateTime2` explícito (2026-09-02) | Dapper mapea `DateTime` a `DbType.DateTime` (el `datetime` viejo, 1/300 s). SQL Server **redondea ese parámetro a milisegundos** al compararlo contra `datetime2`, y `GETUTCDATE()` escribe ticks de 1/300 s (ej. `.9166667`) irrepresentables en milisegundos → **la igualdad no matchea nunca**. No da error ni excepción: el `UPDATE` afecta 0 filas, y eso se lee igual que "la fila no existe" — el defecto se disfraza justo de la condición que el código intenta detectar. Detecta `WHERE`/`AND <col> = @<param>` con parámetro `DateTime` desde Dapper (objeto anónimo o `DynamicParameters.Add` sin tercer argumento) contra columna `datetime2`. **Sólo igualdad**: en rangos (`>=`, `<`, `BETWEEN`) el redondeo mueve el borde, no rompe la consulta. Tipo de columna verificado como en `DOTNET-W9`/`W12`; sin DDL → finding "no verificable", nunca silencio. Silenciosa con type map global confirmado. **Eje distinto de `DOTNET-W12`** (aquélla es serialización de salida; ésta, comparación de entrada) — se citan por separado para que el hallazgo diga cuál de los dos es. Por qué: el defecto puede vivir meses con tests verdes que mockean el repositorio. Medido al adoptarla: **1 sola coincidencia en 6.939 archivos `.cs` de 12 repos** → entra sin deuda. Fix: `parameters.Add("ExpectedUpdatedAt", value, DbType.DateTime2)` |

---

## Tests Coverage — `tycon-plugin-tests-coverage`

Archivo del advisor: `~/.claude/agent-skills/agents/tycon-plugin-tests-coverage.md`

### CRITICAL

| ID | Nombre | Fix típico |
|---|---|---|
| **TEST-C1** | Test suite en rojo | Arreglar tests rojos antes de commit |
| **TEST-C2** | Método público nuevo con 0% coverage | Mockear dependencies externas, no el service |
| **TEST-C3** | `Map()` / endpoint sin test de auth metadata | Test reflection sobre `Map()` |

### WARNING

| ID | Nombre | Fix típico |
|---|---|---|
| **TEST-W1** | AC sin test asociado | Agregar test o documentar excepción |
| **TEST-W2** | Coverage < 75% en archivo nuevo. 🔴 **2026-08-25 — el número era MENTIROSO en .NET**: `test-gate.sh` tomaba el `max(line-rate)` por filename, y en C# cada método `async` compila a una clase APARTE con el MISMO filename. Para un repository que los tests mockean, la clase "real" tiene sólo el constructor (line-rate=1) y las máquinas de estado con las consultas dan 0 — el max() se quedaba con el 1. Medido contra el cobertura real de un producto del equipo: un repository reportaba **100%** y su valor real es **13,3%** (8 líneas de 60); 45 de sus 187 archivos con datos inflaban >5 puntos, el peor 86,7. Ahora se SUMAN las líneas por filename dentro de cada `coverage.cobertura.xml`, y el `max()` queda sólo ENTRE cobertura distintos (el caso que ese max vino a resolver: un assembly que no tocó el archivo lo reporta en 0). Afecta a TODO repo .NET del equipo — el número baja y esa baja es la real. Red: `skills/tycon-pipeline/scripts/tests/test-coverage-parser.js` | Agregar tests faltantes |
| **TEST-W3** | Tests count < declarado en story | Implementar faltantes o corregir tabla |
| **TEST-W4** | Edge case/error path sin test | Test para branches no-happy-path |
| **TEST-W8** | El test mockea el repositorio/la base y por eso NUNCA ejercita la comparación SQL real: el defecto se disfraza de la condición que el código detecta («0 filas = no existía») y vive con tests verdes (caso `DOTNET-W13`, 7 meses en producción). **No la aplica ningún advisor hoy**: la cita `tycon-plugin-dotnet-conventions` como ángulo de `DOTNET-W13` (2026-09-02); se documenta acá para que la cita no quede huérfana (`rules-distill`). W5–W7 no existen: el número lo eligió la cita y se respeta para no renumerar. | Un test de integración contra SQL real por cada `WHERE` de igualdad sobre `datetime2`/decimales, o un assert sobre la SQL generada — no un mock del repositorio |
| **TEST-W9** | El test o el doble construye A MANO un objeto/estado para el que existe un constructor real en el repo (`build<X>Payload`, `create<X>`, o el propio componente que el mock reemplaza) y no lo usa: puede estar probando una forma de datos o un comportamiento que el código real NO produce. Dos formas: un doble que no imita el comportamiento real deja verde un AC falso; y una guarda que lee el payload en una forma que el constructor real nunca arma — el test lo arma a mano con la forma que la guarda espera, y el AC no se cumple nunca en producción. Sin esta regla sólo lo cazaba el pase adversarial. **Owner: `tycon-plugin-tests-coverage`** (aviso, no freno; semi-mecánico: existencia e importación del constructor). | Que el test importe y use el constructor/componente real; si no puede (dependencias pesadas), decir por qué junto al doble |
| **TEST-W10** | Assert de performance sobre un AGREGADO entre tablas o entornos: un test de integración con `SET STATISTICS IO` (o equivalente) asserta un total o una suma que incluye tablas distintas de la que el cambio toca. El agregado es una propiedad del plan que el motor elige en cada entorno (versión, estadísticas, volumen sembrado), no del cambio (medido: el total de lecturas SUBIÓ en CI, 1.329→1.928, mientras la tabla tocada bajó igual que en la máquina del dev, 659→321). Owner: `tycon-plugin-tests-coverage` (la cita desde 2026-09-06; guía: `bizuit/bizuit-plugin-dotnet.md` §9). | Assertar sólo la métrica que el cambio causa DIRECTAMENTE (la tabla u operación tocada); el agregado se mide y se REPORTA en el mensaje de falla para diagnóstico, nunca se asserta como gate. Guía: `bizuit/bizuit-plugin-dotnet.md` §9 |

---

## SignalR Hub Reviewer — `signalr-hub-reviewer`

Archivo del advisor: `~/.claude/agent-skills/agents/signalr-hub-reviewer.md`

**Naturaleza condicional**: a diferencia de los otros advisors Core, `signalr-hub-reviewer` NO se invoca por default en cada corrida del `tycon-pipeline`. Se agrega al set paralelo **solo si** el diff incluye `**/Hubs/*.cs`, declara `IHubContext<`, o usa `Clients.X.SendAsync(...)`. Ver `~/.claude/agent-skills/skills/tycon-pipeline/steps/step-05-advisors-parallel.md` (sección "Advisors condicionales").

### CRITICAL — tenant isolation y auth

| ID | Nombre | Fix típico |
|---|---|---|
| **SIGNALR-C1** | Hub method público sin validación de tenant scope antes de operar sobre `Groups` | Agregar guard tipo `await ValidateProjectAccessAsync(projectId)` al inicio del método; throw `HubException` si no autorizado |
| **SIGNALR-C2** | Broadcast cross-tenant via `Clients.All` / `Clients.Others` / `Clients.AllExcept` sin scope | Usar `Clients.Group(groupName)` o `Clients.User(userId)` con tenant en el group name |
| **SIGNALR-C3** | `OnConnectedAsync` no aborta la conexión si la auth falla | Validar credentials/scope; si fallan: log + `Context.Abort()` + `return` antes de `base.OnConnectedAsync()` |
| **SIGNALR-C4** | `IHubContext<T>` fuera del Hub emite a Group sin tenant en el group name | Construir el group name via helper estático del Hub (ej: `NoticesHub.GetGroupName(projectId)`) |
| **SIGNALR-C5** | `Groups.AddToGroupAsync` o `Groups.RemoveFromGroupAsync` sin `await` | Agregar `await` (la operación se pierde si el método retorna antes) |
| **SIGNALR-C6** | Group name construido sin tenant identifier | Incluir `projectId`/`tenantId` en el group name (ej: `$"project_{projectId}_topic_{topicId}"`) |
| **SIGNALR-C7** | Record/DTO de evento expone campos sensibles (`PasswordHash`, `Token`, `Secret`, JWT, etc.) | Crear DTO de evento con allow-list de campos |
| **SIGNALR-C8** | Hub method `async void` | Cambiar a `async Task` (rompe propagación de errores) |
| **SIGNALR-C9** | Hub de plugin Bizuit decorado con `[Authorize]` de ASP.NET Core | Quitar `[Authorize]`; auth manual en `OnConnectedAsync`. El host Bizuit corre `UseAuthorization()` sin `AddAuthentication()` → el endpoint `negotiate` tira HTTP 500. El DevHost enmascara el bug (registra un scheme mock) |

### WARNING — calidad operacional

| ID | Nombre | Fix típico |
|---|---|---|
| **SIGNALR-W1** | `OnDisconnectedAsync` no limpia estado estático asociado a `Context.ConnectionId` | Agregar `_state.TryRemove(Context.ConnectionId, out _)` antes de `await base.OnDisconnectedAsync(...)` |
| **SIGNALR-W2** | Payload de evento sin metadata para deduplicación (`MessageId`/`EventId`/`UpdatedAt`/`Sequence`) | Agregar al menos un identificador estable + timestamp |
| **SIGNALR-W3** | Hub con estado estático sin justificación documentada (riesgo cluster multi-instancia) | Documentar la decisión, o mover a Redis backplane / cache distribuido |
| **SIGNALR-W4** | `HubException` sin mensaje accionable para el cliente | Mensaje específico que diga qué falló y qué hacer |
| **SIGNALR-W5** | Hub nuevo/modificado en plugin Bizuit — recordatorio de deployment `DisableARR` | Verificar que el `web.config` del host (`*BIZUITExtensionsAPI`) tenga la regla rewrite `DisableARR` (`ARR_DISABLE=1`). Sin ella, ARR buffea la respuesta y rompe el handshake `101` del WebSocket: `negotiate` da 200 y LongPolling anda, pero WS falla. No detectable en el diff — recordatorio de infra |

---

## Migration Impact Analyzer — `migration-impact-analyzer`

Archivo del advisor: `~/.claude/agent-skills/agents/migration-impact-analyzer.md`

**Naturaleza condicional**: igual que `signalr-hub-reviewer`, NO se invoca en cada corrida del `tycon-pipeline`. Se agrega al set paralelo **solo si** el diff incluye archivos `database/*.sql`. Ver `~/.claude/agent-skills/skills/tycon-pipeline/steps/step-05-advisors-parallel.md` (sección "Advisors condicionales").

### CRITICAL — breakage de schema o code

| ID | Nombre | Fix típico |
|---|---|---|
| **MIGRATION-C1** | Numeración duplicada de migración (dos `NNN_*.sql` con mismo prefijo) | Renumerar uno de los dos al siguiente número libre y bumpear los siguientes si aplica |
| **MIGRATION-C2** | DROP COLUMN / DROP TABLE de un objeto referenciado en código (`Features/`, `Services/`, `Workers/`, `Repositories/`) | Actualizar código primero o cambiar a deprecate-then-drop (nullable + remover usos en otra migración) |
| **MIGRATION-C3** | RENAME COLUMN / RENAME TABLE sin update del código (nombre viejo aún aparece en `.cs`) | Actualizar referencias en el mismo PR |
| **MIGRATION-C4** | ALTER COLUMN con cambio de tipo incompatible (ej: `nvarchar` → `int`) | Migración de datos previa (UPDATE con cast seguro) o staging column |
| **MIGRATION-C5** | DDL + DML combinados sin `BEGIN TRAN`/`COMMIT TRAN`, **cuando la mezcla es riesgosa**: el DDL es destructivo (`DROP`/`ALTER` de tipo/`RENAME`) o la DML puede perder datos (`UPDATE`/`DELETE` sin guard). Si TODO el bloque es aditivo e idempotente (CREATE + INSERT con `IF NOT EXISTS`/`WHERE NOT EXISTS`), degrada a WARNING — un fallo a medio camino se re-corre sin daño, no deja el schema inconsistente. Redacción calibrada 2026-08-22: es lo que el advisor ya hacía en la práctica. El must-flag `mig-c5-ddl-dml-sin-transaccion` mide la mitad CRITICAL (DDL destructivo) y el caso `mig-c5-aditivo-idempotente-degrada-warning` fija la otra mitad: la mezcla aditiva e idempotente sin transacción DEBE seguir citando C5 (como WARNING) — la calibración no la silencia | Envolver en transacción explícita o splitear en migraciones separadas |

### WARNING — gaps operativos

| ID | Nombre | Fix típico |
|---|---|---|
| **MIGRATION-W1** | Falta idempotencia (CREATE/ALTER/INSERT sin guards `IF NOT EXISTS`) | Agregar guards condicionales antes de cada operación |
| **MIGRATION-W2** | Seeder / data canónica desactualizado | Actualizar `database/seed.sql` o seeders equivalentes en el mismo PR |
| **MIGRATION-W3** | Sin sección PRINT/log de auditoría | Agregar PRINTs en cada paso (ver migración 020 de Pacara como referencia) |

---

## HTTP Client Resilience .NET — `http-resilience-reviewer`

Archivo del advisor: `~/.claude/agent-skills/agents/http-resilience-reviewer.md`

**Naturaleza condicional**: igual que `signalr-hub-reviewer` y `migration-impact-analyzer`, NO se invoca en cada corrida del `tycon-pipeline`. Se agrega al set paralelo **solo si** el diff toca código HTTP cliente .NET (`HttpClient`, `IHttpClientFactory`, `AddHttpClient`, `AddResilienceHandler`/`AddStandardResilienceHandler`, `ResiliencePipeline`, `Polly`). Ver `~/.claude/agent-skills/skills/tycon-pipeline/steps/step-05-advisors-parallel.md` (sección "Advisors condicionales").

**Scope**: solo .NET. Clientes HTTP en JS/TS (`fetch`, `axios`) NO están cubiertos por este advisor.

### CRITICAL — breakage real en producción

| ID | Nombre | Fix típico |
|---|---|---|
| **HTTP-C1** | `new HttpClient()` directo (socket exhaustion) | Inyectar `IHttpClientFactory` y resolver con `factory.CreateClient(name)`, o usar typed client `services.AddHttpClient<TClient>()` |
| **HTTP-C2** | Retry sin timeout total acotado (retry storm cuando upstream se cuelga) | Agregar `AddTimeout` total a la pipeline, o usar `AddStandardResilienceHandler` que combina retry + timeout + breaker |
| **HTTP-C3** | Timeout per-attempt ≥ timeout total (timeout granular nunca dispara) | `AttemptTimeout < TotalTimeout / (MaxRetryAttempts + 1)` con margen |
| **HTTP-C4** | Secrets en logs de retry / catch HTTP (Authorization, X-Api-Key, query tokens) | Redactar headers sensibles + query params al loggear; nunca `request.ToString()` ni `LogXxx(... ex)` con `HttpRequestException` que arrastra el request |
| **HTTP-C5** | `CancellationToken` no propagado a `HttpClient.SendAsync/GetAsync/PostAsync` | Pasar el token disponible a cada llamada async HTTP |
| **HTTP-C6** | `EnsureSuccessStatusCode` antes de leer body en error → pierde diagnóstico del proveedor | Para no-2xx: leer body, loggear (sin secrets), throw con contexto |
| **HTTP-C7** | API estática de `Microsoft.Extensions.Http.Resilience` (`GetRequestMessage()`, `HttpClientResiliencePredicates.*`) dentro de un predicado de resiliencia de un plugin Bizuit — el host carga SU versión de la librería y pisa la del plugin: `MissingMethodException` en cada llamada del cliente, 500 en toda la feature; verde en local y CI | Leer el request por la clave cruda `ResiliencePropertyKey<HttpRequestMessage>("Resilience.Http.RequestMessage")` + delegar al predicado default capturado antes de reemplazarlo + fail-closed. Alinear además la versión del paquete del plugin y de sus tests con la del host |

### WARNING — gaps operativos

| ID | Nombre | Fix típico |
|---|---|---|
| **HTTP-W1** | Retry sin jitter (thundering herd) | `UseJitter = true` en `RetryStrategyOptions`, o `Polly.Contrib.WaitAndRetry.DecorrelatedJitter` |
| **HTTP-W2** | Falta circuit breaker para endpoint externo | Agregar `AddCircuitBreaker` o pasar a `AddStandardResilienceHandler` |
| **HTTP-W3** | `HttpClient` sin nombre / typed client | Registrar named (`AddHttpClient("twilio", c => ...)`) o typed (`AddHttpClient<ITwilioClient, TwilioClient>()`) |
| **HTTP-W4** | `HttpClient.Timeout` mezclado con timeout en pipeline (doble fuente de verdad) | Una sola fuente: o `HttpClient.Timeout = Timeout.InfiniteTimeSpan` + pipeline timeout, o `HttpClient.Timeout` directo sin pipeline timeout |
| **HTTP-W5** | Retry aplicado a POST con efectos (riesgo de duplicación) | Filtrar retry por status (`5xx + 408 + 429`), o desactivar retry en clients con side effects, o usar idempotency key |

---

## Worker Lifecycle .NET — `worker-lifecycle-reviewer`

Archivo del advisor: `~/.claude/agent-skills/agents/worker-lifecycle-reviewer.md`

**Naturaleza condicional**: NO se invoca en cada corrida del `tycon-pipeline`. Se agrega al set paralelo **solo si** el diff toca código que herede de `BackgroundService` o implemente `IHostedService` (.NET). Ver `step-05-advisors-parallel.md` (sección "Advisors condicionales").

**Scope**: solo .NET. Workers en JS/TS (Node.js BullMQ, RabbitMQ consumers) NO están cubiertos por este advisor.

### CRITICAL — workers zombie o muerte silenciosa

| ID | Nombre | Fix típico |
|---|---|---|
| **WORKER-C1** | `ExecuteAsync` sin try/catch dentro del polling loop (1 row mata el worker) | Envolver el cuerpo del `while (!stoppingToken.IsCancellationRequested)` en try/catch que log + continue al siguiente iteration |
| **WORKER-C2** | `stoppingToken` no propagado a operaciones cancelables async | Pasar `stoppingToken` a cada llamada async cancelable (`Task.Delay`, `httpClient.GetAsync`, `dbContext.SaveChangesAsync`, `ExecuteReaderAsync`, `Channel.Reader.ReadAsync`) |
| **WORKER-C3** | `Task.Delay` sin token (bloquea shutdown N segundos) | `await Task.Delay(TimeSpan.FromSeconds(N), stoppingToken)` |
| **WORKER-C4** | `SemaphoreSlim`/`IDisposable` sin try/finally para Release/Dispose | `try { await sem.WaitAsync(...); ... } finally { sem.Release(); }` o `using` |
| **WORKER-C5** | Worker registrado como `AddSingleton<T>` en vez de `AddHostedService<T>` (nunca arranca) | `services.AddHostedService<MyWorker>()`. Para health-check inspection, registro dual: `AddSingleton<T>().AddHostedService(sp => sp.GetRequiredService<T>())` |

### WARNING — gaps operativos

| ID | Nombre | Fix típico |
|---|---|---|
| **WORKER-W1** | Polling sin jitter (thundering herd entre instancias) | Agregar `Random.Shared.Next(0, jitterMs)` al delay |
| **WORKER-W2** | Worker sin heartbeat / health registry | Registry singleton (ej: `WorkerHealthRegistry`) actualizado cada N iteraciones + endpoint `/health/workers` |
| **WORKER-W3** | `OperationCanceledException` no manejada explícitamente (spam ERROR en shutdown) | `catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { /* expected */ }` antes del catch genérico |
| **WORKER-W4** | `ExecuteAsync` sin log inicial / final del lifecycle | `LogInformation("{Worker} starting/stopped", nameof(MyWorker))` al entrar y al salir |

---

## Feature Wiring Checker — `tycon-feature-wiring-checker`

Archivo del advisor: `~/.claude/agent-skills/agents/tycon-feature-wiring-checker.md`

**Naturaleza condicional + stack-specific**: NO se invoca en cada corrida del `tycon-pipeline`. Se agrega al set paralelo **solo si** el diff toca `**/*.tsx` (mount detection), agrega componente / hook / store action exportado, **O** agrega endpoint `MapGet/MapPost/MapPut/MapDelete/MapPatch` en `.cs`. Ver `~/.claude/agent-skills/skills/tycon-pipeline/steps/step-05-advisors-parallel.md` (sección "Advisors condicionales").

**Stack soportado V1**: React 18 + TypeScript + Zustand + esbuild + vitest **+** .NET 9 + Minimal API + Bizuit Plugin (`IPluginEndpointBuilder` + `BizuitUserContext`). Otros stacks (Vue, Angular, Blazor, Razor, Svelte, mobile nativo, Express/Node.js) NO soportados — advisor separado pendiente.

**Por qué**: advisors, tests y builds en verde no prueban que la feature esté conectada. Los gaps "código done, feature dead" típicos: un componente exportado pero nunca mounted, una store action con 0 callsites, un shortcut que solo hace `preventDefault`, un contador sin sync hook, una toolbar sin su botón. Sin este advisor, ningún otro detecta estos patrones.

### CRITICAL — bloquea commit prep

| ID | Nombre | Fix típico |
|---|---|---|
| **WIRING-C1** | Componente React exportado sin mount real. Grep `<ComponentName` en `src/**/*.tsx` excluyendo `__tests__/` + `*.test.tsx` + `*.stories.tsx` + archivo del propio componente → 0 matches | Mount el componente en el layout/page del shell del feature. Ejemplo: `<RemitoModal userRoles={userRoles} />` en `DepositoLayout.tsx`. Falso positivo esperado: `React.lazy(() => import('./X'))` — override con razón |
| **WIRING-C2** | Zustand store action sin invocación real. Para cada action exportada en `store/use<X>Store.ts` del diff, grep `useXStore(.*)\.actionName(` o `useXStore.getState().actionName(` en `*.tsx`/`*.ts` excluyendo tests → 0 matches | Invocar la action desde el handler que debe disparar el cambio de estado. Ejemplo: `const openModal = useDespachoStore(s => s.openRemitoModal); openModal([])` |
| **WIRING-C3** | React hook side-effect sin mount en el árbol del app shell. Hook agregado con `useEffect` + (`setInterval`/`fetch`/`api.get`/`signalrService.on`/`.subscribe`) → grep `useX(` en `src/**/*.{tsx,ts}` excluyendo tests + archivo del propio hook → 0 matches | Invocar el hook desde el componente root del feature (DepositoLayout, AdminLayout, o page-level component). Ejemplo: `useColaDeArmadoSync()` en `DepositoLayout.tsx` |
| **WIRING-C4** | Keyboard event handler con `event.preventDefault()` sin user action. Listener `keydown`/`keyup` agregado en el diff que llama `preventDefault()` pero no invoca store action, navigate, set state visible, ni función con verbo de acción (`open*`, `close*`, `submit*`, etc.) | Agregar la action que debe responder al shortcut. Ejemplo: `if (event.ctrlKey && event.key === 'p') { event.preventDefault(); openRemitoModal([]); }` |
| **WIRING-C5** | (2026-06-09, enforcea Regla 11.1 de `workflow-orchestration.md`) Diff crea/modifica layout, navegación o estructura de pantalla (`*Layout*`, `*Nav*`, `Sidebar*`, `Drawer*`, routing) SIN evidencia de validación contra el artefacto de IA: ni `navigation-map.md`/UX spec en el diff (divergencia ratificada en el mismo PR) ni cita concreta de consistencia en la story/Dev Agent Record. Por qué: un layout que diverge en silencio del catálogo aprobado obliga a una reconciliación semanas después. Si el repo no tiene artefacto de navegación → degrada a WARNING | (a) ratificar el modelo nuevo editando el artefacto de IA EN el mismo PR, (b) ajustar la implementación al artefacto, o (c) si toca modelo firmado por el cliente → CR registrado (Regla 12.3 + signed-scope-guardrails.md) |

### WARNING — no bloquea, reportar

| ID | Nombre | Fix típico |
|---|---|---|
| **WIRING-W1** | `data-testid` declarado en spec Mary+GOLD sin uso en código. Story `.md` menciona `data-testid="X"` → grep `data-testid="X"` en `src/**/*.{tsx,ts}` → 0 matches. Tests E2E que dependan del testid van a fallar runtime | Agregar el atributo al elemento JSX correspondiente. Si la story se equivocó con el testid, corregir en la story |
| **WIRING-W2** | Badge/count prop sin sync hook. Componente acepta prop `^(count\|badge.*\|pending.*\|unread.*)Count|^count$` typed como `number` pero el diff no incluye hook con `useEffect` + `setInterval`/SignalR/`.subscribe()` que populate la fuente | Agregar hook de sync (polling o SignalR listener) + invocarlo en el layout/page del feature. Ver patrón `useNotificationsSync` o `useColaDeArmadoSync` como referencia |
| **WIRING-W3** | Endpoint .NET Minimal API sin caller frontend. Endpoint `endpoints.Map(Get\|Post\|Put\|Delete\|Patch)("ruta")` nuevo en `.cs` → grep `'/api/ceibo/<ruta>'` (y variantes) en frontend → 0 matches. WARNING (no CRITICAL) porque hay casos legítimos: endpoint admin, integración B2B, spike preliminar. Si V2 confirma que estos casos son raros y el equipo quiere bloqueo duro, promover a `WIRING-C5` real CRITICAL | Agregar wrapper en `services/<feature>Api.ts` + caller desde el componente que consume. O override con razón si es admin-only / integración externa / spike |
| **WIRING-W4** | Módulo COMPARTIDO modificado sin enumerar sus consumidores: el diff cambia la firma o el comportamiento de un símbolo exportado (service, hook, helper) que importan DOS o más apps/paquetes del mismo repo, y la story nombra sólo al consumidor que motivó el cambio. Los demás reciben el cambio sin prueba, smoke ni E2E: se cubren «por construcción», no por chequeo. Ejemplo: el fix de un servicio compartido que consumen dos apps, y ningún reporte nombra a la segunda. `XPAT-*` cubre plugins backend hermanos en repos separados, no apps del mismo monorepo. Owner: `tycon-feature-wiring-checker`. | Listar los consumidores REALES por import (`grep -rl` / codegraph callers) y compararlos con los que la story nombra; el finding enumera los que faltan y pide test o smoke por consumidor, o la nota de por qué no aplica |

Anti-patterns (lo que NO hace este advisor):
- NO valida lógica funcional del componente (eso es `tycon-plugin-tests-coverage`).
- NO valida que sea visualmente correcto (out of scope).
- NO bloquea WARNINGs (W1, W2, y C5 marcado WARNING) — el dev decide.
- NO soporta Vue/Blazor/Angular/Svelte/mobile/Express en V1 — skipea con mensaje explícito.
- NO usa AST analysis — heurísticas grep-based. Falsos positivos esperados en patterns dinámicos (lazy, subscribe, render props, JSX construido via `React.createElement`).

---

## SignalR Client Reviewer — `signalr-client-reviewer`

Archivo del advisor: `~/.claude/agent-skills/agents/signalr-client-reviewer.md`

**Naturaleza condicional**: NO se invoca en cada corrida del `tycon-pipeline`. Se agrega al set paralelo **solo si** el diff toca código que use `HubConnection` / `HubConnectionBuilder` (.NET) o importe `@microsoft/signalr` (JS/TS).

**Scope**: clientes (consumidores) del Hub. Ortogonal a `signalr-hub-reviewer` que cubre el server-side. Cubre tanto .NET (`Microsoft.AspNetCore.SignalR.Client`) como JS/TS (`@microsoft/signalr`) — un solo advisor para ambas plataformas.

### CRITICAL — pérdida de eventos, leak de credentials/PII

| ID | Nombre | Fix típico |
|---|---|---|
| **SIGNALRC-C1** | Handler `On<T>` no-idempotente (procesa duplicados sin deduplicar) | Chequeo idempotente al inicio del handler: cache de IDs procesados, `INSERT ... WHERE NOT EXISTS`, o unique constraint capturada como expected |
| **SIGNALRC-C2** | Reconnect sin re-suscribir grupos (subscriptions perdidas) | `connection.onreconnected(() => resubscribe())` (JS) / `_connection.Reconnected += async (id) => await ResubscribeAsync()` (.NET) |
| **SIGNALRC-C3** | Token hardcoded sin `accessTokenFactory` / `AccessTokenProvider` | `accessTokenFactory: async () => await getFreshToken()` — la lambda se invoca en cada (re)connect |
| **SIGNALRC-C4** | Handler loguea PII / payload completo | Loggear solo IDs y metadata (`MessageId`, `ContactId`) — nunca el contenido del payload |

### WARNING — gaps operativos

| ID | Nombre | Fix típico |
|---|---|---|
| **SIGNALRC-W1** | Sin fallback polling cuando `state !== Connected` | Polling REST cada M segundos cuando `state !== Connected` por más de N segundos. Justificable solo si el caso de uso es real-time crítico (chat). |
| **SIGNALRC-W2** | Evento `Closed`/`onclose` sin handler que loggee motivo | Handler que log `exception?.Message` + `connectionId` + estado del reconnect |
| **SIGNALRC-W3** | `WithAutomaticReconnect()` sin `KeepAliveInterval` configurado | `KeepAliveInterval = TimeSpan.FromSeconds(10)` (default 15s puede ser insuficiente con LBs aggressive) |

---

## DoD Runtime Checker — `tycon-dod-runtime-checker`

(2026-05-13) Cierra el gap entre **"build verde + tests verde + advisors verde"** y **"production-ready"**. La guía `definition-of-done.md` declara que *"Build verde NO alcanza"* — este advisor enforce los gates runtime que ningún otro advisor cubre. Corre **post-push, pre-`done`-transition** (NO en Step 5 paralelo — separado).

**Por qué**: con todos los advisors en verde post-loop D.i pueden escapar 3 gaps reales: smoke check runtime NO ejecutado, CI run post-push NO verificado, TransactionScope + Dapper enlist NO verificado runtime. Este advisor cubre esos 3 gaps explícitamente.

### CRITICAL

| ID | Nombre | Fix típico |
|---|---|---|
| **DODRT-C1** | Smoke check runtime ausente — no existe evidencia de curl real contra DevHost para los endpoints/features nuevos de la story. Heurística: identificar endpoints nuevos via grep `endpoints\.Map*` en files modificados, buscar `.advisors/pipeline-runs/story-{N}-*/smoke-check.md` con output curl + response code. Si falta → CRITICAL | Arrancar DevHost (`./scripts/devhost.sh start`), correr curl con auth headers contra DevHost real para cada endpoint nuevo, capturar response code + body parseable, guardar en `.advisors/pipeline-runs/story-{N}-*/smoke-check.md` |
| **DODRT-C2** | CI run post-push no verificado — commit pusheado pero no hay evidencia de que CI pasó verde. Heurística: `az pipelines runs list --branch <branch> --query "[?triggerInfo.\"ci.sourceSha\"=='<sha>']"` o `gh run list --commit <sha> --json conclusion`. Si vacío → CRITICAL (puede ser FRESNO-pattern: trigger no fired); si `failed` → CRITICAL | (a) verificar `azure-pipelines.yml` triggers matchean paths del diff; (b) si FRESNO-pattern, agregar commit trivial sobre `.cs` para forzar trigger; (c) re-correr advisor cuando CI termine |
| **DODRT-C3** | Patterns transaccionales sin runtime verification — código usa `TransactionScope` / `BeginTransaction` para wrap operaciones críticas, pero no hay test que fuerce excepción mid-transaction y verifique rollback total. Heurística: grep tx patterns en files modificados, cross-check con tests del feature por `ThrowsAsync<Db*Exception>` + Verify de no-state-change | Agregar test que use `TransactionScope` real con SQLite in-memory O TestContainers, fuerce excepción mid-update, y assert no-state-change. Sin esto, el TransactionScope puede no estar enlistado correctamente con Dapper |
| **DODRT-C4** | (2026-05-20) E2E declarado en `pipelines.X.tests_done` falla realness check del `tycon-e2e-realness-checker`. Heurística: leer frontmatter `pipelines:` block, por cada E2E name en `tests_done`, localizar spec en `tests/e2e/*.spec.ts` y aplicar reglas REAL-C1/C2/C3. Si algún spec falla → bloquea status→done. Defensa estructural contra "E2E verde declarado como cobertura runtime de AC user-visible" cuando el spec en realidad es API-only stub o mockea backend de negocio. 🔴 **Pendiente (2026-08-21)**: el set de realness se amplió y esta fila —y el `.md` de este advisor— siguen enumerando las tres reglas originales; hay que ampliarlo a **todo el set `REAL-C*`**, si no los CRITICAL nuevos del realness checker no bloquean `status→done` | Fixear el spec según finding REAL-Cn correspondiente: agregar interacción UI real + asserts visuales DOM (REAL-C1), remover `page.route()` sobre endpoints de negocio (REAL-C2), agregar asserts visuales después del dev seam (REAL-C3). O remover el E2E falso de `tests_done` y declarar cobertura runtime por otro medio |
| **DODRT-C5** | (2026-07-03) UI story con E2E diferido (`pipelines.X.tests_pending` con `E2E-*` inexistentes) + smoke DRIVEN por-AC ausente/parcial/mockeado, O el orquestador afirmó "DoD complete/probado/verificado/smoke passed" (o entregó una guía "cómo probar" como si la hubiera ejecutado) sin ejecución real — sub-check anti pre-claim. Aplica AUNQUE el status siga `in-progress` (WIP no waivea). Heurística: diff cablea `.tsx` montados + `tests_pending` con `E2E-*` sin spec → exige `.advisors/dod-runtime/<story>-ui-smoke-*.md` real (app viva `dev.html` + datos seedeados, no `page.route()`) aserteando CADA AC de UI; cruzar AFIRMADO vs EJECUTADO | Correr un script Playwright que maneje la app real y asserte los N ACs de UI (cada modal/pantalla/RBAC/validación/estado visible), capturar evidencia (mapeo AC→assertion + screenshots). "E2E diferido" y "WIP in-progress" NO waivean. Nunca narrar verificación sin ejecutar; las guías al user etiquetan `✅ verificado-por-mí (evidencia)` vs `🔲 para-el-user`. Complementa ACCOV-C7 |
| **DODRT-C6** | (2026-07-10) Matriz de verificación runtime por AC: `dod` verde prueba que el spec E2E declarado terminó en 0, NO qué ACs quedaron ejercitados. Cada AC necesita evidencia de EJECUCIÓN (gate E2E con exit 0, o smoke registrado vía `smoke-run.sh`). Verde sólo si todo AC es RUNTIME o el resto está declarado `runtime_not_verifiable:` y aprobado por el USUARIO desde su terminal | Correr los ACs sin evidencia (E2E/smoke real) o declararlos imposibles con su `covered_by:` y pedirle el waiver TTY al usuario. Script: `runtime-matrix.js` |
| **DODRT-C7** | Guía de prueba manual del tester ausente o ilegible para una story operable a mano: faltan los pasos en criollo (`<repo>/qa/<sid>-pasos.md`), hay ACs verificados corriendo sin pasos, hay jerga de software, falta la review de legibilidad con veredicto OK, falta declarar con qué usuario se prueba, o (desde 2026-08-05) hay ACs cuyo TITULAR en la guía sería el texto técnico del criterio — incluidos los no verificables por la app, que igual aparecen y el tester los lee. Sólo se exige descripción cuando el AC no se entiende solo (lo decide el mismo detector de jerga), para no pedir de más | Escribir los pasos en castellano llano (qué hacer / qué tenés que ver), declarar `Usuario:` por AC o `Usuario por defecto:`, y correr la pasada de legibilidad. Script: `qa-guide.js --check` |
| **DODRT-C8** | (2026-08-05) **"Verificado corriendo" sobre un AC de ACCIÓN cuya acción nunca se ejecutó**: el AC describe algo que el usuario HACE (asignar, confirmar, crear, enviar, iniciar…) y la corrida sólo OBSERVÓ la pantalla — el E2E aserta que el botón es visible, la matriz lo da 🟢 RUNTIME y la acción falla en la app real. Heurística: verbo de mutación en el texto del AC + ausencia de (a) test del gate E2E titulado `@mutates` con el `@ac-N` del AC, o (b) smoke con método de escritura (`-X POST\|PUT\|PATCH\|DELETE`, `--data`). Veredicto `RUNTIME-PARCIAL`: bloquea igual que NOT-RUN | Hacer que la prueba EJECUTE la acción: test E2E con `@mutates ... @ac-N` que apriete el botón de verdad, o smoke que escriba vía `smoke-run.sh`. Si es materialmente imposible, declarar el AC en `runtime_not_verifiable:` con su `covered_by:` y que lo apruebe el usuario. Requiere que el gate E2E del repo escriba la sección `## Tests corridos` en su evidencia. Escotilla (deja rastro): `TYCON_RUNTIME_MATRIX_NO_MUTATION_CHECK=1`. **2026-08-25 — el verbo se juzga por CONTEXTO, no por la lista sola** (por qué: en una feature READ-ONLY el falso positivo deja al pipeline SIN salida limpia, porque las tres salidas previstas exigen declarar una mutación que no ocurre). Neutralizan: negación INMEDIATA (`no se descarta`) y lookup (`resuelve en Parameters` — sólo `resolver` con complemento `en/por/contra/desde`). Desde 2026-10-07 también el condicional (`cada deploy borraría la columna`: describe lo que pasaría, no algo que el usuario hace; el futuro `se creará` sigue disparando) y el rechazo HTTP (`se rechaza sin invocar el handler: 401` — sólo `rechazar` con un código 4xx a menos de 45 caracteres en la misma oración; `el supervisor rechaza la solicitud` sigue disparando). Medido sobre 8336 ACs locales: saca 2, los dos rechazos de un sistema. Desde 2026-10-09, el «sin» pegado a un infinitivo de la lista (`sus pruebas pasan sin editar`, `reusa el servicio sin modificar sus contratos`: describen algo que NO pasa), salvo que el AC hable de repetición o duplicado (`el mismo pedido 2x → 200 sin crear duplicado`, `llega de nuevo`, `nuevamente`, `upsert`…): ahí alcanza UNA señal para que siga disparando. Medido sobre 11.888 criterios de 1.003 stories: cambian 59. Límite aceptado: dos criterios de acción cuyo verbo real no está en la lista (`arrancar`, `agregar`) marcaban sólo por ese «sin» y dejan de marcar; sumar verbos a la lista se mide aparte. NO neutralizan: negación lejana, ni un AC de RE-EJECUCIÓN (`con la orden ya iniciada … NO crea un duplicado` — ahí la acción SÍ se ejecuta, dos veces, y es justo donde más vale exigir la corrida; pide repetición + duplicación juntas). Cuando aun así la heurística se equivoca —el verbo NOMBRA un endpoint, un botón o un permiso y el AC verifica que la acción se BLOQUEA: `los endpoints asignar / cerrar retornan 403`— la salida es declararlo EN EL AC: `@runtime-exempt(DODRT-C8): <motivo>`. Corrige la CLASIFICACIÓN, NO la verificación (el AC sigue necesitando su evidencia de corrida). Motivo OBLIGATORIO (sin motivo no cuenta y avisa), cada uso contado en el artefacto y en warnings, y con ≥3 en una misma story el artefacto grita. Medido sobre 1222 stories / 8864 ACs del equipo: el fix de contexto rescata 213 falsos positivos con 0 positivos nuevos, y quedan ~238 que sólo la declaración resuelve |
| **DODRT-C9** | (2026-08-25) **Procedencia del target del smoke — "verde contra la laptop" indistinguible de "verde"**: el smoke corre contra un DevHost local que sirve un backend cuyo commit existe SOLO en esa máquina (el push nunca se ejecutó); la evidencia dice "verde" sin registrar contra qué, y los endpoints responden 200 precisamente porque el código que falta en el remoto está en el disco — el front se promueve a main llamando endpoints que no existen en ningún deploy posible. DODRT-C2 no lo cubre (su waive branch-aware aplica al commit propio; acá el agujero es el repo DEPENDIENTE). Heurística: evidencia de smoke en `.advisors/dod-runtime/` sin bloque `## Target` (URL + por repo involucrado: path, SHA del HEAD servido, presencia en `origin`) → C9 evidencia ciega; SHA declarado NO presente en origin (verificable con `git branch -r --contains <sha>` si el path existe) → C9; smoke `localhost` de story frontend sin NINGÚN repo backend declarado → C9 procedencia incompleta; path no verificable en esta máquina → WARNING explícito, nunca silencio. Criterio ÚNICO: "presente en origin" (alcanzable desde algún ref de origin — una feature pusheada sin mergear NO es finding); "ancestor de origin/main" queda informativo. Límite declarado: el bloque lo escribe el auditado (v2: el smoke-runner estampa la procedencia solo) | Agregar el bloque `## Target` a la evidencia (`git rev-parse HEAD` + `git branch -r --contains <sha>` por repo involucrado); si el SHA no está en origin → pushear ANTES de cerrar la story. Complementa la capa mecánica: hook `unpushed-work-notice.js` (aviso al arranque/stop/push) + step 0.6 de `/tycon-merge-to-main` (scan del grupo de repos en el preflight) |

### WARNING

| ID | Nombre | Fix típico |
|---|---|---|
| **DODRT-W1** | Smoke check ejecutado pero sin captura estructurada en `.advisors/pipeline-runs/<story>/smoke-check.md` | Capturar curl outputs + response codes en archivo persistente para auditoría regulatoria (21 CFR Part 11 / ISO 15189 si aplica) |
| **DODRT-W2** | CI configurado pero `paths:` triggers no incluyen archivos del diff (probable trigger no-fire) | Ajustar `trigger.paths.include` en `azure-pipelines.yml` o `.github/workflows/*.yml` para cubrir paths del feature |
| **DODRT-W3** | (BZURL, 2026-07-15) Smoke/script/E2E contra staging/prod con URL shape de DevHost — falta el prefijo `/api/plugins/{pluginName}/{version}/`. Heurística: evidencia de smoke (`smoke-check.md`, scripts, specs E2E) con URL `https://<host bizuit>/api/{ruta}` sin `/plugins/` cuando el target NO es localhost:5001; o diagnóstico "endpoint roto en staging" ante 404 body-vacío con el mismo path verde en DevHost. Incidente recurrente multi-proyecto — el 404 body-vacío es la URL, no el endpoint | Rearmar la URL con el prefijo `/api/plugins/{pluginName}/{version}/{ruta}` (nombre + versión del `plugin.json`). Tabla de routing por entorno: `bizuit/bizuit-plugin-dotnet.md` §7 + callout BZURL, `definition-of-done.md` §1, README "Regla siempre activa — BZURL" |

Anti-patterns (lo que NO hace este advisor):
- NO ejecuta el smoke check por su cuenta (solo verifica que se haya hecho).
- NO triggea el CI run (solo verifica que pasó).
- NO escribe los tests de rollback (solo verifica que existen).

---

## Spec-First Checker — `tycon-spec-first-checker`

Archivo del advisor: `~/.claude/agent-skills/agents/tycon-spec-first-checker.md`

Cierra el loop **código → spec** detectando scope creep no documentado entre una story Mary+GOLD y el diff propuesto o implementado. Corre en **dos modos**: pre-coding (antes de cada coding phase del Step 4 del `tycon-pipeline`) y post-implementation (Step 5 paralelo, y **default** si el caller no declara `phase`). CRITICAL inmediato — bloquea coding phase o commit prep si encuentra endpoints/componentes/contratos/filtros/exceptions no descritos en spec.

**Stack-agnostic**: corre sobre cualquier stack TYCON con stories Mary+GOLD (Ceibo React+.NET, plugins Bizuit React/TS, plugins Bizuit .NET).

**Por qué**: la regla "spec-first: si surge algo nuevo durante implementación, actualizá la story PRIMERO, después código" se puede romper varias veces dentro de una misma story (un wiring olvidado, un error mapping nuevo, un filtro de tenant, un response shape distinto, UI nueva), y cada vez la corrige el usuario a mano. Sin este advisor, ningún otro detecta el patrón "código primero, spec después".

### CRITICAL — bloquea coding phase / commit prep

| ID | Nombre | Fix típico |
|---|---|---|
| **SPEC-C1** | Endpoint REST nuevo (`MapGet/MapPost/MapPut/MapDelete/MapPatch` en `.cs` o `api.get/post/put/delete` / `fetch(...)` en frontend) que NO aparece literalmente en `## Acceptance Criteria` ni en `### Archivos a crear/modificar` del spec | Actualizar AC del spec mencionando el endpoint (verbo + ruta + response shape) ANTES de implementar. Si la ruta ya estaba documentada y solo cambió el handler interno, OK |
| **SPEC-C2** | Componente UI nuevo (`.tsx` con `export function|const <PascalName>`) exportado del barrel del feature sin AC que lo mencione | Agregar referencia al componente en AC correspondiente + `### Archivos a crear/modificar` antes de codear |
| **SPEC-C3** | Cambio de response shape de endpoint existente: record/DTO/interface en código agrega/quita/renombra campos respecto al shape declarado en spec | Actualizar la sección del AC que describe el shape (e.g. AC #1 "preview endpoint shape") con la lista nueva de campos ANTES de mergear |
| **SPEC-C4** | ⚠️ **Alcance ACOTADO 2026-08-21 — la parte de campos extra en payload/evento migró a `SPEC-W7`.** Hoy cubre SOLO la mitad mecánica y objetiva: el AC declara una compound condition con `AND` / `Y` / `+ además` / `adicionalmente` que combina ≥2 predicados y el código evalúa menos predicados de los declarados (verificable contando predicados). Ejemplo: el AC dice *"Si los hashes divergen → 409 **AND** the diff classifier finds at least one incompatible field"* — código emite DIVERGENT_PAYLOAD siempre que hash diverja sin chequear el 2do predicado. Antes del 2026-08-21 esta regla también cubría "assertion/branch que asume comportamiento no declarado" con campos de más en un payload; esa mitad es de juicio (su propio fix admitía "OK") y hoy es `SPEC-W7` | (a) update spec para reflejar la decisión defensiva (drift legítimo + Change Log entry), O (b) update code para implementar el predicado faltante — decidir según riesgo operativo. Con comentario en código **Y** entrada en `## Change Log` degrada a `SPEC-W4` (nunca a `SPEC-W2`) |
| **SPEC-C5** | Nueva exception tipada (`class XxxException : Exception`) o nuevo error mapping (catch + status code) que NO aparece en sección `### Errores` del spec | Agregar la exception type + condiciones que la disparan + HTTP response mapping a `### Errores` del spec ANTES de mergear el código que la lanza |
| **SPEC-C6** | Veredicto emitido sin haber podido leer los insumos (auto-chequeo: corre SIEMPRE y PRIMERO). La story no se resuelve/no se lee, su frontmatter no cierra o no expone `story:`/`status:` con el regex de `lint-story-frontmatter.js`, no hay `## Acceptance Criteria` con ≥1 AC numerado, o el diff/lista de archivos llega vacío. Sin esta regla, "el control no corrió" y "el control salió limpio" se ven idénticos (🟢 OK falso), y un spec ilegible produce una lluvia de falsos CRITICAL | Veredicto obligatorio **INCONCLUSO** nombrando qué insumo faltó — nunca 🟢 OK, y no se emiten findings de las otras reglas. Fix: corregir `story_path`, arreglar el frontmatter, o pasar el diff real |
| **SPEC-C7** | Hook, store action o servicio nuevo sin mención en el spec: símbolo exportado NO-componente agregado por el diff (`export (async )?function use[A-Z]…` / `export const use[A-Z]… =`, acción nueva de un store Zustand, `public (class\|interface) *Service`, método `public` nuevo de un `*Service`/`*Orchestrator`) sin match en el body de la story. Es el pecado de `SPEC-C2` en los archivos donde `C2` no mira (`.ts` camelCase en archivo existente). Ejemplo: un hook `useColaDeArmadoSync` nuevo sin AC. **Desempate**: componente PascalCase en `.tsx` → `SPEC-C2`; cualquier otro caso → `SPEC-C7`, nunca los dos | Agregar el hook/acción/servicio al AC que lo justifica + a `### Archivos a crear/modificar` ANTES de implementarlo. Excluir: `__tests__/`, `*.test.ts(x)`, `*Tests.cs`, helpers privados/no exportados, renombres cuyo nombre viejo sí está en el spec |
| **SPEC-C8** | Contrato de ENTRADA nuevo o cambiado sin AC: campo **obligatorio** (no nullable, sin default) en el input de un endpoint YA documentado (`record *Request/*Command/*Input`, `[FromQuery]`/`[FromHeader]`/`[FromBody]`, parámetro nuevo en la lambda del `Map*`, `interface *Request/*Payload/*Input`, objeto literal de `api.post/put/patch`) que el AC no menciona. `SPEC-C3` cubre sólo la SALIDA; un contrato tiene dos mitades y la de entrada es la que **rompe al cliente** (agregar campo a la respuesta es aditivo, exigir un campo nuevo es breaking) | Actualizar el AC del endpoint con el contrato de entrada completo (campos + obligatoriedad) ANTES de codear el consumidor. Excluir: campos opcionales/nullable/con default, y campos de infraestructura convencionales del repo (`tenantId` de `BizuitUserContext`, `CancellationToken`) |
| **SPEC-C9** | Filtro, scoping o regla de negocio agregada a una consulta sin AC: predicado **agregado por el diff** (`SafeQueryBuilder`, `.Where(`, `WHERE` en SQL string, `db.select(...).where(`, `.filter(`) sobre un campo de visibilidad (`TenantId`, `UserId`, `Estado`, `Activo`, `DeletedAt`, `IsDeleted`…) cuyo resultado llega a una respuesta HTTP o a la UI, sin AC que lo declare — el usuario ve otros datos sin que nadie lo haya aprobado. Ejemplo: un security fix `WHERE TenantId` en un listado, sin AC | Agregar al AC la regla de visibilidad ("el listado excluye X", "el listado se acota al inquilino del usuario") ANTES de mergear. Si es un fix de seguridad urgente, entra igual pero con entrada en `## Change Log` el mismo día. Excluir: predicados sobre la PK del propio lookup (`Id == id`), filtros en tests, predicados preexistentes sólo reordenados |

### WARNING — no bloquea, reportar

| ID | Nombre | Fix típico |
|---|---|---|
| **SPEC-W1** | Comentario en código tipo `// TODO update spec`, `// spec-later`, `// post-spec`, `// FIXME: spec drift`, `// HACK: not in spec`, `// XXX: spec missing` | Actualizar el spec con la decisión declarada + remover el TODO antes de marcar `review`. Es drift declarado honesto pero requiere acción |
| **SPEC-W2** | Spec menciona entidad (`XxxModal`, `useXxxStore`, `GET /...`) que NO existe en código (gap inverso al scope creep) | Implementar la entidad, O remover la referencia del spec, O agregarla a `tasks_pending` de algún pipeline. Excluir: entidades en `tasks_pending`/`acs_pending` (deferral documentado) o en `### Lo que NO hay que hacer` (anti-pattern citado) |
| **SPEC-W3** | Endpoint declara response con discriminated union (`status: 'A' \| 'B' \| 'C'`) Y spec enumera comportamientos distintos por status value en ACs distintos Y componente consumer NO inspecciona el field discriminator (`response.status === '<value>'` / `switch`) — UX declarado en spec queda dead-code. **Ejemplo**: un drawer que invoca `/reprint` pero ignora `response.status` pierde el PDF in-memory cuando la impresora no responde. | Agregar branching sobre `response.status` con UI distinta por value (per AC referenciado). ALTERNATIVA: documentar en el AC que el componente ignora intencionalmente los demás statuses + referencia cruzada a quien sí los maneja |
| **SPEC-W4** | Drift defensivo documentado — degradación de `SPEC-C4`. Un hallazgo que califica como `SPEC-C4` cuando se cumplen **ambas** condiciones: comentario en el código (misma línea o hasta 3 arriba) que matchee `// decisión defensiva` / `// más estricto que el spec` / `// spec drift:`, **Y** entrada correspondiente en `## Change Log` de la story. Con una sola de las dos sigue siendo `SPEC-C4`. **ID propio desde 2026-08-21**: antes esta degradación se reportaba como `SPEC-W2`, que es una regla distinta (gap inverso) — la colisión hacía que un `W2` significara dos cosas incompatibles y que el conteo de uso fuera falso | Ninguno automático — es un ítem de revisión humana. Si la razón no convence, se convierte en un cambio de spec |
| **SPEC-W5** | El spec se editó junto con el código, sin `## Change Log`: el `.md` de la story está entre los `modified_files` del mismo diff que trae el código, el diff toca líneas dentro de `## Acceptance Criteria`, y no hay entrada nueva en `## Change Log`. Es la huella barata de "acomodar el AC al código ya escrito" — el resultado se ve idéntico a spec-first bien hecho y es lo contrario. WARNING porque la señal es indirecta (el advisor no tiene git y no puede probar el orden) | Agregar la entrada al `## Change Log` diciendo qué AC cambió y por qué. Si el cambio nació del código, decirlo — es información, no una falta. Excluir: cambios sólo en `### Dev Notes`/`### Tests`/`## Dev Agent Record`/frontmatter, y stories creadas en el mismo diff |
| **SPEC-W6** | Exención aplicada sin marcador ni razón: marcador de exención mal formado (sin rule ID, sin razón, o con razón genérica — `"no aplica"`, `"ok"`, `"ver arriba"`). El marcador válido es `// @spec-first-exempt(SPEC-CN): <razón>` en el código o `spec_first_exempt:` en el frontmatter de la story (convención copiada de `// @realness-exempt` de `tycon-e2e-realness-checker`). Existe porque el advisor prometía un "override con razón documentada" sin decir **dónde** se registra: sin marcador, cualquier hallazgo se descartaba sin rastro y Claude y Codex podían decidir distinto pasando ambos el banco | Escribir la razón real en el marcador, o dejar que el hallazgo salga. Con marcador válido el finding original se suprime y queda `SPEC-W6` informativo; con marcador mal formado sale `SPEC-W6` **y** el hallazgo original. Sin marcador, un hallazgo NO se puede descartar |
| **SPEC-W7** | Campos extra en payload/evento no declarados en el AC: el código emite un evento/payload cuya lista de campos excede la enumerada literalmente en el AC (ej.: audit event con `tenantId`/`sessionId` de más), **sin** condición compuesta involucrada (si la hay, es `SPEC-C4`). **Escindida de `SPEC-C4` el 2026-08-21**: es la mitad de juicio de aquella regla, cuyo propio texto de fix admitía que la respuesta correcta puede ser "OK" — un CRITICAL así no es una severidad, es una pregunta | Si los campos son intencionales, actualizar el AC; si son detalle interno, documentarlo en `### Dev Notes` |

> **Nota de numeración (2026-08-21)**: la propuesta original incluía un `SPEC-W7` para "dependencia o setting nuevo sin mención en el spec". Se descartó (ya lo cubren otros controles) y los WARNING restantes se renumeraron para no dejar hueco — la regla de campos extra, propuesta como `SPEC-W8`, quedó publicada como `SPEC-W7`. **No existe `SPEC-W8`.**

| Regla | Qué | Estado |
|---|---|---|
| ~~SPEC-W8~~ | ~~número propuesto y nunca publicado~~ | **RETIRADO 2026-08-21 — el número se quemó al renumerar: la regla quedó como `SPEC-W7`. Se registra acá para que un revisor que lo nombre en una nota de historia no cuente como huérfano.** |

Anti-patterns (lo que NO hace este advisor):

- NO valida tests (eso es `tycon-plugin-tests-coverage` + `tycon-ac-coverage-checker`).
- NO valida wiring mount/callsite (eso es `tycon-feature-wiring-checker`).
- NO valida convenciones de código (eso es `tycon-plugin-{dotnet|react}-conventions`).
- NO bloquea WARNINGs (`SPEC-W1..W7` son advisory).
- NO reescribe el spec — solo reporta gaps. El dev/agent humano actualiza la story.
- NO entiende semántica profunda — heurística grep + parsing simple. Falsos positivos posibles (sinónimos, renombres internos sin cambio de contrato público). El único override es el marcador de `SPEC-W6`; no hay otro.
- NO detecta el mount de un componente que YA existía (`SPEC-C2` exige archivo NEW) — eso es `tycon-feature-wiring-checker`.
- NO prueba el ORDEN real spec→código (no tiene acceso a git): `SPEC-W5` detecta sólo su huella, y por eso es WARNING.
- NO mira dependencias nuevas ni settings de despliegue — fuera de alcance (ya lo cubren otros controles).

---

## Silent Failure Hunter — `tycon-silent-failure-hunter`

Advisor condicional. Caza fallos silenciosos en código TYCON: catch vacíos, return null sin log, generic rethrow que pierde stack, `async void` en backend, fire-and-forget en paths críticos, `.catch(() => default)` en TS, log-and-forget, HttpClient sin EnsureSuccess, transactions sin rollback, JSON.parse sin try, SignalR handlers que tragan throws. Stack-aware: distingue Polly retry, OperationCanceledException en BackgroundService, event handlers WinForms/WPF legítimos, y `Assert.Throws<X>()` en tests. Inspirado en ECC silent-failure-hunter, adaptado al stack TYCON 2026-05-23.

**Trigger**: diff toca `.cs`/`.ts`/`.tsx` con keywords `try`/`catch`/`async`/`await`/`Task.Run`/`.catch(`/`EnsureSuccess`/`BackgroundService`/`JSON.parse`/`throw new`.

### CRITICAL

| ID | Nombre | Fix típico |
|---|---|---|
| **SILENT-C1** | Catch block vacío (`catch (Exception) { }`, `catch { }`, `catch (e) { }` con `e` no usado) | Log con context + decidir si propagar (rethrow) o retornar default DOCUMENTADO en contrato |
| **SILENT-C2** | Catch que retorna default sin log ni razón documentada (`return null`, `return new List<T>()`, `return []`, `return undefined`) | Log con context + retornar default SOLO si el contrato lo permite + comentario explicando intent |
| **SILENT-C3** | Generic rethrow que pierde stack trace (`throw new Exception("...")` sin passar inner exception) | C#: `throw new InvalidOperationException("msg", ex);` o `throw;` (re-throw preservando stack). TS: `throw new Error("msg", { cause: e });` |
| **SILENT-C4** | `async void` en código NO-event-handler (plugin/service/hub/worker .NET) | Cambiar return type a `async Task`. Si REALMENTE fire-and-forget: `Task.Run(async () => { try { ... } catch (Exception ex) { _logger.LogError(ex, "..."); } })` |
| **SILENT-C5** | Fire-and-forget en path transaccional/crítico (`_ = SomeAsync()`, `Task.Run(() => ...)` sin await, `someAsyncFn()` sin await en TS) | await + manejar exception. Si fire-and-forget es necesario por performance: wrapper con try/catch + log + métrica counter |

### WARNING

| ID | Nombre | Fix típico |
|---|---|---|
| **SILENT-W1** | `.catch(() => default)` en TS/JS sin log (`.catch(() => [])`, `.catch(() => null)`) | `.catch(err => { logger.error('X failed', { context, err }); return []; })` o propagar |
| **SILENT-W2** | Log-and-forget (`catch (ex) { _logger.LogError(ex, "..."); return null; }`) | Documentar el contrato del método en XML doc / JSDoc + agregar métrica/alarma. O propagar con `throw;` |
| **SILENT-W3** | HttpClient `GetAsync`/`PostAsync` sin `EnsureSuccessStatusCode` ni check manual de `IsSuccessStatusCode` | `resp.EnsureSuccessStatusCode();` antes de leer Content, o branch explícito sobre IsSuccessStatusCode |
| **SILENT-W4** | Transaction (`BeginTransaction()` + `tx.Commit()`) sin rollback en catch | `catch (Exception) { tx.Rollback(); throw; }` o usar `TransactionScope` |
| **SILENT-W5** | `JSON.parse(x)` sin try/catch (especialmente sobre input de localStorage, fetch, postMessage, postman) | `try { JSON.parse(x) } catch (e) { logger.warn('bad JSON', { preview: x.slice(0,200), e }); return defaultValue; }` o usar schema validator (zod) |
| **SILENT-W6** | SignalR client `.on()` async handler sin try/catch (TS `connection.on(...)` o C# `hub.On<T>(...)`) — throws en handler se pierden silencio | Wrappear handler con try/catch + log + métrica counter de handler fails con label del evento |
| **SILENT-W7** | El fallo de una OPERACIÓN se colapsa en un `bool`/`null` que el controller traduce a UNA sola respuesta al usuario, cuando el método distingue internamente ≥2 causas con nombre propio (logs, excepciones o mensajes distintos por rama). El código sabía por qué falló y tiró el dato: el usuario lee «not found» ante un conflicto de concurrencia y la hipótesis correcta se descarta de un vistazo. Las TRES condiciones juntas — consumidor HTTP + una sola respuesta + ≥2 causas —, y los predicados (`Is*`/`Has*`/`Can*`/`Try*` con `out`) quedan fuera por nombre y por forma: medido sobre 6.939 `.cs` de 12 repos, sin la tercera hay 353 candidatos, con las tres 13 (deuda declarada). Owner: `tycon-silent-failure-hunter`. | Resultado discriminado (`enum`/record: `Updated`/`NotFound`/`Conflict`) y el controller mapea cada causa a su código y su mensaje (409 ante conflicto real) |

### Anti-patterns como advisor (false positives a NO flagear)

- ❌ NO flagear `catch { /* expected */ }` con comentario justificando — el comentario ES la documentación.
- ❌ NO flagear `Assert.Throws<X>(...)` en tests xUnit o `expect(() => ...).toThrow()` en vitest.
- ❌ NO flagear `catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)` en BackgroundService — cancelación es flow normal.
- ❌ NO flagear Polly `Policy.Handle<X>().WaitAndRetryAsync(...)` — es resilience pattern legítimo, no silent failure.
- ❌ NO flagear event handlers `private async void Button_Click(...)` en WinForms/WPF. En backend TYCON (plugins, workers, hubs) sí flagear.
- ❌ NO inventar fixes sin saber el contrato del método. Si dudás del intent, flageá como "needs review" no como fix concreto.

---

## Auth Session Reviewer — `auth-session-reviewer`

Advisor condicional para Auth.js / NextAuth v5 en Next.js multi-tenant. Trigger: diff toca `src/app/api/auth/**`, `src/lib/auth/**`, `src/auth*.ts`, `src/middleware.ts`, o usa `getServerSession`/`auth()`/`signIn`/`signOut`.

### CRITICAL — vulns o sesión inválida

| ID | Nombre | Fix típico |
|---|---|---|
| **AUTH-C1** | `getServerSession()` o `auth()` sin `await` | Promise truthy hace `if (!session)` siempre false → bypass de check. Fix: `await getServerSession(authOptions)` o `await auth()` (v5) |
| **AUTH-C2** | Server Action lee `userId` del input request en vez de la sesión | Cualquier user crafted request spoofea identidad. Fix: extraer `userId` SOLO de `(await auth()).user.id`; ignorar `userId` del input |
| **AUTH-C3** | Redirect callback sin allowlist (open redirect) | Atacante crafta `?callbackUrl=https://evil.com`. Fix: `if (new URL(url).origin === baseUrl) return url; return baseUrl;` |
| **AUTH-C4** | EmailProvider con `maxAge` > 24h o sin definir | TTL largo = más ventana de ataque. Fix: `maxAge: 60 * 60 * 24` (24h) o menor (1h-4h) |
| **AUTH-C5** | Callbacks `jwt`/`session` no propagan `userId` al token/session | Sin userId en `session.user`, rompe TENANT-C1/C2 downstream. Fix: en `jwt` callback `token.sub = user.id`; en `session` callback `session.user.id = token.sub` |
| **AUTH-C6** | API key de provider de email hardcoded o con fallback hardcoded | Fix: env var validada con Zod en startup, fail-fast si missing |

### WARNING — hardening recomendado

| ID | Nombre | Fix típico |
|---|---|---|
| **AUTH-W1** | EmailProvider sin rate-limit | Atacante spammea inbox víctima. Fix: Upstash ratelimit con `5 emails/15min/IP` y `10/hora/email-target` |
| **AUTH-W2** | `useSession()` invocado en Server Component | Devuelve undefined (solo funciona en Client con SessionProvider). Fix: usar `await getServerSession()` (v4) o `await auth()` (v5) |
| **AUTH-W3** | Logout flow no llama `signOut()` callback | UI con "logout" que solo borra cookie del client. Sesión server-side queda válida. Fix: usar `signOut()` de `next-auth/react` o server-side |

---

## Drizzle Migration Reviewer — `drizzle-migration-reviewer`

Advisor condicional para migraciones Drizzle ORM (Next.js + Postgres). Trigger: diff toca `drizzle/*.sql`, `drizzle/meta/_journal.json`, o `src/db/schema.ts`.

### CRITICAL — breakage de schema, code o data

| ID | Nombre | Fix típico |
|---|---|---|
| **DRIZZLE-C1** | DROP COLUMN/TABLE referenciado en code | El `.sql` ejecuta `ALTER TABLE X DROP COLUMN Y` o `DROP TABLE X`, y la referencia sigue activa en `schema.ts`/repos. Fix: actualizar código primero (PR previo) o crear migración aditiva (rename a `<col>_deprecated`, borrar después) |
| **DRIZZLE-C2** | RENAME COLUMN/TABLE sin update de `schema.ts` y repos | Schema.ts es source-of-truth del ORM — desync corrompe queries. Fix: actualizar `schema.ts` + repos en el mismo PR |
| **DRIZZLE-C3** | ALTER COLUMN con cambio de tipo incompatible sin migración de data | Cast no seguro (text → integer sin validar) falla en runtime. Fix: UPDATE previo con cast seguro o crear staging column |
| **DRIZZLE-C4** | NOT NULL agregado sin DEFAULT ni backfill | Migración falla apenas hay 1 row con NULL. Fix: 3-step migration (add column nullable → backfill UPDATE → set NOT NULL) en migraciones separadas |
| **DRIZZLE-C5** | Schema drift entre `schema.ts` y migrations | `schema.ts` declara columna/tabla que no existe en migraciones (o viceversa). Fix: `pnpm db:generate` y commitear el `.sql` resultante |

### WARNING — gaps operativos

| ID | Nombre | Fix típico |
|---|---|---|
| **DRIZZLE-W1** | Falta idempotencia (`CREATE TABLE X` sin `IF NOT EXISTS`) | Reaplicar la migración en otro entorno falla. Fix: usar `IF NOT EXISTS` / `IF EXISTS` |
| **DRIZZLE-W2** | FK con `onDelete` no coordinado con repos | `cascade` borra rows que repos no esperan, o `set null` sobre NOT NULL rompe constraint. Fix: revisar semántica del cascade vs repos |
| **DRIZZLE-W3** | Índice ausente en columna con uso frecuente en queries | Performance OK con <10k rows, degrada en SaaS multi-tenant. Fix: agregar `index('idx_table_col').on(table.col)` o composite index |
| **DRIZZLE-W4** | `_journal.json` no actualizado tras nuevo `.sql` | Drizzle CLI a veces se olvida regenerar. Fix: correr `pnpm db:generate` y verificar journal incluye la migración |

---

## LLM Cost Reviewer — `llm-cost-reviewer`

Advisor condicional para uso de SDKs de Anthropic/Voyage/OpenAI. Trigger: diff importa `@anthropic-ai/sdk`/`voyageai`/`openai`/`@openrouter/sdk`/`cohere-ai`, o toca `src/lib/llm/**`, `src/lib/embeddings/**`, `src/matcher/**`.

### CRITICAL — cost runaway o falla sin recuperación

| ID | Nombre | Fix típico |
|---|---|---|
| **LLMCOST-C1** | `messages.create()` sin `max_tokens` razonable | Sin max_tokens o con 8192 cuando output esperado es <500, gastás de más si el modelo divaga. Fix: max_tokens ajustado al output (rerank: 200-500; analysis: 1000-2000) |
| **LLMCOST-C2** | Llamadas LLM en loop sin cap explícito | `for/map(async)` sobre N items sin batch ni `p-limit`. 1000 items = 1000 calls. Fix: batch (N items por prompt) o `pLimit(10)` |
| **LLMCOST-C3** | Falta cache cross-tenant en operación determinista | Query "gaseosa cola sin azúcar 2.25L" repetida por 50 users = pagás 50 veces. Fix: cache key `(query_normalized, super, region_id)` con TTL 7-30d |
| **LLMCOST-C4** | Llamada LLM sin `timeout`/`signal` | Anthropic puede colgar — sin timeout, request queda pendiente y agota connection pool. Fix: `signal: AbortSignal.timeout(30_000)` (30-60s messages, 10s embeddings) |
| **LLMCOST-C5** | Falta rate-limit per-user en endpoint que invoca LLM | Un user (intencional o accidental) vacía la cuota mensual. Fix: `ratelimit.limit(userId)` con cap (10-50 LLM calls/hora/user) |
| **LLMCOST-C6** | API key (Anthropic/Voyage/OpenAI) hardcoded o leída de archivo | Debe venir de `process.env`. Fix: `process.env.ANTHROPIC_API_KEY` con validación Zod en `src/config/env.ts`. Si commiteado, rotar la key |

### WARNING — optimizaciones que perdés

| ID | Nombre | Fix típico |
|---|---|---|
| **LLMCOST-W1** | Prompt caching no activado en system prompts > 1024 tokens | Anthropic descuenta 90% en tokens cacheados. Fix: agregar `cache_control: { type: 'ephemeral' }` al system prompt + few-shot constantes |
| **LLMCOST-W2** | Embeddings sin batch | `embed([text])` × N en vez de `embed(texts, { batch_size: 128 })`. Fix: batch hasta cap del provider (Voyage: 128, OpenAI ada: 2048) |
| **LLMCOST-W3** | Modelo más caro del necesario | Sonnet para rerank simple cuando Haiku alcanza (5x más caro). Fix: `claude-haiku-4-5-20251001` para rerank/extracción/clasificación; Sonnet solo para razonamiento complejo |
| **LLMCOST-W4** | Falta fallback ante 529 (overloaded) | Sin retry+fallback, el feature falla cuando Anthropic se satura. Fix: retry exponencial (3 intentos) + fallback a Haiku si la primera era Sonnet. Confirmar `maxRetries: 3` en SDK |

---

## Multi-Tenant Isolation Reviewer — `multi-tenant-isolation-reviewer`

Advisor condicional para queries Drizzle, Server Actions y Route Handlers contra fugas cross-tenant (Next.js + Postgres + Auth.js). Trigger: diff toca `src/db/repos/**`, `src/app/api/**`, `**/actions.ts`, `src/lib/cache/**`, o queries sobre tablas con `user_id`.

### CRITICAL — leak cross-tenant directo (todas bloqueantes salvo `// @tenant-override`)

| ID | Nombre | Fix típico |
|---|---|---|
| **TENANT-C1** | Query a tabla con `user_id` sin filtro `userId` en `where` | `db.select().where(eq(lists.id, listId))` sin `and(eq(lists.userId, userId))`. Fix: agregar el filtro de userId derivado de sesión a TODA query sobre tabla con user_id |
| **TENANT-C2** | Server Action acepta ID del client sin validar ownership | User A modifica lista de user B con request crafteado. Fix: query `WHERE id = ? AND user_id = sessionUserId` antes de cualquier mutación |
| **TENANT-C3** | INSERT setea `user_id` desde input request en vez de sesión | Spoofing trivial. Fix: `userId: session.user.id` siempre, ignorar cualquier `userId` del input |
| **TENANT-C4** | Repo con `userId` opcional default null/undefined | Olvidar pasarlo bypassa el filtro. Fix: `userId` siempre required. Caso admin justificado → método separado `findByIdAsAdmin` con check de rol explícito |
| **TENANT-C5** | Route Handler `/api/**/[id]/route.ts` no valida ownership | Vector IDOR — user A lee lista de user B sabiendo el UUID. Fix: validar ownership o devolver 404 (no 403, no leakear existencia) |
| **TENANT-C6** | Cache key sin `userId` (o `regionId` cuando aplica) | Cache shared → user A puede leer resultados de user B. Excepción documentada con `// @tenant-shared: cross-tenant cache by design` cuando incluye region_id |
| **TENANT-C7** | Subquery o JOIN olvida propagar `user_id` | Si una sola tabla filtra, el JOIN trae rows de otros tenants. Fix: filtrar `userId` en CADA tabla del JOIN |

### WARNING — gaps de defense-in-depth

| ID | Nombre | Fix típico |
|---|---|---|
| **TENANT-W1** | Logs estructurados sin `userId`/`listId` | Debugging post-incident requiere correlación. Fix: incluir `userId` en TODO log de operaciones DB |
| **TENANT-W2** | Tests integration sin caso de aislamiento | Única red contra regresión humana. Fix: `it('does not return rows from other users')` en cada repo con user_id |
| **TENANT-W3** | Migración agrega tabla con FK a `users` pero sin `user_id` directo | Joins constantes + complejidad de queries. Fix: considerar columna user_id denormalizada con FK además |

---

## Next.js App Router Security — `nextjs-app-router-security`

Advisor condicional para Server Actions, Route Handlers, middleware y componentes Next.js App Router. Trigger: diff toca `src/app/**`, `src/middleware.ts`, o componentes con directiva `'use server'`/`'use client'`.

### CRITICAL — vulnerabilidades reales

| ID | Nombre | Fix típico |
|---|---|---|
| **NEXTSEC-C1** | Server Action sin validación de input con Zod | RCE/CSRF vector si input crafted bypassa tipos. Fix: `const schema = z.object({...}); schema.parse(input)` al inicio |
| **NEXTSEC-C2** | Server Action sin auth check | Cualquier visitante puede invocarla con `fetch` directo. Fix: primera línea `const session = await getServerSession(); if (!session) throw new Error('unauthorized')`. Excepción `// @public-action: <razón>` |
| **NEXTSEC-C3** | `process.env.X` referenciado dentro de Client Component | Si Next la inyecta accidentalmente (rebrand a NEXT_PUBLIC_), expone secrets al bundle público. Fix: env secrets solo en Server Components/Actions; NEXT_PUBLIC_ solo para data no-sensible |
| **NEXTSEC-C4** | Open redirect en signIn/signOut/redirect callbacks | Atacante manda `?callbackUrl=https://evil.com`. Fix: verificar `url.origin === request.nextUrl.origin` o whitelist explícita |
| **NEXTSEC-C5** | Route Handler sin validación de ownership (IDOR) | Overlap intencional con TENANT-C5 — defensa por capas. Fix: query `WHERE id = ? AND user_id = sessionUserId` o devolver 404 |
| **NEXTSEC-C6** | `dangerouslySetInnerHTML` sin DOMPurify | XSS directo si userContent viene de input/DB/API. Fix: `DOMPurify.sanitize(userContent, { ALLOWED_TAGS: [...] })` antes de renderizar |
| **NEXTSEC-C7** | API key de provider externo hardcoded en código | Lectura de `git log` filtra el secret. Fix: mover a `.env.local`. Si ya commiteó, rotar la key |
| **NEXTSEC-C8** | `headers()` o `cookies()` leídos en componente sin marca dynamic | Render build-time fija valor de un user, sirve a todos. Fix: `export const dynamic = 'force-dynamic'` o mover el read a layout/page dynamic |

### WARNING — gaps de defense-in-depth

| ID | Nombre | Fix típico |
|---|---|---|
| **NEXTSEC-W1** | Search params usados sin sanitizar para construir URLs/SQL | Drizzle escapa pero composición URL no. Fix: validar formato + `encodeURIComponent` |
| **NEXTSEC-W2** | Falta rate-limit en route handler público | Vector DoS. Fix: Upstash `@upstash/ratelimit` (10-30 req/min/IP) |
| **NEXTSEC-W3** | Middleware no fuerza redirect HTTPS en prod | Vercel lo hace; custom domain con CDN propia, validar. Fix: `if (NODE_ENV==='production' && proto !== 'https') redirect` |
| **NEXTSEC-W4** | `revalidatePath('/')` sin scope en Server Action user-specific | Invalida cache global + posible leak temporal data stale. Fix: `revalidateTag(\`user-${userId}-lists\`)` con tags específicos |
| **NEXTSEC-W5** | Hydration mismatch por data dinámica en Server Component (`Date.now()`, `Math.random()`, `cookies()` sin prop) | Causa warning + flicker. Fix: pasar valor estable como prop o usar useEffect en Client |

---

## E2E Realness Checker — `tycon-e2e-realness-checker`

Advisor condicional stack-agnostic. Audita specs Playwright contra E2E "verdes" que no ejercen el flujo real. Trigger: diff toca `**/tests/e2e/*.spec.ts`.

**Opt-out (endurecido 2026-08-21)**: `// @realness-exempt(REAL-CN): <razón concreta>` — **con el rule ID que exime**. Un marcador válido suprime ESE finding puntual, nunca el archivo entero, y **la exención queda registrada en el reporte** (`REAL-W3`). El marcador viejo sin rule ID ya no suprime nada. Alcances válidos: `test()` (preferido), `describe()`, header del archivo (sólo con un `test()` o razón que declare el alcance completo).

**Definición canónica de "assert visual"** (vale para `C1`/`C3`/`C6`/`W7`): matchers `toBeVisible|toBeHidden|toContainText|toHaveText|toHaveValue|toBeChecked|toBeEnabled|toBeDisabled` sobre un **locator**, descontando los smoke asserts (`body`/`html`/`head`/`*`). `toHaveClass`/`toHaveAttribute` NO cuentan; `toHaveURL`/`toHaveTitle` se cuentan aparte.

**IDs reservados, no publicados**: `~~REAL-C5~~` (el agujero "goto y nada más" quedó dentro de `REAL-C1` ampliada) · `~~REAL-W5~~` (spec contra host/puerto fijo — descartada, ya la cubre `DODRT-W3`). No se reutilizan.

### CRITICAL — bloquea commit prep y status→done

| ID | Nombre | Fix típico |
|---|---|---|
| **REAL-C4** | Veredicto emitido sin haber podido leer los specs (auto-chequeo, corre SIEMPRE y PRIMERO) | No llegó ningún spec (`changed_specs` vacío sin `flag_all`), un path no resuelve/no se lee, el archivo no tiene ningún `test(`/`it(` parseable, o `flag_all: true` con `Glob` vacío. Veredicto obligatorio **INCONCLUSO**, nunca GREEN, nombrando qué insumo faltó. Fix: pasar la lista real de specs del diff, corregir el path, o correr con `flag_all` sobre un repo con `tests/e2e/`. Análogo de `SCOPE-C5` / `SPEC-C6` |
| **REAL-C1** | Spec que no ejerce la feature — 0 interacciones UI **y** 0 asserts visuales de feature (**alcance AMPLIADO 2026-08-21**) | Antes exigía además `api_requests > 0 \|\| page_goto == 0`; esa cláusula dejaba escapar el caso más puro (spec con `page.goto` y nada más). Hoy la condición es sólo `ui_interactions == 0 && feature_visual_asserts == 0`: cubre el API-only stub, el goto decorativo y el spec cuyo único assert es sobre `body`. Los asserts de URL no la satisfacen. Fix: interacción UI real + `expect(<locator>).toBeVisible()`, mover a `tests/api/`, o marcador de exención válido |
| **REAL-C2** | Backend de negocio con respuesta FABRICADA — `page.route(…, route.fulfill(…))` en el `test()` (**alcance ACOTADO 2026-08-21**) | Antes el algoritmo contaba **cualquier** `page.route(` sobre un patrón de negocio (un espía `route.continue()` disparaba CRITICAL); ahora es sólo `fulfill`, y toda otra intercepción migró a `REAL-C7`. Invalida runtime end-to-end: verifica que el frontend manda bien la request, no que el backend responda, ni middleware/auth/tenant scoping. Fix: sacar el `fulfill` y sembrar datos con un helper que postee al backend real |
| **REAL-C3** | Dev seam usado sin asserts visuales del DOM (**PROJECT-gated** desde 2026-08-21) | Sólo corre si el repo declara `.tycon/advisors.yaml → e2e_realness.dev_seam_pattern` (antes el patrón `window.__ceibo*Store` estaba hardcodeado: regla publicada y muerta por construcción fuera de un proyecto). Cuando no aplica **se declara en el reporte**, no desaparece. Además pasó a exigir asserts de **feature** (antes un `body.toBeVisible()` la salvaba). Fix: tras cada `page.evaluate` que abre un componente, `expect(getByTestId(…)).toBeVisible()` + assert de contenido |
| **REAL-C6** | Interactúa con la UI y no comprueba nada observable | `ui_interactions > 0 && feature_visual_asserts == 0 && url_asserts == 0`: hace los clicks reales y después comprueba estado interno (`page.evaluate`, `localStorage`, store) o nada. Si el botón deja de dibujar el resultado, el test sigue verde. El caso leve (sólo `toHaveURL`) tiene ID propio: `REAL-W7`. Fix: agregar al menos un assert sobre el DOM que el usuario vería |
| **REAL-C7** | Backend de negocio interceptado por una vía que no es `route.fulfill()` en el `test()` | `context.route(`/`browserContext.route(`, `page.routeFromHAR(`/`context.routeFromHAR(`, `fulfill` desde `beforeEach`/`beforeAll`, `route.abort()` o `route.continue({…})` **con overrides**, o `import` de `msw`/`@mswjs/`/`nock`/`fetch-mock`/`jest-fetch-mock` en `tests/e2e/`. Mismo pecado que `C2` escrito de otra forma — y `context.route()` es la forma que Playwright recomienda para mockear todo un archivo. Excepciones: assets, telemetría y refresh de auth, con comentario inline. Fix: el mismo de `REAL-C2` |
| **REAL-C8** | Spec que se auto-saltea cuando el entorno no responde (`skip-on-not-ok`) | `test.skip(!res.ok(), …)`, `if (!res.ok()) test.skip(…)`, `test.skip(!process.env.X, …)` o `return` temprano tras un probe fallido, **sin** el override fail-loud de `guides/definition-of-done.md` §2 (env var `<DOMAIN>_REQUIRED=1` que **lanza** en vez de saltear). Un backend roto produce una corrida "verde" — estaba prohibido en prosa en esa guía y sin ningún rule ID que lo enforceara. El `test.skip()` **incondicional** NO cae acá: es `DEFTR-C2`. Fix: implementar el override fail-loud y setearlo en el CI dedicado |

### WARNING — no bloquea pero requiere acción documentada

| ID | Nombre | Fix típico |
|---|---|---|
| **REAL-W1** | Spec menciona AC user-visible en describe/test name sin `page.goto` | **Alcance fijado 2026-08-21**: se busca sólo en el **nombre** de `describe()`/`test()`, nunca en el cuerpo (el regex viejo miraba tres lugares distintos según dónde se lo leyera). Lista canónica stack-agnostic; la enumeración de roles de un cliente se retiró y se generalizó a `ve el`/`ve la`. Ampliable por repo con `e2e_realness.user_visible_keywords`. Fix: agregar `page.goto` o marcador de exención con razón |
| **REAL-W2** | Timing-based asserts (`page.waitForTimeout(>=500)` ≥ 3 veces) | Race conditions + slow CI. Fix: reemplazar por `await expect(...).toBeVisible({ timeout })` o `page.waitForResponse(...)` |
| **REAL-W3** | Exención registrada, o marcador de exención inválido | **Dos caras, las dos se reportan.** (a) marcador bien formado → suprime ESE finding y queda listado con archivo, alcance y razón; (b) marcador inválido → **finding, y el hallazgo original sale igual**: sin rule ID, razón vacía o genérica (`TODO`, `n/a`, `ok`, `temporal`, `por ahora`, `ver arriba`), alcance mayor al que la razón justifica, o exención muerta (la regla eximida no habría disparado — huella de copy-paste). Antes de esta regla, un comentario en la línea 1 apagaba todas las reglas del archivo **sin dejar rastro en el reporte**. Sin marcador válido, un hallazgo no se puede descartar. Fix: escribir el marcador completo en el bloque que corresponde, o dejar que el hallazgo salga |
| **REAL-W4** | La exención delega la cobertura visual en un spec que no existe | Marcador cuya razón nombra otro archivo/test (`covered in <path>`, `cubierto por <path>`, `E2E-<n>`) y ese destino no existe, es él mismo API-only, o no contiene el test citado; también si afirma cobertura "en otro lado" sin nombrar dónde. Es una promesa de cobertura auto-emitida — el falso verde, movido del spec al comentario. Fix: apuntar al spec real, o sacar la exención y escribir el assert acá |
| **REAL-W6** | E2E declarado en `pipelines.X.tests_done` que no aparece entre los specs auditados | Requiere `story_path`. Por cada E2E declarado: no se encuentra bajo `tests/e2e/`, o se encuentra pero no está en el diff que la story declara como entrega de esta tanda. Era una instrucción en el prompt del orquestador, sin ID y por lo tanto no asertable. **Owner: `tycon-e2e-realness-checker`** (el spec no está, en Step 5 sobre el diff) · **Co-enforced: `tycon-dod-runtime-checker`** vía `DODRT-C4` (el spec está y falla realness, en el gate de `done`) — es la misma familia con dos puntos de aplicación, el ID no se duplica. Fix: entregar el spec, o sacarlo de `tests_done` y declarar la cobertura por otro medio |
| **REAL-W7** | Navegación asertada sólo por la URL | `ui_interactions > 0 && feature_visual_asserts == 0 && url_asserts > 0`. Un cambio de ruta es observable, pero no prueba que la pantalla renderizó. Nace de **partir `REAL-C6`**: la degradación interna habría dejado un ID con dos severidades, imposible de assertar en el banco. Fix: agregar un assert sobre un elemento de la pantalla destino además del `toHaveURL` |

### ⚙️ Config del repo que GATEA o AFLOJA estas reglas — `.tycon/advisors.yaml → e2e_realness`

> Documentado acá el **2026-08-25**. Hasta esa fecha estas tres llaves cambiaban el
> comportamiento de reglas CRITICAL y **`business_endpoint_excludes` no figuraba en ningún
> lado** — ni en este catálogo ni en las guías: sólo en el `.md` del advisor. Una llave que
> afloja dos reglas críticas y no está publicada es indistinguible de una puerta trasera:
> quien la usa no deja rastro auditable, y quien audita no sabe que existe.
> Auditoría: `guides/decisions/controles-apagables-por-config-2026-08-25.md` §C6.

| Llave | Qué le hace a las reglas | Dirección |
|---|---|---|
| `dev_seam_pattern` | **GATE de `REAL-C3`.** Sin la llave, `REAL-C3` **no corre** (se declara no aplicable en el reporte, no desaparece en silencio) | Ausente = regla apagada |
| `business_endpoint_excludes` | **AFLOJA `REAL-C2` y `REAL-C7`.** Suma patrones a la lista canónica de exclusiones: una intercepción de un endpoint excluido deja de ser CRITICAL. El repo **puede sumar exclusiones, nunca quitarlas** — y una exclusión sigue necesitando su comentario inline con el motivo (sin él es `REAL-W3`, no verde) | Cada entrada **reduce** cobertura |
| `user_visible_keywords` | **ENDURECE `REAL-W1`.** Suma vocabulario del dominio a la lista canónica | Cada entrada **aumenta** cobertura |

**Lo que hay que mirar en un diff que toca este bloque**: que `business_endpoint_excludes`
**crezca** es el cambio que apaga cobertura, y hoy nada lo ejerce automáticamente — editar
`.tycon/advisors.yaml` no selecciona ningún revisor (es el hueco C6 de la auditoría; un
`lint-config` es lo que vendría a cerrarlo). Hasta que exista, es revisión humana.

### 🕳 Gotcha conocido, SIN rule ID: el assert que pasa por estado que dejó OTRO test

**No tiene ID a propósito**: no es detectable leyendo el spec aislado, que es lo único que ve un
advisor. Se documenta acá porque el set `REAL-C*` cubre todas las otras formas de falso verde y
alguien va a buscar ésta en esta tabla.

**Ejemplo**: un spec —"la tarjeta abre el
calendario"— assertea que el panel de detalle **desaparece** al abrir el calendario. El
calendario en realidad es un MODAL que se dibuja SOBRE el panel, así que esa aserción es falsa. Y
pasa igual: encadenado con los specs anteriores queda una gestión heredada abierta que hace
desaparecer el panel por OTRA razón. Corrido en aislamiento, falla.

**Por qué es su propia clase.** Los `REAL-C*` atacan specs que no ejercen la feature (`C1`), backend
fabricado (`C2`/`C7`), dev-seam sin asserts (`C3`), interacción sin observable (`C6`/`W7`) y
auto-skip sobre entorno roto (`C8`). Acá el spec **hace todo bien**: interactúa de verdad, assertea
algo visible, no mockea nada. Lo que está mal es la RAZÓN por la que pasa — y esa razón no está en
el archivo, está en el test de antes. Ningún análisis estático lo ve.

**Dónde sí se puede ver.** El gate de merge corre la suite **encadenada**; el pipeline de advisors
mira spec por spec. La señal es el DIFF entre los dos modos: un spec que pasa encadenado y falla
aislado está apoyado en estado ajeno. Es más caro que un advisor (hay que correr dos veces) y por
eso queda como propuesta, no como regla.

**Qué hacer mientras tanto.** Si un E2E toca estado compartido (una gestión, una conversación, una
sesión), que **siembre lo suyo y lo limpie**. Y ante un verde sospechoso, la pregunta barata es:
*¿pasa si lo corro solo?* — `npx playwright test <spec>` sin el resto de la suite.

---

## i18n Hardcoded Text Reviewer — `i18n-hardcoded-text-reviewer`

Advisor condicional **PROJECT-gated** (no por diff). Audita texto visible al usuario hardcodeado (sin pasar por i18n) en proyectos que lo declaran. **Activación**: el repo tiene `.tycon/advisors.yaml` con `i18n.required: true` **Y** el diff toca `.tsx/.ts/.jsx/.js/.cs`. Es el primer advisor gatillado por *capacidad declarada del proyecto* en vez de por el contenido del diff — generaliza "si el proyecto requiere i18n, que no se nos escape de nuevo". **Scope: solo lo NUEVO/modificado del diff, nunca el backlog histórico** (eso es trabajo de stories de sweep, no del gate). Lee `.tycon/advisors.yaml` para `hook`, `locales_glob`, `backend_required`, `audiences`, `shared_libs`. Opt-out por línea: `// @i18n-allow: <razón>`. Por qué: sin gate, los textos hardcodeados se acumulan (medido en una auditoría: 512). Creado 2026-06-01.

### CRITICAL — label visible primario nuevo hardcodeado

| ID | Nombre | Fix típico |
|---|---|---|
| **I18N-C1** | Label/título/botón/placeholder visible **nuevo** sin `t()` | Texto en JSX renderizado o prop de UI (`label`/`title`/`placeholder`/`heading`/`confirmLabel`/`subtitle`) agregado/modificado por el diff, que no pasa por el hook i18n. Fix: agregar la clave al catálogo (`locales_glob`) y usar `t('area.key')`. Excepción: `// @i18n-allow: <razón>` |
| **I18N-C2** | Mapa de labels visibles hardcodeado | Object literal código→nombre mostrado (`const STAGE_LABELS = { ARM: 'Armado' }`, `ETAPA_LABELS`, `ROL_LABELS`, `STATUS_LABELS`) introducido por el diff y renderizado en UI. Multiplica duplicación (el mismo mapa termina copiado en N archivos). Fix: centralizar en el catálogo + helper que devuelve la clave i18n (patrón `stageLabels.ts`) |

### WARNING — texto secundario / librería / backend

| ID | Nombre | Fix típico |
|---|---|---|
| **I18N-W1** | Toast/error/confirm/notificación **nuevo** sin `t()` | Mensaje user-facing (`toast.success('...')`, `showToast`, `alert`, `window.confirm`, error construido para mostrar, `addNotification`) agregado por el diff sin i18n. Fix: clave i18n + `t(...)` |
| **I18N-W2** | Texto de usuario en librería compartida agnóstica | String visible hardcodeado en un path de `shared_libs` (ej. `shared/ui`). La lib la consumen varias apps y no tiene i18n propio → impone idioma a todas. Fix: exponer como prop de label traducible con default en idioma actual (patrón labels-as-props); cada app la llena con su `t()` |
| **I18N-W3** | Mensaje user-facing de backend sin criterio de audiencia | Solo si `backend_required: true`. `message` de `Ceibo*Exception`/`ProblemDetails.Detail`/`Results.BadRequest("...")`/`.WithMessage("...")` **nuevo** sin pasar por el mecanismo i18n, o con idioma que no respeta `audiences` (operador en EN, o LIS en ES sin criterio). Fix: resolver vía el mecanismo del ADR backend + idioma según audiencia |
| **I18N-W4** | Clave i18n agregada a un solo locale (drift de catálogo) | El diff agrega una clave a un archivo de `locales_glob` pero no a los otros locales (cuando hay >1) → "Missing key" en runtime para el idioma faltante. Fix: agregar la clave a todos los locales. Inerte mientras haya 1 solo locale |
| **I18N-W5** | Texto en español NO neutro (voseo / argentinismos) | Solo si `spanish_variant: neutral`. Texto user-facing nuevo (JSX, prop UI, toast/error, valor `es.json`, `message` backend) con formas rioplatenses: voseo imperativo ("Ingresá", "Seleccioná", "Reintentá", "Marcá", "Cargá", "Describí", "Elegí"…), voseo pronominal/conjugación ("vos", "tenés", "podés", "querés", "hacés"…), léxico regional ("acá"→"aquí"). Fix: reescribir neutro (infinitivo "Ingresar"/"Seleccionar", o "usted"/impersonal "Ingrese", "aquí"). 🔴 Requiere criterio, NO grep: `Mercadería`/`Categoría`/`Recepción`/`está`/`código`/`región` terminan en acento y NO son voseo — no marcar |

---

## Safety Guard — `safety-guard-pre.sh`

Hook `PreToolUse` matcher `Bash|PowerShell` (la herramienta PowerShell de Claude Code en Windows, 2026-10-04; cada regla con su forma de PowerShell, mismo id). Bloqueo de comandos destructivos irreversibles. **No es un advisor** (no analiza diffs ni produce findings de review) — es un **hook en tiempo real** que aborta la ejecución con `exit 2` y mensaje a stderr. Las reglas se citan en el mensaje del bloqueo. Prendido por default; opt-out vía `TYCON_SAFETY_GUARD=0`. Override de emergencia: `TYCON_SAFETY_OFF=1 <cmd>`. Ver `guides/safety-guard.md` para detalle.

### CRITICAL — Filesystem

| ID | Nombre | Fix típico |
|---|---|---|
| **FS-C1** | `sudo rm ...` | Diagnosticar permission issue real; no usar sudo rm como workaround |
| **FS-C2** | `rm -rf /` o variantes con paths absolutos críticos | Especificar el path real (`/tmp/foo`, `~/Downloads/bar`) |
| **FS-C3** | `rm -rf ~` / `rm -rf $HOME` | Especificar subpath bajo $HOME (`~/.cache/foo`) |
| **FS-C4** | `rm -rf .` / `rm -rf ..` (cwd o parent wipe) | Especificar qué borrar (`rm -rf node_modules`, `rm -rf bin obj`) |
| **FS-C5** | `chmod -R 777` / `chmod 777 /` | Diagnosticar quién falla con permisos; dar solo lo necesario (`chmod u+x`) |

### CRITICAL — Git

| ID | Nombre | Fix típico |
|---|---|---|
| **GIT-C1** | `git push --force` / `-f` / `--force-with-lease` a `main`/`master`/`dev`/`release/*` | Para feature branch propia: `--force-with-lease` a esa branch específica. Para main: hablarlo en el equipo |
| **GIT-C2** | `--no-verify` en `git commit`/`push`/`merge`/`rebase` (también con opciones de git antes del subcomando), `git commit -n`, y `core.hooksPath` apuntado a otra carpeta para ese comando | Arreglar lo que el hook reporta. Si el hook está roto, fixearlo, no bypassearlo. Ver `git-commit-conventions.md` |
| **GIT-C3** | `git clean -fdx` (incluye gitignored) | Sin `-x`: `git clean -fd`. Para preview: `git clean -ndx` |

### CRITICAL — Supply chain

| ID | Nombre | Fix típico |
|---|---|---|
| **SUP-C1** | `curl ... \| bash` / `wget ... \| sh` / `... \| zsh` | Bajar primero (`curl -o /tmp/x.sh URL`), inspeccionar, luego `bash /tmp/x.sh` |
| **SUP-C2** | `eval $(curl ...)` / `eval $(wget ...)` | Idem SUP-C1 |

### CRITICAL — Publicación accidental

| ID | Nombre | Fix típico |
|---|---|---|
| **PUB-C1** | `npm publish` | Si era intencional: `TYCON_SAFETY_OFF=1 npm publish`. Verificar que el package no contenga secretos |
| **PUB-C2** | `yarn publish` | Idem PUB-C1 |
| **PUB-C3** | `dotnet nuget push` | Solo CI/release pipeline debería pushear NuGet. Si manual a propósito: override + verificar `.nupkg` |

### CRITICAL — SQL

| ID | Nombre | Fix típico |
|---|---|---|
| **SQL-C1** | `DROP DATABASE` | Si REALMENTE necesitás recrear (típicamente `*_DEV`): override + restaurar backup |
| **SQL-C2** | `DROP TABLE` inline (no en `.sql` migration) | Crear migration nueva con `tycon-new-migration`. Para exploratorio en `*_DEV`: override |

### CRITICAL — Secret reading

| ID | Nombre | Fix típico |
|---|---|---|
| **SEC-C1** *(safety-guard)* | `cat ~/.ssh/...` / `cat .../.aws/credentials` | Para verificar existencia: `ls -la ~/.ssh/`. Para contenido: wrapper que no exponga |
| **SEC-C2** *(safety-guard)* | `cat .env` / `cat .env.*` / `less .env` / `head .env` / `tail .env` | Para listar keys sin valores: `grep -E '^[A-Z_]+=' .env \| cut -d= -f1` |

> ⚠️ **Colisión de namespace**: `SEC-C1`/`SEC-C2` también existen en `tycon-plugin-security-basics` (advisor sobre código). Las del safety-guard están marcadas `*(safety-guard)*` y aplican al runtime del shell, no al diff. Mismo prefijo, distinto contexto.

### Limitations v1

- Cubre los matchers `Bash` y `PowerShell` (los comandos de shell). Una llamada `Read` a `~/.ssh/id_rsa` desde Claude Code **no se bloquea** en v1 (requiere matcher `Read|Edit|Write` — roadmap v2).
- Cubre solo macOS/Linux (bash script). Windows queda fuera en v1.
- No tiene Freeze/Guard modes — solo Careful (denylist).

---

## Banco de pruebas — `build/check-bank-coverage.js`

**No es un advisor**: es la etiqueta (`rule_id: BANCO`) que el orquestador del pipeline le pone a
un hallazgo cuando el defecto **está en la prueba, no en el código que la prueba juzga**. Nació el
2026-09-10.

🔴 **Qué enforcea de verdad `check-bank-coverage.js`, y qué NO.** Ese guion corre en el pre-commit
y sólo garantiza **BANCO-W3**: una pieza nueva entra con sus casos o no entra. Las otras siete
reglas de esta sección **ningún script las detecta**: a seis las encuentra el **rojo previo** —correr
el caso contra el código sin arreglar y exigir que se ponga rojo— y a la séptima (W4), un rojo **sin
regresión**; las dos cosas son disciplina del pipeline y de quien revisa, no un control automático. Se catalogan igual porque son la etiqueta que llevan
esos hallazgos cuando aparecen; decir que hay un control donde sólo hay disciplina sería
exactamente el `verde-que-significa-no-mire-nada` que esta familia persigue.

<!-- sin-verificacion: BANCO-C1 BANCO-C2 BANCO-C3 BANCO-C4 BANCO-C5 BANCO-W1 BANCO-W2 BANCO-W4 -->
<!-- ↑ La lee scripts/lib/rules-catalog.js: es el párrafo de arriba en una forma que
     una máquina puede leer. Si una de estas reglas pasa a tener un guion que la verifique, se saca de
     acá en el mismo commit. -->

🔴 **La familia entera es una sola idea: un control que NO PUEDE PONERSE ROJO.** Un caso que pasa
en verde midiendo otra cosa es peor que no tener caso — el caso ausente se nota, el caso mentiroso
tranquiliza. Por eso todo caso nuevo del arnés se verifica **por rojo previo**: si no se pone rojo
contra el código sin arreglar, no prueba nada, y eso es un hallazgo `BANCO`.

| ID | Nombre | Fix típico |
|---|---|---|
| **BANCO-C1** | El doble de un servicio externo **ignora un filtro** que el código real sí usa, así que el caso no puede reproducir el defecto | Honrar en el doble los parámetros de los que depende la decisión (ejemplo: `--status` de `az repos pr list`) |
| **BANCO-C2** | El banco **fija una variable** que el caso debería ejercitar, y borrar la guarda deja la suite verde | Dejar la variable sobreescribible por caso y agregar el que la ejercita (ejemplo: la guarda del literal `$(…)` de revisores) |
| **BANCO-C3** | El entorno del banco **tapa el mecanismo** que el caso quiere probar | Declarar en el sandbox lo que el entorno global eclipsa (ejemplo: `core.hooksPath` global ignora el `hooks/` de un repo bare) |
| **BANCO-C4** | Un chequeo cubre **la misma regla en varios lugares** y se verificó rompiendo UNO solo, así que los otros pueden romperse en verde | Un mutante por lugar, y adentro de la suite: el chequeo como función y un caso que la corre contra cada copia rota. Un «lo verifiqué quitándolo» a mano no alcanza (ejemplo: un chequeo se da por arreglado probando un solo paso; su caso hermano rompe el argumento en cada paso) |
| **BANCO-C5** | El caso **se derrama sobre el entorno real**: corre la pieza de verdad sin fabricarle su casa, y escribe en el registro, la config o el repo de la máquina. Peor que ensuciar: si ese registro alimenta una métrica publicada, la suite **fabrica el numerador** de un número que el equipo lee como medido | Casa falsa (`HOME=`), raíz de sistema falsa y dobles para todo lo que escriba; y un caso hermano que mire el archivo REAL antes y después y falle si creció (medido: un caso dejaba 10 bloqueos inventados por corrida en el registro del freno de producción, que el reductor cuenta para el tablero) |
| **BANCO-W1** | El **mensaje de fallo** del caso se rompe a sí mismo, y sólo explota cuando el caso falla | Probar el camino del fallo, no sólo el del éxito (ejemplo: `«$VAR»` bajo `set -u` — bash se come el `»` como parte del nombre) |
| **BANCO-W2** | El caso arma un **fixture a mano** habiendo un constructor real importable | Usar el constructor real: si el formato cambia, el caso se entera |
| **BANCO-W3** | Hay un **modo de prueba declarado en el doble que ningún caso activa** | Agregar el caso, o sacar el modo: un escenario que nadie ejercita es un escenario que no existe |
| **BANCO-W4** | El chequeo exige un **número fijo** de apariciones de un patrón en un archivo que tocan varias stories: la próxima que agregue una aparición legítima lo pone en **rojo sin regresión**, y un control que da falsas alarmas termina ajustado a ciegas o apagado | Contar contra lo que el archivo tiene en el momento —el original, y original − 1 por cada mutante—, nunca contra una constante (ejemplo: un caso esperaba `112` —1 y 1 en los mutantes, 2 en el original— y un paso nuevo agregó una tercera aparición legítima) |

**Cómo se detecta**: por el **rojo previo**. Un caso que no se pone rojo contra el código sin
arreglar es candidato a `BANCO`, salvo que sea explícitamente de no-regresión (y entonces se
escribe que lo es, con el motivo). **BANCO-C5** se delata distinto: no por el rojo del caso sino midiendo el entorno real antes y después de correr la suite (el registro que creció, el archivo que cambió). La excepción es **BANCO-W4**, que se delata al revés: un caso
que se pone rojo **sin que nada se haya roto**, porque otra story agregó algo legítimo al archivo
que vigila. Ahí no se sube el número: se cambia el caso para que cuente contra lo que hay.

---

## Agregar una regla nueva

Para agregar una regla al sistema:

1. **Elegir advisor** donde vive la regla (SEC/DOTNET/TEST).
2. **Elegir ID**: siguiente número disponible en ese área+severity. Los IDs son secuenciales y estables — no reusar IDs retirados.
3. **Actualizar el `.md` del advisor** con:
   - Fila en la tabla "Catálogo de reglas"
   - Si aplica, ejemplo en la sección "Falsos positivos esperables"
4. **Actualizar este catálogo** (el archivo actual) con la fila nueva.
5. **Si la regla depende de una guía** (típico de DOTNET — reglas en `bizuit/bizuit-plugin-dotnet.md`), agregar el contenido a la guía primero.
6. **Commit** a ambos repos (`AgentSkills` para el advisor, el arnés para el catálogo).

**Regla**: no hay regla sin ID. Si necesitás checkear algo nuevo, primero lo documentás acá.

---

## Retirar una regla

Si una regla genera ruido sistemático (falsos positivos, ya no aplica al stack):

1. Marcarla en este catálogo con status "RETIRED" + fecha + razón.
2. Remover del advisor correspondiente (el detector ya no corre).
3. El ID **no se reutiliza** — queda como placeholder para historial.

Ejemplo:
```
| ~~SEC-W4~~ | ~~CORS pre-flight caching~~ | **RETIRED 2026-05-01 — falso positivo en 80% de casos. Replaced by SEC-W1 ampliado.** |
```

---

## Versionado

Este catálogo es **append-only por semántica**: los IDs nunca cambian de significado. Si una regla evoluciona significativamente, se crea un ID nuevo y el viejo se retira.

No hay versionado formal (no hay `v1.0`, `v2.0`). Si necesitás saber qué reglas existían en una fecha dada, mirar `git log` de este archivo.
