#!/usr/bin/env bash
# profile-equivalence.test.sh — T15 Equivalence_SettingsMode_TwoFiles (story 8.13, AC 14): el modo
# `profile-equivalence.js --settings <antes.json> <despues.json>` compara dos settings.json por los hooks DEL ARNÉS
# (evento → matcher → nombre del script → comando entero + async), aparte del `--base`.
#
# Lo que sostiene: (1) iguales por hooks → 0; (2) un hook con otro comando → 1 y la lista lo nombra (evento + nombre);
# (3) uno de más → 1; (4) hooks ajenos en otro orden y uno ajeno de más → 0 (lo ajeno y su orden no cuentan); (5) la
# línea de arranque distinta (la vieja de `git pull` contra la nueva de `bootstrap.js`) → 0 y la salida la nombra como
# `startup-line` (se informa, no decide); (6) uno de menos → 1; (7) un archivo ilegible o ausente → 2 (un listado que
# no se pudo leer no es «no hay diferencias»).
#
# 🔴 rojo previo verificado: sin el modo, el script pide `--base` y sale 2 en todos los casos.
# 🔴 Nada acá toca ~/.claude: HOME es de juguete y los settings viven en el temporal. Nombres de laboratorio (Dev-lab, con mayúscula: el detector de publicación toma una carpeta personal en minúscula por una ruta de máquina).
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$RAIZ/scripts/publishing/profile-equivalence.js"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
HOME="$T/casa"; mkdir -p "$HOME/.claude"; export HOME
export TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GUI_ENV=1
correr() { node "$SCRIPT" --settings "$1" "$2" > "$T/salida.txt" 2>&1; echo $?; }

# Un settings.json de laboratorio: hooks del arnés por las tres formas (clon en SourceCode, agent-skills, el enlace),
# hooks ajenos, y la línea de arranque. $1 = archivo · $2 = comando de la línea de arranque · $3 = extra JSON para
# PostToolUse (vacío o una entrada más) · $4 = comando del hook de retro (para cambiarle el valor)
LINEA_VIEJA='cd ~/SourceCode/tycon-claude-guides && git pull --ff-only --autostash --quiet 2>/dev/null || true; cd ~/.claude/agent-skills && git pull --ff-only --quiet --autostash 2>/dev/null || true; bash ~/SourceCode/tycon-claude-guides/scripts/install-tycon-hooks.sh 2>/dev/null || true'
LINEA_NUEVA='node "$HOME/.claude/.tycon-pipeline/harness/bootstrap.js" || bash "$HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh"'
RETRO='node "/home/Dev-lab/SourceCode/tycon-claude-guides/scripts/hooks/retro-pending.js"'
escribir() {
  local archivo="$1" linea="$2" extra="$3" retro="${4:-$RETRO}"
  cat > "$archivo" <<EOF
{
  "cleanupPeriodDays": 365,
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "$(printf '%s' "$linea" | sed 's/\\/\\\\/g; s/"/\\"/g')", "async": true } ] },
      { "hooks": [ { "type": "command", "command": "node \"/home/Dev-lab/SourceCode/tycon-claude-guides/scripts/hooks/branch-guard-notice.js\"" } ] },
      { "hooks": [ { "type": "command", "command": "p=\"\$HOME/notas/diario.py\"; [ -f \"\$p\" ] && python3 \"\$p\" --hook; true" } ] },
      { "hooks": [ { "type": "command", "command": "bash \"\$HOME/.claude/tycon-claude-guides/scripts/hooks/codegraph-session-hook.sh\"", "async": true } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node \"/home/Dev-lab/.claude/agent-skills/skills/tycon-pipeline/scripts/on-pre-commit.js\"" } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "bash \"/home/Dev-lab/SourceCode/tycon-claude-guides/scripts/hooks/safety-guard-pre.sh\"" } ] },
      { "matcher": "Edit|Write", "hooks": [ { "type": "command", "command": "node \"/home/Dev-lab/.claude/agent-skills/skills/tycon-pipeline/scripts/hook-pre-edit.js\"" } ] }
    ],
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "$(printf '%s' "$retro" | sed 's/"/\\"/g')" } ] },
      { "matcher": "Edit|Write", "hooks": [ { "type": "command", "command": "node \"/home/Dev-lab/SourceCode/tycon-claude-guides/scripts/hooks/rebuild-before-verify.js\"" } ] },
      { "hooks": [ { "type": "command", "command": "node \"/home/Dev-lab/.claude/agent-skills/skills/clocki/scripts/touch-activity.js\"", "async": true } ] }$extra
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node \"/home/Dev-lab/SourceCode/tycon-claude-guides/scripts/hooks/response-style-meter.js\"" } ] },
      { "hooks": [ { "type": "command", "command": "python3 \"/home/Dev-lab/notas/cierre.py\"" } ] }
    ]
  }
}
EOF
}

