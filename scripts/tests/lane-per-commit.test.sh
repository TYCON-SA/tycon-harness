#!/usr/bin/env bash
# lane-per-commit.test.sh — red del carril de cada commit.
#
# Por qué existe: el hook que registra cada commit de una sesión (unpushed-work-notice.js) anota el
# repo y el sha, y nada de POR QUÉ CARRIL entró el trabajo: una corrida del pipeline, un atajo
# declarado, o ninguno de los dos. Sin eso, «¿cuánto se hace fuera del pipeline?» no tiene número.
#
# Lo que prueba:
#   T9  — tres commits, tres carriles: pipeline (con su story), adhoc y ninguno; la línea durable
#         (carriles.jsonl) lleva {ts, carril, story} y NADA más — ni ruta, ni sha, ni mensaje
#   T9b — el registro por sesión suma carril y story sin perder repo ni sha
#   T9c — una story con forma rara no se copia: sale null
#   T10 — un commit que el hook no ve (hecho fuera de una sesión) no deja ninguna línea
#   T11 — no poder escribir la constancia no rompe el hook
#   T11b — un comando que no es un commit no anota carril
#
# 🔴 HOME falso siempre: los registros viven bajo el home.
# Correr: bash scripts/tests/lane-per-commit.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$AQUI/scripts/hooks/unpushed-work-notice.js"
TMP="$(mktemp -d)"; trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ carril: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ carril: $1"; fallos=$((fallos+1)); }

EST=".claude/.tycon-pipeline"
CASA="$TMP/casa"; mkdir -p "$CASA/$EST/active" "$CASA/$EST/adhoc"
REPO="$TMP/cliente-secreto/Backend"; mkdir -p "$REPO/.tycon"
git -C "$REPO" init -q -b main
gcommit(){ git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "$1"; }
gcommit "base"
CARR="$CASA/$EST/carriles.jsonl"
nlin(){ if [ -f "$CARR" ]; then wc -l < "$CARR" | tr -d ' '; else echo 0; fi; }

# corre el hook en modo registro para un commit YA hecho
registrar(){ # $1 sesión  $2 asunto del commit
  local ev
  ev="$(node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",session_id:process.argv[1],cwd:process.argv[2],tool_input:{command:`git commit -m "${process.argv[3]}"`}}))' "$1" "$REPO" "$2")"
  printf '%s' "$ev" | HOME="$CASA" node "$HOOK" >/dev/null 2>&1
  echo $?
}
campo(){ # $1 archivo  $2 número de línea (1..)  $3 expresión sobre `o`
  F="$1" N="$2" E="$3" node -e '
    const l = require("fs").readFileSync(process.env.F, "utf8").split("\n").filter(Boolean)[Number(process.env.N) - 1];
    const o = JSON.parse(l); process.stdout.write(String(eval(process.env.E)));
  ' 2>&1
}

# ── T9 — tres carriles ────────────────────────────────────────────────────────────────────────
printf '{"storyId":"2.7","storyPath":"/x/s.md","repoPath":"%s","sessionId":"s-pipe"}' "$REPO" > "$CASA/$EST/active/s-pipe.json"
printf '{"reason":"un hotfix chico","files":[],"maxFiles":8}' > "$CASA/$EST/adhoc/s-adhoc.json"

gcommit "feat: con corrida"
rc1=$(registrar s-pipe "feat: con corrida")
gcommit "fix: con atajo"
rc2=$(registrar s-adhoc "fix: con atajo")
gcommit "chore: sin carril"
rc3=$(registrar s-nada "chore: sin carril")
[ "$rc1$rc2$rc3" = "000" ] && ok "T9 el hook sale 0 en los tres" || no "T9 códigos de salida: $rc1 $rc2 $rc3"

