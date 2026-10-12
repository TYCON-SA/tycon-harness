#!/usr/bin/env bash
# nightly-dod-notice.sh — avisa por Telegram cuando la evidencia DoD que medimos CAMBIA.
#
# POR QUÉ EXISTE (2026-09-05)
# La evidencia de cierre no viajaba por git: `.advisors/` en el .gitignore tapaba también
# `.advisors/dod-runtime/`, así que el medidor nocturno reportaba 0% en repos con decenas de
# archivos en el disco. Se arregló en 26 repos y se commitearon 1024 archivos… a `dev`.
# El nocturno clona la rama por defecto (`main`), o sea que el número NO se mueve hasta que
# cada producto mergee. Este aviso existe para no tener que acordarse de mirar.
#
# QUÉ HACE
# Compara el snapshot de hoy con el anterior, LEÍDOS DE LO PUBLICADO (`origin/main`), y avisa SÓLO
# si la evidencia DoD se movió. Si no se movió, calla — un aviso diario que dice "sigue igual" se
# ignora en tres días. Lo que no puede afirmar lo dice como lo vio: "no está publicado en main"
# (el fetch anduvo y el de hoy no está) no es "no pude mirar" (el fetch falló), y ninguno de los
# dos es "no corrió" — este guion no mira Azure DevOps.
#
# 🔴 POR QUÉ LEE `origin/main` Y NO EL DISCO (story 1.5, 2026-09-15)
# Leía `.dashboard/` del checkout compartido después de un `merge --ff-only` con el error tapado.
# A las 03:43 del 15 el checkout estaba en otra rama, el merge falló callado y llegó "el medidor NO
# corrió hoy" con el snapshot publicado 37 minutos antes. Y cuando el merge SÍ andaba, le metía
# `main` encima a la rama en la que estuviera el dev. Ahora el único cambio que hace en el repo es
# traer la referencia `origin/main`; la rama, el índice y el árbol de trabajo no se tocan.
#
# 🔴 UN ENVÍO QUE NO LLEGA QUEDA DICHO
# El registro mostraba avisos perdidos por DNS (la Mac despertando) con la corrida en exit 0 y sin
# fecha. Ahora reintenta; si igual no llega, deja una línea "NO SE ENTREGÓ" con motivo y texto,
# guarda el aviso como pendiente y sale 3. La corrida siguiente que logra entregar manda los
# pendientes (con su fecha) en el mismo mensaje.
#
# VARIABLES
#   TYCON_GUIDES_DIR        el repo del arnés (default ~/.claude/tycon-harness)
#   TYCON_NOTICE_DRYRUN=1   no manda nada: imprime "[dry-run] <texto>" y no toca los pendientes
#   TYCON_NOTICE_NOTIFY     script de envío (default <repo>/scripts/lib/tycon-telegram-notify.sh)
#   TYCON_NOTICE_TODAY      fecha UTC de hoy (AAAA-MM-DD); para las pruebas
#   TYCON_NOTICE_STATE_DIR  dónde viven los pendientes (default ~/.claude/.tycon-pipeline/aviso-dod)
#   TYCON_NOTICE_RETRIES    intentos de envío en total (default 3)
#   TYCON_NOTICE_WAIT_S     segundos entre intentos (default 30)
#   (los nombres viejos en castellano siguen valiendo hasta el retiro: scripts/lib/renames.json, story 8.9)
#   TYCON_NOTICE_FETCH_RETRIES  intentos de traer main cuando falla por red (default 3; story 8.3.1)
#   TYCON_NOTICE_FETCH_WAIT_S    segundos entre esos intentos (default 60)
#
# SALIDA: 0 miró (y avisó o calló) · 2 no pudo mirar o comparar (y lo avisó) ·
#         3 no pudo entregar el aviso (también si falta el script de envío; no entregar manda sobre
#           el 2), o no hay ni un snapshot publicado.
#
# Pruebas: scripts/tests/nightly-dod-notice.test.sh
# APAGARLO:  launchctl unload ~/Library/LaunchAgents/com.tycon.aviso-dod.plist
set -u

