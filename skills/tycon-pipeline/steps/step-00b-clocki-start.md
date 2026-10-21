# Arranque: reloj de Clockify

**Objetivo**: abrir una entry en Clockify con el título de la story al arrancar la implementación. Pre-requisito: Clockify MCP instalado (ver `~/.claude/tycon-harness/guides/integrations/clockify-mcp.md`). Si no está instalado, este step se saltea silenciosamente — no bloquea el pipeline.

Este step corre **después** del Step 0 (preflight pasó). Razón: si preflight aborta (ej: estamos en main), no queremos abrir timer.

## 🔀 Fan-out del arranque (2026-07-30) — 0b y 0c corren MIENTRAS el validator del Step 1 ya está en vuelo

El validator del Step 1 tarda 1-7 min y **no depende de nada que 0b/0c produzcan** (verificado:
no lee `clockiStarted` ni `adoMarkedActive`; su input es solo la story, cuyo frontmatter el Step 0
ya mutó a `in-progress` — estado que el validator tolera explícitamente). Orden cableado:

1. **Resolver el project de clocki PRIMERO** (paso c de abajo) — es el ÚNICO punto de 0b que puede
   necesitar una pregunta al dev. Si hay que preguntar, se pregunta ACÁ, antes del fan-out.
2. **Abrir `steps/step-01-validate-story.md` y lanzar sus `Agent(...)` de los puntos 1 y 2 TAL
   CUAL están escritos** — incluidos los `lanzamientos` que devuelve `pipeline.js validators`
   (los revisores de validación de los paquetes, con su `prompt` y su `modelo` ya resueltos). Es la ÚNICA
   excepción al "Leé SOLO este step" de `pipeline.js next`: acá se lee step-01 para lanzar, y se
   vuelve a step-01 después para el join. Si el prompt no se puede reproducir textualmente, NO
   improvisarlo: caer al orden secuencial (el fan-out es optimización, no requisito).
3. **Completar 0b** (pasos b+d+e, atómicos como siempre) **y 0c inline** mientras el validator corre.
4. El join es la notificación del validator: recién ahí se procesa su reporte (decisiones C.i).
   🔴 **Nunca presentar una pregunta de 0b/0c y el resultado del validator en el mismo mensaje sin
   rotular cuál es cuál** — si 0c necesita confirmación (fallback por título / WI cerrado),
   resolverla ANTES de procesar el reporte del validator.

Si el fan-out se complica (ej: el project de clocki no resuelve y el dev no contesta), el orden
secuencial viejo (0b → 0c → 1) sigue siendo válido — el fan-out es optimización, no requisito.

## Cuándo saltear

- Si la integración **clockify está apagada** en esta máquina (sin `integrations.clockify` en `~/.claude/tycon.json` ni `TYCON_CLOCKIFY=1`; es el estado de fábrica de la copia pública), `pipeline.js next` ya da el 0b por salteado (`skip_mechanical`) y manda al paso siguiente: no hace falta marcar `clockiStarted`, y no se marca (diría «timer abierto» sin timer).
- Si **NINGUNA** tool de Clockify está disponible → saltear, loguear `step-00b-clocki: MCP no disponible, skip`. 🔴 Chequeá las DOS variantes de nombre: bajo Codex las tools vienen con **guiones bajos** (`mcp__clockify__list_clockify_workspaces`), no con guiones — ver "Nombres de las tools de Clockify" en `clocki/SKILL.md`. NO saltees sólo porque no encontrás el nombre EXACTO con guiones: eso apagaba el tracking en silencio bajo Codex.
- Si el frontmatter de la story no tiene título legible → usar el filename del story (ej: `story-2-3.md`).

## Acciones

> 🔴 Los nombres `mcp__clockify__*` de abajo van con **guiones**; bajo Codex usá la variante con **guiones bajos** — ver "Nombres de las tools de Clockify" en `clocki/SKILL.md`. Misma tool, distinto separador.


### 1. Extraer descripción de la story

Del frontmatter de la story (ya leído en Step 0/1), obtener:
- `title` (campo del frontmatter, ej: "Webhook handler para Telegram")
- `id` (campo del frontmatter, ej: "2.3"; si no existe, usar el filename sin extensión)

Construir descripción: `"Story <id> — <title>"`. Ej: `"Story <N.M> — Webhook handler para Telegram"`. Cap a 100 chars.

### 2. Invocar clocki:start (transición atómica close+open — anti billing-gap)

