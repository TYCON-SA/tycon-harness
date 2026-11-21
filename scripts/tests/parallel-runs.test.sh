#!/usr/bin/env bash
# parallel-runs.test.sh — una corrida, una carpeta.
#
# Por qué existe: dos corridas de una misma story (otra tanda, o la misma story reabierta) compartían la carpeta
# `.advisors/pipeline-runs/<clave>-<sello>/`: la segunda pisaba el `findings.json` y el `review-roster.json` de la primera,
# y la constancia de la primera desaparecía. Cada corrida tiene ahora su carpeta, anotada en el marcador (`runDir`), y
# todo lo que pide la carpeta de esa story recibe la del marcador.
#
# Lo que prueba (todo con los comandos reales sobre repos de juguete, el estado del arnés en una casa temporal):
#   T1  `start` con una carpeta vieja de la story crea la suya, la anota en el marcador y no toca la vieja
#   T2  con `runDir` en el marcador, run-dir, findings-status, write-findings, el registro de revisores y la función con
#       cada forma de pedir (marcador pasado, sesión, ambiente, otra sesión, otro repo) dan la del marcador
#   T3  la segunda corrida escribe sus hallazgos y cierra su ronda sin tocar los dos archivos de la primera
#   T4  un marcador sin `runDir` usa la carpeta de su apertura; sin apertura válida, la regla sin marcador y el motivo
#   T5  `adopt-session` y `start` re-corrido conservan la carpeta, sin PIPE-C5 ni carpetas nuevas
#   T6  `set --replace` con otra story no hereda el `runDir`
#   T7  otra sesión de la misma story en otra copia y otra rama no pausa; queda `parallelWith`
#   T8  la misma copia, o la misma rama en otra copia, pausa por PIPE-C0
#   T9  el marcador propio de otra story con pasos hechos pausa (PIPE-C4) sin tocar su `runDir`
#   T10 `set` directo con otra story viva se niega; con `--replace` reemplaza y deja la copia
#   T11 la copia de la otra sesión borrada, o sin git, pausa y dice que no leyó la rama
#   T12 `write-findings` sin marcador no reemplaza un `findings.json` sin `--run-dir`
#   T13 sin clave calculable, o sin permiso de escritura, `start` pausa y no escribe el marcador
#   T14 una story de una sola corrida queda como hoy, y las carpetas viejas siguen en disco
#   T15 un marcador de otra story sin pasos no frena; un `set` de la misma story no pide `--replace`
#   T16 sin marcador, gana la carpeta del sello más nuevo aunque las fechas de los archivos digan otra cosa
#   T17 el portón valida cada `findings.json` contra el registro de revisores de SU carpeta
#
# 🔴 HOME falso siempre: los marcadores, gates.log y el registro de revisores viven bajo la casa.
# Correr: bash scripts/tests/parallel-runs.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SK="$AQUI/skills/tycon-pipeline/scripts"
CI="$AQUI/scripts/ci/tycon-ci-gate.js"
TMP="$(mktemp -d)"; trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ ejecución: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ ejecución: $1"; fallos=$((fallos+1)); }

command -v node >/dev/null || { echo "❌ ejecución: sin node no se puede medir nada"; exit 1; }
command -v git >/dev/null || { echo "❌ ejecución: sin git no se puede armar un repo de prueba"; exit 1; }
unset NODE_TEST_CONTEXT TYCON_EVIDENCE_KEY CLAUDE_CODE_SESSION_ID TYCON_SESSION_ID CODEX_SESSION_ID

export HOME="$TMP/casa"; export USERPROFILE="$HOME"; mkdir -p "$HOME/.claude"
# el lugar de las skills que deja el instalador, apuntando al árbol que se mide: `start` corre su marker.js
ln -s "$AQUI" "$HOME/.claude/agent-skills"
export TYCON_AUTO_SNAPSHOT=0 TYCON_PIPELINE_NO_AUTONOMOUS=1
ST="$(node -e 'process.stdout.write(require(process.argv[1]).stateDir(process.argv[2]))' "$SK/lib/state-dir.js" "$HOME")"
mkdir -p "$ST/active"

