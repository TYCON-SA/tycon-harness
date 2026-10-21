#!/usr/bin/env bash
# 🔴 AISLAMIENTO PRIMERO: HOME falso ANTES de cualquier otra línea que ejecute algo. Sin esto, una suite
#    corrida contra un guion que todavía no la contempla leería la configuración REAL de la máquina y
#    empujaría datos de prueba al buzón de verdad. Acá nada puede encontrar un registro real.
HOME="$(mktemp -d)"; export HOME
#
# telemetry-leak.test.sh — LA PRUEBA DE FUGA DEL REDUCTOR.
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
# Lo que esta prueba atrapa: publicar el valor crudo de la dimensión en vez de «otro» (aparecen el nombre de
# cliente y el comando), o leer timing-history/ (el espía lo ve).
#
# 🔴 La prueba cubre también los HALLAZGOS de los revisores. Se siembran, en `findings.json` de repos
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
# los hallazgos de los revisores
M_PERSONA_NOMBRE="Devito-FugaPersona"
M_DECISION="DECISION-DEV-FUGA-2291 arreglarlo ahora"
M_FILE="/Users/fulano/Clientes/SecretoSA/src/Clave.cs"
M_REGLA_CLIENTE="CLIENTESECRETOSA-C1"
# 🔴 Sólo se buscan marcadores ÚNICOS. Buscar también «contraseña» y «Llavero» daría
#    fuga en falso: el tablero ya publica, sin nada sembrado, una nota del propio arnés que usa esas dos
#    palabras. Un marcador que aparece solo no prueba nada; por eso el resumen lleva su token propio.
M_RESUMEN="RESUMEN-FUGA-6610 la contraseña de producción del Llavero"
M_PESAN="PESAN-FUGA-6611"
M_VERIF="VERIF-FUGA-6612"
# la mutación y la guía de QA
M_MUT="MUT-FUGA-3301"
M_QA="QA-FUGA-3302"
# la COLA de la salida que `marker.js run-check` guarda al dar rojo. gates.log viaja al
# buzón; el reductor no debe leer ese campo (lista blanca). Se siembra con correo, ruta del home y cliente.
M_COLA="COLA-FUGA-8801"
# el cambio de git de cada corrida (`<volcado>.cambio.json.gz`): trae código de cliente. Sólo lo
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

# ── máquina A: sus repos dejan hallazgos, y el recolector REAL los proyecta ─────────────
REPOS="${BASE}/repos"
mkdir -p "${REPOS}/ClienteSecretoSA/.git" "${REPOS}/grupo/anidado/.git"
# 🔴 Fechas RELATIVAS a hoy: con fechas fijas, en cuatro meses las corridas salen de la ventana del cruce y
#    el control positivo se pone rojo solo.
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
# el volcado de una corrida en el registro de A: el recolector lo empareja con su carpeta y lo nombra
# como corrida leída (sin eso no hay denominador). La carpeta lleva la hora LOCAL de la máquina.
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
# el cambio de git también viaja al buzón, al lado de su volcado
cp "${HOME_A}/.claude/.tycon-pipeline/timing-history/2.5-x.cambio.json.gz" "${BASE}/buzon/${NOMBRE_A}/9.1-a.cambio.json.gz"
HOME="${HOME_A}" TYCON_LOGS_DIR="${BASE}/buzon/${NOMBRE_A}/registros" SPY_LOG="${BASE}/prep.espia" NODE_OPTIONS="--require ${BASE}/espia.js" \
  node -e 'const r = require(process.argv[1]).prepararRegistros(); console.log(JSON.stringify(r)); process.exitCode = r.estado === "preparado" ? 0 : 1' "${RAIZ}/scripts/metrics/upload-runs.js" > "${BASE}/prep.out" 2> "${BASE}/prep.err"
RC_P=$?
[ "${RC_P}" = "0" ] && [ -f "${BASE}/buzon/${NOMBRE_A}/registros/gates.log.gz" ] && [ -f "${BASE}/buzon/${NOMBRE_A}/registros/frenos.jsonl.gz" ] && [ -f "${BASE}/buzon/${NOMBRE_A}/registros/carriles.jsonl.gz" ] && [ -f "${BASE}/buzon/${NOMBRE_A}/registros/cobertura.json" ] \
  && ok "la preparación de la subida dejó los registros comprimidos y la cobertura de la máquina A" || mal "la preparación no dejó los registros (rc=${RC_P}): $(head -c 300 "${BASE}/prep.err") $(head -c 300 "${BASE}/prep.out")"
