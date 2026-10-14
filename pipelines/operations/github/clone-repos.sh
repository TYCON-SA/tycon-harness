#!/usr/bin/env bash
# pipelines/operations/github/clone-repos.sh — los clones de los repos de la organización en GitHub (story 8.31).
#
#   clone-repos.sh --declared <destino>
#       Para la revisión de dependencias. Lee de la entrada las líneas `<ruta>\t<dueño>/<repo>` (lo que imprime
#       `nightly-dependencies.js clone-list`) y clona cada repo, rama main, en `<destino>/<ruta>`. El token de la
#       organización va SÓLO en la línea de comando del clon (decisión 14): ningún clon lo guarda en su config, porque
#       el paso siguiente corre código de los productos (`dotnet restore`).
#   clone-repos.sh --org <destino> [--team-repos <archivo>]
#       Para las métricas. Descubre los repos de cada dueño de `OWNERS` (separados por `;`; vacío: GITHUB_REPOSITORY_OWNER),
#       como organización o como usuario según GitHub, paginado; con `PREFIX`, sólo los que empiezan así; sin las copias
#       del arnés que declara team-repos.json (`harness_copies` de GitHub). Clona LIVIANO (`--filter=blob:none`, sólo
#       Markdown, `.advisors/` y `.tycon/`) en `<destino>/<dueño>__<repo>` (lo parten en `__` las métricas). El clon
#       liviano baja contenido después: el token queda en la config de esos clones, en un trabajo que sólo lee Markdown.
#
# Necesita ORG_TOKEN, por env del paso: el token de la GitHub App (recomendado) o el secreto HARNESS_ORG_TOKEN (un usuario
# de máquina). Habla con GitHub por TYCON_GH_CMD (por defecto gh; un `.js` corre con node) y clona desde GITHUB_SERVER_URL
# (las pruebas usan una carpeta local).
# Un repo que no se pudo listar o clonar se NOMBRA (un barrido que se achica en silencio se lee igual que uno completo).
# Salida: 0 (lo que falló va como ::warning::) · 1 sin credencial, sin poder listar a un dueño, o error de uso.
set -uo pipefail

MODE="${1:-}"; DEST="${2:-}"; TEAM_REPOS=""
[ "${3:-}" = "--team-repos" ] && TEAM_REPOS="${4:-}"
case "${MODE}" in --declared|--org) ;; *) echo "uso: clone-repos.sh --declared <destino> | --org <destino> [--team-repos <archivo>]" >&2; exit 1 ;; esac
[ -n "${DEST}" ] || { echo "uso: falta el destino" >&2; exit 1; }
[ -n "${ORG_TOKEN:-}" ] || { echo "::error::Falta la credencial de la organización para leer sus repos: la GitHub App (variable HARNESS_APP_CLIENT_ID y secreto HARNESS_APP_PRIVATE_KEY) o el secreto HARNESS_ORG_TOKEN. No se clonó nada"; exit 1; }
SERVER="${GITHUB_SERVER_URL:-https://github.com}"
AUTH="$(printf 'x-access-token:%s' "${ORG_TOKEN}" | base64 | tr -d '\n')"
echo "::add-mask::${AUTH}"
HDR="AUTHORIZATION: basic ${AUTH}"
NAME='^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
mkdir -p "${DEST}"
FALLIDOS=""

