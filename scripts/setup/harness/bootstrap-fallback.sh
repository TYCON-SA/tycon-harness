#!/usr/bin/env bash
# bootstrap-fallback.sh — el RESPALDO en shell del arranque del arnés. Vive en
# ~/.claude/.tycon-pipeline/harness/, fuera del árbol; la línea de arranque lo corre cuando bootstrap.js no sale 0
# (harness.js roto, enlace colgado, árbol ausente, node por debajo del piso, startup que falló).
#
# Hace lo mismo que la línea de arranque de un clon: `git pull --ff-only --autostash --quiet` en el lugar del arnés y en
# ~/.claude/agent-skills (si existen), y después el aplicador (install-tycon-hooks.sh). Si el enlace no resuelve, usa el
# árbol que dice el estado. Todo silencioso: una sesión nunca se frena ni se ensucia por el arnés. Deja UNA línea en
# startup.log y, si hay node, el aviso en `notice` del estado (un `node -e` mínimo que lee y escribe el JSON).
#
# Sale 0 siempre. Doctrina: lo durable no viaja por el camino roto — este archivo no depende del árbol para arrancar.
set +e
# git nunca pregunta nada desde acá: ni la terminal ni el gestor de credenciales (un login invisible dejaría al arranque
# esperando hasta el tope del hook)
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
H="${HOME:-$(cd ~ 2>/dev/null && pwd)}"
# dónde vive el estado: una máquina sin Claude Code vive entera en la casa propia del arnés
# (~/.tycon, o TYCON_HOME) y su estado es <casa>/state. La regla de tycon-home.js, escrita acá: si esa carpeta existe,
# es ésa; si no, la de siempre.
OWN="${TYCON_HOME:-$H/.tycon}"
PIPE="$H/.claude/.tycon-pipeline"
[ -d "$OWN/state" ] && PIPE="$OWN/state"
HDIR="$PIPE/harness"; LOG="$HDIR/startup.log"; STATE="$PIPE/harness-state.json"
SKILLS="$H/.claude/agent-skills"
# los dos nombres del lugar del arnés: primero el lugar, después el viejo; bajo HOME y, en Windows con
# HOME en otra carpeta, bajo USERPROFILE. Escritos acá: esta copia fija no carga nada del árbol (copia declarada en
# scripts/tests/fixtures/harness-place-names.json)
LINK="$H/.claude/tycon-harness"
LINK_TREE=""
for _base in "$H" "${USERPROFILE:-}"; do
  [ -n "$_base" ] || continue
  if command -v cygpath >/dev/null 2>&1; then _base="$(cygpath -u "$_base" 2>/dev/null || printf '%s' "$_base")"; fi
  for _name in tycon-harness tycon-claude-guides; do
    if [ -z "$LINK_TREE" ] && [ -d "$_base/.claude/$_name/" ] && [ -f "$_base/.claude/$_name/scripts/install-tycon-hooks.sh" ]; then LINK_TREE="$_base/.claude/$_name"; fi
  done
