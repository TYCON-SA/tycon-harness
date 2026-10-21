#!/usr/bin/env bash
# run-change.test.sh — el cambio de cada corrida sale de git (T1–T9).
#
# Todo en repos efímeros y un HOME falso: nunca se lee ni se toca lo de esta máquina. Lo que la corrida
# «hizo» pasa con la hora real; lo previo a la corrida (crear el repo, el commit inicial) se fecha en el
# pasado con GIT_COMMITTER_DATE, que es la hora que git anota también en el reflog.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrito qué lo pone en rojo (la mutación). El exit
#    code se lee ANTES de cualquier pipe. bash 3.2 (macOS): siempre `${v}`.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUION="${RAIZ}/scripts/metrics/run-change.js"
NODE="$(command -v node)"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

echo "== run-change.test.sh =="
[ -f "${GUION}" ] || { mal "no existe ${GUION} (rojo previo: el guion todavía no está)"; echo; echo "${FALLOS} fallo(s)"; exit 1; }

BASE="$(mktemp -d)"
trap 'rm -rf "${BASE}"' EXIT
mkdir -p "${BASE}/home"; export HOME="${BASE}/home"
export GIT_CONFIG_GLOBAL="${BASE}/gitconfig" GIT_CONFIG_NOSYSTEM=1
git config --global user.name "Prueba" && git config --global user.email "prueba@ejemplo.invalid" && git config --global init.defaultBranch main
ANTES="2026-01-01T10:00:00"
SID="sesion-2-19"

# repo <dir>: repo con un commit inicial fechado ANTES de la corrida (no es de la corrida)
repo() {
  mkdir -p "$1" && git -C "$1" init -q
  printf 'uno\n' > "$1/a.js"; printf 'base\n' > "$1/b.js"
  git -C "$1" add -A && GIT_COMMITTER_DATE="${ANTES}" GIT_AUTHOR_DATE="${ANTES}" git -C "$1" commit -qm "inicial"
}
# volcado <archivo> <repoPath> [filesTouched-json]: la corrida arrancó hace 10 minutos y se archiva ahora
volcado() {
  "${NODE}" -e '
    const [f, repo, ft, sid] = process.argv.slice(1);
    const ahora = Date.now();
    require("fs").writeFileSync(f, JSON.stringify({ archivedAt: new Date(ahora + 5000).toISOString(),
      marker: { storyId: "9.9", sessionId: sid, repoPath: repo || undefined, startedAt: new Date(ahora - 600000).toISOString(),
        filesTouched: JSON.parse(ft || "[]") } }));' "$1" "$2" "${3:-[]}" "${SID}"
}
# volcado_ventana <archivo> <repoPath> <desfase-inicio-seg> <duracion-seg>: la ventana arranca cuando se le dice
volcado_ventana() {
  "${NODE}" -e '
    const [f, repo, off, dur, sid] = process.argv.slice(1);
    const ini = Date.now() + Number(off) * 1000;
    require("fs").writeFileSync(f, JSON.stringify({ archivedAt: new Date(ini + Number(dur) * 1000).toISOString(),
      marker: { storyId: "9.9", sessionId: sid, repoPath: repo, startedAt: new Date(ini).toISOString(), filesTouched: [] } }));' "$1" "$2" "$3" "$4" "${SID}"
}
# leer <archivo.cambio.json.gz> <expresión js sobre c>: imprime el resultado
leer() { "${NODE}" -e 'const c=JSON.parse(require("zlib").gunzipSync(require("fs").readFileSync(process.argv[1])).toString()); console.log(eval(process.argv[2]));' "$1" "$2"; }
correr() { "${NODE}" "${GUION}" --dump "$1" --state "${BASE}/estado" > "${BASE}/out" 2> "${BASE}/err"; }
mkdir -p "${BASE}/estado"

# ── T1 · commits de la corrida y lo que quedó sin commitear ────────────────────────────────────────
# falla si: sin el guion no hay archivo. Mutaciones: no leer `git diff HEAD` (b.js no sale), olvidar los
# no trackeados (c.js no sale), o tomar el commit inicial como de la corrida.
R="${BASE}/t1"; repo "${R}"
printf 'uno\ndos\n' > "${R}/a.js"; git -C "${R}" commit -qam "feat: la corrida toca a.js"
printf 'base\ncambio sin commitear\n' > "${R}/b.js"; printf 'nuevo\n' > "${R}/c.js"
V="${BASE}/t1v.json"; volcado "${V}" "${R}"
correr "${V}"; rc=$?
if [ "${rc}" = 0 ] && [ -f "${BASE}/t1v.cambio.json.gz" ]; then
  G="$(leer "${BASE}/t1v.cambio.json.gz" '
    const r = c.repos && c.repos[0];
    [c.estado, c.version, c.repos.length, r.principal, r.commits.length, r.commits[0].asunto,
     r.commits[0].archivos.map(p => p.ruta + ":" + p.estado).join(","), /\+dos/.test(r.commits[0].archivos[0].parche),
     r.sin_commitear.map(p => p.ruta + ":" + p.estado).sort().join(","),
     r.sin_commitear.every(p => typeof p.parche === "string" && p.parche.length > 0)].join("|")')"
  [ "${G}" = "medido|1|1|true|1|feat: la corrida toca a.js|a.js:M|true|b.js:M,c.js:A|true" ] && ok "T1 el commit de la corrida con su parche, y b.js modificado y c.js nuevo sin commitear" || mal "T1 salió: ${G}"
  S="$(cat "${BASE}/out")"
  "${NODE}" -e 'const s=JSON.parse(process.argv[1]); if(s.estado!=="medido"||s.archivos!==3||s.repos!==1) process.exit(1)' "${S}" && ! grep -q 'dos\|cambio sin commitear' "${BASE}/out" "${BASE}/err" \
    && ok "T1/T10 la salida es una línea de resumen (3 archivos, 1 repo) sin ningún parche" || mal "T1/T10 salida: ${S} · err: $(head -c 200 "${BASE}/err")"