if [ "${MODE}" = "--declared" ]; then
  while IFS=$'\t' read -r RUTA ID; do
    [ -n "${RUTA}" ] || continue
    if ! printf '%s' "${ID}" | grep -Eq "${NAME}"; then
      echo "::warning::${RUTA} no declara «github: <dueño>/<repo>» en repos.json: no se clona"
      FALLIDOS="${FALLIDOS} ${RUTA}"; continue
    fi
    case "${RUTA}" in /*|*..*) echo "::warning::la ruta «${RUTA}» sale del destino: no se clona"; FALLIDOS="${FALLIDOS} ${RUTA}"; continue ;; esac
    mkdir -p "$(dirname "${DEST}/${RUTA}")"
    if ! ERR="$(git -c "http.extraheader=${HDR}" clone --quiet --depth=1 --branch main "${SERVER}/${ID}.git" "${DEST}/${RUTA}" 2>&1)"; then
      echo "::warning::No se pudo clonar ${ID}: $(printf '%s' "${ERR}" | head -n 2 | tr '\n' ' ')"
      FALLIDOS="${FALLIDOS} ${ID}"
    fi
  done
  echo "clonados: $(find "${DEST}" -mindepth 1 -maxdepth 4 -name .git | wc -l | tr -d ' ')"
  [ -z "${FALLIDOS}" ] || echo "::warning::Repos NO clonados:${FALLIDOS} — van a figurar como NO MEDIDO, que no es lo mismo que limpio"
  exit 0
fi

# --org: la lista, armada por node (paginada, organización o usuario, sin copias, con prefijo)
LIST="$(mktemp)"
if ! GH_TOKEN="${ORG_TOKEN}" node - "${TEAM_REPOS}" > "${LIST}" 2> "${LIST}.err" <<'JS'
const { spawnSync } = require('child_process');
const fs = require('fs');
const cmd = process.env.TYCON_GH_CMD || 'gh';
const [exe, pre] = /\.js$/i.test(cmd) ? [process.execPath, [cmd]] : [cmd, []];
const api = (ruta) => {
  const r = spawnSync(exe, [...pre, 'api', '-H', 'Accept: application/vnd.github+json', ruta], { encoding: 'utf8', maxBuffer: 1 << 28, env: process.env });
  if (r.error || r.status !== 0) return { ok: false, motivo: String((r.stderr || (r.error && r.error.message) || '')).trim().split('\n')[0] };
  try { return { ok: true, valor: JSON.parse(r.stdout) }; } catch { return { ok: false, motivo: 'la respuesta no es JSON' }; }
};
const teamRepos = process.argv[2];
const copias = new Set();
if (teamRepos && fs.existsSync(teamRepos)) {
  const t = JSON.parse(fs.readFileSync(teamRepos, 'utf8'));
  for (const c of t.harness_copies || []) if (c && c.platform === 'github') copias.add(`${c.org}/${c.repo}`.toLowerCase());
}
const owners = String(process.env.OWNERS || process.env.GITHUB_REPOSITORY_OWNER || '').split(';').map((s) => s.trim()).filter(Boolean);
if (!owners.length) { console.error('no hay dueños que mirar (OWNERS y GITHUB_REPOSITORY_OWNER vacíos)'); process.exit(1); }
const prefix = String(process.env.PREFIX || '');
let fallo = false;
for (const o of owners) {
  if (!/^[A-Za-z0-9-]+$/.test(o)) { console.error(`«${o}» no es un dueño de GitHub`); fallo = true; continue; }
  const u = api(`users/${o}`);
  if (!u.ok || !u.valor || !u.valor.type) { console.error(`no pude saber qué es ${o}: ${u.motivo || 'sin tipo'}`); fallo = true; continue; }
  const base = u.valor.type === 'Organization' ? `orgs/${o}/repos?type=all` : `users/${o}/repos?type=owner`;
  for (let page = 1; page <= 50; page++) {
    const r = api(`${base}&per_page=100&page=${page}`);
    if (!r.ok || !Array.isArray(r.valor)) { console.error(`no pude listar los repos de ${o} (página ${page}): ${r.motivo || 'no es una lista'}`); fallo = true; break; }
    for (const x of r.valor) {
      if (!x || typeof x.name !== 'string' || !x.owner) continue;
      const full = `${x.owner.login}/${x.name}`;
      if (prefix && !x.name.startsWith(prefix)) continue;
      if (copias.has(full.toLowerCase())) { console.log(`COPY\t${full}`); continue; }
      console.log(`REPO\t${full}`);
    }
    if (r.valor.length < 100) break;
  }
}
process.exit(fallo ? 1 : 0);
JS
then
  echo "::error::No se pudieron listar los repos de la organización: $(tail -n 3 "${LIST}.err" | tr '\n' ' ') — el barrido no se hace a medias"
  rm -f "${LIST}" "${LIST}.err"; exit 1
fi
TOTAL=0; SKIPPED=""
while IFS=$'\t' read -r KIND FULL; do
  [ -n "${FULL}" ] || continue
  printf '%s' "${FULL}" | grep -Eq "${NAME}" || continue
  if [ "${KIND}" = "COPY" ]; then SKIPPED="${SKIPPED} ${FULL}"; continue; fi
  TOTAL=$((TOTAL + 1))
  D="${DEST}/${FULL%%/*}__${FULL##*/}"
  if ! ERR="$(git -c "http.extraheader=${HDR}" clone --quiet --filter=blob:none --no-checkout "${SERVER}/${FULL}.git" "${D}" 2>&1)"; then
    echo "   ✗ ${FULL}: $(printf '%s' "${ERR}" | head -n 1 | cut -c1-160)"
    FALLIDOS="${FALLIDOS} ${FULL}(clone)"; continue
  fi
  # un repo VACÍO no tiene HEAD: no es un fallo, es un repo sin nada que medir
  if ! git -C "${D}" rev-parse -q --verify HEAD > /dev/null 2>&1; then rm -rf "${D}"; continue; fi
  (
    cd "${D}" || exit 1
    git config http.extraheader "${HDR}"
    git sparse-checkout init --no-cone 2>/dev/null
    printf '%s\n' '**/*.md' '.advisors/**' '.tycon/**' > .git/info/sparse-checkout
    git checkout --quiet 2>/dev/null
  ) || FALLIDOS="${FALLIDOS} ${FULL}(checkout)"
done < "${LIST}"
rm -f "${LIST}" "${LIST}.err"
echo "repos vistos: ${TOTAL} · clonados: $(find "${DEST}" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
[ -z "${SKIPPED}" ] || echo "copias del arnés que no se miden:${SKIPPED}"
[ -z "${FALLIDOS}" ] || echo "::warning::Repos NO medidos:${FALLIDOS} — el barrido está incompleto (¿la credencial puede leerlos?)"
exit 0
