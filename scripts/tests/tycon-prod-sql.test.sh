#!/usr/bin/env bash
# tycon-prod-sql.test.sh — red de la PUERTA: la única forma de consultar una base de producción.
#
# Por qué existe: sin ella, una autorización puntual deja pasar consultas a producción sin pedir permiso. La puerta existe
# para que cada sentencia se vea y se apruebe, y para que la contraseña NUNCA pase por la conversación.
#
# 🔴 Ningún caso toca una base, ni el Llavero real, ni /opt: raíz de sistema falsa
# (TYCON_PROD_ROOT), HOME falso, y dobles de `security` y `sqlcmd` que anotan lo que reciben.
#
#   T21 — rechaza `-i archivo`, los separadores de lote (GO) y cualquier otro argumento de sqlcmd
#   T22 — la contraseña no aparece en la salida, ni en el error, ni en los argumentos, ni en el registro
#   T23 — si la entrada del Llavero confía en alguien más, no lee el secreto: sale ≠ 0 y guía a recrearla
#   T24 — sin entrada en el Llavero no conecta: sale 3 y deja el `.command` para cargarla
#   T25 — un host que no es producción se rechaza (para eso no hace falta la puerta)
#   T26 — `--reclasificar` baja el host y eso se nota (deja de frenarse) y queda en el registro
#   T29 — usa el cliente de base de root, no el del PATH (un `sqlcmd` impostor se llevaría la clave)
#   T30 — los comandos del cliente (`!!`, `:r`, `:out`, `:connect`) los frena la puerta, antes de conectarse
#   T33 — `port` en el catálogo: la puerta lo pega al host al conectarse, y un puerto inválido la
#         frena antes del cliente. Corre incluso con el freno instalado (no toca nada externo)
#   T31 — los flags que la puerta le pasa al cliente los acepta el cliente REAL (los demás casos usan un sqlcmd de
#         mentira que sólo anota argumentos, así que sin este la puerta podría estar rota para TODA consulta
#         y ningún caso lo vería)
#
# Correr: bash scripts/tests/tycon-prod-sql.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PUERTA="$AQUI/scripts/production/tycon-prod-sql"
HOOK="$AQUI/scripts/hooks/prod-access-guard.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ prod-sql: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ prod-sql: $1"; fallos=$((fallos+1)); }

PROD=acme-sql.database.windows.net
STAGING=acme-sql-staging.database.windows.net
CLAVE_MARCA='M4RC4-DE-L4-CL4VE'

