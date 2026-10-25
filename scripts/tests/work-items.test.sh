#!/usr/bin/env bash
# Prueba de work-items.js — el pedido de trabajo del líder.
#
# La pieza crea Bugs en los proyectos de Azure DevOps de los CLIENTES, asignados a quien administra
# cada proyecto. Por eso esta suite no toca la red NUNCA: habla con un `az` de mentira
# (scripts/tests/lib/fake-az.sh) que contesta desde fixtures, recuerda lo que "creó" como lo haría
# Azure, y anota cada llamada con los archivos que recibió.
#
# Los casos giran alrededor de las confusiones que convertirían la pieza en un problema:
#   · «no pude preguntar» leído como «no existe» → un Bug duplicado en el tablero de un cliente;
#   · la ruta /{proyecto}/ de la WIQL que NO acota (medido: 183 contra 0) → el pedido de otro
#     proyecto leído como duplicado, y el segundo nunca se crea;
#   · un dueño elegido al azar, o un pedido sin mención que el responsable de respaldo no ve;
#   · el texto en un campo que el formulario del Bug no muestra (medido: Descripción no aparece);
#   · un defecto que sólo se ve en la SEGUNDA noche (una suite de una sola noche no lo ve).
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PED="$AQUI/scripts/nightly/dependencies/work-items.js"
NOC="$AQUI/scripts/nightly/dependencies/nightly-dependencies.js"
NOTICE="$AQUI/scripts/hooks/dependencies-notice.js"
# el modelo público del pipeline: lo que copia cada organización a su repo de operaciones
YAML="$AQUI/pipelines/operations/dependency-audit.yml"
# el YAML del pipeline puede pasar la fecha con el nombre nuevo o con el viejo (el alias lo sigue aceptando
# hasta el retiro). El chequeo acepta los dos; el viejo sale del mapa de renombres, nunca escrito en la prueba.
nombres(){ # <kind> <nuevo> <where>... → «nuevo|viejo…» (sólo «nuevo» sin mapa)
  node -e 'const [k, n, f, ...w] = process.argv.slice(1); let v = [];
    try { v = JSON.parse(require("fs").readFileSync(f, "utf8")).entries.filter((e) => e.kind === k && e.new === n && w.includes(e.where)).map((e) => e.old); } catch (_) { v = []; }
    console.log([...new Set([n, ...v])].join("|"));' "$1" "$2" "$AQUI/scripts/lib/renames.json" "${@:3}"
}
HOY_OPC="--($(nombres option today scripts/nightly/dependencies/work-items.js scripts/nightly/dependencies/nightly-dependencies.js scripts/nightly/dependencies/daily-summary.js))"
DOBLE="$AQUI/scripts/tests/lib/fake-az.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ pedidos: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ pedidos: $1"; fallos=$((fallos+1)); }

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
// el valor de un campo de `--fields` (Campo=valor); uno mandado por archivo devuelve «@<archivo>»
const campo = (k) => { const x = a.find((v) => typeof v === "string" && v.startsWith(`${k}=`)); return x === undefined ? undefined : x.slice(k.length + 1); };
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

# ── T1. una ficha viva pide en SU proyecto, con el nombre decodificado ────────────────────────────
mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] \
  && llamada crear 0 'arg("--project") === "Proy A" && arg("--type") === "Bug"' \
  && grep -qx 'pedidos:' "$TMP/pend/pending/abc12345.yaml" \
  && grep -qx '  - Proy A: 101' "$TMP/pend/pending/abc12345.yaml"; } \
  && ok "T1: una ficha viva pide en su proyecto («Proy%20A» sale «Proy A») y la ficha guarda el id" \
  || no "T1: rc=$rc creates=$(cuenta crear) · $(pie)"

# ── T1b. 🔴 un repo que ya no está en repos.json no inventa un proyecto de Azure ───────────────────
# `proyectoDe` cae en el `producto` cuando la etiqueta no está en la config,
# y el producto NO es el proyecto (Acme → «Acme Web», Globex → GlobexCore). Saldría un par a un proyecto
# inexistente que fallaría todas las noches, ocuparía cupo como reintento y protegería la ficha de
# `ignorado` para siempre. Un repo sin proyecto conocido no pide: se dice en `sin_pedido`.
mundo
ficha pending abc12345 browserslist high 1 "A/A,Z/Z"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] && llamada crear 0 'arg("--project") === "Proy A"' \
  && ped 'p.sin_pedido.some((x) => x.ficha === "abc12345" && /fuera de repos\.json/.test(x.motivo) && x.motivo.includes("Z/Z"))' \
  && ped 'p.fallidos.length === 0'; } \
  && ok "T1b: 🔴 un repo fuera de repos.json no genera un pedido a un proyecto inventado, y se dice por qué no pide" \
  || no "T1b: rc=$rc creates=$(cuenta crear) · $(pie)"

# T23c (el mismo criterio en el nocturno): con la llave encendida, una ficha cuyos únicos repos están
# fuera de la config no queda protegida de `ignorado` para siempre — nunca va a poder tener pedido.
t23c=$(node -e '
const fs = require("fs"), path = require("path"), noc = require(process.argv[1]);
const dir = fs.mkdtempSync(path.join(process.argv[2], "t23c-")); fs.mkdirSync(path.join(dir, "pending"));
fs.writeFileSync(path.join(dir, "pending", "zzz99999.yaml"), "id: zzz99999\ndetectado: 2026-09-01\nveredicto: pendiente\npaquete: x\nseveridad: high\nnoches: 9\nids:\n  - zzz99999\nrepos:\n  - Z/Z\n");
const cfg = { azure: { pedidos_activos: true }, repos: [{ producto: "A", ruta: "A", ado: "Proy%20A/A" }] };
console.log(noc.archivarIgnorados(dir, "2026-09-10", cfg).join(","));' "$NOC" "$TMP" 2>&1)
[ "$t23c" = "zzz99999" ] && ok "T23c: una ficha con repos sólo fuera de la config se ignora a los 7 días como cualquier otra (no puede tener pedido)" \
  || no "T23c: archivarIgnorados devolvió «${t23c}»"

# ── T2. una ficha en DOS proyectos son dos pedidos, uno por proyecto ──────────────────────────────
mundo
ficha pending abc12345 browserslist high 1 "A/A,B/B"
snapshot $HOY "[$(p1 abc12345 browserslist A/A B/B)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 2 ] \
  && grep -Eq '^  - Proy A: 10[12]$' "$TMP/pend/pending/abc12345.yaml" \
  && grep -Eq '^  - ProyB: 10[12]$' "$TMP/pend/pending/abc12345.yaml"; } \
  && ok "T2: una ficha en dos proyectos crea dos pedidos y guarda los dos ids" \
  || no "T2: rc=$rc creates=$(cuenta crear) · $(grep -A3 '^pedidos:' "$TMP/pend/pending/abc12345.yaml" | tr '\n' ' ')"

# ── T3. se extiende a otro proyecto: pide sólo ahí · lo que sólo está declarado no pide ────────────
mundo
ficha pending xxx11111 browserslist high 2 "A/A,B/B" "pedidos:" "  - Proy A: 55"
ficha pending yyy22222 handlebars high 2 "A/A" "pedidos:" "  - Proy A: 56" "declarada_en:" "  - C/C (vence 2026-12-31)"
snapshot $HOY "[$(p1 xxx11111 browserslist A/A B/B),$(p1 yyy22222 handlebars A/A C/C@2026-12-31)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] \
  && llamada crear 0 'arg("--project") === "ProyB"' \
  && grep -qx '  - Proy A: 55' "$TMP/pend/pending/xxx11111.yaml" \
  && grep -qx '  - ProyB: 101' "$TMP/pend/pending/xxx11111.yaml"; } \
  && ok "T3: el hallazgo que se extiende pide sólo en el proyecto nuevo, y un proyecto que sólo declaró no recibe pedido" \
  || no "T3: rc=$rc creates=$(cuenta crear) · $(pie)"

# ── T4. si Azure ya tiene el pedido (por la etiqueta), se ADOPTA ──────────────────────────────────
mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
echo '{ "workItems": [ { "id": 777 } ] }' > "$TMP/fixaz/wiql-Proy A.json"
echo '{ "id": 777, "fields": { "System.Tags": "arnes-hallazgo; arnes:abc12345" } }' > "$TMP/fixaz/wi-777.json"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] \
  && grep -qx '  - Proy A: 777' "$TMP/pend/pending/abc12345.yaml" \
  && ped 'p.adoptados.length === 1 && p.adoptados[0].id === 777 && p.adoptados[0].proyecto === "Proy A"'; } \
  && ok "T4: el pedido que Azure ya tiene por la etiqueta se adopta y no se crea otro" \
  || no "T4: rc=$rc creates=$(cuenta crear) · $(pie)"

# ── T4b. 🔴 el pedido ADOPTADO recibe la mención al responsable de respaldo ───────────────────────────────────────────
# Si `crear` falla de forma ambigua (timeout, respuesta cortada) pero Azure
# sí lo creó, la noche siguiente se adopta — y una adopción sin comentario dejaría un Bug asignado sin la
# mención al responsable de respaldo («el responsable de respaldo va SIEMPRE») y sin rastro. Adoptar, encendido, comenta; simulado, no.
mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
echo '{ "workItems": [ { "id": 777 } ] }' > "$TMP/fixaz/wiql-Proy A.json"
echo '{ "id": 777, "fields": { "System.Tags": "arnes-hallazgo; arnes:abc12345" } }' > "$TMP/fixaz/wi-777.json"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta comentario)" -eq 1 ] \
  && llamada comentario 0 'arg("--id") === "777" && b.includes(`data-vss-mention="version:2.0,${process.env.BACKUP_OWNER_ID}"`) && /ya existía/.test(b)'; } \
  && ok "T4b: 🔴 un pedido adoptado recibe el comentario con la mención al responsable de respaldo y el porqué de la adopción" \
  || no "T4b: rc=$rc comentarios=$(cuenta comentario) · $(pie)"

# ── T5. la etiqueta se compara como TOKEN exacto, no como prefijo ─────────────────────────────────
mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
echo '{ "workItems": [ { "id": 778 } ] }' > "$TMP/fixaz/wiql-Proy A.json"
echo '{ "id": 778, "fields": { "System.Tags": "arnes-hallazgo; arnes:abc123459" } }' > "$TMP/fixaz/wi-778.json"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] && ped 'p.adoptados.length === 0'; } \
  && ok "T5: «arnes:abc123459» no es «arnes:abc12345»: no se adopta, se crea" \
  || no "T5: rc=$rc creates=$(cuenta crear) · $(pie)"

# ── T5b. 🔴 la WIQL acota por proyecto: la ruta /{proyecto}/ sola NO acota ────────────────────────
# El `az` de mentira rechaza toda WIQL sin `[System.TeamProject] = @project` (medido:
# 183 work items sin la cláusula, 0 con ella). Sin la cláusula, el pedido de Proy A se leería como
# duplicado del de ProyB y la segunda mitad de la ficha nunca tendría su pedido.
mundo
ficha pending abc12345 browserslist high 2 "A/A,B/B" "pedidos:" "  - Proy A: 777"
snapshot $HOY "[$(p1 abc12345 browserslist A/A B/B)]"
echo '{ "id": 777, "fields": { "System.Tags": "arnes-hallazgo; arnes:abc12345" } }' > "$TMP/fixaz/wi-777.json"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] && llamada crear 0 'arg("--project") === "ProyB"' \
  && llamada wiql 0 '/\[System\.TeamProject\]\s*=\s*@project/.test(b) && /arnes:abc12345/.test(b)'; } \
  && ok "T5b: 🔴 la consulta de duplicados acota por proyecto y la segunda mitad de la ficha tiene su pedido" \
  || no "T5b: rc=$rc creates=$(cuenta crear) · $(pie)"

# ── T6. duplicados, o una consulta que no se pudo hacer, NO crean nada ────────────────────────────
mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
echo '{ "workItems": [ { "id": 781 }, { "id": 782 } ] }' > "$TMP/fixaz/wiql-Proy A.json"
echo '{ "id": 781, "fields": { "System.Tags": "arnes:abc12345; arnes-hallazgo" } }' > "$TMP/fixaz/wi-781.json"
echo '{ "id": 782, "fields": { "System.Tags": "arnes-hallazgo;arnes:abc12345" } }' > "$TMP/fixaz/wi-782.json"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] && ! grep -q '^pedidos:' "$TMP/pend/pending/abc12345.yaml" \
  && ped 'p.fallidos.length === 1 && p.fallidos[0].paso === "duplicados" && /duplicados en Azure/.test(p.fallidos[0].motivo) && /781/.test(p.fallidos[0].motivo) && /782/.test(p.fallidos[0].motivo)'; } \
  && ok "T6a: dos pedidos con la misma etiqueta: no se crea ni se adopta, lo decide una persona" \
  || no "T6a: rc=$rc creates=$(cuenta crear) · $(pie)"

for modo in FALLA BASURA; do
  mundo
  ficha pending abc12345 browserslist high 1 "A/A"
  snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
  if [ "$modo" = FALLA ]; then rc=$(TYCON_AZ_FAIL=wiql correr); else rc=$(TYCON_AZ_GARBAGE=wiql correr); fi
  { [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] \
    && ped 'p.fallidos.length === 1 && p.fallidos[0].paso === "duplicados" && /no pude consultar duplicados/.test(p.fallidos[0].motivo)' \
    && ped 'p.sin_pedido.some((x) => x.ficha === "abc12345")'; } \
    && ok "T6 ($modo): 🔴 una consulta de duplicados que $( [ $modo = FALLA ] && echo 'sale ≠0' || echo 'no devuelve JSON') NO se lee como «no hay»: no se crea nada" \
    || no "T6 ($modo): rc=$rc creates=$(cuenta crear) · $(pie)"
