#!/usr/bin/env bash
# harness-channel.test.sh — los dos canales del repo público, de punta a punta (T31:
# `Channel_BothRefsReset_NumericNoDowngrade_LatestToStable_PreviousSurvivesGc`).
#
# Lo que no se puede perder:
#   T31 · un clon cuyo `origin` está en la lista que el árbol declara (`scripts/setup/public-remotes.json`) es «el
#         público»: `latest` es `mirror/sync` y `stable` es `main`, y los DOS se consumen igual —rama local
#         `tycon/installed` + `reset --hard`—, porque el commit de `mirror/sync` que alguien instaló deja de ser ancestro
#         de todo cuando la rama se reescribe. «No bajar» se decide por NÚMERO (`2026.10.03.10` es más nuevo que
#         `2026.10.03.9`): pasar a `stable` con lo instalado más nuevo no baja, lo dice, y `update --check` sale 0; cuando
#         se mergea el pull request (mismo número, otro commit) se aplica. `refs/tycon/previous/harness` sostiene el commit
#         anterior después de un `gc` —con el registro de movimientos (reflog) VACIADO antes: si no, el commit sobrevive
#         igual y la prueba no prueba nada— y `rollback` vuelve a él. Si `mirror/sync` no está, o es más vieja que `main`,
#         `latest` lee `main`.
#   OTRO · con otro remoto (la lista declara otra URL), `latest` y `stable` son `main` sin reescritura, y lo dice.
#   D3   · una skill propia sin seguir dentro del clon no traba la actualización; la que choca con una ruta que la versión
#          nueva trae, sí: no se toca nada, se nombra la ruta y el archivo queda intacto.
#   A5   · con una ref que se reescribe se mueve sólo desde `tycon/installed` (o la primera vez, desde el commit
#          registrado): desde otra rama no se toca nada y se dice.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh (remoto bare con `main` y `mirror/sync`, un `version.json` en cada una).
# Nunca ~/.claude ni el checkout real. 🔴 Sin pipes sobre el comando medido.
#
#   ROTO · un `version.json` que no se deja leer NO es «sin número»: `update` no mueve el clon, sale 2 («no pude mirar») y
#          nombra la ref y el archivo, en los dos canales; `startup` lo deja en el aviso y la mirada no cuenta.
#   PULL · un clon del público cuyo `HEAD` avanzó en `main` ANTES de su primera actualización
#          —un `git pull` a mano, o el respaldo en shell— no queda bloqueado: `update` lo re-registra y la versión
#          siguiente entra; ya en `tycon/installed`, con `HEAD` en la punta sin registrar, también se re-registra. Una
#          rama propia con un commit propio no se toca, y el comando que el mensaje aconseja SE PUEDE correr.
#   NEST · una carpeta sin seguir que es un repo de git propio, contra una versión que trae rutas bajo ella:
#          no se toca nada, se nombra, y lo que la persona tenía sin commitear sigue ahí.
#   CASE · una ruta sin seguir que difiere sólo en la caja de una que la versión nueva trae: en el disco de Mac
#          y de Windows es el mismo archivo; no se toca nada y se nombran las dos.
#   REF  · una rama `tycon/installed` que no se puede LEER no es «todavía no existe»:
#          `update` y `rollback` no mueven el clon, salen con su código de «no pude» y nombran la ref; `doctor`, en rojo.
#
#   T48  · `channel` escribe con el escritor único de la configuración (`setKey`) y el
#          archivo queda byte a byte como lo dejaría un escritor propio de `channel`:
#          las otras secciones, su orden y sus nombres, intactos.
#
# Uso: bash scripts/tests/harness-channel.test.sh [--only T31|OTRO|D3|A5|ROTO|PULL|NEST|CASE|REF|T48]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
# El arranque corre en el lugar: desprendido, con la máquina cargada (la puerta de pruebas corre varias suites a la vez)
# pasa sus 20 s de espera, sale 0 y sigue aparte con el candado tomado, y el comando siguiente de la prueba sale 3
# «otra sesión está actualizando». El arranque desprendido con su candado lo mide harness-update.test.sh (T39L).
export TYCON_STARTUP_DETACH=0
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d "${TMPDIR:-/tmp}/harness-channel.XXXXXX")"
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" harness-channel || exit 1
trap 'rm -rf "$BASE"' EXIT
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
estado() { j "$(ESTADO)" "$1"; }
head_de() { harness_lab_git "$1" rev-parse HEAD; }
rama_de() { harness_lab_git "$1" symbolic-ref --short -q HEAD; }
existe() { harness_lab_git "$1" cat-file -e "$2^{commit}" 2>/dev/null; }
fuente() { estado "d['sources'][0]['$1']"; }
export TYCON_UPDATE_APPLY=auto   # las actualizaciones se aplican con `update` a secas (la política `ask` la mide T32)

