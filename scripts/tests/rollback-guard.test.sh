#!/usr/bin/env bash
# Prueba de rollback-guard.sh — el freno que impide promover a producción un paquete MENOR que
# el instalado. Sin red: un `curl` de mentira en PATH contesta según lo que el caso pide, y
# `sleep` no espera. Lo que se prueba: que se NIEGA sólo ante un retroceso (2), que deja pasar
# igual/mayor/primera instalación (0), y que cualquier "no pude mirar" es 1, nunca 0.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
G="$AQUI/scripts/ci/rollback-guard.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; ok(){ echo "✅ retroceso: $1"; }; no(){ echo "❌ retroceso: $1"; fallos=$((fallos+1)); }
for req in jq unzip zip; do command -v "$req" >/dev/null || { echo "⚠️ retroceso: falta $req — suite salteada (no es verde)"; exit 0; }; done

STUB="$TMP/stub"; mkdir -p "$STUB"; export STUB_DIR="$TMP"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/sleep"; chmod +x "$STUB/sleep"
cat > "$STUB/curl" <<'STUB'
#!/usr/bin/env bash
url=""; hdr=""; out=""
while [ $# -gt 0 ]; do case "$1" in -D) hdr="$2"; shift;; -o) out="$2"; shift;; -w) shift;; http*) url="$1";; esac; shift; done
if echo "$url" | grep '/api/auth/login' >/dev/null; then
  code=$(cat "$STUB_DIR/login.code" 2>/dev/null || echo 200)
  [ "$code" = "401" ] && echo '{"error":"Invalid credentials"}' > "$out"
  [ "$code" = "200" ] && { printf 'HTTP/1.1 200 OK\r\nSet-Cookie: admin_token=tok; Path=/\r\n\r\n' > "$hdr"; echo '{}' > "$out"; }
  printf '%s' "$code"; [ "$code" = "000" ] && exit 7; exit 0
fi
if echo "$url" | grep '/api/admin/plugins' >/dev/null; then cat "$STUB_DIR/plugins.json"; exit 0; fi
if echo "$url" | grep '/api/custom-forms' >/dev/null; then cat "$STUB_DIR/forms.json"; exit 0; fi
exit 1
STUB
chmod +x "$STUB/curl"; export PATH="$STUB:$PATH"
gp(){ bash "$G" plugin http://stub u p totorabackend "$1" >"$TMP/out" 2>"$TMP/err"; }
gf(){ bash "$G" forms http://stub u p "$1" >"$TMP/out" 2>"$TMP/err"; }

# ── plugin: instalada 1.0.214 (default), 1.0.213 cargada pero no default
echo 200 > "$TMP/login.code"
echo '[{"name":"totorabackend","version":"1.0.214","isActive":true,"isDefault":true},{"name":"totorabackend","version":"1.0.213","isActive":true,"isDefault":false},{"name":"otro","version":"9.9.9","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"
gp 1.0.215; rc=$?; [ "$rc" -eq 0 ] && ok "plugin: paquete MAYOR que la instalada → 0 (puede subir)" || no "plugin: mayor salió $rc: $(cat "$TMP/err" "$TMP/out")"
gp 1.0.214; rc=$?; [ "$rc" -eq 0 ] && ok "plugin: paquete IGUAL → 0 (el despliegue lo va a deduplicar)" || no "plugin: igual salió $rc"
gp 1.0.213; rc=$?; [ "$rc" -eq 2 ] && ok "🔴 plugin: paquete MENOR (1.0.213 < 1.0.214) → 2, ME NIEGO" || no "🔴 plugin: dejó pasar un retroceso (salió $rc)"
grep -q "ME NIEGO" "$TMP/out" && grep -q "1.0.214" "$TMP/out" && ok "…y dice cuál está instalada y por qué se niega" || no "el mensaje no explica: $(cat "$TMP/out")"
gp 1.0.9; rc=$?; [ "$rc" -eq 2 ] && ok "plugin: compara por versión, no por texto (1.0.9 < 1.0.214)" || no "🔴 plugin: comparó como texto (1.0.9 salió $rc)"
# la que cuenta es la DEFAULT: si la default es la vieja y la nueva está cargada sin ser default, subir la nueva NO es retroceso
echo '[{"name":"totorabackend","version":"1.0.213","isActive":true,"isDefault":true},{"name":"totorabackend","version":"1.0.214","isActive":false,"isDefault":false}]' > "$TMP/plugins.json"
gp 1.0.214; rc=$?; [ "$rc" -eq 0 ] && ok "plugin: la instalada es la DEFAULT (1.0.213), no la más alta cargada" || no "🔴 plugin: miró la versión equivocada (salió $rc)"
echo '[{"name":"otro","version":"9.9.9","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"
gp 1.0.1; rc=$?; [ "$rc" -eq 0 ] && ok "plugin: no instalado → primera versión, puede subir" || no "plugin: primera instalación salió $rc"
echo 'esto no es json' > "$TMP/plugins.json"
gp 1.0.215; rc=$?; [ "$rc" -eq 1 ] && ok "plugin: respuesta ilegible → 1 (no pude mirar ≠ puede subir)" || no "🔴 plugin: respuesta ilegible salió $rc"
echo '[{"name":"totorabackend","version":"rara","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"
gp 1.0.215; rc=$?; [ "$rc" -eq 1 ] && ok "plugin: versión instalada sin forma de versión → 1" || no "🔴 plugin: versión rara salió $rc"
echo '[{"name":"totorabackend","version":"1.0.214","isActive":true,"isDefault":true}]' > "$TMP/plugins.json"
gp abc; rc=$?; [ "$rc" -eq 1 ] && ok "plugin: versión del paquete sin forma de versión → 1" || no "🔴 plugin: paquete 'abc' salió $rc"
echo 000 > "$TMP/login.code"
gp 1.0.215; rc=$?; [ "$rc" -eq 1 ] && ok "plugin: login caído (4 intentos) → 1" || no "🔴 plugin: sin poder entrar salió $rc"
echo 401 > "$TMP/login.code"
gp 1.0.215; rc=$?; [ "$rc" -eq 1 ] && ok "plugin: clave mala → 1, sin reintentar" || no "🔴 plugin: clave mala salió $rc"

# ── forms: 2 ZIPs con manifest
echo 200 > "$TMP/login.code"; Z="$TMP/zips"; mkdir -p "$Z"
mk(){ ( cd "$TMP" && jq -nc --arg f "$1" --arg v "$2" '{forms:[{formName:$f,version:$v}]}' > manifest.json && zip -q "$Z/$1.zip" manifest.json && rm manifest.json ); }
mk form-uno 1.0.10; mk form-dos 2.3.0
echo '[{"formName":"form-uno","currentVersion":"1.0.9"},{"formName":"form-dos","currentVersion":"2.3.0"}]' > "$TMP/forms.json"
gf "$Z"; rc=$?; [ "$rc" -eq 0 ] && ok "forms: uno mayor y otro igual → 0" || no "forms: el caso bueno salió $rc: $(cat "$TMP/err" "$TMP/out")"
echo '[{"formName":"form-uno","currentVersion":"1.0.11"},{"formName":"form-dos","currentVersion":"2.3.0"}]' > "$TMP/forms.json"
gf "$Z"; rc=$?; [ "$rc" -eq 2 ] && ok "🔴 forms: UN formulario menor que el instalado → 2, ME NIEGO" || no "🔴 forms: dejó pasar un retroceso (salió $rc)"
grep -q "form-uno" "$TMP/out" && grep -q "1.0.11" "$TMP/out" && ok "…y nombra el formulario y la versión instalada" || no "no nombró el retroceso: $(cat "$TMP/out")"
echo '[{"formName":"form-dos","currentVersion":"2.2.0"}]' > "$TMP/forms.json"
gf "$Z"; rc=$?; [ "$rc" -eq 0 ] && ok "forms: uno no instalado (primera vez) y otro mayor → 0" || no "forms: primera instalación salió $rc"
echo '{"forms":[{"formName":"form-uno","currentVersion":"1.0.10"},{"formName":"form-dos","currentVersion":"2.3.1"}]}' > "$TMP/forms.json"
gf "$Z"; rc=$?; [ "$rc" -eq 2 ] && ok "forms: lista envuelta en {forms:[…]} también se lee (y caza el retroceso de form-dos)" || no "🔴 forms: lista envuelta salió $rc"
echo 'no json' > "$TMP/forms.json"
gf "$Z"; rc=$?; [ "$rc" -eq 1 ] && ok "forms: respuesta ilegible → 1" || no "🔴 forms: respuesta ilegible salió $rc"
mkdir -p "$TMP/vacio"; gf "$TMP/vacio"; rc=$?; [ "$rc" -eq 1 ] && ok "forms: directorio sin ZIPs → 1 (nada que promover no es verde)" || no "🔴 forms: sin ZIPs salió $rc"
( cd "$TMP" && echo '{}' > manifest.json && zip -q "$Z/roto.zip" manifest.json && rm manifest.json )
echo '[]' > "$TMP/forms.json"; gf "$Z"; rc=$?; [ "$rc" -eq 1 ] && ok "forms: un manifest sin formName/version → 1" || no "🔴 forms: manifest roto salió $rc"
bash "$G" otro http://stub u p x >/dev/null 2>&1; rc=$?; [ "$rc" -eq 1 ] && ok "modo desconocido → 1" || no "modo desconocido salió $rc"

echo "─────────────"
if [ "$fallos" -eq 0 ]; then echo "✅ rollback-guard: todo verde"; exit 0; else echo "❌ rollback-guard: $fallos falla(s)"; exit 1; fi
