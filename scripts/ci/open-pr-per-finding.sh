#!/usr/bin/env bash
# open-pr-per-finding.sh — el pull request que las dos colas nocturnas RECUERDAN.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# POR QUÉ EXISTE, Y POR QUÉ ES UNO SOLO
#
# Los dos nocturnos —dependencias y vigilante— abren un pull request por hallazgo, y reintentan
# cada noche el de toda ficha pendiente que no tenga uno ACTIVO. El reintento existe porque, si una
# ficha se anuncia cuando la identidad del pipeline no puede crear ramas, el paso "sale bien" sin
# abrir nada y la ficha espera noches una decisión sin un lugar donde decidirse.
#
# Lo que un reintento ingenuo NO distingue es «no se pudo crear» de «una persona lo cerró». Un pull
# request rechazado tampoco está activo: la rama de un mismo hallazgo (`vigilante/<id>`) recibiría
# un pull request tras otro para una decisión ya tomada.
#
# 🔴 Y va en UN guion que los dos YAML llaman, no copiado en los dos. Dos bloques copiados se
# separan enseguida —por ejemplo, la guarda del literal `$(…)` de los revisores se arreglaría en
# una copia y nunca llegaría a la otra—. Este repo ya pagó ese patrón con `release-notes.sh` en 8
# repos, y lo cerró extrayendo el canónico a `scripts/ci/`.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# LAS TRES REGLAS QUE ORDENAN EL GUION
#
# 1. LA IDENTIDAD DEL PULL REQUEST ES `pr:` EN LA FICHA. La rama sigue llamándose `<cola>/<id>`,
#    pero lo que decide si hay que abrir uno es la ficha, no lo que Azure conteste sobre una rama.
#    Sin `pr:`, se pregunta por la rama con `--status all` y se ADOPTA lo que haya: eso es lo que
#    impide que un `pr:` perdido por un push fallido produzca un segundo pull request.
#    Y un `pr:` cuenta sólo si ese pull request es de ESTE repo (`--project`/`--repo`): el número vale
#    para toda la organización, y el de otro repo no es un lugar donde decidir esta ficha (ver `pr_owner`).
#
# 2. PREGUNTAR MAL NO ES «NO HAY NINGUNO». Ninguna consulta lleva `|| true` ni `2>/dev/null`: si
#    `az` falla, esa ficha no se toca, se imprime el error CRUDO, cuenta como fallo, las demás se
#    procesan igual, y el paso termina en 1. Mañana se reintenta la consulta, no el pull request.
#
# 3. LA CONSECUENCIA DE UN RECHAZO LA DECIDE CADA COLA, no este guion: se llama a `<guion> note`.
#    En dependencias el rechazo se anota y la ficha SIGUE VIVA (la vulnerabilidad es un hecho
#    medido; rechazar el aviso no la saca de `main`); en el vigilante archiva la ficha como
#    descartada (un borrador es una hipótesis, y descartarla es una decisión completa). Este guion
#    no sabe leer ni escribir el formato de ninguna de las dos: lee `pr:` y `veredicto:` por línea.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# EL ORDEN DE LAS FASES, que es lo que lo hace correcto
#
#   S  decisiones del sitio .... mergea o cierra el pull request que una persona decidió en el sitio
#   A  decidir por ficha ....... consulta Azure y ENCOLA lo que habrá que anotar (no escribe)
#   E  barrer las archivadas ... cierra el pull request de lo que ya se archivó (encola también)
#   B  abrir ................... rama, texto, mover, push, `pr create` → guarda el id
#   C  anotar .................. ejecuta TODA la cola sobre el disco y la guarda en `main` (un commit)
#   D  rehacer las ramas ....... sólo las de esta noche, desde el `main` ya publicado
#
# Decidir y escribir están separados para que todo lo anotado entre en UN commit. E va antes de B
# para entrar en ese mismo commit. D va después de C y SÓLO si C pudo publicar: si el push falló,
# `main` no tiene el `pr:`, la rama vieja no choca con nada, y mañana esos pull requests se adoptan
# sin crear otros.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# 🔴 ESTE GUION NO MUEVE EL CHECKOUT. Corre cuatro veces por noche —dos en cada cola—, y la primera
# es el primer paso después de traer el arnés. Volver el checkout a `origin/main` (`checkout -B`,
# `reset --hard`) reemplazaría el código puesto encima por el de `origin/main`, y la noche seguiría
# en verde midiendo otro código. Por eso:
#   · la rama de cada pedido se arma SIN copia de trabajo (`commit_de_rama`: la ficha de `main`,
#     movida a `promoted/`, en un commit hecho con un índice temporal) y se empuja por su sha;
#   · las anotaciones se escriben en el disco, donde la noche las cuenta, y salen a `main` por
#     `push-nightly-data.js save`, el único camino por el que los nocturnos guardan: lleva SÓLO la
#     carpeta de la cola, nunca lo que haya debajo de HEAD. Si ese guardado no viaja, lo anotado queda
#     en el disco y el paso que guarda la noche —que incluye esta carpeta— lo vuelve a llevar.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# DOS PASADAS POR NOCHE
#
# Con `--record-only` corren A, E y C, y B no abre nada: es la pasada que cada cola hace ANTES de
# su corrida nocturna. Sin ella, lo que una persona decide durante el día se registraría recién en el
# último paso, DESPUÉS de que la noche cuente las fichas y de que salga el resumen: el resumen
# contaría como pendientes borradores ya rechazados, y uno rechazado con su motivo escrito se
# archivaría como «nadie lo miró en 7 días». Esta pasada no abre porque no
# puede: el borrador de esta noche todavía no existe, y B arma la rama desde un `main` que todavía no
# lo tiene. La pasada completa del final sigue abriendo, y vuelve a preguntar por todo: si Azure no
# contestó a la mañana, es la que deja la noche en rojo.
#
# Uso:
#   open-pr-per-finding.sh [--record-only] [--no-save] --queue <carpeta> --branch <prefijo> --script <js> \
#                          --org <url> --project <proy> --repo <repo> [--reviewers <lista>] [--today <fecha>]
#   open-pr-per-finding.sh --platform github [--record-only] [--no-save] --queue <carpeta>/dependencies --branch <prefijo> \
#                          --script <js> --repo <dueño>/<repo> [--reviewers "<login> <login>"] [--today <fecha>]
#   --platform es azure (por defecto) o github; en GitHub, sólo la cola de dependencias, con `gh api` (TYCON_GH_CMD) y
#   los issues de los productos con TYCON_GH_ISSUES_TOKEN si está. --no-save anota en el disco y no guarda ni abre.
#   --queue es la carpeta de la cola, relativa a donde se corre y de los niveles que haga falta
#   (`inbox/watcher`); --branch, el prefijo de las ramas (`<prefijo>/<id>`). Son dos datos: no se derivan.
# Exit: 0 hizo lo suyo · 1 algo falló (se dice cuál y por qué) · 2 error de uso (incluye: la cola no existe, o le falta `pending/`)

set -uo pipefail

# Las opciones renombradas a inglés: los pipelines nocturnos pueden seguir pasando las viejas
# hasta el retiro. El traductor vive al lado (viaja en el artefacto arnes-ci).
_AQUI_LO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${_AQUI_LO}/legacy-options.sh" ]; then
  . "${_AQUI_LO}/legacy-options.sh"
  legacy_options 'cola:queue guion:script hoy:today rama:branch revisores:reviewers solo-registrar:record-only' "$@" || exit 2
  set -- ${LEGACY_OPTIONS[@]+"${LEGACY_OPTIONS[@]}"}
fi

COLA=""; PREFIJO=""; GUION=""; ORG=""; PROYECTO=""; REPO=""; REVISORES=""; HOY=""; SOLO_REGISTRAR=""
PLATAFORMA="azure"; SIN_GUARDAR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --record-only) SOLO_REGISTRAR=1; shift ;;
    --no-save)     SIN_GUARDAR=1; shift ;;
    --platform)  PLATAFORMA="$2"; shift 2 ;;
    --queue)     COLA="$2"; shift 2 ;;
    --branch)    PREFIJO="$2"; shift 2 ;;
    --script)    GUION="$2"; shift 2 ;;
    --org)       ORG="$2"; shift 2 ;;
    --project)   PROYECTO="$2"; shift 2 ;;
    --repo)      REPO="$2"; shift 2 ;;
    --reviewers) [ $# -ge 2 ] || { echo "error: --reviewers sin valor" >&2; exit 2; }; REVISORES="$2"; shift 2 ;;
    --today)     HOY="$2"; shift 2 ;;
    *) echo "opción desconocida: $1" >&2; exit 2 ;;
  esac
done
case "$PLATAFORMA" in
  azure|github) ;;
  *) echo "error: --platform tiene que ser azure o github (es «${PLATAFORMA}»)" >&2; exit 2 ;;
esac
falta=""
[ -n "$COLA" ]     || falta="$falta --queue"
[ -n "$PREFIJO" ]  || falta="$falta --branch"
[ -n "$GUION" ]    || falta="$falta --script"
if [ "$PLATAFORMA" = azure ]; then
  [ -n "$ORG" ]      || falta="$falta --org"
  [ -n "$PROYECTO" ] || falta="$falta --project"
fi
[ -n "$REPO" ]     || falta="$falta --repo"
if [ -n "$falta" ]; then
  echo "error: faltan parámetros:$falta" >&2
  sed -n '/^# Uso:/,/^# Exit:/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
# En GitHub el pull request se pregunta siempre dentro de un repo (`<dueño>/<repo>`), y sólo la cola de dependencias
# sabe anotar de qué repo es (`note --pr-repo`): el vigilante comparte el guion y no lo tiene.
if [ "$PLATAFORMA" = github ]; then
  # la forma del conector (esRepoGithub de gh-api.js): el dueño sin puntos ni «-» al comienzo; el nombre, ni `.` ni `..`
  # (irían a parar a otra ruta de la API)
  if ! [[ "$REPO" =~ ^[A-Za-z0-9_][A-Za-z0-9_-]*/[A-Za-z0-9_.][A-Za-z0-9_.-]*$ ]] || [[ "$REPO" =~ /\.{1,2}$ ]]; then
    echo "error: en GitHub --repo es <dueño>/<repo> (es «${REPO}»)" >&2; exit 2
  fi
  case "$COLA" in
    */dependencies|dependencies) ;;
    # el vigilante en GitHub: no_soportado, que frena (sale 2) salvo que quien llama lo pida con TYCON_ALLOW_UNSUPPORTED=1
    *) echo "no_soportado: open-pr-per-finding.sh: --platform github sólo con la cola de dependencias (la cola es «${COLA}», la del vigilante u otra): sólo ella anota de qué repo es su pull request" >&2
       [ "${TYCON_ALLOW_UNSUPPORTED:-}" = "1" ] && exit 0
       exit 2 ;;
  esac
fi
[ -n "$HOY" ] || HOY=$(date -u +%Y-%m-%d)

# 🔴 UNA CARPETA DE COLA QUE NO ESTÁ NO ES «NO HAY FICHAS».
# `--queue` es una RUTA, relativa a donde se corre (`--branch` es el prefijo de las ramas, otro dato).
# Los `for` de abajo recorren `"$COLA"/pending/*.yaml`: si la carpeta no existe no encuentran nada, el
# guion diría «Nada que abrir» y saldría 0 sin preguntarle nada a Azure — la noche en verde con todas las
# fichas sin mirar. Es el modo de falla de mudar la cola (de `<cola>/` a `inbox/<…>/`) sin que un
# llamador se entere, y se lee igual que una noche tranquila. Acá es un error de uso: 2, y dicho.
if [ ! -d "$COLA" ]; then
  echo "##vso[task.logissue type=error]la carpeta de la cola «${COLA}» no existe en $(pwd): no se miró ninguna ficha (¿--queue apunta a la carpeta de antes?)"
  echo "error: la carpeta de la cola no existe: $COLA" >&2
  exit 2
