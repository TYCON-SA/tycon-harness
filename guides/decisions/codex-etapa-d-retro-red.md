# Propuesta — Etapa D: la red de `tycon-retrospective-capturer` (28/28)

**Fecha**: 2026-08-22 · **Plan**: [codex-migration.md](../codex-migration.md) · **Estado**: ✅ DECIDIDO 2026-08-22 — las 4
preguntas resueltas por el dev, las 4 con la opción recomendada: (1) anclaje en **artefactos
verificables** · (2) escritura sin ensuciar con el **mecanismo completo**, incluidos los retoques
al canónico (`dashboard_dir`/`gates_log` como inputs del caller) · (3) gemelo limpio = **latido +
prohibiciones + línea `CAPTURAS:`** · (4) frenos Codex: **el paquete propuesto entero**
(enabled_tools + approve solo engram + workspace-write + writable_roots declarados + runner lee
el sandbox del perfil). La implementación se presupuesta aparte (Parte 8) y corre en sesión propia.

---

## Parte 0 — La foto del sujeto (por qué no le sirve el contrato de los otros 27)

El contrato de veredicto del banco es "presencia/ausencia del rule ID objetivo como bullet".
El capturer no tiene dónde agarrarse de eso, y no por accidente:

- **0 reglas con ID, severidad INFO only, nadie lee su salida** — su producto no es un reporte:
  son **escrituras**: observaciones en engram, el JSON de métricas del dashboard, `alerts.md`
  si un umbral cruza.
- **Toca estado global en 3 canales**: engram (store compartido), el dashboard
  (`~/SourceCode/tycon-claude-guides/.dashboard/` — ruta absoluta hardcodeada en el canónico),
  y `gates.log` global como INPUT (`~/.claude/.tycon-pipeline/gates.log`).
- **Único advisor con Write + mem_save**, corre post-commit async: exactamente donde la
  sustitución silenciosa (sonda D) pasaría inadvertida, y donde un caso mal diseñado ensucia
  de verdad.

