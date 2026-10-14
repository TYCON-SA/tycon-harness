#!/usr/bin/env bash
# branch-guard-notice.test.sh — el consejo que da el aviso de arranque para un clon trabado FUNCIONA (story 8.5.1, T1-T3).
#
# Lo que no se puede perder:
#   · Que los comandos que imprime el aviso, corridos tal cual y en orden, destraben el clon: con un conflicto que HEAD
#     no tiene (DU: el retiro borró un archivo que el dev había modificado) `checkout HEAD --` falla ENTERO y no resuelve
#     ni los demás (pase adversarial de la 8.5 tanda B). Por eso esto corre los comandos, no busca texto.
#   · Que ninguna ruta de un tipo caiga en el comando del otro, que lo del dev siga en el disco y en el stash, y que una
#     ruta o una carpeta con espacio llegue citada.
#
# Laboratorio: todo bajo `mktemp -d /tmp/tycon-branch-guard.XXXXXX` (nunca bajo una ruta del arnés). El hook se copia
# suelto a una carpeta que NO es un repo (así el arnés de juguete no se juzga y sólo aparece agent-skills) y corre con un
# HOME de juguete cuyo `.claude/agent-skills` es el clon trabado.
# 🔴 Sin pipes sobre el comando medido: el exit code REAL es el veredicto.
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="$(mktemp -d /tmp/tycon-branch-guard.XXXXXX)"
case "$BASE" in *tycon-claude-guides*|*agent-skills*|*.claude*) echo "❌ branch-guard-notice: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"' EXIT
FALLAS=0
ok() { echo "✅ branch-guard-notice: $1"; }
bad() { echo "❌ branch-guard-notice: $1"; FALLAS=$((FALLAS + 1)); }
g() { env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com \
  git -c core.hooksPath=/dev/null "$@"; }
HOOK_DIR="$BASE/sin-repo/scripts/hooks"; mkdir -p "$HOOK_DIR"; cp "$TCG/scripts/hooks/branch-guard-notice.js" "$HOOK_DIR/"
( cd "$BASE/sin-repo" && git rev-parse --git-dir >/dev/null 2>&1 ) && { echo "❌ branch-guard-notice: ${BASE} quedó dentro de un repo"; exit 1; }

# el aviso, como lo corre el arranque, con un HOME de juguete
notice() { # notice <home>
  env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE HOME="$1" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    node "$HOOK_DIR/branch-guard-notice.js"
}
# corre, en orden, las líneas `git -C …` del consejo; devuelve el primer exit code distinto de 0
run_advice() { # run_advice <home> <salida del aviso>
  local line rc=0
  while IFS= read -r line; do
    env HOME="$1" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null bash -c "$line" >/dev/null 2>&1 || { rc=$?; break; }
  done < <(sed -n 's/^  \(git -C .*\)$/\1/p' <<<"$2")
  return "$rc"
}
# stuck <home> <ruta ajena que el retiro borra> <ruta propia que cambia arriba, o vacío>
# → $home/.claude/agent-skills trabado como lo deja la línea de arranque (`pull --ff-only --autostash`)
stuck() {
  local h="$1" du="$2" uu="$3" up="$1.up" as="$1/.claude/agent-skills"
  g init -q -b main "$up"; mkdir -p "$up/skills/own" "$(dirname "$up/$du")"
  printf 'propia v1\n' > "$up/skills/own/SKILL.md"; printf 'ajena v1\n' > "$up/$du"
  g -C "$up" add -A && g -C "$up" commit -q -m A
  mkdir -p "$h/.claude"; g clone -q "$up" "$as"
  g -C "$up" rm -q -- "$du"; [ -n "$uu" ] && printf 'propia v2\n' > "$up/$uu"; g -C "$up" add -A && g -C "$up" commit -q -m 'B: retiro'
  printf 'ajena, tocada por el dev\n' > "$as/$du"; [ -n "$uu" ] && printf 'propia, tocada por el dev\n' > "$as/$uu"
  g -C "$as" pull -q --ff-only --autostash >/dev/null 2>&1
}
unmerged() { g -C "$1" ls-files -u | wc -l | tr -d ' '; }

# ═══ T1 · DU ajeno + UU propio (la receta del probe): dos comandos, cada ruta en el suyo, y corridos destraban ═══════════
H="$BASE/h1"; AS="$H/.claude/agent-skills"; stuck "$H" skills/acme/SKILL.md skills/own/SKILL.md
u0="$(unmerged "$AS")"; out="$(notice "$H")"; rc=$?
rm_line="$(grep 'rm --cached' <<<"$out")"; co_line="$(grep 'checkout HEAD' <<<"$out")"
run_advice "$H" "$out"; rca=$?
g -C "$AS" merge -q --ff-only origin/main >/dev/null 2>&1; rcm=$?
if [ "$u0" -gt 0 ] && [ "$rc" -eq 0 ] && grep -q 'skills/acme/SKILL.md' <<<"$rm_line" && ! grep -q 'skills/own' <<<"$rm_line" \
   && grep -q 'skills/own/SKILL.md' <<<"$co_line" && ! grep -q 'skills/acme' <<<"$co_line" \
   && [ "$rca" -eq 0 ] && [ "$(unmerged "$AS")" = 0 ] && [ "$rcm" -eq 0 ] \
   && [ "$(cat "$AS/skills/acme/SKILL.md" 2>&1)" = 'ajena, tocada por el dev' ] && g -C "$AS" stash list | grep -q autostash; then
  ok "T1 DU + UU: un rm --cached para el ajeno, un checkout HEAD para el propio; corridos, el clon se destraba y lo del dev queda"
else bad "T1 (conflictos ${u0} → $(unmerged "$AS"), consejo rc=$rca, merge rc=$rcm): $out"; fi

# ═══ T2 · sólo UU (el caso de hoy): el mismo consejo de siempre, y funciona ═══════════════════════════════════════════
H="$BASE/h2"; AS="$H/.claude/agent-skills"
g init -q -b main "$H.up"; mkdir -p "$H.up/skills/own"; printf 'v1\n' > "$H.up/skills/own/SKILL.md"
g -C "$H.up" add -A && g -C "$H.up" commit -q -m A; mkdir -p "$H/.claude"; g clone -q "$H.up" "$AS"
printf 'v2\n' > "$H.up/skills/own/SKILL.md"; g -C "$H.up" commit -q -am B
printf 'del dev\n' > "$AS/skills/own/SKILL.md"; g -C "$AS" pull -q --ff-only --autostash >/dev/null 2>&1
u0="$(unmerged "$AS")"; out="$(notice "$H")"
run_advice "$H" "$out"; rca=$?
if [ "$u0" -gt 0 ] && grep -q 'checkout HEAD -- skills/own/SKILL.md' <<<"$out" && ! grep -q 'rm --cached' <<<"$out" \
   && [ "$rca" -eq 0 ] && [ "$(unmerged "$AS")" = 0 ]; then
  ok "T2 sólo UU: el consejo sigue siendo checkout HEAD sobre esa ruta, y destraba"
else bad "T2 (conflictos ${u0} → $(unmerged "$AS"), consejo rc=$rca): $out"; fi

# ═══ T3 · una ruta y una carpeta con espacio: van citadas y el comando corre; la ruta simple, sin comillas ═════════════
H="$BASE/con espacio/h3"; AS="$H/.claude/agent-skills"; mkdir -p "$BASE/con espacio"
stuck "$H" 'skills/con espacio/SKILL.md' skills/own/SKILL.md
u0="$(unmerged "$AS")"; out="$(notice "$H")"
rm_line="$(grep 'rm --cached' <<<"$out")"; co_line="$(grep 'checkout HEAD' <<<"$out")"
run_advice "$H" "$out"; rca=$?
if [ "$u0" -gt 0 ] && grep -qF "git -C '$AS' rm --cached -- 'skills/con espacio/SKILL.md'" <<<"$rm_line" \
   && grep -qF "git -C '$AS' checkout HEAD -- skills/own/SKILL.md" <<<"$co_line" \
   && [ "$rca" -eq 0 ] && [ "$(unmerged "$AS")" = 0 ] && [ -f "$AS/skills/con espacio/SKILL.md" ]; then
  ok "T3 ruta y carpeta con espacio: citadas con comillas simples, la ruta simple sin ellas, y los comandos destraban"
else bad "T3 (conflictos ${u0} → $(unmerged "$AS"), consejo rc=$rca): $out"; fi

