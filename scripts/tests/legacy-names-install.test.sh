#!/usr/bin/env bash
# legacy-names-install.test.sh — el nombre viejo en bash y en la máquina: la biblioteca de shell, la migración del
# instalador y la máquina atrasada (story 8.9, tanda A2 · 2026-09-30). T17 y T19 (parte bash), T26 y T27.
#
# Lo que no se puede perder:
#   · En bash 3.2 (el de macOS), una variable o una opción con el nombre viejo hace lo mismo que con el nuevo, sin
#     imprimir nada; las dos a la vez de una opción que no se repite es un error de opción.
#   · El instalador reescribe las rutas viejas comparando la ruta COMPLETA: `corridas.js` está dentro de
#     `subir-corridas.js` y esa no se toca. En hooks, permisos, settings.local.json, Codex, ~/.git-hooks/* y los
#     LaunchAgents; recarga sólo el que estaba cargado; sin duplicar; la segunda corrida no cambia nada.
#   · Una máquina atrasada que recibe un renombre por la línea de arranque: entre el pull y el instalador los
#     reemplazos cubren, y después cada control corre de verdad; un control que no encuentra su archivo se saltea sin
#     ensuciar hook-errors.log. Un agent-skills adelantado o atrasado respecto del arnés no cae a su camino silencioso.
#
# Todo en carpetas de mktemp: HOME de juguete (fake_home_create --installer: launchctl de mentira, sin examen nocturno
# ni entorno gráfico), un arnés y un agent-skills de laboratorio. Nunca la HOME real, nunca launchd real, nunca /opt.
# Las etiquetas de LaunchAgent son de laboratorio (lab.legacy-names.*), nunca ar.com.tycon.*.
#
# Story 8.12 (tanda R1): T1 (parte --write-shims: un .yml sólo de docs/ado/same-repo no pide reemplazo), T12 y T4 (los
# permisos RELATIVOS de settings.json y settings.local.json, y el prefijo de la ruta nueva que no se reescribe dos veces).
#
# Story 8.9 (tanda E): T55, la máquina vieja entera —«nadie nota el cambio»—. Es la más larga (un minuto o dos: dos
# arranques reales y cada control una vez), así que corre sólo cuando se la pide: --old-machine (o --only T55).
#
# Uso: bash scripts/tests/legacy-names-install.test.sh [--only T17|T19|T26|T27|T1|T12|T4|T55] [--old-machine]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB_JS="$RAIZ/scripts/lib/legacy-names.js"
LIB_SH="$RAIZ/scripts/lib/legacy-names.sh"
# El repo de las skills, por la biblioteca: `TYCON_SKILLS_DIR` vale como la RAÍZ del clon y como su carpeta `skills/`
# (scripts/lib/skills-dir.js acepta las dos). Antes esta línea la leía sólo como «la carpeta de skills» (`cd …/..`): con
# la raíz del clon unido —lo que exporta la CI— buscaba las skills en la carpeta madre del clon y T27 daba «cruce de
# repos: antes=0 después=0» sin que el instalador tuviera nada que ver (story 8.18, medido el 2026-10-04).
# Si la biblioteca no contesta (su vecina está y no carga), se dice la causa y no se mide nada: caer a
# ~/.claude/agent-skills era medir las skills INSTALADAS en vez de las del clon, y cerrar en verde (story 8.18, deuda
# lectores-que-tragan; caso en scripts/tests/skills-dir-readers.test.js). En la falla, la salida trae la causa.
if ! SKILLS_REPO="$(node -e 'try { process.stdout.write(require(process.argv[1]).resolveSkillsDirs().repo); } catch (e) { process.stdout.write(String((e && e.message) || e).split("\n")[0]); process.exit(1); }' "$RAIZ/scripts/lib/skills-dir.js")" \
   || [ -z "$SKILLS_REPO" ]; then
  echo "⏭ legacy-names-install: NO MEDIDO — no pude resolver la carpeta de skills: ${SKILLS_REPO:-la biblioteca no contestó nada}"
  exit 2
