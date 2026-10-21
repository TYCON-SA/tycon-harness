#!/usr/bin/env bash
# 🔴 AISLAMIENTO PRIMERO (si no, la suite toca lo real): HOME falso antes de
#    cualquier línea que ejecute algo. El recolector ESCRIBE en ~/.claude/.tycon-pipeline/, así que
#    sin esta línea una corrida de la suite pisaría el archivo real de la máquina.
HOME="$(mktemp -d)"; export HOME
#
# collect-findings.test.sh — el recolector de hallazgos de todos los repos.
#
# Qué defiende, y por qué existe cada caso:
#   · T1 proyeccion_por_lista_blanca — de cada hallazgo salen SEIS claves (con la huella de corrida). `reason` es prosa libre
#        (3 rutas del home, 6 menciones a una persona por nombre, un host de cliente y 34 decisiones
#        citadas, medidos en el material real) y `file` son rutas. No se publican, ni hoy ni mañana.
#   · T2 baja_dos_niveles — `repos-root.js` devuelve una CARPETA, no una lista. Medido: los 3 repos
#        de nivel 1 son los que ya commitean `.advisors/`; los archivos de nivel 2
#        son los que este recolector existe para traer. Un glob de un nivel junta lo que ya viaja, y la
#        cobertura dice «medido».
#   · T3 vocabularios_cerrados + una_vez_por_dia — sin lista escrita, el implementador la inventa
#        mirando sus propios datos. Y re-comprimir en cada arranque es trabajo por nada.
#   · T4 tres_ausencias_distintas — «sin archivo», «archivo con cero hallazgos» y «archivo de otro
#        esquema» son tres cosas distintas. Medido: 204 de 331 corridas sin archivo, 69 de ésas CON
#        reportes de revisores adentro, y sólo 7 son «revisé y no encontré nada». Tratar la ausencia
#        como cero baja la tasa de una regla sin que nadie la haya revisado.
#   · T5 modos_de_falla + fuera_de_catalogo_es_conteo — «no pude mirar» nunca es «no hay». Y el
#        identificador crudo NO sale: son 324 valores escritos a mano y cualquiera puede traer
#        adentro el nombre de un cliente.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la forma en que se pone rojo. El exit code se lee ANTES de cualquier
#    pipe. bash 3.2 (macOS): siempre `${v}`.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECOLECTOR="${RAIZ}/scripts/metrics/collect-findings.js"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

echo "== collect-findings.test.sh =="
[ -f "${RECOLECTOR}" ] || { mal "no existe ${RECOLECTOR} (rojo previo: el recolector todavía no está)"; echo; echo "${FALLOS} fallo(s)"; exit 1; }

BASE="$(mktemp -d)"
trap 'rm -rf "${BASE}" "${HOME}"' EXIT
unset TYCON_REPOS_ROOT TYCON_FINDINGS_OUTPUT TYCON_TODAY TYCON_CATALOG TYCON_REVIEWERS_DIR TYCON_HISTORY_DIR
# Las carpetas de corrida llevan la hora LOCAL de la máquina: los casos fijan la zona para que el
# emparejamiento con los volcados (en UTC) no dependa de dónde corre la suite.
export TZ="America/Argentina/Buenos_Aires"

HOY="2026-09-16"

# ── andamios ────────────────────────────────────────────────────────────────────────────────────
catalogo() {               # $1 = ruta del .md
  cat > "$1" <<'MD'
# Catálogo

## Silent Failure Hunter — `tycon-silent-failure-hunter`

| Regla | Qué detecta | Fix |
|---|---|---|
| **SILENT-C2** | catch vacío | loguear |
| **SILENT-W1** | return null sin log | idem |

## Security — `tycon-plugin-security-basics`

| Regla | Qué detecta | Fix |
|---|---|---|
| **SEC-C1** | path injection | escapar |
MD
}
roster() {                 # $1 = dir ; resto = ids
  local d="$1"; shift; mkdir -p "${d}"
  local id; for id in "$@"; do printf 'name = "%s"\n' "${id}" > "${d}/${id}.toml"; done
}
repo() {                   # $1 = ruta del repo → lo crea con .git
  mkdir -p "$1/.git"
}
corrida() {                # $1 = repo ; $2 = nombre del run dir ; $3 = contenido de findings.json ('' = sin archivo)
  local d="$1/.advisors/pipeline-runs/$2"; mkdir -p "${d}"
  if [ -n "$3" ]; then printf '%s' "$3" > "${d}/findings.json"; fi
}
reportes() {               # $1 = repo ; $2 = run dir → le pone reportes de revisores adentro
  mkdir -p "$1/.advisors/pipeline-runs/$2/step-05-advisor-reports"
  printf '# reporte\n' > "$1/.advisors/pipeline-runs/$2/step-05-advisor-reports/tycon-story-validator.md"
}

recolectar() {             # $1 = caso ; resto = args → RC ; salida en ${OUT}/${ERR}
  local C="$1"; shift
  OUT="${C}/out"; ERR="${C}/err"
  TYCON_REPOS_ROOT="${C}/raiz" \
  TYCON_FINDINGS_OUTPUT="${C}/estado/hallazgos.jsonl" \
  TYCON_TODAY="${HOY}" \
    node "${RECOLECTOR}" --catalog "${C}/catalogo.md" --reviewers "${C}/revisores" "$@" > "${OUT}" 2> "${ERR}"
}
nuevo() {                  # $1 = nombre → crea el caso y lo imprime
  local C="${BASE}/$1"; mkdir -p "${C}/raiz" "${C}/estado"
  catalogo "${C}/catalogo.md"
  roster "${C}/revisores" tycon-silent-failure-hunter tycon-plugin-security-basics
  echo "${C}"
}
py() { python3 -c "$1" 2>/dev/null; }

# ── T1 · la proyección: seis claves, ni una más ─────────────────────────────────────────────────
C="$(nuevo t1)"
repo "${C}/raiz/repoA"
corrida "${C}/raiz/repoA" "2.9-20260910T101010" '[{"rule_id":"SILENT-C2","severity":"CRITICAL","advisor":"tycon-silent-failure-hunter","file":"/Users/fulano/SourceCode/Cliente/src/App.tsx","disposition":"fixed","reason":"decisión del dev «arreglarlo ahora», host db-cliente-prod con 4.2M filas"}]'
recolectar "${C}" --json; RC=$?
if [ "${RC}" -ne 0 ]; then
  mal "T1 · el recolector salió ${RC} sobre un repo bien formado (stderr: $(head -c 200 "${ERR}"))"
else
  N="$(wc -l < "${C}/estado/hallazgos.jsonl" | tr -d ' ')"
  [ "${N}" = "1" ] && ok "T1 · una línea por hallazgo" || mal "T1 · ${N} líneas, esperaba 1"
  CLAVES="$(py "
import json
d=json.loads(open('${C}/estado/hallazgos.jsonl').readline())
print(','.join(sorted(d.keys())))")"
  [ "${CLAVES}" = "corrida,disposicion,dueno,regla,severidad,ts" ] \
    && ok "T1 · exactamente 6 claves: ${CLAVES}" \
    || mal "T1 · claves=${CLAVES} — rojo previo: copiar el objeto entero deja pasar reason y file"
  CORR="$(py "