done

# ── T6e. 🔴 dos fichas vivas del MISMO paquete en el MISMO proyecto no abren dos Bugs ──────────────
# El pedido se identifica por ficha, y el nocturno puede dejar dos
# fichas vivas del mismo paquete en un mismo proyecto (dos huellas la misma noche, o una ficha que se
# extiende a otro proyecto). Saldrían dos Bugs para el mismo hecho — «nunca dos veces» roto. La segunda
# no crea: queda como fallo `duplicados` que nombra a la otra ficha, y lo decide una persona.
for variante in "misma-noche" "ya-tenia-pedido"; do
  mundo
  if [ "$variante" = "ya-tenia-pedido" ]; then
    ficha pending aaa11111 js-yaml high 3 "A/A" "pedidos:" "  - Proy A: 55"
  else
    ficha pending aaa11111 js-yaml high 3 "A/A"
  fi
  ficha pending bbb22222 JS-YAML critical 1 "A/A"
  snapshot $HOY "[$(p1 aaa11111 js-yaml A/A),$(p1 bbb22222 js-yaml A/A)]"
  rc=$(correr)
  esperado=1; [ "$variante" = "ya-tenia-pedido" ] && esperado=0
  # Cuál de las dos gana la misma noche lo decide el orden (una crítica va primero);
  # lo que se exige es que haya UN Bug y que la otra quede frenada nombrando a la que lo tiene.
  if [ "$variante" = "ya-tenia-pedido" ]; then perdedora=bbb22222; ganadora=aaa11111; else perdedora=aaa11111; ganadora=bbb22222; fi
  { [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq "$esperado" ] && ! grep -q '^pedidos:' "$TMP/pend/pending/$perdedora.yaml" \
    && ped "p.fallidos.some((f) => f.ficha === \"$perdedora\" && f.paso === \"duplicados\" && /otra ficha viva del mismo paquete/.test(f.motivo) && f.motivo.includes(\"$ganadora\"))"; } \
    && ok "T6e ($variante): 🔴 la segunda ficha del mismo paquete en el mismo proyecto no abre otro Bug: fallo que nombra a la primera" \
    || no "T6e ($variante): rc=$rc creates=$(cuenta crear) · $(pie)"
done

# ── T6f. 🔴 una adopción que no se pudo ANOTAR igual cuenta como el pedido de ese paquete ───────────
# Si `anotarPedido` falla al adoptar, el `continue`
# saltearía el registro del paquete, y la segunda ficha del mismo paquete crearía otro Bug esa noche.
mundo
ficha pending aaa11111 browserslist high 5 "A/A"
ficha pending bbb22222 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 aaa11111 browserslist A/A),$(p1 bbb22222 browserslist A/A)]"
echo '{ "workItems": [ { "id": 777 } ] }' > "$TMP/fixaz/wiql-Proy A.json"
echo '{ "id": 777, "fields": { "System.Tags": "arnes-hallazgo; arnes:aaa11111" } }' > "$TMP/fixaz/wi-777.json"
chmod 0444 "$TMP/pend/pending/aaa11111.yaml"
rc=$(correr)
chmod 0644 "$TMP/pend/pending/aaa11111.yaml"
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] \
  && ped 'p.fallidos.some((f) => f.ficha === "aaa11111" && f.paso === "escribir-ficha") && p.fallidos.some((f) => f.ficha === "bbb22222" && f.paso === "duplicados" && f.motivo.includes("777"))'; } \
  && ok "T6f: 🔴 una adopción que no se pudo anotar en la ficha igual impide el segundo Bug del mismo paquete" \
  || no "T6f: rc=$rc creates=$(cuenta crear) · $(pie)"

# ── T6g. el aviso de duplicado nombra SIEMPRE la misma ficha, lleguen como lleguen ────────────────
# Con dos fichas que ya tienen pedido para el mismo paquete (un estado que el
# arnés puede traer de una noche anterior), la ficha nombrada dependería del orden del disco.
orden6g=$(node -e '
const ped = require(process.argv[1]), noc = require(process.argv[2]), fs = require("fs"), path = require("path");
const dir = fs.mkdtempSync(path.join(process.argv[3], "t6g-")); fs.mkdirSync(path.join(dir, "pending"));
const ficha = (id, ped) => fs.writeFileSync(path.join(dir, "pending", id + ".yaml"),
  `id: ${id}\ndetectado: 2026-09-08\nveredicto: pendiente\npaquete: foo\nseveridad: high\nnoches: 1\n${ped ? `pedidos:\n  - Proy A: ${ped}\n` : ""}ids:\n  - ${id}\nrepos:\n  - A/A\n`);
ficha("bbb22222", 222); ficha("aaa11111", 111); ficha("ccc33333", null);
const cfg = { azure: { fallback_owner: "respaldo@prueba" }, repos: [{ producto: "A", ruta: "A", ado: "Proy%20A/A" }] };
const az = (a) => (a[0] === "devops" && a[1] === "invoke" ? { ok: true, valor: { value: [{ id: "x", providerDisplayName: "Respaldo" }] } } : { ok: false, motivo: "no" });
const plataforma = async () => ({ ok: false, reason: "no_medido", detail: "no" });
const correr = async (fichas) => (await ped.hablar({ az, plataforma, cfg, azure: cfg.azure, hoy: "2026-09-10", simulado: true, tope: 5,
  snap: { repos: [], presencias: [] }, out: "/nada", tmp: dir, fichas })).res.fallidos.map((f) => f.motivo).join("|");
(async () => {
  const f = noc.leerTodasLasFichas(dir); const a = await correr(f), b = await correr([...f].reverse());
  console.log(a === b && a.includes("aaa11111") ? "igual" : `distinto: ${a} ≠ ${b}`);
})();' "$PED" "$NOC" "$TMP" 2>&1)
[ "$orden6g" = "igual" ] && ok "T6g: el fallo de duplicado nombra la misma ficha (la de menor id) sin importar el orden del disco" \
  || no "T6g: $orden6g"

# ── T6d. no poder ver las etiquetas de un resultado tampoco es «no es el nuestro» ─────────────────
mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
echo '{ "workItems": [ { "id": 783 } ] }' > "$TMP/fixaz/wiql-Proy A.json"      # sin wi-783.json: show sale 1
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] \
  && ped 'p.fallidos.length === 1 && /no pude consultar duplicados/.test(p.fallidos[0].motivo)'; } \
  && ok "T6d: si no se pueden leer las etiquetas de un resultado, no se crea" \
  || no "T6d: rc=$rc creates=$(cuenta crear) · $(pie)"

# ── T7. dos corridas seguidas con el mismo estado: la segunda no crea nada ────────────────────────
mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
correr >/dev/null
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] \
  && ped 'p.creados.length === 0 && p.adoptados.length === 0 && p.existentes === 1'; } \
  && ok "T7: la segunda ejecución no crea ni adopta nada y cuenta el pedido como existente" \
  || no "T7: rc=$rc creates=$(cuenta crear) · $(pie)"

# ── T8. el dueño deducido: el único administrador además del responsable de respaldo · grupo leído UNA vez ───────────
mundo; config true respaldo@prueba https://dev.azure.com/prueba 3
# Tres paquetes DISTINTOS en el mismo proyecto: tres fichas del mismo paquete ahí serían el duplicado
# que T6e frena, no tres pedidos.
ficha pending aaa11111 browserslist high 1 "A/A"; ficha pending bbb22222 handlebars high 1 "A/A"; ficha pending ccc33333 lodash high 1 "A/A"
snapshot $HOY "[$(p1 aaa11111 browserslist A/A),$(p1 bbb22222 handlebars A/A),$(p1 ccc33333 lodash A/A)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 3 ] && [ "$(cuenta grupo)" -eq 1 ] && [ "$(cuenta miembros)" -eq 1 ] \
  && llamada crear 0 'a.includes("System.AssignedTo=dana@prueba") && !a.includes("--assigned-to")' \
  && llamada crear 2 'a.includes("System.AssignedTo=dana@prueba")' \
  && ped 'p.creados.every((c) => c.asignado_a === "dana@prueba" && c.motivo_dueno === "único administrador además del responsable de respaldo")'; } \
  && ok "T8: se asigna al único administrador además del responsable de respaldo, y el grupo se lee una vez para tres fichas del mismo proyecto" \
  || no "T8: rc=$rc creates=$(cuenta crear) grupo=$(cuenta grupo) miembros=$(cuenta miembros) · $(pie)"

# ── T9. sin dueño único: cae en el responsable de respaldo y SE DICE ───────────────────────────────────────────────────
mundo
echo '{ "aad.res": { "subjectKind": "user", "displayName": "Respaldo Prueba", "principalName": "respaldo@prueba", "mailAddress": "respaldo@prueba" } }' > "$TMP/fixaz/miembros.json"
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada crear 0 'a.includes("System.AssignedTo=respaldo@prueba")' \
  && llamada comentario 0 'b.includes("sin dueño deducible")' \
  && ped 'p.sin_dueno_unico.length === 1 && /ningún administrador del proyecto además del responsable de respaldo/.test(p.sin_dueno_unico[0].motivo)'; } \
  && ok "T9a: sin otro administrador que el responsable de respaldo, se le asigna a él y el comentario lo dice" \
  || no "T9a: rc=$rc · $(pie)"

mundo
cat > "$TMP/fixaz/miembros.json" <<'J'
{ "aad.1": { "subjectKind": "user", "displayName": "Uno Prueba",  "principalName": "uno@prueba",  "mailAddress": "uno@prueba" },
  "aad.2": { "subjectKind": "user", "displayName": "Dos Prueba",  "principalName": "dos@prueba",  "mailAddress": "dos@prueba" },
  "aad.3": { "subjectKind": "user", "displayName": "Tres Prueba", "principalName": "tres@prueba", "mailAddress": "tres@prueba" },
  "aad.a": { "subjectKind": "user", "displayName": "Respaldo Prueba", "principalName": "respaldo@prueba", "mailAddress": "respaldo@prueba" } }
J
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada crear 0 'a.includes("System.AssignedTo=respaldo@prueba")' \
  && llamada comentario 0 'b.includes("Uno Prueba") && b.includes("Dos Prueba") && b.includes("Tres Prueba")' \
  && ped '/^3 administradores además del responsable de respaldo: /.test(p.sin_dueno_unico[0].motivo)'; } \
  && ok "T9b: con tres candidatos no se elige al primero: va al responsable de respaldo, con los tres nombres" \
  || no "T9b: rc=$rc · $(pie)"

mundo
cat > "$TMP/fixaz/miembros.json" <<'J'
{ "aad.f": { "subjectKind": "user",  "displayName": "Dana Prueba", "principalName": "dana@prueba", "mailAddress": "dana@prueba" },
  "vssgp.x": { "subjectKind": "group", "displayName": "[Org]\\Project Collection Administrators", "principalName": "[Org]\\Project Collection Administrators" },
  "aad.a": { "subjectKind": "user",  "displayName": "Respaldo Prueba", "principalName": "respaldo@prueba", "mailAddress": "respaldo@prueba" } }
J
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada crear 0 'a.includes("System.AssignedTo=dana@prueba")' && ped 'p.sin_dueno_unico.length === 0'; } \
  && ok "T9c: un grupo dentro de los administradores no es una persona y no le quita el dueño a Dana" \
  || no "T9c: rc=$rc · $(pie)"

# ── T9d. un administrador que Azure devuelve SIN cuenta no puede ser el dueño ─────────────────────
# Sin principalName ni mail, la cuenta quedaría `undefined` y viajaría
# literal `System.AssignedTo=undefined`, con «Asignado a undefined» en el comentario. No hay a quién
# asignar: es «no pude leer los administradores» — al responsable de respaldo, dicho, y como fallo.
mundo
cat > "$TMP/fixaz/miembros.json" <<'J'
{ "aad.x": { "subjectKind": "user", "displayName": "Sin Cuenta" },
  "aad.a": { "subjectKind": "user", "displayName": "Respaldo Prueba", "principalName": "respaldo@prueba", "mailAddress": "respaldo@prueba" } }
J
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada crear 0 'a.includes("System.AssignedTo=respaldo@prueba") && !JSON.stringify(a).includes("undefined")' \
  && llamada comentario 0 '!b.includes("undefined")' \
  && ped 'p.fallidos.some((f) => f.paso === "administradores" && /Sin Cuenta/.test(f.motivo)) && p.creados[0].asignado_a === "respaldo@prueba"'; } \
  && ok "T9d: un administrador sin cuenta no se asigna: va al responsable de respaldo, con el motivo y como fallo de lectura" \
  || no "T9d: rc=$rc · $(pie)"

# ── T9e. los textos que van al snapshot no dependen del orden en que responde Azure ──────────────
# Los nombres de «N administradores además del responsable de respaldo» y los ids de «pedidos
# duplicados en Azure» saldrían en el orden de la respuesta; el snapshot se commitea cada noche.
mundo
cat > "$TMP/fixaz/miembros.json" <<'J'
{ "aad.3": { "subjectKind": "user", "displayName": "Tres Prueba", "principalName": "tres@prueba", "mailAddress": "tres@prueba" },
  "aad.1": { "subjectKind": "user", "displayName": "Uno Prueba",  "principalName": "uno@prueba",  "mailAddress": "uno@prueba" },
  "aad.2": { "subjectKind": "user", "displayName": "Dos Prueba",  "principalName": "dos@prueba",  "mailAddress": "dos@prueba" } }
