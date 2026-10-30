#!/usr/bin/env bash
# 🔴 AISLAMIENTO PRIMERO: HOME falso antes de ejecutar cualquier otra cosa. El
#    latido lee ~/.claude/.tycon-pipeline/timing-history/; acá nunca puede encontrar un volcado real.
#    Lo único que se toma del HOME de verdad es DÓNDE está agent-skills, para leer dos textos (T8).
AS_DIR="${TYCON_AGENT_SKILLS_DIR:-${HOME}/.claude/agent-skills}"
HOME="$(mktemp -d)"; export HOME
# Esta suite arma sus repos en el temporal del sistema, y retro-pending.js no anota ni reclama los repos de laboratorio:
# se declara que no hay carpetas de laboratorio, para medirlos como repos de verdad. El criterio de
# laboratorio se mide en T11c, con su carpeta declarada.
export TYCON_RETRO_LAB_DIRS=""
#
# retro-heartbeat.test.sh — red de `scripts/metrics/retro-heartbeat.js`.
#
# Lo que cuida, en una frase: que cada merge a main deje, en un segundo y sin modelo, el archivo que
# da el merge por retrospectivado — con la única métrica que alguien consume (las vueltas de revisión)
# y las otras cinco en null con quién las cubre. NUNCA un 0 donde no hubo insumo.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la MUTACIÓN que lo pone en rojo.
#    · T1 — elegir el volcado sólo por número de story (sin mirar el repo) toma el de OTRO repo, o el
#      del proyecto de prueba armado dentro de una sesión del mismo repo. Comparar sólo la ruta real, sin
#      reconocer el clon, no encuentra ninguno (muchas corridas del arnés corren en un clon descartable).
#    · T2 — pintar `0` donde no hubo corrida: el validador lo dejaría pasar (`count` acepta 0) y
#      `first_pass_ratio` lo descartaría en silencio; la regla la cumple el script.
#    · T3 — escribir sin validar: un valor inválido llega a la serie.
#    · T4 — nombre sin el sha: el segundo merge del día pisa al primero.
#    · T5 — saltar un volcado ilegible para tomar uno más viejo de la misma story: se publica la
#      corrida equivocada sin decirlo.
#    · T6 — copiar algo del volcado más allá de números de vuelta y fechas: viaja por git.
#
# bash 3.2 (macOS): siempre `${v}`. El exit code se lee antes de cualquier pipe.
# Correr: bash scripts/tests/retro-heartbeat.test.sh

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LATIDO="${RAIZ}/scripts/metrics/retro-heartbeat.js"
LIB="${RAIZ}/scripts/lib/dashboard-metrics.js"

fallos=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1 — $2"; fallos=$((fallos+1)); }

echo "== retro-heartbeat.test.sh =="
if [ ! -f "${LATIDO}" ]; then
  echo "❌ retro-latido: falta ${LATIDO}"; exit 1
fi

BASE="$(mktemp -d)"
trap 'rm -rf "${BASE}" "${HOME}"' EXIT
unset TYCON_TODAY TYCON_RETRO_HEARTBEAT_FORCE_ROUNDS TYCON_RETRO_PENDING TYCON_RETRO_PENDING_SCOPE
HIST="${HOME}/.claude/.tycon-pipeline/timing-history"
mkdir -p "${HIST}"
HOY="2026-09-16"
export TYCON_TODAY="${HOY}"

# ── el repo del merge ─────────────────────────────────────────────────────────────────────────────
REPO="${BASE}/proyecto"
mkdir -p "${REPO}/specs"
( cd "${REPO}" && git init -q -b main \
  && echo "---" > specs/story-9.9.md && echo "story: \"9.9\"" >> specs/story-9.9.md \
  && git add -A && git -c user.email=t@t -c user.name=t commit -q -m "feat: story 9.9" )
SHA1="$(git -C "${REPO}" rev-parse HEAD)"
( cd "${REPO}" && echo x > otro.txt && git add -A && git -c user.email=t@t -c user.name=t commit -q -m "fix: otro" )
SHA2="$(git -C "${REPO}" rev-parse HEAD)"
REPO_REAL="$(cd "${REPO}" && pwd -P)"
ENC="$(printf '%s' "${REPO_REAL}" | sed 's/[^A-Za-z0-9]/-/g')"
SESION="${BASE}/claude-501/${ENC}/sesion-1/scratchpad"
mkdir -p "${REPO}/.advisors/pipeline-runs/9.9-20260916-1000"

# volcado <archivo> <storyId> <repoPath> <storyPath> <por_vuelta JSON|null> <iterations JSON> <archivedAt>
volcado() {
  F="$1" SID="$2" RP="$3" SP="$4" PV="$5" IT="$6" AT="$7" node -e '
    const e = process.env; const pv = JSON.parse(e.PV); const it = JSON.parse(e.IT);
    const d = { archivedAt: e.AT, marker: { storyId: e.SID, repoPath: e.RP, storyPath: e.SP, iterations: it }, gates: [] };
    if (pv) d.revisores = { estado: "medido", por_vuelta: pv };
    require("fs").writeFileSync(e.F, JSON.stringify(d, null, 2));'
}
correr() { # correr <out-dir> <args...> → deja ${BASE}/rc, stdout y stderr
  local out="$1"; shift
  mkdir -p "${out}"
  node "${LATIDO}" "$@" --out "${out}" > "${BASE}/stdout" 2> "${BASE}/stderr"
  echo $? > "${BASE}/rc"
}
campo() { # campo <archivo> <expresión JS sobre d>
  F="$1" X="$2" node -e 'const d = JSON.parse(require("fs").readFileSync(process.env.F, "utf8")); const v = eval(process.env.X); process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));'
}

# ── T1 ────────────────────────────────────────────────────────────────────────────────────────────
volcado "${HIST}/9.9-2026-09-16T1000.json" 9.9 "${REPO_REAL}" "${REPO_REAL}/specs/story-9.9.md" \
  '{"0":1,"1":4,"2":3,"sin registro":1}' '{"1":{"ts":"2026-09-16T09:00:00Z","filesSnapshot":["a"]},"2":{"ts":"2026-09-16T09:30:00Z"}}' "2026-09-16T10:00:00.000Z"
volcado "${HIST}/9.9-2026-09-16T1100.json" 9.9 "${SESION}/tcg" "${SESION}/tcg/specs/story-9.9.md" \
  '{"0":1,"1":5,"2":2,"3":4}' '{"1":{},"2":{},"3":{}}' "2026-09-16T11:00:00.000Z"
volcado "${HIST}/9.9-2026-09-16T1200.json" 9.9 "/otra/maquina/OtroRepo" "/otra/maquina/OtroRepo/specs/story-9.9.md" \
  '{"1":1,"7":1}' '{"1":{},"7":{}}' "2026-09-16T12:00:00.000Z"
volcado "${HIST}/9.9-2026-09-16T1300.json" 9.9 "${SESION}/dorada/claude" "${SESION}/dorada/claude/specs/stories/story-9-9.md" \
  '{"1":1,"9":1}' '{"1":{},"9":{}}' "2026-09-16T13:00:00.000Z"