# 1) iguales por hooks → 0
escribir "$T/a1.json" "$LINEA_VIEJA" ""
escribir "$T/b1.json" "$LINEA_VIEJA" ""
rc=$(correr "$T/a1.json" "$T/b1.json")
[ "$rc" = "0" ] && ok "T15 dos settings iguales por hooks del arnés → 0" \
  || mal "T15 dos settings iguales → esperaba 0, salió $rc: $(cat "$T/salida.txt")"

# 2) un hook con otro valor (el mismo retro-pending.js, con otro comando) → 1 y la lista lo nombra
escribir "$T/a2.json" "$LINEA_VIEJA" ""
escribir "$T/b2.json" "$LINEA_VIEJA" "" 'node "/home/Dev-lab/SourceCode/tycon-claude-guides/scripts/hooks/retro-pending.js" --quiet'
rc=$(correr "$T/a2.json" "$T/b2.json")
if [ "$rc" = "1" ] && grep -q "PostToolUse" "$T/salida.txt" && grep -q "retro-pending.js" "$T/salida.txt"; then
  ok "T15 un hook con otro comando → 1 y la lista nombra evento y hook"
else
  mal "T15 un hook con otro comando → esperaba 1 con PostToolUse · retro-pending.js, salió $rc: $(cat "$T/salida.txt")"
fi
#    …y el mismo nombre con otro `async` también es otro valor
python3 - "$T/a2.json" "$T/b2b.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['hooks']['PostToolUse'][0]['hooks'][0]['async'] = True
json.dump(d, open(sys.argv[2], 'w'), indent=2)
PY
rc=$(correr "$T/a2.json" "$T/b2b.json")
[ "$rc" = "1" ] && grep -q "retro-pending.js" "$T/salida.txt" && grep -qi "async" "$T/salida.txt" \
  && ok "T15 el mismo hook con otro async → 1 y lo dice" \
  || mal "T15 el mismo hook con otro async → esperaba 1 nombrando async, salió $rc: $(cat "$T/salida.txt")"

# 3) uno de más en «después» → 1
escribir "$T/a3.json" "$LINEA_VIEJA" ""
escribir "$T/b3.json" "$LINEA_VIEJA" ',
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node \"/home/Dev-lab/SourceCode/tycon-claude-guides/scripts/hooks/missing-path-notice.js\"" } ] }'
rc=$(correr "$T/a3.json" "$T/b3.json")
[ "$rc" = "1" ] && grep -q "missing-path-notice.js" "$T/salida.txt" \
  && ok "T15 un hook del arnés de más → 1 y lo nombra" \
  || mal "T15 un hook de más → esperaba 1 nombrando missing-path-notice.js, salió $rc: $(cat "$T/salida.txt")"

# 6) uno de menos en «después» → 1 (la lista simétrica)
rc=$(correr "$T/b3.json" "$T/a3.json")
[ "$rc" = "1" ] && grep -q "missing-path-notice.js" "$T/salida.txt" \
  && ok "T15 un hook del arnés de menos → 1 y lo nombra" \
  || mal "T15 un hook de menos → esperaba 1, salió $rc: $(cat "$T/salida.txt")"

