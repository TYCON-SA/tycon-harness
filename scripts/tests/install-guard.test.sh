#!/usr/bin/env bash
# install-guard.test.sh — red del lint del catálogo de producción y del instalador del freno
# («Producción con permiso»).
#
# Caso que lo motiva: si en una sesión se autoriza UNA consulta a producción, el asistente puede correr ~9 más
# sin pedir permiso y abrir una regla de firewall
# que queda viva. La regla existe en la memoria del asistente y no alcanza: un control que hay que
# acordarse de invocar es un control que no corre.
#
# Qué prueba este archivo:
#   T11 — una declaración `.tycon/production.json` con una clave de más NO entra (lista blanca).
#   T19 — el instalador es idempotente, fusiona sin pisar lo de la organización, deja respaldo,
#         y falla si /opt/tycon existe con otro dueño.
#   T32 — en una máquina con una versión BAJADA, el aviso de arranque juzga el freno contra esa versión y contra la
#         constancia que deja el instalador, no contra el clon que la máquina mantiene: recién instalado es «al día»,
#         tras una versión nueva «quedó viejo», y una biblioteca retocada en /opt sigue siendo «alguien lo cambió».
#   T34 — con el permiso guardado vencido y el repo público, el instalador sigue sin él y lo dice.
#   T33 — el freno usa SÓLO el intérprete de root (/opt/tycon/bin/node): si falta, tiene otro dueño
#         o su huella no coincide, un comando que nombra una base sale 2 (y uno que no, pasa). Si el freno no
#         contesta a tiempo o se cae, sale 2 cualquier comando; el reloj cubre todo el lanzador, el intérprete se
#         verifica por sus datos, y con la máquina cargada el lanzador contesta con margen bajo el tope (T33g–T33s).
#
# 🔴 Nada acá toca el sistema de verdad: raíz de sistema falsa, HOME falso, `sudo` doblado.
#    Lección: sin esto, una prueba nueva puede leer la config REAL de la
#    máquina y empujar datos a un repo de verdad.
#
# Correr: bash scripts/tests/install-guard.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LINT="$AQUI/scripts/production/lint-production-json.js"
INSTALADOR="$AQUI/scripts/production/install-guard.sh"
SHIM="$AQUI/scripts/production/node-shim.sh"
HOOK_GLOBAL="$AQUI/scripts/hooks/git-pre-commit-global.sh"
TMP="$(mktemp -d)"
# La carga de T33s se apaga siempre al salir, también si la suite se corta a mitad.
CARGA_PIDS=""
matar_arbol(){ local c; for c in $(pgrep -P "$1" 2>/dev/null); do matar_arbol "$c"; done; kill -9 "$1" 2>/dev/null; }
apagar_carga(){ local p; for p in $CARGA_PIDS; do matar_arbol "$p"; wait "$p" 2>/dev/null; done; CARGA_PIDS=""; }
trap 'apagar_carga; rm -rf "$TMP"' EXIT
source "$AQUI/scripts/tests/lib/fake-home.sh"
fallos=0; pasaron=0
# La foto del registro REAL antes de empezar: T33g exige que al final valga lo mismo.
REAL_LOG_0="${HOME}/.claude/.tycon-pipeline/production.log"
ANTES_REAL=0; [ -f "$REAL_LOG_0" ] && ANTES_REAL="$(wc -l < "$REAL_LOG_0" | tr -d ' ')"
# los datos de un archivo como los anota el instalador: dueño, permisos, tamaño, fecha e inode (GNU en el nocturno, BSD en la Mac)
datos_de(){ stat -c '%u %a %s %Y %i' "$1" 2>/dev/null || stat -f '%u %Lp %z %m %i' "$1" 2>/dev/null; }
datos_json(){ set -- $(datos_de "$1"); printf '{"uid": %s, "mode": "%s", "size": %s, "mtime": %s, "inode": %s}' "$1" "$2" "$3" "$4" "$5"; }
# mide N vueltas del lanzador con node (spawnSync espera a que se cierren los caños de salida, como Claude Code):
# imprime «mediana máximo» en ms, y deja los códigos distintos de todas las vueltas en $TMP/medido-rc y el stderr de la
# última en $TMP/medido-err.
# stable-data: lee el reloj para medir cuánto tarda el lanzador; ninguna fecha entra en lo que se compara.
medir(){ # $1 = vueltas · $2 = evento JSON · el ambiente se hereda
  node -e 'const {spawnSync}=require("child_process"); const fs=require("fs"); const [n,ev,shim,tmp]=process.argv.slice(1);
    const ms=[], rcs=new Set(); let r; for (let i=0;i<+n;i++){ const t=Date.now(); r=spawnSync("bash",[shim],{input:ev,encoding:"utf8"}); ms.push(Date.now()-t); rcs.add(String(r.status)); }
    fs.writeFileSync(tmp+"/medido-rc", [...rcs].join(" ")); fs.writeFileSync(tmp+"/medido-err", r.stderr||"");
    ms.sort((a,b)=>a-b); console.log(ms[Math.floor((ms.length-1)/2)], ms[ms.length-1]);' "$1" "$2" "$SHIM" "$TMP"; }
ok(){ echo "✅ instalar-freno: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ instalar-freno: $1"; fallos=$((fallos+1)); }

# ── T11 · la declaración con una clave de más no entra ────────────────────────────────────────
# Sin lint (o con lista NEGRA en vez de blanca), `usuario` pasa y la contraseña del
# proyecto termina versionada en el repo del cliente.
declara(){ # $1 = json  → deja el archivo en un repo git (CON migraciones) con el archivo STAGEADO
  rm -rf "$TMP/r"; mkdir -p "$TMP/r/.tycon" "$TMP/r/database"
  printf '%s' "$1" > "$TMP/r/.tycon/production.json"
  ( cd "$TMP/r" && git init -q . && git add .tycon/production.json ) >/dev/null 2>&1
}

if [ ! -f "$LINT" ]; then
  no "T11 · el lint no existe todavía ($LINT)"
else
  BUENO='{"servers":[{"host":"acme-sql.database.windows.net","environment":"produccion","keychain":"tycon-prod-acme"},{"host":"acme-test.example.com","environment":"no-produccion"}]}'
  declara "$BUENO"
  if node "$LINT" --staged --repo "$TMP/r" >/dev/null 2>&1; then ok "T11a · la declaración válida pasa"
  else no "T11a · la declaración válida fue rechazada"; fi

  for clave in usuario password; do
    declara "{\"servers\":[{\"host\":\"x.database.windows.net\",\"environment\":\"produccion\",\"keychain\":\"tycon-prod-x\",\"$clave\":\"lo-que-sea\"}]}"
    salida="$(node "$LINT" --staged --repo "$TMP/r" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$salida" | grep "$clave" >/dev/null; then ok "T11b · la clave de más «${clave}» rechaza el archivo y la nombra"
    else no "T11b · «${clave}» no fue rechazada (rc=$rc) — salida: $(printf '%s' "$salida" | head -1)"; fi
  done

  declara '{"servers":[{"host":"x.database.windows.net","environment":"prod"}]}'
  if ! node "$LINT" --staged --repo "$TMP/r" >/dev/null 2>&1; then ok "T11c · un ambiente fuera del vocabulario rechaza"
  else no "T11c · «prod» (que no es `produccion`) pasó"; fi

  declara '{"servers":[{"host":"x.database.windows.net","environment":"produccion","keychain":"mi-clave"}]}'
  if ! node "$LINT" --staged --repo "$TMP/r" >/dev/null 2>&1; then ok "T11d · un llavero que no empieza con tycon-prod- rechaza"
  else no "T11d · un llavero con cualquier nombre pasó"; fi

  declara '{"servers":[{"host":"x.database.windows.net","environment":"produccion"}]}'
  if ! node "$LINT" --staged --repo "$TMP/r" >/dev/null 2>&1; then ok "T11e · producción sin llavero rechaza"
  else no "T11e · un servidor de producción sin llavero pasó"; fi

  declara '{"servers":[{"host":"x.database.windows.net","environment":"no-produccion","keychain":"tycon-prod-x"}]}'
  if ! node "$LINT" --staged --repo "$TMP/r" >/dev/null 2>&1; then ok "T11f · un no-produccion con llavero rechaza"
  else no "T11f · un no-produccion con llavero pasó"; fi

  # lo que NO tiene que molestar: un repo sin catálogo, y un catálogo no stageado
  rm -rf "$TMP/r2"; mkdir -p "$TMP/r2"; ( cd "$TMP/r2" && git init -q . ) >/dev/null 2>&1
  if node "$LINT" --staged --repo "$TMP/r2" >/dev/null 2>&1; then ok "T11g · un repo sin catálogo no dice nada"
  else no "T11g · un repo sin catálogo fue rechazado"; fi

  declara "$BUENO"; printf '{"servers":[{"roto":1}]}' > "$TMP/r/.tycon/production.json"   # sucio pero NO stageado
  if node "$LINT" --staged --repo "$TMP/r" >/dev/null 2>&1; then ok "T11h · juzga lo STAGEADO, no el disco"
  else no "T11h · juzgó el archivo del disco en vez del stageado"; fi

  # producción se declara en el repo con migraciones (database/ o BD/)
  declara "$BUENO"; rm -rf "$TMP/r/database"
  salida="$(node "$LINT" --staged --repo "$TMP/r" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$salida" | grep "sin migraciones" >/dev/null; then ok "T11j · producción declarada en un repo sin migraciones se rechaza"
  else no "T11j · producción en un repo sin database/ ni BD/ pasó (rc=$rc)"; fi
  declara '{"servers":[{"host":"acme-test.example.com","environment":"no-produccion"}]}'; rm -rf "$TMP/r/database"
  if node "$LINT" --staged --repo "$TMP/r" >/dev/null 2>&1; then ok "T11k · un servidor de no-producción se declara en cualquier repo"
  else no "T11k · un no-produccion en un repo sin migraciones fue rechazado"; fi
fi

# el enganche en el pre-commit global: sin `|| true`, porque tiene que RECHAZAR
if grep -q "lint-production-json.js" "$HOOK_GLOBAL" 2>/dev/null; then
  if grep -A3 "lint-production-json.js" "$HOOK_GLOBAL" | grep "|| true" >/dev/null; then
    no 'T11i · el lint está enganchado con "|| true": no rechazaría nada'
  else ok "T11i · el lint está enganchado en el pre-commit global y su veredicto manda"; fi
else
  no "T11i · el pre-commit global no invoca el lint"
fi

# ── T33 · el freno usa sólo el intérprete de root ─────────────────────────────────────────────
# Resolver `node` por rutas fijas del usuario (/usr/local/bin, /opt/homebrew/bin, las
# dos escribibles por el usuario) deja que `cp /bin/true /opt/homebrew/bin/node` apague el freno en silencio.
if [ ! -f "$SHIM" ]; then
  no "T33 · el shim no existe todavía ($SHIM)"
else
  RAIZ="$TMP/sys"; mkdir -p "$RAIZ/opt/tycon/bin"
  payload_base='{"tool_name":"Bash","tool_input":{"command":"sqlcmd -S acme-sql.database.windows.net -Q \"select 1\""}}'
  payload_sin='{"tool_name":"Bash","tool_input":{"command":"git status"}}'

  # sin node de root: con base → 2 ; sin base → 0
  printf '%s' "$payload_base" | HOME="$TMP/casa-33" TYCON_PROD_ROOT="$RAIZ" bash "$SHIM" >/dev/null 2>&1
  [ $? -eq 2 ] && ok "T33a · sin el node de root, un comando que nombra una base sale 2" || no "T33a · sin el node de root, el comando con base NO se frenó"
  printf '%s' "$payload_sin" | HOME="$TMP/casa-33" TYCON_PROD_ROOT="$RAIZ" bash "$SHIM" >/dev/null 2>&1
  [ $? -eq 0 ] && ok "T33b · sin el node de root, un comando sin base pasa" || no "T33b · un comando sin base fue frenado"

  # con node de root pero huella distinta → 2 con base
  mkdir -p "$RAIZ/opt/tycon/hooks"
  cp "$AQUI/scripts/hooks/prod-access-guard.js" "$RAIZ/opt/tycon/hooks/"
  cp "$(command -v node)" "$RAIZ/opt/tycon/bin/node"
  printf '{"/opt/tycon/bin/node":"0000000000000000000000000000000000000000000000000000000000000000"}' > "$RAIZ/opt/tycon/huellas.json"
  printf '%s' "$payload_base" | HOME="$TMP/casa-33" TYCON_PROD_ROOT="$RAIZ" bash "$SHIM" >/dev/null 2>&1
  [ $? -eq 2 ] && ok "T33c · con la huella del intérprete cambiada, sale 2" || no "T33c · huella distinta y el shim ejecutó igual"
fi

# 🔴 CONTROL POSITIVO (su ausencia tapa un defecto real):
# con TODO en su lugar, el lanzador tiene que EJECUTAR el freno y dejar pasar su veredicto. Sin este
# caso, un lanzador que nunca ejecuta nada se vería idéntico a uno que anda: los tres casos de arriba
# pasan igual, porque todos miran el camino de la falla.
if [ -f "$SHIM" ]; then
  RAIZ2="$TMP/sys-ok"; CASA2="$TMP/casa-ok"; REPOS2="$TMP/repos-ok"
  rm -rf "$RAIZ2" "$CASA2" "$REPOS2"
  mkdir -p "$RAIZ2/opt/tycon/bin" "$RAIZ2/opt/tycon/hooks" "$RAIZ2/opt/tycon/lib" "$RAIZ2/opt/tycon/production"            "$CASA2/.claude/.tycon-pipeline" "$REPOS2/backend-acme/.tycon"
  ( cd "$REPOS2/backend-acme" && git init -q . ) >/dev/null 2>&1
  printf '{"servers":[{"host":"acme-sql.database.windows.net","environment":"produccion","keychain":"tycon-prod-acme"}]}'     > "$REPOS2/backend-acme/.tycon/production.json"
  cp "$AQUI/scripts/hooks/prod-access-guard.js" "$RAIZ2/opt/tycon/hooks/"
  cp "$AQUI/scripts/production/guard-libs/lib/shell-parse.js" "$AQUI/scripts/production/guard-libs/lib/repos-root.js" "$RAIZ2/opt/tycon/lib/"
  cp "$AQUI/scripts/production/production-index.js" "$RAIZ2/opt/tycon/production/"
  cp "$(command -v node)" "$RAIZ2/opt/tycon/bin/node"
  printf '{"/opt/tycon/bin/node":"%s"}' "$(shasum -a 256 "$RAIZ2/opt/tycon/bin/node" | cut -d' ' -f1)" > "$RAIZ2/opt/tycon/huellas.json"

  lanza(){ printf '%s' "$1" | env HOME="$CASA2" TYCON_PROD_ROOT="$RAIZ2" TYCON_REPOS_ROOT="$REPOS2"              TYCON_PROD_SESSION_SINCE=0 bash "$SHIM" >"$TMP/shim-out" 2>"$TMP/shim-err"; echo $?; }

  rc="$(lanza '{"tool_name":"Bash","tool_input":{"command":"sqlcmd -S acme-sql.database.windows.net -Q \"select 1\""}}')"
  if [ "$rc" = 2 ] && grep -q "acme-sql" "$TMP/shim-err"; then ok "T33d · con todo en su lugar, el lanzador EJECUTA el freno (mensaje del freno, no el suyo)"
  else no "T33d · el lanzador no ejecutó el freno (rc=$rc) — err: $(head -c 120 "$TMP/shim-err")"; fi

  rc="$(lanza '{"tool_name":"Bash","tool_input":{"command":"git status --short"}}')"
  if [ "$rc" = 0 ] && [ ! -s "$TMP/shim-out" ]; then ok "T33e · y un comando cualquiera pasa sin una línea de salida"
  else no "T33e · un comando sin base no pasó limpio (rc=$rc)"; fi
fi

# T33i · un freno que no se pudo ejecutar deja CONSTANCIA donde el aviso de arranque la lee. Sin
# esto, «el freno está roto en esta máquina» vive sólo en la pantalla del momento.
if [ -f "$SHIM" ]; then
  VACIA2="$TMP/sys-vacia2"; CASA3="$TMP/casa-constancia"; rm -rf "$VACIA2" "$CASA3"; mkdir -p "$VACIA2/opt/tycon/bin" "$CASA3"
  printf '{"tool_name":"Bash","tool_input":{"command":"sqlcmd -S acme-sql.database.windows.net -Q \"select 1\""}}'     | env HOME="$CASA3" TYCON_PROD_ROOT="$VACIA2" bash "$SHIM" >/dev/null 2>&1
  if grep -q "prod-access-guard" "$CASA3/.claude/.tycon-pipeline/hook-errors.log" 2>/dev/null; then
    ok "T33i · el lanzador que no pudo correr el freno deja constancia en hook-errors.log"
  else no "T33i · frenó sin dejar constancia: el aviso de arranque nunca se entera"; fi
fi

# T33k · el tope del hook es al menos el doble del reloj del lanzador. Los dos números se leen de sus archivos: si
# alguien sube el reloj sin subir el tope, Claude Code corta al lanzador antes de que frene, y el comando corre.
tope_alcanza(){ [ -n "$1" ] && [ -n "$2" ] && [ "$1" -ge $(( 2 * $2 )) ]; }
TOPE_K="$(node -e 'const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); let x=null;
  for (const g of (t.hooks||{}).PreToolUse||[]) for (const h of g.hooks||[]) if (/node-shim\.sh$/.test(h.command||"")) x=h.timeout; console.log(x??"")' \
  "$AQUI/scripts/production/managed-settings.tycon-production.json.template" 2>/dev/null)"
RELOJ_K="$(grep -o 'TYCON_PROD_SHIM_TIMEOUT:-[0-9]*' "$SHIM" 2>/dev/null | head -1 | cut -d- -f2)"
if tope_alcanza "$TOPE_K" "$RELOJ_K" && ! tope_alcanza 10 7; then ok "T33k · el tope del hook (${TOPE_K} s) es al menos el doble del reloj del lanzador (${RELOJ_K} s)"
else no "T33k · el tope del hook («${TOPE_K}» s) no llega al doble del reloj del lanzador («${RELOJ_K}» s)"; fi

# T33q · la guía dice qué pasa cuando el freno no contesta a tiempo, y el límite que el arnés no puede cerrar.
GUIA_Q="$AQUI/guides/produccion-con-permiso.md"
if grep -q "no contesta a tiempo" "$GUIA_Q" && grep -qi "frena" "$GUIA_Q" && grep -qi "reinstal" "$GUIA_Q" \
   && grep -q "30 s" "$GUIA_Q" && grep -q "Claude Code" "$GUIA_Q"; then ok "T33q · la guía dice qué pasa cuando el freno no contesta a tiempo y el límite de los 30 s"
else no "T33q · la guía no explica qué pasa cuando el freno no contesta a tiempo (o le falta el límite de los 30 s)"; fi

# 🔴 Con el freno INSTALADO el lanzador ignora `TYCON_PROD_ROOT` (a propósito: una sesión hija con esa
# variable apagaba el freno entero), así que el caso de abajo no se puede fabricar en esta máquina: el
# lanzador usaría el /opt/tycon REAL y contestaría con el motivo del freno de verdad, no con el suyo.
# Se saltea DICIÉNDOLO; lo mide el nocturno, que corre sin el freno instalado.
if [ -d /opt/tycon ]; then
  echo "⏭ instalar-freno: T33g/h/j salteados — con el freno instalado, el lanzador ignora la raíz de prueba; los mide el nocturno."
else