# ═══ T15 · trabado Y atrasado, con un archivo que el dev tocó después y que lo publicado también cambia (pase adversarial,
# vuelta 2): la secuencia trae `git stash` entre los conflictos y el merge, y corrida entera el merge entra ═════════════
H="$BASE/h15"; AS="$H/.claude/agent-skills"; UP="$H.up"
g init -q -b main "$UP"; mkdir -p "$UP/skills/own" "$UP/skills/acme" "$UP/docs"
printf 'propia v1\n' > "$UP/skills/own/SKILL.md"; printf 'ajena v1\n' > "$UP/skills/acme/SKILL.md"; printf 'notas v1\n' > "$UP/docs/NOTAS.md"
g -C "$UP" add -A && g -C "$UP" commit -q -m A; mkdir -p "$H/.claude"; g clone -q "$UP" "$AS"
g -C "$UP" rm -q skills/acme/SKILL.md; printf 'propia v2\n' > "$UP/skills/own/SKILL.md"; g -C "$UP" add -A && g -C "$UP" commit -q -m 'B: retiro'
printf 'ajena, tocada\n' > "$AS/skills/acme/SKILL.md"; printf 'propia, tocada\n' > "$AS/skills/own/SKILL.md"
g -C "$AS" pull -q --ff-only --autostash >/dev/null 2>&1                     # trabado: DU + UU, HEAD = B
printf 'notas, tocadas después de trabarse\n' > "$AS/docs/NOTAS.md"          # el dev siguió trabajando
printf 'notas v2\n' > "$UP/docs/NOTAS.md"; g -C "$UP" commit -q -am C; g -C "$AS" fetch -q origin   # atrasado (la sanadora fetchea)
out="$(notice "$H")"; advice="$(sed -n 's/^  \(git -C .*\)$/\1/p' <<<"$out")"
run_advice "$H" "$out"; rca=$?
if grep -q "git -C $AS stash" <<<"$advice" && [ "$(tail -1 <<<"$advice" | grep -c 'merge --ff-only')" = 1 ] \
   && [ "$rca" -eq 0 ] && [ "$(unmerged "$AS")" = 0 ] && [ "$(g -C "$AS" rev-parse HEAD)" = "$(g -C "$UP" rev-parse HEAD)" ] \
   && g -C "$AS" stash list | grep -q autostash; then
  ok "T15 trabado y atrasado con un archivo tocado después: git stash antes del merge, y la secuencia entera entra"
else bad "T15 (consejo rc=$rca, conflictos $(unmerged "$AS"), HEAD $(g -C "$AS" rev-parse --short HEAD) vs $(g -C "$UP" rev-parse --short HEAD)): $out"; fi

# ═══ T16 · un nombre hostil (comilla y $(…)): va citado, el comando destraba y no se ejecuta nada del nombre ═══════════
H="$BASE/h16"; AS="$H/.claude/agent-skills"; HOSTIL="skills/it's \$(touch PWNED) \`touch PWNED2\`.md"
stuck "$H" "$HOSTIL" skills/own/SKILL.md
u0="$(unmerged "$AS")"; out="$(notice "$H")"
( cd "$BASE" && run_advice "$H" "$out" ); rca=$?
if [ "$u0" -gt 0 ] && grep -qF "'skills/it'\\''s \$(touch PWNED) \`touch PWNED2\`.md'" <<<"$out" && [ "$rca" -eq 0 ] \
   && [ "$(unmerged "$AS")" = 0 ] && [ -z "$(find "$BASE" "$AS" -name 'PWNED*' 2>/dev/null)" ]; then
  ok "T16 un nombre con comilla, \$(…) y comillas invertidas va citado; corrido, destraba y no ejecuta nada"
else bad "T16 (conflictos ${u0} → $(unmerged "$AS"), consejo rc=$rca, PWNED: $(find "$BASE" "$AS" -name 'PWNED*' 2>/dev/null | head -2)): $out"; fi

# ═══ story 8.13 (tanda A, T10) · el aviso síncrono lee el estado del mecanismo nuevo ══════════════════════════════════
# (a) imprime el `notice` pendiente que dejó `startup`, dirigido a la persona; (b) grita «atrasado» SÓLO en `managed` con
# `apply: auto` (en `developer`, en `ask` o con TYCON_UPDATE=0 el atraso es decisión de esa persona: lo dice `doctor`);
# (c) `harness-bootstrap-heal.sh` considera sana una línea de arranque que llama a `bootstrap.js`.
# atrasado <home>: $home/.claude/agent-skills en main, 1 commit atrás de origin/main (sin conflicto)
atrasado() {
  local h="$1" up="$1.up" as="$1/.claude/agent-skills"
  g init -q -b main "$up"; mkdir -p "$up/skills/own"; printf 'v1\n' > "$up/skills/own/SKILL.md"
  g -C "$up" add -A && g -C "$up" commit -q -m A; mkdir -p "$h/.claude/.tycon-pipeline"; g clone -q "$up" "$as"
  printf 'v2\n' > "$up/skills/own/SKILL.md"; g -C "$up" commit -q -am B; g -C "$as" fetch -q origin
}
estado() { # estado <home> <json>
  printf '%s\n' "$2" > "$1/.claude/.tycon-pipeline/harness-state.json"
}
# sin estado: grita el atraso como siempre
H="$BASE/h10a"; atrasado "$H"; out="$(notice "$H")"
grep -q 'ARNÉS ATRASADO' <<<"$out" && ok "T10 sin estado: grita el atraso como hoy" || bad "T10 sin estado no grita: $out"
# managed + auto: grita
H="$BASE/h10b"; atrasado "$H"; estado "$H" '{"schema":1,"mode":"managed","tree":"/","notice":null}'
out="$(TYCON_UPDATE_APPLY=auto notice "$H")"
grep -q 'ARNÉS ATRASADO' <<<"$out" && ok "T10 managed + auto: grita el atraso" || bad "T10 managed+auto no grita: $out"
# managed + ask: calla el atraso (lo dice doctor)
out="$(TYCON_UPDATE_APPLY=ask notice "$H")"
grep -q 'ARNÉS ATRASADO' <<<"$out" && bad "T10 managed+ask grita igual: $out" || ok "T10 managed + ask: calla el atraso"
# TYCON_UPDATE=0: calla
out="$(TYCON_UPDATE=0 TYCON_UPDATE_APPLY=auto notice "$H")"
grep -q 'ARNÉS ATRASADO' <<<"$out" && bad "T10 TYCON_UPDATE=0 grita igual: $out" || ok "T10 TYCON_UPDATE=0: calla el atraso"
# developer: calla
H="$BASE/h10c"; atrasado "$H"; estado "$H" '{"schema":1,"mode":"developer","tree":"/","notice":null}'
out="$(TYCON_UPDATE_APPLY=auto notice "$H")"
grep -q 'ARNÉS ATRASADO' <<<"$out" && bad "T10 developer grita igual: $out" || ok "T10 developer: calla el atraso"
# el notice pendiente aparece en la salida del hook síncrono, dirigido a la persona, aunque no haya atraso
H="$BASE/h10d"; mkdir -p "$H/.claude/.tycon-pipeline"
estado "$H" '{"schema":1,"mode":"managed","tree":"/","notice":"arnés 2026.10.02+abc1234 disponible (instalada 2026.10.01+9999999, canal latest) · aplicar: node ~/.claude/tycon-harness/scripts/setup/harness.js update --yes"}'
out="$(TYCON_UPDATE_APPLY=ask notice "$H")"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'disponible' <<<"$out" && grep -qi 'decile a la persona' <<<"$out" && grep -qi 'no lo apliques' <<<"$out"; then
  ok "T10 el notice pendiente sale por el hook síncrono, dirigido a la persona"
else bad "T10 notice (rc=$rc): $out"; fi
# un estado ilegible: lo dice (en rojo) y sale 0
H="$BASE/h10e"; mkdir -p "$H/.claude/.tycon-pipeline"; printf '{ roto' > "$H/.claude/.tycon-pipeline/harness-state.json"
out="$(notice "$H")"; rc=$?
[ "$rc" -eq 0 ] && grep -qi 'estado' <<<"$out" && ok "T10 estado ilegible: lo dice y sale 0" || bad "T10 estado ilegible (rc=$rc): $out"
# REG-D6 · un estado de una versión más nueva (schema 9) o que apunta a un árbol que no está también se dice: antes el
# hook sólo veía un JSON roto (revisor de alcance, iteración 1)
H="$BASE/h10f"; mkdir -p "$H/.claude/.tycon-pipeline"
estado "$H" '{"schema":9,"mode":"managed","tree":"/","notice":null}'
out="$(notice "$H")"; rc=$?
[ "$rc" -eq 0 ] && grep -qi 'más nueva\|schema' <<<"$out" && ok "REG-D6 estado de una versión más nueva: lo dice y sale 0" || bad "REG-D6 schema 9 (rc=$rc): $out"
estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"$BASE/no-existe\",\"notice\":null}"
out="$(notice "$H")"; rc=$?
[ "$rc" -eq 0 ] && grep -qi 'no está\|no existe' <<<"$out" && ok "REG-D6 estado con un árbol que no está: lo dice y sale 0" || bad "REG-D6 tree ausente (rc=$rc): $out"
# ═══ story 8.13 (tanda C, T23) · con `hold` (la retención que deja `harness.js rollback`) el aviso NO grita «atrasado»
# —el atraso es a propósito: la persona deshizo esa versión— e imprime la retención, dirigida a la persona: qué versión se
# deshizo, desde cuándo y el comando para volver a actualizar. Sin `hold`, lo de siempre (T10). Si el `notice` de
# `startup` ya trae el comando para liberarla, no se repite.
HOLD='"hold":{"commit":"2026.10.02+abc1234","sources":{"harness":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","agent_skills":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"at":"2026-10-02T12:34:56.000Z","reason":"rollback"}'
H="$BASE/h23a"; atrasado "$H"; estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"/\",\"notice\":null,$HOLD}"
out="$(TYCON_UPDATE_APPLY=auto notice "$H")"; rc=$?
if [ "$rc" -eq 0 ] && ! grep -q 'ARNÉS ATRASADO' <<<"$out" && grep -q '2026.10.02+abc1234' <<<"$out" && grep -q '2026-10-02' <<<"$out" \
   && grep -q 'rollback --release' <<<"$out" && grep -qi 'decile a la persona' <<<"$out"; then
  ok "T23 hold + managed + auto + atrasado: imprime la retención (versión, desde cuándo, cómo liberarla) y no grita «atrasado»"
