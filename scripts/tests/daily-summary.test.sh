#!/usr/bin/env bash
# daily-summary.test.sh — red de scripts/nightly/dependencies/daily-summary.js (story 4.3).
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
# Rojo previo (declarado): el guion nace en esta story; antes de escribirlo, TODA la suite sale
# roja porque `daily-summary.js` no existe. Los casos de los pipelines (T17, T18) corren el paso
# REAL extraído del YAML por su displayName, con las macros de Azure sustituidas como lo hace ADO.
#
# Correr: bash scripts/tests/daily-summary.test.sh   (~45 s: T13 espera sus dos reintentos de 5 s
# y T13b el corte de 15 s de curl; ninguno se puede acortar sin mentir sobre lo que se prueba)

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RES="$RAIZ/scripts/nightly/dependencies/daily-summary.js"
# story 8.9: el YAML del pipeline puede llamar con el nombre nuevo o con el viejo (el alias lo sigue aceptando hasta el
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
    node "$RES" deliver --source vigilante --today "$H" --out "$D/vig" --pending "$D/vigpend" --deps-out "$D/out" "$@" > "$D/entregar.txt" 2>&1
  else
    node "$RES" deliver --source dependencies --today "$H" --out "$D/out" --pending "$D/pend" --config "$D/repos.json" \
      --summary-config "$D/resumen.json" --watcher-out "$D/vig" "$@" > "$D/entregar.txt" 2>&1
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
      message_id: p.message_id || null, text: p.text }) + "\n");
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
# T1 (AC 1) armar_dependencias_ocho_rubros
D="$TMP/t1"; mundo "$D"
snap "$D" "$HOY" '{"hallazgos":[{"id":"aaa11111","paquete":"browserslist","severidad":"high","repos":["A/A"],"noches":1},{"id":"bbb22222","paquete":"handlebars","severidad":"critical","repos":["B/B"],"noches":3}],"anunciados_hoy":["aaa11111"],"postergados_por_presupuesto":["bbb22222"]}'
ficha "$D" pending aaa11111 "$HOY" pendiente A/A
ficha "$D" promoted ccc33333 "$(fecha "$HOY" -4)" util A/A
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
CLAVES=$(q "$D/a.json" 'Object.keys(j.rubros).sort().join(",")')
ESPERADAS="aceptadas_sin_resolver,deuda_con_pedido_abierto,edad_mas_vieja,nuevos,pedidos_cerrados,pedidos_cerrados_con_vivas,pedidos_creados,pedidos_reabiertos,postergadas_por_presupuesto,proyectos_sin_iteracion,rechazadas_sin_deuda,resueltas_con_pedido_abierto,vivas_por_proyecto"
# (story 4.5: diez rubros — los dos del cruce se suman a los ocho de la 4.3; 2026-09-15: trece, con los pedidos creados, cerrados y reabiertos por el arnés)
[ "$CLAVES" = "$ESPERADAS" ] && ok "T1 armar devuelve los trece rubros de dependencias" || no "T1 rubros: esperaba [$ESPERADAS], obtuve [$CLAVES] ($(head -c 300 "$D/a.err"))"
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


# T1b (ADV-H) el desempate de la ficha más vieja no depende del idioma de la máquina
D="$TMP/t1b"; mundo "$D"; snap "$D" "$HOY" '{}'
ficha "$D" pending zz000001 "$(fecha "$HOY" -3)" pendiente A/A
ficha "$D" pending aa000001 "$(fecha "$HOY" -3)" pendiente A/A
LC_ALL=da_DK.UTF-8 LANG=da_DK.UTF-8 armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.rubros.edad_mas_vieja.id')" = aa000001 ] \
  && ok "T1b con dos vivas del mismo día, la más vieja es la de id menor también en un locale que ordena «aa» después de «z»" \
  || no "T1b desempate dependiente del locale: $(q "$D/a.json" 'j.rubros.edad_mas_vieja')"

# T1c (TEST-W4) sin snapshot de hoy, ilegible o que no es un objeto: armar sale 1 y entregar sale 3 sin mandar nada
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

# T1d (SILENT, clase) una ficha que no se puede leer es un FALLO dicho, no una caída del resumen entero
D="$TMP/t1d"; mundo "$D"; snap "$D" "$HOY" '{}'
ficha "$D" pending aaa11111 "$HOY" pendiente A/A
mkdir -p "$D/pend/pending/rota.yaml"      # un directorio con nombre de ficha: leerlo tira EISDIR (vale también como root)
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"; RC=$?
[ "$RC" = 0 ] && [ "$(q "$D/a.json" 'j.fallos.some(f => /no se pudo leer la ficha/.test(f) && /rota\.yaml/.test(f)) && j.rubros.vivas_por_proyecto.de === 1')" = true ] \
  && ok "T1d una ficha ilegible entra en fallos con su nombre y el resto del resumen se arma igual" || no "T1d ficha ilegible: rc=$RC · $(head -c 300 "$D/a.err") · $(q "$D/a.json" 'j.fallos')"

# T1e (revisor de pruebas, iter 2) la carpeta de fichas entera no se puede leer: los rubros de fichas son null con motivo
D="$TMP/t1e"; mundo "$D"; snap "$D" "$HOY" '{}'
node "$RES" build --source dependencies --today "$HOY" --out "$D/out" --pending "$D/no-existe" --config "$D/repos.json" --summary-config "$D/resumen.json" --watcher-out "$D/vig" --json > "$D/a.json" 2> "$D/a.err"; RC=$?
[ "$RC" = 0 ] && [ "$(q "$D/a.json" '["vivas_por_proyecto","edad_mas_vieja","aceptadas_sin_resolver"].every(k => j.rubros[k].valor === null && /no se pudieron leer las fichas/.test(j.rubros[k].motivo)) && j.fallos.some(f => /no se pudieron leer las fichas en/.test(f))')" = true ] \
  && ok "T1e sin carpeta de fichas legible: los tres rubros de fichas salen null con motivo y el fallo lo dice (nunca 0 vivas)" || no "T1e carpeta de fichas: rc=$RC · $(head -c 200 "$D/a.err") · $(q "$D/a.json" 'j.fallos')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T2 (AC 2) armar_sobre_la_foto_del_09_14 — la forma de esa noche, fabricada: tres hallazgos vivos, ninguno anunciado
