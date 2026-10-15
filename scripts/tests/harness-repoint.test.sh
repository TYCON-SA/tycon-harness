#!/usr/bin/env bash
# harness-repoint.test.sh — la llave `update.skills_source`: re-apuntar el clon viejo de agent-skills al repo unificado,
# deshacerlo, y la guarda que nunca deja a una máquina sin skills (story 8.18, tramo 3 · T32, T33, T34 y T35).
#
# El caso: los dos repos internos (el arnés y agent-skills) se unieron en uno. Cada máquina del equipo sigue con sus DOS
# clones hasta que la llave pasa a `unified`: ahí `harness.js startup` / `update` cambia el remoto de
# `~/.claude/agent-skills` al del repo unificado y lo avanza en línea recta al mismo commit que el clon del arnés. Es una
# mudanza sobre las máquinas de todo el equipo: lo que se prueba acá es que NADA de lo del dev se mueve, que se deshace
# con un paso, y que si no puede pasar no toca nada y lo dice.
#
# Lo que no se puede perder:
#   T32 · con la llave en `unified`, un `startup`: (a) el `origin` del clon viejo es el del repo unificado y el estado
#        guarda de dónde venía (URL y commit); (b) el clon quedó en el MISMO commit que el clon del arnés; (c) lo sin
#        versionar, lo ignorado, las skills de terceros y el stash están idénticos, y los enlaces y settings.json no se
#        tocaron; (d) ese clon muestra sólo agents/, skills/, packs/ y los archivos de la raíz (el instalador no está ahí);
#        (e) UNA línea, una vez: el segundo `startup` no cambia nada y no dice nada. Hay copia de seguridad de antes.
#        Después, cada `update` deja los dos clones en el mismo commit, y `version` muestra uno solo (AC 35).
#   T33 · si no puede pasar —otra rama, commits propios, un archivo sin versionar o ignorado que choca con una ruta que
#        llega, sin red, historia sin unir, un fallo a mitad de camino— no se mueve NINGUNA de las dos fuentes (tampoco el
#        arnés, aunque haya versión nueva), el aviso nombra la causa y el comando, `doctor` queda en rojo, «sin red» se
#        reintenta en el arranque siguiente y una causa permanente no se reintenta sobre lo mismo. Y arreglada la causa,
#        la misma máquina pasa (espejo).
#   T34 · con la llave de vuelta en `separate`: el `origin` vuelve a la URL guardada y la rama al commit guardado, el clon
#        vuelve a mostrar todo y el estado queda como antes. Ida y vuelta completa deja la máquina BYTE A BYTE como al
#        principio (remoto, commit, configuración de git, árbol de trabajo, refs, listados, estado). Con el remoto viejo
#        caído no toca nada y lo dice; cuando vuelve, pasa.
#   T35 · la guarda: una fuente de la que salen las skills nunca avanza a una punta que no trae `skills/tycon-pipeline`
#        (`main` devuelto a un árbol de antes de la unión): en la máquina re-apuntada y en la de un solo árbol no se mueve
#        ninguna fuente, las skills siguen, y el aviso lo dice. Espejo: en la máquina de dos clones SIN re-apuntar el clon
#        del arnés sí sigue a `main` (es el retorno de antes de la llave), y las skills siguen en el clon viejo.
#   LINK · `~/.claude/agent-skills` es un ENLACE a un clon viejo que vive en otra carpeta: pasa igual, y después de
#        re-apuntar el instalador lo sigue reconociendo como la transición (no vuelve a avisar).
#   CRASH · una ida que se cortó en el medio (el estado quedó con la mudanza «en curso»): el arranque siguiente la
#        deshace y, con la llave apagada, la máquina queda como al principio.
#   REAL · con el aplicador de VERDAD: después de re-apuntar no imprime ni una línea más que antes, ni con `--check`.
#
# Laboratorio: `harness_lab_team_machine` (scripts/tests/lib/harness-lab.sh): HOME de juguete, dos remotos de juguete con
# historia unida de verdad, el clon viejo con cosas sin versionar, ignoradas y un stash. Nunca ~/.claude ni el checkout
# real. 🔴 Sin pipes sobre el comando medido. JSON con node (sin python3: la suite se mide también en Windows).
#
#   ADOPT · el estado se perdió (desinstalar y volver a instalar) con el clon ya re-apuntado: el arranque lo reconoce por
#        la constancia que la mudanza deja dentro del clon, la máquina se sigue actualizando, y la vuelta sigue andando.
#
# Lo que confirmó el pase adversarial del tramo 3 (2026-10-04), una sección por causa. Cada una se puso roja antes del
# arreglo, con el guion que reprodujo el hallazgo:
#   SAME  · `~/.claude/agent-skills` pasó a ser un enlace al CLON DEL ARNÉS y el estado todavía lista la fuente vieja: la
#        mudanza (ida, vuelta, deshacer una en curso) se niega y ese clon no se toca; el comando que el aviso nombra
#        (`harness.js install`) vuelve a detectar las fuentes y la máquina se actualiza otra vez (clases 1 y 20).
#   VIEW  · la vista reducida se lee por su valor EFECTIVO (`.git/config.worktree` le gana a `.git/config`): un clon donde
#        alguna vez se corrió `git sparse-checkout disable` re-apunta y vuelve; una vista propia hecha con el comando
#        estándar se detecta; y el remedio que el aviso nombra destraba, corrido tal cual (clases 7, 8, 10 y 11).
#   BACK  · la vuelta no pisa nada del dev: un archivo sin versionar o ignorado en una ruta que vuelve la frena; una
#        mudanza en curso no se deshace sobre una rama del dev; lo que estaba en el índice vuelve en el índice; y un
#        renombre sin commitear no esconde la ruta que la versión nueva cambia (clases 3, 9, 16, 17, 18 y 19).
#   STATE · el estado se contrasta con el clon de verdad: «sin constancia» no frena ningún arranque, seguir el remedio
#        del aviso lo saca, `--dry-run` no deja nada grabado, y doctor no dice «re-apuntado» de un clon que sigue al
#        repo viejo (clases 4, 5, 6, 12 y 13).
#   NFF   · «no avanza en línea recta» ya arreglado en el repo unificado: `harness.js update` a mano trae el arnés y
#        reintenta la mudanza en el mismo comando; sin arreglar, no mueve ninguna fuente (clase 2).
#   ARGS  · una URL del estado que empieza con «-» no llega a git como opción (revisor de seguridad).
#   (y en T35: «no pude leer si de esa fuente salen las skills» no es «no salen»: no se avanza y se dice.)
#
# Lo que encontró la segunda vuelta del revisor de fallos silenciosos (2026-10-04): «no pude mirar» nunca es «no hay».
# Cada una inyecta el fallo con un git de laboratorio delante del PATH (`blind_git`) o con permisos quitados, y se puso
# roja antes del arreglo:
#   REDETECT · `install` no suelta una fuente cuya carpeta no pudo mirar (permisos, un disco que no responde) ni borra lo
#        anotado de su mudanza: sólo la que de verdad ya no existe.
#   IDENTITY · si no se pudo leer la identidad de los dos clones, la vuelta no le hace `reset` al clon del arnés: no se
#        toca nada, se dice, y se reintenta en el arranque siguiente.
#   HIDDEN · si no se pudo contar lo que la vista oculta, la vuelta no dice «muestra todo»: queda a medias y lo dice.
#   POP · si lo local apartado en un stash no se pudo reaplicar en un camino de error, se dice con `stash list`.
#   CONTAINS · `update` a mano que no pudo comparar lo publicado con el commit del clon de skills no dice «todavía no lo
#        contiene»: dice que no pudo comparar.
#   PARTIAL · deshacer una ida en curso que no pudo listar lo que cambia no la da por deshecha.
#
# La tercera vuelta (2026-10-04, revisor de fallos silenciosos y revisor de pruebas) sumó, en esas mismas secciones:
#   PARTIAL · una puerta por cada «no pude mirar» de la limpieza del merge a medias, y la comparación de cada archivo con
#        la versión nueva en tres estados: si no pudo leer el disco, la versión nueva o las dos —o mirar si el archivo
#        está (permisos)—, no pisa ni borra nada y lo dice.  REDETECT · `install` que no pudo mirar una fuente sale 1
#        también sin la comprobación de salud (`--from-existing`).  IDENTITY · medido con un árbol de trabajo enlazado
#        (`git worktree`), en cualquier disco.  HIDDEN y POP · la puerta y el espejo que faltaban.  CONTAINS · las otras
#        tres ramas de «no pude mirar» de `update` a mano.  GUARD · que TODO armado pase por `lab_guard`, y que el cierre
#        cuente lo NO MEDIDO (con algo sin medir no dice «todo verde»).
#
#   GUARD · la suite corta si la HOME no es la del laboratorio (nada corre sobre la ~/.claude de verdad).
# Uso: bash scripts/tests/harness-repoint.test.sh [--only T32|T33|T34|T35|LINK|CRASH|ADOPT|REAL|SAME|VIEW|BACK|STATE|NFF|ARGS|REDETECT|IDENTITY|HIDDEN|POP|PARTIAL|CONTAINS|GUARD]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
ONLY=""; [ "${1:-}" = "--only" ] && ONLY="${2:-}"
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
# lo que esta máquina no deja medir: se cuenta, y una suite con algo sin medir no dice «todo verde» (tercera vuelta)
NO_MEDIDOS=0
no_medido() { echo "  ⏭   — $1 NO MEDIDO: $2"; NO_MEDIDOS=$((NO_MEDIDOS+1)); }
T_INICIO=$(date +%s)
BASE="$(mktemp -d)"
node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" harness-repoint || exit 1
# u+rwx (no sólo u+w): una carpeta que una prueba dejó en `chmod 000` también se puede recorrer y borrar
trap 'chmod -R u+rwx "$BASE" 2>/dev/null; rm -rf "$BASE"' EXIT
[ -f "$RAIZ/scripts/setup/harness/repoint.js" ] || mal "falta scripts/setup/harness/repoint.js (la feature no existe)"

ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
LOG() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log"; }
# estado '<expresión js sobre d>'  — un valor del estado («null» si no está)
estado() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(new Function("d","return ("+process.argv[2]+")"))(d);process.stdout.write(v===undefined||v===null?"null":(typeof v==="string"?v:JSON.stringify(v)))' "$(ESTADO)" "$1" 2>/dev/null; }
# estado_set '<sentencias js sobre d>'  — edita el estado a mano (sólo las pruebas lo hacen)
estado_set() { node -e 'const fs=require("fs"),p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf8"));(new Function("d",process.argv[2]))(d);fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' "$(ESTADO)" "$1"; }
fuente() { estado "(d.sources.find((s)=>s.name==='$1')||{})['$2']"; }
doctor_json() { node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{const d=JSON.parse(s);const v=(new Function("d","return ("+process.argv[1]+")"))(d);process.stdout.write(typeof v==="string"?v:JSON.stringify(v))})' "$1" 2>/dev/null; }
head_de() { harness_lab_git "$1" rev-parse HEAD; }
sk() { harness_lab_git "$LAB_SKILLS" "$@"; }          # git en el clon viejo de agent-skills
origen_de() { harness_lab_git "$1" remote get-url origin; }
lineas() { printf '%s' "$1" | grep -c . ; }
copias_de() { harness rollback --list 2>/dev/null | grep -c " · $1 · " ; }
visibles() { sk ls-files -t | grep -v '^S ' | cut -c3- | grep '/' | cut -d/ -f1 | LC_ALL=C sort -u | tr '\n' ' '; }   # las carpetas de la raíz que el clon muestra
export TYCON_UPDATE_APPLY=auto   # la política del equipo, sin perfil en el laboratorio
con_llave() { TYCON_UPDATE_SKILLS_SOURCE=unified "$@"; }

# la máquina del equipo DESPUÉS del corte y con la llave apagada: dos clones, el del arnés ya en la unión
# Nada de esta suite corre sobre la HOME de verdad: si el laboratorio no la tomó (armarlo falló antes de cambiarla), se
# corta la suite entera en rojo, en vez de seguir con `harness startup` y los remedios de los avisos sobre ~/.claude.
lab_guard() {
  case "$HOME" in "$BASE"/*) return 0 ;; esac
  echo "❌ harness-repoint: la HOME no es la del laboratorio (${HOME}): corto antes de tocar nada de verdad"
  exit 1
}
# TODO armado de laboratorio de esta suite pasa por estas dos: arman y, salga bien o mal, `lab_guard` mira la HOME antes
# de que la sección siga (tercera vuelta del revisor de pruebas: T35, LINK, STATE y REAL armaban por su cuenta y, si el
# armado fallaba, seguían). GUARD comprueba que no quede ningún armado por fuera de ellas.
lab_team() { harness_lab_team_machine "$@" >/dev/null; local rc=$?; lab_guard; return $rc; }      # lab:wrapper
lab_single() { harness_lab_single_tree "$@" >/dev/null; local rc=$?; lab_guard; return $rc; }      # lab:wrapper
# sólo para GUARD: el armado falla ANTES de tomar la HOME (lo que pasaría con un disco lleno o un git que no arranca)
if [ "${LAB_BREAK_BEFORE_HOME:-}" = 1 ]; then
  harness_lab_team_machine() { return 1; }      # lab:wrapper
  harness_lab_single_tree() { return 1; }       # lab:wrapper
fi
maquina() { # maquina <dir>
  lab_team "$1" toy; local rc=$?
  [ "$rc" = 0 ] || return 1
  harness install --yes >/dev/null 2>&1 || return 1
  harness_lab_cut || return 1
  harness update >/dev/null 2>&1 || return 1
  [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_SKILLS" ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ]
}
# todo lo que la mudanza no puede dejar distinto en el clon viejo y a su alrededor (sin el estado: va aparte)
foto() { # foto <archivo>
  {
    echo "origin: $(origen_de "$LAB_SKILLS")"
    echo "head: $(sk rev-parse HEAD)"
    echo "rama: $(sk symbolic-ref --short -q HEAD)"
    echo "config de git: $(shasum -a 256 < "$LAB_SKILLS/.git/config" | cut -d' ' -f1)"
    echo "config.worktree: $([ -e "$LAB_SKILLS/.git/config.worktree" ] && shasum -a 256 < "$LAB_SKILLS/.git/config.worktree" | cut -d' ' -f1 || echo no)"
    echo "info: $(ls -A "$LAB_SKILLS/.git/info" | tr '\n' ' ')"
    echo "constancia de la mudanza en el clon: $([ -e "$LAB_SKILLS/.git/tycon-repoint.json" ] && echo está || echo no)"
    echo "árbol de trabajo: $(harness_lab_worktree_hash "$LAB_SKILLS")"
    echo "lo que git no sigue y los stash: $(harness_lab_clone_extras "$LAB_SKILLS")"
    echo "status:"; sk status --porcelain --ignored
    echo "stash:"; sk stash list --format='%H %gs'
    echo "refs:"; sk for-each-ref --format='%(refname) %(objectname)'
    echo "ocultos: $(sk ls-files -t | grep -c '^S ')"
    echo "arnés: $(head_de "$LAB_TREE") $(origen_de "$LAB_TREE")"
    echo "enlaces:"; harness_lab_links
    echo "settings.json: $(shasum -a 256 < "$TYCON_SETTINGS_PATH" | cut -d' ' -f1)"
  } > "$1" 2>&1
}
# lo del estado que la ida y la vuelta tienen que dejar como estaba
foto_estado() { estado 'JSON.stringify({mode:d.mode,tree:d.tree,sources:d.sources,channel:d.channel,repoint:d.repoint===undefined?"(sin la clave)":d.repoint,hold:d.hold,failed:d.failed})' > "$1"; }
igual() { cmp -s "$1" "$2"; }
tr_() { harness_lab_git "$LAB_TREE" "$@"; }           # git en el clon del arnés
# todo lo que la mudanza no puede dejar distinto en el clon del ARNÉS
foto_arbol() { # foto_arbol <archivo>
  {
    echo "origin: $(origen_de "$LAB_TREE")"
    echo "head: $(tr_ rev-parse HEAD)"
    echo "rama: $(tr_ symbolic-ref --short -q HEAD)"
    echo "config de git: $(shasum -a 256 < "$LAB_TREE/.git/config" | cut -d' ' -f1)"
    echo "config.worktree: $([ -e "$LAB_TREE/.git/config.worktree" ] && echo está || echo no)"
    echo "info: $(ls -A "$LAB_TREE/.git/info" | tr '\n' ' ')"
    echo "árbol de trabajo: $(harness_lab_worktree_hash "$LAB_TREE")"
    echo "status:"; tr_ status --porcelain
    echo "refs:"; tr_ for-each-ref --format='%(refname) %(objectname)'
    echo "ocultos: $(tr_ ls-files -t | grep -c '^S ')"
  } > "$1" 2>&1
}
# remedio '<texto del aviso>' '<comienzo del comando>'  — el comando que el aviso nombra como arreglo (lo que va entre
# « — » y «; después:»), tal cual: la prueba lo CORRE. Si el aviso no lo trae, sale vacío
remedio() { printf '%s\n' "$1" | sed -n "s/.* — \\($2[^;]*\\); después: .*/\\1/p" | head -1; }
# corre_remedio '<comando>' — el remedio tal cual; cada `harness.js install` que trae, con `--yes` escrito acá (también en
# un remedio de varios comandos encadenados): la prueba no tiene terminal, y desde la story 8.16 (tanda B) install sin
# terminal muestra el plan y no escribe (AC 44)
corre_remedio() { bash -c "${1//harness.js install/harness.js install --yes}"; }
suelta_la_mirada() { estado_set 'd.last_fetch=null; d.last_fetch_failed=null'; }   # el arranque siguiente vuelve a mirar la red
# blind_git '<patrones>' <comando…>  — el comando con un git de laboratorio delante del PATH que FALLA (sale 128, y lo dice
# por stderr) en las llamadas cuyos argumentos —« <args> », como los recibe git— calzan con alguno de los patrones (de sh,
# separados por «|»); todas las demás van al git de verdad. Así se mide «no pude mirar» sin romper el laboratorio
LAB_REAL_GIT="$(command -v git)"; mkdir -p "$BASE/blind-bin"
cat > "$BASE/blind-bin/git" <<EOF
#!/bin/sh
# git de laboratorio (harness-repoint.test.sh): falla en lo que nombra LAB_GIT_FAIL; lo demás, al git de verdad. Con
# LAB_GIT_ARM, recién empieza a fallar DESPUÉS de una llamada que calza con ese patrón (la deja pasar y prende la marca
# LAB_GIT_ARMED): así falla una lectura que el comando repite, sólo a partir de cierto paso
all=" \$* "
if [ -n "\${LAB_GIT_ARM:-}" ]; then
  case "\$all" in \$LAB_GIT_ARM) : > "\$LAB_GIT_ARMED"; exec "$LAB_REAL_GIT" "\$@" ;; esac
  [ -f "\$LAB_GIT_ARMED" ] || exec "$LAB_REAL_GIT" "\$@"
fi
if [ -n "\${LAB_GIT_FAIL:-}" ]; then
  set -f; ifs="\$IFS"; IFS='|'
  for pat in \$LAB_GIT_FAIL; do
    case "\$all" in \$pat)
      # con LAB_GIT_ONCE (una marca), sólo falla la PRIMERA llamada que calza; las siguientes van al git de verdad
      if [ -n "\${LAB_GIT_ONCE:-}" ]; then [ -f "\$LAB_GIT_ONCE" ] && exec "$LAB_REAL_GIT" "\$@"; : > "\$LAB_GIT_ONCE"; fi
      echo "fatal: no pude (git de laboratorio)" >&2; exit 128 ;;
    esac
  done
  IFS="\$ifs"; set +f
