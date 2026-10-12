#!/usr/bin/env bash
# lint-story-detector.test.sh — red del DETECTOR de `lint-story-frontmatter.js`: qué archivo entra
# al lint y cuál no.
#
# El chequeo en sí (frontmatter cerrado, campos legibles) ya tenía su cobertura. Lo que no la tenía
# —y por eso se rompió— es la decisión previa: **a qué archivos se los mira**. Con el criterio v2
# entraban los 13 documentos de planning de un repo del equipo, y el gate habría rechazado 331 de 1608
# `.md` del repo el día que alguien lo activara.
#
# Los casos POSITIVOS de acá no son decorativos: cada uno es el contraejemplo de un criterio que se
# evaluó y se descartó. Si mañana alguien "simplifica" el detector exigiendo forma de id en el
# nombre, o un `## Acceptance Criteria` en el cuerpo, estos casos se ponen en rojo — que es
# exactamente para lo que existen. Sin ellos, ese cambio pasa en verde y deja stories invisibles.
#
# Correr: bash scripts/tests/lint-story-detector.test.sh

set -uo pipefail
LINT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/lint-story-frontmatter.js"
FX="$(mktemp -d)/stories"
mkdir -p "$FX"

fallos=0
ok()   { echo "✅ $1"; }
bad()  { echo "❌ $1 — $2"; fallos=$((fallos+1)); }

# Corre el lint SOLO sobre el archivo indicado (modo pre-commit) y deja salida en $OUT / exit en $RC
correr() { OUT="$(node "$LINT" "$FX/$1" 2>&1)"; RC=$?; }

# "Se la miró" = o la contó como revisada, o la reportó con ❌. El contador `revisadas` sólo suma
# las que PASAN el chequeo estructural, así que para una story rota la evidencia de que el detector
# la agarró es el reporte del error, no el contador.
linteada() {
  correr "$1"
  case "$OUT" in
    *"1 revisadas"*|*"❌ "*"$1"*) ok "$2" ;;
    *) bad "$2" "no la miró: $(echo "$OUT" | head -1)" ;;
  esac
}
no_linteada() { correr "$1"; case "$OUT" in *"0 revisadas"*) ok "$2";; *) bad "$2" "la miró y no debía: $(echo "$OUT" | head -1)";; esac; }
con_error()   { correr "$1"; [ "$RC" -eq 1 ] && ok "$2" || bad "$2" "esperaba exit 1, dio $RC"; }
sin_error()   { correr "$1"; [ "$RC" -eq 0 ] && ok "$2" || bad "$2" "esperaba exit 0, dio $RC · $OUT"; }
en_aviso()    { correr "$1"; case "$OUT" in *"NO linteados"*) ok "$2";; *) bad "$2" "el descarte no se anunció";; esac; }

# ── POSITIVOS: se lintean ─────────────────────────────────────────────────────────────────────
cat > "$FX/1-1-story-sana.md" <<'EOF'
---
story: "1.1"
epic: 1
status: ready-for-dev
---
# Story 1.1
## Acceptance Criteria
1. AC#1: algo.
EOF
linteada 1-1-story-sana.md "story sana → se lintea"
sin_error 1-1-story-sana.md "story sana → exit 0"

# Modo de rotura 1: el frontmatter no cierra. ES el caso que dejó 4 stories invisibles 2 meses.
cat > "$FX/1-2-sin-cierre.md" <<'EOF'
---
story: "1.2"
epic: 1
status: ready-for-dev
# Story 1.2
Cuerpo sin haber cerrado el frontmatter.
EOF
linteada 1-2-sin-cierre.md "ROTA modo 1 (sin cierre) → se lintea igual"
con_error 1-2-sin-cierre.md "ROTA modo 1 → bloquea"

