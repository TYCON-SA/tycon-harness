#!/usr/bin/env bash
# prod-firewall-world.sh — el mundo de prueba de la puerta de producción y su firewall: raíz de sistema falsa, casa
# falsa, repos con su catálogo y dobles de `az`, `sqlcmd`, `security`, `ioreg` y el cuadro, que anotan lo que reciben.
#
# Vive en `lib/` porque lo usan varias suites (prod-firewall.test.sh, prod-firewall-deleted-server.test.sh,
# prod-emergency.test.sh y prod-azure-admin.test.sh): dos copias del mismo doble se separan solas. Antes de cargarlo, la suite define `TMP` (su carpeta temporal), `PUERTA` y `HOOK`, y ya
# comprobó que el freno no está instalado: con /opt/tycon a la vista, la puerta ignora la raíz falsa.
#
# 🔴 Nada de esto toca Azure, una base, el Llavero ni /opt. La puerta llama a `az` con el entorno limpio, así que el doble
# lee sus modos de archivos que están al lado de su registro: `fake-az-mode` (FAKE_AZ, lo que contesta Azure en general) y
# `fake-name-mode` (FAKE_NOMBRE, lo que contesta la consulta del nombre del servidor). Sin FAKE_NOMBRE, el nombre sale
# ocupado.

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
  rm -rf "$RAIZ" "$CASA" "$REPOS" "$TMP"/*.log "$TMP/az-reglas" "$TMP/fake-name-odd"
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
  # la puerta llama a az con un entorno limpio: la carpeta y los modos van escritos, no en variables
  { printf '#!/usr/bin/env bash\nTMPLOG="%s"\nHOST_PROD="%s"\n' "$TMP" "$PROD"; cat <<'SH'
FAKE_AZ="$(cat "$TMPLOG/fake-az-mode" 2>/dev/null)"
FAKE_NOMBRE="$(cat "$TMPLOG/fake-name-mode" 2>/dev/null)"
printf '%s\n' "$*" >> "$TMPLOG/az.log"
env >> "$TMPLOG/az-env.log"
case "${FAKE_AZ:-ok}" in
  sin-sesion) echo "ERROR: Please run 'az login' to setup account." >&2; exit 1 ;;
  lento) sleep 5 ;;
esac
arg(){ local k="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$k" ] && { echo "$2"; return; }; shift; done; }
# la consulta del nombre del servidor (checkNameAvailability, con `-o json`: el booleano tal cual)
if [ "$1" = rest ]; then
  ESTADO_FW="$TMPLOG/casa/.claude/.tycon-pipeline/production-firewall.json"
  case "${FAKE_NOMBRE:-}" in
    libre) echo true ;;
    # error y lento escriben `true` antes de fallar: quien mire sólo el texto, y no cómo salió az, cerraría la regla
    error) echo true; echo "ERROR: (AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Sql/checkNameAvailability/action'." >&2; exit 1 ;;
    lento) echo true; sleep 5 ;;
    raro) cat "$TMPLOG/fake-name-odd" 2>/dev/null ;;
    # reabierta: alguien vuelve a abrir la regla mientras la puerta pregunta (sube su versión, o la crea si no estaba)
    reabierta)
      if [ -f "$ESTADO_FW" ]; then /usr/bin/perl -0pi -e 's/("rev":\s*)(\d+)/$1.($2+1)/e' "$ESTADO_FW"
      else printf '{"reglas":[{"host":"%s","regla":"tycon-gate-otra","ip":"198.51.100.9","sesiones":[],"rev":1}]}\n' "$HOST_PROD" > "$ESTADO_FW"
      fi
      echo true ;;
    # estado-roto: el archivo de reglas abiertas queda ilegible mientras la puerta pregunta
    estado-roto) printf 'no es json' > "$ESTADO_FW"; echo true ;;
    *) echo false ;;
  esac
  exit 0
fi
case "$1 $2" in
  "account list")
    case "${FAKE_AZ:-ok}" in
      sin-suscripciones) : ;;
      ids-raros) printf 'sub_1\nsub.2\n' ;;
      # el listado de las suscripciones falla, aunque haya escrito una
      cuentas-error) printf 'sub-1\n'; echo "ERROR: (InternalServerError) Encountered an internal server error." >&2; exit 1 ;;
      *) printf 'sub-1\nsub-2\n' ;;
    esac; exit 0 ;;
esac
case "$1 $2 $3" in
  # un servidor puntual: sin permiso, Azure dice AuthorizationFailed (y su listado sale vacío, sin error)
  "sql server show")
    case "${FAKE_AZ:-ok}" in
      ninguna|movido) echo "ERROR: (ResourceNotFound) The Resource 'Microsoft.Sql/servers/$(arg -n "$@")' under resource group '$(arg -g "$@")' was not found." >&2; exit 3 ;;
      sin-permiso-servidor) echo "ERROR: (AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Sql/servers/read'." >&2; exit 1 ;;
    esac
    arg -n "$@"; exit 0 ;;
  "sql server list")
    s="$(arg --subscription "$@")"
    # con -g: los servidores de un grupo de mentira (fake-groups/<suscripción>/<grupo>/servers)
    g="$(arg -g "$@")"
    if [ -n "$g" ]; then
      [ "$FAKE_AZ" = listado-error ] && { echo "ERROR: (InternalServerError) Encountered an internal server error." >&2; exit 1; }
      f="$TMPLOG/fake-groups/$s/$g/servers"; [ -f "$f" ] && cat "$f"; exit 0
    fi
    case "${FAKE_AZ:-ok}:$s" in
      ninguna:*|sin-permiso-servidor:*|cuentas-error:*) : ;;
      # listado-error, sin grupo: la primera suscripción contesta vacía y la segunda falla
      listado-error:sub-1) : ;;
      listado-error:sub-2) echo "ERROR: (InternalServerError) Encountered an internal server error." >&2; exit 1 ;;
      movido:sub-1) : ;;
      movido:sub-2) echo "rg-otro" ;;
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
  # abrir el firewall pide el cuadro de la puerta: el doble aprueba y anota que lo llamaron; la sesión es la de la Mac
  mkdir -p "$RAIZ/bin"
  printf '#!/usr/bin/env bash\nprintf "cuadro\\n" >> "%s/cuadro.log"\necho "button returned:Aprobar, gave up:false"\n' "$TMP" > "$RAIZ/usr/bin/osascript"
  printf '#!/usr/bin/env bash\necho Aqua\n' > "$RAIZ/bin/launchctl"
  chmod +x "$RAIZ/usr/bin/osascript" "$RAIZ/bin/launchctl"
  # una sentencia pedida por una sesión no abre el cuadro del sistema: la aprueba el click en la sesión
  # (session-approval.js, con su propia suite). Su doble aprueba y anota el cuadro en el mismo registro: uno por sentencia
  # Con $TMP/cuadro-modo en «rechaza» (como el doble del cuadro de la prueba de emergencia), no hay click: pide y sale 1
  # Lee los argumentos con el mismo lector del verificador real: lo que el verificador rechazaría, el doble también
  cat > "$TMP/aprobacion-de-la-sesion.js" <<JS
const fs = require('fs');
const leidos = require('$(dirname "$PUERTA")/session-approval.js').leerArgs(process.argv.slice(2));
fs.writeFileSync('$TMP/aprobacion-argv.json', JSON.stringify(process.argv.slice(2)));
if (!leidos) { process.stdout.write('uso: session-approval.js (el doble no entiende estos argumentos)\n'); process.exit(2); }
fs.appendFileSync('$TMP/cuadro.log', 'cuadro\n');
// lo que se aprueba (después de «--»), en el mismo registro donde el doble del cuadro del sistema anota su texto
fs.appendFileSync('$TMP/cuadro-texto.log', process.argv[process.argv.length - 1] + '\n');
let rejects = false; try { rejects = fs.readFileSync('$TMP/cuadro-modo', 'utf8').trim() === 'rechaza'; } catch (_) { /* aprueba */ }
if (!rejects) { process.stdout.write('id-de-prueba\n'); process.exit(0); }
process.stdout.write('Mostrale AskUserQuestion con una sola pregunta (firma production-query · sesión s · código c)\n'); process.exit(1);
JS
  # un az impostor primero en el PATH: la puerta no lo usa (T30)
  mkdir -p "$TMP/impostor"; printf '#!/usr/bin/env bash\necho IMPOSTOR >> "%s/impostor.log"\n' "$TMP" > "$TMP/impostor/az"; chmod +x "$TMP/impostor/az"
  unset FAKE_SQLCMD FAKE_AZ FAKE_IP FAKE_UUID FAKE_NOMBRE
}