# ── T31 · los flags que la puerta le pasa al cliente, contra el cliente REAL ──────────────────
# 🔴 Cubre que el cliente real acepte los flags: sin este caso, la puerta puede estar rota para TODA consulta
# (incluso `select 1`) sin que nada lo note. Todos los demás casos usan un `sqlcmd` de mentira que
# sólo ANOTA los argumentos: prueban que la puerta manda los que quiere mandar, nunca que el cliente
# real los acepte. `-X1` es del sqlcmd viejo (ODBC); contra go-sqlcmd ni
# parsea («Sqlcmd: '0': Unknown command»), y con las formas que sí parsean el cliente ignora el `-Q`
# y se va a modo interactivo. Un argumento presente no es un argumento aceptado.
#
# 🔴 Va ANTES del salteo de abajo a propósito: la única máquina donde esto importa es justamente la
# que tiene el freno instalado, y ahí la suite se saltea entera. No toca ninguna base ni el Llavero:
# el host no resuelve (TLD `.invalid`), así que lo que se exige es que falle CONECTÁNDOSE y no
# parseando argumentos.
if [ -f "$PUERTA" ]; then
  CLIENTE_REAL="$(PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin command -v sqlcmd || true)"
  LINEA_CLIENTE="$(grep -E '^SALIDA="\$\(.*SQLCMDPASSWORD=' "$PUERTA" | head -1)"
  if [ -z "$CLIENTE_REAL" ]; then
    echo "⏭ prod-sql: T31 no corre — no hay sqlcmd en esta máquina (constancia, no verde)."
  elif [ -z "$LINEA_CLIENTE" ]; then
    no "T31 · no encontré en la puerta la línea que invoca al cliente: el caso no puede probar nada"
  else
    # se evalúa LA MISMA línea de la puerta, con valores de prueba: si alguien cambia los flags,
    # este caso los sigue solo en vez de quedarse mirando una copia que se desactualiza.
    ( CLIENTE="$CLIENTE_REAL"; HOST="no-existe-tycon-prueba.invalid"; USUARIO="nadie"
      SENTENCIA="select 1"; CLAVE="clave-de-prueba"
      eval "$LINEA_CLIENTE"
      printf '%s' "$SALIDA" ) > "$TMP/t31.out" 2>&1
    salida_t31="$(cat "$TMP/t31.out" 2>/dev/null)"
    if printf '%s' "$salida_t31" | grep -iE "Unknown command|Unexpected argument|invalid argument|unknown shorthand|liner:" >/dev/null; then
      no "T31 · el cliente REAL rechaza los flags de la puerta → no puede correr NINGUNA consulta: «$(printf '%s' "$salida_t31" | head -1)»"
    elif [ -z "$salida_t31" ]; then
      no "T31 · el cliente real no dijo nada: el caso no puede distinguir «aceptó los flags» de «no corrió»"
    else
      ok "T31 · el cliente real acepta los flags de la puerta (falla conectándose, que es lo esperado sin base)"
    fi
  fi
fi

# ── T32 · el cliente REAL manda la clave del Llavero, no la de su config de usuario ─────────────
# 🔴 Qué atrapa: go-sqlcmd lee `~/.sqlcmd/sqlconfig`, y si ahí
# hay un contexto actual con usuario guardado, manda AL SERVIDOR la clave guardada ahí e ignora
# SQLCMDPASSWORD, aunque reciba `-S` y `-U` explícitos. Si la config del dev tiene una clave vieja o con
# un `\` de más, da «Login failed» aunque la clave del Llavero esté bien cargada. Se prueba con un
# servidor TDS de mentira en 127.0.0.1 que decodifica el LOGIN7 (lib/tds-spy.py): no toca ninguna
# base ni el Llavero. Dos mediciones: el CONTROL (el cliente suelto, con esa config a la vista) tiene
# que reproducir el defecto; la PUERTA (su línea real, evaluada como en T31) tiene que mandar la clave
# de la variable. Sin el control, un verde no diría nada: podría ser que la config de prueba no tenga
# la forma que el cliente lee. `-N o -l 5` van porque el espía no habla TLS; no cambian lo que se mide.
if [ -f "$PUERTA" ] && [ -n "${CLIENTE_REAL:-}" ] && [ -n "${LINEA_CLIENTE:-}" ] && command -v python3 >/dev/null 2>&1; then
  ESPIA="$AQUI/scripts/tests/lib/tds-spy.py"
  CASA32="$TMP/casa32"; mkdir -p "$CASA32/.sqlcmd"
  cat > "$CASA32/.sqlcmd/sqlconfig" <<YAML
contexts:
    - context:
        endpoint: ep-prueba
        user: usuario-prueba
      name: prueba
currentcontext: prueba
endpoints:
    - endpoint:
        address: 127.0.0.1
        port: 1433
      name: ep-prueba
users:
    - authentication-type: basic
      basic-auth:
        password: $(printf '%s' 'GUARDADA-VIEJA' | base64)
        password-encryption: none
        username: usuarioX
      name: usuario-prueba
version: v1
YAML
  espiar(){ # $1 = puerto → corre el espía de fondo y espera a que escuche; imprime su pid
    python3 "$ESPIA" "$1" > "$TMP/espia-$1.out" 2>&1 &
    local pid=$!; local i=0
    while [ $i -lt 50 ] && ! grep -q escuchando "$TMP/espia-$1.out" 2>/dev/null; do sleep 0.1; i=$((i+1)); done
    echo "$pid"
  }
  clave_vista(){ sed -n 's/^CLAVE=\[\(.*\)\] largo=.*/\1/p' "$TMP/espia-$1.out" 2>/dev/null; }
  # el control: el cliente suelto, con HOME apuntando a esa config
  pid="$(espiar 14351)"
  ( HOME="$CASA32" SQLCMDPASSWORD='DE-LA-VARIABLE' "$CLIENTE_REAL" -x -S 127.0.0.1,14351 -U usuarioX -N o -l 5 -b -Q 'select 1' ) >/dev/null 2>&1
  wait "$pid" 2>/dev/null
  control="$(clave_vista 14351)"
  # la puerta: SU línea, con el mismo HOME contaminado por fuera
  pid="$(espiar 14352)"
  # 🔴 `SERVIDOR` y no sólo `HOST`: la puerta se conecta a `$SERVIDOR`, que arma
  # más arriba pegándole el puerto del catálogo al host. Este caso evalúa SU línea real —para que no
  # se le escape un cambio— así que tiene que darle las variables que esa línea usa. Con `HOST`
  # solo, el cliente recibe `-S ""`, se conecta a ningún lado, y el caso falla diciendo que la
  # puerta mandó «nada»: un rojo que parece de la clave y es del destino.
  # Cómo se DERIVA el destino lo cubre T33; acá lo que se mide es de dónde sale la contraseña.
  ( export HOME="$CASA32"; CLIENTE="$CLIENTE_REAL"; SERVIDOR="127.0.0.1,14352"; USUARIO="usuarioX"
    SENTENCIA="select 1"; CLAVE="DE-LA-VARIABLE"; ARGS_BASE=(-N o -l 5)
    eval "$LINEA_CLIENTE" ) >/dev/null 2>&1
  wait "$pid" 2>/dev/null
  puerta32="$(clave_vista 14352)"
  if [ "$control" != "GUARDADA-VIEJA" ]; then
    echo "⏭ prod-sql: T32 el control NO reprodujo el defecto (el cliente suelto mandó «${control:-nada}»): el caso no puede juzgar a la puerta — ¿cambió go-sqlcmd, o la forma de su config?"
  elif [ "$puerta32" = "DE-LA-VARIABLE" ]; then
    ok "T32 · con una config de go-sqlcmd que guarda OTRA clave, el cliente suelto manda ésa (control) y la PUERTA manda la del Llavero"
  else
    no "T32 · la puerta mandó al servidor «${puerta32:-nada}» en vez de la clave del Llavero: el cliente leyó la config del usuario"
  fi
fi

# ── T33 · el puerto del catálogo ──────────────────────────────────────────────────────────────
# POR QUÉ: un servidor que no escucha en el 1433 necesita declarar su puerto, y la puerta rechaza
# `host,puerto` como argumento. La salida NO es
# aflojar la validación del host: eso le daría dos escrituras al mismo servidor, y el freno
# reconoce el nombre PELADO. El puerto se declara aparte y lo pega la puerta al conectarse.
#
# 🔴 Va ANTES del salteo, como T31 y T32: el bloque que arma el destino no toca el Llavero, ni el
# cliente, ni la red —sólo arma una cadena—, así que se puede juzgar en la máquina que tiene el
# freno puesto, que es donde esto se usa. Se EXTRAE del guión, no se copia: si alguien cambia el
# bloque y no este caso, el caso lo ve.
BLOQUE_DESTINO="$(awk '/^SERVIDOR="\$HOST"$/,/^fi$/' "$PUERTA")"
if [ -z "$BLOQUE_DESTINO" ]; then
  no "T33 · no pude extraer del guión el bloque que arma el destino (¿lo renombraron?)"
else
  destino_con(){ # $1 = puerto; imprime el destino, o «MUERE: …» y sale 9
    ( HOST="srv.acme.test"; PUERTO="$1"
      muere(){ echo "MUERE: $*"; exit 9; }
      eval "$BLOQUE_DESTINO" || exit $?
      printf '%s' "$SERVIDOR" )
  }
  d="$(destino_con 1435)"
  if [ "$d" = "srv.acme.test,1435" ]; then ok "T33a · con puerto declarado, el destino es «host,puerto»"
  else no "T33a · dio «${d}», esperaba «srv.acme.test,1435»"; fi

  d="$(destino_con '')"
  if [ "$d" = "srv.acme.test" ]; then ok "T33b · sin puerto, el host va pelado: ningún servidor ya declarado cambia"
  else no "T33b · dio «${d}», esperaba el host sin coma"; fi

  # El puerto llega de un archivo del disco, que pudo editarse DESPUÉS del lint del commit. Sin esta
  # validación, lo que hubiera ahí viajaría pegado a los argumentos del cliente.
  fallaron=0
  for malo in "1435 -i /etc/passwd" "70000" "0" "sqlprod" "-1"; do
    d="$(destino_con "$malo")" ; rc=$?
    [ "$rc" = 9 ] || { fallaron=$((fallaron+1)); echo "     («${malo}» no frenó: dio «${d}»)"; }
  done
  if [ "$fallaron" = 0 ]; then ok "T33c · un puerto que no es un número en rango frena la puerta, no llega al cliente"
  else no "T33c · $fallaron puerto(s) inválido(s) pasaron"; fi
fi

# T33d · el eslabón del medio: que el puerto sobreviva al ÍNDICE.
# T33a/b/c juzgan el bloque que arma el destino, con el puerto ya en la mano. Pero entre el archivo
# que escribe la persona y ese bloque está el índice, que se construye leyendo los catálogos y se
# guarda en disco. Si el puerto se perdiera ahí, todo lo de arriba seguiría en verde y la puerta
# igual se conectaría al 1433. Por eso este caso construye el índice DESDE UN ARCHIVO, no armado a
# mano. No toca el Llavero, ni el cliente, ni la red.
T33D="$TMP/t33d"; rm -rf "$T33D"; mkdir -p "$T33D/repos/backend-acme/.tycon" "$T33D/casa/.claude/.tycon-pipeline"
( cd "$T33D/repos/backend-acme" && git init -q . ) >/dev/null 2>&1
cat > "$T33D/repos/backend-acme/.tycon/production.json" <<'JSON'
{"servers":[
  {"host":"srv.acme.test","environment":"produccion","keychain":"tycon-prod-acme","base":"AcmeDb","port":1435},
  {"host":"otro.acme.test","environment":"produccion","keychain":"tycon-prod-otro"}
]}
JSON
if node -e '
  const m = require(process.argv[1]);
  const idx = m.leer({ home: process.argv[2], raiz: process.argv[3], forzar: true });
  const con = m.clasificar("srv.acme.test", idx);
  const sin = m.clasificar("otro.acme.test", idx);
  const guardado = JSON.parse(require("fs").readFileSync(process.argv[2] + "/.claude/.tycon-pipeline/production-index.json", "utf8"));
  const bien = con.puerto === 1435 && sin.puerto === undefined && guardado.hosts["srv.acme.test"].puerto === 1435;
  process.exit(bien ? 0 : 1);
' "$AQUI/scripts/production/production-index.js" "$T33D/casa" "$T33D/repos" 2>/dev/null; then
  ok "T33d · el puerto sobrevive al índice: del archivo del repo hasta lo que consulta la puerta"
else
  no "T33d · el índice se comió el puerto (o no lo persistió): la puerta se conectaría al 1433"
fi

# 🔴 En una Mac con el freno INSTALADO la puerta ignora la raíz falsa (a propósito: no puede ser un
# interruptor), así que esta suite usaría el `security` y el `sqlcmd` REALES contra la base real.
# Ahí no corre, y lo dice.
if [ -d /opt/tycon ]; then
  echo "⏭ prod-sql: esta máquina tiene el freno instalado (/opt/tycon): la suite no corre para no tocar el Llavero ni la base reales."
  exit 0
fi
if [ ! -f "$PUERTA" ]; then
  no "la puerta no existe todavía ($PUERTA)"
  echo "— prod-sql: $pasaron ok, $fallos fallos —"; exit 1
fi

# ── el mundo: raíz de sistema falsa con la puerta, el cliente de root y los dobles ─────────────
mundo(){ # $1 = modo del doble de security: ok | sin-entrada | confianza-ajena
  RAIZ="$TMP/sys"; CASA="$TMP/casa"; REPOS="$TMP/repos"
  rm -rf "$RAIZ" "$CASA" "$REPOS"
  rm -f "$TMP/security-argv.log" "$TMP/sqlcmd-argv.log" "$TMP/sqlcmd-env.log" "$TMP/impostor.log"
  mkdir -p "$RAIZ/opt/tycon/bin" "$RAIZ/usr/bin" "$CASA/.claude/.tycon-pipeline" "$CASA/Desktop" "$REPOS/backend-acme/.tycon"
  ( cd "$REPOS/backend-acme" && git init -q . ) >/dev/null 2>&1
  cat > "$REPOS/backend-acme/.tycon/production.json" <<JSON
{"servers":[{"host":"$PROD","environment":"produccion","keychain":"tycon-prod-acme"},
               {"host":"$STAGING","environment":"no-produccion"}]}
JSON
  # doble de `security`: nunca toca el Llavero real
  cat > "$RAIZ/usr/bin/security" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMP/security-argv.log"
case "\$1" in
  find-generic-password)
    case "\${SECURITY_MODE:-ok}" in
      sin-entrada) echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; exit 44 ;;
    esac
    for a in "\$@"; do [ "\$a" = "-w" ] && { printf '%s\n' "$CLAVE_MARCA"; exit 0; }; done
    printf 'keychain: "%s"\n"acct"<blob>="usuario-de-prueba"\n"svce"<blob>="tycon-prod-acme"\n' "$CASA/Library/Keychains/tycon-prod.keychain-db"; exit 0 ;;
  dump-keychain)
    # 🔴 El formato es el REAL, medido en un llavero descartable el 2026-09-15: lo que gatea la
    # lectura es la entrada de autorización que dice «decrypt», y una clave cargada con «-A» la deja
    # en «applications: <null>» (cualquier programa, sin cuadro). El doble anterior imprimía sólo
    # líneas numeradas sueltas: con ese formato, la entrada abierta —la peor— no se podía ni simular.
    volcado(){ # \$1 = servicio, \$2 = apps del decrypt: «security», «ajena» o «cualquiera»
      printf 'keychain: "%s"\nclass: "genp"\nattributes:\n    "acct"<blob>="usuario-de-prueba"\n    "svce"<blob>="%s"\naccess: 3 entries\n' "$CASA/Library/Keychains/tycon-prod.keychain-db" "\$1"
      printf '    entry 0:\n        authorizations (6): decrypt derive export_clear export_wrapped mac sign\n        don'"'"'t-require-password\n'
      case "\$2" in
        cualquiera) printf '        applications: <null>\n' ;;
        ajena) printf '        applications (2):\n            0: /usr/bin/security (OK)\n                requirement: identifier "com.apple.security" and anchor apple\n            1: /Applications/OtraCosa.app (OK)\n' ;;
        *) printf '        applications (1):\n            0: /usr/bin/security (OK)\n                requirement: identifier "com.apple.security" and anchor apple\n' ;;
      esac
      printf '    entry 1:\n        authorizations (1): encrypt\n        don'"'"'t-require-password\n        applications: <null>\n'
      printf '    entry 2:\n        authorizations (1): change_acl\n        don'"'"'t-require-password\n        applications (0):\n'
    }
    case "\${SECURITY_MODE:-ok}" in
      confianza-ajena) volcado tycon-prod-acme ajena; exit 0 ;;
      llave-abierta)   volcado tycon-prod-acme cualquiera; exit 0 ;;
      llavero-bloqueado) echo "security: SecKeychainCopyAccess: User interaction is not allowed." >&2; exit 1 ;;
      *) volcado tycon-prod-acme security; exit 0 ;;
    esac ;;