El contrato del caller ya existe y es texto libre (step 10b de `/tycon-merge-to-main`: "repo,
rango de commits, paths de `.advisors/pipeline-runs/`") — el mismo patrón "inputs del caller"
que el banco ya usa con deferral (`engram_project=...`).

---

## Parte 1 — Pregunta 1: ¿rule IDs nuevos o artefactos verificables?

**Recomendación: ARTEFACTOS.** El veredicto se ancla en lo que el runner puede verificar sin
creerle al modelo — y para un observer cuyo output nadie lee, eso son sus escrituras, no su prosa.

| | Opción A — rule IDs nuevos (`RETRO-C*`) | Opción B — artefactos verificables |
|---|---|---|
| **Pros** | Contrato uniforme con los otros 27 · cero código nuevo en el runner | Mide el **producto real** (engram/dashboard/alerts) · el canónico queda casi intacto (2 retoques aditivos, Parte 5) · la verificación la hace el RUNNER post-run, determinista — infalsificable como la verdad-de-consola de los canarios |
| **Contras** | Exige reescribir el canónico **sin foto previa posible** (el huevo-y-gallina: la red que protegería la reescritura no existe hasta después de reescribir) · los IDs serían cosméticos — INFO-only, sin consumidores: ni catálogo, ni dev, ni pipeline (rules-distill los vería como familia huérfana nueva) · seguiría midiendo el REPORTE, no las escrituras — el reporte es justo lo que nadie lee | Pide 2-3 tipos de aserción nuevos en `advisor-runner.js` (~100-150 líneas + selftest offline) · los 2 retoques al canónico van ANTES de la red — mitigado: son aditivos, chicos, y el dev los aprueba leyendo el diff entero |

El precedente que lo decide: `expect_mcp` ya rompió la uniformidad del contrato cuando hizo
falta ("QUE la tool se llamó" no es "QUE el ID apareció") — esto es el paso siguiente de la
misma lógica, no una excepción nueva.

---

## Parte 2 — Pregunta 2: cómo se asserta una ESCRITURA sin ensuciar

Tres canales, un mecanismo cada uno, y un tripwire que vigila los tres.

### 2.1 Engram — project descartable + nonce por corrida + guard duro

- El caso pasa `engram_project=advbench-retro` como input del caller (ya lowercase — engram
  lowercasea y su filtro es case-insensitive).
- **Nonce**: el runner genera un token único por corrida (`<case-id>-<epoch>`) y lo planta en el
  fixture (título de la story / mensaje del commit). El advisor que captura la decisión cita la
  story → la observación contiene el nonce sin que se le pida nada raro.
- **Aserción del runner, no del modelo**: post-run, `engram search --project advbench-retro
  "<nonce>"` vía CLI (el runner corre sin sandbox en el host). must-capture → ≥1 · gemelo → =0.
  Residuos de corridas anteriores **no pueden** dar falso verde: el nonce es único.
- **Limpieza**: `engram delete project advbench-retro --hard` post-suite — existe en el CLI
  (verificado 2026-08-22) y es un cascade-delete del project entero, un comando determinista.
  Aun así la correctness no depende de la limpieza (el nonce la independiza). `engram projects
  consolidate` sigue PROHIBIDO, ni para limpiar.
- **Guard duro en el runner**: un caso de retro cuyo `engram_project` no empiece con
  `advbench-` **no corre** — la suite falla en armado, antes de gastar LLM. El freno anti
  "caso mal diseñado escribe a proyecto real" vive en el banco, no en la buena memoria.
- Sin export a repos: las obs viajan a un repo sólo vía `.engram-project` + sync; el fixture es
  efímero y no tiene ninguno de los dos.

### 2.2 Dashboard y gates.log — parametrizar el canónico (retoque legítimo, no concesión al banco)

Hoy el canónico hardcodea la ruta absoluta del dashboard (asume dónde está clonado
`tycon-claude-guides` — deuda real en máquinas del equipo) y lee gates.log de la ruta global.
Retoque: ambos pasan a ser **inputs del caller con default en el valor actual**
(`dashboard_dir=` · `gates_log=`). Step 10b los pasa explícitos; el banco pasa rutas DENTRO del
fixture. Nada cambia para producción; el banco queda hermético.

### 2.3 El tripwire anti-contaminación (el banco se vigila a sí mismo)

Barato y determinista, en el runner:
1. **Antes** de cada corrida: snapshot del listado de `~/.../.dashboard/` real + mtime/size del
   gates.log real.
2. **Después**: re-chequeo. Si algo cambió → el caso se marca **CONTAMINANTE** y la suite entera
   sale en rojo con ese motivo (no es un fallo del advisor: es un fallo del diseño del caso).
3. **Engram global**: `engram search "<nonce>"` sin filtro de project — el nonce debe aparecer
   SOLO en `advbench-retro`. Si aparece en otro project → rojo contaminación.

La regla que implementa: el banco no solo no debe ensuciar — debe **detectar** si ensució.

---

## Parte 3 — Pregunta 3: el gemelo limpio de un capturer

**"Nada que capturar" ≠ "no produjo nada".** El canónico ya obliga un latido en cada corrida:
el dashboard JSON se escribe SIEMPRE (las 6 métricas se calculan haya o no capturas) y la métrica
`retrospective_capturer_last_successful_run` es el self-check. Entonces:

| | REQUIRED (si falta → rojo) | FORBIDDEN (si aparece → rojo) |
|---|---|---|
| **Gemelo limpio** | `<dashboard_dir>/metrics-*.json` existe, parsea como JSON y tiene las 6 claves de métricas | Obs con nonce en `advbench-retro` · `.advisors/alerts.md` en el fixture |
| **Run muerto** | no escribe el REQUIRED → rojo por ausencia de latido | — |

El muerto y el limpio quedan separados por construcción: el limpio produce el latido y cero
capturas; el muerto no produce ni el latido.

**Segunda señal (retoque b al canónico)**: el reporte cierra con una línea mecánica
`CAPTURAS: engram=<n> dashboard=<ruta|no> alertas=<sí|no>` — espejo de `CHEQUEOS-MCP`, misma
lógica ya medida en la etapa: llenar un campo obligatorio es más confiable que obedecer una orden
general, y para llenarlo sin mentir hay que haber escrito (el archivo lo verifica el runner
igual; si la línea dice `engram=1` y el nonce no está, ese delta es EL hallazgo). Vive en el
canónico — no en el preamble de codex — para que Claude la emita también.

---

## Parte 4 — Pregunta 4: frenos Codex (workspace-write + mem_save auto-aprobado)

**`enabled_tools` es EL freno; el sandbox es el segundo.** En orden de importancia:

1. **`enabled_tools = ["mem_save", "mem_search", "mem_context"]`** en el server engram del
   perfil — réplica exacta del frontmatter de Claude. Sin la whitelist, `approve` sobre el
   server completo auto-aprobaría también `mem_delete`, `mem_update`, `mem_merge_projects`.
   Con ella, esas tools no existen para el modelo. (Mecanismo ya verificado por canario.)
2. **`approve` SOLO por-server para engram** (como en los otros revisores), nunca como default del perfil.
3. **workspace-write acota las escrituras al cwd** (el fixture) — en el banco es exactamente lo
   que queremos: la ruta real del dashboard NO es escribible desde el fixture, el sandbox de
   codex es una capa más del tripwire. En **producción** bajo codex, el perfil declara
   `writable_roots = [<dashboard_dir real>]` y nada más — la asimetría queda **declarada en el
   perfil**, no descubierta en runtime (lo que no admite paridad se declara).
4. **Runner**: hoy hardcodea `--sandbox read-only` para codex → pasa a leer el sandbox del
   perfil del advisor (retro es el único workspace-write; los otros 27 no cambian).

No hace falta más freno que eso: el guard `advbench-` (2.1) y el tripwire (2.3) cubren lo que
el perfil no puede saber.

---

## Parte 5 — Los ÚNICOS retoques al canónico (aditivos, antes de la red, con OK del dev)

a. **Inputs del caller parametrizados**: `dashboard_dir` y `gates_log` con default en los
   valores actuales (§2.2). `engram_project` ya es doctrina del advisor ("leer de CLAUDE.md /
   `.engram-project`") — se explicita que el caller puede pasarlo.
b. **Línea de cierre `CAPTURAS:`** en el formato de reporte (§3).

Los dos son verificables a mano leyendo el diff (chico), y los dos mejoran el advisor FUERA del
banco: (a) paga deuda de ruta absoluta; (b) es la misma medicina de honestidad que ya funcionó.

**Lo que NO se toca**: workflow, métricas, umbrales, anti-patterns, auditoría externa mensual.
Cero reescritura.

---

## Parte 6 — Los casos propuestos (4 firmes + 1 candidato)

Regla vigente: los fixtures se CALCAN de material real (commits/stories/findings.json de
corridas reales del pipeline), no se inventan.

| # | id | tipo | qué planta el fixture | qué asserta el runner |
|---|---|---|---|---|
| 1 | `retro-captura-decision` | must-capture | story mergeada + commit con patrón "elegimos X porque Y" (calcado) + `findings.json` con disposition fixed · nonce en el título | nonce en `advbench-retro` ≥1 (CLI) · dashboard JSON con las 6 claves · `expect_mcp: mem_save` |
| 2 | `retro-correlacion-canario` | must-capture | **fixture con git history plantada** (feature nueva del runner: `git_commits` en el caso): merge con warning waived en `findings.json` + hotfix 3 días después tocando el mismo archivo | la correlación aparece: `alerts.md` o la métrica `ignorado_que_volvio_como_bug` > 0 en el JSON. Sin `expect_mcp` — su workflow de correlación es git+findings, no manda engram (lección deferral-C2: no forzar donde el procedimiento no pide) |
| 3 | `retro-gemelo-limpio` | heartbeat-only | merge trivial: sin patrones de decisión, sin waived, sin hotfix, métricas verdes | REQUIRED: dashboard JSON + 6 claves · FORBIDDEN: nonce-obs y `alerts.md` (§3) |
| 4 | `retro-umbral-alerta` | must-alert | `findings.json` con ratio actioned <50% **por construcción** (determinista) | `alerts.md` existe y nombra `advisor_warnings_actioned_ratio` |
| 5 | `retro-dedup` | CANDIDATO | el runner pre-planta en `advbench-retro` una obs con el mismo learning del fixture | 0 saves nuevos con nonce + `expect_mcp: mem_search` (su doc MANDA search antes de save). Riesgo declarado: el juicio "es duplicado" puede variar — si no estabiliza en 3 diseños, se declara en `__doc` y no se fuerza |

El flagship es el #2: la correlación warnings-ignorados↔incidentes es la razón de existir del
advisor, y hoy nadie verifica que la sepa hacer.

---

## Parte 7 — Qué se le suma al runner (todo con selftest offline, cero LLM)

- `expect_artifact`: `[{ path, json_keys?, content_regex? }]` — existencia + forma.
- `forbid_artifact`: `[{ path }]` — para el FORBIDDEN del gemelo.
- `expect_engram`: `{ project, min?, max? }` — búsqueda CLI por nonce, con el guard `advbench-`.
- Fixture con `git_commits` opcional (git init + commits con fecha/mensaje/archivos del caso).
- Sandbox de codex por perfil (deja de estar hardcodeado read-only).
- Tripwire de contaminación (§2.3).
- `--selftest-retro` con artefactos reales capturados (patrón `--prove-detection`): el negativo
  del selftest es un run muerto (sin latido) y un run contaminante (nonce fuera de
  `advbench-retro`).

## Parte 8 — Orden de implementación y costo

1. Retoques (a)+(b) al canónico — diff chico, dev lo lee entero. Sin LLM.
2. Runner: aserciones nuevas + selftest offline. Sin LLM.
3. Suite 4 casos + baseline Claude (3 corridas c/u). ~12 invocaciones sonnet.
4. Perfil codex (workspace-write + enabled_tools + approve engram + writable_roots doc) +
   paridad. ~12 invocaciones gpt.
5. Candidato dedup sólo si (3) estabilizó.

Escala de costo: igual a las suites de los otros revisores. Todo lo determinista va primero; el LLM se
gasta al final y una vez.

## Parte 9 — Descartado con razón (para no re-litigarlo)

- **Rule IDs `RETRO-C*`**: cosmético para un INFO-only sin consumidores; exige reescritura sin
  foto previa (Parte 1).
- **`HOME` redirigido al fixture** (aislaría engram y el `~` del dashboard gratis): rompe el
  descubrimiento de MCP servers y toda la config (`~/.claude.json`, `~/.codex/`) — demasiado
  invasivo para lo que resuelve; la parametrización (§2.2) lo logra sin romper nada.
- **Escribir a projects reales de engram "total después se borra"**: NUNCA — el borrado no es
  atómico, las obs viajan a repos vía sync, y consolidate está prohibido.
- **Usar un merge real como fixture**: eso es la auditoría externa mensual, que ya existe y
  sigue — el banco es determinista y pre-merge por diseño.

---

