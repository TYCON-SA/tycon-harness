#!/usr/bin/env bash
# prod-access-guard.test.sh — red del freno de producción y de su índice.
#
# Qué evita: autorizada UNA consulta a producción, en el turno siguiente el asistente podría correr varias más sin
# pedir permiso y abrir una regla de firewall que quede viva. Una regla escrita en la memoria del asistente no alcanza.
#
# Lo que prueba (los casos del banco cubren el resto — `40-prod-access-guard.json`):
#   T4  — todas las formas de nombrar un servidor (cadena de conexión, az, nombre corto, comillas partidas)
#   T6  — la puerta sólo en su forma canónica (bash -c, eval, env, xargs, redirecciones, $(…) → 2)
#   T12 — el índice lee sólo repos clonados bajo la raíz, acotado (no entra node_modules)
#   T13 — el mismo host declarado con dos ambientes: gana producción, y los nombra a los dos
#   T15 — producción pegajosa: reescribir el catálogo o borrar el índice NO destraba
#   T16 — secuestro de la puerta por función/alias del shell (y los nombres que sólo la contienen, no)
#   T17 — falla propia del hook con un comando que nombra bases → 2 (y `git status` pasa)
#   T30 — sin snapshot (Claude Code 2.1.272 ya no lo escribe) se le pregunta al shell de login en vivo:
#         limpio pasa; secuestrado, mudo, colgado o de un shell que no sé leer frena
#   T31 — se mira el snapshot de ESTA sesión, no el más nuevo
#   6.6 T1-T8, T13 — el cuadro muestra la consulta: --file se frena (con el comando en línea listo), la consulta en
#         línea tiene un tope de 20 renglones de pantalla y una lista de caracteres que engañan
#   T32 — la guía declara que la regla de firewall es de cortesía
#
# 🔴 HOME falso siempre: el hook lee ~/.claude (snapshots, índice, registros).
# Correr: bash scripts/tests/prod-access-guard.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$AQUI/scripts/hooks/prod-access-guard.js"
INDICE="$AQUI/scripts/production/production-index.js"
GUIA="$AQUI/guides/produccion-con-permiso.md"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ prod-guard: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ prod-guard: $1"; fallos=$((fallos+1)); }

PROD=acme-sql.database.windows.net
STAGING=acme-sql-staging.database.windows.net

# ── el mundo de prueba: HOME falso + dos repos con catálogo ───────────────────────────────────
mundo(){ # deja $CASA (HOME falso) y $REPOS (raíz de repos) recién hechos
  CASA="$TMP/casa"; REPOS="$TMP/repos"
  rm -rf "$CASA" "$REPOS"
  mkdir -p "$CASA/.claude/shell-snapshots" "$CASA/.claude/.tycon-pipeline"
  mkdir -p "$REPOS/backend-acme/.tycon" "$REPOS/otro/.tycon"
  ( cd "$REPOS/backend-acme" && git init -q . ) >/dev/null 2>&1
  ( cd "$REPOS/otro" && git init -q . ) >/dev/null 2>&1
  cat > "$REPOS/backend-acme/.tycon/production.json" <<JSON
{"servers":[{"host":"$PROD","environment":"produccion","keychain":"tycon-prod-acme"},
               {"host":"$STAGING","environment":"no-produccion"},
               {"host":"acme-test.example.com","environment":"no-produccion"}]}
JSON
  printf '{"servers":[{"host":"otro.database.windows.net","environment":"no-produccion"}]}' > "$REPOS/otro/.tycon/production.json"
}

snapshot(){ # $1 = funciones, $2 = alias, $3 = epoch-ms del nombre (default: ahora)
  local ms="${3:-$(date +%s)000}"
  printf '# Snapshot file\n\n# Functions\n%s\n# Shell Options\n# Aliases\n%s\n# Check for rg availability\nrg () { : }\nexport PATH=/usr/bin\n' "$1" "$2" > "$CASA/.claude/shell-snapshots/snapshot-zsh-$ms-aaaaaa.sh"; }

# corre el hook con un comando; imprime el exit code. $2… = variables extra "K=V"
corre(){ local cmd="$1"; shift
  local payload; payload="$(CMD="$cmd" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:process.env.WITHOUT_CWD?undefined:(process.env.CWD||"/tmp"),tool_input:{command:process.env.CMD}}))' 2>/dev/null)"
  # TYCON_PROD_SESSION_SINCE: el arranque de la sesión, en ms. En producción sale de la ascendencia de
  # procesos hasta el `claude` que invocó el hook; acá no hay ninguno, así que se inyecta. La costura
  # sólo puede cerrar el freno (0 = TODOS los snapshots son candidatos, el lado seguro), nunca abrirlo.
  printf '%s' "$payload" | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE="${DESDE:-0}" "$@" node "${HOOK_USAR:-$HOOK}" >"$TMP/out" 2>"$TMP/err"
  echo $?
}
frena(){ local etiqueta="$1" cmd="$2"; shift 2
  local rc; rc="$(corre "$cmd" "$@")"
  if [ "$rc" = 2 ]; then ok "$etiqueta"; else no "$etiqueta (rc=$rc, esperaba 2) — err: $(head -c 120 "$TMP/err")"; fi
}
pasa(){ local etiqueta="$1" cmd="$2"; shift 2
  local rc; rc="$(corre "$cmd" "$@")"
  if [ "$rc" = 0 ]; then ok "$etiqueta"; else no "$etiqueta (rc=$rc, esperaba 0) — err: $(head -c 120 "$TMP/err")"; fi
}

# Con el freno INSTALADO las costuras de prueba no existen (a propósito), así que estos casos no se
# pueden fabricar ahí. La suite no corre, y lo dice.
if [ -d /opt/tycon ]; then
  echo "⏭ prod-guard: esta máquina tiene el freno instalado (/opt/tycon): sin costuras de prueba, esta suite corre en el nocturno."
  exit 0
fi
if [ ! -f "$HOOK" ] || [ ! -f "$INDICE" ]; then
  no "el freno o el índice no existen todavía ($HOOK / $INDICE)"
  echo "— prod-guard: $pasaron ok, $fallos fallos —"; exit 1
fi

# ── T12 · el índice: sólo repos clonados bajo la raíz, y acotado ──────────────────────────────
# Sin esto, leer de cualquier carpeta (o sin acotar) deja entrar un catálogo sembrado en node_modules
# y tarda ~17 s; y un repo de FUERA de la raíz haría conocido un host que esta máquina no debería conocer.
mundo
mkdir -p "$REPOS/backend-acme/node_modules/x/.tycon"
printf '{"servers":[{"host":"sembrado.database.windows.net","environment":"no-produccion"}]}' > "$REPOS/backend-acme/node_modules/x/.tycon/production.json"
mkdir -p "$TMP/afuera/.tycon"; ( cd "$TMP/afuera" && git init -q . ) >/dev/null 2>&1
printf '{"servers":[{"host":"prod-b.database.windows.net","environment":"no-produccion"}]}' > "$TMP/afuera/.tycon/production.json"
JSON_INDICE="$(HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" node "$INDICE" --json 2>/dev/null)"
if printf '%s' "$JSON_INDICE" | grep "sembrado.database.windows.net" >/dev/null; then no "T12a · entró un catálogo de node_modules al índice"; else ok "T12a · node_modules no entra al índice"; fi
if printf '%s' "$JSON_INDICE" | grep "prod-b.database.windows.net" >/dev/null; then no "T12b · entró un catálogo de FUERA de la raíz de repos"; else ok "T12b · un catálogo fuera de la raíz no entra"; fi
frena "T12c · un host de fuera de la raíz es DESCONOCIDO y se frena" "sqlcmd -S prod-b.database.windows.net -Q \"select 1\""

# ── T13 · el mismo host con dos ambientes: gana producción ────────────────────────────────────
# Sin esto, quedarse con el último leído hace que el orden de lectura decida si producción está protegida.
mundo
printf '{"servers":[{"host":"'$PROD'","environment":"no-produccion"}]}' > "$REPOS/otro/.tycon/production.json"
rc="$(corre "sqlcmd -S $PROD -Q \"select 1\"")"
if [ "$rc" = 2 ] && grep -q "backend-acme" "$TMP/err" && grep -q "otro" "$TMP/err"; then ok "T13 · gana producción y nombra los dos repos"
else no "T13 · rc=$rc y/o el mensaje no nombra los dos repos — err: $(head -c 160 "$TMP/err")"; fi

# ── T15 · producción pegajosa ─────────────────────────────────────────────────────────────────
# Sin esto, regenerar el índice desde cero haría que reescribir el catálogo a no-produccion destrabe
# producción sin que nadie lo apruebe.
mundo
corre "sqlcmd -S $PROD -Q \"select 1\"" >/dev/null                     # primera vez: queda en la memoria
printf '{"servers":[{"host":"'$PROD'","environment":"no-produccion"}]}' > "$REPOS/backend-acme/.tycon/production.json"
rm -f "$CASA/.claude/.tycon-pipeline/production-index.json"
rc="$(corre "sqlcmd -S $PROD -Q \"select 1\"")"
if [ "$rc" = 2 ] && grep -q -- "--reclasificar" "$TMP/err"; then ok "T15 · sigue frenando y ofrece --reclasificar"
else no "T15 · el host se destrabó reescribiendo el catálogo (rc=$rc)"; fi

# ── T4 · todas las formas de nombrar un servidor ──────────────────────────────────────────────
# Sin esto, mirar sólo `sqlcmd -S`, no des-entrecomillar o no completar el nombre corto deja pasar alguna de las formas.
mundo
frena "T4a · cadena de conexión con tcp: y puerto" "python3 -c 'x=\"Server=tcp:ACME-SQL.database.windows.net,1433;Database=d\"'"
frena "T4b · az con nombre corto" "az sql db list --server acme-sql -g ACME"
frena "T4c · comillas partidas en el valor" "az sql db list --server \"acme-s\"ql -g ACME"
frena "T4d · bcp" "bcp tabla out x.dat -S $PROD -T"
frena "T4e · por --ids de recurso" "az resource show --ids /subscriptions/x/resourceGroups/ACME/providers/Microsoft.Sql/servers/acme-sql"
pasa  "T4f · staging con prefijo parecido pasa" "sqlcmd -S $STAGING -Q \"select 1\""
pasa  "T4g · un comando sin base no dice nada" "git status"
pasa  "T4h · SQL_SERVER= no es una cadena de conexión" "SQL_SERVER=algo make build"
pasa  "T4i · el tipo de recurso de una consulta de az graph no es un servidor" "az graph query -q \"Resources | where type =~ 'microsoft.sql/servers/databases' | project name\""
pasa  "T4j · en az sql server, lo que sigue a -s no es un servidor" "az sql server list -s 0f1e2d3c-1111-2222-3333-444455556666 -o table"
frena "T4k · en az sql db, -s sigue siendo el servidor" "az sql db list -s acme-sql -g ACME"
frena "T4l · el servidor de az sql server se sigue leyendo por -n" "az sql server show -n acme-sql -g ACME -s 0f1e2d3c-1111-2222-3333-444455556666"
frena "T4m · en los grupos de az sql server, -s es el servidor" "az sql server firewall-rule create -s acme-sql -g ACME -n abrir --start-ip-address 1.2.3.4 --end-ip-address 1.2.3.4"
frena "T4n · la palabra server en otra posición no apaga el -s" "az sql db list -s acme-sql -g ACME --query server"
# 6.3 · T11 y T12: el borrado de un servidor o de una base de producción ya frenaba; se fija. La sentencia de borrado se
# arma por partes: escrita entera, el freno general corta el comando que corre esta suite.
frena "6.3 T11 · borrar el servidor de producción por -n" "az sql server delete -n acme-sql --yes"
frena "6.3 T11 · borrar una base del servidor de producción por --server" "az sql db delete --server $PROD -n base --yes"
pasa  "6.3 T11 · borrar un servidor declarado no-producción pasa" "az sql server delete -n acme-sql-staging --yes"
BORRA="DR""OP DATA""BASE"
for forma in "$BORRA" "$(printf '%s' "$BORRA" | tr '[:upper:]' '[:lower:]')" "Drop DataBase"; do
  frena "6.3 T12 · la sentencia de borrado de base contra producción (${forma%% *})" "sqlcmd -S $PROD -Q \"$forma base\""
done

# ── T6 · la puerta sólo en su forma canónica ──────────────────────────────────────────────────
# Sin esto, una lista negra de envoltorios deja pasar los cinco que la esquivan.
mundo
# la forma canónica exige poder mirar el shell de esta sesión: con snapshot se mira el
# snapshot; sin snapshot, el shell de login en vivo (eso lo prueba T30). Acá se siembra uno limpio
# para poder juzgar SÓLO la forma del comando.
snapshot "" ""
PUERTA="/opt/tycon/bin/tycon-prod-sql"
pasa  "T6a · la forma canónica pasa" "$PUERTA $PROD 'select 1'"
pasa  "T6b · canónica con --max-filas" "$PUERTA $PROD 'select 1' --max-filas 50"
# 6.4 · T10: `--locks` sola es una forma canónica (pasa al cuadro); con cualquier argumento más, se corta
pasa  "6.4 T10 · la puerta --locks sola pasa al cuadro" "$PUERTA --locks"
frena "6.4 T10 · la puerta --locks con un argumento se corta" "$PUERTA --locks acme-sql"
# 6.5 · T14: `--delete-group <grupo>` sola pasa al cuadro; con otro argumento se corta; `az group delete` directo, igual
pasa  "6.5 T14 · la puerta --delete-group <grupo> sola pasa al cuadro" "$PUERTA --delete-group acme-prueba-rg"
frena "6.5 T14 · la puerta --delete-group con otro argumento se corta" "$PUERTA --delete-group acme-prueba-rg --yes"
frena "6.5 T14 · la puerta --delete-group con un nombre que empieza con guion se corta" "$PUERTA --delete-group -x"
pasa  "6.5 T14 · un grupo con paréntesis, entre comillas simples, pasa al cuadro" "$PUERTA --delete-group 'acme(prueba)'"
frena "6.5 T14 · entre comillas dobles no es la forma canónica" "$PUERTA --delete-group \"acme(prueba)\""
# 6.3 · T12: la misma sentencia de borrado de base, por la puerta, pasa al cuadro como hoy (la ve una persona)
pasa  "6.3 T12 · la puerta con la sentencia de borrado de base pasa al cuadro" "$PUERTA $PROD '$BORRA base'"
frena "T6c · bash -c" "bash -c '$PUERTA $PROD \"select 1\"'"
frena "T6d · eval" "eval $PUERTA $PROD 'select 1'"
frena "T6e · nombre pelado" "tycon-prod-sql $PROD 'select 1'"
frena "T6f · env por delante" "env $PUERTA $PROD 'select 1'"
frena "T6g · xargs" "xargs -n1 $PUERTA"
frena "T6h · encadenado con cd" "cd /tmp && $PUERTA $PROD 'select 1'"
frena "T6i · con redirección" "$PUERTA $PROD 'select 1' > /tmp/x"
frena "T6j · sentencia por sustitución de comando" "$PUERTA $PROD \"\$(cat /tmp/x.sql)\""
frena "T6k · ruta partida con comillas" "/opt/tycon/bin/tycon-prod-sq\"\"l $PROD 'select 1'"

