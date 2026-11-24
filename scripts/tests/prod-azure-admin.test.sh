#!/usr/bin/env bash
# prod-azure-admin.test.sh — los cambios de administración de Azure sobre producción (alertas, tamaño o plan) tienen un
# camino aprobado: la puerta, con el cuadro del dueño y su constancia en el registro.
#
# POR QUÉ EXISTE: crear alertas de espacio para una base de producción (`az monitor metrics alert create --scopes <id
# del recurso>`) se frenaba porque el freno reconoce el servidor dentro del identificador del recurso, aunque el comando
# no se conecta a la base. Las salidas que ofrecía no servían: la puerta sólo ejecutaba SQL, reclasificar sería mentir y
# abrir el firewall es otra cosa. Terminó corriéndolo la persona en su terminal, con un guion del asistente.
#
# Como el laboratorio de la emergencia, recorre el pedido «creá alertas de espacio para la base de producción» como lo
# haría un asistente sin conocimiento previo: arranca por el comando de Azure que se le ocurriría, y desde ahí corre
# SÓLO los comandos que le muestran los mensajes.
#
#   T1 — el comando de Azure directo se frena, y el mensaje da el mismo comando por la puerta, sin disfrazarlo
#   T2 — ese comando pasa el freno; la puerta abre el cuadro con el comando entero, corre az y lo anota
#   T3 — con el cuadro rechazado, az no recibe el cambio
#   T4 — una lectura (`monitor metrics alert list`) corre por la puerta sin cuadro, y se anota
#   T5 — una operación sin camino aprobado (borrar el servidor) la frena el freno, y el mensaje dice que se la deje a
#        la persona para su terminal; por la puerta tampoco corre
#   T6 — la regla de firewall con `az` no pasa por `--azure`: el mensaje manda a `--open-firewall`
#   T7 — un argumento con `@` (az lee el contenido de un archivo que el cuadro no muestra) no pasa
#   T8 — la ayuda de la puerta y la guía nombran el camino de Azure
#   T9 — `--debug` y `--verbose` no pasan: az imprimiría los encabezados con la credencial de Azure
#   T10 — «@» después de un «=» (`--name=@ruta`, `--set clave=@ruta`): az lee el archivo igual, así que no pasa
#   T11 — una lectura larga corre: no abre cuadro, así que no tiene el tope del cuadro
#   T12 — el freno no arma, listo para correr, un comando que él mismo frenaría
#
# 🔴 Ningún caso toca Azure, una base, el Llavero ni /opt: raíz de sistema falsa, casa falsa y los dobles de
# lib/prod-firewall-world.sh, con un `az` de mentira que anota lo que recibe.
#
# Correr: bash scripts/tests/prod-azure-admin.test.sh
# En una máquina con el freno instalado (/opt/tycon) la puerta y el freno ignoran la raíz falsa (a propósito) y la suite
# no corre: para medirla ahí, esconder /opt/tycon con sandbox-exec (perfil que niega file-read*, file-read-metadata y
# file-test-existence sobre /opt/tycon).
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PUERTA="$AQUI/scripts/production/tycon-prod-sql"
HOOK="$AQUI/scripts/hooks/prod-firewall-close.js"
FRENO="$AQUI/scripts/hooks/prod-access-guard.js"
GUIA="$AQUI/guides/production-with-permission.md"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ prod-azure-admin: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ prod-azure-admin: $1"; fallos=$((fallos+1)); }

if [ -d /opt/tycon ]; then
  echo "⏭ prod-azure-admin: esta máquina tiene el freno instalado (/opt/tycon): la suite no corre para no tocar Azure ni el Llavero reales."
  exit 0
fi

. "$AQUI/scripts/tests/lib/prod-firewall-world.sh"
RUTA=/opt/tycon/bin/tycon-prod-sql

mundo
# az de mentira para la administración: anota cada llamada con sus argumentos tal cual llegaron, uno por renglón
{ printf '#!/usr/bin/env bash\nTMPLOG="%s"\n' "$TMP"; cat <<'SH'
{ printf '%s\n' "--- llamada"; for a in "$@"; do printf '[%s]\n' "$a"; done; } >> "$TMPLOG/az-admin.log"
case "$1 $2 $3 $4" in
  "monitor metrics alert list") echo '[{"name":"espacio-80"}]' ;;
  "monitor metrics alert create") echo '{"name":"creada"}' ;;
