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
  echo "⏭ prod-firewall: NO MEDIDO — esta máquina tiene el freno instalado (/opt/tycon): la suite no corre para no tocar Azure ni el Llavero reales."
  exit 0
fi

# el mundo de prueba (raíz falsa, casa, repos y los dobles), compartido con prod-firewall-deleted-server.test.sh
. "$AQUI/scripts/tests/lib/prod-firewall-world.sh"

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
            "--close-firewall $PROD --session" "--close-firewall $PROD --session ../../etc"; do
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

# ── B1-B6 · el servidor se borró en Azure con la regla abierta ─────────────────────────────────────────────────
# Un servidor borrado se lleva sus reglas: con la suscripción anotada al abrir, cerrar lo da por cerrado.
# 🔴 Falla con: el cierre que sale «0 lugares entre tus suscripciones» y deja la regla anotada como abierta para siempre.
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
if estado | grep '"sub": "sub-1"' >/dev/null && estado | grep '"rg": "rg-acme"' >/dev/null \
   && registro | grep '"accion":"open-firewall"' | grep '"sub":"sub-1","rg":"rg-acme"' >/dev/null; then
  ok "B1 OpenFirewall_RecordsSubscription · el estado y el registro anotan la suscripción y el grupo del servidor"
else no "B1 · estado: $(estado) · registro: $(registro)"; fi
SES=""; FAKE_AZ=ninguna; rc="$(puerta --close-firewall "$PROD")"; unset FAKE_AZ
if [ "$rc" = 0 ] && ! estado | grep "$PROD" >/dev/null && grep -q "ya no existe" "$TMP/out" \
   && registro | grep '"accion":"close-firewall"' | grep '"servidor":"borrado"' | grep '"exit":0' >/dev/null; then
  ok "B2 CloseFirewall_ServerDeleted_CountsAsClosed · sale 0, lo dice y saca la regla del estado"
else no "B2 · rc=$rc · $(cat "$TMP/out" "$TMP/err") · estado: $(estado)"; fi
# sin la suscripción anotada (una regla abierta antes de este cambio), como antes: «no sé» y queda anotada
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
f="$CASA/.claude/.tycon-pipeline/production-firewall.json"
node -e 'const fs=require("fs"),f=process.argv[1],e=JSON.parse(fs.readFileSync(f,"utf8"));e.reglas.forEach(r=>{delete r.sub;delete r.rg});fs.writeFileSync(f,JSON.stringify(e))' "$f"
sed -i.bak 's/"sub":"sub-1","rg":"rg-acme",//' "$CASA/.claude/.tycon-pipeline/production.log"
SES=""; FAKE_AZ=ninguna; rc="$(puerta --close-firewall "$PROD")"; unset FAKE_AZ
if [ "$rc" = 2 ] && estado | grep "$PROD" >/dev/null && grep -q "0 lugar" "$TMP/err"; then
  ok "B3 CloseFirewall_NoSubscriptionRecorded_StaysOpen · sin suscripción anotada sale 2 y la regla sigue anotada"
else no "B3 · rc=$rc · $(cat "$TMP/out" "$TMP/err") · estado: $(estado)"; fi
# la cuenta perdió el permiso sobre el servidor: el listado sale vacío sin error, pero eso no dice que no exista
# 🔴 Falla con: el cierre que lee un listado vacío como «borrado» (un rol vencido dejaría la regla viva y sin rastro).
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
SES=""; FAKE_AZ=sin-permiso-servidor; rc="$(puerta --close-firewall "$PROD")"; unset FAKE_AZ
if [ "$rc" = 2 ] && estado | grep "$PROD" >/dev/null && grep -q "AuthorizationFailed" "$TMP/err" && grep -q "sub-1" "$TMP/err"; then
  ok "B4 CloseFirewall_PermissionLost_StaysOpen · sale 2 con el motivo y la regla sigue anotada"
