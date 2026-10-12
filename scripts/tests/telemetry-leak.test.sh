#!/usr/bin/env bash
# 🔴 AISLAMIENTO PRIMERO (story 2.5): HOME falso ANTES de cualquier otra línea que ejecute algo. En la 2.16
#    el rojo previo de una suite nueva, corrido contra el guion viejo, leyó la configuración REAL de la
#    máquina y empujó datos de prueba al buzón de verdad. Acá nada puede encontrar un registro real.
HOME="$(mktemp -d)"; export HOME
#
# telemetry-leak.test.sh — LA PRUEBA DE FUGA DEL REDUCTOR (story 2.5, condición de entrega).
#
# Cada máquina sube sus registros de frenos y escapes al buzón (privado, lo lee sólo quien fue autorizado) y el
# reductor los cuenta para la página del tablero, que ve todo el equipo. Esos registros traen comandos,
# rutas, prompts y nombres de cliente. Esta suite siembra marcadores —en los campos que el reductor lee, en
# los que no, y en archivos que NO debe abrir—, corre la cadena real (la preparación de la subida en la
# máquina A → carpeta de buzón → reductor y tablero en la máquina B) y FALLA si un marcador aparece en la
# salida del reductor o en la página. No es una promesa: es la prueba.
#
# 🔴 CONTROL POSITIVO: sin él, un reductor que no publica nada pasaría la prueba de fuga. Se exige que
#    los frenos y escapes sembrados LLEGUEN a la página con su número (sumadas las dos máquinas).
#
# Rojo previo verificado (Dev Agent Record de la 2.5): publicar el valor crudo de la dimensión en vez
# de «otro» → aparecen el nombre de cliente y el comando. Leer timing-history/ → el espía lo ve.
#
# 🔴 STORY 2.9 amplía la prueba a los HALLAZGOS de los revisores. Se siembran, en `findings.json` de repos
#    fabricados, los campos de texto libre (`reason`, `file`) y los del SEGUNDO esquema (`resumen`,
#    `los_que_mas_pesan`, `verificacion`) con marcadores, y un identificador de regla con nombre de cliente
#    que TIENE forma válida (`CLIENTESECRETOSA-C1`): pasa el filtro de forma y sólo lo frena la lista
#    cerrada. Se corre el recolector REAL en la máquina A, la preparación real, y el tablero (con el cruce
#    de poda adentro) en la máquina B. Y el espía exige que ni el reductor NI el cruce abran los
#    `findings.json` originales: leen sólo lo que el recolector preparó.
#
# bash 3.2 (macOS): siempre `${v}`. El exit code se lee antes de cualquier pipe.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REDUCTOR="${RAIZ}/scripts/nightly/dashboard/reducer.js"
TABLERO="${RAIZ}/scripts/nightly/dashboard/dashboard.js"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

echo "== telemetry-leak.test.sh =="
[ -f "${REDUCTOR}" ] || { mal "no existe ${REDUCTOR} (rojo previo: el reductor todavía no está)"; echo; echo "${FALLOS} fallo(s)"; exit 1; }

BASE="$(mktemp -d)"
trap 'rm -rf "${BASE}" "${HOME}"' EXIT
unset TYCON_LOGS_SOURCE TYCON_LOGS_DIR TYCON_MAILBOX_DIR TYCON_SOURCES_JSON TYCON_TODAY TYCON_MACHINE

# ── los marcadores ───────────────────────────────────────────────────────────────────────────────
M_CORREO="fuga.persona@cliente-secreto.com"
M_RUTA="/Users/fulano/SourceCode/ClienteSecretoSA/Pagos/x.cs"
M_CLIENTE="ClienteSecretoSA"
M_CMD="git push --force FUGA-CMD-5521"
M_PROMPT="PROMPT-FUGA-7731 implementemos lo del cliente"
M_SESION="00000000-0000-4000-8000-000000000011"
M_PERSONA="Devbs-MacBook-Pro"
# únicos por archivo que el reductor NO debe abrir
M_LANE="MARCA-LANE-4410"
M_HILO="MARCA-HILO-4411"
M_TIMING="MARCA-TIMING-4412"
M_SAFETY="MARCA-SAFETY-4413"
M_ESTILO="MARCA-ESTILO-4414"
# story 2.9 — los hallazgos de los revisores
M_PERSONA_NOMBRE="Devito-FugaPersona"
M_DECISION="DECISION-DEV-FUGA-2291 arreglarlo ahora"
M_FILE="/Users/fulano/Clientes/SecretoSA/src/Clave.cs"
M_REGLA_CLIENTE="CLIENTESECRETOSA-C1"
# 🔴 Sólo se buscan marcadores ÚNICOS. La primera versión buscaba también «contraseña» y «Llavero» y dio
#    fuga en falso: el tablero ya publica, sin nada sembrado, una nota del propio arnés que usa esas dos
#    palabras. Un marcador que aparece solo no prueba nada; por eso el resumen lleva su token propio.
M_RESUMEN="RESUMEN-FUGA-6610 la contraseña de producción del Llavero"
M_PESAN="PESAN-FUGA-6611"
M_VERIF="VERIF-FUGA-6612"
# story 2.8 — la mutación y la guía de QA
M_MUT="MUT-FUGA-3301"
M_QA="QA-FUGA-3302"
# 2026-09-17 — la COLA de la salida que `marker.js run-check` guarda al dar rojo. gates.log viaja al
# buzón; el reductor no debe leer ese campo (lista blanca). Se siembra con correo, ruta del home y cliente.
M_COLA="COLA-FUGA-8801"
# story 2.19 — el cambio de git de cada corrida (`<volcado>.cambio.json.gz`): trae código de cliente. Sólo lo
# abre la vista de corridas (privada), y ahí la clave sale tapada; el tablero, el reductor y la poda no lo abren.
M_GIT="CAMBIO-GIT-FUGA-5550"
M_CLAVE_GIT="ClaveFuga9981"