# story <ruta> <id> [estado] — una story mínima con un AC cubierto por una fila de la tabla de tests.
story(){
  mkdir -p "$(dirname "$1")"
  printf -- '---\nepic: 1\nstory: "%s"\ntitle: "story de prueba %s"\nstatus: %s\n---\n\n# Story %s\n\n## Acceptance Criteria\n\n1. **Given** algo **When** pasa **Then** resultado.\n\n### Tests\n\n| # | Test | AC | Nivel | Escenario | Resultado esperado |\n|---|------|----|-------|-----------|--------------------|\n| T1 | `Caso1` | 1 | integration | x | y |\n' \
    "$2" "$2" "${3:-ready-for-dev}" "$2" > "$1"
}
# mundo <nombre> [rama] — un repo git propio, con la story de prueba commiteada; imprime la ruta del repo. Cada mundo
# arranca sin marcadores vivos: todos tienen la misma story en la misma ruta, y dos copias de una story con la misma ruta
# son, para PIPE-C0, la misma story.
mundo(){
  rm -f "$ST/active/"*.json
  local r="$TMP/$1/repo"; mkdir -p "$r/.advisors/pipeline-runs"
  git -C "$r" init -q -b "${2:-trabajo}"; git -C "$r" config user.email prueba@ejemplo.invalid; git -C "$r" config user.name prueba
  story "$r/specs/1-9-x.md" 1.9
  git -C "$r" add -A
  GIT_AUTHOR_DATE='2026-10-01T00:00:00Z' GIT_COMMITTER_DATE='2026-10-01T00:00:00Z' git -C "$r" -c maintenance.auto=false commit -qm base
  echo "$r"
}
# corrida <repo> <nombre> <hallazgos> [revisor] — una carpeta de corrida con su findings.json y su registro de revisores.
corrida(){
  local d="$1/.advisors/pipeline-runs/$2"; mkdir -p "$d"
  node -e '
    const [d, n, rev] = process.argv.slice(1); const fs = require("fs");
    const h = Array.from({ length: Number(n) }, (_, i) => ({ rule_id: "R" + i, severity: "warning", advisor: rev, file: "x.js", disposition: "fixed", reason: "r" + i }));
    fs.writeFileSync(d + "/findings.json", JSON.stringify(h, null, 2));
    fs.writeFileSync(d + "/review-roster.json", JSON.stringify({ version: 1, implementer: { kind: "sesion-principal", session_id: "impl" }, reviewers: [{ agent: rev, kind: "subagente" }] }, null, 2));
  ' "$d" "$3" "${4:-rev-a}"
}
# arrancar <sesión> <repo> <story> [más args] — `pipeline.js start`; imprime «ready=<bool> pausas=<ids>» y deja el JSON.
arrancar(){
  local sid="$1" repo="$2" st="$3"; shift 3
  (cd "$repo" && CLAUDE_CODE_SESSION_ID="$sid" node "$SK/pipeline.js" start --story "$st" --repo "$repo" --no-autonomous "$@" 2>"$TMP/start-$sid.err") > "$TMP/start-$sid.json"
  node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log("ready="+j.ready+" pausas="+(j.pauses||[]).map(p=>p.id).join(","))}catch(e){console.log("no-json")}' "$TMP/start-$sid.json"
}
# campo <sesión> <campo> — el campo del marcador de esa sesión, en JSON («null» si no hay).
campo(){ node -e 'const fs=require("fs");try{const m=JSON.parse(fs.readFileSync(process.argv[1]+"/active/"+process.argv[2]+".json","utf8"));console.log(JSON.stringify(m[process.argv[3]]===undefined?null:m[process.argv[3]]))}catch(e){console.log("null")}' "$ST" "$1" "$2"; }
# marcador <sesión> <json> — un marcador escrito a mano (lo que deja un arranque anterior a este cambio, o `set`).
marcador(){ printf '%s\n' "$2" > "$ST/active/$1.json"; }
carpetas(){ ls -1 "$1/.advisors/pipeline-runs" 2>/dev/null | grep -c . ; }
# esencia <sesión> — lo que dice el marcador de su corrida (la historia, su carpeta y sus pasos), sin el formato del archivo
esencia(){ node -e 'try{const m=JSON.parse(require("fs").readFileSync(process.argv[1]+"/active/"+process.argv[2]+".json","utf8"));console.log(JSON.stringify([m.storyId,m.runDir,m.stepsCompleted]))}catch(e){console.log("falta")}' "$ST" "$1"; }
huella(){ node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1" 2>/dev/null || echo falta; }
hallazgos(){ node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)}catch(e){console.log("ilegible")}' "$1"; }
# cerrarRonda <sesión> <repo> <revisor> — la ronda de revisores de esa sesión se completa con el lanzamiento real.
cerrarRonda(){
  mkdir -p "$ST/advisor-runs"
  printf '{"event":"step5-start","iter":1,"expected":["%s"]}\n' "$3" >> "$ST/advisor-runs/$1.jsonl"
  (cd "$2" && node -e 'require(process.argv[1]).recordLaunch({ advisor: process.argv[2], sessionId: process.argv[3], cwd: process.argv[4] })' "$SK/on-advisor-run.js" "$3" "$1" "$2" 2>/dev/null)
  # lo que contestó el revisor, como lo anota el gancho del fin del subagente: un revisor lanzado sin reporte frena write-findings
  local tr="$TMP/revisor-$1-$3.jsonl"
  printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Sin hallazgos.\nVeredicto: limpio"}]}}' > "$tr"
  (cd "$2" && printf '{"hook_event_name":"SubagentStop","session_id":"%s","agent_id":"ag-%s","agent_type":"%s","agent_transcript_path":"%s"}' "$1" "$1" "$3" "$tr" \
    | node "$SK/on-advisor-done.js" >/dev/null 2>&1)
}
VIEJA=1.9-20261001000000