# T33g/h · el RELOJ del lanzador. La herramienta le da al hook 10 s y un hook que no contesta a
# tiempo DEJA PASAR: un freno colgado se leería como «lo miré y estaba todo bien». Sin
# el vigía, el caso de abajo tarda lo que tarde el freno y sale 0.
if [ -f "$SHIM" ]; then
  COLG="$TMP/sys-colgado"; rm -rf "$COLG"; mkdir -p "$COLG/opt/tycon/bin" "$COLG/opt/tycon/hooks"
  cp "$(command -v node)" "$COLG/opt/tycon/bin/node"
  printf 'setTimeout(()=>process.exit(0), 60000);\n' > "$COLG/opt/tycon/hooks/prod-access-guard.js"
  printf '{"/opt/tycon/bin/node":"%s"}' "$(shasum -a 256 "$COLG/opt/tycon/bin/node" | cut -d' ' -f1)" > "$COLG/opt/tycon/huellas.json"
  COLG_CASA="$TMP/casa-colgado"
  # HOME de la prueba: colgado() corre dentro de `$( … )`, así que la HOME falsa queda en esa
  # subshell y el resto de la suite sigue como estaba. Si no se puede armar, 97: ni 0 ni 2, los dos casos lo ven.
  colgado(){ fake_home_create "$COLG_CASA" 2>"$TMP/colg-err" || { echo 97; return; }
             printf '%s' "$1" | env TYCON_PROD_ROOT="$COLG" TYCON_PROD_SHIM_TIMEOUT=2 bash "$SHIM" >"$TMP/colg-out" 2>"$TMP/colg-err"; echo $?; }

  rc="$(colgado '{"tool_name":"Bash","tool_input":{"command":"sqlcmd -S acme-sql.database.windows.net -Q \"select 1\""}}')"
  if [ "$rc" = 2 ] && grep -q "sin tiempo" "$TMP/colg-err"; then ok "T33g · un freno colgado NO deja pasar un comando que nombra una base"
  else no "T33g · el freno colgado salió $rc (esperaba 2 con el motivo del tiempo) — err: $(head -c 120 "$TMP/colg-err")"; fi

  # T33h · un freno colgado tampoco deja pasar un comando sin bases: el freno juzga lo que el comando ejecuta por
  # dentro (un guion, `bash -c`, un heredoc), y eso el lanzador no lo ve. El cartel dice que se reintente.
  rc="$(colgado '{"tool_name":"Bash","tool_input":{"command":"git status --short"}}')"
  if [ "$rc" = 2 ] && grep -q "no contestó" "$TMP/colg-err" && grep -q "carga" "$TMP/colg-err"; then ok "T33h · un freno colgado tampoco deja pasar un comando sin bases, y el cartel pide reintentar"
  else no "T33h · con el freno colgado, un comando sin bases salió $rc (esperaba 2 con «no contestó» y «carga») — err: $(head -c 160 "$TMP/colg-err")"; fi

  # T33j · la constancia del reloj queda en la HOME de la PRUEBA. El lanzador que frena deja
  # «no pude ejecutar el freno» en hook-errors.log, que el aviso de arranque lee: corrido sin HOME propia, deja una
  # constancia falsa por corrida en el registro real del nocturno. Evidencia POSITIVA (el real no sirve de
  # control). Sin la HOME falsa en colgado(), la constancia no está acá.
  n="$(FAKE_HOME="$COLG_CASA" fake_home_count hook-errors.log 'se quedó sin tiempo' 2>/dev/null)"
  if [ "${n:-0}" -gt 0 ]; then ok "T33j · la constancia del freno colgado quedó en la HOME de la prueba ($n), no en la real"
  else no "T33j · la constancia del freno colgado no está en la HOME de la prueba: fue al hook-errors.log real"; fi

  # T33t · el reloj anda aunque el hook arranque con su señal ignorada: bash no puede atrapar una señal que le llega
  # ignorada, y con el reloj muerto el freno colgado deja pasar el comando a los 30 s.
  # T33u · el reloj corta también la lectura de la entrada: una entrada que no se cierra no lo retiene, y el cartel
  # sale sin el «Killed: 9» con que bash anuncia el trabajo que mató.
  # cronometrar: corre un comando con `bash -c` y espera a que se cierren sus caños, como Claude Code; imprime los ms.
  cronometrar(){ node -e 'const {spawnSync}=require("child_process"); const fs=require("fs"); const t=Date.now();
    const r=spawnSync("bash",["-c",process.argv[1]],{encoding:"utf8"}); const ms=Date.now()-t;
    fs.writeFileSync(process.argv[2]+"/medido-rc", String(r.status)); fs.writeFileSync(process.argv[2]+"/medido-err", r.stderr||""); console.log(ms);' "$1" "$TMP"; }
  CASA_T="$TMP/casa-33t"; mkdir -p "$CASA_T"
  export SHIM_T="$SHIM" EV_T='{"tool_name":"Bash","tool_input":{"command":"ls"}}'
  for ignoradas in "USR1" "USR1 USR2 ALRM"; do
    ms="$(HOME="$CASA_T" TYCON_PROD_ROOT="$COLG" TYCON_PROD_SHIM_TIMEOUT=2 cronometrar "trap '' $ignoradas; printf '%s' \"\$EV_T\" | exec bash \"\$SHIM_T\"")"
    rc="$(cat "$TMP/medido-rc")"
    if [ "$rc" = 2 ] && [ "${ms:-99999}" -lt 4000 ] && grep -q "se quedó sin tiempo" "$TMP/medido-err"; then ok "T33t · con ${ignoradas} ignorada(s) al arrancar, el reloj frena igual (${ms} ms)"
    else no "T33t · con ${ignoradas} ignorada(s) al arrancar, salió $rc en ${ms:-?} ms (esperaba 2 por tiempo en < 4000 ms) — err: $(head -c 160 "$TMP/medido-err")"; fi
  done
  ms="$(HOME="$CASA_T" TYCON_PROD_ROOT="$COLG" TYCON_PROD_SHIM_TIMEOUT=2 cronometrar 'bash "$SHIM_T" < <(printf "%s" "$EV_T"; exec 2>/dev/null; sleep 8)')"
  rc="$(cat "$TMP/medido-rc")"
  if [ "$rc" = 2 ] && [ "${ms:-99999}" -lt 4000 ] && grep -q "se quedó sin tiempo" "$TMP/medido-err" && ! grep -q "Killed" "$TMP/medido-err"; then ok "T33u · una entrada que no se cierra no retiene al reloj (${ms} ms), y el cartel sale limpio"
  else no "T33u · con la entrada abierta salió $rc en ${ms:-?} ms (esperaba 2 por tiempo en < 4000 ms, sin «Killed») — err: $(head -c 160 "$TMP/medido-err")"; fi
fi

# T33l–T33s · la verificación del intérprete por sus datos, el reloj que la cubre y la medición con carga. Cada caso
# arma su raíz de prueba con el intérprete de este node, un freno de juguete y su huellas.json.
if [ -f "$SHIM" ]; then
  EV_LS='{"tool_name":"Bash","tool_input":{"command":"ls"}}'
  EV_BASE='{"tool_name":"Bash","tool_input":{"command":"sqlcmd -S acme-sql.database.windows.net -Q \"select 1\""}}'
  # el freno de juguete: frena (2) lo que nombra acme-sql y deja pasar el resto, con su propio mensaje
  JUGUETE='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(s.includes("acme-sql")){console.error("juguete: lo frenó el freno");process.exit(2)}process.exit(0)});'
  raiz_de_prueba(){ # $1 = raíz · $2 = código del freno · deja el intérprete copiado
    rm -rf "$1"; mkdir -p "$1/opt/tycon/bin" "$1/opt/tycon/hooks"
    cp "$(command -v node)" "$1/opt/tycon/bin/node"; printf '%s\n' "$2" > "$1/opt/tycon/hooks/prod-access-guard.js"; }
  huellas_de(){ # $1 = raíz · $2 = huella del intérprete · $3 = objeto de datos (vacío = huellas.json viejo)
    if [ -n "${3:-}" ]; then printf '{\n  "/opt/tycon/bin/node": "%s",\n  "__stat": {\n    "/opt/tycon/bin/node": %s\n  }\n}\n' "$2" "$3" > "$1/opt/tycon/huellas.json"
    else printf '{\n  "/opt/tycon/bin/node": "%s"\n}\n' "$2" > "$1/opt/tycon/huellas.json"; fi; }
  sha_de(){ shasum -a 256 "$1" | cut -d' ' -f1; }
  CEROS=0000000000000000000000000000000000000000000000000000000000000000
  CASA_L="$TMP/casa-33l"; mkdir -p "$CASA_L"

  # T33l · el reloj cubre la verificación del intérprete: un huellas.json viejo obliga a leer el binario entero, y un
  # intérprete de 4 GB (disperso: no ocupa disco) no se termina de leer en 2 s. Sin el reloj alrededor, el lanzador
  # espera la huella entera y Claude Code lo corta por tiempo: el comando corre sin freno.
  RL="$TMP/sys-lento"; raiz_de_prueba "$RL" "$JUGUETE"; rm -f "$RL/opt/tycon/bin/node"
  mkfile -n 4g "$RL/opt/tycon/bin/node" 2>/dev/null || truncate -s 4G "$RL/opt/tycon/bin/node"; chmod 755 "$RL/opt/tycon/bin/node"
  huellas_de "$RL" "$CEROS" ""
  read -r med _ < <(HOME="$CASA_L" TYCON_PROD_ROOT="$RL" TYCON_PROD_SHIM_TIMEOUT=2 medir 1 "$EV_LS")
  rc="$(cat "$TMP/medido-rc")"
  if [ "$rc" = 2 ] && [ "${med:-99999}" -lt 3000 ] && grep -q "se quedó sin tiempo" "$TMP/medido-err" && ! grep -q "huella" "$TMP/medido-err"; then
    ok "T33l · el reloj cubre la verificación del intérprete: frenó por tiempo en ${med} ms"
  else no "T33l · con la huella lenta salió $rc en ${med:-?} ms (esperaba 2 en < 3000 ms, por tiempo) — err: $(head -c 160 "$TMP/medido-err")"; fi

  # T33m · con los datos del intérprete, el lanzador no recalcula la huella: la huella anotada es falsa a propósito, y
  # aun así el freno corre y decide (un comando con base lo frena el juguete, no el lanzador).
  RM="$TMP/sys-datos"; raiz_de_prueba "$RM" "$JUGUETE"
  huellas_de "$RM" "$CEROS" "$(datos_json "$RM/opt/tycon/bin/node")"
  HOME="$CASA_L" TYCON_PROD_ROOT="$RM" medir 1 "$EV_LS" >/dev/null; rc1="$(cat "$TMP/medido-rc")"
  HOME="$CASA_L" TYCON_PROD_ROOT="$RM" medir 1 "$EV_BASE" >/dev/null; rc2="$(cat "$TMP/medido-rc")"
  if [ "$rc1" = 0 ] && [ "$rc2" = 2 ] && grep -q "juguete" "$TMP/medido-err"; then ok "T33m · con los datos del intérprete no se recalcula la huella: el freno corre y decide"
  else no "T33m · con datos correctos y huella falsa: ls salió $rc1, la base $rc2 — err: $(head -c 160 "$TMP/medido-err")"; fi

  # T33n · un intérprete cambiado se nota por sus datos: otro tamaño y el comando con base se frena por el intérprete.
  d=($(datos_de "$RM/opt/tycon/bin/node"))
  huellas_de "$RM" "$(sha_de "$RM/opt/tycon/bin/node")" "$(printf '{"uid": %s, "mode": "%s", "size": %s, "mtime": %s, "inode": %s}' "${d[0]}" "${d[1]}" "$(( d[2] + 1 ))" "${d[3]}" "${d[4]}")"
  HOME="$CASA_L" TYCON_PROD_ROOT="$RM" medir 1 "$EV_BASE" >/dev/null; rc="$(cat "$TMP/medido-rc")"
  if [ "$rc" = 2 ] && grep -q "intérprete" "$TMP/medido-err" && ! grep -q "juguete" "$TMP/medido-err"; then ok "T33n · un intérprete con otros datos frena el comando con base"
  else no "T33n · con datos distintos, la base salió $rc sin el motivo del intérprete — err: $(head -c 160 "$TMP/medido-err")"; fi

  # T33p · un huellas.json viejo (sin datos) sigue andando: la huella completa, dentro del reloj.
  RP="$TMP/sys-viejo"; raiz_de_prueba "$RP" "$JUGUETE"
  huellas_de "$RP" "$(sha_de "$RP/opt/tycon/bin/node")" ""
  HOME="$CASA_L" TYCON_PROD_ROOT="$RP" medir 1 "$EV_LS" >/dev/null; rc1="$(cat "$TMP/medido-rc")"
  HOME="$CASA_L" TYCON_PROD_ROOT="$RP" medir 1 "$EV_BASE" >/dev/null; rc2="$(cat "$TMP/medido-rc")"
  if [ "$rc1" = 0 ] && [ "$rc2" = 2 ] && grep -q "juguete" "$TMP/medido-err"; then ok "T33p · un huellas.json viejo sigue andando: ls pasa y la base la juzga el freno"
  else no "T33p · con huellas.json viejo: ls salió $rc1, la base $rc2 — err: $(head -c 160 "$TMP/medido-err")"; fi

  # T33r · un freno que se cae al instante tampoco deja pasar: un código propio no es «estaba todo bien».
  RR="$TMP/sys-caido"; raiz_de_prueba "$RR" 'process.exit(1);'
  huellas_de "$RR" "$(sha_de "$RR/opt/tycon/bin/node")" "$(datos_json "$RR/opt/tycon/bin/node")"
  HOME="$CASA_L" TYCON_PROD_ROOT="$RR" medir 1 "$EV_LS" >/dev/null; rc="$(cat "$TMP/medido-rc")"
  if [ "$rc" = 2 ] && grep -q "error propio (código 1)" "$TMP/medido-err" && grep -q "no pudo decidir" "$TMP/medido-err"; then ok "T33r · un freno caído tampoco deja pasar un comando sin bases"
  else no "T33r · con el freno caído, ls salió $rc (esperaba 2 con «error propio (código 1)» y «no pudo decidir») — err: $(head -c 160 "$TMP/medido-err")"; fi

  # T33s · con la máquina cargada a propósito (CPU en cada núcleo y lectura de disco sin parar), el lanzador con el
  # freno de verdad contesta con margen: la mediana de 20 vueltas, debajo de la mitad del tope del hook; ninguna, en
  # el tope. El tope se lee de la plantilla: el freno tiene que contestar casi siempre, también con la máquina ocupada.
  TOPE_S="$(node -e 'const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); let x=null;
    for (const g of (t.hooks||{}).PreToolUse||[]) for (const h of g.hooks||[]) if (/node-shim\.sh$/.test(h.command||"")) x=h.timeout; console.log(x??"")' \
    "$AQUI/scripts/production/managed-settings.tycon-production.json.template" 2>/dev/null)"
  if [ -z "$TOPE_S" ] || [ ! -d "$RAIZ2/opt/tycon/hooks" ]; then
    no "T33s · no pude leer el tope del hook de la plantilla («${TOPE_S}») o falta la raíz con el freno de verdad"
  else
    RS="$TMP/sys-carga"; rm -rf "$RS"; cp -R "$RAIZ2" "$RS"
    huellas_de "$RS" "$(sha_de "$RS/opt/tycon/bin/node")" "$(datos_json "$RS/opt/tycon/bin/node")"
    nucleos="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
    for _ in $(seq "$nucleos"); do yes > /dev/null & CARGA_PIDS="$CARGA_PIDS $!"; done
    ( while :; do dd if="$RS/opt/tycon/bin/node" of=/dev/null bs=1048576 2>/dev/null; done ) & CARGA_PIDS="$CARGA_PIDS $!"
    read -r med max < <(HOME="$CASA2" TYCON_PROD_ROOT="$RS" TYCON_REPOS_ROOT="$REPOS2" TYCON_PROD_SESSION_SINCE=0 medir 20 "$EV_LS")
    rcs_ls="$(cat "$TMP/medido-rc")"
    # control con la misma carga: un comando con base trae el mensaje del freno de verdad (no el del lanzador). Sin esto,
    # un lanzador que nunca llega al freno deja pasar `ls` en milisegundos y la medición sale verde sin medir nada.
    HOME="$CASA2" TYCON_PROD_ROOT="$RS" TYCON_REPOS_ROOT="$REPOS2" TYCON_PROD_SESSION_SINCE=0 medir 1 "$EV_BASE" >/dev/null
    rc_base="$(cat "$TMP/medido-rc")"
    apagar_carga
    tope_ms=$(( TOPE_S * 1000 ))
    if [ "$rcs_ls" = 0 ] && [ "$rc_base" = 2 ] && grep -q "acme-sql" "$TMP/medido-err" && ! grep -q "no pude ejecutarlo" "$TMP/medido-err" \
       && [ -n "${med:-}" ] && [ "$med" -lt $(( tope_ms / 2 )) ] && [ "$max" -lt "$tope_ms" ]; then
      ok "T33s · con la máquina cargada ($nucleos núcleos + disco), el freno decide: mediana ${med} ms y máximo ${max} ms, con tope ${TOPE_S} s"
    else no "T33s · con carga, mediana ${med:-?} ms y máximo ${max:-?} ms (tope ${TOPE_S} s; la mediana, debajo de la mitad); códigos de ls «${rcs_ls}» (esperaba 0), control con base ${rc_base} — err: $(head -c 160 "$TMP/medido-err")"; fi
  fi
fi
fi

# T33f · CADA cliente que el freno conoce, con el lanzador SIN intérprete de root, sale 2. La lista se
# lee del propio freno: si alguien suma un cliente allá y no en el lanzador, este caso se pone rojo
# (dos listas a mano se separarían).
# 🔴 CASA FALSA, como el resto de los casos de este archivo. T33f lanza el shim REAL: el freno escribe
# su registro en `$HOME/.claude/.tycon-pipeline/`, así que sin `HOME=` cada corrida de esta suite dejaría ~10 bloqueos
# INVENTADOS en el production.log de verdad. Y ese registro no es un log suelto: `guard-record.js`
# lo declara y el reductor lo cuenta para el tablero del arnés, o sea que la suite fabricaría el
# numerador de un número que el equipo publica. Regla: BANCO-C11.
if [ -f "$SHIM" ]; then
  VACIA="$TMP/sys-vacia"; mkdir -p "$VACIA/opt/tycon/bin"
  CASA_33F="$TMP/casa-33f"; mkdir -p "$CASA_33F"
  clientes="$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8"); const m=/const CLIENTES = \{([\s\S]*?)\};/.exec(s); console.log([...m[1].matchAll(/([\w-]+)\x27?\s*:/g)].map(x=>x[1]).join(" "))' "$AQUI/scripts/hooks/prod-access-guard.js")"
  [ -n "$clientes" ] || no "T33f · no pude leer la lista de clientes del freno"
  for cli in $clientes; do
    payload="$(CMD="$cli -S acme-sql.database.windows.net" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:process.env.CMD}}))')"
    printf '%s' "$payload" | HOME="$CASA_33F" TYCON_PROD_ROOT="$VACIA" bash "$SHIM" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 2 ] && ok "T33f · sin intérprete, «${cli}» se frena igual" || no "T33f · sin intérprete, «${cli}» PASÓ (el lanzador no lo reconoce)"
  done
fi

# T33g · esta suite no escribe NADA en la casa real. Se mira el registro del freno de la
# casa de verdad antes y después del bloque de arriba: si crece, algún caso perdió su `HOME=` y está
# fabricando bloqueos que el tablero después cuenta como reales. Sin el `HOME=`, la suite suma ~10 líneas por corrida.
{
  REAL_LOG="$REAL_LOG_0"
  DESPUES=0; [ -f "$REAL_LOG" ] && DESPUES="$(wc -l < "$REAL_LOG" | tr -d ' ')"
  if [ "${ANTES_REAL:-0}" = "$DESPUES" ]; then ok "T33g · la suite no dejó ni una línea en el registro de producción real"
  else no "T33g · la suite escribió $((DESPUES - ${ANTES_REAL:-0})) línea(s) en $REAL_LOG — a algún caso le falta su HOME falso"; fi
}

# ── T19 · el instalador ───────────────────────────────────────────────────────────────────────
if [ ! -f "$INSTALADOR" ]; then
  no "T19 · el instalador no existe todavía ($INSTALADOR)"
