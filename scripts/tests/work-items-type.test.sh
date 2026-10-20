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

echo
total=$((pasaron + fallos))
[ "$fallos" -eq 0 ] && { echo "✅ pedidos-tipo: $pasaron/$total"; exit 0; } \
  || { echo "❌ pedidos-tipo: $fallos fallo(s) de $total"; exit 1; }
