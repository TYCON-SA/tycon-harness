<!-- requires-profile: full -->
# ===================================================
# Nombres por herramienta — lado CLAUDE CODE (2026-08-20)
# ===================================================

Las reglas de este archivo refieren a las tools por **lo que hacen**; los nombres exactos
viven SOLO acá. Este es el único bloque que difiere entre `~/.claude/CLAUDE.md` (Claude Code)
y `~/.codex/AGENTS.md` (Codex) — el resto de las dos copias es idéntico y lo sincroniza
`sync-claude-md-blocks.sh`. **No agregar nombres exactos de tools fuera de esta sección.**

| Función | Nombre exacto en Claude Code |
|---|---|
| Telegram — responder / avisar | `mcp__plugin_telegram_telegram__reply` |
| Telegram — editar un aviso ya mandado | `mcp__plugin_telegram_telegram__edit_message` |
| Clockify — abrir time entry | `mcp__clockify__create-clockify-time-entry` |
| Clockify — actualizar/cerrar time entry | `mcp__clockify__update-clockify-time-entry` |
| Clockify — listar projects / workspaces / entries | `mcp__clockify__list-clockify-projects` · `list-clockify-workspaces` · `list-clockify-time-entries` |
| Memoria persistente (engram) — guardar / buscar / contexto | `mcp__plugin_engram_engram__mem_save` · `mem_search` · `mem_context` · `mem_session_summary` |
| Pregunta con opciones cerradas (cuadro clickeable) | `AskUserQuestion` |
| Pregunta abierta por voz (Spokenly) | `mcp__spokenly__ask_user_dictation` (cargarla con `ToolSearch` si está deferred) |
| CodeGraph — búsqueda estructural de código | tools `mcp__codegraph__codegraph_*` (`_search`, `_context`, `_callers`, `_impact`, …) |
| Ejecución en segundo plano | parámetro `run_in_background` en `Bash`/`Agent`; la tool `Workflow` ya corre de fondo |
| Ver progreso de tareas de fondo / fan-outs | comandos `/tasks` y `/workflows` |
| Mensaje de seguimiento a un subagente | `SendMessage` |
