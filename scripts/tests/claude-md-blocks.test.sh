#!/usr/bin/env bash
# claude-md-blocks.test.sh — el presupuesto de los bloques del CLAUDE.md (CLAUDEMD-SIN-PRESUPUESTO, 2026-09-06).
#
# Lo que se afirma: un bloque que se pasa de su techo FRENA (exit 1) y se nombra; uno dentro del
# techo pasa; un bloque nuevo sin techo usa el default; el total también frena; lo que el commit
# AGREGA con forma de historia (caso disparador, pasada numerada) sólo AVISA; lo que ya estaba no
# avisa; un presupuesto ilegible NO es verde (exit 2); y los bloques REALES del repo pasan hoy — sin
# ese último caso, el control podría nacer en rojo y se apagaría el primer día.
#
# 🔴 Rojo previo: sin el guion, no hay nada que frene (los seis chequeos que exigen 1 o 2 dan 0).
# Desde la revisión adversarial del 2026-09-06 (C-10..C-18): en --staged el techo, la lista de bloques y su
# contenido salen del ÍNDICE (un techo subido sin stagear no deja pasar; lo que creció en el disco después
# del add no frena); sin git sale 2; las variantes de Codex se miden contra el techo de su bloque y suman en
# total_codex; un techo 0 o de texto sale 2; los códigos ANSI no ciegan al detector; y «el dev preguntó»
# —con acento— dispara la señal de cita. Rojo previo verificado contra la primera versión del guion en los
# seis que podían ponerse rojos (C-10, C-12, C-13, C-14, C-15, C-18); C-11 ya pasaba con la primera versión
# (el contenido de los bloques siempre salió del índice): fija la conducta, no la corrige.
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
G="$RAIZ/scripts/ci/check-claude-md-blocks.js"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
[ -f "$G" ] || { echo "  MAL  — no encontré $G"; exit 1; }

montar() {   # repo de juguete con dos bloques commiteados: a (80 bytes, techo 220) y b (50, default 200)
  local T="$1"
  mkdir -p "$T/repo/claude-md-blocks" "$T/repo/scripts/ci"
  cp "$G" "$T/repo/scripts/ci/"
  cat > "$T/repo/claude-md-blocks/budget.json" <<'JSON'
{ "default": 200, "total": 1000, "blocks": { "a": 220 } }
JSON
  head -c 80 /dev/zero | tr '\0' 'x' > "$T/repo/claude-md-blocks/a.md"
  head -c 50 /dev/zero | tr '\0' 'y' > "$T/repo/claude-md-blocks/b.md"
  git init -q -b main "$T/repo"
  ( cd "$T/repo" && git add -A && git -c user.email=b@b -c user.name=b commit -q -m base )
}
correr() { ( cd "$1/repo" && node scripts/ci/check-claude-md-blocks.js --repo . --staged ) > "$1/out.txt" 2>&1; echo $?; }

