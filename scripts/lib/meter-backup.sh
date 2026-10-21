#!/usr/bin/env bash
# meter-backup.sh —¿tiene que correr el RESPALDO local del medidor de etapas del SDLC?
#
# El punto del día lo escribe el nocturno de ADO (06:00 UTC = 03:00 Argentina). La corrida local
# es un respaldo para cuando el nocturno falló o el repo no tiene red. Esta función decide, y vive
# aparte del instalador para poder probarse sin correr el instalador
# (scripts/tests/meter-backup.test.sh).
#
# 🔴 Por qué mira la HORA y no sólo «¿existe el archivo?»: lanzar el respaldo si el snapshot de hoy no llegó con el
# pull es un error, porque antes de las 03:00 el archivo de hoy NUNCA está —el nocturno todavía no corrió—. En toda
# sesión de madrugada el respaldo correría aunque nada hubiera fallado, y a las 03:20 el nocturno commitearía el
# suyo: dos escritores del mismo archivo, y el `git pull` de la mañana rebotando contra el suelto. Antes de la hora
# del nocturno más un margen, la ausencia del archivo no es una falla: es que todavía no es la hora.
#
# Uso: respaldo_medidor_debe_correr <hora_local_HH> <existe_snapshot_de_hoy 0|1> <sello_es_de_hoy 0|1>
#   sale 0 = correr · 1 = no correr
# (lo sourcea install-tycon-hooks.sh)

# Hora local (Argentina) a partir de la cual el nocturno ya tuvo su oportunidad: corre a las 03:00
# y tarda minutos; el margen cubre una corrida lenta o encolada.
RESPALDO_MEDIDOR_DESDE_HORA="${RESPALDO_MEDIDOR_DESDE_HORA:-05}"

# 🔴 El respaldo escribe en el árbol del arnés, así que sólo tiene sentido donde ese árbol es un CLON.
# En una versión instalada el árbol no es un clon: la foto del día en `<árbol>/.dashboard/` ahí no existe nunca, y el
# respaldo correría todos los días, barrería la carpeta madre del árbol (sin repos) y dejaría una foto vacía con el
# mismo nombre que la del nocturno. En el clon donde el nocturno deja la suya, esa foto la pisa o traba el `pull`
# siguiente. El punto del día es del nocturno: donde el arnés
# no es un clon, no hay respaldo.
#
# Uso: meter_backup_has_own_tree <raíz del árbol del arnés>     sale 0 = es un clon (aplica) · 1 = no aplica
meter_backup_has_own_tree() {
  local tree="${1:-}"
  [ -n "$tree" ] || return 1
  [ -e "$tree/.git" ] || return 1     # carpeta en un clon, archivo en un árbol enlazado
  return 0
}

respaldo_medidor_debe_correr() {
  local hora="$1" existe="$2" sello_hoy="$3"
  [ "$existe" = "1" ] && return 1        # ya llegó con el pull: escritor único
  [ "$sello_hoy" = "1" ] && return 1     # ya se lanzó hoy: no se reintenta en loop
  # 10# fuerza base decimal: «08» y «09» son octales inválidos para bash sin eso
  [ $((10#$hora)) -lt $((10#$RESPALDO_MEDIDOR_DESDE_HORA)) ] && return 1   # el nocturno no tuvo su oportunidad
  return 0
}