fi
# 🔴 …Y UNA COLA SIN SU `pending/` TAMPOCO. Mirar sólo que la cola exista dejaría pasar la mudanza
# a medias: la carpeta llega con `promoted/` o `archived/` y `pending/` no. El `for` de la fase A
# no encontraría ninguna ficha y el guion diría «Nada que abrir»:
# el mismo verde falso, un nivel más adentro. `pending/` viaja SIEMPRE en git (con su `.gitkeep`), así
# que su ausencia no es una noche sin fichas: una `pending/` que está y no tiene ninguna sí lo es, y
# ésa sigue saliendo 0. Va antes de hablar con Azure y de escribir nada.
if [ ! -d "$COLA/pending" ]; then
  echo "##vso[task.logissue type=error]la cola «${COLA}» no tiene su carpeta pending/ en $(pwd): no se miró ninguna ficha (¿una mudanza a medias?)"
  echo "error: la cola no tiene su carpeta pending/: $COLA/pending" >&2
  exit 2
fi

# 🔴 Si la variable de revisores no está definida, Azure DevOps NO la deja vacía: deja el literal
# `$(NOMBRE)`, y `--reviewers '$(NOMBRE)'` hace FALLAR la apertura del pull request. O sea que la
# promesa de "sin revisores se abre igual" sería falsa justo en el caso que dice cubrir: una
# instalación nueva que todavía no configuró la variable. Un hallazgo sin pull request es un
# hallazgo que nadie va a mirar, así que la ausencia de revisores no puede costar el aviso.
# Esta guarda vale para las dos colas.
case "$REVISORES" in *'$('*) REVISORES="" ;; esac

FALLOS=0
ACCIONES=$(mktemp)                 # una línea por acción: <archivo> TAB <op> TAB <arg1> TAB <arg2>
ABIERTOS=$(mktemp)                 # "<id> <pr>" de los abiertos ESTA noche (para rehacer su rama)
ERR=$(mktemp)
TEXTOS=$(mktemp -d)                # el texto de cada pedido: una carpeta propia, no nombres fijos en /tmp
trap 'rm -f "$ACCIONES" "$ABIERTOS" "$ERR"; rm -rf "$TEXTOS"' EXIT

# 🔴 El texto de un fallo o de un aviso suele traer lo que dijo OTRO programa (`$(cat "$ERR")`: el stderr
# de `az` o de `git`, de varias líneas). Se sanea acá, en la salida, y no en cada llamador: una línea de
# ese stderr que empezara con `##vso[...]` la leería Azure como una orden del pipeline —un
# `task.complete result=Succeeded` taparía el `exit 1` del final—. `sanear` está definida más abajo.
fallo(){ echo "##vso[task.logissue type=error]$(sanear "$1")"; FALLOS=$((FALLOS+1)); }
aviso(){ echo "##vso[task.logissue type=warning]$(sanear "$1")"; }

# 🔴 EL COMENTARIO DE UN PULL REQUEST ES TEXTO LIBRE, escrito por cualquiera que pueda comentarlo.
# Se sanea en el PUNTO DE ENTRADA —apenas sale de Azure— y no río abajo, porque río abajo ya es tarde
# para los dos usos que hace este guion:
#
#   (a) IMPRIMIRLO. Azure DevOps lee el stdout de cada paso buscando `##vso[...]` y los EJECUTA como
#       órdenes del pipeline. Un comentario con `##vso[task.complete result=Succeeded]` hace que el
#       paso se reporte exitoso pase lo que pase, tapando el `exit 1` del final: una noche que falló
#       termina en verde. Con `task.setvariable` se puede además reescribir `DEPS_REVISORES`, que más
#       abajo se expande SIN comillas dentro de `--reviewers`.
#   (b) ENCOLARLO. La cola de acciones es una línea por acción separada por TAB. Un comentario de
#       varias líneas —lo NORMAL en Azure, que acepta markdown— parte el registro en dos y la
#       continuación se lee como una acción independiente: con un TAB adentro, se puede forjar un
#       `note --card <la ficha de OTRA persona> --pr <n>`, que se commitea a `main` con la
#       identidad del pipeline. Reproducido: una ficha ajena pasó de `pr: 8` a `pr: 999`.
#
# Y sin colapsar los saltos de línea ni recortar los bordes se pierde el dato que se busca: un comentario que arranca con una línea en
# blanco quedaría ENTERO afuera y la ficha diría «sin motivo escrito» — el hecho opuesto al real.
sanear(){
  printf '%s' "$1" \
    | sed -e 's/^[[:space:]]*##[vV][sS][oO]\[/(vso) [/' -e 's/##[vV][sS][oO]\[/(vso) [/g' \
    | tr '\r\n\t' '   ' \
    | sed -e 's/  */ /g' -e 's/^ //' -e 's/ $//'
}
# Los cuatro campos se escapan igual, por si mañana otro llamador encola algo con tabs: sanear en la
# entrada arregla HOY, escapar acá impide que vuelva.
encolar(){
  printf '%s\t%s\t%s\t%s\n' "$(sanear "$1")" "$(sanear "$2")" "$(sanear "${3:-}")" "$(sanear "${4:-}")" >> "$ACCIONES"
}
# 🔴 Sin quitar las comillas, la guarda de «vida anterior» quedaría MUERTA en el vigilante: sus fichas
# escriben `fecha: "AAAA-MM-DD"`, y como `"` (0x22) ordena por debajo de cualquier dígito,
# `[[ "$CREADO" < "$DESDE" ]]` no podía ser verdadero nunca — o sea que CUALQUIER pull request
# abandonado de la rama se adoptaba como rechazo, sin importar de qué vida fuera.
escalar(){ sed -n "s/^$2:[ \\t]*//p" "$1" | head -1 | awk '{print $1}' | tr -d '"'; }

# ── La rama de un pedido, sin mover el checkout ────────────────────────────────────────────────
# Imprime el commit de la rama: el árbol de <base> con la ficha movida de `pending/` a `promoted/` y su
# veredicto en `util`. Se arma con un índice temporal: ni HEAD, ni el índice, ni el disco del checkout
# cambian. Sale != 0 con el motivo en stderr si la ficha no está en <base> o git no pudo.
# 🔴 El veredicto se cambia ANTES de guardar el contenido: con `git mv` + `sed` sobre el árbol de
# trabajo, el commit llevaría el archivo movido con el veredicto VIEJO (rename 100 %, 0 cambios).
# Con <el>, la ficha lleva además `decidido_en_sitio: <el>`: la aceptó una persona en el sitio. La marca de una decisión
# que no se pudo aplicar no viaja: la que llega a `promoted/` ya está decidida.
commit_de_rama(){ # <base> <id> [<el>]
  local BASE="$1" ID="$2" EL="${3:-}" INDICE CONTENIDO MODO ARBOL
  INDICE=$(mktemp) || return 1
  rm -f "$INDICE"   # git quiere crear él el archivo del índice
  # «no pude leer» no es «no está»: el código de salida de git se mira antes de leer su salida
  if ! MODO=$(git ls-tree "$BASE" -- "$COLA/pending/$ID.yaml"); then echo "no pude leer $BASE para buscar la ficha $ID" >&2; return 2; fi
  MODO=$(printf '%s' "$MODO" | awk '{print $1}')
  if [ -z "$MODO" ]; then echo "la ficha $ID no está en pending/ de $BASE" >&2; return 1; fi
  CONTENIDO=$(git show "$BASE:$COLA/pending/$ID.yaml" \
      | awk -v el="$EL" '/^(motivo_)?decision_fallida:/ { next }
                         /^veredicto:[ \t]*"?pendiente"?[ \t]*(#.*)?$/ { print "veredicto: util"; if (el != "") print "decidido_en_sitio: " el; next }
                         { print }' | git hash-object -w --stdin) \
    && GIT_INDEX_FILE="$INDICE" git read-tree "$BASE" \
    && GIT_INDEX_FILE="$INDICE" git update-index --force-remove "$COLA/pending/$ID.yaml" \
    && GIT_INDEX_FILE="$INDICE" git update-index --add --cacheinfo "$MODO,$CONTENIDO,$COLA/promoted/$ID.yaml" \
    && ARBOL=$(GIT_INDEX_FILE="$INDICE" git write-tree)
  local RC=$?
  rm -f "$INDICE"
  [ "$RC" = 0 ] || return "$RC"
  git commit-tree "$ARBOL" -p "$BASE" -m "$COLA: $ID pasa a trabajo real"
}
# La identidad de los commits de esas ramas. El paso anterior del pipeline guarda por
# push-nightly-data.js y no la deja puesta; tocar la configuración del repo no mueve el checkout.
# En GitHub no se toca: el árbol ya trae la de `prepare-tree.sh`, que firma también los guardados.
if [ "$PLATAFORMA" = azure ]; then
  git config user.name "Azure Pipelines"
  git config user.email "azure-pipelines@dev.azure.com"
fi

# Cómo se nombra un pull request en los mensajes, y de qué repo se habla.
if [ "$PLATAFORMA" = github ]; then NR="#"; DONDE="$REPO"; else NR="PR !"; DONDE="$PROYECTO/$REPO"; fi

# ── Azure, sin silenciadores ───────────────────────────────────────────────────────────────────
# Cada una devuelve JSON por stdout y sale != 0 si `az` falló, con el error en $ERR. Nada de
# `--query`: JSON crudo + `node -e`, así el doble de las pruebas es un impresor de JSON y no hay
# que reimplementar JMESPath para probar esto sin red.
az_pr_por_id(){ az repos pr show --org "$ORG" --id "$1" -o json 2>"$ERR"; }
az_pr_por_rama(){ az repos pr list --org "$ORG" --project "$PROYECTO" --repository "$REPO" \
                    --source-branch "$1" --status all -o json 2>"$ERR"; }
az_hilos_de(){ az devops invoke --org "$ORG" --area git --resource pullRequestThreads \
                 --route-parameters "project=$PROYECTO" "repositoryId=$REPO" "pullRequestId=$1" \
                 --api-version 7.1 -o json 2>"$ERR"; }

# ── GitHub, con el mismo criterio ──────────────────────────────────────────────────────────────
# Todo por `gh api` (TYCON_GH_CMD lo reemplaza: un ejecutable, o un `.js` que corre con node). Las respuestas se
# traducen a la forma de Azure (`gh_a_azure`), así los lectores de abajo son uno solo para las dos plataformas.
# Los issues de los productos se tocan con TYCON_GH_ISSUES_TOKEN si está: el token del workflow sólo alcanza al repo
# de operaciones, donde viven los pull requests.
gh_cmd(){ local C="${TYCON_GH_CMD:-gh}"; case "$C" in *.js) node "$C" "$@" ;; *) "$C" "$@" ;; esac; }
gh_issues(){ if [ -n "${TYCON_GH_ISSUES_TOKEN:-}" ]; then GH_TOKEN="$TYCON_GH_ISSUES_TOKEN" gh_cmd "$@"; else gh_cmd "$@"; fi; }

# 🔴 Una lista de GitHub viene en páginas de 100: leer sólo la primera es decir «no hay» de lo que está en la segunda.
# Escribe cada página en <dir>/<n>.json (la ruta puede traer ya su `?…`); sale != 0 si una página no se pudo pedir o no es una lista.
gh_paginas(){ # <ruta con ?…> <dir> [issues]
  local K=1 N S="?"
  case "$1" in *\?*) S="&" ;; esac
  while [ "$K" -le 50 ]; do
    if [ "${3:-}" = issues ]; then gh_issues api "$1${S}per_page=100&page=$K" > "$2/$K.json" 2>"$ERR" || return 1
    else gh_cmd api "$1${S}per_page=100&page=$K" > "$2/$K.json" 2>"$ERR" || return 1; fi
    N=$(node -e 'let l; try { l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); } catch { process.exit(1); }
                 if (!Array.isArray(l)) process.exit(1); console.log(l.length);' "$2/$K.json") \
      || { echo "la página $K de $1 no es una lista legible" > "$ERR"; return 1; }
    [ "$N" -ge 100 ] || return 0
    K=$((K+1))
  done
  echo "más de 50 páginas en $1: no se sigue" > "$ERR"; return 1
}