REPO="${TYCON_GUIDES_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"   # este script vive en el arnés: su ubicación (story 8.3)
# Las variables renombradas a inglés (story 8.9): la biblioteca, por la ubicación de este script (vive en el arnés).
. "$(cd "$(dirname "$0")/../.." && pwd)/scripts/lib/legacy-names.sh"
legacy_env TYCON_NOTICE_DRYRUN; legacy_env TYCON_NOTICE_NOTIFY; legacy_env TYCON_NOTICE_TODAY
legacy_env TYCON_NOTICE_STATE_DIR; legacy_env TYCON_NOTICE_RETRIES; legacy_env TYCON_NOTICE_WAIT_S
NOTIFY="${TYCON_NOTICE_NOTIFY:-$REPO/scripts/lib/tycon-telegram-notify.sh}"
HOY="${TYCON_NOTICE_TODAY:-$(date -u +%Y-%m-%d)}"
ESTADO_DIR="${TYCON_NOTICE_STATE_DIR:-$HOME/.claude/.tycon-pipeline/aviso-dod}"
PENDIENTES="$ESTADO_DIR/pendientes.tsv"
REINTENTOS="${TYCON_NOTICE_RETRIES:-3}"
ESPERA_S="${TYCON_NOTICE_WAIT_S:-30}"
REF="refs/remotes/origin/main"
LIMITE_MENSAJE=4000   # Telegram rechaza textos de más de 4096 caracteres
NL=$'\n'

# Toda línea que sale de acá lleva fecha UTC: el LaunchAgent la manda a /tmp/tycon-aviso-dod.log,
# y un registro sin fechas no permite saber qué noche pasó qué.
log() { local t="$*"; printf '%s aviso-dod: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${t//$NL/ ⏎ }"; }

# Un valor inválido vuelve al default, y lo dice: un reintento que "no anda" sin rastro es otro silencio.
# Inválido = vacío, no numérico, con cero adelante («0», «00»: cero intentos con otra forma) o
# demasiado largo (un número enorme desborda el `[ -lt ]` y escribe un error sin fecha).
case "$REINTENTOS" in ''|*[!0-9]*|0*|????*) log "TYCON_NOTICE_RETRIES inválido («${REINTENTOS}»): uso 3"; REINTENTOS=3 ;; esac
case "$ESPERA_S" in ''|*[!0-9]*|?????*) log "TYCON_NOTICE_WAIT_S inválido («${ESPERA_S}»): uso 30"; ESPERA_S=30 ;; esac

# El motivo de un error: la primera línea `fatal:`/`error:` si la hay (git pone la útil primero y
# después consejos genéricos), si no la última no vacía. Recortado sin partir caracteres.
motivo_de() {
  python3 -c '
import re, sys
ls = [l.strip() for l in sys.argv[1].splitlines() if l.strip()]
f = [l for l in ls if re.match(r"(fatal|error):", l)]
m = (f[0] if f else (ls[-1] if ls else "sin detalle"))
print(m[:200])' "$1"
}

# ── 1. Traer lo publicado, sin tocar la rama del checkout ───────────────────────────────────────
# El refspec explícito actualiza origin/main aunque el remoto no tenga `fetch` configurado.
#
# UN FETCH QUE FALLA POR RED SE REINTENTA (story 8.3.1). Caso disparador, 2026-09-27 03:43: la
# MacBook despertó sin DNS, el único fetch falló y el aviso dijo «no pude mirar» con el snapshot
# publicado. El envío ya reintentaba; el fetch no. Red = el texto de git dice que no llegó al
# servidor: `Could not resolve host`, `Connection timed out`, `Connection refused`, `Failed to
# connect`, `Operation timed out`, `Network is unreachable`. Cualquier otro error (repo roto,
# permisos, `main` inexistente) se avisa al primer intento: repetirlo no lo arregla y demora el aviso.
es_error_de_red() {
  case "$1" in
    *"Could not resolve host"*|*"Connection timed out"*|*"Connection refused"*|*"Failed to connect"*|*"Operation timed out"*|*"Network is unreachable"*) return 0 ;;
  esac
  return 1
}
FETCH_INTENTOS="${TYCON_NOTICE_FETCH_RETRIES:-3}"
FETCH_ESPERA_S="${TYCON_NOTICE_FETCH_WAIT_S:-60}"
case "$FETCH_INTENTOS" in ''|*[!0-9]*|0*|????*) log "TYCON_NOTICE_FETCH_RETRIES inválido («${FETCH_INTENTOS}»): uso 3"; FETCH_INTENTOS=3 ;; esac
case "$FETCH_ESPERA_S" in ''|*[!0-9]*|?????*) log "TYCON_NOTICE_FETCH_WAIT_S inválido («${FETCH_ESPERA_S}»): uso 60"; FETCH_ESPERA_S=60 ;; esac