if grep -E '/lane(/|$)|/timing-history(/|$)|safety-guard\.log|/response-style(/|$)' "${BASE}/prep.espia" >/dev/null 2>&1; then
  mal "la preparación de la subida abrió algo más que los dos registros: $(grep -E '/lane|/timing-history|safety-guard|/response-style' "${BASE}/prep.espia" | head -2 | tr '\n' ' ')"
else ok "la preparación de la subida sólo lee los cuatro registros (ni lane/, ni timing-history/, ni safety-guard.log)"; fi
# T20: el place.json de la máquina A en el espejo trae el correo de git de su dev (un marcador). Lo leen
# sólo quienes mantienen; la página del equipo no. Y una carpeta vieja unida, para que el reductor y la poda lean la unión.
M_OWNER="ZQX-FUGA-CORREO@ejemplo.test"
printf '{"schema":1,"day":"2026-10-15","owner":{"email":"%s","source":"git-global"},"folder":{"name":"%s","source":"TYCON_MACHINE"}}\n' "${M_OWNER}" "${NOMBRE_A}" > "${BASE}/buzon/${NOMBRE_A}/registros/place.json"
printf '{"schema":1,"carpetas":{},"regeneradas":{}}\n' > "${BASE}/buzon/.carpetas-de-maquina.json"

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
# control positivo de la cola: el rojo con `cola` SE LEYÓ (cuenta como bloqueo de «tests»);
# sin esto, un reductor que saltea la línea entera pasaría la fuga sin haber mirado el campo nuevo.
python3 -c "import json,sys; m=json.load(open(sys.argv[1]))['metricas']; assert m['bloqueos']['porDim']['tests']['num']==2, m['bloqueos']['porDim']" "${BASE}/b.out" 2>/dev/null \
  && ok "control positivo (cola): los 2 rojos con la cola de su salida se contaron como bloqueos de «tests», sin publicar la cola" || mal "control positivo (cola): el rojo con cola no se contó: $(head -c 400 "${BASE}/b.out")"
# control positivo del registro de carriles: sin esto, un carril que no llega se leería como «no fugó»
python3 -c "import json,sys; c=json.load(open(sys.argv[1]))['metricas']['carriles']['porDim']; assert c['pipeline']['num']==8 and c['otro']['num']==2, c" "${BASE}/b.out" 2>/dev/null \
  && ok "control positivo (2.7): los carriles sembrados llegaron — 8 «pipeline» y el carril con nombre de cliente como «otro»" || mal "control positivo (2.7): los carriles no llegaron: $(head -c 400 "${BASE}/b.out")"
# control positivo: la mutación y la guía LLEGARON — sin esto, una métrica que no cuenta nada pasaría la fuga
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

# ── control positivo: los hallazgos LLEGARON al cruce, con su número ───────────────────
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

# ── T22 · ni el reductor NI el cruce abren los findings.json originales ───────────────
for f in "${BASE}/b.espia" "${BASE}/t.espia"; do
  if [ ! -s "${f}" ]; then mal "T22 el espía no anotó nada (${f#${BASE}/}): no se puede afirmar qué abrió"; continue; fi
  if grep -F "${REPOS}" "${f}" >/dev/null; then
    mal "T22 ${f#${BASE}/} abrió algo de los repos: $(grep -F "${REPOS}" "${f}" | head -2 | tr '\n' ' ') — rojo previo: leer findings.json directo saltea la proyección de cinco claves"
  else
    ok "T22 ${f#${BASE}/}: no abre nada de los repos (lee sólo lo que el recolector preparó)"
  fi
done

# ── T17 · el cambio de git: nadie más que la vista de corridas lo abre, y ahí la clave sale tapada ──
# 🔴 Sin el caso, el tablero o la poda podrían empezar a leer el .cambio.json.gz (código de cliente)
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
  && ok "T17 la vista de ejecuciones sí lo lee (control positivo: el parche sembrado llegó) y la clave sale tapada" \
  || mal "T17 vista de ejecuciones (rc=${RC_C}): ${R_GIT} — $(head -c 200 "${BASE}/corridas.err")"