else
  mal "T1 no escribió el cambio (rc=${rc}): $(head -c 300 "${BASE}/err")"
fi

# ── T2 · lo que llegó de afuera no es de la corrida ─────────────────────────────────────────────────
# falla si: comparar contra la base (o tomar todo el rango) mete z.js y los commits del otro clon.
# Mutaciones: contar `pull:`/`reset:`/fast-forward como acciones que crean commit → rojo.
O="${BASE}/t2origen"; repo "${O}"; git -C "${O}" config receive.denyCurrentBranch ignore
R="${BASE}/t2"; GIT_COMMITTER_DATE="${ANTES}" git clone -q "${O}" "${R}"
BASEC="$(git -C "${R}" rev-parse HEAD)"
OTRO="${BASE}/t2otro"; git clone -q "${O}" "${OTRO}"
printf 'ajeno\n' > "${OTRO}/z.js"; git -C "${OTRO}" add z.js && git -C "${OTRO}" commit -qm "ajeno: z.js" && git -C "${OTRO}" push -q origin main 2>/dev/null
git -C "${R}" pull -q --ff-only 2>/dev/null
printf 'ajeno2\n' > "${OTRO}/z.js"; git -C "${OTRO}" commit -qam "ajeno: z.js otra vez" && git -C "${OTRO}" push -q origin main 2>/dev/null
git -C "${R}" fetch -q && git -C "${R}" reset -q --hard origin/main
V="${BASE}/t2v.json"; volcado "${V}" "${R}"
correr "${V}"
G="$(leer "${BASE}/t2v.cambio.json.gz" 'const r=c.repos[0]; [c.estado, r.commits.length, JSON.stringify(r).includes("z.js")].join("|")')"
EN_RANGO="$(git -C "${R}" rev-list --count "${BASEC}..HEAD")"
[ "${G}" = "medido|0|false" ] && [ "${EN_RANGO}" = 2 ] && ok "T2 los 2 commits que llegaron por pull y reset no son de la corrida (control: están entre la base y HEAD)" || mal "T2 salió: ${G} · en rango: ${EN_RANGO}"

# ── T3 · amend y rebase: el commit sale una sola vez, el que quedó ──────────────────────────────────
# falla si: tomar todo `commit:` del reflog sin mirar si sigue alcanzable → 3 commits (original,
# enmendado, reubicado). Mutación: sacar el chequeo de alcanzable → rojo.
O="${BASE}/t3origen"; repo "${O}"; git -C "${O}" config receive.denyCurrentBranch ignore
R="${BASE}/t3"; GIT_COMMITTER_DATE="${ANTES}" git clone -q "${O}" "${R}"
printf 'uno\npropio\n' > "${R}/a.js"; git -C "${R}" commit -qam "propio: primera"
printf 'uno\npropio enmendado\n' > "${R}/a.js"; git -C "${R}" commit -q --amend -am "propio: enmendado"
OTRO="${BASE}/t3otro"; git clone -q "${O}" "${OTRO}"; printf 'x\n' > "${OTRO}/y.js"; git -C "${OTRO}" add y.js && git -C "${OTRO}" commit -qm "ajeno: y.js" && git -C "${OTRO}" push -q origin main 2>/dev/null
git -C "${R}" fetch -q && git -C "${R}" rebase -q origin/main
V="${BASE}/t3v.json"; volcado "${V}" "${R}"
correr "${V}"
HEADC="$(git -C "${R}" rev-parse HEAD)"
G="$(leer "${BASE}/t3v.cambio.json.gz" 'const r=c.repos[0]; [r.commits.length, "'"${HEADC}"'".startsWith(r.commits[0].h), r.commits[0].asunto, JSON.stringify(r).includes("y.js")].join("|")')"
[ "${G}" = "1|true|propio: enmendado|false" ] && ok "T3 enmendado y reubicado: sale una vez, el commit que quedó, sin lo ajeno" || mal "T3 salió: ${G}"

# ── T4 · lo escrito por consola en otro repo hace que ese repo se mire ─────────────────────────────
# falla si: mirar sólo el repo de la story → «otro» no aparece. Control: sin la línea no entra
# (si entrara igual, el caso no probaría que la anotación es la que lo trae).
R="${BASE}/t4"; repo "${R}"
OT="${BASE}/t4otro repo"; repo "${OT}"; printf 'uno\nconsola\n' > "${OT}/a.js"
V="${BASE}/t4v.json"; volcado "${V}" "${R}"
mkdir -p "${BASE}/estado/console-writes"
anotar() { "${NODE}" -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify({path: process.argv[2], ts: new Date().toISOString()})+"\n")' "$1" "$2"; }
anotar "${BASE}/estado/console-writes/${SID}.jsonl" "${OT}/a.js"
correr "${V}"
G="$(leer "${BASE}/t4v.cambio.json.gz" 'const o=c.repos.find(r=>!r.principal); o ? [c.repos.length, JSON.stringify(o.por), o.sin_commitear.map(p=>p.ruta).join(","), o.nombre].join("|") : "sin-otro:"+c.repos.length')"
rm -f "${BASE}/estado/console-writes/${SID}.jsonl"
correr "${V}"
G2="$(leer "${BASE}/t4v.cambio.json.gz" 'c.repos.length')"
[ "${G}" = '2|["consola"]|a.js|t4otro repo' ] && [ "${G2}" = 1 ] && ok "T4 el repo donde se escribió por consola entra con por=consola (control: sin la anotación, no entra)" || mal "T4 salió: ${G} · sin anotación: ${G2}"