else no "B4 · rc=$rc · $(cat "$TMP/out" "$TMP/err") · estado: $(estado)"; fi
# el servidor se movió a otra suscripción: la regla se fue con él y se cierra allá
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
SES=""; FAKE_AZ=movido; rc="$(puerta --close-firewall "$PROD")"; unset FAKE_AZ
if [ "$rc" = 0 ] && ! grep -q "^$REGLA " "$TMP/az-reglas" && grep "firewall-rule delete" "$TMP/az.log" | grep -- "--subscription sub-2 -g rg-otro" >/dev/null; then
  ok "B7 CloseFirewall_ServerMoved_ClosesWhereItIs · la busca en las demás suscripciones y la cierra allá"
else no "B7 · rc=$rc · $(cat "$TMP/out" "$TMP/err") · az: $(grep firewall-rule "$TMP/az.log")"; fi
# sin el estado, la suscripción sale del registro de la apertura
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; rm -f "$CASA/.claude/.tycon-pipeline/production-firewall.json"
SES=""; FAKE_AZ=ninguna; rc="$(puerta --close-firewall "$PROD")"; unset FAKE_AZ
if [ "$rc" = 0 ] && grep -q "ya no existe" "$TMP/out"; then
  ok "B5 CloseFirewall_StateLost_SubscriptionFromLog · sin el estado, el registro alcanza para darlo por cerrado"
else no "B5 · rc=$rc · $(cat "$TMP/out" "$TMP/err")"; fi
# el fin de sesión pasa por el mismo camino
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
FAKE_AZ=ninguna; rc="$(gancho SessionEnd "$SES_A")"; unset FAKE_AZ
if [ "$rc" = 0 ] && ! estado | grep "$PROD" >/dev/null && registro | grep '"servidor":"borrado"' | grep '"por":"fin-de-sesion"' >/dev/null; then
  ok "B6 SessionEnd_ServerDeleted_CountsAsClosed · el fin de sesión también lo da por cerrado"
else no "B6 · rc=$rc · $(cat "$TMP/hook.out" "$TMP/hook.err") · estado: $(estado)"; fi

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

# ── T31-T38 · la regla vive lo que vive la sesión que la pidió, con un tope de horas (fila 248) ──────────────────
# Abierta desde la terminal de la persona, la regla no quedaba a nombre de ninguna sesión y la cerraba el primer
# arranque de cualquier otra; y una sesión quieta más de 3 minutos (esperando a la persona) se tomaba por muerta.
# Ahora la persona la abre a nombre de la sesión que la pidió (`--session <id>`), «viva» se mira por el proceso que
# Claude Code anota en ~/.claude/sessions (con el respaldo de los 3 minutos, que se dice) y ninguna dura más de 8 h.
sesion_proceso(){ # $1 = sesión, $2 = pid → la anota como Claude Code en ~/.claude/sessions/<pid>.json
  mkdir -p "$CASA/.claude/sessions"; printf '{"pid":%s,"sessionId":"%s","kind":"interactive"}\n' "$2" "$1" > "$CASA/.claude/sessions/$2.json"
}
PID_MUERTO="$( (sleep 0 & echo $!) )"; wait 2>/dev/null; sleep 0.2
mundo; SES=""; rc="$(puerta --open-firewall "$PROD" --session "$SES_A")"
if [ "$rc" = 0 ] && estado | grep "$SES_A" >/dev/null && registro | grep '"accion":"open-firewall"' | grep "\"sesion\":\"$SES_A\"" >/dev/null; then
  ok "T31 OpenFirewall_FromTerminalWithSession_RuleBelongsToThatSession · desde la terminal, a nombre de la sesión que la pidió"
else no "T31 · rc=$rc · $(cat "$TMP/err") · estado: $(estado)"; fi
mundo; SES=""; for args in "--open-firewall $PROD --session ../../etc" "--open-firewall $PROD --session $SES_A otra" "--open-firewall $PROD --session-id $SES_A"; do
  # shellcheck disable=SC2086
  rc="$(puerta $args)"
  if [ "$rc" = 2 ] && [ ! -s "$TMP/az.log" ] && grep -qi "uso" "$TMP/err"; then ok "T32 OpenFirewall_BadSession_Exit2 · «${args}» sale 2 con el uso"
  else no "T32 · «${args}» rc=$rc · $(cat "$TMP/err")"; fi
