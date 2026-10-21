# @tyconsa/harness

El instalador del arnés TYCON, en una línea, igual en Windows, Mac y Linux:

```bash
npx @tyconsa/harness@latest
```

- **Qué hace**: baja de GitHub la versión publicada del arnés a una carpeta temporal y le pasa el trabajo al instalador
  de ese árbol (`harness.js npx`): los requisitos, para quién, el permiso del equipo y `harness.js install`. El paquete
  sólo arranca; por eso un cambio del instalador llega sin publicarlo de nuevo. El arnés **no viene en el paquete**:
  llega de GitHub y se verifica contra el árbol del commit.
- **Un solo sí**: no pregunta nada antes del plan. Instala para vos, con la instalación mínima, sin conexiones
  opcionales y sin paquete; muestra en cinco renglones lo que va a cambiar en tu máquina y espera tu
  `¿Instalo? [s/N]`. Con un «no», no queda nada. `--profile full`, `--integrations` y `--packs` lo cambian; `--team
  <repo>` te suma a un equipo y `--audience org` da de alta tu organización. El detalle completo, con `--dry-run`.
- **Sin Claude Code ni Codex**: te dice la orden para instalar cada uno en tu sistema y cómo iniciar sesión, y no baja
  nada. No instala ninguno por vos.
- **Sin terminal** (un guion, la CI): no pregunta; te da la línea para confirmar, `npx @tyconsa/harness@latest --yes`.
- **La procedencia**: este paquete lo publica la CI pública del repo, con constancia de procedencia. Se ve en la pestaña
  «Provenance» de su página en npmjs.com, o con `npm view @tyconsa/harness dist.attestations`, **desde la 1.0.2** (la
  1.0.1 se publicó a mano y no la tiene). Ojo: **npx no comprueba la firma al instalar**; se mira en la página o con
  `npm view`.
- **Con el arnés ya instalado**: no lo reinstala. Dice si está al día o, si hay una versión nueva, pregunta
  `¿Actualizo? [s/N]` y corre el `update` de la versión recién bajada.
- **Sin npm, a mano**: `scripts/setup/get-harness.sh` (o `get-harness.ps1` en Windows) del repo público: bajarlo,
  leerlo y correrlo.
- **Node**: hace falta Node 22 o posterior sólo para instalar; después el arnés usa su propio Node 24.
- **Si npm falla antes de este instalador**: una caché de npm sin permiso (`EACCES`) se arregla con
  `npm config get cache` y devolviéndote esa carpeta; sin red, con el paquete fuera de la caché, npx no puede bajarlo. Un
  `.npmrc` con `registry=` apunta a otro registro: el paquete tiene que salir de registry.npmjs.org.

Repo: https://github.com/TYCON-SA/tycon-harness · Licencia Apache-2.0.
