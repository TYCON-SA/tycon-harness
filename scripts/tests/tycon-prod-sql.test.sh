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
#   T26 — `--reclassify` baja el host y eso se nota (deja de frenarse) y queda en el registro
#   T29 — usa el cliente de base de root, no el del PATH (un `sqlcmd` impostor se llevaría la clave)
#   T30 — los comandos del cliente (`!!`, `:r`, `:out`, `:connect`) los frena la puerta, antes de conectarse
#   T33 — `port` en el catálogo: la puerta lo pega al host al conectarse, y un puerto inválido la
#         frena antes del cliente. Corre incluso con el freno instalado (no toca nada externo)
#   T31 — los flags que la puerta le pasa al cliente los acepta el cliente REAL (los demás casos usan un sqlcmd de
#         mentira que sólo anota argumentos, así que sin este la puerta podría estar rota para TODA consulta
#         y ningún caso lo vería)
#   sin aprobación, la puerta dice cuál de las tres pasó (el cuadro se venció, lo rechazaron o no se pudo abrir) y lo
#         anota como motivo; sólo la respuesta exacta de «Aprobar» aprueba
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
  rm -f "$TMP/sqlcmd-q.bin" "$TMP/security-argv.log" "$TMP/sqlcmd-argv.log" "$TMP/sqlcmd-env.log" "$TMP/sqlcmd-heredado.log" "$TMP/impostor.log" \
        "$TMP/orden.log" "$TMP"/cuadro-arg-* "$TMP/cuadro-n" "$TMP/cuadro-modo" "$TMP/launchctl-modo"
  mkdir -p "$RAIZ/opt/tycon/bin" "$RAIZ/usr/bin" "$RAIZ/bin" "$RAIZ/usr/sbin" "$CASA/.claude/.tycon-pipeline" "$CASA/Desktop" "$REPOS/backend-acme/.tycon"
  ( cd "$REPOS/backend-acme" && git init -q . ) >/dev/null 2>&1
  cat > "$REPOS/backend-acme/.tycon/production.json" <<JSON
{"servers":[{"host":"$PROD","environment":"produccion","keychain":"tycon-prod-acme"},
               {"host":"$STAGING","environment":"no-produccion"}]}
JSON
  # doble de `security`: nunca toca el Llavero real
  cat > "$RAIZ/usr/bin/security" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMP/security-argv.log"
printf 'security %s\n' "\$*" >> "$TMP/orden.log"
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
printf 'sqlcmd\n' >> "$TMP/orden.log"
while [ \$# -gt 0 ]; do [ "\$1" = -Q ] && { printf '%s' "\$2" > "$TMP/sqlcmd-q.bin"; break; }; shift; done
if [ -f "\$HOME/.sqlcmd/sqlconfig" ]; then printf 'SQLCMDPASSWORD=CLAVE-GUARDADA-EN-SQLCONFIG\n' >> "$TMP/sqlcmd-env.log"
else printf 'SQLCMDPASSWORD=%s\n' "\${SQLCMDPASSWORD:-}" >> "$TMP/sqlcmd-env.log"; fi
env | grep '^SQLCMD' | grep -v '^SQLCMDPASSWORD=' >> "$TMP/sqlcmd-heredado.log"
echo "filaA"; echo "filaB"; echo "filaC"
echo "algo salió mal en el servidor" >&2
exit 1
SH
  chmod +x "$RAIZ/opt/tycon/bin/sqlcmd"
  # doble del programa del cuadro: anota que lo llamaron (en el registro de orden común) y cada argumento en su archivo,
  # y contesta lo que diga $TMP/cuadro-modo (la puerta lo corre con el entorno limpio: una variable no le llegaría)
  # @story-8.254 @ac-25: con este doble que aprueba, los casos de antes siguen verdes sin cambiar sus filas
  cat > "$RAIZ/usr/bin/osascript" <<SH
#!/usr/bin/env bash
printf 'cuadro\n' >> "$TMP/orden.log"
n=0; for a in "\$@"; do n=\$((n+1)); printf '%s' "\$a" > "$TMP/cuadro-arg-\$n"; done; printf '%s' "\$n" > "$TMP/cuadro-n"
case "\$(cat "$TMP/cuadro-modo" 2>/dev/null || echo aprobar)" in
  aprobar) echo "button returned:Aprobar, gave up:false" ;;
  rechazar) echo "button returned:Rechazar, gave up:false" ;;
  vencer) echo "button returned:, gave up:true" ;;
  mudo) ;;
  raro) echo "button returned:Aprobar" ;;
  *) echo "execution error: No user interaction allowed. (-1713)" >&2; exit 1 ;;
esac
SH
  # la sesión gráfica: Aqua, salvo que el caso diga otra cosa
  printf '#!/usr/bin/env bash\ncat "%s/launchctl-modo" 2>/dev/null || echo Aqua\n' "$TMP" > "$RAIZ/bin/launchctl"
  # el identificador de la máquina, para que las formas del firewall sigan de largo hasta buscar az
  printf '#!/usr/bin/env bash\necho %s\n' "'  \"IOPlatformUUID\" = \"00000000-0000-0000-0000-000000000001\"'" > "$RAIZ/usr/sbin/ioreg"
  chmod +x "$RAIZ/usr/bin/osascript" "$RAIZ/bin/launchctl" "$RAIZ/usr/sbin/ioreg"
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