else
  prep(){ rm -rf "$TMP/sys2"; mkdir -p "$TMP/sys2/Library/Application Support/ClaudeCode" "$TMP/sys2/opt" "$TMP/bin"
          cat > "$TMP/bin/sudo" <<'SH'
#!/usr/bin/env bash
exec "$@"
SH
          chmod +x "$TMP/bin/sudo"
          # doble del cliente de base: el agente Linux del nocturno no tiene sqlcmd en la ruta fija
          # que mira el instalador, y sin él el instalador muere ANTES de T19a
          cat > "$TMP/bin/sqlcmd" <<'SH'
#!/usr/bin/env bash
echo "doble de sqlcmd para T19"; exit 0
SH
          chmod +x "$TMP/bin/sqlcmd"; }
  prep
  # ── de qué clon instala T19 ──────────────────────────────────────────────────────
  # El instalador exige que el `origin` del arnés sea el https de Azure DevOps del equipo y que haya una organización
  # configurada. Corriendo sobre ESTE clon, T19 depende del remoto de quien corre: en la copia pública (sin remoto, o
  # con el de otro servidor), en un clon de laboratorio (`git clone --shared`: el origin es una carpeta) o en un clon
  # por ssh, el instalador muere antes de instalar nada y nueve chequeos dan rojo sin haber medido lo suyo («no pude
  # leer el remoto del clon»).
  # Con el origin https del repo del equipo se sigue instalando desde ESTE clon, con la organización del perfil: así el
  # repo del equipo mide además que su perfil y su remoto coinciden. Sin eso, se arma un clon de laboratorio con los
  # archivos del instalador, un origin de Azure DevOps inventado y esa organización por TYCON_ADO_ORG —lo mismo que ya
  # hace T19l con su clon falso— y se dice: que ESTE clon sea instalable ahí no se midió.
  ORIGIN_URL="$(git -C "$AQUI" remote get-url origin 2>/dev/null)"
  ORG_REAL="$(printf '%s\n' "$ORIGIN_URL" | sed -nE 's#^(ssh|https?)://([^@/]+@)?dev\.azure\.com/([^/]+)/.*#\3#p; s#^git@ssh\.dev\.azure\.com:v3/([^/]+)/.*#\1#p; s#^https?://([^@/]+@)?([^./]+)\.visualstudio\.com/.*#\2#p' | head -1)"
  HARNESS_T19="$AQUI"; ORG_T19="${TYCON_ADO_ORG:-}"
  case "$ORIGIN_URL" in https://*) : ;; *) HARNESS_T19="" ;; esac
  [ -n "$ORG_REAL" ] || HARNESS_T19=""
  # …y tiene que ser EL repo en el que el instalador confía (el `case` del remoto de install-guard.sh). Desde otro repo
  # de la misma organización —su origin también es un https de Azure DevOps— el instalador muere por el remoto antes de
  # instalar nada, y los nueve chequeos de abajo darían rojo sin haber medido lo suyo: la misma falla que tienen la
  # copia pública y los clones de laboratorio, con otro remoto. Un clon así, además, no tiene por qué traer el freno
  # publicado en su rama principal.
  case "$ORIGIN_URL" in */tycon-claude-guides/_git/tycon-claude-guides) : ;; *) HARNESS_T19="" ;; esac
  if [ -z "$HARNESS_T19" ]; then
    HARNESS_T19="$TMP/harness-t19"; ORG_T19="https://dev.azure.com/lab-org"
    rm -rf "$HARNESS_T19"; mkdir -p "$HARNESS_T19"
    # los archivos del instalador y, si este arnés es el del equipo, su perfil y su mapa (el instalador los exige juntos)
    for f in $(sed -n '/^ARCHIVOS=(/,/^)/p' "$INSTALADOR" | grep '^  scripts/') scripts/lib/renames.json team-profile.json perfil-equipo.json; do
      [ -f "$AQUI/$f" ] || continue
      mkdir -p "$HARNESS_T19/$(dirname "$f")"; cp "$AQUI/$f" "$HARNESS_T19/$f"
    done
    ( cd "$HARNESS_T19" && git init -q . && git remote add origin "https://dev.azure.com/lab-org/tycon-claude-guides/_git/tycon-claude-guides" ) >/dev/null 2>&1
    echo "⏭ instalar-freno: T19 corre sobre un clon de laboratorio con un origin de Azure DevOps inventado — el origin de este clon no es el repo en el que confía el instalador, por https (${ORIGIN_URL:-sin remoto}). Que ESTE clon sea instalable no se midió acá."
  fi
  # managed ajeno preexistente (de la organización): no se pisa
  printf '{"permissions":{"allow":["Bash(ls *)"]},"organizacion":true}' > "$TMP/sys2/Library/Application Support/ClaudeCode/managed-settings.json"
  PATH="$TMP/bin:$PATH" TYCON_ADO_ORG="$ORG_T19" TYCON_PROD_TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$TMP/sys2" TYCON_PROD_HARNESS="$HARNESS_T19" TYCON_PROD_ACCEPT_ORIGIN=1 bash "$INSTALADOR" --no-sudo >"$TMP/inst-out" 2>&1
  rc1=$?
  if [ "$rc1" -eq 0 ] && grep -q '"organizacion"' "$TMP/sys2/Library/Application Support/ClaudeCode/managed-settings.json" 2>/dev/null; then
    ok "T19a · el instalador no pisa el managed de la organización"
  else no "T19a · el managed de la organización se perdió o el instalador falló (rc=$rc1): $(tail -1 "$TMP/inst-out" 2>/dev/null)"; fi

  if [ -f "$TMP/sys2/Library/Application Support/ClaudeCode/managed-settings.d/tycon-production.json" ]; then
    ok "T19b · deja su archivo aparte en managed-settings.d/"
  else no "T19b · no dejó managed-settings.d/tycon-production.json"; fi

  if grep -q 'Bash|Monitor|PowerShell' "$TMP/sys2/Library/Application Support/ClaudeCode/managed-settings.d/tycon-production.json" 2>/dev/null; then
    ok "T19c · el matcher administrado incluye Monitor y PowerShell"
  else no "T19c · el matcher administrado no cubre Monitor/PowerShell"; fi

  # T33o · el instalador anota los datos del intérprete junto a su huella, iguales a los del archivo instalado. Con
  # ellos el lanzador no lee los 122 MB del intérprete en cada comando. T19d, abajo, mide que no se reescriban.
  o_node="$TMP/sys2/opt/tycon/bin/node"; o_huellas="$TMP/sys2/opt/tycon/huellas.json"
  o_esperado="$(datos_de "$o_node")"
  o_anotado="$(node -e 'const h=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const s=(h.__stat||{})["/opt/tycon/bin/node"]||{};
    if (typeof h["/opt/tycon/bin/node"] !== "string") process.exit(1); console.log([s.uid,s.mode,s.size,s.mtime,s.inode].join(" "))' "$o_huellas" 2>/dev/null)"
  if [ -n "$o_esperado" ] && [ "$o_anotado" = "$o_esperado" ]; then ok "T33o · huellas.json trae la huella y los datos del intérprete ($o_anotado)"
  else no "T33o · los datos del intérprete en huellas.json no coinciden: anotado «${o_anotado}», archivo «${o_esperado}»"; fi

  antes="$(find "$TMP/sys2" -type f -print0 | sort -z | xargs -0 shasum 2>/dev/null | shasum | cut -d' ' -f1)"
  PATH="$TMP/bin:$PATH" TYCON_ADO_ORG="$ORG_T19" TYCON_PROD_TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$TMP/sys2" TYCON_PROD_HARNESS="$HARNESS_T19" TYCON_PROD_ACCEPT_ORIGIN=1 bash "$INSTALADOR" --no-sudo >"$TMP/inst-out" 2>&1
  despues="$(find "$TMP/sys2" -type f -print0 | sort -z | xargs -0 shasum 2>/dev/null | shasum | cut -d' ' -f1)"
  [ "$antes" = "$despues" ] && ok "T19d · la segunda ejecución no cambia nada (idempotente)" || no "T19d · la segunda ejecución cambió archivos"

  # T19j · las libs que el freno necesita en /opt/tycon viajan completas: repos-root.js requiere tycon-config.js y
  #        skills-dir.js; sin ellas el freno instalado no puede ni leer el índice
  if [ -f "$TMP/sys2/opt/tycon/lib/tycon-config.js" ] && [ -f "$TMP/sys2/opt/tycon/lib/skills-dir.js" ] \
     && node -e 'require(process.argv[1])' "$TMP/sys2/opt/tycon/lib/repos-root.js" >/dev/null 2>&1; then
    ok "T19j · el repos-root.js instalado carga con sus vecinas (tycon-config.js, skills-dir.js)"
  else no "T19j · el repos-root.js instalado no carga: faltan libs en /opt/tycon/lib"; fi

  # T19k · la organización en cualquiera de sus formas (barra final, <org>.visualstudio.com, espacios) es la MISMA
  #        organización: el instalador acepta el clon del equipo; y una organización ajena lo sigue rechazando (control).
  #        La organización se lee del origin de ESTE clon (ORG_REAL, arriba): la prueba no escribe ninguna a mano.
  #        Si este clon no es el repo en el que confía el instalador (otro repo de la misma organización), se mide lo
  #        mismo sobre el clon de laboratorio de T19, con su organización inventada: con ESTE clon los tres darían rojo
  #        por el remoto, no por la forma de escribir la organización.
  ORG_K="$ORG_REAL"; [ "$HARNESS_T19" = "$AQUI" ] || ORG_K="lab-org"
  if [ -z "$ORG_REAL" ]; then
    echo "⏭ instalar-freno: T19k salteado — el origin de este clon no es de Azure DevOps (no hay organización que comparar)"
  else
    for forma in "https://dev.azure.com/${ORG_K}/" "https://${ORG_K}.visualstudio.com" " https://dev.azure.com/${ORG_K} "; do
      rm -rf "$TMP/sys5"; mkdir -p "$TMP/sys5/Library/Application Support/ClaudeCode" "$TMP/sys5/opt"
      PATH="$TMP/bin:$PATH" TYCON_ADO_ORG="$forma" TYCON_PROD_TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$TMP/sys5" TYCON_PROD_HARNESS="$HARNESS_T19" TYCON_PROD_ACCEPT_ORIGIN=1 bash "$INSTALADOR" --no-sudo >"$TMP/inst-out-k" 2>&1; rc=$?
      if [ "$rc" -eq 0 ]; then ok "T19k · la organización escrita «${forma}» es la del equipo: el instalador acepta el clon"
      else no "T19k · con la organización «${forma}» el instalador rechazó el clon del equipo (rc=$rc): $(grep -m1 -i 'remoto\|organización' "$TMP/inst-out-k")"; fi
    done
    rm -rf "$TMP/sys5"; mkdir -p "$TMP/sys5/Library/Application Support/ClaudeCode" "$TMP/sys5/opt"
    PATH="$TMP/bin:$PATH" TYCON_ADO_ORG="https://dev.azure.com/otra-organizacion" TYCON_PROD_TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$TMP/sys5" TYCON_PROD_HARNESS="$HARNESS_T19" TYCON_PROD_ACCEPT_ORIGIN=1 bash "$INSTALADOR" --no-sudo >"$TMP/inst-out-k" 2>&1; rc=$?
    if [ "$rc" -ne 0 ] && grep -q "no es el del equipo" "$TMP/inst-out-k"; then ok "T19k · control: con otra organización configurada, el clon se rechaza diciéndolo"
    else no "T19k · control: con otra organización el instalador aceptó el clon (rc=$rc)"; fi
  fi

  # T19l · el ORIGEN DE CONFIANZA: la organización sale de archivos que el
  #        asistente puede escribir, así que el `case` no alcanza. La primera instalación fija URL + organización en
  #        /opt/tycon (de root) sólo si una persona confirma por teclado (en pruebas: TYCON_PROD_ACCEPT_ORIGIN=1); un
  #        remoto distinto —misma organización, pasa el case— se niega sin --change-origin, y con el flag pide otra vez
  #        a la persona. Se prueba con un clon FALSO (los archivos del arnés + un `origin` que la prueba controla).
  if [ -z "$ORG_REAL" ]; then
    echo "⏭ instalar-freno: T19l/T19m/T19n/T19o salteados — el origin de este clon no es de Azure DevOps: el origen de confianza queda SIN PROBAR acá (no cuenta como verde)"
  else
    FALSO="$TMP/clon-falso"; rm -rf "$FALSO"; mkdir -p "$FALSO"
    # el perfil del equipo de este árbol, con su nombre actual o el anterior
    PERFIL_AQUI=team-profile.json; [ -f "$AQUI/$PERFIL_AQUI" ] || PERFIL_AQUI=perfil-equipo.json
    for f in $(sed -n '/^ARCHIVOS=(/,/^)/p' "$INSTALADOR" | grep '^  scripts/') scripts/lib/renames.json; do mkdir -p "$FALSO/$(dirname "$f")"; cp "$AQUI/$f" "$FALSO/$f"; done
    cp "$AQUI/$PERFIL_AQUI" "$FALSO/"
    ( cd "$FALSO" && git init -q . && git remote add origin "https://uno@dev.azure.com/${ORG_REAL}/tycon-claude-guides/_git/tycon-claude-guides" ) >/dev/null 2>&1
    rm -rf "$TMP/sys6"; mkdir -p "$TMP/sys6/Library/Application Support/ClaudeCode" "$TMP/sys6/opt"
    FIJADO6="$TMP/sys6/opt/tycon/production/trusted-origin.json"
    inst6(){ local acepta="$1"; shift; env PATH="$TMP/bin:$PATH" TYCON_PROD_TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$TMP/sys6" TYCON_PROD_HARNESS="$FALSO" TYCON_PROD_ACCEPT_ORIGIN="$acepta" bash "$INSTALADOR" --no-sudo "$@"; }
    inst6 0 >"$TMP/o6" 2>&1; rc=$?
    if [ "$rc" -ne 0 ] && grep -q "no confirmado" "$TMP/o6" && [ ! -f "$FIJADO6" ]; then ok "T19l · primera instalación sin persona que confirme: no instala ni fija nada"
    else no "T19l · sin confirmación instaló o fijó algo (rc=$rc): $(tail -1 "$TMP/o6")"; fi
    inst6 1 >"$TMP/o6" 2>&1; rc=$?
    if [ "$rc" -eq 0 ] && grep -q '"url": "https://uno@dev.azure.com' "$FIJADO6" 2>/dev/null && grep -q '"org": "https://dev.azure.com/'"$ORG_REAL"'"' "$FIJADO6"; then ok "T19l · confirmada por la persona: instala y deja fijados la URL y la organización"
    else no "T19l · confirmada, pero no instaló o no fijó el origen (rc=$rc): $(tail -1 "$TMP/o6")"; fi
    antes6="$(shasum "$FIJADO6" | cut -d' ' -f1)"
    inst6 0 >"$TMP/o6" 2>&1; rc=$?   # sin persona: con el mismo origen no hay nada que confirmar (una actualización no pregunta)
    if [ "$rc" -eq 0 ] && [ "$(shasum "$FIJADO6" | cut -d' ' -f1)" = "$antes6" ]; then ok "T19l · la segunda instalación con el mismo origen no pregunta nada ni re-escribe lo fijado"
    else no "T19l · mismo origen: preguntó, falló o re-escribió lo fijado (rc=$rc): $(tail -1 "$TMP/o6")"; fi
    ( cd "$FALSO" && git remote set-url origin "https://dos@dev.azure.com/${ORG_REAL}/tycon-claude-guides/_git/tycon-claude-guides" )
    inst6 1 >"$TMP/o6" 2>&1; rc=$?
    if [ "$rc" -ne 0 ] && grep -q "NO es el que se instaló" "$TMP/o6" && grep -q "uno@" "$TMP/o6" && grep -q "dos@" "$TMP/o6"; then ok "T19l · el remoto cambió (misma organización): se niega y nombra el fijado y el nuevo"
    else no "T19l · con el remoto cambiado instaló igual o no lo dijo (rc=$rc): $(tail -1 "$TMP/o6")"; fi
    inst6 0 --change-origin >"$TMP/o6" 2>&1; rc=$?
    if [ "$rc" -ne 0 ] && grep -q "no confirmado" "$TMP/o6" && grep -q '"url": "https://uno@' "$FIJADO6"; then ok "T19l · --change-origin sin la persona: no instala y lo fijado queda como estaba"
    else no "T19l · --change-origin sin confirmación pasó (rc=$rc): $(tail -1 "$TMP/o6")"; fi
    inst6 1 --change-origin >"$TMP/o6" 2>&1; rc=$?
    if [ "$rc" -eq 0 ] && grep -q '"url": "https://dos@' "$FIJADO6"; then ok "T19l · --change-origin confirmado por la persona: instala y re-fija el origen"
    else no "T19l · --change-origin confirmado no instaló o no re-fijó (rc=$rc): $(tail -1 "$TMP/o6")"; fi

    # T19m · un perfil ILEGIBLE frena con archivo y motivo, no se lee como «sin organización»;
    #        un perfil AUSENTE sí es «sin organización»
    printf '{ roto' > "$FALSO/$PERFIL_AQUI"
    inst6 1 >"$TMP/o6" 2>&1; rc=$?
    if [ "$rc" -ne 0 ] && grep -q "ROTA" "$TMP/o6" && grep -q "$PERFIL_AQUI" "$TMP/o6" && ! grep -q "sin organización de Azure DevOps configurada" "$TMP/o6"; then ok "T19m · perfil ilegible: frena nombrando el archivo y el motivo, no lo disfraza de «sin organización»"
    else no "T19m · perfil ilegible mal reportado (rc=$rc): $(tail -1 "$TMP/o6")"; fi
    rm -f "$FALSO/$PERFIL_AQUI"
    inst6 1 >"$TMP/o6" 2>&1; rc=$?
    if [ "$rc" -ne 0 ] && grep -q "sin organización" "$TMP/o6"; then ok "T19m · perfil ausente (y nada más configurado): «sin organización», que sí es la verdad"
    else no "T19m · perfil ausente mal reportado (rc=$rc): $(tail -1 "$TMP/o6")"; fi
    cp "$AQUI/$PERFIL_AQUI" "$FALSO/"

    # T19n · un origen FIJADO ilegible (sólo root lo escribe: si está roto, alguien con root lo rompió) frena diciéndolo;
    #        no se lee como «vacío» ni se pisa
    cp "$FIJADO6" "$TMP/fijado.bak"; printf '{ roto' > "$FIJADO6"
    inst6 1 --change-origin >"$TMP/o6" 2>&1; rc=$?
    if [ "$rc" -ne 0 ] && grep -q "ilegible" "$TMP/o6" && [ "$(cat "$FIJADO6")" = '{ roto' ]; then ok "T19n · origen fijado ilegible: frena diciéndolo y no lo pisa, ni con --change-origin"
    else no "T19n · origen fijado ilegible mal tratado (rc=$rc): $(tail -1 "$TMP/o6")"; fi
    cp "$TMP/fijado.bak" "$FIJADO6"

    # T19o · el host del remoto se compara ENTERO: un remoto ajeno que sólo lleva «dev.azure.com/<org>» adentro de la ruta
    #        no es el del equipo (un glob `*dev.azure.com/` lo dejaría pasar)
    ( cd "$FALSO" && git remote set-url origin "https://ajeno.example/dev.azure.com/${ORG_REAL}/tycon-claude-guides/_git/tycon-claude-guides" )
    inst6 1 --change-origin >"$TMP/o6" 2>&1; rc=$?
    if [ "$rc" -ne 0 ] && grep -q "no es el del equipo" "$TMP/o6"; then ok "T19o · un remoto ajeno con «dev.azure.com/<org>» adentro de la ruta se rechaza: el host se compara entero"
    else no "T19o · remoto ajeno con el host adentro de la ruta pasó (rc=$rc): $(tail -1 "$TMP/o6")"; fi
    ( cd "$FALSO" && git remote set-url origin "http://dev.azure.com/${ORG_REAL}/tycon-claude-guides/_git/tycon-claude-guides" )
    inst6 1 --change-origin >"$TMP/o6" 2>&1; rc=$?
    if [ "$rc" -ne 0 ] && grep -q "no es https" "$TMP/o6"; then ok "T19o · un remoto por http (sin s) se rechaza"
    else no "T19o · remoto por http pasó (rc=$rc): $(tail -1 "$TMP/o6")"; fi

    # T19p · el mapa de nombres viejos: el arnés del equipo
    #        (con perfil) lo EXIGE —sin él la copia de /opt leería sólo los nombres nuevos, callada—; la copia pública no
    #        lo lleva a propósito (nace con los nombres nuevos y legacy-names.js sin mapa es paso directo), así que sin
    #        perfil y sin mapa instala igual y no deja ningún mapa en /opt
    ( cd "$FALSO" && git remote set-url origin "https://uno@dev.azure.com/${ORG_REAL}/tycon-claude-guides/_git/tycon-claude-guides" )
    MAPA_REL="scripts/lib/renames.json"
    rm -f "$FALSO/$MAPA_REL"
    rm -rf "$TMP/sys6/opt/tycon"; mkdir -p "$TMP/sys6/opt"
    inst6 1 >"$TMP/o6" 2>&1; rc=$?
    if [ "$rc" -ne 0 ] && grep -q "renames.json" "$TMP/o6"; then ok "T19p · arnés del equipo sin el mapa de nombres viejos: no instala y lo nombra"
    else no "T19p · arnés del equipo sin el mapa instaló igual o no lo nombró (rc=$rc): $(tail -1 "$TMP/o6")"; fi
    rm -f "$FALSO/$PERFIL_AQUI"
    rm -rf "$TMP/sys6/opt/tycon"; mkdir -p "$TMP/sys6/opt"
    TYCON_ADO_ORG="https://dev.azure.com/${ORG_REAL}" inst6 1 >"$TMP/o6" 2>&1; rc=$?
    if [ "$rc" -eq 0 ] && [ -f "$TMP/sys6/opt/tycon/lib/legacy-names.js" ] && [ ! -e "$TMP/sys6/opt/tycon/lib/renames.json" ]; then ok "T19p · copia pública (sin perfil ni mapa): instala, y sin mapa en /opt"
    else no "T19p · copia pública sin mapa no instaló, o dejó un mapa (rc=$rc): $(tail -1 "$TMP/o6")"; fi
    cp "$AQUI/$PERFIL_AQUI" "$FALSO/"; cp "$AQUI/$MAPA_REL" "$FALSO/$MAPA_REL"
  fi
fi

# ── T19q · la organización sale del perfil del equipo con su nombre actual (team-profile.json) o con el anterior
#          (perfil-equipo.json); con los dos gana el nuevo, y el anterior ni se lee (roto, no frena). Sólo sobre el clon de
#          laboratorio (nunca se escribe en el clon real). Un perfil hace que el instalador exija el mapa de nombres viejos:
#          si este árbol no lo trae (la copia pública), el laboratorio lleva uno vacío.
if [ -f "$INSTALADOR" ] && [ -n "${HARNESS_T19:-}" ] && [ "$HARNESS_T19" = "$TMP/harness-t19" ]; then
  MAPA_Q=0
  # (mkdir: desde la copia propia del freno, ARCHIVOS no trae nada de scripts/lib/ y el laboratorio no tiene esa carpeta)
  [ -f "$HARNESS_T19/scripts/lib/renames.json" ] || { mkdir -p "$HARNESS_T19/scripts/lib"; printf '{ "retire_after": "2099-01-01", "entries": [] }\n' > "$HARNESS_T19/scripts/lib/renames.json"; MAPA_Q=1; }
  for caso in nuevo viejo ambos; do
    rm -f "$HARNESS_T19/team-profile.json" "$HARNESS_T19/perfil-equipo.json"
    case "$caso" in
      nuevo) printf '{ "ado": { "org": "%s" } }\n' "$ORG_T19" > "$HARNESS_T19/team-profile.json" ;;
      viejo) printf '{ "ado": { "org": "%s" } }\n' "$ORG_T19" > "$HARNESS_T19/perfil-equipo.json" ;;
      ambos) printf '{ "ado": { "org": "%s" } }\n' "$ORG_T19" > "$HARNESS_T19/team-profile.json"; printf '{ roto' > "$HARNESS_T19/perfil-equipo.json" ;;
    esac
    rm -rf "$TMP/sysq"; mkdir -p "$TMP/sysq/Library/Application Support/ClaudeCode" "$TMP/sysq/opt"
    env -u TYCON_ADO_ORG -u ADO_ORG PATH="$TMP/bin:$PATH" TYCON_PROD_TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$TMP/sysq" TYCON_PROD_HARNESS="$HARNESS_T19" TYCON_PROD_ACCEPT_ORIGIN=1 bash "$INSTALADOR" --no-sudo >"$TMP/oq" 2>&1; rc=$?
    if [ "$rc" -eq 0 ] && grep -q "\"org\": \"$ORG_T19\"" "$TMP/sysq/opt/tycon/production/trusted-origin.json" 2>/dev/null; then ok "T19q · perfil «${caso}»: la organización sale del perfil y el freno se instala"
    else no "T19q · perfil «${caso}»: no instaló o no tomó la organización del perfil (rc=$rc): $(tail -1 "$TMP/oq")"; fi
  done
  rm -f "$HARNESS_T19/team-profile.json" "$HARNESS_T19/perfil-equipo.json"
  [ "$MAPA_Q" = 1 ] && rm -f "$HARNESS_T19/scripts/lib/renames.json"