# ── T4b · mientras dura el renombre se leen las dos carpetas ───────────────────────
# Una sesión abierta con el código anterior sigue anotando en la carpeta vieja; la que ya migró, en la nueva. Lo de
# las dos cuenta: la propia (un repo sólo en la nueva, otro sólo en la vieja) y la de otra sesión (sólo en la vieja).
# El nombre viejo sale del mapa (escrito acá, lo contaría el termómetro). Falla si, en las dos direcciones: leer
# sólo la nueva → «t4b viejo» no entra y la otra sesión no se cuenta; sólo la vieja (el código anterior) → «t4otro
# repo» no entra.
VIEJA="$("${NODE}" -e 'try { const e = require(process.argv[1]).entries.find((x) => x.batch === "D2" && /\/console-writes$/.test(x.new)); process.stdout.write(e ? e.old.split("/").pop() : ""); } catch (_) {}' "${RAIZ}/scripts/lib/renames.json")"
if [ -z "${VIEJA}" ]; then
  ok "T4b se saltea: sin el mapa del equipo (copia pública) no hay nombre viejo"
else
  OV="${BASE}/t4b viejo"; repo "${OV}"; printf 'x\n' > "${OV}/v.js"
  mkdir -p "${BASE}/estado/${VIEJA}"
  anotar "${BASE}/estado/console-writes/${SID}.jsonl" "${OT}/a.js"
  anotar "${BASE}/estado/${VIEJA}/${SID}.jsonl" "${OV}/v.js"
  anotar "${BASE}/estado/${VIEJA}/otra-sesion.jsonl" "${R}/z.js"
  correr "${V}"
  G="$(leer "${BASE}/t4v.cambio.json.gz" '[c.repos.length, c.repos.filter(r=>!r.principal).map(r=>r.nombre).sort().join(","), c.repos.find(r=>r.principal).otras_sesiones].join("|")')"
  [ "${G}" = '3|t4b viejo,t4otro repo|1' ] && ok "T4b las dos carpetas cuentan: la propia (una en cada una) y la de otra sesión" || mal "T4b salió: ${G}"
  rm -rf "${BASE}/estado/${VIEJA}" "${BASE}/estado/console-writes/${SID}.jsonl"
fi

# ── T5 · la clave y la ruta salen tapadas; sin el saneado no se publica ────────────────────────────
# falla si: guardar el diff crudo → la clave sale. Mutación: no pasar el parche por sanear → rojo;
# en la copia sin tokens-digest.js, publicar igual los parches → rojo.
R="${BASE}/t5"; repo "${R}"
printf '{"Conexion": "Server=x;Password=ClaveSecreta123;", "Ruta": "/Users/dev/cliente/x"}\n' > "${R}/appsettings.json"
V="${BASE}/t5v.json"; volcado "${V}" "${R}"
correr "${V}"
if gzip -dc "${BASE}/t5v.cambio.json.gz" | grep 'ClaveSecreta123\|/Users/dev' >/dev/null; then mal "T5 la clave o la ruta quedaron en el archivo"
elif grep -q 'ClaveSecreta123\|/Users/dev' "${BASE}/out" "${BASE}/err"; then mal "T5 la clave o la ruta salieron por pantalla"
else
  G="$(leer "${BASE}/t5v.cambio.json.gz" 'const p=c.repos[0].sin_commitear[0]; [p.ruta, /appsettings/.test(p.parche), /<oculto>|<ruta>/.test(p.parche)].join("|")')"
  [ "${G}" = "appsettings.json|true|true" ] && ok "T5 el parche existe y trae la clave y la ruta tapadas" || mal "T5 salió: ${G}"
fi
# La copia lleva scripts/lib/legacy-names.js (la carga al arrancar y vive siempre al lado); falta sólo tokens-digest.js.
mkdir -p "${BASE}/copia/scripts/metrics" "${BASE}/copia/scripts/lib" && cp "${GUION}" "${BASE}/copia/scripts/metrics/"
cp "${RAIZ}/scripts/lib/legacy-names.js" "${BASE}/copia/scripts/lib/"
"${NODE}" "${BASE}/copia/scripts/metrics/run-change.js" --dump "${V}" --state "${BASE}/estado" --output "${BASE}/t5sin.cambio.json.gz" > "${BASE}/out" 2> "${BASE}/err"; rc=$?
G="$(leer "${BASE}/t5sin.cambio.json.gz" '[c.estado, /tokens-digest/.test(c.motivo||""), !JSON.stringify(c).includes("Password")].join("|")' 2>&1)"
[ "${rc}" = 0 ] && [ "${G}" = "no_publicado|true|true" ] && ok "T5 sin tokens-digest.js: no_publicado, con el motivo y sin parches" || mal "T5 sin saneado (rc=${rc}): ${G}"

# ── T6 · topes por parte y por corrida, binario y .engram ──────────────────────────────────────────
# falla si: sin topes el archivo lleva 6 MB de parches. Mutaciones: no cortar la parte grande, no
# cortar al pasar el total, dar parche a un binario, o incluir .engram/ → rojo.
R="${BASE}/t6"; repo "${R}"
"${NODE}" -e '
  const fs=require("fs"), d=process.argv[1];
  fs.writeFileSync(d+"/grande.txt", ("x".repeat(99)+"\n").repeat(3000));
  for (let i=0;i<32;i++) fs.writeFileSync(d+"/m"+String(i).padStart(2,"0")+".txt", (String(i)+"y".repeat(98)+"\n").repeat(1900));
  fs.writeFileSync(d+"/logo.png", Buffer.from([0x89,0x50,0x4e,0x47,0,0,0,0,1,2,3,0,0,255]));
  fs.mkdirSync(d+"/.engram",{recursive:true}); fs.writeFileSync(d+"/.engram/memoria.txt","secreto de memoria\n");' "${R}"
V="${BASE}/t6v.json"; volcado "${V}" "${R}"
correr "${V}"
G="$(leer "${BASE}/t6v.cambio.json.gz" '
  const ps=c.repos[0].sin_commitear, g=ps.find(p=>p.ruta==="grande.txt"), png=ps.find(p=>p.ruta==="logo.png");
  const tope=ps.filter(p=>p.sin_parche_por_tope), total=ps.reduce((a,p)=>a+(p.parche?p.parche.length:0),0);
  [g&&g.cortado>0&&g.parche.length<=200000, png&&png.binario===true&&png.parche===null, tope.length>0&&tope.every(p=>p.parche===null&&p.mas>0),
   total<=5*1024*1024, !ps.some(p=>p.ruta.startsWith(".engram")), c.topes&&c.topes.por_parte===200000].join("|")')"