puerta(){ # corre la puerta con el mundo falso; imprime el exit code. Sin las variables de SSH: corrida por SSH, la
  # suite no tiene que fallar cerrada (T-puerta-24 las pone a propósito, con `puerta_con`)
  env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY HOME="$CASA" TYCON_PROD_ROOT="$RAIZ" TYCON_REPOS_ROOT="$REPOS" \
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


# ── T24j · `--load-key <host>`: el archivo sin tener que fallar una consulta ────────────────
# Cargar la clave no exige «correr
# una consulta que falle», un rodeo: hay un comando directo. Tiene que dejar el .command, NO
# tocar el cliente de base, NO pedir el secreto al Llavero, y salir 0 (la persona sigue).
mundo sin-entrada
rc="$(puerta --load-key "$PROD")"
if [ "$rc" = 0 ] && [ ! -s "$TMP/sqlcmd-argv.log" ] && ! grep -q -- " -w" "$TMP/security-argv.log" 2>/dev/null \
   && ls "$CASA/Desktop"/cargar-clave-tycon-prod-acme.command >/dev/null 2>&1 && grep -q "Escritorio" "$TMP/out"; then
  ok "T24j · --load-key deja el .command, no consulta, no lee el secreto, y sale 0"
else no "T24j · --load-key: rc=$rc · sqlcmd=$(wc -c <"$TMP/sqlcmd-argv.log" 2>/dev/null) · .command: $(ls "$CASA/Desktop" 2>/dev/null | tr '\n' ' ') · out: $(head -c 80 "$TMP/out")"; fi
rc="$(puerta --load-key "$STAGING")"
[ "$rc" != 0 ] && ok "T24k · --load-key con un host que NO es producción se niega" || no "T24k · dejó cargar clave para un host de no-producción"
rc="$(puerta --load-key)"
[ "$rc" != 0 ] && ok "T24l · --load-key sin host se niega" || no "T24l · --load-key sin host salió 0"

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

# ── T26 · --reclassify ──────────────────────────────────────────────────────────────────────
# El escenario real: el host se vio como producción (queda en la memoria pegajosa), el proyecto lo
# baja a no-producción en su catálogo… y aun así sigue frenándose (T15). Lo único que lo destraba es
# reclasificarlo por la puerta, que pasa por el cuadro de aprobación.
mundo ok
frena(){ echo "{\"tool_name\":\"Bash\",\"hook_event_name\":\"PreToolUse\",\"tool_input\":{\"command\":\"sqlcmd -S $PROD -Q \\\"select 1\\\"\"}}" \
  | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 node "$HOOK" >/dev/null 2>&1; echo $?; }
antes="$(frena)"                                   # lo vio como producción: queda en la memoria
printf '{"servers":[{"host":"%s","environment":"no-produccion"}]}' "$PROD" > "$REPOS/backend-acme/.tycon/production.json"
intermedio="$(frena)"                              # el catálogo ya dice no-producción y IGUAL frena
rc="$(puerta --reclassify "$PROD")"
despues="$(frena)"
if [ "$antes" = 2 ] && [ "$intermedio" = 2 ] && [ "$rc" = 0 ] && [ "$despues" = 0 ]; then ok "T26a · sólo la puerta lo destraba: reescribir el catálogo no alcanza"
else no "T26a · antes=$antes intermedio=$intermedio rc=$rc después=$despues (esperaba 2 / 2 / 0 / 0)"; fi
if grep -q "reclasific" "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null; then ok "T26b · la reclasificación queda en el registro"
else no "T26b · reclasificar no dejó constancia"; fi

# ── RetireD_NoticeAndGuardOptionsRenamed · las opciones de antes ya no existen, sin alias ──────────────────────
# La puerta y sus llamadores se instalan juntos: una opción de antes recibe el mensaje real de la puerta, que nombra
# las de hoy. Las de antes, armadas por partes (como en las pruebas de nombres).
mundo ok
OLD_LOAD="cargar-""clave"; OLD_RECLASS="reclasi""ficar"; OLD_VERIFY="verifi""car"; OLD_ROWS="max-""filas"
for vieja in "--$OLD_LOAD $PROD" "--$OLD_RECLASS $PROD" "--$OLD_VERIFY"; do
  # shellcheck disable=SC2086
  rc="$(puerta $vieja)"
  if [ "$rc" != 0 ] && grep -q "primer argumento inválido: sólo <host>, --load-key, --reclassify, --verify" "$TMP/err"; then
    ok "RetireD_NoticeAndGuardOptionsRenamed · «${vieja%% *}» ya no es una opción: «primer argumento inválido» con las de hoy @story-8.15 @ac-15"
  else no "RetireD_NoticeAndGuardOptionsRenamed · «${vieja%% *}»: rc=$rc — $(head -c 200 "$TMP/err") @story-8.15 @ac-15"; fi
done
rc="$(puerta "$PROD" 'select 1' "--$OLD_ROWS" 5)"
if [ "$rc" != 0 ] && grep -q "sólo se acepta la sentencia en línea y, opcionalmente, --max-rows N" "$TMP/err"; then
  ok "RetireD_NoticeAndGuardOptionsRenamed · la opción de antes del tope de filas recibe el mensaje con --max-rows @story-8.15 @ac-15"
else no "RetireD_NoticeAndGuardOptionsRenamed · tope de filas de antes: rc=$rc — $(head -c 200 "$TMP/err") @story-8.15 @ac-15"; fi

# ── 6.6 · la consulta va en línea: la puerta no acepta --file ────────────────────────────────────────────────────────
# El cuadro de aprobación muestra el comando y nada más: el contenido de un archivo no se ve antes de aprobar (medido el
# 2026-10-29). La puerta rechaza --file en cualquier posición, y la sentencia en línea pasa la misma lista de caracteres
# que engañan que el freno, mirada por el intérprete verificado y no por grep (que depende de la configuración regional).
H64=0000000000000000000000000000000000000000000000000000000000000000
printf 'select top 3 Id,\n       Nombre\nfrom Articulos\n' > "$TMP/consulta.sql"
sin_archivo_en_registro(){ ! grep -rqs '"origen":"archivo"' "$CASA" 2>/dev/null; }

# T9 · --file sale 2 con el uso, sin leer el archivo ni conectarse, y el registro no suma líneas de archivo
for args in "$PROD --file $TMP/consulta.sql --sha256 $H64" "$PROD --file $TMP/consulta.sql --sha256 $H64 --max-rows 5" \
            "--file $TMP/consulta.sql $PROD" "$PROD select --file $TMP/consulta.sql"; do
  mundo ok
  # shellcheck disable=SC2086
  rc="$(puerta $args)"
  if [ "$rc" = 2 ] && grep -q "uso" "$TMP/err" && [ ! -s "$TMP/sqlcmd-argv.log" ] && [ ! -s "$TMP/security-argv.log" ] && sin_archivo_en_registro; then
    ok "6.6 T9 Gate_File_Refused · «${args//$TMP\//}» sale 2 con el uso, sin conectarse"
  else no "6.6 T9 Gate_File_Refused · «${args//$TMP\//}» rc=$rc · $(head -c 200 "$TMP/err")"; fi
done

# T3 · el comando que arma el freno, corrido por la puerta, le da al cliente los bytes del archivo sin los saltos de línea
# del final (8.283, AC 5-6: el cuadro no deja un renglón vacío); los de adentro quedan
mundo ok
printf "select 'a''b' as x,\t\"c\" -- \$(id) \\\\ # ; | fin\nfrom T where n = 'it''s'\n-- tercera\n" > "$TMP/raro.sql"
printf "select 'a''b' as x,\t\"c\" -- \$(id) \\\\ # ; | fin\nfrom T where n = 'it''s'\n-- tercera" > "$TMP/raro-sin-final.sql"
payload="$(CMD="/opt/tycon/bin/tycon-prod-sql $PROD --file $TMP/raro.sql" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:"/tmp",tool_input:{command:process.env.CMD}}))')"
printf '%s' "$payload" | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 node "$HOOK" >/dev/null 2>"$TMP/hook-err"
LISTO="$(node -e '
  const t = require("fs").readFileSync(process.argv[1], "utf8"); const i = t.indexOf(process.argv[2]);
  if (i < 0) process.exit(1);
  const m = /^\S+ \S+ (?:\x27(?:[^\x27]|\x27\\\x27\x27)*\x27)(?: --max-rows \d+)?/.exec(t.slice(i));
  if (!m) process.exit(1); process.stdout.write(m[0]);' "$TMP/hook-err" "/opt/tycon/bin/tycon-prod-sql $PROD '")" || LISTO=""
if [ -n "$LISTO" ]; then
  eval "puerta ${LISTO#/opt/tycon/bin/tycon-prod-sql }" >/dev/null
  if cmp -s "$TMP/raro-sin-final.sql" "$TMP/sqlcmd-q.bin"; then ok "6.6 T3 Guard_File_InlineCommandRunsSameBytes · el cliente recibe byte a byte el archivo, sin el salto final"
  else no "6.6 T3 Guard_File_InlineCommandRunsSameBytes · el cliente recibió otra cosa: $(od -c "$TMP/sqlcmd-q.bin" 2>/dev/null | head -3)"; fi
else no "6.6 T3 Guard_File_InlineCommandRunsSameBytes · el freno no dio el comando — err: $(head -c 200 "$TMP/hook-err")"; fi

# T10 · los caracteres que engañan, directo a la puerta (también con LC_ALL=C): sale 2 sin conectarse
for raro in '\033[2J' '\r' '\302\233' '\302\255' '\330\234' '\342\200\256' '\342\200\213' '\357\270\217' '\363\240\201\201' '\377\376' \
           '\357\277\275' '\341\240\213' '\342\201\252' '\357\277\274'; do
  for loc in "" C; do
    mundo ok
    if [ "$loc" = C ]; then rc="$(LC_ALL=C puerta "$PROD" "select 1 $(printf "$raro") x")"; else rc="$(puerta "$PROD" "select 1 $(printf "$raro") x")"; fi
    if [ "$rc" = 2 ] && [ ! -s "$TMP/sqlcmd-argv.log" ] && grep -qE "caracteres|UTF-8" "$TMP/err"; then ok "6.6 T10 Gate_Inline_DeceivingChars_Exit2NoConnect · $raro${loc:+ (LC_ALL=$loc)}"
    else no "6.6 T10 Gate_Inline_DeceivingChars_Exit2NoConnect · $raro${loc:+ (LC_ALL=$loc)} rc=$rc · $(head -c 160 "$TMP/err")"; fi
  done
done

# una marca de orden de bytes al principio no la saca el decodificador: se ve como nada y sale 2
mundo ok
rc="$(puerta "$PROD" "$(printf '\357\273\277')select 1")"
if [ "$rc" = 2 ] && [ ! -s "$TMP/sqlcmd-argv.log" ] && grep -q "invisibles" "$TMP/err"; then ok "6.6 T10 Gate_Inline_DeceivingChars_Exit2NoConnect · marca de orden de bytes al principio"
else no "6.6 T10 Gate_Inline_DeceivingChars_Exit2NoConnect · marca de orden de bytes al principio rc=$rc · $(head -c 160 "$TMP/err")"; fi

# T11 · las reglas de siempre de la sentencia en línea: las malas salen 2, la buena llega al cliente
for mala in 'select 1
GO
select 2' 'select 1
:r /etc/passwd' '!! ls' '-i /tmp/x.sql'; do
  mundo ok
  rc="$(puerta "$PROD" "$mala")"
  if [ "$rc" = 2 ] && [ ! -s "$TMP/sqlcmd-argv.log" ]; then ok "6.6 T11 Gate_Inline_SameRules_Unchanged · «$(printf '%s' "$mala" | tail -1)» sale 2"
  else no "6.6 T11 Gate_Inline_SameRules_Unchanged · «$(printf '%s' "$mala" | tail -1)» rc=$rc"; fi
done
mundo ok
puerta "$PROD" 'select top 3 Id
from Articulos' >/dev/null
if printf 'select top 3 Id\nfrom Articulos' | cmp -s - "$TMP/sqlcmd-q.bin"; then ok "6.6 T11 Gate_Inline_SameRules_Unchanged · una buena de dos renglones llega al cliente tal cual"
else no "6.6 T11 Gate_Inline_SameRules_Unchanged · la buena no llegó al cliente: $(cat "$TMP/err")"; fi

# ── el cuadro propio: la puerta pide su aprobación, antes de leer la clave ────────────────────────────────────────────
# Caso que lo motiva: la aprobación de cada sentencia era sólo la regla `ask` de Claude Code, que mira el texto del
# comando. Un guion guardado que llamaba a la puerta consultaba producción sin ningún cuadro.
modo_cuadro(){ printf '%s' "$1" > "$TMP/cuadro-modo"; }
sin_security(){ ! grep -q '^security' "$TMP/orden.log" 2>/dev/null; }
ultimo_arg(){ cat "$TMP/cuadro-arg-$(cat "$TMP/cuadro-n" 2>/dev/null)" 2>/dev/null; }

# T-puerta-1 · el cuadro recibe host y sentencia, y recién después se lee la clave y se llama al cliente
mundo ok
rc="$(puerta "$PROD" 'select top 3 * from Articulos')"
primero="$(head -1 "$TMP/orden.log" 2>/dev/null)"
if [ "$primero" = cuadro ] && grep -q '^security .*-w' "$TMP/orden.log" && grep -q '^sqlcmd' "$TMP/orden.log" \
   && ultimo_arg | grep -F "$PROD" >/dev/null && ultimo_arg | grep -F 'select top 3 * from Articulos' >/dev/null; then
  ok "T-puerta-1 PuertaPideCuadro_AntesDeLeerLaClave @story-8.254 @ac-1 · el cuadro va primero, con host y sentencia; después security -w y el cliente"
else no "T-puerta-1 PuertaPideCuadro_AntesDeLeerLaClave @story-8.254 @ac-1 · orden: $(tr '\n' '|' < "$TMP/orden.log" 2>/dev/null) · cuadro: $(ultimo_arg | head -c 120)"; fi
if grep '"accion":"consulta"' "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null | grep '"aprobacion":"cuadro-propio"' >/dev/null; then
  ok "T-puerta-1 PuertaPideCuadro_AntesDeLeerLaClave @story-8.254 @ac-1 · el registro de la consulta dice cuadro-propio"
else no "T-puerta-1 PuertaPideCuadro_AntesDeLeerLaClave @story-8.254 @ac-1 · el registro no dice cuadro-propio: $(tail -1 "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null)"; fi

