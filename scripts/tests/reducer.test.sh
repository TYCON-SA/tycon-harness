#!/usr/bin/env bash
# 🔴 AISLAMIENTO PRIMERO (story 2.5): HOME falso antes de cualquier otra línea que ejecute algo — ninguna
#    versión del reductor, vieja o nueva, puede leer un registro de esta máquina ni la carpeta bajada real.
HOME="$(mktemp -d)"; export HOME
#
# reducer.test.sh — el reductor del tablero (story 2.5, rediseño): cuenta los registros de frenos y escapes
# de esta máquina y de las bajadas del buzón, por lista blanca. Lista cerrada o se niega, «no medido» nunca
# es 0, alias sin persona, escapes por type o kind, ventana de días cerrados.
# La prueba de fuga de punta a punta vive aparte (telemetry-leak.test.sh); las sumas entre máquinas, las
# esperadas y el piso, en dashboard.test.sh (C-29 a C-32).
#
# Todo se fabrica: registros locales (TYCON_LOGS_SOURCE), carpeta bajada (TYCON_MAILBOX_DIR), configuración
# (TYCON_SOURCES_JSON), el día (TYCON_TODAY) y el nombre de la máquina (TYCON_MACHINE).
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrito su rojo previo. El exit code se lee ANTES de cualquier
#    pipe. bash 3.2 (macOS): siempre `${v}`.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REDUCTOR="${RAIZ}/scripts/nightly/dashboard/reducer.js"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

echo "== reducer.test.sh =="
[ -f "${REDUCTOR}" ] || { mal "no existe ${REDUCTOR} (rojo previo: el reductor todavía no está)"; echo; echo "${FALLOS} fallo(s)"; exit 1; }

BASE="$(mktemp -d)"
trap 'rm -rf "${BASE}" "${HOME}"' EXIT
unset TYCON_LOGS_SOURCE TYCON_MAILBOX_DIR TYCON_SOURCES_JSON TYCON_TODAY TYCON_MACHINE

HOY="2026-09-15"
D1="2026-09-14"; D2="2026-09-13"; VIEJO="2026-08-06"

config_ok() {
  cat > "$1" <<'JSON'
{
  "sources": [],
  "reducer": {
    "schema": 1, "window_days": 30, "floor": 3,
    "expected_machines": [],
    "metrics": {
      "bloqueos": { "source": "gates", "dim": "control", "type": "ratio", "values": ["tests", "build", "sin-nombre"] },
      "escapes":  { "source": "bypass", "dim": "tipo", "type": "conteo", "values": ["FULL_SUITE_RUN", "MUTATION_BYPASS", "sin-tipo"] }
    }
  }
}
JSON
}
nuevo_caso() { local C="${BASE}/$1"; mkdir -p "${C}/local" "${C}/buzon"; config_ok "${C}/sources.json"; echo "${C}"; }
contar() {   # $1 = caso; resto = args → RC; salida en out/err
  local C="$1"; shift
  TYCON_LOGS_SOURCE="${C}/local" TYCON_MAILBOX_DIR="${C}/buzon" TYCON_SOURCES_JSON="${C}/sources.json" \
  TYCON_TODAY="${HOY}" TYCON_MACHINE="${TYCON_MACHINE_CASE:-maquina-local}" \
    node "${REDUCTOR}" "$@" > "${C}/out" 2> "${C}/err"
  echo $?
}
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$1/out" "$2" 2>/dev/null; }

# 🔴 La última línea NO tiene ninguna de las cuatro formas de nombrar un control: es la «línea sin
# nombre» de verdad. Hasta la story 2.6 traía `type:"smoke"`, pero `type` pasó a ser una forma válida
# de nombrar (1.460 líneas reales del registro lo usan), así que ya no servía para eso.
gates_basicos() {
  cat > "$1/gates.log" <<JSON
{"ts":"${D1}T10:00:00Z","check":"tests","status":"green","cmd":"npm test"}
{"ts":"${D1}T11:00:00Z","check":"tests","status":"red","cmd":"npm test"}
{"ts":"${D1}T12:00:00Z","name":"tests","status":"blocked"}
{"ts":"${D2}T09:00:00Z","name":"zzz-desconocido","status":"blocked"}
{"ts":"${D2}T09:30:00Z","exit":0}
{"ts":"${HOY}T01:00:00Z","name":"build","status":"blocked"}
{"ts":"${VIEJO}T01:00:00Z","name":"build","status":"blocked"}
JSON
}
bypass_basicos() {
  cat > "$1/bypass.log" <<JSON
{"ts":"${D1}T10:00:00Z","type":"FULL_SUITE_RUN","command":"npm test"}
{"ts":"${D1}T10:05:00Z","kind":"MUTATION_BYPASS","reason":"x"}
{"ts":"${D1}T10:06:00Z","reason":"sin tipo ni kind"}
JSON
}
# maquina_bajada <buzon> <nombre> <fecha de subida> <estado gates> <estado bypass> — la cobertura de una máquina bajada
maquina_bajada() {
  local R="$1/$2/registros"; mkdir -p "${R}"
  python3 - "${R}" "$3" "$4" "$5" <<'PY'
import json, sys, os
r, fecha, eg, eb = sys.argv[1:5]
def f(e): return {"estado": "medido", "bytes": 1} if e == "medido" else {"estado": "no_medido", "motivo": "el registro no existe en esta máquina"}
json.dump({"esquema": 1, "fecha": fecha, "fuentes": {"gates": f(eg), "bypass": f(eb)}}, open(os.path.join(r, "cobertura.json"), "w"))
PY
}
gz() { gzip -c "$1" > "$2"; }

# ── T6 · lista cerrada: fuera de la lista → «otro»; config rota → se niega (exit 2) ────────────────
# 🔴 rojo previo: aceptar la dimensión sin lista cerrada → sale 0 y cuenta.
C="$(nuevo_caso t6)"; gates_basicos "${C}/local"; bypass_basicos "${C}/local"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['porDim']['otro']['num']")" = "1" ] && ! grep -q 'zzz-desconocido' "${C}/out" "${C}/err" \
  && ok "T6 un control fuera de la lista cuenta como «otro» y su nombre no sale" || mal "T6 fuera de la lista (rc=${RC}): $(head -c 400 "${C}/out")"
[ "$(j "${C}" "d['metricas']['bloqueos']['porDim']['sin-nombre']['den']")" = "1" ] && ok "T6 una línea sin nombre de control cuenta en «sin-nombre»" || mal "T6 sin-nombre: $(j "${C}" "d['metricas']['bloqueos']['porDim']")"
[ "$(j "${C}" "d['metricas']['bloqueos']['porDim'].get('build')")" = "None" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['den']")" = "5" ] \
  && ok "T6 ni el día de hoy (sin cerrar) ni uno de hace 40 días entran: 5 evaluaciones en la ventana" || mal "T6 ventana: $(j "${C}" "d['metricas']['bloqueos']")"
[ "$(j "${C}" "d['ventana']")" = "{'desde': '2026-08-16', 'hasta': '2026-09-14'}" ] && ok "T6 la ventana declarada es 2026-08-16 → 2026-09-14" || mal "T6 ventana=$(j "${C}" "d['ventana']")"
for ROTA in sin-valores fuente-desconocida dim-no-permitida tipo-no-permitido valor-con-texto esquema-2 ventana-0 piso-500 esperadas-no-lista esperada-alias-mal esperada-sin-desde esperadas-repetidas metricas-vacia metrica-nombre-raro metrica-no-objeto valores-vacia sin-seccion; do
  C="$(nuevo_caso "t6-${ROTA}")"; gates_basicos "${C}/local"
  python3 - "${C}/sources.json" "${ROTA}" <<'PY'
import json, sys
p, rota = sys.argv[1], sys.argv[2]
d = json.load(open(p)); m = d['reducer']['metrics']
if rota == 'sin-valores': del m['bloqueos']['values']
if rota == 'valores-vacia': m['bloqueos']['values'] = []
if rota == 'fuente-desconocida': m['bloqueos']['source'] = 'lane'
if rota == 'dim-no-permitida': m['bloqueos']['dim'] = 'cmd'
if rota == 'tipo-no-permitido': m['bloqueos']['type'] = 'conteo'
if rota == 'valor-con-texto': m['bloqueos']['values'].append('git push --force')
r = d['reducer']
if rota == 'esquema-2': r['schema'] = 2
if rota == 'ventana-0': r['window_days'] = 0
if rota == 'piso-500': r['floor'] = 500
if rota == 'esperadas-no-lista': r['expected_machines'] = {'alias': 'maq-000000'}
if rota == 'esperada-alias-mal': r['expected_machines'] = [{'alias': 'Devbs-MacBook', 'from': '2026-09-01'}]
if rota == 'esperada-sin-desde': r['expected_machines'] = [{'alias': 'maq-0a0a0a'}]
if rota == 'esperadas-repetidas': r['expected_machines'] = [{'alias': 'maq-0a0a0a', 'from': '2026-09-01'}, {'alias': 'maq-0a0a0a', 'from': '2026-09-02'}]
if rota == 'metricas-vacia': r['metrics'] = {}
if rota == 'metrica-nombre-raro': r['metrics']['Bloqueos X'] = r['metrics'].pop('bloqueos')
if rota == 'metrica-no-objeto': r['metrics']['bloqueos'] = 'si'
if rota == 'sin-seccion': del d['reducer']
json.dump(d, open(p, 'w'))
PY
  RC="$(contar "${C}" --json)"
  ESPERADO=2; [ "${ROTA}" = "sin-seccion" ] && ESPERADO=1
  NOMBRA=1; case "${ROTA}" in sin-valores|valores-vacia|fuente-desconocida|dim-no-permitida|tipo-no-permitido|valor-con-texto|metrica-no-objeto) grep -q "bloqueos" "${C}/err" || NOMBRA=0 ;; esac
  if [ "${RC}" = "${ESPERADO}" ] && [ "${NOMBRA}" = "1" ] && [ -s "${C}/err" ] && ! grep -q '"num"' "${C}/out"; then ok "T6 config «${ROTA}» → exit ${ESPERADO}, lo dice y no cuenta nada"
  else mal "T6 config «${ROTA}»: rc=${RC} (esperaba ${ESPERADO}), err=$(head -c 200 "${C}/err") out=$(head -c 120 "${C}/out")"; fi
done
C="$(nuevo_caso t6-null)"; echo 'null' > "${C}/sources.json"
RC="$(contar "${C}" --json)"
[ "${RC}" = "1" ] && [ -s "${C}/err" ] && ok "T6 sources.json que es «null» → exit 1 y lo dice (no sale 0 callado)" || mal "T6 sources.json null: rc=${RC} err=$(head -c 120 "${C}/err")"
# 🔴 rojo previo: una sección «reducer» que existe pero no es un objeto se leía como AUSENTE (exit 1, «no tiene la sección»).
for FORMA in '"si"' '[]' '7'; do
  C="$(nuevo_caso "t6-seccion-$(echo "${FORMA}" | tr -dc 'a-z0-9')x")"; echo "{\"sources\": [], \"reducer\": ${FORMA}}" > "${C}/sources.json"
  RC="$(contar "${C}" --json)"
  [ "${RC}" = "2" ] && grep -q 'tiene que ser un objeto' "${C}/err" && ok "T6 sección «reducer» = ${FORMA} → exit 2, rota (no «ausente»)" || mal "T6 sección ${FORMA}: rc=${RC} err=$(head -c 160 "${C}/err")"