esac
exit 0
SH
} > "$RAIZ/opt/homebrew/bin/az"
chmod +x "$RAIZ/opt/homebrew/bin/az"
cat > "$RAIZ/usr/bin/osascript" <<SH
#!/usr/bin/env bash
printf 'cuadro\n' >> "$TMP/cuadro.log"
for a in "\$@"; do printf '%s\n' "\$a"; done >> "$TMP/cuadro-texto.log"
if [ "\$(cat "$TMP/cuadro-modo" 2>/dev/null)" = rechaza ]; then echo "button returned:Rechazar, gave up:false"; else echo "button returned:Aprobar, gave up:false"; fi
SH
chmod +x "$RAIZ/usr/bin/osascript"
SES=$SES_A; viva $SES_A
# la foto del shell de la sesión, limpia: sin ella el freno le pregunta al shell de login, que en la CI no sabe contestar
mkdir -p "$CASA/.claude/shell-snapshots"
printf '# Snapshot file\n\n# Functions\n# Shell Options\n# Aliases\n# Check for rg availability\nrg () { : }\nexport PATH=/usr/bin\n' \
  > "$CASA/.claude/shell-snapshots/snapshot-zsh-1700000000000-aaaaaa.sh"   # con SESSION_SINCE=0 vale cualquier hora

freno(){
  local payload; payload="$(CMD="$1" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:"/tmp",tool_input:{command:process.env.CMD}}))')"
  printf '%s' "$payload" | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_ROOT="$RAIZ" TYCON_PROD_SESSION_SINCE=0 \
    node "$FRENO" >"$TMP/freno.out" 2>"$TMP/freno.err"
  echo $?
}
eval "$(declare -f puerta | sed '1s/puerta/puerta_mundo/')"
puerta(){ puerta_mundo "$@" > "$TMP/rc"; }
correr(){ # $1 = comando tal como lo mostró un mensaje: el freno y, si pasa, la puerta
  local rc; rc="$(freno "$1")"
  [ "$rc" = 0 ] || { echo "freno:$rc"; return; }
  eval "puerta ${1#"$RUTA" }" >/dev/null
  echo "puerta:$(cat "$TMP/rc" 2>/dev/null)"
}
llamadas(){ awk '/^--- llamada/{n++} END{print n+0}' "$TMP/az-admin.log" 2>/dev/null || echo 0; }

ID="/subscriptions/sub-1/resourceGroups/rg-acme/providers/Microsoft.Sql/servers/$CORTO/databases/acme"
DIRECTO="az monitor metrics alert create -n espacio-80 -g rg-acme --scopes $ID --condition 'avg storage_percent > 80' --description 'Espacio al 80 %'"

# ── T1 · el comando de Azure directo: frena y da el mismo por la puerta ──────────────────────────────────────────
rc="$(freno "$DIRECTO")"
POR_PUERTA="$(grep -oE "$RUTA --azure .*" "$TMP/freno.err" | head -1)"
ESPERADO="$RUTA --azure ${DIRECTO#az }"
if [ "$rc" = 2 ] && [ "$POR_PUERTA" = "$ESPERADO" ]; then
  ok "T1 AzureAdmin_ComandoDirecto_FrenaYDaElMismoPorLaPuerta"
else no "T1 · rc=$rc · dio «${POR_PUERTA}» · $(head -c 500 "$TMP/freno.err")"; fi

# ── T2 · por la puerta: cuadro con el comando entero, az lo recibe tal cual, queda anotado ───────────────────────
: > "$TMP/cuadro.log"; : > "$TMP/az-admin.log"
r="$(correr "$POR_PUERTA")"
if [ "$r" = "puerta:0" ] && [ "$(wc -l < "$TMP/cuadro.log" | tr -d ' ')" = 1 ] \
   && grep -qF "az monitor metrics alert create -n espacio-80 -g rg-acme --scopes $ID --condition 'avg storage_percent > 80'" "$TMP/cuadro-texto.log" \
   && grep -qxF "[avg storage_percent > 80]" "$TMP/az-admin.log" && grep -qxF "[$ID]" "$TMP/az-admin.log" \
   && registro | grep '"accion":"azure".*"aprobacion":"cuadro-propio".*"exit":0' >/dev/null; then
  ok "T2 AzureAdmin_PorLaPuerta_CuadroConElComandoEnteroYConstancia"