Seguir el flujo de `~/.claude/skills/clocki/SKILL.md` (la skill de la integración de Clockify) (sección "Flujo de `start`" + "Regla atómica close+open") **SIN pedir confirmación al user** — el pipeline es intent explícito.

**🔴 REGLA ATÓMICA (no-negociable)**: los pasos b + d + e deben ejecutarse en el MISMO bloque de tool calls (mismo turn). Si b se ejecuta y d/e no (ej: error MCP en el medio), abortar el pipeline con CRITICAL — un timer cerrado sin sucesor genera billing-gap: el tiempo entre el cierre de una entry y la apertura de la siguiente queda sin registrar.

Concretamente:

a. **Leer** `~/.claude/clocki/active.json` con Read. Capturar `entryId` y `lastActivity` del cwd actual si existe.
b. **Cerrar previo en este cwd** (si existe): llamar `mcp__clockify__update-clockify-time-entry` con `end = active.json[cwd].lastActivity` literal (NO now — usar el último activity registrado).
c. **Resolver project**:
   - Leer `~/.claude/clocki/project-cache.json`. Si hay entry para cwd → usar.
   - Si no, llamar `mcp__clockify__list-clockify-projects` (workspace default — primer item de `list-clockify-workspaces` salvo override en `~/.claude/clocki/settings.json`). Matchear basename(cwd) contra project names: exact case-insensitive > parcial.
   - Si no hay match único → preguntar al user qué project usar (lista top 5). En este caso SÍ pausar para input.
   - Cachear resultado en project-cache.json.
d. **Crear entry nueva** (mismo turn que b): llamar `mcp__clockify__create-clockify-time-entry` con:
   - `workspaceId`, `projectId` resueltos
   - `description` = la armada arriba
   - `start` = MISMO valor que `end` del paso b si hubo previa (zero-gap continuity), o `date "+%Y-%m-%dT%H:%M:%S"` (hora LOCAL bare, SIN `-u`) si no había previa. 🔴 NUNCA UTC (`date -u` / `toISOString()`) — el MCP de Clockify recibe el timestamp en local y lo convierte a UTC; si le pasás UTC lo trata como local y la entry queda corrida por tu offset (caso 2026-05-17). Ver clocki SKILL.md "Reglas CRÍTICAS de timestamps → Timezone".
   - `end` = MISMO valor que `start` (NO null, NO futuro — MCP wrapper requiere `end` string; ver clocki SKILL.md "Regla atómica")
e. **Persistir** (mismo turn que d): sobrescribir `active.json[cwd]` con:
   - `entryId` = el nuevo (response.id de paso d)
   - `workspaceId`, `projectId`, `description` actualizados
   - `startedAt` = mismo `start` de paso d
   - `lastActivity` = mismo
   - `source` = "tycon-pipeline"
   - Si Write falla por file-state lock (hook touch-activity actualiza file entre Read y Write) → usar `cat > ~/.claude/clocki/active.json <<EOF...EOF` via Bash.

**Sanity check post-step**: verificar `active.json[cwd].entryId` matchea response.id de paso d. Si NO matchea → CRITICAL log + abortar pipeline (atomicidad rota).

**Registrar flag en el marker** (para que un resume cross-session / `pipeline.js next` sepan que este step ya corrió y NO re-abran timer):

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js set-flag clockiStarted true
```

### 3. Confirmación silenciosa

Loguear a stdout una línea corta:
```
✓ Clocki timer abierto: <description> en project <project-name>
```

No pausar, seguir directo al Step 1.

## Errores tolerables

Si CUALQUIER paso falla (MCP no responde, project no resuelve, write a active.json falla):
- Loguear `⚠ Clocki: step-00b falló — <razón>. Pipeline continúa sin tracking.`
- NO interrumpir el pipeline. El timer es nice-to-have, no critical-path.

## Lo que NO hace este step

- ❌ NO cierra el timer al final del pipeline. Las 4 vías de cierre están enumeradas en
  `step-08-commit-prep.md` §"NO cerrar el clocki timer" — ésa es la lista canónica, no se duplica acá.
- ❌ NO pide confirmación al user cuando viene de tycon-pipeline (es intent explícito).
- ❌ NO arranca timer si el preflight (Step 0) falló.

## Output

Archivo `step-00b-clocki.md` en `.advisors/pipeline-runs/<clave>-<sello>/`:

```markdown
# Arranque: reloj de Clockify

- description: Story <N.M> — Webhook handler
- workspaceId: ws-xxx
- projectId: prj-yyy
- entryId: ent-zzz
- startedAt: 2026-05-12T15:30:00Z
- status: ok | skipped (<razón>) | failed (<razón>)
```