# Modo de rotura 2: comillas dobles en el comentario inline rompen el scalar de OTRO campo.
cat > "$FX/1-3-comillas.md" <<'EOF'
---
story: "1.3"
epic: 1
status: done  # cerrada con la "evidencia" de DoD
---
# Story 1.3
EOF
linteada 1-3-comillas.md "ROTA modo 2 (comillas) → se lintea"
con_error 1-3-comillas.md "ROTA modo 2 → bloquea"

# 🔴 Contraejemplo del criterio "forma de id en el NOMBRE" (descartado: 463 stories reales de la
# máquina se llaman story-N.M-slug y ningún patrón de id razonable las matchea).
cat > "$FX/historia-del-login.md" <<'EOF'
---
story: "9.9"
epic: 9
status: ready-for-dev
# sin cerrar, a propósito
EOF
linteada historia-del-login.md "rota con nombre SIN forma de id → se lintea (el nombre no es requisito)"

# 🔴 Contraejemplo del criterio "marcador en el CUERPO" (descartado: 62 stories escriben
# '## Acceptance criteria' en minúscula, y un stub legítimo todavía no tiene ACs).
cat > "$FX/2-1-stub.md" <<'EOF'
---
story: "2.1"
epic: 2
status: draft
---
# Story 2.1
Todavía sin criterios de aceptación.
EOF
linteada 2-1-stub.md "story stub sin Acceptance Criteria → se lintea (el cuerpo no es requisito)"

cat > "$FX/2-2-indentada.md" <<'EOF'
---
  story: "2.2"
  epic: 2
  status: ready-for-dev
---
EOF
linteada 2-2-indentada.md "story: indentado → se lintea (el detector tolera)"

# Canario del ANCLAJE de la lista de exclusión: son stories REALES con "template" en el slug.
cat > "$FX/story-1.22-template-render-fail-loud.md" <<'EOF'
---
story: "1.22"
epic: 1
status: done
---
EOF
linteada story-1.22-template-render-fail-loud.md "story real con 'template' en el medio del slug → se lintea"

# ── NEGATIVOS: NO se lintean ──────────────────────────────────────────────────────────────────
# El falso positivo que motivó todo esto: planning con `status:` y sin `story:`.
cat > "$FX/prd.md" <<'EOF'
---
status: complete
completedAt: '2026-07-02'
---
# PRD
EOF
no_linteada prd.md "PRD con status: → NO se lintea"
sin_error prd.md "PRD → no bloquea el commit"

cat > "$FX/epics.md" <<'EOF'
---
epic: 7
status: complete
---
# Épicos
EOF
no_linteada epics.md "documento de épicos (epic: sin story:) → NO se lintea"
en_aviso epics.md "…pero queda anunciado, no descartado en silencio"

cat > "$FX/_template-gold.md" <<'EOF'
---
story: "{N.NN}"
epic: "{N}"
status: "backlog"  # backlog | ready-for-dev | in-progress
---
EOF
no_linteada _template-gold.md "la plantilla → NO se lintea (declara story: pero es placeholder)"
sin_error _template-gold.md "la plantilla → no bloquea"

# La zona se corta en el cierre: un `story:` del CUERPO no convierte al archivo en story.
cat > "$FX/guia.md" <<'EOF'
---
title: Guía
---
# Cómo escribir una story
En el frontmatter va:
    story: "4.2"
EOF
no_linteada guia.md "story: en el CUERPO (frontmatter cerrado) → NO se lintea"

printf '# Sin frontmatter\n' > "$FX/README.md"
no_linteada README.md "archivo sin frontmatter → NO se lintea"

# ── Comportamiento del control ────────────────────────────────────────────────────────────────
# Un aviso NUNCA bloquea: el descarte se comunica, no se castiga.
correr epics.md
[ "$RC" -eq 0 ] && ok "con avisos y sin errores → exit 0" || bad "aviso no bloqueante" "dio exit $RC"

rm -rf "$(dirname "$FX")"
if [ "$fallos" -eq 0 ]; then echo "✅ lint-story-detector: todo verde"; exit 0; fi
echo "❌ lint-story-detector: $fallos rojos"; exit 1