OUT1="${BASE}/out1"
T0="$(node -e 'console.log(Date.now())')"
correr "${OUT1}" --repo "${REPO}" --merge "${SHA1:0:12}" --story 9.9
RC="$(cat "${BASE}/rc")"
MS=$(( $(node -e 'console.log(Date.now())') - T0 ))
ARCH1="${OUT1}/metrics-${HOY}-proyecto-9.9-${SHA1:0:7}.json"
if [ "${RC}" = "0" ] && [ -f "${ARCH1}" ]; then
  ok "T1 escribió ${ARCH1##*/} (exit 0, ${MS} ms)"
  [ "${MS}" -lt 2000 ] && ok "T1 menos de 2 segundos" || bad "T1 tardó" "${MS} ms"
  [ "$(cat "${BASE}/stdout")" = "${ARCH1}" ] && ok "T1 imprime la ruta escrita" || bad "T1 stdout" "$(cat "${BASE}/stdout")"
  V="$(campo "${ARCH1}" 'd.metrics.advisor_rerun_loop_iterations.value')"
  [ "${V}" = "3" ] && ok "T1 vueltas = 3: la del CLON de este repo, no la del otro repo (7) ni la del proyecto de prueba de la sesión (9)" \
    || bad "T1 vueltas" "esperaba 3 (clon), vino ${V} — mutación: elegir por número de story sin mirar el repo, o no reconocer el clon"
  DET="$(campo "${ARCH1}" 'd.metrics.advisor_rerun_loop_iterations.detail')"
  echo "${DET}" | grep "revisores" >/dev/null && ok "T1 el detalle nombra la fuente (revisores por vuelta)" || bad "T1 detail" "${DET}"
  ID="$(campo "${ARCH1}" '[d.schema_version, d.project, d.captured_at, d.repo, d.merge_commit, d.story, d.run_dir, d.generated_by].join("|")')"
  # generated_by es un campo del registro: conserva el nombre original del generador
  ESP="2.0|proyecto|${HOY}|${REPO_REAL}|${SHA1}|9.9|.advisors/pipeline-runs/9.9-20260916-1000/|retro-""latido.js"
  [ "${ID}" = "${ESP}" ] && ok "T1 identidad completa (repo real, sha completo, story, run_dir, generated_by)" || bad "T1 identidad" "vino ${ID} · esperaba ${ESP}"
  NULOS="$(campo "${ARCH1}" 'Object.entries(d.metrics).filter(([k]) => k !== "advisor_rerun_loop_iterations").map(([k, m]) => k + "=" + (m.value === null ? "null:" + m.unavailable_reason : m.value)).join("\n")')"
  CINCO="$(printf '%s\n' "${NULOS}" | grep -c '=null:')"
  # son SEIS: incluye `deep_review_skipped_then_hotfixed`, que va siempre en null con su
  # motivo y la señal de carril al lado (T9).
  [ "${CINCO}" = "6" ] && ok "T1 las otras seis en null con motivo" || bad "T1 seis null" "${NULOS}"
  # el motivo es texto de registro: puede nombrar al recolector con el nombre actual o con el nombre viejo que da el
  # mapa de renombres (no se escribe literal)
  RECOLECTOR_VIEJO="$(node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entries.find((x)=>x.kind==="file"&&x.new==="scripts/metrics/collect-findings.js");process.stdout.write(e?e.old.split("/").pop():"collect-findings.js")' "${RAIZ}/scripts/lib/renames.json" 2>/dev/null || echo collect-findings.js)"
  RECOLECTOR_RE="collect-findings\\.js|${RECOLECTOR_VIEJO//./\\.}"
  printf '%s\n' "${NULOS}" | grep '^advisor_warnings_per_story=' | grep -E "${RECOLECTOR_RE}" >/dev/null \
    && printf '%s\n' "${NULOS}" | grep '^advisor_warnings_actioned_ratio=' | grep -E "${RECOLECTOR_RE}" >/dev/null \
    && printf '%s\n' "${NULOS}" | grep '^advisor_pipeline_runtime_failures=' | grep 'reviewers-cost.js' >/dev/null \
    && printf '%s\n' "${NULOS}" | grep '^step_8_commit_skipped_rerun=' | grep 'complete-step' >/dev/null \
    && printf '%s\n' "${NULOS}" | grep '^advisor_findings_on_verification_artifacts=' | grep 'a pedido' >/dev/null \
    && ok "T1 cada motivo nombra quién la cubre (2.9, 2.15, el portón del paso 8, a pedido)" || bad "T1 motivos" "${NULOS}"
  VAL="$(F="${ARCH1}" LIB="${LIB}" DIR="${OUT1}" node -e '
    const m = require(process.env.LIB); const fs = require("fs");
    const v = m.validate(JSON.parse(fs.readFileSync(process.env.F, "utf8")));
    const r = m.loadAll(process.env.DIR).records.find((x) => process.env.F.endsWith(x.file));
    console.log(v.ok + "|" + v.errors.join(";") + "|" + (r ? r.status + ":" + r.values.advisor_rerun_loop_iterations : "sin registro"));')"
  [ "${VAL}" = "true||ok:3" ] && ok "T1 validate() lo acepta y loadAll lo lee con 3 (lo que cuenta first_pass_ratio)" || bad "T1 validate/loadAll" "${VAL}"
else
  bad "T1 no escribió el archivo" "rc=${RC} · $(head -c 400 "${BASE}/stderr")"
fi

# ── T2 ────────────────────────────────────────────────────────────────────────────────────────────
OUT2="${BASE}/out2"
correr "${OUT2}" --repo "${REPO}" --merge "${SHA2}"
RC="$(cat "${BASE}/rc")"
ARCH2="${OUT2}/metrics-${HOY}-proyecto-adhoc-${SHA2:0:7}.json"
if [ "${RC}" = "0" ] && [ -f "${ARCH2}" ]; then
  export RR="${REPO_REAL}" S2="${SHA2}"
  R="$(campo "${ARCH2}" '[Object.values(d.metrics).filter((m) => m.value === null && m.unavailable_reason).length, Object.values(d.metrics).some((m) => m.value === 0), d.repo === process.env.RR, d.merge_commit === process.env.S2, d.story].join("|")')"
  [ "${R}" = "7|false|true|true|" ] && ok "T2 ad-hoc sin --story: siete null con motivo, ningún 0, repo y merge presentes" \
    || bad "T2 ad-hoc" "vino ${R} — mutación: pintar 0 donde no hubo corrida"
else
  bad "T2 ad-hoc no escribió" "rc=${RC} · $(head -c 300 "${BASE}/stderr")"
fi
OUT2B="${BASE}/out2b"
correr "${OUT2B}" --repo "${REPO}" --merge "${SHA2}" --story 8.8
ARCH2B="${OUT2B}/metrics-${HOY}-proyecto-8.8-${SHA2:0:7}.json"
if [ -f "${ARCH2B}" ]; then
  R="$(campo "${ARCH2B}" 'd.metrics.advisor_rerun_loop_iterations.value === null && /sin volcado/.test(d.metrics.advisor_rerun_loop_iterations.unavailable_reason)')"
  [ "${R}" = "true" ] && ok "T2 con --story sin volcado: vueltas null «sin volcado de ejecución»" || bad "T2 sin volcado" "$(campo "${ARCH2B}" 'd.metrics.advisor_rerun_loop_iterations')"
else
  bad "T2 --story sin volcado no escribió" "rc=$(cat "${BASE}/rc") · $(head -c 300 "${BASE}/stderr")"
fi

# ── T3 ────────────────────────────────────────────────────────────────────────────────────────────
OUT3="${BASE}/out3"
mkdir -p "${OUT3}"
TYCON_RETRO_HEARTBEAT_FORCE_ROUNDS=0 node "${LATIDO}" --repo "${REPO}" --merge "${SHA1}" --story 9.9 --out "${OUT3}" > "${BASE}/stdout" 2> "${BASE}/stderr"
RC=$?
N3="$(ls "${OUT3}" | wc -l | tr -d ' ')"
if [ "${RC}" = "2" ] && [ "${N3}" = "0" ] && grep -q "advisor_rerun_loop_iterations" "${BASE}/stderr"; then
  ok "T3 el validador rechaza (vueltas 0 en una count1): exit 2, nada escrito, nombra la métrica"
else
  bad "T3 validador" "rc=${RC} archivos=${N3} stderr=$(head -c 300 "${BASE}/stderr") — mutación: escribir sin validate()"
fi

# ── T4 ────────────────────────────────────────────────────────────────────────────────────────────
OUT4="${BASE}/out4"
correr "${OUT4}" --repo "${REPO}" --merge "${SHA1}"
correr "${OUT4}" --repo "${REPO}" --merge "${SHA2}"
N4="$(ls "${OUT4}" | grep -c "^metrics-${HOY}-proyecto-adhoc-")"
[ "${N4}" = "2" ] && [ -f "${OUT4}/metrics-${HOY}-proyecto-adhoc-${SHA1:0:7}.json" ] && [ -f "${OUT4}/metrics-${HOY}-proyecto-adhoc-${SHA2:0:7}.json" ] \
  && ok "T4 dos merges el mismo día: dos archivos, uno por sha" || bad "T4 dos merges" "$(ls "${OUT4}")"

# ── T5 ────────────────────────────────────────────────────────────────────────────────────────────
echo '{roto' > "${HIST}/5.1-2026-09-16T1000.json"
volcado "${HIST}/5.2-2026-09-16T1000.json" 5.2 "${REPO_REAL}" "${REPO_REAL}/specs/story-9.9.md" 'null' '{}' "2026-09-16T10:00:00.000Z"
volcado "${HIST}/5.3-2026-09-16T1000.json" 5.3 "${REPO_REAL}" "${REPO_REAL}/specs/story-9.9.md" 'null' '{"1":{},"3":{}}' "2026-09-16T10:00:00.000Z"
volcado "${HIST}/5.4-2026-09-16T0900.json" 5.4 "${REPO_REAL}" "${REPO_REAL}/specs/story-9.9.md" '{"1":1,"2":1}' '{"1":{},"2":{}}' "2026-09-16T09:00:00.000Z"
echo '{roto' > "${HIST}/5.4-2026-09-16T1000.json"
t5() { # t5 <story> <expresión esperada sobre m> <nombre>
  local out="${BASE}/out5-$1"
  correr "${out}" --repo "${REPO}" --merge "${SHA1}" --story "$1"
  local f="${out}/metrics-${HOY}-proyecto-$1-${SHA1:0:7}.json"
  if [ ! -f "${f}" ]; then bad "T5 $3" "no escribió el archivo (rc=$(cat "${BASE}/rc")) — el archivo se escribe igual"; return; fi
  local r; r="$(campo "${f}" "(() => { const m = d.metrics.advisor_rerun_loop_iterations; return $2; })()")"
  [ "${r}" = "true" ] && ok "T5 $3" || bad "T5 $3" "$(campo "${f}" 'd.metrics.advisor_rerun_loop_iterations')"
}
t5 5.1 'm.value === null && /ilegible/.test(m.unavailable_reason)' "JSON roto: null «volcado ilegible», archivo escrito"
t5 5.2 'm.value === null && /no anota vueltas/.test(m.unavailable_reason)' "iterations vacío y sin revisores: null «no anota vueltas»"
t5 5.3 'm.value === 3 && /iterations/.test(m.detail)' "sin revisores por vuelta pero con fotos {1,3}: 3 desde marker.iterations"
t5 5.4 'm.value === null && /ilegible/.test(m.unavailable_reason)' "el más nuevo ilegible NO se salta para tomar uno más viejo"

