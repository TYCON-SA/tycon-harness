# clocki — Time tracking automático en Clockify

Skill + hooks que abren y cierran entries de tiempo en Clockify cuando trabajás sobre algo (una story, un fix, un refactor, una sesión de planning). Diseñado para que el equipo TYCON tenga tracking transparente, sin fricción y cross-platform (Mac/Linux/Windows).

## Cómo funciona

### Cuando trabajás con una story (vía `tycon-pipeline`)

Cuando invocás `tycon-pipeline` (ej: "implementemos la story-2-3.md"):

1. Step 0 — preflight (branch guard).
2. **Step 0b — clocki-start automático**:
   - Lee `title` + `id` del frontmatter de la story.
   - Resuelve project en Clockify auto-matcheando el basename del cwd (ej: cwd `~/SourceCode/Ceibo` → project `Ceibo`). Cachea el resultado.
   - Abre time entry con descripción `Story <N.M> — <título>` (cap a 100 chars).
   - **No pide confirmación** — el pipeline es intent explícito.
3. Pipeline continúa normal.
4. El timer queda corriendo. Si hacés `git commit`, code review, etc, todo cuenta como tiempo de la story.
5. **El timer se cierra solo** cuando:
   - Pasan >15min sin actividad (sweep retroactiva el end-time al último activity timestamp).
   - Arrancás otra cosa (nuevo `clocki:start` cierra el previo).
   - Tipeás `/clocki stop`.

### Cuando trabajás sin story (ad-hoc, fix, planning)

El hook `UserPromptSubmit` detecta keywords de intent ("fixeemos", "refactor", "agregar", "trabajemos", "review", "investiguemos", etc) en tu prompt. Si detecta intent **y** no hay timer activo en ese cwd:

1. Inyecta un system-reminder pidiéndole al agente que evalúe si es trabajo real o solo charla.
2. Si el agente juzga que sí, **te pregunta**: *"Detecté trabajo: fix bug login. ¿Abro timer en project Ceibo? (sí / cambiar desc / cambiar project / no)"*
3. Confirmás → timer abierto. Negás → ignorado.

Tradeoff: **autoría con confirmación** (no automático silencioso). Cero entries fantasma; sí una pregunta extra cuando empezás algo nuevo.

### Cierre automático por idle

Cualquier tool call (Edit, Bash, Read, etc) actualiza `lastActivity`. Si pasan **15 minutos sin actividad**:

- En el próximo `SessionStart` o `UserPromptSubmit`, el sweep detecta el timer stale.
- Emite reminder al agente para cerrarlo con `end = lastActivity` (NO `now` — el tiempo idle no se cuenta).
- Si cerraste VS Code y volvés al día siguiente, el timer se cierra retroactivamente con la duración real trabajada.

## Comandos manuales

| Comando | Qué hace |
|---|---|
| `/clocki start "descripción"` | Abre timer manualmente. Auto-resuelve project. Pide confirmación si no hay match único. |
| `/clocki stop` | Cierra el timer activo en este cwd. |
| `/clocki status` | Muestra timer activo (descripción, project, tiempo corrido). |
| `/clocki config` | Configura manualmente cwd → workspace/project (override del auto-match). |

## Instalación (una vez por máquina)

**Pre-requisito**: Clockify MCP instalado. Si no lo tenés:

```bash
# macOS / Linux
bash ~/.claude/tycon-harness/scripts/setup/install-clockify-mcp.sh

# Windows
pwsh ~\.claude\tycon-harness\scripts\setup\install-clockify-mcp.ps1
```

**Instalar los hooks**:

```bash
# macOS / Linux
bash ~/.claude/agent-skills/skills/clocki/scripts/install-clocki-hooks.sh
```

```powershell
# Windows
pwsh $HOME\.claude\agent-skills\skills\clocki\scripts\install-clocki-hooks.ps1
```

El install script:
- Verifica que Node.js esté en PATH.
- Crea `~/.claude/clocki/` con defaults (`idleTimeoutMinutes: 15`, etc).
- Parcha `~/.claude/settings.json` agregando tres hooks (SessionStart, UserPromptSubmit, PostToolUse) **sin pisar** hooks existentes (idempotente — corrible varias veces sin duplicar).
- Reiniciás la sesión de Claude Code → listo.

## Archivos del sistema

### `~/.claude/agent-skills/skills/clocki/` (compartido, team-wide via git pull)

```
SKILL.md                              # documentación + flujo para el agente
scripts/
├── lib.js                            # helpers compartidos (state I/O, normalización)
├── sweep.js                          # hook SessionStart: detecta stale, emite reminder
├── on-prompt.js                      # hook UserPromptSubmit: sweep + intent detection
├── touch-activity.js                 # hook PostToolUse: bumps lastActivity
├── install-clocki-hooks.sh           # installer macOS/Linux
└── install-clocki-hooks.ps1          # installer Windows
```