done
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; muerta $SES_A; sesion_proceso "$SES_A" "$$"
rc="$(gancho SessionStart "$SES_B")"
if [ "$rc" = 0 ] && grep -q "^$REGLA " "$TMP/az-reglas" && estado | grep "$SES_A" >/dev/null; then
  ok "T33 Startup_SessionAliveByProcess_KeepsRule · quieta más de 3 minutos pero con su proceso vivo: no se cierra"
else no "T33 · rc=$rc · $(cat "$TMP/hook.out" "$TMP/hook.err") · reglas: $(cat "$TMP/az-reglas")"; fi
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; viva $SES_A; sesion_proceso "$SES_A" "$PID_MUERTO"
rc="$(gancho SessionStart "$SES_B")"
if [ "$rc" = 0 ] && ! grep -q "^$REGLA " "$TMP/az-reglas"; then
  ok "T34 Startup_SessionProcessGone_ClosesRule · con su proceso terminado se cierra, aunque la conversación se haya escrito recién"
else no "T34 · rc=$rc · $(cat "$TMP/hook.out" "$TMP/hook.err") · reglas: $(cat "$TMP/az-reglas")"; fi
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; muerta $SES_A; rm -rf "$CASA/.claude/sessions"
rc="$(gancho SessionStart "$SES_B")"
if [ "$rc" = 0 ] && ! grep -q "^$REGLA " "$TMP/az-reglas" && grep -q "3 minutos" "$TMP/hook.out"; then
  ok "T35 Startup_NoProcessRegistry_FallsBackTo3Min_AndSaysIt · sin el registro de procesos, el respaldo, y lo dice"
else no "T35 · rc=$rc · $(cat "$TMP/hook.out" "$TMP/hook.err") · reglas: $(cat "$TMP/az-reglas")"; fi
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; sesion_proceso "$SES_A" "$$"
node -e 'const f=process.argv[1]; const e=JSON.parse(require("fs").readFileSync(f,"utf8")); e.reglas[0].abierta=new Date(Date.now()-9*3600e3).toISOString(); require("fs").writeFileSync(f, JSON.stringify(e))' "$CASA/.claude/.tycon-pipeline/production-firewall.json"
rc="$(gancho SessionStart "$SES_B")"
if [ "$rc" = 0 ] && ! grep -q "^$REGLA " "$TMP/az-reglas" && grep -q "8 h" "$TMP/hook.out" && grep -q -- "--open-firewall $PROD --session" "$TMP/hook.out"; then
  ok "T36 Startup_RuleOlderThanCap_ClosesEvenIfAlive · más de 8 h: se cierra aunque la sesión siga viva, y dice cómo reabrirla"
else no "T36 · rc=$rc · $(cat "$TMP/hook.out" "$TMP/hook.err") · reglas: $(cat "$TMP/az-reglas")"; fi
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null
node -e 'const f=process.argv[1]; const e=JSON.parse(require("fs").readFileSync(f,"utf8")); e.reglas[0].abierta="2020-01-01T00:00:00.000Z"; require("fs").writeFileSync(f, JSON.stringify(e))' "$CASA/.claude/.tycon-pipeline/production-firewall.json"
puerta --open-firewall "$PROD" >/dev/null
if ! estado | grep '"abierta": "2020-' >/dev/null; then ok "T37 Reopen_WithItsBox_RestartsTheCap · volver a abrirla con su cuadro cuenta las 8 h de nuevo"
else no "T37 · estado: $(estado)"; fi
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; viva $SES_B; SES=$SES_B FAKE_SQLCMD=acceso puerta --open-firewall "$PROD" >/dev/null
muerta $SES_B; sesion_proceso "$SES_B" "$$"
rc="$(gancho SessionEnd "$SES_A")"
if grep -q "^$REGLA " "$TMP/az-reglas" && estado | grep "$SES_B" >/dev/null; then
  ok "T38 SessionEnd_OtherSessionAliveByProcess_KeepsRule · la otra sesión, quieta pero viva por su proceso, la sigue usando"