done
# 🔴 rojo previo: sin la ida y vuelta de la fecha, «2026-02-30» (que Date.parse acepta como 1 de marzo) pasa como fecha válida.
C="$(nuevo_caso t6-fecha-imposible)"
python3 - "${C}/sources.json" <<'PY2'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d['reducer']['expected_machines'] = [{'alias': 'maq-0a0a0a', 'from': '2026-02-30'}]; json.dump(d, open(p, 'w'))
PY2
RC="$(contar "${C}" --json)"
[ "${RC}" = "2" ] && ok "T6 una esperada con from «2026-02-30» (fecha imposible) → exit 2" || mal "T6 fecha imposible: rc=${RC} err=$(head -c 160 "${C}/err")"

# ── T9c · el CLI: salida en texto, errores de --alias / --alias-of y sources.json que no existe ────────
# 🔴 rojo previo (por mutación): sin la rama de texto no sale nada sin --json; sin las guardas, --alias imprime «null» con exit 0;
#    y un sources.json ausente se confunde con uno ilegible.
C="$(nuevo_caso t9c)"; gates_basicos "${C}/local"
RC="$(contar "${C}")"
[ "${RC}" = "0" ] && grep -q '^contado: reportaron 0 de 0 máquinas esperadas' "${C}/out" && grep -q 'bloqueos 3/5 (midieron 1 de 1)' "${C}/out" \
  && ok "T9c sin --json imprime «contado: …» con la cobertura y «bloqueos 3/5 (midieron 1 de 1)»" || mal "T9c texto: rc=${RC} out=$(head -c 300 "${C}/out")"
OUT="$(TYCON_MACHINE='!!!' node "${REDUCTOR}" --alias 2>"${C}/err")"; RCA=$?
[ "${RCA}" = "1" ] && [ -z "${OUT}" ] && grep -q 'no se pudo saber el nombre de esta máquina' "${C}/err" \
  && ok "T9c --alias con un nombre de máquina sin forma → exit 1, lo dice y no imprime un alias" || mal "T9c --alias sin nombre: rc=${RCA} out=${OUT} err=$(cat "${C}/err")"
for N in '' '!!!'; do
  OUT="$(node "${REDUCTOR}" --alias-of "${N}" 2>"${C}/err")"; RCA=$?
  [ "${RCA}" = "1" ] && [ -z "${OUT}" ] && grep -q 'necesita un nombre de máquina' "${C}/err" \
    && ok "T9c --alias-of «${N}» → exit 1 y lo dice" || mal "T9c --alias-of «${N}»: rc=${RCA} out=${OUT} err=$(cat "${C}/err")"
done
rm -f "${C}/sources.json"
RC="$(contar "${C}" --json)"
[ "${RC}" = "1" ] && grep -q 'no se pudo leer sources.json (ENOENT)' "${C}/err" && [ "$(j "${C}" "d['estado']")" = "no_pudo" ] \
  && ok "T9c sources.json que no existe → exit 1, «no se pudo leer sources.json (ENOENT)» y estado no_pudo" || mal "T9c fuentes ausente: rc=${RC} err=$(head -c 160 "${C}/err") out=$(head -c 160 "${C}/out")"

# ── T8 · «no medido» nunca es 0 ───────────────────────────────────────────────────────────────────
# 🔴 rojo previo: leer el .gz viejo aunque la cobertura diga no_medido → suma escapes de otro día.
C="$(nuevo_caso t8)"; gates_basicos "${C}/local"; bypass_basicos "${C}/local"
T8="${C}/tmp"; mkdir -p "${T8}"; gates_basicos "${T8}"; bypass_basicos "${T8}"
maquina_bajada "${C}/buzon" "maq-b" "${D1}" medido no_medido; gz "${T8}/gates.log" "${C}/buzon/maq-b/registros/gates.log.gz"; gz "${T8}/bypass.log" "${C}/buzon/maq-b/registros/bypass.log.gz"
maquina_bajada "${C}/buzon" "maq-c" "${D1}" medido medido; echo "no soy gzip" > "${C}/buzon/maq-c/registros/gates.log.gz"; gz "${T8}/bypass.log" "${C}/buzon/maq-c/registros/bypass.log.gz"
mkdir -p "${C}/buzon/maq-d/registros"; echo '{ roto' > "${C}/buzon/maq-d/registros/cobertura.json"
mkdir -p "${C}/buzon/maq-e/registros"   # sin cobertura.json: no se puede afirmar nada
mkdir -p "${C}/buzon/maq-f"             # una máquina que sólo sube corridas: no reportó registros
RC="$(contar "${C}" --json)"
python3 - "${C}/out" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); m = d['metricas']; c = d['cobertura']
e, b = m['escapes'], m['bloqueos']
assert e['maquinas'] == 3 and e['midieron'] == 2 and e['num'] == 6, ('escapes: local + maq-c, no maq-b', e)
assert b['maquinas'] == 3 and b['midieron'] == 2 and b['den'] == 10, ('bloqueos: local + maq-b, no maq-c (gz roto)', b)
assert c['carpetas_ilegibles'] == 2, ('maq-d con cobertura rota y maq-e sin cobertura', c)
PY
[ $? -eq 0 ] && [ "${RC}" = "0" ] && ok "T8 fuente no medida o .gz roto → esa máquina no cuenta (midieron 2 de 3); cobertura rota o ausente → carpeta ilegible" || mal "T8 (rc=${RC}): $(head -c 600 "${C}/out")"
C="$(nuevo_caso t8-sin-local)"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['midieron']")" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['maquinas']")" = "1" ] \
  && ok "T8 esta máquina sin registros: cuenta como máquina que no midió, nunca como 0 medido" || mal "T8 sin registros locales: rc=${RC} $(head -c 300 "${C}/out")"
grep -qF "${BASE}" "${C}/out" "${C}/err" && mal "T8 la salida trae una ruta de la máquina" || ok "T8 ni la salida ni los motivos traen rutas"

# ── T8b · «no pude mirar» no es «no hay»: una lectura que falla por algo que no es «no existe» se dice ──
# 🔴 rojo previo: el catch que descarta el error sin mirar el código → «ninguna máquina reportó».
C="$(nuevo_caso t8b)"; gates_basicos "${C}/local"; echo "soy un archivo" > "${C}/archivo"
TYCON_LOGS_SOURCE="${C}/local" TYCON_MAILBOX_DIR="${C}/archivo/sub" TYCON_SOURCES_JSON="${C}/sources.json" TYCON_TODAY="${HOY}" TYCON_MACHINE=maquina-local \
  node "${REDUCTOR}" --json > "${C}/out" 2> "${C}/err"; RC=$?
[ "${RC}" = "0" ] && [ "$(j "${C}" "len(d['cobertura']['no_leidos'])")" = "1" ] && ! grep -qF "${C}" "${C}/out" \
  && ok "T8b la carpeta bajada no se puede leer (ENOTDIR) → queda en no_leidos, sin ruta, y lo local se cuenta igual" || mal "T8b buzón ilegible: rc=${RC} $(head -c 300 "${C}/out")"
TYCON_LOGS_SOURCE="${C}/archivo/sub" TYCON_MAILBOX_DIR="${C}/buzon" TYCON_SOURCES_JSON="${C}/sources.json" TYCON_TODAY="${HOY}" TYCON_MACHINE=maquina-local \
  node "${REDUCTOR}" --json > "${C}/out" 2> "${C}/err"; RC=$?
[ "${RC}" = "0" ] && [ "$(j "${C}" "len(d['cobertura']['no_leidos'])")" = "1" ] \
  && ok "T8b la carpeta local no se puede leer (ENOTDIR) → no_leidos, no «no participa» callado" || mal "T8b local ilegible: rc=${RC} $(head -c 300 "${C}/out")"
TYCON_LOGS_SOURCE="${C}/archivo" TYCON_MAILBOX_DIR="${C}/buzon" TYCON_SOURCES_JSON="${C}/sources.json" TYCON_TODAY="${HOY}" TYCON_MACHINE=maquina-local \
  node "${REDUCTOR}" --json > "${C}/out" 2> "${C}/err"; RC=$?
[ "${RC}" = "0" ] && [ "$(j "${C}" "len(d['cobertura']['no_leidos'])")" = "1" ] && grep -q 'no están en una carpeta' "${C}/out" \
  && ok "T8b la «carpeta» local es un archivo → no_leidos «no están en una carpeta», no «no participa»" || mal "T8b local es archivo: rc=${RC} $(head -c 300 "${C}/out")"
mkdir -p "${C}/buzon/maq-z"; echo "no soy carpeta" > "${C}/buzon/maq-z/registros"
RC="$(contar "${C}" --json)"
[ "$(j "${C}" "d['cobertura']['carpetas_ilegibles']")" = "1" ] && ok "T8b una máquina con registros/ que no es carpeta → carpeta ilegible, no «nunca reportó»" || mal "T8b registros/ no-carpeta: $(head -c 300 "${C}/out")"

# ── T8f · un ARCHIVO suelto en la carpeta bajada no es una máquina (medido en real: la página de corridas vive ahí) ──
# 🔴 rojo previo: tratar toda entrada con forma de nombre como carpeta de máquina → `runs-dashboard.html` sale como
#    «1 carpeta de registros ilegible» en la página de todos los días.
C="$(nuevo_caso t8f)"; gates_basicos "${C}/local"; echo "<html>" > "${C}/buzon/runs-dashboard.html"; echo "x" > "${C}/buzon/nota.txt"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['cobertura']['carpetas_ilegibles']")" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['maquinas']")" = "1" ] \
  && ok "T8f archivos sueltos en la carpeta bajada (la página de corridas) no cuentan como máquinas ilegibles" || mal "T8f rc=${RC} $(j "${C}" "d['cobertura']")"

# ── T8g · un ENLACE a una carpeta de máquina real se decide por lo que apunta: cuenta la máquina ──────
# 🔴 rojo previo: decidir por el tipo de la entrada (un enlace no es carpeta) → esa máquina desaparece callada.
C="$(nuevo_caso t8g)"; gates_basicos "${C}/local"
mkdir -p "${C}/afuera"; maquina_bajada "${C}/afuera" "real" "${D1}" medido no_medido; gz "${C}/local/gates.log" "${C}/afuera/real/registros/gates.log.gz"
ln -s "${C}/afuera/real" "${C}/buzon/maq-link"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['maquinas']")" = "2" ] && [ "$(j "${C}" "d['cobertura']['carpetas_ilegibles']")" = "0" ] \
  && ok "T8g un enlace a una carpeta de máquina real cuenta como máquina" || mal "T8g rc=${RC} $(j "${C}" "d['cobertura']") maquinas=$(j "${C}" "d['metricas']['bloqueos']['maquinas']")"

# ── T8h · un enlace ROTO no se puede afirmar qué es: carpeta ilegible, no «no está» ──────────────────
# 🔴 rojo previo: tratar el enlace roto como archivo suelto → se saltea sin rastro.
C="$(nuevo_caso t8h)"; gates_basicos "${C}/local"; ln -s "${C}/no-existe" "${C}/buzon/maq-roto"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['cobertura']['carpetas_ilegibles']")" = "1" ] \
  && ok "T8h un enlace roto en la carpeta bajada → 1 carpeta ilegible" || mal "T8h rc=${RC} $(j "${C}" "d['cobertura']")"

