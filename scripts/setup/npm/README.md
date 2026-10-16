# @tycon-sa/harness

El instalador del arnés TYCON, en una línea, igual en Windows, Mac y Linux:

```bash
npx @tycon-sa/harness@latest
```

- **Qué hace**: revisa los requisitos, baja de GitHub la versión publicada del arnés a una carpeta temporal y corre su
  `harness.js install`. El arnés **no viene en el paquete**: llega de GitHub y se verifica contra el árbol del commit.
- **Pregunta antes de escribir**: muestra el plan de lo que va a cambiar en tu máquina y espera tu `¿Instalo? [s/N]`.
  Con un «no», no queda nada.
- **La procedencia**: este paquete lo publica la CI pública del repo, con constancia de procedencia. Se ve en la pestaña
  «Provenance» de su página en npmjs.com, o con `npm view @tycon-sa/harness dist.attestations`.
  Ojo: **npx no comprueba la firma al instalar**; se mira en la página o con `npm view`.
- **Sin npm, a mano**: `scripts/setup/get-harness.sh` (o `get-harness.ps1` en Windows) del repo público: bajarlo,
  leerlo y correrlo.
- **Node**: hace falta Node 20 o posterior sólo para instalar; después el arnés usa su propio Node 24.
- **Si npm falla antes de este instalador**: una caché de npm sin permiso (`EACCES`) se arregla con
  `npm config get cache` y devolviéndote esa carpeta; sin red, con el paquete fuera de la caché, npx no puede bajarlo. Un
  `.npmrc` con `registry=` apunta a otro registro: el paquete tiene que salir de registry.npmjs.org.

Repo: https://github.com/TYCON-SA/tycon-harness · Licencia Apache-2.0.