### `~/.claude/clocki/` (estado local por-dev, NO commiteado)

```
active.json                           # timers activos por cwd
project-cache.json                    # cache cwd → workspace/project
settings.json                         # config: idleTimeoutMinutes, intentKeywords, etc
```

## Settings que podés tunear

Editá `~/.claude/clocki/settings.json`:

```json
{
  "idleTimeoutMinutes": 15,
  "defaultWorkspaceId": null,
  "intentKeywords": ["implementemos", "fixear", "..."]
}
```

- `idleTimeoutMinutes`: cuántos min de inactividad antes de cerrar (default 15). Subilo si trabajás con pausas largas y querés que cuente; bajalo para tracking más estricto.
- `defaultWorkspaceId`: si tenés varios workspaces en Clockify, podés fijar uno por default (sin este, usa el primero que devuelve la API).
- `intentKeywords`: palabras que activan la detección de intent en `UserPromptSubmit`. Podés agregar las propias.

## Anti-patterns

- ❌ **NO** se commitea `~/.claude/clocki/` a ningún repo — es estado per-dev (active.json contiene IDs específicos de tu cuenta de Clockify).
- ❌ **NO** se hardcodea workspace/project ID en el repo — auto-match + cache lo resuelve por dev.
- ❌ **NO** se cierra el timer cuando termina `tycon-pipeline` — el commit + push + review también es trabajo en esa story. El idle-timeout lo cierra cuando efectivamente pares.
- ❌ **NO** se loguea API key de Clockify a `active.json` ni a logs — los scripts no manejan la key, solo el agente la usa via MCP.

## Troubleshooting

**No se abre timer cuando empiezo una story con `tycon-pipeline`:**
- Verificá que el MCP esté instalado: `claude mcp list | grep clockify` (debe decir ✓ Connected).
- Mirá el log del pipeline: `.advisors/pipeline-runs/<story-id>-*/step-00b-clocki.md` debería existir y decir `status: ok`.

**Cuando empiezo a trabajar el agente no me pregunta nada:**
- Mirá `~/.claude/clocki/active.json` — si ya hay timer activo en este cwd, no propone otro.
- Cerralo con `/clocki stop` y probá de nuevo. Si seguís sin trigger, fijate si tu prompt tiene alguno de los `intentKeywords` (en `settings.json`).

**Timer no se cierra cuando dejo de trabajar:**
- El sweep solo corre al SessionStart o UserPromptSubmit. Si cerraste VS Code y nunca volviste, el timer queda "abierto" en Clockify hasta que arranques una sesión de nuevo (entonces se cierra retroactivamente al lastActivity, así la entry queda bien igual).
- Para cerrar ya, abrí una sesión y tipeá `/clocki stop` o esperá al sweep automático.

**Auto-match elige el project equivocado:**
- Borrá la entry del cwd en `~/.claude/clocki/project-cache.json`.
- Próximo `clocki:start` te ofrece la lista de projects para elegir manualmente. Esa elección se cachea.
- También podés usar `/clocki config` para configurar explícitamente.

**Quiero deshabilitar clocki temporalmente:**
- Editá `~/.claude/settings.json` y comentá / sacá los tres hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse` que apuntan a `clocki/scripts/*.js`).
- O renombrá `~/.claude/clocki/` a `~/.claude/clocki.disabled/` — los scripts no encuentran el state dir y exitean sin hacer nada (exit 0 siempre).

**El skill no aparece al tipear /clocki:**
- Verificá que `~/.claude/agent-skills/skills/clocki/SKILL.md` exista.
- Hacé `cd ~/.claude/agent-skills && git pull` para asegurarte que el repo está al día.
- Reiniciá la sesión de Claude Code.

## Cómo lo reciben los devs nuevos

Si el dev nuevo ya hizo el setup del README del arnés (clone del repo + hook `SessionStart git pull`):

1. Próxima sesión de Claude Code → auto-pull trae el skill `clocki` desde `~/.claude/agent-skills`.
2. El dev corre **una vez**: `bash ~/.claude/agent-skills/skills/clocki/scripts/install-clocki-hooks.sh` (o el `.ps1` en Windows).
3. Listo. Las updates futuras (cambios al `SKILL.md`, a los scripts, etc) llegan via el git pull automático.

Si el dev no quiere clocki, simplemente no corre el install script. El skill queda disponible (tipeable con `/clocki ...`) pero los hooks no se activan automáticamente.