[ "${G}" = "true|true|true|true|true|true" ] && ok "T6 la parte grande se corta, pasado el total quedan sólo los números, el png sin parche y .engram fuera" || mal "T6 salió: ${G}"

# ── T7 · otra sesión que escribió en la misma copia se cuenta ──────────────────────────────────────
# falla si: sin mirar las otras sesiones, otras_sesiones no existe. Mutaciones: contar la sesión propia,
# o contar la escritura de fuera de la ventana → 2 → rojo.
R="${BASE}/t7"; repo "${R}"; printf 'uno\nmio\n' > "${R}/a.js"
V="${BASE}/t7v.json"; volcado "${V}" "${R}"
mkdir -p "${BASE}/estado/file-events"
"${NODE}" -e '
  const fs=require("fs"), [d, r, sid]=process.argv.slice(1), ahora=Date.now();
  fs.writeFileSync(d+"/otra-sesion.jsonl", JSON.stringify({path:r+"/b.js", ts:new Date(ahora-60000).toISOString()})+"\n");
  fs.writeFileSync(d+"/sesion-vieja.jsonl", JSON.stringify({path:r+"/b.js", ts:new Date(ahora-86400000).toISOString()})+"\n");
  fs.writeFileSync(d+"/"+sid+".jsonl", JSON.stringify({path:r+"/a.js", ts:new Date(ahora-30000).toISOString()})+"\n");' "${BASE}/estado/file-events" "${R}" "${SID}"
correr "${V}"
G="$(leer "${BASE}/t7v.cambio.json.gz" 'const r=c.repos[0]; [c.repos.length, r.otras_sesiones, JSON.stringify(r.por)].join("|")')"
rm -f "${BASE}/estado/file-events/"*.jsonl
[ "${G}" = '1|1|["story","herramientas"]' ] && ok "T7 una sola otra sesión en la ventana (la vieja y la propia no cuentan)" || mal "T7 salió: ${G}"

# ── T8 · no poder mirar nunca es vacío ─────────────────────────────────────────────────────────────
# falla si: devolver `repos: []`. Mutaciones: escribir `repos` en un no_medido, o abortar todo por un
# repo borrado → rojo.
printf '{ esto no es json' > "${BASE}/t8a.json"
"${NODE}" "${GUION}" --dump "${BASE}/t8a.json" --state "${BASE}/estado" > "${BASE}/out" 2> "${BASE}/err"; rc1=$?
G1="$(leer "${BASE}/t8a.cambio.json.gz" '[c.estado, "repos" in c, (c.motivo||"").length>10].join("|")')"
volcado "${BASE}/t8b.json" ""
"${NODE}" "${GUION}" --dump "${BASE}/t8b.json" --state "${BASE}/estado" > "${BASE}/out" 2> "${BASE}/err"; rc2=$?
G2="$(leer "${BASE}/t8b.cambio.json.gz" '[c.estado, "repos" in c].join("|")')"
R="${BASE}/t8c"; repo "${R}"; printf 'uno\nx\n' > "${R}/a.js"
volcado "${BASE}/t8c.json" "${R}"
env PATH="/nonexistent" "${NODE}" "${GUION}" --dump "${BASE}/t8c.json" --state "${BASE}/estado" > "${BASE}/out" 2> "${BASE}/err"; rc3=$?
G3="$(leer "${BASE}/t8c.cambio.json.gz" '[c.estado, "repos" in c, /git/.test(c.motivo||"")].join("|")')"
SANO="${BASE}/t8sano"; repo "${SANO}"; printf 'uno\nsano\n' > "${SANO}/a.js"
volcado "${BASE}/t8d.json" "${BASE}/t8borrado" "[\"${SANO}/a.js\"]"
"${NODE}" "${GUION}" --dump "${BASE}/t8d.json" --state "${BASE}/estado" > "${BASE}/out" 2> "${BASE}/err"; rc4=$?
G4="$(leer "${BASE}/t8d.cambio.json.gz" 'const b=c.repos.find(r=>r.principal), s=c.repos.find(r=>!r.principal); [c.estado, b&&b.estado, b&&(b.motivo||"").length>5, s&&s.estado, s&&s.sin_commitear.length, b&&b.otras_sesiones===null].join("|")')"
[ "${rc1}${rc2}${rc3}${rc4}" = "0000" ] && [ "${G1}" = "no_medido|false|true" ] && [ "${G2}" = "no_medido|false" ] && [ "${G3}" = "no_medido|false|true" ] && [ "${G4}" = "medido|no_medido|true|medido|1|true" ] \
  && ok "T8 volcado ilegible, sin repo y sin git: no_medido sin «repos»; repo borrado: ése no_medido y el sano medido" \
  || mal "T8 rc=${rc1}${rc2}${rc3}${rc4} · ${G1} · ${G2} · ${G3} · ${G4}"

# ── T9 · no cambió nada; y sin reflog no se inventan commits ───────────────────────────────────────
# falla si: sin commits ni cambios, devolver no_medido o listas ausentes. Mutación: leer «reflog vacío»
# como «sin commits» cuando el reflog no existe → commits: [] en vez de null → rojo.
R="${BASE}/t9"; repo "${R}"
volcado "${BASE}/t9a.json" "${R}"
correr "${BASE}/t9a.json"
G1="$(leer "${BASE}/t9a.cambio.json.gz" 'const r=c.repos[0]; [c.estado, JSON.stringify(r.commits), JSON.stringify(r.sin_commitear)].join("|")')"
R="${BASE}/t9b"; repo "${R}"; git -C "${R}" config core.logAllRefUpdates false; rm -rf "${R}/.git/logs"; printf 'uno\nsin reflog\n' > "${R}/a.js"
volcado "${BASE}/t9b.json" "${R}"
correr "${BASE}/t9b.json"
G2="$(leer "${BASE}/t9b.cambio.json.gz" 'const r=c.repos[0]; [c.estado, JSON.stringify(r.commits), (r.commits_motivo||"").length>10, r.sin_commitear.length].join("|")')"
[ "${G1}" = "medido|[]|[]" ] && [ "${G2}" = "medido|null|true|1" ] && ok "T9 sin cambios: medido con listas vacías; sin reflog: commits null con motivo y lo no commiteado igual" || mal "T9 salió: ${G1} · ${G2}"