fi
exec "$LAB_REAL_GIT" "\$@"
EOF
chmod +x "$BASE/blind-bin/git"
blind_git() { local pats="$1"; shift; PATH="$BASE/blind-bin:$PATH" LAB_GIT_FAIL="$pats" "$@"; }
# blind_git_after '<patrón que arma>' '<patrones>' <comando…>  — igual, pero falla recién después de la llamada que arma
# blind_git_once '<patrones>' <comando…>  — igual, pero sólo falla la primera llamada que calza
blind_git_once() { local pats="$1"; shift; rm -f "$BASE/blind-bin/once"; PATH="$BASE/blind-bin:$PATH" LAB_GIT_ONCE="$BASE/blind-bin/once" LAB_GIT_FAIL="$pats" "$@"; }
blind_git_after() { local arm="$1" pats="$2"; shift 2; rm -f "$BASE/blind-bin/armed"; PATH="$BASE/blind-bin:$PATH" LAB_GIT_ARM="$arm" LAB_GIT_ARMED="$BASE/blind-bin/armed" LAB_GIT_FAIL="$pats" "$@"; }

# ═══ T32 · Repoint_FastForward_NothingMovesOnDisk_StateUpdated_Idempotent ════════════════════════════════════════════
if corre T32; then
  maquina "$BASE/t32" || mal "T32 no pude armar la máquina del equipo después del corte"
  [ -f "$LAB_SKILLS/.githooks/pre-commit" ] && [ ! -e "$LAB_SKILLS/scripts" ] || mal "T32 precondición: el clon viejo no tiene la forma esperada"
  EXTRAS0="$(harness_lab_clone_extras "$LAB_SKILLS")"; STATUS0="$(sk status --porcelain --ignored)"; STASH0="$(sk stash list --format='%H %gs')"
  # lo que git no sigue, archivo por archivo. (`git status --ignored` no sirve para comparar después de la ida: el
  # .gitignore pasa a ser el del repo unido, y una carpeta que antes salía entera como ignorada —`!! .advisors/`— sale
  # archivo por archivo. Cambia cómo se LISTA, no lo que hay: a la vuelta, T34 compara el status tal cual.)
  SUELTOS0="$(sk ls-files --others | LC_ALL=C sort)"
  ENLACES0="$(harness_lab_links)"; SETTINGS0="$(shasum -a 256 < "$TYCON_SETTINGS_PATH")"
  [ -n "$STASH0" ] && [ "$(printf '%s\n' "$STATUS0" | grep -c .)" = 4 ] || mal "T32 precondición: el clon viejo no trae sus dos sin versionar, dos ignorados y un stash: «${STATUS0}»"
  # sin la llave nada pasa: el arranque de siempre no re-apunta
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -z "$SALIDA" ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(estado 'd.repoint')" = null ] \
    && ok "T32 espejo: con la llave en separate (por defecto) el arranque no re-apunta ni dice nada" || mal "T32 sin la llave: rc $RC, «${SALIDA}», origin $(origen_de "$LAB_SKILLS"), repoint $(estado 'd.repoint')"
  # --dry-run dice lo que haría y no mueve nada
  SALIDA="$(con_llave harness update --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"se re-apuntaría"*) true ;; *) false ;; esac && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_SKILLS" ] && [ "$(estado 'd.repoint')" = null ] \
    && ok "T32 update --dry-run con la llave: dice que se re-apuntaría y no mueve nada" || mal "T32 --dry-run: rc $RC: $SALIDA"
  # la ida
  SALIDA="$(con_llave harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(lineas "$SALIDA")" = 1 ] && case "$SALIDA" in *"re-apuntad"*) true ;; *) false ;; esac \
    && ok "T32 (e) startup con la llave: sale 0 y dice UNA línea, la del re-apuntado" || mal "T32 (e) startup: rc $RC, $(lineas "$SALIDA") línea(s): $SALIDA"
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(origen_de "$LAB_SKILLS")" = "$(origen_de "$LAB_TREE")" ] \
    && ok "T32 (a) el origin del clon viejo es el del repo unificado, el mismo que el del clon del arnés" || mal "T32 (a) origin: $(origen_de "$LAB_SKILLS") (arnés: $(origen_de "$LAB_TREE"))"
  [ "$(fuente agent_skills url)" = "$LAB_REMOTE_UNIFIED" ] && [ "$(estado 'd.repoint.applied.from.url')" = "$LAB_REMOTE_SKILLS" ] && [ "$(estado 'd.repoint.applied.from.commit')" = "$LAB_COMMIT_SKILLS" ] \
    && ok "T32 (a) el estado tiene la URL nueva de la fuente y guarda de dónde venía (URL y commit)" || mal "T32 (a) estado: url $(fuente agent_skills url), repoint $(estado 'd.repoint')"
  [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_TREE")" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_UNION" ] && [ "$(fuente agent_skills commit)" = "$LAB_COMMIT_UNION" ] && [ "$(sk symbolic-ref --short -q HEAD)" = main ] \
    && ok "T32 (b) el clon avanzó en línea recta y quedó en el mismo commit que el clon del arnés, en main" || mal "T32 (b) skills $(head_de "$LAB_SKILLS") arnés $(head_de "$LAB_TREE") estado $(fuente agent_skills commit)"
  [ "$(harness_lab_clone_extras "$LAB_SKILLS")" = "$EXTRAS0" ] && [ "$(sk ls-files --others | LC_ALL=C sort)" = "$SUELTOS0" ] && [ "$(sk stash list --format='%H %gs')" = "$STASH0" ] \
    && ok "T32 (c) lo sin versionar, lo ignorado, la skill de terceros y el stash: idénticos (mismos archivos, mismo contenido)" || mal "T32 (c) algo del dev se movió: «$(sk ls-files --others | tr '\n' ' ')» · $(sk stash list | grep -c .) stash"
  [ -f "$LAB_SKILLS/.advisors/lab-run.json" ] && [ ! -e "$LAB_SKILLS/.advisors/dod-runtime" ] \
    && ok "T32 (c) en una carpeta que el repo unido también sigue (.advisors/): lo ignorado del dev sigue ahí, y lo del arnés no se escribió" || mal "T32 (c) .advisors/: $(ls -A "$LAB_SKILLS/.advisors" 2>&1 | tr '\n' ' ')"
  [ -z "$(sk status --porcelain --untracked-files=no)" ] && ok "T32 (c) y el clon queda limpio: nada de lo que git sigue aparece modificado ni borrado" || mal "T32 (c) el clon quedó sucio: $(sk status --porcelain --untracked-files=no | head -5)"
  [ "$(harness_lab_links)" = "$ENLACES0" ] && [ "$(shasum -a 256 < "$TYCON_SETTINGS_PATH")" = "$SETTINGS0" ] \
    && ok "T32 (c) los enlaces y settings.json (los hooks) no se tocaron" || mal "T32 (c) enlaces o hooks cambiaron: $(harness_lab_links | tr '\n' ' ')"
  [ "$(visibles)" = "agents packs skills " ] && [ ! -e "$LAB_SKILLS/scripts" ] && [ ! -e "$LAB_SKILLS/.githooks/pre-commit" ] && [ -f "$LAB_SKILLS/README.md" ] && cmp -s "$LAB_SKILLS/README.md" "$LAB_TREE/README.md" && [ -d "$LAB_SKILLS/skills/tycon-pipeline" ] \
    && ok "T32 (d) el clon muestra sólo agents/, skills/, packs/ y los archivos de la raíz: el instalador no está ahí" || mal "T32 (d) el clon muestra: $(visibles) · scripts/: $([ -e "$LAB_SKILLS/scripts" ] && echo está || echo no)"
  [ "$(copias_de repoint)" = 1 ] && [ "$(sk rev-parse -q --verify refs/tycon/previous/agent_skills)" = "$LAB_COMMIT_SKILLS" ] \
    && ok "T32 hay copia de seguridad de antes de mover (una copia «repoint» y refs/tycon/previous/agent_skills en el commit viejo)" || mal "T32 copia de seguridad: $(copias_de repoint) copia(s), previous $(sk rev-parse -q --verify refs/tycon/previous/agent_skills)"
  # la segunda corrida no cambia nada y no dice nada
  foto "$BASE/t32/f1"; foto_estado "$BASE/t32/e1"
  SALIDA="$(con_llave harness startup 2>&1)"; RC=$?
  foto "$BASE/t32/f2"; foto_estado "$BASE/t32/e2"
  [ "$RC" = 0 ] && [ -z "$SALIDA" ] && igual "$BASE/t32/f1" "$BASE/t32/f2" && igual "$BASE/t32/e1" "$BASE/t32/e2" && [ "$(copias_de repoint)" = 1 ] \
    && ok "T32 (e) el segundo startup no cambia nada y no dice nada" || mal "T32 (e) segundo startup: rc $RC, «${SALIDA}» · $(diff "$BASE/t32/f1" "$BASE/t32/f2" | head -5) $(diff "$BASE/t32/e1" "$BASE/t32/e2" | head -3)"
  [ "$(estado 'd.notice')" = null ] && ok "T32 …y el aviso del re-apuntado no queda para siempre (el arranque siguiente lo saca)" || mal "T32 el aviso quedó: $(estado 'd.notice')"
  # doctor y version en la máquina re-apuntada
  JSON="$(con_llave harness doctor --json 2>/dev/null)"; RC=$?
  [ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | doctor_json 'd.fail.length')" = 0 ] && [ "$(printf '%s' "$JSON" | doctor_json "d.ok.filter((t)=>/re-apuntad/.test(t)).length")" = 1 ] \
    && [ "$(printf '%s' "$JSON" | doctor_json "d.ok.concat(d.warn).filter((t)=>/nada se mueve hasta que la llave/.test(t)).length")" = 0 ] \
    && ok "T32 doctor en la máquina re-apuntada: verde, lo dice una vez, y ya no dice «nada se mueve hasta que la llave…»" || mal "T32 doctor (rc $RC): $JSON"
  SALIDA="$(con_llave harness version 2>&1)"
  case "$SALIDA" in *"agent-skills "[0-9a-f]*) mal "T32 version sigue mostrando dos commits: $SALIDA" ;; *"${LAB_COMMIT_UNION:0:7}"*) ok "T32 (AC 35) version muestra un solo commit" ;; *) mal "T32 version: $SALIDA" ;; esac
  # AC 35: una versión nueva → los dos clones, en el mismo commit; y el clon sigue mostrando sólo lo suyo
  harness_lab_publish tree "versión nueva del repo unido" skills/tycon-pipeline/NEW.md "nuevo"
  NUEVO="$(head_de "$LAB_AUTHOR_TREE")"
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$NUEVO" ] && [ "$(head_de "$LAB_SKILLS")" = "$NUEVO" ] && [ -f "$LAB_SKILLS/skills/tycon-pipeline/NEW.md" ] \
    && ok "T32 (AC 35) después de un update con versión nueva, los dos clones están en el mismo commit" || mal "T32 (AC 35) update (rc $RC): arnés $(head_de "$LAB_TREE") skills $(head_de "$LAB_SKILLS") nuevo $NUEVO: $SALIDA"
  [ "$(visibles)" = "agents packs skills " ] && [ ! -e "$LAB_SKILLS/scripts" ] && [ "$(harness_lab_clone_extras "$LAB_SKILLS")" = "$EXTRAS0" ] \
    && ok "T32 …el clon sigue mostrando sólo lo suyo, y lo del dev sigue idéntico" || mal "T32 después del update el clon muestra: $(visibles)"
  # la vista es SIN cono: si alguien (o una herramienta) vuelve a aplicarla, git no borra lo ignorado del dev. En modo
  # cono borraba `.advisors/` entero (medido): por eso no se usa
  sk sparse-checkout reapply >/dev/null 2>&1
  [ "$(sk config --get core.sparseCheckoutCone)" = false ] && [ -f "$LAB_SKILLS/.advisors/lab-run.json" ] && [ "$(harness_lab_clone_extras "$LAB_SKILLS")" = "$EXTRAS0" ] \
    && ok "T32 (c) la vista es sin cono: volver a aplicarla (git sparse-checkout reapply) no borra lo ignorado del dev" || mal "T32 (c) al volver a aplicar la vista se perdió algo del dev: .advisors/: $(ls -A "$LAB_SKILLS/.advisors" 2>&1 | tr '\n' ' ')"
  # la llave por la configuración de la máquina vale igual que por la variable (es como se prueba primero en una máquina)
  maquina "$BASE/t32b" || mal "T32 no pude armar la segunda máquina"
  printf '{ "update": { "skills_source": "unified" } }\n' > "$LAB_HOME/.claude/tycon.json"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && case "$SALIDA" in *"re-apuntad"*) true ;; *) false ;; esac \
    && ok "T32 la llave en ~/.claude/tycon.json: update re-apunta y lo dice" || mal "T32 llave por archivo: rc $RC: $SALIDA"
  # con la política en ask no se muda sola: se avisa, y la aplica la persona
  maquina "$BASE/t32c" || mal "T32 no pude armar la tercera máquina"
  SALIDA="$(TYCON_UPDATE_APPLY=ask con_llave harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && case "$(estado 'd.notice')" in *"update --yes"*) true ;; *) false ;; esac \
    && ok "T32 con la política en ask el arranque no re-apunta: deja el aviso con el comando" || mal "T32 en ask: rc $RC, origin $(origen_de "$LAB_SKILLS"), aviso $(estado 'd.notice')"
  case "$(TYCON_UPDATE_APPLY=ask con_llave harness doctor 2>&1)" in *"todavía no se re-apuntó"*"«ask»"*"update --yes"*) ok "T32 …y doctor dice quién lo hace: la persona, con update --yes" ;; *) mal "T32 doctor en ask no dice cómo aplicarlo: $(TYCON_UPDATE_APPLY=ask con_llave harness doctor 2>&1 | head -4)" ;; esac
  # como llega al equipo: la llave en el PERFIL (con la política del equipo). Y una máquina que la tiene apagada en su
  # propio archivo NO re-apunta, aunque el perfil la prenda: así quedan las Windows hasta probar una (AC 38)
  maquina "$BASE/t32d" || mal "T32 no pude armar la cuarta máquina"
  printf '{ "update": { "channel": "latest", "apply": "auto", "skills_source": "unified" } }\n' > "$LAB/team-profile.json"
  con_perfil() { env -u TYCON_UPDATE_APPLY TYCON_PROFILE="$LAB/team-profile.json" node "$LAB_TREE/scripts/setup/harness.js" "$@"; }
  printf '{ "update": { "skills_source": "separate" } }\n' > "$LAB_HOME/.claude/tycon.json"
  SALIDA="$(con_perfil startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_SKILLS" ] && [ "$(estado 'd.repoint')" = null ] \
    && ok "T32 (AC 38) el perfil prende la llave y la máquina la tiene en separate en su archivo: NO re-apunta" || mal "T32 (AC 38) la máquina re-apuntó con la llave apagada en su archivo: rc $RC, repoint $(estado 'd.repoint'): $SALIDA"
  case "$(con_perfil doctor 2>&1)" in *"dos clones: en transición"*) ok "T32 (AC 38) …y doctor la sigue viendo en transición, sin rojo ni aviso de la llave" ;; *) mal "T32 (AC 38) doctor: $(con_perfil doctor 2>&1 | head -5)" ;; esac
  rm -f "$LAB_HOME/.claude/tycon.json"
  SALIDA="$(con_perfil startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_TREE")" ] \
    && ok "T32 espejo: sin ese archivo, la llave del perfil re-apunta en el arranque" || mal "T32 la llave por el perfil no re-apuntó: rc $RC: $SALIDA"
fi

# ═══ T34 · Repoint_KeyOff_BackToOldRemoteAndCommit_RoundTripIdentical ════════════════════════════════════════════════
if corre T34 || corre CRASH; then
  maquina "$BASE/t34" || mal "T34 no pude armar la máquina del equipo después del corte"
  printf 'dentro de una carpeta que deja de verse\n' > "$LAB_SKILLS/.tycon/lab-local.txt"   # sin versionar, en una carpeta que la ida oculta
  foto "$BASE/t34/antes"; foto_estado "$BASE/t34/antes.estado"
fi
if corre T34; then
  SALIDA="$(con_llave harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_UNION" ] && [ -f "$LAB_SKILLS/.tycon/lab-local.txt" ] && [ ! -e "$LAB_SKILLS/.tycon/lab-config.yaml" ] \
    && ok "T34 la ida: re-apuntado, y lo sin versionar de una carpeta que deja de verse sigue en su lugar" || mal "T34 la ida no pasó (rc $RC): $SALIDA"
  # la vuelta: la llave en separate (sin la variable)
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(lineas "$SALIDA")" = 1 ] && case "$SALIDA" in *"repo viejo"*) true ;; *) false ;; esac \
    && ok "T34 la vuelta: startup con la llave en separate sale 0 y dice UNA línea" || mal "T34 la vuelta: rc $RC, $(lineas "$SALIDA") línea(s): $SALIDA"
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_SKILLS" ] && [ "$(sk symbolic-ref --short -q HEAD)" = main ] \
    && ok "T34 el origin volvió a la URL guardada y la rama main al commit guardado (sin checkout de un commit suelto)" || mal "T34 origin $(origen_de "$LAB_SKILLS") head $(head_de "$LAB_SKILLS") rama $(sk symbolic-ref --short -q HEAD)"
  [ -f "$LAB_SKILLS/.githooks/pre-commit" ] && [ -f "$LAB_SKILLS/.tycon/lab-config.yaml" ] && [ "$(sk ls-files -t | grep -c '^S ')" = 0 ] \
    && ok "T34 el clon vuelve a mostrar todo" || mal "T34 el clon no muestra todo: ocultos $(sk ls-files -t | grep -c '^S ')"
  foto "$BASE/t34/despues"; foto_estado "$BASE/t34/despues.estado"
  igual "$BASE/t34/antes" "$BASE/t34/despues" \
    && ok "T34 ida y vuelta: la máquina quedó BYTE A BYTE como al principio (remoto, commit, config de git, árbol de trabajo, refs, listados, enlaces, hooks)" || mal "T34 ida y vuelta dejó diferencias: $(diff "$BASE/t34/antes" "$BASE/t34/despues" | head -12)"
  igual "$BASE/t34/antes.estado" "$BASE/t34/despues.estado" \
    && ok "T34 …y el estado quedó como antes (las fuentes, y sin rastro de la mudanza)" || mal "T34 el estado difiere: $(diff "$BASE/t34/antes.estado" "$BASE/t34/despues.estado")"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  foto "$BASE/t34/despues2"
  [ "$RC" = 0 ] && [ -z "$SALIDA" ] && igual "$BASE/t34/antes" "$BASE/t34/despues2" && [ "$(estado 'd.notice')" = null ] \
    && ok "T34 un arranque más: no dice nada, no cambia nada, sin aviso pendiente" || mal "T34 arranque posterior: rc $RC «${SALIDA}» aviso $(estado 'd.notice')"
  JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
  [ "$RC" = 0 ] && [ "$(printf '%s' "$JSON" | doctor_json "d.ok.filter((t)=>/dos clones: en transición/.test(t)).length")" = 1 ] \
    && ok "T34 doctor vuelve a decir «dos clones: en transición», en verde" || mal "T34 doctor después de la vuelta (rc $RC): $JSON"
  # (error) el remoto viejo no contesta: no toca nada y lo dice; cuando vuelve, pasa
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "T34 la segunda ida no pasó"
  foto "$BASE/t34/ida2"; foto_estado "$BASE/t34/ida2.estado"
  mv "$LAB_REMOTE_SKILLS" "$LAB_REMOTE_SKILLS.caido"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  foto "$BASE/t34/caido"
  [ "$RC" = 0 ] && igual "$BASE/t34/ida2" "$BASE/t34/caido" && [ "$(estado 'd.repoint.applied.from.url')" = "$LAB_REMOTE_SKILLS" ] \
    && ok "T34 (error) con el remoto viejo caído la vuelta no toca nada" || mal "T34 (error) remoto caído: rc $RC · $(diff "$BASE/t34/ida2" "$BASE/t34/caido" | head -6)"
  case "$SALIDA$(estado 'd.notice')" in *"no contesta"*) ok "T34 (error) …y lo dice: el remoto viejo no contesta" ;; *) mal "T34 (error) no lo dice: «${SALIDA}» · aviso $(estado 'd.notice')" ;; esac
  JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
  [ "$RC" = 1 ] && [ "$(printf '%s' "$JSON" | doctor_json "d.fail.filter((t)=>/volvió a «separate»/.test(t)).length")" = 1 ] \
    && ok "T34 (error) doctor queda en rojo: la llave volvió a separate y el clon sigue en el unificado" || mal "T34 (error) doctor (rc $RC): $JSON"
  mv "$LAB_REMOTE_SKILLS.caido" "$LAB_REMOTE_SKILLS"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  foto "$BASE/t34/despues3"; foto_estado "$BASE/t34/despues3.estado"
  [ "$RC" = 0 ] && igual "$BASE/t34/antes" "$BASE/t34/despues3" && igual "$BASE/t34/antes.estado" "$BASE/t34/despues3.estado" \
    && ok "T34 con el remoto viejo de vuelta, el arranque siguiente deshace: otra vez byte a byte como al principio" || mal "T34 la vuelta después del remoto caído: rc $RC · $(diff "$BASE/t34/antes" "$BASE/t34/despues3" | head -8) $(diff "$BASE/t34/antes.estado" "$BASE/t34/despues3.estado")"
  # la vuelta después de una versión nueva: vuelve al commit GUARDADO, no a la punta
  con_llave harness startup >/dev/null 2>&1
  harness_lab_publish tree "versión nueva, después de re-apuntar" skills/tycon-pipeline/NEW.md "nuevo"
  con_llave harness update >/dev/null 2>&1
  [ -f "$LAB_SKILLS/skills/tycon-pipeline/NEW.md" ] || mal "T34 precondición: la versión nueva no llegó al clon re-apuntado"
  SALIDA="$(harness update 2>&1)"; RC=$?
  foto "$BASE/t34/despues4"
  # el arnés sí avanzó: se compara todo menos su línea
  grep -v '^arnés: ' "$BASE/t34/antes" > "$BASE/t34/antes.sin"; grep -v '^arnés: ' "$BASE/t34/despues4" > "$BASE/t34/despues4.sin"
  [ "$RC" = 0 ] && igual "$BASE/t34/antes.sin" "$BASE/t34/despues4.sin" && [ ! -e "$LAB_SKILLS/skills/tycon-pipeline/NEW.md" ] \
    && ok "T34 la vuelta después de una versión nueva: el clon viejo vuelve al commit guardado, idéntico al de antes de la ida" || mal "T34 vuelta tras versión nueva: rc $RC · $(diff "$BASE/t34/antes.sin" "$BASE/t34/despues4.sin" | head -8): $SALIDA"
