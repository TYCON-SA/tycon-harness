#!/usr/bin/env bash
# Prueba de work-items.js — el pedido propio de cualquier tipo.
#
# El pedido del arnés deja de ser siempre un Bug: una organización puede convertirlo a otro tipo (en un proceso propio,
# un tipo con estados como «Identificado … Cerrado»), y el nocturno lo tiene que seguir cerrando, reabriendo y
# comentando. Lo que no se puede perder:
#   · un pedido es propio por su proyecto y sus etiquetas (`arnes:<id>` y `arnes-hallazgo`), no por su tipo;
#   · las categorías de estado se leen del TIPO del pedido (no del Bug), y si no se pueden leer, ese pedido no se cierra
#     ni se reabre y el fallo se dice (falla cerrado);
#   · lo que una persona resolvió (categoría Resolved) o creó no se cierra, en cualquier tipo.
#
# Mismo `az` de mentira que work-items.test.sh (scripts/tests/lib/fake-az.sh); nunca toca la red. Los ayudantes del
# mundo de prueba son los de esa suite, copiados.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PED="$AQUI/scripts/nightly/dependencies/work-items.js"
DOBLE="$AQUI/scripts/tests/lib/fake-az.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ pedidos-tipo: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ pedidos-tipo: $1"; fallos=$((fallos+1)); }

if [ -f "$DOBLE" ]; then cp "$DOBLE" "$TMP/az"; chmod +x "$TMP/az"; fi
HOY=2026-09-10
export BACKUP_OWNER_ID=7bb1c00b-0000-0000-0000-00000000a41e
BACKUP_OWNER_MAIL=respaldo@prueba   # el fixture de la API de identidades se llama por el mail

# ── el mundo de prueba ────────────────────────────────────────────────────────────────────────────
# Cuatro repos en tres proyectos: A/A y A/A2 en «Proy A» (con espacio, codificado como en la URL),
# B/B en ProyB, C/C en ProyC. Dos administradores por defecto: Dana y el responsable de respaldo (con OTRAS mayúsculas
# que en la config, para que la comparación sin distinguir mayúsculas se pruebe siempre).
mundo(){
  rm -rf "$TMP/pend" "$TMP/out" "$TMP/fixaz"
  mkdir -p "$TMP/pend/pending" "$TMP/pend/promoted" "$TMP/pend/archived" "$TMP/out" "$TMP/fixaz"
  echo 100 > "$TMP/fixaz/contador"
  cat > "$TMP/fixaz/miembros.json" <<'J'
{ "aad.dan": { "subjectKind": "user", "displayName": "Dana Prueba", "principalName": "dana@prueba", "mailAddress": "dana@prueba" },
  "aad.res": { "subjectKind": "user", "displayName": "Respaldo Prueba", "principalName": "Respaldo@Prueba", "mailAddress": "Respaldo@Prueba" } }
J
  cat > "$TMP/fixaz/identidades-${BACKUP_OWNER_MAIL}.json" <<J
{ "count": 1, "value": [ { "id": "$BACKUP_OWNER_ID", "providerDisplayName": "Respaldo Prueba" } ] }
J
  config
}

config(){ # [pedidos_activos=true] [respaldo=respaldo@prueba] [org=https://dev.azure.com/prueba] [tope=2]
  node -e '
const [act, ari, org, tope, f] = process.argv.slice(1);
const azure = { fallback_owner: ari, pedidos_activos: act === "true" };
if (org) azure.org = org;
const c = { presupuesto_de_ruido: { tope_pr_por_noche: Number(tope) }, azure, repos: [
  { producto: "A", ruta: "A",  ado: "Proy%20A/A",  tipo: "npm", activo: true },
  { producto: "A", ruta: "A2", ado: "Proy%20A/A2", tipo: "npm", activo: true },
  { producto: "B", ruta: "B",  ado: "ProyB/B",     tipo: "npm", activo: true },
  { producto: "C", ruta: "C",  ado: "ProyC/C",     tipo: "npm", activo: true } ] };
require("fs").writeFileSync(f, JSON.stringify(c, null, 2));' \
    "${1:-true}" "${2-respaldo@prueba}" "${3-https://dev.azure.com/prueba}" "${4:-2}" "$TMP/c.json"
}

ficha(){ # <carpeta> <id> <paquete> <severidad> <noches> <repos,separados,por,coma> [líneas extra...]
  local dir="$1" id="$2" paq="$3" sev="$4" noches="$5" repos="$6"; shift 6
  {
    echo "id: $id"
    echo "detectado: ${DETECTADO:-2026-09-08}"
    if [ "$dir" = promoted ]; then echo "veredicto: util"; else echo "veredicto: pendiente"; fi
    echo "paquete: $paq"; echo "severidad: $sev"; echo "noches: $noches"
    for l in "$@"; do printf '%s\n' "$l"; done
    echo "ids:"; echo "  - $id"
    if [ -n "$repos" ]; then
      echo "repos:"
      local IFS=','; for r in $repos; do echo "  - $r"; done
    fi
    echo "avisos:"; echo "  - https://github.com/advisories/GHSA-73wf-$id"
    echo "# Qué decidir: el pie de siempre."
  } > "$TMP/pend/$dir/$id.yaml"
}

