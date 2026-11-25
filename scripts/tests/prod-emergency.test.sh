#!/usr/bin/env bash
# prod-emergency.test.sh — con producción caída, los mensajes del freno y de la puerta llevan solos al arreglo.
#
# POR QUÉ EXISTE: una base de producción llegó a su tope y dejó de escribir. La puerta falló por el firewall y su error
# no nombraba `--open-firewall`; `--help` lo frenaba el freno por «invocación no canónica»; una lectura de Azure
# (`az sql db list`) también se frenaba sin decir qué usar. El asistente concluyó que no había camino y mandó a la
# persona al portal: la mitigación, que por la puerta tardaba segundos, se demoró varias idas y vueltas.
#
# El laboratorio recorre el incidente como lo haría un asistente sin conocimiento previo: arranca por los comandos que
# se le ocurrirían primero y, desde ahí, corre SÓLO los comandos que le muestran los mensajes, sin que la suite le
# dicte ninguno. Termina cuando el cambio corrió por la puerta, aprobado en el cuadro.
#
#   T1 — `sqlcmd` directo: el freno nombra la puerta para cambios, `--open-firewall`, `--help` y la emergencia
#   T2 — `--help` con la ruta absoluta pasa el freno, y la puerta lista las formas y la emergencia sin tocar nada
#   T3 — el nombre pelado con `--help` se frena, y el mensaje da la forma canónica con todas las opciones
#   T4 — `az sql db list` sobre producción se frena y dice qué consulta usar por la puerta, y cómo abrir el firewall
#   T5 — la consulta por la puerta, rechazada por el firewall: la puerta da el comando para abrirlo
#   T6 — el comando que dio la puerta pasa el freno y abre la regla de esta máquina, con cuadro
#   T7 — la misma consulta, ahora conecta; el cambio (alter database) pasa el freno y corre, con su cuadro
#   T8 — nada escribe sin el cuadro: con el cuadro rechazado, el cambio no llega al cliente de base
#   T9 — la guía tiene la sección de emergencia que nombran los mensajes
#
# 🔴 Ningún caso toca Azure, una base, el Llavero ni /opt: raíz de sistema falsa, casa falsa y los dobles de
# lib/prod-firewall-world.sh. El cliente de base de mentira rechaza por firewall hasta que hay una regla, y anota cada
# sentencia que le llega.
#
# Correr: bash scripts/tests/prod-emergency.test.sh
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
ok(){ echo "✅ prod-emergency: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ prod-emergency: $1"; fallos=$((fallos+1)); }

if [ -d /opt/tycon ]; then
  echo "⏭ prod-emergency: esta máquina tiene el freno instalado (/opt/tycon): la suite no corre para no tocar Azure ni el Llavero reales."
  exit 0
fi

. "$AQUI/scripts/tests/lib/prod-firewall-world.sh"
RUTA=/opt/tycon/bin/tycon-prod-sql

mundo
# el cliente de base de la emergencia: sin regla en el firewall, el rechazo 40615; con regla, conecta, anota cada
# sentencia y contesta una base llena
cat > "$RAIZ/opt/tycon/bin/sqlcmd" <<SH
#!/usr/bin/env bash
[ -n "\${SQLCMDPASSWORD:-}" ] || { echo "liner: function not supported in this terminal"; exit 1; }
# el servidor propio (no Azure) contesta con el mismo texto de rechazo: la puerta no tiene que mandarlo al firewall
case "\$*" in *"$PROPIO"*) echo "Client with IP address '$IP_PUB' is not allowed to access the server."; exit 1 ;; esac
if [ ! -s "$TMP/az-reglas" ]; then
  echo "Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Cannot open server '$CORTO' requested by the login. Client with IP address '$IP_PUB' is not allowed to access the server.  To enable access, use the Azure Management Portal or run sp_set_firewall_rule on the master database to create a firewall rule for this IP address or address range.  It may take up to five minutes for this change to take effect."
  exit 1
fi
q=""; while [ \$# -gt 0 ]; do [ "\$1" = -Q ] && q="\$2"; shift; done
printf '%s\n' "\$q" >> "$TMP/sentencias.log"
case "\$q" in
  *sys.database_files*) printf 'name|mb|max_mb\nacme|2048|2048\n' ;;
  # un 40615 en los datos, y después otro error: no es el firewall
  *no_existe*) printf 'x\n40615\nMsg 208, Level 16, State 1: Invalid object name no_existe.\n'; exit 1 ;;
  *) : ;;
