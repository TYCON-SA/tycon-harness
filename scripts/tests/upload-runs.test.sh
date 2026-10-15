#!/usr/bin/env bash
# upload-runs.test.sh — la subida de las corridas al buzón de Azure Storage (story 2.16, rediseño).
#
# Sin red: el «buzón» es un servidor HTTP local (node:http) que imita Blob Storage — recibe PUT de
# blobs, contesta 201/403/404/500, corta la conexión a mitad o demora, y ANOTA cada pedido (método,
# ruta, query, cabeceras) para poder exigir que la subida sólo escriba. La config, el registro de
# corridas, el registro de subidas y el nombre de la máquina se fabrican (TYCON_MAILBOX_JSON,
# TYCON_MAILBOX_URL_BASE, TYCON_TIMING_HISTORY, TYCON_UPLOADS_LOG, TYCON_MACHINE): nunca se lee
# ni se toca lo de esta máquina, ni el buzón real.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrito su rojo previo. El exit code se lee ANTES de cualquier
#    pipe. bash 3.2 (macOS): siempre `${v}`.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# story 8.3: la integración «buzón» se declara por variable — sin perfil del equipo ni llave, upload-runs.js dice
# «apagado» y sale 0 antes de mirar el archivo de la llave, que es justo lo que esta suite mide (con un buzón de mentira).
export TYCON_MAILBOX=1
SUBIR="${RAIZ}/scripts/metrics/upload-runs.js"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

echo "== upload-runs.test.sh =="
[ -f "${SUBIR}" ] || { mal "no existe ${SUBIR} (rojo previo: el script todavía no está)"; echo; echo "${FALLOS} fallo(s)"; exit 1; }

BASE="$(mktemp -d)"
PIDS=""
# 🔴 AISLAMIENTO: HOME falso para todo lo que corra acá. El rojo previo de este archivo, corrido contra la
#    versión anterior del guion (la de git), leyó el ~/.claude/.tycon-pipeline/corridas.json REAL y empujó
#    datos de prueba al repo privado de verdad (2026-09-15). Con HOME falso, ninguna versión del guion
#    —vieja o nueva— puede encontrar una configuración, un registro o un sello de esta máquina.
mkdir -p "${BASE}/home"; export HOME="${BASE}/home"
unset TYCON_RUNS_JSON TYCON_MAILBOX_JSON TYCON_MAILBOX_URL_BASE TYCON_UPLOADS_LOG TYCON_MAILBOX_DIR
trap 'for p in ${PIDS}; do kill "${p}" 2>/dev/null; done; rm -rf "${BASE}"' EXIT

# ── el buzón de mentira ─────────────────────────────────────────────────────────────────────────
# Control por archivos en su carpeta: `modo` (ok|403|404|500|cut: corta la conexión), `demora` (ms por PUT).
cat > "${BASE}/buzon.js" <<'JS'
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = process.argv[2];
const leer = (f, d) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch (_) { return d; } };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const modo = leer('modo', 'ok');
  const trozos = [];
  let cortado = false;
  req.on('data', (c) => {
    if (modo === 'cut' && !cortado) { cortado = true; anotar(0); req.socket.destroy(); return; }
    trozos.push(c);
  });
  const anotar = (bytes) => fs.appendFileSync(path.join(dir, 'pedidos.jsonl'), JSON.stringify({
    metodo: req.method, ruta: decodeURIComponent(u.pathname), query: u.search,
    tipo: req.headers['x-ms-blob-type'] || null, version: req.headers['x-ms-version'] || null,
    md5: req.headers['content-md5'] || null, largo: req.headers['content-length'] || null, bytes,
    inm: req.headers['if-none-match'] || null,
  }) + '\n');
  req.on('end', () => {
    if (cortado) return;
    const cuerpo = Buffer.concat(trozos);
    anotar(cuerpo.length);
    const responder = () => {
      // `despues` = «N modo»: los primeros N PUT salen bien y desde ahí contesta `modo`.
      const despues = leer('despues', '').split(' ');
      if (despues.length === 2) {
        const hechos = Number(leer('hechos', '0'));
        if (hechos < Number(despues[0])) { fs.writeFileSync(path.join(dir, 'hechos'), String(hechos + 1)); }
        else if (despues[1] === '403') { res.writeHead(403); return res.end('<Error><Code>AuthenticationFailed</Code></Error>'); }
      }
      if (decodeURIComponent(u.pathname).includes('rechazado')) { res.writeHead(409); return res.end('<Error><Code>BlobAlreadyExists</Code></Error>'); }
      const rechazar = leer('rechazar', '');
      if (rechazar && decodeURIComponent(u.pathname).includes(rechazar)) { res.writeHead(409); return res.end('<Error><Code>BlobAlreadyExists</Code></Error>'); }
      if (modo === '403') { res.writeHead(403, { 'content-type': 'application/xml' }); return res.end('<?xml version="1.0"?><Error><Code>AuthenticationFailed</Code></Error>'); }
      if (modo === '404') { res.writeHead(404); return res.end('<Error><Code>ContainerNotFound</Code></Error>'); }
      if (modo === '500') { res.writeHead(500); return res.end('<Error><Code>InternalError</Code></Error>'); }
      if (req.method !== 'PUT') { res.writeHead(403); return res.end('<Error><Code>AuthorizationPermissionMismatch</Code></Error>'); }
      const md5 = crypto.createHash('md5').update(cuerpo).digest('base64');
      if (req.headers['content-md5'] && req.headers['content-md5'] !== md5) { res.writeHead(400); return res.end('<Error><Code>Md5Mismatch</Code></Error>'); }
      // story 2.24: `codigo403` = líneas «<Code> <parte del nombre | *>»: contesta 403 con ese código (medidos en el
      // laboratorio: UnauthorizedBlobOverwrite, AuthorizationPermissionMismatch, AuthenticationFailed).
      const ruta = decodeURIComponent(u.pathname);
      for (const l of leer('codigo403', '').split('\n').filter(Boolean)) {
        const [code, parte] = l.trim().split(/\s+/);
        if (parte === '*' || ruta.includes(parte)) { res.writeHead(403); return res.end(code === '-' ? '' : `<?xml version="1.0"?><Error><Code>${code}</Code></Error>`); }
      }
      const destino = path.join(dir, 'blobs', ruta);
      // Como Azure (medido, story 2.24): un nombre que ya existe con `If-None-Match: *` → 409 BlobAlreadyExists; con la
      // política «sólo crear» (`politica` = c) → 403 UnauthorizedBlobOverwrite, con o sin la cabecera.
      if (fs.existsSync(destino)) {
        if (leer('politica', 'cw') === 'c') { res.writeHead(403); return res.end('<?xml version="1.0"?><Error><Code>UnauthorizedBlobOverwrite</Code></Error>'); }
        if (req.headers['if-none-match'] === '*') { res.writeHead(409); return res.end('<?xml version="1.0"?><Error><Code>BlobAlreadyExists</Code></Error>'); }
      }
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, cuerpo);
      res.writeHead(201, { 'content-md5': md5 }); res.end();
    };
    const demora = Number(leer('demora', '0'));
    if (demora > 0) setTimeout(responder, demora); else responder();
  });
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(dir, 'puerto'), String(srv.address().port)));
JS

# buzon <dir> → levanta un buzón de mentira y deja su URL en URL_BUZON
buzon() {
  mkdir -p "$1"
  node "${BASE}/buzon.js" "$1" > "$1/servidor.log" 2>&1 &
  PIDS="${PIDS} $!"; disown "$!" 2>/dev/null
  local i=0; while [ ! -s "$1/puerto" ] && [ "${i}" -lt 100 ]; do sleep 0.05; i=$((i+1)); done
  URL_BUZON="http://127.0.0.1:$(cat "$1/puerto")"
}
# corrida <dir> <nombre> [bytes del hilo] — un volcado y su hilo comprimido
corrida() {
  mkdir -p "$1"
  printf '{"archivedAt":"2026-09-14T10:00:00.000Z","marker":{"storyId":"%s","sessionId":"sid-%s"}}\n' "$2" "$2" > "$1/$2.json"
  head -c "${3:-2000}" /dev/urandom | base64 | gzip -c > "$1/$2.hilo.jsonl.gz"
}
# La firma de mentira va en su propia variable (story 8.8, AC 3): escrita pegada a su parámetro, la línea tiene la forma
# de una llave de Azure Storage, y el escaneo de secretos de GitHub —que no lee las excepciones del equipo— la marcaría
# en la copia pública. La llave que arma cada caso es la de siempre.
FAKE_SIGNATURE='FIRMA%2Bdeprueba%3D'
# config <archivo> [vence] [sas]
config() {
  printf '{"cuenta":"cuentadeprueba","contenedor":"corridas","tenant":"00000000-0000-0000-0000-000000000000","politica":"subida-prueba","vence":"%s","sas":"%s"}\n' \
    "${2:-2099-01-01}" "${3:-sv=2022-11-02&si=subida-prueba&sr=c&spr=https&sig=${FAKE_SIGNATURE}}" > "$1"
}
# en <dias> → la fecha de hoy + N días (UTC)
en() { python3 -c "import datetime,sys; print((datetime.datetime.utcnow().date()+datetime.timedelta(days=int(sys.argv[1]))).isoformat())" "$1"; }
# subir <caso-dir> <origen> <maquina> [args...] → RC + salida en <caso>/out.json, <caso>/err.txt
subir() {
  local c="$1" ori="$2" maq="$3"; shift 3
  TYCON_MAILBOX_JSON="${c}/cfg.json" TYCON_MAILBOX_URL_BASE="${URL_BUZON}" TYCON_TIMING_HISTORY="${ori}" \
    TYCON_UPLOADS_LOG="${c}/estado/mailbox-uploads.json" TYCON_MACHINE="${maq}" \
    node "${SUBIR}" --json "$@" > "${c}/out.json" 2> "${c}/err.txt"
  RC=$?
}
campo() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); v=d.get(sys.argv[2]); print(json.dumps(v) if isinstance(v,(dict,list,bool)) or v is None else v)" "$1/out.json" "$2" 2>/dev/null; }
num() { local v; v="$(campo "$1" "$2")"; case "${v}" in ''|*[!0-9]*) echo -1 ;; *) echo "${v}" ;; esac; }
puts() { if [ -f "$1/pedidos.jsonl" ]; then grep -c '"metodo":"PUT"' "$1/pedidos.jsonl" || true; else echo 0; fi; }
pedidos() { if [ -f "$1/pedidos.jsonl" ]; then wc -l < "$1/pedidos.jsonl" | tr -d ' '; else echo 0; fi; }
en_registro() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('\n'.join(sorted(d.get('archivos',{}).keys())))" "$1/estado/mailbox-uploads.json" 2>/dev/null; }
# story 2.24: los registros suben como un juego bajo `<maq>/registros/v<versión>/`, y lo que se vuelve a subir bajo
# `<maq>/v<versión>/`. regdir <caso> [maq] → la carpeta del juego más nuevo en el buzón de mentira (vacío si no hay).
regdir() { local d="$1/b/blobs/corridas/${2:-maq-a}/registros"; local v; v="$(ls -d "${d}"/v* 2>/dev/null | sort | tail -1)"; echo "${v}"; }
# versiones <caso> <maq> → las carpetas v… de corridas de esa máquina, una por línea
versiones() { ls -d "$1/b/blobs/corridas/$2"/v* 2>/dev/null | sort; }
# ultimo <caso> <maq> <archivo> → el blob más nuevo de ese archivo (la última versión, o el nombre de siempre)
ultimo() { local v; v="$(ls "$1/b/blobs/corridas/$2"/v*/"$3" 2>/dev/null | sort | tail -1)"; [ -n "${v}" ] && echo "${v}" || echo "$1/b/blobs/corridas/$2/$3"; }
FORMA_V='v[0-9]{8}T[0-9]{9}Z'

# ── T1 · sube bajo <maquina>/ normalizada, como BlockBlob, con la SAS en la query (AC1) ───────────
# 🔴 rojo previo: subir a la raíz del contenedor → dos máquinas pisan el mismo nombre.
T="${BASE}/t1"; buzon "${T}/b"; config "${T}/cfg.json"
corrida "${T}/h" "2.1-2026-09-01T1000" 3000; corrida "${T}/h" "2.2-2026-09-02T1100" 5000
subir "${T}" "${T}/h" "Mac-De-Prueba.local"
[ "${RC}" -eq 0 ] && ok "T1 exit 0" || mal "T1 esperaba exit 0, fue ${RC}: $(head -3 "${T}/err.txt")"
for f in 2.1-2026-09-01T1000.json 2.1-2026-09-01T1000.hilo.jsonl.gz 2.2-2026-09-02T1100.json 2.2-2026-09-02T1100.hilo.jsonl.gz; do
  if cmp -s "${T}/h/${f}" "${T}/b/blobs/corridas/mac-de-prueba/${f}"; then ok "T1 llegó mac-de-prueba/${f}, idéntico"; else mal "T1 no llegó (o llegó distinto) mac-de-prueba/${f}"; fi
done
python3 - "${T}/b/pedidos.jsonl" <<'PY' && ok "T1 cada PUT: BlockBlob, x-ms-version, Content-MD5 y la SAS (sig=) en la query, bajo /corridas/mac-de-prueba/" || mal "T1 algún PUT sin las cabeceras, sin la SAS o fuera de la carpeta de la máquina"
import json, sys
ps = [json.loads(l) for l in open(sys.argv[1])]
assert len(ps) == 4, len(ps)
for p in ps:
    assert p['metodo'] == 'PUT' and p['tipo'] == 'BlockBlob' and p['version'] and p['md5'], p
    assert 'sig=' in p['query'] and 'si=subida-prueba' in p['query'], p
    assert p['ruta'].startswith('/corridas/mac-de-prueba/') and p['ruta'].count('/') == 3, p
PY
[ "$(campo "${T}" subidos)" = "4" ] && ok "T1 el resumen dice 4 archivos subidos" || mal "T1 subidos=$(campo "${T}" subidos)"
BYTES=$(( $(wc -c < "${T}/h/2.1-2026-09-01T1000.json") + $(wc -c < "${T}/h/2.1-2026-09-01T1000.hilo.jsonl.gz") + $(wc -c < "${T}/h/2.2-2026-09-02T1100.json") + $(wc -c < "${T}/h/2.2-2026-09-02T1100.hilo.jsonl.gz") ))
[ "$(campo "${T}" bytes)" = "${BYTES}" ] && ok "T1 el resumen dice los bytes subidos (${BYTES})" || mal "T1 bytes=$(campo "${T}" bytes), esperaba ${BYTES}"
[ "$(campo "${T}" subido)" = "true" ] && [ "$(campo "${T}" maquina)" = "mac-de-prueba" ] && ok "T1 subido=true, máquina mac-de-prueba" || mal "T1 subido=$(campo "${T}" subido) maquina=$(campo "${T}" maquina)"

# ── T2 · la segunda pasada no hace ningún PUT (AC2) ─────────────────────────────────────────────
# 🔴 rojo previo: sin registro local la llave no deja preguntar qué hay → re-sube todo en cada arranque.
ANTES=$(puts "${T}/b")
subir "${T}" "${T}/h" "Mac-De-Prueba.local"
[ "${RC}" -eq 0 ] && [ "$(puts "${T}/b")" = "${ANTES}" ] && ok "T2 segunda pasada: exit 0 y ningún PUT" || mal "T2 rc=${RC}, PUTs antes ${ANTES} después $(puts "${T}/b")"
[ "$(campo "${T}" estado)" = "nada_nuevo" ] && [ "$(campo "${T}" subido)" = "false" ] && ok "T2 lo dice: estado nada_nuevo, subido=false" || mal "T2 estado=$(campo "${T}" estado) subido=$(campo "${T}" subido)"