# C-01 · todo dentro del techo → 0
T=$(mktemp -d); montar "$T"; echo 'z' >> "$T/repo/claude-md-blocks/b.md"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 0 ] && ok "C-01 bloques dentro del techo: pasa (exit 0)" || { mal "C-01 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-02 · b se pasa del default (200) → 1 y lo nombra
T=$(mktemp -d); montar "$T"; head -c 250 /dev/zero | tr '\0' 'y' > "$T/repo/claude-md-blocks/b.md"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 1 ] && grep -q "❌ b:" "$T/out.txt" && ok "C-02 un bloque que se pasa FRENA (exit 1) y se nombra" || { mal "C-02 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-03 · a crece a 210, bajo su techo declarado (220) → 0
T=$(mktemp -d); montar "$T"; head -c 210 /dev/zero | tr '\0' 'x' > "$T/repo/claude-md-blocks/a.md"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 0 ] && ok "C-03 el techo declarado por bloque manda sobre el default" || { mal "C-03 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-04 · un bloque NUEVO sin techo declarado usa el default → 230 > 200 frena
T=$(mktemp -d); montar "$T"; head -c 230 /dev/zero | tr '\0' 'w' > "$T/repo/claude-md-blocks/nuevo.md"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 1 ] && grep -q "nuevo:.*default" "$T/out.txt" && ok "C-04 un bloque nuevo sin techo usa el default (y frena si se pasa)" || { mal "C-04 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-05 · lo AGREGADO con forma de historia sólo AVISA (exit 0)
T=$(mktemp -d); montar "$T"; printf '\nCaso disparador (un repo del equipo, 2026-07-29): el dev preguntó tres veces.\n' >> "$T/repo/claude-md-blocks/b.md"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 0 ] && grep -q "caso disparador" "$T/out.txt" && ok "C-05 sumar un «caso disparador» avisa y no frena" || { mal "C-05 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-06 · la MISMA historia ya commiteada no avisa cuando el commit toca otra línea
T=$(mktemp -d); montar "$T"; printf '\nCaso disparador (2026-07-29): ya estaba.\n' >> "$T/repo/claude-md-blocks/b.md"
( cd "$T/repo" && git add -A && git -c user.email=b@b -c user.name=b commit -q -m historia ); echo 'otra línea' >> "$T/repo/claude-md-blocks/b.md"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 0 ] && ! grep -q "caso disparador" "$T/out.txt" && ok "C-06 lo que YA estaba no se reclama" || { mal "C-06 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-07 · presupuesto ilegible → 2 (no medido no es verde)
T=$(mktemp -d); montar "$T"; echo '{ roto' > "$T/repo/claude-md-blocks/budget.json"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 2 ] && ok "C-07 presupuesto ilegible: exit 2, no verde" || { mal "C-07 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-08 · la suma se pasa del total → 1
T=$(mktemp -d); montar "$T"; head -c 600 /dev/zero | tr '\0' 'x' > "$T/repo/claude-md-blocks/c.md"; head -c 500 /dev/zero | tr '\0' 'x' > "$T/repo/claude-md-blocks/d.md"
python3 - "$T/repo/claude-md-blocks/budget.json" <<'PYX'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['blocks'].update({'c':700,'d':700}); json.dump(d,open(p,'w'))
PYX
( cd "$T/repo" && git add -A ); RC=$(correr "$T"); [ "$RC" = 1 ] && grep -q "total" "$T/out.txt" && ok "C-08 el total también frena" || { mal "C-08 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-09 · los bloques REALES del repo pasan hoy (el control no nace en rojo)
if node "$G" --repo "$RAIZ" > /tmp/cmb-real-$$.txt 2>&1; then ok "C-09 los bloques reales del arnés están dentro de su techo"; else mal "C-09 los bloques reales NO pasan — el control nacería en rojo"; cat /tmp/cmb-real-$$.txt; fi; rm -f /tmp/cmb-real-$$.txt

# ── Revisión adversarial 2026-09-06: el índice manda, las variantes de Codex se miden, no medido no es verde ──
GIT='git -c user.email=b@b -c user.name=b'

# C-10 · 🔴 el techo del DISCO no manda: presupuesto subido sin stagear, bloque stageado en 300 → 1
T=$(mktemp -d); montar "$T"
head -c 300 /dev/zero | tr '\0' 'y' > "$T/repo/claude-md-blocks/b.md"; ( cd "$T/repo" && git add claude-md-blocks/b.md )
printf '{ "default": 200, "total": 1000, "blocks": { "a": 220, "b": 400 } }\n' > "$T/repo/claude-md-blocks/budget.json"   # sólo en el disco
RC=$(correr "$T"); [ "$RC" = 1 ] && grep -q "❌ b:" "$T/out.txt" && ok "C-10 un techo subido en el disco pero no stageado NO deja pasar (mide el índice)" || { mal "C-10 exit $RC"; cat "$T/out.txt"; }
# C-10b · el mismo techo, stageado → 0 (viaja con el commit)
( cd "$T/repo" && git add claude-md-blocks/budget.json )
RC=$(correr "$T"); [ "$RC" = 0 ] && ok "C-10b el techo stageado manda: pasa" || { mal "C-10b exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-11 · el contenido del DISCO no manda: b stageado en 50, el disco sigue creciendo a 300 → 0
T=$(mktemp -d); montar "$T"
head -c 300 /dev/zero | tr '\0' 'y' > "$T/repo/claude-md-blocks/b.md"            # sin git add: sólo en el disco
RC=$(correr "$T"); [ "$RC" = 0 ] && ok "C-11 lo que creció en el disco después del add no frena (mide el índice)" || { mal "C-11 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-12 · sin repo git, --staged → 2 (no medido no es verde)
T=$(mktemp -d); mkdir -p "$T/repo/claude-md-blocks" "$T/repo/scripts/ci"; cp "$G" "$T/repo/scripts/ci/"
printf '{ "default": 200 }\n' > "$T/repo/claude-md-blocks/budget.json"; head -c 300 /dev/zero | tr '\0' 'x' > "$T/repo/claude-md-blocks/a.md"
RC=$(correr "$T"); [ "$RC" = 2 ] && grep -q "no medido no es verde" "$T/out.txt" && ok "C-12 sin git, --staged sale 2 (no 0 con «todo borrado»)" || { mal "C-12 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-13 · 🔴 la variante de Codex se mide contra el techo de su bloque: names/b.codex.md de 300 → 1 y la nombra
T=$(mktemp -d); montar "$T"; mkdir -p "$T/repo/claude-md-blocks/names"
head -c 300 /dev/zero | tr '\0' 'z' > "$T/repo/claude-md-blocks/names/b.codex.md"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 1 ] && grep -q "variante Codex" "$T/out.txt" && ok "C-13 la variante Codex que se pasa del techo de su bloque frena y se nombra" || { mal "C-13 exit $RC"; cat "$T/out.txt"; }
# C-13b · con techo propio declarado («b.codex»: 400) → 0
printf '{ "default": 200, "total": 1000, "blocks": { "a": 220, "b.codex": 400 } }\n' > "$T/repo/claude-md-blocks/budget.json"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 0 ] && ok "C-13b la variante con techo propio declarado pasa" || { mal "C-13b exit $RC"; cat "$T/out.txt"; }
# C-13c · el total del lado Codex: variante 950 (techo propio 960) → a(80)+b.codex(950)=1030 > total_codex 1000 → 1 y dice «lado Codex»
head -c 950 /dev/zero | tr '\0' 'z' > "$T/repo/claude-md-blocks/names/b.codex.md"
printf '{ "default": 200, "total": 1000, "blocks": { "a": 220, "b.codex": 960 } }\n' > "$T/repo/claude-md-blocks/budget.json"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 1 ] && grep -q "lado Codex" "$T/out.txt" && ! grep -q "se pasa de su techo" "$T/out.txt" && ok "C-13c la suma del lado Codex se pasa del total y el mensaje lo dice (no «se pasa de su techo»)" || { mal "C-13c exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-14 · la señal «cita del dev» con vocal acentuada: «el dev preguntó» avisa (con \b nunca matcheaba)
T=$(mktemp -d); montar "$T"
printf 'x\nel dev preguntó tres veces si esto andaba\n' >> "$T/repo/claude-md-blocks/a.md"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 0 ] && grep -q "cita del dev" "$T/out.txt" && ok "C-14 «el dev preguntó» dispara la señal de cita (vocal acentuada)" || { mal "C-14 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-15 · techo inválido (0 / texto) → 2
T=$(mktemp -d); montar "$T"
printf '{ "default": 200, "total": 1000, "blocks": { "a": 0 } }\n' > "$T/repo/claude-md-blocks/budget.json"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 2 ] && ok "C-15 un techo 0 no cae al default en silencio: sale 2" || { mal "C-15 exit $RC"; cat "$T/out.txt"; }
printf '{ "default": "abc", "total": 1000 }\n' > "$T/repo/claude-md-blocks/budget.json"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 2 ] && ok "C-15b un default que no es número sale 2" || { mal "C-15b exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-16 · con color.diff=always en la config del repo, el detector de forma sigue viendo
T=$(mktemp -d); montar "$T"; ( cd "$T/repo" && git config color.diff always && git config color.ui always )
printf 'x\nesto suma un caso disparador más\n' >> "$T/repo/claude-md-blocks/a.md"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 0 ] && grep -q "caso disparador" "$T/out.txt" && ok "C-16 los códigos ANSI del diff no ciegan al detector de forma" || { mal "C-16 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-17 · el TOTAL se pasa con todos los bloques en verde: el mensaje nombra al total, no a un bloque
T=$(mktemp -d); montar "$T"
head -c 950 /dev/zero | tr '\0' 'y' > "$T/repo/claude-md-blocks/b.md"
printf '{ "default": 200, "total": 1000, "blocks": { "a": 220, "b": 960 } }\n' > "$T/repo/claude-md-blocks/budget.json"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 1 ] && grep -q "se pasa del total" "$T/out.txt" && ! grep -q "se pasa de su techo" "$T/out.txt" && ok "C-17 el total que se pasa se dice como total" || { mal "C-17 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-18 · un presupuesto que está en el disco pero NO en el índice ni en HEAD → 2 (no mide contra el aire)
T=$(mktemp -d); montar "$T"; ( cd "$T/repo" && git rm -q --cached claude-md-blocks/budget.json )
RC=$(correr "$T"); [ "$RC" = 2 ] && ok "C-18 sin presupuesto en el índice, --staged sale 2" || { mal "C-18 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-19 · un .md ANIDADO (claude-md-blocks/archivo/viejo.md) no es un bloque: en pathspecs de git `*` cruza `/`
T=$(mktemp -d); montar "$T"; mkdir -p "$T/repo/claude-md-blocks/archivo"
head -c 900 /dev/zero | tr '\0' 'v' > "$T/repo/claude-md-blocks/archivo/viejo.md"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 0 ] && ! grep -q "viejo" "$T/out.txt" && ok "C-19 un .md anidado no se mide como bloque (el sync tampoco lo manda a ninguna máquina)" || { mal "C-19 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-20 · un `names/b.md` SIN `.codex` no es una variante: no reemplaza a b ni se mide (segundo pase con Fable, [20])
T=$(mktemp -d); montar "$T"; mkdir -p "$T/repo/claude-md-blocks/names"
head -c 900 /dev/zero | tr '\0' 'w' > "$T/repo/claude-md-blocks/names/b.md"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 0 ] && ! grep -q "b (variante Codex" "$T/out.txt" && ! grep -q "lado Codex" "$T/out.txt" && ok "C-20 names/b.md sin .codex no es variante (ni se mide ni reemplaza a b)" || { mal "C-20 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# ── Los archivos IMPORTADOS enteros en cada sesión (story 7.4, 2026-09-17) ────────────────────
# El presupuesto medía los BLOQUES, que son 15.555 bytes; el README —que el `~/.claude/CLAUDE.md`
# de cada dev importa ENTERO en cada sesión y en cada subagente— pesaba 235.771 y no lo medía nada.
# La sección `imported` del presupuesto le pone techo, tope por entrada, y exige que el índice y
# la guía del detalle se nombren mutuamente. Rojo previo: sin la sección, el guion sale 0 en todos.
#
# 🔴 Y el detector de entradas es `^- \*\*`, NO `^- \*\*\[`: cuatro de las 105 fichas del README
# nombran un COMANDO (`` - **`pipeline.js …` ``) y el detector angosto las pierde EN SILENCIO
# (101 contra 105). Lo cazó el validador en el Step 1 de esta story; C-27b lo fija.

montar_imp() {   # repo con README (índice) + guides/p.md (detalle) + presupuesto con `imported`
  local T="$1" techo="${2:-300}" emax="${3:-200}"
  mkdir -p "$T/repo/claude-md-blocks" "$T/repo/scripts/ci" "$T/repo/guides"
  cp "$G" "$T/repo/scripts/ci/"
  cat > "$T/repo/claude-md-blocks/budget.json" <<JSON
{ "default": 200, "total": 1000, "blocks": { "a": 220 },
  "imported": { "README.md": { "ceiling": $techo, "max_input": $emax, "detail": "guides/p.md" } } }
JSON
  head -c 80 /dev/zero | tr '\0' 'x' > "$T/repo/claude-md-blocks/a.md"
  printf '# r\n\n- **[scripts/uno.js](scripts/uno.js)** — hace uno. Detalle: [p.md#scriptsunojs](guides/p.md#scriptsunojs)\n' > "$T/repo/README.md"
  printf '# piezas\n\n## scripts/uno.js\n\nhace uno, con su historia.\n' > "$T/repo/guides/p.md"
  git init -q -b main "$T/repo"
  ( cd "$T/repo" && git add -A && git -c user.email=b@b -c user.name=b commit -q -m base )
}

# C-21 · el importado se pasa de su techo → 1 y lo nombra con los dos números
T=$(mktemp -d); montar_imp "$T" 300 200
{ printf '# r\n\n'; head -c 350 /dev/zero | tr '\0' 'q'; printf '\n'; } > "$T/repo/README.md"
( cd "$T/repo" && git add -A ); RC=$(correr "$T")
[ "$RC" = 1 ] && grep -q "README.md" "$T/out.txt" && grep -q "300" "$T/out.txt" \
  && ok "C-21 un archivo importado que se pasa de su techo FRENA (exit 1) y se nombra" || { mal "C-21 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-22 · dentro del techo, entradas cortas, anclas en correspondencia → 0, y la salida de los bloques no cambia
T=$(mktemp -d); montar_imp "$T" 400 200
RC=$(correr "$T"); [ "$RC" = 0 ] && grep -q "✅ a:" "$T/out.txt" \
  && ok "C-22 importado dentro del techo pasa, y los bloques se siguen reportando igual" || { mal "C-22 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-23 · «no medido» nunca es verde: 5 formas de no poder medir → 2
T=$(mktemp -d); montar_imp "$T" 400 200; ( cd "$T/repo" && git rm -q --cached README.md )
RC=$(correr "$T"); [ "$RC" = 2 ] && ok "C-23a importado declarado y ausente del índice → 2" || { mal "C-23a exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"
T=$(mktemp -d); montar_imp "$T" 400 200; ( cd "$T/repo" && git rm -q --cached guides/p.md )
RC=$(correr "$T"); [ "$RC" = 2 ] && ok "C-23b el archivo de detalle ilegible → 2" || { mal "C-23b exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"
for BAD in '"ceiling": 0, "max_input": 200, "detail": "guides/p.md"' \
           '"ceiling": 400, "max_input": "x", "detail": "guides/p.md"'; do
  T=$(mktemp -d); montar_imp "$T" 400 200
  printf '{ "default": 200, "imported": { "README.md": { %s } } }\n' "$BAD" > "$T/repo/claude-md-blocks/budget.json"
  ( cd "$T/repo" && git add -A ); RC=$(correr "$T")
  [ "$RC" = 2 ] && ok "C-23c techo/entrada_max inválido → 2 (no cae al default en silencio)" || { mal "C-23c exit $RC ($BAD)"; cat "$T/out.txt"; }; rm -rf "$T"
done
T=$(mktemp -d); montar_imp "$T" 400 200
printf '{ "default": 200, "imported": [] }\n' > "$T/repo/claude-md-blocks/budget.json"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 2 ] && ok "C-23d «imported» que no es un objeto → 2" || { mal "C-23d exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-24 · una ENTRADA larga frena aunque el archivo entre en el techo, y se nombra por su principio
T=$(mktemp -d); montar_imp "$T" 4000 200
{ printf '# r\n\n- **[scripts/uno.js](scripts/uno.js)** — '; head -c 260 /dev/zero | tr '\0' 'L'; printf '. Detalle: [p.md#scriptsunojs](guides/p.md#scriptsunojs)\n'; } > "$T/repo/README.md"
( cd "$T/repo" && git add -A ); RC=$(correr "$T")
[ "$RC" = 1 ] && grep -q "scripts/uno.js" "$T/out.txt" \
  && ok "C-24 una entrada de más de entrada_max frena y se nombra (el índice no vuelve a ser catálogo)" || { mal "C-24 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-25 · las anclas se exigen en LAS DOS direcciones, y el slug tolera puntos/mayúsculas/acentos
T=$(mktemp -d); montar_imp "$T" 4000 400
sed -i.bak 's|guides/p.md#scriptsunojs|guides/p.md#no-existe|' "$T/repo/README.md"; rm -f "$T/repo/README.md.bak"
( cd "$T/repo" && git add -A ); RC=$(correr "$T")
[ "$RC" = 1 ] && grep -qi "enlace\|ancla" "$T/out.txt" && ok "C-25a un enlace al detalle sin destino frena" || { mal "C-25a exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"
T=$(mktemp -d); montar_imp "$T" 4000 400
printf '\n## sobra\n\nnadie la enlaza.\n' >> "$T/repo/guides/p.md"; ( cd "$T/repo" && git add -A ); RC=$(correr "$T")
[ "$RC" = 1 ] && grep -qi "sobra" "$T/out.txt" && ok "C-25b una sección del detalle que el índice no enlaza frena" || { mal "C-25b exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"
# C-25d · story 7.7: el README deja de ser índice (las piezas se buscan en la guía) y lo declara con
# `linked_sections: false`. Entonces una sección del detalle SIN enlace no frena… pero un enlace
# que SÍ está y no tiene destino sigue frenando, y la opción mal escrita no cae al default en silencio.
con_opcion() {   # presupuesto con la opción; $2 = valor literal JSON
  printf '{ "default": 200, "total": 1000, "blocks": { "a": 220 }, "imported": { "README.md": { "ceiling": 4000, "max_input": 400, "detail": "guides/p.md", "linked_sections": %s } } }\n' "$2" > "$1/repo/claude-md-blocks/budget.json"
}
T=$(mktemp -d); montar_imp "$T" 4000 400; con_opcion "$T" false
printf '\n## sobra\n\nnadie la enlaza.\n' >> "$T/repo/guides/p.md"; ( cd "$T/repo" && git add -A ); RC=$(correr "$T")
[ "$RC" = 0 ] && ok "C-25d1 con secciones_enlazadas:false, una sección del detalle sin enlace NO frena" || { mal "C-25d1 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"
T=$(mktemp -d); montar_imp "$T" 4000 400; con_opcion "$T" false
sed -i.bak 's|guides/p.md#scriptsunojs|guides/p.md#no-existe|' "$T/repo/README.md"; rm -f "$T/repo/README.md.bak"
( cd "$T/repo" && git add -A ); RC=$(correr "$T")
[ "$RC" = 1 ] && ok "C-25d2 con secciones_enlazadas:false, un enlace sin destino SIGUE frenando" || { mal "C-25d2 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"
T=$(mktemp -d); montar_imp "$T" 4000 400; con_opcion "$T" '"no"'; ( cd "$T/repo" && git add -A ); RC=$(correr "$T")
[ "$RC" = 2 ] && ok "C-25d3 secciones_enlazadas que no es booleano → 2 (no cae al default)" || { mal "C-25d3 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

T=$(mktemp -d); montar_imp "$T" 4000 400
printf '# r\n\n- **[scripts/ci/release-notes.sh](x)** — nota. Detalle: [p.md#scriptscirelease-notessh](guides/p.md#scriptscirelease-notessh)\n' > "$T/repo/README.md"
printf '# piezas\n\n## scripts/ci/release-notes.sh\n\ncon puntos y barras.\n' > "$T/repo/guides/p.md"
( cd "$T/repo" && git add -A ); RC=$(correr "$T")
[ "$RC" = 0 ] && ok "C-25c el slug de un encabezado con barras y puntos resuelve (scripts/ci/release-notes.sh)" || { mal "C-25c exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-26 · lo que el commit AGREGA a un importado con forma de historia AVISA y no frena
T=$(mktemp -d); montar_imp "$T" 4000 400
printf '\nCaso disparador (2026-07-29): el dev preguntó tres veces.\n' >> "$T/repo/README.md"; ( cd "$T/repo" && git add -A )
RC=$(correr "$T"); [ "$RC" = 0 ] && grep -q "caso disparador" "$T/out.txt" \
  && ok "C-26 la historia agregada a un importado avisa (va a la guía), no frena" || { mal "C-26 exit $RC"; cat "$T/out.txt"; }; rm -rf "$T"

# C-27 · el repo REAL: tras la poda, en verde. 🔴 ROJO PREVIO EXIGIDO POR LA STORY: con el README de
# `origin/main` (235.771 bytes contra un techo de 55.000 y 87 entradas de más de 400) sale 1 — la
# salida de ese rojo se anota en el Dev Agent Record ANTES de podar. Sin ese rojo, este verde no
# significaría nada.
if node "$G" --repo "$RAIZ" > /tmp/cmb-imp-$$.txt 2>&1; then
  ok "C-27 el README real del arnés está dentro de su techo y sus entradas"
else
  mal "C-27 el README real NO pasa el presupuesto de importados"; cat /tmp/cmb-imp-$$.txt
fi; rm -f /tmp/cmb-imp-$$.txt

# C-27b · 🔴 EL DETECTOR: las fichas que nombran un COMANDO arrancan con `` - **` `` en vez de
# `- **[`; el detector angosto las pierde en silencio y un verificador de poda diría «no se perdió
# nada» habiéndolas dejado afuera (hallazgo del validador, Step 1 de esta story).
#
# 🔴 Lo que se compara es la DIFERENCIA, no un total (2026-09-17). Antes decía «105 y 101» clavados:
# el README ganó dos fichas y el caso se puso rojo sin que el detector tuviera nada malo — una prueba
# que se rompe cuando alguien documenta una pieza nueva enseña a ignorarla. Ahora exige que las que
# encuentra de más sean EXACTAMENTE las de comando, que es lo que el par vino a fijar; y si algún día
# no queda ninguna, lo dice en vez de pasar en verde sin haber probado nada.
ENTRADAS=$(node -e '
const { entradasDe } = require(process.argv[1]);
const fs = require("fs"), cp = require("child_process");
let txt; try { txt = cp.execFileSync("git", ["-C", process.argv[2], "show", "origin/main:INDEX.md"], { encoding: "utf8", maxBuffer: 1 << 28 }); }
catch { txt = fs.readFileSync(process.argv[2] + "/INDEX.md", "utf8"); }
const anchas = entradasDe(txt);
const L = txt.split("\n");
const angostas = L.filter((l) => l.startsWith("- **["));
const deComando = L.filter((l) => /^- \*\*`/.test(l));
console.log(anchas.length + " " + angostas.length + " " + deComando.length);
' "$G" "$RAIZ" 2>/dev/null)
A=$(echo "$ENTRADAS" | awk '{print $1}'); B=$(echo "$ENTRADAS" | awk '{print $2}'); C=$(echo "$ENTRADAS" | awk '{print $3}')
if [ "${C:-0}" -eq 0 ] 2>/dev/null; then
  echo "  ⚠️   — C-27b no verificado: hoy el README no tiene fichas de comando (\`- **\`), así que el detector angosto no perdería ninguna. No es un verde."
elif [ "$A" = "$((B + C))" ]; then
  ok "C-27b entradasDe() encuentra las $A entradas del README, y las $C de comando son justo las que el detector angosto ($B) perdería"
else
  mal "C-27b entradasDe()=$A ≠ angosto($B) + de comando($C) — si entradasDe no las suma, la poda pierde fichas en silencio"
fi

# C-27c · 🔴 una entrada MULTILÍNEA no se trunca. En markdown una viñeta sigue en las líneas
# indentadas, y el README tiene una ficha así (`guides/que-hace-el-arnes.md`, 12 de continuación).
# `entradasDe` devuelve el primer renglón —lo que hace falta para medir el tope por entrada— y con
# eso la primera poda de la 7.4 perdió 1.184 bytes EN SILENCIO: el verificador comparaba el mismo
# texto truncado en los dos lados, o sea que se verificaba a sí mismo. Quien MUEVE texto usa
# `entradasCompletasDe`. Este par es el rojo previo de ese arreglo.
MULTI=$(node -e '
const { entradasDe, entradasCompletasDe } = require(process.argv[1]);
const t = "- **[a](a)** — arranca\n  y sigue acá.\n  y acá también.\n\n- **[b](b)** — sola.\n";
const a = entradasDe(t), c = entradasCompletasDe(t);
console.log(a.length, c.length, c[0].split("\n").length, c[0].includes("y acá también") ? "completa" : "TRUNCADA");
' "$G" 2>/dev/null)
set -- $MULTI
if [ "${1:-}" = 2 ] && [ "${2:-}" = 2 ] && [ "${3:-}" = 3 ] && [ "${4:-}" = "completa" ]; then
  ok "C-27c entradasCompletasDe conserva las líneas de continuación (entradasDe sigue dando el primer renglón, para medir el tope)"
else
  mal "C-27c entradas=${1:-?} completas=${2:-?} líneas=${3:-?} ${4:-?} — una mudanza truncaría las fichas multilínea"
fi

# C-27d · y sobre el README REAL: las fichas completas pesan MÁS que sus primeros renglones
# (si fueran iguales, el caso de arriba no estaría probando nada sobre este repo)
#
# 🔴 Desde la story 7.4 el README es un índice de UN renglón por ficha —el cuerpo se mudó a
# `guides/piezas-del-arnes.md`— así que hoy no queda ninguna multilínea que medir (2026-09-17). El
# caso no se borra: si alguien vuelve a partir una ficha en dos renglones, vuelve a medir sola. Sin
# multilínea deja CONSTANCIA, que no es lo mismo que un verde: C-27c sigue probando la función con
# texto propio, y es ahí donde vive la garantía mientras el README sea de una línea.
REAL=$(node -e '
const { entradasDe, entradasCompletasDe } = require(process.argv[1]);
const cp = require("child_process");
let t; try { t = cp.execFileSync("git", ["-C", process.argv[2], "show", "origin/main:INDEX.md"], { encoding: "utf8", maxBuffer: 1 << 28 }); }
catch { console.log("SIN-ORIGIN"); process.exit(0); }
const L = t.split("\n"); const i = L.findIndex((l) => /^## Qué contiene/.test(l));
let f = L.length; for (let k = i + 1; k < L.length; k++) if (/^## /.test(L[k])) { f = k; break; }
const sec = L.slice(i + 1, f).join("\n");
const b = (a) => a.reduce((s, x) => s + Buffer.byteLength(x, "utf8"), 0);
const co = entradasCompletasDe(sec);
console.log(entradasDe(sec).length, co.length, b(co) - b(entradasDe(sec)), co.filter((x) => x.includes("\n")).length);
' "$G" "$RAIZ" 2>/dev/null)
if [ "$REAL" = "SIN-ORIGIN" ]; then
  echo "  ⚠️   — C-27d no verificado: el clon no tiene origin/main. No es un verde."
else
  set -- $REAL
  if [ "${1:-}" = 0 ] && [ "${2:-}" = 0 ]; then
    # Desde la story 7.7 el README ya no es índice: las piezas se buscan en la guía de piezas.
    echo "  ⚠️   — C-27d no verificado sobre el repo real: desde la story 7.7 el README no tiene fichas («Qué contiene» apunta a la guía de piezas). No es un verde (lo prueba C-27c)."
  elif [ "${4:-0}" -eq 0 ] 2>/dev/null && [ "${1:-0}" -gt 0 ] 2>/dev/null && [ "${1:-}" = "${2:-}" ]; then
    echo "  ⚠️   — C-27d no verificado sobre el repo real: desde la story 7.4 las ${1} fichas del README son de un solo renglón, no hay multilínea que medir. No es un verde (lo prueba C-27c)."
  elif [ "${1:-}" = "${2:-}" ] && [ "${1:-0}" -gt 0 ] 2>/dev/null && [ "${3:-0}" -gt 0 ] 2>/dev/null && [ "${4:-0}" -ge 1 ]; then
    ok "C-27d en el README real las ${1} completas pesan ${3} bytes más que sus primeros renglones (${4} ficha(s) multilínea)"
  else
    mal "C-27d entradas=${1:-?} completas=${2:-?} delta=${3:-?} multilínea=${4:-?}"
  fi
fi

# ── T34 · Blocks_RequiresProfile_OffRemoves_UnknownStays_FullByteIdentical (story 8.16, tanda C · AC 24) ─────────────
# Un bloque puede pedir el perfil `full` con `<!-- requires-profile: full -->` en sus primeras líneas, solo o junto a
# `requires-integration` (uno de cada uno como mucho, en cualquier orden; ninguno se copia al CLAUDE.md). Con el perfil
# activo fuera de la lista no se agrega y, si estaba, se quita entre sus marcadores (con --check sólo avisa que sobra). Si
# no se pudo saber (configuración rota, o un marcador casi bien escrito), no se agrega si falta y queda si está, dicho en
# una línea. Con `full`, o sin valor, el CLAUDE.md queda byte a byte como con el sync de antes de la tanda.
# 🔴 rojo previo verificado: sin el marcador en el sync, un bloque con `requires-profile` se copia con el comentario
#    adentro y se escribe también en minimal.
echo "T34 · Blocks_RequiresProfile_OffRemoves_UnknownStays_FullByteIdentical"
P="$(mktemp -d)"; P="$(cd "$P" && pwd)"
arbol_sync() { # arbol_sync <dir> → el sync y el lector de configuración de este repo, con bloques de juguete
  mkdir -p "$1/scripts/setup" "$1/scripts/lib" "$1/claude-md-blocks"
  cp "$RAIZ/scripts/setup/sync-claude-md-blocks.sh" "$1/scripts/setup/"
  cp "$RAIZ"/scripts/lib/*.js "$RAIZ"/scripts/lib/*.json "$1/scripts/lib/" 2>/dev/null
  printf '<!-- requires-profile: full -->\n# Bloque de full\nsólo con full\n' > "$1/claude-md-blocks/de-full.md"
  printf '<!-- requires-profile: full -->\n<!-- requires-integration: ado -->\n# Dos marcadores\nfull y ado\n' > "$1/claude-md-blocks/dos-a.md"
  printf '<!-- requires-integration: ado -->\n<!-- requires-profile: full -->\n# Dos marcadores al revés\nado y full\n' > "$1/claude-md-blocks/dos-b.md"
  printf '# Bloque común\nsiempre\n' > "$1/claude-md-blocks/comun.md"
}
sync_lab() { # sync_lab <árbol> <home> [VAR=val…] [-- --check] → corre el sync; la salida en $P/sync.out
  local tr="$1" h="$2"; shift 2
  local extra=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do extra+=("$1"); shift; done; [ "${1:-}" = "--" ] && shift
  env -u TYCON_INSTALL_PROFILE -u TYCON_ADO_ORG -u ADO_ORG -u TYCON_NO_CLAUDEMD_SYNC HOME="$h" TYCON_PROFILE=0 TYCON_CODEX=0 \
    CLAUDE_MD_PATH="$h/CLAUDE.md" CODEX_AGENTS_MD_PATH="$h/AGENTS.md" ${extra[@]+"${extra[@]}"} bash "$tr/scripts/setup/sync-claude-md-blocks.sh" "$@" > "$P/sync.out" 2>&1
}
tiene() { grep -q "TYCON_BLOCK:$2 START" "$1/CLAUDE.md" 2>/dev/null; }
ADO=(TYCON_ADO_ORG=https://dev.azure.com/acme)
A="$P/arbol"; arbol_sync "$A"

# minimal: los de full no se agregan; el común sí; el comentario nunca se copia
H="$P/min"; mkdir -p "$H"; sync_lab "$A" "$H" TYCON_INSTALL_PROFILE=minimal "${ADO[@]}"
{ ! tiene "$H" de-full && ! tiene "$H" dos-a && ! tiene "$H" dos-b && tiene "$H" comun; } \
  && ok "T34 minimal: no agrega los bloques de full (solos o con su integración prendida) y sí el común" \
  || mal "T34 minimal: $(grep -o 'TYCON_BLOCK:[a-z-]* START' "$H/CLAUDE.md" 2>/dev/null | tr '\n' ' ')"
# full: los cuatro (con ado prendida), sin los comentarios
H="$P/full"; mkdir -p "$H"; sync_lab "$A" "$H" TYCON_INSTALL_PROFILE=full "${ADO[@]}"
{ tiene "$H" de-full && tiene "$H" dos-a && tiene "$H" dos-b && tiene "$H" comun; } && ok "T34 full: los cuatro bloques" || mal "T34 full: $(grep -o 'TYCON_BLOCK:[a-z-]* START' "$H/CLAUDE.md" 2>/dev/null | tr '\n' ' ')"
grep -q 'requires-' "$H/CLAUDE.md" && mal "T34 full: un marcador se copió al CLAUDE.md" || ok "T34 los marcadores no se copian"
# full con ado apagada: los de dos marcadores no (la integración manda igual que siempre)
H="$P/full-sin-ado"; mkdir -p "$H"; sync_lab "$A" "$H" TYCON_INSTALL_PROFILE=full
{ tiene "$H" de-full && ! tiene "$H" dos-a && ! tiene "$H" dos-b; } && ok "T34 full sin ado: los de dos marcadores esperan su integración" || mal "T34 full sin ado: $(grep -o 'TYCON_BLOCK:[a-z-]* START' "$H/CLAUDE.md" | tr '\n' ' ')"

# de full a minimal: --check sólo avisa que sobra; sin --check se quita entre sus marcadores, y lo ajeno queda igual
H="$P/cambio"; mkdir -p "$H"; printf 'mi texto de arriba\n' > "$H/CLAUDE.md"
sync_lab "$A" "$H" TYCON_INSTALL_PROFILE=full "${ADO[@]}"; printf 'mi texto de abajo\n' >> "$H/CLAUDE.md"
cp "$H/CLAUDE.md" "$P/antes.md"
sync_lab "$A" "$H" TYCON_INSTALL_PROFILE=minimal "${ADO[@]}" -- --check
{ cmp -s "$H/CLAUDE.md" "$P/antes.md" && grep -q "de-full' sobra (perfil «minimal»)" "$P/sync.out"; } && ok "T34 --check en minimal: sólo avisa que sobra" || mal "T34 --check: $(head -c 300 "$P/sync.out")"
sync_lab "$A" "$H" TYCON_INSTALL_PROFILE=minimal "${ADO[@]}"
{ ! tiene "$H" de-full && ! tiene "$H" dos-a && tiene "$H" comun && grep -q '^mi texto de arriba$' "$H/CLAUDE.md" && grep -q '^mi texto de abajo$' "$H/CLAUDE.md"; } \
  && ok "T34 de full a minimal: los quita entre sus marcadores y deja lo ajeno" || mal "T34 de full a minimal: $(cat "$H/CLAUDE.md" | head -20 | tr '\n' '|')"
grep -q "quitado (perfil «minimal»)" "$P/sync.out" && ok "T34 lo dice al quitarlo" || mal "T34 no dice que lo quitó: $(head -c 300 "$P/sync.out")"
#   …y de vuelta a full, el mismo archivo que antes (lo repone en su lugar)
sync_lab "$A" "$H" TYCON_INSTALL_PROFILE=full "${ADO[@]}"
tiene "$H" de-full && ok "T34 de vuelta a full: lo repone" || mal "T34 de vuelta a full no lo repuso"

# no se pudo saber: la configuración rota → no se agrega si falta, queda si está, y una línea lo dice
H="$P/rota"; mkdir -p "$H"; sync_lab "$A" "$H" TYCON_INSTALL_PROFILE=medio
{ ! tiene "$H" de-full && grep -q "requiere el perfil «full» y no pude saber" "$P/sync.out"; } && ok "T34 rota: no lo agrega y lo dice" || mal "T34 rota sobre vacío: $(head -c 300 "$P/sync.out")"
H="$P/rota2"; mkdir -p "$H"; sync_lab "$A" "$H" TYCON_INSTALL_PROFILE=full; sync_lab "$A" "$H" TYCON_INSTALL_PROFILE=medio
tiene "$H" de-full && ok "T34 rota: si estaba, queda" || mal "T34 rota: lo sacó"
# un marcador casi bien escrito, o dos del mismo, es «no se pudo saber»
B="$P/arbol-casi"; arbol_sync "$B"; rm -f "$B/claude-md-blocks/"dos-*.md
printf '<!--requires-profile full-->\n# Casi\ncasi bien\n' > "$B/claude-md-blocks/casi.md"
printf '<!-- requires-profile: full -->\n<!-- requires-profile: full -->\n# Dos iguales\nrepetido\n' > "$B/claude-md-blocks/repetido.md"
H="$P/casi"; mkdir -p "$H"; sync_lab "$B" "$H" TYCON_INSTALL_PROFILE=full
{ ! tiene "$H" casi && ! tiene "$H" repetido && grep -q "casi'" "$P/sync.out" && grep -q "repetido'" "$P/sync.out"; } \
  && ok "T34 casi bien escrito o repetido: no se agrega y se dice" || mal "T34 casi bien escrito: $(head -c 400 "$P/sync.out")"
grep -q 'requires-profile' "$H/CLAUDE.md" 2>/dev/null && mal "T34 un marcador casi bien escrito se copió" || ok "T34 el marcador casi bien escrito tampoco se copia"

# full y sin valor, con los bloques REALES: byte a byte como el sync de antes de la tanda (la punta de la tanda B), con los
# bloques de entonces (sin el marcador)
BASE_REF="${TYCON_PROFILE_BASE_REF:-6f1f6dec}"
if git -C "$RAIZ" cat-file -e "${BASE_REF}^{commit}" 2>/dev/null; then
  OLD="$P/viejo"; mkdir -p "$OLD"; git -C "$RAIZ" archive "$BASE_REF" scripts/setup/sync-claude-md-blocks.sh scripts/lib claude-md-blocks | ( cd "$OLD" && tar xf - )
  # story 8.19 (tanda E): cambió el texto de dos bloques y la descripción de la marca de arranque («generado por … del
  # arnés»). T34 mide el perfil, no esos textos: el sync viejo recibe los bloques de hoy (sin el marcador, que no conoce)
  # y la marca se compara sin su descripción. Sigue frenando un bloque de más, de menos o con otro cuerpo.
  rm -rf "$OLD/claude-md-blocks" && cp -R "$RAIZ/claude-md-blocks" "$OLD/claude-md-blocks" \
    && for f in "$OLD"/claude-md-blocks/*.md; do grep -v '^<!-- requires-profile:' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done
  NEW="$P/nuevo"; mkdir -p "$NEW/scripts/setup" "$NEW/scripts/lib"; cp "$RAIZ/scripts/setup/sync-claude-md-blocks.sh" "$NEW/scripts/setup/"
  cp "$RAIZ"/scripts/lib/*.js "$RAIZ"/scripts/lib/*.json "$NEW/scripts/lib/" 2>/dev/null; cp -R "$RAIZ/claude-md-blocks" "$NEW/"
  for modo in sin-valor full; do
    HO="$P/real-viejo-$modo"; HN="$P/real-nuevo-$modo"; mkdir -p "$HO" "$HN"
    printf 'texto propio\n' > "$HO/CLAUDE.md"; cp "$HO/CLAUDE.md" "$HN/CLAUDE.md"
    extra=("${ADO[@]}"); [ "$modo" = full ] && extra+=(TYCON_INSTALL_PROFILE=full)
    sync_lab "$OLD" "$HO" "${ADO[@]}"; sync_lab "$NEW" "$HN" "${extra[@]}"
    for h in "$HO" "$HN"; do sed -E 's#(<!-- TYCON_BLOCK:[^ ]+ START) — generado por [^·]*·#\1 — generado por @SYNC@ ·#' "$h/CLAUDE.md" > "$h/CLAUDE.norm.md"; done
    cmp -s "$HO/CLAUDE.norm.md" "$HN/CLAUDE.norm.md" && ok "T34 bloques reales, ${modo}: CLAUDE.md byte a byte igual al del sync de ${BASE_REF} (la descripción de la marca aparte)" \
      || mal "T34 bloques reales, ${modo}: distinto: $(diff "$HO/CLAUDE.norm.md" "$HN/CLAUDE.norm.md" | head -4 | tr '\n' ' ')"
  done
elif [ ! -f "$RAIZ/scripts/publishing/public-repos.json" ]; then
  # La copia pública (sin scripts/publishing/public-repos.json, que no se publica) no trae la historia ni el perfil del
  # equipo: lo que los necesita ahí NO SE PUEDE MEDIR y se dice como «NO MEDIDO en la copia», sin contar como rojo; en el
  # repo interno, que falten sigue siendo rojo (la convención de harness-place.test.js, story 8.19).
  echo "  ⏭   — T34 bloques reales: NO MEDIDO en la copia — no trae el commit de antes de la tanda (${BASE_REF})"
else
  mal "T34 NO MEDIDO — no está el commit de antes de la tanda (${BASE_REF}): no puedo comparar con el sync de entonces"
fi
# los marcadores de los bloques reales: se miden también en la copia (no necesitan historia)
for b in response-style tool-names background-execution; do
  head -n 3 "$RAIZ/claude-md-blocks/$b.md" | grep -qx '<!-- requires-profile: full -->' && ok "T34 $b.md lleva el marcador" || mal "T34 $b.md no lleva <!-- requires-profile: full -->"
done
grep -q 'requires-profile' "$RAIZ/claude-md-blocks/ado-runs-list-lag.md" && mal "T34 ado-runs-list-lag.md cambió (no lleva el marcador)" || ok "T34 ado-runs-list-lag.md sin el marcador"
rm -rf "$P"

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