J
ficha pending abc12345 browserslist high 1 "A/A"
ficha pending def67890 handlebars high 1 "B/B"
snapshot $HOY "[$(p1 abc12345 browserslist A/A),$(p1 def67890 handlebars B/B)]"
echo '{ "workItems": [ { "id": 792 }, { "id": 781 } ] }' > "$TMP/fixaz/wiql-ProyB.json"
echo '{ "id": 792, "fields": { "System.Tags": "arnes:def67890" } }' > "$TMP/fixaz/wi-792.json"
echo '{ "id": 781, "fields": { "System.Tags": "arnes:def67890" } }' > "$TMP/fixaz/wi-781.json"
rc=$(correr)
{ [ "$rc" -eq 0 ] \
  && ped 'p.sin_dueno_unico[0].motivo === "3 administradores además del responsable de respaldo: Dos Prueba, Tres Prueba, Uno Prueba"' \
  && ped 'p.fallidos.some((f) => f.paso === "duplicados" && f.motivo.includes("781, 792"))'; } \
  && ok "T9e: los nombres de los candidatos y los ids duplicados salen ordenados, respondan como respondan" \
  || no "T9e: rc=$rc · $(pie)"

# ── T10. no poder leer los administradores, o no tener al responsable de respaldo ────────────────────────────────────
for paso in grupo miembros; do
  mundo
  ficha pending abc12345 browserslist high 1 "A/A"
  snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
  rc=$(TYCON_AZ_FAIL=$paso correr)
  { [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] && llamada crear 0 'a.includes("System.AssignedTo=respaldo@prueba")' \
    && llamada comentario 0 'b.includes("no pude leer los administradores")' \
    && ped '/no pude leer los administradores/.test(p.sin_dueno_unico[0].motivo) && p.creados.length === 1' \
    && ped 'p.fallidos.length === 1 && p.fallidos[0].paso === "administradores" && /no pude leer los administradores/.test(p.fallidos[0].motivo)'; } \
    && ok "T10a ($paso): sin poder leer los administradores el pedido se crea igual, al responsable de respaldo, se dice por qué y 🔴 queda como fallo (es el permiso que nadie verificó)" \
    || no "T10a ($paso): rc=$rc creates=$(cuenta crear) · $(pie)"
done

mundo; config true ""
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] && [ "$(cuenta identidad)" -eq 0 ] \
  && ped 'p.fallidos.length === 1 && p.fallidos[0].paso === "lead-identity"'; } \
  && ok "T10b: sin la identidad del responsable de respaldo configurada no se crea NINGÚN pedido, y queda el fallo" \
  || no "T10b: rc=$rc creates=$(cuenta crear) · $(pie)"

mundo; rm -f "$TMP/fixaz/identidades-${BACKUP_OWNER_MAIL}.json"
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] && ped 'p.fallidos[0].paso === "lead-identity"'; } \
  && ok "T10c: si la API de identidades no resuelve al responsable de respaldo, no se crea ningún pedido" \
  || no "T10c: rc=$rc creates=$(cuenta crear) · $(pie)"

mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(TYCON_AZ_GARBAGE=identidad correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] && ped 'p.fallidos[0].paso === "lead-identity"'; } \
  && ok "T10d: una respuesta ilegible de la API de identidades tampoco deja crear" \
  || no "T10d: rc=$rc creates=$(cuenta crear) · $(pie)"

# ── T10e. WorkItems_Owner_FromOperationsJson: quién responde sale de operations.json ───────────────
# El responsable de respaldo es `owners.default` de operations.json (se excluye al deducir, se lo menciona, recibe lo que no tiene dueño único) y
# `owners.by_project.<proyecto>` asigna directo en ese proyecto, sin leer sus administradores. Sin operations.json,
# `azure.fallback_owner` de repos.json. Un operations.json que está y no valida no cae en repos.json: no se adivina.
ops(){ printf '%s' "$1" > "$TMP/operations.json"; }
mundo; config true ""
ops '{ "version": 1, "owners": { "default": "respaldo@prueba", "by_project": { "ProyB": "lider-b@prueba" } } }'
ficha pending abc12345 browserslist high 1 "A/A"
ficha pending def67890 handlebars high 1 "B/B"
snapshot $HOY "[$(p1 abc12345 browserslist A/A),$(p1 def67890 handlebars B/B)]"
rc=$(correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 2 ] && [ "$(cuenta grupo)" -eq 1 ] && [ "$(cuenta identidad)" -eq 1 ] \
  && ped 'p.creados.some((c) => c.proyecto === "Proy A" && c.asignado_a === "dana@prueba" && c.motivo_dueno === "único administrador además del responsable de respaldo")' \
  && ped 'p.creados.some((c) => c.proyecto === "ProyB" && c.asignado_a === "lider-b@prueba" && c.motivo_dueno === "declarado en operations.json")' \
  && ped 'p.fallidos.length === 0' \
  && llamada comentario 0 'b.includes(`data-vss-mention="version:2.0,${process.env.BACKUP_OWNER_ID}"`)' \
  && llamada comentario 1 'b.includes(`data-vss-mention="version:2.0,${process.env.BACKUP_OWNER_ID}"`)'; } \
  && ok "WorkItems_Owner_FromOperationsJson (default y by_project): el declarado del proyecto recibe su pedido sin leer administradores, el otro se deduce sin contar a owners.default, y los dos mencionan al respaldo" \
  || no "WorkItems_Owner_FromOperationsJson (default y by_project): rc=$rc creates=$(cuenta crear) grupo=$(cuenta grupo) · $(pie)"

mundo; config true respaldo@prueba
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
if [ -f "$AQUI/operations.json" ]; then
  no "WorkItems_Owner_FromOperationsJson (sin operations.json): la raíz del repo trae operations.json y el caso no se puede medir acá"
else
  rc=$(correr)
  { [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] && llamada crear 0 'a.includes("System.AssignedTo=dana@prueba")' \
    && llamada comentario 0 'b.includes(`data-vss-mention="version:2.0,${process.env.BACKUP_OWNER_ID}"`)'; } \
    && ok "WorkItems_Owner_FromOperationsJson (sin operations.json): el responsable de respaldo sale de azure.fallback_owner de repos.json" \
    || no "WorkItems_Owner_FromOperationsJson (sin operations.json): rc=$rc creates=$(cuenta crear) · $(pie)"
fi

for variante in invalido ausente; do
  mundo                                   # repos.json SÍ trae fallback_owner: no tiene que usarse
  ficha pending abc12345 browserslist high 1 "A/A"
  snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
  if [ "$variante" = invalido ]; then ops '{ "version": 2, "owners": { "default": "respaldo@prueba" } }'; else rm -f "$TMP/operations.json"; fi
  rc=$(correr --operations "$TMP/operations.json")
  { [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] && [ "$(cuenta identidad)" -eq 0 ] \
    && ped 'p.fallidos.length === 1 && p.fallidos[0].paso === "lead-identity" && /operations\.json no sirve/.test(p.fallidos[0].motivo) && /no se adivina/.test(p.fallidos[0].motivo)'; } \
    && ok "WorkItems_Owner_FromOperationsJson ($variante): 🔴 un operations.json que no sirve no cae en repos.json: ningún pedido, y el motivo se dice" \
    || no "WorkItems_Owner_FromOperationsJson ($variante): rc=$rc creates=$(cuenta crear) identidad=$(cuenta identidad) · $(pie)"
done
rm -f "$TMP/operations.json"

# ── T54b. Pedido_MotivoDeResponsables_Fijo: el motivo no copia lo que dice el lector de operations.json ─────────
# El motivo va a la foto de la noche y a su salida: el problema del lector trae valores del archivo (correos,
# identidades), así que el motivo es fijo, como el de nochesParaResolver.
mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
ops '{ "version": 1, "owners": { "default": "zzsecreto sin forma" } }'
rc=$(correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] && ! grep -q zzsecreto "$TMP/o.txt" "$TMP/out/"*.json \
  && ped 'p.fallidos.length === 1 && /operations\.json no sirve/.test(p.fallidos[0].motivo) && !/zzsecreto|owners/.test(p.fallidos[0].motivo)'; } \
  && ok "T54b Pedido_MotivoDeResponsables_Fijo: el motivo de un operations.json que no sirve no copia el archivo" \
  || no "T54b Pedido_MotivoDeResponsables_Fijo: rc=$rc creates=$(cuenta crear) · $(pie)"
rm -f "$TMP/operations.json"

# ── T11. la iteración: la actual si está vigente; si terminó, la raíz, y se dice ──────────────────
iter(){ # <etiqueta> <json de iteraciones> <expresión sobre la llamada crear> <expresión sobre p>
  mundo
  ficha pending abc12345 browserslist high 1 "A/A"
  snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
  [ -n "$2" ] && printf '%s' "$2" > "$TMP/fixaz/iteracion-Proy A.json"
  rc=$(correr)
  { [ "$rc" -eq 0 ] && llamada crear 0 "$3" && ped "$4" && llamada iteracion 0 'arg("--team") === "Proy A Team"'; } \
    && ok "T11 ($1)" || no "T11 ($1): rc=$rc · $(pie)"
}
iter "fin futuro → esa iteración" '[{"path":"Proy A\\Sprint 3","attributes":{"startDate":"2026-09-01T00:00:00Z","finishDate":"2099-01-01T00:00:00Z"}}]' \
  'campo("System.IterationPath") === "Proy A\\Sprint 3"' 'p.sin_iteracion.length === 0 && p.creados[0].iteracion === "Proy A\\Sprint 3"'
iter "sin fechas → esa iteración" '[{"path":"Proy A\\Iteration 1","attributes":{}}]' \
  'campo("System.IterationPath") === "Proy A\\Iteration 1"' 'p.sin_iteracion.length === 0'
iter "termina HOY → todavía vigente" '[{"path":"Proy A\\Sprint 4","attributes":{"finishDate":"2026-09-10T00:00:00Z"}}]' \
  'campo("System.IterationPath") === "Proy A\\Sprint 4"' 'p.sin_iteracion.length === 0'
iter "🔴 terminada → la raíz, y se dice cuándo terminó" '[{"path":"Proy A\\Sprint 9","attributes":{"finishDate":"2026-07-31T00:00:00Z"}}]' \
  'campo("System.IterationPath") === "Proy A"' 'p.sin_iteracion.length === 1 && /terminó el 2026-07-31/.test(p.sin_iteracion[0].motivo) && p.sin_iteracion[0].motivo.includes("Sprint 9")'
iter "ninguna actual → la raíz" '' \
  'campo("System.IterationPath") === "Proy A"' 'p.sin_iteracion.length === 1 && /sin iteración actual/.test(p.sin_iteracion[0].motivo)'

# ── T12. la iteración NUNCA frena el pedido ───────────────────────────────────────────────────────
for paso in iteracion equipo; do
  mundo
  ficha pending abc12345 browserslist high 1 "A/A"
  snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
  rc=$(TYCON_AZ_FAIL=$paso correr)
  { [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] && llamada crear 0 'campo("System.IterationPath") === "Proy A"' \
    && ped '/no pude leer la iteración/.test(p.sin_iteracion[0].motivo) && p.creados.length === 1' \
    && ped 'p.fallidos.length === 1 && p.fallidos[0].paso === "iteracion"'; } \
    && ok "T12 ($paso): si no se puede leer la iteración, el Bug se crea igual en la raíz, y la lectura fallida queda como fallo" \
    || no "T12 ($paso): rc=$rc creates=$(cuenta crear) · $(pie)"
done

# ── T13. el contenido: los repos de ESE proyecto, los avisos, las noches, y la mención ───────────
mundo
ficha pending abc12345 browserslist high 4 "A/A,B/B"
snapshot $HOY "[$(p1 abc12345 browserslist A/A B/B)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] \
  && llamada crear 0 'arg("--title") === "Dependencia vulnerable: browserslist (high) en A/A"' \
  && llamada crear 0 'b.includes("A/A") && !b.includes("B/B") && b.includes("GHSA-73wf-abc12345") && /4 noche/.test(b) && b.includes("vulnerabilidades-pendientes.json")' \
  && llamada crear 0 'a.some((x) => /^System\.Tags=arnes-hallazgo; ?arnes:abc12345; arnes-gravedad:high$/.test(x))' \
  && llamada crear 1 'b.includes("B/B") && !b.includes("A/A")' \
  && llamada comentario 0 'b.includes(`data-vss-mention="version:2.0,${process.env.BACKUP_OWNER_ID}"`) && b.includes("@Respaldo Prueba")'; } \
  && ok "T13: el Bug lleva los repos de su proyecto (no los del otro), avisos, noches, la deuda, las etiquetas y la mención" \
  || no "T13: rc=$rc · $(pie)"

# ── T13b. 🔴 el texto va a Repro Steps, en HTML, por archivo, y en UN solo --fields ───────────────
# El formulario del Bug no muestra Descripción. Y `--fields` repetido pierde
# el primero (argparse se queda con el último): las etiquetas y el texto van en el MISMO --fields.
{ llamada crear 0 'a.indexOf("--fields") === a.lastIndexOf("--fields")' \
  && llamada crear 0 'a.some((x) => x.startsWith("Microsoft.VSTS.TCM.ReproSteps=@")) && String(campo("System.Description")).startsWith("@")' \
  && llamada crear 0 '/<li>/.test(b) && /<a href=/.test(b) && !b.includes("**")'; } \
  && ok "T13b: 🔴 el texto viaja por archivo a Repro Steps (visible en el formulario) y a Descripción, como HTML" \
  || no "T13b: el create no manda el texto a Repro Steps como HTML por archivo"

