#!/usr/bin/env bash
# harness-doctor.test.sh — `harness.js doctor` mínimo de la tanda A (story 8.13 · T13, la parte del diagnóstico; la B
# completa el doctor con el registro de piezas: T19).
#
# Lo que no se puede perder:
#   · `doctor` es de sólo lectura: el HOME queda idéntico por hash (la única excepción, `--fetch`, escribe FETCH_HEAD).
#   · La primera línea dice el modo. Sin estado dice «no instalado» y sale 3; con un estado ilegible lo dice en rojo.
#   · En un clon interno (el árbol NO trae `scripts/setup/public-remotes.json`) y la política en `ask` avisa «una máquina
#     del equipo sin el perfil» (`TYCON_PROFILE=0`, perfil no resuelto); con `auto` no. Una copia cuyo remoto no es el
#     público (un fork, o servida desde una carpeta) trae la lista: no recibe ese aviso, sólo que su remoto no es el
#     público. `--json` trae `fail`/`warn`/`ok` y no tiene `fail` en una instalación sana.
#   · Compara la copia fija de arranque con el estado y con el árbol (al día / vieja), el enlace y el `origin` de cada
#     fuente contra `sources[].url`.
#   · Lo que dice de un HEAD que no es el commit registrado es CIERTO, también en una copia pública: si promete que
#     `update` lo re-registra, `update` lo re-registra; con commits propios no lo promete, y el comando que aconseja se
#     puede correr.
#   · (story 8.18, T38) En las tres formas de máquina que deja la unión de los dos repos —dos clones sin re-apuntar, dos
#     clones con el viejo re-apuntado al repo unificado, un solo árbol— doctor es verde, de sólo lectura y dice cuál es;
#     la llave prendida con la mudanza sin hacer es un aviso; y lo publicado sin skills (AC 34), otro, con lo que hay.
#   · (story 8.18, REPEATED) Los hooks del arnés que una máquina ya tiene registrados más de una vez: doctor lo dice UNA
#     vez, como dato, con la cuenta y cómo sacarlos a mano; no toca settings.json ni pone el diagnóstico en rojo.
#   · (story 8.18, REPEATED-CASE) …también cuando la segunda ruta es la misma carpeta escrita con otras mayúsculas, en
#     un disco que no las distingue: se compara qué archivo es, no cómo está escrita la ruta.
#   · T97 (story 8.17, tanda W3a): dice cuántos controles ESPERADOS —los de la lista del aplicador para esta plataforma y
#     esta configuración— faltan en settings.json y cuáles; es un aviso, nunca un rojo (tampoco bajo la comprobación de
#     salud), y sigue sin escribir nada.
#   · T6 (story 8.13.1, tanda A · AC 5): en una máquina con capa, doctor prueba sin escribir que público + capa = interno
#     (lo que falta, lo editado a mano, lo que no viene de ninguna fuente; lo ignorado y los escritores no cuentan), la
#     compatibilidad por la lista de transformados, el rojo de un version.json sin esa lista, no_push y pre-push sólo en
#     un árbol gestionado, y la capa al mínimo con las horas. `layer --check` es el mismo chequeo (0 / 1 / 3), y con
#     `--public` y `--harness-clone` calcula contra lo que le dan sin tocar el estado. Sin capa, doctor como siempre.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh. Nunca ~/.claude. 🔴 Sin pipes sobre el comando medido.
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" harness-doctor || exit 1
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$BASE"' EXIT   # (el servidor de versiones de juguete de T79, si quedó vivo)
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
jtxt() { python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print($1)" 2>/dev/null; }

harness_lab_create "$BASE/lab" >/dev/null
# sin estado: «no instalado», 3
SALIDA="$(harness doctor 2>&1)"; RC=$?
[ "$RC" = 3 ] && case "$SALIDA" in *"no instalado"*) ok "T13 sin estado: «no instalado» y 3" ;; *) mal "T13 sin estado no lo dice: $SALIDA" ;; esac || mal "T13 sin estado: rc $RC: $SALIDA"

harness install --yes >/dev/null 2>&1 || mal "T13 install previo falló"
# sólo lectura
ANTES="$(harness_lab_home_hash)"
SALIDA="$(harness doctor 2>&1)"; RC=$?
[ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "T13 doctor no escribe nada (HOME idéntico por hash)" || mal "T13 doctor escribió algo"
[ "$(printf '%s\n' "$SALIDA" | head -1 | grep -c managed)" = 1 ] && ok "T13 la primera línea dice el modo" || mal "T13 primera línea: $(printf '%s\n' "$SALIDA" | head -1)"
# interno + ask (TYCON_PROFILE=0 en el laboratorio) → aviso «máquina del equipo»; con auto, no
# (story 8.16: doctor dice siempre «perfil: …», así que acá se busca el aviso entero, no la palabra suelta)
case "$SALIDA" in *"máquina del equipo sin el perfil"*) ok "T13 remoto interno en ask: avisa la máquina del equipo sin el perfil" ;; *) mal "T13 no avisa el ask interno: $SALIDA" ;; esac
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && ok "T13 --json: sin fail en una instalación sana" || mal "T13 --json fail: $(printf '%s' "$JSON" | jtxt "d['fail']")"
[ "$(printf '%s' "$JSON" | jtxt "any('ask' in w or 'perfil' in w for w in d['warn'])")" = True ] && ok "T13 --json: el aviso del ask está en warn" || mal "T13 --json warn: $(printf '%s' "$JSON" | jtxt "d['warn']")"
# el espejo del fork de T37 (tanda D): un clon interno de verdad —el árbol NO trae la lista de remotos públicos—, en ask
# por defecto, trae el aviso «una máquina del equipo sin el perfil», como siempre
[ ! -e "$LAB_TREE/scripts/setup/public-remotes.json" ] && [ "$(printf '%s' "$JSON" | jtxt "any('máquina del equipo sin el perfil' in w for w in d['warn'])")" = True ] \
  && ok "T13 un árbol sin la lista de remotos públicos (clon interno), en ask por defecto: con el aviso «máquina del equipo sin el perfil»" || mal "T13 clon interno sin el aviso: $(printf '%s' "$JSON" | jtxt "d['warn']")"
JSON="$(TYCON_UPDATE_APPLY=auto harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('ask' in w for w in d['warn'])")" = False ] && ok "T13 con apply auto no avisa" || mal "T13 con auto avisa igual: $(printf '%s' "$JSON" | jtxt "d['warn']")"
# T40 (story 8.23, tanda L · AC 39): dos arranques que no pudieron actualizar → doctor lo dice como aviso, con la fecha
FALLA="$LAB_HOME/.claude/.tycon-pipeline/harness/update-failures.json"
printf '{"since":"2026-10-06T10:00:00.000Z","count":2,"reason":"sin red","last":"2026-10-06T11:00:00.000Z"}\n' > "$FALLA"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('no se pudo actualizar desde 2026-10-06' in w and 'sin red' in w for w in d['warn'])")" = True ] \
  && ok "T40 doctor dice «no se pudo actualizar desde <fecha>: <motivo>» como aviso" || mal "T40 doctor no lo dice: $(printf '%s' "$JSON" | jtxt "d['warn']")"