# ═══ T31 · Channel_BothRefsReset_NumericNoDowngrade_LatestToStable_PreviousSurvivesGc ════════════════════════════════
# 🔴 Rojo con un programa sin esta conducta: `install` deja `rewrites:
#    False` (el clon público no se reconoce), `update` no trae `mirror/sync` («arnés al día» con la ref en `main`), y
#    `channel stable` no dice «no se baja»: baja, o no hace nada.
if corre T31; then
  harness_lab_create "$BASE/t31" >/dev/null
  harness_lab_public
  harness_lab_publish_stable 2026.10.01.1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  SALIDA="$(harness install --yes --channel latest 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(fuente rewrites)" = True ] && ok "T31 un clon del remoto declarado se reconoce como público (rewrites)" || mal "T31 install: rc $RC rewrites=$(fuente rewrites): $SALIDA"
  [ "$(estado "d['channel']")" = latest ] && [ "$(estado "d['version']['number']")" = 2026.10.01.1 ] && ok "T31 canal latest, versión estampada 2026.10.01.1" || mal "T31 estado: canal $(estado "d['channel']") versión $(estado "d['version']['number']")"
  M0="$(head_de "$LAB_TREE")"

  # (1) latest: lo que trae es mirror/sync, a una rama local tycon/installed
  harness_lab_publish_sync 2026.10.02.1 || mal "T31 no pude publicar la sincronización"
  S1="$(harness_lab_remote_head mirror/sync)"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$S1" ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && ok "T31 latest: update trae mirror/sync a tycon/installed" || mal "T31 latest: rc $RC rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE") (esperado $S1): $SALIDA"
  [ "$(fuente ref)" = mirror/sync ] && [ "$(estado "d['version']['number']")" = 2026.10.02.1 ] && ok "T31 …la ref del estado es mirror/sync y la versión 2026.10.02.1" || mal "T31 latest: ref $(fuente ref) versión $(estado "d['version']['number']")"
  case "$(harness version 2>&1)" in *"harness@mirror/sync"*) ok "T31 …y version lo muestra" ;; *) mal "T31 version: $(harness version 2>&1)" ;; esac

  # (2) la rama se reescribe: el commit instalado ya no es ancestro de nada, y se mueve igual (reset)
  harness_lab_publish_sync 2026.10.02.2
  S2="$(harness_lab_remote_head mirror/sync)"
  harness_lab_git "$LAB_AUTHOR_TREE" merge-base --is-ancestor "$S1" "$S2" && mal "T31 el laboratorio no reescribió la rama (S1 es ancestro de S2)"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$S2" ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && ok "T31 rama reescrita: update hace reset a la punta nueva" || mal "T31 reescrita: rc $RC HEAD $(head_de "$LAB_TREE") (esperado $S2): $SALIDA"
  [ "$(harness_lab_git "$LAB_TREE" rev-parse -q --verify refs/tycon/previous/harness)" = "$S1" ] && ok "T31 previous quedó en refs/tycon/previous/harness" || mal "T31 previous: $(harness_lab_git "$LAB_TREE" rev-parse -q --verify refs/tycon/previous/harness)"

  # (3) gc con el reflog vaciado antes: la ref sostiene el commit anterior, y rollback vuelve a él. El testigo: un commit
  #     que NADA sostiene se poda con ese mismo gc (si no, el gc no está podando y lo de arriba no prueba nada).
  SUELTO="$(harness_lab_git "$LAB_TREE" commit-tree "$S2^{tree}" -p "$S2" -m "testigo: nada lo sostiene")"
  existe "$LAB_TREE" "$SUELTO" || mal "T31 no pude crear el commit testigo"
  harness_lab_git "$LAB_TREE" reflog expire --expire=now --all
  harness_lab_git "$LAB_TREE" gc -q --prune=now 2>/dev/null
  existe "$LAB_TREE" "$SUELTO" && mal "T31 el gc no podó el commit testigo: la prueba del gc no mide nada" || ok "T31 el gc (con el reflog vacío) poda lo que nada sostiene"
  existe "$LAB_TREE" "$S1" && ok "T31 …y el commit de previous sobrevive" || mal "T31 el gc se llevó el commit de previous ($S1)"
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$S1" ] && ok "T31 rollback funciona después del gc: vuelve a la versión anterior" || mal "T31 rollback tras gc: rc $RC HEAD $(head_de "$LAB_TREE") (esperado $S1): $SALIDA"
  SALIDA="$(harness update --yes 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$S2" ] && ok "T31 …y update --yes levanta la retención y vuelve a la punta" || mal "T31 update --yes tras rollback: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"

  # (4) paso a stable con lo instalado MÁS NUEVO que la estable: no baja, y lo dice
  harness channel stable >/dev/null 2>&1 || mal "T31 channel stable falló"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$S2" ] && ok "T31 stable con lo instalado más nuevo: no baja" || mal "T31 stable bajó o falló: rc $RC HEAD $(head_de "$LAB_TREE") (S2 $S2, main $M0): $SALIDA"
  case "$SALIDA" in *"instalada 2026.10.02.2, estable 2026.10.01.1: no se baja"*rollback*) ok "T31 …y lo dice: «instalada X, estable Y: no se baja; para volver, rollback»" ;; *) mal "T31 no dice «no se baja»: $SALIDA" ;; esac
  harness update --check >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && ok "T31 update --check sale 0 cuando lo traído es menor" || mal "T31 update --check con lo traído menor: rc $RC"
  [ "$(fuente ref)" = main ] && ok "T31 la ref se regrabó: stable es main" || mal "T31 ref en stable: $(fuente ref)"
  case "$(harness doctor --fetch 2>&1)" in *"no se baja"*) ok "T31 doctor --fetch también lo dice" ;; *) mal "T31 doctor --fetch no dice «no se baja»: $(harness doctor --fetch 2>&1)" ;; esac

  # (5) se mergea el pull request: main queda con el MISMO número y otro commit → se aplica (la próxima estable ≥ X)
  harness_lab_merge_sync || mal "T31 no pude mergear el pull request de juguete"
  M1="$(harness_lab_remote_head main)"
  [ "$M1" != "$S2" ] || mal "T31 el merge de juguete fue fast-forward (tenía que ser un commit de merge)"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$M1" ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && ok "T31 mergeado el pull request (mismo número, otro commit): stable lo aplica, también con rama local + reset" || mal "T31 tras el merge: rc $RC rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE") (esperado $M1): $SALIDA"
  [ "$(estado "d['version']['number']")" = 2026.10.02.2 ] && ok "T31 …el número no cambió con el merge" || mal "T31 número tras el merge: $(estado "d['version']['number']")"

  # (6) .9 contra .10: por partes numéricas (como texto, «10» sería menor que «9»)
  harness_lab_publish_stable 2026.10.03.9
  harness update >/dev/null 2>&1
  [ "$(estado "d['version']['number']")" = 2026.10.03.9 ] || mal "T31 no llegué a 2026.10.03.9: $(estado "d['version']['number']")"
  harness channel latest >/dev/null 2>&1 || mal "T31 channel latest falló"
  harness_lab_publish_sync 2026.10.03.10
  S10="$(harness_lab_remote_head mirror/sync)"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$S10" ] && ok "T31 latest desde estable aplica en el próximo update: .10 es más nueva que .9" || mal "T31 .9 → .10: rc $RC HEAD $(head_de "$LAB_TREE") (esperado $S10): $SALIDA"
  harness channel stable >/dev/null 2>&1
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$(head_de "$LAB_TREE")" = "$S10" ] && case "$SALIDA" in *"instalada 2026.10.03.10, estable 2026.10.03.9: no se baja"*) true ;; *) false ;; esac && ok "T31 de vuelta a stable: .9 es más vieja que .10, no se baja" || mal "T31 .10 → .9: HEAD $(head_de "$LAB_TREE") (S10 $S10): $SALIDA"

  # (7) latest con mirror/sync más vieja que main: lee main
  harness channel latest >/dev/null 2>&1
  harness_lab_publish_stable 2026.10.04.1
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] && [ "$(fuente ref)" = main ] && ok "T31 latest con mirror/sync más vieja que main: lee main" || mal "T31 sync vieja: rc $RC ref $(fuente ref) HEAD $(head_de "$LAB_TREE"): $SALIDA"

  # (8) sin la rama en el remoto: latest lee main (no es «no pude mirar»)
  harness_lab_delete_sync || mal "T31 no pude borrar mirror/sync del remoto"
  harness_lab_publish_stable 2026.10.04.2
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] && [ "$(estado "d['version']['number']")" = 2026.10.04.2 ] && ok "T31 sin mirror/sync en el remoto: latest lee main" || mal "T31 sin la rama: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
  harness update --check >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && ok "T31 …y update --check da «al día» (0), no «no pude mirar» (2)" || mal "T31 sin la rama, update --check: rc $RC"
  harness_lab_git "$LAB_TREE" rev-parse -q --verify refs/remotes/origin/mirror/sync >/dev/null && mal "T31 quedó la copia local de una rama que el remoto ya no tiene" || ok "T31 …sin dejar la copia local de la rama borrada"
fi

# ═══ OTRO · con un remoto que no es el público: main sin reescritura, y lo dice ═══════════════════════════════════════
# 🔴 Rojo con un programa sin esta conducta: `doctor` y `channel` no dicen nada del remoto (el caso «es un clon interno» no se nombra).
if corre OTRO; then
  harness_lab_create "$BASE/otro" >/dev/null
  harness_lab_public "https://example.invalid/example-org/example-harness"
  SALIDA="$(harness install --yes --channel latest 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(fuente rewrites)" = False ] && ok "OTRO con otro remoto la fuente no se reescribe" || mal "OTRO install: rc $RC rewrites=$(fuente rewrites): $SALIDA"
  harness_lab_publish_sync 2026.10.02.1
  harness_lab_publish_stable 2026.10.02.5
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] && [ "$(rama_de "$LAB_TREE")" = main ] && [ "$(fuente ref)" = main ] && ok "OTRO latest lee main, en la rama main (sin tycon/installed)" || mal "OTRO update: rc $RC rama $(rama_de "$LAB_TREE") ref $(fuente ref) HEAD $(head_de "$LAB_TREE"): $SALIDA"
  case "$(harness doctor 2>&1)" in *"no es el repo público"*) ok "OTRO doctor lo dice" ;; *) mal "OTRO doctor no dice que el remoto no es el público: $(harness doctor 2>&1)" ;; esac
  case "$(harness channel 2>&1)" in *"no es el repo público"*main*) ok "OTRO channel lo dice" ;; *) mal "OTRO channel no lo dice: $(harness channel 2>&1)" ;; esac
  # espejo: en el clon público, ninguno de los dos lo dice
  harness_lab_create "$BASE/otro-espejo" >/dev/null
  harness_lab_public
  harness install --yes >/dev/null 2>&1 || mal "OTRO install del espejo falló"
  case "$(harness doctor 2>&1)$(harness channel 2>&1)" in *"no es el repo público"*) mal "OTRO el clon público dice que su remoto no es el público" ;; *) ok "OTRO espejo: el clon público no lo dice" ;; esac