# ── T8i · una máquina ESPERADA que quedó como archivo (no carpeta) es ilegible, no «no reportó» ──────
# 🔴 rojo previo: saltear todo archivo suelto → la esperada sale «ausente» cuando en realidad está rota.
C="$(nuevo_caso t8i)"; gates_basicos "${C}/local"; AL_ESP="$(node "${REDUCTOR}" --alias-of maq-esperada 2>/dev/null | tr -d '[:space:]')"
python3 - "${C}/sources.json" "${AL_ESP}" <<'PY'
import json, sys
p, al = sys.argv[1:3]; d = json.load(open(p))
d['reducer']['expected_machines'] = [{'alias': al, 'from': '2026-09-01'}]
json.dump(d, open(p, 'w'))
PY
echo "corrupto" > "${C}/buzon/maq-esperada"; echo "<html>" > "${C}/buzon/runs-dashboard.html"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['cobertura']['carpetas_ilegibles']")" = "1" ] \
  && ok "T8i una máquina esperada convertida en archivo → 1 carpeta ilegible (la página de corridas sigue sin contar)" || mal "T8i rc=${RC} alias=${AL_ESP} $(j "${C}" "d['cobertura']")"

# ── T8j · un enlace que SÍ resuelve pero a un ARCHIVO se trata como archivo suelto ───────────────────
# 🔴 rojo previo: dar por carpeta todo enlace que resuelve → el de nombre cualquiera sale ilegible; y sin mirar el alias,
#    el de nombre de máquina esperada sale «no reportó».
C="$(nuevo_caso t8j)"; gates_basicos "${C}/local"; echo "x" > "${C}/un-archivo"; ln -s "${C}/un-archivo" "${C}/buzon/maq-x"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['cobertura']['carpetas_ilegibles']")" = "0" ] \
  && ok "T8j un enlace a un archivo con nombre cualquiera no es máquina ni carpeta ilegible" || mal "T8j sin alias: rc=${RC} $(j "${C}" "d['cobertura']")"
python3 - "${C}/sources.json" "${AL_ESP}" <<'PY'
import json, sys
p, al = sys.argv[1:3]; d = json.load(open(p))
d['reducer']['expected_machines'] = [{'alias': al, 'from': '2026-09-01'}]
json.dump(d, open(p, 'w'))
PY
ln -s "${C}/un-archivo" "${C}/buzon/maq-esperada"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['cobertura']['carpetas_ilegibles']")" = "1" ] \
  && ok "T8j un enlace a un archivo con nombre de máquina esperada → 1 carpeta ilegible" || mal "T8j con alias: rc=${RC} $(j "${C}" "d['cobertura']")"

# ── T8k · lo que no tiene forma de nombre de máquina se ignora entero (el .DS_Store del Finder, una carpeta a mano) ──
# 🔴 rojo previo: sin el filtro de forma, el enlace roto oculto y la carpeta con registros/ roto suman ilegibles falsos.
C="$(nuevo_caso t8k)"; gates_basicos "${C}/local"; echo "x" > "${C}/buzon/.DS_Store"; ln -s "${C}/no-existe" "${C}/buzon/.roto-oculto"
mkdir -p "${C}/buzon/Maq-MAYUS"; echo "no soy carpeta" > "${C}/buzon/Maq-MAYUS/registros"
maquina_bajada "${C}/buzon" "Con Espacio" "${D1}" medido medido; gz "${C}/local/gates.log" "${C}/buzon/Con Espacio/registros/gates.log.gz"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['cobertura']['carpetas_ilegibles']")" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['maquinas']")" = "1" ] \
  && ok "T8k entradas sin forma de nombre de máquina (.DS_Store, enlace oculto roto, mayúsculas, espacio) no cuentan ni como máquina ni como ilegibles" || mal "T8k rc=${RC} $(j "${C}" "d['cobertura']") maquinas=$(j "${C}" "d['metricas']['bloqueos']['maquinas']")"

# ── T8l · un .gz del buzón de más de 16 MB COMPRIMIDO no se lee: esa máquina no mide ────────────────
# 🔴 rojo previo: sin el tope del comprimido, un .gz grande (que descomprime por debajo de 64 MB) se lee entero.
C="$(nuevo_caso t8l)"; gates_basicos "${C}/local"
maquina_bajada "${C}/buzon" "maq-grande" "${D1}" medido medido
{ cat "${C}/local/gates.log"; head -c 17000000 /dev/urandom; } | gzip -1 -c > "${C}/buzon/maq-grande/registros/gates.log.gz"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['maquinas']")" = "2" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['midieron']")" = "1" ] \
  && ok "T8l .gz de más de 16 MB comprimido → esa máquina no mide («midieron 1 de 2»)" || mal "T8l rc=${RC} midieron=$(j "${C}" "d['metricas']['bloqueos']['midieron']") $(head -c 200 "${C}/err")"

# ── T8m · un registro LOCAL de más de 64 MB no se lee: esta máquina no mide esa fuente ────────────────
# 🔴 rojo previo: sin el tope local, readFileSync carga el archivo entero y la máquina cuenta como medida.
C="$(nuevo_caso t8m)"; gates_basicos "${C}/local"
python3 - "${C}/local/gates.log" <<'PY2'
import sys
with open(sys.argv[1], 'r+b') as f: f.seek(70000000); f.write(b'\n')
PY2
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['maquinas']")" = "1" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['midieron']")" = "0" ] \
  && ok "T8m gates.log local de más de 64 MB → esta máquina no mide bloqueos («midieron 0 de 1»)" || mal "T8m rc=${RC} midieron=$(j "${C}" "d['metricas']['bloqueos']['midieron']") $(head -c 200 "${C}/err")"

# ── T8n · un evento sin fecha legible es una línea ILEGIBLE, no uno fuera de la ventana ──────────────
# 🔴 rojo previo: sin `ts` (o con `ts` que no es texto ni fecha) se descarta callado como «fuera de la ventana».
C="$(nuevo_caso t8n)"; gates_basicos "${C}/local"
printf '%s\n' '{"name":"tests","status":"blocked"}' '{"ts":12345,"name":"tests","status":"blocked"}' '{"ts":"ayer","name":"tests","status":"blocked"}' >> "${C}/local/gates.log"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['cobertura']['lineas_ilegibles']")" = "3" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['den']")" = "5" ] \
  && ok "T8n 3 eventos sin fecha legible (sin ts, ts número, ts texto) → 3 líneas ilegibles, la cuenta no cambia" || mal "T8n rc=${RC} $(j "${C}" "d['cobertura']") den=$(j "${C}" "d['metricas']['bloqueos']['den']")"

# ── T8o · el relleno «sin-nombre» que la lista NO declara sale como «otro» ────────────────────────────
# 🔴 rojo previo: publicar el relleno aunque la lista cerrada no lo tenga → la lista deja de ser cerrada.
C="$(nuevo_caso t8o)"; gates_basicos "${C}/local"
python3 - "${C}/sources.json" <<'PY2'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d['reducer']['metrics']['bloqueos']['values'] = ['tests', 'build']
json.dump(d, open(p, 'w'))
PY2
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['porDim'].get('sin-nombre')")" = "None" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['porDim']['otro']['den']")" = "2" ] \
  && ok "T8o sin «sin-nombre» en la lista, la línea sin nombre cuenta como «otro»" || mal "T8o rc=${RC} porDim=$(j "${C}" "d['metricas']['bloqueos']['porDim']")"

# juntar_js <caso> <json extra> — llama juntar() como librería (así la llama dashboard.js → equipo()), no por el CLI.
juntar_js() {
  local C="$1"
  node -e '
const r = require(process.argv[1]); const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[2] + "/sources.json", "utf8"));
const base = { registros: process.argv[2] + "/local", buzon: process.argv[2] + "/buzon", cfg, hoy: "2026-09-15", maquina: "maquina-local" };
const j = r.juntar(Object.assign(base, JSON.parse(process.argv[3])));
j.texto = r.textoCobertura(j);
process.stdout.write(JSON.stringify(j));' "${REDUCTOR}" "${C}" "$2" > "${C}/out" 2> "${C}/err"
  echo $?
}

# ── T8p · un nombre de control que no es texto (un número) cuenta como «otro» ─────────────────────────
# 🔴 rojo previo: publicar el valor crudo que no es texto → aparece «123» como control en la página.
C="$(nuevo_caso t8p)"; gates_basicos "${C}/local"; echo "{\"ts\":\"${D1}T13:00:00Z\",\"name\":123,\"status\":\"blocked\"}" >> "${C}/local/gates.log"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['porDim']['otro']['den']")" = "2" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['porDim'].get('123')")" = "None" ] \
  && ok "T8p un control con nombre numérico cuenta como «otro» y el número no sale" || mal "T8p rc=${RC} porDim=$(j "${C}" "d['metricas']['bloqueos']['porDim']")"

# ── T8q · sin nombre de máquina legible, juntar() lo DICE en vez de saltear la máquina local ──────────
# 🔴 rojo previo: como librería (dashboard.js), un nombre vacío saca a esta máquina sin rastro → la página dice «no reportó».
C="$(nuevo_caso t8q)"; gates_basicos "${C}/local"
RC="$(juntar_js "${C}" '{"maquina":""}')"
[ "${RC}" = "0" ] && [ "$(j "${C}" "len(d['cobertura']['no_leidos'])")" = "1" ] && grep -q 'nombre de esta máquina' "${C}/out" \
  && ok "T8q nombre de máquina vacío → no_leidos «no se pudo saber el nombre de esta máquina», no un salteo callado" || mal "T8q rc=${RC} $(head -c 300 "${C}/out") $(head -c 200 "${C}/err")"

# ── T8r · sin carpeta bajada (buzon null) cuenta sólo la máquina local, sin error ─────────────────────
# 🔴 rojo previo: leer el buzón aunque no se haya pasado → «no se pudo leer la carpeta bajada» falso.
C="$(nuevo_caso t8r)"; gates_basicos "${C}/local"
RC="$(juntar_js "${C}" '{"buzon":null}')"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['maquinas']")" = "1" ] && [ "$(j "${C}" "len(d['cobertura']['no_leidos'])")" = "0" ] \
  && ok "T8r juntar() sin buzón cuenta sólo esta máquina y no inventa un «no pude leer»" || mal "T8r rc=${RC} $(head -c 300 "${C}/out") $(head -c 200 "${C}/err")"

# ── T8s · el texto de cobertura en singular: «1 máquina esperada», «1 carpeta de registros ilegible» ──
# 🔴 rojo previo: el plural fijo → «de 1 máquinas esperadas» y «1 carpetas de registros ilegibles» en la página.
C="$(nuevo_caso t8s)"; gates_basicos "${C}/local"; AL_S="$(node "${REDUCTOR}" --alias-of maq-esperada 2>/dev/null | tr -d '[:space:]')"
python3 - "${C}/sources.json" "${AL_S}" <<'PY2'
import json, sys
p, al = sys.argv[1:3]; d = json.load(open(p))
d['reducer']['expected_machines'] = [{'alias': al, 'from': '2026-09-01'}]
json.dump(d, open(p, 'w'))
PY2
echo "corrupto" > "${C}/buzon/maq-esperada"
RC="$(juntar_js "${C}" '{}')"
[ "${RC}" = "0" ] && grep -q 'de 1 máquina esperada ·' "${C}/out" && grep -q '· 1 carpeta de registros ilegible' "${C}/out" \
  && ok "T8s el texto dice «de 1 máquina esperada» y «1 carpeta de registros ilegible», en singular" || mal "T8s rc=${RC} texto=$(j "${C}" "d['texto']")"