fi
source "$RAIZ/scripts/tests/lib/fake-home.sh"
ONLY=""
[ "${1:-}" = "--only" ] && ONLY="${2:-}"
[ "${1:-}" = "--old-machine" ] && ONLY="T55"
# T55 sólo a pedido (--old-machine): sin selección corren todas las demás
corre() { if [ "$1" = T55 ]; then [ "$ONLY" = T55 ]; else [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; fi; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
trap 'rm -rf "$BASE"' EXIT
BASH32=/bin/bash   # en macOS es el 3.2; en Linux, el que haya (la prueba vale igual)

# Los nombres castellanos de los ejemplos se arman por partes: esta prueba sale en la copia pública (AC 7).
VIEJA_ENV="TYCON_NO_$(printf 'BAJ')AR"
NUEVA_ENV="TYCON_NO_DOWNLOAD_LAB"
VIEJA_OPT="$(printf 'si')n-$(printf 'co')pia"
NUEVA_OPT="no-copy"
LIMPIAR="$(printf 'limp')iar"
CORRIDAS="$(printf 'corri')das"

mapa() { # mapa <archivo> <entradas JSON>
  printf '{ "__about": "mapa de laboratorio", "retire_after": null, "entries": %s }\n' "$2" > "$1"
}

# ═══ T17 · legacy_env en bash 3.2 ═════════════════════════════════════════════════════════════════════════════════
if corre T17; then
  T="$BASE/t17"; mkdir -p "$T/scripts/lab"
  mapa "$T/renames.json" "[{\"kind\":\"env\",\"old\":\"$VIEJA_ENV\",\"new\":\"$NUEVA_ENV\",\"batch\":\"lab\"}]"
  cat > "$T/scripts/lab/tool.sh" <<EOF
#!/usr/bin/env bash
set -u
. "$LIB_SH"
legacy_env $NUEVA_ENV
printf 'valor=%s' "\${$NUEVA_ENV-<ninguna>}"
EOF
  run17() { ( fake_home_create "$T/casa" && env TYCON_LEGACY_NAMES_MAP="$T/renames.json" "$@" "$BASH32" "$T/scripts/lab/tool.sh" ) 2>"$T/err"; }
  o="$(run17 env "$VIEJA_ENV=1")";                [ "$o" = "valor=1" ] && ok "T17 bash: sólo la vieja → su valor" || mal "T17 bash: sólo la vieja dio «${o}»"
  o="$(run17 env "$VIEJA_ENV=1" "$NUEVA_ENV=1")"; [ "$o" = "valor=1" ] && ok "T17 bash: las dos iguales → el valor" || mal "T17 bash: iguales dio «${o}»"
  o="$(run17 env "$VIEJA_ENV=0" "$NUEVA_ENV=1")"; [ "$o" = "valor=1" ] && ok "T17 bash: distintas → gana la nueva" || mal "T17 bash: distintas dio «${o}»"
  for _ in 1 2 3 4 5 6 7 8 9 10; do   # el registro va de fondo (anotar nunca demora al guion): se espera hasta 5 s
    grep -q '"conflict":true' "$T/casa/.claude/.tycon-pipeline/legacy-names.jsonl" 2>/dev/null && break; sleep 0.5
  done
  if grep -q '"conflict":true' "$T/casa/.claude/.tycon-pipeline/legacy-names.jsonl" 2>/dev/null; then ok "T17 bash: la diferencia se anota como conflict"
  else mal "T17 bash: no quedó el conflict en legacy-names.jsonl"; fi
  o="$(run17 env)";                                [ "$o" = "valor=<ninguna>" ] && ok "T17 bash: ninguna → sin valor, como hoy" || mal "T17 bash: ninguna dio «${o}»"
  [ ! -s "$T/err" ] && ok "T17 bash: no imprime nada" || mal "T17 bash: imprimió: $(head -3 "$T/err")"
  o="$( ( fake_home_create "$T/casa2" && env "$VIEJA_ENV=1" "$BASH32" "$T/scripts/lab/tool.sh" ) 2>&1)"
  [ "$o" = "valor=<ninguna>" ] && ok "T17 bash: sin mapa es paso directo" || mal "T17 bash: sin mapa dio «${o}»"
  if grep -vE '^[[:space:]]*#' "$LIB_SH" | grep -nE '\$\{[A-Za-z_]+,,\}|declare -A|typeset -A|local -A' >/dev/null 2>&1; then mal "T17 bash: legacy-names.sh usa algo que bash 3.2 no tiene"
  else ok "T17 bash: legacy-names.sh sin \${v,,} ni arreglos asociativos"; fi
  # el .ps1, por lectura: las mismas funciones y el mismo punto de entrada de node
  PS1="$RAIZ/scripts/lib/legacy-names.ps1"
  if [ -f "$PS1" ] && grep -q 'function Get-LegacyEnv' "$PS1" && grep -q 'function Get-LegacyArgs' "$PS1" && grep -q 'legacy-names.js' "$PS1"; then
    ok "T17 ps1 (por lectura): Get-LegacyEnv y Get-LegacyArgs sobre la misma biblioteca"
  else mal "T17 ps1: falta legacy-names.ps1 o sus funciones"; fi
  # y si la máquina tiene PowerShell, además se corre (la pregunta 5 pide lectura; correrlo es mejor cuando se puede)
  if command -v pwsh >/dev/null 2>&1 && [ -f "$PS1" ]; then
    mapa "$T/ps-map.json" "[{\"kind\":\"env\",\"old\":\"$VIEJA_ENV\",\"new\":\"$NUEVA_ENV\",\"batch\":\"lab\"},
      {\"kind\":\"option\",\"old\":\"$VIEJA_OPT\",\"new\":\"$NUEVA_OPT\",\"where\":\"scripts/lab/x.ps1\",\"batch\":\"lab\"}]"
    cat > "$T/t.ps1" <<EOF
. '$PS1'
"env=" + (Get-LegacyEnv '$NUEVA_ENV')
"args=" + ((Get-LegacyArgs -Where 'scripts/lab/x.ps1' '--$VIEJA_OPT' 'a b') -join '|')
try { Get-LegacyArgs -Where 'scripts/lab/x.ps1' '--$VIEJA_OPT' '--$NUEVA_OPT' | Out-Null; 'dup=sin-error' } catch { 'dup=' + \$_.Exception.Message }
EOF
    o="$( ( fake_home_create "$T/casa-ps" && env TYCON_LEGACY_NAMES_MAP="$T/ps-map.json" "$VIEJA_ENV=1" pwsh -NoProfile -File "$T/t.ps1" ) 2>&1)"
    if grep -q '^env=1$' <<<"$o" && grep -qF "args=--$NUEVA_OPT|a b" <<<"$o" && grep -q '^dup=la misma opción dos veces' <<<"$o"; then
      ok "T17 ps1 (corrido con pwsh): variable vieja, opción vieja y las dos a la vez"
    else mal "T17 ps1 corrido: $(tr '\n' ' ' <<<"$o")"; fi
    # el registro de usos también se escribe desde PowerShell fuera de Windows (de fondo: se espera hasta 5 s)
    for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q "\"old\":\"$VIEJA_ENV\"" "$T/casa-ps/.claude/.tycon-pipeline/legacy-names.jsonl" 2>/dev/null && break; sleep 0.5; done
    grep -q "\"old\":\"$VIEJA_ENV\"" "$T/casa-ps/.claude/.tycon-pipeline/legacy-names.jsonl" 2>/dev/null \
      && ok "T17 ps1: el uso queda anotado en legacy-names.jsonl" || mal "T17 ps1: no quedó anotado el uso desde PowerShell"
    # sin argumentos devuelve un arreglo vacío; y el mensaje de «dos veces» no cambia entre corridas
    M2="$(printf 'moti')vo"; P2="$(printf 'paqu')ete"
    mapa "$T/ps-map2.json" "[{\"kind\":\"option\",\"old\":\"$VIEJA_OPT\",\"new\":\"$NUEVA_OPT\",\"where\":\"scripts/lab/x.ps1\",\"batch\":\"lab\"},
      {\"kind\":\"option\",\"old\":\"$M2\",\"new\":\"reason\",\"where\":\"scripts/lab/x.ps1\",\"batch\":\"lab\"},
      {\"kind\":\"option\",\"old\":\"$P2\",\"new\":\"package\",\"where\":\"scripts/lab/x.ps1\",\"batch\":\"lab\"}]"
    cat > "$T/t2.ps1" <<EOF
. '$PS1'
\$r = Get-LegacyArgs -Where 'scripts/lab/x.ps1'
"count=" + \$r.Count
try { Get-LegacyArgs -Where 'scripts/lab/x.ps1' '--$VIEJA_OPT' '--$M2' '--$P2' '--$NUEVA_OPT' '--reason' '--package' | Out-Null } catch { 'dup=' + \$_.Exception.Message }
EOF
    msgs=""
    for _ in 1 2 3 4 5; do
      o="$( ( fake_home_create "$T/casa-ps2" && env TYCON_LEGACY_NAMES_MAP="$T/ps-map2.json" pwsh -NoProfile -File "$T/t2.ps1" ) 2>&1)"
      grep -q '^count=0$' <<<"$o" || mal "T17 ps1: sin argumentos no devolvió un arreglo vacío: $(tr '\n' ' ' <<<"$o")"
      msgs="$msgs
$(grep '^dup=' <<<"$o")"
    done
    [ "$(printf '%s\n' "$msgs" | grep -c .)" = 5 ] && [ "$(printf '%s\n' "$msgs" | grep . | sort -u | wc -l | tr -d ' ')" = 1 ] \
      && grep -qF -- "--$VIEJA_OPT y --$NUEVA_OPT" <<<"$msgs" && ok "T17 ps1: sin argumentos da 0 y el mensaje de «dos veces» es siempre el primero del argv" \
      || mal "T17 ps1: el mensaje de «dos veces» cambia entre corridas: $(printf '%s' "$msgs" | sort -u | tr '\n' ' ')"
  else echo "  (sin pwsh en esta máquina: el .ps1 queda revisado por lectura)"; fi
fi

# ═══ T19 · legacy_args en bash 3.2 ════════════════════════════════════════════════════════════════════════════════
if corre T19; then
  T="$BASE/t19"; mkdir -p "$T/scripts/lab"
  mapa "$T/renames.json" "[{\"kind\":\"option\",\"old\":\"$VIEJA_OPT\",\"new\":\"$NUEVA_OPT\",\"where\":\"scripts/lab/tool.sh\",\"batch\":\"lab\"},
    {\"kind\":\"subcommand\",\"old\":\"$LIMPIAR\",\"new\":\"clean\",\"where\":\"scripts/lab/tool.sh\",\"batch\":\"lab\"}]"
  cat > "$T/scripts/lab/tool.sh" <<EOF
#!/usr/bin/env bash
set -u
. "$LIB_SH"
LEGACY_NAMES_WHERE=scripts/lab/tool.sh
legacy_args "\$@" || exit 64
set -- \${LEGACY_ARGS[@]+"\${LEGACY_ARGS[@]}"}
case "\${1:-}" in
  clean) shift; echo "clean:\$*" ;;
  --$NUEVA_OPT) echo "no-copy" ;;
  *) echo "opción desconocida: \${1:-}" >&2; exit 64 ;;
esac
EOF
  run19() { ( fake_home_create "$T/casa" && env TYCON_LEGACY_NAMES_MAP="$T/renames.json" "$BASH32" "$T/scripts/lab/tool.sh" "$@" ) 2>"$T/err"; echo "rc=$?"; }
  a="$(run19 "--$VIEJA_OPT")"; b="$(run19 "--$NUEVA_OPT")"
  [ "$a" = "$b" ] && [ "$a" = "$(printf 'no-copy\nrc=0')" ] && ok "T19 bash: la opción vieja = la nueva" || mal "T19 bash: vieja «${a}» vs nueva «${b}»"
  a="$(run19 "$LIMPIAR" "x y")"; b="$(run19 clean "x y")"
  [ "$a" = "$b" ] && ok "T19 bash: el subcomando viejo = el nuevo (con argumentos con espacios)" || mal "T19 bash: «${a}» vs «${b}»"
  a="$(run19 "--$VIEJA_OPT" "--$NUEVA_OPT")"
  if [ "$a" = "rc=64" ] && grep -q 'la misma opción dos veces' "$T/err"; then ok "T19 bash: las dos a la vez → código de opción desconocida y el mensaje"
  else mal "T19 bash: las dos a la vez dio «${a}» / $(cat "$T/err")"; fi
  a="$(run19)"; [ "$a" = "rc=64" ] && ok "T19 bash: sin argumentos sigue andando con set -u" || mal "T19 bash: sin argumentos dio «${a}»"
  # sin LEGACY_NAMES_WHERE: el script se deduce de quién cargó la biblioteca, en cualquier forma de invocarlo
  L="$T/lab-repo"; mkdir -p "$L/scripts/lib" "$L/scripts/lab" "$L/scripts/tools"
  cp "$LIB_SH" "$LIB_JS" "$L/scripts/lib/"
  mapa "$L/scripts/lib/renames.json" "[{\"kind\":\"option\",\"old\":\"$VIEJA_OPT\",\"new\":\"$NUEVA_OPT\",\"where\":\"scripts/lab/tool2.sh\",\"batch\":\"lab\"}]"
  cat > "$L/scripts/lab/tool2.sh" <<'EOF'
#!/usr/bin/env bash
set -u
. "$(dirname "${BASH_SOURCE[0]}")/../lib/legacy-names.sh"
legacy_args "$@" || exit 64
set -- ${LEGACY_ARGS[@]+"${LEGACY_ARGS[@]}"}
echo "args=$*"
EOF
  chmod +x "$L/scripts/lab/tool2.sh"
  deduce() { ( fake_home_create "$T/casa-deduce" && cd "$L/$1" && env -u TYCON_LEGACY_NAMES_MAP "${@:2}" ) 2>/dev/null; }
  fallas=""
  for forma in "bash scripts/lab/tool2.sh" "bash ./scripts/lab/tool2.sh" "./scripts/lab/tool2.sh" "bash scripts//lab/tool2.sh" "bash scripts/tools/../lab/tool2.sh"; do
    o="$(deduce . $forma "--$VIEJA_OPT")"; [ "$o" = "args=--$NUEVA_OPT" ] || fallas="$fallas «${forma}» → «${o}»"
  done
  o="$(deduce scripts/lab ./tool2.sh "--$VIEJA_OPT")"; [ "$o" = "args=--$NUEVA_OPT" ] || fallas="$fallas «cd scripts/lab && ./tool2.sh» → «${o}»"
  [ -z "$fallas" ] && ok "T19 bash: el script se deduce igual con ./, //, .. y desde su carpeta" || mal "T19 bash: la deducción falla en$fallas"
fi

# ═══ T26 · el instalador reescribe por ruta completa, en todos lados, una vez ══════════════════════════════════════
if corre T26; then
  T="$BASE/t26"; H="$T/casa"; G="$T/src/guides"; S="$T/src/agent-skills"
  mkdir -p "$G/scripts/metrics" "$S/skills/lab" "$T/bin"
  echo '// nuevo' > "$G/scripts/metrics/runs.js"
  echo '// otro, que contiene al viejo como subcadena' > "$G/scripts/metrics/subir-$CORRIDAS.js"
  mapa "$T/renames.json" "[{\"kind\":\"file\",\"old\":\"scripts/metrics/$CORRIDAS.js\",\"new\":\"scripts/metrics/runs.js\",\"batch\":\"lab\",\"callers\":[\"machine\"]}]"
  ( fake_home_create "$H" --installer ) || mal "T26 no pude armar la HOME de juguete"
  mkdir -p "$H/.claude" "$H/.codex" "$H/.git-hooks" "$H/Library/LaunchAgents"
  ln -s "$G" "$H/.claude/tycon-claude-guides"
  OLD_ABS="$G/scripts/metrics/$CORRIDAS.js"; NEW_ABS="$G/scripts/metrics/runs.js"; SUB_ABS="$G/scripts/metrics/subir-$CORRIDAS.js"
  OLD_LNK="$H/.claude/tycon-claude-guides/scripts/metrics/$CORRIDAS.js"
  cat > "$H/.claude/settings.json" <<EOF
{
  "model": "keep-me",
  "hooks": {
    "Stop": [ { "hooks": [ { "type": "command", "command": "node \"$OLD_ABS\"" }, { "type": "command", "command": "node \"$SUB_ABS\"" } ] } ],
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "node \"$OLD_LNK\" --quiet" }, { "type": "command", "command": "node \"$NEW_ABS\" --quiet" } ] } ]
  },
  "permissions": {
    "allow": [ "Bash(node $OLD_ABS:*)", "Bash(node $NEW_ABS:*)", "Bash(node $SUB_ABS:*)" ],
    "deny": [ "Read(~/.claude/tycon-claude-guides/scripts/metrics/$CORRIDAS.js)" ]
  }
}
EOF
  printf '{ "permissions": { "allow": [ "Bash(node %s --x)" ] } }\n' "$OLD_ABS" > "$H/.claude/settings.local.json"
  printf '{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node \\"%s\\"" } ] } ] } }\n' "$OLD_ABS" > "$H/.codex/hooks.json"
  printf '#!/bin/sh\nnode "$HOME/.claude/tycon-claude-guides/scripts/metrics/%s.js" || true\n' "$CORRIDAS" > "$H/.git-hooks/pre-commit.local"
  printf '#!/bin/sh\nnode "${TCG}/scripts/metrics/subir-%s.js"\n' "$CORRIDAS" > "$H/.git-hooks/post-commit"
  for L in loaded idle; do
    cat > "$H/Library/LaunchAgents/lab.legacy-names.$L.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>lab.legacy-names.$L</string>
  <key>ProgramArguments</key><array><string>/usr/bin/env</string><string>node</string><string>$OLD_ABS</string></array>
</dict></plist>
EOF
  done
  cat > "$T/bin/launchctl" <<EOF
#!/bin/sh
echo "\$*" >> "$T/launchctl.log"
case "\$*" in
  "print gui/"*"/lab.legacy-names.loaded") exit 0 ;;
  print*) exit 113 ;;
esac
exit 0
EOF
  chmod +x "$T/bin/launchctl"
  migrar() { ( fake_home_create "$H" --installer && env LAUNCHCTL_BIN="$T/bin/launchctl" TYCON_LEGACY_NAMES_MAP="$T/renames.json" \
      node "$LIB_JS" --migrate-machine --guides "$G" --skills "$S" "$@" ) 2>"$T/err"; }
  cp "$H/.claude/settings.json" "$T/antes.json"
  chk="$(migrar --check)"
  if cmp -s "$T/antes.json" "$H/.claude/settings.json" && grep -q '^RENAMED:[1-9]' <<<"$chk"; then ok "T26 --check cuenta y no escribe"
  else mal "T26 --check: «${chk}» o escribió"; fi
  out="$(migrar)"; rc=$?
  n="$(sed -n 's/^RENAMED:\([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  [ "$rc" -eq 0 ] && [ -n "$n" ] && [ "$n" -gt 0 ] && ok "T26 primera corrida: RENAMED:$n" || mal "T26 primera corrida rc=$rc «${out}» $(cat "$T/err")"
  SJ="$H/.claude/settings.json"
  grep -q "$CORRIDAS\.js\"" "$SJ" | true
  if python3 - "$SJ" "$OLD_ABS" "$NEW_ABS" "$SUB_ABS" "$OLD_LNK" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); old, new, sub, lnk = sys.argv[2:6]
