#!/usr/bin/env bash
# followup-reason-lint.test.sh — red de la regla `followup_reason:` de `lint-story-frontmatter.js`.
#
# Lo que cuida, en una frase: que el campo se EXIJA sólo a la story que nace en este commit, que a
# las que ya existían se les AVISE sin frenarlas, y que un valor fuera del vocabulario cerrado no
# pase nunca — nueva o vieja.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la MUTACIÓN que lo pone en rojo. El que más pesa es
#    T2: hay cientos de stories con `followup_of:` en varios repos; exigírselo a todas pone en rojo el
#    pre-commit de todo el equipo — o sea, el lint se apaga en una semana.
#
# La regla depende de si el archivo TIENE HISTORIAL EN GIT, así que los fixtures son repos git
# efímeros de verdad (mktemp + init + un commit). Sin eso, el caso no probaría nada.
#
# Correr: bash scripts/tests/followup-reason-lint.test.sh

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LINT="$RAIZ/scripts/lib/lint-story-frontmatter.js"
VOCAB="$RAIZ/scripts/metrics/rework-causes.json"
DOC="$RAIZ/story-format.md"

# git determinista: sin depender de la config de la máquina que corre la suite
export GIT_AUTHOR_NAME=tycon GIT_AUTHOR_EMAIL=tycon@test GIT_COMMITTER_NAME=tycon GIT_COMMITTER_EMAIL=tycon@test
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

fallos=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1 — $2"; fallos=$((fallos+1)); }

# Corre el lint SOLO sobre el archivo indicado (modo pre-commit) → $OUT / $RC
correr() { OUT="$(node "$LINT" "$1" 2>&1)"; RC=$?; }

# Una story mínima y legible. $1 id · $2 "con"|"sin" followup_of · $3 followup_reason (vacío = sin campo)
story() {
  local id="$1" fo="$2" reason="${3:-}"
  {
    echo '---'
    echo "story: \"$id\""
    echo 'epic: 9'
    echo 'status: ready-for-dev'
    if [ "$fo" = "con" ]; then
      echo 'followup_of:'
      echo '  - id: "9.1"'
      echo '    type: "fix"'
      echo '    summary: "corrige lo que la 9.1 entregó"'
    fi
    [ -n "$reason" ] && echo "followup_reason: $reason"
    echo '---'
    echo "# Story $id"
    echo '## Acceptance Criteria'
    echo '1. algo.'
  }
}

# Repo git efímero con specs/
TMP="$(mktemp -d)"
REPO="$TMP/repo"; mkdir -p "$REPO/specs"
( cd "$REPO" && git init -q && git commit -q --allow-empty -m "raíz" )

# ── T2 · story que YA EXISTÍA (commiteada) con followup_of y sin causa → AVISA, exit 0 ─────────
# 🔴 Mutación: exigir el campo a toda story → exit 1. Es el caso de las stories que ya existen.
story "9.2" con > "$REPO/specs/9-2-vieja.md"
( cd "$REPO" && git add specs/9-2-vieja.md && git commit -q -m "story vieja" )
correr "$REPO/specs/9-2-vieja.md"
[ "$RC" -eq 0 ] && ok "T2 · story existente sin causa → exit 0 (no frena)" || bad "T2 · story existente sin causa" "esperaba exit 0, dio $RC · $OUT"
case "$OUT" in *"sin causa declarada"*) ok "T2 · …y lo AVISA (nombra la cuenta)";; *) bad "T2 · el aviso no salió" "$OUT";; esac

# ── T1 · story NUEVA (sin historial) con followup_of y sin causa → FRENA, exit 1 ────────────────
# 🔴 Mutación: quitar la regla → exit 0 y la story entra sin decir por qué volvió.
story "9.3" con > "$REPO/specs/9-3-nueva.md"
correr "$REPO/specs/9-3-nueva.md"
[ "$RC" -eq 1 ] && ok "T1 · story nueva sin causa → exit 1" || bad "T1 · story nueva sin causa" "esperaba exit 1, dio $RC · $OUT"
case "$OUT" in *"followup_reason"*) ok "T1 · el mensaje nombra el campo";; *) bad "T1 · el mensaje no nombra followup_reason" "$OUT";; esac
for v in defecto-propio cambio-de-requisito deuda-declarada descubrimiento; do
  case "$OUT" in *"$v"*) ok "T1 · el arreglo lista «${v}»";; *) bad "T1 · falta «${v}» en el arreglo" "$OUT";; esac
