#!/usr/bin/env bash
# reviewer-rules.test.sh — red de `scripts/ci/reviewer-rules.js`, el aviso de «regla fuera de la
# sección» al commitear un CLAUDE.md (story 7.5, 2026-09-19).
#
# Por qué existe el aviso: desde la 7.5 los revisores del pipeline no cargan el CLAUDE.md; las reglas
# propias del repo les llegan SÓLO por la sección `## Reglas para revisores`. Una regla escrita en otra
# parte del archivo el revisor no la ve.
#
# Ningún caso sale a la red: TypeSafe es un `fetch` inyectado que anota el cuerpo y contesta lo que el
# caso fabrica. Lo que se prueba es que avise sólo lo de afuera, que sin llave (o con TypeSafe caído)
# avise todo y diga por qué, que con llave filtre por probabilidad, que NADA salga sin tachar
# —ni al pedido ni a la terminal—, y que nunca frene el commit.
#
# T9 (Codex) también vive acá: el generador y su chequeo verdes, y los «Límites de ejecución» sólo en
# los .toml de los 5 revisores con Bash.
#
# Correr: bash scripts/tests/reviewer-rules.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${AQUI}/scripts/ci/reviewer-rules.js"
HOOK="${AQUI}/scripts/hooks/git-pre-commit-global.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT
source "${AQUI}/scripts/tests/lib/fake-home.sh"
fallos=0; pasaron=0
ok(){ echo "✅ reglas-revisores: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ reglas-revisores: $1"; fallos=$((fallos+1)); }

CLAUDE_BASE='# Proyecto

Intro.

## Reglas para revisores

- Nunca SQL concatenado.

## Otra sección

Texto.
'

repo(){ # repo nuevo con un CLAUDE.md commiteado; deja el cwd ahí
  rm -rf "${TMP}/r" "${TMP}/h"
  mkdir -p "${TMP}/r"
  # HOME falsa y nueva por caso, para toda la suite (story 7.16): el commit de abajo no lee el core.hooksPath
  # global del dev (no corren sus ganchos) y las mediciones van a ${TMP}/h, no a su reviewer-rules.jsonl.
  fake_home_create "${TMP}/h" || exit 9
  cd "${TMP}/r" || exit 9
  git init -q . && printf '%s' "${CLAUDE_BASE}" > CLAUDE.md && git add CLAUDE.md \
    && git -c user.email=t@t -c user.name=t commit -q -m init
}
# Agrega 2 líneas fuera de la sección y 1 adentro, y las stagea.
cambio_tipico(){
  python3 - <<'PY'
p = 'CLAUDE.md'
s = open(p).read()
s = s.replace('- Nunca SQL concatenado.\n', '- Nunca SQL concatenado.\n- Regla nueva ADENTRO de la sección.\n')
s = s.replace('Texto.\n', 'Texto.\n- Las tablas nuevas no llevan prefijo XX_.\n- Toda migración nace con su rollback.\n')
open(p, 'w').write(s)
PY
  git add CLAUDE.md
}
correr(){ # correr [env extra...] → salida en $TMP/o.txt, imprime rc
  env -u TYPESAFE_API_KEY "$@" node "${SCRIPT}" --staged --repo "${TMP}/r" > "${TMP}/o.txt" 2>&1
  echo $?
}

# ── T10 Aviso_SinLlave_TodaLineaFuera ────────────────────────────────────────────────────────────
repo; cambio_tipico
rc=$(correr)
[ "${rc}" = "0" ] && ok "T10 sale 0 (avisa, no frena)" || no "T10 salió ${rc}"
grep -q 'prefijo XX_' "${TMP}/o.txt" && grep -q 'nace con su rollback' "${TMP}/o.txt" \
  && ok "T10 avisa las 2 líneas de afuera" || no "T10 no avisó las de afuera: $(cat "${TMP}/o.txt")"