# ── T13c. un hallazgo sin enlace de aviso no deja el título «Avisos» vacío en el Bug ─────────────
# El llamador tiene que filtrar el marcador «(el informe no trajo enlace)»
# que el pull request sí muestra: sin filtrarlo, el Bug queda con un título sin lista debajo.
mundo
ficha pending abc12345 browserslist high 1 "A/A"
sed -i.bak 's#^  - https://github.com/advisories/GHSA-73wf-abc12345$#  - (el informe no trajo enlace)#' "$TMP/pend/pending/abc12345.yaml"; rm -f "$TMP/pend/pending/abc12345.yaml.bak"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada crear 0 '/<li>\(el informe no trajo enlace\)<\/li>/.test(b) && /"advisories": \[\]/.test(b.replace(/&quot;/g, "\""))'; } \
  && ok "T13c: sin enlace de aviso, el Bug dice «(el informe no trajo enlace)» como el pull request, y la deuda de ejemplo no inventa avisos" \
  || no "T13c: rc=$rc · el cuerpo no trae el marcador bajo «Avisos»"

# ── T13d. 🔴 la severidad del hallazgo llega al campo Severity del Bug ───────────────────────────
# Sin el campo Severity, un Bug de severidad crítica sale «3 - Medium»,
# el valor por defecto de Azure — en el tablero, una crítica se ve como cualquier otra cosa.
# Los 8 proyectos medidos aceptan los mismos cuatro valores. Una severidad que no está en la
# tabla NO se inventa: el campo no se manda y Azure pone su valor por defecto.
mundo
ficha pending aaa11111 vitest critical 1 "A/A"
ficha pending bbb22222 sharp high 1 "B/B"
ficha pending ccc33333 raro rarisima 1 "C/C"
snapshot $HOY "[$(p1 aaa11111 vitest A/A),$(p1 bbb22222 sharp B/B),$(p1 ccc33333 raro C/C)]"
rc=$(correr)
sev(){ # <título que contiene> <valor esperado | NINGUNO>
  node -e '
const [log, contiene, esperado] = process.argv.slice(1);
const x = require("fs").readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("crear\t"))
  .map((l) => JSON.parse(l.slice(l.indexOf("\t") + 1))).find((c) => { const i = c.args.lastIndexOf("--title"); return i >= 0 && c.args[i + 1].includes(contiene); });
if (!x) process.exit(1);
const s = x.args.filter((a) => a.startsWith("Microsoft.VSTS.Common.Severity="));
const ok = esperado === "NINGUNO" ? s.length === 0 : (s.length === 1 && s[0] === `Microsoft.VSTS.Common.Severity=${esperado}` && x.args.indexOf("--fields") === x.args.lastIndexOf("--fields"));
process.exit(ok ? 0 : 1);' "$TMP/fixaz/llamadas.log" "$1" "$2"
}
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 3 ] \
  && sev "vitest (critical)" "1 - Critical" && sev "sharp (high)" "2 - High" && sev "raro (rarisima)" NINGUNO; } \
  && ok "T13d: 🔴 critical → «1 - Critical», high → «2 - High» (en el mismo --fields), y una severidad desconocida no se inventa" \
  || no "T13d: rc=$rc · crear=$(cuenta crear) · el Bug no lleva la severidad del hallazgo"

# ── T14. el Bug se creó y el comentario falló: el id se guarda IGUAL ──────────────────────────────
mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(TYCON_AZ_FAIL=comentario correr)
primero=$(grep -c '^  - Proy A: 101$' "$TMP/pend/pending/abc12345.yaml")
paso_ok=0; ped 'p.fallidos.length === 1 && p.fallidos[0].paso === "comentario"' && paso_ok=1
correr >/dev/null
{ [ "$rc" -eq 0 ] && [ "$primero" -eq 1 ] && [ "$paso_ok" -eq 1 ] && [ "$(cuenta crear)" -eq 1 ]; } \
  && ok "T14: con el comentario fallido el id queda en la ficha, y la noche siguiente no crea otro" \
  || no "T14: rc=$rc id=$primero paso=$paso_ok creates=$(cuenta crear) · $(pie)"

# ── T15. un fallo en un par no tumba la corrida ───────────────────────────────────────────────────
mundo
ficha pending abc12345 browserslist high 1 "A/A"
ficha pending def67890 handlebars high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A),$(p1 def67890 handlebars A/A)]"
rc=$(TYCON_AZ_FAIL=crear:arnes:abc12345 correr)
{ [ "$rc" -eq 0 ] && ! grep -q '^pedidos:' "$TMP/pend/pending/abc12345.yaml" \
  && grep -Eq '^  - Proy A: [0-9]+$' "$TMP/pend/pending/def67890.yaml" \
  && ped 'p.fallidos.length === 1 && p.fallidos[0].ficha === "abc12345" && p.fallidos[0].paso === "crear" && p.creados.length === 1'; } \
  && ok "T15: el create que falla para una ficha no impide crear el de la otra, y la ejecución sale 0" \
  || no "T15: rc=$rc · $(pie)"

# ── T15b. 🔴 «sigue sin pedido» explica cada ficha con SU fallo, no con el primero que encuentra ────
# Una lectura de administradores fallida también entra en `fallidos`: sin cuidado, el motivo de `sin_pedido` tomaría el
# PRIMER fallo de la ficha sin mirar proyecto ni paso — y diría «falló administradores» sobre el
# proyecto donde el que falló fue `crear`. Es la lista que el resumen muestra como fallo.
mundo
ficha pending abc12345 browserslist high 1 "A/A,B/B"
snapshot $HOY "[$(p1 abc12345 browserslist A/A B/B)]"
rc=$(TYCON_AZ_FAIL='miembros,crear:"ProyB"' correr)
{ [ "$rc" -eq 0 ] && grep -Eq '^  - Proy A: [0-9]+$' "$TMP/pend/pending/abc12345.yaml" \
  && ped 'p.sin_pedido.length === 1 && p.sin_pedido[0].proyectos.join() === "ProyB" && /falló crear/.test(p.sin_pedido[0].motivo) && !/administradores/.test(p.sin_pedido[0].motivo)'; } \
  && ok "T15b: 🔴 el motivo de «sigue sin pedido» es el fallo de ese proyecto que impidió el pedido, no el primero de la ficha" \
  || no "T15b: rc=$rc · $(node -e 'try{console.log(JSON.stringify(require(process.argv[1]).pedidos.sin_pedido))}catch(e){console.log(e.message)}' "$TMP/out/dependencias-$HOY.json")"

# ── T15c. 🔴 dos proyectos sin pedido por razones distintas: una razón por proyecto ────────────────
# Con dos proyectos trabados, `sin_pedido` diría sólo la razón del
# primero — el que mira por qué ProyB no tiene Bug leería el problema de Proy A.
mundo
ficha pending lod12345 lodash high 1 "A/A,B/B"
snapshot $HOY "[$(p1 lod12345 lodash A/A B/B)]"
rc=$(TYCON_AZ_FAIL='wiql:"project=Proy A",crear:"ProyB"' correr)
{ [ "$rc" -eq 0 ] \
  && ped 'const e = p.sin_pedido.find((x) => x.ficha === "lod12345"); e && /Proy A: falló duplicados/.test(e.motivo) && /ProyB: falló crear/.test(e.motivo)'; } \
  && ok "T15c: 🔴 con dos proyectos trabados, «sigue sin pedido» da la razón de cada uno" \
  || no "T15c: rc=$rc · $(node -e 'try{console.log(JSON.stringify(require(process.argv[1]).pedidos.sin_pedido))}catch(e){console.log(e.message)}' "$TMP/out/dependencias-$HOY.json")"

# ── T1c. una ficha con sólo repos fuera de la config no dice «sin pedido en  desde hace N días» ────
mundo
DETECTADO=2026-08-01 ficha pending zzz99999 x high 9 "Z/Z"
snapshot $HOY "[]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && ped 'const e = p.sin_pedido.find((x) => x.ficha === "zzz99999"); e && /fuera de repos\.json/.test(e.motivo) && !/sin pedido en\s+desde/.test(e.motivo)'; } \
  && ok "T1c: una ficha sólo con repos fuera de la config explica eso, sin un «sin pedido en  desde hace» vacío" \
  || no "T1c: rc=$rc · $(node -e 'try{console.log(JSON.stringify(require(process.argv[1]).pedidos.sin_pedido))}catch(e){console.log(e.message)}' "$TMP/out/dependencias-$HOY.json")"

# ── T16. 🔴 sin poder intentar nada sale 2, y NO publica una sección vacía ────────────────────────
mundo
ficha pending abc12345 browserslist high 1 "A/A"
rc=$(correr)
{ [ "$rc" -eq 2 ] && [ ! -f "$TMP/out/dependencias-$HOY.json" ]; } \
  && ok "T16a: sin el snapshot de hoy sale 2 (no hay qué pedir ≠ no se sabe)" || no "T16a: rc=$rc · $(pie)"