# ni postergado, cinco fichas (una pendiente, cuatro aceptadas de las que dos ya se resolvieron).
# En el repo del equipo este caso leía el snapshot real de esa noche; en el público la foto se fabrica con la misma
# forma y los mismos números (el snapshot real es dato del equipo y no viaja). Esa noche corrió antes de la 4.4: sin
# `pedidos`, `cruce` ni `resumen`.
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
# T3 (AC 3) rubro_sin_fuente_es_null_con_motivo
D="$TMP/t3"; mundo "$D"
snap "$D" "$HOY" '{"rechazadas_sin_deuda_ids":["zzz99999"]}'
ficha "$D" pending zzz99999 "$HOY" pendiente A/A "rechazado: $HOY"
echo '{ "rubros_sin_fuente": { "rechazadas_sin_deuda": "la story 9.9 escribe la clave nueva" } }' > "$D/resumen.json"
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.rubros.rechazadas_sin_deuda.valor === null && j.rubros.rechazadas_sin_deuda.motivo.includes("la story 9.9 escribe la clave nueva")')" = true ] \
  && ok "T3 un rubro declarado sin fuente sale null con ESE motivo, aunque el snapshot traiga el dato" || no "T3 declarado: $(q "$D/a.json" 'j.rubros.rechazadas_sin_deuda')"
grep -q 'sin fuente todavía: la story 9.9 escribe la clave nueva' <<<"$(q "$D/a.json" 'j.texto')" \
  && ok "T3 el texto lo dice «sin fuente todavía: <motivo>»" || no "T3 el texto no dice «sin fuente todavía»: $(q "$D/a.json" 'j.texto')"
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


# T3b (ADV-E) `rubros_sin_fuente` vale también para los rubros del vigilante
D="$TMP/t3b"; mundo "$D"; vsnap "$D" "$HOY" '{}'
vficha "$D" pending 2026-09-05-globex-cccc3333 2026-09-05 pendiente
echo '{ "rubros_sin_fuente": { "pendientes": "la story 9.9 trae la fuente de pendientes" } }' > "$D/resumen.json"
armar "$D" vigilante "$HOY" --summary-config "$D/resumen.json" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.rubros.pendientes.valor === null && /la story 9\.9 trae la fuente de pendientes/.test(j.rubros.pendientes.motivo || "") && /sin fuente todavía: la story 9\.9/.test(j.texto)')" = true ] \
  && ok "T3b un rubro del vigilante declarado sin fuente sale null con su motivo y el texto lo dice" || no "T3b vigilante sin fuente: $(q "$D/a.json" '[j.rubros && j.rubros.pendientes, j.texto]')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T4 (AC 4) cambio_desde_ayer_arriba
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

# T4b (AC 4) mismo_conteo_distintos_ids_es_cambio
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

# T4c (AC 4b) null_contra_numero_es_cambio
D="$TMP/t4c"; mundo "$D"
snap "$D" "$AYER" '{"hallazgos":[{"id":"bbb22222","paquete":"handlebars","severidad":"critical","repos":["B/B"],"noches":3}],"postergados_por_presupuesto":["bbb22222"]}'
sellar "$D" "$AYER"
snap "$D" "$HOY" '{"postergados_por_presupuesto":"__BORRAR__"}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.rubros.postergadas_por_presupuesto.valor === null && Array.isArray(j.cambios) && j.cambios.includes("postergadas_por_presupuesto") && /pasó a no medido/.test(j.texto)')" = true ] \
  && ok "T4c un número de ayer contra un null de hoy es cambio y se dice «pasó a no medido»" || no "T4c null contra número: $(q "$D/a.json" '[j.rubros.postergadas_por_presupuesto, j.cambios, j.texto]')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T5 (AC 5) sin_cambios_son_tres_lineas_y_se_manda — con la edad creciendo un día (no es cambio)
D="$TMP/t5"; mundo "$D"
PEDIDOS_OK='{"pedidos":{"simulado":false,"tope":2,"fichas_vivas":1,"fichas_sin_pedido":0,"creados":[],"adoptados":[],"existentes":1,"fallidos":[],"postergados":[],"sin_iteracion":[],"sin_dueno_unico":[],"pagados_avisados":[],"deuda_avisada":[],"sin_pedido":[]}}'
snap "$D" "$AYER" "$PEDIDOS_OK"; snap "$D" "$HOY" "$PEDIDOS_OK"
ficha "$D" pending eee55555 "$(fecha "$HOY" -6)" pendiente A/A
ficha "$D" promoted fff66666 "$(fecha "$HOY" -9)" util B/B
sellar "$D" "$AYER"
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'JSON.stringify(j.cambios) + "|" + j.fallos.length + "|" + j.texto.split("\n").length')" = '[]|0|3' ] \
  && ok "T5 ayer = hoy y sin fallos: cero cambios (la edad que crece no cuenta) y el texto son tres líneas" || no "T5: $(q "$D/a.json" '[j.cambios, j.fallos, j.texto]')"
[ "$(q "$D/a.json" 'j.texto.split("\n")[0].startsWith("Sin cambios desde ayer · 2 vivas · 1 aceptadas sin resolver · 0 postergadas") && j.texto.split("\n")[1] === "Sigue igual (13 rubros)"')" = true ] \
  && ok "T5 primera línea «Sin cambios desde ayer · …» y segunda «Sigue igual (13 rubros)»" || no "T5 forma: $(q "$D/a.json" 'j.texto')"
reset_srv ok:501; RC=$(entregar "$D" dependencias "$HOY")
[ "$RC" = 0 ] && [ "$(pedidos)" = 1 ] && ok "T5 la noche sin cambios SE ENTREGA igual (un POST, sale 0): el silencio no es un canal" || no "T5 entrega sin cambios: rc=$RC pedidos=$(pedidos) · $(cat "$D/entregar.txt")"

