#!/usr/bin/env bash
# Prueba del estado de los pedidos de trabajo: el volcado, el aviso único en el Bug, el
# Bug suelto, el aviso del arranque y el paso del pipeline.
#
# work-items.js crea un Bug por proyecto, y hay DOS fuentes que hablan del mismo hecho: el
# estado del Bug (lo que una persona decidió) y la medición nocturna (lo que hay en `origin/main`).
# Esta suite prueba la mitad que habla con Azure —el volcado `bugs-<fecha>.json` y el comentario— contra
# el `az` de mentira (scripts/tests/lib/fake-az.sh), que NUNCA toca la red. La mitad que
# decide (el cruce) vive en la suite del nocturno, porque el nocturno no habla con Azure: lee el volcado.
#
# Los casos giran alrededor de las confusiones que convertirían la pieza en ruido o en silencio:
#   · «no pude leer el pedido» leído como «coincide» (o como «no tiene pedido»);
#   · un comentario del pipeline contado como actividad de una persona (el reloj de `ignorado`);
#   · un marcador escrito antes de que el comentario salga (un aviso que nunca llega, en verde);
#   · el texto de un comentario de Azure copiado a un archivo que viaja por git;
#   · un Bug creado que ninguna ficha nombra, que nadie vuelve a mirar.
#
# Sin el subcomando `state` y el aviso, la suite entera sale roja.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PED="$AQUI/scripts/nightly/dependencies/work-items.js"
NOTICE="$AQUI/scripts/hooks/dependencies-notice.js"
# el modelo público del pipeline: lo que copia cada organización a su repo de operaciones
YAML="$AQUI/pipelines/operations/dependency-audit.yml"
# el YAML del pipeline puede llamar con el nombre nuevo o con el viejo (el alias lo sigue aceptando hasta el
# retiro). El chequeo acepta los dos; el viejo sale del mapa de renombres, nunca escrito en la prueba.
nombres(){ # <kind> <nuevo> <where> → «nuevo|viejo» (sólo «nuevo» sin mapa)
  node -e 'const [k, n, w, f] = process.argv.slice(1); let v = [];
    try { v = JSON.parse(require("fs").readFileSync(f, "utf8")).entries.filter((e) => e.kind === k && e.new === n && e.where === w).map((e) => e.old); } catch (_) { v = []; }
    console.log([...new Set([n, ...v])].join("|"));' "$1" "$2" "$3" "$AQUI/scripts/lib/renames.json"
}
HOY_OPC="--($(nombres option today scripts/nightly/dependencies/work-items.js))"
VOLCAR="work-items[.]js ($(nombres subcommand state scripts/nightly/dependencies/work-items.js))( |\$)"
DOBLE="$AQUI/scripts/tests/lib/fake-az.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ estado-de-pedidos: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ estado-de-pedidos: $1"; fallos=$((fallos+1)); }

if [ -f "$DOBLE" ]; then cp "$DOBLE" "$TMP/az"; chmod +x "$TMP/az"; fi
HOY=2026-09-10
export BACKUP_OWNER_ID=7bb1c00b-0000-0000-0000-00000000a41e
BACKUP_OWNER_MAIL=respaldo@prueba   # el fixture de la API de identidades se llama por el mail

# ── el mundo de prueba (el mismo de la suite work-items.test.sh) ──────────────────────────────────────────
mundo(){
  rm -rf "$TMP/pend" "$TMP/out" "$TMP/fixaz"
  mkdir -p "$TMP/pend/pending" "$TMP/pend/promoted" "$TMP/pend/archived" "$TMP/out" "$TMP/fixaz"
  echo 100 > "$TMP/fixaz/contador"
  cat > "$TMP/fixaz/identidades-${BACKUP_OWNER_MAIL}.json" <<J
{ "count": 1, "value": [ { "id": "$BACKUP_OWNER_ID", "providerDisplayName": "Respaldo Prueba" } ] }
J
  estados_agile "Proy A"
  config
}

config(){ # [pedidos_activos=true] [con_vocabulario=true]
  node -e '
const [act, voc, f] = process.argv.slice(1);
const azure = { org: "https://dev.azure.com/prueba", fallback_owner: "respaldo@prueba", pedidos_activos: act === "true" };
if (voc === "true") azure.motivos_arreglado = ["Fixed", "Fixed and verified", "Verified", "Work finished"];
const c = { presupuesto_de_ruido: { tope_pr_por_noche: 2 }, azure, repos: [
  { producto: "A", ruta: "A",  ado: "Proy%20A/A",  tipo: "npm", activo: true },
  { producto: "A", ruta: "A2", ado: "Proy%20A/A2", tipo: "npm", activo: true },
  { producto: "B", ruta: "B",  ado: "ProyB/B",     tipo: "npm", activo: true },
  { producto: "C", ruta: "C",  ado: "ProyC/C",     tipo: "npm", activo: true } ] };
require("fs").writeFileSync(f, JSON.stringify(c, null, 2));' "${1:-true}" "${2:-true}" "$TMP/c.json"
}

estados_agile(){ # <proyecto> — la forma REAL de `workItemTypeStates`
  cat > "$TMP/fixaz/estados-$1.json" <<'J'
{ "count": 4, "value": [ { "name": "New", "color": "b2b2b2", "category": "Proposed" },
  { "name": "Active", "color": "007acc", "category": "InProgress" },
  { "name": "Resolved", "color": "ff9d00", "category": "Resolved" },
  { "name": "Closed", "color": "339933", "category": "Completed" } ] }
J
}

ficha(){ # <carpeta> <id> <paquete> <repos,por,coma> [líneas extra...]
  local dir="$1" id="$2" paq="$3" repos="$4"; shift 4
  {
    echo "id: $id"; echo "detectado: 2026-09-01"
    case "$dir" in promoted) echo "veredicto: util" ;; archived) echo "veredicto: ignorado" ;; *) echo "veredicto: pendiente" ;; esac
    echo "paquete: $paq"; echo "severidad: high"; echo "noches: 3"
    for l in "$@"; do printf '%s\n' "$l"; done
    echo "ids:"; echo "  - $id"
    if [ -n "$repos" ]; then echo "repos:"; local IFS=','; for r in $repos; do echo "  - $r"; done; fi
    echo "avisos:"; echo "  - https://github.com/advisories/GHSA-73wf-$id"
  } > "$TMP/pend/$dir/$id.yaml"
}

wi(){ # <id> <estado> <motivo> [etiquetas] — con TÍTULO y DESCRIPCIÓN centinela: nunca pueden llegar al volcado
  node -e '
const [id, estado, motivo, tags, f] = process.argv.slice(1);
const fields = { "System.TeamProject": "Proy A", "System.WorkItemType": "Bug", "System.CreatedBy": { displayName: "Project Collection Build Service (prueba)", descriptor: "svc.XXX" }, "System.State": estado, "System.Reason": motivo,
  "Microsoft.VSTS.Common.StateChangeDate": "2026-09-01T10:00:00Z", "System.ChangedDate": "2026-09-09T04:00:05Z",
  "System.Title": "CENTINELA-TIT", "System.Description": "CENTINELA-DESC" };
if (tags) fields["System.Tags"] = tags;
require("fs").writeFileSync(f, JSON.stringify({ id: Number(id), fields }, null, 2));' "$1" "$2" "$3" "${4:-}" "$TMP/fixaz/wi-$1.json"
}