esac
exit 0
SH
  chmod +x "$RAIZ/usr/bin/security"
  # doble del cliente de base: anota argv y entorno, y falla ruidosamente. Imita lo que go-sqlcmd hace
  # de verdad con la clave (medido, T32): si en SU HOME hay `.sqlcmd/sqlconfig`, usa la guardada ahí.
  cat > "$RAIZ/opt/tycon/bin/sqlcmd" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMP/sqlcmd-argv.log"
if [ -f "\$HOME/.sqlcmd/sqlconfig" ]; then printf 'SQLCMDPASSWORD=CLAVE-GUARDADA-EN-SQLCONFIG\n' >> "$TMP/sqlcmd-env.log"
else printf 'SQLCMDPASSWORD=%s\n' "\${SQLCMDPASSWORD:-}" >> "$TMP/sqlcmd-env.log"; fi
echo "filaA"; echo "filaB"; echo "filaC"
echo "algo salió mal en el servidor" >&2
exit 1
SH
  chmod +x "$RAIZ/opt/tycon/bin/sqlcmd"
  # y la casa del dev tiene esa config
  mkdir -p "$CASA/.sqlcmd"; printf 'currentcontext: prueba\n' > "$CASA/.sqlcmd/sqlconfig"
  # un impostor en el PATH, que la puerta NO debe usar (T29)
  mkdir -p "$TMP/impostor"
  cat > "$TMP/impostor/sqlcmd" <<SH
