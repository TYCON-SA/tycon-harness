#!/usr/bin/env bash
#
# check-engram-version.sh — mantiene a todo el equipo en la MISMA versión de engram:
# la que está anotada en el archivo `engram-version` de este repo.
#
# Por qué importa que sea la misma: las memorias (`.engram/`) se comparten por git. Si
# una máquina corre una versión que escribe otro formato, el resto no las puede leer —
# y no da error, simplemente no aparecen. Por eso lo que se busca no es "todos en la
# última" sino "todos en la misma", cambiando cuando alguien lo decide.
#
# Tres comportamientos:
#
#   A · ATRASADO (tu versión < la del equipo) — **la actualiza sola** (ver precondiciones
#       más abajo). Ojo con la diferencia: NO actualiza "a la última", actualiza a la que
#       el equipo eligió. Saltar a la última cuando a cada uno se le ocurre es lo que
#       genera versiones distintas conviviendo; converger a un número que decidió una
#       persona es lo contrario. El juicio ("¿la 1.20 sirve?") queda en el commit del
#       número; la convergencia es mecánica.
#
#   B · ADELANTADO (tu versión > la del equipo) — avisa, **nunca hace downgrade**. Bajar
#       de versión puede romper memoria ya escrita, y el que está adelantado suele ser
#       justamente quien está validando la versión nueva a propósito.
#
#   C · HAY UNA MÁS NUEVA que la del equipo — avisa como mucho 1 vez cada 7 días. Es
#       informativo: alguien tiene que probarla y decidir. Sin ese límite sale en cada
#       arranque de sesión y se vuelve ruido que se ignora, que es como mueren los avisos.
#
# 🔴 El comando de update lleva `--cask`. El que imprime el propio engram
# (`brew upgrade engram`) resuelve a la FÓRMULA, que es otro paquete y suele estar sin
# instalar — no hace lo que parece. El binario se distribuye como CASK.
#
# Fail-open total: cualquier problema → exit 0 en silencio. Nunca rompe una sesión.
# Opt-outs: `TYCON_NO_ENGRAM_VERSION_CHECK=1` (apaga todo) ·
#           `TYCON_ENGRAM_AUTO_UPGRADE=0` (deja el aviso, saca el update automático).
#
# Uso:
#   ./check-engram-version.sh          # chequeo normal (respeta el throttle)
#   ./check-engram-version.sh --check  # fuerza ambos avisos, ignora el throttle

set -uo pipefail

[[ "${TYCON_NO_ENGRAM_VERSION_CHECK:-0}" == "1" ]] && exit 0

FORCE=0
[[ "${1:-}" == "--check" ]] && FORCE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIN_FILE="$SCRIPT_DIR/../../engram-version"

[[ -f "$PIN_FILE" ]] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# engram ausente: normalmente no hay nada que decir (no todos lo tienen instalado).
# EXCEPCIÓN: si una migración automática quedó a medias, engram NO está justamente porque
# este script lo desinstaló. Salir en silencio ahí dejaría al dev sin memoria y sin
# enterarse — el peor final posible. Se avisa en CADA arranque hasta que lo resuelva.
if ! command -v engram >/dev/null 2>&1; then
  if [[ -f "$HOME/.claude/.tycon-engram-upgrade-failed" ]] \
     && [[ "$(cat "$HOME/.claude/.tycon-engram-upgrade-failed" 2>/dev/null)" == "migracion" ]]; then
    echo "🛑 tycon: NO TENÉS ENGRAM — una migración automática quedó a medias y tu memoria"
    echo "   no se está guardando. Corré esto para recuperarlo:"
    echo "       brew install gentleman-programming/tap/engram"
    echo "   (cuando ande, este aviso desaparece solo)"
  fi
  exit 0
fi

# stdout trae `engram X.Y.Z`; stderr trae el aviso `Update available: A -> B`.
# Se capturan por separado a propósito: mezclarlos hace ambiguo cuál número es cuál.
LOCAL_RAW="$(engram version 2>/dev/null || true)"
UPSTREAM_RAW="$(engram version 2>&1 >/dev/null || true)"

STAMP="$HOME/.claude/.tycon-engram-upstream-notice"
SENTINEL="$(mktemp -t tycon-engram-upgrade 2>/dev/null || echo "/tmp/tycon-engram-upgrade.$$")"
rm -f "$SENTINEL"
trap 'rm -f "$SENTINEL"' EXIT

python3 - "$PIN_FILE" "$LOCAL_RAW" "$UPSTREAM_RAW" "$STAMP" "$FORCE" "$SENTINEL" <<'PYEOF'
import sys, os, re, time

