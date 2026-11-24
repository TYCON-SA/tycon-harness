#!/usr/bin/env bash
# prod-firewall-deleted-server.test.sh — la regla de firewall de un servidor que ya no existe se cierra con una prueba
# que da Azure, y su aviso no vuelve.
#
# POR QUÉ EXISTE: una regla abierta antes de que la puerta anotara el lugar del servidor (suscripción y grupo) no se
# podía dar por cerrada nunca, aunque el servidor se hubiera borrado: cada arranque reintentaba y avisaba en rojo. Un
# listado vacío no alcanza como prueba, porque Azure esconde lo que la cuenta ya no ve. La prueba es que el nombre del
# servidor esté libre (`checkNameAvailability`): si está libre, no hay servidor que pueda tener la regla. Ante cualquier
# duda, la regla sigue anotada y el aviso sigue.
#
# 🔴 Ningún caso toca Azure, una base, el Llavero ni /opt: raíz de sistema falsa, casa temporal y los dobles de
# lib/prod-firewall-world.sh.
#
# Correr: bash scripts/tests/prod-firewall-deleted-server.test.sh
# En una máquina con el freno instalado (/opt/tycon) la puerta ignora la raíz falsa y el gancho llamaría a la puerta
# real, así que la suite no corre: para medirla ahí, esconder /opt/tycon con sandbox-exec (perfil que niega file-read*,
# file-read-metadata y file-test-existence sobre /opt/tycon). Un salteo no es una medición.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PUERTA="$AQUI/scripts/production/tycon-prod-sql"
HOOK="$AQUI/scripts/hooks/prod-firewall-close.js"
fallos=0; pasaron=0
ok(){ echo "✅ prod-firewall-borrado: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ prod-firewall-borrado: $1"; fallos=$((fallos+1)); }

# el freno a la vista de bash o de node: el gancho usaría la puerta instalada, que habla con Azure de verdad
if [ -d /opt/tycon ] || node -e 'process.exit(require("fs").existsSync("/opt/tycon") ? 0 : 1)' 2>/dev/null; then
  echo "⏭ prod-firewall-borrado: esta máquina tiene el freno instalado (/opt/tycon): la suite no corre para no tocar Azure ni el Llavero reales."
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/prod-firewall-borrado.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
. "$AQUI/scripts/tests/lib/prod-firewall-world.sh"
[ -f "$PUERTA" ] || { no "la puerta no existe ($PUERTA)"; echo "— prod-firewall-borrado: $pasaron ok, $fallos fallos —"; exit 1; }

ESTADO_FW() { printf '%s' "$CASA/.claude/.tycon-pipeline/production-firewall.json"; }
# una regla abierta antes de que la puerta anotara el lugar: sin `sub` ni `rg` en el estado ni en el registro
abrir_sin_lugar(){
  mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; SES=""
  node -e 'const fs=require("fs"),f=process.argv[1],e=JSON.parse(fs.readFileSync(f,"utf8"));e.reglas.forEach(r=>{delete r.sub;delete r.rg});fs.writeFileSync(f,JSON.stringify(e,null,2)+"\n")' "$(ESTADO_FW)"
  sed -i.bak 's/"sub":"sub-1","rg":"rg-acme",//' "$CASA/.claude/.tycon-pipeline/production.log"
  : > "$TMP/az.log"; : > "$TMP/az-env.log"
}
# una regla abierta con el lugar anotado, como abre la puerta hoy
abrir_con_lugar(){ mundo; SES=$SES_A; viva $SES_A; puerta --open-firewall "$PROD" >/dev/null; SES=""; : > "$TMP/az.log"; : > "$TMP/az-env.log"; }
cerrar(){ puerta --close-firewall "$PROD"; }
en_estado(){ estado | grep "$PROD" >/dev/null; }
cierre_anotado(){ registro | grep '"accion":"close-firewall"' | grep '"exit":0' >/dev/null; }
con_prueba(){ registro | grep '"accion":"close-firewall"' | grep '"servidor":"borrado"' | grep '"prueba":"nombre-libre"' | grep '"exit":0' >/dev/null; }
pregunto(){ grep -q '^rest ' "$TMP/az.log"; }
sigue(){ [ "$1" = 2 ] && en_estado && ! cierre_anotado; }   # $1 = rc
salida(){ cat "$TMP/out" "$TMP/err" 2>/dev/null | tr '\n' ' '; }

