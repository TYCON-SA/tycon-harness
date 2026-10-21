#!/usr/bin/env bash
# nightly-dod-notice.test.sh — el aviso por Telegram de la evidencia DoD del nocturno.
#
# Sin red y sin tocar nada de esta máquina: cada caso arma un repo git temporal con su propio
# `origin` (bare), un clon «publicador» que empuja los snapshots como lo haría el nocturno de Azure,
# y un clon «checkout» parado donde diga el caso — que es lo que el LaunchAgent lee. El envío es un
# DOBLE que anota cada llamada y sale con el código que el caso le pida.
#
# 🔴 AISLAMIENTO, antes del primer caso: HOME falso, token vacío, API de Telegram apuntada a un
#    puerto local cerrado y carpeta del canal inexistente. Ni un error de cableado (el guion
#    llamando al script real en vez del doble) puede llegar al Telegram de verdad.
#
# 🔴 REGLA DE ADMISIÓN: cada caso dice cómo falla contra un guion sin el arreglo
#    (`AVISO_GUION=<guion viejo> bash scripts/tests/nightly-dod-notice.test.sh`). Los que no se ponen
#    rojos lo dicen y son de no-regresión. El exit code se lee ANTES de cualquier pipe.
#    Corre con /bin/bash, que en macOS es 3.2: la misma versión que usa el LaunchAgent.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUION="${AVISO_GUION:-${RAIZ}/scripts/ci/nightly-dod-notice.sh}"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

echo "== nightly-dod-notice.test.sh =="
[ -f "${GUION}" ] || { mal "no existe ${GUION}"; echo; echo "${FALLOS} fallo(s)"; exit 1; }

BASE="$(mktemp -d)"
trap 'rm -rf "${BASE}"' EXIT
mkdir -p "${BASE}/home"; export HOME="${BASE}/home"
export TELEGRAM_BOT_TOKEN=""
export TYCON_TELEGRAM_API="http://127.0.0.1:9"
export TYCON_TELEGRAM_DIR="${BASE}/home/sin-canal"
unset TYCON_TELEGRAM_CHAT_ID TYCON_NOTICE_DRYRUN TYCON_NOTICE_STATE_DIR TYCON_NOTICE_RETRIES TYCON_GUIDES_DIR
export TYCON_NOTICE_WAIT_S=0
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="${BASE}/home/.gitconfig"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
: > "${GIT_CONFIG_GLOBAL}"

HOY="$(date -u +%Y-%m-%d)"
AYER="$(python3 -c "import datetime as d;print((d.date.fromisoformat('${HOY}')-d.timedelta(days=1)).isoformat())")"
MANANA="$(python3 -c "import datetime as d;print((d.date.fromisoformat('${HOY}')+d.timedelta(days=1)).isoformat())")"
export TYCON_NOTICE_TODAY="${HOY}"
TAB="$(printf '\t')"

F="${BASE}/f"; CO="${F}/co"; PUB="${F}/pub"; D="${BASE}/doble"; OUT="${BASE}/out"; RC=0
export DOUBLE_DIR="${D}"

# ── el doble del envío ──────────────────────────────────────────────────────────────────────────
# `codigos`: un código de salida por línea, uno por llamada; pasada la última línea, repite la última.
cat > "${BASE}/doble.sh" <<'SH'
#!/usr/bin/env bash
n=$(( $(cat "${DOUBLE_DIR}/n" 2>/dev/null || echo 0) + 1 )); echo "${n}" > "${DOUBLE_DIR}/n"
{ echo "--- llamada ${n}"; printf '%s\n' "$*"; } >> "${DOUBLE_DIR}/llamadas"
printf '%s' "$1" > "${DOUBLE_DIR}/msg-${n}"
rc="$(sed -n "${n}p" "${DOUBLE_DIR}/codigos" 2>/dev/null)"
[ -n "${rc}" ] || rc="$(tail -n 1 "${DOUBLE_DIR}/codigos" 2>/dev/null)"
rc="${rc:-0}"
if [ "${rc}" != "0" ]; then
  echo "⚠ telegram-notify: Telegram rechazó el envío — curl: (6) Could not resolve host: api.telegram.org" >&2
  exit "${rc}"
fi
echo 4242
SH
chmod +x "${BASE}/doble.sh"
export TYCON_NOTICE_NOTIFY="${BASE}/doble.sh"

# ── fixtures ────────────────────────────────────────────────────────────────────────────────────
repo() { printf '{"repo":"/x/%s","dod_evidence_ratio":{"num":%s,"den":100}}' "$1" "$2"; }
# repo_ruta <ruta completa> <num> <den> — como los snapshots de una corrida local (/Users/.../Proyecto/Repo)
repo_ruta() { printf '{"repo":"%s","dod_evidence_ratio":{"num":%s,"den":%s}}' "$1" "$2" "$3"; }
# repo_sin_medir <nombre> — sigue en el snapshot pero sin medición (dod_evidence_ratio null)
repo_sin_medir() { printf '{"repo":"/x/%s","dod_evidence_ratio":null}' "$1"; }
snap() { printf '{"global":{"dod_evidence_ratio":{"num":%s,"den":100}},"repos":[%s]}\n' "$2" "$3" > "$1"; }

# armar <repos de ayer | "-" sin snapshot de ayer> [num global de ayer]
# Deja: origin con AYER publicado, y el checkout clonado en ese momento (o sea, atrasado respecto
# de lo que se publique después), parado en main.
armar() {
  rm -rf "${F}" "${D}" "${BASE}/estado"; mkdir -p "${F}" "${D}"
  export TYCON_NOTICE_STATE_DIR="${BASE}/estado"   # cada caso con su propio estado (T15/T16 miran el default)
  git init -q --bare "${F}/origin.git"
  git -C "${F}/origin.git" symbolic-ref HEAD refs/heads/main
  git init -q "${PUB}"; git -C "${PUB}" checkout -q -b main
  git -C "${PUB}" remote add origin "${F}/origin.git"
  mkdir -p "${PUB}/scripts/lib" "${PUB}/.dashboard"
  # El doble también vive donde el guion lo busca sin TYCON_NOTICE_NOTIFY: `scripts/lib/`.
  # T33 lo usa así; sólo ahí (sin el reemplazo de la ruta vieja) se ve si el default apunta a la ruta nueva.
  printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "${BASE}/doble.sh" > "${PUB}/scripts/lib/tycon-telegram-notify.sh"
  chmod +x "${PUB}/scripts/lib/tycon-telegram-notify.sh"
  echo "arnés de prueba" > "${PUB}/README.md"
  if [ "$1" != "-" ]; then snap "${PUB}/.dashboard/sdlc-stage-${AYER}.json" "${2:-10}" "$1"; fi
  git -C "${PUB}" add -A; git -C "${PUB}" commit -qm ayer; git -C "${PUB}" push -q origin main
  git clone -q "${F}/origin.git" "${CO}"
}
# publicar <fecha> <num global> <repos>   |   publicar_crudo <fecha> <contenido>
publicar() { snap "${PUB}/.dashboard/sdlc-stage-$1.json" "$2" "$3"; git -C "${PUB}" add -A; git -C "${PUB}" commit -qm "snapshot $1"; git -C "${PUB}" push -q origin main; }
publicar_crudo() { printf '%s' "$2" > "${PUB}/.dashboard/sdlc-stage-$1.json"; git -C "${PUB}" add -A; git -C "${PUB}" commit -qm "snapshot $1"; git -C "${PUB}" push -q origin main; }
rama_divergida() { git -C "${CO}" checkout -q -b story/otra; echo propio > "${CO}/propio.txt"; git -C "${CO}" add propio.txt; git -C "${CO}" commit -qm propio; }
codigos() { printf '%s\n' "$@" > "${D}/codigos"; rm -f "${D}/n" "${D}/llamadas"; }
correr() { TYCON_GUIDES_DIR="${CO}" /bin/bash "${GUION}" > "${OUT}" 2>&1; RC=$?; }
llamadas() { cat "${D}/n" 2>/dev/null || echo 0; }
enviado() { cat "${D}/llamadas" 2>/dev/null; }
foto() { { git -C "${CO}" branch --show-current; git -C "${CO}" rev-parse HEAD; git -C "${CO}" status --porcelain; git -C "${CO}" diff; git -C "${CO}" diff --cached; } 2>&1; }
contiene() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

