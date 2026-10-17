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
COPY scripts/site/ scripts/site/
COPY scripts/lib/ scripts/lib/
COPY scripts/metrics/ scripts/metrics/
COPY scripts/nightly/dashboard/ scripts/nightly/dashboard/
COPY scripts/setup/harness/ scripts/setup/harness/
COPY scripts/ci/check-product-parity.js scripts/ci/legacy-options.js scripts/ci/
COPY skills/tycon-pipeline/scripts/lib/ skills/tycon-pipeline/scripts/lib/
COPY skills/tycon-pipeline/steps/step-0*.md skills/tycon-pipeline/steps/

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