# ── T3 · sólo lo que creció; un touch sin cambio no sube (AC2) ──────────────────────────────────
# 🔴 rojo previo: comparar por nombre → el hilo que el barrido de la 2.13 reescribió nunca se actualiza.
ANTES=$(puts "${T}/b")
cp "${T}/b/blobs/corridas/mac-de-prueba/2.2-2026-09-02T1100.hilo.jsonl.gz" "${T}/hilo-viejo"
head -c 9000 /dev/urandom | base64 | gzip -c > "${T}/h/2.2-2026-09-02T1100.hilo.jsonl.gz"
touch -t 202601010101 "${T}/h/2.1-2026-09-01T1000.json"
subir "${T}" "${T}/h" "Mac-De-Prueba.local"
N=$(( $(puts "${T}/b") - ANTES ))
[ "${RC}" -eq 0 ] && [ "${N}" = "1" ] && ok "T3 sólo el hilo que creció se re-subió (1 PUT)" || mal "T3 rc=${RC}, ${N} PUT(s) (esperaba 1)"
tail -1 "${T}/b/pedidos.jsonl" | grep -E "/mac-de-prueba/${FORMA_V}/2\.2-2026-09-02T1100\.hilo\.jsonl\.gz\"" >/dev/null && ok "T3 y fue el hilo reescrito, a una versión (story 2.24)" || mal "T3 el PUT fue otro: $(tail -1 "${T}/b/pedidos.jsonl")"
# story 2.24 (hoy-T3): nada se pisa — el contenido nuevo queda en la versión, el blob del nombre de siempre igual que antes
cmp -s "${T}/h/2.2-2026-09-02T1100.hilo.jsonl.gz" "$(ultimo "${T}" mac-de-prueba 2.2-2026-09-02T1100.hilo.jsonl.gz)" && cmp -s "${T}/hilo-viejo" "${T}/b/blobs/corridas/mac-de-prueba/2.2-2026-09-02T1100.hilo.jsonl.gz" \
  && ok "T3 el contenido nuevo quedó en la versión y el blob viejo quedó igual" || mal "T3 la versión no tiene lo nuevo, o el blob viejo cambió"
ANTES=$(puts "${T}/b"); subir "${T}" "${T}/h" "Mac-De-Prueba.local"
[ "$(puts "${T}/b")" = "${ANTES}" ] && ok "T3 después del touch, la pasada siguiente sigue sin subir (el hash se recordó)" || mal "T3 el touch provocó una subida en la pasada siguiente"

# ── T3b · el archivo se reescribe con el MISMO tamaño mientras sube: la pasada siguiente lo re-sube (AC2) ──
# 🔴 rojo previo (adversarial): el registro anotaba el mtime de DESPUÉS del PUT con el hash de ANTES → «subido»
#    falso para siempre, con el blob viejo en el buzón.
T="${BASE}/t3b"; buzon "${T}/b"; config "${T}/cfg.json"; mkdir -p "${T}/h"
printf '{"marker":{"sessionId":"sid-carrera"},"out":11111}\n' > "${T}/h/2.9-2026-09-09T0900.json"
echo 1500 > "${T}/b/demora"
( subir "${T}" "${T}/h" "maq-a" ) &
CARRERA=$!
sleep 0.7
printf '{"marker":{"sessionId":"sid-carrera"},"out":99999}\n' > "${T}/h/2.9-2026-09-09T0900.json"
wait "${CARRERA}"
echo 0 > "${T}/b/demora"
subir "${T}" "${T}/h" "maq-a"
cmp -s "${T}/h/2.9-2026-09-09T0900.json" "$(ultimo "${T}" maq-a 2.9-2026-09-09T0900.json)" && ok "T3b reescrito con el mismo tamaño durante el PUT → la pasada siguiente sube lo nuevo" || mal "T3b el buzón quedó con el contenido viejo (estado $(campo "${T}" estado), subidos $(campo "${T}" subidos))"

# ── T6c · una fecha de vencimiento imposible no deja la llave sin vigilancia (AC4) ──────────────
# 🔴 rojo previo (adversarial): «2027-13-15» pasaba la forma, diasHasta daba NaN y el aviso no salía nunca.
T="${BASE}/t6c"; buzon "${T}/b"; corrida "${T}/h" "5.3-2026-09-05T0700"
config "${T}/cfg.json" "2027-13-15"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "config_ilegible" ] && [ "$(pedidos "${T}/b")" = "0" ] && ok "T6c vence 2027-13-15 → config_ilegible, exit 1, ningún pedido" || mal "T6c fecha imposible → rc=${RC} estado=$(campo "${T}" estado) aviso=$(campo "${T}" aviso_vence)"

# ── T1c · en macOS el nombre no sigue a la red: HostName fijado, o si no LocalHostName (AC1) ───────
# 🔴 rojo previo (adversarial): sin HostName fijado, os.hostname() cambia con la red (x.lan / x.home) → la misma
#    máquina escribe en dos carpetas del buzón y re-sube todo.
if [ "$(uname -s)" = "Darwin" ]; then
  T="${BASE}/t1c"; mkdir -p "${T}/bin"
  printf '#!/bin/sh\n[ "$2" = HostName ] && { echo "HostName: not set" >&2; exit 1; }\n[ "$2" = LocalHostName ] && { echo "Devbs-MacBook-Pro"; exit 0; }\nexit 1\n' > "${T}/bin/scutil"; chmod +x "${T}/bin/scutil"
  N="$(env -u TYCON_MACHINE PATH="${T}/bin:${PATH}" node -e "console.log(require('${SUBIR}').nombreDeMaquina())")"
  [ "${N}" = "devbs-macbook-pro" ] && ok "T1c sin HostName → LocalHostName (devbs-macbook-pro), no el nombre que da la red" || mal "T1c nombre: «${N}»"
  printf '#!/bin/sh\n[ "$2" = HostName ] && { echo "equipo-deva"; exit 0; }\nexit 1\n' > "${T}/bin/scutil"
  N="$(env -u TYCON_MACHINE PATH="${T}/bin:${PATH}" node -e "console.log(require('${SUBIR}').nombreDeMaquina())")"
  [ "${N}" = "equipo-deva" ] && ok "T1c con HostName fijado → ése (equipo-deva)" || mal "T1c con HostName: «${N}»"
else
  ok "T1c (no es macOS: el nombre sale de os.hostname())"
fi

# ── T4 · un corte a mitad nunca marca «subido» (AC2) ────────────────────────────────────────────
# 🔴 rojo previo: anotar en el registro antes de la respuesta → «subido» falso para siempre.
T="${BASE}/t4"; buzon "${T}/b"; config "${T}/cfg.json"
corrida "${T}/h" "3.1-2026-09-03T0900" 4000
echo cut > "${T}/b/modo"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -ne 0 ] && ok "T4 conexión cortada → exit ≠ 0 (fue ${RC})" || mal "T4 conexión cortada salió 0"
[ -z "$(en_registro "${T}")" ] && ok "T4 nada quedó anotado en el registro" || mal "T4 el registro anotó: $(en_registro "${T}")"
[ "$(campo "${T}" subido)" = "false" ] && ok "T4 subido=false" || mal "T4 subido=$(campo "${T}" subido)"
echo ok > "${T}/b/modo"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 0 ] && cmp -s "${T}/h/3.1-2026-09-03T0900.hilo.jsonl.gz" "${T}/b/blobs/corridas/maq-a/3.1-2026-09-03T0900.hilo.jsonl.gz" && ok "T4 la pasada siguiente lo sube entero" || mal "T4 la pasada siguiente no lo subió (rc=${RC})"
[ "$(en_registro "${T}" | wc -l | tr -d ' ')" = "2" ] && ok "T4 y recién ahí queda en el registro (2 archivos)" || mal "T4 registro: $(en_registro "${T}" | tr '\n' ' ')"

# ── T5 · llave vencida/revocada distinta de sin red; ninguna marca nada (AC3) ───────────────────
# 🔴 rojo previo: un solo motivo genérico → nadie se entera de que hay que rotar la llave.
for CODIGO in 403 404; do
  T="${BASE}/t5-${CODIGO}"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "4.1-2026-09-04T0800"
  echo "${CODIGO}" > "${T}/b/modo"
  subir "${T}" "${T}/h" "maq-a"
  [ "${RC}" -ne 0 ] && [ "$(campo "${T}" estado)" = "llave_invalida" ] && ok "T5 ${CODIGO} → exit ${RC}, estado llave_invalida" || mal "T5 ${CODIGO} → rc=${RC} estado=$(campo "${T}" estado)"
  campo "${T}" motivo | grep 'vencida o revocada' >/dev/null && ok "T5 ${CODIGO} → el motivo dice «vencida o revocada»" || mal "T5 ${CODIGO} → motivo: $(campo "${T}" motivo)"
  [ -z "$(en_registro "${T}")" ] && [ "$(campo "${T}" subido)" = "false" ] && ok "T5 ${CODIGO} → nada anotado, subido=false" || mal "T5 ${CODIGO} → anotó algo o subido=true"
done
T="${BASE}/t5-red"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "4.1-2026-09-04T0800"
for p in ${PIDS}; do :; done; kill "${p}" 2>/dev/null; sleep 0.2   # el último buzón: puerto cerrado
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -ne 0 ] && [ "$(campo "${T}" estado)" = "sin_red" ] && ok "T5 puerto cerrado → exit ${RC}, estado sin_red" || mal "T5 puerto cerrado → rc=${RC} estado=$(campo "${T}" estado)"
campo "${T}" motivo | grep 'sin red' >/dev/null && ! campo "${T}" motivo | grep 'vencida' >/dev/null && ok "T5 puerto cerrado → el motivo dice «sin red» y no habla de la llave" || mal "T5 puerto cerrado → motivo: $(campo "${T}" motivo)"
[ -z "$(en_registro "${T}")" ] && ok "T5 sin red → nada anotado" || mal "T5 sin red → anotó algo"
T="${BASE}/t5-500"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "4.1-2026-09-04T0800"; echo 500 > "${T}/b/modo"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -ne 0 ] && [ "$(campo "${T}" estado)" != "llave_invalida" ] && [ -z "$(en_registro "${T}")" ] && ok "T5 500 del servicio → exit ${RC}, no se confunde con la llave ($(campo "${T}" estado)), nada anotado" || mal "T5 500 → rc=${RC} estado=$(campo "${T}" estado)"

# ── T5b · 403 a mitad de la pasada: lo que subió queda anotado, el resumen NO dice «subido» (AC3) ──
# 🔴 rojo previo (tests-coverage + spec-first, iter 1): subido=true con estado llave_invalida, y un motivo
#    que decía a la vez «no se marcó nada» y «N sí subieron».
T="${BASE}/t5b"; buzon "${T}/b"; config "${T}/cfg.json"
corrida "${T}/h" "4.1-2026-09-04T0800"; corrida "${T}/h" "4.2-2026-09-04T0900"
echo "2 403" > "${T}/b/despues"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -ne 0 ] && [ "$(campo "${T}" estado)" = "llave_invalida" ] && [ "$(campo "${T}" subido)" = "false" ] && ok "T5b 403 después de 2 subidas → exit ${RC}, llave_invalida, subido=false" || mal "T5b rc=${RC} estado=$(campo "${T}" estado) subido=$(campo "${T}" subido)"
[ "$(campo "${T}" subidos)" = "2" ] && [ "$(en_registro "${T}" | wc -l | tr -d ' ')" = "2" ] && ok "T5b los 2 que el servicio confirmó quedan anotados y contados" || mal "T5b subidos=$(campo "${T}" subidos), registro $(en_registro "${T}" | wc -l)"
campo "${T}" motivo | grep -i 'no se marcó nada más' >/dev/null && ! campo "${T}" motivo | grep -i 'no se marcó nada;' >/dev/null && ok "T5b el motivo no se contradice («no se marcó nada más» + los que sí)" || mal "T5b motivo: $(campo "${T}" motivo)"

# ── T-E · los estados del contrato que no tenían caso (tests-coverage iter 1) ───────────────────
# 🔴 rojo previo: dry_run, parcial, sin_registro y sin_maquina figuraban en el contrato y ningún caso los ejercía.
T="${BASE}/te"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "9.1-2026-09-09T0100"; corrida "${T}/h" "9.2-rechazado-2026-09-09T0200"
subir "${T}" "${T}/h" "maq-a" --dry-run
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" estado)" = "dry_run" ] && [ "$(campo "${T}" a_subir)" = "4" ] && [ "$(pedidos "${T}/b")" = "0" ] && [ ! -e "${T}/estado/mailbox-uploads.json" ] && ok "T-E --dry-run → exit 0, a_subir 4, ningún pedido, sin registro" || mal "T-E dry-run rc=${RC} estado=$(campo "${T}" estado) a_subir=$(campo "${T}" a_subir) pedidos=$(pedidos "${T}/b")"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "parcial" ] && [ "$(campo "${T}" subido)" = "false" ] && [ "$(campo "${T}" subidos)" = "2" ] && ok "T-E un 409 (los dos archivos de la corrida rechazada) → parcial, exit 1, subido=false, los otros 2 sí subieron" || mal "T-E parcial rc=${RC} estado=$(campo "${T}" estado) subido=$(campo "${T}" subido) subidos=$(campo "${T}" subidos)"
en_registro "${T}" | grep rechazado >/dev/null && mal "T-E el rechazado quedó anotado" || ok "T-E el rechazado no quedó anotado"
# una máquina que nunca corrió el pipeline NO tiene timing-history: eso es «nada que subir», no un fallo en cada arranque
# 🔴 rojo previo (adversarial, integración): exit 1 «sin_registro» en TODAS las máquinas nuevas del equipo, cada arranque.
subir "${T}" "${T}/no-hay-registro" "maq-a"
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" estado)" = "sin_corridas" ] && [ "$(pedidos "${T}/b")" = "0" ] || true
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" estado)" = "sin_corridas" ] && ok "T-E sin timing-history (máquina que nunca corrió el pipeline) → exit 0, sin_corridas" || mal "T-E sin timing-history rc=${RC} estado=$(campo "${T}" estado)"
mkdir -p "${T}/cerrado"; chmod 000 "${T}/cerrado"
subir "${T}" "${T}/cerrado" "maq-a"; chmod 755 "${T}/cerrado"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "sin_registro" ] && ok "T-E timing-history que existe y no se puede leer → sin_registro, exit 1" || mal "T-E registro ilegible rc=${RC} estado=$(campo "${T}" estado)"
subir "${T}" "${T}/h" "..."
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "sin_maquina" ] && ok "T-E nombre de máquina que queda vacío → sin_maquina, exit 1" || mal "T-E sin máquina rc=${RC} estado=$(campo "${T}" estado)"