fi

# ═══ D3 · una skill propia sin seguir dentro del clon: sin choque avanza, con choque no ═══════════════════════════════
# 🔴 Está en el caso de módulo (`harness-state.test.js`, «T7·módulo · ref reescrita»): con un `plan` que no distinga,
#    cualquier archivo sin seguir traba el reset («el árbol tiene cambios fuera de lo ignorado…»). ESTE recorrido
#    entero pasaría con un programa que no reconociera el clon público y avanzara con `merge --ff-only`:
#    acá se mide que, reconocido como público (rama `tycon/installed` + `reset --hard`), el archivo de la persona no
#    se pisa.
if corre D3; then
  harness_lab_create "$BASE/d3" >/dev/null
  harness_lab_public
  harness install --yes >/dev/null 2>&1 || mal "D3 install previo falló"
  mkdir -p "$LAB_TREE/skills/mine"; printf 'mi skill\n' > "$LAB_TREE/skills/mine/SKILL.md"
  harness_lab_publish_stable 2026.10.02.1
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && ok "D3 sin choque: update avanza (con rama local + reset)" || mal "D3 sin choque: rc $RC rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE"): $SALIDA"
  [ "$(cat "$LAB_TREE/skills/mine/SKILL.md" 2>/dev/null)" = "mi skill" ] && ok "D3 …y la skill propia sigue en su lugar" || mal "D3 sin choque: la skill propia no está"
  # la versión nueva trae ESA ruta
  harness_lab_publish_stable 2026.10.02.2 skills/mine/SKILL.md "la del arnés"
  ANTES="$(head_de "$LAB_TREE")"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" != 0 ] && [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && ok "D3 con choque: update no avanza (rc $RC)" || mal "D3 con choque: rc $RC HEAD $(head_de "$LAB_TREE") (antes $ANTES): $SALIDA"
  case "$SALIDA" in *"skills/mine/SKILL.md"*) ok "D3 …nombra la ruta que choca" ;; *) mal "D3 con choque: no nombra la ruta: $SALIDA" ;; esac
  [ "$(cat "$LAB_TREE/skills/mine/SKILL.md" 2>/dev/null)" = "mi skill" ] && ok "D3 …y el archivo de la persona queda intacto" || mal "D3 con choque: pisó el archivo: $(cat "$LAB_TREE/skills/mine/SKILL.md" 2>&1)"
  # espejo: movido el archivo, la misma versión entra
  mv "$LAB_TREE/skills/mine/SKILL.md" "$BASE/d3-mi-skill.md"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(cat "$LAB_TREE/skills/mine/SKILL.md" 2>/dev/null)" = "la del arnés" ] && ok "D3 espejo: sin el archivo en el camino, la versión entra" || mal "D3 espejo: rc $RC: $SALIDA"
fi

# ═══ A5 · con una ref que se reescribe se mueve sólo desde tycon/installed ════════════════════════════════════════════
# 🔴 Rojo con un programa sin esta conducta: desde otra rama `update` hace `checkout -B tycon/installed` + `reset --hard` y saca a la persona de
#    su rama sin avisar.
if corre A5; then
  harness_lab_create "$BASE/a5" >/dev/null
  harness_lab_public
  harness install --yes >/dev/null 2>&1 || mal "A5 install previo falló"
  harness_lab_publish_stable 2026.10.02.1
  harness update >/dev/null 2>&1
  [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && ok "A5 la primera vez (HEAD en el commit registrado) pasa a tycon/installed" || mal "A5 primera vez: rama $(rama_de "$LAB_TREE")"
  harness_lab_git "$LAB_TREE" checkout -q -b mine
  harness_lab_publish_stable 2026.10.02.2
  ANTES="$(head_de "$LAB_TREE")"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && [ "$(rama_de "$LAB_TREE")" = mine ] && ok "A5 desde otra rama: 2, y no movió el clon ni de commit ni de rama" || mal "A5 otra rama: rc $RC rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE"): $SALIDA"
  case "$SALIDA" in *"rama mine"*"tycon/installed"*) ok "A5 …y avisa el motivo" ;; *) mal "A5 no avisa el motivo: $SALIDA" ;; esac
  # espejo: de vuelta en tycon/installed, la misma versión entra
  harness_lab_git "$LAB_TREE" checkout -q tycon/installed
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] && ok "A5 espejo: desde tycon/installed se mueve" || mal "A5 espejo: rc $RC: $SALIDA"
fi