# ── T8t · una cobertura con forma de JSON pero inválida (esquema, fecha, fuentes) es carpeta ilegible ──
# 🔴 rojo previo: validar sólo que parsee → una cobertura de otro esquema se lee como máquina que reportó.
C="$(nuevo_caso t8t)"; gates_basicos "${C}/local"
for M in maq-esquema maq-fecha maq-fuentes maq-sin-fuentes; do maquina_bajada "${C}/buzon" "${M}" "${D1}" medido medido; done
python3 - "${C}/buzon" <<'PY2'
import json, sys, os
b = sys.argv[1]
def edit(m, f):
    p = os.path.join(b, m, 'registros', 'cobertura.json'); d = json.load(open(p)); f(d); json.dump(d, open(p, 'w'))
edit('maq-esquema', lambda d: d.update(esquema=2))
edit('maq-fecha', lambda d: d.update(fecha='ayer'))
edit('maq-fuentes', lambda d: d.update(fuentes='si'))
edit('maq-sin-fuentes', lambda d: d.pop('fuentes'))
PY2
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['cobertura']['carpetas_ilegibles']")" = "4" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['maquinas']")" = "1" ] \
  && ok "T8t coberturas con esquema 2, fecha inválida, fuentes que no es objeto o sin fuentes → 4 carpetas ilegibles, ninguna cuenta como máquina" || mal "T8t rc=${RC} $(j "${C}" "d['cobertura']") maquinas=$(j "${C}" "d['metricas']['bloqueos']['maquinas']")"

# ── T8u · una línea JSON válida que no es un objeto (null, un número) es ilegible ─────────────────────
# 🔴 rojo previo: sin mirar `null` → `o.ts` tira y la cuenta entera se cae.
C="$(nuevo_caso t8u)"; gates_basicos "${C}/local"; printf '%s\n' 'null' '42' >> "${C}/local/gates.log"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['cobertura']['lineas_ilegibles']")" = "2" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['den']")" = "5" ] \
  && ok "T8u las líneas «null» y «42» cuentan como 2 ilegibles y la cuenta sigue" || mal "T8u rc=${RC} $(head -c 200 "${C}/err") $(j "${C}" "d['cobertura']")"

# ── T8v · sin un día válido, juntar() usa la fecha real (no tira, no inventa una ventana) ─────────────
# 🔴 rojo previo: usar el `hoy` inválido tal cual → la ventana sale rota o la cuenta tira.
C="$(nuevo_caso t8v)"; gates_basicos "${C}/local"
AYER_UTC="$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)).strftime('%Y-%m-%d'))")"
RC="$(juntar_js "${C}" '{"hoy":"ayer"}')"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['estado']")" = "medido" ] && [ "$(j "${C}" "d['ventana']['hasta']")" = "${AYER_UTC}" ] \
  && ok "T8v con hoy=«ayer» la ventana cierra en el día real anterior (${AYER_UTC})" || mal "T8v rc=${RC} ventana=$(j "${C}" "d.get('ventana')") $(head -c 200 "${C}/err")"

# ── T8w · el texto de cobertura en plural y la frase de líneas ilegibles, singular y plural ───────────
# 🔴 rojo previo: plural o singular fijos → «2 carpeta de registros ilegible», «atrasada: a, b», «1 líneas ilegibles».
C="$(nuevo_caso t8w)"; gates_basicos "${C}/local"; printf '%s\n' 'roto' 'roto' >> "${C}/local/gates.log"
ln -s "${C}/no-existe" "${C}/buzon/maq-roto1"; ln -s "${C}/no-existe" "${C}/buzon/maq-roto2"
maquina_bajada "${C}/buzon" "maq-vieja1" "2026-09-01" medido medido; maquina_bajada "${C}/buzon" "maq-vieja2" "2026-09-02" medido medido
RC="$(juntar_js "${C}" '{}')"
[ "${RC}" = "0" ] && grep -q '· 2 carpetas de registros ilegibles' "${C}/out" && grep -q '· atrasadas: maq-' "${C}/out" && grep -q '· 2 líneas ilegibles en los registros' "${C}/out" \
  && ok "T8w el texto dice «2 carpetas de registros ilegibles», «atrasadas: …» y «2 líneas ilegibles en los registros»" || mal "T8w plural rc=${RC} texto=$(j "${C}" "d['texto']")"
C="$(nuevo_caso t8w1)"; gates_basicos "${C}/local"; echo 'roto' >> "${C}/local/gates.log"
RC="$(juntar_js "${C}" '{}')"
[ "${RC}" = "0" ] && grep -q '· 1 línea ilegible en los registros' "${C}/out" \
  && ok "T8w con una sola, «1 línea ilegible en los registros»" || mal "T8w singular rc=${RC} texto=$(j "${C}" "d['texto']")"

# ── T8c · un .gz que descomprime a más del tope no cuelga la cuenta: esa máquina no mide ────────────
# 🔴 rojo previo: gunzip sin tope → el proceso carga todo en memoria.
C="$(nuevo_caso t8c)"; gates_basicos "${C}/local"
maquina_bajada "${C}/buzon" "maq-bomba" "${D1}" medido medido
head -c 70000000 /dev/zero | gzip -c > "${C}/buzon/maq-bomba/registros/gates.log.gz"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['midieron']")" = "1" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['maquinas']")" = "2" ] \
  && ok "T8c registro de 70 MB descomprimidos (tope 64 MB) → esa máquina no mide, la cuenta sigue" || mal "T8c bomba: rc=${RC} $(head -c 300 "${C}/out") $(head -c 200 "${C}/err")"

# ── T8d · un estado que no es texto no tira la cuenta ────────────────────────────────────────────────
# 🔴 rojo previo: String() sobre un objeto con toString no llamable → excepción → sin página.
C="$(nuevo_caso t8d)"; gates_basicos "${C}/local"; echo "{\"ts\":\"${D1}T13:00:00Z\",\"name\":\"tests\",\"status\":{\"toString\":1}}" >> "${C}/local/gates.log"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['porDim']['tests']['den']")" = "4" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['porDim']['tests']['num']")" = "2" ] \
  && ok "T8d un status que es un objeto cuenta como evaluación sin bloqueo y no tira nada" || mal "T8d status objeto: rc=${RC} $(head -c 200 "${C}/err")"

# ── T8e · las líneas rotas se CUENTAN, no se descartan en silencio ──────────────────────────────────
# 🔴 rojo previo: `catch { continue }` sin contador → el número baja y nada dice por qué.
C="$(nuevo_caso t8e)"; gates_basicos "${C}/local"; printf 'esto no es json\n[1,2]\n{roto\n' >> "${C}/local/gates.log"
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['cobertura']['lineas_ilegibles']")" = "3" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['den']")" = "5" ] \
  && ok "T8e 3 líneas ilegibles (texto, lista, JSON roto) se cuentan en la cobertura y no tocan la cuenta" || mal "T8e rc=${RC} $(j "${C}" "d['cobertura']")"

# ── T9 · alias sin persona ────────────────────────────────────────────────────────────────────────
# 🔴 rojo previo: usar el nombre de la máquina como alias → el nombre aparece en la salida.
C="$(nuevo_caso t9)"; gates_basicos "${C}/local"
RC="$(TYCON_MACHINE_CASE="Devbs-MacBook-Pro" contar "${C}" --json)"
AL1="$(j "${C}" "d['cobertura']['sin_declarar'][0]")"
grep -qi 'devbs' "${C}/out" "${C}/err" && mal "T9 el nombre de la máquina aparece en la salida" || ok "T9 el nombre de la máquina no aparece en ninguna salida"
RCA="$(TYCON_MACHINE_CASE="Devbs-MacBook-Pro" contar "${C}" --alias)"; AL2="$(tr -d '[:space:]' < "${C}/out")"
AL3="$(node "${REDUCTOR}" --alias-of "Devbs-MacBook-Pro" 2>/dev/null | tr -d '[:space:]')"
AL4="$(node "${REDUCTOR}" --alias-of "devbs-macbook-pro.local" 2>/dev/null | tr -d '[:space:]')"
if echo "${AL1}" | grep -E '^maq-[0-9a-f]{6}$' >/dev/null && [ "${AL1}" = "${AL2}" ] && [ "${AL1}" = "${AL3}" ] && [ "${AL1}" = "${AL4}" ]; then
  ok "T9 alias ${AL1}: la misma huella en la cuenta, en --alias y en --alias-of (con o sin .local, con mayúsculas)"
else mal "T9 alias: cuenta=${AL1} --alias=${AL2} --alias-of=${AL3} normalizado=${AL4} (rc ${RC}/${RCA})"; fi
C="$(nuevo_caso t9-nombre)"; gates_basicos "${C}/local"
RC="$(TYCON_MACHINE_CASE="..." contar "${C}" --json)"
[ "${RC}" = "1" ] && ok "T9 sin nombre de máquina usable → exit 1" || mal "T9 sin nombre: rc=${RC}"
C="$(nuevo_caso t9-config)"; echo '{ no es json' > "${C}/sources.json"
RC="$(contar "${C}" --json)"
[ "${RC}" = "1" ] && ok "T9 sources.json ilegible → exit 1" || mal "T9 config ilegible: rc=${RC}"

# ── T9b · el alias de una carpeta es el de su nombre, sin normalizarlo dos veces ──────────────────────
# 🔴 rojo previo: normalizar el nombre de la carpeta otra vez → «maq.local» pasa a «maq» y la copia bajada de
#    esta máquina no se reconoce: cuenta doble.
C="$(nuevo_caso t9b)"; gates_basicos "${C}/local"
maquina_bajada "${C}/buzon" "maq.local" "${D1}" medido medido; gz "${C}/local/gates.log" "${C}/buzon/maq.local/registros/gates.log.gz"
RC="$(TYCON_MACHINE_CASE="Maq.local.local" contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['maquinas']")" = "1" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['den']")" = "5" ] \
  && [ "$(node "${REDUCTOR}" --alias-of "Maq.local.local")" = "$(TYCON_MACHINE="Maq.local.local" TYCON_LOGS_SOURCE="${C}/local" TYCON_MAILBOX_DIR="${C}/buzon" TYCON_SOURCES_JSON="${C}/sources.json" node "${REDUCTOR}" --alias)" ] \
  && ok "T9b un nombre que termina en .local.local: la carpeta bajada y esta máquina son la misma (una máquina, 5 evaluaciones)" || mal "T9b alias doble: rc=${RC} $(head -c 300 "${C}/out")"

# ── T13 · escapes por type o por kind ─────────────────────────────────────────────────────────────
# 🔴 rojo previo: leer sólo `type` → el escape con `kind` cae en «sin-tipo».
C="$(nuevo_caso t13)"; bypass_basicos "${C}/local"; gates_basicos "${C}/local"
RC="$(contar "${C}" --json)"
[ "$(j "${C}" "d['metricas']['escapes']['porDim']['MUTATION_BYPASS']['num']")" = "1" ] && [ "$(j "${C}" "d['metricas']['escapes']['porDim']['sin-tipo']['num']")" = "1" ] && [ "$(j "${C}" "d['metricas']['escapes']['porDim']['FULL_SUITE_RUN']['num']")" = "1" ] \
  && ok "T13 el escape con sólo «kind» cuenta en su tipo; sin ninguno, en «sin-tipo»" || mal "T13 escapes: $(j "${C}" "d['metricas']['escapes']")"