revs(){ # <id> [persona «Nombre@fecha»] — dos revisiones del pipeline (la 2 es un comentario) y, opcional, una de una persona
  node -e '
const [id, persona, f] = process.argv.slice(1);
const svc = { displayName: "Project Collection Build Service (acme)", uniqueName: "Build\\64bea6b8", descriptor: "svc.XXX" };
const value = [
  { rev: 1, fields: { "System.ChangedDate": "2026-08-25T04:00:00Z", "System.ChangedBy": svc, "System.State": "New" } },
  { rev: 2, fields: { "System.ChangedDate": "2026-09-09T04:00:05Z", "System.ChangedBy": svc, "System.History": "CENTINELA-COMENTARIO" } } ];
if (persona) { const [nombre, fecha] = persona.split("@");
  value.splice(1, 0, { rev: 3, fields: { "System.ChangedDate": fecha, "System.ChangedBy": { displayName: nombre, uniqueName: "x@y", descriptor: "msa.YYY" } } }); }
require("fs").writeFileSync(f, JSON.stringify({ count: value.length, value }, null, 2));' "$1" "${2:-}" "$TMP/fixaz/revisiones-$1.json"
}

estado(){ # [flags extra...] → imprime el código de salida; la salida queda en $TMP/o.txt
  FIXAZ="$TMP/fixaz" TYCON_ADO_CMD="${AZ_CMD:-$TMP/az}" AZURE_DEVOPS_EXT_PAT="${PAT-pat-de-prueba}" \
    node "$PED" state --config "$TMP/c.json" --pending "$TMP/pend" --out "$TMP/out" --today "$HOY" "$@" \
    >"$TMP/o.txt" 2>&1
  echo $?
}

correr(){ # [flags extra...] → `run` de pedidos (el que comenta y adopta)
  FIXAZ="$TMP/fixaz" TYCON_ADO_CMD="${AZ_CMD:-$TMP/az}" AZURE_DEVOPS_EXT_PAT="${PAT-pat-de-prueba}" \
    node "$PED" run --config "$TMP/c.json" --pending "$TMP/pend" --out "$TMP/out" --today "$HOY" "$@" \
    >"$TMP/o.txt" 2>&1
  echo $?
}

volc(){ # <expresión JS sobre v = bugs-<HOY>.json>
  node -e '
const [f, expr] = process.argv.slice(1);
let v; try { v = JSON.parse(require("fs").readFileSync(f, "utf8")); } catch { process.exit(1); }
process.exit(eval(expr) ? 0 : 1);' "$TMP/out/bugs-$HOY.json" "$1"
}
volcj(){ node -e 'try { console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")))); } catch (e) { console.log("<<" + e.message + ">>"); }' "$TMP/out/bugs-$HOY.json" | cut -c1-600; }

cuenta(){ # <paso> → cuántas llamadas de ese paso recibió el `az` de mentira
  if [ -f "$TMP/fixaz/llamadas.log" ]; then awk -F'\t' -v p="$1" '$1 == p' "$TMP/fixaz/llamadas.log" | wc -l | tr -d ' '; else echo 0; fi
}

llamada(){ # <paso> <n desde 0> <expresión JS sobre a (args), arg(k), b (texto de los archivos)>
  [ -f "$TMP/fixaz/llamadas.log" ] || return 1
  node -e '
const [log, paso, n, expr] = process.argv.slice(1);
const ls = require("fs").readFileSync(log, "utf8").split("\n").filter(Boolean)
  .map((l) => { const i = l.indexOf("\t"); return { paso: l.slice(0, i), ...JSON.parse(l.slice(i + 1)) }; })
  .filter((x) => x.paso === paso);
const x = ls[Number(n)]; if (!x) process.exit(1);
const a = x.args, b = Object.values(x.archivos || {}).join("\n");
const arg = (k) => { const i = a.lastIndexOf(k); return i < 0 ? undefined : a[i + 1]; };
process.exit(eval(expr) ? 0 : 1);' "$TMP/fixaz/llamadas.log" "$1" "$2" "$3"
}

snapshot(){ # <presencias JSON> [cruce JSON] — el snapshot de HOY que dejó el nocturno
  node -e '
const [pres, cruce, f] = process.argv.slice(1);
const repos = [["A","A"],["A","A2"],["B","B"],["C","C"]].map(([p, r]) => ({ producto: p, ruta: r, medido: true }));
const s = { fecha: process.argv[4], corrida_completa: true, repos, presencias: JSON.parse(pres), hallazgos: [], anunciados_hoy: [] };
if (cruce) s.cruce = JSON.parse(cruce);
require("fs").writeFileSync(f, JSON.stringify(s, null, 2));' "$1" "${2:-}" "$TMP/out/dependencias-$HOY.json" "$HOY"
}
presente(){ echo "[{\"id\":\"$1\",\"paquete\":\"$2\",\"severidad\":\"high\",\"advisories\":[],\"repos\":[{\"repo\":\"A/A\",\"declarada\":false,\"vence\":null}]}]"; }
cv(){ # <clase> [avisar=true] [estado=Closed] [motivo=Verified] → un `cerrados_vivos` de una entrada para abc12345 en Proy A
  echo "{\"consultado\":true,\"cerrados_vivos\":[{\"ficha\":\"abc12345\",\"proyecto\":\"Proy A\",\"pedido\":101,\"estado\":\"${3:-Closed}\",\"motivo\":\"${4:-Verified}\",\"clase\":\"$1\",\"visto_cerrado\":\"2026-09-08\",\"repos\":[\"A/A\"],\"avisar\":${2:-true}}]}"
}
ped(){ # <expresión JS sobre p = snapshot.pedidos>
  node -e '
const [f, expr] = process.argv.slice(1);
let s; try { s = JSON.parse(require("fs").readFileSync(f, "utf8")); } catch { process.exit(1); }
const p = s.pedidos;
process.exit(eval(expr) ? 0 : 1);' "$TMP/out/dependencias-$HOY.json" "$1"
}
pie(){ tail -5 "$TMP/o.txt" | tr '\n' ' ' | cut -c1-500; }

# ── T1. el volcado lee estado, categoría y motivo, y las categorías UNA vez por proyecto ────
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101"
ficha pending def67890 handlebars "A/A2" "pedidos:" "  - Proy A: 102"
ficha promoted ghi11111 lodash "A/A" "resuelto: 2026-09-08" "pedidos:" "  - Proy A: 103"
wi 101 Closed Verified; wi 102 Active New; wi 103 Resolved Fixed
revs 101 "Dana@2026-09-03T15:00:00Z"; revs 102; revs 103
rc=$(estado)
{ [ "$rc" -eq 0 ] && volc 'v.fecha === "2026-09-10" && v.consultado === true' \
  && volc 'const x = v.pedidos["101"]; x && x.ficha === "abc12345" && x.proyecto === "Proy A" && x.leido === true && x.estado === "Closed" && x.categoria === "Completed" && x.motivo === "Verified" && x.estado_desde === "2026-09-01T10:00:00Z" && x.motivo_no_leido === null' \
  && volc 'v.pedidos["103"] && v.pedidos["103"].ficha === "ghi11111" && v.pedidos["103"].categoria === "Resolved"' \
  && volc 'v.pedidos["102"].categoria === "InProgress" && v.proyectos["Proy A"].categorias.Closed === "Completed"' \
  && [ "$(cuenta estados)" -eq 1 ]; } \
  && ok "T1: el volcado trae estado, categoría, motivo y fecha del estado por pedido (también de la ficha resuelta), y lee las categorías UNA vez para tres pedidos del mismo proyecto" \
  || no "T1: rc=$rc estados=$(cuenta estados) · $(volcj) · $(pie)"

