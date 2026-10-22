#!/usr/bin/env bash
# instinct-observe.sh — reenvío a la grabadora de instintos (integrations/instincts/scripts/instinct-observe.js) para
# una registración vieja del gancho que todavía nombra este guion. El aplicador la reemplaza en su próxima corrida;
# mientras tanto, el evento pasa entero a node y el uso del nombre viejo queda anotado. Sale 0 siempre.
set -u
_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_LEGACY_SH="$_DIR/../lib/legacy-names.sh"
if [ -f "$_LEGACY_SH" ] && . "$_LEGACY_SH" 2>/dev/null && command -v _legacy_names_log >/dev/null 2>&1; then
  _legacy_names_log file scripts/hooks/instinct-observe.sh integrations/instincts/scripts/instinct-observe.js scripts/hooks/instinct-observe.sh
fi
node "$_DIR/../../integrations/instincts/scripts/instinct-observe.js" 2>/dev/null || true
exit 0
