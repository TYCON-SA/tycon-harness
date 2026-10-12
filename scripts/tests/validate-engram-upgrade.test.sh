#!/usr/bin/env bash
# validate-engram-upgrade.test.sh — un repo que no se pudo validar no cuenta como validado (story 8.12, pendiente SILENT-W2).
#
# La falla que caza: `TYCON_ENGRAM_TEST_REPOS` trae un repo extra que no existe (o una carpeta que no es un repo) y el
# guion igual dice «✓» y «VERDE — se puede propagar». Un repo que no se pudo leer es «no pude validar»: el guion tiene
# que nombrarlo con «✗» y salir distinto de 0.
#
# Cómo mide: HOME de laboratorio, `env -i` (ninguna TYCON_* de quien corre se cuela), TYCON_ENGRAM=1 (la integración se
# prende por variable) y un `engram` DE MENTIRA delante de /usr/bin:/bin que contesta la versión pedida y anota cada
# llamada. Los repos son de laboratorio: uno con git, uno que no existe y una carpeta suelta sin git.
# 🔴 Nada acá toca el engram real de la máquina ni un repo del equipo: el engram de mentira no escribe nada.
# Rojo previo (2026-10-02, antes del arreglo): con el repo inexistente el guion salía 0 con «✓ repo-fantasma».
# Correr: bash scripts/tests/validate-engram-upgrade.test.sh   (~2 s)

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUION="$RAIZ/scripts/setup/validate-engram-upgrade.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FALLOS=0; TOTAL=0
ok() { TOTAL=$((TOTAL+1)); echo "✅ validate-engram-upgrade: $1"; }
no() { TOTAL=$((TOTAL+1)); FALLOS=$((FALLOS+1)); echo "❌ validate-engram-upgrade: $1"; }

# ── el laboratorio ────────────────────────────────────────────────────────────────────────────────
mkdir -p "$T/home" "$T/bin"
LLAMADAS="$T/llamadas.log"; : > "$LLAMADAS"
cat > "$T/bin/engram" <<'EOF'
#!/bin/sh
echo "engram $* (en $(pwd))" >> "${LLAMADAS:?}"
case "$1" in
  version) echo "engram version 9.9.9" ;;
  sync) echo "imported 0 chunks" ;;
  search) echo "[1] memoria de laboratorio" ;;
esac
exit 0
EOF
chmod +x "$T/bin/engram"
ln -s "$(command -v node)" "$T/bin/node"
mkdir -p "$T/repo-bueno" "$T/carpeta-suelta"
git -C "$T/repo-bueno" init -q

correr() { # <repos extra> → corre el guion en el laboratorio; deja SAL y RC
  SAL="$(env -i HOME="$T/home" PATH="$T/bin:/usr/bin:/bin" LLAMADAS="$LLAMADAS" TYCON_ENGRAM=1 \
    TYCON_NO_NIGHTLY_EXAM=1 TARGET=9.9.9 TYCON_ENGRAM_TEST_REPOS="$1" bash "$GUION" 2>&1)"; RC=$?
}

# ── control positivo: con un repo extra que existe, verde ─────────────────────────────────────────
correr "$T/repo-bueno"
if [ "$RC" = 0 ] && printf '%s\n' "$SAL" | grep -q "✓ repo-bueno"; then
  ok "con un repo extra que existe, sale 0 y lo da por validado"
else
  no "control: esperaba rc=0 y «✓ repo-bueno»; rc=$RC — salida: $SAL"
fi

# ── un repo extra que no existe: no pude validar ──────────────────────────────────────────────────
correr "$T/repo-bueno $T/repo-fantasma"
if [ "$RC" != 0 ] && printf '%s\n' "$SAL" | grep -q "✗ repo-fantasma" \
   && ! printf '%s\n' "$SAL" | grep -q "✓ repo-fantasma" && printf '%s\n' "$SAL" | grep -q "RESULTADO: ROJO"; then
  ok "un repo extra que no existe sale distinto de 0 y lo nombra"
else
  no "repo inexistente: esperaba rc≠0, «✗ repo-fantasma» y ROJO; rc=$RC — salida: $SAL"
fi