#!/usr/bin/env bash
printf 'IMPOSTOR %s\n' "\$*" >> "$TMP/impostor.log"
printf 'SQLCMDPASSWORD=%s\n' "\${SQLCMDPASSWORD:-}" >> "$TMP/impostor.log"
exit 0
SH
  chmod +x "$TMP/impostor/sqlcmd"
  export SECURITY_MODE="${1:-ok}"
}

puerta(){ # corre la puerta con el mundo falso; imprime el exit code
  env HOME="$CASA" TYCON_PROD_ROOT="$RAIZ" TYCON_REPOS_ROOT="$REPOS" \
      PATH="$TMP/impostor:$PATH" SECURITY_MODE="$SECURITY_MODE" \
      bash "$PUERTA" "$@" >"$TMP/out" 2>"$TMP/err"
  echo $?
}

# ── T25 · un host que no es producción ────────────────────────────────────────────────────────
mundo ok
rc="$(puerta "$STAGING" 'select 1')"
if [ "$rc" != 0 ] && [ ! -s "$TMP/security-argv.log" ]; then ok "T25 · rechaza un host que no es producción, sin tocar el Llavero"
else no "T25 · aceptó un host no-produccion (rc=$rc) o leyó el Llavero"; fi

# ── T21 · sólo la sentencia en línea ──────────────────────────────────────────────────────────
mundo ok
for mal in "-i /tmp/x.sql" "select 1
GO
select 2" "--other-flag"; do
  rc="$(puerta "$PROD" "$mal")"
  if [ "$rc" != 0 ] && [ ! -s "$TMP/sqlcmd-argv.log" ]; then ok "T21 · rechaza «$(printf '%s' "$mal" | head -1)» sin llamar al cliente"
  else no "T21 · aceptó «$(printf '%s' "$mal" | head -1)» (rc=$rc)"; fi
done

# ── T30 · los comandos del cliente los frena LA PUERTA ────────────────────────────────────────
# 🔴 Esto no lo puede hacer un `-X1` pasado a sqlcmd: ese flag no sólo no sirve,
# rompe la puerta entera (T31). Por eso se frena acá, ANTES de conectarse, sin depender del dialecto
# de flags de ningún cliente. `!!` abre un shell, `:r` lee un archivo, `:out` escribe uno y
# `:connect` va a otra base — ninguno consulta la base que se aprobó en el cuadro.
mundo ok
for escape in '!!touch /tmp/tycon-escape' ':r /etc/passwd' ':out /tmp/tycon-robo' ':connect otra-base' 'select 1
:r /etc/passwd'; do
  rc="$(puerta "$PROD" "$escape")"
  if [ "$rc" != 0 ] && [ ! -s "$TMP/sqlcmd-argv.log" ]; then ok "T30 · frena «$(printf '%s' "$escape" | tail -1)» sin llamar al cliente"
  else no "T30 · dejó pasar «$(printf '%s' "$escape" | tail -1)» al cliente (rc=$rc)"; fi
done
# y el reverso, que es lo que evita que el freno se apague por ruidoso: una consulta con `:` o `!`
# en el MEDIO es SQL legítimo y tiene que pasar (sqlcmd sólo reconoce comandos al principio de línea)
mundo ok
rc="$(puerta "$PROD" 'select 1 where nota <> '\''a:b'\'' and x <> 2')"
# el doble del cliente devuelve 1 a propósito (T22c mira ese error): lo que se juzga acá es que la puerta
# NO frenó (no hay mensaje de «comando del cliente») y SÍ llamó al cliente con la sentencia entera
if [ -s "$TMP/sqlcmd-argv.log" ] && grep -q "a:b" "$TMP/sqlcmd-argv.log" && ! grep -q "comando del cliente" "$TMP/err" 2>/dev/null; then ok "T30b · una sentencia con «:» en el medio pasa: el freno no es ruidoso"
else no "T30b · frenó una consulta legítima por tener «:» en el medio (rc=$rc): $(head -c 200 "$TMP/err" 2>/dev/null)"; fi