# ── T6 ────────────────────────────────────────────────────────────────────────────────────────────
M_CORREO="fuga.persona@cliente-secreto.com"
M_RUTA="/Users/fulano/SourceCode/ClienteSecretoSA/Pagos/x.cs"
M_PROMPT="PROMPT-FUGA-7731 implementemos lo del cliente"
F6="${HIST}/6.6-2026-09-16T1000.json"
volcado "${F6}" 6.6 "${REPO_REAL}" "${REPO_REAL}/specs/story-9.9.md" '{"1":2,"2":2}' '{"1":{"ts":"2026-09-16T09:00:00Z"},"2":{"ts":"2026-09-16T09:30:00Z"}}' "2026-09-16T10:00:00.000Z"
F="${F6}" C="${M_CORREO}" R="${M_RUTA}" P="${M_PROMPT}" node -e '
  const fs = require("fs"); const e = process.env; const d = JSON.parse(fs.readFileSync(e.F, "utf8"));
  d.marker.iterations["1"].filesSnapshot = [e.R, e.C]; d.marker.iterations["2"].filesSnapshot = [e.R];
  d.marker.planApproval = { text: e.P }; d.marker.filesTouched = [e.R]; d.gates = [{ check: "tests", mensaje: e.C + " " + e.R }];
  d.consumo = { estado: "medido", motivo: e.P }; d.revisores.motivo = e.C;
  fs.writeFileSync(e.F, JSON.stringify(d));'
mkdir -p "${REPO}/.advisors/pipeline-runs/6.6-20260916-1000"
printf '[{"rule_id":"SEC-C1","reason":"%s en %s","file":"%s"}]\n' "${M_PROMPT}" "${M_CORREO}" "${M_RUTA}" > "${REPO}/.advisors/pipeline-runs/6.6-20260916-1000/findings.json"
OUT6="${BASE}/out6"
correr "${OUT6}" --repo "${REPO}" --merge "${SHA1}" --story 6.6
F6OUT="${OUT6}/metrics-${HOY}-proyecto-6.6-${SHA1:0:7}.json"
if [ -f "${F6OUT}" ]; then
  FUGA=0
  for m in "${M_CORREO}" "${M_RUTA}" "PROMPT-FUGA-7731" "ClienteSecretoSA" "fulano"; do
    if grep -qF "${m}" "${F6OUT}"; then bad "T6 fuga" "«${m}» apareció en el archivo — mutación: copiar filesSnapshot, gates o findings"; FUGA=1; fi
  done
  [ "$(campo "${F6OUT}" 'd.metrics.advisor_rerun_loop_iterations.value')" = "2" ] || { bad "T6 control positivo" "el volcado sembrado no dio sus 2 vueltas"; FUGA=1; }
  [ "${FUGA}" = "0" ] && ok "T6 ni correo, ni ruta, ni prompt del volcado ni del findings.json en el archivo (y sí sus 2 vueltas)"
else
  bad "T6 no escribió" "rc=$(cat "${BASE}/rc") · $(head -c 300 "${BASE}/stderr")"
fi

# ── default de --out y repo que no es git ─────────────────────────────────────────────────
TCG="${BASE}/tcg"
mkdir -p "${TCG}/scripts/metrics" "${TCG}/scripts/lib" "${TCG}/scripts/hooks" "${TCG}/.dashboard"
cp "${LATIDO}" "${TCG}/scripts/metrics/"
cp "${LIB}" "${RAIZ}/scripts/lib/az-pr.js" "${RAIZ}/scripts/lib/git-target.js" "${RAIZ}/scripts/lib/shell-parse.js" "${RAIZ}/scripts/lib/harness-repo.js" "${RAIZ}/scripts/lib/legacy-names.js" "${RAIZ}/scripts/lib/retro-coverage.js" "${TCG}/scripts/lib/"
cp "${RAIZ}/scripts/hooks/retro-pending.js" "${TCG}/scripts/hooks/"
node "${TCG}/scripts/metrics/retro-heartbeat.js" --repo "${REPO}" --merge "${SHA1}" --story 9.9 > "${BASE}/stdout" 2> "${BASE}/stderr"
RC=$?
[ "${RC}" = "0" ] && [ -f "${TCG}/.dashboard/metrics-${HOY}-proyecto-9.9-${SHA1:0:7}.json" ] \
  && ok "AC6 sin --out escribe en el .dashboard/ del arnés donde vive el script" || bad "AC6 default --out" "rc=${RC} · $(ls "${TCG}/.dashboard") · $(head -c 300 "${BASE}/stderr")"
mkdir -p "${BASE}/no-git"
node "${LATIDO}" --repo "${BASE}/no-git" --merge "${SHA1}" --out "${BASE}/out-nogit" > "${BASE}/stdout" 2> "${BASE}/stderr"
RC=$?
[ "${RC}" = "2" ] && grep -qi "no es un repo git" "${BASE}/stderr" && [ ! -d "${BASE}/out-nogit" -o -z "$(ls -A "${BASE}/out-nogit" 2>/dev/null)" ] \
  && ok "AC6 --repo que no es git: exit 2 con el motivo, nada escrito" || bad "AC6 no-git" "rc=${RC} · $(head -c 300 "${BASE}/stderr")"
node "${LATIDO}" --repo "${REPO}" --merge deadbeefdeadbeef --out "${BASE}/out-nosha" > "${BASE}/stdout" 2> "${BASE}/stderr"
RC=$?
[ "${RC}" = "2" ] && grep -qi "merge" "${BASE}/stderr" \
  && ok "AC6 --merge que no resuelve a un commit: exit 2 con el motivo" || bad "AC6 sha inexistente" "rc=${RC} · $(head -c 300 "${BASE}/stderr")"

# ── el archivo cubre el merge para retro-pending, y la serie lo suma ──────────────────────
LEDGER_DIR="${HOME}/.claude/.tycon-pipeline"
printf '{"ts":"2026-09-16T10:00:00.000Z","sessionId":"s-test","repoPath":"%s","sha":"%s","branch":"main"}\n' "${REPO_REAL}" "${SHA1:0:12}" > "${LEDGER_DIR}/retro-pending.jsonl"
REP="$(node "${TCG}/scripts/hooks/retro-pending.js" --report --days 36500 2>&1)"
RC=$?
echo "${REP}" | grep '"conRetro": 1' >/dev/null && echo "${REP}" | grep '"pendientes": 0' >/dev/null \
  && ok "AC5 retro-pending da el merge por cubierto con el archivo del latido" || bad "AC5 cobertura" "rc=${RC} · ${REP}"
SER="$(node "${RAIZ}/scripts/lib/dashboard-series.js" --dir "${OUT1}" --json 2>&1)"
RC=$?
[ "${RC}" = "0" ] && echo "${SER}" | node -e 'const s = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(s.counts.v2ok === 1 && s.series.advisor_rerun_loop_iterations.n === 1 ? 0 : 1)' \
  && ok "T10 dashboard-series.js suma el archivo del latido (v2ok 1, vueltas n=1)" || bad "T10 serie" "rc=${RC} · $(echo "${SER}" | head -c 400)"

# ── dónde escribe la máquina sin --out: su carpeta de estado, nunca un clon ───────────────────────
# Cada caso con su HOME, para que la carpeta de estado y la llave del buzón sean las del caso. La llave se pasa siempre
# por TYCON_MAILBOX_JSON: ninguna prueba lee la de verdad.
# MUTACIÓN que pone en rojo T1/T2/T26: volver a escribir en el `.dashboard/` del clon de mantenimiento o del propio árbol.
# MUTACIÓN que pone en rojo T4: callar el «no viaja» cuando no hay llave.
ARCH_ADHOC="metrics-${HOY}-proyecto-adhoc-${SHA2:0:7}.json"
latido_en() { # latido_en <home> <archivo de llave> <args...> → deja ${BASE}/rc, stdout y stderr
  local h="$1" k="$2"; shift 2
  # el portón de pruebas apaga el buzón (TYCON_MAILBOX=0): la suite decide sólo con la llave que le pasa
  env -u TYCON_MAILBOX HOME="${h}" TYCON_MAILBOX_JSON="${k}" node "${LATIDO}" --repo "${REPO}" --merge "${SHA2}" "$@" > "${BASE}/stdout" 2> "${BASE}/stderr"
  echo $? > "${BASE}/rc"
}
LLAVE="${BASE}/llaves/corridas-buzon.json"
mkdir -p "${BASE}/llaves"
printf '{"cuenta":"cuentaprueba","contenedor":"corridas","sas":"si=p&sig=x","vence":"2099-01-01"}\n' > "${LLAVE}"

# T1 Heartbeat_NoOut_WritesStateDir — versión bajada que declara su clon de mantenimiento
H1="${BASE}/home-t1"; CLON1="${BASE}/clon-mantenimiento"
mkdir -p "${H1}/.tycon/state" "${CLON1}/.dashboard"
printf '{"sources":[{"kind":"release"}]}\n' > "${H1}/.tycon/state/harness-state.json"
printf '{"paths":{"maintainers":"%s"}}\n' "${CLON1}" > "${H1}/.tycon/config.json"
( cd "${CLON1}" && git init -q -b main && touch .dashboard/.gitkeep && git add -A && git -c user.email=t@t -c user.name=t commit -q -m inicial )
latido_en "${H1}" "${LLAVE}"
RC="$(cat "${BASE}/rc")"
[ "${RC}" = "0" ] && [ -f "${H1}/.tycon/state/dashboard/${ARCH_ADHOC}" ] && [ -z "$(git -C "${CLON1}" status --porcelain)" ] \
  && ! grep -q "no viaja" "${BASE}/stderr" \
  && ok "T1 sin --out, en una versión bajada: escribe en la carpeta de estado, el clon de mantenimiento queda limpio y, con llave, no avisa" \
  || bad "T1 Heartbeat_NoOut_WritesStateDir" "rc=${RC} · $(ls -R "${H1}/.tycon/state" 2>&1 | head -c 300) · $(git -C "${CLON1}" status --porcelain) · $(head -c 300 "${BASE}/stderr")"