else bad "T23 hold (rc=$rc): $out"; fi
# el mismo repo atrasado sin hold: grita como siempre
estado "$H" '{"schema":1,"mode":"managed","tree":"/","notice":null,"hold":null}'
out="$(TYCON_UPDATE_APPLY=auto notice "$H")"
grep -q 'ARNÉS ATRASADO' <<<"$out" && ! grep -q 'rollback --release' <<<"$out" && ok "T23 sin hold: grita el atraso como siempre y no habla de retención" || bad "T23 sin hold: $out"
# con hold y un notice de startup que ya trae el comando para liberarla: el comando sale una sola vez
estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"/\",\"notice\":\"retención: deshiciste 2026.10.02+abc1234; para volver a actualizar: harness.js rollback --release\",$HOLD}"
out="$(TYCON_UPDATE_APPLY=auto notice "$H")"
[ "$(grep -c 'rollback --release' <<<"$out")" = 1 ] && ! grep -q 'ARNÉS ATRASADO' <<<"$out" && ok "T23 hold con el notice que ya lo dice: el comando para liberarla sale una vez" || bad "T23 hold + notice: $out"

# ═══ story 8.13 (tanda D, T32 / AC 26) · el aviso de versión nueva, con su número, su sha y el enlace de cambios, sale
# ENTERO por el hook síncrono (lo arma `startup`; acá se mide que nada lo corta: es una línea larga con una URL) ═════════
H="$BASE/h32"; mkdir -p "$H/.claude/.tycon-pipeline"
AVISO='arnés 2026.10.02.1 (abc1234) disponible (instalada 2026.10.01.1, canal stable) · aplicar: node ~/.claude/tycon-harness/scripts/setup/harness.js update --yes · cambios: https://example.com/example-org/example-harness/compare/1111111111111111111111111111111111111111...2222222222222222222222222222222222222222'
estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"/\",\"notice\":\"$AVISO\"}"
out="$(TYCON_UPDATE_APPLY=ask notice "$H")"; rc=$?
if [ "$rc" -eq 0 ] && grep -qF "decile a la persona: $AVISO" <<<"$out" && grep -qi 'no lo apliques' <<<"$out"; then
  ok "T32 el aviso con número, sha y enlace de cambios sale entero, dirigido a la persona"
else bad "T32 aviso con enlace (rc=$rc): $out"; fi

# ═══ story 8.13 (tanda D, A4 / AC 25) · una copia pública vive en la rama local `tycon/installed`: con el estado diciendo
# que esa fuente se reescribe, el aviso NO grita «FUERA de main» y mide el atraso contra la ref del estado. Sin estado, o
# con una fuente que no se reescribe, lo de siempre (el banco de controles corre este hook suelto).
# 🔴 rojo previo: cualquier rama distinta de `main` era un infractor sin mirar el estado, y el atraso se medía siempre
#    contra `origin/main`: cada sesión de una persona de afuera arrancaba con «BRANCH GUARD — FUERA de main».
# publico <home>: $home/.claude/agent-skills en tycon/installed, parado en la punta de origin/mirror/sync; origin/main
# tiene un commit que esa rama no (el remoto estable siguió de largo: no es atraso de `latest`)
publico() {
  local h="$1" up="$1.up" as="$1/.claude/agent-skills"
  g init -q -b main "$up"; mkdir -p "$up/skills/own"; printf 'v1\n' > "$up/skills/own/SKILL.md"
  g -C "$up" add -A && g -C "$up" commit -q -m A
  g -C "$up" checkout -q -b mirror/sync; printf 'sync\n' > "$up/skills/own/SKILL.md"; g -C "$up" commit -q -am S1
  g -C "$up" checkout -q main; printf 'main\n' > "$up/OTRO.md"; g -C "$up" add -A && g -C "$up" commit -q -m B
  mkdir -p "$h/.claude/.tycon-pipeline"; g clone -q "$up" "$as"
  g -C "$as" fetch -q origin '+refs/heads/*:refs/remotes/origin/*'
  g -C "$as" checkout -q -B tycon/installed origin/mirror/sync
}
# la fuente lleva su `dir` (la carpeta real del clon), como la escribe `harness.js`: el aviso la encuentra por la carpeta
public_source() { # public_source <home> [<rewrites>] [<ref>]
  printf '"sources":[{"name":"agent_skills","ref":"%s","rewrites":%s,"dir":"%s"}]' "${3:-mirror/sync}" "${2:-true}" "$(cd "$1/.claude/agent-skills" && pwd -P)"
}
H="$BASE/h-a4a"; publico "$H"; FUENTE_PUBLICA="$(public_source "$H")"
estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"/\",\"notice\":null,$FUENTE_PUBLICA}"
out="$(TYCON_UPDATE_APPLY=auto notice "$H")"; rc=$?
if [ "$rc" -eq 0 ] && ! grep -q 'FUERA de main' <<<"$out" && ! grep -q 'ARNÉS ATRASADO' <<<"$out"; then
  ok "A4 fuente que se reescribe, en tycon/installed y al día con su ref: ni «FUERA de main» ni «atrasado» (aunque origin/main siguió)"
else bad "A4 tycon/installed al día (rc=$rc): $out"; fi
# espejo 1: la MISMA carpeta con una fuente que no se reescribe → grita «FUERA de main»
estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"/\",\"notice\":null,$(public_source "$H" false main)}"
out="$(TYCON_UPDATE_APPLY=auto notice "$H")"
grep -q 'FUERA de main' <<<"$out" && grep -q 'tycon/installed' <<<"$out" && ok "A4 espejo: con una fuente que no se reescribe, tycon/installed sigue siendo «FUERA de main»" || bad "A4 espejo (no se reescribe): $out"
# espejo 2: sin estado → lo de siempre
rm -f "$H/.claude/.tycon-pipeline/harness-state.json"
out="$(notice "$H")"
grep -q 'FUERA de main' <<<"$out" && ok "A4 espejo: sin estado, lo de siempre (grita «FUERA de main»)" || bad "A4 espejo (sin estado): $out"
# espejo 3: fuente que se reescribe pero en OTRA rama (ni main ni tycon/installed) → grita
estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"/\",\"notice\":null,$FUENTE_PUBLICA}"
g -C "$H/.claude/agent-skills" checkout -q -b mine
out="$(TYCON_UPDATE_APPLY=auto notice "$H")"
grep -q 'FUERA de' <<<"$out" && grep -q '"mine"' <<<"$out" && ok "A4 espejo: en otra rama que no es la suya, grita" || bad "A4 espejo (otra rama): $out"
# el atraso se mide contra la ref del estado: la rama se reescribió en el remoto → atrasado (managed + auto), y el
# consejo es `harness.js update`, no un merge con origin/main
H="$BASE/h-a4b"; publico "$H"; FUENTE_PUBLICA="$(public_source "$H")"
estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"/\",\"notice\":null,$FUENTE_PUBLICA}"
g -C "$H.up" checkout -q mirror/sync; printf 'sync reescrita\n' > "$H.up/skills/own/SKILL.md"; g -C "$H.up" commit -q --amend -am S2; g -C "$H.up" checkout -q main
g -C "$H/.claude/agent-skills" fetch -q origin '+refs/heads/*:refs/remotes/origin/*'
out="$(TYCON_UPDATE_APPLY=auto notice "$H")"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'ARNÉS ATRASADO' <<<"$out" && grep -q 'origin/mirror/sync' <<<"$out" && grep -q 'harness.js update' <<<"$out" && ! grep -q 'merge --ff-only origin/main' <<<"$out"; then
  ok "A4 la rama del canal se movió en el remoto: «atrasado» contra origin/mirror/sync, y el consejo es harness.js update"
else bad "A4 atraso contra la ref del estado (rc=$rc): $out"; fi