cmds = [h["command"] for ev in s["hooks"].values() for g in ev for h in g["hooks"]]
txt = json.dumps(s)
assert old not in txt and lnk not in txt, "queda una ruta vieja"
assert f'node "{sub}"' in cmds, "subir-…js no se toca"
assert cmds.count(f'node "{new}"') == 1, "Stop: el viejo pasa al nuevo"
ss = [h["command"] for g in s["hooks"]["SessionStart"] for h in g["hooks"]]
assert len(ss) == 1, f"SessionStart sin duplicar: {ss}"
al = s["permissions"]["allow"]
assert al.count(f"Bash(node {new}:*)") == 1 and f"Bash(node {sub}:*)" in al and len(al) == 2, f"permisos sin duplicar: {al}"
assert s["permissions"]["deny"] == ["Read(~/.claude/tycon-claude-guides/scripts/metrics/runs.js)"], s["permissions"]["deny"]
assert s["model"] == "keep-me", "el resto intacto"
PY
  then ok "T26 settings.json: hooks y permisos por ruta completa, sin duplicar, subir-…js intacto, el resto igual"
  else mal "T26 settings.json quedó mal: $(cat "$SJ")"; fi
  grep -q "runs.js --x" "$H/.claude/settings.local.json" && ! grep -q "$CORRIDAS.js --x" "$H/.claude/settings.local.json" \
    && ok "T26 settings.local.json reescrito" || mal "T26 settings.local.json: $(cat "$H/.claude/settings.local.json")"
  grep -q 'runs.js' "$H/.codex/hooks.json" && ok "T26 ~/.codex/hooks.json reescrito" || mal "T26 codex: $(cat "$H/.codex/hooks.json")"
  grep -q 'metrics/runs.js' "$H/.git-hooks/pre-commit.local" && ok "T26 ~/.git-hooks/pre-commit.local reescrito" || mal "T26 git-hooks .local: $(cat "$H/.git-hooks/pre-commit.local")"
  grep -q "subir-$CORRIDAS.js" "$H/.git-hooks/post-commit" && ok "T26 ~/.git-hooks/post-commit: subir-…js intacto" || mal "T26 post-commit tocado"
  for L in loaded idle; do grep -q 'metrics/runs.js' "$H/Library/LaunchAgents/lab.legacy-names.$L.plist" || mal "T26 plist $L sin reescribir"; done
  if grep -q 'bootout gui/[0-9]*/lab.legacy-names.loaded' "$T/launchctl.log" && grep -q 'bootstrap gui/[0-9]* .*lab.legacy-names.loaded.plist' "$T/launchctl.log" \
     && ! grep -qE '(bootout|bootstrap|load).*idle' "$T/launchctl.log"; then ok "T26 LaunchAgent: el cargado se recarga, el no cargado sigue sin cargar"
  else mal "T26 launchctl: $(tr '\n' ' ' < "$T/launchctl.log")"; fi
  cp "$SJ" "$T/despues.json"
  out2="$(migrar)"
  if grep -q '^RENAMED:0' <<<"$out2" && cmp -s "$T/despues.json" "$SJ"; then ok "T26 segunda corrida: no cambia nada"
  else mal "T26 segunda corrida: «${out2}»"; fi
  # sin HOME real y sin launchctl de prueba, no toca launchd
  : > "$T/launchctl.log"
  sed -i.bak "s#metrics/runs.js#metrics/$CORRIDAS.js#" "$H/Library/LaunchAgents/lab.legacy-names.loaded.plist"
  o3="$( ( fake_home_create "$H" && unset LAUNCHCTL_BIN && env PATH="$T/bin:$PATH" TYCON_LEGACY_NAMES_MAP="$T/renames.json" node "$LIB_JS" --migrate-machine --guides "$G" --skills "$S" ) 2>&1)"
  [ ! -s "$T/launchctl.log" ] && ok "T26 con una HOME que no es la real y sin launchctl de prueba, no llama a launchd" || mal "T26 llamó a launchctl: $(cat "$T/launchctl.log") / $o3"
  # el instalador real la llama y suma RENAMED al reporte (HOME de juguete, arnés del repo, mapa de laboratorio)
  H2="$T/casa-inst"; mkdir -p "$H2/.claude"; ln -s "$SKILLS_REPO" "$H2/.claude/agent-skills"
  MISS="$RAIZ/scripts/hooks/missing-path-notice.js"
  mapa "$T/inst-map.json" "[{\"kind\":\"file\",\"old\":\"scripts/hooks/$CORRIDAS-lab.js\",\"new\":\"scripts/hooks/missing-path-notice.js\",\"batch\":\"lab\",\"callers\":[\"machine\"]}]"
  printf '{ "hooks": { "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node \\"%s\\"" } ] } ] } }\n' "$RAIZ/scripts/hooks/$CORRIDAS-lab.js" > "$H2/.claude/settings.json"
  inst="$( ( fake_home_create "$H2" --installer && env TYCON_LEGACY_NAMES_MAP="$T/inst-map.json" TYCON_PROFILE=0 TYCON_CODEX=0 TYCON_NO_CLAUDEMD_SYNC=1 \
      TYCON_NO_COMMANDS_SYNC=1 TYCON_NO_GIT_HOOKS=1 TYCON_NO_SQLITE_CHECK=1 TYCON_NO_THREAD_RESCUE=1 TYCON_NO_COLLECT_FINDINGS=1 \
      TYCON_STAGE_METRICS=0 TYCON_BENCH_DAILY=0 TYCON_NO_CANONICAL_PATH=1 TYCON_NO_BOOTSTRAP_HEAL=1 TYCON_THIRD_PARTY=0 \
      TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 bash "$RAIZ/scripts/install-tycon-hooks.sh" ) 2>/dev/null)"
  n_old="$(grep -c "$CORRIDAS-lab.js" "$H2/.claude/settings.json")"; n_new="$(grep -c "\"$MISS\\\\\"" "$H2/.claude/settings.json")"
  if grep -q 'reescrib' <<<"$inst" && [ "$n_old" = 0 ] && [ "$n_new" = 1 ]; then ok "T26 el instalador real llama a la migración: la ruta vieja pasa a la nueva, sin duplicar el hook canónico"
  else mal "T26 instalador: viejas=$n_old nuevas=$n_new salida: $(grep -i 'renam\|reescrib' <<<"$inst" | head -3)"; fi
  # el .ps1 hace lo mismo con la misma lista (pregunta 5): el mismo guion, las mismas raíces y --check en su modo que no escribe
  SH_I="$RAIZ/scripts/install-tycon-hooks.sh"; PS_I="$RAIZ/scripts/install-tycon-hooks.ps1"
  if grep -q 'legacy-names.js' "$SH_I" && grep -q -- '--migrate-machine --guides' "$SH_I" && grep -q '_LN_ARGS+=(--check)' "$SH_I" \
     && grep -q "'legacy-names.js'" "$PS_I" && grep -q -- "'--migrate-machine', '--guides'" "$PS_I" && grep -q "lnArgs += '--check'" "$PS_I"; then
    ok "T26 el .sh y el .ps1 llaman a legacy-names.js --migrate-machine con las dos raíces y --check"
  else mal "T26 los dos instaladores no llaman a la migración igual"; fi
  # estructura destino (§4): un archivo que CAMBIA DE CARPETA (hooks/ → setup/, como harness-env-publish.sh), en los seis lugares
  H3="$T/casa-carpeta"; ( fake_home_create "$H3" --installer ) || mal "T26 no pude armar la HOME de juguete (carpeta)"
  mkdir -p "$H3/.claude" "$H3/.codex" "$H3/.git-hooks" "$H3/Library/LaunchAgents" "$G/scripts/setup"
  echo '# nuevo' > "$G/scripts/setup/lab-env-publish.sh"
  ENV_OLD="$G/scripts/hooks/lab-env-publish.sh"; ENV_NEW="$G/scripts/setup/lab-env-publish.sh"
  mapa "$T/map-carpeta.json" '[{"kind":"file","old":"scripts/hooks/lab-env-publish.sh","new":"scripts/setup/lab-env-publish.sh","batch":"lab","callers":["machine"]}]'
  printf '{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "bash \\"%s\\"" } ] } ] }, "permissions": { "allow": [ "Bash(bash %s)" ] } }\n' "$ENV_OLD" "$ENV_OLD" > "$H3/.claude/settings.json"
  printf '{ "permissions": { "allow": [ "Bash(bash %s --x)" ] } }\n' "$ENV_OLD" > "$H3/.claude/settings.local.json"
  printf '{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "bash %s" } ] } ] } }\n' "$ENV_OLD" > "$H3/.codex/hooks.json"
  printf '#!/bin/sh\nbash "%s" || true\n' "$ENV_OLD" > "$H3/.git-hooks/pre-commit.local"
  cat > "$H3/Library/LaunchAgents/lab.legacy-names.loaded.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>lab.legacy-names.loaded</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$ENV_OLD</string></array>
</dict></plist>
EOF
  : > "$T/launchctl.log"
  o="$( ( fake_home_create "$H3" --installer && env LAUNCHCTL_BIN="$T/bin/launchctl" TYCON_LEGACY_NAMES_MAP="$T/map-carpeta.json" \
      node "$LIB_JS" --migrate-machine --guides "$G" --skills "$S" ) 2>&1)"
  quedan=""; for f in .claude/settings.json .claude/settings.local.json .codex/hooks.json .git-hooks/pre-commit.local Library/LaunchAgents/lab.legacy-names.loaded.plist; do
    grep -qF "$ENV_OLD" "$H3/$f" && quedan="$quedan $f(viejo)"; grep -qF "$ENV_NEW" "$H3/$f" || quedan="$quedan $f(sin-nuevo)"
  done
  if [ -z "$quedan" ] && grep -q '^RENAMED:6' <<<"$o" && grep -q 'bootstrap gui/[0-9]* .*lab.legacy-names.loaded.plist' "$T/launchctl.log"; then
    ok "T26 un archivo que cambia de carpeta se reescribe en los seis lugares (RENAMED:6) y su LaunchAgent cargado se recarga"
  else mal "T26 cambio de carpeta:$quedan · $(tr '\n' ' ' <<<"$o")"; fi
  # los avisos de la migración llegan al dev (vuelta 2 de revisores): una migración que se cae lo dice con SU mensaje (no
  # con la última línea de la pila), y una nota —un plist binario, un respaldo imposible— se muestra aunque no se haya
  # reescrito nada. Un node de mentira intercepta sólo la llamada a legacy-names.js; el resto usa el node real.
  REAL_NODE="$(command -v node)"; mkdir -p "$T/bin-ln"
  cat > "$T/bin-ln/node" <<EOF
#!/bin/bash
case "\${1:-}" in
  *legacy-names.js)
    case "\${LN_LAB:-}" in
      cae) printf '⛔ legacy-names: Error: EACCES lab-caida\n    at writeAtomic (legacy-names.js:600:6)\n    at migrateMachine (legacy-names.js:633:5)\n' >&2; exit 2 ;;
      nota) printf 'RENAMED:0\n  ⚠ lab.plist: plist binario con una ruta vieja — lab-nota\n'; exit 0 ;;
    esac ;;
esac
exec "$REAL_NODE" "\$@"
EOF
  chmod +x "$T/bin-ln/node"
  H4="$T/casa-avisos"; mkdir -p "$H4/.claude"; ln -s "$SKILLS_REPO" "$H4/.claude/agent-skills"; echo '{}' > "$H4/.claude/settings.json"
  inst_ln() { ( fake_home_create "$H4" --installer && env PATH="$T/bin-ln:$PATH" LN_LAB="$1" TYCON_PROFILE=0 TYCON_CODEX=0 TYCON_NO_CLAUDEMD_SYNC=1 \
      TYCON_NO_COMMANDS_SYNC=1 TYCON_NO_GIT_HOOKS=1 TYCON_NO_SQLITE_CHECK=1 TYCON_NO_THREAD_RESCUE=1 TYCON_NO_COLLECT_FINDINGS=1 \
      TYCON_STAGE_METRICS=0 TYCON_BENCH_DAILY=0 TYCON_NO_CANONICAL_PATH=1 TYCON_NO_BOOTSTRAP_HEAL=1 TYCON_THIRD_PARTY=0 \
      TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 bash "$SH_I" ) 2>/dev/null; }
  o="$(inst_ln cae)"
  grep -q 'la migración de nombres viejos falló.*lab-caida' <<<"$o" && ok "T26 .sh: una migración que se cae se dice con su mensaje" \
    || mal "T26 .sh caída: $(grep -i 'nombres viejos' <<<"$o" | head -2)"
  o="$(inst_ln nota)"
  grep -q 'lab-nota' <<<"$o" && ok "T26 .sh: una nota de la migración se muestra aunque no haya reescrito nada" || mal "T26 .sh nota perdida"
  # el .ps1: su bloque de migración corrido con pwsh (el instalador entero es de Windows), con el mismo node de mentira
  if command -v pwsh >/dev/null 2>&1; then
    mkdir -p "$T/ps/lib"; : > "$T/ps/lib/legacy-names.js"
    { printf '$ErrorActionPreference = "Stop"; $Check = $false; $ClaudeDir = "%s"\n' "$H4/.claude"
      sed -n '/^# ── Los nombres viejos (story 8.9/,/^# Load settings.json/p' "$PS_I" | sed '$d'
    } > "$T/ps/frag.ps1"
    for caso in cae:lab-caida nota:lab-nota; do
      o="$(env PATH="$T/bin-ln:$PATH" LN_LAB="${caso%%:*}" pwsh -NoProfile -File "$T/ps/frag.ps1" 2>&1)"
      grep -q "${caso#*:}" <<<"$o" && ok "T26 .ps1 (pwsh): el aviso «${caso%%:*}» llega al dev" || mal "T26 .ps1 ${caso%%:*}: «${o}»"
    done
  else echo "  (sin pwsh en esta máquina: el bloque del .ps1 queda revisado por lectura)"; fi