# Un pull request de GitHub (o una lista, o las páginas de una carpeta) → la forma de Azure: `pullRequestId`, `status`
# (open → active; cerrado con `merged_at` → completed; cerrado sin él → abandoned), las fechas y el repo
# (`repository.name` y `repository.project.name` = el dueño). Con `lista <rama> <dir>`, las páginas de <dir> y sólo
# los de esa rama: GitHub filtra
# `head=` por dueño y rama, pero lo que no es de esa rama no se adopta aunque venga.
gh_a_azure(){ node -e '
  const fs=require("fs"); const a=process.argv.slice(1);
  const rama=a[0]==="lista"?a[1]:null; const dir=a[0]==="lista"?a[2]:null;
  const uno=(p)=>{
    if (!p||typeof p!=="object"||p.number===undefined||!p.state) { process.stderr.write("la respuesta no trae el pull request\n"); process.exit(1); }
    const full=((p.base||{}).repo||{}).full_name||""; const i=full.indexOf("/");
    const o={ pullRequestId:p.number, status:p.state==="open"?"active":(p.merged_at?"completed":"abandoned"),
              creationDate:p.created_at||"", closedDate:p.closed_at||"" };
    if (i>0) o.repository={ name:full.slice(i+1), project:{ name:full.slice(0,i) } };
    return o;
  };
  if (dir) {
    const l=[];
    for (const f of fs.readdirSync(dir).filter((x)=>/^\d+\.json$/.test(x)).sort((x,y)=>parseInt(x)-parseInt(y)))
      l.push(...JSON.parse(fs.readFileSync(dir+"/"+f,"utf8")));
    console.log(JSON.stringify(l.filter((p)=>!rama||(p&&p.head&&p.head.ref===rama)).map(uno)));
  } else {
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
      let p; try { p=JSON.parse(d); } catch { process.stderr.write("respuesta ilegible de gh\n"); process.exit(1); }
      console.log(JSON.stringify(uno(p)));
    });
  }' "$@"; }

gh_pr_por_id(){ local OUT; OUT=$(gh_cmd api "repos/$REPO/pulls/$1" 2>"$ERR") || return 1
                printf '%s' "$OUT" | gh_a_azure 2>"$ERR"; }
gh_pr_por_rama(){ local D RC; D=$(mktemp -d) || return 1
  gh_paginas "repos/$REPO/pulls?head=${REPO%%/*}:$1&state=all" "$D" && gh_a_azure lista "$1" "$D" 2>"$ERR"
  RC=$?; rm -rf "$D"; return "$RC"; }
# Los comentarios y las revisiones → los hilos de Azure, en orden de fecha y sólo de personas: una cuenta `[bot]` o de
# tipo Bot no da motivos, ni una revisión vacía o pendiente. `motivo_de` toma el último.
gh_hilos_de(){ local D RC; D=$(mktemp -d) || return 1; mkdir "$D/c" "$D/r" "$D/l"
  # tres fuentes: la conversación, las revisiones y los comentarios sobre líneas del diff
  gh_paginas "repos/$REPO/issues/$1/comments" "$D/c" && gh_paginas "repos/$REPO/pulls/$1/reviews" "$D/r" \
    && gh_paginas "repos/$REPO/pulls/$1/comments" "$D/l" \
    && node -e '
      const fs=require("fs"); const leer=(d)=>fs.readdirSync(d).flatMap((f)=>JSON.parse(fs.readFileSync(d+"/"+f,"utf8")));
      const persona=(u)=>u&&u.login&&!/\[bot\]$/.test(u.login)&&u.type!=="Bot";
      const c=[...leer(process.argv[1]),...leer(process.argv[3])].filter((x)=>persona(x.user)&&x.body).map((x)=>({fecha:x.created_at,texto:x.body,login:x.user.login}));
      const r=leer(process.argv[2]).filter((x)=>persona(x.user)&&x.body&&String(x.body).trim()&&x.state!=="PENDING")
        .map((x)=>({fecha:x.submitted_at,texto:x.body,login:x.user.login}));
      const todos=[...c,...r].sort((a,b)=>Date.parse(a.fecha||0)-Date.parse(b.fecha||0));
      console.log(JSON.stringify({ value:[{ comments:todos.map((x)=>({ commentType:"text", author:{ displayName:x.login }, content:x.texto })) }] }));
    ' "$D/c" "$D/r" "$D/l" 2>"$ERR"
  RC=$?; rm -rf "$D"; return "$RC"; }

# Cierra el pull request de una ficha que ya se cerró. En GitHub, además, dice por qué: un pull request cerrado sin
# explicación se lee como un rechazo de alguien. Primero se cierra y después se comenta: si el cierre falla, mañana se
# reintenta sin haber dejado un comentario por noche; si falla el comentario, el pull request ya está cerrado (aviso).
cerrar_pr(){ # <pr> <id> <ficha>
  if [ "$PLATAFORMA" = azure ]; then az repos pr update --org "$ORG" --id "$1" --status abandoned -o none 2>"$ERR"; return; fi
  local J; J=$(mktemp) || return 1
  printf '{"state":"closed"}' > "$J"
  if ! gh_cmd api --method PATCH "repos/$REPO/pulls/$1" --input "$J" >/dev/null 2>"$ERR"; then rm -f "$J"; return 1; fi
  local POR_QUE="se archivó" EL
  # la decidida en el sitio dice el día: el cierre es la decisión de una persona, no un rechazo del pull request
  EL=$(escalar "$3" decidido_en_sitio)
  case "$EL" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) POR_QUE="se decidió en el sitio el $EL" ;; esac
  case "$3" in */promoted/*) [ -n "$EL" ] || POR_QUE="se decidió en el sitio"; grep -q '^resuelto:' "$3" && POR_QUE="se resolvió" ;; esac
  if ! node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ body: "La ficha "+process.argv[2]+" ya salió de la cola ("+process.argv[3]+"): este pull request no tiene nada que decidir, y la noche lo cerró.\n\n<!-- tycon-nocturno -->" }))' \
         "$J" "$2" "$POR_QUE" 2>"$ERR" \
     || ! gh_cmd api --method POST "repos/$REPO/issues/$1/comments" --input "$J" >/dev/null 2>"$ERR"; then
    aviso "$2: el #$1 quedó cerrado, pero no se pudo dejar el comentario que dice por qué — $(cat "$ERR")"
  fi
  rm -f "$J"
}

# Abre el pull request y deja su respuesta en la forma de Azure. En GitHub los revisores se piden aparte (si eso falla,
# el pull request ya existe y su número no se pierde: es un aviso).
crear_pr(){ # <rama> <título> <archivo del cuerpo> <id>
  if [ "$PLATAFORMA" = azure ]; then
    # --squash: el historial de main cuenta decisiones, no el andamio de cada rama.
    az repos pr create --org "$ORG" --project "$PROYECTO" --repository "$REPO" \
       --source-branch "$1" --target-branch main --title "$2" \
       --description "@$3" --squash true \
       ${REVISORES:+--reviewers $REVISORES} -o json 2>"$ERR"
    return
  fi
  local J OUT RC N
  J=$(mktemp) || return 1
  node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ title:process.argv[2], head:process.argv[3], base:"main", body:fs.readFileSync(process.argv[4],"utf8") }))' \
    "$J" "$2" "$1" "$3" || { rm -f "$J"; return 1; }
  OUT=$(gh_cmd api --method POST "repos/$REPO/pulls" --input "$J" 2>"$ERR"); RC=$?
  if [ "$RC" != 0 ]; then
    # 🔴 El 403 de este ajuste no dice qué hay que tocar: se nombra, o la mañana se pierde buscando un permiso del token.
    if grep -q 'GitHub Actions is not permitted to create or approve pull requests' "$ERR"; then
      printf '%s\n' "falta prender «Allow GitHub Actions to create and approve pull requests» en Settings → Actions → General del repo $REPO (y que la organización no lo bloquee) — $(cat "$ERR")" > "$ERR"
    fi
    rm -f "$J"; return 1
  fi
  if ! OUT=$(printf '%s' "$OUT" | gh_a_azure 2>"$ERR"); then rm -f "$J"; return 1; fi
  if [ -n "$REVISORES" ] && N=$(printf '%s' "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).pullRequestId))'); then
    node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ reviewers: process.argv.slice(2) }))' "$J" $REVISORES
    gh_cmd api --method POST "repos/$REPO/pulls/$N/requested_reviewers" --input "$J" >/dev/null 2>"$ERR.rev" \
      || aviso "$4: el #$N se abrió, pero no se pudo pedir revisión a «${REVISORES}» — $(cat "$ERR.rev")" >&2   # la salida de esta función es la respuesta del pull request
    rm -f "$ERR.rev"
  fi
  rm -f "$J"
  printf '%s\n' "$OUT"
}

pr_por_id(){ if [ "$PLATAFORMA" = github ]; then gh_pr_por_id "$@"; else az_pr_por_id "$@"; fi; }

# ¿Lo cerró la noche? Su comentario de cierre (`cerrar_pr`) lleva la marca `<!-- tycon-nocturno -->`. Imprime si|no, y
# sale != 0 si no pudo leer los comentarios: «no pude leer» no es «no».
cerrado_por_la_noche(){ # <pr>
  local D RC; D=$(mktemp -d) || return 1
  gh_paginas "repos/$REPO/issues/$1/comments" "$D" \
    && node -e 'const fs=require("fs");const d=process.argv[1];
      const t=fs.readdirSync(d).flatMap((f)=>JSON.parse(fs.readFileSync(d+"/"+f,"utf8")));
      console.log(t.some((c)=>String((c&&c.body)||"").includes("<!-- tycon-nocturno -->"))?"si":"no");' "$D" 2>"$ERR"
  RC=$?; rm -rf "$D"; return "$RC"
}
pr_por_rama(){ if [ "$PLATAFORMA" = github ]; then gh_pr_por_rama "$@"; else az_pr_por_rama "$@"; fi; }
hilos_de(){ if [ "$PLATAFORMA" = github ]; then gh_hilos_de "$@"; else az_hilos_de "$@"; fi; }

# 🔴 EL EMPUJE PREGUNTA LA PUNTA REAL. `--force-with-lease` sin valor compara contra la rama de seguimiento local, y un
# árbol que trae sólo `main` no la tiene: git rechaza el empuje de una rama que ya existe y el pull request de esa
# ficha no se puede rehacer nunca. Se pregunta al remoto y se compara contra eso (vacío: la rama no tiene que existir).
empujar_rama(){ # <commit> <rama>
  local PUNTA
  if ! PUNTA=$(git ls-remote origin "refs/heads/$2" 2>"$ERR"); then return 1; fi
  PUNTA=${PUNTA%%[[:space:]]*}
  git push -q origin "$1:refs/heads/$2" --force-with-lease="refs/heads/$2:$PUNTA" 2>"$ERR"
}

# 🔴 LOS TRES LECTORES DE JSON SALEN != 0 CUANDO NO PUEDEN LEER, y nunca vacíos.
#
# Un `catch { process.exit(0) }` saldría con ÉXITO y sin imprimir nada, así que el shell no
# podría distinguir *«az contestó y no hay nada»* de *«no pude leer la respuesta»*. Es EXACTAMENTE el
# hazard que este guion existe para evitar, con tres consecuencias: se abriría un pull request
# duplicado, se daría por cerrado uno que sigue abierto (y esa ficha no se volvería a mirar NUNCA),
# y se perdería el motivo del rechazo.
#
# La lista vacía LEGÍTIMA imprime `SIN_PR`, que sí es distinguible de no imprimir nada.
mas_reciente(){ node -e '
  let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
    let l; try { l=JSON.parse(d); } catch { process.stderr.write("respuesta ilegible de az\n"); process.exit(1); }
    if (!Array.isArray(l)) { process.stderr.write("se esperaba una lista de pull requests\n"); process.exit(1); }
    if (!l.length) { console.log("SIN_PR"); return; }
    // 🔴 El ACTIVO gana sobre la fecha: si no, un pull request abandonado más nuevo sobre la misma
    // rama tapa al que está abierto y la ficha se anota como rechazada teniendo uno vivo.
    const orden=(p)=>(p.status==="active"?0:1);
    l.sort((a,b)=>orden(a)-orden(b)||Date.parse(b.creationDate||0)-Date.parse(a.creationDate||0));
    const p=l[0];
    if (p.pullRequestId===undefined||p.pullRequestId===null) { process.stderr.write("un pull request sin número\n"); process.exit(1); }
    console.log([p.pullRequestId,p.status,(p.creationDate||"").slice(0,10),(p.closedDate||"").slice(0,10)].join(" "));
  });'; }

campo_pr(){ node -e '
  let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
    let p; try { p=JSON.parse(d); } catch { process.stderr.write("respuesta ilegible de az\n"); process.exit(1); }
    if (!p||typeof p!=="object"||p.pullRequestId===undefined||!p.status) {
      process.stderr.write("la respuesta no trae el pull request\n"); process.exit(1);
    }
    console.log([p.pullRequestId,p.status,(p.creationDate||"").slice(0,10),(p.closedDate||"").slice(0,10)].join(" "));
  });'; }

# 🔴 EL NÚMERO DE UN PULL REQUEST ES DE TODA LA ORGANIZACIÓN, NO DE ESTE REPO.
# `pr_por_id` pregunta por número y Azure contesta el pull request de CUALQUIER repo. Una ficha que llega con su `pr:`
# desde otro repo —el caso: la cola se muda a un repo que nace con la historia del anterior— tiene entonces un pull
# request «propio» que no se puede decidir acá: si sigue activo, la ficha espera para siempre en un lugar donde
# nadie la va a aceptar; si alguien lo abandona para ordenar, se anota como un rechazo; y a los 7 días pasa
# sola a ignorada. Las tres, en verde. Este lector dice de quién es: `own`, o `foreign <proyecto>/<repo>`.
# Como los otros: si la respuesta no dice de qué repo es, sale != 0 —«no pude leer» no es «es de acá»—.
# `--project` y `--repo` pueden venir por nombre o por id: se compara contra los dos, sin distinguir mayúsculas.
pr_owner(){
  local PJ="$PROYECTO" RP="$REPO"
  [ "$PLATAFORMA" = github ] && { PJ="${REPO%%/*}"; RP="${REPO#*/}"; }
  PR_PROJECT="$PJ" PR_REPO="$RP" node -e '
  let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
    let p; try { p=JSON.parse(d); } catch { process.stderr.write("respuesta ilegible de az\n"); process.exit(1); }
    const r=p&&p.repository, pj=r&&r.project;
    if (!r||typeof r!=="object"||!r.name||!pj||typeof pj!=="object"||!pj.name) {
      process.stderr.write("la respuesta no dice de qué repo es el pull request\n"); process.exit(1);
    }
    const same=(a,b)=>String(a||"").toLowerCase()===String(b||"").toLowerCase();
    const one=(o,v)=>same(o.name,v)||same(o.id,v);
    if (one(r,process.env.PR_REPO)&&one(pj,process.env.PR_PROJECT)) { console.log("own"); return; }
    console.log("foreign "+String(pj.name).replace(/\s+/g," ")+"/"+String(r.name).replace(/\s+/g," "));
  });'; }

