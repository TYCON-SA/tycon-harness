#!/usr/bin/env bash
# download-runs.test.sh — la bajada del buzón de corridas, sólo para quien tiene el rol de lectura.
#
# Sin red y sin `az` real: el «buzón» es un servidor HTTP local que imita el listado XML y el GET de blobs
# de Azure Storage con `Authorization: Bearer`, y `az` es un doble (TYCON_AZ_BIN) que devuelve un token, o
# falla como una máquina sin sesión, o no existe. HOME es falso: nada de esta máquina entra ni sale.
#
# 🔴 REGLA DE ADMISIÓN: cada caso trae escrito qué lo pone en rojo. El exit code se lee ANTES de cualquier
#    pipe. bash 3.2 (macOS): siempre `${v}`.

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Las integraciones se declaran por variable — sin perfil del equipo, download-runs.js dice «buzón apagado»
# (o «Azure DevOps apagado»: la bajada usa la sesión de az) y sale 0 antes de hacer lo que esta suite mide con dobles.
export TYCON_MAILBOX=1 TYCON_ADO_ORG=https://dev.azure.com/prueba
BAJAR="${RAIZ}/scripts/metrics/download-runs.js"
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }

# 🔴 Esta suite NO toca el tablero del repo (gemelo de dashboard.test.sh C-27 y dashboard-runs.test.sh T15). Correr
#    la página del equipo con --nightly y sin --output la escribe en artifacts/tablero-del-arnes.html del repo; en la
#    misma tanda que dashboard-runs, ésa la vería cambiar y se pondría roja de a ratos.
#    Cada página que genera esta suite va a su temporal; T24, al final, lo cuida.
huella() { python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1" 2>/dev/null || echo AUSENTE; }
ENTREGABLE_SEIS="${RAIZ}/artifacts/tablero-del-arnes.html"
HUELLA_SEIS_ANTES="$(huella "${ENTREGABLE_SEIS}")"

echo "== download-runs.test.sh =="
[ -f "${BAJAR}" ] || { mal "no existe ${BAJAR} (rojo previo: el script todavía no está)"; echo; echo "${FALLOS} fallo(s)"; exit 1; }

BASE="$(mktemp -d)"
PIDS=""
trap 'for p in ${PIDS}; do kill "${p}" 2>/dev/null; done; rm -rf "${BASE}"' EXIT
mkdir -p "${BASE}/home"; export HOME="${BASE}/home"
unset TYCON_MAILBOX_JSON TYCON_MAILBOX_URL_BASE TYCON_MAILBOX_DIR TYCON_AZ_BIN TYCON_DOWNLOADS_LOG

# ── el buzón de mentira (lectura) ───────────────────────────────────────────────────────────────
# `blobs/<contenedor>/<nombre>` son los blobs; `token` el token válido; `modo` (ok|403); `pagina` (tamaño
# de página del listado, para obligar a seguir NextMarker); `sin-md5` (lista sin Content-MD5).
cat > "${BASE}/buzon.js" <<'JS'
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = process.argv[2];
const leer = (f, d) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch (_) { return d; } };
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function todos(raiz, pre = '') {
  let out = [];
  for (const e of fs.readdirSync(raiz, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = pre ? `${pre}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(todos(path.join(raiz, e.name), rel)); else out.push(rel);
  }
  return out;
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  fs.appendFileSync(path.join(dir, 'pedidos.jsonl'), JSON.stringify({ metodo: req.method, ruta: decodeURIComponent(u.pathname), query: u.search, auth: req.headers.authorization || null, version: req.headers['x-ms-version'] || null }) + '\n');
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  const listar = u.searchParams.get('comp') === 'list';
  const modoLista = leer('modo-lista', ''), modoGet = leer('modo-get', '');
  if (listar && modoLista) { res.writeHead(Number(modoLista)); return res.end('<Error><Code>X</Code></Error>'); }
  if (!listar && modoGet) { res.writeHead(Number(modoGet)); return res.end('<Error><Code>AuthorizationPermissionMismatch</Code></Error>'); }
  // story 2.23: con `sas-sig`, el buzón acepta también la firma en la consulta (la SAS de lectura del sitio), sin cabecera
  // story 2.23: `lista-html` = el listado contesta 200 con algo que no es un listado (la página de un proxy)
  if (u.searchParams.get('comp') === 'list' && leer('lista-html', '')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body>proxy</body></html>'); }
  const sasSig = leer('sas-sig', '');
  const conSas = sasSig && u.searchParams.get('sig') === sasSig && !req.headers.authorization;
  if (leer('modo', 'ok') === '403' || (req.headers.authorization !== `Bearer ${leer('token', '')}` && !conSas)) {
    res.writeHead(403); return res.end('<?xml version="1.0"?><Error><Code>AuthorizationPermissionMismatch</Code></Error>');
  }
  const partes = decodeURIComponent(u.pathname).split('/').filter(Boolean);
  const cont = partes.shift();
  const raiz = path.join(dir, 'blobs', cont || '_');
  if (u.searchParams.get('comp') === 'list') {
    if (!fs.existsSync(raiz)) { res.writeHead(404); return res.end('<Error><Code>ContainerNotFound</Code></Error>'); }
    const nombres = todos(raiz);
    const desde = Number(u.searchParams.get('marker') || 0);
    const tam = Number(leer('pagina', '5000'));
    const trozo = nombres.slice(desde, desde + tam);
    const sig = desde + tam < nombres.length ? String(desde + tam) : '';
    // story 2.24: `fechas` = JSON { nombre: [creado ISO | null, modificado ISO] }; sin entrada, las dos son el mtime del archivo.
    let fechas = {};
    try { fechas = JSON.parse(leer('fechas', '{}')); } catch (_) { fechas = {}; }
    const blobs = trozo.map((n) => {
      const b = fs.readFileSync(path.join(raiz, n));
      const md5 = leer('sin-md5', '') ? '' : crypto.createHash('md5').update(b).digest('base64');
      const mt = fs.statSync(path.join(raiz, n)).mtime.toUTCString();
      const [creado, modificado] = fechas[n] || [mt, mt];
      const rfc = (iso) => (/^\d{4}-/.test(iso) ? new Date(iso).toUTCString() : iso);
      const fechasXml = `${creado ? `<Creation-Time>${rfc(creado)}</Creation-Time>` : ''}${modificado ? `<Last-Modified>${rfc(modificado)}</Last-Modified>` : ''}`;
      return `<Blob><Name>${xml(n)}</Name><Properties>${fechasXml}<Content-Length>${b.length}</Content-Length><Content-MD5>${md5}</Content-MD5><Etag>0x${crypto.createHash('sha1').update(b).digest('hex').slice(0, 16)}</Etag></Properties></Blob>`;
    }).join('');
    res.writeHead(200, { 'content-type': 'application/xml' });
    return res.end(`<?xml version="1.0" encoding="utf-8"?><EnumerationResults ContainerName="${cont}"><Blobs>${blobs}</Blobs><NextMarker>${sig}</NextMarker></EnumerationResults>`);
  }
  const archivo = path.join(raiz, ...partes);
  // story 2.24: `falla-get` = un nombre al que el GET contesta 500 (el servicio falla con ese blob)
  if (leer('falla-get', '') === partes.join('/')) { res.writeHead(500); return res.end('<Error><Code>InternalError</Code></Error>'); }
  if (!fs.existsSync(archivo)) { res.writeHead(404); return res.end(); }
  let b = fs.readFileSync(archivo);
  const md5 = crypto.createHash('md5').update(b).digest('base64');
  // `corromper` = un nombre: se sirve con el mismo largo y el primer byte cambiado (llega distinto).
  if (leer('corromper', '') === partes.join('/')) { b = Buffer.from(b); b[0] = b[0] ^ 0xff; }
  const responder = () => { res.writeHead(200, { 'content-length': b.length, 'content-md5': md5 }); res.end(b); };
  const demora = Number(leer('demora', '0'));
  if (demora > 0) setTimeout(responder, demora); else responder();
}).listen(0, '127.0.0.1', function () { fs.writeFileSync(path.join(dir, 'puerto'), String(this.address().port)); });
JS

buzon() {
  mkdir -p "$1/blobs/corridas"
  echo "token-bueno" > "$1/token"
  node "${BASE}/buzon.js" "$1" > "$1/servidor.log" 2>&1 &
  PIDS="${PIDS} $!"; disown "$!" 2>/dev/null
  local i=0; while [ ! -s "$1/puerto" ] && [ "${i}" -lt 100 ]; do sleep 0.05; i=$((i+1)); done
  URL_BUZON="http://127.0.0.1:$(cat "$1/puerto")"
}
# blob <buzon> <nombre> [bytes] — un blob en el contenedor «corridas»
blob() { mkdir -p "$(dirname "$1/blobs/corridas/$2")"; head -c "${3:-1500}" /dev/urandom > "$1/blobs/corridas/$2"; }
config() { printf '{"cuenta":"cuentadeprueba","contenedor":"corridas","tenant":"11111111-2222-3333-4444-555555555555","politica":"p","vence":"2099-01-01","sas":"si=p&sig=x"}\n' > "$1"; }
# az <caso> <modo> — un doble de az: token | bad-token (sin el rol) | no-session
az_doble() {
  mkdir -p "$1/bin"
  case "$2" in
    token)      printf '#!/bin/sh\necho "$@" >> "%s/az.log"\necho token-bueno\n' "$1" ;;
    bad-token)  printf '#!/bin/sh\necho "$@" >> "%s/az.log"\necho token-que-no-tiene-el-rol\n' "$1" ;;
    no-session) printf '#!/bin/sh\necho "$@" >> "%s/az.log"\necho "ERROR: Please run '"'"'az login'"'"' to setup account." >&2\nexit 1\n' "$1" ;;
  esac > "$1/bin/az"
  chmod +x "$1/bin/az"
}
# bajar <caso> [az] [args...] → RC; salida en <caso>/out.json, <caso>/err.txt
bajar() {
  local c="$1" az="$2"; shift 2
  TYCON_MAILBOX_JSON="${c}/cfg.json" TYCON_MAILBOX_URL_BASE="${URL_BUZON}" TYCON_AZ_BIN="${az}" \
    TYCON_MAILBOX_DIR="${c}/estado/corridas-buzon" \
    node "${BAJAR}" --json "$@" > "${c}/out.json" 2> "${c}/err.txt" < /dev/null
  RC=$?
}
campo() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); v=d.get(sys.argv[2]); print(json.dumps(v) if isinstance(v,(dict,list,bool)) or v is None else v)" "$1/out.json" "$2" 2>/dev/null; }
gets() { if [ -f "$1/pedidos.jsonl" ]; then grep -v 'comp=list' "$1/pedidos.jsonl" | grep -c '"metodo":"GET"' || true; else echo 0; fi; }

# ── T10 · baja lo nuevo o cambiado, no lo que ya tiene ────────────────────────────────────
# 🔴 Falla con: bajar todo en cada arranque → con diez máquinas, 1 GB por arranque.
T="${BASE}/t10"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.json" 800
blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.hilo.jsonl.gz" 4000
blob "${T}/b" "devb-mbp/3.1-2026-09-02T1100.json" 900
blob "${T}/b" "devb-mbp/3.1-2026-09-02T1100.hilo.jsonl.gz" 6000
echo 2 > "${T}/b/pagina"      # obliga a seguir el NextMarker
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 0 ] && ok "T10 exit 0" || mal "T10 rc=${RC}: $(head -3 "${T}/err.txt")"
IGUALES=0
for n in equipo-deva/2.1-2026-09-01T1000.json equipo-deva/2.1-2026-09-01T1000.hilo.jsonl.gz devb-mbp/3.1-2026-09-02T1100.json devb-mbp/3.1-2026-09-02T1100.hilo.jsonl.gz; do
  cmp -s "${T}/b/blobs/corridas/${n}" "${T}/estado/corridas-buzon/${n}" && IGUALES=$((IGUALES+1))
done
[ "${IGUALES}" = "4" ] && ok "T10 los 4 blobs (dos máquinas, dos páginas de listado) quedaron en <buzon>/<maquina>/, idénticos" || mal "T10 sólo ${IGUALES} de 4 bajaron idénticos"
[ "$(campo "${T}" bajados)" = "4" ] && ok "T10 el resumen dice 4 bajados" || mal "T10 bajados=$(campo "${T}" bajados)"
grep -q -- '--resource https://storage.azure.com/' "${T}/az.log" && grep -q -- '--tenant 11111111-2222-3333-4444-555555555555' "${T}/az.log" && ok "T10 el token se pide para storage y con el tenant del buzón" || mal "T10 az se llamó con: $(cat "${T}/az.log")"
ANTES=$(gets "${T}/b")
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 0 ] && [ "$(gets "${T}/b")" = "${ANTES}" ] && [ "$(campo "${T}" bajados)" = "0" ] && ok "T10 la segunda pasada no baja nada (0 GET de blobs)" || mal "T10 segunda pasada rc=${RC}, GETs ${ANTES}→$(gets "${T}/b"), bajados=$(campo "${T}" bajados)"
# cambió el contenido con el MISMO tamaño (el hilo se reescribió): se detecta por Content-MD5
head -c 4000 /dev/urandom > "${T}/b/blobs/corridas/equipo-deva/2.1-2026-09-01T1000.hilo.jsonl.gz"
blob "${T}/b" "equipo-deva/2.2-2026-09-03T0900.json" 700
bajar "${T}" "${T}/bin/az"
[ "$(campo "${T}" bajados)" = "2" ] && cmp -s "${T}/b/blobs/corridas/equipo-deva/2.1-2026-09-01T1000.hilo.jsonl.gz" "${T}/estado/corridas-buzon/equipo-deva/2.1-2026-09-01T1000.hilo.jsonl.gz" && ok "T10 baja lo nuevo y lo cambiado con el mismo tamaño (2), y nada más" || mal "T10 cambio de contenido: bajados=$(campo "${T}" bajados)"
# sin Content-MD5 en el listado: el cambio se detecta por la Etag recordada
echo 1 > "${T}/b/sin-md5"
bajar "${T}" "${T}/bin/az"
PRIMERO=$(campo "${T}" bajados)
head -c 900 /dev/urandom > "${T}/b/blobs/corridas/devb-mbp/3.1-2026-09-02T1100.json"
bajar "${T}" "${T}/bin/az"
[ "$(campo "${T}" bajados)" = "1" ] && cmp -s "${T}/b/blobs/corridas/devb-mbp/3.1-2026-09-02T1100.json" "${T}/estado/corridas-buzon/devb-mbp/3.1-2026-09-02T1100.json" && ok "T10 sin Content-MD5, el cambio se detecta por la Etag (1 bajado; la pasada anterior bajó ${PRIMERO})" || mal "T10 sin md5: bajados=$(campo "${T}" bajados) (anterior ${PRIMERO})"
rm -f "${T}/b/sin-md5"
# nombres que no son <maquina>/<archivo de corrida> no se bajan (y nada sale de la carpeta)
blob "${T}/b" "suelto-en-la-raiz.json" 100
blob "${T}/b" "Mac Con Espacios/4.1-2026-09-04T0800.json" 100
blob "${T}/b" "equipo-deva/pagina.html" 100
blob "${T}/b" "equipo-deva/sub/5.1-2026-09-05T0700.json" 100
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" ignorados)" = "4" ] && ok "T10 cuatro nombres sin forma de <maquina>/<ejecución> se cuentan como ignorados" || mal "T10 ignorados=$(campo "${T}" ignorados) rc=${RC}"
[ ! -e "${T}/estado/corridas-buzon/suelto-en-la-raiz.json" ] && [ ! -e "${T}/estado/corridas-buzon/equipo-deva/pagina.html" ] && [ ! -d "${T}/estado/corridas-buzon/Mac Con Espacios" ] && [ ! -d "${T}/estado/corridas-buzon/equipo-deva/sub" ] && ok "T10 y ninguno se escribió" || mal "T10 se escribió algún nombre sin forma"
[ -z "$(find "${T}/estado" -name '*.tmp-*' 2>/dev/null)" ] && ok "T10 no quedaron temporales" || mal "T10 quedaron temporales"

# ── T3 · los registros de frenos y escapes bajan a <buzon>/<maquina>/registros/ ─────
# 🔴 Falla con: aceptar sólo <maquina>/<corrida> → el reductor nunca ve a las otras máquinas; o aceptar
#    cualquier subcarpeta → «equipo-deva/sub/…» (caso T10) se escribe.
T="${BASE}/t3-25"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "devb-mbp/registros/gates.log.gz" 300
blob "${T}/b" "devb-mbp/registros/bypass.log.gz" 200
blob "${T}/b" "devb-mbp/registros/frenos.jsonl.gz" 250
blob "${T}/b" "devb-mbp/registros/cobertura.json" 100
blob "${T}/b" "devb-mbp/registros/otro.txt" 50
blob "${T}/b" "devb-mbp/registros/sub/gates.log.gz" 50
blob "${T}/b" "devb-mbp/agregados/2026-09-14.jsonl" 50
blob "${T}/b" "devb-mbp/3.1-2026-09-02T1100.json" 900
bajar "${T}" "${T}/bin/az"
IGUALES=0
for n in gates.log.gz bypass.log.gz frenos.jsonl.gz cobertura.json; do cmp -s "${T}/b/blobs/corridas/devb-mbp/registros/${n}" "${T}/estado/corridas-buzon/devb-mbp/registros/${n}" && IGUALES=$((IGUALES+1)); done
[ "${RC}" -eq 0 ] && [ "${IGUALES}" = "4" ] && ok "2.5-T3 + 2.6-T11 los TRES registros y la cobertura bajaron a devb-mbp/registros/, idénticos" || mal "2.5-T3 + 2.6-T11 rc=${RC}, ${IGUALES} de 4: $(ls -R "${T}/estado/corridas-buzon" 2>&1 | head -8)"
[ "$(campo "${T}" ignorados)" = "3" ] && [ ! -e "${T}/estado/corridas-buzon/devb-mbp/registros/otro.txt" ] && [ ! -d "${T}/estado/corridas-buzon/devb-mbp/registros/sub" ] && [ ! -d "${T}/estado/corridas-buzon/devb-mbp/agregados" ] \
  && ok "2.5-T3 lo que no tiene forma de registro (otro archivo, otra subcarpeta, agregados) se ignora y no se escribe" || mal "2.5-T3 ignorados=$(campo "${T}" ignorados)"
python3 - "${RAIZ}/scripts/nightly/dashboard/runs.js" "${T}/estado/corridas-buzon" <<'PY' && ok "2.5-T3 la vista de ejecuciones cuenta lo mismo con y sin la carpeta de registros" || mal "2.5-T3 la vista de ejecuciones cambió con los registros bajados"
import json, subprocess, sys, shutil, os
js = "const c=require(process.argv[1]); const r=c.leerRegistro(process.argv[2]+'/../vacio', [], {buzon: process.argv[2]}); console.log(JSON.stringify({n:r.corridas.length, ile:r.ilegibles, arch:r.archivos, sin:r.corridas.filter(x=>!x.maquina).length, b:r.buzon}))"
leer = lambda: json.loads(subprocess.check_output(['node', '-e', js, sys.argv[1], sys.argv[2]]).decode())
con = leer()
reg = os.path.join(sys.argv[2], 'devb-mbp', 'registros')
shutil.move(reg, reg + '.aparte')
sin = leer()
shutil.move(reg + '.aparte', reg)
assert con == sin and con['arch'] == 1, (con, sin)
PY

# ── T3b · los registros bajan PRIMERO y la cobertura después de sus registros; si uno no llega, la
# cobertura no se escribe (quedaría apuntando a un registro viejo).
# 🔴 Falla con: bajar en el orden del listado → bypass, cobertura, gates: un corte o un blob que llega
#    distinto deja la cobertura nueva junto al gates.log.gz viejo, y los registros esperan detrás de las corridas.
T="${BASE}/t3b-25"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
for i in 1 2 3 4 5 6; do blob "${T}/b" "lab-mini/1.${i}-2026-09-01T1000.json" 200; done
blob "${T}/b" "lab-mini/registros/bypass.log.gz" 100; blob "${T}/b" "lab-mini/registros/cobertura.json" 100; blob "${T}/b" "lab-mini/registros/gates.log.gz" 100
echo 250 > "${T}/b/demora"
bajar "${T}" "${T}/bin/az" --budget-ms 900
[ -f "${T}/estado/corridas-buzon/lab-mini/registros/bypass.log.gz" ] && [ -f "${T}/estado/corridas-buzon/lab-mini/registros/gates.log.gz" ] && [ -f "${T}/estado/corridas-buzon/lab-mini/registros/cobertura.json" ] \
  && ok "2.5-T3b con presupuesto chico y 6 ejecuciones, los tres archivos de registros bajaron primero" || mal "2.5-T3b rc=${RC} sin_tiempo=$(campo "${T}" sin_tiempo): $(ls -R "${T}/estado/corridas-buzon" 2>&1 | head -6)"
T="${BASE}/t3c-25"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "lab-mini/registros/bypass.log.gz" 100; blob "${T}/b" "lab-mini/registros/cobertura.json" 100; blob "${T}/b" "lab-mini/registros/gates.log.gz" 100
echo "lab-mini/registros/gates.log.gz" > "${T}/b/corromper"
bajar "${T}" "${T}/bin/az"
[ -f "${T}/estado/corridas-buzon/lab-mini/registros/bypass.log.gz" ] && [ ! -e "${T}/estado/corridas-buzon/lab-mini/registros/gates.log.gz" ] && [ ! -e "${T}/estado/corridas-buzon/lab-mini/registros/cobertura.json" ] && [ "${RC}" -eq 1 ] \
  && ok "2.5-T3c gates.log.gz llega distinto → no se escribe, y la cobertura de esa máquina queda retenida (sale 1)" || mal "2.5-T3c rc=${RC}: $(ls "${T}/estado/corridas-buzon/lab-mini/registros" 2>&1)"

# ── T10b · los estados de error de la bajada sin caso propio ──────────
# 🔴 Falla con: que sin_contenedor, servicio_fallo, sin_red, sin_permiso_a_mitad, parcial y sin_tiempo
#    queden sin un caso que los ejerza, o un fallo después de bajar algo diga bajado=true.
T="${BASE}/t10b"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.json" 800; blob "${T}/b" "equipo-deva/2.2-2026-09-02T1000.json" 900
for CODIGO in 404 500; do
  echo "${CODIGO}" > "${T}/b/modo-lista"; bajar "${T}" "${T}/bin/az"
  ESPERADO=$([ "${CODIGO}" = 404 ] && echo sin_contenedor || echo servicio_fallo)
  [ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "${ESPERADO}" ] && [ ! -e "${T}/estado/corridas-buzon" ] && ok "T10b listar ${CODIGO} → exit 1, ${ESPERADO}, sin carpeta" || mal "T10b listar ${CODIGO} → rc=${RC} estado=$(campo "${T}" estado)"
done
rm -f "${T}/b/modo-lista"
echo 403 > "${T}/b/modo-get"; bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "sin_permiso_a_mitad" ] && [ "$(campo "${T}" bajado)" = "false" ] && ok "T10b lista pero no lee → exit 1, sin_permiso_a_mitad, bajado=false" || mal "T10b 403 al leer → rc=${RC} estado=$(campo "${T}" estado) bajado=$(campo "${T}" bajado)"
rm -f "${T}/b/modo-get"
echo "equipo-deva/2.2-2026-09-02T1000.json" > "${T}/b/corromper"; bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "parcial" ] && [ "$(campo "${T}" bajado)" = "false" ] && [ "$(campo "${T}" bajados)" = "1" ] && ok "T10b un blob que llega distinto al listado → parcial, exit 1, bajado=false, el otro sí bajó" || mal "T10b corrupto → rc=${RC} estado=$(campo "${T}" estado) bajado=$(campo "${T}" bajado) bajados=$(campo "${T}" bajados)"
[ ! -e "${T}/estado/corridas-buzon/equipo-deva/2.2-2026-09-02T1000.json" ] && [ -z "$(find "${T}/estado" -name '*.tmp-*' 2>/dev/null)" ] && ok "T10b el que llegó distinto no se escribió ni dejó temporal" || mal "T10b el corrupto quedó en disco"
rm -f "${T}/b/corromper"
T="${BASE}/t10c"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token; echo 60 > "${T}/b/demora"
# 80 blobs (no 20): se bajan 8 a la vez, y 20 de 60 ms entrarían enteros en el tope
i=0; while [ "${i}" -lt 80 ]; do blob "${T}/b" "maq-z/7.$(printf %02d ${i})-2026-09-07T0500.json" 200; i=$((i+1)); done
bajar "${T}" "${T}/bin/az" --budget-ms 200
BJ=$(campo "${T}" bajados); ST=$(campo "${T}" sin_tiempo)
[ "${RC}" -eq 0 ] && [ "${ST}" -gt 0 ] 2>/dev/null && [ "$((BJ + ST))" = "80" ] && ok "T10c tope chico: bajados ${BJ} + sin_tiempo ${ST} = 80" || mal "T10c rc=${RC} bajados=${BJ} sin_tiempo=${ST}"
T="${BASE}/t10d"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
for p in ${PIDS}; do :; done; kill "${p}" 2>/dev/null; sleep 0.2
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "sin_red" ] && [ ! -e "${T}/estado/corridas-buzon" ] && ok "T10d puerto cerrado → exit 1, sin_red, sin carpeta" || mal "T10d sin red → rc=${RC} estado=$(campo "${T}" estado)"
# los nombres que no se bajan se NOMBRAN, no sólo se cuentan
T="${BASE}/t10e"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "Mac Rara/1.1-2026-09-01T1000.json" 50; blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.json" 50
# y un nombre con una secuencia de terminal (ESC) no llega crudo ni al registro ni al JSON
# 🔴 Falla con: los nombres los elige cualquiera con la llave de escritura; si salen crudos, pintan o borran la terminal de quien baja.
blob "${T}/b" "$(printf 'trampa\033[2J')/x.json" 50
bajar "${T}" "${T}/bin/az"
! grep -q "$(printf '\033')" "${T}/err.txt" && ! grep -q "$(printf '\033')" "${T}/out.json" && grep -q 'trampa\\u001b\[2J' "${T}/err.txt" && ok "T10e un nombre con ESC se escapa (\\u001b) en el registro y en el JSON" || mal "T10e el ESC llegó crudo: $(cat -v "${T}/err.txt" | head -2)"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['ignorados']==2 and 'Mac Rara/1.1-2026-09-01T1000.json' in d['ignorados_nombres'], d" "${T}/out.json" 2>/dev/null && grep -q 'Mac Rara/1.1-2026-09-01T1000.json' "${T}/err.txt" && ok "T10e el blob sin forma se nombra en el resumen y en el registro" || mal "T10e el ignorado no se nombra: $(cat "${T}/err.txt" | head -2)"

# ── T10f · la carpeta local no se puede mirar o no se puede escribir: se cuenta, nunca «bajado» ──
# 🔴 Falla con: que las ramas `no_leidos` (stat local con EACCES) y `malos` por escritura fallida queden sin caso.
T="${BASE}/t10f"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "maq-f/1.1-2026-09-01T1000.json" 300
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" bajados)" = "1" ] || mal "T10f preparación: la primera bajada no bajó (rc=${RC})"
head -c 300 /dev/urandom > "${T}/b/blobs/corridas/maq-f/1.1-2026-09-01T1000.json"   # cambió en el buzón
chmod 000 "${T}/estado/corridas-buzon/maq-f"
bajar "${T}" "${T}/bin/az"; chmod 755 "${T}/estado/corridas-buzon/maq-f"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "parcial" ] && [ "$(campo "${T}" bajado)" = "false" ] && python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert any('1.1-2026-09-01T1000.json' in x for x in d.get('no_leidos',[])), d" "${T}/out.json" 2>/dev/null && ok "T10f carpeta local que no se puede mirar → parcial, exit 1, nombrada en no_leidos" || mal "T10f sin permiso para mirar → rc=${RC} estado=$(campo "${T}" estado) no_leidos=$(campo "${T}" no_leidos)"
blob "${T}/b" "maq-f/1.2-2026-09-02T1000.json" 300
chmod 555 "${T}/estado/corridas-buzon/maq-f"
bajar "${T}" "${T}/bin/az"; chmod 755 "${T}/estado/corridas-buzon/maq-f"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "parcial" ] && [ "$(campo "${T}" bajado)" = "false" ] && python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert any('1.2-2026-09-02T1000.json' in x and 'escribir' in x for x in d.get('no_bajados',[])), d" "${T}/out.json" 2>/dev/null && ok "T10f carpeta local de sólo lectura → parcial, exit 1, nombrado en no_bajados con «no se pudo escribir»" || mal "T10f sólo lectura → rc=${RC} estado=$(campo "${T}" estado) no_bajados=$(campo "${T}" no_bajados)"
[ -z "$(find "${T}/estado" -name '*.tmp-*' 2>/dev/null)" ] && ok "T10f no quedaron temporales" || mal "T10f quedaron temporales"

# ── T11 · sin permiso no deja rastro: sin az, sin sesión, 403 → exit 0, sin carpeta, aviso diario ─
# 🔴 Falla con: un login en la máquina de otro miembro del equipo, o una carpeta vacía que se lee como
#    «bajé y no había nada».
for MODO in missing no-session 403; do
  T="${BASE}/t11-${MODO}"; buzon "${T}/b"; config "${T}/cfg.json"; blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.json"
  case "${MODO}" in
    missing)    AZ="${T}/bin/no-hay-az" ;;
    no-session) az_doble "${T}" no-session; AZ="${T}/bin/az" ;;
    403)        az_doble "${T}" bad-token; AZ="${T}/bin/az" ;;
  esac
  bajar "${T}" "${AZ}"
  [ "${RC}" -eq 0 ] && ok "T11 ${MODO} → exit 0" || mal "T11 ${MODO} → rc=${RC}: $(head -2 "${T}/err.txt")"
  [ ! -e "${T}/estado/corridas-buzon" ] && ok "T11 ${MODO} → no crea la carpeta" || mal "T11 ${MODO} → creó la carpeta"
  [ "$(campo "${T}" bajado)" = "false" ] && [ -n "$(campo "${T}" motivo)" ] && [ "$(campo "${T}" motivo)" != "null" ] && ok "T11 ${MODO} → bajado=false con motivo ($(campo "${T}" estado))" || mal "T11 ${MODO} → bajado=$(campo "${T}" bajado) motivo=$(campo "${T}" motivo)"
  [ "$(campo "${T}" aviso)" = "emitido" ] && [ -s "${T}/err.txt" ] && ok "T11 ${MODO} → lo anota (emitido)" || mal "T11 ${MODO} → aviso=$(campo "${T}" aviso)"
  bajar "${T}" "${AZ}"
  [ "${RC}" -eq 0 ] && [ "$(campo "${T}" aviso)" = "ya_emitido_hoy" ] && ok "T11 ${MODO} → la segunda vez del día no lo repite" || mal "T11 ${MODO} → segunda vez: rc=${RC} aviso=$(campo "${T}" aviso)"
done
grep -q "'login'" "${BAJAR}" && mal "T11 el script invoca az login" || ok "T11 el script nunca invoca «az login»"
T="${BASE}/t11-stdin"; buzon "${T}/b"; config "${T}/cfg.json"; mkdir -p "${T}/bin"
printf '#!/bin/sh\nif [ -t 0 ]; then echo tty >> "%s/stdin.log"; else read -r x && echo "leyo:$x" >> "%s/stdin.log"; fi\necho token-bueno\n' "${T}" "${T}" > "${T}/bin/az"; chmod +x "${T}/bin/az"
blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.json"
( echo "no-deberia-leerse" | TYCON_MAILBOX_JSON="${T}/cfg.json" TYCON_MAILBOX_URL_BASE="${URL_BUZON}" TYCON_AZ_BIN="${T}/bin/az" TYCON_MAILBOX_DIR="${T}/estado/corridas-buzon" node "${BAJAR}" --json > "${T}/out.json" 2>&1 )
! grep -q 'leyo:no-deberia-leerse\|tty' "${T}/stdin.log" 2>/dev/null && ok "T11 az corre sin entrada: no hereda la terminal ni lo que venga por stdin (nunca puede preguntar)" || mal "T11 az leyó la entrada: $(cat "${T}/stdin.log")"

# ── T9 · el instalador: barrido → subida → bajada, cada llave apaga sólo lo suyo ────────
# Se extrae del instalador REAL el bloque «Rescate del hilo…» (hasta el siguiente bloque) y se corre con
# SCRIPT_DIR en un temporal donde tres dobles anotan el orden en que los llaman. Correr el instalador
# entero en un temporal arrastra decenas de dependencias ajenas a este caso.
# 🔴 Falla con: bajar antes de subir → la página propia sale sin lo de hoy; sin la bajada en el bloque,
#    quienes leen el buzón nunca ven lo del resto del equipo.
T="${BASE}/t9"; mkdir -p "${T}/scripts/metrics" "${T}/home"
python3 - "${RAIZ}/scripts/install-tycon-hooks.sh" "${T}/bloque.sh" <<'PY2'
import sys
s = open(sys.argv[1], encoding='utf8').read()
i = s.index('# Rescate del hilo y el consumo de las ejecuciones del pipeline')
i = s.rfind('# ====', 0, i)
j = s.index('# Hook de git PRE-COMMIT global', i)
j = s.rfind('# ====', 0, j)
open(sys.argv[2], 'w', encoding='utf8').write(s[i:j])
PY2
printf "setTimeout(() => require('fs').appendFileSync(process.env.ORDER_LOG, 'barrido\\\\n'), 500);\n" > "${T}/scripts/metrics/tokens-digest.js"
printf "setTimeout(() => require('fs').appendFileSync(process.env.ORDER_LOG, 'subida ' + process.argv.slice(2).join(' ') + '\\\\n'), 300);\n" > "${T}/scripts/metrics/upload-runs.js"
printf "require('fs').appendFileSync(process.env.ORDER_LOG, 'bajada ' + process.argv.slice(2).join(' ') + '\\\\n');\n" > "${T}/scripts/metrics/download-runs.js"
mkdir -p "${T}/bin"; printf '#!/bin/sh\necho "$@" >> "%s/git.log"\nexit 0\n' "${T}" > "${T}/bin/git"; chmod +x "${T}/bin/git"
# Las llaves de cada paso del bloque se sacan del ambiente heredado: el corredor de suites apaga el buzón para toda suite
# (TYCON_NO_UPLOAD_RUNS=1, entre otras), y estos casos prueban el bloque con cada llave puesta a propósito. El interruptor
# del buzón queda en el TYCON_MAILBOX=1 que esta suite fija arriba.
SIN_LLAVES=(-u TF_BUILD -u TYCON_NO_UPLOAD_RUNS -u TYCON_NO_DOWNLOAD_RUNS -u TYCON_NO_THREAD_RESCUE -u TYCON_NO_COLLECT_FINDINGS -u TYCON_MAILBOX_JSON)
instalar9() {  # <líneas esperadas> <VAR=valor>...
  local esperadas="$1"; shift
  : > "${T}/orden.txt"; rm -rf "${T}/home/.claude"
  # TYCON_INTEG_MAILBOX=1: el bloque extraído lee la llave del buzón que el instalador resuelve más arriba; acá es un
  # dato de entrada, y el caso de abajo la apaga para probar que apaga sólo lo suyo.
  env "${SIN_LLAVES[@]}" HOME="${T}/home" PATH="${T}/bin:${PATH}" ORDER_LOG="${T}/orden.txt" SCRIPT_DIR="${T}/scripts" CHECK_ONLY=0 TYCON_INTEG_MAILBOX=1 PROFILE_FULL=1 "$@" \
    bash -c 'source "$1"' _ "${T}/bloque.sh" > "${T}/inst.log" 2>&1
  local n=0; while [ "${n}" -lt 40 ]; do [ "$(wc -l < "${T}/orden.txt" | tr -d ' ')" -ge "${esperadas}" ] && break; sleep 0.25; n=$((n+1)); done
  sleep 1   # por si aparece algo que no debía
}
instalar9 3 TYCON_X=0
ORDER_LOG="$(tr '\n' '|' < "${T}/orden.txt")"
echo "${ORDER_LOG}" | grep -E '^barrido\|subida [^|]*\|bajada [^|]*\|$' >/dev/null && ok "T9 el instalador lanza barrido → subida → bajada, en ese orden" || mal "T9 orden anotado: ${ORDER_LOG} $(head -3 "${T}/inst.log")"
[ -f "${T}/home/.claude/.tycon-pipeline/upload-runs.log" ] && [ -f "${T}/home/.claude/.tycon-pipeline/download-runs.log" ] && ok "T9 subida y bajada dejan su registro (upload-runs.log, download-runs.log)" || mal "T9 falta algún registro: $(ls "${T}/home/.claude/.tycon-pipeline" 2>&1)"
instalar9 2 TYCON_NO_DOWNLOAD_RUNS=1
grep -q bajada "${T}/orden.txt" && mal "T9 con TYCON_NO_DOWNLOAD_RUNS=1 igual bajó" || ok "T9 TYCON_NO_DOWNLOAD_RUNS=1 apaga la bajada"
grep -q barrido "${T}/orden.txt" && grep -q subida "${T}/orden.txt" && ok "T9 y deja el barrido y la subida" || mal "T9 la llave de la bajada apagó otra cosa: $(tr '\n' '|' < "${T}/orden.txt")"
instalar9 2 TYCON_NO_UPLOAD_RUNS=1
! grep -q subida "${T}/orden.txt" && grep -q barrido "${T}/orden.txt" && grep -q bajada "${T}/orden.txt" && ok "T9 TYCON_NO_UPLOAD_RUNS=1 apaga sólo la subida" || mal "T9 sin subida: $(tr '\n' '|' < "${T}/orden.txt")"
instalar9 2 TYCON_NO_THREAD_RESCUE=1
! grep -q barrido "${T}/orden.txt" && grep -q subida "${T}/orden.txt" && grep -q bajada "${T}/orden.txt" && ok "T9 TYCON_NO_THREAD_RESCUE=1 apaga sólo el barrido" || mal "T9 sin barrido: $(tr '\n' '|' < "${T}/orden.txt")"
# Con la integración «buzón» apagada no se lanza ni la subida ni la bajada; el barrido (local) sigue
instalar9 1 TYCON_INTEG_MAILBOX=0
! grep -q subida "${T}/orden.txt" && ! grep -q bajada "${T}/orden.txt" && grep -q barrido "${T}/orden.txt" && ok "T9 (8.3) buzón apagado: ni subida ni bajada, el barrido sigue" || mal "T9 buzón apagado: $(tr '\n' '|' < "${T}/orden.txt")"
instalar9 0 CHECK_ONLY=1
[ ! -s "${T}/orden.txt" ] && ok "T9 con --check no lanza nada" || mal "T9 con --check lanzó: $(tr '\n' '|' < "${T}/orden.txt")"

# ── T9b · la recolección de hallazgos va ENTRE el barrido y la subida ────────────────────
# 🔴 Falla con: sin el paso en el bloque, nadie corre el recolector, `hallazgos.jsonl` no existe en
#    ninguna máquina y la subida declara la fuente «no_medido» para siempre, en verde. Y si fuera DESPUÉS de la
#    subida, lo recolectado hoy subiría recién mañana.
printf "setTimeout(() => require('fs').appendFileSync(process.env.ORDER_LOG, 'recoleccion ' + process.argv.slice(2).join(' ') + '\\\\n'), 200);\n" > "${T}/scripts/metrics/collect-findings.js"
instalar9 4 TYCON_X=0
ORDER_LOG="$(tr '\n' '|' < "${T}/orden.txt")"
echo "${ORDER_LOG}" | grep -E '^barrido\|recoleccion [^|]*\|subida [^|]*\|bajada [^|]*\|$' >/dev/null \
  && ok "T9b el instalador lanza barrido → recolección → subida → bajada" \
  || mal "T9b orden anotado: ${ORDER_LOG} — rojo previo: sin el paso, los hallazgos no viajan nunca"
[ -f "${T}/home/.claude/.tycon-pipeline/collect-findings.log" ] \
  && ok "T9b la recolección deja su registro (collect-findings.log)" \
  || mal "T9b falta collect-findings.log: $(ls "${T}/home/.claude/.tycon-pipeline" 2>&1)"
instalar9 3 TYCON_NO_COLLECT_FINDINGS=1
! grep -q recoleccion "${T}/orden.txt" && grep -q barrido "${T}/orden.txt" && grep -q subida "${T}/orden.txt" && grep -q bajada "${T}/orden.txt" \
  && ok "T9b TYCON_NO_COLLECT_FINDINGS=1 apaga sólo la recolección" \
  || mal "T9b sin recolección: $(tr '\n' '|' < "${T}/orden.txt")"
instalar9 2 TYCON_NO_UPLOAD_RUNS=1
! grep -q subida "${T}/orden.txt" && grep -q recoleccion "${T}/orden.txt" \
  && ok "T9b apagar la subida no apaga la recolección (sirve igual para el cruce de esta máquina)" \
  || mal "T9b la llave de la subida apagó la recolección: $(tr '\n' '|' < "${T}/orden.txt")"
rm -f "${T}/scripts/metrics/collect-findings.js"   # los casos que siguen miden el bloque sin este paso

# ── T14 · InstaladorEnCi_NoLanzaLaTanda · dentro de una corrida de Azure la tanda de fondo NO se lanza ───────────
# Los casos de arriba corren el bloque con `env -u TF_BUILD`: el banco nocturno corre con TF_BUILD=True y la guarda
# los pondría en rojo. Éste lo pone a propósito.
# 🔴 Falla con: sin la guarda, el banco nocturno lanza barrido → recolección → subida → bajada con el HOME del
#    agente, y la carpeta de la máquina efímera del agente llega al buzón del equipo.
printf "setTimeout(() => require('fs').appendFileSync(process.env.ORDER_LOG, 'recoleccion\\\\n'), 200);\n" > "${T}/scripts/metrics/collect-findings.js"
: > "${T}/orden.txt"; rm -rf "${T}/home/.claude"
env HOME="${T}/home" PATH="${T}/bin:${PATH}" ORDER_LOG="${T}/orden.txt" SCRIPT_DIR="${T}/scripts" CHECK_ONLY=0 PROFILE_FULL=1 TF_BUILD=True bash -c 'source "$1"' _ "${T}/bloque.sh" > "${T}/inst.log" 2>&1
sleep 2
[ ! -s "${T}/orden.txt" ] && [ ! -e "${T}/home/.claude/.tycon-pipeline/upload-runs.log" ] && grep -q 'ejecución de Azure DevOps' "${T}/inst.log" \
  && ok "2.12-T14 InstaladorEnCi_NoLanzaLaTanda: con TF_BUILD=True el bloque no lanza barrido, recolección, subida ni bajada, y lo dice por stderr" \
  || mal "2.12-T14 InstaladorEnCi_NoLanzaLaTanda con TF_BUILD=True se lanzó: $(tr '\n' '|' < "${T}/orden.txt") · salida: $(head -c 200 "${T}/inst.log")"
: > "${T}/orden.txt"; rm -rf "${T}/home/.claude"
env HOME="${T}/home" PATH="${T}/bin:${PATH}" ORDER_LOG="${T}/orden.txt" SCRIPT_DIR="${T}/scripts" CHECK_ONLY=0 PROFILE_FULL=1 TF_BUILD=true bash -c 'source "$1"' _ "${T}/bloque.sh" > "${T}/inst.log" 2>&1
sleep 2
[ ! -s "${T}/orden.txt" ] && ok "2.12-T14 también con TF_BUILD=true en minúsculas" || mal "2.12-T14 con TF_BUILD=true se lanzó: $(tr '\n' '|' < "${T}/orden.txt")"
rm -f "${T}/scripts/metrics/collect-findings.js"

# (usa T7D, no T: los casos siguientes del instalador siguen usando ${T})
# ── T7 · los hallazgos bajan con el mismo rango y la misma retención que los registros ─
# 🔴 Falla con: que la guarda de la bajada reconozca sólo «.log.gz »: una falla de
#    hallazgos.jsonl.gz no retiene la cobertura.
T7D="${BASE}/t7-29"; buzon "${T7D}/b"; config "${T7D}/cfg.json"; az_doble "${T7D}" token
for i in 1 2 3; do blob "${T7D}/b" "lab-mini/2.${i}-2026-09-0${i}T1000.json" 100; done
blob "${T7D}/b" "lab-mini/registros/bypass.log.gz" 100; blob "${T7D}/b" "lab-mini/registros/gates.log.gz" 100
blob "${T7D}/b" "lab-mini/registros/hallazgos.jsonl.gz" 100; blob "${T7D}/b" "lab-mini/registros/cobertura.json" 100
blob "${T7D}/b" "lab-mini/hallazgos/otra-carpeta.jsonl.gz" 100
echo 250 > "${T7D}/b/demora"
bajar "${T7D}" "${T7D}/bin/az" --budget-ms 1300
H="${T7D}/estado/corridas-buzon/lab-mini/registros/hallazgos.jsonl.gz"
[ -f "${H}" ] && [ -f "${T7D}/estado/corridas-buzon/lab-mini/registros/cobertura.json" ] \
  && ok "T7 hallazgos.jsonl.gz baja con los registros, antes que las ejecuciones (presupuesto chico)" \
  || mal "T7 hallazgos no bajó primero (rc=${RC}): $(ls -R "${T7D}/estado/corridas-buzon" 2>&1 | head -8)"
[ ! -e "${T7D}/estado/corridas-buzon/lab-mini/hallazgos" ] && ok "T7 una carpeta hermana <maq>/hallazgos/ se ignora" \
  || mal "T7 se bajó una carpeta hermana de hallazgos — la forma válida es <maq>/registros/"
T7D="${BASE}/t7b-29"; buzon "${T7D}/b"; config "${T7D}/cfg.json"; az_doble "${T7D}" token
blob "${T7D}/b" "lab-mini/registros/gates.log.gz" 100; blob "${T7D}/b" "lab-mini/registros/hallazgos.jsonl.gz" 100; blob "${T7D}/b" "lab-mini/registros/cobertura.json" 100
echo "lab-mini/registros/hallazgos.jsonl.gz" > "${T7D}/b/corromper"
bajar "${T7D}" "${T7D}/bin/az"
[ ! -e "${T7D}/estado/corridas-buzon/lab-mini/registros/hallazgos.jsonl.gz" ] && [ ! -e "${T7D}/estado/corridas-buzon/lab-mini/registros/cobertura.json" ] && [ "${RC}" -eq 1 ] \
  && ok "T7 hallazgos.jsonl.gz llega distinto → no se escribe y la cobertura de esa máquina queda retenida" \
  || mal "T7 retención de hallazgos (rc=${RC}): $(ls "${T7D}/estado/corridas-buzon/lab-mini/registros" 2>&1)"
# la guarda previa a la cola reconoce los registros por la lista de la subida (una expresión escrita a
# mano no ve el guion de legacy-names.jsonl.gz); los casos de «retención por registro» del final la prueban corriendo, con .jsonl.gz incluido
grep -q 'const esFallaDeRegistro = (x) => REGISTROS.some(' "${RAIZ}/scripts/metrics/download-runs.js" \
  && ok "T7 la guarda previa a la cola reconoce los registros por REGISTROS de la subida (también .jsonl.gz)" \
  || mal "T7 la guarda previa de la bajada no sale de REGISTROS"


# el registro de cada arranque se AGREGA, no pisa al anterior
# 🔴 Falla con: con `>` la segunda sesión del día borra el aviso de vencimiento, que sale una vez por día.
mkdir -p "${T}/home/.claude/.tycon-pipeline"; : > "${T}/orden.txt"
echo "LINEA-DE-LA-SESION-ANTERIOR" > "${T}/home/.claude/.tycon-pipeline/upload-runs.log"
echo "LINEA-DE-LA-SESION-ANTERIOR" > "${T}/home/.claude/.tycon-pipeline/download-runs.log"
env "${SIN_LLAVES[@]}" HOME="${T}/home" PATH="${T}/bin:${PATH}" ORDER_LOG="${T}/orden.txt" SCRIPT_DIR="${T}/scripts" CHECK_ONLY=0 TYCON_INTEG_MAILBOX=1 TYCON_X=0 bash -c 'source "$1"' _ "${T}/bloque.sh" > "${T}/inst.log" 2>&1
# Sin PROFILE_FULL el bloque lanza la subida y la bajada, no el barrido: son DOS líneas. Esperar tres agota los 10 s del
# tope en cada una de estas dos corridas.
n=0; while [ "${n}" -lt 40 ]; do [ "$(wc -l < "${T}/orden.txt" | tr -d ' ')" -ge 2 ] && break; sleep 0.25; n=$((n+1)); done; sleep 1
grep -q 'LINEA-DE-LA-SESION-ANTERIOR' "${T}/home/.claude/.tycon-pipeline/upload-runs.log" && grep -q 'LINEA-DE-LA-SESION-ANTERIOR' "${T}/home/.claude/.tycon-pipeline/download-runs.log" && ok "T9 el registro de subida y de bajada conserva lo de la sesión anterior (se agrega)" || mal "T9 el arranque pisó el registro anterior"

# pasado el tope (~512 KB) el registro viejo se mueve a .1 y el nuevo arranca de cero
# 🔴 Falla con: sin rotación, un registro que se agrega crece para siempre.
: > "${T}/orden.txt"; head -c 600000 /dev/zero | tr '\0' 'x' > "${T}/home/.claude/.tycon-pipeline/upload-runs.log"
env "${SIN_LLAVES[@]}" HOME="${T}/home" PATH="${T}/bin:${PATH}" ORDER_LOG="${T}/orden.txt" SCRIPT_DIR="${T}/scripts" CHECK_ONLY=0 TYCON_INTEG_MAILBOX=1 TYCON_X=0 bash -c 'source "$1"' _ "${T}/bloque.sh" > "${T}/inst.log" 2>&1
n=0; while [ "${n}" -lt 40 ]; do [ "$(wc -l < "${T}/orden.txt" | tr -d ' ')" -ge 2 ] && break; sleep 0.25; n=$((n+1)); done; sleep 1
[ "$(wc -c < "${T}/home/.claude/.tycon-pipeline/upload-runs.log.1" 2>/dev/null | tr -d ' ')" = "600000" ] && [ "$(wc -c < "${T}/home/.claude/.tycon-pipeline/upload-runs.log" | tr -d ' ')" -lt 1000 ] && ok "T9 registro de más de 512 KB → pasa a .1 entero y el nuevo arranca chico" || mal "T9 rotación: .1=$(wc -c < "${T}/home/.claude/.tycon-pipeline/upload-runs.log.1" 2>/dev/null) actual=$(wc -c < "${T}/home/.claude/.tycon-pipeline/upload-runs.log")"

# ── T18 (parte instalador) · el bloque no nombra git ni el repo privado ──────────────────
[ ! -s "${T}/git.log" ] && ok "T18 el bloque del instalador no invoca git" || mal "T18 el bloque invocó git: $(head -2 "${T}/git.log")"
grep -q 'corridas\.json\|corridas-del-arnes\|corridas-remoto' "${T}/bloque.sh" && mal "T18 el bloque del instalador todavía nombra el repo privado git" || ok "T18 el bloque del instalador no nombra corridas.json ni el repo git"
# ── T13 · el cambio de git baja con la MISMA forma con que sube ──────────────
# 🔴 Falla con: la forma no acepta .cambio.json.gz → el blob se cuenta como ignorado y no baja.
T="${BASE}/t219"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "equipo-deva/2.19-2026-09-17T1300.cambio.json.gz" 2500
blob "${T}/b" "equipo-deva/2.19-2026-09-17T1300.cambio.json.gz.99.tmp" 10
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 0 ] && cmp -s "${T}/b/blobs/corridas/equipo-deva/2.19-2026-09-17T1300.cambio.json.gz" "${T}/estado/corridas-buzon/equipo-deva/2.19-2026-09-17T1300.cambio.json.gz" \
  && [ ! -e "${T}/estado/corridas-buzon/equipo-deva/2.19-2026-09-17T1300.cambio.json.gz.99.tmp" ] \
  && ok "2.19-T13 el .cambio.json.gz baja a <buzon>/<maquina>/, idéntico; un nombre que no tiene la forma no baja" \
  || mal "2.19-T13 rc=${RC} bajados=$(campo "${T}" bajados) carpeta: $(ls "${T}/estado/corridas-buzon/equipo-deva" 2>&1)"


# ── T12 · BajarSinHilos_NoBajaConversaciones · --no-threads: el nocturno baja registros y volcados, nunca las conversaciones ──
# 🔴 Falla con: sin la bandera (o ignorándola), el hilo baja — el agente de Azure tiene las conversaciones, con
#    prompts, rutas y código de clientes, para una página que no las usa.
T="${BASE}/t12"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.json" 800
blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.hilo.jsonl.gz" 4000
# El cambio de git tampoco lo usa la página del nocturno y trae código de todos los repos
blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.cambio.json.gz" 2200
mkdir -p "${T}/b/blobs/corridas/equipo-deva/registros"
printf '{"ts":"2026-09-16T10:00:00Z","name":"tests","status":"green"}\n' | gzip -c > "${T}/b/blobs/corridas/equipo-deva/registros/gates.log.gz"
bajar "${T}" "${T}/bin/az" --no-threads
if [ "${RC}" -eq 0 ] && [ -f "${T}/estado/corridas-buzon/equipo-deva/2.1-2026-09-01T1000.json" ] && [ -f "${T}/estado/corridas-buzon/equipo-deva/registros/gates.log.gz" ] \
   && [ ! -e "${T}/estado/corridas-buzon/equipo-deva/2.1-2026-09-01T1000.hilo.jsonl.gz" ] \
   && [ ! -e "${T}/estado/corridas-buzon/equipo-deva/2.1-2026-09-01T1000.cambio.json.gz" ] && [ "$(campo "${T}" omitidos)" = "2" ] \
   && [ "$(campo "${T}" completo)" = "true" ] && [ "$(campo "${T}" codigo)" = "0" ] \
   && ! grep -q 'hilo.jsonl.gz' "${T}/b/pedidos.jsonl" && ! grep -q 'cambio.json.gz' "${T}/b/pedidos.jsonl"; then
  ok "2.12-T12 BajarSinHilos_NoBajaConversaciones: con --no-threads baja el volcado y los registros, ningún GET al hilo ni al cambio de git (2.19), omitidos 2, completo true y codigo 0"
else
  mal "2.12-T12 BajarSinHilos_NoBajaConversaciones rc=${RC} omitidos=$(campo "${T}" omitidos) completo=$(campo "${T}" completo) codigo=$(campo "${T}" codigo) · $(ls -R "${T}/estado" 2>&1 | head -8)"
fi
T="${BASE}/t12b"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.json" 800
blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.hilo.jsonl.gz" 4000
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 0 ] && [ -f "${T}/estado/corridas-buzon/equipo-deva/2.1-2026-09-01T1000.hilo.jsonl.gz" ] && [ "$(campo "${T}" omitidos)" = "0" ] \
  && ok "2.12-T12 sin la bandera el hilo baja, como antes (omitidos 0)" || mal "2.12-T12 sin la bandera: rc=${RC} omitidos=$(campo "${T}" omitidos)"
# una bajada que no terminó no es «completa» aunque salga 0
T="${BASE}/t12c"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.json" 800
echo 400 > "${T}/b/demora"
bajar "${T}" "${T}/bin/az" --no-threads --budget-ms 1
[ "$(campo "${T}" completo)" = "false" ] && [ "$(campo "${T}" sin_tiempo)" != "0" ] \
  && ok "2.12-T12 una bajada que se quedó sin tiempo dice completo false" || mal "2.12-T12 sin tiempo: completo=$(campo "${T}" completo) sin_tiempo=$(campo "${T}" sin_tiempo) rc=${RC}"

# ── Nombres en inglés · el índice y el sello diario con su nombre en inglés; el viejo sigue valiendo ─────────────
# 🔴 Falla con: renombrar el índice sin leer el viejo re-baja todo lo que el listado no trae con MD5, y renombrar el
#    sello sin leer el viejo repite el aviso de «sin permiso» el día del cambio. El nombre viejo sale del mapa.
viejo_d2() {  # <nombre nuevo> → el nombre viejo, según scripts/lib/renames.json
  node -e '
    const m = require(process.argv[1]);
    const e = m.entries.find((x) => x.batch === "D2" && x.kind === "state-file" && x.new.split("/").pop() === process.argv[2]);
    process.stdout.write(e ? e.old.split("/").pop() : "");
  ' "${RAIZ}/scripts/lib/renames.json" "$1"
}
bajar_casa() {  # <caso> <az> [args...] — como bajar, pero con la carpeta por defecto (la HOME de juguete)
  local c="$1" az="$2"; shift 2
  TYCON_MAILBOX_JSON="${c}/cfg.json" TYCON_MAILBOX_URL_BASE="${URL_BUZON}" TYCON_AZ_BIN="${az}" \
    node "${BAJAR}" --json "$@" > "${c}/out.json" 2> "${c}/err.txt" < /dev/null
  RC=$?
}
CASA="${HOME}/.claude/.tycon-pipeline"
# en la copia pública el mapa no viaja: sin nombre viejo no hay migración que mirar (se saltea con motivo)
if [ ! -f "${RAIZ}/scripts/lib/renames.json" ]; then
  ok "8.9-D2 se saltea — copia pública, sin el mapa de renombres"
else
SELLO_VIEJO="$(viejo_d2 download-runs-no-permission.seal)"; INDICE_VIEJO="$(viejo_d2 mailbox-downloads.json)"
[ -n "${SELLO_VIEJO}" ] && [ -n "${INDICE_VIEJO}" ] || mal "8.9-D2 el mapa no tiene las entradas de la bajada (sello=${SELLO_VIEJO} índice=${INDICE_VIEJO})"
T="${BASE}/t-d2-sello"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" no-session
rm -rf "${CASA}"; mkdir -p "${CASA}"
echo "$(date -u +%Y-%m-%d) sin_sesion: de antes del renombre" > "${CASA}/${SELLO_VIEJO}"
bajar_casa "${T}" "${T}/bin/az"
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" aviso)" = "ya_emitido_hoy" ] \
  && ok "8.9-D2 con sólo el sello viejo de hoy, el aviso de sin permiso no se repite" \
  || mal "8.9-D2 sello viejo de hoy: rc=${RC} aviso=$(campo "${T}" aviso)"
echo "2000-01-01 sin_sesion: de antes del renombre" > "${CASA}/${SELLO_VIEJO}"; cp "${CASA}/${SELLO_VIEJO}" "${T}/viejo-antes"
bajar_casa "${T}" "${T}/bin/az"
[ "$(campo "${T}" aviso)" = "emitido" ] && [ "$(cut -c1-10 "${CASA}/download-runs-no-permission.seal" 2>/dev/null)" = "$(date -u +%Y-%m-%d)" ] && cmp -s "${T}/viejo-antes" "${CASA}/${SELLO_VIEJO}" \
  && ok "8.9-D2 el sello diario se escribe como download-runs-no-permission.seal y el viejo queda intacto" \
  || mal "8.9-D2 sello nuevo: aviso=$(campo "${T}" aviso) · $(ls "${CASA}" 2>&1 | tr '\n' ' ')"
T="${BASE}/t-d2-indice"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
echo 1 > "${T}/b/sin-md5"
rm -rf "${CASA}"; mkdir -p "${CASA}"
blob "${T}/b" "equipo-deva/2.1-2026-09-01T1000.json" 900
bajar_casa "${T}" "${T}/bin/az"
[ "${RC}" -eq 0 ] && [ -f "${CASA}/mailbox-downloads.json" ] && [ ! -e "${CASA}/${INDICE_VIEJO}" ] \
  && ok "8.9-D2 el índice de la bajada se escribe como mailbox-downloads.json" \
  || mal "8.9-D2 índice nuevo: rc=${RC} · $(ls "${CASA}" 2>&1 | tr '\n' ' ')"
mv "${CASA}/mailbox-downloads.json" "${CASA}/${INDICE_VIEJO}"; cp "${CASA}/${INDICE_VIEJO}" "${T}/indice-antes"
ANTES="$(gets "${T}/b")"
bajar_casa "${T}" "${T}/bin/az"
[ "${RC}" -eq 0 ] && [ "$(gets "${T}/b")" = "${ANTES}" ] && [ "$(campo "${T}" al_dia)" = "1" ] \
  && ok "8.9-D2 con sólo el índice viejo, lo que el listado no trae con MD5 no se vuelve a bajar" \
  || mal "8.9-D2 índice viejo: rc=${RC} gets antes=${ANTES} después=$(gets "${T}/b") al_dia=$(campo "${T}" al_dia)"
blob "${T}/b" "equipo-deva/2.2-2026-09-02T1000.json" 900
bajar_casa "${T}" "${T}/bin/az"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if len(d['blobs'])==2 else 1)" "${CASA}/mailbox-downloads.json" 2>/dev/null && cmp -s "${T}/indice-antes" "${CASA}/${INDICE_VIEJO}" \
  && ok "8.9-D2 al escribir, el índice nuevo arranca con lo del viejo (2 entradas) y el viejo queda intacto" \
  || mal "8.9-D2 migración del índice: rc=${RC} · $(cat "${CASA}/mailbox-downloads.json" 2>&1 | head -c 300)"
rm -rf "${CASA}"
fi

# ── Retención por registro · una falla local de CUALQUIER registro antes de la cola retiene la cobertura, también con guion en el nombre ──
# 🔴 Falla con: reconocer los registros con una expresión escrita a
#    mano (`[a-z]+\.(log|jsonl)\.gz`), que no ve el guion de `legacy-names.jsonl.gz`: una copia local ilegible de ése
#    deja escribir la cobertura nueva. La lista sale de REGISTROS de upload-runs.js: un registro nuevo entra solo.
for REG in hallazgos.jsonl legacy-names.jsonl; do
  T8="${BASE}/t89e-${REG}"; buzon "${T8}/b"; config "${T8}/cfg.json"; az_doble "${T8}" token
  blob "${T8}/b" "lab-mini/registros/${REG}.gz" 100; blob "${T8}/b" "lab-mini/registros/cobertura.json" 100
  L8="${T8}/estado/corridas-buzon/lab-mini/registros"; mkdir -p "${L8}"
  head -c 100 /dev/urandom > "${L8}/${REG}.gz"; chmod 000 "${L8}/${REG}.gz"   # mismo largo, ilegible → falla antes de la cola
  bajar "${T8}" "${T8}/bin/az"
  chmod 644 "${L8}/${REG}.gz"
  [ "${RC}" -eq 1 ] && [ ! -e "${L8}/cobertura.json" ] \
    && ok "8.9-E ${REG}.gz ilegible en la copia local → la cobertura de esa máquina queda retenida (sale 1)" \
    || mal "8.9-E ${REG}.gz ilegible: rc=${RC}, cobertura $( [ -e "${L8}/cobertura.json" ] && echo escrita || echo retenida)"
done

# ════ el bajador toma la última versión y deja el espejo como estaba ═══════════════════════════════════
VA=v20261020T100000000Z; VB=v20261021T100000000Z
gets_de() { if [ -f "$1/pedidos.jsonl" ]; then grep -v 'comp=list' "$1/pedidos.jsonl" | grep '"metodo":"GET"' | grep -c "$2" || true; else echo 0; fi; }
cobertura_de() {  # <archivo> <fuentes medidas, separadas por coma> → una cobertura válida que declara esas fuentes medidas
  python3 - "$1" "$2" <<'PY'
import json, sys
f = {k: {'estado': 'medido', 'bytes': 10} for k in sys.argv[2].split(',') if k}
f.setdefault('hallazgos', {'estado': 'no_medido', 'motivo': 'no existe'})
json.dump({'esquema': 1, 'fecha': '2026-10-20', 'preparado': 'v20261020T100000000Z', 'fuentes': f}, open(sys.argv[1], 'w'))
PY
}
gz_de() { mkdir -p "$(dirname "$1")"; printf '{"ts":"2026-10-20T10:00:00Z","name":"%s","status":"green"}\n' "$2" | gzip -c > "$1"; }

# ── T14 · Corrida_TomaLaMasNueva_EnLaRutaDeSiempre ── 🔴 Falla con: bajar todas y que gane la última del listado.
T="${BASE}/t224-14"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
C="${T}/b/blobs/corridas"
blob "${T}/b" "maq-x/1.1-2026-10-01T1000.json" 300
blob "${T}/b" "maq-x/${VB}/1.1-2026-10-01T1000.json" 320
blob "${T}/b" "maq-x/${VA}/1.1-2026-10-01T1000.json" 310
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 0 ] && cmp -s "${C}/maq-x/${VB}/1.1-2026-10-01T1000.json" "${T}/estado/corridas-buzon/maq-x/1.1-2026-10-01T1000.json" \
  && [ "$(campo "${T}" versiones_viejas)" = "2" ] && [ "$(gets "${T}/b")" = "1" ] && [ ! -d "${T}/estado/corridas-buzon/maq-x/${VA}" ] && [ ! -d "${T}/estado/corridas-buzon/maq-x/${VB}" ] \
  && [ "$(campo "${T}" completo)" = "true" ] \
  && ok "2.24-T14 baja sólo la versión más nueva, a <máquina>/<archivo> (la ruta de siempre), versiones_viejas 2, un solo GET, completo" \
  || mal "2.24-T14 rc=${RC} viejas=$(campo "${T}" versiones_viejas) gets=$(gets "${T}/b") completo=$(campo "${T}" completo) · $(ls -R "${T}/estado/corridas-buzon" 2>&1 | head -6 | tr '\n' ' ')"

# ── T15 · NoThreads_OmiteHilosDeTodasLasVersiones ── 🔴 Falla con: una versión del hilo baja.
T="${BASE}/t224-15"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "maq-x/1.1-2026-10-01T1000.json" 300
blob "${T}/b" "maq-x/1.1-2026-10-01T1000.hilo.jsonl.gz" 300
blob "${T}/b" "maq-x/${VA}/1.1-2026-10-01T1000.hilo.jsonl.gz" 300
blob "${T}/b" "maq-x/${VB}/1.1-2026-10-01T1000.cambio.json.gz" 300
bajar "${T}" "${T}/bin/az" --no-threads
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" omitidos)" = "3" ] && [ -z "$(find "${T}/estado" -name '*.hilo.jsonl.gz' -o -name '*.cambio.json.gz' 2>/dev/null)" ] \
  && ! grep -q 'hilo.jsonl.gz\|cambio.json.gz' "${T}/b/pedidos.jsonl" \
  && ok "2.24-T15 con --no-threads, ni el hilo ni el cambio de ninguna versión bajan; omitidos los cuenta (3)" || mal "2.24-T15 rc=${RC} omitidos=$(campo "${T}" omitidos)"

# ── T16 · Registros_JuegoMasNuevoConCobertura_SaltaIncompleto ── 🔴 Falla con: tomar B.
T="${BASE}/t224-16"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
C="${T}/b/blobs/corridas/maq-x/registros"
gz_de "${C}/gates.log.gz" plano; cobertura_de "${C}/cobertura.json" gates
gz_de "${C}/${VA}/gates.log.gz" versionA; cobertura_de "${C}/${VA}/cobertura.json" gates
gz_de "${C}/${VB}/gates.log.gz" versionB
bajar "${T}" "${T}/bin/az"
E="${T}/estado/corridas-buzon/maq-x/registros"
[ "${RC}" -eq 0 ] && cmp -s "${C}/${VA}/gates.log.gz" "${E}/gates.log.gz" && cmp -s "${C}/${VA}/cobertura.json" "${E}/cobertura.json" \
  && [ "$(campo "${T}" versiones_incompletas)" = "1" ] && [ "$(gets_de "${T}/b" "${VB}")" = "0" ] \
  && ok "2.24-T16 toma el juego más nuevo COMPLETO (A), saltea el B sin cobertura (versiones_incompletas 1) y no lo baja" \
  || mal "2.24-T16 rc=${RC} incompletas=$(campo "${T}" versiones_incompletas) gets B=$(gets_de "${T}/b" "${VB}") · $(gunzip -c "${E}/gates.log.gz" 2>&1 | head -c 80)"

# ── T30 · Registros_FuenteMedidaSinArchivo_Saltea ── 🔴 Falla con: tomar B por tener cobertura.
T="${BASE}/t224-30"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
C="${T}/b/blobs/corridas/maq-x/registros"
gz_de "${C}/${VA}/gates.log.gz" versionA; gz_de "${C}/${VA}/bypass.log.gz" versionA; cobertura_de "${C}/${VA}/cobertura.json" gates,bypass
gz_de "${C}/${VB}/gates.log.gz" versionB; cobertura_de "${C}/${VB}/cobertura.json" gates,bypass
bajar "${T}" "${T}/bin/az"
E="${T}/estado/corridas-buzon/maq-x/registros"
[ "${RC}" -eq 0 ] && cmp -s "${C}/${VA}/gates.log.gz" "${E}/gates.log.gz" && cmp -s "${C}/${VA}/bypass.log.gz" "${E}/bypass.log.gz" && cmp -s "${C}/${VA}/cobertura.json" "${E}/cobertura.json" \
  && [ "$(campo "${T}" versiones_incompletas)" = "1" ] \
  && ok "2.24-T30 una versión con cobertura que declara bypass medido y sin bypass.log.gz se saltea: queda A" \
  || mal "2.24-T30 rc=${RC} incompletas=$(campo "${T}" versiones_incompletas) · $(gunzip -c "${E}/gates.log.gz" 2>&1 | head -c 80)"

# ── T16b · Registros_CoberturaQueNoSeLee_NoEsIncompleta ──
# 🔴 Falla con: un 500 al pedir la cobertura del juego más nuevo, o una cobertura ilegible, contado como «juego
#    incompleto»: el espejo queda con la versión anterior y la bajada dice exit 0, completo true.
T="${BASE}/t224-16b"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
C="${T}/b/blobs/corridas/maq-x/registros"
gz_de "${C}/${VA}/gates.log.gz" versionA; cobertura_de "${C}/${VA}/cobertura.json" gates
gz_de "${C}/${VB}/gates.log.gz" versionB; cobertura_de "${C}/${VB}/cobertura.json" gates
echo "maq-x/registros/${VB}/cobertura.json" > "${T}/b/falla-get"
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "servicio_fallo" ] && [ "$(campo "${T}" completo)" = "false" ] && [ ! -e "${T}/estado/corridas-buzon/maq-x/registros/gates.log.gz" ] \
  && ok "2.24-T16b un 500 al leer la cobertura del juego más nuevo: servicio_fallo, exit 1, completo false, no baja la versión vieja" \
  || mal "2.24-T16b 500: rc=${RC} estado=$(campo "${T}" estado) completo=$(campo "${T}" completo)"
rm -f "${T}/b/falla-get"; echo "maq-x/registros/${VB}/cobertura.json" > "${T}/b/corromper"
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "parcial" ] && [ "$(campo "${T}" completo)" = "false" ] && [ "$(campo "${T}" versiones_incompletas)" = "0" ] \
  && campo "${T}" no_leidos | grep 'cobertura ilegible' >/dev/null && cmp -s "${C}/${VA}/gates.log.gz" "${T}/estado/corridas-buzon/maq-x/registros/gates.log.gz" \
  && ok "2.24-T16c una cobertura ilegible se nombra (parcial, exit 1, completo false), no cuenta como incompleta, y el espejo queda con la versión anterior" \
  || mal "2.24-T16c ilegible: rc=${RC} estado=$(campo "${T}" estado) incompletas=$(campo "${T}" versiones_incompletas) no_leidos=$(campo "${T}" no_leidos)"

# ── T17 · VersionMalFormada_Ignorada ── 🔴 Falla con: una versión mal formada se baja o tumba la pasada.
T="${BASE}/t224-17"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "maq-x/v2026/x.json" 50
blob "${T}/b" "maq-x/otra/x.json" 50
blob "${T}/b" "maq-x/registros/vX/gates.log.gz" 50
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" ignorados)" = "3" ] && [ ! -e "${T}/estado/corridas-buzon/maq-x" ] \
  && python3 -c "import json,sys; n=json.load(open(sys.argv[1]))['ignorados_nombres']; assert sorted(n)==['maq-x/otra/x.json','maq-x/registros/vX/gates.log.gz','maq-x/v2026/x.json'], n" "${T}/out.json" \
  && ok "2.24-T17 versión mal formada u otra subcarpeta: ignorados 3, nombrados, nada en el disco" || mal "2.24-T17 rc=${RC} ignorados=$(campo "${T}" ignorados) $(campo "${T}" ignorados_nombres)"

# ── T20 · Lectores_IgualConVersionesQueConNombresDeSiempre ── 🔴 Falla con: un lector que lee la carpeta v….
T="${BASE}/t224-20"
for B in plano versionado; do buzon "${T}/${B}"; done
mkdir -p "${T}/fuente/maq-x/registros"
printf '{"archivedAt":"2026-10-20T10:00:00.000Z","marker":{"storyId":"7.1","sessionId":"sid-71"}}\n' > "${T}/fuente/maq-x/7.1-2026-10-20T1000.json"
printf '{"archivedAt":"2026-10-20T11:00:00.000Z","marker":{"storyId":"7.2","sessionId":"sid-72"}}\n' > "${T}/fuente/maq-x/7.2-2026-10-20T1100.json"
gz_de "${T}/fuente/maq-x/registros/gates.log.gz" tests; gz_de "${T}/fuente/maq-x/registros/bypass.log.gz" bypass
cobertura_de "${T}/fuente/maq-x/registros/cobertura.json" gates,bypass
# plano: los nombres de siempre
cp -R "${T}/fuente/maq-x" "${T}/plano/blobs/corridas/maq-x"
# versionado: el mismo contenido final, con una versión vieja distinta debajo
P="${T}/versionado/blobs/corridas/maq-x"; mkdir -p "${P}/registros/${VB}" "${P}/${VB}"
printf '{"archivedAt":"2026-10-20T10:00:00.000Z","marker":{"storyId":"7.1","sessionId":"sid-viejo"}}\n' > "${P}/7.1-2026-10-20T1000.json"
cp "${T}/fuente/maq-x/7.1-2026-10-20T1000.json" "${P}/${VB}/"
cp "${T}/fuente/maq-x/7.2-2026-10-20T1100.json" "${P}/"
gz_de "${P}/registros/gates.log.gz" viejo; cobertura_de "${P}/registros/cobertura.json" gates
cp "${T}/fuente/maq-x/registros/"* "${P}/registros/${VB}/"
TABLERO="${RAIZ}/scripts/nightly/dashboard/dashboard.js"
for B in plano versionado; do
  config "${T}/${B}/cfg.json"; az_doble "${T}/${B}" token
  echo token-bueno > "${T}/${B}/token"
  URL_BUZON="http://127.0.0.1:$(cat "${T}/${B}/puerto")"
  bajar "${T}/${B}" "${T}/${B}/bin/az" --no-threads
  cp "${T}/${B}/out.json" "${T}/${B}-estado.json"
  E="${T}/${B}/estado/corridas-buzon"
  # la hora en que se generó cada modelo no es un número del buzón: se saca antes de comparar
  sin_hora() { python3 -c "
import json, sys
def f(x):
    if isinstance(x, dict): return {k: f(v) for k, v in x.items() if not k.startswith('generad')}
    if isinstance(x, list): return [f(v) for v in x]
    return x
t = sys.stdin.read()
i = 0 if t.startswith('{') else t.find('\n{') + 1
print(json.dumps(f(json.JSONDecoder().raw_decode(t[i:])[0]), sort_keys=True, indent=1))" 2>/dev/null; }
  TYCON_MACHINE=maq-otra node "${TABLERO}" --view runs --runs-dir "${T}/vacio" --mailbox "${E}" --json --dry-run 2>/dev/null | sed "s#${E}#ESPEJO#g" | sin_hora > "${T}/${B}-runs.json"
  TYCON_MACHINE=maq-otra node "${TABLERO}" --nightly --mailbox "${E}" --mailbox-state "${T}/${B}-estado.json" --output "${T}/${B}-noche.html" --json > "${T}/${B}-noche.crudo" 2>/dev/null
  # el nocturno imprime su resumen de fuentes y después el modelo en JSON: se toma el JSON
  sed "s#${E}#ESPEJO#g; s#${T}/${B}#CASO#g" "${T}/${B}-noche.crudo" | sin_hora > "${T}/${B}-noche.json"
done
if [ "$(campo "${T}/plano" completo)" = "true" ] && [ "$(campo "${T}/versionado" completo)" = "true" ] && diff -r "${T}/plano/estado/corridas-buzon/maq-x" "${T}/versionado/estado/corridas-buzon/maq-x" >/dev/null \
   && [ -s "${T}/plano-runs.json" ] && cmp -s "${T}/plano-runs.json" "${T}/versionado-runs.json" && [ -s "${T}/plano-noche.json" ] && cmp -s "${T}/plano-noche.json" "${T}/versionado-noche.json"; then
  ok "2.24-T20 un buzón versionado y uno plano con el mismo contenido dan el mismo espejo, la misma vista de ejecuciones y la misma página del equipo (completo en los dos)"
else
  mal "2.24-T20 completo plano=$(campo "${T}/plano" completo) versionado=$(campo "${T}/versionado" completo) · espejos: $(diff -rq "${T}/plano/estado/corridas-buzon/maq-x" "${T}/versionado/estado/corridas-buzon/maq-x" 2>&1 | head -3) · runs $(cmp "${T}/plano-runs.json" "${T}/versionado-runs.json" 2>&1) · noche $(cmp "${T}/plano-noche.json" "${T}/versionado-noche.json" 2>&1) $(wc -c < "${T}/plano-noche.json") · $(head -c 300 "${T}/plano-noche.crudo")"
fi

# ── T18 · OverwritesReport_SoloListaYCuentaSinNombres ──────────────────────────────
# 🔴 Falla con: el informe no existe (la bandera se ignora y baja todo), o nombra las máquinas (se llaman como personas).
T="${BASE}/t224-18"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "mac-a/1.1-2026-10-01T1000.json" 300
blob "${T}/b" "mac-a/1.1-2026-10-01T1000.hilo.jsonl.gz" 300
blob "${T}/b" "mac-a/registros/gates.log.gz" 100
blob "${T}/b" "mac-a/registros/cobertura.json" 100
blob "${T}/b" "mac-a/otra/x.json" 50
blob "${T}/b" "mac-b/2.1-2026-09-20T1000.json" 300
blob "${T}/b" "mac-b/2.1-2026-09-20T1000.cambio.json.gz" 300
blob "${T}/b" "mac-c/3.1-2026-10-10T1000.json" 300
blob "${T}/b" "mac-c/3.2-2026-10-10T1100.json" 300
HACE20="$(python3 -c "import datetime; print((datetime.datetime.utcnow()-datetime.timedelta(days=20)).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
AYER="$(python3 -c "import datetime; print((datetime.datetime.utcnow()-datetime.timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
cat > "${T}/b/fechas" <<JSON
{"mac-a/1.1-2026-10-01T1000.json": ["${AYER}", "${AYER}"],
 "mac-a/1.1-2026-10-01T1000.hilo.jsonl.gz": ["2026-10-01T10:00:00Z", "2026-10-01T10:01:00Z"],
 "mac-a/registros/gates.log.gz": ["2026-10-01T10:00:00Z", "${AYER}"],
 "mac-a/registros/cobertura.json": [null, "${AYER}"],
 "mac-b/2.1-2026-09-20T1000.json": ["${HACE20}", "${HACE20}"],
 "mac-b/2.1-2026-09-20T1000.cambio.json.gz": ["${HACE20}", "${HACE20}"],
 "mac-c/3.1-2026-10-10T1000.json": ["${AYER}", "${AYER}"],
 "mac-c/3.2-2026-10-10T1100.json": ["${AYER}", null]}
JSON
ESP="${T}/estado/corridas-buzon"
mkdir -p "${ESP}/mac-a/registros" "${ESP}/mac-b/registros" "${ESP}/mac-c/registros"
printf '{"schema":1,"day":"2026-10-15","install":{"mode":"managed","version":"2099.01.01.1","team":null}}\n' > "${ESP}/mac-a/registros/place.json"
printf '{"schema":1,"day":"2026-09-25","install":{"mode":"managed","version":null,"team":null}}\n' > "${ESP}/mac-b/registros/place.json"
printf '{"schema":1,"day":"2026-10-12","install":{"mode":"managed","version":"2026.01.01.1","team":null}}\n' > "${ESP}/mac-c/registros/place.json"
espejo_sha() { find "${ESP}" -type f -exec shasum {} + 2>/dev/null | sort | shasum; }
ANTES_ESP="$(espejo_sha)"
bajar "${T}" "${T}/bin/az" --overwrites-report
ALIAS_A="$(node "${RAIZ}/scripts/nightly/dashboard/reducer.js" --alias-of mac-a)"
ALIAS_B="$(node "${RAIZ}/scripts/nightly/dashboard/reducer.js" --alias-of mac-b)"
ALIAS_C="$(node "${RAIZ}/scripts/nightly/dashboard/reducer.js" --alias-of mac-c)"
if [ "${RC}" -eq 0 ] && python3 - "${T}/out.json" "${ALIAS_A}" "${ALIAS_B}" "${ALIAS_C}" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); a, b, c = sys.argv[2:5]
assert d['estado'] == 'medido', d
assert d['blobs'] == 9 and d['reescritos'] == 2 and d['sin_fecha_de_creacion'] == 1 and d['sin_fecha_de_modificacion'] == 1 and d['ignorados'] == 1, d
t = d['por_tipo']
assert t['registros'] == {'blobs': 2, 'reescritos': 1, 'sin_fecha_de_creacion': 1, 'sin_fecha_de_modificacion': 0}, t
# un blob sin fecha de modificación es «no medido», nunca «no re-escrito»
assert t['hilo']['reescritos'] == 1 and t['volcado'] == {'blobs': 4, 'reescritos': 0, 'sin_fecha_de_creacion': 0, 'sin_fecha_de_modificacion': 1}, t
assert t['cambio']['blobs'] == 1 and t['ignorado']['blobs'] == 1, t
m = {x['alias']: x for x in d['maquinas']}
assert set(m) == {a, b, c}, m
assert m[a]['blobs'] == 4 and m[a]['reescritos'] == 2 and m[a]['sin_fecha_de_creacion'] == 1, m[a]
assert m[a]['version'] == '2099.01.01.1' and m[a]['version_dia'] == '2026-10-15' and m[a]['lista'] == 'sí', m[a]
assert m[b]['version'] is None and m[b]['version_dia'] == '2026-09-25' and m[b]['lista'] == 'no medido', m[b]
assert m[c]['version'] == '2026.01.01.1' and m[c]['lista'] == 'no', m[c]
assert d['ausentes'] == [b], d['ausentes']
assert isinstance(d.get('version_solo_crear'), str) and d.get('dias_ausente') == 14, d
PY
then ok "2.24-T18 el informe cuenta re-escritos por tipo y por alias, aparte los sin fecha de creación, la versión de cada máquina y las ausentes"
else mal "2.24-T18 rc=${RC} · $(head -c 600 "${T}/out.json") · $(head -2 "${T}/err.txt")"; fi
[ "$(gets "${T}/b")" = "0" ] && [ "$(espejo_sha)" = "${ANTES_ESP}" ] \
  && ok "2.24-T18 sólo lista: ningún GET de blob y el espejo quedó igual" || mal "2.24-T18 GET de blobs=$(gets "${T}/b"), espejo cambió: $(find "${ESP}" -type f | head -5)"
grep -q 'mac-a\|mac-b\|mac-c' "${T}/out.json" "${T}/err.txt" && mal "2.24-T18 el informe nombra una máquina: $(grep -o 'mac-[abc][^"]*' "${T}/out.json" "${T}/err.txt" | head -2)" \
  || ok "2.24-T18 ni el informe ni sus avisos nombran una máquina (sólo alias)"

# ── T19 · OverwritesReport_SinPermiso_NoMedido ────────────────────────────────────────────
# 🔴 Falla con: sin el rol el informe falla con exit ≠ 0, o crea la carpeta del espejo.
for MODO in bad-token no-session; do
  T="${BASE}/t224-19-${MODO}"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" "${MODO}"
  blob "${T}/b" "mac-a/1.1-2026-10-01T1000.json" 300
  bajar "${T}" "${T}/bin/az" --overwrites-report
  [ "${RC}" -eq 0 ] && [ "$(campo "${T}" estado)" = "no_medido" ] && [ -n "$(campo "${T}" motivo)" ] && [ "$(campo "${T}" motivo)" != "null" ] && [ ! -e "${T}/estado" ] \
    && ok "2.24-T19 (${MODO}) sin permiso: exit 0, «no medido» con su motivo, sin carpeta creada" \
    || mal "2.24-T19 (${MODO}) rc=${RC} estado=$(campo "${T}" estado) motivo=$(campo "${T}" motivo) · $(ls "${T}" | tr '\n' ' ')"
done
# T19b · el listado que falla por otra cosa que el permiso NO es «no medido» con exit 0: es un error
for CODIGO in 404 500; do
  T="${BASE}/t224-19b-${CODIGO}"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
  echo "${CODIGO}" > "${T}/b/modo-lista"
  bajar "${T}" "${T}/bin/az" --overwrites-report
  ESPERA=sin_contenedor; [ "${CODIGO}" = 500 ] && ESPERA=servicio_fallo
  [ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "${ESPERA}" ] && [ ! -e "${T}/estado" ] \
    && ok "2.24-T19b listado ${CODIGO} → ${ESPERA}, exit 1, sin carpeta" || mal "2.24-T19b listado ${CODIGO}: rc=${RC} estado=$(campo "${T}" estado)"
done

# ── T31 · InformeNodePropio_PorVersion_AusentesAparte ────────────────────────────────
# @story-8.39 @ac-23 @ac-24  Por máquina, con su alias: «sí» si su place.json es de una versión con el Node propio (trae
# install.harness_node), «no» si es de una anterior, «no medido» sin place.json; las que no suben hace 14 días, aparte;
# `todas` sólo si ninguna presente dice «no» ni «no medido». Sólo lista. 🔴 Falla con: que la opción no exista.
T="${BASE}/t839-31"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
for m in mac-a mac-b mac-c mac-d; do blob "${T}/b" "${m}/1.1-2026-10-14T1000.json" 300; done
HACE20="$(python3 -c "import datetime; print((datetime.datetime.utcnow()-datetime.timedelta(days=20)).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
AYER="$(python3 -c "import datetime; print((datetime.datetime.utcnow()-datetime.timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
printf '{"mac-a/1.1-2026-10-14T1000.json": ["%s", "%s"], "mac-b/1.1-2026-10-14T1000.json": ["%s", "%s"], "mac-c/1.1-2026-10-14T1000.json": ["%s", "%s"], "mac-d/1.1-2026-10-14T1000.json": ["%s", "%s"]}\n' \
  "${AYER}" "${AYER}" "${AYER}" "${AYER}" "${AYER}" "${AYER}" "${HACE20}" "${HACE20}" > "${T}/b/fechas"
ESP="${T}/estado/corridas-buzon"
mkdir -p "${ESP}/mac-a/registros" "${ESP}/mac-b/registros" "${ESP}/mac-d/registros"
printf '{"schema":1,"day":"2026-10-16","install":{"mode":"managed","version":"2026.10.16.1","team":null,"harness_node":{"own":false,"major":20}}}\n' > "${ESP}/mac-a/registros/place.json"
printf '{"schema":1,"day":"2026-10-15","install":{"mode":"managed","version":"2026.10.15.40","team":null}}\n' > "${ESP}/mac-b/registros/place.json"
printf '{"schema":1,"day":"2026-09-20","install":{"mode":"managed","version":"2026.09.20.1","team":null}}\n' > "${ESP}/mac-d/registros/place.json"
espejo_sha() { find "${ESP}" -type f -exec shasum {} + 2>/dev/null | sort | shasum; }
ANTES_ESP="$(espejo_sha)"
bajar "${T}" "${T}/bin/az" --harness-node-report
A="$(node "${RAIZ}/scripts/nightly/dashboard/reducer.js" --alias-of mac-a)"; B="$(node "${RAIZ}/scripts/nightly/dashboard/reducer.js" --alias-of mac-b)"
C="$(node "${RAIZ}/scripts/nightly/dashboard/reducer.js" --alias-of mac-c)"; D="$(node "${RAIZ}/scripts/nightly/dashboard/reducer.js" --alias-of mac-d)"
if [ "${RC}" -eq 0 ] && python3 - "${T}/out.json" "$A" "$B" "$C" "$D" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); a, b, c, dd = sys.argv[2:6]
assert d['estado'] == 'medido', d
m = {x['alias']: x for x in d['maquinas']}
assert set(m) == {a, b, c}, m
assert m[a]['lista'] == 'sí' and m[a]['con_el_del_path'] is True and m[a]['node_mayor'] == 20, m[a]
assert m[b]['lista'] == 'no', m[b]
assert m[c]['lista'] == 'no medido', m[c]
assert d['ausentes'] == [dd], d['ausentes']
assert d['todas'] is False and d['con_el_del_path'] == 1, d
PY
then ok "8.39-T31 sí / no / no medido por alias, la ausente aparte, todas: false y los que corren con el del PATH"
else mal "8.39-T31 rc=${RC} · $(head -c 600 "${T}/out.json") · $(head -2 "${T}/err.txt")"; fi
[ "$(gets "${T}/b")" = "0" ] && [ "$(espejo_sha)" = "${ANTES_ESP}" ] && ok "8.39-T31 sólo lista: ningún GET de blob y el espejo igual" || mal "8.39-T31 bajó o escribió"
grep -q 'mac-a\|mac-b\|mac-c\|mac-d' "${T}/out.json" && mal "8.39-T31 el informe nombra una máquina" || ok "8.39-T31 el informe no nombra máquinas (sólo alias)"
# con las presentes en «sí»: todas
printf '{"schema":1,"day":"2026-10-16","install":{"mode":"managed","version":"2026.10.16.2","team":null,"harness_node":{"own":true,"major":24}}}\n' > "${ESP}/mac-b/registros/place.json"
mkdir -p "${ESP}/mac-c/registros"; cp "${ESP}/mac-b/registros/place.json" "${ESP}/mac-c/registros/place.json"
bajar "${T}" "${T}/bin/az" --harness-node-report
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" todas)" = "true" ] && ok "8.39-T31 con las tres presentes en «sí»: todas: true (la ausente no cuenta)" || mal "8.39-T31 todas=$(campo "${T}" todas) · $(head -c 400 "${T}/out.json")"


# ════ la unión de carpetas: una carpeta vieja es historia de UNA nueva, o no se une ══════
# place228 <buzon> <carpeta> <previous_folder> <moved_on> [code_regenerated reason] — el place.json de una carpeta nueva
# huella_de <carpeta> — la huella de las corridas de una carpeta (sus volcados .json de primer nivel), como la declara la
# máquina que subió ahí: la misma función que usan la subida y la bajada.
huella_de() { node -e 'const fs=require("fs"); const [,u,d]=process.argv; let n=[]; try { n=fs.readdirSync(d).filter((x)=>x.endsWith(".json")); } catch (_) {} console.log(require(u).huellaDeCorridas(n))' "${RAIZ}/scripts/metrics/upload-runs.js" "$1"; }
place228() {
  local code="${2##*-}" extra=""
  [ -n "${5:-}" ] && extra=",\"code_regenerated\":{\"on\":\"$4\",\"reason\":\"$5\"}"
  mkdir -p "$1/blobs/corridas/$2/registros"
  printf '{"schema":1,"day":"%s","owner":{"email":"zqx-fuga-correo@ejemplo.test","source":"git-global"},"folder":{"name":"%s","code":"%s","previous_folder":"%s","moved_on":"%s","previous_runs_sha256":"%s"%s}}\n' "$4" "$2" "${code}" "$3" "$4" "$(huella_de "$1/blobs/corridas/$3")" "${extra}" > "$1/blobs/corridas/$2/registros/place.json"
}
volcado228() { mkdir -p "$1/blobs/corridas/$2"; printf '{"archivedAt":"%sT10:00:00.000Z","marker":{"sessionId":"sid-%s"}}\n' "$4" "$3" > "$1/blobs/corridas/$2/$3.json"; }
uniones() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps(d, sort_keys=True))" "$1/estado/corridas-buzon/.carpetas-de-maquina.json" 2>&1; }

# ── T35 · Carpetas_UnaDeclaracion_SeUne ── 🔴 Falla con: sin archivo; el correo adentro.
T="${BASE}/t228-35"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
volcado228 "${T}/b" macbook-pro "9.1-2026-10-14T0900" 2026-10-14
place228 "${T}/b" macbook-pro-1a2b3c4d macbook-pro 2026-10-15
volcado228 "${T}/b" macbook-pro-1a2b3c4d "9.1-2026-10-14T0900" 2026-10-14
bajar "${T}" "${T}/bin/az"
U="$(uniones "${T}")"
[ "${RC}" -eq 0 ] && [ "${U}" = '{"carpetas": {"macbook-pro": {"declarantes": 1, "desde": "2026-10-15", "estado": "unida", "nueva": "macbook-pro-1a2b3c4d"}}, "no_leidas": [], "regeneradas": {}, "schema": 1}' ] \
  && ok "2.28-T35 una declaración y nada nuevo en la vieja: unida a la nueva desde el día de la mudanza" || mal "2.28-T35 rc=${RC} uniones=${U}"
case "$(cat "${T}/estado/corridas-buzon/.carpetas-de-maquina.json" 2>/dev/null)" in *zqx-fuga*|*ejemplo.test*|*"${BASE}"*) mal "2.28-T35 el archivo trae un correo o una ruta" ;; '') mal "2.28-T35 no hay archivo" ;; *) ok "2.28-T35 sin correos ni rutas" ;; esac
node -e 'const { carpetasDeMaquina } = require(process.argv[1]); const r = carpetasDeMaquina(process.argv[2]); process.exit(r.carpetas["macbook-pro"].estado === "unida" ? 0 : 1)' "${BAJAR}" "${T}/estado/corridas-buzon" \
  && ok "2.28-T35 carpetasDeMaquina(espejo) da lo mismo (una sola definición)" || mal "2.28-T35 carpetasDeMaquina no exportada o distinta"
# Contrato: el archivo que escribe la bajada lo acepta el lector del reductor (que también usan la poda y la vista).
# 🔴 Falla con: probar los lectores con el archivo fabricado a mano.
node -e 'const r = require(process.argv[1]).leerUnionesDeCarpetas(process.argv[2]); process.exit(r.estado === "medidas" && r.carpetas.get("macbook-pro").nueva === "macbook-pro-1a2b3c4d" ? 0 : 1)' "${RAIZ}/scripts/nightly/dashboard/reducer.js" "${T}/estado/corridas-buzon" \
  && ok "2.28-T35 contrato: el lector del reductor acepta lo que escribe la bajada" || mal "2.28-T35 contrato: el reductor no acepta el archivo de la bajada"
# también con la bajada parcial
T="${BASE}/t228-35b"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
volcado228 "${T}/b" macbook-pro "9.1-2026-10-14T0900" 2026-10-14
place228 "${T}/b" macbook-pro-1a2b3c4d macbook-pro 2026-10-15
volcado228 "${T}/b" macbook-pro-1a2b3c4d "9.2-2026-10-15T0900" 2026-10-15
echo "macbook-pro-1a2b3c4d/9.2-2026-10-15T0900.json" > "${T}/b/corromper"
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "parcial" ] && echo "$(uniones "${T}")" | grep '"estado": "unida"' > /dev/null \
  && ok "2.28-T35 la bajada parcial también deja el archivo" || mal "2.28-T35 parcial: rc=${RC} estado=$(campo "${T}" estado) uniones=$(uniones "${T}")"

# «no pude mirar» no es «no recibió nada»: una carpeta vieja que no se deja listar no se une y queda nombrada
# 🔴 Falla con: que el listado fallido dé «último día vacío» y la vieja quede unida.
T="${BASE}/t228-35c"; mkdir -p "${T}/esp/macbook-pro" "${T}/esp/macbook-pro-1a2b3c4d/registros"
printf '{"schema":1,"day":"2026-10-15","folder":{"name":"macbook-pro-1a2b3c4d","code":"1a2b3c4d","previous_folder":"macbook-pro","moved_on":"2026-10-15"}}\n' > "${T}/esp/macbook-pro-1a2b3c4d/registros/place.json"
chmod 000 "${T}/esp/macbook-pro"
if [ -r "${T}/esp/macbook-pro" ]; then echo "  SALTEADO — 2.28-T35 carpeta ilegible: esta cuenta lee igual una carpeta sin permisos (¿root?)"
else
  node -e 'const r = require(process.argv[1]).carpetasDeMaquina(process.argv[2]); process.exit(!r.carpetas["macbook-pro"] && r.no_leidas.some((x) => x.carpeta === "macbook-pro") ? 0 : 1)' "${BAJAR}" "${T}/esp" \
    && ok "2.28-T35 una carpeta vieja que no se puede listar no se une y queda en no_leidas" || mal "2.28-T35 la carpeta ilegible se unió o no quedó nombrada"
fi
chmod 755 "${T}/esp/macbook-pro"

# ── pase adversarial: una declaración sin forma no une nada ─────────────────────────────────────────────
# El buzón lo escribe cualquiera con la llave: una declaración vale sólo si la carpeta que declara es EXACTAMENTE
# `<vieja>-<8 hexadecimales>`, la vieja no es a su vez una carpeta nueva, y la mudanza es una fecha real, no posterior al
# día de su place.json. 🔴 rojos previos (clases 3, 7, 14, 18 y el «aparte»): dos carpetas que se declaran una a la otra
# (ciclo); una máquina que declara como vieja la carpeta con código de otra (se queda con sus corridas); una mudanza en
# 2099; una fecha imposible que apagaba todas las uniones en los lectores.
pl228() {  # <espejo> <carpeta> <code> <previous> <moved_on> <day> [extra json dentro de folder]
  mkdir -p "$1/$2/registros"
  printf '{"schema":1,"day":"%s","folder":{"name":"%s","code":"%s","previous_folder":"%s","moved_on":"%s","previous_runs_sha256":"%s"%s}}\n' "$6" "$2" "$3" "$4" "$5" "$(huella_de "$1/$4")" "${7:-}" > "$1/$2/registros/place.json"
}
uniones_de() { node -e 'const r = require(process.argv[1]).carpetasDeMaquina(process.argv[2]); console.log(JSON.stringify(r.carpetas))' "${BAJAR}" "$1"; }
E="${BASE}/t228-adv/ciclo"; pl228 "${E}" maq-x z maq-y 2026-09-01 2026-09-01; pl228 "${E}" maq-y z maq-x 2026-09-01 2026-09-01
[ "$(uniones_de "${E}")" = '{}' ] && ok "2.28-adv ciclo: dos carpetas que se declaran una a la otra no se unen" || mal "2.28-adv ciclo: $(uniones_de "${E}")"
E="${BASE}/t228-adv/ajena"; pl228 "${E}" maq-a-1234abcd 1234abcd maq-a 2026-10-01 2026-10-15; pl228 "${E}" maq-b-9f8e7d6c 9f8e7d6c maq-a-1234abcd 2026-10-15 2026-10-15
mkdir -p "${E}/maq-a"
U="$(uniones_de "${E}")"
echo "${U}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'maq-a-1234abcd' not in d and d['maq-a']['nueva']=='maq-a-1234abcd', d" 2>/dev/null \
  && ok "2.28-adv una máquina no puede declarar como vieja la carpeta con código de otra" || mal "2.28-adv ajena: ${U}"
E="${BASE}/t228-adv/anidada"; pl228 "${E}" victima-1a2b3c4d 1a2b3c4d victima 2026-10-01 2026-10-15; pl228 "${E}" victima-1a2b3c4d-9f8e7d6c 9f8e7d6c victima-1a2b3c4d 2026-10-15 2026-10-15; mkdir -p "${E}/victima"
U="$(uniones_de "${E}")"
echo "${U}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'victima-1a2b3c4d' not in d, d" 2>/dev/null \
  && ok "2.28-adv una carpeta que declara su propia vieja no es una vieja de nadie" || mal "2.28-adv anidada: ${U}"
E="${BASE}/t228-adv/futuro"; pl228 "${E}" maq-c-1234abcd 1234abcd maq-c 2099-12-31 2026-10-15; mkdir -p "${E}/maq-c"
[ "$(uniones_de "${E}")" = '{}' ] && ok "2.28-adv una mudanza posterior al día de su place.json no declara nada" || mal "2.28-adv futuro: $(uniones_de "${E}")"
E="${BASE}/t228-adv/imposible"; pl228 "${E}" pc-22222222 22222222 pc 2026-02-31 2026-10-15; pl228 "${E}" mac-1a2b3c4d 1a2b3c4d mac 2026-10-15 2026-10-15; mkdir -p "${E}/pc" "${E}/mac"
U="$(uniones_de "${E}")"
echo "${U}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'pc' not in d and d['mac']['estado']=='unida', d" 2>/dev/null \
  && ok "2.28-adv una fecha imposible no declara nada y la otra unión sigue" || mal "2.28-adv imposible: ${U}"
# un código regenerado declara también la carpeta con código que reemplaza (sale del registro de subidas de la máquina):
# esa carpeta se une a la regenerada si nada llegó ahí después; si no, queda como estaba.
# 🔴 Falla con: la carpeta del código anterior que no declara nadie, y el tablero que cuenta dos veces lo re-subido.
E="${BASE}/t228-adv/regenerada"; mkdir -p "${E}/macbook-pro" "${E}/macbook-pro-1111aaaa"
pl228 "${E}" macbook-pro-1111aaaa 1111aaaa macbook-pro 2026-09-14 2026-09-16
pl228 "${E}" macbook-pro-2222bbbb 2222bbbb macbook-pro 2026-09-17 2026-09-17 ",\"code_regenerated\":{\"on\":\"2026-09-17\",\"reason\":\"no estaba\"},\"superseded_folders\":[\"macbook-pro-1111aaaa\"],\"superseded_runs_sha256\":{\"macbook-pro-1111aaaa\":\"$(huella_de "${E}/macbook-pro-1111aaaa")\"}"
U="$(uniones_de "${E}")"
echo "${U}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['macbook-pro-1111aaaa']=={'estado':'unida','nueva':'macbook-pro-2222bbbb','declarantes':1,'desde':'2026-09-17'}, d; assert d['macbook-pro']['estado']=='compartida', d" 2>/dev/null \
  && ok "2.28-adv la carpeta del código anterior se une a la regenerada" || mal "2.28-adv regenerada: ${U}"
printf '{}\n' > "${E}/macbook-pro-1111aaaa/9.9-2026-09-18T0900.json"
echo "$(uniones_de "${E}")" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['macbook-pro-1111aaaa']['estado']=='siguio_recibiendo', d" 2>/dev/null \
  && ok "2.28-adv y si la del código anterior siguió recibiendo, no se une" || mal "2.28-adv regenerada que siguió: $(uniones_de "${E}")"

# La unión pide la HUELLA de las corridas que la máquina
# subió a la carpeta vieja (de su registro de subidas; la llave no deja listar el buzón, así que nadie más la sabe). Una
# máquina con el mismo nombre que declara la carpeta vieja de otra no la sabe: no se une.
# 🔴 Falla con: con un `moved_on` de hoy y la carpeta ajena sin nada después, la carpeta de otra persona queda unida.
E="${BASE}/t228-adv/huella"; mkdir -p "${E}/macbook-pro"; printf '{}\n' > "${E}/macbook-pro/9.1-2026-10-14T0900.json"
pl228 "${E}" macbook-pro-aaaaaaaa aaaaaaaa macbook-pro 2026-10-15 2026-10-15
node -e 'const fs=require("fs"); const f=process.argv[1]; const p=JSON.parse(fs.readFileSync(f)); p.folder.previous_runs_sha256=require("crypto").createHash("sha256").update("adivinada").digest("hex"); fs.writeFileSync(f, JSON.stringify(p))' "${E}/macbook-pro-aaaaaaaa/registros/place.json"
U="$(uniones_de "${E}")"
echo "${U}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['macbook-pro']['estado']=='siguio_recibiendo' and d['macbook-pro']['nueva'] is None, d" 2>/dev/null \
  && ok "2.28-adv sin la huella de las ejecuciones de la carpeta vieja, la carpeta no se une" || mal "2.28-adv huella: ${U}"
pl228 "${E}" macbook-pro-aaaaaaaa aaaaaaaa macbook-pro 2026-10-15 2026-10-15
echo "$(uniones_de "${E}")" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['macbook-pro']['estado']=='unida', d" 2>/dev/null \
  && ok "2.28-adv con la huella correcta, se une" || mal "2.28-adv huella correcta: $(uniones_de "${E}")"
# sin huella (una subida que no la declara, o un registro que no se pudo leer y la dejó en null): no se une
node -e 'const fs=require("fs"); const f=process.argv[1]; const p=JSON.parse(fs.readFileSync(f)); delete p.folder.previous_runs_sha256; fs.writeFileSync(f, JSON.stringify(p))' "${E}/macbook-pro-aaaaaaaa/registros/place.json"
echo "$(uniones_de "${E}")" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['macbook-pro']['estado']=='siguio_recibiendo', d" 2>/dev/null \
  && ok "2.28-adv sin huella declarada, no se une" || mal "2.28-adv sin huella: $(uniones_de "${E}")"
# la carpeta que reemplaza un código regenerado, con una huella que no coincide: no se une
E="${BASE}/t228-adv/regenerada-mal"; mkdir -p "${E}/macbook-pro" "${E}/macbook-pro-1111aaaa"; printf '{}\n' > "${E}/macbook-pro-1111aaaa/9.1-2026-09-14T0900.json"
pl228 "${E}" macbook-pro-1111aaaa 1111aaaa macbook-pro 2026-09-14 2026-09-16
pl228 "${E}" macbook-pro-2222bbbb 2222bbbb macbook-pro 2026-09-17 2026-09-17 ',"code_regenerated":{"on":"2026-09-17","reason":"no estaba"},"superseded_folders":["macbook-pro-1111aaaa"],"superseded_runs_sha256":{"macbook-pro-1111aaaa":"0000000000000000000000000000000000000000000000000000000000000000"}'
U="$(uniones_de "${E}")"
echo "${U}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['macbook-pro-1111aaaa']['estado']=='siguio_recibiendo', d" 2>/dev/null \
  && ok "2.28-adv una carpeta reemplazada con otra huella no se une a la regenerada" || mal "2.28-adv reemplazada con otra huella: ${U}"
# La lista de reemplazadas vale sólo con un código regenerado ese día, y ningún día de un
# place.json puede ser posterior a hoy. 🔴 Falla con: una carpeta nueva sin regenerar que lista la carpeta con código de
# otra máquina; con un `day` y un `moved_on` a futuro, la otra «nunca siguió recibiendo» y queda unida a la atacante.
E="${BASE}/t228-adv/sin-regenerar"; mkdir -p "${E}/beta" "${E}/beta-bbbbbbbb"
pl228 "${E}" beta-bbbbbbbb bbbbbbbb beta 2026-09-14 2026-09-16
pl228 "${E}" beta-aaaaaaaa aaaaaaaa beta 2026-09-17 2026-09-17 ',"superseded_folders":["beta-bbbbbbbb"]'
U="$(uniones_de "${E}")"
echo "${U}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'beta-bbbbbbbb' not in d, d" 2>/dev/null \
  && ok "2.28-adv sin código regenerado, la lista de reemplazadas no une nada" || mal "2.28-adv sin regenerar: ${U}"
E="${BASE}/t228-adv/futuro-dia"; mkdir -p "${E}/gama" "${E}/gama-cccccccc"
pl228 "${E}" gama-cccccccc cccccccc gama 2026-09-14 2026-09-16
pl228 "${E}" gama-dddddddd dddddddd gama 2099-01-01 2099-01-01 ',"code_regenerated":{"on":"2099-01-01","reason":"no estaba"},"superseded_folders":["gama-cccccccc"]'
U="$(uniones_de "${E}")"
echo "${U}" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'gama-cccccccc' not in d and d['gama']['estado']=='unida' and d['gama']['nueva']=='gama-cccccccc', d" 2>/dev/null \
  && ok "2.28-adv un día de place.json posterior a hoy no declara nada" || mal "2.28-adv día futuro: ${U}"

# ── T36 · Carpetas_DosDeclaraciones_NoSeUne ── 🔴 Falla con: unirla a la más nueva.
T="${BASE}/t228-36"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
volcado228 "${T}/b" macbook-pro "9.1-2026-10-14T0900" 2026-10-14
place228 "${T}/b" macbook-pro-1a2b3c4d macbook-pro 2026-10-15
place228 "${T}/b" macbook-pro-9f8e7d6c macbook-pro 2026-10-16
bajar "${T}" "${T}/bin/az"
echo "$(uniones "${T}")" | python3 -c "import json,sys; d=json.load(sys.stdin)['carpetas']['macbook-pro']; assert d=={'estado':'compartida','nueva':None,'declarantes':2,'desde':'2026-10-15'}, d" 2>/dev/null \
  && ok "2.28-T36 dos carpetas que la declaran: compartida, declarantes 2, sin nueva" || mal "2.28-T36 rc=${RC} uniones=$(uniones "${T}")"
# un código regenerado: dos carpetas de la MISMA máquina la declaran → compartida igual, y la segunda en `regeneradas`
T="${BASE}/t228-36b"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
volcado228 "${T}/b" macbook-pro "9.1-2026-10-14T0900" 2026-10-14
place228 "${T}/b" macbook-pro-1a2b3c4d macbook-pro 2026-10-15
place228 "${T}/b" macbook-pro-55aa66bb macbook-pro 2026-10-15 "no estaba"
bajar "${T}" "${T}/bin/az"
echo "$(uniones "${T}")" | python3 -c "import json,sys; d=json.load(sys.stdin); c=d['carpetas']['macbook-pro']; assert c['estado']=='compartida' and c['declarantes']==2, c; assert d['regeneradas']=={'macbook-pro-55aa66bb':{'on':'2026-10-15','reason':'no estaba'}}, d['regeneradas']" 2>/dev/null \
  && ok "2.28-T36 código regenerado: compartida, y la carpeta nueva en regeneradas con día y motivo" || mal "2.28-T36 regenerado: $(uniones "${T}")"
# el motivo viene de OTRA máquina: sin controles ni separadores de línea, y acotado a 120 caracteres
# 🔴 Falla con: el saneado del motivo sin caso propio.
E="${BASE}/t228-36c"; mkdir -p "${E}/maq-s"
node -e 'const fs=require("fs"); const [,d]=process.argv; fs.mkdirSync(`${d}/maq-s-1a2b3c4d/registros`,{recursive:true}); fs.writeFileSync(`${d}/maq-s-1a2b3c4d/registros/place.json`, JSON.stringify({schema:1,day:"2026-10-15",folder:{name:"maq-s-1a2b3c4d",code:"1a2b3c4d",previous_folder:"maq-s",moved_on:"2026-10-15",code_regenerated:{on:"2026-10-15",reason:`x${String.fromCharCode(0x2028)}y${String.fromCharCode(7)}`+"z".repeat(300)}}}))' "${E}"
node -e 'const r=require(process.argv[1]).carpetasDeMaquina(process.argv[2]); const m=r.regeneradas["maq-s-1a2b3c4d"].reason; process.exit(m.length<=120 && !/[\u0000-\u001f]/.test(m) && !m.includes(String.fromCharCode(0x2028)) ? 0 : 1)' "${BAJAR}" "${E}" \
  && ok "2.28-T36 el motivo de una regeneración ajena sale sin controles y acotado" || mal "2.28-T36 el motivo ajeno no se sanea"

# ── T37 · Carpetas_SiguioRecibiendo_NoSeUne ── 🔴 Falla con: unirla con una declaración.
for por in volcado place; do
  T="${BASE}/t228-37-${por}"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
  volcado228 "${T}/b" macbook-pro "9.1-2026-10-14T0900" 2026-10-14
  place228 "${T}/b" macbook-pro-1a2b3c4d macbook-pro 2026-10-15
  if [ "${por}" = volcado ]; then volcado228 "${T}/b" macbook-pro "9.3-2026-10-16T0900" 2026-10-16
  else mkdir -p "${T}/b/blobs/corridas/macbook-pro/registros"; printf '{"schema":1,"day":"2026-10-16","install":null}\n' > "${T}/b/blobs/corridas/macbook-pro/registros/place.json"; fi
  volcado228 "${T}/b" maq-suelta "9.4-2026-10-16T0900" 2026-10-16
  bajar "${T}" "${T}/bin/az"
  echo "$(uniones "${T}")" | python3 -c "import json,sys; d=json.load(sys.stdin)['carpetas']; assert d['macbook-pro']['estado']=='siguio_recibiendo' and d['macbook-pro']['nueva'] is None, d; assert 'maq-suelta' not in d and 'macbook-pro-1a2b3c4d' not in d, d" 2>/dev/null \
    && ok "2.28-T37 la vieja recibió un ${por} después de la mudanza: siguio_recibiendo, sin unir; la que nadie declara no aparece" || mal "2.28-T37 ${por}: rc=${RC} $(uniones "${T}")"
done

# ── T23 · Bajar_ConOtraCredencial_SinHilos ─────────────────────────────────────────
# El sitio de la organización llama a bajar() con sus opciones: la cuenta, el contenedor, la SAS de LECTURA y la carpeta.
# No lee corridas-buzon.json (no hay), no mira las integraciones (apagadas), no llama a az (no hay), y baja sólo los
# volcados y los registros, nunca hilos ni cambios. La firma va en la consulta, sin cabecera Authorization.
# 🔴 Falla con: que bajar() lea corridas-buzon.json y la sesión de az: sin ellos no baja nada (y con ellos baja hilos).
rm -rf "${HOME}/.claude"   # 8.9-D2 siembra la casa de juguete a propósito; T23 mira sólo lo que escribe él
T="${BASE}/t23"; buzon "${T}/b"; SIG="firma-$$"; echo "${SIG}" > "${T}/b/sas-sig"
blob "${T}/b" "maq-a-11111111/2.1-2026-10-15T1000.json" 700
blob "${T}/b" "maq-a-11111111/2.1-2026-10-15T1000.hilo.jsonl.gz" 3000
blob "${T}/b" "maq-a-11111111/2.1-2026-10-15T1000.cambio.json.gz" 2000
blob "${T}/b" "maq-a-11111111/registros/gates.log.gz" 300
blob "${T}/b" "maq-a-11111111/v20261021T100000000Z/2.1-2026-10-15T1000.json" 720   # la 2.24: una versión más nueva
SITIO="${T}/sitio/buzon"
TYCON_MAILBOX=0 TYCON_AZ_BIN=/nonexistent/az node -e '
const { bajar } = require(process.argv[1]);
const sas = `sv=2023-11-03&sr=c&sp=rl&si=lectura&se=2099-01-01T00:00:00Z&sig=${process.argv[4]}`;
bajar({ cuenta: "acmeruns", contenedor: "corridas", credencial: { sas }, dir: process.argv[3], sinHilos: true, urlBase: process.argv[2] })
  .then(({ codigo, res }) => { console.log(JSON.stringify({ codigo, estado: res.estado, bajados: res.bajados, omitidos: res.omitidos })); process.exit(codigo); });
' "${BAJAR}" "${URL_BUZON}" "${SITIO}" "${SIG}" > "${T}/out.txt" 2> "${T}/err.txt" < /dev/null
RC=$?
if [ "${RC}" -eq 0 ] && [ -f "${SITIO}/maq-a-11111111/2.1-2026-10-15T1000.json" ] && [ -f "${SITIO}/maq-a-11111111/registros/gates.log.gz" ] \
  && [ ! -e "${SITIO}/maq-a-11111111/2.1-2026-10-15T1000.hilo.jsonl.gz" ] && [ ! -e "${SITIO}/maq-a-11111111/2.1-2026-10-15T1000.cambio.json.gz" ]; then
  ok "T23 con la SAS de lectura: bajó el volcado y el registro, ni el hilo ni el cambio"
else mal "T23 rc=${RC} · $(cat "${T}/out.txt") · $(head -3 "${T}/err.txt")"; fi
cmp -s "${T}/b/blobs/corridas/maq-a-11111111/v20261021T100000000Z/2.1-2026-10-15T1000.json" "${SITIO}/maq-a-11111111/2.1-2026-10-15T1000.json" \
  && ok "T23 con dos versiones (2.24), el sitio baja la más nueva a la ruta de siempre" || mal "T23 la versión bajada no es la más nueva"
if grep -q '"auth":"Bearer' "${T}/b/pedidos.jsonl" || ! grep -q "sig=${SIG}" "${T}/b/pedidos.jsonl"; then
  mal "T23 la firma tiene que ir en la consulta y sin cabecera Authorization: $(head -2 "${T}/b/pedidos.jsonl")"
else ok "T23 la firma va en la consulta, sin cabecera Authorization"; fi
[ ! -e "${HOME}/.claude" ] && ok "T23 no tocó la casa de esta máquina (ni índice ni sello fuera de la carpeta del sitio)" || mal "T23 escribió en la HOME de juguete"
# una SAS que escribe: no se usa, y no sale un solo pedido al buzón
T="${BASE}/t23b"; buzon "${T}/b"; echo "x" > "${T}/b/sas-sig"
TYCON_MAILBOX=0 node -e '
const { bajar } = require(process.argv[1]);
bajar({ cuenta: "acmeruns", contenedor: "corridas", credencial: { sas: "sv=1&sr=c&sp=rlw&si=p&se=2099-01-01T00:00:00Z&sig=x" }, dir: process.argv[3], urlBase: process.argv[2] })
  .then(({ codigo, res }) => { console.log(res.estado); process.exit(codigo); });
' "${BAJAR}" "${URL_BUZON}" "${T}/sitio/buzon" > "${T}/out.txt" 2>&1 < /dev/null
RC=$?
[ "${RC}" -eq 2 ] && grep -q llave_con_escritura "${T}/out.txt" && [ ! -s "${T}/b/pedidos.jsonl" ] \
  && ok "T23 una SAS que escribe no se usa: llave_con_escritura y ningún pedido al buzón" || mal "T23b rc=${RC} · $(cat "${T}/out.txt")"
# una cuenta que no tiene la forma de Azure Storage armaría otro host con la credencial adentro: no se manda nada
# (falla con armar `https://${cuenta}.blob.core.windows.net` con «host.malo/x?»)
T="${BASE}/t23c"; mkdir -p "${T}"
TYCON_MAILBOX=0 node -e '
const { bajar } = require(process.argv[1]);
bajar({ cuenta: "host.malo/x?", contenedor: "corridas", credencial: { sas: "sv=1&sr=c&sp=rl&si=p&se=2099-01-01T00:00:00Z&sig=x" }, dir: process.argv[2] })
  .then(({ codigo, res }) => { console.log(res.estado); process.exit(codigo); });
' "${BAJAR}" "${T}/sitio/buzon" > "${T}/out.txt" 2>&1 < /dev/null
RC=$?
[ "${RC}" -eq 2 ] && grep -q config_rota "${T}/out.txt" && [ ! -e "${T}/sitio" ] \
  && ok "T23 una cuenta sin la forma de Azure Storage: config_rota, sin pedir nada ni crear la carpeta" || mal "T23c rc=${RC} · $(cat "${T}/out.txt")"
# un 200 al listar que no es un listado (la página de un proxy) no es «el buzón está vacío y al día» (cazador de fallos
# silenciosos; falla con: 0 blobs, al_dia, completo true)
T="${BASE}/t23d"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token; echo 1 > "${T}/b/lista-html"
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 1 ] && [ "$(campo "${T}" estado)" = "servicio_fallo" ] && [ "$(campo "${T}" completo)" = "false" ] \
  && ok "T23 un listado que no es un listado: servicio_fallo, exit 1, completo false" || mal "T23d rc=${RC} estado=$(campo "${T}" estado) completo=$(campo "${T}" completo)"

# ── T29 ThreadsSince_FiltraPorFechaDelNombre @story-4.10 @ac-4 ─────────────────────────────────────────────────────
# --threads-since: los volcados y los registros bajan siempre; la conversación y el cambio, sólo desde esa fecha (la
# del nombre); uno cuyo nombre no trae fecha baja igual.
# 🔴 Falla con: comparar la fecha al revés o con «<=» (la del mismo día se pierde), filtrar también los .json (la
#    revisión nocturna no ve la ejecución), o tirar el nombre sin fecha (se pierde una conversación sin aviso).
T="${BASE}/t4-10-29"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
for base in 1.1-2026-10-20T1000 2.2-2026-09-22T1000 3.3-2026-10-15T0900; do
  blob "${T}/b" "equipo-deva/${base}.json" 800
  blob "${T}/b" "equipo-deva/${base}.hilo.jsonl.gz" 3000
  blob "${T}/b" "equipo-deva/${base}.cambio.json.gz" 1200
done
blob "${T}/b" "equipo-deva/raro.hilo.jsonl.gz" 900
mkdir -p "${T}/b/blobs/corridas/equipo-deva/registros"
printf '{"ts":"2026-09-16T10:00:00Z","name":"tests","status":"green"}\n' | gzip -c > "${T}/b/blobs/corridas/equipo-deva/registros/gates.log.gz"
bajar "${T}" "${T}/bin/az" --threads-since 2026-10-15
E="${T}/estado/corridas-buzon/equipo-deva"
if [ "${RC}" -eq 0 ] && [ -f "${E}/1.1-2026-10-20T1000.json" ] && [ -f "${E}/2.2-2026-09-22T1000.json" ] && [ -f "${E}/registros/gates.log.gz" ] \
   && [ -f "${E}/1.1-2026-10-20T1000.hilo.jsonl.gz" ] && [ -f "${E}/1.1-2026-10-20T1000.cambio.json.gz" ] && [ -f "${E}/raro.hilo.jsonl.gz" ] \
   && [ -f "${E}/3.3-2026-10-15T0900.hilo.jsonl.gz" ] && [ -f "${E}/3.3-2026-10-15T0900.cambio.json.gz" ] \
   && [ ! -e "${E}/2.2-2026-09-22T1000.hilo.jsonl.gz" ] && [ ! -e "${E}/2.2-2026-09-22T1000.cambio.json.gz" ] \
   && [ "$(campo "${T}" omitidos)" = "2" ] && [ "$(campo "${T}" completo)" = "true" ] \
   && ! grep -q '2.2-2026-09-22T1000.hilo' "${T}/b/pedidos.jsonl"; then
  ok "4.10-T29 ThreadsSince_FiltraPorFechaDelNombre: volcados y registros siempre, conversaciones desde la fecha (la del mismo día incluida), la sin fecha baja; omitidos 2, completo true"
else
  mal "4.10-T29 rc=${RC} omitidos=$(campo "${T}" omitidos) completo=$(campo "${T}" completo) · $(ls "${E}" 2>&1 | tr '\n' ' ')"
fi

# ── T29d ThreadsSince_SinCerrarConSuFecha @story-4.10 @ac-4 ────────────────────────────────────────────────────────
# Una ejecución sin cerrar se sube como `<story>-<AAAAMMDDhhmmss>-sin-cerrar`: la fecha va pegada, y también cuenta.
# 🔴 Falla con: no leer esa forma (las sin cerrar viejas bajan todas las noches: medido en el buzón real, 13 de
#    septiembre en una bajada «desde hoy») o leerla corrida un día.
T="${BASE}/t4-10-29d"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
for base in 1.11-20260930105410-sin-cerrar 5.3-20261015000001-sin-cerrar; do
  blob "${T}/b" "equipo-deva/${base}.json" 800
  blob "${T}/b" "equipo-deva/${base}.hilo.jsonl.gz" 3000
done
bajar "${T}" "${T}/bin/az" --threads-since 2026-10-15
E="${T}/estado/corridas-buzon/equipo-deva"
[ "${RC}" -eq 0 ] && [ -f "${E}/1.11-20260930105410-sin-cerrar.json" ] && [ ! -e "${E}/1.11-20260930105410-sin-cerrar.hilo.jsonl.gz" ] \
  && [ -f "${E}/5.3-20261015000001-sin-cerrar.hilo.jsonl.gz" ] && [ "$(campo "${T}" omitidos)" = "1" ] \
  && ok "4.10-T29d una sin cerrar se filtra por su fecha pegada: la vieja no baja su conversación, la del mismo día sí" \
  || mal "4.10-T29d rc=${RC} omitidos=$(campo "${T}" omitidos) · $(ls "${E}" 2>&1 | tr '\n' ' ')"

# ── T29b ThreadsSince_FechaMalFormada @story-4.10 @ac-4 ─────────────────────────────────────────────────────────────
# 🔴 Falla con: tomar «22/10/2026» como fecha, o una fecha con forma pero imposible (2026-13-01, 2026-02-31): la
#    comparación de texto deja pasar o tira todo sin decirlo.
T="${BASE}/t4-10-29b"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "equipo-deva/1.1-2026-10-20T1000.json" 800
mal29b=""
for f in 22/10/2026 2026-13-01 2026-02-31; do
  bajar "${T}" "${T}/bin/az" --threads-since "${f}"
  { [ "${RC}" -eq 2 ] && [ "$(campo "${T}" estado)" = "config_rota" ]; } || mal29b="${mal29b} ${f}:rc=${RC}"
done
[ -z "${mal29b}" ] && [ "$(gets "${T}/b")" = "0" ] \
  && ok "4.10-T29b una fecha que no es una AAAA-MM-DD real: config_rota, exit 2, sin bajar nada" \
  || mal "4.10-T29b${mal29b} gets=$(gets "${T}/b")"

# ── T29c ThreadsSince_SinValor @story-4.10 @ac-4 ────────────────────────────────────────────────────────────────────
# 🔴 Falla con: tomar la opción sin valor como «sin filtro» (una variable vacía en el YAML del nocturno bajaría todas las
#    conversaciones del buzón, gigas, con salida 0), o aceptar la opción que viene detrás como si fuera la fecha.
T="${BASE}/t4-10-29c"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "equipo-deva/1.1-2026-10-20T1000.hilo.jsonl.gz" 800
bajar "${T}" "${T}/bin/az" --threads-since
rc29c="${RC}"; est29c="$(campo "${T}" estado)"
bajar "${T}" "${T}/bin/az" --threads-since --budget-ms 600000
[ "${rc29c}" -eq 2 ] && [ "${est29c}" = "config_rota" ] && [ "${RC}" -eq 2 ] && [ "$(campo "${T}" estado)" = "config_rota" ] && [ "$(gets "${T}/b")" = "0" ] \
  && ok "4.10-T29c --threads-since sin valor, al final o con otra opción detrás: config_rota, exit 2, sin bajar nada" \
  || mal "4.10-T29c al final rc=${rc29c} estado=${est29c} · con otra opción detrás rc=${RC} estado=$(campo "${T}" estado) gets=$(gets "${T}/b")"

# ── T30 SinThreadsSince_IgualQueHoy @story-4.10 @ac-25 ──────────────────────────────────────────────────────────────
# 🔴 Falla con: un valor por defecto de la fecha (el tablero y el sitio dejarían de ver conversaciones viejas), o que
#    --threads-since ablande --no-threads. `--no-threads` solo lo fija 2.12-T12 y `--instincts`, sus casos de esta suite.
T="${BASE}/t4-10-30"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
for base in 1.1-2026-10-20T1000 2.2-2026-09-22T1000; do
  blob "${T}/b" "equipo-deva/${base}.json" 800
  blob "${T}/b" "equipo-deva/${base}.hilo.jsonl.gz" 3000
  blob "${T}/b" "equipo-deva/${base}.cambio.json.gz" 1200
done
bajar "${T}" "${T}/bin/az"
todo30="$(ls "${T}/estado/corridas-buzon/equipo-deva" 2>/dev/null | grep -c 'gz$')"; omit30="$(campo "${T}" omitidos)"
T2="${BASE}/t4-10-30b"; buzon "${T2}/b"; config "${T2}/cfg.json"; az_doble "${T2}" token
cp -R "${T}/b/blobs" "${T2}/b/"
bajar "${T2}" "${T2}/bin/az" --no-threads --threads-since 2026-10-15
sin30="$(ls "${T2}/estado/corridas-buzon/equipo-deva" 2>/dev/null | grep -c 'gz$')"
[ "${todo30}" = "4" ] && [ "${omit30}" = "0" ] && [ "${sin30}" = "0" ] && [ "$(campo "${T2}" omitidos)" = "4" ] \
  && ok "4.10-T30 SinThreadsSince_IgualQueHoy: sin la opción bajan las 4 partes; con --no-threads ninguna, aunque venga --threads-since" \
  || mal "4.10-T30 sin opción: ${todo30} partes, omitidos ${omit30} · con --no-threads: ${sin30} partes, omitidos $(campo "${T2}" omitidos)"

# ── Bajar_SinDirBuzon_ComoAntes · la carpeta por parámetro, y sin él como siempre ─────────────────────────────────
# La revisión de ejecuciones le pasa su carpeta a bajar() en `dirBuzon`; los demás (los nocturnos, el tablero, esta
# línea de comandos) no la pasan y siguen leyendo TYCON_MAILBOX_DIR, o la carpeta de siempre bajo la HOME.
# 🔴 Falla con: que el parámetro no gane sobre la variable (la revisión leería otra carpeta que la que bajó), o que sin
#    él la bajada deje de seguir a la variable o a la carpeta de siempre.
T="${BASE}/t-dirbuzon"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
blob "${T}/b" "maq-d-44444444/2.1-2026-10-15T1000.json" 600
# bajar_js <home> <dirBuzon o vacío> [VAR=valor…] → corre bajar() desde node; RC y <caso>/js-err.txt
bajar_js() {
  local h="$1" d="$2"; shift 2
  env -u TYCON_MAILBOX_DIR HOME="${h}" TYCON_MAILBOX_JSON="${T}/cfg.json" TYCON_MAILBOX_URL_BASE="${URL_BUZON}" TYCON_AZ_BIN="${T}/bin/az" "$@" node -e '
const { bajar } = require(process.argv[1]);
const antes = JSON.stringify(process.env);
bajar(process.argv[2] ? { dirBuzon: process.argv[2], sinHilos: true } : { sinHilos: true })
  .then(({ codigo }) => { if (JSON.stringify(process.env) !== antes) { console.error("bajar() cambió el ambiente"); process.exit(3); } process.exit(codigo); });
' "${BAJAR}" "${d}" > /dev/null 2> "${T}/js-err.txt" < /dev/null
  RC=$?
}
VOLCADO="maq-d-44444444/2.1-2026-10-15T1000.json"
mkdir -p "${T}/h1" "${T}/h2" "${T}/h3"
bajar_js "${T}/h1" "" TYCON_MAILBOX_DIR="${T}/por-variable"
[ "${RC}" -eq 0 ] && [ -f "${T}/por-variable/${VOLCADO}" ] && ok "Bajar_SinDirBuzon_ComoAntes: sin el parámetro, baja a TYCON_MAILBOX_DIR" \
  || mal "Bajar_SinDirBuzon_ComoAntes (variable): rc=${RC} · $(head -2 "${T}/js-err.txt")"
bajar_js "${T}/h2" ""
SIEMPRE="$(cd "${T}/h2" && find . -path "*corridas-buzon/${VOLCADO}" 2>/dev/null | head -1)"
[ "${RC}" -eq 0 ] && [ -n "${SIEMPRE}" ] && ok "Bajar_SinDirBuzon_ComoAntes: sin el parámetro ni la variable, baja a la carpeta de siempre bajo la HOME (${SIEMPRE#./})" \
  || mal "Bajar_SinDirBuzon_ComoAntes (de siempre): rc=${RC} · $(head -2 "${T}/js-err.txt")"
bajar_js "${T}/h3" "${T}/por-parametro" TYCON_MAILBOX_DIR="${T}/no-aca"
[ "${RC}" -eq 0 ] && [ -f "${T}/por-parametro/${VOLCADO}" ] && [ ! -e "${T}/no-aca/${VOLCADO}" ] \
  && ok "Bajar_SinDirBuzon_ComoAntes: con dirBuzon gana el parámetro sobre la variable, y el ambiente queda igual" \
  || mal "Bajar_SinDirBuzon_ComoAntes (parámetro): rc=${RC} · $(head -2 "${T}/js-err.txt")"

# ── Los archivos de cada merge (story 8.132, tanda B) ───────────────────────────────────────────────────────────
# merge_doc <archivo> <sha> <project> <repo> <vueltas|null> <ts> — un archivo 2.0 como el que escribe retro-heartbeat.js
merge_doc() {
  mkdir -p "$(dirname "$1")"
  node -e '
const { METRICS } = require(process.argv[1]);
const [, , archivo, sha, project, repo, vueltas, ts] = process.argv;
const metrics = {};
for (const k of Object.keys(METRICS)) metrics[k] = { value: null, unavailable_reason: "no la mide esta prueba" };
metrics.advisor_rerun_loop_iterations = vueltas === "null" ? { value: null, unavailable_reason: "sin volcado" } : { value: Number(vueltas) };
require("fs").writeFileSync(archivo, JSON.stringify({ schema_version: "2.0", project, captured_at: ts.slice(0, 10), ts, repo, merge_commit: sha, story: "8.1", generated_by: ["retro", "latido.js"].join("-"), metrics }, null, 2) + "\n");
' "${RAIZ}/scripts/lib/dashboard-metrics.js" "$@"
}
SHA_A="aaaaaaa1111111111111111111111111111111111"; SHA_A="${SHA_A:0:40}"
SHA_B="bbbbbbb2222222222222222222222222222222222"; SHA_B="${SHA_B:0:40}"

# ── T19 Download_MergesTo_OnePerMerge @story-8.132 @ac-12 ──
# 🔴 rojo previo: la bajada no conoce `<maquina>/merges/…` (los cuenta en ignorados) o no deja un archivo por merge:
#    el repetido de dos máquinas entraría dos veces, o ganaría la versión vieja de un archivo que se volvió a subir.
T="${BASE}/t8132-19"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
M="${T}/b/blobs/corridas"
# el mismo merge desde dos máquinas, cada una con su ruta: el de maq-b trae las vueltas
merge_doc "${M}/maq-a/merges/metrics-2026-10-25-tycon-harness-8.1-aaaaaaa.json" "${SHA_A}" tycon-harness /srv/maq-a/tycon-harness null 2026-10-25T12:00:00.000Z
merge_doc "${M}/maq-b/merges/metrics-2026-10-25-tycon-harness-wt-8.1-aaaaaaa.json" "${SHA_A}" tycon-harness-wt /srv/maq-b/tycon-harness-wt 2 2026-10-25T10:00:00.000Z
# otro merge que se volvió a subir: la versión más nueva trae 1 vuelta, la vieja ninguna
merge_doc "${M}/maq-a/merges/metrics-2026-10-25-tycon-harness-8.1-bbbbbbb.json" "${SHA_B}" tycon-harness /srv/maq-a/tycon-harness null 2026-10-25T09:00:00.000Z
merge_doc "${M}/maq-a/merges/v20261025T120000000Z/metrics-2026-10-25-tycon-harness-8.1-bbbbbbb.json" "${SHA_B}" tycon-harness /srv/maq-a/tycon-harness 1 2026-10-25T13:00:00.000Z
blob "${T}/b" "maq-a/2.1-2026-10-25T1000.json" 600
bajar "${T}" "${T}/bin/az" --merges-to "${T}/nuevos"
QUEDAN="$(cd "${T}/nuevos" 2>/dev/null && ls metrics-*.json 2>/dev/null | sort | tr '\n' ' ')"
vueltas_de() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['metrics']['advisor_rerun_loop_iterations']['value'])" "$1" 2>/dev/null; }
[ "${RC}" -eq 0 ] && [ "$(echo "${QUEDAN}" | wc -w | tr -d ' ')" = "2" ] && ok "T19 dos máquinas y una versión nueva: quedan 2 archivos, uno por merge" || mal "T19 rc=${RC}, quedaron: ${QUEDAN} · $(head -3 "${T}/err.txt")"
[ "$(vueltas_de "${T}/nuevos/metrics-2026-10-25-tycon-harness-wt-8.1-aaaaaaa.json")" = "2" ] && [ ! -e "${T}/nuevos/metrics-2026-10-25-tycon-harness-8.1-aaaaaaa.json" ] \
  && ok "T19 el repetido de dos máquinas: gana el que trae las vueltas" || mal "T19 repetido: ${QUEDAN}"
[ "$(vueltas_de "${T}/nuevos/metrics-2026-10-25-tycon-harness-8.1-bbbbbbb.json")" = "1" ] && ok "T19 el que se volvió a subir: baja la versión más nueva" || mal "T19 versión: vueltas=$(vueltas_de "${T}/nuevos/metrics-2026-10-25-tycon-harness-8.1-bbbbbbb.json")"
[ "$(campo "${T}" merges)" = '{"bajados": 2, "repetidos": 1}' ] && ok "T19 la salida cuenta merges: {bajados: 2, repetidos: 1}" || mal "T19 merges=$(campo "${T}" merges)"
[ "$(campo "${T}" ignorados)" = "0" ] && [ "$(campo "${T}" completo)" = "true" ] && ok "T19 ningún archivo de merges cuenta como ignorado y la bajada sale completa" || mal "T19 ignorados=$(campo "${T}" ignorados) completo=$(campo "${T}" completo)"

# ── T20 Download_NoFlag_MergesIgnored @story-8.132 @ac-12 ──
# 🔴 rojo previo: sin `--merges-to` la bajada igual escribe los merges (al espejo o a otra carpeta), o deja de contarlos.
T="${BASE}/t8132-20"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
merge_doc "${T}/b/blobs/corridas/maq-a/merges/metrics-2026-10-25-tycon-harness-8.1-aaaaaaa.json" "${SHA_A}" tycon-harness /srv/maq-a/tycon-harness 1 2026-10-25T12:00:00.000Z
merge_doc "${T}/b/blobs/corridas/maq-a/merges/v20261025T120000000Z/metrics-2026-10-25-tycon-harness-8.1-aaaaaaa.json" "${SHA_A}" tycon-harness /srv/maq-a/tycon-harness 2 2026-10-25T13:00:00.000Z
blob "${T}/b" "maq-a/2.1-2026-10-25T1000.json" 600
bajar "${T}" "${T}/bin/az"
[ "${RC}" -eq 0 ] && [ "$(campo "${T}" ignorados)" = "2" ] && ok "T20 sin --merges-to, los dos archivos de merges se cuentan en ignorados" || mal "T20 rc=${RC} ignorados=$(campo "${T}" ignorados)"
[ -z "$(find "${T}/estado" -path '*merges*' 2>/dev/null)" ] && [ "$(campo "${T}" bajados)" = "1" ] && ok "T20 y ninguno llega al disco (sólo baja la ejecución)" || mal "T20 en disco: $(find "${T}/estado" -path '*merges*' | head -3) · bajados=$(campo "${T}" bajados)"

# ── T19b Download_MergesTo_SinValor @story-8.132 @ac-12 ──
# 🔴 rojo previo: `--merges-to` sin valor (una variable vacía en el YAML) se toma como «sin opción» y los merges van a
#    ignorados con la bajada completa; con otra opción detrás, esa opción se toma por la carpeta.
T="${BASE}/t8132-19b"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
merge_doc "${T}/b/blobs/corridas/maq-a/merges/metrics-2026-10-25-tycon-harness-8.1-aaaaaaa.json" "${SHA_A}" tycon-harness /srv/maq-a/tycon-harness 1 2026-10-25T12:00:00.000Z
bajar "${T}" "${T}/bin/az" --merges-to
rc19b="${RC}"; est19b="$(campo "${T}" estado)"
bajar "${T}" "${T}/bin/az" --merges-to --budget-ms 600000
[ "${rc19b}" -eq 2 ] && [ "${est19b}" = "config_rota" ] && [ "${RC}" -eq 2 ] && [ "$(campo "${T}" estado)" = "config_rota" ] && [ "$(gets "${T}/b")" = "0" ] \
  && ok "T19b --merges-to sin valor, al final o con otra opción detrás: config_rota, exit 2, sin bajar nada" \
  || mal "T19b al final rc=${rc19b} estado=${est19b} · con otra opción detrás rc=${RC} estado=$(campo "${T}" estado) gets=$(gets "${T}/b")"

# ── T19c Download_MergesTo_InvalidNeverWins @story-8.132 @ac-12 ──
# 🔴 rojo previo: se elige uno por merge ANTES de validar: un archivo que no es 2.0 válido con más vueltas le gana al
#    legítimo del mismo merge, `juntar` lo descarta después y ese merge se pierde esa noche.
T="${BASE}/t8132-19c"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
M="${T}/b/blobs/corridas"
merge_doc "${M}/maq-a/merges/metrics-2026-10-25-tycon-harness-8.1-aaaaaaa.json" "${SHA_A}" tycon-harness /srv/maq-a/tycon-harness 1 2026-10-25T12:00:00.000Z
merge_doc "${M}/maq-b/merges/metrics-2026-10-25-tycon-harness-wt-8.1-aaaaaaa.json" "${SHA_A}" tycon-harness-wt /srv/maq-b/tycon-harness-wt 3 2026-10-25T13:00:00.000Z
python3 -c "import json,sys;p=sys.argv[1];d=json.load(open(p));d['schema_version']='1.0';json.dump(d,open(p,'w'))" "${M}/maq-b/merges/metrics-2026-10-25-tycon-harness-wt-8.1-aaaaaaa.json"
blob "${T}/b" "maq-a/2.1-2026-10-25T1000.json" 600
bajar "${T}" "${T}/bin/az" --merges-to "${T}/nuevos"
[ "${RC}" -eq 0 ] && [ "$(vueltas_de "${T}/nuevos/metrics-2026-10-25-tycon-harness-8.1-aaaaaaa.json")" = "1" ] && [ ! -e "${T}/nuevos/metrics-2026-10-25-tycon-harness-wt-8.1-aaaaaaa.json" ] \
  && [ "$(campo "${T}" merges)" = '{"bajados": 1, "repetidos": 0, "invalidos": 1}' ] \
  && ok "T19c el que no es 2.0 válido no le gana al legítimo: queda el de 1 vuelta y se cuenta inválido" \
  || mal "T19c rc=${RC} merges=$(campo "${T}" merges) · $(ls "${T}/nuevos" 2>/dev/null | tr '\n' ' ')"

# ── T32 NotMeasured_DownloadForcedToFail @story-8.132 @ac-22 ──
# 🔴 rojo previo: con la bajada rechazada, el nocturno mide `first_pass_ratio` con lo que había versionado en git (un
#    número parcial que parece bueno), o la constancia dice «completa».
T="${BASE}/t8132-32"; buzon "${T}/b"; config "${T}/cfg.json"; az_doble "${T}" token
merge_doc "${T}/b/blobs/corridas/maq-a/merges/metrics-2026-10-25-tycon-harness-8.1-aaaaaaa.json" "${SHA_A}" tycon-harness /srv/maq-a/tycon-harness 1 2026-10-25T12:00:00.000Z
echo 403 > "${T}/b/modo-lista"
bajar "${T}" "${T}/bin/az" --merges-to "${T}/nuevos"
RC_BAJADA="${RC}"; cp "${T}/out.json" "${T}/bajada-resultado.json"
DASH="${T}/repo-datos/.dashboard"
merge_doc "${DASH}/metrics-2026-10-20-tycon-harness-8.1-bbbbbbb.json" "${SHA_B}" tycon-harness /srv/maq-a/tycon-harness 1 2026-10-20T12:00:00.000Z
node "${RAIZ}/scripts/lib/merge-metrics.js" juntar --from "${T}/nuevos" --to "${DASH}/merges" --result "${T}/bajada-resultado.json" > "${T}/juntar.out" 2>&1
RC_JUNTAR=$?
COMPLETA="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['completo'])" "${DASH}/merges/bajada.json" 2>/dev/null)"
[ "${RC_BAJADA}" -eq 0 ] && [ "${RC_JUNTAR}" -eq 0 ] && [ "${COMPLETA}" = "False" ] && ok "T32 la bajada rechazada (403) deja la constancia incompleta" || mal "T32 bajada rc=${RC_BAJADA} juntar rc=${RC_JUNTAR} completo=${COMPLETA} · $(cat "${T}/juntar.out")"
mkdir -p "${T}/r/specs"; git -C "${T}/r" init -q 2>/dev/null; printf -- '---\nstory: 1.1\nstatus: done\n---\n' > "${T}/r/specs/story-1.1.md"
git -C "${T}/r" add -A >/dev/null 2>&1
GIT_AUTHOR_DATE='2026-10-01T12:00:00Z' GIT_COMMITTER_DATE='2026-10-01T12:00:00Z' \
  git -C "${T}/r" -c user.name=t -c user.email=t@t -c maintenance.auto=false -c gc.auto=0 commit -qm x >/dev/null 2>&1