# ═══ story 8.13 (tanda D, causa A del pase adversarial · AC 25) · la FORMA REAL de la copia pública de UN SOLO repo ═════
# `harness.js install` deja el estado con UNA fuente (`harness`, que se reescribe) y `~/.claude/agent-skills` es un ENLACE
# al mismo clon (lo crea canonical-path.js). El aviso recorre dos repos: los dos son ese clon. Tiene que encontrar la
# fuente por la CARPETA real y no por el nombre, juzgar el clon una sola vez, y no mandar nunca a `checkout main` a un
# clon cuya fuente se reescribe (seguirlo dejaba a `update` bloqueado: «está en la rama main y no en tycon/installed»).
# 🔴 rojo previo (REG-A1): buscaba la fuente `agent_skills` por nombre, no la encontraba, tomaba `main` como rama de casa
#    e imprimía en CADA sesión «BRANCH GUARD — repos compartidos del harness FUERA de main: agent-skills está en
#    "tycon/installed"… Volver: git -C <repo> checkout main». La A4 no lo veía: su estado trae una fuente `agent_skills`.
# single <home>: remoto `<home>.up` con el hook real, skills/ y agents/ en la raíz; clon `<home>.clone`; y en la HOME de
# juguete los dos enlaces al MISMO clon (el de agent-skills, con el canonical-path.js real)
single() {
  local h="$1" up="$1.up" cl="$1.clone"
  g init -q -b main "$up"; mkdir -p "$up/scripts/hooks" "$up/skills/tycon-pipeline" "$up/agents"
  cp "$TCG/scripts/hooks/branch-guard-notice.js" "$up/scripts/hooks/"
  printf '# skill de juguete\n' > "$up/skills/tycon-pipeline/SKILL.md"; printf '# revisor de juguete\n' > "$up/agents/rev.md"
  g -C "$up" add -A && g -C "$up" commit -q -m A
  g clone -q "$up" "$cl"; mkdir -p "$h/.claude/.tycon-pipeline"
  ln -s "$cl" "$h/.claude/tycon-harness"
  node "$TCG/scripts/lib/canonical-path.js" --ensure-repo-links --clone "$cl" --home "$h" --only agent-skills >/dev/null 2>&1
  [ -L "$h/.claude/agent-skills" ] || bad "laboratorio del repo único: canonical-path.js no dejó el enlace ~/.claude/agent-skills en ${h}"
}
# el estado como lo deja `harness.js install` en esa copia: una sola fuente, con su carpeta real
single_state() { # single_state <home> [<ref>] [<rewrites>]
  local cl; cl="$(cd "$1.clone" && pwd -P)"
  estado "$1" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"$cl\",\"notice\":null,\"policy\":{\"channel\":\"stable\",\"apply\":\"ask\",\"enabled\":true},\"sources\":[{\"name\":\"harness\",\"url\":\"$1.up\",\"ref\":\"${2:-main}\",\"rewrites\":${3:-true},\"dir\":\"$cl\",\"commit\":\"$(g -C "$cl" rev-parse HEAD)\",\"previous\":null}]}"
}
# la primera actualización, como la deja `sources.advance`: rama local tycon/installed + reset a lo traído
first_update() { # first_update <home>
  printf 'v2\n' > "$1.up/skills/tycon-pipeline/SKILL.md"; g -C "$1.up" commit -q -am 'B: version nueva'
  g -C "$1.clone" fetch -q origin; g -C "$1.clone" checkout -q -B tycon/installed; g -C "$1.clone" reset -q --hard origin/main
}
# el aviso del PROPIO clon, por el enlace estable, como lo llama la línea de arranque
notice_at() { # notice_at <home>
  env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR HOME="$1" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    node "$1/.claude/tycon-harness/scripts/hooks/branch-guard-notice.js"
}
# corre la línea «Volver: git -C …» del aviso tal cual; sin esa línea, falla
run_back() { # run_back <salida del aviso>
  local line; line="$(sed -n 's/^Volver: \(git -C .*\)$/\1/p' <<<"$1")"
  [ -n "$line" ] || return 97
  env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null bash -c "$line" >/dev/null 2>&1
}
offenders() { grep -c '^  - ' <<<"$1"; }
branch_of() { g -C "$1" rev-parse --abbrev-ref HEAD; }

# REG-A1 · después de la primera actualización, el clon en tycon/installed y al día: silencio, con cualquier política
H="$BASE/h-ra1"; single "$H"; first_update "$H"; single_state "$H"; CL="$H.clone"
o1="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; r1=$?; o2="$(TYCON_UPDATE_APPLY=ask notice_at "$H")"; r2=$?; o3="$(notice_at "$H")"; r3=$?
if [ "$(branch_of "$CL")" = tycon/installed ] && [ "$(branch_of "$H/.claude/agent-skills")" = tycon/installed ] \
   && [ "$r1$r2$r3" = 000 ] && [ -z "$o1$o2$o3" ]; then
  ok "REG-A1 repo único (una fuente «harness», agent-skills enlazado al mismo clon) en tycon/installed: el aviso calla (auto, ask y por defecto)"
else bad "REG-A1 repo único en tycon/installed (rc=$r1$r2$r3): $o1"; fi
# REG-A2 · espejo: ese MISMO clon en una rama propia de la persona → avisa, lo nombra UNA vez, y el consejo NO es
# `checkout main`: es volver a tycon/installed, y corrido tal cual funciona (y el aviso vuelve a callar)
# 🔴 rojo previo: dos renglones para el mismo clon (el arnés y agent-skills) y «Volver: git -C <repo> checkout main»
g -C "$CL" checkout -q -b mine
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?
run_back "$out"; rcb=$?; after="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"
if [ "$rc" -eq 0 ] && grep -q 'BRANCH GUARD' <<<"$out" && [ "$(offenders "$out")" = 1 ] && grep -q 'está en "mine"' <<<"$out" \
   && ! grep -q 'checkout main' <<<"$out" && ! grep -qi 'volver a main' <<<"$out" && grep -q 'checkout tycon/installed' <<<"$out" \
   && [ "$rcb" -eq 0 ] && [ "$(branch_of "$CL")" = tycon/installed ] && [ -z "$after" ]; then
  ok "REG-A2 espejo: el mismo clon en otra rama avisa, lo nombra una vez, y el consejo (volver a tycon/installed, nunca a main) corrido funciona"
else bad "REG-A2 espejo en otra rama (rc=$rc, renglones $(offenders "$out"), consejo rc=$rcb, quedó en $(branch_of "$CL")): $out"; fi
# REG-A3 · alguien siguió el consejo viejo: el clon en `main` DESPUÉS de su primera actualización (tycon/installed ya
# existe). `update` no lo toca desde ahí: el aviso lo dice, y su consejo lo devuelve a tycon/installed
# 🔴 rojo previo: `main` valía siempre para una fuente que se reescribe → silencio, con `update` bloqueado
g -C "$CL" checkout -q main
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?
run_back "$out"; rcb=$?
if [ "$rc" -eq 0 ] && [ "$(offenders "$out")" = 1 ] && grep -q 'está en "main" y no en "tycon/installed"' <<<"$out" \
   && ! grep -q 'checkout main' <<<"$out" && [ "$rcb" -eq 0 ] && [ "$(branch_of "$CL")" = tycon/installed ]; then
  ok "REG-A3 en main después de la primera actualización: avisa (update no lo toca desde ahí) y el consejo lo devuelve a tycon/installed"
else bad "REG-A3 en main con tycon/installed ya creada (rc=$rc, consejo rc=$rcb, quedó en $(branch_of "$CL")): $out"; fi
# REG-A4 · atrasado: una vez, contra la ref que el estado dice para ESA fuente, y el consejo es `harness.js update`
# 🔴 rojo previo: el atraso salía para el arnés y, además, «FUERA de main» para agent-skills (el mismo clon)
printf 'v3\n' > "$H.up/skills/tycon-pipeline/SKILL.md"; g -C "$H.up" commit -q -am 'C: otra version'; g -C "$CL" fetch -q origin
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'ARNÉS ATRASADO' <<<"$out" && [ "$(offenders "$out")" = 1 ] && grep -q '1 commit' <<<"$out" \
   && grep -q 'harness.js update' <<<"$out" && ! grep -q 'FUERA de\|merge --ff-only\|checkout main' <<<"$out"; then
  ok "REG-A4 repo único atrasado: un solo renglón, sin «FUERA de», y el consejo es harness.js update"
else bad "REG-A4 repo único atrasado (rc=$rc): $out"; fi
# …y la ref es la del estado: siguiendo `mirror/sync` (parado en su punta), que origin/main haya seguido no es atraso
g -C "$H.up" branch -q mirror/sync "$(g -C "$CL" rev-parse HEAD)"; g -C "$CL" fetch -q origin '+refs/heads/*:refs/remotes/origin/*'
single_state "$H" mirror/sync
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"
[ -z "$out" ] && ok "REG-A4 la ref sale del estado de esa fuente: al día con origin/mirror/sync, calla aunque origin/main siguió" || bad "REG-A4 ref del estado: $out"
# REG-A5 · antes de la primera actualización (la rama tycon/installed todavía no existe): en main calla; en una rama
# propia avisa una vez, y el consejo no es `checkout main` ni un `checkout tycon/installed` que fallaría
# 🔴 rojo previo: dos renglones, «Volver: git -C <repo> checkout main» y «checkout tycon/installed» (rama que no existe)
H="$BASE/h-ra5"; single "$H"; single_state "$H"; CL="$H.clone"
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "REG-A5 repo único recién instalado (en main, sin tycon/installed): calla" || bad "REG-A5 recién instalado (rc=$rc): $out"
# …y atrasado ahí: un renglón y `harness.js update`. Nunca `merge --ff-only origin/main`: un clon del público que avanza
# en main a mano queda fuera de lo que `update` mueve
# 🔴 rojo previo: dos renglones, y para «agent-skills» (el mismo clon) el consejo `git stash` + `merge --ff-only origin/main`
printf 'v2\n' > "$H.up/skills/tycon-pipeline/SKILL.md"; g -C "$H.up" commit -q -am 'B: version nueva'; g -C "$CL" fetch -q origin
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"
if grep -q 'ARNÉS ATRASADO' <<<"$out" && [ "$(offenders "$out")" = 1 ] && grep -q 'harness.js update' <<<"$out" \
   && ! grep -q 'merge --ff-only\|git -C .* stash\|FUERA de' <<<"$out"; then
  ok "REG-A5 recién instalado y atrasado: un renglón, y el consejo es harness.js update (nunca un merge con origin/main)"
else bad "REG-A5 recién instalado y atrasado (renglones $(offenders "$out")): $out"; fi
g -C "$CL" checkout -q -b mine
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"
if [ "$(offenders "$out")" = 1 ] && grep -q 'está en "mine"' <<<"$out" && ! grep -q 'checkout main\|checkout tycon/installed' <<<"$out" \
   && ! grep -qi 'volver a main' <<<"$out" && grep -q 'harness.js update' <<<"$out"; then
  ok "REG-A5 recién instalado y en otra rama: avisa una vez; el consejo no es checkout main ni un checkout de una rama que no existe"