p1(){ # <id> <paquete> <repo[@vence]>... → UNA presencia (con @vence = declarada)
  node -e '
const [id, paquete, ...rs] = process.argv.slice(1);
console.log(JSON.stringify({ id, paquete, severidad: "high", advisories: [], repos: rs.map((x) => {
  const [repo, vence] = x.split("@"); return { repo, declarada: !!vence, vence: vence || null }; }) }));' "$@"
}

snapshot(){ # <fecha> <presencias JSON> [repos sin medir, "A/A2,B/B"]
  node -e '
const [fecha, pres, sinMedir, f] = process.argv.slice(1);
const nm = new Set(sinMedir ? sinMedir.split(",") : []);
const repos = [["A","A"],["A","A2"],["B","B"],["C","C"]].map(([p, r]) => ({ producto: p, ruta: r, medido: !nm.has(`${p}/${r}`) }));
require("fs").writeFileSync(f, JSON.stringify({ fecha, corrida_completa: nm.size === 0, repos,
  presencias: JSON.parse(pres), hallazgos: [], anunciados_hoy: [] }, null, 2));' "$1" "$2" "${3:-}" "$TMP/out/dependencias-$1.json"
}

correr(){ # [flags extra...] → imprime el código de salida; la salida queda en $TMP/o.txt
  FIXAZ="$TMP/fixaz" TYCON_ADO_CMD="${AZ_CMD:-$TMP/az}" AZURE_DEVOPS_EXT_PAT="${PAT-pat-de-prueba}" \
    node "$PED" run --config "$TMP/c.json" --pending "$TMP/pend" --out "$TMP/out" --today "${HOYC:-$HOY}" "$@" \
    >"$TMP/o.txt" 2>&1
  echo $?
}

cuenta(){ # <paso> → cuántas llamadas de ese paso recibió el `az` de mentira
  if [ -f "$TMP/fixaz/llamadas.log" ]; then
    awk -F'\t' -v p="$1" '$1 == p' "$TMP/fixaz/llamadas.log" | wc -l | tr -d ' '
  else echo 0; fi
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

ped(){ # <expresión JS sobre p = snapshot.pedidos, s = snapshot> [fecha]
  node -e '
const [f, expr] = process.argv.slice(1);
let s; try { s = JSON.parse(require("fs").readFileSync(f, "utf8")); } catch { process.exit(1); }
const p = s.pedidos;
process.exit(eval(expr) ? 0 : 1);' "$TMP/out/dependencias-${2:-$HOY}.json" "$1"
}

pie(){ tail -4 "$TMP/o.txt" | tr '\n' ' '; }

estado(){ # [flags extra...] → `state` (el volcado de la noche, con los pedidos sueltos)
  FIXAZ="$TMP/fixaz" TYCON_ADO_CMD="${AZ_CMD:-$TMP/az}" AZURE_DEVOPS_EXT_PAT="${PAT-pat-de-prueba}" \
    node "$PED" state --config "$TMP/c.json" --pending "$TMP/pend" --out "$TMP/out" --today "${HOYC:-$HOY}" "$@" \
    >"$TMP/o.txt" 2>&1
  echo $?
}
volc(){ # <expresión JS sobre v = el volcado de hoy>
  node -e 'const [f, expr] = process.argv.slice(1); let v; try { v = JSON.parse(require("fs").readFileSync(f, "utf8")); } catch { process.exit(1); } process.exit(eval(expr) ? 0 : 1);' \
    "$TMP/out/bugs-$HOY.json" "$1"
}
# las categorías de un tipo en un proyecto: «agile» (el Bug de Agile), «riesgo» (un tipo propio, con los nombres de
# un proceso en castellano) o «story» (el User Story de Agile)
estados(){ # <proyecto> <forma: agile|riesgo|story> <tipo>
  node -e '
const [p, forma, tipo, dir] = process.argv.slice(1);
const v = { agile: [["New","Proposed"],["Active","InProgress"],["Resolved","Resolved"],["Closed","Completed"]],
  riesgo: [["Identificado","Proposed"],["En Análisis","InProgress"],["En Mitigación","InProgress"],["Materializado","InProgress"],["Mitigado","Resolved"],["Cerrado","Completed"]],
  story: [["New","Proposed"],["Active","InProgress"],["Resolved","Resolved"],["Closed","Completed"],["Removed","Removed"]] }[forma];
require("fs").writeFileSync(`${dir}/estados-${p}-${tipo}.json`, JSON.stringify({ count: v.length, value: v.map(([name, category]) => ({ name, category })) }));' "$1" "$2" "$3" "$TMP/fixaz"
}
wi(){ # <id> <estado> <proyecto> <tipo> [creador=svc.build] [etiquetas="arnes-hallazgo; arnes:abc12345"] [cambio de estado=2026-09-01T04:00:00Z]
  node -e '
const [id, estado, proyecto, tipo, creador, tags, cambio, dir] = process.argv.slice(1);
require("fs").writeFileSync(`${dir}/wi-${id}.json`, JSON.stringify({ id: Number(id), fields: { "System.State": estado,
  "System.TeamProject": proyecto, "System.WorkItemType": tipo, "System.Tags": tags, "Microsoft.VSTS.Common.StateChangeDate": cambio,
  "System.AssignedTo": { id: "dan00000-0000-0000-0000-00000000f3e1", displayName: "Dana Prueba", uniqueName: "dana@prueba" },
  "System.CreatedBy": { displayName: creador.startsWith("svc.") ? "Project Collection Build Service (prueba)" : "Una Persona", descriptor: creador } } }));' \
    "$1" "$2" "$3" "$4" "${5:-svc.build}" "${6:-arnes-hallazgo; arnes:abc12345}" "${7:-2026-09-01T04:00:00Z}" "$TMP/fixaz"
}
revs(){ # <id> — dos revisiones del pipeline, ninguna de una persona
  node -e '
const [id, f] = process.argv.slice(1);
const svc = { displayName: "Project Collection Build Service (acme)", uniqueName: "Build\\64bea6b8", descriptor: "svc.XXX" };
require("fs").writeFileSync(f, JSON.stringify({ count: 1, value: [ { rev: 1, fields: { "System.ChangedDate": "2026-08-25T04:00:00Z", "System.ChangedBy": svc, "System.State": "Identificado" } } ] }));' "$1" "$TMP/fixaz/revisiones-$1.json"
}
# «ya no aparece» en Proy A: la ficha nombra el pedido 301 en Proy A y la vulnerabilidad sólo sigue en B/B
pagado(){ # <estado> <tipo> [creador] [etiquetas]
  mundo
  ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
  wi 301 "$1" "Proy A" "$2" "${3:-svc.build}" "${4:-arnes-hallazgo; arnes:abc12345}"
  snapshot $HOY "[$(p1 abc12345 browserslist B/B)]"
}

# ── T18 (AC 12, 13). un Bug propio se sigue cerrando, con las categorías de SU tipo ────────────────────
pagado New Bug; estados "Proy A" agile Bug
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada actualizar 0 'arg("--id") === "301" && arg("--state") === "Closed"' \
  && llamada estados 0 'a.includes("type=Bug")' && ped 'p.pagados_avisados[0].cerrado === true'; } \
  && ok "T18: un Bug propio se cierra como siempre, con las categorías del Bug" \
  || no "T18: rc=$rc cierres=$(cuenta actualizar) · $(pie)"