fi

# ═══ CRASH · una ida que se cortó en el medio se deshace sola ═════════════════════════════════════════════════════════
if corre CRASH; then
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] || { harness update >/dev/null 2>&1; }
  harness_lab_pull_tree >/dev/null 2>&1; harness update >/dev/null 2>&1
  foto "$BASE/t34/crash.antes"; foto_estado "$BASE/t34/crash.antes.estado"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "CRASH la ida previa no pasó"
  # el estado como queda ANTES de mover (la mudanza anotada «en curso») con el clon ya movido: la sesión murió en el medio
  estado_set "const a=d.repoint.applied; d.repoint={pending:{step:'forward',from:a.from,to:a.to,at:a.at}}; const s=d.sources.find((x)=>x.name==='agent_skills'); s.url=a.from.url; s.commit=a.from.commit; s.previous=a.from.previous;"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  foto "$BASE/t34/crash.despues"; foto_estado "$BASE/t34/crash.despues.estado"
  [ "$RC" = 0 ] && igual "$BASE/t34/crash.antes" "$BASE/t34/crash.despues" && igual "$BASE/t34/crash.antes.estado" "$BASE/t34/crash.despues.estado" \
    && ok "CRASH una ida cortada en el medio, con la llave apagada: el arranque siguiente la deshace y la máquina queda como al principio" || mal "CRASH (rc $RC): $(diff "$BASE/t34/crash.antes" "$BASE/t34/crash.despues" | head -8) $(diff "$BASE/t34/crash.antes.estado" "$BASE/t34/crash.despues.estado"): $SALIDA"
  grep -q "en curso" "$(LOG)" 2>/dev/null && ok "CRASH …y el registro dice que encontró una mudanza en curso" || mal "CRASH el registro no lo dice: $(tail -5 "$(LOG)" 2>/dev/null)"
  # y con la llave prendida: la deshace y la vuelve a hacer entera
  con_llave harness startup >/dev/null 2>&1
  estado_set "const a=d.repoint.applied; d.repoint={pending:{step:'forward',from:a.from,to:a.to,at:a.at}}; const s=d.sources.find((x)=>x.name==='agent_skills'); s.url=a.from.url; s.commit=a.from.commit; s.previous=a.from.previous;"
  SALIDA="$(con_llave harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_TREE")" ] && [ "$(estado 'd.repoint.pending')" = null ] && [ "$(estado 'd.repoint.applied.from.commit')" = "$LAB_COMMIT_SKILLS" ] \
    && ok "CRASH con la llave prendida: la mudanza cortada se rehace entera y el estado queda coherente" || mal "CRASH con la llave (rc $RC): origin $(origen_de "$LAB_SKILLS") repoint $(estado 'd.repoint'): $SALIDA"
fi

# ═══ T33 · Repoint_CannotMove_NothingTouched_NoticeNamesCause ════════════════════════════════════════════════════════
if corre T33; then
  maquina "$BASE/t33" || mal "T33 no pude armar la máquina del equipo después del corte"
  harness_lab_publish tree "versión nueva: si algo se moviera, se vería" skills/tycon-pipeline/V2.md "v2"
  FRASE='la llave pide el repo unificado y este clon sigue en el viejo'
  # no_paso <nombre> <patrón de la causa>  — corre update con la llave; tiene que salir 2, nombrar la causa y no tocar nada
  no_paso() {
    foto "$BASE/t33/antes"; COPIAS="$(copias_de repoint)"
    SALIDA="$(con_llave harness update 2>&1)"; RC=$?
    foto "$BASE/t33/despues"
    [ "$RC" = 2 ] && printf '%s' "$SALIDA" | grep -- "$2" >/dev/null && printf '%s' "$SALIDA" | grep "$FRASE" >/dev/null \
      && ok "T33 $1: update sale 2 y nombra la causa" || mal "T33 $1: rc $RC, sin «$2»: $SALIDA"
    igual "$BASE/t33/antes" "$BASE/t33/despues" \
      && ok "T33 $1: no se movió NINGUNA de las dos fuentes ni nada del clon (aun con versión nueva publicada)" || mal "T33 $1: algo se movió: $(diff "$BASE/t33/antes" "$BASE/t33/despues" | head -8)"
    [ "$(copias_de repoint)" = "$COPIAS" ] || mal "T33 $1: tomó una copia «repoint» sin mover nada"
  }
  # (a) otra rama
  sk checkout -q -b lab/work
  no_paso "otra rama" "rama lab/work"
  SALIDA="$(con_llave harness startup 2>&1)"; RC=$?
  AVISO="$(estado 'd.notice')"
  [ "$RC" = 0 ] && case "$AVISO" in *"$FRASE"*"rama lab/work"*"harness.js update"*) true ;; *) false ;; esac \
    && ok "T33 otra rama: startup sale 0 y deja el aviso con la causa y el comando" || mal "T33 otra rama: startup rc $RC, aviso: $AVISO"
  [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] && ok "T33 otra rama: el arranque tampoco movió el clon del arnés" || mal "T33 otra rama: el arnés avanzó a $(head_de "$LAB_TREE")"
  JSON="$(con_llave harness doctor --json 2>/dev/null)"; RC=$?
  [ "$RC" = 1 ] && [ "$(printf '%s' "$JSON" | doctor_json "d.fail.filter((t)=>t.includes('$FRASE')).length")" = 1 ] \
    && ok "T33 otra rama: doctor queda en rojo («${FRASE}»)" || mal "T33 otra rama: doctor (rc $RC): $JSON"
  con_llave harness startup >/dev/null 2>&1
  grep -q "no se reintenta" "$(LOG)" && [ "$(estado 'd.repoint.blocked.transient')" = false ] \
    && ok "T33 otra rama: una causa permanente no se reintenta sobre lo mismo en el arranque siguiente (y el aviso sigue)" || mal "T33 otra rama: se reintentó: $(tail -4 "$(LOG)")"
  case "$(estado 'd.notice')" in *"$FRASE"*) true ;; *) mal "T33 otra rama: el aviso no siguió: $(estado 'd.notice')" ;; esac
  sk checkout -q main; sk branch -q -D lab/work
  # (b) commits propios
  sk commit -q --allow-empty -m "un commit propio del dev"
  no_paso "commits propios" "commit(s) propio"
  sk reset -q --hard HEAD~1
  # (c) un archivo sin versionar que choca con una ruta que llega
  mkdir -p "$LAB_SKILLS/scripts"; printf 'mi copia\n' > "$LAB_SKILLS/scripts/install-tycon-hooks.sh"
  no_paso "sin versionar que choca" "scripts/install-tycon-hooks.sh"
  [ "$(cat "$LAB_SKILLS/scripts/install-tycon-hooks.sh")" = "mi copia" ] && ok "T33 sin versionar que choca: el archivo del dev quedó intacto" || mal "T33 el archivo del dev cambió"
  rm -rf "$LAB_SKILLS/scripts"
  # el arnés baja la versión nueva con la llave apagada (el clon viejo no cambia): así la ruta que choca abajo ya llega
  harness_lab_publish tree "una evidencia versionada" .advisors/dod-runtime/e1.md "evidencia"
  harness update >/dev/null 2>&1
  [ -f "$LAB_TREE/.advisors/dod-runtime/e1.md" ] || mal "T33 precondición: el arnés no bajó la versión con la ruta que choca"
  # (d) un archivo IGNORADO que choca con una ruta que llega (git lo pisaría sin avisar)
  mkdir -p "$LAB_SKILLS/.advisors/dod-runtime"; printf 'del dev, ignorado\n' > "$LAB_SKILLS/.advisors/dod-runtime/e1.md"
  no_paso "ignorado que choca" ".advisors/dod-runtime/e1.md"
  [ "$(cat "$LAB_SKILLS/.advisors/dod-runtime/e1.md")" = "del dev, ignorado" ] && ok "T33 ignorado que choca: el archivo del dev quedó intacto" || mal "T33 el archivo ignorado del dev cambió"
  rm -rf "$LAB_SKILLS/.advisors/dod-runtime"
  # (e) sin red: el repo unificado no contesta (conexión rechazada). Pasajera: se reintenta en el arranque siguiente
  URL_BUENA="$(origen_de "$LAB_TREE")"; URL_MALA="git://127.0.0.1:9/lab/harness.git"
  harness_lab_git "$LAB_TREE" remote set-url origin "$URL_MALA"; estado_set "d.sources.find((s)=>s.name==='harness').url='$URL_MALA'"
  foto "$BASE/t33/antes"
  SALIDA="$(con_llave harness startup 2>&1)"; RC=$?
  foto "$BASE/t33/despues"
  [ "$RC" = 0 ] && igual "$BASE/t33/antes" "$BASE/t33/despues" && [ "$(estado 'd.repoint.blocked.transient')" = true ] && case "$(estado 'd.notice')" in *"sin red"*) true ;; *) false ;; esac \
    && ok "T33 sin red: no se movió nada, el aviso dice «sin red» y la causa queda como pasajera" || mal "T33 sin red: rc $RC, blocked $(estado 'd.repoint.blocked'), aviso $(estado 'd.notice') · $(diff "$BASE/t33/antes" "$BASE/t33/despues" | head -4)"
  harness_lab_git "$LAB_TREE" remote set-url origin "$URL_BUENA"; estado_set "d.sources.find((s)=>s.name==='harness').url='$URL_BUENA'"
  # (f) un fallo a mitad de camino (la carpeta del clon no deja escribir): vuelve a como estaba y lo dice
  if [ "$(id -u)" != 0 ]; then
    chmod 555 "$LAB_SKILLS"
    foto "$BASE/t33/antes"
    SALIDA="$(con_llave harness update 2>&1)"; RC=$?
    COPIAS="$(copias_de repoint)"
    con_llave harness startup >/dev/null 2>&1   # el arranque siguiente reintenta (es pasajero) y vuelve a fallar
    COPIAS2="$(copias_de repoint)"
    chmod 755 "$LAB_SKILLS"
    foto "$BASE/t33/despues"
    [ "$RC" = 2 ] && igual "$BASE/t33/antes" "$BASE/t33/despues" && [ "$(estado 'd.repoint.pending')" = null ] && [ "$(estado 'd.repoint.applied')" = null ] \
      && ok "T33 un fallo a mitad de camino (no se puede escribir en el clon): la máquina vuelve a como estaba y lo dice" || mal "T33 fallo a mitad de camino: rc $RC, repoint $(estado 'd.repoint') · $(diff "$BASE/t33/antes" "$BASE/t33/despues" | head -8): $SALIDA"
    [ "$(estado 'd.repoint.blocked.transient')" = true ] && [ "$COPIAS" = 1 ] && [ "$COPIAS2" = 1 ] \
      && ok "T33 …es pasajero (un archivo tomado por otro programa): se reintenta en el arranque siguiente, sin ir gastando copias de seguridad" || mal "T33 fallo a mitad de camino: pasajero=$(estado 'd.repoint.blocked.transient'), copias $COPIAS → $COPIAS2"
  else
    echo "  ⏭   — T33 NO MEDIDO: «un fallo a mitad de camino» (corre como root: no hay permiso que negar)"
  fi
  # (g) historia sin unir: el repo viejo recibió un commit DESPUÉS de la unión y el clon lo bajó
  harness_lab_publish skills "un commit en el repo viejo, después de la unión"
  harness update >/dev/null 2>&1
  [ "$(head_de "$LAB_SKILLS")" != "$LAB_COMMIT_SKILLS" ] || mal "T33 precondición: el clon viejo no bajó el commit de después de la unión"
  no_paso "historia sin unir" "línea recta"
  sk reset -q --hard "$LAB_COMMIT_SKILLS"; sk update-ref -d refs/tycon/previous/agent_skills
  estado_set "const s=d.sources.find((x)=>x.name==='agent_skills'); s.commit='$LAB_COMMIT_SKILLS'; s.previous=null;"
  # espejo: arreglada cada causa, la MISMA máquina pasa — nada de lo anterior la dejó a medias
  SALIDA="$(con_llave harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_TREE")" ] && [ "$(estado 'd.repoint.blocked')" = null ] \
    && ok "T33 espejo: con las causas arregladas, la misma máquina re-apunta (y el arranque reintentó solo después de «sin red»)" || mal "T33 espejo (rc $RC): origin $(origen_de "$LAB_SKILLS"), repoint $(estado 'd.repoint'): $SALIDA"
  con_llave harness update >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_TREE")" ] && [ "$(con_llave harness doctor --json 2>/dev/null | doctor_json 'd.fail.length')" = 0 ] \
    && ok "T33 espejo: y el update siguiente lleva las dos a la versión nueva; doctor sin rojo" || mal "T33 espejo: arnés $(head_de "$LAB_TREE") skills $(head_de "$LAB_SKILLS"): $(con_llave harness doctor 2>&1 | head -6)"
fi

# ═══ T35 · Guard_TipWithoutSkills_NeverApplied ═══════════════════════════════════════════════════════════════════════
if corre T35; then
  GUARDA='la versión nueva no trae las skills: no se aplica'
  # (1) la máquina re-apuntada
  maquina "$BASE/t35a" || mal "T35 no pude armar la máquina del equipo"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "T35 precondición: la máquina no quedó re-apuntada"
  harness_lab_publish_without_skills || mal "T35 no pude publicar la punta sin skills"
  EXTRAS0="$(harness_lab_clone_extras "$LAB_SKILLS")"; ARBOL0="$(harness_lab_worktree_hash "$LAB_SKILLS")"
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  [ "$RC" = 2 ] && case "$SALIDA" in *"$GUARDA"*) true ;; *) false ;; esac \
    && ok "T35 re-apuntada: update sale 2 y dice «${GUARDA}»" || mal "T35 re-apuntada: rc $RC: $SALIDA"
  [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_UNION" ] && [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] && [ -d "$LAB_SKILLS/skills/tycon-pipeline" ] \
    && [ "$(harness_lab_clone_extras "$LAB_SKILLS")" = "$EXTRAS0" ] && [ "$(harness_lab_worktree_hash "$LAB_SKILLS")" = "$ARBOL0" ] \
    && ok "T35 re-apuntada: ninguna fuente se movió y las skills siguen" || mal "T35 re-apuntada: algo se movió: skills $(head_de "$LAB_SKILLS") arnés $(head_de "$LAB_TREE")"
  estado_set "d.last_fetch=null"
  con_llave harness startup >/dev/null 2>&1
  case "$(estado 'd.notice')" in *"$GUARDA"*) ok "T35 re-apuntada: el arranque deja el aviso" ;; *) mal "T35 re-apuntada: aviso $(estado 'd.notice')" ;; esac
  [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_UNION" ] && [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] || mal "T35 re-apuntada: el arranque movió algo"
  SALIDA="$(con_llave harness doctor 2>&1)"
  case "$SALIDA" in *"no trae las skills"*) ok "T35 re-apuntada: doctor lo muestra" ;; *) mal "T35 re-apuntada: doctor no lo muestra: $SALIDA" ;; esac
  # (2) la máquina de un solo árbol
  lab_single "$BASE/t35b" || mal "T35 no pude armar la máquina de un solo árbol"
  harness install --yes >/dev/null 2>&1 || mal "T35 install en la máquina de un solo árbol falló"
  [ "$(estado 'd.sources.length')" = 1 ] || mal "T35 precondición: la máquina de un solo árbol tiene $(estado 'd.sources.length') fuentes"
  harness_lab_publish_without_skills || mal "T35 no pude publicar la punta sin skills (un árbol)"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 2 ] && case "$SALIDA" in *"$GUARDA"*) true ;; *) false ;; esac && [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] && [ -d "$LAB_HOME/.claude/skills/tycon-pipeline" ] \
    && ok "T35 un solo árbol: la punta sin skills no se aplica, el árbol no se mueve y las skills siguen" || mal "T35 un solo árbol: rc $RC, head $(head_de "$LAB_TREE"): $SALIDA"
  # (3) espejo: dos clones SIN re-apuntar — el arnés sí sigue a main (el retorno de antes de la llave) y las skills siguen
  maquina "$BASE/t35c" || mal "T35 no pude armar la máquina en transición"
  harness_lab_publish_without_skills || mal "T35 no pude publicar la punta sin skills (transición)"
  RETORNO="$(harness_lab_remote_head main)"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$RETORNO" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_SKILLS" ] && [ -d "$LAB_HOME/.claude/skills/tycon-pipeline" ] \
    && ok "T35 espejo: en la máquina de dos clones sin re-apuntar el arnés sigue a main (el retorno de antes de la llave) y las skills siguen en el clon viejo" || mal "T35 espejo: rc $RC, arnés $(head_de "$LAB_TREE") (retorno $RETORNO): $SALIDA"
  # (4) «no pude leer» no es «de acá no salen las skills» (revisor de fallos silenciosos): en la máquina de un solo árbol,
  # con el árbol de lo instalado ilegible (su objeto apartado), la guarda no sabe si de esa fuente salen las skills. Antes
  # lo leía como «no salen», se salteaba, y la punta sin skills seguía su camino. No se avanza, y se dice con su causa
  lab_single "$BASE/t35d" || mal "T35 no pude armar la segunda máquina de un solo árbol"
  harness install --yes >/dev/null 2>&1 || mal "T35 install en la segunda máquina de un solo árbol falló"
  harness_lab_publish_without_skills || mal "T35 no pude publicar la punta sin skills (ilegible)"
  # con el árbol legible, la guarda de siempre; de paso la punta queda traída (con el objeto apartado git no puede traer)
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 2 ] && case "$SALIDA" in *"$GUARDA"*) true ;; *) false ;; esac || mal "T35 (ilegible) precondición: con el árbol legible la guarda no frenó (rc $RC): $SALIDA"
  ARBOL="$(tr_ rev-parse 'HEAD^{tree}')"; OBJETO="$LAB_TREE/.git/objects/${ARBOL:0:2}/${ARBOL:2}"
  if [ -n "$ARBOL" ] && [ -f "$OBJETO" ]; then
    mv "$OBJETO" "$OBJETO.aside"
    SALIDA="$(harness update 2>&1)"; RC=$?
    DOCTOR="$(harness doctor 2>&1)"
    mv "$OBJETO.aside" "$OBJETO"
    [ "$RC" = 2 ] && case "$SALIDA" in *"no pude"*"salen las skills"*"no se mueve ninguna fuente"*) true ;; *) false ;; esac && [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] \
      && ok "T35 (ilegible) con el árbol de lo instalado ilegible, update sale 2, dice que no pudo leer si de ahí salen las skills, y no avanza" || mal "T35 (ilegible) rc $RC, head $(head_de "$LAB_TREE"): $SALIDA"
    case "$DOCTOR" in *"no pude"*"salen las skills"*) ok "T35 (ilegible) …y doctor lo dice, en vez de callar" ;; *) mal "T35 (ilegible) doctor no lo dice: $(printf '%s' "$DOCTOR" | grep -i 'skills' | head -4)" ;; esac
    SALIDA="$(harness update 2>&1)"; RC=$?
    [ "$RC" = 2 ] && case "$SALIDA" in *"$GUARDA"*) true ;; *) false ;; esac && [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] \
      && ok "T35 (ilegible) espejo: con el árbol legible otra vez, la guarda de siempre («${GUARDA}»)" || mal "T35 (ilegible) espejo: rc $RC: $SALIDA"
  else
    no_medido T35 "«no pude leer» (el árbol de HEAD no está como objeto suelto en el clon: no hay qué apartar)"
  fi
