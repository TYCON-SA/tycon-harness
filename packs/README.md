# Paquetes

Un paquete es lo que una organización suma al núcleo para su stack: revisores, skills, guías y plantillas, en una
carpeta `packs/<nombre>/` con su `pack.json`. El núcleo no trae ninguno.

Los paquetes de una organización viven en el repo de su perfil y llegan a cada máquina con la capa del equipo. Se
activan con `packs.default` (`all`, `none` o una lista de nombres), desde la sección Paquetes de la pestaña
Configuración del sitio o en el perfil del equipo; un repo puede achicar la lista con `packs:` en su
`.tycon/advisors.yaml`.

Lo que un `pack.json` puede declarar (revisores con su condición, superficie y profundidad; las carpetas `skills/`,
`agents/`, `guides/` y `templates/`) está en `guides/agent-architecture.md`, sección «Paquetes de revisores».