modos(){ # deja escritos los modos de los dobles, que la puerta no les pasa por el entorno
  printf '%s' "${FAKE_AZ:-ok}" > "$TMP/fake-az-mode"
  printf '%s' "${FAKE_NOMBRE:-}" > "$TMP/fake-name-mode"
}
puerta(){ # corre la puerta en el mundo falso; imprime el exit code. SES = la sesión que la llama (vacía = ninguna)
  modos
  # sin las variables de SSH: corrida por SSH, la puerta pediría la sesión de la Mac y la suite fallaría cerrada
  # sin la sesión de quien corre la suite: la de la prueba es SES (vacía = una terminal)
  local sesion=(); [ -n "${SES:-}" ] && sesion=(CLAUDE_CODE_SESSION_ID="$SES")
  env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID HOME="$CASA" TYCON_PROD_ROOT="$RAIZ" TYCON_REPOS_ROOT="$REPOS" TMPLOG="$TMP" \
      PATH="$TMP/impostor:$PATH" ${sesion[@]+"${sesion[@]}"} TYCON_PROD_TEST_APPROVAL_JS="$TMP/aprobacion-de-la-sesion.js" TYCON_PROD_AZ_TIMEOUT="${AZ_TOPE:-20}" \
      FAKE_SQLCMD="${FAKE_SQLCMD:-}" FAKE_AZ="${FAKE_AZ:-}" FAKE_IP="${FAKE_IP:-}" FAKE_UUID="${FAKE_UUID:-}" \
      bash "$PUERTA" "$@" >"$TMP/out" 2>"$TMP/err"
  echo $?
}
gancho(){ # $1 = evento, $2 = sesión → corre el hook con la puerta del repo y el mundo falso; imprime el exit code
  modos
  printf '{"hook_event_name":"%s","session_id":"%s"}' "$1" "$2" | \
    env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY HOME="$CASA" TYCON_PROD_ROOT="$RAIZ" TYCON_REPOS_ROOT="$REPOS" TMPLOG="$TMP" TYCON_PROD_GATE="$PUERTA" \
        TYCON_PROD_AZ_TIMEOUT="${AZ_TOPE:-20}" FAKE_AZ="${FAKE_AZ:-}" \
        node "$HOOK" >"$TMP/hook.out" 2>"$TMP/hook.err"
  echo $?
}
viva(){ printf '{}\n' > "$CASA/.claude/projects/p/$1.jsonl"; touch "$CASA/.claude/projects/p/$1.jsonl"; } # actividad reciente
muerta(){ printf '{}\n' > "$CASA/.claude/projects/p/$1.jsonl"; touch -t 202001010000 "$CASA/.claude/projects/p/$1.jsonl"; }
registro(){ cat "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null; }
estado(){ cat "$CASA/.claude/.tycon-pipeline/production-firewall.json" 2>/dev/null; }
regla_de_la_maquina(){ printf 'tycon-gate-%s' "$(printf '%s' "${FAKE_UUID:-equipo-de-prueba-uno}" | shasum -a 256 | cut -c1-8)"; }