esac
exit 0
SH
chmod +x "$RAIZ/opt/tycon/bin/sqlcmd"
# el cuadro: aprueba o rechaza según cuadro-modo, y anota cada vez que se abre
cat > "$RAIZ/usr/bin/osascript" <<SH
#!/usr/bin/env bash
printf 'cuadro\n' >> "$TMP/cuadro.log"
if [ "\$(cat "$TMP/cuadro-modo" 2>/dev/null)" = rechaza ]; then echo "button returned:Rechazar, gave up:false"; else echo "button returned:Aprobar, gave up:false"; fi
SH
chmod +x "$RAIZ/usr/bin/osascript"
# el Llavero: una entrada con usuario que sólo confía en la herramienta del sistema (el formato real de dump-keychain)
cat > "$RAIZ/usr/bin/security" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMP/security.log"
case "\$1" in
  find-generic-password)
    for a in "\$@"; do [ "\$a" = "-w" ] && { printf '%s\n' "$CLAVE_MARCA"; exit 0; }; done
    printf 'keychain: "x"\n"acct"<blob>="usuario-de-prueba"\n"svce"<blob>="tycon-prod-acme"\n'; exit 0 ;;
  dump-keychain)
    printf 'keychain: "x"\nclass: "genp"\nattributes:\n    "acct"<blob>="usuario-de-prueba"\n    "svce"<blob>="tycon-prod-acme"\naccess: 1 entries\n'
    printf '    entry 0:\n        authorizations (1): decrypt\n        applications (1):\n            0: /usr/bin/security (OK)\n'
    exit 0 ;;
esac
exit 0
SH
chmod +x "$RAIZ/usr/bin/security"
SES=$SES_A; viva $SES_A
# la foto del shell de la sesión, limpia (sin alias ni funciones): sin ella el freno le pregunta al shell de login, que en
# una máquina sin zsh ni bash como SHELL (la CI) no sabe contestar y frena la forma canónica
mkdir -p "$CASA/.claude/shell-snapshots"
printf '# Snapshot file\n\n# Functions\n# Shell Options\n# Aliases\n# Check for rg availability\nrg () { : }\nexport PATH=/usr/bin\n' \
  > "$CASA/.claude/shell-snapshots/snapshot-zsh-1700000000000-aaaaaa.sh"   # con SESSION_SINCE=0 vale cualquier hora

# el freno, con la casa y la raíz falsas; imprime el exit code y deja el mensaje en freno.err
# El evento lleva el tope de 5 minutos que pide la puerta en primer plano: sin él, el freno la frena por el tope.
freno(){
  local payload; payload="$(CMD="$1" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:"/tmp",tool_input:{command:process.env.CMD,timeout:300000}}))')"
  printf '%s' "$payload" | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_ROOT="$RAIZ" TYCON_PROD_SESSION_SINCE=0 \
    node "$FRENO" >"$TMP/freno.out" 2>"$TMP/freno.err"
  echo $?
}
# lo que haría el asistente con un comando que le mostró un mensaje: pasarlo por el freno y, si pasa, correrlo
# (la ruta absoluta de la puerta es la del repo bajo la raíz falsa)
correr(){ # $1 = comando tal como lo mostró el mensaje
  local rc; rc="$(freno "$1")"
  [ "$rc" = 0 ] || { echo "freno:$rc"; return; }
  eval "puerta ${1#"$RUTA" }" >/dev/null
  echo "puerta:$(cat "$TMP/rc" 2>/dev/null)"
}
# `puerta` del mundo imprime el exit code; acá se guarda para que `correr` lo devuelva
eval "$(declare -f puerta | sed '1s/puerta/puerta_mundo/')"
puerta(){ puerta_mundo "$@" > "$TMP/rc"; }
# la primera línea de un texto que empieza con la ruta de la puerta y tiene la opción pedida
comando_en(){ # $1 = archivo, $2 = patrón que sigue a la ruta
  grep -oE "$RUTA $2" "$1" | head -1
}

# ── T1 · lo primero que se le ocurre: sqlcmd directo ─────────────────────────────────────────────────────────────
rc="$(freno "sqlcmd -S $PROD -d acme -Q \"select 1\"")"
if [ "$rc" = 2 ] && grep -q -- "--open-firewall" "$TMP/freno.err" && grep -qi "o cambiar" "$TMP/freno.err" \
   && grep -q -- "$RUTA --help" "$TMP/freno.err" && grep -q "Emergencia: producción caída" "$TMP/freno.err"; then
  ok "T1 Emergencia_SqlcmdDirecto_FrenoNombraFirewallCambiosAyudaYEmergencia"
else no "T1 · rc=$rc · $(head -c 400 "$TMP/freno.err")"; fi