# ══════════════════════════════════════════════════════════════════════════════════════════════════
# Story 2.6 — los dos arreglos de la cuenta y la fuente nueva
# ══════════════════════════════════════════════════════════════════════════════════════════════════

# ── 2.6-T7 · un estado con detalle (`red:exit=1`) ES un bloqueo ───────────────────────────────────
# 🔴 rojo previo: con igualdad exacta contra «red», las pruebas y la compilación salen 0 bloqueos.
#    Medido en el gates.log real de esta máquina: 489 bloqueos contados como cero.
C="$(nuevo_caso t26-7)"
cat > "${C}/local/gates.log" <<JSON
{"ts":"${D1}T10:00:00Z","name":"tests","status":"red:exit=1"}
{"ts":"${D1}T10:01:00Z","name":"tests","status":"red:exit=127"}
{"ts":"${D1}T10:02:00Z","name":"tests","status":"fail:timeout"}
{"ts":"${D1}T10:03:00Z","name":"tests","status":"redundante"}
{"ts":"${D1}T10:04:00Z","name":"tests","status":"greenish"}
{"ts":"${D1}T10:05:00Z","name":"tests","status":"green"}
JSON
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['porDim']['tests']['num']")" = "3" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['porDim']['tests']['den']")" = "6" ] \
  && ok "2.6-T7 «red:exit=N» y «fail:…» son bloqueo; «redundante» y «greenish» no (3 de 6)" \
  || mal "2.6-T7 rc=${RC} tests=$(j "${C}" "d['metricas']['bloqueos']['porDim'].get('tests')")"

# ── 2.6-T8 · la forma real: un control con cientos de evaluaciones NO puede salir 0 % ─────────────
# 🔴 rojo previo: con la regla vieja, `tests` publica «0 bloqueos sobre 816 evaluaciones».
C="$(nuevo_caso t26-8)"
: > "${C}/local/gates.log"
i=0; while [ ${i} -lt 20 ]; do echo "{\"ts\":\"${D1}T10:00:00Z\",\"check\":\"tests\",\"status\":\"green\"}" >> "${C}/local/gates.log"; i=$((i+1)); done
i=0; while [ ${i} -lt 6 ];  do echo "{\"ts\":\"${D1}T10:00:00Z\",\"check\":\"tests\",\"status\":\"red:exit=1\"}" >> "${C}/local/gates.log"; i=$((i+1)); done
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['porDim']['tests']['num']")" = "6" ] \
  && ok "2.6-T8 26 evaluaciones de pruebas con 6 en rojo publican 6 bloqueos, no 0" \
  || mal "2.6-T8 tests=$(j "${C}" "d['metricas']['bloqueos']['porDim'].get('tests')")"

# ── 2.6-T9 · el nombre que vive en `type` se usa; sin ninguno sigue siendo «sin-nombre» ───────────
# 🔴 rojo previo: leyendo sólo name/check/gate, 1.460 líneas reales caen en un balde anónimo.
C="$(nuevo_caso t26-9)"
python3 - "${C}/sources.json" <<'PY2'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
d['reducer']['metrics']['bloqueos']['values'].append('smoke-run')
json.dump(d,open(p,'w'))
PY2
cat > "${C}/local/gates.log" <<JSON
{"ts":"${D1}T10:00:00Z","type":"smoke-run","status":"blocked"}
{"ts":"${D1}T10:01:00Z","status":"blocked"}
JSON
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['porDim']['smoke-run']['num']")" = "1" ] && [ "$(j "${C}" "d['metricas']['bloqueos']['porDim']['sin-nombre']['den']")" = "1" ] \
  && ok "2.6-T9 el nombre en «type» se usa; una línea sin ninguno sigue en «sin-nombre»" \
  || mal "2.6-T9 porDim=$(j "${C}" "d['metricas']['bloqueos']['porDim']")"

# ── 2.6-T12 · la fuente `frenos`: lista cerrada, y sin lista se niega ─────────────────────────────
# 🔴 rojo previo: sin la fuente, la métrica queda sin fuente conocida y el reductor se niega (exit 2).
con_frenos() { # $1 = sources.json
  python3 - "$1" <<'PY2'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
d['reducer']['metrics']['frenos_bloqueos']={"source":"frenos","dim":"freno","type":"ratio_bloqueo",
  "values":["safety-guard","test-scope-guard","pr-uno-por-repo","pr-sin-auto-complete","push-referencia-fantasma","prod-access-guard"]}
d['reducer']['metrics']['frenos_escapes']={"source":"frenos","dim":"freno","type":"ratio_escape",
  "values":["safety-guard","test-scope-guard","pr-uno-por-repo","pr-sin-auto-complete","push-referencia-fantasma","prod-access-guard"]}
json.dump(d,open(p,'w'))
PY2
}
C="$(nuevo_caso t26-12)"; con_frenos "${C}/sources.json"
cat > "${C}/local/frenos.jsonl" <<JSON
{"ts":"${D1}T10:00:00Z","freno":"safety-guard","regla":"GIT-C1","veredicto":"bloqueo","sha256":"aa"}
{"ts":"${D1}T10:01:00Z","freno":"safety-guard","regla":"GIT-C1","veredicto":"escape","sha256":"bb"}
{"ts":"${D1}T10:02:00Z","freno":"test-scope-guard","regla":"suite-completa","veredicto":"paso","sha256":"cc"}
{"ts":"${D1}T10:03:00Z","freno":"freno-que-no-existe","regla":"x","veredicto":"bloqueo","sha256":"dd"}
JSON
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] && [ "$(j "${C}" "d['metricas']['frenos_bloqueos']['porDim']['safety-guard']['num']")" = "1" ] \
  && [ "$(j "${C}" "d['metricas']['frenos_escapes']['porDim']['safety-guard']['num']")" = "1" ] \
  && [ "$(j "${C}" "d['metricas']['frenos_bloqueos']['porDim']['test-scope-guard']['num']")" = "0" ] \
  && [ "$(j "${C}" "d['metricas']['frenos_bloqueos']['porDim']['otro']['den']")" = "1" ] \
  && ! grep -q 'freno-que-no-existe' "${C}/out" \
  && ok "2.6-T12 bloqueos y escapes del MISMO freno, y uno fuera de la lista sale «otro» sin su nombre" \
  || mal "2.6-T12 rc=${RC} $(j "${C}" "d['metricas'].get('frenos_bloqueos')")"

C="$(nuevo_caso t26-12b)"; con_frenos "${C}/sources.json"
python3 - "${C}/sources.json" <<'PY2'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); del d['reducer']['metrics']['frenos_bloqueos']['values']
json.dump(d,open(p,'w'))
PY2
RC="$(contar "${C}" --json)"
[ "${RC}" = "2" ] && ok "2.6-T12b la fuente frenos sin lista cerrada → el reductor se niega (exit 2)" || mal "2.6-T12b rc=${RC}"

# ── 2.6-T13 · «no medido» de la fuente frenos nunca es 0 ──────────────────────────────────────────
# 🔴 rojo previo: contar la ausencia como cero publica «este freno nunca frenó».
C="$(nuevo_caso t26-13)"; con_frenos "${C}/sources.json"
cat > "${C}/local/frenos.jsonl" <<JSON
{"ts":"${D1}T10:00:00Z","freno":"safety-guard","regla":"GIT-C1","veredicto":"bloqueo","sha256":"aa"}
JSON
R="${C}/buzon/otra-maquina/registros"; mkdir -p "${R}"
python3 - "${R}" "${D1}" <<'PY2'
import json,sys,os
r,fecha=sys.argv[1:3]
json.dump({"esquema":1,"fecha":fecha,"fuentes":{
  "gates":{"estado":"medido","bytes":1},"bypass":{"estado":"medido","bytes":1},
  "frenos":{"estado":"no_medido","motivo":"el registro no existe en esta máquina"}}},
  open(os.path.join(r,"cobertura.json"),"w"))
PY2
: > "${R}/gates.log"; gzip -c "${R}/gates.log" > "${R}/gates.log.gz"; rm "${R}/gates.log"
: > "${R}/bypass.log"; gzip -c "${R}/bypass.log" > "${R}/bypass.log.gz"; rm "${R}/bypass.log"
RC="$(contar "${C}" --json)"
MID="$(j "${C}" "d['metricas']['frenos_bloqueos']['midieron']")"
[ "${RC}" = "0" ] && [ "${MID}" = "1" ] \
  && ok "2.6-T13 la máquina que no midió frenos no cuenta (midieron 1 de 2), no suma un cero" \
  || mal "2.6-T13 rc=${RC} midieron=${MID}"

# ══════════════════════════════════════════════════════════════════════════════════════════════════
# Story 2.7 — el carril de cada commit
# ══════════════════════════════════════════════════════════════════════════════════════════════════

# ── 2.7-T13 · la fuente `carriles`: cuenta por carril, lista cerrada, y la ausencia no es cero ──────
# 🔴 rojo previo: sin la fuente, la métrica `carriles` declara una fuente desconocida → exit 2; y si la
#    máquina sin archivo contara como cero, «nadie trabajó fuera del pipeline» saldría de la nada.
con_carriles() { # $1 = sources.json
  python3 - "$1" <<'PY2'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
d['reducer']['metrics']['carriles']={"source":"carriles","dim":"carril","type":"conteo","values":["pipeline","adhoc","ninguno"]}
json.dump(d,open(p,'w'))
PY2
}
C="$(nuevo_caso t27-13)"; con_carriles "${C}/sources.json"
cat > "${C}/local/carriles.jsonl" <<JSON
{"ts":"${D1}T10:00:00Z","carril":"pipeline","story":"CLIENTE-SECRETO-1"}
{"ts":"${D1}T10:01:00Z","carril":"pipeline","story":"2.7"}
{"ts":"${D1}T10:02:00Z","carril":"adhoc","story":null}
{"ts":"${D1}T10:03:00Z","carril":"ninguno","story":null}
{"ts":"${D1}T10:04:00Z","carril":"inventado","story":null}
JSON
R="${C}/buzon/otra-maquina/registros"; mkdir -p "${R}"
python3 - "${R}" "${D1}" <<'PY2'
import json,sys,os
r,fecha=sys.argv[1:3]
json.dump({"esquema":1,"fecha":fecha,"fuentes":{
  "gates":{"estado":"medido","bytes":1},"bypass":{"estado":"medido","bytes":1},"frenos":{"estado":"medido","bytes":1},
  "carriles":{"estado":"no_medido","motivo":"el registro no existe en esta máquina"}}},
  open(os.path.join(r,"cobertura.json"),"w"))
PY2
for f in gates.log bypass.log frenos.jsonl; do : > "${R}/${f}"; gzip -c "${R}/${f}" > "${R}/${f}.gz"; rm "${R}/${f}"; done
RC="$(contar "${C}" --json)"
[ "${RC}" = "0" ] \
  && [ "$(j "${C}" "d['metricas']['carriles']['porDim']['pipeline']['num']")" = "2" ] \
  && [ "$(j "${C}" "d['metricas']['carriles']['porDim']['adhoc']['num']")" = "1" ] \
  && [ "$(j "${C}" "d['metricas']['carriles']['porDim']['ninguno']['num']")" = "1" ] \
  && [ "$(j "${C}" "d['metricas']['carriles']['porDim']['otro']['num']")" = "1" ] \
  && [ "$(j "${C}" "d['metricas']['carriles']['midieron']")" = "1" ] \
  && ! grep -q -e 'CLIENTE-SECRETO' -e 'inventado' "${C}/out" \
  && ok "2.7-T13 commits por carril (2·1·1 + 1 «otro»), la máquina sin archivo no mide, y la story nunca sale" \
  || mal "2.7-T13 rc=${RC} $(j "${C}" "d['metricas'].get('carriles')")"