pin_file, local_raw, upstream_raw, stamp, force, sentinel = sys.argv[1:7]
force = force == "1"

def parse_semver(text):
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in m.groups()) if m else None

def fmt(t):
    return ".".join(str(x) for x in t)

try:
    pin = None
    with open(pin_file, encoding="utf-8") as fh:
        for line in fh:
            line = line.split("#", 1)[0].strip()
            if line:
                pin = parse_semver(line)
                break
    if not pin:
        sys.exit(0)

    local = parse_semver(local_raw)
    if not local:
        sys.exit(0)

    # --- A · DRIFT: tu binario no es el que validó el equipo ---
    if local != pin:
        if local < pin:
            # ATRASADO → el sentinel le pide a bash que intente el upgrade automático.
            # NO se imprime el comando acá: lo imprime bash sólo si el auto-upgrade no
            # se pudo hacer, para no decirle al dev que corra algo que ya va a correr solo.
            try:
                with open(sentinel, "w") as fh:
                    fh.write(fmt(pin))
            except OSError:
                pass
            print("⚠ tycon: engram %s — el equipo usa la %s (con una versión distinta "
                  "podés no ver memorias que escribió el resto)." % (fmt(local), fmt(pin)))
        else:
            print("⚠ tycon: tenés engram %s, más nueva que la del equipo (%s). Las "
                  "memorias que guardes pueden no verse en las máquinas del resto."
                  % (fmt(local), fmt(pin)))
            print("   Si la %s anda bien, poné ese número en el archivo `engram-version` "
                  "del arnés y commiteá: el resto se actualiza solo."
                  % fmt(local))

    # --- B · UPSTREAM: hay release más nuevo que el pin (throttled) ---
    m = re.search(r"Update available:\s*\S+\s*->\s*(\d+\.\d+\.\d+)", upstream_raw or "")
    if not m:
        sys.exit(0)
    upstream = parse_semver(m.group(1))
    if not upstream or upstream <= pin:
        sys.exit(0)

    if not force:
        try:
            if time.time() - os.path.getmtime(stamp) < 7 * 24 * 3600:
                sys.exit(0)
        except OSError:
            pass

    print("ℹ tycon: salió engram %s. El equipo sigue en la %s, nadie la probó todavía."
          % (fmt(upstream), fmt(pin)))
    print("   Si la probás unos días y la memoria sigue andando, poné ese número en el "
          "archivo `engram-version` del arnés: el resto se actualiza solo.")

    if not force:
        try:
            os.makedirs(os.path.dirname(stamp), exist_ok=True)
            with open(stamp, "w") as fh:
                fh.write(fmt(upstream))
        except OSError:
            pass

except Exception:
    # Fail-open: nunca romper el arranque de una sesión por un chequeo informativo.
    sys.exit(0)
PYEOF

# ============================================================
# Auto-alineación a la versión del equipo (decisión del dev 2026-07-25).
#
# SOLO corre si tu versión es MENOR que la del equipo. Nunca "actualiza a la última":
# actualiza a la que el equipo eligió. Esa diferencia es todo el punto — saltar a la
# última cuando a cada uno se le ocurre genera versiones distintas conviviendo, que es
# el problema; converger a un número que decidió una persona lo elimina.
#
# NUNCA hace downgrade. Si estás ADELANTADO, se avisa y listo: bajar de versión puede
# romperte memoria que ya escribiste, y además el que está adelantado suele ser el que
# está validando la versión nueva a propósito.
#
# Precondiciones — si falla cualquiera, cae al aviso manual (no rompe nada):
#   - `TYCON_ENGRAM_AUTO_UPGRADE` != 0 (default: ON)
#   - Homebrew presente Y engram instalado COMO CASK. Si el dev lo instaló de otra forma
#     (binario suelto, scoop, otro gestor), `brew upgrade` haría algo distinto de lo
#     esperado o nada — mejor decirle y que decida.
#
# Es lento (`brew update` refresca todos los taps, medido en >120s), pero corre sólo
# cuando hay diferencia de versión, o sea casi nunca. En el caso normal ni se entra acá.
# ============================================================
[[ -f "$SENTINEL" ]] || exit 0

TARGET="$(cat "$SENTINEL" 2>/dev/null || true)"
GOPKG="github.com/Gentleman-Programming/engram/cmd/engram"
FAILED_STAMP="$HOME/.claude/.tycon-engram-upgrade-failed"

