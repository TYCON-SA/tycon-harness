#!/usr/bin/env bash
# validate-engram-upgrade.sh — corré esto ANTES de bumpear `engram-version`.
# Lo que importa: las memorias ya commiteadas (las escribió la versión vieja) tienen que
# seguir siendo legibles, y las nuevas tienen que quedar en el mismo formato. Si esto da
# rojo, NO bumpees: propagarías una versión que parte la memoria del equipo en dos, y la
# falla es silenciosa (nadie ve un error, simplemente dejan de aparecer memorias).
#
# Uso: TARGET=1.21.0 bash scripts/setup/validate-engram-upgrade.sh
set -uo pipefail
FAIL=0
ok(){ echo "  ✓ $1"; }
bad(){ echo "  ✗ $1"; FAIL=1; }

# engram (story 8.3, AC 10): con la integración apagada no hay versión que validar — lo dice y sale 0; configuración rota → sale 2.
CFG="$(cd "$(dirname "$0")/.." && pwd)/lib/tycon-config.js"
if [ -f "$CFG" ] && command -v node >/dev/null 2>&1; then
  ESTADO="$(node "$CFG" key engram 2>&1)"; rc=$?
  if [ "$rc" = 2 ]; then echo "$ESTADO" >&2; exit 2; fi
  if [ "$rc" = 3 ]; then echo "engram apagado en esta máquina — no hay versión que validar (prender: integrations.engram=true en ~/.claude/tycon.json o TYCON_ENGRAM=1)"; exit 0; fi
fi

echo "== 1. versión =="
TARGET="${TARGET:-$(grep -vE '^#|^$' "$(dirname "$0")/../../engram-version" | head -1 | tr -d ' ')}"
V="$(engram version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
[ "$V" = "$TARGET" ] && ok "engram $V" || bad "esperaba $TARGET, hay ${V:-nada}"

echo "== 2. leer chunks escritos por 1.12 (import) =="
# El arnés, por la ubicación de este script; otros repos con memoria, por variable (story 8.3: nada escrito a mano).
ARNES="$(cd "$(dirname "$0")/../.." && pwd)"
# La variable renombrada a inglés (story 8.9): el nombre viejo sigue valiendo hasta el retiro.
. "${ARNES}/scripts/lib/legacy-names.sh"
legacy_env TYCON_ENGRAM_TEST_REPOS
for R in "$ARNES" ${TYCON_ENGRAM_TEST_REPOS:-}; do
  # story 8.12 (SILENT-W2): un repo que no existe o no es un repo es «no pude validar», nunca un ✓.
  if [ ! -d "$R" ] || ! git -C "$R" rev-parse --git-dir >/dev/null 2>&1; then
    bad "$(basename "$R"): no existe o no es un repo ($R) — no pude validar"
    continue
  fi
  OUT="$(cd "$R" && engram sync --import 2>&1)"
  if echo "$OUT" | grep -iE "error|panic|failed|corrupt|unsupported" >/dev/null; then
    bad "$(basename $R): $(echo "$OUT" | head -2 | tr '\n' ' ')"
  else
    ok "$(basename $R): $(echo "$OUT" | grep -iE 'chunk|import' | head -1)"
  fi
done

echo "== 3. las memorias viejas siguen apareciendo =="
N="$(engram search --project tycon "harness" 2>/dev/null | grep -cE '^\[|#[0-9]+' || true)"
[ "${N:-0}" -gt 0 ] && ok "search encuentra $N resultados en 'tycon'" \
  || bad "search no devolvió nada — REVISAR ANTES DE PROPAGAR"

echo "== 4. escribir con 1.20 y ver el formato del manifest =="
# Un arnés que no lleva memoria —sin `.engram-project` y sin `.engram/`, como nace la copia pública (story 8.7)— no
# tiene manifest que comparar. Sincronizar ahí le CREARÍA una memoria, y exigirle el manifest dejaba este guion en ROJO
# siempre, con cualquier versión: un rojo que no dice nada tapa al que sí importa. Se dice y no se cuenta como rojo.
# Con memoria declarada, como siempre: que falte el manifest es un rojo.
if [ ! -f "$ARNES/.engram-project" ] && [ ! -d "$ARNES/.engram" ]; then
  echo "  – este repo no lleva memoria (sin .engram-project ni .engram/): no hay manifest que comparar — NO MEDIDO, no es un ✓"
else
  OUT="$(cd "$ARNES" && engram sync --project tycon 2>&1)"
  echo "$OUT" | grep -iE "error|panic|failed" >/dev/null && bad "sync falló: $(echo "$OUT"|head -2)" || ok "sync escribió sin error"
  MV="$(python3 -c "import json;print(json.load(open('$ARNES/.engram/manifest.json'))['version'])" 2>/dev/null)"
  [ "$MV" = "1" ] && ok "manifest sigue en version 1 (mismo formato que 1.12)" \
    || bad "manifest cambió a version $MV — 1.20 NO es compatible, NO propagar"
fi

echo
[ "$FAIL" = "0" ] && echo "RESULTADO: VERDE — se puede propagar $TARGET al equipo" \
                  || echo "RESULTADO: ROJO — NO bumpear la versión del equipo"
exit $FAIL
