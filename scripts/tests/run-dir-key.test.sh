#!/usr/bin/env bash
# run-dir-key.test.sh — red de la clave por tema de lo que el arnés nombra con el número de la story.
#
# Por qué existe: la evidencia de cierre se separa por tema (`.advisors/dod-runtime/`), y otras cuatro cosas que los
# frenos también miran tendrían el número solo: la carpeta de los revisores (`.advisors/pipeline-runs/`),
# la guía del tester (`qa/<id>-pasos.md`), las aprobaciones de la matriz (`.tycon/runtime-waivers.jsonl`) y el aviso
# de «otra sesión ya trabaja esta story» (PIPE-C0). En los repos que numeran por tema, una story podría pasar a `done`
# con la carpeta de revisores de OTRA del mismo número.
#
# La regla es la de la evidencia de cierre (`lib/evidence-key.js`), sin otra: número único → el nombre de siempre; número repetido →
# `<tema>__<número>`.
#
# Lo que prueba:
#   T1  dos stories con el número 1.1 en temas a y b → carpetas de corrida a__1.1-<ts> y b__1.1-<ts>
#   T2  sólo b tiene carpeta de revisores (y constancia en gates.log) → el freno del commit y el portón de Azure no se la dan a a
#   T3  carpetas de a y b, la de b más nueva → retomar la corrida de a devuelve la de a
#   T4  dos 1.1 que comparten la carpeta qa/ → cada una su guía; el chequeo de a no acepta la de b
#   T5  aprobación de la matriz de b con el mismo texto de declaración que a → la matriz de a no la aplica
#   T6  dos sesiones sobre dos 1.1 distintas no se frenan; sobre la MISMA story sí (también desde otra copia del repo)
#   T7  carpeta, guía y aprobación viejas bajo el número compartido → siguen en disco, no cuentan, se nombran
#   T8  forma del arnés (número único) → los cuatro nombres no cambian
#   T9  `story: "../../fuera"` → no se crea ni se elige carpeta fuera de pipeline-runs/, y el motivo se dice
#   T10 marker.js escribe la constancia de gates.log con la ruta de la story
#   T11 marker.js clear deja el volcado de tiempos en la carpeta de la story, no en la de la otra del mismo número
#   T12 los medidores (rework por carril, puntero de la retro, duplicación del pase) ven las carpetas `<tema>__<número>-`
#   T13 el portón de Azure con una ruta de story que no existe no da nada por bueno, y lo avisa
#   T14–T19 cubren los bordes de la clave.
#
# Más casos:
#   T20 el registro de revisores (`on-advisor-run.js`, el hook real) sin clave anota el motivo y no crea carpeta
#   T21 `marker.js complete-step 8` sin clave anota «no medido» con el motivo y no bloquea por el findings.json
#   T22 el freno del frontmatter con una story que todavía no está en disco no le da la evidencia de otra del mismo número
#   T23 el portón de Azure y el freno del frontmatter calculan el prefijo de la evidencia con UNA función
#   T24 `storyId:` sin `story:` no es una story para nadie: ni el portón ni el pipeline lo leen, y los dos lo dicen
#
# Cada mundo de prueba vive en SU carpeta padre: la verificación previa al cierre mira repos vecinos.
# 🔴 HOME falso siempre: gates.log, los marcadores y el registro de aprobaciones viven bajo el home.
# Correr: bash scripts/tests/run-dir-key.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SK="$AQUI/skills/tycon-pipeline/scripts"
CI="$AQUI/scripts/ci/tycon-ci-gate.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ ejecución: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ ejecución: $1"; fallos=$((fallos+1)); }

command -v node >/dev/null || { echo "❌ ejecución: sin node no se puede medir nada"; exit 1; }
command -v git >/dev/null || { echo "❌ ejecución: sin git no se puede armar un repo de prueba"; exit 1; }
unset NODE_TEST_CONTEXT TYCON_EVIDENCE_KEY CLAUDE_CODE_SESSION_ID

export HOME="$TMP/casa"; mkdir -p "$HOME/.claude/.tycon-pipeline/active"
export TYCON_WAIVER_LOG="$HOME/.claude/.tycon-pipeline/runtime-waivers.jsonl"
GATES="$HOME/.claude/.tycon-pipeline/gates.log"

