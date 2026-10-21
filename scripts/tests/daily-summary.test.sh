#!/usr/bin/env bash
# daily-summary.test.sh — red de scripts/nightly/dependencies/daily-summary.js.
#
# El resumen diario existe para que «no llegó» y «no había nada» dejen de ser el mismo silencio:
# un mensaje por día a quien mantiene el arnés con lo que dejaron las dos colas nocturnas, y una constancia de
# entrega en el snapshot que el aviso del arranque puede cobrar. Los casos giran alrededor de las
# confusiones que matarían la pieza sin un solo error:
#   · un `0` donde en realidad no hubo fuente («no volvió nada» cuando nadie midió);
#   · una noche sin cambios que se calla (el silencio no es un canal);
#   · comparar por NÚMERO en vez de por identidad (dos fichas nuevas que reemplazan a dos resueltas);
#   · un resumen que se da por entregado sin que Telegram lo haya aceptado;
#   · un paso del pipeline que confunde el literal `$(TELEGRAM_BOT_TOKEN)` con un token.
#
# 🔴 NINGÚN CASO TOCA LA RED. Telegram es un servidor HTTP local levantado por la propia suite
# (`TYCON_TELEGRAM_API`), y el canal es una carpeta de mentira (`TYCON_TELEGRAM_DIR`). Las dos
# variables se exportan ANTES de cualquier caso: sin ellas, en la máquina de un dev el script
# real leería `~/.claude/channels/telegram/.env` y mandaría un mensaje de verdad.
#
# Sin `daily-summary.js` TODA la suite sale roja. Los casos de los pipelines (T17, T18) corren el paso
# REAL extraído del YAML por su displayName, con las macros de Azure sustituidas como lo hace ADO.
#
# Correr: bash scripts/tests/daily-summary.test.sh   (~45 s: T13 espera sus dos reintentos de 5 s
# y T13b el corte de 15 s de curl; ninguno se puede acortar sin mentir sobre lo que se prueba)

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RES="$RAIZ/scripts/nightly/dependencies/daily-summary.js"
# El YAML del pipeline puede llamar con el nombre nuevo o con el viejo (el alias lo sigue aceptando hasta el
# retiro). El chequeo acepta los dos; el viejo sale del mapa de renombres, nunca escrito en la prueba.
nombres(){ # <kind> <nuevo> → «nuevo|viejo» de daily-summary.js (sólo «nuevo» sin mapa)
  node -e 'const [k, n, f] = process.argv.slice(1); let v = [];
    try { v = JSON.parse(require("fs").readFileSync(f, "utf8")).entries.filter((e) => e.kind === k && e.new === n && e.where === "scripts/nightly/dependencies/daily-summary.js").map((e) => e.old); } catch (_) { v = []; }
    console.log([...new Set([n, ...v])].join("|"));' "$1" "$2" "$RAIZ/scripts/lib/renames.json"
}
FUENTE_OPC="--($(nombres option source))"
FUENTE_DEPS="($(nombres value dependencies))"
TMP="$(mktemp -d)"
SRV_PID=""
limpiar() { [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; rm -rf "$TMP"; }
trap limpiar EXIT

# 🔴 Antes que nada: ningún caso puede alcanzar la API real ni el canal real del dev.
mkdir -p "$TMP/canal" "$TMP/canal-vacio"
TOK_PRUEBA=tok-de-prueba-que-no-debe-aparecer   # el token de mentira (en una variable: escrito en la asignación parece un secreto)
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOK_PRUEBA" > "$TMP/canal/.env"
printf '{"allowFrom":["990011223344"]}\n' > "$TMP/canal/access.json"
export TYCON_TELEGRAM_DIR="$TMP/canal"
export TYCON_TELEGRAM_API="http://127.0.0.1:9"      # puerto cerrado hasta que arranque el servidor
unset TELEGRAM_BOT_TOKEN TYCON_TELEGRAM_CHAT_ID

FALLOS=0; TOTAL=0
ok()  { TOTAL=$((TOTAL+1)); echo "✅ resumen-diario: $1"; }
no()  { TOTAL=$((TOTAL+1)); FALLOS=$((FALLOS+1)); echo "❌ resumen-diario: $1"; }
salt(){ echo "∅  resumen-diario: $1 (SALTEADO, no verde)"; }

# ── Utilidades ─────────────────────────────────────────────────────────────────────────────────
# q <archivo-json> <expresión JS sobre j>  → imprime el resultado (objetos como JSON)
q() {
  node -e '
const fs = require("fs");
let j; try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { console.log("<<ILEGIBLE>>"); process.exit(0); }
const v = new Function("j", "return (" + process.argv[2] + ")")(j);
console.log(v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));' "$1" "$2"
}
fecha() { node -e 'console.log(new Date(Date.parse(process.argv[1] + "T12:00:00Z") + Number(process.argv[2]) * 864e5).toISOString().slice(0, 10))' "$1" "$2"; }

HOY=2026-09-20
AYER=$(fecha "$HOY" -1)

# Un mundo de dependencias: config, resumen.json vacío, snapshots y fichas.
mundo() { # <dir>
  local D="$1"; rm -rf "$D"
  mkdir -p "$D/out" "$D/pend/pending" "$D/pend/promoted" "$D/pend/archived" "$D/vig" "$D/vigpend/pending" "$D/vigpend/promoted" "$D/vigpend/archived"
  cat > "$D/repos.json" <<'J'
{ "repos": [
  { "producto": "A", "ruta": "A/A", "tipo": "npm", "activo": true, "ado": "ProyA/A" },
  { "producto": "B", "ruta": "B/B", "tipo": "npm", "activo": true, "ado": "Proy%20B/B" } ] }
J
  echo '{ "rubros_sin_fuente": {} }' > "$D/resumen.json"
  # sin `notify` no se manda nada; el mundo de siempre avisa por Telegram
  echo '{ "version": 1, "owners": { "default": "lead@acme.example" }, "notify": { "channel": "telegram" } }' > "$D/operations.json"
}
# snap <dir> <fecha> <json que pisa claves de la base>  — la forma REAL del snapshot (claves del 09-14)
snap() {
  node -e '
const [dir, fecha, extra] = process.argv.slice(1);
const base = { fecha, corrida_completa: true, linea_base: false, comparado_contra: null, repos_activos: 2,
  repos_apagados: 0, repos: [], no_medidos: [], hallazgos: [], presencias: [], anunciados_hoy: [],
  postergados_por_presupuesto: [], anexados: [], reaparecidos_ids: [], presupuesto: { tope: 2 },
  resueltos_ids: [], descartados_ids: [], aceptadas_sin_resolver: [], rechazadas_sin_deuda_ids: [], ignorados_ids: [] };
const e = JSON.parse(extra);
for (const [k, v] of Object.entries(e)) { if (v === "__BORRAR__") delete base[k]; else base[k] = v; }
require("fs").writeFileSync(dir + "/out/dependencias-" + fecha + ".json", JSON.stringify(base, null, 2) + "\n");' "$1" "$2" "$3"
}
# ficha <dir> <carpeta> <id> <detectado> <veredicto> <repo> [líneas extra…]
ficha() {
  local D="$1" C="$2" ID="$3" DET="$4" VER="$5" REPO="$6"; shift 6
  { printf 'id: %s\ndetectado: %s\nveredicto: %s\npaquete: pkg-%s\nseveridad: high\nnoches: 1\n' "$ID" "$DET" "$VER" "$ID"
    for l in "$@"; do printf '%s\n' "$l"; done
    printf 'repos:\n  - %s\navisos:\n  - https://x/GHSA-%s\n' "$REPO" "$ID"; } > "$D/pend/$C/$ID.yaml"
}
# vficha <dir> <carpeta> <id> <fecha> <veredicto> [líneas extra…]   (borrador del vigilante)
vficha() {
  local D="$1" C="$2" ID="$3" F="$4" VER="$5"; shift 5
  { printf 'id: "%s"\nfecha: "%s"\nproducto: "%s"\nregla: "latido"\nhuella: "%s"\nseveridad: "media"\nplugin: "x"\n' "$ID" "$F" "$(echo "$ID" | cut -d- -f4)" "$(echo "$ID" | cut -d- -f5)"
    printf 'diagnostico: "DATO-DE-CLIENTE-QUE-NO-DEBE-SALIR en %s"\nveredicto: %s\n' "$ID" "$VER"
    for l in "$@"; do printf '%s\n' "$l"; done; } > "$D/vigpend/$C/$ID.yaml"
}
vsnap() { # <dir> <fecha> <json que pisa claves>  — la forma REAL: `nuevos` y `marcados_ignorados` son CONTEOS
  node -e '
const [dir, fecha, extra] = process.argv.slice(1);
const base = { fecha, generado: fecha + "T08:00:00.000Z", productos: {}, conteos: {}, hallazgos: [], no_medido: [],
  nuevos: 0, repetidos: 0, marcados_ignorados: 0, ignorados_ids: [], modo: "normal", aviso: null, recordados: 0 };
const e = JSON.parse(extra);
for (const [k, v] of Object.entries(e)) { if (v === "__BORRAR__") delete base[k]; else base[k] = v; }
require("fs").writeFileSync(dir + "/vig/vigilante-" + fecha + ".json", JSON.stringify(base, null, 2) + "\n");' "$1" "$2" "$3"
}

armar() { # <dir> <fuente> <hoy> [args extra]  → JSON en stdout
  local D="$1" F="$2" H="$3"; shift 3
  if [ "$F" = vigilante ]; then
    node "$RES" build --source vigilante --today "$H" --out "$D/vig" --pending "$D/vigpend" --deps-out "$D/out" --json "$@"
  else
    node "$RES" build --source dependencies --today "$H" --out "$D/out" --pending "$D/pend" --config "$D/repos.json" \
      --summary-config "$D/resumen.json" --watcher-out "$D/vig" --json "$@"
  fi
}
entregar() { # <dir> <fuente> <hoy> [args extra]  → stdout+stderr a $D/entregar.txt, devuelve el exit code
  local D="$1" F="$2" H="$3"; shift 3
  if [ "$F" = vigilante ]; then
    node "$RES" deliver --source vigilante --today "$H" --out "$D/vig" --pending "$D/vigpend" --deps-out "$D/out" --operations "${OPS_FILE:-$D/operations.json}" "$@" > "$D/entregar.txt" 2>&1
  else
    node "$RES" deliver --source dependencies --today "$H" --out "$D/out" --pending "$D/pend" --config "$D/repos.json" \
      --summary-config "$D/resumen.json" --watcher-out "$D/vig" --operations "${OPS_FILE:-$D/operations.json}" "$@" > "$D/entregar.txt" 2>&1
  fi
  echo $?
}
# sellar <dir> <fecha> [message_id|null] [motivo]  — deja en el snapshot de esa fecha el `resumen` de una
# noche anterior, con los rubros que `armar` calcula para ese día (así "ayer" es un ayer de verdad).
sellar() {
  local D="$1" F="$2" MID="${3:-1}" MOT="${4:-}"
  armar "$D" dependencias "$F" > "$D/sello.json" 2>/dev/null
  node -e '
const fs = require("fs"); const [arch, sello, mid, mot] = process.argv.slice(1);
const s = JSON.parse(fs.readFileSync(arch, "utf8")); const a = JSON.parse(fs.readFileSync(sello, "utf8"));
const entregado = mid !== "null";
s.resumen = { canal: "telegram", message_id: entregado ? Number(mid) : null, editado: null,
  entregado_el: entregado ? "2000-01-01T04:00:00.000Z" : null, motivo: mot || null, rubros: a.rubros };
fs.writeFileSync(arch, JSON.stringify(s, null, 2) + "\n");' "$D/out/dependencias-$F.json" "$D/sello.json" "$MID" "$MOT"
}

# vconstancia <archivo-snapshot> <json de resumen | __BORRAR__ | null>  — pisa la clave `resumen` de un snapshot
constancia() {
  node -e '
const fs = require("fs"); const [arch, r] = process.argv.slice(1);
const s = JSON.parse(fs.readFileSync(arch, "utf8"));
if (r === "__BORRAR__") delete s.resumen; else s.resumen = JSON.parse(r);
fs.writeFileSync(arch, JSON.stringify(s, null, 2) + "\n");' "$1" "$2"
}

# ── El Telegram de mentira ─────────────────────────────────────────────────────────────────────
# Anota cada POST (ruta con el token tapado, chat_id, message_id, text) y contesta lo que diga
# $TMP/respuesta: `ok:<id>` · `rechaza:<descripción>` · `mudo` (acepta la conexión y no contesta).
# Con varias líneas, cada pedido consume la primera y la última queda fija: así un caso puede decir
# «la edición se rechaza y el mensaje nuevo se acepta» sin depender del reloj.
: > "$TMP/pedidos.jsonl"; echo "ok:777" > "$TMP/respuesta"
node -e '
const http = require("http"), fs = require("fs"), qs = require("querystring");
const [log, resp, puertoF] = process.argv.slice(1);
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)).on("end", () => {
    const p = qs.parse(b);
    fs.appendFileSync(log, JSON.stringify({ ruta: req.url.replace(/\/bot[^/]*\//, "/bot<token>/"),
      token_ok: req.url.includes("/bottok-de-prueba-que-no-debe-aparecer/"), chat_id: p.chat_id,
      message_id: p.message_id || null, text: p.text, raw: b }) + "\n");
    const lineas = fs.readFileSync(resp, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const r = lineas[0] || "";
    if (lineas.length > 1) fs.writeFileSync(resp, lineas.slice(1).join("\n") + "\n");
    if (r === "mudo") return;
    res.setHeader("content-type", "application/json");
    if (r.startsWith("ok:")) return res.end(JSON.stringify({ ok: true, result: { message_id: Number(r.slice(3)) } }));
    if (r.startsWith("rechaza:")) return res.end(JSON.stringify({ ok: false, error_code: 400, description: r.slice(8) }));
    res.end(JSON.stringify({ ok: false, description: "respuesta de prueba desconocida" }));
  });
});
srv.listen(0, "127.0.0.1", () => fs.writeFileSync(puertoF, String(srv.address().port)));' "$TMP/pedidos.jsonl" "$TMP/respuesta" "$TMP/puerto" &
SRV_PID=$!
disown "$SRV_PID" 2>/dev/null || true   # sin esto, al matarlo bash imprime el código entero del servidor
for _ in $(seq 1 100); do [ -s "$TMP/puerto" ] && break; sleep 0.05; done
if [ ! -s "$TMP/puerto" ]; then echo "❌ resumen-diario: no pude levantar el servidor de prueba"; exit 1; fi
export TYCON_TELEGRAM_API="http://127.0.0.1:$(cat "$TMP/puerto")"
pedidos() { grep -c . "$TMP/pedidos.jsonl" 2>/dev/null || true; }
reset_srv() { : > "$TMP/pedidos.jsonl"; echo "${1:-ok:777}" > "$TMP/respuesta"; }
ultimo() { tail -1 "$TMP/pedidos.jsonl" > "$TMP/ultimo.json"; q "$TMP/ultimo.json" "$1"; }

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T1 armar_dependencias_ocho_rubros
D="$TMP/t1"; mundo "$D"
snap "$D" "$HOY" '{"hallazgos":[{"id":"aaa11111","paquete":"browserslist","severidad":"high","repos":["A/A"],"noches":1},{"id":"bbb22222","paquete":"handlebars","severidad":"critical","repos":["B/B"],"noches":3}],"anunciados_hoy":["aaa11111"],"postergados_por_presupuesto":["bbb22222"]}'
ficha "$D" pending aaa11111 "$HOY" pendiente A/A
ficha "$D" promoted ccc33333 "$(fecha "$HOY" -4)" util A/A
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
CLAVES=$(q "$D/a.json" 'Object.keys(j.rubros).sort().join(",")')
ESPERADAS="aceptadas_sin_resolver,deuda_con_pedido_abierto,edad_mas_vieja,nuevos,pedidos_cerrados,pedidos_cerrados_con_vivas,pedidos_creados,pedidos_reabiertos,postergadas_por_presupuesto,proyectos_con_tipo_de_fabrica,proyectos_sin_iteracion,rechazadas_sin_deuda,resueltas_con_pedido_abierto,vivas_por_proyecto"
# (catorce rubros: ocho de base, dos del cruce, tres de los pedidos creados, cerrados y reabiertos por el arnés, y uno con los proyectos donde el pedido salió con su elemento de backlog)
[ "$CLAVES" = "$ESPERADAS" ] && ok "T1 armar devuelve los catorce rubros de dependencias" || no "T1 rubros: esperaba [$ESPERADAS], obtuve [$CLAVES] ($(head -c 300 "$D/a.err"))"
[ "$(q "$D/a.json" 'Object.values(j.rubros).every(r => r && ["valor","de","motivo"].every(k => Object.prototype.hasOwnProperty.call(r, k)))')" = true ] \
  && ok "T1 cada rubro trae valor, de y motivo (ninguna clave ausente)" || no "T1 algún rubro no trae valor/de/motivo"
[ "$(q "$D/a.json" '["fuente","fecha","rubros","cambios","fallos","texto"].every(k => k in j) && j.fuente === "dependencias" && j.fecha === "'"$HOY"'"')" = true ] \
  && ok "T1 la salida tiene fuente, fecha, rubros, cambios, fallos y texto" || no "T1 falta alguna clave de la salida de armar"
[ "$(q "$D/a.json" 'j.rubros.nuevos.valor.map(x => x.id).join(",") + "|" + j.rubros.nuevos.valor[0].paquete + "|" + j.rubros.nuevos.valor[0].proyectos.join(",")')" = "aaa11111|browserslist|ProyA" ] \
  && ok "T1 nuevos: id, paquete y proyecto (proyectoDe sobre el repo)" || no "T1 nuevos mal: $(q "$D/a.json" 'j.rubros.nuevos')"
[ "$(q "$D/a.json" 'j.rubros.vivas_por_proyecto.de + "|" + JSON.stringify(j.rubros.vivas_por_proyecto.valor)')" = '2|[{"proyecto":"ProyA","ids":["aaa11111","ccc33333"]}]' ] \
  && ok "T1 vivas por proyecto: la pendiente y la aceptada sin resolver, agrupadas" || no "T1 vivas mal: $(q "$D/a.json" 'j.rubros.vivas_por_proyecto')"
[ "$(q "$D/a.json" 'j.rubros.edad_mas_vieja.valor + "|" + j.rubros.edad_mas_vieja.id')" = "4|ccc33333" ] \
  && ok "T1 la viva más vieja: días desde detectado y su id" || no "T1 edad mal: $(q "$D/a.json" 'j.rubros.edad_mas_vieja')"
[ "$(q "$D/a.json" 'j.rubros.postergadas_por_presupuesto.valor.hallazgos.map(x => x.id + ":" + x.paquete).join(",")')" = "bbb22222:handlebars" ] \
  && ok "T1 postergadas por presupuesto: los ids del snapshot con su paquete" || no "T1 postergadas mal: $(q "$D/a.json" 'j.rubros.postergadas_por_presupuesto')"