# ── T9b · lo que ya estaba sin commitear antes de la corrida no es de la corrida ─────────────────────
# falla si: tomar todo `git diff HEAD` → la copia sucia previa a la corrida se le atribuye a la corrida.
# Mutación: no filtrar por fecha de modificación → rojo.
# 🔴 La ventana va en el FUTURO a propósito: así lo que existe AHORA es «de antes de la corrida» de verdad
# (fecha de modificación Y de cambio de estado anteriores), que es lo que pasa con una copia sucia real. Con
# `touch -t` sólo se mueve la fecha de modificación, y eso no alcanza ante un renombrado.
R="${BASE}/t9c"; repo "${R}"
printf 'uno\nsucio de antes\n' > "${R}/a.js"; printf 'viejo sin trackear\n' > "${R}/viejo.txt"
printf 'base\nde la corrida\n' > "${R}/b.js"
FUT="$("${NODE}" -e 'const d=new Date(Date.now()+180000); const p=(n)=>String(n).padStart(2,"0"); console.log(`${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`)')"
touch -t "${FUT}" "${R}/b.js"
volcado_ventana "${BASE}/t9c.json" "${R}" 120 120
correr "${BASE}/t9c.json"
G="$(leer "${BASE}/t9c.cambio.json.gz" 'const r=c.repos[0]; [r.sin_commitear.map(p=>p.ruta).join(","), r.sin_commitear_previo, c.totales.archivos].join("|")')"
[ "${G}" = "b.js|2|1" ] && ok "T9b sólo entra lo modificado durante la corrida; lo sucio de antes se cuenta aparte (2)" || mal "T9b salió: ${G}"

# ── T21 · un rebase que CHOCA y se resuelve sigue siendo trabajo de la corrida ───────────────────────
# 🔴 falla si: al resolver un conflicto, git anota
# `rebase (continue):` / `commit (cherry-pick):` / `commit (merge):`, formas que una lista blanca sin ellas no reconoce.
# La corrida perdería TODOS sus commits y se archivaría como «medido, 0 archivos» — «no pude mirar» publicado
# como «no cambió nada», que es lo que esta pieza existe para evitar. Mutación: sacar `continue` de la lista.
O="${BASE}/t21origen"; repo "${O}"; git -C "${O}" config receive.denyCurrentBranch ignore
R="${BASE}/t21"; GIT_COMMITTER_DATE="${ANTES}" git clone -q "${O}" "${R}"
printf 'uno\nMI TRABAJO DE LA CORRIDA\n' > "${R}/a.js"; git -C "${R}" commit -qam "feat: trabajo de la corrida"
OTRO="${BASE}/t21otro"; git clone -q "${O}" "${OTRO}"
printf 'uno\nlo de otro en la misma linea\n' > "${OTRO}/a.js"; git -C "${OTRO}" commit -qam "otro: mismo renglon" && git -C "${OTRO}" push -q origin main 2>/dev/null
git -C "${R}" fetch -q
git -C "${R}" rebase -q origin/main > /dev/null 2>&1   # choca a propósito
printf 'uno\nlo de otro en la misma linea\nMI TRABAJO DE LA CORRIDA\n' > "${R}/a.js"
git -C "${R}" add a.js && GIT_EDITOR=true git -C "${R}" rebase --continue > /dev/null 2>&1
volcado "${BASE}/t21.json" "${R}"
correr "${BASE}/t21.json"
HEADC="$(git -C "${R}" rev-parse HEAD)"
G="$(leer "${BASE}/t21.cambio.json.gz" 'const r=c.repos[0]; [r.commits.length>0, r.commits.some(k=>"'"${HEADC}"'".startsWith(k.h)), JSON.stringify(r).includes("MI TRABAJO DE LA CORRIDA")].join("|")')"
[ "${G}" = "true|true|true" ] && ok "T21 el commit que salió de resolver el conflicto es de la corrida, con su cambio" || mal "T21 salió: ${G} (reflog: $(git -C "${R}" reflog --format=%gs -1))"

# ── T19 · si git no puede decir si es alta, baja o renombrado, el repo sale no_medido ────────────────
# falla si: el error de `--name-status` se lee como «vacío» y
# todos los archivos quedan «M», con la corrida en `medido` y sin aviso. Mutación: volver a tratar el
# error como cadena vacía → el repo sale «medido» con todo M → rojo.
R="${BASE}/t19"; repo "${R}"
printf 'uno\nmodificado\n' > "${R}/a.js"; rm "${R}/b.js"; printf 'nuevo\n' > "${R}/n.js"
volcado "${BASE}/t19.json" "${R}"
# un git de mentira que falla SÓLO en --name-status (lo demás pasa al git real)
mkdir -p "${BASE}/bin"
cat > "${BASE}/bin/git" <<'GIT'
#!/bin/sh
for a in "$@"; do [ "$a" = "--name-status" ] && { echo "fatal: name-status roto a propósito" >&2; exit 128; }; done
exec /usr/bin/git "$@"
GIT
chmod +x "${BASE}/bin/git"
env PATH="${BASE}/bin:${PATH}" "${NODE}" "${GUION}" --dump "${BASE}/t19.json" --state "${BASE}/estado" > "${BASE}/out" 2> "${BASE}/err"; rc=$?
G="$(leer "${BASE}/t19.cambio.json.gz" 'const r=c.repos[0]; [c.estado, r.estado, /name-status|git/.test(r.motivo||""), !("sin_commitear" in r), /ninguno/.test(c.motivo||"")].join("|")')"
[ "${rc}" = 0 ] && [ "${G}" = "no_medido|no_medido|true|true|true" ] && ok "T19 el error de --name-status deja ESE repo no_medido con motivo; sin ningún repo medido, la corrida entera es no_medido" || mal "T19 (rc=${rc}) salió: ${G}"