# ── A · el cierre con prueba ─────────────────────────────────────────────────────────────────────────────────────
# 🔴 Falla con: el cierre de hoy, que sin lugar anotado sale «0 lugar(es)» y deja la regla abierta para siempre.
abrir_sin_lugar; FAKE_AZ=ninguna; FAKE_NOMBRE=libre; rc="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE
# lo que recibió az, guardado para T16 con un nombre que `mundo` no borra
cp "$TMP/az.log" "$TMP/t1-az-llamadas"; cp "$TMP/az-env.log" "$TMP/t1-az-entorno"
if [ "$rc" = 0 ] && grep -q "ya no existe" "$TMP/out" && ! en_estado && con_prueba; then
  ok "T1 CloseFirewall_NoPlace_NameFree_Closes @story-8.311 @ac-1 · sale 0, lo dice, saca la regla y anota la prueba"
else no "T1 · rc=$rc · $(salida) · estado: $(estado) · registro: $(registro | tail -1)"; fi

abrir_sin_lugar; rm -f "$(ESTADO_FW)"; FAKE_AZ=ninguna; FAKE_NOMBRE=libre; rc="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE
if [ "$rc" = 0 ] && grep -q "ya no existe" "$TMP/out" && ! en_estado && con_prueba; then
  ok "T2 CloseFirewall_OnlyInLog_NameFree_Closes @story-8.311 @ac-2 · sin el estado, el registro alcanza"
else no "T2 · rc=$rc · $(salida) · registro: $(registro | tail -1)"; fi

# el barrido de arranque: una sola línea, sin «la sesión que la abrió» y sin comando para correr
linea_borrado(){ # $1 = nombre del caso
  local n; n="$(grep -c . "$TMP/hook.out")"
  [ "$n" = 1 ] && grep -q '^🔒' "$TMP/hook.out" && grep -q "ya no existe" "$TMP/hook.out" && grep -q "cerrada" "$TMP/hook.out" \
    && ! grep -q "la sesión que la abrió" "$TMP/hook.out" && ! grep -q "tycon-prod-sql" "$TMP/hook.out"
}
abrir_sin_lugar; muerta $SES_A; FAKE_AZ=ninguna; FAKE_NOMBRE=libre; rc="$(gancho SessionStart "$SES_B")"; unset FAKE_AZ FAKE_NOMBRE
if [ "$rc" = 0 ] && linea_borrado && ! en_estado; then
  ok "T3 Sweep_DeletedServer_SaysItOnce @story-8.311 @ac-3 · una línea 🔒: el servidor ya no existe y la regla se da por cerrada"
else no "T3 · rc=$rc · salida: $(cat "$TMP/hook.out" "$TMP/hook.err")"; fi
: > "$TMP/az.log"; rc="$(gancho SessionStart "$SES_B")"
if [ "$rc" = 0 ] && [ ! -s "$TMP/hook.out" ] && [ ! -s "$TMP/az.log" ]; then
  ok "T4 Sweep_AfterClosure_SilentAndNoAz @story-8.311 @ac-4 · el arranque siguiente no dice nada ni llama a Azure"
else no "T4 · salida: $(cat "$TMP/hook.out") · az: $(cat "$TMP/az.log")"; fi

abrir_con_lugar; muerta $SES_A; FAKE_AZ=ninguna; rc="$(gancho SessionStart "$SES_B")"; unset FAKE_AZ
if [ "$rc" = 0 ] && linea_borrado && ! en_estado; then
  ok "T17 Sweep_DeletedServerWithPlace_SaysItOnce @story-8.311 @ac-3 · con el lugar anotado, la misma línea 🔒"
else no "T17 · rc=$rc · salida: $(cat "$TMP/hook.out" "$TMP/hook.err")"; fi

# ── B · nunca esconder una regla de un servidor real ───────────────────────────────────────────────────────────
# Con la puerta de hoy estos casos ya salen 2: además exigen que la consulta del nombre haya ocurrido, así prueban que
# el rechazo vino de ella.
abrir_sin_lugar; FAKE_AZ=ninguna; FAKE_NOMBRE=ocupado; rc="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE
if sigue "$rc" && pregunto && grep -q "en uso" "$TMP/err"; then
  ok "T5 CloseFirewall_NameTaken_StaysOpen @story-8.311 @ac-5 · el nombre en uso: sale 2 y la regla sigue"