# T1b el desempate de la ficha más vieja no depende del idioma de la máquina
D="$TMP/t1b"; mundo "$D"; snap "$D" "$HOY" '{}'
ficha "$D" pending zz000001 "$(fecha "$HOY" -3)" pendiente A/A
ficha "$D" pending aa000001 "$(fecha "$HOY" -3)" pendiente A/A
LC_ALL=da_DK.UTF-8 LANG=da_DK.UTF-8 armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.rubros.edad_mas_vieja.id')" = aa000001 ] \
  && ok "T1b con dos vivas del mismo día, la más vieja es la de id menor también en un locale que ordena «aa» después de «z»" \
  || no "T1b desempate dependiente del locale: $(q "$D/a.json" 'j.rubros.edad_mas_vieja')"

# T1c sin snapshot de hoy, ilegible o que no es un objeto: armar sale 1 y entregar sale 3 sin mandar nada
D="$TMP/t1c"; mundo "$D"
node "$RES" build --source dependencies --today "$HOY" --out "$D/out" --pending "$D/pend" --config "$D/repos.json" --summary-config "$D/resumen.json" --watcher-out "$D/vig" > "$D/a.txt" 2>&1; RC=$?
[ "$RC" = 1 ] && grep -q "no hay snapshot de dependencias para $HOY" "$D/a.txt" && ok "T1c armar sin snapshot de hoy sale 1 y lo dice" || no "T1c armar sin snapshot: rc=$RC · $(head -c 200 "$D/a.txt")"
reset_srv ok:1; RC=$(entregar "$D" dependencias "$HOY")
[ "$RC" = 3 ] && [ "$(pedidos)" = 0 ] && grep -q 'no hay snapshot' "$D/entregar.txt" && ok "T1c entregar sin snapshot sale 3 y no manda nada" || no "T1c entregar sin snapshot: rc=$RC pedidos=$(pedidos) · $(head -c 200 "$D/entregar.txt")"
echo 'esto no es json' > "$D/out/dependencias-$HOY.json"
node "$RES" build --source dependencies --today "$HOY" --out "$D/out" --pending "$D/pend" --config "$D/repos.json" --summary-config "$D/resumen.json" --watcher-out "$D/vig" > "$D/b.txt" 2>&1; RC=$?
[ "$RC" = 1 ] && grep -q 'ilegible' "$D/b.txt" && ok "T1c snapshot ilegible: armar sale 1 y dice «ilegible»" || no "T1c snapshot ilegible: rc=$RC · $(head -c 200 "$D/b.txt")"
echo 'null' > "$D/out/dependencias-$HOY.json"
node "$RES" build --source dependencies --today "$HOY" --out "$D/out" --pending "$D/pend" --config "$D/repos.json" --summary-config "$D/resumen.json" --watcher-out "$D/vig" > "$D/c.txt" 2>&1; RC=$?
[ "$RC" = 1 ] && grep -q 'no es un objeto' "$D/c.txt" && ok "T1c snapshot que es el JSON null: armar sale 1 y dice «no es un objeto»" || no "T1c snapshot null: rc=$RC · $(head -c 200 "$D/c.txt")"

# T1d una ficha que no se puede leer es un FALLO dicho, no una caída del resumen entero
D="$TMP/t1d"; mundo "$D"; snap "$D" "$HOY" '{}'
ficha "$D" pending aaa11111 "$HOY" pendiente A/A
mkdir -p "$D/pend/pending/rota.yaml"      # un directorio con nombre de ficha: leerlo tira EISDIR (vale también como root)
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"; RC=$?
[ "$RC" = 0 ] && [ "$(q "$D/a.json" 'j.fallos.some(f => /no se pudo leer la ficha/.test(f) && /rota\.yaml/.test(f)) && j.rubros.vivas_por_proyecto.de === 1')" = true ] \
  && ok "T1d una ficha ilegible entra en fallos con su nombre y el resto del resumen se arma igual" || no "T1d ficha ilegible: rc=$RC · $(head -c 300 "$D/a.err") · $(q "$D/a.json" 'j.fallos')"

# T1e la carpeta de fichas entera no se puede leer: los rubros de fichas son null con motivo
D="$TMP/t1e"; mundo "$D"; snap "$D" "$HOY" '{}'
node "$RES" build --source dependencies --today "$HOY" --out "$D/out" --pending "$D/no-existe" --config "$D/repos.json" --summary-config "$D/resumen.json" --watcher-out "$D/vig" --json > "$D/a.json" 2> "$D/a.err"; RC=$?
[ "$RC" = 0 ] && [ "$(q "$D/a.json" '["vivas_por_proyecto","edad_mas_vieja","aceptadas_sin_resolver"].every(k => j.rubros[k].valor === null && /no se pudieron leer las fichas/.test(j.rubros[k].motivo)) && j.fallos.some(f => /no se pudieron leer las fichas en/.test(f))')" = true ] \
  && ok "T1e sin carpeta de fichas legible: los tres rubros de fichas salen null con motivo y el fallo lo dice (nunca 0 vivas)" || no "T1e carpeta de fichas: rc=$RC · $(head -c 200 "$D/a.err") · $(q "$D/a.json" 'j.fallos')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T2 armar_sobre_la_foto_del_09_14 — la forma de esa noche, fabricada: tres hallazgos vivos, ninguno anunciado
# ni postergado, cinco fichas (una pendiente, cuatro aceptadas de las que dos ya se resolvieron).
# La foto se fabrica con la forma y los números de una noche real, de antes de que existieran `pedidos`, `cruce` y
# `resumen` (el snapshot real es dato del equipo y no viaja).
D="$TMP/t2"; mundo "$D"
snap "$D" 2026-09-14 '{"hallazgos":[{"id":"ea4e7794","paquete":"pkg-ea4e7794","severidad":"high","repos":["A/A"]},{"id":"3788493d","paquete":"pkg-3788493d","severidad":"high","repos":["A/A"]},{"id":"94dbbf29","paquete":"pkg-94dbbf29","severidad":"high","repos":["B/B"]}]}'
ficha "$D" pending ea4e7794 2026-09-10 pendiente A/A "pr: 3093"
ficha "$D" promoted 3788493d 2026-09-09 util A/A
ficha "$D" promoted 94dbbf29 2026-09-09 util B/B
ficha "$D" promoted d7b4a316 2026-09-10 util B/B "resuelto: 2026-09-11"
ficha "$D" promoted f7aa0f9c 2026-09-03 util B/B 'resuelto: "2026-09-05"'
armar "$D" dependencias 2026-09-14 > "$D/a.json" 2> "$D/a.err"
R=$(q "$D/a.json" '[j.rubros.nuevos.valor.length, j.rubros.postergadas_por_presupuesto.valor.hallazgos.length, j.rubros.aceptadas_sin_resolver.valor.map(x => x.id).sort().join("+"), j.rubros.aceptadas_sin_resolver.de, j.rubros.edad_mas_vieja.valor, j.rubros.vivas_por_proyecto.de, JSON.stringify(j.rubros.rechazadas_sin_deuda.valor)].join("|")')
[ "$R" = "0|0|3788493d+94dbbf29|4|5|3|[]" ] && ok "T2 la foto del 09-14: nuevos 0 · postergadas 0 · aceptadas 2 de 4 · edad 5 · vivas 3 · rechazadas lista vacía" \
  || no "T2 la foto del 09-14: esperaba [0|0|3788493d+94dbbf29|4|5|3|[]], obtuve [$R] ($(head -c 300 "$D/a.err"))"
[ "$(q "$D/a.json" '[j.rubros.deuda_con_pedido_abierto, j.rubros.proyectos_sin_iteracion].every(r => r.valor === null && /el snapshot no trae `pedidos`/.test(r.motivo || ""))')" = true ] \
  && ok "T2 esa noche corrió antes de la 4.4: los rubros de pedidos salen null con «el snapshot no trae \`pedidos\`»" \
  || no "T2 rubros de pedidos: $(q "$D/a.json" '[j.rubros.deuda_con_pedido_abierto, j.rubros.proyectos_sin_iteracion]')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T3 rubro_sin_fuente_es_null_con_motivo
D="$TMP/t3"; mundo "$D"
snap "$D" "$HOY" '{"rechazadas_sin_deuda_ids":["zzz99999"]}'
ficha "$D" pending zzz99999 "$HOY" pendiente A/A "rechazado: $HOY"
echo '{ "rubros_sin_fuente": { "rechazadas_sin_deuda": "la story 9.9 escribe la clave nueva" } }' > "$D/resumen.json"
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.rubros.rechazadas_sin_deuda.valor === null && j.rubros.rechazadas_sin_deuda.motivo.includes("la story 9.9 escribe la clave nueva")')" = true ] \
  && ok "T3 un rubro declarado sin fuente sale null con ESE motivo, aunque el snapshot traiga el dato" || no "T3 declarado: $(q "$D/a.json" 'j.rubros.rechazadas_sin_deuda')"
# el texto lo marca «?» sin el motivo (el motivo puede nombrar un repo); el motivo queda en el rubro
[ "$(q "$D/a.json" '/^• rechazadas sin deuda: \?$/m.test(j.texto) && !j.texto.includes("la story 9.9")')" = true ] \
  && ok "T3 el texto lo marca «rechazadas sin deuda: ?», sin el motivo" || no "T3 el texto no dice «?» o trae el motivo: $(q "$D/a.json" 'j.texto')"
echo '{ "rubros_sin_fuente": {} }' > "$D/resumen.json"
snap "$D" "$HOY" '{"rechazadas_sin_deuda_ids":"__BORRAR__"}'
armar "$D" dependencias "$HOY" > "$D/b.json" 2>/dev/null
[ "$(q "$D/b.json" 'j.rubros.rechazadas_sin_deuda.valor === null && /el snapshot no trae `rechazadas_sin_deuda_ids`/.test(j.rubros.rechazadas_sin_deuda.motivo || "")')" = true ] \
  && ok "T3 sin la entrada y sin la clave en el snapshot: null con el motivo mecánico, nunca 0" || no "T3 mecánico rechazadas: $(q "$D/b.json" 'j.rubros.rechazadas_sin_deuda')"
[ "$(q "$D/b.json" '["deuda_con_pedido_abierto","proyectos_sin_iteracion"].every(k => j.rubros[k].valor === null && /el snapshot no trae `pedidos`/.test(j.rubros[k].motivo || ""))')" = true ] \
  && ok "T3 snapshot sin \`pedidos\`: los dos rubros de pedidos salen null con su motivo" || no "T3 pedidos ausente: $(q "$D/b.json" '[j.rubros.deuda_con_pedido_abierto, j.rubros.proyectos_sin_iteracion]')"
# (una edad de 0 días es una MEDICIÓN, no una ausencia: lo que se exige es que todo rubro con motivo sea null)
[ "$(q "$D/b.json" 'Object.values(j.rubros).filter(r => r.motivo).length >= 3 && Object.values(j.rubros).filter(r => r.motivo).every(r => r.valor === null)')" = true ] \
  && ok "T3 todo rubro que trae motivo de ausencia es null: ninguno sin fuente se convierte en 0" || no "T3 un rubro con motivo de ausencia tiene valor: $(q "$D/b.json" 'Object.entries(j.rubros).filter(([k, r]) => r.motivo)')"
snap "$D" "$HOY" '{"pedidos":{"simulado":true,"tope":2,"fichas_vivas":1,"fichas_sin_pedido":1,"creados":[],"adoptados":[],"existentes":0,"fallidos":[],"postergados":[],"sin_iteracion":[{"proyecto":"ProyA","motivo":"la iteración terminó"}],"sin_dueno_unico":[],"pagados_avisados":[],"deuda_avisada":[{"ficha":"zzz99999","proyecto":"ProyA","id":null,"vence":"2026-10-01"}],"sin_pedido":[]}}'
armar "$D" dependencias "$HOY" > "$D/c.json" 2>/dev/null
[ "$(q "$D/c.json" 'j.rubros.proyectos_sin_iteracion.valor.length === 1 && j.rubros.deuda_con_pedido_abierto.valor.length === 1')" = true ] \
  && ok "T3 con \`pedidos\` los rubros se miden de la sección (sin_iteracion, deuda_avisada)" || no "T3 pedidos presentes: $(q "$D/c.json" '[j.rubros.deuda_con_pedido_abierto, j.rubros.proyectos_sin_iteracion]')"
[ "$(q "$D/c.json" 'j.texto.split("\n").filter(l => /iteración|deuda con pedido/.test(l)).every(l => l.includes("(simulado)"))')" = true ] \
  && grep -q '(simulado)' <<<"$(q "$D/c.json" 'j.texto')" \
  && ok "T3 con pedidos.simulado los rubros de pedidos llevan «(simulado)»" || no "T3 falta «(simulado)»: $(q "$D/c.json" 'j.texto')"
[ "$(q "$RAIZ/scripts/nightly/dependencies/summary.json" 'Object.keys(j.rubros_sin_fuente).length')" = 0 ] \
  && ok "T3 el summary.json commiteado nace con rubros_sin_fuente vacío (las fuentes de 4.2 y 4.4 ya existen)" \
  || no "T3 el summary.json commiteado no está vacío o no existe: $(q "$RAIZ/scripts/nightly/dependencies/summary.json" 'j.rubros_sin_fuente')"


# T3b `rubros_sin_fuente` vale también para los rubros del vigilante
D="$TMP/t3b"; mundo "$D"; vsnap "$D" "$HOY" '{}'
vficha "$D" pending 2026-09-05-globex-cccc3333 2026-09-05 pendiente
echo '{ "rubros_sin_fuente": { "pendientes": "la story 9.9 trae la fuente de pendientes" } }' > "$D/resumen.json"
armar "$D" vigilante "$HOY" --summary-config "$D/resumen.json" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.rubros.pendientes.valor === null && /la story 9\.9 trae la fuente de pendientes/.test(j.rubros.pendientes.motivo || "") && /pendientes: \?/.test(j.texto) && !/story 9\.9/.test(j.texto)')" = true ] \
  && ok "T3b un rubro del vigilante declarado sin fuente sale null con su motivo y el texto lo marca «?» sin el motivo" || no "T3b vigilante sin fuente: $(q "$D/a.json" '[j.rubros && j.rubros.pendientes, j.texto]')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T4 cambio_desde_ayer_arriba
D="$TMP/t4"; mundo "$D"
snap "$D" "$AYER" '{}'
ficha "$D" promoted ccc33333 "$(fecha "$HOY" -4)" util A/A
sellar "$D" "$AYER"
snap "$D" "$HOY" '{"hallazgos":[{"id":"ddd44444","paquete":"lodash","severidad":"high","repos":["B/B"],"noches":1}],"anunciados_hoy":["ddd44444"]}'
ficha "$D" pending ddd44444 "$HOY" pendiente B/B
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'Array.isArray(j.cambios) && j.cambios.includes("nuevos") && j.cambios.includes("vivas_por_proyecto") && !j.cambios.includes("aceptadas_sin_resolver")')" = true ] \
  && ok "T4 cambios lista los rubros que cambiaron (nuevos, vivas) y no los que siguen igual" || no "T4 cambios: $(q "$D/a.json" 'j.cambios')"
[ "$(q "$D/a.json" '(() => { const t = j.texto, a = t.indexOf("Cambió desde ayer"), b = t.indexOf("Sigue igual ("); return a > 0 && b > a && t.split("\n")[0].length <= 120; })()')" = true ] \
  && ok "T4 «Cambió desde ayer» va arriba, después del veredicto (≤120) y antes de «Sigue igual (N rubros)»" || no "T4 orden del texto: $(q "$D/a.json" 'j.texto')"
D="$TMP/t4-sin-ayer"; mundo "$D"; snap "$D" "$HOY" '{}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.cambios === null && /sin ayer con qué comparar/.test(j.cambios_motivo || "") && /sin ayer con qué comparar/.test(j.texto)')" = true ] \
  && ok "T4 sin ayer con resumen: cambios null con motivo y el texto es la foto completa, rotulada" || no "T4 sin ayer: $(q "$D/a.json" '[j.cambios, j.cambios_motivo, j.texto]')"

# T4b mismo_conteo_distintos_ids_es_cambio
D="$TMP/t4b"; mundo "$D"
snap "$D" "$AYER" '{}'
ficha "$D" pending p1111111 "$AYER" pendiente A/A; ficha "$D" pending p2222222 "$AYER" pendiente A/A
sellar "$D" "$AYER"
rm -f "$D/pend/pending/"*.yaml
ficha "$D" pending p3333333 "$HOY" pendiente A/A; ficha "$D" pending p4444444 "$HOY" pendiente A/A
snap "$D" "$HOY" '{}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.rubros.vivas_por_proyecto.de === 2 && Array.isArray(j.cambios) && j.cambios.includes("vivas_por_proyecto")')" = true ] \
  && ok "T4b dos fichas nuevas que reemplazan a dos resueltas: el número no cambia y el rubro SÍ está en cambios" || no "T4b comparación por conteo: $(q "$D/a.json" '[j.rubros.vivas_por_proyecto, j.cambios]')"

# T4c null_contra_numero_es_cambio
D="$TMP/t4c"; mundo "$D"
snap "$D" "$AYER" '{"hallazgos":[{"id":"bbb22222","paquete":"handlebars","severidad":"critical","repos":["B/B"],"noches":3}],"postergados_por_presupuesto":["bbb22222"]}'
sellar "$D" "$AYER"
snap "$D" "$HOY" '{"postergados_por_presupuesto":"__BORRAR__"}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.rubros.postergadas_por_presupuesto.valor === null && Array.isArray(j.cambios) && j.cambios.includes("postergadas_por_presupuesto") && /pasó a no medido/.test(j.texto)')" = true ] \
  && ok "T4c un número de ayer contra un null de hoy es cambio y se dice «pasó a no medido»" || no "T4c null contra número: $(q "$D/a.json" '[j.rubros.postergadas_por_presupuesto, j.cambios, j.texto]')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T5 sin_cambios_son_tres_lineas_y_se_manda — con la edad creciendo un día (no es cambio)
D="$TMP/t5"; mundo "$D"
PEDIDOS_OK='{"pedidos":{"simulado":false,"tope":2,"fichas_vivas":1,"fichas_sin_pedido":0,"creados":[],"adoptados":[],"existentes":1,"fallidos":[],"postergados":[],"sin_iteracion":[],"sin_dueno_unico":[],"pagados_avisados":[],"deuda_avisada":[],"sin_pedido":[]}}'
snap "$D" "$AYER" "$PEDIDOS_OK"; snap "$D" "$HOY" "$PEDIDOS_OK"
ficha "$D" pending eee55555 "$(fecha "$HOY" -6)" pendiente A/A
ficha "$D" promoted fff66666 "$(fecha "$HOY" -9)" util B/B
sellar "$D" "$AYER"
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'JSON.stringify(j.cambios) + "|" + j.fallos.length + "|" + j.texto.split("\n").length')" = '[]|0|3' ] \
  && ok "T5 ayer = hoy y sin fallos: cero cambios (la edad que crece no cuenta) y el texto son tres líneas" || no "T5: $(q "$D/a.json" '[j.cambios, j.fallos, j.texto]')"
[ "$(q "$D/a.json" 'j.texto.split("\n")[0].startsWith("Sin cambios desde ayer · 2 vivas · 1 aceptadas sin resolver · 0 postergadas") && j.texto.split("\n")[1] === "Sigue igual (14 rubros)"')" = true ] \
  && ok "T5 primera línea «Sin cambios desde ayer · …» y segunda «Sigue igual (14 rubros)»" || no "T5 forma: $(q "$D/a.json" 'j.texto')"