# ── T19 (AC 13). un Riesgo y un User Story propios se cierran por categoría; el Riesgo se reabre a su estado inicial ──
pagado "En Análisis" Riesgo; estados "Proy A" riesgo Riesgo
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada actualizar 0 'arg("--id") === "301" && arg("--state") === "Cerrado"' \
  && llamada estados 0 'a.includes("type=Riesgo")' && llamada comentario 0 'b.includes("ya no aparece") && b.includes("Cierro este pedido")' \
  && ped 'p.pagados_avisados[0].cerrado === true'; } \
  && ok "T19: un Riesgo propio se cierra a su estado de cierre (Cerrado), leído de las categorías del Riesgo" \
  || no "T19 riesgo: rc=$rc cierres=$(cuenta actualizar) · $(pie)"
pagado Active "User Story"; estados "Proy A" story "User Story"
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada actualizar 0 'arg("--id") === "301" && arg("--state") === "Closed"'; } \
  && ok "T19: un User Story propio se cierra por categoría" \
  || no "T19 story: rc=$rc cierres=$(cuenta actualizar) · $(pie)"
mundo
ficha pending abc12345 browserslist high 3 "A/A" "pedidos:" "  - Proy A: 301" "pagado_avisado:" "  - Proy A (2026-09-08, cerrado por el arnés)"
wi 301 Cerrado "Proy A" Riesgo svc.build "arnes-hallazgo; arnes:abc12345" 2026-09-08T04:03:11Z; estados "Proy A" riesgo Riesgo
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada actualizar 0 'arg("--id") === "301" && arg("--state") === "Identificado"' \
  && llamada comentario 0 'b.includes("Volvió a aparecer") && b.includes("Reabro este pedido")' \
  && ped 'JSON.stringify(p.reabiertos) === JSON.stringify([{ ficha: "abc12345", proyecto: "Proy A", id: 301 }])'; } \
  && ok "T19: la vulnerabilidad vuelve a un Riesgo que cerró el arnés: se reabre a su estado inicial (Identificado)" \
  || no "T19 reabrir: rc=$rc reaperturas=$(cuenta actualizar) · $(pie)"

# ── T19b. lo que una persona resolvió (Mitigado = Resolved) o creó no se cierra, en un tipo propio ───────────────
pagado Mitigado Riesgo; estados "Proy A" riesgo Riesgo
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && llamada comentario 0 'b.includes("ya no aparece") && !b.includes("Cierro este pedido")' \
  && ped 'p.pagados_avisados[0].cerrado === false'; } \
  && ok "T19b: un Riesgo que una persona dejó Mitigado no se cierra: recibe el aviso" \
  || no "T19b mitigado: rc=$rc cierres=$(cuenta actualizar) · $(pie)"