grep -q 'ADENTRO de la sección' "${TMP}/o.txt" && no "T10 avisó la línea de adentro" || ok "T10 no avisa la de adentro"
grep -q 'sin TypeSafe' "${TMP}/o.txt" && ok "T10 dice «sin TypeSafe»" || no "T10 no dice por qué avisa sin filtrar"
grep -q 'movela a «Reglas para revisores»' "${TMP}/o.txt" && ok "T10 el aviso dice qué hacer" || no "T10 el aviso no dice qué hacer"
grep -Eq 'CLAUDE\.md:1[0-9]' "${TMP}/o.txt" && ok "T10 cita el número de línea" || no "T10 sin número de línea: $(cat "${TMP}/o.txt")"

# ── T15 (story 7.16) · los commits de juguete no corren los ganchos del dev ──────────────────────
# Con la HOME real, git lee el core.hooksPath GLOBAL del dev y el commit de repo() corría su pre-commit, que
# anotaba cada commit de juguete en SU registro de reglas (728 líneas «repo r» sólo el 2026-09-29).
# Evidencia POSITIVA: git no ve ganchos globales y la medición del caso quedó en la HOME falsa.
# Rojo previo: sin el ayudante en repo(), git ve el core.hooksPath del dev y la HOME falsa no existe.
hp="$(git -C "${TMP}/r" config --get core.hooksPath 2>/dev/null)"
[ -z "${hp}" ] && ok "T15 el repo de juguete no ve un core.hooksPath global (no corren los ganchos del dev)" \
  || no "T15 🔴 el repo de juguete ve core.hooksPath=${hp}: sus commits corren los ganchos del dev"
n="$(fake_home_count reviewer-rules.jsonl '"repo":"r"' 2>/dev/null)"
[ "${n:-0}" -gt 0 ] && ok "T15 la medición del caso quedó en la HOME falsa (${n}), no en la real" \
  || no "T15 🔴 la medición del caso no está en la HOME falsa: fue al reviewer-rules.jsonl real"

# ── T16 (story 8.9, tanda D2) · el registro con nombre viejo pasa al nuevo sin perder su historia ─────
# El nombre viejo sale del mapa de renombres (no se escribe literal). Con sólo el viejo en la HOME falsa,
# la primera medición lo copia al nuevo y anota ahí; el viejo queda intacto hasta el retiro.
# La copia pública (story 8.7) sale sin el perfil del equipo y sin el mapa: ahí no hay nombre viejo que probar, y se dice.
PUBLIC_COPY=0
if [ ! -f "${AQUI}/perfil-equipo.json" ] || [ ! -f "${AQUI}/scripts/lib/renames.json" ]; then PUBLIC_COPY=1; fi
not_measured=0
viejo=""
[ "${PUBLIC_COPY}" = 1 ] || viejo="$(node -e 'const m=require(process.argv[1]);const e=m.entries.find(x=>x.batch==="D2"&&x.new.endsWith("/reviewer-rules.jsonl"));process.stdout.write(e?require("path").basename(e.old):"")' "${AQUI}/scripts/lib/renames.json")"
if [ "${PUBLIC_COPY}" = 1 ]; then
  echo "⏭ reglas-revisores: T16 NO MEDIDO — copia pública sin el mapa de renombres: no hay nombre viejo del registro que probar. No es un verde."
  not_measured=$((not_measured+1))
elif [ -z "${viejo}" ]; then
  no "T16 el mapa no tiene la entrada D2 de reviewer-rules.jsonl"
else
  repo; cambio_tipico
  rm -f "${FAKE_HOME}/.claude/.tycon-pipeline/reviewer-rules.jsonl"
  echo '{"ts":"2026-09-01T00:00:00Z","repo":"historia-vieja"}' > "${FAKE_HOME}/.claude/.tycon-pipeline/${viejo}"
  rc=$(correr)
  [ "$(fake_home_count reviewer-rules.jsonl 'historia-vieja')" = "1" ] && [ "$(fake_home_count reviewer-rules.jsonl '"repo":"r"')" -gt 0 ] \
    && ok "T16 el registro nuevo trae la historia del viejo y la medición nueva" \
    || no "T16 🔴 el registro nuevo no trae la historia del viejo: $(cat "${FAKE_HOME}/.claude/.tycon-pipeline/reviewer-rules.jsonl" 2>/dev/null)"
  [ "$(wc -l < "${FAKE_HOME}/.claude/.tycon-pipeline/${viejo}" | tr -d ' ')" = "1" ] \
    && ok "T16 el registro viejo queda intacto (no recibe la medición nueva)" || no "T16 el registro viejo cambió"