# ── T1 ───────────────────────────────────────────────────────────────────────────────────
# Falla si el guion lee el disco de la rama: avisa «NO corrió hoy».
echo "T1 RamaDivergida_SnapshotPublicado_AvisaCambio"
armar "$(repo A__A 10)"; rama_divergida; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0; correr
MSG="$(enviado)"; cp "${OUT}" "${BASE}/out-t1"
if [ "${RC}" = 0 ] && contiene "${MSG}" "Se movió la evidencia DoD del nocturno: 10% (10/100) -> 20% (20/100). A__A: 10% (10/100) -> 20% (20/100)" \
   && ! contiene "${MSG}" "no está publicado" && ! contiene "${MSG}" "NO corrió"; then ok "T1 avisa el cambio publicado aunque el checkout esté en otra rama"
else mal "T1 rc=${RC} enviado=[${MSG}] salida=[$(cat "${OUT}")]"; fi

# ── T2 ───────────────────────────────────────────────────────────────────────────────────
# No-regresión: con la rama divergida y el árbol sucio, un guion que hiciera merge fallaría solo.
echo "T2 RamaDivergida_CheckoutIntacto"
armar "$(repo A__A 10)"; rama_divergida
echo cambio >> "${CO}/propio.txt"; echo nuevo > "${CO}/stageado.txt"; git -C "${CO}" add stageado.txt
ANTES="$(foto)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0; correr; DESPUES="$(foto)"
if [ "${ANTES}" = "${DESPUES}" ]; then ok "T2 rama, HEAD, índice y árbol idénticos"
else mal "T2 el checkout cambió: antes=[${ANTES}] después=[${DESPUES}]"; fi

# ── T3 ───────────────────────────────────────────────────────────────────────────────────
# Falla si el guion le hace fast-forward a la rama.
echo "T3 RamaAtrasadaSinDivergir_NoLaMueve"
armar "$(repo A__A 10)"; git -C "${CO}" checkout -q -b story/otra
ANTES="$(foto)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0; correr; DESPUES="$(foto)"
if [ "${ANTES}" = "${DESPUES}" ]; then ok "T3 la rama sin divergir no se mueve"
else mal "T3 la rama se movió: antes=[${ANTES}] después=[${DESPUES}]"; fi

# ── T4 ───────────────────────────────────────────────────────────────────────────────────
# Falla si el guion avanza main en el checkout.
echo "T4 CheckoutEnMain_NoLoMueve"
armar "$(repo A__A 10)"
ANTES="$(foto)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0; correr; DESPUES="$(foto)"
PUBLICADO="$(git -C "${PUB}" rev-parse HEAD)"; REF="$(git -C "${CO}" rev-parse refs/remotes/origin/main 2>/dev/null)"
if [ "${ANTES}" = "${DESPUES}" ] && [ "${REF}" = "${PUBLICADO}" ]; then ok "T4 main del checkout quieto; origin/main al día"
else mal "T4 antes=[${ANTES}] después=[${DESPUES}] origin/main=${REF} publicado=${PUBLICADO}"; fi

# ── T5 ───────────────────────────────────────────────────────────────────────────────────
# Falla si el guion tiene `git -C "$REPO" merge -q --ff-only origin/main`.
echo "T5 GuionSinComandosQueEscriben"
ESCRIBEN="$(grep -vE '^[[:space:]]*#' "${GUION}" | grep -nE 'git([[:space:]]+-[A-Za-z]+([[:space:]]+"?[^[:space:]]+"?)?)*[[:space:]]+(merge|pull|checkout|reset|stash|rebase)([[:space:]]|$)')"
if [ -z "${ESCRIBEN}" ]; then ok "T5 ni merge, ni pull, ni checkout, ni reset, ni stash, ni rebase"
else mal "T5 el guion escribe en el checkout: ${ESCRIBEN}"; fi

# ── T6 ───────────────────────────────────────────────────────────────────────────────────
# Sin `remote.origin.fetch`, `git fetch origin main` no actualiza origin/main.
echo "T6 Fetch_UsaRefspecExplicito"
armar "$(repo A__A 10)"; rama_divergida; git -C "${CO}" config --unset-all remote.origin.fetch
publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0; correr
REF="$(git -C "${CO}" rev-parse refs/remotes/origin/main 2>/dev/null)"
if [ "${REF}" = "$(git -C "${PUB}" rev-parse HEAD)" ] && contiene "$(enviado)" "Se movió la evidencia DoD"; then ok "T6 el refspec explícito trae main aunque el remoto no tenga fetch configurado"
else mal "T6 origin/main=${REF} enviado=[$(enviado)] salida=[$(cat "${OUT}")]"; fi

# ── T7 ───────────────────────────────────────────────────────────────────────────────────
# Falla si, con el remoto inalcanzable, el guion avisa «NO corrió hoy» y sale 0.
echo "T7 FetchFalla_SinHoyLocal_NoPudeMirar"
armar "$(repo A__A 10)"; rama_divergida; publicar "${HOY}" 20 "$(repo A__A 20)"
git -C "${CO}" remote set-url origin "${F}/no-existe.git"; codigos 0; correr; MSG="$(enviado)"
if [ "${RC}" = 2 ] && contiene "${MSG}" "no pude mirar" && contiene "${MSG}" "no-existe" \
   && ! contiene "${MSG}" "NO corrió" && ! contiene "${MSG}" "no está publicado"; then ok "T7 fetch fallido = «no pude mirar» con el motivo, exit 2"
else mal "T7 rc=${RC} enviado=[${MSG}] salida=[$(cat "${OUT}")]"; fi

# ── T8 ───────────────────────────────────────────────────────────────────────────────────
# Falla si el guion lee el disco de la rama divergida, no la referencia ya traída.
echo "T8 FetchFalla_ConHoyLocal_ComparaNormal"
armar "$(repo A__A 10)"; rama_divergida; publicar "${HOY}" 20 "$(repo A__A 20)"
git -C "${CO}" fetch -q origin; git -C "${CO}" remote set-url origin "${F}/no-existe.git"; codigos 0; correr
if [ "${RC}" = 0 ] && contiene "$(enviado)" "Se movió la evidencia DoD del nocturno: 10% (10/100) -> 20% (20/100)"; then ok "T8 con el de hoy ya en la referencia local, compara"
else mal "T8 rc=${RC} enviado=[$(enviado)] salida=[$(cat "${OUT}")]"; fi