# 4) hooks ajenos en otro orden, y uno ajeno de más → 0 (lo ajeno y su orden no cuentan)
escribir "$T/a4.json" "$LINEA_VIEJA" ""
python3 - "$T/a4.json" "$T/b4.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
ss = d['hooks']['SessionStart']
ss.reverse()                                   # otro orden (también mueve los del arnés: el orden no cuenta)
d['hooks']['Stop'].insert(0, {"hooks": [{"type": "command", "command": "say listo"}]})   # uno ajeno de más
d['hooks']['Notification'] = [{"hooks": [{"type": "command", "command": "python3 /home/Dev-lab/notas/aviso.py"}]}]
json.dump(d, open(sys.argv[2], 'w'), indent=2)
PY
rc=$(correr "$T/a4.json" "$T/b4.json")
[ "$rc" = "0" ] && ok "T15 hooks ajenos en otro orden y uno ajeno de más → 0 (lo ajeno no cuenta)" \
  || mal "T15 lo ajeno no debería contar: esperaba 0, salió $rc: $(cat "$T/salida.txt")"

# 5) la línea de arranque distinta (vieja → nueva) → 0, y la salida la nombra como startup-line
escribir "$T/a5.json" "$LINEA_VIEJA" ""
escribir "$T/b5.json" "$LINEA_NUEVA" ""
rc=$(correr "$T/a5.json" "$T/b5.json")
if [ "$rc" = "0" ] && grep -q "startup-line" "$T/salida.txt" && grep -q "bootstrap.js" "$T/salida.txt"; then
  ok "T15 la línea de arranque distinta → 0 y la salida la nombra (startup-line, no cuenta para el veredicto)"
else
  mal "T15 la línea de arranque distinta → esperaba 0 nombrando startup-line y bootstrap.js, salió $rc: $(cat "$T/salida.txt")"
fi
#    control anti-tautología: la línea nueva no se cuenta como un hook del arnés que «sobra» (aunque nombre al arnés)
grep -q "sobra" "$T/salida.txt" && mal "T15 la línea de arranque nueva se contó como un hook del arnés de más" \
  || ok "T15 la línea de arranque no entra en la lista de hooks del arnés"

# 7) un archivo ilegible o ausente → 2 (nunca «iguales»)
echo '{ "hooks": ' > "$T/roto.json"
rc=$(correr "$T/a1.json" "$T/roto.json")
[ "$rc" = "2" ] && ok "T15 un settings ilegible → 2 (no se lee como «sin diferencias»)" \
  || mal "T15 un settings ilegible → esperaba 2, salió $rc: $(cat "$T/salida.txt")"
rc=$(correr "$T/a1.json" "$T/no-existe.json")
[ "$rc" = "2" ] && ok "T15 un settings ausente → 2" \
  || mal "T15 un settings ausente → esperaba 2, salió $rc: $(cat "$T/salida.txt")"

# ── Regresiones del pase adversarial (iteración 1, 2026-10-02 · clases 3, 5, 6, 12, 13, 28) ──────────────────────────
# REG-D10a · dos hooks del arnés con el MISMO nombre de archivo bajo el mismo evento (clocki y tycon-pipeline tienen cada
# uno su on-prompt.js) en otro orden → 0: la clave es la ruta relativa, no el nombre suelto ni la posición
dos() { # dos <archivo> <primero> <segundo>
  printf '{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "node \\"/home/Dev-lab/.claude/agent-skills/skills/%s/scripts/on-prompt.js\\"" } ] }, { "hooks": [ { "type": "command", "command": "node \\"/home/Dev-lab/.claude/agent-skills/skills/%s/scripts/on-prompt.js\\"" } ] } ] } }\n' "$2" "$3" > "$1"
}
dos "$T/op-a.json" clocki tycon-pipeline; dos "$T/op-b.json" tycon-pipeline clocki
rc=$(correr "$T/op-a.json" "$T/op-b.json")
[ "$rc" = "0" ] && ok "REG-D10a dos on-prompt.js de skills distintas en otro orden → 0" \
  || mal "REG-D10a mismos hooks en otro orden → esperaba 0, salió $rc: $(cat "$T/salida.txt")"