# T2 Heartbeat_FromClone_WritesStateDir — el arnés corriendo desde un clon (este árbol)
H2="${BASE}/home-t2"; mkdir -p "${H2}"
ANTES2="$(ls "${RAIZ}/.dashboard" 2>/dev/null)"
latido_en "${H2}" "${LLAVE}"
RC="$(cat "${BASE}/rc")"
[ "${RC}" = "0" ] && [ -f "${H2}/.claude/.tycon-pipeline/dashboard/${ARCH_ADHOC}" ] && [ "$(ls "${RAIZ}/.dashboard" 2>/dev/null)" = "${ANTES2}" ] \
  && ok "T2 desde un clon: escribe en la carpeta de estado y nada en el .dashboard/ del clon" \
  || bad "T2 Heartbeat_FromClone_WritesStateDir" "rc=${RC} · $(ls -R "${H2}" 2>&1 | head -c 300) · $(head -c 300 "${BASE}/stderr")"

# T3 Heartbeat_ExplicitOut_Unchanged — con --out, la carpeta pedida y ninguna otra
H3="${BASE}/home-t3"; mkdir -p "${H3}"
latido_en "${H3}" "${BASE}/llaves/no-esta.json" --out "${BASE}/out-t3"
RC="$(cat "${BASE}/rc")"
[ "${RC}" = "0" ] && [ -f "${BASE}/out-t3/${ARCH_ADHOC}" ] && [ ! -d "${H3}/.claude/.tycon-pipeline/dashboard" ] && ! grep -q "no viaja" "${BASE}/stderr" \
  && ok "T3 con --out: escribe ahí, como siempre, y no toca la carpeta de estado" \
  || bad "T3 Heartbeat_ExplicitOut_Unchanged" "rc=${RC} · $(ls "${BASE}/out-t3" 2>&1) · $(head -c 300 "${BASE}/stderr")"

# T4 Heartbeat_NoKey_SaysNotTravel — sin llave del buzón: escribe igual y dice que no viaja
H4="${BASE}/home-t4"; mkdir -p "${H4}"
latido_en "${H4}" "${BASE}/llaves/no-esta.json"
RC="$(cat "${BASE}/rc")"
[ "${RC}" = "0" ] && [ -f "${H4}/.claude/.tycon-pipeline/dashboard/${ARCH_ADHOC}" ] && grep -q "no viaja" "${BASE}/stderr" \
  && [ "$(cat "${BASE}/stdout")" = "${H4}/.claude/.tycon-pipeline/dashboard/${ARCH_ADHOC}" ] \
  && ok "T4 sin llave: escribe en la carpeta de estado, sale 0 y dice por stderr que no viaja (stdout sólo la ruta)" \
  || bad "T4 Heartbeat_NoKey_SaysNotTravel" "rc=${RC} · $(cat "${BASE}/stdout") · $(head -c 300 "${BASE}/stderr")"

# T26 RetroPending_StateDirCovers — el merge anotado queda cubierto por el archivo de la carpeta de estado
H26="${BASE}/home-t26"; mkdir -p "${H26}/.claude/.tycon-pipeline"
latido_en "${H26}" "${BASE}/llaves/no-esta.json"
printf '{"ts":"2026-09-16T10:00:00.000Z","sessionId":"s-test","repoPath":"%s","sha":"%s","branch":"main"}\n' "${REPO_REAL}" "${SHA2:0:12}" > "${H26}/.claude/.tycon-pipeline/retro-pending.jsonl"
REP="$(HOME="${H26}" TYCON_MAILBOX_JSON="${BASE}/llaves/no-esta.json" node "${RAIZ}/scripts/hooks/retro-pending.js" --report --days 36500 2>&1)"
RC=$?
echo "${REP}" | grep '"conRetro": 1' >/dev/null && echo "${REP}" | grep '"pendientes": 0' >/dev/null \
  && ok "T26 retro-pending da el merge por cubierto con el archivo de la carpeta de estado" || bad "T26 RetroPending_StateDirCovers" "rc=${RC} · $(echo "${REP}" | head -c 400)"

# ── Casos de borde de la identidad del repo ──────────────────────────────────────────────────────
# T1b — worktree del arnés (<Repo>--wt-<slug>, <Repo>--merge; guides/git-worktrees.md). Falla si: el
#       volcado de un worktree no coincide con el repo y sale «sin volcado» (null con motivo falso).
volcado "${HIST}/9.7-2026-09-16T1000.json" 9.7 "${REPO_REAL}--wt-9-7-algo" "${REPO_REAL}--wt-9-7-algo/specs/story-9.9.md" '{"1":1,"2":1}' '{}' "2026-09-16T10:00:00.000Z"
t1x() { # t1x <story> <repo-arg> <esperado JSON de value> <nombre> [cwd]
  local out="${BASE}/out-$1-$RANDOM"; mkdir -p "${out}"
  ( cd "${5:-${BASE}}" && node "${LATIDO}" --repo "$2" --merge "${SHA1}" --story "$1" --out "${out}" > "${BASE}/stdout" 2> "${BASE}/stderr" )
  local f; f="$(ls "${out}"/metrics-*.json 2>/dev/null | head -1)"
  if [ -z "${f}" ]; then bad "$4" "no escribió (rc?) $(head -c 300 "${BASE}/stderr")"; return; fi
  local v; v="$(campo "${f}" 'd.metrics.advisor_rerun_loop_iterations.value')"
  [ "${v}" = "$3" ] && ok "$4" || bad "$4" "esperaba ${3}, vino ${v} · $(campo "${f}" 'd.metrics.advisor_rerun_loop_iterations.unavailable_reason || ""')"
}
t1x 9.7 "${REPO}" 2 "T1b un volcado corrido en <Repo>--wt-<slug> es de ese repo (2 vueltas)"
git -C "${REPO}" worktree add -q --detach "${REPO}--merge" "${SHA1}" 2>/dev/null
volcado "${HIST}/9.4-2026-09-16T1000.json" 9.4 "${REPO_REAL}" "${REPO_REAL}/specs/story-9.9.md" '{"1":1,"2":1,"3":1}' '{}' "2026-09-16T10:00:00.000Z"
if [ -d "${REPO}--merge" ]; then
  t1x 9.4 "${REPO}--merge" 3 "T1b el merge desde <Repo>--merge encuentra la corrida del checkout principal (3 vueltas)"
else
  bad "T1b" "no se pudo armar el worktree <Repo>--merge para la prueba"
fi
# T1c — repoPath RELATIVO ('.', 'mcp', 'MiBackend'). Falla si: se resuelve contra la carpeta desde donde
#       corre el latido; desde adentro del repo toma las vueltas de otro proyecto y desde afuera da null —
#       el mismo comando, dos archivos distintos.
volcado "${HIST}/9.6-2026-09-16T1000.json" 9.6 "." "specs/story-9.9.md" '{"1":1,"2":1}' '{}' "2026-09-16T10:00:00.000Z"
t1x 9.6 "${REPO}" null "T1c repoPath relativo ('.') NO coincide desde adentro del repo" "${REPO}"
t1x 9.6 "${REPO}" null "T1c ... ni desde afuera: el resultado no depende de la carpeta"
# T1d — mayúsculas (macOS/Windows no distinguen). Falla si: el volcado propio con otra caja no aparece.
if [ "$(uname)" = "Darwin" ]; then
  RP_CAJA="$(printf '%s' "${REPO_REAL}" | sed 's#/proyecto$#/PROYECTO#')"
  volcado "${HIST}/9.5-2026-09-16T1000.json" 9.5 "${RP_CAJA}" "${RP_CAJA}/specs/story-9.9.md" '{"1":1,"2":1}' '{}' "2026-09-16T10:00:00.000Z"
  t1x 9.5 "${REPO}" 2 "T1d en macOS, el mismo repo escrito con otra caja es el mismo repo"
else
  echo "⏭️  T1d salteado: el disco de esta máquina distingue mayúsculas (no es verde: no se midió)"
fi
# T5b — otra story cuyo id EXTIENDE a éste con guion (1.3 y 1.3-B-frontend). Falla si: su volcado
#       ilegible, aunque viejo, deja la métrica en null «ilegible» porque su sello no es una fecha.
volcado "${HIST}/1.3-2026-09-16T1000.json" 1.3 "${REPO_REAL}" "${REPO_REAL}/specs/story-9.9.md" '{"1":3,"2":2}' '{}' "2026-09-16T10:00:00.000Z"
echo '{roto' > "${HIST}/1.3-B-frontend-2026-07-17T1808.json"
t1x 1.3 "${REPO}" 2 "T5b el volcado ilegible de la story 1.3-B-frontend no anula la 1.3"
# T5c — un volcado sin archivedAt contra uno con archivedAt (SILENT-W8). Falla si: las claves se comparan
#       en formatos distintos y el que no trae la fecha pierde siempre, aunque sea más nuevo.
volcado "${HIST}/4.1-2026-09-16T0900.json" 4.1 "${REPO_REAL}" "${REPO_REAL}/specs/story-9.9.md" '{"1":1}' '{}' "2026-09-16T09:00:00.000Z"
F="${HIST}/4.1-2026-09-16T1500.json" RR="${REPO_REAL}" node -e 'require("fs").writeFileSync(process.env.F, JSON.stringify({ marker: { storyId: "4.1", repoPath: process.env.RR, storyPath: process.env.RR + "/specs/story-9.9.md", iterations: {} }, revisores: { por_vuelta: { "1": 1, "2": 1 } } }))'
t1x 4.1 "${REPO}" 2 "T5c el volcado de las 15:00 sin archivedAt le gana al de las 09:00 con archivedAt"