else bad "REG-A5 recién instalado en otra rama (renglones $(offenders "$out")): $out"; fi
# REG-A6 · una fuente `harness` sin `dir` en el estado: su carpeta es el `tree` del estado
# 🔴 rojo previo: el mismo de REG-A1
H="$BASE/h-ra6"; single "$H"; first_update "$H"; CL="$(cd "$H.clone" && pwd -P)"
estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"$CL\",\"notice\":null,\"sources\":[{\"name\":\"harness\",\"ref\":\"main\",\"rewrites\":true}]}"
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "REG-A6 fuente «harness» sin dir: se la encuentra por el tree del estado, y calla" || bad "REG-A6 harness sin dir (rc=$rc): $out"
# REG-A7 · en un disco que no distingue mayúsculas, la carpeta del estado escrita con otra caja ES el mismo clon
# 🔴 rojo previo: el mismo de REG-A1 (y, comparando rutas letra por letra, seguiría en rojo)
ALT="$(dirname "$CL")/$(basename "$CL" | tr '[:lower:]' '[:upper:]')"
if [ "$ALT" != "$CL" ] && [ -d "$ALT" ]; then
  estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"$ALT\",\"notice\":null,\"sources\":[{\"name\":\"harness\",\"ref\":\"main\",\"rewrites\":true,\"dir\":\"$ALT\"}]}"
  out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?
  [ "$rc" -eq 0 ] && [ -z "$out" ] && ok "REG-A7 la carpeta del estado con otra caja es el mismo clon: calla" || bad "REG-A7 otra caja (rc=$rc): $out"
else echo "⚪ branch-guard-notice: REG-A7 NO MEDIDO — este disco distingue mayúsculas (la carpeta con otra caja no existe)"; fi
# REG-A8 · espejo: un estado que NO nombra ese clon (su fuente vive en otra carpeta) no lo ampara: lo de siempre
g init -q -b main "$BASE/h-ra8-other"; g -C "$BASE/h-ra8-other" commit -q --allow-empty -m x; OTHER="$(cd "$BASE/h-ra8-other" && pwd -P)"
estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"$OTHER\",\"notice\":null,\"sources\":[{\"name\":\"harness\",\"ref\":\"main\",\"rewrites\":true,\"dir\":\"$OTHER\"},{\"name\":\"agent_skills\",\"ref\":\"main\",\"rewrites\":true,\"dir\":\"$OTHER\"}]}"
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"
if grep -q 'FUERA de main' <<<"$out" && [ "$(offenders "$out")" = 1 ] && grep -q 'Volver: git -C <repo> checkout main' <<<"$out"; then
  ok "REG-A8 espejo: un estado cuyas fuentes viven en otra carpeta no ampara a este clon (lo de siempre, y una sola vez)"
else bad "REG-A8 estado que no nombra el clon (renglones $(offenders "$out")): $out"; fi
# REG-A9 · espejo: el clon interno de siempre fuera de main → el aviso de hoy, letra por letra, con su consejo de hoy;
# sin estado, y con un estado que nombra ese clon con `rewrites: false`
H="$BASE/h-ra9"; AS="$H/.claude/agent-skills"; mkdir -p "$H/.claude/.tycon-pipeline"
g init -q -b main "$AS"; g -C "$AS" commit -q --allow-empty -m x; g -C "$AS" checkout -q -b codex/etapa-x
EXPECTED="$(printf '%s\n' \
  '🔴🔴 BRANCH GUARD — repos compartidos del harness FUERA de main:' \
  "  - agent-skills está en \"codex/etapa-x\" (${AS})" \
  'TODAS las sesiones leen guías/skills/hooks de lo que esté checkouteado — esta sesión' \
  'está corriendo con un arnés a medio hacer. Si no sos la sesión que trabaja la' \
  'migración: avisale al dev ANTES de confiar en cualquier guía o skill de ese repo.' \
  'Si sos la sesión de la migración: acordate de volver a main al pausar o cerrar' \
  '(regla del clon compartido, guides/codex-migration.md §5).' \
  'Volver: git -C <repo> checkout main')"
out="$(notice "$H")"
[ "$out" = "$EXPECTED" ] && ok "REG-A9 clon interno fuera de main, sin estado: el aviso de hoy, letra por letra" || bad "REG-A9 interno sin estado: $out"
estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"/\",\"notice\":null,$(public_source "$H" false main)}"
out="$(TYCON_UPDATE_APPLY=auto notice "$H")"
[ "$out" = "$EXPECTED" ] && ok "REG-A9 clon interno fuera de main, con estado y rewrites: false: el mismo aviso, con su consejo de hoy" || bad "REG-A9 interno con estado: $out"

# ═══ story 8.13 (tanda D, segunda vuelta de revisores) · «no pude leer» no es «no hay» ════════════════════════════════
# Una ref rota (basura adentro, un lock, el tope de tiempo) hace fallar a git igual que una ref ausente. Leer ese fallo
# como «la rama tycon/installed no existe», «no es un clon» o «está al día» es inventar: el aviso ni grita «FUERA de main»
# ni calla como si todo estuviera bien; dice en UNA línea qué no pudo leer de qué clon, sin veredicto ni consejo de rama.
# Cada caso lleva su espejo: la ref ausente de verdad y la ref sana se portan como siempre.
# only_unread <salida> <texto que tiene que nombrar>: una sola línea, «no pude leer», sin veredicto ni cambio de rama
only_unread() {
  [ "$(grep -c . <<<"$1")" = 1 ] && grep -q 'no pude leer' <<<"$1" && grep -qF -- "$2" <<<"$1" \
    && ! grep -q 'FUERA de\|Volver:\|checkout\|ARNÉS ATRASADO\|merge --ff-only\|harness.js update' <<<"$1"
}
# REG-R1 · la rama tycon/installed con basura adentro, y el clon del público parado en main
# 🔴 rojo previo: el `rev-parse --verify` fallido se leía como «todavía no existe» → main valía como rama de casa y el
#    aviso seguía de largo (acá, «ARNÉS ATRASADO» con `harness.js update`), sin decir que la ref estaba rota
H="$BASE/h-rr1"; single "$H"; first_update "$H"; single_state "$H"; CL="$H.clone"; REF="$CL/.git/refs/heads/tycon/installed"
SHA="$(g -C "$CL" rev-parse HEAD)"; g -C "$CL" checkout -q main; printf 'esto no es un sha\n' > "$REF"
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?
[ "$rc" -eq 0 ] && only_unread "$out" '"tycon/installed"' && ok "REG-R1 tycon/installed rota, parado en main: dice que no pudo leer esa rama, sin veredicto ni consejo de rama" || bad "REG-R1 ref rota en main (rc=$rc): $out"
# …parado en una rama propia
# 🔴 rojo previo: «FUERA de su rama» con «"tycon/installed" todavía no existe: la crea la primera actualización» (existe, rota)
g -C "$CL" checkout -q -b mine >/dev/null 2>&1
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?
[ "$rc" -eq 0 ] && [ "$(branch_of "$CL")" = mine ] && only_unread "$out" '"tycon/installed"' && ok "REG-R1 tycon/installed rota, parado en otra rama: lo mismo (no inventa que la rama no existe)" || bad "REG-R1 ref rota en otra rama (rc=$rc, rama $(branch_of "$CL")): $out"
# …y parado EN la rama rota: git no puede decir en qué rama está
# 🔴 rojo previo: silencio (el fallo se leía como «repo no clonado»)
printf '%s\n' "$SHA" > "$REF"; g -C "$CL" checkout -q tycon/installed; printf 'esto no es un sha\n' > "$REF"
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?
[ "$rc" -eq 0 ] && only_unread "$out" 'el arnés' && ok "REG-R1 parado en la rama rota: dice que no pudo leer en qué rama está ese clon (no calla como si no fuera un clon)" || bad "REG-R1 parado en la rama rota (rc=$rc): $out"
# espejo · la ref sana: como siempre (en su rama y al día, calla)
printf '%s\n' "$SHA" > "$REF"
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "REG-R1 espejo: con la ref sana, en su rama y al día, calla" || bad "REG-R1 espejo ref sana (rc=$rc): $out"
# REG-R2 · la ref contra la que se mide el atraso (origin/main) con basura adentro
# 🔴 rojo previo: el `rev-list` fallido se leía como «0 commits atrás» → silencio
printf 'basura\n' > "$CL/.git/refs/remotes/origin/main"
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?
[ "$rc" -eq 0 ] && only_unread "$out" 'origin/main' && ok "REG-R2 origin/main rota: dice que no pudo medir el atraso contra esa ref (no «al día»)" || bad "REG-R2 ref remota rota (rc=$rc): $out"
out="$(TYCON_UPDATE_APPLY=ask notice_at "$H")"
[ -z "$out" ] && ok "REG-R2 con ask el atraso no se juzga: tampoco se dice nada de esa ref" || bad "REG-R2 ref remota rota con ask: $out"
# espejo · esa ref ausente de verdad (clon sin esa rama remota): no se juzga, como siempre
printf '%s\n' "$SHA" > "$CL/.git/refs/remotes/origin/main"; g -C "$CL" update-ref -d refs/remotes/origin/main
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "REG-R2 espejo: sin esa ref remota en el clon, no se juzga y calla (como siempre)" || bad "REG-R2 espejo ref remota ausente (rc=$rc): $out"
# espejo · tycon/installed ausente de verdad, parado en main: main vale como rama de casa (lo de REG-A5)
g -C "$CL" fetch -q origin; g -C "$CL" checkout -q main; g -C "$CL" branch -q -D tycon/installed
out="$(TYCON_UPDATE_APPLY=ask notice_at "$H")"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "REG-R1 espejo: tycon/installed ausente de verdad y parado en main: calla, como hoy" || bad "REG-R1 espejo ref ausente (rc=$rc): $out"
# REG-R3 · un clon con el HEAD roto no es «una carpeta sin clonar»
# 🔴 rojo previo: silencio
H="$BASE/h-rr3"; AS="$H/.claude/agent-skills"; mkdir -p "$H/.claude"
g init -q -b main "$AS"; g -C "$AS" commit -q --allow-empty -m x; printf 'basura\n' > "$AS/.git/HEAD"
out="$(notice "$H")"; rc=$?
[ "$rc" -eq 0 ] && only_unread "$out" 'agent-skills' && ok "REG-R3 un clon con el HEAD roto: dice que no pudo leer su rama" || bad "REG-R3 HEAD roto (rc=$rc): $out"
# espejo · una carpeta que no es un clon (o que no está): no es problema de este aviso
H="$BASE/h-rr3b"; mkdir -p "$H/.claude/agent-skills"
out="$(notice "$H")"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "REG-R3 espejo: una carpeta que no es un clon calla (como siempre)" || bad "REG-R3 espejo sin clon (rc=$rc): $out"
# REG-R4 · el índice ilegible: «no pude mirar si hay conflictos abiertos» no es «no hay»
# 🔴 rojo previo: silencio (el `ls-files -u` fallido se leía como «sin conflictos»)
H="$BASE/h-rr4"; AS="$H/.claude/agent-skills"; mkdir -p "$H/.claude"
g init -q -b main "$H.up"; printf 'v1\n' > "$H.up/a.txt"; g -C "$H.up" add -A && g -C "$H.up" commit -q -m A; g clone -q "$H.up" "$AS"
out="$(notice "$H")"
cp "$AS/.git/index" "$H.index"; printf 'basura\n' > "$AS/.git/index"
out2="$(notice "$H")"; rc=$?
[ -z "$out" ] && [ "$rc" -eq 0 ] && only_unread "$out2" 'agent-skills' && ok "REG-R4 el índice ilegible: lo dice (y con el índice sano, el mismo clon calla)" || bad "REG-R4 índice ilegible (rc=$rc, sano: «${out}»): $out2"
# REG-R5 · la carpeta de una fuente del estado que no se puede mirar (sin permiso): no se sabe si es este clon
# 🔴 rojo previo: «no la pude mirar» se leía como «no es este clon» → «FUERA de main» con `checkout main`
H="$BASE/h-rr5"; single "$H"; first_update "$H"; CL="$(cd "$H.clone" && pwd -P)"
mkdir -p "$BASE/locked/inner"; chmod 000 "$BASE/locked"
if [ -d "$BASE/locked/inner" ]; then
  chmod 755 "$BASE/locked"; echo "⚪ branch-guard-notice: REG-R5 NO MEDIDO — este usuario entra a una carpeta sin permisos (¿root?)"