# ── T9 ───────────────────────────────────────────────────────────────────────────────────
# Falla si el guion afirma «NO corrió hoy».
echo "T9 FetchOk_SinHoy_DiceLoObservado"
armar "$(repo A__A 10)"; codigos 0; correr; MSG="$(enviado)"
if [ "${RC}" = 0 ] && contiene "${MSG}" "no está publicado en main a las " && contiene "${MSG}" " UTC" \
   && contiene "${MSG}" "(${HOY})" && contiene "${MSG}" "el último es del ${AYER}" && ! contiene "${MSG}" "NO corrió"; then ok "T9 dice lo observado, sin afirmar que no corrió"
else mal "T9 rc=${RC} enviado=[${MSG}]"; fi

# ── T10 ──────────────────────────────────────────────────────────────────────────────────
# Falla si, sin origin, el guion lee el disco y avisa «NO corrió hoy».
echo "T10 SinRefOrigenMain_NoPudeMirar"
armar "$(repo A__A 10)"; git -C "${CO}" remote remove origin; codigos 0; correr; MSG="$(enviado)"
if [ "${RC}" = 2 ] && contiene "${MSG}" "no pude mirar" && ! contiene "${MSG}" "NO corrió"; then ok "T10 sin origin/main = «no pude mirar», exit 2"
else mal "T10 rc=${RC} enviado=[${MSG}] salida=[$(cat "${OUT}")]"; fi

# ── T11 ──────────────────────────────────────────────────────────────────────────────────
# Falla con KeyError en porrepo() → «salida inesperada del comparador», sin aviso, exit 3.
echo "T11 RepoNuevo_NoRevienta"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 10),$(repo N__N 10)"; codigos 0; correr; MSG="$(enviado)"
if [ "${RC}" = 0 ] && contiene "${MSG}" "N__N: nuevo -> 10% (10/100)" && ! grep -q Traceback "${OUT}"; then ok "T11 el repo nuevo se nombra como nuevo"
else mal "T11 rc=${RC} enviado=[${MSG}] salida=[$(cat "${OUT}")]"; fi

# ── T12 ──────────────────────────────────────────────────────────────────────────────────
# Falla si el guion recorre sólo los repos de hoy — el que salió no aparece.
echo "T12 RepoQueSalio_LoNombra"
armar "$(repo A__A 10),$(repo X__X 5)" 15; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0; correr; MSG="$(enviado)"
if [ "${RC}" = 0 ] && contiene "${MSG}" "X__X: 5% (5/100) -> salió"; then ok "T12 el repo que salió se nombra"
else mal "T12 rc=${RC} enviado=[${MSG}] salida=[$(cat "${OUT}")]"; fi

# ── T13 ─────────────────────────────────────────────────────────────────────────────────
# Falla con JSONDecodeError → «salida inesperada», sin aviso, exit 3.
echo "T13 JsonRoto_NoPudeComparar"
armar "$(repo A__A 10)"; publicar_crudo "${HOY}" '{roto'; codigos 0; correr; MSG="$(enviado)"
if [ "${RC}" = 2 ] && contiene "${MSG}" "no pude comparar los snapshots" && ! contiene "${MSG}" "salida inesperada"; then ok "T13 un snapshot roto se avisa como «no pude comparar», exit 2"
else mal "T13 rc=${RC} enviado=[${MSG}] salida=[$(cat "${OUT}")]"; fi

# ── T14 ─────────────────────────────────────────────────────────────────────────────────
# Falla si el guion no reintenta (1 llamada, aviso perdido, exit 0).
echo "T14 EnvioFallaYReintentoSale_EntregaUnaVez"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 3 0
export TYCON_NOTICE_STATE_DIR="${BASE}/estado-t14"; correr
if [ "${RC}" = 0 ] && [ "$(llamadas)" = 2 ] && [ ! -s "${BASE}/estado-t14/pendientes.tsv" ]; then ok "T14 el reintento entrega, sin pendientes"
else mal "T14 rc=${RC} llamadas=$(llamadas) pendientes=[$(cat "${BASE}/estado-t14/pendientes.tsv" 2>/dev/null)]"; fi

# ── T15 ─────────────────────────────────────────────────────────────────────────────────
# Falla con exit 0, una sola llamada, ninguna línea con fecha, nada guardado.
# Sin TYCON_NOTICE_STATE_DIR: verifica también el lugar por defecto (bajo el HOME falso).
echo "T15 EnvioFallaSiempre_QuedaDicho"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 3
unset TYCON_NOTICE_STATE_DIR; PEND="${HOME}/.claude/.tycon-pipeline/aviso-dod/pendientes.tsv"; rm -f "${PEND}"
TYCON_NOTICE_RETRIES=3 correr; cp "${OUT}" "${BASE}/out-t15"
LINEA="$(grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z aviso-dod: .*NO SE ENTREGÓ' "${OUT}")"
if [ "${RC}" = 3 ] && [ "$(llamadas)" = 3 ] && contiene "${LINEA}" "curl: (6) Could not resolve host" \
   && contiene "${LINEA}" "Se movió la evidencia DoD del nocturno" && grep -q "^${HOY}${TAB}Se movió la evidencia DoD" "${PEND}" 2>/dev/null; then ok "T15 queda dicho: línea con fecha, motivo, texto, pendiente guardado, exit 3"
else mal "T15 rc=${RC} llamadas=$(llamadas) línea=[${LINEA}] pendientes=[$(cat "${PEND}" 2>/dev/null)] salida=[$(cat "${OUT}")]"; fi

# ── T16 ─────────────────────────────────────────────────────────────────────────────────
# Continúa T15 (mismo HOME). Mañana sin cambios: igual se entrega lo pendiente.
# Falla si el guion no guarda nada → no hay qué entregar.
echo "T16 PendienteSeEntregaAlDiaSiguiente"
publicar "${MANANA}" 20 "$(repo A__A 20)"; codigos 0
TYCON_NOTICE_TODAY="${MANANA}" correr; MSG="$(enviado)"
if [ "${RC}" = 0 ] && [ "$(llamadas)" = 1 ] && contiene "${MSG}" "(aviso del ${HOY} que no se pudo entregar) Se movió la evidencia DoD" \
   && [ ! -s "${PEND}" ]; then ok "T16 el pendiente llega al día siguiente, en un solo mensaje, y se borra"
else mal "T16 rc=${RC} llamadas=$(llamadas) enviado=[${MSG}] pendientes=[$(cat "${PEND}" 2>/dev/null)] salida=[$(cat "${OUT}")]"; fi

# ── T17 ─────────────────────────────────────────────────────────────────────────────────
# Falla si no se guarda nada (0 líneas, no 1).
echo "T17 PendienteVuelveAFallar_NoDuplica"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 3
export TYCON_NOTICE_STATE_DIR="${BASE}/estado-t17"; correr; correr
N="$(grep -c . "${BASE}/estado-t17/pendientes.tsv" 2>/dev/null)"
if [ "${RC}" = 3 ] && [ "${N}" = 1 ]; then ok "T17 dos fallas del mismo aviso dejan un solo pendiente"
else mal "T17 rc=${RC} líneas=${N:-0} pendientes=[$(cat "${BASE}/estado-t17/pendientes.tsv" 2>/dev/null)]"; fi

