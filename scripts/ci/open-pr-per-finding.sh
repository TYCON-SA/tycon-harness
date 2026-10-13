#!/usr/bin/env bash
# open-pr-per-finding.sh — el pull request que las dos colas nocturnas RECUERDAN (2026-09-10).
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# POR QUÉ EXISTE, Y POR QUÉ ES UNO SOLO
#
# Los dos nocturnos —dependencias y vigilante— abren un pull request por hallazgo, y desde el
# 2026-09-05 reintentan cada noche el de toda ficha pendiente que no tenga uno ACTIVO. El reintento
# nació de un caso real: una ficha se anunció cuando la identidad del pipeline no podía crear
# ramas, el paso "salió bien" sin abrir nada, y pasó tres noches esperando una decisión sin un
# lugar donde decidirse.
#
# Lo que el reintento NO distingue es «no se pudo crear» de «una persona lo cerró». Un pull request
# rechazado tampoco está activo. Medido contra Azure el 2026-09-10, en el vigilante eso pasó CINCO
# veces en cuatro días: la rama de un mismo hallazgo (`vigilante/<id>`) recibió un pull request (rechazado a
# las 4 h), otro (rechazado) y un tercero. Tres pull requests para una decisión ya tomada — guides/incident-log.md#case-rejected-pr-retried-2026-09-10.
#
# 🔴 Y va en UN guion que los dos YAML llaman, no copiado en los dos. Los dos bloques nacieron
# iguales y en CINCO DÍAS ya se habían separado en tres lugares —entre ellos la guarda del literal
# `$(…)` de los revisores, que se arregló en una copia y nunca llegó a la otra—. Este repo ya pagó
# ese patrón con `release-notes.sh` en 8 repos, y lo cerró extrayendo el canónico a `scripts/ci/`.
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
# 🔴 ESTE GUION NO MUEVE EL CHECKOUT (story 8.26, tanda H1a). Corre cuatro veces por noche —dos en
# cada cola—, y la primera es el primer paso después de traer el arnés. Antes volvía el checkout a
# `origin/main` (`checkout -B`, `reset --hard`): cuando el arnés sale de GitHub eso reemplaza el
# código puesto encima por el de `origin/main`, y la noche sigue en verde midiendo otro código. Ahora:
#   · la rama de cada pedido se arma SIN copia de trabajo (`commit_de_rama`: la ficha de `main`,
#     movida a `promoted/`, en un commit hecho con un índice temporal) y se empuja por su sha;
#   · las anotaciones se escriben en el disco, donde la noche las cuenta, y salen a `main` por
#     `push-nightly-data.js save`, el único camino por el que los nocturnos guardan: lleva SÓLO la
#     carpeta de la cola, nunca lo que haya debajo de HEAD. Si ese guardado no viaja, lo anotado queda
#     en el disco y el paso que guarda la noche —que incluye esta carpeta— lo vuelve a llevar.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# DOS PASADAS POR NOCHE (2026-09-18, incident-log#decisiones-de-ayer-contadas-tarde-2026-09-18)
#
# Con `--record-only` corren A, E y C, y B no abre nada: es la pasada que cada cola hace ANTES de
# su corrida nocturna. Sin ella, lo que una persona decidía durante el día se registraba recién en el
# último paso, DESPUÉS de que la noche contara las fichas y de que saliera el resumen: el del 18/09
# contó como pendientes tres borradores rechazados la tarde anterior, y un cuarto —rechazado con su
# motivo escrito— la noche lo archivó como «nadie lo miró en 7 días». Esta pasada no abre porque no
# puede: el borrador de esta noche todavía no existe, y B arma la rama desde un `main` que todavía no
# lo tiene. La pasada completa del final sigue abriendo, y vuelve a preguntar por todo: si Azure no
# contestó a la mañana, es la que deja la noche en rojo.
#
# Uso:
#   open-pr-per-finding.sh [--record-only] --queue <carpeta> --branch <prefijo> --script <js> \
#                          --org <url> --project <proy> --repo <repo> [--reviewers <lista>] [--today <fecha>]
#   --queue es la carpeta de la cola, relativa a donde se corre y de los niveles que haga falta
#   (`inbox/watcher`); --branch, el prefijo de las ramas (`<prefijo>/<id>`). Son dos datos: no se derivan.
# Exit: 0 hizo lo suyo · 1 algo falló (se dice cuál y por qué) · 2 error de uso (incluye: la cola no existe, o le falta `pending/`)