printf '{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "node \\"/home/Dev-lab/.claude/agent-skills/skills/tycon-pipeline/scripts/on-prompt.js\\"" } ] } ] } }\n' > "$T/op-c.json"
rc=$(correr "$T/op-a.json" "$T/op-c.json")
[ "$rc" = "1" ] && grep -q 'clocki' "$T/salida.txt" && ! grep -q 'cambió el comando' "$T/salida.txt" \
  && ok "REG-D10a falta el de clocki → 1 y nombra a clocki (no un «cambió el comando»)" \
  || mal "REG-D10a falta clocki → rc $rc: $(cat "$T/salida.txt")"
# REG-D10b · la línea de arranque con `git -C <repo> pull` (forma git-c-posix) se informa aparte y no cuenta
printf '{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "git -C \\"$HOME/.claude/tycon-claude-guides\\" pull --ff-only --autostash --quiet 2>/dev/null || true; git -C \\"$HOME/.claude/agent-skills\\" pull --ff-only --autostash 2>/dev/null || true; bash \\"$HOME/.claude/tycon-claude-guides/scripts/install-tycon-hooks.sh\\" 2>/dev/null || true", "async": true } ] } ] } }\n' > "$T/gc-a.json"
printf '{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "node \\"$HOME/.claude/.tycon-pipeline/harness/bootstrap.js\\" || bash \\"$HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh\\"", "async": true } ] } ] } }\n' > "$T/gc-b.json"
rc=$(correr "$T/gc-a.json" "$T/gc-b.json")
[ "$rc" = "0" ] && grep -q 'startup-line' "$T/salida.txt" && ok "REG-D10b la vieja con git -C … pull es la línea de arranque: se informa y no cuenta → 0" \
  || mal "REG-D10b git -C pull → rc $rc: $(cat "$T/salida.txt")"
# REG-D10c · un clon del arnés en una carpeta con cualquier nombre (el aplicador escribe la ruta real del clon): sus
# hooks cuentan; uno que falta → 1
CLON="$T/otra-carpeta/mi-arnes"; mkdir -p "$CLON/scripts/hooks"; : > "$CLON/scripts/install-tycon-hooks.sh"; : > "$CLON/scripts/hooks/retro-pending.js"; : > "$CLON/scripts/hooks/branch-guard-notice.js"
printf '{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "node \\"%s/scripts/hooks/branch-guard-notice.js\\"" } ] } ], "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node \\"%s/scripts/hooks/retro-pending.js\\"" } ] } ] } }\n' "$CLON" "$CLON" > "$T/cl-a.json"
printf '{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "node \\"%s/scripts/hooks/branch-guard-notice.js\\"" } ] } ] } }\n' "$CLON" > "$T/cl-b.json"
rc=$(correr "$T/cl-a.json" "$T/cl-b.json")
[ "$rc" = "1" ] && grep -q 'retro-pending' "$T/salida.txt" && ok "REG-D10c clon en otra carpeta: falta retro-pending → 1 y lo nombra" \
  || mal "REG-D10c clon en otra carpeta → rc $rc: $(cat "$T/salida.txt")"