# ── T2 · la ayuda, tal como la nombró el freno ───────────────────────────────────────────────────────────────────
AYUDA="$(comando_en "$TMP/freno.err" '--help')"
: > "$TMP/cuadro.log"
r="$(correr "$AYUDA")"
if [ "$r" = "puerta:0" ] && grep -q -- "--open-firewall <host>" "$TMP/out" && grep -qi "alter database" "$TMP/out" \
   && grep -q "Emergencia" "$TMP/out" && [ ! -s "$TMP/cuadro.log" ] && [ ! -s "$TMP/sentencias.log" ] && [ ! -s "$TMP/az.log" ]; then
  ok "T2 Emergencia_AyudaCanonica_PasaElFrenoYListaFormasSinTocarNada"
else no "T2 · «${AYUDA}» → $r · $(head -c 300 "$TMP/out") $(head -c 300 "$TMP/err")"; fi

# ── T3 · el nombre pelado con --help: se frena, pero el mensaje enseña la forma ──────────────────────────────────
rc="$(freno "tycon-prod-sql --help")"
if [ "$rc" = 2 ] && grep -q -- "$RUTA --help" "$TMP/freno.err" && grep -q -- "$RUTA --open-firewall <host>" "$TMP/freno.err"; then
  ok "T3 Emergencia_AyudaSinRuta_FrenaYMuestraLaFormaCanonica"
else no "T3 · rc=$rc · $(head -c 400 "$TMP/freno.err")"; fi

# ── T4 · una lectura de Azure sobre producción: frena y dice qué usar en su lugar ────────────────────────────────
rc="$(freno "az sql db list -s $CORTO -g rg-acme")"
LEER="$(comando_en "$TMP/freno.err" "$PROD 'select name, size/128 as mb, max_size/128 as max_mb from sys.database_files'")"
if [ "$rc" = 2 ] && [ -n "$LEER" ] && grep -q -- "$RUTA --open-firewall $PROD" "$TMP/freno.err"; then
  ok "T4 Emergencia_LecturaAzure_FrenaYDaLaConsultaPorLaPuerta"
else no "T4 · rc=$rc · $(head -c 600 "$TMP/freno.err")"; fi

# ── T5 · la consulta que dio el freno: el firewall la rechaza, y la puerta dice qué hacer ────────────────────────
: > "$TMP/cuadro.log"
r="$(correr "$LEER")"
# Abrir el firewall lo corre la persona en su terminal (el modo automático del asistente lo frena, fila 248): el mensaje
# lo dice de entrada y trae el comando para copiar, a nombre de la sesión que lo pidió.
ABRIR="$(comando_en "$TMP/out" "--open-firewall [^ ]+ --session [^ ]+")"
if [ "$r" = "puerta:1" ] && [ "$ABRIR" = "$RUTA --open-firewall $PROD --session $SES_A" ] && grep -q "No hace falta el portal" "$TMP/out" \
   && grep -qi "en su terminal" "$TMP/out"; then
  ok "T5 Emergencia_RechazoDelFirewall_LaPuertaDaElComandoParaLaTerminalDeLaPersona"
else no "T5 · $r · abrir=«${ABRIR}» · $(tail -c 500 "$TMP/out")"; fi

# ── T6 · la persona corre ese comando en su terminal: abre la regla con cuadro, a nombre de la sesión ────────────
: > "$TMP/cuadro.log"
SES=""; eval "puerta ${ABRIR#"$RUTA" }" >/dev/null; r="puerta:$(cat "$TMP/rc" 2>/dev/null)"; SES=$SES_A
if [ "$r" = "puerta:0" ] && grep -q " $IP_PUB$" "$TMP/az-reglas" && [ "$(wc -l < "$TMP/cuadro.log" | tr -d ' ')" = 1 ] \
   && grep -q "$SES_A" "$CASA/.claude/.tycon-pipeline/production-firewall.json"; then
  ok "T6 Emergencia_AbrirFirewallEnLaTerminal_AbreUnaReglaConCuadro_DeLaSesion"
else no "T6 · $r · reglas=$(cat "$TMP/az-reglas") · cuadros=$(wc -l < "$TMP/cuadro.log") · $(head -c 300 "$TMP/err")"; fi