# T5b (AC 2, forma) el_tope_de_telegram — muchas fichas no rompen el mensaje
D="$TMP/t5b"; mundo "$D"
HALL=$(node -e 'const a=[];for(let i=0;i<60;i++)a.push({id:"n"+String(i).padStart(7,"0"),paquete:"paquete-con-nombre-largo-"+i,severidad:"high",repos:["A/A"],noches:1});console.log(JSON.stringify(a))')
snap "$D" "$HOY" "{\"hallazgos\":$HALL,\"anunciados_hoy\":$(node -e 'console.log(JSON.stringify(Array.from({length:60},(_, i)=>"n"+String(i).padStart(7,"0"))))'),\"postergados_por_presupuesto\":$(node -e 'console.log(JSON.stringify(Array.from({length:40},(_, i)=>"n"+String(i).padStart(7,"0"))))')}"
for i in $(seq 0 59); do ficha "$D" pending "n$(printf '%07d' "$i")" "$HOY" pendiente A/A; done
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.texto.split("\n").length <= 23 && j.texto.length <= 2000 && /\(\+\d+ más\)/.test(j.texto)')" = true ] \
  && ok "T5b 60 hallazgos: la sección de dependencias cabe en su presupuesto (≤23 líneas, ≤2000 caracteres) y corta con «(+N más)»" \
  || no "T5b tope: $(q "$D/a.json" 'j.texto.split("\n").length + " líneas, " + j.texto.length + " caracteres"')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T6 (AC 6) fallos_siempre_arriba
D="$TMP/t6"; mundo "$D"
snap "$D" "$AYER" '{}'
sellar "$D" "$AYER" null "⚠ telegram-notify: no hay token (ni \$TELEGRAM_BOT_TOKEN ni /x/.env) — NO se mandó el aviso."
snap "$D" "$HOY" '{"corrida_completa":false,"no_medidos":[{"ruta":"B/B","motivo":"el restore falló"}]}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
[ "$(q "$D/a.json" 'j.fallos.length === 3 && j.fallos.some(f => /B\/B/.test(f) && /el restore falló/.test(f)) && j.fallos.some(f => /incompleta/.test(f)) && j.fallos.some(f => /no se entregó/.test(f) && /no hay token/.test(f))')" = true ] \
  && ok "T6 fallos: el repo no medido con su motivo, la corrida incompleta y el resumen de ayer que no se entregó" || no "T6 fallos: $(q "$D/a.json" 'j.fallos')"
