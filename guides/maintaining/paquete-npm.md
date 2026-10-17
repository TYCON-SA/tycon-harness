# El paquete de npm: cómo sale, cómo se aprueba y cómo se retira

El paquete `@tyconsa/harness` es el instalador que corre `npx @tyconsa/harness@latest`. **No trae el arnés**: trae un
programa chico (`scripts/setup/npm/index.js`) que baja el arnés de GitHub, verificado contra el commit. Esta guía es para
quien mantiene el arnés. Para instalar, la portada.

## Cuándo sale una versión nueva

Sólo cuando cambia lo que el paquete trae (la carpeta `scripts/setup/npm/`). El paquete tiene su propia versión
(`version` de `scripts/setup/npm/package.json`, semver), que no es el número del arnés.

1. **En el pedido**, subí `version` (`1.0.2` → `1.0.3`; un cambio que rompe algo para quien ya lo usa, el número del
   medio). La CI pública lo exige: un pedido que toca la carpeta sin subirla sale rojo con «subí version».
2. **El merge a `main`** dispara el workflow `npm-publish.yml`. Publica **en etapas** (`npm stage publish`): la versión
   queda esperando, sin que nadie pueda instalarla todavía.
3. **El dueño la aprueba** con su doble verificación: en npmjs.com (el paquete → la versión en espera → aprobar) o con
   `npm stage approve <id>` desde su sesión. Nadie más puede aprobarla.
4. **Se confirma**: `npm view @tyconsa/harness dist.attestations` trae la constancia de procedencia, la pestaña
   «Provenance» de la página nombra el repo, el commit y `npm-publish.yml`, y `npm view @tyconsa/harness dist-tags`
   dice esa versión como `latest`. La suite `scripts/tests/npm-published.test.js` lo mide cada noche.

## Quién aprueba y con qué

- La cuenta de npm del dueño, con la doble verificación pedida también para escribir (`auth-and-writes`). Ninguna
  credencial de npm vive en el repo, en la CI ni en una máquina: la CI publica con **trusted publishing**, una identidad
  de la corrida que npm acepta porque el paquete declara como publicador de confianza `TYCON-SA` / `tycon-harness` /
  `npm-publish.yml`, con la acción «sólo en etapas».
- La variable de repositorio `NPM_PUBLISH_ENABLED=true` (GitHub → Settings → Secrets and variables → Actions →
  Variables) prende la publicación. Sin ella, el workflow sale en verde con un aviso de qué falta y no publica nada.

## Si la publicación falla

El workflow sale rojo nombrando la causa. Las de siempre:

| Lo que dice | Qué pasó | Qué hacer |
|---|---|---|
| «ya está publicada con otro contenido: subí version» | dos pedidos con la misma versión, o se cambió la carpeta sin subirla | un pedido que sube `version` |
| E401, E403 o un error de OIDC al publicar | el publicador de confianza no está, o no coincide con el repo, el archivo o la acción | revisarlo en npmjs.com (ver «Rotar el publicador») y repetir |
| «npm viejo o distinto» | la versión fija de npm que instala el workflow cambió | ajustar la versión en `npm-publish.yml` y en `check-public-workflow.js`, en el mismo pedido |
| «no pude preguntarle al registro» | npm caído o sin respuesta | repetir más tarde |

Para repetir una publicación que no salió: GitHub → Actions → `npm-publish` → «Run workflow» sobre `main`. Sólo corre
sobre `main`.

## Retirar una versión

- **Lo normal es deprecarla**: `npm deprecate @tyconsa/harness@<versión> "<por qué y cuál usar>"`. Se sigue pudiendo
  instalar, pero npm avisa; `@latest` apunta a la última no deprecada que se publique después.
- **Borrarla** (`npm unpublish @tyconsa/harness@<versión>`) sólo se puede en las primeras **72 horas** y si nadie
  depende de ella. Ese número de versión no se puede volver a usar nunca: la siguiente sube.
- Una versión que se publicó mal se arregla con otra versión, no reescribiéndola.

## Rotar el publicador de confianza

En npmjs.com (el paquete → Settings → Trusted publishing) el publicador **no se edita: se borra y se crea**, con los
mismos tres datos (`TYCON-SA`, `tycon-harness`, `npm-publish.yml`) y la acción «sólo en etapas». Hay que rotarlo si
cambia el nombre del repo, de la organización de GitHub o del archivo del workflow. Ojo: **un publicador que no publica
en 2 días vence**; si se crea antes de tiempo, puede que haya que crearlo de nuevo el día del merge.

## La primera versión publicada

La primera versión publicada del paquete salió a mano, antes de que existiera el workflow, y no tiene constancia de
procedencia. Todas las que vinieron después salen por el workflow.