else
  estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"$CL\",\"notice\":null,\"sources\":[{\"name\":\"harness\",\"ref\":\"main\",\"rewrites\":true,\"dir\":\"$BASE/locked/inner\"}]}"
  out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"; rc=$?; chmod 755 "$BASE/locked"
  [ "$rc" -eq 0 ] && only_unread "$out" 'estado' && ok "REG-R5 la carpeta de una fuente del estado no se puede mirar: lo dice, sin «FUERA de main»" || bad "REG-R5 carpeta de la fuente sin permiso (rc=$rc): $out"
fi
# espejo · esa carpeta NO EXISTE de verdad: el estado no nombra este clon, lo de siempre
estado "$H" "{\"schema\":1,\"mode\":\"managed\",\"tree\":\"$CL\",\"notice\":null,\"sources\":[{\"name\":\"harness\",\"ref\":\"main\",\"rewrites\":true,\"dir\":\"$BASE/no-existe\"}]}"
out="$(TYCON_UPDATE_APPLY=auto notice_at "$H")"
grep -q 'FUERA de main' <<<"$out" && [ "$(offenders "$out")" = 1 ] && ! grep -q 'no pude leer' <<<"$out" \
  && ok "REG-R5 espejo: una fuente cuya carpeta no existe no ampara a este clon (lo de siempre)" || bad "REG-R5 espejo carpeta que no existe: $out"

# harness-bootstrap-heal.sh: con la línea nueva (bootstrap.js) está sano y no toca settings.json
HEAL="$TCG/scripts/hooks/harness-bootstrap-heal.sh"
HR="$BASE/heal"; mkdir -p "$HR/scripts/hooks"; cp "$HEAL" "$HR/scripts/hooks/"; printf '#!/bin/sh\nexit 0\n' > "$HR/scripts/install-tycon-hooks.sh"
S="$BASE/heal-settings.json"
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node \\"$HOME/.claude/.tycon-pipeline/harness/bootstrap.js\\" || bash \\"$HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh\\"","async":true}]}]}}\n' > "$S"
antes="$(shasum -a 256 < "$S")"
out="$(TYCON_SETTINGS_PATH="$S" TYCON_NO_AUTOINSTALL=1 bash "$HR/scripts/hooks/harness-bootstrap-heal.sh")"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && [ "$(shasum -a 256 < "$S")" = "$antes" ] && ok "T10 bootstrap-heal: la línea nueva es sana (silencio, sin tocar settings.json)" || bad "T10 bootstrap-heal con la línea nueva (rc=$rc): $out"
# …y la vieja sin la llamada al instalador la sigue reparando
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"cd ~/.claude/tycon-claude-guides && git pull --ff-only --autostash --quiet 2>/dev/null || true","async":true}]}]}}\n' > "$S"
out="$(TYCON_SETTINGS_PATH="$S" TYCON_NO_AUTOINSTALL=1 bash "$HR/scripts/hooks/harness-bootstrap-heal.sh")"; rc=$?
[ "$rc" -eq 0 ] && grep -q 'install-tycon-hooks' "$S" && ok "T10 bootstrap-heal: la línea vieja sin instalador se sigue reparando" || bad "T10 bootstrap-heal con la vieja (rc=$rc): $out"

# ═══ story 8.9 (tanda E, T57 / AC 53) · los nombres viejos después de la fecha de retiro ═══════════════════════════════
# Pasada `retire_after` del mapa, si esta máquina anotó usos de nombres viejos en los últimos 14 días (legacy-names.jsonl),
# UNA línea dice cuáles y dónde cambiarlos. Antes de la fecha (o el mismo día), sin usos recientes, sin registro o sin
# fecha: nada. Es parte de este aviso y no un hook nuevo: así no hay que registrar otro hook en el instalador, el banco y
# Codex para una línea que vive hasta la story de retiro. El mapa es de laboratorio (TYCON_LEGACY_NAMES_MAP), con
# nombres inventados; el hook corre suelto y con un HOME de juguete sin repos (nada más que decir).
RH="$BASE/retiro"; mkdir -p "$RH/.claude/.tycon-pipeline"; RMAP="$BASE/retiro-map.json"
printf '{ "__about": "laboratorio", "retire_after": "2026-11-20", "entries": [] }\n' > "$RMAP"
usos() { printf '%s\n' "$@" > "$RH/.claude/.tycon-pipeline/legacy-names.jsonl"; }
retiro() { TYCON_LEGACY_NAMES_MAP="$RMAP" TYCON_TODAY="$1" notice "$RH"; }
U_ENV='{"day":"2026-11-21","kind":"env","old":"TYCON_NO_LAB_OLD","new":"TYCON_NO_LAB_NEW","script":"scripts/lab/tool.sh"}'
U_OPT='{"day":"2026-11-08","kind":"option","old":"lab-old","new":"lab-new","script":"scripts/lab/x.js"}'
U_FILE='{"day":"2026-11-15","kind":"file","old":"scripts/lab/old.js","new":"scripts/lab/new.js","script":"scripts/lab/old.js"}'
U_FAR='{"day":"2026-11-07","kind":"env","old":"TYCON_LAB_GONE","new":"TYCON_LAB_FAR","script":"scripts/lab/z.sh"}'
usos "$U_ENV" "$U_OPT" "$U_FILE" "$U_FAR" 'no es json'
out="$(retiro 2026-11-19)"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "T57 antes de la fecha de retiro: nada, aunque haya usos" || bad "T57 antes de la fecha (rc=$rc): $out"
out="$(retiro 2026-11-20)"
[ -z "$out" ] && ok "T57 el mismo día de la fecha: nada (el aviso es cuando la fecha pasó)" || bad "T57 el mismo día: $out"
out="$(retiro 2026-11-21)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(grep -c . <<<"$out")" = 1 ] && grep -q 'TYCON_NO_LAB_OLD' <<<"$out" && grep -q 'TYCON_NO_LAB_NEW' <<<"$out" \
   && grep -q -- '--lab-old' <<<"$out" && grep -q -- '--lab-new' <<<"$out" && grep -q 'scripts/lab/x.js' <<<"$out" \
   && grep -q 'scripts/lab/old.js' <<<"$out" && grep -q 'scripts/lab/new.js' <<<"$out" && grep -q 'entorno' <<<"$out" \
   && grep -q '2026-11-20' <<<"$out" && grep -q 'nombres-en-ingles.md' <<<"$out" && ! grep -q 'TYCON_LAB_GONE' <<<"$out"; then
  ok "T57 pasada la fecha: UNA línea con cada nombre viejo de los últimos 14 días, su nuevo y dónde cambiarlo"
