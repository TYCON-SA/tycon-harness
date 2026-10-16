# syntax=docker/dockerfile:1
#
# La imagen del sitio de la organización (story 2.23, AC 3; decisión 25).
#
#   docker buildx build -f scripts/site/Dockerfile -t site:local .
#
# Se arma con BuildKit (`docker buildx build`): es el que lee scripts/site/Dockerfile.dockerignore, la lista de lo que
# entra. Con el constructor clásico se ignora esa lista y la imagen traería las pruebas.
#
# Node LTS sobre Alpine con la versión FIJADA, `git` adentro (el sitio clona el repo de operaciones), un usuario sin
# privilegios, y sólo lo que el sitio ejecuta: scripts/site, los lectores que usa (scripts/lib, scripts/metrics,
# scripts/nightly/dashboard, scripts/setup/harness, y de scripts/ci el lector de la paridad) y los títulos de los pasos del pipeline (los lee la vista de corridas,
# 2.27). Ningún secreto en la imagen: llegan como variables de entorno desde el almacén de cada plataforma (2.30).
# La misma orden arranca el sitio con Node solo, sin Docker: node scripts/site/server.js
#
# 🔴 Poné SITE_DATA_DIR en un VOLUMEN (por ejemplo `-v sitio-datos:/datos -e SITE_DATA_DIR=/datos`): ahí quedan el espejo
# del buzón, el clon de operaciones y el último bueno de la configuración. Sin volumen, cada reinicio vuelve a bajar
# el buzón entero, y la pestaña Corridas dice «no medido» hasta que termina.
FROM node:24.11.0-alpine3.22

RUN apk add --no-cache git

WORKDIR /app
COPY version.json ./
COPY scripts/site/ scripts/site/
COPY scripts/lib/ scripts/lib/
COPY scripts/metrics/ scripts/metrics/
COPY scripts/nightly/dashboard/ scripts/nightly/dashboard/
COPY scripts/setup/harness/ scripts/setup/harness/
COPY scripts/ci/check-product-parity.js scripts/ci/legacy-options.js scripts/ci/
COPY skills/tycon-pipeline/scripts/lib/ skills/tycon-pipeline/scripts/lib/
COPY skills/tycon-pipeline/steps/step-0*.md skills/tycon-pipeline/steps/

ENV NODE_ENV=production PORT=8080 TYCON_SKILLS_DIR=/app/skills

USER node
EXPOSE 8080

# La vida sola (/livez): /healthz da 503 con el sitio frenado, y reiniciar no arregla operations.json.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD wget -qO- http://127.0.0.1:8080/livez >/dev/null || exit 1

CMD ["node", "scripts/site/server.js"]