pagado Identificado Riesgo msa.persona; estados "Proy A" riesgo Riesgo
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && ped 'p.pagados_avisados[0].cerrado === false'; } \
  && ok "T19b: un Riesgo con las etiquetas pero creado por una persona no lo cierra el arnés" \
  || no "T19b persona: rc=$rc cierres=$(cuenta actualizar) · $(pie)"

# ── T19c. 🔴 falla cerrado: sin las categorías del tipo del pedido, no se cierra ni se reabre, y se dice ──────────
pagado "En Análisis" Riesgo; estados "Proy A" agile Bug      # hay categorías del Bug, pero no del Riesgo
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && llamada comentario 0 'b.includes("No pude cerrarlo")' \
  && ped 'p.fallidos.some((x) => x.paso === "cerrar" && x.proyecto === "Proy A" && /categorías de estado/.test(x.motivo) && /Riesgo/.test(x.motivo))'; } \
  && ok "T19c: 🔴 sin las categorías del tipo del pedido (aunque haya las del Bug) no se cierra, y el fallo nombra el tipo" \
  || no "T19c: rc=$rc cierres=$(cuenta actualizar) · $(pie)"
pagado "En Análisis" ""; estados "Proy A" agile Bug
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && ped 'p.fallidos.some((x) => x.paso === "cerrar" && /tipo/.test(x.motivo))'; } \
  && ok "T19c: 🔴 un pedido sin tipo legible no se cierra, y se dice" \
  || no "T19c sin tipo: rc=$rc cierres=$(cuenta actualizar) · $(pie)"

# ── T20 (AC 12, 13). ajeno: sin las dos etiquetas, o de otro proyecto, no se toca ni se comenta ──────────────
for variante in sin-hallazgo sin-ficha proyecto; do
  case $variante in
    sin-hallazgo) pagado "En Análisis" Riesgo svc.build "arnes:abc12345" ;;
    sin-ficha)    pagado "En Análisis" Riesgo svc.build "arnes-hallazgo; cliente" ;;
    proyecto)     mundo; ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
                  wi 301 "En Análisis" ProyB Riesgo; snapshot $HOY "[$(p1 abc12345 browserslist B/B)]" ;;
  esac
  estados "Proy A" riesgo Riesgo
  rc=$(correr)
  { [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ] \
    && ped 'p.fallidos.some((x) => x.paso === "cerrar" && /no es el pedido de esta ficha/.test(x.motivo))'; } \
    && ok "T20 ($variante): un work item que no es el pedido de la ficha no se cierra ni se comenta" \
    || no "T20 ($variante): rc=$rc cierres=$(cuenta actualizar) comentarios=$(cuenta comentario) · $(pie)"
done

# ── T21 (AC 14). el volcado lee un Riesgo con las categorías del Riesgo, y un suelto de tipo Riesgo se encuentra ───
mundo
ficha pending abc12345 browserslist high 3 "A/A" "pedidos:" "  - Proy A: 301"
wi 301 "En Mitigación" "Proy A" Riesgo; revs 301
wi 150 Identificado "Proy A" Riesgo svc.build "arnes-hallazgo; arnes:def67890"; revs 150
estados "Proy A" riesgo Riesgo
echo '{ "workItems": [ { "id": 301 }, { "id": 150 } ] }' > "$TMP/fixaz/wiql-Proy A.json"
rc=$(estado)
{ [ "$rc" -eq 0 ] && volc 'v.pedidos["301"] && v.pedidos["301"].leido === true && v.pedidos["301"].categoria === "InProgress"' \
  && volc 'JSON.stringify(v.huerfanos.filter((x) => x.proyecto === "Proy A")) === JSON.stringify([{ id: 150, proyecto: "Proy A", ficha: "def67890", estado: "Identificado", categoria: "Proposed" }])'; } \
  && ok "T21: el volcado lee un Riesgo con sus categorías, y un Riesgo suelto del arnés se encuentra con su categoría" \
  || no "T21: rc=$rc · $(pie) · $(cat "$TMP/out/bugs-$HOY.json" 2>/dev/null | head -c 400)"