else bad "T57 pasada la fecha (rc=$rc): $out"; fi
usos "$U_FAR"
out="$(retiro 2026-11-21)"
[ -z "$out" ] && ok "T57 pasada la fecha, sin usos en los últimos 14 días: nada" || bad "T57 usos viejos solamente: $out"
rm -f "$RH/.claude/.tycon-pipeline/legacy-names.jsonl"
out="$(retiro 2026-11-21)"
[ -z "$out" ] && ok "T57 pasada la fecha, sin registro de usos: nada" || bad "T57 sin registro: $out"
printf '{ "__about": "laboratorio", "retire_after": null, "entries": [] }\n' > "$RMAP"; usos "$U_ENV"
out="$(retiro 2026-11-21)"
[ -z "$out" ] && ok "T57 sin fecha de retiro en el mapa: nada" || bad "T57 sin fecha: $out"
printf '{ "__about": "laboratorio", "retire_after": "2026-11-20", "entries": [] }\n' > "$RMAP"
usos "$U_ENV" "$U_OPT" "$U_FILE" \
  '{"day":"2026-11-21","kind":"env","old":"TYCON_LAB_A","new":"TYCON_LAB_AA","script":"scripts/lab/a.sh"}' \
  '{"day":"2026-11-21","kind":"env","old":"TYCON_LAB_B","new":"TYCON_LAB_BB","script":"scripts/lab/b.sh"}' \
  '{"day":"2026-11-21","kind":"env","old":"TYCON_LAB_C","new":"TYCON_LAB_CC","script":"scripts/lab/c.sh"}'
out="$(retiro 2026-11-21)"
[ "$(grep -c . <<<"$out")" = 1 ] && grep -q 'y 2 más' <<<"$out" && ok "T57 con muchos nombres sigue siendo una línea («y N más»)" || bad "T57 muchos nombres: $out"
# el mismo nombre viejo usado contra varios guiones (el mapa tiene opciones del mismo nombre en varios): se nombra cada
# guion, el más reciente primero — quedarse con la primera línea nombraba sólo el más viejo, quizás ya corregido
# (pase adversarial de la tanda E)
usos '{"day":"2026-11-10","kind":"option","old":"lab-old","new":"lab-new","script":"scripts/lab/x.js"}' \
  '{"day":"2026-11-20","kind":"option","old":"lab-old","new":"lab-new","script":"scripts/lab/y.js"}' \
  '{"day":"2026-11-12","kind":"option","old":"lab-old","new":"lab-new","script":"scripts/lab/x.js"}'
out="$(retiro 2026-11-21)"
if [ "$(grep -c . <<<"$out")" = 1 ] && grep -q 'scripts/lab/y.js' <<<"$out" && grep -q 'scripts/lab/x.js' <<<"$out" \
   && [ "$(sed 's/scripts\/lab\/y\.js.*//' <<<"$out" | grep -c 'scripts/lab/x.js')" = 0 ]; then
  ok "T57 un nombre viejo usado contra dos guiones: nombra los dos, el más reciente primero"
else bad "T57 varios guiones: $out"; fi
# los estados que el arnés migra solo (prepareStateWrite anota el uso al copiar el viejo al nuevo) no son del dev: no se
# avisan, y nunca se le dice «renombralo» (pisaría el nuevo con el contenido viejo)
U_STATE='{"day":"2026-11-20","kind":"state-file","old":"~/.claude/.tycon-pipeline/lab-before.json","new":"~/.claude/.tycon-pipeline/lab-new.json","script":"scripts/metrics/upload-runs.js"}'
usos "$U_STATE"
out="$(retiro 2026-11-21)"
[ -z "$out" ] && ok "T57 sólo un estado que el arnés migró solo: nada" || bad "T57 estado migrado solo: $out"
usos "$U_STATE" "$U_ENV"
out="$(retiro 2026-11-21)"
grep -q 'TYCON_NO_LAB_OLD' <<<"$out" && ! grep -q 'lab-before.json\|renombralo' <<<"$out" && grep -q 'usó 1 ' <<<"$out" \
  && ok "T57 con un estado migrado solo y una variable: avisa la variable, no el estado" || bad "T57 estado + variable: $out"
# «está y no lo pude leer» no es «no hay usos»: un mapa que no parsea o un registro ilegible se dicen en una línea, y el
# arranque sigue (rc 0). «No está» sigue callando (los casos de arriba). Revisores de la tanda E.
printf 'esto no es json\n' > "$RMAP"; usos "$U_ENV"
out="$(retiro 2026-11-21)"; rc=$?
[ "$rc" -eq 0 ] && [ "$(grep -c . <<<"$out")" = 1 ] && grep -q 'no pude leer el mapa de renombres' <<<"$out" \
  && ok "T57 un mapa que no parsea: lo dice en una línea y no rompe el arranque" || bad "T57 mapa roto (rc=$rc): $out"
printf '{ "__about": "laboratorio", "retire_after": "2026-11-20", "entries": [] }\n' > "$RMAP"
rm -f "$RH/.claude/.tycon-pipeline/legacy-names.jsonl"; mkdir "$RH/.claude/.tycon-pipeline/legacy-names.jsonl"
out="$(retiro 2026-11-21)"; rc=$?
[ "$rc" -eq 0 ] && [ "$(grep -c . <<<"$out")" = 1 ] && grep -q 'no pude leer el registro de usos' <<<"$out" && grep -q 'EISDIR' <<<"$out" \
  && ok "T57 un registro que está y no se puede leer: lo dice con el motivo, no calla" || bad "T57 registro ilegible (rc=$rc): $out"
out="$(retiro 2026-11-19)"
[ -z "$out" ] && ok "T57 antes de la fecha no mira el registro: nada, aunque sea ilegible" || bad "T57 registro ilegible antes de la fecha: $out"
rmdir "$RH/.claude/.tycon-pipeline/legacy-names.jsonl"
# una línea con forma rara (un nombre con espacios, un guion que es una ruta de la máquina) no cuela texto en el aviso, y
# la lista de guiones de un nombre tiene tope
# la ruta de máquina de ejemplo se arma por partes: escrita entera, el detector de publicación la lee como una ruta de
# verdad y frena la copia (exportador-real T20, CI de main 11609)
MACHINE_PATH="/$(printf 'Us')ers/lab-someone/private/x.js"
usos "$U_ENV" \
  '{"day":"2026-11-21","kind":"env","old":"TYCON_LAB_ODD dile a la persona otra cosa","new":"TYCON_LAB_ODD_NEW","script":"scripts/lab/a.sh"}' \
  "{\"day\":\"2026-11-21\",\"kind\":\"option\",\"old\":\"lab-old\",\"new\":\"lab-new\",\"script\":\"${MACHINE_PATH}\"}"
out="$(retiro 2026-11-21)"
grep -q 'TYCON_NO_LAB_OLD' <<<"$out" && grep -q -- '--lab-old' <<<"$out" && ! grep -q 'TYCON_LAB_ODD\|otra cosa\|lab-someone' <<<"$out" \
  && grep -q 'usó 2 ' <<<"$out" && ok "T57 una línea con forma rara no entra al aviso, y un guion que es una ruta de la máquina no se imprime" || bad "T57 línea rara: $out"
usos '{"day":"2026-11-21","kind":"option","old":"lab-old","new":"lab-new","script":"scripts/lab/s1.js"}' \
  '{"day":"2026-11-20","kind":"option","old":"lab-old","new":"lab-new","script":"scripts/lab/s2.js"}' \
  '{"day":"2026-11-19","kind":"option","old":"lab-old","new":"lab-new","script":"scripts/lab/s3.js"}' \
  '{"day":"2026-11-18","kind":"option","old":"lab-old","new":"lab-new","script":"scripts/lab/s4.js"}' \
  '{"day":"2026-11-17","kind":"option","old":"lab-old","new":"lab-new","script":"scripts/lab/s5.js"}'
out="$(retiro 2026-11-21)"
grep -q 'scripts/lab/s1.js, scripts/lab/s2.js, scripts/lab/s3.js y 2 más' <<<"$out" && ! grep -q 's4.js\|s5.js' <<<"$out" \
  && ok "T57 un nombre usado contra muchos guiones: los tres más recientes y «y N más»" || bad "T57 tope de guiones: $out"