# ── T40 (story 8.16, tanda C · AC 43): el modo --settings ve un cambio de perfil ──────────────────────────────────────
# La prueba de que el perfil del equipo deja los mismos hooks que antes de la tanda C (harness-profile.test.sh, T40) se
# apoya en este modo: tiene que ver la diferencia que deja un minimal (sin los frenos ni los medidores) contra un full.
# Si no la viera, «mismos hooks» no diría nada.
escribir "$T/p40-full.json" "$LINEA_NUEVA" ""
python3 - "$T/p40-full.json" "$T/p40-min.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
# una diferencia cualquiera entre dos settings.json: sin los PreToolUse (entre ellos safety-guard), el medidor de estilo y el retro
d['hooks']['PreToolUse'] = []
d['hooks']['Stop'] = [g for g in d['hooks']['Stop'] if 'response-style-meter' not in json.dumps(g)]
d['hooks']['PostToolUse'] = [g for g in d['hooks']['PostToolUse'] if 'retro-pending' not in json.dumps(g)]
json.dump(d, open(sys.argv[2], 'w'), indent=2)
PY
rc=$(correr "$T/p40-full.json" "$T/p40-min.json")
[ "$rc" = "1" ] && grep -q "safety-guard-pre.sh" "$T/salida.txt" && grep -q "response-style-meter.js" "$T/salida.txt" \
  && ok "T40 un full contra un minimal → 1, y nombra los frenos y el medidor que minimal no trae" \
  || mal "T40 full contra minimal → esperaba 1 nombrando safety-guard-pre.sh y response-style-meter.js, salió $rc: $(cat "$T/salida.txt")"

# ── Story 8.18 (2026-10-04) · el modo `--base` no se traga el error de quien ubica las skills ─────────────────────────
# `skills-dir.js` tira cuando su vecina (canonical-path.js) está y no carga. El modo `--base` envolvía la llamada en un
# `catch` genérico y seguía con ~/.claude/agent-skills: medía las skills INSTALADAS en vez de las del clon, callado.
# Un clon de juguete (el script, la biblioteca y sus dos vecinas) fuera de todo repo de git, con una HOME de juguete que
# SÍ trae algo instalado (adonde caería quien se traga el error). `--base` necesita un commit: acá no lo hay, así que
# quien pasa de la resolución de las skills llega a «no encuentro el commit» — eso es lo que muestra el espejo.
# 🔴 rojo previo verificado: con el `catch` genérico, el caso roto llega a «no encuentro el commit» sin decir nada.
lab_clone() { # lab_clone <nombre> → arma $T/<nombre>/clone y deja LAB apuntando a $T/<nombre>
  LAB="$T/$1"; mkdir -p "$LAB/clone/scripts/publishing" "$LAB/clone/scripts/lib" "$LAB/clone/skills/tycon-pipeline" "$LAB/clone/agents" \
    "$LAB/home/.claude/agent-skills/skills/tycon-pipeline"
  cp "$SCRIPT" "$LAB/clone/scripts/publishing/profile-equivalence.js"
  for f in skills-dir.js canonical-path.js legacy-names.js; do cp "$RAIZ/scripts/lib/$f" "$LAB/clone/scripts/lib/$f"; done
  # lo que canonical-path.js importa viaja con ella (story 8.19: el nombre del lugar)
  # (place.js toma el nombre de tycon-home.js, a su lado: story 8.23)
  mkdir -p "$LAB/clone/scripts/setup/harness" && cp "$RAIZ/scripts/setup/harness/place.js" "$RAIZ/scripts/setup/harness/tycon-home.js" "$LAB/clone/scripts/setup/harness/"
}
base_mode() { # base_mode [args…] → corre el modo --base del clon de juguete, sin la variable; imprime el exit
  HOME="$LAB/home" env -u TYCON_SKILLS_DIR -u TYCON_GUIDES_DIR node "$LAB/clone/scripts/publishing/profile-equivalence.js" --base HEAD "$@" > "$T/salida.txt" 2>&1; echo $?
}
lab_clone roto; printf '%s\n' 'throw new Error("biblioteca rota a propósito")' > "$LAB/clone/scripts/lib/canonical-path.js"
rc=$(base_mode)
if [ "$rc" = "2" ] && grep -q "no pude resolver la carpeta de skills: " "$T/salida.txt" && grep -q "biblioteca rota a propósito" "$T/salida.txt" \
  && ! grep -q "no encuentro el commit" "$T/salida.txt"; then
  ok "8.18 --base con la biblioteca de las skills rota → 2, dice «no pude resolver» con la causa y no sigue"
else
  mal "8.18 --base con la biblioteca rota → esperaba 2 con «no pude resolver la carpeta de skills: … biblioteca rota a propósito» y sin seguir, salió $rc: $(cat "$T/salida.txt")"
