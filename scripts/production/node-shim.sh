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
ENTRADA=""

# ¿el comando nombra algo de bases? (mismo criterio que el freno: ver CRUDO en prod-access-guard.js)
nombra_bases() {
  # Mismo criterio que CRUDO en prod-access-guard.js, que lo DERIVA de su lista de clientes. Acá no se
  # puede derivar (bash, y justo cuando node no está), así que lo sostiene un caso de la suite que
  # prueba CADA cliente de esa lista de los dos lados: si alguien suma un cliente allá y no acá, se
  # pone rojo. Eran dos listas a mano y ya se habían separado (pase adversarial 2026-09-15).
  printf '%s' "$ENTRADA" | grep -qiE '(^|[^A-Za-z0-9_-])(sqlcmd|bcp|mssql-cli|sqlps|osql|tsql|mssql|usql|invoke-sqlcmd|sqlpackage)([^A-Za-z0-9_-]|$)|SQLCMDSERVER[[:space:]]*=|MSSQL_HOST[[:space:]]*=|PGHOST[[:space:]]*=|DBSERVER[[:space:]]*=|(^|[^A-Za-z0-9_])Server[[:space:]]*=|Data[[:space:]]+Source[[:space:]]*=|Addr(ess)?[[:space:]]*=|Network[[:space:]]+Address[[:space:]]*=|az[[:space:]]+sql|Microsoft\.Sql/servers|(jdbc:)?(sqlserver|mssql|tds)://|tycon-prod-sql|\.tycon/production\.json|production-(index|memory)\.json|\.tycon/produccion\.json|produccion-(indice|memoria)\.json|security[[:space:]]+(-i|find-|dump-keychain|export|[a-z-]*generic-password)'
}