C="$(nuevo_caso t27-13b)"; con_carriles "${C}/sources.json"
python3 - "${C}/sources.json" <<'PY2'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['reducer']['metrics']['carriles']['dim']='story'
json.dump(d,open(p,'w'))
PY2
RC="$(contar "${C}" --json)"
[ "${RC}" = "2" ] && ok "2.7-T13b pedir la story como dimensión → el reductor se niega (sólo se lee el carril)" || mal "2.7-T13b rc=${RC}"

# ── 2.4-T12 · la observación de cobertura: evaluaron / habría frenado ─────────────────────────────
# 🔴 rojo previo: contar `no-medido` como evaluado (5 de 6 → 6 de 6), o los tipos inexistentes → exit 2.
C="$(nuevo_caso t24-12)"
python3 - "${C}/sources.json" <<'PY2'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
d["reducer"]["metrics"]["cob_evaluo"]={"source":"gates","dim":"control","type":"ratio_evaluo","values":["cobertura-tocada"]}
d["reducer"]["metrics"]["cob_frenaria"]={"source":"gates","dim":"control","type":"ratio_habria_frenado","values":["cobertura-tocada"]}
json.dump(d,open(p,"w"))
PY2
gates_basicos "${C}/local"
for st in cumple cumple cumple habria-frenado habria-frenado no-medido; do
  echo "{\"ts\":\"${D1}T15:00:00Z\",\"name\":\"cobertura-tocada\",\"status\":\"${st}\"}" >> "${C}/local/gates.log"
done
RC="$(contar "${C}" --json)"
EV="$(j "${C}" "(d['metricas']['cob_evaluo']['num'], d['metricas']['cob_evaluo']['den'])")"
FR="$(j "${C}" "(d['metricas']['cob_frenaria']['num'], d['metricas']['cob_frenaria']['den'])")"
BQ="$(j "${C}" "d['metricas']['bloqueos']['den']")"
[ "${RC}" = "0" ] && [ "${EV}" = "(5, 6)" ] && [ "${FR}" = "(2, 5)" ] && [ "${BQ}" = "5" ] \
  && ok "2.4-T12 evaluaron 5 de 6 y habrían frenado 2 de 5; las otras líneas no cuentan, y las de cobertura no suman a bloqueos (las 5 de siempre)" \
  || mal "2.4-T12 rc=${RC} evaluo=${EV} frenaria=${FR} bloqueos_den=${BQ} err=$(head -c 300 "${C}/err")"
# story 2.9 — la fuente «hallazgos»: los hallazgos de los revisores viajan como un registro más
# ══════════════════════════════════════════════════════════════════════════════════════════════════

# Config con la métrica nueva. Va aparte de `config_ok` a propósito: los casos de la 2.5 no se tocan.
config_29() {
  cat > "$1" <<'JSON'
{
  "sources": [],
  "prune": { "max_findings_days": 3 },
  "reducer": {
    "schema": 1, "window_days": 30, "floor": 3,
    "expected_machines": [],
    "metrics": {
      "bloqueos": { "source": "gates", "dim": "control", "type": "ratio", "values": ["tests", "build", "sin-nombre"] },
      "escapes":  { "source": "bypass", "dim": "tipo", "type": "conteo", "values": ["FULL_SUITE_RUN", "sin-tipo"] },
      "hallazgos_por_gravedad": { "source": "hallazgos", "dim": "severidad", "type": "conteo", "values": ["CRITICAL", "WARNING"] }
    }
  }
}
JSON
}
hallazgos_basicos() {   # la serie como la deja el recolector: hallazgos, una línea de corrida leída, y su sello
  cat > "$1/hallazgos.jsonl" <<JSON
{"ts":"${D1}T10:00:00Z","corrida":"c-00000000aa01","regla":"SEC-C1","dueno":"tycon-plugin-security-basics","severidad":"CRITICAL","disposicion":"fixed"}
{"ts":"${D1}T11:00:00Z","corrida":"c-00000000aa01","regla":"SILENT-C2","dueno":"tycon-silent-failure-hunter","severidad":"WARNING","disposicion":"open"}
{"ts":"${D2}T09:00:00Z","corrida":"c-00000000aa02","regla":"SILENT-C2","dueno":"tycon-silent-failure-hunter","severidad":"WARNING","disposicion":"refuted"}
{"ts":"${D2}T09:30:00Z","corrida":"c-00000000aa02","regla":"I18N-W5","dueno":"i18n-hardcoded-text-reviewer","severidad":"robustness","disposicion":"fixed"}
{"ts":"${VIEJO}T01:00:00Z","corrida":"c-00000000aa03","regla":"SEC-C1","dueno":"tycon-plugin-security-basics","severidad":"CRITICAL","disposicion":"fixed"}
{"volcado":"9.1-${D1}T1000.json","medida":"con_hallazgos"}
JSON
  printf '{"estado":"recolectado","fecha":"%s","repos":1,"hallazgos":5,"volcados":{"leidos":1,"medidos":1}}\n' "${HOY}" > "$1/findings-seal.json"
}

# ── T15 · la fuente nueva cuenta, respeta la ventana y la lista cerrada ──────────────────────────
# 🔴 rojo previo: sin la entrada en FUENTES, el reductor se NIEGA (la métrica apunta a una fuente que
#    el código no conoce) — que es exactamente la guarda que dejó puesta la 2.5.
C="$(nuevo_caso t15)"; config_29 "${C}/sources.json"; hallazgos_basicos "${C}/local"
RC="$(contar "${C}" --json)"
if [ "${RC}" != "0" ]; then
  mal "T15 el reductor salió ${RC} con la fuente «hallazgos»: $(head -c 300 "${C}/err")"
else
  N="$(j "${C}" "d['metricas']['hallazgos_por_gravedad']['num']")"
  [ "${N}" = "4" ] && ok "T15 cuenta los 4 de la ventana (el de hace más de 30 días queda afuera)" \
    || mal "T15 num=${N}, esperaba 4"
  CR="$(j "${C}" "d['metricas']['hallazgos_por_gravedad']['porDim']['CRITICAL']['num']")"
  [ "${CR}" = "1" ] && ok "T15 desglosa por gravedad" || mal "T15 CRITICAL=${CR}, esperaba 1"
  OT="$(j "${C}" "d['metricas']['hallazgos_por_gravedad']['porDim']['otro']['num']")"
  [ "${OT}" = "1" ] && ok "T15 una gravedad fuera de la lista cerrada cuenta como «otro»" \
    || mal "T15 otro=${OT}, esperaba 1 — rojo previo: publicar el valor crudo saca «robustness» a la página"
  if grep -qE 'SEC-C1|SILENT-C2|I18N-W5|tycon-plugin-security-basics' "${C}/out"; then
    mal "T15 🔴 un identificador de regla o un dueño llegó a la salida del reductor — la dimensión publicada es la GRAVEDAD"
  else
    ok "T15 ni la regla ni el dueño salen por esta métrica"
  fi
fi

# ── T16 · una máquina bajada que no declara la fuente nueva NO cuenta (y no es 0) ────────────────
# 🔴 rojo previo: contar una máquina sin la fuente declarada como «0 hallazgos» baja el total del
#    equipo sin que nadie lo haya medido.
C="$(nuevo_caso t16)"; config_29 "${C}/sources.json"
gates_basicos "${C}/local"; bypass_basicos "${C}/local"; hallazgos_basicos "${C}/local"
# La otra máquina SÍ subió frenos y escapes (su cobertura los declara y sus .gz están), pero NO
# hallazgos: es el caso real de una máquina del equipo que todavía no corrió el recolector.
maquina_bajada "${C}/buzon" "maq-otra" "${D1}" "medido" "medido"
gz "${C}/local/gates.log"  "${C}/buzon/maq-otra/registros/gates.log.gz"
gz "${C}/local/bypass.log" "${C}/buzon/maq-otra/registros/bypass.log.gz"
RC="$(contar "${C}" --json)"
if [ "${RC}" != "0" ]; then
  mal "T16 salió ${RC}: $(head -c 300 "${C}/err")"
else
  MQ="$(j "${C}" "d['metricas']['hallazgos_por_gravedad']['maquinas']")"
  [ "${MQ}" = "2" ] && ok "T16 dos máquinas en el conjunto" || mal "T16 maquinas=${MQ}, esperaba 2"
  MI="$(j "${C}" "d['metricas']['hallazgos_por_gravedad']['midieron']")"
  [ "${MI}" = "1" ] && ok "T16 sólo 1 de 2 midió hallazgos, y se dice" \
    || mal "T16 midieron=${MI}, esperaba 1 — rojo previo: «no declaró la fuente» leído como «midió 0»"
  MB="$(j "${C}" "d['metricas']['bloqueos']['midieron']")"
  [ "${MB}" = "2" ] && ok "T16 y las métricas de la 2.5 siguen contando las dos máquinas" \
    || mal "T16 bloqueos.midieron=${MB}, esperaba 2 — regresión sobre la 2.5"
fi

# ── T17 · «medida» es la regla del recolector, de los dos lados ──────────────────────────────────
# 🔴 rojo previo (cazador de fallos silenciosos, vuelta 2): el reductor contaba la serie local si el
#    archivo existía — sin sello o vacía, «midió 0» —, y una del buzón aunque no coincidiera con su resumen.
C="$(nuevo_caso t17)"; config_29 "${C}/sources.json"; hallazgos_basicos "${C}/local"
rm -f "${C}/local/findings-seal.json"
RC="$(contar "${C}" --json)"
MI="$(j "${C}" "d['metricas']['hallazgos_por_gravedad']['midieron']")"
[ "${RC}" = "0" ] && [ "${MI}" = "0" ] && ok "T17 una serie local sin sello no midió (0 de 1), no «midió 0 hallazgos»" \
  || mal "T17 rc=${RC} midieron=${MI}, esperaba 0"
C="$(nuevo_caso t17b)"; config_29 "${C}/sources.json"
mkdir -p "${C}/buzon/maq-otra/registros" "${C}/tmp"
hallazgos_basicos "${C}/tmp"
gz "${C}/tmp/hallazgos.jsonl" "${C}/buzon/maq-otra/registros/hallazgos.jsonl.gz"
python3 - "${C}/buzon/maq-otra/registros/cobertura.json" "${D1}" <<'PY'
import json, sys
json.dump({"esquema": 1, "fecha": sys.argv[2], "fuentes": {
  "gates": {"estado": "no_medido", "motivo": "x"}, "bypass": {"estado": "no_medido", "motivo": "x"},
  "hallazgos": {"estado": "medido", "bytes": 1, "fecha": sys.argv[2], "resumen": {"hallazgos": 9, "volcados": {"medidos": 1}}}}},
  open(sys.argv[1], "w"))