TYCON_SKILLS_DIR=/nonexistent-8132 node "${RAIZ}/scripts/metrics/sdlc-stage-metrics.js" --repo "${T}/r" --dashboard "${DASH}" --merges-receipt "${DASH}/merges/bajada.json" --json > "${T}/sdlc.json" 2> "${T}/sdlc.err"
RC_SDLC=$?
FP="$(python3 -c "
import json,sys
g=json.load(open(sys.argv[1]))['global']
fp=g['first_pass_ratio']
print('null' if fp.get('value', 'x') is None and 'num' not in fp else 'num=%s' % fp.get('num'), '|', ' · '.join(g.get('not_measured') or []))" "${T}/sdlc.json" 2>&1)"
[ "${RC_SDLC}" -eq 0 ] && [[ "${FP}" == null* ]] && [[ "${FP}" == *"no medido: la bajada de los merges"* ]] \
  && ok "T32 first_pass_ratio null con «no medido: la bajada de los merges…», nunca el número de los versionados" || mal "T32 sdlc rc=${RC_SDLC}: ${FP} · $(head -2 "${T}/sdlc.err")"

# ── T24 · esta suite NO toca el tablero del repo (ver la cabecera) ───────────────────────────────────────────────
[ "$(huella "${ENTREGABLE_SEIS}")" = "${HUELLA_SEIS_ANTES}" ] && ok "T24 la suite no tocó artifacts/tablero-del-arnes.html" \
  || mal "T24 la suite ESCRIBIÓ artifacts/tablero-del-arnes.html — algún caso genera la página del equipo sin --output a un temporal"

echo
[ "${FALLOS}" -eq 0 ] && { echo "bajar-corridas: todo verde"; exit 0; } || { echo "${FALLOS} fallo(s)"; exit 1; }
