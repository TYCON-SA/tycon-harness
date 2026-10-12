#!/usr/bin/env bash
# fake-home.test.sh — red del ayudante `scripts/tests/lib/fake-home.sh` (story 7.16).
#
# Caso que lo motiva (story 7.15, 2026-09-29): cuatro suites dejaban constancias falsas en los registros
# reales del dev (`gates.log`, `frenos.jsonl`, `new-names.jsonl`, `reviewer-rules.jsonl`); `frenos.jsonl`
# sube al buzón y alimenta el tablero. Cada suite armaba su carpeta personal falsa a mano y a su manera, y
# olvidarse un paso ensuciaba la máquina sin avisar. El ayudante la arma siempre igual; esta suite prueba
# que la arma, que se niega a usar la real y que la cuenta con evidencia POSITIVA.
#
# 🔴 Esta suite tampoco toca la HOME real: cada caso corre en una subshell con una HOME «real» de
#    mentira armada acá, así lo que el ayudante resuelve «con la HOME real» se puede afirmar.
#
# Correr: bash scripts/tests/fake-home.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$AQUI/scripts/tests/lib/fake-home.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; casos=0
ok(){ casos=$((casos+1)); echo "✅ fake-home: $1"; }
no(){ casos=$((casos+1)); echo "❌ fake-home: $1"; fallos=$((fallos+1)); }

# Una HOME «real» de mentira, con el arnés y agent-skills donde los busca una máquina del equipo.
LAB="$TMP/real"
mkdir -p "$LAB/.claude/tycon-harness" "$LAB/.claude/agent-skills/skills"
LAB_VACIA="$TMP/real-vacia"; mkdir -p "$LAB_VACIA"

# en_lab <home-real> <script>: corre <script> en una subshell limpia (sin las variables del ayudante),
# con HOME=<home-real> y el ayudante cargado. Imprime lo que el script imprima.
# 🔴 Con `set -uo pipefail`, como las suites que lo cargan: sin eso, un «$var» pegado a un carácter no ASCII
#    (que el bash 3.2 de macOS con locale UTF-8 lee como otro nombre de variable) pasaba acá y tumbaba las
#    suites de verdad con «unbound variable» (pase adversarial de la 7.16).
en_lab(){
  env -u FAKE_HOME -u REAL_HOME -u TYCON_GUIDES_DIR -u TYCON_SKILLS_DIR -u LAUNCHCTL_BIN \
      -u TYCON_NO_NIGHTLY_EXAM -u TYCON_NO_GUI_ENV HOME="$1" HELPER="$HELPER" \
      bash -c 'set -uo pipefail; source "$HELPER" || exit 90; '"$2"
}

# ── T1 · arma el árbol y las variables ───────────────────────────────────────────────────────────
salida="$(en_lab "$LAB" 'fake_home_create "'"$TMP"'/t1/casa" || exit 91
  [ -d "$HOME/.claude/.tycon-pipeline" ] && echo arbol
  echo "home=$HOME"; echo "fake=$FAKE_HOME"; echo "real=$REAL_HOME"' 2>&1)"
if printf '%s\n' "$salida" | grep -qx arbol \
   && printf '%s\n' "$salida" | grep -qx "home=$TMP/t1/casa" \
   && printf '%s\n' "$salida" | grep -qx "fake=$TMP/t1/casa" \
   && printf '%s\n' "$salida" | grep -qx "real=$LAB"; then
  ok "T1 arma .claude/.tycon-pipeline/ y deja HOME=FAKE_HOME=<dir>, REAL_HOME=la de antes"
else no "T1 no armó el árbol o las variables — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

# T1b · una segunda llamada re-apunta la HOME falsa y CONSERVA la real (una carpeta por caso).
salida="$(en_lab "$LAB" 'fake_home_create "'"$TMP"'/t1b/uno" && fake_home_create "'"$TMP"'/t1b/dos" || exit 91
  echo "home=$HOME"; echo "real=$REAL_HOME"' 2>&1)"
if printf '%s\n' "$salida" | grep -qx "home=$TMP/t1b/dos" && printf '%s\n' "$salida" | grep -qx "real=$LAB"; then
  ok "T1b una segunda llamada re-apunta la HOME falsa y la real sigue siendo la de antes"
else no "T1b la segunda llamada perdió la HOME real — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

# ── T2 · fija el arnés y agent-skills con lo que resolvían bajo la HOME real ─────────────────────
salida="$(en_lab "$LAB" 'fake_home_create "'"$TMP"'/t2/casa" || exit 91
  echo "guias=${TYCON_GUIDES_DIR:-}"; echo "skills=${TYCON_SKILLS_DIR:-}"' 2>&1)"
if printf '%s\n' "$salida" | grep -qx "guias=$LAB/.claude/tycon-harness" \
   && printf '%s\n' "$salida" | grep -qx "skills=$LAB/.claude/agent-skills/skills"; then
  ok "T2 sin variables puestas, TYCON_GUIDES_DIR y TYCON_SKILLS_DIR quedan con lo de la HOME real"