fi

# ═══ T27 · la máquina atrasada, por la línea de arranque, y los dos repos desfasados ══════════════════════════════
# El caso entero prueba el paso de un nombre viejo a uno nuevo, y lo arma con el mapa de renombres. Sin el mapa (la copia
# pública, story 8.7) no hay nombres viejos que probar: se dice y no corre, igual que T55. No es un verde.
if corre T27 && [ ! -f "$RAIZ/scripts/lib/renames.json" ]; then
  echo "  (sin scripts/lib/renames.json — la copia pública: no hay nombres viejos que probar, T27 no corre)"
elif corre T27; then
  T="$BASE/t27"; mkdir -p "$T"
  # 1 · un arnés de laboratorio con el árbol de trabajo de este (lo nuevo de la tanda incluido), en un remoto propio
  SRC="$T/src"; mkdir -p "$SRC"
  ( cd "$RAIZ" && git ls-files -co --exclude-standard -z | xargs -0 tar cf - 2>/dev/null ) | ( cd "$SRC" && tar xf - )
  G0() { git -C "$1" -c core.hooksPath=/dev/null -c user.email=lab@example.com -c user.name=Lab "${@:2}"; }
  git init -q -b main "$SRC" && G0 "$SRC" add -A && G0 "$SRC" commit -q -m "antes del renombre"
  git clone -q --bare "$SRC" "$T/remote.git"
  # 2 · el renombre de laboratorio: un hook que llama la máquina, un control del hook global de git y una lib que
  #     llama agent-skills. Cada uno con su reemplazo generado, su entrada en el mapa y sus llamadores al día.
  W="$T/work"; git clone -q "$T/remote.git" "$W"
  OLD_HOOK="scripts/hooks/missing-path-notice.js";    NEW_HOOK="scripts/hooks/missing-path-lab-notice.js"
  OLD_GIT="scripts/production/lint-production-json.js"; NEW_GIT="scripts/production/lint-production-json-lab.js"
  # la lib que llama agent-skills: desde la tanda C1 la real es guard-record.js y su nombre de antes es un reemplazo; el
  # laboratorio la vuelve a renombrar y lleva los DOS nombres anteriores al nuevo (agent-skills sigue llamando el más
  # viejo). El más viejo sale del mapa, nunca escrito acá: la copia pública frena un archivo que nombra una ruta vieja.
  OLD_LIB="scripts/lib/guard-record.js";              NEW_LIB="scripts/lib/guard-record-lab.js"
  OLDEST_LIB="$(node -e 'const e=require(process.argv[1]).entries.find((x)=>x.kind==="file"&&x.new==="scripts/lib/guard-record.js"); process.stdout.write(e?e.old:"")' "$RAIZ/scripts/lib/renames.json")"
  G0 "$W" mv "$OLD_HOOK" "$NEW_HOOK"; G0 "$W" mv "$OLD_GIT" "$NEW_GIT"; G0 "$W" mv "$OLD_LIB" "$NEW_LIB"
  python3 - "$W/scripts/lib/renames.json" "$OLD_HOOK" "$NEW_HOOK" "$OLD_GIT" "$NEW_GIT" "$OLD_LIB" "$NEW_LIB" "$OLDEST_LIB" <<'PY'
import json, sys
p = sys.argv[1]; m = json.load(open(p))
a = sys.argv[2:]
m["entries"] = [
  {"kind": "file", "old": a[0], "new": a[1], "batch": "lab", "callers": ["machine"]},
  {"kind": "file", "old": a[2], "new": a[3], "batch": "lab", "callers": ["machine"]},
  {"kind": "file", "old": a[4], "new": a[5], "batch": "lab", "callers": ["other-repo", "same-repo"]},
]
if a[6]:   # sin el mapa real (la copia pública) no hay un nombre más viejo que llevar
  m["entries"].append({"kind": "file", "old": a[6], "new": a[5], "batch": "lab", "callers": ["other-repo", "same-repo"]})
json.dump(m, open(p, "w"), indent=2)
PY
  ( cd "$W" && node scripts/lib/legacy-names.js --write-shims ) >/dev/null
  # los llamadores del mismo repo, al nombre nuevo (como lo haría la tanda)
  # (desde la story 8.17, W3, el nombre del hook vive en la lista única que lee el instalador, no en su texto)
  sed -i.bak "s#@tcg:missing-path-notice.js#@tcg:missing-path-lab-notice.js#" "$W/scripts/setup/hooks-list.json"
  sed -i.bak "s#$OLD_GIT#$NEW_GIT#" "$W/scripts/hooks/git-pre-commit-global.sh"
  grep -rl "guard-record.js" "$W/scripts" --include='*.js' | grep -v "/$OLD_LIB\$" | grep -v '/tests/' | while read -r f; do sed -i.bak "s#guard-record.js#guard-record-lab.js#g" "$f"; done
  find "$W" -name '*.bak' -delete
  G0 "$W" add -A && G0 "$W" commit -q -m "renombre de laboratorio" && G0 "$W" push -q origin main
  # 3 · la máquina: el arnés clonado del remoto en el sha ANTERIOR, instalado; agent-skills, el de esta máquina
  H="$T/casa"; mkdir -p "$H/.claude"
  git clone -q "$T/remote.git" "$H/.claude/tycon-claude-guides"
  G0 "$H/.claude/tycon-claude-guides" reset -q --hard HEAD~1
  ln -s "$SKILLS_REPO" "$H/.claude/agent-skills"
  GH="$H/.claude/tycon-claude-guides"
  # TF_BUILD vacío: en Azure el reemplazo escribe el warning de la corrida en stderr, y T27 compara la salida del hook viejo
  # con la del nuevo (salía rojo sólo en el nocturno, 2026-10-01). Una máquina del equipo no corre con TF_BUILD.
  INST_ENV=(TF_BUILD= TYCON_PROFILE=0 TYCON_CODEX=0 TYCON_NO_CLAUDEMD_SYNC=1 TYCON_NO_COMMANDS_SYNC=1 TYCON_NO_SQLITE_CHECK=1 TYCON_NO_THREAD_RESCUE=1
    TYCON_NO_COLLECT_FINDINGS=1 TYCON_STAGE_METRICS=0 TYCON_BENCH_DAILY=0 TYCON_NO_CANONICAL_PATH=1 TYCON_NO_BOOTSTRAP_HEAL=1
    TYCON_THIRD_PARTY=0 TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 TYCON_GIT_HOOKS_DIR="$H/.git-hooks" TYCON_GUIDES_DIR="$GH")
  en_casa() { ( fake_home_create "$H" --installer && unset TYCON_SKILLS_DIR && env "${INST_ENV[@]}" "$@" ); }
  en_casa bash "$GH/scripts/install-tycon-hooks.sh" >/dev/null 2>&1
  cmd_del_hook() { python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); print(next(h["command"] for ev in s["hooks"].values() for g in ev for h in g["hooks"] if sys.argv[2] in h["command"]))' "$H/.claude/settings.json" "$1" 2>/dev/null; }
  ENTRADA='{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls /no/such/lab-legacy-path"},"tool_response":{"stdout":"","stderr":"ls: /no/such/lab-legacy-path: No such file or directory","interrupted":false}}'
  C_OLD="$(cmd_del_hook missing-path-notice.js)"
  [ -n "$C_OLD" ] && ok "T27 antes: settings.json registra el hook con su nombre viejo" || mal "T27 antes: no encontré el hook viejo en settings.json"
  # un repo de producto de juguete, para commitear con el hook global de git
  P="$T/producto"; git init -q -b main "$P"; mkdir -p "$P/.tycon"
  commit_malo() { # un catálogo de producción mal formado: el control del hook global lo tiene que rechazar
    printf '{ "servidores": "no-es-una-lista" }\n' > "$P/.tycon/produccion.json"; G0 "$P" add -A
    ( fake_home_create "$H" && env TYCON_GUIDES_DIR="$GH" git -C "$P" -c core.hooksPath="$H/.git-hooks" -c user.email=l@l -c user.name=l commit -q -m malo ) >/dev/null 2>&1
    echo $?
  }
  # 4 · el pull de la línea de arranque, SIN el instalador todavía: los reemplazos cubren
  G0 "$GH" pull -q --ff-only
  s_old="$(printf '%s' "$ENTRADA" | en_casa bash -c "$C_OLD" 2>&1; echo "rc=$?")"
  s_new="$(printf '%s' "$ENTRADA" | en_casa node "$GH/$NEW_HOOK" 2>&1; echo "rc=$?")"
  # el aviso de ruta inexistente sale por stderr con código 2 (así lo muestra la herramienta): se compara todo, y tiene que haber aviso
  [ "$s_old" = "$s_new" ] && grep -q 'lab-legacy-path' <<<"$s_old" && ok "T27 entre el pull y el instalador: el hook con la ruta vieja corre igual que el nuevo (mismo aviso, mismo código)" \
    || mal "T27 entre pull e instalador: viejo «${s_old}» vs nuevo «${s_new}»"
  rc="$(commit_malo)"
  [ "$rc" != 0 ] && ok "T27 entre el pull y el instalador: el control del hook global (copia vieja) corrió y rechazó el catálogo malo" \
    || mal "T27 el hook global viejo no corrió el control (el commit se creó)"
  # 5 · la línea de arranque completa (pull + pull + instalador), como la corre la sesión
  en_casa bash -c "cd \"$GH\" && git pull --ff-only --autostash --quiet 2>/dev/null || true; cd \"$SKILLS_REPO\" && true; bash \"$GH/scripts/install-tycon-hooks.sh\" 2>/dev/null || true" > "$T/arranque.out"
  C_NEW="$(cmd_del_hook missing-path-lab-notice.js)"
  if [ -n "$C_NEW" ] && [ -z "$(cmd_del_hook missing-path-notice.js)" ]; then ok "T27 después del arranque: settings.json apunta al nombre nuevo y el viejo no quedó"
  else mal "T27 después del arranque: nuevo «${C_NEW}» / viejo «$(cmd_del_hook missing-path-notice.js)»"; fi
  s_after="$(printf '%s' "$ENTRADA" | en_casa bash -c "$C_NEW" 2>&1; echo "rc=$?")"
  [ "$s_after" = "$s_new" ] && ok "T27 después del arranque: el hook corrió (misma salida que el nuevo)" || mal "T27 después: «${s_after}»"
  git -C "$P" reset -q
  rc="$(commit_malo)"
  grep -q "$NEW_GIT" "$H/.git-hooks/pre-commit" && [ "$rc" != 0 ] && ok "T27 después del arranque: el hook global de git es el nuevo y su control corrió" \
    || mal "T27 hook global después: rc=$rc"
  # un control que no encuentra su archivo se saltea sin escribir en hook-errors.log
  git -C "$P" reset -q; rm -f "$P/.tycon/produccion.json"
  rm -f "$GH/scripts/ci/sql-compile.js"; echo 'SELECT 1;' > "$P/x.sql"; G0 "$P" add -A
  ( fake_home_create "$H" && env TYCON_GUIDES_DIR="$GH" git -C "$P" -c core.hooksPath="$H/.git-hooks" -c user.email=l@l -c user.name=l commit -q -m sql ) >/dev/null 2>&1
  if [ "$(git -C "$P" rev-list --count HEAD 2>/dev/null)" = 1 ] && [ ! -s "$H/.claude/.tycon-pipeline/hook-errors.log" ]; then
    ok "T27 un control sin su archivo se saltea: el commit entra y hook-errors.log queda vacío"
  else mal "T27 control sin archivo: commits=$(git -C "$P" rev-list --count HEAD 2>/dev/null) hook-errors: $(head -2 "$H/.claude/.tycon-pipeline/hook-errors.log" 2>/dev/null)"; fi
  G0 "$GH" checkout -q -- scripts/ci/sql-compile.js
  # 6 · los dos repos desfasados: agent-skills llama la lib del arnés con el nombre viejo (regla entre repos, AC 1 d)
  CIERRE="$SKILLS_REPO/skills/tycon-pipeline/scripts/lib/constancia-cierre.js"
  anota_desde_skills() { # la constancia que anota un hook de agent-skills, contra el arnés en el sha que se le pase
    G0 "$GH" checkout -q "$1"
    ( fake_home_create "$H" && env TYCON_GUIDES_DIR="$GH" node -e '
      const c = require(process.argv[1]);
      const r = c.anotarCierre({ freno: "spanish-names", regla: "clean", veredicto: "paso", huella: "lab-legacy" });
      if (!r || r.escrito === false) { console.error(JSON.stringify(r)); process.exit(1); }' "$CIERRE" ) >/dev/null 2>&1
    grep -c '"spanish-names"' "$H/.claude/.tycon-pipeline/frenos.jsonl" 2>/dev/null || echo 0
  }
  : > "$H/.claude/.tycon-pipeline/hook-errors.log"; rm -f "$H/.claude/.tycon-pipeline/frenos.jsonl"
  n1="$(anota_desde_skills HEAD~1)"; n2="$(anota_desde_skills main)"
  if [ "$n1" = 1 ] && [ "$n2" = 2 ] && [ ! -s "$H/.claude/.tycon-pipeline/hook-errors.log" ]; then
    ok "T27 agent-skills con el arnés antes y después del renombre: la constancia se anota las dos veces, sin error de carga"
  else mal "T27 cruce de repos: antes=$n1 después=$n2 hook-errors: $(head -2 "$H/.claude/.tycon-pipeline/hook-errors.log")"; fi
  # el pre-commit de agent-skills llama los frenos del arnés por ruta: con el arnés atrasado o al día, corren
  for sha in HEAD~1 main; do
    G0 "$GH" checkout -q "$sha"
    o="$( ( fake_home_create "$H" && env TYCON_GUIDES_DIR="$GH" bash -c "cd \"$SKILLS_REPO\" && sed -n '/NEW_NAMES=/p;/SPANISH_NAMES=/p' .githooks/pre-commit" ) 2>&1)"
    miss=0; for v in new-names.js spanish-names.js; do [ -f "$GH/scripts/publishing/$v" ] || miss=1; done
    [ "$miss" = 0 ] && ok "T27 pre-commit de agent-skills ($sha): los frenos que llama por ruta existen en el arnés" || mal "T27 falta un freno del arnés en $sha"
  done
  G0 "$GH" checkout -q main