FETCH_N=0
FETCH_MOTIVO=""
while :; do
  FETCH_N=$((FETCH_N + 1))
  FETCH_SALIDA="$(git -C "$REPO" fetch -q origin "+refs/heads/main:$REF" 2>&1)"
  FETCH_RC=$?
  if [ "$FETCH_RC" -eq 0 ]; then
    if [ "$FETCH_N" -gt 1 ]; then
      FALLAS=$((FETCH_N - 1)); [ "$FALLAS" -eq 1 ] && VECES="vez" || VECES="veces"
      log "fetch: falló ${FALLAS} ${VECES} (${FETCH_MOTIVO}), anduvo al intento ${FETCH_N}"
    fi
    FETCH_MOTIVO=""
    break
  fi
  FETCH_MOTIVO="$(motivo_de "$FETCH_SALIDA")"
  log "el fetch de main falló (rc=${FETCH_RC}, intento ${FETCH_N} de ${FETCH_INTENTOS}): ${FETCH_MOTIVO}"
  if ! es_error_de_red "$FETCH_SALIDA"; then break; fi
  if [ "$FETCH_N" -ge "$FETCH_INTENTOS" ]; then
    FETCH_MOTIVO="sin red en ${FETCH_N} intentos: ${FETCH_MOTIVO}"   # el conteo adelante: el motivo se recorta al final
    break
  fi
  sleep "$FETCH_ESPERA_S"
done

# ── 2. Comparar ─────────────────────────────────────────────────────────────────────────────────
SALIDA_PY="$(python3 - "$REPO" "$REF" "$HOY" "$FETCH_RC" "$FETCH_MOTIVO" 2>&1 <<'PY'
import json, os, re, subprocess, sys

repo, ref, hoy, fetch_rc, fetch_motivo = sys.argv[1:6]
fetch_ok = fetch_rc == "0"

def fin(s):
    print(s)
    raise SystemExit(0)

def limpio(t):
    return str(t).replace("|", "/").replace("\n", " ").replace("\t", " ")

def motivo(t):
    ls = [l.strip() for l in (t or "").splitlines() if l.strip()]
    f = [l for l in ls if re.match(r"(fatal|error):", l)]
    return limpio((f[0] if f else (ls[-1] if ls else "sin detalle"))[:200])

def git(*args):
    p = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr

try:
    rc, _, err = git("rev-parse", "--verify", "-q", ref)
    if rc != 0:
        fin("NO_PUDE|" + (limpio(fetch_motivo) if not fetch_ok and fetch_motivo else f"no existe {ref} en {repo}"))

    rc, listado, err = git("ls-tree", "--name-only", ref, ".dashboard/")
    if rc != 0:
        fin("NO_PUDE|" + motivo(err))
    fechas = sorted(
        m.group(1)
        for n in listado.splitlines()
        for m in [re.fullmatch(r"\.dashboard/sdlc-stage-(\d{4}-\d{2}-\d{2})\.json", n.strip())]
        if m
    )

    # Sin el de hoy, sólo se puede afirmar algo si el fetch anduvo: si falló, no sabemos.
    if hoy not in fechas and not fetch_ok:
        fin("NO_PUDE|" + limpio(fetch_motivo or "el fetch de main falló"))
    if not fechas:
        fin("SIN_SNAPSHOTS")
    if hoy not in fechas:
        fin(f"NO_PUBLICADO|{fechas[-1]}")
    previas = [f for f in fechas if f < hoy]
    if not previas:
        fin("SIN_PREVIO")

    def leer(fecha):
        rc, contenido, err = git("show", f"{ref}:.dashboard/sdlc-stage-{fecha}.json")
        if rc != 0:
            fin("NO_PUDE|" + motivo(err))
        return json.loads(contenido)

    a, b = leer(previas[-1]), leer(hoy)

    def dod(s):
        r = (s.get("global") or {}).get("dod_evidence_ratio") or {}
        return r.get("num"), r.get("den")

    an, ad = dod(a)
    bn, bd = dod(b)
    if (an, ad) == (bn, bd):
        fin("IGUAL")

    def pct(n, den):
        return f"{round(100 * n / den)}% ({n}/{den})" if n is not None and den else "sin dato"

    # Qué repos se movieron, para que el aviso diga DÓNDE y no sólo CUÁNTO. Por la UNIÓN de los dos
    # snapshots: un repo que aparece o desaparece se nombra (antes reventaba con KeyError).
    #
    # La identidad de un repo no es el basename: en una corrida local la ruta es .../Proyecto/Repo y
    # tres repos se llamaban «Project» (snapshot publicado del 2026-09-03) — se pisaban en el
    # diccionario. El nocturno de Azure ya escribe .../Proyecto__Repo; una ruta local se lleva a esa
    # misma forma, y si igual choca dentro de un snapshot, se usa la ruta completa.
    def clave(ruta):
        partes = [x for x in str(ruta).replace("\\", "/").split("/") if x]
        if not partes:
            return "?"
        if "__" in partes[-1] or len(partes) < 2:
            return partes[-1]
        return f"{partes[-2]}__{partes[-1]}"

    # Un repo que sigue en el snapshot pero sin medición (ratio null) NO se fue: queda con None.
    def porrepo(s):
        repos = s.get("repos") or []
        claves = [clave(r.get("repo", "?")) for r in repos]
        out = {}
        for r, k in zip(repos, claves):
            if claves.count(k) > 1:
                k = str(r.get("repo", "?"))
            rr = r.get("dod_evidence_ratio")
            out[k] = (rr.get("num"), rr.get("den")) if rr else None
        return out

    def txt(v):
        return "sin medición" if v is None else pct(*v)

    pa, pb = porrepo(a), porrepo(b)
    # Primero lo que se movió de verdad, después lo que ganó o perdió su medición, al final lo que
    # entró o salió del medidor: el detalle tiene 6 lugares y un repo sin medición no debe tapar un
    # movimiento real (pasó con los snapshots publicados del 09-05 y el 09-06).
    reales, medicion, presencia = [], [], []
    for k in list(pb) + [k for k in pa if k not in pb]:
        if k not in pa:
            if pb[k] is not None:
                presencia.append(f"{k}: nuevo -> {txt(pb[k])}")
        elif k not in pb:
            if pa[k] is not None:
                presencia.append(f"{k}: {txt(pa[k])} -> salió")
        elif pa[k] != pb[k]:
            destino = reales if pa[k] is not None and pb[k] is not None else medicion
            destino.append(f"{k}: {txt(pa[k])} -> {txt(pb[k])}")
    movidos = reales + medicion + presencia
    detalle = " · ".join(movidos[:6]) if movidos else "sin desglose"
    fin(f"CAMBIO|{pct(an, ad)}|{pct(bn, bd)}|{limpio(detalle)}")
except Exception as e:  # noqa: BLE001 — cualquier falla se AVISA como "no pude comparar"
    print("NO_PUDE_COMPARAR|" + limpio(type(e).__name__ + ": " + motivo(str(e))))
PY
)"
VEREDICTO="$(printf '%s\n' "$SALIDA_PY" | tail -n 1)"