else no "T38 · reglas: $(cat "$TMP/az-reglas") · estado: $(estado)"; fi
# de la revisión corta: una anotación vieja de la misma sesión no la da por muerta; sin fecha legible, vencida; y el tope
# se aplica aunque ninguna sesión arranque, porque el freno de cada comando lanza el barrido
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; muerta $SES_A
sesion_proceso "$SES_A" "$PID_MUERTO"; sesion_proceso "$SES_A" "$$"
rc="$(gancho SessionStart "$SES_B")"
if grep -q "^$REGLA " "$TMP/az-reglas"; then ok "T39 Startup_StaleEntryOfSameSession_StillAlive · una anotación vieja no tapa la del proceso vivo"
else no "T39 · reglas: $(cat "$TMP/az-reglas") · $(cat "$TMP/hook.out")"; fi
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; sesion_proceso "$SES_A" "$$"
node -e 'const f=process.argv[1]; const e=JSON.parse(require("fs").readFileSync(f,"utf8")); delete e.reglas[0].abierta; require("fs").writeFileSync(f, JSON.stringify(e))' "$CASA/.claude/.tycon-pipeline/production-firewall.json"
rc="$(gancho SessionStart "$SES_B")"
if ! grep -q "^$REGLA " "$TMP/az-reglas"; then ok "T40 Startup_RuleWithoutReadableDate_CountsAsExpired"
else no "T40 · reglas: $(cat "$TMP/az-reglas") · $(cat "$TMP/hook.out")"; fi
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; sesion_proceso "$SES_A" "$$"
node -e 'const f=process.argv[1]; const e=JSON.parse(require("fs").readFileSync(f,"utf8")); e.reglas[0].abierta=new Date(Date.now()-9*3600e3).toISOString(); require("fs").writeFileSync(f, JSON.stringify(e))' "$CASA/.claude/.tycon-pipeline/production-firewall.json"
printf '{"tool_name":"Bash","hook_event_name":"PreToolUse","cwd":"/tmp","tool_input":{"command":"ls"}}' | \
  env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY HOME="$CASA" TYCON_PROD_ROOT="$RAIZ" TYCON_REPOS_ROOT="$REPOS" TMPLOG="$TMP" TYCON_PROD_GATE="$PUERTA" \
    TYCON_PROD_AZ_TIMEOUT="${AZ_TOPE:-$AZ_TOPE_COMUN}" node "$AQUI/scripts/hooks/prod-access-guard.js" >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do grep -q "^$REGLA " "$TMP/az-reglas" || break; sleep 0.5; done
if ! grep -q "^$REGLA " "$TMP/az-reglas"; then ok "T41 Guard_AnyCommand_LaunchesSweepForExpiredRule · una sesión larga sola no deja la regla pasar de 8 h"
else no "T41 · la regla vencida sigue abierta tras un comando · estado: $(estado)"; fi
espera_cierre "$PROD" || no "T41 · el cierre de fondo no terminó en 2 min"

# ── T41b · un cierre de fondo termina antes de que la prueba siga ──────────────────────────────────────────────
# El cierre que lanza el freno sigue escribiendo su estado y su registro después de borrar la regla. Con la máquina
# cargada (el portón, con el medidor de cobertura) lo hacía sobre el mundo de la prueba siguiente, en la ruta que vio
# al arrancar: T21 encontraba los dos archivos también en ~/.claude/.tycon-pipeline (issue #1855).
mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; sesion_proceso "$SES_A" "$$"
node -e 'const f=process.argv[1]; const e=JSON.parse(require("fs").readFileSync(f,"utf8")); e.reglas[0].abierta=new Date(Date.now()-9*3600e3).toISOString(); require("fs").writeFileSync(f, JSON.stringify(e))' "$CASA/.claude/.tycon-pipeline/production-firewall.json"
printf 'borrar-lento' > "$TMP/fake-az-mode"
printf '{"tool_name":"Bash","hook_event_name":"PreToolUse","cwd":"/tmp","tool_input":{"command":"ls"}}' | \
  env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY HOME="$CASA" TYCON_PROD_ROOT="$RAIZ" TYCON_REPOS_ROOT="$REPOS" TMPLOG="$TMP" TYCON_PROD_GATE="$PUERTA" \
    TYCON_PROD_AZ_TIMEOUT="${AZ_TOPE:-$AZ_TOPE_COMUN}" node "$AQUI/scripts/hooks/prod-access-guard.js" >/dev/null 2>&1