AYER="$(node -e 'console.log(new Date(Date.now()-864e5).toISOString().slice(0,10))')"
ANTEAYER="$(node -e 'console.log(new Date(Date.now()-2*864e5).toISOString().slice(0,10))')"

# Siembra una casa completa: registros que el reductor lee y archivos que no debe abrir.
sembrar() {   # $1 = HOME de la máquina
  local P="$1/.claude/.tycon-pipeline"
  mkdir -p "${P}/lane" "${P}/timing-history" "$1/.claude/response-style"
  python3 - "${P}" "${AYER}" "${ANTEAYER}" <<PY
import json, sys, gzip
p, ayer, anteayer = sys.argv[1], sys.argv[2], sys.argv[3]
g = []
# 4 bloqueos de un «control» con nombre de cliente → tiene que salir como «otro»
for i, d in enumerate([ayer, ayer, anteayer, anteayer]):
    g.append({"ts": f"{d}T1{i}:00:00Z", "sessionId": "${M_SESION}", "name": "${M_CLIENTE}", "status": "blocked",
              "cmd": "${M_CMD}", "repoPath": "${M_RUTA}", "reason": "falló ${M_CORREO}", "story": "${M_RUTA}"})
# 3 evaluaciones sanas de un control conocido
for i in range(3):
    g.append({"ts": f"{ayer}T0{i}:00:00Z", "sessionId": "${M_SESION}", "check": "tests", "status": "green",
              "cmd": "${M_CMD}", "repoPath": "${M_RUTA}", "exit": 0, "durationMs": 1000})
# un control ROJO con la cola de su salida (2026-09-17): correo, ruta del home y cliente adentro
g.append({"ts": f"{ayer}T06:30:00Z", "sessionId": "${M_SESION}", "check": "tests", "status": "red:exit=1",
          "cmd": "${M_CMD}", "repoPath": "${M_RUTA}", "exit": 1, "durationMs": 2000,
          "cola": "${M_COLA} FALLA en ${M_RUTA} de ${M_CORREO} (${M_CLIENTE})"})
# la aprobación del plan trae el PROMPT del dev
g.append({"ts": f"{ayer}T05:00:00Z", "sessionId": "${M_SESION}", "name": "plan-approval", "status": "approved",
          "text": "${M_PROMPT}", "story": "${M_RUTA}"})
# story 2.8 · la mutación y la guía de QA: se siembran los marcadores en los campos de texto libre que el
# reductor NO lee (reason, repoPath, story, sessionId), y un estado con nombre de cliente, que sale «otro».
for i, d in enumerate([ayer, ayer, anteayer, anteayer]):
    g.append({"ts": f"{d}T17:0{i}:00Z", "sessionId": "${M_SESION}", "repoPath": "${M_RUTA}", "name": "mutation",
              "story": "${M_CLIENTE}", "total": 12, "killed": 6 + i, "survived": 6 - i, "verdict": "${M_PROMPT}",
              "status": "warn-survivors", "reason": "${M_MUT} ${M_CORREO} ${M_CMD}"})
g.append({"ts": f"{ayer}T18:00:00Z", "sessionId": "${M_SESION}", "name": "qa-guide", "action": "warn", "status": "presente",
          "esquema": 2, "repoPath": "${M_RUTA}", "story": "${M_QA} ${M_RUTA}"})
g.append({"ts": f"{ayer}T18:01:00Z", "name": "qa-guide", "action": "warn", "status": "${M_CLIENTE}",
          "esquema": 2, "story": "${M_QA} ${M_PROMPT}"})
open(f"{p}/gates.log", "w").write("\n".join(json.dumps(x) for x in g) + "\n")
b = []
for d in [ayer, ayer, ayer, anteayer]:
    b.append({"ts": f"{d}T08:00:00Z", "type": "${M_CMD}", "command": "${M_CMD}", "cwd": "${M_RUTA}", "sessionId": "${M_SESION}"})
b.append({"ts": f"{ayer}T09:00:00Z", "kind": "MUTATION_BYPASS", "reason": "${M_PROMPT}", "repoPath": "${M_RUTA}"})
open(f"{p}/bypass.log", "w").write("\n".join(json.dumps(x) for x in b) + "\n")
# story 2.6 · la constancia de los frenos: se siembran los marcadores en los campos que el
# reductor lee (freno, regla) y en los que NO lee, para que la prueba cubra el registro nuevo.
fr = []
for i, d in enumerate([ayer, ayer, ayer, anteayer]):
    fr.append({"ts": f"{d}T14:0{i}:00Z", "freno": "safety-guard", "regla": "GIT-C1",
               "veredicto": "bloqueo" if i < 3 else "escape", "sha256": "e" * 64,
               "cmd": "${M_CMD}", "cwd": "${M_RUTA}", "sessionId": "${M_SESION}"})
# un freno con NOMBRE DE CLIENTE: tiene que salir «otro», nunca con su nombre
fr.append({"ts": f"{ayer}T15:00:00Z", "freno": "${M_CLIENTE}", "regla": "${M_PROMPT}",
           "veredicto": "bloqueo", "sha256": "d" * 64})
open(f"{p}/frenos.jsonl", "w").write("\n".join(json.dumps(x) for x in fr) + "\n")
# story 2.7 · el carril de cada commit: el reductor lee SÓLO `carril`. La story, la ruta y el
# comando se siembran igual (en campos que no lee), y un carril con nombre de cliente sale «otro».
ca = []
for i, d in enumerate([ayer, ayer, ayer, anteayer]):
    ca.append({"ts": f"{d}T16:0{i}:00Z", "carril": "pipeline", "story": "${M_CLIENTE}",
               "repo": "${M_RUTA}", "cmd": "${M_CMD}", "sessionId": "${M_SESION}"})
ca.append({"ts": f"{ayer}T16:30:00Z", "carril": "${M_CLIENTE}", "story": "${M_PROMPT}"})
open(f"{p}/carriles.jsonl", "w").write("\n".join(json.dumps(x) for x in ca) + "\n")
json.dump({"recentPrompts": ["${M_LANE} ${M_PROMPT}"]}, open(f"{p}/lane/${M_SESION}.json", "w"))
json.dump({"marker": {"sessionId": "${M_SESION}", "repoPath": "${M_TIMING}"}, "archivedAt": f"{ayer}T10:00:00Z"}, open(f"{p}/timing-history/2.5-x.json", "w"))
with gzip.open(f"{p}/timing-history/2.5-x.hilo.jsonl.gz", "wt") as f: f.write(json.dumps({"text": "${M_HILO}"}) + "\n")
cambio = {"version": 1, "estado": "medido", "motivo": None, "medido_en": f"{ayer}T10:00:00Z", "ventana": {"desde": f"{ayer}T09:00:00Z", "hasta": f"{ayer}T10:00:00Z"},
          "repos": [{"nombre": "repo-fuga", "principal": True, "por": ["story"], "otras_sesiones": 0, "estado": "medido", "commits": [],
                     "sin_commitear": [{"ruta": "src/x.cs", "estado": "M", "mas": 1, "menos": 0, "binario": False, "cortado": 0,
                                        "parche": "+${M_GIT} Password=${M_CLAVE_GIT}; ${M_RUTA} ${M_CORREO}"}]}],
          "totales": {"repos": 1, "archivos": 1, "partes": 1, "cortados": 0, "sin_parche_por_tope": 0}}
with gzip.open(f"{p}/timing-history/2.5-x.cambio.json.gz", "wt") as f: f.write(json.dumps(cambio))
open(f"{sys.argv[1]}/../safety-guard.log", "w").write(f"[{ayer} 10:00:00] BLOCK rule=GIT-C1 cwd=${M_RUTA}\n  cmd: ${M_SAFETY} ${M_CMD}\n")
open(f"{sys.argv[1]}/../response-style/log.jsonl", "w").write(json.dumps({"at": f"{ayer}T10:00:00Z", "cwd": "${M_ESTILO}", "over": False}) + "\n")
PY
}