# T-puerta-2 · lo piden la consulta, --reclassify y --open-firewall; las otras cinco formas no
mundo ok
puerta --reclassify "$PROD" >/dev/null
if [ "$(head -1 "$TMP/orden.log" 2>/dev/null)" = cuadro ] && ultimo_arg | grep -F "Bajar $PROD a no producción" >/dev/null \
   && grep '"accion":"reclasificar"' "$CASA/.claude/.tycon-pipeline/production.log" | grep '"aprobacion":"cuadro-propio"' >/dev/null; then
  ok "T-puerta-2 PuertaCuadro_FormasQueLoPidenYLasQueNo @story-8.254 @ac-2 · --reclassify pide el cuadro con la acción y el host, y lo anota"
else no "T-puerta-2 PuertaCuadro_FormasQueLoPidenYLasQueNo @story-8.254 @ac-2 · --reclassify: orden $(tr '\n' '|' < "$TMP/orden.log" 2>/dev/null) · $(ultimo_arg | head -c 120)"; fi
mundo ok; modo_cuadro rechazar
rc="$(puerta --reclassify "$PROD")"
if [ "$rc" = 2 ] && grep -q "no aprobó" "$TMP/err" && ! grep -q '"accion":"reclasificar"' "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null; then
  ok "T-puerta-2 PuertaCuadro_FormasQueLoPidenYLasQueNo @story-8.254 @ac-2 · --reclassify rechazado no reclasifica"