# ¿el comando borra un grupo, un candado o un recurso de Azure? (mismo criterio que nombraBorradoAzure() en prod-access-guard.js;
# la T18 de prod-guard-azure-delete.test.sh compara los dos). Va aparte de nombra_bases(), que fija la T27.
nombra_borrado() {
  # el separador incluye `\n`, `\t` y `\r` escritos (el lanzador lee el JSON crudo del evento), y cada palabra puede venir
  # entre comillas, con su escape del JSON. El patrón va en un heredoc entre comillas: lleva comillas simples.
  IFS= read -r _patron <<'PATRON'
(^|[^A-Za-z0-9_.-]|\\[ntr]|[\\\"'])az(\.cmd|\.exe)?[\\\"']*(([[:space:]]|\\[ntr])[^;|&]*)?([[:space:]]|\\[ntr])[\\\"']*(group|lock|resource)[\\\"']*([[:space:]]|\\[ntr])([^;|&]*([[:space:]]|\\[ntr]))?[\\\"']*delete([^A-Za-z0-9_-]|$)|(^|[^A-Za-z0-9_.-]|\\[ntr]|[\\\"'])az(\.cmd|\.exe)?[\\\"']*(([[:space:]]|\\[ntr])[^;|&]*)?([[:space:]]|\\[ntr])[\\\"']*rest[\\\"']*([[:space:]]|\\[ntr])([^;|&]*([[:space:]]|\\[ntr]))?(--m[a-z]*|-m)[^A-Za-z0-9]{0,4}delete([^A-Za-z0-9_-]|$)|(^|[^A-Za-z0-9_.-]|\\[ntr])azd(\.exe)?([[:space:]]|\\[ntr])+down([^A-Za-z0-9_-]|$)|Remove-Az(ResourceGroup|ResourceLock|Resource|SqlServer|SqlDatabase)([^A-Za-z0-9_]|$)|Invoke-AzRestMethod[^;|&]*[[:space:]]-M[a-z]*[^A-Za-z0-9$]{1,4}(delete([^A-Za-z0-9_-]|$)|\$)|Invoke-AzRestMethod[^;|&]*[[:space:]]@[A-Za-z_]
PATRON
  printf '%s' "$ENTRADA" | grep -qiE "$_patron"
}

registro_de() {
  # la carpeta del estado: la regla de tycon-home.js stateDir (si existe ~/.tycon/state, la máquina vive ahí; story 8.23, tanda D)
  _estado="$HOME/.claude/.tycon-pipeline"; [ -d "$HOME/.tycon/state" ] && _estado="$HOME/.tycon/state"
  printf '%s' "$_estado/hook-errors.log"
}

frenar() { # $1 = encabezado · $2 = motivo · $3 = qué hacer
  # 🔴 Queda constancia donde el aviso de arranque la lee. Sin esto, «el freno no se pudo ejecutar»
  # sólo existía en la pantalla del momento: se frenaba bien, pero nadie se enteraba de que el freno
  # está roto en esa máquina, que es el problema de fondo (revisores del Step 5, 2026-09-15).
  registro="$(registro_de)"
  if mkdir -p "$(dirname "$registro")" 2>/dev/null; then
    printf '%s prod-access-guard (lanzador): %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" >> "$registro" 2>/dev/null || true
  fi
  printf '🛑 FRENO DE PRODUCCIÓN — %s\n\nMotivo: %s\n\n   %s\n' "$1" "$2" "$3" >&2
  exit 2
}

# Un problema de instalación: frena sólo lo que nombra una base. Frenar todo dejaría la máquina sin terminal hasta reinstalar.
ok_o_frenar() {
  if nombra_bases || nombra_borrado; then
    frenar "no pude ejecutarlo y el comando nombra una base." "$1" "Un freno que no corrió NO deja pasar. Reinstalá con scripts/production/install-guard.command"
  else exit 0; fi
}

# 🔴 El freno no contestó (tiempo, señal o un código propio): se frena TODO comando, nombre bases o no. El freno juzga
# también lo que el comando ejecuta por dentro (un guion, `bash -c`, un heredoc) y eso `nombra_bases` no lo ve: dejar
# pasar lo que no nombra bases abría un hueco. Un freno de seguridad falla cerrado.
sin_decidir() { # $1 = motivo
  # `disown` antes de matar: si no, bash anuncia «Killed: 9» por stderr antes del cartel
  [ -n "${pid:-}" ] && { disown "$pid" 2>/dev/null; matar_arbol "$pid"; }
  _que="Suele ser la carga de la máquina: reintentá en un momento. Queda constancia en $(registro_de)."
  [ "${VIEJAS:-}" = 1 ] && _que="$_que Y reinstalá el freno (scripts/production/install-guard.command): trae los datos del intérprete y deja de leerlo entero en cada comando."
  frenar "el freno no pudo decidir, así que el comando no corre." "$1" "$_que"
}

# Mata un proceso y todo lo que arrancó, sin esperarlos: uno trabado en el disco no muere hasta que vuelve la E/S, y
# esperarlo es justo lo que no puede hacer el lanzador.
matar_arbol() { for _h in $(pgrep -P "$1" 2>/dev/null); do matar_arbol "$_h"; done; kill -9 "$1" 2>/dev/null; }

# Los datos del archivo sin leerlo: dueño, permisos, tamaño, fecha e inode. GNU primero (donde corren las pruebas de
# noche): el `stat -f` de GNU no falla callado, imprime el sistema de archivos antes de quejarse.
datos_de() { stat -c '%u %a %s %Y %i' "$1" 2>/dev/null || stat -f '%u %Lp %z %m %i' "$1" 2>/dev/null; }

# Los datos que el instalador anotó para el intérprete (`__stat` de huellas.json, un objeto en una línea). Vacío si
# huellas.json es de antes de que se anotaran.
datos_anotados() {
  grep -o "\"${NODE#$RAIZ}\"[[:space:]]*:[[:space:]]*{[^}]*}" "$HUELLAS" 2>/dev/null | head -1 \
    | sed -nE 's/.*"uid":[[:space:]]*([0-9]+).*"mode":[[:space:]]*"([0-7]+)".*"size":[[:space:]]*([0-9]+).*"mtime":[[:space:]]*([0-9]+).*"inode":[[:space:]]*([0-9]+).*/\1 \2 \3 \4 \5/p'
}

# Todo lo que puede tardar: leer la entrada, verificar el intérprete y correr el freno. Corre de fondo para que el reloj
# lo pueda cortar (un `$(cat)` en primer plano no se interrumpe: una entrada que no se cierra retenía al lanzador).
trabajo() {
  ENTRADA="$(cat)"
  [ -x "$NODE" ] || ok_o_frenar "no está el intérprete de root ($NODE)"
  datos="$(datos_de "$NODE")"
  if [ -z "$RAIZ" ]; then
    [ "${datos%% *}" = 0 ] || ok_o_frenar "el intérprete ($NODE) no es de root"
  fi
  modo="$(printf '%s' "$datos" | cut -d' ' -f2)"
  case "${modo: -2}" in *[2367]*) ok_o_frenar "el intérprete ($NODE) lo puede escribir alguien más que su dueño" ;; esac
  [ -f "$HOOK" ] || ok_o_frenar "no está el freno ($HOOK)"
  [ -f "$HUELLAS" ] || ok_o_frenar "no está el archivo de huellas ($HUELLAS)"

  # Con los datos anotados, se comparan sin leer el binario (122 MB: bajo carga, segundos en cada comando). Cambiar el
  # binario sin cambiar sus datos pide root, y con root el freno no protege nada de todos modos.
  anotados="$(datos_anotados)"
  if [ -n "$anotados" ]; then
    [ "$anotados" = "$datos" ] || ok_o_frenar "el intérprete de root no coincide con sus datos anotados (dueño, permisos, tamaño, fecha o inode)"
  else
    # huellas.json viejo: la huella completa, como antes, pero dentro del reloj.
    # 🔴 Se extrae con grep, NO con sed: la clave del JSON es una RUTA, y sus barras rompían el `s///`
    # de sed («bad flag in substitute command»). El efecto era el peor posible y no se veía: el shim
    # creía que no había huella de referencia, así que NUNCA ejecutaba el freno y todo quedaba en manos
    # de su propio filtro crudo. Lo cazó el pase adversarial del 2026-09-15; lo fija T33d.
    esperada="$(grep -o "\"${NODE#$RAIZ}\"[[:space:]]*:[[:space:]]*\"[a-f0-9]\{64\}\"" "$HUELLAS" | grep -o '[a-f0-9]\{64\}' | head -1)"
    [ -n "$esperada" ] || ok_o_frenar "no hay huella de referencia para el intérprete de root"
    real="$(shasum -a 256 "$NODE" 2>/dev/null | cut -d' ' -f1)"
    [ "$real" = "$esperada" ] || ok_o_frenar "el intérprete de root no coincide con su huella"
  fi
  printf '%s' "$ENTRADA" | TYCON_PROD_ROOT="$RAIZ" exec "$NODE" "$HOOK"
}