sin_clave(){ node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit("pedidos" in s?1:0)' "$TMP/out/dependencias-$HOY.json"; }
mundo; ficha pending abc12345 browserslist high 1 "A/A"; snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(AZ_CMD="$TMP/no-existe-az" correr)
{ [ "$rc" -eq 2 ] && sin_clave; } && ok "T16b: sin \`az\` ejecutable sale 2 y no escribe «pedidos»" || no "T16b: rc=$rc · $(pie)"

mundo; config true respaldo@prueba ""; ficha pending abc12345 browserslist high 1 "A/A"; snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(correr)
{ [ "$rc" -eq 2 ] && sin_clave && [ "$(cuenta crear)" -eq 0 ]; } && ok "T16c: sin \`azure.org\` sale 2" || no "T16c: rc=$rc · $(pie)"

mundo; ficha pending abc12345 browserslist high 1 "A/A"; snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(PAT="" correr)
{ [ "$rc" -eq 2 ] && sin_clave && [ "$(cuenta crear)" -eq 0 ]; } && ok "T16d: sin token (AZURE_DEVOPS_EXT_PAT vacío) sale 2" || no "T16d: rc=$rc · $(pie)"

mundo; ficha pending abc12345 browserslist high 1 "A/A"; echo '{ esto no' > "$TMP/out/dependencias-$HOY.json"
rc=$(correr)
[ "$rc" -eq 2 ] && ok "T16e: un snapshot ilegible sale 2" || no "T16e: rc=$rc · $(pie)"

# ── T17. el tope cuenta FICHAS, con los reintentos primero, y lo postergado entra mañana ──────────
mundo
ficha pending aaa11111 browserslist high 5 "A/A,B/B"
ficha pending bbb22222 handlebars high 1 "A/A"
DETECTADO=2026-09-01 ficha pending ccc33333 lodash high 4 "A/A"
ficha pending ddd44444 minimist high 2 "A/A"
PRES="[$(p1 aaa11111 browserslist A/A B/B),$(p1 bbb22222 handlebars A/A),$(p1 ccc33333 lodash A/A),$(p1 ddd44444 minimist A/A)]"
snapshot 2026-09-09 "$PRES"
node -e 'const f=process.argv[1];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));s.pedidos={fallidos:[{ficha:"bbb22222",proyecto:"Proy A",paso:"crear",motivo:"fabricado"}]};require("fs").writeFileSync(f,JSON.stringify(s))' "$TMP/out/dependencias-2026-09-09.json"
snapshot $HOY "$PRES"
rc=$(correr)
hoy_ok=0
ped 'p.creados.length === 3 && p.creados.some((c) => c.ficha === "bbb22222") && p.creados.filter((c) => c.ficha === "aaa11111").length === 2 && p.postergados.map((x) => x.ficha).join() === "ccc33333,ddd44444" && p.fichas_sin_pedido === 4 && p.fichas_vivas === 4 && p.tope === 2' && hoy_ok=1
antiguedad=0; ped 'p.sin_pedido.some((x) => x.ficha === "ccc33333" && /sin pedido en Proy A desde hace 9 días/.test(x.motivo))' && antiguedad=1
snapshot 2026-09-11 "$PRES"
rc2=$(HOYC=2026-09-11 correr)
{ [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$hoy_ok" -eq 1 ] && [ "$antiguedad" -eq 1 ] && [ "$(cuenta crear)" -eq 5 ] \
  && ped 'p.postergados.length === 0 && p.creados.map((c) => c.ficha).sort().join() === "ccc33333,ddd44444"' 2026-09-11; } \
  && ok "T17: el tope cuenta fichas (3 pedidos, 2 cupos), el reintento entra primero y lo postergado entra mañana" \
  || no "T17: rc=$rc/$rc2 hoy=$hoy_ok antigüedad=$antiguedad creates=$(cuenta crear) · $(pie)"

# ── T17b. 🔴 un snapshot de anoche ilegible NO se reemplaza en silencio por uno más viejo ─────────
# La búsqueda de los reintentos saltearía el snapshot
# corrupto sin decir nada y tomaría los fallos de una noche anterior — datos viejos priorizando fichas
# que quizá ya no fallan. Por eso esa noche no se priorizan reintentos, y se dice.
mundo; config true respaldo@prueba https://dev.azure.com/prueba 1
ficha pending aaa11111 browserslist high 5 "A/A"
ficha pending bbb22222 handlebars high 1 "A/A"
PRES="[$(p1 aaa11111 browserslist A/A),$(p1 bbb22222 handlebars A/A)]"
snapshot 2026-09-08 "$PRES"
node -e 'const f=process.argv[1];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));s.pedidos={fallidos:[{ficha:"bbb22222",proyecto:"Proy A",paso:"crear",motivo:"de hace dos noches"}]};require("fs").writeFileSync(f,JSON.stringify(s))' "$TMP/out/dependencias-2026-09-08.json"
echo '{ roto' > "$TMP/out/dependencias-2026-09-09.json"
snapshot $HOY "$PRES"
rc=$(correr)
{ [ "$rc" -eq 0 ] && ped 'p.creados.length === 1 && p.creados[0].ficha === "aaa11111"' && grep -q 'ilegible' "$TMP/o.txt"; } \
  && ok "T17b: 🔴 con el snapshot de anoche ilegible no se usan los reintentos de una noche más vieja, y la salida lo dice" \
  || no "T17b: rc=$rc · $(pie)"

# ── T17c. un fallo que NO impidió el pedido no es un «reintento» ──────────────────────────────────
# Una ficha de 1 noche cuyo grupo de administradores no se pudo leer le
# ganaría el cupo, todas las noches, a una de 5 noches. Reintento = el par quedó SIN pedido.
mundo; config true respaldo@prueba https://dev.azure.com/prueba 1
ficha pending aaa11111 browserslist high 5 "A/A"
ficha pending bbb22222 handlebars high 1 "A/A"
PRES="[$(p1 aaa11111 browserslist A/A),$(p1 bbb22222 handlebars A/A)]"
snapshot 2026-09-09 "$PRES"
node -e 'const f=process.argv[1];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));s.pedidos={fallidos:[{ficha:"bbb22222",proyecto:"Proy A",paso:"administradores",motivo:"no pude leer"},{ficha:"bbb22222",proyecto:"Proy A",paso:"comentario",motivo:"no pude comentar"}]};require("fs").writeFileSync(f,JSON.stringify(s))' "$TMP/out/dependencias-2026-09-09.json"
snapshot $HOY "$PRES"
rc=$(correr)
{ [ "$rc" -eq 0 ] && ped 'p.creados.length === 1 && p.creados[0].ficha === "aaa11111"'; } \
  && ok "T17c: un fallo de anoche que no impidió el pedido (administradores, comentario) no le quita el turno a la ficha más vieja" \
  || no "T17c: rc=$rc · $(pie)"

# ── T17g. el paso de identidad con su nombre viejo sigue dando prioridad de reintento ─────────────────
# El paso se llama `lead-identity`; los snapshots de noches anteriores lo traen
# como `identidad-` más un nombre de persona. Un fallo de anoche con la forma vieja sigue siendo un reintento.
mundo; config true respaldo@prueba https://dev.azure.com/prueba 1
ficha pending aaa11111 browserslist high 5 "A/A"
ficha pending bbb22222 handlebars high 1 "A/A"
PRES="[$(p1 aaa11111 browserslist A/A),$(p1 bbb22222 handlebars A/A)]"
snapshot 2026-09-09 "$PRES"
node -e 'const f=process.argv[1];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));s.pedidos={fallidos:[{ficha:"bbb22222",proyecto:"Proy A",paso:"identidad-zorblax",motivo:"fabricado con la forma vieja"}]};require("fs").writeFileSync(f,JSON.stringify(s))' "$TMP/out/dependencias-2026-09-09.json"
snapshot $HOY "$PRES"
rc=$(correr)
{ [ "$rc" -eq 0 ] && ped 'p.creados.length === 1 && p.creados[0].ficha === "bbb22222"'; } \
  && ok "T17g: un fallo de anoche en el paso de identidad con su nombre viejo sigue entrando primero" \
  || no "T17g: rc=$rc · $(pie)"

# ── T17e. 🔴 un fallo que se repite no acapara el cupo para siempre ─────────────────────────────────
# Una falla permanente en un proyecto (sin permiso de crear, duplicados que
# nadie resuelve) volvería «reintento» a sus fichas todas las noches, y una ficha sana de otro proyecto,
# más vieja y más grave, quedaría postergada sin fin con la promesa «entra primero mañana». La prioridad
# de reintento es para un fallo de UNA noche: la que falló dos noches seguidas compite por antigüedad.
mundo; config true respaldo@prueba https://dev.azure.com/prueba 1
ficha pending bbb22222 handlebars high 1 "B/B"
ficha pending ccc33333 lodash high 5 "C/C"
PRES="[$(p1 bbb22222 handlebars B/B),$(p1 ccc33333 lodash C/C)]"
for noche in 2026-09-08 2026-09-09; do
  snapshot $noche "$PRES"
  node -e 'const f=process.argv[1];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));s.pedidos={fallidos:[{ficha:"bbb22222",proyecto:"ProyB",paso:"crear",motivo:"sin permiso"}]};require("fs").writeFileSync(f,JSON.stringify(s))' "$TMP/out/dependencias-$noche.json"
done
snapshot $HOY "$PRES"
rc=$(correr)
{ [ "$rc" -eq 0 ] && ped 'p.creados.length === 1 && p.creados[0].ficha === "ccc33333"'; } \
  && ok "T17e: 🔴 una ficha que falló dos noches seguidas pierde la prioridad y no posterga sin fin a una más vieja de otro proyecto" \
  || no "T17e: rc=$rc · $(pie)"

# ── T17f. 🔴 una crítica no espera turno: no consume el tope y pide la misma noche ────────────────
# Con el orden «más noches primero», una crítica recién aparecida quedaría
# detrás de altas viejas y su Bug podría tardar varias noches. Tope 1, dos críticas de 1 noche y dos altas
# de 5 y 4 → entran las dos críticas y la alta de 5; la de 4 queda postergada.
mundo; config true respaldo@prueba https://dev.azure.com/prueba 1
ficha pending aaa11111 browserslist high 5 "A/A"
ficha pending bbb22222 handlebars high 4 "A/A"
ficha pending ccc33333 lodash critical 1 "A/A"
ficha pending ddd44444 minimist critical 1 "B/B"
snapshot $HOY "[$(p1 aaa11111 browserslist A/A),$(p1 bbb22222 handlebars A/A),$(p1 ccc33333 lodash A/A),$(p1 ddd44444 minimist B/B)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] \
  && ped 'p.creados.map((c) => c.ficha).sort().join() === "aaa11111,ccc33333,ddd44444" && p.postergados.map((x) => x.ficha).join() === "bbb22222" && p.tope === 1'; } \
  && ok "T17f: 🔴 las críticas no consumen el tope: con tope 1 piden las dos críticas y la alta más vieja, y la otra alta queda para mañana" \
  || no "T17f: rc=$rc · $(pie)"

# ── T17d. 🔴 un snapshot de anoche legible pero con `fallidos` de forma rara no tumba la noche ─────
# `{"fallidos":{}}` o `[null]` tirarían TypeError sin catch → exit 1, cero
# pedidos y el snapshot de hoy sin sección — el mismo daño que el snapshot ilegible, que se cubre aparte.
for forma in '{}' '[null, "x", 3]'; do
  mundo; config true respaldo@prueba https://dev.azure.com/prueba 1
  ficha pending aaa11111 browserslist high 5 "A/A"
  snapshot 2026-09-09 "[$(p1 aaa11111 browserslist A/A)]"
  node -e 'const [f,forma]=process.argv.slice(1);const s=JSON.parse(require("fs").readFileSync(f,"utf8"));s.pedidos={fallidos:JSON.parse(forma)};require("fs").writeFileSync(f,JSON.stringify(s))' "$TMP/out/dependencias-2026-09-09.json" "$forma"
  snapshot $HOY "[$(p1 aaa11111 browserslist A/A)]"
  rc=$(correr)
  { [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] && ped 'Array.isArray(p.creados)'; } \
    && ok "T17d ($forma): 🔴 unos fallos de anoche con forma inesperada no tumban la ejecución" \
    || no "T17d ($forma): rc=$rc · $(pie)"
done

# ── T18. «en tu proyecto ya no aparece»: se CIERRA el Bug, una vez, y sólo con todo medido ───────
# Si el arreglo ya está en main, el Bug se da por arreglado: cuándo subirlo a prod es del equipo.
# Se cierra al estado de categoría Completed que el proyecto declara (no a un nombre fijo: Agile es
# Closed, Scrum es Done), sin mandar motivo — medido con validateOnly: Azure pone «Fixed and
# verified»/«Verified» (Agile) y «Work finished» (Scrum), los tres en `motivos_arreglado`.
estados(){ # <proyecto> <estado de cierre> → fixture de categorías del Bug de ese proyecto
  node -e '
const [p, cierre, dir] = process.argv.slice(1);
const v = cierre === "Done"
  ? [["New","Proposed"],["Approved","Proposed"],["Committed","InProgress"],["Done","Completed"],["Removed","Removed"]]
  : [["New","Proposed"],["Active","InProgress"],["Resolved","Resolved"],["Closed","Completed"]];
require("fs").writeFileSync(`${dir}/estados-${p}.json`, JSON.stringify({ count: v.length, value: v.map(([name, category]) => ({ name, category })) }));' "$1" "$2" "$TMP/fixaz"
}
wi(){ # <id> <estado> <proyecto> [tipo=Bug] [creador=svc.build] [etiquetas="arnes-hallazgo; arnes:abc12345"] [cambio de estado=2026-09-01T04:00:00Z] → fixture del work item
  node -e '
const [id, estado, proyecto, tipo, creador, tags, cambio, dir] = process.argv.slice(1);
require("fs").writeFileSync(`${dir}/wi-${id}.json`, JSON.stringify({ id: Number(id), fields: { "System.State": estado,
  "System.TeamProject": proyecto, "System.WorkItemType": tipo, "System.Tags": tags, "Microsoft.VSTS.Common.StateChangeDate": cambio,
  "System.AssignedTo": { id: "dan00000-0000-0000-0000-00000000f3e1", displayName: "Dana Prueba", uniqueName: "dana@prueba" },
  "System.CreatedBy": { displayName: creador.startsWith("svc.") ? "Project Collection Build Service (prueba)" : "Una Persona", descriptor: creador } } }));' \
    "$1" "$2" "$3" "${4:-Bug}" "${5:-svc.build}" "${6:-arnes-hallazgo; arnes:abc12345}" "${7:-2026-09-01T04:00:00Z}" "$TMP/fixaz"
}
mundo
ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
estados "Proy A" Closed; wi 301 New "Proy A"
snapshot $HOY "[$(p1 abc12345 browserslist B/B)]"
rc=$(correr)
marca=$(grep -c '^  - Proy A (2026-09-10, cerrado por el arnés)$' "$TMP/pend/pending/abc12345.yaml")
aviso_ok=0; llamada actualizar 0 'arg("--id") === "301" && arg("--state") === "Closed" && !a.includes("--reason") && !a.includes("--discussion")' \
  && llamada comentario 0 'arg("--id") === "301" && b.includes("ya no aparece") && b.includes("Cierro este pedido") && b.includes("main")' \
  && llamada comentario 0 'b.includes(`data-vss-mention="version:2.0,${process.env.BACKUP_OWNER_ID}"`) && b.includes("data-vss-mention=\"version:2.0,dan00000-0000-0000-0000-00000000f3e1\"") && b.includes("@Dana Prueba")' \
  && ped 'p.pagados_avisados.length === 1 && p.pagados_avisados[0].id === 301 && p.pagados_avisados[0].cerrado === true && p.pagados_avisados[0].motivo_azure === "Fixed and verified"' && aviso_ok=1
correr >/dev/null
{ [ "$rc" -eq 0 ] && [ "$aviso_ok" -eq 1 ] && [ "$marca" -eq 1 ] && [ "$(cuenta comentario)" -eq 1 ] && [ "$(cuenta actualizar)" -eq 1 ] && [ "$(cuenta crear)" -eq 0 ]; } \
  && ok "T18: 🔴 el Bug del proyecto donde ya no aparece se CIERRA (al estado de cierre del proyecto, sin motivo) y recibe el aviso, una sola vez" \
  || no "T18: rc=$rc aviso=$aviso_ok marca=$marca comentarios=$(cuenta comentario) cierres=$(cuenta actualizar) · $(pie)"

# T18c. un Bug que una persona YA cerró (o quitó) no se toca: sólo el aviso, sin «Cierro este pedido»
mundo
ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
estados "Proy A" Closed; wi 301 Closed "Proy A"
snapshot $HOY "[$(p1 abc12345 browserslist B/B)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && llamada comentario 0 'arg("--id") === "301" && b.includes("ya no aparece") && !b.includes("Cierro este pedido")' \
  && ped 'p.pagados_avisados[0].cerrado === false' && grep -q '^  - Proy A (2026-09-10)$' "$TMP/pend/pending/abc12345.yaml"; } \
  && ok "T18c: un Bug ya cerrado por una persona no se vuelve a tocar: recibe el aviso y queda marcado" \
  || no "T18c: rc=$rc cierres=$(cuenta actualizar) comentarios=$(cuenta comentario) · $(pie)"

# T18d. 🔴 no se pudo cerrar → el aviso sale IGUAL, diciendo que no se pudo cerrar y por qué, y se marca
# (un fallo permanente —una regla del proceso, un permiso— dejaría al equipo
# sin el «ya no aparece»). El fallo se cobra en `fallidos`.
mundo
ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
wi 301 New "Proy A"
snapshot $HOY "[$(p1 abc12345 browserslist B/B)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && llamada comentario 0 'arg("--id") === "301" && b.includes("ya no aparece") && b.includes("No pude cerrarlo") && b.includes("categorías de estado") && !b.includes("Cierro este pedido")' \
  && grep -q '^  - Proy A (2026-09-10)$' "$TMP/pend/pending/abc12345.yaml" \
  && ped 'p.fallidos.some((x) => x.paso === "cerrar" && x.proyecto === "Proy A" && /categorías de estado/.test(x.motivo)) && p.pagados_avisados[0].cerrado === false'; } \
  && ok "T18d: 🔴 si no se pueden leer los estados del proyecto no se cierra, pero el aviso sale diciendo que no se pudo, se marca y el fallo se dice" \
  || no "T18d: rc=$rc cierres=$(cuenta actualizar) comentarios=$(cuenta comentario) · $(pie)"
mundo
ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
estados "Proy A" Closed; wi 301 Active "Proy A"
snapshot $HOY "[$(p1 abc12345 browserslist B/B)]"
TYCON_AZ_FAIL='actualizar:--state' rc=$(TYCON_AZ_FAIL='actualizar:--state' correr)
{ [ "$rc" -eq 0 ] && llamada comentario 0 'b.includes("No pude cerrarlo") && b.includes("cerralo vos")' && grep -q '^  - Proy A (2026-09-10)$' "$TMP/pend/pending/abc12345.yaml" \
  && ped 'p.fallidos.some((x) => x.paso === "cerrar" && /no pude cerrar el pedido 301/.test(x.motivo))'; } \
  && ok "T18d: 🔴 si Azure rechaza el cierre, el aviso dice que no se pudo cerrar, se marca (no se insiste cada noche) y el fallo se dice" \
  || no "T18d rechazo: rc=$rc comentarios=$(cuenta comentario) · $(pie)"

# T18e. Scrum cierra a Done (el estado sale de las categorías del proyecto, no de un nombre fijo)
mundo
ficha pending abc12345 browserslist high 3 "C/C" "pedidos:" "  - ProyB: 302" "  - ProyC: 303"
estados ProyB Done; wi 302 Committed ProyB
snapshot $HOY "[$(p1 abc12345 browserslist C/C)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada actualizar 0 'arg("--id") === "302" && arg("--state") === "Done"'; } \
  && ok "T18e: en un proyecto Scrum el Bug se cierra a Done" \
  || no "T18e: rc=$rc cierres=$(cuenta actualizar) · $(pie)"

# T18f. 🔴 el id de la ficha no es SU pedido (otro proyecto, sin la etiqueta del arnés, sin la de la ficha): no se toca nada
# (un id mal anotado cerraría un work item ajeno).
# El tipo no cuenta: un pedido propio de otro tipo se cierra, y lo prueba work-items-type.test.sh.
for variante in proyecto hallazgo etiqueta; do
  mundo
  ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
  estados "Proy A" Closed
  case $variante in
    proyecto) wi 301 New ProyB ;;
    hallazgo) wi 301 New "Proy A" Bug svc.build "arnes:abc12345" ;;
    etiqueta) wi 301 New "Proy A" Bug svc.build "cliente; sprint-12" ;;
  esac
  snapshot $HOY "[$(p1 abc12345 browserslist B/B)]"
  rc=$(correr)
  { [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ] && ! grep -q '^pagado_avisado:' "$TMP/pend/pending/abc12345.yaml" \
    && ped 'p.fallidos.some((x) => x.paso === "cerrar" && /no es el pedido de esta ficha/.test(x.motivo))'; } \
    && ok "T18f ($variante): 🔴 un work item que no es el pedido de la ficha en ese proyecto no se cierra ni se comenta, y el fallo se dice" \
    || no "T18f ($variante): rc=$rc cierres=$(cuenta actualizar) comentarios=$(cuenta comentario) · $(pie)"