import json
print(json.loads(open('${C}/estado/hallazgos.jsonl').readline())['corrida'])")"
  case "${CORR}" in c-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ok "T1 · la corrida es una huella opaca (${CORR})" ;;
    *) mal "T1 · corrida=${CORR} — tiene que ser una huella que no diga qué repo ni qué story" ;; esac
  if grep -qiE 'fulano|Cliente|App\.tsx|arreglarlo ahora|db-cliente-prod|4\.2M' "${C}/estado/hallazgos.jsonl"; then
    mal "T1 · 🔴 FUGA: prosa o rutas del original en la salida — rojo previo: publicar reason/file filtra rutas del home, nombres de persona y datos de cliente"
  else
    ok "T1 · ni prosa, ni rutas, ni datos de cliente en la salida"
  fi
  TS="$(py "
import json
print(json.loads(open('${C}/estado/hallazgos.jsonl').readline())['ts'])")"
  case "${TS}" in 2026-09-10*) ok "T1 · el ts sale del nombre del run dir (${TS})" ;;
    *) mal "T1 · ts=${TS} — rojo previo: usar la hora de la corrida del recolector mete todo en la ventana de hoy y borra la serie" ;; esac
  DUENO="$(py "
import json
print(json.loads(open('${C}/estado/hallazgos.jsonl').readline())['dueno'])")"
  [ "${DUENO}" = "tycon-silent-failure-hunter" ] && ok "T1 · el dueño sale del catálogo" \
    || mal "T1 · dueno=${DUENO} — rojo previo: confiar en el campo advisor del archivo, que no es el dueño declarado"
fi

# ── T2 · baja dos niveles ────────────────────────────────────────────────────────────────────────
C="$(nuevo t2)"
repo "${C}/raiz/repoA"
corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","file":"x","disposition":"open","reason":"y"}]'
repo "${C}/raiz/grupo/repoB"
corrida "${C}/raiz/grupo/repoB" "1.2-20260902T090000" '[{"rule_id":"SILENT-W1","severity":"WARNING","advisor":"tycon-silent-failure-hunter","file":"x","disposition":"fixed","reason":"y"}]'
mkdir -p "${C}/raiz/repoA/node_modules/paquete/.advisors/pipeline-runs/9.9-20260903T090000"
printf '[{"rule_id":"SEC-C1","severity":"CRITICAL","advisor":"x","file":"x","disposition":"open","reason":"y"}]' > "${C}/raiz/repoA/node_modules/paquete/.advisors/pipeline-runs/9.9-20260903T090000/findings.json"
recolectar "${C}" --json; RC=$?
if [ "${RC}" -ne 0 ]; then
  mal "T2 · salió ${RC} (stderr: $(head -c 200 "${ERR}"))"
else
  N="$(wc -l < "${C}/estado/hallazgos.jsonl" | tr -d ' ')"
  [ "${N}" = "2" ] && ok "T2 · el repo anidado se recolecta (2 hallazgos, nivel 1 + nivel 2)" \
    || mal "T2 · ${N} hallazgos, esperaba 2 — rojo previo: un glob de un nivel junta SÓLO lo que ya viaja por git y la cobertura igual dice «medido»"
  REPOS="$(py "
import json
print(json.load(open('${OUT}'))['repos'])")"
  [ "${REPOS}" = "2" ] && ok "T2 · la cobertura dice cuántos repos recorrió (${REPOS})" \
    || mal "T2 · repos=${REPOS}, esperaba 2 — rojo previo: sin el conteo, «no encontré nada» y «no busqué» se ven igual"
  PROF="$(py "
import json
print(json.load(open('${OUT}'))['profundidad'])")"
  [ "${PROF}" = "2" ] && ok "T2 · la cobertura declara la profundidad" || mal "T2 · profundidad=${PROF}, esperaba 2"
  if grep -q 'node_modules' "${C}/estado/hallazgos.jsonl" 2>/dev/null; then
    mal "T2 · entró a node_modules"
  else
    ok "T2 · no entra a node_modules"
  fi
fi

# ── T3 · vocabularios cerrados y sello diario ────────────────────────────────────────────────────
C="$(nuevo t3)"
repo "${C}/raiz/repoA"
corrida "${C}/raiz/repoA" "3.1-20260905T090000" '[{"rule_id":"SEC-C1","severity":"robustness","advisor":"tycon-plugin-security-basics","file":"x","disposition":"inventada","reason":"y"},{"rule_id":"SILENT-C2","severity":"CRITICAL","advisor":"tycon-silent-failure-hunter","file":"x","disposition":"refuted","reason":"y"}]'
recolectar "${C}" --json; RC=$?
if [ "${RC}" -ne 0 ]; then
  mal "T3 · salió ${RC}"
else
  OTROS="$(py "
import json
ls=[json.loads(l) for l in open('${C}/estado/hallazgos.jsonl')]
print(sum(1 for x in ls if x['severidad']=='otro')+sum(1 for x in ls if x['disposicion']=='otro'))")"
  [ "${OTROS}" = "2" ] && ok "T3 · un valor fuera de vocabulario sale «otro» y se cuenta" \
    || mal "T3 · ${OTROS} valores en «otro», esperaba 2 — rojo previo: sin lista cerrada el implementador la inventa mirando sus propios datos; medido, ya existe un severity «robustness»"
  REF="$(py "
import json
ls=[json.loads(l) for l in open('${C}/estado/hallazgos.jsonl')]
print(sum(1 for x in ls if x['disposicion']=='refuted'))")"
  [ "${REF}" = "1" ] && ok "T3 · un valor del vocabulario pasa tal cual" || mal "T3 · refuted=${REF}, esperaba 1"
fi
# segunda pasada el MISMO día
MTIME1="$(py "import os;print(int(os.path.getmtime('${C}/estado/hallazgos.jsonl')*1000))")"
recolectar "${C}" --json; RC=$?
MTIME2="$(py "import os;print(int(os.path.getmtime('${C}/estado/hallazgos.jsonl')*1000))")"
[ "${MTIME1}" = "${MTIME2}" ] && ok "T3 · la 2ª pasada del mismo día no reescribe" \
  || mal "T3 · reescribió el mismo día — rojo previo: recolectar en cada arranque es trabajo por nada, y con 143 archivos se nota"
ESTADO="$(py "
import json
print(json.load(open('${OUT}'))['estado'])")"
[ "${ESTADO}" = "ya_recolectado_hoy" ] && ok "T3 · y lo dice (${ESTADO})" || mal "T3 · estado=${ESTADO}, esperaba ya_recolectado_hoy"
# el día siguiente
TYCON_REPOS_ROOT="${C}/raiz" TYCON_FINDINGS_OUTPUT="${C}/estado/hallazgos.jsonl" TYCON_TODAY="2026-09-17" \
  node "${RECOLECTOR}" --catalog "${C}/catalogo.md" --reviewers "${C}/revisores" --json > "${C}/out2" 2>&1; RC=$?
E2="$(py "
import json
print(json.load(open('${C}/out2'))['estado'])")"
[ "${E2}" = "recolectado" ] && ok "T3 · al día siguiente vuelve a recolectar" || mal "T3 · estado=${E2} el día siguiente, esperaba recolectado"