# ── T20 · el motivo de un repo sin historial sale saneado ─────────────────────────────────────────────
# falla si: `commits_motivo` se publica sin
# pasar por `sanear`, y el motivo lleva el error crudo de git, que puede traer la ruta del disco.
R="${BASE}/t20"; repo "${R}"; printf 'uno\nx\n' > "${R}/a.js"
volcado "${BASE}/t20.json" "${R}"
# un git de mentira que falla al leer el reflog, con una ruta del disco en el error (como git de verdad)
mkdir -p "${BASE}/bin20"
cat > "${BASE}/bin20/git" <<'GIT'
#!/bin/sh
for a in "$@"; do [ "$a" = "reflog" ] && { echo "fatal: no pude leer /Users/fulano/SourceCode/ClienteSecreto/.git/logs/HEAD" >&2; exit 128; }; done
exec /usr/bin/git "$@"
GIT
chmod +x "${BASE}/bin20/git"
env PATH="${BASE}/bin20:${PATH}" "${NODE}" "${GUION}" --dump "${BASE}/t20.json" --state "${BASE}/estado" > "${BASE}/out" 2> "${BASE}/err"
G="$(leer "${BASE}/t20.cambio.json.gz" 'const r=c.repos[0]; [typeof r.commits_motivo, /<ruta>/.test(r.commits_motivo||""), !/fulano|ClienteSecreto/.test(JSON.stringify(c))].join("|")')"
[ "${G}" = "string|true|true" ] && ok "T20 el motivo que trae el error de git viaja saneado: la ruta sale tapada" || mal "T20 salió: ${G}"

# ── T23 · un merge con conflicto: estado y parche de cada archivo, no el diff combinado ──────────────
# 🔴 falla si: en un merge, `git show --numstat` da el diff contra el primer padre pero
# `--name-status` y el parche por archivo dan el COMBINADO: el borrado y el traído salen «modificado» y sin
# texto. Mutación: volver a `show` en vez de `diff <primer padre>` → rojo.
R="${BASE}/t23"; repo "${R}"; printf 'borrar\n' > "${R}/borrar.txt"; git -C "${R}" add -A
GIT_COMMITTER_DATE="${ANTES}" GIT_AUTHOR_DATE="${ANTES}" git -C "${R}" commit -qm "base con borrar.txt"
git -C "${R}" checkout -q -b rama; printf 'uno\nde la rama\n' > "${R}/a.js"; printf 'traido\n' > "${R}/traido.txt"
git -C "${R}" rm -q "${R}/borrar.txt" 2>/dev/null || git -C "${R}" rm -q borrar.txt
git -C "${R}" add -A && git -C "${R}" commit -qm "rama: cambios"
git -C "${R}" checkout -q main && printf 'uno\nde main\n' > "${R}/a.js" && git -C "${R}" commit -qam "main: cambio"
git -C "${R}" merge rama > /dev/null 2>&1
printf 'uno\nRESUELTO A MANO\n' > "${R}/a.js"; git -C "${R}" add -A; git -C "${R}" commit -qm "merge resuelto" > /dev/null
volcado "${BASE}/t23.json" "${R}"
correr "${BASE}/t23.json"
G="$(leer "${BASE}/t23.cambio.json.gz" '
  const k=(c.repos[0].commits||[]).find(x=>/merge resuelto/.test(x.asunto));
  if(!k) "sin-commit-de-merge"; else {
    const m=Object.fromEntries(k.archivos.map(p=>[p.ruta,p.estado]));
    const a=k.archivos.find(p=>p.ruta==="a.js"), t=k.archivos.find(p=>p.ruta==="traido.txt");
    [m["a.js"], m["borrar.txt"], m["traido.txt"], /RESUELTO A MANO/.test(a&&a.parche||""), !!(t&&t.parche&&t.parche.length)].join("|"); }')"
[ "${G}" = "M|D|A|true|true" ] && ok "T23 en el merge con conflicto: el borrado dice borrado, el traído dice nuevo, y los dos traen su cambio" || mal "T23 salió: ${G}"

# ── T24 · un renombrado sin commitear hecho por la corrida NO es «sucio de antes» ─────────────────────
# 🔴 falla si: `mv` conserva la fecha de modificación, así que el filtro por fecha lo
# descarta y la corrida sale «sin cambios». Mutación: volver a mirar sólo `mtime` → rojo.
R="${BASE}/t24"; repo "${R}"; printf 'contenido de siempre\n' > "${R}/viejo.js"; git -C "${R}" add -A
GIT_COMMITTER_DATE="${ANTES}" GIT_AUTHOR_DATE="${ANTES}" git -C "${R}" commit -qm "con viejo.js"
touch -t 202601010000 "${R}/viejo.js"; git -C "${R}" mv viejo.js nuevo.js
volcado "${BASE}/t24.json" "${R}"
correr "${BASE}/t24.json"
# y lo mismo para uno SIN trackear que la corrida movió
printf 'suelto de antes\n' > "${R}/suelto.txt"; touch -t 202601010000 "${R}/suelto.txt"; mv "${R}/suelto.txt" "${R}/movido.txt"
correr "${BASE}/t24.json"
G="$(leer "${BASE}/t24.cambio.json.gz" 'const r=c.repos[0]; [r.sin_commitear.map(p=>p.estado+":"+p.ruta).sort().join(","), r.sin_commitear_previo].join("|")')"
[ "${G}" = "A:movido.txt,R:nuevo.js|0" ] && ok "T24 el renombrado entra, trackeado o no (la fecha de modificación no alcanza en ninguno de los dos)" || mal "T24 salió: ${G}"