done

# T18g. 🔴 un Bug que creó una PERSONA (p. ej. una copia del Bug del arnés en otro proyecto) no lo cierra el arnés:
# recibe el aviso de siempre, «cerralo si corresponde»
mundo
ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
estados "Proy A" Closed; wi 301 New "Proy A" Bug aad.persona
snapshot $HOY "[$(p1 abc12345 browserslist B/B)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && llamada comentario 0 'b.includes("ya no aparece") && b.includes("cerralo si corresponde") && !b.includes("Cierro este pedido")' \
  && ped 'p.pagados_avisados[0].cerrado === false'; } \
  && ok "T18g: 🔴 el arnés sólo cierra los Bugs que creó él: uno creado por una persona recibe el aviso y queda abierto" \
  || no "T18g: rc=$rc cierres=$(cuenta actualizar) · $(pie)"

# T18h. 🔴 un repo de la ficha que ya no está en repos.json no se mide: bloquea el cierre (y el aviso), como en el cruce
mundo
ficha pending abc12345 browserslist high 3 "B/B,Z/Z" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
estados "Proy A" Closed; wi 301 New "Proy A"
snapshot $HOY "[$(p1 abc12345 browserslist B/B)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ]; } \
  && ok "T18h: 🔴 un repo de la ficha fuera de repos.json no está medido: no se cierra ni se avisa «ya no aparece»" \
  || no "T18h: rc=$rc cierres=$(cuenta actualizar) comentarios=$(cuenta comentario) · $(pie)"

# T18i. un Bug que una persona dejó RESUELTO (Resolved: «As Designed», «Duplicate»…) no se toca: la decisión es de ella
mundo
ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
estados "Proy A" Closed; wi 301 Resolved "Proy A"
snapshot $HOY "[$(p1 abc12345 browserslist B/B)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && llamada comentario 0 'b.includes("ya no aparece") && !b.includes("Cierro este pedido")'; } \
  && ok "T18i: un Bug en Resolved no se cierra: una persona ya decidió" \
  || no "T18i: rc=$rc cierres=$(cuenta actualizar) · $(pie)"

# T18j. 🔴 un snapshot SIN `presencias` no dice «no aparece en ningún lado»: no se avisa ni se cierra nada
mundo
ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
estados "Proy A" Closed; wi 301 New "Proy A"; estados ProyB Closed; wi 302 New ProyB
snapshot $HOY "[$(p1 abc12345 browserslist B/B)]"
node -e 'const f = process.argv[1]; const s = JSON.parse(require("fs").readFileSync(f, "utf8")); delete s.presencias; require("fs").writeFileSync(f, JSON.stringify(s));' "$TMP/out/dependencias-$HOY.json"
rc=$(correr)
{ [ "$(cuenta actualizar)" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ]; } \
  && ok "T18j: 🔴 sin presencias en el snapshot no se cierra ni se avisa ningún Bug" \
  || no "T18j: rc=$rc cierres=$(cuenta actualizar) comentarios=$(cuenta comentario) · $(pie)"

# ── T18k. 🔴 la vulnerabilidad VUELVE a un Bug que cerró el arnés: se REABRE ──
# Si no, el tablero del equipo dice «Closed» con la vulnerabilidad viva y sólo el responsable de respaldo se entera. Sólo se reabre lo
# que cerró el arnés (la marca lo dice) y sólo si nadie le cambió el estado después (la fecha del cambio de estado
# es la de la marca). Se reabre al primer estado «Proposed» del proyecto (New): medido con validateOnly,
# Closed→New pone «Not fixed» (Agile) y Done→New «Moved to the backlog» (Scrum).
reaparece(){ # <cambio de estado del Bug> <línea de la marca>
  mundo
  ficha pending abc12345 browserslist high 3 "A/A" "pedidos:" "  - Proy A: 301" "pagado_avisado:" "  - $2"
  estados "Proy A" Closed; wi 301 Closed "Proy A" Bug svc.build "arnes-hallazgo; arnes:abc12345" "$1"
  snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
}
reaparece 2026-09-08T04:03:11Z "Proy A (2026-09-08, cerrado por el arnés)"
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada actualizar 0 'arg("--id") === "301" && arg("--state") === "New" && !a.includes("--reason")' \
  && llamada comentario 0 'arg("--id") === "301" && b.includes("Volvió a aparecer") && b.includes("Reabro este pedido") && b.includes("2026-09-08")' \
  && llamada comentario 0 'b.includes(`data-vss-mention="version:2.0,${process.env.BACKUP_OWNER_ID}"`) && b.includes("@Dana Prueba")' \
  && ! grep -q 'Proy A (2026-09-08' "$TMP/pend/pending/abc12345.yaml" \
  && ped 'JSON.stringify(p.reabiertos) === JSON.stringify([{ ficha: "abc12345", proyecto: "Proy A", id: 301 }])'; } \
  && ok "T18k: 🔴 la vulnerabilidad vuelve a un Bug que cerró el arnés: se reabre a New, se avisa y se borra la marca" \
  || no "T18k: rc=$rc reaperturas=$(cuenta actualizar) comentarios=$(cuenta comentario) · $(pie)"

# T18l. una PERSONA le cambió el estado después del cierre del arnés: no se reabre (el cruce avisa, como siempre)
reaparece 2026-09-09T15:20:00Z "Proy A (2026-09-08, cerrado por el arnés)"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ] && ! grep -q 'Proy A (2026-09-08' "$TMP/pend/pending/abc12345.yaml" \
  && ped 'p.reabiertos.length === 0'; } \
  && ok "T18l: si alguien cambió el estado después del cierre del arnés, no se reabre: la decisión es suya" \
  || no "T18l: rc=$rc reaperturas=$(cuenta actualizar) comentarios=$(cuenta comentario) · $(pie)"

# T18m. un Bug que cerró una PERSONA (marca sin «cerrado por el arnés», o una marca vieja) no se reabre
reaparece 2026-09-08T04:03:11Z "Proy A (2026-09-08)"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ]; } \
  && ok "T18m: un Bug que no cerró el arnés nunca se reabre" \
  || no "T18m: rc=$rc reaperturas=$(cuenta actualizar) · $(pie)"

# T18n. 🔴 si la reapertura falla, el aviso sale igual («no pude reabrirlo, reabrilo vos») y el fallo se dice
reaparece 2026-09-08T04:03:11Z "Proy A (2026-09-08, cerrado por el arnés)"
rc=$(TYCON_AZ_FAIL='actualizar:--state' correr)
{ [ "$rc" -eq 0 ] && llamada comentario 0 'b.includes("Volvió a aparecer") && b.includes("No pude reabrirlo") && b.includes("reabrilo vos")' \
  && ped 'p.fallidos.some((x) => x.paso === "reabrir" && /no pude reabrir el pedido 301/.test(x.motivo)) && p.reabiertos.length === 0'; } \
  && ok "T18n: 🔴 una reapertura que falla avisa igual en el Bug y cuenta el fallo" \
  || no "T18n: rc=$rc comentarios=$(cuenta comentario) · $(pie)"

# T18o. 🔴 los avisos del arnés en un Bug mencionan a quien lo tiene asignado y al responsable de respaldo (porque
# en esta organización cambiar el estado de un Bug no manda mail a nadie — medido: las únicas suscripciones de work
# items son «asignado» y «reacción» —, y una mención sí). Si la identidad del responsable de respaldo no se resuelve, el aviso sale igual
# con la mención al responsable y el fallo se dice: el cierre ya ocurrió, y callarlo sería peor.
mundo; rm -f "$TMP/fixaz/identidades-${BACKUP_OWNER_MAIL}.json"
ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
estados "Proy A" Closed; wi 301 New "Proy A"
snapshot $HOY "[$(p1 abc12345 browserslist B/B)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta actualizar)" -eq 1 ] && llamada comentario 0 'b.includes("Cierro este pedido") && b.includes("@Dana Prueba") && !b.includes(process.env.BACKUP_OWNER_ID)' \
  && ped 'p.fallidos.some((x) => x.paso === "mencion" && x.proyecto === "Proy A")'; } \
  && ok "T18o: 🔴 sin la identidad del responsable de respaldo el aviso de cierre sale igual, mencionando al responsable, y el fallo se dice" \
  || no "T18o: rc=$rc cierres=$(cuenta actualizar) comentarios=$(cuenta comentario) · $(pie)"
# y un Bug asignado al responsable de respaldo lo menciona UNA vez
mundo
ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
estados "Proy A" Closed; wi 301 New "Proy A"
node -e 'const f = process.argv[1]; const w = JSON.parse(require("fs").readFileSync(f, "utf8")); w.fields["System.AssignedTo"] = { id: process.env.BACKUP_OWNER_ID, displayName: "Respaldo Prueba", uniqueName: "respaldo@prueba" }; require("fs").writeFileSync(f, JSON.stringify(w));' "$TMP/fixaz/wi-301.json"
snapshot $HOY "[$(p1 abc12345 browserslist B/B)]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada comentario 0 'b.split("data-vss-mention").length === 2'; } \
  && ok "T18o: un Bug asignado al responsable de respaldo lo menciona una sola vez" \
  || no "T18o (asignado al responsable de respaldo): rc=$rc · $(pie)"

mundo
ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 301" "  - ProyB: 302"
snapshot $HOY "[$(p1 abc12345 browserslist B/B)]" "A/A2"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ] && ! grep -q '^pagado_avisado:' "$TMP/pend/pending/abc12345.yaml"; } \
  && [ "$(cuenta actualizar)" -eq 0 ] \
  && ok "T18: 🔴 con un repo del proyecto sin medir, «ya no aparece» NO se avisa ni se cierra (no medido ≠ limpio)" \
  || no "T18 sin medir: rc=$rc comentarios=$(cuenta comentario) cierres=$(cuenta actualizar)"

# ── T18b. la ficha que se RESOLVIÓ esta noche también avisa ───────────────────────────────────────
mundo
ficha promoted abc12345 browserslist high 3 "A/A" "resuelto: 2026-09-10" "pedidos:" "  - Proy A: 401"
estados "Proy A" Closed; wi 401 New "Proy A"
snapshot $HOY "[]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && llamada actualizar 0 'arg("--id") === "401" && arg("--state") === "Closed"' && llamada comentario 0 'arg("--id") === "401" && b.includes("ya no aparece")' && [ "$(cuenta crear)" -eq 0 ]; } \
  && ok "T18b: la ficha resuelta esta noche cierra su Bug y le avisa que ya no aparece" \
  || no "T18b: rc=$rc comentarios=$(cuenta comentario) · $(pie)"

# ── T19. «quedó declarada»: una vez por vencimiento ───────────────────────────────────────────────
mundo
ficha pending abc12345 browserslist high 3 "B/B" "pedidos:" "  - Proy A: 501" "  - ProyB: 502" "declarada_en:" "  - A/A (vence 2026-12-31)"
wi 501 New "Proy A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A@2026-12-31 B/B)]"
rc=$(correr)
primero=0; llamada comentario 0 'arg("--id") === "501" && b.includes("quedó declarada") && b.includes("2026-12-31")' \
  && llamada comentario 0 'b.includes(`data-vss-mention="version:2.0,${process.env.BACKUP_OWNER_ID}"`) && b.includes("@Dana Prueba")' \
  && grep -qx '  - Proy A (vence 2026-12-31)' "$TMP/pend/pending/abc12345.yaml" \
  && ped 'p.deuda_avisada.length === 1 && p.deuda_avisada[0].vence === "2026-12-31" && p.deuda_avisada[0].id === 501' && primero=1