# ── T18 ─────────────────────────────────────────────────────────────────────────────────
# Falla si ninguna línea del guion tiene fecha (el registro real tampoco).
echo "T18 CadaLineaConFechaUTC"
SIN_FECHA="$(cat "${BASE}/out-t1" "${BASE}/out-t15" | grep -vE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z aviso-dod: ' | grep -v '^$')"
if [ -z "${SIN_FECHA}" ] && grep -q 'aviso-dod: veredicto: ' "${BASE}/out-t1" && grep -q 'aviso-dod: veredicto: ' "${BASE}/out-t15"; then ok "T18 toda línea lleva fecha UTC y hay veredicto"
else mal "T18 líneas sin fecha=[${SIN_FECHA}] t1=[$(cat "${BASE}/out-t1")]"; fi

# No-regresión (verde también sin el arreglo, con el checkout en main). La forma del aviso de
# cambio la exige T1 textual.
echo "T19 SinCambio_Calla"
armar "$(repo A__A 10)"; publicar "${HOY}" 10 "$(repo A__A 10)"; codigos 0; correr; RC_A="${RC}"; N_A="$(llamadas)"
# Tope del detalle: con 7 repos movidos se nombran los 6 primeros.
# Es no-regresión del recorte por la unión.
R_AYER=""; R_HOY=""
for i in 1 2 3 4 5 6 7; do R_AYER="${R_AYER:+${R_AYER},}$(repo "R${i}__R${i}" 10)"; R_HOY="${R_HOY:+${R_HOY},}$(repo "R${i}__R${i}" 20)"; done
armar "${R_AYER}" 70; publicar "${HOY}" 140 "${R_HOY}"; codigos 0; correr; MSG="$(enviado)"
if [ "${RC_A}" = 0 ] && [ "${N_A}" = 0 ] && [ "${RC}" = 0 ] && contiene "${MSG}" "R6__R6: 10% (10/100) -> 20% (20/100)" && ! contiene "${MSG}" "R7__R7"; then ok "T19 sin cambios calla; el detalle se corta en 6 repos"
else mal "T19 sin-cambio rc=${RC_A} llamadas=${N_A} · siete rc=${RC} enviado=[${MSG}]"; fi

# ── T20 ─────────────────────────────────────────────────────────────────────────────
# No-regresión (verde también sin el arreglo).
echo "T20 SinPrevio_Y_SinSnapshots"
armar -; publicar "${HOY}" 10 "$(repo A__A 10)"; codigos 0; correr; RC_A="${RC}"; N_A="$(llamadas)"
armar -; codigos 0; correr; MSG="$(enviado)"
if [ "${RC_A}" = 0 ] && [ "${N_A}" = 0 ] && [ "${RC}" = 3 ] && contiene "${MSG}" "no hay ni un snapshot"; then ok "T20 sin anterior calla; sin snapshots avisa y sale 3"
else mal "T20 sin-previo rc=${RC_A} llamadas=${N_A} · sin-snapshots rc=${RC} enviado=[${MSG}]"; fi

# ── T21 ─────────────────────────────────────────────────────────────────────────────
# Falla si el guion imprime «[dry-run]» sin fecha. Suma el aislamiento de esta suite.
echo "T21 DryRun_NoLlamaAlEnvio"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0
export TYCON_NOTICE_STATE_DIR="${BASE}/estado-t21"; mkdir -p "${BASE}/estado-t21"
printf '%s\t%s\n' "${AYER}" "aviso viejo guardado" > "${BASE}/estado-t21/pendientes.tsv"
TYCON_NOTICE_DRYRUN=1 correr
# El dry-run no agrega ni borra pendientes y su línea también lleva fecha.
if [ "${RC}" = 0 ] && [ "$(llamadas)" = 0 ] \
   && grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z aviso-dod: \[dry-run\] .*Se movió la evidencia DoD' "${OUT}" \
   && [ "$(cat "${BASE}/estado-t21/pendientes.tsv" 2>/dev/null)" = "${AYER}${TAB}aviso viejo guardado" ] \
   && [ "${HOME}" = "${BASE}/home" ] && [ -z "${TELEGRAM_BOT_TOKEN}" ] && contiene "${TYCON_TELEGRAM_API}" "127.0.0.1"; then ok "T21 dry-run no envía; la suite está aislada"
else mal "T21 rc=${RC} llamadas=$(llamadas) salida=[$(cat "${OUT}")]"; fi

# ── T22 ─────────────────────────────────────────────────────────────────────────────────
# Falla si el guion no lee estas variables — no hay línea que diga nada.
echo "T22 ValoresInvalidos_VuelvenAlDefaultYLoDicen"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0
TYCON_NOTICE_RETRIES=abc TYCON_NOTICE_WAIT_S=-1 correr
OUT_A="$(cat "${OUT}")"; RC_A="${RC}"; N_A="$(llamadas)"
# «00» son cero intentos con otra forma, y un número enorme desborda el `[ -lt ]` (sin validar,
# pasarían sin decir nada, y el desborde imprimiría un error sin fecha).
codigos 0; TYCON_NOTICE_RETRIES=00 correr; OUT_B="$(cat "${OUT}")"
codigos 0; TYCON_NOTICE_RETRIES=99999999999999999999 correr; OUT_C="$(cat "${OUT}")"
SIN_FECHA_C="$(printf '%s\n' "${OUT_C}" | grep -vE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z aviso-dod: ' | grep -v '^$')"
if [ "${RC_A}" = 0 ] && [ "${N_A}" = 1 ] && contiene "${OUT_A}" 'aviso-dod: TYCON_NOTICE_RETRIES inválido («abc»): uso 3' \
   && contiene "${OUT_A}" 'aviso-dod: TYCON_NOTICE_WAIT_S inválido («-1»): uso 30' \
   && contiene "${OUT_B}" 'TYCON_NOTICE_RETRIES inválido («00»): uso 3' \
   && contiene "${OUT_C}" 'TYCON_NOTICE_RETRIES inválido («99999999999999999999»): uso 3' && [ -z "${SIN_FECHA_C}" ]; then ok "T22 un valor inválido (también «00» o desbordado) vuelve al default y lo dice"
else mal "T22 abc=[${OUT_A}] 00=[${OUT_B}] enorme=[${OUT_C}]"; fi

# ── T23 ─────────────────────────────────────────────────────────────────────────────
# Falla si el guion ignora TYCON_NOTICE_NOTIFY y entrega con el doble del repo (exit 0);
# o si, sin script, sale 3 al arrancar, sin veredicto ni pendiente.
echo "T23 SinScriptDeEnvio_QuedaPendiente"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0
TYCON_NOTICE_NOTIFY="${BASE}/no-existe.sh" correr; RC_A="${RC}"; OUT_A="$(cat "${OUT}")"; PEND_A="$(cat "${BASE}/estado/pendientes.tsv" 2>/dev/null)"
armar "$(repo A__A 10)"; publicar "${HOY}" 10 "$(repo A__A 10)"; codigos 0
TYCON_NOTICE_NOTIFY="${BASE}/no-existe.sh" correr
if [ "${RC_A}" = 3 ] && contiene "${OUT_A}" "aviso-dod: veredicto: CAMBIO" && contiene "${OUT_A}" "NO SE ENTREGÓ el aviso (falta el script de envío" \
   && contiene "${PEND_A}" "${HOY}${TAB}Se movió la evidencia DoD" && [ "${RC}" = 0 ]; then ok "T23 sin script de envío: veredicto, NO SE ENTREGÓ, pendiente; sin cambios ni lo necesita"