# ── T2. 🔴 la actividad de una persona NO la mueve un comentario del pipeline ────────────
{ volc 'v.pedidos["101"].cambiado_por_persona_el === "2026-09-03T15:00:00Z" && v.pedidos["101"].cambiado_por_persona === "Dana"' \
  && volc 'v.pedidos["102"].cambiado_por_persona_el === null && v.pedidos["102"].cambiado_por_persona === null'; } \
  && ok "T2: 🔴 «cambiado por una persona» sale de las revisiones con descriptor que no es svc. — el comentario del pipeline del 09-09 no cuenta, y un pedido que sólo tocó el pipeline da null" \
  || no "T2: $(volcj)"

# ── T26. 🔴 ni un texto de Azure en el volcado ────────────────────────────────────────
n=$(grep -c CENTINELA "$TMP/out/bugs-$HOY.json" 2>/dev/null); n=${n:-0}
{ [ -f "$TMP/out/bugs-$HOY.json" ] && [ "$n" -eq 0 ]; } \
  && ok "T26: 🔴 el volcado no trae el título, la descripción ni el texto de un comentario (el archivo viaja por git)" \
  || no "T26: existe=$([ -f "$TMP/out/bugs-$HOY.json" ] && echo sí || echo no) · centinelas=$n"

# ── T3. una lectura que falla es «no leído» POR ID, con cuál falló, y la corrida sigue ────
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101"
ficha pending def67890 handlebars "A/A2" "pedidos:" "  - Proy A: 102"
wi 101 Closed Verified; wi 102 Active New; revs 101; revs 102
rc=$(TYCON_AZ_FAIL='wi:"101"' estado)
a_ok=0; { [ "$rc" -eq 0 ] && volc 'v.pedidos["101"].leido === false && /no pude leer el work item/.test(v.pedidos["101"].motivo_no_leido) && v.pedidos["102"].leido === true'; } && a_ok=1
rc=$(TYCON_AZ_GARBAGE=revisiones estado)
b_ok=0; { [ "$rc" -eq 0 ] && volc '["101","102"].every((k) => v.pedidos[k].leido === false && /no pude leer las revisiones/.test(v.pedidos[k].motivo_no_leido))'; } && b_ok=1
rm "$TMP/fixaz/estados-Proy A.json"; rc=$(estado)
c_ok=0; { [ "$rc" -eq 0 ] && volc '["101","102"].every((k) => v.pedidos[k].leido === false && /no pude leer las categorías de estado de Proy A/.test(v.pedidos[k].motivo_no_leido)) && v.proyectos["Proy A"].categorias === null'; } && c_ok=1
estados_agile "Proy A"; wi 101 Raro Verified; rc=$(estado)
d_ok=0; { [ "$rc" -eq 0 ] && volc 'v.pedidos["101"].leido === false && /el estado Raro no está en las categorías de Proy A/.test(v.pedidos["101"].motivo_no_leido) && v.pedidos["102"].leido === true'; } && d_ok=1
[ "$a_ok$b_ok$c_ok$d_ok" = 1111 ] \
  && ok "T3: el work item, las revisiones o las categorías que no se pueden leer (o un estado fuera de las categorías) dejan ESE pedido en «no leído» con el motivo, y la ejecución sigue" \
  || no "T3: show=$a_ok revisiones=$b_ok categorías=$c_ok estado-raro=$d_ok · $(volcj)"

# ── T5. 🔴 un id que no existe (o sin permiso) no es «sin pedido» ────────────────────────
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 999"
rc=$(estado)
{ [ "$rc" -eq 0 ] && volc 'v.pedidos["999"] && v.pedidos["999"].leido === false && /no existe o sin permiso de lectura/.test(v.pedidos["999"].motivo_no_leido)'; } \
  && ok "T5: 🔴 un id que Azure dice que no existe (TF401232) sale «no leído: no existe o sin permiso de lectura», nunca desaparece" \
  || no "T5: rc=$rc · $(volcj)"

# ── T4. sin pedidos igual escribe · sin poder intentar nada sale 2 y lo dice ─────────
mundo
ficha pending abc12345 browserslist "A/A"
rc=$(estado)
a_ok=0; { [ "$rc" -eq 0 ] && volc 'v.consultado === true && Object.keys(v.pedidos).length === 0'; } && a_ok=1
rc2=$(AZ_CMD=/no/existe estado)
b_ok=0; { [ "$rc2" -eq 2 ] && volc 'v.consultado === false && typeof v.motivo === "string" && v.motivo.length > 0 && !("pedidos" in v)'; } && b_ok=1
rc3=$(PAT= estado)
c_ok=0; { [ "$rc3" -eq 2 ] && volc 'v.consultado === false && /token/.test(v.motivo)'; } && c_ok=1
[ "$a_ok$b_ok$c_ok" = 111 ] \
  && ok "T4: sin fichas con pedido el volcado sale igual con «pedidos: {}»; sin az o sin token sale 2 y escribe «consultado: false» con el motivo" \
  || no "T4: vacío=$a_ok (rc=$rc) sin-az=$b_ok (rc=$rc2) sin-token=$c_ok (rc=$rc3) · $(volcj)"

# ── T28. 🔴 el Bug suelto se encuentra por su etiqueta ──────────────────────────────
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101"
ficha archived zzz99999 minimist "A/A" "pedidos:" "  - Proy A: 160"
wi 101 Active New "arnes-hallazgo; arnes:abc12345"; revs 101
wi 150 Active New "arnes-hallazgo; arnes:abc12345"
wi 170 Active New "arnes-hallazgo-viejo; arnes:qqq"
echo '{ "workItems": [ { "id": 101 }, { "id": 150 }, { "id": 160 }, { "id": 170 } ] }' > "$TMP/fixaz/wiql-Proy A.json"
rc=$(estado)
a_ok=0; { [ "$rc" -eq 0 ] && volc 'JSON.stringify(v.huerfanos) === JSON.stringify([{ id: 150, proyecto: "Proy A", ficha: "abc12345", estado: "Active", categoria: "InProgress" }]) && v.huerfanos_no_consultados.length === 0' \
  && [ "$(cuenta wiql)" -eq 3 ] && llamada wiql 0 'b.includes("@project") && b.includes("arnes-hallazgo")'; } && a_ok=1
rc2=$(TYCON_AZ_FAIL='wiql:project=ProyB' estado)
b_ok=0; { [ "$rc2" -eq 0 ] && volc 'v.huerfanos_no_consultados.map((x) => x.proyecto).join() === "ProyB" && v.huerfanos.length === 1'; } && b_ok=1
[ "$a_ok$b_ok" = 11 ] \
  && ok "T28: 🔴 un Bug del arnés que ninguna ficha nombra sale en «huerfanos» con su ficha (uno nombrado sólo en archived/ no, y una etiqueta parecida tampoco); una consulta que falla es «no consultado», no «sin huérfanos»" \
  || no "T28: encontrado=$a_ok (rc=$rc wiql=$(cuenta wiql)) falla=$b_ok (rc=$rc2) · $(volcj)"

