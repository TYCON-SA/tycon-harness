#!/usr/bin/env bash
# installer-repeated-hooks.test.sh — el aplicador REAL de Mac/Linux (`install-tycon-hooks.sh`) en dos lugares donde
# podía juzgar por cómo está escrita una ruta y no por lo que hay en el disco. El gemelo de Windows se mide en installer-ps1.test.sh, secciones (j) y (k).
#
# CASE · «el mismo hook por otra ruta» tiene que igualar mayúsculas
#   El caso: en un disco que no distingue mayúsculas (el de una Mac, el de Windows) se llama al aplicador por la misma
#   carpeta escrita con otra caja (`…/src/harness` por `…/Src/harness`). Si comparara la ruta real letra por letra
#   (`os.path.realpath` resuelve enlaces, no la caja), `--check` diría «27 hooks faltan» sin que faltara ninguno, y sin
#   `--check` quedarían hooks registrados dos veces. No se curaría solo y doctor no lo vería.
#   Lo que no se puede perder:
#     · llamado por la misma carpeta en otra caja, en los dos órdenes: ningún hook dos veces, `--check` no inventa
#       faltantes y settings.json queda byte a byte;
#     · un interruptor apagado por una ruta saca el hook que registró la otra, y al volver entra en su lugar;
#     · un hook cuyo archivo ya no está en el disco se reconoce por su ruta, con la caja igualada sólo porque este
#       disco no la distingue;
#     · el espejo: otro archivo con el mismo nombre en otra carpeta es OTRO hook (ni se toma por el del arnés ni se saca).
#   En un disco que SÍ distingue mayúsculas la otra ruta no existe: NO MEDIDO (ni verde ni rojo).
#
# HOOKSPATH · el `core.hooksPath` local no es vestigial sólo porque su carpeta no está en el disco
#   El caso: un clon viejo de agent-skills con `core.hooksPath = .githooks` (el repo sigue esa carpeta, con un hook de
#   verdad). Re-apuntado al repo unido, la vista reducida esconde `.githooks/`. Si el lazo del aplicador mirara sólo el
#   disco, `find` fallaría sobre la carpeta que no está y, con `set -e`, el aplicador MORIRÍA sin una línea (salida 1:
#   `harness.js update` no podría aplicar ninguna versión mientras durara); en Windows la daría por vestigial y borraría la
#   clave, y la vuelta no la repondría.
#   Lo que no se puede perder:
#     · con la carpeta escondida por la vista reducida el aplicador sale 0, dice que NO es vestigial y por qué, y no
#       toca `.git/config` (tampoco con `--check`);
#     · una carpeta que está y no se puede leer es «no pude mirar», no «vestigial»: tampoco se toca;
#     · el espejo: lo vestigial de verdad (sólo `*.sample`, o una carpeta que no existe y que el repo no sigue) se sigue
#       destapando, y con `--check` sólo se avisa.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh, la máquina del equipo con el árbol de trabajo del repo bajo prueba
# (`real`) y HOME de juguete. El aplicador corre aislado (`harness_lab_isolated`): nada sale a la red. Nunca ~/.claude.
# 🔴 Sin pipes sobre el comando medido: el código de salida REAL es parte del veredicto.
# Uso: bash scripts/tests/installer-repeated-hooks.test.sh [--only CASE|HOOKSPATH]   (~2 min: cada corrida del aplicador, 5 a 10 s)
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
ONLY=""
[ "${1:-}" = "--only" ] && ONLY="${2:-}"
case "$ONLY" in ""|CASE|HOOKSPATH) ;; *) echo "❌ installer-repeated-hooks: --only CASE|HOOKSPATH («${ONLY}» no existe)"; exit 2 ;; esac
runs() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FAILURES=0; NOT_MEASURED=0
ok()  { echo "  ok   — $1"; }
bad() { echo "  MAL  — $1"; FAILURES=$((FAILURES+1)); }
not_measured() { echo "  ⏭ NO MEDIDO — $1"; NOT_MEASURED=$((NOT_MEASURED+1)); }
command -v python3 >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && command -v git >/dev/null 2>&1 \
  || { echo "⏭ installer-repeated-hooks: NO MEDIDO — faltan python3, node o git en esta máquina"; exit 0; }