# ── T4 · tres ausencias distintas ────────────────────────────────────────────────────────────────
C="$(nuevo t4)"
repo "${C}/raiz/repoA"
corrida "${C}/raiz/repoA" "4.1-20260906T090000" ''                 # sin archivo…
reportes "${C}/raiz/repoA" "4.1-20260906T090000"                   # …pero CON reportes de revisores
corrida "${C}/raiz/repoA" "4.2-20260906T100000" '[]'               # archivo con cero hallazgos
corrida "${C}/raiz/repoA" "4.3-20260906T110000" '{"story":"6.1","resumen":"la contraseña de producción del Llavero"}'
corrida "${C}/raiz/repoA" "4.4-20260906T120000" ''                 # sin archivo y sin reportes
recolectar "${C}" --json; RC=$?
if [ "${RC}" -ne 0 ]; then
  mal "T4 · salió ${RC} (stderr: $(head -c 200 "${ERR}"))"
else
  for par in "sin_evidencia:1" "revisado_sin_hallazgos:1" "otro_esquema:1"; do
    k="${par%%:*}"; esperado="${par##*:}"
    v="$(py "
import json
print(json.load(open('${OUT}')).get('${k}'))")"
    [ "${v}" = "${esperado}" ] && ok "T4 · ${k}=${v}" \
      || mal "T4 · ${k}=${v}, esperaba ${esperado} — rojo previo: tratar la ausencia como cero hallazgos baja la tasa de una regla sin que nadie la haya revisado"
  done
  if grep -qi 'contraseña\|Llavero' "${C}/estado/hallazgos.jsonl" 2>/dev/null; then
    mal "T4 · 🔴 FUGA: prosa del segundo esquema en la salida — rojo previo: la lista blanca nombraba sólo reason y file"
  else
    ok "T4 · la prosa del segundo esquema no sale"
  fi
fi

# ── T5 · modos de falla y el conteo (no la lista) de lo que está fuera del catálogo ──────────────
C="$(nuevo t5)"
repo "${C}/raiz/repoA"
corrida "${C}/raiz/repoA" "5.1-20260907T090000" '[{"rule_id":"ADV-5B-1","severity":"WARNING","advisor":"x","file":"x","disposition":"open","reason":"y"},{"rule_id":"ACME-BANCO-C1","severity":"WARNING","advisor":"x","file":"x","disposition":"open","reason":"y"},{"rule_id":"SEC-C1","severity":"CRITICAL","advisor":"tycon-plugin-security-basics","file":"x","disposition":"fixed","reason":"y"}]'
corrida "${C}/raiz/repoA" "5.2-20260907T100000" 'esto no es json'
recolectar "${C}" --json; RC=$?
if [ "${RC}" -ne 0 ]; then
  mal "T5 · salió ${RC} (stderr: $(head -c 200 "${ERR}"))"
else
  FC="$(py "
import json
print(json.load(open('${OUT}'))['fuera_de_catalogo'])")"
  [ "${FC}" = "2" ] && ok "T5 · fuera_de_catalogo=2, contado aparte" \
    || mal "T5 · fuera_de_catalogo=${FC}, esperaba 2 — rojo previo: descartarlos en silencio pierde 505 de 1179 hallazgos"
  ES_NUM="$(py "
import json
v=json.load(open('${OUT}'))['fuera_de_catalogo']
print('num' if isinstance(v,int) else 'lista')")"
  [ "${ES_NUM}" = "num" ] && ok "T5 · es un CONTEO, no una lista" \
    || mal "T5 · fuera_de_catalogo es una lista — rojo previo: cualquiera de los 324 identificadores escritos a mano puede traer adentro el nombre de un cliente"
  if grep -q 'ACME' "${C}/estado/hallazgos.jsonl" 2>/dev/null || grep -q 'ACME' "${OUT}" 2>/dev/null; then
    mal "T5 · 🔴 FUGA: un identificador crudo salió del recolector"
  else
    ok "T5 · el identificador crudo no sale"
  fi
  ILEG="$(py "
import json
print(json.load(open('${OUT}'))['archivos_ilegibles'])")"
  [ "${ILEG}" = "1" ] && ok "T5 · el archivo ilegible se cuenta, no se descarta" || mal "T5 · archivos_ilegibles=${ILEG}, esperaba 1"
  N="$(wc -l < "${C}/estado/hallazgos.jsonl" | tr -d ' ')"
  [ "${N}" = "1" ] && ok "T5 · sólo el hallazgo del catálogo entra a la serie" || mal "T5 · ${N} líneas, esperaba 1"
fi

# raíz que no existe → no medido con motivo, nunca vacío en verde
C="$(nuevo t5b)"; rm -rf "${C}/raiz"
recolectar "${C}" --json; RC=$?
[ "${RC}" = "2" ] && ok "T5 · raíz inexistente → exit 2" \
  || mal "T5 · raíz inexistente salió ${RC}, esperaba 2 — rojo previo: salir 0 sin archivo se lee como «este equipo no encontró nada»"
grep -q . "${ERR}" && ok "T5 · con motivo en stderr" || mal "T5 · sin motivo — rojo previo: un fallo mudo es indistinguible de «no hay hallazgos»"
[ -f "${C}/estado/hallazgos.jsonl" ] && mal "T5 · escribió un archivo igual — rojo previo: un .jsonl vacío se sube y se lee como «0 hallazgos»" \
  || ok "T5 · no deja un archivo que se leería como cero"

# ── T6 · el camino por DEFECTO (sin raíz declarada) ─────────────────────────────────────────────
# 🔴 Cubre el camino que usa la máquina del dev: los demás casos inyectan la raíz por variable de entorno, así que
#    el ÚNICO camino real sería el único sin probar (llamar a una función que no existe en
#    `repos-root.js` —`reposRoot().raiz` en vez de `resolveReposRoot().root`— reventaría con un TypeError).
#    Lo que resuelve el resolvedor depende del disco (bajo HOME falso a veces encuentra una raíz y a
#    veces no), así que se exige lo invariante: o midió y dice de dónde salió la raíz, o no pudo y el
#    motivo habla de la raíz. Nunca un error de programación.
C="$(nuevo t6)"
OUT="${C}/out"; ERR="${C}/err"
TYCON_FINDINGS_OUTPUT="${C}/estado/hallazgos.jsonl" TYCON_TODAY="${HOY}" \
  node "${RECOLECTOR}" --catalog "${C}/catalogo.md" --reviewers "${C}/revisores" --dry-run --json > "${OUT}" 2> "${ERR}"; RC=$?
if grep -qiE 'is not a function|undefined is not|TypeError|Cannot read' "${ERR}" "${OUT}"; then
  mal "T6 · 🔴 error de programación en el camino por defecto: $(head -c 200 "${ERR}") — rojo previo EXACTO: la API es resolveReposRoot().root, no reposRoot().raiz"
else
  ok "T6 · el camino por defecto usa la interfaz real de repos-root (sin TypeError)"
fi
if [ "${RC}" = "0" ]; then
  FUENTE="$(py "
import json
print(json.load(open('${OUT}')).get('raiz_fuente'))")"
  case "${FUENTE}" in ''|None) mal "T6 · midió sin decir de dónde salió la raíz" ;; *) ok "T6 · resolvió la raíz sola y dice de dónde (${FUENTE})" ;; esac
elif [ "${RC}" = "2" ]; then
  # Alternancia y no `[ií]`: con LC_CTYPE=C la í son dos bytes y el corchete no la reconoce (la suite
  # salía roja en una consola sin locale y verde en el nocturno, que corre en UTF-8).
  grep -qiE 'ra(i|í)z de repos|ningún repo' "${ERR}" && ok "T6 · no pudo resolver la raíz y lo dice (exit 2)" \
    || mal "T6 · exit 2 con un motivo que no habla de la raíz: $(head -c 160 "${ERR}")"