fi

# Sin la sección: lo dice una vez
repo; printf '# Proyecto\n\n- Una regla suelta.\n' > CLAUDE.md; git add CLAUDE.md
rc=$(correr)
[ "$(grep -c 'no tiene «## Reglas para revisores»' "${TMP}/o.txt")" = "1" ] && ok "T10 sin sección: lo dice una vez" \
  || no "T10 sin sección: $(cat "${TMP}/o.txt")"
# Commit que no toca un CLAUDE.md: silencio
repo; echo x > a.txt; git add a.txt
rc=$(correr)
[ ! -s "${TMP}/o.txt" ] && [ "${rc}" = "0" ] && ok "T10 sin CLAUDE.md en el commit: silencio" || no "T10 habló sin CLAUDE.md: $(cat "${TMP}/o.txt")"
# Apagado
repo; cambio_tipico
rc=$(correr TYCON_REVIEWER_RULES=0)
[ ! -s "${TMP}/o.txt" ] && ok "T10 TYCON_REVIEWER_RULES=0 lo apaga" || no "T10 no se apaga"

# ── T11 Aviso_ConLlave_Tacha_YFiltra ─────────────────────────────────────────────────────────────
# Un `fetch` falso: anota el cuerpo en $TMP/cuerpo.json y contesta 0,9 para la línea que habla de
# prefijo y 0,1 para el resto; o tarda / da 500 según MODO.
cat > "${TMP}/harness.js" <<'JS'
const fs = require('fs');
const [script, repo, modo, salida] = process.argv.slice(2);
const { correr } = require(script);
const fetchImpl = async (url, opts) => {
  fs.writeFileSync(salida, opts.body);
  fs.appendFileSync(require('path').join(require('path').dirname(salida), 'pedidos.log'), 'pedido\n');
  if (modo === 'slow') {
    await new Promise((res, rej) => {
      const t = setTimeout(res, 6000);
      opts.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('abortado'); e.name = 'AbortError'; rej(e); });
    });
  }
  if (modo === 'error') return { ok: false, status: 500, json: async () => ({}) };
  const { state } = JSON.parse(opts.body);
  const answers = {};
  for (const [id, texto] of Object.entries(state)) answers[id] = { noul: /prefijo/.test(texto) ? 0.9 : 0.1 };
  return { ok: true, status: 200, json: async () => ({ answers }) };
};
let out = '';
// La lista de nombres a tachar son los términos `cliente` de la lista de denegación (story 8.10, AC 24):
// acá, una sintética al lado del cuerpo; `no-list` apunta a una que no existe; `no-client`, a una sin
// términos `cliente`; `broken`, a una ilegible.
const dir = require('path').dirname(salida);
const deniedList = modo === 'no-list' ? '/no/existe/denylist.json'
  : require('path').join(dir, modo === 'no-client' ? 'denylist-no-client.json' : modo === 'broken' ? 'denylist-broken.json' : 'denylist.json');
correr({ repo, env: { TYPESAFE_API_KEY: 'llave-de-prueba' }, fetchImpl, deniedList, escribir: (s) => { out += s; } })
  .then((rc) => { process.stdout.write(out); process.exit(rc); });