done
mkdir -p "$HDIR" 2>/dev/null
[ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')" -gt 1048576 ] 2>/dev/null && mv -f "$LOG" "$LOG.1" 2>/dev/null

# ── la versión BAJADA: sin git y sin Node en este camino ─────────────────────────
# Si el estado dice `kind: release`, el árbol es ~/.tycon/harness (o TYCON_HOME/harness) y acá no hay pull: un cambio
# de versión cortado a mitad se repara desde su diario (swap.json, leído con sed), y si harness.js no arranca y hay una
# versión anterior (previous/), se vuelve a ella (la rota queda apartada en trash/) y se corre su aplicador; sin
# previous/, queda el aviso con el comando. Nunca se baja nada desde acá. (`OWN`, la casa propia, se definió arriba.)
RELEASE=""
if [ -f "$STATE" ] && grep -q '"kind":[[:space:]]*"release"' "$STATE" 2>/dev/null; then RELEASE=1; fi
# un campo de texto del diario, esté en una línea o en varias (cada coma o llave corta la línea antes de buscar)
jfield() { tr ',{}' '\n\n\n' < "$OWN/swap.json" 2>/dev/null | sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }
repaired=""
if [ -f "$OWN/swap.json" ]; then
  _stage="$(jfield stage)"; _incoming="$(jfield incoming)"; _aside="$(jfield aside)"
  case "$_stage" in
    harness-out|start|previous-cleared)
      # «start» y «previous-cleared» se escriben ANTES del rename harness → previous: con harness/ ausente, es lo mismo
      if [ ! -d "$OWN/harness" ] && [ -n "$_incoming" ] && [ -d "$_incoming" ]; then mv "$_incoming" "$OWN/harness" 2>/dev/null && repaired="completó el cambio (incoming → harness)"
      elif [ ! -d "$OWN/harness" ] && [ -d "$OWN/previous" ]; then mv "$OWN/previous" "$OWN/harness" 2>/dev/null && repaired="deshizo el cambio (previous → harness)"
      else repaired="harness/ ya estaba"; fi ;;
    back-start|back-harness-out)
      _why="$(jfield why)"
      if [ ! -d "$OWN/harness" ] && [ -d "$OWN/previous" ]; then
        if mv "$OWN/previous" "$OWN/harness" 2>/dev/null; then
          repaired="completó la vuelta atrás (previous → harness)"
          # un rollback deja la deshecha como previous/ (AC 15)
          [ "$_why" = rollback ] && [ -n "$_aside" ] && [ -d "$_aside" ] && [ ! -d "$OWN/previous" ] && mv "$_aside" "$OWN/previous" 2>/dev/null
        else repaired="no pude mover previous → harness; queda para el próximo arranque"; fi
      elif [ ! -d "$OWN/harness" ] && [ -n "$_aside" ] && [ -d "$_aside" ]; then mv "$_aside" "$OWN/harness" 2>/dev/null && repaired="recuperó la versión activa" || repaired="no pude recuperar la versión activa; queda para el próximo arranque"
      else repaired="harness/ ya estaba"; fi ;;
    back-previous-in)
      if [ ! -d "$OWN/previous" ] && [ -n "$_aside" ] && [ -d "$_aside" ]; then mv "$_aside" "$OWN/previous" 2>/dev/null && repaired="la deshecha quedó como previous/" || repaired="la deshecha no pudo quedar como previous/"
      else repaired="la vuelta atrás ya estaba completa"; fi ;;
    *) repaired="diario en «${_stage:-?}» sin nada a medias" ;;
  esac
  [ -d "$OWN/harness" ] && rm -f "$OWN/swap.json" 2>/dev/null
fi

# el árbol: el lugar (o el nombre viejo) si resuelve; si no, el `tree` del estado
TREE=""; why=""
if [ -n "$RELEASE" ]; then
  TREE="$OWN/harness"
  # harness.js que no arranca (es por lo que corre este respaldo): vuelve a previous/ si la hay. Sin node en el PATH no se
  # sabe si está roto —y bootstrap.js no corrió por eso—: no se vuelve a nada, se dice
  if ! command -v node >/dev/null 2>&1; then
    why="node no está en el PATH: no puedo saber si harness.js arranca; no vuelvo a ninguna versión; "
  elif ! node --check "$TREE/scripts/setup/harness.js" >/dev/null 2>&1 || [ ! -f "$TREE/scripts/setup/harness.js" ]; then
    if [ -d "$OWN/previous" ]; then
      mkdir -p "$OWN/trash" 2>/dev/null
      _aside="$OWN/trash/failed-$(date -u +%Y%m%d-%H%M%S)"
      if mv "$TREE" "$_aside" 2>/dev/null && mv "$OWN/previous" "$TREE" 2>/dev/null; then why="harness.js no arrancaba: volví a la versión anterior (previous → harness; la rota en $_aside); "
      else why="harness.js no arranca y no pude volver a previous/; "; fi
    else
      why="harness.js no arranca y no hay versión anterior: volvé a instalar con node <copia>/scripts/setup/harness.js install --version latest; "
    fi
  fi
  [ -n "$repaired" ] && why="${why}reparación desde el diario: $repaired; "