else
  mal "T6 · salió ${RC}: ni midió (0) ni dijo que no pudo (2)"
fi
[ -f "${C}/estado/hallazgos.jsonl" ] && mal "T6 · una simulación escribió la serie" || ok "T6 · la simulación no escribe la serie"

# ══════════════════════════════════════════════════════════════════════════════════════════════════
# Una lectura que falla no termina contada como dato bueno
# ══════════════════════════════════════════════════════════════════════════════════════════════════
jq_out() { py "
import json
print(json.load(open('${OUT}')).get('$1'))"; }

# ── T7 · fechas con guiones, y una corrida sin fecha NO emite ────────────────────────────────────
# 🔴 sin esto, sólo se entiende AAAAMMDD; 11 de 17 corridas «sin fecha» la tienen con guiones, y a
#    todas se les pondría la fecha de hoy — o sea que caerían en la ventana actual aunque fueran de mayo.
C="$(nuevo t7)"; repo "${C}/raiz/repoA"
corrida "${C}/raiz/repoA" "3.25-2026-07-27-2308" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","file":"x","disposition":"fixed","reason":"y"}]'
corrida "${C}/raiz/repoA" "D.6.6-2026-05-02T21-56-13" '[{"rule_id":"SILENT-C2","severity":"WARNING","advisor":"tycon-silent-failure-hunter","file":"x","disposition":"fixed","reason":"y"}]'
corrida "${C}/raiz/repoA" "1.3-manual" '[{"rule_id":"SEC-C1","severity":"CRITICAL","advisor":"tycon-plugin-security-basics","file":"x","disposition":"open","reason":"y"}]'
recolectar "${C}" --json; RC=$?
TSS="$(py "
import json
print(sorted(json.loads(l)['ts'][:10] for l in open('${C}/estado/hallazgos.jsonl')))")"
[ "${TSS}" = "['2026-05-02', '2026-07-27']" ] && ok "T7 las fechas con guiones se entienden (2026-05-02 y 2026-07-27)" \
  || mal "T7 fechas=${TSS} — rojo previo: con guiones no se entendía y quedaba la fecha de hoy"
[ "$(jq_out sin_fecha)" = "1" ] && ok "T7 la corrida sin fecha se cuenta y NO emite" \
  || mal "T7 sin_fecha=$(jq_out sin_fecha) — rojo previo: se le inventaba la fecha de hoy"
grep -q "$(date +%Y-%m-%d)" "${C}/estado/hallazgos.jsonl" && mal "T7 un hallazgo quedó con la fecha de hoy" || ok "T7 ningún hallazgo lleva una fecha inventada"

# ── T8 · cero repos es «no medido», no «recolectado» ─────────────────────────────────────────────
C="$(nuevo t8)"; mkdir -p "${C}/raiz/carpeta-sin-git"
recolectar "${C}" --json; RC=$?
[ "${RC}" = "2" ] && [ ! -f "${C}/estado/hallazgos.jsonl" ] && ok "T8 una raíz sin un solo repo → exit 2 y sin archivo" \
  || mal "T8 rc=${RC} — rojo previo: raíz equivocada → «recolectado», exit 0 y un archivo vacío que se sube como «0 hallazgos»"

# ── T9 · lo que no se puede listar se CUENTA ─────────────────────────────────────────────────────
C="$(nuevo t9)"
repo "${C}/raiz/repoA"; corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","file":"x","disposition":"open","reason":"y"}]'
repo "${C}/raiz/repoB"; corrida "${C}/raiz/repoB" "1.2-20260902T090000" '[]'
corrida "${C}/raiz/repoB" "1.3-20260903T090000" '[]'
mkdir -p "${C}/raiz/grupo-cerrado/repoC/.git"
chmod 000 "${C}/raiz/grupo-cerrado"                                   # un subárbol ilegible
chmod 000 "${C}/raiz/repoB/.advisors/pipeline-runs/1.3-20260903T090000" # una corrida ilegible
recolectar "${C}" --json; RC=$?
chmod 755 "${C}/raiz/grupo-cerrado" "${C}/raiz/repoB/.advisors/pipeline-runs/1.3-20260903T090000"
CI="$(jq_out carpetas_ilegibles)"
[ "${RC}" = "0" ] && [ "${CI}" = "2" ] && ok "T9 el subárbol y la corrida ilegibles se cuentan (2)" \
  || mal "T9 rc=${RC} carpetas_ilegibles=${CI} — rojo previo: desaparecían sin sumar a nada"

# ── T10 · los baldes suman el total de corridas ─────────────────────────────────────────────────
C="$(nuevo t10)"; repo "${C}/raiz/repoA"
corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","file":"x","disposition":"open","reason":"y"}]'
corrida "${C}/raiz/repoA" "1.2-20260902T090000" '[]'
corrida "${C}/raiz/repoA" "1.3-20260903T090000" '{"story":"x"}'
corrida "${C}/raiz/repoA" "1.4-20260904T090000" ''; reportes "${C}/raiz/repoA" "1.4-20260904T090000"
corrida "${C}/raiz/repoA" "1.5-20260905T090000" ''
corrida "${C}/raiz/repoA" "1.6-20260906T090000" 'roto'
corrida "${C}/raiz/repoA" "1.7-manual" '[]'
recolectar "${C}" --json; RC=$?
SUMA="$(py "
import json
d=json.load(open('${OUT}'))
b=d['baldes']
print(sum(b.values()), d['run_dirs'], sorted(b.items()))")"
case "${SUMA}" in "7 7 "*) ok "T10 los baldes suman el total (7 corridas, cada una en exactamente uno)" ;;
  *) mal "T10 ${SUMA} — rojo previo: una corrida sin archivo y sin reportes, o con un archivo roto, no caía en ningún balde" ;; esac

# ── T11 · un elemento sin identificador de regla no es «fuera de catálogo» ───────────────────────
C="$(nuevo t11)"; repo "${C}/raiz/repoA"
corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[{"severity":"WARNING","file":"x"},{"rule_id":42},{"rule_id":"INVENTADA-C1","severity":"WARNING"}]'
recolectar "${C}" --json; RC=$?
[ "$(jq_out elementos_sin_regla)" = "2" ] && [ "$(jq_out fuera_de_catalogo)" = "1" ] \
  && ok "T11 sin identificador (2) y fuera de catálogo (1) se cuentan por separado" \
  || mal "T11 sin_regla=$(jq_out elementos_sin_regla) fuera=$(jq_out fuera_de_catalogo) — rojo previo: todo iba a «fuera de catálogo»"

# ── T12 · una fecha de hoy inválida no se reemplaza en silencio ──────────────────────────────────
C="$(nuevo t12)"; repo "${C}/raiz/repoA"; corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[]'
OUT="${C}/out"; ERR="${C}/err"
TYCON_REPOS_ROOT="${C}/raiz" TYCON_FINDINGS_OUTPUT="${C}/estado/hallazgos.jsonl" \
  node "${RECOLECTOR}" --catalog "${C}/catalogo.md" --reviewers "${C}/revisores" --today "16/09/2026" --json > "${OUT}" 2> "${ERR}"; RC=$?
[ "${RC}" = "2" ] && grep -qi 'fecha' "${ERR}" && ok "T12 --today inválido → exit 2 con motivo" \
  || mal "T12 rc=${RC} — rojo previo: usaba la fecha real sin avisar"