else no "T5 · rc=$rc · $(salida) · az: $(cat "$TMP/az.log")"; fi

abrir_sin_lugar; FAKE_AZ=ninguna; FAKE_NOMBRE=error; rc="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE
if sigue "$rc" && pregunto; then
  ok "T6 CloseFirewall_NameCheckFails_StaysOpen @story-8.311 @ac-6 · la consulta falla (aunque escriba true): sale 2"
else no "T6 · rc=$rc · $(salida)"; fi

abrir_sin_lugar; FAKE_AZ=ninguna; FAKE_NOMBRE=lento; AZ_TOPE=1; rc="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE AZ_TOPE
if sigue "$rc" && pregunto && grep -qiE "tope" "$TMP/err"; then
  ok "T7 CloseFirewall_NameCheckTimeout_StaysOpen @story-8.311 @ac-6 · la consulta se corta por el tope: sale 2"
else no "T7 · rc=$rc · $(salida)"; fi

raras=0
for respuesta in 'True' '' '"true"' 'true x'; do
  abrir_sin_lugar; printf '%s\n' "$respuesta" > "$TMP/fake-name-odd"; FAKE_AZ=ninguna; FAKE_NOMBRE=raro; rc="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE
  if sigue "$rc" && pregunto; then raras=$((raras+1)); else no "T8 · «${respuesta}» rc=$rc · $(salida)"; fi
done
[ "$raras" = 4 ] && ok "T8 CloseFirewall_NameCheckOddAnswer_StaysOpen @story-8.311 @ac-6 · True, vacía, \"true\" y «true x»: sale 2 en las cuatro"

abrir_sin_lugar; FAKE_AZ=listado-error; FAKE_NOMBRE=libre; rc="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE
if sigue "$rc" && ! pregunto; then
  ok "T9 CloseFirewall_ListingFailed_NeverAsksName @story-8.311 @ac-7 · una suscripción no listó: sale 2 sin consultar el nombre"
else no "T9 · rc=$rc · $(salida) · az: $(cat "$TMP/az.log")"; fi

malos10=""
for m in sin-sesion cuentas-error; do
  abrir_sin_lugar; FAKE_AZ=$m; FAKE_NOMBRE=libre; rc="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE
  sigue "$rc" && ! pregunto || malos10="$malos10 «${m}» rc=$rc $(salida)"
done
if [ -z "$malos10" ]; then
  ok "T10 CloseFirewall_NotLoggedIn_NeverAsksName @story-8.311 @ac-7 · sin sesión o sin poder listar las suscripciones: sale 2 sin consultar"
else no "T10 ·$malos10"; fi

malos11=""
for m in sin-suscripciones ids-raros; do
  abrir_sin_lugar; FAKE_AZ=$m; FAKE_NOMBRE=libre; rc="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE
  sigue "$rc" && ! pregunto || malos11="$malos11 «${m}» rc=$rc $(salida)"
done
if [ -z "$malos11" ]; then
  ok "T11 CloseFirewall_NoValidSubscription_StaysOpen @story-8.311 @ac-8 · ninguna suscripción válida no prueba nada: sale 2 sin consultar"
else no "T11 ·$malos11"; fi

abrir_sin_lugar; FAKE_NOMBRE=libre; rc1="$(cerrar)"; pregunto && p1=si || p1=no; unset FAKE_NOMBRE
cerrada1=no; [ "$rc1" = 0 ] && grep -q "cerrada en $CORTO" "$TMP/out" && cerrada1=si
abrir_sin_lugar; FAKE_AZ=dos; FAKE_NOMBRE=libre; rc2="$(cerrar)"; pregunto && p2=si || p2=no; unset FAKE_AZ FAKE_NOMBRE
if [ "$cerrada1" = si ] && [ "$p1" = no ] && [ "$rc2" = 2 ] && grep -q "no elijo a ciegas" "$TMP/err" && [ "$p2" = no ]; then
  ok "T12 CloseFirewall_ServerFound_NeverAsksName @story-8.311 @ac-9 · un lugar: la cierra; dos: no elige; sin consultar en ninguno"
else no "T12 · un lugar rc=$rc1 consultó=$p1 · dos rc=$rc2 consultó=$p2 · $(salida)"; fi

