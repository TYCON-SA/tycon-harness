# La máquina limpia del núcleo: la lista de requisitos de la portada, hecha ejecutable.
#
# Trae EXACTAMENTE lo que declara el bloque `<!-- requirements -->` de la portada pública
# (getting-started/reference.md) y nada más: `clean-machine.test.sh` (T24) comprueba que cada
# requisito responde a `command -v` y que ninguna herramienta de la lista vigilada está. No trae Claude Code, ni
# credenciales, ni el arnés: la copia entra después, en una capa que arma la prueba.
#
# La base va fijada por el digest de su ÍNDICE multi-arquitectura (linux/amd64 para la CI, linux/arm64 para la Mac del
# dev), no por el de una plataforma: con el de una sola, la otra máquina no puede bajarla.
#   Se lee con:  docker buildx imagetools inspect node:22-bookworm-slim
#   Para renovarlo: el mismo comando, y copiar el `Digest:` de arriba (el del índice), no el de un `Manifests:`.
#
# La imagen chica trae `bash` (5.2), `node` (22.x), `npm` y el usuario sin privilegios `node`
# (uid 1000); NO trae `git`, `python3`, certificados, `curl`, `wget` ni compiladores. Por eso es la chica y no la
# completa: la completa ya trae git y Python y escondería un requisito no declarado.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# Lo que la base no trae y la portada declara, instalado a la vista. `ca-certificates` no es una herramienta (no va en
# el bloque de requisitos): sin ellos git no puede clonar por https. Sale del repositorio de paquetes de Debian, que la
# portada nombra entre los servicios de los que baja la prueba.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Usuario sin privilegios y HOME vacía: quien instala desde la portada no es root ni trae un `~/.claude`.
RUN mkdir -p /home/clean /work && chown node:node /home/clean /work
ENV HOME=/home/clean
USER node
WORKDIR /work