# ── T13 · los vocabularios salen de sources.json, y el del reductor es el mismo ───────────────────
C="$(nuevo t13)"; repo "${C}/raiz/repoA"
corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","file":"x","disposition":"parked","reason":"y"}]'
python3 - "${C}/sources.json" <<'PYF'
import json,sys
json.dump({"sources": [], "prune": {"vocabularies": {"severity": ["CRITICAL", "WARNING"], "disposition": ["fixed", "parked"]}}}, open(sys.argv[1], "w"))
PYF
recolectar "${C}" --sources "${C}/sources.json" --json; RC=$?
DISP="$(py "
import json
print(json.loads(open('${C}/estado/hallazgos.jsonl').readline())['disposicion'])")"
[ "${DISP}" = "parked" ] && ok "T13 la lista de disposiciones es la de sources.json (un valor declarado ahí pasa)" \
  || mal "T13 disposicion=${DISP} — rojo previo: la lista vivía en el guion y sources.json no mandaba"
python3 - "${RAIZ}/scripts/nightly/dashboard/sources.json" <<'PYF' && ok "T13 la gravedad del reductor y la de la poda son LA MISMA lista" || mal "T13 las dos listas de gravedad difieren — dos copias del mismo vocabulario se separan solas"
import json,sys
d=json.load(open(sys.argv[1]))
a=d['reducer']['metrics']['hallazgos_por_gravedad']['values']
b=d['prune']['vocabularies']['severity']
assert a==b, (a,b)
PYF
C2="$(nuevo t13b)"; repo "${C2}/raiz/repoA"; corrida "${C2}/raiz/repoA" "1.1-20260901T090000" '[]'
printf '{"sources":[]}' > "${C2}/sources.json"
recolectar "${C2}" --sources "${C2}/sources.json" --json; RC=$?
[ "${RC}" = "2" ] && ok "T13 sin vocabularios declarados → exit 2 (no se inventan)" \
  || mal "T13 rc=${RC} — sin la lista declarada, el recolector no puede decidir qué es «otro»"

# ── T14 · el estado de la serie: la única regla de «esto está medido» ───────────────────────────
C="$(nuevo t14)"; repo "${C}/raiz/repoA"; corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[]'
recolectar "${C}" --json; RC=$?
estado_serie() {  # $1 = salida ; $2 = hoy
  node -e '
    const r = require(process.argv[1]).estadoDeLaSerie({ salida: process.argv[2], hoy: process.argv[3] });
    console.log(r.estado + (r.motivo ? " · " + r.motivo : ""));
  ' "${RECOLECTOR}" "$1" "$2"
}
E1="$(estado_serie "${C}/estado/hallazgos.jsonl" "${HOY}")"
case "${E1}" in medido*) ok "T14 la serie recién recolectada está medida" ;; *) mal "T14 ${E1}" ;; esac
E2="$(estado_serie "${C}/estado/hallazgos.jsonl" "2026-09-30")"
case "${E2}" in no_medido*) ok "T14 una serie de hace dos semanas NO está medida (el recolector dejó de correr)" ;;
  *) mal "T14 ${E2} — rojo previo: un archivo viejo se subía como medido todos los días" ;; esac
rm -f "${C}/estado/findings-seal.json"
E3="$(estado_serie "${C}/estado/hallazgos.jsonl" "${HOY}")"
case "${E3}" in no_medido*) ok "T14 sin sello no hay medición, aunque el archivo exista" ;;
  *) mal "T14 ${E3} — rojo previo: un archivo sin sello (vacío, a mano, de otra versión) contaba como medido" ;; esac

# ── T15 · el presupuesto de tiempo corta y lo dice ───────────────────────────────────────────────
C="$(nuevo t15)"; repo "${C}/raiz/repoA"; corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[]'
recolectar "${C}" --budget-ms 0 --json; RC=$?
[ "${RC}" = "2" ] && [ ! -f "${C}/estado/hallazgos.jsonl" ] && ok "T15 sin tiempo → exit 2 y sin archivo (una recolección a medias no se sube)" \
  || mal "T15 rc=${RC} — rojo previo: sin tope, un recolector colgado frenaba la subida y la bajada sin rastro"

# ── T16 · UNA lista por corrida: las copias intermedias no se suman ──────────────────────────────
# 🔴 sin esto, se suman findings-input, -iterN, -final y findings.json; un solo
#    refutado real llega a 3 y manda la regla a revisión humana.
C="$(nuevo t16)"; repo "${C}/raiz/repoA"
D="${C}/raiz/repoA/.advisors/pipeline-runs/9.1-20260825T003248"; mkdir -p "${D}"
UNO='[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","file":"x","disposition":"refuted","reason":"y"}]'
for f in findings-input findings-iter1 findings-iter2 findings; do printf '%s' "${UNO}" > "${D}/${f}.json"; done
recolectar "${C}" --json; RC=$?
N="$(wc -l < "${C}/estado/hallazgos.jsonl" | tr -d ' ')"
[ "${N}" = "1" ] && [ "$(jq_out copias_ignoradas)" = "3" ] && ok "T16 cuatro copias → 1 hallazgo, y 3 copias ignoradas contadas" \
  || mal "T16 hallazgos=${N} copias_ignoradas=$(jq_out copias_ignoradas) — rojo previo: cada copia sumaba el hallazgo otra vez"
D2="${C}/raiz/repoA/.advisors/pipeline-runs/9.2-20260826T003248"; mkdir -p "${D2}"
printf '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","disposition":"open"}]' > "${D2}/findings-input.json"
printf '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","disposition":"fixed"}]' > "${D2}/findings-iter2.json"
printf '[]' > "${D2}/findings-iter1.json"
rm -f "${C}/estado/findings-seal.json"
recolectar "${C}" --json; RC=$?
DISP="$(py "
import json
print([json.loads(l)['disposicion'] for l in open('${C}/estado/hallazgos.jsonl') if json.loads(l)['ts'].startswith('2026-08-26')])")"
[ "${DISP}" = "['fixed']" ] && ok "T16 sin findings.json se lee la vuelta más alta, nunca la entrada" \
  || mal "T16 disposiciones=${DISP} — la foto de ANTES de arreglar no es la verdad de la corrida"

# ── T17 · la identidad de la corrida es la misma en todos los clones ─────────────────────────────
# 🔴 un findings.json commiteado existe en cada clon; sin identidad, el total del equipo lo
#    cuenta una vez por máquina.
C="$(nuevo t17)"
for clon in uno otro-nombre; do
  repo "${C}/raiz/${clon}"
  printf '[remote "origin"]\n\turl = https://dev.azure.com/org/proj/_git/el-repo\n' > "${C}/raiz/${clon}/.git/config"
  corrida "${C}/raiz/${clon}" "4.2-20260901T090000" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","file":"x","disposition":"fixed","reason":"y"}]'
done
recolectar "${C}" --json; RC=$?
IDS="$(py "
import json
print(len({json.loads(l)['corrida'] for l in open('${C}/estado/hallazgos.jsonl')}))")"
[ "${IDS}" = "1" ] && ok "T17 dos clones con carpetas de nombre distinto dan la MISMA huella de corrida" \
  || mal "T17 huellas distintas=${IDS} — rojo previo: sin identidad estable, el cruce no puede contar una corrida una sola vez"