fi

# ── T19e-i · los demás casos del instalador ─────────────────────────────────────────────────
if [ -f "$INSTALADOR" ]; then
  MANAGED_D="$TMP/sys2/Library/Application Support/ClaudeCode/managed-settings.d"
  for regla in 'Bash(/opt/tycon/bin/tycon-prod-sql *)' 'Bash(az sql server firewall-rule *)' 'Edit(//**/.tycon/production.json)'; do
    if grep -qF "$regla" "$MANAGED_D/tycon-production.json" 2>/dev/null; then ok "T19e · la regla de preguntar «${regla}» está en la configuración administrada"
    else no "T19e · falta la regla «${regla}» en la configuración administrada"; fi
  done

  # respaldo: un archivo administrado distinto del nuestro se respalda antes de pisarse
  printf '{"viejo":true}' > "$MANAGED_D/tycon-production.json"
  PATH="$TMP/bin:$PATH" TYCON_ADO_ORG="$ORG_T19" TYCON_PROD_TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$TMP/sys2" TYCON_PROD_HARNESS="$HARNESS_T19" TYCON_PROD_ACCEPT_ORIGIN=1 bash "$INSTALADOR" --no-sudo >"$TMP/inst-out" 2>&1
  if ls "$MANAGED_D"/tycon-production.json.bak-* >/dev/null 2>&1 && grep -q '"viejo"' "$MANAGED_D"/tycon-production.json.bak-* 2>/dev/null; then
    ok "T19f · un archivo administrado distinto se respalda antes de reemplazarse"
  else no "T19f · no dejó respaldo del archivo administrado anterior"; fi

  # huellas completas: puerta, node, sqlcmd, freno y plantilla, todas de 64 hexadecimales
  H="$TMP/sys2/opt/tycon/huellas.json"; faltan=""
  for clave in /opt/tycon/bin/tycon-prod-sql /opt/tycon/bin/node /opt/tycon/bin/sqlcmd /opt/tycon/hooks/prod-access-guard.js /opt/tycon/production/load-key.command.template; do
    grep -qE "\"$clave\"[[:space:]]*:[[:space:]]*\"[a-f0-9]{64}\"" "$H" 2>/dev/null || faltan="$faltan $clave"
  done
  [ -z "$faltan" ] && ok "T19g · las huellas cubren puerta, intérprete, cliente, freno y plantilla" || no "T19g · faltan huellas válidas para:$faltan"

  # 6.2-T33 · el hook que cierra las reglas de firewall se instala de root, con su huella, y la configuración
  # administrada lo registra en el fin de sesión y en el arranque
  if [ -f "$TMP/sys2/opt/tycon/hooks/prod-firewall-close.js" ] \
     && grep -qE '"/opt/tycon/hooks/prod-firewall-close.js"[[:space:]]*:[[:space:]]*"[a-f0-9]{64}"' "$H" 2>/dev/null \
     && grep -q 'prod-firewall-close.js' "$MANAGED_D/tycon-production.json" 2>/dev/null; then
    ok "6.2-T33 · el hook del firewall queda instalado, con huella, y registrado en la configuración administrada"
  else no "6.2-T33 · falta el hook del firewall, su huella o su registro en la configuración administrada"; fi

  # 6.2-T34 · reinstalar con una regla de firewall abierta: el instalador la cierra antes de reemplazar la
  # puerta o, si no puede (acá no hay az), lo dice en rojo con el comando de cierre, y la instalación sigue
  CASA34="$TMP/casa34"; rm -rf "$CASA34"; mkdir -p "$CASA34/.claude/.tycon-pipeline"
  printf '{"reglas":[{"host":"acme-sql.database.windows.net","regla":"tycon-gate-0a1b2c3d","ip":"203.0.113.25","abierta":"2026-10-21T00:00:00Z","sesiones":[]}]}\n' > "$CASA34/.claude/.tycon-pipeline/production-firewall.json"
  HOME="$CASA34" PATH="$TMP/bin:$PATH" TYCON_ADO_ORG="$ORG_T19" TYCON_PROD_TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$TMP/sys2" TYCON_PROD_HARNESS="$HARNESS_T19" TYCON_PROD_ACCEPT_ORIGIN=1 bash "$INSTALADOR" --no-sudo >"$TMP/inst34" 2>&1; rc34=$?
  if [ "$rc34" = 0 ] && grep -q -- "--close-firewall acme-sql.database.windows.net" "$TMP/inst34" && grep -q "🔴" "$TMP/inst34"; then
    ok "6.2-T34 · con una regla abierta y sin poder cerrarla, el instalador lo dice en rojo con el comando y termina"
  else no "6.2-T34 · rc=$rc34 · $(grep -i firewall "$TMP/inst34" | head -2)"; fi

  # M1 · reinstalar con una regla abierta que la puerta instalada SÍ puede cerrar: la cierra con ella, como el dev,
  # ANTES de reemplazarla, lo dice en verde y no avisa en rojo
  # 🔴 Falla con: reemplazar la puerta sin cerrar la regla, cerrarla con la puerta nueva (la regla queda sin quién la
  #    cierre si la nueva falla), o un cierre que salió bien contado como rojo.
  PUERTA_INST="$TMP/sys2/opt/tycon/bin/tycon-prod-sql"
  { printf '#!/usr/bin/env bash\n# doble de la puerta instalada: sabe --close-firewall, anota lo que recibe y cierra bien\n'
    printf 'printf "%%s\\n" "$*" >> "%s/cierre-vieja.log"\nexit 0\n' "$TMP"; } > "$PUERTA_INST"; chmod 755 "$PUERTA_INST"
  rm -f "$TMP/cierre-vieja.log"
  HOME="$CASA34" PATH="$TMP/bin:$PATH" TYCON_ADO_ORG="$ORG_T19" TYCON_PROD_TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$TMP/sys2" TYCON_PROD_HARNESS="$HARNESS_T19" TYCON_PROD_ACCEPT_ORIGIN=1 bash "$INSTALADOR" --no-sudo >"$TMP/inst-m1" 2>&1; rcm1=$?
  if [ "$rcm1" = 0 ] && [ "$(cat "$TMP/cierre-vieja.log" 2>/dev/null)" = "--close-firewall acme-sql.database.windows.net" ] \
     && grep -q "regla de firewall de acme-sql.database.windows.net cerrada antes de reinstalar" "$TMP/inst-m1" \
     && ! grep -i firewall "$TMP/inst-m1" | grep "🔴" >/dev/null && ! grep -q 'cierre-vieja.log' "$PUERTA_INST"; then
    ok "M1 Reinstall_OpenRuleClosable_ClosesWithInstalledGateFirst · la cerró la puerta vieja, en verde, y después la reemplazó"
  else no "M1 · rc=$rcm1 · cierre: $(cat "$TMP/cierre-vieja.log" 2>/dev/null) · $(grep -i firewall "$TMP/inst-m1" | head -2)"; fi

  # --no-sudo corriendo como root: se niega
  rm -rf "$TMP/sys3"; mkdir -p "$TMP/sys3"
  TYCON_PROD_AS_ROOT=1 TYCON_PROD_ROOT="$TMP/sys3" TYCON_PROD_HARNESS="$AQUI" TYCON_PROD_ACCEPT_ORIGIN=1 bash "$INSTALADOR" --no-sudo >/dev/null 2>&1; rc=$?
  if [ "$rc" != 0 ] && [ -z "$(find "$TMP/sys3" -type f 2>/dev/null)" ]; then ok "T19h · el modo de pruebas se niega a correr como root, sin tocar nada"
  else no "T19h · el modo de pruebas corrió como root (rc=$rc)"; fi

  # sin sqlcmd NO instala a medias ni termina con ✅
  rm -rf "$TMP/sys4" "$TMP/sinsql"; mkdir -p "$TMP/sys4" "$TMP/sinsql"; ln -s "$(command -v node)" "$TMP/sinsql/node"
  # 🔴 «falla» sólo no alcanza. Con un clon cuyo remoto el instalador rechaza, esto daría verde por el motivo
  #    equivocado (moriría por el remoto, antes de buscar el cliente). Se instala desde el mismo clon que T19a —que sí
  #    llega a instalar— y se exige que el motivo sea el cliente de base.
  salida="$(TYCON_ADO_ORG="$ORG_T19" TYCON_PROD_TEST_PATH="$TMP/sinsql:/usr/bin:/bin" TYCON_PROD_ROOT="$TMP/sys4" TYCON_PROD_HARNESS="$HARNESS_T19" TYCON_PROD_ACCEPT_ORIGIN=1 bash "$INSTALADOR" --no-sudo 2>&1)"; rc=$?
  if [ "$rc" != 0 ] && ! printf '%s' "$salida" | grep "✅" >/dev/null && printf '%s' "$salida" | grep -i "sqlcmd" >/dev/null; then ok "T19i · sin el cliente de base falla diciéndolo, y no termina en ✅"
  else no "T19i · sin sqlcmd terminó rc=$rc, dijo ✅ o no nombró al cliente: $(printf '%s' "$salida" | tail -1)"; fi
fi

# ── T31 · Installer_GuardRunsFromInstalledCopy ─────────────────────────────
# Caso que lo motiva: si el freno instalado requiere una biblioteca que el instalador no copia (la de las constancias)
# y el `require` está en un `try`, la copia de /opt corre, frena lo que tiene que frenar y
# no anota nada: nadie se entera. Una lista a mano de «lo que el freno requiere» se separa de lo que el freno requiere
# de verdad; por eso esto NO lee los `require` del texto: instala en una raíz falsa, corre el freno INSTALADO con un
# trazador que anota cada archivo que el intérprete busca (lo encuentre o no, dentro de un `try` o no; así se siguen
# también los de production-index.js y la forma `require(require('path').join(__dirname, …))`), y exige que todo lo
# que buscó esté en la copia y venga de un archivo de `ARCHIVOS`. Los comandos recorren los caminos del freno: el que
# pasa, el que frena por un nombre entero, el que frena por una base (índice, raíz de repos, configuración) y el `rm`
# con llaves en alcance.
# T31c: lo que el freno requiere de verdad es lo que el aviso de arranque compara contra lo publicado.
if [ -f "$INSTALADOR" ] && [ -d /opt/tycon ]; then
  echo "⏭ instalar-freno: T31 salteado — con el freno instalado (/opt/tycon), el freno de la raíz falsa no honra sus costuras; se corre con /opt/tycon escondido (sandbox-exec) y lo mide el nocturno."
elif [ -f "$INSTALADOR" ]; then
  R31="$TMP/sys31"; CASA31="$TMP/casa-31"; REPOS31="$TMP/repos-31"
  rm -rf "$R31" "$CASA31" "$REPOS31"
  mkdir -p "$R31/Library/Application Support/ClaudeCode" "$R31/opt" "$CASA31/.claude/shell-snapshots" \
           "$CASA31/.claude/.tycon-pipeline" "$REPOS31/backend-acme/.tycon"
  ( cd "$REPOS31/backend-acme" && git init -q . ) >/dev/null 2>&1
  printf '{"servers":[{"host":"acme-sql.database.windows.net","environment":"produccion","keychain":"tycon-prod-acme"}]}' \
    > "$REPOS31/backend-acme/.tycon/production.json"
  printf '# Snapshot file\n# Functions\n# Aliases\nexport PATH=/usr/bin\n' > "$CASA31/.claude/shell-snapshots/snapshot-zsh-$(date +%s)000-aaaaaa.sh"
  # Los nombres protegidos se arman al correr: el freno vivo frena un comando que los lleva enteros.
  P31=production
  for n in "${P31}-index.json" "${P31}-memory.json"; do printf '{}' > "$CASA31/.claude/.tycon-pipeline/$n"; done
  CMD31_PASA="git status --short"
  CMD31_ENTERO="rm -f ~/.claude/.tycon-pipeline/${P31}-memory.json"
  CMD31_BASE="sqlcmd -S acme-sql.database.windows.net -Q \"select 1\""
  CMD31_LLAVES="rm -f ~/.claude/.tycon-pipeline/${P31}-{index,memory}.json"

  # 🔴 El intérprete que se copia a la raíz falsa tiene que CORRER copiado. Uno de Homebrew carga su biblioteca por
  # ruta relativa y, copiado, aborta (134): por el lanzador eso se ve igual que un freno que frena (el lanzador frena
  # todo lo que nombra una base cuando el intérprete se cae), y la prueba pasaría sin haber corrido el freno.
  NODE31=""; mkdir -p "$TMP/prueba-node-31" "$TMP/bin31"
  for c in $(type -ap node); do
    cp "$c" "$TMP/prueba-node-31/node" 2>/dev/null && "$TMP/prueba-node-31/node" -e 0 >/dev/null 2>&1 && { NODE31="$c"; break; }
  done
  [ -n "$NODE31" ] && ln -sf "$NODE31" "$TMP/bin31/node"
  # el mismo clon del que instala T19: con el de quien corre, sin un origin https de Azure DevOps no instalaría
  PATH="$TMP/bin:$PATH" TYCON_ADO_ORG="$ORG_T19" TYCON_PROD_TEST_PATH="$TMP/bin31:$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 \
    TYCON_PROD_ROOT="$R31" TYCON_PROD_HARNESS="$HARNESS_T19" TYCON_PROD_ACCEPT_ORIGIN=1 bash "$INSTALADOR" --no-sudo >"$TMP/inst-31" 2>&1
  inst31=$?
  if [ -z "$NODE31" ]; then
    no "T31 · ningún node de esta máquina corre copiado a otra carpeta: no puedo correr el freno instalado en la raíz falsa"
  elif [ "$inst31" -ne 0 ] || [ ! -f "$R31/opt/tycon/hooks/prod-access-guard.js" ]; then
    no "T31 · no pude instalar el freno en la raíz falsa: $(tail -1 "$TMP/inst-31")"
  elif ! "$R31/opt/tycon/bin/node" -e 0 >/dev/null 2>&1; then
    no "T31 · el intérprete instalado en la raíz falsa no arranca: el freno instalado no puede correr"
  else
    # el trazador: cada archivo que el intérprete busca, lo encuentre o no
    TRAZADOR31="$TMP/trazador-31.js"
    cat > "$TRAZADOR31" <<'JS'
'use strict';
const Module = require('module'); const fs = require('fs'); const path = require('path');
const destino = process.env.TRACE_31;
const anota = (o) => { if (destino) fs.appendFileSync(destino, JSON.stringify(o) + '\n'); };
anota({ main: path.resolve(process.argv[1] || '') });
const original = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...resto) {
  try {
    const file = original.call(this, request, parent, ...resto);
    anota({ ok: true, request, parent: parent && parent.filename, file });
    return file;
  } catch (e) {
    anota({ ok: false, request, parent: parent && parent.filename, code: e && e.code });
    throw e;
  }
};
JS
    # el juez: lo que el freno instalado buscó contra la copia y contra ARCHIVOS del instalador
    JUEZ31="$TMP/juez-31.js"
    cat > "$JUEZ31" <<'JS'