done
# staged pero sin commit sigue siendo «nace ahora» (es exactamente el estado en el pre-commit)
( cd "$REPO" && git add specs/9-3-nueva.md )
correr "$REPO/specs/9-3-nueva.md"
[ "$RC" -eq 1 ] && ok "T1 · staged sin commit también es nueva → exit 1" || bad "T1 · staged sin commit" "esperaba exit 1, dio $RC"
( cd "$REPO" && git reset -q specs/9-3-nueva.md )

# ── T3 · sin followup_of no se exige; declarar de más no es error ───────────────────────────────
# 🔴 Mutación: exigir el campo siempre → la primera falla; rechazar el campo sin followup_of → la segunda.
story "9.4" sin > "$REPO/specs/9-4-suelta.md"
correr "$REPO/specs/9-4-suelta.md"
[ "$RC" -eq 0 ] && ok "T3 · nueva sin followup_of y sin causa → exit 0" || bad "T3 · nueva sin followup_of" "esperaba exit 0, dio $RC · $OUT"
story "9.5" sin descubrimiento > "$REPO/specs/9-5-de-mas.md"
correr "$REPO/specs/9-5-de-mas.md"
[ "$RC" -eq 0 ] && ok "T3 · causa declarada sin followup_of → exit 0 (declarar de más no es error)" || bad "T3 · causa sin followup_of" "esperaba exit 0, dio $RC · $OUT"

# ── T4 · fuera del vocabulario frena SIEMPRE, vieja o nueva, sin normalizar ────────────────────
# 🔴 Mutación: aceptar cualquier texto → exit 0; normalizar mayúsculas «por comodidad» → la
#    segunda pasa y el vocabulario deja de ser cerrado.
story "9.6" con fix > "$REPO/specs/9-6-vieja-mal.md"
( cd "$REPO" && git add specs/9-6-vieja-mal.md && git commit -q -m "vieja con causa mal" )
correr "$REPO/specs/9-6-vieja-mal.md"
[ "$RC" -eq 1 ] && ok "T4 · story existente con «fix» (es un type, no una causa) → exit 1" || bad "T4 · vieja fuera de vocabulario" "esperaba exit 1, dio $RC · $OUT"
case "$OUT" in *"fix"*) ok "T4 · nombra el valor rechazado";; *) bad "T4 · no nombra el valor" "$OUT";; esac
story "9.7" con Defecto-Propio > "$REPO/specs/9-7-mayus.md"
correr "$REPO/specs/9-7-mayus.md"
[ "$RC" -eq 1 ] && ok "T4 · «Defecto-Propio» con mayúsculas → exit 1 (no se normaliza)" || bad "T4 · mayúsculas" "esperaba exit 1, dio $RC · $OUT"
story "9.8" con "defecto-propio" > "$REPO/specs/9-8-bien.md"
correr "$REPO/specs/9-8-bien.md"
[ "$RC" -eq 0 ] && ok "T4 · control positivo: nueva con causa válida → exit 0" || bad "T4 · control positivo" "esperaba exit 0, dio $RC · $OUT"

# ── T5 · la documentación COPIA el archivo: los dos dicen las mismas cuatro causas ─────────────
# 🔴 Mutación: agregar una causa a un solo lado → rojo. Sin este caso se separan solos, como pasa con
#    dos diccionarios de estados.
T5="$(python3 - "$VOCAB" "$DOC" <<'PY'
import json, re, sys
causas = set(json.load(open(sys.argv[1], encoding='utf8'))['causes'].keys())
doc = open(sys.argv[2], encoding='utf8').read()
ini = doc.find('##### Campo `followup_reason:`')
if ini < 0: print('NO_SECCION'); sys.exit(0)
fin = doc.find('\n##### ', ini + 10)
sec = doc[ini:fin if fin > 0 else None]
en_doc = set(re.findall(r'^\| `([a-z-]+)` \|', sec, re.M))
print('OK' if en_doc == causas and len(causas) == 4 else f'DIFF json={sorted(causas)} doc={sorted(en_doc)}')
PY
)"
[ "$T5" = "OK" ] && ok "T5 · story-format.md §1.2 y rework-causes.json dicen las mismas 4 causas" || bad "T5 · doc y archivo difieren" "$T5"