# ══ el pedido se crea con el tipo y los campos que declara la organización ═══════════════════════════════════
# Sin `work_items` en operations.json, el tipo es el elemento de backlog del proyecto (la categoría
# Microsoft.RequirementCategory); con la clave, el tipo y sus campos. Si el tipo no existe en un proyecto, ese proyecto
# usa el de fábrica y se dice; un campo obligatorio del tipo que nadie cubre no deja crear un pedido a medias.
cats(){ # <proyecto> <tipo por defecto del elemento de backlog>
  node -e 'const [p, t, dir] = process.argv.slice(1); require("fs").writeFileSync(`${dir}/categorias-${p}.json`, JSON.stringify({ count: 2, value: [
  { referenceName: "Microsoft.BugCategory", defaultWorkItemType: { name: "Defecto" } }, { referenceName: "Microsoft.RequirementCategory", defaultWorkItemType: { name: t } } ] }));' "$1" "$2" "$TMP/fixaz"
}
campos(){ # <proyecto> <tipo> <campos separados por coma; con * al final, obligatorio>
  node -e 'const [p, t, lista, dir] = process.argv.slice(1); const v = lista.split(",").filter(Boolean).map((x) => ({ referenceName: x.replace(/\*$/, ""), alwaysRequired: x.endsWith("*") }));
require("fs").writeFileSync(`${dir}/campos-${p}-${t}.json`, JSON.stringify({ count: v.length, value: v }));' "$1" "$2" "$3" "$TMP/fixaz"
}
opsw(){ # <work_items en JSON, o vacío> → operations.json con el responsable de siempre
  node -e 'const [w, f] = process.argv.slice(1); const d = { version: 1, owners: { default: "respaldo@prueba" } }; if (w) d.work_items = JSON.parse(w);
require("fs").writeFileSync(f, JSON.stringify(d));' "${1:-}" "$TMP/operations.json"
}
BASICOS="System.Title*,System.State*,System.AreaId*,System.IterationId*,System.Description,System.Tags,System.AssignedTo"
RIESGO='{ "type": "Riesgo", "fixed_fields": { "Custom.Cat": "Seguridad-de-prueba", "Custom.Prob": 3 }, "by_severity": { "critical": { "Custom.Imp": 5, "Custom.Prio": "alto" }, "high": { "Custom.Imp": 4, "Custom.Prio": "medio" }, "moderate": { "Custom.Imp": 3, "Custom.Prio": "medio" }, "low": { "Custom.Imp": 2, "Custom.Prio": "bajo" } } }'

# ── T1 (AC 1). sin configuración, el pedido se crea con el tipo de backlog del proyecto ─────────────────────────
mundo; opsw ""
cats "Proy A" "User Story"; campos "Proy A" "User Story" "$BASICOS"
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] && llamada crear 0 'arg("--type") === "User Story"'; } \
  && ok "T1 Fabrica_SinConfiguracion_TipoDeBacklog: sin work_items, el pedido es el elemento de backlog del proyecto" \
  || no "T1: rc=$rc crear=$(cuenta crear) · $(pie)"

# ── T2 (AC 2). Basic crea Issue, Scrum PBI y CMMI Requirement: ninguna plantilla necesita «Bug» ───────────────────
mundo; opsw ""
cats "Proy A" "Issue"; campos "Proy A" "Issue" "$BASICOS"
cats ProyB "Product Backlog Item"; campos ProyB "Product Backlog Item" "$BASICOS"
cats ProyC "Requirement"; campos ProyC "Requirement" "$BASICOS"
ficha pending abc12345 browserslist high 1 "A/A,B/B,C/C"
snapshot $HOY "[$(p1 abc12345 browserslist A/A B/B C/C)]"
rc=$(correr --operations "$TMP/operations.json")
tipos=$(node -e 'const ls = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.startsWith("crear\t")).map((l) => JSON.parse(l.split("\t")[1]).args);
console.log(ls.map((a) => `${a[a.indexOf("--project") + 1]}=${a[a.indexOf("--type") + 1]}`).sort().join(";"));' "$TMP/fixaz/llamadas.log" 2>/dev/null)
{ [ "$rc" -eq 0 ] && [ "$tipos" = "Proy A=Issue;ProyB=Product Backlog Item;ProyC=Requirement" ]; } \
  && ok "T2 Fabrica_PlantillasSinBug: Basic Issue, Scrum PBI, CMMI Requirement" \
  || no "T2: rc=$rc tipos=$tipos · $(pie)"

# ── T3 (AC 1). la categoría se lee una vez por proyecto por corrida ───────────────────────────────────────────
mundo; opsw ""
cats "Proy A" "User Story"; campos "Proy A" "User Story" "$BASICOS"
ficha pending abc12345 browserslist high 1 "A/A"
ficha pending def67890 handlebars high 1 "A/A2"
snapshot $HOY "[$(p1 abc12345 browserslist A/A),$(p1 def67890 handlebars A/A2)]"
rc=$(correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 2 ] && [ "$(cuenta categorias)" -eq 1 ] && [ "$(cuenta campos)" -eq 1 ]; } \
  && ok "T3 Fabrica_CategoriaUnaVezPorProyecto: dos pedidos del mismo proyecto, una lectura de categoría y una de campos" \
  || no "T3: rc=$rc crear=$(cuenta crear) categorias=$(cuenta categorias) campos=$(cuenta campos) · $(pie)"