# ── T1 — `start` crea su carpeta y la anota ─────────────────────────────────────────────────────────
M1="$(mundo m1)"; corrida "$M1" "$VIEJA" 3; h1="$(huella "$M1/.advisors/pipeline-runs/$VIEJA/findings.json")"
r1="$(arrancar s1 "$M1" "$M1/specs/1-9-x.md")"; rd1="$(campo s1 runDir)"; f1=""
[[ "$r1" == ready=true* ]] || f1="$f1 start($r1)"
case "$rd1" in *"/.advisors/pipeline-runs/1.9-"*) ;; *) f1="$f1 runDir-en-el-marcador($rd1)";; esac
[[ "$rd1" != *"$VIEJA"* ]] || f1="$f1 reusó-la-vieja"
[ "$(carpetas "$M1")" = 2 ] || f1="$f1 carpetas($(carpetas "$M1"), esperaba 2)"
[ "$(huella "$M1/.advisors/pipeline-runs/$VIEJA/findings.json")" = "$h1" ] || f1="$f1 tocó-la-vieja"
if [ -z "$f1" ]; then ok "T1 Start_CreatesOwnRunDir"; else no "T1 Start_CreatesOwnRunDir —$f1"; fi

# ── T2 — todos los que piden la carpeta reciben la del marcador ────────────────────────────────────
OTRO2="$(mundo m2b)"; corrida "$OTRO2" 1.9-20261003000000 1
M2="$(mundo m2)"; S2="$M2/specs/1-9-x.md"; A2="$M2/.advisors/pipeline-runs/$VIEJA"; B2="$M2/.advisors/pipeline-runs/1.9-20261002000000"
corrida "$M2" "$VIEJA" 1; corrida "$M2" 1.9-20261002000000 4; hb2="$(huella "$B2/findings.json")"
marcador s2 "{\"sessionId\":\"s2\",\"storyId\":\"1.9\",\"storyPath\":\"$S2\",\"repoPath\":\"$M2\",\"runDir\":\"$A2\",\"stepScheme\":2,\"stepsCompleted\":[\"start\"]}"
f2=""
o2="$(cd "$M2" && CLAUDE_CODE_SESSION_ID=s2 node "$SK/pipeline.js" run-dir --story "$S2" --repo "$M2" 2>/dev/null)"
[ "$o2" = "$A2" ] || f2="$f2 run-dir($o2)"
o2="$(cd "$M2" && CLAUDE_CODE_SESSION_ID=s2 node "$SK/pipeline.js" findings-status --story "$S2" --repo "$M2" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).run_dir)}catch(e){console.log("no-json")}})')"
[ "$o2" = "$A2" ] || f2="$f2 findings-status($o2)"
printf '[{"rule_id":"N1","severity":"warning","advisor":"rev-a","file":"x.js","disposition":"fixed","reason":"nuevo"},{"rule_id":"N2","severity":"warning","advisor":"rev-a","file":"x.js","disposition":"fixed","reason":"nuevo"}]\n' > "$TMP/h2.json"
(cd "$M2" && CLAUDE_CODE_SESSION_ID=s2 node "$SK/pipeline.js" write-findings --story "$S2" --repo "$M2" --findings "$TMP/h2.json" >/dev/null 2>&1)
[ "$(hallazgos "$A2/findings.json")" = 2 ] || f2="$f2 write-findings(la del marcador tiene $(hallazgos "$A2/findings.json"))"
[ "$(huella "$B2/findings.json")" = "$hb2" ] || f2="$f2 write-findings(tocó la más nueva)"
rm -f "$A2/review-roster.json"; cerrarRonda s2 "$M2" rev-a
[ -f "$A2/review-roster.json" ] || f2="$f2 registro-de-revisores(no lo escribió en la del marcador)"
# la función, con cada forma de pedir: el marcador en la mano, la sesión, el ambiente, otra sesión, otro repo
o2="$(CLAUDE_CODE_SESSION_ID=otra node -e '
  const [sk, st, repo, otro, story] = process.argv.slice(1); const p = require(sk + "/pipeline.js"), fs = require("fs");
  const m = JSON.parse(fs.readFileSync(st + "/active/s2.json", "utf8")); const b = (x) => require("path").basename(x || "null");
  console.log([b(p.resolveRunDir(repo, "1.9", false, story, { marker: m })), b(p.resolveRunDir(repo, "1.9", false, story, { sessionId: "s2" })),
    b(p.resolveRunDir(otro, "1.9", false, otro + "/specs/1-9-x.md", { marker: m }))].join(" "));