rm -f "$FALLA"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('no se pudo actualizar' in w for w in d['warn'])")" = False ] && ok "T40 sin falla anotada, doctor no lo dice" || mal "T40 lo dice sin falla"
# la copia fija: al día; vieja si el árbol cambió
[ "$(printf '%s' "$JSON" | jtxt "any('bootstrap' in o or 'copia fija' in o for o in d['ok'])")" = True ] && ok "T13 la copia fija está al día" || mal "T13 no dice nada de la copia fija: $JSON"
printf '// cambio\n' >> "$LAB_TREE/scripts/setup/harness/bootstrap.js"
SALIDA="$(harness doctor 2>&1)"
case "$SALIDA" in *"copia"*"viej"*|*"bootstrap"*"viej"*|*"bootstrap"*"difiere"*) ok "T13 con el árbol cambiado dice que la copia fija quedó vieja" ;; *) mal "T13 no detecta la copia fija vieja: $SALIDA" ;; esac
harness_lab_git "$LAB_TREE" checkout -q -- scripts/setup/harness/bootstrap.js 2>/dev/null || true
# el origin cambiado: rojo
harness_lab_git "$LAB_TREE" remote set-url origin "$LAB_REMOTE_TREE.otro"
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
[ "$RC" != 0 ] && [ "$(printf '%s' "$JSON" | jtxt "any('origen' in f or 'origin' in f for f in d['fail'])")" = True ] && ok "T13 origin cambiado: fail y rc ≠ 0" || mal "T13 origin cambiado: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
harness_lab_git "$LAB_TREE" remote set-url origin "$LAB_REMOTE_TREE"
# --fetch: la única escritura, FETCH_HEAD
ANTES="$(harness_lab_home_hash)"; rm -f "$LAB_TREE/.git/FETCH_HEAD"
harness doctor --fetch >/dev/null 2>&1
[ -f "$LAB_TREE/.git/FETCH_HEAD" ] && [ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "T13 --fetch escribe FETCH_HEAD y nada más del HOME" || mal "T13 --fetch: FETCH_HEAD=$([ -f "$LAB_TREE/.git/FETCH_HEAD" ] && echo sí || echo no)"
# ── T19 Doctor_ManagedVsMachine_ReadOnly_FetchIsTheException (tanda B · AC 16) ─────────────────────────────────────
# El registro de piezas (`managed`) contra la máquina: lo registrado que falta, lo del arnés sin registrar, el HEAD y el
# origin de cada fuente; y sigue sin escribir nada.
ESTADO="$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"
N="$(j "$ESTADO" "len(d.get('managed') or [])")"
[ "${N:-0}" -ge 1 ] 2>/dev/null && ok "T19 install dejó el registro de piezas ($N)" || mal "T19 install no registró piezas: managed=$(j "$ESTADO" "d.get('managed')")"
[ "$(j "$ESTADO" "all(p.get('version') for p in d['managed'])")" = True ] && ok "T19 cada pieza registrada lleva la versión que la puso" || mal "T19 piezas sin versión: $(j "$ESTADO" "d['managed']")"
[ "$(j "$ESTADO" "any(p['kind']=='hook' for p in d['managed'])")" = True ] && ok "T19 el hook del aplicador está registrado" || mal "T19 sin el hook del aplicador: $(j "$ESTADO" "d['managed']")"
SALIDA="$(harness doctor 2>&1)"; RC=$?
case "$SALIDA" in *"piezas, todas en su lugar"*) ok "T19 todo igual: «N piezas, todas en su lugar»" ;; *) mal "T19 todo igual no lo dice: $SALIDA" ;; esac
# una pieza registrada borrada a mano → aviso con apply
python3 - "$TYCON_SETTINGS_PATH" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
for ev, blocks in s.get("hooks", {}).items():
    for b in blocks: b["hooks"] = [h for h in b.get("hooks", []) if "lab-hook.js" not in h.get("command", "")]
    s["hooks"][ev] = [b for b in blocks if b["hooks"]]
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
ANTES="$(harness_lab_home_hash)"
SALIDA="$(harness doctor 2>&1)"
[ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "T19 doctor con una pieza faltante no escribe nada" || mal "T19 doctor escribió algo con una pieza faltante"
case "$SALIDA" in *"lab-hook.js"*"apply"*|*"apply"*"lab-hook.js"*) ok "T19 la pieza registrada que falta se avisa con apply" ;; *) mal "T19 no avisa la pieza que falta: $SALIDA" ;; esac
harness apply >/dev/null 2>&1 || mal "T19 apply falló"
SALIDA="$(harness doctor 2>&1)"
case "$SALIDA" in *"todas en su lugar"*) ok "T19 tras apply vuelve a estar todo en su lugar" ;; *) mal "T19 tras apply: $SALIDA" ;; esac
# del arnés y sin registrar: un hook que apunta al árbol y un bloque TYCON_BLOCK
printf '// hook del arnés sembrado a mano\n' > "$LAB_TREE/scripts/hooks/seeded-hook.js"
python3 - "$TYCON_SETTINGS_PATH" "$LAB_HOME/.claude/tycon-harness/scripts/hooks/seeded-hook.js" <<'PY'
import json, sys
p, hook = sys.argv[1], sys.argv[2]; s = json.load(open(p, encoding="utf-8"))
s.setdefault("hooks", {}).setdefault("PreToolUse", []).append({"matcher": "Bash", "hooks": [{"type": "command", "command": 'node "%s"' % hook}]})
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
printf '<!-- TYCON_BLOCK:seeded-block START -->\nregla sembrada\n<!-- TYCON_BLOCK:seeded-block END -->\n' >> "$CLAUDE_MD_PATH"
ANTES="$(harness_lab_home_hash)"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "T19 doctor con piezas sin registrar no escribe nada" || mal "T19 doctor escribió algo con piezas sin registrar"
[ "$(printf '%s' "$JSON" | jtxt "any('seeded-hook.js' in w for w in d['warn'])")" = False ] && ok "T19 un hook del árbol que el aplicador no conoce (lo registró otro instalador) no sale como sin registrar" || mal "T19 el hook de otro instalador sale como sin registrar: $(printf '%s' "$JSON" | jtxt "d['warn']")"
[ "$(printf '%s' "$JSON" | jtxt "any('sin registrar' in w and 'seeded-block' in w for w in d['warn'])")" = True ] && ok "T19 el bloque TYCON_BLOCK sin registrar se avisa" || mal "T19 bloque sin registrar: $(printf '%s' "$JSON" | jtxt "d['warn']")"
[ "$(printf '%s' "$JSON" | jtxt "any('sin registrar' in w and 'lab-hook.js' in w for w in d['warn'])")" = False ] && ok "T19 lo registrado no sale como sin registrar" || mal "T19 lo registrado sale como sin registrar"
# un hook que el aplicador SÍ conoce, presente y fuera del registro: «sin registrar: apply»
cp "$ESTADO" "$BASE/estado.json"
python3 - "$ESTADO" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p, encoding="utf-8"))
d["managed"] = [m for m in d["managed"] if "lab-hook.js" not in m["id"]]
json.dump(d, open(p, "w", encoding="utf-8"), indent=2)
PY
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('sin registrar' in w and 'lab-hook.js' in w and 'apply' in w for w in d['warn'])")" = True ] && ok "T19 el hook que el aplicador conoce y falta en el registro: «sin registrar: apply»" || mal "T19 hook conocido sin registrar: $(printf '%s' "$JSON" | jtxt "d['warn']")"
cp "$BASE/estado.json" "$ESTADO"
# lo sembrado se saca: los casos que siguen miden otra cosa
python3 - "$TYCON_SETTINGS_PATH" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
s["hooks"]["PreToolUse"] = [b for b in s["hooks"].get("PreToolUse", []) if not any("seeded-hook.js" in h.get("command", "") for h in b.get("hooks", []))]
if not s["hooks"]["PreToolUse"]: del s["hooks"]["PreToolUse"]
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
python3 - "$CLAUDE_MD_PATH" <<'PY'
import re, sys
p = sys.argv[1]; t = open(p, encoding="utf-8").read()
open(p, "w", encoding="utf-8").write(re.sub(r"<!-- TYCON_BLOCK:seeded-block START -->.*?<!-- TYCON_BLOCK:seeded-block END -->\n", "", t, flags=re.S))
PY
# HEAD distinto del commit registrado: rojo
harness_lab_git "$LAB_TREE" commit -q --allow-empty -m "commit a mano" >/dev/null
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
[ "$RC" != 0 ] && [ "$(printf '%s' "$JSON" | jtxt "any('HEAD' in f for f in d['fail'])")" = True ] && ok "T19 HEAD distinto de sources[].commit: rojo" || mal "T19 HEAD distinto: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
harness_lab_git "$LAB_TREE" reset -q --hard HEAD~1 >/dev/null
# los .bak del dev: los cuenta y dice que no los gestiona, sin tocarlos
printf '{}\n' > "$TYCON_SETTINGS_PATH.bak.2026-01-01T00-00-00"
printf 'viejo\n' > "$CLAUDE_MD_PATH.bak.2026-01-01T00-00-00"
ANTES="$(harness_lab_home_hash)"
SALIDA="$(harness doctor 2>&1)"
[ "$(harness_lab_home_hash)" = "$ANTES" ] && [ -f "$TYCON_SETTINGS_PATH.bak.2026-01-01T00-00-00" ] && ok "T19 los .bak quedan intactos" || mal "T19 doctor tocó los .bak"
case "$SALIDA" in *"2 copia"*".bak"*"no las gestiona"*|*".bak"*"2"*"no las gestiona"*) ok "T19 cuenta los .bak y dice que no los gestiona" ;; *) mal "T19 no cuenta los .bak: $SALIDA" ;; esac
# las piezas propias de harness.js (el @import, la copia fija): borradas a mano, apply no las repone → no se caen del
# registro y doctor remite a install (pase adversarial, iteración 2)
# (los dos nombres del lugar, de su constante: story 8.19)
PLACE_NAMES_RX="$(node -e 'const p=require(process.argv[1]); process.stdout.write(`(${p.LEGACY_PLACE_NAME}|${p.PLACE_NAME})`)' "$RAIZ/scripts/setup/harness/place.js")"
{ grep -v -E "${PLACE_NAMES_RX}/(README|INDEX).md" "$CLAUDE_MD_PATH" || true; } > "$BASE/claude.md"   # sin otras líneas, grep -v sale 1
cat "$BASE/claude.md" > "$CLAUDE_MD_PATH"
harness apply >/dev/null 2>&1 || mal "T19 apply falló sin el @import"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('import' in w and 'install' in w for w in d['warn'])")" = True ] && ok "T19 el @import borrado sigue registrado y doctor remite a install" || mal "T19 el @import borrado: $(printf '%s' "$JSON" | jtxt "d['warn']")"
harness install --yes >/dev/null 2>&1 || mal "T19 install falló al reponer el @import"
SALIDA="$(harness doctor 2>&1)"
case "$SALIDA" in *"todas en su lugar"*) ok "T19 install repone el @import: todo en su lugar" ;; *) mal "T19 tras install: $SALIDA" ;; esac
# HEAD movido a la punta de origin a mano (un pull, el respaldo en shell): rojo, y el siguiente update lo re-registra
harness_lab_publish tree "v2 a mano" VERSION 2
harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
[ "$RC" != 0 ] && [ "$(printf '%s' "$JSON" | jtxt "any('HEAD' in f for f in d['fail'])")" = True ] && ok "T19 HEAD en la punta de origin pero no registrado: rojo" || mal "T19 HEAD movido a mano: rc $RC"
# `update --check` sólo mira: no promete un re-registro que no graba (revisor de fallos silenciosos, iteración 2)
SALIDA="$(harness update --check 2>&1)"
case "$SALIDA" in *"commit re-registrado"*) mal "T19 update --check dice «re-registrado» sin grabarlo: $SALIDA" ;; *"re-registraría"*) ok "T19 update --check dice que se re-registraría, sin grabar" ;; *) mal "T19 update --check no dice nada del commit a re-registrar: $SALIDA" ;; esac
harness update --check >/dev/null 2>&1
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('HEAD' in f for f in d['fail'])")" = True ] && ok "T19 tras update --check el rojo sigue (no grabó nada)" || mal "T19 update --check grabó el re-registro"
harness update >/dev/null 2>&1
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
[ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | jtxt "any('HEAD' in f for f in d['fail'])")" = False ] && ok "T19 update re-registra el commit del clon que ya está en la punta de origin" || mal "T19 update no re-registró: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
# sin carpeta temporal usable, apply corre igual (sin reporte, el registro queda como estaba)
TMPDIR="$BASE/no-existe" harness apply >/dev/null 2>&1; RC=$?
[ "$RC" = 0 ] && ok "T19 apply sin carpeta temporal corre el aplicador igual" || mal "T19 apply sin carpeta temporal: rc $RC"
# una pieza propia que no es hook ni import (un archivo de la copia fija) que falta: aviso con install
mv "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh" "$BASE/fallback.sh"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('bootstrap-fallback.sh' in w and 'install' in w for w in d['warn'])")" = True ] && ok "T19 un archivo registrado de la copia fija que falta se avisa con install" || mal "T19 archivo de la copia fija: $(printf '%s' "$JSON" | jtxt "d['warn']")"
mv "$BASE/fallback.sh" "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh"
# tanda C (decisión 7 del dueño): la copia fija trae el programa entero —harness.js y scripts/setup/harness/*.js en
# program/—, igual al árbol, registrado como piezas propias; uno que falta es rojo de la copia fija y aviso con install
PROG="$LAB_HOME/.claude/.tycon-pipeline/harness/program"
PROG_OK=1
for f in "$LAB_TREE/scripts/setup/harness.js" "$LAB_TREE"/scripts/setup/harness/*.js; do
  rel="${f#$LAB_TREE/scripts/setup/}"
  cmp -s "$f" "$PROG/$rel" || { PROG_OK=0; mal "T24 la copia fija no trae program/${rel} igual al árbol"; }
done
[ "$PROG_OK" = 1 ] && ok "T24 la copia fija trae program/harness.js y program/harness/*.js iguales al árbol"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('copia fija' in o and 'al día' in o for o in d['ok'])")" = True ] && ok "T24 doctor: copia fija (con el programa) al día" || mal "T24 doctor no da la copia fija al día: $(printf '%s' "$JSON" | jtxt "d['fail']+d['warn']")"
mv "$PROG/harness/state.js" "$BASE/state.js"
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
[ "$RC" != 0 ] && [ "$(printf '%s' "$JSON" | jtxt "any('copia fija' in f and 'program/harness/state.js' in f for f in d['fail'])")" = True ] && ok "T24 un módulo de la copia fija que falta es rojo y lo nombra" || mal "T24 módulo faltante en la copia fija: rc $RC $(printf '%s' "$JSON" | jtxt "d['fail']")"
[ "$(printf '%s' "$JSON" | jtxt "any('program/harness/state.js' in w and 'install' in w for w in d['warn'])")" = True ] && ok "T24 …y como pieza registrada que falta, con install" || mal "T24 el módulo faltante no sale como pieza con install: $(printf '%s' "$JSON" | jtxt "d['warn']")"
mv "$BASE/state.js" "$PROG/harness/state.js"
# --fetch sigue siendo la única escritura (el caso de arriba, ahora con el registro lleno)
ANTES="$(harness_lab_home_hash)"; rm -f "$LAB_TREE/.git/FETCH_HEAD"
harness doctor --fetch >/dev/null 2>&1
[ -f "$LAB_TREE/.git/FETCH_HEAD" ] && [ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "T19 --fetch escribe FETCH_HEAD y nada más" || mal "T19 --fetch escribió otra cosa"

# ── T97 Doctor_MissingExpectedControls_WarnNeverFail_ReadOnly (story 8.17, tanda W3a · AC 70) ───────────────────────
# Un control que el aplicador CONOCE y nunca registró no está en el registro de piezas: doctor comparaba sólo lo
# registrado y decía «todas en su lugar» (pipeline 182: al instalador de Windows le faltaban 15 y doctor callaba).
# Acá el aplicador de juguete pasa a conocer un control más —una línea con la forma de su lista— que no registra.
# 🔴 rojo previo (medido): sin la cuenta de esperados, 5 MAL — doctor no decía cuántos controles esperados hay (las dos
#    líneas de «todos registrados»), ni nombraba `lab-expected.js` en un aviso (en JSON, en texto y bajo la salud).
esperados() { printf '%s' "$1" | jtxt "' | '.join(w for w in d['warn'] if 'esperado' in w)"; }
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
[ "$RC" = 0 ] && [ -z "$(esperados "$JSON")" ] && ok "T97 espejo: con todo lo esperado registrado, doctor no dice que falte nada" || mal "T97 espejo: rc $RC «$(esperados "$JSON")»"
[ "$(printf '%s' "$JSON" | jtxt "any('controles esperados: 1, todos registrados' in o for o in d['ok'])")" = True ] && ok "T97 espejo: dice cuántos controles esperados hay y que están todos" || mal "T97 espejo sin la línea de esperados: $(printf '%s' "$JSON" | jtxt "d['ok']")"
printf '\nLAB_SPEC_EXPECTED="PreToolUse|Bash|@tcg:lab-expected.js|control esperado de juguete que el aplicador no registra"\n' >> "$LAB_TREE/scripts/install-tycon-hooks.sh"
ANTES="$(harness_lab_home_hash)"
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
[ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "T97 doctor con un control esperado que falta no escribe nada (HOME idéntico por hash)" || mal "T97 doctor escribió algo"
case "$(esperados "$JSON")" in *"falta 1 de 2 controles esperados"*"lab-expected.js"*) ok "T97 el control esperado que falta se avisa con la cuenta y el nombre" ;; *) mal "T97 sin el aviso con la cuenta y el nombre: «$(esperados "$JSON")» · warn: $(printf '%s' "$JSON" | jtxt "d['warn']")" ;; esac
case "$(esperados "$JSON")" in *"lab-hook.js"*) mal "T97 nombra como faltante un control que está: «$(esperados "$JSON")»" ;; *) ok "T97 …y no nombra el que sí está" ;; esac
[ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && ok "T97 …como aviso, nunca en rojo (rc 0, sin fail)" || mal "T97 un control esperado que falta salió en rojo: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
SALIDA="$(harness doctor 2>&1)"
case "$SALIDA" in *"falta 1 de 2 controles esperados"*"lab-expected.js"*) ok "T97 …y la salida para una persona lo dice igual" ;; *) mal "T97 la salida de texto no lo dice: $SALIDA" ;; esac
# bajo la comprobación de salud: sigue siendo un aviso (un rojo ahí hace volver atrás una actualización sana)
JSON="$(TYCON_HARNESS_HEALTH=1 harness doctor --json 2>/dev/null)"; RC=$?
[ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && [ -n "$(esperados "$JSON")" ] && ok "T97 bajo la comprobación de salud: aviso, sin fail" || mal "T97 bajo la salud: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']") warn=«$(esperados "$JSON")»"
harness startup --force >/dev/null 2>&1
case "$(j "$ESTADO" "d.get('notice') or ''")" in *"comprobación de salud no pasó"*) mal "T97 la salud de startup --force falló por un control esperado que falta: $(j "$ESTADO" "d.get('notice')")" ;; *) ok "T97 la comprobación de salud entera (startup --force) pasa con un control esperado que falta" ;; esac
# espejo: el mismo control, ya registrado en settings.json → no falta
printf '// control esperado de juguete\nprocess.exit(0);\n' > "$LAB_TREE/scripts/hooks/lab-expected.js"
python3 - "$TYCON_SETTINGS_PATH" "$LAB_HOME/.claude/tycon-harness/scripts/hooks/lab-expected.js" <<'PY'
import json, sys
p, hook = sys.argv[1], sys.argv[2]; s = json.load(open(p, encoding="utf-8"))
s.setdefault("hooks", {}).setdefault("PreToolUse", []).append({"matcher": "Bash", "hooks": [{"type": "command", "command": 'node "%s"' % hook}]})
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
JSON="$(harness doctor --json 2>/dev/null)"
[ -z "$(esperados "$JSON")" ] && ok "T97 espejo: registrado, deja de faltar" || mal "T97 espejo: sigue avisando con el control registrado: «$(esperados "$JSON")»"
[ "$(printf '%s' "$JSON" | jtxt "any('controles esperados: 2, todos registrados' in o for o in d['ok'])")" = True ] && ok "T97 …y la cuenta de esperados pasa a 2" || mal "T97 la cuenta no pasó a 2: $(printf '%s' "$JSON" | jtxt "d['ok']")"
# lo sembrado se saca: los casos que siguen miden otra cosa
python3 - "$TYCON_SETTINGS_PATH" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
s["hooks"]["PreToolUse"] = [b for b in s["hooks"].get("PreToolUse", []) if not any("lab-expected.js" in h.get("command", "") for h in b.get("hooks", []))]
if not s["hooks"]["PreToolUse"]: del s["hooks"]["PreToolUse"]
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
rm -f "$LAB_TREE/scripts/hooks/lab-expected.js"
harness_lab_git "$LAB_TREE" checkout -q -- scripts/install-tycon-hooks.sh 2>/dev/null || mal "T97 no pude dejar el aplicador de juguete como estaba"

# ── T37 (tanda D · AC 29b): en una copia pública con `latest` + `auto`, doctor lo recuerda en CADA corrida ──────────
# 🔴 rojo previo: doctor no tenía la frase («sin revisión tuya» no aparecía en ningún aviso).
recuerda() { printf '%s' "$1" | jtxt "any('sin revisión tuya' in w for w in d['warn'])"; }
JSON="$(TYCON_UPDATE_CHANNEL=latest TYCON_UPDATE_APPLY=auto harness doctor --json 2>/dev/null)"
[ "$(recuerda "$JSON")" = False ] && ok "T37 espejo: en un clon interno, latest + auto no trae el recordatorio" || mal "T37 clon interno con el recordatorio: $(printf '%s' "$JSON" | jtxt "d['warn']")"
harness_lab_create "$BASE/lab-publico" >/dev/null
harness_lab_public
TYCON_UPDATE_APPLY=auto harness install --yes >/dev/null 2>&1 || mal "T37 install de la copia pública falló"
JSON="$(TYCON_UPDATE_CHANNEL=latest TYCON_UPDATE_APPLY=auto harness doctor --json 2>/dev/null)"
[ "$(recuerda "$JSON")" = True ] && ok "T37 copia pública en latest + auto: doctor recuerda «recibís lo que el equipo del arnés empuja, en minutos, sin revisión tuya»" || mal "T37 sin el recordatorio: $(printf '%s' "$JSON" | jtxt "d['warn']")"
[ "$(printf '%s' "$JSON" | jtxt "any('recibís lo que el equipo del arnés empuja, en minutos, sin revisión tuya' in w for w in d['warn'])")" = True ] && ok "T37 …con la frase del AC entera" || mal "T37 la frase no está entera: $(printf '%s' "$JSON" | jtxt "d['warn']")"
JSON2="$(TYCON_UPDATE_CHANNEL=latest TYCON_UPDATE_APPLY=auto harness doctor --json 2>/dev/null)"
[ "$(recuerda "$JSON2")" = True ] && ok "T37 …y lo repite en la corrida siguiente" || mal "T37 la segunda corrida no lo recuerda"
[ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && ok "T37 …como aviso, no en rojo" || mal "T37 el recordatorio (u otra cosa) salió en rojo: $(printf '%s' "$JSON" | jtxt "d['fail']")"
# espejos: en la copia pública, latest + ask y stable + auto no lo traen
JSON="$(TYCON_UPDATE_CHANNEL=latest TYCON_UPDATE_APPLY=ask harness doctor --json 2>/dev/null)"
[ "$(recuerda "$JSON")" = False ] && ok "T37 espejo: latest + ask no trae el recordatorio" || mal "T37 latest + ask con el recordatorio"
JSON="$(TYCON_UPDATE_CHANNEL=stable TYCON_UPDATE_APPLY=auto harness doctor --json 2>/dev/null)"
[ "$(recuerda "$JSON")" = False ] && ok "T37 espejo: stable + auto no trae el recordatorio" || mal "T37 stable + auto con el recordatorio"
# en la copia pública el aviso «máquina del equipo sin el perfil» no corresponde (no es un clon interno)
# El aviso «una máquina del equipo sin el perfil» usa el MISMO criterio de «público» (A1), no la presencia de
# `version.json`: la primera publicación salió sin ese archivo, y a una persona de afuera le salía siempre.
# 🔴 rojo previo: con `internal = !version.json`, este clon público (sin version.json) en ask traía el aviso.
[ ! -f "$LAB_TREE/version.json" ] || mal "T37 el laboratorio público trae version.json: el caso de abajo no mediría lo que dice"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('máquina del equipo' in w for w in d['warn'])")" = False ] && ok "T37 un clon del público SIN version.json, en ask por defecto: sin el aviso «máquina del equipo sin el perfil»" || mal "T37 la copia pública avisa «máquina del equipo»: $(printf '%s' "$JSON" | jtxt "d['warn']")"
[ "$(printf '%s' "$JSON" | jtxt "any('no es el repo público' in o for o in d['ok'])")" = False ] && ok "T37 …y no dice que su remoto no es el público" || mal "T37 el clon público dice que su remoto no es el público"
# Una COPIA con otro remoto —un fork de la copia pública, o la copia servida desde una carpeta local—: el árbol trae la
# lista de remotos públicos y su remoto no está en ella. No es «una máquina del equipo sin el perfil» (el aviso es sólo
# para un clon interno de verdad: un árbol SIN la lista); sí sigue diciendo que su remoto no es el público.
# 🔴 rojo previo: con el criterio «el remoto no es el público», este fork en ask por defecto traía el aviso
#    («T37 un fork de la copia… trae el aviso «máquina del equipo»: ['remoto interno con la política en ask: …']»).
harness_lab_create "$BASE/lab-otro-remoto" >/dev/null
harness_lab_public "https://example.invalid/example-org/example-harness"
harness install --yes >/dev/null 2>&1 || mal "T37 install del clon con otro remoto falló"
[ -f "$LAB_TREE/scripts/setup/public-remotes.json" ] || mal "T37 el laboratorio del fork no trae la lista de remotos: el caso de abajo no mediría lo que dice"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('máquina del equipo' in w for w in d['warn'])")" = False ] && ok "T37 un fork de la copia (el árbol trae la lista y su remoto no está en ella), en ask por defecto: sin el aviso «máquina del equipo sin el perfil»" || mal "T37 un fork de la copia trae el aviso «máquina del equipo»: $(printf '%s' "$JSON" | jtxt "d['warn']")"
[ "$(printf '%s' "$JSON" | jtxt "any('no es el repo público' in o for o in d['ok'])")" = True ] && ok "T37 …y sigue diciendo que su remoto no es el repo público" || mal "T37 el fork no dice que su remoto no es el público: $(printf '%s' "$JSON" | jtxt "d['ok']")"
[ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && ok "T37 …sin nada en rojo" || mal "T37 el fork tiene rojos: $(printf '%s' "$JSON" | jtxt "d['fail']")"

# ── T19 en una copia pública (pase adversarial de la tanda D, causa B): lo que doctor dice del HEAD que no es el
#    registrado tiene que ser CIERTO también para una fuente que se reescribe ─────────────────────────────────────────
# 🔴 rojo previo (medido con el programa de antes de este arreglo sobre este mismo guion): 4 MAL — doctor decía «si el
#    clon está en la punta de origin, harness.js update … lo re-registra» y `update` salía 2 sin re-registrar nunca (el
#    lazo de re-registro salteaba las fuentes que se reescriben); y con un commit propio decía lo mismo.
rojo_head() { printf '%s' "$1" | jtxt "' | '.join(f for f in d['fail'] if 'HEAD' in f)"; }
harness_lab_create "$BASE/lab-publico-pull" >/dev/null
harness_lab_public
harness_lab_publish_stable 2026.10.01.1
harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
TYCON_UPDATE_APPLY=auto harness install --yes >/dev/null 2>&1 || mal "T19 install de la copia pública (pull) falló"
harness_lab_publish_stable 2026.10.02.1
harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1   # un pull a mano en main, antes de la primera actualización
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
[ "$RC" != 0 ] && case "$(rojo_head "$JSON")" in *"no es el commit registrado"*"commit publicado"*"harness.js update"*"lo re-registra"*) true ;; *) false ;; esac && ok "T19 copia pública, pull a mano en main: rojo, y dice que update lo re-registra" || mal "T19 copia pública (pull): rc $RC «$(rojo_head "$JSON")»"
# T40b (2026-10-15, una máquina del equipo en Windows): la falla que dejaron arranques viejos se borra cuando la
# actualización a mano sale bien; si no, doctor y cada sesión seguían diciendo «no se pudo actualizar» con el arnés al día
FALLA2="$(node -e "console.log(require(process.argv[1]).paths(process.argv[2]).failuresFile)" "$LAB_TREE/scripts/setup/harness/state.js" "$LAB_HOME")"
mkdir -p "$(dirname "$FALLA2")"
printf '{"since":"2026-10-14T14:38:47.224Z","count":4,"reason":"no pude apartar la versión activa (EPERM)","last":"2026-10-15T09:00:00.000Z","kind":"update"}\n' > "$FALLA2"
TYCON_UPDATE_APPLY=auto harness update >/dev/null 2>&1; RC=$?
JSON="$(harness doctor --json 2>/dev/null)"
[ "$RC" = 0 ] && [ -z "$(rojo_head "$JSON")" ] && ok "T19 …y es cierto: update lo re-registra y el rojo se va" || mal "T19 copia pública: update (rc $RC) no re-registró: «$(rojo_head "$JSON")»"
[ "$RC" = 0 ] && [ ! -e "$FALLA2" ] && [ "$(printf '%s' "$JSON" | jtxt "any('no se pudo actualizar' in w for w in d['warn'])")" = False ] \
  && ok "T40b una actualización a mano que sale bien borra la falla vieja: doctor ya no la dice" || mal "T40b la falla vieja quedó después de un update sano (rc $RC, archivo $([ -e "$FALLA2" ] && echo sigue || echo borrado))"
# espejo: con un commit propio en main, doctor NO promete el re-registro: dice qué hay y un comando que se puede correr
harness_lab_git "$LAB_TREE" commit -q --allow-empty -m "commit propio" >/dev/null
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
ROJO="$(rojo_head "$JSON")"
[ "$RC" != 0 ] && case "$ROJO" in *"update lo re-registra"*|*" checkout tycon/installed"*) false ;; *"no es el commit registrado"*"1 commit"*"checkout -b tycon/installed "*) true ;; *) false ;; esac && ok "T19 espejo: con un commit propio no promete el re-registro ni aconseja una rama que no existe" || mal "T19 copia pública con commit propio: rc $RC «${ROJO}»"
CMD="$(printf '%s\n' "$ROJO" | grep -o "git -C [^ ]* checkout -b tycon/installed [0-9a-f]\{40\}" | head -1)"
env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR bash -c "${CMD:-false}" >/dev/null 2>&1; RC=$?
JSON="$(harness doctor --json 2>/dev/null)"
[ "$RC" = 0 ] && [ -z "$(rojo_head "$JSON")" ] && ok "T19 …y el comando que aconseja funciona: el rojo se va" || mal "T19 el comando aconsejado «${CMD}» salió $RC: «$(rojo_head "$JSON")»"

# estado ilegible: rojo, con el motivo (sobre el laboratorio que quedó armado)
printf '{ roto' > "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"
SALIDA="$(harness doctor 2>&1)"; RC=$?
[ "$RC" != 0 ] && case "$SALIDA" in *ilegible*|*roto*|*"no se puede leer"*) ok "T13 estado ilegible: rojo con el motivo" ;; *) mal "T13 estado ilegible sin motivo: $SALIDA" ;; esac || mal "T13 estado ilegible: rc 0"

# ═══ T38 (story 8.18, AC 37) · doctor en las tres formas de máquina que deja la unión de los dos repos ═══════════════
# Dos clones sin re-apuntar, dos clones con el viejo re-apuntado al repo unificado, y un solo árbol: en las tres doctor es
# verde, de sólo lectura, y dice qué forma es; muestra la fuente `agent_skills` mientras hay dos clones. Con la llave
# prendida y la mudanza todavía sin hacer, un aviso (no rojo); y lo publicado sin skills (AC 34), un aviso con lo que hay.
for shape in two-clones repointed single; do
  harness_lab_shape "$BASE/t38-$shape" "$shape" || { mal "T38 ($shape) no pude armar la máquina"; continue; }
  ANTES="$(harness_lab_home_hash)"
  JSON="$(TYCON_UPDATE_APPLY=auto harness doctor --json 2>/dev/null)"; RC=$?
  [ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && [ "$(harness_lab_home_hash)" = "$ANTES" ] \
    && ok "T38 ($shape) doctor: verde y sin escribir nada" || mal "T38 ($shape) doctor: rc $RC, fail $(printf '%s' "$JSON" | jtxt "d['fail']")"
  TRANSICION="$(printf '%s' "$JSON" | jtxt "sum('dos clones: en transición' in o for o in d['ok'])")"
  REAPUNTADOS="$(printf '%s' "$JSON" | jtxt "sum('dos clones, re-apuntados' in o for o in d['ok'])")"
  FUENTE="$(printf '%s' "$JSON" | jtxt "' | '.join(o for o in d['ok'] if o.startswith('fuente agent_skills: origin'))")"
  case "$shape" in
    two-clones) [ "$TRANSICION" = 1 ] && [ "$REAPUNTADOS" = 0 ] && case "$FUENTE" in *"$LAB_REMOTE_SKILLS"*) true ;; *) false ;; esac \
      && ok "T38 (two-clones) dice «dos clones: en transición» y muestra la fuente agent_skills con su repo viejo" || mal "T38 (two-clones): transición $TRANSICION, re-apuntados $REAPUNTADOS, fuente «${FUENTE}»" ;;
    repointed) [ "$TRANSICION" = 0 ] && [ "$REAPUNTADOS" = 1 ] && case "$FUENTE" in *"$LAB_REMOTE_UNIFIED"*) true ;; *) false ;; esac \
      && ok "T38 (repointed) dice «dos clones, re-apuntados» y muestra la fuente agent_skills con el repo unificado" || mal "T38 (repointed): transición $TRANSICION, re-apuntados $REAPUNTADOS, fuente «${FUENTE}»" ;;
    single) [ "$TRANSICION" = 0 ] && [ "$REAPUNTADOS" = 0 ] && [ -z "$FUENTE" ] && [ "$(printf '%s' "$JSON" | jtxt "sum(o.startswith('fuente harness: origin') for o in d['ok'])")" = 1 ] \
      && ok "T38 (single) una sola fuente, y nada que decir de dos clones" || mal "T38 (single): transición $TRANSICION, re-apuntados $REAPUNTADOS, fuente «${FUENTE}»" ;;
  esac
  if [ "$shape" = two-clones ]; then
    # la llave prendida, la mudanza todavía sin hacer (ningún arranque corrió): se dice, y no es rojo
    JSON="$(TYCON_UPDATE_SKILLS_SOURCE=unified harness doctor --json 2>/dev/null)"; RC=$?
    [ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | jtxt "sum('todavía no se re-apuntó' in w for w in d['warn'])")" = 1 ] && [ "$(printf '%s' "$JSON" | jtxt "sum('nada se mueve hasta que la llave' in o for o in d['ok'])")" = 0 ] \
      && ok "T38 con la llave prendida y la mudanza sin hacer: un aviso (lo hace el próximo arranque), no rojo" || mal "T38 llave prendida sin mudanza: rc $RC: $JSON"
  fi
  if [ "$shape" = repointed ]; then
    # AC 34: lo último traído no trae las skills → doctor lo muestra con lo que hay en el clon, sin salir a la red
    harness_lab_publish_without_skills && harness_lab_git "$LAB_SKILLS" fetch -q origin || mal "T38 no pude traer la punta sin skills"
    SALIDA="$(harness doctor 2>&1)"; RC=$?
    [ "$RC" = 0 ] && case "$SALIDA" in *"fuente agent_skills: lo publicado"*"no trae las skills"*"no se aplica"*) true ;; *) false ;; esac \
      && ok "T38 (AC 34) lo publicado sin skills: doctor lo muestra como aviso (la máquina sigue sana, con sus skills)" || mal "T38 (AC 34) doctor (rc $RC): $SALIDA"
  fi
done

# ═══ REPEATED (story 8.18 · decisión del dueño, 2026-10-04: «avisa y no toca») · los hooks que ya quedaron repetidos ══
# El caso: el ensayo del alta de un dev nuevo (2026-10-03) terminó con 32 hooks registrados DOS veces —el mismo archivo
# por dos rutas: la carpeta del clon y el enlace ~/.claude/tycon-harness—. El instalador ya no registra uno dos
# veces (AC 36), pero los que una máquina ya tiene se quedan: sacarlos solo cambiaría el settings.json de las máquinas
# del equipo el día del corte. doctor lo dice UNA vez, como dato (cuántos, y cómo se sacan a mano), sin tocar nada y sin
# poner el diagnóstico en rojo. Repetido = mismo evento, mismo matcher (en cualquier orden) y el MISMO archivo del arnés
# por su ruta real; el mismo archivo en otro evento o con otro matcher no lo es, y un hook de la persona tampoco cuenta.
harness_lab_create "$BASE/rep" >/dev/null
harness install --yes >/dev/null 2>&1 || mal "REPEATED install previo falló"
rep_said() { grep -c 'más de una vez'; }   # las líneas de doctor que hablan de hooks repetidos
rep_alarms() { grep -e '^  ✗ ' -e '^  ! '; }
REP_BEFORE="$(harness doctor 2>&1)"; RC_BEFORE=$?
[ "$(printf '%s\n' "$REP_BEFORE" | rep_said)" = 0 ] && ok "REPEATED sin hooks repetidos, doctor no dice nada de eso" || mal "REPEATED sin repetidos doctor lo dice igual: $(printf '%s\n' "$REP_BEFORE" | grep 'más de una vez')"
cp "$TYCON_SETTINGS_PATH" "$BASE/rep-settings-clean.json"
printf 'process.exit(0);\n' > "$LAB_TREE/scripts/hooks/lab-other.js"; mkdir -p "$LAB/elsewhere"; printf 'process.exit(0);\n' > "$LAB/elsewhere/own.js"
python3 - "$TYCON_SETTINGS_PATH" "$LAB_HOME/.claude/tycon-harness" "$LAB_TREE" "$LAB/elsewhere/own.js" <<'PY'
import json, sys
p, link, tree, own = sys.argv[1:5]
s = json.load(open(p, encoding="utf-8"))
h = s.setdefault("hooks", {})
cmd = lambda path: {"type": "command", "command": 'node "%s"' % path}
# 1) el hook que registró el aplicador (por la carpeta del clon), otra vez por el ENLACE: el mismo archivo por dos rutas
h.setdefault("SessionStart", []).append({"hooks": [cmd(link + "/scripts/hooks/lab-hook.js")]})
# 2) otro archivo del arnés dos veces en el mismo evento, con el mismo matcher escrito en otro orden
h.setdefault("PreToolUse", []).append({"matcher": "Edit|Write", "hooks": [cmd(tree + "/scripts/hooks/lab-other.js")]})
h["PreToolUse"].append({"matcher": "Write|Edit", "hooks": [cmd(tree + "/scripts/hooks/lab-other.js")]})
# lo que NO es repetido: ese archivo con OTRO matcher, y en OTRO evento
h["PreToolUse"].append({"matcher": "Bash", "hooks": [cmd(tree + "/scripts/hooks/lab-other.js")]})
h.setdefault("PostToolUse", []).append({"matcher": "Edit|Write", "hooks": [cmd(tree + "/scripts/hooks/lab-other.js")]})
# un hook de la persona, dos veces: no es del arnés
h.setdefault("Stop", []).append({"hooks": [cmd(own), cmd(own)]})
json.dump(s, open(p, "w", encoding="utf-8"), indent=2, ensure_ascii=False); open(p, "a").write("\n")
PY
REP_SHA="$(shasum -a 256 < "$TYCON_SETTINGS_PATH")"; ANTES="$(harness_lab_home_hash)"
SALIDA="$(harness doctor 2>&1)"; RC=$?
LINEA="$(printf '%s\n' "$SALIDA" | grep 'más de una vez')"
[ "$(printf '%s\n' "$SALIDA" | rep_said)" = 1 ] && ok "REPEATED con hooks repetidos, doctor lo dice UNA vez" || mal "REPEATED doctor lo dice $(printf '%s\n' "$SALIDA" | rep_said) veces: $(printf '%s\n' "$LINEA" | head -3 | cut -c1-300)"
case "$LINEA" in "  ✓ "*"2 hook"*) ok "REPEATED …como dato (✓) y con la cuenta: 2 (el del enlace y el del matcher en otro orden; ni el otro evento, ni el otro matcher, ni el hook de la persona)" ;; *) mal "REPEATED la línea no es un dato con la cuenta 2: ${LINEA}" ;; esac
case "$LINEA" in *"$TYCON_SETTINGS_PATH"*"a mano"*) ok "REPEATED …y dice dónde están y cómo se sacan a mano" ;; *) mal "REPEATED la línea no dice el archivo ni cómo sacarlos a mano: ${LINEA}" ;; esac
[ "$RC" = "$RC_BEFORE" ] && [ "$RC" = 0 ] && [ "$(printf '%s\n' "$SALIDA" | rep_alarms)" = "$(printf '%s\n' "$REP_BEFORE" | rep_alarms)" ] \
  && ok "REPEATED no pone el diagnóstico en rojo ni suma un aviso: sale $RC, con las mismas alarmas que sin repetidos" \
  || mal "REPEATED doctor cambió de veredicto (rc $RC, antes $RC_BEFORE): $(diff <(printf '%s\n' "$REP_BEFORE" | rep_alarms) <(printf '%s\n' "$SALIDA" | rep_alarms) | head -4 | cut -c1-300)"
[ "$(shasum -a 256 < "$TYCON_SETTINGS_PATH")" = "$REP_SHA" ] && [ "$(harness_lab_home_hash)" = "$ANTES" ] \
  && ok "REPEATED no toca nada: settings.json idéntico antes y después, y la HOME también" || mal "REPEATED doctor escribió algo (settings.json o la HOME cambiaron)"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "sum('más de una vez' in o for o in d['ok'])")" = 1 ] && [ "$(printf '%s' "$JSON" | jtxt "sum('más de una vez' in x for x in d['warn'] + d['fail'])")" = 0 ] \
  && ok "REPEATED --json: el dato va en «ok», no en «warn» ni en «fail»" || mal "REPEATED --json: $(printf '%s' "$JSON" | jtxt "[x for x in d['ok'] + d['warn'] + d['fail'] if 'más de una vez' in x]")"
# (espejo) sacados a mano, doctor deja de decirlo
cp "$BASE/rep-settings-clean.json" "$TYCON_SETTINGS_PATH"
SALIDA="$(harness doctor 2>&1)"
[ "$(printf '%s\n' "$SALIDA" | rep_said)" = 0 ] && ok "REPEATED (espejo) sacados a mano, doctor deja de decirlo" || mal "REPEATED (espejo) sin repetidos lo sigue diciendo: $(printf '%s\n' "$SALIDA" | grep 'más de una vez' | cut -c1-200)"
# (error) un settings.json que no se puede leer no es «sin repetidos»: se dice que no se pudo mirar
printf '{ roto' > "$TYCON_SETTINGS_PATH"
SALIDA="$(harness doctor 2>&1)"
[ "$(printf '%s\n' "$SALIDA" | grep -c 'hooks repetidos: no pude mirar')" = 1 ] && [ "$(printf '%s\n' "$SALIDA" | rep_said)" = 0 ] \
  && ok "REPEATED (error) con settings.json ilegible dice que no pudo mirar (no «sin repetidos»)" || mal "REPEATED (error) settings.json ilegible: $(printf '%s\n' "$SALIDA" | grep -i 'repetid' | cut -c1-200)"
cp "$BASE/rep-settings-clean.json" "$TYCON_SETTINGS_PATH"

# ═══ REPEATED-CASE (story 8.18, tramo 3 · pase adversarial, clase 15) · la misma carpeta escrita con otras mayúsculas ══
# El caso: en un disco que no distingue mayúsculas (el de una Mac, el de Windows), el instalador llamado por la misma
# carpeta escrita con otra caja (`…/src/harness` por `…/Src/harness`) dejó 27 hooks registrados dos veces, y doctor
# calló: comparaba la ruta real letra por letra (`fs.realpathSync` no iguala la caja) y decidía «es del arnés» con un
# prefijo letra por letra, así que esos hooks ni contaban como del arnés. La regla ahora es QUÉ ARCHIVO es (dispositivo
# e inodo); si el disco no da esa identidad, la ruta real con la caja igualada sólo cuando ese disco no la distingue.
# Se mide por las dos vías («id»: con la identidad; «path»: sin ella, como en un disco que no la da), con la raíz en su
# caja y en la otra, y con su espejo: dos archivos DISTINTOS del árbol no son un repetido.
# En un disco que SÍ distingue mayúsculas la otra ruta no existe: NO MEDIDO (ni verde ni rojo).
REP_OTHER="$(dirname "$(dirname "$LAB_TREE")")/$(basename "$(dirname "$LAB_TREE")" | tr '[:lower:]' '[:upper:]')/$(basename "$LAB_TREE")"   # …/CLONES/harness
if [ "$REP_OTHER" != "$LAB_TREE" ] && [ "$REP_OTHER/scripts/hooks/lab-hook.js" -ef "$LAB_TREE/scripts/hooks/lab-hook.js" ]; then
  cat > "$BASE/rep-case.js" <<'JS'
'use strict';
// rep-case.js <repo bajo prueba> <árbol> <el mismo árbol en otra caja> <el enlace>: una línea por caso, «<vía> <caso> ok|MAL(…)»
const path = require('path');
const [repo, tree, other, link] = process.argv.slice(2);
const R = require(path.join(repo, 'scripts', 'setup', 'harness', 'report.js'));
const hook = (root, name = 'lab-hook.js') => path.join(root, 'scripts', 'hooks', name);
const mk = (...files) => ({ hooks: { SessionStart: files.map((f) => ({ hooks: [{ type: 'command', command: `node "${f}"` }] })) } });
const cases = [
  ['A-clon+enlace(la-vara)', mk(hook(tree), hook(link)), tree, '2'],
  ['B-clon+otra-caja', mk(hook(tree), hook(other)), tree, '2'],
  ['C-otra-caja-dos-veces', mk(hook(other), hook(other)), tree, '2'],
  ['D-enlace+otra-caja', mk(hook(link), hook(other)), tree, '2'],
  ['E-raíz-en-otra-caja:clon-dos-veces', mk(hook(tree), hook(tree)), other, '2'],
  ['F-raíz-en-otra-caja:clon+enlace', mk(hook(tree), hook(link)), other, '2'],
  ['G-espejo:dos-archivos-distintos', mk(hook(tree), hook(other, 'lab-other.js')), tree, ''],
];
for (const via of ['id', 'path']) {
  for (const [name, settings, root, want] of cases) {
    // «path»: sin identidad de archivo, como en un disco que no la da (vale la ruta real, con la caja que el disco diga)
    const got = R.repeatedHooks(settings, [root], via === 'path' ? { identity: () => null } : undefined).map((x) => x.count).join(',');
    console.log(`${via} ${name} ${got === want ? 'ok' : `MAL(contó «${got}», esperaba «${want}»)`}`);
  }
}
JS
  REP_UNIT="$(node "$BASE/rep-case.js" "$RAIZ" "$LAB_TREE" "$REP_OTHER" "$LAB_HOME/.claude/tycon-harness" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(printf '%s\n' "$REP_UNIT" | grep -c ' ok$')" = 14 ] && [ "$(printf '%s\n' "$REP_UNIT" | grep -c 'MAL')" = 0 ] \
    && ok "REPEATED-CASE el mismo archivo por la carpeta en otra caja cuenta como repetido, con la raíz en cualquiera de las dos cajas, con identidad de archivo y sin ella (7 casos por 2 vías, con su vara y su espejo)" \
    || mal "REPEATED-CASE (rc $RC): $(printf '%s\n' "$REP_UNIT" | grep -v ' ok$' | head -8 | tr '\n' ' ' | cut -c1-600)"
  # de punta a punta: el hook que registró el aplicador (por la carpeta del clon), otra vez por la misma carpeta en otra caja
  python3 - "$TYCON_SETTINGS_PATH" "$REP_OTHER" <<'PY'
import json, sys
p, other = sys.argv[1:3]
s = json.load(open(p, encoding="utf-8"))
s.setdefault("hooks", {}).setdefault("SessionStart", []).append({"hooks": [{"type": "command", "command": 'node "%s/scripts/hooks/lab-hook.js"' % other}]})
json.dump(s, open(p, "w", encoding="utf-8"), indent=2, ensure_ascii=False); open(p, "a").write("\n")
PY
  REP_SHA="$(shasum -a 256 < "$TYCON_SETTINGS_PATH")"
  SALIDA="$(harness doctor 2>&1)"; RC=$?
  LINEA="$(printf '%s\n' "$SALIDA" | grep 'más de una vez')"
  [ "$RC" = "$RC_BEFORE" ] && [ "$(printf '%s\n' "$SALIDA" | rep_said)" = 1 ] && case "$LINEA" in "  ✓ "*"1 hook"*"mayúsculas"*) true ;; *) false ;; esac \
    && ok "REPEATED-CASE doctor lo dice: 1 hook repetido (el del clon y el de la misma carpeta en otra caja), como dato, y nombra esa causa" \
    || mal "REPEATED-CASE doctor (rc $RC, antes $RC_BEFORE) lo dice $(printf '%s\n' "$SALIDA" | rep_said) vez/veces: $(printf '%s\n' "$LINEA" | head -2 | cut -c1-300)"
  [ "$(shasum -a 256 < "$TYCON_SETTINGS_PATH")" = "$REP_SHA" ] && ok "REPEATED-CASE …y no toca settings.json (avisa y no toca)" || mal "REPEATED-CASE doctor escribió settings.json"
  cp "$BASE/rep-settings-clean.json" "$TYCON_SETTINGS_PATH"
else
  echo "  ⏭ REPEATED-CASE NO MEDIDO — este disco distingue mayúsculas (${REP_OTHER} no es ${LAB_TREE}): la misma carpeta en otra caja no existe acá"
fi

# ── T26 Doctor_WhereHarnessLives_LegacyOnlyIfPresent_CountByFile_JsonPlace_ReadOnly (story 8.19, tanda B · AC 19) ───
# doctor dice en qué nombre vive el arnés y si es enlace o carpeta; el nombre viejo SÓLO si existe (una máquina de afuera
# nunca lo lee); cuánto queda registrado por él, archivo por archivo, como dato y con el comando (harness.js relocate);
# rojo si ningún nombre resuelve o si los dos apuntan a clones distintos; un viejo que es una carpeta ajena o un archivo
# es un dato (deuda M7 de la tanda A). Todo de sólo lectura. Los enlaces se arman por Node (en Windows, junctions).
PN="$(node -p "require('$RAIZ/scripts/setup/harness/place.js').PLACE_NAME")"
LN="$(node -p "require('$RAIZ/scripts/setup/harness/place.js').LEGACY_PLACE_NAME")"
T26_PLACE="$LAB_HOME/.claude/$PN"; T26_OLD="$LAB_HOME/.claude/$LN"
t26_link() { node -e 'const fs=require("fs");const [t,a]=process.argv.slice(1);try{fs.unlinkSync(a)}catch(_){try{fs.rmdirSync(a)}catch(_){}}if(t!=="-")fs.symlinkSync(t,a,process.platform==="win32"?"junction":"dir")' "$1" "$2"; }
t26_rm() { node -e 'const fs=require("fs");const a=process.argv[1];try{fs.unlinkSync(a)}catch(_){try{fs.rmdirSync(a)}catch(_){}}' "$1"; }
t26_hook() { # t26_hook <command>  — un hook más en PreToolUse de settings.json
  python3 - "$TYCON_SETTINGS_PATH" "$1" <<'PY'
import json, sys
p, cmd = sys.argv[1:3]
s = json.load(open(p, encoding="utf-8"))
s.setdefault("hooks", {}).setdefault("PreToolUse", []).append({"matcher": "Bash", "hooks": [{"type": "command", "command": cmd}]})
json.dump(s, open(p, "w", encoding="utf-8"), indent=2, ensure_ascii=False); open(p, "a").write("\n")
PY
}
cp "$TYCON_SETTINGS_PATH" "$BASE/t26-settings.json"
t26_link "$LAB_TREE" "$T26_PLACE"; t26_link "$T26_PLACE" "$T26_OLD"
# (1) ya instalada, sin mudar: un hook por el nombre viejo
t26_hook "node \"\$HOME/.claude/$LN/scripts/hooks/lab-hook.js\""
ANTES="$(harness_lab_home_hash)"
SALIDA="$(harness doctor 2>&1)"; RC=$?
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "T26 doctor sigue sin escribir nada (HOME idéntico por hash)" || mal "T26 doctor escribió algo"
case "$SALIDA" in *"arnés en ~/.claude/$PN → "*) ok "T26 dice en qué nombre vive el arnés (el lugar) y a dónde apunta" ;; *) mal "T26 no dice dónde vive: $SALIDA" ;; esac
case "$SALIDA" in *"nombre viejo ~/.claude/$LN sigue andando y apunta al lugar"*) ok "T26 el viejo, que existe: sigue andando y apunta al lugar" ;; *) mal "T26 el viejo: $SALIDA" ;; esac
case "$SALIDA" in *"registrado por el nombre viejo: settings.json 1"*"harness.js relocate"*) ok "T26 lo registrado por el viejo, por archivo, como dato y con el comando" ;; *) mal "T26 el conteo: $(printf '%s\n' "$SALIDA" | grep -i 'registrado')" ;; esac
[ "$(printf '%s' "$JSON" | jtxt "(d['place']['name'], d['place']['kind'], d['legacy']['to_place'], d['registered_by_legacy']['total'], len(d['fail']))")" = "('$PN', 'link', True, 1, 0)" ] \
  && ok "T26 --json: place (nombre, enlace), legacy (apunta al lugar), registered_by_legacy 1, sin fail" || mal "T26 --json: $(printf '%s' "$JSON" | jtxt "{k: d.get(k) for k in ('place','legacy','registered_by_legacy','fail')}")"
# «8.19» como número suelto: la salida trae la hora de instalación con milésimas, y «…:38.190Z» lo contenía de a ratos
# (public-ci, 2026-10-14, Node 22: rojo sin ninguna story en la salida)
T26_STORY='story|(^|[^0-9.])8\.19([^0-9]|$)'
printf '%s\n' '  ✓ versión 2026.10.14+b815072 · instalada 2026-10-14T05:55:38.190Z' | grep -iE "$T26_STORY" >/dev/null && mal "T26 el patrón de story toma la hora de instalación como una story" || ok "T26 el patrón de story no toma la hora de instalación (…:38.190Z)"
printf '%s\n' 'tanda B de la 8.19' '(8.19)' 'una Story' | grep -ciE "$T26_STORY" | grep -x 3 >/dev/null && ok "T26 espejo: el patrón sí ve «8.19» suelto y «story»" || mal "T26 espejo: el patrón no ve «8.19» suelto o «story»"
printf '%s\n' "$SALIDA" | grep -iE "$T26_STORY" >/dev/null && mal "T26 una línea nombra una story: $(printf '%s\n' "$SALIDA" | grep -iE "$T26_STORY")" || ok "T26 ninguna línea nombra una story"
# (2) mudada: el hook por el lugar, el permiso con las dos formas → sólo permisos
cp "$BASE/t26-settings.json" "$TYCON_SETTINGS_PATH"
t26_hook "node \"\$HOME/.claude/$PN/scripts/hooks/lab-hook.js\""
python3 - "$TYCON_SETTINGS_PATH" "$LN" "$PN" <<'PY'
import json, sys
p, old, new = sys.argv[1:4]
s = json.load(open(p, encoding="utf-8"))
s.setdefault("permissions", {}).setdefault("allow", []).extend(["Bash(node ~/.claude/%s/scripts/setup/harness.js doctor)" % old, "Bash(node ~/.claude/%s/scripts/setup/harness.js doctor)" % new])
json.dump(s, open(p, "w", encoding="utf-8"), indent=2, ensure_ascii=False); open(p, "a").write("\n")
PY
JSON="$(harness doctor --json 2>/dev/null)"; SALIDA="$(harness doctor 2>&1)"
[ "$(printf '%s' "$JSON" | jtxt "all(f['count'] == f['permissions'] for f in d['registered_by_legacy']['files']) and d['registered_by_legacy']['total'] == 1")" = True ] \
  && case "$SALIDA" in *"sólo permisos"*) true ;; *) false ;; esac && ok "T26 mudada: sólo permisos (con las dos formas, a propósito)" || mal "T26 mudada: $(printf '%s' "$JSON" | jtxt "d.get('registered_by_legacy')")"
# (3) una máquina de afuera: sin el viejo y sin nada por él → ni una palabra del viejo
cp "$BASE/t26-settings.json" "$TYCON_SETTINGS_PATH"; t26_rm "$T26_OLD"
SALIDA="$(harness doctor 2>&1)"; RC=$?; JSON="$(harness doctor --json 2>/dev/null)"
[ "$RC" = 0 ] && ! printf '%s\n' "$SALIDA" | grep "nombre viejo" >/dev/null && [ "$(printf '%s' "$JSON" | jtxt "('legacy' in d, 'registered_by_legacy' in d, d['place']['name'])")" = "(False, False, '$PN')" ] \
  && ok "T26 máquina de afuera: verde, sin nombrar el viejo, place sin legacy en el JSON" || mal "T26 afuera (rc $RC): $(printf '%s\n' "$SALIDA" | grep -i 'viejo') · $(printf '%s' "$JSON" | jtxt "[k for k in d]")"
# (3b) …con las copias que el arnés gestiona instaladas: el pre-commit global de git (copia de su fuente en el árbol)
#      nombra la ruta vieja a propósito; no es un registro de la persona: sigue sin una palabra del viejo y con 0
#      (pase adversarial de la tanda B, B1)
mkdir -p "$LAB_TREE/scripts/hooks" "$TYCON_GIT_HOOKS_DIR"
printf '#!/usr/bin/env bash\nharness_dir="${TYCON_GUIDES_DIR:-$HOME/.claude/%s}"\nbash "$HOME/.claude/%s/scripts/hooks/x.sh"\n' "$LN" "$LN" > "$LAB_TREE/scripts/hooks/git-pre-commit-global.sh"
cp "$LAB_TREE/scripts/hooks/git-pre-commit-global.sh" "$TYCON_GIT_HOOKS_DIR/pre-commit"
SALIDA="$(harness doctor 2>&1)"; RC=$?; JSON="$(harness doctor --json 2>/dev/null)"
[ "$RC" = 0 ] && ! printf '%s\n' "$SALIDA" | grep "nombre viejo" >/dev/null && [ "$(printf '%s' "$JSON" | jtxt "('legacy' in d, 'registered_by_legacy' in d)")" = "(False, False)" ] \
  && ok "T26 máquina de afuera con el pre-commit global del árbol instalado: tampoco nombra el viejo (la copia no es un registro)" || mal "T26 afuera con el pre-commit (rc $RC): $(printf '%s\n' "$SALIDA" | grep -i 'viejo') · $(printf '%s' "$JSON" | jtxt "d.get('registered_by_legacy')")"
rm -f "$LAB_TREE/scripts/hooks/git-pre-commit-global.sh" "$TYCON_GIT_HOOKS_DIR/pre-commit"
# (4) el viejo como carpeta ajena o como archivo: un dato, no rojo (M7)
mkdir -p "$T26_OLD/algo"
SALIDA="$(harness doctor 2>&1)"; RC=$?
[ "$RC" = 0 ] && case "$SALIDA" in *"nombre viejo ~/.claude/$LN es una carpeta, que no es un clon del arnés"*) true ;; *) false ;; esac && ok "T26 el viejo como carpeta ajena: un dato, verde" || mal "T26 carpeta ajena (rc $RC): $(printf '%s\n' "$SALIDA" | grep -i viejo)"
rm -rf "$T26_OLD"; printf 'x\n' > "$T26_OLD"
SALIDA="$(harness doctor 2>&1)"; RC=$?
[ "$RC" = 0 ] && case "$SALIDA" in *"nombre viejo ~/.claude/$LN es un archivo"*) true ;; *) false ;; esac && ok "T26 el viejo como archivo: un dato, verde" || mal "T26 archivo (rc $RC): $(printf '%s\n' "$SALIDA" | grep -i viejo)"
rm -f "$T26_OLD"
# (5) conflicto: los dos a clones distintos → rojo
mkdir -p "$BASE/t26-otro/scripts"; : > "$BASE/t26-otro/scripts/install-tycon-hooks.sh"
t26_link "$BASE/t26-otro" "$T26_OLD"
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
[ "$RC" != 0 ] && [ "$(printf '%s' "$JSON" | jtxt "any('clones distintos' in f for f in d['fail'])")" = True ] && ok "T26 conflicto (los dos a clones distintos): rojo" || mal "T26 conflicto rc $RC: $(printf '%s' "$JSON" | jtxt "d['fail']")"
# (6) ninguno resuelve → rojo
t26_rm "$T26_OLD"; t26_rm "$T26_PLACE"
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
[ "$RC" != 0 ] && [ "$(printf '%s' "$JSON" | jtxt "len(d['fail']) > 0 and d['place']['name'] is None")" = True ] && ok "T26 ningún nombre resuelve: rojo, place sin nombre" || mal "T26 ninguno rc $RC: $(printf '%s' "$JSON" | jtxt "(d['fail'], d.get('place'))")"
# version muestra el lugar
t26_link "$LAB_TREE" "$T26_PLACE"; t26_link "$T26_PLACE" "$T26_OLD"
case "$(harness version 2>&1)" in *"arnés en ~/.claude/$PN"*) ok "T26 version muestra el lugar" ;; *) mal "T26 version: $(harness version 2>&1)" ;; esac
[ "$(harness version --json 2>/dev/null | jtxt "d['place']['name']")" = "$PN" ] && ok "T26 version --json trae place" || mal "T26 version --json: $(harness version --json 2>&1 | head -3)"
cp "$BASE/t26-settings.json" "$TYCON_SETTINGS_PATH"

# ── T38 HealthAndDoctor_Minimal_GreenWithEventsWithoutHooks (story 8.16, tanda C · AC 28, la parte de doctor) ────────
# En una instalación minimal, lo que el perfil no trae no es un «control esperado que falta»; doctor dice el perfil con su
# origen y sigue sin escribir nada. El aplicador de juguete pasa a conocer un control que es sólo de full (el medidor de
# estilo, según la lista de efectos) y no lo registra: en full se avisa que falta; en minimal, no.
# 🔴 rojo previo (medido): sin el perfil en doctor, minimal avisaba el control de full como faltante y no decía el perfil.
echo "T38 · doctor en minimal"
harness_lab_create "$BASE/t38" >/dev/null
harness install --yes >/dev/null 2>&1 || mal "T38 install previo falló"
printf 'process.exit(0);\n' > "$LAB_TREE/scripts/hooks/response-style-meter.js"
printf '\nLAB_SPEC_FULL_ONLY="Stop||@tcg:response-style-meter.js|control de full que el aplicador de juguete no registra"\n' >> "$LAB_TREE/scripts/install-tycon-hooks.sh"
falta_full() { printf '%s' "$1" | jtxt "any('response-style-meter.js' in w for w in d['warn'])"; }
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(falta_full "$JSON")" = True ] && ok "T38 espejo: en full, el control de full sin registrar se avisa" || mal "T38 espejo full: warn=$(printf '%s' "$JSON" | jtxt "d['warn']")"
printf '{ "install": { "profile": "minimal" } }\n' > "$LAB_HOME/.claude/tycon.json"
ANTES="$(harness_lab_home_hash)"
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
[ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "T38 doctor en minimal no escribe nada" || mal "T38 doctor en minimal escribió algo"
[ "$(falta_full "$JSON")" = False ] && ok "T38 en minimal, lo que el perfil no trae no es «falta»" || mal "T38 en minimal avisa el control de full: $(printf '%s' "$JSON" | jtxt "[w for w in d['warn'] if 'esperado' in w]")"
[ "$(printf '%s' "$JSON" | jtxt "any(o.startswith('perfil: minimal (') for o in d['ok'])")" = True ] && ok "T38 doctor dice «perfil: minimal (<origen>)»" || mal "T38 doctor no dice el perfil: $(printf '%s' "$JSON" | jtxt "d['ok'][:6]")"
[ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && ok "T38 doctor en minimal sin fail" || mal "T38 doctor en minimal: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
SALIDA="$(harness doctor 2>&1)"
case "$SALIDA" in *"perfil: minimal ("*) ok "T38 …y la salida para una persona también lo dice" ;; *) mal "T38 la salida de texto no dice el perfil" ;; esac
case "$SALIDA" in *"sin registrar"*) mal "T38 doctor en minimal da algo «sin registrar»: $(printf '%s\n' "$SALIDA" | grep 'sin registrar' | head -2)" ;; *) ok "T38 …y nada «sin registrar»" ;; esac
# (pase adversarial de la tanda C, clases 3 y 4) en minimal, el barrido de Telegram prendido a mano (TYCON_TG_ZOMBIE_SWEEP=1,
# con el plugin) lo registra el aplicador: doctor lo espera, y si no está lo avisa
mkdir -p "$LAB_HOME/.claude/plugins/cache/claude-plugins-official/telegram"
printf 'process.exit(0);\n' > "$LAB_TREE/scripts/hooks/telegram-zombie-sweep.sh"
printf '\nLAB_SPEC_TG="SessionStart||@tcg:telegram-zombie-sweep.sh|el barrido de Telegram de juguete, que el aplicador no registra"\n' >> "$LAB_TREE/scripts/install-tycon-hooks.sh"
JSON="$(TYCON_TG_ZOMBIE_SWEEP=1 harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('telegram-zombie-sweep.sh' in w for w in d['warn'])")" = True ] && ok "T38 en minimal con TYCON_TG_ZOMBIE_SWEEP=1: doctor espera el barrido y avisa que falta" \
  || mal "T38 barrido de Telegram prendido a mano en minimal: warn=$(printf '%s' "$JSON" | jtxt "[w for w in d['warn'] if 'esperado' in w]")"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('telegram-zombie-sweep.sh' in w for w in d['warn'])")" = False ] && ok "T38 espejo: sin la variable, en minimal no lo espera" \
  || mal "T38 espejo del barrido: lo espera sin la variable"

# ── T49 Doctor_ShowsProfileIntegrationsPackBrakes_JsonKeys_UnchosenWarns (story 8.16, tanda D · AC 35) ─────────────
# doctor dice el perfil con su origen, las integraciones prendidas y apagadas con su origen, el paquete del stack por
# defecto y cuántos controles que frenan están registrados (nombrando los que frenan en cualquier repo); en una
# instalación sin perfil elegido avisa que se comporta como full. `--json` suma `profile`, `integrations`, `packs` y
# `brakes` sin tocar `mode`, `fail`, `warn` ni `ok`. Sigue sin escribir nada.
# 🔴 rojo previo verificado: antes de la tanda D doctor no decía integraciones, paquete ni frenos, y --json no traía esas claves.
echo "T49 · doctor: perfil, integraciones, paquete y frenos"
harness_lab_create "$BASE/t49" >/dev/null
harness install --yes >/dev/null 2>&1 || mal "T49 install previo falló"
# el hook de juguete pasa a ser, para la lista de efectos del laboratorio, un control que frena en cualquier repo
python3 - "$LAB_TREE/scripts/setup/install-effects.json" <<'PY2'
import json, sys
p = sys.argv[1]; d = json.load(open(p, encoding="utf-8"))
d["effects"].append({"id": "SessionStart:@tcg:lab-hook.js", "kind": "hook", "title": "Un freno de juguete", "group": "safety", "default": "on",
  "does": "Un freno de juguete del laboratorio.", "blocks": "any-repo", "when": "always",
  "switch": None, "network": None, "stores": None, "windows": False, "front_page": False, "profiles": ["minimal", "full"]})
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY2
printf '{ "install": { "profile": "minimal" } }\n' > "$LAB_HOME/.claude/tycon.json"
ANTES="$(harness_lab_home_hash)"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "T49 doctor no escribe nada" || mal "T49 doctor escribió algo"
# (cruce con la tanda B de la 8.19, AC 19: `place` va siempre, y `legacy` y `registered_by_legacy` si el viejo existe o
# algo lo nombra; fuera de esas tres, las claves son exactamente las de siempre más las cuatro de la tanda D)
[ "$(printf '%s' "$JSON" | jtxt "(sorted(k for k in d.keys() if k not in ('place', 'legacy', 'registered_by_legacy')), 'place' in d)")" = "(['brakes', 'declared_repos', 'fail', 'harness_node', 'integrations', 'mode', 'ok', 'packs', 'profile', 'warn'], True)" ] \
  && ok "T49 --json: las cuatro claves nuevas y las de siempre (más las del lugar, desde la story 2.21 declared_repos y desde la 8.39 harness_node)" || mal "T49 claves de --json: $(printf '%s' "$JSON" | jtxt "sorted(d.keys())")"
[ "$(printf '%s' "$JSON" | jtxt "(d['profile']['value'], d['profile']['origin'])")" = "('minimal', 'maquina')" ] && ok "T49 profile: minimal desde ~/.claude/tycon.json" || mal "T49 profile: $(printf '%s' "$JSON" | jtxt "d['profile']")"
[ "$(printf '%s' "$JSON" | jtxt "(d['brakes']['registered'], d['brakes']['any_repo'])")" = "(1, ['lab-hook.js'])" ] && ok "T49 brakes: uno registrado, nombrado entre los que frenan en cualquier repo" || mal "T49 brakes: $(printf '%s' "$JSON" | jtxt "d['brakes']")"
[ "$(printf '%s' "$JSON" | jtxt "d['packs']['value']")" = none ] && ok "T49 packs: none" || mal "T49 packs: $(printf '%s' "$JSON" | jtxt "d['packs']")"
for linea in 'perfil: minimal (~/.claude/tycon.json)' 'integraciones: ninguna prendida' 'paquete del stack por defecto: none (de fábrica)' 'controles que frenan registrados: 1 (en cualquier repo: lab-hook.js)'; do
  [ "$(printf '%s' "$JSON" | jtxt "any(o.startswith('$linea') for o in d['ok'])")" = True ] && ok "T49 dice «${linea}»" || mal "T49 no dice «${linea}»: $(printf '%s' "$JSON" | jtxt "[o for o in d['ok'] if 'perfil' in o or 'integra' in o or 'paquete' in o or 'frenan' in o]")"
done
# full con engram prendida
printf '{ "install": { "profile": "full" }, "integrations": { "engram": true } }\n' > "$LAB_HOME/.claude/tycon.json"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any(o.startswith('integraciones: engram (~/.claude/tycon.json)') for o in d['ok']) and d['integrations']['engram']['state'] == 'prendida'")" = True ] \
  && ok "T49 full con engram: la integración prendida con su origen (texto y --json)" || mal "T49 full con engram: $(printf '%s' "$JSON" | jtxt "[o for o in d['ok'] if 'integra' in o]") $(printf '%s' "$JSON" | jtxt "d['integrations']")"
[ "$(printf '%s' "$JSON" | jtxt "any('perfil sin elegir' in w for w in d['warn'])")" = False ] && ok "T49 espejo: con el perfil elegido no avisa «perfil sin elegir»" || mal "T49 avisa «perfil sin elegir» con el perfil elegido"
# una instalación sin perfil elegido (sin archivo y sin perfil del equipo): avisa que se comporta como full
rm -f "$LAB_HOME/.claude/tycon.json"
JSON="$(TYCON_PROFILE=0 harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any(w.startswith('perfil sin elegir: esta instalación se comporta como full') and '--profile minimal|full' in w for w in d['warn'])")" = True ] \
  && ok "T49 sin perfil elegido: el aviso con cómo elegirlo" || mal "T49 sin perfil elegido: warn=$(printf '%s' "$JSON" | jtxt "d['warn']")"
SALIDA="$(TYCON_PROFILE=0 harness doctor 2>&1)"
case "$SALIDA" in *"perfil sin elegir"*"integraciones:"*|*"integraciones:"*"perfil sin elegir"*) ok "T49 …y la salida para una persona también lo dice" ;; *) mal "T49 la salida de texto no lo dice" ;; esac

# ── T9 Doctor_ActivePackMissing_Red ─────────────────────────────────────────────────────────────────────────────────
# un paquete que `packs.default` pide y no está instalado: rojo, y doctor sale distinto de 0, aunque no haya NINGÚN
# paquete instalado (el caso medido: el paquete se borró con la actualización y doctor seguía en verde). `all` y `none`
# no son nombres: no frenan. El mensaje dice de dónde sale el pedido y qué hacer.
echo "T9 · doctor: un paquete activo que falta"
printf '{ "install": { "profile": "minimal" }, "packs": { "default": ["mi-stack"] } }\n' > "$LAB_HOME/.claude/tycon.json"
JSON="$(harness doctor --json 2>/dev/null)"; harness doctor >/dev/null 2>&1; RC9=$?
[ "$(printf '%s' "$JSON" | jtxt "any('mi-stack' in f and 'no está instalado' in f for f in d['fail'])")" = True ] && [ "$RC9" -ne 0 ] \
  && ok "T9 packs.default pide «mi-stack» y no está: rojo y doctor sale $RC9" || mal "T9 paquete que falta (rc $RC9): fail=$(printf '%s' "$JSON" | jtxt "d['fail']") warn=$(printf '%s' "$JSON" | jtxt "[w for w in d['warn'] if 'paquete' in w]")"
[ "$(printf '%s' "$JSON" | jtxt "any('mi-stack' in f and 'configuración de esta máquina' in f and 'team-init --local' in f for f in d['fail'])")" = True ] \
  && ok "T9 el rojo dice de dónde sale el pedido (la máquina) y qué hacer (el repo del perfil con team-init --local)" || mal "T9 el texto: $(printf '%s' "$JSON" | jtxt "d['fail']")"
for v in '"all"' '"none"'; do
  printf '{ "install": { "profile": "minimal" }, "packs": { "default": %s } }\n' "$v" > "$LAB_HOME/.claude/tycon.json"
  JSON="$(harness doctor --json 2>/dev/null)"
  [ "$(printf '%s' "$JSON" | jtxt "any('no está instalado' in f for f in d['fail'])")" = False ] && ok "T9 espejo: packs.default $v no frena" || mal "T9 $v frena: $(printf '%s' "$JSON" | jtxt "d['fail']")"
done
rm -f "$LAB_HOME/.claude/tycon.json"

# ── T6 Doctor_PublicPlusLayerEqualsInternal_CompatByTransformedList_VersionWithoutTransformedRed_IgnoredNotCounted_
#    MinimumLag_ReadOnly (story 8.13.1, tanda A · AC 5; y el subcomando `layer` del AC 1 y 10) ─────────────────────────
# Una máquina CON capa, armada a mano en el laboratorio (la tanda A no instala desde la copia pública: eso es la B). El
# árbol del laboratorio hace de «copia pública»: trae version.json con su lista de transformados, LICENSE y las tres listas
# declaradas de la capa. El «interno» de juguete es esa copia sin lo de «sólo afuera», con el transformado entero y con lo
# privado (un plan, una guía privada dentro de guides/, una skill de un producto y un instinto, que es de los escritores).
# Su clon de lectura (--bare) va a la carpeta del mecanismo, la capa se apila con layer.js y el estado gana la fuente
# `internal`. doctor tiene que probar, sin escribir nada, que público + capa = interno.
echo "T6 · doctor y layer con capa"
harness_lab_create "$BASE/lab-capa" >/dev/null
A6="$LAB_AUTHOR_TREE"
mkdir -p "$A6/guides" "$A6/scripts/tests/fixtures"
for f in layer-public-wins layer-public-only harness-tree-writers; do cp "$RAIZ/scripts/tests/fixtures/$f.json" "$A6/scripts/tests/fixtures/"; done
# qué publica el commit de la capa lo dice la clasificación del exportador (AC 5): sus guiones, y la lista blanca y la
# tabla de juguete, que el interno trae (la copia también: así son iguales, no agregados)
mkdir -p "$A6/scripts/publishing"; cp "$RAIZ"/scripts/publishing/*.js "$A6/scripts/publishing/"
cp "$RAIZ/scripts/tests/fixtures/layer-lab-allowlist.json" "$A6/scripts/publishing/allowlist.json"
cp "$RAIZ/scripts/tests/fixtures/layer-lab-table.json" "$A6/scripts/publishing/replacements.json"
printf '# guía pública\n' > "$A6/guides/public.md"
printf '.dashboard/\n.codegraph/\n' > "$A6/.gitignore"
printf 'licencia de juguete\n' > "$A6/LICENSE"
version6() { # version6 <archivo> [sin-lista]  — el version.json de la copia, con o sin la lista de transformados
  if [ "${2:-}" = sin-lista ]; then printf '{ "version": "2026.10.06.1", "source": { "harness": "%040d" } }\n' 1 > "$1"
  else printf '{ "version": "2026.10.06.1", "source": { "harness": "%040d" }, "transformed": [ { "path": "guides/public.md", "transform": "toy-trim" } ] }\n' 1 > "$1"; fi
}
version6 "$A6/version.json"
harness_lab_git "$A6" add -A >/dev/null
harness_lab_git "$A6" commit -q -m "la copia pública de juguete" >/dev/null
harness_lab_git "$A6" push -q origin main >/dev/null 2>&1
harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
# el interno: la copia sin lo de afuera, el transformado entero y lo privado
INT6="$LAB/author/internal"; INT6_REMOTE="$LAB/remotes/internal.git"
harness_lab_git "$LAB/author" clone -q "$LAB_REMOTE_TREE" "$INT6" >/dev/null 2>&1
harness_lab_git "$INT6" rm -q LICENSE version.json >/dev/null
printf 'una línea que el exportador saca\n' >> "$INT6/guides/public.md"
mkdir -p "$INT6/tasks" "$INT6/skills/projects/acme" "$INT6/inbox/instincts/pending" "$INT6/guides/maintaining"
printf '# plan privado\n' > "$INT6/tasks/plan.md"
printf '# casos con nombre\n' > "$INT6/guides/maintaining/incident-log.md"
printf '# skill de un producto\n' > "$INT6/skills/projects/acme/SKILL.md"
printf '# instinto pendiente\n' > "$INT6/inbox/instincts/pending/lab.md"
harness_lab_git "$INT6" add -A >/dev/null
GIT_AUTHOR_DATE=2026-10-06T00:00:00Z GIT_COMMITTER_DATE=2026-10-06T00:00:00Z harness_lab_git "$INT6" commit -q -m "el interno de juguete" >/dev/null
harness_lab_git "$LAB/remotes" clone -q --bare "$INT6" "$INT6_REMOTE" >/dev/null 2>&1
harness_lab_git "$INT6" remote set-url origin "$INT6_REMOTE"
INT6_COMMIT="$(harness_lab_git "$INT6" rev-parse HEAD)"
harness install --yes >/dev/null 2>&1 || mal "T6 install previo falló"
MECH6="$LAB_HOME/.claude/.tycon-pipeline/harness"
READ6="$MECH6/sources/internal"; MANIFEST6="$MECH6/layer.json"; ESTADO6="$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"
mkdir -p "$MECH6/sources"
harness_lab_git "$MECH6/sources" clone -q --bare "$INT6_REMOTE" "$READ6" >/dev/null 2>&1
# sin fuentes layer: doctor como siempre (ni una línea de la capa, ni la clave), y `layer` dice «sin capa» con 3
JSON="$(harness doctor --json 2>/dev/null)"
PLACE6="$(printf '%s' "$JSON" | jtxt "d['place']")"
[ "$(printf '%s' "$JSON" | jtxt "('layer' in d, any(t.startswith('capa') for t in d['ok']+d['warn']+d['fail']))")" = "(False, False)" ] \
  && ok "T6 sin fuentes layer: doctor sin la clave «layer» ni líneas de la capa" || mal "T6 sin fuentes layer doctor habla de la capa: $JSON"
harness layer --check >/dev/null 2>&1; RC=$?
[ "$RC" = 3 ] && ok "T6 layer --check sin capa: 3" || mal "T6 layer --check sin capa: rc $RC"
# apilar la capa y registrarla en el estado (lo que en la tanda B harán migrate y update)
LAYERJS6="$LAB_TREE/scripts/setup/harness/layer.js"
node "$LAYERJS6" compute --internal "$READ6" --public "$LAB_TREE" --out "$LAB/layer-list.json" >/dev/null 2>&1 || mal "T6 layer.js compute falló"
node "$LAYERJS6" apply --tree "$LAB_TREE" --from "$READ6" --list "$LAB/layer-list.json" --manifest "$MANIFEST6" >/dev/null 2>&1 || mal "T6 layer.js apply falló"
state6() { # state6 <clave>=<valor json>…  — cambia el estado del laboratorio (las claves con punto: fuente.campo)
  python3 - "$ESTADO6" "$@" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p, encoding="utf-8"))
for kv in sys.argv[2:]:
    k, v = kv.split("=", 1); v = json.loads(v)
    if "." in k:
        name, field = k.split(".", 1)
        if field.startswith("layer:"): d["layer"][field[6:]] = v; continue
        [s for s in d["sources"] if s["name"] == name][0][field] = v
    elif k == "add-source": d["sources"].append(v)
    else: d[k] = v
json.dump(d, open(p, "w", encoding="utf-8"), indent=2)
PY
}
state6 source='"public"' \
  add-source="{\"name\": \"internal\", \"kind\": \"layer\", \"url\": \"$INT6_REMOTE\", \"ref\": \"main\", \"rewrites\": false, \"dir\": \"$READ6\", \"commit\": \"$INT6_COMMIT\", \"previous\": null}" \
  layer="{\"manifest\": \"$MANIFEST6\", \"version\": \"2026.10.06.1\", \"at\": \"2026-10-06T00:00:00Z\", \"minimum\": false, \"lag_hours\": null}"
mkdir -p "$LAB_TREE/.codegraph" && printf 'índice\n' > "$LAB_TREE/.codegraph/db"   # ignorado por el .gitignore público
# doctor de sólo lectura en CADA corrida: el HOME (con el clon de lectura y el manifiesto), el árbol y su índice, por hash
RO6=1
doctor6() { # doctor6 [--text]  — deja la salida en JSON (o SALIDA) y RC, y anota si algo cambió
  local h w i
  h="$(harness_lab_home_hash)"; w="$(harness_lab_worktree_hash "$LAB_TREE")"; i="$(shasum -a 256 < "$LAB_TREE/.git/index")"
  if [ "${1:-}" = --text ]; then SALIDA="$(harness doctor 2>&1)"; RC=$?; else JSON="$(harness doctor --json 2>/dev/null)"; RC=$?; fi
  [ "$(harness_lab_home_hash)" = "$h" ] && [ "$(harness_lab_worktree_hash "$LAB_TREE")" = "$w" ] && [ "$(shasum -a 256 < "$LAB_TREE/.git/index")" = "$i" ] || RO6=0
}
SUM6='capa: 3 agregados, 1 pisados (transformados), 0 a mano, todo en su lugar'
# la capa entera: «todo en su lugar», sin rojos, lo ignorado no cuenta, y `place` no cambia
doctor6
[ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && ok "T6 capa entera: doctor 0 y sin rojos" || mal "T6 capa entera: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
[ "$(printf '%s' "$JSON" | jtxt "'$SUM6' in d['ok']")" = True ] && ok "T6 capa entera: «${SUM6}»" || mal "T6 capa entera sin el resumen: $(printf '%s' "$JSON" | jtxt "[t for t in d['ok']+d['warn']+d['fail'] if 'capa' in t]")"
[ "$(printf '%s' "$JSON" | jtxt "any('.codegraph/' in t for t in d['ok']+d['warn']+d['fail'])")" = False ] && ok "T6 el .codegraph/ ignorado no se cuenta ni se nombra" || mal "T6 doctor nombra lo ignorado"
[ "$(printf '%s' "$JSON" | jtxt "d['place']")" = "$PLACE6" ] && ok "T6 las líneas de la capa no tocan «place»" || mal "T6 «place» cambió con la capa: $(printf '%s' "$JSON" | jtxt "d['place']") (antes $PLACE6)"
[ "$(printf '%s' "$JSON" | jtxt "[(x['name'], x['added'], x['overwritten'], x['hand_edited'], x['missing'], x['foreign']) for x in d['layer']]")" = "[('internal', 3, 1, [], [], [])]" ] \
  && ok "T6 --json: la clave «layer» con la fuente y las cuentas" || mal "T6 --json layer: $(printf '%s' "$JSON" | jtxt "d.get('layer')")"
[ "$(printf '%s' "$JSON" | jtxt "any('no_push' in t or 'pre-push' in t for t in d['ok']+d['warn']+d['fail'])")" = False ] && ok "T6 sin árbol gestionado no mira no_push ni pre-push" || mal "T6 mira no_push/pre-push sin árbol gestionado"
doctor6 --text
case "$SALIDA" in *"$SUM6"*) ok "T6 …y la salida de texto lo dice" ;; *) mal "T6 la salida de texto no trae el resumen: $SALIDA" ;; esac
# un archivo de los escritores cambiado por la máquina: ni «a mano» ni «no viene de ninguna fuente»
printf 'lo escribió el observador\n' >> "$LAB_TREE/inbox/instincts/pending/lab.md"
doctor6
[ "$(printf '%s' "$JSON" | jtxt "'$SUM6' in d['ok']")" = True ] && ok "T6 un archivo de los escritores cambiado no cuenta" || mal "T6 el de los escritores cuenta: $(printf '%s' "$JSON" | jtxt "[t for t in d['warn']+d['fail'] if 'lab.md' in t]")"
# `layer` es el mismo chequeo: --check 0, --list nombra lo agregado y lo pisado
harness layer --check >/dev/null 2>&1; RC=$?
[ "$RC" = 0 ] && ok "T6 layer --check con la capa entera: 0" || mal "T6 layer --check entera: rc $RC"
SALIDA="$(harness layer --list 2>&1)"
case "$SALIDA" in *"tasks/plan.md"*"guides/public.md"*|*"guides/public.md"*"tasks/plan.md"*) ok "T6 layer --list nombra lo agregado y lo pisado" ;; *) mal "T6 layer --list: $SALIDA" ;; esac
# un archivo de la capa borrado: nombrado, rojo, y layer --check 1
mv "$LAB_TREE/tasks/plan.md" "$LAB/plan.md"
doctor6
[ "$RC" = 1 ] && [ "$(printf '%s' "$JSON" | jtxt "any('falta' in t and 'tasks/plan.md' in t for t in d['fail'])")" = True ] && ok "T6 un archivo de la capa borrado: rojo que lo nombra" || mal "T6 borrado: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
harness layer --check >/dev/null 2>&1; RC=$?
[ "$RC" = 1 ] && ok "T6 layer --check con un archivo que falta: 1" || mal "T6 layer --check con faltante: rc $RC"
mv "$LAB/plan.md" "$LAB_TREE/tasks/plan.md"
# uno editado a mano: «a mano», contado, nombrado
cp "$LAB_TREE/guides/maintaining/incident-log.md" "$LAB/incident-log.md"
printf 'una nota mía\n' >> "$LAB_TREE/guides/maintaining/incident-log.md"
doctor6
[ "$(printf '%s' "$JSON" | jtxt "any('a mano' in t and 'guides/maintaining/incident-log.md' in t for t in d['warn'])")" = True ] && ok "T6 uno editado: «a mano» con la ruta" || mal "T6 editado: warn=$(printf '%s' "$JSON" | jtxt "d['warn']")"
[ "$(printf '%s' "$JSON" | jtxt "any(t.startswith('capa: 3 agregados, 1 pisados (transformados), 1 a mano') and 'todo en su lugar' not in t for t in d['ok']+d['warn'])")" = True ] && ok "T6 …el resumen cuenta 1 a mano y no dice «todo en su lugar»" || mal "T6 resumen con uno a mano: $(printf '%s' "$JSON" | jtxt "[t for t in d['ok']+d['warn'] if t.startswith('capa')]")"
harness layer --check >/dev/null 2>&1; RC=$?
[ "$RC" = 1 ] && ok "T6 layer --check con uno a mano: 1" || mal "T6 layer --check a mano: rc $RC"
cp "$LAB/incident-log.md" "$LAB_TREE/guides/maintaining/incident-log.md"
# un archivo ajeno en guides/: «no viene de ninguna fuente»
printf 'suelto\n' > "$LAB_TREE/guides/stray.md"
doctor6
[ "$(printf '%s' "$JSON" | jtxt "any('no viene de ninguna fuente' in t and 'guides/stray.md' in t for t in d['warn']+d['fail'])")" = True ] && ok "T6 un archivo ajeno en guides/: «no viene de ninguna fuente»" || mal "T6 ajeno: $(printf '%s' "$JSON" | jtxt "d['warn']+d['fail']")"
harness layer --check >/dev/null 2>&1; RC=$?
[ "$RC" = 1 ] && ok "T6 layer --check con un archivo que sobra: 1" || mal "T6 layer --check con uno que sobra: rc $RC"
rm -f "$LAB_TREE/guides/stray.md"
# (pase adversarial de la tanda A, clase 8) un pisado que volvió al contenido público (un checkout o un reset en el
# árbol): a la capa le falta ese archivo —rojo, capa incompleta—, no es «editado a mano» (la capa SÍ lo vuelve a pisar)
cp "$LAB_TREE/guides/public.md" "$LAB/public-pisado.md"
harness_lab_git "$LAB_TREE" checkout -q -- guides/public.md
doctor6
[ "$RC" = 1 ] && [ "$(printf '%s' "$JSON" | jtxt "[(x['hand_edited'], x['stale']) for x in d['layer']]")" = "[([], ['guides/public.md'])]" ] \
  && [ "$(printf '%s' "$JSON" | jtxt "any('guides/public.md' in t and 'a mano' in t for t in d['warn'])")" = False ] \
  && ok "T6 un pisado que volvió al público: rojo de capa incompleta, no «a mano»" || mal "T6 pisado vuelto al público: rc $RC $(printf '%s' "$JSON" | jtxt "[(x['hand_edited'], x['stale']) for x in d['layer']], [t for t in d['warn']+d['fail'] if 'public.md' in t]")"
harness layer --check >/dev/null 2>&1; RC=$?
[ "$RC" = 1 ] && ok "T6 layer --check con un pisado vuelto al público: 1" || mal "T6 layer --check pisado vuelto al público: rc $RC"
cp "$LAB/public-pisado.md" "$LAB_TREE/guides/public.md"
# (clase 12) un archivo que la copia pública misma sigue —un papel que el exportador agrega sólo a la copia y que la
# lista «sólo afuera» todavía no nombra— viene del público: no es «no viene de ninguna fuente»
mkdir -p "$LAB_TREE/docs"; printf '# sólo en la copia\n' > "$LAB_TREE/docs/solo-en-la-copia.md"
harness_lab_git "$LAB_TREE" add docs/solo-en-la-copia.md >/dev/null
harness_lab_git "$LAB_TREE" commit -q -m "un papel que trae sólo la copia" >/dev/null
state6 harness.commit="\"$(harness_lab_git "$LAB_TREE" rev-parse HEAD)\""
doctor6
[ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | jtxt "[x['foreign'] for x in d['layer']]")" = "[[]]" ] && [ "$(printf '%s' "$JSON" | jtxt "'$SUM6' in d['ok']")" = True ] \
  && ok "T6 un archivo que la copia pública sigue: viene del público, «todo en su lugar»" || mal "T6 seguido por la copia: rc $RC foreign=$(printf '%s' "$JSON" | jtxt "[x['foreign'] for x in d['layer']]") $(printf '%s' "$JSON" | jtxt "[t for t in d['warn']+d['fail'] if 'solo-en-la-copia' in t or 'capa' in t]")"
harness layer --check >/dev/null 2>&1; RC=$?
[ "$RC" = 0 ] && ok "T6 layer --check con un archivo que la copia sigue: 0" || mal "T6 layer --check seguido por la copia: rc $RC"
harness_lab_git "$LAB_TREE" reset -q --soft HEAD~1 >/dev/null
harness_lab_git "$LAB_TREE" rm -q --cached docs/solo-en-la-copia.md >/dev/null
rm -rf "$LAB_TREE/docs"
state6 harness.commit="\"$(harness_lab_git "$LAB_TREE" rev-parse HEAD)\""
# (C6) un layer.json ilegible no es «no hay capa»: es un problema que se dice, rojo, y layer --check 1
cp "$MANIFEST6" "$LAB/layer.json.bak"; printf '{ roto' > "$MANIFEST6"
doctor6
[ "$RC" = 1 ] && [ "$(printf '%s' "$JSON" | jtxt "any('el manifiesto de la capa no se puede leer' in t for t in d['fail'])")" = True ] \
  && ok "T6 un layer.json ilegible: rojo «el manifiesto de la capa no se puede leer»" || mal "T6 manifiesto roto: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']") warn=$(printf '%s' "$JSON" | jtxt "[t for t in d['warn'] if 'capa' in t]")"
harness layer --check >/dev/null 2>&1; RC=$?
[ "$RC" = 1 ] && ok "T6 layer --check con el manifiesto roto: 1" || mal "T6 layer --check manifiesto roto: rc $RC"
cp "$LAB/layer.json.bak" "$MANIFEST6"
# (clases 1 y 15, del lado de doctor) lo que el exportador agrega sólo a la copia sale de la lista blanca del commit
# interno (`outsideMatcher` de layer.js), no sólo de la lista a mano: un destino `synthetic` que la lista a mano no nombra
# no es «no viene de ninguna fuente». La lista blanca nueva entra igual al interno y a la copia (así no difiere)
python3 - "$INT6/scripts/publishing/allowlist.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p, encoding="utf-8"))
d["synthetic"] = [{"target": "docs/papel.md", "from": "guides/public.md", "reason": "un papel de juguete que sólo trae la copia"}]
json.dump(d, open(p, "w", encoding="utf-8"), indent=2)
PY
cp "$INT6/scripts/publishing/allowlist.json" "$LAB_TREE/scripts/publishing/allowlist.json"
harness_lab_git "$INT6" commit -q -am "un sintético en la lista blanca" >/dev/null
harness_lab_git "$INT6" push -q origin main >/dev/null 2>&1
harness_lab_git "$READ6" fetch -q origin '+refs/heads/*:refs/heads/*' >/dev/null 2>&1
harness_lab_git "$LAB_TREE" commit -q -m "la lista blanca con el sintético" -- scripts/publishing/allowlist.json >/dev/null
state6 internal.commit="\"$(harness_lab_git "$INT6" rev-parse HEAD)\"" harness.commit="\"$(harness_lab_git "$LAB_TREE" rev-parse HEAD)\""
mkdir -p "$LAB_TREE/docs"; printf '# papel\n' > "$LAB_TREE/docs/papel.md"
doctor6
[ "$(printf '%s' "$JSON" | jtxt "[x['foreign'] for x in d['layer']]")" = "[[]]" ] && [ "$(printf '%s' "$JSON" | jtxt "'$SUM6' in d['ok']")" = True ] \
  && ok "T6 un destino «synthetic» de la lista blanca del interno: sólo afuera, no «no viene de ninguna fuente»" || mal "T6 sintético: rc $RC foreign=$(printf '%s' "$JSON" | jtxt "[x['foreign'] for x in d['layer']]") $(printf '%s' "$JSON" | jtxt "[t for t in d['warn']+d['fail'] if 'papel' in t or 'capa' in t]")"
rm -rf "$LAB_TREE/docs"
harness_lab_git "$LAB_TREE" reset -q --soft HEAD~1 >/dev/null
harness_lab_git "$LAB_TREE" checkout -q HEAD -- scripts/publishing/allowlist.json >/dev/null
harness_lab_git "$INT6" reset -q --hard HEAD~1 >/dev/null
harness_lab_git "$INT6" push -q -f origin main >/dev/null 2>&1
harness_lab_git "$READ6" fetch -q -f origin '+refs/heads/*:refs/heads/*' >/dev/null 2>&1
state6 internal.commit="\"$INT6_COMMIT\"" harness.commit="\"$(harness_lab_git "$LAB_TREE" rev-parse HEAD)\""
# (clase 6, del lado de doctor) un agregado que el interno borró y la persona editó queda en el manifiesto marcado
# `held` (layer.js): doctor lo cuenta «a mano» aunque su carpeta siga excluida, y layer --check sale 1
printf 'mi nota en el plan\n' >> "$LAB_TREE/tasks/plan.md"
harness_lab_git "$INT6" checkout -q -b sin-plan >/dev/null 2>&1
harness_lab_git "$INT6" rm -q tasks/plan.md >/dev/null
printf '#!/bin/sh\n' > "$INT6/tasks/run.sh"
harness_lab_git "$INT6" add tasks/run.sh >/dev/null
harness_lab_git "$INT6" commit -q -m "el interno borra el plan" >/dev/null
harness_lab_git "$INT6" push -q origin sin-plan >/dev/null 2>&1
harness_lab_git "$READ6" fetch -q origin '+refs/heads/*:refs/heads/*' >/dev/null 2>&1
node "$LAYERJS6" compute --internal "$READ6" --internal-commit sin-plan --public "$LAB_TREE" --out "$LAB/layer-list-sin-plan.json" >/dev/null 2>&1 || mal "T6 compute sin el plan falló"
node "$LAYERJS6" apply --tree "$LAB_TREE" --from "$READ6" --list "$LAB/layer-list-sin-plan.json" --manifest "$MANIFEST6" >/dev/null 2>&1
state6 internal.commit="\"$(harness_lab_git "$INT6" rev-parse HEAD)\""
doctor6
[ "$(printf '%s' "$JSON" | jtxt "[(x['hand_edited'], x['foreign']) for x in d['layer']]")" = "[(['tasks/plan.md'], [])]" ] && [ "$(printf '%s' "$JSON" | jtxt "any('a mano' in t and 'tasks/plan.md' in t for t in d['warn'])")" = True ] \
  && ok "T6 un agregado que el interno borró y está editado a mano (held): doctor lo cuenta «a mano», una sola vez" || mal "T6 held: rc $RC hand/foreign=$(printf '%s' "$JSON" | jtxt "[(x['hand_edited'], x['foreign']) for x in d['layer']]") $(printf '%s' "$JSON" | jtxt "[t for t in d['warn']+d['fail'] if 'capa' in t]")"
harness layer --check >/dev/null 2>&1; RC=$?
[ "$RC" = 1 ] && ok "T6 layer --check con un held: 1" || mal "T6 layer --check held: rc $RC"
printf '# plan privado\n' > "$LAB_TREE/tasks/plan.md"
harness_lab_git "$INT6" checkout -q main >/dev/null 2>&1
node "$LAYERJS6" apply --tree "$LAB_TREE" --from "$READ6" --list "$LAB/layer-list.json" --manifest "$MANIFEST6" >/dev/null 2>&1 || mal "T6 re-apilar la capa original falló"
state6 internal.commit="\"$INT6_COMMIT\""
doctor6
[ "$(printf '%s' "$JSON" | jtxt "'$SUM6' in d['ok']")" = True ] || mal "T6 tras el held la capa no volvió entera: $(printf '%s' "$JSON" | jtxt "[t for t in d['ok']+d['warn']+d['fail'] if 'capa' in t or 'tasks' in t]")"
# `layer --public <copia> --harness-clone <clon>` (AC 10): calcula contra lo que le dan, sin tocar el estado ni el HOME
H6="$(harness_lab_home_hash)"
JSON="$(harness layer --check --json --public "$LAB_TREE" --harness-clone "$INT6" 2>/dev/null)"; RC=$?
[ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | jtxt "(sorted(d['add']), d['overwrite'], d['otherVersion'], d['onlyPublic']['undeclared'])")" = "(['guides/maintaining/incident-log.md', 'inbox/instincts/pending/lab.md', 'skills/projects/acme/SKILL.md', 'tasks/plan.md'], ['guides/public.md'], [], [])" ] \
  && ok "T6 layer --check --json --public … --harness-clone …: el complemento, 0" || mal "T6 layer con rutas: rc $RC $JSON"
[ "$(harness_lab_home_hash)" = "$H6" ] && ok "T6 …sin tocar el estado ni el HOME" || mal "T6 layer con rutas escribió en el HOME"
# un commit de la capa con un archivo público distinto que no está entre los transformados: «capa de otra versión»
harness_lab_git "$INT6" checkout -q -b otra >/dev/null 2>&1
printf 'cambio que el público no tiene\n' >> "$INT6/README.md"
harness_lab_git "$INT6" commit -q -am "otra versión" >/dev/null
harness_lab_git "$INT6" push -q origin otra >/dev/null 2>&1
harness_lab_git "$READ6" fetch -q origin '+refs/heads/*:refs/heads/*' >/dev/null 2>&1
state6 internal.commit="\"$(harness_lab_git "$INT6" rev-parse HEAD)\""
doctor6
[ "$RC" = 1 ] && [ "$(printf '%s' "$JSON" | jtxt "any('capa de otra versión' in t and 'README.md' in t for t in d['fail'])")" = True ] && ok "T6 un público distinto no transformado: rojo «capa de otra versión» con la ruta" || mal "T6 otra versión: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
harness layer --check >/dev/null 2>&1; RC=$?
[ "$RC" = 1 ] && ok "T6 layer --check con la capa de otra versión: 1" || mal "T6 layer --check otra versión: rc $RC"
state6 internal.commit="\"$INT6_COMMIT\""
harness_lab_git "$INT6" checkout -q main >/dev/null 2>&1
# un version.json sin la lista de transformados: rojo con ese texto (y `layer` con rutas tampoco calcula)
version6 "$LAB_TREE/version.json" sin-lista
harness_lab_git "$LAB_TREE" commit -q -m "versión sin la lista" version.json >/dev/null
state6 harness.commit="\"$(harness_lab_git "$LAB_TREE" rev-parse HEAD)\""
doctor6
[ "$RC" = 1 ] && [ "$(printf '%s' "$JSON" | jtxt "any('la versión pública no trae la lista de transformados' in t for t in d['fail'])")" = True ] && ok "T6 version.json sin «transformed»: rojo «la versión pública no trae la lista de transformados»" || mal "T6 sin transformed: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
harness layer --check --public "$LAB_TREE" --harness-clone "$INT6" >/dev/null 2>&1; RC=$?
[ "$RC" = 1 ] && ok "T6 layer --check --public sobre una copia sin la lista: 1" || mal "T6 layer --public sin la lista: rc $RC"
harness_lab_git "$LAB_TREE" reset -q --soft HEAD~1 >/dev/null
harness_lab_git "$LAB_TREE" checkout -q HEAD -- version.json >/dev/null
state6 harness.commit="\"$(harness_lab_git "$LAB_TREE" rev-parse HEAD)\""
# el árbol gestionado (en la tanda A existe sólo acá): pushurl no_push y el pre-push; cambiados, rojo
GITDIR6="$LAB_TREE/.git"
: > "$GITDIR6/tycon-managed"
harness_lab_git "$LAB_TREE" remote set-url --push origin no_push
printf '#!/bin/sh\necho "el árbol gestionado no empuja" >&2\nexit 1\n' > "$GITDIR6/hooks/pre-push"; chmod +x "$GITDIR6/hooks/pre-push"
doctor6
[ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | jtxt "any('no_push' in t for t in d['ok']) and any('pre-push' in t for t in d['ok'])")" = True ] && ok "T6 árbol gestionado sano: no_push y pre-push en verde" || mal "T6 árbol gestionado sano: rc $RC $(printf '%s' "$JSON" | jtxt "[t for t in d['ok']+d['fail'] if 'push' in t]")"
harness_lab_git "$LAB_TREE" remote set-url --push origin "$LAB_REMOTE_TREE"
doctor6
[ "$RC" = 1 ] && [ "$(printf '%s' "$JSON" | jtxt "any('no_push' in t for t in d['fail'])")" = True ] && ok "T6 pushurl cambiado: rojo no_push" || mal "T6 pushurl cambiado: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
harness_lab_git "$LAB_TREE" remote set-url --push origin no_push
mv "$GITDIR6/hooks/pre-push" "$LAB/pre-push"
doctor6
[ "$RC" = 1 ] && [ "$(printf '%s' "$JSON" | jtxt "any('pre-push' in t for t in d['fail'])")" = True ] && ok "T6 pre-push borrado: rojo pre-push" || mal "T6 pre-push borrado: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
mv "$LAB/pre-push" "$GITDIR6/hooks/pre-push"
# la capa al mínimo, con `main` interno 30 horas adelante: amarillo con las horas
printf '# otro plan\n' > "$INT6/tasks/next.md"
harness_lab_git "$INT6" add -A >/dev/null
GIT_AUTHOR_DATE=2026-10-07T06:00:00Z GIT_COMMITTER_DATE=2026-10-07T06:00:00Z harness_lab_git "$INT6" commit -q -m "main interno avanza" >/dev/null
harness_lab_git "$INT6" push -q origin main >/dev/null 2>&1
harness_lab_git "$READ6" fetch -q origin '+refs/heads/*:refs/heads/*' >/dev/null 2>&1
state6 internal.layer:minimum=true
doctor6
[ "$(printf '%s' "$JSON" | jtxt "any('capa al mínimo' in t and '30 horas' in t for t in d['warn'])")" = True ] && ok "T6 layer.minimum con main interno 30 h adelante: amarillo con las horas" || mal "T6 mínimo: $(printf '%s' "$JSON" | jtxt "[t for t in d['ok']+d['warn']+d['fail'] if 'mínimo' in t]")"
[ "$RO6" = 1 ] && ok "T6 doctor no escribió nada en ninguna corrida (HOME, árbol e índice idénticos por hash)" || mal "T6 alguna corrida de doctor escribió algo"
# la línea de comandos: `layer` con una opción que no existe es 2; install --harness-clone con una ruta que no es un clon, 2
harness layer --bogus >/dev/null 2>&1; RC=$?
[ "$RC" = 2 ] && ok "T6 layer con una opción que no existe: 2" || mal "T6 layer --bogus: rc $RC"
H6="$(harness_lab_home_hash)"
harness install --yes --harness-clone "$BASE/no-existe" >/dev/null 2>&1; RC=$?
[ "$RC" = 2 ] && [ "$(harness_lab_home_hash)" = "$H6" ] && ok "T6 install --harness-clone con una ruta que no es un clon: 2 sin escribir nada" || mal "T6 install --harness-clone inválido: rc $RC"
SALIDA="$(harness install --dry-run --harness-clone "$INT6" 2>&1)"; RC=$?
[ "$RC" = 0 ] && case "$SALIDA" in *"capa privada: --harness-clone"*"sin efecto"*"source: internal"*) true ;; *) false ;; esac && ok "T6 install --dry-run --harness-clone <clon>: 0 y dice qué pasa con la capa" || mal "T6 install --harness-clone válido: rc $RC $SALIDA"
SALIDA="$(harness --help 2>&1)"
case "$SALIDA" in *"layer"*"--harness-clone"*|*"--harness-clone"*"layer"*) ok "T6 --help lista layer e install --harness-clone" ;; *) mal "T6 --help: $SALIDA" ;; esac

# ── T79 (story 8.26, tanda H1c · AC 65 d): doctor nombra el freno antes de publicar ──────────────────────────────────
# El freno antes de publicar es lo único que hay entre un nombre real y el repo público, y doctor no decía nada de él: ni
# si el `pre-push` está en la carpeta GLOBAL de hooks de git, ni de dónde sale la lista, ni qué clon de mantenimiento
# declara la máquina, ni si esa lista está al día. Lo que no puede pasar:
#   · un ROJO nuevo. La comprobación de salud de una actualización corre `doctor --json` y un `fail` la tira abajo: un
#     rojo acá frenaría las actualizaciones de toda máquina sin el `pre-push` (perfil mínimo, TYCON_NO_GIT_HOOKS=1, sin
#     carpeta global de hooks). Todo es dato o aviso, y el código de salida es el mismo que sin la pieza;
#   · que la respuesta dependa de la carpeta desde la que se corre (se mira la carpeta global, no el hook de un repo);
#   · que escriba algo, o que cite un término de la lista, el asunto de un commit o el nombre de una rama del repo privado.
# La configuración global de git es SIEMPRE un archivo del laboratorio (GIT_CONFIG_GLOBAL): nunca la de quien corre esto.
T79="T79 MaintainerMachine_CommitLooksWithMachineList_DoctorNamesGuard_HooksPathElsewhereWarned_StaleListWarned —"
echo "T79 · doctor y el freno antes de publicar"
T79_TERM="Zorblax"                 # inventado: el único término de la lista de juguete
T79_MARK="Xilofago77"              # inventado: va en el asunto de los commits y en el nombre de la rama principal del clon privado
T79_MAIN="principal-$T79_MARK"
harness_lab_create "$BASE/t79" >/dev/null
harness install --yes >/dev/null 2>&1 || mal "$T79 install previo falló"
# las líneas de la pieza en un nivel de --json; y todo lo que doctor dice, junto
t79_lines() { printf '%s' "$1" | jtxt "' | '.join(t for t in d['$2'] if 'freno antes de publicar' in t or 'memoria del trabajo' in t)"; }
t79_has() { [ "$(printf '%s' "$1" | jtxt "any(($3) for t in d['$2'] if 'freno antes de publicar' in t or 'memoria del trabajo' in t)")" = True ]; }
t79_list() { node -e 'const fs=require("fs"),p=require("path");fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],JSON.stringify({terminos:[{patron:process.argv[2],categoria:"cliente"}],permitidos:JSON.parse(process.argv[3]||"[]")},null,2)+"\n")' "$@"; }
t79_config() { mkdir -p "$LAB_HOME/.tycon" && printf '%s\n' "$1" > "$LAB_HOME/.tycon/config.json"; }
# un árbol que NO trae el freno (el de juguete; una versión anterior): doctor no dice nada de él, ni suma la clave
JSON="$(harness doctor --json 2>/dev/null)"; T79_RC0=$?
T79_FAIL0="$(printf '%s' "$JSON" | jtxt "d['fail']")"
[ "$(printf '%s' "$JSON" | jtxt "'publish_guard' in d")" = False ] && [ -z "$(t79_lines "$JSON" ok)$(t79_lines "$JSON" warn)" ] && ok "$T79 un árbol sin el freno: doctor no dice nada de él, y --json no suma la clave" || mal "$T79 sin el freno en el árbol, doctor habló de él: $(t79_lines "$JSON" ok) $(t79_lines "$JSON" warn)"
JSON="$(TYCON_HARNESS_HEALTH=1 harness doctor --json 2>/dev/null)"; T79_RC0H=$?
T79_FAIL0H="$(printf '%s' "$JSON" | jtxt "d['fail']")"
T79_ALL0H="$(printf '%s' "$JSON" | jtxt "(d['fail'], d['warn'], d['ok'])")"
# un `git` testigo: anota cada invocación y corre el de verdad. Se antepone al PATH sólo en el comando que se mide
T79_WBIN="$BASE/t79/witness-bin"; T79_WLOG="$BASE/t79/git-witness.log"
mkdir -p "$T79_WBIN"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\nexec "%s" "$@"\n' "$T79_WLOG" "$(command -v git)" > "$T79_WBIN/git"; chmod +x "$T79_WBIN/git"
# el freno REAL, en el árbol (lo que una versión de hoy trae)
# (se nombra cada archivo, nunca su carpeta: el lector de dependencias de la validación cuenta entera una carpeta nombrada)
t79_guard_into() {
  local f
  for f in scripts/hooks/public-push-guard.js scripts/publishing/detector.js; do
    mkdir -p "$(dirname "$1/$f")" && cp "$RAIZ/$f" "$1/$f" || return 1
  done
}
t79_guard_into "$LAB_TREE" || mal "$T79 no pude copiar el freno al árbol del laboratorio"

# 1 · sin el pre-push (git sin carpeta global de hooks), perfil full: lo avisa, y NADA en rojo
ANTES="$(harness_lab_home_hash)"
JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
[ "$(harness_lab_home_hash)" = "$ANTES" ] && ok "$T79 doctor con el freno no escribe nada (HOME idéntico por hash)" || mal "$T79 doctor escribió algo"
t79_has "$JSON" warn "'pre-push del arnés NO está' in t and 'core.hooksPath' in t" && ok "$T79 sin carpeta global de hooks, en full: avisa que el pre-push no está puesto" || mal "$T79 no avisa el pre-push que falta: warn=«$(t79_lines "$JSON" warn)» ok=«$(t79_lines "$JSON" ok)»"
[ "$RC" = "$T79_RC0" ] && [ "$(printf '%s' "$JSON" | jtxt "d['fail']")" = "$T79_FAIL0" ] && ok "$T79 …como aviso: el código de salida ($RC) y los rojos son los mismos que sin la pieza" || mal "$T79 la pieza cambió el código o los rojos: rc $RC (antes $T79_RC0) fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
[ "$(printf '%s' "$JSON" | jtxt "(sorted(d['publish_guard'].keys()), d['publish_guard']['hook'], d['publish_guard']['list'], d['publish_guard']['maintainers'], d['publish_guard']['freshness'])")" = "(['freshness', 'hook', 'list', 'maintainers'], {'placed': False, 'runnable': False, 'path': None, 'expected': True}, None, {'declared': False, 'path': None, 'problem': None}, None)" ] \
  && ok "$T79 --json trae publish_guard (hook, list, maintainers, freshness)" || mal "$T79 publish_guard: $(printf '%s' "$JSON" | jtxt "d.get('publish_guard')")"
t79_has "$JSON" ok "'sin lista en esta máquina' in t" && t79_has "$JSON" ok "'no declara un clon de mantenimiento' in t" && ok "$T79 sin lista y sin clon declarado: lo dice como dato" || mal "$T79 sin lista ni clon: ok=«$(t79_lines "$JSON" ok)»"
t79_has "$JSON" ok "'memoria del trabajo' in t" && mal "$T79 dice la línea de la memoria sin clon de mantenimiento declarado" || ok "$T79 sin clon de mantenimiento declarado, la línea de la memoria no sale"
# 🔴 bajo la comprobación de salud de una actualización (TYCON_HARNESS_HEALTH=1) el bloque NO corre: ni una lectura de
#    git, ni la lista, ni la frescura. La instalación y la actualización no invocan git (la regla de la versión bajada),
#    y la salud no puede cambiar por nada de este bloque: doctor dice EXACTAMENTE lo que decía sin el freno en el árbol
JSON="$(TYCON_HARNESS_HEALTH=1 harness doctor --json 2>/dev/null)"; RC=$?
[ -z "$(t79_lines "$JSON" ok)$(t79_lines "$JSON" warn)$(t79_lines "$JSON" fail)" ] && [ "$(printf '%s' "$JSON" | jtxt "('publish_guard' in d, d.get('publish_guard'))")" = "(True, None)" ] \
  && ok "$T79 bajo la comprobación de salud el bloque no corre: ninguna de sus líneas, y publish_guard en null" || mal "$T79 bajo la salud el bloque habló: ok=«$(t79_lines "$JSON" ok)» warn=«$(t79_lines "$JSON" warn)» publish_guard=$(printf '%s' "$JSON" | jtxt "d.get('publish_guard', 'sin la clave')")"
[ "$RC" = "$T79_RC0H" ] && [ "$(printf '%s' "$JSON" | jtxt "(d['fail'], d['warn'], d['ok'])")" = "$T79_ALL0H" ] && [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] \
  && ok "$T79 …y doctor dice bajo la salud lo mismo, línea por línea y con el mismo código ($RC), que sin el freno en el árbol" || mal "$T79 bajo la salud cambió algo: rc $RC (antes $T79_RC0H) $(printf '%s' "$JSON" | jtxt "(d['fail'], d['warn'])")"
T79_STATE="$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"
harness startup --force >/dev/null 2>&1
case "$(j "$T79_STATE" "d.get('notice') or ''")" in *"comprobación de salud no pasó"*) mal "$T79 la comprobación de salud entera (startup --force) falló sin el pre-push: $(j "$T79_STATE" "d.get('notice')")" ;; *) ok "$T79 la comprobación de salud entera (startup --force) pasa sin el pre-push" ;; esac
# donde el freno no se espera, que falte es un dato: el interruptor de los hooks de git, y el perfil mínimo
JSON="$(TYCON_NO_GIT_HOOKS=1 harness doctor --json 2>/dev/null)"
t79_has "$JSON" ok "'NO está' in t and 'no se espera' in t and 'TYCON_NO_GIT_HOOKS=1' in t" && ! t79_has "$JSON" warn "'pre-push' in t" && ok "$T79 con TYCON_NO_GIT_HOOKS=1, que falte es un dato, no un aviso" || mal "$T79 TYCON_NO_GIT_HOOKS=1: warn=«$(t79_lines "$JSON" warn)» ok=«$(t79_lines "$JSON" ok)»"
printf '{ "install": { "profile": "minimal" } }\n' > "$LAB_HOME/.claude/tycon.json"
JSON="$(harness doctor --json 2>/dev/null)"
t79_has "$JSON" ok "'NO está' in t and 'el perfil es minimal' in t" && ! t79_has "$JSON" warn "'pre-push' in t" && [ "$(printf '%s' "$JSON" | jtxt "d['publish_guard']['hook']['expected']")" = False ] && ok "$T79 en el perfil mínimo, que falte es un dato, no un aviso" || mal "$T79 perfil mínimo: warn=«$(t79_lines "$JSON" warn)» ok=«$(t79_lines "$JSON" ok)»"
rm -f "$LAB_HOME/.claude/tycon.json"

# 2 · el pre-push del arnés en la carpeta GLOBAL de hooks (declarada en un archivo de configuración del laboratorio)
T79_GITCONFIG="$BASE/t79/gitconfig-global"
T79_HOOKS="$LAB_HOME/.git-hooks"
mkdir -p "$T79_HOOKS"
printf '[core]\n\thooksPath = ~/.git-hooks\n' > "$T79_GITCONFIG"
doctor79() { JSON="$(GIT_CONFIG_GLOBAL="$T79_GITCONFIG" harness doctor --json "$@" 2>/dev/null)"; RC=$?; }
printf '#!/bin/sh\nexit 0\n' > "$T79_HOOKS/pre-push"; chmod +x "$T79_HOOKS/pre-push"
doctor79
t79_has "$JSON" warn "'NO está en la carpeta global' in t and 'no es el del arnés' in t" && ok "$T79 un pre-push ajeno en la carpeta global no es el del arnés: avisa" || mal "$T79 pre-push ajeno: warn=«$(t79_lines "$JSON" warn)»"
printf '#!/usr/bin/env bash\n# git-pre-push-global.sh\nexit 0\n' > "$T79_HOOKS/pre-push"; chmod +x "$T79_HOOKS/pre-push"
doctor79
t79_has "$JSON" ok "'el pre-push del arnés está en la carpeta global de hooks de git' in t and '.git-hooks' in t" && ! t79_has "$JSON" warn "'pre-push' in t" \
  && [ "$(printf '%s' "$JSON" | jtxt "(d['publish_guard']['hook']['placed'], d['publish_guard']['hook']['runnable'], '.git-hooks' in d['publish_guard']['hook']['path'] and d['publish_guard']['hook']['path'].endswith('pre-push'))")" = "(True, True, True)" ] \
  && ok "$T79 con el pre-push del arnés en la carpeta global (~ expandido): lo nombra como dato" || mal "$T79 pre-push puesto: ok=«$(t79_lines "$JSON" ok)» warn=«$(t79_lines "$JSON" warn)» $(printf '%s' "$JSON" | jtxt "d['publish_guard']['hook']")"
# la respuesta no depende de la carpeta desde la que se corre: desde un repo con su propia carpeta local de hooks, lo mismo
T79_OTHER="$BASE/t79/otro-repo"; mkdir -p "$T79_OTHER"
harness_lab_git "$T79_OTHER" init -q -b main >/dev/null; harness_lab_git "$T79_OTHER" config core.hooksPath .githooks
T79_HERE="$(printf '%s' "$JSON" | jtxt "d['publish_guard']['hook']")"
JSON="$(cd "$T79_OTHER" && GIT_CONFIG_GLOBAL="$T79_GITCONFIG" harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "d['publish_guard']['hook']")" = "$T79_HERE" ] && ok "$T79 …y contesta lo mismo desde un repo con carpeta local de hooks (mira la global)" || mal "$T79 la respuesta cambió con la carpeta: $(printf '%s' "$JSON" | jtxt "d['publish_guard']['hook']") vs $T79_HERE"
# la carpeta puesta desde un archivo INCLUIDO por la configuración global (`[include]`): git la usa, y doctor la tiene que
# ver (leída sin seguir los incluidos decía «git no tiene carpeta global de hooks», distinto de lo que dice el instalador)
T79_INCLUDED="$BASE/t79/gitconfig-incluido"
printf '[core]\n\thooksPath = ~/.git-hooks\n' > "$T79_INCLUDED"
printf '[include]\n\tpath = %s\n' "$T79_INCLUDED" > "$T79_GITCONFIG"
doctor79
t79_has "$JSON" ok "'el pre-push del arnés está en la carpeta global de hooks de git' in t" && ! t79_has "$JSON" warn "'pre-push' in t" && [ "$(printf '%s' "$JSON" | jtxt "(d['publish_guard']['hook']['placed'], d['publish_guard']['hook']['runnable'])")" = "(True, True)" ] \
  && ok "$T79 la carpeta global puesta desde un archivo incluido ([include]): doctor la ve" || mal "$T79 carpeta global desde un archivo incluido: ok=«$(t79_lines "$JSON" ok)» warn=«$(t79_lines "$JSON" warn)»"
printf '[core]\n\thooksPath = ~/.git-hooks\n' > "$T79_GITCONFIG"
# la misma carpeta escrita con otras mayúsculas, en un disco que no las distingue: es la misma (no se compara cómo está
# escrita la ruta: se lee el pre-push que git va a correr). En un disco que sí las distingue no hay nada que medir
if [ -d "$LAB_HOME/.GIT-HOOKS" ]; then
  printf '[core]\n\thooksPath = ~/.GIT-HOOKS\n' > "$T79_GITCONFIG"
  doctor79
  [ "$(printf '%s' "$JSON" | jtxt "(d['publish_guard']['hook']['placed'], d['publish_guard']['hook']['runnable'])")" = "(True, True)" ] && ! t79_has "$JSON" warn "'pre-push' in t" \
    && ok "$T79 la carpeta global escrita con otras mayúsculas (disco que no las distingue): es la misma, sin aviso" || mal "$T79 otras mayúsculas: $(printf '%s' "$JSON" | jtxt "d['publish_guard']['hook']") warn=«$(t79_lines "$JSON" warn)»"
  printf '[core]\n\thooksPath = ~/.git-hooks\n' > "$T79_GITCONFIG"
fi
# la carpeta global de hooks RELATIVA: cada repo mira la suya, y el pre-push del arnés no está puesto para todos
printf '[core]\n\thooksPath = .githooks\n' > "$T79_GITCONFIG"
doctor79
t79_has "$JSON" warn "'es relativa' in t and '.githooks' in t and 'cada repo mira la suya' in t" && [ "$RC" = "$T79_RC0" ] && [ "$(printf '%s' "$JSON" | jtxt "d['fail']")" = "$T79_FAIL0" ] \
  && ok "$T79 una carpeta global de hooks relativa: avisa que cada repo mira la suya (aviso, no rojo)" || mal "$T79 carpeta relativa: rc $RC warn=«$(t79_lines "$JSON" warn)»"
printf '[core]\n\thooksPath = ~/.git-hooks\n' > "$T79_GITCONFIG"
# `git config` que sale con un ERROR (ni 0 ni 1): no se pudo mirar, y se dice eso — no «git no tiene carpeta global»
T79_BADGIT="$BASE/t79/git-roto"; mkdir -p "$T79_BADGIT"
printf '#!/bin/sh\ncase "$*" in *"--type=path core.hooksPath"*) echo "fatal: de mentira" >&2; exit 3 ;; esac\nexec "%s" "$@"\n' "$(command -v git)" > "$T79_BADGIT/git"; chmod +x "$T79_BADGIT/git"
JSON="$(PATH="$T79_BADGIT:$PATH" GIT_CONFIG_GLOBAL="$T79_GITCONFIG" harness doctor --json 2>/dev/null)"; RC=$?
t79_has "$JSON" warn "'no pude mirar la carpeta global de hooks de git' in t and 'salió 3' in t" && ! t79_has "$JSON" warn "'git no tiene carpeta global' in t" && [ "$RC" = "$T79_RC0" ] && [ "$(printf '%s' "$JSON" | jtxt "d['fail']")" = "$T79_FAIL0" ] \
  && ok "$T79 git config que sale con un error: «no pude mirar», no «git no tiene carpeta global» (aviso, no rojo)" || mal "$T79 git config con error: rc $RC warn=«$(t79_lines "$JSON" warn)»"
# el freno del árbol que NO CARGA (un archivo roto): se dice, como aviso, y publish_guard va en null
cp "$LAB_TREE/scripts/hooks/public-push-guard.js" "$BASE/t79/guard-sano.js"
printf "'use strict';\nfunction roto( {\n" > "$LAB_TREE/scripts/hooks/public-push-guard.js"
doctor79
t79_has "$JSON" warn "'está en el árbol y no carga' in t" && [ "$(printf '%s' "$JSON" | jtxt "('publish_guard' in d, d.get('publish_guard'))")" = "(True, None)" ] && [ "$RC" = "$T79_RC0" ] && [ "$(printf '%s' "$JSON" | jtxt "d['fail']")" = "$T79_FAIL0" ] \
  && ok "$T79 el freno del árbol que no carga: lo avisa (no rojo), y publish_guard va en null" || mal "$T79 freno roto: rc $RC warn=«$(t79_lines "$JSON" warn)» publish_guard=$(printf '%s' "$JSON" | jtxt "d.get('publish_guard', 'sin la clave')") fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
cp "$BASE/t79/guard-sano.js" "$LAB_TREE/scripts/hooks/public-push-guard.js"
# sin permiso de ejecución git no lo corre (en Windows git no mira ese permiso: ahí no hay nada que medir)
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) : ;; *)
  chmod -x "$T79_HOOKS/pre-push"
  doctor79
  t79_has "$JSON" warn "'sin permiso de ejecución' in t" && [ "$(printf '%s' "$JSON" | jtxt "(d['publish_guard']['hook']['placed'], d['publish_guard']['hook']['runnable'])")" = "(True, False)" ] && [ "$(printf '%s' "$JSON" | jtxt "d['fail']")" = "$T79_FAIL0" ] \
    && ok "$T79 el del arnés sin permiso de ejecución: avisa que git no lo corre (aviso, no rojo)" || mal "$T79 sin permiso de ejecución: warn=«$(t79_lines "$JSON" warn)» $(printf '%s' "$JSON" | jtxt "(d['publish_guard']['hook'], d['fail'])")"
  chmod +x "$T79_HOOKS/pre-push" ;;
esac

# 3 · una máquina que MANTIENE: el «remoto» del repo de mantenimiento, quien publica en él, y el clon de la máquina
T79_REMOTE="$BASE/t79/interno.git"; T79_AUTHOR="$BASE/t79/autor"; T79_CLONE="$BASE/t79/mantenimiento"
mkdir -p "$T79_AUTHOR"
harness_lab_git "$BASE/t79" init -q --bare -b "$T79_MAIN" "$T79_REMOTE" >/dev/null
# el «remoto» es una carpeta: su propio `origin` dice de qué repo es copia (así el clon tiene un remoto que se lee)
harness_lab_git "$T79_REMOTE" config remote.origin.url https://dev.azure.com/acme/harness/_git/acme-harness-internal
harness_lab_git "$T79_AUTHOR" init -q -b "$T79_MAIN" >/dev/null
t79_list "$T79_AUTHOR/scripts/publishing/denylist.json" "$T79_TERM"
harness_lab_git "$T79_AUTHOR" add -A >/dev/null; harness_lab_git "$T79_AUTHOR" commit -q -m "base" >/dev/null
harness_lab_git "$T79_AUTHOR" remote add origin "$T79_REMOTE"; harness_lab_git "$T79_AUTHOR" push -q origin "$T79_MAIN" >/dev/null 2>&1
harness_lab_git "$BASE/t79" clone -q "$T79_REMOTE" "$T79_CLONE" >/dev/null 2>&1
harness_lab_git "$T79_CLONE" fetch -q origin >/dev/null 2>&1
T79_CLONE="$(cd "$T79_CLONE" && pwd -P)"
# declara el clon que mantiene (paths.maintained) y NO el de mantenimiento: la lista sale de ahí, y se avisa con el comando
t79_config "{ \"paths\": { \"maintained\": \"$T79_CLONE\" } }"
doctor79
t79_has "$JSON" ok "'la lista: el clon que esta máquina mantiene (paths.maintained)' in t and '1 término(s)' in t" && ok "$T79 nombra de dónde sale la lista y cuántos términos" || mal "$T79 la lista: ok=«$(t79_lines "$JSON" ok)» warn=«$(t79_lines "$JSON" warn)»"
t79_has "$JSON" warn "'paths.maintained' in t and 'no declara el de mantenimiento' in t and 'harness.js config set paths.maintainers' in t" && ok "$T79 con paths.maintained y sin paths.maintainers: avisa, con el comando" || mal "$T79 no avisa la clave que falta: warn=«$(t79_lines "$JSON" warn)»"
t79_has "$JSON" ok "'memoria del trabajo' in t" && mal "$T79 dice la línea de la memoria sin paths.maintainers" || ok "$T79 …y sin paths.maintainers no dice la línea de la memoria"
[ "$RC" = "$T79_RC0" ] && [ "$(printf '%s' "$JSON" | jtxt "d['fail']")" = "$T79_FAIL0" ] && ok "$T79 …como aviso: mismo código y mismos rojos" || mal "$T79 la clave que falta cambió el código o los rojos: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
# declara el de mantenimiento: lo nombra, la lista sale de él, está al día, y dice por dónde viaja la memoria
t79_config "{ \"paths\": { \"maintainers\": \"$T79_CLONE\", \"maintained\": \"$T79_CLONE\" } }"
# (el clon entero, con su .git: doctor tampoco puede dejarle una traída ni un candado)
t79_clone_hash() { ( cd "$T79_CLONE" && find . \( -type f -o -type l \) -print | LC_ALL=C sort | while IFS= read -r f; do printf '%s ' "$f"; if [ -L "$f" ]; then readlink "$f"; else shasum -a 256 < "$f"; fi; done ) | shasum -a 256 | cut -d' ' -f1; }
ANTES="$(harness_lab_home_hash)"; T79_HASH_BEFORE="$(t79_clone_hash)"
doctor79
[ "$(harness_lab_home_hash)" = "$ANTES" ] && [ "$(t79_clone_hash)" = "$T79_HASH_BEFORE" ] && ok "$T79 doctor no escribe nada: ni en la HOME ni en el clon de mantenimiento" || mal "$T79 doctor escribió algo (HOME o clon de mantenimiento)"
t79_has "$JSON" ok "'clon de mantenimiento declarado: $T79_CLONE (paths.maintainers)' in t" && ok "$T79 nombra el clon de mantenimiento declarado" || mal "$T79 no nombra el clon declarado: ok=«$(t79_lines "$JSON" ok)» warn=«$(t79_lines "$JSON" warn)»"
t79_has "$JSON" ok "'la lista: el clon de mantenimiento (paths.maintainers)' in t" && t79_has "$JSON" ok "'la lista está al día' in t" && ! t79_has "$JSON" warn "True" && ok "$T79 la lista sale de él, está al día, y no queda ningún aviso de la pieza" || mal "$T79 con el clon declarado: ok=«$(t79_lines "$JSON" ok)» warn=«$(t79_lines "$JSON" warn)»"
t79_has "$JSON" ok "'memoria del trabajo hecho en un clon del público viaja con el próximo commit del clon de mantenimiento' in t" && ok "$T79 con paths.maintainers dice por dónde viaja la memoria" || mal "$T79 sin la línea de la memoria: ok=«$(t79_lines "$JSON" ok)»"
T79_PG="$(printf '%s' "$JSON" | jtxt "(d['publish_guard']['list'], d['publish_guard']['maintainers'], d['publish_guard']['freshness']['measured'], d['publish_guard']['freshness']['differs'], d['publish_guard']['freshness']['behind'])")"
[ "$T79_PG" = "({'source': 'maintainers', 'terms': 1}, {'declared': True, 'path': '$T79_CLONE', 'problem': None}, True, False, 0)" ] \
  && ok "$T79 --json: la lista con su origen y su cuenta, el clon declarado, y la frescura medida" || mal "$T79 publish_guard: $(printf '%s' "$JSON" | jtxt "d['publish_guard']")"
# «no pude medir si la lista está al día»: un AVISO donde la lista sale de un clon que la máquina declaró (ahí se
# esperaba poder medir), y un DATO donde sale de un archivo suelto (no hay clon que mirar)
harness_lab_git "$T79_CLONE" remote set-head origin --delete
doctor79
t79_has "$JSON" warn "'no pude medir si la lista está al día' in t and 'rama principal remota' in t" && [ "$RC" = "$T79_RC0" ] && [ "$(printf '%s' "$JSON" | jtxt "d['fail']")" = "$T79_FAIL0" ] \
  && ok "$T79 «no pude medir» con la lista de un clon declarado: es un aviso (no rojo)" || mal "$T79 no pude medir, clon declarado: rc $RC warn=«$(t79_lines "$JSON" warn)» ok=«$(t79_lines "$JSON" ok)»"
harness_lab_git "$T79_CLONE" remote set-head origin "$T79_MAIN"
t79_list "$BASE/t79/lista-suelta.json" "$T79_TERM"
JSON="$(TYCON_PUBLISH_DENYLIST="$BASE/t79/lista-suelta.json" GIT_CONFIG_GLOBAL="$T79_GITCONFIG" harness doctor --json 2>/dev/null)"; RC=$?
t79_has "$JSON" ok "'no pude medir si la lista está al día' in t and 'no vive en un clon de git' in t" && ! t79_has "$JSON" warn "'no pude medir' in t" \
  && ok "$T79 «no pude medir» con la lista de un archivo suelto: es un dato, no un aviso" || mal "$T79 no pude medir, archivo suelto: warn=«$(t79_lines "$JSON" warn)» ok=«$(t79_lines "$JSON" ok)»"
# el clon ADELANTE de su remoto (una excepción commiteada en la lista, sin subir): no es «atrasado» ni se arregla
# trayéndolo — dice que hay que subirla
T79_ALLOWED="$(node -e 'process.stdout.write(JSON.stringify([{archivo:"guides/a.md",patron:process.argv[1],motivo:"una excepción todavía sin subir"}]))' "$T79_TERM")"
t79_list "$T79_CLONE/scripts/publishing/denylist.json" "$T79_TERM" "$T79_ALLOWED"
harness_lab_git "$T79_CLONE" add -A >/dev/null; harness_lab_git "$T79_CLONE" commit -q -m "$T79_MARK: una excepción" >/dev/null
doctor79
t79_has "$JSON" warn "'tiene cambios que su remoto todavía no tiene' in t and '1 commit(s) sin subir' in t and ' push)' in t and 'atrasad' not in t and 'pull' not in t" && [ "$(printf '%s' "$JSON" | jtxt "(d['publish_guard']['freshness']['behind'], d['publish_guard']['freshness']['ahead'])")" = "(0, 1)" ] \
  && ok "$T79 el clon adelante de su remoto: dice que tiene cambios sin subir y cómo subirlos, sin «atrasado» ni «pull»" || mal "$T79 clon adelante: warn=«$(t79_lines "$JSON" warn)» ok=«$(t79_lines "$JSON" ok)»"
harness_lab_git "$T79_CLONE" reset -q --hard "origin/$T79_MAIN" >/dev/null
# el remoto suma tres commits que cambian la lista y el clon los TRAE sin fusionar: avisa con la cuenta
t79_publish() { # t79_publish <cuántos>
  local i allowed="[]"
  for i in $(seq 1 "$1"); do
    allowed="$(node -e 'const a=JSON.parse(process.argv[1]);a.push({archivo:"guides/caso-"+a.length+".md",patron:process.argv[2],motivo:"una excepción de la prueba"});process.stdout.write(JSON.stringify(a))' "$allowed" "$T79_TERM")"
    t79_list "$T79_AUTHOR/scripts/publishing/denylist.json" "$T79_TERM" "$allowed"
    harness_lab_git "$T79_AUTHOR" add -A >/dev/null; harness_lab_git "$T79_AUTHOR" commit -q -m "$T79_MARK: el asunto del commit $i ($(date +%s)$RANDOM)" >/dev/null
  done
  harness_lab_git "$T79_AUTHOR" push -q origin "$T79_MAIN" >/dev/null 2>&1
}
t79_publish 3
doctor79
t79_has "$JSON" warn "True" && mal "$T79 avisa un atraso que no puede conocer sin salir a la red: «$(t79_lines "$JSON" warn)»" || ok "$T79 el remoto avanzó y nadie trajo el clon: sin --fetch, doctor no lo ve (y no sale a la red)"
doctor79 --fetch
t79_has "$JSON" warn "'su remoto tiene commits que este clon todavía no trajo' in t" && [ "$(printf '%s' "$JSON" | jtxt "(d['publish_guard']['freshness']['remoteAsked'], d['publish_guard']['freshness']['remoteAhead'])")" = "(True, True)" ] \
  && ok "$T79 con --fetch le pregunta al remoto del clon y avisa que tiene novedades" || mal "$T79 --fetch: warn=«$(t79_lines "$JSON" warn)» $(printf '%s' "$JSON" | jtxt "d['publish_guard']['freshness']")"
[ "$(harness_lab_git "$T79_CLONE" rev-list --count "HEAD..origin/$T79_MAIN")" = 0 ] && ok "$T79 …preguntar no trae: el clon de mantenimiento queda como estaba" || mal "$T79 doctor --fetch trajo el clon de mantenimiento"
harness_lab_git "$T79_CLONE" fetch -q origin >/dev/null 2>&1
doctor79
t79_has "$JSON" warn "'clon atrasado' in t and '3 commit(s) atrás de su rama principal remota, y la lista cambió' in t and 'git -C' in t" && ok "$T79 traído sin fusionar: avisa «3 commit(s) atrás, la lista cambió», con cómo traerlo" || mal "$T79 la lista atrasada: warn=«$(t79_lines "$JSON" warn)» ok=«$(t79_lines "$JSON" ok)»"
[ "$RC" = "$T79_RC0" ] && [ "$(printf '%s' "$JSON" | jtxt "d['fail']")" = "$T79_FAIL0" ] && ok "$T79 …como aviso: mismo código y mismos rojos" || mal "$T79 la lista atrasada cambió el código o los rojos: rc $RC fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
# 🔴 la misma máquina —clon de mantenimiento declarado y atrasado, todo para decir—, bajo la comprobación de salud: el
#    bloque no dice nada y no le pregunta nada a git (ni la carpeta global de hooks, ni una lectura sobre ese clon).
#    Lo demás de doctor en una máquina con clon sí usa git: por eso el testigo tiene que haber anotado algo
: > "$T79_WLOG"
JSON="$(PATH="$T79_WBIN:$PATH" TYCON_HARNESS_HEALTH=1 GIT_CONFIG_GLOBAL="$T79_GITCONFIG" harness doctor --json 2>/dev/null)"; RC=$?
[ -s "$T79_WLOG" ] && [ "$(grep -c -e '--type=path core.hooksPath' -e "$T79_CLONE" "$T79_WLOG")" = 0 ] && [ -z "$(t79_lines "$JSON" ok)$(t79_lines "$JSON" warn)$(t79_lines "$JSON" fail)" ] && [ "$(printf '%s' "$JSON" | jtxt "('publish_guard' in d, d.get('publish_guard'))")" = "(True, None)" ] \
  && ok "$T79 bajo la comprobación de salud, con un clon atrasado que avisar: ni una línea del bloque, ni una llamada a git por él (git testigo)" || mal "$T79 bajo la salud el bloque corrió: git=«$(grep -e '--type=path core.hooksPath' -e "$T79_CLONE" "$T79_WLOG" | head -3)» warn=«$(t79_lines "$JSON" warn)» ok=«$(t79_lines "$JSON" ok)»"
# …y el espejo: el mismo comando sin esa variable (doctor corrido por una persona) sí le pregunta a git y sí lo dice
: > "$T79_WLOG"
JSON="$(PATH="$T79_WBIN:$PATH" GIT_CONFIG_GLOBAL="$T79_GITCONFIG" harness doctor --json 2>/dev/null)"; RC=$?
grep -q -e '--type=path core.hooksPath' "$T79_WLOG" && grep -q -e "$T79_CLONE" "$T79_WLOG" && t79_has "$JSON" warn "'clon atrasado' in t" && t79_has "$JSON" ok "'el pre-push del arnés está en la carpeta global' in t" \
  && ok "$T79 …y corrido por una persona, el mismo doctor sí mira (la carpeta global de hooks y el clon de la lista) y lo dice" || mal "$T79 sin la variable el bloque no corrió: git=«$(grep -c -e '--type=path core.hooksPath' -e "$T79_CLONE" "$T79_WLOG")» warn=«$(t79_lines "$JSON" warn)»"
SALIDA="$(GIT_CONFIG_GLOBAL="$T79_GITCONFIG" harness doctor 2>&1)"
case "$SALIDA$JSON" in *"$T79_MARK"*|*"$T79_TERM"*) mal "$T79 doctor cita un término de la lista, el asunto de un commit o una rama del repo privado" ;; *) ok "$T79 doctor no cita ni un término de la lista, ni el asunto de un commit, ni el nombre de una rama" ;; esac
case "$SALIDA" in *"freno antes de publicar"*"clon atrasado"*) ok "$T79 la salida para una persona lo dice igual" ;; *) mal "$T79 la salida de texto no lo dice: $SALIDA" ;; esac
# la lista del clon con las marcas de un merge a medias: no se puede usar, y dice además que ese clon no está al día
cp "$T79_CLONE/scripts/publishing/denylist.json" "$BASE/t79/lista-sana.json"
printf '<<<<<<< HEAD\n{ "terminos": [] }\n=======\n' > "$T79_CLONE/scripts/publishing/denylist.json"
doctor79
t79_has "$JSON" warn "'la lista no se puede usar' in t and 'no se puede leer' in t" && t79_has "$JSON" warn "'clon atrasado' in t and '3 commit(s) atrás' in t" && [ "$RC" = "$T79_RC0" ] && [ "$(printf '%s' "$JSON" | jtxt "d['fail']")" = "$T79_FAIL0" ] \
  && ok "$T79 una lista que no se deja leer (un merge a medias): avisa que no se puede usar y que su clon está atrasado (aviso, no rojo)" || mal "$T79 lista ilegible: rc $RC warn=«$(t79_lines "$JSON" warn)» fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
cp "$BASE/t79/lista-sana.json" "$T79_CLONE/scripts/publishing/denylist.json"
# declarado y la carpeta ya no está: avisa por qué no sirve (y no es un rojo)
t79_config "{ \"paths\": { \"maintainers\": \"$BASE/t79/no-existe\" } }"
doctor79
t79_has "$JSON" warn "'el clon de mantenimiento declarado no sirve' in t and 'una carpeta que no está' in t and 'por el nombre de su carpeta' in t" && [ "$RC" = "$T79_RC0" ] && [ "$(printf '%s' "$JSON" | jtxt "d['fail']")" = "$T79_FAIL0" ] \
  && ok "$T79 un clon declarado que no está: avisa el motivo y qué pasa mientras tanto (aviso, no rojo)" || mal "$T79 clon declarado ausente: rc $RC warn=«$(t79_lines "$JSON" warn)» fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
# declarado, y la carpeta no es la raíz de un clon (una subcarpeta): también
t79_config "{ \"paths\": { \"maintainers\": \"$T79_CLONE/scripts\" } }"
doctor79
t79_has "$JSON" warn "'el clon de mantenimiento declarado no sirve' in t and 'no es la raíz de un clon' in t" && ok "$T79 una carpeta declarada que no es la raíz de un clon: avisa" || mal "$T79 subcarpeta declarada: warn=«$(t79_lines "$JSON" warn)»"
rm -f "$LAB_HOME/.tycon/config.json"

# 4 · la otra forma de máquina: una versión BAJADA que trae el freno. La instalación corre la comprobación de salud
#     (`doctor --json` del árbol nuevo) SIN el pre-push puesto, y una versión bajada se instala sin invocar git: ni la
#     instalación ni su salud le preguntan nada, tampoco por este bloque (el git testigo no anota ni una línea)
harness_lab_create "$BASE/t79r" >/dev/null
t79_guard_into "$LAB_AUTHOR_TREE" || mal "$T79 no pude sumar el freno a lo publicado"
harness_lab_release_server
harness_lab_publish_stable 2026.10.12.1
harness_lab_release_fresh_home
: > "$T79_WLOG"
T79_OUT="$(PATH="$T79_WBIN:$PATH" harness install --version latest --yes 2>&1)"; RC=$?
[ "$RC" = 0 ] && [ -f "$LAB_HOME/.tycon/harness/scripts/hooks/public-push-guard.js" ] && ok "$T79 una versión bajada que trae el freno se instala sin el pre-push puesto (la comprobación de salud pasa)" || mal "$T79 install --version con el freno en el árbol: rc $RC $T79_OUT"
[ ! -s "$T79_WLOG" ] && ok "$T79 …y la instalación, con su comprobación de salud, no invocó git ni una vez" || mal "$T79 la instalación de una versión bajada invocó git: $(head -3 "$T79_WLOG")"
: > "$T79_WLOG"
JSON="$(PATH="$T79_WBIN:$PATH" TYCON_HARNESS_HEALTH=1 harness_release doctor --json 2>/dev/null)"; RC=$?
[ "$RC" = 0 ] && [ ! -s "$T79_WLOG" ] && [ -z "$(t79_lines "$JSON" ok)$(t79_lines "$JSON" warn)$(t79_lines "$JSON" fail)" ] && [ "$(printf '%s' "$JSON" | jtxt "('publish_guard' in d, d.get('publish_guard'))")" = "(True, None)" ] \
  && ok "$T79 doctor bajo la comprobación de salud, en una versión bajada: ni una llamada a git, ni una línea del bloque, publish_guard en null" || mal "$T79 versión bajada bajo la salud: rc $RC git=«$(head -3 "$T79_WLOG")» warn=«$(t79_lines "$JSON" warn)» ok=«$(t79_lines "$JSON" ok)»"
: > "$T79_WLOG"
JSON="$(PATH="$T79_WBIN:$PATH" harness_release doctor --json 2>/dev/null)"; RC=$?
grep -q -e '--type=path core.hooksPath' "$T79_WLOG" && ok "$T79 …y corrido por una persona, sí le pregunta a git por la carpeta global de hooks" || mal "$T79 doctor a mano en una versión bajada no miró la carpeta global de hooks: $(head -3 "$T79_WLOG")"
[ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = 0 ] && t79_has "$JSON" warn "'pre-push del arnés NO está' in t" && t79_has "$JSON" ok "'no declara un clon de mantenimiento' in t" \
  && [ "$(printf '%s' "$JSON" | jtxt "sorted(d['publish_guard'].keys())")" = "['freshness', 'hook', 'list', 'maintainers']" ] \
  && ok "$T79 en una máquina con versión bajada, doctor dice lo mismo del freno (aviso, sin rojo, y publish_guard en --json)" || mal "$T79 doctor en versión bajada: rc $RC warn=«$(t79_lines "$JSON" warn)» ok=«$(t79_lines "$JSON" ok)» fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
# …con su clon que mantiene declarado y sin el de mantenimiento: el aviso con el comando, también acá
printf '%s' "$T79_CLONE" | harness_release config set paths.maintained >/dev/null 2>&1 || mal "$T79 no pude declarar paths.maintained en la máquina con versión bajada"
JSON="$(harness_release doctor --json 2>/dev/null)"; RC=$?
t79_has "$JSON" warn "'no declara el de mantenimiento' in t and 'harness.js config set paths.maintainers' in t" && t79_has "$JSON" ok "'la lista: el clon que esta máquina mantiene' in t" && [ "$RC" = 0 ] \
  && ok "$T79 …y con paths.maintained sin paths.maintainers avisa con el comando, también en una versión bajada" || mal "$T79 versión bajada con paths.maintained: rc $RC warn=«$(t79_lines "$JSON" warn)» ok=«$(t79_lines "$JSON" ok)»"
# sin git en la máquina (una versión bajada no lo pide): doctor a mano lo dice como dato y sigue, sin un rojo
T79_NOGIT="$BASE/t79r/sin-git"; mkdir -p "$T79_NOGIT"
for T79_TOOL in node python3 bash sh; do ln -s "$(command -v "$T79_TOOL")" "$T79_NOGIT/$T79_TOOL"; done
JSON="$(PATH="$T79_NOGIT" harness_release doctor --json 2>/dev/null)"; RC=$?
t79_has "$JSON" ok "'git no está en esta máquina' in t" && ! t79_has "$JSON" warn "'pre-push' in t" && [ "$(printf '%s' "$JSON" | jtxt "len([t for t in d['fail'] if 'freno antes de publicar' in t])")" = 0 ] \
  && ok "$T79 sin git en la máquina: doctor lo dice como dato («git no está») y no pone nada del bloque en rojo" || mal "$T79 sin git: rc $RC ok=«$(t79_lines "$JSON" ok)» warn=«$(t79_lines "$JSON" warn)» fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
kill "$LAB_RELEASE_PROCESS" 2>/dev/null
# la ayuda de `doctor --fetch` dice las dos cosas que hace: la traída de siempre, y la pregunta al remoto del clon de la lista
SALIDA="$(harness --help 2>&1)"
case "$SALIDA" in *"--fetch"*"FETCH_HEAD"*"remoto del clon de la lista"*) ok "$T79 la ayuda de doctor --fetch dice que además le pregunta al remoto del clon de la lista" ;; *) mal "$T79 la ayuda de doctor --fetch no nombra la pregunta al remoto del clon de la lista" ;; esac

# ── T21 Doctor_ReposDeclarados_ConListaDeLaOrganizacion (story 2.21 · AC 15, 16) @story-2.21 @ac-16 ─────────────────
# La ficha «repos declarados contra el disco» salió de la página del tablero y vive acá: la lista de la ORGANIZACIÓN
# (`scripts/nightly/dependencies/repos.json` del clon de operaciones, `paths.operations`) contra los repos bajo la raíz
# de repos-root.js, a profundidad 2. Un repo cuenta como declarado si su `origin` (leído de .git/config, sin git) apunta
# al `ado` de una entrada, sin distinguir mayúsculas y con los espacios decodificados.
# 🔴 rojo previo: doctor no dice nada de los repos; o compara por el nombre de la carpeta (la etiqueta `ruta`).
T221="story 2.21 ·"
harness_lab_create "$BASE/t221" >/dev/null
harness install --yes >/dev/null 2>&1 || mal "$T221 install previo falló"
T221_OPS="$BASE/t221/ops"; T221_ROOT="$BASE/t221/repos"
mkdir -p "$T221_OPS/scripts/nightly/dependencies"
cat > "$T221_OPS/scripts/nightly/dependencies/repos.json" <<'JSON'
{ "repos": [
  { "producto": "Acme", "ruta": "Acme/BackEnd", "ado": "Acme Proj/BackEnd" },
  { "producto": "Acme", "ruta": "Acme/BackEnd", "subruta": "tools/gateway", "ado": "Acme Proj/BackEnd" },
  { "producto": "Acme", "ruta": "Acme/FrontEnd", "ado": "Acme Proj/Front End", "activo": false },
  { "producto": "Acme", "ruta": "Acme/Mobile", "ado": "Acme Proj/Mobile" }
] }
JSON
t221_repo() {  # t221_repo <carpeta relativa a la raíz> <url del origin> [huella]
  mkdir -p "$T221_ROOT/$1/.git"
  printf '[core]\n\tbare = false\n[remote "origin"]\n\turl = %s\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' "$2" > "$T221_ROOT/$1/.git/config"
  [ -z "${3:-}" ] || mkdir -p "$T221_ROOT/$1/.tycon"
}
t221_repo Acme/AcmeBackEnd 'https://dev.azure.com/lab/Acme%20Proj/_git/BackEnd'
t221_repo Acme/FE 'https://dev.azure.com/lab/acme proj/_git/front%20end'
t221_repo Otro/Suelto 'https://dev.azure.com/lab/Otro/_git/Suelto' huella
# (pase adversarial de la 2.21) un clon por SSH es el mismo repo que su `ado`; un worktree es el repo del que sale, no otro
t221_repo Acme/Mob 'git@ssh.dev.azure.com:v3/lab/Acme%20Proj/Mobile'
mkdir -p "$T221_ROOT/Otro/Suelto/.git/worktrees/wt" "$T221_ROOT/Otro/Suelto-wt/.tycon"
printf 'gitdir: %s\n' "$T221_ROOT/Otro/Suelto/.git/worktrees/wt" > "$T221_ROOT/Otro/Suelto-wt/.git"
printf '../..\n' > "$T221_ROOT/Otro/Suelto/.git/worktrees/wt/commondir"
t221_lines() { printf '%s' "$1" | jtxt "' | '.join(t for t in d['$2'] if 'repos declarados' in t)"; }
mkdir -p "$LAB_HOME/.tycon"; printf '{ "paths": { "operations": "%s" } }\n' "$T221_OPS" > "$LAB_HOME/.tycon/config.json"
JSON="$(TYCON_REPOS_ROOT="$T221_ROOT" harness doctor --json 2>/dev/null)"; RC=$?
L="$(t221_lines "$JSON" ok)"
case "$L" in *"repos declarados por la organización: 3 de 3 en este disco (raíz $T221_ROOT)"*"con huella del arnés sin declarar: 1"*) ok "$T221 T21 con la lista de la organización: «3 de 3 en este disco» (por el origin, también SSH; el repo declarado dos veces cuenta una) y «con huella del arnés sin declarar: 1» (el worktree es el mismo repo)" ;; *) mal "$T221 T21 línea: «${L}» warn=«$(t221_lines "$JSON" warn)» rc=$RC" ;; esac
[ "$(printf '%s' "$JSON" | jtxt "d['declared_repos']")" = "{'declared': 3, 'on_disk': 4, 'matched': 3, 'undeclared_with_harness': 1}" ] \
  && ok "$T221 T21 --json trae declared_repos { declared, on_disk, matched, undeclared_with_harness }" || mal "$T221 T21 declared_repos: $(printf '%s' "$JSON" | jtxt "d.get('declared_repos', 'sin la clave')")"

# ── T22 Doctor_ReposDeclarados_SinListaNuncaFalla (story 2.21 · AC 17) @story-2.21 @ac-17 ───────────────────────────
# 🔴 rojo previo: un `fail` acá tira la comprobación de salud de cada actualización (corre `doctor --json`).
T221_FAIL0="$(printf '%s' "$JSON" | jtxt "len(d['fail'])")"
rm -f "$LAB_HOME/.tycon/config.json"
JSON="$(TYCON_REPOS_ROOT="$T221_ROOT" harness doctor --json 2>/dev/null)"
case "$(t221_lines "$JSON" ok)" in *"repos declarados: no medido — esta máquina no tiene la lista de la organización"*"harness.js team-config"*) ok "$T221 T22 sin paths.operations: un dato, con cómo pedir la lista" ;; *) mal "$T221 T22 sin paths.operations: ok=«$(t221_lines "$JSON" ok)» warn=«$(t221_lines "$JSON" warn)»" ;; esac
mkdir -p "$BASE/t221/ops-vacio"; printf '{ "paths": { "operations": "%s" } }\n' "$BASE/t221/ops-vacio" > "$LAB_HOME/.tycon/config.json"
JSON="$(TYCON_REPOS_ROOT="$T221_ROOT" harness doctor --json 2>/dev/null)"
case "$(t221_lines "$JSON" ok)" in *"no medido — esta máquina no tiene la lista de la organización"*) ok "$T221 T22 un clon de operaciones sin repos.json: el mismo dato" ;; *) mal "$T221 T22 clon sin repos.json: ok=«$(t221_lines "$JSON" ok)» warn=«$(t221_lines "$JSON" warn)»" ;; esac
printf '{ "paths": { "operations": "%s" } }\n' "$T221_OPS" > "$LAB_HOME/.tycon/config.json"
cp "$T221_OPS/scripts/nightly/dependencies/repos.json" "$BASE/t221/repos.json.bak"; printf '{ roto' > "$T221_OPS/scripts/nightly/dependencies/repos.json"
JSON="$(TYCON_REPOS_ROOT="$T221_ROOT" harness doctor --json 2>/dev/null)"
{ [ -n "$(t221_lines "$JSON" warn)" ] && [ -z "$(t221_lines "$JSON" fail)" ] && [ "$(printf '%s' "$JSON" | jtxt "len(d['fail'])")" = "$T221_FAIL0" ]; } \
  && ok "$T221 T22 repos.json ilegible: un aviso con el motivo, nunca un rojo" || mal "$T221 T22 repos.json roto: warn=«$(t221_lines "$JSON" warn)» fail=$(printf '%s' "$JSON" | jtxt "d['fail']")"
cp "$BASE/t221/repos.json.bak" "$T221_OPS/scripts/nightly/dependencies/repos.json"
JSON="$(TYCON_REPOS_ROOT="$BASE/t221/no-existe" harness doctor --json 2>/dev/null)"
{ [ -n "$(t221_lines "$JSON" warn)" ] && [ -z "$(t221_lines "$JSON" fail)" ]; } \
  && ok "$T221 T22 sin raíz de repos: un aviso con el motivo, nunca un rojo" || mal "$T221 T22 sin raíz: warn=«$(t221_lines "$JSON" warn)» ok=«$(t221_lines "$JSON" ok)» fail=«$(t221_lines "$JSON" fail)»"
# un repo cuya configuración no se puede leer no se cuenta como «no declarado» en silencio: aviso con el código
# (revisión de la story 2.21: «no pude leer» no es «no está»). Sin efecto si corre como root (chmod no le quita nada).
chmod 000 "$T221_ROOT/Acme/FE/.git/config"
JSON="$(TYCON_REPOS_ROOT="$T221_ROOT" harness doctor --json 2>/dev/null)"
chmod 644 "$T221_ROOT/Acme/FE/.git/config"
if [ "$(id -u)" = 0 ]; then echo "  ⏭ $T221 T22 configuración ilegible: NO MEDIDO como root"
else
  case "$(t221_lines "$JSON" warn)" in *"2 de 3 en este disco"*"no se pudieron leer (EACCES)"*) ok "$T221 T22 una configuración que no se puede leer: aviso con el código y los números «pueden quedar cortos», nunca un rojo" ;; *) mal "$T221 T22 configuración ilegible: warn=«$(t221_lines "$JSON" warn)» ok=«$(t221_lines "$JSON" ok)»" ;; esac
  [ "$(printf '%s' "$JSON" | jtxt "(d['declared_repos'].get('unreadable'), len([t for t in d['fail'] if 'repos declarados' in t]))")" = "(1, 0)" ] \
    && ok "$T221 T22 --json la cuenta en declared_repos.unreadable" || mal "$T221 T22 declared_repos: $(printf '%s' "$JSON" | jtxt "d.get('declared_repos')")"
fi
JSON="$(TYCON_HARNESS_HEALTH=1 TYCON_REPOS_ROOT="$T221_ROOT" harness doctor --json 2>/dev/null)"
{ [ -z "$(t221_lines "$JSON" ok)$(t221_lines "$JSON" warn)$(t221_lines "$JSON" fail)" ] && [ "$(printf '%s' "$JSON" | jtxt "('declared_repos' in d, d.get('declared_repos'))")" = "(True, None)" ]; } \
  && ok "$T221 T22 bajo la comprobación de salud el bloque no corre: ninguna línea y declared_repos en null" || mal "$T221 T22 bajo la salud: ok=«$(t221_lines "$JSON" ok)» declared_repos=$(printf '%s' "$JSON" | jtxt "d.get('declared_repos', 'sin la clave')")"
rm -f "$LAB_HOME/.tycon/config.json"

# ── T27 y T28 de la story 8.39: el Node propio del arnés en doctor (dato o aviso, nunca rojo) ─────────────────────────
# @story-8.39 @ac-20 Doctor_NodeDelArnes_LineaYClave · @ac-21 Doctor_NodeDelArnes_NuncaRojo
echo "T27/T28 · doctor y el Node del arnés"
harness_lab_create "$BASE/t839" >/dev/null
harness install --yes >/dev/null 2>&1 || mal "T27 install previo falló"
export TYCON_HARNESS_NODE=1
mkdir -p "$LAB_TREE/scripts/production"
NV="v24.21.0"; NDIR839="$LAB_HOME/.tycon/node"
# un Node de juguete (un GUION que dice la versión y si no llama al node real por su ruta: nunca un enlace a un binario
# real) y la lista de laboratorio con la huella de ESE binario para la plataforma de esta máquina
mkdir -p "$NDIR839/versions/$NV/bin"
printf '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "%s"; exit 0; fi\nexec "%s" "$@"\n' "$NV" "$(command -v node)" > "$NDIR839/versions/$NV/bin/node"
chmod +x "$NDIR839/versions/$NV/bin/node"; ln -s "versions/$NV" "$NDIR839/current"
lista839() { # lista839 <versión> <huella del binario>
  node -e '
const [file, v, sha, hn] = process.argv.slice(1);
const key = require(hn).platformKey({}).key;
const files = {}; files[key] = { tar: `node-${v}-${key}.tar.gz`, sha256: "0".repeat(64), node_sha256: sha };
require("fs").writeFileSync(file, JSON.stringify({ version: v, base_url: "http://127.0.0.1:9/", files }, null, 2) + "\n");' "$LAB_TREE/scripts/production/node-official.json" "$1" "$2" "$LAB_TREE/scripts/setup/harness/harness-node.js"
}
SHA839="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$NDIR839/versions/$NV/bin/node")"
lista839 "$NV" "$SHA839"
# el aplicador de juguete del laboratorio escribe `node "<guion>"` a mano: el hook queda como lo deja el aplicador real
# (scripts/setup/apply-hooks.js, probado en apply-hooks.test.js T16) con el Node del arnés
node -e 'const f=process.argv[1],b=process.argv[2];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));for(const g of Object.values(s.hooks||{}))for(const e of g)for(const h of e.hooks||[])if(/^node "/.test(h.command)&&/lab-hook\.js"$/.test(h.command))h.command=h.command.replace(/^node /,b+" ");require("fs").writeFileSync(f,JSON.stringify(s,null,2))' "$LAB_HOME/.claude/settings.json" "$NDIR839/current/bin/node"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "(d['harness_node']['own'], d['harness_node']['version'], d['harness_node']['verified'], any(o.startswith('Node del arnés: $NV, el propio') and 'huella del binario igual a la de la lista' in o for o in d['ok']))")" = "(True, '$NV', True, True)" ] \
  && ok "T27 propio y al día: la línea en ok y harness_node con own, version y verified" || mal "T27 propio: $(printf '%s' "$JSON" | jtxt "(d.get('harness_node'), [o for o in d['ok'] if 'Node del' in o], [w for w in d['warn'] if 'Node del' in w])")"
printf '%s' "$JSON" | jtxt "sorted(d['harness_node'].keys())" | grep "'expected', 'form', 'hooks', 'own', 'path', 'reason', 'switch', 'verified', 'version'" >/dev/null && ok "T27 --json trae las claves de harness_node" || mal "T27 claves: $(printf '%s' "$JSON" | jtxt "sorted(d['harness_node'].keys())")"
# otra versión en la lista; la huella del binario distinta de la lista
lista839 "v24.99.0" "$SHA839"; JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any(w.startswith('Node del arnés: no está') for w in d['warn']) and d['harness_node']['own'] is False")" = True ] && ok "T27 versión vieja: warn" || mal "T27 versión vieja: $(printf '%s' "$JSON" | jtxt "[w for w in d['warn'] if 'Node del' in w]")"
lista839 "$NV" "$(printf 'a%.0s' $(seq 1 64))"; JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('NO es la de la lista' in w for w in d['warn']) and d['harness_node']['verified'] is False")" = True ] && ok "T27 huella distinta de node_sha256: warn" || mal "T27 huella: $(printf '%s' "$JSON" | jtxt "[w for w in d['warn'] if 'Node del' in w]")"
# hooks a medias: el hook del arnés (uno de la lista) otra vez con node "
lista839 "$NV" "$SHA839"
node -e 'const f=process.argv[1],b=process.argv[2];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));for(const g of Object.values(s.hooks||{}))for(const e of g)for(const h of e.hooks||[])if(h.command.startsWith(b+" "))h.command=h.command.replace(b+" ","node ");require("fs").writeFileSync(f,JSON.stringify(s,null,2))' "$LAB_HOME/.claude/settings.json" "$NDIR839/current/bin/node"
JSON="$(harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$JSON" | jtxt "any('el próximo arranque los pasa' in w for w in d['warn']) and d['harness_node']['hooks']['path_node'] >= 1")" = True ] && ok "T27 hooks a medias: «el próximo arranque los pasa», como warn" || mal "T27 hooks a medias: $(printf '%s' "$JSON" | jtxt "([w for w in d['warn'] if 'Node del' in w], d['harness_node'])")"
# T28: ningún estado pone un fail; bajo la salud, verified en null
for estado in apagado roto sinlista; do
  case "$estado" in
    apagado) J="$(TYCON_HARNESS_NODE=0 harness doctor --json 2>/dev/null)" ;;
    roto) printf '#!/bin/sh\nexit 1\n' > "$NDIR839/versions/$NV/bin/node"; J="$(harness doctor --json 2>/dev/null)" ;;
    sinlista) rm -f "$LAB_TREE/scripts/production/node-official.json"; J="$(harness doctor --json 2>/dev/null)" ;;
  esac
  [ "$(printf '%s' "$J" | jtxt "any('Node del arnés' in f for f in d['fail'])")" = False ] && ok "T28 $estado: ningún fail por el Node del arnés" || mal "T28 $estado: fail=$(printf '%s' "$J" | jtxt "d['fail']")"
done
printf '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "%s"; exit 0; fi\nexec "%s" "$@"\n' "$NV" "$(command -v node)" > "$NDIR839/versions/$NV/bin/node"
lista839 "$NV" "$SHA839"
J="$(TYCON_HARNESS_HEALTH=1 harness doctor --json 2>/dev/null)"
[ "$(printf '%s' "$J" | jtxt "d['harness_node']['verified'] is None and d['harness_node']['own'] is True")" = True ] && ok "T28 bajo la comprobación de salud: verified en null, sin recalcular la huella" || mal "T28 salud: $(printf '%s' "$J" | jtxt "d.get('harness_node')")"
export TYCON_HARNESS_NODE=0

if [ "$FALLOS" = 0 ]; then echo "✅ harness-doctor: todo verde"; exit 0; fi
echo "❌ harness-doctor: $FALLOS fallo(s)"; exit 1