# ── T16 · secuestro de la puerta ──────────────────────────────────────────────────────────────
# Sin esto, no revisar el shell deja que una función `tycon-prod-sql` en el .zshrc se quede con la
# sentencia; y marcar cualquier alias que CONTENGA la palabra → falso positivo que apaga el control.
mundo; snapshot "" ""
pasa  "T16a · sin secuestro, la forma canónica pasa" "$PUERTA $PROD 'select 1'"
mundo; snapshot "tycon-prod-sql () { echo tomada }" ""
frena "T16b · función con el nombre de la puerta" "$PUERTA $PROD 'select 1'"
# 🔴 zsh vuelca los alias como `alias -- nombre=valor`. Sembrar `alias nombre=` sería un formato
# que zsh no emite nunca: pasaría en verde y la detección real quedaría muerta.
mundo; snapshot "" "alias -- tycon-prod-sql='otra cosa'"
frena "T16c · alias en el formato REAL de zsh (alias -- nombre=)" "$PUERTA $PROD 'select 1'"
mundo; snapshot "" "alias -- command='/tmp/x'"
frena "T16c2 · alias de command en el formato real" "$PUERTA $PROD 'select 1'"
mundo; snapshot "command () { : }" ""
frena "T16d · función command redefinida" "$PUERTA $PROD 'select 1'"
mundo; snapshot "which-command () { : }
open_command () { : }" "alias edit-command-line='x'"
pasa  "T16e · nombres que sólo CONTIENEN la palabra no disparan" "$PUERTA $PROD 'select 1'"
mundo; snapshot "" ""
frena "T16f · la función definida en el propio comando" "tycon-prod-sql() { :; }; $PUERTA $PROD 'select 1'"

# ── T31 · el snapshot de ESTA sesión, no el más nuevo ─────────────────────────────────────────
# Con 3 sesiones vivas, elegir «el más nuevo» le erra a 2 de 3. Los candidatos
# son los snapshots nacidos DESPUÉS del arranque de esta sesión; con más de uno se revisan todos
# (superconjunto = lado seguro). Elegir por fecha deja pasar.
mundo
snapshot "tycon-prod-sql () { echo tomada }" "" 1000000000000     # de OTRA sesión, anterior a la mía
snapshot "" "" 2000000000000                                      # el mío, limpio
DESDE=1500000000000
pasa "T31a · el secuestro de una sesión anterior no me frena" "$PUERTA $PROD 'select 1'"
mundo
snapshot "" "" 1000000000000                                      # anterior, limpio
snapshot "tycon-prod-sql () { echo tomada }" "" 2000000000000     # el mío, secuestrado
DESDE=1500000000000
frena "T31b · el secuestro en el snapshot de mi sesión sí frena" "$PUERTA $PROD 'select 1'"

DESDE=0

# ── T30 · sin snapshot: se le pregunta al shell de login en vivo ──────────────────────────────
# Claude Code 2.1.272 (extensión de VS Code) no escribe snapshot: corre cada comando como `zsh -c -l …`, sin sourcear
# nada. Frenar por «no hay snapshot» dejaría la puerta cerrada PARA SIEMPRE en esas sesiones (T30a frenaría).
# Lo que ESE shell define sí secuestra —un alias con la ruta absoluta como nombre se queda con la
# invocación canónica (zsh 5.9)— y lo lee de .zshenv/.zprofile/.zlogin y de lo que ellos sourceen:
# justo lo que el barrido estático de los rc no alcanza. ZDOTDIR/HOME apuntan a la casa falsa para
# que el shell vivo lea de ahí. Un snapshot ilegible frena.
ZD="ZDOTDIR=$TMP/casa"
mundo; printf 'esto no es un snapshot\n' > "$CASA/.claude/shell-snapshots/snapshot-zsh-1-aaaaaa.sh"
frena "T30b · snapshot que no parece un snapshot" "$PUERTA $PROD 'select 1'" $ZD SHELL=/bin/zsh
if [ -x /bin/zsh ]; then
  mundo   # sin ningún snapshot ni archivos de arranque: sesión de la extensión de VS Code, limpia
  pasa  "T30a · sin snapshot y shell de login limpio, la puerta pasa" "$PUERTA $PROD 'select 1'" $ZD SHELL=/bin/zsh
  # .zlogin no está en el barrido estático de los rc: sólo el shell vivo lo ve.
  mundo; printf 'tycon-prod-sql() { echo tomada; }\n' > "$CASA/.zlogin"
  frena "T30c · sin snapshot, una función en .zlogin frena" "$PUERTA $PROD 'select 1'" $ZD SHELL=/bin/zsh
  # el alias con la RUTA ABSOLUTA como nombre, en un archivo sourceado desde .zshenv (el barrido
  # estático lee .zshenv y ahí no hay nada)
  mundo; printf 'source "$ZDOTDIR/mas.zsh"\n' > "$CASA/.zshenv"; printf 'alias /opt/tycon/bin/tycon-prod-sql=/bin/echo\n' > "$CASA/mas.zsh"
  frena "T30d · sin snapshot, un alias con la ruta absoluta sourceado desde .zshenv frena" "$PUERTA $PROD 'select 1'" $ZD SHELL=/bin/zsh
  # el que hace la pregunta también puede estar tomado: la respuesta mentiría
  mundo; printf 'whence() { echo "$3: none"; }\n' > "$CASA/.zlogin"
  frena "T30e · sin snapshot, un whence redefinido frena" "$PUERTA $PROD 'select 1'" $ZD SHELL=/bin/zsh
  # un shell que no contesta no deja pasar, y tampoco cuelga al freno (su reloj: ~3 s de los 5)
  mundo; printf 'sleep 8\n' > "$CASA/.zlogin"
  t=$(date +%s)
  frena "T30f · sin snapshot, un shell de login que se cuelga frena" "$PUERTA $PROD 'select 1'" $ZD SHELL=/bin/zsh
  t=$(( $(date +%s) - t ))
  if [ "$t" -le 5 ]; then ok "T30f2 · y frena dentro del reloj propio (${t}s)"; else no "T30f2 · tardó ${t}s en frenar (tope 5)"; fi
else
  echo "⏭ prod-guard: sin /bin/zsh en esta máquina, T30a/c/d/e/f no se pueden medir (constancia, no verde)"
fi
# un shell que no sé leer → «no pude mirar», nunca verde
mundo
frena "T30g · sin snapshot y un shell que no sé leer (fish) frena" "$PUERTA $PROD 'select 1'" SHELL=/usr/local/bin/fish
# bash: la misma pregunta con `type -t`; .profile no está en el barrido estático de los rc
mundo
pasa  "T30h · sin snapshot, bash de login limpio pasa" "$PUERTA $PROD 'select 1'" SHELL=/bin/bash
mundo; printf 'tycon-prod-sql() { echo tomada; }\n' > "$CASA/.profile"
frena "T30i · sin snapshot, bash: una función en .profile frena" "$PUERTA $PROD 'select 1'" SHELL=/bin/bash

# ── T34 · lo escondido que NO se puede ver ────────────────────────────────────────────────────
# 🔴 Un tramo inofensivo del mismo comando NO compra permiso para el tramo opaco de al lado: el
# `sqlcmd -S localhost` se mira y se descarta, pero el `bash -c "$CMD"` sigue siendo invisible.
mundo
frena "T34a · un tramo inofensivo no tapa a uno opaco" 'sqlcmd -S localhost -Q "select 1"; bash -c "$CMD"'
frena "T34b · un intérprete con el texto en una variable de afuera" 'bcp x out y.dat; bash -c "$LO_QUE_SEA"'
pasa  "T34c · el mismo comando sin nada de bases pasa" 'bash -c "$CMD"'

# ── T17 · falla propia del hook, con y sin base ───────────────────────────────────────────────
# Sin esto, un `require` fuera del try, o sin reloj propio, rompe el hook y DEJA PASAR.
# La falla es real: una copia del freno a la que le faltan sus bibliotecas, y el `require` revienta
# adentro del try (la misma receta que el caso del banco `falla-real-del-freno-con-base-frena-y-anota`).
freno_roto(){ # deja en $TMP/roto una copia del freno sin sus bibliotecas, e imprime la ruta del hook
  local r="$TMP/roto"; rm -rf "$r"
  mkdir -p "$r/scripts/hooks" "$r/scripts/lib" "$r/scripts/production"
  cp "$HOOK" "$r/scripts/hooks/"
  cp "$AQUI/scripts/lib/repos-root.js" "$r/scripts/lib/"
  cp "$INDICE" "$r/scripts/production/"
  echo "$r/scripts/hooks/prod-access-guard.js"
}
mundo; ROTO="$(freno_roto)"
HOOK_USAR="$ROTO" frena "T17a · con el freno roto y una base nombrada, frena" "sqlcmd -S $PROD -Q \"select 1\""
if [ -s "$CASA/.claude/.tycon-pipeline/hook-errors.log" ]; then ok "T17a · la falla queda anotada en hook-errors.log"
else no "T17a · la falla no quedó anotada en hook-errors.log"; fi
HOOK_USAR="$ROTO" pasa "T17b · con el mismo freno roto y sin base, pasa" "git status"

# T17c · CADA cliente que el freno conoce, ante una falla propia, sale 2. Una lista del
# criterio de falla-cerrado escrita a mano podría no tener `tsql` ni `sqlpackage`.
mundo; ROTO="$(freno_roto)"
clientes="$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8"); const m=/const CLIENTES = \{([\s\S]*?)\};/.exec(s); console.log([...m[1].matchAll(/([\w-]+)\x27?\s*:/g)].map(x=>x[1]).join(" "))' "$HOOK")"
[ -n "$clientes" ] || no "T17c · no pude leer la lista de clientes del freno"
for cli in $clientes; do
  HOOK_USAR="$ROTO" frena "T17c · falla propia con «${cli}» frena" "${cli} -S $PROD"
done

# T17d · un comando GIGANTE con miles de `<<` que nombra producción: se frena sin parsearlo, y a
# tiempo. Parsear los heredocs tardaría ~17 s, el timeout del registro mataría el hook
# antes de frenar, y un timeout vencido DEJA PASAR el comando.
mundo
node -e 'const c="<<A\n".repeat(55000)+"\nsqlcmd -S '"$PROD"' -Q \"select 1\""; process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:c}}))' > "$TMP/gigante.json"
t0=$(date +%s)
env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 node "$HOOK" < "$TMP/gigante.json" >/dev/null 2>"$TMP/err"; rc=$?
dur=$(( $(date +%s) - t0 ))
if [ "$rc" = 2 ] && [ "$dur" -lt 5 ]; then ok "T17d · el comando gigante que nombra producción se frena en ${dur} s (antes del reloj)"
else no "T17d · rc=$rc en ${dur} s (esperaba 2 y menos de 5 s)"; fi

# T17e · un payload ILEGIBLE que nombra una base frena: si no, saldría 0 sin mirar el texto crudo
mundo
printf '{no es json sqlcmd -S %s' "$PROD" | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" node "$HOOK" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "T17e · un payload ilegible que nombra una base frena" || no "T17e · payload ilegible con base salió rc=$rc"
printf '{no es json, git status' | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" node "$HOOK" >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok "T17f · un payload ilegible sin bases deja pasar" || no "T17f · payload ilegible sin base salió rc=$rc"

# ── el freno lee los nombres como el shell (T17-T26) ─────────────────
# Caso que lo motiva: `rm -f …/production-{index,memory}.json` tiene que frenar. La tabla entera de formas vive en
# prod-guard-shell-forms.test.sh; acá van las pruebas con nombre, una por forma. Los nombres protegidos se arman por
# concatenación: el freno vivo frena un comando que los lleva enteros. «<P>» es la raíz del pipeline del HOME falso y «$R» un repo con su catálogo.
NI="production""-index.json"; NM="production""-memory.json"; CAT="production"".json"
P='~/.claude/.tycon-pipeline'
mundo; R="$REPOS/backend-acme"
regla_de_la_ultima(){ tail -n 1 "$CASA/.claude/.tycon-pipeline/frenos.jsonl" 2>/dev/null | sed -n 's/.*"regla":"\([^"]*\)".*/\1/p'; }

# T17 · mayúsculas: el disco de macOS no distingue y el shell toca el mismo archivo.
frena "8.14 T17a CaseInsensitive_ProtectedName_Blocks (Production-Index)" "rm -f $P/Production-Index.json"
frena "8.14 T17b CaseInsensitive_ProtectedName_Blocks (.Tycon/)" "rm -f $R/.Tycon/$CAT"

# T18 · comodín en la carpeta del catálogo.
frena "8.14 T18a WildcardFolder_Catalog_Blocks (.tyc*)" "rm -f $R/.tyc*/$CAT"
frena "8.14 T18b WildcardFolder_Catalog_Blocks (.tycon?)" "rm -f $R/.tycon?/$CAT"