correr >/dev/null; segundo=$(cuenta comentario)
snapshot $HOY "[$(p1 abc12345 browserslist A/A@2027-03-31 B/B)]"
correr >/dev/null
{ [ "$rc" -eq 0 ] && [ "$primero" -eq 1 ] && [ "$segundo" -eq 1 ] && [ "$(cuenta comentario)" -eq 2 ] && [ "$(cuenta actualizar)" -eq 0 ] \
  && [ "$(grep -c '^  - Proy A (vence' "$TMP/pend/pending/abc12345.yaml")" -eq 1 ] \
  && grep -qx '  - Proy A (vence 2027-03-31)' "$TMP/pend/pending/abc12345.yaml"; } \
  && ok "T19: «quedó declarada» se avisa una vez (otra sólo si la deuda se renueva) y el Bug queda ABIERTO: la deuda no es un arreglo" \
  || no "T19: rc=$rc primero=$primero segundo=$segundo total=$(cuenta comentario)"

# ── T20. 🔴 el modo simulado lee, calcula y publica, pero NO escribe nada ─────────────────────────
for variante in llave flag; do
  mundo
  if [ "$variante" = llave ]; then config false; fi
  ficha pending abc12345 browserslist high 1 "A/A"
  snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
  antes=$(cat "$TMP/pend/pending/abc12345.yaml" | shasum -a 256)
  if [ "$variante" = llave ]; then rc=$(correr); else rc=$(correr --simulate); fi
  despues=$(cat "$TMP/pend/pending/abc12345.yaml" | shasum -a 256)
  { [ "$rc" -eq 0 ] && [ "$antes" = "$despues" ] \
    && [ "$(cuenta crear)" -eq 0 ] && [ "$(cuenta comentario)" -eq 0 ] && [ "$(cuenta actualizar)" -eq 0 ] \
    && [ "$(cuenta identidad)" -eq 1 ] && [ "$(cuenta wiql)" -eq 1 ] && [ "$(cuenta grupo)" -eq 1 ] \
    && ped 'p.simulado === true && p.creados.length === 1 && p.creados[0].id === null && p.creados[0].asignado_a === "dana@prueba"' \
    && grep -q 'Dependencia vulnerable: browserslist (high) en A/A' "$TMP/o.txt" && grep -q 'data-vss-mention' "$TMP/o.txt"; } \
    && ok "T20 ($variante): 🔴 simulado hace las lecturas, publica lo que habría creado con su texto, y no escribe ni un work item ni la ficha" \
    || no "T20 ($variante): rc=$rc ficha-igual=$([ "$antes" = "$despues" ] && echo sí || echo NO) creates=$(cuenta crear) · $(pie)"
done

# ── T20b. 🔴 en simulado, lo que habría salido NO figura también como «sigue sin pedido» ──────────
# Como simulado no escribe la ficha, `sin_pedido` repetiría
# todo lo que falta al empezar, y el mismo par saldría en «habría creado» y en «sin pedido desde hace 9
# días» — justo en la salida que se lee para decidir si encender los pedidos. El espejo: lo que el tope
# postergó sí sigue sin pedido (sin él, el arreglo podría vaciar la lista entera).
mundo
config false
DETECTADO=2026-09-01 ficha pending abc12345 browserslist high 5 "A/A"
DETECTADO=2026-09-01 ficha pending ado12345 lodash high 5 "B/B"
DETECTADO=2026-09-01 ficha pending ppp12345 semver high 1 "C/C"
snapshot $HOY "[$(p1 abc12345 browserslist A/A),$(p1 ado12345 lodash B/B),$(p1 ppp12345 semver C/C)]"
echo '{ "workItems": [ { "id": 779 } ] }' > "$TMP/fixaz/wiql-ProyB.json"
echo '{ "id": 779, "fields": { "System.Tags": "arnes-hallazgo; arnes:ado12345" } }' > "$TMP/fixaz/wi-779.json"
rc=$(correr)
{ [ "$rc" -eq 0 ] \
  && ped 'p.simulado === true && p.creados.some((c) => c.ficha === "abc12345") && p.adoptados.some((a) => a.ficha === "ado12345" && a.id === 779)' \
  && ped '!p.sin_pedido.some((x) => x.ficha === "abc12345" || x.ficha === "ado12345")' \
  && ped 'p.sin_pedido.some((x) => x.ficha === "ppp12345" && /postergada por el tope/.test(x.motivo))'; } \
  && ok "T20b: 🔴 en simulado, lo que habría creado o adoptado no figura también como sin pedido, y lo postergado sí" \
  || no "T20b: rc=$rc · $(node -e 'try{const p=require(process.argv[1]).pedidos;console.log(JSON.stringify({creados:p.creados.map(c=>c.ficha),adoptados:p.adoptados.map(a=>a.ficha),sin_pedido:p.sin_pedido}))}catch(e){console.log(e.message)}' "$TMP/out/dependencias-$HOY.json")"