# ── T4 (AC 3). la gravedad va en la etiqueta y en el cuerpo aunque el tipo no tenga Severity ───────────────────
# ── T5 (AC 3). Severity y ReproSteps se mandan sólo si el tipo los tiene ────────────────────────────────────────
mundo; opsw ""
cats "Proy A" "User Story"; campos "Proy A" "User Story" "$BASICOS"
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && llamada crear 0 'a.some((x) => x.startsWith("System.Tags=") && /arnes-gravedad:high/.test(x) && /arnes-hallazgo/.test(x)) && /high/.test(b)'; } \
  && ok "T4 Gravedad_EnEtiquetaYCuerpo: la gravedad va en la etiqueta y en el cuerpo, con un tipo sin Severity" \
  || no "T4: rc=$rc · $(pie)"
{ [ "$rc" -eq 0 ] && llamada crear 0 '!a.some((x) => /^Microsoft\.VSTS\.(Common\.Severity|TCM\.ReproSteps)=/.test(x)) && a.some((x) => x.startsWith("System.Description=@"))'; } \
  && cp "$TMP/fixaz/llamadas.log" "$TMP/sin.log" \
  && { mundo; opsw ""; cats "Proy A" Bug; campos "Proy A" Bug "$BASICOS,Microsoft.VSTS.TCM.ReproSteps,Microsoft.VSTS.Common.Severity"
       ficha pending abc12345 browserslist high 1 "A/A"; snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
       rc2=$(correr --operations "$TMP/operations.json"); [ "$rc2" -eq 0 ]; } \
  && llamada crear 0 'a.some((x) => x.startsWith("Microsoft.VSTS.TCM.ReproSteps=@")) && a.some((x) => x === "Microsoft.VSTS.Common.Severity=2 - High")' \
  && ok "T5 Campos_SeveridadYReproSoloSiExisten: sin los campos no se mandan; con ellos, sí" \
  || no "T5: rc=$rc · $(pie)"

# ── T6 (AC 4). sin categoría de backlog legible no se crea, y el fallo lo dice ──────────────────────────────────
mundo; opsw ""
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(TYCON_AZ_FAIL=categorias correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] && ped 'p.fallidos.some((x) => x.paso === "tipo" && x.proyecto === "Proy A" && /backlog/.test(x.motivo))'; } \
  && ok "T6 Fabrica_SinCategoria_NoCreaYLoDice: no se inventa un tipo ni se cae a Bug" \
  || no "T6: rc=$rc crear=$(cuenta crear) · $(pie)"

# ── T7-T10 (AC 5, 6). la clave work_items y el lector de operations.json ────────────────────────────────────────
valida(){ node -e 'const o = require(process.argv[1]); const r = o.parse(process.argv[2]); console.log(JSON.stringify(r.problems || []));' "$AQUI/scripts/lib/operations-config.js" "$1"; }
base='{ "version": 1, "owners": { "default": "respaldo@prueba" }'
[ "$(valida "$base, \"work_items\": $RIESGO }")" = "[]" ] \
  && ok "T7 Config_WorkItemsValido: tipo, campos fijos y por gravedad" \
  || no "T7: $(valida "$base, \"work_items\": $RIESGO }")"
t8=$(valida "$base, \"work_items\": { \"type\": \"\", \"fixed_fields\": { \"\": 1, \"Custom.X\": [1] }, \"by_severity\": { \"altisima\": {} }, \"otra\": 1 } }")
{ echo "$t8" | grep 'work_items.type' >/dev/null && echo "$t8" | grep 'work_items.fixed_fields' >/dev/null && echo "$t8" | grep 'work_items.by_severity.altisima' >/dev/null && echo "$t8" | grep 'work_items.otra' >/dev/null; } \
  && ok "T8 Config_WorkItemsRechazaLoMalFormado: tipo vacío, campo vacío, valor raro, gravedad desconocida y clave desconocida" \
  || no "T8: $t8"
t9=$(valida "$base, \"work_items\": { \"type\": \"X\", \"fixed_fields\": { \"Custom.ApiToken\": \"abc\" } } }")
echo "$t9" | grep -i 'secreto' >/dev/null && ok "T9 Config_WorkItemsConFormaDeSecreto: un campo con forma de secreto se rechaza" || no "T9: $t9"
[ "$(valida "$base }")" = "[]" ] && ok "T10 Config_SinWorkItems_ComoAntes" || no "T10: $(valida "$base }")"

# ── T11 (AC 7). el pedido lleva el tipo, los campos fijos y los de la gravedad ──────────────────────────────────
# ── T12 (AC 7). el valor de la gravedad pisa al campo fijo ─────────────────────────────────────────────────────
mundo
opsw "$(node -e 'const r = JSON.parse(process.argv[1]); r.by_severity.high["Custom.Prob"] = 2; console.log(JSON.stringify(r));' "$RIESGO")"
campos "Proy A" Riesgo "$BASICOS,Custom.Cat*,Custom.Prob*,Custom.Imp*,Custom.Prio"
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && llamada crear 0 'arg("--type") === "Riesgo" && a.includes("Custom.Cat=Seguridad-de-prueba") && a.includes("Custom.Imp=4") && a.includes("Custom.Prio=medio") && a.some((x) => /^System\.Tags=.*arnes:abc12345/.test(x)) && a.some((x) => x.startsWith("System.AssignedTo="))'; } \
  && ok "T11 Crear_TipoCamposFijosYDeGravedad: tipo, fijos y de la gravedad, con las etiquetas y la asignación de siempre" \
  || no "T11: rc=$rc · $(pie)"
{ [ "$rc" -eq 0 ] && llamada crear 0 'a.includes("Custom.Prob=2") && !a.includes("Custom.Prob=3")'; } \
  && ok "T12 Crear_LaGravedadPisaAlFijo" \
  || no "T12: rc=$rc · $(pie)"