# ── T29. el Bug suelto se adopta en SU ficha, sin comentario ─────────────────────────────
suelto(){ # <ficha nombrada> → el volcado de HOY con un solo huérfano (150 en Proy A)
  echo "{\"fecha\":\"$HOY\",\"consultado\":true,\"motivo\":null,\"proyectos\":{},\"pedidos\":{},\"huerfanos\":[{\"id\":150,\"proyecto\":\"Proy A\",\"ficha\":\"$1\",\"estado\":\"Active\",\"categoria\":\"InProgress\"}],\"huerfanos_no_consultados\":[]}" > "$TMP/out/bugs-$HOY.json"
}
mundo
ficha promoted abc12345 browserslist "" "resuelto: 2026-09-08"
snapshot '[]'; suelto abc12345; wi 150 Active "" "arnes-hallazgo; arnes:abc12345"
rc=$(correr)
a_ok=0; { [ "$rc" -eq 0 ] && grep -qx '  - Proy A: 150' "$TMP/pend/promoted/abc12345.yaml" \
  && ped 'JSON.stringify(p.huerfanos_adoptados) === JSON.stringify([{ ficha: "abc12345", proyecto: "Proy A", id: 150 }])' \
  && [ "$(cuenta crear)" -eq 0 ] && [ "$(cuenta comentario)" -eq 1 ] && llamada comentario 0 'arg("--id") === "150" && b.includes("ya no aparece") && !/adopt/i.test(b)' \
  && [ "$(cuenta actualizar)" -eq 1 ] && llamada actualizar 0 'arg("--id") === "150" && arg("--state") === "Closed"'; } && a_ok=1
# (la adopción no comenta; el único comentario es el «ya no aparece» del cruce, que le llega esa misma
#  noche porque la ficha está resuelta y el Bug que ahora conoce sigue abierto, y
#  por la misma razón, ese Bug se cierra: el arreglo ya está en main)
mundo
ficha promoted abc12345 browserslist "" "resuelto: 2026-09-08" "pedidos:" "  - Proy A: 140" "pagado_avisado:" "  - Proy A (2026-09-08)"
snapshot '[]'; suelto abc12345; cp "$TMP/pend/promoted/abc12345.yaml" "$TMP/antes.yaml"
rc=$(correr)
b_ok=0; { [ "$rc" -eq 0 ] && cmp -s "$TMP/antes.yaml" "$TMP/pend/promoted/abc12345.yaml" \
  && ped 'p.huerfanos_adoptados.length === 0 && p.huerfanos_sin_adoptar.length === 1 && /140/.test(p.huerfanos_sin_adoptar[0].motivo)'; } && b_ok=1
mundo
snapshot '[]'; suelto noexiste
rc=$(correr)
c_ok=0; { [ "$rc" -eq 0 ] && ped 'p.huerfanos_sin_adoptar.length === 1 && /no existe/.test(p.huerfanos_sin_adoptar[0].motivo)'; } && c_ok=1
mundo; config false
ficha promoted abc12345 browserslist "" "resuelto: 2026-09-08"
snapshot '[]'; suelto abc12345; cp "$TMP/pend/promoted/abc12345.yaml" "$TMP/antes.yaml"
rc=$(correr)
d_ok=0; { [ "$rc" -eq 0 ] && cmp -s "$TMP/antes.yaml" "$TMP/pend/promoted/abc12345.yaml" && ped 'p.huerfanos_adoptados.length === 1'; } && d_ok=1
mundo
ficha promoted abc12345 browserslist "" "resuelto: 2026-09-08"
snapshot '[]'
rc=$(correr)
e_ok=0; { [ "$rc" -eq 0 ] && ped 'Array.isArray(p.huerfanos_adoptados) && p.huerfanos_adoptados.length === 0 && Array.isArray(p.huerfanos_sin_adoptar)'; } && e_ok=1
[ "$a_ok$b_ok$c_ok$d_ok$e_ok" = 11111 ] \
  && ok "T29: el Bug suelto se anota en la ficha que nombra (aunque esté resuelta), sin comentario propio (sólo el «ya no aparece» de la 4.4); con otro id en el proyecto o sin ficha no se escribe nada; simulado no escribe; sin volcado no pasa nada" \
  || no "T29: adopta=$a_ok otro-id=$b_ok sin-ficha=$c_ok simulado=$d_ok sin-volcado=$e_ok · $(pie)"

# ── T16. el aviso: UN comentario, con la mención, y el marcador DESPUÉS ────────────────────
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101"
snapshot "$(presente abc12345 browserslist)" "$(cv arreglado)"
rc=$(correr)
a_ok=0; { [ "$rc" -eq 0 ] && [ "$(cuenta comentario)" -eq 1 ] \
  && llamada comentario 0 'arg("--id") === "101" && ["browserslist", "A/A", "No lo reabro", "data-vss-mention", "pending-vulnerabilities.json", "2026-09-08", "Closed", "Verified"].every((t) => b.includes(t))' \
  && grep -qx 'avisado_cerrado_vivo:' "$TMP/pend/pending/abc12345.yaml" && grep -qx '  - Proy A (2026-09-10)' "$TMP/pend/pending/abc12345.yaml" \
  && ped 'JSON.stringify(p.cerrados_vivos_avisados) === JSON.stringify([{ ficha: "abc12345", proyecto: "Proy A", id: 101 }])'; } && a_ok=1
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101"
snapshot "$(presente abc12345 browserslist)" "$(cv no-aplica true Resolved Duplicate)"
rc=$(correr)
b_ok=0; { [ "$rc" -eq 0 ] && [ "$(cuenta comentario)" -eq 1 ] && llamada comentario 0 'b.includes("no aplica") && b.includes("declarar la deuda") && b.includes("Duplicate")'; } && b_ok=1
[ "$a_ok$b_ok" = 11 ] \
  && ok "T16: un pedido cerrado con la vulnerabilidad viva recibe UN comentario (paquete, repo, «No lo reabro», mención, dónde declarar la deuda) y la ficha queda marcada; «no aplica» tiene su propio texto" \
  || no "T16: arreglado=$a_ok no-aplica=$b_ok comentarios=$(cuenta comentario) · $(pie)"

# ── T17. 🔴 comentario fallido no marca · marcado no repite · avisar:false no comenta ─
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101"
snapshot "$(presente abc12345 browserslist)" "$(cv arreglado)"
rc=$(TYCON_AZ_FAIL=comentario correr)
a_ok=0; { [ "$rc" -eq 0 ] && ! grep -q '^avisado_cerrado_vivo:' "$TMP/pend/pending/abc12345.yaml" \
  && ped 'p.fallidos.some((x) => x.paso === "aviso-cerrado-vivo" && x.ficha === "abc12345" && x.proyecto === "Proy A") && p.cerrados_vivos_avisados.length === 0'; } && a_ok=1
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101" "avisado_cerrado_vivo:" "  - Proy A (2026-09-09)"
snapshot "$(presente abc12345 browserslist)" "$(cv arreglado)"
rc=$(correr); b_ok=0; { [ "$rc" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ]; } && b_ok=1
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101"
snapshot "$(presente abc12345 browserslist)" "$(cv arreglado false)"
rc=$(correr); c_ok=0; { [ "$rc" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ]; } && c_ok=1
[ "$a_ok$b_ok$c_ok" = 111 ] \
  && ok "T17: 🔴 si el comentario falla la ficha NO se marca y el fallo queda (mañana se reintenta); con el marcador puesto o avisar:false no sale ningún comentario" \
  || no "T17: fallido=$a_ok marcado=$b_ok avisar-false=$c_ok · $(pie)"