PY
RC="$(contar "${C}" --json)"
MI="$(j "${C}" "d['metricas']['hallazgos_por_gravedad']['midieron']")"
[ "${MI}" = "0" ] && ok "T17 una serie del buzón que no coincide con su resumen (5 contra 9) no midió" \
  || mal "T17 midieron=${MI}, esperaba 0 — rojo previo: se contaba lo que llegara"
python3 - "${C}/buzon/maq-otra/registros/cobertura.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["fuentes"]["hallazgos"]["resumen"]["hallazgos"] = 5
json.dump(d, open(sys.argv[1], "w"))
PY
RC="$(contar "${C}" --json)"
N="$(j "${C}" "d['metricas']['hallazgos_por_gravedad']['num']")"; MI="$(j "${C}" "d['metricas']['hallazgos_por_gravedad']['midieron']")"
LI="$(j "${C}" "d['cobertura']['lineas_ilegibles']")"
[ "${MI}" = "1" ] && [ "${N}" = "4" ] && [ "${LI}" = "0" ] && ok "T17 con el resumen correcto midió, y la línea de corrida no es ni hallazgo ni línea ilegible (4 · 0)" \
  || mal "T17 midieron=${MI} num=${N} ilegibles=${LI}, esperaba 1, 4 y 0"

# ══════════════════════════════════════════════════════════════════════════════════════════════════
# Story 2.8 — mutación y guía de QA como serie del equipo
# ══════════════════════════════════════════════════════════════════════════════════════════════════
con_mutacion_qa() { # $1 = sources.json
  python3 - "$1" <<'PY2'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); m=d['reducer']['metrics']
m['mutacion_puntaje']={"source":"gates","dim":"control","type":"muestra_mutacion","values":["mutation"]}
m['mutacion_chequeos']={"source":"gates","dim":"estado","type":"ratio_mutacion_con_puntaje",
  "values":["pass","warn-survivors","blocked","structural","error","timeout-posible-mutacion","sin-estado"]}
m['qa_guia_estados']={"source":"gates","dim":"estado","type":"conteo_qa_guia","values":["missing","stale","presente","no-aplica","sin-estado"]}
m['qa_guia_presente']={"source":"gates","dim":"estado","type":"ratio_qa_presente","values":["presente","missing","stale"]}
json.dump(d,open(p,'w'))
PY2
}
# mut <archivo> <fecha> <estado> <killed|null> <total|null> — una línea `mutation` con los campos de texto libre
# que el reductor NO lee (reason, repoPath, story, sessionId).
mut() {
  python3 - "$@" <<'PY2'
import json, sys
f, fecha, st, k, t = sys.argv[1:6]
v = lambda x: None if x == 'null' else int(x)
with open(f, 'a') as o:
    o.write(json.dumps({"ts": f"{fecha}T10:00:00Z", "sessionId": "s-x", "repoPath": "/Users/x/Cliente", "name": "mutation",
        "story": "9.9", "total": v(t), "killed": v(k), "survived": 0, "verdict": None, "maxMutants": 12, "status": st,
        "reason": "texto libre"}) + "\n")
PY2
}
# qa <archivo> <fecha> <estado> <esquema|sin> [clave] — una línea `qa-guide`
qa() {
  python3 - "$@" <<'PY2'
import json, sys
f, fecha, st, esq = sys.argv[1:5]
o = {"ts": f"{fecha}T11:00:00Z", "sessionId": "s-x", "repoPath": "/Users/x/Cliente", "name": "qa-guide", "action": "warn",
     "status": st, "story": "/Users/x/Cliente/specs/stories/9-9.md"}
if esq != 'sin': o["esquema"] = int(esq)
if len(sys.argv) > 5: o["clave"] = sys.argv[5]
open(f, 'a').write(json.dumps(o) + "\n")
PY2
}

# ── 2.8-T1 · la mediana se arma con las muestras de TODAS las máquinas, y un chequeo sin puntaje no es una muestra ──
# 🔴 rojo previo: sin tipo de distribución el reductor se niega (exit 2); leyendo `total: null` como 0, o
#    aceptando `killed > total`, aparecen muestras de más.
C="$(nuevo_caso t28-1)"; con_mutacion_qa "${C}/sources.json"; gates_basicos "${C}/local"
mut "${C}/local/gates.log" "${D1}" warn-survivors 1 10
mut "${C}/local/gates.log" "${D1}" warn-survivors 2 10
mut "${C}/local/gates.log" "${D2}" warn-survivors 3 10
mut "${C}/local/gates.log" "${D2}" structural null null
mut "${C}/local/gates.log" "${D2}" pass 0 0
mut "${C}/local/gates.log" "${D2}" zzz-inventado null null
mkdir -p "${C}/tmp-b"
mut "${C}/tmp-b/gates.log" "${D1}" warn-survivors 9 10
for i in 1 2 3 4; do mut "${C}/tmp-b/gates.log" "${D1}" pass 12 12; done
mut "${C}/tmp-b/gates.log" "${VIEJO}" pass 5 10
mut "${C}/tmp-b/gates.log" "${D2}" warn-survivors 12 10
maquina_bajada "${C}/buzon" "maq-b" "${D1}" medido no_medido; gz "${C}/tmp-b/gates.log" "${C}/buzon/maq-b/registros/gates.log.gz"
RC="$(contar "${C}" --json)"
MU="$(j "${C}" "sorted(float(round(x,3)) for x in d['metricas']['mutacion_puntaje']['muestras'])")"
AP="$(j "${C}" "d['metricas']['mutacion_puntaje']['aportaron']")"
[ "${RC}" = "0" ] && [ "${MU}" = "[0.1, 0.2, 0.3, 0.9, 1.0, 1.0, 1.0, 1.0]" ] && [ "${AP}" = "2" ] \
  && ok "2.8-T1 8 muestras de dos máquinas (aportaron 2); ni structural, ni total 0, ni fuera de ventana, ni killed>total son muestras" \
  || mal "2.8-T1 rc=${RC} muestras=${MU} aportaron=${AP} err=$(head -c 300 "${C}/err")"

# ── 2.8-T2 · los chequeos por estado: con puntaje sobre todos los de mutación, y nada de otros controles ──
# 🔴 rojo previo: contar todas las líneas de gates.log → las 7 de `gates_basicos` inflan el denominador.
CHQ="$(j "${C}" "(d['metricas']['mutacion_chequeos']['num'], d['metricas']['mutacion_chequeos']['den'])")"
OT="$(j "${C}" "d['metricas']['mutacion_chequeos']['porDim'].get('otro',{}).get('den')")"
ST="$(j "${C}" "d['metricas']['mutacion_chequeos']['porDim'].get('structural',{}).get('den')")"
SE="$(j "${C}" "'sin-estado' in d['metricas']['mutacion_chequeos']['porDim']")"
[ "${CHQ}" = "(8, 12)" ] && [ "${OT}" = "1" ] && [ "${ST}" = "1" ] && [ "${SE}" = "False" ] \
  && ok "2.8-T2 8 con puntaje de 12 chequeos; el estado inventado sale «otro»; las líneas de otros controles no suman" \
  || mal "2.8-T2 chequeos=${CHQ} otro=${OT} structural=${ST} sin-estado=${SE}"
! grep -q 'zzz-inventado\|texto libre\|/Users/x' "${C}/out" && ok "2.8-T2 ni el estado inventado, ni el reason, ni la ruta salen del reductor" \
  || mal "2.8-T2 fuga en la salida: $(grep -o 'zzz-inventado\|texto libre\|/Users/x' "${C}/out" | head -2 | tr '\n' ' ')"

# ── 2.8-T3 · guía de QA: los estados se cuentan todos; la proporción sólo con el registro completo ──
# 🔴 rojo previo: contar todas las líneas en la proporción → 2 de 6 (las viejas sin esquema son sólo avisos).
C="$(nuevo_caso t28-3)"; con_mutacion_qa "${C}/sources.json"
qa "${C}/local/gates.log" "${D1}" presente 2; qa "${C}/local/gates.log" "${D1}" presente 2
qa "${C}/local/gates.log" "${D1}" missing 2;  qa "${C}/local/gates.log" "${D1}" no-aplica 2
for i in 1 2 3; do qa "${C}/local/gates.log" "${D2}" missing sin; done
RC="$(contar "${C}" --json)"
EST="$(j "${C}" "sorted((k,v['num']) for k,v in d['metricas']['qa_guia_estados']['porDim'].items())")"
PR="$(j "${C}" "(d['metricas']['qa_guia_presente']['num'], d['metricas']['qa_guia_presente']['den'])")"
[ "${RC}" = "0" ] && [ "${EST}" = "[('missing', 4), ('no-aplica', 1), ('presente', 2)]" ] && [ "${PR}" = "(2, 3)" ] \
  && ok "2.8-T3 estados missing 4 · presente 2 · no-aplica 1; presentes 2 de 3 (sólo esquema 2, sin no-aplica)" \
  || mal "2.8-T3 rc=${RC} estados=${EST} presente=${PR}"

# ── 2.8-T4 · una máquina que no midió su registro no aporta ni una muestra ni un cero ──
# 🔴 rojo previo: leer la ilegible como vacía → midieron 3 de 3, y la mediana se calcula igual sin decirlo.
C="$(nuevo_caso t28-4)"; con_mutacion_qa "${C}/sources.json"
mut "${C}/local/gates.log" "${D1}" pass 12 12; mut "${C}/local/gates.log" "${D1}" pass 6 12; mut "${C}/local/gates.log" "${D1}" pass 3 12
mkdir -p "${C}/tmp-b"; mut "${C}/tmp-b/gates.log" "${D1}" pass 0 12
maquina_bajada "${C}/buzon" "maq-b" "${D1}" no_medido no_medido; gz "${C}/tmp-b/gates.log" "${C}/buzon/maq-b/registros/gates.log.gz"
maquina_bajada "${C}/buzon" "maq-c" "${D1}" medido no_medido; echo "no soy gzip" > "${C}/buzon/maq-c/registros/gates.log.gz"
RC="$(contar "${C}" --json)"
R4="$(j "${C}" "(len(d['metricas']['mutacion_puntaje']['muestras']), d['metricas']['mutacion_puntaje']['midieron'], d['metricas']['mutacion_puntaje']['maquinas'], d['metricas']['mutacion_puntaje']['aportaron'])")"
[ "${RC}" = "0" ] && [ "${R4}" = "(3, 1, 3, 1)" ] \
  && ok "2.8-T4 3 muestras, midieron 1 de 3 máquinas, aportó 1: la no medida y la del .gz roto no suman un cero" \
  || mal "2.8-T4 rc=${RC} (muestras, midieron, maquinas, aportaron)=${R4}"

# ── 2.8-T5 · una guía que no aplica no es una evaluación: no entra al denominador de bloqueos ──
# 🔴 rojo previo: sin la exclusión, las dos `no-aplica` suben el denominador a 8.
C="$(nuevo_caso t28-5)"; con_mutacion_qa "${C}/sources.json"; gates_basicos "${C}/local"
qa "${C}/local/gates.log" "${D1}" no-aplica 2; qa "${C}/local/gates.log" "${D1}" no-aplica 2; qa "${C}/local/gates.log" "${D1}" presente 2
RC="$(contar "${C}" --json)"
BD="$(j "${C}" "d['metricas']['bloqueos']['den']")"
[ "${RC}" = "0" ] && [ "${BD}" = "6" ] \
  && ok "2.8-T5 bloqueos sobre 6 evaluaciones: las 5 de siempre + la guía presente; las dos que no aplican no cuentan" \
  || mal "2.8-T5 rc=${RC} bloqueos.den=${BD}, esperaba 6"