elif [ -n "$LINK_TREE" ]; then
  TREE="$LINK_TREE"
else
  why="el enlace $LINK no resuelve; "
  if [ -f "$STATE" ] && command -v node >/dev/null 2>&1; then
    TREE="$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof s.tree==="string"?s.tree:"")}catch(e){}' "$STATE" 2>/dev/null)"
  elif [ -f "$STATE" ]; then
    TREE="$(sed -n 's/^[[:space:]]*"tree"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATE" 2>/dev/null | head -1)"
  fi
  [ -n "$TREE" ] && [ -f "$TREE/scripts/install-tycon-hooks.sh" ] || TREE=""
fi

# en modo developer el árbol es el clon propio del dev: el respaldo NO toca su git (ni pull ni autostash), sólo corre el
# aplicador — un harness.js roto a medio editar es justo cuando este archivo corre (pase adversarial, clase 18)
MODE=""
if [ -f "$STATE" ] && command -v node >/dev/null 2>&1; then
  MODE="$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof s.mode==="string"?s.mode:"")}catch(e){}' "$STATE" 2>/dev/null)"
elif [ -f "$STATE" ]; then
  MODE="$(sed -n 's/^[[:space:]]*"mode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATE" 2>/dev/null | head -1)"
fi

NODE_V="$(node --version 2>/dev/null)"
pulled=""
[ "$MODE" = "developer" ] && pulled=" ninguno (modo desarrollador: el git del clon es del dev)"

# La guarda: el clon del que salen las skills —~/.claude/agent-skills: el clon viejo, re-apuntado o no
# al repo unificado, o el único árbol de una máquina nueva (ahí es un enlace al clon del arnés)— NUNCA avanza a una punta
# que no trae skills/tycon-pipeline. Pasa si `main` vuelve a un árbol anterior a la unión de los dos repos: el pull
# dejaría a la máquina sin skills. Se mira ANTES del pull: se trae sin mover (fetch) y se mira el árbol de lo traído. Si
# no las trae no se mueve NINGUNO de los dos clones (el aplicador corre igual, con lo que hay). Con dos clones sin
# re-apuntar el clon viejo sigue a su repo de siempre, que las trae: el arnés sigue a `main`.
#
# «No pude mirar» no es «no las trae». Preguntar con `git cat-file -e <commit>:skills/tycon-pipeline` contesta lo
# mismo (≠ 0) si el árbol no trae la carpeta que si git no pudo leerlo (un objeto que falta, un candado). Con el
# árbol de HEAD sin leer se entendería «de este clon no salen las skills» y se haría el pull —a una punta sin
# skills—; con el de lo traído sin leer se frenaría diciendo «no trae las skills», que no sería cierto. Por eso son
# tres respuestas, como `hasSkills()` de repoint.js: `git ls-tree`
# sale 0 y nombra la carpeta (las trae) · sale 0 y no la nombra (no las trae) · no sale 0 (no pude mirar). Con «no pude
# mirar» tampoco se mueve ningún clon, y la línea dice qué no se pudo leer. Un clon sin rama de la que traer no tiene a
# dónde avanzar (su pull falla solo): ahí no hay nada que cuidar. Lo mide harness-bootstrap.test.sh (T35).
skills_at() { # skills_at <commit> → yes | no | unknown
  _sa="$(git -C "$SKILLS" ls-tree -d --name-only "$1^{tree}" -- skills/tycon-pipeline 2>/dev/null)" || { printf 'unknown'; return 0; }
  if [ "$_sa" = "skills/tycon-pipeline" ]; then printf 'yes'; else printf 'no'; fi
}
guard=""
if [ "$MODE" != "developer" ] && [ -z "$RELEASE" ] && [ -d "$SKILLS/" ] && git -C "$SKILLS" rev-parse --git-dir >/dev/null 2>&1; then
  case "$(skills_at HEAD)" in
    yes)
      git -C "$SKILLS" fetch --quiet >/dev/null 2>&1
      up="$(git -C "$SKILLS" rev-parse --verify -q "@{upstream}^{commit}" 2>/dev/null)"; up_rc=$?
      if [ "$up_rc" = 0 ] && [ -n "$up" ]; then
        case "$(skills_at "$up")" in
          no) guard="1"; pulled=" ninguno (la versión nueva no trae las skills: no se aplica)" ;;
          unknown) guard="1"; pulled=" ninguno (no pude mirar si la versión nueva trae las skills: git no leyó el árbol de $up en $SKILLS; no se aplica)" ;;
        esac
      elif [ "$up_rc" != 1 ]; then
        # 1 = no hay rama de la que traer (o HEAD suelto); otra salida es git que no pudo contestar
        guard="1"; pulled=" ninguno (no pude mirar a qué versión avanzaría $SKILLS: git rev-parse salió $up_rc; no se aplica)"
      fi ;;
    unknown) guard="1"; pulled=" ninguno (no pude mirar si de $SKILLS salen las skills: git no leyó el árbol de HEAD; no se aplica)" ;;
  esac