reset_srv ok:501; RC=$(entregar "$D" dependencias "$HOY")
[ "$RC" = 0 ] && [ "$(pedidos)" = 1 ] && ok "T5 la noche sin cambios SE ENTREGA igual (un POST, sale 0): el silencio no es un canal" || no "T5 entrega sin cambios: rc=$RC pedidos=$(pedidos) · $(cat "$D/entregar.txt")"

# T5b (forma) el_tope_de_telegram — muchas fichas no rompen el mensaje
D="$TMP/t5b"; mundo "$D"
HALL=$(node -e 'const a=[];for(let i=0;i<60;i++)a.push({id:"n"+String(i).padStart(7,"0"),paquete:"paquete-con-nombre-largo-"+i,severidad:"high",repos:["A/A"],noches:1});console.log(JSON.stringify(a))')
snap "$D" "$HOY" "{\"hallazgos\":$HALL,\"anunciados_hoy\":$(node -e 'console.log(JSON.stringify(Array.from({length:60},(_, i)=>"n"+String(i).padStart(7,"0"))))'),\"postergados_por_presupuesto\":$(node -e 'console.log(JSON.stringify(Array.from({length:40},(_, i)=>"n"+String(i).padStart(7,"0"))))')}"
for i in $(seq 0 59); do ficha "$D" pending "n$(printf '%07d' "$i")" "$HOY" pendiente A/A; done
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.texto.split("\n").length <= 23 && j.texto.length <= 2000 && /^• nuevos: 60$/m.test(j.texto) && !/paquete-con-nombre-largo|n0000/.test(j.texto)')" = true ] \
  && ok "T5b 60 hallazgos: la sección de dependencias cabe en su presupuesto (≤23 líneas, ≤2000 caracteres) y los cuenta sin listarlos" \
  || no "T5b tope: $(q "$D/a.json" 'j.texto.split("\n").length + " líneas, " + j.texto.length + " caracteres"')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T6 fallos_siempre_arriba
D="$TMP/t6"; mundo "$D"
snap "$D" "$AYER" '{}'
sellar "$D" "$AYER" null "⚠ telegram-notify: no hay token (ni \$TELEGRAM_BOT_TOKEN ni /x/.env) — NO se mandó el aviso."
snap "$D" "$HOY" '{"corrida_completa":false,"no_medidos":[{"ruta":"B/B","motivo":"el restore falló"}]}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.fallos.length === 3 && j.fallos.some(f => /B\/B/.test(f) && /el restore falló/.test(f)) && j.fallos.some(f => /incompleta/.test(f)) && j.fallos.some(f => /no se entregó/.test(f) && /no hay token/.test(f))')" = true ] \
  && ok "T6 fallos: el repo no medido con su motivo, la ejecución incompleta y el resumen de ayer que no se entregó" || no "T6 fallos: $(q "$D/a.json" 'j.fallos')"
[ "$(q "$D/a.json" '(() => { const t = j.texto, a = t.indexOf("fallos: " + j.fallos.length), b = t.indexOf("Sigue igual ("); return j.fallos.length > 0 && a > 0 && (b === -1 || a < b) && !t.includes("el restore falló"); })()')" = true ] \
  && ok "T6 los fallos van en el texto antes de «Sigue igual», como cantidad («fallos: N»), sin el detalle" || no "T6 lugar de los fallos: $(q "$D/a.json" 'j.texto')"
[ "$(q "$D/a.json" 'j.fallos.some(f => /pull request/i.test(f))')" = false ] \
  && ok "T6 ninguna línea fija sobre los pull requests en fallos" || no "T6 apareció una línea fija de PR: $(q "$D/a.json" 'j.fallos')"
snap "$D" "$HOY" '{"pedidos":{"simulado":false,"tope":2,"fichas_vivas":1,"fichas_sin_pedido":1,"creados":[],"adoptados":[],"existentes":0,"fallidos":[{"ficha":"a1","proyecto":"ProyA","paso":"crear","motivo":"TF401027 sin permiso"},{"ficha":"a1","proyecto":"ProyA","paso":"comentario","motivo":"otro"}],"postergados":[],"sin_iteracion":[],"sin_dueno_unico":[{"proyecto":"ProyA","motivo":"tres administradores"}],"pagados_avisados":[],"deuda_avisada":[],"sin_pedido":[]}}'
armar "$D" dependencias "$HOY" > "$D/b.json" 2>/dev/null
[ "$(q "$D/b.json" 'j.fallos.some(f => /pedidos/.test(f) && /TF401027/.test(f)) && j.fallos.some(f => /dueño único/.test(f) && /tres administradores/.test(f))')" = true ] \
  && ok "T6 con \`pedidos\`: sus fallidos y los proyectos sin dueño único entran en fallos" || no "T6 fallos de pedidos: $(q "$D/b.json" 'j.fallos')"


# T6b una CADENA de noches sin entregar queda escrita entera en el primer resumen que llega —
# también la noche que no dejó constancia (sin la clave) y la que dejó `resumen: null`
D="$TMP/t6b"; mundo "$D"
H3=$(fecha "$HOY" -3); H2=$(fecha "$HOY" -2); H1=$(fecha "$HOY" -1)
snap "$D" "$H3" '{}'; sellar "$D" "$H3"
snap "$D" "$H2" '{}'; sellar "$D" "$H2" null "MOTIVO-X de la noche fallida"
snap "$D" "$H1" '{}'
snap "$D" "$HOY" '{}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.fallos.some(f => f.includes("el resumen del '"$H1"' no consta como entregado")) && j.fallos.some(f => f.includes("el resumen del '"$H2"' no se entregó: MOTIVO-X")) && !j.fallos.some(f => f.includes("'"$H3"'"))')" = true ] \
  && ok "T6b dos noches seguidas sin entregar (una sin constancia) quedan escritas, y la anterior entregada no" || no "T6b cadena de fallas: $(q "$D/a.json" 'j.fallos')"
constancia "$D/out/dependencias-$H1.json" null
armar "$D" dependencias "$HOY" > "$D/b.json" 2>/dev/null
[ "$(q "$D/b.json" 'j.fallos.some(f => f.includes("el resumen del '"$H1"' no se entregó: sin motivo escrito"))')" = true ] \
  && ok "T6b una noche con \`resumen: null\` cuenta como no entregada (la misma lectura que el aviso del arranque)" || no "T6b resumen null: $(q "$D/b.json" 'j.fallos')"
# T6c los snapshots de noches sin constancia de entrega (anteriores a la pieza) NO son una cadena de fallas
D="$TMP/t6c"; mundo "$D"
snap "$D" "$(fecha "$HOY" -2)" '{}'; snap "$D" "$(fecha "$HOY" -1)" '{}'; snap "$D" "$HOY" '{}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.fallos.some(f => /resumen del/.test(f))')" = false ] \
  && ok "T6c sin ninguna noche anterior con constancia (antes del estreno) no se inventan resúmenes no entregados" || no "T6c falsos fallos de antes del estreno: $(q "$D/a.json" 'j.fallos')"
# T6d la misma cadena para el vigilante
D="$TMP/t6d"; mundo "$D"
vsnap "$D" "$(fecha "$HOY" -2)" '{}'; constancia "$D/vig/vigilante-$(fecha "$HOY" -2).json" '{"canal":"telegram","message_id":9,"editado":true,"entregado_el":"2000-01-01T08:00:00Z","motivo":null,"rubros":{}}'
vsnap "$D" "$(fecha "$HOY" -1)" '{}'
vsnap "$D" "$HOY" '{}'
armar "$D" vigilante "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.fallos.some(f => f.includes("el resumen del '"$(fecha "$HOY" -1)"' no consta como entregado"))')" = true ] \
  && ok "T6d el vigilante también cobra la noche anterior que no dejó constancia" || no "T6d vigilante: $(q "$D/a.json" 'j.fallos')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T7 vigilante_viejo_entra_en_fallos
D="$TMP/t7"; mundo "$D"; snap "$D" "$HOY" '{}'
vsnap "$D" "$(fecha "$HOY" -2)" '{}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.fallos.some(f => f.includes("vigilante: último snapshot del '"$(fecha "$HOY" -2)"' (hace 2 días)"))')" = true ] \
  && ok "T7 el vigilante sin snapshot desde hace 2 días entra en los fallos de dependencias" || no "T7 vigilante viejo: $(q "$D/a.json" 'j.fallos')"
vsnap "$D" "$(fecha "$HOY" -1)" '{}'
armar "$D" dependencias "$HOY" > "$D/b.json" 2>/dev/null
[ "$(q "$D/b.json" 'j.fallos.some(f => /vigilante/.test(f))')" = false ] \
  && ok "T7 con el snapshot del vigilante de ayer (corre a las 08:00, después) no hay fallo" || no "T7 falso fallo del vigilante: $(q "$D/b.json" 'j.fallos')"
D="$TMP/t7-nunca"; mundo "$D"; snap "$D" "$HOY" '{}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.fallos.some(f => /vigilante/.test(f))')" = false ] \
  && ok "T7 sin ningún snapshot del vigilante (no se estrenó): silencio sobre el vigilante" || no "T7 habló de un vigilante que nunca corrió: $(q "$D/a.json" 'j.fallos')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T8 armar_vigilante_cinco_rubros
D="$TMP/t8"; mundo "$D"
vsnap "$D" "$HOY" '{"hallazgos":[{"id":"'"$HOY"'-acme-aaaa0001","regla":"latido","producto":"acme","huella":"aaaa0001","severidad":"media","plugin":"x","endpoint":null}],"nuevos":1,"no_medido":["globex: timeout"],"marcados_ignorados":1,"ignorados_ids":["2026-09-01-initech-eeee5555"]}'
vficha "$D" promoted 2026-09-01-acme-aaaa1111 2026-09-01 util 'story_creada: "specs/story-9.9.md"'
vficha "$D" promoted 2026-09-02-globex-bbbb2222 2026-09-02 util
vficha "$D" pending 2026-09-05-globex-cccc3333 2026-09-05 pendiente
vficha "$D" pending "$HOY-acme-aaaa0001" "$HOY" pendiente
armar "$D" vigilante "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" 'Object.keys(j.rubros).sort().join(",")')" = "aceptadas_sin_story,ignoradas_hoy,no_medido,nuevos,pendientes" ] \
  && ok "T8 build --source vigilante devuelve los cinco rubros" || no "T8 rubros del vigilante: $(q "$D/a.json" 'Object.keys(j.rubros||{})') ($(head -c 300 "$D/a.err"))"
[ "$(q "$D/a.json" 'j.rubros.aceptadas_sin_story.valor.map(x => x.id + ":" + x.dias).join(",")')" = "2026-09-02-globex-bbbb2222:18" ] \
  && ok "T8 aceptadas sin story: sólo la que no tiene story_creada, con su edad" || no "T8 aceptadas sin story: $(q "$D/a.json" 'j.rubros.aceptadas_sin_story')"
[ "$(q "$D/a.json" 'j.rubros.pendientes.valor.length + "|" + j.rubros.pendientes.edad_mas_vieja')" = "2|15" ] \
  && ok "T8 pendientes con la edad del más viejo" || no "T8 pendientes: $(q "$D/a.json" 'j.rubros.pendientes')"
[ "$(q "$D/a.json" 'j.rubros.nuevos.valor.map(x => [x.id, x.producto, x.regla, x.severidad].join(":")).join(",") + "|" + j.rubros.ignoradas_hoy.valor.join(",") + "|" + j.rubros.no_medido.valor.join(",")')" = "$HOY-acme-aaaa0001:acme:latido:media|2026-09-01-initech-eeee5555|globex: timeout" ] \
  && ok "T8 nuevos (de la lista hallazgos), ignoradas hoy (ignorados_ids) y no medido (tal cual)" || no "T8 nuevos/ignoradas/no_medido: $(q "$D/a.json" '[j.rubros.nuevos, j.rubros.ignoradas_hoy, j.rubros.no_medido]')"
T8TXT=$(q "$D/a.json" 'j.texto')
case "$T8TXT" in "🌙 vigilante"*) ok "T8 el texto del vigilante empieza con su veredicto «🌙 vigilante · …»" ;; *) no "T8 el texto del vigilante no empieza con «🌙 vigilante»: $T8TXT" ;; esac
case "$T8TXT" in "🌙 vigilante"*) if grep -q 'DATO-DE-CLIENTE-QUE-NO-DEBE-SALIR' <<<"$T8TXT"; then no "T8 🔴 el diagnóstico del borrador (dato de cliente) entró al texto"; else ok "T8 el diagnóstico del borrador NO entra al texto"; fi ;; *) no "T8 no hay texto del vigilante sobre el que mirar el diagnóstico" ;; esac
vsnap "$D" "$HOY" '{"hallazgos":"__BORRAR__","ignorados_ids":"__BORRAR__"}'
armar "$D" vigilante "$HOY" > "$D/b.json" 2>/dev/null
[ "$(q "$D/b.json" 'j.rubros.nuevos.valor === null && /el snapshot no trae `hallazgos`/.test(j.rubros.nuevos.motivo || "") && j.rubros.ignoradas_hoy.valor === null')" = true ] \
  && ok "T8 un snapshot del vigilante sin sus listas: null con motivo, no cero" || no "T8 listas ausentes: $(q "$D/b.json" '[j.rubros.nuevos, j.rubros.ignoradas_hoy]')"


# T8b `story_creada` vacía —null, ~, "" o null con comentario— NO es una story
D="$TMP/t8b"; mundo "$D"; vsnap "$D" "$HOY" '{}'
vficha "$D" promoted 2026-09-01-acme-dddd0001 2026-09-01 util 'story_creada: null'
vficha "$D" promoted 2026-09-01-acme-dddd0002 2026-09-01 util 'story_creada: ~'
vficha "$D" promoted 2026-09-01-acme-dddd0003 2026-09-01 util 'story_creada: ""'
vficha "$D" promoted 2026-09-01-acme-dddd0004 2026-09-01 util 'story_creada: null  # todavía no creada'
vficha "$D" promoted 2026-09-01-acme-dddd0005 2026-09-01 util 'story_creada: "specs/story-9.9.md"'
armar "$D" vigilante "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.rubros.aceptadas_sin_story.valor.map(x => x.id.slice(-4)).sort().join(",")')" = "0001,0002,0003,0004" ] \
  && ok "T8b una story_creada vacía (null, ~, \"\", null con comentario) sigue contando como aceptada sin story" || no "T8b story_creada vacía: $(q "$D/a.json" 'j.rubros.aceptadas_sin_story')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T9 approve_nombra_la_clave — NO VIAJA al público: mira el comando del vigilante (`commands/tycon-vigilante.md`),
# que es del repo del equipo. El vigilante de producción no se publica; el caso sigue en el repo privado.

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T10 entregar_manda_y_guarda_message_id
D="$TMP/t10"; mundo "$D"
snap "$D" "$HOY" '{"hallazgos":[{"id":"aaa11111","paquete":"browserslist","severidad":"high","repos":["A/A"],"noches":1}],"anunciados_hoy":["aaa11111"]}'
ficha "$D" pending aaa11111 "$HOY" pendiente A/A
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
cp "$D/out/dependencias-$HOY.json" "$D/antes.json"
reset_srv ok:777; RC=$(entregar "$D" dependencias "$HOY")
[ "$RC" = 0 ] && ok "T10 entregar sale 0 cuando Telegram acepta" || no "T10 rc=$RC · $(cat "$D/entregar.txt")"
[ "$(pedidos)" = 1 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] && [ "$(ultimo 'j.token_ok')" = true ] \
  && ok "T10 un solo POST a sendMessage con el token del canal" || no "T10 pedidos=$(pedidos) ruta=$(ultimo 'j.ruta')"
[ "$(pedidos)" = 1 ] && [ "$(q "$D/a.json" 'typeof j.texto === "string" && j.texto.length > 0')" = true ] && [ "$(ultimo 'j.text')" = "$(q "$D/a.json" 'j.texto')"$'\n'"sitio: sin configurar" ] && ok "T10 el texto mandado es el de armar más la línea del sitio" || no "T10 el texto mandado difiere del de armar"
[ "$(q "$D/out/dependencias-$HOY.json" 'JSON.stringify([j.resumen.canal, j.resumen.message_id, j.resumen.editado, j.resumen.motivo, typeof j.resumen.entregado_el])')" = '["telegram",777,null,null,"string"]' ] \
  && ok "T10 el snapshot guarda resumen {canal, message_id 777, editado null, motivo null, entregado_el}" || no "T10 resumen: $(q "$D/out/dependencias-$HOY.json" 'j.resumen')"
if grep -q 'tok-de-prueba-que-no-debe-aparecer\|990011223344' "$D/entregar.txt" "$D/out/dependencias-$HOY.json"; then
  no "T10 🔴 el token o el chat_id aparecen en la salida o en el snapshot"
else ok "T10 ni el token ni el chat_id aparecen en la salida ni en el snapshot"; fi

# T10b (--dry-run) no manda, no escribe, no muestra el destinatario
D="$TMP/t10b"; mundo "$D"; snap "$D" "$HOY" '{}'
cp "$D/out/dependencias-$HOY.json" "$D/antes.json"
reset_srv ok:1; RC=$(entregar "$D" dependencias "$HOY" --dry-run)
[ "$RC" = 0 ] && [ "$(pedidos)" = 0 ] && cmp -s "$D/antes.json" "$D/out/dependencias-$HOY.json" && ! grep -q '990011223344' "$D/entregar.txt" \
  && ok "T10b --dry-run: cero POST, el snapshot intacto y sin el chat_id en la salida" || no "T10b dry-run: rc=$RC pedidos=$(pedidos) · $(head -c 400 "$D/entregar.txt")"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T11 vigilante_edita_el_mensaje_del_dia