for _ in $(seq 1 40); do grep -q "^$REGLA " "$TMP/az-reglas" || break; sleep 0.5; done
espera_cierre "$PROD"
mundo; mkdir -p "$CASA/.tycon/state"; sleep 4
if [ ! -e "$CASA/.claude/.tycon-pipeline/production-firewall.json" ] && [ ! -e "$CASA/.claude/.tycon-pipeline/production.log" ]; then
  ok "T41b Sweep_FinishesBeforeTheNextWorld · el cierre de fondo no escribe en el mundo de la prueba siguiente"
else no "T41b · el cierre de fondo escribió después en $(ls "$CASA/.claude/.tycon-pipeline" | tr '\n' ' ')"; fi

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
  const ok = ["Edit", "Write"].every((t) => ["/.tycon-pipeline/", "/.tycon/state/"].every((d) => ask.some((r) => r.startsWith(t + "(") && r.includes(d) && r.includes("production-firewall.json"))));
  process.exit(ok ? 0 : 1);' "$PLANT"; then
  ok "T20 · la plantilla pregunta antes de editar o escribir el estado del firewall, en sus dos ubicaciones"
else no "T20 · faltan las reglas ask de Edit/Write sobre production-firewall.json"; fi

# ── T21 · el estado cae donde cae el registro ──────────────────────────────────────────────────────────────────
mundo; mkdir -p "$CASA/.tycon/state"; SES=$SES_A; viva $SES_A; rc="$(puerta --open-firewall "$PROD")"
if [ "$rc" = 0 ] && [ -f "$CASA/.tycon/state/production-firewall.json" ] && [ -f "$CASA/.tycon/state/production.log" ] && [ ! -f "$CASA/.claude/.tycon-pipeline/production-firewall.json" ]; then
  ok "T21 StateFile_PathFollowsStateDirRule · con ~/.tycon/state, el estado y el registro van ahí"
else
  # qué falta, qué sobra y con qué salió la puerta: las dos carpetas existen siempre, así que listarlas no dice nada
  _t21=""
  [ "$rc" = 0 ] || _t21="$_t21 la puerta salió $rc ($(tail -n 2 "$TMP/err" 2>/dev/null | tr '\n' ' '));"
  [ -f "$CASA/.tycon/state/production-firewall.json" ] || _t21="$_t21 falta ~/.tycon/state/production-firewall.json;"
  [ -f "$CASA/.tycon/state/production.log" ] || _t21="$_t21 falta ~/.tycon/state/production.log;"
  [ ! -f "$CASA/.claude/.tycon-pipeline/production-firewall.json" ] || _t21="$_t21 sobra ~/.claude/.tycon-pipeline/production-firewall.json;"
  no "T21 ·$_t21"
fi

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
fuera="$(grep -vE '^(account list|sql server (list|show)|sql server firewall-rule (show|create|update|delete)) ' "$TMP/az.log")"
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
GUIA="$AQUI/guides/production-with-permission.md"
faltan=""
for f in "CanNotDelete" "--locks" "lo pone una persona" "permiso de locks" "az lock create" "ScopeLocked" "suscripción" \
         "--close-firewall\` también falla con" "queda abierta. Por eso no pongas el candado"; do
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