fi

# ═══ LINK · ~/.claude/agent-skills es un enlace a un clon viejo que vive en otra carpeta ══════════════════════════════
if corre LINK; then
  lab_team "$BASE/link" toy || mal "LINK no pude armar la máquina"
  OTRA="$LAB/clones/skills-in-another-folder"
  mv "$LAB_SKILLS" "$OTRA" && ln -s "$OTRA" "$LAB_SKILLS" || mal "LINK no pude mover el clon viejo"
  rm -f "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents"; ln -s "$OTRA/skills" "$LAB_HOME/.claude/skills"; ln -s "$OTRA/agents" "$LAB_HOME/.claude/agents"
  harness install --yes >/dev/null 2>&1 && harness_lab_cut && harness update >/dev/null 2>&1 || mal "LINK la máquina no quedó instalada después del corte"
  foto "$BASE/link/antes"; foto_estado "$BASE/link/antes.estado"
  CANON="$LAB_TREE/scripts/lib/canonical-path.js"
  ANTES_T="$(node "$CANON" --separate-skills-clone --clone "$LAB_TREE" --home "$LAB_HOME" 2>&1)"
  SALIDA="$(con_llave harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$OTRA")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(head_de "$OTRA")" = "$(head_de "$LAB_TREE")" ] && [ -L "$LAB_SKILLS" ] \
    && ok "LINK con agent-skills como enlace a un clon en otra carpeta: re-apunta ese clon, y el enlace sigue siendo un enlace" || mal "LINK la ida (rc $RC): $SALIDA"
  DESPUES_T="$(node "$CANON" --separate-skills-clone --clone "$LAB_TREE" --home "$LAB_HOME" 2>&1)"
  [ -n "$ANTES_T" ] && [ "$DESPUES_T" = "$ANTES_T" ] \
    && ok "LINK después de re-apuntar el instalador sigue reconociendo la transición (el clon no muestra el instalador): no vuelve a avisar" || mal "LINK la transición ya no se reconoce: antes «${ANTES_T}» después «${DESPUES_T}»"
  harness startup >/dev/null 2>&1
  foto "$BASE/link/despues"; foto_estado "$BASE/link/despues.estado"
  igual "$BASE/link/antes" "$BASE/link/despues" && igual "$BASE/link/antes.estado" "$BASE/link/despues.estado" \
    && ok "LINK ida y vuelta: byte a byte como al principio" || mal "LINK ida y vuelta: $(diff "$BASE/link/antes" "$BASE/link/despues" | head -8) $(diff "$BASE/link/antes.estado" "$BASE/link/despues.estado")"
fi

# ═══ ADOPT · el estado se perdió (se desinstaló y se volvió a instalar) con el clon ya re-apuntado ═════════════════════
# `uninstall` no toca el clon viejo: queda re-apuntado. Al reinstalar, el estado nace sin rastro de la mudanza. Sin esto,
# con la llave prendida el arranque encontraba un clon «con una vista reducida propia», no lo podía re-apuntar y —por la
# regla «ninguna fuente se mueve»— la máquina dejaba de actualizarse. El clon guarda su propia constancia (dentro de su
# .git): el mecanismo la reconoce, no dice nada, y la vuelta sigue sabiendo a dónde volver.
if corre ADOPT; then
  maquina "$BASE/adopt" || mal "ADOPT no pude armar la máquina del equipo después del corte"
  foto "$BASE/adopt/antes"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "ADOPT precondición: la máquina no quedó re-apuntada"
  harness uninstall --yes < /dev/null >/dev/null 2>&1; con_llave harness install --yes >/dev/null 2>&1 || mal "ADOPT la reinstalación falló"
  [ "$(estado 'd.repoint')" = null ] && [ "$(fuente agent_skills url)" = "$LAB_REMOTE_UNIFIED" ] || mal "ADOPT precondición: el estado nuevo no nació sin rastro: $(estado 'd.repoint')"
  SALIDA="$(con_llave harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ -z "$SALIDA" ] && [ "$(estado 'd.repoint.blocked')" = null ] && [ "$(estado 'd.repoint.applied.from.url')" = "$LAB_REMOTE_SKILLS" ] && [ "$(estado 'd.repoint.applied.from.commit')" = "$LAB_COMMIT_SKILLS" ] \
    && ok "ADOPT reinstalada con el clon ya re-apuntado: el arranque lo reconoce sin decir nada, y recupera de dónde venía" || mal "ADOPT (rc $RC) «${SALIDA}»: repoint $(estado 'd.repoint')"
  [ "$(con_llave harness doctor --json 2>/dev/null | doctor_json 'd.fail.length')" = 0 ] && ok "ADOPT doctor sin rojo" || mal "ADOPT doctor: $(con_llave harness doctor 2>&1 | head -6)"
  harness_lab_publish tree "versión nueva, después de reinstalar" skills/tycon-pipeline/NEW.md "nuevo"
  con_llave harness update >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_TREE")" ] \
    && ok "ADOPT …y la máquina se sigue actualizando: los dos clones, en el mismo commit" || mal "ADOPT la máquina dejó de actualizarse: arnés $(head_de "$LAB_TREE") skills $(head_de "$LAB_SKILLS")"
  # la vuelta sigue funcionando: el clon viejo queda como al principio (el arnés avanzó: se compara todo menos su línea, y
  # settings.json, que la reinstalación volvió a escribir)
  SALIDA="$(harness update 2>&1)"; RC=$?
  foto "$BASE/adopt/despues"
  grep -v '^arnés: \|^settings.json: ' "$BASE/adopt/antes" > "$BASE/adopt/antes.sin"; grep -v '^arnés: \|^settings.json: ' "$BASE/adopt/despues" > "$BASE/adopt/despues.sin"
  [ "$RC" = 0 ] && igual "$BASE/adopt/antes.sin" "$BASE/adopt/despues.sin" && [ "$(estado 'd.repoint')" = null ] \
    && ok "ADOPT la vuelta después de reinstalar: el clon viejo queda byte a byte como al principio" || mal "ADOPT la vuelta (rc $RC): $(diff "$BASE/adopt/antes.sin" "$BASE/adopt/despues.sin" | head -8): $SALIDA"
  # espejo: un clon de skills que apunta al repo unificado y NO es obra de la llave (sin constancia), con la llave apagada: no se toca
  maquina "$BASE/adopt2" || mal "ADOPT no pude armar la segunda máquina"
  sk remote set-url origin "$LAB_REMOTE_UNIFIED"; estado_set "d.sources.find((s)=>s.name==='agent_skills').url='$LAB_REMOTE_UNIFIED'"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado 'd.repoint')" = null ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_SKILLS" ] \
    && ok "ADOPT espejo: un clon que alguien apuntó a mano al repo unificado, con la llave apagada, no es una mudanza: no se toca" || mal "ADOPT espejo (rc $RC): repoint $(estado 'd.repoint'): $SALIDA"
fi

# ═══ REAL · con el aplicador de verdad: re-apuntar no le hace decir nada nuevo ═══════════════════════════════════════
if corre REAL; then
  if ! lab_team "$BASE/real" real; then mal "REAL no pude armar la máquina del equipo con el árbol de verdad"; else
    harness_lab_isolated harness install --yes >/dev/null 2>&1 || mal "REAL install falló"
    harness_lab_cut || mal "REAL el corte falló"
    harness_lab_isolated harness update >/dev/null 2>&1
    [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] || mal "REAL precondición: el arnés no llegó a la unión"
    harness_lab_real_applier >/dev/null 2>&1   # una corrida para que lo que escribe la primera vez ya esté
    harness_lab_real_applier > "$BASE/real/antes.out" 2>&1; RC_A=$?
    harness_lab_real_applier --check > "$BASE/real/antes.check" 2>&1
    SETTINGS0="$(shasum -a 256 < "$TYCON_SETTINGS_PATH")"; ENLACES0="$(harness_lab_links)"; EXTRAS0="$(harness_lab_clone_extras "$LAB_SKILLS")"
    SALIDA="$(con_llave harness_lab_isolated harness startup 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_TREE")" ] && [ "$(harness_lab_clone_extras "$LAB_SKILLS")" = "$EXTRAS0" ] \
      && ok "REAL con el aplicador de verdad: la ida pasa y lo del dev queda idéntico" || mal "REAL la ida (rc $RC): $SALIDA"
    harness_lab_real_applier > "$BASE/real/despues.out" 2>&1; RC_D=$?
    harness_lab_real_applier --check > "$BASE/real/despues.check" 2>&1
    [ "$RC_A" = 0 ] && [ "$RC_D" = 0 ] && igual "$BASE/real/antes.out" "$BASE/real/despues.out" && igual "$BASE/real/antes.check" "$BASE/real/despues.check" \
      && ok "REAL después de re-apuntar el aplicador dice exactamente lo mismo que antes, también con --check (cero líneas nuevas)" || mal "REAL el aplicador cambió lo que dice: $(diff "$BASE/real/antes.out" "$BASE/real/despues.out" | head -6) $(diff "$BASE/real/antes.check" "$BASE/real/despues.check" | head -4)"
    [ "$(shasum -a 256 < "$TYCON_SETTINGS_PATH")" = "$SETTINGS0" ] && [ "$(harness_lab_links)" = "$ENLACES0" ] \
      && ok "REAL settings.json y los enlaces: iguales que antes de re-apuntar" || mal "REAL settings.json o los enlaces cambiaron"
    [ ! -e "$LAB_SKILLS/scripts/install-tycon-hooks.sh" ] && ok "REAL el instalador no está en el clon re-apuntado" || mal "REAL el clon re-apuntado muestra el instalador"
    JSON="$(con_llave harness_lab_isolated harness doctor --json 2>/dev/null)"
    [ "$(printf '%s' "$JSON" | doctor_json 'd.fail.length')" = 0 ] && ok "REAL doctor sin rojo en la máquina re-apuntada" || mal "REAL doctor: $(printf '%s' "$JSON" | doctor_json 'd.fail')"
  fi
fi

# ═══ SAME · ~/.claude/agent-skills pasó a ser el clon del arnés: la mudanza se niega y no lo toca ═════════════════════
# El caso (pase adversarial, clases 1 y 20): el dev borra su clon viejo y el aplicador enlaza `~/.claude/agent-skills` al
# clon del arnés (canonical-path.js --ensure-repo-links). El estado sigue listando la fuente `agent_skills`. Con la llave
# en `unified` la ida le ponía la vista reducida AL CLON DEL ARNÉS (desaparecía scripts/, con harness.js adentro) y la
# vuelta le hacía `reset --hard` al commit viejo de agent-skills. Y `install`, el remedio, no volvía a detectar las fuentes.
if corre SAME; then
  # el dev borra el clon viejo y el aplicador deja el enlace al clon del arnés
  un_arbol_de_hecho() {
    rm -f "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents"; rm -rf "$LAB_SKILLS"
    node "$LAB_TREE/scripts/lib/canonical-path.js" --ensure-repo-links --clone "$LAB_TREE" --home "$LAB_HOME" >/dev/null 2>&1
    [ -L "$LAB_SKILLS" ] && [ "$(cd "$LAB_SKILLS" && pwd -P)" = "$(cd "$LAB_TREE" && pwd -P)" ]
  }
  # (1) la ida
  maquina "$BASE/same" || mal "SAME no pude armar la máquina del equipo después del corte"
  un_arbol_de_hecho || mal "SAME precondición: ~/.claude/agent-skills no quedó enlazado al clon del arnés"
  [ "$(estado 'd.sources.length')" = 2 ] || mal "SAME precondición: el estado ya no lista la fuente agent_skills"
  foto_arbol "$BASE/same/antes"
  SALIDA="$(con_llave harness startup 2>&1)"; RC=$?
  foto_arbol "$BASE/same/despues"
  igual "$BASE/same/antes" "$BASE/same/despues" && [ -f "$LAB_TREE/scripts/setup/harness.js" ] && [ -f "$LAB_TREE/scripts/install-tycon-hooks.sh" ] && [ -z "$(tr_ config --get core.sparseCheckout)" ] \
    && ok "SAME la ida: con agent-skills enlazado al clon del arnés, el arranque con la llave NO toca ese clon (scripts/ sigue ahí, sin vista reducida)" || mal "SAME la ida tocó el clon del arnés (rc $RC): $(diff "$BASE/same/antes" "$BASE/same/despues" | head -8) · scripts/: $([ -e "$LAB_TREE/scripts" ] && echo está || echo NO): $SALIDA"
  AVISO="$(estado 'd.notice')"
  case "$AVISO" in *"clon del arnés"*"harness.js install"*) ok "SAME la ida: el aviso nombra la causa (ya no es un clon aparte: es el clon del arnés) y el comando (harness.js install)" ;; *) mal "SAME la ida: el aviso no nombra la causa o el comando: $AVISO" ;; esac
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  foto_arbol "$BASE/same/despues2"
  [ "$RC" = 2 ] && igual "$BASE/same/antes" "$BASE/same/despues2" && case "$SALIDA" in *"clon del arnés"*) true ;; *) false ;; esac \
    && ok "SAME la ida: update a mano sale 2 con la misma causa, y tampoco lo toca" || mal "SAME update a mano (rc $RC): $(diff "$BASE/same/antes" "$BASE/same/despues2" | head -6): $SALIDA"
  # el remedio que el aviso nombra, corrido tal cual: install vuelve a detectar las fuentes (clase 20)
  REMEDIO="$(remedio "$SALIDA" 'node ')"
  [ -n "$REMEDIO" ] && corre_remedio "$REMEDIO" >/dev/null 2>&1; RC=$?
  [ -n "$REMEDIO" ] && [ "$RC" = 0 ] && [ "$(estado 'd.sources.length')" = 1 ] && [ "$(estado 'd.sources[0].name')" = harness ] && [ "$(estado 'd.repoint')" = null ] \
    && ok "SAME (clase 20) el comando del aviso («${REMEDIO}») vuelve a detectar las fuentes: queda una, sin rastro de la mudanza" || mal "SAME (clase 20) el remedio «${REMEDIO}» (rc $RC) no arregló el estado: fuentes $(estado 'd.sources.map((s)=>s.name)'), repoint $(estado 'd.repoint')"
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && ok "SAME …y update vuelve a andar (sale 0)" || mal "SAME update después del remedio: rc $RC: $SALIDA"
  harness_lab_publish tree "versión nueva, después de pasar a un árbol" skills/tycon-pipeline/NEW.md "nuevo"
  con_llave harness update >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && [ -f "$LAB_TREE/scripts/setup/harness.js" ] && [ "$(con_llave harness doctor --json 2>/dev/null | doctor_json 'd.fail.length')" = 0 ] \
    && ok "SAME …la máquina se actualiza otra vez, y doctor queda sin rojo" || mal "SAME la máquina no se actualiza: arnés $(head_de "$LAB_TREE") publicado $(head_de "$LAB_AUTHOR_TREE"): $(con_llave harness doctor 2>&1 | grep '✗' | head -4)"
  # (2) la vuelta: la máquina estaba re-apuntada
  maquina "$BASE/same2" || mal "SAME no pude armar la segunda máquina"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "SAME precondición: la segunda máquina no quedó re-apuntada"
  un_arbol_de_hecho || mal "SAME precondición: el enlace de la segunda máquina"
  foto_arbol "$BASE/same2/antes"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  foto_arbol "$BASE/same2/despues"
  igual "$BASE/same2/antes" "$BASE/same2/despues" && [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] && [ "$(origen_de "$LAB_TREE")" = "$LAB_REMOTE_UNIFIED" ] && [ -f "$LAB_TREE/scripts/setup/harness.js" ] \
    && ok "SAME la vuelta: con la llave en separate, el clon del arnés no vuelve al commit viejo de agent-skills ni cambia de origin" || mal "SAME la vuelta tocó el clon del arnés (rc $RC): head $(head_de "$LAB_TREE") origin $(origen_de "$LAB_TREE") · $(diff "$BASE/same2/antes" "$BASE/same2/despues" | head -6): $SALIDA"
  case "$(estado 'd.notice')" in *"clon del arnés"*"harness.js install"*) ok "SAME la vuelta: el aviso nombra la causa y el comando" ;; *) mal "SAME la vuelta: aviso $(estado 'd.notice')" ;; esac
  # (3) una mudanza «en curso» tampoco se deshace sobre el clon del arnés
  maquina "$BASE/same3" || mal "SAME no pude armar la tercera máquina"
  con_llave harness startup >/dev/null 2>&1
  estado_set "const a=d.repoint.applied; d.repoint={pending:{step:'forward',from:a.from,to:a.to,at:a.at}}; const s=d.sources.find((x)=>x.name==='agent_skills'); s.url=a.from.url; s.commit=a.from.commit; s.previous=a.from.previous;"
  un_arbol_de_hecho || mal "SAME precondición: el enlace de la tercera máquina"
  foto_arbol "$BASE/same3/antes"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  foto_arbol "$BASE/same3/despues"
  igual "$BASE/same3/antes" "$BASE/same3/despues" && [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] \
    && ok "SAME una mudanza en curso: el arranque no la deshace sobre el clon del arnés" || mal "SAME la mudanza en curso se deshizo sobre el clon del arnés (rc $RC): head $(head_de "$LAB_TREE") · $(diff "$BASE/same3/antes" "$BASE/same3/despues" | head -6): $SALIDA"
  harness install --yes >/dev/null 2>&1
  [ "$(estado 'd.sources.length')" = 1 ] && [ "$(estado 'd.repoint')" = null ] && harness update >/dev/null 2>&1 \
    && ok "SAME …e install la saca del estado junto con la fuente que ya no existe; update sale 0" || mal "SAME install no limpió la mudanza en curso: fuentes $(estado 'd.sources.length'), repoint $(estado 'd.repoint')"
  # (4) clase 20 con la llave apagada: el remedio que nombran update y doctor (install --source <url>) destraba
  maquina "$BASE/same4" || mal "SAME no pude armar la cuarta máquina"
  un_arbol_de_hecho || mal "SAME precondición: el enlace de la cuarta máquina"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 2 ] && case "$SALIDA" in *"install --source"*) true ;; *) false ;; esac || mal "SAME precondición: update no pidió install --source (rc $RC): $SALIDA"
  SALIDA="$(harness install --yes --source "$LAB_REMOTE_UNIFIED" 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado 'd.sources.length')" = 1 ] && case "$SALIDA" in *"agent_skills"*) true ;; *) false ;; esac \
    && ok "SAME (clase 20) install --source <url> sobre el mismo árbol: el estado queda con la única fuente de ahora, y lo dice" || mal "SAME (clase 20) install --source (rc $RC): fuentes $(estado 'd.sources.map((s)=>s.name)'): $SALIDA"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(harness doctor --json 2>/dev/null | doctor_json 'd.fail.length')" = 0 ] \
    && ok "SAME (clase 20) …update sale 0 y doctor queda sin rojo" || mal "SAME (clase 20) después de install --source: update rc $RC: $SALIDA · $(harness doctor 2>&1 | grep '✗' | head -4)"
  # espejo: install sobre una máquina de dos clones de verdad NO toca las fuentes
  maquina "$BASE/same5" || mal "SAME no pude armar la quinta máquina"
  foto_estado "$BASE/same5/antes.estado"
  SALIDA="$(harness install --yes 2>&1)"; RC=$?
  foto_estado "$BASE/same5/despues.estado"
  [ "$RC" = 0 ] && igual "$BASE/same5/antes.estado" "$BASE/same5/despues.estado" && case "$SALIDA" in *"sin cambios"*) true ;; *) false ;; esac \
    && ok "SAME espejo: con dos clones de verdad, install otra vez no cambia las fuentes («sin cambios»)" || mal "SAME espejo (rc $RC): $(diff "$BASE/same5/antes.estado" "$BASE/same5/despues.estado" | head -4): $SALIDA"
