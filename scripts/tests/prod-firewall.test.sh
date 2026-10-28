#!/usr/bin/env bash
# prod-firewall.test.sh — la puerta de producción abre y cierra la regla de firewall de la máquina, y la cierra sola
# al terminar la sesión que la abrió.
#
# POR QUÉ EXISTE: con la IP de la máquina sin regla en el firewall de un servidor de producción, el freno corta el
# comando de Azure que la crearía (aunque el dev lo autorice en el chat) y la puerta sólo sabía consultar: el dev
# terminaba creando y borrando la regla a mano. Y una regla que un asistente deja viva en producción es justo lo que el
# freno existe para evitar. Ahora la puerta abre UNA regla con nombre fijo por máquina, para una sola IP sacada del
# rechazo de Azure, y el hook `prod-firewall-close.js` la cierra al terminar la sesión o en el próximo arranque.
#
# 🔴 Ningún caso toca Azure, una base, el Llavero ni /opt: raíz de sistema falsa (TYCON_PROD_ROOT), HOME falso, y
# dobles de `az`, `sqlcmd`, `security` e `ioreg` que anotan lo que reciben.
#
# Correr: bash scripts/tests/prod-firewall.test.sh
# En una máquina con el freno instalado (/opt/tycon) la puerta ignora la raíz falsa (a propósito) y la suite no corre:
# para medirla ahí, esconder /opt/tycon con sandbox-exec (perfil que niega file-read*, file-read-metadata y
# file-test-existence sobre /opt/tycon).
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PUERTA="$AQUI/scripts/production/tycon-prod-sql"
HOOK="$AQUI/scripts/hooks/prod-firewall-close.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ prod-firewall: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ prod-firewall: $1"; fallos=$((fallos+1)); }

if [ -d /opt/tycon ]; then
  echo "⏭ prod-firewall: esta máquina tiene el freno instalado (/opt/tycon): la suite no corre para no tocar Azure ni el Llavero reales."
  exit 0
fi

PROD=acme-sql.database.windows.net
CORTO=acme-sql
STAGING=acme-sql-staging.database.windows.net
PROPIO=acme-onprem.example.test
CLAVE_MARCA='M4RC4-DE-L4-CL4VE'
SONDA=tycon-gate-probe   # el usuario del intento de conexión, que también va como su clave
IP_PUB=203.0.113.25
SES_A=11111111-aaaa-4aaa-8aaa-111111111111
SES_B=22222222-bbbb-4bbb-8bbb-222222222222

mundo(){ # arma la raíz falsa, la casa y los repos, y deja los dobles listos
  RAIZ="$TMP/sys"; CASA="$TMP/casa"; REPOS="$TMP/repos"
  rm -rf "$RAIZ" "$CASA" "$REPOS" "$TMP"/*.log "$TMP/az-reglas"
  mkdir -p "$RAIZ/opt/tycon/bin" "$RAIZ/usr/bin" "$RAIZ/usr/sbin" "$RAIZ/opt/homebrew/bin" \
    "$CASA/.claude/.tycon-pipeline" "$CASA/.claude/projects/p" "$REPOS/backend-acme/.tycon"
  ( cd "$REPOS/backend-acme" && git init -q . ) >/dev/null 2>&1
  cat > "$REPOS/backend-acme/.tycon/production.json" <<JSON
{"servers":[{"host":"$PROD","environment":"produccion","keychain":"tycon-prod-acme"},
            {"host":"$STAGING","environment":"no-produccion"},
            {"host":"$PROPIO","environment":"produccion","keychain":"tycon-prod-nuevo","port":14330}]}
JSON
  : > "$TMP/az-reglas"
  # security: anota; nunca debería llamarse para abrir o cerrar el firewall
  cat > "$RAIZ/usr/bin/security" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMP/security.log"
printf '%s\n' "$CLAVE_MARCA"
SH
  # ioreg: el identificador del equipo
  cat > "$RAIZ/usr/sbin/ioreg" <<SH
#!/usr/bin/env bash
printf '  "IOPlatformUUID" = "%s"\n' "\${FAKE_UUID:-equipo-de-prueba-uno}"
SH
  # sqlcmd: lo que contesta Azure SQL al intentar entrar, según FAKE_SQLCMD
  cat > "$RAIZ/opt/tycon/bin/sqlcmd" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMP/sqlcmd.log"
printf 'SQLCMDPASSWORD=%s\n' "\${SQLCMDPASSWORD:-}" >> "$TMP/sqlcmd-env.log"
# como el sqlcmd real: con la clave vacía la pide por teclado y, sin teclado, falla sin conectarse
[ -n "\${SQLCMDPASSWORD:-}" ] || { echo "liner: function not supported in this terminal"; exit 1; }
case "\${FAKE_SQLCMD:-rechazo}" in
  rechazo) echo "Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Cannot open server '$CORTO' requested by the login. Client with IP address '\${FAKE_IP:-$IP_PUB}' is not allowed to access the server.  To enable access, use the Azure Management Portal or run sp_set_firewall_rule on the master database to create a firewall rule for this IP address or address range.  It may take up to five minutes for this change to take effect." ; exit 1 ;;
  acceso)  echo "Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login failed for user 'tycon-gate-probe'." ; exit 1 ;;
  sin-ip)  echo "Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Client is not allowed to access the server." ; exit 1 ;;
  otro)    echo "Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login timeout expired." ; exit 1 ;;
esac
SH
  # az: anota cada llamada y su entorno; las reglas viven en un archivo «nombre ip»
  # la puerta llama a az con un entorno limpio: la carpeta y el modo van escritos, no en variables
  { printf '#!/usr/bin/env bash\nTMPLOG="%s"\n' "$TMP"; cat <<'SH'
FAKE_AZ="$(cat "$TMPLOG/fake-az-mode" 2>/dev/null)"
printf '%s\n' "$*" >> "$TMPLOG/az.log"
env >> "$TMPLOG/az-env.log"
case "${FAKE_AZ:-ok}" in
  sin-sesion) echo "ERROR: Please run 'az login' to setup account." >&2; exit 1 ;;
  lento) sleep 5 ;;
esac
arg(){ local k="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$k" ] && { echo "$2"; return; }; shift; done; }
case "$1 $2" in
  "account list") case "${FAKE_AZ:-ok}" in dos) printf 'sub-1\nsub-2\n' ;; *) printf 'sub-1\nsub-2\n' ;; esac; exit 0 ;;
esac
case "$1 $2 $3" in
  "sql server list")
    s="$(arg --subscription "$@")"
    # con -g: los servidores de un grupo de mentira (fake-groups/<suscripción>/<grupo>/servers)
    g="$(arg -g "$@")"
    if [ -n "$g" ]; then
      [ "$FAKE_AZ" = listado-error ] && { echo "ERROR: (InternalServerError) Encountered an internal server error." >&2; exit 1; }
      f="$TMPLOG/fake-groups/$s/$g/servers"; [ -f "$f" ] && cat "$f"; exit 0
    fi
    case "${FAKE_AZ:-ok}:$s" in
      ninguna:*) : ;;
      dos:*) echo "rg-acme" ;;
      # cada servidor en su grupo (para los candados); el de siempre, en rg-acme
      *:sub-1) n="$(printf '%s' "$(arg --query "$@")" | sed -n "s/.*name=='\([^']*\)'.*/\1/p")"
               if [ -z "$n" ] || [ "$n" = acme-sql ]; then echo "rg-acme"; else echo "rg-$n"; fi ;;
    esac; exit 0 ;;
esac
case "$1 $2" in
  # los grupos de mentira: fake-groups/<suscripción>/<grupo>/ existe, con sus servidores y los tipos de sus recursos
  "group show")
    g="$(arg -n "$@")"; s="$(arg --subscription "$@")"
    [ "$FAKE_AZ" = sin-permiso ] && { echo "ERROR: (AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Resources/subscriptions/resourcegroups/read'." >&2; exit 1; }
    [ -d "$TMPLOG/fake-groups/$s/$g" ] && { echo "$g"; exit 0; }
    echo "ERROR: (ResourceGroupNotFound) Resource group '$g' could not be found." >&2; exit 3 ;;
  "resource list")
    g="$(arg -g "$@")"; s="$(arg --subscription "$@")"
    [ "$FAKE_AZ" = listado-error ] && { echo "ERROR: (InternalServerError) Encountered an internal server error." >&2; exit 1; }
    f="$TMPLOG/fake-groups/$s/$g/types"; [ -f "$f" ] && cat "$f"; exit 0 ;;
  "group delete")
    printf '%s\n' "$*" >> "$TMPLOG/az-borrados.log"
    [ "$FAKE_AZ" = scope-locked ] && { echo "ERROR: (ScopeLocked) The scope '/subscriptions/sub-1/resourceGroups/$(arg -n "$@")' cannot perform delete operation because following scope(s) are locked: '/subscriptions/sub-1/resourceGroups/$(arg -n "$@")'." >&2; exit 1; }
    exit 0 ;;
  # los candados de un grupo: lo que haya en fake-locks/<grupo> (el arreglo que devuelve az), o ninguno
  "lock list")
    g="$(arg -g "$@")"; f="$TMPLOG/fake-locks/$g"
    if [ "$FAKE_AZ" = lock-error ] || { [ "$FAKE_AZ" = lock-error-b ] && [ "$g" = rg-prod-b ]; }; then
      echo "ERROR: (AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Authorization/locks/read'." >&2; exit 1
    fi
    if [ -f "$f" ]; then cat "$f"; else echo "[]"; fi; exit 0 ;;
