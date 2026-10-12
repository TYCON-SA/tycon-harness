#!/usr/bin/env bash
# meter-backup.sh —¿tiene que correr el RESPALDO local del medidor de etapas del SDLC?
#
# El punto del día lo escribe el nocturno de ADO (06:00 UTC = 03:00 Argentina). La corrida local
# es un respaldo para cuando el nocturno falló o el repo no tiene red. Esta función decide, y vive
# aparte del instalador para poder probarse sin correr el instalador
# (scripts/tests/meter-backup.test.sh).
#
# 🔴 Por qué mira la HORA y no sólo «¿existe el archivo?» (2026-09-06): la primera versión lanzaba
# el respaldo si el snapshot de hoy no había llegado con el pull. Pero antes de las 03:00 el archivo
# de hoy NUNCA está —el nocturno todavía no corrió—, así que en toda sesión de madrugada el respaldo
# corría aunque nada hubiera fallado, y a las 03:20 el nocturno commiteaba el suyo: dos escritores
# del mismo archivo, y el `git pull` de la mañana rebotando contra el suelto. Medido: sesión a las
# 01:38 → snapshot local a las 01:41. Antes de la hora del nocturno más un margen, la ausencia del
# archivo no es una falla: es que todavía no es la hora.
#
# Uso: respaldo_medidor_debe_correr <hora_local_HH> <existe_snapshot_de_hoy 0|1> <sello_es_de_hoy 0|1>
#   sale 0 = correr · 1 = no correr
# (lo sourcea install-tycon-hooks.sh)

# Hora local (Argentina) a partir de la cual el nocturno ya tuvo su oportunidad: corre a las 03:00
# y tarda minutos; el margen cubre una corrida lenta o encolada.
RESPALDO_MEDIDOR_DESDE_HORA="${RESPALDO_MEDIDOR_DESDE_HORA:-05}"

respaldo_medidor_debe_correr() {
  local hora="$1" existe="$2" sello_hoy="$3"
  [ "$existe" = "1" ] && return 1        # ya llegó con el pull: escritor único
  [ "$sello_hoy" = "1" ] && return 1     # ya se lanzó hoy: no se reintenta en loop
  # 10# fuerza base decimal: «08» y «09» son octales inválidos para bash sin eso
  [ $((10#$hora)) -lt $((10#$RESPALDO_MEDIDOR_DESDE_HORA)) ] && return 1   # el nocturno no tuvo su oportunidad
  return 0
}