'use strict';
const fs = require('fs'); const path = require('path');
const [opt, instalador, salida, ...trazas] = process.argv.slice(2);
const real = (f) => { try { return fs.realpathSync(f); } catch { return path.join(real(path.dirname(f)), path.basename(f)); } };
const OPT = real(opt);
const dentro = (f) => f === OPT || f.startsWith(OPT + path.sep);
const texto = fs.readFileSync(instalador, 'utf8');
const bloque = /^ARCHIVOS=\(\n([\s\S]*?)^\)/m.exec(texto);
if (!bloque) { console.log(`no encuentro ARCHIVOS en ${instalador}`); process.exit(1); }
const ARCHIVOS = new Set(bloque[1].split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((l) => l && !l.startsWith('#')));
const vars = {};
for (const m of texto.matchAll(/^([A-Z_]+)=([^\s#()"]+)\s*$/gm)) vars[m[1]] = m[2];
const expande = (s) => s.replace(/^"|"$/g, '').replace(/\$\{?([A-Z_]+)\}?/g, (x, v) => (v in vars ? vars[v] : x));
const copias = {};   // relativo a /opt/tycon → archivo del arnés que el instalador copia ahí
for (const m of texto.matchAll(/\binstalar\s+("[^"]+"|\S+)\s+"\$DESTINO\/([^"]+)"/g)) copias[expande(`"$DESTINO/${m[2]}"`).replace(/^\$DESTINO\//, '')] = expande(m[1]);
const enArnes = (rel) => copias[rel] || rel.replace(/^(hooks|lib|production)\//, 'scripts/$1/');
const errores = new Set(); const requeridos = new Map(); const mains = new Set(); let cargados = 0;
for (const t of trazas) {
  let lineas = [];
  try { lineas = fs.readFileSync(t, 'utf8').split('\n').filter(Boolean); } catch { errores.add(`no hay traza (${t}): el trazador no corrió`); }
  for (const l of lineas) {
    const o = JSON.parse(l);
    if (o.main) { mains.add(real(o.main)); continue; }
    const desde = o.parent ? path.relative(OPT, real(o.parent)) : '?';
    if (o.ok) {
      if (!path.isAbsolute(o.file)) continue;                       // un módulo propio del intérprete (fs, path…)
      const f = real(o.file); cargados++;
      if (!dentro(f)) { errores.add(`el freno instalado cargó ${f}, FUERA de /opt/tycon (pedido «${o.request}» desde ${desde})`); continue; }
      const rel = path.relative(OPT, f);
      if (!copias[rel]) errores.add(`el freno instalado cargó /opt/tycon/${rel}, que el instalador no copia con un nombre conocido`);
      else if (!ARCHIVOS.has(copias[rel])) errores.add(`el freno instalado requiere ${copias[rel]} (en /opt: ${rel}) y no está en ARCHIVOS de install-guard.sh`);
      else if (rel !== 'hooks/prod-access-guard.js') requeridos.set(rel, copias[rel]);
    } else if (o.request.startsWith('.') || path.isAbsolute(o.request)) {
      let objetivo = path.resolve(path.dirname(o.parent || path.join(OPT, 'hooks', 'x')), o.request);
      if (!path.extname(objetivo)) objetivo += '.js';
      const f = real(objetivo);
      if (!dentro(f)) { errores.add(`el freno instalado busca ${f}, FUERA de /opt/tycon (pedido «${o.request}» desde ${desde})`); continue; }
      const rel = path.relative(OPT, f);
      errores.add(`el freno instalado requiere /opt/tycon/${rel} (desde ${desde}) y no está en la copia: falta ${enArnes(rel)} en ARCHIVOS de install-guard.sh`);
    } else {
      errores.add(`el freno instalado requiere el módulo «${o.request}» (desde ${desde}) y el intérprete de /opt no lo encuentra`);
    }
  }
}
const hook = path.join(OPT, 'hooks', 'prod-access-guard.js');
if (!mains.size) errores.add('el trazador no vio arrancar ningún freno');
for (const m of mains) if (m !== hook) errores.add(`el freno que corrió es ${m}, no la copia instalada (${hook})`);
fs.writeFileSync(salida, JSON.stringify({ cargados, requeridos: [...requeridos].map(([opt, repo]) => ({ opt, repo })) }, null, 1));
for (const e of errores) console.log(e);
process.exit(errores.size ? 1 : 0);
JS
    payload31(){ CMD="$1" CWD31="$TMP" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:process.env.CWD31,tool_input:{command:process.env.CMD}}))'; }
    # el freno instalado, directo con su intérprete y el trazador → imprime el código de salida
    # Con «sin-raiz» corre sin TYCON_REPOS_ROOT, como en una máquina de verdad: así el índice se arma resolviendo la raíz
    # de repos (repos-root.js y sus vecinas), un camino que la costura de la raíz saltea.
    directo31(){ # $1 = raíz, $2 = traza, $3 = comando, $4 = «sin-raiz» (opcional)
      local raiz_repos=(); [ "${4:-}" = sin-raiz ] || raiz_repos=(TYCON_REPOS_ROOT="$REPOS31")
      payload31 "$3" | env -u TYCON_REPOS_ROOT HOME="$CASA31" ${raiz_repos[@]+"${raiz_repos[@]}"} TYCON_PROD_SESSION_SINCE=0 TYCON_PROD_ROOT="$1" TRACE_31="$2" \
        "$1/opt/tycon/bin/node" -r "$TRAZADOR31" "$1/opt/tycon/hooks/prod-access-guard.js" >/dev/null 2>"$TMP/err-31"; echo $?; }
    # el índice vuelve a «ilegible» antes de cada camino que lo lee: si no, el primero lo deja fresco y los demás no lo arman
    indiceIlegible31(){ printf '{}' > "$CASA31/.claude/.tycon-pipeline/${P31}-index.json"; }
    # el freno instalado por donde lo corre la configuración administrada: el lanzador instalado
    lanzador31(){ # $1 = raíz, $2 = comando, $3 = dónde dejar lo que dijo
      payload31 "$2" | env HOME="$CASA31" TYCON_REPOS_ROOT="$REPOS31" TYCON_PROD_SESSION_SINCE=0 TYCON_PROD_ROOT="$1" \
        bash "$1/opt/tycon/node-shim.sh" >/dev/null 2>"$3"; echo $?; }
    # frenó EL FRENO (su mensaje), no el lanzador porque el freno no pudo correr
    frenoFreno31(){ grep -q "es a propósito" "$1" && ! grep -q "no pude ejecutarlo" "$1"; }
    recorre31(){ # $1 = raíz, $2 = carpeta de trazas → corre los cinco caminos y deja «nombre=rc» en $2/rc
      rm -rf "$2"; mkdir -p "$2"
      { echo "pasa=$(directo31 "$1" "$2/pasa" "$CMD31_PASA")"
        echo "entero=$(directo31 "$1" "$2/entero" "$CMD31_ENTERO")"
        indiceIlegible31; echo "base=$(directo31 "$1" "$2/base" "$CMD31_BASE")"
        indiceIlegible31; echo "basesinraiz=$(directo31 "$1" "$2/basesinraiz" "$CMD31_BASE" sin-raiz)"
        echo "llaves=$(directo31 "$1" "$2/llaves" "$CMD31_LLAVES")"; } > "$2/rc"
    }
    rc31(){ sed -n "s/^$2=//p" "$1/rc"; }
    juez31(){ # $1 = carpeta de trazas, $2 = salida JSON
      node "$JUEZ31" "$R31/opt/tycon" "$INSTALADOR" "$2" "$1/pasa" "$1/entero" "$1/base" "$1/basesinraiz" "$1/llaves"; }

    recorre31 "$R31" "$TMP/trazas-31"
    if juez31 "$TMP/trazas-31" "$TMP/req-31.json" >"$TMP/juez-31" 2>&1; then
      n="$(node -e 'const r=require(process.argv[1]); console.log(r.requeridos.length + " bibliotecas: " + r.requeridos.map(x=>x.opt).join(", "))' "$TMP/req-31.json")"
      ok "T31a · el freno instalado corre desde su copia y todo lo que requiere está en /opt/tycon y en ARCHIVOS ($n)"
    else no "T31a · el freno instalado no tiene todo lo que requiere: $(tr '\n' ' ' < "$TMP/juez-31")"; fi
    if [ "$(rc31 "$TMP/trazas-31" pasa)" = 0 ] && [ "$(rc31 "$TMP/trazas-31" entero)" = 2 ] && [ "$(rc31 "$TMP/trazas-31" base)" = 2 ] \
       && [ "$(rc31 "$TMP/trazas-31" basesinraiz)" = 2 ]; then
      ok "T31b · el freno instalado pasa lo que no nombra nada y frena el nombre entero y la base (con y sin la raíz de repos)"
    else no "T31b · el freno instalado contestó mal ($(tr '\n' ' ' < "$TMP/trazas-31/rc"))"; fi
    # el `rm` con llaves en alcance: el freno usa el expansor de llaves para verlo.
    if [ "$(rc31 "$TMP/trazas-31" llaves)" = 2 ]; then ok "T31b-llaves · el freno instalado frena el rm con llaves sobre el índice y la memoria"
    else no "T31b-llaves · [8.14-T3] el freno instalado dejó pasar el rm con llaves sobre el índice y la memoria (rc=$(rc31 "$TMP/trazas-31" llaves))"; fi
    # y por el lanzador instalado, que es lo que corre la configuración administrada
    s_pasa="$(lanzador31 "$R31" "$CMD31_PASA" "$TMP/s31-pasa")"; s_entero="$(lanzador31 "$R31" "$CMD31_ENTERO" "$TMP/s31-entero")"
    s_base="$(lanzador31 "$R31" "$CMD31_BASE" "$TMP/s31-base")"
    if [ "$s_pasa" = 0 ] && [ ! -s "$TMP/s31-pasa" ] && [ "$s_entero" = 2 ] && frenoFreno31 "$TMP/s31-entero" \
       && [ "$s_base" = 2 ] && frenoFreno31 "$TMP/s31-base" && ! grep -qs "Cannot find module\|FALLÓ\|lanzador" "$CASA31/.claude/.tycon-pipeline/hook-errors.log"; then
      ok "T31b · por el lanzador instalado, lo mismo, con el mensaje del freno y sin una caída en hook-errors.log"
    else no "T31b · por el lanzador instalado: pasa=$s_pasa entero=$s_entero base=$s_base — $(head -c 160 "$TMP/s31-entero") $(grep -s -m1 'FALLÓ\|Cannot find\|lanzador' "$CASA31/.claude/.tycon-pipeline/hook-errors.log")"; fi
    s_llaves="$(lanzador31 "$R31" "$CMD31_LLAVES" "$TMP/s31-llaves")"
    if [ "$s_llaves" = 2 ] && frenoFreno31 "$TMP/s31-llaves"; then ok "T31b-llaves · por el lanzador instalado también frena el rm con llaves"
    else no "T31b-llaves · [8.14-T3] por el lanzador instalado el rm con llaves salió $s_llaves"; fi

    # el control: un archivo que el freno requiere y que la copia no tiene (lo que pasa si sale de ARCHIVOS) hace fallar
    # al juez nombrándolo — también cuando el `require` está en un `try` y el freno sigue andando sin él
    # la de las constancias, por su nombre actual: el freno la busca primero así, y recién si no
    # está por el nombre anterior (que el instalador también deja en /opt). Sin la actual el freno sigue anotando por
    # la anterior, y el juez igual lo dice: buscó un archivo que la copia no tiene.
    # `lib/skills-dir.js` NO va en este lazo: `repos-root.js` la carga sólo si está al
    # lado, y sin ella cae a lo instalado — una dependencia opcional a propósito (las copias viejas del freno no la
    # traen). Sin ella el freno sigue andando y no la busca: el control daría rojo por diseño. Que, cuando está, el freno
    # la carga lo cubre el positivo de T31a (está en `requeridos` y en ARCHIVOS).
    for falta in lib/guard-record.js production/production-index.js; do
      mv "$R31/opt/tycon/$falta" "$TMP/apartado-31"
      recorre31 "$R31" "$TMP/trazas-31c"
      salida="$(juez31 "$TMP/trazas-31c" "$TMP/req-31c.json" 2>&1)"; rc=$?
      mv "$TMP/apartado-31" "$R31/opt/tycon/$falta"
      if [ "$rc" -ne 0 ] && printf '%s' "$salida" | grep "$(basename "$falta")" >/dev/null; then ok "T31a · control: sin /opt/tycon/${falta}, la prueba falla y lo nombra"
      else no "T31a · control: sin /opt/tycon/${falta} la prueba no falló o no lo nombró (rc=$rc): $(printf '%s' "$salida" | head -c 200)"; fi
    done
    # y el otro lado: con las mismas trazas, un instalador cuyo ARCHIVOS no lleva una biblioteca que el freno requiere
    grep -v '^  scripts/production/guard-libs/lib/tycon-config.js$' "$INSTALADOR" > "$TMP/install-guard-sin-31.sh"
    salida="$(node "$JUEZ31" "$R31/opt/tycon" "$TMP/install-guard-sin-31.sh" "$TMP/req-31d.json" "$TMP"/trazas-31/pasa "$TMP"/trazas-31/entero \
      "$TMP"/trazas-31/base "$TMP"/trazas-31/basesinraiz "$TMP"/trazas-31/llaves 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$salida" | grep "scripts/production/guard-libs/lib/tycon-config.js.*ARCHIVOS" >/dev/null; then
      ok "T31a · control: con scripts/production/guard-libs/lib/tycon-config.js fuera de ARCHIVOS, la prueba falla y lo nombra"
    else no "T31a · control: sacar tycon-config.js de ARCHIVOS no hizo fallar la prueba (rc=$rc): $(printf '%s' "$salida" | head -c 200)"; fi

    # T31c · cada biblioteca que el freno requiere de verdad está entre las piezas que el aviso compara contra lo
    # publicado; y el aviso no compara de más (el costo de reinstalar con sudo se paga sólo por lo que el freno usa)
    salida="$(node -e '
      const req = require(process.argv[1]).requeridos;
      const aviso = require(process.argv[2]);
      const libs = aviso.BIBLIOTECAS_DEL_FRENO;
      if (!Array.isArray(libs)) { console.log("el aviso de arranque no exporta BIBLIOTECAS_DEL_FRENO: no compara las bibliotecas del freno"); process.exit(1); }
      const clave = (x) => x.opt + " ← " + x.repo;
      const del_aviso = new Set(libs.map(clave)); const del_freno = new Set(req.map(clave));
      const faltan = [...del_freno].filter((k) => !del_aviso.has(k)); const sobran = [...del_aviso].filter((k) => !del_freno.has(k));
      if (faltan.length) console.log("el aviso no compara: " + faltan.join(", "));
      if (sobran.length) console.log("el aviso compara y el freno no las requiere: " + sobran.join(", "));
      process.exit(faltan.length || sobran.length ? 1 : 0);
    ' "$TMP/req-31.json" "$AQUI/scripts/hooks/production-notice.js" 2>&1)"
    if [ $? -eq 0 ]; then ok "T31c · el aviso de arranque compara contra lo publicado exactamente las bibliotecas que el freno requiere"
    else no "T31c · $salida"; fi
  fi
fi

# ── T30 · ProductionGuard_TrustsVerifiedHarnessDir_LocalEditRefused_OldWorksUntilReinstall ──
# La máquina mudada a ~/.tycon corre una versión BAJADA (sin git): el instalador no puede hacer `git archive origin/main`.
# Verifica ~/.tycon/harness contra su manifiesto (el blob de git de cada archivo, calculado en el instalador sin cargar código
# del árbol) y contra el árbol que registra el estado, fija el repo de GitHub como origen de confianza (con `repo`, así
# `doctor` distingue el freno nuevo del viejo) y copia tycon-home.js a /opt/tycon/setup/harness/, donde tycon-config.js y
# skills-dir.js lo cargan por su ruta relativa. Un archivo editado frena nombrándolo; un árbol distinto del estado, también.
if [ -f "$INSTALADOR" ]; then
  CASA30="$TMP/casa-30"; ARNES30="$CASA30/.tycon/harness"; SYS30="$TMP/sys30"; ESTADO30="$CASA30/.tycon/state/harness-state.json"
  rm -rf "$CASA30" "$SYS30"; mkdir -p "$ARNES30" "$CASA30/.tycon/state" "$SYS30/Library/Application Support/ClaudeCode" "$SYS30/opt" "$TMP/bin"
  [ -x "$TMP/bin/sudo" ] || { printf '#!/usr/bin/env bash\nexec "$@"\n' > "$TMP/bin/sudo"; chmod +x "$TMP/bin/sudo"; }
  [ -x "$TMP/bin/sqlcmd" ] || { printf '#!/usr/bin/env bash\necho "doble de sqlcmd para T30"; exit 0\n' > "$TMP/bin/sqlcmd"; chmod +x "$TMP/bin/sqlcmd"; }
  for f in $(sed -n '/^ARCHIVOS=(/,/^)/p' "$INSTALADOR" | grep '^  scripts/') scripts/lib/renames.json team-profile.json perfil-equipo.json scripts/lib/git-tree-hash.js; do
    [ -f "$AQUI/$f" ] || continue
    mkdir -p "$ARNES30/$(dirname "$f")"; cp "$AQUI/$f" "$ARNES30/$f"
  done
  # la versión bajada es un COMMIT de un repo que sirve el «GitHub» de juguete (scripts/tests/fixtures/toy-release-server.js):
  # el instalador le pregunta por el árbol del commit y por la punta publicada — lo único que el asistente no puede escribir
  # (el repo de git vive APARTE: ~/.tycon/harness no tiene .git — con uno el instalador la tomaría por un clon)
  SRC30="$TMP/src-30"; rm -rf "$SRC30"; cp -R "$ARNES30" "$SRC30"
  G30(){ git -C "$SRC30" -c user.name=Lab -c user.email=lab@example.com "$@"; }
  G30 init -q -b main >/dev/null 2>&1; G30 add -A >/dev/null; G30 commit -q -m "la versión bajada" >/dev/null
  BARE30="$TMP/bare-30.git"; rm -rf "$BARE30"; git clone -q --bare "$SRC30" "$BARE30"
  SRV30="$TMP/srv-30"; mkdir -p "$SRV30"; printf '{ "auth": "none" }\n' > "$SRV30/control.json"; rm -f "$SRV30/ports.env"
  node "$AQUI/scripts/tests/fixtures/toy-release-server.js" --repo "$BARE30" --org lab-org --name arnes-lab --git "$(command -v git)" --control "$SRV30/control.json" --log "$SRV30/requests.log" --port-file "$SRV30/ports.env" &
  SRV30_PID=$!
  for i in $(seq 1 100); do [ -f "$SRV30/ports.env" ] && break; sleep 0.1; done
  API30="$(sed -n 's/^API=//p' "$SRV30/ports.env" 2>/dev/null)"
  [ -n "$API30" ] || no "T30 · el servidor de versiones de juguete no arrancó"
  # el manifiesto de la versión bajada (.tycon-release.json) con los modos y blobs REALES de git, y el estado de una máquina
  # release que la bajó de ese repo
  manifiesto30(){ # imprime el árbol de HEAD
    local C T; C="$(G30 rev-parse HEAD)"; T="$(G30 rev-parse 'HEAD^{tree}')"
    G30 ls-tree -r HEAD | python3 -c '
import sys, json
files = []
for line in sys.stdin:
    meta, path = line.rstrip("\n").split("\t"); mode, typ, sha = meta.split()
    files.append({"mode": mode, "path": path, "blob": sha})
json.dump({"schema": 1, "version": "2026.10.08.1", "ref": "main", "commit": sys.argv[2], "tree": sys.argv[3], "files": files}, open(sys.argv[1], "w"), indent=1)' "$ARNES30/.tycon-release.json" "$C" "$T"
    printf '%s' "$T"
  }
  COMMIT30="$(G30 rev-parse HEAD)"
  ARBOL30="$(manifiesto30)"
  estado30(){ # $1 = árbol que registra el estado, $2 = commit (por defecto, el HEAD actual del repo de laboratorio)
    printf '{ "schema": 1, "mode": "managed", "source": "public", "tree": "%s", "sources": [ { "name": "harness", "kind": "release", "url": "https://github.com/lab-org/arnes-lab", "repo": "lab-org/arnes-lab", "ref": "main", "commit": "%s", "tree": "%s", "version": "2026.10.08.1" } ], "channel": "stable", "version": { "number": "2026.10.08.1" }, "managed": [] }\n' "$ARNES30" "${2:-$(G30 rev-parse HEAD)}" "$1" > "$ESTADO30"
  }
  estado30 "$ARBOL30"
  instala30(){ PATH="$TMP/bin:$PATH" TYCON_ADO_ORG="https://dev.azure.com/lab-org" TYCON_PROD_TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$SYS30" TYCON_PROD_HARNESS="$ARNES30" TYCON_PROD_STATE="$ESTADO30" TYCON_RELEASE_API="$API30" TYCON_PROD_ACCEPT_ORIGIN=1 HOME="$CASA30" bash "$INSTALADOR" --no-sudo >"$TMP/inst-30" 2>&1; }
  # (a) la versión bajada verificada se instala, con el repo de GitHub fijado y tycon-home.js en /opt
  if instala30; then ok "T30a · instala desde ~/.tycon/harness verificada (sin git)"
  else no "T30a · no instaló desde la versión bajada: $(grep '⛔' "$TMP/inst-30" | head -2 | tr '\n' ' ') — últimas líneas: $(tail -3 "$TMP/inst-30" | tr '\n' ' ' | cut -c1-400)"; fi
  FIJ30="$SYS30/opt/tycon/production/trusted-origin.json"
  if [ -f "$FIJ30" ] && grep -q '"repo": "lab-org/arnes-lab"' "$FIJ30" && grep -q '"url": "https://github.com/lab-org/arnes-lab"' "$FIJ30"; then ok "T30b · el origen de confianza fijado es el repo de GitHub (con «repo»)"
  else no "T30b · el origen fijado no es el repo de GitHub: $(cat "$FIJ30" 2>/dev/null | tr '\n' ' ')"; fi
  if grep -q "verificada contra su manifiesto" "$TMP/inst-30"; then ok "T30c · …y lo dice (verificada contra el manifiesto y el estado)"
  else no "T30c · no dice que verificó: $(grep -i arnés "$TMP/inst-30" | head -2 | tr '\n' ' ')"; fi
  if [ -f "$SYS30/opt/tycon/setup/harness/tycon-home.js" ] && cmp -s "$SYS30/opt/tycon/setup/harness/tycon-home.js" "$AQUI/scripts/production/guard-libs/setup/harness/tycon-home.js"; then ok "T30d · tycon-home.js copiado a /opt/tycon/setup/harness/ (la copia propia del freno, en la misma posición relativa)"
  else no "T30d · falta /opt/tycon/setup/harness/tycon-home.js o no es el del repo"; fi
  # la copia de /opt lee las rutas NUEVAS por tycon-home.js: en una HOME mudada (~/.tycon/state existe) la configuración
  # de la máquina es ~/.tycon/config.json, y las skills instaladas ~/.claude/agent-skills (lo que tycon-home.js diga)
  salida="$(HOME="$CASA30" node -e 'const C = require(process.argv[1]); process.stdout.write(C.nombreArchivoMaquina(process.env.HOME))' "$SYS30/opt/tycon/lib/tycon-config.js" 2>&1)"
  if [ "$salida" = "~/.tycon/config.json" ]; then ok "T30e · la copia de /opt de tycon-config.js lee la configuración en ~/.tycon/config.json (por la copia de tycon-home.js)"
  else no "T30e · la copia de /opt lee «${salida}» en vez de ~/.tycon/config.json"; fi
  salida="$(HOME="$CASA30" TYCON_SKILLS_DIR= node -e 'const S = require(process.argv[1]); process.stdout.write(S.resolveInstalledSkillsDirs().repo)' "$SYS30/opt/tycon/lib/skills-dir.js" 2>&1)"
  if [ "$salida" = "$CASA30/.claude/agent-skills" ]; then ok "T30f · la copia de /opt de skills-dir.js le pide la ruta instalada a tycon-home.js"
  else no "T30f · skills-dir.js de /opt contestó «${salida}»"; fi

  # ── T32 · GuardNotice_OnDownloadedVersion_JudgesAgainstItNotTheMaintainedClone ─────────────────────
  # Una máquina mudada a ~/.tycon que reinstala el freno desde la versión bajada diría en cada arranque «NO coincide
  # con ninguna versión publicada… alguien lo cambió» si el aviso comparara contra origin/main del clon que la máquina
  # mantiene (paths.maintained): lo instalado viene de la versión bajada, que no trae los mismos bytes que ese clon.
  # Corriendo una versión bajada, la referencia es ESA versión (su manifiesto) y, para distinguir «quedó viejo» de
  # «alguien lo cambió» sin historia de git, la constancia que el instalador deja como root.
  NOTICE32="$AQUI/scripts/hooks/production-notice.js"
  CONST32="$SYS30/opt/tycon/production/installed-files.json"
  LIB32="scripts/production/guard-libs/lib/repos-root.js"   # una biblioteca del freno SIN huella en huellas.json: sólo la cuida esta comparación
  # (a) el instalador deja la constancia: el blob de cada archivo que copió, el mismo que trae el manifiesto verificado
  salida="$(python3 - "$CONST32" "$ARNES30/.tycon-release.json" "$INSTALADOR" <<'PY' 2>&1
import json, re, sys
try: c = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e: print("no se lee la constancia: %s" % e); sys.exit(1)
m = {f["path"]: f["blob"] for f in json.load(open(sys.argv[2], encoding="utf-8"))["files"]}
dejado = {f["path"]: f["blob"] for f in c.get("files") or []}
archivos = re.findall(r"^  (scripts/\S+)$", re.search(r"^ARCHIVOS=\(\n(.*?)^\)", open(sys.argv[3], encoding="utf-8").read(), re.S | re.M).group(1), re.M)
faltan = [a for a in archivos if a not in dejado]
distintos = [a for a in dejado if m.get(a) != dejado[a]]
if faltan: print("la constancia no trae: " + ", ".join(faltan))
if distintos: print("blob distinto del manifiesto: " + ", ".join(distintos))
sys.exit(1 if faltan or distintos or not archivos else 0)
PY
)"
  if [ $? -eq 0 ]; then ok "T32a · el instalador deja la constancia de lo instalado: cada archivo de ARCHIVOS con el blob del manifiesto verificado"
  else no "T32a · la constancia de lo instalado ($CONST32): $(printf '%s' "$salida" | head -c 300)"; fi
  # (b) el juicio, sin raíz de laboratorio (se mide también en una máquina con el freno instalado)
  juicio32(){ # $1 = archivo instalado, $2 = ruta en el repo, $3 = manifiesto de la versión que corre, $4 = constancia ("" = sin ella), $5 = la ruta compartida de antes de la copia propia (opcional)
    env -u TF_BUILD node -e '
      const m = require(process.argv[1]);
      const corre = m.blobsDe(process.argv[4]); const dejado = process.argv[5] ? m.blobsDe(process.argv[5]) : null;
      process.stdout.write(String(m.estadoContraVersionBajada(process.argv[2], process.argv[3], corre, dejado, process.argv[6] || undefined)));
    ' "$NOTICE32" "$1" "$2" "$3" "$4" "${5:-}" 2>"$TMP/juicio-32.err"
  }
  # la versión SIGUIENTE: el mismo árbol bajado, con otra biblioteca publicada (el blob de LIB32 cambia en el manifiesto)
  NUEVA32="$TMP/arnes-32-nueva"; rm -rf "$NUEVA32"; cp -R "$ARNES30" "$NUEVA32"
  python3 -c '
import json, sys
p = sys.argv[1]; m = json.load(open(p))
for f in m["files"]:
    if f["path"] == sys.argv[2]: f["blob"] = "c" * 40
json.dump(m, open(p, "w"), indent=1)' "$NUEVA32/.tycon-release.json" "$LIB32"
  INST32="$SYS30/opt/tycon/lib/repos-root.js"
  s="$(juicio32 "$INST32" "$LIB32" "$ARNES30/.tycon-release.json" "$CONST32")"
  [ "$s" = "al-dia" ] && ok "T32b · lo instalado desde la versión que corre es «al día»" || no "T32b · lo instalado desde la versión que corre salió «${s}» — $(head -c 200 "$TMP/juicio-32.err")"
  s="$(juicio32 "$INST32" "$LIB32" "$NUEVA32/.tycon-release.json" "$CONST32")"
  [ "$s" = "vieja" ] && ok "T32c · el arnés se actualizó y el freno no: «vieja» (es lo que dejó el instalador), no «alterada»" || no "T32c · tras una versión nueva salió «${s}»"
  cp "$INST32" "$TMP/retocada-32.js"; printf '\n// retocada en /opt\n' >> "$TMP/retocada-32.js"
  s="$(juicio32 "$TMP/retocada-32.js" "$LIB32" "$ARNES30/.tycon-release.json" "$CONST32")"
  [ "$s" = "alterada" ] && ok "T32d · gemelo: una biblioteca retocada en /opt sigue siendo «alterada» (ni la versión que corre ni lo que dejó el instalador)" || no "T32d · una biblioteca retocada salió «${s}»"
  s="$(juicio32 "$TMP/retocada-32.js" "$LIB32" "$NUEVA32/.tycon-release.json" "$CONST32")"
  [ "$s" = "alterada" ] && ok "T32e · …y también con el arnés ya actualizado: retocada no pasa por «vieja»" || no "T32e · retocada, con una versión nueva, salió «${s}»"
  s="$(juicio32 "$INST32" "$LIB32" "$NUEVA32/.tycon-release.json" "")"
  [ "$s" = "vieja" ] && ok "T32f · un freno instalado antes de la constancia, distinto de la versión que corre: «vieja» (reinstalar la deja escrita)" || no "T32f · sin constancia salió «${s}»"
  s="$(juicio32 "$INST32" "scripts/lib/no-publicada.js" "$ARNES30/.tycon-release.json" "$CONST32")"
  [ "$s" = "sin-publicado" ] && ok "T32g · lo que la versión que corre no trae no se pudo comparar («sin-publicado»), no «al día»" || no "T32g · una ruta que la versión no trae salió «${s}»"
  # (b2) LA TRANSICIÓN A LA COPIA PROPIA: un freno instalado antes de ella tiene la constancia con las rutas de
  # las bibliotecas COMPARTIDAS, de donde se copiaban. Con la versión siguiente es «vieja» —por la ruta de antes—, no
  # «alterada»; sin esa ruta, la misma constancia daría «alterada» (el control); y retocada sigue siendo «alterada».
  CONST32V="$TMP/constancia-32-antes-de-la-copia.json"
  python3 - "$CONST32" "$CONST32V" <<'PY'
import json, sys
c = json.load(open(sys.argv[1], encoding="utf-8"))
for f in c["files"]:
    p = f["path"]
    if p.startswith("scripts/production/guard-libs/lib/"): f["path"] = "scripts/lib/" + p.rsplit("/", 1)[1]
    elif p == "scripts/production/guard-libs/setup/harness/tycon-home.js": f["path"] = "scripts/setup/harness/tycon-home.js"
json.dump(c, open(sys.argv[2], "w", encoding="utf-8"), indent=1)
PY
  ANTES32="scripts/lib/repos-root.js"
  s="$(juicio32 "$INST32" "$LIB32" "$NUEVA32/.tycon-release.json" "$CONST32V" "$ANTES32")"
  [ "$s" = "vieja" ] && ok "T32p · un freno instalado antes de la copia propia, con una versión nueva: «vieja» (lo reconoce por la ruta de la compartida)" || no "T32p · instalado antes de la copia propia salió «${s}» — $(head -c 200 "$TMP/juicio-32.err")"
  s="$(juicio32 "$INST32" "$LIB32" "$NUEVA32/.tycon-release.json" "$CONST32V")"
  [ "$s" = "alterada" ] && ok "T32p · control: sin la ruta de antes, esa constancia daría «alterada» (la transición se apoya en ella)" || no "T32p · control: sin la ruta de antes salió «${s}»"
  s="$(juicio32 "$TMP/retocada-32.js" "$LIB32" "$NUEVA32/.tycon-release.json" "$CONST32V" "$ANTES32")"
  [ "$s" = "alterada" ] && ok "T32p · gemelo: retocada, con la constancia de antes de la copia propia, sigue siendo «alterada»" || no "T32p · retocada con la constancia de antes salió «${s}»"
  salida="$(env -u TF_BUILD node -e '
    const m = require(process.argv[1]);
    const r = [m.instaladoConCopiaPropia(m.blobsDe(process.argv[2])), m.instaladoConCopiaPropia(m.blobsDe(process.argv[3])), m.instaladoConCopiaPropia(null)];
    process.stdout.write(r.join(","));
  ' "$NOTICE32" "$CONST32" "$CONST32V" 2>&1)"
  [ "$salida" = "true,false,false" ] && ok "T32q · la constancia dice si el freno instalado ya es el de la copia propia (sí con la nueva; no con la de antes ni sin constancia)" || no "T32q · instaladoConCopiaPropia contestó «${salida}» (esperaba true,false,false)"
  # (c) de punta a punta. El aviso honra la raíz de laboratorio sólo si /opt/tycon no existe de verdad: en una máquina
  # con el freno se saltea DICIÉNDOLO y lo mide la validación, que corre sin freno instalado.
  if [ -d /opt/tycon ]; then
    echo "⏭ instalar-freno: T32h-o salteados — con el freno instalado, el aviso ignora la raíz de laboratorio; los mide la validación."
  else
    # la máquina mudada, con el clon que mantiene DECLARADO: un repo con las mismas piezas y otros bytes, como el interno
    CASA32="$TMP/casa-32"; INTERNO32="$TMP/interno-32"; REPOS32="$TMP/repos-32"
    rm -rf "$CASA32" "$INTERNO32" "$REPOS32"; mkdir -p "$CASA32/.tycon/state" "$INTERNO32" "$REPOS32/backend-acme/.tycon" "$SYS30/usr/bin"
    cp "$ESTADO30" "$CASA32/.tycon/state/harness-state.json"
    printf '{ "paths": { "maintained": "%s" } }\n' "$INTERNO32" > "$CASA32/.tycon/config.json"
    for f in $(sed -n '/^ARCHIVOS=(/,/^)/p' "$INSTALADOR" | grep '^  scripts/'); do
      mkdir -p "$INTERNO32/$(dirname "$f")"; cp "$AQUI/$f" "$INTERNO32/$f"; printf '\n# otros bytes: el clon que se mantiene no es la copia que se baja\n' >> "$INTERNO32/$f"
    done
    ( cd "$INTERNO32" && git init -q -b main . && git add -A && git -c user.name=Lab -c user.email=lab@example.com commit -q -m interno && git update-ref refs/remotes/origin/main HEAD ) >/dev/null 2>&1
    printf '{"servers":[{"host":"acme-test.example.com","environment":"no-produccion"}]}' > "$REPOS32/backend-acme/.tycon/production.json"
    git -C "$REPOS32/backend-acme" init -q . >/dev/null 2>&1
    printf '#!/usr/bin/env bash\nexit 44\n' > "$SYS30/usr/bin/security"; chmod +x "$SYS30/usr/bin/security"
    aviso32(){ # $1 = el árbol de la versión que corre
      env -u TF_BUILD HOME="$CASA32" TYCON_REPOS_ROOT="$REPOS32" TYCON_GUIDES_DIR="$1" TYCON_PROD_ROOT="$SYS30" TYCON_PRODUCTION_AUTOINSTALL=0 node "$NOTICE32" --report 2>&1
    }
    out="$(aviso32 "$ARNES30")"
    if printf '%s' "$out" | grep "al día y con sus huellas" >/dev/null && ! printf '%s' "$out" | grep "alguien lo cambió\|NO coincide" >/dev/null; then
      ok "T32h · recién instalado desde la versión bajada, con un clon declarado de otros bytes: «al día», nunca «alguien lo cambió»"
    else no "T32h · el aviso tras instalar desde la versión bajada — $(printf '%s' "$out" | head -c 400)"; fi
    out="$(aviso32 "$NUEVA32")"
    if printf '%s' "$out" | grep "el freno quedó viejo: reinstalalo" >/dev/null && printf '%s' "$out" | grep "repos-root.js" >/dev/null && ! printf '%s' "$out" | grep "alguien lo cambió" >/dev/null; then
      ok "T32i · el arnés bajó una versión nueva: «el freno quedó viejo: reinstalalo», nombrando la biblioteca, y no «alguien lo cambió»"
    # el rojo muestra las líneas que decide la condición, no los primeros 400 caracteres: un rojo con «quedó viejo» y
    # «repos-root.js» a la vista podría dejar fuera del recorte lo que lo hizo fallar
    else no "T32i · con una versión nueva — $(printf '%s\n' "$out" | grep -E 'quedó viejo|repos-root\.js|alguien lo cambió' | head -8 | cut -c1-300) [$(printf '%s' "$out" | wc -l | tr -d ' ') líneas]"; fi
    cp "$INST32" "$TMP/guardada-32.js"; printf '\n// retocada en /opt\n' >> "$INST32"
    out="$(aviso32 "$ARNES30")"
    if printf '%s' "$out" | grep "alguien lo cambió" >/dev/null && printf '%s' "$out" | grep "repos-root.js" >/dev/null; then ok "T32j · gemelo: tocar una biblioteca en /opt sigue gritando «alguien lo cambió» y la nombra"
    else no "T32j · con una biblioteca retocada en /opt — $(printf '%s' "$out" | head -c 400)"; fi
    cp "$TMP/guardada-32.js" "$INST32"
    # un freno instalado antes de la constancia: con una versión nueva es «quedó viejo»; igual a la que corre, «al día»
    mv "$CONST32" "$TMP/constancia-32.json"
    out="$(aviso32 "$NUEVA32")"
    if printf '%s' "$out" | grep "el freno quedó viejo: reinstalalo" >/dev/null && ! printf '%s' "$out" | grep "alguien lo cambió" >/dev/null; then ok "T32k · sin constancia (instalado antes de ella) y una versión nueva: «quedó viejo», no «alguien lo cambió»"
    else no "T32k · sin constancia — $(printf '%s' "$out" | head -c 400)"; fi
    # una constancia que está y no se lee no se toma por «no hay»: se dice
    printf '{ roto' > "$CONST32"
    out="$(aviso32 "$ARNES30")"
    if printf '%s' "$out" | grep "no pude leer la constancia" >/dev/null; then ok "T32l · una constancia ilegible se dice (no se lee como «no hay constancia»)"
    else no "T32l · con la constancia rota — $(printf '%s' "$out" | head -c 400)"; fi
    mv -f "$TMP/constancia-32.json" "$CONST32"
    # y un manifiesto de la versión que corre ilegible: «no pude leer», no «al día»
    ROTA32="$TMP/arnes-32-rota"; rm -rf "$ROTA32"; cp -R "$ARNES30" "$ROTA32"; printf '{ roto' > "$ROTA32/.tycon-release.json"
    out="$(aviso32 "$ROTA32")"
    if printf '%s' "$out" | grep "no pude leer el manifiesto de la versión bajada" >/dev/null && ! printf '%s' "$out" | grep "al día y con sus huellas" >/dev/null; then ok "T32m · con el manifiesto de la versión ilegible lo dice, y no da «al día»"
    else no "T32m · con el manifiesto roto — $(printf '%s' "$out" | head -c 400)"; fi
    # el aviso corriendo DESDE la versión bajada con TYCON_GUIDES_DIR apuntando al clon (una variable que quedó de antes
    # de la mudanza): el arnés que corre es la versión bajada, y contra ella se juzga
    CORRE32="$TMP/arnes-32-corre"; rm -rf "$CORRE32"; cp -R "$ARNES30" "$CORRE32"; mkdir -p "$CORRE32/scripts/hooks"; cp "$NOTICE32" "$CORRE32/scripts/hooks/"
    out="$(env -u TF_BUILD HOME="$CASA32" TYCON_REPOS_ROOT="$REPOS32" TYCON_GUIDES_DIR="$INTERNO32" TYCON_PROD_ROOT="$SYS30" TYCON_PRODUCTION_AUTOINSTALL=0 node "$CORRE32/scripts/hooks/production-notice.js" --report 2>&1)"
    if printf '%s' "$out" | grep "al día y con sus huellas" >/dev/null && ! printf '%s' "$out" | grep "alguien lo cambió\|NO coincide" >/dev/null; then
      ok "T32n · con TYCON_GUIDES_DIR apuntando al clon, el aviso que corre desde la versión bajada juzga contra ella: «al día»"
    else no "T32n · el aviso desde la versión bajada con TYCON_GUIDES_DIR al clon — $(printf '%s' "$out" | head -c 400)"; fi
    # y la constancia rota con una biblioteca retocada: se dicen las dos cosas, ninguna calla
    cp "$CONST32" "$TMP/constancia-32.json"; printf '{ roto' > "$CONST32"; cp "$INST32" "$TMP/guardada-32.js"; printf '\n// retocada en /opt\n' >> "$INST32"
    out="$(aviso32 "$ARNES30")"
    if printf '%s' "$out" | grep "no pude leer la constancia" >/dev/null && printf '%s' "$out" | grep "repos-root.js" >/dev/null && printf '%s' "$out" | grep "🔴" >/dev/null; then ok "T32o · constancia ilegible y una biblioteca retocada: lo dice, en rojo, y nombra la biblioteca"
    else no "T32o · constancia rota con una biblioteca retocada — $(printf '%s' "$out" | head -c 400)"; fi
    cp "$TMP/guardada-32.js" "$INST32"; mv -f "$TMP/constancia-32.json" "$CONST32"
    # la transición, de punta a punta: con la constancia de antes de la copia propia, la reinstalación lo explica (es la
    # última por cambios ajenos al freno) y no grita «alguien lo cambió»; con la nueva, el texto de la transición no sale
    cp "$CONST32" "$TMP/constancia-32.json"; cp "$CONST32V" "$CONST32"
    out="$(aviso32 "$NUEVA32")"
    if printf '%s' "$out" | grep "el freno quedó viejo: reinstalalo" >/dev/null && printf '%s' "$out" | grep "su propia copia de las bibliotecas" >/dev/null && ! printf '%s' "$out" | grep "alguien lo cambió" >/dev/null; then
      ok "T32r · instalado antes de la copia propia y una versión nueva: «quedó viejo», explica que es por la copia propia, y no «alguien lo cambió»"
    else no "T32r · instalado antes de la copia propia — $(printf '%s\n' "$out" | grep -E 'quedó viejo|propia copia|alguien lo cambió' | head -6 | cut -c1-300)"; fi
    mv -f "$TMP/constancia-32.json" "$CONST32"
    out="$(aviso32 "$NUEVA32")"
    if printf '%s' "$out" | grep "el freno quedó viejo: reinstalalo" >/dev/null && ! printf '%s' "$out" | grep "su propia copia de las bibliotecas" >/dev/null; then
      ok "T32s · instalado con la copia propia: si algo del freno cambia pide reinstalar, sin el texto de la transición"
    else no "T32s · instalado con la copia propia — $(printf '%s\n' "$out" | grep -E 'quedó viejo|propia copia' | head -6 | cut -c1-300)"; fi
    # La copia propia: una versión nueva que cambia SÓLO las bibliotecas compartidas (las de scripts/lib/ y
    # scripts/setup/harness/) no le pide reinstalar a nadie
    COMPARTIDA32="$TMP/arnes-32-compartida"; rm -rf "$COMPARTIDA32"; cp -R "$ARNES30" "$COMPARTIDA32"
    python3 -c '
import json, sys
p = sys.argv[1]; m = json.load(open(p))
m["files"] = [f for f in m["files"] if f["path"] not in ("scripts/lib/repos-root.js", "scripts/setup/harness/tycon-home.js")]
m["files"] += [{"mode": "100644", "path": "scripts/lib/repos-root.js", "blob": "d" * 40}, {"mode": "100644", "path": "scripts/setup/harness/tycon-home.js", "blob": "e" * 40}]
json.dump(m, open(p, "w"), indent=1)' "$COMPARTIDA32/.tycon-release.json"
    out="$(aviso32 "$COMPARTIDA32")"
    if printf '%s' "$out" | grep "al día y con sus huellas" >/dev/null && ! printf '%s' "$out" | grep "quedó viejo" >/dev/null; then
      ok "T32t · una versión que cambia sólo las bibliotecas compartidas no pide reinstalar: el freno sigue «al día»"
    else no "T32t · con sólo las compartidas cambiadas — $(printf '%s\n' "$out" | grep -E 'quedó viejo|al día|🔴|🟠' | head -6 | cut -c1-300)"; fi
    rm -f "$SYS30/usr/bin/security"
  fi

  # (b) un archivo editado en ~/.tycon/harness: no se instala, y se nombra
  rm -rf "$SYS30/opt/tycon"; mkdir -p "$SYS30/opt"
  printf '\n// editado a mano en la máquina\n' >> "$ARNES30/scripts/production/guard-libs/lib/skills-dir.js"
  if ! instala30 && grep -q 'skills-dir.js (editado)' "$TMP/inst-30" && grep -q 'NO es la publicada' "$TMP/inst-30"; then ok "T30g · un archivo editado en la versión bajada frena la instalación y lo nombra"
  else no "T30g · con skills-dir.js editado: rc $? — $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-200)"; fi
  [ -d "$SYS30/opt/tycon" ] && no "T30g · …y además dejó algo en /opt/tycon" || ok "T30h · …sin dejar nada en /opt"
  cp "$AQUI/scripts/production/guard-libs/lib/skills-dir.js" "$ARNES30/scripts/production/guard-libs/lib/skills-dir.js"
  # (c) la carpeta no es la que registra el estado (otro árbol): tampoco
  estado30 "$(printf 'b%.0s' $(seq 1 40))"
  if ! instala30 && grep -q 'no es el que registra el estado' "$TMP/inst-30"; then ok "T30i · un árbol distinto del que registra el estado frena y lo dice"
  else no "T30i · con el estado de otro árbol: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-200)"; fi
  estado30 "$ARBOL30"
  # (d) y un archivo que falta
  mv "$ARNES30/scripts/production/guard-libs/lib/guard-record.js" "$TMP/guard-record.30"
  if ! instala30 && grep -q 'guard-record.js (falta)' "$TMP/inst-30"; then ok "T30j · un archivo que falta en la versión bajada frena y lo nombra"
  else no "T30j · con guard-record.js faltante: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-200)"; fi
  mv "$TMP/guard-record.30" "$ARNES30/scripts/production/guard-libs/lib/guard-record.js"
  # (e) 🔴 el manifiesto y el estado FORJADOS para que cierren con un archivo editado: el
  # blob y el árbol recalculados con git; GitHub dice otro árbol para ese commit → no se instala
  printf '\n// editado a mano, con el manifiesto y el estado acomodados\n' >> "$ARNES30/scripts/production/guard-libs/lib/skills-dir.js"
  cp "$ARNES30/scripts/production/guard-libs/lib/skills-dir.js" "$SRC30/scripts/production/guard-libs/lib/skills-dir.js"
  python3 - "$ARNES30" "$SRC30" "$ESTADO30" <<'PY'
import json, os, subprocess, sys
arnes, src, estado = sys.argv[1], sys.argv[2], sys.argv[3]
nb = subprocess.check_output(["git", "-C", src, "hash-object", "scripts/production/guard-libs/lib/skills-dir.js"]).decode().strip()
m = json.load(open(arnes + "/.tycon-release.json"))
for f in m["files"]:
    if f["path"] == "scripts/production/guard-libs/lib/skills-dir.js": f["blob"] = nb
env = dict(os.environ, GIT_INDEX_FILE=src + "/.git/forjado.idx")
subprocess.run(["git", "-C", src, "add", "-A"], env=env, check=True)
t = subprocess.check_output(["git", "-C", src, "write-tree"], env=env).decode().strip()
m["tree"] = t; json.dump(m, open(arnes + "/.tycon-release.json", "w"))
s = json.load(open(estado)); s["sources"][0]["tree"] = t; json.dump(s, open(estado, "w"))
PY
  if ! instala30 && grep -q 'NO es el del commit' "$TMP/inst-30" && grep -q 'GitHub' "$TMP/inst-30"; then ok "T30k · manifiesto y estado forjados con un archivo editado: GitHub dice otro árbol y no se instala"
  else no "T30k · el forjado pasó o frenó por otro motivo: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  [ -d "$SYS30/opt/tycon" ] && no "T30k · …y dejó algo en /opt/tycon" || ok "T30l · …sin dejar nada en /opt"
  G30 checkout -q -- scripts/production/guard-libs/lib/skills-dir.js; rm -f "$SRC30/.git/forjado.idx"; cp "$AQUI/scripts/production/guard-libs/lib/skills-dir.js" "$ARNES30/scripts/production/guard-libs/lib/skills-dir.js"; ARBOL30="$(manifiesto30)"; estado30 "$ARBOL30"
  # (f) la versión instalada ya no es la punta publicada (alguien publicó otra). Con más de 30
  # publicaciones por día, una cada ~10 min, exigir la punta exacta haría casi imposible instalar el freno. Vale un commit
  # PUBLICADO de main (GitHub: «behind» respecto de la punta) cuyo freno sea byte a byte el de la punta: instala y avisa.
  # Lo que la regla de la punta cuida sigue frenando: una rama (fuera de main), un freno viejo, y GitHub sin contestar.
  C1_30="$(G30 rev-parse HEAD)"
  printf 'otra\n' > "$SRC30/CHANGES"; G30 add -A >/dev/null; G30 commit -q -m "otra versión" >/dev/null; C2_30="$(G30 rev-parse HEAD)"; G30 push -q "$BARE30" main >/dev/null 2>&1; G30 reset -q --hard HEAD~1; ARBOL30="$(manifiesto30)"; estado30 "$ARBOL30"
  rm -rf "$SYS30/opt/tycon"; mkdir -p "$SYS30/opt"
  if instala30 && grep -q 'hay una versión más nueva' "$TMP/inst-30" && grep -q "main ${C2_30:0:7}, 1 commit adelante" "$TMP/inst-30" && grep -q 'Actualizá cuando puedas' "$TMP/inst-30" && [ -f "$SYS30/opt/tycon/hooks/prod-access-guard.js" ]; then ok "T30m · una versión de main atrasada, con el mismo freno que la punta, instala y avisa que hay una más nueva"
  else no "T30m · atrasada con el mismo freno: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240) — $(grep '⚠' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  # (f2) 🔴 atrasada y el freno CAMBIÓ en la punta (un arreglo del freno publicado después): una versión vieja verifica contra
  # GitHub igual, y el asistente la puede bajar — no se instala un freno viejo
  G30 reset -q --hard "$C2_30"; printf '\n// arreglo del freno publicado después\n' >> "$SRC30/scripts/production/guard-libs/lib/skills-dir.js"; G30 add -A >/dev/null; G30 commit -q -m "arreglo del freno" >/dev/null; G30 push -q "$BARE30" main >/dev/null 2>&1; G30 reset -q --hard "$C1_30"; ARBOL30="$(manifiesto30)"; estado30 "$ARBOL30"
  rm -rf "$SYS30/opt/tycon"; mkdir -p "$SYS30/opt"
  if ! instala30 && grep -q 'es de main pero VIEJA' "$TMP/inst-30" && grep -q 'scripts/production/guard-libs/lib/skills-dir.js' "$TMP/inst-30" && [ ! -d "$SYS30/opt/tycon" ]; then ok "T30m2 · una versión de main atrasada con el freno cambiado en la punta frena, nombra el archivo y no deja nada en /opt"
  else no "T30m2 · atrasada con otro freno en la punta: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  G30 push -q -f "$BARE30" main >/dev/null 2>&1
  # (f3) 🔴 un commit que no está en main (una rama publicada en el repo, o un cambio local): GitHub lo sirve por su sha
  # con su árbol, pero respecto de la punta es «ahead» — frena
  printf 'rama\n' > "$SRC30/RAMA"; cp "$SRC30/RAMA" "$ARNES30/RAMA"; G30 add -A >/dev/null; G30 commit -q -m "una rama" >/dev/null; G30 push -q "$BARE30" HEAD:refs/heads/otra >/dev/null 2>&1; ARBOL30="$(manifiesto30)"; estado30 "$ARBOL30"
  if ! instala30 && grep -q 'NO es un commit publicado de main' "$TMP/inst-30" && grep -q 'ahead' "$TMP/inst-30" && [ ! -d "$SYS30/opt/tycon" ]; then ok "T30m3 · un commit de una rama (fuera de main) frena aunque GitHub lo sirva con su árbol"
  else no "T30m3 · commit fuera de main: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  rm -f "$ARNES30/RAMA"; G30 reset -q --hard "$C1_30"; git -C "$BARE30" update-ref -d refs/heads/otra; ARBOL30="$(manifiesto30)"; estado30 "$ARBOL30"
  # (f4) 🔴 atrasada y GitHub no contesta la comparación (caído, o 403 por el límite de consultas): no es «está bien», frena
  git -C "$SRC30" push -q -f "$BARE30" "$C2_30:refs/heads/main" >/dev/null 2>&1
  for cod30 in 503 403; do
    printf '{ "auth": "none", "compare_status": %s }\n' "$cod30" > "$SRV30/control.json"
    if ! instala30 && grep -q "GitHub contestó $cod30 al comparar" "$TMP/inst-30" && [ ! -d "$SYS30/opt/tycon" ]; then ok "T30m4 · atrasada y la comparación de GitHub contesta $cod30: frena"
    else no "T30m4 · comparación con $cod30: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  done
  printf '{ "auth": "none" }\n' > "$SRV30/control.json"
  G30 push -q -f "$BARE30" main >/dev/null 2>&1
  # (f5) T15 · sin permiso y con el github.com de juguete (TYCON_RELEASE_GIT): las puntas salen de info/refs, sin
  # la API; a la API le queda el commit (1) y, con una versión atrasada, la comparación y el árbol de la punta (3 pedidos en total)
  GIT30="$(sed -n 's/^GIT=//p' "$SRV30/ports.env" 2>/dev/null)"
  api30(){ grep -c '"host":"api"' "$SRV30/requests.log" 2>/dev/null || true; }
  rm -rf "$SYS30/opt/tycon"; mkdir -p "$SYS30/opt"; : > "$SRV30/requests.log"
  if TYCON_RELEASE_GIT="$GIT30" instala30 && grep -q 'info/refs' "$SRV30/requests.log" && ! grep -q 'git/ref/heads' "$SRV30/requests.log" && [ "$(api30)" = 1 ]; then ok "T15 · sin permiso, las puntas de info/refs: una sola consulta a la API (el commit)"
  else no "T15 · puntas sin la API (consultas a la API: $(api30)): $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  git -C "$SRC30" push -q -f "$BARE30" "$C2_30:refs/heads/main" >/dev/null 2>&1
  rm -rf "$SYS30/opt/tycon"; mkdir -p "$SYS30/opt"; : > "$SRV30/requests.log"
  if TYCON_RELEASE_GIT="$GIT30" instala30 && grep -q 'hay una versión más nueva' "$TMP/inst-30" && ! grep -q 'git/ref/heads' "$SRV30/requests.log" && [ "$(api30)" = 3 ]; then ok "T15 · atrasada y sin permiso: las puntas de info/refs; a la API, el commit, la comparación y el árbol de la punta (3)"
  else no "T15 · atrasada sin la API para las puntas (consultas a la API: $(api30)): $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  # la API agotada: no instala y dice el tope y su hora, nunca «GitHub contestó 403»
  RESET30=$(( $(date +%s) + 1800 )); HORA30="$(python3 -c "import time,sys; print(time.strftime('%H:%M', time.localtime(int(sys.argv[1]))))" "$RESET30")"
  printf '{ "auth": "none", "ratelimit": true, "ratelimit_reset": %s }\n' "$RESET30" > "$SRV30/control.json"
  rm -rf "$SYS30/opt/tycon"; mkdir -p "$SYS30/opt"
  if ! TYCON_RELEASE_GIT="$GIT30" instala30 && grep -q "hasta las $HORA30" "$TMP/inst-30" && ! grep -q 'GitHub contestó 403' "$TMP/inst-30" && [ ! -d "$SYS30/opt/tycon" ]; then ok "T15 · con la API agotada: no instala y dice el tope y la hora ($HORA30), sin «GitHub contestó 403»"
  else no "T15 · API agotada: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  printf '{ "auth": "none" }\n' > "$SRV30/control.json"
  G30 push -q -f "$BARE30" main >/dev/null 2>&1
  # con sudo, github.com es SIEMPRE el real: TYCON_RELEASE_GIT es sólo de las pruebas, como TYCON_RELEASE_API
  if grep -qF 'if [ "$SIN_SUDO" = 0 ]; then GIT_GITHUB="https://github.com"' "$INSTALADOR"; then ok "T15 · con sudo, las puntas se leen del github.com real (TYCON_RELEASE_GIT se ignora)"
  else no "T15 · el instalador no fija github.com real con sudo"; fi
  # (g) el repo es privado y la máquina no tiene el permiso guardado: 404 con la única acción; con el permiso, instala
  printf '{ "auth": "token:permiso-de-laboratorio" }\n' > "$SRV30/control.json"
  if ! instala30 && grep -q 'config set github.token' "$TMP/inst-30"; then ok "T30n · repo privado sin permiso guardado: no instala y dice la acción (config set github.token)"
  else no "T30n · sin permiso: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  mkdir -p "$CASA30/.tycon"; printf '{ "github": { "token": "permiso-de-laboratorio" } }\n' > "$CASA30/.tycon/config.json"
  if instala30 && [ -f "$SYS30/opt/tycon/production/trusted-origin.json" ]; then ok "T30o · con el permiso guardado en ~/.tycon/config.json, instala"
  else no "T30o · con el permiso guardado: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  if ! grep -q 'permiso-de-laboratorio' "$TMP/inst-30" && ! grep -rq 'permiso-de-laboratorio' "$SYS30/opt" 2>/dev/null; then ok "T30p · el permiso no aparece en la salida ni en /opt"
  else no "T30p · el permiso de GitHub quedó escrito en la salida o en /opt"; fi
  # T10/T15 · con el permiso guardado, los pedidos del freno a la API son los de antes (el commit y las dos
  # puntas), aunque haya un github.com de juguete: con permiso no se usan las rutas públicas
  rm -rf "$SYS30/opt/tycon"; mkdir -p "$SYS30/opt"; : > "$SRV30/requests.log"
  if TYCON_RELEASE_GIT="$GIT30" instala30 && [ "$(grep '"host":"api"' "$SRV30/requests.log" | grep -c 'git/commits/')" = 1 ] && [ "$(grep '"host":"api"' "$SRV30/requests.log" | grep -c 'git/ref/heads/')" = 2 ] && ! grep -q 'info/refs' "$SRV30/requests.log"; then ok "T15 · con permiso, el freno pide a la API lo mismo que antes (el commit y las dos puntas), sin info/refs"
  else no "T15 · con permiso, los pedidos cambiaron: $(sed 's/.*"path":"\([^"]*\)".*/\1/' "$SRV30/requests.log" | tr '\n' ' ')"; fi
  # T34 · el permiso guardado VENCIÓ y el repo es público (GitHub contesta 401 al permiso, 200 sin él): instala
  # sin el permiso y dice en una línea que venció, que no hace falta y cómo sacarlo
  printf '{ "auth": "none", "reject_unknown_token": true }\n' > "$SRV30/control.json"
  printf '{ "github": { "token": "permiso-vencido-de-laboratorio" } }\n' > "$CASA30/.tycon/config.json"
  rm -rf "$SYS30/opt/tycon"; mkdir -p "$SYS30/opt"; : > "$SRV30/requests.log"
  if TYCON_RELEASE_GIT="$GIT30" instala30 && [ -f "$SYS30/opt/tycon/production/trusted-origin.json" ] && grep -q 'no hace falta: el repo del arnés es público' "$TMP/inst-30" && grep -q 'config unset github.token' "$TMP/inst-30" && grep -q 'info/refs' "$SRV30/requests.log"; then
    ok "T34 · el permiso guardado vencido con el repo público: instala sin él y dice cómo sacarlo"
  else no "T34 · permiso guardado vencido: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240) · $(tail -2 "$TMP/inst-30" | tr '\n' ' ' | cut -c1-240)"; fi
  printf '{ "auth": "token:permiso-de-laboratorio" }\n' > "$SRV30/control.json"
  printf '{ "github": { "token": "permiso-de-laboratorio" } }\n' > "$CASA30/.tycon/config.json"
  # (h) un archivo puesto a mano en ~/.tycon/harness que la versión NO trae (renames.json en una versión pública): su sola
  # presencia no lo mete en /opt
  rm -rf "$SYS30/opt/tycon"; mkdir -p "$SYS30/opt"
  if [ -f "$ARNES30/scripts/lib/renames.json" ]; then
    MAPA_BAK30="$TMP/renames.30"; mv "$ARNES30/scripts/lib/renames.json" "$MAPA_BAK30"
    # el manifiesto SIN el mapa (la versión pública no lo trae), y el mapa puesto a mano en el disco
    G30 rm -q --cached scripts/lib/renames.json >/dev/null 2>&1; G30 commit -q -m "sin el mapa" >/dev/null; G30 push -q -f "$BARE30" main >/dev/null 2>&1; ARBOL30="$(manifiesto30)"; estado30 "$ARBOL30"
    cp "$MAPA_BAK30" "$ARNES30/scripts/lib/renames.json"
    if instala30 && [ ! -e "$SYS30/opt/tycon/lib/renames.json" ]; then ok "T30q · un mapa de nombres puesto a mano, que la versión no trae, NO entra a /opt (CON_MAPA lo decide el manifiesto)"
    else no "T30q · el mapa fuera del manifiesto: rc=$? /opt tiene renames.json: $([ -e "$SYS30/opt/tycon/lib/renames.json" ] && echo sí || echo no) — $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-200)"; fi
    # y un archivo de ARCHIVOS que la versión publicada NO trae (el manifiesto y GitHub cierran sin él) pero está en el disco:
    # el instalador no copia nada que no esté verificado, frena nombrándolo
    rm -rf "$SYS30/opt/tycon"; mkdir -p "$SYS30/opt"
    G30 rm -q --cached scripts/production/guard-libs/lib/skills-dir.js >/dev/null 2>&1; G30 commit -q -m "sin skills-dir" >/dev/null; G30 push -q -f "$BARE30" main >/dev/null 2>&1; ARBOL30="$(manifiesto30)"; estado30 "$ARBOL30"
    if ! instala30 && grep -q 'skills-dir.js está en' "$TMP/inst-30" && grep -q 'NO en el manifiesto' "$TMP/inst-30"; then ok "T30r · un archivo a copiar que la versión publicada no trae (sólo está en el disco) frena y lo nombra"
    else no "T30r · archivo fuera del manifiesto: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
    cp "$MAPA_BAK30" "$SRC30/scripts/lib/renames.json"; G30 add -A >/dev/null; G30 commit -q -m "con el mapa y skills-dir" >/dev/null; G30 push -q -f "$BARE30" main >/dev/null 2>&1; ARBOL30="$(manifiesto30)"; estado30 "$ARBOL30"
  fi
  # (i) una máquina instalada con `install --version` CON Claude Code tiene el estado donde siempre, no en ~/.tycon/state:
  # el instalador lo mira donde esté
  rm -rf "$SYS30/opt/tycon"; mkdir -p "$SYS30/opt" "$CASA30/.claude/.tycon-pipeline"; mv "$ESTADO30" "$CASA30/.claude/.tycon-pipeline/harness-state.json"; rmdir "$CASA30/.tycon/state" 2>/dev/null
  if PATH="$TMP/bin:$PATH" TYCON_ADO_ORG="https://dev.azure.com/lab-org" TYCON_PROD_TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$SYS30" TYCON_PROD_HARNESS="$ARNES30" TYCON_RELEASE_API="$API30" TYCON_PROD_ACCEPT_ORIGIN=1 HOME="$CASA30" bash "$INSTALADOR" --no-sudo >"$TMP/inst-30" 2>&1; then ok "T30s · con el estado en la carpeta de siempre (instalada con Claude Code), instala igual"
  else no "T30s · estado en la carpeta de siempre: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  # (j) 🔴 el ancla contra un repo AJENO que GitHub verifica igual: el origen fijado en
  # /opt (root) la primera vez; otro repo en el estado —aunque exista y cierre— exige --change-origin y la confirmación por
  # teclado, como en el modo clon. (El estado vuelve a ~/.tycon/state para este caso.)
  mkdir -p "$CASA30/.tycon/state"; mv "$CASA30/.claude/.tycon-pipeline/harness-state.json" "$ESTADO30"
  # (u) 🔴 LA MUDANZA OFICIAL A GITHUB. Una máquina que instaló desde el clon de Azure
  # tiene ese clon fijado; la versión bajada de GitHub frenaría pidiendo --change-origin. Declarada en origin-moves.json (al
  # lado del instalador; en pruebas, TYCON_PROD_ORIGIN_MOVES), se acepta SOLA —sin teclado— y se dice; otro clon fijado,
  # otro repo de destino o lo fijado desde GitHub siguen frenando; una lista rota frena diciéndolo.
  MUD30="$TMP/origin-moves-30.json"
  mudanzas30(){ printf '{ "moves": [ { "from": { "azure_path": "tycon-claude-guides/_git/tycon-claude-guides" }, "to": { "github_repo": "%s" }, "message": "el arnés se mudó a GitHub: actualizo el origen fijado" } ] }\n' "$1" > "$MUD30"; }
  fijado30(){ printf '{ "url": "%s", "org": "%s", "fijado": "2026-09-01T00:00:00Z" }\n' "$1" "$2" > "$FIJ30"; }
  instala30m(){ PATH="$TMP/bin:$PATH" TYCON_ADO_ORG="https://dev.azure.com/lab-org" TYCON_PROD_TEST_PATH="$TMP/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" TYCON_PROD_NODE_LOCAL=1 TYCON_PROD_ROOT="$SYS30" TYCON_PROD_HARNESS="$ARNES30" TYCON_PROD_STATE="$ESTADO30" TYCON_RELEASE_API="$API30" TYCON_PROD_ACCEPT_ORIGIN=0 TYCON_PROD_ORIGIN_MOVES="$MUD30" HOME="$CASA30" bash "$INSTALADOR" --no-sudo >"$TMP/inst-30" 2>&1; }
  mudanzas30 lab-org/arnes-lab; USR30='alguien@'   # el usuario de la URL, armado por partes (escrito junto parece un correo al freno de publicación)
  fijado30 "https://${USR30}dev.azure.com/lab-org/tycon-claude-guides/_git/tycon-claude-guides" "https://dev.azure.com/lab-org"
  if instala30m && grep -q 'el arnés se mudó a GitHub: actualizo el origen fijado' "$TMP/inst-30" && grep -q '"repo": "lab-org/arnes-lab"' "$FIJ30" && grep -q '"url": "https://github.com/lab-org/arnes-lab"' "$FIJ30"; then ok "T30u · la mudanza oficial (clon de Azure fijado → el repo de GitHub declarado): instala sin teclado, lo dice y re-fija el origen"
  else no "T30u · la mudanza oficial no se aceptó sola: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240) — fijado: $(tr '\n' ' ' < "$FIJ30")"; fi
  fijado30 "https://dev.azure.com/lab-org/otro-proyecto/_git/otro-repo" "https://dev.azure.com/lab-org"
  if ! instala30m && grep -q 'NO es el que se instaló la última vez' "$TMP/inst-30" && ! grep -q 'se mudó a GitHub' "$TMP/inst-30" && grep -q 'otro-repo' "$FIJ30"; then ok "T30u · otro clon de Azure fijado: la mudanza no aplica y frena como siempre (lo fijado queda)"
  else no "T30u · otro clon fijado no frenó o tocó lo fijado: $(grep -E '⛔|mudó' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  fijado30 "https://dev.azure.com/lab-org/tycon-claude-guides/_git/tycon-claude-guides" "https://dev.azure.com/lab-org"; mudanzas30 otro-lab/arnes-ajeno
  if ! instala30m && grep -q 'NO es el que se instaló la última vez' "$TMP/inst-30" && grep -q '"url": "https://dev.azure.com/lab-org/tycon' "$FIJ30"; then ok "T30u · la mudanza declarada va a OTRO repo de GitHub: instalar éste frena como siempre"
  else no "T30u · un destino distinto del declarado pasó: $(grep -E '⛔|mudó' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  mudanzas30 lab-org/arnes-lab; fijado30 "https://dev.azure.com/lab-org/tycon-claude-guides/_git/tycon-claude-guides" "https://dev.azure.com/otra-org"
  if ! instala30m && grep -q 'NO es el que se instaló la última vez' "$TMP/inst-30"; then ok "T30u · un fijado cuya organización no es la de su URL: la mudanza no aplica"
  else no "T30u · fijado con organización cruzada pasó: $(grep -E '⛔|mudó' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  fijado30 "https://github.com/viejo-lab/otro" "github:viejo-lab/otro"
  printf '{ "url": "https://github.com/viejo-lab/otro", "org": "github:viejo-lab/otro", "repo": "viejo-lab/otro" }\n' > "$FIJ30"
  if ! instala30m && grep -q 'NO es el que se instaló la última vez' "$TMP/inst-30"; then ok "T30u · lo fijado desde GitHub (con «repo») no es un clon de Azure: la mudanza no aplica"
  else no "T30u · un fijado de GitHub se tomó como mudanza: $(grep -E '⛔|mudó' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  fijado30 "https://dev.azure.com/lab-org/tycon-claude-guides/_git/tycon-claude-guides" "https://dev.azure.com/lab-org"; printf '{ roto' > "$MUD30"
  if ! instala30m && grep -q 'mudanzas oficiales del origen está ROTA' "$TMP/inst-30"; then ok "T30u · la lista de mudanzas rota frena diciéndolo (no se lee como «sin mudanza»)"
  else no "T30u · lista de mudanzas rota: $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  # la lista real, al lado del instalador: trae la mudanza oficial y nada más
  if python3 -c 'import json,sys; m=json.load(open(sys.argv[1]))["moves"]; sys.exit(0 if [(x["from"]["azure_path"], x["to"]["github_repo"]) for x in m]==[("tycon-claude-guides/_git/tycon-claude-guides","TYCON-SA/tycon-harness")] else 1)' "$AQUI/scripts/production/origin-moves.json"; then ok "T30u · origin-moves.json declara la mudanza oficial (el clon de Azure → TYCON-SA/tycon-harness) y ninguna otra"
  else no "T30u · origin-moves.json no declara exactamente la mudanza oficial"; fi
  # con sudo la variable de pruebas no cuenta: la lista sale SIEMPRE de al lado del instalador
  if grep -q 'if \[ "\$SIN_SUDO" = 1 \] && \[ -n "\${TYCON_PROD_ORIGIN_MOVES:-}" \]' "$INSTALADOR"; then ok "T30u · TYCON_PROD_ORIGIN_MOVES sólo vale en --no-sudo"
  else no "T30u · TYCON_PROD_ORIGIN_MOVES no está atada a --no-sudo"; fi
  # lo fijado vuelve a ser el repo de GitHub del laboratorio: el caso (j) que sigue lo compara contra un repo ajeno
  printf '{ "url": "https://github.com/lab-org/arnes-lab", "org": "github:lab-org/arnes-lab", "repo": "lab-org/arnes-lab" }\n' > "$FIJ30"
  # el «GitHub» de juguete pasa a servir el MISMO contenido bajo otro repo (el ajeno existe y verifica), y el estado lo nombra
  kill "$SRV30_PID" 2>/dev/null; wait "$SRV30_PID" 2>/dev/null; rm -f "$SRV30/ports.env"; printf '{ "auth": "none" }\n' > "$SRV30/control.json"
  node "$AQUI/scripts/tests/fixtures/toy-release-server.js" --repo "$BARE30" --org otro-lab --name arnes-ajeno --git "$(command -v git)" --control "$SRV30/control.json" --log "$SRV30/requests.log" --port-file "$SRV30/ports.env" &
  SRV30_PID=$!
  for i in $(seq 1 100); do [ -f "$SRV30/ports.env" ] && break; sleep 0.1; done
  API30="$(sed -n 's/^API=//p' "$SRV30/ports.env" 2>/dev/null)"
  python3 -c "
import json,sys; p=sys.argv[1]; s=json.load(open(p)); s['sources'][0]['url']='https://github.com/otro-lab/arnes-ajeno'; s['sources'][0]['repo']='otro-lab/arnes-ajeno'; json.dump(s, open(p,'w'))" "$ESTADO30"
  if ! instala30 && grep -q 'NO es el que se instaló la última vez' "$TMP/inst-30" && grep -q 'otro-lab/arnes-ajeno' "$TMP/inst-30"; then ok "T30t · un repo de GitHub distinto del fijado en /opt frena aunque exista y verifique (sin --change-origin ni teclado no hay cambio de origen)"
  else no "T30t · otro repo en el estado: rc=$? — $(grep '⛔' "$TMP/inst-30" | head -1 | cut -c1-240)"; fi
  estado30 "$ARBOL30"
  kill "$SRV30_PID" 2>/dev/null; wait "$SRV30_PID" 2>/dev/null
fi

# ── T34 · la copia propia del freno ──────────────────────────────────────────────────────────────────────
# Sin la copia propia, el aviso de arranque pediría reinstalar el freno —con la contraseña del Mac— casi en cada versión
# del arnés, porque compararía las bibliotecas COMPARTIDAS, que cambian todo el tiempo por motivos que no son del freno.
# El freno lleva su propia copia (scripts/production/guard-libs/), que se actualiza a conciencia.
#   (a) el instalador no instala ninguna biblioteca compartida, cada copia declarada se instala, y el aviso compara cada
#       copia (con la compartida de la que salía antes, para la transición) y nada compartido;
#   (b) el control de quien mantiene (guard-libs-check.js): sobre el repo, en verde; en un laboratorio, una diferencia en lo
#       que el freno usa frena nombrándola y diciendo las dos salidas, una en lo que no usa se dice y no frena, y las dos
#       decisiones (dejar la copia, refrescarla) quedan anotadas y lo dejan en verde.
GL34="scripts/production/guard-libs"
salida="$(node - "$INSTALADOR" "$AQUI/scripts/hooks/production-notice.js" "$AQUI/$GL34/sources.json" <<'JS' 2>&1
const fs = require('fs');
const [inst, notice, sources] = process.argv.slice(2);
const bloque = /^ARCHIVOS=\(\n([\s\S]*?)^\)/m.exec(fs.readFileSync(inst, 'utf8'));
if (!bloque) { console.log('no encuentro ARCHIVOS en el instalador'); process.exit(1); }
const archivos = bloque[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const errores = [];
for (const a of archivos) if (/^scripts\/(lib|setup)\//.test(a)) errores.push(`ARCHIVOS instala ${a}, una biblioteca compartida`);
const copias = JSON.parse(fs.readFileSync(sources, 'utf8')).files;
const deDonde = new Map(copias.map((f) => [`scripts/production/guard-libs/${f.copy}`, f.source]));
for (const c of deDonde.keys()) if (!archivos.includes(c)) errores.push(`la copia ${c} no está en ARCHIVOS: no se instala`);
const m = require(notice);
for (const b of m.BIBLIOTECAS_DEL_FRENO) {
  if (!b.repo.startsWith(m.COPIA_PROPIA)) {
    if (!b.repo.startsWith('scripts/production/') || b.antes) errores.push(`el aviso compara ${b.repo}, que no es ni de la copia propia ni una pieza del freno`);
    continue;
  }
  if (!deDonde.has(b.repo)) errores.push(`el aviso compara ${b.repo}, que sources.json no declara`);
  else if (deDonde.get(b.repo) !== b.antes) errores.push(`el aviso dice que ${b.repo} salía de ${b.antes}; sources.json, de ${deDonde.get(b.repo)}`);
}
for (const c of deDonde.keys()) if (!m.BIBLIOTECAS_DEL_FRENO.some((b) => b.repo === c)) errores.push(`la copia ${c} se instala y el aviso no la compara`);
for (const e of errores) console.log(e);
process.exit(errores.length ? 1 : 0);
JS
)"
if [ $? -eq 0 ]; then ok "T34a · el freno se instala con su copia propia: ninguna biblioteca compartida en ARCHIVOS, y el aviso compara cada copia y nada compartido"
else no "T34a · $(printf '%s' "$salida" | tr '\n' ' ' | cut -c1-400)"; fi

CHECK34="$AQUI/scripts/production/guard-libs-check.js"
node "$CHECK34" >"$TMP/chk34-repo" 2>&1; rc=$?
if [ "$rc" -eq 0 ]; then ok "T34b · la copia propia está al día con lo que decidió quien mantiene (guard-libs-check.js sale 0)"
else no "T34b · guard-libs-check.js sobre el repo salió $rc: $(tr '\n' ' ' < "$TMP/chk34-repo" | cut -c1-400)"; fi

LAB34="$TMP/lab-34"; rm -rf "$LAB34"
for f in "$GL34" scripts/production/guard-libs-check.js scripts/hooks/prod-access-guard.js scripts/production/production-index.js scripts/production/tycon-prod-sql $(node -e 'for (const f of require(process.argv[1]).files) console.log(f.source)' "$AQUI/$GL34/sources.json"); do
  mkdir -p "$LAB34/$(dirname "$f")"; cp -R "$AQUI/$f" "$LAB34/$f"
done
chk34(){ node "$LAB34/scripts/production/guard-libs-check.js" --repo "$LAB34" "$@" >"$TMP/chk34" 2>&1; echo $?; }
COMP34="$LAB34/scripts/lib/repos-root.js"; ORIG34="$TMP/repos-root-34.js"; cp "$COMP34" "$ORIG34"
COPIA34="$LAB34/$GL34/lib/repos-root.js"
# lo que el freno usa: el cuerpo de resolveReposRoot (lo llama el índice de producción)
node -e 'const f=require("fs"),p=process.argv[1];f.writeFileSync(p,f.readFileSync(p,"utf8").replace(/^(function resolveReposRoot\(.*\{)$/m,"$1\n  const cambioDePrueba = 1; void cambioDePrueba;"))' "$COMP34"
rc="$(chk34)"
if [ "$rc" = 1 ] && grep -q "lib/repos-root.js" "$TMP/chk34" && grep -q "resolveReposRoot (cambió)" "$TMP/chk34" && grep -q "refresh lib/repos-root.js" "$TMP/chk34" && grep -q "keep lib/repos-root.js" "$TMP/chk34"; then
  ok "T34c · la compartida cambió en lo que el freno usa: frena, dice qué (resolveReposRoot) y las dos salidas (refresh / keep)"
else no "T34c · cambio en lo que el freno usa: rc=$rc — $(tr '\n' ' ' < "$TMP/chk34" | cut -c1-400)"; fi
# lo que el freno no usa: describir (sólo la línea de comandos) y una función nueva
cp "$ORIG34" "$COMP34"
node -e 'const f=require("fs"),p=process.argv[1];f.writeFileSync(p,f.readFileSync(p,"utf8").replace(/^(function describir\(.*\{)$/m,"$1\n  const otraCosa = 2; void otraCosa;")+"\nfunction nuevaSinUsoEnElFreno() { return 1; }\n")' "$COMP34"
rc="$(chk34)"
if [ "$rc" = 0 ] && grep -q "sólo en lo que el freno no usa" "$TMP/chk34" && grep -q "describir (cambió)" "$TMP/chk34" && grep -q "nuevaSinUsoEnElFreno" "$TMP/chk34"; then
  ok "T34d · la compartida cambió sólo en lo que el freno no usa: lo dice (describir, la función nueva) y no frena"
else no "T34d · cambio en lo que el freno no usa: rc=$rc — $(tr '\n' ' ' < "$TMP/chk34" | cut -c1-400)"; fi
# keep: con el cambio en lo usado, se deja la copia → queda anotado, la copia no cambia y deja de frenar
cp "$ORIG34" "$COMP34"
node -e 'const f=require("fs"),p=process.argv[1];f.writeFileSync(p,f.readFileSync(p,"utf8").replace(/^(function resolveReposRoot\(.*\{)$/m,"$1\n  const cambioDePrueba = 1; void cambioDePrueba;"))' "$COMP34"
cp "$COPIA34" "$TMP/copia-34.js"
rc_keep="$(chk34 keep lib/repos-root.js)"; rc="$(chk34)"
if [ "$rc_keep" = 0 ] && [ "$rc" = 0 ] && cmp -s "$COPIA34" "$TMP/copia-34.js" && grep -q "ya se decidió dejar la copia" "$TMP/chk34" && grep -q "\"reviewed\": \"$(git hash-object "$COMP34")\"" "$LAB34/$GL34/sources.json"; then
  ok "T34e · «keep»: la copia queda como estaba, se anota el blob de la compartida y deja de frenar"
else no "T34e · keep: rc=$rc_keep, después rc=$rc — $(tr '\n' ' ' < "$TMP/chk34" | cut -c1-300)"; fi
# …hasta que la compartida vuelve a cambiar en lo que el freno usa
node -e 'const f=require("fs"),p=process.argv[1];f.writeFileSync(p,f.readFileSync(p,"utf8").replace("const cambioDePrueba = 1;","const cambioDePrueba = 3;"))' "$COMP34"
rc="$(chk34)"
[ "$rc" = 1 ] && ok "T34f · lo anotado vale para ESE cambio: si la compartida vuelve a cambiar en lo que el freno usa, vuelve a frenar" || no "T34f · tras otro cambio salió $rc — $(tr '\n' ' ' < "$TMP/chk34" | cut -c1-300)"
# refresh: la copia pasa a ser la compartida, y queda en verde
rc_ref="$(chk34 refresh lib/repos-root.js)"; rc="$(chk34)"
if [ "$rc_ref" = 0 ] && [ "$rc" = 0 ] && cmp -s "$COPIA34" "$COMP34" && grep -q "\"reviewed\": \"$(git hash-object "$COMP34")\"" "$LAB34/$GL34/sources.json"; then
  ok "T34g · «refresh»: la copia pasa a ser la compartida, se anota, y queda en verde"
else no "T34g · refresh: rc=$rc_ref, después rc=$rc"; fi
# un archivo en la carpeta de la copia que sources.json no declara: frena nombrándolo
printf '// suelto\n' > "$LAB34/$GL34/lib/suelto.js"
rc="$(chk34)"
if [ "$rc" = 1 ] && grep -q "lib/suelto.js no está declarado" "$TMP/chk34"; then ok "T34h · un archivo en la copia propia que sources.json no declara frena y lo nombra"
else no "T34h · archivo sin declarar: rc=$rc — $(tr '\n' ' ' < "$TMP/chk34" | cut -c1-300)"; fi

echo "— instalar-freno: $pasaron ok, $fallos fallos —"
[ "$fallos" -eq 0 ]