# ═══ ROTO · la versión nueva trae un version.json que no se deja leer: «no sé», nunca «nueva» ═════════════════════════
# Sin poder leer el número de lo traído no se sabe si es más nuevo: `update`
# NO mueve el clon, sale con el código de «no pude mirar» (2) y lo dice nombrando la ref y el archivo; `startup` lo deja
# en el aviso y en el registro como cualquier «no pude mirar», y esa mirada no cuenta. En los dos canales.
# 🔴 Rojo con un programa sin esta conducta: `update` da «arnés … → …» y deja el clon en el commit del version.json roto (rc 0), en los dos
#    canales: un número ilegible se lee como «sin número» y `latest` aplica (y `stable`, por no ser ancestro).
if corre ROTO; then
  LOG="$BASE/roto/home/.claude/.tycon-pipeline/harness/startup.log"
  harness_lab_create "$BASE/roto" >/dev/null
  harness_lab_public
  harness_lab_publish_stable 2026.10.01.1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  harness install --yes >/dev/null 2>&1 || mal "ROTO install previo falló"
  harness_lab_publish_stable 2026.10.02.1
  harness update >/dev/null 2>&1
  SANO="$(head_de "$LAB_TREE")"
  [ "$SANO" = "$(harness_lab_remote_head main)" ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] || mal "ROTO no llegué a la versión sana de partida"
  # stable: la punta de main trae un version.json con JSON roto
  LAB_VERSION_RAW='{ "version": roto' harness_lab_publish_stable rota
  ROTA="$(harness_lab_remote_head main)"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(head_de "$LAB_TREE")" = "$SANO" ] && ok "ROTO stable: update sale 2 («no pude mirar») y no mueve el clon" || mal "ROTO stable: rc $RC HEAD $(head_de "$LAB_TREE") (sano $SANO, roto $ROTA): $SALIDA"
  case "$SALIDA" in *"version.json"*"origin/main"*|*"origin/main"*"version.json"*) ok "ROTO …y lo dice, con la ref y el archivo" ;; *) mal "ROTO stable no nombra la ref y el archivo: $SALIDA" ;; esac
  case "$SALIDA" in *"al día"*|*" → "*) mal "ROTO stable dice «al día» o que aplicó: $SALIDA" ;; *) ok "ROTO …sin decir «al día» ni que aplicó" ;; esac
  harness update --check >/dev/null 2>&1; RC=$?
  [ "$RC" = 2 ] && ok "ROTO update --check: 2 (ni 0 «al día» ni 3 «hay nueva»)" || mal "ROTO update --check: rc $RC"
  case "$(harness doctor --fetch 2>&1)" in *"no pude mirar"*"version.json"*) ok "ROTO doctor --fetch: «no pude mirar», con el archivo" ;; *) mal "ROTO doctor --fetch: $(harness doctor --fetch 2>&1)" ;; esac
  # startup: al aviso y al registro, sin mover nada, y la mirada no se sella
  python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p, encoding='utf-8')); d['last_fetch']=None; d['last_fetch_failed']=None; json.dump(d, open(p,'w', encoding='utf-8'), indent=2)" "$(ESTADO)"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$SANO" ] && ok "ROTO startup (auto): sale 0 y no mueve el clon" || mal "ROTO startup: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
  case "$(estado "d.get('notice') or ''")" in *"version.json"*) ok "ROTO …lo deja en el aviso" ;; *) mal "ROTO startup sin aviso: $(estado "d.get('notice')")" ;; esac
  grep -q 'version.json' "$LOG" 2>/dev/null && ok "ROTO …y en startup.log" || mal "ROTO startup.log sin el motivo: $(tail -2 "$LOG" 2>&1)"
  [ "$(estado "d.get('last_fetch')")" = None ] && [ "$(estado "d.get('last_fetch_failed')")" != None ] && ok "ROTO …y esa mirada no cuenta (last_fetch sin sellar)" || mal "ROTO selló la mirada: last_fetch $(estado "d.get('last_fetch')")"
  # espejo: arreglado el archivo, update aplica
  harness_lab_publish_stable 2026.10.02.3
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] && [ "$(estado "d['version']['number']")" = 2026.10.02.3 ] && ok "ROTO espejo: arreglado el archivo, update aplica" || mal "ROTO espejo: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
  # latest: la sincronización trae el archivo roto — tampoco se aplica (un «sin número» en latest no se lee como «aplicar»)
  harness channel latest >/dev/null 2>&1 || mal "ROTO channel latest falló"
  SANO="$(head_de "$LAB_TREE")"
  LAB_VERSION_RAW='{ "version": roto' harness_lab_publish_sync rota
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(head_de "$LAB_TREE")" = "$SANO" ] && case "$SALIDA" in *"version.json"*"mirror/sync"*|*"mirror/sync"*"version.json"*) true ;; *) false ;; esac && ok "ROTO latest: 2, no mueve el clon y nombra origin/mirror/sync y el archivo" || mal "ROTO latest: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
  harness_lab_publish_sync 2026.10.02.4
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head mirror/sync)" ] && ok "ROTO espejo en latest: con la sincronización sana, update aplica" || mal "ROTO espejo latest: rc $RC: $SALIDA"

  # A11 («si su número es menor que el de main, latest lee main»): con el número de main ilegible no se elige rama a
  # ciegas — «no pude mirar»; y `channel stable`, que dice «no se baja» con lo último traído, dice que no lo pudo leer
  # 🔴 Rojo con un programa sin esta conducta: `channel stable` no dice nada del archivo (sólo «canal: latest → stable»).
  SANO="$(head_de "$LAB_TREE")"
  LAB_VERSION_RAW='{ "version": roto' harness_lab_publish_stable rota
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(head_de "$LAB_TREE")" = "$SANO" ] && case "$SALIDA" in *"version.json"*"origin/main"*|*"origin/main"*"version.json"*) true ;; *) false ;; esac && ok "ROTO latest con el número de main ilegible: no elige rama a ciegas (2, y nombra origin/main)" || mal "ROTO latest con main ilegible: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
  SALIDA="$(harness channel stable 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"no pude leer version.json de origin/main"*) true ;; *) false ;; esac && ok "ROTO channel stable: dice que no pudo leer el número de la estable (no calla como si no hubiera nada que decir)" || mal "ROTO channel stable con main ilegible (rc $RC): $SALIDA"
  case "$SALIDA" in *"no se baja"*) mal "ROTO channel stable afirma «no se baja» sin haber leído el número: $SALIDA" ;; *) ok "ROTO …sin afirmar «no se baja»" ;; esac

  # un remoto que NO es el público va por ancestría (main no se reescribe: no hay cómo bajar), así que la versión se
  # ofrece igual; pero el AVISO no le inventa un número a un version.json que no se pudo leer
  # 🔴 Rojo con un programa sin esta conducta: con `numberAt` devolviendo «problema» y el aviso sin adaptar, `startup` no deja aviso (falla
  #    interna al armarlo); un aviso que no distinga lleva el número derivado (fecha+sha), como
  #    si el commit no trajera el archivo.
  harness_lab_create "$BASE/roto-interno" >/dev/null
  harness install --yes >/dev/null 2>&1 || mal "ROTO install previo (interno) falló"
  ANTES="$(head_de "$LAB_TREE")"
  harness_lab_publish tree "version.json roto" version.json '{ "version": roto'
  NUEVO="$(harness_lab_remote_head main)"
  TYCON_UPDATE_APPLY=ask harness startup >/dev/null 2>&1
  N="$(estado "d.get('notice') or ''")"
  case "$N" in "arnés ${NUEVO:0:7} (su número no se pudo leer: version.json: JSON ilegible"*") disponible (instalada "*"update --yes"*"cambios: git -C "*) ok "ROTO remoto interno: el aviso nombra la versión por su sha y dice que el número no se pudo leer" ;; *) mal "ROTO aviso interno: $N" ;; esac
  case "$N" in *"+${NUEVO:0:7}"*) mal "ROTO el aviso le inventa un número derivado a un version.json ilegible: $N" ;; *) ok "ROTO …sin inventarle el número derivado" ;; esac
  [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && ok "ROTO …y ask no aplica" || mal "ROTO ask aplicó"
fi

# ═══ PULL · el clon que avanzó en main antes de su primera actualización no queda bloqueado ════════════════
# La regla aprobada no cambia: no se saca a una persona de una rama propia ni se pisan commits propios. Lo que se cierra
# es el callejón: «la primera vez» vale también para un avance simple en la rama por defecto (un `git pull` a mano, el
# `git pull --ff-only` del respaldo en shell), y ningún mensaje aconseja un comando que no puede funcionar.
# 🔴 Rojo con un programa sin esta conducta: 21 MAL — con el pull a mano y
#    con el respaldo en shell, `update` y `update --check` salen 2 con «harness está en la rama main y no en
#    tycon/installed: no se toca (git -C … checkout tycon/installed)», la versión siguiente nunca entra y `doctor`
#    queda en rojo; en `tycon/installed` con HEAD en la punta, «arnés al día» sin re-registrar y `doctor` en rojo; con
#    la rama propia, el comando aconsejado falla («pathspec 'tycon/installed' did not match»).
fallos_de_doctor() { harness doctor --json 2>/dev/null | python3 -c "import json,sys; print(' | '.join(json.loads(sys.stdin.read())['fail']))" 2>/dev/null; }
hay_rama() { harness_lab_git "$1" rev-parse --verify -q "refs/heads/$2" >/dev/null 2>&1; }
# el comando que un mensaje aconseja, corrido TAL CUAL (sin las variables de git de quien corre la prueba)
aconsejado() { printf '%s\n' "$1" | grep -o "git -C [^ ]* checkout -b tycon/installed [0-9a-f]\{40\}" | head -1; }
correr_aconsejado() { env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR bash -c "$1"; }
if corre PULL; then
  # (a) un `git pull --ff-only` a mano en main, todavía sin tycon/installed
  harness_lab_create "$BASE/pull-a" >/dev/null
  harness_lab_public
  harness_lab_publish_stable 2026.10.01.1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  harness install --yes >/dev/null 2>&1 || mal "PULL install previo (a) falló"
  R0="$(head_de "$LAB_TREE")"
  harness_lab_publish_stable 2026.10.02.1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  P1="$(head_de "$LAB_TREE")"
  [ "$P1" != "$R0" ] && [ "$(rama_de "$LAB_TREE")" = main ] && ! hay_rama "$LAB_TREE" tycon/installed && [ "$(fuente commit)" = "$R0" ] || mal "PULL (a) el laboratorio no quedó como el caso: rama $(rama_de "$LAB_TREE") HEAD $P1 registrado $(fuente commit)"
  # doctor queda en rojo (lo instalado no es lo registrado), y lo que promete es CIERTO: update lo re-registra
  case "$(fallos_de_doctor)" in *"no es el commit registrado"*"update"*"re-registra"*) ok "PULL pull a mano en main: doctor lo marca y remite a update" ;; *) mal "PULL (a) doctor: $(fallos_de_doctor)" ;; esac
  SALIDA="$(harness update --check 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"re-registraría"*) true ;; *) false ;; esac && ok "PULL …update --check: 0, y dice que se re-registraría (sin grabar)" || mal "PULL (a) update --check: rc $RC: $SALIDA"
  [ "$(fuente commit)" = "$R0" ] && ok "PULL …y no grabó nada" || mal "PULL (a) update --check grabó el re-registro"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(fuente commit)" = "$P1" ] && [ "$(estado "d['version']['number']")" = 2026.10.02.1 ] && ok "PULL …update re-registra el commit y la versión (2026.10.02.1)" || mal "PULL (a) update: rc $RC registrado $(fuente commit) (HEAD $P1) versión $(estado "d['version']['number']"): $SALIDA"
  case "$SALIDA" in *"commit re-registrado: harness ${R0:0:7} → ${P1:0:7}"*) ok "PULL …y lo dice" ;; *) mal "PULL (a) update no dice el re-registro: $SALIDA" ;; esac
  [ -z "$(fallos_de_doctor)" ] && ok "PULL …y doctor no queda en rojo" || mal "PULL (a) doctor sigue en rojo: $(fallos_de_doctor)"
  # sale otra versión: otro pull a mano, y la que sigue ENTRA (sin bloqueo permanente)
  harness_lab_publish_stable 2026.10.02.2
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  harness_lab_publish_stable 2026.10.03.1
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && ok "PULL con versión nueva después del pull a mano: update aplica y queda en tycon/installed" || mal "PULL (a) versión nueva: rc $RC rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE"): $SALIDA"
  [ "$(estado "d['version']['number']")" = 2026.10.03.1 ] && [ -z "$(fallos_de_doctor)" ] && ok "PULL …versión 2026.10.03.1 y doctor sin rojo" || mal "PULL (a) tras aplicar: versión $(estado "d['version']['number']") doctor: $(fallos_de_doctor)"
  [ "$(harness_lab_git "$LAB_TREE" rev-parse -q --verify refs/tycon/previous/harness)" = "$(harness_lab_git "$LAB_TREE" rev-parse main)" ] && ok "PULL …y previous es el commit que estaba (el del pull), para rollback" || mal "PULL (a) previous: $(harness_lab_git "$LAB_TREE" rev-parse -q --verify refs/tycon/previous/harness)"

  # (b) el respaldo en shell de verdad (la copia fija que dejó install): hace `git pull --ff-only` en main
  harness_lab_create "$BASE/pull-b" >/dev/null
  harness_lab_public
  harness_lab_publish_stable 2026.10.01.1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  harness install --yes >/dev/null 2>&1 || mal "PULL install previo (b) falló"
  R0="$(head_de "$LAB_TREE")"
  harness_lab_publish_stable 2026.10.02.1
  bash "$LAB_HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh" >/dev/null 2>&1
  P1="$(head_de "$LAB_TREE")"
  [ "$P1" = "$(harness_lab_remote_head main)" ] && [ "$P1" != "$R0" ] && [ "$(rama_de "$LAB_TREE")" = main ] || mal "PULL (b) el respaldo en shell no movió el clon en main: rama $(rama_de "$LAB_TREE") HEAD $P1"
  # con la política en ask: el arranque siguiente (ya con Node) mira, re-registra y ofrece la versión que salió después
  harness_lab_publish_stable 2026.10.03.1
  SALIDA="$(TYCON_UPDATE_APPLY=ask harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(fuente commit)" = "$P1" ] && [ -z "$(fallos_de_doctor)" ] && ok "PULL tras el respaldo en shell: el arranque siguiente re-registra el commit y doctor no queda en rojo" || mal "PULL (b) startup: rc $RC registrado $(fuente commit) (HEAD $P1) doctor: $(fallos_de_doctor): $SALIDA"
  case "$(estado "d.get('notice') or ''")" in "arnés 2026.10.03.1 ("*") disponible (instalada 2026.10.02.1, canal stable)"*) ok "PULL …y el aviso ofrece la nueva contra la que de verdad está instalada (2026.10.02.1)" ;; *) mal "PULL (b) aviso: $(estado "d.get('notice')")" ;; esac
  case "$(estado "d.get('notice') or ''")" in *"no se toca"*|*"checkout tycon/installed"*) mal "PULL (b) el aviso sigue con el bloqueo: $(estado "d.get('notice')")" ;; *) ok "PULL …sin el bloqueo «no se toca» en el aviso" ;; esac
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && [ -z "$(fallos_de_doctor)" ] && ok "PULL …y update aplica la versión siguiente (tycon/installed, doctor sin rojo)" || mal "PULL (b) update: rc $RC rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE") doctor: $(fallos_de_doctor): $SALIDA"

  # (c) ya en tycon/installed, HEAD llevado a mano a la punta de lo traído: «al día» re-registra (sin dejar doctor en rojo
  #     hasta la versión siguiente)
  harness_lab_create "$BASE/pull-c" >/dev/null
  harness_lab_public
  harness_lab_publish_stable 2026.10.01.1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  harness install --yes >/dev/null 2>&1 || mal "PULL install previo (c) falló"
  harness_lab_publish_stable 2026.10.02.1
  harness update >/dev/null 2>&1
  [ "$(rama_de "$LAB_TREE")" = tycon/installed ] || mal "PULL (c) no llegué a tycon/installed"
  R1="$(fuente commit)"
  harness_lab_publish_stable 2026.10.02.2
  harness_lab_git "$LAB_TREE" fetch -q origin main >/dev/null 2>&1
  harness_lab_git "$LAB_TREE" merge -q --ff-only origin/main >/dev/null 2>&1
  P2="$(head_de "$LAB_TREE")"
  [ "$P2" = "$(harness_lab_remote_head main)" ] && [ "$P2" != "$R1" ] || mal "PULL (c) el laboratorio no quedó como el caso"
  case "$(fallos_de_doctor)" in *"no es el commit registrado"*"update"*"re-registra"*) ok "PULL en tycon/installed con HEAD en la punta sin registrar: doctor lo marca y remite a update" ;; *) mal "PULL (c) doctor: $(fallos_de_doctor)" ;; esac
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(fuente commit)" = "$P2" ] && [ "$(estado "d['version']['number']")" = 2026.10.02.2 ] && case "$SALIDA" in *"commit re-registrado"*) true ;; *) false ;; esac && ok "PULL …update lo re-registra (commit y versión), y lo dice" || mal "PULL (c) update: rc $RC registrado $(fuente commit) (HEAD $P2): $SALIDA"
  [ -z "$(fallos_de_doctor)" ] && ok "PULL …y doctor no queda en rojo" || mal "PULL (c) doctor sigue en rojo: $(fallos_de_doctor)"
  # espejo: un commit PROPIO en tycon/installed no se registra como versión, y doctor no promete que update lo haga:
  # dice lo que pasa de verdad (la próxima actualización lo saca de la rama y queda en refs/tycon/previous/harness)
  harness_lab_git "$LAB_TREE" commit -q --allow-empty -m "commit propio" >/dev/null
  PROPIO="$(head_de "$LAB_TREE")"
  case "$(fallos_de_doctor)" in *"no es el commit registrado"*"update lo re-registra"*) mal "PULL (c) doctor promete un re-registro que no ocurre: $(fallos_de_doctor)" ;; *"no es el commit registrado"*"1 commit"*"refs/tycon/previous/harness"*) ok "PULL espejo: con un commit propio doctor no promete el re-registro, y dice dónde va a quedar" ;; *) mal "PULL (c) doctor con commit propio: $(fallos_de_doctor)" ;; esac
  TYCON_UPDATE_APPLY=ask harness update >/dev/null 2>&1
  [ "$(fuente commit)" = "$P2" ] && [ "$(head_de "$LAB_TREE")" = "$PROPIO" ] && ok "PULL …update (ask) no registra el commit propio como versión, ni lo toca" || mal "PULL (c) registró o movió un commit propio: registrado $(fuente commit) HEAD $(head_de "$LAB_TREE")"
  harness update >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$P2" ] && [ "$(harness_lab_git "$LAB_TREE" rev-parse -q --verify refs/tycon/previous/harness)" = "$PROPIO" ] && ok "PULL …y al aplicar pasa lo que doctor dijo: sale de la rama y queda en refs/tycon/previous/harness" || mal "PULL (c) tras aplicar: HEAD $(head_de "$LAB_TREE") previous $(harness_lab_git "$LAB_TREE" rev-parse -q --verify refs/tycon/previous/harness) (propio $PROPIO)"

  # (d) el caso que la regla protege: una rama propia con un commit propio, antes de la primera actualización
  harness_lab_create "$BASE/pull-d" >/dev/null
  harness_lab_public
  harness install --yes >/dev/null 2>&1 || mal "PULL install previo (d) falló"
  R0="$(head_de "$LAB_TREE")"
  harness_lab_git "$LAB_TREE" checkout -q -b mine
  printf 'trabajo propio\n' > "$LAB_TREE/mio.txt"
  harness_lab_git "$LAB_TREE" add mio.txt >/dev/null; harness_lab_git "$LAB_TREE" commit -q -m "trabajo propio" >/dev/null
  MIO="$(head_de "$LAB_TREE")"
  harness_lab_publish_stable 2026.10.02.1
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(head_de "$LAB_TREE")" = "$MIO" ] && [ "$(rama_de "$LAB_TREE")" = mine ] && ok "PULL espejo: rama propia con un commit propio — 2, y no se toca ni el commit ni la rama" || mal "PULL (d) rc $RC rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE"): $SALIDA"
  case "$SALIDA" in *"rama mine"*"1 commit"*) ok "PULL …dice qué hay (la rama y el commit propio)" ;; *) mal "PULL (d) no dice qué hay: $SALIDA" ;; esac
  case "$SALIDA" in *" checkout tycon/installed"*) mal "PULL (d) aconseja pasar a una rama que no existe: $SALIDA" ;; *) ok "PULL …sin aconsejar «checkout tycon/installed» (esa rama todavía no existe)" ;; esac
  case "$(fallos_de_doctor)" in *"update lo re-registra"*) mal "PULL (d) doctor promete un re-registro que no ocurre: $(fallos_de_doctor)" ;; *"no es el commit registrado"*"rama mine"*) ok "PULL …doctor dice lo mismo, sin prometer el re-registro" ;; *) mal "PULL (d) doctor: $(fallos_de_doctor)" ;; esac
  # el comando que aconseja se corre tal cual: funciona, deja la rama de la persona como estaba y update vuelve a andar
  CMD="$(aconsejado "$SALIDA")"
  [ -n "$CMD" ] && ok "PULL …aconseja un comando" || mal "PULL (d) el mensaje no trae un comando: $SALIDA"
  correr_aconsejado "${CMD:-false}" >/dev/null 2>&1; RC=$?
  [ "$RC" = 0 ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && [ "$(head_de "$LAB_TREE")" = "$R0" ] && ok "PULL …el comando aconsejado funciona (rc 0): tycon/installed en el commit registrado" || mal "PULL (d) el comando aconsejado «${CMD}» salió $RC (rama $(rama_de "$LAB_TREE"))"
  [ "$(harness_lab_git "$LAB_TREE" rev-parse mine)" = "$MIO" ] && ok "PULL …y la rama de la persona queda con su commit" || mal "PULL (d) la rama mine se movió"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] && [ "$(harness_lab_git "$LAB_TREE" rev-parse mine)" = "$MIO" ] && [ -z "$(fallos_de_doctor)" ] && ok "PULL …después update aplica, sin tocar la rama de la persona, y doctor sin rojo" || mal "PULL (d) update tras el remedio: rc $RC: $SALIDA · doctor: $(fallos_de_doctor)"
