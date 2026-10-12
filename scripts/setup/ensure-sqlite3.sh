#!/usr/bin/env bash
# ensure-sqlite3.sh — deja el comando `sqlite3` disponible en esta máquina (Mac/Linux).
#
# ── POR QUÉ ─────────────────────────────────────────────────────────────────────────────────
# Dos de los cuatro chequeos de salud de la memoria persistente (memoria partida en varios
# nombres, y memoria que nunca se exportó) leen la base de engram por dentro, porque el dato que
# necesitan —desde QUÉ CARPETA se guardó cada recuerdo— engram no lo expone por ningún comando.
# Y para leerla hace falta el comando `sqlite3`.
#
# 🔴 Tener engram NO alcanza: engram lleva su propio SQLite COMPILADO ADENTRO
# (`modernc.org/sqlite`), así que funciona perfecto sin dejar ningún comando en el PATH.
# En macOS `sqlite3` viene con el sistema; en Windows no viene ni con el sistema ni con engram
# (que además allá se instala con `go install`). Ver `ensure-sqlite3.ps1` para ese lado.
#
# Se instala SOLO, sin preguntar, por el mismo criterio que el arnés ya aplica al actualizar
# engram (`check-engram-version.sh`): es una dependencia del arnés, no una decisión del dev.
# Si no se puede, avisa con el comando exacto — nunca falla en silencio, que es justamente el
# modo de falla que estos chequeos existen para cazar.
#
# Idempotente · fail-open (nunca rompe el arranque) · throttle de 7 días para no reintentar en
# cada sesión si el intento no prospera.
#
# Opt-outs: `TYCON_NO_SQLITE_CHECK=1` (apaga todo) · `TYCON_SQLITE_AUTO_INSTALL=0` (deja el
# aviso, saca la instalación). Override del binario: `TYCON_SQLITE_BIN`.

set -uo pipefail

[[ "${TYCON_NO_SQLITE_CHECK:-0}" == "1" ]] && exit 0

SQLITE_BIN="${TYCON_SQLITE_BIN:-sqlite3}"

# ── ¿ya está? ────────────────────────────────────────────────────────────────────────────────
if "$SQLITE_BIN" -version >/dev/null 2>&1; then
  exit 0
fi

STAMP="$HOME/.claude/.tycon-pipeline/sqlite3-install-last-try"
CADA=$((7 * 24 * 60 * 60))
ahora=$(date +%s)
if [[ -f "$STAMP" ]]; then
  ultimo=$(cat "$STAMP" 2>/dev/null || echo 0)
  # Un stamp ilegible cuenta como vencido: mejor reintentar de más que quedarse mudo por una
  # fecha rota.
  [[ "$ultimo" =~ ^[0-9]+$ ]] || ultimo=0
  if (( ahora - ultimo < CADA )); then
    exit 0
  fi
fi

aviso_manual() {
  echo "⚠️  tycon: falta el comando \`sqlite3\` y no se pudo instalar solo." >&2
  echo "    Sin él, 2 de los 4 chequeos de salud de la memoria de engram no pueden correr" >&2
  echo "    (memoria partida en varios nombres · memoria que nunca se exportó)." >&2
  echo "    Instalalo a mano:  $1" >&2
  echo "    Silenciar: TYCON_NO_SQLITE_CHECK=1" >&2
  # 🔴 Si el sello no se puede escribir, el throttle no existe: el intento y el aviso se repiten en
  # CADA arranque. Eso se dice — un aviso que reaparece sin explicación se lee como ruido y termina
  # apagado. (2026-08-25, revisión adversarial: dos corridas seguidas con HOME no escribible dieron
  # el mismo aviso y ningún sello.)
  if ! { mkdir -p "$(dirname "$STAMP")" 2>/dev/null && echo "$ahora" > "$STAMP" 2>/dev/null; }; then
    echo "    (no pude escribir $STAMP, así que este aviso va a repetirse en cada arranque)" >&2
  fi
  exit 0
}

# ── cómo instalarlo en este sistema ──────────────────────────────────────────────────────────
if command -v brew >/dev/null 2>&1; then
  CMD=(brew install sqlite)
  CMD_TXT="brew install sqlite"
elif command -v apt-get >/dev/null 2>&1; then
  CMD=(sudo apt-get install -y sqlite3)
  CMD_TXT="sudo apt-get install -y sqlite3"
elif command -v dnf >/dev/null 2>&1; then
  CMD=(sudo dnf install -y sqlite)
  CMD_TXT="sudo dnf install -y sqlite"
else
  aviso_manual "instalá el paquete 'sqlite3' con el gestor de tu distro"
fi

[[ "${TYCON_SQLITE_AUTO_INSTALL:-1}" == "0" ]] && aviso_manual "$CMD_TXT"

# 🔴 Nada de `sudo` sin que el dev lo vea. En Linux el comando lleva sudo y podría quedarse
# esperando una contraseña en un hook de arranque — eso cuelga la sesión. Se avisa y listo.
if [[ "${CMD[0]}" == "sudo" ]]; then
  aviso_manual "$CMD_TXT"
fi

echo "▸ tycon: falta \`sqlite3\` (engram trae el suyo compilado adentro, pero no deja el comando)."
echo "  Instalando con: $CMD_TXT"
if "${CMD[@]}" >/dev/null 2>&1 && "$SQLITE_BIN" -version >/dev/null 2>&1; then
  echo "  ✓ sqlite3 instalado — los chequeos de memoria ya pueden correr."
  rm -f "$STAMP" 2>/dev/null
  exit 0
fi

aviso_manual "$CMD_TXT"