fi

# ═══ T1 (parte --write-shims, story 8.12 AC 1) · un .yml que sólo nombran docs, ado y el mismo repo no pide reemplazo ═══
# Decisión del dueño (2026-10-01): una extensión sin forma de reemplazo (.yml) no exige reemplazo cuando sus llamadores
# son sólo `ado`, `docs` y `same-repo`; con `machine`, `other-repo` o `products` lo sigue exigiendo. La parte de
# --check-map la cubre T1 en legacy-names.test.js.
if corre T1; then
  T="$BASE/t1"; R="$T/repo"; mkdir -p "$R/pipelines" "$R/scripts/lab"
  echo 'trigger: none' > "$R/pipelines/lab-docs.yml"; echo 'trigger: none' > "$R/pipelines/lab-products.yml"
  echo '// nuevo' > "$R/scripts/lab/tool.js"
  mapa "$T/docs.json" '[{"kind":"file","old":"azure-pipelines-lab-docs.yml","new":"pipelines/lab-docs.yml","batch":"lab","callers":["ado","docs","same-repo"]}]'
  mapa "$T/products.json" '[{"kind":"file","old":"azure-pipelines-lab-products.yml","new":"pipelines/lab-products.yml","batch":"lab","callers":["ado","products"]}]'
  o="$( ( fake_home_create "$T/casa" && node "$LIB_JS" --write-shims --map "$T/docs.json" --root "$R" ) 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && [ ! -e "$R/azure-pipelines-lab-docs.yml" ]; then ok "T1 --write-shims: el yml con [ado, docs, same-repo] no pide reemplazo ni lo intenta"
  else mal "T1 --write-shims con [ado, docs, same-repo]: rc=$rc «${o}»"; fi
  o="$( ( fake_home_create "$T/casa" && node "$LIB_JS" --write-shims --map "$T/products.json" --root "$R" ) 2>&1)"; rc=$?
  [ "$rc" -eq 2 ] && grep -q 'no hay forma de reemplazo' <<<"$o" && ok "T1 --write-shims: el yml con [ado, products] sigue saliendo 2 «no hay forma de reemplazo»" \
    || mal "T1 --write-shims con [ado, products]: rc=$rc «${o}»"
  # needsShim, caso por caso: `docs` sólo deja de exigir reemplazo cuando la extensión no tiene forma
  o="$(node -e '
    const { needsShim } = require(process.argv[1]);
    const f = (old, callers) => needsShim({ kind: "file", old, new: "x/" + old, callers });
    const casos = [
      ["a.yml", ["docs"], false], ["a.yml", ["ado", "docs", "same-repo"], false], ["a.yml", ["machine"], true],
      ["a.yml", ["other-repo"], true], ["a.yml", ["products", "docs"], true], ["a.js", ["docs"], true], ["a.js", ["same-repo", "ado"], false],
    ];
    const malos = casos.filter(([o, c, want]) => f(o, c) !== want).map(([o, c, want]) => `${o} ${c.join("+")} → ${!want}`);
    process.stdout.write(malos.join(" · "));' "$LIB_JS" 2>&1)"
  [ -z "$o" ] && ok "T1 needsShim: docs exige reemplazo sólo si la extensión tiene forma; machine, other-repo y products siempre" || mal "T1 needsShim: $o"
fi

# ═══ T12 y T4 (story 8.12 AC 9 y AC 3) · los permisos RELATIVOS de la máquina, y el prefijo que no se reescribe dos veces ═══
# Un permiso de Claude Code escrito con la ruta relativa (`Bash(bash scripts/x.sh --check)`) no lleva ninguna forma de la
# raíz: la migración lo reescribe sólo dentro de permissions.{allow,ask,deny} de settings.json y settings.local.json, con
# borde estricto delante, sólo para entradas del arnés ya mudadas. Hooks, Codex, git hooks y plists siguen con las formas
# con raíz. HOME de juguete (fake_home_create --installer: sin examen nocturno), LaunchAgent de laboratorio.
if corre T12 || corre T4; then
  T="$BASE/t12"; H="$T/casa"; G="$T/src/guides"; S="$T/src/agent-skills"
  mkdir -p "$G/scripts/setup" "$S/scripts/tools" "$T/bin"
  for f in lab-session-hook.sh install-lab-mining.sh lab-env-publish.sh; do echo '# nuevo' > "$G/scripts/setup/$f"; done
  echo '# real, todavía sin mudar' > "$G/scripts/lab-pending.sh"
  echo '# nuevo' > "$S/scripts/tools/lab-skill.sh"
  mapa "$T/renames.json" '[
    {"kind":"file","old":"scripts/hooks/lab-session-hook.sh","new":"scripts/setup/lab-session-hook.sh","batch":"lab","callers":["machine"]},
    {"kind":"file","old":"scripts/install-lab-mining.sh","new":"scripts/setup/install-lab-mining.sh","batch":"lab","callers":["machine"]},
    {"kind":"file","old":"scripts/hooks/lab-env-publish.sh","new":"scripts/setup/lab-env-publish.sh","batch":"lab","callers":["machine"]},
    {"kind":"file","old":"scripts/lab-pending.sh","new":"scripts/setup/lab-pending.sh","batch":"lab","callers":["machine"]},
    {"kind":"file","old":"scripts/lab-skill.sh","new":"scripts/tools/lab-skill.sh","batch":"lab","repo":"agent-skills","callers":["machine"]}]'
  ( fake_home_create "$H" --installer ) || mal "T12 no pude armar la HOME de juguete"
  mkdir -p "$H/.claude" "$H/.codex" "$H/Library/LaunchAgents"
  HOOK_OLD="$G/scripts/hooks/lab-session-hook.sh"; HOOK_NEW="$G/scripts/setup/lab-session-hook.sh"
  ENV_OLD="$G/scripts/hooks/lab-env-publish.sh"; ENV_NEW="$G/scripts/setup/lab-env-publish.sh"
  cat > "$H/.claude/settings.json" <<EOF
{
  "hooks": {
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "bash \"$HOOK_OLD\"" } ] } ],
    "Stop": [ { "hooks": [ { "type": "command", "command": "bash scripts/install-lab-mining.sh --hook" } ] } ]
  },
  "permissions": {
    "allow": [
      "Bash(bash scripts/install-lab-mining.sh --check)",
      "Bash(bash scripts/install-lab-mining.sh)",
      "Bash(bash scripts/setup/install-lab-mining.sh)",
      "Bash(bash scripts/setup/install-lab-mining.sh --already)",
      "Bash(bash otros/scripts/install-lab-mining.sh)",
      "Bash(bash scripts/lab-pending.sh)",
      "Bash(bash scripts/lab-skill.sh)"
    ]
  }
}
EOF
  printf '{ "permissions": { "ask": [ "Bash(bash scripts/install-lab-mining.sh --local)" ] } }\n' > "$H/.claude/settings.local.json"
  printf '{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "bash \\"%s\\"" }, { "type": "command", "command": "bash scripts/install-lab-mining.sh --codex" } ] } ] } }\n' "$HOOK_OLD" > "$H/.codex/hooks.json"
  cat > "$H/Library/LaunchAgents/lab.legacy-names.env.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>lab.legacy-names.env</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$ENV_OLD</string></array>
</dict></plist>
EOF
  cat > "$T/bin/launchctl" <<EOF
#!/bin/sh
echo "\$*" >> "$T/launchctl.log"
case "\$*" in
  "print gui/"*"/lab.legacy-names.env") exit 0 ;;
  print*) exit 113 ;;
esac
exit 0
EOF
  chmod +x "$T/bin/launchctl"
  migrar12() { ( fake_home_create "$H" --installer && env LAUNCHCTL_BIN="$T/bin/launchctl" TYCON_LEGACY_NAMES_MAP="$T/renames.json" \
      node "$LIB_JS" --migrate-machine --guides "$G" --skills "$S" "$@" ) 2>"$T/err"; }
  LUGARES=".claude/settings.json .claude/settings.local.json .codex/hooks.json Library/LaunchAgents/lab.legacy-names.env.plist"
  : > "$T/launchctl.log"
  out="$(migrar12)"; rc=$?
  # 6 = settings.json (hook absoluto + 2 permisos relativos) + settings.local.json (1) + Codex (1) + el LaunchAgent (1)
  if corre T12; then
    [ "$rc" -eq 0 ] && grep -q '^RENAMED:6$' <<<"$out" && ok "T12 primera corrida: RENAMED:6 (hook, los dos permisos relativos, el local, Codex y el LaunchAgent)" \
      || mal "T12 primera corrida rc=$rc «$(tr '\n' ' ' <<<"$out")» $(cat "$T/err")"
    if python3 - "$H" "$HOOK_OLD" "$HOOK_NEW" "$ENV_OLD" "$ENV_NEW" <<'PY'
import json, sys
h, hook_old, hook_new, env_old, env_new = sys.argv[1:6]
s = json.load(open(f"{h}/.claude/settings.json"))
al = s["permissions"]["allow"]
assert al.count("Bash(bash scripts/setup/install-lab-mining.sh --check)") == 1, al
assert al.count("Bash(bash scripts/setup/install-lab-mining.sh)") == 1, f"el reescrito que ya estaba queda una vez: {al}"
assert "Bash(bash scripts/install-lab-mining.sh --check)" not in al and "Bash(bash scripts/install-lab-mining.sh)" not in al, al
assert "Bash(bash scripts/lab-pending.sh)" in al, "una entrada todavía sin mudar no se reescribe"
assert "Bash(bash scripts/lab-skill.sh)" in al, "una entrada de agent-skills no se reescribe en relativo"
ss = [x["command"] for g in s["hooks"]["SessionStart"] for x in g["hooks"]]
assert ss == [f'bash "{hook_new}"'], ss
st = [x["command"] for g in s["hooks"]["Stop"] for x in g["hooks"]]
assert st == ["bash scripts/install-lab-mining.sh --hook"], f"un hook relativo no se toca: {st}"
loc = json.load(open(f"{h}/.claude/settings.local.json"))
assert loc["permissions"]["ask"] == ["Bash(bash scripts/setup/install-lab-mining.sh --local)"], loc
cx = [x["command"] for ev in json.load(open(f"{h}/.codex/hooks.json"))["hooks"].values() for g in ev for x in g["hooks"]]
assert cx == [f'bash "{hook_new}"', "bash scripts/install-lab-mining.sh --codex"], f"Codex: sólo la forma con raíz: {cx}"
pl = open(f"{h}/Library/LaunchAgents/lab.legacy-names.env.plist").read()
assert env_new in pl and env_old not in pl, pl
PY
    then ok "T12 los permisos relativos (allow y ask, settings.json y .local) pasan a la ruta nueva sin duplicar; hooks y Codex sólo por la forma con raíz"
    else mal "T12 quedó mal: $(cat "$H/.claude/settings.json") / $(cat "$H/.claude/settings.local.json") / $(cat "$H/.codex/hooks.json")"; fi
    if grep -q 'bootout gui/[0-9]*/lab.legacy-names.env' "$T/launchctl.log" && grep -q 'bootstrap gui/[0-9]* .*lab.legacy-names.env.plist' "$T/launchctl.log"; then
      ok "T12 el LaunchAgent cargado se recarga"
    else mal "T12 launchctl: $(tr '\n' ' ' < "$T/launchctl.log")"; fi
    ls "$H/.claude/settings.json.bak-legacy-names-"* >/dev/null 2>&1 && ls "$H/.claude/settings.local.json.bak-legacy-names-"* >/dev/null 2>&1 \
      && ok "T12 settings.json y settings.local.json quedan respaldados al lado" || mal "T12 sin respaldo de settings"
  fi
  if corre T4; then
    if python3 - "$H/.claude/settings.json" <<'PY'