' "$SK" "$ST" "$M2" "$OTRO2" "$S2" 2>/dev/null)"
[ "$o2" = "$VIEJA $VIEJA 1.9-20261003000000" ] || f2="$f2 resolveRunDir(marcador sesión otro-repo: $o2)"
o2="$(CLAUDE_CODE_SESSION_ID=s2 node -e 'console.log(require("path").basename(require(process.argv[1] + "/pipeline.js").resolveRunDir(process.argv[2], "1.9", false, process.argv[3]) || "null"))' "$SK" "$M2" "$S2" 2>/dev/null)"
[ "$o2" = "$VIEJA" ] || f2="$f2 resolveRunDir(ambiente: $o2)"
if [ -z "$f2" ]; then ok "T2 Resolvers_PreferMarkerRunDir"; else no "T2 Resolvers_PreferMarkerRunDir —$f2"; fi

# ── T3 — la segunda corrida no toca la primera ──────────────────────────────────────────────────────
M3="$(mundo m3)"; S3="$M3/specs/1-9-x.md"; A3="$M3/.advisors/pipeline-runs/$VIEJA"
corrida "$M3" "$VIEJA" 3; hf3="$(huella "$A3/findings.json")"; hr3="$(huella "$A3/review-roster.json")"
r3="$(arrancar s3 "$M3" "$S3")"; rd3="$(campo s3 runDir | tr -d '"')"
(cd "$M3" && CLAUDE_CODE_SESSION_ID=s3 node "$SK/pipeline.js" write-findings --story "$S3" --repo "$M3" --findings "$TMP/h2.json" >/dev/null 2>&1)
cerrarRonda s3 "$M3" rev-a
f3=""
[ "$(huella "$A3/findings.json")" = "$hf3" ] || f3="$f3 findings-de-la-primera(quedó en $(hallazgos "$A3/findings.json"))"
[ "$(huella "$A3/review-roster.json")" = "$hr3" ] || f3="$f3 registro-de-la-primera(cambió)"
[ "$rd3" != "$A3" ] && [ "$(hallazgos "$rd3/findings.json" 2>/dev/null)" = 2 ] || f3="$f3 findings-de-la-segunda($rd3)"
[ -f "$rd3/review-roster.json" ] || f3="$f3 registro-de-la-segunda(falta)"
if [ -z "$f3" ]; then ok "T3 SecondRun_DoesNotTouchFirst"; else no "T3 SecondRun_DoesNotTouchFirst —$f3"; fi

# ── T4 — un marcador sin `runDir` usa la carpeta de su apertura ─────────────────────────────────────
M4="$(mundo m4)"; S4="$M4/specs/1-9-x.md"; A4="$M4/.advisors/pipeline-runs/1.9-20261005115959"
corrida "$M4" 1.9-20261005115959 1; corrida "$M4" 1.9-20261006000000 1
marcador s4 "{\"sessionId\":\"s4\",\"storyId\":\"1.9\",\"storyPath\":\"$S4\",\"repoPath\":\"$M4\",\"stepScheme\":2,\"startedAt\":\"2026-10-05T12:00:00.000Z\",\"stepsCompleted\":[\"start\"]}"
printf '{"ts":"2026-10-05T12:00:00.000Z","sessionId":"s4","name":"run-open","sesion":"s4","story":"1.9","storyPath":"%s","repo":"%s","runDir":"%s"}\n' "$S4" "$M4" "$A4" >> "$ST/gates.log"
pide4(){ CLAUDE_CODE_SESSION_ID=s4 node -e 'console.log(require("path").basename(require(process.argv[1] + "/pipeline.js").resolveRunDir(process.argv[2], "1.9", true, process.argv[3]) || "null"))' "$SK" "$M4" "$S4" 2>"$TMP/t4.err"; }
f4=""; o4="$(pide4)"
[ "$o4" = 1.9-20261005115959 ] || f4="$f4 con-apertura($o4)"
[ "$(campo s4 runDir)" = null ] || f4="$f4 escribió-el-marcador"
# la apertura de otra story no cuenta: cae a la regla sin marcador y lo dice
printf '{"ts":"2026-10-05T12:01:00.000Z","sessionId":"s4","name":"run-open","sesion":"s4","story":"2.1","runDir":"%s"}\n' "$A4" >> "$ST/gates.log"
o4="$(pide4)"
[ "$o4" = 1.9-20261006000000 ] || f4="$f4 apertura-de-otra-story($o4)"
grep -qi "apertura" "$TMP/t4.err" || f4="$f4 sin-motivo-en-stderr"
# un cierre no es una apertura
printf '{"ts":"2026-10-05T12:02:00.000Z","sessionId":"s4","name":"run-close","sesion":"s4","story":"1.9","runDir":"%s"}\n' "$A4" >> "$ST/gates.log"
o4="$(pide4)"
[ "$o4" = 1.9-20261006000000 ] || f4="$f4 cierre($o4)"
[ "$(carpetas "$M4")" = 2 ] || f4="$f4 creó-carpetas($(carpetas "$M4"))"
# un marcador que no se lee no es «sin marcador» callado: la regla sigue y lo dice
printf '{roto' > "$ST/active/s4.json"
o4="$(pide4)"
grep -qi "no se puede leer\|no es un JSON" "$TMP/t4.err" || f4="$f4 marcador-ilegible(no lo dijo)"
if [ -z "$f4" ]; then ok "T4 MarkerWithoutRunDir_UsesItsOpening"; else no "T4 MarkerWithoutRunDir_UsesItsOpening —$f4"; fi

