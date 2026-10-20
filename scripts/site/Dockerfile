# syntax=docker/dockerfile:1
#
# La imagen del sitio de la organización (story 2.23, AC 3; decisión 25).
#
#   docker buildx build -f scripts/site/Dockerfile -t site:local .
#
# Se arma con BuildKit (`docker buildx build`): es el que lee scripts/site/Dockerfile.dockerignore, la lista de lo que
# entra. Con el constructor clásico se ignora esa lista y la imagen traería las pruebas.
#
# Node LTS sobre Alpine con la versión FIJADA por etiqueta y por huella (sin npm, npx, yarn ni corepack), `git` adentro (el sitio clona el repo de operaciones), un usuario sin
# privilegios, y sólo lo que el sitio ejecuta: scripts/site, los lectores que usa (scripts/lib, scripts/metrics,
# scripts/nightly/dashboard, scripts/setup/harness, y de scripts/ci el lector de la paridad) y los títulos de los pasos del pipeline (los lee la vista de corridas,
# 2.27). Ningún secreto en la imagen: llegan como variables de entorno desde el almacén de cada plataforma (2.30).
# La misma orden arranca el sitio con Node solo, sin Docker: node scripts/site/server.js
#
# 🔴 Poné SITE_DATA_DIR en un VOLUMEN: `docker run -v sitio-datos:/data -e SITE_DATA_DIR=/data …`. Ahí quedan el espejo
# del buzón, el clon de operaciones y el último bueno de la configuración. Sin volumen, cada reinicio vuelve a bajar
# el buzón entero, y la pestaña Corridas dice «no medido» hasta que termina.
FROM node:24.22.0-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

# los paquetes del sistema al día (la base trae los de su fecha), git para leer los repos, y fuera lo que el sitio no
# usa: npm, npx, yarn y corepack traen sus propios módulos (tar, glob…) y con ellos sus vulnerabilidades
RUN apk upgrade --no-cache \
 && apk add --no-cache git \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

WORKDIR /app
# la versión, si está: .tycon-release.json lo escribe el workflow de la imagen con la etiqueta del merge, y el sitio lo
# lee antes que version.json (el piso). El árbol de la noche no trae ninguno de los dos; con el comodín la imagen se arma
# igual, y el sitio dice la versión como desconocida
COPY version.json* .tycon-release.json* ./
# la licencia y los créditos: el pie de cada página los abre (/licencia, /creditos)
COPY LICENSE* NOTICE* ./
COPY scripts/site/ scripts/site/
# la guía del sitio y sus capturas: la pestaña Ayuda la arma de acá, con lo que le toca a cada rol (help.js). Con el
# comodín, un árbol sin guides/ (el de la noche) arma la imagen igual, y la ayuda dice que esta versión no la trae
COPY guide[s]/organization-site.md* guides/
COPY guide[s]/organization-site.en.md* guides/
COPY guide[s]/sitio-de-la-organizacion/capturas/*.png guides/sitio-de-la-organizacion/capturas/
COPY scripts/lib/ scripts/lib/
COPY scripts/metrics/ scripts/metrics/
COPY scripts/nightly/dashboard/ scripts/nightly/dashboard/
COPY scripts/nightly/projects/state-age.js scripts/nightly/projects/
COPY scripts/setup/harness/ scripts/setup/harness/
# qué trae cada perfil de instalación: lo muestra la pestaña Configuración
COPY scripts/setup/install-effects.json scripts/setup/
COPY scripts/ci/check-product-parity.js scripts/ci/legacy-options.js scripts/ci/
# la pestaña Cómo trabaja carga el pipeline y lee lo mismo que él: la tabla y los archivos de los pasos, la lista de
# controles y el guion de cada uno (así reconoce un despachador), y las guías (así reconoce una guía citada por su
# nombre). Sin pruebas: la lista de exclusiones las saca. how-it-works.test.js frena si algo de eso no entra
COPY skills/tycon-pipeline/scripts/ skills/tycon-pipeline/scripts/
COPY skills/tycon-pipeline/steps/ skills/tycon-pipeline/steps/
COPY skills/clocki/scripts/ skills/clocki/scripts/
COPY scripts/hooks/ scripts/hooks/
COPY scripts/setup/hooks-list.json scripts/setup/
COPY guide[s]/ guides/
# los revisores del núcleo y los paquetes de revisores del árbol: la pestaña Configuración dice cuáles conoce esta
# versión y qué paquetes hay instalados. El público no trae paquetes (llegan con la capa del equipo); con el comodín la
# imagen se arma igual sin la carpeta
COPY agents* agents/
COPY packs* packs/

ENV NODE_ENV=production PORT=8080 TYCON_SKILLS_DIR=/app/skills

# /data es del usuario del sitio y es un VOLUME: un volumen con nombre nuevo montado ahí copia este dueño. Sin esto nacía
# de root, y el sitio (que corre como node) no podía clonar ni guardar su estado: se frenaba.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8080

# La vida sola (/livez): /healthz da 503 con el sitio frenado, y reiniciar no arregla operations.json.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD wget -qO- http://127.0.0.1:8080/livez >/dev/null || exit 1

CMD ["node", "scripts/site/server.js"]