import json, sys
al = json.load(open(sys.argv[1]))["permissions"]["allow"]
assert "Bash(bash scripts/setup/install-lab-mining.sh --already)" in al, f"la ruta ya nueva, intacta: {al}"
assert "Bash(bash otros/scripts/install-lab-mining.sh)" in al, f"otro prefijo delante, intacto: {al}"
assert not any("setup/setup" in r for r in al), f"nada reescrito dos veces: {al}"
PY
    then ok "T4 un permiso con la ruta ya nueva y otro con otro prefijo delante quedan intactos; nada se reescribe dos veces"
    else mal "T4 $(cat "$H/.claude/settings.json")"; fi
  fi
  mkdir -p "$T/despues"; for f in $LUGARES; do cp "$H/$f" "$T/despues/$(basename "$f")"; done
  : > "$T/launchctl.log"
  out2="$(migrar12)"
  igual=1; for f in $LUGARES; do cmp -s "$H/$f" "$T/despues/$(basename "$f")" || igual=0; done
  for t in T12 T4; do
    corre "$t" || continue
    grep -q '^RENAMED:0$' <<<"$out2" && [ "$igual" = 1 ] && ! grep -q bootstrap "$T/launchctl.log" && ok "$t segunda corrida: RENAMED:0 y no cambia nada" \
      || mal "$t segunda corrida: «$(tr '\n' ' ' <<<"$out2")» igual=$igual"
  done
fi

# ═══ T55 (tanda E, AC 51) · la máquina vieja entera: nadie nota el cambio ════════════════════════════════════════
# Una máquina que se quedó con la configuración de antes del renombre —hooks y permisos de settings.json,
# settings.local.json, ~/.codex/hooks.json, ~/.git-hooks/*, un LaunchAgent cargado, dos interruptores de apagado con su
# nombre viejo, estados con su nombre viejo, ~/.claude/tycon.json con claves viejas y un repo de producto con su catálogo
# de producción de antes— recibe la línea de arranque REAL (la que INSTALL.md mandaba pegar) y después cada control una vez.
# Cómo se arma lo viejo sin escribir acá un solo nombre viejo: se instala una máquina nueva con esa misma línea (la
# plantilla) y se la «envejece» con el mapa, del nombre nuevo al viejo, sólo donde el viejo existe como reemplazo
# generado. Así la configuración vieja es la que el instalador de verdad escribe. Sin el mapa (la copia pública) no hay
# nada que envejecer: se dice y no corre.
# Aislamiento: HOME de juguete con TYCON_NO_NIGHTLY_EXAM=1 y sin entorno gráfico (fake_home_create --installer), un
# launchctl de mentira primero en el PATH, un engram y un claude de mentira (la línea llama a engram; un hook de Codex
# llama a claude), la subida al buzón contra un puerto cerrado, el LaunchAgent con etiqueta de laboratorio
# (lab.legacy-names.*, nunca ar.com.tycon.*) y agent-skills como CLON local del de esta máquina (la línea le hace pull).
if corre T55; then
  # la ruta FÍSICA: en macOS mktemp da /var/… y su ruta real es /private/var/…; una HOME de verdad (/Users/…) no tiene dos
  # nombres, y con dos la migración no reconoce `~/…` del clon (la prueba mediría un problema que ninguna máquina tiene)
  T="$(cd "$BASE" && pwd -P)/t55"; H="$T/casa"; mkdir -p "$T/bin" "$T/repos" "$H/src" "$H/.claude"
  MAPA="$RAIZ/scripts/lib/renames.json"
  if [ ! -f "$MAPA" ]; then
    echo "  (sin scripts/lib/renames.json — la copia pública: no hay nombres viejos que probar, T55 no corre)"
  else
    # 1 · el arnés (el árbol de trabajo de éste, en un remoto propio) y agent-skills (clon local), donde los tiene una
    #     máquina del equipo: en una carpeta de repos, con los enlaces de ~/.claude
    SRC="$T/src"; mkdir -p "$SRC"
    ( cd "$RAIZ" && git ls-files -co --exclude-standard -z | xargs -0 tar cf - 2>/dev/null ) | ( cd "$SRC" && tar xf - )
    G0() { git -C "$1" -c core.hooksPath=/dev/null -c user.email=lab@example.com -c user.name=Lab "${@:2}"; }
    git init -q -b main "$SRC" && G0 "$SRC" add -A && G0 "$SRC" commit -q -m "el arnés de hoy"
    git clone -q --bare "$SRC" "$T/remote.git"
    GH="$H/src/tycon-claude-guides"; SK="$H/src/agent-skills"
    git clone -q "$T/remote.git" "$GH"; git clone -q --local "$SKILLS_REPO" "$SK"
    ln -s "$GH" "$H/.claude/tycon-claude-guides"; ln -s "$SK" "$H/.claude/agent-skills"
    cat > "$T/bin/launchctl" <<EOF
#!/bin/sh
echo "\$*" >> "$T/launchctl.log"
case "\$*" in
  "print gui/"*"/lab.legacy-names.old-machine") exit 0 ;;
  print*) exit 113 ;;
esac
exit 0
EOF
    printf '#!/bin/sh\nexit 0\n' > "$T/bin/engram"; printf '#!/bin/sh\nexit 0\n' > "$T/bin/claude"; chmod +x "$T/bin/"*
    # la línea de arranque REAL de una máquina vieja (el SessionStart de macOS/Linux que INSTALL.md mandaba pegar a
    # mano), sin tocarla. Desde la story 8.18 INSTALL.md ya no la trae —la línea la escribe `harness.js install`—: la
    # forma conocida vive en la lista de líneas de arranque del mecanismo (`canonical-posix`).
    LINEA="$(node -e '
      const f = require(process.argv[1]).forms.find((x) => x.id === "canonical-posix");
      if (f && f.command) process.stdout.write(f.command);' "$RAIZ/scripts/tests/fixtures/startup-lines.json" 2>/dev/null)"
    [ -n "$LINEA" ] || mal "T55 no encontré la línea de arranque vieja (canonical-posix) en scripts/tests/fixtures/startup-lines.json"
    P="$T/repos/producto"; git init -q -b main "$P"
    PIPE="$H/.claude/.tycon-pipeline"
    # T55 prueba la TRANSICIÓN: el día queda fijo en la fecha de retiro del mapa (el aviso de retiro sale recién el día
    # siguiente). Con el reloj real, desde esa fecha el aviso nombraba los nombres viejos que la prueba misma anota
    # (pase adversarial de la tanda E). Sin fecha en el mapa, el día real (no hay aviso que pueda salir).
    RETIRO_MAPA="$(node -e 'const v=require(process.argv[1]).retire_after; process.stdout.write(typeof v==="string"?v:"")' "$MAPA")"
    BASE_ENV=(${RETIRO_MAPA:+TYCON_TODAY="$RETIRO_MAPA"} PATH="$T/bin:$PATH" LAUNCHCTL_BIN="$T/bin/launchctl" TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GUI_ENV=1 TF_BUILD=
      TYCON_CODEX=1 TYCON_PROFILE=0 TYCON_NO_CLAUDEMD_SYNC=1 TYCON_THIRD_PARTY=0 TYCON_BENCH_DAILY=0 TYCON_NO_DOWNLOAD_RUNS=1
      TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 TYCON_TZS_DRY_RUN=1)
    en_casa() { ( fake_home_create "$H" --installer && unset TYCON_SKILLS_DIR TYCON_GUIDES_DIR TYCON_REPOS_ROOT TYCON_LEGACY_NAMES_MAP \
        && cd "$P" && env "${BASE_ENV[@]}" "$@" ); }
    arranque() { en_casa "$@" bash -c "$LINEA"; }   # arranque [VARIABLE=valor…]
    # la tanda de fondo del arranque (rescate, hallazgos, subida) termina sola: se espera a que no quede ningún proceso
    # con la carpeta del pipeline de esta HOME en su línea de comandos
    esperar_fondo() { local i; for i in $(seq 1 150); do pgrep -f "$PIPE" >/dev/null 2>&1 || return 0; sleep 1; done; mal "T55 la tanda de fondo del arranque no terminó en 150 s"; }
    viejo_de() { node -e 'const m=require(process.argv[1]); const e=m.entries.find((x)=>x.kind===process.argv[2]&&x.new===process.argv[3]&&(!process.argv[4]||x.where===process.argv[4])); process.stdout.write(e?e.old:"")' "$MAPA" "$@"; }
    en_casa git config --global core.hooksPath "$H/.git-hooks"
    en_casa git config --global user.email lab@example.com; en_casa git config --global user.name Lab
    # ~/.claude/tycon.json con la clave de los nocturnos como se escribía antes de la tanda G (prendidos: suman hooks) y la raíz de repos
    printf '{ "integrations": { "nocturnos": true }, "paths": { "repos": "%s" } }\n' "$T/repos" > "$H/.claude/tycon.json"

    # 2 · la plantilla: la máquina nueva que deja la línea de arranque, más lo que pone un dev a mano —la línea misma como
    #     hook de SessionStart, permisos absolutos, con ~ y relativos, y un LaunchAgent— escrito con los nombres de hoy
    arranque > "$T/plantilla.out" 2>&1
    esperar_fondo
    if [ ! -s "$H/.claude/settings.json" ] || [ ! -s "$H/.codex/hooks.json" ] || [ ! -f "$H/.git-hooks/pre-commit" ]; then
      mal "T55 la plantilla no quedó instalada: $(tail -3 "$T/plantilla.out")"
    fi
    python3 - "$H/.claude/settings.json" "$H/.claude/settings.local.json" "$GH" "$LINEA" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); gh = sys.argv[3]
s.setdefault("hooks", {}).setdefault("SessionStart", []).insert(0, {"hooks": [{"type": "command", "command": sys.argv[4]}]})
s["permissions"] = {
    "allow": ["Bash(node ~/.claude/tycon-claude-guides/scripts/lib/harness-audit.js:*)",
              f"Bash(node {gh}/scripts/controls-bench/periodic-exam.js --dry-run)",
              "Bash(node scripts/controls-bench/periodic-exam.js:*)", "Bash(git status:*)"],
    "deny": ["Read(~/.claude/tycon-claude-guides/scripts/metrics/upload-runs.js)"],
}
json.dump(s, open(sys.argv[1], "w"), indent=2)
json.dump({"permissions": {"allow": [f"Bash(node {gh}/scripts/metrics/upload-runs.js --dry-run)"]}}, open(sys.argv[2], "w"), indent=2)
PY
    mkdir -p "$H/Library/LaunchAgents"
    cat > "$H/Library/LaunchAgents/lab.legacy-names.old-machine.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>lab.legacy-names.old-machine</string>
  <key>ProgramArguments</key><array><string>/usr/bin/env</string><string>node</string><string>$GH/scripts/controls-bench/periodic-exam.js</string></array>