# story <ruta> <id> [extra-frontmatter] — una story mínima con un AC cubierto por una fila de la tabla de tests.
story(){
  mkdir -p "$(dirname "$1")"
  cat > "$1" <<EOF
---
epic: 1
story: "$2"
title: "story de prueba $2"
status: in-progress
${3:-}
---

# Story $2

## Acceptance Criteria

1. **Given** algo **When** pasa **Then** resultado.

### Tests

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | \`Caso1\` | 1 | integration | x | y |
EOF
}
# mundo <nombre> — un repo git propio en su carpeta padre propia; imprime la ruta del repo.
mundo(){ local r="$TMP/$1/repo"; mkdir -p "$r/.advisors/pipeline-runs" "$r/.advisors/dod-runtime"; git -C "$r" init -q -b trabajo; echo "$r"; }
# corrida <repo> <nombre> — una carpeta de corrida con un findings.json (lo que el freno acepta como constancia).
corrida(){ mkdir -p "$1/.advisors/pipeline-runs/$2"; echo '[]' > "$1/.advisors/pipeline-runs/$2/findings.json"; }
# verde <repo> — una suite verde: sin ella la matriz no acepta la declaración de un criterio no verificable
# («ningún test lo cubre»), y entonces ninguna aprobación podría aplicar y las pruebas de aprobaciones no medirían nada.
verde(){ printf '{"suite_green":true,"ts":"2026-10-06T00:00:00Z"}\n' > "$1/.advisors/tests-result.json"; }

# ── T1 — la carpeta de corrida se nombra por la clave ─────────────────────────────────────────────
M1="$(mundo m1)"
story "$M1/.specs/a/stories/1-1-x.md" 1.1; story "$M1/.specs/b/stories/1-1-y.md" 1.1
t1="$(node -e '
  const [sk, repo, a, b] = process.argv.slice(1);
  const p = require(sk + "/pipeline.js"), path = require("path");
  console.log(path.basename(p.resolveRunDir(repo, "1.1", true, a) || "null") + " " + path.basename(p.resolveRunDir(repo, "1.1", true, b) || "null"));
' "$SK" "$M1" "$M1/.specs/a/stories/1-1-x.md" "$M1/.specs/b/stories/1-1-y.md" 2>&1 | tail -1)"
if [[ "$t1" =~ ^a__1\.1-[0-9]{14}\ b__1\.1-[0-9]{14}$ ]]; then ok "T1 CarpetaDeCorrida_PorLaClave ($t1)"
else no "T1 CarpetaDeCorrida_PorLaClave — esperaba a__1.1-<ts> b__1.1-<ts>, dio: $t1"; fi

# ── T2 — la constancia de revisores de b no le sirve a a ──────────────────────────────────────────
M2="$(mundo m2)"
story "$M2/.specs/a/stories/1-1-x.md" 1.1; story "$M2/.specs/b/stories/1-1-y.md" 1.1
corrida "$M2" "b__1.1-20261006120000"
GL2="$TMP/m2/gates.log"
printf '{"check":"advisors","status":"green","storyId":"1.1","repoPath":"%s","storyPath":"%s"}\n' "$M2" "$M2/.specs/b/stories/1-1-y.md" > "$GL2"
t2="$(cd "$M2" && node -e '
  const [sk, ci, repo, a, b, gl] = process.argv.slice(1);
  const pc = require(sk + "/on-pre-commit.js"), g = require(ci);
  const r = [];
  r.push("commit:" + (!pc.findAdvisorsEvidence(repo, "1.1", { storyPath: a, gatesLog: gl }).found && pc.findAdvisorsEvidence(repo, "1.1", { storyPath: b, gatesLog: gl }).found));
  // Sólo gates.log: sin carpeta para nadie, la línea de b tampoco le sirve a a.
  const fs = require("fs"); fs.renameSync(repo + "/.advisors/pipeline-runs/b__1.1-20261006120000", repo + "/.advisors/fuera");
  r.push("gates:" + (!pc.findAdvisorsEvidence(repo, "1.1", { storyPath: a, gatesLog: gl }).found && pc.findAdvisorsEvidence(repo, "1.1", { storyPath: b, gatesLog: gl }).found));
  fs.renameSync(repo + "/.advisors/fuera", repo + "/.advisors/pipeline-runs/b__1.1-20261006120000");
  r.push("azure:" + (!g.hayEvidencia(repo, "pipeline-runs", "1.1", a) && g.hayEvidencia(repo, "pipeline-runs", "1.1", b)));
  // La búsqueda del registro de autoría (`review-roster.json`) del portón es la otra mitad de la constancia.
  r.push("roster:" + (typeof g.runDirsDeStory !== "function" ? "no-exportada"
    : (g.runDirsDeStory(repo, "1.1", a).length === 0 && g.runDirsDeStory(repo, "1.1", b).length === 1)));
  console.log(r.join(" "));
' "$SK" "$CI" "$M2" "$M2/.specs/a/stories/1-1-x.md" "$M2/.specs/b/stories/1-1-y.md" "$GL2" 2>&1 | tail -1)"
if [ "$t2" = "commit:true gates:true azure:true roster:true" ]; then ok "T2 ConstanciaDeRevisores_NoSeComparte"
else no "T2 ConstanciaDeRevisores_NoSeComparte — un lector le da a «a» la constancia de «b» (o no encuentra la de «b»): $t2"; fi

# ── T3 — retomar una corrida elige la propia aunque la otra sea más nueva ─────────────────────────
M3="$(mundo m3)"
story "$M3/.specs/a/stories/1-1-x.md" 1.1; story "$M3/.specs/b/stories/1-1-y.md" 1.1
corrida "$M3" "a__1.1-20261006100000"; sleep 1; corrida "$M3" "b__1.1-20261006110000"
t3="$(node -e '
  const [sk, repo, a] = process.argv.slice(1);
  console.log(require("path").basename(require(sk + "/pipeline.js").resolveRunDir(repo, "1.1", false, a) || "null"));
' "$SK" "$M3" "$M3/.specs/a/stories/1-1-x.md" 2>&1 | tail -1)"
if [ "$t3" = "a__1.1-20261006100000" ]; then ok "T3 RetomarCorrida_EligeLaPropia"
else no "T3 RetomarCorrida_EligeLaPropia — esperaba a__1.1-20261006100000, dio: $t3"; fi

# ── T4 — la guía de QA va por la clave cuando dos 1.1 comparten la carpeta qa/ ────────────────────
M4="$(mundo m4)"; UI='files_to_modify:
  - src/Pantalla.tsx'
story "$M4/docs/voz/epic-05/1-1-x.md" 1.1 "$UI"; story "$M4/docs/voz/epic-07/1-1-y.md" 1.1 "$UI"
QA4="$M4/docs/voz/qa"; mkdir -p "$QA4"
printf 'Usuario por defecto: operador\n\n## AC 1\nAbrir la pantalla y mirar el resultado.\n' > "$QA4/epic-07__1.1-pasos.md"
printf 'veredicto: OK\n' > "$QA4/epic-07__1.1-legibilidad.md"
# Una story de pantalla también necesita la revisión de su pantalla, con la misma clave.
printf 'veredicto: OK\nscreens: src/Pantalla.tsx\ncaptures: ninguna — sin E2E en esta prueba\n' > "$QA4/epic-07__1.1-legibilidad-ui.md"
mkdir -p "$M4/src"; printf 'export const P = () => <p>Pantalla de prueba</p>;\n' > "$M4/src/Pantalla.tsx"
ca="$(node "$SK/qa-guide.js" --story "$M4/docs/voz/epic-05/1-1-x.md" --check 2>&1)"; rca=$?
cb="$(node "$SK/qa-guide.js" --story "$M4/docs/voz/epic-07/1-1-y.md" --check 2>&1)"; rcb=$?
ga="$(node "$SK/qa-guide.js" --story "$M4/docs/voz/epic-05/1-1-x.md" --out "$TMP/m4/qa-a.html" 2>&1)"
if [ "$rca" -ne 0 ] && printf '%s' "$ca" | grep 'epic-05__1\.1-pasos\.md' >/dev/null && [ "$rcb" -eq 0 ] \
   && printf '%s' "$ga" | grep 'epic-05__1\.1-pasos\.md' >/dev/null; then ok "T4 GuiaDeQA_PorLaClave"
else no "T4 GuiaDeQA_PorLaClave — a: rc=$rca «$(printf '%s' "$ca" | head -3 | tr '\n' ' ')» · b: rc=$rcb «$(printf '%s' "$cb" | head -3 | tr '\n' ' ')»"; fi

# ── T5 — la aprobación de la matriz de b no vale para a aunque la declaración sea la misma ───────
M5="$(mundo m5)"; NV='runtime_not_verifiable:
  - ac: 1
    reason: "depende de un servicio externo que no hay en el entorno de prueba"
    covered_by: "T1"'
story "$M5/.specs/a/stories/1-1-x.md" 1.1 "$NV"; story "$M5/.specs/b/stories/1-1-y.md" 1.1 "$NV"; verde "$M5"
node -e '
  const [sk, repo] = process.argv.slice(1);
  const w = require(sk + "/lib/runtime-waiver.js");
  w.appendWaiver({ story: "b__1.1", acs: [1], matrixHash: "x", approvedBy: "dev", nowIso: "2026-10-06T00:00:00",
    declHashByAc: { 1: w.declHashFor("depende de un servicio externo que no hay en el entorno de prueba", "T1") },
    logPath: w.repoWaiverLogPath(repo) });
' "$SK" "$M5"
v5(){ node "$SK/runtime-matrix.js" --story "$1" --json --no-write 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).perAc[1].verdict)}catch{console.log("?")}})'; }
t5a="$(v5 "$M5/.specs/a/stories/1-1-x.md")"; t5b="$(v5 "$M5/.specs/b/stories/1-1-y.md")"
if [ "$t5a" != "WAIVED-USER" ] && [ "$t5b" = "WAIVED-USER" ]; then ok "T5 AprobacionDeLaMatriz_NoSeComparte (a=$t5a b=$t5b)"
else no "T5 AprobacionDeLaMatriz_NoSeComparte — a=$t5a (no debía ser WAIVED-USER), b=$t5b (debía serlo)"; fi

# ── T6 — PIPE-C0 compara la story, no sólo el número ──────────────────────────────────────────────
M6="$(mundo m6)"
story "$M6/.specs/a/stories/1-1-x.md" 1.1; story "$M6/.specs/b/stories/1-1-y.md" 1.1
git -C "$M6" add -A >/dev/null; git -C "$M6" -c user.email=t@t -c user.name=t commit -qm base >/dev/null
otra(){ printf '{"sessionId":"otra-sesion","storyId":"1.1","storyPath":"%s","repoPath":"%s","lastTouch":"2026-10-06T00:00:00Z","stepsCompleted":[0]}\n' "$1" "$M6" > "$HOME/.claude/.tycon-pipeline/active/otra-sesion.json"; }
c0(){ CLAUDE_CODE_SESSION_ID=esta-sesion TYCON_PIPELINE_NO_AUTONOMOUS=1 node "$SK/pipeline.js" start --story "$1" --repo "$M6" 2>/dev/null | grep -c 'PIPE-C0' ; }
otra "$M6/.specs/b/stories/1-1-y.md"; t6a="$(c0 "$M6/.specs/a/stories/1-1-x.md")"
rm -f "$HOME/.claude/.tycon-pipeline/active/esta-sesion.json"
otra "$M6/.specs/a/stories/1-1-x.md"; t6b="$(c0 "$M6/.specs/a/stories/1-1-x.md")"
rm -f "$HOME/.claude/.tycon-pipeline/active/"*.json
# La MISMA story en otra copia del repo (otro clon, otra ruta absoluta): se sigue frenando.
C6="$TMP/m6-copia/repo"; mkdir -p "$TMP/m6-copia"; git clone -q "$M6" "$C6"
printf '{"sessionId":"otra-sesion","storyId":"1.1","storyPath":"%s","repoPath":"%s","lastTouch":"2026-10-06T00:00:00Z","stepsCompleted":[0]}\n' "$C6/.specs/a/stories/1-1-x.md" "$C6" > "$HOME/.claude/.tycon-pipeline/active/otra-sesion.json"
t6c="$(c0 "$M6/.specs/a/stories/1-1-x.md")"
rm -f "$HOME/.claude/.tycon-pipeline/active/"*.json
if [ "$t6a" = "0" ] && [ "$t6b" != "0" ] && [ "$t6c" != "0" ]; then ok "T6 SesionesCruzadas_PorRuta"
else no "T6 SesionesCruzadas_PorRuta — otra story del mismo número: $t6a menciones de PIPE-C0 (esperaba 0) · misma story: $t6b (esperaba >0) · misma story en otra copia del repo: $t6c (esperaba >0)"; fi

# ── T7 — lo viejo bajo el número compartido no se toca, no cuenta y se nombra ─────────────────────
M7="$(mundo m7)"
story "$M7/.specs/a/stories/1-1-x.md" 1.1 "$NV
files_to_modify:
  - src/Pantalla.tsx"; story "$M7/.specs/b/stories/1-1-y.md" 1.1
corrida "$M7" "1.1-20261005090000"; verde "$M7"
QA7="$M7/.specs/a/qa"; mkdir -p "$QA7"   # la carpeta qa/ que le corresponde a «a» (la de arriba de su carpeta)
printf 'Usuario por defecto: operador\n\n## AC 1\nAbrir la pantalla.\n' > "$QA7/1.1-pasos.md"; printf 'veredicto: OK\n' > "$QA7/1.1-legibilidad.md"
node -e '
  const [sk, repo] = process.argv.slice(1);
  const w = require(sk + "/lib/runtime-waiver.js");
  w.appendWaiver({ story: "1.1", acs: [1], matrixHash: "x", approvedBy: "dev", nowIso: "2026-10-05T00:00:00",
    declHashByAc: { 1: w.declHashFor("depende de un servicio externo que no hay en el entorno de prueba", "T1") },
    logPath: w.repoWaiverLogPath(repo) });
' "$SK" "$M7"
antes="$(cd "$M7" && find .advisors .specs/a/qa .tycon -type f | sort | xargs shasum 2>/dev/null)"
A7="$M7/.specs/a/stories/1-1-x.md"
adv7="$(cd "$M7" && node -e '
  const [sk, repo, a] = process.argv.slice(1);
  const r = require(sk + "/on-pre-commit.js").findAdvisorsEvidence(repo, "1.1", { storyPath: a, gatesLog: "/nada" });
  console.log((r.found ? "cuenta" : "no-cuenta") + " " + ((r.legacy || []).join(",") || "sin-nombrar"));
' "$SK" "$M7" "$A7" 2>&1 | tail -1)"
qa7="$(node "$SK/qa-guide.js" --story "$A7" --check 2>&1)"; rq7=$?
mx7="$(node "$SK/runtime-matrix.js" --story "$A7" --json --no-write 2>/dev/null)"
v7="$(printf '%s' "$mx7" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).perAc[1].verdict)}catch{console.log("?")}})')"
despues="$(cd "$M7" && find .advisors .specs/a/qa .tycon -type f | sort | xargs shasum 2>/dev/null)"
f7=""
[[ "$adv7" == no-cuenta*1.1-20261005090000* ]] || f7="$f7 carpeta($adv7)"
{ [ "$rq7" -ne 0 ] && printf '%s' "$qa7" | grep '1\.1-pasos\.md.*no cuenta\|no cuenta.*1\.1-pasos\.md' >/dev/null; } || f7="$f7 guía(rc=$rq7)"
# Sin tildes en el patrón: `[oó]` no es UN carácter en el locale C. (El comentario va en su línea: al final de la de
# abajo se tragaría el `|| f7=…` y la rama no podría fallar nunca.)
{ [ "$v7" != "WAIVED-USER" ] && printf '%s' "$mx7" | grep 'vieja de la matriz' >/dev/null; } || f7="$f7 aprobación($v7)"
[ "$antes" = "$despues" ] || f7="$f7 se-tocó-algo"
if [ -z "$f7" ]; then ok "T7 LoViejo_NoSeTocaNiCuenta"
else no "T7 LoViejo_NoSeTocaNiCuenta — falla en:$f7"; fi

# ── T8 — número único (forma del arnés): los cuatro nombres no cambian ────────────────────────
M8="$(mundo m8)"
S8="$M8/specs/story-1-9-x.md"; story "$S8" 1.9 "$NV
files_to_modify:
  - src/Pantalla.tsx"
mkdir -p "$M8/qa"; printf 'Usuario por defecto: operador\n\n## AC 1\nAbrir la pantalla y mirar el resultado.\n' > "$M8/qa/1.9-pasos.md"
printf 'veredicto: OK\n' > "$M8/qa/1.9-legibilidad.md"
printf 'veredicto: OK\nscreens: src/Pantalla.tsx\ncaptures: ninguna — sin E2E en esta prueba\n' > "$M8/qa/1.9-legibilidad-ui.md"
# Una pantalla declarada que no está en el disco frena (no se puede revisar lo que no se ve).
mkdir -p "$M8/src"; printf 'export const P = () => <p>Pantalla de prueba</p>;\n' > "$M8/src/Pantalla.tsx"
node -e '
  const [sk, repo] = process.argv.slice(1);
  const w = require(sk + "/lib/runtime-waiver.js");
  w.appendWaiver({ story: "1.9", acs: [1], matrixHash: "x", approvedBy: "dev", nowIso: "2026-10-05T00:00:00",
    declHashByAc: { 1: w.declHashFor("depende de un servicio externo que no hay en el entorno de prueba", "T1") },
    logPath: w.repoWaiverLogPath(repo) });
' "$SK" "$M8"
corrida "$M8" "1.9-20261005090000"; verde "$M8"
t8="$(cd "$M8" && node -e '
  const [sk, ci, repo, s] = process.argv.slice(1);
  const p = require(sk + "/pipeline.js"), pc = require(sk + "/on-pre-commit.js"), g = require(ci), path = require("path");
  const r = [];
  r.push("retoma:" + path.basename(p.resolveRunDir(repo, "1.9", false, s) || "null"));
  r.push("commit:" + pc.findAdvisorsEvidence(repo, "1.9", { storyPath: s, gatesLog: "/nada" }).found);
  r.push("azure:" + g.hayEvidencia(repo, "pipeline-runs", "1.9", s));
  require("fs").rmSync(repo + "/.advisors/pipeline-runs", { recursive: true, force: true });
  r.push("crea:" + path.basename(p.resolveRunDir(repo, "1.9", true, s) || "null").replace(/\d{14}$/, "<ts>"));
  console.log(r.join(" "));
' "$SK" "$CI" "$M8" "$S8" 2>&1 | tail -1)"
q8="$(node "$SK/qa-guide.js" --story "$S8" --check 2>&1)"; rq8=$?
v8="$(node "$SK/runtime-matrix.js" --story "$S8" --json --no-write 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).perAc[1].verdict)}catch{console.log("?")}})')"
if [ "$t8" = "retoma:1.9-20261005090000 commit:true azure:true crea:1.9-<ts>" ] && [ "$rq8" -eq 0 ] && [ "$v8" = "WAIVED-USER" ]; then
  ok "T8 NumeroUnico_SinCambios"
else no "T8 NumeroUnico_SinCambios — $t8 · guía rc=$rq8 «$(printf '%s' "$q8" | head -2 | tr '\n' ' ')» · aprobación=$v8"; fi

# ── T9 — un número de story con ruta no nombra nada fuera de su carpeta ───────────────────────────
M9="$(mundo m9)"; story "$M9/.specs/a/stories/x.md" "../../fuera"
t9="$(node -e '
  const [sk, repo, s] = process.argv.slice(1);
  const p = require(sk + "/pipeline.js");
  const r = p.resolveRunDir(repo, "../../fuera", true, s);
  const f = p.computeFindingsStatus({ story: s, repo });
  console.log((r === null ? "sin-carpeta" : "CREO:" + r) + " " + (f.key_error ? "motivo-dicho" : "sin-motivo"));
' "$SK" "$M9" "$M9/.specs/a/stories/x.md" 2>&1 | tail -1)"
fuera9="$(find "$TMP" -maxdepth 3 -name 'fuera-*' 2>/dev/null | head -1)"
if [ "$t9" = "sin-carpeta motivo-dicho" ] && [ -z "$fuera9" ]; then ok "T9 NumeroConRuta_NoNombraNada"
else no "T9 NumeroConRuta_NoNombraNada — $t9 · creado afuera: ${fuera9:-nada}"; fi

# ── T10 — la constancia de gates.log la escribe marker.js con la ruta de la story ─────────────────
M10="$(mundo m10)"; S10="$M10/.specs/a/stories/1-1-x.md"; story "$S10" 1.1
printf '{"sessionId":"s10","storyId":"1.1","storyPath":"%s","repoPath":"%s","stepsCompleted":[0],"checks":{}}\n' "$S10" "$M10" > "$HOME/.claude/.tycon-pipeline/active/s10.json"
(cd "$M10" && CLAUDE_CODE_SESSION_ID=s10 node "$SK/marker.js" set-check build green --manual >/dev/null 2>&1)
t10="$(grep '"check":"build"' "$GATES" 2>/dev/null | tail -1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).storyPath||"sin-ruta")}catch{console.log("sin-linea")}})')"
rm -f "$HOME/.claude/.tycon-pipeline/active/s10.json"
if [ "$t10" = "$S10" ]; then ok "T10 ConstanciaDeGatesLog_LlevaLaRuta"
else no "T10 ConstanciaDeGatesLog_LlevaLaRuta — la línea de gates.log trae: $t10"; fi

# ── T11 — el volcado de tiempos va a la carpeta de la story, no a la de la otra del mismo número ──
M11="$(mundo m11)"; S11="$M11/.specs/a/stories/1-1-x.md"; story "$S11" 1.1; story "$M11/.specs/b/stories/1-1-y.md" 1.1
corrida "$M11" "a__1.1-20261006100000"; corrida "$M11" "b__1.1-20261006110000"
printf '{"sessionId":"s11","storyId":"1.1","storyPath":"%s","repoPath":"%s","stepsCompleted":[0],"checks":{}}\n' "$S11" "$M11" > "$HOME/.claude/.tycon-pipeline/active/s11.json"
(cd "$M11" && CLAUDE_CODE_SESSION_ID=s11 node "$SK/marker.js" clear >/dev/null 2>&1)
t11a="$(ls "$M11/.advisors/pipeline-runs/a__1.1-20261006100000" | grep -c '^timing-dump-')"
t11b="$(ls "$M11/.advisors/pipeline-runs/b__1.1-20261006110000" | grep -c '^timing-dump-')"
rm -f "$HOME/.claude/.tycon-pipeline/active/s11.json"
if [ "$t11a" = "1" ] && [ "$t11b" = "0" ]; then ok "T11 VolcadoDeTiempos_VaALaCarpetaPropia"
else no "T11 VolcadoDeTiempos_VaALaCarpetaPropia — volcados en la de a: $t11a (esperaba 1), en la de b: $t11b (esperaba 0)"; fi

# ── T12 — los medidores ven las carpetas nuevas ──────────────────────────────────────────────────
M12="$(mundo m12)"; A12="$M12/.specs/a/stories/1-1-x.md"; B12="$M12/.specs/b/stories/1-1-y.md"; story "$A12" 1.1; story "$B12" 1.1
corrida "$M12" "a__1.1-20261001120000"
git -C "$M12" add -A >/dev/null; git -C "$M12" -c user.email=t@t -c user.name=t commit -qm base >/dev/null
t12="$(node -e '
  const [aq, sk, repo, a, b] = process.argv.slice(1);
  const path = require("path");
  const sdlc = require(aq + "/scripts/metrics/sdlc-stage-metrics.js");
  const ek = require(sk + "/lib/evidence-key.js");
  const claves = ek.keysForStories([{ path: a, id: "1.1" }, { path: b, id: "1.1" }], repo);
  const sa = { id: "1.1", file: a, followups: false }, sb = { id: "1.1", file: b, followups: false };
  const hoy = new Date().toISOString();
  const r = sdlc.reworkPorCarril(repo, [sa, sb], new Map([[sa, hoy], [sb, hoy]]), (s) => claves.get(path.resolve(s.file)) || s.id);
  const v = r.valor || {};
  const retro = require(aq + "/scripts/metrics/retro-heartbeat.js").runDirDe(repo, "1.1");
  const dup = require(aq + "/scripts/metrics/adversarial-duplication.js").corridasDe(repo, "1.1");
  console.log("rework:" + (v.con_corrida && v.con_corrida.den) + "/" + (v.sin_constancia && v.sin_constancia.den)
    + " retro:" + (retro ? path.basename(retro) : "null") + " dup:" + dup.length);
' "$AQUI" "$SK" "$M12" "$A12" "$B12" 2>&1 | tail -1)"
if [ "$t12" = "rework:1/1 retro:a__1.1-20261001120000 dup:1" ]; then ok "T12 Medidores_VenLasCarpetasNuevas"
else no "T12 Medidores_VenLasCarpetasNuevas — $t12 (esperaba rework:1/1 retro:a__1.1-20261001120000 dup:1)"; fi

# ── T12b — la retro de una story de varias tandas apunta a la carpeta de la tanda que se mergeó ───────────────────
# Dos carpetas de la misma story: la de nombre más nuevo es de una tanda sin mergear. Gana la que firmó sobre un commit
# que el merge trae; sin ninguna atada al merge, null (ambiguo), no la última por nombre.
M12B="$(mundo m12b)"; g12(){ git -C "$M12B" -c user.email=t@t -c user.name=t "$@"; }
echo a > "$M12B/a"; g12 add -A >/dev/null; g12 commit -qm base >/dev/null
g12 checkout -q -b tanda-vieja; echo v > "$M12B/v"; g12 add v; g12 commit -qm vieja >/dev/null; CV="$(g12 rev-parse --short=12 HEAD)"
g12 checkout -q trabajo; g12 checkout -q -b tanda-nueva; echo n > "$M12B/n"; g12 add n; g12 commit -qm nueva >/dev/null; CN="$(g12 rev-parse --short=12 HEAD)"
g12 checkout -q trabajo; g12 merge -q --no-ff tanda-vieja -m "merge de la vieja" >/dev/null; MV="$(g12 rev-parse HEAD)"
corrida "$M12B" "1.2-20261001120000"; corrida "$M12B" "1.2-20261002120000"
printf '{"que":"plan","cuando":"2026-10-01T12:00:00Z","commit":"%s"}\n' "$CV" > "$M12B/.advisors/pipeline-runs/1.2-20261001120000/approvals.jsonl"
printf '{"que":"plan","cuando":"2026-10-02T12:00:00Z","commit":"%s"}\n' "$CN" > "$M12B/.advisors/pipeline-runs/1.2-20261002120000/approvals.jsonl"
t12b="$(node -e '
  const [aq, repo, merge] = process.argv.slice(1);
  const rd = require(aq + "/scripts/metrics/retro-heartbeat.js").runDirDe;
  console.log(String(rd(repo, "1.2", merge)));
' "$AQUI" "$M12B" "$MV" 2>&1 | tail -1)"
if [ "$t12b" = ".advisors/pipeline-runs/1.2-20261001120000/" ]; then ok "T12b la retro apunta a la carpeta de la tanda mergeada, no a la última por nombre"
else no "T12b la retro apunta a «${t12b}» (esperaba la carpeta 1.2-20261001120000)"; fi
printf '{"que":"plan","cuando":"2026-10-01T12:00:00Z","commit":"%s"}\n' "$CN" > "$M12B/.advisors/pipeline-runs/1.2-20261001120000/approvals.jsonl"
t12c="$(node -e '
  const [aq, repo, merge] = process.argv.slice(1);
  console.log(String(require(aq + "/scripts/metrics/retro-heartbeat.js").runDirDe(repo, "1.2", merge)));
' "$AQUI" "$M12B" "$MV" 2>&1 | tail -1)"
if [ "$t12c" = "null" ]; then ok "T12b …sin ninguna carpeta atada al merge es ambiguo: null"
else no "T12b …sin ninguna atada al merge esperaba null y dio «${t12c}»"; fi
# la tanda nueva firmó el plan sobre un commit que el merge trae y el cierre sobre el suyo, sin mergear: queda afuera
printf '{"que":"plan","cuando":"2026-10-01T12:00:00Z","commit":"%s"}\n' "$CV" > "$M12B/.advisors/pipeline-runs/1.2-20261001120000/approvals.jsonl"
printf '{"que":"plan","cuando":"2026-10-02T12:00:00Z","commit":"%s"}\n{"que":"cierre","cuando":"2026-10-02T13:00:00Z","commit":"%s"}\n' "$CV" "$CN" > "$M12B/.advisors/pipeline-runs/1.2-20261002120000/approvals.jsonl"
t12d="$(node -e '
  const [aq, repo, merge] = process.argv.slice(1);
  console.log(String(require(aq + "/scripts/metrics/retro-heartbeat.js").runDirDe(repo, "1.2", merge)));
' "$AQUI" "$M12B" "$MV" 2>&1 | tail -1)"
if [ "$t12d" = ".advisors/pipeline-runs/1.2-20261001120000/" ]; then ok "T12b …una tanda que firmó sobre un commit del merge y también sobre los suyos sin mergear no gana"
else no "T12b …la tanda sin mergear ganó: «${t12d}»"; fi
# las dos atadas al merge: ambiguo, no la más nueva
printf '{"que":"plan","cuando":"2026-10-02T12:00:00Z","commit":"%s"}\n' "$CV" > "$M12B/.advisors/pipeline-runs/1.2-20261002120000/approvals.jsonl"
t12e="$(node -e '
  const [aq, repo, merge] = process.argv.slice(1);
  console.log(String(require(aq + "/scripts/metrics/retro-heartbeat.js").runDirDe(repo, "1.2", merge)));
' "$AQUI" "$M12B" "$MV" 2>&1 | tail -1)"
if [ "$t12e" = "null" ]; then ok "T12b …con dos carpetas atadas al merge es ambiguo: null"
else no "T12b …con dos atadas esperaba null y dio «${t12e}»"; fi

# ── T13 — el portón de Azure sin la story falla cerrado ──────────────────────────────────────────
M13="$(mundo m13)"; corrida "$M13" "1.1-20261006120000"
printf '# DoD Runtime Evidence — Story 1.1\nverdict=PASS\n' > "$M13/.advisors/dod-runtime/1.1-202610061200Z.md"
t13="$(node -e '
  const [ci, repo] = process.argv.slice(1);
  const g = require(ci);
  const falta = repo + "/.specs/a/stories/no-existe.md";
  console.log("azure:" + g.hayEvidencia(repo, "pipeline-runs", "1.1", falta) + " roster:" + g.runDirsDeStory(repo, "1.1", falta).length
    + " cierre:" + g.hayEvidencia(repo, "dod-runtime", "1.1", falta));
' "$CI" "$M13" 2>"$TMP/m13/err" | tail -1)"
if [ "$t13" = "azure:false roster:0 cierre:false" ] && grep -q 'no encuentro la story' "$TMP/m13/err"; then ok "T13 PortonSinStory_FallaCerrado"
else no "T13 PortonSinStory_FallaCerrado — $t13 · aviso: $(head -c 160 "$TMP/m13/err")"; fi

# ── T14 — la carpeta de corrida la da un comando (los pasos no la arman a mano) ─────────────────
M14="$(mundo m14)"; story "$M14/.specs/a/stories/1-1-x.md" 1.1; story "$M14/.specs/b/stories/1-1-y.md" 1.1
U14="$(mundo m14u)"; story "$U14/specs/story-1-9-x.md" 1.9
rd(){ node "$SK/pipeline.js" run-dir "$@" 2>/dev/null; }
sin14="$(rd --story "$M14/.specs/a/stories/1-1-x.md" --repo "$M14")"; rsin14=$?
con14="$(rd --story "$M14/.specs/a/stories/1-1-x.md" --repo "$M14" --create)"
otra14="$(rd --story "$M14/.specs/a/stories/1-1-x.md" --repo "$M14")"
uni14="$(rd --story "$U14/specs/story-1-9-x.md" --repo "$U14" --create)"
if [ "$rsin14" -eq 3 ] && [ -z "$sin14" ] && [[ "$(basename "$con14")" =~ ^a__1\.1-[0-9]{14}$ ]] && [ -d "$con14" ] \
   && [ "$otra14" = "$con14" ] && [[ "$(basename "$uni14")" =~ ^1\.9-[0-9]{14}$ ]]; then ok "T14 CarpetaDeCorrida_LaDaElComando"
else no "T14 CarpetaDeCorrida_LaDaElComando — sin --create: rc=$rsin14 «${sin14}» · con: «$(basename "$con14")» · retomar: «$(basename "$otra14")» · único: «$(basename "$uni14")»"; fi

# ── T15 — el freno del commit desde una subcarpeta del repo encuentra la carpeta de la story ──────
M15="$(mundo m15)"; S15="$M15/specs/story-1-1-x.md"; story "$S15" 1.1 "dod_runtime_exempt: true"; mkdir -p "$M15/src/app"; echo x > "$M15/src/app/a.txt"
git -C "$M15" add -A >/dev/null; git -C "$M15" -c user.email=t@t -c user.name=t commit -qm base >/dev/null
corrida "$M15" "1.1-20261001120000"
node -e 'const fs=require("fs"),p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace("status: in-progress","status: done"))' "$S15"
git -C "$M15" add "$S15"
pc15(){ printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' "$1" | TYCON_ROSTER_GATE=off node "$SK/on-pre-commit.js" >/dev/null 2>&1; echo $?; }
r15raiz="$(pc15 "$M15")"; r15sub="$(pc15 "$M15/src/app")"
if [ "$r15raiz" = "0" ] && [ "$r15sub" = "0" ]; then ok "T15 FrenoDesdeSubcarpeta"
else no "T15 FrenoDesdeSubcarpeta — desde la raíz rc=$r15raiz, desde src/app rc=$r15sub (los dos debían pasar)"; fi

# ── T17 — la clave no cambia por tildes (NFC/NFD) ni por mayúsculas en la ruta ────────────────────
M17="$(mundo m17)"; NFD="gestio$(printf '\xcc\x81')n"; NFC="gesti$(printf '\xc3\xb3')n"
story "$M17/.specs/$NFD/stories/1-1-x.md" 1.1; story "$M17/.specs/otro/stories/1-1-y.md" 1.1
k17(){ node -e 'try{console.log(require(process.argv[1]+"/lib/evidence-key.js").evidenceKey(process.argv[2]).key)}catch(e){console.log("ERR:"+e.code)}' "$SK" "$1"; }
k17a="$(k17 "$M17/.specs/$NFD/stories/1-1-x.md")"
f17=""
# La story no es su propia hermana (el tema, no la ruta): en todos los sistemas de archivos.
[[ "$k17a" != +p+* ]] && [[ "$k17a" != ERR:* ]] || f17="$f17 tildes($k17a)"
# Las dos formas de la tilde, sólo donde el disco las trata como el mismo archivo (Mac). En Linux (ext4) son dos nombres
# distintos y la ruta en NFC no existe: igual que con las mayúsculas, ahí no hay nada que comparar (CI de Linux).
if [ -f "$M17/.specs/$NFC/stories/1-1-x.md" ]; then
  k17b="$(k17 "$M17/.specs/$NFC/stories/1-1-x.md")"
  [ "$k17a" = "$k17b" ] || f17="$f17 tildes($k17a vs $k17b)"
fi
OTRO17="$M17/.specs/OTRO/stories/1-1-y.md"
if [ -f "$OTRO17" ]; then   # sólo en sistemas de archivos que no distinguen mayúsculas (Mac, Windows)
  k17c="$(k17 "$OTRO17")"; k17d="$(k17 "$M17/.specs/otro/stories/1-1-y.md")"
  [ "$k17c" = "$k17d" ] || f17="$f17 mayúsculas($k17c vs $k17d)"
fi
if [ -z "$f17" ]; then ok "T17 ClaveEstable_TildesYMayusculas"
else no "T17 ClaveEstable_TildesYMayusculas —$f17"; fi

# ── T18 — el recolector de hallazgos empareja el volcado con la carpeta nueva ─────────────────────
t18="$(node -e '
  const c = require(process.argv[1] + "/scripts/metrics/collect-findings.js");
  if (typeof c.esCorridaDe !== "function") { console.log("sin-funcion"); process.exit(0); }
  console.log([c.esCorridaDe("a__1.1-20261006100000", "1.1"), c.esCorridaDe("1.1-20261006100000", "1.1"),
    c.esCorridaDe("1.10-20261006100000", "1.1"), c.esCorridaDe("a__1.10-20261006100000", "1.1")].join(","));
' "$AQUI" 2>&1 | tail -1)"
if [ "$t18" = "true,true,false,false" ]; then ok "T18 RecolectorDeHallazgos_VeLasNuevas"
else no "T18 RecolectorDeHallazgos_VeLasNuevas — $t18 (esperaba true,true,false,false)"; fi

# ── T19 — PIPE-C0 con la story de la otra sesión movida: se compara por el número ─────────────────
otra "$M6/.specs/a/stories/ya-no-existe.md"; t19="$(c0 "$M6/.specs/a/stories/1-1-x.md")"
rm -f "$HOME/.claude/.tycon-pipeline/active/"*.json
if [ "$t19" != "0" ]; then ok "T19 SesionesCruzadas_StoryMovida"
else no "T19 SesionesCruzadas_StoryMovida — con la story del otro marcador movida no frenó (debía comparar por el número)"; fi

# ── T20 — el registro de revisores sin clave dice el motivo (el hook de verdad, no la función) ─────
# Un número de story que no sirve para nombrar (`../../fuera`) es la forma determinista de que la clave no se calcule.
M20="$(mundo m20)"; S20="$M20/.specs/a/stories/x.md"; story "$S20" "../../fuera"
printf '{"sessionId":"s20","storyId":"../../fuera","storyPath":"%s","repoPath":"%s","stepsCompleted":[0,1,2,3,4],"checks":{}}\n' "$S20" "$M20" > "$HOME/.claude/.tycon-pipeline/active/s20.json"
L20="$HOME/.claude/.tycon-pipeline/advisor-runs/s20.jsonl"; mkdir -p "$(dirname "$L20")"
printf '{"ts":"2026-10-06T00:00:00Z","event":"step5-start","iter":1,"expected":["revisor-de-prueba"]}\n' > "$L20"
printf '{"tool_name":"Agent","session_id":"s20","cwd":"%s","tool_input":{"subagent_type":"revisor-de-prueba","prompt":"x"}}' "$M20" \
  | (cd "$M20" && TYCON_AUTO_SNAPSHOT=0 node "$SK/on-advisor-run.js" >/dev/null 2>"$TMP/m20/err")
t20="$(grep '"roster-write-failed"' "$L20" 2>/dev/null | tail -1)"
creadas20="$(find "$M20/.advisors/pipeline-runs" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')"
fuera20="$(find "$TMP/m20" -maxdepth 3 -name 'fuera-*' 2>/dev/null | head -1)"
rm -f "$HOME/.claude/.tycon-pipeline/active/s20.json"
if [[ "$t20" == *'run dir no resuelto: sin clave de la story ('* ]] && [ "$creadas20" = "0" ] && [ -z "$fuera20" ] \
   && grep -q 'no se pudo escribir el registro de autor' "$TMP/m20/err"; then ok "T20 RegistroDeRevisores_SinClave_DiceElMotivo"
else no "T20 RegistroDeRevisores_SinClave_DiceElMotivo — registro: ${t20:-nada} · carpetas: $creadas20 · afuera: ${fuera20:-nada}"; fi

# ── T21 — el cierre del Step 8 sin clave anota «no medido» con el motivo (el comando de verdad) ────
M21="$(mundo m21)"; S21="$M21/.specs/a/stories/x.md"; story "$S21" "../../fuera"
printf '{"sessionId":"s21","storyId":"../../fuera","storyPath":"%s","repoPath":"%s","stepsCompleted":[0,1,2,3,4,5,6,7],"checks":{}}\n' "$S21" "$M21" > "$HOME/.claude/.tycon-pipeline/active/s21.json"
(cd "$M21" && CLAUDE_CODE_SESSION_ID=s21 node "$SK/marker.js" complete-step 8 >/dev/null 2>"$TMP/m21/err")
l21="$(grep '"findings-json"' "$GATES" 2>/dev/null | tail -1)"
rm -f "$HOME/.claude/.tycon-pipeline/active/s21.json"
if grep -q 'NO pude mirar si' "$TMP/m21/err" && grep -q 'sin clave de la carpeta de corrida' "$TMP/m21/err" \
   && [[ "$l21" == *'"action":"no-medido"'* ]] && [[ "$l21" == *'sin clave de la carpeta de corrida'* ]] \
   && ! grep -q 'FALTA el findings.json' "$TMP/m21/err"; then ok "T21 CierreDelStep8_SinClave_NoMedido"
else no "T21 CierreDelStep8_SinClave_NoMedido — gates.log: ${l21:-nada} · aviso: $(grep -m1 'findings' "$TMP/m21/err" | head -c 200)"; fi

# ── T22 — el freno del frontmatter con la story todavía fuera del disco no usa el número solo ──────
# La story `a` se escribe por primera vez (Write) ya en `done`; existe otra 1.1 (`b`) con evidencia `1.1-*.md`.
M22="$(mundo m22)"; story "$M22/.specs/b/stories/1-1-y.md" 1.1
printf '# DoD Runtime Evidence — Story 1.1\nverdict=PASS\n' > "$M22/.advisors/dod-runtime/1.1-202610061200Z.md"
N22="$M22/.specs/a/stories/1-1-x.md"
r22="$(node -e '
  const [n, repo] = process.argv.slice(1);
  const content = "---\nepic: 1\nstory: \"1.1\"\ntitle: \"t\"\nstatus: done\n---\n\n# Story 1.1\n\nSe prueba con smoke runtime.\n";
  process.stdout.write(JSON.stringify({ tool_name: "Write", session_id: "s22", cwd: repo, tool_input: { file_path: n, content } }));
' "$N22" "$M22" | (cd "$M22" && TYCON_STATUS_GATE=off node "$SK/on-frontmatter-write.js" >/dev/null 2>"$TMP/m22/err"; echo $?))"
if [ "$r22" = "2" ] && grep -q 'no encuentro la story' "$TMP/m22/err"; then ok "T22 FrenoDelFrontmatter_StorySinDisco_FallaCerrado"
else no "T22 FrenoDelFrontmatter_StorySinDisco_FallaCerrado — rc=$r22 (esperaba 2: bloqueo) · aviso: $(head -c 200 "$TMP/m22/err")"; fi

# ── T23 — el portón y el freno del frontmatter: el mismo prefijo, de UNA función ───────────────────
M23="$(mundo m23)"
story "$M23/.specs/a/stories/1-1-x.md" 1.1; story "$M23/.specs/b/stories/1-1-y.md" 1.1; story "$M23/.specs/c/stories/1-9-z.md" 1.9
t23="$(node -e '
  const [sk, ci, repo] = process.argv.slice(1);
  const ek = require(sk + "/lib/evidence-key.js"), g = require(ci), fw = require(sk + "/on-frontmatter-write.js");
  if (typeof ek.evidencePrefix !== "function" || typeof g.prefijoDeEvidencia !== "function" || typeof fw.prefijoDe !== "function") {
    console.log("sin-funcion-compartida"); process.exit(0);
  }
  const casos = [["1.1", repo + "/.specs/a/stories/1-1-x.md"], ["1.9", repo + "/.specs/c/stories/1-9-z.md"],
    ["1.1", repo + "/.specs/a/stories/no-existe.md"], ["1.1", null]];
  console.log(casos.map(([id, p]) => {
    const a = g.prefijoDeEvidencia(id, p), b = fw.prefijoDe(id, p), c = ek.evidencePrefix(p, id).prefix;
    return a === b && b === c ? String(a) : `DISTINTOS(${a}|${b}|${c})`;
  }).join(" "));
' "$SK" "$CI" "$M23" 2>/dev/null | tail -1)"
# Copia de las skills atrasada (pasa: el freno del commit lee las instaladas): una biblioteca sin `evidencePrefix`. El
# portón conserva su respaldo — story fuera del disco, nada; en disco, el número solo — y dice que la copia es vieja.
V23="$TMP/m23/viejas/skills/tycon-pipeline/scripts/lib"; mkdir -p "$V23"
echo 'module.exports = { keyInfoOr: () => ({ key: "NO-DEBIA-USARSE", error: null }) };' > "$V23/evidence-key.js"
v23="$(TYCON_SKILLS_DIR="$TMP/m23/viejas/skills" node -e '
  const [ci, repo] = process.argv.slice(1);
  const g = require(ci);
  console.log(g.prefijoDeEvidencia("1.1", repo + "/.specs/a/stories/1-1-x.md") + " " + g.prefijoDeEvidencia("1.1", repo + "/.specs/a/stories/no-existe.md"));
' "$CI" "$M23" 2>"$TMP/m23/err-viejas" | tail -1)"
if [ "$t23" = "a__1.1- 1.9- null 1.1-" ] && [ "$v23" = "1.1- null" ] && grep -q 'vieja sin evidencePrefix' "$TMP/m23/err-viejas"; then ok "T23 Prefijo_UnaSolaRegla"
else no "T23 Prefijo_UnaSolaRegla — $t23 (esperaba: a__1.1- 1.9- null 1.1-) · con la copia vieja: $v23 (esperaba: 1.1- null) · aviso: $(head -c 160 "$TMP/m23/err-viejas")"; fi

# ── T24 — `storyId:` sin `story:` no es una story: nadie lo lee, y el portón y el arranque lo dicen ──
M24="$(mundo m24)"; S24="$M24/.specs/a/stories/a-x.md"; mkdir -p "$(dirname "$S24")"
fm24(){ printf -- '---\nepic: 1\nstoryId: "1.1"\ntitle: "t"\nstatus: %s\n---\n\n# Story 1.1\n' "$1" > "$S24"; }
gc24(){ git -C "$M24" -c user.email=t@t -c user.name=t "$@" >/dev/null 2>&1; }
fm24 in-progress; gc24 add -A; gc24 commit -q -m base; base24="$(git -C "$M24" rev-parse HEAD)"
fm24 done; gc24 add -A; gc24 commit -q -m done
f24=""
p24="$(node -e '
  const [ci, repo, base] = process.argv.slice(1);
  const r = require(ci).revisar({ repo, base });
  const mio = (l) => (l || []).filter((h) => /a-x\.md$/.test(h.archivo));
  console.log(mio(r.hallazgos).length + " " + mio(r.avisos).map((a) => a.regla).join(","));
' "$CI" "$M24" "$base24" 2>/dev/null | tail -1)"
[ "$p24" = "0 storyid-sin-story" ] || f24="$f24 portón($p24, esperaba «0 storyid-sin-story»)"
# La salida de texto: el aviso va en su bloque, no bajo el de `review → done` (que diría que frena).
o24="$(node "$CI" --repo "$M24" --base "$base24" 2>&1)"
[[ "$o24" == *'no los trata como tal'* ]] && [[ "$o24" != *'TYCON_REVIEW_A_DONE'* ]] || f24="$f24 texto(el aviso salió bajo otro encabezado)"
# Los otros dos caminos al silencio: renombrar `story:` a `storyId:` sin tocar el estado, y un
# frontmatter que no cierra.
printf -- '---\nepic: 1\nstory: "1.2"\ntitle: "t"\nstatus: done\n---\n\n# Story 1.2\n' > "$M24/.specs/a/stories/b-y.md"
gc24 add -A; gc24 commit -q -m b; base24b="$(git -C "$M24" rev-parse HEAD)"
printf -- '---\nepic: 1\nstoryId: "1.2"\ntitle: "t"\nstatus: done\n---\n\n# Story 1.2\n' > "$M24/.specs/a/stories/b-y.md"
printf -- '---\nepic: 1\nstoryId: "1.3"\ntitle: "t"\nstatus: done\n\n# Story 1.3 (el frontmatter no cierra)\n' > "$M24/.specs/a/stories/c-z.md"
gc24 add -A; gc24 commit -q -m renombre
q24="$(node -e '
  const [ci, repo, base] = process.argv.slice(1);
  const r = require(ci).revisar({ repo, base });
  const de = (f) => (r.avisos || []).filter((h) => h.archivo.endsWith(f) && h.regla === "storyid-sin-story").length;
  console.log(de("b-y.md") + " " + de("c-z.md"));
' "$CI" "$M24" "$base24b" 2>/dev/null | tail -1)"
[ "$q24" = "1 1" ] || f24="$f24 renombre/frontmatter-roto($q24, esperaba «1 1»: un aviso cada uno)"
d24="$(node -e 'console.log(require(process.argv[1]+"/pipeline.js").deriveStoryId(process.argv[2]))' "$SK" "$S24" 2>/dev/null | tail -1)"
[ "$d24" != "1.1" ] || f24="$f24 deriveStoryId(tomó 1.1 de storyId:)"
s24="$(cd "$M24" && CLAUDE_CODE_SESSION_ID=s24 node "$SK/pipeline.js" start --story "$S24" --repo "$M24" --no-autonomous 2>&1)"
rm -f "$HOME/.claude/.tycon-pipeline/active/s24.json"
[[ "$s24" == *'declara `storyId:` y no `story:`'* ]] || f24="$f24 start(no lo dijo)"
# El barrido: ningún lector del frontmatter en el código cae a `storyId` cuando falta `story` (`fm.story || fm.storyId`,
# `escalar(fm, 'story') || escalar(fm, 'storyId')`). Mirar si la clave ESTÁ, para avisar, no es leerla como número.
b24="$(grep -rnE "story['\"]?\)? *\|\| *([A-Za-z]*[Ff]m[A-Za-z]*\.storyId|[A-Za-z]+\([^)]*['\"]storyId['\"])" "$AQUI/skills" "$AQUI/scripts" --include='*.js' 2>/dev/null | grep -v '/tests/' | head -3)"
[ -z "$b24" ] || f24="$f24 barrido(${b24})"
if [ -z "$f24" ]; then ok "T24 StoryIdSolo_NoEsStory"
else no "T24 StoryIdSolo_NoEsStory —$f24"; fi

echo "run-dir-key: $pasaron pasaron, $fallos fallaron"
[ "$fallos" -eq 0 ]