# ── una carpeta que no es un repo: tampoco cuenta como validada ───────────────────────────────────
correr "$T/carpeta-suelta"
if [ "$RC" != 0 ] && printf '%s\n' "$SAL" | grep -q "✗ carpeta-suelta" \
   && ! printf '%s\n' "$SAL" | grep -q "✓ carpeta-suelta"; then
  ok "una carpeta que no es un repo sale distinto de 0 y la nombra"
else
  no "carpeta sin git: esperaba rc≠0 y «✗ carpeta-suelta»; rc=$RC — salida: $SAL"
fi

# ── el engram de mentira nunca se llamó desde una carpeta que no se pudo validar ─────────────────
if grep -qE "/(repo-fantasma|carpeta-suelta)\)$" "$LLAMADAS"; then
  no "se llamó a engram dentro de una carpeta que no es un repo: $(cat "$LLAMADAS")"
else
  ok "engram no se llamó dentro de lo que no se pudo validar"
fi

# ── un arnés que no lleva memoria (la copia pública) no exige el índice de la memoria (story 8.7) ──
# La falla que caza: el paso 4 leía `.engram/manifest.json` del arnés, el índice REAL de la memoria del equipo. La copia
# pública no lo trae (nace con la memoria apagada), así que ahí el guion terminaba SIEMPRE en ROJO y los tres casos de
# arriba que esperan «distinto de 0» pasaban por el motivo equivocado. Un arnés sin `.engram-project` ni `.engram/` no
# lleva memoria: se dice, no se sincroniza nada adentro (eso le crearía una memoria) y no cuenta como rojo.
# El espejo: un arnés que SÍ declara memoria y no tiene el índice sigue en ROJO, como hoy.
# Rojo previo (2026-10-03, antes del arreglo): el arnés sin memoria salía 1 con «manifest cambió a version».
lab_harness() { # <carpeta> → un arnés de laboratorio: el guion, sus bibliotecas y un repo git vacío
  mkdir -p "$1/scripts/setup"
  cp "$GUION" "$1/scripts/setup/"; cp -R "$RAIZ/scripts/lib" "$1/scripts/lib"
  git -C "$1" init -q
}
run_lab() { # <arnés de laboratorio> → corre SU guion, sin repos extra; deja SAL y RC
  SAL="$(env -i HOME="$T/home" PATH="$T/bin:/usr/bin:/bin" LLAMADAS="$LLAMADAS" TYCON_ENGRAM=1 \
    TYCON_NO_NIGHTLY_EXAM=1 TARGET=9.9.9 bash "$1/scripts/setup/validate-engram-upgrade.sh" 2>&1)"; RC=$?
}
lab_harness "$T/arnes-sin-memoria"
: > "$LLAMADAS"; run_lab "$T/arnes-sin-memoria"
if [ "$RC" = 0 ] && printf '%s\n' "$SAL" | grep -q "no lleva memoria" && printf '%s\n' "$SAL" | grep -q "RESULTADO: VERDE" \
   && ! grep -qE "^engram sync --project .*arnes-sin-memoria\)$" "$LLAMADAS" && [ ! -e "$T/arnes-sin-memoria/.engram" ]; then
  ok "un arnés que no lleva memoria sale 0, lo dice y no sincroniza nada adentro"
else
  no "arnés sin memoria: esperaba rc=0, «no lleva memoria» y ninguna sincronización adentro; rc=$RC — salida: $SAL — llamadas: $(cat "$LLAMADAS")"
fi
lab_harness "$T/arnes-con-memoria"; echo "lab" > "$T/arnes-con-memoria/.engram-project"
run_lab "$T/arnes-con-memoria"
if [ "$RC" != 0 ] && printf '%s\n' "$SAL" | grep -q "RESULTADO: ROJO" && printf '%s\n' "$SAL" | grep -q "✗ manifest"; then
  ok "un arnés que declara memoria y no tiene el índice sigue en ROJO"
else
  no "arnés con memoria y sin índice: esperaba rc≠0, «✗ manifest» y ROJO; rc=$RC — salida: $SAL"
fi

echo "validate-engram-upgrade: $((TOTAL-FALLOS))/$TOTAL"
[ "$FALLOS" = 0 ]
