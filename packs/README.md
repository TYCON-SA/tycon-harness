# Paquetes

Un paquete es lo que una organización suma al núcleo para su stack: revisores, skills, guías y plantillas, en una
carpeta `packs/<nombre>/` con su `pack.json`. El núcleo no trae ninguno.

Los paquetes de una organización viven en el repo de su perfil y llegan a cada máquina con la capa del equipo. Se
activan con `packs.default` (`all`, `none` o una lista de nombres), desde la sección Paquetes de la pestaña
Configuración del sitio o en el perfil del equipo; un repo puede achicar la lista con `packs:` en su
`.tycon/advisors.yaml`.

Lo que un `pack.json` puede declarar (revisores con su condición, superficie y profundidad; las carpetas `skills/`,
`agents/`, `guides/` y `templates/`) está en `guides/agent-architecture.md`, sección «Paquetes de revisores».

Un paquete también puede traer reglas que el asistente tiene que tener siempre cargadas: los `.md` de
`packs/<nombre>/claude-md-blocks/`. Se escriben en las reglas del asistente de cada persona (`~/.claude/CLAUDE.md` y,
con Codex, `~/.codex/AGENTS.md`) mientras la organización activa el paquete, y se van solas cuando deja de activarlo.
El detalle, en la misma sección.
