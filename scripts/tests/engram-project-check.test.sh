#!/usr/bin/env bash
# engram-project-check.test.sh — red de `scripts/setup/check-engram-project.sh`.
#
# Lo que importa probar no es que avise cuando difieren (eso es lo fácil) sino que se CALLE en
# los casos legítimos: repo sin engram, nombres iguales (aunque cambie mayúsculas), opt-out. Un
# aviso que salta de más en cada arranque se aprende a ignorar y se lleva puestos los reales.
# Ninguno de estos casos toca git ni la red: carpetas temporales sin .git (el script mira el
# directorio tal cual cuando no hay repo).
#
# Correr: bash scripts/tests/engram-project-check.test.sh
set -uo pipefail
SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/setup/check-engram-project.sh"
fallos=0
check() { # check <nombre> <esperado> <obtenido>
  if [ "$2" = "$3" ]; then echo "✅ $1"; else echo "❌ $1 — esperaba [$2], obtuvo [$3]"; fallos=$((fallos+1)); fi
}
contiene() { # contiene <nombre> <aguja> <pajar>
  if printf '%s' "$3" | grep -qF -- "$2"; then echo "✅ $1"; else echo "❌ $1 — no encontré [$2] en: $3"; fallos=$((fallos+1)); fi
}
nuevo_repo() { local d; d="$(mktemp -d)"; mkdir -p "$d/.engram"; echo "$d"; }
config() { printf '{ "project_name": "%s", "other": 1 }\n' "$2" > "$1/.engram/config.json"; }

# 1. Coinciden → silencio, exit 0 (también en --strict).
r="$(nuevo_repo)"; config "$r" totora; printf 'totora\n' > "$r/.engram-project"
out="$(bash "$SCRIPT" --strict "$r" 2>&1)"; rc=$?
check "coinciden: exit 0" 0 "$rc"; check "coinciden: sin aviso" "" "$out"

# 2. Coinciden salvo mayúsculas → silencio (engram normaliza a minúsculas).
r="$(nuevo_repo)"; config "$r" pluginforms; printf 'PluginForms\n' > "$r/.engram-project"
out="$(bash "$SCRIPT" --strict "$r" 2>&1)"; rc=$?
check "mayúsculas: exit 0" 0 "$rc"; check "mayúsculas: sin aviso" "" "$out"

# 3. Difieren → aviso con los DOS nombres; exit 1 en --strict, 0 sin --strict (advisory).
r="$(nuevo_repo)"; config "$r" totora; printf 'TotoraBackend\n' > "$r/.engram-project"
out="$(bash "$SCRIPT" --strict "$r" 2>&1)"; rc=$?
check "difieren: exit 1 en --strict" 1 "$rc"
contiene "difieren: nombra config.json" '"totora"' "$out"
contiene "difieren: nombra .engram-project" '"TotoraBackend"' "$out"
out="$(bash "$SCRIPT" "$r" 2>&1)"; rc=$?
check "difieren: exit 0 sin --strict (advisory)" 0 "$rc"
contiene "difieren: igual avisa sin --strict" "DOS nombres" "$out"

# 4. .engram/ sin ningún nombre → aviso.
r="$(nuevo_repo)"
out="$(bash "$SCRIPT" --strict "$r" 2>&1)"; rc=$?
check "sin nombre: exit 1 en --strict" 1 "$rc"; contiene "sin nombre: lo dice" "NINGÚN archivo" "$out"

# 5. Sólo uno de los dos archivos → silencio (un nombre es un nombre; no hay desacuerdo).
r="$(nuevo_repo)"; config "$r" totora
out="$(bash "$SCRIPT" --strict "$r" 2>&1)"; rc=$?
check "sólo config.json: exit 0" 0 "$rc"; check "sólo config.json: sin aviso" "" "$out"
r="$(mktemp -d)"; printf 'totora\n' > "$r/.engram-project"
out="$(bash "$SCRIPT" --strict "$r" 2>&1)"; rc=$?
check "sólo .engram-project: exit 0" 0 "$rc"; check "sólo .engram-project: sin aviso" "" "$out"

# 6. Repo sin engram → silencio.
r="$(mktemp -d)"
out="$(bash "$SCRIPT" --strict "$r" 2>&1)"; rc=$?
check "sin engram: exit 0" 0 "$rc"; check "sin engram: sin aviso" "" "$out"

# 7. Opt-out → silencio aunque difieran.
r="$(nuevo_repo)"; config "$r" a; printf 'b\n' > "$r/.engram-project"
out="$(TYCON_NO_ENGRAM_PROJECT_CHECK=1 bash "$SCRIPT" --strict "$r" 2>&1)"; rc=$?
check "opt-out: exit 0" 0 "$rc"; check "opt-out: sin aviso" "" "$out"

# 8. .engram-project vacío con config.json → aviso específico.
r="$(nuevo_repo)"; config "$r" totora; : > "$r/.engram-project"
out="$(bash "$SCRIPT" --strict "$r" 2>&1)"; rc=$?
check "archivo vacío: exit 1 en --strict" 1 "$rc"; contiene "archivo vacío: lo dice" "VACÍO" "$out"

echo; if [ "$fallos" -eq 0 ]; then echo "engram-project-check: todo verde"; exit 0; else echo "engram-project-check: $fallos fallo(s)"; exit 1; fi