esac
case "$1 $2 $3 $4" in
  "sql server firewall-rule show")
    # show-error: Azure contesta otra cosa que «no existe» (límite de pedidos, red, permiso)
    [ "$FAKE_AZ" = show-error ] && { echo "ERROR: (TooManyRequests) Too many requests. Retry later." >&2; exit 1; }
    n="$(arg -n "$@")"; l="$(grep "^$n " "$TMPLOG/az-reglas")"
    [ -n "$l" ] || { echo "ERROR: (ResourceNotFound) The Resource 'Microsoft.Sql/servers/x/firewallRules/$n' was not found." >&2; exit 3; }
    echo "${l#* }"; exit 0 ;;
  "sql server firewall-rule create"|"sql server firewall-rule update")
    # crear-sin-permiso: la cuenta de Azure no puede escribir reglas en ese servidor
    [ "$FAKE_AZ" = crear-sin-permiso ] && { echo "ERROR: (AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Sql/servers/firewallRules/write'." >&2; exit 1; }
    n="$(arg -n "$@")"; ip="$(arg --start-ip-address "$@")"
    grep -v "^$n " "$TMPLOG/az-reglas" > "$TMPLOG/az-reglas.t"; echo "$n $ip" >> "$TMPLOG/az-reglas.t"; mv "$TMPLOG/az-reglas.t" "$TMPLOG/az-reglas"
    # crear-lento: la regla queda creada en Azure, pero la respuesta no llega antes del tope
    [ "$FAKE_AZ" = crear-lento ] && sleep 5
    exit 0 ;;
  "sql server firewall-rule delete")
    n="$(arg -n "$@")"; grep -v "^$n " "$TMPLOG/az-reglas" > "$TMPLOG/az-reglas.t"; mv "$TMPLOG/az-reglas.t" "$TMPLOG/az-reglas"; exit 0 ;;
esac
echo "az de mentira: no sé hacer «$*»" >&2; exit 9
SH
  } > "$RAIZ/opt/homebrew/bin/az"
  chmod +x "$RAIZ/usr/bin/security" "$RAIZ/usr/sbin/ioreg" "$RAIZ/opt/tycon/bin/sqlcmd" "$RAIZ/opt/homebrew/bin/az"
  # un az impostor primero en el PATH: la puerta no lo usa (T30)
  mkdir -p "$TMP/impostor"; printf '#!/usr/bin/env bash\necho IMPOSTOR >> "%s/impostor.log"\n' "$TMP" > "$TMP/impostor/az"; chmod +x "$TMP/impostor/az"
  unset FAKE_SQLCMD FAKE_AZ FAKE_IP FAKE_UUID
}