fi
#    …con --agent-skills dado no se le pregunta a la biblioteca: la rota no molesta (llega al paso siguiente)
rc=$(base_mode --agent-skills "$LAB/home/.claude/agent-skills")
[ "$rc" = "2" ] && grep -q "no encuentro el commit" "$T/salida.txt" && ! grep -q "no pude resolver" "$T/salida.txt" \
  && ok "8.18 --base con --agent-skills dado no depende de la biblioteca" \
  || mal "8.18 --base --agent-skills con la biblioteca rota → esperaba llegar a «no encuentro el commit», salió $rc: $(cat "$T/salida.txt")"
#    el espejo: con la biblioteca sana pasa de la resolución (el propio clon, que es unido) y llega al paso siguiente
lab_clone sano
rc=$(base_mode)
[ "$rc" = "2" ] && grep -q "no encuentro el commit" "$T/salida.txt" && ! grep -q "no pude resolver" "$T/salida.txt" \
  && ok "8.18 --base con la biblioteca sana pasa de la resolución de las skills" \
  || mal "8.18 --base con la biblioteca sana → esperaba llegar a «no encuentro el commit», salió $rc: $(cat "$T/salida.txt")"

# ── T38 (story 8.17, tanda W3 · AC 26 y 60) · el instalador a través de la lista única deja lo mismo que el de antes ──
# El instalador de antes de la W3 (el del commit de partida de la tanda, con su lista y su bloque de Python) y el de
# ahora (que llama a scripts/setup/apply-hooks.js), corridos DESDE LA MISMA COPIA del repo sobre la misma carpeta de
# juguete: settings.json byte a byte igual (la carpeta de cada HOME normalizada) y la misma salida, en cuatro casos —la
# instalación de equipo, la pública, la minimal y una máquina con hooks ajenos, un reemplazado, una forma vieja y un
# matcher angosto—. Mide el CAMBIO de la W3: vale mientras la lista sea la de ese commit; si la lista cambió después
# (un hook nuevo), el viejo ya no es la referencia y la prueba lo dice como NO MEDIDO, nunca como verde. Sin ese commit
# en el clon (uno superficial), también NO MEDIDO. Dev Agent Record de la 8.17: corrida del 2026-10-05, los cuatro iguales.
W3_BASE=16b4bfd6961fd585ab2eb39eb5bc6514b8740a49
RAIZ_REPO="$RAIZ"
if ! git -C "$RAIZ_REPO" cat-file -e "$W3_BASE:scripts/install-tycon-hooks.sh" 2>/dev/null; then
  echo "  ⏭  T38 NO MEDIDO — el clon no trae el commit de partida de la W3 ($W3_BASE): sin el instalador de antes no hay con qué comparar"
elif ! node -e '
  const [list, oldSh] = [require(process.argv[1]).hooks, require("fs").readFileSync(process.argv[2], "utf8")];
  const specs = (oldSh.match(/^\s+"(?:UserPromptSubmit|PostToolUse|PreToolUse|Stop|SessionStart)\|[^\n]*"$/gm) || []).length;
  process.exit(specs === list.length ? 0 : 1);' "$RAIZ_REPO/scripts/setup/hooks-list.json" <(git -C "$RAIZ_REPO" show "$W3_BASE:scripts/install-tycon-hooks.sh"); then
  echo "  ⏭  T38 NO MEDIDO — la lista de hooks cambió desde la W3: el instalador de $W3_BASE ya no es la referencia"