else no "T2 · $r · cuadros=$(wc -l < "$TMP/cuadro.log") · $(head -c 300 "$TMP/err") · registro: $(registro | tail -1)"; fi

# ── T3 · cuadro rechazado: az no recibe nada ─────────────────────────────────────────────────────────────────────
printf 'rechaza' > "$TMP/cuadro-modo"; : > "$TMP/az-admin.log"
r="$(correr "$RUTA --azure monitor metrics alert create -n espacio-90 -g rg-acme --scopes $ID --condition 'avg storage_percent > 90'")"
if [ "$r" != "puerta:0" ] && [ "$(llamadas)" = 0 ]; then
  ok "T3 AzureAdmin_CuadroRechazado_AzNoRecibeElCambio"
else no "T3 · $r · llamadas=$(llamadas)"; fi
rm -f "$TMP/cuadro-modo"

# ── T4 · una lectura: sin cuadro, y anotada ──────────────────────────────────────────────────────────────────────
: > "$TMP/cuadro.log"; : > "$TMP/az-admin.log"
r="$(correr "$RUTA --azure monitor metrics alert list -g rg-acme")"
if [ "$r" = "puerta:0" ] && [ ! -s "$TMP/cuadro.log" ] && [ "$(llamadas)" = 1 ] && grep -q espacio-80 "$TMP/out" \
   && registro | tail -1 | grep '"accion":"azure-lectura"' >/dev/null; then
  ok "T4 AzureAdmin_Lectura_SinCuadroYAnotada"
else no "T4 · $r · cuadros=$(wc -l < "$TMP/cuadro.log") · llamadas=$(llamadas) · $(head -c 300 "$TMP/err")"; fi

# ── T5 · sin camino aprobado: el freno dice que se lo deje a la persona; la puerta tampoco lo corre ──────────────
rc="$(freno "az sql server delete -n $CORTO -g rg-acme --yes")"
rc2="$(freno "az sql db delete -s $CORTO -n acme -g rg-acme --yes")"
msg2="$(cat "$TMP/freno.err")"
: > "$TMP/cuadro.log"; : > "$TMP/az-admin.log"
rp="$(puerta "--azure" sql db delete -s "$CORTO" -n acme -g rg-acme --yes; cat "$TMP/rc")"
if [ "$rc" = 2 ] && [ "$rc2" = 2 ] && printf '%s' "$msg2" | grep "dejale el comando a la persona para que lo corra en su terminal" >/dev/null \
   && ! printf '%s' "$msg2" | grep -- "--azure sql db delete" >/dev/null && [ "$rp" != 0 ] && [ "$(llamadas)" = 0 ] && [ ! -s "$TMP/cuadro.log" ]; then
  ok "T5 AzureAdmin_SinCaminoAprobado_SeLeDejaALaPersonaYLaPuertaNoLoCorre"
else no "T5 · rc=$rc rc2=$rc2 puerta=$rp llamadas=$(llamadas) · $(printf '%s' "$msg2" | head -c 500)"; fi

# ── T6 · la regla de firewall no va por --azure ──────────────────────────────────────────────────────────────────
rc="$(freno "$RUTA --azure sql server firewall-rule create -g rg-acme -s $CORTO -n otra --start-ip-address 1.2.3.4 --end-ip-address 1.2.3.4")"
if [ "$rc" = 2 ] && grep -q -- "$RUTA --open-firewall" "$TMP/freno.err"; then
  ok "T6 AzureAdmin_ReglaDeFirewall_VaPorOpenFirewall"
else no "T6 · rc=$rc · $(head -c 400 "$TMP/freno.err")"; fi

# ── T7 · un argumento con @ (contenido de archivo que el cuadro no muestra) no pasa ni por el freno ni por la puerta
rc="$(freno "$RUTA --azure monitor metrics alert create -n x -g rg-acme --scopes $ID --condition @condicion.txt")"
: > "$TMP/az-admin.log"
rp="$(puerta --azure monitor metrics alert create -n x -g rg-acme --scopes "$ID" --condition @condicion.txt; cat "$TMP/rc")"
if [ "$rc" = 2 ] && [ "$rp" != 0 ] && [ "$(llamadas)" = 0 ]; then
  ok "T7 AzureAdmin_ArgumentoConArroba_NoPasa"
