---
description: Abre en el navegador el sitio de la organización (la dirección sale del perfil del equipo; sólo abre, no cambia nada)
allowed-tools: Bash(node:*), Bash(open:*), Bash(xdg-open:*), Bash(cmd.exe:*)
---

Abrí en el navegador el sitio de la organización. **Este comando sólo abre una página: no cambia nada**, ni en la
máquina ni en el perfil.

**El programa**: `<arnés>/scripts/lib/tycon-config.js`, con `<arnés>` = `$TYCON_GUIDES_DIR` si está definida y, si no,
`~/.claude/tycon-harness` (en Windows, desde la terminal de Claude Code, que es Git Bash, `~/.claude/tycon-harness`
también sirve). Si el archivo no está, decí que el arnés no está instalado en esta máquina y pará.

## Qué corro

`node <arnés>/scripts/lib/tycon-config.js get site.url < /dev/null`, una sola vez, **mirando el código de salida**:

| Código | Qué significa |
|---|---|
| 0 | imprimió la dirección del sitio: abrila |
| 3 | el perfil del equipo no trae la dirección: decí cómo cargarla (abajo) |
| 2 | la configuración no se pudo leer, o el arnés instalado es anterior a la clave: mostrá el error tal cual y sugerí actualizar con el comando de barra tycon-harness |

La dirección vale **sólo desde el perfil del equipo**: ni una variable ni el archivo de la máquina la cambian. No la
busques en otro lado, no la adivines y no abras `~/.tycon/config.json`.

## Cómo la abro

Con la dirección que imprimió, tal cual, una sola orden según el sistema:

- Mac: `open "<dirección>"`
- Linux: `xdg-open "<dirección>"`
- Windows (Git Bash): `cmd.exe /c start "" "<dirección>"`

Si la orden falla, mostrá la dirección para que la persona la abra a mano. Al terminar, decí en una línea qué abriste.

## Sin dirección (código 3)

Decí, en llano, que la organización todavía no cargó la dirección de su sitio y que se carga de una de dos formas:

1. **Desde el sitio**, quien lo mantiene: pestaña **Configuración** → «La dirección del sitio en cada máquina» →
   «Proponer». Llega a cada máquina cuando entra el pedido al perfil del equipo.
2. **Con un pedido al repo del perfil del equipo**: en `team-profile.json`, la clave `site.url` con la dirección
   (`"site": { "url": "https://…" }`, tiene que empezar con `https://`), y en `team-layer.json`, `requires.harness`
   en la versión que la lee o una mayor.

No abras nada y no propongas un valor.