# T11 — el CLI que corre el paso 10b: `retro-pending.js --judge <repo>` (TEST-W1). Un push sólo de tests
#       sale exento; uno con código, no.
J="${BASE}/juzgar"; mkdir -p "${J}"
( cd "${J}" && git init -q --bare remoto.git && git init -q -b main repo && cd repo && echo x > a.txt && git add -A \
  && git -c user.email=t@t -c user.name=t commit -q -m base && git remote add origin ../remoto.git && git push -q origin main \
  && mkdir -p tests && echo t > tests/x.test.sh && git add -A && git -c user.email=t@t -c user.name=t commit -q -m "fix(tests): uno" && git push -q origin main )
JZ="$(node "${RAIZ}/scripts/hooks/retro-pending.js" --judge "${J}/repo" 2>&1)"
echo "${JZ}" | node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(j.exento === "solo-tests-docs" && j.target === "main" && typeof j.repo === "string" ? 0 : 1)' \
  && ok "T11 --judge: un push sólo de tests sale exento (JSON con repo, target, exento)" || bad "T11 --judge exento" "${JZ}"
( cd "${J}/repo" && echo y > b.js && git add -A && git -c user.email=t@t -c user.name=t commit -q -m "feat: código" && git push -q origin main )
JZ="$(node "${RAIZ}/scripts/hooks/retro-pending.js" --judge "${J}/repo" 2>&1)"
echo "${JZ}" | node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(j.exento === null ? 0 : 1)' \
  && ok "T11 --judge: un push con código NO está exento (exento: null → corre el latido)" || bad "T11 --judge código" "${JZ}"
# T11b — `--judge` dice también si el repo es DEL ARNÉS, o sea si el hook anotaría ese push.
#        `exento` no cambia: sigue hablando de lo que trajo el push.
echo "${JZ}" | node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(j.arnes === false && j.registraria === true ? 0 : 1)' \
  && ok "T11b --judge: un repo de producto sale arnes:false y registraria:true" || bad "T11b --judge producto" "${JZ}"
# El remoto «del arnés» es el que el propio juez reconoce para ESTE checkout, venga de donde venga (el interno, el repo
# de mantenimiento, una copia de GitHub): escrito a mano, el caso saldría rojo apenas el banco corriera desde otro repo.
# Con un usuario cualquiera adelante: no cuenta para la identidad.
ARNES_URL="$(node "${RAIZ}/scripts/lib/harness-repo.js" "${RAIZ}" 2>/dev/null | node -e 'try { const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(j.arnes && j.por === "remoto" && /^https:\/\//.test(j.url || "") ? j.url.replace(/^https:\/\/[^@/]*@/, "https://otro@").replace(/^https:\/\/(?!otro@)/, "https://otro@") : ""); } catch (_) {}')"
# un checkout sin remoto legible (un laboratorio): el remoto del arnés se declara, con uno inventado
ARNES_ENV=""
[ -n "${ARNES_URL}" ] || { ARNES_URL="https://otro@example.invalid/acme/el-arnes.git"; ARNES_ENV="https://example.invalid/acme/el-arnes.git"; }
( cd "${J}/repo" && git remote set-url origin "${ARNES_URL}" )
if [ -n "${ARNES_ENV}" ]; then JZ="$(TYCON_HARNESS_IDENTITIES="${ARNES_ENV}" node "${RAIZ}/scripts/hooks/retro-pending.js" --judge "${J}/repo" 2>&1)"
else JZ="$(node "${RAIZ}/scripts/hooks/retro-pending.js" --judge "${J}/repo" 2>&1)"; fi
echo "${JZ}" | node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(j.arnes === true && j.arnes_por === "remoto" && j.registraria === false && j.exento === null ? 0 : 1)' \
  && ok "T11b --judge: un clon del arnés (carpeta «repo», remoto del arnés) sale arnes:true y registraria:false, con exento intacto" || bad "T11b --judge arnés" "${JZ}"