fi

# ═══ VIEW · la vista reducida se lee por su valor efectivo, y el remedio del aviso destraba ═══════════════════════════
# El caso (clases 7, 8, 10 y 11): `git sparse-checkout set` y `disable` escriben en `.git/config.worktree`, que le gana
# a `.git/config`. La mudanza leía y escribía sólo `.git/config`: con `core.sparseCheckout=false` en el otro archivo,
# `reapply` fallaba en la ida y al deshacer, y la mudanza quedaba «en curso» para siempre; una vista propia hecha con el
# comando estándar no se detectaba; y `git sparse-checkout disable`, el remedio del aviso, no destrababa.
if corre VIEW; then
  efectiva() { sk config --type=bool --get core.sparseCheckout; }
  # (1) el clon viejo de un dev que alguna vez probó sparse-checkout y lo apagó: ida y vuelta, byte a byte
  maquina "$BASE/view" || mal "VIEW no pude armar la máquina del equipo después del corte"
  sk sparse-checkout set skills agents >/dev/null 2>&1; sk sparse-checkout disable >/dev/null 2>&1
  [ "$(efectiva)" = false ] && [ -z "$(sk config --local --get core.sparseCheckout)" ] && [ -f "$LAB_SKILLS/.git/config.worktree" ] && [ -z "$(sk status --porcelain --untracked-files=no)" ] \
    || mal "VIEW precondición: el clon no quedó con la vista apagada en config.worktree"
  foto "$BASE/view/antes"; foto_estado "$BASE/view/antes.estado"
  SALIDA="$(con_llave harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_TREE")" ] && [ "$(visibles)" = "agents packs skills " ] && [ "$(estado 'd.repoint.pending')" = null ] && [ "$(estado 'd.repoint.applied.from.commit')" = "$LAB_COMMIT_SKILLS" ] \
    && ok "VIEW con core.sparseCheckout=false en config.worktree (un «sparse-checkout disable» de antes), la ida pasa y el clon muestra sólo lo suyo" || mal "VIEW la ida (rc $RC): repoint $(estado 'd.repoint' | cut -c1-200): $SALIDA"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  foto "$BASE/view/despues"; foto_estado "$BASE/view/despues.estado"
  [ "$RC" = 0 ] && igual "$BASE/view/antes" "$BASE/view/despues" && igual "$BASE/view/antes.estado" "$BASE/view/despues.estado" \
    && ok "VIEW …y la vuelta lo deja byte a byte como estaba, config.worktree incluido" || mal "VIEW la vuelta (rc $RC): $(diff "$BASE/view/antes" "$BASE/view/despues" | head -8) $(diff "$BASE/view/antes.estado" "$BASE/view/despues.estado" | head -3): $SALIDA"
  # (2) una vista propia hecha con el comando estándar: se detecta, no se pisa, y el remedio del aviso destraba
  maquina "$BASE/view2" || mal "VIEW no pude armar la segunda máquina"
  sk sparse-checkout set --no-cone '/*' '!/packs/' >/dev/null 2>&1
  [ "$(efectiva)" = true ] && [ -z "$(sk config --local --get core.sparseCheckout)" ] && [ ! -e "$LAB_SKILLS/packs" ] || mal "VIEW precondición: la vista propia del dev no quedó puesta"
  foto "$BASE/view2/antes"
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  foto "$BASE/view2/despues"
  [ "$RC" = 2 ] && igual "$BASE/view2/antes" "$BASE/view2/despues" && case "$SALIDA" in *"vista reducida propia"*) true ;; *) false ;; esac \
    && ok "VIEW una vista propia hecha con «git sparse-checkout set» se detecta: update sale 2, lo dice y no la pisa" || mal "VIEW la vista propia no frenó (rc $RC): $(diff "$BASE/view2/antes" "$BASE/view2/despues" | head -6): $SALIDA"
  REMEDIO="$(remedio "$SALIDA" 'git -C ')"
  [ -n "$REMEDIO" ] && corre_remedio "$REMEDIO" >/dev/null 2>&1
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  [ -n "$REMEDIO" ] && [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(visibles)" = "agents packs skills " ] \
    && ok "VIEW el remedio del aviso («${REMEDIO##*agent-skills }»), corrido tal cual, destraba: el update siguiente re-apunta" || mal "VIEW el remedio «${REMEDIO}» no destrabó (rc $RC): $SALIDA"
  # (3) una vista a la antigua (core.sparseCheckout=true en .git/config): el mismo remedio destraba, y la vuelta anda
  maquina "$BASE/view3" || mal "VIEW no pude armar la tercera máquina"
  sk config --local core.sparseCheckout true; printf '/*\n' > "$LAB_SKILLS/.git/info/sparse-checkout"
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  [ "$RC" = 2 ] && case "$SALIDA" in *"vista reducida propia"*) true ;; *) false ;; esac || mal "VIEW precondición: la vista a la antigua no frenó (rc $RC): $SALIDA"
  REMEDIO="$(remedio "$SALIDA" 'git -C ')"
  [ -n "$REMEDIO" ] && corre_remedio "$REMEDIO" >/dev/null 2>&1
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  [ -n "$REMEDIO" ] && [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(estado 'd.repoint.pending')" = null ] \
    && ok "VIEW con la vista a la antigua, el remedio del aviso destraba (antes: el mismo aviso para siempre)" || mal "VIEW vista a la antigua: el remedio «${REMEDIO}» no destrabó (rc $RC): repoint $(estado 'd.repoint' | cut -c1-200): $SALIDA"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_SKILLS" ] && [ "$(sk ls-files -t | grep -c '^S ')" = 0 ] && [ "$(estado 'd.repoint')" = null ] && [ "$(efectiva)" = false ] \
    && ok "VIEW …y la vuelta de ese clon pasa: repo viejo, commit viejo, todo a la vista" || mal "VIEW la vuelta de la vista a la antigua (rc $RC): repoint $(estado 'd.repoint' | cut -c1-200): $SALIDA"
  # (4) en el clon YA re-apuntado, el dev corre «git sparse-checkout disable» (para ver todo): la vuelta pasa igual
  maquina "$BASE/view4" || mal "VIEW no pude armar la cuarta máquina"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "VIEW precondición: la cuarta máquina no quedó re-apuntada"
  sk sparse-checkout disable >/dev/null 2>&1
  [ "$(efectiva)" = false ] && [ "$(sk config --local --get core.sparseCheckout)" = true ] || mal "VIEW precondición: el disable no dejó local=true y efectiva=false"
  harness_lab_publish tree "versión nueva: si la máquina quedara congelada, se vería" skills/tycon-pipeline/V9.md "v9"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_SKILLS" ] && [ "$(estado 'd.repoint')" = null ] && [ "$(sk ls-files -t | grep -c '^S ')" = 0 ] \
    && ok "VIEW con la vista apagada a mano en el clon re-apuntado, la vuelta pasa (antes: «quedó a medias» para siempre)" || mal "VIEW la vuelta con la vista apagada a mano (rc $RC): repoint $(estado 'd.repoint' | cut -c1-200): $SALIDA"
  suelta_la_mirada; harness startup >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && ok "VIEW …y la máquina sigue actualizándose (el arnés baja la versión nueva)" || mal "VIEW la máquina quedó congelada: arnés $(head_de "$LAB_TREE") publicado $(head_de "$LAB_AUTHOR_TREE")"
fi

# ═══ BACK · la vuelta no pisa nada del dev ════════════════════════════════════════════════════════════════════════════
# El caso (clases 3, 9, 16, 17, 18 y 19): la ida frena ante un archivo del dev en el camino; la vuelta (`reset --hard` al
# commit guardado) lo pisaba sin aviso y sin copia. Una mudanza en curso se deshacía sobre la rama en la que estuviera
# parado el dev. Lo que estaba en el índice volvía sin agregar. Y un renombre sin commitear escondía la ruta vieja.
if corre BACK; then
  FRASE_VUELTA='la llave volvió a «separate» y este clon sigue en el repo unificado'
  maquina "$BASE/back" || mal "BACK no pude armar la máquina del equipo después del corte"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "BACK precondición: la máquina no quedó re-apuntada"
  # el repo unido retira dos rutas que el commit viejo sigue (una pasa a estar ignorada), y la máquina actualiza
  harness_lab_git "$LAB_AUTHOR_TREE" pull -q --ff-only origin main
  harness_lab_git "$LAB_AUTHOR_TREE" rm -q skills/lab-skill/SKILL.md packs/lab/pack.json
  printf 'packs/lab/\n' >> "$LAB_AUTHOR_TREE/.gitignore"
  harness_lab_git "$LAB_AUTHOR_TREE" add -A; harness_lab_git "$LAB_AUTHOR_TREE" commit -q -m "el repo unido retira dos rutas"; harness_lab_git "$LAB_AUTHOR_TREE" push -q origin main
  con_llave harness update >/dev/null 2>&1
  [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && [ ! -e "$LAB_SKILLS/skills/lab-skill/SKILL.md" ] && [ ! -e "$LAB_SKILLS/packs/lab/pack.json" ] || mal "BACK precondición: el retiro no llegó al clon re-apuntado"
  # frenada <nombre> <ruta>  — update con la llave en separate tiene que salir 2, nombrar la ruta y no tocar nada
  frenada() {
    foto "$BASE/back/antes"; COPIAS="$(copias_de repoint-back)"
    SALIDA="$(harness update 2>&1)"; RC=$?
    foto "$BASE/back/despues"
    [ "$RC" = 2 ] && printf '%s' "$SALIDA" | grep -- "$2" >/dev/null && printf '%s' "$SALIDA" | grep "$FRASE_VUELTA" >/dev/null && printf '%s' "$SALIDA" | grep "movelo o borralo" >/dev/null \
      && ok "BACK $1: la vuelta sale 2, nombra la ruta ($2) y qué hacer" || mal "BACK $1: rc $RC: $SALIDA"
    igual "$BASE/back/antes" "$BASE/back/despues" && [ "$(copias_de repoint-back)" = "$COPIAS" ] \
      && ok "BACK $1: no se tocó nada del clon" || mal "BACK $1: algo se movió: $(diff "$BASE/back/antes" "$BASE/back/despues" | head -8)"
  }
  # (a) sin versionar, en una ruta que el commit guardado sigue
  mkdir -p "$LAB_SKILLS/skills/lab-skill"; printf 'MI COPIA PERSONAL, con mis cambios\n' > "$LAB_SKILLS/skills/lab-skill/SKILL.md"
  frenada "sin versionar en una ruta que vuelve" "skills/lab-skill/SKILL.md"
  [ "$(cat "$LAB_SKILLS/skills/lab-skill/SKILL.md")" = "MI COPIA PERSONAL, con mis cambios" ] && ok "BACK sin versionar: el archivo del dev quedó intacto" || mal "BACK el archivo sin versionar del dev se pisó: «$(cat "$LAB_SKILLS/skills/lab-skill/SKILL.md")»"
  rm -rf "$LAB_SKILLS/skills/lab-skill"
  # (b) ignorado
  mkdir -p "$LAB_SKILLS/packs/lab"; printf 'del dev, ignorado\n' > "$LAB_SKILLS/packs/lab/pack.json"
  case "$(sk status --porcelain --ignored -- packs/lab)" in '!!'*) true ;; *) mal "BACK precondición: packs/lab no quedó ignorado: «$(sk status --porcelain --ignored -- packs/lab)»" ;; esac
  frenada "ignorado en una ruta que vuelve" "packs/lab/pack.json"
  [ "$(cat "$LAB_SKILLS/packs/lab/pack.json")" = "del dev, ignorado" ] && ok "BACK ignorado: el archivo del dev quedó intacto" || mal "BACK el archivo ignorado del dev se pisó: «$(cat "$LAB_SKILLS/packs/lab/pack.json")»"
  rm -rf "$LAB_SKILLS/packs/lab"
  # espejo: sin nada en el camino, la misma máquina vuelve (y el arranque reintentó solo: lo que se miró cambió)
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_SKILLS" ] && [ "$(cat "$LAB_SKILLS/skills/lab-skill/SKILL.md")" = "# otra skill de juguete" ] && [ "$(estado 'd.repoint')" = null ] \
    && ok "BACK espejo: sin nada del dev en el camino, el arranque siguiente vuelve solo, y las rutas retiradas reaparecen" || mal "BACK espejo (rc $RC): origin $(origen_de "$LAB_SKILLS"), repoint $(estado 'd.repoint' | cut -c1-200): $SALIDA"
  # (c) lo mismo al deshacer una mudanza «en curso»: no pisa, lo dice, y sin el archivo la deshace
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ ! -e "$LAB_SKILLS/skills/lab-skill/SKILL.md" ] || mal "BACK precondición: la segunda ida no pasó"
  estado_set "const a=d.repoint.applied; d.repoint={pending:{step:'forward',from:a.from,to:a.to,at:a.at}}; const s=d.sources.find((x)=>x.name==='agent_skills'); s.url=a.from.url; s.commit=a.from.commit; s.previous=a.from.previous;"
  mkdir -p "$LAB_SKILLS/skills/lab-skill"; printf 'MI COPIA PERSONAL, otra vez\n' > "$LAB_SKILLS/skills/lab-skill/SKILL.md"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$(cat "$LAB_SKILLS/skills/lab-skill/SKILL.md")" = "MI COPIA PERSONAL, otra vez" ] && [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_TREE")" ] && [ "$(estado 'd.repoint.pending.step')" = forward ] \
    && case "$(estado 'd.notice')" in *"skills/lab-skill/SKILL.md"*) true ;; *) false ;; esac \
    && ok "BACK una mudanza en curso con un archivo del dev en el camino: no se deshace encima, y el aviso nombra la ruta" || mal "BACK en curso (rc $RC): archivo «$(cat "$LAB_SKILLS/skills/lab-skill/SKILL.md")», repoint $(estado 'd.repoint' | cut -c1-160), aviso $(estado 'd.notice')"
  rm -rf "$LAB_SKILLS/skills/lab-skill"
  # (d) clase 17: en curso, y el dev quedó parado en una rama suya con un commit propio
  sk checkout -q -b mi-rama
  printf 'notas del dev\n' > "$LAB_SKILLS/agents/NOTAS.md"; sk add agents/NOTAS.md; sk commit -q -m "trabajo del dev en su rama"
  PROPIO="$(head_de "$LAB_SKILLS")"; MAIN0="$(sk rev-parse refs/heads/main)"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$(sk rev-parse refs/heads/mi-rama)" = "$PROPIO" ] && [ "$(sk rev-parse refs/heads/main)" = "$MAIN0" ] && [ -f "$LAB_SKILLS/agents/NOTAS.md" ] && [ "$(estado 'd.repoint.pending.step')" = forward ] \
    && ok "BACK (clase 17) una mudanza en curso con el clon en una rama del dev: no se deshace sobre esa rama (su commit sigue ahí)" || mal "BACK (clase 17) mi-rama $(sk rev-parse refs/heads/mi-rama) (propio $PROPIO), main $(sk rev-parse refs/heads/main), repoint $(estado 'd.repoint' | cut -c1-160)"
  case "$(estado 'd.notice')" in *"mi-rama"*"checkout main"*) ok "BACK (clase 17) …y el aviso nombra la rama y el comando (checkout main)" ;; *) mal "BACK (clase 17) aviso: $(estado 'd.notice')" ;; esac
  sk checkout -q main
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_SKILLS" ] && [ "$(estado 'd.repoint')" = null ] && [ "$(sk rev-parse refs/heads/mi-rama)" = "$PROPIO" ] \
    && ok "BACK (clase 17) espejo: de vuelta en main, el arranque siguiente la deshace, y la rama del dev queda como estaba" || mal "BACK (clase 17) espejo (rc $RC): origin $(origen_de "$LAB_SKILLS"), repoint $(estado 'd.repoint' | cut -c1-160): $SALIDA"
  # (e) clases 16 y 19: lo que el dev tenía en el índice vuelve EN el índice
  maquina "$BASE/back3" || mal "BACK no pude armar la segunda máquina"
  printf '\ncambio agregado al índice\n' >> "$LAB_SKILLS/agents/lab-reviewer.md"; sk add agents/lab-reviewer.md
  sk rm -q .tycon/lab-config.yaml
  printf '\ncambio sin agregar\n' >> "$LAB_SKILLS/skills/lab-skill/SKILL.md"
  STATUS0="$(sk status --porcelain --untracked-files=no)"
  [ "$(printf '%s\n' "$STATUS0" | grep -c .)" = 3 ] || mal "BACK precondición: el clon no tiene sus tres cambios: «${STATUS0}»"
  foto "$BASE/back3/antes"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(sk status --porcelain --untracked-files=no)" = "$STATUS0" ] || mal "BACK precondición: la ida no pasó, o no conservó el status: «$(sk status --porcelain --untracked-files=no)»"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  foto "$BASE/back3/despues"
  [ "$RC" = 0 ] && [ "$(sk status --porcelain --untracked-files=no)" = "$STATUS0" ] \
    && ok "BACK (clases 16 y 19) ida y vuelta: lo que estaba en el índice vuelve en el índice (mismo status)" || mal "BACK (clases 16 y 19) el status cambió (rc $RC): antes «${STATUS0}» después «$(sk status --porcelain --untracked-files=no)»: $SALIDA"
  igual "$BASE/back3/antes" "$BASE/back3/despues" && ok "BACK (clases 16 y 19) …y el clon queda byte a byte como al principio" || mal "BACK (clases 16 y 19) ida y vuelta con cambios en el índice dejó diferencias: $(diff "$BASE/back3/antes" "$BASE/back3/despues" | head -8)"
  # (f) clase 18: un renombre sin commitear no esconde la ruta que la versión nueva cambia
  maquina "$BASE/back4" || mal "BACK no pude armar la tercera máquina"
  sk mv README.md LEEME.md
  foto "$BASE/back4/antes"
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  foto "$BASE/back4/despues"
  [ "$RC" = 2 ] && case "$SALIDA" in *"cambios sin commitear en"*"README.md"*"stash push"*) true ;; *) false ;; esac \
    && ok "BACK (clase 18) con README.md renombrado sin commitear, la ida frena ANTES de mover: nombra el archivo y el comando" || mal "BACK (clase 18) rc $RC: $SALIDA"
  igual "$BASE/back4/antes" "$BASE/back4/despues" && [ "$(copias_de repoint)" = 0 ] \
    && ok "BACK (clase 18) …sin haber arrancado la mudanza (ni copia de seguridad, ni vista puesta y sacada)" || mal "BACK (clase 18) la mudanza arrancó: $(copias_de repoint) copia(s) · $(diff "$BASE/back4/antes" "$BASE/back4/despues" | head -6)"
fi