# ── 2.8-T6 · una métrica de distribución sin lista cerrada, o con un tipo que no existe, hace que se niegue ──
# 🔴 rojo previo: aceptar la métrica sin lista → sale 0 y publica.
for ROTA in sin-valores tipo-inventado; do
  C="$(nuevo_caso "t28-6-${ROTA}")"; con_mutacion_qa "${C}/sources.json"; mut "${C}/local/gates.log" "${D1}" pass 12 12
  python3 - "${C}/sources.json" "${ROTA}" <<'PY2'
import json, sys
p, rota = sys.argv[1:3]; d = json.load(open(p)); m = d['reducer']['metrics']['mutacion_puntaje']
if rota == 'sin-valores': del m['values']
if rota == 'tipo-inventado': m['type'] = 'muestra_inventada'
json.dump(d, open(p, 'w'))
PY2
  RC="$(contar "${C}" --json)"
  { [ "${RC}" = "2" ] && grep -q "mutacion_puntaje" "${C}/err"; } \
    && ok "2.8-T6 «${ROTA}» → exit 2 nombrando la métrica" || mal "2.8-T6 «${ROTA}» rc=${RC} err=$(head -c 200 "${C}/err")"
done

# ── 2.8-T7 · un cierre que rebota cuenta UNA vez: la clave se cuenta una sola vez (revisión, AC 5) ──
# 🔴 rojo previo: el hook anota una línea por INTENTO de commit, antes de frenos que pueden cortarlo; sin
#    deduplicar, tres rebotes del mismo cierre publican 3 de 4 donde lo real es 1 de 2.
C="$(nuevo_caso t28-7)"; con_mutacion_qa "${C}/sources.json"
for i in 1 2 3; do qa "${C}/local/gates.log" "${D1}" presente 2 aaaaaaaaaaaaaaaa; done
qa "${C}/local/gates.log" "${D1}" missing 2 bbbbbbbbbbbbbbbb
# 🔴 revisión iter 2: el mismo cierre rebota «missing», se genera la guía y el reintento da «presente» → cuenta el ÚLTIMO.
qa "${C}/local/gates.log" "${D1}" missing 2 cccccccccccccccc
qa "${C}/local/gates.log" "${D1}" presente 2 cccccccccccccccc
qa "${C}/local/gates.log" "${D2}" missing sin; qa "${C}/local/gates.log" "${D2}" missing sin
RC="$(contar "${C}" --json)"
EST="$(j "${C}" "sorted((k,v['num']) for k,v in d['metricas']['qa_guia_estados']['porDim'].items())")"
PR="$(j "${C}" "(d['metricas']['qa_guia_presente']['num'], d['metricas']['qa_guia_presente']['den'])")"
[ "${RC}" = "0" ] && [ "${EST}" = "[('missing', 3), ('presente', 2)]" ] && [ "${PR}" = "(2, 3)" ] \
  && ok "2.8-T7 un cierre cuenta una vez y con su ÚLTIMO resultado: tres rebotes son uno, missing→presente es presente; 2 de 3" \
  || mal "2.8-T7 rc=${RC} estados=${EST} presente=${PR} — rojo previo: «el primero gana» deja el cierre c como missing (1 de 3)"
if grep -q 'aaaaaaaaaaaaaaaa\|bbbbbbbbbbbbbbbb' "${C}/out"; then mal "2.8-T7 la clave salió en la salida del reductor"
else ok "2.8-T7 la clave no sale del reductor"; fi

# ── 2.8-T8 · una clave con forma rara NO deduplica: la línea cuenta suelta (revisión iter 3) ──
# 🔴 rojo previo (mutación): aceptar cualquier texto como clave → las dos «XYZ» se funden en un cierre.
C="$(nuevo_caso t28-8)"; con_mutacion_qa "${C}/sources.json"
qa "${C}/local/gates.log" "${D1}" presente 2 XYZ; qa "${C}/local/gates.log" "${D1}" presente 2 XYZ
qa "${C}/local/gates.log" "${D1}" missing 2 aaaaaaaaaaaaaaaaa
qa "${C}/local/gates.log" "${D1}" missing 2 aaaaaaaaaaaaaaaaa
RC="$(contar "${C}" --json)"
PR="$(j "${C}" "(d['metricas']['qa_guia_presente']['num'], d['metricas']['qa_guia_presente']['den'])")"
[ "${RC}" = "0" ] && [ "${PR}" = "(2, 4)" ] \
  && ok "2.8-T8 claves malformadas (3 letras, 17 hex) no deduplican: cada línea cuenta, 2 de 4" \
  || mal "2.8-T8 rc=${RC} presente=${PR}, esperaba (2, 4)"

# ── 2.8-T9 · el mismo cierre visto desde DOS máquinas cuenta una vez (revisión iter 3) ──
# 🔴 rojo previo (mutación): deduplicar sólo dentro de cada máquina → el cierre cuenta dos veces.
C="$(nuevo_caso t28-9)"; con_mutacion_qa "${C}/sources.json"
qa "${C}/local/gates.log" "${D1}" presente 2 dddddddddddddddd
mkdir -p "${C}/tmp-b"; qa "${C}/tmp-b/gates.log" "${D1}" presente 2 dddddddddddddddd; qa "${C}/tmp-b/gates.log" "${D1}" stale 2 eeeeeeeeeeeeeeee
maquina_bajada "${C}/buzon" "maq-b" "${D1}" medido no_medido; gz "${C}/tmp-b/gates.log" "${C}/buzon/maq-b/registros/gates.log.gz"
RC="$(contar "${C}" --json)"
PR="$(j "${C}" "(d['metricas']['qa_guia_presente']['num'], d['metricas']['qa_guia_presente']['den'], d['metricas']['qa_guia_presente']['aportaron'])")"
[ "${RC}" = "0" ] && [ "${PR}" = "(1, 2, 2)" ] \
  && ok "2.8-T9 el mismo cierre en dos máquinas cuenta uno: 1 de 2, y las dos máquinas aportaron" \
  || mal "2.8-T9 rc=${RC} (num, den, aportaron)=${PR}, esperaba (1, 2, 2)"

# ══════════════════════════════════════════════════════════════════════════════════════════════════
# Story 7.2 — cuántas evidencias rechazan los hooks del cierre
# ══════════════════════════════════════════════════════════════════════════════════════════════════

# ── 7.2-T6 · Reductor_EvidenciaRechazadaPorHook_ConDenominadorYNoMedido ──────────────────────────────
# 🔴 rojo previo: sin `values_only` el reductor se niega a una opción que no conoce… y sin él, los hooks
#    del cierre caerían como «otro» dentro de la ficha de los frenos previos (y viceversa). Una máquina con
#    `frenos.jsonl.gz` ilegible no mide: «midieron 1 de 2», nunca un cero sumado.
C="$(nuevo_caso t72-6)"
python3 - "${C}/sources.json" <<'PY2'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
seis=["safety-guard","test-scope-guard","pr-uno-por-repo","pr-sin-auto-complete","push-referencia-fantasma","prod-access-guard"]
d['reducer']['metrics']['frenos_bloqueos']={"source":"frenos","dim":"freno","type":"ratio_bloqueo","values_only":True,"values":seis}
d['reducer']['metrics']['evidencia_rechazada_por_hook']={"source":"frenos","dim":"freno","type":"ratio_bloqueo","values_only":True,
  "values":["on-frontmatter-write","on-pre-commit","on-dod-evidence-guard"]}
json.dump(d,open(p,'w'))
PY2
cat > "${C}/local/frenos.jsonl" <<JSON
{"ts":"${D1}T10:00:00Z","freno":"on-frontmatter-write","regla":"evidencia-ausente","veredicto":"bloqueo","sha256":"aa"}
{"ts":"${D1}T10:01:00Z","freno":"on-frontmatter-write","regla":"evidencia-ok","veredicto":"paso","sha256":"bb"}
{"ts":"${D1}T10:02:00Z","freno":"on-pre-commit","regla":"roster","veredicto":"bloqueo","sha256":"cc"}
{"ts":"${D1}T10:03:00Z","freno":"on-pre-commit","regla":"evidencia-ok","veredicto":"paso","sha256":"dd"}
{"ts":"${D1}T10:04:00Z","freno":"safety-guard","regla":"GIT-C1","veredicto":"bloqueo","sha256":"ee"}
JSON
R="${C}/buzon/maq-b/registros"; mkdir -p "${R}"
python3 - "${R}" "${D1}" <<'PY2'
import json,sys,os
r,fecha=sys.argv[1:3]
json.dump({"esquema":1,"fecha":fecha,"fuentes":{"gates":{"estado":"medido","bytes":1},"bypass":{"estado":"medido","bytes":1},"frenos":{"estado":"medido","bytes":1}}},
  open(os.path.join(r,"cobertura.json"),"w"))
PY2
: > "${R}/gates.log"; gzip -c "${R}/gates.log" > "${R}/gates.log.gz"; rm "${R}/gates.log"
: > "${R}/bypass.log"; gzip -c "${R}/bypass.log" > "${R}/bypass.log.gz"; rm "${R}/bypass.log"
echo "no soy gzip" > "${R}/frenos.jsonl.gz"
RC="$(contar "${C}" --json)"
EV="$(j "${C}" "(d['metricas']['evidencia_rechazada_por_hook']['num'], d['metricas']['evidencia_rechazada_por_hook']['den'], d['metricas']['evidencia_rechazada_por_hook']['midieron'], d['metricas']['evidencia_rechazada_por_hook']['maquinas'], sorted(d['metricas']['evidencia_rechazada_por_hook']['porDim'].keys()))")"
FB="$(j "${C}" "(d['metricas']['frenos_bloqueos']['num'], d['metricas']['frenos_bloqueos']['den'], sorted(d['metricas']['frenos_bloqueos']['porDim'].keys()))")"
[ "${RC}" = "0" ] && [ "${EV}" = "(2, 4, 1, 2, ['on-frontmatter-write', 'on-pre-commit'])" ] \
  && [ "${FB}" = "(1, 1, ['safety-guard'])" ] \
  && ok "7.2-T6 2 de 4 evidencias rechazadas (midieron 1 de 2); los hooks del cierre y los frenos previos no se mezclan como «otro»" \
  || mal "7.2-T6 rc=${RC} evidencia=${EV} frenos_previos=${FB} $(head -c 300 "${C}/err")"

# ── 7.2-T6b · `values_only` que no es booleano → el reductor se niega (lista blanca) ────────────────
# 🔴 rojo previo: una opción con forma inventada se aceptaría en silencio.
C="$(nuevo_caso t72-6b)"
python3 - "${C}/sources.json" <<'PY2'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
d['reducer']['metrics']['evidencia_rechazada_por_hook']={"source":"frenos","dim":"freno","type":"ratio_bloqueo","values_only":"si","values":["on-pre-commit"]}
json.dump(d,open(p,'w'))
PY2
RC="$(contar "${C}" --json)"
[ "${RC}" = "2" ] && ok "7.2-T6b «values_only» con forma inválida → se niega (exit 2)" || mal "7.2-T6b rc=${RC}"

echo
[ "${FALLOS}" -eq 0 ] && { echo "todo verde"; exit 0; }
echo "${FALLOS} fallo(s)"; exit 1
