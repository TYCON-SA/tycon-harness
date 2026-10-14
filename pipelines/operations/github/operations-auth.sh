# pipelines/operations/github/operations-auth.sh — la credencial para hablar con el repo de operaciones, SÓLO en este paso
# (story 8.31, decisión 14).
#
# Se carga con `source` (no se ejecuta) en el paso que guarda, trae o publica en el repo de operaciones. Deja la
# credencial del workflow (`OPS_TOKEN`, que el paso recibe de `github.token` por `env:`) en las variables `GIT_CONFIG_*`
# de ESTE proceso: git la usa para la dirección del repo de operaciones y para nada más, y no queda escrita en ningún
# `.git/config`. Así un paso que corre código de los productos (la revisión de dependencias corre `dotnet restore`)
# no tiene ninguna credencial al alcance.
#
# Necesita: OPS_TOKEN, GITHUB_REPOSITORY (dueño/repo de operaciones) y GITHUB_SERVER_URL (por defecto github.com).
# OPS_REMOTE_URL reemplaza la dirección (las pruebas usan un repo local).

if [ -z "${OPS_TOKEN:-}" ]; then
  echo "::error::operations-auth.sh: falta OPS_TOKEN (el paso tiene que recibir github.token por env)"
  return 1 2>/dev/null || exit 1
fi
_ops_url="${OPS_REMOTE_URL:-${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}.git}"
_ops_auth="$(printf 'x-access-token:%s' "${OPS_TOKEN}" | base64 | tr -d '\n')"
echo "::add-mask::${_ops_auth}"
_ops_n="${GIT_CONFIG_COUNT:-0}"
export "GIT_CONFIG_KEY_${_ops_n}=http.${_ops_url}.extraheader"
export "GIT_CONFIG_VALUE_${_ops_n}=AUTHORIZATION: basic ${_ops_auth}"
export GIT_CONFIG_COUNT=$((_ops_n + 1))
unset _ops_url _ops_auth _ops_n
