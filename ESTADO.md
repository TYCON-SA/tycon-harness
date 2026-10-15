# ESTADO — el arranque pone al día el clon de mantenimiento (pausado 2026-10-14)

## Hecho

- Rama `feat/arranque-pone-al-dia-mantenimiento` creada desde `origin/main` (bcb8b09). **Sin código todavía.**
- Lectura del terreno:
  - `paths.maintainers` está en `scripts/setup/harness/github-auth.js` (KEYS).
  - `harness.js startup` ya corre desprendido del hook (`scripts/setup/harness/detach.js`, espera hasta 20 s; en
    Windows con relevo `windowsHide`). La línea de arranque es `async: true`.
  - El aviso que llega a la conversación lo imprime el hook síncrono `scripts/hooks/branch-guard-notice.js`
    (lee `notice` de `harness-state.json`).
  - `skills/tycon-pipeline/scripts/lib/guides-heal.js` repara el clon del arnés al primer prompt (stash propio,
    `merge --ff-only`, avisa «tu copia del arnés estaba N commits atrás»). Sus reglas no sirven tal cual: acá un
    cambio rastreado sin commitear NO se aparta, frena.
- Medición de cuándo Claude lee los `@import` del CLAUDE.md (Claude Code 2.1.251, modo `-p`, Mac):
  - Hook de SessionStart que escribe el archivo importado al instante → la sesión ve lo NUEVO.
  - El mismo hook con 0,3 s, 1 s o 3 s de espera antes de escribir → la sesión ve lo VIEJO.
  - Conclusión: los `@import` se leen al arrancar, EN PARALELO con los hooks, sin esperarlos. Una bajada de fondo
    nunca llega a la sesión que la lanzó: la lee la siguiente.
  - Modo interactivo: no se pudo medir (el diálogo de confianza de carpeta no aceptó la tecla desde un pty).

## Diseño propuesto (sin implementar)

1. Pieza nueva de fondo (p. ej. `scripts/lib/maintainers-sync.js`): lee `paths.maintainers` con el lector de
   configuración (sin imprimir el archivo); si no está → nada. Si está: en `main`, `git status --porcelain
   --untracked-files=no` vacío, sin merge/rebase en curso → `git fetch origin main` (timeout ~20 s,
   `GIT_TERMINAL_PROMPT=0`, sin credenciales en línea de comandos) → si `HEAD` es ancestro de `origin/main`,
   `merge --ff-only`; si git se niega por archivos sin seguimiento, nombrarlos. Escribe el resultado en
   `<estado>/maintainers-sync.json` (avanzó N / al día / otra rama / cambios propios / divergió / sin red / sin permiso).
2. `branch-guard-notice.js` (síncrono, Node, Mac y Windows): lanza la pieza desprendida (`detached`, `windowsHide`,
   `unref`) y, si hay un resultado de la corrida anterior sin mostrar, dice UNA línea. «Sin red» no es rojo.
   Alternativa para avisar en la MISMA sesión: leer el resultado al primer prompt (on-prompt.js, como guides-heal).
3. Línea nueva en el mapa del repo privado (pedido en borrador desde `~/SourceCode/tycon-claude-guides-wt-mant`).

## Falta

- Implementar 1 y 2, las pruebas con clon de laboratorio (al día; atrás y limpio avanza; cambio propio no toca; otra
  rama no toca; divergido no toca; sin la clave nada), el freno de publicar, el PR público y public-ci verde.
- La línea del mapa en el privado (no hay worktree ni rama privada todavía).
- La 182: no encolada (sólo hace falta si se toca el arranque o el aplicador).

## Pruebas corridas

- Ninguna suite (no hay código). Sólo la medición de arriba, en carpetas descartables ya borradas.