if [ -f "$CARR" ]; then
  n=$(wc -l < "$CARR" | tr -d ' ')
  [ "$n" = "3" ] && ok "T9 una línea por commit" || no "T9 esperaba 3 líneas, hay $n"
  [ "$(campo "$CARR" 1 'o.carril + "|" + o.story')" = "pipeline|2.7" ] && ok "T9 el commit con corrida cae en pipeline con su story" || no "T9 línea 1: $(sed -n 1p "$CARR")"
  [ "$(campo "$CARR" 2 'o.carril + "|" + o.story')" = "adhoc|null" ] && ok "T9 el commit con atajo cae en adhoc, sin story" || no "T9 línea 2: $(sed -n 2p "$CARR")"
  [ "$(campo "$CARR" 3 'o.carril + "|" + o.story')" = "ninguno|null" ] && ok "T9 el commit sin carril cae en ninguno" || no "T9 línea 3: $(sed -n 3p "$CARR")"
  [ "$(campo "$CARR" 1 'Object.keys(o).sort().join(",")')" = "carril,story,ts" ] && ok "T9 la línea lleva sólo ts, carril y story" || no "T9 claves: $(campo "$CARR" 1 'Object.keys(o).join(",")')"
  if grep -q -e "cliente-secreto" -e "$(git -C "$REPO" rev-parse HEAD)" -e "sin carril" "$CARR"; then no "T9 la línea durable filtra ruta, sha o mensaje"; else ok "T9 ni ruta, ni sha, ni mensaje en la línea durable"; fi
else
  no "T9 no se creó carriles.jsonl"
fi

# ── T9b — el registro por sesión conserva lo que tenía y suma el carril ─────────────────────────
LED="$CASA/$EST/unpushed-commits-s-pipe.jsonl"
if [ -f "$LED" ]; then
  r=$(campo "$LED" 1 'o.kind + "|" + (o.repo ? "repo" : "-") + "|" + (o.sha ? "sha" : "-") + "|" + o.carril + "|" + o.story')
  [ "$r" = "commit|repo|sha|pipeline|2.7" ] && ok "T9b el registro de sesión suma carril y story sin perder repo ni sha" || no "T9b: $r"
else
  no "T9b no existe el registro de la sesión"
fi

# ── T9c — story con forma rara ─────────────────────────────────────────────────────────────────
printf '{"storyId":"../../etc/passwd con espacios","sessionId":"s-rara"}' > "$CASA/$EST/active/s-rara.json"
gcommit "feat: story rara"
registrar s-rara "feat: story rara" >/dev/null
[ "$(campo "$CARR" 4 'o.carril + "|" + o.story')" = "pipeline|null" ] && ok "T9c una story con forma rara no se copia" || no "T9c línea 4: $(sed -n 4p "$CARR" 2>/dev/null)"

# ── T9d — el estado de la sesión existe pero no se puede leer ──────────────────────────────────
# 🔴 Tratarlo igual que «no existe» haría que un commit hecho EN una corrida se cuente como «ninguno».
printf '{"storyId": "2.7", roto' > "$CASA/$EST/active/s-rota.json"
gcommit "feat: estado roto"
registrar s-rota "feat: estado roto" >/dev/null
[ "$(campo "$CARR" 5 'o.carril + "|" + o.story')" = "ilegible|null" ] && ok "T9d un estado de sesión ilegible se anota «ilegible», no «ninguno»" || no "T9d línea 5: $(sed -n 5p "$CARR" 2>/dev/null)"
printf '{"reason":"x"' > "$CASA/$EST/adhoc/s-adhoc-rota.json"
gcommit "fix: atajo roto"
registrar s-adhoc-rota "fix: atajo roto" >/dev/null
[ "$(campo "$CARR" 6 'o.carril')" = "ilegible" ] && ok "T9d también si el que no se lee es el del atajo" || no "T9d línea 6: $(sed -n 6p "$CARR" 2>/dev/null)"