grep -q 'el-repo\|dev.azure' "${C}/estado/hallazgos.jsonl" && mal "T17 🔴 la dirección del remoto salió en la serie" || ok "T17 la huella no deja ver el remoto"
NL="$(wc -l < "${C}/estado/hallazgos.jsonl" | tr -d ' ')"; REP="$(py "import json;print(json.load(open('${OUT}'))['baldes']['repetida'])")"
[ "${NL}" = "1" ] && [ "${REP}" = "1" ] && ok "T17 dos clones en la misma máquina: la corrida se lee UNA vez y la otra es «repetida»" \
  || mal "T17 líneas=${NL} repetida=${REP}, esperaba 1 y 1 — rojo previo: el mismo refutado contado dos veces llevaba una regla a revisión humana"

# ── T18 · «sin evidencia» reconoce las tres formas en que quedan los informes ────────────────────
C="$(nuevo t18)"; repo "${C}/raiz/repoA"; B="${C}/raiz/repoA/.advisors/pipeline-runs"
mkdir -p "${B}/1.1-20260901T090000" "${B}/1.2-20260902T090000" "${B}/1.3-20260903T090000"
printf '# x\n' > "${B}/1.1-20260901T090000/step-05-tycon-story-validator.md"
printf '# x\n' > "${B}/1.2-20260902T090000/step-06-consolidated-report.md"
recolectar "${C}" --json; RC=$?
[ "$(jq_out sin_evidencia)" = "2" ] && ok "T18 informes sueltos o el consolidado del paso 6 también son «sin evidencia» (2)" \
  || mal "T18 sin_evidencia=$(jq_out sin_evidencia) — rojo previo: sólo se reconocía la carpeta de informes (105 informes sueltos en disco)"
[ "$(py "
import json
print(json.load(open('${OUT}'))['baldes']['sin_nada'])")" = "1" ] && ok "T18 una corrida sin archivo ni informes es «sin nada»" || mal "T18 sin_nada mal contado"

# ── T19 · un worktree hermano no duplica las corridas ────────────────────────────────────────────
C="$(nuevo t19)"; repo "${C}/raiz/Repo"
corrida "${C}/raiz/Repo" "1.1-20260901T090000" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","disposition":"fixed"}]'
mkdir -p "${C}/raiz/Repo--merge"; printf 'gitdir: ../Repo/.git/worktrees/merge\n' > "${C}/raiz/Repo--merge/.git"
corrida "${C}/raiz/Repo--merge" "1.1-20260901T090000" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","disposition":"fixed"}]'
recolectar "${C}" --json; RC=$?
[ "$(jq_out repos)" = "1" ] && [ "$(jq_out worktrees_salteados)" = "1" ] && ok "T19 el worktree <Repo>--merge se saltea y se cuenta" \
  || mal "T19 repos=$(jq_out repos) worktrees=$(jq_out worktrees_salteados) — rojo previo: un .git como archivo contaba como otro repo"

# ── T20 · las corridas de un subproyecto de un monorepo también se recolectan ────────────────────
C="$(nuevo t20)"; repo "${C}/raiz/mono"
corrida "${C}/raiz/mono/app-front" "1.1-20260901T090000" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","disposition":"fixed"}]'
recolectar "${C}" --json; RC=$?
[ "$(jq_out hallazgos)" = "1" ] && ok "T20 una corrida en <repo>/<subproyecto>/.advisors se recolecta" \
  || mal "T20 hallazgos=$(jq_out hallazgos) — rojo previo: sólo se miraba donde estaba .git y el subproyecto se salteaba sin decirlo"

# ── T21 · una simulación que falla NO borra la serie real ────────────────────────────────────────
C="$(nuevo t21)"; repo "${C}/raiz/repoA"; corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[]'
recolectar "${C}" --json; RC=$?
[ -f "${C}/estado/hallazgos.jsonl" ] || mal "T21 preparación: no quedó la serie"
OUT="${C}/out2"; ERR="${C}/err2"
TYCON_REPOS_ROOT="${C}/no-existe" TYCON_FINDINGS_OUTPUT="${C}/estado/hallazgos.jsonl" TYCON_TODAY="${HOY}" \
  node "${RECOLECTOR}" --catalog "${C}/catalogo.md" --reviewers "${C}/revisores" --dry-run --json > "${OUT}" 2> "${ERR}"; RC=$?
[ "${RC}" = "2" ] && [ -f "${C}/estado/hallazgos.jsonl" ] && [ -f "${C}/estado/findings-seal.json" ] \
  && ok "T21 un --dry-run que falla deja la serie y el sello reales intactos" \
  || mal "T21 rc=${RC} — rojo previo: la simulación borraba la serie real del día"

# ── T22 · el tercer esquema (ruleId) se cuenta y NO se traduce inventando la disposición ─────────
C="$(nuevo t22)"; repo "${C}/raiz/repoA"
corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[{"ruleId":"SEC-C1","severity":"WARNING","summary":"x","resolved":true}, 5, "texto"]'
recolectar "${C}" --json; RC=$?
[ "$(jq_out elementos_otro_esquema)" = "3" ] && [ "$(jq_out hallazgos)" = "0" ] && ok "T22 un elemento con ruleId, o que no es un objeto, se cuenta como otro esquema y no emite" \
  || mal "T22 otro_esquema=$(jq_out elementos_otro_esquema) hallazgos=$(jq_out hallazgos)"

# ════════════════════════ cruce con los volcados de historia y lectura de la serie ════════════════════════
volcado_h() {   # $1 = dir historia ; $2 = nombre ; $3 = storyId ; $4 = repoPath ; $5 = inicio UTC ; $6 = fin UTC
  mkdir -p "$1"
  printf '{"archivedAt":"%s","marker":{"storyId":"%s","repoPath":"%s","startedAt":"%s","lastTouch":"%s","sessionId":"s-%s"},"revisores":{"estado":"medido","por_tipo":{"tycon-plugin-security-basics":2}}}\n' \
    "$6" "$3" "$4" "$5" "$6" "$2" > "$1/$2.json"
}
# ── T23 · el denominador: cada volcado se empareja con su corrida, y sólo cuenta si se LEYÓ ───────
# 🔴 sin esto, el cruce suma oportunidades de toda corrida con conteo, también de las que no dejaron
#    hallazgos legibles (49 de 113 en el material real). Esas se leen como «cero hallazgos».
C="$(nuevo t23)"; R="${C}/raiz/repoA"; repo "${R}"; H="${C}/historia"
# 2.1: con hallazgos (carpeta 09:51 hora local = 12:51Z; sesión 12:45Z → 13:20Z)
corrida "${R}" "2.1-20260831-095132" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","disposition":"fixed"}]'
volcado_h "${H}" "2.1-2026-08-31T1320" "2.1" "${R}" "2026-08-31T12:45:16Z" "2026-08-31T13:20:00Z"
# 2.2: revisó y no encontró nada
corrida "${R}" "2.2-20260901T100000" '[]'
volcado_h "${H}" "2.2-2026-09-01T1400" "2.2" "${R}" "2026-09-01T12:55:00Z" "2026-09-01T14:00:00Z"
# 2.3: corrieron revisores y no quedó el archivo
corrida "${R}" "2.3-20260902T100000" ''; reportes "${R}" "2.3-20260902T100000"
volcado_h "${H}" "2.3-2026-09-02T1400" "2.3" "${R}" "2026-09-02T12:55:00Z" "2026-09-02T14:00:00Z"
# 2.4: el volcado de un repo que ya no existe (un clon borrado)
volcado_h "${H}" "2.4-2026-09-03T1400" "2.4" "${C}/raiz/borrado" "2026-09-03T12:55:00Z" "2026-09-03T14:00:00Z"
# 2.5: la carpeta de la story es de OTRA sesión (un mes antes): no es la suya
corrida "${R}" "2.5-20260801T100000" '[]'
volcado_h "${H}" "2.5-2026-09-04T1400" "2.5" "${R}" "2026-09-04T12:55:00Z" "2026-09-04T14:00:00Z"
# 2.6: ninguna carpeta de esa story
volcado_h "${H}" "2.6-2026-09-05T1400" "2.6" "${R}" "2026-09-05T12:55:00Z" "2026-09-05T14:00:00Z"
recolectar "${C}" --history "${H}" --json; RC=$?
VOL="$(py "
import json
d=json.load(open('${OUT}'))['volcados']
print(d['leidos'], d['medidos'], d['sin_hallazgos_legibles'], d['sin_repo'], d['sin_corrida'])")"
[ "${RC}" = "0" ] && [ "${VOL}" = "6 2 1 1 2" ] && ok "T23 6 volcados: 2 con su corrida leída, 1 sin hallazgos legibles, 1 sin repo, 2 sin corrida en su sesión" \
  || mal "T23 rc=${RC} volcados(leidos medidos sin_legibles sin_repo sin_corrida)=${VOL}, esperaba 6 2 1 1 2"