D="$TMP/t11"; mundo "$D"
snap "$D" "$HOY" '{}'; ficha "$D" pending aaa11111 "$HOY" pendiente A/A
reset_srv ok:777; entregar "$D" dependencias "$HOY" >/dev/null
DEPS_L1=$(q "$D/out/dependencias-$HOY.json" 'j.resumen && j.resumen.message_id')
DEPS_TXT_L1=$(tail -1 "$TMP/pedidos.jsonl" > "$TMP/p.json"; q "$TMP/p.json" 'j.text.split("\n")[0]')
vsnap "$D" "$HOY" '{}'; vficha "$D" pending 2026-09-05-globex-cccc3333 2026-09-05 pendiente
reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY")
[ "$DEPS_L1" = 777 ] && [ "$RC" = 0 ] && [ "$(pedidos)" = 1 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/editMessageText" ] && [ "$(ultimo 'j.message_id')" = 777 ] \
  && ok "T11 el vigilante EDITA el mensaje de dependencias de hoy (editMessageText, message_id 777), no manda otro" \
  || no "T11 edición: deps_mid=$DEPS_L1 rc=$RC pedidos=$(pedidos) ruta=$(ultimo 'j.ruta') mid=$(ultimo 'j.message_id') · $(cat "$D/entregar.txt")"
[ "$(ultimo 'j.text.split("\n")[0]')" = "$DEPS_TXT_L1" ] && grep -q '🌙 vigilante' <<<"$(ultimo 'j.text')" \
  && ok "T11 el texto editado es el de dependencias (reconstruido de sus rubros) más la sección del vigilante" || no "T11 texto editado: $(ultimo 'j.text')"
[ "$(q "$D/vig/vigilante-$HOY.json" 'JSON.stringify([j.resumen.canal, j.resumen.message_id, j.resumen.editado])')" = '["telegram",777,true]' ] \
  && ok "T11 vigilante-<hoy>.json guarda resumen con editado: true" || no "T11 resumen del vigilante: $(q "$D/vig/vigilante-$HOY.json" 'j.resumen')"
[ "$(ultimo 'j.text.split("\n").length <= 40 && j.text.length <= 3500')" = true ] \
  && ok "T11 el mensaje combinado respeta el tope (≤40 líneas, ≤3500 caracteres)" || no "T11 mensaje combinado fuera de tope"

# T11b sin_mensaje_de_dependencias_manda_nuevo
D="$TMP/t11b"; mundo "$D"
snap "$D" "$HOY" '{}'; sellar "$D" "$HOY" null "⚠ telegram-notify: no hay token — NO se mandó el aviso."
vsnap "$D" "$HOY" '{}'
reset_srv ok:888; RC=$(entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] && [ "$(ultimo 'j.text.split("\n")[0]')" = "⚠️ dependencias no entregó su resumen hoy: no se entregó" ] && ! grep -q 'no hay token' <<<"$(ultimo 'j.text')" \
  && ok "T11b dependencias no entregó: el vigilante manda uno NUEVO que lo dice en la primera línea, sin el motivo libre" || no "T11b: rc=$RC ruta=$(ultimo 'j.ruta') · $(ultimo 'j.text')"
[ "$(q "$D/vig/vigilante-$HOY.json" 'j.resumen.editado')" = false ] && ok "T11b editado: false" || no "T11b editado: $(q "$D/vig/vigilante-$HOY.json" 'j.resumen')"
rm -f "$D/out/dependencias-$HOY.json"; vsnap "$D" "$HOY" '{}'
reset_srv ok:889; RC=$(entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] && grep -q 'dependencias no entregó su resumen hoy' <<<"$(ultimo 'j.text')" \
  && ok "T11b sin snapshot de dependencias de hoy: también mensaje nuevo que lo dice" || no "T11b sin snapshot: rc=$RC · $(cat "$D/entregar.txt")"

# T11c la edición rechazada por Telegram cae a un mensaje nuevo, y lo dice
D="$TMP/t11c"; mundo "$D"
snap "$D" "$HOY" '{}'; sellar "$D" "$HOY" 555
vsnap "$D" "$HOY" '{}'
reset_srv "$(printf 'rechaza:Bad Request: message to edit not found\nok:556')"
RC=$(entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && grep -q '/editMessageText' "$TMP/pedidos.jsonl" && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] && [ "$(q "$D/vig/vigilante-$HOY.json" 'j.resumen.editado + "|" + j.resumen.message_id')" = "false|556" ] \
  && ok "T11c mensaje que ya no se puede editar: cae a uno nuevo (editado false) en vez de reintentar la edición" \
  || no "T11c: rc=$RC · $(head -c 400 "$TMP/pedidos.jsonl") · $(q "$D/vig/vigilante-$HOY.json" 'j.resumen')"

# T11d «message is not modified» es entregado (el texto ya estaba)
D="$TMP/t11d"; mundo "$D"
snap "$D" "$HOY" '{}'; sellar "$D" "$HOY" 555
vsnap "$D" "$HOY" '{}'
reset_srv "rechaza:Bad Request: message is not modified: specified new message content and reply markup are exactly the same"
RC=$(entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && [ "$(pedidos)" = 1 ] && [ "$(q "$D/vig/vigilante-$HOY.json" 'j.resumen.editado + "|" + j.resumen.message_id + "|" + j.resumen.motivo')" = "true|555|null" ] \
  && ok "T11d «message is not modified»: cuenta como entregado, sin reintentos" || no "T11d: rc=$RC pedidos=$(pedidos) · $(q "$D/vig/vigilante-$HOY.json" 'j.resumen')"


# T11e si la sección de dependencias no se puede rearmar, el vigilante NO pisa el mensaje de las 04:00
D="$TMP/t11e"; mundo "$D"
snap "$D" "$HOY" '{}'; sellar "$D" "$HOY" 555
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));delete s.resumen.rubros.proyectos_sin_iteracion;fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$D/out/dependencias-$HOY.json"
vsnap "$D" "$HOY" '{}'
reset_srv ok:600; RC=$(entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && ! grep -q '/editMessageText' "$TMP/pedidos.jsonl" && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] \
  && [ "$(q "$D/vig/vigilante-$HOY.json" 'j.resumen.editado + "|" + j.resumen.message_id')" = "false|600" ] \
  && ! grep -q 'no se pudo reconstruir' <<<"$(ultimo 'j.text')" \
  && ok "T11e sin rubros de dependencias reconstruibles no se edita (no se borra lo de las 04:00): va un mensaje aparte" \
  || no "T11e edición destructiva: rc=$RC · $(head -c 400 "$TMP/pedidos.jsonl")"

# T11f la sección que el vigilante vuelve a escribir es la de las 04:00, con sus fallos
D="$TMP/t11f"; mundo "$D"; snap "$D" "$HOY" '{}'
rm -f "$D/resumen.json"                     # a las 04:00 no se pudo leer resumen.json: es un fallo de esa noche
reset_srv ok:700; entregar "$D" dependencias "$HOY" >/dev/null
L04=$(tail -1 "$TMP/pedidos.jsonl" > "$TMP/p04.json"; q "$TMP/p04.json" 'j.text')
vsnap "$D" "$HOY" '{}'
reset_srv ok:700; RC=$(entregar "$D" vigilante "$HOY")
grep -q '^fallos: 1$' <<<"$L04" && [ "$RC" = 0 ] && grep -q '^fallos: 1$' <<<"$(ultimo 'j.text')" && [ "$(q "$D/out/dependencias-$HOY.json" 'j.resumen.fallos.some(f => /summary\.json/.test(f))')" = true ] \
  && ok "T11f la edición de las 08:00 conserva los fallos que dijo el mensaje de las 04:00" || no "T11f fallos perdidos en la edición: rc=$RC · 04:00=[$L04] · 08:00=[$(ultimo 'j.text')]"

# T11g dependencias entregó pero sin message_id: el vigilante va aparte y NO dice que no entregó
D="$TMP/t11g"; mundo "$D"; snap "$D" "$HOY" '{}'; sellar "$D" "$HOY" 1
constancia "$D/out/dependencias-$HOY.json" "$(q "$D/out/dependencias-$HOY.json" '({ ...j.resumen, message_id: null, entregado_el: "2000-01-01T04:00:00Z", motivo: null })')"
vsnap "$D" "$HOY" '{}'
reset_srv ok:801; RC=$(entregar "$D" vigilante "$HOY")
L1=$(ultimo 'j.text.split("\n")[0]')
[ "$RC" = 0 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] && ! grep -q 'no entregó' <<<"$L1" && grep -q 'entregó' <<<"$L1" \
  && ok "T11g sin message_id para editar, el mensaje aparte dice que dependencias SÍ entregó" || no "T11g primera línea engañosa: rc=$RC · «${L1}»"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T11h el snapshot de dependencias de hoy está ilegible: el vigilante manda uno nuevo y lo dice
D="$TMP/t11h"; mundo "$D"; echo 'esto no es json' > "$D/out/dependencias-$HOY.json"; vsnap "$D" "$HOY" '{}'
reset_srv ok:901; RC=$(entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] && grep -q 'dependencias no entregó su resumen hoy: su snapshot de hoy está ilegible' <<<"$(ultimo 'j.text.split("\n")[0]')" \
  && ok "T11h snapshot de dependencias ilegible: mensaje nuevo cuya primera línea lo dice" || no "T11h: rc=$RC · $(ultimo 'j.text.split("\n")[0]')"

# T12 sin_config_sale_3_con_el_motivo_del_script
D="$TMP/t12"; mundo "$D"; snap "$D" "$HOY" '{}'
reset_srv ok:1
RC=$(TYCON_TELEGRAM_DIR="$TMP/canal-vacio" entregar "$D" dependencias "$HOY")
[ "$RC" = 3 ] && [ "$(pedidos)" = 0 ] && [ "$(q "$D/out/dependencias-$HOY.json" 'j.resumen.message_id === null && /no hay token/.test(j.resumen.motivo) && j.resumen.entregado_el === null')" = true ] \
  && ok "T12 sin token: cero POST, message_id null, motivo con la línea del script («no hay token»), sale 3" || no "T12: rc=$RC pedidos=$(pedidos) · $(q "$D/out/dependencias-$HOY.json" 'j.resumen')"

# T13 telegram_rechaza_reintenta_y_lo_dice
D="$TMP/t13"; mundo "$D"; snap "$D" "$HOY" '{}'
reset_srv "rechaza:Bad Request: chat not found"
RC=$(entregar "$D" dependencias "$HOY")
[ "$RC" = 3 ] && [ "$(pedidos)" = 3 ] && [ "$(q "$D/out/dependencias-$HOY.json" 'j.resumen.message_id === null && /chat not found/.test(j.resumen.motivo)')" = true ] \
  && ok "T13 Telegram rechaza: 3 intentos (2 reintentos), motivo con la respuesta, sale 3" || no "T13: rc=$RC pedidos=$(pedidos) · $(q "$D/out/dependencias-$HOY.json" 'j.resumen')"

# T13b telegram_muda_termina — con un perro guardián de 60 s (macOS no trae `timeout`)
D="$TMP/t13b"; mundo "$D"; snap "$D" "$HOY" '{}'
reset_srv mudo
cp "$D/out/dependencias-$HOY.json" "$D/antes.json"
( entregar "$D" dependencias "$HOY" > "$D/rc.txt" ) & EP=$!
( sleep 60; kill "$EP" 2>/dev/null ) & GUARD=$!
wait "$EP" 2>/dev/null; kill "$GUARD" 2>/dev/null; wait "$GUARD" 2>/dev/null
RC=$(cat "$D/rc.txt" 2>/dev/null)
[ "$RC" = 3 ] && [ "$(q "$D/out/dependencias-$HOY.json" 'j.resumen && j.resumen.message_id === null && /sin respuesta/.test(j.resumen.motivo)')" = true ] \
  && ok "T13b Telegram mudo: entregar TERMINA (corte de 15 s) con motivo «sin respuesta» y sale 3" || no "T13b: rc=[$RC] · $(q "$D/out/dependencias-$HOY.json" 'j.resumen') · $(head -c 300 "$D/entregar.txt")"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T14 resumen_se_escribe_despues_y_solo_eso  (sobre el snapshot del T13b y del T10)
for C in t13b t10; do
  D="$TMP/$C"
  node -e '
const fs = require("fs"); const [antesF, despuesF] = process.argv.slice(1);
const antesRaw = fs.readFileSync(antesF, "utf8"); const d = JSON.parse(fs.readFileSync(despuesF, "utf8"));
const extra = Object.keys(d).filter((k) => !(k in JSON.parse(antesRaw)));
const sin = { ...d }; delete sin.resumen;
process.exit(JSON.stringify(extra) === "[\"resumen\"]" && JSON.stringify(sin, null, 2) + "\n" === antesRaw ? 0 : 1);' "$D/antes.json" "$D/out/dependencias-$HOY.json" \
    && ok "T14 ($C) el snapshot sólo ganó la clave resumen: el resto quedó byte a byte igual" || no "T14 ($C) el snapshot cambió más allá de resumen"
done
D="$TMP/t10"
[ "$(node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const s=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));console.log(JSON.stringify(a.rubros)===JSON.stringify(s.resumen.rubros))' "$D/a.json" "$D/out/dependencias-$HOY.json")" = true ] \
  && ok "T14 resumen.rubros es exactamente lo que calculó armar" || no "T14 resumen.rubros difiere de armar"
if [ -f "$RES" ]; then
  N=$(grep -cE "curl|https\.request|api\.telegram" "$RES")
  [ "$N" = 0 ] && ok "T14 el guion no tiene curl, https.request ni api.telegram: la única salida a la red es el script" || no "T14 el guion sale a la red por su cuenta ($N líneas)"
  N=$(grep -cE "require\(['\"][^'\"]*vigilante" "$RES")
  [ "$N" = 0 ] && ok "T14 el guion no requiere vigilante.js (sólo Node y nightly-dependencies.js)" || no "T14 el guion requiere vigilante.js"
else
  no "T14 el guion no existe"
fi


# T14b un error inesperado del guion sale en UNA línea (no un stack) y deja constancia con el motivo
D="$TMP/t14b"; mundo "$D"; snap "$D" "$HOY" '{}'
reset_srv ok:1
RC=$(TYCON_SUMMARY_INJECT_FAILURE=1 entregar "$D" dependencias "$HOY")
[ "$RC" = 3 ] && [ "$(pedidos)" = 0 ] && tail -n 1 "$D/entregar.txt" | grep 'error inesperado' >/dev/null && ! grep -qE '^\s+at ' "$D/entregar.txt" \
  && [ "$(q "$D/out/dependencias-$HOY.json" 'j.resumen && j.resumen.message_id === null && /error inesperado/.test(j.resumen.motivo)')" = true ] \
  && ok "T14b un error inesperado: sale 3, la última línea lo dice sin stack, y el snapshot queda con el motivo" \
  || no "T14b error inesperado: rc=$RC · $(tail -c 400 "$D/entregar.txt")"

# T14c el error inesperado también por `armar`: una línea, sale 1, sin constancia
D="$TMP/t14c"; mundo "$D"; snap "$D" "$HOY" '{}'; cp "$D/out/dependencias-$HOY.json" "$D/antes.json"
TYCON_SUMMARY_INJECT_FAILURE=1 node "$RES" build --source dependencies --today "$HOY" --out "$D/out" --pending "$D/pend" --config "$D/repos.json" --summary-config "$D/resumen.json" --watcher-out "$D/vig" > "$D/a.txt" 2>&1; RC=$?
[ "$RC" = 1 ] && tail -n 1 "$D/a.txt" | grep 'error inesperado' >/dev/null && ! grep -qE '^\s+at ' "$D/a.txt" && cmp -s "$D/antes.json" "$D/out/dependencias-$HOY.json" \
  && ok "T14c armar con un error inesperado sale 1 en una línea y no toca el snapshot" || no "T14c: rc=$RC · $(tail -c 300 "$D/a.txt")"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T15, T15b, T15c, T15d, T16, T16b — los casos del aviso viven en el BANCO de controles
# (`scripts/controls-bench/cases/hooks/22-dependencias-notice.json`), que es donde se corren contra el
# hook real en un sandbox. Acá se verifica que sigan ahí, con su tipo, y que el fixture del caso viejo
# de la noche buena traiga la constancia de entrega (T15d): si alguien lo borra, ese caso vuelve a pedir
# el ✅ sobre una noche sin resumen y el banco se pone rojo por la razón equivocada.
BANCO="$RAIZ/scripts/controls-bench/cases/hooks/22-dependencias-notice.json"
R=$(node -e '
const casos = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).hooks[0].cases;
const por = Object.fromEntries(casos.map((c) => [c.id, c]));
const falta = [["T15","arranque-grita-si-la-noche-corrio-sin-resumen"],["T15b","arranque-cobra-el-motivo-de-entrega"],
  ["T15c","noche-buena-no-suma-lineas"],["T16","arranque-cobra-al-vigilante"],["T16","arranque-calla-al-vigilante-que-entrego"],
  ["T16b","vigilante-viejo-sin-numeros"],["T16b","sin-snapshot-del-vigilante-silencio"]]
  .filter(([, id]) => !por[id] || por[id].type !== "must-emit").map(([t, id]) => t + ":" + id);