# ── T5 — retomar conserva la carpeta ────────────────────────────────────────────────────────────────
M5="$(mundo m5)"; S5="$M5/specs/1-9-x.md"
r5="$(arrancar s5 "$M5" "$S5")"; rd5="$(campo s5 runDir)"; n5="$(carpetas "$M5")"; f5=""
r5b="$(arrancar s5 "$M5" "$S5")"
[[ "$r5b" == ready=true* ]] || f5="$f5 start-re-corrido($r5b)"
[ "$(campo s5 runDir)" = "$rd5" ] || f5="$f5 runDir-cambió"
# un marcador sin `runDir` (de antes de este cambio): el `start` re-corrido lo anota desde la apertura
node -e 'const fs=require("fs"),f=process.argv[1];const m=JSON.parse(fs.readFileSync(f,"utf8"));delete m.runDir;fs.writeFileSync(f,JSON.stringify(m))' "$ST/active/s5.json"
r5c="$(arrancar s5 "$M5" "$S5")"
[ "$(campo s5 runDir)" = "$rd5" ] || f5="$f5 sin-runDir($r5c, $(campo s5 runDir))"
[ "$(carpetas "$M5")" = "$n5" ] || f5="$f5 carpetas-sin-runDir($(carpetas "$M5"))"
# y otra sesión que la retoma
(cd "$M5" && CLAUDE_CODE_SESSION_ID=s5b node "$SK/marker.js" adopt-session s5 >/dev/null 2>&1)
[ "$(campo s5b runDir)" = "$rd5" ] || f5="$f5 adopt-session($(campo s5b runDir))"
[ "$(carpetas "$M5")" = "$n5" ] || f5="$f5 carpetas($n5 → $(carpetas "$M5"))"
if [ -z "$f5" ]; then ok "T5 Resume_KeepsRunDir"; else no "T5 Resume_KeepsRunDir —$f5"; fi

# ── T6 — otra story no hereda la carpeta ────────────────────────────────────────────────────────────
M6="$(mundo m6)"; story "$M6/specs/2-1-y.md" 2.1
marcador s6 "{\"sessionId\":\"s6\",\"storyId\":\"1.9\",\"storyPath\":\"$M6/specs/1-9-x.md\",\"repoPath\":\"$M6\",\"runDir\":\"$M6/.advisors/pipeline-runs/$VIEJA\",\"stepScheme\":2,\"stepsCompleted\":[\"start\"]}"
(cd "$M6" && CLAUDE_CODE_SESSION_ID=s6 node "$SK/marker.js" set "{\"storyId\":\"2.1\",\"storyPath\":\"$M6/specs/2-1-y.md\",\"repoPath\":\"$M6\"}" --replace >/dev/null 2>&1)
if [ "$(campo s6 storyId)" = '"2.1"' ] && [ "$(campo s6 runDir)" = null ]; then ok "T6 StoryChange_ResetsRunDir"
else no "T6 StoryChange_ResetsRunDir — storyId $(campo s6 storyId), runDir $(campo s6 runDir)"; fi

# ── T7 / T8 — otra copia, otra rama ─────────────────────────────────────────────────────────────────
M7="$(mundo m7)"; r7a="$(arrancar s7a "$M7" "$M7/specs/1-9-x.md")"
C7="$TMP/m7/otra-copia"; git clone -q "$M7" "$C7"; git -C "$C7" checkout -qb otra-rama
story "$C7/specs/1-9-x.md" 1.9 in-progress
r7="$(arrancar s7b "$C7" "$C7/specs/1-9-x.md")"; pw7="$(campo s7b parallelWith)"; f7=""
[ "$r7" = "ready=true pausas=" ] || f7="$f7 start($r7)"
case "$pw7" in *'"sessionId":"s7a"'*'"branch":"trabajo"'*|*'"branch":"trabajo"'*'"sessionId":"s7a"'*) ;; *) f7="$f7 parallelWith($pw7)";; esac
grep -q "s7a" "$TMP/start-s7b.json" || f7="$f7 sin-línea-en-actions_done"
if [ -z "$f7" ]; then ok "T7 OtherBatch_OtherCloneOtherBranch_NoPause"; else no "T7 OtherBatch_OtherCloneOtherBranch_NoPause —$f7"; fi

f8=""; r8="$(arrancar s8a "$M7" "$M7/specs/1-9-x.md")"
[[ "$r8" == *PIPE-C0-cross-session* ]] || f8="$f8 misma-copia($r8)"
C8="$TMP/m7/copia-misma-rama"; git clone -q "$M7" "$C8"; story "$C8/specs/1-9-x.md" 1.9 in-progress
r8="$(arrancar s8b "$C8" "$C8/specs/1-9-x.md")"
[[ "$r8" == *PIPE-C0-cross-session* ]] || f8="$f8 misma-rama($r8)"
if [ -z "$f8" ]; then ok "T8 SameCloneOrSameBranch_Pauses"; else no "T8 SameCloneOrSameBranch_Pauses —$f8"; fi