# ── T22 · la clave no se filtra ───────────────────────────────────────────────────────────────
mundo ok
rc="$(puerta "$PROD" 'select top 3 * from Articulos')"
fuga=0
grep -q "$CLAVE_MARCA" "$TMP/out" "$TMP/err" 2>/dev/null && fuga=1
grep -q "$CLAVE_MARCA" "$TMP/sqlcmd-argv.log" 2>/dev/null && fuga=1
grep -rq "$CLAVE_MARCA" "$CASA/.claude/.tycon-pipeline/" 2>/dev/null && fuga=1
if [ "$fuga" = 0 ]; then ok "T22a · la clave no aparece en salida, error, argumentos ni registro"
else no "T22a · LA CLAVE SE FILTRÓ"; fi
if grep -q "SQLCMDPASSWORD=$CLAVE_MARCA" "$TMP/sqlcmd-env.log" 2>/dev/null; then ok "T22b · la clave viaja por el entorno del proceso hijo"
else no "T22b · el cliente no recibió la clave por el entorno"; fi
# 🔴 T22g — el cliente NO ve la config de go-sqlcmd del usuario (`~/.sqlcmd/sqlconfig`): con ella a la
# vista manda la clave guardada AHÍ y no la del Llavero (medido con el cliente real, T32). El doble lo
# imita, y la casa falsa la tiene. Rojo previo: la línea anterior de la puerta heredaba el HOME del dev.
if grep -q "CLAVE-GUARDADA-EN-SQLCONFIG" "$TMP/sqlcmd-env.log" 2>/dev/null; then
  no "T22g · el cliente corrió con el HOME del dev y usó la clave guardada en ~/.sqlcmd/sqlconfig, no la del Llavero"
else ok "T22g · el cliente corre sin ver la config de go-sqlcmd del usuario (la clave que viaja es la del Llavero)"; fi
# T22h/T22i — `base`: sin ella el cliente entra a `master` y en Azure SQL no hay `USE` (medido)
if grep -qE -- '(^| )-d ' "$TMP/sqlcmd-argv.log"; then no "T22h · le pasa -d al cliente sin que el catálogo declare «base»"
else ok "T22h · sin «base» en el catálogo, no le pasa -d al cliente"; fi
if grep -q "algo salió mal en el servidor" "$TMP/out" && grep -q "rc=" "$TMP/out"; then ok "T22c · junta error y salida, e imprime el código de salida real"
else no "T22c · no juntó el error con la salida, o no imprimió rc="; fi
if grep -q "Articulos" "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null; then no "T22d · la SENTENCIA quedó en el registro"
else ok "T22d · el registro guarda la huella de la sentencia, no la sentencia"; fi

if grep -qE -- '(^| )-x( |$)' "$TMP/sqlcmd-argv.log"; then
  ok "T22e · el cliente corre sin sustitución de variables (una sentencia con \$(SQLCMDPASSWORD) no devuelve la clave)"
else no "T22e · el cliente corre CON sustitución de variables: una sentencia podría devolver la clave"; fi
# 🔴 Y NO le pasa `-X`: es del sqlcmd viejo (ODBC) y contra go-sqlcmd rompe la puerta entera (ver T31).
# Este caso mira el reverso a propósito: exigir `-X1` acá daría
# verde justamente porque el flag roto está. Un argumento presente no es un argumento aceptado.
if grep -qE -- '(^| )-X' "$TMP/sqlcmd-argv.log"; then
  no "T22e2 · le pasa -X al cliente: contra go-sqlcmd eso hace que ignore el -Q y no corra NADA"
else ok "T22e2 · no le pasa -X al cliente (los comandos del cliente los frena la puerta, antes de conectarse)"; fi
if grep -q '"accion":"consulta"' "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null; then
  ok "T22f · la consulta queda anotada en el registro (en positivo, no sólo «no está la sentencia»)"
else no "T22f · la consulta no dejó constancia en el registro"; fi

# T22i/T22j van DESPUÉS de T22c-f: reinician el mundo (mundo ok) y pisarían la consulta que aquéllos juzgan
mundo ok
cat > "$REPOS/backend-acme/.tycon/production.json" <<JSON
{"servers":[{"host":"$PROD","environment":"produccion","keychain":"tycon-prod-acme","base":"basedeprueba"}]}
JSON
rc="$(puerta "$PROD" 'select 1')"
if grep -qE -- '(^| )-d basedeprueba( |$)' "$TMP/sqlcmd-argv.log"; then ok "T22i · con «base» en el catálogo, el cliente entra a esa base (-d)"
else no "T22i · el catálogo declara base=basedeprueba y el cliente no la recibió (rc=$rc): $(head -1 "$TMP/sqlcmd-argv.log" 2>/dev/null)"; fi
mundo ok
cat > "$REPOS/backend-acme/.tycon/production.json" <<JSON
{"servers":[{"host":"$PROD","environment":"produccion","keychain":"tycon-prod-acme","base":"mala;base]"}]}
JSON
rc="$(puerta "$PROD" 'select 1')"
if [ "$rc" != 0 ] && [ ! -s "$TMP/sqlcmd-argv.log" ]; then ok "T22j · una «base» con caracteres raros no llega al cliente: la puerta la rechaza antes"
else no "T22j · dejó pasar una base malformada al cliente (rc=$rc)"; fi

# ── T29 · el cliente de root, no el del PATH ──────────────────────────────────────────────────
if [ -s "$TMP/impostor.log" ]; then no "T29a · usó el sqlcmd del PATH (un impostor se llevaría la clave)"
else ok "T29a · usó el cliente de root y nunca el del PATH"; fi
mundo ok; rm -f "$RAIZ/opt/tycon/bin/sqlcmd"
rc="$(puerta "$PROD" 'select 1')"
if [ "$rc" != 0 ] && [ ! -s "$TMP/impostor.log" ]; then ok "T29b · sin el cliente de root NO cae al del PATH: falla diciéndolo"
else no "T29b · sin el cliente de root usó el del PATH (rc=$rc)"; fi

# 🔴 La huella del cliente de base: el camino que puede romperse en
# el lanzador (una ruta con barras dentro de un `sed`, que hace que NUNCA se verifique nada). Acá
# van los dos lados, porque un control que no se ejerce se ve igual que uno que anda.
mundo ok
printf '{"/opt/tycon/bin/sqlcmd":"%s"}' "$(shasum -a 256 "$RAIZ/opt/tycon/bin/sqlcmd" | cut -d' ' -f1)" > "$RAIZ/opt/tycon/huellas.json"
rc="$(puerta "$PROD" 'select 1')"
if [ -s "$TMP/sqlcmd-argv.log" ]; then ok "T29c · con la huella correcta, el cliente de root se ejecuta"
else no "T29c · con la huella correcta NO ejecutó el cliente (rc=$rc) — err: $(head -c 120 "$TMP/err")"; fi