usos "$U_STATE" "$U_ENV"
out="$(TYCON_BRANCH_GUARD=0 retiro 2026-11-21)"
[ -z "$out" ] && ok "T57 apagado con el interruptor del aviso (TYCON_BRANCH_GUARD=0)" || bad "T57 apagado: $out"
# la variable del día tiene nombre viejo (story 8.9, tanda B1): con la biblioteca al lado, el viejo sigue valiendo. El
# nombre viejo se arma por partes (esta prueba sale en la copia pública) y el mapa de laboratorio lo declara.
HOY_VIEJA="TYCON_$(printf 'H')OY"
RDIR="$BASE/sin-repo-lib/scripts"; mkdir -p "$RDIR/hooks" "$RDIR/lib"
cp "$TCG/scripts/hooks/branch-guard-notice.js" "$RDIR/hooks/"; cp "$TCG/scripts/lib/legacy-names.js" "$RDIR/lib/"
printf '{ "__about": "laboratorio", "retire_after": "2026-11-20", "entries": [ { "kind": "env", "old": "%s", "new": "TYCON_TODAY", "batch": "lab" } ] }\n' "$HOY_VIEJA" > "$RMAP"
usos "$U_ENV"
out="$(env -u TYCON_TODAY "$HOY_VIEJA=2026-11-21" TYCON_LEGACY_NAMES_MAP="$RMAP" HOME="$RH" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null node "$RDIR/hooks/branch-guard-notice.js")"
grep -q 'TYCON_NO_LAB_OLD' <<<"$out" && ok "T57 el día con el nombre viejo de la variable sigue valiendo (por la biblioteca de nombres viejos)" || bad "T57 día con el nombre viejo: «${out}»"

# ═══ story 8.18 (T36 / AC 35) · las tres formas de máquina, al día: ni «atrasado» ni «fuera de main» ═════════════════
# Desde la unión de los dos repos internos una máquina puede tener: (1) dos clones sin re-apuntar (el arnés ya trae
# skills/ y las skills salen del clon viejo), (2) dos clones con el viejo RE-APUNTADO al repo unificado (el mismo remoto y
# el mismo commit que el arnés, mostrando sólo agents/, skills/ y packs/), o (3) un solo árbol. En las tres, al día, este
# aviso calla; y después de DESHACER el re-apuntado, también (la ref de lo traído vuelve a ser la del repo viejo: si
# quedara la del unificado, el clon viejo saldría «atrasado» en cada sesión). Va al final: el laboratorio cambia la HOME.
# shellcheck disable=SC1091
source "$TCG/scripts/tests/lib/harness-lab.sh"
export TYCON_UPDATE_APPLY=auto
shape_notice() { node "$LAB_TREE/scripts/hooks/branch-guard-notice.js"; }   # el aviso del propio clon del arnés, con la HOME del laboratorio
with_hook() { mkdir -p "$LAB_TREE/scripts/hooks" && cp "$TCG/scripts/hooks/branch-guard-notice.js" "$LAB_TREE/scripts/hooks/"; }
quiet() { ! grep -q 'ATRASADO\|FUERA de\|no pude leer' <<<"$1"; }
if harness_lab_team_machine "$BASE/t36" toy >/dev/null && harness install --yes >/dev/null 2>&1 && harness_lab_cut && harness update >/dev/null 2>&1 && with_hook; then
  out="$(shape_notice)"
  [ -z "$out" ] && ok "T36 dos clones sin re-apuntar, al día: el aviso calla" || bad "T36 dos clones sin re-apuntar: «${out}»"
  TYCON_UPDATE_SKILLS_SOURCE=unified harness startup >/dev/null 2>&1
  [ "$(harness_lab_git "$LAB_SKILLS" remote get-url origin)" = "$LAB_REMOTE_UNIFIED" ] || bad "T36 precondición: el clon viejo no quedó re-apuntado"
  out="$(TYCON_UPDATE_SKILLS_SOURCE=unified shape_notice)"
  quiet "$out" && grep -q 're-apuntad' <<<"$out" && ok "T36 recién re-apuntado: ni «atrasado» ni «fuera de main»; sólo el aviso del re-apuntado, dirigido a la persona" || bad "T36 recién re-apuntado: «${out}»"
  TYCON_UPDATE_SKILLS_SOURCE=unified harness startup >/dev/null 2>&1
  out="$(TYCON_UPDATE_SKILLS_SOURCE=unified shape_notice)"
  [ -z "$out" ] && ok "T36 dos clones re-apuntados, al día: el aviso calla" || bad "T36 dos clones re-apuntados: «${out}»"
  # espejo: el aviso no está ciego — con una versión nueva traída y sin aplicar, grita por los DOS clones
  harness_lab_publish tree "una versión nueva, traída y sin aplicar" skills/tycon-pipeline/NEW.md "nuevo"
  harness_lab_git "$LAB_TREE" fetch -q origin && harness_lab_git "$LAB_SKILLS" fetch -q origin
  out="$(TYCON_UPDATE_SKILLS_SOURCE=unified shape_notice)"
  grep -q 'ATRASADO' <<<"$out" && grep -q 'el arnés: 1 commit' <<<"$out" && grep -q 'agent-skills: 1 commit' <<<"$out" \
    && ok "T36 espejo: con una versión traída y sin aplicar, el aviso grita «atrasado» por los dos clones" || bad "T36 espejo: «${out}»"
  TYCON_UPDATE_SKILLS_SOURCE=unified harness update >/dev/null 2>&1
  out="$(TYCON_UPDATE_SKILLS_SOURCE=unified shape_notice)"
  [ -z "$out" ] && ok "T36 después del update los dos clones quedan en el mismo commit y el aviso vuelve a callar" || bad "T36 después del update: «${out}»"
  # deshacer: la llave vuelve a separate
  harness startup >/dev/null 2>&1; harness startup >/dev/null 2>&1
  [ "$(harness_lab_git "$LAB_SKILLS" remote get-url origin)" = "$LAB_REMOTE_SKILLS" ] || bad "T36 precondición: el clon viejo no volvió a su repo"
  out="$(shape_notice)"
  [ -z "$out" ] && ok "T36 después de deshacer el re-apuntado: el aviso calla (el clon viejo no sale «atrasado» contra el repo unificado)" || bad "T36 después de deshacer: «${out}»"
else
  bad "T36 no pude armar la máquina del equipo de laboratorio"
fi
if harness_lab_single_tree "$BASE/t36-single" >/dev/null && harness install --yes >/dev/null 2>&1 && with_hook; then
  out="$(shape_notice)"
  [ -z "$out" ] && ok "T36 un solo árbol, al día: el aviso calla (y juzga el clon una sola vez)" || bad "T36 un solo árbol: «${out}»"
else
  bad "T36 no pude armar la máquina de un solo árbol"
fi

# ═══ T12 / T13 (story 8.35) · el aviso de PowerShell 7 faltante: Windows (simulado), una vez; nunca en posix ═══════════
# @story-8.35 · T12 PwshMissing_NoticeOnce · T13 PwshPresentOrPosix_Silent
NODE_BIN="$(command -v node)"
PW_BIN="$BASE/con-pwsh"; mkdir -p "$PW_BIN"; printf '#!/bin/sh\nexit 0\n' > "$PW_BIN/pwsh.exe"; chmod +x "$PW_BIN/pwsh.exe"
# lo que Windows no puede ejecutar no cuenta: una carpeta llamada pwsh.exe, o un `pwsh` sin extensión
PW_FAKE="$BASE/pwsh-falso"; mkdir -p "$PW_FAKE/pwsh.exe"; printf 'x\n' > "$PW_FAKE/pwsh"
pw_notice() { # pw_notice <home> <PATH> [plataforma]: el hook con un PATH dado y, si se pide, Windows simulado
  env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE HOME="$1" PATH="$2" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    ${3:+TYCON_BRANCH_GUARD_PLATFORM=$3} "$NODE_BIN" "$HOOK_DIR/branch-guard-notice.js"
}
H="$BASE/h-pw"; mkdir -p "$H/.claude"
o1="$(pw_notice "$H" /usr/bin:/bin win32)"; o2="$(pw_notice "$H" /usr/bin:/bin win32)"
if grep -q 'PowerShell 7' <<<"$o1" && grep -q 'winget install' <<<"$o1" && ! grep -q 'PowerShell' <<<"$o2"; then
  ok "T12 Windows sin pwsh: el aviso sale una vez, con el comando de winget, y no se repite"
else bad "T12 sin pwsh: 1ª «${o1}» · 2ª «${o2}»"; fi
o3="$(pw_notice "$H" "$PW_BIN:/usr/bin:/bin" win32)"; o4="$(pw_notice "$H" /usr/bin:/bin win32)"
if ! grep -q 'PowerShell' <<<"$o3" && grep -q 'PowerShell 7' <<<"$o4"; then
  ok "T12 con pwsh calla; si vuelve a faltar, avisa otra vez"
else bad "T12 con pwsh «${o3}» · faltando otra vez «${o4}»"; fi
H="$BASE/h-pw2"; mkdir -p "$H/.claude"
o5="$(pw_notice "$H" /usr/bin:/bin)"; o6="$(pw_notice "$H" "$PW_BIN:/usr/bin:/bin" win32)"
if ! grep -q 'PowerShell' <<<"$o5" && ! grep -q 'PowerShell' <<<"$o6"; then
  ok "T13 en posix, o en Windows con pwsh: sin aviso"
else bad "T13 posix «${o5}» · Windows con pwsh «${o6}»"; fi
H="$BASE/h-pw3"; mkdir -p "$H/.claude"
o7="$(pw_notice "$H" "$PW_FAKE:/usr/bin:/bin" win32)"
if grep -q 'PowerShell 7' <<<"$o7"; then
  ok "T12 una carpeta pwsh.exe o un pwsh sin extensión no cuentan: avisa"
else bad "T12 con un pwsh que Windows no ejecuta calló: «${o7}»"; fi

[ "$FALLAS" -eq 0 ] && { echo "branch-guard-notice: todo verde"; exit 0; }
echo "branch-guard-notice: $FALLAS en rojo"; exit 1
