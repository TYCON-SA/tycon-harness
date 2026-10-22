#!/usr/bin/env bash
# guard-update-notice.test.sh — red del aviso de arranque de la actualización del freno sin contraseña.
#
# Qué cuida: el permiso de sudo de una máquina lo pone y lo saca su persona, con su contraseña; lo que elige la
# organización (guard.update, en el perfil del equipo) no lo cambia solo. Si el aviso no dijera que los dos no coinciden,
# una organización que volvió a «con la contraseña» seguiría con máquinas que se actualizan solas sin que nadie se entere.
#
#   T42 — con el permiso puesto, el aviso dice que está encendido y la última actualización (update-log.jsonl).
#   T58 — marca puesta con «password», marca ausente con «auto»: avisa con el comando exacto; coincidiendo, no pide nada.
#   T59 — con el perfil ilegible, dice que no pudo leer lo que eligió la organización.
#
# Nada acá toca /opt de verdad: raíz falsa (TYCON_PROD_ROOT) y HOME falso. El aviso nunca cambia nada: se compara la
# huella de la raíz falsa antes y después.
#
# Correr: bash scripts/tests/guard-update-notice.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AVISO="$AQUI/scripts/hooks/guard-update-notice.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
source "$AQUI/scripts/tests/lib/fake-home.sh"
fake_home_create "$TMP/casa"
fallos=0; pasaron=0
ok(){ echo "✅ guard-update-notice: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ guard-update-notice: $1"; fallos=$((fallos+1)); }
foto(){ ( cd "$1" && find . -type f -print0 | sort -z | xargs -0 shasum 2>/dev/null; find . -print | sort ) | shasum | cut -d' ' -f1; }

SYS="$TMP/sys"; PROD="$SYS/opt/tycon/production"; ARNES="$TMP/arnes"
mkdir -p "$PROD" "$ARNES"
perfil(){ case "$1" in ROTO) printf '{ roto' ;; *) printf '{ "guard": { "update": "%s" } }\n' "$1" ;; esac > "$ARNES/team-profile.json"; }
aviso(){ TYCON_PROD_ROOT="$SYS" TYCON_GUIDES_DIR="$ARNES" node "$AVISO" 2>&1; }
tiene(){ [ "$1" = -- ] && shift; grep -q -- "$1" <<< "$s"; }   # sin tubería: con pipefail, un grep que corta temprano rompe al que escribe

if [ ! -f "$AVISO" ]; then no "el aviso no existe todavía ($AVISO)"; echo "— guard-update-notice: $pasaron ok, $fallos fallos —"; exit 1; fi

# ── T58 · StartupNotice_StateVsChoice_BothDirections ──────────────────────────────────────────────────────────────────
printf '{ "at": "2026-10-22T10:00:00Z", "user": "dev" }\n' > "$PROD/auto-update.json"
perfil password; F0="$(foto "$SYS")"; s="$(aviso)"
if tiene -- 'eligió «con la contraseña»' && tiene -- "sudo bash .*install-guard.sh --remove-auto-update"; then
  ok "T58a · marca puesta y «password»: lo dice con el comando exacto para sacar el permiso"
else no "T58a · $(printf '%s' "$s" | tr '\n' ' ' | cut -c1-300)"; fi
[ "$(foto "$SYS")" = "$F0" ] && ok "T58b · el aviso no cambió nada" || no "T58b · el aviso cambió la raíz falsa"
rm -f "$PROD/auto-update.json"; perfil auto; s="$(aviso)"
if tiene -- 'eligió «solo»' && tiene -- "sudo bash .*install-guard.sh --allow-auto-update" && tiene -- "contraseña"; then
  ok "T58c · marca ausente y «auto»: lo dice con el comando exacto para instalar el permiso (pide la contraseña)"
else no "T58c · $(printf '%s' "$s" | tr '\n' ' ' | cut -c1-300)"; fi
instalador="$(printf '%s' "$s" | sed -n 's/.*sudo bash \([^ ]*install-guard.sh\).*/\1/p' | head -1)"
[ -n "$instalador" ] && [ -f "$instalador" ] && ok "T58d · la ruta del instalador del comando existe" || no "T58d · la ruta del comando («${instalador}») no existe"
perfil password; s="$(aviso)"
[ -z "$s" ] && ok "T58e · sin permiso y «con la contraseña» (lo de fábrica): no dice nada" || no "T58e · coincidiendo en lo de fábrica habló: $s"

# ── T42 · StartupNotice_ShowsAutoUpdateAndLastRun ─────────────────────────────────────────────────────────────────────
printf '{ "at": "2026-10-22T10:00:00Z", "user": "dev" }\n' > "$PROD/auto-update.json"; perfil auto
s="$(aviso)"
if tiene -- "encendida" && tiene -- "todavía no"; then ok "T42a · encendida y sin actualizaciones: lo dice"
else no "T42a · $(printf '%s' "$s" | tr '\n' ' ' | cut -c1-300)"; fi
printf '{"at":"2026-10-21T09:00:00Z","from":"aaaaaaa","to":"bbbbbbb","from_version":"2026.10.21.1","to_version":"2026.10.21.2","user":"dev"}\n{"at":"2026-10-22T09:00:00Z","from":"bbbbbbb","to":"ccccccc","from_version":"2026.10.21.2","to_version":"2026.10.22.5","user":"dev"}\n' > "$PROD/update-log.jsonl"
s="$(aviso)"
if tiene -- "el freno se actualizó solo a 2026.10.22.5" && ! tiene -- "eligió"; then ok "T42b · coincidiendo: muestra sólo la última actualización"
else no "T42b · $(printf '%s' "$s" | tr '\n' ' ' | cut -c1-300)"; fi

# ── T59 · StartupNotice_UnreadableChoice_SaysSo ───────────────────────────────────────────────────────────────────────
perfil ROTO; s="$(aviso)"
tiene -- "no pude leer lo que eligió la organización" && ok "T59 · con el perfil ilegible lo dice" || no "T59 · $(printf '%s' "$s" | tr '\n' ' ' | cut -c1-300)"

# ── lo que no tiene que hacer: hablar en una máquina sin freno, o con el aviso apagado ────────────────────────────────
rm -rf "$SYS/opt/tycon"; perfil auto; s="$(aviso)"
[ -z "$s" ] && ok "T58f · en una máquina sin el freno instalado no dice nada" || no "T58f · sin freno habló: $s"
mkdir -p "$PROD"; printf '{}\n' > "$PROD/auto-update.json"; perfil password
s="$(TYCON_GUARD_UPDATE_NOTICE=0 TYCON_PROD_ROOT="$SYS" TYCON_GUIDES_DIR="$ARNES" node "$AVISO" 2>&1)"
[ -z "$s" ] && ok "T58g · TYCON_GUARD_UPDATE_NOTICE=0 lo apaga" || no "T58g · apagado habló: $s"

echo "— guard-update-notice: $pasaron ok, $fallos fallos —"
[ "$fallos" -eq 0 ]