mundo ok
printf '{"/opt/tycon/bin/sqlcmd":"0000000000000000000000000000000000000000000000000000000000000000"}' > "$RAIZ/opt/tycon/huellas.json"
rc="$(puerta "$PROD" 'select 1')"
if [ "$rc" != 0 ] && [ ! -s "$TMP/sqlcmd-argv.log" ]; then ok "T29d · con la huella cambiada, no ejecuta y lo dice"
else no "T29d · ejecutó un cliente cuya huella no coincide (rc=$rc)"; fi

# ── T24f · el .command CORRIENDO de verdad, contra un llavero descartable ─────────────────────
# 🔴 Los casos de arriba LEEN la plantilla y buscan textos; ninguno la ejecuta,
# y la matriz daría por «corrido» algo que sólo se leyó. Éste la ejecuta: rinde la plantilla, la alimenta con un usuario y una clave con comillas de los dos tipos,
# `$` y `\`, y exige que la clave se lea después IDÉNTICA y que el usuario no haya inyectado otro
# argumento (una comilla suelta podía colar `-A`, que deja la entrada legible por cualquier programa).
# El llavero se crea en el temporal y se borra al terminar; NO se toca el Llavero del dev ni su lista.
# Sin `security` (Linux, el nocturno) se saltea DICIÉNDOLO: saltear en silencio es lo mismo que no tener el caso.
if command -v security >/dev/null 2>&1 && [ "$(uname)" = "Darwin" ]; then
  KC="$TMP/descartable-$$.keychain"
  security create-keychain -p x "$KC" >/dev/null 2>&1
  security unlock-keychain -p x "$KC" >/dev/null 2>&1
  sed -e "s|@LLAVERO@|tycon-prod-prueba|g" -e "s|@HOST@|host.de.prueba|g" -e "s|@LLAVERO_PROPIO@|$KC|g"     "$AQUI/scripts/production/load-key.command.template" > "$TMP/cargar.command"
  chmod 700 "$TMP/cargar.command"
  CLAVE_DURA='a b"c'"'"'d$e\f g'
  USUARIO_DURO='usu"ario -A'
  printf '%s\n%s\n\n' "$USUARIO_DURO" "$CLAVE_DURA" | bash "$TMP/cargar.command" >/dev/null 2>&1
  leida="$(security find-generic-password -s tycon-prod-prueba -w "$KC" 2>/dev/null)"
  acct="$(security find-generic-password -s tycon-prod-prueba "$KC" 2>/dev/null | sed -n 's/.*"acct"<blob>="\(.*\)"/\1/p')"
  abierta="$(security dump-keychain -a "$KC" 2>/dev/null | awk '/authorizations \(/{g=($0~/decrypt/)}/applications: <null>/{if(g)print "SI"}')"
  if [ "$leida" = "$CLAVE_DURA" ]; then ok "T24f · el .command corrido de verdad guarda la clave y se lee IDÉNTICA (comillas, \$ y \\)"
  else no "T24f · la clave no volvió igual del llavero descartable"; fi
  if [ "$acct" = "$USUARIO_DURO" ]; then ok "T24g · el usuario con comillas no inyectó otro argumento"
  else no "T24g · el usuario quedó distinto: [$acct] (¿se coló un argumento?)"; fi
  if [ -z "$abierta" ]; then ok "T24h · la entrada NO quedó abierta a cualquier programa (sin -A)"
  else no "T24h · la entrada quedó legible por cualquier programa sin cuadro"; fi
  if [ ! -f "$TMP/cargar.command" ]; then ok "T24i · y el .command se borró solo al terminar"
  else no "T24i · el .command quedó en el disco después de cargar la clave"; fi
  security delete-keychain "$KC" >/dev/null 2>&1
else
  ok "T24f · (salteado: no hay \`security\` o no es macOS — se dice, no se calla)"
fi

# ── T23 · la entrada confía en alguien más ────────────────────────────────────────────────────
mundo confianza-ajena
rc="$(puerta "$PROD" 'select 1')"
if [ "$rc" != 0 ] && ! grep -q -- "-w" "$TMP/security-argv.log" 2>/dev/null; then ok "T23 · no pide el secreto si la entrada confía en otra app, y guía a recrearla"
else no "T23 · leyó el secreto de una entrada con confianza de más (rc=$rc)"; fi

# 🔴 T23b — la clave cargada con «-A»: CUALQUIER programa puede leerla sin cuadro. Es el caso peor y
# el que un control que sólo mire líneas numeradas daría por limpio (no imprime líneas numeradas, así que «no había nadie de
# más»). Ese control pasaría y leería el secreto.
mundo llave-abierta
rc="$(puerta "$PROD" 'select 1')"
if [ "$rc" != 0 ] && ! grep -q -- "-w" "$TMP/security-argv.log" 2>/dev/null; then ok "T23c · una clave que puede leer cualquier programa no se usa: no pide el secreto"
else no "T23c · leyó el secreto de una clave abierta a cualquier programa (rc=$rc)"; fi


# ── T24j · `--cargar-clave <host>`: el archivo sin tener que fallar una consulta ────────────────
# Cargar la clave no exige «correr
# una consulta que falle», un rodeo: hay un comando directo. Tiene que dejar el .command, NO
# tocar el cliente de base, NO pedir el secreto al Llavero, y salir 0 (la persona sigue).
mundo sin-entrada
rc="$(puerta --cargar-clave "$PROD")"
if [ "$rc" = 0 ] && [ ! -s "$TMP/sqlcmd-argv.log" ] && ! grep -q -- " -w" "$TMP/security-argv.log" 2>/dev/null \
   && ls "$CASA/Desktop"/cargar-clave-tycon-prod-acme.command >/dev/null 2>&1 && grep -q "Escritorio" "$TMP/out"; then
  ok "T24j · --cargar-clave deja el .command, no consulta, no lee el secreto, y sale 0"
else no "T24j · --cargar-clave: rc=$rc · sqlcmd=$(wc -c <"$TMP/sqlcmd-argv.log" 2>/dev/null) · .command: $(ls "$CASA/Desktop" 2>/dev/null | tr '\n' ' ') · out: $(head -c 80 "$TMP/out")"; fi
rc="$(puerta --cargar-clave "$STAGING")"
[ "$rc" != 0 ] && ok "T24k · --cargar-clave con un host que NO es producción se niega" || no "T24k · dejó cargar clave para un host de no-producción"
rc="$(puerta --cargar-clave)"
[ "$rc" != 0 ] && ok "T24l · --cargar-clave sin host se niega" || no "T24l · --cargar-clave sin host salió 0"

