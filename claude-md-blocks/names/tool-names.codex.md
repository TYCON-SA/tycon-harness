# ===================================================
# Nombres por herramienta — lado CODEX
# ===================================================

Las reglas de este archivo refieren a las tools por **lo que hacen**; los nombres exactos
viven SOLO acá. Este es el único bloque que difiere entre `~/.claude/CLAUDE.md` (Claude Code)
y `~/.codex/AGENTS.md` (Codex) — el resto de las dos copias es idéntico y lo sincroniza
`sync-claude-md-blocks.sh`. **No agregar nombres exactos de tools fuera de esta sección.**

🔴 **Codex SANEA los guiones de los nombres de tool MCP a guiones bajos** (medido 2026-08-23 con
una sonda que ordenó llamar la tool y devolver su nombre exacto: un `mcp__<servidor>__list-time-entries` de Claude es
`mcp__<servidor>__list_time_entries` bajo Codex). Engram, codegraph y spokenly ya usan guion bajo y salen idénticos; el
servidor de una integración que tenga guiones en sus nombres trae acá su versión saneada. Por eso la columna de abajo
NO es una copia de la tabla de Claude: con guiones, la llamada falla.

🔴 **Si una tool de esta tabla NO está en la sesión** (el deploy falló, el server no quedó
registrado en esta máquina): **decilo explícitamente** ("no tengo la tool de X en esta sesión")
y seguí sin ella — **NUNCA inventar un nombre ni simular el efecto**. La ausencia declarada es
información; la simulada es el modo de falla que este archivo existe para impedir.

⚠️ **Los servidores MCP se difieren detrás del tool search de Codex**: no aparecen en el listado
inicial aunque estén sanos y cargados. Si una tool no figura, **buscala** antes de concluir que no
existe — y en un canario, ORDENÁ llamarla en vez de preguntar si está.

| Función | En Codex hoy |
|---|---|
| Telegram — avisar / editar aviso | ✅ `~/.claude/tycon-harness/scripts/lib/tycon-telegram-notify.sh "texto"` (imprime el `message_id`; `--edit <id> "texto"` reescribe ese aviso). Sólo SALIDA: recibir sigue siendo exclusivo de Claude Code con `--channels` — dos consumidores del mismo bot se pisan con un 409 | <!-- integration: telegram -->
<!-- time-tool-rows -->
| Memoria persistente (engram) — guardar / buscar / contexto | `mcp__plugin_engram_engram__mem_save` · `mem_search` · `mem_context` · `mem_session_summary` | <!-- integration: engram -->
| Grafo de código (codebase-memory) — búsqueda / trazas | `mcp__codebase_memory__search_graph` · `mcp__codebase_memory__trace_path` (los usan los advisors de wiring y sibling-pattern) |
| CodeGraph — búsqueda estructural de código | tools `mcp__codegraph__codegraph_*` (`_search`, `_context`, `_callers`, `_impact`, …) — el deployer lo registra **sólo si el binario `codegraph` está en el PATH** de la máquina; si no está, declarar la ausencia y usar `grep` | <!-- integration: codegraph -->
| Pregunta abierta por voz (Spokenly) | `mcp__spokenly__ask_user_dictation` — **sólo si** el server HTTP de Spokenly figura en el `~/.claude.json` de la máquina; si no, la pregunta va por el canal normal |
| Pregunta con opciones cerradas | ❌ sin equivalente — usar pregunta numerada en texto plano con opción default explícita (definición §2.3 de codex-migration.md) |
| Ejecución en segundo plano | shell con `&` + archivo de log; no hay notificación automática de término |
| Ver progreso de tareas de fondo | ❌ sin comando — leer el log del paso lanzado |
| Mensaje de seguimiento a un subagente | ❌ sin equivalente — el subagente termina y devuelve; relanzar con contexto si hace falta |

**Por qué este archivo se revisa y no se hereda**: una tabla de nombres que se queda vieja no falla
ruidosamente: apaga reglas en silencio (con la tabla diciendo que no había tools, Codex omitía el registro de horas,
engram y codegraph **teniendo las tools disponibles**). Por eso esta tabla se verifica con SONDA
cuando se toca (ordenarle a una sesión Codex llamar la tool y devolver su nombre exacto — así se
midió el saneo de guiones), no confiando en la memoria de nadie.