BASE="$(mktemp -d)" && BASE="$(cd "$BASE" && pwd -P)" || { echo "❌ installer-repeated-hooks: no pude crear la carpeta temporal"; exit 1; }
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" installer-repeated-hooks || exit 1
trap 'chmod -R u+rwx "$BASE" 2>/dev/null; rm -rf "$BASE"' EXIT

# el aplicador real, llamado por ESA carpeta del árbol (la del clon, o la misma escrita con otra caja)
applier_by() { local root="$1"; shift; harness_lab_isolated bash "$root/scripts/install-tycon-hooks.sh" "$@"; }

# census.py <settings.json> <total|repeated|order|naming <texto>>
#   total     cuántos hooks hay
#   repeated  cuántos están de más: mismo evento, mismo matcher (en cualquier orden) y el MISMO archivo por dispositivo e inodo
#   order     «evento|matcher|archivo», uno por línea y en el orden del archivo (sin la carpeta: por dónde se llegó no cuenta)
#   naming    cuántos comandos traen ese texto
cat > "$BASE/census.py" <<'PY'
import collections, json, os, re, sys
path, mode = sys.argv[1], sys.argv[2]
s = json.load(open(path, encoding="utf-8"))
total = 0; seen = collections.Counter(); order = []; naming = 0
for ev, bucket in (s.get("hooks") or {}).items():
    for entry in bucket:
        matcher = "|".join(sorted(t.strip() for t in (entry.get("matcher") or "").split("|") if t.strip()))
        for h in entry.get("hooks", []):
            cmd = h.get("command", ""); total += 1
            q = re.search(r'"(/[^"]+)"', cmd)
            if q and os.path.exists(q.group(1)):
                st = os.stat(q.group(1)); seen[(ev, matcher, st.st_dev, st.st_ino)] += 1
            else:
                seen[(ev, matcher, cmd)] += 1
            order.append("%s|%s|%s" % (ev, matcher, os.path.basename(q.group(1)) if q else cmd))
            if mode == "naming" and sys.argv[3] in cmd:
                naming += 1
if mode == "total": print(total)
elif mode == "repeated": print(sum(v - 1 for v in seen.values() if v > 1))
elif mode == "order": print("\n".join(order))
elif mode == "naming": print(naming)
else: sys.exit(2)
PY
census() { python3 "$BASE/census.py" "$TYCON_SETTINGS_PATH" "$@"; }
# add_hook.py <settings.json> <evento> <matcher o vacío> <comando>: un hook más, en un bloque propio al final de su evento
cat > "$BASE/add_hook.py" <<'PY'
import json, sys
path, ev, matcher, cmd = sys.argv[1:5]
s = json.load(open(path, encoding="utf-8"))
entry = {"hooks": [{"type": "command", "command": cmd}]}
if matcher: entry["matcher"] = matcher
s.setdefault("hooks", {}).setdefault(ev, []).append(entry)
json.dump(s, open(path, "w", encoding="utf-8"), indent=2, ensure_ascii=False); open(path, "a").write("\n")
PY
add_hook() { python3 "$BASE/add_hook.py" "$TYCON_SETTINGS_PATH" "$@"; }