fi

# ═══ NEST · una carpeta sin seguir que es un repo de git propio ════════════════════════════════════════════
# git la lista como `carpeta/`, con barra final, y no dice qué hay adentro: choca con cualquier ruta que la versión nueva
# traiga bajo ella.
# 🔴 Rojo con un programa sin esta conducta: 5 MAL — `update` sale 0
#    («arnés … → …»), el clon avanza y `skills/mine/SKILL.md` queda con «la del arnés»: el trabajo sin commitear del
#    repo anidado, perdido sin copia.
if corre NEST; then
  harness_lab_create "$BASE/nest" >/dev/null
  harness_lab_public
  harness install --yes >/dev/null 2>&1 || mal "NEST install previo falló"
  MIA="$LAB_TREE/skills/mine"
  mkdir -p "$MIA"
  harness_lab_git "$MIA" init -q -b main >/dev/null
  printf 'mi skill\n' > "$MIA/SKILL.md"
  harness_lab_git "$MIA" add -A >/dev/null; harness_lab_git "$MIA" commit -q -m "mi skill" >/dev/null
  printf 'TRABAJO SIN COMMITEAR\n' > "$MIA/SKILL.md"; printf 'notas mías\n' > "$MIA/NOTES.md"
  [ "$(harness_lab_git "$LAB_TREE" ls-files --others --exclude-standard)" = "skills/mine/" ] || mal "NEST el laboratorio no quedó como el caso: git lista «$(harness_lab_git "$LAB_TREE" ls-files --others --exclude-standard)»"
  harness_lab_publish_stable 2026.10.02.1 skills/mine/SKILL.md "la del arnés"
  ANTES="$(head_de "$LAB_TREE")"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" != 0 ] && [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && ok "NEST repo anidado en el camino: update no avanza (rc $RC)" || mal "NEST avanzó o salió 0: rc $RC HEAD $(head_de "$LAB_TREE") (antes $ANTES): $SALIDA"
  case "$SALIDA" in *"skills/mine/"*"sin seguir"*) ok "NEST …nombra la carpeta que choca" ;; *) mal "NEST no nombra la ruta: $SALIDA" ;; esac
  [ "$(cat "$MIA/SKILL.md" 2>/dev/null)" = "TRABAJO SIN COMMITEAR" ] && [ "$(cat "$MIA/NOTES.md" 2>/dev/null)" = "notas mías" ] && ok "NEST …y lo que la persona tenía sin commitear queda intacto" || mal "NEST pisó el repo anidado: SKILL.md=«$(cat "$MIA/SKILL.md" 2>&1)»"
  # espejo: el repo anidado en una carpeta que la versión nueva NO trae: avanza, y el repo queda igual
  mv "$MIA" "$LAB_TREE/skills/mine-own"; MIA="$LAB_TREE/skills/mine-own"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] && [ "$(cat "$LAB_TREE/skills/mine/SKILL.md" 2>/dev/null)" = "la del arnés" ] && ok "NEST espejo: un repo anidado que no choca no traba, y la versión entra" || mal "NEST espejo: rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
  [ "$(cat "$MIA/SKILL.md" 2>/dev/null)" = "TRABAJO SIN COMMITEAR" ] && [ "$(cat "$MIA/NOTES.md" 2>/dev/null)" = "notas mías" ] && [ "$(harness_lab_git "$MIA" status --porcelain | tr -s ' \n' ' ')" = " M SKILL.md ?? NOTES.md " ] && ok "NEST …y el repo anidado queda igual (lo modificado y lo sin seguir, en su lugar)" || mal "NEST espejo: el repo anidado cambió: «$(harness_lab_git "$MIA" status --porcelain | tr -s ' \n' ' ')»"