# ── T25 · un nombre con corchetes es un NOMBRE, no un comodín ─────────────────────────────────────────
# 🔴 falla si: sin `--literal-pathspecs`, `app/[id]/page.tsx` se lee como patrón y el
# parche se trae el de otros archivos. Mutación: sacar `--literal-pathspecs` → rojo.
R="${BASE}/t25"; repo "${R}"; mkdir -p "${R}/app/[id]" "${R}/app/i"
# los dos ya versionados ANTES de la corrida: el del corchete y el que un comodín `[id]` matchearía («i»)
printf 'pagina dinamica\n' > "${R}/app/[id]/page.tsx"; printf 'pagina de la i\n' > "${R}/app/i/page.tsx"
git -C "${R}" add -A && GIT_COMMITTER_DATE="${ANTES}" GIT_AUTHOR_DATE="${ANTES}" git -C "${R}" commit -qm "con rutas dinamicas"
# la corrida cambia los dos
printf 'pagina dinamica\nCAMBIO EN EL CORCHETE\n' > "${R}/app/[id]/page.tsx"
printf 'pagina de la i\nCAMBIO EN LA I\n' > "${R}/app/i/page.tsx"
volcado "${BASE}/t25.json" "${R}"
correr "${BASE}/t25.json"
G="$(leer "${BASE}/t25.cambio.json.gz" '
  const p=c.repos[0].sin_commitear.find(x=>x.ruta.includes("[id]"));
  [!!p, p?/CAMBIO EN EL CORCHETE/.test(p.parche||""):false, p?!/CAMBIO EN LA I/.test(p.parche||""):false].join("|")')"
[ "${G}" = "true|true|true" ] && ok "T25 el archivo con corchetes trae SU cambio, no el del que matchearía el comodín" || mal "T25 salió: ${G}"

# ── T26 · un enlace simbólico nuevo entra (git lo versiona) ───────────────────────────────────────────
# 🔴 falla si: `if (!st2.isFile()) continue;` lo descarta en silencio. Mutación:
# volver a saltear lo que no es archivo → rojo.
R="${BASE}/t26"; repo "${R}"; ln -s a.js "${R}/atajo.js"
volcado "${BASE}/t26.json" "${R}"
correr "${BASE}/t26.json"
G="$(leer "${BASE}/t26.cambio.json.gz" 'const p=c.repos[0].sin_commitear.find(x=>x.ruta==="atajo.js"); [!!p, p?/a\.js/.test(p.parche||""):false].join("|")')"
[ "${G}" = "true|true" ] && ok "T26 el enlace simbólico nuevo entra, con su destino como cambio" || mal "T26 salió: ${G}"

# ── T27 · en una copia compartida, cada commit se atribuye con el hilo de la conversación ──────────────
# 🔴 falla si: sin atribución los tres commits salen como de la corrida. Mutaciones: no mirar la hora (B entra), no pedir
# que el comando lo nombre (C sale sin marca), o esconder lo ajeno sin listarlo (B desaparece).
R="${BASE}/t27"; repo "${R}"
GIT_COMMITTER_DATE="$("${NODE}" -e 'console.log(new Date(Date.now()-300000).toISOString())')" GIT_AUTHOR_DATE="${ANTES}" bash -c 'printf "ajeno\n" > "$1/z.js"; git -C "$1" add z.js; git -C "$1" commit -qm "ajeno: la otra sesión commitea z.js"' _ "${R}"
GIT_COMMITTER_DATE="$("${NODE}" -e 'console.log(new Date(Date.now()-200000).toISOString())')" GIT_AUTHOR_DATE="${ANTES}" bash -c 'printf "dudoso\n" > "$1/y.js"; git -C "$1" add y.js; git -C "$1" commit -qm "dudoso: mientras corría un ls"' _ "${R}"
printf 'uno\npropio\n' > "${R}/a.js"; git -C "${R}" commit -qam "propio: la corrida toca a.js"
TA="$(git -C "${R}" log -1 --format=%cI)"
V="${BASE}/t27v.json"; volcado "${V}" "${R}"
mkdir -p "${BASE}/estado/file-events"
"${NODE}" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({path: process.argv[2], ts: new Date(Date.now()-250000).toISOString()})+"\n")' "${BASE}/estado/file-events/otra-sesion.jsonl" "${R}/z.js"
# el hilo: un Bash con `git commit` alrededor del commit propio, un `ls` alrededor del dudoso, nada alrededor del ajeno
"${NODE}" -e '
  const zlib=require("zlib"), [f, ta]=process.argv.slice(1), tA=Date.parse(ta), tC=Date.now()-200000, t0=Date.now()-600000;
  const uso=(t,id,cmd)=>({type:"assistant",timestamp:new Date(t).toISOString(),message:{content:[{type:"tool_use",id,name:"Bash",input:{command:cmd}}]}});
  const res=(t,id,txt)=>({type:"user",timestamp:new Date(t).toISOString(),message:{content:[{type:"tool_result",tool_use_id:id,content:txt}]}});
  const l=[{type:"user",timestamp:new Date(t0).toISOString(),message:{content:"arrancamos"}},
    uso(tC-1000,"c","ls -la"), res(tC+1000,"c","a.js"),
    uso(tA-1500,"a","git -C . commit -qam \"propio: la corrida toca a.js\""), res(tA+1500,"a","[main abc] propio"),
    {type:"user",timestamp:new Date().toISOString(),message:{content:"fin"}}];
  require("fs").writeFileSync(f, zlib.gzipSync(l.map(x=>JSON.stringify(x)).join("\n")+"\n"));' "${BASE}/t27v.hilo.jsonl.gz" "${TA}"