set -uo pipefail

# Las opciones renombradas a inglés (story 8.9, tanda B3a): los pipelines nocturnos pueden seguir pasando las viejas
# hasta el retiro. El traductor vive al lado (viaja en el artefacto arnes-ci).
_AQUI_LO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${_AQUI_LO}/legacy-options.sh" ]; then
  . "${_AQUI_LO}/legacy-options.sh"
  legacy_options 'cola:queue guion:script hoy:today rama:branch revisores:reviewers solo-registrar:record-only' "$@" || exit 2
  set -- ${LEGACY_OPTIONS[@]+"${LEGACY_OPTIONS[@]}"}
fi

COLA=""; PREFIJO=""; GUION=""; ORG=""; PROYECTO=""; REPO=""; REVISORES=""; HOY=""; SOLO_REGISTRAR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --record-only) SOLO_REGISTRAR=1; shift ;;
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
falta=""
[ -n "$COLA" ]     || falta="$falta --queue"
[ -n "$PREFIJO" ]  || falta="$falta --branch"
[ -n "$GUION" ]    || falta="$falta --script"
[ -n "$ORG" ]      || falta="$falta --org"
[ -n "$PROYECTO" ] || falta="$falta --project"
[ -n "$REPO" ]     || falta="$falta --repo"
if [ -n "$falta" ]; then
  echo "error: faltan parámetros:$falta" >&2
  sed -n '/^# Uso:/,/^# Exit:/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
[ -n "$HOY" ] || HOY=$(date -u +%Y-%m-%d)

# 🔴 UNA CARPETA DE COLA QUE NO ESTÁ NO ES «NO HAY FICHAS» (story 8.9, tanda F — 2026-10-03).
# `--queue` es una RUTA, relativa a donde se corre (`--branch` es el prefijo de las ramas, otro dato).
# Los `for` de abajo recorren `"$COLA"/pending/*.yaml`: si la carpeta no existe no encuentran nada, el
# guion decía «Nada que abrir» y salía 0 sin preguntarle nada a Azure — la noche en verde con todas las
# fichas sin mirar. Es el modo de falla de mudar la cola (de `<cola>/` a `inbox/<…>/`) sin que un
# llamador se entere, y se lee igual que una noche tranquila. Acá es un error de uso: 2, y dicho.
if [ ! -d "$COLA" ]; then
  echo "##vso[task.logissue type=error]la carpeta de la cola «${COLA}» no existe en $(pwd): no se miró ninguna ficha (¿--queue apunta a la carpeta de antes?)"
  echo "error: la carpeta de la cola no existe: $COLA" >&2
  exit 2
fi
# 🔴 …Y UNA COLA SIN SU `pending/` TAMPOCO (misma tanda, hallazgo de la revisión). Mirar sólo que la
# cola exista dejaba pasar la mudanza a medias: la carpeta llegó con `promoted/` o `archived/` y
# `pending/` no. El `for` de la fase A no encontraba ninguna ficha y el guion decía «Nada que abrir»:
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
# promesa de "sin revisores se abre igual" era falsa justo en el caso que dice cubrir: una
# instalación nueva que todavía no configuró la variable. Un hallazgo sin pull request es un
# hallazgo que nadie va a mirar, así que la ausencia de revisores no puede costar el aviso.
# Esta guarda existía SÓLO en la copia de dependencias: acá vale para las dos colas.
case "$REVISORES" in *'$('*) REVISORES="" ;; esac