# ── T9e — un atajo vencido no es un carril ───────────
# 🔴 El portón da el atajo por vencido pasadas 6 h; si el hook lo siguiera contando como `adhoc`, la medición sería falsa.
node -e '
const fs=require("fs"); const v=new Date(Date.now()-20*3600e3).toISOString();
fs.writeFileSync(process.argv[1], JSON.stringify({reason:"un hotfix viejo",files:[],declaredAt:v,lastTouch:v}));
' "$CASA/$EST/adhoc/s-vencido.json"
gcommit "fix: con atajo vencido"
registrar s-vencido "fix: con atajo vencido" >/dev/null
[ "$(campo "$CARR" 7 'o.carril')" = "ninguno" ] && ok "T9e un atajo vencido (20 h) no cuenta como adhoc" || no "T9e línea 7: $(sed -n 7p "$CARR" 2>/dev/null)"

# ── T9f — el commit que llega justo DESPUÉS de cerrar la corrida sigue siendo del pipeline ──────────────
# 🔴 El paso 8 cierra el marker antes de que el dev apruebe el commit: sin esto, el commit de la corrida
#    cae en `ninguno`, que es exactamente lo contrario de lo que el carril existe para medir.
mkdir -p "$CASA/$EST/timing-history"
node -e '
const fs=require("fs");
const hace=(min)=>new Date(Date.now()-min*60e3).toISOString();
fs.writeFileSync(process.argv[1]+"/2.8-reciente.json", JSON.stringify({archivedAt:hace(10),marker:{storyId:"2.8",sessionId:"s-cerrada"}}));
fs.writeFileSync(process.argv[1]+"/2.9-vieja.json", JSON.stringify({archivedAt:hace(300),marker:{storyId:"2.9",sessionId:"s-vieja"}}));
' "$CASA/$EST/timing-history"
gcommit "feat: después del cierre"
registrar s-cerrada "feat: después del cierre" >/dev/null
[ "$(campo "$CARR" 8 'o.carril + "|" + o.story')" = "pipeline|2.8" ] && ok "T9f el commit de hace 10 min tras cerrar la corrida cuenta como pipeline, con su story" || no "T9f línea 8: $(sed -n 8p "$CARR" 2>/dev/null)"
gcommit "feat: mucho después"
registrar s-vieja "feat: mucho después" >/dev/null
[ "$(campo "$CARR" 9 'o.carril')" = "ninguno" ] && ok "T9f una corrida cerrada hace 5 h ya no le da carril al commit" || no "T9f línea 9: $(sed -n 9p "$CARR" 2>/dev/null)"

# ── T10 — un commit que ningún hook vio ────────────────────────────────────────────────────────
antes=$(nlin)
gcommit "commit hecho desde la terminal"
despues=$(nlin)
[ "$antes" -gt 0 ] && [ "$antes" = "$despues" ] && ok "T10 un commit fuera de sesión no deja línea (no medido, no cero)" || no "T10 apareció una línea sin hook"

# ── T11 — no poder escribir ────────────────────────────────────────────────────────────────────
CASA2="$TMP/casa2"; mkdir -p "$CASA2/$EST"; chmod a-w "$CASA2/$EST"
gcommit "feat: sin permiso"
ev="$(node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",session_id:"s-x",cwd:process.argv[1],tool_input:{command:"git commit -m \"feat: sin permiso\""}}))' "$REPO")"
printf '%s' "$ev" | HOME="$CASA2" node "$HOOK" >/dev/null 2>&1; rc=$?
[ "$rc" = "0" ] && ok "T11 sin permiso de escritura el hook sale igual" || no "T11 el hook salió $rc"
chmod u+w "$CASA2/$EST"

# ── T11b — lo que no es un commit no anota carril ─────────────────────────────────────────────
antes=$(nlin)
ev="$(node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",session_id:"s-pipe",cwd:process.argv[1],tool_input:{command:"git status && git log -1"}}))' "$REPO")"
printf '%s' "$ev" | HOME="$CASA" node "$HOOK" >/dev/null 2>&1
despues=$(nlin)
[ "$antes" = "$despues" ] && ok "T11b un git status no anota carril" || no "T11b se anotó un carril sin commit"

echo "carril: $pasaron bien · $fallos mal"
[ "$fallos" -eq 0 ]