for m in "${M_CLAVE_GIT}"; do grep -F "${m}" "${BASE}/corridas.out" "${BASE}/corridas.err" >/dev/null && mal "T17 «${m}» salió por la pantalla de la vista"; done

# ── el latido de la retrospectiva no saca nada del volcado ni de los hallazgos ──────────
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

# ── T20 · ElCorreoDePlaceNoLlegaALaPaginaDelEquipo ── 🔴 Atrapa un reductor que lo lee.
FUGA=0
for f in ${SALIDAS}; do
  if grep -qiF -- "${M_OWNER}" "${f}" 2>/dev/null; then mal "2.28-T20 el correo de place.json aparece en ${f#${BASE}/}"; FUGA=1; fi
done
[ "${FUGA}" -eq 0 ] && ok "2.28-T20 el correo de git de place.json no llega a la página del equipo ni a la salida del reductor"
if grep -F 'place.json' "${BASE}/b.espia" "${BASE}/t.espia" > /dev/null 2>&1; then
  mal "2.28-T20 el reductor o la poda abrieron place.json: $(grep -hF 'place.json' "${BASE}/b.espia" "${BASE}/t.espia" | head -2 | tr '\n' ' ')"
else ok "2.28-T20 ni el reductor ni la poda (ni el tablero) abren place.json"; fi
# control positivo: el marcador está en el espejo, y quien lo lee a propósito (people.js) lo ve — la prueba no es vacía
node -e 'const r = require(process.argv[1]).leerCorreosInformados(process.argv[2]); process.exit(Object.values(r.maquinas).some((m) => m.correo === process.argv[3].toLowerCase()) ? 0 : 1)' \
  "${RAIZ}/scripts/lib/people.js" "${BASE}/buzon" "${M_OWNER}" \
  && ok "2.28-T20 control positivo: el correo está en el espejo y people.js lo lee" || mal "2.28-T20 el marcador no llegó al espejo: la prueba sería vacía"
# ── T20 · Fuga_VolcadosYDuracionDelBuzon @story-2.21 @ac-14 ─────────────────────────────────────────
# El nocturno lee del buzón los VOLCADOS de las corridas (duración, agentes, vueltas, trabajo y espera) y la
# duración de la suite de las líneas `tests` de gates.log. Un volcado trae la story, la ruta del repo y comandos; una
# línea `tests`, el comando y la ruta. Se siembran marcadores ahí y se corre la página en modo nocturno en la máquina B.
# 🔴 Atrapa: publicar `marker.storyId` o `repoPath` en el detalle; o leer `timing-history/` del disco del agente.
# 🔴 CONTROL POSITIVO: la mediana de la corrida, los agentes, las vueltas y la duración de la suite llegan con su número.
python3 - "${BASE}/buzon/${NOMBRE_A}/${M_CLIENTE}-x.json" "${AYER}" <<PY
import json, sys
p, ayer = sys.argv[1], sys.argv[2]
json.dump({"archivedAt": f"{ayer}T12:00:00Z",
           "marker": {"storyId": "${M_CLIENTE}", "repoPath": "${M_RUTA}", "sessionId": "${M_SESION}", "startedAt": f"{ayer}T10:00:00Z",
                      "lastTouch": f"{ayer}T12:00:00Z", "planApproval": {"text": "${M_PROMPT}"},
                      "stepTimings": {"1": {"startedAt": f"{ayer}T10:00:00Z", "completedAt": f"{ayer}T11:00:00Z"}}},
           "gates": [{"check": "tests", "cmd": "${M_CMD}"}], "costo": {"spawns": 7, "iteraciones": 3}}, open(p, "w"))
PY
echo '{"codigo":0,"estado":"al_dia","sin_tiempo":0,"completo":true,"bajados":1,"al_dia":0,"omitidos":0}' > "${BASE}/bajada-ok.json"
: > "${BASE}/n.espia"
HOME="${HOME_B}" TYCON_MACHINE="maquina-b-9931" SPY_LOG="${BASE}/n.espia" NODE_OPTIONS="--require ${BASE}/espia.js" \
  node "${TABLERO}" --nightly --mailbox "${BASE}/buzon" --mailbox-state "${BASE}/bajada-ok.json" --output "${BASE}/pagina-n.html" --json > "${BASE}/tablero-n.out" 2> "${BASE}/tablero-n.err"