# ── T9 / T10 — la misma sesión con otra story viva ──────────────────────────────────────────────────
M9="$(mundo m9)"; story "$M9/specs/2-1-y.md" 2.1
VIVO9="{\"sessionId\":\"s9\",\"storyId\":\"1.9\",\"storyPath\":\"$M9/specs/1-9-x.md\",\"repoPath\":\"$M9\",\"runDir\":\"$M9/.advisors/pipeline-runs/$VIEJA\",\"stepScheme\":2,\"stepsCompleted\":[\"start\",\"validate-story\"]}"
corrida "$M9" "$VIEJA" 1; marcador s9 "$VIVO9"; h9="$(esencia s9)"
r9="$(arrancar s9 "$M9" "$M9/specs/2-1-y.md")"; f9=""
[[ "$r9" == *PIPE-C4-otra-ejecucion* ]] || f9="$f9 start($r9)"
[ "$(esencia s9)" = "$h9" ] || f9="$f9 tocó-el-marcador($(esencia s9))"
[ "$(carpetas "$M9")" = 1 ] || f9="$f9 carpetas($(carpetas "$M9"))"
if [ -z "$f9" ]; then ok "T9 SameSession_OtherStoryAlive_Pauses"; else no "T9 SameSession_OtherStoryAlive_Pauses —$f9"; fi

f10=""; (cd "$M9" && CLAUDE_CODE_SESSION_ID=s9 node "$SK/marker.js" set "{\"storyId\":\"2.1\",\"storyPath\":\"$M9/specs/2-1-y.md\",\"repoPath\":\"$M9\"}" >/dev/null 2>&1); rc10=$?
[ "$rc10" = 3 ] || f10="$f10 sin-replace(salió $rc10)"
[ "$(esencia s9)" = "$h9" ] || f10="$f10 tocó-el-marcador($(esencia s9))"
(cd "$M9" && CLAUDE_CODE_SESSION_ID=s9 node "$SK/marker.js" set "{\"storyId\":\"2.1\",\"storyPath\":\"$M9/specs/2-1-y.md\",\"repoPath\":\"$M9\"}" --replace >/dev/null 2>&1)
[ "$(campo s9 storyId)" = '"2.1"' ] || f10="$f10 con-replace($(campo s9 storyId))"
ls "$ST/replaced/" 2>/dev/null | grep '^s9-' >/dev/null || f10="$f10 sin-copia"
grep -q '"marker-replace"' "$ST/gates.log" || f10="$f10 sin-marker-replace"
if [ -z "$f10" ]; then ok "T10 Set_OtherStoryAlive_Refuses"; else no "T10 Set_OtherStoryAlive_Refuses —$f10"; fi

# ── T11 — la copia de la otra sesión no se puede leer ───────────────────────────────────────────────
M11="$(mundo m11)"; story "$M11/specs/1-9-x.md" 1.9 in-progress; f11=""
marcador o11 "{\"sessionId\":\"o11\",\"storyId\":\"1.9\",\"storyPath\":\"$TMP/m11/ya-no-esta/specs/1-9-x.md\",\"repoPath\":\"$TMP/m11/ya-no-esta\",\"stepScheme\":2,\"stepsCompleted\":[\"start\"]}"
r11="$(arrancar s11 "$M11" "$M11/specs/1-9-x.md")"
[[ "$r11" == *PIPE-C0-cross-session* ]] || f11="$f11 borrada($r11)"
grep -q "rama" "$TMP/start-s11.json" || f11="$f11 borrada(no dice que no leyó la rama)"
rm -f "$ST/active/o11.json"; SIN11="$TMP/m11/sin-git"; mkdir -p "$SIN11/specs"; story "$SIN11/specs/1-9-x.md" 1.9 in-progress
marcador o11b "{\"sessionId\":\"o11b\",\"storyId\":\"1.9\",\"storyPath\":\"$SIN11/specs/1-9-x.md\",\"repoPath\":\"$SIN11\",\"stepScheme\":2,\"stepsCompleted\":[\"start\"]}"
r11="$(arrancar s11b "$M11" "$M11/specs/1-9-x.md")"
[[ "$r11" == *PIPE-C0-cross-session* ]] || f11="$f11 sin-git($r11)"
grep -q "rama" "$TMP/start-s11b.json" || f11="$f11 sin-git(no dice que no leyó la rama)"
rm -f "$ST/active/o11b.json"
if [ -z "$f11" ]; then ok "T11 OtherSessionUnreadable_Pauses"; else no "T11 OtherSessionUnreadable_Pauses —$f11"; fi