# ── T6 · sin llave no sube y lo dice; por vencer, aviso con fecha una vez por día (AC4) ─────────
# 🔴 rojo previo: vencimiento silencioso → un día todas las máquinas dejan de subir y nadie lo sabe;
#    o aviso en cada sesión → ruido que se aprende a ignorar.
T="${BASE}/t6"; buzon "${T}/b"; corrida "${T}/h" "5.1-2026-09-05T0700"
subir "${T}" "${T}/h" "maq-a"          # sin cfg.json
[ "${RC}" -ne 0 ] && [ "$(campo "${T}" estado)" = "sin_config" ] && [ "$(pedidos "${T}/b")" = "0" ] && ok "T6 sin corridas-buzon.json → exit ${RC}, estado sin_config, ningún pedido" || mal "T6 sin config → rc=${RC} estado=$(campo "${T}" estado) pedidos=$(pedidos "${T}/b")"
campo "${T}" motivo | grep 'corridas-buzon.json' >/dev/null && ok "T6 y lo dice nombrando el archivo" || mal "T6 motivo: $(campo "${T}" motivo)"
echo '{"cuenta": "x",' > "${T}/cfg.json"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -ne 0 ] && [ "$(campo "${T}" estado)" = "config_ilegible" ] && [ "$(pedidos "${T}/b")" = "0" ] && ok "T6 config ilegible → exit ${RC}, config_ilegible, ningún pedido" || mal "T6 ilegible → rc=${RC} estado=$(campo "${T}" estado)"
printf '{"cuenta":"c","contenedor":"corridas","vence":"2099-01-01"}\n' > "${T}/cfg.json"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -ne 0 ] && [ "$(campo "${T}" estado)" = "config_ilegible" ] && ok "T6 config sin «sas» → config_ilegible" || mal "T6 sin sas → rc=${RC} estado=$(campo "${T}" estado)"
VENCE=$(en 20); config "${T}/cfg.json" "${VENCE}"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" aviso_vence)" = "emitido" ] && ok "T6 vence en 20 días → sube igual y el aviso sale (emitido)" || mal "T6 vence en 20 → rc=${RC} aviso=$(campo "${T}" aviso_vence)"
grep -q "${VENCE}" "${T}/err.txt" && ok "T6 el aviso trae la fecha (${VENCE})" || mal "T6 el aviso no trae la fecha: $(head -3 "${T}/err.txt")"
subir "${T}" "${T}/h" "maq-a"
[ "$(campo "${T}" aviso_vence)" = "ya_emitido_hoy" ] && ! grep -q "${VENCE}" "${T}/err.txt" && ok "T6 la segunda pasada del día no lo repite" || mal "T6 segunda pasada: aviso=$(campo "${T}" aviso_vence)"
T="${BASE}/t6b"; buzon "${T}/b"; corrida "${T}/h" "5.1-2026-09-05T0700"; config "${T}/cfg.json" "$(en 60)"
subir "${T}" "${T}/h" "maq-a"
[ "$(campo "${T}" aviso_vence)" = "null" ] && ok "T6 vence en 60 días → sin aviso" || mal "T6 vence en 60 → aviso=$(campo "${T}" aviso_vence)"

# ── T7 · nunca lee: sólo PUT; una llave que lee o lista no se acepta (AC5) ──────────────────────
# 🔴 rojo previo: un GET o un LIST para comparar → la llave necesitaría leer, y leería lo de todos.
NO_PUT=$(cat "${BASE}"/t*/b/pedidos.jsonl 2>/dev/null | grep -vc '"metodo":"PUT"' || true)
TOTAL=$(cat "${BASE}"/t*/b/pedidos.jsonl 2>/dev/null | wc -l | tr -d ' ')
[ "${TOTAL}" -gt 0 ] && [ "${NO_PUT}" = "0" ] && ok "T7 de ${TOTAL} pedidos en todos los casos, ninguno fue otra cosa que PUT" || mal "T7 hubo ${NO_PUT} pedido(s) que no son PUT (de ${TOTAL})"
T="${BASE}/t7"; buzon "${T}/b"; corrida "${T}/h" "6.1-2026-09-06T0600"
config "${T}/cfg.json" "2099-01-01" "sv=2022-11-02&sp=rcwl&sr=c&se=2099-01-01&sig=x"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 2 ] && [ "$(campo "${T}" estado)" = "llave_con_lectura" ] && [ "$(pedidos "${T}/b")" = "0" ] && ok "T7 SAS con sp=rcwl → exit 2, llave_con_lectura, ningún pedido" || mal "T7 SAS con lectura → rc=${RC} estado=$(campo "${T}" estado) pedidos=$(pedidos "${T}/b")"
config "${T}/cfg.json" "2099-01-01" "sv=2022-11-02&ss=b&srt=co&sp=cw&se=2099-01-01&sig=x"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 2 ] && [ "$(pedidos "${T}/b")" = "0" ] && ok "T7 SAS de CUENTA (ss/srt) → exit 2, ningún pedido" || mal "T7 SAS de cuenta → rc=${RC} pedidos=$(pedidos "${T}/b")"
grep -Eq "method: *'(GET|DELETE|HEAD)'|comp=list" "${SUBIR}" && mal "T7 el script tiene una operación de lectura/listado" || ok "T7 el script no tiene GET/HEAD/DELETE ni comp=list"