AVISO=""
SALIDA=0
case "$VEREDICTO" in
  IGUAL)
    log "veredicto: IGUAL — la evidencia DoD no se movió; no aviso" ;;
  SIN_PREVIO)
    log "veredicto: SIN_PREVIO — hay un solo snapshot publicado; no aviso" ;;
  SIN_SNAPSHOTS)
    log "veredicto: SIN_SNAPSHOTS — no hay ni un snapshot publicado en main"
    AVISO="Aviso DoD: no hay ni un snapshot del medidor SDLC publicado en main. El nocturno no está dejando rastro."
    SALIDA=3 ;;
  NO_PUBLICADO\|*)
    ULTIMO="${VEREDICTO#NO_PUBLICADO|}"
    log "veredicto: NO_PUBLICADO — el de hoy ($HOY) no está en main; el último es del $ULTIMO"
    AVISO="Aviso DoD: el snapshot de hoy ($HOY) no está publicado en main a las $(date -u +%H:%M) UTC; el último es del $ULTIMO. Sin medición no hay 'sin cambios'." ;;
  NO_PUDE\|*)
    MOTIVO="${VEREDICTO#NO_PUDE|}"
    log "veredicto: NO_PUDE — $MOTIVO"
    AVISO="Aviso DoD: no pude mirar si el nocturno publicó hoy ($HOY) el snapshot del medidor SDLC — $MOTIVO"
    SALIDA=2 ;;
  NO_PUDE_COMPARAR\|*)
    MOTIVO="${VEREDICTO#NO_PUDE_COMPARAR|}"
    log "veredicto: NO_PUDE_COMPARAR — $MOTIVO"
    AVISO="Aviso DoD: no pude comparar los snapshots del medidor SDLC de hoy ($HOY) — $MOTIVO"
    SALIDA=2 ;;
  CAMBIO\|*)
    IFS='|' read -r _ ANTES AHORA DETALLE <<< "$VEREDICTO"
    log "veredicto: CAMBIO — $ANTES -> $AHORA"
    AVISO="Se movió la evidencia DoD del nocturno: $ANTES -> $AHORA. $DETALLE" ;;
  *)
    MOTIVO="$(motivo_de "$SALIDA_PY")"
    log "veredicto: NO_PUDE_COMPARAR — salida inesperada del comparador: $MOTIVO"
    AVISO="Aviso DoD: no pude comparar los snapshots del medidor SDLC de hoy ($HOY) — salida inesperada del comparador: $MOTIVO"
    SALIDA=2 ;;
esac

# ── 3. Entregar: los pendientes de corridas anteriores + el aviso de hoy, en UN mensaje ───────
# Se arma en Python por dos motivos medidos: `read` pierde la última línea de un archivo sin salto
# final (el pendiente no se mandaba y se borraba igual), y sin tope el mensaje de varias noches
# fallidas pasa los 4096 caracteres de Telegram y no se entrega NUNCA más. Entra siempre el aviso
# de hoy; de los pendientes, los más nuevos que quepan; los más viejos se resumen en una línea y
# su texto queda en el registro antes de borrarse.
AVISO_1L="$(printf '%s' "$AVISO" | tr '\t\n' '  ')"
ARMADO="$(python3 - "$PENDIENTES" "$AVISO_1L" "$HOY" "$LIMITE_MENSAJE" 2>&1 <<'ARMAR'
import sys
ruta, aviso, hoy, limite = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
pend = []
try:
    with open(ruta, encoding="utf-8", errors="replace") as f:
        for linea in f.read().splitlines():
            if not linea.strip():
                continue
            fecha, _, texto = linea.partition("\t")
            if not texto.strip():
                fecha, texto = "?", linea
            pend.append((fecha.strip(), texto.strip()))
except FileNotFoundError:
    pass
ya = any(f == hoy and t == aviso for f, t in pend)
de_hoy = aviso if aviso and not ya else ""
lineas = [f"(aviso del {f} que no se pudo entregar) {t}" for f, t in pend]
presupuesto = limite - len(de_hoy) - 250
entran, usado = [], 0
for l in reversed(lineas):
    if usado + len(l) + 1 > presupuesto:
        break
    entran.append(l)
    usado += len(l) + 1
entran.reverse()
omitidos = pend[: len(pend) - len(entran)]
partes = []
if omitidos:
    partes.append(f"(y {len(omitidos)} aviso(s) pendiente(s) más viejos, del {omitidos[0][0]} al {omitidos[-1][0]}, "
                  "que no entran en un mensaje: su texto quedó en el registro del aviso)")
partes += entran
if de_hoy:
    partes.append(de_hoy)
mensaje = "\n".join(partes)
if len(mensaje) > limite:
    mensaje = mensaje[: limite - 1] + "…"
print(f"{int(ya)} {len(pend)} {len(omitidos)}")
for f, t in omitidos:
    print(f"{f} {t}")