</dict></plist>
EOF
    LUGARES=".claude/settings.json .claude/settings.local.json .codex/hooks.json .git-hooks/pre-commit .git-hooks/post-commit Library/LaunchAgents/lab.legacy-names.old-machine.plist"
    for f in $LUGARES .claude/tycon.json; do mkdir -p "$T/plantilla/$(dirname "$f")"; cp "$H/$f" "$T/plantilla/$f"; done

    # 3 · envejecer: cada ruta de hoy pasa a su nombre viejo donde el viejo existe como reemplazo generado (en las seis
    #     configuraciones; los permisos relativos también), y las claves de tycon.json a sus nombres de antes
    python3 - "$MAPA" "$GH" "$SK" "$H" $LUGARES > "$T/envejecido.json" <<'PY'
import json, os, re, sys
mapa, gh, sk, home = sys.argv[1:5]; lugares = sys.argv[5:]
m = json.load(open(mapa))
def es_reemplazo(p):
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            f.readline(); return "tycon-legacy-shim:" in f.readline()
    except OSError:
        return False
archivos, carpetas = {}, []
for e in m.get("entries", []):
    if e.get("kind") not in ("file", "folder"): continue
    repo = "agent-skills" if e.get("repo") == "agent-skills" else "arnes"
    if e["kind"] == "file": archivos[(repo, e["new"])] = e["old"]
    else: carpetas.append((repo, e["new"].rstrip("/"), e["old"].rstrip("/")))
carpetas.sort(key=lambda c: -len(c[1]))
raices = {"arnes": gh, "agent-skills": sk}
def viejo(repo, rel):
    o = archivos.get((repo, rel))
    if o and es_reemplazo(os.path.join(raices[repo], o)): return o
    for r, nuevo, antes in carpetas:
        if r == repo and rel.startswith(nuevo + "/"):
            c = antes + rel[len(nuevo):]
            if es_reemplazo(os.path.join(raices[repo], c)): return c
    return None
def formas(root, enlace):
    out = {root, os.path.realpath(root), enlace}
    for x in (root, enlace):
        rel = os.path.relpath(x, home)
        out |= {f"~/{rel}", f"$HOME/{rel}", f"${{HOME}}/{rel}"}
    return out
F = [(f, "arnes") for f in formas(gh, os.path.join(home, ".claude", "tycon-claude-guides"))
     | {"${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-claude-guides}", "$TCG", "${TCG}"}]
F += [(f, "agent-skills") for f in formas(sk, os.path.join(home, ".claude", "agent-skills"))]
F.sort(key=lambda x: -len(x[0]))
patron = re.compile("(?<![\\w.~-])(" + "|".join(re.escape(f) for f, _ in F) + ")/([\\w.@+/-]+)")
repo_de = dict(F)
relativo = re.compile("(?<![\\w.~/-])(scripts/[\\w.@+/-]+)")
cuenta = {}
def envejecer(s, lugar, permiso=False):
    def sub(mt):
        o = viejo(repo_de[mt.group(1)], mt.group(2))
        if not o: return mt.group(0)
        cuenta[lugar] = cuenta.get(lugar, 0) + 1
        return f"{mt.group(1)}/{o}"
    s = patron.sub(sub, s)
    if permiso:
        def subr(mt):
            o = viejo("arnes", mt.group(1))
            if not o: return mt.group(0)
            cuenta[lugar] = cuenta.get(lugar, 0) + 1
            return o
        s = relativo.sub(subr, s)
    return s
def recorrer(v, lugar, permiso=False):
    if isinstance(v, str): return envejecer(v, lugar, permiso)
    if isinstance(v, list): return [recorrer(x, lugar, permiso) for x in v]
    if isinstance(v, dict):
        return {k: recorrer(x, lugar, permiso or (k in ("allow", "ask", "deny") and lugar.startswith(".claude/"))) for k, x in v.items()}
    return v
for lugar in lugares:
    p = os.path.join(home, lugar)
    if lugar.endswith(".json"):
        d = json.load(open(p)); json.dump(recorrer(d, lugar), open(p, "w"), indent=2)
    else:
        t = open(p, encoding="utf-8").read(); open(p, "w", encoding="utf-8").write(envejecer(t, lugar))