else no "T2 no fijó el arnés/agent-skills de la HOME real — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

salida="$(en_lab "$LAB" 'export TYCON_GUIDES_DIR=/otro/arnes TYCON_SKILLS_DIR=/otro/skills
  fake_home_create "'"$TMP"'/t2b/casa" || exit 91
  echo "guias=$TYCON_GUIDES_DIR"; echo "skills=$TYCON_SKILLS_DIR"' 2>&1)"
if printf '%s\n' "$salida" | grep -qx "guias=/otro/arnes" && printf '%s\n' "$salida" | grep -qx "skills=/otro/skills"; then
  ok "T2b con las variables ya puestas (una sesión en un clon), no las toca"
else no "T2b pisó las variables que ya estaban puestas — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

salida="$(en_lab "$LAB_VACIA" 'fake_home_create "'"$TMP"'/t2c/casa" || exit 91
  echo "guias=${TYCON_GUIDES_DIR-SIN}"; echo "skills=${TYCON_SKILLS_DIR-SIN}"' 2>&1)"
if printf '%s\n' "$salida" | grep -qx "guias=SIN" && printf '%s\n' "$salida" | grep -qx "skills=SIN"; then
  ok "T2c si la HOME real no tiene el arnés ni agent-skills, no inventa una ruta"
else no "T2c inventó una ruta que no existe — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