# ── T6 · sin git no se puede saber si nace ahora → se trata como existente: avisa, exit 0 ───────
# 🔴 Mutación: tratar «no sé» como «nace ahora» → exit 1 en el repo de alguien que lintea fuera de git.
SINGIT="$TMP/sin-git/specs"; mkdir -p "$SINGIT"
story "9.9" con > "$SINGIT/9-9-sin-git.md"
correr "$SINGIT/9-9-sin-git.md"
[ "$RC" -eq 0 ] && ok "T6 · fuera de un repo git → exit 0" || bad "T6 · fuera de git" "esperaba exit 0, dio $RC · $OUT"
case "$OUT" in *"sin causa declarada"*) ok "T6 · …y avisa igual";; *) bad "T6 · sin aviso" "$OUT";; esac

# ── El chequeo de siempre sigue andando: una story sana sin nada de esto sigue OK ────────────────
story "9.10" sin > "$REPO/specs/9-10-sana.md"
correr "$REPO/specs/9-10-sana.md"
[ "$RC" -eq 0 ] && ok "control · story sana → exit 0" || bad "control · story sana" "dio $RC · $OUT"

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# Defectos de parseo y de historia, cada uno con su reproducción real.
# ═══════════════════════════════════════════════════════════════════════════════════════════════

# ── T16 · lista YAML SIN INDENTAR (`-` en columna 0) ─────────────────────────────────
# 🔴 Mutación: acotar el bloque con `after.search(/^\S/m)` → encuentra el PROPIO guion del primer
#    item (un `-` es no-blanco), corta el bloque a '' y la story se lee como si no tuviera
#    seguimiento. El parser hermano de `followed_up_by:` sí lo reconoce.
cat > "$REPO/specs/9-11-flush-left.md" <<'EOF'
---
story: "9.11"
epic: 9
status: ready-for-dev
followup_of:
- id: "9.1"
  type: "fix"
  summary: "lista sin indentar — YAML válido"
---
# Story 9.11
EOF
correr "$REPO/specs/9-11-flush-left.md"
[ "$RC" -eq 1 ] && ok "T16 · lista sin indentar SÍ es un seguimiento (nueva sin causa → exit 1)" \
  || bad "T16 · lista sin indentar" "esperaba exit 1 y dio $RC — la story se evaporó del conteo · $OUT"

# ── T17 · `followup_of: []` con comentario al final NO es un seguimiento ──────────────
# 🔴 Mutación: comparar `inline !== '[]'` → el comentario rompe la igualdad exacta y una story
#    SIN seguimientos queda bloqueada.
cat > "$REPO/specs/9-12-vacio-con-comentario.md" <<'EOF'
---
story: "9.12"
epic: 9
status: ready-for-dev
followup_of: []  # ninguno todavía
---
# Story 9.12
EOF
correr "$REPO/specs/9-12-vacio-con-comentario.md"
[ "$RC" -eq 0 ] && ok "T17 · 'followup_of: []' con comentario → exit 0 (no es seguimiento)" \
  || bad "T17 · lista vacía con comentario" "esperaba exit 0 y dio $RC — bloqueó una story sin seguimientos · $OUT"

# ── T18 · el literal `followup_of:` en OTRO campo no confunde al parser ───────────────
# 🔴 Mutación: ubicar el bloque con `fm.indexOf(fo[0])` en vez de `match.index` → si el literal
#    aparece antes (en un `title:`), se lee el lugar equivocado y el bloque real nunca se mira.
cat > "$REPO/specs/9-13-literal-en-title.md" <<'EOF'
---
story: "9.13"
epic: 9
status: ready-for-dev
title: "Documentar el campo followup_of: y su back-link"
followup_of:
  - id: "9.1"
    type: "fix"
    summary: "sigue a la 9.1"