# 🔴 El motivo del rechazo es el ÚLTIMO comentario de tipo `text` escrito por una PERSONA. Medido
# sobre los tres pull requests abandonados reales: sólo UNO tenía un comentario de texto; los otros
# dos únicamente comentarios de sistema ("voted -10", "updated the pull request status to
# Abandoned"), y `closedBy` viene `null`. Cuando no hay, se dice «sin motivo escrito», que es un
# dato — y es distinto de «no pude leer el motivo», que cuenta como fallo y se reintenta mañana.
motivo_de(){ node -e '
  let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
    let v; try { v=(JSON.parse(d)||{}).value; } catch { process.stderr.write("hilos ilegibles\n"); process.exit(1); }
    if (!Array.isArray(v)) { process.stderr.write("la respuesta no trae hilos\n"); process.exit(1); }
    const bot=/Project Collection Build Service|Microsoft\.VisualStudio\.Services/i;
    let ultimo=null;
    for (const h of v) for (const c of (h.comments||[])) {
      if (c.commentType!=="text") continue;
      if (bot.test(((c.author||{}).displayName)||"")) continue;
      ultimo=c;
    }
    console.log(ultimo && ultimo.content ? String(ultimo.content) : "sin motivo escrito");
  });'; }

# ── El issue sigue al pull request (GitHub) ───────────────────────────────────────────────────
# 🔴 Con dos lugares de decisión que dicen cosas distintas, el resumen no sabe qué está aceptado. Manda el pull
# request: mergeado («hay que arreglarlo») reabre el issue cerrado como «not planned»; cerrado sin merge («no aplica»)
# cierra como «not planned» el issue abierto, con el motivo; reabierto reabre el que la noche cerró por ese rechazo.
# Un issue cerrado como `completed` no se toca: eso lo decide la medición. Cada decisión se aplica UNA vez
# (`alineado: <pr>:<decisión>`): si después una persona vuelve a mover el issue, la noche no se pelea con ella.
# Sólo en la pasada completa: la de antes de la noche corre con permiso de leer.
# Toca los issues aunque C no pueda guardar: mañana se repite, y como mira el estado de cada issue antes, no lo duplica
# (el estado se cambia antes del comentario: si el comentario falla, mañana el issue ya está bien y no se comenta dos veces).
alinear_issues(){ # <ficha> <pr> merged|closed|reopened <motivo>
  local FICHA="$1" N="$2" DEC="$3" MOT="$4" ID LISTA IR M ACT ESTADO RAZON CUERPO MAL=0
  [ "$PLATAFORMA" = github ] && [ -z "$SOLO_REGISTRAR" ] || return 0
  [ "$(escalar "$FICHA" alineado)" != "$N:$DEC" ] || return 0
  ID=$(basename "$FICHA" .yaml)
  # 🔴 Sólo los repos que la organización declara (`github:` activo en repos.json, el mismo criterio que
  # github-issues.js): la ficha viene del trabajo que corrió código de los productos, y un `pedidos:` adulterado no
  # puede cerrar issues de cualquier repo que alcance el token. Sin repos.json legible no se toca ninguno.
  if ! LISTA=$(node -e 'const fs=require("fs"); const n=require(require("path").resolve(process.argv[1]));
                        let c; try { c=JSON.parse(fs.readFileSync("scripts/nightly/dependencies/repos.json","utf8")); }
                        catch (e) { process.stderr.write("no se pudo leer scripts/nightly/dependencies/repos.json: "+e.message+"\n"); process.exit(1); }
                        const ok=new Set((c.repos||[]).filter((r)=>r&&r.activo!==false&&typeof r.github==="string").map((r)=>r.github.toLowerCase()));
                        for (const p of n.leerPedidos(fs.readFileSync(process.argv[2],"utf8"))) {
                          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.proyecto)) console.log("malo - "+p.id);
                          else console.log((ok.has(p.proyecto.toLowerCase())?"ok ":"fuera ")+p.proyecto+" "+p.id);
                        }' "$GUION" "$FICHA" 2>"$ERR"); then
    fallo "$ID: no pude leer los issues de la ficha para alinearlos con el #$N — $(cat "$ERR")"; return 0
  fi
  [ -n "$LISTA" ] || return 0
  while read -r QUE IR M; do
    [ -n "${QUE:-}" ] || continue
    case "$QUE" in
      malo)  aviso "$ID: un pedido de la ficha no nombra un repo <dueño>/<repo>: no se toca"; continue ;;
      fuera) aviso "$ID: el issue $IR#$M no es un repo declarado en repos.json: no se toca"; continue ;;
    esac
    if ! ACT=$(gh_issues api "repos/$IR/issues/$M" 2>"$ERR"); then
      # 🔴 Un issue que GitHub dice que no está (404, o 410 si se borró) es una respuesta, no un «no pude preguntar»: no
      # hay nada que alinear, y como fallo dejaría la noche en rojo todas las noches por un issue que nadie va a volver
      # a crear. Se dice y la decisión se da por alineada. Cualquier otro error sí es un fallo y se reintenta mañana.
      if grep -qE 'HTTP (404|410)' "$ERR"; then
        aviso "$ID: el issue $IR#$M ya no existe (GitHub: $(grep -oE 'HTTP (404|410)' "$ERR" | head -1)): no hay nada que alinear con el #$N"
        continue
      fi
      fallo "$ID: no se pudo consultar el issue $IR#$M para alinearlo con el #$N — $(cat "$ERR")"; MAL=1; continue
    fi
    if ! read -r ESTADO RAZON < <(printf '%s' "$ACT" | node -e '
        let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
          let i; try { i=JSON.parse(d); } catch { process.exit(1); }
          if (!i||!i.state) process.exit(1); console.log(i.state+" "+(i.state_reason||"-")); });'); then
      fallo "$ID: no pude leer el estado del issue $IR#$M"; MAL=1; continue
    fi
    case "$DEC" in
      merged|reopened) [ "$ESTADO" = closed ] && [ "$RAZON" = not_planned ] || continue ;;
      closed)          [ "$ESTADO" = open ] || continue ;;
    esac
    case "$DEC" in
      merged)   CUERPO="El pull request $REPO#$N se mergeó: el hallazgo de la ficha $ID hay que arreglarlo, así que este issue se reabre." ;;
      reopened) CUERPO="El pull request $REPO#$N se reabrió: el rechazo por el que la noche cerró este issue ya no vale, así que se reabre." ;;
      closed)   CUERPO="El pull request $REPO#$N se cerró sin merge: el hallazgo de la ficha $ID no aplica. Motivo: ${MOT:-sin motivo escrito}" ;;
    esac
    # el motivo lo escribió cualquiera: un `@` no menciona a nadie desde la cuenta de la noche
    if ! node -e 'require("fs").writeFileSync(process.argv[1]+".c", JSON.stringify({ body: process.argv[2].replace(/@/g,"@​")+"\n\n<!-- tycon-nocturno -->" }));
                  require("fs").writeFileSync(process.argv[1]+".e", JSON.stringify(process.argv[3]==="closed" ? { state:"closed", state_reason:"not_planned" } : { state:"open" }));' \
           "$ERR" "$CUERPO" "$DEC" 2>"$ERR" \
       || ! gh_issues api --method PATCH "repos/$IR/issues/$M" --input "$ERR.e" >/dev/null 2>"$ERR" \
       || ! gh_issues api --method POST "repos/$IR/issues/$M/comments" --input "$ERR.c" >/dev/null 2>"$ERR"; then
      fallo "$ID: no se pudo alinear el issue $IR#$M con el #$N — $(cat "$ERR")"; MAL=1; rm -f "$ERR.c" "$ERR.e"; continue
    fi
    rm -f "$ERR.c" "$ERR.e"
    echo "$ID: el issue $IR#$M sigue al #$N ($DEC)"
  done <<< "$LISTA"
  # se anota aunque no haya hecho falta tocar ninguno: la decisión ya está alineada y no se vuelve a mirar
  [ "$MAL" = 1 ] || encolar "$FICHA" alineado "$N:$DEC"
}

# 🔴 EN GITHUB LA FICHA LLEGA DEL TRABAJO QUE CORRIÓ CÓDIGO DE LOS PRODUCTOS: el nombre y el `pr:` se validan antes de
# imprimirlos o de armar con ellos una ruta de la API. Un nombre con un salto de línea imprimiría una línea que
# empieza con `::` (una orden del workflow), y un `pr:` con `/..` cambiaría la ruta que se escribe con el token.
ficha_valida(){ # <ficha>
  [ "$PLATAFORMA" = github ] || return 0
  local B; B=$(basename "$1" .yaml)
  if ! [[ "$B" =~ ^[A-Za-z0-9_-]+$ ]]; then
    fallo "una ficha con un nombre fuera de [A-Za-z0-9_-] («$(printf '%s' "$B" | tr -c 'A-Za-z0-9_.-' '?')»): no se toca"; return 1
  fi
  local N; N=$(escalar "$1" pr)
  if [ -n "$N" ] && ! [[ "$N" =~ ^[0-9]+$ ]]; then
    fallo "$B: su pr: no es un número («$(printf '%s' "$N" | tr -c 'A-Za-z0-9_.-' '?')»): no se toca"; return 1
  fi
}