correr "${V}"
G="$(leer "${BASE}/t27v.cambio.json.gz" 'const r=c.repos[0]; [c.estado, r.otras_sesiones, r.commits.map(k=>k.asunto.split(":")[0]+"="+(k.atribucion||"propio")).join(","), (r.commits_de_otras_sesiones||[]).map(k=>k.asunto.split(":")[0]+":"+k.h.length).join(","), "atribucion_motivo" in r].join("|")')"
[ "${G}" = "medido|1|dudoso=coincide_la_hora,propio=propio|ajeno:12|false" ] && ok "T27 propio sin marca, el de la hora coincidente marcado, y el ajeno afuera pero listado con su asunto" || mal "T27 salió: ${G}"
# sin el hilo no se puede atribuir: todos quedan, marcados, con el motivo en el repo
rm -f "${BASE}/t27v.hilo.jsonl.gz"; correr "${V}"
G="$(leer "${BASE}/t27v.cambio.json.gz" 'const r=c.repos[0]; [r.commits.length, r.commits.every(k=>k.atribucion==="sin_constancia"), (r.commits_de_otras_sesiones||[]).length, /hilo/.test(r.atribucion_motivo||"")].join("|")')"
[ "${G}" = "3|true|0|true" ] && ok "T27b sin hilo, los tres quedan marcados «sin constancia» y el repo dice por qué" || mal "T27b salió: ${G}"
# copia NO compartida: nada de esto aplica, ni aparecen los campos
rm -f "${BASE}/estado/file-events/"*.jsonl; correr "${V}"
G="$(leer "${BASE}/t27v.cambio.json.gz" 'const r=c.repos[0]; [r.otras_sesiones, r.commits.length, r.commits.some(k=>"atribucion" in k), "commits_de_otras_sesiones" in r].join("|")')"
[ "${G}" = "0|3|false|false" ] && ok "T27c en una copia de una sola sesión no se atribuye nada" || mal "T27c salió: ${G}"

# ── Cambio_GuardaProyectoDeAzure (T25) ──────────────────────────────────
# Cada repo del cambio guarda también el PROYECTO de Azure de su remoto, para ubicar la corrida en un producto
# de repos.json por `<proyecto>/<repo>`. Forma elegida: como `nombre`, DECODIFICADO y con la caja que escribe el
# remoto (`Beta%20Dos` → «Beta Dos»; `identidadAzure` decodifica igual, pero baja a minúsculas: comparar sin
# distinguir mayúsculas es de quien lee). Un remoto que no es de Azure, o ningún remoto: `proyecto: null`, presente.
# 🔴 falla si: sin el campo, `"proyecto" in r` es false en los cuatro. Mutaciones: tomar la ORG en vez del
# proyecto (sale «acme»), no decodificar (sale «Beta%20Dos»), o devolver la forma en minúsculas (sale «beta»).
for par in "t228az|https://dev.azure.com/acme/Beta/_git/Project" "t228esp|https://dev.azure.com/acme/Beta%20Dos/_git/Back" \
           "t228gh|https://github.com/acme/Front.git" "t228sin|"; do
  D="${par%%|*}"; U="${par#*|}"; R="${BASE}/${D}"; repo "${R}"
  [ -n "${U}" ] && git -C "${R}" remote add origin "${U}"
  printf 'uno\ncambio\n' > "${R}/a.js"
  volcado "${BASE}/${D}.json" "${R}"
  correr "${BASE}/${D}.json"; rc=$?
  [ "${rc}" = 0 ] || mal "2.28-Cambio_GuardaProyectoDeAzure ${D}: run-change salió ${rc}: $(head -c 300 "${BASE}/err")"
done
G="$(leer "${BASE}/t228az.cambio.json.gz" 'const r=c.repos[0]; [c.estado, "proyecto" in r, JSON.stringify(r.proyecto), r.nombre].join("|")')"
[ "${G}" = 'medido|true|"Beta"|Project' ] && ok "2.28-Cambio_GuardaProyectoDeAzure el remoto de Azure guarda proyecto «Beta» y nombre «Project»" || mal "2.28-Cambio_GuardaProyectoDeAzure Azure salió: ${G}"
G="$(leer "${BASE}/t228esp.cambio.json.gz" 'const r=c.repos[0]; ["proyecto" in r, JSON.stringify(r.proyecto), r.nombre].join("|")')"
[ "${G}" = 'true|"Beta Dos"|Back' ] && ok "2.28-Cambio_GuardaProyectoDeAzure el proyecto con espacio codificado se guarda decodificado («Beta Dos»)" || mal "2.28-Cambio_GuardaProyectoDeAzure espacio salió: ${G}"
G="$(leer "${BASE}/t228gh.cambio.json.gz" 'const r=c.repos[0]; ["proyecto" in r, JSON.stringify(r.proyecto), r.nombre].join("|")')"
[ "${G}" = 'true|null|Front' ] && ok "2.28-Cambio_GuardaProyectoDeAzure el remoto de GitHub guarda proyecto null y el nombre de hoy" || mal "2.28-Cambio_GuardaProyectoDeAzure GitHub salió: ${G}"
G="$(leer "${BASE}/t228sin.cambio.json.gz" 'const r=c.repos[0]; ["proyecto" in r, JSON.stringify(r.proyecto), r.nombre].join("|")')"
[ "${G}" = 'true|null|t228sin' ] && ok "2.28-Cambio_GuardaProyectoDeAzure sin remoto, proyecto null y el nombre de la carpeta" || mal "2.28-Cambio_GuardaProyectoDeAzure sin remoto salió: ${G}"

# ── argumentos inválidos ────────────────────────────────────────────────────────────────────
"${NODE}" "${GUION}" > "${BASE}/out" 2> "${BASE}/err"; rc=$?
[ "${rc}" != 0 ] && ok "T10 sin --dump sale ≠ 0" || mal "T10 sin argumentos salió 0"

echo
echo "${FALLOS} fallo(s)"
[ "${FALLOS}" = 0 ]