JS
# La lista de denegación de laboratorio: dos términos `cliente` (uno de palabra, uno que distingue la caja) y uno de
# persona, que no se tacha (la lista a tachar son los clientes). Nombres inventados.
cat > "${TMP}/denylist.json" <<'JSON'
{ "terminos": [
  { "patron": "Zorblax", "categoria": "cliente", "palabra": true },
  { "patron": "ACME", "categoria": "cliente", "palabra": true, "mayusculas": true },
  { "patron": "Initrode", "categoria": "cliente", "palabra": true, "mayusculas": true },
  { "patron": "GlobexTracking", "categoria": "cliente" },
  { "patron": "Wonka", "categoria": "cliente" },
  { "patron": "WonkaVision", "categoria": "cliente" },
  { "patron": "Vandelay", "categoria": "persona", "palabra": true }
] }
JSON
printf '{ "terminos": [ { "patron": ' > "${TMP}/denylist-broken.json"
printf '{ "terminos": [ { "patron": "Vandelay", "categoria": "persona", "palabra": true } ] }\n' > "${TMP}/denylist-no-client.json"
con_llave(){ # con_llave <modo> → salida en $TMP/o.txt, cuerpo en $TMP/cuerpo.json, imprime rc
  rm -f "${TMP}/cuerpo.json"
  node "${TMP}/harness.js" "${SCRIPT}" "${TMP}/r" "$1" "${TMP}/cuerpo.json" > "${TMP}/o.txt" 2>&1
  echo $?
}
repo
python3 - <<'PY'
p = 'CLAUDE.md'
s = open(p).read()
s = s.replace('Texto.\n', 'Texto.\n- Las tablas de Zorblax no llevan prefijo ZX_.\n- La conexión de prueba usa Password=abc123 en local.\n')
open(p, 'w').write(s)
PY
git add CLAUDE.md
rc=$(con_llave normal)
[ "${rc}" = "0" ] && ok "T11 sale 0 con llave" || no "T11 salió ${rc}: $(cat "${TMP}/o.txt")"
[ -s "${TMP}/cuerpo.json" ] && ok "T11 hizo UN pedido" || no "T11 no hizo el pedido"
grep -q 'abc123' "${TMP}/cuerpo.json" && no "T11 la contraseña salió en el pedido" || ok "T11 el pedido no lleva la contraseña"
grep -qi 'zorblax' "${TMP}/cuerpo.json" && no "T11 el nombre del cliente salió en el pedido" || ok "T11 el pedido no lleva el nombre del cliente"
grep -q 'prefijo' "${TMP}/o.txt" && ok "T11 avisa la línea de 0,9" || no "T11 no avisó la de 0,9: $(cat "${TMP}/o.txt")"
grep -q 'Password' "${TMP}/o.txt" && no "T11 avisó la línea de 0,1" || ok "T11 no avisa la de 0,1"
grep -qi 'zorblax' "${TMP}/o.txt" && no "T11 la terminal muestra el nombre sin tachar" || ok "T11 la terminal tampoco muestra el nombre"
grep -q 'sin TypeSafe' "${TMP}/o.txt" && no "T11 dijo «sin TypeSafe» teniendo respuesta" || ok "T11 con respuesta no dice «sin TypeSafe»"

for modo in slow error; do
  rc=$(con_llave "${modo}")
  [ "${rc}" = "0" ] || no "T11 (${modo}) salió ${rc}"
  grep -q 'sin TypeSafe' "${TMP}/o.txt" && ok "T11 (${modo}) cae al modo sin llave y lo dice" || no "T11 (${modo}) no lo dice: $(cat "${TMP}/o.txt")"
  grep -q 'prefijo' "${TMP}/o.txt" && grep -q 'Password' "${TMP}/o.txt" && ok "T11 (${modo}) avisa todas" || no "T11 (${modo}) no avisó todas"
  grep -q 'abc123' "${TMP}/o.txt" && no "T11 (${modo}) imprimió la contraseña" || ok "T11 (${modo}) no imprime la contraseña"
done

# ── T35 ReglasRevisores_ListaDeLaListaPrivada (story 8.10, AC 24) ─────────────────────────────────
# La lista a tachar son los términos `cliente` de la lista de denegación, con sus reglas de palabra y caja.
repo
printf -- '- En Zorblaxiano y en ACME y acme el prefijo es AC_.\n- Lo pidió Vandelay: prefijo VD_.\n' >> CLAUDE.md
git add CLAUDE.md
rc=$(con_llave normal)
grep -q 'Zorblaxiano' "${TMP}/cuerpo.json" && ok "T35 un término de palabra no tacha dentro de otra palabra" \
  || no "T35 tachó dentro de otra palabra: $(cat "${TMP}/cuerpo.json")"