MED="$(py "
import json
print(sorted((o['volcado'], o['medida']) for o in map(json.loads, open('${C}/estado/hallazgos.jsonl')) if 'volcado' in o))")"
[ "${MED}" = "[('2.1-2026-08-31T1320.json', 'con_hallazgos'), ('2.2-2026-09-01T1400.json', 'revisado_sin_hallazgos')]" ] \
  && ok "T23 la serie nombra sólo los volcados cuya corrida se leyó, con cómo se leyó" \
  || mal "T23 volcados en la serie=${MED}"
if grep -q "${C}" "${C}/estado/hallazgos.jsonl"; then mal "T23 🔴 una ruta del disco llegó a la serie"; else ok "T23 las líneas de corrida no llevan rutas"; fi
E="$(node -e 'const r=require(process.argv[1]).estadoDeLaSerie({salida:process.argv[2],hoy:process.argv[3]});console.log(r.estado)' "${RECOLECTOR}" "${C}/estado/hallazgos.jsonl" "${HOY}")"
[ "${E}" = "medido" ] && ok "T23 la serie con líneas de corrida sigue medida" || mal "T23 estado=${E}"

# ── T24 · la serie que no coincide con su sello NO está medida ────────────────────────────────────
# 🔴 sin esto, una serie vacía (a medio escribir) con un sello bueno se lee «medida, 0 hallazgos» y todo
#    lo probado sale candidata (4 → 14); una línea de otro formato, también.
C="$(nuevo t24)"; repo "${C}/raiz/repoA"
corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","disposition":"fixed"}]'
recolectar "${C}" --json; RC=$?
estado_de_serie() { node -e 'const r=require(process.argv[1]).estadoDeLaSerie({salida:process.argv[2],hoy:process.argv[3]});console.log(r.estado+" · "+(r.motivo||""))' "${RECOLECTOR}" "$1" "${HOY}"; }
cp "${C}/estado/hallazgos.jsonl" "${C}/copia.jsonl"
: > "${C}/estado/hallazgos.jsonl"
case "$(estado_de_serie "${C}/estado/hallazgos.jsonl")" in no_medido*coincide*) ok "T24 serie vacía con sello de 1 hallazgo → no medida" ;;
  *) mal "T24 serie vacía con sello bueno: $(estado_de_serie "${C}/estado/hallazgos.jsonl")" ;; esac
{ cat "${C}/copia.jsonl"; printf '{"ts":"2026-09-01T09:00:00Z","regla":"SEC-C1","dueno":"x","severidad":"WARNING","disposicion":"fixed"}\n'; } > "${C}/estado/hallazgos.jsonl"
case "$(estado_de_serie "${C}/estado/hallazgos.jsonl")" in no_medido*ilegibles*) ok "T24 una línea sin huella de corrida → no medida" ;;
  *) mal "T24 línea de otro formato: $(estado_de_serie "${C}/estado/hallazgos.jsonl")" ;; esac

# ── T25 · una salida que no es una serie no se pisa ni se borra ──────────────────────────────────
C="$(nuevo t25)"; repo "${C}/raiz/repoA"; corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[]'
printf 'no me borres\n' > "${C}/gates.log"
OUT="${C}/out"; ERR="${C}/err"
TYCON_REPOS_ROOT="${C}/no-existe" TYCON_FINDINGS_OUTPUT="${C}/gates.log" TYCON_TODAY="${HOY}" \
  node "${RECOLECTOR}" --catalog "${C}/catalogo.md" --reviewers "${C}/revisores" --json > "${OUT}" 2> "${ERR}"; RC=$?
[ "${RC}" = "2" ] && [ "$(cat "${C}/gates.log")" = "no me borres" ] && ok "T25 --output sin .jsonl → exit 2 y el archivo intacto" \
  || mal "T25 rc=${RC} contenido=$(cat "${C}/gates.log" 2>&1) — rojo previo: una medición fallida BORRABA lo que se le pasara"

# ── T26 · un enlace y una carpeta de último nivel ilegible se cuentan ────────────────────────────
C="$(nuevo t26)"; repo "${C}/raiz/repoA"; corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[]'
ln -s "${C}/raiz/repoA" "${C}/raiz/enlace"
mkdir -p "${C}/raiz/Cont/Dos/.git"; chmod 000 "${C}/raiz/Cont/Dos"
recolectar "${C}" --json; RC=$?
chmod 755 "${C}/raiz/Cont/Dos"
[ "$(jq_out enlaces_salteados)" = "1" ] && [ "$(jq_out carpetas_ilegibles)" = "1" ] && [ "$(jq_out repos)" = "1" ] \
  && ok "T26 el enlace se saltea y se cuenta; la carpeta de nivel 2 ilegible se cuenta" \
  || mal "T26 enlaces=$(jq_out enlaces_salteados) ilegibles=$(jq_out carpetas_ilegibles) repos=$(jq_out repos) — rojo previo: desaparecían sin sumar"

# ── T27 · lo que sale de la máquina es una lista de CLAVES, no «todo lo que sea número» ──────────
node -e '
  const { conteosDelSello } = require(process.argv[1]);
  const ajeno = JSON.parse("{\"repos\":2,\"__proto__\":{\"x\":1},\"RUTA-/Users/fulana\":3,\"baldes\":{\"con_hallazgos\":1,\"cliente-secreto\":9},\"hallazgos\":\"5\"}");
  const r = conteosDelSello(ajeno);
  const txt = JSON.stringify(r);
  if (({}).x !== undefined) { console.error("prototipo contaminado"); process.exit(1); }
  if (/fulana|secreto|__proto__/.test(txt)) { console.error("clave ajena: " + txt); process.exit(1); }
  if (r.repos !== 2 || r.baldes.con_hallazgos !== 1 || "hallazgos" in r) { console.error("forma: " + txt); process.exit(1); }