# ═══ STATE · el estado se contrasta con el clon de verdad ═════════════════════════════════════════════════════════════
# El caso (clases 4, 5, 6, 12 y 13): «sin constancia» decía «no frena a nadie» y desde el segundo arranque congelaba la
# máquina; seguir el remedio del aviso no soltaba `repoint.applied`; `update --dry-run` lo dejaba grabado; y con el clon
# reemplazado por uno del repo viejo, doctor seguía diciendo «✓ re-apuntados».
if corre STATE; then
  FRASE_VUELTA='la llave volvió a «separate» y este clon sigue en el repo unificado'
  # la máquina cuyo ~/.claude/agent-skills se volvió a clonar a mano desde el repo unificado: sin constancia de la mudanza
  lab_team "$BASE/state" toy || mal "STATE no pude armar la máquina"
  harness_lab_cut && harness_lab_pull_tree || mal "STATE el corte falló"
  rm -f "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents"; rm -rf "$LAB_SKILLS"
  harness_lab_git "$LAB_HOME/.claude" clone -q "$LAB_REMOTE_UNIFIED" "$LAB_SKILLS" || mal "STATE no pude clonar agent-skills desde el repo unificado"
  ln -s "$LAB_SKILLS/skills" "$LAB_HOME/.claude/skills"; ln -s "$LAB_SKILLS/agents" "$LAB_HOME/.claude/agents"
  harness install --yes >/dev/null 2>&1 || mal "STATE install falló"
  [ "$(fuente agent_skills url)" = "$LAB_REMOTE_UNIFIED" ] && [ "$(estado 'd.repoint')" = null ] || mal "STATE precondición: fuente $(fuente agent_skills url), repoint $(estado 'd.repoint')"
  # (clase 13) --dry-run no deja nada grabado
  SALIDA="$(con_llave harness update --dry-run 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado 'd.repoint')" = null ] \
    && ok "STATE (clase 13) update --dry-run con la llave no deja la adopción grabada en el estado" || mal "STATE (clase 13) --dry-run (rc $RC) dejó: $(estado 'd.repoint')"
  con_llave harness startup >/dev/null 2>&1
  [ "$(estado 'd.repoint.applied.adopted')" = true ] && [ "$(estado 'd.repoint.applied.from')" = null ] || mal "STATE precondición: el arranque con la llave no adoptó sin origen: $(estado 'd.repoint')"
  # (clases 5 y 12) la llave vuelve a separate: se dice en cada arranque, y NINGÚN arranque deja de actualizar
  suelta_la_mirada
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado 'd.last_fetch')" != null ] && case "$(estado 'd.notice')" in *"$FRASE_VUELTA"*"no hay constancia"*) true ;; *) false ;; esac \
    && ok "STATE sin constancia, primer arranque: lo dice y mira la red igual" || mal "STATE primer arranque (rc $RC): last_fetch $(estado 'd.last_fetch'), aviso $(estado 'd.notice')"
  CONGELADA=0
  for N in 2 3 4; do
    harness_lab_publish tree "versión $N" VERSION "$N"
    suelta_la_mirada
    harness startup >/dev/null 2>&1
    [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] || CONGELADA=$((CONGELADA+1))
  done
  [ "$CONGELADA" = 0 ] && ! grep -q "no se actualiza ninguna fuente" "$(LOG)" \
    && ok "STATE (clases 5 y 12) sin constancia, arranques 2 a 4: la máquina sigue bajando cada versión nueva (no se congela)" || mal "STATE (clases 5 y 12) la máquina se congeló en $CONGELADA de 3 arranques: $(grep -c 'no se actualiza ninguna fuente' "$(LOG)") veces «no se actualiza ninguna fuente»"
  AVISO="$(estado 'd.notice')"
  case "$AVISO" in *"$FRASE_VUELTA"*"no hay constancia"*) ok "STATE …y el aviso sigue en cada arranque" ;; *) mal "STATE el aviso se perdió: $AVISO" ;; esac
  JSON="$(harness doctor --json 2>/dev/null)"; RC=$?
  [ "$RC" = 1 ] && [ "$(printf '%s' "$JSON" | doctor_json "d.fail.filter((t)=>/no hay constancia/.test(t)).length")" = 1 ] \
    && ok "STATE …y doctor lo tiene en rojo" || mal "STATE doctor (rc $RC): $(printf '%s' "$JSON" | doctor_json 'd.fail')"
  # (clases 6 y 13) el remedio del aviso, seguido al pie de la letra, lo saca
  # (clases 6 y 13) el remedio del aviso, corrido tal cual (con la URL del repo viejo en su lugar), lo saca
  REMEDIO="$(remedio "$AVISO" 'git -C ')"
  case "$REMEDIO" in *"remote set-url origin <URL-del-repo-viejo>"*"install --source <URL-del-repo-viejo>"*"reset --keep origin/main"*) ok "STATE el aviso trae el remedio entero para volverlo a mano, en un solo comando" ;; *) mal "STATE el aviso no trae el remedio entero: $AVISO" ;; esac
  REMEDIO="${REMEDIO//<URL-del-repo-viejo>/$LAB_REMOTE_SKILLS}"
  [ -n "$REMEDIO" ] && corre_remedio "$REMEDIO" >/dev/null 2>&1; RC_REMEDIO=$?
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ -n "$REMEDIO" ] && [ "$RC_REMEDIO" = 0 ] && [ "$RC" = 0 ] && [ "$(estado 'd.repoint')" = null ] && case "$SALIDA$(estado 'd.notice')" in *"sigue en el repo unificado"*) false ;; *) true ;; esac \
    && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(head_de "$LAB_SKILLS")" = "$LAB_COMMIT_SKILLS" ] \
    && ok "STATE (clases 6 y 13) corrido el remedio, update sale 0, el estado suelta la mudanza y ya no dice que el clon sigue en el repo unificado" || mal "STATE (clases 6 y 13) después del remedio (rc del remedio $RC_REMEDIO, update rc $RC): repoint $(estado 'd.repoint' | cut -c1-200), aviso $(estado 'd.notice'): $SALIDA"
  harness_lab_publish tree "versión 5" VERSION 5; suelta_la_mirada
  harness startup >/dev/null 2>&1
  [ "$(head_de "$LAB_TREE")" = "$(head_de "$LAB_AUTHOR_TREE")" ] && [ "$(harness doctor --json 2>/dev/null | doctor_json "d.fail.filter((t)=>/sigue en el repo unificado|el origen cambió/.test(t)).length")" = 0 ] \
    && ok "STATE …la máquina se sigue actualizando, y doctor ya no tiene ese rojo" || mal "STATE después del remedio: arnés $(head_de "$LAB_TREE") publicado $(head_de "$LAB_AUTHOR_TREE") · $(harness doctor 2>&1 | grep '✗' | head -4)"
  # (clase 4) el clon re-apuntado se rompe y se vuelve a clonar del repo VIEJO: el estado no puede seguir diciendo «re-apuntado»
  maquina "$BASE/state4" || mal "STATE no pude armar la segunda máquina"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "STATE precondición: la segunda máquina no quedó re-apuntada"
  rm -rf "$LAB_SKILLS"; harness_lab_git "$LAB_HOME/.claude" clone -q "$LAB_REMOTE_SKILLS" "$LAB_SKILLS" || mal "STATE no pude volver a clonar el repo viejo"
  JSON="$(con_llave harness doctor --json 2>/dev/null)"
  [ "$(printf '%s' "$JSON" | doctor_json "d.ok.filter((t)=>/re-apuntados/.test(t)).length")" = 0 ] \
    && ok "STATE (clase 4) con el clon vuelto a clonar del repo viejo, doctor no dice «✓ re-apuntados»" || mal "STATE (clase 4) doctor da un ✓ falso: $(printf '%s' "$JSON" | doctor_json "d.ok.filter((t)=>/re-apuntados/.test(t))")"
  # el clon volvió al remoto del que venía (la URL que la propia ida anotó): el arranque con la llave lo re-apunta otra vez
  SALIDA="$(con_llave harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_TREE")" ] && [ "$(estado 'd.repoint.applied.from.url')" = "$LAB_REMOTE_SKILLS" ] && [ "$(estado 'd.repoint.applied.from.commit')" = "$LAB_COMMIT_SKILLS" ] \
    && ok "STATE (clase 4) el arranque con la llave suelta la constancia vieja y lo re-apunta de verdad (antes: «arnés al día» con el clon en el repo viejo)" || mal "STATE (clase 4) el arranque (rc $RC): origin $(origen_de "$LAB_SKILLS"), skills $(head_de "$LAB_SKILLS") arnés $(head_de "$LAB_TREE"), repoint $(estado 'd.repoint' | cut -c1-200): $SALIDA"
  JSON="$(con_llave harness doctor --json 2>/dev/null)"
  [ "$(printf '%s' "$JSON" | doctor_json 'd.fail.length')" = 0 ] && [ "$(printf '%s' "$JSON" | doctor_json "d.ok.filter((t)=>/re-apuntados/.test(t)).length")" = 1 ] \
    && ok "STATE (clase 4) …y ahí sí doctor dice «re-apuntados», sin rojo" || mal "STATE (clase 4) doctor: $JSON"
  # espejo, con la llave apagada: el estado suelta la mudanza y la fuente queda fijada donde está el clon (el repo viejo)
  maquina "$BASE/state5" || mal "STATE no pude armar la tercera máquina"
  con_llave harness startup >/dev/null 2>&1
  rm -rf "$LAB_SKILLS"; harness_lab_git "$LAB_HOME/.claude" clone -q "$LAB_REMOTE_SKILLS" "$LAB_SKILLS" || mal "STATE no pude volver a clonar el repo viejo (llave apagada)"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado 'd.repoint')" = null ] && [ "$(fuente agent_skills url)" = "$LAB_REMOTE_SKILLS" ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(harness doctor --json 2>/dev/null | doctor_json 'd.fail.length')" = 0 ] \
    && ok "STATE (clase 4) espejo con la llave apagada: update sale 0, el estado suelta la mudanza, la fuente queda en el repo viejo y doctor sin rojo" || mal "STATE (clase 4) espejo (rc $RC): repoint $(estado 'd.repoint' | cut -c1-200), fuente $(fuente agent_skills url): $SALIDA · $(harness doctor 2>&1 | grep '✗' | head -4)"
  # el origin del clon es OTRO que el que fijó el estado (ni el unificado ni el guardado): no se muda sin que la persona lo fije
  maquina "$BASE/state6" || mal "STATE no pude armar la cuarta máquina"
  harness_lab_git "$LAB/remotes" clone -q --bare "$LAB_REMOTE_SKILLS" "$LAB/remotes/another.git" || mal "STATE no pude armar el otro remoto"
  sk remote set-url origin "$LAB/remotes/another.git"
  foto "$BASE/state6/antes"
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  foto "$BASE/state6/despues"
  [ "$RC" = 2 ] && igual "$BASE/state6/antes" "$BASE/state6/despues" && case "$SALIDA" in *"no es el que fijó el estado"*"install --source"*) true ;; *) false ;; esac \
    && ok "STATE un clon cuyo origin no es el que fijó el estado no se re-apunta: sale 2, lo dice y nombra install --source" || mal "STATE origin cambiado (rc $RC): $(diff "$BASE/state6/antes" "$BASE/state6/despues" | head -6): $SALIDA"
  REMEDIO="$(remedio "$SALIDA" 'node ')"
  [ -n "$REMEDIO" ] && corre_remedio "$REMEDIO" >/dev/null 2>&1
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  [ -n "$REMEDIO" ] && [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(estado 'd.repoint.applied.from.url')" = "$LAB/remotes/another.git" ] \
    && ok "STATE …y corrido el remedio del aviso, el update siguiente lo re-apunta" || mal "STATE el remedio «${REMEDIO}» no destrabó (rc $RC): $SALIDA"
fi

# ═══ NFF · «no avanza en línea recta», ya arreglado en el repo unificado: update a mano destraba ══════════════════════
# El caso (clase 2): el repo viejo recibió un commit después de la unión y el clon lo bajó. El destino de la mudanza sale
# del clon local del arnés, y con el clon de skills frenado no se actualiza ninguna fuente (AC 32): aunque el repo
# unificado mergee ese commit, el clon del arnés nunca lo baja. `harness.js update` pedido a mano —el comando que el
# aviso nombra— trae primero el arnés, SÓLO si lo publicado ya contiene el commit del clon, y reintenta la mudanza.
if corre NFF; then
  maquina "$BASE/nff" || mal "NFF no pude armar la máquina del equipo después del corte"
  harness_lab_publish skills "un PR tardío en el repo viejo, después de la unión"
  harness update >/dev/null 2>&1
  TARDIO="$(head_de "$LAB_SKILLS")"
  [ "$TARDIO" != "$LAB_COMMIT_SKILLS" ] || mal "NFF precondición: el clon viejo no bajó el commit tardío"
  con_llave harness startup >/dev/null 2>&1
  AVISO="$(estado 'd.notice')"
  case "$AVISO" in *"línea recta"*) true ;; *) mal "NFF precondición: el arranque no frenó por «línea recta»: $AVISO" ;; esac
  case "$AVISO" in *"línea recta"*"harness.js update"*"a mano"*"reintenta"*) ok "NFF el aviso dice que update a mano trae el arnés y reintenta la mudanza" ;; *) mal "NFF el aviso no lo dice: $AVISO" ;; esac
  # sin arreglar, con una versión nueva del arnés que NO trae ese commit: update a mano no mueve ninguna fuente (AC 32)
  harness_lab_publish tree "una versión nueva que no arregla nada" skills/tycon-pipeline/V5.md "v5"
  foto "$BASE/nff/antes"
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  foto "$BASE/nff/despues"
  [ "$RC" = 2 ] && igual "$BASE/nff/antes" "$BASE/nff/despues" && [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] && case "$SALIDA" in *"línea recta"*) true ;; *) false ;; esac \
    && ok "NFF sin arreglar: update a mano sale 2 y no mueve ninguna fuente, aunque haya versión nueva del arnés" || mal "NFF sin arreglar (rc $RC): arnés $(head_de "$LAB_TREE") · $(diff "$BASE/nff/antes" "$BASE/nff/despues" | head -6): $SALIDA"
  # el repo unificado se arregla: mergea el commit tardío del repo viejo y publica
  harness_lab_git "$LAB_AUTHOR_TREE" pull -q --ff-only origin main
  harness_lab_git "$LAB_AUTHOR_TREE" fetch -q "$LAB_REMOTE_SKILLS" refs/heads/main
  harness_lab_git "$LAB_AUTHOR_TREE" merge -q --no-ff -m "unión: entra el PR tardío del repo viejo" FETCH_HEAD
  harness_lab_git "$LAB_AUTHOR_TREE" push -q origin main
  ARREGLADO="$(harness_lab_remote_head main)"
  harness_lab_git "$LAB_REMOTE_TREE" merge-base --is-ancestor "$TARDIO" "$ARREGLADO" || mal "NFF precondición: el repo unificado no quedó conteniendo el commit tardío"
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_TREE")" = "$ARREGLADO" ] && [ "$(head_de "$LAB_SKILLS")" = "$ARREGLADO" ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] \
    && ok "NFF arreglado en el repo unificado: update a mano trae el arnés y re-apunta en el mismo comando (los dos clones en el mismo commit)" || mal "NFF arreglado (rc $RC): arnés $(head_de "$LAB_TREE") skills $(head_de "$LAB_SKILLS") arreglado $ARREGLADO origin $(origen_de "$LAB_SKILLS"): $SALIDA"
  [ "$(estado 'd.repoint.blocked')" = null ] && [ "$(estado 'd.repoint.applied.from.commit')" = "$TARDIO" ] && [ "$(con_llave harness doctor --json 2>/dev/null | doctor_json 'd.fail.length')" = 0 ] \
    && ok "NFF …el estado guarda de dónde venía (el commit tardío) y doctor queda sin rojo" || mal "NFF estado: repoint $(estado 'd.repoint' | cut -c1-240) · $(con_llave harness doctor 2>&1 | grep '✗' | head -4)"
fi

# ═══ ARGS · una URL del estado que empieza con «-» no llega a git como opción ═════════════════════════════════════════
# El caso (revisor de seguridad): `git ls-remote <url>` sin el separador `--` lee una URL que empieza con «-» como una
# opción; `--upload-pack=<comando>` corre ese comando. La URL sale del estado y de la constancia del clon.
if corre ARGS; then
  maquina "$BASE/args" || mal "ARGS no pude armar la máquina del equipo después del corte"
  URL_BUENA="$(fuente harness url)"; MARCA="$BASE/args/corrio-un-comando"
  estado_set "d.sources.find((s)=>s.name==='harness').url='--upload-pack=touch $MARCA'"
  foto "$BASE/args/antes"
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  foto "$BASE/args/despues"
  [ "$RC" = 2 ] && [ ! -e "$MARCA" ] && igual "$BASE/args/antes" "$BASE/args/despues" && case "$SALIDA" in *"empieza con «-»"*) true ;; *) false ;; esac \
    && ok "ARGS la ida: una URL del arnés que empieza con «-» se rechaza con su causa, y no corre ningún comando" || mal "ARGS la ida (rc $RC): ¿corrió el comando? $([ -e "$MARCA" ] && echo SÍ || echo no): $SALIDA"
  rm -f "$MARCA" "$MARCA"*
  estado_set "d.sources.find((s)=>s.name==='harness').url='$URL_BUENA'"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "ARGS espejo: con la URL buena la ida no pasó"
  # la vuelta: la URL guardada de dónde venía
  estado_set "d.repoint.applied.from.url='--upload-pack=touch $MARCA'"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 2 ] && [ ! -e "$MARCA" ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && case "$SALIDA" in *"empieza con «-»"*) true ;; *) false ;; esac \
    && ok "ARGS la vuelta: una URL guardada que empieza con «-» se rechaza con su causa, y no corre ningún comando" || mal "ARGS la vuelta (rc $RC): ¿corrió el comando? $([ -e "$MARCA" ] && echo SÍ || echo no), origin $(origen_de "$LAB_SKILLS"): $SALIDA"
  estado_set "d.repoint.applied.from.url='$LAB_REMOTE_SKILLS'"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && ok "ARGS espejo: con la URL buena, la vuelta pasa" || mal "ARGS espejo de la vuelta (rc $RC): $SALIDA"
  # una mudanza «en curso» cuyo commit de destino guardado no es un commit (segunda vuelta del revisor de seguridad): el
  # deshacer lo pasaba a `git diff <de> <a>`, y `--output=<archivo>` hacía que git pisara ese archivo
  rm -f "$MARCA"
  ACA="$(sk rev-parse HEAD)"
  estado_set "d.repoint={pending:{step:'forward',at:'2026-10-04T00:00:00Z',from:{url:'$LAB_REMOTE_SKILLS',commit:'$ACA'},to:{url:'$LAB_REMOTE_UNIFIED',commit:'--output=$MARCA'}}}"
  SALIDA="$(harness update 2>&1)"; RC=$?
  [ ! -e "$MARCA" ] && [ "$(sk rev-parse HEAD)" = "$ACA" ] && case "$SALIDA" in *"no es un commit"*) true ;; *) false ;; esac \
    && ok "ARGS en curso: un commit de destino guardado que no es un commit se rechaza con su causa, y git no escribe nada" || mal "ARGS en curso (rc $RC): ¿escribió el archivo? $([ -e "$MARCA" ] && echo SÍ || echo no): $SALIDA"
  rm -f "$MARCA"
fi