grep -q 'ACME' "${TMP}/cuerpo.json" && no "T35 el término que distingue la caja salió sin tachar" || ok "T35 tacha el término en su caja"
grep -q 'y acme el' "${TMP}/cuerpo.json" && ok "T35 un término que distingue la caja no tacha otra caja" \
  || no "T35 tachó otra caja: $(cat "${TMP}/cuerpo.json")"
grep -q 'Vandelay' "${TMP}/cuerpo.json" && ok "T35 sólo los términos cliente (una persona no está en la lista a tachar)" \
  || no "T35 tachó un término que no es cliente"
# Pase adversarial de la tanda B: las formas que el detector cuenta como el mismo nombre (story 8.4, AC 30) también
# se tachan —otra caja en un identificador, todo en mayúsculas, el compuesto separado— y un nombre que contiene a
# otro más corto se tacha entero.
repo
printf -- '- Deployar con el llavero tycon-prod-initrode y la ruta /api/plugins/initrode/1.0/: prefijo IN_.\n- Nunca borrar la base INITRODE: prefijo IB_.\n- El repo globex-tracking y el WonkaVision: prefijo GW_.\n' >> CLAUDE.md
git add CLAUDE.md
rc=$(con_llave normal)
grep -qi 'initrode' "${TMP}/cuerpo.json" && no "T35 una variante del nombre (otra caja o mayúsculas) salió sin tachar: $(cat "${TMP}/cuerpo.json")" \
  || ok "T35 tacha las variantes que ve el detector (otra caja en un identificador, todo en mayúsculas)"
grep -qi 'globex' "${TMP}/cuerpo.json" && no "T35 el nombre compuesto separado en partes salió sin tachar" \
  || ok "T35 tacha el nombre compuesto separado en partes"
grep -q 'Vision' "${TMP}/cuerpo.json" && no "T35 un nombre que contiene a otro más corto quedó tachado a medias" \
  || ok "T35 un nombre que contiene a otro más corto se tacha entero"
grep -qi 'initrode\|globex\|wonka' "${TMP}/o.txt" && no "T35 la terminal muestra una variante sin tachar" \
  || ok "T35 la terminal tampoco muestra las variantes"
repo; cambio_tipico
rm -f "${TMP}/pedidos.log"
rc=$(con_llave broken)
[ ! -s "${TMP}/pedidos.log" ] && ok "T35 una lista ilegible es «sin lista»: no sale ningún pedido" || no "T35 salió un pedido con la lista rota"
grep -q 'terminos' "${TMP}/o.txt" && no "T35 el motivo cita el contenido de la lista rota" || ok "T35 el motivo de la lista rota no cita su contenido"
repo; cambio_tipico
rm -f "${TMP}/pedidos.log"
rc=$(con_llave no-client)
[ ! -s "${TMP}/pedidos.log" ] && ok "T35 una lista sin términos cliente es «sin lista»: no sale ningún pedido" \
  || no "T35 salió un pedido sin nombres a tachar"
grep -q 'sin TypeSafe' "${TMP}/o.txt" && grep -qi 'nombres' "${TMP}/o.txt" && ok "T35 sin términos cliente lo dice" \
  || no "T35 no lo dice: $(cat "${TMP}/o.txt")"
awk '/^## Nombres que se tachan/{p=1;next} /^## /{p=0} p&&/^```/{f=1} END{exit !f}' "${AQUI}/guides/reglas-para-revisores.md" \
  && no "T35 la guía todavía trae la lista de nombres (un bloque bajo «Nombres que se tachan»)" \
  || ok "T35 la guía ya no trae la lista de nombres: dice dónde vive"