# ── Fase S — lo que una persona decidió en el sitio sobre un pull request ──────────────────────
# Aceptar en el sitio mergea el pull request de la ficha; Rechazar lo cierra con el motivo como comentario, y la ficha
# anota `rechazado:` y `motivo_rechazo:` (sigue viva, como cualquier rechazo de dependencias). La decisión de una ficha
# SIN pull request la aplica la noche (`aplicarDecisiones`): ésta es sólo la que nombra uno.
#
# 🔴 SE APLICA SÓLO SOBRE EL PEDIDO QUE VIO LA PERSONA. La decisión trae el `pr:` (y en GitHub el `pr_repo:`) de la
# ficha tal como estaba en la pantalla. Si la ficha ya tiene otro, si el pull request es de otro repo o si ya no está
# abierto, no se toca nada: la decisión se borra y la ficha queda con `decision_fallida:` y su porqué, que el resumen
# de la mañana cuenta y que devuelve la fila a «Te toca decidir». Nunca un éxito callado.
#
# 🔴 EL MOTIVO LO ESCRIBIÓ UNA PERSONA. Llega validado (una línea, con tope de largo: `cycle.js site-decisions`), viaja
# como argumento hasta el JSON del comentario, y nunca se arma dentro de un texto de consola ni se imprime.
#
# Antes de mergear, la rama se rehace sobre el `main` de ahora: la ficha cambió en `main` desde que se abrió el pedido
# (las noches la anotan), y la rama vieja choca al fusionar. Lo mergeado se copia al disco igual que quedó en `main`
# —la ficha en `promoted/`—: el guardado de la fase C ve el mismo cambio de los dos lados y no choca.
# Corre en las pasadas que guardan (en GitHub, la del final; la de antes de la noche no puede escribir).
S_TOCO=""; S_RECHAZADAS=" "
ESPERA="${TYCON_PR_WAIT_SECONDS:-60}"
# Cuántas noches se reintenta un merge que no se pudo confirmar antes de devolver la fila a «Te toca decidir».
NOCHES_SIN_CONFIRMAR=3
# Días de <desde> a <hasta> (AAAA-MM-DD); sin fechas legibles, 0: se reintenta, nunca se da por fallida a ciegas.
dias_entre(){ node -e 'const [a,b]=process.argv.slice(1).map((x)=>Date.parse(x+"T00:00:00Z"));console.log(Number.isFinite(a)&&Number.isFinite(b)?Math.max(0,Math.round((b-a)/864e5)):0)' "$1" "$2"; }
[[ "$ESPERA" =~ ^[0-9]+$ ]] || ESPERA=60

# La decisión no se pudo aplicar: se borra, se avisa y la ficha (si sigue en pending/) anota por qué.
decision_no_aplicada(){ # <archivo de la decisión> <ficha o vacío> <id> <por qué>
  rm -f "$1"; S_TOCO=1
  aviso "$3: la decisión del sitio no se aplicó — $4"
  [ -z "$2" ] || encolar "$2" decision-fallida "$HOY" "$4"
}

# El JSON del comentario de un rechazo, escrito por node desde sus argumentos. Un `@` del motivo no menciona a nadie
# desde la cuenta de la noche.
comentario_de_rechazo(){ # <archivo> <el> <motivo> azure|github
  node -e 'const [f,el,m,pl]=process.argv.slice(1);
    const texto="Se rechazó en el sitio el "+el+". Motivo: "+m.replace(/@/g,"@​");
    require("fs").writeFileSync(f, JSON.stringify(pl==="azure"
      ? { comments:[{ parentCommentId:0, content:texto, commentType:1 }], status:4 }
      : { body:texto }));' "$@" 2>"$ERR"
}

# El estado de un pull request por su número: imprime «<estado> <punta de la rama que Azure ya vio>».
estado_y_fuente(){ # <pr>
  local OUT
  OUT=$(pr_por_id "$1") || return 1
  if [ "$PLATAFORMA" = github ]; then
    printf '%s' "$OUT" | campo_pr 2>"$ERR" | awk '{print $2" -"}'; return "${PIPESTATUS[1]}"
  fi
  printf '%s' "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    let p; try { p=JSON.parse(d); } catch { process.stderr.write("respuesta ilegible de az\n"); process.exit(1); }
    if (!p||!p.status) { process.stderr.write("la respuesta no trae el estado del pull request\n"); process.exit(1); }
    console.log(p.status+" "+(((p.lastMergeSourceCommit||{}).commitId)||"-")+" "+(p.mergeStatus||"-")+" "+(p.sourceRefName||"-")); });' 2>"$ERR"
}

# Mergea el pull request con la rama recién empujada. Sale 0 si quedó mergeado, 1 si la plataforma dijo que no (el
# porqué en $ERR) y 2 si no se pudo confirmar: la decisión queda y se reintenta mañana, sin tocar la ficha.
mergear_pr(){ # <pr> <commit de la rama>
  local K=0 E F MS J
  if [ "$PLATAFORMA" = github ]; then
    J=$(mktemp) || return 2
    node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ sha:process.argv[2], merge_method:"squash" }))' "$J" "$2" || { rm -f "$J"; return 2; }
    # GitHub calcula si se puede juntar después del empuje: un 405 o un 409 recién empujado se reintenta un rato
    until gh_cmd api --method PUT "repos/$REPO/pulls/$1/merge" --input "$J" >/dev/null 2>"$ERR"; do
      grep -qE 'HTTP (405|409)' "$ERR" && [ "$K" -lt "$ESPERA" ] || { rm -f "$J"; cp "$ERR" "$ERR.merge"; read -r E _ < <(estado_y_fuente "$1" 2>/dev/null); mv "$ERR.merge" "$ERR"; [ "${E:-}" = completed ] && return 0; [ -n "${E:-}" ] || return 2; return 1; }
      sleep 5; K=$((K+5))
    done
    rm -f "$J"; return 0
  fi
  # Azure: el pull request toma la rama nueva por su cuenta, y completarlo antes juntaría la punta vieja
  while :; do
    read -r E F MS < <(estado_y_fuente "$1") || return 2
    [ "$F" = "$2" ] && break
    [ "$K" -lt "$ESPERA" ] || { echo "Azure todavía no tomó la rama rehecha del pull request" > "$ERR"; return 2; }
    sleep 5; K=$((K+5))
  done
  az repos pr update --org "$ORG" --id "$1" --status completed --squash true --delete-source-branch true -o none 2>"$ERR" || return 1
  K=0
  while :; do
    read -r E F MS < <(estado_y_fuente "$1") || return 2
    case "$E" in
      completed) return 0 ;;
      abandoned) echo "el pull request quedó abandonado" > "$ERR"; return 1 ;;
    esac
    case "$MS" in conflicts|failure|rejectedByPolicy) echo "Azure no lo pudo juntar (mergeStatus: $MS)" > "$ERR"; return 1 ;; esac
    [ "$K" -lt "$ESPERA" ] || { echo "Azure todavía no terminó de juntarlo" > "$ERR"; return 2; }
    sleep 5; K=$((K+5))
  done
}

aceptar_pedido(){ # <ficha> <id> <pr> <el> <archivo de la decisión>
  local F="$1" ID="$2" N="$3" EL="$4" DA="$5" MAIN COMMIT RC
  if ! git fetch -q origin main 2>"$ERR" || ! MAIN=$(git rev-parse --verify -q 'FETCH_HEAD^{commit}'); then
    fallo "$ID: no se pudo traer origin/main para mergear el ${NR}$N que se aceptó en el sitio — se reintenta mañana — $(cat "$ERR")"; return
  fi
  if [ "$PLATAFORMA" = azure ]; then
    local SRC=""
    if ! read -r _ _ _ SRC < <(estado_y_fuente "$N"); then
      fallo "$ID: no se pudo consultar el ${NR}$N que se aceptó en el sitio — se reintenta mañana — $(cat "$ERR")"; return
    fi
    if [ "$SRC" != "refs/heads/$PREFIJO/$ID" ]; then
      decision_no_aplicada "$DA" "$F" "$ID" "el ${NR}$N sale de la rama ${SRC#refs/heads/}, no de la de la ficha: la noche no la puede rehacer"; return
    fi
  fi
  if ! COMMIT=$(commit_de_rama "$MAIN" "$ID" "$EL" 2>"$ERR"); then
    decision_no_aplicada "$DA" "$F" "$ID" "no se pudo rehacer la rama del ${NR}$N: $(cat "$ERR")"; return
  fi
  if ! empujar_rama "$COMMIT" "$PREFIJO/$ID"; then
    fallo "$ID: no se pudo empujar la rama del ${NR}$N que se aceptó en el sitio — se reintenta mañana — $(cat "$ERR")"; return
  fi
  mergear_pr "$N" "$COMMIT"; RC=$?
  case "$RC" in
    0) ;;
    2) if [ "$(dias_entre "$EL" "$HOY")" -ge "$NOCHES_SIN_CONFIRMAR" ]; then
         decision_no_aplicada "$DA" "$F" "$ID" "no se pudo confirmar que el ${NR}$N quedó mergeado en $NOCHES_SIN_CONFIRMAR noches: $(cat "$ERR")"
       else
         aviso "$ID: el ${NR}$N se aceptó en el sitio y no se pudo confirmar que quedó mergeado — la decisión queda y se mira mañana — $(cat "$ERR")"
       fi
       return ;;
    *) decision_no_aplicada "$DA" "$F" "$ID" "no se pudo mergear el ${NR}$N: $(cat "$ERR")"; return ;;
  esac
  # el disco queda como `main`: la ficha, tal como la llevó la rama, en promoted/
  if git show "$COMMIT:$COLA/promoted/$ID.yaml" > "$COLA/promoted/$ID.yaml.tmp" 2>"$ERR"; then
    mv "$COLA/promoted/$ID.yaml.tmp" "$COLA/promoted/$ID.yaml" 2>"$ERR" && rm -f "$F" \
      || aviso "$ID: el ${NR}$N quedó mergeado, pero no pude mover la ficha en el disco — la trae el main de mañana — $(cat "$ERR")"
  else
    rm -f "$COLA/promoted/$ID.yaml.tmp"
    aviso "$ID: el ${NR}$N quedó mergeado, pero no pude copiar la ficha al disco — la trae el main de mañana — $(cat "$ERR")"
  fi
  rm -f "$DA"; S_TOCO=1
  echo "$ID: mergeado el ${NR}$N (se aceptó en el sitio el $EL)"
}

# Cierra el pull request sin el comentario de la noche (`cerrar_pr` dice «la ficha salió de la cola»: acá decidió una persona).
cerrar_rechazado(){ # <pr>
  if [ "$PLATAFORMA" = azure ]; then az repos pr update --org "$ORG" --id "$1" --status abandoned -o none 2>"$ERR"; return; fi
  local J R; J=$(mktemp) || return 1
  printf '{"state":"closed"}' > "$J"
  gh_cmd api --method PATCH "repos/$REPO/pulls/$1" --input "$J" >/dev/null 2>"$ERR"; R=$?
  rm -f "$J"; return "$R"
}
comentar_pr(){ # <pr> <archivo del comentario>
  if [ "$PLATAFORMA" = azure ]; then
    az devops invoke --org "$ORG" --area git --resource pullRequestThreads \
      --route-parameters "project=$PROYECTO" "repositoryId=$REPO" "pullRequestId=$1" \
      --http-method POST --in-file "$2" --api-version 7.1 -o none 2>"$ERR"; return
  fi
  gh_cmd api --method POST "repos/$REPO/issues/$1/comments" --input "$2" >/dev/null 2>"$ERR"
}