# ── T7 · la consulta conecta y muestra la base llena; el cambio corre por la puerta, con su cuadro ───────────────
r1="$(correr "$LEER")"
CAMBIO="$RUTA $PROD 'alter database [acme] modify (maxsize = 250 GB)'"
grep -qF "$RUTA <host> 'alter database [<base>] modify (maxsize = 250 GB)'" "$GUIA" || CAMBIO=""
: > "$TMP/cuadro.log"
r2="$( [ -n "$CAMBIO" ] && correr "$CAMBIO")"
if [ "$r1" = "puerta:0" ] && [ "$r2" = "puerta:0" ] && grep -qx "alter database \[acme\] modify (maxsize = 250 GB)" "$TMP/sentencias.log" \
   && [ "$(wc -l < "$TMP/cuadro.log" | tr -d ' ')" = 1 ]; then
  ok "T7 Emergencia_CambioPorLaPuerta_PasaElFrenoYCorreConSuCuadro"
else no "T7 · lectura=$r1 · cambio=$r2 · sentencias=$(cat "$TMP/sentencias.log" 2>/dev/null) · $(head -c 300 "$TMP/err")"; fi

# ── T8 · nada escribe sin el cuadro ──────────────────────────────────────────────────────────────────────────────
printf 'rechaza' > "$TMP/cuadro-modo"; : > "$TMP/sentencias.log"
r="$(correr "$RUTA $PROD 'alter database [acme] modify (maxsize = 500 GB)'")"
if [ "$r" != "puerta:0" ] && [ ! -s "$TMP/sentencias.log" ] && ! grep -q '^security' "$TMP/security.log" 2>/dev/null; then
  ok "T8 Emergencia_CuadroRechazado_ElCambioNoLlegaALaBase"
else no "T8 · $r · sentencias=$(cat "$TMP/sentencias.log")"; fi
rm -f "$TMP/cuadro-modo"

# ── T9 · la guía tiene lo que los mensajes nombran ───────────────────────────────────────────────────────────────
if grep -q "^## Emergencia: producción caída" "$GUIA" && grep -q -- "--open-firewall <host>" "$GUIA"; then
  ok "T9 Emergencia_Guia_TieneLaSeccionQueNombranLosMensajes"
else no "T9 · la guía no tiene «## Emergencia: producción caída»"; fi

# ── T10 · un 40615 en los datos de una consulta que falla por otra cosa no manda al firewall ─────────────────────
r="$(correr "$RUTA $PROD 'select 40615 as x; select * from no_existe'")"
if [ "$r" = "puerta:1" ] && ! grep -q -- "--open-firewall" "$TMP/out"; then
  ok "T10 Emergencia_40615EnLosDatos_NoEsElFirewall"
else no "T10 · $r · $(tail -c 300 "$TMP/out")"; fi

# ── T11 · un servidor propio (no Azure) rechazado: no se le sugiere --open-firewall, que la puerta no le acepta ───
r="$(correr "$RUTA $PROPIO 'select 1'")"
if [ "$r" = "puerta:1" ] && grep -q "is not allowed to access the server" "$TMP/out" && ! grep -q -- "--open-firewall" "$TMP/out"; then
  ok "T11 Emergencia_ServidorNoAzure_NoSugiereElFirewall"
else no "T11 · $r · $(tail -c 300 "$TMP/out")"; fi

# ── T12 · un cambio de az que nombra «list» como valor, o que encadena un borrado, no se presenta como lectura ────
rc1="$(freno "az sql db create -n list -s $CORTO -g rg-acme")"; e1="$(cat "$TMP/freno.err")"
rc2="$(freno "az sql db list -s $CORTO -g rg-acme && az sql db delete -n acme -s $CORTO -g rg-acme --yes")"; e2="$(cat "$TMP/freno.err")"
if [ "$rc1" = 2 ] && [ "$rc2" = 2 ] && ! printf '%s\n%s' "$e1" "$e2" | grep "Las lecturas de Azure" >/dev/null; then
  ok "T12 Emergencia_CambioConPalabraList_NoEsLectura"
else no "T12 · rc1=$rc1 rc2=$rc2"; fi

# ── T13 · un host sin declarar: no se le sugieren consultas que la puerta rechazaría; y la sugerencia dice qué mide ─
rc="$(freno "az sql db list -s otro-sin-declarar -g rg-x")"
if [ "$rc" = 2 ] && ! grep -q "sys.database_files" "$TMP/freno.err"; then
  rc="$(freno "az sql db list -s $CORTO -g rg-acme")"
  if [ "$rc" = 2 ] && grep -q "master" "$TMP/freno.err"; then ok "T13 Emergencia_HostSinDeclarar_SinConsultasYLaSugerenciaDiceQueMide"
  else no "T13 · la sugerencia no dice que sin «base» mide master"; fi
else no "T13 · rc=$rc · $(head -c 400 "$TMP/freno.err")"; fi

echo "— prod-emergency: $pasaron ok, $fallos fallos —"
[ "$fallos" = 0 ]