# ── T12 — `write-findings` sin marcador no reemplaza ────────────────────────────────────────────────
M12="$(mundo m12)"; S12="$M12/specs/1-9-x.md"; A12="$M12/.advisors/pipeline-runs/$VIEJA"; corrida "$M12" "$VIEJA" 3; h12="$(huella "$A12/findings.json")"; f12=""
o12="$(cd "$M12" && CLAUDE_CODE_SESSION_ID=sin-marcador node "$SK/pipeline.js" write-findings --story "$S12" --repo "$M12" --findings "$TMP/h2.json" 2>&1)"; rc12=$?
[ "$rc12" != 0 ] || f12="$f12 salió-0"
[ "$(huella "$A12/findings.json")" = "$h12" ] || f12="$f12 lo-reemplazó"
[[ "$o12" == *"$VIEJA"* && "$o12" == *"--run-dir"* ]] || f12="$f12 no-dice-qué-carpeta-ni---run-dir"
(cd "$M12" && CLAUDE_CODE_SESSION_ID=sin-marcador node "$SK/pipeline.js" write-findings --story "$S12" --repo "$M12" --findings "$TMP/h2.json" --run-dir "$A12" >/dev/null 2>&1)
[ "$(hallazgos "$A12/findings.json")" = 2 ] || f12="$f12 con---run-dir(no escribió)"
if [ -z "$f12" ]; then ok "T12 WriteFindings_NoMarker_Refuses"; else no "T12 WriteFindings_NoMarker_Refuses —$f12"; fi

# ── T13 — sin carpeta posible, `start` pausa sin marcador ───────────────────────────────────────────
M13="$(mundo m13)"; f13=""
story "$M13/specs/fuera.md" "../../fuera"
r13="$(arrancar s13 "$M13" "$M13/specs/fuera.md")"
[[ "$r13" == ready=false* ]] || f13="$f13 sin-clave($r13)"
[ ! -f "$ST/active/s13.json" ] || f13="$f13 sin-clave(escribió el marcador)"
chmod a-w "$M13/.advisors/pipeline-runs"
r13="$(arrancar s13b "$M13" "$M13/specs/1-9-x.md")"
chmod u+w "$M13/.advisors/pipeline-runs"
[[ "$r13" == ready=false* ]] || f13="$f13 sin-permiso($r13)"
[ ! -f "$ST/active/s13b.json" ] || f13="$f13 sin-permiso(escribió el marcador)"
if [ -z "$f13" ]; then ok "T13 Start_CannotCreateRunDir_Pauses"; else no "T13 Start_CannotCreateRunDir_Pauses —$f13"; fi

# ── T14 — una sola corrida, como hoy ────────────────────────────────────────────────────────────────
M14="$(mundo m14)"; S14="$M14/specs/1-9-x.md"; mkdir -p "$M14/.advisors/pipeline-runs/1.8-20260901000000"; echo x > "$M14/.advisors/pipeline-runs/1.8-20260901000000/viejo.txt"
r14="$(arrancar s14 "$M14" "$S14")"; rd14="$(campo s14 runDir | tr -d '"')"; f14=""
[[ "$(basename "$rd14")" =~ ^1\.9-[0-9]{14}$ ]] || f14="$f14 nombre($(basename "$rd14"))"
[ -f "$M14/.advisors/pipeline-runs/1.8-20260901000000/viejo.txt" ] || f14="$f14 borró-una-vieja"
corrida "$M14" "$(basename "$rd14")" 0
o14="$(node -e 'const pc=require(process.argv[1]+"/on-pre-commit.js");const r=pc.findAdvisorsEvidence(process.argv[2],"1.9",{storyPath:process.argv[3]});console.log(r.found?"ok":"no")' "$SK" "$M14" "$S14" 2>/dev/null)"
[ "$o14" = ok ] || f14="$f14 on-pre-commit($o14)"
if [ -z "$f14" ]; then ok "T14 SingleRun_Unchanged"; else no "T14 SingleRun_Unchanged —$f14"; fi

# ── T15 — lo terminado no frena ─────────────────────────────────────────────────────────────────────
M15="$(mundo m15)"; story "$M15/specs/2-1-y.md" 2.1; f15=""
marcador s15 "{\"sessionId\":\"s15\",\"storyId\":\"2.1\",\"storyPath\":\"$M15/specs/2-1-y.md\",\"repoPath\":\"$M15\",\"stepScheme\":2,\"stepsCompleted\":[]}"
r15="$(arrancar s15 "$M15" "$M15/specs/1-9-x.md")"
[[ "$r15" == ready=true* ]] || f15="$f15 start($r15)"
(cd "$M15" && CLAUDE_CODE_SESSION_ID=s15 node "$SK/marker.js" set "{\"storyId\":\"1.9\",\"storyPath\":\"$M15/specs/1-9-x.md\",\"repoPath\":\"$M15\"}" >/dev/null 2>&1); rc15=$?
[ "$rc15" = 0 ] || f15="$f15 set-de-la-misma(salió $rc15)"
if [ -z "$f15" ]; then ok "T15 FinishedMarker_DoesNotBlock"; else no "T15 FinishedMarker_DoesNotBlock —$f15"; fi