[ -f "${BASE}/pagina-n.html" ] && ok "2.21-T20 el nocturno generó la página con el buzón de las dos máquinas" || mal "2.21-T20 el nocturno no generó la página: $(head -c 300 "${BASE}/tablero-n.err")"
FUGA=0
for M in "${M_CORREO}" "${M_RUTA}" "/Users/fulano" "${M_CLIENTE}" "${M_CMD}" "FUGA-CMD-5521" "PROMPT-FUGA-7731" "${M_SESION}" \
         "${M_PERSONA}" "devbs-macbook-pro" "maquina-b-9931" "${M_TIMING}" "${M_HILO}" "${HOME_A}" "${HOME_B}"; do
  for f in "${BASE}/pagina-n.html" "${BASE}/tablero-n.out" "${BASE}/tablero-n.err"; do
    if grep -qiF -- "${M}" "${f}" 2>/dev/null; then mal "2.21-T20 fuga: «${M}» aparece en ${f#${BASE}/}"; FUGA=1; fi
  done
done
[ "${FUGA}" -eq 0 ] && ok "2.21-T20 ni la story, ni la ruta, ni el comando, ni el prompt, ni la sesión de un volcado o de una línea tests salen en la página del nocturno"
grep -E '/timing-history(/|$)' "${BASE}/n.espia" >/dev/null && mal "2.21-T20 el nocturno leyó timing-history/ del disco: $(grep -E '/timing-history' "${BASE}/n.espia" | head -2 | tr '\n' ' ')" \
  || ok "2.21-T20 el nocturno no lee timing-history/ del disco: las ejecuciones salen sólo del buzón"
python3 - "${BASE}/tablero-n.out" <<'PY' && ok "2.21-T20 control positivo: ejecución (mediana de 40 min y 2 h), 7 agentes, 3 vueltas y la duración de la suite (1 s, 4 muestras) llegan con su número" || mal "2.21-T20 control positivo: $(python3 -c "import sys;t=open(sys.argv[1]).read();i=t.find(chr(10)+'{');print(t[i:i+600])" "${BASE}/tablero-n.out")"
import json, sys
t = open(sys.argv[1]).read(); i = t.find('\n{')
d, _ = json.JSONDecoder().raw_decode(t[i+1:] if i >= 0 else t)
L = d['local']
c, a, v, g = L['corridas'], L['agentes'], L['vueltas'], L['gates_dur']
assert c['estado'] == 'medido' and abs(c['valor'] - (40 / 60 + 2) / 2) < 1e-6 and c['medidos'] == 2, ('corridas', c)
assert a['estado'] == 'medido' and a['valor'] == 7, ('agentes', a)
assert v['estado'] == 'medido' and v['valor'] == 3, ('vueltas', v)
assert g['estado'] == 'medido' and g['valor'] == 1 and g['medidos'] == 4, ('gates_dur', g)
PY

# ── T25 · Fuga_AvisoDeLaManana ───────────────────────────────────────────────────────────────────────────
# El aviso de la mañana sale a un servicio de afuera (Telegram, Slack, Teams): lleva sólo cantidades y el enlace. Se
# siembran marcadores en TODAS sus fuentes —un paquete y un repo en la foto de dependencias, un repo en un no medido,
# un proyecto sin dueño único, un correo asignado, un id de ficha con el paquete, un motivo de texto libre, un
# producto, un host y un diagnóstico del vigilante, un título y un autor de PR, la organización en el error de az— y
# una dirección de webhook con forma real. Se corre la cadena real (open-prs.js → daily-summary.js de dependencias y
# del vigilante → notify.js por Slack contra un servidor local, y el aviso del vigilante por hallazgo) y FALLA si un
# marcador llega a un cuerpo mandado, o la dirección del webhook a la salida o a la constancia.
A="${BASE}/aviso"; mkdir -p "${A}/deps/out" "${A}/deps/pend/pending" "${A}/deps/pend/promoted" "${A}/deps/pend/archived" "${A}/vig/out" "${A}/vig/pend/pending" "${A}/vig/pend/promoted" "${A}/vig/pend/archived" "${A}/fixaz"
HOY_A=2026-09-20
SUMMARY="${RAIZ}/scripts/nightly/dependencies/daily-summary.js"
: > "${A}/cuerpos.jsonl"
node -e '
const http = require("http"), fs = require("fs");
const [log, puertoF] = process.argv.slice(1);
const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)).on("end", () => {
  fs.appendFileSync(log, JSON.stringify({ ruta: req.url, cuerpo: b }) + "\n"); res.statusCode = 200; res.end("ok"); }); });