# 🔴 El reloj del lanzador cubre TODO su trabajo y se mide desde que arranca. Un hook que no contesta antes del tope de
# Claude Code DEJA PASAR el comando: el corte por tiempo no bloquea. Bajo carga, leer el intérprete entero ya pasa ese
# tope. `TYCON_PROD_SHIM_TIMEOUT` es el presupuesto entero; el tope del hook en la plantilla es al menos el doble (T33k).
# macOS NO trae `timeout` (medido: no está en /usr/bin), así que el vigía es un `sleep` propio. Avisa con una señal que
# el lanzador atrapa: `wait` vuelve al instante, sin esperar a que muera lo que quedó trabado (un `$(…)` en primer plano
# no se interrumpe). Su salida va a /dev/null para no retener los caños del hook.
# 🔴 Bash no puede atrapar una señal que le llega ignorada: con USR1 ignorada desde el arranque, el reloj quedaba muerto
# y el freno colgado dejaba pasar el comando. Se usa la primera que se pueda atrapar; si no queda
# ninguna, el vigía mata el trabajo él mismo y `wait` vuelve con 137.
RELOJ="${TYCON_PROD_SHIM_TIMEOUT:-7}"
SENAL=""
for _s in USR1 USR2 ALRM; do
  trap 'sin_decidir "el freno no contestó en ${RELOJ}s (se quedó sin tiempo)"' "$_s"
  # desde bash 5.1, `trap -p` muestra también la señal que llegó ignorada (`trap -- '' SIGUSR1`): vale sólo si quedó la nuestra
  case "$(trap -p "$_s")" in *sin_decidir*) SENAL="$_s"; break ;; esac
done

# `<&0`: sin redirección explícita, bash le da /dev/null como entrada a un trabajo de fondo.
trabajo <&0 &
pid=$!
if [ -n "$SENAL" ]; then
  ( exec >/dev/null 2>&1 </dev/null; sleep "$RELOJ"; kill -"$SENAL" $$ ) &
else
  ( exec >/dev/null 2>&1 </dev/null; sleep "$RELOJ"; matar_arbol "$pid" ) &
fi
vigia=$!

# ¿huellas.json es de antes de los datos del intérprete? Lo dice el cartel si se acaba el tiempo.
VIEJAS=0
( grep -q '"__stat"' "$HUELLAS" 2>/dev/null ) & wait $! || VIEJAS=1

# `2>/dev/null` en el `wait`: bash anuncia «Killed: 9» al cosechar el trabajo, y ese ruido saldría
# por el mismo canal que el motivo del freno (medido).
wait "$pid" 2>/dev/null; rc=$?
[ -n "$SENAL" ] && trap '' "$SENAL"
disown "$vigia" 2>/dev/null; matar_arbol "$vigia"
pid=""
# 137 y 143 = una señal mató al freno: no contestó.
case "$rc" in
  137|143) sin_decidir "el freno no contestó en ${RELOJ}s (se quedó sin tiempo)" ;;
esac
# El veredicto del freno pasa tal cual (0 deja pasar, 2 frena). Cualquier otro código es que el intérprete se cayó (1,
# 134…), y la herramienta DEJA PASAR ante un hook que no sale 2: eso no puede leerse como «estaba todo bien».
case "$rc" in
  0|2) exit "$rc" ;;
  *) sin_decidir "el freno terminó con un error propio (código $rc)" ;;
esac