HOME_A="${BASE}/casa-a"; HOME_B="${BASE}/casa-b"
mkdir -p "${HOME_A}" "${HOME_B}"
sembrar "${HOME_A}"; sembrar "${HOME_B}"

# Espía de fs: anota cada ruta que la preparación de la subida y el reductor abren o listan (T5).
cat > "${BASE}/espia.js" <<'JS'
const fs = require('fs');
const log = process.env.SPY_LOG;
const anotar = (p) => { try { fs.appendFileSync(log, String(p) + '\n'); } catch (_) {} };
for (const k of ['openSync', 'readFileSync', 'readdirSync', 'createReadStream', 'statSync', 'existsSync']) {
  const orig = fs[k];
  fs[k] = function (p, ...r) { if (typeof p === 'string' || p instanceof URL) anotar(p); return orig.call(this, p, ...r); };
}
for (const k of ['readFile', 'open', 'readdir']) {
  const orig = fs.promises[k];
  fs.promises[k] = function (p, ...r) { anotar(p); return orig.call(this, p, ...r); };
}
JS

# ── máquina A: sus repos dejan hallazgos, y el recolector REAL los proyecta (story 2.9) ─────────────
REPOS="${BASE}/repos"
mkdir -p "${REPOS}/ClienteSecretoSA/.git" "${REPOS}/grupo/anidado/.git"
# 🔴 Fechas RELATIVAS a hoy: con fechas fijas, en cuatro meses las corridas salen de la ventana del cruce y
#    el control positivo se pone rojo solo (vuelta 2).
dia_hace() { python3 -c "import datetime,sys;print((datetime.date.today()-datetime.timedelta(days=int(sys.argv[1]))).strftime(sys.argv[2]))" "$1" "$2"; }
R1="${REPOS}/ClienteSecretoSA/.advisors/pipeline-runs/9.1-$(dia_hace 6 %Y%m%d)T101010"
R2="${REPOS}/grupo/anidado/.advisors/pipeline-runs/9.2-$(dia_hace 5 %Y%m%d)T101010"
R3="${REPOS}/grupo/anidado/.advisors/pipeline-runs/9.3-$(dia_hace 4 %Y%m%d)T101010"
mkdir -p "${R1}" "${R2}" "${R3}"
python3 - "${R1}" "${R2}" "${R3}" <<PY
import json, sys
r1, r2, r3 = sys.argv[1:4]
# un hallazgo LEGÍTIMO (regla real del catálogo) con toda la prosa y las rutas sembradas → control positivo
json.dump([
  {"rule_id": "SEC-C5", "severity": "CRITICAL", "advisor": "tycon-plugin-security-basics",
   "file": "${M_FILE}", "disposition": "fixed",
   "reason": "${M_PERSONA_NOMBRE} pidió ${M_DECISION}; ruta ${M_RUTA}; ${M_CORREO}; sesión ${M_SESION}"},
  # un identificador con nombre de cliente y forma VÁLIDA: sólo lo frena la lista cerrada (el catálogo)
  {"rule_id": "${M_REGLA_CLIENTE}", "severity": "WARNING", "advisor": "${M_CLIENTE}",
   "file": "${M_FILE}", "disposition": "open", "reason": "${M_PROMPT}"}
], open(f"{r1}/findings.json", "w"))
json.dump([
  {"rule_id": "SEC-C5", "severity": "WARNING", "advisor": "tycon-plugin-security-basics",
   "file": "${M_FILE}", "disposition": "open", "reason": "${M_CMD}"}
], open(f"{r2}/findings.json", "w"))
# el SEGUNDO esquema: un objeto, con prosa en campos que la lista blanca nunca nombró
json.dump({"story": "9.3", "resumen": "${M_RESUMEN}", "los_que_mas_pesan": ["${M_PESAN}"],
           "verificacion": "${M_VERIF}", "criticos_abiertos": 0}, open(f"{r3}/findings.json", "w"))