srv.listen(0, "127.0.0.1", () => fs.writeFileSync(puertoF, String(srv.address().port)));' "${A}/cuerpos.jsonl" "${A}/puerto" &
SRV_AVISO=$!
for _ in $(seq 1 100); do [ -s "${A}/puerto" ] && break; sleep 0.05; done
WEBHOOK="http://127.0.0.1:$(cat "${A}/puerto")/services/T0MARCAWH/B0MARCAWH/marcadorwebhookxyz123"
printf '{ "version": 1, "owners": { "default": "lead@acme.example" }, "notify": { "channel": "slack" } }\n' > "${A}/operations.json"
printf '{ "repos": [ { "producto": "ProductoFugaDeps", "ruta": "RepoFuga/Marca", "tipo": "npm", "activo": true, "ado": "ProyectoFugaA/RepoFuga" } ] }\n' > "${A}/repos.json"
echo '{ "rubros_sin_fuente": {} }' > "${A}/summary.json"
printf 'id: fugaaa11\ndetectado: %s\nveredicto: pendiente\npaquete: paquete-fuga-marca\nseveridad: high\nnoches: 1\nrepos:\n  - RepoFuga/Marca\navisos:\n  - https://x/GHSA-fuga\n' "${HOY_A}" > "${A}/deps/pend/pending/fugaaa11.yaml"
node -e '
const [arch, hoy] = process.argv.slice(1);
require("fs").writeFileSync(arch, JSON.stringify({ fecha: hoy, corrida_completa: true, linea_base: false, comparado_contra: null, repos_activos: 1, repos_apagados: 0, repos: [],
  no_medidos: [{ ruta: "RepoNoMedidoFuga/X", motivo: "MotivoLibreFuga: el restore falló en RepoNoMedidoFuga" }, { ruta: "Otro/Y", motivo: "x" }],
  hallazgos: [{ id: "fugaaa11", paquete: "paquete-fuga-marca", severidad: "high", repos: ["RepoFuga/Marca"], noches: 1 }], presencias: [], anunciados_hoy: ["fugaaa11"],
  postergados_por_presupuesto: [], anexados: [], reaparecidos_ids: [], presupuesto: { tope: 2 }, resueltos_ids: [], descartados_ids: [], aceptadas_sin_resolver: [],
  rechazadas_sin_deuda_ids: [], ignorados_ids: [],
  pedidos: { simulado: false, creados: [{ ficha: "fugaaa11", proyecto: "ProyectoFugaA", id: 7788, asignado_a: "persona.fuga@cliente-secreto.example" }], adoptados: [],
    fallidos: [], postergados: [], sin_iteracion: [], sin_dueno_unico: [{ proyecto: "ProyectoSinDuenoFuga", motivo: "dos dueños" }], deuda_avisada: [] } }, null, 2));' "${A}/deps/out/dependencias-${HOY_A}.json" "${HOY_A}"
# los PR: az falla y nombra la organización en su error
printf '#!/usr/bin/env bash\necho "ERROR: TF400813: la organización OrgFugaMarca rechazó el pedido" >&2\nexit 1\n' > "${A}/az-que-nombra"; chmod +x "${A}/az-que-nombra"
TYCON_ADO_CMD="${A}/az-que-nombra" node "${RAIZ}/scripts/nightly/open-prs/open-prs.js" --today "${HOY_A}" --org https://dev.azure.com/OrgFugaMarca --out "${A}/prs.txt" > "${A}/prs.out" 2>&1
env -u TELEGRAM_BOT_TOKEN -u TYCON_TELEGRAM_CHAT_ID TYCON_NOTIFY_WEBHOOK_URL="${WEBHOOK}" node "${SUMMARY}" deliver --source dependencies --today "${HOY_A}" \
  --out "${A}/deps/out" --pending "${A}/deps/pend" --config "${A}/repos.json" --summary-config "${A}/summary.json" --watcher-out "${A}/vig/out" \
  --operations "${A}/operations.json" > "${A}/deps.out" 2>&1; RC_D=$?
