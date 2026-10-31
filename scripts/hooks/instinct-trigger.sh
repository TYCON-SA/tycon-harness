#!/usr/bin/env bash
# instinct-trigger.sh — SessionStart hook que ya no dispara el observador de instintos.
#
# Las propuestas de aprendizajes ya no se arman en cada máquina: las arma la noche de la organización
# (scripts/instincts/instinct-nightly.js, pipelines/operations/instinct-proposals.yml) con lo que suben las máquinas, y se
# deciden en la pestaña Aprendizajes del sitio. Este hook no lanza `instinct-observer.js` en ninguna máquina, con
# TYCON_INSTINCT_OBSERVER prendida o no: el observador queda como biblioteca de la noche y como herramienta manual.
#
# Sigue registrado por la reparación de la línea de arranque de abajo, que tiene que correr igual.


# ── Reparación de la línea de arranque del arnés ────────────────────────────────────
# Este hook es uno de los POCOS que una instalación vieja del arnés sí tiene registrados, y su
# código sí se actualiza con el `git pull` que esas máquinas sí hacen. Por eso entra por acá el
# reparador: el arreglo de "tu línea de arranque no llama al instalador" no puede viajar por el
# instalador que no se llama. Sale en silencio y en un grep si ya está sano.
# Off: TYCON_NO_BOOTSTRAP_HEAL=1
_heal="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
for _c in "$_heal/hooks/harness-bootstrap-heal.sh" "$_heal/harness-bootstrap-heal.sh"; do
  [ -f "$_c" ] && { bash "$_c" || true; break; }
done
unset _heal _c

exit 0