# las claves de ~/.claude/tycon.json, de su nombre de hoy al de antes
viejas = {e["new"]: e["old"] for e in m.get("entries", []) if e.get("kind") == "key" and e.get("where") == "~/.claude/tycon.json"}
p = os.path.join(home, ".claude", "tycon.json"); d = json.load(open(p))
d2 = {viejas.get(k, k): v for k, v in d.items()}
cuenta[".claude/tycon.json"] = sum(1 for k in d if k in viejas)
json.dump(d2, open(p, "w"), indent=2)
print(json.dumps(cuenta))
PY
    # cada lugar con al menos un nombre viejo; los dos hooks de git cuentan juntos (el post-commit no nombra ningún
    # archivo renombrado: sólo el pre-commit tiene qué envejecer)
    sin=""; for f in .claude/settings.json .claude/settings.local.json .codex/hooks.json ".git-hooks/pre-commit .git-hooks/post-commit" \
                   Library/LaunchAgents/lab.legacy-names.old-machine.plist .claude/tycon.json; do
      python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if sum(d.get(x,0) for x in sys.argv[2].split())>0 else 1)' "$T/envejecido.json" "$f" || sin="$sin $f"
    done
    [ -z "$sin" ] && ok "T55 la configuración vieja está completa: nombres viejos en los seis lugares y en tycon.json ($(cat "$T/envejecido.json"))" \
      || mal "T55 el envejecido no tocó:$sin — la prueba no estaría probando esos lugares ($(cat "$T/envejecido.json"))"
    # los estados de antes y los interruptores con su nombre viejo; lo que dejó la plantilla en el pipeline se va (una
    # máquina vieja no tiene los registros con el nombre nuevo), salvo el sello del despliegue de Codex y el estado de
    # la instalación, que una máquina vieja también tiene
    rm -rf "$PIPE"/*.log "$PIPE"/legacy-names.jsonl "$PIPE"/legacy-names.d "$PIPE"/registros-buzon "$PIPE"/findings-seal.json "$PIPE"/file-events
    rm -f "$H/.claude/settings.json.bak"*
    E_SUBIDA="$(viejo_de state-file '~/.claude/.tycon-pipeline/upload-runs.log')"
    E_RESCATE="$(viejo_de state-file '~/.claude/.tycon-pipeline/thread-rescue.log')"
    V_SUBIDA="$(viejo_de env TYCON_NO_UPLOAD_RUNS)"; V_RESCATE="$(viejo_de env TYCON_NO_THREAD_RESCUE)"
    C_PROD="$(viejo_de config-file .tycon/production.json)"
    K_SERV="$(viejo_de key servers .tycon/production.json)"; K_AMB="$(viejo_de key environment .tycon/production.json)"
    falta=""; for v in E_SUBIDA E_RESCATE V_SUBIDA V_RESCATE C_PROD K_SERV K_AMB; do [ -n "${!v}" ] || falta="$falta $v"; done
    [ -z "$falta" ] || mal "T55 el mapa no trae el nombre viejo de:$falta"
    L_SUBIDA='línea de la subida de antes del renombre (lab-55)'; L_RESCATE='línea del rescate de antes del renombre (lab-55)'
    printf '%s\n' "$L_SUBIDA" > "$H/${E_SUBIDA#\~/}"; printf '%s\n' "$L_RESCATE" > "$H/${E_RESCATE#\~/}"
    mkdir -p "$P/.tycon"
    printf '{ "%s": [ { "host": "lab-db.example.invalid", "%s": "no-produccion" } ] }\n' "$K_SERV" "$K_AMB" > "$P/$C_PROD"
    cp "$H/.claude/settings.json" "$T/vieja-settings.json"

    # 4 · la línea de arranque real sobre la máquina vieja, con los dos interruptores puestos con su nombre viejo
    : > "$T/launchctl.log"
    arranque "$V_SUBIDA=1" "$V_RESCATE=1" > "$T/arranque.out" 2>&1
    esperar_fondo
    python3 - "$H" "$T/plantilla" $LUGARES <<'PY' > "$T/comparacion.txt" 2>&1
import json, sys, os
home, plantilla = sys.argv[1:3]; malos = []
for lugar in sys.argv[3:]:
    a, b = os.path.join(home, lugar), os.path.join(plantilla, lugar)
    if lugar.endswith(".json"):
        if json.load(open(a)) != json.load(open(b)): malos.append(lugar)
    elif open(a, encoding="utf-8").read() != open(b, encoding="utf-8").read(): malos.append(lugar)
print(" ".join(malos))
sys.exit(1 if malos else 0)
PY
    [ $? -eq 0 ] && ok "T55 después del arranque, los seis lugares quedaron iguales a los de una máquina nueva (hooks, permisos, Codex, git, LaunchAgent)" \
      || mal "T55 distintos de la máquina nueva: $(cat "$T/comparacion.txt")"
    python3 - "$H/.claude/settings.json" "$H/.claude/settings.local.json" "$T/plantilla/.claude/settings.json" "$T/plantilla/.claude/settings.local.json" <<'PY' \
      && ok "T55 ningún pedido de permiso nuevo: cada permiso viejo quedó con su ruta nueva, ni uno de más ni de menos" || mal "T55 los permisos cambiaron"
import json, sys
def perms(f): return json.load(open(f)).get("permissions", {})
for a, b in ((sys.argv[1], sys.argv[3]), (sys.argv[2], sys.argv[4])):
    pa, pb = perms(a), perms(b)
    for k in set(pa) | set(pb):
        if sorted(pa.get(k, [])) != sorted(pb.get(k, [])): print(k, pa.get(k), pb.get(k)); sys.exit(1)
PY
    if grep -q 'bootout gui/[0-9]*/lab.legacy-names.old-machine' "$T/launchctl.log" && grep -q 'bootstrap gui/[0-9]* .*lab.legacy-names.old-machine.plist' "$T/launchctl.log"; then
      ok "T55 el LaunchAgent cargado se recargó con la ruta nueva"
    else mal "T55 LaunchAgent: $(tr '\n' ' ' < "$T/launchctl.log")"; fi
    # los interruptores con su nombre viejo siguen apagando, y el estado se conserva: el registro nuevo es el de antes
    # (copiado en la primera escritura), sin una línea de la subida ni del rescate, y el viejo sigue intacto
    if [ "$(cat "$PIPE/upload-runs.log" 2>/dev/null)" = "$L_SUBIDA" ] && [ "$(cat "$PIPE/thread-rescue.log" 2>/dev/null)" = "$L_RESCATE" ]; then
      ok "T55 los dos interruptores con su nombre viejo siguen apagando, y el estado de antes pasó al nombre nuevo"
    else mal "T55 interruptores/estado: subida «$(head -c 200 "$PIPE/upload-runs.log" 2>&1)» · rescate «$(head -c 200 "$PIPE/thread-rescue.log" 2>&1)»"; fi
    [ "$(cat "$H/${E_SUBIDA#\~/}")" = "$L_SUBIDA" ] && [ "$(cat "$H/${E_RESCATE#\~/}")" = "$L_RESCATE" ] \
      && ok "T55 los registros con el nombre viejo quedan intactos hasta el retiro" || mal "T55 se tocó un registro con su nombre viejo"
    grep -q "\"old\":\"$V_SUBIDA\"" "$PIPE/legacy-names.jsonl" 2>/dev/null && grep -q "\"old\":\"$V_RESCATE\"" "$PIPE/legacy-names.jsonl" 2>/dev/null \
      && ok "T55 el uso de los dos interruptores viejos quedó anotado en legacy-names.jsonl" || mal "T55 sin anotar el uso: $(head -c 300 "$PIPE/legacy-names.jsonl" 2>&1)"
    # la configuración se entiende: las claves viejas de tycon.json (los nocturnos y la raíz de repos)
    grep -q 'prendidas:.*nightly' "$T/arranque.out" && ok "T55 tycon.json con claves viejas: la integración que prende sigue prendida" \
      || mal "T55 tycon.json viejo no se entendió: $(grep 'integraciones' "$T/arranque.out" | head -1)"
    raiz="$(en_casa node "$GH/scripts/lib/repos-root.js" --plain 2>/dev/null)"
    [ "$raiz" = "$T/repos" ] && ok "T55 tycon.json con claves viejas: la raíz de repos se lee" || mal "T55 raíz de repos «${raiz}»"

    # 5 · cada control una vez: cada hook de Claude Code y de Codex (salvo la línea de arranque, que ya corrió) con una
    #     entrada mínima de su evento, desde el repo de producto
    en_casa node - "$H/.claude/settings.json" "$H/.codex/hooks.json" "$P" "$LINEA" "$T/controles.json" "$T/controles.out" <<'JS'
const fs = require('fs'); const { spawnSync } = require('child_process');
const [settings, codex, prod, linea, salida, textos] = process.argv.slice(2);
const vistos = new Set(); const cmds = [];
for (const [lado, f] of [['claude', settings], ['codex', codex]]) {
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const [ev, gs] of Object.entries(s.hooks || {})) for (const g of gs) for (const h of g.hooks || []) {
    if ((h.type && h.type !== 'command') || h.command === linea) continue;
    const k = `${ev}\0${g.matcher || ''}\0${h.command}`;
    if (!vistos.has(k)) { vistos.add(k); cmds.push({ lado, ev, matcher: g.matcher || '', command: h.command }); }
  }
}
const herramienta = (m) => {
  const t = String(m || '').split('|')[0];
  if (/^(Edit|Write)$/.test(t)) return ['Write', { file_path: `${prod}/notas.txt`, content: 'x' }];
  if (t === 'Skill') return ['Skill', { skill: 'lab' }];
  if (/^(Task|Agent)$/.test(t)) return ['Agent', { subagent_type: 'Explore', description: 'lab', prompt: 'lab' }];
  if (t === 'Artifact') return ['Artifact', { file_path: `${prod}/no-existe.html` }];
  return ['Bash', { command: 'ls' }];
};
const out = []; let texto = '';
for (const c of cmds) {
  const [tool_name, tool_input] = herramienta(c.matcher);
  const ent = { hook_event_name: c.ev, session_id: 'lab-old-machine', cwd: prod, transcript_path: `${prod}/no-hay.jsonl`,
    source: 'startup', prompt: 'hola', tool_name, tool_input, tool_response: { stdout: '', stderr: '', interrupted: false },
    stop_hook_active: false, last_assistant_message: 'listo' };
  const r = spawnSync('/bin/bash', ['-c', c.command], { input: JSON.stringify(ent), cwd: prod, encoding: 'utf8', timeout: 45000 });
  const dicho = `${r.stdout || ''}${r.stderr || ''}`;
  texto += `${dicho}\n`;
  const scripts = (c.command.match(/\/[^\s"']+\.(?:js|sh|py)\b/g) || []);
  const faltan = scripts.filter((p) => !fs.existsSync(p));
  const reemplazos = scripts.filter((p) => { try { return /tycon-legacy-shim:/.test(fs.readFileSync(p, 'utf8').split('\n')[1] || ''); } catch { return false; } });
  let por = '';
  if (r.error) por = `no corrió (${r.error.code || r.error.message})`;
  else if (r.signal) por = `cortado por ${r.signal}`;
  else if (r.status === 127) por = 'comando no encontrado (127)';
  else if (/Cannot find module|MODULE_NOT_FOUND|No such file or directory|command not found/.test(dicho)) por = `no encontró algo: ${dicho.split('\n').find((l) => /Cannot find|No such file|not found/.test(l))}`;
  else if (faltan.length) por = `apunta a lo que no está: ${faltan.join(' ')}`;
  else if (reemplazos.length) por = `sigue apuntando a un nombre viejo: ${reemplazos.join(' ')}`;
  out.push({ lado: c.lado, ev: c.ev, matcher: c.matcher, script: (scripts[0] || c.command).split('/').slice(-2).join('/'), status: r.status, por });
}
fs.writeFileSync(salida, JSON.stringify(out, null, 1));
fs.writeFileSync(textos, texto);
JS
    python3 - "$T/controles.json" <<'PY' > "$T/controles.txt"
import json, sys
c = json.load(open(sys.argv[1])); malos = [x for x in c if x["por"]]
lados = {l: sum(1 for x in c if x["lado"] == l) for l in ("claude", "codex")}
print(f"{len(c)} {lados['claude']} {lados['codex']}")
for x in malos: print(f"  {x['lado']} {x['ev']}/{x['matcher']} {x['script']}: {x['por']}")
PY
    read -r n_ctl n_cl n_cx < "$T/controles.txt"
    if [ "${n_cl:-0}" -gt 10 ] && [ "${n_cx:-0}" -gt 5 ] && [ "$(wc -l < "$T/controles.txt" | tr -d ' ')" = 1 ]; then
      ok "T55 cada control corrió una vez: $n_ctl hooks ($n_cl de Claude Code, $n_cx de Codex), cada uno con su nombre nuevo"
    else mal "T55 controles: $(tr '\n' ' ' < "$T/controles.txt")"; fi
    # el hook global de git, con el catálogo de producción de antes: el bueno entra, el mal formado se rechaza
    G0 "$P" add -A
    ( fake_home_create "$H" && unset TYCON_GUIDES_DIR TYCON_SKILLS_DIR && cd "$P" && env PATH="$T/bin:$PATH" git commit -q -m "catálogo de antes" ) > "$T/commit-bueno.out" 2>&1; rc=$?
    [ "$rc" = 0 ] && [ "$(git -C "$P" rev-list --count HEAD 2>/dev/null)" = 1 ] \
      && ok "T55 el hook global de git entendió el catálogo de producción de antes (el commit entró)" || mal "T55 commit con el catálogo de antes: rc=$rc $(tail -3 "$T/commit-bueno.out")"
    printf '{ "%s": "no-es-una-lista" }\n' "$K_SERV" > "$P/$C_PROD"; G0 "$P" add -A
    ( fake_home_create "$H" && unset TYCON_GUIDES_DIR TYCON_SKILLS_DIR && cd "$P" && env PATH="$T/bin:$PATH" git commit -q -m "catálogo roto" ) > "$T/commit-malo.out" 2>&1; rc=$?
    [ "$rc" != 0 ] && [ "$(git -C "$P" rev-list --count HEAD 2>/dev/null)" = 1 ] \
      && ok "T55 y su control corrió: el catálogo mal formado se rechaza" || mal "T55 el catálogo roto entró (rc=$rc)"
    git -C "$P" checkout -q -- . 2>/dev/null; git -C "$P" reset -q 2>/dev/null
    # el LaunchAgent: su guion es el nuevo, de verdad (no un reemplazo)
    agente="$(sed -n 's#.*<string>\([^<]*periodic-exam[^<]*\)</string>.*#\1#p' "$H/Library/LaunchAgents/lab.legacy-names.old-machine.plist")"
    [ -f "$agente" ] && ! sed -n 2p "$agente" | grep -q 'tycon-legacy-shim:' && ok "T55 el LaunchAgent apunta al guion nuevo, que existe" || mal "T55 LaunchAgent apunta a «${agente}»"
    # check-hook-coverage.js y la paridad Claude↔Codex, en esa HOME
    ( fake_home_create "$H" && unset TYCON_GUIDES_DIR TYCON_SKILLS_DIR && node "$GH/build/check-hook-coverage.js" ) > "$T/cobertura.out" 2>&1 \
      && ok "T55 check-hook-coverage.js verde en la máquina migrada" || mal "T55 check-hook-coverage.js: $(tail -5 "$T/cobertura.out" | tr '\n' ' ')"
    # La paridad mide el despliegue de Codex en esa HOME (hooks, revisores, skills, MCP, AGENTS.md…) y además cuatro
    # cosas que una HOME de juguete no puede tener y que el renombre no toca: el login de `codex`, la aprobación de los
    # hooks por hash (se hace en una sesión interactiva con /hooks), la llave en el rc del dev y los servidores MCP que
    # el dev registró. Ésas se dejan afuera, nombradas; cualquier otro rojo es de la migración.
    ( fake_home_create "$H" && unset TYCON_GUIDES_DIR TYCON_SKILLS_DIR && env PATH="$T/bin:$PATH" TYCON_CODEX=1 TYCON_NO_CLAUDEMD_SYNC=1 \
        TYCON_PARITY_BENCH_DIR="$T/paridad-bench" node "$GH/scripts/lib/harness-audit.js" --parity --json ) > "$T/paridad.json" 2>"$T/paridad.err"
    python3 - "$T/paridad.json" <<'PY' > "$T/paridad.txt"
import json, sys
FUERA = {"codex-cli", "trust", "llave-en-rc", "tabla-vs-realidad"}
r = json.load(open(sys.argv[1])); s = r.get("surfaces", [])
rojos = [x for x in s if not x.get("ok") and x.get("name") not in FUERA]
hooks = [x for x in s if x.get("name") == "hooks"]
print("ok" if r.get("deployed") and hooks and hooks[0].get("ok") and not rojos else "mal",
      " · ".join(f"{x['name']}: {x.get('detail', '')}" for x in rojos) or (hooks[0].get("detail", "") if hooks else "sin superficie hooks"))
PY
    if [ "$(cut -d' ' -f1 "$T/paridad.txt")" = ok ]; then
      ok "T55 harness-audit.js --parity verde en la máquina migrada, salvo login, aprobación por hash, rc y MCP del dev (no se pueden en una HOME de juguete)"
    else mal "T55 --parity: $(cut -d' ' -f2- "$T/paridad.txt") $(head -c 300 "$T/paridad.err")"; fi
    # nada de lo que se imprimió nombra un nombre viejo (archivos, carpetas, variables, opciones, archivos de
    # configuración y de estado; las claves y los subcomandos son palabras que la prosa usa y no se buscan)
    cat "$T/arranque.out" "$T/controles.out" "$T/commit-bueno.out" > "$T/todo.out"
    node - "$MAPA" "$T/todo.out" <<'JS' > "$T/viejos.txt"
const fs = require('fs'); const path = require('path');
const m = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); const txt = fs.readFileSync(process.argv[3], 'utf8');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hits = [];
for (const e of m.entries || []) {
  if (typeof e.old !== 'string') continue;
  let re = null;
  // detrás de una `/` también: una ruta absoluta que termina en la ruta vieja la nombra (`subir-x.js` no es `x.js`: el `-`)
  if (e.kind === 'file') re = new RegExp(`(^|[^\\w.-])${esc(e.old)}(?![\\w-])`);
  else if (e.kind === 'folder') re = new RegExp(`(^|[^\\w.-])${esc(e.old.replace(/\/+$/, ''))}/`);
  else if (e.kind === 'env') re = new RegExp(`(^|[^\\w])${esc(e.old)}(?!\\w)`);
  else if (e.kind === 'option') re = new RegExp(`(^|[^\\w-])--${esc(e.old.replace(/^-+/, ''))}(?![\\w-])`);
  else if (e.kind === 'config-file' || e.kind === 'state-file') re = new RegExp(`(^|[^\\w.-])${esc(path.basename(e.old))}(?![\\w-])`);
  const mt = re && re.exec(txt);
  if (mt) hits.push(`${e.kind} «${e.old}»: …${txt.slice(Math.max(0, mt.index - 50), mt.index + 70).replace(/\s+/g, ' ')}…`);
}
process.stdout.write(hits.join('\n'));
JS
    [ ! -s "$T/viejos.txt" ] && ok "T55 nada de lo que se imprimió (arranque, controles, commit) nombra un nombre viejo" \
      || mal "T55 se imprimió un nombre viejo: $(head -5 "$T/viejos.txt" | tr '\n' ' ')"

    # 6 · el contraste: el mismo arranque sin los interruptores sube y rescata (si no, «siguen apagando» no probaría
    #     nada), y la configuración ya migrada no cambia
    for f in $LUGARES; do mkdir -p "$T/migrada/$(dirname "$f")"; cp "$H/$f" "$T/migrada/$f"; done
    arranque > "$T/arranque2.out" 2>&1
    esperar_fondo
    if [ "$(grep -c . "$PIPE/upload-runs.log" 2>/dev/null)" -gt 1 ] && [ "$(cat "$PIPE/thread-rescue.log" 2>/dev/null)" != "$L_RESCATE" ]; then
      ok "T55 contraste: sin los interruptores, la subida y el rescate corren"
    else mal "T55 contraste: sin los interruptores no corrieron (subida: $(tail -1 "$PIPE/upload-runs.log" 2>&1 | head -c 120))"; fi
    igual=1; for f in $LUGARES; do cmp -s "$H/$f" "$T/migrada/$f" || igual=0; done
    [ "$igual" = 1 ] && ! grep -q 'reescrib' "$T/arranque2.out" && ok "T55 el segundo arranque no cambia nada de la configuración" \
      || mal "T55 el segundo arranque cambió la configuración: $(grep -i 'reescrib' "$T/arranque2.out" | head -2)"
  fi
fi

echo
if [ "$FALLOS" -eq 0 ]; then echo "✅ legacy-names-install: todo verde"; exit 0; fi
echo "❌ legacy-names-install: $FALLOS en rojo"; exit 1