# T19 · todas las redirecciones, leídas del tokenizador (no sólo la primera).
frena "8.14 T19a EveryRedirection_IsJudged (JQ1)" "jq '.x=1' /tmp/f.json 2>/dev/null > $P/$NI"
frena "8.14 T19b EveryRedirection_IsJudged (RD1)" "cat /dev/null 2>&1 > $P/$NI"
frena "8.14 T19c EveryRedirection_IsJudged (RD3)" "cat /dev/null >/tmp/lab814-b >$P/$NI"
frena "8.14 T19d EveryRedirection_IsJudged (RD7)" "cat /dev/null 2>/dev/null 1> $P/$NI"
frena "8.14 T19e EveryRedirection_IsJudged (comillas con >)" "grep \"a>b\" f > $P/$NI"
pasa  "8.14 T19f EveryRedirection_IsJudged (nada protegido)" "cmd 2>/dev/null > /tmp/x"

# T20 · la carpeta de trabajo: todas las formas de `cd`, no sólo `cd <una palabra>`.
frena "8.14 T20a WorkingDirectory_AllForms (cd -P)" "cd -P $R/.tycon && rm -f $CAT"
frena "8.14 T20b WorkingDirectory_AllForms (cd --)" "cd -- $R/.tycon && rm -f $CAT"
frena "8.14 T20c WorkingDirectory_AllForms (pushd)" "pushd $R/.tycon && rm -f $CAT"
frena "8.14 T20d WorkingDirectory_AllForms (chdir)" "chdir $R/.tycon && rm -f $CAT"
frena "8.14 T20e WorkingDirectory_AllForms (cd -)" "cd $R/.tycon; cd /; cd - && rm -f $CAT"
frena "8.14 T20f WorkingDirectory_AllForms (cd con comodín)" "cd $R/.tyc* && rm -f $CAT"
frena "8.14 T20g WorkingDirectory_AllForms (builtin cd)" "builtin cd $R/.tycon && rm -f $CAT"
frena "8.14 T20h WorkingDirectory_AllForms (git -C)" "git -C $R/.tycon rm -f $CAT"
frena "8.14 T20i WorkingDirectory_AllForms (cd a una variable sin resolver)" "cd \"\$X\" && rm -f $CAT"
CWD="$R/.tycon" frena "8.14 T20j WorkingDirectory_AllForms (cwd del payload)" "rm -f $CAT"
pasa  "8.14 T20k WorkingDirectory_AllForms (cd /tmp)" "cd /tmp && rm -f $CAT"

# T21 · xargs alimentado por cualquier segmento anterior del pipeline.
frena "8.14 T21a Xargs_AnyFeedingSegment_Blocks (X3)" "echo $P/$NI | xargs rm -f"
frena "8.14 T21b Xargs_AnyFeedingSegment_Blocks (X4)" "printf '%s\\n' $P/production-{index,memory}.json | xargs rm -f"
frena "8.14 T21c Xargs_AnyFeedingSegment_Blocks (X5)" "ls $P/ | grep production | xargs -I@ rm -f $P/@"
frena "8.14 T21d Xargs_AnyFeedingSegment_Blocks (X6)" "xargs rm -f <<< $P/$NI"
frena "8.14 T21e Xargs_AnyFeedingSegment_Blocks (FX1)" "find $P -name 'production-*' -print0 | xargs -0 rm -f"
frena "8.14 T21f Xargs_AnyFeedingSegment_Blocks (FX2)" "ls $P/production-* | xargs rm -f"
frena "8.14 T21g Xargs_AnyFeedingSegment_Blocks (FX8)" "grep -l . $P/*.json | xargs rm -f"
pasa  "8.14 T21h Xargs_AnyFeedingSegment_Blocks (cp a /tmp)" "ls | xargs -I{} cp {} /tmp/{}.bak"

# T22 · find recursivo desde una carpeta protegida o un ancestro.
frena "8.14 T22a Find_Recursive_FromProtectedOrAncestor (G7)" "find $P -name 'prod*' -delete"
frena "8.14 T22b Find_Recursive_FromProtectedOrAncestor (FX4)" "find ~/.claude -name '*-index.json' -delete"
frena "8.14 T22c Find_Recursive_FromProtectedOrAncestor (FX5)" "cd $R && find . -name '*.json' -delete"
frena "8.14 T22d Find_Recursive_FromProtectedOrAncestor (FX6)" "find $P -regex '.*index.*' -delete"
pasa  "8.14 T22e Find_Recursive_FromProtectedOrAncestor (N17 -exec cat)" "find $R/.tycon -type f -exec cat {} \\;"
pasa  "8.14 T22f Find_Recursive_FromProtectedOrAncestor (X10 llaves literales)" "find $P -name 'production-{index,memory}.json' -delete"
# una carpeta temporal SIN repos adentro: el /tmp de la máquina puede tener clones con `.tycon/` (una máquina puede tener varios), y
# ahí `find /tmp … -delete` sí borra catálogos — con más de 300 entradas en /tmp no se miraría y el caso pasaría sin querer
mkdir -p "$TMP/lab-tmp/a" "$TMP/lab-tmp/b"
pasa  "8.14 T22g Find_Recursive_FromProtectedOrAncestor (carpeta temporal sin repos)" "find $TMP/lab-tmp -name '*.json' -delete"
pasa  "8.14 T22h Find_Recursive_FromProtectedOrAncestor (-maxdepth 0)" "find ~/.claude -maxdepth 0 -name x -delete"

# T23 · una sustitución que nombra el alcance, como argumento de un escritor.
frena "8.14 T23a Substitution_NamingProtectedScope_Blocks (X9)" "rm -f \$(ls -d $P/* | grep -E 'production-(index|memory)')"
pasa  "8.14 T23b Substitution_NamingProtectedScope_Blocks (lista ajena)" "rm -f \$(cat /tmp/lista)"

# T24 · lo indecidible en alcance frena con su motivo y su regla, sin ensuciar hook-errors.log. Fuera del
# alcance, «no sé» no frena (nombres que no empiezan con production: ésos están en alcance en cualquier carpeta).
for caso in "rm -f $P/production-(index" "setopt extendedglob; rm -f $P/^STOP_AUTONOMY" "setopt braceccl; rm -f $P/production-{i}ndex.json"; do
  mundo
  rc="$(corre "$caso")"
  if [ "$rc" = 2 ] && grep -q "no sabe leer como el shell" "$TMP/err" && [ "$(regla_de_la_ultima)" = "nombre-indecidible" ] \
     && ! grep -q "prod-access-guard" "$CASA/.claude/.tycon-pipeline/hook-errors.log" 2>/dev/null; then
    ok "8.14 T24 Undecidable_InScope_Blocks («${caso:0:40}…»)"
  else
    no "8.14 T24 Undecidable_InScope_Blocks («${caso:0:40}…»): rc=$rc regla=$(regla_de_la_ultima) — err: $(grep -m1 Motivo "$TMP/err")"
  fi
done
mundo
pasa "8.14 T24 Undecidable_OutOfScope_Passes (/tmp)" "rm -f /tmp/foo-(index"
pasa "8.14 T24 Undecidable_OutOfScope_Passes (timing-history)" "rm -f $P/timing-history/foo-(index"
pasa "8.14 T24 Undecidable_OutOfScope_Passes (setopt, /tmp)" "setopt extendedglob; rm -f /tmp/^foo"
pasa "8.14 T24 Undecidable_OutOfScope_Passes (setopt, timing-history)" "setopt braceccl; rm -f $P/timing-history/foo-{i}ndex.json"

# T25 · el peor comando de ~32 KB se decide en menos de 1 s: palabras de 1.024 expansiones cada una fuera
# del alcance, y la escritura protegida al final. Con un tope por palabra, tardaría ~10 s y el reloj dejaría pasar.
mundo
for con in 1 0; do
  r25="$(CON="$con" LAB_HOME="$CASA" REPOS="$REPOS" HOOK="$HOOK" node -e '
    const { spawnSync } = require("child_process");
    let c = "touch"; let k = 0;
    // la escritura final pide más expansiones de las que quedan en el presupuesto: no se puede leer entera, y está en alcance
    const fin = process.env.CON === "1" ? "; rm -f ~/.claude/.tycon-pipeline/{x{0..2047},production-index}.json" : "";
    while (c.length < 32 * 1024 - 200) c += ` /tmp/t814-${k++}/a{0..1023}`;
    c += fin;
    const payload = JSON.stringify({ tool_name: "Bash", cwd: "/tmp", tool_input: { command: c } });
    const t = Date.now();
    const r = spawnSync("node", [process.env.HOOK], { input: payload, encoding: "utf8",
      env: { ...process.env, HOME: process.env.LAB_HOME, TYCON_REPOS_ROOT: process.env.REPOS, TYCON_PROD_SESSION_SINCE: "0" } });
    const indecidible = /no sabe leer como el shell/.test(r.stderr || "") ? "indecidible" : "otro";
    console.log(`${r.status} ${Date.now() - t} ${c.length} ${indecidible}`);')"
  set -- $r25
  # con la escritura, el presupuesto ya se agotó cuando llega: frena por «no lo pude leer a tiempo»
  esperado=$([ "$con" = 1 ] && echo "2 indecidible" || echo "0 otro")
  if [ "$1 $4" = "$esperado" ] && [ "$2" -lt 1000 ]; then ok "8.14 T25 ExpansionBudget_Worst32KB_UnderOneSecond (con escritura=$con: rc=$1 en $2 ms, $3 bytes)"
  else no "8.14 T25 ExpansionBudget_Worst32KB_UnderOneSecond (con escritura=$con: rc=$1 $4 en $2 ms, esperaba «${esperado}» y < 1000 ms)"; fi
done

# T26 · el motivo nombra el archivo que el shell iba a tocar y la palabra de donde sale; lo que no escribe pasa
mundo
rc="$(corre "rm -f $P/production-{index,memory}.json")"
if [ "$rc" = 2 ] && grep "Motivo:" "$TMP/err" | grep "$NI" >/dev/null && grep "Motivo:" "$TMP/err" | grep "{index,memory}" >/dev/null; then
  ok "8.14 T26a BlockMessage_NamesExpandedFile (R2: el archivo y la palabra)"
else no "8.14 T26a BlockMessage_NamesExpandedFile (R2: rc=$rc) — $(grep -m1 Motivo "$TMP/err")"; fi
rc="$(corre "rm -f $P/{production-index,production-memory}.json")"
if [ "$rc" = 2 ] && grep "Motivo:" "$TMP/err" | grep -e "$NI" -e "$NM" >/dev/null && ! grep -q "ESCRIBE sobre ~/.claude/.tycon-pipeline\.\?$" "$TMP/err"; then
  ok "8.14 T26b BlockMessage_NamesExpandedFile (L7 nombra el archivo, no la carpeta)"
else no "8.14 T26b BlockMessage_NamesExpandedFile (L7: rc=$rc) — $(grep -m1 Motivo "$TMP/err")"; fi
pasa "8.14 T26c NonWritersPass (N6: otros archivos de la raíz del pipeline)" "rm -f $P/{timing,active}-x.json"
pasa "8.14 T26d NonWritersPass (FP1: echo del nombre)" "echo $P/$NI"
pasa "8.14 T26e NonWritersPass (FP2: asignación y cat)" "F=$P/$NI; cat \"\$F\""

# Las sustituciones no rompen el partidor:
# (a) una `$(…)` sin comillas no pega el resto del comando en un solo segmento — si no, el `cd` se traga el `&& rm` y pasa;
# (b) una `"…$(cmd "x")…"` no se cierra en la primera comilla de adentro — si no, el freno frena un `echo` que no escribe.
frena "8.14 SubstitutionDoesNotGlueSegments (cd tras X=\$(…) y rm con comodín)" "X=\$(pwd); cd $P && rm -f *.json"
pasa  "8.14 QuotedSubstitutionWithQuotes_IsOneWord (echo con \$(ls -d \"…/.tycon\"))" "X=\$(pwd); git fetch -q origin && echo \"t=\$(ls -d \"\$D/.tycon\" 2>/dev/null && echo ok)\""

# ── casos de revisión ─────────────────────────────────────────────────
# Frena con la regla de lo indecidible, sin ensuciar hook-errors.log: «no lo pude mirar» no es una falla del freno.
frena_indecidible(){ local etiqueta="$1" cmd="$2"; shift 2
  local rc; rc="$(corre "$cmd" "$@")"
  if [ "$rc" = 2 ] && grep -q "no sabe leer como el shell" "$TMP/err" && [ "$(regla_de_la_ultima)" = "nombre-indecidible" ]; then ok "$etiqueta"
  else no "$etiqueta (rc=$rc regla=$(regla_de_la_ultima)) — err: $(grep -m1 Motivo "$TMP/err")"; fi
}
mundo
LAB="$TMP/lab-find"; rm -rf "$LAB"
mkdir -p "$LAB/few/a" "$LAB/few/b" "$LAB/few/c/.tycon" "$LAB/locked/repo/.tycon" "$LAB/x" "$LAB/huge"
i=1; while [ "$i" -le 301 ]; do mkdir -p "$LAB/many/d$i"; i=$((i+1)); done; mkdir -p "$LAB/many/d301/.tycon"
( cd "$LAB/huge" && seq 1 5001 | sed 's/^/d/' | xargs mkdir )

# (1) `find … -delete` desde una carpeta de repos: el repo número 301 se busca igual (un tope de 300 lo daría por «fuera
# de alcance» sin mirar); con más subcarpetas de las que se revisan, o sin permiso para leerla, NO se miró: indecidible.
# Sin esto, many, huge y locked saldrían 0.
frena "8.14 FindDelete_ReposFolder_FewChildren_Blocks (control)" "find $LAB/few -name '*.json' -delete"
frena "8.14 FindDelete_ReposFolder_Child301_Blocks" "find $LAB/many -name '*.json' -delete"
frena_indecidible "8.14 FindDelete_ReposFolder_TooManyChildren_IsUndecidable" "find $LAB/huge -name '*.json' -delete"
chmod 000 "$LAB/locked"
frena_indecidible "8.14 FindDelete_UnreadableFolder_IsUndecidable" "find $LAB/locked -name '*.json' -delete"
chmod 755 "$LAB/locked"
pasa "8.14 FindDelete_TooManyChildren_PatternCannotBeCatalog_Passes" "find $LAB/huge -name '*.log' -delete"
pasa "8.14 FindDelete_MissingFolder_Passes" "find $LAB/no-existe -name '*.json' -delete"