print(mensaje)
ARMAR
)"
RC_ARMADO=$?
YA_PENDIENTE=0; N_PEND=0; N_OMIT=0
read -r YA_PENDIENTE N_PEND N_OMIT <<< "$(printf '%s\n' "$ARMADO" | sed -n 1p)"
case "$YA_PENDIENTE $N_PEND $N_OMIT" in *[!0-9\ ]*|'') RC_ARMADO=9 ;; esac   # cabecera ilegible = no pude leer
if [ "$RC_ARMADO" -eq 0 ]; then
  if [ "$N_OMIT" -gt 0 ]; then
    printf '%s\n' "$ARMADO" | sed -n "2,$((N_OMIT + 1))p" | while IFS= read -r OMITIDO || [ -n "$OMITIDO" ]; do
      log "pendiente que no entra en el mensaje (se resume y se borra al entregar): $OMITIDO"
    done
  fi
  MENSAJE="$(printf '%s\n' "$ARMADO" | sed -n "$((N_OMIT + 2)),\$p")"
else
  # Sin poder leer los pendientes, se manda sólo lo de hoy y el archivo NO se toca.
  log "no pude leer los pendientes de $PENDIENTES: $(motivo_de "$ARMADO") — mando sólo el aviso de hoy"
  YA_PENDIENTE=0; N_PEND=0; N_OMIT=0
  MENSAJE="$AVISO"
fi
[ -n "$MENSAJE" ] || exit "$SALIDA"

if [ "${TYCON_NOTICE_DRYRUN:-0}" = "1" ]; then
  log "[dry-run] $MENSAJE"
  exit "$SALIDA"
fi

# Sin script de envío cuenta como envío fallido: el veredicto ya quedó dicho y el aviso se guarda.
MOTIVO_ENVIO=""
INTENTO=1
PUEDE_ENVIAR=1
if [ ! -x "$NOTIFY" ]; then
  PUEDE_ENVIAR=0
  MOTIVO_ENVIO="falta el script de envío $NOTIFY (o no es ejecutable)"
  log "no puedo avisar: $MOTIVO_ENVIO"
fi
while [ "$PUEDE_ENVIAR" -eq 1 ]; do
  RESP="$("$NOTIFY" "$MENSAJE" 2>&1)"
  RC_ENVIO=$?
  if [ "$RC_ENVIO" -eq 0 ]; then
    if [ -n "${RESP//[[:space:]]/}" ]; then log "entregado (intento $INTENTO de $REINTENTOS): $(motivo_de "$RESP")"
    else log "entregado (intento $INTENTO de $REINTENTOS)"; fi
    if [ "$N_PEND" -gt 0 ]; then
      if rm -f "$PENDIENTES"; then log "pendientes entregados y borrados"; else log "entregué los pendientes pero no pude borrar $PENDIENTES"; fi
    fi
    exit "$SALIDA"
  fi
  MOTIVO_ENVIO="$(motivo_de "$RESP")"
  log "intento $INTENTO de $REINTENTOS falló (rc=$RC_ENVIO): $MOTIVO_ENVIO"
  [ "$INTENTO" -lt "$REINTENTOS" ] || break
  INTENTO=$((INTENTO + 1))
  sleep "$ESPERA_S"
done

log "NO SE ENTREGÓ el aviso ($MOTIVO_ENVIO): $MENSAJE"
if [ -n "$AVISO" ] && [ "$YA_PENDIENTE" -eq 0 ]; then
  # Si el archivo no termina en salto de línea (editado a mano, escritura cortada), se agrega uno
  # antes: si no, el pendiente nuevo quedaría pegado al anterior.
  ERR_GUARDAR="$( { mkdir -p "$ESTADO_DIR" \
    && { [ ! -s "$PENDIENTES" ] || [ -z "$(tail -c 1 "$PENDIENTES")" ] || printf '\n' >> "$PENDIENTES"; } \
    && printf '%s\t%s\n' "$HOY" "$AVISO_1L" >> "$PENDIENTES"; } 2>&1 )"
  if [ $? -eq 0 ]; then
    log "quedó pendiente en $PENDIENTES; se manda en la próxima corrida que logre entregar"
  else
    log "tampoco pude guardarlo como pendiente en $PENDIENTES: $(motivo_de "$ERR_GUARDAR")"
  fi
fi
exit 3