# ── T13. la resuelta con pedido abierto se LISTA (lo hace el nocturno), no se comenta de nuevo ─
mundo
ficha promoted abc12345 browserslist "" "resuelto: 2026-09-05" "pedidos:" "  - Proy A: 101" "pagado_avisado:" "  - Proy A (2026-09-05)"
snapshot '[]' '{"consultado":true,"cerrados_vivos":[],"resueltas_con_pedido_abierto":[{"ficha":"abc12345","proyecto":"Proy A","pedido":101,"resuelto":"2026-09-05","dias":5}]}'
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ]; } \
  && ok "T13: una ficha resuelta con el pedido abierto no recibe un comentario más (ya tuvo «ya no aparece»)" \
  || no "T13: rc=$rc comentarios=$(cuenta comentario) · $(pie)"

# ── T18. 🔴 simulado no escribe · y el guion NUNCA cambia el estado de un Bug ─────────
mundo; config false
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101"
snapshot "$(presente abc12345 browserslist)" "$(cv arreglado)"; cp "$TMP/pend/pending/abc12345.yaml" "$TMP/antes.yaml"
rc=$(correr)
# el guion SÍ cambia el estado de un Bug en dos lugares — `cerrarPedido` (el
# arreglo llegó a main) y `reabrirPedido` (volvió a un Bug que cerró él; work-items.test.sh T18/T18k).
# Lo que sigue prohibido: mandar un motivo, y que el CRUCE toque un estado. Por eso `--state` aparece DOS veces
# en el guion y ninguna llamada de este caso lo lleva.
st=$(grep -c -- "'--state'" "$PED"); re=$(grep -c -- '--reason' "$PED")
logst=$(grep -cE -- '"--(state|reason)"' "$TMP/fixaz/llamadas.log" 2>/dev/null); logst=${logst:-0}
{ [ "$rc" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ] && cmp -s "$TMP/antes.yaml" "$TMP/pend/pending/abc12345.yaml" \
  && grep -q 'No lo reabro' "$TMP/o.txt" && [ "$st" -eq 2 ] && [ "$re" -eq 0 ] && [ "$logst" -eq 0 ]; } \
  && ok "T18: 🔴 simulado no comenta ni toca la ficha y muestra el texto que habría salido; el cruce no cambia estados, el guion nunca manda motivo y cambia estados sólo desde cerrar y reabrir" \
  || no "T18: rc=$rc comentarios=$(cuenta comentario) ficha-igual=$(cmp -s "$TMP/antes.yaml" "$TMP/pend/pending/abc12345.yaml" && echo sí || echo no) --state=$st --reason=$re en-llamadas=$logst"

# ── T22. el aviso del arranque cobra el cruce ─────────────────────────────────────────
aviso(){ # <cruce JSON | AUSENTE> → la salida del hook sobre un .dashboard/ fabricado
  rm -rf "$TMP/dash"; mkdir -p "$TMP/dash/out" "$TMP/dash/pend/pending"
  node -e '
const [cruce, f, hoy] = process.argv.slice(1);
const s = { fecha: hoy, corrida_completa: true, linea_base: false, no_medidos: [], pedidos: { simulado: false, fallidos: [], creados: [] },
  resumen: { canal: "telegram", message_id: 1, entregado_el: hoy + "T04:00:00Z", motivo: null } };
if (cruce !== "AUSENTE") s.cruce = JSON.parse(cruce);
require("fs").writeFileSync(f, JSON.stringify(s));' "$1" "$TMP/dash/out/dependencias-$HOY.json" "$HOY"
  # `TYCON_DEPS_REPO` fija el árbol de la noche: sin él, en una máquina con la versión bajada y los nocturnos apagados,
  # el aviso no lee ningún árbol y calla
  TYCON_DEPS_REPO="$TMP/dash" TYCON_DEPS_OUT="$TMP/dash/out" TYCON_DEPS_PENDING="$TMP/dash/pend" TYCON_WATCHER_OUT="$TMP/dash/novig" \
    TYCON_DEPS_NOW="${HOY}T12:00:00Z" node "$NOTICE" 2>&1
}
cruce(){ # <campo> <lista JSON> [consultado=true] [motivo] → un `cruce` completo con esa lista y las demás vacías
  node -e '
const [campo, lista, cons, motivo] = process.argv.slice(1);
const c = { consultado: cons !== "false", motivo: motivo || null };
for (const k of ["cerrados_vivos", "en_gracia", "cerrados_con_deuda", "reabiertos", "resueltas_con_pedido_abierto",
  "no_leidos", "no_evaluados", "ignorado_frenado", "huerfanos", "huerfanos_no_consultados"]) c[k] = [];
if (campo) c[campo] = JSON.parse(lista);
console.log(JSON.stringify(c));' "$@"
}
o1=$(aviso AUSENTE)
o2=$(aviso "$(cruce "" "" false "sin token")")
o3=$(aviso "$(cruce cerrados_vivos '[{"ficha":"abc12345","proyecto":"Proy A","pedido":101,"clase":"arreglado"}]')")
o4=$(aviso "$(cruce no_leidos '[{"ficha":"abc12345","proyecto":"Proy A","pedido":101,"motivo":"x"}]')")
o5=$(aviso "$(cruce huerfanos '[{"id":150,"proyecto":"Proy A","ficha":"abc12345"}]')")
o6=$(aviso "$(cruce)")
{ echo "$o1" | grep 'NO cruzó el estado de los pedidos' >/dev/null \
  && echo "$o2" | grep 'no pudo leer el estado de los pedidos (sin token)' >/dev/null \
  && echo "$o3" | grep '1 pedido(s) cerrado(s) con la vulnerabilidad viva — abc12345 en Proy A' >/dev/null \
  && echo "$o4" | grep '1 pedido(s) no leído(s): no se puede decir que coincidan' >/dev/null \
  && echo "$o5" | grep '1 Bug(s) del arnés que ninguna ficha nombra' >/dev/null \
  && ! echo "$o6" | grep -E 'cruzó|no pudo leer el estado|con la vulnerabilidad viva|no leído|ninguna ficha nombra' >/dev/null; } \
  && ok "T22: el arranque dice «NO cruzó» sin la clave, «no pudo leer» con consultado:false, y cobra cerrados vivos, no leídos y Bugs sueltos; con todo en orden no suma nada" \
  || no "T22: ausente=«$(echo "$o1" | tr '\n' ' ' | cut -c1-160)» · consultado-false=«$(echo "$o2" | tr '\n' ' ' | cut -c1-160)» · cerrado-vivo=«$(echo "$o3" | tr '\n' ' ' | cut -c1-200)» · no-leído=«$(echo "$o4" | tr '\n' ' ' | cut -c1-160)» · suelto=«$(echo "$o5" | tr '\n' ' ' | cut -c1-160)» · limpio=«$(echo "$o6" | tr '\n' ' ' | cut -c1-160)»"