puerta(){ # corre la puerta en el mundo falso; imprime el exit code. SES = la sesión que la llama (vacía = ninguna)
  printf '%s' "${FAKE_AZ:-ok}" > "$TMP/fake-az-mode"
  env HOME="$CASA" TYCON_PROD_ROOT="$RAIZ" TYCON_REPOS_ROOT="$REPOS" TMPLOG="$TMP" \
      PATH="$TMP/impostor:$PATH" CLAUDE_CODE_SESSION_ID="${SES:-}" TYCON_PROD_AZ_TIMEOUT="${AZ_TOPE:-20}" \
      FAKE_SQLCMD="${FAKE_SQLCMD:-}" FAKE_AZ="${FAKE_AZ:-}" FAKE_IP="${FAKE_IP:-}" FAKE_UUID="${FAKE_UUID:-}" \
      bash "$PUERTA" "$@" >"$TMP/out" 2>"$TMP/err"
  echo $?
}
gancho(){ # $1 = evento, $2 = sesión → corre el hook con la puerta del repo y el mundo falso; imprime el exit code
  printf '%s' "${FAKE_AZ:-ok}" > "$TMP/fake-az-mode"
  printf '{"hook_event_name":"%s","session_id":"%s"}' "$1" "$2" | \
    env HOME="$CASA" TYCON_PROD_ROOT="$RAIZ" TYCON_REPOS_ROOT="$REPOS" TMPLOG="$TMP" TYCON_PROD_GATE="$PUERTA" \
        TYCON_PROD_AZ_TIMEOUT="${AZ_TOPE:-20}" FAKE_AZ="${FAKE_AZ:-}" \
        node "$HOOK" >"$TMP/hook.out" 2>"$TMP/hook.err"
  echo $?
}
viva(){ printf '{}\n' > "$CASA/.claude/projects/p/$1.jsonl"; touch "$CASA/.claude/projects/p/$1.jsonl"; } # actividad reciente
muerta(){ printf '{}\n' > "$CASA/.claude/projects/p/$1.jsonl"; touch -t 202001010000 "$CASA/.claude/projects/p/$1.jsonl"; }
registro(){ cat "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null; }
estado(){ cat "$CASA/.claude/.tycon-pipeline/production-firewall.json" 2>/dev/null; }
regla_de_la_maquina(){ printf 'tycon-gate-%s' "$(printf '%s' "${FAKE_UUID:-equipo-de-prueba-uno}" | shasum -a 256 | cut -c1-8)"; }

[ -f "$PUERTA" ] || { no "la puerta no existe ($PUERTA)"; echo "— prod-firewall: $pasaron ok, $fallos fallos —"; exit 1; }

# ── T1 · abrir crea UNA regla de una sola IP, con el nombre fijo de la máquina ──────────────────────────────────
mundo; SES=$SES_A; viva $SES_A
rc="$(puerta --open-firewall "$PROD")"
REGLA="$(regla_de_la_maquina)"
if [ "$rc" = 0 ] && grep -q "firewall-rule create .*-s $CORTO .*-n $REGLA .*--start-ip-address $IP_PUB .*--end-ip-address $IP_PUB" "$TMP/az.log" \
   && grep -q "$REGLA" "$TMP/out" && grep -q "$IP_PUB" "$TMP/out" && grep -q "$CORTO" "$TMP/out"; then
  ok "T1 OpenFirewall_ProductionHost_CreatesSingleIpRule · una regla $REGLA con start = end = la IP del rechazo"
else no "T1 · rc=$rc · $(cat "$TMP/out" "$TMP/err") · az: $(cat "$TMP/az.log" 2>/dev/null)"; fi

# ── T2 · el registro suma la apertura, sin secretos ────────────────────────────────────────────────────────────
l="$(registro | grep '"accion":"open-firewall"' | tail -1)"
if [[ "$l" == *"\"regla\":\"$REGLA\""* ]] && [[ "$l" == *"\"ip\":\"$IP_PUB\""* ]] \
   && [[ "$l" == *"\"sesion\":\"$SES_A\""* ]] && [[ "$l" == *'"exit":0'* ]] && ! registro | grep "$CLAVE_MARCA" >/dev/null; then
  ok "T2 OpenFirewall_LogsLineWithoutSecrets · regla, IP, sesión y exit; sin la clave"
else no "T2 · registro: $(registro)"; fi
[ ! -s "$TMP/security.log" ] && ok "T2 · abrir no leyó el Llavero" || no "T2 · abrir leyó el Llavero: $(cat "$TMP/security.log")"
if ! grep -q "$CLAVE_MARCA" "$TMP/az-env.log" 2>/dev/null && [ "$(sort -u "$TMP/sqlcmd-env.log" 2>/dev/null)" = "SQLCMDPASSWORD=$SONDA" ]; then
  ok "T30 · ni az ni el intento de conexión reciben la clave de la base: sqlcmd recibe el nombre del usuario de prueba"
else no "T30 · la clave llegó a az o a sqlcmd, o el intento fue sin clave · $(cat "$TMP/sqlcmd-env.log" 2>/dev/null)"; fi

# ── T3 · sin IP válida en el rechazo: sale 2 y no toca Azure ───────────────────────────────────────────────────
for caso in "sin-ip:" "rechazo:0.0.0.0" "rechazo:10.1.2.3" "rechazo:172.20.0.1" "rechazo:192.168.1.9" "rechazo:127.0.0.1" "rechazo:203.0.113.0/24" "otro:"; do
  mundo; SES=$SES_A; FAKE_SQLCMD="${caso%%:*}"; FAKE_IP="${caso#*:}"
  rc="$(puerta --open-firewall "$PROD")"
  if [ "$rc" = 2 ] && [ ! -s "$TMP/az.log" ] && [ ! -s "$TMP/security.log" ] && grep -qi "IP" "$TMP/err"; then
    ok "T3 OpenFirewall_NoIpOrBadIp_Exit2NoAzure · «${caso}» sale 2 sin llamar a az"
  else no "T3 · «${caso}» rc=$rc · $(cat "$TMP/err") · az: $(cat "$TMP/az.log" 2>/dev/null)"; fi
done
unset FAKE_SQLCMD FAKE_IP

# ── T4 · la IP ya tiene acceso: sale 0 y no crea nada; con la regla propia, anota la sesión ────────────────────
mundo; SES=$SES_B; FAKE_SQLCMD=acceso
rc="$(puerta --open-firewall "$PROD")"
if [ "$rc" = 0 ] && grep -qi "ya tenés acceso" "$TMP/out" && ! grep -q "firewall-rule create" "$TMP/az.log" 2>/dev/null; then
  ok "T4 OpenFirewall_AlreadyHasAccess_Exit0NoRule · sin regla propia: «ya tenés acceso», nada creado"
else no "T4 · rc=$rc · $(cat "$TMP/out" "$TMP/err")"; fi
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
SES=$SES_B; FAKE_SQLCMD=acceso; rc="$(puerta --open-firewall "$PROD")"; unset FAKE_SQLCMD
if [ "$rc" = 0 ] && estado | grep "$SES_B" >/dev/null && [ "$(grep -c "firewall-rule create" "$TMP/az.log")" = 1 ]; then
  ok "T4 · con la regla propia abierta, la sesión nueva queda anotada como usuaria"
else no "T4 · regla propia: rc=$rc · estado: $(estado)"; fi

# ── T5 · la máquina cambió de IP: actualiza la MISMA regla ─────────────────────────────────────────────────────
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
FAKE_IP=198.51.100.7; rc="$(puerta --open-firewall "$PROD")"; unset FAKE_IP
if [ "$rc" = 0 ] && [ "$(wc -l < "$TMP/az-reglas" | tr -d ' ')" = 1 ] && grep -q "^$REGLA 198.51.100.7$" "$TMP/az-reglas" && grep -q "firewall-rule update" "$TMP/az.log"; then
  ok "T5 OpenFirewall_IpChanged_UpdatesSameRule · una sola regla, con la IP nueva"
else no "T5 · rc=$rc · reglas: $(cat "$TMP/az-reglas") · az: $(cat "$TMP/az.log")"; fi

# ── T6 · el nombre: fijo por máquina, distinto entre máquinas, sin el nombre del equipo ────────────────────────
mundo; SES=$SES_A; FAKE_UUID=AAAAAAAA-1111-4111-8111-111111111111; puerta --open-firewall "$PROD" >/dev/null; r1="$(grep -o 'tycon-gate-[0-9a-f]*' "$TMP/az-reglas" | head -1)"
FAKE_UUID=BBBBBBBB-2222-4222-8222-222222222222; puerta --open-firewall "$PROD" >/dev/null; r2="$(grep -o 'tycon-gate-[0-9a-f]*' "$TMP/az-reglas" | sort -u | grep -v "^$r1$" | head -1)"
unset FAKE_UUID
if [[ "$r1" =~ ^tycon-gate-[0-9a-f]{8}$ ]] && [[ "$r2" =~ ^tycon-gate-[0-9a-f]{8}$ ]] && [ "$r1" != "$r2" ] \
   && [ "$(wc -l < "$TMP/az-reglas" | tr -d ' ')" = 2 ] && ! grep -qi "$(hostname -s)" "$TMP/az-reglas"; then
  ok "T6 RuleName_FixedPerMachine_NoPersonalName · $r1 y $r2: una por máquina, ninguna pisa a la otra"
else no "T6 · r1=$r1 r2=$r2 · reglas: $(cat "$TMP/az-reglas")"; fi

# ── T7 · cerrar borra SÓLO la regla de la máquina ──────────────────────────────────────────────────────────────
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; echo "regla-ajena 1.2.3.4" >> "$TMP/az-reglas"
SES=""; rc="$(puerta --close-firewall "$PROD")"
if [ "$rc" = 0 ] && grep -q "^regla-ajena " "$TMP/az-reglas" && ! grep -q "^$REGLA " "$TMP/az-reglas" \
   && registro | grep '"accion":"close-firewall"' >/dev/null && ! grep "firewall-rule delete" "$TMP/az.log" | grep -v -- "-n $REGLA" >/dev/null; then
  ok "T7 CloseFirewall_OnlyOwnRule · borró $REGLA y dejó la ajena; anotado"
else no "T7 · rc=$rc · reglas: $(cat "$TMP/az-reglas") · $(cat "$TMP/err")"; fi

# ── T8 / T26 · las formas no aceptan nada más que el host ──────────────────────────────────────────────────────
mundo
for args in "--close-firewall $PROD otra-regla" "--open-firewall $PROD 0.0.0.0" "--open-firewall $PROD 10.0.0.0/8" \
            "--open-firewall $PROD --azure-services" "--open-firewall $PROD --subscription sub-9" "--open-firewall" \
            "--close-firewall $PROD --session" "--close-firewall $PROD --session ../../etc" "--open-firewall $PROD --session $SES_A"; do
  # shellcheck disable=SC2086
  rc="$(puerta $args)"
  if [ "$rc" = 2 ] && [ ! -s "$TMP/az.log" ] && grep -qi "uso" "$TMP/err"; then ok "T8/T26 · «${args}» sale 2 con el uso, sin tocar Azure"
  else no "T8/T26 · «${args}» rc=$rc · $(cat "$TMP/err")"; fi
done

# ── T9 · un host reclasificado que figura en el estado se cierra igual; sin estado, no ─────────────────────────
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
sed -i '' "s/\"host\":\"$PROD\",\"environment\":\"produccion\"/\"host\":\"$PROD\",\"environment\":\"no-produccion\"/" "$REPOS/backend-acme/.tycon/production.json"
rm -f "$CASA/.claude/.tycon-pipeline/production-index.json"
SES=""; rc="$(puerta --close-firewall "$PROD")"
if [ "$rc" = 0 ] && ! grep -q "^$REGLA " "$TMP/az-reglas"; then ok "T9 CloseFirewall_ReclassifiedHostInState_StillCloses · cerrar es la dirección segura"
else no "T9 · reclasificado: rc=$rc · $(cat "$TMP/err")"; fi
mundo; rc="$(puerta --close-firewall "$STAGING")"
if [ "$rc" = 2 ] && [ ! -s "$TMP/az.log" ]; then ok "T9 · un host que no está en el estado ni es producción sale 2 sin tocar Azure"
else no "T9 · sin estado: rc=$rc · az: $(cat "$TMP/az.log" 2>/dev/null)"; fi

# ── T10 · el cierre a mano cierra aunque otra sesión la use, y la saca del estado ──────────────────────────────
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; viva $SES_B; SES=$SES_B FAKE_SQLCMD=acceso puerta --open-firewall "$PROD" >/dev/null
SES=""; rc="$(puerta --close-firewall "$PROD")"
if [ "$rc" = 0 ] && ! grep -q "^$REGLA " "$TMP/az-reglas" && ! estado | grep "$PROD" >/dev/null; then
  ok "T10 CloseFirewall_ManualWhileOtherSessionUses_ClosesAndClears"
else no "T10 · rc=$rc · estado: $(estado)"; fi

# ── T11 · la regla ya no existe en Azure: sale 0 y la saca del estado ──────────────────────────────────────────
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; : > "$TMP/az-reglas"
SES=""; rc="$(puerta --close-firewall "$PROD")"
if [ "$rc" = 0 ] && ! estado | grep "$PROD" >/dev/null; then ok "T11 CloseFirewall_RuleAlreadyGone_Exit0Cleared"
else no "T11 · rc=$rc · $(cat "$TMP/err") · estado: $(estado)"; fi

# ── T12-T14 · el fin de sesión ─────────────────────────────────────────────────────────────────────────────────
[ -f "$HOOK" ] || no "el hook no existe ($HOOK)"
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
rc="$(gancho SessionEnd "$SES_A")"
if [ "$rc" = 0 ] && ! grep -q "^$REGLA " "$TMP/az-reglas" && registro | grep '"accion":"close-firewall"' | grep '"por":"fin-de-sesion"' >/dev/null; then
  ok "T12 SessionEnd_ClosesRulesOfThatSession · cerrada, con «por: fin-de-sesion»"
else no "T12 · rc=$rc · $(cat "$TMP/hook.out" "$TMP/hook.err") · reglas: $(cat "$TMP/az-reglas")"; fi
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; viva $SES_B; SES=$SES_B FAKE_SQLCMD=acceso puerta --open-firewall "$PROD" >/dev/null
rc="$(gancho SessionEnd "$SES_A")"
if grep -q "^$REGLA " "$TMP/az-reglas" && estado | grep "$SES_B" >/dev/null && ! estado | grep "$SES_A" >/dev/null; then
  ok "T13 SessionEnd_OtherLiveSessionKeepsRule · sigue abierta; la sesión que terminó salió de la lista"
else no "T13 · reglas: $(cat "$TMP/az-reglas") · estado: $(estado)"; fi
rc="$(gancho SessionEnd "$SES_B")"
if ! grep -q "^$REGLA " "$TMP/az-reglas" && ! estado | grep "$PROD" >/dev/null; then ok "T14 SessionEnd_LastSessionClosesRule"
else no "T14 · reglas: $(cat "$TMP/az-reglas") · estado: $(estado)"; fi

# ── T16-T18 · el barrido de arranque ───────────────────────────────────────────────────────────────────────────
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; muerta $SES_A
rc="$(gancho SessionStart "$SES_B")"
if [ "$rc" = 0 ] && ! grep -q "^$REGLA " "$TMP/az-reglas" && grep -q "$REGLA" "$TMP/hook.out" && grep -q "$PROD" "$TMP/hook.out" && grep -qi "desde" "$TMP/hook.out"; then
  ok "T16 Startup_LeftoverRuleClosedAndSaid · la cerró y lo dijo con servidor y desde cuándo"
else no "T16 · rc=$rc · $(cat "$TMP/hook.out" "$TMP/hook.err") · reglas: $(cat "$TMP/az-reglas")"; fi
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; muerta $SES_A; rm -f "$CASA/.claude/.tycon-pipeline/production-firewall.json"
rc="$(gancho SessionStart "$SES_B")"
if ! grep -q "^$REGLA " "$TMP/az-reglas"; then ok "T17 Startup_StateDeleted_LogStillShowsOpenRule · sin el estado, el registro alcanza"
else no "T17 · reglas: $(cat "$TMP/az-reglas") · $(cat "$TMP/hook.out" "$TMP/hook.err")"; fi
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; muerta $SES_A
FAKE_AZ=sin-sesion; rc="$(gancho SessionStart "$SES_B")"; unset FAKE_AZ
if grep -q "^$REGLA " "$TMP/az-reglas" && grep -q "🔴" "$TMP/hook.out" && grep -q -- "--close-firewall $PROD" "$TMP/hook.out" && estado | grep "$PROD" >/dev/null; then
  ok "T18 Startup_CannotClose_RedWithCommand · rojo con el comando; sigue anotada"
else no "T18 · $(cat "$TMP/hook.out" "$TMP/hook.err") · estado: $(estado)"; fi
mundo; rc="$(gancho SessionStart "$SES_B")"
if [ "$rc" = 0 ] && [ ! -s "$TMP/hook.out" ] && [ ! -s "$TMP/az.log" ]; then ok "T16 · sin reglas abiertas, el barrido no dice nada ni llama a Azure"
else no "T16 · sin reglas: rc=$rc · $(cat "$TMP/hook.out")"; fi

# ── T19 · el hook está en la configuración administrada, en los dos eventos, sin interruptor ───────────────────
PLANT="$AQUI/scripts/production/managed-settings.tycon-production.json.template"
if node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const tiene = (ev) => ((j.hooks || {})[ev] || []).some((g) => (g.hooks || []).some((h) => /prod-firewall-close\.js/.test(h.command || "")));
  process.exit(tiene("SessionEnd") && tiene("SessionStart") ? 0 : 1);' "$PLANT" && ! grep -q "prod-firewall-close" "$AQUI/scripts/setup/hooks-list.json" \
   && ! grep -qE "TYCON_[A-Z_]*FIREWALL[A-Z_]*=0|process\.env\.TYCON_PROD_FIREWALL" "$HOOK"; then
  ok "T19 Startup_SweepInManagedSettings_NoSwitch · SessionEnd y SessionStart, en la configuración de root, sin variable de apagado"
else no "T19 · la plantilla no trae el hook en los dos eventos, o hay un interruptor"; fi
if node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ask = (j.permissions && j.permissions.ask) || [];
  const ok = ["Edit", "Write"].every((t) => [".claude/.tycon-pipeline", ".tycon/state"].every((d) => ask.some((r) => r.startsWith(t + "(") && r.includes(d) && r.includes("production-firewall.json"))));
  process.exit(ok ? 0 : 1);' "$PLANT"; then
  ok "T20 · la plantilla pregunta antes de editar o escribir el estado del firewall, en sus dos ubicaciones"
else no "T20 · faltan las reglas ask de Edit/Write sobre production-firewall.json"; fi

# ── T21 · el estado cae donde cae el registro ──────────────────────────────────────────────────────────────────
mundo; mkdir -p "$CASA/.tycon/state"; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
if [ -f "$CASA/.tycon/state/production-firewall.json" ] && [ -f "$CASA/.tycon/state/production.log" ] && [ ! -f "$CASA/.claude/.tycon-pipeline/production-firewall.json" ]; then
  ok "T21 StateFile_PathFollowsStateDirRule · con ~/.tycon/state, el estado y el registro van ahí"
else no "T21 · $(ls "$CASA/.tycon/state" "$CASA/.claude/.tycon-pipeline" 2>&1 | tr '\n' ' ')"; fi

# ── T24 · abrir un host no-producción o desconocido: sale 2 sin Azure ──────────────────────────────────────────
for h in "$STAGING" "otro-cualquiera.database.windows.net"; do
  mundo; rc="$(puerta --open-firewall "$h")"
  if [ "$rc" = 2 ] && [ ! -s "$TMP/az.log" ] && [ ! -s "$TMP/sqlcmd.log" ]; then ok "T24 Gate_OpenNonProductionOrUnknownHost_Exit2NoAzure · $h"
  else no "T24 · $h rc=$rc · $(cat "$TMP/err")"; fi
done

# ── T25 · sólo Azure SQL; el nombre corto sale del host ─────────────────────────────────────────────────────────
mundo; rc="$(puerta --open-firewall "$PROPIO")"
if [ "$rc" = 2 ] && [ ! -s "$TMP/az.log" ] && grep -qi "Azure SQL" "$TMP/err"; then ok "T25 Gate_NotAzureSqlHost_Exit2_ShortNameDerived · un servidor propio sale 2"
else no "T25 · rc=$rc · $(cat "$TMP/err")"; fi

# ── T27 · sin az, sin sesión de Azure ──────────────────────────────────────────────────────────────────────────
mundo; rm -f "$RAIZ/opt/homebrew/bin/az"; SES=$SES_A; rc="$(puerta --open-firewall "$PROD")"
if [ "$rc" = 2 ] && grep -qi "az" "$TMP/err" && [ ! -s "$TMP/impostor.log" ] && registro | grep '"accion":"open-firewall"' | grep '"exit":2' >/dev/null; then
  ok "T27 Gate_AzMissingOrNotLoggedIn_Exit2WithReason · sin az en las rutas fijas: sale 2, no usa el del PATH, anotado"
else no "T27 · sin az: rc=$rc · $(cat "$TMP/err") · impostor: $(cat "$TMP/impostor.log" 2>/dev/null)"; fi
mundo; FAKE_AZ=sin-sesion; SES=$SES_A; rc="$(puerta --open-firewall "$PROD")"; unset FAKE_AZ
if [ "$rc" = 2 ] && grep -q "az login" "$TMP/err"; then ok "T27 · sin sesión de Azure: sale 2 y nombra az login"
else no "T27 · sin sesión: rc=$rc · $(cat "$TMP/err")"; fi

# ── T28 · el servidor en dos suscripciones, o en ninguna ───────────────────────────────────────────────────────
for m in dos ninguna; do
  mundo; FAKE_AZ=$m; SES=$SES_A; rc="$(puerta --open-firewall "$PROD")"; unset FAKE_AZ
  if [ "$rc" = 2 ] && ! grep -q "firewall-rule create" "$TMP/az.log"; then ok "T28 Gate_ServerInTwoSubscriptionsOrNone_Exit2 · «${m}»: no elige"
  else no "T28 · «${m}» rc=$rc · $(cat "$TMP/err")"; fi
done

# ── T29 · az que no contesta: corta, y un cierre que no se hizo queda anotado ──────────────────────────────────
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
FAKE_AZ=lento; AZ_TOPE=1; SES=""; rc="$(puerta --close-firewall "$PROD")"; unset FAKE_AZ AZ_TOPE
if [ "$rc" = 2 ] && grep -qiE "tope|tard" "$TMP/err" && estado | grep "$PROD" >/dev/null; then ok "T29 Gate_AzTimeout_CloseStaysRecordedOpen"
else no "T29 · rc=$rc · $(cat "$TMP/err") · estado: $(estado)"; fi

# ── T30 · az de la ruta fija, sólo las operaciones permitidas ──────────────────────────────────────────────────
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; SES=""; puerta --close-firewall "$PROD" >/dev/null
fuera="$(grep -vE '^(account list|sql server list|sql server firewall-rule (show|create|update|delete)) ' "$TMP/az.log")"
if [ -z "$fuera" ] && [ ! -s "$TMP/impostor.log" ] && ! grep -q "firewall-rule \(create\|update\|delete\)" "$TMP/az.log" | grep -v -- "-n $REGLA"; then
  ok "T30 Gate_AzFromFixedPathsOnlyListedOps_NoSecretPassed · la ruta fija y sólo las operaciones de la lista"
else no "T30 · fuera de la lista: «${fuera}» · impostor: $(cat "$TMP/impostor.log" 2>/dev/null)"; fi

# ── lo que encontró el pase adversarial (cada caso, rojo contra la primera versión) ────────────────────────────

# T7 · un error de Azure que no es «no existe» NO cuenta como regla cerrada: sale 2 y la regla sigue anotada
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
FAKE_AZ=show-error; SES=""; rc="$(puerta --close-firewall "$PROD")"; unset FAKE_AZ
if [ "$rc" = 2 ] && estado | grep "$PROD" >/dev/null && ! registro | grep '"accion":"close-firewall"' | grep '"exit":0' >/dev/null; then
  ok "T7 · un error de Azure al mirar la regla (no «no existe») sale 2 y la deja anotada como abierta"
else no "T7 · show con error: rc=$rc · estado: $(estado) · $(cat "$TMP/out" "$TMP/err")"; fi

# T29 · el tope al CREAR: la regla puede haber quedado en Azure, así que queda anotada y el barrido la cierra
mundo; SES=$SES_A; FAKE_AZ=crear-lento; AZ_TOPE=2; rc="$(puerta --open-firewall "$PROD")"; unset FAKE_AZ AZ_TOPE
muerta $SES_A; gancho SessionStart "$SES_B" >/dev/null
if [ "$rc" = 2 ] && ! grep -q "^$REGLA " "$TMP/az-reglas"; then ok "T29 · un tope al crear deja la regla anotada, y el barrido de arranque la cierra"
else no "T29 · crear con tope: rc=$rc · reglas: $(cat "$TMP/az-reglas") · $(cat "$TMP/hook.out" "$TMP/hook.err")"; fi

# T16 · varias sesiones muertas en la misma regla: el barrido la cierra UNA vez, aunque el host esté reclasificado
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; viva $SES_B; SES=$SES_B FAKE_SQLCMD=acceso puerta --open-firewall "$PROD" >/dev/null
muerta $SES_A; muerta $SES_B
sed -i '' "s/\"host\":\"$PROD\",\"environment\":\"produccion\"/\"host\":\"$PROD\",\"environment\":\"no-produccion\"/" "$REPOS/backend-acme/.tycon/production.json"
rm -f "$CASA/.claude/.tycon-pipeline/production-index.json"; : > "$TMP/az.log"
rc="$(gancho SessionStart 33333333-cccc-4ccc-8ccc-333333333333)"
borrados="$(grep -c "firewall-rule delete" "$TMP/az.log")"
if ! grep -q "^$REGLA " "$TMP/az-reglas" && [ "$borrados" = 1 ] && ! grep -q "🔴" "$TMP/hook.out"; then
  ok "T16 · dos sesiones muertas en una regla de un host reclasificado: una sola llamada que la cierra, sin rojo falso"
else no "T16 · varias muertas: borrados=$borrados · $(cat "$TMP/hook.out")"; fi

# T17 · una regla que sólo figura en el registro y cuyo host hoy no es producción se cierra igual (cerrar es seguro)
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; muerta $SES_A
rm -f "$CASA/.claude/.tycon-pipeline/production-firewall.json"
sed -i '' "s/\"host\":\"$PROD\",\"environment\":\"produccion\"/\"host\":\"$PROD\",\"environment\":\"no-produccion\"/" "$REPOS/backend-acme/.tycon/production.json"
rm -f "$CASA/.claude/.tycon-pipeline/production-index.json"
gancho SessionStart "$SES_B" >/dev/null
if ! grep -q "^$REGLA " "$TMP/az-reglas"; then ok "T17 · sin el estado y con el host reclasificado, el registro alcanza para cerrarla"
else no "T17 · sólo registro y reclasificado: reglas: $(cat "$TMP/az-reglas") · $(cat "$TMP/hook.out")"; fi

# T3 · una IP con ceros adelante es otra forma de escribir una privada o 0.0.0.0: no se acepta
for ipmala in 00.0.0.0 010.1.2.3 0127.0.0.1 203.0.113.025; do
  mundo; SES=$SES_A; FAKE_IP=$ipmala; rc="$(puerta --open-firewall "$PROD")"; unset FAKE_IP
  if [ "$rc" = 2 ] && [ ! -s "$TMP/az.log" ]; then ok "T3 · «${ipmala}» (con ceros adelante) sale 2 sin llamar a az"
  else no "T3 · «${ipmala}» rc=$rc · az: $(cat "$TMP/az.log" 2>/dev/null)"; fi
done

# T25 · el host se escribe como lo normaliza el índice: mayúsculas, punto final o el nombre corto son el mismo servidor
for forma in "ACME-SQL.database.windows.net" "$PROD." "$CORTO"; do
  mundo; SES=$SES_A; viva $SES_A; rc="$(puerta --open-firewall "$forma")"
  if [ "$rc" = 0 ] && grep -q "^$REGLA $IP_PUB$" "$TMP/az-reglas" && grep -q "firewall-rule create .*-s $CORTO " "$TMP/az.log" && [[ "$(estado)" == *"\"host\": \"$PROD\""* ]]; then
    ok "T25 · «${forma}» es el mismo servidor: una regla, anotada con el host normalizado"
  else no "T25 · «${forma}» rc=$rc · $(cat "$TMP/err") · estado: $(estado)"; fi
done

# T8 · un valor con salto de línea no pasa por una de sus líneas
mundo; SES=$SES_A; rc="$(puerta --close-firewall "$PROD" --session "$(printf '%s\nx' "$SES_A")")"
if [ "$rc" = 2 ] && [ ! -s "$TMP/az.log" ]; then ok "T8 · una sesión con salto de línea se rechaza entera"
else no "T8 · sesión con salto de línea: rc=$rc"; fi
mundo; rc="$(puerta --open-firewall "$(printf '%s\nevil' "$PROD")")"
if [ "$rc" = 2 ] && [ ! -s "$TMP/az.log" ]; then ok "T8 · un host con salto de línea se rechaza entero"
else no "T8 · host con salto de línea: rc=$rc"; fi

# T12 · si el cierre del fin de sesión falla, el hook lo dice (no sólo el barrido siguiente)
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
FAKE_AZ=sin-sesion; gancho SessionEnd "$SES_A" >/dev/null; unset FAKE_AZ
if grep -q "🔴" "$TMP/hook.out" && grep -q -- "--close-firewall $PROD" "$TMP/hook.out" && estado | grep "$PROD" >/dev/null; then
  ok "T12 · un cierre de fin de sesión que falla se dice en rojo con el comando, y la regla sigue anotada"
else no "T12 · fin de sesión fallido: $(cat "$TMP/hook.out" "$TMP/hook.err")"; fi

# ══ Los candados: `--locks` dice qué servidores de producción tienen el candado de Azure ══════════════════════════
# un repo más con tres servidores de producción, cada uno en su grupo: x con el candado en el servidor, prod-b en
# el grupo, otro sin candado
mundo_candados(){
  mundo
  mkdir -p "$REPOS/candados/.tycon" "$TMP/fake-locks"; ( cd "$REPOS/candados" && git init -q . ) >/dev/null 2>&1
  printf '{"servers":[{"host":"x.database.windows.net","environment":"produccion","keychain":"tycon-prod-x"},{"host":"prod-b.database.windows.net","environment":"produccion","keychain":"tycon-prod-b"},{"host":"otro.database.windows.net","environment":"produccion","keychain":"tycon-prod-otro"}]}' \
    > "$REPOS/candados/.tycon/production.json"
  rm -f "$TMP"/fake-locks/*
}
candado(){ # $1 = grupo, $2 = dónde (grupo | servidor:<nombre> | otro:<nombre>), $3 = nivel, $4 = nombre
  local id="/subscriptions/sub-1/resourceGroups/$1"
  case "$2" in
    servidor:*) id="$id/providers/Microsoft.Sql/servers/${2#servidor:}" ;;
    otro:*) id="$id/providers/Microsoft.Web/sites/${2#otro:}" ;;
  esac
  printf '[{"id":"%s/providers/Microsoft.Authorization/locks/%s","level":"%s","name":"%s","notes":null,"owners":null,"resourceGroup":"%s","type":"Microsoft.Authorization/locks"}]\n' \
    "$id" "$4" "$3" "$4" "$1" > "$TMP/fake-locks/$1"
}
linea(){ grep "^$1" "$TMP/out" | head -1; }

# ── T1 · con y sin candado, por servidor ───────────────────────────────────────────────────────────────────────
mundo_candados
candado rg-x servidor:x CanNotDelete en-el-servidor
candado rg-prod-b grupo ReadOnly en-el-grupo
rc="$(puerta --locks)"
if [ "$rc" = 0 ] && [[ "$(linea x.database.windows.net)" == *"con candado"*"en-el-servidor"* ]] \
   && [[ "$(linea prod-b.database.windows.net)" == *"con candado"*"en-el-grupo"* ]] \
   && [[ "$(linea otro.database.windows.net)" == *"sin candado"* ]]; then
  ok "6.4 T1 Candados_ListsProductionServers_WithAndWithout · el del servidor, el del grupo (ReadOnly) y el que no tiene"
else no "6.4 T1 · rc=$rc · $(cat "$TMP/out" "$TMP/err")"; fi

# ── T2 · el comando de crear se imprime y nunca se corre ────────────────────────────────────────────────────────
if grep -q "az lock create --name tycon-no-borrar --lock-type CanNotDelete --resource-group 'rg-otro' --resource-name otro --resource-type Microsoft.Sql/servers --subscription sub-1" "$TMP/out" \
   && grep -q "lo corre una persona con permiso de locks, fuera del asistente" "$TMP/out" && ! grep -q "lock create" "$TMP/az.log"; then
  ok "6.4 T2 Candados_PrintsCreateCommand_NeverRunsIt · el comando con la suscripción y la frase; az no recibió ningún lock create"
else no "6.4 T2 · $(cat "$TMP/out") · az: $(grep lock "$TMP/az.log")"; fi

# un candado de otro recurso del grupo, o uno de nivel desconocido, no protege al servidor
mundo_candados
candado rg-x otro:una-app CanNotDelete de-la-app
candado rg-prod-b grupo NotSpecified sin-nivel
rc="$(puerta --locks)"
if [[ "$(linea x.database.windows.net)" == *"sin candado"* ]] && [[ "$(linea prod-b.database.windows.net)" == *"sin candado"* ]]; then
  ok "6.4 T1 Candados_OtherResourceOrUnknownLevel_NotCounted · ni el de otro recurso del grupo ni uno de nivel desconocido"
else no "6.4 T1 · candado de otro recurso o nivel desconocido: $(cat "$TMP/out")"; fi

# un repo con el catálogo roto no deja ciegos a los demás: sus servidores se revisan y el roto sale «no sé»
mundo_candados
mkdir -p "$REPOS/otro-roto/.tycon"; ( cd "$REPOS/otro-roto" && git init -q . ) >/dev/null 2>&1
printf '{ roto' > "$REPOS/otro-roto/.tycon/production.json"
candado rg-x servidor:x CanNotDelete en-el-servidor
rc="$(puerta --locks)"
if [ "$rc" = 2 ] && [[ "$(linea x.database.windows.net)" == *"con candado"* ]] && grep -q "otro-roto" "$TMP/out" && grep "otro-roto" "$TMP/out" | grep "no sé" >/dev/null; then
  ok "6.4 T5 Candados_IndexUnreadableOrEmpty · un catálogo roto: los demás se revisan, el roto sale «no sé» y sale 2"
else no "6.4 T5 · catálogo roto de otro repo · rc=$rc · $(cat "$TMP/out" "$TMP/err")"; fi

# ── T3 · la forma va sola ───────────────────────────────────────────────────────────────────────────────────────
for extra in "acme-sql" "--x"; do
  mundo_candados
  rc="$(puerta --locks "$extra")"
  if [ "$rc" = 2 ] && grep -q "uso: tycon-prod-sql --locks" "$TMP/err" && [ ! -s "$TMP/az.log" ]; then
    ok "6.4 T3 Candados_ExtraArgument_Exit2 · --locks $extra: sale 2 con el uso, sin tocar az"
  else no "6.4 T3 · --locks $extra · rc=$rc · $(cat "$TMP/err")"; fi
done

# ── T4 · no-producción y sin declarar no aparecen; el SQL propio, aparte ────────────────────────────────────────
mundo_candados
rc="$(puerta --locks)"
# acme-sin-declarar no está en ningún catálogo: no aparece
if ! grep -q "$STAGING" "$TMP/out" && ! grep -q "acme-sin-declarar" "$TMP/out" && grep -q "$PROPIO" "$TMP/out" \
   && [[ "$(linea "$PROPIO")" == *"no se maneja desde acá"* ]] && ! grep -q -- "--name acme-onprem" "$TMP/az.log"; then
  ok "6.4 T4 Candados_NonProductionOrNonAzure_NotPending · el no-producción no aparece; el propio sale «no se maneja desde acá»"
else no "6.4 T4 · $(cat "$TMP/out")"; fi

# ── T5 · índice ilegible o sin producción ───────────────────────────────────────────────────────────────────────
mundo_candados
printf '{ esto no es json' > "$REPOS/candados/.tycon/production.json"
printf '{ esto no es json' > "$REPOS/backend-acme/.tycon/production.json"
rc="$(puerta --locks)"
r1="$rc"
mundo; printf '{"servers":[{"host":"%s","environment":"no-produccion"}]}' "$STAGING" > "$REPOS/backend-acme/.tycon/production.json"
rc="$(puerta --locks)"
if [ "$r1" = 2 ] && [ "$rc" = 0 ] && grep -q "no hay servidores de producción declarados" "$TMP/out"; then
  ok "6.4 T5 Candados_IndexUnreadableOrEmpty · ilegible: 2; sin producción: 0 con el mensaje"
else no "6.4 T5 · ilegible=$r1 vacío=$rc · $(cat "$TMP/out" "$TMP/err")"; fi

# ── T6 · lo que az no contesta es «no sé», con su motivo, y los demás siguen ────────────────────────────────────
for modo in sin-sesion lento dos ninguna lock-error; do
  mundo_candados; FAKE_AZ=$modo; AZ_TOPE=2
  rc="$(puerta --locks)"
  # cada «no sé» trae su motivo después de la raya
  if [ "$rc" = 2 ] && [[ "$(linea otro.database.windows.net)" == *"no sé — "?* ]] && [ "$(grep -c "no sé — " "$TMP/out")" -ge 3 ]; then
    ok "6.4 T6 Candados_AzFailures_NoSabeWithReason · $modo: «no sé» con motivo, sale 2"
  else no "6.4 T6 · $modo · rc=$rc · $(cat "$TMP/out" "$TMP/err")"; fi
  unset FAKE_AZ AZ_TOPE
done
# los demás siguen: falla sólo el de un grupo, y los otros se informan
mundo_candados; FAKE_AZ=lock-error-b
candado rg-x servidor:x CanNotDelete en-el-servidor
rc="$(puerta --locks)"
if [ "$rc" = 2 ] && [[ "$(linea prod-b.database.windows.net)" == *"no sé — "* ]] \
   && [[ "$(linea x.database.windows.net)" == *"con candado"* ]] && [[ "$(linea otro.database.windows.net)" == *"sin candado"* ]]; then
  ok "6.4 T6 · falla sólo uno: ése sale «no sé» y los demás se informan"
else no "6.4 T6 · falla mixta · rc=$rc · $(cat "$TMP/out")"; fi
unset FAKE_AZ
# sin az en las rutas fijas
mundo_candados; rm -f "$RAIZ/opt/homebrew/bin/az"
rc="$(puerta --locks)"
if [ "$rc" = 2 ] && grep -q "no sé" "$TMP/out" && [ ! -s "$TMP/impostor.log" ]; then
  ok "6.4 T6 · sin az en las rutas fijas: «no sé», sale 2, y no usa el del PATH"
else no "6.4 T6 · sin az · rc=$rc · $(cat "$TMP/out" "$TMP/err")"; fi

# ── T7 · sólo las lecturas de la lista, el az de la ruta fija y sin la clave ────────────────────────────────────
mundo_candados
rc="$(puerta --locks)"
otras="$(cut -d' ' -f1-2 "$TMP/az.log" | sort -u | grep -vE '^(account list|sql server|lock list)$')"
if [ "$rc" = 0 ] && [ -z "$otras" ] && grep -q '^lock list' "$TMP/az.log" && [ ! -s "$TMP/impostor.log" ] \
   && ! grep -q "$CLAVE_MARCA" "$TMP/az-env.log" && [ ! -s "$TMP/security.log" ] && ! grep -qv '^sql server list' <(grep '^sql' "$TMP/az.log"); then
  ok "6.4 T7 Candados_OnlyListedAzOperations_FixedPaths_CleanEnv · sólo account list, sql server list y lock list; sin la clave"
else no "6.4 T7 · otras=«${otras}» · $(cat "$TMP/az.log")"; fi

# ── T8 · la línea del registro ──────────────────────────────────────────────────────────────────────────────────
l="$(registro | grep '"accion":"candados"' | tail -1)"
if [[ "$l" == *'"exit":0'* ]] && [[ "$l" != *"lock create"* ]] && ! registro | grep "$CLAVE_MARCA" >/dev/null; then
  ok "6.4 T8 Candados_RegistroLine_NoSecrets · accion candados, sin comando ni credenciales"
else no "6.4 T8 · registro: $(registro | tail -2)"; fi

# ── T9 · la guía ────────────────────────────────────────────────────────────────────────────────────────────────
GUIA="$AQUI/guides/produccion-con-permiso.md"
faltan=""
for f in "CanNotDelete" "--locks" "lo pone una persona" "permiso de locks" "az lock create" "ScopeLocked" "suscripción"; do
  grep -q -- "$f" "$GUIA" || faltan="${faltan} «${f}»"
done
[ -z "$faltan" ] && ok "6.4 T9 Guide_DeclaresCandadoAndLimits" || no "6.4 T9 · la guía no dice:$faltan"

# ══ Borrar un grupo: `--delete-group <grupo>` borra sólo lo que puede probar que no es producción ══════════════════
GRUPO=acme-prueba-rg
grupo(){ # $1 = suscripción, $2 = grupo; después, «servidores» y «tipos» separados por «--»
  local s="$1" g="$2"; shift 2
  mkdir -p "$TMP/fake-groups/$s/$g"; : > "$TMP/fake-groups/$s/$g/servers"; : > "$TMP/fake-groups/$s/$g/types"
  local destino=servers
  for x in "$@"; do
    [ "$x" = "--" ] && { destino=types; continue; }
    printf '%s\n' "$x" >> "$TMP/fake-groups/$s/$g/$destino"
  done
}
mundo_grupo(){ mundo; rm -rf "$TMP/fake-groups"; mkdir -p "$TMP/fake-groups"; }
borrados(){ cat "$TMP/az-borrados.log" 2>/dev/null; }

# ── T1 · un grupo seguro se borra: un servidor no-producción, o ninguno ─────────────────────────────────────────
mundo_grupo; SES=$SES_A
grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Sql/servers Microsoft.Web/sites
rc="$(puerta --delete-group "$GRUPO")"
if [ "$rc" = 0 ] && [ "$(borrados | grep -c "group delete -n $GRUPO --subscription sub-1 --yes --no-wait")" = 1 ] \
   && grep -q "$STAGING" "$TMP/out" && grep -q "2 recurso" "$TMP/out" && grep -q "az group exists -n $GRUPO --subscription sub-1" "$TMP/out" \
   && grep -qi "pedido" "$TMP/out"; then
  ok "6.5 T1 BorrarGrupo_SafeGroup_Deletes · pide el borrado una vez, dice qué había y cómo confirmar que terminó"
else no "6.5 T1 · rc=$rc · $(cat "$TMP/out" "$TMP/err") · borrados: $(borrados)"; fi
mundo_grupo; grupo sub-1 vacio-rg --
rc="$(puerta --delete-group vacio-rg)"
[ "$rc" = 0 ] && [ "$(borrados | grep -c "group delete -n vacio-rg")" = 1 ] && ok "6.5 T1 · un grupo sin servidores ni recursos también" || no "6.5 T1 · vacío · rc=$rc · $(cat "$TMP/err")"
mundo_grupo; grupo sub-1 'acme(prueba)' --
rc="$(puerta --delete-group 'acme(prueba)')"
[ "$rc" = 0 ] && [ "$(borrados | grep -c 'group delete -n acme(prueba)')" = 1 ] && ok "6.5 T1 · un grupo con paréntesis en el nombre (Azure los permite)" || no "6.5 T1 · paréntesis · rc=$rc · $(cat "$TMP/err")"
# las suscripciones Warned y PastDue siguen activas: la búsqueda del grupo las mira
mundo_grupo; grupo sub-1 "$GRUPO" --
puerta --delete-group "$GRUPO" >/dev/null
grep '^account list' "$TMP/az.log" | grep 'Warned' | grep 'PastDue' >/dev/null && ok "6.5 T9 · la búsqueda del grupo mira también las suscripciones Warned y PastDue" || no "6.5 T9 · suscripciones: $(grep '^account list' "$TMP/az.log")"

# ── T2 · la línea del registro ──────────────────────────────────────────────────────────────────────────────────
mundo_grupo; SES=$SES_A; grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Sql/servers
puerta --delete-group "$GRUPO" >/dev/null
l="$(registro | grep '"accion":"borrar-grupo"' | tail -1)"
if [[ "$l" == *"\"grupo\":\"$GRUPO\""* ]] && [[ "$l" == *'"servidores":1'* ]] && [[ "$l" == *"\"sesion\":\"$SES_A\""* ]] \
   && [[ "$l" == *'"exit":0'* ]] && ! registro | grep "$CLAVE_MARCA" >/dev/null; then
  ok "6.5 T2 BorrarGrupo_RegistroLine_NoSecrets · grupo, servidores, sesión y exit; sin credenciales"
else no "6.5 T2 · registro: $(registro | tail -1)"; fi

# ── T3 · un nombre que no es de grupo: sale 2 sin llamar a az ──────────────────────────────────────────────────
for nombre in 'rg-*' 'rg$x' "rg'x" 'rg x' '-x' '' "$(printf 'a%.0s' $(seq 1 91))"; do
  mundo_grupo
  rc="$(puerta --delete-group "$nombre")"
  if [ "$rc" = 2 ] && [ ! -s "$TMP/az.log" ]; then ok "6.5 T3 BorrarGrupo_InvalidName_Exit2NoAz · «${nombre:0:12}»"
  else no "6.5 T3 · «${nombre:0:12}» · rc=$rc · az: $(cat "$TMP/az.log" 2>/dev/null)"; fi
done

# ── T4 · sólo el nombre ─────────────────────────────────────────────────────────────────────────────────────────
for extra in "--yes" "--subscription sub-1" "--no-wait" "otro-rg"; do
  mundo_grupo
  # shellcheck disable=SC2086
  rc="$(puerta --delete-group "$GRUPO" $extra)"
  if [ "$rc" = 2 ] && grep -q "uso: tycon-prod-sql --delete-group" "$TMP/err" && [ ! -s "$TMP/az.log" ]; then
    ok "6.5 T4 BorrarGrupo_ExtraArguments_Exit2 · con «${extra}»"
  else no "6.5 T4 · ${extra} · rc=$rc · $(cat "$TMP/err")"; fi
done

# ── T5 · un servidor de producción: se niega y lo nombra ───────────────────────────────────────────────────────
mundo_grupo; grupo sub-1 "$GRUPO" "$STAGING" "$PROD" -- Microsoft.Sql/servers Microsoft.Sql/servers
rc="$(puerta --delete-group "$GRUPO")"
if [ "$rc" = 2 ] && [ -z "$(borrados)" ] && grep -q "$PROD" "$TMP/err" && grep -q "una persona" "$TMP/err"; then
  ok "6.5 T5 BorrarGrupo_ProductionServer_Refuses · no borra, nombra el servidor y dice quién lo borra"
else no "6.5 T5 · rc=$rc · $(cat "$TMP/err") · borrados: $(borrados)"; fi

# ── T6 · un servidor sin declarar: se niega ─────────────────────────────────────────────────────────────────────
mundo_grupo; grupo sub-1 "$GRUPO" x.database.windows.net -- Microsoft.Sql/servers
rc="$(puerta --delete-group "$GRUPO")"
if [ "$rc" = 2 ] && [ -z "$(borrados)" ] && grep -q "x.database.windows.net" "$TMP/err"; then
  ok "6.5 T6 BorrarGrupo_UndeclaredServer_Refuses"
else no "6.5 T6 · rc=$rc · $(cat "$TMP/err")"; fi

# ── T7 · un tipo de base que el catálogo no cubre: se niega ────────────────────────────────────────────────────
for tipo in Microsoft.DBforPostgreSQL/flexibleServers Microsoft.DBforMySQL/flexibleServers Microsoft.DBforMariaDB/servers \
            Microsoft.Sql/managedInstances Microsoft.Sql/instancePools Microsoft.SqlVirtualMachine/sqlVirtualMachines \
            Microsoft.DocumentDB/databaseAccounts Microsoft.Synapse/workspaces; do
  mundo_grupo; grupo sub-1 "$GRUPO" -- Microsoft.Web/sites "$tipo"
  rc="$(puerta --delete-group "$GRUPO")"
  if [ "$rc" = 2 ] && [ -z "$(borrados)" ] && grep -q "$tipo" "$TMP/err"; then ok "6.5 T7 BorrarGrupo_UncoveredDbType_Refuses · ${tipo}"
  else no "6.5 T7 · ${tipo} · rc=$rc · $(cat "$TMP/err")"; fi
done

# ── T8 · un catálogo ilegible: se niega ─────────────────────────────────────────────────────────────────────────
mundo_grupo; grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Sql/servers
printf '{ roto' > "$REPOS/backend-acme/.tycon/production.json"
rc="$(puerta --delete-group "$GRUPO")"
if [ "$rc" = 2 ] && [ -z "$(borrados)" ]; then ok "6.5 T8 BorrarGrupo_IndexUnreadable_Refuses"
else no "6.5 T8 · rc=$rc · $(cat "$TMP/err")"; fi
# la memoria de producción tocada a mano: tampoco borra
mundo_grupo; grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Sql/servers
printf '{ roto' > "$CASA/.claude/.tycon-pipeline/production-memory.json"
rc="$(puerta --delete-group "$GRUPO")"
if [ "$rc" = 2 ] && [ -z "$(borrados)" ] && grep -q "memoria" "$TMP/err"; then ok "6.5 T8 · con la memoria de producción tocada a mano, no borra"
else no "6.5 T8 · memoria tocada · rc=$rc · $(cat "$TMP/err")"; fi

# ── T9 · lo que az no contesta: 2 con el motivo, sin borrar, y el intento anotado ──────────────────────────────
for modo in sin-sesion sin-permiso lento dos ninguna; do
  mundo_grupo; FAKE_AZ=$modo; AZ_TOPE=2
  grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Sql/servers
  [ "$modo" = dos ] && grupo sub-2 "$GRUPO" -- Microsoft.Web/sites
  [ "$modo" = ninguna ] && rm -rf "$TMP/fake-groups/sub-1"
  rc="$(puerta --delete-group "$GRUPO")"
  l="$(registro | grep '"accion":"borrar-grupo"' | tail -1)"
  if [ "$rc" = 2 ] && [ -z "$(borrados)" ] && [ -s "$TMP/err" ] && [[ "$l" == *'"exit":2'* ]]; then
    ok "6.5 T9 BorrarGrupo_AzFailures_Exit2WithReason · ${modo}"
  else no "6.5 T9 · ${modo} · rc=$rc · $(cat "$TMP/err") · registro: ${l}"; fi
  unset FAKE_AZ AZ_TOPE
done
mundo_grupo; grupo sub-1 "$GRUPO" -- ; rm -f "$RAIZ/opt/homebrew/bin/az"
rc="$(puerta --delete-group "$GRUPO")"
l="$(registro | grep '"accion":"borrar-grupo"' | tail -1)"
if [ "$rc" = 2 ] && [ ! -s "$TMP/impostor.log" ] && grep -q "no encuentro az" "$TMP/err" && [[ "$l" == *'"exit":2'* ]]; then
  ok "6.5 T9 · sin az en las rutas fijas: 2 con el motivo, anotado, y no usa el del PATH"
else no "6.5 T9 · sin az · rc=$rc · $(cat "$TMP/err") · ${l}"; fi

# ── T10 · un listado con error, o cortado: «no sé» ──────────────────────────────────────────────────────────────
mundo_grupo; FAKE_AZ=listado-error; grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Sql/servers
rc="$(puerta --delete-group "$GRUPO")"; r1="$rc"; unset FAKE_AZ
# cortado: el listado de recursos trae dos servidores SQL y el de servidores, uno
mundo_grupo; grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Sql/servers Microsoft.Sql/servers
rc="$(puerta --delete-group "$GRUPO")"; r2="$rc"
# al revés: el de servidores trae uno y el de recursos ninguno
mundo_grupo; grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Web/sites
rc="$(puerta --delete-group "$GRUPO")"
if [ "$r1" = 2 ] && [ "$r2" = 2 ] && [ "$rc" = 2 ] && [ -z "$(borrados)" ]; then ok "6.5 T10 BorrarGrupo_TruncatedOrErrorListing_Refuses · con error, y cortado de los dos lados"
else no "6.5 T10 · error=$r1 cortado=$r2 al-revés=$rc · $(cat "$TMP/err")"; fi

# ── T11 · un grupo con candado: Azure lo rechaza y la puerta lo dice ───────────────────────────────────────────
mundo_grupo; FAKE_AZ=scope-locked; grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Sql/servers
rc="$(puerta --delete-group "$GRUPO")"
l="$(registro | grep '"accion":"borrar-grupo"' | tail -1)"
if [ "$rc" = 2 ] && grep -qi "candado" "$TMP/err" && [[ "$l" == *'"exit":2'* ]]; then ok "6.5 T11 BorrarGrupo_LockedGroup_ReportsExit2"
else no "6.5 T11 · rc=$rc · $(cat "$TMP/err") · ${l}"; fi
unset FAKE_AZ

# ── T12 · sólo las operaciones de la lista, el az de la ruta fija y sin la clave ───────────────────────────────
mundo_grupo; grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Sql/servers
rc="$(puerta --delete-group "$GRUPO")"
otras="$(cut -d' ' -f1-2 "$TMP/az.log" | sort -u | grep -vE '^(account list|group show|sql server|resource list|group delete)$')"
if [ "$rc" = 0 ] && [ -z "$otras" ] && [ ! -s "$TMP/impostor.log" ] && ! grep "$CLAVE_MARCA" "$TMP/az-env.log" >/dev/null && [ ! -s "$TMP/security.log" ]; then
  ok "6.5 T12 BorrarGrupo_OnlyListedAzOperations_FixedPaths_CleanEnv"
else no "6.5 T12 · otras=«${otras}» · $(cat "$TMP/az.log")"; fi

# ── Gate_CannotLog_SaysSoInRed — la puerta avisa en rojo sólo cuando no pudo anotar ───────────────────────────────
# La puerta se tragaba el fallo al escribir el registro de producción: algo podía correr sin quedar anotado y nadie se
# enteraba. El aviso sale sólo cuando la escritura falla; con el registro sano, la puerta no dice nada nuevo.
# 🔴 Falla con: el fallo de escritura callado, un aviso en cada uso, o el aviso que cambia la salida de la puerta.
mundo; rc="$(puerta --reclasificar "$STAGING")"
if [ "$rc" = 0 ] && ! grep -q "no pude anotar" "$TMP/err" && grep -q '"accion":"reclasificar"' "$CASA/.claude/.tycon-pipeline/production.log"; then
  ok "Gate_CannotLog_SaysSoInRed · con el registro sano anota y no avisa"
else no "Gate_CannotLog_SaysSoInRed · registro sano: rc=$rc · err: $(head -c 200 "$TMP/err")"; fi
mundo; mkdir -p "$CASA/.claude/.tycon-pipeline/production.log"
rc="$(puerta --reclasificar "$STAGING")"
if [ "$rc" = 0 ] && grep -q "🔴 no pude anotar" "$TMP/err" && grep -q "production.log" "$TMP/err"; then
  ok "Gate_CannotLog_SaysSoInRed · sin poder escribir el registro, lo dice en rojo con la ruta y sale igual"
else no "Gate_CannotLog_SaysSoInRed · sin registro: rc=$rc · err: $(head -c 200 "$TMP/err")"; fi
# El cierre que hace el hook al terminar la sesión también lo dice: la puerta cierra bien (rc 0) y avisa por stderr.
# 🔴 Falla con: el hook que sólo muestra la salida de la puerta cuando el cierre falló.
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
rm -f "$CASA/.claude/.tycon-pipeline/production.log"; mkdir -p "$CASA/.claude/.tycon-pipeline/production.log"
rc="$(gancho SessionEnd "$SES_A")"
if [ "$rc" = 0 ] && grep -q "🔴.*no pude anotar" "$TMP/hook.out" && ! grep -q "^$REGLA " "$TMP/az-reglas"; then
  ok "Gate_CannotLog_SaysSoInRed · el cierre del fin de sesión que no se pudo anotar lo dice en rojo"
else no "Gate_CannotLog_SaysSoInRed · fin de sesión: rc=$rc · $(cat "$TMP/hook.out" "$TMP/hook.err")"; fi
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
rc="$(gancho SessionEnd "$SES_A")"
if [ "$rc" = 0 ] && ! grep -q "no pude anotar" "$TMP/hook.out"; then
  ok "Gate_CannotLog_SaysSoInRed · con el registro sano, el fin de sesión no avisa nada nuevo"
else no "Gate_CannotLog_SaysSoInRed · fin de sesión sano: rc=$rc · $(cat "$TMP/hook.out")"; fi

# ── M1 · el intento de conexión tiene tope: un servidor que no contesta no cuelga la puerta ─────────────────────
# 🔴 Falla con: el intento sin tope de espera (sqlcmd espera lo que quiera el servidor y el cierre de sesión se corta).
mundo; SES=$SES_A; viva $SES_A; rc="$(puerta --open-firewall "$PROD")"
if [ "$rc" = 0 ] && grep -Eq -- "(^| )-l [1-9][0-9]?( |$)" "$TMP/sqlcmd.log"; then
  ok "M1 OpenFirewall_ConnectionAttempt_HasTimeout · el intento de conexión lleva su tope de espera"
else no "M1 · rc=$rc · sqlcmd: $(cat "$TMP/sqlcmd.log" 2>/dev/null)"; fi

# ── M2 · la cuenta de Azure sin permiso al abrir: sale 2, lo dice y deja la regla anotada ───────────────────────
# 🔴 Falla con: un permiso negado leído como apertura (sale 0 o dice «abierta»), o la regla que sale del estado y
#    queda sin rastro si la creación llegó a medias.
mundo; SES=$SES_A; viva $SES_A; FAKE_AZ=crear-sin-permiso; rc="$(puerta --open-firewall "$PROD")"; unset FAKE_AZ
if [ "$rc" = 2 ] && grep -q "no pudo crear la regla" "$TMP/err" && grep -q "AuthorizationFailed" "$TMP/err" \
   && ! grep -q "abierta para" "$TMP/out" && estado | grep "$PROD" >/dev/null && ! grep -q "^$REGLA " "$TMP/az-reglas"; then
  ok "M2 OpenFirewall_AccountWithoutPermission_Exit2AndKeepsTrace · sale 2 con el motivo de Azure y la regla anotada"
else no "M2 · rc=$rc · $(cat "$TMP/out" "$TMP/err") · estado: $(estado)"; fi

echo "— prod-firewall: $pasaron ok, $fallos fallos —"
[ "$fallos" = 0 ]