FALLOS=0
ACCIONES=$(mktemp)                 # una línea por acción: <archivo> TAB <op> TAB <arg1> TAB <arg2>
ABIERTOS=$(mktemp)                 # "<id> <pr>" de los abiertos ESTA noche (para rehacer su rama)
ERR=$(mktemp)
trap 'rm -f "$ACCIONES" "$ABIERTOS" "$ERR"' EXIT

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
# Y sin esto se pierde el dato que la story va a buscar: un comentario que arranca con una línea en
# blanco quedaba ENTERO afuera y la ficha decía «sin motivo escrito» — el hecho opuesto al real.
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
# 🔴 Sin quitar las comillas, la guarda de «vida anterior» quedaba MUERTA en el vigilante: sus fichas
# escriben `fecha: "2026-09-06"`, y como `"` (0x22) ordena por debajo de cualquier dígito,
# `[[ "$CREADO" < "$DESDE" ]]` no podía ser verdadero nunca — o sea que CUALQUIER pull request
# abandonado de la rama se adoptaba como rechazo, sin importar de qué vida fuera.
escalar(){ sed -n "s/^$2:[ \\t]*//p" "$1" | head -1 | awk '{print $1}' | tr -d '"'; }

# ── La rama de un pedido, sin mover el checkout ────────────────────────────────────────────────
# Imprime el commit de la rama: el árbol de <base> con la ficha movida de `pending/` a `promoted/` y su
# veredicto en `util`. Se arma con un índice temporal: ni HEAD, ni el índice, ni el disco del checkout
# cambian. Sale != 0 con el motivo en stderr si la ficha no está en <base> o git no pudo.
# 🔴 El veredicto se cambia ANTES de guardar el contenido: con `git mv` + `sed` sobre el árbol de
# trabajo, el commit llevaba el archivo movido con el veredicto VIEJO (2026-09-05: rename 100 %, 0 cambios).
commit_de_rama(){ # <base> <id>
  local BASE="$1" ID="$2" INDICE CONTENIDO MODO ARBOL
  INDICE=$(mktemp) || return 1
  rm -f "$INDICE"   # git quiere crear él el archivo del índice
  # «no pude leer» no es «no está»: el código de salida de git se mira antes de leer su salida
  if ! MODO=$(git ls-tree "$BASE" -- "$COLA/pending/$ID.yaml"); then echo "no pude leer $BASE para buscar la ficha $ID" >&2; return 2; fi
  MODO=$(printf '%s' "$MODO" | awk '{print $1}')
  if [ -z "$MODO" ]; then echo "la ficha $ID no está en pending/ de $BASE" >&2; return 1; fi
  CONTENIDO=$(git show "$BASE:$COLA/pending/$ID.yaml" | sed 's/^veredicto: pendiente$/veredicto: util/' | git hash-object -w --stdin) \
    && GIT_INDEX_FILE="$INDICE" git read-tree "$BASE" \
    && GIT_INDEX_FILE="$INDICE" git update-index --force-remove "$COLA/pending/$ID.yaml" \
    && GIT_INDEX_FILE="$INDICE" git update-index --add --cacheinfo "$MODO,$CONTENIDO,$COLA/promoted/$ID.yaml" \
    && ARBOL=$(GIT_INDEX_FILE="$INDICE" git write-tree)
  local RC=$?
  rm -f "$INDICE"
  [ "$RC" = 0 ] || return "$RC"
  git commit-tree "$ARBOL" -p "$BASE" -m "$COLA: $ID pasa a trabajo real"
}
# La identidad de los commits de esas ramas. La dejaba puesta el paso anterior del pipeline, que ahora
# guarda por push-nightly-data.js; tocar la configuración del repo no mueve el checkout.
git config user.name "Azure Pipelines"
git config user.email "azure-pipelines@dev.azure.com"