# ── T23. el paso del volcado va entre el clon y la revisión, con el token, y la fecha nace ahí ─
# Una función para poder correrla contra mutantes: un chequeo de texto verificado a
# mano se equivoca. Cada mutante tiene que perder UNA cosa y poner rojo al chequeo.
volcado_ok(){
  local Y="$1" k v r paso rev
  linea(){ grep -nF "displayName: '$1'" "$Y" | head -1 | cut -d: -f1; }
  k=$(linea 'Clonar los repos declarados'); v=$(linea 'Volcar el estado de los pedidos de trabajo'); r=$(linea 'Correr la revisión de dependencias')
  { [ -n "$k" ] && [ -n "$v" ] && [ -n "$r" ] && [ "$k" -lt "$v" ] && [ "$v" -lt "$r" ]; } || { echo "orden incorrecto o paso ausente — clonar=$k volcar=$v revisión=$r"; return; }
  paso=$(sed -n "$(( k + 1 )),$(( v + 3 ))p" "$Y")     # en este YAML el `script:` va antes de su displayName
  rev=$(sed -n "$(( v + 4 )),${r}p" "$Y")
  echo "$paso" | grep -E -- "$VOLCAR" >/dev/null || { echo "el paso no corre «state»"; return; }
  echo "$paso" | grep -F 'AZURE_DEVOPS_EXT_PAT: $(System.AccessToken)' >/dev/null || { echo "el paso no tiene el token"; return; }
  echo "$paso" | grep 'set -uo pipefail' >/dev/null || { echo "el paso no tiene pipefail"; return; }
  ! echo "$paso" | grep -E '^[[:space:]]*continueOnError:' >/dev/null || { echo "el paso tiene continueOnError"; return; }
  echo "$paso" | grep 'task.logissue type=warning' >/dev/null || { echo "el código 2 no deja un warning"; return; }
  echo "$paso" | grep 'task.setvariable variable=HOY_NOCTURNO' >/dev/null || { echo "el paso no publica la fecha de la noche"; return; }
  echo "$paso" | grep -E -- "${HOY_OPC} \"[\$]HOY\"" >/dev/null || { echo "«state» no recibe --today"; return; }
  echo "$rev" | grep 'HOY_NOCTURNO:-' >/dev/null || { echo "la revisión no toma la fecha del volcado"; return; }
  echo "ok"
}
sin_linea(){ grep -vF -- "$1" "$YAML"; }
salida=$(volcado_ok "$YAML")
sin_linea 'AZURE_DEVOPS_EXT_PAT: $(System.AccessToken)' > "$TMP/m1.yml"     # borra el token de TODOS los pasos
m1=$(volcado_ok "$TMP/m1.yml")
grep -vE -- "$VOLCAR" "$YAML" > "$TMP/m2.yml"; m2=$(volcado_ok "$TMP/m2.yml")
sed 's/HOY_NOCTURNO:-/HOY_PROPIO:-/' "$YAML" > "$TMP/m3.yml"; m3=$(volcado_ok "$TMP/m3.yml")
awk "/displayName: 'Volcar el estado de los pedidos de trabajo'/ { \$0 = \"        displayName: 'Otro paso'\" } { print }" "$YAML" > "$TMP/m4.yml"; m4=$(volcado_ok "$TMP/m4.yml")
{ [ "$salida" = ok ] && [ "$m1" != ok ] && [ "$m2" != ok ] && [ "$m3" != ok ] && [ "$m4" != ok ]; } \
  && ok "T23: el volcado va entre el clon y la revisión con el token y pipefail, publica la fecha de la noche que la revisión usa, y cada mutante (sin token, sin guion, fecha propia, sin paso) pone rojo el chequeo" \
  || no "T23: «${salida}» · mutantes: sin-token=«${m1}» sin-guion=«${m2}» fecha-propia=«${m3}» sin-paso=«${m4}»"

# ── T25r. 🔴 el repos.json de EJEMPLO del modelo público declara el vocabulario ─────────────────────────────────────
# Las demás pruebas usan una configuración fabricada. Sin la lista en el archivo real,
# el cruce, con razón, no clasificaría NINGÚN cerrado — en verde en
# todas las suites. En el público se mira el EJEMPLO que copia cada organización (el repos.json de
# cada equipo vive en su repo de operaciones): un ejemplo sin la lista enseñaría a no ponerla.
# Se exige PRESENCIA y FORMA (lista de textos no vacía), no los valores: agregar o sacar un motivo a
# propósito no es una regresión, y un conteo o una lista exacta sobre un archivo compartido se rompe con
# el cambio legítimo siguiente. Los valores se prueban en T9/T25, con la
# configuración armada a mano.
real=$(node -e 'try { const c = require(process.argv[1]); const m = c.azure && c.azure.motivos_arreglado;
  const ok = Array.isArray(m) && m.length > 0 && m.every((x) => typeof x === "string" && x.trim() !== "");
  console.log(ok ? "ok" : JSON.stringify(m)); } catch (e) { console.log("<<" + e.message + ">>"); }' "$AQUI/pipelines/operations/examples/repos.json")
[ "$real" = ok ] \
  && ok "T25r: 🔴 el repos.json de ejemplo del modelo declara motivos_arreglado como una lista de textos no vacía (sin ella, el cruce no clasifica nada)" \
  || no "T25r: azure.motivos_arreglado del repos.json de ejemplo = ${real}"

# ════ más casos: ramas de error y de cobertura ═════════════════════

# ── el arranque dice «no se pudo buscar Bugs sueltos» y un cruce ilegible ───────────────
o7=$(aviso "$(cruce huerfanos_no_consultados '[{"proyecto":"ProyB","motivo":"no pude consultar los Bugs del arnés (salió 1)"}]')")
o8=$(aviso 'null')
o9=$(aviso '"no soy un objeto"')
{ echo "$o7" | grep 'no se pudo buscar Bugs sueltos en 1 proyecto(s) — ProyB' >/dev/null \
  && echo "$o8" | grep 'cruce del estado de los pedidos está ILEGIBLE' >/dev/null && echo "$o9" | grep 'ILEGIBLE' >/dev/null; } \
  && ok "C1/D1 (story 4.5, 5b): el arranque dice cuando no se pudo buscar Bugs sueltos, y un cruce que no es un objeto se dice ILEGIBLE en vez de callar" \
  || no "C1/D1: no-consultados=«$(echo "$o7" | tr '\n' ' ' | cut -c1-200)» · null=«$(echo "$o8" | tr '\n' ' ' | cut -c1-200)» · string=«$(echo "$o9" | tr '\n' ' ' | cut -c1-160)»"

# ── simulado: un Bug suelto de una ficha VIVA no sale también como «habría creado» ────────────
mundo; config false
ficha pending abc12345 browserslist "A/A"
snapshot "$(presente abc12345 browserslist)"; suelto abc12345
rc=$(correr)
{ [ "$rc" -eq 0 ] && ped 'p.huerfanos_adoptados.length === 1 && !p.creados.some((c) => c.ficha === "abc12345" && c.proyecto === "Proy A") && !p.sin_pedido.some((x) => x.ficha === "abc12345")'; } \
  && ok "I1 (story 4.5, 5b): en simulado, el Bug suelto que se adoptaría no aparece además como un pedido que se crearía" \
  || no "I1: rc=${rc} · $(pie)"