else no "T-puerta-2 PuertaCuadro_FormasQueLoPidenYLasQueNo @story-8.254 @ac-2 · --reclassify rechazado: rc=$rc · $(head -c 160 "$TMP/err")"; fi
mundo ok; modo_cuadro rechazar
rc="$(puerta --open-firewall "$PROD")"
if [ "$rc" = 2 ] && [ "$(head -1 "$TMP/orden.log" 2>/dev/null)" = cuadro ] && ultimo_arg | grep -F "Abrir el firewall de $PROD" >/dev/null && grep -q "no aprobó" "$TMP/err"; then
  ok "T-puerta-2 PuertaCuadro_FormasQueLoPidenYLasQueNo @story-8.254 @ac-2 · --open-firewall pide el cuadro antes de hacer nada"
else no "T-puerta-2 PuertaCuadro_FormasQueLoPidenYLasQueNo @story-8.254 @ac-2 · --open-firewall: rc=$rc · orden $(tr '\n' '|' < "$TMP/orden.log" 2>/dev/null) · $(head -c 160 "$TMP/err")"; fi
for forma in "--verify" "--locks" "--load-key $PROD" "--close-firewall $PROD" "--delete-group grupo-de-prueba"; do
  mundo ok
  # shellcheck disable=SC2086
  puerta $forma >/dev/null
  if ! grep -q '^cuadro' "$TMP/orden.log" 2>/dev/null; then ok "T-puerta-2 PuertaCuadro_FormasQueLoPidenYLasQueNo @story-8.254 @ac-2 · ${forma%% *} no pide el cuadro"
  else no "T-puerta-2 PuertaCuadro_FormasQueLoPidenYLasQueNo @story-8.254 @ac-2 · ${forma%% *} pidió el cuadro"; fi
done

# T-puerta-3 · la sentencia viaja sólo como argumento: el guion de AppleScript es el mismo con cualquier sentencia
mundo ok
puerta "$PROD" 'select 1' >/dev/null
guion_a="$(n="$(cat "$TMP/cuadro-n")"; i=1; while [ "$i" -lt "$n" ]; do cat "$TMP/cuadro-arg-$i"; printf '\n'; i=$((i+1)); done)"
mundo ok
MALA="select '\" & do shell script \"touch $TMP/inyectado\" & \"' as x, 'a\\b' as \"y\""
puerta "$PROD" "$MALA" >/dev/null
guion_b="$(n="$(cat "$TMP/cuadro-n")"; i=1; while [ "$i" -lt "$n" ]; do cat "$TMP/cuadro-arg-$i"; printf '\n'; i=$((i+1)); done)"
if [ -n "$guion_a" ] && [ "$guion_a" = "$guion_b" ] && ultimo_arg | grep -F "$MALA" >/dev/null && [ ! -e "$TMP/inyectado" ] \
   && ! printf '%s' "$guion_b" | grep -F 'do shell script' >/dev/null; then
  ok "T-puerta-3 PuertaCuadro_SentenciaLiteral_SinInyeccion @story-8.254 @ac-3 · la sentencia llega intacta por argv y el guion no cambia"
else no "T-puerta-3 PuertaCuadro_SentenciaLiteral_SinInyeccion @story-8.254 @ac-3 · guion igual: $([ "$guion_a" = "$guion_b" ] && echo sí || echo no) · arg: $(ultimo_arg | head -c 160)"; fi

# T-puerta-5 · desde bash puro, sin nada de Claude Code: el cuadro se pide igual, y sin aprobación no se lee la clave
mundo ok; modo_cuadro rechazar
env -i HOME="$CASA" PATH=/usr/bin:/bin TYCON_PROD_TEST_PATH="$(dirname "$(command -v node)")" TYCON_PROD_ROOT="$RAIZ" \
    TYCON_REPOS_ROOT="$REPOS" bash "$PUERTA" "$PROD" 'select 1' >"$TMP/out" 2>"$TMP/err"; rc=$?
if [ "$rc" = 2 ] && [ "$(head -1 "$TMP/orden.log" 2>/dev/null)" = cuadro ] && sin_security && ! grep -q '^sqlcmd' "$TMP/orden.log" \
   && grep -q "la persona no aprobó esta sentencia" "$TMP/err"; then
  ok "T-puerta-5 Puerta_SinClaudeCode_PideCuadro @story-8.254 @ac-4 · el cuadro fue llamado, antes de cualquier security; sale 2"
else no "T-puerta-5 Puerta_SinClaudeCode_PideCuadro @story-8.254 @ac-4 · rc=$rc · orden $(tr '\n' '|' < "$TMP/orden.log" 2>/dev/null) · $(head -c 160 "$TMP/err")"; fi

# T-puerta-23 · rechazo, vencimiento (osascript sale 0 con gave up:true) y error: ni security ni cliente, y el registro
for m in rechazar vencer error; do
  mundo ok; modo_cuadro "$m"
  rc="$(puerta "$PROD" 'select 1')"
  if [ "$rc" = 2 ] && sin_security && ! grep -q '^sqlcmd' "$TMP/orden.log" && grep -q "la persona no aprobó esta sentencia" "$TMP/err" \
     && grep -q '"accion":"rechazada"' "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null; then
    ok "T-puerta-23 PuertaCuadro_RechazoVencidoOError @story-8.254 @ac-18 · $m: sale 2 sin security ni cliente, y queda «rechazada»"
  else no "T-puerta-23 PuertaCuadro_RechazoVencidoOError @story-8.254 @ac-18 · $m: rc=$rc · orden $(tr '\n' '|' < "$TMP/orden.log" 2>/dev/null) · $(head -c 160 "$TMP/err")"; fi
done