PY
# el volcado de la corrida 9.1 en el registro de A: el recolector lo empareja con su carpeta y lo nombra
# como corrida leída (vuelta 2 — sin eso no hay denominador). La carpeta lleva la hora LOCAL de la máquina.
python3 - "${HOME_A}/.claude/.tycon-pipeline/timing-history/9.1-a.json" "$(dia_hace 6 %Y-%m-%d)" "${REPOS}/ClienteSecretoSA" <<'PY'
import datetime, json, sys
ruta, fecha, repo = sys.argv[1:4]
inicio = datetime.datetime.strptime(f"{fecha} 10:05:00", "%Y-%m-%d %H:%M:%S").astimezone(datetime.timezone.utc)
fin = inicio + datetime.timedelta(minutes=40)
iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump({"archivedAt": iso(fin),
           "marker": {"storyId": "9.1", "sessionId": "sesion-9-1", "repoPath": repo, "startedAt": iso(inicio), "lastTouch": iso(fin)},
           "revisores": {"estado": "medido", "por_tipo": {"tycon-plugin-security-basics": 3}}}, open(ruta, "w"))
PY
HOME="${HOME_A}" TYCON_REPOS_ROOT="${REPOS}" node "${RAIZ}/scripts/metrics/collect-findings.js" --json > "${BASE}/rec.out" 2> "${BASE}/rec.err"
RC_R=$?
[ "${RC_R}" = "0" ] && [ -s "${HOME_A}/.claude/.tycon-pipeline/hallazgos.jsonl" ] \
  && ok "el recolector real proyectó los hallazgos de la máquina A (2 repos, uno anidado)" \
  || mal "el recolector no dejó la serie (rc=${RC_R}): $(head -c 300 "${BASE}/rec.err")"