# ── T2b/T3b/T4b. las ramas de error del aviso ─────────────────────────────────────────────────────
mundo; rm "$TMP/fixaz/identidades-${BACKUP_OWNER_MAIL}.json"
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101"
snapshot "$(presente abc12345 browserslist)" "$(cv arreglado)"
rc=$(correr); t2b=0; { [ "$rc" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ] && ped 'p.fallidos.some((x) => x.paso === "aviso-cerrado-vivo" && /mención al responsable de respaldo/.test(x.motivo))'; } && t2b=1
mundo
snapshot "$(presente abc12345 browserslist)" "$(cv arreglado)"
rc=$(correr); t3b=0; { [ "$rc" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ] && ped 'p.fallidos.some((x) => x.paso === "aviso-cerrado-vivo" && /no está viva/.test(x.motivo))'; } && t3b=1
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101"
snapshot "$(presente abc12345 browserslist)" "$(cv arreglado)"; chmod 444 "$TMP/pend/pending/abc12345.yaml"
rc=$(correr); chmod 644 "$TMP/pend/pending/abc12345.yaml"
t4b=0; { [ "$rc" -eq 0 ] && [ "$(cuenta comentario)" -eq 1 ] && ped 'p.fallidos.some((x) => x.paso === "escribir-ficha" && /avisé en el Bug 101 pero no pude marcarlo/.test(x.motivo)) && p.cerrados_vivos_avisados.length === 1'; } && t4b=1
[ "$t2b$t3b$t4b" = 111 ] \
  && ok "T2b/T3b/T4b (story 4.5): sin la identidad del responsable de respaldo no se avisa (y se dice); una ficha que ya no está viva es un fallo; un marcador que no se puede escribir después de comentar queda en fallidos" \
  || no "T2b/T3b/T4b: sin-respaldo=${t2b} ficha-no-viva=${t3b} marcar-falla=${t4b} · $(pie)"

# ── T5b. el `show` de un candidato falla a mitad de la lista: el proyecto entero es «no consultado» ─
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101"
wi 101 Active New "arnes-hallazgo; arnes:abc12345"; revs 101
wi 150 Active New "arnes-hallazgo; arnes:abc12345"; wi 170 Active New "arnes-hallazgo; arnes:qqq"
echo '{ "workItems": [ { "id": 150 }, { "id": 170 } ] }' > "$TMP/fixaz/wiql-Proy A.json"
rc=$(TYCON_AZ_FAIL='wi:"170"' estado)
{ [ "$rc" -eq 0 ] && volc 'v.huerfanos.length === 0 && v.huerfanos_no_consultados.some((x) => x.proyecto === "Proy A" && /170/.test(x.motivo))'; } \
  && ok "T5b (story 4.5): si el show de un Bug candidato falla, lo encontrado en ese proyecto se descarta y el proyecto sale «no consultado» (una lectura a medias no es «estos son todos»)" \
  || no "T5b: rc=${rc} · $(volcj)"

# ── 🔴 «ya no aparece» vuelve a poder decirse SÓLO donde volvió ──
# Borrar `pagado_avisado:` entero al reactivar la ficha haría que el proyecto donde
# nada cambió recibiera otra vez «ya no aparece». Por eso el marcador de un proyecto se borra la noche en que la
# vulnerabilidad vuelve a aparecer AHÍ, y el otro proyecto lo conserva.
mundo
ficha pending abc12345 browserslist "A/A,B/B" "reaparecido: 2026-09-09" "pedidos:" "  - Proy A: 101" "  - ProyB: 201" "pagado_avisado:" "  - Proy A (2026-09-05)" "  - ProyB (2026-09-05)"
snapshot "$(presente abc12345 browserslist)"
rc=$(correr)
p1=$(node -e 'const n = require(process.argv[1]); console.log(JSON.stringify(n.listaDe(require("fs").readFileSync(process.argv[2], "utf8"), "pagado_avisado")));' "$AQUI/scripts/nightly/dependencies/nightly-dependencies.js" "$TMP/pend/pending/abc12345.yaml")
{ [ "$rc" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ] && [ "$p1" = '["ProyB (2026-09-05)"]' ]; } \
  && ok "P1 (story 4.5, vuelta 2): 🔴 cuando la vulnerabilidad vuelve en Proy A se borra sólo su «ya avisado», y ProyB —donde nada cambió— no recibe otro «ya no aparece»" \
  || no "P1: rc=${rc} comentarios=$(cuenta comentario) pagado_avisado=${p1}"
# ── la rama que rehabilita «ya no aparece»: simulado no escribe; un fallo se dice ──
mundo; config false
ficha pending abc12345 browserslist "A/A" "reaparecido: 2026-09-09" "pedidos:" "  - Proy A: 101" "pagado_avisado:" "  - Proy A (2026-09-05)"
snapshot "$(presente abc12345 browserslist)"; cp "$TMP/pend/pending/abc12345.yaml" "$TMP/antes.yaml"
rc=$(correr); p1b=0; { [ "$rc" -eq 0 ] && cmp -s "$TMP/antes.yaml" "$TMP/pend/pending/abc12345.yaml"; } && p1b=1
mundo
ficha pending abc12345 browserslist "A/A" "reaparecido: 2026-09-09" "pedidos:" "  - Proy A: 101" "pagado_avisado:" "  - Proy A (2026-09-05)"
snapshot "$(presente abc12345 browserslist)"; chmod 444 "$TMP/pend/pending/abc12345.yaml"
rc=$(correr); chmod 644 "$TMP/pend/pending/abc12345.yaml"
p1c=0; { [ "$rc" -eq 0 ] && ped 'p.fallidos.some((x) => x.paso === "escribir-ficha" && x.proyecto === "Proy A" && /no pude borrar el «ya no aparece» de Proy A/.test(x.motivo))' && grep -qx '  - Proy A (2026-09-05)' "$TMP/pend/pending/abc12345.yaml"; } && p1c=1
[ "$p1b$p1c" = 11 ] \
  && ok "P1b/P1c (story 4.5, vuelta 3): en simulado la ficha no se toca aunque la vulnerabilidad haya vuelto; si el marcador no se puede borrar, el fallo queda en fallidos" \
  || no "P1b/P1c: simulado-no-escribe=${p1b} fallo-dicho=${p1c} · $(pie)"
# ── T30. el volcado guarda el NOMBRE de quien tiene la tarea, nunca su correo ─────────────────
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101" "  - Proy A: 102" "  - Proy A: 103"
wi 101 Active New; wi 102 Active New; wi 103 New New
asignar(){ node -e 'const [f, v] = process.argv.slice(1); const w = JSON.parse(require("fs").readFileSync(f, "utf8")); w.fields["System.AssignedTo"] = JSON.parse(v); require("fs").writeFileSync(f, JSON.stringify(w));' "$TMP/fixaz/wi-$1.json" "$2"; }
asignar 101 '{"displayName":"Ana Pérez","uniqueName":"ana@prueba"}'
asignar 102 '{"displayName":"ana@prueba","uniqueName":"ana@prueba"}'
revs 101; revs 102; revs 103
rc=$(estado)
{ [ "$rc" -eq 0 ] && volc 'v.pedidos["101"].asignado === "Ana Pérez" && v.pedidos["102"].asignado === null && v.pedidos["103"].asignado === null' \
  && volc 'v.pedidos["101"].sin_asignar === false && v.pedidos["102"].sin_asignar === false && v.pedidos["103"].sin_asignar === true' \
  && ! grep -q 'ana@prueba' "$TMP/out/bugs-$HOY.json"; } \
  && ok "T30: el volcado guarda el nombre de quien tiene cada tarea; un correo como nombre, o sin asignar, queda en null; la que no tiene a nadie lo dice" \
  || no "T30: rc=$rc · $(volcj)"