# ── Azure, sin silenciadores ───────────────────────────────────────────────────────────────────
# Cada una devuelve JSON por stdout y sale != 0 si `az` falló, con el error en $ERR. Nada de
# `--query`: JSON crudo + `node -e`, así el doble de las pruebas es un impresor de JSON y no hay
# que reimplementar JMESPath para probar esto sin red.
pr_por_id(){ az repos pr show --org "$ORG" --id "$1" -o json 2>"$ERR"; }
pr_por_rama(){ az repos pr list --org "$ORG" --project "$PROYECTO" --repository "$REPO" \
                 --source-branch "$1" --status all -o json 2>"$ERR"; }
hilos_de(){ az devops invoke --org "$ORG" --area git --resource pullRequestThreads \
              --route-parameters "project=$PROYECTO" "repositoryId=$REPO" "pullRequestId=$1" \
              --api-version 7.1 -o json 2>"$ERR"; }

# 🔴 LOS TRES LECTORES DE JSON SALEN != 0 CUANDO NO PUEDEN LEER, y nunca vacíos.
#
# Antes hacían `catch { process.exit(0) }`: salían con ÉXITO y sin imprimir nada, así que el shell no
# podía distinguir *«az contestó y no hay nada»* de *«no pude leer la respuesta»*. Es EXACTAMENTE el
# hazard que esta story existe para eliminar, reproducido adentro del propio arreglo — y con las tres
# consecuencias medidas: se abría un pull request duplicado, se daba por cerrado uno que seguía
# abierto (y esa ficha no se volvía a mirar NUNCA), y se perdía el motivo del rechazo.
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