else
  EQ="$T/w3eq"; D="$EQ/repo"; mkdir -p "$D"
  rsync -a --exclude .git --exclude .advisors --exclude node_modules "$RAIZ_REPO/" "$D/"
  git -C "$RAIZ_REPO" show "$W3_BASE:scripts/install-tycon-hooks.sh" > "$EQ/old.sh"; cp "$D/scripts/install-tycon-hooks.sh" "$EQ/new.sh"
  # La 8.19 (tanda E) cambió el texto de dos rótulos de la lista («el arnés» donde nombraba al repo interno). T38 mide el
  # cambio de la W3, no esos textos: la referencia los toma con el texto de hoy, y todo lo demás se compara igual.
  OLDN="$(node -p "require(process.argv[1]).LEGACY_PLACE_NAME" "$RAIZ_REPO/scripts/setup/harness/place.js" 2>/dev/null || true)"
  if [ -n "$OLDN" ]; then
    sed -i.bak -e "s#grita en cada arranque si ${OLDN} o agent-skills NO están en main#grita en cada arranque si el arnés o agent-skills NO están en main#" \
      -e "s#tocar git sí\. En ${OLDN} y agent-skills no propone worktree#tocar git sí. En el arnés y agent-skills no propone worktree#" "$EQ/old.sh" && rm -f "$EQ/old.sh.bak"
  fi
  # La 8.10.3 (tanda C) cambió el texto de un rótulo más: el caso disparador del medidor de pasos bloqueantes nombraba un
  # repo interno y ahora dice «un repo del equipo». Mismo criterio: la referencia lo toma con el texto de hoy. El nombre
  # viejo no se escribe acá: se reconoce por su forma (mayúsculas y guiones entre el número de la story y la fecha).
  sed -i.bak -E -e "s#Caso disparador: Story 3\.34 [A-Z][A-Z-]+ 2026-07-29#Caso disparador: Story 3.34 de un repo del equipo 2026-07-29#" "$EQ/old.sh" && rm -f "$EQ/old.sh.bak"
  # …y que se diga si no pudo: sin el rótulo de hoy en la referencia, el rojo de abajo sería «los instaladores difieren»
  # cuando lo que pasó es que esta línea dejó de reconocer el texto viejo.
  grep -q "Caso disparador: Story 3.34 de un repo del equipo 2026-07-29" "$EQ/old.sh" \
    || mal "T38 referencia: no pude llevar al texto de hoy el rótulo del medidor de pasos bloqueantes en el instalador de $W3_BASE (la forma del texto viejo cambió)"
  # La 8.10.3 (tanda E) cambió el nombre inventado de cuatro productos, y cuatro rótulos los nombran en su caso
  # disparador. Mismo criterio: la referencia los toma con el texto de hoy. Los nombres viejos no se escriben acá: cada
  # uno se reconoce por la forma de la frase que lo rodea, y si alguna dejó de reconocerse se dice.
  sed -i.bak -E \
    -e "s#Caso: [A-Z][a-z]+ AS-1/PERF-1#Caso: Totora AS-1/PERF-1#" \
    -e "s#(PR [0-9]+ de )[A-Z][a-z]+( \(2026-09-03\))#\1Ceibo\2#" \
    -e "s#Medido: [A-Z]+/FrontEnd pasó verde#Medido: URUTAU/FrontEnd pasó verde#" \
    -e "s#Caso: [A-Z]+ Story 1\.1 2026-08-25#Caso: FRESNO Story 1.1 2026-08-25#" "$EQ/old.sh" && rm -f "$EQ/old.sh.bak"
  for rotulo in "Caso: Totora AS-1/PERF-1" "de Ceibo (2026-09-03)" "Medido: URUTAU/FrontEnd pasó verde" "Caso: FRESNO Story 1.1 2026-08-25"; do
    grep -qF "$rotulo" "$EQ/old.sh" \
      || mal "T38 referencia: no pude llevar al texto de hoy el rótulo que dice «${rotulo}» en el instalador de $W3_BASE (la forma del texto viejo cambió)"
  done
  w3_run() { # w3_run <sh> <home> [VAR=valor…]
    cp "$1" "$D/scripts/install-tycon-hooks.sh"; local h="$2"; shift 2
    env -i PATH="$PATH" HOME="$h" USERPROFILE="$h" TYCON_NO_GUI_ENV=1 TYCON_NO_NIGHTLY_EXAM=1 TYCON_EXAM_LAUNCHAGENTS="$h/LA" \
      TYCON_NO_UPLOAD_RUNS=1 TYCON_NO_DOWNLOAD_RUNS=1 TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_THREAD_RESCUE=1 TYCON_NO_COLLECT_FINDINGS=1 \
      TYCON_NO_ENGRAM_VERSION_CHECK=1 TYCON_NO_SQLITE_CHECK=1 TYCON_NO_ENGRAM_PROJECT_CHECK=1 TYCON_THIRD_PARTY=0 TYCON_HARNESS_LOCK_HELD=1 \
      TYCON_GIT_HOOKS_DIR="$h/gh" CODEX_HOME="$h/codex" "$@" bash "$D/scripts/install-tycon-hooks.sh" > "$h.out" 2>&1
  }
  # la máquina con historia: una instalación de equipo de antes + ajenos, un reemplazado, una forma vieja, un matcher angosto
  mkdir -p "$EQ/seed/.claude"; w3_run "$EQ/old.sh" "$EQ/seed"
  node - "$EQ/seed/.claude/settings.json" "$EQ/seed" > "$EQ/seed.json" <<'JS'