fi

[ -n "$RELEASE" ] && pulled=" ninguno (versión bajada: sin git)"
for d in "$TREE" "$SKILLS"; do
  [ "$MODE" = "developer" ] && break
  [ -n "$RELEASE" ] && break
  [ -n "$guard" ] && break
  [ -n "$d" ] && [ -d "$d/" ] || continue
  if git -C "$d" rev-parse --git-dir >/dev/null 2>&1; then
    if git -C "$d" pull --ff-only --autostash --quiet >/dev/null 2>&1; then pulled="$pulled $(basename "$d"):ok"; else pulled="$pulled $(basename "$d"):no"; fi
  fi
done
applier="sin aplicador (árbol no encontrado)"
# el aplicador es el enchufe de Claude Code: si el estado dice qué herramientas enchufa la máquina
# y Claude Code no está entre ellas, no corre (escribiría en su carpeta). Sin `tools` en el estado, como siempre.
NO_CLAUDE=""
if [ -f "$STATE" ]; then
  _flat="$(tr -d ' \n\r\t' < "$STATE" 2>/dev/null)"
  case "$_flat" in
    *'"tools":['*)
      # la lista cierra en su primer `]`: un «claude» más adelante en el archivo no cuenta
      _tools="${_flat#*\"tools\":[}"; _tools="${_tools%%]*}"
      case "$_tools" in *'"claude"'*) : ;; *) NO_CLAUDE=1 ;; esac ;;
  esac
fi
if [ -n "$TREE" ]; then
  if [ -n "$NO_CLAUDE" ]; then applier="aplicador no corrido (esta máquina no enchufa a Claude Code)"
  elif [ "${TYCON_NO_AUTOINSTALL:-0}" = "1" ]; then applier="aplicador no corrido (TYCON_NO_AUTOINSTALL=1)"
  elif bash "$TREE/scripts/install-tycon-hooks.sh" >/dev/null 2>&1; then applier="aplicador ok"; else applier="aplicador salió $?"; fi
fi

line="respaldo en shell: bootstrap.js no arrancó harness.js (${why}node ${NODE_V:-ausente}); pull:${pulled:- ninguno}; $applier"
printf '%s fallback: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line" >> "$LOG" 2>/dev/null

# el aviso en el estado, para que el hook síncrono se lo diga a la persona (si hay node y el estado se puede leer)
if [ -f "$STATE" ] && command -v node >/dev/null 2>&1; then
  node -e '
const fs = require("fs"), f = process.argv[1], text = process.argv[2];
try {
  const s = JSON.parse(fs.readFileSync(f, "utf8")); if (!s || typeof s !== "object") process.exit(0);
  s.notice = text + " — mirá " + process.argv[3] + " y corré harness.js doctor";
  const tmp = f + "." + process.pid + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n"); fs.renameSync(tmp, f);
} catch (e) { /* el aviso nunca frena el arranque */ }' "$STATE" "$line" "$LOG" >/dev/null 2>&1
fi
exit 0