const habla = por["habla-aunque-no-haya-nada-que-decir"];
if (!habla || !habla.setup.join(" ").includes("resumen:{")) falta.push("T15d:habla-aunque-no-haya-nada-que-decir sin resumen en el fixture");
console.log(falta.length ? falta.join(" · ") : "ok");' "$BANCO" 2>&1)
[ "$R" = ok ] && ok "T15/T15b/T15c/T15d/T16/T16b los casos del aviso están en el banco (y la noche buena vieja trae su constancia de entrega)" || no "T15–T16b en el banco: $R"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T15-paridad — el guion que deja la constancia y el aviso que la cobra usan LA MISMA regla
# de «entregado». Viven en dos archivos a propósito (el banco copia el hook solo, sin hermanos), así
# que lo único que impide que se separen es esta tabla.
PAR=$(node -e '
const { entregado } = require(process.argv[1]);
const { constaEntregado } = require(process.argv[2]);
const casos = [undefined, null, {}, { message_id: 5, motivo: null }, { message_id: null, motivo: "no hay token" },
  { message_id: null, motivo: null }, { message_id: 7, motivo: "algo" }, { entregado_el: "2026-09-20T04:00:00Z", message_id: null, motivo: null },
  { entregado_el: null, message_id: null, motivo: "sin respuesta" }, { message_id: 0, motivo: null }, "texto"];
const dif = casos.filter((c) => entregado(c) !== constaEntregado(c));
console.log(dif.length ? "DIFIEREN: " + JSON.stringify(dif) : "iguales");' "$RES" "$RAIZ/scripts/hooks/dependencies-notice.js" 2>&1)
[ "$PAR" = iguales ] && ok "T15-paridad la regla de «entregado» del resumen y la del aviso de arranque coinciden en toda la tabla" || no "T15-paridad: $PAR"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T17 / T18 — los pasos REALES de los pipelines
extraer() { # <yaml> <displayName> → cuerpo del `- script: |` (misma técnica que open-pr-per-finding.test.sh)
  python3 - "$1" "$2" <<'PY'
import re, sys
lines = open(sys.argv[1], encoding='utf8').read().split('\n'); display = sys.argv[2]
idx = next((i for i, l in enumerate(lines) if f"displayName: '{display}'" in l), None)
if idx is None: sys.stderr.write(f"NO_ENCONTRE_DISPLAYNAME:{display}\n"); sys.exit(3)
start = next((i for i in range(idx, -1, -1) if re.match(r'\s*-\s+script:\s*\|', lines[i])), None)
if start is None: sys.stderr.write("NO_ENCONTRE_SCRIPT\n"); sys.exit(3)
cuerpo = lines[start + 1:idx]
sangria = min((len(l) - len(l.lstrip()) for l in cuerpo if l.strip()), default=0)
print('\n'.join(l[sangria:] if len(l) >= sangria else l for l in cuerpo).rstrip() + '\n')
PY
}
region() { # <yaml> <displayName> → el paso ENTERO (script, displayName, continueOnError, env…)
  python3 - "$1" "$2" <<'PY'
import re, sys
lines = open(sys.argv[1], encoding='utf8').read().split('\n'); display = sys.argv[2]
idx = next((i for i, l in enumerate(lines) if f"displayName: '{display}'" in l), None)
if idx is None: sys.exit(3)
start = next((i for i in range(idx, -1, -1) if re.match(r'\s*-\s+(script|task|checkout):', lines[i])), None)
ind = len(lines[start]) - len(lines[start].lstrip())
end = next((i for i in range(start + 1, len(lines)) if lines[i].strip() and (len(lines[i]) - len(lines[i].lstrip())) <= ind), len(lines))
print('\n'.join(lines[start:end]))
PY
}
orden() { # <yaml> <display1> <display2> <display3> → true si aparecen en ese orden
  python3 - "$@" <<'PY'
import sys
t = open(sys.argv[1], encoding='utf8').read()
pos = [t.find(f"displayName: '{d}'") for d in sys.argv[2:]]
print('true' if all(p >= 0 for p in pos) and pos == sorted(pos) else 'false')
PY
}
# Corre el paso en un sandbox con la forma de un agente de Azure: $(Build.SourcesDirectory) apunta
# a una copia mínima con scripts/ y el snapshot, y las macros se sustituyen como lo hace ADO.
correr_paso() { # <yaml> <display> <sandbox> [VAR=valor …]  → exit code; salida en <sandbox>/paso.out
  local Y="$1" DISP="$2" S="$3"; shift 3
  extraer "$Y" "$DISP" > "$S/cuerpo.sh" || return 99
  sed -e "s#\$(Build.SourcesDirectory)#$S#g" "$S/cuerpo.sh" > "$S/paso.sh"
  ( cd "$S" && env -u TELEGRAM_BOT_TOKEN -u TYCON_TELEGRAM_CHAT_ID -u HOY_NOCTURNO "$@" bash "$S/paso.sh" ) > "$S/paso.out" 2>&1
  echo $?
}
sandbox() { # <dir> <fuente>
  local S="$1"; rm -rf "$S"; mkdir -p "$S/.dashboard/dependencias" "$S/.dashboard/vigilante" "$S/inbox/dependencies/pending" "$S/inbox/dependencies/promoted" "$S/inbox/watcher/pending" "$S/inbox/watcher/promoted"
  ln -s "$RAIZ/scripts" "$S/scripts"
  node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({fecha:process.argv[2],corrida_completa:true,no_medidos:[],hallazgos:[],anunciados_hoy:[],postergados_por_presupuesto:[],reaparecidos_ids:[],rechazadas_sin_deuda_ids:[]},null,2)+"\n")' "$S/.dashboard/dependencias/dependencias-$HOY.json" "$HOY"
  node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({fecha:process.argv[2],hallazgos:[],no_medido:[],nuevos:0,marcados_ignorados:0,ignorados_ids:[]},null,2)+"\n")' "$S/.dashboard/vigilante/vigilante-$HOY.json" "$HOY"
  # el canal sale de operations.json → notify (sin el segundo argumento «sin-notify»)
  if [ "${2:-}" = sin-notify ]; then echo '{ "version": 1, "owners": { "default": "lead@acme.example" } }' > "$S/operations.json"
  else echo '{ "version": 1, "owners": { "default": "lead@acme.example" }, "notify": { "channel": "telegram" } }' > "$S/operations.json"; fi
}
BASE_OK=1; git -C "$RAIZ" rev-parse --verify --quiet origin/main >/dev/null || BASE_OK=0
# El renombre de una opción o de un archivo del arnés a inglés (mapa de renombres) no es «tocar el paso»: los
# dos lados se comparan con cada `--viejo` pasado a `--nuevo` y cada ruta vieja a la nueva. Sin mapa, el texto tal cual.
# La carpeta de la cola (`--queue`) también es una ruta, así que una carpeta mudada (`kind: folder` del mapa)
# se compara por su nombre nuevo — SÓLO en esa posición. `--branch` lleva la misma palabra y es un valor (el prefijo
# de la rama): si alguien lo cambiara por la carpeta, el paso tiene que salir distinto.
opciones_nuevas() {
  node -e 'const fs = require("fs"); let t = fs.readFileSync(0, "utf8"); let e = [];
    try { e = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).entries; } catch (_) { e = []; }
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const x of e.filter((x) => x && x.kind === "option" && x.old && x.new)) t = t.replace(new RegExp(`--${esc(x.old)}(?![A-Za-z0-9-])`, "g"), `--${x.new}`);
    for (const x of e.filter((x) => x && x.kind === "file" && !x.repo && x.old && x.new)) t = t.replace(new RegExp(`(?<![A-Za-z0-9_./-])${esc(x.old)}(?![A-Za-z0-9_.-])`, "g"), x.new);
    for (const x of e.filter((x) => x && x.kind === "folder" && !x.repo && x.old && x.new)) t = t.replace(new RegExp(`(--queue[ \\t]+)${esc(x.old)}(?![A-Za-z0-9_./-])`, "g"), `$1${x.new}`);
    process.stdout.write(t);' "$RAIZ/scripts/lib/renames.json"
}
# Los yml viven en pipelines/. Si origin/main los tiene todavía en su ruta de antes, se lee
# la nueva si ya está publicada; si no, la vieja armada DESDE EL MAPA (nunca escrita acá), diciéndolo. Sale 2 sin mapa
# (la copia pública) y 1 si ninguna de las dos está en origin/main.
ruta_publicada() { # <ruta nueva> → la ruta a leer en origin/main
  if git -C "$RAIZ" cat-file -e "origin/main:$1" 2>/dev/null; then echo "$1"; return 0; fi
  [ -f "$RAIZ/scripts/lib/renames.json" ] || return 2
  local vieja
  vieja=$(node -e 'try { const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const e = m.entries.find((x) => x && x.kind === "file" && x.new === process.argv[2]); if (e) console.log(e.old); } catch (_) {}' \
    "$RAIZ/scripts/lib/renames.json" "$1")
  { [ -n "$vieja" ] && git -C "$RAIZ" cat-file -e "origin/main:$vieja" 2>/dev/null; } || return 1
  echo "   (origin/main todavía tiene $1 en su ruta de antes, $vieja: se compara contra esa)" >&2
  echo "$vieja"
}
igual_a_main() { # <yaml> <display> → true si el paso entero es idéntico al de origin/main (salvo opciones renombradas)
  local pub rc
  pub=$(ruta_publicada "$1"); rc=$?
  [ "$rc" = 2 ] && { echo "NO MEDIDO — copia pública sin el mapa"; return; }
  # Sin el yml en origin/main no hay contra qué comparar: no es «cambió». Pasa en el nocturno, que corre en el repo del
  # equipo con el público encima (su origin/main no trae los pipelines que se mudaron al público), y con un pipeline
  # nuevo de la rama. Sin esto saldría rojo «nomain» cada noche.
  [ "$rc" = 0 ] || { echo "NO MEDIDO — origin/main de este repo no tiene $1: no hay paso de antes contra el cual comparar"; return; }
  git -C "$RAIZ" show "origin/main:$pub" > "$TMP/main.yml" 2>/dev/null || { echo nomain; return; }
  # la condición de `efectos` (una corrida de prueba no abre pedidos ni avisa) no es un cambio del paso:
  # se saca de los dos lados, y sólo esa línea (la fija pipelines-moved.test.js, T7)
  local sin_efectos="condition: and(succeeded(), eq('\${{ parameters.efectos }}', 'true'))"
  [ "$(region "$RAIZ/$1" "$2" | opciones_nuevas | grep -vF "$sin_efectos")" = "$(region "$TMP/main.yml" "$2" | opciones_nuevas | grep -vF "$sin_efectos")" ] && echo true || echo false
}