# ── máquina A: la preparación REAL de la subida deja sus registros en la carpeta de buzón ──────────
NOMBRE_A="$(TYCON_MACHINE="${M_PERSONA}" node -e 'console.log(require(process.argv[1]).nombreDeMaquina())' "${RAIZ}/scripts/metrics/upload-runs.js")"
mkdir -p "${BASE}/buzon/${NOMBRE_A}"
# el volcado viaja al buzón como lo deja la subida (lleva la ruta del repo con el nombre del cliente: no puede salir)
cp "${HOME_A}/.claude/.tycon-pipeline/timing-history/9.1-a.json" "${BASE}/buzon/${NOMBRE_A}/9.1-a.json"
# story 2.19: el cambio de git también viaja al buzón, al lado de su volcado
cp "${HOME_A}/.claude/.tycon-pipeline/timing-history/2.5-x.cambio.json.gz" "${BASE}/buzon/${NOMBRE_A}/9.1-a.cambio.json.gz"
HOME="${HOME_A}" TYCON_LOGS_DIR="${BASE}/buzon/${NOMBRE_A}/registros" SPY_LOG="${BASE}/prep.espia" NODE_OPTIONS="--require ${BASE}/espia.js" \
  node -e 'const r = require(process.argv[1]).prepararRegistros(); console.log(JSON.stringify(r)); process.exitCode = r.estado === "preparado" ? 0 : 1' "${RAIZ}/scripts/metrics/upload-runs.js" > "${BASE}/prep.out" 2> "${BASE}/prep.err"
RC_P=$?
[ "${RC_P}" = "0" ] && [ -f "${BASE}/buzon/${NOMBRE_A}/registros/gates.log.gz" ] && [ -f "${BASE}/buzon/${NOMBRE_A}/registros/frenos.jsonl.gz" ] && [ -f "${BASE}/buzon/${NOMBRE_A}/registros/carriles.jsonl.gz" ] && [ -f "${BASE}/buzon/${NOMBRE_A}/registros/cobertura.json" ] \
  && ok "la preparación de la subida dejó los registros comprimidos y la cobertura de la máquina A" || mal "la preparación no dejó los registros (rc=${RC_P}): $(head -c 300 "${BASE}/prep.err") $(head -c 300 "${BASE}/prep.out")"
if grep -E '/lane(/|$)|/timing-history(/|$)|safety-guard\.log|/response-style(/|$)' "${BASE}/prep.espia" >/dev/null 2>&1; then
  mal "la preparación de la subida abrió algo más que los dos registros: $(grep -E '/lane|/timing-history|safety-guard|/response-style' "${BASE}/prep.espia" | head -2 | tr '\n' ' ')"
else ok "la preparación de la subida sólo lee los cuatro registros (ni lane/, ni timing-history/, ni safety-guard.log)"; fi

# ── máquina B: el reductor cuenta sus registros locales y los bajados ──────────────────────────────
HOME="${HOME_B}" TYCON_MACHINE="maquina-b-9931" TYCON_MAILBOX_DIR="${BASE}/buzon" SPY_LOG="${BASE}/b.espia" NODE_OPTIONS="--require ${BASE}/espia.js" \
  node "${REDUCTOR}" --json > "${BASE}/b.out" 2> "${BASE}/b.err"
RC_B=$?
[ "${RC_B}" = "0" ] && ok "el reductor contó (exit 0)" || mal "el reductor no contó: rc=${RC_B} — $(head -c 300 "${BASE}/b.err")"

HOME="${HOME_B}" TYCON_MACHINE="maquina-b-9931" SPY_LOG="${BASE}/t.espia" NODE_OPTIONS="--require ${BASE}/espia.js" \
  node "${TABLERO}" --mailbox "${BASE}/buzon" --output "${BASE}/pagina.html" --json > "${BASE}/tablero.out" 2> "${BASE}/tablero.err"
RC_T=$?
[ -f "${BASE}/pagina.html" ] && ok "el tablero generó la página (exit ${RC_T})" || mal "el tablero no generó la página (exit ${RC_T}): $(head -c 300 "${BASE}/tablero.err")"

# ── T4 · ningún marcador sale ─────────────────────────────────────────────────────────────────────
SALIDAS="${BASE}/b.out ${BASE}/b.err ${BASE}/pagina.html ${BASE}/tablero.out ${BASE}/prep.out ${BASE}/prep.err ${BASE}/rec.out ${BASE}/rec.err ${HOME_A}/.claude/.tycon-pipeline/hallazgos.jsonl"
FUGA=0
for M in "${M_CORREO}" "${M_RUTA}" "/Users/fulano" "${M_CLIENTE}" "${M_CMD}" "FUGA-CMD-5521" "PROMPT-FUGA-7731" "${M_SESION}" \
         "${M_PERSONA}" "devbs-macbook-pro" "maquina-b-9931" "${M_LANE}" "${M_HILO}" "${M_TIMING}" "${M_SAFETY}" "${M_ESTILO}" "${HOME_A}" "${HOME_B}" \
         "${M_PERSONA_NOMBRE}" "DECISION-DEV-FUGA-2291" "arreglarlo ahora" "${M_FILE}" "SecretoSA" "${M_REGLA_CLIENTE}" \
         "RESUMEN-FUGA-6610" "${M_PESAN}" "${M_VERIF}" "${REPOS}" "${M_MUT}" "${M_QA}" "${M_COLA}" "${M_GIT}" "${M_CLAVE_GIT}"; do
  for f in ${SALIDAS}; do
    if grep -qiF -- "${M}" "${f}" 2>/dev/null; then mal "T4 fuga: «${M}» aparece en ${f#${BASE}/}"; FUGA=1; fi
  done