# (4a) Un comodín que NO empieza con punto no casa con un nombre que empieza con punto (sin dotglob/globdots): `*-*`
# no es la carpeta del pipeline; frenar «ESCRIBE sobre …/*-*» sería un falso positivo.
pasa "8.14 WildcardWithoutDot_IsNotHiddenFolder (rm *-*)" "rm -rf $LAB/x/*-*"
pasa "8.14 WildcardWithoutDot_IsNotHiddenFolder (\$A-\$B)" "rm -rf \"$LAB/x/\$A-\$B\""
pasa "8.14 WildcardWithoutDot_IsNotHiddenFolder (D=…; \$D/x/\$A-\$B)" "D=$LAB; rm -rf \"\$D/x/\$A-\$B\""
CWD="$R" pasa "8.14 WildcardWithoutDot_IsNotHiddenFolder (ls \$ID-* | xargs basename)" "ls .advisors/pipeline-runs/\$ID-* | xargs -n1 basename"
CWD="$R" pasa "8.14 WildcardWithoutDot_IsNotHiddenFolder (ls \$ID-* | xargs rm)" "ls .advisors/pipeline-runs/\$ID-* | xargs rm -f"
pasa "8.14 WildcardWithoutDot_IsNotHiddenFolder (~/.claude/*-*)" "rm -rf ~/.claude/*-*"
frena "8.14 WildcardWithDot_IsHiddenFolder (control .tycon-pipel*)" "rm -rf ~/.claude/.tycon-pipel*"
frena "8.14 WildcardWithDot_IsHiddenFolder (control .*)" "rm -rf ~/.claude/.*"
frena_indecidible "8.14 DotGlobOn_WildcardMayBeHiddenFolder (setopt globdots)" "setopt globdots; rm -rf ~/.claude/*-*"
frena_indecidible "8.14 DotGlobOn_WildcardMayBeHiddenFolder (GLOBIGNORE)" "GLOBIGNORE=x; rm -rf ~/.claude/*-*"

# (4b) Con la carpeta de trabajo en la raíz del pipeline: `sed` sin -i no escribe sus archivos, y lo que un intérprete
# recibe de una variable o sustitución sin resolver es dato de su programa (el programa calcula qué abre).
# Frenar «ESCRIBE sobre …/production-index.json (el shell arma ese nombre desde «"$F"»)» sería un falso positivo.
PIPE_CWD="$CASA/.claude/.tycon-pipeline"
CWD="$PIPE_CWD" pasa "8.14 InterpreterUnknownArg_Passes (F=\$(ls …) && python3 - \"\$F\")" "F=\$(ls -t runs/*/step-*.json | head -1) && python3 - \"\$F\" <<'PY'
import json, sys
print(len(json.load(open(sys.argv[1]))))
PY"
CWD="$PIPE_CWD" pasa "8.14 InterpreterUnknownArg_Passes (sustitución directa)" "python3 - \"\$(ls -t runs/*/step-*.json | head -1)\""
CWD="$PIPE_CWD" pasa "8.14 InterpreterUnknownArg_Passes (variable sin definir)" "python3 - \"\$F\""
CWD="$PIPE_CWD" pasa "8.14 SedWithoutInPlace_Passes (for con sed/cut)" "for f in a b; do sed -n 1p \"\$f\" | cut -d: -f1; done"
CWD="$PIPE_CWD" frena "8.14 SedInPlace_StillBlocks (control sed -i)" "sed -i.bak 1d $NI"
CWD="$PIPE_CWD" frena "8.14 SedScriptWrite_StillBlocks (control sed w)" "sed -n 'w $NI' /tmp/x"
CWD="$PIPE_CWD" frena "8.14 InterpreterLiteralArg_StillBlocks (control python3 x.py <nombre>)" "python3 x.py $NI"
CWD="$PIPE_CWD" frena "8.14 InterpreterArgFromNamingSubstitution_StillBlocks (control AC 13c)" "python3 - \"\$(ls $P/$NI)\""
# el motivo de un nombre sin resolver es el de lo indecidible: el shell no arma «production-index.json» desde «"$X"»
CWD="$PIPE_CWD" frena_indecidible "8.14 UnknownName_InScope_SaysUndecidable (rm \"\$X\" en la raíz)" "rm -f \"\$X\""

# (4c) `for x in <palabras>` no escribe sus palabras: se las da a la variable, y se juzgan donde se usan. Medido en un día
# de conversaciones: dos frenos «ESCRIBE sobre un nombre que arma una sustitución» eran bucles que sólo leían.
# 🔴 Falla con: juzgar las palabras del `for` como destinos de escritura (frenan los que leen), o perder sus valores en
#    la variable (un `rm "$f"` adentro deja de frenar).
pasa  "ForLoopWords_AreNotWrites (find de la carpeta, echo y wc)" "for f in \$(find ~/.claude/.tycon-pipeline -maxdepth 1 -name '*.json'); do echo \"\$f \$(wc -l <\$f)\"; done"
pasa  "ForLoopWords_AreNotWrites (ls de la carpeta, cat)" "for f in \$(ls $P/*.json); do cat \"\$f\"; done"
frena "ForLoopWords_GoToTheVariable (rm de lo que lista una sustitución)" "for f in \$(ls $P/*.json); do rm \"\$f\"; done"
frena "ForLoopWords_GoToTheVariable (rm de un comodín)" "for f in $P/*.json; do rm -f \"\$f\"; done"
frena "ForLoopWords_GoToTheVariable (cp encima de lo que encuentra find)" "for f in \$(find $P -name '*.json'); do cp /tmp/x \"\$f\"; done"
frena "ForLoopWords_GoToTheVariable (la variable copiada a otra)" "for f in $P/$NI; do g=\$f; rm \"\$g\"; done"

# (5b) `make -C<carpeta>` pegado y `make --directory=<carpeta>` fijan la carpeta de su segmento. Guarda: esta prueba fija
# ese comportamiento.
frena "8.14 MakeDirectory_Glued_SetsFolder (make -C<dir>)" "make -C$R/.tycon $CAT"
frena "8.14 MakeDirectory_Long_SetsFolder (make --directory=<dir>)" "make --directory=$R/.tycon $CAT"
pasa  "8.14 MakeDirectory_Glued_SetsFolder (control /tmp)" "make -C/tmp $CAT"

# ── casos del pase adversarial ──────────────────────────────────────────────
# Uno por clase con su número; los «control» son guardas de lo que tiene que seguir igual.
mundo; R="$REPOS/backend-acme"; PIPE_CWD="$CASA/.claude/.tycon-pipeline"
mkdir -p "$TMP/lab-tmp/a" "$TMP/lab-tmp/b"

# #1 (REGRESIÓN) · el texto que va A un shell se juzga: tubería a sh/bash/zsh, `source <(…)`, `bash <(…)`, `$(…)` como
# palabra de comando. El `echo` sigue siendo lector (FP1): lo que se juzga es el texto que corre el shell.
frena "8.14 #1 TextIntoShell_IsJudged (echo | bash)" "echo 'rm -f $P/$NI' | bash"
frena "8.14 #1 TextIntoShell_IsJudged (echo | sh)" "echo 'rm -f $P/$NI' | sh"
frena "8.14 #1 TextIntoShell_IsJudged (printf %s | zsh)" "printf 'rm -f %s\\n' $P/$NI | zsh"
frena "8.14 #1 TextIntoShell_IsJudged (echo | cat | sh)" "echo 'rm -f $P/$NI' | cat | sh"
frena "8.14 #1 TextIntoShell_IsJudged (source <(echo))" "source <(echo 'rm -f $P/$NI')"
frena "8.14 #1 TextIntoShell_IsJudged (bash <(echo))" "bash <(echo 'rm -f $P/$NI')"
frena "8.14 #1 TextIntoShell_IsJudged (. <(printf))" ". <(printf 'rm -f $P/$NI')"
frena "8.14 #1 TextIntoShell_IsJudged (bash < <(echo))" "bash < <(echo 'rm -f $P/$NI')"
frena "8.14 #1 TextIntoShell_IsJudged (bash <<< texto)" "bash <<< 'rm -f $P/$NI'"
frena "8.14 #1 TextIntoShell_IsJudged (\$(echo …) como comando)" "\$(echo rm -f $P/$NI)"
frena "8.14 #1 TextIntoShell_IsJudged (comilla invertida como comando)" "\`echo rm -f $P/$NI\`"
pasa  "8.14 #1 TextIntoShell_IsJudged (control: echo | sh a /tmp)" "echo 'rm -f /tmp/x' | sh"
pasa  "8.14 #1 TextIntoShell_IsJudged (control: echo del nombre | grep)" "echo $P/$NI | grep index"
pasa  "8.14 #1 TextIntoShell_IsJudged (control: \$(echo ls) como comando)" "\$(echo ls) $P/$NI"

# #3 (REGRESIÓN) · el valor por defecto de `\${X:-…}` / `\${X-…}` es uno de los valores posibles de la palabra.
frena "8.14 #3 ParameterDefault_IsAPossibleValue (\${F:-…} entre comillas)" "rm -f \"\${F:-$P/$NI}\""
frena "8.14 #3 ParameterDefault_IsAPossibleValue (\${F-…})" "rm -f \${F-$P/$NI}"
frena "8.14 #3 ParameterDefault_IsAPossibleValue (\${F:=…} en redirección)" "echo x > \${F:=$P/$NI}"
pasa  "8.14 #3 ParameterDefault_IsAPossibleValue (control: \${F:-/tmp/x})" "rm -f \"\${F:-/tmp/x}\""

# #5 (REGRESIÓN) · una variable que sale de una sustitución conserva el texto de esa sustitución, variable por variable.
frena "8.14 #5 VariableFromSubstitution_KeepsItsText (\$(…))" "F=\$(echo $P/$NI); rm -f \"\$F\""
frena "8.14 #5 VariableFromSubstitution_KeepsItsText (comilla invertida)" "F=\`echo $P/$NI\`; rm -f \$F"
frena "8.14 #5 VariableFromSubstitution_KeepsItsText (copiada a otra variable)" "F=\$(echo $P/$NI); G=\$F; rm -f \"\$G\""
pasa  "8.14 #5 VariableFromSubstitution_KeepsItsText (control: lista ajena)" "F=\$(cat /tmp/lista); rm -f \$F"

# #6 y #17 · `find` que alimenta a un `xargs` escritor baja a las subcarpetas como con -delete.
frena "8.14 #6 FindFeedingXargs_Descends (desde ~/.claude)" "find ~/.claude -name '*-index.json' | xargs rm -f"
frena "8.14 #6 FindFeedingXargs_Descends (-print0 | xargs -0)" "find ~/.claude -name '*.json' -print0 | xargs -0 rm -f"
CWD="$R" frena "8.14 #17 FindFeedingXargs_Descends (desde un repo)" "find . -name '$CAT' | xargs rm -f"
pasa  "8.14 #6 FindFeedingXargs_Descends (control: carpeta sin repos)" "find $TMP/lab-tmp -name '*.json' | xargs rm -f"
pasa  "8.14 #6 FindFeedingXargs_Descends (control: xargs lector)" "find ~/.claude -name '*-index.json' | xargs grep x"
CWD="$PIPE_CWD" pasa "8.14 #6 FindFeedingXargs_Descends (control: el . de find en la raíz no es la carpeta)" "find . -maxdepth 1 -name 'timing-*' | xargs rm -f"
frena "8.14 #6 FindFeedingXargs_Descends (control: la carpeta entera a rm -rf)" "find $P | xargs rm -rf"

# #8 (REGRESIÓN) · el texto del intérprete con banderas juntas, con sudo -E/env -i delante, y dentro de find -exec / xargs.
frena "8.14 #8 ShellScript_AnyFlagForm (bash -lc)" "bash -lc 'rm -f $P/production-{index,memory}.json'"
frena "8.14 #8 ShellScript_AnyFlagForm (bash -ec)" "bash -ec 'rm -f $P/production-{index,memory}.json'"
frena "8.14 #8 ShellScript_AnyFlagForm (zsh -fc)" "zsh -fc 'rm -f $P/production-{index,memory}.json'"
frena "8.14 #8 ShellScript_AnyFlagForm (sh -xc)" "sh -xc 'rm -f $P/production-{index,memory}.json'"
frena "8.14 #8 ShellScript_AnyFlagForm (bash -euo pipefail -c)" "bash -euo pipefail -c 'rm -f $P/production-{index,memory}.json'"
frena "8.14 #8 ShellScript_AnyFlagForm (sudo -E bash -c)" "sudo -E bash -c 'rm -f $P/production-{index,memory}.json'"
frena "8.14 #8 ShellScript_AnyFlagForm (env -i bash -c)" "env -i bash -c 'rm -f $P/production-{index,memory}.json'"
frena "8.14 #8 ShellScript_AnyFlagForm (find -exec sh -c)" "find /tmp -maxdepth 0 -exec sh -c 'rm -f $P/production-{index,memory}.json' \\;"
frena "8.14 #8 ShellScript_AnyFlagForm (xargs sh -c)" "echo | xargs sh -c 'rm -f $P/production-{index,memory}.json'"
pasa  "8.14 #8 ShellScript_AnyFlagForm (control: bash -lc a /tmp)" "bash -lc 'rm -f /tmp/{a,b}.json'"

# #9 (REGRESIÓN) · un texto de bash -c / zsh -c con variables se lee como shell, con las variables del comando.
frena "8.14 #9 ShellScriptWithVariables_IsRead (export n)" "export n=index; bash -c 'rm -f $P/production-\$n.json'"
frena "8.14 #9 ShellScriptWithVariables_IsRead (asignación adentro)" "bash -c 'X=production; rm -f $P/\${X}-index.json'"
frena "8.14 #9 ShellScriptWithVariables_IsRead (for adentro)" "zsh -c 'for f in index memory; do rm -f $P/production-\$f.json; done'"
frena "8.14 #9 ShellScriptWithVariables_IsRead (\"\$HOME\" y llaves)" "bash -c 'rm -f \"\$HOME\"/.claude/.tycon-pipeline/production-{index,memory}.json'"
pasa  "8.14 #9 ShellScriptWithVariables_IsRead (control: \$TMPDIR)" "bash -c 'rm -rf \"\${TMPDIR}/build-{a,b}\"'"