# En el público el paso real es el del MODELO de la revisión nocturna (pipelines/operations/dependency-audit.yml),
# con sus nombres de pasos. T18 (el pipeline del vigilante) no viaja: el vigilante de producción es del repo del
# equipo, y sus casos siguen allá. Tampoco viaja el chequeo del grupo de variables `vigilante-prod-hosts`, que era del
# pipeline del equipo: el modelo no carga grupos.
for CASO in dependencias; do
  # el paso real, por su nombre, sin condición sobre el chat de Telegram
  T=2.30-T30; Y="$RAIZ/pipelines/operations/dependency-audit.yml"; YREL=pipelines/operations/dependency-audit.yml
  ANTES='Crear los pedidos de trabajo'; DESPUES='Guardar el snapshot y las fichas en el repo de operaciones'
  INTACTOS=("Abrir un pull request por hallazgo (ahí se decide)"); SNAP=".dashboard/dependencias/dependencias-$HOY.json"
  DISP='Entregar el resumen'
  [ "$(orden "$Y" "$ANTES" "$DISP" "$DESPUES")" = true ] \
    && ok "$T el paso «${DISP}» está entre «${ANTES}» y «${DESPUES}»" || no "$T el paso «${DISP}» no está entre «${ANTES}» y «${DESPUES}»"
  REG=$(region "$Y" "$DISP" 2>/dev/null || true)
  grep -q 'continueOnError: true' <<<"$REG" && grep -q 'TELEGRAM_BOT_TOKEN: $(TELEGRAM_BOT_TOKEN)' <<<"$REG" && grep -q 'TYCON_TELEGRAM_CHAT_ID: $(TYCON_TELEGRAM_CHAT_ID)' <<<"$REG" \
    && grep -q 'TYCON_NOTIFY_WEBHOOK_URL: $(TYCON_NOTIFY_WEBHOOK_URL)' <<<"$REG" \
    && ok "$T el paso lleva continueOnError: true y las variables de los canales en env (Telegram y el webhook)" || no "$T al paso le falta continueOnError o las variables de los canales"
  grep -q 'condition:' <<<"$REG" && ! grep -q 'TYCON_TELEGRAM_CHAT_ID' <<<"$(grep 'condition:' <<<"$REG")" \
    && grep -Eq -- '--operations "\$\(Build\.SourcesDirectory\)/operations\.json"' <<<"$REG" \
    && ok "$T la condición del paso no mira el chat de Telegram (la decisión la toma notify.js) y le pasa el operations.json del árbol" \
    || no "$T el paso sigue atado al chat de Telegram o no pasa --operations: $(grep 'condition:' <<<"$REG")"
  VAL="$FUENTE_DEPS"
  grep -Eq -- "${FUENTE_OPC} ${VAL}( |\$)" <<<"$REG" && grep -q 'HOY_NOCTURNO' <<<"$REG" && ! grep -qE '\bdate\b' <<<"$REG" \
    && ok "$T el paso entrega --source $CASO con la fecha de la noche (HOY_NOCTURNO) y no calcula otra" || no "$T el paso no usa --source $CASO / HOY_NOCTURNO, o calcula su propia fecha"
  if [ "$BASE_OK" = 1 ]; then
    for P in "${INTACTOS[@]}"; do
      R=$(igual_a_main "$YREL" "$P")
      case "$R" in "NO MEDIDO"*) salt "$T el paso «${P}» contra origin/main: $R"; continue ;; esac
      [ "$R" = true ] && ok "$T el paso «${P}» es idéntico a origin/main" || no "$T el paso «${P}» cambió respecto de origin/main ($R)"
    done
  else
    salt "$T no hay origin/main en este clon: no se puede comparar «${INTACTOS[*]}» con lo publicado"
  fi
  # El literal de Azure: una variable no definida llega como el TEXTO `$(TELEGRAM_BOT_TOKEN)`.
  S="$TMP/sb-$CASO"; sandbox "$S"; reset_srv ok:42
  RC=$(correr_paso "$Y" "$DISP" "$S" HOY_NOCTURNO="$HOY" TYCON_TELEGRAM_DIR="$TMP/canal-vacio" 'TELEGRAM_BOT_TOKEN=$(TELEGRAM_BOT_TOKEN)' 'TYCON_TELEGRAM_CHAT_ID=$(TYCON_TELEGRAM_CHAT_ID)')
  [ "$RC" != 0 ] && [ "$(pedidos)" = 0 ] && grep -q 'task.logissue type=warning' "$S/paso.out" && grep -q 'no hay token' "$S/paso.out" \
    && [ "$(q "$S/$SNAP" 'j.resumen && /no hay token/.test(j.resumen.motivo)')" = true ] \
    && ok "$T con el literal \$(TELEGRAM_BOT_TOKEN) el paso lo trata como «sin token»: cero POST, warning y motivo verdadero" \
    || no "$T literal de Azure: rc=$RC pedidos=$(pedidos) · $(head -c 400 "$S/paso.out")"
  S="$TMP/sb2-$CASO"; sandbox "$S"; reset_srv ok:43
  RC=$(correr_paso "$Y" "$DISP" "$S" TYCON_TELEGRAM_DIR="$TMP/canal")
  [ "$RC" != 0 ] && [ "$(pedidos)" = 0 ] && grep -q 'HOY_NOCTURNO' "$S/paso.out" && [ "$(q "$S/$SNAP" 'j.resumen === undefined')" = true ] \
    && ok "$T sin HOY_NOCTURNO el paso no adivina la fecha: no intenta nada y lo dice" || no "$T sin HOY_NOCTURNO: rc=$RC pedidos=$(pedidos) · $(head -c 400 "$S/paso.out")"
  S3="$TMP/sb3-$CASO"; sandbox "$S3"; RUTA_ESPERADA=sendMessage
  S4="$TMP/sb4-$CASO"; sandbox "$S4"; reset_srv ok:45
  RC=$(correr_paso "$Y" "$DISP" "$S4" HOY_NOCTURNO="$HOY" TYCON_TELEGRAM_DIR="$TMP/canal" TYCON_SUMMARY_INJECT_FAILURE=1)
  [ "$RC" != 0 ] && [ "$(pedidos)" = 0 ] && grep 'task.logissue type=warning' "$S4/paso.out" | grep 'error inesperado' >/dev/null \
    && ok "$T un error inesperado del guion llega al warning de Azure con su motivo, no con la última línea de un stack" \
    || no "$T warning con error inesperado: rc=$RC · $(grep 'logissue' "$S4/paso.out" | head -c 300)"
  reset_srv ok:44
  RC=$(correr_paso "$Y" "$DISP" "$S3" HOY_NOCTURNO="$HOY" TYCON_TELEGRAM_DIR="$TMP/canal-vacio" TELEGRAM_BOT_TOKEN="$TOK_PRUEBA" TYCON_TELEGRAM_CHAT_ID=990011223344)
  [ "$RC" = 0 ] && [ "$(pedidos)" = 1 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/$RUTA_ESPERADA" ] && [ "$(q "$S3/$SNAP" 'j.resumen && j.resumen.message_id === 44')" = true ] \
    && ok "$T con las dos variables de verdad el paso entrega ($RUTA_ESPERADA) y sale 0" || no "$T paso con variables: rc=$RC pedidos=$(pedidos) ruta=$(ultimo 'j.ruta') · $(head -c 400 "$S3/paso.out")"
  # sin `notify`, con las variables de Telegram puestas: no se manda, y el warning lo dice
  S5="$TMP/sb5-$CASO"; sandbox "$S5" sin-notify; reset_srv ok:46
  RC=$(correr_paso "$Y" "$DISP" "$S5" HOY_NOCTURNO="$HOY" TYCON_TELEGRAM_DIR="$TMP/canal-vacio" TELEGRAM_BOT_TOKEN="$TOK_PRUEBA" TYCON_TELEGRAM_CHAT_ID=990011223344)
  [ "$RC" != 0 ] && [ "$(pedidos)" = 0 ] && grep 'task.logissue type=warning' "$S5/paso.out" | grep 'canal sin configurar' >/dev/null \
    && [ "$(q "$S5/$SNAP" 'j.resumen && j.resumen.canal === null && /canal sin configurar en operations\.json → notify/.test(j.resumen.motivo)')" = true ] \
    && ok "$T sin notify el paso no manda aunque estén las variables de Telegram, y la constancia dice «canal sin configurar»" \
    || no "$T sin notify: rc=$RC pedidos=$(pedidos) · $(head -c 400 "$S5/paso.out") · $(q "$S5/$SNAP" 'j.resumen')"
  # el literal del webhook sin definir es «ausente» (con notify slack)
  S6="$TMP/sb6-$CASO"; sandbox "$S6"; echo '{ "version": 1, "owners": { "default": "lead@acme.example" }, "notify": { "channel": "slack" } }' > "$S6/operations.json"; reset_srv ok:47
  RC=$(correr_paso "$Y" "$DISP" "$S6" HOY_NOCTURNO="$HOY" 'TYCON_NOTIFY_WEBHOOK_URL=$(TYCON_NOTIFY_WEBHOOK_URL)')
  [ "$RC" != 0 ] && [ "$(pedidos)" = 0 ] && [ "$(q "$S6/$SNAP" 'j.resumen && /falta la dirección del webhook/.test(j.resumen.motivo)')" = true ] \
    && ok "$T con el literal \$(TYCON_NOTIFY_WEBHOOK_URL) el paso lo trata como ausente" || no "$T literal del webhook: rc=$RC pedidos=$(pedidos) · $(q "$S6/$SNAP" 'j.resumen')"
done

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T30 resumen_lee_el_cruce — dos rubros que LEEN `cruce`, nunca un 0 sin fuente
D="$TMP/t30"; mundo "$D"
snap "$D" "$HOY" '{"cruce":"__BORRAR__"}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" '["pedidos_cerrados_con_vivas","resueltas_con_pedido_abierto"].every(k => j.rubros[k] && j.rubros[k].valor === null && /el snapshot no trae `cruce`/.test(j.rubros[k].motivo))')" = true ] \
  && ok "T30 sin la clave cruce los dos rubros salen null con «el snapshot no trae \`cruce\`» (nunca 0)" || no "T30 sin cruce: $(q "$D/a.json" '[j.rubros.pedidos_cerrados_con_vivas, j.rubros.resueltas_con_pedido_abierto]') ($(head -c 200 "$D/a.err"))"
snap "$D" "$HOY" '{"cruce":{"consultado":false,"motivo":"sin volcado bugs-2026-09-20.json","cerrados_vivos":[],"resueltas_con_pedido_abierto":[],"no_leidos":[],"huerfanos":[]}}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" '["pedidos_cerrados_con_vivas","resueltas_con_pedido_abierto"].every(k => j.rubros[k].valor === null && /sin volcado bugs-2026-09-20\.json/.test(j.rubros[k].motivo))')" = true ] \
  && ok "T30 con cruce.consultado:false los dos rubros salen null con el motivo del cruce" || no "T30 consultado false: $(q "$D/a.json" '[j.rubros.pedidos_cerrados_con_vivas, j.rubros.resueltas_con_pedido_abierto]')"
snap "$D" "$HOY" '{"cruce":{"consultado":true,"motivo":null,"cerrados_vivos":[{"ficha":"aaa11111","proyecto":"ProyA","pedido":101,"estado":"Closed","motivo":"Verified","clase":"arreglado","visto_cerrado":"2026-09-18","repos":["A/A"],"avisar":true}],"resueltas_con_pedido_abierto":[{"ficha":"bbb22222","proyecto":"Proy B","pedido":202,"resuelto":"2026-09-15","dias":5}],"no_leidos":[{"ficha":"ccc33333","proyecto":"ProyA","pedido":303,"motivo":"no pude leer el work item (salió 1)"}],"huerfanos":[{"id":150,"proyecto":"ProyA","ficha":"aaa11111","estado":"Active","categoria":"InProgress"}]}}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" 'JSON.stringify(j.rubros.pedidos_cerrados_con_vivas.valor) === JSON.stringify([{ ficha: "aaa11111", proyecto: "ProyA", pedido: 101, clase: "arreglado" }]) && JSON.stringify(j.rubros.resueltas_con_pedido_abierto.valor) === JSON.stringify([{ ficha: "bbb22222", proyecto: "Proy B", pedido: 202, dias: 5 }])')" = true ] \
  && ok "T30 con cruce los rubros traen los pedidos cerrados con la vulnerabilidad viva y las resueltas con pedido abierto" || no "T30 valores: $(q "$D/a.json" '[j.rubros.pedidos_cerrados_con_vivas, j.rubros.resueltas_con_pedido_abierto]')"
[ "$(q "$D/a.json" 'j.fallos.some(f => /^cruce: 1 pedido\(s\) no leído\(s\) — no pude leer el work item/.test(f)) && j.fallos.some(f => /^cruce: 1 Bug\(s\) del arnés que ninguna ficha nombra/.test(f))')" = true ] \
  && ok "T30 los fallos dicen los pedidos no leídos (con el motivo del primero) y los Bugs sueltos" || no "T30 fallos: $(q "$D/a.json" 'j.fallos')"
[ "$(q "$D/a.json" 'j.texto.includes("pedidos cerrados con la vulnerabilidad viva: 1") && !/aaa11111|ProyA|Bug 101/.test(j.texto)')" = true ] \
  && ok "T30 el texto cuenta el pedido cerrado con la vulnerabilidad viva, sin ficha, proyecto ni Bug" || no "T30 texto: $(q "$D/a.json" 'j.texto')"
snap "$D" "$HOY" '{"cruce":{"consultado":true,"motivo":null,"cerrados_vivos":[],"resueltas_con_pedido_abierto":[],"no_leidos":[],"huerfanos":[],"huerfanos_no_consultados":[{"proyecto":"Proy B","motivo":"no pude consultar los Bugs del arnés (salió 1)"}]}}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" 'j.fallos.some(f => /^cruce: no se pudo buscar Bugs sueltos en 1 proyecto\(s\) — Proy B/.test(f))')" = true ] \
  && ok "T30 (5b) un proyecto donde no se pudo buscar Bugs sueltos es un fallo de la noche, no un silencio" || no "T30 no consultados: $(q "$D/a.json" 'j.fallos')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T31 la_noche_que_se_encendieron_los_pedidos — el mensaje de la noche en que los pedidos pasan de simulados a reales.
# Tiene que nombrar los Bugs que la noche creó de verdad y no decir «5 cambio(s) desde ayer» con cinco renglones
# en 0: tres rubros «cambian» sólo porque `simulado` pasa a false, dos son rubros nuevos que se miden por primera vez,
# y el que sí cambió (un pedido postergado que salió) tiene que decir qué había antes. El ayer se sella con la forma de
# la constancia de ese día: sin los rubros que nacieron después (se borran del sello).
D="$TMP/t31"; mundo "$D"
ficha "$D" pending ea4e7794 "$(fecha "$HOY" -5)" pendiente A/A
ficha "$D" promoted 3788493d "$(fecha "$HOY" -6)" util A/A
ficha "$D" promoted 94dbbf29 "$(fecha "$HOY" -6)" util B/B
snap "$D" "$AYER" '{"pedidos":{"simulado":true,"tope":2,"creados":[{"ficha":"3788493d","proyecto":"ProyA","id":null},{"ficha":"94dbbf29","proyecto":"Proy B","id":null}],"adoptados":[],"fallidos":[],"postergados":[{"ficha":"ea4e7794","proyectos":["ProyA"]}],"sin_iteracion":[],"sin_dueno_unico":[],"deuda_avisada":[],"sin_pedido":[]},"cruce":"__BORRAR__"}'
sellar "$D" "$AYER"
node -e '
const fs = require("fs"); const f = process.argv[1]; const s = JSON.parse(fs.readFileSync(f, "utf8"));
for (const k of ["pedidos_creados", "pedidos_cerrados", "pedidos_reabiertos", "pedidos_cerrados_con_vivas", "resueltas_con_pedido_abierto"]) delete s.resumen.rubros[k];
fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");' "$D/out/dependencias-$AYER.json"
snap "$D" "$HOY" '{"pedidos":{"simulado":false,"tope":2,"creados":[{"ficha":"3788493d","proyecto":"ProyA","id":5173},{"ficha":"94dbbf29","proyecto":"Proy B","id":5174},{"ficha":"ea4e7794","proyecto":"ProyA","id":5175}],"adoptados":[],"fallidos":[],"postergados":[],"sin_iteracion":[],"sin_dueno_unico":[],"deuda_avisada":[],"pagados_avisados":[],"reabiertos":[],"sin_pedido":[]},"cruce":{"consultado":true,"motivo":null,"evaluados":0,"cerrados_vivos":[],"resueltas_con_pedido_abierto":[],"no_leidos":[],"huerfanos":[],"huerfanos_no_consultados":[]}}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" '/^• pedidos creados: 3/m.test(j.texto) && !/5173|5174|5175|ProyA|Proy B|3788493d/.test(j.texto) && j.rubros.pedidos_creados.valor.length === 3')" = true ] \
  && ok "T31 🔴 el resumen cuenta los Bugs que la noche creó (el detalle, en el snapshot)" || no "T31 no nombra los Bugs creados: $(q "$D/a.json" 'j.texto') ($(head -c 200 "$D/a.err"))"
[ "$(q "$D/a.json" 'Array.isArray(j.cambios) && !j.cambios.includes("deuda_con_pedido_abierto") && !j.cambios.includes("proyectos_sin_iteracion") && /^Pedidos de trabajo: encendidos \(ayer estaban en simulado\)\.$/m.test(j.texto)')" = true ] \
  && ok "T31 🔴 pasar de simulado a real no es un cambio de cada rubro: es UNA línea «Pedidos de trabajo: encendidos»" || no "T31 modo: $(q "$D/a.json" '[j.cambios, j.texto]')"
[ "$(q "$D/a.json" '!j.cambios.includes("pedidos_cerrados_con_vivas") && !j.cambios.includes("resueltas_con_pedido_abierto") && /^Empezó a medirse, sin novedad: Bugs cerrados por el arnés, Bugs reabiertos por el arnés, pedidos cerrados con la vulnerabilidad viva, resueltas con pedido abierto$/m.test(j.texto) && !/antes no medido/.test(j.texto)')" = true ] \
  && ok "T31 🔴 un rubro que se mide por primera vez y viene vacío no es un cambio: una línea «Empezó a medirse»" || no "T31 rubros nuevos: $(q "$D/a.json" '[j.cambios, j.texto]')"
[ "$(q "$D/a.json" '/^• postergadas por presupuesto: 0 hallazgo\(s\) · pedidos: 0 \(antes 0 hallazgo\(s\) · pedidos: 1\)$/m.test(j.texto)')" = true ] \
  && ok "T31 🔴 el cambio dice qué había antes" || no "T31 sin «antes»: $(q "$D/a.json" 'j.texto')"
[ "$(q "$D/a.json" 'JSON.stringify(j.cambios) === JSON.stringify(["pedidos_creados", "postergadas_por_presupuesto"]) && j.texto.startsWith("2 cambio(s) desde ayer") && /^Sigue igual \(8 rubros\)$/m.test(j.texto)')" = true ] \
  && ok "T31 la cuenta: 2 cambios (los Bugs y el postergado que salió), 4 rubros que empezaron, 8 que siguen igual" || no "T31 cuenta: $(q "$D/a.json" '[j.cambios, j.texto]')"
# El espejo: una noche que se APAGA vuelve a simulado — también es una línea, no tres cambios.
D="$TMP/t31b"; mundo "$D"
snap "$D" "$AYER" '{"pedidos":{"simulado":false,"creados":[],"adoptados":[],"fallidos":[],"postergados":[],"sin_iteracion":[],"deuda_avisada":[]}}'
sellar "$D" "$AYER"
snap "$D" "$HOY" '{"pedidos":{"simulado":true,"creados":[],"adoptados":[],"fallidos":[],"postergados":[],"sin_iteracion":[],"deuda_avisada":[]}}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" 'JSON.stringify(j.cambios) === "[]" && /^Pedidos de trabajo: volvieron a simulado \(ayer estaban encendidos\)\.$/m.test(j.texto) && j.texto.startsWith("Sin cambios desde ayer")')" = true ] \
  && ok "T31b apagar los pedidos se dice en una línea y no cuenta como cambios" || no "T31b: $(q "$D/a.json" '[j.cambios, j.texto]')"
# T31c una noche SIN sección `pedidos` no es un cambio de modo: sin el paso de pedidos no
# se sabe si estaban encendidos (el `simulado: false` de «postergadas» solo no alcanza para decir «encendidos»).
D="$TMP/t31c"; mundo "$D"
snap "$D" "$AYER" '{"pedidos":{"simulado":true,"creados":[],"adoptados":[],"fallidos":[],"postergados":[],"sin_iteracion":[],"deuda_avisada":[]}}'
sellar "$D" "$AYER"
snap "$D" "$HOY" '{}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" 'j.modo_pedidos === null && !/Pedidos de trabajo:/.test(j.texto)')" = true ] \
  && ok "T31c hoy sin sección pedidos (ayer simulados): no dice «encendidos»" || no "T31c: $(q "$D/a.json" '[j.modo_pedidos, j.texto]')"
D="$TMP/t31d"; mundo "$D"
snap "$D" "$AYER" '{}'
sellar "$D" "$AYER"
snap "$D" "$HOY" '{"pedidos":{"simulado":true,"creados":[],"adoptados":[],"fallidos":[],"postergados":[],"sin_iteracion":[],"deuda_avisada":[]}}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" 'j.modo_pedidos === null && !/Pedidos de trabajo:/.test(j.texto)')" = true ] \
  && ok "T31d ayer sin sección pedidos (hoy simulados): no dice «volvieron a simulado»" || no "T31d: $(q "$D/a.json" '[j.modo_pedidos, j.texto]')"
# T32 los Bugs que cerró el arnés se NOMBRAN, y la noche del cierre
# no salen también como «resueltas con pedido abierto» (el cruce corre antes que el cierre y los ve abiertos)
D="$TMP/t32"; mundo "$D"
snap "$D" "$HOY" '{"pedidos":{"simulado":false,"creados":[],"adoptados":[],"fallidos":[],"postergados":[],"sin_iteracion":[],"deuda_avisada":[],"pagados_avisados":[{"ficha":"aaa11111","proyecto":"ProyA","id":301,"cerrado":true,"motivo_azure":"Fixed and verified"},{"ficha":"bbb22222","proyecto":"Proy B","id":302,"cerrado":false,"motivo_azure":null}],"reabiertos":[{"ficha":"ccc33333","proyecto":"ProyA","id":303}]},"cruce":{"consultado":true,"motivo":null,"evaluados":2,"cerrados_vivos":[],"resueltas_con_pedido_abierto":[{"ficha":"aaa11111","proyecto":"ProyA","pedido":301,"dias":0},{"ficha":"bbb22222","proyecto":"Proy B","pedido":302,"dias":3}],"no_leidos":[],"huerfanos":[],"huerfanos_no_consultados":[]}}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" 'JSON.stringify(j.rubros.pedidos_cerrados.valor) === JSON.stringify([{ ficha: "aaa11111", proyecto: "ProyA", id: 301 }]) && JSON.stringify(j.rubros.resueltas_con_pedido_abierto.valor.map(x => x.pedido)) === "[302]" && j.texto.includes("Bugs cerrados por el arnés: 1") && j.texto.includes("Bugs reabiertos por el arnés: 1") && !/Bug 30[13]|ProyA|aaa11111/.test(j.texto)')" = true ] \
  && ok "T32 el resumen cuenta los Bugs que cerró y los que reabrió el arnés (sin nombrarlos), y no repite los cerrados como «resueltas con pedido abierto»" || no "T32: $(q "$D/a.json" '[j.rubros.pedidos_cerrados, j.rubros.resueltas_con_pedido_abierto, j.texto]') ($(head -c 200 "$D/a.err"))"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T33 la_seccion_viaja_en_el_mismo_mensaje — los PR abiertos van al final del MISMO mensaje
# Sin `--extra`, `entregar` sale 2 («opción desconocida») y no manda nada.
D="$TMP/t33"; mundo "$D"
snap "$D" "$HOY" '{}'; ficha "$D" pending aaa11111 "$HOY" pendiente A/A
reset_srv ok:777; entregar "$D" dependencias "$HOY" >/dev/null
DEPS_L1=$(tail -1 "$TMP/pedidos.jsonl" > "$TMP/p.json"; q "$TMP/p.json" 'j.text.split("\n")[0]')
vsnap "$D" "$HOY" '{}'
printf 'PR abiertos hace más de 2 días: 1\n#2912 Acme/Backend — Autor — 13 días\n' > "$D/prs.txt"
reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/prs.txt")
[ "$RC" = 0 ] && [ "$(pedidos)" = 1 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/editMessageText" ] \
  && [ "$(ultimo 'j.text.split("\n").slice(-2).join("|")')" = "PR abiertos hace más de 2 días: 1|sitio: sin configurar" ] && ! grep -q '2912' <<<"$(ultimo 'j.text')" \
  && [ "$(ultimo 'j.text.split("\n")[0]')" = "$DEPS_L1" ] && grep -q '🌙 vigilante' <<<"$(ultimo 'j.text')" \
  && ok "T33 la cantidad de PR va al final del mismo mensaje editado, antes de la línea del sitio, sin la lista" \
  || no "T33 con sección: rc=$RC pedidos=$(pedidos) ruta=$(ultimo 'j.ruta') · $(ultimo 'j.text') · $(head -c 300 "$D/entregar.txt")"
[ "$(q "$D/vig/vigilante-$HOY.json" 'JSON.stringify(j.resumen.rubros).includes("2912")')" = false ] \
  && ok "T33 la sección no entra a los rubros ni al snapshot" || no "T33 la sección se coló en el snapshot"
# Sin el archivo (el paso de los PR falló antes de escribirlo): el resumen sale igual y lo DICE.
vsnap "$D" "$HOY" '{}'
reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/no-existe.txt")
[ "$RC" = 0 ] && [ "$(pedidos)" = 1 ] && [ "$(ultimo 'j.text.split("\n").slice(-2)[0]')" = "PR abiertos: ? (no se pudo consultar)" ] \
  && ok "T33 sin el archivo el resumen se entrega igual y la última línea dice que los PR no se consultaron" \
  || no "T33 sin archivo: rc=$RC pedidos=$(pedidos) · $(ultimo 'j.text') · $(head -c 300 "$D/entregar.txt")"
# Sin --extra: nada cambia.
vsnap "$D" "$HOY" '{}'
reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && ! grep -q 'PR abiertos' <<<"$(ultimo 'j.text')" && ok "T33 sin --extra el mensaje no menciona PR" || no "T33 sin --extra: $(ultimo 'j.text')"
# Una sección enorme no le recorta nada al resto y el mensaje entra en Telegram (4096).
{ echo 'PR abiertos hace más de 2 días: 40'; for i in $(seq 1 40); do echo "#$i ProyectoConNombreLargo/RepositorioConNombreLargo — Autor con nombre muy largo — $i días"; done; } > "$D/largo.txt"
vsnap "$D" "$HOY" '{}'
reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/largo.txt")
[ "$RC" = 0 ] && [ "$(ultimo 'j.text.length <= 4096 && j.text.split("\n")[0] === '"$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$DEPS_L1")"' && j.text.includes("🌙 vigilante") && j.text.includes("PR abiertos hace más de 2 días: 40") && !j.text.includes("ProyectoConNombreLargo")')" = true ] \
  && ok "T33 una sección enorme deja sólo su cantidad: no recorta dependencias ni vigilante, y el total entra en 4096" \
  || no "T33 sección enorme: rc=$RC · largo=$(ultimo 'j.text.length') · $(ultimo 'j.text')"

# T33c nombres_largos_se_recortan_por_linea_entera — una sección que pasa el tope de
# caracteres con pocas líneas no puede cortarse a mitad de la lista: se sacan líneas enteras de abajo y se dice cuántas.
{ echo 'PR abiertos hace más de 2 días: 15'
  for i in $(seq 1 10); do echo "#29$i Acme Custom Portal/acme-custom-portal-sample — Persona Inventada Apellido Largo — $((i + 2)) días"; done
  echo '(+5 más)'; } > "$D/nombres-largos.txt"
vsnap "$D" "$HOY" '{}'
reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/nombres-largos.txt")
[ "$RC" = 0 ] && [ "$(ultimo 'j.text.includes("PR abiertos hace más de 2 días: 15") && !/#29\d|Persona Inventada|acme-custom/.test(j.text)')" = true ] \
  && ok "T33c con nombres largos sólo viaja la cantidad: ningún PR, autor ni repo" \
  || no "T33c nombres largos: rc=$RC · $(ultimo 'j.text')"
# T33d archivo vacío o que no se puede leer: se dice, distinto de «no se generó»
: > "$D/vacio.txt"; mkdir -p "$D/es-carpeta.txt"
vsnap "$D" "$HOY" '{}'; reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/vacio.txt")
[ "$RC" = 0 ] && [ "$(ultimo 'j.text.split("\n").slice(-2)[0]')" = "PR abiertos: ? (no se pudo consultar)" ] \
  && ok "T33d archivo vacío: «?» sin el motivo" || no "T33d vacío: rc=$RC · $(ultimo 'j.text')"
vsnap "$D" "$HOY" '{}'; reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/es-carpeta.txt")
[ "$RC" = 0 ] && [ "$(ultimo 'j.text.split("\n").slice(-2)[0]')" = "PR abiertos: ? (no se pudo consultar)" ] \
  && ok "T33d archivo ilegible (una carpeta): «?» sin el motivo" || no "T33d ilegible: rc=$RC · $(ultimo 'j.text')"
# T33e la sección que llega de afuera tampoco trae «##vso[» al mensaje
printf 'PR abiertos hace más de 2 días: 1\n#1 P/R — ##vso[task.setvariable variable=X]y — 3 días\n' > "$D/hostil.txt"
vsnap "$D" "$HOY" '{}'; reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/hostil.txt" --dry-run)
[ "$RC" = 0 ] && ! grep -qE '##(vso)?\[' "$D/entregar.txt" && ok "T33e --extra no deja pasar «##vso[» ni en el ensayo por stdout" || no "T33e: rc=$RC · $(grep -E '##' "$D/entregar.txt" | head -2)"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T21 Resumen_SoloCantidades — ningún nombre ni id en el texto; el detalle, en el snapshot
D="$TMP/t2130"; mundo "$D"
ficha "$D" pending aaa11111 "$(fecha "$HOY" -3)" pendiente A/A
ficha "$D" pending bbb22222 "$HOY" pendiente B/B
snap "$D" "$HOY" '{"hallazgos":[{"id":"aaa11111","paquete":"pkg-aaa11111","severidad":"high","repos":["A/A"],"noches":3},{"id":"bbb22222","paquete":"pkg-bbb22222","severidad":"high","repos":["B/B"],"noches":1}],"anunciados_hoy":["bbb22222"],"no_medidos":[{"ruta":"RepoSecreto/Marcador","motivo":"el restore de RepoSecreto falló"}],"carpetas":[{"repo":"RepoSecreto/Marcador","miradas":2,"total":3,"excluidas":[{"path":"Marcador","reason":"MotivoLibreMarcador"}],"nuevas":2,"altas_nuevas":1}],"graves_en_carpetas_nuevas":1,"pedidos":{"simulado":false,"creados":[{"ficha":"bbb22222","proyecto":"ProyectoMarcador","id":9191,"asignado_a":"persona@marcador.example"}],"adoptados":[],"fallidos":[{"ficha":"aaa11111","proyecto":"ProyectoMarcador","paso":"crear","motivo":"MotivoLibreMarcador"}],"postergados":[],"sin_iteracion":[],"sin_dueno_unico":[{"proyecto":"ProyectoSinDueno","motivo":"dos dueños"}],"deuda_avisada":[]},"cruce":{"consultado":true,"motivo":null,"cerrados_vivos":[],"resueltas_con_pedido_abierto":[],"no_leidos":[],"huerfanos":[{"id":4545,"proyecto":"ProyectoHuerfano","ficha":"aaa11111","estado":"Active"}]}}'
echo '{ "rubros_sin_fuente": { "rechazadas_sin_deuda": "MotivoSinFuenteMarcador" } }' > "$D/resumen.json"
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
T21TXT=$(q "$D/a.json" 'j.texto')
FUGA=""; for M in aaa11111 bbb22222 pkg- A/A B/B RepoSecreto Marcador ProyectoSinDueno ProyectoHuerfano 9191 4545 persona@ MotivoLibre MotivoSinFuente ProyA "Proy B"; do grep -qF -- "$M" <<<"$T21TXT" && FUGA="$FUGA $M"; done
[ -z "$FUGA" ] && [ -n "$T21TXT" ] && ok "2.30-T21 el texto no nombra paquetes, repos, proyectos, ids, personas ni motivos" || no "2.30-T21 🔴 se colaron en el texto:$FUGA · $T21TXT ($(head -c 200 "$D/a.err"))"
grep -q '^• vivas: 2 en 2 proyecto(s)' <<<"$T21TXT" && grep -q '^fallos: [0-9]' <<<"$T21TXT" && grep -q '^• rechazadas sin deuda: ?$' <<<"$T21TXT" && grep -q '^• la viva más vieja: 3 día(s)$' <<<"$T21TXT" \
  && ok "2.30-T21 las cantidades: «vivas: N en M proyectos», «fallos: N», «?» sin motivo donde no se midió, la edad sin id" || no "2.30-T21 cantidades: $T21TXT"
[ "$(q "$D/a.json" 'j.fallos.some(f => f.includes("RepoSecreto")) && j.rubros.nuevos.valor.some(x => x.paquete === "pkg-bbb22222")')" = true ] \
  && ok "2.30-T21 el detalle sigue en la salida de armar (rubros y fallos), que va al snapshot" || no "2.30-T21 se perdió el detalle: $(q "$D/a.json" '[j.fallos, j.rubros.nuevos]')"
vsnap "$D" "$HOY" '{"hallazgos":[{"id":"2026-09-20-ProductoMarcador-abcd","producto":"ProductoMarcador","regla":"ReglaMarcador","severidad":"alta"}],"no_medido":["host-marcador.example: sin respuesta"],"ignorados_ids":["2026-09-19-ProductoMarcador-ffff"]}'
vficha "$D" pending 2026-09-05-globex-cccc3333 2026-09-05 pendiente
armar "$D" vigilante "$HOY" > "$D/v.json" 2> "$D/v.err"
VTXT=$(q "$D/v.json" 'j.texto')
FUGA=""; for M in ProductoMarcador ReglaMarcador host-marcador globex cccc3333 ffff DATO-DE-CLIENTE; do grep -qF -- "$M" <<<"$VTXT" && FUGA="$FUGA $M"; done
[ -z "$FUGA" ] && grep -q '🌙 vigilante' <<<"$VTXT" && ok "2.30-T21 el texto del vigilante tampoco nombra productos, reglas, hosts ni ids" || no "2.30-T21 🔴 vigilante, se colaron:$FUGA · $VTXT"

# T22 Resumen_EnlaceSoloSiPasoLaPrueba
D="$TMP/t2230"; mundo "$D"; snap "$D" "$HOY" '{}'
echo '{ "version": 1, "owners": { "default": "lead@acme.example" }, "notify": { "channel": "telegram" }, "site": { "url": "https://sitio.acme.example" } }' > "$D/ops-url.json"
prueba() { node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ resultado: process.argv[2], motivo: process.argv[3] === "-" ? null : process.argv[3], hora: process.argv[4] }) + "\n")' "$D/check.json" "$1" "$2" "$3"; }
ultima_linea() { ultimo 'j.text.split("\n").pop()'; }
prueba paso - "${HOY}T04:12:30.000Z"; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json")
[ "$RC" = 0 ] && [ "$(ultima_linea)" = "sitio: https://sitio.acme.example (probado 04:12 UTC)" ] \
  && [ "$(q "$D/out/dependencias-$HOY.json" 'j.resumen.sitio.resultado + "|" + j.resumen.sitio.linea')" = "paso|sitio: https://sitio.acme.example (probado 04:12 UTC)" ] \
  && ok "2.30-T22 pasó la prueba de esta mañana: la última línea es el enlace con la hora, y queda en la constancia" || no "2.30-T22 paso: rc=$RC · «$(ultima_linea)» · $(head -c 300 "$D/entregar.txt")"