else no "T7 · freno=$rc puerta=$rp llamadas=$(llamadas)"; fi

# ── T9 · --debug y --verbose no pasan: az imprimiría los encabezados con la credencial de Azure ──────────────────
rc="$(freno "$RUTA --azure monitor metrics alert list -g rg-acme --debug")"
: > "$TMP/az-admin.log"
rp="$(puerta --azure monitor metrics alert list -g rg-acme --verbose; cat "$TMP/rc")"
if [ "$rc" = 2 ] && [ "$rp" != 0 ] && [ "$(llamadas)" = 0 ]; then
  ok "T9 AzureAdmin_DebugYVerbose_NoPasan"
else no "T9 · freno=$rc puerta=$rp llamadas=$(llamadas)"; fi

# ── T10 · «@» después de un «=» (az lee el archivo igual): no pasa, tampoco en una lectura sin cuadro ───────────
printf 'SECRETO-DE-PRUEBA' > "$TMP/secreto.txt"
rc1="$(freno "$RUTA --azure sql db show -g rg-acme -s $CORTO '--name=@$TMP/secreto.txt'")"
rc2="$(freno "$RUTA --azure sql db update -g rg-acme -s $CORTO -n acme --set 'tags.a=@$TMP/secreto.txt'")"
: > "$TMP/az-admin.log"; : > "$TMP/cuadro.log"
rp1="$(puerta --azure sql db show -g rg-acme -s "$CORTO" "--name=@$TMP/secreto.txt"; cat "$TMP/rc")"
rp2="$(puerta --azure sql db update -g rg-acme -s "$CORTO" -n acme --set "tags.a=@$TMP/secreto.txt"; cat "$TMP/rc")"
if [ "$rc1" = 2 ] && [ "$rc2" = 2 ] && [ "$rp1" != 0 ] && [ "$rp2" != 0 ] && [ "$(llamadas)" = 0 ] && [ ! -s "$TMP/cuadro.log" ]; then
  ok "T10 AzureAdmin_ArrobaTrasIgual_NoPasaNiEnLectura"
else no "T10 · freno=$rc1/$rc2 puerta=$rp1/$rp2 llamadas=$(llamadas)"; fi

# ── T11 · una lectura larga corre: no abre cuadro, así que no tiene su tope ──────────────────────────────────────
LARGA="$RUTA --azure monitor metrics list --resource $ID --metric $(printf 'storage_percent,%.0s' $(seq 1 80))cpu_percent"
: > "$TMP/az-admin.log"
r="$(correr "$LARGA")"
if [ "${#LARGA}" -gt 1200 ] && [ "$r" = "puerta:0" ] && [ "$(llamadas)" = 1 ]; then
  ok "T11 AzureAdmin_LecturaLarga_CorreSinElTopeDelCuadro"
else no "T11 · largo=${#LARGA} · $r · $(head -c 300 "$TMP/err")"; fi

# ── T12 · el freno no sugiere un comando que él mismo frena (--debug, «=@») ──────────────────────────────────────
rc="$(freno "az monitor metrics alert list -g rg-acme --scopes $ID --debug")"
if [ "$rc" = 2 ] && ! grep -E -- "$RUTA --azure monitor" "$TMP/freno.err" >/dev/null && grep -- "sin --debug" "$TMP/freno.err" >/dev/null; then
  ok "T12 AzureAdmin_SugerenciaConDebug_NoSeArmaListaParaCorrer"
else no "T12 · rc=$rc · $(head -c 500 "$TMP/freno.err")"; fi

# ── T8 · la ayuda y la guía nombran el camino ────────────────────────────────────────────────────────────────────
puerta --help
if grep -q -- "--azure <comando de az sin «az»>" "$TMP/out" && grep -q -- "--azure monitor metrics alert create" "$GUIA"; then
  ok "T8 AzureAdmin_AyudaYGuia_NombranElCamino"
else no "T8 · la ayuda o la guía no nombran --azure"; fi

echo "— prod-azure-admin: $pasaron ok, $fallos fallos —"
[ "$fallos" = 0 ]
