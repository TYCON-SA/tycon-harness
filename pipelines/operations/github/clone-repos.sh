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
#       paginado, según la credencial (`ORG_TOKEN_KIND`; vacía, se averigua: sólo el token de una App lee
#       `installation/repositories`):
#         · `app` (el token de la GitHub App): los repos donde la App está instalada (`installation/repositories`), de los
#           dueños de OWNERS; privados incluidos, en una organización y en una cuenta de usuario. Un dueño sin ningún repo
#           ahí sale como aviso (la App no está instalada en sus repos);
#         · `user` (el usuario de máquina): de una organización, `orgs/<dueño>/repos?type=all`; de una cuenta de
#           usuario, `users/<dueño>/repos?type=owner` —que da SÓLO los públicos— más los de ese dueño que la credencial ve
#           por `user/repos?affiliation=owner,collaborator` (los privados del dueño o donde el usuario es colaborador).
#       Con `PREFIX`, sólo los que empiezan así; sin las copias
#       del arnés que declara team-repos.json (`harness_copies` de GitHub, salvo la de `maintainers` si está en la lista:
#       la regla es la del lector, scripts/lib/team-repos.js). Clona LIVIANO (`--filter=blob:none`, sólo
#       Markdown, `.advisors/` y `.tycon/`) en `<destino>/<dueño>__<repo>` (lo parten en `__` las métricas). El clon
#       liviano baja contenido después: el token queda en la config de esos clones, en un trabajo que sólo lee Markdown.
#
# Necesita ORG_TOKEN, por env del paso: el token de la GitHub App (recomendado) o el secreto HARNESS_ORG_TOKEN (un usuario
# de máquina). Habla con GitHub por TYCON_GH_CMD (por defecto gh; un `.js` corre con node) y clona desde GITHUB_SERVER_URL
# (las pruebas usan una carpeta local).
# Un repo que no se pudo listar o clonar se NOMBRA (un barrido que se achica en silencio se lee igual que uno completo), y
# cero repos vistos es un aviso, nunca un verde mudo (DEF-8.31-metricas-no-ven-privados-de-un-usuario: en una cuenta de
# usuario el camino de `users/` no trae los privados y la corrida salía verde con «repos vistos: 0»).
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
READER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/scripts/lib/team-repos.js"
if ! GH_TOKEN="${ORG_TOKEN}" node - "${TEAM_REPOS}" "${READER}" > "${LIST}" 2> "${LIST}.err" <<'JS'
const { spawnSync } = require('child_process');
const fs = require('fs');
const cmd = process.env.TYCON_GH_CMD || 'gh';
const [exe, pre] = /\.js$/i.test(cmd) ? [process.execPath, [cmd]] : [cmd, []];
const api = (ruta) => {
  const r = spawnSync(exe, [...pre, 'api', '-H', 'Accept: application/vnd.github+json', ruta], { encoding: 'utf8', maxBuffer: 1 << 28, env: process.env });
  if (r.error || r.status !== 0) return { ok: false, motivo: String((r.stderr || (r.error && r.error.message) || '')).trim().split('\n')[0] };
  try { return { ok: true, valor: JSON.parse(r.stdout) }; } catch { return { ok: false, motivo: 'la respuesta no es JSON' }; }
};
const [teamRepos, reader] = process.argv.slice(2);
const copias = new Set();
if (teamRepos && fs.existsSync(teamRepos)) {
  // las copias, con la regla del lector: un team-repos.json que no valida es un error, no «no hay copias»
  const r = require(reader).load(teamRepos);
  if (!r.ok) { console.error(`team-repos.json no valida: ${r.problems.map((p) => `${p.path || '(el archivo)'}: ${p.message}`).join('; ')}`); process.exit(1); }
  for (const c of require(reader).harnessCopies(r.data, 'github')) if (!c.measured) copias.add(c.id.toLowerCase());
}
const owners = String(process.env.OWNERS || process.env.GITHUB_REPOSITORY_OWNER || '').split(';').map((s) => s.trim()).filter(Boolean);
if (!owners.length) { console.error('no hay dueños que mirar (OWNERS y GITHUB_REPOSITORY_OWNER vacíos)'); process.exit(1); }
let kind = String(process.env.ORG_TOKEN_KIND || '');
if (kind && !['app', 'user'].includes(kind)) { console.error(`ORG_TOKEN_KIND «${kind}» no es app ni user`); process.exit(1); }
if (!kind) {
  // sin decir cuál (un workflow copiado antes de que existiera la variable): installation/repositories sólo contesta al
  // token de una App; con el de un usuario responde 403 y vale el camino del usuario
  const p = api('installation/repositories?per_page=1');
  kind = p.ok && p.valor && Array.isArray(p.valor.repositories) ? 'app' : 'user';
}
const prefix = String(process.env.PREFIX || '');
let fallo = false;
const vistos = new Set();
const emitir = (x) => {
  if (!x || typeof x.name !== 'string' || !x.owner || typeof x.owner.login !== 'string') return;
  const full = `${x.owner.login}/${x.name}`;
  if (vistos.has(full.toLowerCase())) return;
  vistos.add(full.toLowerCase());
  if (prefix && !x.name.startsWith(prefix)) return;
  if (copias.has(full.toLowerCase())) { console.log(`COPY\t${full}`); return; }
  console.log(`REPO\t${full}`);
};
/** Todas las páginas de una ruta; `campo`: la lista viene dentro de ese campo (installation/repositories). null = falló. */
const todo = (ruta, campo) => {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const r = api(`${ruta}${ruta.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const lista = r.ok && r.valor ? (campo ? r.valor[campo] : r.valor) : null;
    if (!Array.isArray(lista)) { console.error(`no pude listar ${ruta} (página ${page}): ${r.motivo || 'no es una lista'}`); return null; }
    out.push(...lista);
    if (lista.length < 100) break;
  }
  return out;
};
const validos = owners.filter((o) => {
  if (/^[A-Za-z0-9-]+$/.test(o)) return true;
  console.error(`«${o}» no es un dueño de GitHub`); fallo = true; return false;
});
if (kind === 'app') {
  // el token de la App sólo ve los repos donde está instalada: ésa es la lista, privados incluidos
  const lista = todo('installation/repositories', 'repositories');
  if (!lista) process.exit(1);
  for (const o of validos) {
    const suyos = lista.filter((x) => x && x.owner && String(x.owner.login).toLowerCase() === o.toLowerCase());
    if (!suyos.length) console.log(`WARN\tla GitHub App no está instalada en ningún repo de ${o}: sus repos no se miden`);
    suyos.forEach(emitir);
  }
} else {
  let mios = null;
  for (const o of validos) {
    const u = api(`users/${o}`);
    if (!u.ok || !u.valor || !u.valor.type) { console.error(`no pude saber qué es ${o}: ${u.motivo || 'sin tipo'}`); fallo = true; continue; }
    if (u.valor.type === 'Organization') {
      const l = todo(`orgs/${o}/repos?type=all`);
      if (!l) { fallo = true; continue; }
      l.forEach(emitir);
      continue;
    }
    // una cuenta de usuario: users/<dueño>/repos trae sólo los públicos; los privados que la credencial ve, por user/repos
    const l = todo(`users/${o}/repos?type=owner`);
    if (!l) { fallo = true; continue; }
    if (mios === null) mios = todo('user/repos?affiliation=owner,collaborator');
    if (!mios) { fallo = true; continue; }
    [...l, ...mios.filter((x) => x && x.owner && String(x.owner.login).toLowerCase() === o.toLowerCase())].forEach(emitir);
  }
}
// lo que team-repos.json declara de estos dueños: si no se ve ninguno, la credencial no los está viendo
const ownerSet = new Set(validos.map((o) => o.toLowerCase()));
if (teamRepos && fs.existsSync(teamRepos)) {
  const d = require(reader).load(teamRepos).data || {};
  const decl = [d.public, d.profile, d.operations, d.maintainers, ...(d.harness_copies || [])]
    .filter((x) => x && x.platform === 'github' && ownerSet.has(String(x.org).toLowerCase())).map((x) => `${x.org}/${x.repo}`);
  if (decl.length) console.log(`DECL\t${[...new Set(decl)].join(' ')}`);
}
process.exit(fallo ? 1 : 0);
JS
then
  echo "::error::No se pudieron listar los repos de la organización: $(tail -n 3 "${LIST}.err" | tr '\n' ' ') — el barrido no se hace a medias"
  rm -f "${LIST}" "${LIST}.err"; exit 1
fi
TOTAL=0; SKIPPED=""
DECLARED=""
while IFS=$'\t' read -r KIND FULL; do
  [ -n "${FULL}" ] || continue
  case "${KIND}" in
    WARN) echo "::warning::${FULL}"; continue ;;
    DECL) DECLARED="${FULL}"; continue ;;
  esac
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
if [ "${TOTAL}" -eq 0 ]; then
  if [ -n "${DECLARED}" ]; then
    echo "::warning::Cero repos vistos, y team-repos.json declara repos de estos dueños (${DECLARED}): la credencial no los ve — ¿la App no está instalada en ellos, o el usuario de máquina no ve los privados? No se midió nada"
  else
    echo "::warning::Cero repos vistos: no se midió nada (¿la credencial ve los repos de ${OWNERS:-${GITHUB_REPOSITORY_OWNER:-}}${PREFIX:+, con el prefijo ${PREFIX}}?)"
  fi
fi
[ -z "${SKIPPED}" ] || echo "copias del arnés que no se miden:${SKIPPED}"
[ -z "${FALLIDOS}" ] || echo "::warning::Repos NO medidos:${FALLIDOS} — el barrido está incompleto (¿la credencial puede leerlos?)"
exit 0