node -e '
require("fs").writeFileSync(process.argv[1], JSON.stringify({ fecha: process.argv[2], generado: process.argv[2] + "T08:00:00.000Z", productos: {}, conteos: {},
  hallazgos: [{ id: process.argv[2] + "-ProductoFugaVig-abcd", producto: "ProductoFugaVig", regla: "ReglaFuga", severidad: "alta" }],
  no_medido: ["host-fuga.cliente-secreto.com: sin respuesta"], nuevos: 1, repetidos: 0, marcados_ignorados: 0, ignorados_ids: [], modo: "normal", aviso: null, recordados: 0 }, null, 2));' "${A}/vig/out/vigilante-${HOY_A}.json" "${HOY_A}"
printf 'id: "%s-ProductoFugaVig-abcd"\nfecha: "%s"\nproducto: "ProductoFugaVig"\nregla: "ReglaFuga"\nhuella: "abcd"\nseveridad: "alta"\nplugin: "PluginFuga"\ndiagnostico: "DiagnosticoFuga con datos de cliente"\nveredicto: pendiente\n' "${HOY_A}" "${HOY_A}" > "${A}/vig/pend/pending/${HOY_A}-ProductoFugaVig-abcd.yaml"
env -u TELEGRAM_BOT_TOKEN -u TYCON_TELEGRAM_CHAT_ID TYCON_NOTIFY_WEBHOOK_URL="${WEBHOOK}" node "${SUMMARY}" deliver --source vigilante --today "${HOY_A}" \
  --out "${A}/vig/out" --pending "${A}/vig/pend" --deps-out "${A}/deps/out" --extra "${A}/prs.txt" --operations "${A}/operations.json" > "${A}/vig.out" 2>&1; RC_V=$?
