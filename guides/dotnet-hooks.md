# Hooks recomendados para proyectos .NET TYCON

Bloque de hooks `.claude/settings.json` para proyectos .NET con migraciones SQL numeradas (Pacara, Totora, Ebano, etc.). Copy-pasteable.

> ⚠️ **Asimetría Codex (declarada 2026-08-23)**: estos hooks son de PROYECTO
> (`<repo>/.claude/settings.json`) y **ningún deployer del lado Codex los traduce** — bajo Codex
> el freno de migraciones inmutables y el `dotnet format` automático NO existen, sin error. Es la
> única familia de hooks fuera del despliegue automático. Atenuante medido: al 2026-08-23 ningún
> repo tiene el bloque adoptado, así que declarar alcanza; si un repo lo adopta y su equipo usa
> Codex, portarlo pasa a ser deuda real (fila correspondiente en codex-divergence-inventory.md).

## Por qué viven en `<repo>/.claude/settings.json` y no team-wide

Los hooks de Claude Code se leen desde:

- `~/.claude/settings.json` (user-global, por máquina)
- `<repo>/.claude/settings.json` (project-local, commiteado al repo)

**Claude Code NO lee hooks desde `~/.claude/agent-skills/`**, así que los hooks team-wide no se distribuyen vía el repo `AgentSkills` (a diferencia de subagents y skills). La forma correcta de propagarlos es: cada proyecto TYCON commitea este bloque en su `.claude/settings.json` local — los devs lo reciben con `git pull` del repo del proyecto, sin pasos manuales.

## Hooks recomendados

Dos hooks útiles para cualquier plugin .NET TYCON con migraciones SQL numeradas:

### 1. `PreToolUse` — bloquear edición de migraciones ya commiteadas

Las migraciones SQL son **inmutables** una vez aplicadas en otros entornos. Si el agente (o un dev) edita por error un `database/0NN_*.sql` ya commiteado, rompe la cadena de schema en CI/staging/prod.

Este hook bloquea `Edit` y `Write` sobre archivos `database/[0-9][0-9][0-9]_*.sql` que ya están **trackeados por git** (es decir, fueron commiteados al menos una vez). Migraciones recién creadas y aún no commiteadas siguen siendo editables.

### 2. `PostToolUse` — `dotnet format` automático sobre `.cs` editados

Mantiene el diff limpio, evita ruido de estilo en PRs y elimina findings espurios de `tycon-plugin-dotnet-conventions` por whitespace o ordering. Idempotente y rápido sobre un solo archivo.

## Bloque copy-pasteable