# ── T24 · sin entrada en el Llavero ───────────────────────────────────────────────────────────
mundo sin-entrada
rc="$(puerta "$PROD" 'select 1')"
if [ "$rc" = 3 ] && [ ! -s "$TMP/sqlcmd-argv.log" ] && ls "$CASA/Desktop"/cargar-clave-*.command >/dev/null 2>&1; then
  ok "T24a · sale 3, no conecta, y deja el .command en el Escritorio"
else no "T24a · rc=$rc · .command: $(ls "$CASA/Desktop" 2>/dev/null | tr '\n' ' ')"; fi
CMDF="$(ls "$CASA/Desktop"/cargar-clave-*.command 2>/dev/null | head -1)"
if grep -q -- "-T /usr/bin/security" "$CMDF" 2>/dev/null && grep -q 'read -r -s' "$CMDF" 2>/dev/null &&
   grep -q 'security -i' "$CMDF" 2>/dev/null && grep -q '"$LLAVERO_PROPIO"' "$CMDF" 2>/dev/null &&
   grep -q 'LLAVERO="tycon-prod-acme"' "$CMDF" 2>/dev/null; then
  ok "T24b · el .command nace de la plantilla: confía sólo en la herramienta del sistema, pide la clave sin mostrarla y la guarda en el llavero propio"
else no "T24b · el .command no tiene la forma esperada (plantilla, -T /usr/bin/security, read -s, security -i, llavero propio)"; fi

# 🔴 T24d — la clave NO puede viajar por los argumentos: mientras corre el comando, `ps` la muestra a
# cualquier programa del mismo usuario Y NUNCA `-A`, que abre la
# entrada a cualquier programa sin cuadro. Rojo que atrapa: una plantilla con `-w "$CLAVE"`.
if grep -qE '^[^#|]*security[^|]*add-generic-password' "$CMDF" 2>/dev/null; then
  no "T24d · el .command ejecuta add-generic-password con la clave en los argumentos (visible en ps)"
elif grep -qE -- '(^|[[:space:]])-A([[:space:]]|$)' "$CMDF" 2>/dev/null; then
  no "T24d · el .command carga la entrada con -A: cualquier programa podría leerla sin cuadro"
else ok "T24d · la clave viaja por la entrada estándar y la entrada no queda abierta a cualquiera"; fi

# T24e — y no se da por cargada sin comprobarlo: `security -i` sale 0 aunque el subcomando falle
# (medido), así que la plantilla tiene que leer la entrada de vuelta antes de borrarse.
if grep -q 'find-generic-password' "$CMDF" 2>/dev/null && grep -q 'rm -f "$YO"' "$CMDF" 2>/dev/null; then
  ok "T24e · comprueba que la entrada quedó guardada antes de borrarse"
else no "T24e · el .command se borra sin comprobar que la clave haya quedado guardada"; fi

# ── T24c · un llavero que no empieza con tycon-prod- no se lee, y nada crudo entra al .command ──
mundo sin-entrada
printf '{"servers":[{"host":"%s","environment":"produccion","keychain":"x$(touch /tmp/pwn)"}]}' "$PROD" > "$REPOS/backend-acme/.tycon/production.json"
rc="$(puerta "$PROD" 'select 1')"
if [ "$rc" != 0 ] && [ -z "$(ls "$CASA/Desktop" 2>/dev/null)" ]; then ok "T24c · un nombre de entrada malformado no se lee ni se mete en el .command"
else no "T24c · rc=$rc · .command: $(ls "$CASA/Desktop" 2>/dev/null)"; fi

# ── T23b · si no puede verificar la confianza, NO lee la clave ──────────────────────────────────
mundo ok
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s/security-argv.log"\ncase "$1" in dump-keychain) echo "SecKeychainOpen: locked" >&2; exit 51;; *) echo x; exit 0;; esac\n' "$TMP" > "$RAIZ/usr/bin/security"
rc="$(puerta "$PROD" 'select 1')"
if [ "$rc" != 0 ] && ! grep -q -- " -w" "$TMP/security-argv.log" 2>/dev/null; then ok "T23b · si no pudo verificar en quién confía la entrada, no pide el secreto"
else no "T23b · leyó la clave sin poder verificar la confianza (rc=$rc)"; fi

# ── T26 · --reclasificar ──────────────────────────────────────────────────────────────────────
# El escenario real: el host se vio como producción (queda en la memoria pegajosa), el proyecto lo
# baja a no-producción en su catálogo… y aun así sigue frenándose (T15). Lo único que lo destraba es
# reclasificarlo por la puerta, que pasa por el cuadro de aprobación.
mundo ok
frena(){ echo "{\"tool_name\":\"Bash\",\"hook_event_name\":\"PreToolUse\",\"tool_input\":{\"command\":\"sqlcmd -S $PROD -Q \\\"select 1\\\"\"}}" \
  | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 node "$HOOK" >/dev/null 2>&1; echo $?; }
antes="$(frena)"                                   # lo vio como producción: queda en la memoria
printf '{"servers":[{"host":"%s","environment":"no-produccion"}]}' "$PROD" > "$REPOS/backend-acme/.tycon/production.json"
intermedio="$(frena)"                              # el catálogo ya dice no-producción y IGUAL frena
rc="$(puerta --reclasificar "$PROD")"
despues="$(frena)"
if [ "$antes" = 2 ] && [ "$intermedio" = 2 ] && [ "$rc" = 0 ] && [ "$despues" = 0 ]; then ok "T26a · sólo la puerta lo destraba: reescribir el catálogo no alcanza"
else no "T26a · antes=$antes intermedio=$intermedio rc=$rc después=$despues (esperaba 2 / 2 / 0 / 0)"; fi
if grep -q "reclasific" "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null; then ok "T26b · la reclasificación queda en el registro"
else no "T26b · reclasificar no dejó constancia"; fi

# ── la consulta desde un archivo (`--file <ruta> --sha256 <sha256>`) ────────────────────────────────────────
# Una consulta larga en una línea, con cada comilla escapada, no se puede leer en el cuadro de aprobación. Desde un
# archivo se lee entera; la huella ata lo que la persona vio a lo que corre: la puerta lee el archivo UNA vez y corre
# esos mismos bytes.
huella_de(){ shasum -a 256 "$1" | cut -d' ' -f1; }
consulta_archivo(){ printf 'select top 3 Id,\n       Nombre\nfrom Articulos\n' > "$1"; }

