# fake-plugin-host.sh — el host de plugins simulado de las suites de deploy-plugin.sh. Se carga con `.`.
#
# 🔴 POR QUÉ ES UN AYUDANTE APARTE. Un `curl` falso que indexa la respuesta sólo por ruta no distingue el método, no
# guarda lo que se manda y no deja rastro de qué se llamó. Con eso un caso puede inventar una respuesta que el host
# nunca da —que `GET /api/admin/plugins/{id}` trae `missingSettings`— y pasar en verde certificando el defecto que
# tiene que cazar. Y una negativa («no se llamó a activar») sólo se podría afirmar mirando lo que el guion imprime,
# no lo que pidió. Las dos suites del guion de despliegue usan este mismo host.
#
# Uso: con `$TMP` definido, `fph_init` escribe el `curl` falso en `$TMP/bin`. El guion se corre con
# `PATH="$TMP/bin:$PATH" RESP=<carpeta de respuestas> LLAMADAS=<archivo>`.
#   resp <ruta> <cuerpo> <código>             respuesta para cualquier método
#   resp_m <MÉTODO> <ruta> <cuerpo> <código>  respuesta sólo para ese método (gana sobre la de cualquier método)
#   resp_seq <ruta> <cuerpo> <código>         la próxima respuesta de esa ruta (la 1.ª llamada usa la 1.ª, …)
#   fph_zip <archivo.zip>                     un ZIP de verdad con plugin.json adentro; sale 1 si no hay con qué
# Cada llamada queda en `$LLAMADAS`, en orden: «MÉTODO /ruta», y debajo «  cuerpo: …» si mandó datos. El cuerpo del
# ingreso no se anota: lleva la clave.

fph_clave() { echo "$1" | sed 's#[^a-zA-Z0-9]#_#g'; }

fph_init() {
  mkdir -p "$TMP/bin"
  cat > "$TMP/bin/curl" <<'CURL'
#!/usr/bin/env bash
url=""; hdr=""; metodo=""; datos=""
while [ $# -gt 0 ]; do
  case "$1" in
    -D) hdr="$2"; shift ;;
    -X) metodo="$2"; shift ;;
    -F|--data|--data-raw|-d) datos="${datos:+$datos & }$2"; [ -n "$metodo" ] || metodo=POST; shift ;;
    -H|-w|-o) shift ;;
    http*) url="$1" ;;
  esac
  shift
done
[ -n "$metodo" ] || metodo=GET
ruta="/${url#*://*/}"
clave=$(echo "$ruta" | sed 's#[^a-zA-Z0-9]#_#g')
if [ -n "${LLAMADAS:-}" ]; then
  printf '%s %s\n' "$metodo" "$ruta" >> "$LLAMADAS"
  case "$ruta" in */api/auth/login) ;; *) [ -n "$datos" ] && printf '  cuerpo: %s\n' "$datos" >> "$LLAMADAS" ;; esac
fi
case "$url" in
  */api/auth/login) [ -n "$hdr" ] && printf 'HTTP/1.1 200 OK\r\nSet-Cookie: admin_token=tok; Path=/\r\n\r\n' > "$hdr" ;;
esac
f=""
if [ -f "$RESP/seq_$clave.1" ]; then
  n=$(( $(cat "$RESP/seq_$clave.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$RESP/seq_$clave.n"
  [ -f "$RESP/seq_$clave.$n" ] && f="$RESP/seq_$clave.$n"
fi
[ -n "$f" ] || { [ -f "$RESP/${metodo}_$clave" ] && f="$RESP/${metodo}_$clave"; }
[ -n "$f" ] || { [ -f "$RESP/$clave" ] && f="$RESP/$clave"; }
[ -n "$f" ] || f="$RESP/default"
if [ -f "$f" ]; then cat "$f"; else printf '{}\n404\n'; fi
CURL
  chmod +x "$TMP/bin/curl"
}

resp()   { mkdir -p "$TMP/respuestas"; printf '%s\n%s\n' "$2" "$3" > "$TMP/respuestas/$(fph_clave "$1")"; }
resp_m() { mkdir -p "$TMP/respuestas"; printf '%s\n%s\n' "$3" "$4" > "$TMP/respuestas/${1}_$(fph_clave "$2")"; }
resp_seq() {
  mkdir -p "$TMP/respuestas"; local k i=1; k=$(fph_clave "$1")
  while [ -f "$TMP/respuestas/seq_$k.$i" ]; do i=$((i+1)); done
  printf '%s\n%s\n' "$2" "$3" > "$TMP/respuestas/seq_$k.$i"
}

fph_zip() { # fph_zip <destino.zip> — plugin.json con name y version sacados del nombre del archivo
  local dest="$1" d nombre version
  nombre=$(basename "$dest" | sed -E 's/^([^.]*)\..*/\1/'); version=$(basename "$dest" | sed -E 's/^[^.]*\.([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
  d=$(mktemp -d); printf '{"name":"%s","version":"%s"}\n' "$nombre" "$version" > "$d/plugin.json"
  if command -v zip >/dev/null 2>&1; then
    ( cd "$d" && zip -q "$dest" plugin.json )
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1],"w").write(sys.argv[2],"plugin.json")' "$dest" "$d/plugin.json"
  else
    rm -rf "$d"; return 1
  fi
  rm -rf "$d"; [ -s "$dest" ]
}