Pegar este bloque en el repo del proyecto, en `<repo-root>/.claude/settings.json` (crear el archivo si no existe). Si ya tenés `settings.json` con otras claves, fusionar el array `hooks`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "input=$(cat); file=$(echo \"$input\" | jq -r '.tool_input.file_path // .tool_input.path // empty'); if [ -z \"$file\" ]; then exit 0; fi; case \"$file\" in */database/[0-9][0-9][0-9]_*.sql) repo=$(echo \"$input\" | jq -r '.cwd // empty'); if [ -n \"$repo\" ] && cd \"$repo\" 2>/dev/null && git ls-files --error-unmatch \"$file\" >/dev/null 2>&1; then echo '🛑 BLOCKED: migración SQL ya commiteada al repo. Las migraciones son inmutables — creá una migración nueva en vez de editar esta.' >&2; exit 2; fi ;; esac; exit 0"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "input=$(cat); file=$(echo \"$input\" | jq -r '.tool_input.file_path // .tool_input.path // empty'); case \"$file\" in *.cs) command -v dotnet >/dev/null 2>&1 && dotnet format --include \"$file\" --no-restore --verbosity quiet 2>/dev/null || true ;; esac; exit 0"
          }
        ]
      }
    ]
  }
}
```

### Qué hacen los comandos paso a paso

**Hook PreToolUse (bloqueo de migraciones)**:

1. Lee el JSON de stdin (Claude Code pasa el contexto de la herramienta).
2. Extrae `file_path` o `path` con `jq`.
3. Si el path matchea `*/database/[0-9][0-9][0-9]_*.sql`:
   - Cambia al cwd del proyecto.
   - Corre `git ls-files --error-unmatch <file>` (silencioso). Si el archivo está trackeado → exit code 0 → el hook devuelve exit 2 = **bloqueo** + mensaje a stderr.
   - Si no está trackeado (migración nueva, sin commitear) → no bloquea.
4. Otros archivos: `exit 0` (continúa normal).

**Hook PostToolUse (dotnet format)**:

1. Lee el JSON de stdin.
2. Si el path termina en `.cs`:
   - Verifica que `dotnet` esté disponible en PATH.
   - Corre `dotnet format --include <file> --no-restore --verbosity quiet`. El `|| true` evita que un error de format rompa el flow del agente.
3. Otros archivos: no hace nada.

### Prerequisitos

- **`jq`** instalado (`brew install jq` en mac, `apt install jq` en linux).
- **`git`** disponible (siempre presente en repos).
- **`dotnet` CLI** disponible (necesario para el segundo hook).

### Cómo testearlos

1. Después de pegarlo en `.claude/settings.json` del repo, reiniciar la sesión de Claude Code.
2. Pedile al agente: *"editá `database/001_NimboSchema.sql` y agregá un comentario"* — debería bloquearse con el mensaje del hook.
3. Pedile: *"editá un `.cs` agregando whitespace extra"* — el archivo debería quedar formateado al guardar.

## Permisos

Para que los hooks corran sin pedir aprobación, el repo debe tener permisos para `Bash(jq:*)`, `Bash(git:*)`, `Bash(dotnet format:*)`. Estos permisos típicamente ya están en `.claude/settings.json` o `.claude/settings.local.json` de proyectos TYCON, pero verificá si los hooks fallan en silencio.

## Variantes opcionales

Si tu proyecto usa **csharpier** en lugar de `dotnet format`:

```json
"command": "input=$(cat); file=$(echo \"$input\" | jq -r '.tool_input.file_path // .tool_input.path // empty'); case \"$file\" in *.cs) command -v dotnet-csharpier >/dev/null 2>&1 && dotnet-csharpier --no-msbuild-check \"$file\" 2>/dev/null || true ;; esac; exit 0"
```

Si querés bloquear también `Bash` que invoque `sqlcmd -i database/0NN_*.sql` (ejecución de migración ya commiteada en DB de dev), agregar un matcher adicional `Bash` con regex sobre `tool_input.command`.

## Anti-patterns

- ❌ NO uses `--no-verify` para saltear estos hooks. Si fallan, el problema es real (migración inmutable o code mal formateado).
- ❌ NO desactives el hook localmente en `settings.local.json` para evitar el bloqueo. Si necesitás editar una migración commiteada, es porque hay un problema de schema que requiere migración nueva.
- ❌ NO copies la lógica del hook a un script externo y lo invoques desde el hook — eso agrega un step de mantenimiento. Inline está bien para esta complejidad.

## Hook 3 — Bloquear edit manual de `status:` en stories Mary+GOLD (proyectos con `specs/stories/`)

**Aplica a:** repos que tengan `specs/stories/N-M-*.md` (CeiboProject, EbanoProject, Totora/specs, FRESNO/specs, NimboFrontEnd/specs, etc.). En general: cualquier repo "project" en stack TYCON que use Mary+GOLD.

**Justificación:** las transiciones de campos contractuales del frontmatter (`status:`, `sprint:`, `signed_for_sprint:`, `pipelines.*.status:`, `ado_work_item:`) tienen side-effects coordinados por `tycon-pipeline` (clocki, ADO WI, engram, advisors). Editarlas manualmente con `Edit`/`Write` deja el estado inconsistente. Ver `workflow-orchestration.md` sección 8 para detalle.

**Por qué:** un edit manual de `status: review → done` deja la entrada de clocki en 0s, el work item de ADO sin cerrar y la transición sin trazar.

### Snippet copy-pasteable

Agregar al bloque `hooks.PreToolUse[].hooks` (junto a los hooks 1 y 2 si ya existen):

```json
{
  "type": "command",
  "command": "input=$(cat); file=$(echo \"$input\" | jq -r '.tool_input.file_path // .tool_input.path // empty'); case \"$file\" in */specs/stories/*.md|*/stories/*.md) old=$(echo \"$input\" | jq -r '.tool_input.old_string // empty'); new=$(echo \"$input\" | jq -r '.tool_input.new_string // empty'); old_status=$(echo \"$old\" | grep -E '^status:' | head -1); new_status=$(echo \"$new\" | grep -E '^status:' | head -1); if [ -n \"$old_status\" ] && [ -n \"$new_status\" ] && [ \"$old_status\" != \"$new_status\" ]; then echo 'BLOCKED: edit manual del campo status: en story Mary+GOLD. Las transiciones DEBEN ir via /tycon-pipeline close N.M (orchestrator). Ver ~/.claude/tycon-harness/guides/workflow-orchestration.md seccion 8.' >&2; exit 2; fi ;; esac; exit 0"
}
```

### Cómo testearlo

1. Pegar en `.claude/settings.json` del repo con `specs/stories/`.
2. Reiniciar la sesión de Claude Code.
3. Pedirle al agente: *"editá specs/stories/X-Y.md y cambiá status: ready-for-dev a in-progress"* → debería bloquearse con el mensaje del hook.
4. Pedirle: *"editá specs/stories/X-Y.md y agregá una línea al body (no toques status:)"* → debería permitirlo.

### Variante opcional — extender a otros campos contractuales

Si querés bloquear también `sprint:` y `signed_for_sprint:`, replicar el patrón con regexes adicionales:

```bash
old_signed=$(echo "$old" | grep -E '^(sprint|signed_for_sprint):' | head -1)
new_signed=$(echo "$new" | grep -E '^(sprint|signed_for_sprint):' | head -1)
if [ -n "$old_signed" ] && [ -n "$new_signed" ] && [ "$old_signed" != "$new_signed" ]; then
  echo 'BLOCKED: edit manual de sprint:/signed_for_sprint: requiere CR aprobado.' >&2
  exit 2
fi
```

### Distribución team-wide del fix

- Este snippet vive en la guía (este archivo) que se auto-pull a todos los devs TYCON.
- El hook real vive en `.claude/settings.json` de cada repo de specs y viaja con `git clone` / `git pull` del repo.
- **Para aplicar a un proyecto nuevo**: 1 PR al repo de specs agregando este snippet a su `.claude/settings.json`.
- Lista de repos TYCON con stories (mantener actualizada):
  - ✅ `CeiboProject` (aplicado 2026-05-14)
  - ⬜ `EbanoProject` (pendiente — tiene `specs/stories/`)
  - ⬜ `Totora` (verificar si tiene specs/stories)
  - ⬜ `FRESNO` (verificar)
  - ⬜ `Pacara` (verificar)

## Referencias

- `tycon-new-migration` skill — genera la próxima migración numerada con plantilla TYCON
- `migration-impact-analyzer` advisor — corre en el `tycon-pipeline` y valida migraciones nuevas contra el código (rule IDs `MIGRATION-C1..C5` + `MIGRATION-W1..W3`)
- `tycon-pipeline` SKILL.md — banner anti-pattern al tope sobre transiciones de status
- `workflow-orchestration.md` sección 8 — regla "Transiciones de campos contractuales SOLO via orchestrator"