# #10 (REGRESIÓN) · el PUNTO DE PARTIDA de find también es un destino: `find <archivo> -delete` lo borra.
frena "8.14 #10 FindStartPoint_IsATarget (-delete)" "find $P/$NI -delete"
frena "8.14 #10 FindStartPoint_IsATarget (-maxdepth 0 -delete)" "find $P/$NI -maxdepth 0 -delete"
frena "8.14 #10 FindStartPoint_IsATarget (catálogo)" "find $R/.tycon/$CAT -delete"
frena "8.14 #10 FindStartPoint_IsATarget (-exec rm {})" "find $P/$NI -exec rm {} \\;"
frena "8.14 #10 FindStartPoint_IsATarget (llaves)" "find $P/production-{index,memory}.json -delete"
pasa  "8.14 #10 FindStartPoint_IsATarget (control: sin -delete)" "find $P/$NI -print"
pasa  "8.14 #10 FindStartPoint_IsATarget (control: el patrón no lo toma)" "find $P/$NI -name '*.log' -delete"

# #12 (REGRESIÓN) · en los argumentos del escritor de find -exec, `{}` dentro de una palabra vale `*` (como en xargs -I).
frena "8.14 #12 FindExecBraces_InsideAWord_IsWildcard (cp {} <P>/{})" "find . -name '$NI' -exec cp {} $P/{} \\;"
pasa  "8.14 #12 FindExecBraces_InsideAWord_IsWildcard (control: /tmp/{}.bak)" "find . -name x -exec cp {} /tmp/{}.bak \\;"
CWD="$PIPE_CWD" pasa "8.14 #12 FindExecBraces_InsideAWord_IsWildcard (control: {} solo en una subcarpeta)" "find timing-history -name '*.old' -exec rm {} \\;"

# #14 · un comando guardado en una variable del propio comando se vuelve a leer como comando (eval, bash -c).
frena "8.14 #14 CommandInVariable_IsReparsed (eval \"\$C\")" "C=\"rm -f $P/production-{index,memory}.json\"; eval \"\$C\""
frena "8.14 #14 CommandInVariable_IsReparsed (eval \$C)" "C=\"rm -f $P/production-{index,memory}.json\"; eval \$C"
frena "8.14 #14 CommandInVariable_IsReparsed (bash -c \"\$C\")" "C=\"rm -f $P/production-{index,memory}.json\"; bash -c \"\$C\""
pasa  "8.14 #14 CommandInVariable_IsReparsed (control: eval de algo ajeno)" "C=\"rm -f /tmp/{a,b}.json\"; eval \"\$C\""

# #16 · xargs alimentado por la tubería: detrás de una subshell o un grupo (depende del partidor: el segmento anterior
# conserva `sep: '|'`), por una sustitución de proceso, y por un `ls` que lista la carpeta de trabajo sin nombrarla.
frena "8.14 #16 XargsFeed_AllForms (| ( xargs ))" "ls $P/production-* | (xargs rm -f)"
frena "8.14 #16 XargsFeed_AllForms (| { xargs; })" "ls $P/production-* | { xargs rm -f; }"
frena "8.14 #16 XargsFeed_AllForms (< <(ls))" "xargs rm -f < <(ls $P/production-*)"
frena "8.14 #16 XargsFeed_AllForms (cd <P> && ls | grep | xargs)" "cd $P && ls | grep -v STOP | xargs rm -f"
frena "8.14 #16 XargsFeed_AllForms (cd .tycon && ls | xargs)" "cd $R/.tycon && ls | xargs rm -f"
pasa  "8.14 #16 XargsFeed_AllForms (control: cd /tmp && ls | xargs)" "cd /tmp && ls | xargs rm -f"

# #18 (REGRESIÓN) · las asignaciones de adelante de un programa que NO es lector se juzgan (FP2 sigue: asignación sola o
# delante de un lector).
frena "8.14 #18 PrefixAssignment_OfNonReader_IsJudged (OUT=… node)" "OUT=$P/$NI node /tmp/gen.js"
frena "8.14 #18 PrefixAssignment_OfNonReader_IsJudged (env OUT=… node)" "env OUT=$P/$NI node /tmp/gen.js"
pasa  "8.14 #18 PrefixAssignment_OfNonReader_IsJudged (control: OUT=/tmp/x node)" "OUT=/tmp/x node /tmp/gen.js"
pasa  "8.14 #18 PrefixAssignment_OfNonReader_IsJudged (control: delante de un lector)" "OUT=$P/$NI cat /tmp/x"
CWD="$PIPE_CWD" pasa "8.14 #18 PrefixAssignment_OfNonReader_IsJudged (control: valor sin resolver en la raíz)" "TMP=\$(mktemp) make"
CWD="$PIPE_CWD" pasa "8.14 #18 PrefixAssignment_OfNonReader_IsJudged (control: X=\$Y en la raíz)" "X=\$Y ./run.sh"

# #21 · el nombre del programa se resuelve con las variables del comando, y más prefijos no esconden xargs ni find.
frena "8.14 #21 ProgramName_ResolvedAndPrefixed (F=rm; \$F -rf <P>)" "F=rm; \$F -rf $P"
frena "8.14 #21 ProgramName_ResolvedAndPrefixed (stdbuf xargs)" "ls $P/production-* | stdbuf -oL xargs rm -f"
frena "8.14 #21 ProgramName_ResolvedAndPrefixed (caffeinate -i find)" "caffeinate -i find $P -name 'prod*' -delete"
pasa  "8.14 #21 ProgramName_ResolvedAndPrefixed (control: F=ls)" "F=ls; \$F -la $P"

# #22 · `git diff/log/show --output=<archivo>` escribe ese archivo.
frena "8.14 #22 GitOutput_Writes (git diff --output=)" "git diff --output=$P/$NI"
frena "8.14 #22 GitOutput_Writes (git log --output <archivo>)" "git log --output $P/$NI"
pasa  "8.14 #22 GitOutput_Writes (control: git diff -- <nombre>)" "git diff -- $P/$NI"

# #25 · los patrones de find se juntan con Y (salvo con -o): un negado no amplía lo que se borra.
pasa  "8.14 #25 FindPatterns_AreAnded (-not -path)" "find $R -name a.json -not -path '*/node_modules/*' -delete"
pasa  "8.14 #25 FindPatterns_AreAnded (! -name)" "find $R -name a.json ! -name b.json -delete"
pasa  "8.14 #25 FindPatterns_AreAnded (-type f -not -name)" "find $R -type f -name x.json -not -name '*.bak' -delete"
frena "8.14 #25 FindPatterns_AreAnded (control: *.json -not -path)" "find $R -name '*.json' -not -path '*/node_modules/*' -delete"
frena "8.14 #25 FindPatterns_AreAnded (control: -o)" "find $R -name a.json -o -name '*.json' -delete"
frena "8.14 #25 FindPatterns_AreAnded (control: grupo negado)" "find $R ! \\( -name a -o -name b \\) -delete"

# #28 · una reasignación seguida (detrás de `;`, fuera de ramas) REEMPLAZA el valor, como el shell; detrás de `&&` puede
# no correr y vale la unión (contrato del partidor: `applyAssignments(ctx, pp, { previousSep })`).
pasa  "8.14 #28 SequentialReassignment_Replaces (OUT=.tycon; …; OUT=build)" "OUT=$R/.tycon; ls \$OUT; OUT=build; rm -rf \$OUT/*"
pasa  "8.14 #28 SequentialReassignment_Replaces (D=<P>; …; D=/tmp/work)" "D=$P; ls \$D; D=/tmp/work; rm -rf \$D/*"
frena "8.14 #28 SequentialReassignment_Replaces (control: detrás de &&, la unión)" "D=$P; ls \$D; true && D=/tmp/work; rm -rf \$D/*"

# Tope de anidamiento: más de 6 niveles de lo que corre adentro (eval, sh -c, $(…), heredoc a
# un shell) no se leen; en alcance protegido eso es indecidible y frena, afuera pasa.
e7(){ local t="$1" i; for i in 1 2 3 4 5 6 7; do t="eval '$(printf '%s' "$t" | sed "s/'/'\\\\''/g")'"; done; printf '%s' "$t"; }
frena_indecidible "8.14 NestingLimit_InScope_IsUndecidable (eval ×7 sobre el índice)" "$(e7 "rm -f $P/$NI")"
frena_indecidible "8.14 NestingLimit_InScope_IsUndecidable (\$(…) ×7 sobre el índice)" "echo \$(echo \$(echo \$(echo \$(echo \$(echo \$(echo \$(rm -f $P/$NI)))))))"
pasa  "8.14 NestingLimit_OutOfScope_Passes (eval ×7 sobre /tmp)" "$(e7 "rm -f /tmp/x.json")"
pasa  "8.14 NestingLimit_OutOfScope_Passes (\$(…) ×7 sobre /tmp)" "echo \$(echo \$(echo \$(echo \$(echo \$(echo \$(echo \$(rm -f /tmp/x.json)))))))"

# Una subshell que el partidor no cortó queda como PALABRA (programa o argumento): `time -p ( … )`, `coproc p ( … )`. La red
# del freno no depende del partidor: en alcance es indecidible y frena; afuera pasa. Como el partidor
# corta estas dos formas, frenan por la lectura precisa; sin la red, un partidor que no las cortara dejaría rc 0.
frena "8.14 UncutSubshellWord_InScope_Blocks (time -p ( … ))" "time -p ( rm -f $P/production-{index,memory}.json )"
frena "8.14 UncutSubshellWord_InScope_Blocks (coproc p ( … ))" "coproc p ( rm -f $P/production-{index,memory}.json )"
pasa  "8.14 UncutSubshellWord_OutOfScope_Passes (time -p ( … ) sobre /tmp)" "time -p ( rm -f /tmp/{a,b}.json )"
pasa  "8.14 UncutSubshellWord_OutOfScope_Passes (coproc p ( … ) sobre /tmp)" "coproc p ( rm -f /tmp/{a,b}.json )"

# #30 · una palabra vacía no es la carpeta de trabajo.
CWD="$R/.tycon" pasa "8.14 #30 EmptyWord_IsNotTheWorkingDirectory (rm -f \"\")" "rm -f \"\""

# #40 · lo escondido (bash -c, eval) se juzga con la carpeta del momento en que corre, no con la del final.
frena "8.14 #40 HiddenText_UsesItsOwnWorkingDirectory (bash -c; cd /tmp)" "cd $P && bash -c 'rm -f *.json'; cd /tmp"
CWD="$PIPE_CWD" frena "8.14 #40 HiddenText_UsesItsOwnWorkingDirectory (sh -c; cd ..)" "sh -c 'rm -f *'; cd .."
frena "8.14 #40 HiddenText_UsesItsOwnWorkingDirectory (eval; cd ~)" "cd $P && eval 'rm -f p*'; cd ~"
pasa  "8.14 #40 HiddenText_UsesItsOwnWorkingDirectory (control: al revés)" "cd /tmp && bash -c 'rm -f *.json' ; cd $P"
frena "8.14 #40 HiddenText_UsesItsOwnWorkingDirectory (heredoc a bash; cd /tmp)" "cd $P && bash <<'EOF'
rm -f *.json
EOF
cd /tmp"
pasa  "8.14 #40 HiddenText_UsesItsOwnWorkingDirectory (control: heredoc al revés)" "cd /tmp && bash <<'EOF'
rm -f *.json
EOF
cd $P"

# #41 · el motivo de una escritura cita la palabra del comando: eso no la vuelve una falla del freno.
mundo
rc="$(corre "python3 -c \"import os; print('no pude abrir'); os.remove('$CASA/.claude/.tycon-pipeline/$NI')\"")"
if [ "$rc" = 2 ] && [ "$(regla_de_la_ultima)" = "produccion" ] && ! grep -q "prod-access-guard" "$CASA/.claude/.tycon-pipeline/hook-errors.log" 2>/dev/null; then
  ok "8.14 #41 WriteReasonQuotingWords_IsNotAGuardFailure"
else no "8.14 #41 WriteReasonQuotingWords_IsNotAGuardFailure (rc=$rc regla=$(regla_de_la_ultima))"; fi

# #42 · un heredoc a un archivo con el mismo texto que un bash -c posterior no esconde al bash -c.
frena "8.14 #42 SameTextHeredocAndShell_ShellIsJudged" "cat > /tmp/notas.txt <<'EOF'
rm -f $P/production-{index,memory}.json
EOF
bash -c 'rm -f $P/production-{index,memory}.json'"

# El programa de python o node que llega por un heredoc se juzga como el de `python3 -c`: si nombra el índice, el
# catálogo o la memoria, frena. Lo que sólo se guarda en un archivo sigue siendo contenido.
frena "HeredocDePrograma_EscribeElIndice_Frena (python3 -)" "python3 - <<'EOF'
import os
open(os.path.expanduser('$P/$NI'),'w').write('{}')
EOF"
frena "HeredocDePrograma_EscribeElIndice_Frena (node, en un cd)" "cd /tmp && node <<'EOF'
require('fs').writeFileSync(require('os').homedir() + '/.claude/.tycon-pipeline/$NM', '{}')
EOF"
frena "HeredocDePrograma_EscribeElIndice_Frena (del otro lado de un caño)" "cat <<'EOF' | python3
open('/x/.tycon/$CAT','w').write('{}')
EOF"
frena "HeredocDePrograma_EscribeElIndice_Frena (con argumentos)" "f=a.md && python3 - \"\$f\" <<'EOF'
import sys, os; os.remove(os.path.expanduser('$P/$NI'))
EOF"
pasa  "HeredocDePrograma_SinNombreProtegido_Pasa" "python3 - <<'EOF'
print('hola')
EOF"
pasa  "HeredocDePrograma_AUnArchivo_EsContenido_Pasa" "cat > /tmp/notas.py <<'EOF'
open('$NI').read()
EOF"
# Las otras formas de darle el programa por la entrada: el here-string, los envoltorios (`/usr/bin/env`, `time -p`,
# `arch`, `stdbuf`, `uv run`), un subshell o un grupo, la línea continuada, el intérprete en otra línea del caño, el
# segundo heredoc de una línea y otros intérpretes (bun, deno, pypy3, osascript).
PROG="open(__import__('os').path.expanduser('$P/$NI'),'w').write('{}')"
frena "ProgramaPorEntrada_HereString_Frena" "python3 <<< \"$PROG\""
frena "ProgramaPorEntrada_HereStringConGuion_Frena" "python3 - <<<'$PROG'"
for envoltorio in "/usr/bin/env python3 -" "time -p python3 -" "arch -arm64 python3 -" "caffeinate -i python3 -" "stdbuf -o0 python3 -" "uv run python -" "bun -" "pypy3 -" "deno run -" "osascript -l JavaScript"; do
  frena "ProgramaPorEntrada_Envoltorio_Frena ($envoltorio)" "$envoltorio <<'EOF'
