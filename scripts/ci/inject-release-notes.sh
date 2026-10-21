#!/usr/bin/env bash
# =============================================================================
# inject-release-notes.sh — reescribe las notas dentro de un ZIP ya armado
# =============================================================================
# Por qué existe: la nota contesta "¿qué cambia respecto de lo que tenés instalado?", y esa
# pregunta sólo se puede contestar BIEN en el momento de publicar. El paquete se arma antes
# —a veces mucho antes— y en el medio el servidor pudo haber cambiado: si se genera la v68 y
# la v69 con la v67 publicada, y después se publica primero la 68, la nota de la 69 tendría
# que dejar de mencionar lo que ya trajo la 68. Por eso el paso de despliegue recalcula
# contra el servidor destino y reescribe el campo justo antes de subir.
#
# Uso: inject-release-notes.sh <archivo.zip> <notas>
# Exit: siempre 0 — un texto informativo no puede frenar un despliegue. Si algo falla, deja
#       el ZIP intacto (queda la nota que trajo del empaquetado) y avisa por stderr.
#
# 🔴 ÉSTE ES EL CANÓNICO. Vive SOLO acá: una copia por backend sería idéntica byte a byte, o sea
# que la duplicación no aportaría nada y sólo esperaría a que alguien toque una. Se mantiene junto
# con `release-notes.sh`.
# =============================================================================
set -uo pipefail

ZIP="${1:?falta el zip}"
NOTAS="${2:?faltan las notas}"

[ -f "$ZIP" ] || { echo "[inject-notes] no existe el zip: $ZIP" >&2; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "[inject-notes] falta jq; se deja la nota original" >&2; exit 0; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if ! unzip -q -o "$ZIP" plugin.json -d "$TMP" 2>/dev/null || [ ! -f "$TMP/plugin.json" ]; then
  echo "[inject-notes] el zip no tiene plugin.json en la raíz; se deja como está" >&2
  exit 0
fi

if ! jq --arg n "$NOTAS" '.releaseNotes = $n' "$TMP/plugin.json" > "$TMP/plugin.new.json" \
   || [ ! -s "$TMP/plugin.new.json" ]; then
  echo "[inject-notes] no se pudo actualizar el plugin.json; se deja la nota original" >&2
  exit 0
fi

mv "$TMP/plugin.new.json" "$TMP/plugin.json"
# El `cd "$TMP"` de abajo cambia el directorio, así que el zip hay que nombrarlo por su ruta
# ABSOLUTA. "$OLDPWD/$ZIP" sólo serviría si $ZIP viniera relativo — y el YAML lo pasa siempre
# absoluto ($(System.ArtifactsDirectory)), con lo cual concatenaría las dos rutas, el zip
# fallaría SIEMPRE y —como este script sale 0 a propósito— nadie se enteraría: todos los
# paquetes se publicarían con la nota vieja del empaquetado.
ZIP_ABS="$(cd "$(dirname "$ZIP")" && pwd)/$(basename "$ZIP")"
# `zip -j` NO: el archivo tiene que quedar en la raíz del zip, con su nombre.
if ! ( cd "$TMP" && zip -q "$ZIP_ABS" plugin.json ) 2>/dev/null; then
  echo "[inject-notes] no se pudo reescribir el zip; se deja la nota original" >&2
  # Que degrade sin frenar el deploy está bien; que degrade en SILENCIO no. El warning sale
  # en el resumen del run de Azure DevOps, así que la próxima vez se ve sin leer el log.
  echo "##vso[task.logissue type=warning]inject-release-notes: el paquete se publica con la nota del empaquetado, no con la recalculada"
  exit 0
fi

echo "[inject-notes] notas actualizadas dentro de $(basename "$ZIP")"
exit 0