' "${RECOLECTOR}" 2>"${BASE}/t27.err" \
  && ok "T27 del sello sólo salen las claves conocidas con números (ni nombres raros ni __proto__)" \
  || mal "T27 $(cat "${BASE}/t27.err") — rojo previo: el filtro miraba el valor y dejaba pasar texto en el nombre de la clave"

# ── T28 · la copia repetida es `repetida` en CUALQUIER balde, y la que se pudo leer es la que cuenta ──
# 🔴 sin esto, sólo las corridas leídas se marcan repetidas; una sin archivo en dos
#    clones suma dos veces a su balde, y una ilegible en un clon y legible en el otro queda mal contada.
C="$(nuevo t28)"
for clon in a-clon b-clon; do
  repo "${C}/raiz/${clon}"
  printf '[remote "origin"]\n\turl = https://dev.azure.com/org/proj/_git/mismo\n' > "${C}/raiz/${clon}/.git/config"
  corrida "${C}/raiz/${clon}" "7.1-20260901T090000" ''; reportes "${C}/raiz/${clon}" "7.1-20260901T090000"
done
corrida "${C}/raiz/a-clon" "7.2-20260902T090000" 'roto'
corrida "${C}/raiz/b-clon" "7.2-20260902T090000" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","disposition":"fixed"}]'
recolectar "${C}" --json; RC=$?
B="$(py "
import json
d=json.load(open('${OUT}')); b=d['baldes']
print(b['sin_evidencia'], b['ilegible'], b['con_hallazgos'], b['repetida'], sum(b.values()), d['run_dirs'], d['hallazgos'])")"
[ "${B}" = "1 0 1 2 4 4 1" ] && ok "T28 dos clones: cada corrida una vez; la copia legible cuenta y la ilegible es la repetida" \
  || mal "T28 (sin_evidencia ilegible con_hallazgos repetida suma run_dirs hallazgos)=${B}, esperaba 1 0 1 2 4 4 1"

# ── T29 · un subproyecto que es su propio repo se lee UNA vez ─────────────────────────────────────
C="$(nuevo t29)"; repo "${C}/raiz/mono"; repo "${C}/raiz/mono/app"
printf '[remote "origin"]\n\turl = https://dev.azure.com/org/proj/_git/app\n' > "${C}/raiz/mono/app/.git/config"
corrida "${C}/raiz/mono/app" "8.1-20260901T090000" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","disposition":"fixed"}]'
recolectar "${C}" --json; RC=$?
[ "$(jq_out hallazgos)" = "1" ] && [ "$(jq_out run_dirs)" = "1" ] && ok "T29 el subproyecto-repo se lee una vez (1 corrida, 1 hallazgo)" \
  || mal "T29 hallazgos=$(jq_out hallazgos) run_dirs=$(jq_out run_dirs) — rojo previo: se leía como subproyecto del padre y como repo propio, con huellas distintas"

# ── T30 · el sello con su nombre en inglés, y el viejo sigue valiendo ────────
# 🔴 renombrar el sello sin leer el viejo deja la serie de cada máquina «no medida» (la subida y el
#    tablero lo dirían) hasta la próxima recolección; y escribirlo sin pasar el viejo al nuevo perdería la historia.
#    El nombre viejo sale del mapa de renombres, no se escribe acá.
# en la copia pública el mapa no viaja: sin nombre viejo no hay migración que mirar (se saltea con motivo)
if [ ! -f "${RAIZ}/scripts/lib/renames.json" ]; then
  ok "T30 se saltea — copia pública, sin el mapa de renombres"
else
VIEJO="$(node -e '
  const m = require(process.argv[1]);
  const e = m.entries.find((x) => x.batch === "D2" && x.kind === "state-file" && x.new.endsWith("/findings-seal.json"));
  process.stdout.write(e ? e.old.split("/").pop() : "");
' "${RAIZ}/scripts/lib/renames.json")"
[ -n "${VIEJO}" ] || mal "T30 el mapa no tiene la entrada del sello (findings-seal.json)"
C="$(nuevo t30)"; repo "${C}/raiz/repoA"
corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[{"rule_id":"SEC-C1","severity":"WARNING","advisor":"tycon-plugin-security-basics","disposition":"fixed"}]'
recolectar "${C}" --json; RC=$?
CASA="${HOME}/.claude/.tycon-pipeline"; mkdir -p "${CASA}"
cp "${C}/estado/hallazgos.jsonl" "${CASA}/hallazgos.jsonl"
cp "${C}/estado/findings-seal.json" "${CASA}/${VIEJO}"
E="$(TYCON_FINDINGS_OUTPUT= node -e 'const r=require(process.argv[1]).estadoDeLaSerie({hoy:process.argv[2]});console.log(r.estado+" · "+(r.motivo||""))' "${RECOLECTOR}" "${HOY}")"
case "${E}" in medido*) ok "T30 con sólo el sello viejo, la serie de la máquina sigue medida" ;;
  *) mal "T30 sólo el sello viejo: ${E}" ;; esac
# el viejo, de un día anterior: la recolección de hoy corre y escribe el nuevo; el viejo queda intacto
python3 -c "
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['fecha']='2026-09-15'; json.dump(d,open(p,'w'))" "${CASA}/${VIEJO}"
cp "${CASA}/${VIEJO}" "${C}/viejo-antes.json"
OUT="${C}/out3"; ERR="${C}/err3"
TYCON_FINDINGS_OUTPUT= TYCON_REPOS_ROOT="${C}/raiz" TYCON_TODAY="${HOY}" \
  node "${RECOLECTOR}" --catalog "${C}/catalogo.md" --reviewers "${C}/revisores" --json > "${OUT}" 2> "${ERR}"; RC=$?
FECHA_NUEVO="$(py "import json; print(json.load(open('${CASA}/findings-seal.json'))['fecha'])")"
[ "${RC}" = "0" ] && [ "${FECHA_NUEVO}" = "${HOY}" ] && cmp -s "${C}/viejo-antes.json" "${CASA}/${VIEJO}" \
  && ok "T30 la recolección escribe findings-seal.json y deja el sello viejo intacto" \
  || mal "T30 rc=${RC} fecha del nuevo=${FECHA_NUEVO} — $(ls "${CASA}" 2>&1 | tr '\n' ' ') $(head -c 200 "${ERR}")"
# otra serie (no la de la máquina): `<serie>-seal.json` al lado
C="$(nuevo t30b)"; repo "${C}/raiz/repoA"; corrida "${C}/raiz/repoA" "1.1-20260901T090000" '[]'
OUT="${C}/out"; ERR="${C}/err"
TYCON_REPOS_ROOT="${C}/raiz" TYCON_FINDINGS_OUTPUT="${C}/estado/otra.jsonl" TYCON_TODAY="${HOY}" \
  node "${RECOLECTOR}" --catalog "${C}/catalogo.md" --reviewers "${C}/revisores" --json > "${OUT}" 2> "${ERR}"; RC=$?
[ "${RC}" = "0" ] && [ -f "${C}/estado/otra-seal.json" ] && [ ! -e "${C}/estado/findings-seal.json" ] \
  && ok "T30 una serie con otro nombre lleva su sello <serie>-seal.json al lado" \
  || mal "T30 rc=${RC} — $(ls "${C}/estado" 2>&1 | tr '\n' ' ')"
fi

echo
echo "${FALLOS} fallo(s)"
[ "${FALLOS}" -eq 0 ] || exit 1
