#!/usr/bin/env bash
#
# harness-bootstrap-heal.sh — repara la LÍNEA DE ARRANQUE del arnés (SessionStart).
#
# El problema que resuelve:
#
#   Todo el arnés se propaga por `git pull` + `install-tycon-hooks.sh`, y esa segunda mitad la
#   dispara UNA línea del settings.json de cada dev. Las instalaciones viejas tienen una variante
#   de esa línea que hace los `git pull` pero NO llama al instalador. Consecuencia: esa máquina
#   BAJA todo el código nuevo del arnés y no ENCHUFA nada. Nunca. Esa máquina queda con
#   controles de menos, con el clon al día y los archivos presentes en el disco.
#
#   Y no hay forma de que se arregle solo: el arreglo de un hook viaja por el pull, pero el
#   arreglo de "no se llama al instalador" NO puede viajar por el instalador que no se llama. El
#   INSTALL.md propone "corré esto una vez a mano" — que es exactamente
#   lo que nadie hace.
#
# La salida es entrar por una puerta que esas máquinas SÍ tienen abierta: los hooks que ya están
# registrados y viven en este repo (los llama por path), porque su código sí se actualiza con el
# `git pull` que esas máquinas sí hacen. Este script se invoca desde ellos.
#
# Qué hace, en orden:
#   1. Si alguna línea de arranque ya llama al instalador → sale en silencio (caso sano, un grep).
#   2. Si no: le AGREGA la llamada a la línea que ya tiene (no la reescribe — respeta lo que el dev
#      haya puesto ahí), con backup previo y escritura atómica (bajo harness.js el backup es la copia del mecanismo:
#      con TYCON_HARNESS_SNAPSHOT_DIR puesta no deja `.bak` propio).
#   3. Corre el instalador una vez, para que la sesión actual no tenga que esperar a la siguiente.
#
# Fail-open TOTAL: cualquier error sale 0. Nunca rompe el arranque de una sesión.
# Off: TYCON_NO_BOOTSTRAP_HEAL=1
#
set +e
[ "${TYCON_NO_BOOTSTRAP_HEAL:-}" = "1" ] && exit 0

TCG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
[ -z "$TCG_ROOT" ] && exit 0
INSTALLER="$TCG_ROOT/scripts/install-tycon-hooks.sh"
[ -f "$INSTALLER" ] || exit 0

SETTINGS="${TYCON_SETTINGS_PATH:-$HOME/.claude/settings.json}"
[ -f "$SETTINGS" ] || exit 0
# una máquina cuyo estado dice que NO enchufa a Claude Code (tools sin «claude») no recibe su línea
# de arranque desde el hook de Codex: si no, la primera sesión de Codex re-enchufaría a Claude Code
# (con el Node del arnés si está; si no, el del PATH)
# con el bash de la Mac (3.2) y `set -e`, un `.` que no encuentra el archivo corta el guion aunque lleve `||`: se mira antes
_hn="$TCG_ROOT/scripts/lib/harness-node.sh"
{ [ -f "$_hn" ] && . "$_hn" 2>/dev/null; } || harness_node_bin() { echo node; }
HNODE="$(harness_node_bin)"
if command -v "$HNODE" >/dev/null 2>&1; then
  _TOOLS="$("$HNODE" -e 'try{const th=require(process.argv[1]);const fs=require("fs"),path=require("path");const st=JSON.parse(fs.readFileSync(path.join(th.stateDir(require("os").homedir()),"harness-state.json"),"utf8"));process.stdout.write(Array.isArray(st.tools)?st.tools.join(","):"")}catch(e){}' "$TCG_ROOT/scripts/setup/harness/tycon-home.js" 2>/dev/null)"
  case ",${_TOOLS}," in *,claude,*) ;; ,,) ;; *) exit 0 ;; esac
fi

# Sin guarda por grep: "install-tycon-hooks"
# puede aparecer en el settings SIN estar en la línea de arranque — p.ej. como permiso Bash en
# permissions.allow tras correr el instalador a mano — y el grep daría esa máquina por sana PARA
# SIEMPRE. El único juez es el JSON: qué hay en los hooks de SessionStart. El costo es levantar
# python en cada arranque (~40 ms), y la corrección lo vale.