# ── sin aprobación, la puerta dice cuál de las tres pasó ─────────────────────────────────────────────────────────────
# Con una frase para las tres, quien pidió no sabe si alguien vio el cuadro: una consulta corrida de fondo se vence sin
# que nadie la mire y parece rechazada. El registro sigue diciendo «rechazada», con el motivo al lado.
ultimo_registro(){ tail -1 "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null; }
sin_aprobar_dice(){ # $1 = motivo del registro · $2 = la frase de la causa · $3 = sentencia | operación
  local r; r="$(ultimo_registro)"
  [ "$rc" = 2 ] && sin_security && ! grep -q '^sqlcmd' "$TMP/orden.log" 2>/dev/null \
    && grep -qF "la persona no aprobó esta $3" "$TMP/err" && grep -qF "$2" "$TMP/err" \
    && [[ "$r" == *'"accion":"rechazada"'* ]] && [[ "$r" == *"\"motivo\":\"$1\""* ]]
}
mundo ok; modo_cuadro vencer
rc="$(puerta "$PROD" 'select 1')"
if sin_aprobar_dice vencido "el cuadro se venció a los 120 s sin respuesta" sentencia && grep -qF "nadie lo vio" "$TMP/err" \
   && ! grep -qF "Rechazar" "$TMP/err" && ! grep -qF "no se pudo abrir" "$TMP/err"; then
  ok "T4 ProdSql_DialogExpired_SaysSo @story-8.333 @ac-4 · vencido: sale 2, dice que se venció y que de fondo nadie lo vio, y el registro trae el motivo"
else no "T4 ProdSql_DialogExpired_SaysSo @story-8.333 @ac-4 · vencido: rc=$rc · $(head -c 240 "$TMP/err") · registro: $(ultimo_registro)"; fi
mundo ok; modo_cuadro vencer
rc="$(puerta --reclassify "$PROD")"
if sin_aprobar_dice vencido "el cuadro se venció a los 120 s sin respuesta" operación; then
  ok "T4 ProdSql_DialogExpired_SaysSo @story-8.333 @ac-4 · --reclassify vencido: dice «operación» y el registro trae el motivo"
else no "T4 ProdSql_DialogExpired_SaysSo @story-8.333 @ac-4 · --reclassify vencido: rc=$rc · $(head -c 240 "$TMP/err") · registro: $(ultimo_registro)"; fi

mundo ok; modo_cuadro rechazar
rc="$(puerta "$PROD" 'select 1')"
if sin_aprobar_dice rechazado "apretó «Rechazar» en el cuadro" sentencia && ! grep -qF "se venció" "$TMP/err" && ! grep -qF "no se pudo abrir" "$TMP/err"; then
  ok "T5 ProdSql_DialogRejected_SaysSo @story-8.333 @ac-5 · rechazado: sale 2, dice que la persona lo rechazó, y el registro trae el motivo"
else no "T5 ProdSql_DialogRejected_SaysSo @story-8.333 @ac-5 · rechazado: rc=$rc · $(head -c 240 "$TMP/err") · registro: $(ultimo_registro)"; fi
mundo ok; modo_cuadro rechazar
rc="$(puerta --open-firewall "$PROD")"
if sin_aprobar_dice rechazado "apretó «Rechazar» en el cuadro" operación; then
  ok "T5 ProdSql_DialogRejected_SaysSo @story-8.333 @ac-5 · --open-firewall rechazado: dice «operación» y el registro trae el motivo"
else no "T5 ProdSql_DialogRejected_SaysSo @story-8.333 @ac-5 · --open-firewall rechazado: rc=$rc · $(head -c 240 "$TMP/err") · registro: $(ultimo_registro)"; fi

# error: el programa sale con error · mudo: sale 0 sin contestar · raro: contesta algo que empieza como «Aprobar» y no es
for m in error mudo raro; do
  mundo ok; modo_cuadro "$m"
  rc="$(puerta "$PROD" 'select 1')"
  if sin_aprobar_dice sin-cuadro "el cuadro no se pudo abrir" sentencia && ! grep -qF "se venció" "$TMP/err" && ! grep -qF "Rechazar" "$TMP/err"; then
    ok "T6 ProdSql_NoDialog_SaysSo @story-8.333 @ac-6 · $m: sale 2, dice que el cuadro no se pudo abrir, y el registro trae el motivo"
  else no "T6 ProdSql_NoDialog_SaysSo @story-8.333 @ac-6 · $m: rc=$rc · $(head -c 240 "$TMP/err") · registro: $(ultimo_registro)"; fi
done
mundo ok; modo_cuadro error
rc="$(puerta "$PROD" 'select 1')"
if grep -qF "salió con el código 1" "$TMP/err"; then ok "T6 ProdSql_NoDialog_SaysSo @story-8.333 @ac-6 · error: dice con qué código salió el programa del cuadro"
else no "T6 ProdSql_NoDialog_SaysSo @story-8.333 @ac-6 · error: no dice el código — $(head -c 240 "$TMP/err")"; fi
# sólo la respuesta exacta de «Aprobar» aprueba
mundo ok; modo_cuadro aprobar
rc="$(puerta "$PROD" 'select 1')"
if grep -q '^sqlcmd' "$TMP/orden.log" 2>/dev/null && ! grep -qF "no aprobó" "$TMP/err" \
   && grep '"accion":"consulta"' "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null | grep -F '"aprobacion":"cuadro-propio"' >/dev/null \
   && ! grep -qF '"accion":"rechazada"' "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null; then
  ok "T6 ProdSql_NoDialog_SaysSo @story-8.333 @ac-6 · «Aprobar» sigue aprobando: lee la clave, consulta y anota cuadro-propio"
else no "T6 ProdSql_NoDialog_SaysSo @story-8.333 @ac-6 · «Aprobar» no aprobó: rc=$rc · orden $(tr '\n' '|' < "$TMP/orden.log" 2>/dev/null) · $(head -c 160 "$TMP/err")"; fi

# T-puerta-24 · sin la sesión de la Mac (otra sesión que Aqua, o por SSH) sale 2 antes de abrir el cuadro
mundo ok; printf 'Background\n' > "$TMP/launchctl-modo"
rc="$(puerta "$PROD" 'select 1')"
if [ "$rc" = 2 ] && grep -q "el cuadro de producción necesita la sesión de la Mac: abrí la terminal en la Mac, no por SSH" "$TMP/err" && [ ! -s "$TMP/orden.log" ]; then
  ok "T-puerta-24 Puerta_SinSesionGrafica_Frena @story-8.254 @ac-19 · launchctl dice Background: sale 2 sin cuadro ni clave"
else no "T-puerta-24 Puerta_SinSesionGrafica_Frena @story-8.254 @ac-19 · Background: rc=$rc · $(head -c 160 "$TMP/err")"; fi
mundo ok
env HOME="$CASA" TYCON_PROD_ROOT="$RAIZ" TYCON_REPOS_ROOT="$REPOS" SSH_CONNECTION="10.0.0.1 50000 10.0.0.2 22" bash "$PUERTA" "$PROD" 'select 1' >"$TMP/out" 2>"$TMP/err"; rc=$?
if [ "$rc" = 2 ] && grep -q "no por SSH" "$TMP/err" && [ ! -s "$TMP/orden.log" ]; then
  ok "T-puerta-24 Puerta_SinSesionGrafica_Frena @story-8.254 @ac-19 · por SSH: sale 2 sin cuadro ni clave"
else no "T-puerta-24 Puerta_SinSesionGrafica_Frena @story-8.254 @ac-19 · SSH: rc=$rc · $(head -c 160 "$TMP/err")"; fi

# T-puerta-25 · sin el programa del cuadro, falla cerrada
mundo ok; rm -f "$RAIZ/usr/bin/osascript"
rc="$(puerta "$PROD" 'select 1')"
if [ "$rc" = 2 ] && sin_security && ! grep -q '^sqlcmd' "$TMP/orden.log" 2>/dev/null; then
  ok "T-puerta-25 Puerta_SinProgramaDelCuadro_Frena @story-8.254 @ac-20 · sale 2 sin leer la clave"
else no "T-puerta-25 Puerta_SinProgramaDelCuadro_Frena @story-8.254 @ac-20 · rc=$rc · $(head -c 160 "$TMP/err")"; fi

# T-puerta-28 · el cierre del firewall (con y sin --session, como lo corre el fin de sesión) no pide cuadro
for args in "--close-firewall $PROD --session 0123456789abcdef" "--close-firewall $PROD"; do
  mundo ok
  # shellcheck disable=SC2086
  puerta $args >/dev/null
  if ! grep -q '^cuadro' "$TMP/orden.log" 2>/dev/null; then ok "T-puerta-28 CierreDeFirewall_SinCuadro @story-8.254 @ac-24 · «${args//$PROD/<host>}» no pide el cuadro"
  else no "T-puerta-28 CierreDeFirewall_SinCuadro @story-8.254 @ac-24 · «${args//$PROD/<host>}» pidió el cuadro"; fi
done

# T-puerta-32 · una sentencia que el cuadro no muestra entera sale 2 antes de abrirlo
mundo ok
larga="select '$(head -c 1300 /dev/zero | tr '\0' 'x')'"
rc="$(puerta "$PROD" "$larga")"
if [ "$rc" = 2 ] && grep -q "la sentencia es demasiado larga para que el cuadro la muestre entera: partila" "$TMP/err" && [ ! -s "$TMP/orden.log" ]; then
  ok "T-puerta-32 PuertaCuadro_SentenciaQueNoEntra_Sale2 @story-8.254 @ac-28 · más caracteres que el tope: sale 2 sin cuadro ni clave"
else no "T-puerta-32 PuertaCuadro_SentenciaQueNoEntra_Sale2 @story-8.254 @ac-28 · larga: rc=$rc · $(head -c 160 "$TMP/err")"; fi
mundo ok
renglones="select 1$(i=0; while [ $i -lt 21 ]; do printf '\n, %s' "$i"; i=$((i+1)); done)"
rc="$(puerta "$PROD" "$renglones")"
if [ "$rc" = 2 ] && grep -q "demasiado larga" "$TMP/err" && [ ! -s "$TMP/orden.log" ]; then
  ok "T-puerta-32 PuertaCuadro_SentenciaQueNoEntra_Sale2 @story-8.254 @ac-28 · más renglones que el tope: sale 2 sin cuadro ni clave"
else no "T-puerta-32 PuertaCuadro_SentenciaQueNoEntra_Sale2 @story-8.254 @ac-28 · renglones: rc=$rc · $(head -c 160 "$TMP/err")"; fi
mundo ok
justa="select '$(head -c 1100 /dev/zero | tr '\0' 'x')'"
rc="$(puerta "$PROD" "$justa")"
if [ "$(head -1 "$TMP/orden.log" 2>/dev/null)" = cuadro ]; then ok "T-puerta-32 PuertaCuadro_SentenciaQueNoEntra_Sale2 @story-8.254 @ac-28 · una dentro del tope sí llega al cuadro"
else no "T-puerta-32 PuertaCuadro_SentenciaQueNoEntra_Sale2 @story-8.254 @ac-28 · una dentro del tope no llegó al cuadro: rc=$rc · $(head -c 160 "$TMP/err")"; fi

# T-puerta-33 · lo aprobado es todo lo que corre: el cliente no hereda SQLCMDINI (un archivo de SQL que go-sqlcmd ejecuta al
# arrancar), SQLCMDDBNAME ni ninguna otra variable suya del que llama
mundo ok
printf 'delete from clientes\n' > "$TMP/ini.sql"
rc="$(SQLCMDINI="$TMP/ini.sql" SQLCMDDBNAME=otra SQLCMDSERVER=otro SQLCMD_LO_QUE_SEA=1 puerta "$PROD" 'select 1')"
if [ -f "$TMP/sqlcmd-argv.log" ] && [ ! -s "$TMP/sqlcmd-heredado.log" ] && grep -qx "SQLCMDPASSWORD=$CLAVE_MARCA" "$TMP/sqlcmd-env.log"; then
  ok "T-puerta-33 Puerta_ClienteNoHeredaSuEntorno @story-8.254 @ac-29 · sin SQLCMDINI ni otra variable suya, y con la clave del Llavero"
else no "T-puerta-33 Puerta_ClienteNoHeredaSuEntorno @story-8.254 @ac-29 · rc=$rc · heredó: $(tr '\n' ' ' < "$TMP/sqlcmd-heredado.log" 2>/dev/null) · $(head -c 160 "$TMP/err")"; fi

# T-puerta-34 · lo que no se puede mostrar no llega al cuadro: vacío, sin host, o más ancho de lo que entra
for vacia in '' '    '; do
  mundo ok; rc="$(puerta "$PROD" "$vacia")"
  if [ "$rc" = 2 ] && [ ! -s "$TMP/orden.log" ] && grep -q 'vacía' "$TMP/err"; then ok "T-puerta-34 PuertaCuadro_SinNadaQueMostrar @story-8.254 @ac-30 · sentencia en blanco («${vacia}»): sale 2 sin cuadro"
  else no "T-puerta-34 PuertaCuadro_SinNadaQueMostrar @story-8.254 @ac-30 · «${vacia}»: rc=$rc · orden $(tr '\n' '|' < "$TMP/orden.log" 2>/dev/null) · $(head -c 160 "$TMP/err")"; fi
done
mundo ok; rc="$(puerta --reclassify '')"
if [ "$rc" = 2 ] && [ ! -s "$TMP/orden.log" ] && grep -q -- 'uso: .*--reclassify' "$TMP/err"; then ok "T-puerta-34 PuertaCuadro_SinNadaQueMostrar @story-8.254 @ac-30 · --reclassify sin host: dice cómo se usa y no abre el cuadro"
else no "T-puerta-34 PuertaCuadro_SinNadaQueMostrar @story-8.254 @ac-30 · --reclassify '': rc=$rc · orden $(tr '\n' '|' < "$TMP/orden.log" 2>/dev/null)"; fi
ancha="$(node -e 'const r = "漢".repeat(60); console.log(Array(19).fill(r).join("\n"))')"
tabs="select 1$(node -e 'process.stdout.write("\t".repeat(1150))'); delete from t"
for caso in ancha tabs; do
  mundo ok; rc="$(puerta "$PROD" "${!caso}")"
  if [ "$rc" = 2 ] && [ ! -s "$TMP/orden.log" ] && grep -q 'demasiado larga' "$TMP/err"; then ok "T-puerta-34 PuertaCuadro_SinNadaQueMostrar @story-8.254 @ac-30 · $caso: cuenta su ancho en pantalla y no llega al cuadro"
  else no "T-puerta-34 PuertaCuadro_SinNadaQueMostrar @story-8.254 @ac-30 · $caso: rc=$rc · orden $(tr '\n' '|' < "$TMP/orden.log" 2>/dev/null) · $(head -c 160 "$TMP/err")"; fi
done

# ── un cuadro por vez, y el cuadro dice quién pide ─────────────────────────────────────────────────────────────────
# Sin turno, una ráfaga de consultas apila cuadros; y sin decir quién pide, con dos sesiones a la vez no se sabe de cuál
# viene cada uno.
REG="$CASA/.claude/.tycon-pipeline/production.log"

# T-puerta-35 · la primera línea del cuadro dice la carpeta y la sesión; desde una terminal, que es una terminal
mundo ok
mkdir -p "$TMP/proyectos/Cliente/Codigo"
rc="$(cd "$TMP/proyectos/Cliente/Codigo" && CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=0123abcd-4567-89ef-0123-456789abcdef puerta "$PROD" 'select 1')"
if [ "$(ultimo_arg | head -1)" = "Pide: Cliente/Codigo · sesión 0123abcd (principal)" ] && ultimo_arg | grep -F "Servidor: $PROD" >/dev/null; then
  ok "T-puerta-35 PuertaCuadro_DiceQuienPide · carpeta y sesión en la primera línea, antes del servidor"
else no "T-puerta-35 PuertaCuadro_DiceQuienPide · cuadro: $(ultimo_arg | head -3 | tr '\n' '|')"; fi
mundo ok
rc="$(unset CLAUDECODE CLAUDE_CODE_SESSION_ID; cd "$TMP/proyectos/Cliente/Codigo" && puerta "$PROD" 'select 1')"
if [ "$(ultimo_arg | head -1)" = "Pide: Cliente/Codigo · una terminal, fuera de Claude Code" ]; then
  ok "T-puerta-35 PuertaCuadro_DiceQuienPide · sin Claude Code, dice que es una terminal"
else no "T-puerta-35 PuertaCuadro_DiceQuienPide · terminal: $(ultimo_arg | head -1)"; fi
mundo ok
raro="$TMP/proyectos/Producción/a$(printf '\xe2\x80\xae')b"; mkdir -p "$raro"
rc="$(cd "$raro" && CLAUDE_CODE_SESSION_ID=0123abcd-4567-89ef-0123-456789abcdef puerta "$PROD" 'select 1')"
if [ "$(ultimo_arg | head -1)" = "Pide: Producción/a?b · sesión 0123abcd (principal)" ]; then
  ok "T-puerta-35 PuertaCuadro_DiceQuienPide · la tilde se ve, y un carácter de dirección sale como «?»"
else no "T-puerta-35 PuertaCuadro_DiceQuienPide · carpeta rara: $(ultimo_arg | head -1)"; fi

# el doble del cuadro que tarda: anota cuándo abrió y cerró cada uno
cuadro_lento(){ # $1 = segundos que tarda en contestar
  cat > "$RAIZ/usr/bin/osascript" <<SH
#!/usr/bin/env bash
printf 'abre %s\n' "\$\$" >> "$TMP/cuadros.log"
sleep $1
printf 'cierra %s\n' "\$\$" >> "$TMP/cuadros.log"
echo "button returned:Aprobar, gave up:false"
SH
  chmod +x "$RAIZ/usr/bin/osascript"; rm -f "$TMP/cuadros.log"
}

# T-puerta-36 · tres pedidos a la vez: los cuadros se abren de a uno (nunca dos abiertos), y los tres se contestan
mundo ok; cuadro_lento 1
for i in 1 2 3; do ( puerta "$PROD" "select $i" >/dev/null; ) & done; wait
abiertos=0; max=0
while read -r que _; do
  [ "$que" = abre ] && abiertos=$((abiertos+1)); [ "$que" = cierra ] && abiertos=$((abiertos-1))
  [ "$abiertos" -gt "$max" ] && max=$abiertos
done < "$TMP/cuadros.log"
if [ "$(grep -c '^abre' "$TMP/cuadros.log")" = 3 ] && [ "$max" = 1 ] && [ ! -e "$CASA/.claude/.tycon-pipeline/production-dialog.turn" ]; then
  ok "T-puerta-36 PuertaCuadro_UnoPorVez · tres pedidos a la vez abren tres cuadros, nunca dos juntos, y el turno queda libre"
else no "T-puerta-36 PuertaCuadro_UnoPorVez · máximo abiertos a la vez: $max · log: $(tr '\n' '|' < "$TMP/cuadros.log")"; fi

# T-puerta-37 · si el cuadro abierto no se contesta antes del tope, el segundo sale 2 sin cuadro ni clave, y dice de quién es
mundo ok; cuadro_lento 4
( cd "$TMP/proyectos/Cliente/Codigo" && CLAUDE_CODE_SESSION_ID=0123abcd-4567-89ef-0123-456789abcdef puerta "$PROD" 'select 1' >/dev/null ) &
primero=$!
sleep 1
rm -f "$TMP/orden.log"
rc="$(TYCON_PROD_TEST_DIALOG_WAIT=1 puerta "$PROD" 'select 2')"
# antes de que termine la primera, que sí está aprobada: después lee la clave y pisa la salida de error
cp "$TMP/err" "$TMP/err-37"; sin_clave_37=0; grep -q '^security' "$TMP/orden.log" 2>/dev/null || sin_clave_37=1
wait "$primero"
if [ "$rc" = 2 ] && grep -q "ya hay un cuadro de producción abierto esperando respuesta" "$TMP/err-37" && grep -q "Cliente/Codigo · sesión 0123abcd" "$TMP/err-37" \
   && [ "$(grep -c '^abre' "$TMP/cuadros.log")" = 1 ] && [ "$sin_clave_37" = 1 ] && grep -q '"accion":"sin-turno"' "$REG"; then
  ok "T-puerta-37 PuertaCuadro_TopeDeEspera · vencida la espera sale 2, nombra quién tiene el cuadro, no abre otro ni lee la clave, y lo anota"
else no "T-puerta-37 PuertaCuadro_TopeDeEspera · rc=$rc · cuadros: $(grep -c '^abre' "$TMP/cuadros.log") · sin clave: $sin_clave_37 · $(head -c 200 "$TMP/err-37")"; fi

# T-puerta-38 · un turno de una puerta que ya no corre (la mataron) no traba a la siguiente
mundo ok
printf '999999\nuna puerta muerta' > "$CASA/.claude/.tycon-pipeline/production-dialog.turn"
rc="$(TYCON_PROD_TEST_DIALOG_WAIT=3 puerta "$PROD" 'select 1')"
if [ "$(head -1 "$TMP/orden.log" 2>/dev/null)" = cuadro ] && [ ! -e "$CASA/.claude/.tycon-pipeline/production-dialog.turn" ]; then
  ok "T-puerta-38 PuertaCuadro_TurnoAbandonado · el turno de un proceso muerto se toma y el cuadro se abre"
else no "T-puerta-38 PuertaCuadro_TurnoAbandonado · rc=$rc · orden $(tr '\n' '|' < "$TMP/orden.log" 2>/dev/null) · $(head -c 160 "$TMP/err")"; fi

# T-puerta-40 · un turno abandonado y una ráfaga: lo toma una sola puerta, y nunca quedan dos cuadros abiertos a la vez
# (dos que vieron el mismo turno muerto se llevaban también el turno vivo que la primera acababa de crear)
peor=0
for ronda in 1 2 3; do
  mundo ok; cuadro_lento 1
  printf '999999\nuna puerta muerta' > "$CASA/.claude/.tycon-pipeline/production-dialog.turn"
  for i in 1 2 3 4 5 6; do ( TYCON_PROD_TEST_DIALOG_WAIT=30 puerta "$PROD" "select $i" >/dev/null; ) & done; wait
  abiertos=0; max=0
  while read -r que _; do
    [ "$que" = abre ] && abiertos=$((abiertos+1)); [ "$que" = cierra ] && abiertos=$((abiertos-1))
    [ "$abiertos" -gt "$max" ] && max=$abiertos
  done < "$TMP/cuadros.log"
  [ "$max" -gt "$peor" ] && peor=$max
done
if [ "$peor" = 1 ]; then ok "T-puerta-40 PuertaCuadro_TurnoAbandonado_EnRafaga · tres rondas de seis puertas sobre un turno muerto: nunca dos cuadros abiertos"
else no "T-puerta-40 PuertaCuadro_TurnoAbandonado_EnRafaga · hubo $peor cuadros abiertos a la vez"; fi

# T-puerta-41 · si el turno no se puede crear, sale enseguida y dice eso, no que hay otro cuadro abierto. Una carpeta
# donde va el archivo del turno hace fallar su creación sin quitarle la escritura al resto del estado (sin escritura, la
# puerta ya frena antes, al leer el índice)
mundo ok
mkdir -p "$CASA/.claude/.tycon-pipeline/production-dialog.turn"
# stable-data: mide cuánto tarda la puerta, no afirma ninguna fecha
desde=$(date +%s)
rc="$(puerta "$PROD" 'select 1')"
tardo=$(( $(date +%s) - desde ))
if [ "$rc" = 2 ] && grep -q "no pude crear el turno del cuadro" "$TMP/err" && ! grep -q "ya hay un cuadro" "$TMP/err" && [ ! -s "$TMP/orden.log" ] && [ "$tardo" -lt 10 ]; then
  ok "T-puerta-41 PuertaCuadro_TurnoQueNoSeCrea · sale 2 en ${tardo} s, sin cuadro ni clave, diciendo que no pudo crear el turno"
else no "T-puerta-41 PuertaCuadro_TurnoQueNoSeCrea · rc=$rc · tardó ${tardo} s · $(head -c 200 "$TMP/err")"; fi

# T-puerta-39 · el freno no deja a un subagente llamar a la puerta, con ninguna forma; a la sesión principal no la frena por eso
mundo ok
freno_puerta(){ # $1 = comando · $2 = campo extra del evento (o vacío)
  node -e 'const [c, extra] = process.argv.slice(1); const e = { tool_name: "Bash", hook_event_name: "PreToolUse", session_id: "s1", tool_input: { command: c } }; if (extra) e.agent_id = extra; process.stdout.write(JSON.stringify(e));' "$1" "$2" \
    | env HOME="$CASA" TYCON_REPOS_ROOT="$REPOS" TYCON_PROD_SESSION_SINCE=0 node "$HOOK" >/dev/null 2>"$TMP/freno-err"; echo $?
}
for cmd in "/opt/tycon/bin/tycon-prod-sql $PROD 'select 1'" "/opt/tycon/bin/tycon-prod-sql --verify" "/opt/tycon/bin/tycon-prod-sql --open-firewall $PROD"; do
  rc="$(freno_puerta "$cmd" a535a3bec91651866)"
  if [ "$rc" = 2 ] && grep -q "un subagente no puede usar la puerta de producción" "$TMP/freno-err" && grep -q "que la sesión principal las corra" "$TMP/freno-err"; then
    ok "T-puerta-39 Freno_SubagenteNoUsaLaPuerta · «${cmd#/opt/tycon/bin/tycon-prod-sql }» desde un subagente: frena y dice qué hacer"
  else no "T-puerta-39 Freno_SubagenteNoUsaLaPuerta · «${cmd#/opt/tycon/bin/tycon-prod-sql }»: rc=$rc · $(head -c 200 "$TMP/freno-err")"; fi
done
rc="$(freno_puerta "/opt/tycon/bin/tycon-prod-sql $PROD 'select 1'" '')"
if ! grep -q "subagente" "$TMP/freno-err"; then ok "T-puerta-39 Freno_SubagenteNoUsaLaPuerta · la sesión principal no se frena por ser subagente"
else no "T-puerta-39 Freno_SubagenteNoUsaLaPuerta · la principal recibió el mensaje de subagente: $(head -c 200 "$TMP/freno-err")"; fi
if grep -q '"regla":"puerta-subagente"' "$CASA/.claude/.tycon-pipeline/guard-decisions.jsonl" 2>/dev/null || grep -rqs '"puerta-subagente"' "$CASA/.claude/.tycon-pipeline"; then
  ok "T-puerta-39 Freno_SubagenteNoUsaLaPuerta · el bloqueo queda anotado con su regla"
else no "T-puerta-39 Freno_SubagenteNoUsaLaPuerta · no encontré la regla puerta-subagente en el registro de decisiones: $(ls "$CASA/.claude/.tycon-pipeline")"; fi

# T-puerta-42 · sin el cuadro propio no se hace nada: la medición que deja sacar la ventana de Claude Code. Cada forma que
# consulta o cambia algo, con el cuadro ausente, rechazado, vencido o roto, sale 2 sin leer la clave, sin conectarse y sin
# anotar el cambio; y las que no piden cuadro no consultan ni cambian nada que no se deshaga
for forma in consulta reclasificar firewall; do
  for m in sin-programa rechazar vencer error; do
    mundo ok
    if [ "$m" = sin-programa ]; then rm -f "$RAIZ/usr/bin/osascript"; else modo_cuadro "$m"; fi
    case "$forma" in
      consulta) rc="$(puerta "$PROD" 'select 1')" ;;
      reclasificar) rc="$(puerta --reclassify "$PROD")" ;;
      firewall) rc="$(puerta --open-firewall "$PROD")" ;;
    esac
    if [ "$rc" = 2 ] && sin_security && ! grep -q '^sqlcmd' "$TMP/orden.log" 2>/dev/null && [ ! -s "$TMP/sqlcmd-argv.log" ] \
       && ! grep -qE '"accion":"(consulta|reclasificar|open-firewall)"' "$CASA/.claude/.tycon-pipeline/production.log" 2>/dev/null; then
      ok "T-puerta-42 Puerta_SinSuCuadro_NoHaceNada · $forma con el cuadro $m: sale 2 sin clave, sin conectarse y sin cambiar nada"
    else no "T-puerta-42 Puerta_SinSuCuadro_NoHaceNada · $forma con el cuadro $m: rc=$rc · orden $(tr '\n' '|' < "$TMP/orden.log" 2>/dev/null) · $(head -c 160 "$TMP/err")"; fi
  done