abrir_con_lugar; FAKE_AZ=ninguna; FAKE_NOMBRE=ocupado; rc="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE
if [ "$rc" = 0 ] && grep -q "ya no existe" "$TMP/out" && ! en_estado && ! pregunto; then
  ok "T13 CloseFirewall_RecordedPlace_NeverAsksName @story-8.311 @ac-10 · con lugar anotado se cierra como hoy, sin consultar el nombre"
else no "T13 · rc=$rc · $(salida) · az: $(cat "$TMP/az.log")"; fi

abrir_sin_lugar; FAKE_AZ=ninguna; FAKE_NOMBRE=reabierta; rc="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE
rea=no; sigue "$rc" && pregunto && rea=si
# el segundo escenario: el archivo de reglas abiertas no se pudo escribir al sacarla
abrir_sin_lugar; FAKE_AZ=ninguna; FAKE_NOMBRE=estado-roto; rcb="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE
rotob=no; [ "$rcb" = 2 ] && ! cierre_anotado && pregunto && rotob=si
if [ "$rea" = si ] && [ "$rotob" = si ]; then
  ok "T14 CloseFirewall_ReopenedMeanwhile_NotRecorded @story-8.311 @ac-11 · reabierta o con el estado sin escribir: sale 2 y no anota el cierre"
else no "T14 · reabierta rc=$rc · estado roto rc=$rcb ($rotob) · $(salida) · estado: $(estado)"; fi

abrir_sin_lugar; rm -f "$(ESTADO_FW)"; FAKE_AZ=ninguna; FAKE_NOMBRE=reabierta; rc="$(cerrar)"; unset FAKE_AZ FAKE_NOMBRE
if sigue "$rc" && pregunto; then
  ok "T18 CloseFirewall_OnlyInLog_ReopenedMeanwhile_NotRecorded @story-8.311 @ac-2 @ac-11 · la entrada que apareció mientras preguntaba queda"
else no "T18 · rc=$rc · $(salida) · estado: $(estado)"; fi

abrir_sin_lugar; FAKE_NOMBRE=libre; rc="$(gancho SessionStart "$SES_B")"; unset FAKE_NOMBRE
if [ "$rc" = 0 ] && [ ! -s "$TMP/hook.out" ] && [ ! -s "$TMP/az.log" ] && en_estado; then
  ok "T15 Sweep_LiveSession_Untouched @story-8.311 @ac-12 · una regla que usa una sesión viva no se toca ni se llama a Azure"
else no "T15 · salida: $(cat "$TMP/hook.out") · az: $(cat "$TMP/az.log")"; fi

# ── C · la forma de la consulta y la guía ───────────────────────────────────────────────────────────────────────
URI='https://management.azure.com/subscriptions/sub-1/providers/Microsoft.Sql/checkNameAvailability?api-version=2023-08-01'
CUERPO='{"name":"acme-sql","type":"Microsoft.Sql/servers"}'
consulta="$(grep '^rest ' "$TMP/t1-az-llamadas")"
GUIA="$AQUI/guides/production-with-permission.md"
if [ "$(printf '%s\n' "$consulta" | grep -c .)" = 1 ] \
   && [ "$consulta" = "rest --method post --uri $URI --headers Content-Type=application/json --body $CUERPO --query available -o json" ] \
   && ! grep -qE 'FAKE_|TMPLOG|TYCON_|CLAUDE_CODE|SQLCMD' "$TMP/t1-az-entorno" && ! grep -q "$CLAVE_MARCA" "$TMP/t1-az-entorno" \
   && [ ! -s "$TMP/impostor.log" ] \
   && grep -q "checkNameAvailability" "$GUIA" && grep -qi "nombre.*libre" "$GUIA" && ! grep -q "queda como abierta" "$GUIA"; then
  ok "T16 NameCheck_RequestShape_AndGuide @story-8.311 @ac-13 @ac-14 · POST a checkNameAvailability con nombre y tipo, entorno limpio; la guía dice la prueba"
else no "T16 · consulta: «${consulta}» · entorno: $(grep -E 'FAKE_|TMPLOG|TYCON_|CLAUDE_CODE|SQLCMD' "$TMP/t1-az-entorno" | head -3) · guía con la prueba: $(grep -c checkNameAvailability "$GUIA")"; fi

echo "— prod-firewall-borrado: $pasaron ok, $fallos fallos —"
[ "$fallos" = 0 ]