# ── T21. la sección `pedidos` trae TODAS sus claves aunque no haya novedad ────────────────────────
mundo
snapshot $HOY "[]"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta version)" -eq 1 ] \
  && ped 'p.simulado === false && p.tope === 2 && p.fichas_vivas === 0 && p.fichas_sin_pedido === 0 && p.existentes === 0 && ["creados","adoptados","fallidos","postergados","sin_iteracion","sin_dueno_unico","pagados_avisados","deuda_avisada","sin_pedido"].every((k) => Array.isArray(p[k]) && p[k].length === 0) && s.fecha === "2026-09-10" && Array.isArray(s.presencias)'; } \
  && ok "T21: una noche sin novedad publica la sección entera (listas vacías, nunca ausentes), conserva el snapshot y verifica que \`az\` responde" \
  || no "T21: rc=$rc · $(pie)"

# ── T22. el aviso de arranque cobra la ausencia, los fallos y el modo simulado ───────────────────
aviso(){ # <json de pedidos, o "" para que no esté la clave>
  rm -rf "$TMP/dash" "$TMP/deps" "$TMP/vig"; mkdir -p "$TMP/dash" "$TMP/deps/pending" "$TMP/vig"
  # 🔴 una noche BUENA incluye la constancia de entrega del resumen diario (`resumen`);
  # sin ella el aviso dice «NO consta» en vez del ✅ que el T22d exige. Y el aviso mira también los
  # snapshots del vigilante: `TYCON_WATCHER_OUT` a una carpeta vacía para no leer los del repo real.
  # 🔴 y también el `cruce` — sin la clave el aviso dice, con razón, que la noche NO cruzó.
  # `TYCON_DEPS_REPO` fija el árbol de la noche: sin él, en una máquina con la versión bajada y los nocturnos
  # apagados, el aviso no lee ningún árbol y calla, y estos casos salen rojos por la máquina, no por el aviso.
  node -e '
const [f, ped] = process.argv.slice(1);
const s = { fecha: "2026-09-10", corrida_completa: true, linea_base: false, no_medidos: [], hallazgos: [], resumen: { message_id: 1, motivo: null },
  cruce: { consultado: true, motivo: null, cerrados_vivos: [], no_leidos: [], huerfanos: [] } };
if (ped) s.pedidos = JSON.parse(ped);
require("fs").writeFileSync(f, JSON.stringify(s));' "$TMP/dash/dependencias-2026-09-10.json" "$1"
  TYCON_DEPS_REPO="$TMP" TYCON_DEPS_OUT="$TMP/dash" TYCON_DEPS_PENDING="$TMP/deps" TYCON_WATCHER_OUT="$TMP/vig" TYCON_DEPS_NOW=2026-09-10T15:00:00Z node "$NOTICE"
}
salida=$(aviso "")
echo "$salida" | grep 'NO intentó crear pedidos' >/dev/null && ok "T22a: snapshot sin «pedidos» → el aviso dice que la noche NO intentó crear pedidos" || no "T22a: el aviso calla la ausencia — «${salida}»"
salida=$(aviso '{"simulado":false,"creados":[],"fallidos":[{"ficha":"abc12345","proyecto":"Proy A","paso":"crear","motivo":"TF401320 sin permiso"},{"ficha":"def67890","proyecto":"ProyB","paso":"duplicados","motivo":"no pude consultar duplicados (x)"}]}')
{ echo "$salida" | grep '2 pedido(s) no se pudieron crear' >/dev/null && echo "$salida" | grep 'TF401320' >/dev/null; } \
  && ok "T22b: con fallos el aviso los cuenta y muestra el primer motivo" || no "T22b: «${salida}»"
salida=$(aviso '{"simulado":true,"creados":[{"ficha":"a"},{"ficha":"b"}],"fallidos":[]}')
echo "$salida" | grep 'modo simulado: 2 habrían salido' >/dev/null && ok "T22c: en modo simulado dice cuántos habrían salido" || no "T22c: «${salida}»"
salida=$(aviso '{"simulado":false,"creados":[],"fallidos":[],"adoptados":[]}')
{ echo "$salida" | grep 'no hay nada esperando' >/dev/null && ! echo "$salida" | grep -i 'pedido' >/dev/null; } \
  && ok "T22d: una noche con la sección presente y sin novedad no agrega ruido" || no "T22d: «${salida}»"
salida=$(aviso '{"simulado":false,"creados":[{"ficha":"a"}],"fallidos":[{"ficha":"abc12345","proyecto":"Proy A","paso":"administradores","motivo":"TF400813 sin permiso para leer grupos"}]}')
{ echo "$salida" | grep '1 pedido(s) con fallos que no impidieron crearlos' >/dev/null && echo "$salida" | grep 'TF400813' >/dev/null \
  && ! echo "$salida" | grep 'no se pudieron crear' >/dev/null; } \
  && ok "T22e: un fallo que no impidió crear (leer administradores, comentar) se cuenta aparte y con su motivo" || no "T22e: «${salida}»"
# T22f. 🔴 se cuentan PEDIDOS, no entradas: un par con la lectura de
# administradores fallida Y el `crear` fallido no existe — no puede aparecer también como «creado con
# fallos». Y un pedido con dos fallos posteriores es UN pedido, no dos.
salida=$(aviso '{"simulado":false,"creados":[{"ficha":"d"}],"fallidos":[{"ficha":"a","proyecto":"P","paso":"administradores","motivo":"leer"},{"ficha":"a","proyecto":"P","paso":"crear","motivo":"TF-crear"},{"ficha":"d","proyecto":"P","paso":"comentario","motivo":"TF-comentar"},{"ficha":"d","proyecto":"P","paso":"escribir-ficha","motivo":"disco"}]}')
{ echo "$salida" | grep '1 pedido(s) no se pudieron crear — crear: TF-crear' >/dev/null \
  && echo "$salida" | grep '1 pedido(s) con fallos que no impidieron crearlos — comentario: TF-comentar' >/dev/null \
  && [ "$(echo "$salida" | grep -c 'pedido(s)')" -eq 2 ]; } \
  && ok "T22f: 🔴 el aviso cuenta pedidos y no entradas: el que no salió no figura también como creado con fallos" || no "T22f: «${salida}»"

# ── T25. el orden del pipeline: pedidos DESPUÉS de la revisión y ANTES del commit ─────────────────
# `pipeline_ok <yaml>` imprime «ok» o qué falta. Es una función para poder correrla contra mutantes
# (T25b): un chequeo verificado a mano puede dar por bueno un paso donde
# quitar `--today` no lo pone rojo.
pipeline_ok(){
  local Y="$1" r p c prl d k rev llamada_noc pedi llamada_ped final
  linea(){ grep -nF "displayName: '$1'" "$Y" | head -1 | cut -d: -f1; }
  r=$(linea 'Correr la revisión de dependencias'); p=$(linea 'Crear los pedidos de trabajo')
  c=$(linea 'Guardar el snapshot y las fichas en el repo de operaciones'); prl=$(linea 'Abrir un pull request por hallazgo (ahí se decide)')
  d=$(linea 'Denunciar que los pedidos no se intentaron')
  if ! { [ -n "$r" ] && [ -n "$p" ] && [ -n "$c" ] && [ -n "$prl" ] && [ -n "$d" ] && [ "$r" -lt "$p" ] && [ "$p" -lt "$c" ] && [ "$c" -lt "$prl" ] && [ "$prl" -lt "$d" ]; }; then
    echo "orden de pasos incorrecto o paso ausente — revisión=$r pedidos=$p commit=$c pr=$prl denuncia=$d"; return
  fi
  # Desde el paso ANTERIOR a la revisión: en este YAML el `script:` va antes de su `displayName`, así
  # que el guion de la revisión (donde nace la fecha de la noche) queda entre el clon y la revisión.
  k=$(linea 'Clonar los repos declarados')
  # 🔴 Cada chequeo mira SU paso, no un bloque mezclado: con el bloque
  # entero, quitar `--today` de la revisión pasaría igual porque el paso de pedidos también lo tiene.
  rev=$(sed -n "$(( ${k:-0} + 1 )),${r}p" "$Y")                    # guion de la revisión
  llamada_noc=$(echo "$rev" | sed -n '/nightly-dependencies.js run/,/| tee/p')
  pedi=$(sed -n "$(( r + 1 )),$(( p + 3 ))p" "$Y")                  # guion + env del paso de pedidos
  llamada_ped=$(echo "$pedi" | sed -n '/work-items.js run/,/| tee/p')
  final=$(sed -n "${prl},\$p" "$Y")
  echo "$pedi" | grep 'work-items.js run' >/dev/null || { echo "el paso de pedidos no corre el guion"; return; }
  echo "$pedi" | grep -F 'AZURE_DEVOPS_EXT_PAT: $(System.AccessToken)' >/dev/null || { echo "el paso de pedidos no tiene el token"; return; }
  ! echo "$pedi" | grep -E '^[[:space:]]*continueOnError:' >/dev/null || { echo "el paso de pedidos tiene continueOnError"; return; }
  echo "$pedi" | grep 'PEDIDOS_NO_INTENTADOS' >/dev/null || { echo "el paso de pedidos no deja la marca"; return; }
  echo "$pedi" | grep 'HOY_NOCTURNO:-' >/dev/null && ! echo "$pedi" | grep 'date -u' >/dev/null || { echo "el paso de pedidos no toma la fecha de la revisión"; return; }
  echo "$llamada_ped" | grep -E -- "${HOY_OPC} \"[\$]HOY\"" >/dev/null || { echo "el guion de pedidos no recibe --today"; return; }
  echo "$final" | grep 'succeededOrFailed()' >/dev/null && echo "$final" | grep 'PEDIDOS_NO_INTENTADOS' >/dev/null || { echo "falta la denuncia final"; return; }
  echo "$rev" | grep 'task.setvariable variable=HOY_NOCTURNO' >/dev/null || { echo "la revisión no publica la fecha"; return; }
  echo "$llamada_noc" | grep -E -- "${HOY_OPC} \"[\$]HOY\"" >/dev/null || { echo "la revisión no recibe --today"; return; }
  echo "ok"
}
salida=$(pipeline_ok "$YAML")
[ "$salida" = ok ] \
  && ok "T25: el paso de pedidos va entre la revisión y el commit, con el token, usa la MISMA fecha que la revisión (una ejecución que cruza la medianoche no busca el snapshot de mañana), y el rojo lo pone un paso final" \
  || no "T25: $salida"

# ── T25b. 🔴 el chequeo de T25 se pone ROJO si a cualquiera de las dos llamadas le falta `--today` ─
# Sin `--today`, el guion de
# pedidos usa la fecha del reloj, y una corrida que cruza la medianoche busca el snapshot de mañana.
sin_hoy(){ # <displayName del paso> → copia del YAML con `--today "$HOY"` borrado sólo en ese paso
  local fin; fin=$(grep -nF "displayName: '$1'" "$YAML" | head -1 | cut -d: -f1)
  awk -v fin="$fin" -v re="${HOY_OPC} \"[\$]HOY\"" 'NR < fin && $0 ~ re { ult = NR } { l[NR] = $0 } END { for (i = 1; i <= NR; i++) if (i != ult) print l[i] }' "$YAML"
}
sin_hoy 'Crear los pedidos de trabajo' > "$TMP/yaml-sin-hoy-pedidos.yml"
sin_hoy 'Correr la revisión de dependencias' > "$TMP/yaml-sin-hoy-revision.yml"
m1=$(pipeline_ok "$TMP/yaml-sin-hoy-pedidos.yml"); m2=$(pipeline_ok "$TMP/yaml-sin-hoy-revision.yml")
# Cada mutante tiene que perder UNA línea `--today`, no cero (un mutante igual al original no prueba nada).
# 🔴 Contra el original y no contra un número fijo: el paso del resumen diario usa la misma
# fecha con el mismo idioma, y un `2` escrito a mano pondría esta prueba roja sin que ninguna llamada
# hubiera perdido su `--today` — la próxima que la use no tiene por qué romperla.
orig=$(grep -cE -- "${HOY_OPC} \"[\$]HOY\"" "$YAML")
quedan=$(grep -cE -- "${HOY_OPC} \"[\$]HOY\"" "$TMP/yaml-sin-hoy-pedidos.yml") quedan2=$(grep -cE -- "${HOY_OPC} \"[\$]HOY\"" "$TMP/yaml-sin-hoy-revision.yml")
{ [ "$orig" -ge 2 ] && [ "$quedan" -eq $(( orig - 1 )) ] && [ "$quedan2" -eq $(( orig - 1 )) ] && [ "$m1" != ok ] && [ "$m2" != ok ]; } \
  && ok "T25b: 🔴 quitar --today de la llamada de pedidos o de la de la revisión pone rojo al chequeo del pipeline" \
  || no "T25b: líneas --today original=$orig · mutante pedidos=$quedan · mutante revisión=$quedan2 (cada una tiene que ser original-1) · sin --today en pedidos: «${m1}» · sin --today en la revisión: «${m2}»"

# ── T26. el texto del pull request NO cambia un byte al extraer el generador ─────────────────────
cat > "$TMP/dorada.yaml" <<'FICHA'
id: aa11bb22
detectado: 2026-09-05
veredicto: pendiente
paquete: browserslist
severidad: high
noches: 3
reaparecido: 2026-09-09
pr_antes: 3015
rechazado_antes: 2026-09-07
motivo_rechazo_antes: "no viaja al navegador / ver R$&D"
ids:
  - aa11bb22
repos:
  - A/A
  - B/B
avisos:
  - https://x/GHSA-73wf
  - https://x/GHSA-9999
FICHA
cat > "$TMP/dorado.txt" <<'DORADO'
Dependencia vulnerable: browserslist (high) — 2 repo(s)
---CUERPO---
Se publicó un aviso de seguridad que alcanza a **browserslist** (severidad high) y que
hoy toca 2 repo(s) del equipo. El código no cambió: cambió lo que se sabe del paquete.

**Repos alcanzados**
- A/A
- B/B

**Avisos**
- https://x/GHSA-73wf
- https://x/GHSA-9999

Detectado hace 3 noche(s) seguida(s).

⚠️ Ya se había rechazado el 2026-09-07 (PR !3015): «no viaja al navegador / ver R$&D»

**Qué decidir acá**
- **Mergear** = es trabajo real: hay que subir el paquete. El borrador pasa a `promoted/`.
- **Rechazar** = no aplica, y el comentario es el motivo. Si la razón es que no viaja al
  navegador ni al servidor, lo correcto es **declararlo** en el `vulnerabilidades-pendientes.json`
  del repo, con motivo y fecha de revisión — así deja de despertar a nadie sin volverse
  permanente en silencio.

_Este pull request no cambia código: transporta la decisión. Lo abrió la revisión nocturna
de dependencias (`scripts/nightly/dependencies/`)._
DORADO
node "$NOC" pr-text --draft "$TMP/dorada.yaml" > "$TMP/pr-hoy.txt" 2>&1
if cmp -s "$TMP/dorado.txt" "$TMP/pr-hoy.txt"; then ok "T26: el texto del pull request es byte a byte el de antes de extraer el generador"
else no "T26: el texto del pull request cambió — $(diff "$TMP/dorado.txt" "$TMP/pr-hoy.txt" | head -6 | tr '\n' ' ')"; fi

# ── T28. las listas del snapshot no dependen del orden en que el disco devuelve las fichas ────────
# `sin_pedido`, `pagados_avisados` y `deuda_avisada` saldrían en el
# orden de `readdirSync`, que no está garantizado. El snapshot se commitea cada noche: un orden
# distinto con el mismo contenido es un diff que no dice nada. Se prueba llamando a `hablar` con las
# mismas fichas en dos órdenes (tope 0 y simulado: no hace falta hablar con ningún `az`).
mundo
ficha pending aaa11111 browserslist high 1 "A/A"
ficha pending bbb22222 handlebars high 1 "A/A"
ficha pending ccc33333 lodash high 1 "B/B" "pedidos:" "  - Proy A: 71"
ficha pending ddd44444 minimist high 1 "B/B" "pedidos:" "  - Proy A: 72"
ficha pending eee55555 qs high 1 "B/B" "pedidos:" "  - Proy A: 73"
ficha pending fff66666 ws high 1 "B/B" "pedidos:" "  - Proy A: 74"
snapshot $HOY "[$(p1 eee55555 qs A/A@2026-12-31),$(p1 fff66666 ws A/A@2026-12-31)]"
orden=$(node -e '
const ped = require(process.argv[1]), noc = require(process.argv[2]), fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[3], "utf8")), snap = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
const az = () => { throw new Error("no debería llamar a az"); };
const plataforma = async () => { throw new Error("no debería llamar a la plataforma"); };
const correr = async (fichas) => {
  const { res } = await ped.hablar({ az, plataforma, cfg, azure: cfg.azure, hoy: "2026-09-10", simulado: true, tope: 0, snap, out: "/nada", tmp: process.argv[5], fichas });
  return JSON.stringify([res.sin_pedido, res.pagados_avisados, res.deuda_avisada]);
};
(async () => {
  const fichas = noc.leerTodasLasFichas(process.argv[6]);
  const a = await correr(fichas), b = await correr([...fichas].reverse());
  console.log(a === b && JSON.parse(a).every((l) => l.length >= 2) ? "igual" : `distinto: ${a} ≠ ${b}`);
})();
' "$PED" "$NOC" "$TMP/c.json" "$TMP/out/dependencias-$HOY.json" "$TMP" "$TMP/pend" 2>&1)
[ "$orden" = "igual" ] && ok "T28: sin_pedido, pagados_avisados y deuda_avisada salen iguales con las fichas en cualquier orden" \
  || no "T28: el orden de las listas depende del orden de las fichas — $orden"

# ── T27. 🔴 SEGUNDA NOCHE: el push de anoche se perdió, la ficha no tiene el id, Azure sí ─────────
# El caso de dos noches que una suite de una sola noche no ve. La ficha vuelve sin
# `pedidos:` —el commit con el id nunca llegó a main— y el `az` de mentira recuerda el Bug que creó.
mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
cp "$TMP/pend/pending/abc12345.yaml" "$TMP/ficha-sin-push.yaml"
correr >/dev/null
cp "$TMP/ficha-sin-push.yaml" "$TMP/pend/pending/abc12345.yaml"
rc=$(correr)
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 1 ] && grep -qx '  - Proy A: 101' "$TMP/pend/pending/abc12345.yaml" \
  && ped 'p.adoptados.length === 1 && p.adoptados[0].id === 101'; } \
  && ok "T27: 🔴 si el push con el id se perdió, la noche siguiente adopta el Bug por la etiqueta y no crea un segundo" \
  || no "T27: rc=$rc creates=$(cuenta crear) · $(pie)"

# ── T70. Pedido_DependenciasPorLaPlataforma_AdoptaPorEtiqueta ─────────────────────────────────────
# El Bug de dependencias se crea por la capa de plataforma, en el proyecto de Azure del REPO: `work_items` de
# operations.json nombra otra organización y otro proyecto (los de ejecuciones y el vigilante) y no tiene que
# mezclarse. Lleva el asignado en System.AssignedTo, la iteración y el texto en Repro Steps. El que ya existe se
# adopta por la etiqueta; con la búsqueda caída no se crea nada (un duplicado en el tablero de un cliente).
ops '{ "version": 1, "owners": { "default": "respaldo@prueba" }, "work_items": { "org": "otra-org", "project": "Operaciones" } }'
mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
printf '%s' '[{"path":"Proy A\\Sprint 3","attributes":{"finishDate":"2099-01-01T00:00:00Z"}}]' > "$TMP/fixaz/iteracion-Proy A.json"
rc=$(correr --operations "$TMP/operations.json")
c1=$(cuenta crear)
{ [ "$rc" -eq 0 ] && [ "$c1" -eq 1 ] \
  && llamada crear 0 'arg("--project") === "Proy A" && /dev\.azure\.com\/prueba/.test(arg("--organization")) && arg("--type") === "Bug"' \
  && llamada crear 0 'campo("System.AssignedTo") === "dana@prueba" && campo("System.IterationPath") === "Proy A\\Sprint 3"' \
  && llamada crear 0 'String(campo("Microsoft.VSTS.TCM.ReproSteps")).startsWith("@") && b.includes("browserslist")' \
  && llamada wiql 0 'arg("--organization") !== "otra-org" && !/Operaciones/.test(a.join(" "))' \
  && ped 'p.creados.length === 1 && p.creados[0].proyecto === "Proy A"'; } \
  && ok "T70 Pedido_DependenciasPorLaPlataforma_AdoptaPorEtiqueta (crea): en el proyecto del repo, no en el de work_items, con asignado, iteración y Repro Steps" \
  || no "T70 (crea): rc=$rc creates=$c1 · $(pie)"

mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
echo '{ "workItems": [ { "id": 777 } ] }' > "$TMP/fixaz/wiql-Proy A.json"
echo '{ "id": 777, "fields": { "System.Tags": "arnes-hallazgo; arnes:abc12345" } }' > "$TMP/fixaz/wi-777.json"
rc=$(correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] && grep -qx '  - Proy A: 777' "$TMP/pend/pending/abc12345.yaml" \
  && ped 'p.adoptados.length === 1 && p.adoptados[0].id === 777'; } \
  && ok "T70 (adopta): el que la plataforma encuentra por la etiqueta se adopta y no se crea otro" \
  || no "T70 (adopta): rc=$rc creates=$(cuenta crear) · $(pie)"

mundo
ficha pending abc12345 browserslist high 1 "A/A"
snapshot $HOY "[$(p1 abc12345 browserslist A/A)]"
rc=$(TYCON_AZ_FAIL=wiql correr --operations "$TMP/operations.json")
{ [ "$rc" -eq 0 ] && [ "$(cuenta crear)" -eq 0 ] \
  && ped 'p.creados.length === 0 && p.fallidos.some((x) => x.paso === "duplicados" && /no pude consultar duplicados/.test(x.motivo))'; } \
  && ok "T70 (búsqueda caída): 🔴 sin poder buscar duplicados no se crea nada, y se dice" \
  || no "T70 (búsqueda caída): rc=$rc creates=$(cuenta crear) · $(pie)"
rm -f "$TMP/operations.json"

echo
total=$((pasaron + fallos))
[ "$fallos" -eq 0 ] && { echo "✅ pedidos-de-trabajo: $pasaron/$total"; exit 0; } \
  || { echo "❌ pedidos-de-trabajo: $fallos fallo(s) de $total"; exit 1; }