# ── Hallazgos del pase adversarial (story 7.5, paso 5b) ──────────────────────────────────────────
# A-1 · una cerca SIN CERRAR antes del encabezado no esconde la sección: la línea agregada adentro no se
# avisa y no dice «no tiene la sección».
repo
printf '# Proyecto\n\n## Ejemplos\n\n```bash\necho sin cerrar\n\n## Reglas para revisores\n\n- Nunca SQL concatenado.\n\n## Otra\n\nTexto.\n' > CLAUDE.md
git add CLAUDE.md && git -c user.email=t@t -c user.name=t commit -q -m base2
python3 - <<'PY'
p = 'CLAUDE.md'; s = open(p).read()
s = s.replace('- Nunca SQL concatenado.\n', '- Nunca SQL concatenado.\n- Regla nueva ADENTRO pese a la cerca abierta.\n')
open(p, 'w').write(s)
PY
git add CLAUDE.md
rc=$(correr)
grep -q 'ADENTRO pese a la cerca' "${TMP}/o.txt" && no "A-1 avisó una línea de adentro (la cerca abierta escondió la sección)" || ok "A-1 cerca abierta antes: la línea de adentro no se avisa"
grep -q 'no tiene «## Reglas para revisores»' "${TMP}/o.txt" && no "A-1 dijo que no tiene la sección" || ok "A-1 cerca abierta antes: reconoce la sección"

# A-2 · mover CLAUDE.md → .claude/CLAUDE.md y agregar una regla afuera en el mismo commit: se avisa (y
# sólo la línea nueva, no todo el archivo).
repo
mkdir -p .claude && git mv CLAUDE.md .claude/CLAUDE.md
printf -- '- Las tablas nuevas no llevan prefijo XX_.\n' >> .claude/CLAUDE.md
git add .claude/CLAUDE.md
rc=$(correr)
grep -q 'prefijo XX_' "${TMP}/o.txt" && ok "A-2 renombrado + regla afuera: se avisa" || no "A-2 renombrado: silencio ($(cat "${TMP}/o.txt"))"
grep -q 'Texto\.' "${TMP}/o.txt" && no "A-2 renombrado: avisó líneas que no son nuevas" || ok "A-2 renombrado: sólo la línea nueva"

# A-3 · una línea agregada que empieza con «+++» o «---» no se pierde, y las de después conservan su número.
repo
python3 - <<'PY'
p = 'CLAUDE.md'; s = open(p).read()
s = s.replace('Texto.\n', 'Texto.\n++ regla con dos más al principio\n--- regla con tres guiones\n- Última regla nueva.\n')
open(p, 'w').write(s)
PY
git add CLAUDE.md
rc=$(correr)
grep -q 'regla con dos más' "${TMP}/o.txt" && grep -q 'regla con tres guiones' "${TMP}/o.txt" \
  && ok "A-3 las líneas que empiezan con ++ / --- se avisan" || no "A-3 se perdieron: $(cat "${TMP}/o.txt")"
grep -q 'CLAUDE.md:14 .*Última regla nueva' "${TMP}/o.txt" && ok "A-3 la línea siguiente conserva su número (14)" || no "A-3 número corrido: $(grep 'Última' "${TMP}/o.txt")"

# A-4 · los dos CLAUDE.md tocados en el mismo commit → UN solo pedido a TypeSafe.
repo
mkdir -p .claude && printf '## Reglas para revisores\n\n- x\n' > .claude/CLAUDE.md
git add .claude/CLAUDE.md && git -c user.email=t@t -c user.name=t commit -q -m dos
printf -- '- Las tablas de raíz no llevan prefijo XX_.\n' >> CLAUDE.md
printf '\n## Otra\n\n- Otra regla con prefijo YY_.\n' >> .claude/CLAUDE.md
git add CLAUDE.md .claude/CLAUDE.md
rm -f "${TMP}/pedidos.log"
rc=$(con_llave normal)
[ "$(wc -l < "${TMP}/pedidos.log" | tr -d ' ')" = "1" ] && ok "A-4 dos CLAUDE.md, un solo pedido" || no "A-4 pedidos: $(wc -l < "${TMP}/pedidos.log" 2>/dev/null)"
grep -q 'XX_' "${TMP}/o.txt" && grep -q 'YY_' "${TMP}/o.txt" && ok "A-4 avisa las de los dos archivos" || no "A-4 falta alguna: $(cat "${TMP}/o.txt")"