# ── T1b · el borrado lo aprueba el cuadro de la puerta: sin su «Aprobar» no se pide nada a Azure ─────────────────────
# La configuración administrada ya no pregunta por la puerta: este cuadro es la única aprobación de un borrado. Es el
# cuadro del sistema, el de la terminal (SES vacía): pedido por una sesión, lo aprueba el click en la sesión
mundo_grupo; SES=""; grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Sql/servers
rc="$(puerta --delete-group "$GRUPO")"
if [ "$rc" = 0 ] && grep -q '^cuadro' "$TMP/cuadro.log" 2>/dev/null; then ok "6.5 T1b BorrarGrupo_PideElCuadro · el borrado aprobado pasó por el cuadro de la puerta"
else no "6.5 T1b BorrarGrupo_PideElCuadro · rc=$rc · cuadro: $(cat "$TMP/cuadro.log" 2>/dev/null)"; fi
# el cuadro empieza por lo que no tiene vuelta atrás, y la lista de servidores tiene tope: el cuadro no corta la advertencia
S7=("$STAGING" "$STAGING" "$STAGING" "$STAGING" "$STAGING" "$STAGING" "$STAGING")
T7=(Microsoft.Sql/servers Microsoft.Sql/servers Microsoft.Sql/servers Microsoft.Sql/servers Microsoft.Sql/servers Microsoft.Sql/servers Microsoft.Sql/servers)
mundo_grupo; SES=""; grupo sub-1 "$GRUPO" "${S7[@]}" -- "${T7[@]}"
printf '#!/usr/bin/env bash\nprintf "%%s" "${@: -1}" > "%s/cuadro-texto"\necho "button returned:Rechazar, gave up:false"\n' "$TMP" > "$RAIZ/usr/bin/osascript"
puerta --delete-group "$GRUPO" >/dev/null
if grep -q "^Pide: .*" "$TMP/cuadro-texto" 2>/dev/null && grep -q "^No tiene vuelta atrás: borrar el grupo de recursos $GRUPO" "$TMP/cuadro-texto" && grep -q "y 2 más" "$TMP/cuadro-texto"; then
  ok "6.5 T1b BorrarGrupo_PideElCuadro · el cuadro dice primero que no tiene vuelta atrás, y lista cinco servidores y cuántos más"
else no "6.5 T1b BorrarGrupo_PideElCuadro · texto del cuadro: $(head -c 400 "$TMP/cuadro-texto" 2>/dev/null)"; fi
for respuesta in 'button returned:Rechazar, gave up:false' 'button returned:, gave up:true'; do
  mundo_grupo; SES=""; grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Sql/servers
  printf '#!/usr/bin/env bash\necho "%s"\n' "$respuesta" > "$RAIZ/usr/bin/osascript"
  rc="$(puerta --delete-group "$GRUPO")"
  if [ "$rc" = 2 ] && [ -z "$(borrados)" ] && grep -q "no aprobó esta operación" "$TMP/err"; then
    ok "6.5 T1b BorrarGrupo_PideElCuadro · con «${respuesta%%,*}» sale 2 y no le pide el borrado a Azure"
  else no "6.5 T1b BorrarGrupo_PideElCuadro · «${respuesta}»: rc=$rc · borrados: $(borrados) · $(head -c 160 "$TMP/err")"; fi
done
# pedido por una sesión, el borrado lo aprueba el click en la sesión: sin click (el doble rechaza) no se le pide nada a
# Azure, y la pregunta empieza diciendo que no tiene vuelta atrás, con el grupo
mundo_grupo; SES=$SES_A; grupo sub-1 "$GRUPO" "$STAGING" -- Microsoft.Sql/servers
printf 'rechaza' > "$TMP/cuadro-modo"
rc="$(puerta --delete-group "$GRUPO")"
if [ "$rc" = 2 ] && [ -z "$(borrados)" ] && grep -qF '"--kind","borrar-grupo","--host","'"$GRUPO"'"' "$TMP/aprobacion-argv.json"; then
  ok "6.5 T1b BorrarGrupo_PideElCuadro · desde una sesión, sin click sale 2 y no le pide el borrado a Azure"
else no "6.5 T1b BorrarGrupo_PideElCuadro · desde una sesión, sin click: rc=$rc · borrados: $(borrados) · $(head -c 160 "$TMP/err")"; fi
rm -f "$TMP/cuadro-modo"

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
mundo; rc="$(puerta --reclassify "$STAGING")"
if [ "$rc" = 0 ] && ! grep -q "no pude anotar" "$TMP/err" && grep -q '"accion":"reclasificar"' "$CASA/.claude/.tycon-pipeline/production.log"; then
  ok "Gate_CannotLog_SaysSoInRed · con el registro sano anota y no avisa"
else no "Gate_CannotLog_SaysSoInRed · registro sano: rc=$rc · err: $(head -c 200 "$TMP/err")"; fi
mundo; mkdir -p "$CASA/.claude/.tycon-pipeline/production.log"
rc="$(puerta --reclassify "$STAGING")"
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
