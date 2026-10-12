#!/bin/bash
# install-guard.command — abrilo con DOBLE CLIC para instalar (o actualizar) el freno de producción.
# (Hasta la story 8.9 se llamaba instalar-freno.command: en la ruta vieja queda un reemplazo que abre éste.)
#
# Pide tu contraseña del Mac una vez: el freno vive en carpetas de root, que es lo único que el
# asistente no puede tocar. Al terminar cierra la caché de sudo.
#
# NOTA (2026-09-15): la story pedía una «plantilla» de este archivo porque la versión anterior tenía
# rutas adentro. No hace falta: este .command resuelve su propia carpeta, así que vive en el repo tal
# cual y se abre desde ahí. Queda escrito para que nadie busque la plantilla que no existe.
cd "$(dirname "$0")" || exit 1
clear
echo "Freno de producción del arnés TYCON"
echo "   Esto instala en carpetas de root: /opt/tycon y la configuración administrada de Claude Code."
echo "   Sólo lo corren quienes están autorizados a tocar producción."
echo
read -r -p "¿Sigo? (s/n) " r
case "$r" in s|S|si|SI|sí|y|Y) ;; *) echo "cancelado"; read -r -p "Enter para cerrar"; exit 0 ;; esac
echo
sudo bash "./install-guard.sh" "$@"
rc=$?
echo
[ "$rc" -eq 0 ] || echo "⛔ la instalación falló (código $rc): copiá lo de arriba y pedile ayuda al arnés."
echo "Los hooks nuevos quedan activos en la SIGUIENTE sesión de Claude Code."
read -r -p "Enter para cerrar"
exit "$rc"