done
for forma in "--verify" "--locks" "--load-key $PROD" "--close-firewall $PROD"; do
  mundo ok; rm -f "$RAIZ/usr/bin/osascript"
  # shellcheck disable=SC2086
  puerta $forma >/dev/null
  if [ ! -s "$TMP/sqlcmd-argv.log" ] && ! grep -q -- '-w' "$TMP/security-argv.log" 2>/dev/null; then
    ok "T-puerta-42 Puerta_SinSuCuadro_NoHaceNada · ${forma%% *} no pide cuadro y no lee la clave ni se conecta"
  else no "T-puerta-42 Puerta_SinSuCuadro_NoHaceNada · ${forma%% *} leyó la clave o se conectó sin cuadro"; fi
done
# y la configuración administrada ya no pregunta por la puerta: su cuadro es la única ventana
if ! grep -qF 'Bash(/opt/tycon/bin/tycon-prod-sql' "$AQUI/scripts/production/managed-settings.tycon-production.json.template"; then
  ok "T-puerta-42 Puerta_SinSuCuadro_NoHaceNada · la plantilla administrada no tiene regla de preguntar por la puerta"
else no "T-puerta-42 Puerta_SinSuCuadro_NoHaceNada · la plantilla administrada todavía pregunta por la puerta: dos ventanas por consulta"; fi

echo "— prod-sql: $pasaron ok, $fallos fallos —"
[ "$fallos" -eq 0 ]