---
# Story 9.13
EOF
correr "$REPO/specs/9-13-literal-en-title.md"
[ "$RC" -eq 1 ] && ok "T18 · el literal en 'title:' no tapa el bloque real (nueva sin causa → exit 1)" \
  || bad "T18 · literal en title" "esperaba exit 1 y dio $RC · $OUT"

# ── T19 · una story EXISTENTE renombrada no se lee como nacida hoy ────────────────────
# 🔴 Mutación: `git log -1 -- <basename>` sin seguir renombres → con un `git mv` + edición
#    grande (git lo ve D+A, no R) la story vieja queda sin historia bajo el nombre nuevo y el lint
#    la FRENA. Es el caso de una story renombrada.
story "9.14" con > "$REPO/specs/9-14-vieja.md"
( cd "$REPO" && git add specs/9-14-vieja.md && git commit -q -m "story vieja con seguimiento" )
( cd "$REPO" && git mv specs/9-14-vieja.md specs/9-14-renombrada.md )
# y se reescribe el cuerpo para que git NO la detecte como renombre
{ sed -n '1,/^---$/p;/^---$/,/^---$/p' "$REPO/specs/9-14-renombrada.md" | awk '/^---$/{n++} {print} n==2{exit}'; for i in $(seq 1 60); do echo "Cuerpo completamente distinto, linea $i, para bajar la similitud."; done; } > "$REPO/specs/tmp" && mv "$REPO/specs/tmp" "$REPO/specs/9-14-renombrada.md"
correr "$REPO/specs/9-14-renombrada.md"
[ "$RC" -eq 0 ] && ok "T19 · story existente renombrada y reescrita → exit 0 (no la frena)" \
  || bad "T19 · renombre" "esperaba exit 0 y dio $RC — frenó una story que YA existía · $OUT"

# ── T20 · repo git con CERO commits: se decide, no se cae en un catch genérico ────────
# 🔴 Anda por accidente (el `git log` falla y cae en el catch-all). Si alguien
#    "arregla" el catch para distinguir errores, TODAS las stories de un repo recién importado
#    pasarían a ser «nuevas» y el primer commit del onboarding quedaría bloqueado en masa.
VACIO="$TMP/repo-vacio/specs"; mkdir -p "$VACIO"
( cd "$TMP/repo-vacio" && git init -q )
story "9.15" con > "$VACIO/9-15.md"
correr "$VACIO/9-15.md"
[ "$RC" -eq 0 ] && ok "T20 · repo sin ningún commit → exit 0 (una importación masiva no se bloquea)" \
  || bad "T20 · repo sin commits" "esperaba exit 0 y dio $RC · $OUT"

# ── T21 · un vocabulario con `causes` como ARRAY no vale como vocabulario ─────────────
# 🔴 Mutación: `typeof j.causes === 'object'` es true para un array → `Object.keys()` devuelve
#    los ÍNDICES ("0","1","2") como si fueran el vocabulario, y el lint valida contra números.
ARR="$TMP/causas-array.json"
printf '{"causes": ["defecto-propio", "cambio-de-requisito"]}\n' > "$ARR"
story "9.16" con defecto-propio > "$REPO/specs/9-16-arr.md"
OUT="$(TYCON_CAUSES_PATH="$ARR" node "$LINT" "$REPO/specs/9-16-arr.md" 2>&1)"; RC=$?
case "$OUT" in
  *"vocabulario de causas"*) ok "T21 · 'causes' como array → se avisa que el vocabulario no vale" ;;
  *) bad "T21 · causas como array" "no avisó; la regla corrió con índices como vocabulario · $OUT" ;;
esac
[ "$RC" -eq 0 ] && ok "T21 · …y no frena por eso (fail-open ruidoso)" || bad "T21 · fail-open" "dio exit $RC"

rm -rf "$TMP"
if [ "$fallos" -eq 0 ]; then echo "✅ followup-reason-lint: todo verde"; exit 0; fi
echo "❌ followup-reason-lint: $fallos rojos"; exit 1