# ── T3 · el modo instalador ──────────────────────────────────────────────────────────────────────
salida="$(en_lab "$LAB" 'fake_home_create "'"$TMP"'/t3/casa" --installer || exit 91
  echo "nocturno=${TYCON_NO_NIGHTLY_EXAM:-}"; echo "gui=${TYCON_NO_GUI_ENV:-}"
  [ -n "${LAUNCHCTL_BIN:-}" ] && [ -x "$LAUNCHCTL_BIN" ] && "$LAUNCHCTL_BIN" list >/dev/null && echo launchctl-ok
  case "${LAUNCHCTL_BIN:-}" in "$FAKE_HOME"/*) echo launchctl-en-falsa ;; esac' 2>&1)"
if printf '%s\n' "$salida" | grep -qx "nocturno=1" && printf '%s\n' "$salida" | grep -qx "gui=1" \
   && printf '%s\n' "$salida" | grep -qx launchctl-ok && printf '%s\n' "$salida" | grep -qx launchctl-en-falsa; then
  ok "T3 con --installer: launchctl de mentira dentro de la HOME falsa, TYCON_NO_NIGHTLY_EXAM=1, TYCON_NO_GUI_ENV=1"
else no "T3 el modo instalador no exportó las tres — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

salida="$(en_lab "$LAB" 'fake_home_create "'"$TMP"'/t3b/casa" || exit 91
  echo "vars=${LAUNCHCTL_BIN-}${TYCON_NO_NIGHTLY_EXAM-}${TYCON_NO_GUI_ENV-}"' 2>&1)"
if printf '%s\n' "$salida" | grep -qx "vars="; then ok "T3b sin --installer no exporta ninguna de las tres"
else no "T3b sin la bandera exportó variables del instalador — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

# ── T4 · la cuenta es evidencia positiva ─────────────────────────────────────────────────────────
salida="$(en_lab "$LAB" 'fake_home_create "'"$TMP"'/t4/casa" || exit 91
  R="$FAKE_HOME/.claude/.tycon-pipeline/frenos.jsonl"
  printf "%s\n" "{\"freno\":\"acme-freno\",\"x\":1}" "{\"freno\":\"otro\"}" "{\"freno\":\"acme-freno\",\"x\":2}" > "$R"
  echo "n=$(fake_home_count frenos.jsonl "\"freno\":\"acme-freno\"")"' 2>&1)"
if printf '%s\n' "$salida" | grep -qx "n=2"; then ok "T4 fake_home_count cuenta las líneas con el texto en el registro de la HOME falsa (2)"
else no "T4 la cuenta no dio 2 — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

# T4b · el texto se toma literal: un punto o un corchete no son comodines.
salida="$(en_lab "$LAB" 'fake_home_create "'"$TMP"'/t4b/casa" || exit 91
  printf "%s\n" "a.b" "axb" "[c]" > "$FAKE_HOME/.claude/.tycon-pipeline/gates.log"
  echo "punto=$(fake_home_count gates.log a.b)"; echo "corchete=$(fake_home_count gates.log "[c]")"' 2>&1)"
if printf '%s\n' "$salida" | grep -qx "punto=1" && printf '%s\n' "$salida" | grep -qx "corchete=1"; then
  ok "T4b el texto se busca literal (un punto no cuenta «axb»)"
else no "T4b el texto se tomó como patrón — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

# ── T5 · se niega: sin argumento, con la HOME real, con una carpeta que no se puede crear ────────
: > "$TMP/soy-un-archivo"
for caso in "sin-argumento|" "home-real|$LAB" "home-real-con-barra|$LAB/" "bajo-un-archivo|$TMP/soy-un-archivo/casa"; do
  nombre="${caso%%|*}"; dir="${caso#*|}"
  salida="$(en_lab "$LAB" 'if [ -n "'"$dir"'" ]; then fake_home_create "'"$dir"'"; else fake_home_create; fi; rc=$?
    echo "rc=$rc"; echo "home=$HOME"; echo "fake=${FAKE_HOME-SIN}"' 2>&1)"
  rc_linea="$(printf '%s\n' "$salida" | grep '^rc=')"
  if [ "$rc_linea" != "rc=0" ] && printf '%s\n' "$salida" | grep -qx "home=$LAB" \
     && printf '%s\n' "$salida" | grep -qx "fake=SIN" && printf '%s\n' "$salida" | grep -q 'fake-home:'; then
    ok "T5 ($nombre) falla con motivo y deja HOME en la real, sin FAKE_HOME a medio armar"
  else no "T5 ($nombre) no se negó como debía — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi
done

# T5c · el motivo nombra la carpeta (con locale UTF-8, donde el bash 3.2 de macOS partía «$dir»).
salida="$(en_lab "$LAB" 'export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; fake_home_create "'"$LAB"'"; echo "rc=$?"' 2>&1)"
if printf '%s\n' "$salida" | grep -qx 'rc=1' && printf '%s\n' "$salida" | grep -qF "«${LAB}» es la HOME real"; then
  ok "T5c con locale UTF-8, el motivo nombra la carpeta y sale 1 (no «unbound variable»)"
else no "T5c el mensaje de la HOME real se rompió con UTF-8 — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

# T5d · una ruta RELATIVA se rechaza: depende del directorio actual, y desde la HOME real crearía una carpeta
# suelta adentro de ella (pase adversarial de la 7.16).
salida="$(en_lab "$LAB" 'cd "$HOME" && fake_home_create casa-relativa; echo "rc=$?"; echo "home=$HOME"' 2>&1)"
if ! printf '%s\n' "$salida" | grep -qx 'rc=0' && printf '%s\n' "$salida" | grep -qx "home=$LAB" \
   && [ ! -e "$LAB/casa-relativa" ] && printf '%s\n' "$salida" | grep -q 'fake-home:.*absoluta'; then
  ok "T5d una ruta relativa se rechaza con motivo y no crea nada adentro de la HOME real"
else no "T5d aceptó una ruta relativa — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

# T5b · fake_home_count sin una HOME falsa armada no cuenta en la real: falla.
salida="$(en_lab "$LAB" 'fake_home_count frenos.jsonl x; echo "rc=$?"' 2>&1)"
if printf '%s\n' "$salida" | grep -q '^rc=[1-9]' && printf '%s\n' "$salida" | grep -q 'fake-home:'; then ok "T5b fake_home_count sin HOME falsa armada falla (no cuenta en la real)"
else no "T5b fake_home_count contó sin HOME falsa — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

# ── T6 · un registro que no existe cuenta 0 ──────────────────────────────────────────────────────
salida="$(en_lab "$LAB" 'fake_home_create "'"$TMP"'/t6/casa" || exit 91
  n="$(fake_home_count no-existe.jsonl algo)"; echo "rc=$?"; echo "n=$n"' 2>&1)"
if printf '%s\n' "$salida" | grep -qx "rc=0" && printf '%s\n' "$salida" | grep -qx "n=0"; then
  ok "T6 un registro que no existe cuenta 0, exit 0 (el caso que no escribió se ve como «0 líneas»)"
else no "T6 el registro inexistente no dio 0 con exit 0 — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

# ── T14 · no se escapa de donde lo llamaron ──────────────────────────────────────────────────────
salida="$(en_lab "$LAB" '( fake_home_create "'"$TMP"'/t14/casa" --installer >/dev/null ) || exit 91
  echo "home=$HOME"; echo "resto=${FAKE_HOME-}${REAL_HOME-}${LAUNCHCTL_BIN-}${TYCON_NO_NIGHTLY_EXAM-}${TYCON_NO_GUI_ENV-}"' 2>&1)"
if printf '%s\n' "$salida" | grep -qx "home=$LAB" && printf '%s\n' "$salida" | grep -qx "resto="; then
  ok "T14 llamado en una subshell, afuera HOME y las variables del ayudante quedan como antes"
else no "T14 el ayudante se escapó de la subshell — salida: $(printf '%s' "$salida" | tr '\n' '|' | head -c 300)"; fi

echo "─────────────"
[ "$fallos" -eq 0 ] && { echo "✅ fake-home: todo verde ($casos casos)"; exit 0; } || { echo "❌ fake-home: $fallos falla(s) de $casos"; exit 1; }