else mal "T23 con-cambio rc=${RC_A} salida=[${OUT_A}] pendientes=[${PEND_A}] · sin-cambio rc=${RC} salida=[$(cat "${OUT}")]"; fi

# ── T24 ───────────────────────────────────────────────────────────────────────────────
# Falla si la clave es el basename (datos reales de un snapshot de main):
# dos repos «Project» se pisan y el que se movió no aparece en el detalle.
echo "T24 ReposConElMismoNombre_NoSeMezclan"
armar "$(repo_ruta /Users/a/SourceCode/Lapacho/Project 0 12),$(repo_ruta /Users/a/SourceCode/Totora/Project 0 2)" 0
publicar "${HOY}" 6 "$(repo_ruta /Users/a/SourceCode/Lapacho/Project 6 12),$(repo_ruta /Users/a/SourceCode/Totora/Project 0 2)"
codigos 0; correr; MSG="$(enviado)"
if [ "${RC}" = 0 ] && contiene "${MSG}" "Lapacho__Project: 0% (0/12) -> 50% (6/12)" && ! contiene "${MSG}" "Totora__Project" && ! contiene "${MSG}" " Project:"; then ok "T24 los repos homónimos se distinguen por su proyecto"
else mal "T24 rc=${RC} enviado=[${MSG}] salida=[$(cat "${OUT}")]"; fi

# ── T25 ──────────────────────────────────────────────────────────────────────────────────
# Falla si un repo que sigue en el snapshot pero se
# quedó sin medición sale como «salió»; y ocupa un lugar del detalle antes que un movimiento real.
echo "T25 MedicionQueSePierde_NoEsSalio"
armar "$(repo B__B 5),$(repo A__A 10)" 15; publicar "${HOY}" 20 "$(repo_sin_medir B__B),$(repo A__A 20)"; codigos 0; correr; MSG="$(enviado)"
if [ "${RC}" = 0 ] && contiene "${MSG}" "B__B: 5% (5/100) -> sin medición" && ! contiene "${MSG}" "salió" \
   && contiene "${MSG}" ". A__A: 10% (10/100) -> 20% (20/100) · B__B"; then ok "T25 perder la medición no es salir, y los movimientos reales van primero"
else mal "T25 rc=${RC} enviado=[${MSG}] salida=[$(cat "${OUT}")]"; fi

# ── T26 ─────────────────────────────────────────────────────────────────────────────────
# Falla si se usa `read`, que no devuelve la última línea sin salto final → ese pendiente
# no se manda y el archivo igual se borra («pendientes entregados y borrados»).
echo "T26 PendienteSinSaltoFinal_SeEntrega"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0
mkdir -p "${BASE}/estado"; printf '%s\t%s' "${AYER}" "aviso viejo sin salto final" > "${BASE}/estado/pendientes.tsv"
correr; MSG="$(cat "${D}/msg-1" 2>/dev/null)"
if [ "${RC}" = 0 ] && contiene "${MSG}" "(aviso del ${AYER} que no se pudo entregar) aviso viejo sin salto final" \
   && contiene "${MSG}" "Se movió la evidencia DoD" && [ ! -s "${BASE}/estado/pendientes.tsv" ]; then ok "T26 la última línea sin salto final también se entrega"
else mal "T26 rc=${RC} mensaje=[${MSG}] pendientes=[$(cat "${BASE}/estado/pendientes.tsv" 2>/dev/null)]"; fi
# Y al guardar un pendiente nuevo sobre un archivo sin salto final, las dos líneas no se pegan.
codigos 3; mkdir -p "${BASE}/estado"; printf '%s\t%s' "${AYER}" "otro viejo" > "${BASE}/estado/pendientes.tsv"; correr
if [ "$(grep -c . "${BASE}/estado/pendientes.tsv")" = 2 ] && grep -q "^${HOY}${TAB}Se movió" "${BASE}/estado/pendientes.tsv"; then ok "T26 guardar sobre un archivo sin salto final no pega las líneas"
else mal "T26 pendientes=[$(cat "${BASE}/estado/pendientes.tsv" 2>/dev/null)]"; fi

# ── T27 ─────────────────────────────────────────────────────────────────────────────────
# Falla sin tope: tras varias noches fallidas el mensaje pasa los 4096
# caracteres de Telegram y no se entrega NUNCA más, aunque vuelva la red.
echo "T27 MuchosPendientes_EntranEnUnMensaje"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0; mkdir -p "${BASE}/estado"
python3 -c "
import datetime as d
base = d.date.fromisoformat('${AYER}')
with open('${BASE}/estado/pendientes.tsv', 'w') as f:
    for i in range(40, 0, -1):
        f.write(f'{(base - d.timedelta(days=i)).isoformat()}\tSe movió la evidencia DoD del nocturno: ' + 'x' * 180 + f' noche {i}\n')
"
correr; LARGO="$(python3 -c "print(len(open('${D}/msg-1', encoding='utf-8').read()))" 2>/dev/null)"; MSG="$(cat "${D}/msg-1" 2>/dev/null)"
if [ "${RC}" = 0 ] && [ -n "${LARGO}" ] && [ "${LARGO}" -le 4000 ] && contiene "${MSG}" "Se movió la evidencia DoD del nocturno: 10% (10/100) -> 20% (20/100)" \
   && contiene "${MSG}" "noche 1" && contiene "${MSG}" "más viejos" && ! contiene "${MSG}" "noche 40 " && [ ! -s "${BASE}/estado/pendientes.tsv" ]; then ok "T27 con 40 pendientes el mensaje entra (${LARGO} caracteres): hoy, los más nuevos y un resumen de los viejos"
else mal "T27 rc=${RC} largo=${LARGO:-?} salida=[$(tail -3 "${OUT}")]"; fi