done
[ "${FUGA}" -eq 0 ] && ok "T4 ni correo, ni ruta, ni cliente, ni comando, ni prompt, ni sesión, ni nombre de máquina en la salida del reductor ni en la página"

# ── control positivo: lo sembrado LLEGÓ, sumado, como «otro» ─────────────────────────────────────
python3 - "${BASE}/tablero.out" <<'PY'
import json, sys
t = open(sys.argv[1]).read()
i = t.find('\n{')
d, _ = json.JSONDecoder().raw_decode(t[i+1:] if i >= 0 else t)
L = d['paneles']['local'] if 'paneles' in d else d['local']
b, e = L.get('bloqueos') or {}, L.get('escapes') or {}
assert b.get('estado') == 'medido' and b.get('valor') == 10, ('bloqueos', b)
assert e.get('estado') == 'medido' and e.get('valor') == 10, ('escapes', e)
PY
[ $? -eq 0 ] && ok "control positivo: la página cuenta 10 bloqueos (8 del control con nombre de cliente + 2 rojos con cola) y 10 escapes de las dos máquinas" || mal "control positivo: lo sembrado no llegó a la página con su número — $(python3 -c "import sys;t=open(sys.argv[1]).read();print(t[:400])" "${BASE}/tablero.out")"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); m=d['metricas']; assert m['bloqueos']['porDim']['otro']['num']==8 and m['escapes']['porDim']['otro']['num']==8, m" "${BASE}/b.out" 2>/dev/null \
  && ok "el control con nombre de cliente y el tipo con un comando se contaron como «otro»" || mal "no se contaron como «otro»: $(head -c 400 "${BASE}/b.out")"
# 2026-09-17 · control positivo de la cola: el rojo con `cola` SE LEYÓ (cuenta como bloqueo de «tests»);
# sin esto, un reductor que saltea la línea entera pasaría la fuga sin haber mirado el campo nuevo.
python3 -c "import json,sys; m=json.load(open(sys.argv[1]))['metricas']; assert m['bloqueos']['porDim']['tests']['num']==2, m['bloqueos']['porDim']" "${BASE}/b.out" 2>/dev/null \
  && ok "control positivo (cola): los 2 rojos con la cola de su salida se contaron como bloqueos de «tests», sin publicar la cola" || mal "control positivo (cola): el rojo con cola no se contó: $(head -c 400 "${BASE}/b.out")"
# story 2.7 · control positivo del registro nuevo: sin esto, un carril que no llega se leería como «no fugó»
python3 -c "import json,sys; c=json.load(open(sys.argv[1]))['metricas']['carriles']['porDim']; assert c['pipeline']['num']==8 and c['otro']['num']==2, c" "${BASE}/b.out" 2>/dev/null \
  && ok "control positivo (2.7): los carriles sembrados llegaron — 8 «pipeline» y el carril con nombre de cliente como «otro»" || mal "control positivo (2.7): los carriles no llegaron: $(head -c 400 "${BASE}/b.out")"
# story 2.8 · control positivo: la mutación y la guía LLEGARON — sin esto, una métrica que no cuenta nada pasaría la fuga
python3 -c "import json,sys; m=json.load(open(sys.argv[1]))['metricas']; assert len(m['mutacion_puntaje']['muestras'])==8 and m['qa_guia_estados']['porDim']['otro']['num']==2 and m['qa_guia_estados']['porDim']['presente']['num']==2, m.get('mutacion_puntaje')" "${BASE}/b.out" 2>/dev/null \
  && ok "control positivo (2.8): 8 puntajes de mutación de las dos máquinas, 2 guías presentes y el estado con nombre de cliente como «otro»" || mal "control positivo (2.8): la mutación o la guía no llegaron: $(head -c 400 "${BASE}/b.out")"

# ── T5 · el reductor no abre lo que no debe ───────────────────────────────────────────────────────
PROHIBIDO=0
for f in "${BASE}/b.espia"; do
  [ -s "${f}" ] || { mal "T5 el espía no anotó nada (${f#${BASE}/}): no se puede afirmar qué abrió"; PROHIBIDO=1; continue; }
  if grep -E '/lane(/|$)|/timing-history(/|$)|safety-guard\.log|/response-style(/|$)|/blocking-meter(/|$)|/advisor-runs(/|$)' "${f}" >/dev/null; then
    mal "T5 el reductor abrió o listó: $(grep -E '/lane|/timing-history|safety-guard|/response-style|/blocking-meter|/advisor-runs' "${f}" | head -3 | tr '\n' ' ')"; PROHIBIDO=1
  fi