# 🔴 EL NÚMERO DE UN PULL REQUEST ES DE TODA LA ORGANIZACIÓN, NO DE ESTE REPO (story 8.26, tanda J — 2026-10-13).
# `pr_por_id` pregunta por número y Azure contesta el pull request de CUALQUIER repo. Una ficha que llegó con su `pr:`
# desde otro repo —el caso: la cola se muda a un repo que nace con la historia del anterior— tenía entonces un pull
# request «propio» que no se puede decidir acá: si seguía activo, la ficha esperaba para siempre en un lugar donde
# nadie la iba a aceptar; si alguien lo abandonaba para ordenar, se anotaba como un rechazo; y a los 7 días pasaba
# sola a ignorada. Las tres, en verde. Este lector dice de quién es: `own`, o `foreign <proyecto>/<repo>`.
# Como los otros: si la respuesta no dice de qué repo es, sale != 0 —«no pude leer» no es «es de acá»—.
# `--project` y `--repo` pueden venir por nombre o por id: se compara contra los dos, sin distinguir mayúsculas.
pr_owner(){ PR_PROJECT="$PROYECTO" PR_REPO="$REPO" node -e '
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

# ── Fase A — decidir por ficha ─────────────────────────────────────────────────────────────────
ABRIR=""
# Con --record-only esta pasada no abre nada (ver «DOS PASADAS POR NOCHE»): dice quién lo abre.
por_abrir(){ # <id> <qué encontró> [<qué se abre>]
  if [ -n "$SOLO_REGISTRAR" ]; then echo "$1: $2 — no se abre en esta pasada: lo abre el último paso de la noche"
  else echo "$1: $2 — se abre${3:-}"; ABRIR="$ABRIR $1"; fi
}
for F in "$COLA"/pending/*.yaml; do
  [ -f "$F" ] || continue
  # 🔴 El MISMO criterio de «está viva» que usa el lector de la cola (`leerFicha`), que descarta el
  # comentario al final de la línea y las comillas. Con la igualdad exacta anterior, una ficha con una
  # nota humana —`veredicto: pendiente # decision-en-curso`, formato que el nocturno soporta a
  # propósito y que su propio caso 21 verifica— quedaba fuera de TODO el manejo de pull requests, en
  # silencio: no se le abría uno, no se le adoptaba, no se le anotaba el rechazo, y terminaba
  # archivada como «ignorado». Dos criterios distintos de «viva» en el mismo sistema se separan solos.
  grep -qE '^veredicto:[ \t]*"?pendiente"?[ \t]*(#.*)?$' "$F" || continue
  ID=$(basename "$F" .yaml)
  PR=$(escalar "$F" pr)

  if [ -n "$PR" ]; then
    if ! OUT=$(pr_por_id "$PR"); then
      fallo "$ID: no se pudo consultar el PR !$PR — $(cat "$ERR")"; continue
    fi
    if ! LEIDO=$(printf '%s' "$OUT" | campo_pr 2>"$ERR"); then
      fallo "$ID: no pude leer la respuesta de Azure sobre el PR !$PR — $(cat "$ERR")"; continue
    fi
    read -r _ ESTADO _ CERRADO <<< "$LEIDO"
    if ! OWNER=$(printf '%s' "$OUT" | pr_owner 2>"$ERR"); then
      fallo "$ID: no pude leer de qué repo es el PR !$PR — $(cat "$ERR")"; continue
    fi
    if [ "$OWNER" != own ]; then
      # 🔴 Un rechazo YA anotado es un dato de la ficha, no del pull request: se respeta venga de donde venga
      # (en dependencias la ficha rechazada sigue viva, con su `pr:` y su `rechazado:`), y no se vuelve a preguntar.
      if grep -q '^rechazado:' "$F"; then
        echo "$ID: ya estaba anotado el rechazo (su PR !$PR es de otro repo, ${OWNER#foreign }: no se mira su estado)"; continue
      fi
      # Lo que el otro repo diga de ese pull request NO decide esta ficha: ni «activo» es un lugar donde decidirla,
      # ni «abandonado» es un rechazo (es lo que queda al ordenar una mudanza). Se sigue como si no tuviera `pr:`:
      # se busca por la rama EN ESTE repo y, si no hay, se abre uno acá, que reemplaza el número en la ficha.
      aviso "$ID: su pr: !$PR es de otro repo (${OWNER#foreign }, $ESTADO), no de $PROYECTO/$REPO: acá no cuenta. Se busca su pull request en este repo; el de allá queda como está (si sigue abierto, hay que cerrarlo a mano)"
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
        por_abrir "$ID" "el PR !$PR ($ESTADO, $CREADO) es de una vida anterior" " uno nuevo"; continue
      fi
    fi
  fi

  case "$ESTADO" in
    active)
      if [ "$(escalar "$F" pr)" != "$PR" ]; then   # sin `pr:`, o con el de otro repo, que no cuenta
        echo "$ID: adoptado el PR !$PR que ya existía"
        encolar "$F" pr "$PR"
        # Alguien pudo REACTIVAR en Azure un pull request que se había rechazado: la ficha lo tiene
        # anotado y hay que borrarlo, o quedaría "rechazada" con su PR abierto pidiendo decisión.
      else
        echo "$ID: ya tiene el PR !$PR"
      fi
      grep -q '^rechazado:' "$F" && { echo "$ID: el PR !$PR volvió a estar activo — se borra el rechazo"; encolar "$F" quitar-rechazo; }
      ;;
    abandoned)
      if grep -q '^rechazado:' "$F"; then
        echo "$ID: ya estaba anotado el rechazo del PR !$PR"
      elif ! HILOS=$(hilos_de "$PR"); then
        # "No pude leer el motivo" NO es "sin motivo escrito": no se anota nada y mañana se reintenta.
        fallo "$ID: no se pudo leer los comentarios del PR !$PR — $(cat "$ERR")"
      elif ! CRUDO=$(printf '%s' "$HILOS" | motivo_de 2>"$ERR"); then
        fallo "$ID: no pude leer el motivo del rechazo del PR !$PR — $(cat "$ERR")"
      else
        # 🔴 Se sanea ACÁ, en el punto de entrada: antes de imprimirlo y antes de encolarlo.
        MOTIVO=$(sanear "$CRUDO")
        echo "$ID: rechazado el ${CERRADO:-$HOY} — «${MOTIVO}»"
        encolar "$F" rechazado "${CERRADO:-$HOY}|$PR" "$MOTIVO"
      fi
      ;;
    completed)
      aviso "$ID: su PR !$PR está completado pero la ficha sigue en pending/ — revisar a mano"
      ;;
    *)
      fallo "$ID: el PR !$PR devolvió un estado que no sé interpretar («${ESTADO}»)"
      ;;
  esac
done

# ── Fase E — toda ficha archivada cierra su pull request ───────────────────────────────────────
# 🔴 El barrido es sobre `archived/*.yaml`, no sobre los ignorados de ESTA noche. Con la lista de
# la noche, un cierre que falló ayer no se reintenta nunca más y el pull request queda abierto para
# siempre; y una ficha archivada por deuda declarada —que no pasa por «ignorado»— no la cerraba
# nadie. Un pull request abierto sobre algo que el sistema ya dio por perdido pide una decisión
# sobre un muerto, y esa clase de pull request es la que enseña a no mirar la lista.
# 🔴 Y también sobre `promoted/`: una ficha que se resuelve sola por medición se mueve de `pending/`
# a `promoted/` LLEVÁNDOSE su `pr:`, y desde ahí su pull request no lo cerraba nadie — ni la fase A
# (ya no está en `pending/`) ni este barrido (sólo miraba `archived/`). Quedaba abierto para siempre.
for F in "$COLA"/archived/*.yaml "$COLA"/promoted/*.yaml; do
  [ -f "$F" ] || continue
  ID=$(basename "$F" .yaml)
  grep -q '^pr_cerrado:' "$F" && continue
  # En `promoted/` sólo se cierra la que YA se resolvió: una aceptada que sigue viva necesita su
  # pull request abierto, que es donde se decidió arreglarla.
  case "$F" in
    */promoted/*) grep -q '^resuelto:' "$F" || continue ;;
  esac
  PR=$(escalar "$F" pr)
  if [ -z "$PR" ]; then echo "$ID: cerrada sin pr: — no sé qué PR cerrar"; continue; fi
  if ! OUT=$(pr_por_id "$PR"); then
    fallo "$ID: no se pudo consultar el PR !$PR de una ficha cerrada — $(cat "$ERR")"; continue
  fi
  if ! LEIDO=$(printf '%s' "$OUT" | campo_pr 2>"$ERR"); then
    # 🔴 Antes, un JSON ilegible dejaba ESTADO vacío, caía en el `else` de abajo y escribía
    # `pr_cerrado:` sobre un pull request que podía seguir ABIERTO — y como arriba hay un
    # `grep -q '^pr_cerrado:' && continue`, esa ficha NO se volvía a mirar nunca. Enterrado, en
    # verde, sin pasar por `fallo()`. Era el peor de los tres.
    fallo "$ID: no pude leer la respuesta de Azure sobre el PR !$PR — $(cat "$ERR")"; continue
  fi
  read -r _ ESTADO _ CERRADO <<< "$LEIDO"
  if ! OWNER=$(printf '%s' "$OUT" | pr_owner 2>"$ERR"); then
    fallo "$ID: no pude leer de qué repo es el PR !$PR de una ficha cerrada — $(cat "$ERR")"; continue
  fi
  if [ "$ESTADO" = "active" ] && [ "$OWNER" != own ]; then
    # 🔴 Este guion no escribe en otro repo: no abandona el pull request ni lo da por cerrado (sigue abierto). Avisa
    # cada noche hasta que alguien lo cierre allá; desde entonces cae en el `else` de abajo y se anota su cierre.
    aviso "$ID: su PR !$PR sigue abierto en otro repo (${OWNER#foreign }): este guion no cierra pull requests de otro repo — hay que cerrarlo a mano; se vuelve a mirar mañana"
    continue
  fi
  if [ "$ESTADO" = "active" ]; then
    if az repos pr update --org "$ORG" --id "$PR" --status abandoned -o none 2>"$ERR"; then
      echo "PR !$PR abandonado con su ficha ($ID)"
      encolar "$F" pr-cerrado "$HOY"
      # Borrar la rama no decide nada: si falla, no cambia el resultado de la noche.
      git push -q origin --delete "$PREFIJO/$ID" || true
    else
      fallo "$ID: no se pudo abandonar el PR !$PR — $(cat "$ERR")"
    fi
  else
    echo "PR !$PR de $ID ya estaba $ESTADO"
    encolar "$F" pr-cerrado "${CERRADO:-$HOY}"
  fi
done

# ── Fase B — abrir los que nunca tuvieron pull request ─────────────────────────────────────────
# El pull request NO transporta el borrador: transporta LA DECISIÓN. El borrador ya está en `main`
# desde el paso anterior del pipeline, y tiene que estarlo: si viviera sólo en la rama, la corrida
# de mañana no lo vería, lo tomaría como nuevo y abriría otro cada noche — con la cuenta de noches
# seguidas clavada en 1, que es justo la señal de que algo se está agravando.
if [ -n "$SOLO_REGISTRAR" ]; then
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
  # (antes un `cat-file -e` que fallaba por lo que fuera daba sólo un aviso, y el pedido no se abría en verde).
  if ! EN_MAIN=$(git ls-tree "$MAIN_AL_ABRIR" -- "$COLA/pending/$ID.yaml" 2>"$ERR"); then
    fallo "$ID: no se pudo leer main para buscar el borrador — no se abre el PR — $(cat "$ERR")"; continue
  fi
  [ -n "$EN_MAIN" ] || { aviso "$ID: no está el borrador, salteado"; continue; }

  # el texto del pedido se arma con la ficha de `main`, sacada a un archivo aparte: el checkout no se toca
  if ! git show "$MAIN_AL_ABRIR:$COLA/pending/$ID.yaml" > "/tmp/pr-card-$ID.yaml" 2>"$ERR"; then
    fallo "$ID: no se pudo sacar el borrador de main — no se abre el PR — $(cat "$ERR")"; continue
  fi
  if ! node "$GUION" pr-text --draft "/tmp/pr-card-$ID.yaml" > "/tmp/pr-$ID.txt" 2>"$ERR"; then
    fallo "$ID: no se pudo armar el texto del PR — no se abre — $(cat "$ERR")"; continue
  fi
  TITULO=$(head -1 "/tmp/pr-$ID.txt")
  # un pedido sin título no lo decide nadie: no se abre vacío
  [ -n "$TITULO" ] || { fallo "$ID: el texto del PR salió sin título — no se abre"; continue; }
  sed -n '/^---CUERPO---$/,$p' "/tmp/pr-$ID.txt" | tail -n +2 > "/tmp/pr-body-$ID.md"

  if ! COMMIT_RAMA=$(commit_de_rama "$MAIN_AL_ABRIR" "$ID" 2>"$ERR"); then
    fallo "$ID: no se pudo armar la rama $RAMA — el borrador sigue en main — $(cat "$ERR")"; continue
  fi
  # 🔴 Un push rechazado no puede dejar la corrida trabada (corrida 9875, 2026-09-04): sin permiso
  # de crear ramas el push falló, se intentó igual el pull request (falló), y el paso murió sin
  # decir QUÉ faltaba.
  if ! git push -q origin "$COMMIT_RAMA:refs/heads/$RAMA" --force-with-lease; then
    fallo "$ID: no se pudo publicar la rama $RAMA (¿la identidad del pipeline tiene 'Create branch'?) — el borrador sigue en main"
    continue
  fi

  # --squash: el historial de main cuenta decisiones, no el andamio de cada rama.
  if ! NUEVO=$(az repos pr create --org "$ORG" --project "$PROYECTO" --repository "$REPO" \
       --source-branch "$RAMA" --target-branch main --title "$TITULO" \
       --description "@/tmp/pr-body-$ID.md" --squash true \
       ${REVISORES:+--reviewers $REVISORES} -o json 2>"$ERR"); then
    fallo "$ID: no se pudo abrir el PR — el borrador está en main, revisar en $COLA/pending/ — $(cat "$ERR")"
    continue
  fi
  # 🔴 El CUARTO lector de JSON, con el mismo criterio que los otros tres: leer mal sale != 0 con su
  # motivo, y nunca vacío. Antes tenía el `catch {}` mudo: el llamador trataba el vacío como fallo
  # —por eso no mordía— pero se perdía POR QUÉ, que es lo que uno necesita a la mañana siguiente.
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
  echo "$ID: abierto el PR !$PRID"
  echo "$ID $PRID" >> "$ABIERTOS"
  # 🔴 La ruta que se encola es la de `main`, donde la ficha SIGUE en `pending/`: moverla a
  # `promoted/` es lo que hace el pull request cuando alguien lo mergea, no algo que pase en `main`
  # esta noche. Encolar la ruta de la rama dejaba la anotación sin archivo que tocar.
  encolar "$COLA/pending/$ID.yaml" pr "$PRID"
done
# (Acá había un `git reset --hard HEAD` y un `git checkout main` para volver de las ramas —la defensa
# venía del vigilante; el `reset` del push fallido, de dependencias—: ya no hay de dónde volver. El
# checkout queda donde estaba, con lo que la noche dejó en el disco.)

# ── Fase C — anotar todo junto en main ─────────────────────────────────────────────────────────
# 🔴 Rehacer la rama sobre el `main` ANOTADO es lo que evita el conflicto: el pull request mueve
# `pending/<id>.yaml` a `promoted/`, así que si `main` modifica ese archivo después, git da
# `CONFLICT (modify/delete)` al fusionar (reproducido en local).
# Las anotaciones se escriben sobre el DISCO del checkout: en la pasada de sólo registrar es lo que
# la noche va a contar, y en la del final el disco ya es lo que el paso anterior guardó en `main`.
if [ -s "$ACCIONES" ]; then
  while IFS=$'\t' read -r ARCHIVO OP A1 A2; do
    [ -n "$ARCHIVO" ] || continue
    [ -f "$ARCHIVO" ] || { aviso "$(basename "$ARCHIVO"): ya no está en main, no se anota"; continue; }
    case "$OP" in
      pr)             node "$GUION" note --card "$ARCHIVO" --pr "$A1" || fallo "$(basename "$ARCHIVO"): note --pr falló" ;;
      pr-cerrado)     node "$GUION" note --card "$ARCHIVO" --pr-closed "$A1" || fallo "$(basename "$ARCHIVO"): note --pr-closed falló" ;;
      quitar-rechazo) node "$GUION" note --card "$ARCHIVO" --clear-rejection || fallo "$(basename "$ARCHIVO"): note --clear-rejection falló" ;;
      rechazado)      node "$GUION" note --card "$ARCHIVO" --rejected "${A1%%|*}" --pr "${A1##*|}" --reason "$A2" \
                        || fallo "$(basename "$ARCHIVO"): note --rejected falló" ;;
    esac
  done < "$ACCIONES"

  # El único camino por el que los nocturnos guardan: lleva a `main` SÓLO la carpeta de la cola, sobre
  # la punta recién traída y con reintento, sin mover el checkout. Sale 0 también si no había nada nuevo.
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
          fallo "$ID: no se pudo leer el main anotado para rehacer la rama del PR !$PRID — $(cat "$ERR")"; continue
        fi
        [ -n "$EN_MAIN" ] || continue
        if COMMIT_RAMA=$(commit_de_rama "$MAIN_ANOTADO" "$ID" 2>"$ERR") \
           && git push -q origin "$COMMIT_RAMA:refs/heads/$RAMA" --force-with-lease; then :; else
          fallo "$ID: no se pudo rehacer la rama del PR !$PRID sobre el main anotado"
        fi
      done < "$ABIERTOS"
    else
      fallo "no se pudo traer el main anotado para rehacer las ramas de los pull requests de esta noche — $(cat "$ERR")"
    fi
  fi
fi

# Que un pull request no se abra NO es "una noche tranquila": es un hallazgo sin nadie que lo mire.
[ "$FALLOS" = "0" ] || exit 1