# ── el fetch reintenta antes de decir «no pude mirar» ─────────────────────────────────────────────
# Si la máquina despierta sin DNS, el fetch falla una vez y el aviso diría
# «no pude mirar» con el snapshot publicado. Un `git` de mentira en el PATH cuenta los fetch y falla los
# primeros K con el texto pedido; todo lo demás (y los fetch siguientes) va al git real.
# Fallan los tres si el guion hace UN solo fetch.
GIT_REAL="$(command -v git)"
mkdir -p "${BASE}/gitfalso"
cat > "${BASE}/gitfalso/git" <<SH
#!/usr/bin/env bash
for a in "\$@"; do
  if [ "\$a" = fetch ]; then
    n=\$(( \$(cat "${BASE}/fetch-n" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "${BASE}/fetch-n"
    if [ "\$n" -le "\$(cat "${BASE}/fetch-fallas")" ]; then cat "${BASE}/fetch-error" >&2; exit 128; fi
    break
  fi
done
exec "${GIT_REAL}" "\$@"
SH
chmod +x "${BASE}/gitfalso/git"
# fetch_falla <veces> <texto del error>
fetch_falla() { echo "$1" > "${BASE}/fetch-fallas"; printf '%s\n' "$2" > "${BASE}/fetch-error"; rm -f "${BASE}/fetch-n"; }
fetches() { cat "${BASE}/fetch-n" 2>/dev/null || echo 0; }
correr_gitfalso() { PATH="${BASE}/gitfalso:${PATH}" TYCON_NOTICE_FETCH_WAIT_S=0 TYCON_GUIDES_DIR="${CO}" /bin/bash "${GUION}" > "${OUT}" 2>&1; RC=$?; }
DNS="fatal: unable to access 'https://dev.azure.com/equipo/_git/arnes/': Could not resolve host: dev.azure.com"

echo "T28 FetchFallaUnaVezPorRed_ReintentaYCompara (story 8.3.1 T7)"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; fetch_falla 1 "${DNS}"; codigos 0; correr_gitfalso
if [ "${RC}" = 0 ] && [ "$(fetches)" = 2 ] && contiene "$(enviado)" "Se movió la evidencia DoD del nocturno: 10% (10/100) -> 20% (20/100)" \
   && ! contiene "$(enviado)" "no pude mirar" && contiene "$(cat "${OUT}")" "falló 1 vez" && contiene "$(cat "${OUT}")" "anduvo al intento 2"; then ok "T28 un fetch fallido por red se reintenta, compara y deja constancia del reintento"
else mal "T28 rc=${RC} fetches=$(fetches) enviado=[$(enviado)] salida=[$(cat "${OUT}")]"; fi

echo "T29 FetchFallaSiemprePorRed_UnAvisoConConteo (story 8.3.1 T8)"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; fetch_falla 99 "${DNS}"; codigos 0; correr_gitfalso
if [ "${RC}" = 2 ] && [ "$(fetches)" = 3 ] && [ "$(llamadas)" = 1 ] && contiene "$(enviado)" "no pude mirar" \
   && contiene "$(enviado)" "3 intentos" && contiene "$(enviado)" "Could not resolve host"; then ok "T29 tres fetch fallidos por red: un solo «no pude mirar» con el conteo y el motivo, exit 2"
else mal "T29 rc=${RC} fetches=$(fetches) llamadas=$(llamadas) enviado=[$(enviado)] salida=[$(cat "${OUT}")]"; fi

echo "T30 FetchFallaPorAlgoQueNoEsRed_NoReintenta (story 8.3.1 T9)"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; fetch_falla 99 "fatal: not a git repository (or any of the parent directories): .git"; codigos 0; correr_gitfalso
if [ "${RC}" = 2 ] && [ "$(fetches)" = 1 ] && contiene "$(enviado)" "no pude mirar" && contiene "$(enviado)" "not a git repository"; then ok "T30 un error que no es de red avisa al primer intento, sin reintentar"
else mal "T30 rc=${RC} fetches=$(fetches) enviado=[$(enviado)] salida=[$(cat "${OUT}")]"; fi

echo "T31 FetchReintentosInvalidos_VuelveAlDefault (story 8.3.1 AC 6)"
# el fetch anda al primero: la espera inválida no llega a esperarse (con el default serían 60 s por intento)
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; fetch_falla 0 "${DNS}"; codigos 0
PATH="${BASE}/gitfalso:${PATH}" TYCON_NOTICE_FETCH_RETRIES=0 TYCON_NOTICE_FETCH_WAIT_S=x TYCON_GUIDES_DIR="${CO}" /bin/bash "${GUION}" > "${OUT}" 2>&1; RC=$?
if [ "${RC}" = 0 ] && [ "$(fetches)" = 1 ] && contiene "$(cat "${OUT}")" "TYCON_NOTICE_FETCH_RETRIES inválido" && contiene "$(cat "${OUT}")" "TYCON_NOTICE_FETCH_WAIT_S inválido"; then ok "T31 valores inválidos vuelven al default y lo dicen"
else mal "T31 rc=${RC} fetches=$(fetches) salida=[$(cat "${OUT}")]"; fi

# La validación acepta hasta 3 dígitos, igual que su hermana TYCON_NOTICE_RETRIES.
echo "T32 FetchReintentosDeTresDigitos_SeRespetan (story 8.3.1 AC 6)"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; fetch_falla 99 "${DNS}"; codigos 0
PATH="${BASE}/gitfalso:${PATH}" TYCON_NOTICE_FETCH_RETRIES=100 TYCON_NOTICE_FETCH_WAIT_S=0 TYCON_GUIDES_DIR="${CO}" /bin/bash "${GUION}" > "${OUT}" 2>&1; RC=$?
if [ "${RC}" = 0 ] && [ "$(fetches)" = 100 ] && ! contiene "$(cat "${OUT}")" "inválido" && contiene "$(cat "${OUT}")" "anduvo al intento 100"; then ok "T32 un valor de tres dígitos se respeta como el de la variable hermana"
else mal "T32 rc=${RC} fetches=$(fetches) salida=[$(tail -3 "${OUT}")]"; fi

# ── T33 ─ R3_TelegramNotify_CallersAndShim ─────────────────────────────────────────────────────
# Sin TYCON_NOTICE_NOTIFY (el LaunchAgent no la declara) el guion busca el envío en el arnés, en
# `scripts/lib/`. El arnés de este caso no tiene el reemplazo de la ruta vieja, así que un default viejo no encuentra
# el envío (exit 3, «falta el script de envío»). Falla si el default apunta a la ruta vieja.
echo "T33 SinNotifyDeclarado_UsaElEnvioDeScriptsLib (story 8.12 T27)"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0
unset TYCON_NOTICE_NOTIFY; correr; export TYCON_NOTICE_NOTIFY="${BASE}/doble.sh"
if [ "${RC}" = 0 ] && [ "$(llamadas)" = 1 ] && contiene "$(enviado)" "Se movió la evidencia DoD"; then ok "T33 sin TYCON_NOTICE_NOTIFY entrega con el envío de scripts/lib/"
else mal "T33 rc=${RC} llamadas=$(llamadas) salida=[$(tail -3 "${OUT}")]"; fi

# ── T34 ─ R3_TelegramNotify_CallersAndShim ─────────────────────────────────────────────────────
# El resumen diario (scripts/nightly/dependencies/daily-summary.js) manda con el mismo envío. En su ensayo
# (`--dry-run`: no manda ni escribe) corre el envío del arnés; acá el arnés es de laboratorio, con un doble en
# `scripts/lib/` y nada en la ruta vieja. Falla si el guion busca el envío en la ruta vieja (exit 3).
# La copia pública no trae el resumen diario: `scripts/nightly/dependencies/` es del equipo y el exportador lo
# deja afuera. Ahí T34 no se puede medir y se dice. La señal de «copia pública» es la de siempre (sin el perfil del
# equipo o sin el mapa de renombres); en el repo del equipo, que falte el resumen sigue siendo un rojo.
echo "T34 ResumenDiario_Ensayo_UsaElEnvioDeScriptsLib (story 8.12 T27)"
T34_NOT_MEASURED=0
if [ ! -f "${RAIZ}/scripts/nightly/dependencies/daily-summary.js" ] \
   && { [ ! -f "${RAIZ}/perfil-equipo.json" ] || [ ! -f "${RAIZ}/scripts/lib/renames.json" ]; }; then
  T34_NOT_MEASURED=1
  echo "  ⏭   — T34 NO MEDIDO: la copia pública no trae el resumen diario del equipo (scripts/nightly/dependencies/). No es un verde."
else
DS="${BASE}/ds"; rm -rf "${DS}"
mkdir -p "${DS}/scripts/nightly/dependencies" "${DS}/out" "${DS}/vig"
for c in pending promoted archived; do mkdir -p "${DS}/pend/${c}"; done
cp "${RAIZ}/scripts/nightly/dependencies/daily-summary.js" "${RAIZ}/scripts/nightly/dependencies/nightly-dependencies.js" "${DS}/scripts/nightly/dependencies/"
cp -R "${RAIZ}/scripts/lib" "${DS}/scripts/"
printf '#!/usr/bin/env bash\necho "doble-de-scripts-lib ensayo texto=$*"\n' > "${DS}/scripts/lib/tycon-telegram-notify.sh"
echo '{ "repos": [ { "producto": "A", "ruta": "A/A", "tipo": "npm", "activo": true, "ado": "ProyA/A" } ] }' > "${DS}/repos.json"
echo '{ "rubros_sin_fuente": {} }' > "${DS}/resumen.json"
# el canal del aviso lo declara la organización: sin `notify`, el resumen no se manda (ni en ensayo)
echo '{ "version": 1, "owners": { "default": "lead@acme.example" }, "notify": { "channel": "telegram" } }' > "${DS}/operations.json"
node -e '
const [dir, fecha] = process.argv.slice(1);
const s = { fecha, corrida_completa: true, linea_base: false, comparado_contra: null, repos_activos: 1, repos_apagados: 0,
  repos: [], no_medidos: [], hallazgos: [], presencias: [], anunciados_hoy: [], postergados_por_presupuesto: [], anexados: [],
  reaparecidos_ids: [], presupuesto: { tope: 2 }, resueltos_ids: [], descartados_ids: [], aceptadas_sin_resolver: [],
  rechazadas_sin_deuda_ids: [], ignorados_ids: [] };
require("fs").writeFileSync(dir + "/out/dependencias-" + fecha + ".json", JSON.stringify(s, null, 2) + "\n");' "${DS}" "${HOY}"
cp "${DS}/out/dependencias-${HOY}.json" "${DS}/antes.json"
node "${DS}/scripts/nightly/dependencies/daily-summary.js" deliver --source dependencies --today "${HOY}" --dry-run \
  --out "${DS}/out" --pending "${DS}/pend" --config "${DS}/repos.json" --summary-config "${DS}/resumen.json" \
  --watcher-out "${DS}/vig" > "${OUT}" 2>&1; RC=$?
if [ "${RC}" = 0 ] && grep -q "doble-de-scripts-lib ensayo" "${OUT}" && cmp -s "${DS}/antes.json" "${DS}/out/dependencias-${HOY}.json"; then
  ok "T34 el ensayo del resumen diario corre el envío de scripts/lib/ y no escribe el snapshot"
else mal "T34 rc=${RC} salida=[$(tail -3 "${OUT}")]"; fi
fi

# ── T35 y T36 ─ los datos, del clon de mantenimiento; el envío, del árbol propio ────────────────────────
# Si el guion tomara como repo su propia ubicación, en una versión instalada eso sería el árbol bajado, que no
# es un clon: el `fetch` fallaría y el aviso diría «no pude mirar» todas las noches, con los datos sanos en el clon de
# mantenimiento de la máquina. Y un solo «repo» ubicaría dos cosas distintas: de dónde se leen los datos y de dónde
# sale el guion que manda el Telegram.
# Falla si el guion, sin TYCON_GUIDES_DIR, hace `fetch` sobre el árbol de juguete (que no es un clon).
# Se arma una versión instalada de juguete: una copia del guion y de sus bibliotecas, con su PROPIO doble del envío.
instalada() {
  IN="${BASE}/instalada"; rm -rf "${IN}" "${BASE}/home/.tycon"
  mkdir -p "${IN}/scripts/ci" "${IN}/scripts/setup" "${IN}/scripts/hooks" "${BASE}/home/.tycon/state" "${BASE}/clon-publico/.git"
  cp "${GUION}" "${IN}/scripts/ci/"; cp -R "${RAIZ}/scripts/lib" "${IN}/scripts/lib"; cp -R "${RAIZ}/scripts/setup/harness" "${IN}/scripts/setup/harness"
  cp "${RAIZ}/scripts/hooks/public-push-guard.js" "${IN}/scripts/hooks/"
  for f in version.json; do [ -f "${RAIZ}/${f}" ] && cp "${RAIZ}/${f}" "${IN}/"; done
  printf '#!/usr/bin/env bash\necho "$1" >> "%s/propio"\necho 4242\n' "${D}" > "${IN}/scripts/lib/tycon-telegram-notify.sh"
  chmod +x "${IN}/scripts/lib/tycon-telegram-notify.sh"
  printf '{"schema":1,"sources":[{"kind":"release","version":"0.0.0"}]}' > "${BASE}/home/.tycon/state/harness-state.json"
  printf '%s' "$1" > "${BASE}/home/.tycon/config.json"
}
correr_instalada() { ( unset TYCON_NOTICE_NOTIFY TYCON_GUIDES_DIR; TYCON_HOME="${BASE}/home/.tycon" TYCON_NIGHTLY=1 /bin/bash "${IN}/scripts/ci/nightly-dod-notice.sh" > "${OUT}" 2>&1 ); RC=$?; }

echo "T35 VersionInstalada_SinGuidesDir_LeeElClonDeOperaciones_MandaConSuPropioEnvio"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0
instalada "{\"paths\":{\"maintained\":\"${BASE}/clon-publico\",\"maintainers\":\"${CO}\",\"operations\":\"${CO}\"}}"
correr_instalada
PROPIO="$(cat "${D}/propio" 2>/dev/null)"
if [ "${RC}" = 0 ] && contiene "${PROPIO}" "Se movió la evidencia DoD del nocturno: 10% (10/100) -> 20% (20/100)" && [ "$(llamadas)" = 0 ]; then
  ok "T35 leyó los snapshots del clon de operaciones y mandó con el envío de su propio árbol (el del clon de datos no se llamó)"
else mal "T35 rc=${RC} propio=[${PROPIO}] llamadas-al-doble-del-clon=$(llamadas) salida=[$(cat "${OUT}")]"; fi

echo "T36 VersionInstalada_SinClonDeOperaciones_LoDiceYNoMandaNada"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0
instalada "{\"paths\":{\"maintained\":\"${BASE}/clon-publico\",\"maintainers\":\"${CO}\"}}"
correr_instalada
if [ "${RC}" = 2 ] && grep -q "paths.operations" "${OUT}" && grep -q "se declara con: harness.js config set paths.operations" "${OUT}" && [ ! -e "${D}/propio" ] && [ "$(llamadas)" = 0 ] && ! grep -q "fetch de main falló" "${OUT}"; then
  ok "T36 sin clon de operaciones declarado sale 2 diciendo qué falta, sin traer ni mandar nada"
else mal "T36 rc=${RC} salida=[$(cat "${OUT}")]"; fi

echo "T36b VersionInstalada_ClonDeclaradoQueNoSirve_NoRecetaDeclararLoYaDeclarado"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0
mkdir -p "${BASE}/una-carpeta-cualquiera"
instalada "{\"paths\":{\"maintained\":\"${BASE}/clon-publico\",\"maintainers\":\"${CO}\",\"operations\":\"${BASE}/una-carpeta-cualquiera\"}}"
correr_instalada
if [ "${RC}" = 2 ] && grep -q "no es la raíz de un clon" "${OUT}" && grep -q "lo declarado no sirve" "${OUT}" && ! grep -q "— se declara con" "${OUT}" && [ "$(llamadas)" = 0 ]; then
  ok "T36b con un clon declarado que no sirve dice por qué y no receta «se declara con»"
else mal "T36b rc=${RC} salida=[$(cat "${OUT}")]"; fi

echo "T37 VersionInstalada_SinNodeEnElPath_DiceLaCausa_NoHaceFetchSobreUnArbolQueNoEsUnClon"
# Corre desde una tarea programada: su PATH puede no traer node. Sin node no se puede preguntar de qué clon leer; en una
# versión instalada el árbol propio no es un clon, y hacer el fetch igual daría «no pude mirar» por otra causa.
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0
instalada "{\"paths\":{\"maintained\":\"${BASE}/clon-publico\",\"maintainers\":\"${CO}\",\"operations\":\"${CO}\"}}"
SIN_NODE="${BASE}/bin-sin-node"; rm -rf "${SIN_NODE}"; mkdir -p "${SIN_NODE}"
for t in bash sh git python3 date dirname basename cat sed tail head mkdir rm sleep tr wc mktemp grep awk printf env sort cut; do
  p="$(command -v "$t" 2>/dev/null)"; case "$p" in /*) ln -s "$p" "${SIN_NODE}/$t" ;; esac
done
( unset TYCON_NOTICE_NOTIFY TYCON_GUIDES_DIR; PATH="${SIN_NODE}" TYCON_HOME="${BASE}/home/.tycon" TYCON_NIGHTLY=1 /bin/bash "${IN}/scripts/ci/nightly-dod-notice.sh" > "${OUT}" 2>&1 ); RC=$?
if [ "${RC}" = 2 ] && grep -q "no encontré node" "${OUT}" && ! grep -q "fetch de main falló" "${OUT}" && ! grep -q "se declara con" "${OUT}" && [ ! -e "${D}/propio" ] && [ "$(llamadas)" = 0 ]; then
  ok "T37 sin node en el PATH sale 2 diciendo la causa (y sin recetar una declaración que no arregla nada), sin hacer fetch ni mandar nada"
else mal "T37 rc=${RC} salida=[$(cat "${OUT}")]"; fi

echo "T38 DesdeUnClonConDatos_EnUnaMaquinaConVersionInstaladaSinClonDeMantenimiento_LeeSuArbol"
# Lanzado DESDE un clon que trae los datos, el repo es ese clon, como siempre: que la máquina tenga además una versión
# instalada sin clon de mantenimiento (o con los nocturnos apagados) no lo cambia. Falla si sale 2 sin mirar nada.
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0
instalada "{\"paths\":{\"maintained\":\"${BASE}/clon-publico\"}}"
mkdir -p "${CO}/scripts/ci" "${CO}/scripts/setup" "${CO}/scripts/hooks"
cp "${GUION}" "${CO}/scripts/ci/"; cp -R "${RAIZ}/scripts/lib/." "${CO}/scripts/lib/"; cp -R "${RAIZ}/scripts/setup/harness" "${CO}/scripts/setup/harness"
printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "${BASE}/doble.sh" > "${CO}/scripts/lib/tycon-telegram-notify.sh"; chmod +x "${CO}/scripts/lib/tycon-telegram-notify.sh"
for NOCT in 1 0; do
  codigos 0
  ( unset TYCON_NOTICE_NOTIFY TYCON_GUIDES_DIR; TYCON_HOME="${BASE}/home/.tycon" TYCON_NIGHTLY="${NOCT}" /bin/bash "${CO}/scripts/ci/nightly-dod-notice.sh" > "${OUT}" 2>&1 ); RC=$?
  MSG="$(enviado)"
  if [ "${RC}" = 0 ] && contiene "${MSG}" "Se movió la evidencia DoD del nocturno: 10% (10/100) -> 20% (20/100)" && ! grep -q "no sé de qué clon" "${OUT}"; then
    ok "T38 desde un clon con datos lee su propio árbol (nocturnos=${NOCT})"
  else mal "T38 nocturnos=${NOCT} rc=${RC} enviado=[${MSG}] salida=[$(cat "${OUT}")]"; fi
  rm -rf "${BASE}/estado"
done

# ── T39 ─ los datos, del clon de OPERACIONES; y el de mantenimiento también se trae ─────────────────────
# Las métricas se guardan en el repo de operaciones. Leídas del clon de mantenimiento, el
# aviso diría «el de hoy no está en main; el último es de ayer» con el de hoy ya guardado.
# Y este guion es quien pone al día los clones cada noche: el de mantenimiento (banco, suites, examen) también.
# Falla si lee el clon de mantenimiento (sin el snapshot de hoy) y avisa que no está publicado, o si el de operaciones no
# se trae.
echo "T39 VersionInstalada_ConClonDeOperaciones_LeeDeAhi_YTraeTambienElDeMantenimiento"
armar "$(repo A__A 10)"; publicar "${HOY}" 20 "$(repo A__A 20)"; codigos 0
MANT_ORIGIN="${BASE}/mant-origin.git"; MANT="${BASE}/clon-mant"; rm -rf "${MANT_ORIGIN}" "${MANT}" "${BASE}/mant-pub"
git init -q --bare "${MANT_ORIGIN}"; git -C "${MANT_ORIGIN}" symbolic-ref HEAD refs/heads/main
git init -q "${BASE}/mant-pub"; git -C "${BASE}/mant-pub" checkout -q -b main; git -C "${BASE}/mant-pub" remote add origin "${MANT_ORIGIN}"
mkdir -p "${BASE}/mant-pub/.dashboard"; snap "${BASE}/mant-pub/.dashboard/sdlc-stage-${AYER}.json" 10 "$(repo A__A 10)"
git -C "${BASE}/mant-pub" add -A; git -C "${BASE}/mant-pub" commit -qm ayer; git -C "${BASE}/mant-pub" push -q origin main
git clone -q "${MANT_ORIGIN}" "${MANT}"
echo banco > "${BASE}/mant-pub/banco.txt"; git -C "${BASE}/mant-pub" add -A; git -C "${BASE}/mant-pub" commit -qm banco; git -C "${BASE}/mant-pub" push -q origin main
MANT_NUEVO="$(git -C "${BASE}/mant-pub" rev-parse HEAD)"
instalada "{\"paths\":{\"maintained\":\"${BASE}/clon-publico\",\"maintainers\":\"${MANT}\",\"operations\":\"${CO}\"}}"
correr_instalada
PROPIO="$(cat "${D}/propio" 2>/dev/null)"
MANT_TRAIDO="$(git -C "${MANT}" rev-parse refs/remotes/origin/main 2>/dev/null)"
if [ "${RC}" = 0 ] && contiene "${PROPIO}" "Se movió la evidencia DoD del nocturno: 10% (10/100) -> 20% (20/100)" && [ "${MANT_TRAIDO}" = "${MANT_NUEVO}" ]; then
  ok "T39 leyó el snapshot de hoy del clon de operaciones y trajo también el de mantenimiento"
else mal "T39 rc=${RC} propio=[${PROPIO}] mant=${MANT_TRAIDO} esperado=${MANT_NUEVO} salida=[$(cat "${OUT}")]"; fi

echo
if [ "${FALLOS}" -eq 0 ] && [ "${T34_NOT_MEASURED}" = 1 ]; then echo "aviso-dod-nocturno: 38 de 39 casos en verde, T34 salteado (NO MEDIDO en la copia pública)"; exit 0; fi
if [ "${FALLOS}" -eq 0 ]; then echo "aviso-dod-nocturno: 39 de 39 casos en verde"; exit 0; fi
echo "aviso-dod-nocturno: ${FALLOS} fallo(s)"; exit 1