# ═══ REDETECT · install no suelta una fuente que no pudo mirar ════════════════════════════════════════════════════════
# El caso (segunda vuelta del revisor de fallos silenciosos, hallazgo 1): al volver a detectar las fuentes, `install`
# tomaba CUALQUIER falla al resolver la carpeta de una fuente (permisos, un disco que no responde) como «ya no existe»:
# soltaba la fuente de skills y BORRABA lo anotado de su mudanza —de dónde venía el clon, o una mudanza a medias—, y la
# vuelta ya no se podía hacer sola. Se suelta sólo la que de verdad no está.
if corre REDETECT; then
  maquina "$BASE/redetect" || mal "REDETECT no pude armar la máquina del equipo después del corte"
  con_llave harness startup >/dev/null 2>&1
  [ "$(estado 'd.repoint.applied.from.url')" = "$LAB_REMOTE_SKILLS" ] || mal "REDETECT precondición: la máquina no quedó re-apuntada"
  # el clon pasa a vivir detrás de una carpeta que no se deja mirar (la carpeta queda sin permisos)
  LEJOS="$LAB/far"; mkdir -p "$LEJOS"
  rm -f "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents"
  mv "$LAB_SKILLS" "$LEJOS/agent-skills" && ln -s "$LEJOS/agent-skills" "$LAB_SKILLS" || mal "REDETECT no pude mover el clon de skills"
  ln -s "$LAB_SKILLS/skills" "$LAB_HOME/.claude/skills"; ln -s "$LAB_SKILLS/agents" "$LAB_HOME/.claude/agents"
  chmod 000 "$LEJOS"
  if node -e 'require("fs").realpathSync(process.argv[1])' "$LAB_SKILLS" >/dev/null 2>&1; then
    chmod 755 "$LEJOS"
    no_medido REDETECT "la carpeta sin permisos se deja resolver igual (¿corre como root?)"
  else
    SALIDA="$(harness install --yes 2>&1)"; RC=$?
    chmod 755 "$LEJOS"
    [ "$(estado 'd.sources.length')" = 2 ] && [ "$(fuente agent_skills url)" = "$LAB_REMOTE_UNIFIED" ] && [ "$(estado 'd.repoint.applied.from.url')" = "$LAB_REMOTE_SKILLS" ] && [ "$(estado 'd.repoint.applied.from.commit')" = "$LAB_COMMIT_SKILLS" ] \
      && ok "REDETECT con la carpeta del clon de skills sin poder mirarse, install no suelta la fuente ni lo anotado de su mudanza" || mal "REDETECT install (rc $RC) soltó lo que no pudo mirar: fuentes $(estado 'd.sources.map((s)=>s.name)'), repoint $(estado 'd.repoint' | cut -c1-200): $SALIDA"
    case "$SALIDA" in *"no pude mirar"*"agent_skills"*) ok "REDETECT …y lo dice, con la fuente y la causa" ;; *) mal "REDETECT install no dice que no pudo mirar la fuente (rc $RC): $SALIDA" ;; esac
    [ "$RC" = 1 ] && ok "REDETECT …y sale 1: no pudo mirar una fuente" || mal "REDETECT install sin poder mirar una fuente salió $RC (se esperaba 1): $SALIDA"
    # espejo: con la carpeta legible otra vez, install no cambia las fuentes, la vuelta sigue sabiendo a dónde ir, y sale 0
    SALIDA="$(harness install --yes 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ "$(estado 'd.sources.length')" = 2 ] && [ "$(estado 'd.repoint.applied.from.url')" = "$LAB_REMOTE_SKILLS" ] \
      && ok "REDETECT espejo: legible otra vez, install sale 0 y deja las dos fuentes y la mudanza como estaban" || mal "REDETECT espejo (rc $RC): fuentes $(estado 'd.sources.length'), repoint $(estado 'd.repoint' | cut -c1-200): $SALIDA"
    # espejo: el clon borrado DE VERDAD sí se suelta (la máquina pasó a un solo árbol), con lo anotado de su mudanza
    rm -rf "$LEJOS/agent-skills"
    SALIDA="$(harness install --yes 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ "$(estado 'd.sources.length')" = 1 ] && [ "$(estado 'd.repoint')" = null ] && case "$SALIDA" in *"ya no existe"*) true ;; *) false ;; esac \
      && ok "REDETECT espejo: con el clon borrado de verdad, install suelta la fuente y lo anotado de su mudanza, y lo dice" || mal "REDETECT espejo del borrado (rc $RC): fuentes $(estado 'd.sources.length'), repoint $(estado 'd.repoint' | cut -c1-120): $SALIDA"
  fi
  # (2) SIN la comprobación de salud (tercera vuelta del revisor de fallos silenciosos): arriba install sale 1 porque la
  # salud tampoco pasa. `install --from-existing` —como lo corre el aplicador— no la corre: salía 0 con la nota. «No pude
  # mirar» no es «instalado»: sale 1, con la nota. Las skills salen del clon del arnés (un solo árbol) y la fuente que no se
  # puede mirar es la que el estado todavía lista
  maquina "$BASE/redetect2" || mal "REDETECT no pude armar la segunda máquina"
  LEJOS="$LAB/far"; mkdir -p "$LEJOS/agent-skills"
  rm -f "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents"; rm -rf "$LAB_SKILLS"
  ln -s "$LAB_TREE" "$LAB_SKILLS"; ln -s "$LAB_TREE/skills" "$LAB_HOME/.claude/skills"; ln -s "$LAB_TREE/agents" "$LAB_HOME/.claude/agents"
  estado_set "d.sources.find((s)=>s.name==='agent_skills').dir='$LEJOS/agent-skills'"
  chmod 000 "$LEJOS"
  if node -e 'require("fs").realpathSync(process.argv[1])' "$LEJOS/agent-skills" >/dev/null 2>&1; then
    chmod 755 "$LEJOS"
    no_medido REDETECT "sin la salud: la carpeta sin permisos se deja resolver igual (¿corre como root?)"
  else
    SALIDA="$(harness install --from-existing 2>&1)"; RC=$?
    chmod 755 "$LEJOS"
    [ "$RC" = 1 ] && [ "$(estado 'd.sources.length')" = 2 ] && case "$SALIDA" in *"no pude mirar la fuente agent_skills"*) true ;; *) false ;; esac \
      && ok "REDETECT sin la comprobación de salud (--from-existing) y una fuente que no se pudo mirar, install sale 1 y lo dice (antes: 0)" || mal "REDETECT --from-existing (rc $RC, se esperaba 1): fuentes $(estado 'd.sources.length'): $SALIDA"
    # espejo: la carpeta ya no existe de verdad: se suelta, se dice, y sale 0
    rm -rf "$LEJOS"
    SALIDA="$(harness install --from-existing 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ "$(estado 'd.sources.length')" = 1 ] && case "$SALIDA" in *"ya no existe"*) true ;; *) false ;; esac \
      && ok "REDETECT espejo (--from-existing): con la carpeta que ya no existe, install la suelta y sale 0" || mal "REDETECT espejo --from-existing (rc $RC): fuentes $(estado 'd.sources.length'): $SALIDA"
  fi
fi

# ═══ IDENTITY · sin poder leer la identidad de los clones, la mudanza no toca nada ════════════════════════════════════
# El caso (hallazgo 2): `sameClone` contestaba «no es el mismo clon» también cuando no pudo leer la identidad (git no
# contestó a tiempo, un `.git` que no se deja leer). Con `~/.claude/agent-skills` enlazado al clon del arnés por una ruta
# que no es letra por letra la misma (otra caja, en un disco que no distingue mayúsculas), la vuelta le hacía `reset
# --hard` al clon del arnés, al commit viejo de agent-skills. Tres respuestas: mismo · distinto · no pude mirar; con «no
# pude mirar» ni la ida, ni la vuelta, ni deshacer, ni reconocer: no se toca nada, se dice, y se reintenta.
if corre IDENTITY; then
  # identity_case <etiqueta> <otra ruta al MISMO repo del arnés> <qué es esa ruta>  — el dev borra el clon viejo y enlaza
  # agent-skills (y skills/, agents/) a esa otra ruta. Mide la vuelta sin poder leer la identidad, y su espejo
  identity_case() {
    local tag="$1" other="$2" what="$3"
    rm -f "$LAB_HOME/.claude/skills" "$LAB_HOME/.claude/agents"; rm -rf "$LAB_SKILLS"
    ln -s "$other" "$LAB_SKILLS"; ln -s "$other/skills" "$LAB_HOME/.claude/skills"; ln -s "$other/agents" "$LAB_HOME/.claude/agents"
    foto_arbol "$BASE/identity/$tag-antes"
    SALIDA="$(blind_git '* rev-parse --git-common-dir *' harness startup 2>&1)"; RC=$?
    foto_arbol "$BASE/identity/$tag-despues"
    AVISO="$SALIDA $(estado 'd.notice')"
    igual "$BASE/identity/$tag-antes" "$BASE/identity/$tag-despues" && [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] && [ -f "$LAB_TREE/scripts/setup/harness.js" ] \
      && ok "IDENTITY ($what) la vuelta sin poder leer la identidad de los clones: el clon del arnés no se toca (ni reset al commit viejo, ni otro origin)" || mal "IDENTITY ($what) la vuelta tocó el clon del arnés (rc $RC): head $(head_de "$LAB_TREE") (unión $LAB_COMMIT_UNION) · $(diff "$BASE/identity/$tag-antes" "$BASE/identity/$tag-despues" | head -6): $SALIDA"
    case "$AVISO" in *"no pude mirar si"*"clon del arnés"*"git de laboratorio"*) ok "IDENTITY ($what) …y lo dice, con la causa" ;; *) mal "IDENTITY ($what) el aviso no dice que no pudo mirar: $AVISO" ;; esac
    [ "$(estado 'd.repoint.blocked.transient')" = true ] && [ "$(estado 'd.repoint.applied.from.url')" = "$LAB_REMOTE_SKILLS" ] \
      && ok "IDENTITY ($what) …es pasajero (se reintenta en el arranque siguiente) y lo anotado de la mudanza queda" || mal "IDENTITY ($what) estado: $(estado 'd.repoint' | cut -c1-240)"
    DOCTOR="$(blind_git '* rev-parse --git-common-dir *' harness doctor 2>&1)"
    case "$DOCTOR" in *"no pude mirar si"*"clon del arnés"*) ok "IDENTITY ($what) …y doctor también lo dice" ;; *) mal "IDENTITY ($what) doctor no lo dice: $(printf '%s' "$DOCTOR" | grep -i 'agent-skills' | head -4)" ;; esac
    # espejo: con git contestando, la identidad se lee: es el mismo repo, y tampoco se toca (la causa de siempre)
    SALIDA="$(harness startup 2>&1)"; RC=$?
    foto_arbol "$BASE/identity/$tag-despues2"
    igual "$BASE/identity/$tag-antes" "$BASE/identity/$tag-despues2" && case "$(estado 'd.notice')" in *"ya no es un clon aparte"*) true ;; *) false ;; esac \
      && ok "IDENTITY ($what) espejo: con git contestando, es el mismo repo (mismo .git): no se toca y se dice" || mal "IDENTITY ($what) espejo (rc $RC): $(diff "$BASE/identity/$tag-antes" "$BASE/identity/$tag-despues2" | head -6) · aviso $(estado 'd.notice'): $SALIDA"
  }
  # (1) un árbol de trabajo enlazado del clon del arnés (`git worktree`): otra ruta, el mismo .git. No depende del disco:
  #     se mide en cualquier máquina (tercera vuelta del revisor de pruebas: antes sólo se medía con mayúsculas)
  maquina "$BASE/identity" || mal "IDENTITY no pude armar la máquina del equipo después del corte"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "IDENTITY precondición: la máquina no quedó re-apuntada"
  WT="$LAB/clones/harness-worktree"
  tr_ worktree add -q --detach "$WT" HEAD >/dev/null 2>&1 && [ -f "$WT/scripts/setup/harness.js" ] || mal "IDENTITY no pude armar el árbol de trabajo enlazado del clon del arnés"
  identity_case worktree "$WT" "árbol de trabajo enlazado"
  # (2) la misma carpeta escrita con otra caja (el caso original): sólo en un disco que no distingue mayúsculas
  maquina "$BASE/identity2" || mal "IDENTITY no pude armar la segunda máquina"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "IDENTITY precondición: la segunda máquina no quedó re-apuntada"
  ALIAS="$(dirname "$LAB_TREE")/$(basename "$LAB_TREE" | tr '[:lower:]' '[:upper:]')"
  if [ "$ALIAS" = "$LAB_TREE" ] || [ ! "$ALIAS" -ef "$LAB_TREE" ]; then
    no_medido IDENTITY "la misma carpeta con otra caja: este disco distingue mayúsculas (el árbol de trabajo enlazado sí se midió)"
  else
    identity_case case "$ALIAS" "otra caja"
  fi
fi

# ═══ HIDDEN · sin poder contar lo que la vista oculta, la vuelta no dice «muestra todo» ═══════════════════════════════
# El caso (hallazgo 3): si `git ls-files -t` fallaba, lo oculto se contaba como 0: la vuelta salteaba volver a mostrar y
# decía «muestra todo otra vez» sin saberlo. Ahora es una falla con su causa: la mudanza queda a medias y el arranque
# siguiente la termina.
if corre HIDDEN; then
  maquina "$BASE/hidden" || mal "HIDDEN no pude armar la máquina del equipo después del corte"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(sk ls-files -t | grep -c '^S ')" -gt 0 ] || mal "HIDDEN precondición: la máquina no quedó re-apuntada con la vista reducida"
  SALIDA="$(blind_git '* ls-files -t *' harness startup 2>&1)"; RC=$?
  AVISO="$SALIDA $(estado 'd.notice')"
  case "$AVISO" in *"muestra todo"*) mal "HIDDEN sin poder contar lo oculto, la vuelta dijo que muestra todo: $AVISO" ;; *"no pude"*"oculta"*"git de laboratorio"*) ok "HIDDEN sin poder contar lo oculto, la vuelta no dice «muestra todo»: dice que no pudo mirarlo, con la causa" ;; *) mal "HIDDEN la vuelta no dijo por qué no terminó (rc $RC): $AVISO" ;; esac
  [ "$(estado 'd.repoint.pending.step')" = back ] && ok "HIDDEN …y la mudanza queda a medias en el estado (la termina el arranque siguiente)" || mal "HIDDEN estado: $(estado 'd.repoint' | cut -c1-240)"
  # espejo: con git contestando, el arranque siguiente termina la vuelta y el clon muestra todo de verdad
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(sk ls-files -t | grep -c '^S ')" = 0 ] && [ "$(estado 'd.repoint')" = null ] \
    && ok "HIDDEN espejo: con git contestando, el arranque siguiente termina la vuelta y el clon muestra todo" || mal "HIDDEN espejo (rc $RC): origin $(origen_de "$LAB_SKILLS"), ocultos $(sk ls-files -t | grep -c '^S '), repoint $(estado 'd.repoint' | cut -c1-200): $SALIDA"
  # la OTRA puerta (tercera vuelta del revisor de pruebas): la vista apagada a mano con archivos todavía ocultos. Ahí se
  # cuenta lo oculto ANTES de decidir si hay que volver a mostrar; sin poder contarlo, tampoco se da la vuelta por terminada.
  # Falla sólo ESA cuenta (la primera): la de después contestaría, y sin esta puerta la vuelta seguiría sin mostrar nada
  maquina "$BASE/hidden2" || mal "HIDDEN no pude armar la segunda máquina"
  con_llave harness startup >/dev/null 2>&1
  sk config core.sparseCheckout false
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] && [ "$(sk config --type=bool --get core.sparseCheckout)" = false ] && [ "$(sk ls-files -t | grep -c '^S ')" -gt 0 ] \
    || mal "HIDDEN precondición: la segunda máquina no quedó re-apuntada con la vista apagada y archivos ocultos"
  SALIDA="$(blind_git_once '* ls-files -t *' harness startup 2>&1)"; RC=$?
  AVISO="$SALIDA $(estado 'd.notice')"
  case "$AVISO" in *"muestra todo"*) mal "HIDDEN (vista apagada a mano) sin poder contar lo oculto, la vuelta dijo que muestra todo: $AVISO" ;; *"no pude"*"oculta"*"git de laboratorio"*) ok "HIDDEN (vista apagada a mano) sin poder contar lo oculto, la vuelta no dice «muestra todo»: dice que no pudo mirarlo, con la causa" ;; *) mal "HIDDEN (vista apagada a mano) la vuelta no dijo por qué no terminó (rc $RC): $AVISO" ;; esac
  [ "$(estado 'd.repoint.pending.step')" = back ] && ok "HIDDEN (vista apagada a mano) …y la mudanza queda a medias en el estado" || mal "HIDDEN (vista apagada a mano) estado: $(estado 'd.repoint' | cut -c1-240)"
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(sk ls-files -t | grep -c '^S ')" = 0 ] && [ "$(estado 'd.repoint')" = null ] \
    && ok "HIDDEN (vista apagada a mano) espejo: con git contestando, la vuelta vuelve a mostrar lo oculto y termina" || mal "HIDDEN (vista apagada a mano) espejo (rc $RC): origin $(origen_de "$LAB_SKILLS"), ocultos $(sk ls-files -t | grep -c '^S '), repoint $(estado 'd.repoint' | cut -c1-200): $SALIDA"
fi

# ═══ POP · lo apartado en un stash que no se pudo reaplicar se dice ══════════════════════════════════════════════════
# El caso (hallazgo 4): en los caminos de error de `advance` (el merge falló) y de `revert` (el reset falló) se reaplicaba
# lo local del stash propio sin mirar el resultado: si los dos intentos fallaban, lo del dev quedaba en el stash sin aviso.
# No se pierde nada, pero hay que decirlo, con el comando para verlo.
if corre POP; then
  # (1) advance: la actualización de todos los días, con un cambio del dev sin commitear en el clon de skills
  maquina "$BASE/pop" || mal "POP no pude armar la máquina del equipo después del corte"
  ARCH="$(sk ls-files | grep -v '^\.' | head -1)"
  printf 'un cambio del dev sin commitear\n' >> "$LAB_SKILLS/$ARCH"
  harness_lab_publish skills "una versión nueva de las skills" skills/tycon-pipeline/POP.md "pop"
  SALIDA="$(blind_git '* merge -q --ff-only refs/remotes/origin/*|* stash pop *' harness update 2>&1)"; RC=$?
  [ "$RC" != 0 ] && case "$SALIDA" in *"stash list"*) true ;; *) false ;; esac \
    && ok "POP advance: el merge y la reaplicación fallaron: update lo dice, nombrando stash list" || mal "POP advance (rc $RC) no dice dónde quedó lo del dev: $SALIDA"
  sk stash show -p 'stash@{0}' 2>/dev/null | grep 'un cambio del dev sin commitear' >/dev/null \
    && ok "POP advance: …y lo del dev está en el stash (no se perdió nada)" || mal "POP advance: lo del dev no está en el stash: $(sk stash list)"
  # espejo: si sólo falla el merge, lo del dev vuelve al árbol de trabajo y no se habla de ningún stash
  sk stash pop -q >/dev/null 2>&1
  SALIDA="$(blind_git '* merge -q --ff-only refs/remotes/origin/*' harness update 2>&1)"; RC=$?
  grep -q 'un cambio del dev sin commitear' "$LAB_SKILLS/$ARCH" && case "$SALIDA" in *"stash list"*) false ;; *) true ;; esac \
    && ok "POP advance espejo: con la reaplicación bien, lo del dev vuelve a su lugar y no se nombra ningún stash" || mal "POP advance espejo (rc $RC): $(sk status --porcelain | head -3): $SALIDA"
  # (2) revert: la vuelta de la llave, con un cambio del dev sin commitear en el clon re-apuntado
  maquina "$BASE/pop2" || mal "POP no pude armar la segunda máquina"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "POP precondición: la segunda máquina no quedó re-apuntada"
  printf 'otro cambio del dev sin commitear\n' >> "$LAB_SKILLS/README.md"
  SALIDA="$(blind_git '* reset -q --hard *|* stash pop *' harness startup 2>&1)"; RC=$?
  AVISO="$SALIDA $(estado 'd.notice')"
  case "$AVISO" in *"stash list"*) ok "POP revert: el reset y la reaplicación fallaron: la vuelta lo dice, nombrando stash list" ;; *) mal "POP revert (rc $RC) no dice dónde quedó lo del dev: $AVISO" ;; esac
  sk stash show -p 'stash@{0}' 2>/dev/null | grep 'otro cambio del dev sin commitear' >/dev/null \
    && ok "POP revert: …y lo del dev está en el stash (no se perdió nada)" || mal "POP revert: lo del dev no está en el stash: $(sk stash list)"
  # espejo (tercera vuelta del revisor de pruebas): si sólo falla el reset, lo del dev vuelve a su lugar y no se nombra
  # ningún stash
  maquina "$BASE/pop3" || mal "POP no pude armar la tercera máquina"
  con_llave harness startup >/dev/null 2>&1
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "POP precondición: la tercera máquina no quedó re-apuntada"
  printf 'otro cambio del dev sin commitear\n' >> "$LAB_SKILLS/README.md"
  STASH0="$(sk stash list --format='%H')"
  SALIDA="$(blind_git '* reset -q --hard *' harness startup 2>&1)"; RC=$?
  AVISO="$SALIDA $(estado 'd.notice')"
  # que el reset de verdad falló (vuelta 4 del revisor de pruebas): la vuelta no pasó, así que el clon sigue en el repo
  # unificado; sin esto, una vuelta que saliera bien también daba verde
  [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] || mal "POP revert espejo: el reset no falló (el clon volvió al repo viejo): el caso no ejerció nada"
  grep -q 'otro cambio del dev sin commitear' "$LAB_SKILLS/README.md" && [ "$(sk stash list --format='%H')" = "$STASH0" ] && case "$AVISO" in *"stash list"*) false ;; *) true ;; esac \
    && ok "POP revert espejo: con la reaplicación bien, lo del dev vuelve a su lugar, no queda en ningún stash y no se nombra ninguno" || mal "POP revert espejo (rc $RC): $(sk status --porcelain | head -3) · stash $(sk stash list | grep -c .): $AVISO"