# Método de instalación → cómo se actualiza. Se elige por lo que HAY en la máquina, no
# por el sistema operativo: un dev de Mac puede haberlo puesto con `go install` igual.
#
# `go install ...@vX.Y.Z` instala la versión EXACTA. `brew upgrade --cask` instala la
# ÚLTIMA que tenga el cask, que puede no ser la del equipo (ver la advertencia de
# sobre-disparo abajo). Por eso, si hay Go, se prefiere Go.
if command -v go >/dev/null 2>&1 && go env GOPATH >/dev/null 2>&1 \
   && [[ "$(command -v engram)" == "$(go env GOPATH)/bin/engram" ]]; then
  METHOD="go"
  CMD="go install $GOPKG@v$TARGET"
elif command -v brew >/dev/null 2>&1 && brew list --formula engram >/dev/null 2>&1; then
  # FÓRMULA — es el paquete VIVO. Upstream mantiene `Formula/engram.rb` (v1.20.0 al
  # 2026-07-25) y ABANDONÓ `Casks/engram.rb`, que quedó clavado en v1.0.0 desde hace
  # meses. Instalar/actualizar por fórmula es el camino correcto en Mac/Linux, y es el
  # que ya dice el onboarding (`brew install gentleman-programming/tap/engram`).
  METHOD="brew"
  CMD="brew update && brew upgrade gentleman-programming/tap/engram"
elif command -v brew >/dev/null 2>&1 && brew list --cask engram >/dev/null 2>&1; then
  # CASK LEGACY — instalaciones viejas (el equipo las tiene desde antes de la migración).
  # `brew upgrade --cask` NUNCA va a pasar de 1.0.0 porque el cask está abandonado: no
  # es que falle, es que no tiene a dónde ir. Hay que MIGRAR a la fórmula, y eso implica
  # desinstalar — no lo hace un script solo al arrancar la sesión, se le pide al dev.
  METHOD="cask-legacy"
  CMD="brew uninstall --cask engram && brew install gentleman-programming/tap/engram"
else
  METHOD="unknown"
  CMD="go install $GOPKG@v$TARGET"
fi

fallback_manual() {
  echo "   Actualizá cuando puedas: $CMD"
  [[ "$METHOD" == "unknown" ]] && \
    echo "   (o bajá el binario: https://github.com/Gentleman-Programming/engram/releases)"
  exit 0
}

[[ "${TYCON_ENGRAM_AUTO_UPGRADE:-1}" == "0" ]] && fallback_manual
[[ "$METHOD" == "unknown" ]] && fallback_manual

# ------------------------------------------------------------
# Migración automática cask (abandonado) → fórmula (viva).
#
# Es la única rama que DESINSTALA algo. El riesgo real no es que falle el `brew install`:
# es quedar con el desinstalar hecho y el instalar no, o sea el dev SIN engram — y sin
# engram la memoria deja de guardarse sin avisar, que es la clase de falla silenciosa que
# todo esto existe para evitar.
#
# Por eso el orden importa: primero se verifica que la fórmula esté disponible (con la red
# y el tap que hay AHORA), y recién después se desinstala. Si el pre-chequeo falla, no se
# toca nada. Si aun así queda a medias, el mensaje es RUIDOSO y con el comando exacto de
# recuperación — nunca se sale en silencio de un estado roto.
# ------------------------------------------------------------
if [[ "$METHOD" == "cask-legacy" ]]; then
  if [[ -f "$FAILED_STAMP" && "$(cat "$FAILED_STAMP" 2>/dev/null)" == "migracion" ]]; then
    echo "   La migración automática ya falló una vez. Hacela a mano:"
    echo "       $CMD"
    exit 0
  fi

  echo "   Tu engram viene del paquete viejo de Homebrew, abandonado en la 1.0.0: no puede"
  echo "   actualizarse nunca. Migrando al que sí se mantiene…"

  brew update >/dev/null 2>&1

  # PRE-CHEQUEO antes de tocar nada: ¿la fórmula existe y es instalable ahora mismo?
  if ! brew info --formula gentleman-programming/tap/engram >/dev/null 2>&1; then
    echo "   ⚠ No pude verificar el paquete nuevo (¿sin red?). NO toqué nada — seguís como estabas."
    echo "   Probá a mano más tarde: $CMD"
    exit 0
  fi

  brew uninstall --cask engram >/dev/null 2>&1
  INSTALL_OUT="$(brew install gentleman-programming/tap/engram 2>&1)"
  NEW="$(engram version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"

  if [[ -n "$NEW" ]]; then
    rm -f "$FAILED_STAMP"
    if [[ "$NEW" == "$TARGET" ]]; then
      echo "   ✓ Listo: engram $NEW (migrado al paquete nuevo)"
    else
      echo "   ✓ Migrado, pero quedó en la $NEW y el equipo usa la $TARGET."
      echo "   Corré: brew upgrade gentleman-programming/tap/engram"
    fi
    exit 0
  fi

  # Estado roto: el desinstalar salió y el instalar no. Ruidoso, con recuperación exacta.
  mkdir -p "$(dirname "$FAILED_STAMP")" 2>/dev/null
  echo "migracion" > "$FAILED_STAMP" 2>/dev/null
  echo "   🛑 QUEDASTE SIN ENGRAM — el paquete viejo se desinstaló y el nuevo no instaló."
  echo "   Tu memoria NO se está guardando hasta que corras esto:"
  echo "       brew install gentleman-programming/tap/engram"
  echo "   Error de Homebrew: $(echo "$INSTALL_OUT" | grep -iE 'error|fatal' | head -1)"
  exit 0
