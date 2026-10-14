# {{FORMS_REPO}}

Formularios y plugins frontend de **{{PRODUCT}} — el {{PRODUCT_DESCRIPTION}}**.

👉 **Antes de tocar este repo, leé [`CLAUDE.md`](CLAUDE.md).** Ahí está cómo se crea un formulario,
las dos cosas que hay que declarar al crearlo (y que si se olvidan fallan en silencio), la forma
de las URLs contra el backend según el entorno, y la regla de pruebas.

Cada formulario es una carpeta propia (`{{PRODUCT}}-<Nombre>/`) con su `package.json`, sus pruebas y su
`src/`. El repo nace vacío: todavía no hay ninguno.

## Arranque

```bash
npm install                                # dependencias compartidas de la raíz
cd {{PRODUCT}}-<Nombre> && npm install    # dependencias del formulario
npm test -- <patrón>                       # pruebas CON scope (nunca la suite entera al iterar)
```

Desde la raíz, los tres comandos recorren **todos** los formularios:

```bash
npm run type-check   # tsc --noEmit en cada uno — esbuild NO chequea tipos
npm test             # Jest en cada uno
npm run build        # esbuild en cada uno
```

Un formulario que **no declare** alguno de esos tres scripts hace **fallar** el comando, no se
saltea. Un formulario sin pruebas es lo que esto viene a detectar.

Un formulario nuevo se copia de `form-template/` del template público
(`bizuit-custom-form-sample`), **archivos de prueba incluidos** — ver `CLAUDE.md`.

Las historias viven en el repo `{{STORIES_REPO}}`, en `.specs/`.