rechazar_pedido(){ # <ficha> <id> <pr> <el> <motivo> <archivo de la decisión>
  local F="$1" ID="$2" N="$3" EL="$4" MOT="$5" DA="$6" J
  if ! cerrar_rechazado "$N"; then
    fallo "$ID: no se pudo cerrar el ${NR}$N que se rechazó en el sitio — se reintenta mañana — $(cat "$ERR")"; return
  fi
  # Primero se cierra y después se comenta: si el comentario falla, el rechazo ya está hecho y el motivo queda en la ficha.
  J=$(mktemp)
  if ! comentario_de_rechazo "$J" "$EL" "$MOT" "$PLATAFORMA" || ! comentar_pr "$N" "$J"; then
    aviso "$ID: el ${NR}$N quedó cerrado, pero no se pudo dejar el motivo como comentario — queda en la ficha — $(cat "$ERR")"
  fi
  rm -f "$J" "$DA"; S_TOCO=1
  S_RECHAZADAS="$S_RECHAZADAS$ID "
  echo "$ID: cerrado el ${NR}$N (se rechazó en el sitio el $EL)"
  encolar "$F" rechazado "$EL|$N" "$MOT"
  alinear_issues "$F" "$N" closed "$MOT"
}

case "$COLA" in */dependencies|dependencies) S_COLA=1 ;; *) S_COLA="" ;; esac
if [ -z "$SIN_GUARDAR" ] && [ -n "$S_COLA" ] && [ -d "$COLA/decisions" ]; then
  DECS=""
  if ! DECS=$(node "$_AQUI_LO/../nightly/findings/cycle.js" site-decisions --dir "$COLA/decisions" 2>"$ERR"); then
    fallo "no pude leer las decisiones del sitio — se reintenta mañana — $(cat "$ERR")"; DECS=""
  fi
  while IFS=$'\t' read -r D_ID D_ACC D_PR D_REPO _ D_EL D_MOT; do
    [ -n "${D_ID:-}" ] || continue
    [ "$D_REPO" != - ] || D_REPO=""
    D_MOT="${D_MOT#:}"
    if ! [[ "$D_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
      fallo "una decisión del sitio con un nombre fuera de [A-Za-z0-9_-] («$(printf '%s' "$D_ID" | tr -c 'A-Za-z0-9_.-' '?')»): no se toca"; continue
    fi
    DA="$COLA/decisions/$D_ID.json"; F="$COLA/pending/$D_ID.yaml"
    # la ficha ya se decidió por otro camino (o se resolvió sola): no hay nada que aplicar ni dónde anotarlo
    if [ ! -f "$F" ] || ! grep -qE '^veredicto:[ \t]*"?pendiente"?[ \t]*(#.*)?$' "$F" || grep -q '^rechazado:' "$F"; then
      rm -f "$DA"; S_TOCO=1; aviso "$D_ID: la decisión del sitio llegó cuando la ficha ya no estaba pendiente de decidir: no se aplica"; continue
    fi
    ficha_valida "$F" || continue
    PR=$(escalar "$F" pr); PR_REPO_F=$(escalar "$F" pr_repo)
    if [ "$PR" != "$D_PR" ] || [ "$PR_REPO_F" != "$D_REPO" ]; then
      decision_no_aplicada "$DA" "$F" "$D_ID" "el pull request de la ficha cambió: se decidió sobre el ${NR}$D_PR${D_REPO:+ de $D_REPO} y la ficha tiene ${PR:+el ${NR}$PR}${PR:-ninguno}${PR_REPO_F:+ de $PR_REPO_F}"; continue
    fi
    if { [ "$PLATAFORMA" = github ] && [ "$PR_REPO_F" != "$REPO" ]; } || { [ "$PLATAFORMA" = azure ] && [ -n "$PR_REPO_F" ]; }; then
      decision_no_aplicada "$DA" "$F" "$D_ID" "el ${NR}$PR es de ${PR_REPO_F:-otra plataforma}, no de $DONDE: desde acá no se puede aplicar"; continue
    fi
    if ! OUT=$(pr_por_id "$PR"); then
      fallo "$D_ID: no se pudo consultar el ${NR}$PR para aplicar la decisión del sitio — se reintenta mañana — $(cat "$ERR")"; continue
    fi
    if ! LEIDO=$(printf '%s' "$OUT" | campo_pr 2>"$ERR") || ! OWNER=$(printf '%s' "$OUT" | pr_owner 2>"$ERR"); then
      fallo "$D_ID: no pude leer la respuesta sobre el ${NR}$PR para aplicar la decisión del sitio — se reintenta mañana — $(cat "$ERR")"; continue
    fi
    read -r _ ESTADO _ _ <<< "$LEIDO"
    if [ "$OWNER" != own ]; then
      decision_no_aplicada "$DA" "$F" "$D_ID" "el ${NR}$PR es de otro repo (${OWNER#foreign }), no de $DONDE"; continue
    fi
    if [ "$ESTADO" != active ]; then
      decision_no_aplicada "$DA" "$F" "$D_ID" "el ${NR}$PR ya no está abierto ($ESTADO)"; continue
    fi
    case "$D_ACC" in
      aceptar)  aceptar_pedido "$F" "$D_ID" "$PR" "$D_EL" "$DA" ;;
      reject) rechazar_pedido "$F" "$D_ID" "$PR" "$D_EL" "$D_MOT" "$DA" ;;
    esac
  done <<< "$DECS"
fi

# ── Fase A — decidir por ficha ─────────────────────────────────────────────────────────────────
ABRIR=""
# Con el sitio andando (`site.url` en operations.json) las fichas se deciden ahí: no se abre un pedido nuevo por ficha,
# y los ya abiertos siguen como siempre (adoptar, anotar el rechazo, cerrar el de una archivada) hasta cerrarse.
# Si no se puede preguntar, se dice y se sigue como sin sitio: un pedido de más se cierra; una ficha sin dónde
# decidirse espera noches en silencio.
SITIO_DECIDE=""
if [ -z "$SOLO_REGISTRAR$SIN_GUARDAR" ]; then
  CICLO="$_AQUI_LO/../nightly/findings/cycle.js"
  if [ ! -f "$CICLO" ]; then
    aviso "no está cycle.js junto al guion: no se pudo preguntar si el sitio decide — se abren pedidos como sin sitio"
  else
    SITIO_MOTIVO=$(node "$CICLO" site-decides --operations operations.json 2>&1); SITIO_RC=$?
    case "$SITIO_RC" in
      0) SITIO_DECIDE=1; echo "$SITIO_MOTIVO" ;;
      1) ;;
      *) aviso "${SITIO_MOTIVO:-no se pudo preguntar si el sitio decide} — se abren pedidos como sin sitio" ;;
    esac
  fi
fi
# Con --record-only esta pasada no abre nada (ver «DOS PASADAS POR NOCHE»): dice quién lo abre.
por_abrir(){ # <id> <qué encontró> [<qué se abre>]
  if [ -n "$SOLO_REGISTRAR$SIN_GUARDAR" ]; then echo "$1: $2 — no se abre en esta pasada: lo abre el último paso de la noche"
  elif [ -n "$SITIO_DECIDE" ]; then echo "$1: $2 — no se abre: la ficha se decide en el sitio"
  else echo "$1: $2 — se abre${3:-}"; ABRIR="$ABRIR $1"; fi
}
for F in "$COLA"/pending/*.yaml; do
  [ -f "$F" ] || continue
  # 🔴 El MISMO criterio de «está viva» que usa el lector de la cola (`leerFicha`), que descarta el
  # comentario al final de la línea y las comillas. Con una igualdad exacta, una ficha con una
  # nota humana —`veredicto: pendiente # decision-en-curso`, formato que el nocturno soporta a
  # propósito y que su propio caso 21 verifica— quedaría fuera de TODO el manejo de pull requests, en
  # silencio: no se le abriría uno, no se le adoptaría, no se le anotaría el rechazo, y terminaría
  # archivada como «ignorado». Dos criterios distintos de «viva» en el mismo sistema se separan solos.
  grep -qE '^veredicto:[ \t]*"?pendiente"?[ \t]*(#.*)?$' "$F" || continue
  ID=$(basename "$F" .yaml)
  # la que se rechazó recién en el sitio ya está decidida: su motivo lo escribió la noche y `motivo_de` no lo leería
  case "$S_RECHAZADAS" in *" $ID "*) continue ;; esac
  ficha_valida "$F" || continue
  PR=$(escalar "$F" pr)

  # 🔴 EN GITHUB EL NÚMERO ES DE CADA REPO: `pr: 12` sin decir de qué repo no es un pull request, y preguntar por el 12
  # de este repo contestaría OTRO (o un issue). Se decide por `pr_repo:` antes de consultar nada. En Azure, una ficha
  # con `pr_repo:` trae un pull request de GitHub: tampoco es de acá.
  PR_REPO_F=$(escalar "$F" pr_repo)
  if [ -n "$PR" ] && { { [ "$PLATAFORMA" = github ] && [ "$PR_REPO_F" != "$REPO" ]; } || { [ "$PLATAFORMA" = azure ] && [ -n "$PR_REPO_F" ]; }; }; then
    if grep -q '^rechazado:' "$F"; then
      echo "$ID: ya estaba anotado el rechazo (su pr: $PR es de ${PR_REPO_F:-un repo sin nombrar}, no de $DONDE: no se mira su estado)"; continue
    fi
    aviso "$ID: su pr: $PR es de ${PR_REPO_F:-un repo sin nombrar (falta pr_repo:)}, no de $DONDE: acá no cuenta. Se busca su pull request en este repo"
    PR=""
  fi

  if [ -n "$PR" ]; then
    if ! OUT=$(pr_por_id "$PR"); then
      fallo "$ID: no se pudo consultar el ${NR}$PR — $(cat "$ERR")"; continue
    fi
    if ! LEIDO=$(printf '%s' "$OUT" | campo_pr 2>"$ERR"); then
      fallo "$ID: no pude leer la respuesta de Azure sobre el ${NR}$PR — $(cat "$ERR")"; continue
    fi
    read -r _ ESTADO _ CERRADO <<< "$LEIDO"
    if ! OWNER=$(printf '%s' "$OUT" | pr_owner 2>"$ERR"); then
      fallo "$ID: no pude leer de qué repo es el ${NR}$PR — $(cat "$ERR")"; continue
    fi
    if [ "$OWNER" != own ]; then
      # 🔴 Un rechazo YA anotado es un dato de la ficha, no del pull request: se respeta venga de donde venga
      # (en dependencias la ficha rechazada sigue viva, con su `pr:` y su `rechazado:`), y no se vuelve a preguntar.
      if grep -q '^rechazado:' "$F"; then
        echo "$ID: ya estaba anotado el rechazo (su ${NR}$PR es de otro repo, ${OWNER#foreign }: no se mira su estado)"; continue
      fi
      # Lo que el otro repo diga de ese pull request NO decide esta ficha: ni «activo» es un lugar donde decidirla,
      # ni «abandonado» es un rechazo (es lo que queda al ordenar una mudanza). Se sigue como si no tuviera `pr:`:
      # se busca por la rama EN ESTE repo y, si no hay, se abre uno acá, que reemplaza el número en la ficha.
      aviso "$ID: su pr: ${NR#PR }$PR es de otro repo (${OWNER#foreign }, $ESTADO), no de $DONDE: acá no cuenta. Se busca su pull request en este repo; el de allá queda como está (si sigue abierto, hay que cerrarlo a mano)"
      PR=""
    fi
  fi
  if [ -z "$PR" ]; then
    if ! OUT=$(pr_por_rama "$PREFIJO/$ID"); then
      fallo "$ID: no se pudo consultar los PR de $PREFIJO/$ID — $(cat "$ERR")"; continue
    fi
    if ! LEIDO=$(printf '%s' "$OUT" | mas_reciente 2>"$ERR"); then
      fallo "$ID: no pude leer la lista de PR de $PREFIJO/$ID — $(cat "$ERR")"; continue
    fi
    # `SIN_PR` es «pregunté y no hay ninguno», que NO es lo mismo que «no pude preguntar»: eso ya
    # salió por el `if` de arriba.
    if [ "$LEIDO" = SIN_PR ]; then
      por_abrir "$ID" "sin pull request"; continue
    fi
    read -r PR ESTADO CREADO CERRADO <<< "$LEIDO"
    if [ "$ESTADO" != "active" ]; then
      # 🔴 Sólo se adopta como rechazo lo que nació DENTRO de la vida actual de la ficha. Una ficha
      # que reapareció arrastra ramas con pull requests de su vida anterior (uno completado, por
      # ejemplo): adoptarlos la dejaría sin ningún lugar donde decidirse, para siempre.
      DESDE=$(escalar "$F" reaparecido); [ -n "$DESDE" ] || DESDE=$(escalar "$F" detectado)
      [ -n "$DESDE" ] || DESDE=$(escalar "$F" fecha)
      if [ "$ESTADO" != "abandoned" ] || [ -z "${CREADO:-}" ] || [ -z "$DESDE" ] || [[ "$CREADO" < "$DESDE" ]]; then
        por_abrir "$ID" "el ${NR}$PR ($ESTADO, $CREADO) es de una vida anterior" " uno nuevo"; continue
      fi
      # 🔴 Y un pull request que cerró LA NOCHE (la fase E, al archivar o resolver la ficha) no es la decisión de nadie:
      # si la ficha vuelve ese mismo día, la fecha no lo separa de esta vida, y adoptarlo anotaría un rechazo «sin
      # motivo escrito» que además cierra el issue del producto como «not planned». Se lo reconoce por su marca.
      if [ "$PLATAFORMA" = github ]; then
        if ! NOCHE=$(cerrado_por_la_noche "$PR"); then
          fallo "$ID: no pude leer los comentarios del ${NR}$PR para saber quién lo cerró — $(cat "$ERR")"; continue
        fi
        if [ "$NOCHE" = si ]; then
          por_abrir "$ID" "el ${NR}$PR lo cerró la noche al cerrar la ficha: no es una decisión" " uno nuevo"; continue
        fi
      fi
    fi
  fi

  case "$ESTADO" in
    active)
      # sin `pr:`, con el de otro repo, o (en GitHub) sin decir de qué repo es: no cuenta, se adopta
      if [ "$(escalar "$F" pr)" != "$PR" ] || { [ "$PLATAFORMA" = github ] && [ "$PR_REPO_F" != "$REPO" ]; }; then
        echo "$ID: adoptado el ${NR}$PR que ya existía"
        encolar "$F" pr "$PR"
        # Alguien pudo REACTIVAR en Azure un pull request que se había rechazado: la ficha lo tiene
        # anotado y hay que borrarlo, o quedaría "rechazada" con su PR abierto pidiendo decisión.
      else
        echo "$ID: ya tiene el ${NR}$PR"
      fi
      grep -q '^rechazado:' "$F" && { echo "$ID: el ${NR}$PR volvió a estar activo — se borra el rechazo"; encolar "$F" quitar-rechazo; }
      # el issue que la noche cerró por ese rechazo se reabre (decisión 12)
      [ "$(escalar "$F" alineado)" = "$PR:closed" ] && alinear_issues "$F" "$PR" reopened ""
      ;;
    abandoned)
      if grep -q '^rechazado:' "$F"; then
        echo "$ID: ya estaba anotado el rechazo del ${NR}$PR"
        alinear_issues "$F" "$PR" closed "$(sed -n 's/^motivo_rechazo:[ \t]*//p' "$F" | head -1 | sed -e 's/^"//' -e 's/"$//')"
      elif ! HILOS=$(hilos_de "$PR"); then
        # "No pude leer el motivo" NO es "sin motivo escrito": no se anota nada y mañana se reintenta.
        fallo "$ID: no se pudo leer los comentarios del ${NR}$PR — $(cat "$ERR")"
      elif ! CRUDO=$(printf '%s' "$HILOS" | motivo_de 2>"$ERR"); then
        fallo "$ID: no pude leer el motivo del rechazo del ${NR}$PR — $(cat "$ERR")"
      else
        # 🔴 Se sanea ACÁ, en el punto de entrada: antes de imprimirlo y antes de encolarlo.
        MOTIVO=$(sanear "$CRUDO")
        echo "$ID: rechazado el ${CERRADO:-$HOY} — «${MOTIVO}»"
        encolar "$F" rechazado "${CERRADO:-$HOY}|$PR" "$MOTIVO"
        alinear_issues "$F" "$PR" closed "$MOTIVO"
      fi
      ;;
    completed)
      aviso "$ID: su ${NR}$PR está completado pero la ficha sigue en pending/ — revisar a mano"
      ;;
    *)
      fallo "$ID: el ${NR}$PR devolvió un estado que no sé interpretar («${ESTADO}»)"
      ;;
  esac