# un aviso del vocabulario de check-deploy se suma al final de la línea; uno libre (puede traer la dirección) se ignora
AVISO48=$(node -e 'process.stdout.write(require(process.argv[1]).AVISOS[0])' "$RAIZ/scripts/site/check-deploy.js")
avisar() { node -e 'const f=process.argv[1]; const j=JSON.parse(require("fs").readFileSync(f,"utf8")); j.avisos=[process.argv[2]]; require("fs").writeFileSync(f, JSON.stringify(j)+"\n")' "$D/check.json" "$1"; }
prueba paso - "${HOY}T04:12:30.000Z"; avisar "$AVISO48"; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json")
[ "$RC" = 0 ] && [ "$(ultima_linea)" = "sitio: https://sitio.acme.example (probado 04:12 UTC) · aviso: $AVISO48" ] \
  && ok "2.48-T22 pasó con el aviso de la salida: la línea lo suma al final" || no "2.48-T22 aviso: rc=$RC · «$(ultima_linea)»"
prueba paso - "${HOY}T04:12:30.000Z"; avisar "https://sitio.acme.example/x dice algo"; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json")
[ "$RC" = 0 ] && [ "$(ultima_linea)" = "sitio: https://sitio.acme.example (probado 04:12 UTC)" ] \
  && ok "2.48-T22 un aviso fuera del vocabulario se ignora" || no "2.48-T22 aviso libre: rc=$RC · «$(ultima_linea)»"
prueba fallo "el sitio está frenado" "${HOY}T04:12:30.000Z"; snap "$D" "$HOY" '{}'; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json")
[ "$(ultima_linea)" = "sitio: no pasó la prueba sin sesión (el sitio está frenado) (probado 04:12 UTC)" ] && ! grep -q 'https://' <<<"$(ultimo 'j.text')" \
  && ok "2.30-T22 no pasó: lo dice con el motivo del vocabulario, sin enlace" || no "2.30-T22 fallo: «$(ultima_linea)»"
prueba fallo "https://sitio.acme.example/x contestó raro" "${HOY}T04:12:30.000Z"; snap "$D" "$HOY" '{}'; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json")
[ "$(ultima_linea)" = "sitio: no se pudo probar desde el nocturno" ] && ok "2.30-T22 un motivo fuera del vocabulario no entra al texto: «no se pudo probar»" || no "2.30-T22 motivo libre: «$(ultima_linea)»"
for CASO22 in "no_pudo:-:${HOY}T04:12:30.000Z" "paso:-:${AYER}T04:12:30.000Z"; do
  IFS=: read -r R22 M22 H22 <<<"$CASO22"; H22="${CASO22#*:*:}"
  prueba "$R22" "$M22" "$H22"; snap "$D" "$HOY" '{}'; reset_srv ok:1
  RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json")
  [ "$(ultima_linea)" = "sitio: no se pudo probar desde el nocturno" ] && ! grep -q 'https://' <<<"$(ultimo 'j.text')" \
    && ok "2.30-T22 ${R22} (${H22:0:10}): «no se pudo probar desde el nocturno», sin enlace" || no "2.30-T22 ${R22}: «$(ultima_linea)»"
done
snap "$D" "$HOY" '{}'; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/no-existe.json")
[ "$(ultima_linea)" = "sitio: no se pudo probar desde el nocturno" ] && ok "2.30-T22 sin el archivo de la prueba: «no se pudo probar»" || no "2.30-T22 sin archivo: «$(ultima_linea)»"
snap "$D" "$HOY" '{}'; reset_srv ok:1
RC=$(entregar "$D" dependencias "$HOY" --site-check "$D/check.json")
[ "$(ultima_linea)" = "sitio: sin configurar" ] && ok "2.30-T22 sin site.url: «sitio: sin configurar», sin enlace" || no "2.30-T22 sin url: «$(ultima_linea)»"
# un operations.json que no se pudo leer NO es «sin configurar»: no se sabe si hay sitio
printf '{ "version": 1, roto' > "$D/ops-roto.json"; snap "$D" "$HOY" '{}'
OPS_FILE="$D/ops-roto.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json" --dry-run >/dev/null
grep -qx 'sitio: no se pudo probar desde el nocturno' "$D/entregar.txt" && ! grep -q 'sitio: sin configurar' "$D/entregar.txt" \
  && ok "2.30-T22 operations.json ilegible: «no se pudo probar», nunca «sin configurar»" || no "2.30-T22 ops roto: $(head -c 400 "$D/entregar.txt")"
# la cantidad de PR con otro plazo (--days 5) y con PR sin fecha legible sí entra, con su forma
printf 'PR abiertos hace más de 5 días: 4\n' > "$D/prs5.txt"; printf 'PR abiertos hace más de 2 días: 1 (+2 sin fecha legible)\n' > "$D/prs-sf.txt"
for P in prs5 prs-sf; do
  snap "$D" "$HOY" '{}'; reset_srv ok:1; entregar "$D" dependencias "$HOY" --extra "$D/$P.txt" >/dev/null
  [ "$(ultimo 'j.text.split("\n").slice(-2)[0]')" = "$(cat "$D/$P.txt")" ] && ok "2.30-T22 la línea de PR «$(cat "$D/$P.txt")» entra tal cual" || no "2.30-T22 línea de PR $P: $(ultimo 'j.text')"
done

# T23 Resumen_UnMensajePorDia — Telegram edita y conserva la línea del sitio; Slack manda el suyo
D="$TMP/t2330"; mundo "$D"; snap "$D" "$HOY" '{}'
echo '{ "version": 1, "owners": { "default": "lead@acme.example" }, "notify": { "channel": "telegram" }, "site": { "url": "https://sitio.acme.example" } }' > "$D/ops-url.json"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ resultado: "paso", motivo: null, hora: process.argv[2] + "T04:12:30.000Z" }))' "$D/check.json" "$HOY"
reset_srv ok:777; OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json" >/dev/null
vsnap "$D" "$HOY" '{}'
reset_srv ok:777; RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/editMessageText" ] && [ "$(ultimo 'j.text.split("\n").pop()')" = "sitio: https://sitio.acme.example (probado 04:12 UTC)" ] \
  && [ "$(ultimo 'j.text.split("sitio: ").length')" = 2 ] && grep -q '🌙 vigilante' <<<"$(ultimo 'j.text')" \
  && ok "2.30-T23 Telegram: el vigilante edita y deja UNA línea del sitio, la de dependencias, con su hora" || no "2.30-T23 telegram: rc=$RC · $(ultimo 'j.text')"
# el vigilante no copia la línea guardada: la rearma de lo que dejó dependencias (resultado, motivo,
# hora) y de site.url. Una línea cambiada en el snapshot no llega al aviso.
constancia "$D/out/dependencias-$HOY.json" "$(q "$D/out/dependencias-$HOY.json" '({ ...j.resumen, sitio: { ...j.resumen.sitio, linea: "sitio: https://otro.example\n#2912 RepoMarcador" } })')"
vsnap "$D" "$HOY" '{}'
reset_srv ok:777; RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && [ "$(ultimo 'j.text.split("\n").pop()')" = "sitio: https://sitio.acme.example (probado 04:12 UTC)" ] && ! grep -q 'otro.example\|RepoMarcador' <<<"$(ultimo 'j.text')" \
  && ok "2.30-T23 una línea del sitio cambiada en el snapshot no llega: el vigilante la rearma" || no "2.30-T23 línea cambiada: $(ultimo 'j.text')"
# lo mismo en los rubros: los números que el vigilante relee del snapshot al rearmar la sección
# de dependencias salen como número o «?», nunca como el texto que traiga el archivo
constancia "$D/out/dependencias-$HOY.json" "$(q "$D/out/dependencias-$HOY.json" '(() => { const r = JSON.parse(JSON.stringify(j.resumen.rubros));
  r.vivas_por_proyecto = { ...r.vivas_por_proyecto, valor: [], de: "MarcaDe" }; r.edad_mas_vieja = { ...r.edad_mas_vieja, valor: "MarcaEdad" };
  r.aceptadas_sin_resolver = { ...r.aceptadas_sin_resolver, valor: [], de: 1, bloqueadas: "MarcaBloq" };
  return { ...j.resumen, rubros: r }; })()')"
vsnap "$D" "$HOY" '{}'
reset_srv ok:777; RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && grep -q '🌙 vigilante' <<<"$(ultimo 'j.text')" && ! grep -q 'Marca' <<<"$(ultimo 'j.text')" \
  && ok "2.30-T23 un rubro con texto en vez de número no llega al aviso al rearmar la sección" || no "2.30-T23 rubros alterados: $(ultimo 'j.text')"
# Slack: dependencias manda; el vigilante manda el suyo con la misma línea, y lo informa como no editado
echo '{ "version": 1, "owners": { "default": "lead@acme.example" }, "notify": { "channel": "slack" }, "site": { "url": "https://sitio.acme.example" } }' > "$D/ops-slack.json"
snap "$D" "$HOY" '{}'; reset_srv ok:1
RC=$(TYCON_NOTIFY_WEBHOOK_URL="$TYCON_TELEGRAM_API/hook/secreto" OPS_FILE="$D/ops-slack.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json")
[ "$RC" = 0 ] && [ "$(q "$D/out/dependencias-$HOY.json" 'j.resumen.canal + "|" + j.resumen.message_id')" = "slack|null" ] && [ "$(ultimo 'j.ruta')" = "/hook/secreto" ] \
  && [ "$(ultimo 'JSON.parse(j.raw).text.split("\n").pop()')" = "sitio: https://sitio.acme.example (probado 04:12 UTC)" ] \
  && ok "2.30-T23 Slack: dependencias sale por el webhook, con la línea del sitio y sin message_id" || no "2.30-T23 slack deps: rc=$RC · $(q "$D/out/dependencias-$HOY.json" 'j.resumen') · $(head -c 300 "$D/entregar.txt")"
