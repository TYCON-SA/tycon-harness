#!/bin/bash -p
# node-shim.sh — lo que la configuración administrada ejecuta de verdad. Corre el freno de
# producción con un intérprete que el asistente NO puede cambiar.
#
# POR QUÉ EXISTE (story 6.1, AC 29, medido en esta Mac el 2026-09-15): `node` vive en
# /usr/local/bin y /opt/homebrew/bin, las dos carpetas escribibles por el usuario. Un
# `cp /bin/true /opt/homebrew/bin/node` apagaría el freno administrado entero **en silencio**: el
# hook «corre», sale 0, y nadie se entera. Por eso el instalador copia el intérprete a
# /opt/tycon/bin/node (root:wheel) con su huella, y acá se usa SÓLO ése.
#
# Y si no se puede usar, no se deja pasar a ciegas: cuando el comando nombra algo de bases, sale 2.
# «No pude correr el freno» no puede leerse igual que «lo corrí y estaba todo bien».
#
# TYCON_PROD_ROOT: raíz de sistema alternativa — se honra SÓLO si /opt/tycon no existe (pruebas). Con
# el freno instalado, una sesión hija que la pusiera apagaba el freno entero con un node y unas
# huellas propias (revisores del Step 5, 2026-09-15). `bash -p` ignora BASH_ENV/ENV/SHELLOPTS.
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
RAIZ=""
if [ ! -d /opt/tycon ] && [ -n "${TYCON_PROD_ROOT:-}" ]; then RAIZ="$TYCON_PROD_ROOT"; fi
NODE="$RAIZ/opt/tycon/bin/node"
HOOK="$RAIZ/opt/tycon/hooks/prod-access-guard.js"
HUELLAS="$RAIZ/opt/tycon/huellas.json"

ENTRADA="$(cat)"

# ¿el comando nombra algo de bases? (mismo criterio que el freno: ver CRUDO en prod-access-guard.js)
nombra_bases() {
  # Mismo criterio que CRUDO en prod-access-guard.js, que lo DERIVA de su lista de clientes. Acá no se
  # puede derivar (bash, y justo cuando node no está), así que lo sostiene un caso de la suite que
  # prueba CADA cliente de esa lista de los dos lados: si alguien suma un cliente allá y no acá, se
  # pone rojo. Eran dos listas a mano y ya se habían separado (pase adversarial 2026-09-15).
  printf '%s' "$ENTRADA" | grep -qiE '(^|[^A-Za-z0-9_-])(sqlcmd|bcp|mssql-cli|sqlps|osql|tsql|mssql|usql|invoke-sqlcmd|sqlpackage)([^A-Za-z0-9_-]|$)|SQLCMDSERVER[[:space:]]*=|MSSQL_HOST[[:space:]]*=|PGHOST[[:space:]]*=|DBSERVER[[:space:]]*=|(^|[^A-Za-z0-9_])Server[[:space:]]*=|Data[[:space:]]+Source[[:space:]]*=|Addr(ess)?[[:space:]]*=|Network[[:space:]]+Address[[:space:]]*=|az[[:space:]]+sql|Microsoft\.Sql/servers|(jdbc:)?(sqlserver|mssql|tds)://|tycon-prod-sql|\.tycon/production\.json|production-(index|memory)\.json|\.tycon/produccion\.json|produccion-(indice|memoria)\.json|security[[:space:]]+(-i|find-|dump-keychain|export|[a-z-]*generic-password)'
}

frenar() {
  # 🔴 Queda constancia donde el aviso de arranque la lee. Sin esto, «el freno no se pudo ejecutar»
  # sólo existía en la pantalla del momento: se frenaba bien, pero nadie se enteraba de que el freno
  # está roto en esa máquina, que es el problema de fondo (revisores del Step 5, 2026-09-15).
  # la carpeta del estado: la regla de tycon-home.js stateDir (si existe ~/.tycon/state, la máquina vive ahí; story 8.23, tanda D)
  _estado="$HOME/.claude/.tycon-pipeline"; [ -d "$HOME/.tycon/state" ] && _estado="$HOME/.tycon/state"
  registro="$_estado/hook-errors.log"
  if mkdir -p "$(dirname "$registro")" 2>/dev/null; then
    printf '%s prod-access-guard (lanzador): %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$registro" 2>/dev/null || true
  fi
  printf '🛑 FRENO DE PRODUCCIÓN — no pude ejecutarlo y el comando nombra una base.\n\nMotivo: %s\n\n   Un freno que no corrió NO deja pasar. Reinstalá con scripts/production/install-guard.command\n' "$1" >&2
  exit 2
}