fi

# ═══ PARTIAL · deshacer una ida en curso no da por limpio lo que no pudo listar ═══════════════════════════════════════
# La misma clase, en `restorePartial` (lo encontró este arreglo): para limpiar un merge que murió a medias se listan las
# rutas que cambian entre el commit de antes y el de destino; si git no podía listarlas, se leía como «el merge ni
# empezó» y la mudanza se daba por deshecha. Ahora queda en curso, se dice, y el arranque siguiente la termina.
if corre PARTIAL; then
  maquina "$BASE/partial" || mal "PARTIAL no pude armar la máquina del equipo después del corte"
  # el destino de la ida: la unión más un archivo NUEVO en la vista (skills/lab-partial/NEW.md), armado en un clon aparte
  # (no toca los remotos) y traído al clon de skills. Una ida que se cortó en el merge: HEAD sigue en el commit de antes
  ORIGEN_P="$LAB/partial-source"
  { harness_lab_git "$LAB" clone -q "$LAB_REMOTE_TREE" "$ORIGEN_P" && harness_lab_git "$ORIGEN_P" checkout -q -b lab/partial "$LAB_COMMIT_UNION" \
    && mkdir -p "$ORIGEN_P/skills/lab-partial" && printf 'nuevo de la versión\n' > "$ORIGEN_P/skills/lab-partial/NEW.md" \
    && harness_lab_git "$ORIGEN_P" add -A && harness_lab_git "$ORIGEN_P" commit -q -m "la unión, con un archivo nuevo en la vista"; } >/dev/null 2>&1 || mal "PARTIAL no pude armar el destino de la ida"
  DEST="$(head_de "$ORIGEN_P")"
  sk fetch -q "$ORIGEN_P" lab/partial >/dev/null 2>&1
  ACA="$(sk rev-parse HEAD)"; RM="$(sk rev-parse -q --verify refs/remotes/origin/main)"; PREV="$(sk rev-parse -q --verify refs/tycon/previous/agent_skills)"
  [ -n "$PREV" ] && PREV="'$PREV'" || PREV=null
  en_curso() { estado_set "d.repoint={pending:{step:'forward',at:'2026-10-04T00:00:00Z',from:{url:'$LAB_REMOTE_SKILLS',commit:'$ACA',remote_main:'$RM',previous_ref:$PREV},to:{url:'$LAB_REMOTE_UNIFIED',commit:'$DEST'}}}"; }
  # lo que el merge dejó escrito a medias: README.md (la versión lo cambia) con un contenido que no es el de ninguna de las
  # dos, y el archivo nuevo de la versión
  A_MEDIAS='contenido a medias, que nadie más tiene'
  a_medias() { printf '%s\n' "$A_MEDIAS" > "$LAB_SKILLS/README.md"; mkdir -p "$LAB_SKILLS/skills/lab-partial"; printf 'nuevo de la versión\n' > "$LAB_SKILLS/skills/lab-partial/NEW.md"; }
  # partial_blind <etiqueta> <patrones de blind_git> <lo que el aviso tiene que decir (patrón de case, sin comillas)>  — una puerta de
  # «no pude mirar»: la ida en curso no se da por deshecha, ningún archivo se toca, y se dice con la causa
  partial_blind() {
    local tag="$1" pats="$2" want="$3"
    en_curso; a_medias
    SALIDA="$(blind_git "$pats" harness startup 2>&1)"; RC=$?
    AVISO="$SALIDA $(estado 'd.notice')"
    local said=0; case "$AVISO" in $want) said=1 ;; esac
    [ "$(estado 'd.repoint.pending.step')" = forward ] && [ "$said" = 1 ] && [ "$(cat "$LAB_SKILLS/README.md")" = "$A_MEDIAS" ] && [ -f "$LAB_SKILLS/skills/lab-partial/NEW.md" ] \
      && ok "PARTIAL ($tag): la ida en curso no se da por deshecha, no se pisa ni se borra ningún archivo, y se dice con la causa" \
      || mal "PARTIAL ($tag) (rc $RC): repoint $(estado 'd.repoint' | cut -c1-120) · README «$(head -1 "$LAB_SKILLS/README.md")» · NEW.md $([ -f "$LAB_SKILLS/skills/lab-partial/NEW.md" ] && echo está || echo BORRADO) · aviso: $(printf '%s' "$AVISO" | cut -c1-300)"
  }
  partial_blind "no pudo mirar si el destino está en el clon" "* rev-parse --verify -q $DEST^{commit}*" '*no pude mirar si el commit al que iba la ida*'
  partial_blind "no pudo listar lo que cambia" '* diff --no-renames --name-status *' '*no pude listar lo que cambia*'
  partial_blind "no pudo mirar lo modificado" '* diff --no-renames --name-only -z HEAD*' '*no pude mirar lo modificado*'
  # las dos lecturas que comparan un archivo con la versión nueva (tercera vuelta del revisor de fallos silenciosos): si
  # fallaban las DOS, «vacío == vacío» daba iguales, y la limpieza pisaba README.md y borraba NEW.md; si fallaba una sola,
  # daba distintos, salteaba el archivo y daba la ida por deshecha con lo de la versión nueva todavía en el disco
  partial_blind "no pudo leer el archivo del disco" '* hash-object *' '*no pude leer*del disco*'
  partial_blind "no pudo leer el archivo de la versión nueva" "* rev-parse --verify -q $DEST:*" '*no pude leer*de la versión nueva*'
  partial_blind "no pudo leer ninguna de las dos" "* hash-object *|* rev-parse --verify -q $DEST:*" '*no pude leer*'
  # «¿está en el disco?» no se contesta con `existsSync`: con un error de permisos decía «no está» y salteaba el archivo
  en_curso; a_medias; chmod 000 "$LAB_SKILLS/skills/lab-partial"
  if [ -r "$LAB_SKILLS/skills/lab-partial" ]; then
    chmod 755 "$LAB_SKILLS/skills/lab-partial"
    no_medido PARTIAL "la carpeta sin permisos se deja leer igual (¿corre como root?)"
  else
    SALIDA="$(harness startup 2>&1)"; RC=$?
    chmod 755 "$LAB_SKILLS/skills/lab-partial"
    AVISO="$SALIDA $(estado 'd.notice')"
    [ "$(estado 'd.repoint.pending.step')" = forward ] && [ -f "$LAB_SKILLS/skills/lab-partial/NEW.md" ] && case "$AVISO" in *"no pude mirar si skills/lab-partial/NEW.md está en el disco"*) true ;; *) false ;; esac \
      && ok "PARTIAL (no pudo mirar si el archivo está en el disco: sin permisos): la ida en curso no se da por deshecha, y se dice" \
      || mal "PARTIAL (sin permisos) (rc $RC): repoint $(estado 'd.repoint' | cut -c1-120) · aviso: $(printf '%s' "$AVISO" | cut -c1-300)"
  fi
  # espejo: con git contestando, el arranque siguiente la deshace: el archivo nuevo de la versión se va, lo que no es de la
  # versión nueva (README.md a medias) queda, y el clon queda como estaba
  en_curso; a_medias
  SALIDA="$(harness startup 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(estado 'd.repoint')" = null ] && [ "$(sk rev-parse HEAD)" = "$ACA" ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_SKILLS" ] && [ "$(sk rev-parse -q --verify refs/remotes/origin/main)" = "$RM" ] \
    && [ ! -e "$LAB_SKILLS/skills/lab-partial/NEW.md" ] && [ "$(cat "$LAB_SKILLS/README.md")" = "$A_MEDIAS" ] \
    && ok "PARTIAL espejo: con git contestando, el arranque siguiente la deshace: saca lo de la versión nueva, deja lo demás, y el clon queda como estaba" || mal "PARTIAL espejo (rc $RC): repoint $(estado 'd.repoint' | cut -c1-160), head $(sk rev-parse HEAD), NEW.md $([ -e "$LAB_SKILLS/skills/lab-partial/NEW.md" ] && echo quedó || echo no): $SALIDA"
  # espejo de la rama que restaura (vuelta 4 del revisor de fallos silenciosos): un archivo que el merge alcanzó a
  # escribir con el contenido de la versión nueva vuelve al de HEAD (`checkout -f`); sin este caso esa rama no corría
  en_curso; a_medias
  sk show "$DEST:README.md" > "$LAB_SKILLS/README.md" 2>/dev/null
  if [ "$(sk hash-object README.md)" = "$(sk rev-parse -q --verify "$ACA:README.md")" ]; then
    mal "PARTIAL espejo (restaura): la versión nueva no cambia README.md: el caso no ejercería la restauración"
  else
    SALIDA="$(harness startup 2>&1)"; RC=$?
    [ "$RC" = 0 ] && [ "$(estado 'd.repoint')" = null ] && [ "$(sk hash-object README.md)" = "$(sk rev-parse -q --verify "$ACA:README.md")" ] && [ ! -e "$LAB_SKILLS/skills/lab-partial/NEW.md" ] \
      && ok "PARTIAL espejo (restaura): un archivo que quedó con el contenido de la versión nueva vuelve al de HEAD" \
      || mal "PARTIAL espejo (restaura) (rc $RC): repoint $(estado 'd.repoint' | cut -c1-120) · README $(sk status --porcelain README.md): $(printf '%s' "$SALIDA" | cut -c1-200)"
  fi
fi

# ═══ CONTAINS · «no pude comparar» no es «todavía no lo contiene» ════════════════════════════════════════════════════
# El caso (hallazgo 5): `update` a mano con el freno «no avanza en línea recta» mira si lo publicado del repo unificado ya
# contiene el commit del clon de skills. Si git no pudo compararlos, lo informaba como «todavía no lo contiene».
if corre CONTAINS; then
  maquina "$BASE/contains" || mal "CONTAINS no pude armar la máquina del equipo después del corte"
  harness_lab_publish skills "un PR tardío en el repo viejo, después de la unión"
  harness update >/dev/null 2>&1
  TARDIO="$(head_de "$LAB_SKILLS")"
  [ "$TARDIO" != "$LAB_COMMIT_SKILLS" ] || mal "CONTAINS precondición: el clon viejo no bajó el commit tardío"
  # el repo unificado ya lo arregló: mergea el commit tardío y publica
  harness_lab_git "$LAB_AUTHOR_TREE" pull -q --ff-only origin main
  harness_lab_git "$LAB_AUTHOR_TREE" fetch -q "$LAB_REMOTE_SKILLS" refs/heads/main
  harness_lab_git "$LAB_AUTHOR_TREE" merge -q --no-ff -m "unión: entra el PR tardío del repo viejo" FETCH_HEAD
  harness_lab_git "$LAB_AUTHOR_TREE" push -q origin main
  foto "$BASE/contains/antes"
  SALIDA="$(blind_git '* -C */clones/harness merge-base *' con_llave harness update 2>&1)"; RC=$?
  foto "$BASE/contains/despues"
  [ "$RC" = 2 ] && igual "$BASE/contains/antes" "$BASE/contains/despues" && [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] \
    && ok "CONTAINS sin poder comparar, update a mano sale 2 y no mueve ninguna fuente" || mal "CONTAINS (rc $RC): arnés $(head_de "$LAB_TREE") · $(diff "$BASE/contains/antes" "$BASE/contains/despues" | head -6): $SALIDA"
  case "$SALIDA" in *"todavía no contiene"*) mal "CONTAINS sin poder comparar dijo «todavía no contiene»: $SALIDA" ;; *"no pude comparar"*"git de laboratorio"*) ok "CONTAINS …y dice que no pudo comparar, con la causa (no «todavía no lo contiene»)" ;; *) mal "CONTAINS no dice que no pudo comparar: $SALIDA" ;; esac
  # las otras tres ramas de «no pude mirar» de `unblockStraightLine` (tercera vuelta del revisor de pruebas), una por una:
  # no pudo traer lo publicado · no pudo leer el HEAD del clon de skills · no pudo mirar si el commit del clon está en el
  # clon del arnés. Las dos últimas leen algo que el comando ya leyó antes: fallan recién después de traer el arnés
  # contains_blind <etiqueta> <patrón que arma (o vacío)> <patrones> <lo que tiene que decir (patrón de case, sin comillas)>
  contains_blind() {
    local tag="$1" arm="$2" pats="$3" want="$4" said=0
    foto "$BASE/contains/$tag-antes"
    if [ -n "$arm" ]; then SALIDA="$(blind_git_after "$arm" "$pats" con_llave harness update 2>&1)"; RC=$?
    else SALIDA="$(blind_git "$pats" con_llave harness update 2>&1)"; RC=$?; fi
    foto "$BASE/contains/$tag-despues"
    case "$SALIDA" in *"todavía no contiene"*) said=0 ;; $want) said=1 ;; esac
    [ "$RC" = 2 ] && [ "$said" = 1 ] && igual "$BASE/contains/$tag-antes" "$BASE/contains/$tag-despues" && [ "$(head_de "$LAB_TREE")" = "$LAB_COMMIT_UNION" ] \
      && ok "CONTAINS ($tag): update a mano sale 2, no mueve ninguna fuente, y dice que no pudo mirar con la causa" \
      || mal "CONTAINS ($tag) (rc $RC): arnés $(head_de "$LAB_TREE") · $(diff "$BASE/contains/$tag-antes" "$BASE/contains/$tag-despues" | head -4): $(printf '%s' "$SALIDA" | cut -c1-400)"
  }
  TRAER='* -C */clones/harness fetch -q origin *'
  contains_blind "no pudo traer" '' "$TRAER" '*no pude mirar si lo publicado del arnés ya contiene*git de laboratorio*'
  contains_blind "no pudo leer HEAD" "$TRAER" '* -C */.claude/agent-skills rev-parse HEAD *' '*no pude mirar si lo publicado*no pude leer HEAD de*'
  contains_blind "no pudo mirar el commit" "$TRAER" "* -C */clones/harness rev-parse --verify -q $TARDIO^{commit}*" '*no pude comparar*git de laboratorio*'
  # espejo: con git contestando, el mismo comando trae el arnés y re-apunta
  SALIDA="$(con_llave harness update 2>&1)"; RC=$?
  [ "$RC" = 0 ] && [ "$(head_de "$LAB_SKILLS")" = "$(head_de "$LAB_TREE")" ] && [ "$(origen_de "$LAB_SKILLS")" = "$LAB_REMOTE_UNIFIED" ] \
    && ok "CONTAINS espejo: con git contestando, update a mano trae el arnés y re-apunta" || mal "CONTAINS espejo (rc $RC): arnés $(head_de "$LAB_TREE") skills $(head_de "$LAB_SKILLS"): $SALIDA"
fi

# ═══ GUARD · la suite no corre nada sobre la HOME de verdad ════════════════════════════════════════════════════════════
# El caso (segunda vuelta del revisor de seguridad): si armar la máquina falla antes de que el laboratorio tome la HOME,
# las secciones seguían y corrían `harness startup` y el remedio del aviso sobre la ~/.claude de verdad.
# sólo la corre GUARD (con LAB_SELF_CHECK=1): una sección que no mide nada, para ver qué dice el cierre
if [ "${LAB_SELF_CHECK:-}" = 1 ] && [ "$ONLY" = UNMEASURED ]; then no_medido UNMEASURED "la sección de control de GUARD"; fi
if corre GUARD; then
  ( HOME="/tmp/no-es-el-laboratorio"; lab_guard ) >/dev/null 2>&1 && mal "GUARD con la HOME fuera del laboratorio, lab_guard no cortó" \
    || ok "GUARD con la HOME fuera del laboratorio, lab_guard corta la suite"
  ( HOME="$BASE/una/home"; lab_guard ) >/dev/null 2>&1 && ok "GUARD espejo: con la HOME del laboratorio, sigue" || mal "GUARD espejo: con la HOME del laboratorio, cortó igual"
  # que se USE (tercera vuelta del revisor de pruebas): (1) por lectura, ningún armado de laboratorio fuera de lab_team y
  # lab_single; (2) por ejecución, cada sección con el armado roto a propósito ANTES de tomar la HOME corta en rojo, sin
  # seguir. La HOME de esas corridas es una carpeta de juguete fuera de su laboratorio: si alguna siguiera, no toca nada real
  SUELTOS="$(grep -nE 'harness_lab_(team_machine|single_tree|shape)\b' "$RAIZ/scripts/tests/harness-repoint.test.sh" | grep -v '^[0-9]*: *#' | grep -v 'lab:wrapper')"
  [ -z "$SUELTOS" ] && ok "GUARD por lectura: todo armado de laboratorio pasa por lab_team o lab_single (y así por lab_guard)" || mal "GUARD por lectura: armados que no pasan por lab_guard: $(printf '%s' "$SUELTOS" | cut -c1-90 | tr '\n' '|')"
  mkdir -p "$BASE/guard-home"; SIN_CORTE=""
  for S in T32 T34 CRASH T33 T35 LINK ADOPT REAL SAME VIEW BACK STATE NFF ARGS REDETECT IDENTITY HIDDEN POP PARTIAL CONTAINS; do
    HOME="$BASE/guard-home" LAB_BREAK_BEFORE_HOME=1 bash "$RAIZ/scripts/tests/harness-repoint.test.sh" --only "$S" > "$BASE/guard-$S.out" 2>&1; RC=$?
    { [ "$RC" = 1 ] && grep -q 'la HOME no es la del laboratorio' "$BASE/guard-$S.out" && ! grep -q '  ok   — ' "$BASE/guard-$S.out"; } || SIN_CORTE="$SIN_CORTE $S(rc $RC)"
  done
  # y el cierre: una corrida con un caso sin medir no dice «todo verde» (sale 0: no es una falla del código)
  SALIDA="$(LAB_SELF_CHECK=1 bash "$RAIZ/scripts/tests/harness-repoint.test.sh" --only UNMEASURED 2>&1)"; RC=$?
  [ "$RC" = 0 ] && case "$SALIDA" in *"todo verde"*) false ;; *"1 caso(s) NO MEDIDO"*) true ;; *) false ;; esac \
    && ok "GUARD el cierre cuenta lo NO MEDIDO: con un caso sin medir sale 0 y no dice «todo verde»" || mal "GUARD el cierre con un caso sin medir (rc $RC): $SALIDA"
  [ -z "$SIN_CORTE" ] && [ -z "$(ls -A "$BASE/guard-home")" ] \
    && ok "GUARD por ejecución: con el armado roto antes de tomar la HOME, las 20 secciones cortan en rojo sin seguir, y la HOME de afuera queda intacta" \
    || mal "GUARD por ejecución: no cortaron:${SIN_CORTE:- (todas cortaron)} · en la HOME de afuera: $(ls -A "$BASE/guard-home" | tr '\n' ' ')"
fi

echo "harness-repoint: $(( $(date +%s) - T_INICIO )) s"
# «todo verde» sólo si se midió todo. Con algo sin medir y sin fallos sale 0 —una máquina que no deja medir un caso no
# es una falla del código—, pero el cierre lo cuenta y no lo llama verde
if [ "$FALLOS" = 0 ] && [ "$NO_MEDIDOS" = 0 ]; then echo "✅ harness-repoint: todo verde"; exit 0; fi
if [ "$FALLOS" = 0 ]; then echo "⚠️  harness-repoint: sin fallos, pero $NO_MEDIDOS caso(s) NO MEDIDO (arriba, con «⏭»): no está todo medido"; exit 0; fi
echo "❌ harness-repoint: $FALLOS fallo(s)$([ "$NO_MEDIDOS" = 0 ] || echo " y $NO_MEDIDOS caso(s) NO MEDIDO")"; exit 1