# ── T8 · presupuesto: lo que no entró queda para después y se cuenta; ningún blob parcial (AC6) ─
# 🔴 rojo previo: cortar a mitad de un PUT → un hilo truncado queda como la copia del buzón.
T="${BASE}/t8"; buzon "${T}/b"; config "${T}/cfg.json"; echo 15 > "${T}/b/demora"
i=0; while [ "${i}" -lt 50 ]; do corrida "${T}/h" "7.$(printf %02d ${i})-2026-09-07T0500" 300; i=$((i+1)); done
subir "${T}" "${T}/h" "maq-a" --budget-ms 150
S=$(num "${T}" subidos); ST=$(num "${T}" sin_tiempo)
[ "${RC}" -eq 0 ] && [ "$((S + ST))" = "100" ] && [ "${ST}" -gt 0 ] && ok "T8 tope chico: subidos ${S} + sin_tiempo ${ST} = 100, exit 0" || mal "T8 rc=${RC} subidos=${S} sin_tiempo=${ST}"
[ "$(en_registro "${T}" | wc -l | tr -d ' ')" = "${S}" ] && ok "T8 el registro anota exactamente los ${S} subidos" || mal "T8 registro con $(en_registro "${T}" | wc -l) (subidos ${S})"
PARCIALES=0
for f in "${T}"/b/blobs/corridas/maq-a/*; do cmp -s "${f}" "${T}/h/$(basename "${f}")" || PARCIALES=$((PARCIALES+1)); done
[ "${PARCIALES}" = "0" ] && ok "T8 ningún blob parcial en el buzón" || mal "T8 ${PARCIALES} blob(s) distintos del original"
echo 0 > "${T}/b/demora"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" subidos)" = "${ST}" ] && [ "$(ls "${T}/b/blobs/corridas/maq-a" | wc -l | tr -d ' ')" = "100" ] && ok "T8 la pasada siguiente sube los ${ST} que faltaban (100 en total)" || mal "T8 segunda pasada rc=${RC} subidos=$(campo "${T}" subidos), en el buzón $(ls "${T}/b/blobs/corridas/maq-a" | wc -l)"

# ── 2.5 T1 · los registros de frenos y escapes suben una vez por día, comprimidos y PRIMERO (story 2.5, AC1) ──
# 🔴 rojo previo: subirlos en cada pasada → 2,4 MB en cada arranque; al final de la cola → con un atraso de
#    hilos y el presupuesto chico no entran nunca; la cobertura antes que los .gz → un corte deja una
#    cobertura nueva apuntando a registros viejos.
registros() {   # <origen> — los dos registros con algo adentro
  mkdir -p "$1"
  for i in $(seq 1 40); do echo "{\"ts\":\"2026-09-14T10:00:${i}Z\",\"name\":\"tests\",\"status\":\"green\",\"cmd\":\"npm test ${i}\"}"; done > "$1/gates.log"
  echo '{"ts":"2026-09-14T11:00:00Z","type":"FULL_SUITE_RUN","command":"npm test"}' > "$1/bypass.log"
}
subir_reg() {   # <caso> <origen timing> <origen registros> <hoy> <maquina> [args...]
  local c="$1" ori="$2" reg="$3" dia="$4" maq="$5"; shift 5
  TYCON_LOGS_SOURCE="${reg}" TYCON_LOGS_DIR="${c}/estado/registros-buzon" TYCON_TODAY="${dia}" subir "${c}" "${ori}" "${maq}" "$@"
}
T="${BASE}/t1-25"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
for i in $(seq 1 20); do corrida "${T}/h" "1.${i}-2026-09-01T1000" 4000; done
echo 150 > "${T}/b/demora"
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a" --budget-ms 400
R="$(regdir "${T}")"
gunzip -c "${R}/gates.log.gz" 2>/dev/null | cmp -s - "${T}/reg/gates.log" && gunzip -c "${R}/bypass.log.gz" 2>/dev/null | cmp -s - "${T}/reg/bypass.log" \
  && [ "$(num "${T}" sin_tiempo)" -gt 0 ] && ok "2.5-T1 con presupuesto chico y 20 corridas atrasadas, los dos registros subieron primero y descomprimen idénticos" || mal "2.5-T1 registros no llegaron primero o distintos (rc=${RC}, sin_tiempo=$(num "${T}" sin_tiempo)): $(ls "${R}" 2>&1)"
python3 - "${T}/b/pedidos.jsonl" "${R}/cobertura.json" <<'PY' && ok "2.5-T1 los tres primeros PUT son los registros, con la cobertura al final; la cobertura dice la fecha y las dos fuentes medidas" || mal "2.5-T1 orden o cobertura: $(head -3 "${T}/b/pedidos.jsonl" | cut -c1-120) $(cat "${R}/cobertura.json" 2>&1 | head -c 200)"
import json, re, sys
ps = [json.loads(l)['ruta'] for l in open(sys.argv[1]) if '"PUT"' in l]
v = r'/corridas/maq-a/registros/v\d{8}T\d{9}Z/'
assert [re.sub(v, '/R/', p) for p in ps[:3]] == ['/R/bypass.log.gz', '/R/gates.log.gz', '/R/cobertura.json'], ps[:4]
assert len({re.match(v, p).group(0) for p in ps[:3]}) == 1, ps[:3]
c = json.load(open(sys.argv[2]))
assert c['esquema'] == 1 and c['fecha'] == '2026-09-15' and c['fuentes']['gates']['estado'] == 'medido' and c['fuentes']['bypass']['estado'] == 'medido', c
PY
echo 0 > "${T}/b/demora"; subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a"
echo '{"ts":"2026-09-15T08:00:00Z","name":"build","status":"blocked"}' >> "${T}/reg/gates.log"
: > "${T}/b/pedidos.jsonl"
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a"
[ "${RC}" -eq 0 ] && ! grep -q '/registros/' "${T}/b/pedidos.jsonl" && ok "2.5-T1 otra pasada el mismo día no sube registros aunque el de frenos haya crecido" || mal "2.5-T1 re-subió el mismo día: rc=${RC} $(grep registros "${T}/b/pedidos.jsonl" | head -2)"
cp -R "${R}" "${T}/juego-viejo"
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-16 "maq-a"
R2="$(regdir "${T}")"
# story 2.24 (hoy-2.5-T1): al día siguiente, otra versión con lo que creció; la de ayer queda igual
[ "${R2}" != "${R}" ] && gunzip -c "${R2}/gates.log.gz" 2>/dev/null | cmp -s - "${T}/reg/gates.log" && grep -q '"fecha": *"2026-09-16"' "${R2}/cobertura.json" && diff -r "${T}/juego-viejo" "${R}" >/dev/null \
  && ok "2.5-T1 al día siguiente vuelven a subir, con lo que creció, bajo otra versión (la de ayer, igual)" || mal "2.5-T1 el día siguiente no re-subió bajo otra versión: rc=${RC} ${R} → ${R2} $(cat "${R2}/cobertura.json" 2>&1 | head -c 200)"
MAQ_A="${T}/b/blobs/corridas/maq-a"
! ls "${MAQ_A}/registros" | grep -v '^v' >/dev/null && ok "2.5-T1 nunca más a registros/<archivo> plano" || mal "2.5-T1 algo subió plano: $(ls "${MAQ_A}/registros")"

# ── 2.6 T10 · el TERCER registro (la constancia de los frenos) viaja por el mismo camino (story 2.6, AC7) ──
# 🔴 rojo previo: dejar `frenos.jsonl` fuera de la lista de registros → el reductor se NIEGA a contarlo
#    (su guarda exige que todo lo que cuenta esté entre lo que se sube), y la constancia no sale de la máquina.
T="${BASE}/t10-26"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
cat > "${T}/reg/frenos.jsonl" <<'JSONL'
{"ts":"2026-09-14T12:00:00Z","freno":"safety-guard","regla":"GIT-C1","veredicto":"bloqueo","sha256":"aa"}
{"ts":"2026-09-14T12:01:00Z","freno":"test-scope-guard","regla":"suite-completa","veredicto":"escape","sha256":"bb"}
JSONL
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a"
R="$(regdir "${T}")"
gunzip -c "${R}/frenos.jsonl.gz" 2>/dev/null | cmp -s - "${T}/reg/frenos.jsonl" \
  && ok "2.6-T10 la constancia de los frenos sube comprimida y descomprime idéntica" || mal "2.6-T10 no subió o difiere: $(ls "${R}" 2>&1)"
python3 - "${T}/b/pedidos.jsonl" "${R}/cobertura.json" <<'PY2' && ok "2.6-T10 los TRES registros van antes que las corridas, la cobertura última, y declara las tres fuentes medidas" || mal "2.6-T10 orden/cobertura: $(head -5 "${T}/b/pedidos.jsonl" | cut -c1-110) $(cat "${R}/cobertura.json" 2>&1 | head -c 250)"
import json, sys
import re
ps = [re.sub(r'/registros/v\d{8}T\d{9}Z/', '/registros/', json.loads(l)['ruta']) for l in open(sys.argv[1]) if '"PUT"' in l]
assert ps[:4] == ['/corridas/maq-a/registros/bypass.log.gz', '/corridas/maq-a/registros/frenos.jsonl.gz',
                  '/corridas/maq-a/registros/gates.log.gz', '/corridas/maq-a/registros/cobertura.json'], ps[:5]
c = json.load(open(sys.argv[2]))
assert c['fuentes']['frenos']['estado'] == 'medido', c
PY2

# ── 2.6 T10b · sin constancia todavía (una máquina que no actualizó el arnés) se DECLARA, no se inventa un vacío ──
# 🔴 rojo previo: subir un .gz vacío → el reductor lo lee como «este freno nunca frenó».
T="${BASE}/t10b-26"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a"
R="$(regdir "${T}")"
[ ! -f "${R}/frenos.jsonl.gz" ] && python3 -c "
import json,sys
c=json.load(open(sys.argv[1]))
assert c['fuentes']['frenos']['estado']=='no_medido', c
assert 'motivo' in c['fuentes']['frenos'] and '/' not in c['fuentes']['frenos']['motivo'], c
" "${R}/cobertura.json" 2>/dev/null \
  && ok "2.6-T10b sin frenos.jsonl la cobertura lo declara no_medido con motivo y sin rutas, y no sube un vacío" || mal "2.6-T10b $(cat "${R}/cobertura.json" 2>&1 | head -c 250)"

# ── 2.7 T12 · el carril de cada commit viaja como un registro más (story 2.7, AC12) ──────────────
# 🔴 rojo previo: dejar `carriles.jsonl` fuera de la lista de registros → no sale de la máquina, y el
#    reductor se NIEGA a contarlo (su guarda exige que lo que cuenta esté entre lo que se sube).
T="${BASE}/t12-27"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
cat > "${T}/reg/carriles.jsonl" <<'JSONL'
{"ts":"2026-09-14T12:00:00Z","carril":"pipeline","story":"2.7"}
{"ts":"2026-09-14T12:05:00Z","carril":"adhoc","story":null}
JSONL
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a"
R="$(regdir "${T}")"
gunzip -c "${R}/carriles.jsonl.gz" 2>/dev/null | cmp -s - "${T}/reg/carriles.jsonl" \
  && ok "2.7-T12 carriles.jsonl sube comprimido y descomprime idéntico" || mal "2.7-T12 no subió o difiere: $(ls "${R}" 2>&1)"
python3 -c "
import json,sys
c=json.load(open(sys.argv[1]))
assert c['fuentes']['carriles']['estado']=='medido', c
" "${R}/cobertura.json" 2>/dev/null && ok "2.7-T12 la cobertura declara la fuente «carriles» (el nombre que busca el reductor)" || mal "2.7-T12 cobertura: $(cat "${R}/cobertura.json" 2>&1 | head -c 250)"

# ── 2.5 T2 · un registro ausente se declara, no se sube vacío; nada más sube de la carpeta (story 2.5, AC2, AC3) ──
# 🔴 rojo previo: tratar el ausente como vacío → sube un .gz vacío que se lee como «0 escapes»; o dejar el .gz de
#    ayer en la preparación → la subida vuelve a mandar números viejos.
T="${BASE}/t2-25"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"; rm "${T}/reg/bypass.log"
mkdir -p "${T}/reg/lane" "${T}/reg/advisor-runs"; echo '{"recentPrompts":["secreto"]}' > "${T}/reg/lane/s.json"; echo '{}' > "${T}/reg/advisor-runs/s.jsonl"; echo "x" > "${T}/reg/safety-guard.log"
mkdir -p "${T}/estado/registros-buzon"; echo "viejo" | gzip -c > "${T}/estado/registros-buzon/bypass.log.gz"; echo '{"esquema":1,"fecha":"2026-09-14","fuentes":{}}' > "${T}/estado/registros-buzon/cobertura.json"
subir_reg "${T}" "${T}/no-existe" "${T}/reg" 2026-09-15 "maq-a"
R="$(regdir "${T}")"
[ "${RC}" -eq 0 ] && [ -f "${R}/gates.log.gz" ] && [ ! -e "${R}/bypass.log.gz" ] && [ ! -e "${T}/estado/registros-buzon/bypass.log.gz" ] \
  && ok "2.5-T2 sin bypass.log (y sin corridas): sube el de frenos y la cobertura, no sube un vacío y borra el .gz de ayer de la preparación" || mal "2.5-T2 rc=${RC} buzón: $(ls "${R}" 2>&1) prep: $(ls "${T}/estado/registros-buzon" 2>&1)"
python3 -c "import json,sys; c=json.load(open(sys.argv[1])); b=c['fuentes']['bypass']; assert b['estado']=='no_medido' and b['motivo'] and sys.argv[2] not in b['motivo'], c" "${R}/cobertura.json" "${T}" 2>/dev/null \
  && ok "2.5-T2 la cobertura declara bypass no_medido con motivo, sin la ruta de la máquina" || mal "2.5-T2 cobertura: $(cat "${R}/cobertura.json" 2>&1 | head -c 300)"
grep -Eq 'lane|advisor-runs|safety-guard|secreto' "${T}/b/pedidos.jsonl" && mal "2.5-T2 subió algo más que los registros: $(grep -E 'lane|advisor-runs|safety' "${T}/b/pedidos.jsonl" | head -2)" || ok "2.5-T2 de la carpeta del pipeline sólo suben los dos registros"
# 2.5 T1b · si un registro rebota con un 4xx que no es de la llave, la cobertura NO sube (quedaría declarando
# medido un registro viejo). 🔴 rojo previo: `continue` y seguir con la cola → sube la cobertura igual.
T="${BASE}/t1b-25"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"; echo "gates.log.gz" > "${T}/b/rechazar"
subir_reg "${T}" "${T}/no-existe" "${T}/reg" 2026-09-15 "maq-a"
R="$(regdir "${T}")"
[ "${RC}" -eq 1 ] && [ -f "${R}/bypass.log.gz" ] && [ ! -e "${R}/cobertura.json" ] \
  && ok "2.5-T1b gates.log.gz rebota (409) → la cobertura queda retenida, sale 1 (parcial) y el otro registro sube" || mal "2.5-T1b rc=${RC} buzón: $(ls "${R}" 2>&1) $(head -c 200 "${T}/err.txt")"
# story 2.24 (hoy-2.5-T1b, AC 10): un «ya existe» en el juego invalida la preparación y saca sus claves del registro local
python3 - "${T}/estado/registros-buzon/cobertura.json" "${T}/estado/mailbox-uploads.json" <<'PY' && ok "2.5-T1b la preparación queda invalidada (sin «preparado») y el registro local sin las claves de ese juego" || mal "2.5-T1b preparación: $(head -c 300 "${T}/estado/registros-buzon/cobertura.json" 2>&1)"
import json, sys
c = json.load(open(sys.argv[1]))
assert 'preparado' not in c and c.get('invalidado'), c
r = json.load(open(sys.argv[2]))
assert not [k for k in r['archivos'] if '/registros/' in k], r['archivos'].keys()
PY
rm -f "${T}/b/rechazar"
subir_reg "${T}" "${T}/no-existe" "${T}/reg" 2026-09-15 "maq-a"
R2="$(regdir "${T}")"
[ "${RC}" -eq 0 ] && [ "${R2}" != "${R}" ] && [ -f "${R2}/gates.log.gz" ] && [ -f "${R2}/bypass.log.gz" ] && [ -f "${R2}/cobertura.json" ] \
  && ok "2.5-T1b la pasada siguiente, el mismo día, re-prepara el juego y lo sube entero bajo otra versión" || mal "2.5-T1b re-preparación: rc=${RC} ${R} → ${R2}: $(ls "${R2}" 2>&1 | tr '\n' ' ')"
# 2.5 T2c · sin corridas, un fallo al preparar los registros no sale 0 «sin corridas».
# 🔴 rojo previo: el return temprano no mira el error anotado.
T="${BASE}/t2c-25"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"; echo x > "${T}/archivo"
TYCON_LOGS_SOURCE="${T}/reg" TYCON_LOGS_DIR="${T}/archivo/sub" TYCON_TODAY=2026-09-15 subir "${T}" "${T}/no-existe" "maq-a"
[ "${RC}" -eq 1 ] && grep -q 'registros' "${T}/err.txt" && ok "2.5-T2c no se pudo preparar la carpeta de registros (y no hay corridas) → sale 1 y lo dice" || mal "2.5-T2c rc=${RC} $(head -c 200 "${T}/err.txt")"
# 2.5 T2d · la carpeta del pipeline que existe pero no se puede mirar NO es «no participa».
# 🔴 rojo previo: el catch del stat que devuelve «sin carpeta» ante cualquier error → la máquina deja de subir
#    registros para siempre, en silencio.
T="${BASE}/t2d-25"; buzon "${T}/b"; config "${T}/cfg.json"; echo x > "${T}/archivo"; corrida "${T}/h" "9.2-2026-09-09T0900"
TYCON_LOGS_SOURCE="${T}/archivo/sub" TYCON_LOGS_DIR="${T}/estado/registros-buzon" TYCON_TODAY=2026-09-15 subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 1 ] && grep -q 'registros' "${T}/err.txt" && ok "2.5-T2d la carpeta del pipeline no se puede mirar (ENOTDIR) → sale 1 y lo dice (las corridas igual suben)" || mal "2.5-T2d rc=${RC} $(head -c 200 "${T}/err.txt")"
TYCON_LOGS_SOURCE="${T}/archivo" TYCON_LOGS_DIR="${T}/estado2/registros-buzon" TYCON_TODAY=2026-09-15 subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 1 ] && grep -q 'registros' "${T}/err.txt" && ok "2.5-T2d la «carpeta» del pipeline es un archivo → sale 1 y lo dice" || mal "2.5-T2d archivo: rc=${RC} $(head -c 200 "${T}/err.txt")"
# 2.5 T2e · una cobertura de la preparación que no se puede leer no cuenta como «ya preparado hoy»: se rehace.
# 🔴 rojo previo: tratar la cobertura ilegible como ya preparada → los registros no vuelven a subir nunca.
T="${BASE}/t2e-25"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
mkdir -p "${T}/estado/registros-buzon"; echo '{ roto "fecha": "2026-09-15"' > "${T}/estado/registros-buzon/cobertura.json"
subir_reg "${T}" "${T}/no-existe" "${T}/reg" 2026-09-15 "maq-a"
R="$(regdir "${T}")"
[ "${RC}" -eq 0 ] && [ -f "${R}/gates.log.gz" ] && python3 -c "import json,sys; c=json.load(open(sys.argv[1])); assert c['fecha']=='2026-09-15'" "${R}/cobertura.json" 2>/dev/null \
  && ok "2.5-T2e cobertura de la preparación ilegible → se rehace y suben los registros con una cobertura válida" || mal "2.5-T2e rc=${RC} buzón: $(ls "${R}" 2>&1)"
T="${BASE}/t2b-25"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "9.1-2026-09-09T0900"
subir_reg "${T}" "${T}/h" "${T}/no-hay-carpeta" 2026-09-15 "maq-a"
[ "${RC}" -eq 0 ] && [ "$(puts "${T}/b")" = "2" ] && ! grep -q registros "${T}/b/pedidos.jsonl" \
  && ok "2.5-T2 una máquina sin carpeta del pipeline no sube registros ni cobertura (sólo sus corridas)" || mal "2.5-T2 sin carpeta: rc=${RC} puts=$(puts "${T}/b")"

# ── T18 (parte subida) · sin rastro de git ni del repo privado (AC17) ───────────────────────────
# 🔴 rojo previo: dejar el camino de git vivo «por las dudas» → dos vehículos para lo mismo.
T="${BASE}/t18"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "8.1-2026-09-08T0400"
mkdir -p "${T}/bin"; printf '#!/bin/sh\necho "$@" >> "%s/git.log"\nexit 0\n' "${T}" > "${T}/bin/git"; chmod +x "${T}/bin/git"
PATH="${T}/bin:${PATH}" subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 0 ] && [ ! -s "${T}/git.log" ] && ok "T18 una subida completa no invoca git" || mal "T18 rc=${RC}, git invocado: $(cat "${T}/git.log" 2>/dev/null | head -3)"
grep -q "corridas\.json\|corridas-remoto\|spawnSync('git'" "${SUBIR}" && mal "T18 el script todavía nombra corridas.json / el clon / git" || ok "T18 el script no nombra corridas.json, el clon ni git"

# ── 2.9 · los hallazgos viajan como un registro más, con UNA sola cobertura ──────────────────────
# 🔴 rojo previo: en una carpeta hermana `<maquina>/hallazgos/` con cobertura propia, el reductor
#    tendría DOS coberturas por máquina; `coberturaValida()` arma una sola iterando las fuentes que
#    conoce, así que la fuente nueva quedaría `no_medido` para TODAS las máquinas, en verde y para
#    siempre. Por eso `hallazgos.jsonl` entra a REGISTROS y no a una carpeta propia.
T="${BASE}/t29"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
cat > "${T}/reg/hallazgos.jsonl" <<'JSONL'
{"ts":"2026-09-14T10:00:00Z","corrida":"c-000000000001","regla":"SEC-C1","dueno":"tycon-plugin-security-basics","severidad":"CRITICAL","disposicion":"fixed"}
{"ts":"2026-09-14T10:05:00Z","corrida":"c-000000000001","regla":"SILENT-C2","dueno":"tycon-silent-failure-hunter","severidad":"WARNING","disposicion":"open"}
JSONL
sello_hallazgos() {  # <carpeta> <fecha> [hallazgos] — el sello que deja el recolector cuando midió
  # (el número de hallazgos TIENE que coincidir con la serie: si no, la serie no está medida)
  printf '{"estado":"recolectado","fecha":"%s","repos":3,"run_dirs":5,"hallazgos":%s,"fuera_de_catalogo":1,"baldes":{"con_hallazgos":1,"sin_nada":4},"volcados":{"leidos":0,"medidos":0},"motivo_crudo":"/Users/fulana/x"}\n' "$2" "${3:-2}" > "$1/findings-seal.json"
}
sello_hallazgos "${T}/reg" 2026-09-15
for i in $(seq 1 20); do corrida "${T}/h" "2.${i}-2026-09-01T1000" 4000; done
echo 150 > "${T}/b/demora"
# 🔴 El presupuesto sube de 400 a 700 ms porque ahora son CUATRO pedidos de registro (3 .gz + la
#    cobertura) a 150 ms cada uno, no tres. Con 400 quedaban afuera la cobertura y el orden — que es
#    el comportamiento correcto (la cobertura se retiene si su registro no subió), pero no es lo que
#    este caso mide. El presupuesto REAL por defecto es de 90 s: tres registros entran de sobra.
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a" --budget-ms 700
R="$(regdir "${T}")"
gunzip -c "${R}/hallazgos.jsonl.gz" 2>/dev/null | cmp -s - "${T}/reg/hallazgos.jsonl" \
  && ok "2.9 los hallazgos subieron en <maq>/registros/ y descomprimen idénticos" \
  || mal "2.9 hallazgos.jsonl.gz ausente o distinto (rc=${RC}): $(ls "${R}" 2>&1)"
[ ! -d "${T}/b/blobs/corridas/maq-a/hallazgos" ] \
  && ok "2.9 NO se creó una carpeta hermana <maq>/hallazgos/" \
  || mal "2.9 apareció una carpeta hermana — rojo previo: dos coberturas por máquina dejan la fuente nueva no medida para todos"
python3 - "${R}/cobertura.json" "${SUBIR}" <<'COB' && ok "2.9 UNA sola cobertura, que declara TODOS los registros (hallazgos entre ellos)" || mal "2.9 cobertura: $(head -c 300 "${R}/cobertura.json" 2>&1)"
import json, subprocess, sys
c = json.load(open(sys.argv[1]))
f = c.get('fuentes') or {}
# Las fuentes son las de REGISTROS sin su extensión: se leen de la subida, no se copian acá (una sola lista).
registros = json.loads(subprocess.run(
    ["node", "-e", "console.log(JSON.stringify(require(process.argv[1]).REGISTROS))", sys.argv[2]],
    capture_output=True, text=True, check=True).stdout)
esperadas = {r.rsplit(".", 1)[0] for r in registros}
assert set(f.keys()) == esperadas, f"fuentes={sorted(f.keys())} esperadas={sorted(esperadas)}"
# los tres que el caso sembró están medidos; los registros de otras stories que este caso no crea se
# declaran «no medido» con motivo, que es justamente el contrato (nunca desaparecen de la cobertura).
assert all(f[k].get("estado") == "medido" for k in ("gates", "bypass", "hallazgos")), f
COB
python3 - "${T}/b/pedidos.jsonl" <<'ORD' && ok "2.9 los tres registros van primero y la cobertura al final de los tres" || mal "2.9 orden: $(grep '"PUT"' "${T}/b/pedidos.jsonl" | head -5 | cut -c1-140)"
import json, sys
ps = [json.loads(l)['ruta'] for l in open(sys.argv[1]) if '"PUT"' in l]
regs = [p for p in ps if '/registros/' in p]
assert len(regs) == 4, f'{len(regs)} pedidos de registros, esperaba 4 (3 .gz + cobertura)'
assert ps[:4] == regs, 'los registros no son los primeros cuatro PUT'
assert regs[-1].endswith('cobertura.json'), f'la cobertura no va ultima: {regs}'
ORD
# el archivo de hallazgos ausente: se declara no_medido y NO se sube un .gz vacío
T="${BASE}/t29b"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a"
R="$(regdir "${T}")"
[ ! -f "${R}/hallazgos.jsonl.gz" ] && ok "2.9 sin el archivo no se sube un .gz vacío" \
  || mal "2.9 subió un hallazgos.jsonl.gz sin archivo — rojo previo: un .gz vacío se lee como «0 hallazgos»"
python3 - "${R}/cobertura.json" <<'AUS' && ok "2.9 y la cobertura lo declara no_medido con motivo" || mal "2.9 cobertura sin declarar la fuente: $(head -c 300 "${R}/cobertura.json" 2>&1)"
import json, sys
f = json.load(open(sys.argv[1]))['fuentes']
assert f['hallazgos']['estado'] == 'no_medido', f['hallazgos']
assert f['hallazgos'].get('motivo'), 'sin motivo'
AUS

# ── 2.9 vuelta 2 · la serie se declara medida con LA MISMA regla que usa el cruce ────────────────
# 🔴 rojo previo (cazador de fallos silenciosos): un hallazgos.jsonl vacío o congelado —el recolector
#    apagado— se declaraba «medido» todos los días y el cruce lo sumaba como si fuera de hoy.
T="${BASE}/t29c"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
printf '{"ts":"2026-04-01T10:00:00Z","corrida":"c-000000000001","regla":"SEC-C1","dueno":"x","severidad":"WARNING","disposicion":"fixed"}\n' > "${T}/reg/hallazgos.jsonl"
sello_hallazgos "${T}/reg" 2026-04-01 1        # un sello de abril: el recolector dejó de correr
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a"
R="$(regdir "${T}")"
python3 - "${R}/cobertura.json" <<'VIEJA' && ok "2.9 una serie de hace meses se declara no_medido, con el motivo" || mal "2.9 serie vieja: $(head -c 300 "${R}/cobertura.json" 2>&1)"
import json, sys
f = json.load(open(sys.argv[1]))['fuentes']['hallazgos']
assert f['estado'] == 'no_medido', f
assert 'dej' in f.get('motivo', ''), f
VIEJA
[ ! -f "${R}/hallazgos.jsonl.gz" ] && ok "2.9 y no sube el .gz de esa serie vieja" || mal "2.9 subió el .gz de una serie no medida"
T="${BASE}/t29d"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
: > "${T}/reg/hallazgos.jsonl"                  # archivo vacío y SIN sello
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a"
python3 - "$(regdir "${T}")/cobertura.json" <<'VACIA' && ok "2.9 un archivo vacío sin sello no es «0 hallazgos medidos»" || mal "2.9 archivo vacío sin sello declarado medido"
import json, sys
assert json.load(open(sys.argv[1]))['fuentes']['hallazgos']['estado'] == 'no_medido'
VACIA
# la cobertura de una serie medida lleva sus conteos (números, nunca nombres), para que viajen
T="${BASE}/t29e"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
printf '{"ts":"2026-09-14T10:00:00Z","corrida":"c-000000000001","regla":"SEC-C1","dueno":"x","severidad":"WARNING","disposicion":"fixed"}\n' > "${T}/reg/hallazgos.jsonl"
sello_hallazgos "${T}/reg" 2026-09-15 1
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a"
python3 - "$(regdir "${T}")/cobertura.json" <<'RES' && ok "2.9 la cobertura lleva los conteos del recolector (sólo números)" || mal "2.9 conteos: $(head -c 300 "$(regdir "${T}")/cobertura.json")"
import json, sys
f = json.load(open(sys.argv[1]))['fuentes']['hallazgos']
r = f['resumen']
assert r['repos'] == 3 and r['fuera_de_catalogo'] == 1 and r['baldes']['sin_nada'] == 4, r
assert 'motivo_crudo' not in r and 'fulana' not in json.dumps(r), r
assert f.get('fecha') == '2026-09-15', f   # la fecha del SELLO viaja: la del archivo es la de la preparación
def solo_numeros(x):
    if isinstance(x, dict): return all(solo_numeros(v) for v in x.values())
    return isinstance(x, (int, float)) and not isinstance(x, bool)
assert solo_numeros(r), r
RES
# el .gz que se preparó ayer con la serie medida se SACA el día que la serie deja de estarlo
# 🔴 rojo previo: sin el borrado, el .gz de ayer quedaba en la preparación y volvía a subir como de hoy.
T="${BASE}/t29f"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
printf '{"ts":"2026-09-14T10:00:00Z","corrida":"c-000000000001","regla":"SEC-C1","dueno":"x","severidad":"WARNING","disposicion":"fixed"}\n' > "${T}/reg/hallazgos.jsonl"
sello_hallazgos "${T}/reg" 2026-09-15 1
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a"
P="${T}/estado/registros-buzon/hallazgos.jsonl.gz"
if [ ! -f "${P}" ]; then
  mal "2.9 el día medido no dejó el .gz preparado (el caso no puede mirar el día siguiente)"
else
  subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-20 "maq-a"   # cinco días después, sin recolectar
  [ ! -f "${P}" ] && ok "2.9 el día que la serie deja de estar medida, el .gz de ayer sale de la preparación" \
    || mal "2.9 el .gz de una serie medida hace cinco días sigue preparado para subir"
fi
# una serie que no coincide con su sello (a medio escribir) no se declara medida
# 🔴 rojo previo: con el sello de 2 hallazgos y la serie vacía, la cobertura decía «medido» y el cruce contaba 0.
T="${BASE}/t29g"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
: > "${T}/reg/hallazgos.jsonl"
sello_hallazgos "${T}/reg" 2026-09-15 2
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-09-15 "maq-a"
python3 - "$(regdir "${T}")/cobertura.json" <<'DESC' && ok "2.9 una serie que no coincide con su sello se declara no medida" || mal "2.9 serie vacía con sello de 2: $(head -c 300 "$(regdir "${T}")/cobertura.json")"
import json, sys
f = json.load(open(sys.argv[1]))['fuentes']['hallazgos']
assert f['estado'] == 'no_medido' and 'coincide' in f['motivo'], f
DESC
# una falla de lectura de hallazgos.jsonl.gz ANTES de la cola retiene la cobertura; una de una corrida, NO
# 🔴 rojo previo (pase adversarial): la guarda reconocía sólo «.log.gz », y ampliarla a «.jsonl.gz » a
#    secas la habría disparado también por un hilo de corrida (`*.hilo.jsonl.gz`).
node - "${SUBIR}" <<'GUARDA' && ok "2.9 la guarda reconoce los tres registros por su NOMBRE, y no se dispara por un hilo de corrida" || mal "2.9 la guarda de registros no distingue un registro de un hilo"
const s = require('fs').readFileSync(process.argv[2], 'utf8');
const m = /const esFallaDeRegistro = \(x\) => ([^\n]+);/.exec(s);
if (!m) { console.error('no encontré esFallaDeRegistro'); process.exit(1); }
const { REGISTROS } = require(process.argv[2]);
const esFallaDeRegistro = eval(`(x) => ${m[1]}`);
const casos = [
  ['hallazgos.jsonl.gz (EACCES)', true], ['gates.log.gz (EACCES)', true], ['bypass.log.gz (EISDIR)', true],
  ['registros de frenos y escapes (EACCES)', true],
  ['2.9-2026-09-16T0101.hilo.jsonl.gz (EACCES)', false], ['2.9-2026-09-16T0101.json (EACCES)', false],
];
for (const [x, esperado] of casos) if (esFallaDeRegistro(x) !== esperado) { console.error(x, '→', !esperado); process.exit(1); }
GUARDA
# ── 2.19 T13 · el cambio de git de cada corrida viaja con el volcado y su hilo (story 2.19, AC13) ──
# 🔴 rojo previo: FORMA_ARCHIVO sólo acepta .json y .hilo.jsonl.gz → el .cambio.json.gz no sube nunca.
#    Mutación: sacar `cambio\.json\.gz` de FORMA_ARCHIVO → rojo acá y en download-runs.test.sh, que la importa.
T="${BASE}/t219"; buzon "${T}/b"; config "${T}/cfg.json"
corrida "${T}/h" "2.19-2026-09-17T1300" 1000
head -c 3000 /dev/urandom | gzip -c > "${T}/h/2.19-2026-09-17T1300.cambio.json.gz"
printf 'x' > "${T}/h/2.19-2026-09-17T1300.cambio.json.gz.123.tmp"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 0 ] && cmp -s "${T}/h/2.19-2026-09-17T1300.cambio.json.gz" "${T}/b/blobs/corridas/maq-a/2.19-2026-09-17T1300.cambio.json.gz" && [ "$(campo "${T}" subidos)" = "3" ] \
  && ok "2.19-T13 el .cambio.json.gz sube como <maquina>/<archivo>, idéntico, junto al volcado y su hilo (3; el .tmp a medio escribir no)" \
  || mal "2.19-T13 rc=${RC} subidos=$(campo "${T}" subidos) buzón: $(ls "${T}/b/blobs/corridas/maq-a" 2>&1)"


# ── 2.12-T13 · SubirEnAgenteDeCi_NoSube (story 2.12) · un agente de CI no es una máquina del equipo: no sube al buzón real (AC 13) ──
# 🔴 rojo previo: sin la guarda, el banco nocturno (TF_BUILD=True) sube los registros del agente como si fuera una
#    máquina — así apareció `runnervmg34hb/` en el buzón el 2026-09-17. El caso apunta a una cuenta que NO existe y
#    no pasa TYCON_MAILBOX_URL_BASE: aunque la guarda falte, nada sale de esta máquina (lección de la 2.16).
T="${BASE}/t13"; mkdir -p "${T}/estado"
printf '{"cuenta":"tyconnoexiste0000","contenedor":"corridas","tenant":"00000000-0000-0000-0000-000000000000","politica":"subida-prueba","vence":"2099-01-01","sas":"sv=2022-11-02&si=subida-prueba&sr=c&spr=https&sig=%s"}\n' "${FAKE_SIGNATURE}" > "${T}/cfg.json"
corrida "${T}/h" "2.1-2026-09-01T1000" 1000
mkdir -p "${HOME}/.claude/.tycon-pipeline"
echo '{"ts":"2026-09-16T10:00:00Z","name":"tests","status":"green"}' > "${HOME}/.claude/.tycon-pipeline/gates.log"
env -u TYCON_MAILBOX_URL_BASE TF_BUILD=True TYCON_MAILBOX_JSON="${T}/cfg.json" TYCON_TIMING_HISTORY="${T}/h" \
  TYCON_UPLOADS_LOG="${T}/estado/mailbox-uploads.json" TYCON_LOGS_DIR="${T}/registros-buzon" TYCON_MACHINE=runnervm-de-prueba \
  node "${SUBIR}" --json > "${T}/out.json" 2> "${T}/err.txt"; RC=$?
if [ "${RC}" -eq 0 ] && [ "$(campo "${T}" estado)" = "agente_ci" ] && [ -n "$(campo "${T}" motivo)" ] \
   && [ ! -e "${T}/registros-buzon" ] && [ ! -e "${T}/estado/mailbox-uploads.json" ] && [ "$(campo "${T}" subidos)" = "0" ]; then
  ok "2.12-T13 SubirEnAgenteDeCi_NoSube: con TF_BUILD=True y el destino real: exit 0, estado agente_ci con motivo, nada preparado ni subido"
else
  mal "2.12-T13 SubirEnAgenteDeCi_NoSube rc=${RC} estado=$(campo "${T}" estado) subidos=$(campo "${T}" subidos) · preparado: $(ls "${T}/registros-buzon" 2>&1 | head -2) · $(head -c 200 "${T}/err.txt")"
fi
rm -rf "${HOME}/.claude"
# control: con un destino de prueba la guarda no aplica — las suites del banco siguen probando la subida
T="${BASE}/t13b"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "2.1-2026-09-01T1000" 1000
TF_BUILD=True TYCON_MAILBOX_JSON="${T}/cfg.json" TYCON_MAILBOX_URL_BASE="${URL_BUZON}" TYCON_TIMING_HISTORY="${T}/h" \
  TYCON_UPLOADS_LOG="${T}/estado/mailbox-uploads.json" TYCON_MACHINE="maquina-de-prueba" \
  node "${SUBIR}" --json > "${T}/out.json" 2> "${T}/err.txt"; RC=$?
[ "${RC}" -eq 0 ] && [ "$(puts "${T}/b")" -gt 0 ] && [ "$(campo "${T}" estado)" != "agente_ci" ] \
  && ok "2.12-T13 con TF_BUILD=True y un destino de prueba, sube (la guarda sólo protege el buzón real)" \
  || mal "2.12-T13 control: rc=${RC} puts=$(puts "${T}/b") estado=$(campo "${T}" estado)"

# ── 8.9-D2 · el registro de subidas y el sello de vencimiento con su nombre en inglés; el viejo sigue valiendo ──
# 🔴 rojo previo: renombrar el registro sin leer el viejo vuelve a subir TODO el historial de la máquina el día del
#    cambio, y renombrar el sello sin leer el viejo repite el aviso de vencimiento. El nombre viejo sale del mapa.
[ -f "${BASE}/t6/estado/upload-runs-expiry.seal" ] \
  && ok "8.9-D2 con TYCON_UPLOADS_LOG, el sello de vencimiento (upload-runs-expiry.seal) va a la carpeta del registro" \
  || mal "8.9-D2 sello de vencimiento junto al registro: $(ls "${BASE}/t6/estado" 2>&1 | tr '\n' ' ')"
viejo_d2() {  # <nombre nuevo> → el nombre viejo, según scripts/lib/renames.json
  node -e '
    const m = require(process.argv[1]);
    const e = m.entries.find((x) => x.batch === "D2" && x.kind === "state-file" && x.new.split("/").pop() === process.argv[2]);
    process.stdout.write(e ? e.old.split("/").pop() : "");
  ' "${RAIZ}/scripts/lib/renames.json" "$1"
}
subir_casa() {  # <caso> <origen> <maquina> — como subir, pero con el registro por defecto (la HOME de juguete)
  local c="$1" ori="$2" maq="$3"; shift 3
  TYCON_MAILBOX_JSON="${c}/cfg.json" TYCON_MAILBOX_URL_BASE="${URL_BUZON}" TYCON_TIMING_HISTORY="${ori}" TYCON_MACHINE="${maq}" \
    node "${SUBIR}" --json "$@" > "${c}/out.json" 2> "${c}/err.txt"
  RC=$?
}
puts_de() { if [ -f "$1/pedidos.jsonl" ]; then grep '"metodo":"PUT"' "$1/pedidos.jsonl" | grep -c "$2" || true; else echo 0; fi; }
CASA="${HOME}/.claude/.tycon-pipeline"
# en la copia pública el mapa no viaja: sin nombre viejo no hay migración que mirar (se saltea con motivo)
if [ ! -f "${RAIZ}/scripts/lib/renames.json" ]; then
  ok "8.9-D2 se saltea — copia pública, sin el mapa de renombres"
else
REG_VIEJO="$(viejo_d2 mailbox-uploads.json)"; SELLO_VIEJO="$(viejo_d2 upload-runs-expiry.seal)"
[ -n "${REG_VIEJO}" ] && [ -n "${SELLO_VIEJO}" ] || mal "8.9-D2 el mapa no tiene las entradas de la subida (registro=${REG_VIEJO} sello=${SELLO_VIEJO})"
T="${BASE}/t-d2"; buzon "${T}/b"; config "${T}/cfg.json" "$(en 20)"; corrida "${T}/h" "2.1-2026-09-01T1000" 1000
rm -rf "${HOME}/.claude"; mkdir -p "${CASA}"
subir_casa "${T}" "${T}/h" "maq-d2"
[ "${RC}" -eq 0 ] && [ -f "${CASA}/mailbox-uploads.json" ] && [ -f "${CASA}/upload-runs-expiry.seal" ] && [ ! -e "${CASA}/${REG_VIEJO}" ] && [ ! -e "${CASA}/${SELLO_VIEJO}" ] \
  && ok "8.9-D2 el registro y el sello se escriben como mailbox-uploads.json y upload-runs-expiry.seal" \
  || mal "8.9-D2 nombres nuevos: rc=${RC} · $(ls "${CASA}" 2>&1 | tr '\n' ' ')"
mv "${CASA}/mailbox-uploads.json" "${CASA}/${REG_VIEJO}"; mv "${CASA}/upload-runs-expiry.seal" "${CASA}/${SELLO_VIEJO}"
cp "${CASA}/${REG_VIEJO}" "${T}/registro-antes"; cp "${CASA}/${SELLO_VIEJO}" "${T}/sello-antes"
ANTES="$(puts_de "${T}/b" "2.1-2026-09-01T1000")"
subir_casa "${T}" "${T}/h" "maq-d2"
[ "${RC}" -eq 0 ] && [ "$(puts_de "${T}/b" "2.1-2026-09-01T1000")" = "${ANTES}" ] && [ "$(campo "${T}" aviso_vence)" = "ya_emitido_hoy" ] \
  && ok "8.9-D2 con sólo los viejos, no se vuelve a subir lo ya subido ni se repite el aviso de hoy" \
  || mal "8.9-D2 con los viejos: rc=${RC} puts antes=${ANTES} después=$(puts_de "${T}/b" "2.1-2026-09-01T1000") aviso=$(campo "${T}" aviso_vence)"
corrida "${T}/h" "2.2-2026-09-02T1000" 1000
subir_casa "${T}" "${T}/h" "maq-d2"
N="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(sum(1 for k in d['archivos'] if '2.1-2026-09-01T1000' in k or '2.2-2026-09-02T1000' in k))" "${CASA}/mailbox-uploads.json" 2>/dev/null)"
[ "${RC}" -eq 0 ] && [ "${N}" = "4" ] && cmp -s "${T}/registro-antes" "${CASA}/${REG_VIEJO}" && cmp -s "${T}/sello-antes" "${CASA}/${SELLO_VIEJO}" \
  && ok "8.9-D2 al escribir, el registro nuevo arranca con lo del viejo y los viejos quedan intactos" \
  || mal "8.9-D2 migración del registro: rc=${RC} corridas en el registro nuevo=${N} · $(ls "${CASA}" 2>&1 | tr '\n' ' ')"
rm -rf "${HOME}/.claude"
fi

# ── 8.9-E T56 · el registro de usos de nombres viejos viaja al buzón con los otros registros (story 8.9, AC 52) ──
# `legacy-names.jsonl` (AC 17: una línea por nombre viejo, script y día) es lo que decide el retiro de los nombres viejos
# —«14 días sin usos en el buzón»—, así que sube como un registro más: comprimido, una vez por día, con su cobertura.
# Sube sólo lo que el registro promete —día, tipo, nombre viejo, nombre nuevo, guion relativo al repo, conflicto—: una
# línea con un campo de más lo pierde, y una con una ruta de la máquina o un día sin forma no sube. La cobertura lleva sus
# conteos (números).
# 🔴 rojo previo: sin la entrada en REGISTROS el archivo se queda en la máquina y el buzón dice «0 usos» por ausencia.
T="${BASE}/t56"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
cat > "${T}/reg/legacy-names.jsonl" <<'JSONL'
{"day":"2026-10-01","kind":"env","old":"TYCON_NO_LAB_OLD","new":"TYCON_NO_LAB_NEW","script":"scripts/lab/tool.sh"}
{"day":"2026-10-02","kind":"file","old":"scripts/lab/old.js","new":"scripts/lab/new.js","script":"scripts/lab/old.js","conflict":true}
{"day":"2026-10-02","kind":"option","old":"lab-old","new":"lab-new","script":"scripts/lab/x.js","value":"secreto-lab-56"}
{"day":"2026-10-02","kind":"env","old":"TYCON_LAB_ROUTE","new":"TYCON_LAB_ROUTE_NEW","script":"/Users/fulana/lab/x.sh"}
{"day":"2026-13-45","kind":"env","old":"TYCON_LAB_DATE","new":"TYCON_LAB_DATE_NEW","script":"scripts/lab/y.sh"}
{"day":"2026-10-02","kind":"inventado","old":"a","new":"b","script":"scripts/lab/z.sh"}
esto no es json
JSONL
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-10-03 "maq-a" --dry-run
P56="${T}/estado/registros-buzon"
[ "${RC}" -eq 0 ] && [ -f "${P56}/legacy-names.jsonl.gz" ] && [ "$(num "${T}" a_subir)" -ge 4 ] \
  && ok "8.9-E T56 --dry-run: el registro de usos queda preparado para subir con los otros (no se manda nada)" \
  || mal "8.9-E T56 --dry-run: rc=${RC} a_subir=$(num "${T}" a_subir) preparado: $(ls "${P56}" 2>&1 | tr '\n' ' ')"
[ "$(puts "${T}/b")" = 0 ] && ok "8.9-E T56 --dry-run no hace ningún pedido al buzón" || mal "8.9-E T56 --dry-run mandó $(puts "${T}/b") PUT"
python3 - "${P56}/legacy-names.jsonl.gz" "${P56}/cobertura.json" <<'PY' && ok "8.9-E T56 sube sólo día, tipo, nombres y guion relativo: el campo de más se cae, la ruta de la máquina y el día imposible no suben; la cobertura lleva los conteos" || mal "8.9-E T56 contenido o cobertura del registro de usos"
import gzip, json, sys
texto = gzip.open(sys.argv[1]).read().decode()
assert "secreto-lab-56" not in texto and "fulana" not in texto and "2026-13-45" not in texto and "inventado" not in texto, texto
lineas = [json.loads(l) for l in texto.splitlines() if l.strip()]
assert len(lineas) == 3, lineas
for l in lineas:
    assert set(l) <= {"day", "kind", "old", "new", "script", "conflict"}, l
assert [l["old"] for l in lineas] == ["TYCON_NO_LAB_OLD", "scripts/lab/old.js", "lab-old"], lineas
assert lineas[1].get("conflict") is True
c = json.load(open(sys.argv[2]))["fuentes"]["legacy-names"]
assert c["estado"] == "medido", c
r = c["resumen"]
assert r == {"lines": 3, "names": 3, "dropped": 4}, r
PY
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-10-03 "maq-a"
R56="$(regdir "${T}")"
[ "${RC}" -eq 0 ] && cmp -s "${R56}/legacy-names.jsonl.gz" "${P56}/legacy-names.jsonl.gz" \
  && ok "8.9-E T56 el registro de usos llega al buzón como <maquina>/registros/legacy-names.jsonl.gz, igual al preparado" \
  || mal "8.9-E T56 no llegó al buzón (rc=${RC}): $(ls "${R56}" 2>&1 | tr '\n' ' ')"
node -e 'const { FORMA_REGISTRO } = require(process.argv[1]); process.exit(FORMA_REGISTRO.test("legacy-names.jsonl.gz") ? 0 : 1)' "${SUBIR}" \
  && ok "8.9-E T56 y la bajada lo reconoce (la forma de los registros se deriva de la misma lista)" || mal "8.9-E T56 la bajada no reconocería legacy-names.jsonl.gz"
# sin el archivo (una máquina que nunca usó un nombre viejo) se declara no_medido y no sube un .gz vacío
T="${BASE}/t56b"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
subir_reg "${T}" "${T}/h" "${T}/reg" 2026-10-03 "maq-a"
python3 - "$(regdir "${T}")" <<'PY' && ok "8.9-E T56 sin el registro de usos: no_medido con motivo y sin .gz" || mal "8.9-E T56 sin el archivo: $(ls "$(regdir "${T}")" 2>&1 | tr '\n' ' ')"
import json, os, sys
d = sys.argv[1]
assert not os.path.exists(os.path.join(d, "legacy-names.jsonl.gz"))
f = json.load(open(os.path.join(d, "cobertura.json")))["fuentes"]["legacy-names"]
assert f["estado"] == "no_medido" and f.get("motivo"), f
PY
# la fecha de retiro: la fija el commit de la tanda E en el mapa (45 días después del merge); acá sólo se lee
if [ ! -f "${RAIZ}/scripts/lib/renames.json" ]; then
  ok "8.9-E T56 (fecha de retiro) se saltea — copia pública, sin el mapa de renombres"
else
  RETIRO="$(node -e 'const v=require(process.argv[1]).retire_after; process.stdout.write(v===null||v===undefined?"":String(v))' "${RAIZ}/scripts/lib/renames.json")"
  if python3 -c 'import datetime,sys; datetime.date.fromisoformat(sys.argv[1])' "${RETIRO}" 2>/dev/null && [ "${#RETIRO}" = 10 ]; then
    ok "8.9-E T56 retire_after fijado en el mapa: ${RETIRO}"
  else mal "8.9-E T56 retire_after todavía no es una fecha (${RETIRO:-null}): lo fija el commit de la tanda E, 45 días después del merge (AC 52)"; fi
fi

# ── 8.19-B T29 · Mailbox_PlaceJson_CountsAndHashesOnly_NoMeasuredDeclared (story 8.19, tanda B · AC 21) ─────────────
# Una vez por día, con los demás registros, sube `place.json`: en qué nombre vive el arnés, si el nombre viejo existe,
# cuánto queda registrado por él (por archivo), el sha256 de la copia fija de arranque contra el del árbol, y si las
# skills salen de un clon aparte y de qué commit. Es la evidencia para retirar el nombre viejo (story 8.15). Sólo
# números, hashes y nombres de archivo: nunca una ruta con la carpeta de la persona. Un dato ilegible: `no_medido`.
# 🔴 rojo previo: sin esto el retiro se decidiría sin saber cuántas máquinas siguen registradas por el nombre viejo.
PN="$(node -p "require('${RAIZ}/scripts/setup/harness/place.js').PLACE_NAME")"
LN="$(node -p "require('${RAIZ}/scripts/setup/harness/place.js').LEGACY_PLACE_NAME")"
casa29() {  # <casa> <clon> — una máquina con el mecanismo: el lugar → el clon, el viejo → el lugar, un hook por el viejo
  local casa="$1" clon="$2"
  mkdir -p "${clon}/scripts/setup/harness" "${casa}/.claude/.tycon-pipeline/harness"
  : > "${clon}/scripts/install-tycon-hooks.sh"; echo '// copia fija de juguete' > "${clon}/scripts/setup/harness/bootstrap.js"
  cp "${clon}/scripts/setup/harness/bootstrap.js" "${casa}/.claude/.tycon-pipeline/harness/bootstrap.js"
  node -e 'const fs=require("fs");const [c,p,o]=process.argv.slice(1);const t=process.platform==="win32"?"junction":"dir";fs.symlinkSync(c,p,t);fs.symlinkSync(p,o,t)' "${clon}" "${casa}/.claude/${PN}" "${casa}/.claude/${LN}"
  printf '{"schema":1,"mode":"managed","tree":"%s","sources":[]}\n' "${clon}" > "${casa}/.claude/.tycon-pipeline/harness-state.json"
  printf '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node \\"$HOME/.claude/%s/scripts/hooks/x.js\\""}]}]}}\n' "${LN}" > "${casa}/.claude/settings.json"
}
T="${BASE}/t29"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"; casa29 "${T}/casa" "${T}/clon"
HOME="${T}/casa" USERPROFILE="${T}/casa" subir_reg "${T}" "${T}/h" "${T}/reg" 2026-10-05 "maq-a" --dry-run
P29="${T}/estado/registros-buzon/place.json"
[ "${RC}" -eq 0 ] && [ -f "${P29}" ] && ok "8.19-B T29 --dry-run: place.json queda preparado con los demás registros" || mal "8.19-B T29 sin place.json (rc=${RC}): $(ls "${T}/estado/registros-buzon" 2>&1 | tr '\n' ' ') $(head -3 "${T}/err.txt")"
python3 - "${P29}" "${PN}" "${T}" "${T}/out.json" <<'PY' && ok "8.19-B T29 dónde vive, el viejo, el conteo por archivo, la copia fija y las skills; el commit ilegible, no_medido; ninguna ruta de la máquina" || mal "8.19-B T29 el contenido de place.json: $(cat "${P29}" 2>&1 | head -c 600)"
import json, sys
f, pn, base, out = sys.argv[1:5]
texto = open(f, encoding="utf-8").read()
assert base not in texto and "/casa" not in texto and "clon" not in texto, texto
d = json.loads(texto)
assert d["place"] == {"name": pn, "kind": "link"}, d["place"]
assert d["legacy"] == {"exists": True, "kind": "link", "to_place": True}, d["legacy"]
r = d["registered_by_legacy"]
assert r["total"] == 1 and r["files"] == {"settings.json": {"count": 1, "permissions": 0}}, r
b = d["bootstrap"]
assert b["same"] is True and len(b["fixed_sha256"]) == 64 and b["fixed_sha256"] == b["tree_sha256"], b
s = d["skills"]
assert s["separate"] is False and s["commit"] == {"status": "no_medido", "reason": s["commit"]["reason"]} and s["commit"]["reason"], s
assert json.load(open(out))["place"]["place"]["name"] == pn, "upload-runs --json no trae place"
assert d["install"] == {"mode": "managed", "version": None, "team": None}, d["install"]
PY
HOME="${T}/casa" USERPROFILE="${T}/casa" subir_reg "${T}" "${T}/h" "${T}/reg" 2026-10-05 "maq-a"
[ "${RC}" -eq 0 ] && cmp -s "$(regdir "${T}")/place.json" "${P29}" && ok "8.19-B T29 place.json llega al buzón como <maquina>/registros/place.json" || mal "8.19-B T29 no llegó (rc=${RC}): $(ls "$(regdir "${T}")" 2>&1 | tr '\n' ' ')"
# la copia fija que no se puede leer: no_medido, no un hash vacío
T="${BASE}/t29b"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"; casa29 "${T}/casa" "${T}/clon"
rm -f "${T}/casa/.claude/.tycon-pipeline/harness/bootstrap.js"
HOME="${T}/casa" USERPROFILE="${T}/casa" subir_reg "${T}" "${T}/h" "${T}/reg" 2026-10-05 "maq-a" --dry-run
python3 - "${T}/estado/registros-buzon/place.json" <<'PY' && ok "8.19-B T29 la copia fija ilegible: bootstrap no_medido con motivo" || mal "8.19-B T29 sin copia fija: $(cat "${T}/estado/registros-buzon/place.json" 2>&1 | head -c 400)"
import json, sys
b = json.load(open(sys.argv[1]))["bootstrap"]
assert b.get("status") == "no_medido" and b.get("reason"), b
PY
# el viejo colgado con el lugar sano: `dangling` (no `link`) en la evidencia
T="${BASE}/t29d"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"; casa29 "${T}/casa" "${T}/clon"
node -e 'const fs=require("fs");const [o,x]=process.argv.slice(1);fs.unlinkSync(o);fs.symlinkSync(x,o,process.platform==="win32"?"junction":"dir")' "${T}/casa/.claude/${LN}" "${T}/borrado"
HOME="${T}/casa" USERPROFILE="${T}/casa" subir_reg "${T}" "${T}/h" "${T}/reg" 2026-10-05 "maq-a" --dry-run
[ "$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['legacy']['kind'])" "${T}/estado/registros-buzon/place.json" 2>&1)" = dangling ] \
  && ok "8.19-B T29 el viejo colgado con el lugar sano: dangling" || mal "8.19-B T29 colgado: $(cat "${T}/estado/registros-buzon/place.json" 2>&1 | head -c 300)"
# ── 8.26 T40 · Mailbox_PlaceJson_SaysReleaseVersionAndTeamLayer_NeverTheLayerUrl (story 8.26 · AC 40) ────────────────
# `install` dice lo que `doctor --json` dice de la instalación —el modo, la versión y la capa del equipo— desde el mismo
# estado, para juntar el AC 40 de todas las máquinas sin pedirle nada a nadie. La dirección del repo de la capa no viaja;
# un campo con otra forma va null; un estado ilegible, no_medido.
# 🔴 rojo previo: sin esto, saber si cada máquina está en la versión bajada y con la capa pedía a cada dev correr doctor.
T="${BASE}/t40"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"; casa29 "${T}/casa" "${T}/clon"
printf '{"schema":1,"mode":"managed","tree":"%s","sources":[],"version":{"number":"2026.10.14.51","installed_at":"2026-10-14T21:13:09.465Z"},"team":{"repo":"https://servidor.example/org/_git/capa-secreta","name":"equipo","files":84,"commit":"556dd0f400cb9eedcfed29a4de6313dda547158c"}}\n' "${T}/clon" > "${T}/casa/.claude/.tycon-pipeline/harness-state.json"
HOME="${T}/casa" USERPROFILE="${T}/casa" subir_reg "${T}" "${T}/h" "${T}/reg" 2026-10-05 "maq-a" --dry-run
python3 - "${T}/estado/registros-buzon/place.json" <<'PY' && ok "8.26 T40 place.json dice versión bajada, número y capa del equipo, sin la dirección de la capa" || mal "8.26 T40 install: $(cat "${T}/estado/registros-buzon/place.json" 2>&1 | head -c 500)"
import json, sys
texto = open(sys.argv[1], encoding="utf-8").read()
assert "capa-secreta" not in texto and "servidor.example" not in texto, texto
i = json.loads(texto)["install"]
assert i == {"mode": "managed", "version": "2026.10.14.51", "team": {"name": "equipo", "files": 84, "commit": "556dd0f400cb9eedcfed29a4de6313dda547158c"}}, i
PY
T="${BASE}/t40b"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"; casa29 "${T}/casa" "${T}/clon"
printf '{"schema":1,"mode":"Managed Mode","tree":"%s","sources":[],"version":{"number":"último"},"team":{"name":"con espacios y /barras","files":-3,"commit":"corto"}}\n' "${T}/clon" > "${T}/casa/.claude/.tycon-pipeline/harness-state.json"
HOME="${T}/casa" USERPROFILE="${T}/casa" subir_reg "${T}" "${T}/h" "${T}/reg" 2026-10-05 "maq-a" --dry-run
python3 - "${T}/estado/registros-buzon/place.json" <<'PY' && ok "8.26 T40 un campo con otra forma va null: no se adivina ni se copia" || mal "8.26 T40 formas raras: $(cat "${T}/estado/registros-buzon/place.json" 2>&1 | head -c 500)"
import json, sys
texto = open(sys.argv[1], encoding="utf-8").read()
assert "barras" not in texto and "último" not in texto and "Managed Mode" not in texto, texto
i = json.loads(texto)["install"]
assert i == {"mode": None, "version": None, "team": {"name": None, "files": None, "commit": None}}, i
PY
T="${BASE}/t40c"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"; casa29 "${T}/casa" "${T}/clon"
echo '{ esto no es json' > "${T}/casa/.claude/.tycon-pipeline/harness-state.json"
HOME="${T}/casa" USERPROFILE="${T}/casa" subir_reg "${T}" "${T}/h" "${T}/reg" 2026-10-05 "maq-a" --dry-run
python3 - "${T}/estado/registros-buzon/place.json" <<'PY' && ok "8.26 T40 el estado ilegible: install no_medido con motivo" || mal "8.26 T40 estado ilegible: $(cat "${T}/estado/registros-buzon/place.json" 2>&1 | head -c 400)"
import json, sys
i = json.load(open(sys.argv[1]))["install"]
assert i.get("status") == "no_medido" and i.get("reason"), i
PY
# una máquina sin el mecanismo instalado no sube place.json (no participa: no es «no medido»)
T="${BASE}/t29c"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"; mkdir -p "${T}/casa"
HOME="${T}/casa" USERPROFILE="${T}/casa" subir_reg "${T}" "${T}/h" "${T}/reg" 2026-10-05 "maq-a" --dry-run
[ "${RC}" -eq 0 ] && [ ! -e "${T}/estado/registros-buzon/place.json" ] && ok "8.19-B T29 sin el mecanismo instalado: no hay place.json" || mal "8.19-B T29 sin mecanismo (rc=${RC}): $(ls "${T}/estado/registros-buzon" 2>&1 | tr '\n' ' ')"
node -e 'const { FORMA_REGISTRO } = require(process.argv[1]); process.exit(FORMA_REGISTRO.test("place.json") ? 0 : 1)' "${SUBIR}" \
  && ok "8.19-B T29 y la bajada reconoce place.json (la misma forma de los registros)" || mal "8.19-B T29 la bajada no reconocería place.json"

# ════ story 2.24 · el buzón sólo crea: nombre nuevo por subida, «ya existe» separado de la llave ════════════════
# Los códigos del buzón de mentira son los medidos en el laboratorio de la story (Dev Agent Record, Task 0).
reg_campo() { python3 -c "import json,sys; d=json.load(open(sys.argv[1]))['archivos'].get(sys.argv[2]) or {}; v=d.get(sys.argv[3]); print('' if v is None else v)" "$1/estado/mailbox-uploads.json" "$2" "$3" 2>/dev/null; }
puts_a() { if [ -f "$1/pedidos.jsonl" ]; then grep '"metodo":"PUT"' "$1/pedidos.jsonl" | grep -c "$2" || true; else echo 0; fi; }

# ── 2.24 T1 · PrimeraSubida_NombreDeSiempre_ConIfNoneMatch (AC 3, 6) ── 🔴 rojo previo: sin la cabecera.
T="${BASE}/t224-1"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "1.1-2026-10-01T1000"
subir "${T}" "${T}/h" "mac-de-prueba"
python3 - "${T}/b/pedidos.jsonl" <<'PY' && [ "${RC}" -eq 0 ] && [ "$(reg_campo "${T}" mac-de-prueba/1.1-2026-10-01T1000.json blob)" = "mac-de-prueba/1.1-2026-10-01T1000.json" ] \
  && ok "2.24-T1 la primera subida va al nombre de siempre, con If-None-Match: *, y se anota con su blob" || mal "2.24-T1 rc=${RC} $(head -2 "${T}/b/pedidos.jsonl" | cut -c1-200)"
import json, sys
ps = [json.loads(l) for l in open(sys.argv[1])]
assert len(ps) == 2 and all(p['inm'] == '*' for p in ps), ps
assert sorted(p['ruta'] for p in ps) == ['/corridas/mac-de-prueba/1.1-2026-10-01T1000.hilo.jsonl.gz', '/corridas/mac-de-prueba/1.1-2026-10-01T1000.json'], ps
PY

# ── 2.24 T2 · ArchivoCambiado_SubeAVersion_NoPisa (AC 4, 6) ── 🔴 rojo previo: PUT al nombre viejo (lo de hoy).
cp "${T}/b/blobs/corridas/mac-de-prueba/1.1-2026-10-01T1000.hilo.jsonl.gz" "${T}/hilo-viejo"
head -c 6000 /dev/urandom | base64 | gzip -c > "${T}/h/1.1-2026-10-01T1000.hilo.jsonl.gz"
: > "${T}/b/pedidos.jsonl"
TYCON_NOW=2026-10-20T10:00:00.000Z subir "${T}" "${T}/h" "mac-de-prueba"
CLAVE="mac-de-prueba/1.1-2026-10-01T1000.hilo.jsonl.gz"
[ "${RC}" -eq 0 ] && [ "$(puts "${T}/b")" = "1" ] && grep -q '"ruta":"/corridas/mac-de-prueba/v20261020T100000000Z/1.1-2026-10-01T1000.hilo.jsonl.gz"' "${T}/b/pedidos.jsonl" \
  && cmp -s "${T}/hilo-viejo" "${T}/b/blobs/corridas/${CLAVE}" && cmp -s "${T}/h/1.1-2026-10-01T1000.hilo.jsonl.gz" "${T}/b/blobs/corridas/mac-de-prueba/v20261020T100000000Z/1.1-2026-10-01T1000.hilo.jsonl.gz" \
  && [ "$(reg_campo "${T}" "${CLAVE}" blob)" = "mac-de-prueba/v20261020T100000000Z/1.1-2026-10-01T1000.hilo.jsonl.gz" ] && [ "$(reg_campo "${T}" "${CLAVE}" version)" = "v20261020T100000000Z" ] \
  && ok "2.24-T2 lo que cambió sube a <máquina>/v<inicio de la pasada>/, el blob de siempre queda idéntico, y el registro anota blob y versión" \
  || mal "2.24-T2 rc=${RC} puts=$(puts "${T}/b") $(cut -c1-200 "${T}/b/pedidos.jsonl") · blob=$(reg_campo "${T}" "${CLAVE}" blob)"

# ── 2.24 T27 · RelojAtrasado_VersionNuncaRetrocede (AC 4) ── 🔴 rojo previo: una versión menor que la anterior.
head -c 7000 /dev/urandom | base64 | gzip -c > "${T}/h/1.1-2026-10-01T1000.hilo.jsonl.gz"
TYCON_NOW=2026-10-20T09:00:00.000Z subir "${T}" "${T}/h" "mac-de-prueba"
[ "${RC}" -eq 0 ] && [ "$(reg_campo "${T}" "${CLAVE}" version)" = "v20261020T100000001Z" ] && [ -f "${T}/b/blobs/corridas/mac-de-prueba/v20261020T100000001Z/1.1-2026-10-01T1000.hilo.jsonl.gz" ] \
  && ok "2.24-T27 con el reloj una hora atrás, la versión es la anterior + 1 ms (nunca retrocede)" || mal "2.24-T27 rc=${RC} versión=$(reg_campo "${T}" "${CLAVE}" version) · $(versiones "${T}" mac-de-prueba | tr '\n' ' ')"

# ── 2.24 T27b · VersionConFechaImposible_NoEsVersion (AC 14; pase adversarial, vuelta 1) ──
# 🔴 rojo previo: Date.parse normaliza el desborde del día: «v20260230…» (30 de febrero) se leía como el 2 de marzo.
node -e '
const u = require(process.argv[1]);
const casos = { v20260230T000000000Z: null, v20260229T000000000Z: null, v20261340T000000000Z: null, v20261020T100000000Z: Date.parse("2026-10-20T10:00:00.000Z"), v20280229T235959999Z: Date.parse("2028-02-29T23:59:59.999Z") };
for (const [v, esperado] of Object.entries(casos)) if (u.msDeVersion(v) !== esperado) { console.error(v, u.msDeVersion(v)); process.exit(1); }
' "${SUBIR}" && ok "2.24-T27b una versión con una fecha imposible (30 y 29 de febrero de 2026, mes 13) no es versión; un 29 de febrero bisiesto sí" \
  || mal "2.24-T27b msDeVersion acepta una fecha imposible"

# ── 2.24 T29 · UnaVersionPorPasada (AC 4) ── 🔴 rojo previo: una carpeta por archivo.
T="${BASE}/t224-29"; buzon "${T}/b"; config "${T}/cfg.json"
for i in 1 2 3; do corrida "${T}/h" "2.${i}-2026-10-02T1000"; done
subir "${T}" "${T}/h" "maq-a"
for i in 1 2 3; do head -c 3000 /dev/urandom | base64 | gzip -c > "${T}/h/2.${i}-2026-10-02T1000.hilo.jsonl.gz"; done
TYCON_NOW=2026-10-21T08:30:00.250Z subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 0 ] && [ "$(versiones "${T}" maq-a | wc -l | tr -d ' ')" = "1" ] && [ "$(ls "${T}/b/blobs/corridas/maq-a/v20261021T083000250Z" | wc -l | tr -d ' ')" = "3" ] \
  && ok "2.24-T29 tres corridas que cambiaron en una pasada van bajo la MISMA carpeta v<inicio de la pasada>" || mal "2.24-T29 rc=${RC} versiones: $(versiones "${T}" maq-a | tr '\n' ' ')"

# ── 2.24 T3 · Registros_UnJuegoPorPreparacion_CoberturaUltima (AC 5) ── 🔴 rojo previo: registros/<archivo> plano.
T="${BASE}/t224-3"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
TYCON_NOW=2026-10-20T07:00:00.000Z subir_reg "${T}" "${T}/no-existe" "${T}/reg" 2026-10-20 "maq-a"
python3 - "${T}/b/pedidos.jsonl" <<'PY' && [ "${RC}" -eq 0 ] && ok "2.24-T3 el juego de registros va bajo registros/v<preparación>/, con la cobertura último" || mal "2.24-T3 rc=${RC} $(grep -o '"ruta":"[^"]*"' "${T}/b/pedidos.jsonl" | head -4 | tr '\n' ' ')"
import json, sys
ps = [json.loads(l)['ruta'] for l in open(sys.argv[1])]
assert ps and all(p.startswith('/corridas/maq-a/registros/v20261020T070000000Z/') for p in ps), ps
assert ps[-1].endswith('/cobertura.json') and len(ps) >= 3, ps
PY

# ── 2.24 T4 · Registros_MismoDiaMismaVersion_DiaSiguienteNueva (AC 5) ── 🔴 rojo previo: versión por pasada, o el idéntico salteado.
T="${BASE}/t224-4"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
subir_reg "${T}" "${T}/no-existe" "${T}/reg" 2026-10-20 "maq-a"
V1="$(regdir "${T}")"; N1=$(puts "${T}/b")
subir_reg "${T}" "${T}/no-existe" "${T}/reg" 2026-10-20 "maq-a"
[ "${RC}" -eq 0 ] && [ "$(puts "${T}/b")" = "${N1}" ] && [ "$(regdir "${T}")" = "${V1}" ] && ok "2.24-T4 otra pasada el mismo día: la misma versión, ningún PUT de más" || mal "2.24-T4 mismo día: rc=${RC} puts ${N1}→$(puts "${T}/b")"
echo '{"ts":"2026-10-21T08:00:00Z","name":"build","status":"blocked"}' >> "${T}/reg/gates.log"   # bypass.log queda idéntico
subir_reg "${T}" "${T}/no-existe" "${T}/reg" 2026-10-21 "maq-a"
V2="$(regdir "${T}")"
[ "${RC}" -eq 0 ] && [ "${V2}" != "${V1}" ] && [ -f "${V2}/bypass.log.gz" ] && [ -f "${V2}/gates.log.gz" ] && [ -f "${V2}/cobertura.json" ] && cmp -s "${V1}/bypass.log.gz" "${V2}/bypass.log.gz" \
  && ok "2.24-T4 al día siguiente, otra versión con TODOS los archivos del juego (también el bypass.log.gz igual al de ayer)" || mal "2.24-T4 día siguiente: rc=${RC} ${V1} → ${V2}: $(ls "${V2}" 2>&1 | tr '\n' ' ')"

# ── 2.24 T5 · YaExiste409_ReintentaConNombreNuevo_NoCorta (AC 7) ── 🔴 rojo previo: el 409 cae en «no aceptado».
T="${BASE}/t224-5"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "3.1-2026-10-03T1000"; corrida "${T}/h" "3.2-2026-10-03T1100"
mkdir -p "${T}/b/blobs/corridas/maq-a"; echo "de otra subida" > "${T}/b/blobs/corridas/maq-a/3.1-2026-10-03T1000.json"   # el registro local se perdió
TYCON_NOW=2026-10-22T12:00:00.000Z subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" estado)" = "subido" ] && [ "$(campo "${T}" ya_existian)" = "1" ] && [ "$(campo "${T}" subidos)" = "4" ] \
  && cmp -s "${T}/h/3.1-2026-10-03T1000.json" "${T}/b/blobs/corridas/maq-a/v20261022T120000000Z/3.1-2026-10-03T1000.json" \
  && [ "$(cat "${T}/b/blobs/corridas/maq-a/3.1-2026-10-03T1000.json")" = "de otra subida" ] \
  && ok "2.24-T5 un 409 BlobAlreadyExists se reintenta UNA vez con versión nueva (201), la pasada sigue, ya_existian 1, nada pisado" \
  || mal "2.24-T5 rc=${RC} estado=$(campo "${T}" estado) ya_existian=$(campo "${T}" ya_existian) subidos=$(campo "${T}" subidos)"

# ── 2.24 T6 · UnauthorizedBlobOverwrite_ReintentaYSigue (AC 7) ── 🔴 rojo previo: corta toda la subida (lo de hoy).
T="${BASE}/t224-6"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "3.1-2026-10-03T1000"
echo c > "${T}/b/politica"
mkdir -p "${T}/b/blobs/corridas/maq-a"; echo "de otra subida" > "${T}/b/blobs/corridas/maq-a/3.1-2026-10-03T1000.json"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" ya_existian)" = "1" ] && [ "$(campo "${T}" estado)" = "subido" ] && [ -n "$(reg_campo "${T}" maq-a/3.1-2026-10-03T1000.json version)" ] \
  && ok "2.24-T6 un 403 UnauthorizedBlobOverwrite (política «sólo crear») al nombre de siempre: reintento con versión, anotado, exit 0" \
  || mal "2.24-T6 rc=${RC} estado=$(campo "${T}" estado) ya_existian=$(campo "${T}" ya_existian) motivo=$(campo "${T}" motivo)"

# ── 2.24 T7 · PermissionMismatch_LlaveSinPermiso_SinReintento (AC 8) ── 🔴 rojo previo: llave_invalida, o un reintento.
T="${BASE}/t224-7"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "3.1-2026-10-03T1000"
echo "AuthorizationPermissionMismatch *" > "${T}/b/codigo403"
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "llave_sin_permiso" ] && [ "$(puts "${T}/b")" = "1" ] && [ -z "$(en_registro "${T}")" ] \
  && campo "${T}" motivo | grep 'no deja crear' >/dev/null && campo "${T}" motivo | grep 'subida-prueba' >/dev/null && ! campo "${T}" motivo | grep -i 'vencida' >/dev/null \
  && ok "2.24-T7 403 AuthorizationPermissionMismatch → llave_sin_permiso, exit 1, un solo PUT, nada anotado, el motivo nombra la política y no dice «vencida»" \
  || mal "2.24-T7 rc=${RC} estado=$(campo "${T}" estado) puts=$(puts "${T}/b") motivo=$(campo "${T}" motivo)"

# ── 2.24 T8 · AuthenticationFailed_LlaveInvalidaComoHoy (AC 9) ── 🔴 rojo previo: confundirlo con «ya existe» y reintentar.
for CASO in authfail sincodigo 404; do
  T="${BASE}/t224-8-${CASO}"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "3.1-2026-10-03T1000"
  case "${CASO}" in authfail) echo "AuthenticationFailed *" > "${T}/b/codigo403" ;; sincodigo) echo "- *" > "${T}/b/codigo403" ;; 404) echo 404 > "${T}/b/modo" ;; esac
  subir "${T}" "${T}/h" "maq-a"
  [ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "llave_invalida" ] && [ "$(puts "${T}/b")" = "1" ] && campo "${T}" motivo | grep 'vencida o revocada' >/dev/null \
    && ok "2.24-T8 (${CASO}) → llave_invalida como hoy, sin reintento" || mal "2.24-T8 (${CASO}) rc=${RC} estado=$(campo "${T}" estado) puts=$(puts "${T}/b")"
done

# ── 2.24 T28 · SegundoYaExiste_NoSubidosSinMasReintentos (AC 7) ── 🔴 rojo previo: reintentar sin fin, o cortar la pasada.
T="${BASE}/t224-28"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "3.1-2026-10-03T1000"; corrida "${T}/h" "3.2-2026-10-03T1100"
echo "3.1-2026-10-03T1000.json" > "${T}/b/rechazar"   # 409 BlobAlreadyExists al nombre de siempre y a toda versión
subir "${T}" "${T}/h" "maq-a"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "parcial" ] && [ "$(puts_a "${T}/b" '3.1-2026-10-03T1000.json')" = "2" ] && [ "$(campo "${T}" subidos)" = "3" ] \
  && [ "$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['no_subidos']))" "${T}/out.json")" = "1" ] \
  && ok "2.24-T28 un segundo «ya existe» no se reintenta más: no_subidos 1, parcial, los demás suben" \
  || mal "2.24-T28 rc=${RC} estado=$(campo "${T}" estado) puts del 3.1=$(puts_a "${T}/b" '3.1-2026-10-03T1000.json') subidos=$(campo "${T}" subidos)"

# ── 2.24 T9 · RegistroYaExiste_CoberturaRetenida_JuegoNuevoDespues (AC 10) ── 🔴 rojo previo: cobertura subida junto a un juego incompleto.
T="${BASE}/t224-9"; buzon "${T}/b"; config "${T}/cfg.json"; registros "${T}/reg"
echo "gates.log.gz" > "${T}/b/rechazar"
TYCON_NOW=2026-10-20T07:00:00.000Z subir_reg "${T}" "${T}/no-existe" "${T}/reg" 2026-10-20 "maq-a"
V1="$(regdir "${T}")"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "parcial" ] && [ "$(puts_a "${T}/b" 'gates.log.gz')" = "1" ] && [ ! -e "${V1}/cobertura.json" ] \
  && ! grep -q '"preparado"' "${T}/estado/registros-buzon/cobertura.json" \
  && ok "2.24-T9 «ya existe» en gates.log.gz: sin reintento, cobertura retenida, parcial, exit 1, la preparación invalidada" \
  || mal "2.24-T9 primera: rc=${RC} estado=$(campo "${T}" estado) puts gates=$(puts_a "${T}/b" 'gates.log.gz') · $(ls "${V1}" | tr '\n' ' ')"
ls "${V1}" > "${T}/v1-antes"
rm -f "${T}/b/rechazar"
TYCON_NOW=2026-10-20T07:00:00.000Z subir_reg "${T}" "${T}/no-existe" "${T}/reg" 2026-10-20 "maq-a"
V2="$(regdir "${T}")"
[ "${RC}" -eq 0 ] && [ "${V2}" != "${V1}" ] && [ -f "${V2}/gates.log.gz" ] && [ -f "${V2}/bypass.log.gz" ] && [ -f "${V2}/cobertura.json" ] && ls "${V1}" | cmp -s - "${T}/v1-antes" \
  && ok "2.24-T9 la segunda pasada del mismo día (mismo reloj) sube el juego entero bajo otra versión, y nada nuevo en la primera" \
  || mal "2.24-T9 segunda: rc=${RC} ${V1} → ${V2}: $(ls "${V2}" 2>&1 | tr '\n' ' ')"

# ── 2.24 T10 · CheckCreateOnly_403Bien_201DejoEscribir_SinDatoNoMedido (AC 16, 17) ── 🔴 rojo previo: sonda con cuerpo vacío.
T="${BASE}/t224-10"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "4.1-2026-10-04T1000" 3000; corrida "${T}/h" "4.2-2026-10-04T1100" 3000
printf '{"chico":1}\n' > "${T}/h/4.0-2026-10-04T0900.json"
subir "${T}" "${T}/h" "maq-a"
cp "${T}/h/4.0-2026-10-04T0900.json" "${T}/el-mas-chico"
echo c > "${T}/b/politica"; : > "${T}/b/pedidos.jsonl"
subir "${T}" "${T}/h" "maq-a" --check-create-only
python3 - "${T}/b/pedidos.jsonl" <<'PY' && [ "${RC}" -eq 0 ] && campo "${T}" motivo | grep 'la política no deja pisar' >/dev/null \
  && ok "2.24-T10 (política c) un PUT de los mismos bytes del confirmado más chico, sin If-None-Match → 403 → «la política no deja pisar», exit 0" || mal "2.24-T10 política c: rc=${RC} motivo=$(campo "${T}" motivo) $(cut -c1-200 "${T}/b/pedidos.jsonl")"
import json, sys
ps = [json.loads(l) for l in open(sys.argv[1])]
assert len(ps) == 1 and ps[0]['metodo'] == 'PUT' and ps[0]['inm'] is None and ps[0]['ruta'] == '/corridas/maq-a/4.0-2026-10-04T0900.json', ps
PY
rm -f "${T}/b/politica"; : > "${T}/b/pedidos.jsonl"
subir "${T}" "${T}/h" "maq-a" --check-create-only
[ "${RC}" -eq 1 ] && campo "${T}" motivo | grep 'dejó escribir, o el blob ya no estaba' >/dev/null && cmp -s "${T}/el-mas-chico" "${T}/b/blobs/corridas/maq-a/4.0-2026-10-04T0900.json" \
  && ok "2.24-T10 (política cw) 201 → «dejó escribir, o el blob ya no estaba», exit 1, y el cuerpo recibido es idéntico al confirmado" || mal "2.24-T10 política cw: rc=${RC} motivo=$(campo "${T}" motivo)"
printf '{"chico":2}\n' > "${T}/h/4.0-2026-10-04T0900.json"   # el más chico cambió en la máquina: otro sha, no se usa
: > "${T}/b/pedidos.jsonl"
subir "${T}" "${T}/h" "maq-a" --check-create-only
grep -q '"ruta":"/corridas/maq-a/4.0-2026-10-04T0900.json"' "${T}/b/pedidos.jsonl" && mal "2.24-T10 usó un archivo cuyo sha256 ya no es el confirmado" || ok "2.24-T10 un archivo local con otro sha256 no se usa (va el siguiente confirmado)"
python3 - "${T}/estado/mailbox-uploads.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
for v in d['archivos'].values(): v.pop('blob', None); v.pop('version', None)
json.dump(d, open(p, 'w'))
PY
: > "${T}/b/pedidos.jsonl"
subir "${T}" "${T}/h" "maq-a" --check-create-only
grep -Eq '"ruta":"/corridas/maq-a/4\.[12]-2026-10-04T1[01]00\.(json|hilo\.jsonl\.gz)"' "${T}/b/pedidos.jsonl" && [ "$(wc -l < "${T}/b/pedidos.jsonl" | tr -d ' ')" = "1" ] \
  && ok "2.24-T10 una entrada del registro de antes (sin blob) va al nombre de siempre" || mal "2.24-T10 entrada vieja: $(cut -c1-200 "${T}/b/pedidos.jsonl")"
T="${BASE}/t224-10b"; buzon "${T}/b"; config "${T}/cfg.json"; corrida "${T}/h" "4.1-2026-10-04T1000"
subir "${T}" "${T}/h" "maq-a" --check-create-only
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "no_medido" ] && [ -n "$(campo "${T}" motivo)" ] && [ "$(pedidos "${T}/b")" = "0" ] \
  && ok "2.24-T10 sin nada confirmado: «no medido» con motivo, exit 1, ningún pedido" || mal "2.24-T10 sin dato: rc=${RC} estado=$(campo "${T}" estado) pedidos=$(pedidos "${T}/b")"
# cualquier otro código del buzón a la sonda → su código y exit 1 (AC 16; cobertura de pruebas, vuelta 1)
subir "${T}" "${T}/h" "maq-a"
echo 500 > "${T}/b/modo"
subir "${T}" "${T}/h" "maq-a" --check-create-only
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "otro" ] && campo "${T}" motivo | grep '500 InternalError' >/dev/null \
  && ok "2.24-T10 otro código a la sonda (500) → lo dice con su código, exit 1" || mal "2.24-T10 500: rc=${RC} estado=$(campo "${T}" estado) motivo=$(campo "${T}" motivo)"

# ── 2.24 T11 · LlaveSpConEscritura_SeNiega (AC 18) ── 🔴 rojo previo: `/[^cwa]/` de hoy deja pasar `cw`.
for SP in cw ca; do
  T="${BASE}/t224-11-${SP}"; buzon "${T}/b"; corrida "${T}/h" "4.1-2026-10-04T1000"
  config "${T}/cfg.json" "2099-01-01" "sv=2022-11-02&si=subida-prueba&sp=${SP}&sr=c&spr=https&sig=${FAKE_SIGNATURE}"
  subir "${T}" "${T}/h" "maq-a"
  [ "${RC}" -eq 2 ] && [ "$(campo "${T}" estado)" = "llave_con_escritura" ] && [ "$(pedidos "${T}/b")" = "0" ] \
    && ok "2.24-T11 sp=${SP} → exit 2, llave_con_escritura, ningún pedido" || mal "2.24-T11 sp=${SP} → rc=${RC} estado=$(campo "${T}" estado) pedidos=$(pedidos "${T}/b")"
done
for SP in c ninguno; do
  T="${BASE}/t224-11-${SP}"; buzon "${T}/b"; corrida "${T}/h" "4.1-2026-10-04T1000"
  if [ "${SP}" = c ]; then config "${T}/cfg.json" "2099-01-01" "sv=2022-11-02&si=subida-prueba&sp=c&sr=c&spr=https&sig=${FAKE_SIGNATURE}"; else config "${T}/cfg.json"; fi
  subir "${T}" "${T}/h" "maq-a"
  [ "${RC}" -eq 0 ] && [ "$(campo "${T}" estado)" = "subido" ] && ok "2.24-T11 sp=${SP} → se acepta y sube" || mal "2.24-T11 sp=${SP} → rc=${RC} estado=$(campo "${T}" estado)"
done

# ── 2.24 T12 · SinBuzon_NoSubeNada (AC 22) ── 🔴 rojo previo: sin llave ni integración, intentar subir.
T="${BASE}/t224-12"; buzon "${T}/b"; corrida "${T}/h" "4.1-2026-10-04T1000"; mkdir -p "${T}/casa"
HOME="${T}/casa" TYCON_MAILBOX_JSON="${T}/no-existe.json" TYCON_MAILBOX_URL_BASE="${URL_BUZON}" TYCON_TIMING_HISTORY="${T}/h" \
  TYCON_UPLOADS_LOG="${T}/estado/mailbox-uploads.json" TYCON_MACHINE=maq-a env -u TYCON_MAILBOX node "${SUBIR}" --json > "${T}/out.json" 2> "${T}/err.txt"
RC=$?
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" estado)" = "apagado" ] && [ "$(pedidos "${T}/b")" = "0" ] \
  && ok "2.24-T12 sin llave ni integración: apagado, exit 0, ningún pedido" || mal "2.24-T12 rc=${RC} estado=$(campo "${T}" estado) pedidos=$(pedidos "${T}/b")"

# ── 2.24 T13 · CodigoPublico_SinCuentaDeNingunaOrganizacion (AC 22) ── 🔴 rojo previo: una cuenta escrita en el código.
FUERA="$(grep -n 'blob\.core\.windows\.net' "${RAIZ}"/scripts/metrics/*.js "${RAIZ}"/scripts/nightly/dashboard/*.js 2>/dev/null | grep -v '\${cfg\.cuenta}\.blob\.core\.windows\.net' || true)"
[ -z "${FUERA}" ] && ok "2.24-T13 la única dirección del servicio en el código es la plantilla con cfg.cuenta" || mal "2.24-T13 dirección escrita: ${FUERA}"

# ── 2.24 T24 · Piezas_SoloCrearYSinVencimiento (AC 21) ── 🔴 rojo previo: «revisar en 2027-03» y «permisos `cw`».
PIEZAS="${RAIZ}/guides/piezas-del-arnes.md"
SECCION="$(awk '/upload-runs\.js/ && /^#/ {p=1; print; next} p && /^#/ {exit} p' "${PIEZAS}")"
CABECERA="$(sed -n '1,60p' "${SUBIR}")"
if echo "${SECCION}" | grep 'sólo crear' >/dev/null && echo "${SECCION}" | grep 'sin vencimiento' >/dev/null && echo "${SECCION}" | grep 'UnauthorizedBlobOverwrite' >/dev/null \
   && echo "${CABECERA}" | grep 'sólo crear' >/dev/null && ! printf '%s\n%s' "${SECCION}" "${CABECERA}" | grep 'revisar en 2027-03' >/dev/null \
   && ! printf '%s\n%s' "${SECCION}" "${CABECERA}" | grep 'permisos `cw`' >/dev/null; then
  ok "2.24-T24 la guía y la cabecera dicen «sólo crear»; la guía, «sin vencimiento» y el síntoma de la máquina con código de antes"
else
  mal "2.24-T24 la guía o la cabecera siguen con el texto viejo (sección: $(echo "${SECCION}" | head -c 120))"
fi

# ── 2.24 T25 · NoRegresion_SinLecturaEnLaSubida (AC 24) ── el T7 de hoy, que sigue.
grep -Eq "method: *'(GET|DELETE|HEAD)'|comp=list" "${SUBIR}" && mal "2.24-T25 la subida tiene una operación de lectura/listado" || ok "2.24-T25 la subida sigue sin GET, HEAD, DELETE ni comp=list (el chequeo de AC 16 es un PUT)"
NO_PUT=$(cat "${BASE}"/t224-*/b/pedidos.jsonl 2>/dev/null | grep -vc '"metodo":"PUT"' || true)
[ "${NO_PUT}" = "0" ] && ok "2.24-T25 en los casos 2.24, todos los pedidos fueron PUT" || mal "2.24-T25 ${NO_PUT} pedido(s) que no son PUT"

echo
[ "${FALLOS}" -eq 0 ] && { echo "subir-corridas: todo verde"; exit 0; } || { echo "${FALLOS} fallo(s)"; exit 1; }