fi

# ═══ CASE · una ruta que difiere sólo en la caja ═══════════════════════════════════════════════════════════
# En el disco de Mac y de Windows `Notes.md` y `notes.md` son el MISMO archivo. La comparación iguala la caja (y la forma
# de los acentos) sin mirar el disco: en uno que sí distingue frena de más, que es lo aceptado; por eso este caso vale
# igual en Linux. El criterio, con rutas sueltas, lo mide `harness-state.test.js` («T7·módulo · D3, los choques…»).
# 🔴 Rojo con un programa sin esta conducta: 6 MAL, en un disco de Mac —
#    `update` sale 0 las dos veces y `Notes.md` y `skills-own/Mine/SKILL.md` quedan con el contenido publicado.
if corre CASE; then
  harness_lab_create "$BASE/case" >/dev/null
  harness_lab_public
  harness install --yes >/dev/null 2>&1 || mal "CASE install previo falló"
  printf 'MIO\n' > "$LAB_TREE/Notes.md"
  printf 'otra cosa mía\n' > "$LAB_TREE/Notas-mias.md"
  harness_lab_publish_stable 2026.10.02.1 notes.md "del arnés"
  ANTES="$(head_de "$LAB_TREE")"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" != 0 ] && [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && ok "CASE Notes.md sin seguir contra notes.md nuevo: update no avanza (rc $RC)" || mal "CASE archivo: rc $RC HEAD $(head_de "$LAB_TREE") (antes $ANTES): $SALIDA"
  case "$SALIDA" in *"Notes.md"*"notes.md"*) ok "CASE …y nombra las dos rutas" ;; *) mal "CASE archivo: no nombra las dos rutas: $SALIDA" ;; esac
  case "$SALIDA" in *"Notas-mias.md"*) mal "CASE culpa a un archivo que no choca: $SALIDA" ;; *) ok "CASE …sin culpar a Notas-mias.md, que no choca" ;; esac
  [ "$(cat "$LAB_TREE/Notes.md" 2>/dev/null)" = "MIO" ] && ok "CASE …y el archivo de la persona queda intacto" || mal "CASE pisó Notes.md: «$(cat "$LAB_TREE/Notes.md" 2>&1)»"
  # espejo: movido el que choca, la versión entra aunque sigan ahí nombres realmente distintos
  mv "$LAB_TREE/Notes.md" "$BASE/case-Notes.md"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] && [ "$(cat "$LAB_TREE/notes.md" 2>/dev/null)" = "del arnés" ] && [ "$(cat "$LAB_TREE/Notas-mias.md" 2>/dev/null)" = "otra cosa mía" ] && ok "CASE espejo: con nombres realmente distintos la versión entra y lo de la persona sigue" || mal "CASE espejo (archivo): rc $RC HEAD $(head_de "$LAB_TREE"): $SALIDA"
  # una CARPETA que difiere sólo en la caja
  mkdir -p "$LAB_TREE/skills-own/Mine"; printf 'MIO (Mine)\n' > "$LAB_TREE/skills-own/Mine/SKILL.md"
  harness_lab_publish_stable 2026.10.02.2 skills-own/mine/SKILL.md "DEL ARNES"
  ANTES="$(head_de "$LAB_TREE")"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" != 0 ] && [ "$(head_de "$LAB_TREE")" = "$ANTES" ] && ok "CASE una carpeta que difiere sólo en la caja: update no avanza (rc $RC)" || mal "CASE carpeta: rc $RC HEAD $(head_de "$LAB_TREE") (antes $ANTES): $SALIDA"
  case "$SALIDA" in *"skills-own/Mine/SKILL.md"*"skills-own/mine/SKILL.md"*) ok "CASE …y nombra las dos rutas" ;; *) mal "CASE carpeta: no nombra las dos rutas: $SALIDA" ;; esac
  [ "$(cat "$LAB_TREE/skills-own/Mine/SKILL.md" 2>/dev/null)" = "MIO (Mine)" ] && ok "CASE …y el archivo de la persona queda intacto" || mal "CASE pisó skills-own/Mine/SKILL.md: «$(cat "$LAB_TREE/skills-own/Mine/SKILL.md" 2>&1)»"
  # espejo: con un nombre realmente distinto, avanza
  mv "$LAB_TREE/skills-own/Mine" "$LAB_TREE/skills-own/Mine-propia"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(cat "$LAB_TREE/skills-own/mine/SKILL.md" 2>/dev/null)" = "DEL ARNES" ] && [ "$(cat "$LAB_TREE/skills-own/Mine-propia/SKILL.md" 2>/dev/null)" = "MIO (Mine)" ] && ok "CASE espejo: una carpeta con nombre realmente distinto no traba, y queda como estaba" || mal "CASE espejo (carpeta): rc $RC: $SALIDA"