done
[ "${PROHIBIDO}" -eq 0 ] && ok "T5 el reductor no abre lane/, timing-history/, safety-guard.log, response-style/ ni advisor-runs/"

# ── story 2.9 · control positivo: los hallazgos LLEGARON al cruce, con su número ───────────────────
python3 - "${BASE}/tablero.out" <<'PY'
import json, sys
t = open(sys.argv[1]).read()
i = t.find('\n{')
d, _ = json.JSONDecoder().raw_decode(t[i+1:] if i >= 0 else t)
P = d['poda']
assert P.get('estado') == 'medido', ('poda', P.get('estado'), P.get('motivo'))
fila = [f for f in P['filas'] if f['regla'] == 'SEC-C5' and f['dueno'] == 'tycon-plugin-security-basics']
assert len(fila) == 1 and fila[0]['hallazgos'] == 2, ('SEC-C5', fila)
assert not [f for f in P['filas'] if 'CLIENTESECRETOSA' in f['regla']], 'la regla con nombre de cliente llegó a la tabla'
PY
[ $? -eq 0 ] && ok "control positivo 2.9: los 2 hallazgos de SEC-C5 (de dos repos, uno anidado) llegaron al cruce" \
  || mal "control positivo 2.9: los hallazgos no llegaron al cruce con su número — $(python3 -c "import sys;t=open(sys.argv[1]).read();i=t.find('\"poda\"');print(t[i:i+300])" "${BASE}/tablero.out")"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['fuera_de_catalogo']==1 and d['otro_esquema']==1, d" "${BASE}/rec.out" 2>/dev/null \
  && ok "el recolector contó 1 fuera de catálogo y 1 de otro esquema, sin nombrarlos" \
  || mal "el recolector no contó lo descartado: $(head -c 300 "${BASE}/rec.out")"

# ── story 2.9 · T22 · ni el reductor NI el cruce abren los findings.json originales ───────────────
for f in "${BASE}/b.espia" "${BASE}/t.espia"; do
  if [ ! -s "${f}" ]; then mal "T22 el espía no anotó nada (${f#${BASE}/}): no se puede afirmar qué abrió"; continue; fi
  if grep -F "${REPOS}" "${f}" >/dev/null; then
    mal "T22 ${f#${BASE}/} abrió algo de los repos: $(grep -F "${REPOS}" "${f}" | head -2 | tr '\n' ' ') — rojo previo: leer findings.json directo saltea la proyección de cinco claves"
  else
    ok "T22 ${f#${BASE}/}: no abre nada de los repos (lee sólo lo que el recolector preparó)"
  fi
done

# ── story 2.19 · T17 · el cambio de git: nadie más que la vista de corridas lo abre, y ahí la clave sale tapada ──
# 🔴 rojo previo: sin el caso, el tablero o la poda podrían empezar a leer el .cambio.json.gz (código de cliente)
#    y publicarlo para todo el equipo sin que nada lo marque. Mutación: que el reductor liste y lea los
#    *.gz del buzón → el espía lo ve.
ABRIO_CAMBIO=0
for f in "${BASE}/b.espia" "${BASE}/t.espia"; do
  if [ -s "${f}" ] && grep -F '.cambio.json.gz' "${f}" >/dev/null; then mal "T17 ${f#${BASE}/} abrió un .cambio.json.gz: $(grep -F '.cambio.json.gz' "${f}" | head -2 | tr '\n' ' ')"; ABRIO_CAMBIO=1; fi
done
[ "${ABRIO_CAMBIO}" -eq 0 ] && ok "T17 ni el reductor ni el tablero (con la poda adentro) abren un .cambio.json.gz"
HOME="${HOME_B}" TYCON_MACHINE="maquina-b-9931" node "${TABLERO}" --view runs --mailbox "${BASE}/buzon" --output "${BASE}/corridas.html" > "${BASE}/corridas.out" 2> "${BASE}/corridas.err"
RC_C=$?
R_GIT="$(python3 - "${BASE}/corridas.html" "${M_GIT}" "${M_CLAVE_GIT}" <<'PYC'
import base64, gzip, re, sys
h = open(sys.argv[1], encoding='utf8').read()
txt = ''.join(gzip.decompress(base64.b64decode(x)).decode() for x in re.findall(r'<script type="text/plain" id="cg-\d+">([^<]*)</script>', h))
print('|'.join(['leido' if sys.argv[2] in txt else 'NO-LEIDO', 'clave-tapada' if sys.argv[3] not in txt and sys.argv[3] not in h else 'CLAVE-VISIBLE']))
PYC
)"
[ "${RC_C}" = "0" ] && [ "${R_GIT}" = "leido|clave-tapada" ] \
  && ok "T17 la vista de corridas sí lo lee (control positivo: el parche sembrado llegó) y la clave sale tapada" \
  || mal "T17 vista de corridas (rc=${RC_C}): ${R_GIT} — $(head -c 200 "${BASE}/corridas.err")"