# ═══ CASE · la misma carpeta escrita con otras mayúsculas ════════════════════════════════════════════════════
if runs CASE; then
  if ! harness_lab_team_machine "$BASE/case" real >/dev/null; then bad "CASE no pude armar la máquina del equipo de laboratorio"; else
  case "$HOME" in "$BASE"/*) ;; *) echo "❌ installer-repeated-hooks: la HOME no es la de juguete (${HOME})"; exit 1 ;; esac
  # la misma carpeta del clon, con la carpeta madre en mayúsculas: …/CLONES/harness
  OTHER="$(dirname "$(dirname "$LAB_TREE")")/$(basename "$(dirname "$LAB_TREE")" | tr '[:lower:]' '[:upper:]')/$(basename "$LAB_TREE")"
  applier_by "$LAB_TREE" >/dev/null 2>&1   # lo que haya que decir una sola vez se dice acá
  OUT="$(applier_by "$LAB_TREE" 2>&1)"; RC=$?
  N="$(census total)"
  [ "$RC" = 0 ] && [ "${N:-0}" -ge 20 ] && [ "$(census repeated)" = 0 ] && [ "$(census naming "\"$LAB_TREE/scripts/hooks/")" -ge 15 ] \
    && ok "CASE la vara: instalado por la carpeta del clon, $N hooks, ninguno repetido, $(census naming "\"$LAB_TREE/scripts/hooks/") con la ruta del árbol" \
    || bad "CASE la vara (rc $RC): ${N:-?} hooks, $(census repeated) repetidos: $(printf '%s\n' "$OUT" | tail -3 | cut -c1-300)"
  if [ "$OTHER" = "$LAB_TREE" ] || ! [ "$OTHER/scripts/install-tycon-hooks.sh" -ef "$LAB_TREE/scripts/install-tycon-hooks.sh" ]; then
    not_measured "CASE: este disco distingue mayúsculas (${OTHER} no es ${LAB_TREE}); la misma carpeta en otra caja no existe acá"
  else
  cp "$TYCON_SETTINGS_PATH" "$BASE/case-before.json"; ORDER_BEFORE="$(census order)"
  OUT="$(applier_by "$OTHER" --check 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(printf '%s\n' "$OUT" | grep -c 'hooks faltan')" = 0 ] && cmp -s "$BASE/case-before.json" "$TYCON_SETTINGS_PATH" \
    && ok "CASE por la misma carpeta en otra caja, con --check: no dice que falte ningún hook, y no escribe" \
    || bad "CASE --check por la otra caja (rc $RC): $(printf '%s\n' "$OUT" | grep -m1 'hooks faltan' | cut -c1-200)"
  OUT="$(applier_by "$OTHER" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(census total)" = "$N" ] && [ "$(census repeated)" = 0 ] && cmp -s "$BASE/case-before.json" "$TYCON_SETTINGS_PATH" \
    && ok "CASE por la misma carpeta en otra caja: sale 0, siguen los $N hooks, ninguno dos veces, y settings.json queda byte a byte" \
    || bad "CASE por la otra caja (rc $RC): $(census total) hooks (eran ${N}), $(census repeated) registrados dos veces: $(printf '%s\n' "$OUT" | grep -m1 'instalé' | cut -c1-200)"
  cp "$BASE/case-before.json" "$TYCON_SETTINGS_PATH"

  # un interruptor apagado por una ruta saca el hook que registró la otra; al prenderlo vuelve UNA vez y en su lugar
  TYCON_SAFETY_GUARD=0 applier_by "$OTHER" >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(census naming '/safety-guard-pre.sh"')" = 0 ] && [ "$(census total)" = "$((N - 1))" ] \
    && ok "CASE el interruptor apagado por la otra caja saca el hook que había registrado la carpeta del clon" \
    || bad "CASE el interruptor por la otra caja (rc $RC): safety-guard-pre.sh sigue $(census naming '/safety-guard-pre.sh"') vez/veces, $(census total) hooks"
  applier_by "$OTHER" >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(census naming '/safety-guard-pre.sh"')" = 1 ] && [ "$(census total)" = "$N" ] && [ "$(census repeated)" = 0 ] && [ "$(census order)" = "$ORDER_BEFORE" ] \
    && ok "CASE …y prendido de nuevo por la otra caja vuelve una vez, en su lugar de siempre (reconoce como del arnés los que registró la otra ruta)" \
    || bad "CASE el hook que vuelve (rc $RC): $(census naming '/safety-guard-pre.sh"') vez/veces, $(census total) hooks, $(census repeated) repetidos; orden: $(diff <(printf '%s\n' "$ORDER_BEFORE") <(census order) | head -4 | tr '\n' ' ')"
  cp "$BASE/case-before.json" "$TYCON_SETTINGS_PATH"

  # un hook apagado (el freno de dos sesiones nace apagado) que quedó registrado por la otra caja: se saca igual
  add_hook PreToolUse Bash "node \"$OTHER/scripts/hooks/session-collision-guard.js\""
  [ -f "$LAB_TREE/scripts/hooks/session-collision-guard.js" ] && [ "$(census naming '/session-collision-guard.js"')" = 1 ] || bad "CASE no pude sembrar el hook apagado por la otra caja"
  applier_by "$LAB_TREE" >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(census naming '/session-collision-guard.js"')" = 0 ] && [ "$(census total)" = "$N" ] \
    && ok "CASE un hook apagado que estaba registrado por la otra caja se saca (el archivo está: se compara qué archivo es)" \
    || bad "CASE el hook apagado por la otra caja (rc $RC) sigue $(census naming '/session-collision-guard.js"') vez/veces"
  cp "$BASE/case-before.json" "$TYCON_SETTINGS_PATH"
  # …y uno cuyo archivo ya NO está en el disco (sin archivo no hay identidad: vale la ruta, con la caja que diga el disco)
  add_hook SessionStart "" "bash \"$OTHER/scripts/hooks/telegram-zombie-sweep.sh\""
  mv "$LAB_TREE/scripts/hooks/telegram-zombie-sweep.sh" "$BASE/case-zombie-sweep.sh" || bad "CASE no pude sacar del árbol el archivo del hook apagado"
  applier_by "$LAB_TREE" >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(census naming '/telegram-zombie-sweep.sh"')" = 0 ] && [ "$(census total)" = "$N" ] \
    && ok "CASE un hook apagado cuyo archivo ya no está, registrado por la otra caja, se saca (por la ruta: este disco no distingue la caja)" \
    || bad "CASE el hook apagado sin archivo (rc $RC) sigue $(census naming '/telegram-zombie-sweep.sh"') vez/veces"
  mv "$BASE/case-zombie-sweep.sh" "$LAB_TREE/scripts/hooks/telegram-zombie-sweep.sh"
  cp "$BASE/case-before.json" "$TYCON_SETTINGS_PATH"

  # (espejo) otro archivo con el mismo nombre en otra carpeta es OTRO hook: no se toma por el del arnés, ni se saca con él
  mkdir -p "$LAB/elsewhere/scripts/hooks" && cp "$LAB_TREE/scripts/hooks/test-scope-guard-pre.sh" "$LAB/elsewhere/scripts/hooks/test-scope-guard-pre.sh" || bad "CASE (espejo) no pude copiar el hook a otra carpeta"
  add_hook PreToolUse Bash "bash \"$LAB/elsewhere/scripts/hooks/test-scope-guard-pre.sh\""
  applier_by "$OTHER" >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(census naming '/test-scope-guard-pre.sh"')" = 2 ] && [ "$(census repeated)" = 0 ] \
    && ok "CASE (espejo) una copia del hook en otra carpeta es otro hook: el del arnés sigue registrado, y no cuentan como repetidos" \
    || bad "CASE (espejo) con la copia en otra carpeta (rc $RC): test-scope-guard-pre.sh está $(census naming '/test-scope-guard-pre.sh"') vez/veces (esperaba 2)"
  TYCON_TEST_SCOPE_GUARD=0 applier_by "$OTHER" >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(census naming '/test-scope-guard-pre.sh"')" = 1 ] && [ "$(census naming "\"$LAB/elsewhere/scripts/hooks/test-scope-guard-pre.sh\"")" = 1 ] \
    && ok "CASE (espejo) …y el interruptor saca sólo el del arnés: la copia de la otra carpeta se queda" \
    || bad "CASE (espejo) el interruptor (rc $RC): quedan $(census naming '/test-scope-guard-pre.sh"'), de la otra carpeta $(census naming "\"$LAB/elsewhere/scripts/hooks/test-scope-guard-pre.sh\"")"

  # el orden inverso: una máquina que se instaló por la otra caja, y después se llama por la carpeta del clon
  printf '{\n  "hooks": {}\n}\n' > "$TYCON_SETTINGS_PATH"
  applier_by "$OTHER" >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(census total)" = "$N" ] && [ "$(census naming "\"$OTHER/scripts/hooks/")" -ge 15 ] \
    && ok "CASE la vara del orden inverso: instalado por la otra caja, los $N hooks, $(census naming "\"$OTHER/scripts/hooks/") con esa ruta" \
    || bad "CASE la vara del orden inverso (rc $RC): $(census total) hooks, $(census naming "\"$OTHER/scripts/hooks/") con la ruta en otra caja"
  cp "$TYCON_SETTINGS_PATH" "$BASE/case-inverse.json"
  OUT="$(applier_by "$LAB_TREE" --check 2>&1)"; RC_CHECK=$?
  applier_by "$LAB_TREE" >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$RC_CHECK" = 0 ] && [ "$(printf '%s\n' "$OUT" | grep -c 'hooks faltan')" = 0 ] && [ "$(census repeated)" = 0 ] && cmp -s "$BASE/case-inverse.json" "$TYCON_SETTINGS_PATH" \
    && ok "CASE orden inverso: después, por la carpeta del clon, nada falta, nada dos veces y settings.json no cambia" \
    || bad "CASE orden inverso (rc $RC, --check $RC_CHECK): $(census total) hooks, $(census repeated) repetidos"
  fi
  fi
fi

# ═══ HOOKSPATH · el core.hooksPath local cuya carpeta no está en el disco ════════════════════════════════════
if runs HOOKSPATH; then
  if ! harness_lab_team_machine "$BASE/hp" real >/dev/null; then bad "HOOKSPATH no pude armar la máquina del equipo de laboratorio"; else
  case "$HOME" in "$BASE"/*) ;; *) echo "❌ installer-repeated-hooks: la HOME no es la de juguete (${HOME})"; exit 1 ;; esac
  sk() { harness_lab_git "$LAB_SKILLS" "$@"; }
  hooks_path() { sk config --local --get core.hooksPath; }
  said() { printf '%s\n' "$1" | grep -e 'core.hooksPath LOCAL' -e 'core.hooksPath local'; }   # <salida>: lo que el lazo dijo de un clon
  # la vista reducida de un clon re-apuntado, como la escribe repoint.js (sin «cono»: lo de la raíz y tres carpetas)
  view_on() {
    sk config --local core.sparseCheckout true && sk config --local core.sparseCheckoutCone false \
      && printf '/*\n!/*/\n/agents/\n/skills/\n/packs/\n' > "$LAB_SKILLS/.git/info/sparse-checkout" && sk sparse-checkout reapply
  }
  view_off() {
    printf '/*\n' > "$LAB_SKILLS/.git/info/sparse-checkout" && sk sparse-checkout reapply \
      && sk config --local --unset core.sparseCheckout && sk config --local --unset core.sparseCheckoutCone && rm -f "$LAB_SKILLS/.git/info/sparse-checkout"
  }
  # el clon viejo sigue `.githooks/` con un hook de verdad (como el repo viejo real), y su hooksPath local apunta ahí
  mkdir -p "$LAB_SKILLS/.githooks" && printf '#!/bin/sh\n# hook del repo viejo (laboratorio)\nexit 0\n' > "$LAB_SKILLS/.githooks/pre-commit" && chmod +x "$LAB_SKILLS/.githooks/pre-commit" \
    && sk add .githooks/pre-commit >/dev/null 2>&1 && sk commit -q -m "lab: el repo viejo trae .githooks/pre-commit" >/dev/null 2>&1 \
    && sk config --local core.hooksPath .githooks || bad "HOOKSPATH no pude sembrar .githooks/ y el hooksPath local en el clon viejo"
  applier_by "$LAB_TREE" >/dev/null 2>&1   # lo que haya que decir una sola vez se dice acá
  cp "$LAB_SKILLS/.git/config" "$BASE/hp-config-before"
  OUT="$(applier_by "$LAB_TREE" 2>&1)"; RC=$?
  case "$(said "$OUT")" in *"con 1 hook(s) reales"*"no lo toco"*) BASELINE=1 ;; *) BASELINE=0 ;; esac
  [ "$RC" = 0 ] && [ "$BASELINE" = 1 ] && [ "$(hooks_path)" = .githooks ] && cmp -s "$BASE/hp-config-before" "$LAB_SKILLS/.git/config" \
    && ok "HOOKSPATH la vara: con la carpeta en el disco y un hook de verdad, el aplicador sale 0, dice «no lo toco» y no toca .git/config" \
    || bad "HOOKSPATH la vara (rc $RC): «$(said "$OUT" | cut -c1-240)» · hooksPath: $(hooks_path)"

  # la vista reducida esconde .githooks/ (el clon re-apuntado)
  view_on >/dev/null 2>&1 && [ ! -e "$LAB_SKILLS/.githooks" ] && [ -d "$LAB_SKILLS/skills" ] || bad "HOOKSPATH no pude poner la vista reducida (¿.githooks/ sigue en el disco?)"
  cp "$LAB_SKILLS/.git/config" "$BASE/hp-config-hidden"
  OUT="$(applier_by "$LAB_TREE" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "HOOKSPATH con .githooks/ escondida por la vista reducida el aplicador sale 0 (no muere a mitad de camino)" \
    || bad "HOOKSPATH con .githooks/ escondida el aplicador salió $RC: $(printf '%s\n' "$OUT" | tail -2 | cut -c1-300)"
  case "$(said "$OUT")" in *"vista reducida"*"no lo toco"*) ok "HOOKSPATH …dice que la carpeta la esconde la vista reducida, que NO es vestigial y que no lo toca" ;; *) bad "HOOKSPATH con .githooks/ escondida el lazo dijo: «$(said "$OUT" | cut -c1-300)»" ;; esac
  [ "$(hooks_path)" = .githooks ] && cmp -s "$BASE/hp-config-hidden" "$LAB_SKILLS/.git/config" \
    && ok "HOOKSPATH …y no borra la clave: .git/config queda byte a byte" || bad "HOOKSPATH con .githooks/ escondida: hooksPath «$(hooks_path)», .git/config $(cmp -s "$BASE/hp-config-hidden" "$LAB_SKILLS/.git/config" && echo igual || echo CAMBIÓ)"
  OUT="$(applier_by "$LAB_TREE" --check 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(said "$OUT" | grep -c 'vestigial (')" = 0 ] && [ "$(said "$OUT" | grep -c 'vista reducida')" = 1 ] && cmp -s "$BASE/hp-config-hidden" "$LAB_SKILLS/.git/config" \
    && ok "HOOKSPATH …también con --check: no lo llama vestigial" || bad "HOOKSPATH --check con .githooks/ escondida (rc $RC): «$(said "$OUT" | cut -c1-300)»"
  # la vuelta: la carpeta vuelve al disco, la clave sigue ahí y .git/config es el de antes de la ida
  view_off >/dev/null 2>&1 && [ -f "$LAB_SKILLS/.githooks/pre-commit" ] || bad "HOOKSPATH no pude sacar la vista reducida"
  OUT="$(applier_by "$LAB_TREE" 2>&1)"; RC=$?
  case "$(said "$OUT")" in *"con 1 hook(s) reales"*"no lo toco"*) BASELINE=1 ;; *) BASELINE=0 ;; esac
  [ "$RC" = 0 ] && [ "$BASELINE" = 1 ] && cmp -s "$BASE/hp-config-before" "$LAB_SKILLS/.git/config" \
    && ok "HOOKSPATH después de la vuelta: .git/config byte a byte el de antes de la ida, y el aplicador dice lo de siempre" \
    || bad "HOOKSPATH después de la vuelta (rc $RC): $(diff "$BASE/hp-config-before" "$LAB_SKILLS/.git/config" | head -3 | tr '\n' ' ') «$(said "$OUT" | cut -c1-200)»"

  # (no pude mirar) una carpeta que ESTÁ y no se deja leer no es «sin hooks»
  if [ "$(id -u)" = 0 ]; then not_measured "HOOKSPATH (no pude mirar): corriendo como root no hay carpeta que no se deje leer"; else
    chmod 000 "$LAB_SKILLS/.githooks"
    OUT="$(applier_by "$LAB_TREE" 2>&1)"; RC=$?
    chmod 755 "$LAB_SKILLS/.githooks"
    case "$(said "$OUT")" in *"no pude mirar"*"no lo toco"*) LOOKED=1 ;; *) LOOKED=0 ;; esac
    [ "$RC" = 0 ] && [ "$LOOKED" = 1 ] && [ "$(hooks_path)" = .githooks ] \
      && ok "HOOKSPATH (no pude mirar) una carpeta que no se deja leer: sale 0, dice que no pudo mirar y no toca la clave" \
      || bad "HOOKSPATH (no pude mirar) (rc $RC): «$(said "$OUT" | cut -c1-300)» · hooksPath: $(hooks_path)"
  fi

  # (espejo) lo vestigial de verdad se sigue destapando: una carpeta del clon con sólo *.sample
  mkdir -p "$LAB_SKILLS/.git/lab-hooks" && : > "$LAB_SKILLS/.git/lab-hooks/pre-commit.sample" && sk config --local core.hooksPath .git/lab-hooks || bad "HOOKSPATH (espejo) no pude sembrar el hooksPath vestigial"
  OUT="$(applier_by "$LAB_TREE" --check 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(said "$OUT" | grep -c 'LOCAL vestigial')" = 1 ] && [ "$(hooks_path)" = .git/lab-hooks ] \
    && ok "HOOKSPATH (espejo) sólo *.sample, con --check: avisa que es vestigial y no lo saca" || bad "HOOKSPATH (espejo) --check (rc $RC): «$(said "$OUT" | cut -c1-240)» · hooksPath: $(hooks_path)"
  OUT="$(applier_by "$LAB_TREE" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(said "$OUT" | grep -c 'vestigial removido')" = 1 ] && [ -z "$(hooks_path)" ] \
    && ok "HOOKSPATH (espejo) sólo *.sample: lo destapa (la clave se va) y lo dice" || bad "HOOKSPATH (espejo) (rc $RC): «$(said "$OUT" | cut -c1-240)» · hooksPath: «$(hooks_path)»"
  # (espejo) una carpeta que no existe y que el repo NO sigue: vestigial también (y el aplicador no muere)
  sk config --local core.hooksPath lab-no-such-hooks
  OUT="$(applier_by "$LAB_TREE" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(said "$OUT" | grep -c 'vestigial removido')" = 1 ] && [ -z "$(hooks_path)" ] \
    && ok "HOOKSPATH (espejo) una carpeta que no existe y que el repo no sigue: sale 0 y la destapa, como el instalador de Windows" \
    || bad "HOOKSPATH (espejo) carpeta inexistente (rc $RC): «$(said "$OUT" | cut -c1-240)» · hooksPath: «$(hooks_path)»"

  # la misma regla con la ruta escrita ABSOLUTA: escondida dentro del clon no es vestigial; fuera del clon y sin estar en
  # el disco, git no puede decir si alguien la sigue: es «no pude mirar», y tampoco se toca
  sk config --local core.hooksPath "$LAB_SKILLS/.githooks" && view_on >/dev/null 2>&1 && [ ! -e "$LAB_SKILLS/.githooks" ] || bad "HOOKSPATH (absoluta) no pude poner la vista reducida"
  OUT="$(applier_by "$LAB_TREE" 2>&1)"; RC=$?
  case "$(said "$OUT")" in *"vista reducida"*"no lo toco"*) HIDDEN=1 ;; *) HIDDEN=0 ;; esac
  [ "$RC" = 0 ] && [ "$HIDDEN" = 1 ] && [ "$(hooks_path)" = "$LAB_SKILLS/.githooks" ] \
    && ok "HOOKSPATH (absoluta) escondida por la vista reducida y escrita con la ruta absoluta: tampoco es vestigial, no se toca" \
    || bad "HOOKSPATH (absoluta) escondida (rc $RC): «$(said "$OUT" | cut -c1-300)» · hooksPath: «$(hooks_path)»"
  view_off >/dev/null 2>&1 || bad "HOOKSPATH (absoluta) no pude sacar la vista reducida"
  sk config --local core.hooksPath "$LAB/elsewhere/lab-no-such-hooks"
  OUT="$(applier_by "$LAB_TREE" 2>&1)"; RC=$?
  case "$(said "$OUT")" in *"no pude mirar"*"no lo toco"*) LOOKED=1 ;; *) LOOKED=0 ;; esac
  [ "$RC" = 0 ] && [ "$LOOKED" = 1 ] && [ "$(hooks_path)" = "$LAB/elsewhere/lab-no-such-hooks" ] \
    && ok "HOOKSPATH (absoluta) una carpeta de FUERA del clon que no está en el disco: sale 0, dice que no pudo mirar si alguien la sigue y no toca la clave" \
    || bad "HOOKSPATH (absoluta) fuera del clon (rc $RC): «$(said "$OUT" | cut -c1-300)» · hooksPath: «$(hooks_path)»"
  fi
fi

if [ "$FAILURES" = 0 ]; then
  if [ "$NOT_MEASURED" -gt 0 ]; then echo "✅ installer-repeated-hooks: lo medido, verde — $NOT_MEASURED parte(s) NO MEDIDA(S)"; else echo "✅ installer-repeated-hooks: todo verde"; fi
  exit 0
fi
echo "❌ installer-repeated-hooks: $FAILURES fallo(s)"; exit 1