# ── T13 (AC 8). el tipo configurado que no existe en un proyecto cae al de fábrica y no frena ───────────────────
# ── T14 (AC 8). el resumen nocturno dice qué proyecto cayó al de fábrica ───────────────────────────────────────
mundo; opsw "$RIESGO"
campos "Proy A" Riesgo "$BASICOS,Custom.Cat*,Custom.Prob*,Custom.Imp*,Custom.Prio"
cats ProyB "User Story"; campos ProyB "User Story" "$BASICOS"
ficha pending abc12345 browserslist high 1 "A/A,B/B"
snapshot $HOY "[$(p1 abc12345 browserslist A/A B/B)]"
rc=$(correr --operations "$TMP/operations.json")
tipos=$(node -e 'const ls = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.startsWith("crear\t")).map((l) => JSON.parse(l.split("\t")[1]).args);
console.log(ls.map((a) => `${a[a.indexOf("--project") + 1]}=${a[a.indexOf("--type") + 1]}`).sort().join(";"));' "$TMP/fixaz/llamadas.log" 2>/dev/null)
{ [ "$rc" -eq 0 ] && [ "$tipos" = "Proy A=Riesgo;ProyB=User Story" ] \
  && ped 'p.tipo_de_fabrica.length === 1 && p.tipo_de_fabrica[0].proyecto === "ProyB" && p.tipo_de_fabrica[0].tipo === "User Story" && /Riesgo/.test(p.tipo_de_fabrica[0].motivo)' \
  && ! llamada crear 1 'a.some((x) => x.startsWith("Custom."))'; } \
  && ok "T13 Crear_TipoInexistente_CaeAFabrica: Riesgo en Proy A, User Story en ProyB sin los campos de Riesgo" \
  || no "T13: rc=$rc tipos=$tipos · $(pie)"
t14=$(node -e 'const ds = require(process.argv[1]); const snap = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const r = ds.rubrosDependencias({ snap, fichas: null, cfg: {}, hoy: snap.fecha }); const v = r.proyectos_con_tipo_de_fabrica; console.log(JSON.stringify(v && v.valor));' "$AQUI/scripts/nightly/dependencies/daily-summary.js" "$TMP/out/dependencias-$HOY.json" 2>&1)
{ echo "$t14" | grep '"ProyB"' >/dev/null && grep -q 'ProyB' "$TMP/o.txt"; } \
  && ok "T14 Resumen_DiceQueProyectoCayoAFabrica: el rubro del resumen y la salida de la noche lo nombran" \
  || no "T14: $t14 · $(pie)"

# ── T15 (AC 9). un campo obligatorio del tipo que la configuración no cubre deja el par en fallidos ─────────────
mundo; opsw "$RIESGO"
campos "Proy A" Riesgo "$BASICOS,Custom.Cat*,Custom.Prob*,Custom.Imp*,Custom.Prio,Custom.Faltante*"
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] && ped 'p.fallidos.some((x) => x.paso === "campos" && x.proyecto === "Proy A" && /Custom\.Faltante/.test(x.motivo))'; } \
  && ok "T15 Crear_CampoObligatorioSinCubrir_NoCrea: no hay pedido a medias, y el fallo nombra el campo" \
  || no "T15: rc=$rc crear=$(cuenta crear) · $(pie)"

# ── T15b (AC 9). un obligatorio con valor por defecto (medido: Priority y ValueArea del PBI) no frena ─────────────
mundo; opsw ""
cats "Proy A" "Product Backlog Item"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ count: 3, value: [{ referenceName: "System.Title", alwaysRequired: true },
  { referenceName: "Microsoft.VSTS.Common.Priority", alwaysRequired: true, defaultValue: "2" }, { referenceName: "Microsoft.VSTS.Common.ValueArea", alwaysRequired: true, defaultValue: "Business" }] }));' "$TMP/fixaz/campos-Proy A-Product Backlog Item.json"
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] && ped 'p.fallidos.length === 0'; } \
  && ok "T15b Crear_ObligatorioConValorPorDefecto_NoFrena: Azure pone el valor; no hace falta configurarlo" \
  || no "T15b: rc=$rc crear=$(cuenta crear) · $(pie)"