for m in "${M_CLAVE_GIT}"; do grep -F "${m}" "${BASE}/corridas.out" "${BASE}/corridas.err" >/dev/null && mal "T17 «${m}» salió por la pantalla de la vista"; done

# ── story 7.1 · el latido de la retrospectiva no saca nada del volcado ni de los hallazgos ──────────
# El archivo que escribe `retro-heartbeat.js` viaja por git (.dashboard/ del arnés). El volcado de la
# corrida trae rutas absolutas (filesSnapshot), el prompt del dev y mensajes de error; el findings.json
# trae prosa y rutas. Se siembran los marcadores de arriba en los dos y se exige que el archivo no
# contenga ninguno — y, como control positivo, que sí traiga las vueltas del volcado sembrado.
LATIDO="${RAIZ}/scripts/metrics/retro-heartbeat.js"
if [ ! -f "${LATIDO}" ]; then
  mal "7.1 no existe ${LATIDO} (rojo previo: el latido todavía no está)"
else
  L_HOME="${BASE}/latido-home"; L_REPO="${BASE}/latido-repo"; L_OUT="${BASE}/latido-out"
  mkdir -p "${L_HOME}/.claude/.tycon-pipeline/timing-history" "${L_REPO}/specs" "${L_OUT}"
  ( cd "${L_REPO}" && git init -q -b main && echo "story: \"7.7\"" > specs/story-7.7.md && git add -A \
    && git -c user.email=f@f -c user.name=f commit -q -m "feat: 7.7" )
  L_SHA="$(git -C "${L_REPO}" rev-parse HEAD)"
  L_REAL="$(cd "${L_REPO}" && pwd -P)"
  mkdir -p "${L_REPO}/.advisors/pipeline-runs/7.7-20260916-1000"
  printf '[{"rule_id":"SEC-C1","reason":"%s %s","file":"%s","resumen":"%s"}]\n' "${M_PROMPT}" "${M_CORREO}" "${M_FILE}" "${M_RESUMEN}" \
    > "${L_REPO}/.advisors/pipeline-runs/7.7-20260916-1000/findings.json"
  F="${L_HOME}/.claude/.tycon-pipeline/timing-history/7.7-2026-09-16T1000.json" R="${L_REAL}" C="${M_CORREO}" RU="${M_RUTA}" \
    P="${M_PROMPT}" CL="${M_CLIENTE}" S="${M_SESION}" node -e '
    const e = process.env;
    const d = { archivedAt: "2026-09-16T10:00:00.000Z", sessionId: e.S,
      marker: { storyId: "7.7", repoPath: e.R, storyPath: "specs/story-7.7.md", sessionId: e.S, planApproval: { text: e.P },
        filesTouched: [e.RU], iterations: { "1": { ts: "2026-09-16T09:00:00Z", filesSnapshot: [e.RU, e.C] }, "2": { ts: "2026-09-16T09:40:00Z", filesSnapshot: [e.CL] } } },
      gates: [{ check: "tests", sessionId: e.S, mensaje: e.C + " " + e.RU }], consumo: { estado: "medido", motivo: e.P },
      revisores: { estado: "medido", por_vuelta: { "0": 1, "1": 3, "2": 2 }, motivo: e.C } };
    require("fs").writeFileSync(e.F, JSON.stringify(d));'
  HOME="${L_HOME}" TYCON_TODAY="2026-09-16" node "${LATIDO}" --repo "${L_REPO}" --merge "${L_SHA}" --story 7.7 --out "${L_OUT}" > "${BASE}/latido.out" 2> "${BASE}/latido.err"
  RC_L=$?
  L_FILE="${L_OUT}/metrics-2026-09-16-latido-repo-7.7-${L_SHA:0:7}.json"
  if [ "${RC_L}" != "0" ] || [ ! -f "${L_FILE}" ]; then
    mal "7.1 el latido no escribió (rc=${RC_L}): $(head -c 300 "${BASE}/latido.err")"
  else
    L_FUGA=0
    for m in "${M_CORREO}" "${M_RUTA}" "${M_CLIENTE}" "PROMPT-FUGA-7731" "${M_SESION}" "${M_FILE}" "RESUMEN-FUGA-6610"; do
      grep -F "${m}" "${L_FILE}" >/dev/null && { mal "7.1 «${m}» apareció en el archivo del latido — rojo previo: copiar filesSnapshot, gates o el findings.json"; L_FUGA=1; }
    done
    grep -q '"value": 2' "${L_FILE}" || { mal "7.1 control positivo: el latido no trae las 2 vueltas del volcado sembrado"; L_FUGA=1; }
    [ "${L_FUGA}" -eq 0 ] && ok "7.1 el latido no saca correo, ruta, cliente, prompt ni sesión del volcado ni del findings.json (y sí sus 2 vueltas)"
  fi
fi

echo
[ "${FALLOS}" -eq 0 ] && { echo "todo verde"; exit 0; }
echo "${FALLOS} fallo(s)"; exit 1