[ "$(q "$D/a.json" '(() => { const t = j.texto, a = t.indexOf("Fallos"), b = t.indexOf("Sigue igual ("); return a > 0 && (b === -1 || a < b) && t.includes("el restore falló"); })()')" = true ] \
  && ok "T6 los fallos van en el texto antes de «Sigue igual»" || no "T6 lugar de los fallos: $(q "$D/a.json" 'j.texto')"
[ "$(q "$D/a.json" 'j.fallos.some(f => /pull request/i.test(f))')" = false ] \
  && ok "T6 ninguna línea fija sobre los pull requests en fallos" || no "T6 apareció una línea fija de PR: $(q "$D/a.json" 'j.fallos')"
snap "$D" "$HOY" '{"pedidos":{"simulado":false,"tope":2,"fichas_vivas":1,"fichas_sin_pedido":1,"creados":[],"adoptados":[],"existentes":0,"fallidos":[{"ficha":"a1","proyecto":"ProyA","paso":"crear","motivo":"TF401027 sin permiso"},{"ficha":"a1","proyecto":"ProyA","paso":"comentario","motivo":"otro"}],"postergados":[],"sin_iteracion":[],"sin_dueno_unico":[{"proyecto":"ProyA","motivo":"tres administradores"}],"pagados_avisados":[],"deuda_avisada":[],"sin_pedido":[]}}'
armar "$D" dependencias "$HOY" > "$D/b.json" 2>/dev/null
[ "$(q "$D/b.json" 'j.fallos.some(f => /pedidos/.test(f) && /TF401027/.test(f)) && j.fallos.some(f => /dueño único/.test(f) && /tres administradores/.test(f))')" = true ] \
  && ok "T6 con \`pedidos\`: sus fallidos y los proyectos sin dueño único entran en fallos" || no "T6 fallos de pedidos: $(q "$D/b.json" 'j.fallos')"


# T6b (ADV-A) una CADENA de noches sin entregar queda escrita entera en el primer resumen que llega —
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
# T6c antes de que la pieza existiera ninguna noche dejó constancia: eso NO es una cadena de fallas
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
# T7 (AC 7) vigilante_viejo_entra_en_fallos
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
# T8 (AC 8) armar_vigilante_cinco_rubros
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


# T8b (ADV-B) `story_creada` vacía —null, ~, "" o null con comentario— NO es una story
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
# T9 (AC 9) approve_nombra_la_clave — NO VIAJA al público: miraba el comando del vigilante (`commands/tycon-vigilante.md`),
# que es del repo del equipo. El vigilante de producción no se publica (story 8.30); el caso sigue en el repo privado.

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T10 (AC 10) entregar_manda_y_guarda_message_id
D="$TMP/t10"; mundo "$D"
snap "$D" "$HOY" '{"hallazgos":[{"id":"aaa11111","paquete":"browserslist","severidad":"high","repos":["A/A"],"noches":1}],"anunciados_hoy":["aaa11111"]}'
ficha "$D" pending aaa11111 "$HOY" pendiente A/A
armar "$D" dependencias "$HOY" > "$D/a.json" 2>/dev/null
cp "$D/out/dependencias-$HOY.json" "$D/antes.json"
reset_srv ok:777; RC=$(entregar "$D" dependencias "$HOY")
[ "$RC" = 0 ] && ok "T10 entregar sale 0 cuando Telegram acepta" || no "T10 rc=$RC · $(cat "$D/entregar.txt")"
[ "$(pedidos)" = 1 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] && [ "$(ultimo 'j.token_ok')" = true ] \
  && ok "T10 un solo POST a sendMessage con el token del canal" || no "T10 pedidos=$(pedidos) ruta=$(ultimo 'j.ruta')"
[ "$(pedidos)" = 1 ] && [ "$(q "$D/a.json" 'typeof j.texto === "string" && j.texto.length > 0')" = true ] && [ "$(ultimo 'j.text')" = "$(q "$D/a.json" 'j.texto')" ] && ok "T10 el texto mandado es exactamente el de armar" || no "T10 el texto mandado difiere del de armar"
[ "$(q "$D/out/dependencias-$HOY.json" 'JSON.stringify([j.resumen.canal, j.resumen.message_id, j.resumen.editado, j.resumen.motivo, typeof j.resumen.entregado_el])')" = '["telegram",777,null,null,"string"]' ] \
  && ok "T10 el snapshot guarda resumen {canal, message_id 777, editado null, motivo null, entregado_el}" || no "T10 resumen: $(q "$D/out/dependencias-$HOY.json" 'j.resumen')"
if grep -q 'tok-de-prueba-que-no-debe-aparecer\|990011223344' "$D/entregar.txt" "$D/out/dependencias-$HOY.json"; then
  no "T10 🔴 el token o el chat_id aparecen en la salida o en el snapshot"
else ok "T10 ni el token ni el chat_id aparecen en la salida ni en el snapshot"; fi

# T10b (AC 10, --dry-run) no manda, no escribe, no muestra el destinatario
D="$TMP/t10b"; mundo "$D"; snap "$D" "$HOY" '{}'
cp "$D/out/dependencias-$HOY.json" "$D/antes.json"
reset_srv ok:1; RC=$(entregar "$D" dependencias "$HOY" --dry-run)
[ "$RC" = 0 ] && [ "$(pedidos)" = 0 ] && cmp -s "$D/antes.json" "$D/out/dependencias-$HOY.json" && ! grep -q '990011223344' "$D/entregar.txt" \
  && ok "T10b --dry-run: cero POST, el snapshot intacto y sin el chat_id en la salida" || no "T10b dry-run: rc=$RC pedidos=$(pedidos) · $(head -c 400 "$D/entregar.txt")"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T11 (AC 11) vigilante_edita_el_mensaje_del_dia
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

# T11b (AC 11b) sin_mensaje_de_dependencias_manda_nuevo
D="$TMP/t11b"; mundo "$D"
snap "$D" "$HOY" '{}'; sellar "$D" "$HOY" null "⚠ telegram-notify: no hay token — NO se mandó el aviso."
vsnap "$D" "$HOY" '{}'
reset_srv ok:888; RC=$(entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] && grep -q 'dependencias no entregó su resumen hoy' <<<"$(ultimo 'j.text.split("\n")[0]')" && grep -q 'no hay token' <<<"$(ultimo 'j.text.split("\n")[0]')" \
  && ok "T11b dependencias no entregó: el vigilante manda uno NUEVO que lo dice en la primera línea, con el motivo" || no "T11b: rc=$RC ruta=$(ultimo 'j.ruta') · $(ultimo 'j.text')"
[ "$(q "$D/vig/vigilante-$HOY.json" 'j.resumen.editado')" = false ] && ok "T11b editado: false" || no "T11b editado: $(q "$D/vig/vigilante-$HOY.json" 'j.resumen')"
rm -f "$D/out/dependencias-$HOY.json"; vsnap "$D" "$HOY" '{}'
reset_srv ok:889; RC=$(entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] && grep -q 'dependencias no entregó su resumen hoy' <<<"$(ultimo 'j.text')" \
  && ok "T11b sin snapshot de dependencias de hoy: también mensaje nuevo que lo dice" || no "T11b sin snapshot: rc=$RC · $(cat "$D/entregar.txt")"

# T11c (AC 11) la edición rechazada por Telegram cae a un mensaje nuevo, y lo dice
D="$TMP/t11c"; mundo "$D"
snap "$D" "$HOY" '{}'; sellar "$D" "$HOY" 555
vsnap "$D" "$HOY" '{}'
reset_srv "$(printf 'rechaza:Bad Request: message to edit not found\nok:556')"
RC=$(entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && grep -q '/editMessageText' "$TMP/pedidos.jsonl" && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] && [ "$(q "$D/vig/vigilante-$HOY.json" 'j.resumen.editado + "|" + j.resumen.message_id')" = "false|556" ] \
  && ok "T11c mensaje que ya no se puede editar: cae a uno nuevo (editado false) en vez de reintentar la edición" \
  || no "T11c: rc=$RC · $(head -c 400 "$TMP/pedidos.jsonl") · $(q "$D/vig/vigilante-$HOY.json" 'j.resumen')"

# T11d (AC 11) «message is not modified» es entregado (el texto ya estaba)
D="$TMP/t11d"; mundo "$D"
snap "$D" "$HOY" '{}'; sellar "$D" "$HOY" 555
vsnap "$D" "$HOY" '{}'
reset_srv "rechaza:Bad Request: message is not modified: specified new message content and reply markup are exactly the same"
RC=$(entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && [ "$(pedidos)" = 1 ] && [ "$(q "$D/vig/vigilante-$HOY.json" 'j.resumen.editado + "|" + j.resumen.message_id + "|" + j.resumen.motivo')" = "true|555|null" ] \
  && ok "T11d «message is not modified»: cuenta como entregado, sin reintentos" || no "T11d: rc=$RC pedidos=$(pedidos) · $(q "$D/vig/vigilante-$HOY.json" 'j.resumen')"


# T11e (ADV-C) si la sección de dependencias no se puede rearmar, el vigilante NO pisa el mensaje de las 04:00
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

# T11f (ADV-D) la sección que el vigilante vuelve a escribir es la de las 04:00, con sus fallos
D="$TMP/t11f"; mundo "$D"; snap "$D" "$HOY" '{}'
rm -f "$D/resumen.json"                     # a las 04:00 no se pudo leer resumen.json: es un fallo de esa noche
reset_srv ok:700; entregar "$D" dependencias "$HOY" >/dev/null
L04=$(tail -1 "$TMP/pedidos.jsonl" > "$TMP/p04.json"; q "$TMP/p04.json" 'j.text')
vsnap "$D" "$HOY" '{}'
reset_srv ok:700; RC=$(entregar "$D" vigilante "$HOY")
grep -q 'no se pudo leer summary.json' <<<"$L04" && [ "$RC" = 0 ] && grep -q 'no se pudo leer summary.json' <<<"$(ultimo 'j.text')" \
  && ok "T11f la edición de las 08:00 conserva los fallos que dijo el mensaje de las 04:00" || no "T11f fallos perdidos en la edición: rc=$RC · 04:00=[$L04] · 08:00=[$(ultimo 'j.text')]"

# T11g (ADV-G) dependencias entregó pero sin message_id: el vigilante va aparte y NO dice que no entregó
D="$TMP/t11g"; mundo "$D"; snap "$D" "$HOY" '{}'; sellar "$D" "$HOY" 1
constancia "$D/out/dependencias-$HOY.json" "$(q "$D/out/dependencias-$HOY.json" '({ ...j.resumen, message_id: null, entregado_el: "2000-01-01T04:00:00Z", motivo: null })')"
vsnap "$D" "$HOY" '{}'
reset_srv ok:801; RC=$(entregar "$D" vigilante "$HOY")
L1=$(ultimo 'j.text.split("\n")[0]')
[ "$RC" = 0 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] && ! grep -q 'no entregó' <<<"$L1" && grep -q 'entregó' <<<"$L1" \
  && ok "T11g sin message_id para editar, el mensaje aparte dice que dependencias SÍ entregó" || no "T11g primera línea engañosa: rc=$RC · «${L1}»"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T11h (revisor de pruebas, iter 2) el snapshot de dependencias de hoy está ilegible: el vigilante manda uno nuevo y lo dice
D="$TMP/t11h"; mundo "$D"; echo 'esto no es json' > "$D/out/dependencias-$HOY.json"; vsnap "$D" "$HOY" '{}'
reset_srv ok:901; RC=$(entregar "$D" vigilante "$HOY")
[ "$RC" = 0 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/sendMessage" ] && grep -q 'dependencias no entregó su resumen hoy: su snapshot de hoy está ilegible' <<<"$(ultimo 'j.text.split("\n")[0]')" \
  && ok "T11h snapshot de dependencias ilegible: mensaje nuevo cuya primera línea lo dice" || no "T11h: rc=$RC · $(ultimo 'j.text.split("\n")[0]')"

# T12 (AC 12) sin_config_sale_3_con_el_motivo_del_script
D="$TMP/t12"; mundo "$D"; snap "$D" "$HOY" '{}'
reset_srv ok:1
RC=$(TYCON_TELEGRAM_DIR="$TMP/canal-vacio" entregar "$D" dependencias "$HOY")
[ "$RC" = 3 ] && [ "$(pedidos)" = 0 ] && [ "$(q "$D/out/dependencias-$HOY.json" 'j.resumen.message_id === null && /no hay token/.test(j.resumen.motivo) && j.resumen.entregado_el === null')" = true ] \
  && ok "T12 sin token: cero POST, message_id null, motivo con la línea del script («no hay token»), sale 3" || no "T12: rc=$RC pedidos=$(pedidos) · $(q "$D/out/dependencias-$HOY.json" 'j.resumen')"

# T13 (AC 13) telegram_rechaza_reintenta_y_lo_dice
D="$TMP/t13"; mundo "$D"; snap "$D" "$HOY" '{}'
reset_srv "rechaza:Bad Request: chat not found"
RC=$(entregar "$D" dependencias "$HOY")
[ "$RC" = 3 ] && [ "$(pedidos)" = 3 ] && [ "$(q "$D/out/dependencias-$HOY.json" 'j.resumen.message_id === null && /chat not found/.test(j.resumen.motivo)')" = true ] \
  && ok "T13 Telegram rechaza: 3 intentos (2 reintentos), motivo con la respuesta, sale 3" || no "T13: rc=$RC pedidos=$(pedidos) · $(q "$D/out/dependencias-$HOY.json" 'j.resumen')"

# T13b (AC 13b) telegram_muda_termina — con un perro guardián de 60 s (macOS no trae `timeout`)
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
# T14 (AC 14) resumen_se_escribe_despues_y_solo_eso  (sobre el snapshot del T13b y del T10)
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


# T14b (SILENT-W) un error inesperado del guion sale en UNA línea (no un stack) y deja constancia con el motivo
D="$TMP/t14b"; mundo "$D"; snap "$D" "$HOY" '{}'
reset_srv ok:1
RC=$(TYCON_SUMMARY_INJECT_FAILURE=1 entregar "$D" dependencias "$HOY")
[ "$RC" = 3 ] && [ "$(pedidos)" = 0 ] && tail -n 1 "$D/entregar.txt" | grep 'error inesperado' >/dev/null && ! grep -qE '^\s+at ' "$D/entregar.txt" \
  && [ "$(q "$D/out/dependencias-$HOY.json" 'j.resumen && j.resumen.message_id === null && /error inesperado/.test(j.resumen.motivo)')" = true ] \
  && ok "T14b un error inesperado: sale 3, la última línea lo dice sin stack, y el snapshot queda con el motivo" \
  || no "T14b error inesperado: rc=$RC · $(tail -c 400 "$D/entregar.txt")"

# T14c (revisor de pruebas, iter 2) el error inesperado también por `armar`: una línea, sale 1, sin constancia
D="$TMP/t14c"; mundo "$D"; snap "$D" "$HOY" '{}'; cp "$D/out/dependencias-$HOY.json" "$D/antes.json"
TYCON_SUMMARY_INJECT_FAILURE=1 node "$RES" build --source dependencies --today "$HOY" --out "$D/out" --pending "$D/pend" --config "$D/repos.json" --summary-config "$D/resumen.json" --watcher-out "$D/vig" > "$D/a.txt" 2>&1; RC=$?
[ "$RC" = 1 ] && tail -n 1 "$D/a.txt" | grep 'error inesperado' >/dev/null && ! grep -qE '^\s+at ' "$D/a.txt" && cmp -s "$D/antes.json" "$D/out/dependencias-$HOY.json" \
  && ok "T14c armar con un error inesperado sale 1 en una línea y no toca el snapshot" || no "T14c: rc=$RC · $(tail -c 300 "$D/a.txt")"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T15, T15b, T15c, T15d, T16, T16b (AC 15, 16) — los casos del aviso viven en el BANCO de controles
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
# T15-paridad (AC 15, 16) — el guion que deja la constancia y el aviso que la cobra usan LA MISMA regla
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
# T17 / T18 (AC 17, 18) — los pasos REALES de los pipelines
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
}
BASE_OK=1; git -C "$RAIZ" rev-parse --verify --quiet origin/main >/dev/null || BASE_OK=0
# story 8.9: el renombre de una opción o de un archivo del arnés a inglés (mapa de renombres) no es «tocar el paso»: los
# dos lados se comparan con cada `--viejo` pasado a `--nuevo` y cada ruta vieja a la nueva. Sin mapa, el texto tal cual.
# Tanda F: la carpeta de la cola (`--queue`) también es una ruta, así que una carpeta mudada (`kind: folder` del mapa)
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
# story 8.12 (tanda R6): los yml pasaron a pipelines/. Hasta el merge, origin/main los tiene en su ruta de antes: se lee
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
  # nuevo de la rama. Antes salía rojo «nomain» cada noche (corrida del 2026-10-15).
  [ "$rc" = 0 ] || { echo "NO MEDIDO — origin/main de este repo no tiene $1: no hay paso de antes contra el cual comparar"; return; }
  git -C "$RAIZ" show "origin/main:$pub" > "$TMP/main.yml" 2>/dev/null || { echo nomain; return; }
  # la condición de `efectos` (story 8.26 B: una corrida de prueba no abre pedidos ni avisa) no es un cambio del paso:
  # se saca de los dos lados, y sólo esa línea (la fija pipelines-moved.test.js, T7)
  local sin_efectos="condition: and(succeeded(), eq('\${{ parameters.efectos }}', 'true'))"
  [ "$(region "$RAIZ/$1" "$2" | opciones_nuevas | grep -vF "$sin_efectos")" = "$(region "$TMP/main.yml" "$2" | opciones_nuevas | grep -vF "$sin_efectos")" ] && echo true || echo false
}

# En el público el paso real es el del MODELO de la revisión nocturna (pipelines/operations/dependency-audit.yml, story
# 8.30), con sus nombres de pasos. T18 (el pipeline del vigilante) no viaja: el vigilante de producción es del repo del
# equipo, y sus casos siguen allá. Tampoco viaja el chequeo del grupo de variables `vigilante-prod-hosts`, que era del
# pipeline del equipo: el modelo no carga grupos.
for CASO in dependencias; do
  T=T17; Y="$RAIZ/pipelines/operations/dependency-audit.yml"; YREL=pipelines/operations/dependency-audit.yml
  ANTES='Crear los pedidos de trabajo'; DESPUES='Guardar el snapshot y las fichas en el repo de operaciones'
  INTACTOS=("Abrir un pull request por hallazgo (ahí se decide)"); SNAP=".dashboard/dependencias/dependencias-$HOY.json"
  DISP='Entregar el resumen (si hay bot de Telegram)'
  [ "$(orden "$Y" "$ANTES" "$DISP" "$DESPUES")" = true ] \
    && ok "$T el paso «${DISP}» está entre «${ANTES}» y «${DESPUES}»" || no "$T el paso «${DISP}» no está entre «${ANTES}» y «${DESPUES}»"
  REG=$(region "$Y" "$DISP" 2>/dev/null || true)
  grep -q 'continueOnError: true' <<<"$REG" && grep -q 'TELEGRAM_BOT_TOKEN: $(TELEGRAM_BOT_TOKEN)' <<<"$REG" && grep -q 'TYCON_TELEGRAM_CHAT_ID: $(TYCON_TELEGRAM_CHAT_ID)' <<<"$REG" \
    && ok "$T el paso lleva continueOnError: true y las dos variables del canal en env" || no "$T al paso le falta continueOnError o las variables del canal"
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
done

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T30 (story 4.5, AC 15) resumen_lee_el_cruce — dos rubros que LEEN `cruce`, nunca un 0 sin fuente
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
[ "$(q "$D/a.json" 'j.texto.includes("pedidos cerrados con la vulnerabilidad viva: 1") && j.texto.includes("aaa11111 → ProyA (Bug 101")')" = true ] \
  && ok "T30 el texto nombra la ficha, el proyecto y el Bug cerrado con la vulnerabilidad viva" || no "T30 texto: $(q "$D/a.json" 'j.texto')"
snap "$D" "$HOY" '{"cruce":{"consultado":true,"motivo":null,"cerrados_vivos":[],"resueltas_con_pedido_abierto":[],"no_leidos":[],"huerfanos":[],"huerfanos_no_consultados":[{"proyecto":"Proy B","motivo":"no pude consultar los Bugs del arnés (salió 1)"}]}}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" 'j.fallos.some(f => /^cruce: no se pudo buscar Bugs sueltos en 1 proyecto\(s\) — Proy B/.test(f))')" = true ] \
  && ok "T30 (5b) un proyecto donde no se pudo buscar Bugs sueltos es un fallo de la noche, no un silencio" || no "T30 no consultados: $(q "$D/a.json" 'j.fallos')"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T31 (2026-09-15) la_noche_que_se_encendieron_los_pedidos — el mensaje real de ese día, corregido.
# Llegó «5 cambio(s) desde ayer» con cinco renglones en 0 y SIN nombrar los tres Bugs que la noche
# había creado de verdad (5173, 5174, 5175): tres rubros «cambiaron» sólo porque `simulado` pasó a
# false, dos eran rubros nuevos que se midieron por primera vez, y el que sí cambió (un pedido
# postergado que salió) no decía qué había antes. El ayer se sella con la forma de la constancia de
# ese día: sin los rubros que nacieron después (se borran del sello).
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
[ "$(q "$D/a.json" '["Bug 5173 (ProyA, 3788493d)", "Bug 5174 (Proy B, 94dbbf29)", "Bug 5175 (ProyA, ea4e7794)"].every(b => j.texto.includes(b))')" = true ] \
  && ok "T31 🔴 el resumen nombra los Bugs que la noche creó, con proyecto y ficha" || no "T31 no nombra los Bugs creados: $(q "$D/a.json" 'j.texto') ($(head -c 200 "$D/a.err"))"
[ "$(q "$D/a.json" 'Array.isArray(j.cambios) && !j.cambios.includes("deuda_con_pedido_abierto") && !j.cambios.includes("proyectos_sin_iteracion") && /^Pedidos de trabajo: encendidos \(ayer estaban en simulado\)\.$/m.test(j.texto)')" = true ] \
  && ok "T31 🔴 pasar de simulado a real no es un cambio de cada rubro: es UNA línea «Pedidos de trabajo: encendidos»" || no "T31 modo: $(q "$D/a.json" '[j.cambios, j.texto]')"
[ "$(q "$D/a.json" '!j.cambios.includes("pedidos_cerrados_con_vivas") && !j.cambios.includes("resueltas_con_pedido_abierto") && /^Empezó a medirse, sin novedad: Bugs cerrados por el arnés, Bugs reabiertos por el arnés, pedidos cerrados con la vulnerabilidad viva, resueltas con pedido abierto$/m.test(j.texto) && !/antes no medido/.test(j.texto)')" = true ] \
  && ok "T31 🔴 un rubro que se mide por primera vez y viene vacío no es un cambio: una línea «Empezó a medirse»" || no "T31 rubros nuevos: $(q "$D/a.json" '[j.cambios, j.texto]')"
[ "$(q "$D/a.json" '/^• postergadas por presupuesto: 0 hallazgo\(s\) · pedidos: 0 \(antes 0 hallazgo\(s\) · pedidos: 1\)$/m.test(j.texto)')" = true ] \
  && ok "T31 🔴 el cambio dice qué había antes" || no "T31 sin «antes»: $(q "$D/a.json" 'j.texto')"
[ "$(q "$D/a.json" 'JSON.stringify(j.cambios) === JSON.stringify(["pedidos_creados", "postergadas_por_presupuesto"]) && j.texto.startsWith("2 cambio(s) desde ayer") && /^Sigue igual \(7 rubros\)$/m.test(j.texto)')" = true ] \
  && ok "T31 la cuenta: 2 cambios (los Bugs y el postergado que salió), 4 rubros que empezaron, 7 que siguen igual" || no "T31 cuenta: $(q "$D/a.json" '[j.cambios, j.texto]')"
# El espejo: una noche que se APAGA vuelve a simulado — también es una línea, no tres cambios.
D="$TMP/t31b"; mundo "$D"
snap "$D" "$AYER" '{"pedidos":{"simulado":false,"creados":[],"adoptados":[],"fallidos":[],"postergados":[],"sin_iteracion":[],"deuda_avisada":[]}}'
sellar "$D" "$AYER"
snap "$D" "$HOY" '{"pedidos":{"simulado":true,"creados":[],"adoptados":[],"fallidos":[],"postergados":[],"sin_iteracion":[],"deuda_avisada":[]}}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" 'JSON.stringify(j.cambios) === "[]" && /^Pedidos de trabajo: volvieron a simulado \(ayer estaban encendidos\)\.$/m.test(j.texto) && j.texto.startsWith("Sin cambios desde ayer")')" = true ] \
  && ok "T31b apagar los pedidos se dice en una línea y no cuenta como cambios" || no "T31b: $(q "$D/a.json" '[j.cambios, j.texto]')"
# T31c (revisión adversarial) una noche SIN sección `pedidos` no es un cambio de modo: sin el paso de pedidos no
# se sabe si estaban encendidos. Antes, «postergadas» traía `simulado: false` igual y el resumen decía «encendidos».
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
# T32 (revisión adversarial del cierre, 2026-09-15) los Bugs que cerró el arnés se NOMBRAN, y la noche del cierre
# no salen también como «resueltas con pedido abierto» (el cruce corre antes que el cierre y los ve abiertos)
D="$TMP/t32"; mundo "$D"
snap "$D" "$HOY" '{"pedidos":{"simulado":false,"creados":[],"adoptados":[],"fallidos":[],"postergados":[],"sin_iteracion":[],"deuda_avisada":[],"pagados_avisados":[{"ficha":"aaa11111","proyecto":"ProyA","id":301,"cerrado":true,"motivo_azure":"Fixed and verified"},{"ficha":"bbb22222","proyecto":"Proy B","id":302,"cerrado":false,"motivo_azure":null}],"reabiertos":[{"ficha":"ccc33333","proyecto":"ProyA","id":303}]},"cruce":{"consultado":true,"motivo":null,"evaluados":2,"cerrados_vivos":[],"resueltas_con_pedido_abierto":[{"ficha":"aaa11111","proyecto":"ProyA","pedido":301,"dias":0},{"ficha":"bbb22222","proyecto":"Proy B","pedido":302,"dias":3}],"no_leidos":[],"huerfanos":[],"huerfanos_no_consultados":[]}}'
armar "$D" dependencias "$HOY" > "$D/a.json" 2> "$D/a.err"
[ "$(q "$D/a.json" 'JSON.stringify(j.rubros.pedidos_cerrados.valor) === JSON.stringify([{ ficha: "aaa11111", proyecto: "ProyA", id: 301 }]) && JSON.stringify(j.rubros.resueltas_con_pedido_abierto.valor.map(x => x.pedido)) === "[302]" && j.texto.includes("Bugs cerrados por el arnés: 1 — Bug 301 (ProyA, aaa11111)") && j.texto.includes("Bugs reabiertos por el arnés: 1 — Bug 303 (ProyA, ccc33333)")')" = true ] \
  && ok "T32 el resumen nombra los Bugs que cerró y los que reabrió el arnés, y no repite los cerrados como «resueltas con pedido abierto»" || no "T32: $(q "$D/a.json" '[j.rubros.pedidos_cerrados, j.rubros.resueltas_con_pedido_abierto, j.texto]') ($(head -c 200 "$D/a.err"))"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# T33 (story 4.6, AC 5) la_seccion_viaja_en_el_mismo_mensaje — los PR abiertos van al final del MISMO mensaje
# Rojo previo: `--extra` no existe → `entregar` sale 2 («opción desconocida») y no manda nada.
D="$TMP/t33"; mundo "$D"
snap "$D" "$HOY" '{}'; ficha "$D" pending aaa11111 "$HOY" pendiente A/A
reset_srv ok:777; entregar "$D" dependencias "$HOY" >/dev/null
DEPS_L1=$(tail -1 "$TMP/pedidos.jsonl" > "$TMP/p.json"; q "$TMP/p.json" 'j.text.split("\n")[0]')
vsnap "$D" "$HOY" '{}'
printf 'PR abiertos hace más de 2 días: 1\n#2912 Acme/Backend — Autor — 13 días\n' > "$D/prs.txt"
reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/prs.txt")
[ "$RC" = 0 ] && [ "$(pedidos)" = 1 ] && [ "$(ultimo 'j.ruta')" = "/bot<token>/editMessageText" ] \
  && [ "$(ultimo 'j.text.split("\n").slice(-2).join("|")')" = "PR abiertos hace más de 2 días: 1|#2912 Acme/Backend — Autor — 13 días" ] \
  && [ "$(ultimo 'j.text.split("\n")[0]')" = "$DEPS_L1" ] && grep -q '🌙 vigilante' <<<"$(ultimo 'j.text')" \
  && ok "T33 la sección de PR va al FINAL del mismo mensaje editado, con dependencias y el vigilante intactos arriba" \
  || no "T33 con sección: rc=$RC pedidos=$(pedidos) ruta=$(ultimo 'j.ruta') · $(ultimo 'j.text') · $(head -c 300 "$D/entregar.txt")"
[ "$(q "$D/vig/vigilante-$HOY.json" 'JSON.stringify(j.resumen.rubros).includes("2912")')" = false ] \
  && ok "T33 la sección no entra a los rubros ni al snapshot" || no "T33 la sección se coló en el snapshot"
# Sin el archivo (el paso de los PR falló antes de escribirlo): el resumen sale igual y lo DICE.
vsnap "$D" "$HOY" '{}'
reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/no-existe.txt")
[ "$RC" = 0 ] && [ "$(pedidos)" = 1 ] && [ "$(ultimo 'j.text.split("\n").pop()')" = "PR abiertos: no se pudo consultar (la sección no se generó)" ] \
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
[ "$RC" = 0 ] && [ "$(ultimo 'j.text.length <= 4096 && j.text.split("\n")[0] === '"$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$DEPS_L1")"' && j.text.includes("🌙 vigilante") && j.text.split("PR abiertos hace más de 2 días: 40")[1].split("\n").length <= 14')" = true ] \
  && ok "T33 una sección enorme se acota sola (≤13 líneas), no recorta dependencias ni vigilante, y el total entra en 4096" \
  || no "T33 sección enorme: rc=$RC · largo=$(ultimo 'j.text.length') · $(ultimo 'j.text')"

# T33c (adversarial ADV-1, iter 2) nombres_largos_se_recortan_por_linea_entera — una sección que pasa el tope de
# caracteres con pocas líneas no puede cortarse a mitad de la lista: se sacan líneas enteras de abajo y se dice cuántas.
{ echo 'PR abiertos hace más de 2 días: 15'
  for i in $(seq 1 10); do echo "#29$i Acme Custom Portal/acme-custom-portal-sample — Persona Inventada Apellido Largo — $((i + 2)) días"; done
  echo '(+5 más)'; } > "$D/nombres-largos.txt"
vsnap "$D" "$HOY" '{}'
reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/nombres-largos.txt")
SEC_JS='(() => { const i = j.text.indexOf("PR abiertos hace más de 2 días: 15"); return i < 0 ? null : j.text.slice(i).split("\n"); })()'
[ "$RC" = 0 ] && [ "$(ultimo "(() => { const L = $SEC_JS; if (!L) return false; const ult = L[L.length - 1]; const m = ult.match(/^\\(\\+(\\d+) más\\)\$/); const cuerpo = L.slice(1, -1); return L.join(\"\\n\").length <= 590 && !!m && cuerpo.every(l => /^#29\\d+ .* días\$/.test(l)) && cuerpo.length + Number(m[1]) === 15; })()")" = true ] \
  && ok "T33c con nombres largos la sección cabe en 590, no corta ninguna línea a la mitad y «(+N más)» cuenta los que faltan (listados + N = 15)" \
  || no "T33c nombres largos: rc=$RC · $(ultimo "$SEC_JS")"
# T33d (TEST-W4, iter 2) archivo vacío o que no se puede leer: se dice, distinto de «no se generó»
: > "$D/vacio.txt"; mkdir -p "$D/es-carpeta.txt"
vsnap "$D" "$HOY" '{}'; reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/vacio.txt")
[ "$RC" = 0 ] && [ "$(ultimo 'j.text.split("\n").pop()')" = "PR abiertos: no se pudo consultar (la sección vino vacía)" ] \
  && ok "T33d archivo vacío: la última línea lo dice" || no "T33d vacío: rc=$RC · $(ultimo 'j.text.split("\n").pop()')"
vsnap "$D" "$HOY" '{}'; reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/es-carpeta.txt")
[ "$RC" = 0 ] && grep -q '^PR abiertos: no se pudo consultar (la sección no se pudo leer: EISDIR)$' <<<"$(ultimo 'j.text.split("\n").pop()')" \
  && ok "T33d archivo ilegible (una carpeta): la última línea dice que no se pudo leer, con el código" || no "T33d ilegible: rc=$RC · $(ultimo 'j.text.split("\n").pop()')"
# T33e (SEC-C5, barrido de clase) la sección que llega de afuera tampoco trae «##vso[» al mensaje
printf 'PR abiertos hace más de 2 días: 1\n#1 P/R — ##vso[task.setvariable variable=X]y — 3 días\n' > "$D/hostil.txt"
vsnap "$D" "$HOY" '{}'; reset_srv ok:777; RC=$(entregar "$D" vigilante "$HOY" --extra "$D/hostil.txt" --dry-run)
[ "$RC" = 0 ] && ! grep -qE '##(vso)?\[' "$D/entregar.txt" && ok "T33e --extra no deja pasar «##vso[» ni en el ensayo por stdout" || no "T33e: rc=$RC · $(grep -E '##' "$D/entregar.txt" | head -2)"

# T33b (story 4.6, AC 5) — NO VIAJA al público: miraba el paso «Listar los PR abiertos» del pipeline del vigilante, que
# es del repo del equipo (el vigilante de producción no se publica, story 8.30). El caso sigue en el repo privado; lo que
# el guion hace con `--extra` lo prueban T33, T33c, T33d y T33e acá.

echo
if [ "$FALLOS" -eq 0 ]; then echo "✅ resumen-diario: $TOTAL/$TOTAL"; exit 0; fi
echo "❌ resumen-diario: $FALLOS de $TOTAL en rojo"; exit 1