done

# ── Fase E — toda ficha archivada cierra su pull request ───────────────────────────────────────
# 🔴 El barrido es sobre `archived/*.yaml`, no sobre los ignorados de ESTA noche. Con la lista de
# la noche, un cierre que falló ayer no se reintenta nunca más y el pull request queda abierto para
# siempre; y una ficha archivada por deuda declarada —que no pasa por «ignorado»— no la cierra
# nadie. Un pull request abierto sobre algo que el sistema ya dio por perdido pide una decisión
# sobre un muerto, y esa clase de pull request es la que enseña a no mirar la lista.
# 🔴 Y también sobre `promoted/`: una ficha que se resuelve sola por medición se mueve de `pending/`
# a `promoted/` LLEVÁNDOSE su `pr:`, y desde ahí su pull request no lo cerraría nadie — ni la fase A
# (ya no está en `pending/`) ni un barrido que sólo mirara `archived/`. Quedaría abierto para siempre.
for F in "$COLA"/archived/*.yaml "$COLA"/promoted/*.yaml; do
  [ -f "$F" ] || continue
  ID=$(basename "$F" .yaml)
  grep -q '^pr_cerrado:' "$F" && continue
  ficha_valida "$F" || continue
  # En `promoted/` sólo se cierra la que YA se resolvió: una aceptada que sigue viva necesita su
  # pull request abierto, que es donde se decidió arreglarla. Con el sitio, no: la decisión se tomó ahí y el pull
  # request viejo de la noche ya no tiene nada que decidir.
  case "$F" in
    */promoted/*) grep -q '^resuelto:' "$F" \
      || { [ -n "$SITIO_DECIDE" ] && grep -qE '^veredicto:[ \t]*"?util"?[ \t]*$' "$F"; } || continue ;;
  esac
  PR=$(escalar "$F" pr)
  if [ -z "$PR" ]; then echo "$ID: cerrada sin pr: — no sé qué PR cerrar"; continue; fi
  PR_REPO_F=$(escalar "$F" pr_repo)
  # Un `pr:` de la OTRA plataforma (en GitHub, sin `pr_repo:`; en Azure, con él) no se puede ni consultar desde acá:
  # se avisa una vez y se anota `pr_cerrado:`, o la ficha avisaría cada noche para siempre. El de otro repo de GitHub
  # sí puede cerrarlo alguien allá: se dice y se vuelve a mirar mañana.
  if { [ "$PLATAFORMA" = github ] && [ -z "$PR_REPO_F" ]; } || { [ "$PLATAFORMA" = azure ] && [ -n "$PR_REPO_F" ]; }; then
    aviso "$ID: cerrada con un pr: $PR de la otra plataforma: este guion no lo puede cerrar (si sigue abierto, hay que cerrarlo a mano); se anota y no se vuelve a mirar"
    encolar "$F" pr-cerrado "$HOY"; continue
  fi
  if [ "$PLATAFORMA" = github ] && [ "$PR_REPO_F" != "$REPO" ]; then
    echo "$ID: cerrada con su pr: $PR de $PR_REPO_F, no de $DONDE — este guion no lo cierra"; continue
  fi
  if ! OUT=$(pr_por_id "$PR"); then
    # Un pull request que Azure dice que no está (TF401180: lo borraron, o era de un repo que ya no existe) es una
    # respuesta, no un «no pude preguntar»: no queda nada que cerrar. Se anota y no se vuelve a mirar; si no, la ficha
    # pondría roja cada noche para siempre. Cualquier otro error sigue siendo un fallo.
    if [ "$PLATAFORMA" = azure ] && grep -q 'TF401180' "$ERR"; then
      aviso "$ID: su ${NR}$PR ya no existe (Azure: TF401180): no hay nada que cerrar; se anota y no se vuelve a mirar"
      encolar "$F" pr-cerrado "$HOY"; continue
    fi
    fallo "$ID: no se pudo consultar el ${NR}$PR de una ficha cerrada — $(cat "$ERR")"; continue
  fi
  if ! LEIDO=$(printf '%s' "$OUT" | campo_pr 2>"$ERR"); then
    # 🔴 Con un JSON ilegible, ESTADO quedaría vacío, caería en el `else` de abajo y escribiría
    # `pr_cerrado:` sobre un pull request que podría seguir ABIERTO — y como arriba hay un
    # `grep -q '^pr_cerrado:' && continue`, esa ficha NO se volvería a mirar nunca. Enterrado, en
    # verde, sin pasar por `fallo()`. Es el peor de los tres casos.
    fallo "$ID: no pude leer la respuesta de Azure sobre el ${NR}$PR — $(cat "$ERR")"; continue
  fi
  read -r _ ESTADO _ CERRADO <<< "$LEIDO"
  if ! OWNER=$(printf '%s' "$OUT" | pr_owner 2>"$ERR"); then
    fallo "$ID: no pude leer de qué repo es el ${NR}$PR de una ficha cerrada — $(cat "$ERR")"; continue
  fi
  if [ "$ESTADO" = "active" ] && [ "$OWNER" != own ]; then
    # 🔴 Este guion no escribe en otro repo: no abandona el pull request ni lo da por cerrado (sigue abierto). Avisa
    # cada noche hasta que alguien lo cierre allá; desde entonces cae en el `else` de abajo y se anota su cierre.
    aviso "$ID: su ${NR}$PR sigue abierto en otro repo (${OWNER#foreign }): este guion no cierra pull requests de otro repo — hay que cerrarlo a mano; se vuelve a mirar mañana"
    continue
  fi
  # La pasada de antes de la noche corre en GitHub con permiso de leer: el cierre lo hace la completa. Intentarlo acá
  # daría un 403 que se lee como fallo justo las noches en que hay algo que cerrar.
  if [ "$ESTADO" = "active" ] && [ "$PLATAFORMA" = github ] && [ -n "$SOLO_REGISTRAR$SIN_GUARDAR" ]; then
    echo "$ID: su ${NR}$PR se cierra en la pasada completa de la noche"; continue
  fi
  if [ "$ESTADO" = "active" ]; then
    if cerrar_pr "$PR" "$ID" "$F"; then
      echo "${NR}$PR abandonado con su ficha ($ID)"
      encolar "$F" pr-cerrado "$HOY"
      # Borrar la rama no decide nada: si falla, no cambia el resultado de la noche.
      git push -q origin --delete "$PREFIJO/$ID" || true
    else
      fallo "$ID: no se pudo abandonar el ${NR}$PR — $(cat "$ERR")"
    fi
  else
    echo "${NR}$PR de $ID ya estaba $ESTADO"
    encolar "$F" pr-cerrado "${CERRADO:-$HOY}"
  fi
done

# Una ficha que llegó a `promoted/` por el merge de su pull request: su issue se reabre si estaba cerrado como
# «not planned» (decisión 12). Se confirma con GitHub que el pull request está mergeado: la carpeta sola no lo prueba.
if [ "$PLATAFORMA" = github ] && [ -z "$SOLO_REGISTRAR" ]; then
  for F in "$COLA"/promoted/*.yaml; do
    [ -f "$F" ] || continue
    grep -q '^resuelto:' "$F" && continue
    ficha_valida "$F" || continue
    PR=$(escalar "$F" pr)
    [ -n "$PR" ] && [ "$(escalar "$F" pr_repo)" = "$REPO" ] || continue
    [ "$(escalar "$F" alineado)" != "$PR:merged" ] || continue
    grep -q '^pedidos:' "$F" || continue
    ID=$(basename "$F" .yaml)
    if ! OUT=$(pr_por_id "$PR") || ! LEIDO=$(printf '%s' "$OUT" | campo_pr 2>"$ERR"); then
      fallo "$ID: no se pudo consultar el #$PR para alinear sus issues — $(cat "$ERR")"; continue
    fi
    read -r _ ESTADO _ _ <<< "$LEIDO"
    [ "$ESTADO" = completed ] && alinear_issues "$F" "$PR" merged ""
  done
fi

# ── Fase B — abrir los que nunca tuvieron pull request ─────────────────────────────────────────
# El pull request NO transporta el borrador: transporta LA DECISIÓN. El borrador ya está en `main`
# desde el paso anterior del pipeline, y tiene que estarlo: si viviera sólo en la rama, la corrida
# de mañana no lo vería, lo tomaría como nuevo y abriría otro cada noche — con la cuenta de noches
# seguidas clavada en 1, que es justo la señal de que algo se está agravando.
if [ -n "$SOLO_REGISTRAR$SIN_GUARDAR" ]; then
  echo "Sólo registrar: esta pasada no abre pull requests (los abre el último paso de la noche)."
elif [ -z "${ABRIR// }" ]; then
  echo "Nada que abrir: ninguna ficha pendiente quedó sin pull request."
fi
MAIN_AL_ABRIR=""
if [ -n "${ABRIR// }" ]; then
  # La rama de cada pedido sale del `main` PUBLICADO, traído ahora: el borrador de esta noche ya está ahí
  # (lo guardó el paso anterior del pipeline). Sin poder traerlo no se abre nada, y se dice.
  if git fetch -q origin main 2>"$ERR" && MAIN_AL_ABRIR=$(git rev-parse --verify -q 'FETCH_HEAD^{commit}'); then :; else
    fallo "no se pudo traer origin/main para abrir los pull requests de esta noche — $(cat "$ERR")"
    ABRIR=""
  fi
fi
for ID in ${ABRIR:-}; do   # con --record-only viene vacío: `por_abrir` no agrega nada
  RAMA="$PREFIJO/$ID"
  # ¿El borrador está en `main`? «No pude preguntar» no es «no está»: si git falla, es un fallo de la noche
  # (un `cat-file -e` que fallara por lo que fuera daría sólo un aviso, y el pedido no se abriría en verde).
  if ! EN_MAIN=$(git ls-tree "$MAIN_AL_ABRIR" -- "$COLA/pending/$ID.yaml" 2>"$ERR"); then
    fallo "$ID: no se pudo leer main para buscar el borrador — no se abre el PR — $(cat "$ERR")"; continue
  fi
  [ -n "$EN_MAIN" ] || { aviso "$ID: no está el borrador, salteado"; continue; }

  # el texto del pedido se arma con la ficha de `main`, sacada a un archivo aparte: el checkout no se toca
  if ! git show "$MAIN_AL_ABRIR:$COLA/pending/$ID.yaml" > "$TEXTOS/pr-card-$ID.yaml" 2>"$ERR"; then
    fallo "$ID: no se pudo sacar el borrador de main — no se abre el PR — $(cat "$ERR")"; continue
  fi
  DESTINO=(); [ "$PLATAFORMA" = github ] && DESTINO=(--destination pr-github --pr-repo "$REPO")
  if ! node "$GUION" pr-text --draft "$TEXTOS/pr-card-$ID.yaml" ${DESTINO[@]+"${DESTINO[@]}"} > "$TEXTOS/pr-$ID.txt" 2>"$ERR"; then
    fallo "$ID: no se pudo armar el texto del PR — no se abre — $(cat "$ERR")"; continue
  fi
  TITULO=$(head -1 "$TEXTOS/pr-$ID.txt")
  # un pedido sin título no lo decide nadie: no se abre vacío
  [ -n "$TITULO" ] || { fallo "$ID: el texto del PR salió sin título — no se abre"; continue; }
  sed -n '/^---CUERPO---$/,$p' "$TEXTOS/pr-$ID.txt" | tail -n +2 > "$TEXTOS/pr-body-$ID.md"

  if ! COMMIT_RAMA=$(commit_de_rama "$MAIN_AL_ABRIR" "$ID" 2>"$ERR"); then
    fallo "$ID: no se pudo armar la rama $RAMA — el borrador sigue en main — $(cat "$ERR")"; continue
  fi
  # 🔴 Un push rechazado no puede dejar la corrida trabada: sin permiso de crear ramas el push
  # falla, se intentaría igual el pull request (falla), y el paso moriría sin decir QUÉ faltaba.
  if ! empujar_rama "$COMMIT_RAMA" "$RAMA"; then
    if [ "$PLATAFORMA" = azure ]; then QUE="tiene 'Create branch'"; else QUE="tiene contents: write"; fi
    fallo "$ID: no se pudo publicar la rama $RAMA (¿la identidad del pipeline $QUE?) — el borrador sigue en main — $(cat "$ERR")"
    continue
  fi

  if ! NUEVO=$(crear_pr "$RAMA" "$TITULO" "$TEXTOS/pr-body-$ID.md" "$ID"); then
    fallo "$ID: no se pudo abrir el PR — el borrador está en main, revisar en $COLA/pending/ — $(cat "$ERR")"
    continue
  fi
  # 🔴 El CUARTO lector de JSON, con el mismo criterio que los otros tres: leer mal sale != 0 con su
  # motivo, y nunca vacío. Un `catch {}` mudo haría que el llamador tratara el vacío como fallo,
  # pero se perdería POR QUÉ, que es lo que uno necesita a la mañana siguiente.
  if ! PRID=$(printf '%s' "$NUEVO" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
      let p; try { p=JSON.parse(d); } catch { process.stderr.write("respuesta ilegible de az\n"); process.exit(1); }
      if (!p||p.pullRequestId===undefined||p.pullRequestId===null) {
        process.stderr.write("el pull request se creó pero la respuesta no trae su número\n"); process.exit(1);
      }
      console.log(p.pullRequestId);
    });' 2>"$ERR"); then
    fallo "$ID: el PR se abrió pero no pude leer su número — no se puede anotar (mañana se adopta) — $(cat "$ERR")"
    continue
  fi
  echo "$ID: abierto el ${NR}$PRID"
  echo "$ID $PRID" >> "$ABIERTOS"
  # 🔴 La ruta que se encola es la de `main`, donde la ficha SIGUE en `pending/`: moverla a
  # `promoted/` es lo que hace el pull request cuando alguien lo mergea, no algo que pase en `main`
  # esta noche. Encolar la ruta de la rama dejaría la anotación sin archivo que tocar.
  encolar "$COLA/pending/$ID.yaml" pr "$PRID"
done
# (No hace falta volver de las ramas con `git reset --hard HEAD` ni `git checkout main`: las ramas
# se arman sin copia de trabajo. El checkout queda donde estaba, con lo que la noche dejó en el disco.)

# ── Fase C — anotar todo junto en main ─────────────────────────────────────────────────────────
# 🔴 Rehacer la rama sobre el `main` ANOTADO es lo que evita el conflicto: el pull request mueve
# `pending/<id>.yaml` a `promoted/`, así que si `main` modifica ese archivo después, git da
# `CONFLICT (modify/delete)` al fusionar (reproducido en local).
# Las anotaciones se escriben sobre el DISCO del checkout: en la pasada de sólo registrar es lo que
# la noche va a contar, y en la del final el disco ya es lo que el paso anterior guardó en `main`.
PR_REPO_ARG=(); [ "$PLATAFORMA" = github ] && PR_REPO_ARG=(--pr-repo "$REPO")
if [ -s "$ACCIONES" ] || [ -n "$S_TOCO" ]; then
  while IFS=$'\t' read -r ARCHIVO OP A1 A2; do
    [ -n "$ARCHIVO" ] || continue
    [ -f "$ARCHIVO" ] || { aviso "$(basename "$ARCHIVO"): ya no está en main, no se anota"; continue; }
    case "$OP" in
      pr)             node "$GUION" note --card "$ARCHIVO" --pr "$A1" ${PR_REPO_ARG[@]+"${PR_REPO_ARG[@]}"} || fallo "$(basename "$ARCHIVO"): note --pr falló" ;;
      alineado)       node "$GUION" note --card "$ARCHIVO" --aligned "$A1" || fallo "$(basename "$ARCHIVO"): note --aligned falló" ;;
      pr-cerrado)     node "$GUION" note --card "$ARCHIVO" --pr-closed "$A1" || fallo "$(basename "$ARCHIVO"): note --pr-closed falló" ;;
      quitar-rechazo) node "$GUION" note --card "$ARCHIVO" --clear-rejection || fallo "$(basename "$ARCHIVO"): note --clear-rejection falló" ;;
      decision-fallida) node "$GUION" note --card "$ARCHIVO" --decision-failed "$A1" --reason "$A2" || fallo "$(basename "$ARCHIVO"): note --decision-failed falló" ;;
      rechazado)      node "$GUION" note --card "$ARCHIVO" --rejected "${A1%%|*}" --pr "${A1##*|}" ${PR_REPO_ARG[@]+"${PR_REPO_ARG[@]}"} --reason "$A2" \
                        || fallo "$(basename "$ARCHIVO"): note --rejected falló" ;;
    esac
  done < "$ACCIONES"

  # El único camino por el que los nocturnos guardan: lleva a `main` SÓLO la carpeta de la cola, sobre
  # la punta recién traída y con reintento, sin mover el checkout. Sale 0 también si no había nada nuevo.
  # Con --no-save lo anotado queda en el disco: lo lleva a `main` el guardado de un paso posterior (en GitHub, el
  # trabajo que escribe; el que lee no puede empujar). Sin guardar no hay ramas que rehacer: esta pasada no abre.
  if [ -n "$SIN_GUARDAR" ]; then
    echo "Anotaciones en el disco, sin guardar (--no-save): las lleva a main el guardado de la noche."
    [ "$FALLOS" = "0" ] || exit 1
    exit 0
  fi
  if ! node "$_AQUI_LO/push-nightly-data.js" save \
         --message "$COLA: pull requests anotados${SOLO_REGISTRAR:+ antes de la noche} $HOY [nocturno]" \
         -- "$COLA"; then
    # Los pull requests ya abiertos SE QUEDAN abiertos: mañana se adoptan por la rama (regla 1) y
    # no se crea ninguno nuevo. Por eso acá se sale sin rehacer las ramas: `main` no tiene el
    # `pr:`, así que la rama tal como quedó no choca con nada.
    # Con --record-only no hay ramas: lo anotado queda en el disco, la noche lo cuenta, y el paso
    # que guarda la noche —que incluye esta carpeta— lo vuelve a llevar (con su propio reintento).
    if [ -n "$SOLO_REGISTRAR" ]; then
      fallo "No se pudo publicar en main lo registrado — queda en el árbol: la noche lo cuenta y el paso del commit lo vuelve a empujar"
    else
      fallo "No se pudo publicar las anotaciones de PR en main — mañana se adoptan por la rama"
    fi
    exit 1
  fi
  echo "Anotaciones al día en main."

  # ── Fase D — rehacer la rama de cada pull request abierto ESTA noche ─────────────────────────
  # Desde el `main` ya anotado, traído de nuevo: la ficha lleva su `pr:` y la rama no choca al fusionar.
  if [ -s "$ABIERTOS" ]; then
    if git fetch -q origin main 2>"$ERR" && MAIN_ANOTADO=$(git rev-parse --verify -q 'FETCH_HEAD^{commit}'); then
      while read -r ID PRID; do
        [ -n "${ID:-}" ] || continue
        RAMA="$PREFIJO/$ID"
        # la ficha puede haber salido de pending/ en el camino (no hay rama que rehacer); un git que falla, no
        if ! EN_MAIN=$(git ls-tree "$MAIN_ANOTADO" -- "$COLA/pending/$ID.yaml" 2>"$ERR"); then
          fallo "$ID: no se pudo leer el main anotado para rehacer la rama del ${NR}$PRID — $(cat "$ERR")"; continue
        fi
        [ -n "$EN_MAIN" ] || continue
        if COMMIT_RAMA=$(commit_de_rama "$MAIN_ANOTADO" "$ID" 2>"$ERR") \
           && empujar_rama "$COMMIT_RAMA" "$RAMA"; then :; else
          fallo "$ID: no se pudo rehacer la rama del ${NR}$PRID sobre el main anotado — $(cat "$ERR")"
        fi
      done < "$ABIERTOS"
    else
      fallo "no se pudo traer el main anotado para rehacer las ramas de los pull requests de esta noche — $(cat "$ERR")"
    fi
  fi
fi

# Que un pull request no se abra NO es "una noche tranquila": es un hallazgo sin nadie que lo mire.
[ "$FALLOS" = "0" ] || exit 1
