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
    case "${FAKE_AZ:-ok}:$s" in
      ninguna:*) : ;;
      dos:*) echo "rg-acme" ;;
      *:sub-1) echo "rg-acme" ;;
    esac; exit 0 ;;
esac
case "$1 $2 $3 $4" in
  "sql server firewall-rule show")
    # show-error: Azure contesta otra cosa que «no existe» (límite de pedidos, red, permiso)
    [ "$FAKE_AZ" = show-error ] && { echo "ERROR: (TooManyRequests) Too many requests. Retry later." >&2; exit 1; }
    n="$(arg -n "$@")"; l="$(grep "^$n " "$TMPLOG/az-reglas")"
    [ -n "$l" ] || { echo "ERROR: (ResourceNotFound) The Resource 'Microsoft.Sql/servers/x/firewallRules/$n' was not found." >&2; exit 3; }
    echo "${l#* }"; exit 0 ;;
  "sql server firewall-rule create"|"sql server firewall-rule update")
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

echo "— prod-firewall: $pasaron ok, $fallos fallos —"
[ "$fallos" = 0 ]