ok_o_frenar() { if nombra_bases; then frenar "$1"; else exit 0; fi }

[ -x "$NODE" ] || ok_o_frenar "no está el intérprete de root ($NODE)"
if [ -z "$RAIZ" ]; then
  [ "$(stat -f '%Su' "$NODE" 2>/dev/null)" = "root" ] || ok_o_frenar "el intérprete ($NODE) no es de root"
fi
[ -f "$HOOK" ] || ok_o_frenar "no está el freno ($HOOK)"

# La huella del intérprete: si no coincide, alguien lo cambió — y es de root, así que eso es grave.
#
# 🔴 Se extrae con grep, NO con sed: la clave del JSON es una RUTA, y sus barras rompían el `s///`
# de sed («bad flag in substitute command»). El efecto era el peor posible y no se veía: el shim
# creía que no había huella de referencia, así que NUNCA ejecutaba el freno y todo quedaba en manos
# de su propio filtro crudo. Lo cazó el pase adversarial del 2026-09-15; lo fija T33d, el control
# positivo que faltaba (los tres casos que había miraban sólo el camino de la falla).
if [ -f "$HUELLAS" ]; then
  esperada="$(grep -o "\"${NODE#$RAIZ}\"[[:space:]]*:[[:space:]]*\"[a-f0-9]\{64\}\"" "$HUELLAS" | grep -o '[a-f0-9]\{64\}' | head -1)"
  if [ -n "$esperada" ]; then
    real="$(shasum -a 256 "$NODE" 2>/dev/null | cut -d' ' -f1)"
    [ "$real" = "$esperada" ] || ok_o_frenar "el intérprete de root no coincide con su huella"
  else
    ok_o_frenar "no hay huella de referencia para el intérprete de root"
  fi
else
  ok_o_frenar "no está el archivo de huellas ($HUELLAS)"
fi

# 🔴 El reloj del lanzador. La herramienta le da al hook un tope de 10 s y un hook que NO contesta a
# tiempo DEJA PASAR: un `node` colgado (disco lento, un comando enorme, o un cuelgue provocado) se
# leería como «lo miré y estaba todo bien». El freno tiene su propio reloj de 5 s adentro; acá va el
# de afuera, por si ni siquiera llega a mirarlo. 7 s deja margen para responder antes de los 10.
# Revisores del Step 5, 2026-09-15.
RELOJ="${TYCON_PROD_SHIM_TIMEOUT:-7}"
# macOS NO trae `timeout` (medido: no está en /usr/bin), así que el vigía es un `sleep` propio.
printf '%s' "$ENTRADA" | TYCON_PROD_ROOT="$RAIZ" "$NODE" "$HOOK" &
pid=$!
( sleep "$RELOJ"; kill -9 "$pid" 2>/dev/null ) &
vigia=$!
# `2>/dev/null` en el `wait`: bash anuncia «Killed: 9» al cosechar el trabajo, y ese ruido saldría
# por el mismo canal que el motivo del freno (medido).
wait "$pid" 2>/dev/null; rc=$?
kill "$vigia" 2>/dev/null; wait "$vigia" 2>/dev/null
# 137 = lo mató el vigía (9); 143 = una señal de afuera. En los dos casos el freno NO contestó.
case "$rc" in
  137|143) ok_o_frenar "el freno no contestó en ${RELOJ}s (se quedó sin tiempo)" ;;
esac
# El veredicto del freno pasa tal cual (0 deja pasar, 2 frena). Cualquier otro código es que el
# intérprete se cayó (1, 134, 137…), y la herramienta DEJA PASAR ante un hook que no sale 2: con un
# comando que nombra bases, eso no puede leerse como «estaba todo bien» (revisores del Step 5).
case "$rc" in
  0|2) exit "$rc" ;;
  *) ok_o_frenar "el freno terminó con un error propio (código $rc)" ;;
esac
