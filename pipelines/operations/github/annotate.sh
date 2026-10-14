#!/usr/bin/env bash
# pipelines/operations/github/annotate.sh — los avisos de los guiones del arnés, en el idioma de GitHub (story 8.31).
#
# Varios guiones de la noche escriben los avisos con la sintaxis de Azure (`##vso[task.logissue type=warning]…`), que
# GitHub no interpreta: quedarían como texto suelto en el registro. Este filtro los convierte: warning → `::warning::`,
# error → `::error::`; cualquier otra orden de Azure (`##vso[…]`) se neutraliza. Lo demás pasa igual, línea por línea.
# Uso, con pipefail para no tapar el código de salida del guion:  set -o pipefail; node guion.js 2>&1 | bash annotate.sh
exec awk '{
  if (sub(/^##vso\[task\.logissue type=warning[^]]*\]/, "::warning::")) {}
  else if (sub(/^##vso\[task\.logissue type=error[^]]*\]/, "::error::")) {}
  else if ($0 ~ /^##vso\[/) { $0 = "(azure) " $0 }
  print; fflush()
}'