# ── T31. la noche anota en la ficha quién tiene cada tarea, por qué falta alguna, y con el sitio la pasa a «arreglar» ──
# Con el sitio, la vulnerabilidad que ya tiene su tarea no espera una decisión: queda en promoted/ con `veredicto:
# util`, y sus `asignados:` dicen el nombre de cada uno. Sin el sitio, la ficha se queda donde está.
ops_con_sitio(){ printf '{ "version": 1, "owners": { "default": "respaldo@prueba" }, "site": { "access": [{ "role": "maintainer", "emails": ["respaldo@prueba"] }], "url": "https://sitio.prueba" } }\n' > "$TMP/ops.json"; }
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101" "pedido_motivo: tope"
snapshot "$(presente abc12345 browserslist)"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ fecha: process.argv[2], consultado: true, proyectos: {}, huerfanos: [], huerfanos_no_consultados: [],
  pedidos: { "101": { ficha: "abc12345", proyecto: "Proy A", leido: true, estado: "Active", categoria: "InProgress", asignado: "Ana Pérez" } } }))' "$TMP/out/bugs-$HOY.json" "$HOY"
wi 101 Active New; revs 101
ops_con_sitio
rc=$(correr --operations "$TMP/ops.json")
F="$TMP/pend/promoted/abc12345.yaml"
{ [ "$rc" -eq 0 ] && [ -f "$F" ] && [ ! -f "$TMP/pend/pending/abc12345.yaml" ] && grep -qx 'veredicto: util' "$F" \
  && grep -qx 'asignados:' "$F" && grep -qx '  - 101: Ana Pérez' "$F" && ! grep -q '^pedido_motivo:' "$F" && grep -qx '  - Proy A: 101' "$F"; } \
  && ok "T31: con el sitio, la ficha con su tarea pasa a «arreglar» en promoted/, con el nombre de quien la tiene y sin el motivo viejo" \
  || no "T31: rc=$rc · $(cat "$F" "$TMP/pend/pending/abc12345.yaml" 2>/dev/null | tr '\n' '|' | cut -c1-400) · $(pie)"
# T31d. 🔴 la tarea leída sin nadie se anota con «<nadie>»; la leída con alguien sin nombre que mostrar (un correo), con
# «<alguien>»; la que no se pudo leer no se anota: el sitio dice «sin asignar» sólo de la primera
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101" "  - Proy A: 102" "  - Proy A: 103" "  - Proy A: 104"
snapshot "$(presente abc12345 browserslist)"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ fecha: process.argv[2], consultado: true, proyectos: {}, huerfanos: [], huerfanos_no_consultados: [],
  pedidos: { "101": { ficha: "abc12345", proyecto: "Proy A", leido: true, estado: "Active", categoria: "InProgress", asignado: "Ana Pérez", sin_asignar: false },
    "102": { ficha: "abc12345", proyecto: "Proy A", leido: true, estado: "Active", categoria: "InProgress", asignado: null, sin_asignar: true },
    "103": { ficha: "abc12345", proyecto: "Proy A", leido: false, estado: null, categoria: null, asignado: null, sin_asignar: null },
    "104": { ficha: "abc12345", proyecto: "Proy A", leido: true, estado: "Active", categoria: "InProgress", asignado: null, sin_asignar: false } } }))' "$TMP/out/bugs-$HOY.json" "$HOY"
wi 101 Active New; revs 101; wi 102 Active New; revs 102; wi 103 Active New; revs 103; wi 104 Active New; revs 104
ops_con_sitio
rc=$(correr --operations "$TMP/ops.json")
F="$TMP/pend/promoted/abc12345.yaml"
{ [ "$rc" -eq 0 ] && [ -f "$F" ] && grep -qx '  - 101: Ana Pérez' "$F" && grep -qx '  - 102: <nadie>' "$F" && grep -qx '  - 104: <alguien>' "$F" && ! grep -q '^  - 103: ' "$F"; } \
  && ok "T31d: la tarea leída sin nadie queda anotada como «<nadie>»; con alguien sin nombre, «<alguien>»; la que no se leyó, sin anotar" \
  || no "T31d: rc=$rc · $(cat "$F" "$TMP/pend/pending/abc12345.yaml" 2>/dev/null | tr '\n' '|' | cut -c1-400) · $(pie)"
# sin el sitio, se anota igual pero la ficha no se mueve; y la que no tiene tarea dice por qué
mundo
ficha pending abc12345 browserslist "A/A" "pedidos:" "  - Proy A: 101"
ficha pending zzz99999 lodash "B/B,X/Y"
config false
snapshot "[$(presente abc12345 browserslist | sed 's/^\[//; s/\]$//'),{\"id\":\"zzz99999\",\"paquete\":\"lodash\",\"severidad\":\"high\",\"advisories\":[],\"repos\":[{\"repo\":\"B/B\",\"declarada\":false,\"vence\":null},{\"repo\":\"X/Y\",\"declarada\":false,\"vence\":null}]}]"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ fecha: process.argv[2], consultado: true, proyectos: {}, huerfanos: [], huerfanos_no_consultados: [],
  pedidos: { "101": { ficha: "abc12345", proyecto: "Proy A", leido: true, estado: "Active", categoria: "InProgress", asignado: "Ana Pérez" } } }))' "$TMP/out/bugs-$HOY.json" "$HOY"
wi 101 Active New; revs 101
cp "$TMP/pend/pending/zzz99999.yaml" "$TMP/antes-z.yaml"
rc=$(correr --operations "$TMP/no-hay.json")
p31b=0; { [ "$rc" -eq 0 ] && cmp -s "$TMP/antes-z.yaml" "$TMP/pend/pending/zzz99999.yaml" && ! grep -q 'asignados:' "$TMP/pend/pending/abc12345.yaml"; } && p31b=1
config true
rc=$(correr --operations "$TMP/no-hay.json")
p31c=0; { [ "$rc" -eq 0 ] && [ -f "$TMP/pend/pending/abc12345.yaml" ] && grep -qx '  - 101: Ana Pérez' "$TMP/pend/pending/abc12345.yaml" \
  && grep -qx 'veredicto: pendiente' "$TMP/pend/pending/abc12345.yaml" && grep -qE '^pedido_motivo: (sin-proyecto|falla|tope)$' "$TMP/pend/pending/zzz99999.yaml"; } && p31c=1
[ "$p31b$p31c" = 11 ] \
  && ok "T31b: en simulado no se escribe nada; sin el sitio la ficha se anota y se queda en pending/, y la que falta dice por qué" \
  || no "T31b: simulado=$p31b anotado=$p31c · $(cat "$TMP/pend/pending/zzz99999.yaml" | tr '\n' '|' | cut -c1-300) · $(pie)"
echo
total=$((pasaron + fallos))
[ "$fallos" -eq 0 ] && { echo "✅ estado-de-pedidos: $pasaron/$total"; exit 0; } \
  || { echo "❌ estado-de-pedidos: $fallos fallo(s) de $total"; exit 1; }