# S-1 · si la lista de nombres a tachar no se puede leer, NO se manda nada a TypeSafe: se cae al modo
# sin llave y se dice por qué (hallazgo SILENT-C2 del paso 5).
repo; cambio_tipico
rm -f "${TMP}/pedidos.log"
rc=$(con_llave no-list)
[ ! -s "${TMP}/pedidos.log" ] && ok "S-1 sin la lista de nombres no sale ningún pedido" || no "S-1 salió un pedido sin la lista de nombres"
grep -q 'sin TypeSafe' "${TMP}/o.txt" && grep -qi 'nombres' "${TMP}/o.txt" && ok "S-1 dice por qué no filtró" || no "S-1 no lo dice: $(cat "${TMP}/o.txt")"

# ── El pre-commit global lo llama y el commit pasa ───────────────────────────────────────────────
repo; cambio_tipico
out=$(env -u TYPESAFE_API_KEY TYCON_GUIDES_DIR="${AQUI}" TYCON_SQL_COMPILE=0 bash "${HOOK}" 2>&1); rc=$?
[ "${rc}" = "0" ] && ok "pre-commit global sale 0 con un CLAUDE.md tocado" || no "pre-commit global salió ${rc}: ${out}"
printf '%s' "${out}" | grep 'movela a «Reglas para revisores»' >/dev/null && ok "pre-commit global muestra el aviso" || no "pre-commit global no mostró el aviso: ${out}"

# ── T9 Codex_GeneradorYCheck ─────────────────────────────────────────────────────────────────────
cd "${AQUI}" || exit 9
# Los revisores de ESTE árbol, nunca los instalados: fake-home.sh apunta TYCON_SKILLS_DIR a la copia
# instalada, y con ella el --check comparaba las copias de Codex de la rama contra los revisores de la máquina (rojo
# cuando la máquina va atrasada, verde aunque la rama esté rota). Es lo mismo que ya hacía T14.
env -u TYCON_SKILLS_DIR TYCON_AGENTS_DIR="${AQUI}/agents" node build/generate.js --check > "${TMP}/gen.txt" 2>&1 && ok "T9 los .toml de Codex están al día" || no "T9 generate --check: $(tail -3 "${TMP}/gen.txt")"
env -u TYCON_SKILLS_DIR TYCON_AGENTS_DIR="${AQUI}/agents" node build/check.js > "${TMP}/chk.txt" 2>&1 && ok "T9 build/check.js verde" || no "T9 check.js: $(tail -3 "${TMP}/chk.txt")"
# T9b · con TYCON_SKILLS_DIR apuntando a una copia de revisores DISTINTA (la instalada atrasada), T9 sigue midiendo el árbol
_otra="$(mktemp -d)"; mkdir -p "${_otra}/skills"; cp -R "${AQUI}/agents" "${_otra}/agents"
printf '\nUna línea que la copia de la rama no tiene.\n' >> "${_otra}/agents/tycon-plugin-tests-coverage.md"
# la forma de antes (sólo la variable heredada) lee esa copia y sale roja: la exposición existe
if TYCON_SKILLS_DIR="${_otra}" node build/generate.js --check > "${TMP}/gen9b-antes.txt" 2>&1; then
  no "T9b la copia distinta no cambió nada: la prueba no prueba (¿el generador ya no lee TYCON_SKILLS_DIR?)"
# la forma de T9 mide el árbol aunque la variable apunte a otra copia
elif TYCON_SKILLS_DIR="${_otra}" env -u TYCON_SKILLS_DIR TYCON_AGENTS_DIR="${AQUI}/agents" node build/generate.js --check > "${TMP}/gen9b.txt" 2>&1; then
  ok "T9b 7.36-ReviewerCopies_FromTree_NotInstalled — con TYCON_SKILLS_DIR en otra copia, T9 sigue midiendo los revisores del árbol"
else
  no "T9b T9 leyó la otra copia: $(tail -3 "${TMP}/gen9b.txt")"