fi

# ═══ REF · una rama tycon/installed que no se puede leer no es «la primera vez» ═══════
# Decidir «la primera vez» por un `.ok` falso de git sería un error: un ref roto (basura en su archivo) sale igual que uno ausente,
# y el clon se movería sin saber si la rama del mecanismo existe. Por eso es «no pude leer»: no se mueve nada, se nombra la
# ref y cada comando sale con su código de «no pude» (update 2; rollback 1; doctor en rojo).
# 🔴 Rojo con un programa sin esta conducta: 5 MAL — `update` no dice qué
#    ref no pudo leer (sale 2 de casualidad: `offInstalledBranch` da vía libre y el que tropieza es el fetch de git,
#    «no pude traer … bad object»); `doctor` promete «update lo re-registra»; `startup` no deja aviso; `rollback`
#    aconseja `checkout -b tycon/installed`, como si la rama no existiera. El «podés moverte» con la ref rota, medido
#    sobre la función, está en `harness-state.test.js` («T7·módulo · una ref en tres estados…»).
if corre REF; then
  LA_REF="refs/heads/tycon/installed"
  BASURA="esto no es un sha"
  harness_lab_create "$BASE/ref" >/dev/null
  harness_lab_public
  harness_lab_publish_stable 2026.10.01.1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  harness install --yes >/dev/null 2>&1 || mal "REF install previo falló"
  harness apply >/dev/null 2>&1 || mal "REF apply previo falló"   # una copia con los commits de ahora, para rollback
  R0="$(head_de "$LAB_TREE")"
  # el clon avanza a mano en main (lo que `update` aceptaría como «la primera vez») y queda una copia a la que volver
  harness_lab_publish_stable 2026.10.02.1
  harness_lab_git "$LAB_TREE" pull -q --ff-only origin main >/dev/null 2>&1
  P1="$(head_de "$LAB_TREE")"
  [ "$P1" != "$R0" ] && [ "$(rama_de "$LAB_TREE")" = main ] || mal "REF el laboratorio no quedó como el caso: rama $(rama_de "$LAB_TREE") HEAD $P1"
  # la rama del mecanismo, con basura en su archivo: git no la puede leer
  ARCHIVO="$LAB_TREE/.git/$LA_REF"
  mkdir -p "$(dirname "$ARCHIVO")"; printf '%s\n' "$BASURA" > "$ARCHIVO"
  harness_lab_publish_stable 2026.10.03.1
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(head_de "$LAB_TREE")" = "$P1" ] && [ "$(rama_de "$LAB_TREE")" = main ] && ok "REF rama tycon/installed ilegible: update sale 2 y no mueve el clon" || mal "REF update: rc $RC rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE") (antes $P1): $SALIDA"
  case "$SALIDA" in *"no pude leer"*"$LA_REF"*) ok "REF …y dice qué ref no pudo leer" ;; *) mal "REF update no nombra la ref: $SALIDA" ;; esac
  case "$SALIDA" in *"al día"*|*" → "*|*"checkout"*) mal "REF update dice «al día», que aplicó, o aconseja un checkout: $SALIDA" ;; *) ok "REF …sin decir «al día», ni que aplicó, ni aconsejar un checkout" ;; esac
  [ "$(cat "$ARCHIVO" 2>/dev/null)" = "$BASURA" ] && ok "REF …y no pisó la ref que no pudo leer" || mal "REF update tocó la ref ilegible: «$(cat "$ARCHIVO" 2>&1)»"
  harness update --check >/dev/null 2>&1; RC=$?
  [ "$RC" = 2 ] && ok "REF update --check: 2 (ni 0 «al día» ni 3 «hay nueva»)" || mal "REF update --check: rc $RC"
  case "$(fallos_de_doctor)" in *"no pude leer"*"$LA_REF"*) ok "REF doctor: en rojo, con la ref" ;; *) mal "REF doctor no dice nada de la ref: «$(fallos_de_doctor)»" ;; esac
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$P1" ] && [ "$(rama_de "$LAB_TREE")" = main ] && case "$(estado "d.get('notice') or ''")" in *"no pude leer"*"$LA_REF"*) true ;; *) false ;; esac && ok "REF startup (auto): no mueve el clon y lo deja en el aviso" || mal "REF startup: rc $RC HEAD $(head_de "$LAB_TREE") aviso «$(estado "d.get('notice')")»: $SALIDA"
  # rollback: hay una copia a la que volver (la de antes del pull a mano), y la rama del mecanismo no se puede leer
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  [ "$RC" != 0 ] && [ "$(head_de "$LAB_TREE")" = "$P1" ] && [ "$(rama_de "$LAB_TREE")" = main ] && case "$SALIDA" in *"no pude leer"*"$LA_REF"*"no se tocó nada"*) true ;; *) false ;; esac && ok "REF rollback: no mueve el clon (rc $RC), nombra la ref y dice que no tocó nada" || mal "REF rollback: rc $RC rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE"): $SALIDA"
  case "$SALIDA" in *"checkout"*) mal "REF rollback aconseja un checkout sobre una ref que no pudo leer: $SALIDA" ;; *) ok "REF …sin aconsejar crear ni pasar a una rama que no pudo leer" ;; esac
  [ "$(cat "$ARCHIVO" 2>/dev/null)" = "$BASURA" ] && ok "REF …y no pisó la ref" || mal "REF rollback tocó la ref ilegible"
  # espejo sano: sin el archivo roto la rama de verdad no existe — es la primera vez, y todo vuelve a andar
  rm -f "$ARCHIVO"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$(harness_lab_remote_head main)" ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && [ -z "$(fallos_de_doctor)" ] && ok "REF espejo: con la rama ausente de verdad, update aplica (tycon/installed) y doctor sin rojo" || mal "REF espejo update: rc $RC rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE") doctor «$(fallos_de_doctor)»: $SALIDA"
  SALIDA="$(harness rollback 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$P1" ] && [ "$(rama_de "$LAB_TREE")" = tycon/installed ] && ok "REF espejo: y rollback, con la rama sana, vuelve a la versión anterior" || mal "REF espejo rollback: rc $RC rama $(rama_de "$LAB_TREE") HEAD $(head_de "$LAB_TREE") (esperado $P1): $SALIDA"