# el aviso por hallazgo del vigilante, armado con su función y mandado por notify.js
AVISO=$(node -e '
const V = require(process.argv[1]);
process.stdout.write(V.construirAviso("2026-09-20", [{ producto: "ProductoFugaVig", plugin: "PluginFuga", endpoint: "/api/EndpointFuga", severidad: "alta", diagnostico: "DiagnosticoFuga" }],
  ["host-fuga.cliente-secreto.com: sin respuesta"], { max_hallazgos_por_aviso: 2 }, [{ edad: 4, campos: { id: "2026-09-16-ProductoFugaVig-ffff" } }]));' "${RAIZ}/scripts/nightly/watcher/vigilante.js")
TYCON_NOTIFY_WEBHOOK_URL="${WEBHOOK}" node "${RAIZ}/scripts/lib/notify.js" --operations "${A}/operations.json" -- "${AVISO}" > "${A}/hallazgo.out" 2>&1; RC_H=$?
kill "${SRV_AVISO}" 2>/dev/null
[ "${RC_D}" = 0 ] && [ "${RC_V}" = 0 ] && [ "${RC_H}" = 0 ] && [ "$(grep -c . "${A}/cuerpos.jsonl")" = 3 ] \
  && ok "2.30-T25 la cadena real mandó los tres avisos por el webhook (dependencias, vigilante y el aviso por hallazgo)" \
  || mal "2.30-T25 la cadena no mandó los tres avisos: deps=${RC_D} vig=${RC_V} hallazgo=${RC_H} · cuerpos=$(grep -c . "${A}/cuerpos.jsonl") · $(head -c 300 "${A}/deps.out") · $(head -c 300 "${A}/vig.out")"
python3 - "${A}/cuerpos.jsonl" <<'PY' && ok "2.30-T25 ningún marcador (paquete, repo, proyecto, correo, id, motivo, producto, host, diagnóstico, PR, organización) en ningún aviso" || mal "2.30-T25 🔴 un marcador llegó al aviso (arriba)"
import json, sys
marcas = ['paquete-fuga', 'RepoFuga', 'RepoNoMedidoFuga', 'ProyectoFugaA', 'ProyectoSinDuenoFuga', 'persona.fuga', 'cliente-secreto', 'fugaaa11', '7788',
          'MotivoLibreFuga', 'ProductoFugaVig', 'ProductoFugaDeps', 'host-fuga', 'DiagnosticoFuga', 'PluginFuga', 'EndpointFuga', 'ReglaFuga', 'OrgFugaMarca', 'ffff']
malos = []
for l in open(sys.argv[1]):
    t = json.loads(json.loads(l)['cuerpo']).get('text', '')
    malos += [m for m in marcas if m in t]
if malos: print('marcadores en el aviso:', sorted(set(malos)))
sys.exit(1 if malos else 0)
PY
python3 - "${A}/cuerpos.jsonl" <<'PY' && ok "2.30-T25 control positivo: las cantidades sembradas sí llegan (fallos, vivas, pedidos creados, PR sin consultar, el vigilante)" || mal "2.30-T25 control positivo: faltan cantidades en el aviso"
import json, sys
textos = [json.loads(json.loads(l)['cuerpo']).get('text', '') for l in open(sys.argv[1])]
deps, vig, hallazgo = textos
ok = ('fallos: 3' in deps and 'vivas: 1 en 1 proyecto(s)' in deps and 'pedidos creados: 1' in deps
      and 'PR abiertos hace más de 2 días: ? (no se pudo consultar)' in vig and '🌙 vigilante' in vig
      and '1 hallazgo(s) nuevo(s), 1 sin medir, 1 borrador(es) esperando' in hallazgo)
if not ok: print(textos)
sys.exit(0 if ok else 1)
PY
FUGA_WH=0
for f in "${A}/deps.out" "${A}/vig.out" "${A}/hallazgo.out" "${A}/deps/out/dependencias-${HOY_A}.json" "${A}/vig/out/vigilante-${HOY_A}.json"; do
  grep -q 'T0MARCAWH\|marcadorwebhookxyz123' "${f}" && { FUGA_WH=1; echo "    la dirección del webhook en ${f#${BASE}/}"; }
done
[ "${FUGA_WH}" -eq 0 ] && ok "2.30-T25 la dirección del webhook no aparece en la salida ni en las constancias" || mal "2.30-T25 🔴 la dirección del webhook se filtró"

# ── ConcentracionSinNombres @story-2.26 @ac-15 ──
# La concentración por persona se publica por producto, nunca con quién es. Se siembra un autor en los commits, se
# pasa por el guion del nocturno y por el tablero nocturno, y ni el nombre ni el correo pueden llegar a la página.
# 🔴 Atrapa: imprimir el autor principal en el detalle de la ficha, o guardarlo en el archivo de concentración.
C26="$(mktemp -d)"; mkdir -p "${C26}/scan/Acme__Back" "${C26}/.dashboard"
M_AUTOR="Zqx Persona Sembrada"; M_AUTOR_CORREO="zqx-sembrada@ej.test"
git -c maintenance.auto=false -c gc.auto=0 -C "${C26}/scan/Acme__Back" init -q -b main
for i in $(seq 1 22); do GIT_AUTHOR_NAME="${M_AUTOR}" GIT_AUTHOR_EMAIL="${M_AUTOR_CORREO}" GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@ej.test \
  git -c maintenance.auto=false -C "${C26}/scan/Acme__Back" commit -q --allow-empty -m "c ${i}"; done
printf '{ "repos": [{ "producto": "ProductoSembrado", "ado": "Acme/Back" }] }\n' > "${C26}/repos.json"
HOY26="$(date -u +%Y-%m-%d)"
node "${RAIZ}/scripts/metrics/author-concentration.js" --scan "${C26}/scan" --products "${C26}/repos.json" --out "${C26}/.dashboard/author-concentration-${HOY26}.json" > "${C26}/conc.out" 2>&1
node "${TABLERO}" --nightly --dir "${C26}/.dashboard" --output "${C26}/pagina.html" > "${C26}/tablero.out" 2>&1
FUGA26=0
for M in "${M_AUTOR}" "${M_AUTOR_CORREO}" "Zqx" "zqx-sembrada"; do
  for f in "${C26}/.dashboard/author-concentration-${HOY26}.json" "${C26}/conc.out" "${C26}/pagina.html" "${C26}/tablero.out"; do
    if grep -qiF -- "${M}" "${f}" 2>/dev/null; then mal "2.26 fuga: «${M}» aparece en ${f#${C26}/}"; FUGA26=1; fi
  done
done
[ "${FUGA26}" -eq 0 ] && ok "2.26 el autor sembrado no llega ni al archivo de concentración ni a la página"
grep -qF 'ProductoSembrado' "${C26}/pagina.html" && ok "2.26 control positivo: el producto sí llega a la página" || mal "2.26 control positivo: el producto no está en la página"
rm -rf "${C26}"

echo
[ "${FALLOS}" -eq 0 ] && { echo "todo verde"; exit 0; }
echo "${FALLOS} fallo(s)"; exit 1