vsnap "$D" "$HOY" '{}'; reset_srv ok:1
RC=$(TYCON_NOTIFY_WEBHOOK_URL="$TYCON_TELEGRAM_API/hook/secreto" OPS_FILE="$D/ops-slack.json" entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && [ "$(pedidos)" = 1 ] && [ "$(q "$D/vig/vigilante-$HOY.json" 'j.resumen.canal + "|" + j.resumen.editado')" = "slack|false" ] \
  && [ "$(ultimo 'JSON.parse(j.raw).text.split("\n").pop()')" = "sitio: https://sitio.acme.example (probado 04:12 UTC)" ] \
  && grep -q 'slack no edita' <<<"$(ultimo 'JSON.parse(j.raw).text.split("\n")[0]')" \
  && ! grep -q 'hook/secreto' "$D/entregar.txt" "$D/vig/vigilante-$HOY.json" "$D/out/dependencias-$HOY.json" \
  && ok "2.30-T23 Slack: el vigilante manda el suyo con la misma línea, editado false, y la dirección no queda en ningún lado" \
  || no "2.30-T23 slack vigilante: rc=$RC pedidos=$(pedidos) · $(q "$D/vig/vigilante-$HOY.json" 'j.resumen') · $(head -c 300 "$D/entregar.txt")"

# T33b — NO VIAJA al público: mira el paso «Listar los PR abiertos» del pipeline del vigilante, que
# es del repo del equipo (el vigilante de producción no se publica). El caso sigue en el repo privado; lo que
# el guion hace con `--extra` lo prueban T33, T33c, T33d y T33e acá.

# T25 Manana_LineaDelSitio — la versión del sitio en la mañana, del resultado del nocturno que lo actualiza: una línea
# fija antes de la del sitio, sólo con versiones y un motivo de la lista cerrada (nunca el texto libre del resultado)
penultima() { ultimo 'j.text.split("\n").slice(-2)[0]'; }
act() { printf '{"version":1,"plataforma":"azure","resultado":"%s","desde":%s,"hacia":%s,"hora":"%s","motivo":%s}\n' "$1" "$2" "$3" "$4" "$5" > "$D/su.json"; }
H25="${HOY}T03:05:00.000Z"
for caso in \
  'actualizado|"2026.10.15.48"|"2026.10.18.9"|null|sitio: actualizado de 2026.10.15.48 a 2026.10.18.9' \
  'al_dia|"2026.10.18.9"|"2026.10.18.9"|null|sitio: al día con la última publicada (2026.10.18.9)' \
  'aviso|"2026.10.15.48"|"2026.10.18.9"|null|sitio: hay una versión nueva, 2026.10.18.9; se actualiza a mano' \
  'pedido|null|"2026.10.18.9"|null|sitio: pedido de actualización a 2026.10.18.9 mandado' \
  'vuelto_atras|"2026.10.15.48"|"2026.10.18.9"|"la prueba sin sesión falló (https://sitio.acme.example/healthz 503)"|sitio: no se pudo actualizar a 2026.10.18.9, sigue en 2026.10.15.48 (la prueba sin sesión falló)' \
  'no_pudo|null|null|"no se pudo leer stable (sin red)"|sitio: no se pudo mirar la última publicada' \
  'no_pudo|null|null|"no se pudo leer site.update"|sitio: no se pudo leer site.update; revisar operations.json' \
  'no_pudo|null|null|"no se pudo leer el estado del actualizador"|sitio: no se pudo leer el estado del actualizador; no se tocó nada'; do
  IFS='|' read -r R DE HA MO ESP <<<"$caso"
  act "$R" "$DE" "$HA" "$H25" "$MO"; prueba paso - "${HOY}T04:12:30.000Z"; reset_srv ok:1
  RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json" --site-update "$D/su.json")
  [ "$RC" = 0 ] && [ "$(penultima)" = "$ESP" ] && [ "$(ultima_linea)" = "sitio: https://sitio.acme.example (probado 04:12 UTC)" ] \
    && ok "2.33-T25 ${R}: «${ESP}», antes de la línea del sitio" || no "2.33-T25 ${R}: rc=$RC · «$(penultima)» · última «$(ultima_linea)»"
  # el caso que trae texto libre en el motivo: ese texto (una dirección) no llega al mensaje, sólo el de la lista
  if [ "$R" = vuelto_atras ]; then
    if grep -q 'sitio.acme.example/healthz' <<<"$(ultimo 'j.text')"; then no "2.33-T25 🔴 el texto libre del motivo se coló al mensaje"; else ok "2.33-T25 el motivo libre del resultado no entra al mensaje (sólo el de la lista)"; fi
  fi
done
for sin in "$D/no-existe.json" ayer; do
  if [ "$sin" = ayer ]; then act al_dia '"2026.10.18.9"' '"2026.10.18.9"' "2026-01-01T03:05:00.000Z" null; F25="$D/su.json"; else F25="$sin"; fi
  prueba paso - "${HOY}T04:12:30.000Z"; reset_srv ok:1
  RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json" --site-update "$F25")
  [ "$(penultima)" = "sitio: sin el resultado del nocturno de hoy; el sitio dice al entrar si hay una versión nueva" ] \
    && ok "2.33-T25 sin un resultado de hoy (${sin##*/}): lo dice, sin inventar" || no "2.33-T25 sin resultado ${sin}: «$(penultima)»"
done
printf '{ roto' > "$D/su.json"; prueba paso - "${HOY}T04:12:30.000Z"; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json" --site-update "$D/su.json")
[ "$(penultima)" = "sitio: el resultado del nocturno de hoy no se pudo leer" ] && ok "2.33-T25 un resultado ilegible no se confunde con «sin resultado»" || no "2.33-T25 ilegible: «$(penultima)»"
prueba paso - "${HOY}T04:12:30.000Z"; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json")
[ "$(penultima)" != "sitio: sin el resultado del nocturno de hoy; el sitio dice al entrar si hay una versión nueva" ] && [ "$(ultima_linea)" = "sitio: https://sitio.acme.example (probado 04:12 UTC)" ] \
  && ok "2.33-T25 sin --site-update (una organización sin el nocturno), el mensaje queda como antes" || no "2.33-T25 sin la opción cambió: «$(penultima)»"

# Resumen_LatidoYRetroPorSeparado y Resumen_Faltan_LoDice — la línea de las retrospectivas, del informe
# que deja el barrido de la noche (`retro-sweep.js --report`, pasado con `--retros`): latido sin modelo y retro con
# aprendizajes por separado, lo que no pide retro y lo que falta. Sin `--retros`, el resumen no tiene esa línea.
retros() { # <archivo> <json de totales/repos>
  node -e 'const [f, j] = process.argv.slice(1); const r = JSON.parse(j);
    require("fs").writeFileSync(f, JSON.stringify({ schema: 1, hecho: "'"$HOY"'T03:30:00.000Z", desde: "'"$AYER"'", ...r }) + "\n")' "$1" "$2"
}
retros "$D/retros.json" '{"repos":[{"nombre":"acme-a","mirado":true,"merges":9,"latido":5,"aprendizajes":1,"no_piden":{"subida de versión":2},"faltan":[]},{"nombre":"acme-b","mirado":true,"merges":1,"latido":1,"aprendizajes":0,"no_piden":{},"faltan":[]}]}'
prueba paso - "${HOY}T04:12:30.000Z"; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json" --retros "$D/retros.json")
T7="$(ultimo 'j.text.split("\n").find((l) => l.startsWith("retros:")) || ""')"
[ "$RC" = 0 ] && [ "$T7" = "retros: 10 merges a main · latido sin modelo 6 · retro con aprendizajes 1 · no piden retro 2 · faltan 0" ] \
  && ok "1.26-T7 latido sin modelo y retro con aprendizajes, por separado y con esos nombres" || no "1.26-T7 rc=$RC · «${T7}» · $(tail -2 "$D/entregar.txt")"
retros "$D/retros.json" '{"repos":[{"nombre":"acme-a","mirado":true,"merges":3,"latido":1,"aprendizajes":0,"no_piden":{},"faltan":[{"sha":"abcdef1234567890","motivo":"el latido falló"}]},{"nombre":"acme-b","mirado":false,"motivo":"no se pudo bajar"}]}'
prueba paso - "${HOY}T04:12:30.000Z"; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json" --retros "$D/retros.json")
T8="$(ultimo 'j.text.split("\n").find((l) => l.startsWith("retros:")) || ""')"
[ "$RC" = 0 ] && [ "$T8" = "retros: 3 merges a main · latido sin modelo 1 · retro con aprendizajes 0 · no piden retro 0 · faltan 1 (acme-a abcdef1) · sin mirar: acme-b" ] \
  && ok "1.26-T8 lo que falta y el repo que no se miró salen en el resumen" || no "1.26-T8 rc=$RC · «${T8}»"
prueba paso - "${HOY}T04:12:30.000Z"; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json" --retros "$D/no-existe.json")
T8b="$(ultimo 'j.text.split("\n").find((l) => l.startsWith("retros:")) || ""')"
[ "$RC" = 0 ] && [ "$T8b" = "retros: ? (el barrido de la noche no dejó su informe)" ] \
  && ok "1.26-T8 sin el informe del barrido lo dice, no es «faltan 0»" || no "1.26-T8 sin informe: «${T8b}»"

# Nombres con espacios o acentos salen tal cual; un informe sin `no_piden` no se lee como «0».
retros "$D/retros.json" '{"repos":[{"nombre":"área ventas","mirado":true,"merges":1,"latido":0,"aprendizajes":0,"no_piden":{},"faltan":[{"sha":"abcdef1234567890","motivo":"x"}]},{"nombre":"Arnés del equipo","mirado":false}]}'
prueba paso - "${HOY}T04:12:30.000Z"; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json" --retros "$D/retros.json")
T8c="$(ultimo 'j.text.split("\n").find((l) => l.startsWith("retros:")) || ""')"
[ "$T8c" = "retros: 1 merges a main · latido sin modelo 0 · retro con aprendizajes 0 · no piden retro 0 · faltan 1 (área ventas abcdef1) · sin mirar: Arnés del equipo" ] \
  && ok "1.26-T8 nombres con espacios y acentos, tal cual" || no "1.26-T8 nombres: «${T8c}»"
retros "$D/retros.json" '{"repos":[{"nombre":"acme-a","mirado":true,"merges":2,"latido":1,"aprendizajes":0,"faltan":[]}]}'
prueba paso - "${HOY}T04:12:30.000Z"; reset_srv ok:1
RC=$(OPS_FILE="$D/ops-url.json" entregar "$D" dependencias "$HOY" --site-check "$D/check.json" --retros "$D/retros.json")
T8d="$(ultimo 'j.text.split("\n").find((l) => l.startsWith("retros:")) || ""')"
[ "$T8d" = "retros: ? (el informe del barrido no se pudo leer)" ] && ok "1.26-T8 un informe sin no_piden no se lee como cero" || no "1.26-T8 sin no_piden: «${T8d}»"

# ResumenDiario_DudasRepetidas — las dudas de los revisores, de las carpetas de corrida commiteadas del repo
# (`.advisors/pipeline-runs/*/findings.json`, `--runs`) de los últimos 7 días: la misma (revisor, regla) con dos o más
# «falsos» confirmados por un verificador, o con dos o más desacuerdos (el verificador reprodujo lo que el autor
# quería descartar). El texto sólo lleva la cantidad (regla del aviso: ningún nombre de regla sale a un servicio de
# afuera); el revisor, la regla y cuántas veces quedan en el `--json` y en la constancia. Sin dudas no sale nada;
# sin carpeta de corridas es `null` con su motivo, nunca «0».
# 🔴 Sale rojo si el rubro no existe, si cuenta un solo falso como duda, si cuenta una corrida de hace más de 7 días,
# si un `refuted` sin constancia del verificador suma, o si sin fuente dice 0 en vez de `null` con motivo.
D="$TMP/t-dudas"; mundo "$D"; snap "$D" "$HOY" '{}'
corrida_dudas() { # <dir-runs> <días atrás> <nombre> <json de findings>
  local dir="$1/$3-$(fecha "$HOY" "-$2" | tr -d '-')120000"
  mkdir -p "$dir"; printf '%s\n' "$4" > "$dir/findings.json"
}
# El resumen de la constancia sale de la lib (summary(build(...))), no escrito a mano: si cambia su forma, esta suite la sigue.
resumen_constancia() { # <refutado|reproducido> → el JSON que findings.json guarda en `refutation`
  node -e 'const R = require(process.argv[1] + "/skills/tycon-pipeline/scripts/lib/refutation.js");
    console.log(JSON.stringify(R.summary(R.build({ finding: { reviewer: "rev", rule: "R-0", file: "a.js", line: 1 }, authorReason: "r",
      verifier: { agent: "general-purpose@2026-09-20T10:00:00.000Z", model: "sonnet" }, verdict: process.argv[2], command: "node p.js", output: "salida" }))));' "$RAIZ" "$1"
}
FALSO="\"disposition\":\"refuted\",\"reason\":\"r\",\"refutation\":$(resumen_constancia refutado)"
DESACUERDO="\"disposition\":\"fixed\",\"reason\":\"r\",\"refutation\":$(resumen_constancia reproducido)"
mkdir -p "$D/runs"
corrida_dudas "$D/runs" 1 1.1 "[{\"rule_id\":\"R-1\",\"advisor\":\"rev-a\",\"file\":\"a.js\",$FALSO},{\"rule_id\":\"R-2\",\"advisor\":\"rev-b\",\"file\":\"a.js\",$FALSO}]"
corrida_dudas "$D/runs" 3 1.2 "[{\"rule_id\":\"R-1\",\"advisor\":\"rev-a\",\"file\":\"b.js\",$FALSO},{\"rule_id\":\"R-3\",\"advisor\":\"rev-c\",\"file\":\"b.js\",$DESACUERDO}]"
corrida_dudas "$D/runs" 4 1.3 "[{\"rule_id\":\"R-3\",\"advisor\":\"rev-c\",\"file\":\"c.js\",$DESACUERDO},{\"rule_id\":\"R-4\",\"advisor\":\"rev-d\",\"file\":\"c.js\",\"disposition\":\"refuted\",\"reason\":\"sin constancia\"},{\"rule_id\":\"R-4\",\"advisor\":\"rev-d\",\"file\":\"d.js\",\"disposition\":\"refuted\",\"reason\":\"sin constancia\"}]"
corrida_dudas "$D/runs" 20 1.4 "[{\"rule_id\":\"R-2\",\"advisor\":\"rev-b\",\"file\":\"z.js\",$FALSO},{\"rule_id\":\"R-2\",\"advisor\":\"rev-b\",\"file\":\"y.js\",$FALSO}]"
armar "$D" dependencias "$HOY" --runs "$D/runs" > "$D/dudas.json" 2>"$D/dudas.err"
DU="$(q "$D/dudas.json" 'j.dudas_revisores.valor.map((x) => [x.revisor, x.regla, x.falsos, x.desacuerdos].join("/")).sort().join(",")')"
[ "$DU" = "rev-a/R-1/2/0,rev-c/R-3/0/2" ] \
  && ok "1.21-T7 dos falsos confirmados (o dos desacuerdos) de la misma regla en la semana son una duda; uno solo, una ejecución vieja o un refuted sin constancia, no" \
  || no "1.21-T7 dudas: «${DU}» · $(head -c 300 "$D/dudas.err")"
TX="$(q "$D/dudas.json" 'j.texto.split("\n").filter((l) => l.startsWith("dudas de revisores:")).join("|")')"
[ "$TX" = "dudas de revisores: 2" ] && ok "1.21-T7 el texto lleva la cantidad y ningún nombre de revisor ni de regla" || no "1.21-T7 línea: «${TX}»"
grep -qE 'rev-a|R-1' <<<"$(q "$D/dudas.json" 'j.texto')" && no "1.21-T7 🔴 un revisor o una regla se coló al texto" || ok "1.21-T7 ni el revisor ni la regla están en el texto"
mkdir -p "$D/runs-sin"; corrida_dudas "$D/runs-sin" 1 1.1 "[{\"rule_id\":\"R-1\",\"advisor\":\"rev-a\",\"file\":\"a.js\",$FALSO}]"
armar "$D" dependencias "$HOY" --runs "$D/runs-sin" > "$D/sin.json" 2>/dev/null
[ "$(q "$D/sin.json" 'JSON.stringify(j.dudas_revisores.valor)')" = "[]" ] && [ "$(q "$D/sin.json" 'j.texto.includes("dudas de revisores")')" = "false" ] \
  && ok "1.21-T7 sin dudas no sale nada" || no "1.21-T7 sin dudas: $(q "$D/sin.json" 'JSON.stringify(j.dudas_revisores)')"
armar "$D" dependencias "$HOY" --runs "$D/no-existe" > "$D/nada.json" 2>/dev/null
[ "$(q "$D/nada.json" 'j.dudas_revisores.valor')" = "null" ] && [ -n "$(q "$D/nada.json" 'j.dudas_revisores.motivo')" ] && [ "$(q "$D/nada.json" 'j.dudas_revisores.motivo')" != "null" ] \
  && ok "1.21-T7 sin carpeta de ejecuciones es null con su motivo, no 0" || no "1.21-T7 sin fuente: $(q "$D/nada.json" 'JSON.stringify(j.dudas_revisores)')"
reset_srv ok:1; RC=$(entregar "$D" dependencias "$HOY" --runs "$D/runs")
[ "$RC" = 0 ] && [ "$(ultimo 'j.text.includes("dudas de revisores: 2")')" = "true" ] \
  && ok "1.21-T7 el resumen entregado trae la línea de las dudas" || no "1.21-T7 entrega rc=$RC"

# El revisor y la regla salen de un findings.json del repo; pasan por el mismo filtro de nombres que lineaRetros.
# 🔴 Sale rojo si un marcador en el revisor o en la regla llega tal cual al --json / a la constancia.
mkdir -p "$D/runs-marca"
corrida_dudas "$D/runs-marca" 1 1.1 "[{\"rule_id\":\"R-9\nGHP_MARCADOR_REGLA\",\"advisor\":\"rev-ok\",\"file\":\"a.js\",$FALSO},{\"rule_id\":\"R-8\",\"advisor\":\"rev;MARCADOR_REVISOR\",\"file\":\"a.js\",$FALSO}]"
corrida_dudas "$D/runs-marca" 2 1.2 "[{\"rule_id\":\"R-9\nGHP_MARCADOR_REGLA\",\"advisor\":\"rev-ok\",\"file\":\"b.js\",$FALSO},{\"rule_id\":\"R-8\",\"advisor\":\"rev;MARCADOR_REVISOR\",\"file\":\"b.js\",$FALSO}]"
armar "$D" dependencias "$HOY" --runs "$D/runs-marca" > "$D/marca.json" 2>/dev/null
grep -qE 'MARCADOR_REVISOR|MARCADOR_REGLA' "$D/marca.json" && no "1.21-W8 🔴 un marcador del revisor o de la regla llegó al --json" \
  || ok "1.21-W8 revisor y regla con caracteres raros salen como «?»"
[ "$(q "$D/marca.json" 'j.dudas_revisores.valor.length')" = "2" ] && ok "1.21-W8 las dudas siguen contadas" || no "1.21-W8 dudas: $(q "$D/marca.json" 'JSON.stringify(j.dudas_revisores)')"

# Un findings.json roto no es una corrida sin dudas. Se cuenta como «no leída»; si ninguna se pudo leer,
# es null con su motivo.
mkdir -p "$D/runs-mixto" "$D/runs-rotas"
corrida_dudas "$D/runs-mixto" 1 1.1 "[{\"rule_id\":\"R-1\",\"advisor\":\"rev-a\",\"file\":\"a.js\",$FALSO}]"
corrida_dudas "$D/runs-mixto" 2 1.2 "[{\"rule_id\":\"R-1\",\"advisor\":\"rev-a\",\"file\":\"b.js\",$FALSO}]"
corrida_dudas "$D/runs-mixto" 3 1.3 '{ roto'
armar "$D" dependencias "$HOY" --runs "$D/runs-mixto" > "$D/mixto.json" 2>/dev/null
[ "$(q "$D/mixto.json" 'j.dudas_revisores.no_leidas')" = "1" ] && [ "$(q "$D/mixto.json" 'j.dudas_revisores.valor.length')" = "1" ] \
  && ok "1.21-C2 una ejecución rota se cuenta como no leída y las demás siguen valiendo" || no "1.21-C2 mixto: $(q "$D/mixto.json" 'JSON.stringify(j.dudas_revisores)')"
corrida_dudas "$D/runs-rotas" 1 1.1 '{ roto'
corrida_dudas "$D/runs-rotas" 2 1.2 '{"no":"un array"}'
armar "$D" dependencias "$HOY" --runs "$D/runs-rotas" > "$D/rotas.json" 2>/dev/null
[ "$(q "$D/rotas.json" 'j.dudas_revisores.valor')" = "null" ] && [ "$(q "$D/rotas.json" 'j.dudas_revisores.no_leidas')" = "2" ] \
  && [ "$(q "$D/rotas.json" 'j.dudas_revisores.motivo')" != "null" ] \
  && ok "1.21-C2 si ninguna ejecución se pudo leer es null con motivo, no «sin dudas»" || no "1.21-C2 rotas: $(q "$D/rotas.json" 'JSON.stringify(j.dudas_revisores)')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T6 Resumen_CarpetasPorRepo @story-4.8 @ac-5 @ac-6
# La noche mira cada formulario; el resumen dice cuántas carpetas miró por repo, así un hueco se ve sin medir a mano,
# y la primera noche de las carpetas nuevas va en una línea por repo (sus altas no se anuncian esa noche).
D="$TMP/t48"; mundo "$D"
# Sólo cantidades, como manda el caso «el texto no nombra paquetes, repos…»: el detalle por repo queda en la foto.
snap "$D" "$HOY" '{"carpetas":[{"repo":"A/A","miradas":9,"total":9,"excluidas":[],"nuevas":0,"altas_nuevas":0},{"repo":"B/B","miradas":7,"total":8,"excluidas":[],"nuevas":8,"altas_nuevas":3},{"repo":"C/C","miradas":0,"total":null,"excluidas":[],"nuevas":0,"altas_nuevas":0}],"graves_en_carpetas_nuevas":3}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
T48=$(q "$D/a.json" 'j.texto')
{ grep -qF "Carpetas: 16 de 17, en 3 repo(s) (1 con hueco, 1 sin contar)" <<<"$T48" \
  && grep -qF "Carpetas nuevas: 8 en 1 repo(s), 3 alta(s) o crítica(s) que nadie miraba" <<<"$T48" \
  && ! grep -qE "A/A|B/B|C/C" <<<"$T48"; } \
  && ok "T6 4.8 el resumen cuenta las carpetas miradas, los huecos y las nuevas con sus altas, sin nombrar repos" || no "T6 4.8 carpetas: $T48"
D="$TMP/t48b"; mundo "$D"; snap "$D" "$HOY" '{}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" '/Carpetas/.test(j.texto)')" = false ] \
  && ok "T6 4.8 una foto de antes, sin la cuenta de carpetas, no inventa la línea" || no "T6 4.8 sin carpetas: $(q "$D/a.json" 'j.texto')"
D="$TMP/t48c"; mundo "$D"; snap "$D" "$HOY" '{"carpetas":[{"repo":"A/A","miradas":0,"total":null,"excluidas":[],"nuevas":0,"altas_nuevas":0}]}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
T48C=$(q "$D/a.json" 'j.texto')
{ grep -qF "Carpetas: sin contar, en 1 repo(s)" <<<"$T48C" && ! grep -q "^Carpetas: 0 de 0" <<<"$T48C"; } \
  && ok "T6 4.8 sin ningún repo contado no dice «0 de 0»: dice «sin contar»" || no "T6 4.8 0 de 0: $T48C"

echo
if [ "$FALLOS" -eq 0 ]; then echo "✅ resumen-diario: $TOTAL/$TOTAL"; exit 0; fi
echo "❌ resumen-diario: $FALLOS de $TOTAL en rojo"; exit 1