const fs = require('fs');
const [file, home] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(file, 'utf8').split(home).join('__H__'));
s.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/opt/ajeno/freno-propio.js"' }] });
s.hooks.PostToolUse.push({ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node "__H__/.claude/agent-skills/skills/tycon-pipeline/scripts/on-edit.js"' }] });
(s.hooks.UserPromptSubmit = s.hooks.UserPromptSubmit || []).push({ hooks: [{ type: 'command', command: 'bash "__H__/.claude/hooks/engram-pre-commit.sh"' }] });
for (const e of s.hooks.PreToolUse) if (e.matcher === 'Bash|PowerShell') e.hooks = e.hooks.filter((h) => !h.command.includes('pr-auto-complete-guard'));
s.otra = { del: 'dev' };
process.stdout.write(JSON.stringify(s, null, 2) + '\n');
JS
  for caso in equipo publica minimal historia; do
    for v in old new; do
      H="$EQ/$caso-$v"; mkdir -p "$H/.claude"
      [ "$caso" = historia ] && sed "s#__H__#$H#g" "$EQ/seed.json" > "$H/.claude/settings.json"
      case "$caso" in
        publica) w3_run "$EQ/$v.sh" "$H" TYCON_PROFILE=0 ;;
        minimal) w3_run "$EQ/$v.sh" "$H" TYCON_INSTALL_PROFILE=minimal ;;
        *) w3_run "$EQ/$v.sh" "$H" ;;
      esac
      sed "s#$H#__H__#g" "$H/.claude/settings.json" > "$H.norm"
      sed "s#$H#__H__#g" "$H.out" | grep -v 'backup en' > "$H.outnorm"
    done
    if cmp -s "$EQ/$caso-old.norm" "$EQ/$caso-new.norm" && cmp -s "$EQ/$caso-old.outnorm" "$EQ/$caso-new.outnorm"; then
      ok "T38 $caso: el instalador a través de la lista única deja el mismo settings.json, byte a byte, y dice lo mismo"
    else
      mal "T38 $caso: el instalador nuevo no deja lo mismo que el de antes: $(diff "$EQ/$caso-old.norm" "$EQ/$caso-new.norm" | head -6 | tr '\n' ' ') $(diff "$EQ/$caso-old.outnorm" "$EQ/$caso-new.outnorm" | head -4 | tr '\n' ' ')"
    fi
  done
  # que el caso con historia cambió algo de verdad (si no, «igual» no probaría nada)
  grep -q 'superseded by H10 dispatcher' "$EQ/historia-new.out" && grep -q 'legacy path migrado' "$EQ/historia-new.out" \
    && ok "T38 historia: el caso ejerce el reemplazado y la forma vieja (los dos instaladores los sacan)" \
    || mal "T38 historia: el caso no sacó el reemplazado ni la forma vieja: no probó nada"
fi

echo
if [ "$FALLOS" -gt 0 ]; then echo "FALLARON $FALLOS chequeo(s)"; exit 1; fi
echo "todo verde"; exit 0