# T38 · el archivo cambió entre el freno y la puerta: sale 2 sin conectarse
mundo ok; Q="$TMP/consulta.sql"; consulta_archivo "$Q"; H_VIEJA="$(huella_de "$Q")"; printf 'delete from Articulos\n' > "$Q"
rc="$(puerta "$PROD" --file "$Q" --sha256 "$H_VIEJA")"
if [ "$rc" = 2 ] && [ ! -s "$TMP/sqlcmd-argv.log" ] && [ ! -s "$TMP/security-argv.log" ]; then
  ok "T38 Gate_Archivo_ChangedAfterApproval_Exit2NoConnect · un archivo cambiado después del cuadro no corre"
else no "T38 · archivo cambiado: rc=$rc · $(cat "$TMP/err")"; fi

# T39 · las mismas reglas que la sentencia en línea, y el registro sin la ruta
for mala in 'select 1
GO
select 2' ':r /etc/passwd' '-i /tmp/x.sql'; do
  mundo ok; Q="$TMP/mala.sql"; printf '%s\n' "$mala" > "$Q"
  rc="$(puerta "$PROD" --file "$Q" --sha256 "$(huella_de "$Q")")"
  if [ "$rc" = 2 ] && [ ! -s "$TMP/sqlcmd-argv.log" ]; then ok "T39 Gate_Archivo_SameRulesAsInline · «$(printf '%s' "$mala" | head -1)» desde un archivo sale 2 sin conectarse"
  else no "T39 · «$(printf '%s' "$mala" | head -1)» rc=$rc"; fi
done
mundo ok; Q="$TMP/buena.sql"; consulta_archivo "$Q"; H="$(huella_de "$Q")"
rc="$(puerta "$PROD" --file "$Q" --sha256 "$H")"
l="$(grep '"origen":"archivo"' "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null | tail -1)"
if grep "from Articulos" "$TMP/sqlcmd-argv.log" >/dev/null 2>&1 && [[ "$l" == *"\"sha256\":\"$H\""* ]] && [[ "$l" != *"$Q"* ]] && [[ "$l" != *"Articulos"* ]]; then
  ok "T39 · la válida corre lo que se leyó y el registro anota la huella y el origen, sin la ruta ni el contenido"
else no "T39 · válida: rc=$rc · registro: ${l} · argv: $(cat "$TMP/sqlcmd-argv.log" 2>/dev/null | head -2)"; fi
# la puerta NO repite la consulta en su salida: llegaría después del cuadro y le mandaría el contenido al modelo
if ! grep "consulta desde archivo" "$TMP/out" >/dev/null; then ok "T39 · la puerta no repite el archivo en su salida (eso lo muestra el freno, antes del cuadro)"
else no "T39 · la puerta repitió el archivo en su salida: $(head -3 "$TMP/out")"; fi

# T38 · una ruta que empieza con «-» no llega al intérprete como una opción suya (cargaría otro código y correría
# otra consulta que la aprobada); se rechaza antes de leer nada
mundo ok; ( cd "$TMP" && printf 'select 1\n' > ./-r && mkdir -p "node_modules/$(huella_de ./-r)" && printf 'process.stdout.write("delete from Articulos");process.exit(0)\n' > "node_modules/$(huella_de ./-r)/index.js" )
rc="$( cd "$TMP" && env HOME="$CASA" TYCON_PROD_ROOT="$RAIZ" TYCON_REPOS_ROOT="$REPOS" PATH="$TMP/impostor:$PATH" SECURITY_MODE=ok bash "$PUERTA" "$PROD" --file -r --sha256 "$(huella_de "$TMP/-r")" >"$TMP/out" 2>"$TMP/err"; echo $?)"
if [ "$rc" = 2 ] && ! grep "delete" "$TMP/sqlcmd-argv.log" >/dev/null 2>&1; then ok "T38 · una ruta que empieza con «-» se rechaza: no corre otra consulta que la aprobada"
else no "T38 · ruta con «-»: rc=$rc · argv: $(cat "$TMP/sqlcmd-argv.log" 2>/dev/null)"; fi
rm -rf "$TMP/-r" "$TMP/node_modules"

# T39 · caracteres que harían ver en pantalla otra cosa que lo que corre: control (ANSI, retorno de carro) e invisibles
for raro in ansi retorno invisible; do
  mundo ok; Q="$TMP/raro.sql"
  case "$raro" in
    ansi) printf 'select 1 \033[8mdelete from Articulos\033[0m\n' > "$Q" ;;
    retorno) printf 'select 1\r:r /etc/passwd\n' > "$Q" ;;
    invisible) printf 'select 1 \342\200\256 from Articulos\n' > "$Q" ;;
  esac
  rc="$(puerta "$PROD" --file "$Q" --sha256 "$(huella_de "$Q")")"
  if [ "$rc" = 2 ] && [ ! -s "$TMP/sqlcmd-argv.log" ]; then ok "T39 · un archivo con caracteres «${raro}» sale 2 sin conectarse"
  else no "T39 · «${raro}» rc=$rc"; fi
done
for args in "--file $TMP/buena.sql" "--file $TMP/buena.sql --sha256" "--file $TMP/buena.sql --sha256 $H --extra"; do
  mundo ok; consulta_archivo "$TMP/buena.sql"
  # shellcheck disable=SC2086
  rc="$(puerta "$PROD" $args)"
  if [ "$rc" = 2 ] && [ ! -s "$TMP/sqlcmd-argv.log" ]; then ok "T39 · «${args##*/}» sin la forma completa sale 2"
  else no "T39 · «${args}» rc=$rc"; fi
done
for raro in enlace carpeta grande binario; do
  mundo ok; Q="$TMP/raro-$raro"; rm -rf "$Q"
  case "$raro" in
    enlace) consulta_archivo "$TMP/real.sql"; ln -s "$TMP/real.sql" "$Q" ;;
    carpeta) mkdir -p "$Q" ;;
    grande) head -c 70000 /dev/zero | tr '\0' 'a' > "$Q" ;;
    binario) printf 'select \377\376 1\n' > "$Q" ;;
  esac
  H="$( [ -f "$Q" ] && huella_de "$Q" || echo 0000000000000000000000000000000000000000000000000000000000000000)"
  rc="$(puerta "$PROD" --file "$Q" --sha256 "$H")"
  if [ "$rc" = 2 ] && [ ! -s "$TMP/sqlcmd-argv.log" ]; then ok "T39 · un archivo «${raro}» sale 2 sin conectarse"
  else no "T39 · «${raro}» rc=$rc"; fi
done

echo "— prod-sql: $pasaron ok, $fallos fallos —"
[ "$fallos" -eq 0 ]