# ── el pase adversarial y el revisor de seguridad: lo que la configuración NO puede hacer ───────────────────────
# Los campos van como argumentos de `az boards work-item create`: un nombre que empieza con «--» sería una opción, un
# valor con «@» al principio haría que az lea un archivo, y un campo que el pedido ya fija (etiquetas, asignación,
# título) pisaría la identidad del pedido. Un comentario de la configuración («__nota») nunca viaja.
t33=$(valida "$base, \"work_items\": { \"type\": \"X\", \"fixed_fields\": { \"--project\": \"otro\", \"Custom.A\": \"@archivo-local\", \"Custom.B\": \"dos\\nlineas\", \"System.Tags\": \"x\", \"System.AssignedTo\": \"alguien\", \"System.Title\": \"t\", \"Microsoft.VSTS.TCM.ReproSteps\": \"r\", \"Custom.campo-con-guiones\": \"ok\" } } }")
{ for k in -- Custom.A Custom.B System.Tags System.AssignedTo System.Title Microsoft.VSTS.TCM.ReproSteps; do echo "$t33" | grep "work_items.fixed_fields.$k" >/dev/null || { echo "falta $k"; exit 1; }; done; ! echo "$t33" | grep 'Custom.campo-con-guiones' >/dev/null; } \
  && ok "T33 Config_WorkItemsCamposConFormaValida: rechaza opciones, archivos, saltos de línea y los campos que el pedido ya fija" \
  || no "T33: $t33"
mundo
opsw '{ "type": "Riesgo", "fixed_fields": { "__nota": "explica", "Custom.Cat": "x" }, "by_severity": { "high": { "__por_que": "otra", "Custom.Imp": 4 } } }'
campos "Proy A" Riesgo "$BASICOS,Custom.Cat*,Custom.Imp*"
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] && llamada crear 0 '!a.some((x) => x.startsWith("__")) && a.includes("Custom.Cat=x") && a.includes("Custom.Imp=4")'; } \
  && ok "T34 Crear_ComentariosDeLaConfiguracionNoViajan" \
  || no "T34: rc=$rc · $(pie)"
mundo
opsw '{ "type": "Riesgo", "fixed_fields": { "Custom.Cat": "x", "Custom.QueNoExiste": "y" } }'
campos "Proy A" Riesgo "$BASICOS,Custom.Cat*"
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] && ped 'p.fallidos.some((x) => x.paso === "campos" && /Custom\.QueNoExiste/.test(x.motivo))'; } \
  && ok "T35 Crear_CampoQueElTipoNoTiene_NoCrea: Azure lo rechazaría; se dice antes, con el nombre" \
  || no "T35: rc=$rc crear=$(cuenta crear) · $(pie)"
mundo; opsw ""
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ count: 1, value: [{ referenceName: "Microsoft.RequirementCategory", defaultWorkItemType: null }] }));' "$TMP/fixaz/categorias-Proy A.json"
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] && ped 'p.fallidos.some((x) => x.paso === "tipo" && /backlog legible/.test(x.motivo))'; } \
  && ok "T6b Fabrica_CategoriaSinTipoPorDefecto_NoCrea" \
  || no "T6b: rc=$rc crear=$(cuenta crear) · $(pie)"
mundo; opsw "$RIESGO"
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(TYCON_AZ_FAIL=campos correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] && [ "$(cuenta categorias)" -eq 0 ] && ped 'p.fallidos.some((x) => x.paso === "tipo" && /no pude leer los campos/.test(x.motivo))'; } \
  && ok "T13b Crear_CamposIlegibles_NoCaeAFabrica: una falla de lectura no es «el tipo no existe»" \
  || no "T13b: rc=$rc crear=$(cuenta crear) categorias=$(cuenta categorias) · $(pie)"

# el nombre del tipo también va a la línea de comandos y a la ruta de la API: sólo letras, números, espacios, «.», «-», «_»
t36=""
for ty in '--project' '@archivo' 'a/../b' 'Tipo?x=1' 'dos\nlineas'; do
  r=$(valida "$base, \"work_items\": { \"type\": \"$ty\" } }"); echo "$r" | grep 'work_items.type' >/dev/null || t36="$t36 [$ty]"
done
for ty in 'Riesgo' 'Product Backlog Item' 'Pedido de Mejora' 'Tipo_1.2-b'; do
  r=$(valida "$base, \"work_items\": { \"type\": \"$ty\" } }"); [ "$r" = "[]" ] || t36="$t36 rechazó [$ty]: $r"
done
[ -z "$t36" ] && ok "T36 Config_WorkItemsTipoConFormaValida: el tipo no puede ser una opción, un archivo ni una ruta" || no "T36:$t36"

# ── T30 (AC 23). el núcleo no trae valores de una organización ──────────────────────────────────────────────────
t30=$(node -e 'const fs = require("fs"); const sin = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"\x27`])\/\/.*$/gm, "$1");
const malos = [];
for (const f of process.argv.slice(1)) { const c = sin(fs.readFileSync(f, "utf8")); for (const w of ["Riesgo", "Seguridad", "Custom.", "Probabilidad", "Impacto"]) if (c.includes(w)) malos.push(`${f.split("/").pop()}: ${w}`); }
console.log(malos.join(", "));' "$PED" "$AQUI/scripts/lib/operations-config.js")
[ -z "$t30" ] && ok "T30 Constitucion_NucleoSinValoresDeUnaOrganizacion: ni tipo, ni categoría, ni campos de una organización en el código" || no "T30: $t30"

echo
total=$((pasaron + fallos))
[ "$fallos" -eq 0 ] && { echo "✅ pedidos-tipo: $pasaron/$total"; exit 0; } \
  || { echo "❌ pedidos-tipo: $fallos fallo(s) de $total"; exit 1; }