fi

# ═══ T48 · Channel_Set_WritesThroughSetKey_SameResult ══════════════════════════════════
# Hay UN escritor de ~/.claude/tycon.json (`setKey` de scripts/lib/tycon-config.js), y `channel` lo usa.
# Lo que no puede cambiar es el resultado: el archivo queda como lo dejaría un escritor propio de `channel` —el JSON leído, con
# `update.channel` fijado y todo lo demás en su orden y con sus nombres, escrito con dos espacios y un salto final—.
# Fija la conducta: con un escritor propio también pasa (es lo que se compara). Lo que la haría fallar es un escritor
# que reordene, renombre o pierda una sección o una clave.
if corre T48; then
  echo "T48 · Channel_Set_WritesThroughSetKey_SameResult"
  harness_lab_create "$BASE/t48" >/dev/null
  export TYCON_GUARD_LIB_FOR_TEST="$BASE/t48/sin-freno.js"
  harness install --yes >/dev/null 2>&1 || mal "T48 install previo falló"
  printf '%s\n' '{' '  "ado": { "org": "https://dev.azure.com/acme" },' '  "integrations": { "engram": true, "clockify": false },' \
    '  "update": { "apply": "auto" },' '  "packs": { "default": "all" },' '  "install": { "profile": "full" }' '}' > "$LAB_HOME/.claude/tycon.json"
  # lo que dejaría un escritor propio de `channel`, calculado aparte
  python3 - "$LAB_HOME/.claude/tycon.json" "$BASE/t48/esperado.json" <<'PY2'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
u = d.get("update") if isinstance(d.get("update"), dict) else {}
u["channel"] = "latest"
d["update"] = u
open(sys.argv[2], "w", encoding="utf-8").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY2
  SALIDA="$(harness channel latest 2>&1)"; RC=$?
  if [ "$RC" = 0 ] && cmp -s "$LAB_HOME/.claude/tycon.json" "$BASE/t48/esperado.json"; then ok "T48 channel latest sobre un tycon.json con otras secciones: el mismo archivo que dejaba el escritor de antes, byte a byte"
  else mal "T48 channel latest: rc $RC · $(diff "$LAB_HOME/.claude/tycon.json" "$BASE/t48/esperado.json" | head -6 | tr '\n' ' ') · $SALIDA"; fi
  case "$SALIDA" in *"canal: (por defecto) → latest en "*) ok "T48 …y dice antes → después como siempre" ;; *) mal "T48 la línea de channel cambió: $SALIDA" ;; esac
  # un tycon.json roto: no se escribe (el archivo roto queda como está)
  printf '{ roto\n' > "$LAB_HOME/.claude/tycon.json"
  SALIDA="$(harness channel stable 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ "$(cat "$LAB_HOME/.claude/tycon.json")" = '{ roto' ] && ok "T48 un tycon.json roto: 2 y no se escribe" || mal "T48 tycon.json roto: rc $RC · $(cat "$LAB_HOME/.claude/tycon.json") · $SALIDA"
  unset TYCON_GUARD_LIB_FOR_TEST
fi

if [ "$FALLOS" = 0 ]; then echo "✅ harness-channel: todo verde"; exit 0; fi
echo "❌ harness-channel: $FALLOS fallo(s)"; exit 1