# ── T16 — sin marcador, el sello del nombre manda ───────────────────────────────────────────────────
M16="$(mundo m16)"; corrida "$M16" 1.9-20261001000000 1; corrida "$M16" 1.9-20261002000000 1
# las fechas de los archivos, al revés del sello: la carpeta vieja parece la más nueva
touch -t 202601010000 "$M16/.advisors/pipeline-runs/1.9-20261002000000/"*; touch -t 202612310000 "$M16/.advisors/pipeline-runs/1.9-20261001000000/"*
o16="$(CLAUDE_CODE_SESSION_ID=sin-marcador node -e 'console.log(require("path").basename(require(process.argv[1] + "/pipeline.js").resolveRunDir(process.argv[2], "1.9", false, process.argv[3]) || "null"))' "$SK" "$M16" "$M16/specs/1-9-x.md" 2>/dev/null)"
f16=""; [ "$o16" = 1.9-20261002000000 ] || f16="$f16 sello-manda($o16)"
# tres arranques seguidos: la carpeta con sufijo lleva el MISMO sello que la que chocó (no uno de un segundo después),
# y una carpeta que todavía no existe bajo un repo nombrado por un enlace (/var → /private/var en macOS) es de ese repo
o16="$(node -e '
  const [sk, repo, story] = process.argv.slice(1); const rd = require(sk + "/lib/run-dir.js"), path = require("path");
  const n = [0, 1, 2].map(() => path.basename(rd.createRunDir(repo, "1.9", story)));
  const sellos = new Set(n.map((x) => (/-(\d{14})/.exec(x) || [])[1]));
  const sufijos = n.slice(1).every((x) => x.startsWith(n[0]) || /-\d{14}$/.test(x));
  console.log((sellos.size === 1 || sufijos ? "sello-ok" : "sello-distinto:" + n.join(",")) + " "
    + (rd.bajoElRepo(path.join(repo, ".advisors", "pipeline-runs", "1.9-29990101000000"), repo) ? "enlace-ok" : "enlace-no"));
' "$SK" "$M16" "$M16/specs/1-9-x.md" 2>&1 | tail -1)"
[ "$o16" = "sello-ok enlace-ok" ] || f16="$f16 $o16"
# una carpeta de corridas que está y no se lee no es «ninguna»: no se abre otra a ciegas, y se dice
chmod 000 "$M16/.advisors/pipeline-runs"
o16="$(CLAUDE_CODE_SESSION_ID=sin-marcador node -e 'console.log(String(require(process.argv[1] + "/pipeline.js").resolveRunDir(process.argv[2], "1.9", true, process.argv[3])))' "$SK" "$M16" "$M16/specs/1-9-x.md" 2>"$TMP/t16.err")"
chmod 755 "$M16/.advisors/pipeline-runs"
[ "$o16" = null ] || f16="$f16 ilegible-abre($o16)"
grep "no puedo leer" "$TMP/t16.err" >/dev/null || f16="$f16 ilegible-sin-aviso"
if [ -z "$f16" ]; then ok "T16 NoMarker_StableChoice"; else no "T16 NoMarker_StableChoice —$f16"; fi

# ── T17 — el portón mira cada carpeta con su registro ───────────────────────────────────────────────
M17="$(mundo m17)"; corrida "$M17" 1.9-20261001000000 2 rev-solo-en-la-primera; corrida "$M17" 1.9-20261002000000 1 rev-a
o17="$(node -e '
  const [ci, repo, story] = process.argv.slice(1); const g = require(ci), fs = require("fs");
  const dirs = g.runDirsDeStory(repo, "1.9", story); const out = [];
  for (const { dir } of dirs) {
    const v = g.validarRoster(JSON.parse(fs.readFileSync(dir + "/review-roster.json", "utf8")), g.advisoresEnFindings(dir));
    out.push(v.problemas.some((p) => p.regla === "roster-incoherente") ? "incoherente" : "ok");
  }
  // la prueba puede fallar: el registro de una carpeta contra los hallazgos de la otra sí es incoherente
  const [a, b] = dirs.map((d) => d.dir).sort();
  const cruzado = g.validarRoster(JSON.parse(fs.readFileSync(b + "/review-roster.json", "utf8")), g.advisoresEnFindings(a));
  out.push(cruzado.problemas.some((p) => p.regla === "roster-incoherente") ? "cruzado-incoherente" : "cruzado-ok");
  console.log(dirs.length + " " + out.join(" "));
' "$CI" "$M17" "$M17/specs/1-9-x.md" 2>&1 | tail -1)"
if [ "$o17" = "2 ok ok cruzado-incoherente" ]; then ok "T17 Gate_ValidatesEachRunDirAgainstItsRoster"
else no "T17 Gate_ValidatesEachRunDirAgainstItsRoster — $o17"; fi

echo "parallel-runs: $pasaron pasaron, $fallos fallaron"
[ "$fallos" -eq 0 ]