RESULT=$(SETTINGS="$SETTINGS" INSTALLER="$INSTALLER" python3 - <<'PY' 2>/dev/null
import json, os, shutil, tempfile, time, sys

settings_path = os.environ["SETTINGS"]
installer = os.environ["INSTALLER"]
call = f'bash "{installer}" 2>/dev/null || true'  # comillas: un path con espacios moría tragado por el || true (A3)

try:
    with open(settings_path, encoding="utf-8") as f:
        s = json.load(f)
except Exception:
    sys.exit(0)  # settings ilegible → no es nuestro problema arreglarlo acá

hooks = s.setdefault("hooks", {})
ss = hooks.setdefault("SessionStart", [])

# ¿Ya sano? (el grep de arriba ya lo dijo, pero el JSON manda). Desde la story 8.13 (tanda A) la línea de arranque nueva
# llama a la copia fija `~/.claude/.tycon-pipeline/harness/bootstrap.js`, que corre el aplicador ella misma: también es sana,
# y pegarle la llamada al instalador sería volver a la forma «heal-appended» que la migración después tiene que deshacer.
for h in ss:
    for c in h.get("hooks", []):
        cmd = c.get("command", "")
        if "install-tycon-hooks" in cmd or ".tycon-pipeline/harness/bootstrap.js" in cmd:
            sys.exit(0)

# Buscar la línea de arranque: la que hace los git pull del arnés.
target = None
for h in ss:
    for c in h.get("hooks", []):
        cmd = c.get("command", "")
        import re as _re
        if "tycon-claude-guides" in cmd and ("git pull" in cmd or _re.search(r"git\s+-C\s+\S+\s+pull", cmd)):
            target = c
            break
    if target:
        break

if target is not None:
    # APPEND, no reescritura: lo que el dev haya agregado a esa línea se conserva.
    # 🔴 Con SALTO DE LÍNEA, no con ";" (hallazgos A1/A2 de la revisión adversarial 2026-08-27):
    # una línea del dev que termina en `&` producía `… &; bash …` — syntax error que mataba la
    # línea ENTERA (pulls incluidos) en cada arranque futuro, con el guard dándola por sana; y una
    # que termina en comentario `# …` dejaba el append DENTRO del comentario: instalador corrido
    # 0 veces, también "sana" para siempre. El salto de línea cierra los dos: termina un
    # comentario, termina un background, y no necesita `;`.
    target["command"] = target["command"].rstrip() + "\n" + call
    modo = "agregado a la línea existente"
else:
    # No hay línea de arranque del arnés → se crea una mínima (sólo la llamada).
    ss.append({"hooks": [{"type": "command", "command": call}]})
    modo = "creada la línea que faltaba"

try:
    # Bajo harness.js (story 8.13, AC 18: TYCON_HARNESS_SNAPSHOT_DIR puesta) la copia de settings.json ya la tomó el
    # mecanismo antes de correr: un .bak más sería la pila sin tope que la 8.13 vino a cerrar. Suelto, el de siempre.
    if not os.environ.get("TYCON_HARNESS_SNAPSHOT_DIR"):
        shutil.copy2(settings_path, f"{settings_path}.bak.{time.strftime('%Y-%m-%dT%H-%M-%S')}")
    fd, tmp = tempfile.mkstemp(prefix=".settings.", dir=os.path.dirname(settings_path))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, settings_path)
except Exception:
    sys.exit(0)

print(modo)
PY
)

[ -z "$RESULT" ] && exit 0

# El instalador corre ANTES del anuncio: anunciar "se corrió" y que después falle es mentir.
if [ "${TYCON_NO_AUTOINSTALL:-}" = "1" ]; then
  CORRIDA="el instalador corre en el próximo arranque (TYCON_NO_AUTOINSTALL=1)"
elif bash "$INSTALLER" 2>/dev/null; then
  CORRIDA="y el instalador ya corrió"
else
  CORRIDA="el instalador falló en esta corrida — vuelve a intentar en el próximo arranque"
fi

echo "🔧 TYCON — tu línea de arranque no llamaba al instalador del arnés, así que bajabas las"
echo "   actualizaciones pero no se enchufaban. Ya está reparada ($RESULT); $CORRIDA."
echo "   Los controles que faltaban quedan activos al abrir la próxima sesión."
exit 0