fi
rm -rf "${_otra}"
con=$(grep -l 'Límites de ejecución (no vienen del CLAUDE.md)' adapters/codex/agents/*.toml | xargs -n1 basename | sort | tr '\n' ' ')
esperado='tycon-feature-wiring-checker.toml tycon-plugin-dotnet-conventions.toml tycon-sibling-pattern-reviewer.toml tycon-signed-scope-audit.toml tycon-silent-failure-hunter.toml '
# Tres de los cinco son de paquetes del equipo (clientes y bizuit, que viajan con su perfil, story 8.41): en la copia
# pública sus .toml no están y se esperan los otros dos, diciéndolo. En el repo del equipo siguen siendo los cinco, y que
# falte uno es un rojo.
PRIVATE_TOMLS='tycon-sibling-pattern-reviewer.toml tycon-feature-wiring-checker.toml tycon-plugin-dotnet-conventions.toml'
# Desde la 8.41 los .toml de los revisores de un paquete se generan desde la capa al instalar y no se guardan en el
# repo: en el árbol armado se esperan los que estén (hoy, el de plugins hermanos), nunca los que no.
for t in ${PRIVATE_TOMLS}; do [ -f "adapters/codex/agents/${t}" ] || esperado="${esperado/${t} /}"; done
if [ "${PUBLIC_COPY}" = 1 ] && [ ! -f "adapters/codex/agents/tycon-sibling-pattern-reviewer.toml" ]; then
  for t in ${PRIVATE_TOMLS}; do esperado="${esperado/${t} /}"; done
  [ "${con}" = "${esperado}" ] && ok "T9 los «Límites de ejecución» llegan a Codex sólo en los 2 con Bash que viajan (copia pública: los de los paquetes del equipo no se midieron)" || no "T9 límites en: ${con}"
else
  [ "${con}" = "${esperado}" ] && ok "T9 los «Límites de ejecución» llegan a Codex en los que tienen Bash y están en el repo" || no "T9 límites en: ${con} (esperaba: ${esperado})"
fi

# ── T14 TestW2_DiceNumeroYOrigen ──────────────────────────────────────────────────────────────────────────────
# TEST-W2 dice de dónde salió el umbral (`threshold_source`), sabe que el corredor de suites.json ya trae número, y
# sigue siendo un aviso; las dos copias de Codex lo dicen igual porque salen del generador (el --check de T9).
# 🔴 rojo: el texto del agente sin `threshold_source`, o una copia de Codex editada a mano que no lo tiene.
t14=""
for f in agents/tycon-plugin-tests-coverage.md adapters/codex/agents/tycon-plugin-tests-coverage.toml adapters/codex/agents-native/tycon-plugin-tests-coverage.toml; do
  fila="$(grep -F '**TEST-W2**' "${f}" | head -1)"
  case "${fila}" in *threshold_source*) ;; *) t14="${t14} ${f}(sin threshold_source)";; esac
  case "${fila}" in *suites.json*) ;; *) t14="${t14} ${f}(sin el corredor de suites.json)";; esac
  case "${fila}" in *"no frena"*) ;; *) t14="${t14} ${f}(no dice que no frena)";; esac
  case "${fila}" in *"citar el número junto con su origen"*) ;; *) t14="${t14} ${f}(no pide citar el origen)";; esac
done
# las copias salen del generador sobre los revisores de ESTE árbol: en una máquina con el arnés instalado, fake-home.sh
# apunta TYCON_SKILLS_DIR a los instalados, y el --check de T9 compara contra ésos
env -u TYCON_SKILLS_DIR TYCON_AGENTS_DIR="${AQUI}/agents" node build/generate.js --check > "${TMP}/gen14.txt" 2>&1
for f in adapters/codex/agents/tycon-plugin-tests-coverage.toml adapters/codex/agents-native/tycon-plugin-tests-coverage.toml; do
  grep -qF "al día: ${f}" "${TMP}/gen14.txt" || t14="${t14} ${f}(no sale del generador: $(grep -F "${f}" "${TMP}/gen14.txt" | head -1))"
done
[ -z "${t14}" ] && ok "T14 7.31-TestW2_DiceNumeroYOrigen — TEST-W2 nombra threshold_source y el corredor de suites.json, en el agente y en las dos copias de Codex" || no "T14 TEST-W2:${t14}"

if [ "${not_measured}" -gt 0 ]; then echo "reglas-revisores: ${pasaron} ok, ${fallos} fallos, ${not_measured} no medido(s) (copia pública)"
else echo "reglas-revisores: ${pasaron} ok, ${fallos} fallos"; fi
[ "${fallos}" = "0" ]