$PROG
EOF"
done
frena "ProgramaPorEntrada_Subshell_Frena" "(python3 - <<'EOF'
$PROG
EOF
)"
frena "ProgramaPorEntrada_Grupo_Frena" "{ python3 - <<'EOF'
$PROG
EOF
}"
frena "ProgramaPorEntrada_LineaContinuada_Frena" "python3 - \\
<<'EOF'
$PROG
EOF"
frena "ProgramaPorEntrada_IntérpreteEnOtraLíneaDelCaño_Frena" "cat <<'EOF' |
$PROG
EOF
python3"
frena "ProgramaPorEntrada_SegundoHeredocDeLaLínea_Frena" "cat <<'A' >/dev/null; python3 - <<'B'
nada
A
$PROG
B"
frena "ProgramaPorEntrada_DentroDeBashC_Frena" "bash -c \"python3 - <<<'$PROG'\""
# Lo que el heredoc le da a otro comando, o a un programa que vive en un archivo, es dato.
pasa  "ProgramaPorEntrada_OtroComandoDeLaLínea_Pasa" "python3 -V; cat > notas.md <<'EOF'
el $NI se regenera solo
EOF"
pasa  "ProgramaPorEntrada_ProgramaEnUnArchivo_EsDato_Pasa" "node tool.js <<'EOF'
{\"archivo\":\"$NI\"}
EOF"
pasa  "ProgramaPorEntrada_ConMenosC_LaEntradaEsDato_Pasa" "python3 -c 'import sys; print(sys.stdin.read())' <<'EOF'
el $NI
EOF"

# ── 6.1.1 · el contenido de un archivo que el comando escribe y no ejecuta no se juzga ─────────
# El cuerpo que sólo se guarda en un archivo no se lee buscando servidores ni el Llavero: `const server = …` en código
# cumple la cadena de conexión `Server=` y, sin esto, frena. Lo que se ejecuta sigue frenando.
mundo
pasa  "6.1.1 T1 HeredocAArchivo_ConstServer_Pasa" "cat > server.js <<'EOF'
const http = require('http');
const server = http.createServer((req, res) => res.end('ok'));
server.listen(3000);
EOF"
pasa  "6.1.1 T2 TeeHeredoc_ConstServer_Pasa" "tee server.js >/dev/null <<EOF
const server = http.createServer(h);
EOF"
pasa  "6.1.1 T3 HeredocAJson_CadenaDeConexion_Pasa" "cat > app.json <<'EOF'
{\"cs\": \"Server=$PROD;Database=x\"}
EOF"
frena "6.1.1 T4 BashHeredoc_Sqlcmd_Frena" "bash <<'EOF'
sqlcmd -S $PROD -Q \"select 1\"
EOF"
frena "6.1.1 T5 PythonHeredoc_CadenaDeConexion_Frena" "python3 <<'EOF'
import pyodbc; pyodbc.connect('Server=$PROD;Database=x')
EOF"
frena "6.1.1 T6 SqlcmdDirecto_Frena" "sqlcmd -S $PROD -Q \"select 1\""
frena "6.1.1 T7 EscriboYCorroConNode_Frena" "cat > x.js <<'EOF'
const cs = 'Server=$PROD;Database=x';
EOF
node x.js"
frena "6.1.1 T8 DestinoNoLiteral_Frena" "cat > \"\$F\" <<'EOF'
sqlcmd -S $PROD -Q \"select 1\"
EOF
bash \"\$F\""
pasa  "6.1.1 T9 HeredocAArchivo_Llavero_Pasa" "cat > notas.md <<'EOF'
La contraseña vive en el Llavero: security find-generic-password -s tycon-prod-acme -w
EOF"
t10_falta=""
grep -q "Lo que el comando \*\*sólo escribe\*\* a un archivo y no corre" "$AQUI/guides/produccion-con-permiso.md" 2>/dev/null || t10_falta="$t10_falta la guía;"
grep -q "El contenido de un archivo que el comando escribe y no corre no se juzga" "$AQUI/guides/maintaining/piezas-en-detalle.md" 2>/dev/null || t10_falta="$t10_falta el detalle de la pieza;"
if [ -z "$t10_falta" ]; then ok "6.1.1 T10 Guide_DeclaresFileContentIsNotJudged"
else no "6.1.1 T10 Guide_DeclaresFileContentIsNotJudged — no lo dice:$t10_falta"; fi
# Caminos por los que el contenido escrito se ejecuta en el mismo comando: por la entrada, por un envoltorio, por una
# sustitución, tras un `cd` o desde un archivo de arranque. Todos frenan.
CUERPO_SQL="sqlcmd -S $PROD -Q \"select 1\""
frena "6.1.1 T11 EscriboYCorroPorEntrada_Frena (bash < x)" "cat > /tmp/x.sh <<'EOF'
$CUERPO_SQL
EOF
bash < /tmp/x.sh"
frena "6.1.1 T11 EscriboYCorroPorEntrada_Frena (cat x | bash)" "cat > /tmp/x.sh <<'EOF'
$CUERPO_SQL
EOF
cat /tmp/x.sh | bash"
frena "6.1.1 T12 TeeASustitucion_Frena" "tee >(bash) <<'EOF'
$CUERPO_SQL
EOF"
frena "6.1.1 T13 CdYRutaRelativa_Frena" "cat > /tmp/x.sh <<'EOF'
$CUERPO_SQL
EOF
cd /tmp && bash x.sh"
frena "6.1.1 T14 OtrosEjecutores_Frena (npx tsx)" "cat > q.ts <<'EOF'
const cs = 'Server=$PROD;Database=x';
EOF
npx tsx q.ts"
frena "6.1.1 T14 OtrosEjecutores_Frena (python3)" "cat > x.py <<'EOF'
cs = 'Server=$PROD;Database=x'
EOF
python3 x.py"
frena "6.1.1 T15 SqlcmdPorEntrada_Frena" "sqlcmd <<'EOF'
:connect $PROD
select 1
EOF"
frena "6.1.1 T16 AnexarAUnArchivoOculto_Frena" "cat >> ~/.zshrc <<'EOF'
$CUERPO_SQL
EOF"
frena "6.1.1 T17 ComandoMixto_FrenaPorElShell" "cat > notas.md <<'EOF'
const server = http.createServer(h);
EOF
bash <<'EOF2'
$CUERPO_SQL
EOF2"
# T18 · cada rama de rechazo de la lista cerrada, con un cuerpo que nombra producción
# stable-data: no crea commits ni repos; `.git/hooks` es sólo una carpeta oculta de prueba que el freno no lee
mkdir -p "$TMP/t18/.git/hooks" "$TMP/t18/b"; : > "$TMP/t18/viejo.sh"; ln -sf "$TMP/t18/.git/hooks/pre-commit" "$TMP/t18/enlace"
t18(){ frena "6.1.1 T18 RamasDeRechazo_Frenan ($1)" "$2
$CUERPO_SQL
EOF"; }
t18 'PATH= antes'          "mkdir -p $TMP/t18/b; PATH=$TMP/t18/b:\$PATH; cat > $TMP/t18/b/ls <<'EOF'"
t18 '>&archivo oculto'     "cat > $TMP/t18/ok >&$TMP/t18/.git/hooks/x <<'EOF'"
t18 'a>archivo oculto'     "cat <<'EOF' >$TMP/t18/ok a>$TMP/t18/.git/hooks/x"
t18 'echo a un oculto'     "echo x > ~/.zshrc; cat > $TMP/t18/ok <<'EOF'"
t18 'sustitución \$(…)'    "cat > $TMP/t18/\$(echo ok) <<'EOF'"
t18 'tee -a'               "tee -a $TMP/t18/ok <<'EOF'"
t18 'comodín'              "cat > $TMP/t18/o* <<'EOF'"
t18 '/dev/fd'              "cat > /dev/fd/3 <<'EOF'"
t18 'carpeta .git/hooks'   "cat > $TMP/t18/.git/hooks/pre-commit <<'EOF'"
t18 'enlace'               "cat > $TMP/t18/enlace <<'EOF'"
t18 'guion existente'      "cat > $TMP/t18/viejo.sh <<'EOF'"
t18 'sudo'                 "sudo cat > $TMP/t18/ok <<'EOF'"
t18 'Makefile nuevo'       "cat > $TMP/t18/Makefile <<'EOF'"
t18 'guion .sh nuevo'      "cat > $TMP/t18/nuevo.sh <<'EOF'"
t18 '~otro usuario'        "cat > ~root/x <<'EOF'"
mkdir -p "$TMP/t18/bucle"; ln -sf "$TMP/t18/bucle/a" "$TMP/t18/bucle/b"; ln -sf "$TMP/t18/bucle/b" "$TMP/t18/bucle/a"
t18 'enlace en bucle'      "cat > $TMP/t18/bucle/a/x <<'EOF'"
mkdir -p "$TMP/t18/real/sub"; ln -sf "$TMP/t18/.git/hooks" "$TMP/t18/real/enlace-a-hooks"
t18 'carpeta nueva bajo un enlace' "mkdir -p $TMP/t18/real/enlace-a-hooks/nueva; cat > $TMP/t18/real/enlace-a-hooks/nueva/x <<'EOF'"
t18 'MAKEFILE en mayúsculas' "cat > $TMP/t18/MAKEFILE <<'EOF'"
t18 '~/library en minúsculas' "mkdir -p ~/library/LaunchAgents; cat > ~/library/LaunchAgents/x.plist <<'EOF'"
t18 'chmod al lado'        "chmod +x $TMP/t18/sin-ext; cat > $TMP/t18/sin-ext <<'EOF'"
ln -sf "$TMP/t18/no-existe/hooks" "$TMP/t18/roto"
t18 'carpeta enlace roto'  "cat > $TMP/t18/roto/x <<'EOF'"
frena "6.1.1 T18 RamasDeRechazo_Frenan (cuerpo sin comillas con \$(…): el shell lo ejecuta)" "cat > $TMP/t18/ok <<EOF
\$(security find-generic-password -s tycon-prod-acme -w)
EOF"
frena "6.1.1 T18 RamasDeRechazo_Frenan (cuerpo sin comillas con comillas invertidas)" "cat > $TMP/t18/ok <<EOF
\`$CUERPO_SQL\`
EOF"
pasa  "6.1.1 T18 RamasDeRechazo_Frenan (control: el mismo \$(…) con el delimitador entre comillas)" "cat > $TMP/t18/ok2 <<'EOF'
\$(security find-generic-password -s tycon-prod-acme -w)
EOF"
frena "6.1.1 T18 RamasDeRechazo_Frenan (delimitador <<\\EOF: el shell cierra antes y corre lo que sigue)" "cat > $TMP/t18/ok <<\\EOF
hola
EOF
security find-generic-password -s tycon-prod-acme -w
\\EOF"
frena "6.1.1 T18 RamasDeRechazo_Frenan (delimitador <<E\"OF\")" "cat > $TMP/t18/ok <<E\"OF\"
hola
EOF
$CUERPO_SQL
E"
WITHOUT_CWD=1 frena "6.1.1 T18 RamasDeRechazo_Frenan (relativa sin carpeta del evento)" "cat > notas-sin-carpeta.md <<'EOF'
$CUERPO_SQL
EOF"
pasa  "6.1.1 T18 RamasDeRechazo_Frenan (control: lo mismo a un archivo nuevo)" "cat > $TMP/t18/nuevo.js <<'EOF'
$CUERPO_SQL
EOF"

# T27 · el criterio crudo NO cambia: `CRUDO` decide la caída del freno, el tope de 32 KB, la red
# de lo opaco y lo que measure-guard cuenta como falso positivo; su copia `nombra_bases()` vive en node-shim.sh. Se compara
# con el de un commit fijo (`REF`) veredicto por veredicto sobre las 119 filas y los comandos del banco 40; si
# ese commit no está en el clon (un clon superficial), contra su huella fijada acá. Ampliarlo frenaría comandos
# reales que no tocan nada.
t27="$(REPO_ROOT="$AQUI" node - <<'JS'
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const { spawnSync } = require('child_process');
const ROOT = process.env.REPO_ROOT; const REF = '6e01463';
const HUELLA_CRUDO = '66fceabd7e5f83b141a2b4bbd22211129159ccd116a2e4e70e31c2016591cdb3';
const HUELLA_SHIM = 'b3251a743f5a0300dde442b73858c80877f99778734fc7c294ace2ee888ae9bc';
const trozos = (src) => [/const CLIENTES = \{[\s\S]*?\n\};/, /const VARIABLES_SERVIDOR = \[[^\]]*\];/, /const escRe = [^\n]*;/,
  /const CRUDO = new RegExp\([\s\S]*?'i'\);/].map((re) => { const m = re.exec(src); if (!m) throw new Error(`sin ${re}`); return m[0]; }).join('\n');
const criterio = (src) => new Function(`${trozos(src)}\nreturn CRUDO;`)();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const shim = (src) => { const m = /nombra_bases\(\)\s*\{[\s\S]*?\n\}/.exec(src); return m ? m[0] : ''; };
const hoy = fs.readFileSync(path.join(ROOT, 'scripts/hooks/prod-access-guard.js'), 'utf8');
const shimHoy = fs.readFileSync(path.join(ROOT, 'scripts/production/node-shim.sh'), 'utf8');
const refHook = spawnSync('git', ['-C', ROOT, 'show', `${REF}:scripts/hooks/prod-access-guard.js`], { encoding: 'utf8' });
const refShim = spawnSync('git', ['-C', ROOT, 'show', `${REF}:scripts/production/node-shim.sh`], { encoding: 'utf8' });
const mal = [];
// los comandos: las 119 filas (con nombres de ejemplo) y los del banco 40
const nombres = (s) => String(s).replace(/@NI@/g, 'production' + '-index').replace(/@NM@/g, 'production' + '-memory')
  .replace(/@OI@/g, 'produccion' + '-indice').replace(/@OM@/g, 'produccion' + '-memoria')
  .replace(/@CAT@/g, 'production' + '.json').replace(/@OCAT@/g, 'produccion' + '.json')
  .replace(/<P>/g, '~/.claude/.tycon-pipeline').replace(/<R>/g, '/r');
const cmds = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/tests/fixtures/prod-guard-shell-forms.json'), 'utf8')).rows.map((f) => nombres(f.cmd));
for (const h of JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/controls-bench/cases/hooks/40-prod-access-guard.json'), 'utf8')).hooks) {
  for (const c of h.cases) {
    let j = c.stdin; if (typeof j === 'string') { try { j = JSON.parse(j); } catch { j = null; } }
    if (j && j.tool_input && j.tool_input.command) cmds.push(j.tool_input.command);
  }
}
const A = criterio(hoy);
let via;
if (refHook.status === 0) {
  via = REF;
  const B = criterio(refHook.stdout);
  for (const c of cmds) if (A.test(c) !== B.test(c)) mal.push(`veredicto distinto: «${c.slice(0, 60)}»`);
} else {
  via = 'huella fijada';
  if (sha(trozos(hoy)) !== HUELLA_CRUDO) mal.push('CRUDO cambió (huella distinta)');
}
const shimRef = refShim.status === 0 ? sha(shim(refShim.stdout)) : HUELLA_SHIM;
if (!shim(shimHoy) || sha(shim(shimHoy)) !== shimRef) mal.push('nombra_bases() de node-shim.sh cambió');
console.log(mal.length ? `NO ${mal.join(' · ')}` : `OK ${cmds.length} comandos contra ${via}`);
JS
)"
case "$t27" in
  OK*) ok "8.14 T27 BasesCriterion_Unchanged (${t27#OK })" ;;
  *)   no "8.14 T27 BasesCriterion_Unchanged — ${t27#NO }" ;;
esac

# ── Agujeros y frenos falsos del freno de producción ─────────────────────────────────────────────────────────────────────────────
# Cada caso que pasa a frenar trae al lado uno parecido e inofensivo que sigue pasando.
mundo
# Delimitador raro: con `<<\EOF` o `<<E"OF"` el shell cierra en `EOF`, y lo que sigue hasta `\EOF` (o `E`) se EJECUTA.
# El freno buscaba el cierre en el delimitador tal como está escrito y trataba ese tramo como cuerpo. (Con el nombre
# de un servidor de producción a la vista ya frenaba por el texto crudo; el agujero es lo que no lo nombra.)
# 🔴 Falla con: el cierre buscado en el delimitador escrito y no en el que usa el shell.
frena "G1 DelimitadorRaro_LoQueSigueAlCierreSeJuzga (<<\\EOF)" "cat <<\\EOF
hola
EOF
rm -f $P/$NI
\\EOF"
frena "G1 DelimitadorRaro_LoQueSigueAlCierreSeJuzga (<<E\"OF\")" "cat <<E\"OF\"
hola
EOF
rm -f $P/$NI
E"
frena "G1 DelimitadorRaro_LoQueSigueAlCierreSeJuzga (<<'E'OF)" "cat <<'E'OF
hola
EOF
sqlcmd -S \"\$H\" -Q \"select 1\"
E"
frena "G1 DelimitadorRaro_CuerpoQueAlimentaUnShell_Frena" "bash <<\\EOF
$CUERPO_SQL
EOF"
pasa  "G1 DelimitadorRaro_NotaAUnArchivo_Pasa" "cat > notas.md <<\\EOF
$CUERPO_SQL
EOF"
# `<<$'E\x4fF'` cierra en `EOF` (bash decodifica la palabra), y `<<EO\` con `F` en la línea siguiente también: bash
# junta las dos líneas. Lo que sigue a ese cierre se ejecuta.
# 🔴 Falla con: la palabra `$'…'` sin decodificar, o la continuación de línea leída como el fin de la palabra.
frena "G1 DelimitadorAnsiC_LoQueSigueAlCierreSeJuzga" "cat <<\$'E\\x4fF'
hola
EOF
rm -f $P/$NI
E\\x4fF"
frena "G1 DelimitadorPartido_LoQueSigueAlCierreSeJuzga" "cat <<EO\\
F
hola
EOF
rm -f $P/$NI
EO"
pasa  "G1 DelimitadorAnsiC_NotaAUnArchivo_Pasa" "cat > notas.md <<\$'EOF'
$CUERPO_SQL
EOF"
# Un `node -e` o un guion con una variable `server` de código no es una cadena de conexión: el texto se ejecuta, pero
# `server = http.createServer(…)` no nombra ninguna base.
# 🔴 Falla con: la regla de cadenas de conexión leyendo la llamada a una función como el nombre de un servidor.
pasa  "G1 NodeE_VariableServer_Pasa" "node -e 'const http=require(\"http\"); const server = http.createServer(()=>{}); server.listen(0, ()=>server.close())'"
printf 'const http = require("http");\nconst server = http.createServer(() => {});\nserver.listen(0, () => server.close());\n' > "$TMP/servidor.js"
pasa  "G1 GuionConVariableServer_Pasa" "node $TMP/servidor.js"
frena "G1 NodeE_CadenaDeConexion_Frena" "node -e 'const cs = \"Server=$PROD;Database=x\"'"
# `Server=$(…)` es una sustitución del shell, no la llamada de un programa: el servidor no se sabe y sigue frenando.
# 🔴 Falla con: `$(` aceptado como el nombre de una función.
frena "G1 ServidorPorSustitucion_Frena" "node -e 'cs=\"Server=\$(cat /tmp/h);Database=x\"'"
# `sqlcmd -s '|'`: la `-s` minúscula es el separador de columnas; el servidor es la `-S` mayúscula.
# 🔴 Falla con: las banderas de sqlcmd comparadas sin distinguir mayúsculas.
pasa  "G1 SqlcmdSeparador_Pasa" "sqlcmd -S localhost -s '|' -Q \"select 1\""
frena "G1 SqlcmdSeparadorContraProduccion_Frena" "sqlcmd -S $PROD -s '|' -Q \"select 1\""
frena "G1 SqlcmdSeparadorAntesDelServidor_Frena" "sqlcmd -s '|' -S $PROD -Q \"select 1\""
frena "G1 InvokeSqlcmdSinDistinguir_SigueFrenando" "pwsh -c 'Invoke-Sqlcmd -serverinstance \$h -Query \"select 1\"'"
# La carpeta de estado del arnés: borrarla esconde a la vez el estado de las reglas y el registro de producción.
# 🔴 Falla con: sólo los archivos de la carpeta protegidos, y no la carpeta entera.
frena "G1 CarpetaDeEstado_Borrarla_Frena" "rm -rf ~/.tycon/state"
frena "G1 CarpetaDeEstado_Moverla_Frena" "mv ~/.tycon/state /tmp/estado-viejo"
frena "G1 CarpetaDeEstado_ConComodin_Frena" "rm -rf ~/.tycon/sta*"
pasa  "G1 CarpetaDeEstado_Crearla_Pasa" "mkdir -p ~/.tycon/state"
pasa  "G1 CarpetaDeEstado_Listarla_Pasa" "ls ~/.tycon/state"
pasa  "G1 OtraCarpetaState_Pasa" "rm -rf build/state"
pasa  "G1 SubcarpetaDelEstado_Pasa" "rm -rf ~/.tycon/state/tmp-lab"
# Copiarla la lee, no la pierde: un respaldo o una copia para mirarla pasan.
# 🔴 Falla con: la carpeta del estado tratada como cualquier carpeta protegida (cp y rsync también escriben).
pasa  "G1 CarpetaDeEstado_Copiarla_Pasa" "cp -r ~/.tycon/state /tmp/estado-copia"
pasa  "G1 CarpetaDeEstado_Rsync_Pasa" "rsync -a ~/.tycon/state/ /tmp/estado-copia/"
# Vaciarla de una vez es perderla igual. Borrar algo de adentro, con su nombre o con un filtro, sigue pasando.
# 🔴 Falla con: sólo la carpeta por su nombre, y no su contenido entero.
frena "G1 CarpetaDeEstado_VaciarlaConComodin_Frena" "rm -rf ~/.tycon/state/*"
frena "G1 CarpetaDeEstado_VaciarlaConFind_Frena" "find ~/.tycon/state -delete"
pasa  "G1 CarpetaDeEstado_BorrarConFiltro_Pasa" "find ~/.tycon/state -name '*.tmp' -delete"
pasa  "G1 CarpetaDeEstado_BorrarUnaCosa_Pasa" "rm -rf ~/.tycon/state/active/viejo.json"
pasa  "G1 CarpetaDeEstado_ListarConComodin_Pasa" "ls ~/.tycon/state/*"
pasa  "G1 CarpetaDeEstado_CopiarConComodin_Pasa" "cp -r ~/.tycon/state/* /tmp/estado-copia/"

# ── 6.6 · el cuadro muestra la consulta: el archivo ya no pasa, la consulta en línea tiene tope ─────────────────────────
# El cuadro de aprobación muestra el comando y nada más: lo que el freno escribe aparece después.
# Por eso `--file` se frena, con el comando en línea listo cuando se puede armar, y la consulta en línea tiene un tope de
# renglones (el cuadro corta el principio sin aviso) y una lista de caracteres que engañan.
mundo
snapshot "" ""
mkdir -p "$TMP/q"
printf 'select top 3 Id,\n       Nombre\nfrom Articulos\n' > "$TMP/q/consulta.sql"
H66="$(shasum -a 256 "$TMP/q/consulta.sql" | cut -d' ' -f1)"
mkdir -p "$TMP/q/con espacio"; cp "$TMP/q/consulta.sql" "$TMP/q/con espacio/c.sql"

# T1 · toda invocación con --file sale 2, sin systemMessage; las formas raras, sin comando listo
t1(){ local etiqueta="$1" cmd="$2" listo="$3" rc; rc="$(corre "$cmd")"
  if [ "$rc" = 2 ] && ! grep -q systemMessage "$TMP/out" && grep -q "no muestra el contenido de un archivo" "$TMP/err" \
     && { [ "$listo" = si ] && grep -qF "$PUERTA $PROD 'select top 3" "$TMP/err" || { [ "$listo" = no ] && ! grep -qF "$PUERTA $PROD '" "$TMP/err"; }; }; then
    ok "6.6 T1 Guard_File_AlwaysBlocks · $etiqueta"
  else no "6.6 T1 Guard_File_AlwaysBlocks · $etiqueta (rc=$rc) — err: $(head -c 200 "$TMP/err")"; fi; }
t1 "huella buena" "$PUERTA $PROD --file $TMP/q/consulta.sql --sha256 $H66" si
t1 "huella vieja" "$PUERTA $PROD --file $TMP/q/consulta.sql --sha256 0000000000000000000000000000000000000000000000000000000000000000" si
t1 "sin huella" "$PUERTA $PROD --file $TMP/q/consulta.sql" si
t1 "con --max-filas" "$PUERTA $PROD --file $TMP/q/consulta.sql --sha256 $H66 --max-filas 7" si
grep -qF -- "--max-filas 7" "$TMP/err" && ok "6.6 T1 Guard_File_AlwaysBlocks · el comando listo conserva --max-filas" || no "6.6 T1 · el comando listo perdió --max-filas — err: $(head -c 200 "$TMP/err")"
t1 "ruta con espacios" "$PUERTA $PROD --file '$TMP/q/con espacio/c.sql' --sha256 $H66" no
t1 "--file antes del host" "$PUERTA --file $TMP/q/consulta.sql $PROD" no
t1 "--file=<ruta>" "$PUERTA $PROD --file=$TMP/q/consulta.sql" no

# T2 · el comando listo, con lo que el shell interpreta, es canónico para el freno
printf "select 'a''b' as x,\t\"c\" -- \$(id) \\\\ # ; | fin\nfrom T where n = 'it''s'\n-- tercera\n" > "$TMP/q/raro.sql"
rc="$(corre "$PUERTA $PROD --file $TMP/q/raro.sql")"
LISTO="$(grep -F "$PUERTA $PROD '" "$TMP/err" | head -1 | sed 's/^ *//')"
# el comando puede ocupar varios renglones del mensaje: se toma desde su primera línea hasta la comilla de cierre
LISTO="$(node -e '
  const t = require("fs").readFileSync(process.argv[1], "utf8"); const i = t.indexOf(process.argv[2]);
  if (i < 0) process.exit(1);
  const resto = t.slice(i); const m = /^\S+ \S+ (?:\x27(?:[^\x27]|\x27\\\x27\x27)*\x27)(?: --max-filas \d+)?/.exec(resto);
  if (!m) process.exit(1); process.stdout.write(m[0]);' "$TMP/err" "$PUERTA $PROD '")" || LISTO=""
if [ "$rc" = 2 ] && [ -n "$LISTO" ]; then
  rc2="$(corre "$LISTO")"
  if [ "$rc2" = 0 ]; then ok "6.6 T2 Guard_File_GivesInlineCommand · el comando listo pasa al cuadro como forma canónica"
  else no "6.6 T2 Guard_File_GivesInlineCommand · el comando listo no es canónico (rc=$rc2) — err: $(head -c 200 "$TMP/err")"; fi
  printf '%s' "$LISTO" > "$TMP/q/listo.cmd"
else no "6.6 T2 Guard_File_GivesInlineCommand · no trajo el comando (rc=$rc) — err: $(head -c 300 "$TMP/err")"; fi

# T4 · el archivo que no pasa las reglas no trae comando: el motivo, y nunca el contenido del protegido
mkdir -p "$TMP/q/carpeta"; ln -sf "$TMP/q/consulta.sql" "$TMP/q/enlace.sql"
head -c 66560 /dev/zero | tr '\0' 'a' > "$TMP/q/grande.sql"
printf 'select \377\376 1\n' > "$TMP/q/binario.sql"
printf 'select 1 \033[2J\n' > "$TMP/q/ansi.sql"
printf 'select 1 \302\233 x\n' > "$TMP/q/c1.sql"
printf 'select 1 \342\200\213 x\n' > "$TMP/q/invisible.sql"
for _ in $(seq 21); do echo 'select 1'; done > "$TMP/q/largo.sql"
: > "$TMP/q/vacio.sql"
printf -- '-i /tmp/x.sql\n' > "$TMP/q/guion.sql"
printf 'select 1\nGO\nselect 2\n' > "$TMP/q/go.sql"
printf 'select 1\n:r /etc/passwd\n' > "$TMP/q/r.sql"
printf '{"servers":[{"host":"SECRETO-DEL-CATALOGO"}]}' > "$TMP/q/production.json"
# lo que no es una consulta no se lee para el asistente: otra extensión, o una carpeta oculta en el camino
printf 'SECRETO-DEL-CATALOGO\n' > "$TMP/q/credenciales"; printf 'SECRETO-DEL-CATALOGO\n' > "$TMP/q/clave.txt"
mkdir -p "$TMP/q/.oculta"; printf 'select 1 -- SECRETO-DEL-CATALOGO\n' > "$TMP/q/.oculta/c.sql"
for caso in "carpeta:archivo común" "enlace.sql:enlace" "grande.sql:mide" "binario.sql:UTF-8" "ansi.sql:control" "c1.sql:control" \
            "invisible.sql:invisible" "largo.sql:partila" "vacio.sql:vacía" "guion.sql:«-»" "go.sql:GO" "r.sql:comando del cliente" \
            "production.json:protegido" "credenciales:.sql" "clave.txt:.sql" ".oculta/c.sql:carpeta oculta"; do
  f="${caso%%:*}"; motivo="${caso#*:}"
  rc="$(corre "$PUERTA $PROD --file $TMP/q/$f --sha256 $H66")"
  if [ "$rc" = 2 ] && grep -qF -- "$motivo" "$TMP/err" && ! grep -qF "$PUERTA $PROD '" "$TMP/err" && ! grep -q "SECRETO-DEL-CATALOGO" "$TMP/err"; then
    ok "6.6 T4 Guard_File_BadFile_NoCommandWithReason · $f"
  else no "6.6 T4 Guard_File_BadFile_NoCommandWithReason · $f (rc=$rc, esperaba «${motivo}») — err: $(head -c 200 "$TMP/err")"; fi
done

# T5 · justo 20 renglones de pantalla, contando el prefijo, pasa al cuadro (también con tabuladores)
veinte="$(for i in $(seq 19); do echo "select $i"; done)"
pasa "6.6 T5 Guard_Inline_UnderCap_Asks · 20 renglones" "$PUERTA $PROD '$veinte
fin'"
# el primer renglón lleva el prefijo de la puerta (62 columnas): ahí 8 tabuladores ocuparían dos
tabs="$(for i in $(seq 19); do printf 'a\t\t\t\t\t\t\t\tb\n'; done)"   # 8 tabuladores: 65 columnas, un renglón cada uno
pasa "6.6 T5 Guard_Inline_UnderCap_Asks · 20 renglones con tabuladores" "$PUERTA $PROD 'select 1
${tabs}fin'"

# T6 · más de 20 renglones de pantalla sale 2 y dice cuántos
sobre(){ local etiqueta="$1" cmd="$2" rc; rc="$(corre "$cmd")"
  if [ "$rc" = 2 ] && grep -qE "ocupa [0-9]+" "$TMP/err" && grep -q "partí la consulta" "$TMP/err"; then ok "6.6 T6 Guard_Inline_OverCap_Blocks · $etiqueta"
  else no "6.6 T6 Guard_Inline_OverCap_Blocks · $etiqueta (rc=$rc) — err: $(head -c 200 "$TMP/err")"; fi; }
sobre "21 renglones" "$PUERTA $PROD '$veinte
x
fin'"
sobre "un renglón de 1600 caracteres" "$PUERTA $PROD 'select $(head -c 1600 /dev/zero | tr '\0' 'a')'"
sobre "20 renglones con 10 tabuladores" "$PUERTA $PROD '$(for i in $(seq 20); do printf 'a\t\t\t\t\t\t\t\t\t\tb\n'; done)'"
sobre "20 renglones de 40 anchos" "$PUERTA $PROD '$(for i in $(seq 20); do for j in $(seq 40); do printf '漢'; done; echo; done)'"
# los anchos que no están en las tablas de siempre (Tangut, kana suplementaria) también cuentan 2
sobre "20 renglones de 40 Tangut" "$PUERTA $PROD '$(for i in $(seq 20); do for j in $(seq 40); do printf '\360\227\200\200'; done; echo; done)'"
sobre "20 renglones de 40 kana suplementaria" "$PUERTA $PROD '$(for i in $(seq 20); do for j in $(seq 40); do printf '\360\233\200\200'; done; echo; done)'"
# un ancho que no entra en la última columna baja entero al renglón siguiente: ese hueco también cuenta
diecisiete="$(for i in $(seq 16); do echo "select $i"; done)"
corte="$(head -c 75 /dev/zero | tr '\0' 'a')漢$(head -c 75 /dev/zero | tr '\0' 'a')"
sobre "un ancho en la última columna" "$PUERTA $PROD 'select 1
$diecisiete
$corte
fin'"
# lo que el shell ignora al final también llega al cuadro: se cuenta
cola="$(for i in $(seq 40); do echo; done; echo x)"; cola="${cola%x}"
sobre "20 renglones y 40 saltos al final" "$PUERTA $PROD '$veinte
fin'$cola"
sobre "20 renglones de 40 letras con acento combinante" "$PUERTA $PROD '$(for i in $(seq 20); do for j in $(seq 40); do printf 'e\314\201'; done; echo; done)'"

# T7 · caracteres que engañan en la consulta en línea: sale 2 con el motivo, sin el carácter en el mensaje
for raro in '\033[2J' '\r' '\302\233' '\302\255' '\330\234' '\342\200\256' '\342\200\213' '\357\270\217' '\363\240\201\201'; do
  c="$(printf "$raro")"
  rc="$(corre "$PUERTA $PROD 'select 1 ${c} x'")"
  if [ "$rc" = 2 ] && grep -qE "control|invisible" "$TMP/err" && ! grep -qF "$c" "$TMP/err"; then ok "6.6 T7 Guard_Inline_DeceivingChars_Block · $raro"
  else no "6.6 T7 Guard_Inline_DeceivingChars_Block · $raro (rc=$rc) — err: $(head -c 200 "$TMP/err")"; fi
done
# los de formato que también se ven como nada (Mongolia, jemer, U+2065, U+206A-206F, relleno de media anchura, objeto)
for raro in '\341\240\213' '\341\236\264' '\342\201\245' '\342\201\252' '\357\276\240' '\357\277\274'; do
  c="$(printf "$raro")"
  rc="$(corre "$PUERTA $PROD 'select 1 ${c} x'")"
  if [ "$rc" = 2 ] && grep -q "invisible" "$TMP/err"; then ok "6.6 T7 Guard_Inline_DeceivingChars_Block · $raro"
  else no "6.6 T7 Guard_Inline_DeceivingChars_Block · $raro (rc=$rc) — err: $(head -c 200 "$TMP/err")"; fi
done
# en las puntas del comando, fuera de las comillas: el freno no las recorta antes de mirar
for raro in '\r' '\013' '\014' '\357\273\277' '\342\200\250'; do
  rc="$(corre "$PUERTA $PROD 'select 1'$(printf "$raro")")"
  if [ "$rc" = 2 ] && grep -qE "control|invisible" "$TMP/err"; then ok "6.6 T7 Guard_Inline_DeceivingChars_Block · $raro al final del comando"
  else no "6.6 T7 Guard_Inline_DeceivingChars_Block · $raro al final del comando (rc=$rc) — err: $(head -c 200 "$TMP/err")"; fi
done
# un sustituto suelto: UTF-16 roto en el JSON, que no llega como carácter de reemplazo
payload="$(CMD="$PUERTA $PROD 'select 1 @@ x'" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:"/tmp",tool_input:{command:process.env.CMD}}).replace("@@","\\ud800"))')"
printf '%s' "$payload" | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 node "$HOOK" >"$TMP/out" 2>"$TMP/err"; rc=$?
if [ "$rc" = 2 ] && grep -q "UTF-8" "$TMP/err"; then ok "6.6 T7 Guard_Inline_DeceivingChars_Block · sustituto suelto"
else no "6.6 T7 Guard_Inline_DeceivingChars_Block · sustituto suelto (rc=$rc) — err: $(head -c 200 "$TMP/err")"; fi
# UTF-8 inválido: llega al freno como un carácter de reemplazo (los bytes malos no sobreviven al JSON)
rc="$(corre "$PUERTA $PROD 'select 1 $(printf '\357\277\275') x'")"
if [ "$rc" = 2 ] && grep -q "UTF-8" "$TMP/err"; then ok "6.6 T7 Guard_Inline_DeceivingChars_Block · UTF-8 inválido"
else no "6.6 T7 Guard_Inline_DeceivingChars_Block · UTF-8 inválido (rc=$rc) — err: $(head -c 200 "$TMP/err")"; fi

# T8 · las otras formas no cambian; Codex sigue cortado, con o sin --file
pasa "6.6 T8 Guard_OtherForms_Unchanged · --reclasificar" "$PUERTA --reclasificar $PROD"
pasa "6.6 T8 Guard_OtherForms_Unchanged · --verificar" "$PUERTA --verificar"
pasa "6.6 T8 Guard_OtherForms_Unchanged · --cargar-clave" "$PUERTA --cargar-clave $PROD"
pasa "6.6 T8 Guard_OtherForms_Unchanged · --open-firewall" "$PUERTA --open-firewall $PROD"
pasa "6.6 T8 Guard_OtherForms_Unchanged · --close-firewall" "$PUERTA --close-firewall $PROD"
pasa "6.6 T8 Guard_OtherForms_Unchanged · --locks" "$PUERTA --locks"
pasa "6.6 T8 Guard_OtherForms_Unchanged · --delete-group" "$PUERTA --delete-group acme-prueba-rg"
codex(){ local cmd="$1" payload; payload="$(CMD="$cmd" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",turn_id:"t1",cwd:"/tmp",tool_input:{command:process.env.CMD}}))')"
  printf '%s' "$payload" | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 node "$HOOK" >"$TMP/out" 2>"$TMP/err"; echo $?; }
for cmd in "$PUERTA $PROD 'select 1'" "$PUERTA $PROD --file $TMP/q/consulta.sql --sha256 $H66" "$PUERTA $PROD --file $TMP/q/consulta.sql" "$PUERTA --file $TMP/q/consulta.sql $PROD"; do
  rc="$(codex "$cmd")"
  if [ "$rc" = 2 ]; then ok "6.6 T8 Guard_OtherForms_Unchanged · Codex sale 2 («${cmd#* * }»)"
  else no "6.6 T8 Guard_OtherForms_Unchanged · Codex no se cortó (rc=$rc)"; fi
done

# T13 · la guía no ofrece --file y dice el tope
if [ -f "$GUIA" ] && ! grep -qF -- "--file" "$GUIA" && grep -q "20 renglones" "$GUIA"; then ok "6.6 T13 Guide_NoFileForm · la guía no ofrece --file y dice el tope"
else no "6.6 T13 Guide_NoFileForm · la guía todavía ofrece --file o no dice el tope de 20 renglones"; fi

# ── T32 · la guía declara la cortesía de la regla de firewall ─────────────────────────
if [ -f "$GUIA" ] && grep -qi "cortes" "$GUIA" && grep -qi "firewall" "$GUIA"; then
  ok "T32 · la guía dice que la regla de firewall es de cortesía"
else
  no "T32 · la guía no declara que la regla de firewall es de cortesía (y que el control es el hook)"
fi

# ── T33 Guide_DeclaresShellFormsAndLimits — la guía dice qué lee el freno y qué no ──────────────
# Las formas que el freno lee como el shell, la medición y los cinco límites: sin esto, el que lee la guía
# cree que el freno cubre más (o menos) de lo que cubre.
t33_falta=""
if [ -f "$GUIA" ]; then
  grep -q "Los nombres se leen como los lee el shell" "$GUIA" || t33_falta="$t33_falta la sección de las formas;"
  for forma in "Llaves y rangos" "Formas de zsh" "Opciones del shell" "Variables, modificadores y arreglos" "Mayúsculas" \
               "Todas las redirecciones" "La carpeta de trabajo" "xargs" "find" "Sustituciones"; do
    grep -qF -- "$forma" "$GUIA" || t33_falta="${t33_falta} la forma «${forma}»;"
  done
  grep -q "119 formas" "$GUIA" && grep -q "65 no hacían" "$GUIA" || t33_falta="$t33_falta la medición (119 formas, 65 mal);"
  for limite in "calcula sin que su texto esté a la vista" "corrido después con un shell" "desde más arriba" \
                "Hasta que cada máquina reinstala" "criterio de emergencia"; do
    grep -qF -- "$limite" "$GUIA" || t33_falta="${t33_falta} el límite «${limite}»;"
  done
else
  t33_falta=" la guía no existe ($GUIA);"
fi
if [ -z "$t33_falta" ]; then ok "8.14 T33 Guide_DeclaresShellFormsAndLimits (las formas, la medición y los cinco límites)"
else no "8.14 T33 Guide_DeclaresShellFormsAndLimits — falta:$t33_falta"; fi

echo "— prod-guard: $pasaron ok, $fallos fallos —"
[ "$fallos" -eq 0 ]