# T11c — `--judge` dice también si el repo es de LABORATORIO: uno que vive en una carpeta temporal y cuyo
#        remoto no tiene copia de trabajo fuera de las temporales no se anota (registraria:false). El clon descartable
#        de un repo con copia de trabajo afuera, sí. Falla si: --judge no conoce el campo y dice registraria:true.
L="${BASE}/laboratorio"; mkdir -p "${L}/temporal" "${L}/repos/producto"
( cd "${L}/repos/producto" && git init -q -b main . && git remote add origin https://dev.azure.com/acme/Producto/_git/Producto )
( cd "${L}/temporal" && git init -q -b main juguete && git -C juguete remote add origin https://github.com/acme-pruebas/juguete.git \
  && git init -q -b main clon && git -C clon remote add origin https://dev.azure.com/acme/Producto/_git/Producto )
for R in juguete clon; do
  ( cd "${L}/temporal/${R}" && echo x > a.txt && git add -A && git -c user.email=t@t -c user.name=t commit -q -m base )
done
JZ="$(TYCON_RETRO_LAB_DIRS="${L}/temporal" TYCON_REPOS_ROOT="${L}/repos" node "${RAIZ}/scripts/hooks/retro-pending.js" --judge "${L}/temporal/juguete" 2>&1)"
echo "${JZ}" | node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(j.laboratorio === true && j.registraria === false ? 0 : 1)' \
  && ok "T11c --judge: un repo de juguete en una carpeta temporal sale laboratorio:true y registraria:false" || bad "T11c --judge laboratorio" "${JZ}"
JZ="$(TYCON_RETRO_LAB_DIRS="${L}/temporal" TYCON_REPOS_ROOT="${L}/repos" node "${RAIZ}/scripts/hooks/retro-pending.js" --judge "${L}/temporal/clon" 2>&1)"
echo "${JZ}" | node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(j.laboratorio === false && j.laboratorio_por === "mismo-remoto-que-una-copia-de-afuera" && j.registraria === true ? 0 : 1)' \
  && ok "T11c --judge: el clon descartable de un repo con copia de trabajo afuera NO es laboratorio (registraria:true)" || bad "T11c --judge clon" "${JZ}"

# T12 — el archivo se nombra por el REPO (lo que dice su remoto), no por la carpeta del clon:
#       un latido lanzado desde un clon descartable no debe salir `metrics-…-tcg-adhoc-…`. El campo `repo` NO
#       cambia: es la ruta con la que retro-pending.js empareja el merge con su archivo.
N="${BASE}/nombre"; mkdir -p "${N}/out"
( cd "${N}" && git init -q -b main clon-descartable && cd clon-descartable && echo x > a.txt && git add -A \
  && git -c user.email=t@t -c user.name=t commit -q -m base && git remote add origin https://dev.azure.com/acme/UnProyecto/_git/MiRepo )
SHAN="$(git -C "${N}/clon-descartable" rev-parse HEAD)"
node "${LATIDO}" --repo "${N}/clon-descartable" --merge "${SHAN}" --out "${N}/out" > "${N}/stdout" 2> "${N}/stderr"; RC=$?
FN="${N}/out/metrics-${HOY}-MiRepo-adhoc-${SHAN:0:7}.json"
[ "${RC}" = "0" ] && [ -f "${FN}" ] \
  && ok "T12 el archivo se llama como el repo del remoto (MiRepo), no como la carpeta (clon-descartable)" || bad "T12 nombre por remoto" "rc=${RC} · $(ls "${N}/out") · $(head -c 300 "${N}/stderr")"
[ -f "${FN}" ] && node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(/clon-descartable$/.test(d.repo) ? 0 : 1)' "${FN}" \
  && ok "T12 el campo repo sigue siendo la RUTA del clon (el gate empareja por ella)" || bad "T12 campo repo" "$(head -c 300 "${FN}" 2>/dev/null)"

# T10 — no-regresión, la parte que la suite puede sostener todas las noches: la serie del dashboard
#       REAL del arnés corre con la ventana de la story. El `git diff --stat` de los archivos protegidos se
#       verifica una vez contra la base de la corrida (evidencia DoD): en main no tiene contra qué comparar.
node "${RAIZ}/scripts/lib/dashboard-series.js" --since 2026-09-01 --json > "${BASE}/serie-real.json" 2> "${BASE}/serie-real.err"
RC=$?
[ "${RC}" = "0" ] && node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(s.counts && s.series ? 0 : 1)' "${BASE}/serie-real.json" \
  && ok "T10 dashboard-series.js --since 2026-09-01 corre sobre el .dashboard/ real del arnés" || bad "T10 serie real" "rc=${RC} · $(head -c 300 "${BASE}/serie-real.err")"

# ── T8 · los dos textos de agent-skills ──────────────────────────────────────────────────────────
SKILL="${AS_DIR}/skills/tycon-merge-to-main/SKILL.md"
STEP8="${AS_DIR}/skills/tycon-pipeline/steps/step-11-prepare-commit.md"
if [ ! -f "${SKILL}" ] || [ ! -f "${STEP8}" ]; then
  echo "⏭️  T8 salteado: esta máquina no tiene agent-skills en ${AS_DIR} (no es verde: no se midió)"
else
  R="$(SKILL="${SKILL}" STEP8="${STEP8}" RENAMES="${RAIZ}/scripts/lib/renames.json" node -e '
    const fs = require("fs"); const s = fs.readFileSync(process.env.SKILL, "utf8"); const p = fs.readFileSync(process.env.STEP8, "utf8");
    const i = s.indexOf("**10b"); const b = i < 0 ? "" : s.slice(i, (s.indexOf("\n## ", i) + 1 || s.length + 1) - 1);
    const j = p.indexOf("## Post-commit"); const pc = j < 0 ? "" : p.slice(j, (p.indexOf("\n## ", j + 3) + 1 || p.length + 1) - 1);
    const faltan = [];
    // `--judge` (story 8.9, tanda B3a); agent-skills puede seguir con el nombre viejo hasta la B3b —referencia entre
    // repos—: el viejo sale del mapa, nunca escrito acá
    const viejo = (JSON.parse(fs.readFileSync(process.env.RENAMES, "utf8")).entries.find((e) => e.kind === "option" && e.new === "judge" && e.where === "scripts/hooks/retro-pending.js") || {}).old;
    if (!b.includes("--judge") && !(viejo && b.includes("--" + viejo))) faltan.push("10b sin «--judge»");
    // el script del latido: agent-skills lo nombra con el nombre viejo hasta el retiro (referencia entre repos, tanda C1);
    // el viejo sale del mapa, nunca escrito acá
    const latidoViejo = ((JSON.parse(fs.readFileSync(process.env.RENAMES, "utf8")).entries.find((e) => e.kind === "file" && e.new === "scripts/metrics/retro-heartbeat.js") || {}).old || "").split("/").pop();
    if (!b.includes("retro-heartbeat.js") && !(latidoViejo && b.includes(latidoViejo))) faltan.push("10b sin «retro-heartbeat.js»");
    for (const t of ["latido ausente", "retro con modelo", "chore(retro"]) if (!b.includes(t)) faltan.push("10b sin «" + t + "»");
    if (/Lanzar el agent `tycon-retrospective-capturer` en background/.test(b)) faltan.push("10b todavía lanza el agente por default");
    if (!pc.includes("mem_save")) faltan.push("Post-commit sin mem_save");
    if (!pc.includes("latido")) faltan.push("Post-commit no nombra el latido");
    if (/debería disparar el `tycon-retrospective-capturer`/.test(pc)) faltan.push("Post-commit sigue diciendo que el hook post-merge dispara el capturer");
    console.log(faltan.join(" · "));')"
  [ -z "${R}" ] && ok "T8 el 10b corre --judge y el latido, sin agente salvo «retro con modelo»; el step-08 guarda los aprendizajes al cierre" \
    || bad "T8 textos de agent-skills" "${R}"
fi

# ── T9 · la señal de carril de la fila del punto ciego ────────────────────────────────────────────
# La fila `deep_review_skipped_then_hotfixed` no puede imprimir `0` cuando la pregunta no se puede hacer
# (sus dos señales exigen una story). El latido la publica SIEMPRE en
# null con su motivo, y al lado la señal cruda: cuántos commits del merge entraron fuera del pipeline
# y cuántos no declaran carril. La mutación que lo pone en rojo: publicar un 0, o contar «sin carril»
# como «fuera del pipeline» (son cosas distintas: una es medición, la otra es «no lo sé»).
{
  RCAR="${BASE}/repo-carril"; mkdir -p "${RCAR}"
  git -C "${RCAR}" init -q -b main
  git -C "${RCAR}" config user.email b@b; git -C "${RCAR}" config user.name b
  echo uno > "${RCAR}/a.txt"; git -C "${RCAR}" add -A; git -C "${RCAR}" commit -qm "primero"
  SHA_A="$(git -C "${RCAR}" rev-parse HEAD)"
  echo dos > "${RCAR}/b.txt"; git -C "${RCAR}" add -A; git -C "${RCAR}" commit -qm "segundo"
  SHA_B="$(git -C "${RCAR}" rev-parse HEAD)"
  # el registro por commit del hook: el primero entró por el pipeline, el segundo ad hoc; del tercero
  # (el merge mismo) no hay línea → «sin carril», que NO es lo mismo que «fuera del pipeline».
  mkdir -p "${HOME}/.claude/.tycon-pipeline"
  LEDGER="${HOME}/.claude/.tycon-pipeline/unpushed-commits-sesion-x.jsonl"
  printf '{"ts":"2026-09-18T01:00:00Z","repo":"%s","kind":"commit","sha":"%s","carril":"pipeline","story":"9.9"}\n' "${RCAR}" "${SHA_A}" > "${LEDGER}"
  printf '{"ts":"2026-09-18T01:05:00Z","repo":"%s","kind":"commit","sha":"%s","carril":"adhoc","story":null}\n' "${RCAR}" "${SHA_B}" >> "${LEDGER}"

  correr "${BASE}/out9" --repo "${RCAR}" --merge "${SHA_B}"
  A9="$(ls "${BASE}/out9"/metrics-*.json 2>/dev/null | head -1)"
  if [ -z "${A9}" ]; then bad "T9 el latido no escribió nada" "$(head -c 160 "${BASE}/stderr")"; else
    V9="$(campo "${A9}" 'd.metrics.deep_review_skipped_then_hotfixed.value')"
    [ "${V9}" = "null" ] && ok "T9 · la fila del punto ciego va en null, nunca en 0" \
      || bad "T9 la fila publicó un número" "${V9}"
    F9="$(campo "${A9}" 'd.metrics.deep_review_skipped_then_hotfixed.commits_fuera_del_pipeline')"
    S9="$(campo "${A9}" 'd.metrics.deep_review_skipped_then_hotfixed.commits_sin_carril')"
    [ "${F9}" = "1" ] && ok "T9 · cuenta el commit que entró FUERA del pipeline (adhoc)" \
      || bad "T9 commits_fuera_del_pipeline" "${F9} (esperaba 1)"
    [ "${S9}" = "0" ] && ok "T9 · y el que sí declaró pipeline no se cuenta como fuera" \
      || bad "T9 commits_sin_carril" "${S9} (esperaba 0)"
    R9="$(campo "${A9}" 'd.metrics.deep_review_skipped_then_hotfixed.unavailable_reason')"
    case "${R9}" in *"observación posterior"*) ok "T9 · el motivo dice por qué no hay correlación todavía" ;;
      *) bad "T9 el motivo no explica el null" "${R9}" ;; esac
  fi

  # Sin ninguna línea de carril para ese commit: «sin carril», no «fuera del pipeline».
  rm -f "${LEDGER}"
  correr "${BASE}/out9b" --repo "${RCAR}" --merge "${SHA_B}"
  A9B="$(ls "${BASE}/out9b"/metrics-*.json 2>/dev/null | head -1)"
  if [ -n "${A9B}" ]; then
    F9B="$(campo "${A9B}" 'd.metrics.deep_review_skipped_then_hotfixed.commits_fuera_del_pipeline')"
    S9B="$(campo "${A9B}" 'd.metrics.deep_review_skipped_then_hotfixed.commits_sin_carril')"
    [ "${F9B}" = "0" ] && [ "${S9B}" = "1" ] && ok "T9b · «no lo sé» se cuenta aparte de «entró fuera del pipeline»" \
      || bad "T9b fuera=${F9B} sin_carril=${S9B}" "esperaba 0 y 1"
  else bad "T9b el latido no escribió nada" "$(head -c 160 "${BASE}/stderr")"; fi
}

# ── T20 · un pedido de GitHub hacia la rama principal se anota como uno de Azure, y el latido lo paga ──────────────
# MUTACIÓN que lo pone en rojo: mirar sólo `az repos pr create`: con un repo en GitHub ningún merge por
# pedido deja entrada, y la retrospectiva depende de que alguien se acuerde. Y la otra: anotar contra el repo
# de la sesión lo que no se sabe a qué repo fue (un pendiente que ninguna retrospectiva puede cerrar).
{
  T20="${BASE}/t20"; H20="${T20}/arnes"; P20="${T20}/producto"
  mkdir -p "${H20}/scripts/hooks" "${H20}/scripts/lib" "${H20}/scripts/metrics" "${H20}/.dashboard" "${P20}/.tycon"
  cp "${RAIZ}/scripts/hooks/retro-pending.js" "${H20}/scripts/hooks/"
  cp "${LATIDO}" "${H20}/scripts/metrics/"
  cp "${LIB}" "${RAIZ}/scripts/lib/az-pr.js" "${RAIZ}/scripts/lib/gh-pr.js" "${RAIZ}/scripts/lib/git-target.js" "${RAIZ}/scripts/lib/shell-parse.js" \
     "${RAIZ}/scripts/lib/harness-repo.js" "${RAIZ}/scripts/lib/legacy-names.js" "${RAIZ}/scripts/lib/retro-coverage.js" "${H20}/scripts/lib/"
  G20() { git -C "${P20}" -c user.email=p@example.invalid -c user.name=p "$@"; }
  git init -q -b main "${P20}"
  echo uno > "${P20}/a.txt"; G20 add -A; G20 commit -q -m base
  G20 remote add origin https://github.com/acme/producto.git
  G20 checkout -q -b dev; echo dos > "${P20}/a.txt"; G20 commit -q -am "cambio en dev"
  TIP20="$(G20 rev-parse HEAD)"
  G20 checkout -q -b otra; echo tres > "${P20}/a.txt"; G20 commit -q -am "cambio en otra"
  P20_REAL="$(cd "${P20}" && pwd -P)"
  LED20="${HOME}/.claude/.tycon-pipeline/retro-pending.jsonl"
  # pedir <herramienta> <comando> → corre el hook como lo corre la herramienta; deja rc y stderr
  pedir() {
    rm -f "${LED20}"
    node -e 'process.stdout.write(JSON.stringify({ session_id: "s-t20", tool_name: process.argv[1], cwd: process.argv[2], tool_input: { command: process.argv[3] } }))' "$1" "${P20}" "$2" \
      | node "${H20}/scripts/hooks/retro-pending.js" > "${T20}/stdout" 2> "${T20}/stderr"
    echo $? > "${T20}/rc"
  }
  anotado() { [ -f "${LED20}" ] && grep -q "\"repoPath\":\"${P20_REAL}\"" "${LED20}" && grep -q "\"branch\":\"$1\"" "${LED20}"; }
  callado() { [ ! -f "${LED20}" ] && [ "$(cat "${T20}/rc")" = "0" ]; }
  dicho()   { [ ! -f "${LED20}" ] && [ "$(cat "${T20}/rc")" = "2" ] && grep -q "no pude resolver a qué repo" "${T20}/stderr"; }

  pedir Bash 'gh pr create --base main --head dev --title t --body-file cuerpo.md'
  anotado main && grep -q "\"sha\":\"${TIP20:0:12}\"" "${LED20}" && [ "$(cat "${T20}/rc")" = "2" ] \
    && ok "T20 gh pr create hacia main: anotado con la punta de la rama del pedido (--head), no la de la rama actual" \
    || bad "T20 gh pr create a main" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 200 "${T20}/stderr")"
  # el archivo del latido con ESA punta lo da por cubierto (en modo pedido va la punta de la rama, no el commit de merge)
  node "${H20}/scripts/metrics/retro-heartbeat.js" --repo "${P20}" --merge "${TIP20}" > "${T20}/stdout" 2> "${T20}/stderr"
  REP20="$(node "${H20}/scripts/hooks/retro-pending.js" --report --days 36500 2>&1)"
  echo "${REP20}" | grep '"conRetro": 1' >/dev/null && echo "${REP20}" | grep '"pendientes": 0' >/dev/null \
    && ok "T20 el latido con la punta anotada da el pedido por cubierto" || bad "T20 cobertura" "${REP20}"
  rm -f "${H20}/.dashboard"/metrics-*.json

  # la misma entrega no se anota dos veces
  pedir Bash 'gh pr create --base main --head dev --title t --body b'
  node -e 'process.stdout.write(JSON.stringify({ session_id: "s-t20", tool_name: "Bash", cwd: process.argv[1], tool_input: { command: "gh pr create --base main --head dev --title t --body b" } }))' "${P20}" \
    | node "${H20}/scripts/hooks/retro-pending.js" > /dev/null 2>&1
  [ "$(grep -c . "${LED20}")" = "1" ] && ok "T20 una sola entrada por entrega" || bad "T20 duplicó la entrada" "$(cat "${LED20}")"

  pedir Bash 'gh pr new -B master -t t -b b'
  anotado master && ok "T20 el alias «gh pr new» y la forma corta de la base valen igual" || bad "T20 gh pr new" "$(cat "${LED20}" 2>/dev/null)"
  pedir Bash 'gh pr create --title t --body b'
  anotado main && ok "T20 sin --base cuenta como hacia la rama principal" || bad "T20 sin --base" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  pedir Bash 'gh pr create --base "$DESTINO" --title t --body b'
  anotado main && ok "T20 una base que arma la terminal se anota (de más, nunca de menos)" || bad "T20 base armada" "$(cat "${LED20}" 2>/dev/null)"
  pedir Bash 'gh pr create --repo acme/producto --base main --title t --body b'
  anotado main && ok "T20 con --repo, si es el origin de esa carpeta, se anota" || bad "T20 --repo propio" "$(cat "${LED20}" 2>/dev/null)"
  # RetroPending_RecordsLayerOpenTowardMain @story-8.85 @ac-15: el pedido que abre la capa de plataforma hacia main es
  # una entrega igual que el `gh pr create`; hacia otra rama, no
  pedir Bash "node scripts/lib/platform/platform.js change-request open --repo acme/producto --auto-complete --args '{\"sourceBranch\":\"dev\",\"targetBranch\":\"main\",\"text\":\"t\",\"deleteSourceBranch\":false}'"
  anotado main && grep -q "\"sha\":\"${TIP20:0:12}\"" "${LED20}" && ok "T20 la llamada a la capa hacia main se anota con la punta de su rama" || bad "T20 capa hacia main" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 200 "${T20}/stderr")"
  printf '%s' '{"sourceBranch":"dev","targetBranch":"master","text":"t","deleteSourceBranch":false}' > "${T20}/args.json"
  pedir Bash "node scripts/lib/platform/platform.js change-request open --repo acme/producto --auto-complete --args @${T20}/args.json"
  anotado master && ok "T20 con los argumentos en un archivo (@archivo) se anota igual" || bad "T20 capa con @archivo" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  # la rama escrita como referencia completa (refs/heads/main) es la misma rama: se anota con su nombre corto y con la
  # punta de la rama de origen, también escrita entera
  pedir Bash "node scripts/lib/platform/platform.js change-request open --repo acme/producto --auto-complete --args '{\"sourceBranch\":\"refs/heads/dev\",\"targetBranch\":\"refs/heads/main\",\"text\":\"t\",\"deleteSourceBranch\":false}'"
  anotado main && grep -q "\"sha\":\"${TIP20:0:12}\"" "${LED20}" && ok "T20 la capa hacia refs/heads/main se anota como hacia main" || bad "T20 capa hacia refs/heads/main" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 200 "${T20}/stderr")"
  pedir Bash "node scripts/lib/platform/platform.js change-request open --repo acme/producto --auto-complete --args '{\"sourceBranch\":\"otra\",\"targetBranch\":\"dev\",\"text\":\"t\",\"deleteSourceBranch\":true}'"
  callado && ok "T20 la llamada a la capa hacia otra rama no se anota" || bad "T20 capa hacia dev" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  pedir PowerShell 'gh pr create --base main --head dev --title t --body b'
  anotado main && ok "T20 por la herramienta de PowerShell, igual que por bash" || bad "T20 PowerShell" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"

  pedir Bash 'gh pr create --base dev --title t --body b'
  callado && ok "T20 hacia otra rama no se anota" || bad "T20 otra rama" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  pedir Bash 'gh pr create --base main --title t --body b --dry-run'
  callado && ok "T20 un simulacro no se anota" || bad "T20 simulacro" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  pedir Bash 'gh pr view 5 --json state && gh pr list --base main'
  callado && ok "T20 mirar pedidos no anota nada" || bad "T20 lectura" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  pedir Bash 'git commit -m "después: gh pr create --base main --title t --body b"'
  callado && ok "T20 un pedido MENCIONADO en un texto no es un pedido" || bad "T20 mención" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  # la rama por defecto del remoto no es la principal: sin --base el pedido va a ella, y eso no es una entrega
  G20 update-ref refs/remotes/origin/dev "${TIP20}"; G20 symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/dev
  pedir Bash 'gh pr create --title t --body b'
  callado && ok "T20 sin --base y con otra rama por defecto en el remoto, no se anota" || bad "T20 rama por defecto" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  G20 symbolic-ref --delete refs/remotes/origin/HEAD

  # lo que no se puede ubicar NO se anota contra el repo de la sesión: se dice
  pedir Bash 'cd "$OTRO_REPO" && gh pr create --base main --title t --body b'
  dicho && ok "T20 con un cd a una variable no anota y lo dice" || bad "T20 cd a una variable" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 200 "${T20}/stderr")"
  pedir Bash 'gh pr create --repo acme/otro-repo --base main --title t --body b'
  dicho && ok "T20 con --repo de OTRO repo que el de la carpeta no anota y lo dice" || bad "T20 --repo ajeno" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 200 "${T20}/stderr")"
  pedir Bash 'gh pr create --repo "$REPO" --base main --title t --body b'
  dicho && ok "T20 con un --repo que arma la terminal no anota y lo dice" || bad "T20 --repo armado" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"

  # ── casos de borde ──
  HEAD20="$(G20 rev-parse HEAD)"
  pedir Bash 'gh pr create --help'
  callado && ok "T20 pedir la ayuda de «gh pr create» no es crear un pedido" || bad "T20 --help" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  pedir Bash '"gh" pr create --base main --title t --body b'
  anotado main && ok "T20 un gh escrito entre comillas es el mismo comando" || bad "T20 gh entre comillas" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  pedir Bash 'gh pr -R acme/producto create --base main --title t --body b'
  anotado main && ok "T20 con la opción del repo entre «pr» y «create» se anota igual" || bad "T20 gh pr -R x create" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  pedir Bash 'gh pr create --base main --title t --body b --dry-run=false'
  anotado main && ok "T20 --dry-run=false sí crea el pedido: se anota" || bad "T20 --dry-run=false" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  pedir Bash 'gh pr create --title t --body b --base $(git config una.rama)'
  anotado main && ok "T20 una base en una sustitución sin comillas «no se sabe»: se anota (no pasa por «no vino»)" || bad "T20 base en \$(…)" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  pedir Bash 'GH_REPO=acme/producto gh pr create --base main --title t --body b'
  anotado main && ok "T20 con GH_REPO igual al origin de la carpeta se anota" || bad "T20 GH_REPO propio" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  pedir Bash 'GH_REPO=acme/otro-repo gh pr create --base main --title t --body b'
  dicho && ok "T20 con GH_REPO de otro repo no anota y lo dice" || bad "T20 GH_REPO ajeno" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  # un `cd ~/…` literal es una carpeta que se sabe: la de la persona
  ln -s "${P20}" "${HOME}/producto-t20"
  rm -f "${LED20}"
  node -e 'process.stdout.write(JSON.stringify({ session_id: "s-t20", tool_name: "Bash", cwd: process.argv[1], tool_input: { command: "cd ~/producto-t20 && gh pr create --base main --title t --body b" } }))' "${BASE}" \
    | node "${H20}/scripts/hooks/retro-pending.js" > "${T20}/stdout" 2> "${T20}/stderr"
  echo $? > "${T20}/rc"
  anotado main && ok "T20 un «cd ~/carpeta» antes del pedido se sigue (la carpeta de la persona)" || bad "T20 cd ~/…" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 200 "${T20}/stderr")"
  # un pedido MENCIONADO como argumento de otro programa, sin comillas, no es un pedido — y no dispara el aviso
  for mencion in 'echo gh pr create --base main' 'rg gh pr create docs/' 'git commit -m merge -m gh pr create'; do
    pedir Bash "${mencion}"
    callado && ok "T20 mención sin comillas («${mencion}»): ni anota ni avisa" || bad "T20 mención sin comillas: ${mencion}" "rc=$(cat "${T20}/rc") · $(head -c 160 "${T20}/stderr")"
  done
  # …pero uno que OTRO programa lanza sí corre, y no se sabe desde dónde: se dice
  pedir Bash 'xargs gh pr create --base main --title t --body b'
  dicho && ok "T20 un gh lanzado por otro programa (xargs) no se puede ubicar: se dice" || bad "T20 xargs gh" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  # la base propia de la rama (lo primero que mira gh cuando no hay --base)
  G20 config branch.dev.gh-merge-base otra
  pedir Bash 'gh pr create --head dev --title t --body b'
  callado && ok "T20 sin --base, con otra base propia de la rama (gh-merge-base), no se anota" || bad "T20 gh-merge-base a otra rama" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  G20 config branch.dev.gh-merge-base main
  pedir Bash 'gh pr create --head dev --title t --body b'
  anotado main && grep -q "\"sha\":\"${TIP20:0:12}\"" "${LED20}" && ok "T20 sin --base, con la principal como base propia de la rama, se anota" || bad "T20 gh-merge-base a main" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  G20 config --unset branch.dev.gh-merge-base
  # la punta: la rama de otro dueño no está en este clon, y una que no existe tampoco: vale HEAD
  pedir Bash 'gh pr create --base main --head alguien:dev --title t --body b'
  anotado main && grep -q "\"sha\":\"${HEAD20:0:12}\"" "${LED20}" && ok "T20 con --head dueño:rama la punta anotada es la de HEAD" || bad "T20 --head dueño:rama" "$(cat "${LED20}" 2>/dev/null)"
  pedir Bash 'gh pr create --base main --head no-existe --title t --body b'
  anotado main && grep -q "\"sha\":\"${HEAD20:0:12}\"" "${LED20}" && ok "T20 con una --head que no está en el clon la punta anotada es la de HEAD" || bad "T20 --head inexistente" "$(cat "${LED20}" 2>/dev/null)"
  # …y si sólo está la del remoto (la rama se empujó desde otro clon), vale ésa
  G20 update-ref refs/remotes/origin/solo-remota "${TIP20}"
  pedir Bash 'gh pr create --base main --head solo-remota --title t --body b'
  anotado main && grep -q "\"sha\":\"${TIP20:0:12}\"" "${LED20}" && ok "T20 con una --head que sólo existe en el remoto, la punta es la del remoto" || bad "T20 --head sólo remota" "$(cat "${LED20}" 2>/dev/null)"

  # un repo del arnés sigue sin deber retrospectiva (decide el remoto)
  G20 remote set-url origin https://github.com/acme/el-arnes.git
  rm -f "${LED20}"
  node -e 'process.stdout.write(JSON.stringify({ session_id: "s-t20", tool_name: "Bash", cwd: process.argv[1], tool_input: { command: "gh pr create --base main --title t --body b" } }))' "${P20}" \
    | TYCON_HARNESS_IDENTITIES="https://github.com/acme/el-arnes.git" node "${H20}/scripts/hooks/retro-pending.js" > "${T20}/stdout" 2> "${T20}/stderr"
  echo $? > "${T20}/rc"
  callado && ok "T20 en un repo del arnés no se anota, como hoy" || bad "T20 repo del arnés" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  G20 remote set-url origin https://github.com/acme/producto.git

  # el hook viaja suelto: sin el lector de gh al lado calla, no se cae — y lo de Azure sigue andando
  rm -f "${H20}/scripts/lib/gh-pr.js"
  pedir Bash 'gh pr create --base main --title t --body b'
  callado && ok "T20 sin el lector de gh al lado, calla (el hook viaja suelto)" || bad "T20 sin la librería" "rc=$(cat "${T20}/rc") · $(head -c 200 "${T20}/stderr")"
  # Regla «avisar y no anotar»: la carpeta es un repo de GitHub y el pedido
  # es de Azure — de OTRO repo, que no está clonado cerca. No se sabe de qué repo es: se dice y no se anota contra este.
  # MUTACIÓN que lo pone en rojo: tratar un origin de GitHub como «sin identidad», que deja caer al repo
  # de la carpeta y anota un pendiente que ninguna retrospectiva cierra.
  pedir Bash 'az repos pr create --org https://x --project P --repository R --source-branch dev --target-branch main'
  dicho && grep -q "no pude saber de qué repo es" "${T20}/stderr" && grep -q "github.com" "${T20}/stderr" \
    && ok "T20 un pedido de Azure desde un repo de GitHub no se anota y lo dice (D6)" || bad "T20 Azure desde GitHub" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 300 "${T20}/stderr")"
  pedir Bash 'az repos pr create --repository "$REPO" --source-branch dev --target-branch main'
  dicho && grep -q "no pude saber de qué repo es" "${T20}/stderr" \
    && ok "T20 lo mismo con el --repository en una variable" || bad "T20 Azure desde GitHub, variable" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 300 "${T20}/stderr")"
  pedir Bash 'az repos pr create --source-branch dev --target-branch main'
  dicho && grep -q "no pude saber de qué repo es" "${T20}/stderr" \
    && ok "T20 lo mismo sin --repository" || bad "T20 Azure desde GitHub, sin --repository" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 300 "${T20}/stderr")"
  pedir Bash 'az repos pr create --source-branch dev --target-branch refs/heads/main'
  dicho && grep -q "no pude saber de qué repo es" "${T20}/stderr" \
    && ok "T20 un --target-branch refs/heads/main es hacia main" || bad "T20 Azure hacia refs/heads/main" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 300 "${T20}/stderr")"
  # con algo que no se pudo mirar en el camino (la carpeta de arriba no se lista), el aviso sigue diciendo lo mismo
  chmod 300 "${T20}"
  pedir Bash 'az repos pr create --repository R --source-branch dev --target-branch main'
  chmod 755 "${T20}"
  dicho && grep -q "no pude saber de qué repo es" "${T20}/stderr" && grep -q "github.com" "${T20}/stderr" \
    && ok "T20 con algo que no se pudo mirar, el aviso dice igual que no se sabe de qué repo es" || bad "T20 Azure desde GitHub, con errores" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 300 "${T20}/stderr")"
  # git falla al leer el origin (tope de tiempo, un candado) en un repo que SÍ lo tiene: es «no sé», no «sin origin».
  # MUTACIÓN que lo pone en rojo: creerle al «sin origin» del lector compartido, que deja caer a la carpeta y anota.
  FAKE20="${T20}/git-que-falla"; mkdir -p "${FAKE20}"
  printf '#!/bin/sh\ncase " $* " in *" get-url "*) exit 128 ;; esac\nexec "%s" "$@"\n' "$(command -v git)" > "${FAKE20}/git"
  chmod +x "${FAKE20}/git"
  PATH="${FAKE20}:${PATH}" pedir Bash 'az repos pr create --source-branch dev --target-branch main'
  dicho && grep -q "no pude leer el origin" "${T20}/stderr" \
    && ok "T20 si git no pudo leer el origin, sin --repository: no anota y lo dice" || bad "T20 origin ilegible, sin --repository" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 300 "${T20}/stderr")"
  PATH="${FAKE20}:${PATH}" pedir Bash 'az repos pr create --repository R --source-branch dev --target-branch main'
  dicho && ok "T20 si git no pudo leer el origin, con --repository: no anota y lo dice" || bad "T20 origin ilegible, con --repository" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null) · $(head -c 300 "${T20}/stderr")"
  # sin origin no hay identidad que contradiga al comando: vale la carpeta (los casos del banco)
  G20 remote remove origin
  pedir Bash 'az repos pr create --org https://x --project P --repository R --source-branch dev --target-branch main'
  anotado main && ok "T20 en un repo sin origin, el pedido de Azure se sigue anotando contra la carpeta" || bad "T20 Azure sin origin" "rc=$(cat "${T20}/rc") · $(cat "${LED20}" 2>/dev/null)"
  G20 remote add origin https://github.com/acme/producto.git
  rm -f "${LED20}"
}

echo
if [ "${fallos}" -eq 0 ]; then echo "retro-latido: todo verde"; exit 0; fi
echo "retro-latido: ${fallos} fallo(s)"; exit 1
