# Skills que no se cargan (`skills-inactivas/`)

Todo lo que está en `skills/` se carga en cada sesión: el nombre y la descripción de cada skill van en la lista que el
agente relee en cada respuesta, en todos los repos. Un paquete que no se usa cuesta igual. Por eso los paquetes sin uso
se mueven a la carpeta **`skills-inactivas/`**, al lado de `skills/`: no se cargan, git los ignora y no se borra nada.

## Dónde está la carpeta

En el árbol del que salen las skills instaladas, que en cualquier máquina se alcanza por la misma ruta:
**`~/.claude/agent-skills/skills-inactivas/`**, al lado de `~/.claude/agent-skills/skills/`.

Esa ruta vale en las tres formas de máquina que conviven desde que el arnés y las skills son un solo repo:

| Forma de la máquina | Qué es `~/.claude/agent-skills` |
|---|---|
| Dos clones (la de siempre) | el clon del repo viejo de skills |
| Clon re-apuntado | el mismo clon, que ahora baja del repo unificado |
| Un solo árbol (una máquina nueva) | un enlace al clon del arnés, que trae `skills/` en su raíz |

En las tres, `skills-inactivas/` queda fuera de git: la línea está en el `.gitignore` del repo.

## Qué hay ahí hoy

Los paquetes de BMAD `gds-*` (juegos, 36) y `wds-*` (diseño, 12), con 0 usos en 30 días (medido el 2026-09-19). No
están versionados: los instaló BMAD en cada máquina, así que en otra máquina pueden no existir, o estar todavía en
`skills/`.

## Volver a activar una skill

```bash
mv ~/.claude/agent-skills/skills-inactivas/<skill> ~/.claude/agent-skills/skills/
```

En una máquina con el arnés instalado por versión esa carpeta es la instalación: el agente no la puede escribir y la
próxima actualización deshace el cambio. Ahí el `mv` lo corrés vos en tu terminal, o la skill vuelve por un pedido al
repo del arnés.

Y abrir una sesión nueva. En Codex, además, correr el instalador para que cree su enlace, llamándolo por la ruta del
clon del arnés (no por el enlace `~/.claude/tycon-harness`: llamarlo por el enlace registra los hooks por
segunda vez):

```bash
TYCON_CODEX=1 bash <clon del arnés>/scripts/install-tycon-hooks.sh
```

## Desactivar otra

El `mv` al revés. En Codex, el instalador limpia solo el enlace que quedó sin destino.

🔴 Reinstalar un módulo de BMAD puede volver a poner sus skills en `skills/`: mirar la carpeta después.