fi

# Anti-loop: si ya se intentó alinear a ESTA misma versión y quedó en otra, no se
# reintenta en cada arranque de sesión. Un upgrade que "funciona" pero deja una versión
# distinta a la pedida (p.ej. el cask sobre-dispara a la última) reintentaría para
# siempre, corriendo un `brew update` de minutos en cada sesión y sin llegar nunca.
if [[ -f "$FAILED_STAMP" && "$(cat "$FAILED_STAMP" 2>/dev/null)" == "$TARGET" ]]; then
  fallback_manual
fi

echo "   Actualizando sola a la $TARGET (puede tardar un par de minutos)…"

UPGRADE_OK=0
UNTRUSTED_TAP=0
if [[ "$METHOD" == "go" ]]; then
  GOFLAGS='' go install "$GOPKG@v$TARGET" >/dev/null 2>&1 && UPGRADE_OK=1
else
  brew update >/dev/null 2>&1
  # Homebrew moderno se NIEGA a cargar casks de taps de terceros hasta que el usuario
  # los marca como confiables (`brew trust`). engram vive en gentleman-programming/tap,
  # así que esto le pasa a TODA máquina de Mac del equipo la primera vez. No lo podemos
  # resolver solos: marcar un tap como confiable es una decisión de seguridad del dueño
  # de la máquina, no de un script que corre al arrancar la sesión. Se detecta y se pide.
  BREW_OUT="$(brew upgrade gentleman-programming/tap/engram 2>&1)" && UPGRADE_OK=1
  if [[ "$UPGRADE_OK" != "1" ]] && grep -qi "untrusted tap\|brew trust" <<< "$BREW_OUT"; then
    UNTRUSTED_TAP=1
  fi
fi

NEW="$(engram version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"

if [[ "$UPGRADE_OK" == "1" && "$NEW" == "$TARGET" ]]; then
  rm -f "$FAILED_STAMP"
  echo "   ✓ Listo: engram $NEW"
  exit 0
fi

mkdir -p "$(dirname "$FAILED_STAMP")" 2>/dev/null
echo "$TARGET" > "$FAILED_STAMP" 2>/dev/null

if [[ "$UNTRUSTED_TAP" == "1" ]]; then
  # Caso esperado la PRIMERA vez en cada Mac. No es un error del harness ni de engram.
  echo "   ⚠ Homebrew no instala desde el repo de engram hasta que lo autorices (es de terceros)."
  echo "   Corré esto UNA vez y listo — es el mismo repo del que ya lo tenías instalado:"
  echo "       brew trust gentleman-programming/tap && brew upgrade --cask engram"
  echo "   Después se actualiza sola de nuevo."
  exit 0
elif [[ "$UPGRADE_OK" != "1" ]]; then
  echo "   ⚠ No se pudo actualizar sola."
elif [[ "$METHOD" == "brew" ]]; then
  # Sobre-disparo: `brew upgrade --cask` no sabe de la versión del equipo, instala la
  # última del cask. Si el equipo eligió a propósito una versión ANTERIOR a la última,
  # este camino no puede acertarle. Con Go sí (`@vX.Y.Z` es exacto).
  echo "   ⚠ Homebrew instaló la ${NEW:-desconocida}, no la $TARGET (brew siempre pone la última)."
  echo "   Para la versión exacta: go install $GOPKG@v$TARGET"
else
  echo "   ⚠ Quedó en la ${NEW:-desconocida}, no en la $TARGET."
fi
echo "   No lo reintento solo hasta que la versión del equipo cambie."
exit 0

exit 0
