<!-- TYCON_BLOCK:background-execution START — generado por scripts/setup/agents-md-blocks.js del arnés · NO EDITAR A MANO (se pisa en la próxima actualización); editá claude-md-blocks/background-execution.md y commiteá -->
# ===================================================
# REGLA EJECUCIÓN EN SEGUNDO PLANO — pasos largos no bloquean la conversación
# ===================================================

**Por qué**: mientras una herramienta corre, los mensajes del dev esperan pegados al próximo
resultado — el agente no puede leerlos ni contestarlos hasta que termina. Un paso largo bloqueante
deja al dev minutos sin respuesta.

## Las 4 reglas

1. **Todo paso que se estime ≥2 minutos corre EN SEGUNDO PLANO** — con el mecanismo de ejecución en
   segundo plano de la herramienta (nombres exactos en la sección "Nombres por herramienta" al final
   de este archivo) — salvo que un gate necesite su exit code inmediato Y tarde
   menos que eso. La notificación de término llega sola; mientras tanto la conversación queda libre.
2. **Antes de lanzar cualquier paso ≥30 segundos: anunciar en UNA línea qué corre y cuánto se
   estima** ("suite completa, ~90s" / "pase adversarial, ~30 min"). El silencio esperado no es un
   misterio; el inesperado sí.
3. **Al volver de una espera, si el dev escribió algo en el medio, contestarle PRIMERO** — antes de
   encadenar el siguiente paso. El mensaje quedó esperando; el paso puede esperar 15 segundos más.
4. **Progreso visible sin preguntar**: usar los comandos de la herramienta que listan fan-outs y
   tareas de fondo (nombres exactos en la sección "Nombres por herramienta"). Son del harness, no
   del modelo — funcionan igual con cualquier modelo. Para sesiones largas, ofrecer aviso por
   Telegram al cierre de cada TANDA (nunca por agente — regla de avisos de progreso del bloque de
   estilo).

## Anti-patterns

- ❌ Correr bloqueante un paso de >2 min "por costumbre" cuando nada del turno actual depende de él.
- ❌ Volver de una espera larga y seguir encadenando pasos con un mensaje del dev sin contestar.
- ❌ Lanzar algo de 30 minutos sin decir cuánto tarda.

## Esto se MIDE, no se confía (cableado 2026-07-30, mismo día)

Hooks `blocking-meter.js` (Stop — mide la tool call bloqueante más larga del turno, excluyendo las
de fondo y las que esperan una respuesta del dev, y los mensajes del dev encolados durante la espera) + `blocking-notice.js`
(UserPromptSubmit — cobra el veredicto al turno siguiente). Nunca bloquean el cierre del turno
(misma decisión que el medidor de estilo: medir y cobrar después). Instalados por
`install-tycon-hooks.sh` en cada máquina del equipo.

- Estadística: `node <tcg>/scripts/hooks/blocking-meter.js --report [--all]`
- Umbral: `TYCON_BLOCKING_MAX_MS` (120000 = el corte de 2 min de la regla 1)
- Opt-out: `TYCON_BLOCKING_METER=0`
<!-- TYCON_BLOCK:background-execution END -->

<!-- TYCON_BLOCK:tool-names START — generado por scripts/setup/agents-md-blocks.js del arnés · NO EDITAR A MANO (se pisa en la próxima actualización); editá claude-md-blocks/tool-names.md y commiteá -->
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
| Grafo de código (codebase-memory) — búsqueda / trazas | `mcp__codebase_memory__search_graph` · `mcp__codebase_memory__trace_path` (los usan los advisors de wiring y sibling-pattern) — el deployer lo registra **sólo si el binario `codebase-memory-mcp` está en el PATH** de la máquina; si no está, declarar la ausencia y usar CodeGraph o `grep` |
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
<!-- TYCON_BLOCK:tool-names END -->
