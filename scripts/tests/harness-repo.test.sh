#!/usr/bin/env bash
# harness-repo.test.sh — ¿este repo es del arnés? lo dice el remoto, no la carpeta
#
# La exclusión de los repos del arnés se apoya en el remoto (retro-pending.js,
# unpushed-work-notice.js, lib/story-gate.js de agent-skills): si miraran el NOMBRE DE LA
# CARPETA, un clon descartable del arnés no quedaría excluido, y un repo de producto bajo una carpeta
# llamada `tycon-claude-guides` quedaría excluido sin serlo. Detalle: scripts/lib/harness-repo.js.
#
# «El arnés» no son dos URLs de una organización escritas en el código: es el
# `origin` del propio clon (y el de agent-skills), normalizado para cualquier host. Los casos de siempre
# corren con las identidades de referencia INYECTADAS (TYCON_HARNESS_IDENTITIES) para no depender del
# `origin` de la máquina; los nuevos prueban el fork en otro servidor, el producto en el mismo servidor y
# el propio clon con `origin` local. Las URLs de abajo son inventadas (acme): la prueba no depende de ninguna organización de verdad.
# El usuario delante del host se arma con una variable (URL_USER): escrito pegado, el detector de publicación lo lee como un correo.
#
# Repos git efímeros, sin red: `git remote add` no se conecta a nada.
# 🔴 Sin pipes sobre el comando: el exit code REAL es el veredicto.
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
J="$TCG/scripts/lib/harness-repo.js"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/repo-del-arnes.XXXXXX")"
BASE="$(cd "$BASE" && pwd -P)"
trap 'rm -rf "$BASE"' EXIT
FALLAS=0
ok() { echo "✅ $1"; }
bad() { echo "❌ repo-del-arnes: $1"; FALLAS=$((FALLAS + 1)); }

repo() { # $1=dir  $2=origin (vacío = sin origin)
  mkdir -p "$1" && git init -q -b main "$1" && git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
  [ -n "${2:-}" ] && git -C "$1" remote add origin "$2"
  return 0
}
juzga() { # $1=ruta [$2=lib] → imprime "true|false por"
  node -e 'const l=require(process.argv[1]); const j=l.juzgarRuta(process.argv[2]); process.stdout.write(j.arnes+" "+j.por)' "${2:-$J}" "$1"
}
espera() { # $1=nombre $2=ruta $3=esperado ("true remoto", …) [$4=lib]
  local got; got="$(juzga "$2" "${4:-$J}")"
  [ "$got" = "$3" ] && ok "$1" || bad "${1} — esperaba «${3}», dio «${got}»"
}

URL_USER=acme
ARNES="https://${URL_USER}@dev.azure.com/acme/tycon-claude-guides/_git/tycon-claude-guides"
SKILLS='https://acme.visualstudio.com/AgentSkills/_git/AgentSkills'
# Las identidades de referencia, inyectadas: los casos de siempre no dependen del origin de esta máquina.
export TYCON_HARNESS_IDENTITIES="$ARNES,$SKILLS"
# El nombre público del arnés (el del lugar): los casos que arman una carpeta con el nombre interno tienen
# su gemelo con éste. Sale de la constante, nunca escrito a mano.
PUB="$(node -p "require(process.argv[1]).PLACE_NAME" "$TCG/scripts/setup/harness/place.js")"

# T1 — las formas de URL de Azure son el mismo repo; el usuario de la URL no cuenta
node -e '
const { identidadAzure, esIdentidadDelArnes } = require(process.argv[1]);
const at = (usuario, resto) => usuario + "@" + resto; // un usuario delante del host (armado: pegado parece un correo)
const si = [
  "https://" + at("acme", "dev.azure.com/acme/tycon-claude-guides/_git/tycon-claude-guides"),
  "https://" + at("alguien", "dev.azure.com/acme/tycon-claude-guides/_git/tycon-claude-guides"),
  "https://dev.azure.com/acme/_git/tycon-claude-guides",
  "https://dev.azure.com/ACME/Tycon-Claude-Guides/_git/TYCON-CLAUDE-GUIDES/",
  "https://dev.azure.com/acme/tycon-claude-guides/_git/_optimized/tycon-claude-guides",
  "git@ssh.dev.azure.com:v3/acme/tycon-claude-guides/tycon-claude-guides",
  "https://acme.visualstudio.com/AgentSkills/_git/AgentSkills",
  "https://" + at("otro", "acme.visualstudio.com/DefaultCollection/AgentSkills/_git/AgentSkills"),
  "https://acme.visualstudio.com/_git/AgentSkills",
  at("acme", "vs-ssh.visualstudio.com:v3/acme/AgentSkills/AgentSkills"),
];
const no = [
  "https://dev.azure.com/acme/tycon-claude-guides-site/_git/tycon-claude-guides-site", // se parece
  "https://dev.azure.com/otra-org/tycon-claude-guides/_git/tycon-claude-guides",        // otra organización
  "https://dev.azure.com/acme/OtroProducto/_git/tycon-claude-guides",                   // otro proyecto
  "https://github.com/alguien/tycon-claude-guides.git",                                  // otro host
  "", "no-es-una-url",
];
const mal = [...si.filter((u) => !esIdentidadDelArnes(identidadAzure(u))).map((u) => "debía ser del arnés: " + u),
             ...no.filter((u) => esIdentidadDelArnes(identidadAzure(u))).map((u) => "NO debía ser del arnés: " + u)];
if (mal.length) { console.log(mal.join("\n")); process.exit(1); }
' "$J" && ok "T1 las formas de URL de Azure se reconocen, y lo que se parece no" || bad "T1 formas de URL"

# T1b — el normalizador para cualquier host: ssh ≡ https, sin usuario, sin .git, sin caja
node -e '
const { identidadRemoto, mismaIdentidad } = require(process.argv[1]);
const a = identidadRemoto("git@github.com:Alguien/Tycon-Claude-Guides.git");
const b = identidadRemoto("https://alguien@github.com/alguien/tycon-claude-guides");
const c = identidadRemoto("ssh://git@github.com:22/alguien/tycon-claude-guides/");
const d = identidadRemoto("https://github.com/alguien/otro");
const e = identidadRemoto("https://acme.visualstudio.com/AgentSkills/_git/AgentSkills");
const f = identidadRemoto("https://dev.azure.com/acme/AgentSkills/_git/AgentSkills");
const fallas = [];
if (!mismaIdentidad(a, b) || !mismaIdentidad(b, c)) fallas.push("ssh, https y ssh:// del mismo repo tienen que ser la misma identidad");
if (mismaIdentidad(a, d)) fallas.push("otro repo del mismo host NO es la misma identidad");
if (!mismaIdentidad(e, f)) fallas.push("las dos formas de Azure tienen que normalizar a lo mismo");
if (a.nombre !== "Tycon-Claude-Guides") fallas.push("el nombre conserva la caja del remoto: " + a.nombre);
if (identidadRemoto("no-es-una-url") !== null || identidadRemoto("") !== null) fallas.push("lo que no es URL da null");
if (identidadRemoto("C:\\repos\\x") !== null) fallas.push("una ruta de Windows no es un remoto");
// un servidor interno sin dominio (forma scp, host sin punto) ES un remoto, el mismo que su forma ssh:// — y una ruta
// de Windows con barra normal o invertida sigue sin serlo (pase adversarial, vuelta 1)
const g = identidadRemoto("git@gitserver:o/r.git");
if (!g || g.host !== "gitserver" || !mismaIdentidad(g, identidadRemoto("ssh://git@gitserver/o/r"))) fallas.push("git@gitserver:o/r.git tiene que ser un remoto, el mismo que ssh://git@gitserver/o/r");
if (identidadRemoto("C:/repos/x") !== null || identidadRemoto("D:\\x\\y.git") !== null) fallas.push("una ruta de Windows con barra normal o invertida no es un remoto");
if (fallas.length) { console.log(fallas.join("\n")); process.exit(1); }
' "$J" && ok "T1b identidadRemoto: cualquier host, sin usuario, sin .git, sin caja; Azure normalizado" || bad "T1b identidadRemoto"

# T2 — EL CASO: clon del arnés en una carpeta con otro nombre
repo "$BASE/scratchpad/tcg" "$ARNES"
espera "T2 clon del arnés en carpeta con otro nombre → es del arnés, por su remoto" "$BASE/scratchpad/tcg" "true remoto"

# T3 — la otra cara: producto bajo una carpeta llamada como el arnés
repo "$BASE/tycon-claude-guides/MiProducto" "https://${URL_USER}@dev.azure.com/acme/UnProducto/_git/Backend"
espera "T3 producto bajo una carpeta llamada como el arnés → NO es del arnés" "$BASE/tycon-claude-guides/MiProducto" "false remoto"
repo "$BASE/$PUB/MiProducto" "https://${URL_USER}@dev.azure.com/acme/UnProducto/_git/Backend"
espera "T3 gemelo: producto bajo una carpeta con el nombre público del arnés → NO es del arnés" "$BASE/$PUB/MiProducto" "false remoto"

# T4 — la ruta de un ARCHIVO que todavía no existe (un Write de algo nuevo) se juzga por su repo
espera "T4 archivo nuevo dentro del clon del arnés" "$BASE/scratchpad/tcg/scripts/nuevo/archivo.js" "true remoto"
espera "T4b archivo nuevo dentro del producto" "$BASE/tycon-claude-guides/MiProducto/src/nuevo.cs" "false remoto"

# T5 — clon LOCAL de un checkout: se sigue el origin hasta el remoto de verdad
repo "$BASE/canonico" "$SKILLS"
git clone -q "$BASE/canonico" "$BASE/scratchpad/clon-local"
espera "T5 clon local de un checkout del arnés → se sigue hasta el remoto" "$BASE/scratchpad/clon-local" "true remoto"

# T6 — sin origin: ÚNICO lugar donde decide la carpeta (en los dos sentidos)
repo "$BASE/agent-skills" ""
repo "$BASE/suelto" ""
espera "T6 sin origin y carpeta con nombre del arnés → respaldo por carpeta" "$BASE/agent-skills" "true carpeta"
espera "T6b sin origin y otra carpeta → no es del arnés" "$BASE/suelto" "false carpeta"

# T7 — fuera de todo repo git no hay remoto que leer: decide la carpeta, como siempre
mkdir -p "$BASE/afuera/tycon-claude-guides/docs"
espera "T7 ruta fuera de todo repo git → respaldo por carpeta" "$BASE/afuera/tycon-claude-guides/docs/x.md" "true carpeta"
mkdir -p "$BASE/afuera/$PUB/docs"
espera "T7 gemelo: fuera de todo repo git, la carpeta con el nombre público → respaldo por carpeta" "$BASE/afuera/$PUB/docs/x.md" "true carpeta"

# T8 — un remoto de OTRO host bajo una carpeta con nombre del arnés NO es el arnés (es un remoto legible
#      que no es el de referencia)
repo "$BASE/otro/tycon-claude-guides" 'https://github.com/alguien/tycon-claude-guides.git'
espera "T8 remoto de otro host bajo carpeta con nombre del arnés → NO es del arnés" "$BASE/otro/tycon-claude-guides" "false remoto"
repo "$BASE/otro/$PUB" "https://github.com/alguien/$PUB.git"
espera "T8 gemelo: remoto de otro host bajo carpeta con el nombre público del arnés → NO es del arnés" "$BASE/otro/$PUB" "false remoto"
repo "$BASE/raro" 'no-es-una-url'
espera "T8b un origin que no es URL → remoto ilegible, no es del arnés" "$BASE/raro" "false remoto-ilegible"

# T9 — un ciclo de origin locales no cuelga a nadie
repo "$BASE/ciclo-a" "$BASE/ciclo-b"; repo "$BASE/ciclo-b" "$BASE/ciclo-a"
espera "T9 ciclo de origin locales → corta en el tope, no es del arnés" "$BASE/ciclo-a" "false tope-de-saltos"

# T11 — cómo se LLAMA el repo según su remoto (con su caja), siguiendo un origin local; null sin remoto legible
node -e '
const { nombreDeRepo } = require(process.argv[1]); const B = process.argv[2];
const got = [nombreDeRepo(B + "/scratchpad/tcg"), nombreDeRepo(B + "/scratchpad/clon-local"), nombreDeRepo(B + "/suelto"), nombreDeRepo(B + "/otro/tycon-claude-guides"), nombreDeRepo(B + "/raro")];
const exp = ["tycon-claude-guides", "AgentSkills", null, "tycon-claude-guides", null];
if (JSON.stringify(got) !== JSON.stringify(exp)) { console.log("esperaba " + JSON.stringify(exp) + ", dio " + JSON.stringify(got)); process.exit(1); }
' "$J" "$BASE" && ok "T11 nombreDeRepo: el nombre sale del remoto (con su caja), null si no hay remoto legible" || bad "T11 nombreDeRepo"

# T10 — la CLI dice qué decidió, por qué, y qué es «el arnés» acá
out="$(node "$J" "$BASE/scratchpad/tcg")"; rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '"arnes": true' && printf '%s' "$out" | grep -q '"por": "remoto"' \
  && printf '%s' "$out" | grep -q '"identidades_del_arnes"' \
  && ok "T10 la CLI dice qué decidió, por qué, y las identidades de referencia" || bad "T10 CLI (rc=${rc}, out='${out}')"

# ── T7: la identidad propia ─────────────────────────────────────────────────────────

# T12 — un clon del arnés alojado en OTRO servidor (un fork en GitHub) se reconoce en las dos formas;
#       un producto en el mismo servidor, no
repo "$BASE/fork-ssh" 'git@github.com:alguien/tycon-claude-guides.git'
repo "$BASE/fork-https" 'https://github.com/alguien/tycon-claude-guides'
repo "$BASE/producto-gh" 'https://github.com/alguien/otro-producto.git'
export TYCON_HARNESS_IDENTITIES='https://github.com/alguien/tycon-claude-guides'
espera "T12 fork en GitHub (forma ssh) → es del arnés cuando ÉSA es la identidad de referencia" "$BASE/fork-ssh" "true remoto"
espera "T12b fork en GitHub (forma https) → es del arnés" "$BASE/fork-https" "true remoto"
espera "T12c un producto en el mismo servidor → no" "$BASE/producto-gh" "false remoto"
espera "T12d …y el clon de la organización deja de serlo cuando la referencia es el fork (no hay nada escrito a mano)" "$BASE/scratchpad/tcg" "false remoto"
unset TYCON_HARNESS_IDENTITIES

# T13 — sin identidad propia legible (el propio clon no tiene origin, agent-skills tampoco): decide la
#       carpeta, y lo dice
mkdir -p "$BASE/sin-origen/scripts/lib" "$BASE/sin-skills"
cp "$J" "$BASE/sin-origen/scripts/lib/harness-repo.js"
cp "$TCG/scripts/lib/skills-dir.js" "$BASE/sin-origen/scripts/lib/"   # la lib copiada lleva su vecina: sin ella caería al default de agent-skills, que sí tiene origin
cp "$TCG/scripts/lib/legacy-names.js" "$BASE/sin-origen/scripts/lib/"   # y la de los nombres renombrados, que carga al arrancar
export TYCON_SKILLS_DIR="$BASE/sin-skills"   # tampoco agent-skills aporta identidad: no hay ninguna que leer
espera "T13 sin identidad propia → la carpeta decide y se dice" "$BASE/otro/tycon-claude-guides" "true carpeta-sin-identidad-propia" "$BASE/sin-origen/scripts/lib/harness-repo.js"
espera "T13b sin identidad propia, carpeta sin nombre del arnés → no" "$BASE/scratchpad/tcg" "false carpeta-sin-identidad-propia" "$BASE/sin-origen/scripts/lib/harness-repo.js"
unset TYCON_SKILLS_DIR

# T14 — el PROPIO clon con `origin` local (un clon descartable de un checkout): la identidad propia se
#       sigue hasta el remoto de verdad, con la misma cadena que el repo juzgado
repo "$BASE/canonico2" "$ARNES"
git clone -q "$BASE/canonico2" "$BASE/clon-propio"
mkdir -p "$BASE/clon-propio/scripts/lib"
cp "$J" "$BASE/clon-propio/scripts/lib/harness-repo.js"
cp "$TCG/scripts/lib/skills-dir.js" "$TCG/scripts/lib/legacy-names.js" "$BASE/clon-propio/scripts/lib/"
export TYCON_SKILLS_DIR="$BASE/sin-skills"   # que agent-skills no aporte identidad: lo que se mide es el propio clon
espera "T14 propio clon con origin local → se sigue hasta el remoto y reconoce al arnés" "$BASE/scratchpad/tcg" "true remoto" "$BASE/clon-propio/scripts/lib/harness-repo.js"
espera "T14b …y sigue sin confundir el producto" "$BASE/tycon-claude-guides/MiProducto" "false remoto" "$BASE/clon-propio/scripts/lib/harness-repo.js"
unset TYCON_SKILLS_DIR

# T15 — el clon REAL donde corre esta prueba se reconoce a sí mismo por su propio origin (sin inyección)
espera "T15 este mismo clon del arnés, por su propio origin" "$TCG" "true remoto"

# ── T16: «repo del arnés» en las tres formas de máquina ────────
# El arnés y agent-skills son UN repo. Mientras dura la mudanza conviven tres formas de máquina:
#   (a) un árbol: el clon del repo unido, y `~/.claude/agent-skills` es un enlace a él;
#   (b) dos clones, el viejo de agent-skills ya re-apuntado al remoto del arnés (mismo remoto);
#   (c) dos clones, el viejo sin re-apuntar: su `origin` sigue siendo el remoto viejo.
# 🔴 En (c): la identidad de agent-skills sale del `origin` de «donde están las skills», y
#    eso contesta EL PROPIO CLON cuando trae `skills/` (el clon del arnés de toda máquina).
#    Si no, el remoto viejo dejaría de ser «del arnés» y el clon instalado de las skills —donde corren los hooks de toda
#    la máquina— pasaría a tratarse como un repo de producto: pediría story, pipeline y retrospectiva.
#    La referencia suma SIEMPRE el `origin` de lo instalado en `~/.claude/agent-skills` (salvo que la variable
#    diga dónde están las skills: ahí manda la variable, como en todo el arnés).
# Sin identidades inyectadas y con HOME de juguete: lo que se mide es de dónde saca la biblioteca su referencia.
LIBS="harness-repo.js skills-dir.js legacy-names.js canonical-path.js"
own_clone() { # $1=dir $2=origin $3=unified|split → un clon del arnés de juguete, con la biblioteca adentro
  repo "$1" "$2"; mkdir -p "$1/scripts/lib"
  for f in $LIBS; do cp "$TCG/scripts/lib/$f" "$1/scripts/lib/" || bad "T16 no pude copiar scripts/lib/$f"; done
  if [ "$3" = unified ]; then mkdir -p "$1/skills/tycon-pipeline" "$1/agents" "$1/packs"; fi
}
judge_at() { # $1=HOME $2=lib $3=ruta → "true|false por", sin variables que digan otra cosa
  env -u TYCON_HARNESS_IDENTITIES -u TYCON_SKILLS_DIR HOME="$1" node -e 'const l=require(process.argv[1]); const j=l.juzgarRuta(process.argv[2]); process.stdout.write(j.arnes+" "+j.por)' "$2" "$3"
}
expect_at() { # $1=nombre $2=HOME $3=lib $4=ruta $5=esperado
  local got; got="$(judge_at "$2" "$3" "$4")"
  [ "$got" = "$5" ] && ok "$1" || bad "${1} — esperaba «${5}», dio «${got}»"
}
# un producto de la MISMA organización que el arnés (el «no» que cuesta): se arma desde la URL de referencia
PRODUCT="${ARNES%/tycon-claude-guides/_git/tycon-claude-guides}/UnProducto/_git/Backend"
[ "$PRODUCT" != "$ARNES/UnProducto/_git/Backend" ] || bad "T16 no pude armar la URL del producto desde la del arnés"
repo "$BASE/t16/product" "$PRODUCT"
repo "$BASE/t16/work-clone" "$ARNES"            # un clon de trabajo cualquiera del repo unido
repo "$BASE/t16/old-skills-elsewhere" "$SKILLS" # otro clon con el remoto viejo, en otra carpeta

# (a) un árbol
own_clone "$BASE/t16/a/harness" "$ARNES" unified
mkdir -p "$BASE/t16/a/home/.claude"; ln -s "$BASE/t16/a/harness" "$BASE/t16/a/home/.claude/agent-skills"
LIB_A="$BASE/t16/a/harness/scripts/lib/harness-repo.js"
expect_at "T16a un árbol: el clon del repo unido es del arnés" "$BASE/t16/a/home" "$LIB_A" "$BASE/t16/a/harness" "true remoto"
expect_at "T16a …y también llegando por el enlace ~/.claude/agent-skills" "$BASE/t16/a/home" "$LIB_A" "$BASE/t16/a/home/.claude/agent-skills/skills/tycon-pipeline/x.md" "true remoto"
expect_at "T16a …y un clon de trabajo del mismo repo en otra carpeta" "$BASE/t16/a/home" "$LIB_A" "$BASE/t16/work-clone" "true remoto"
expect_at "T16a un repo de producto NO es del arnés" "$BASE/t16/a/home" "$LIB_A" "$BASE/t16/product" "false remoto"

# (b) dos clones, el viejo ya re-apuntado: mismo remoto que el arnés
own_clone "$BASE/t16/b/harness" "$ARNES" unified
repo "$BASE/t16/b/home/.claude/agent-skills" "$ARNES"
LIB_B="$BASE/t16/b/harness/scripts/lib/harness-repo.js"
expect_at "T16b clon viejo re-apuntado (mismo remoto): es del arnés" "$BASE/t16/b/home" "$LIB_B" "$BASE/t16/b/home/.claude/agent-skills" "true remoto"
expect_at "T16b …el clon del arnés también" "$BASE/t16/b/home" "$LIB_B" "$BASE/t16/b/harness" "true remoto"
expect_at "T16b un repo de producto NO es del arnés" "$BASE/t16/b/home" "$LIB_B" "$BASE/t16/product" "false remoto"

# (c) dos clones, el viejo sin re-apuntar: el remoto viejo sigue siendo «del arnés» mientras ese clon exista
own_clone "$BASE/t16/c/harness" "$ARNES" unified
repo "$BASE/t16/c/home/.claude/agent-skills" "$SKILLS"
LIB_C="$BASE/t16/c/harness/scripts/lib/harness-repo.js"
expect_at "T16c 🔴 clon viejo SIN re-apuntar (remoto viejo), con el clon del arnés ya unido: sigue siendo del arnés" "$BASE/t16/c/home" "$LIB_C" "$BASE/t16/c/home/.claude/agent-skills" "true remoto"
expect_at "T16c …y otro clon con el remoto viejo, en otra carpeta, también" "$BASE/t16/c/home" "$LIB_C" "$BASE/t16/old-skills-elsewhere" "true remoto"
expect_at "T16c …el clon del arnés también" "$BASE/t16/c/home" "$LIB_C" "$BASE/t16/c/harness" "true remoto"
expect_at "T16c un repo de producto NO es del arnés" "$BASE/t16/c/home" "$LIB_C" "$BASE/t16/product" "false remoto"
# la máquina con el clon del arnés todavía sin skills/: igual que siempre
own_clone "$BASE/t16/c0/harness" "$ARNES" split
repo "$BASE/t16/c0/home/.claude/agent-skills" "$SKILLS"
LIB_C0="$BASE/t16/c0/harness/scripts/lib/harness-repo.js"
expect_at "T16c la máquina de hoy (arnés sin skills/ + clon de skills con su remoto): los dos son del arnés" "$BASE/t16/c0/home" "$LIB_C0" "$BASE/t16/c0/home/.claude/agent-skills" "true remoto"
expect_at "T16c …y el producto no" "$BASE/t16/c0/home" "$LIB_C0" "$BASE/t16/product" "false remoto"

# (espejo) el remoto viejo NO es del arnés en una máquina que ya no tiene ningún clon con ese remoto: nada escrito a
# mano lo recuerda. Es la forma (a), preguntando por el clon suelto.
expect_at "T16d (espejo) sin ningún clon instalado con el remoto viejo, ese remoto ya no es del arnés" "$BASE/t16/a/home" "$LIB_A" "$BASE/t16/old-skills-elsewhere" "false remoto"
# (espejo) con la variable puesta manda la variable: lo instalado no suma su identidad
got="$(env -u TYCON_HARNESS_IDENTITIES HOME="$BASE/t16/c/home" TYCON_SKILLS_DIR="$BASE/t16/c/harness" node -e 'const l=require(process.argv[1]); const j=l.juzgarRuta(process.argv[2]); process.stdout.write(j.arnes+" "+j.por)' "$LIB_C" "$BASE/t16/old-skills-elsewhere")"
[ "$got" = "false remoto" ] && ok "T16d (espejo) con TYCON_SKILLS_DIR puesta, la referencia es la de la variable y no la de lo instalado" || bad "T16d con la variable esperaba «false remoto», dio «${got}»"

# La raíz de los repos del equipo sigue dejando afuera a los DOS clones, también cuando el instalado de las skills
# vive fuera de ~/.claude (un enlace) y el clon del arnés ya trae skills/: sin eso, una persona con un solo producto
# quedaría con la carpeta del clon de skills como «raíz de sus repos».
R16="$BASE/t16/root"; H16="$R16/home"
mkdir -p "$H16/.claude/projects" "$H16/Infra" "$H16/Proyectos" "$R16/tmp"
repo "$H16/Proyectos/ProductoA" "$PRODUCT"
own_clone "$H16/Infra/harness" "$ARNES" unified
repo "$H16/Infra/skills-old" "$SKILLS"
ln -s "$H16/Infra/skills-old" "$H16/.claude/agent-skills"
session_in() { # $1=nombre de la carpeta de sesión $2=cwd
  mkdir -p "$H16/.claude/projects/$1"
  printf '%s\n' "{\"type\":\"user\",\"cwd\":\"$2\"}" > "$H16/.claude/projects/$1/x.jsonl"
}
session_in "-Users-dev-product-a" "$H16/Proyectos/ProductoA"
session_in "-Users-dev-harness" "$H16/Infra/harness"
session_in "-Users-dev-skills-old" "$H16/Infra/skills-old"
cp "$TCG/scripts/lib/repos-root.js" "$TCG/scripts/lib/tycon-config.js" "$H16/Infra/harness/scripts/lib/" || bad "T16e no pude copiar repos-root.js"
got="$(env -u TYCON_REPOS_ROOT -u TYCON_SKILLS_DIR HOME="$H16" node -e '
const { resolveReposRoot } = require(process.argv[1]);
const r = resolveReposRoot("", { home: process.argv[2], clon: process.argv[3], tmp: process.argv[4], env: {}, sinConfig: true });
process.stdout.write(`${r.fuente} ${r.root} ${r.evidencia}`);' "$H16/Infra/harness/scripts/lib/repos-root.js" "$H16" "$H16/Infra/harness" "$R16/tmp")"
[ "$got" = "sesiones $H16/Proyectos 1" ] \
  && ok "T16e la raíz de repos deja afuera a los dos clones (el del arnés y el de las skills, aunque viva fuera de ~/.claude): queda la carpeta del producto" \
  || bad "T16e esperaba «sesiones $H16/Proyectos 1», dio «${got}»"

# T16f · la MISMA máquina, cuando la persona todavía no abrió una sesión en
# el producto. El paso de las sesiones deja afuera a los dos clones, y el paso «vecino» también tiene que descartar a los dos: si sólo descartara al del
# arnés, el clon viejo de las skills contaría como «otro repo al lado» y la raíz saldría `Infra` (con el producto en
# `Proyectos`): cero repos que auditar, sin el error «no se miró ningún repo». Lo esperado es «sin raíz».
root_of() { # imprime "fuente raíz evidencia" de la casa H16, con el clon del arnés de Infra/harness
  env -u TYCON_REPOS_ROOT -u TYCON_SKILLS_DIR HOME="$H16" node -e '
const { resolveReposRoot } = require(process.argv[1]);
const r = resolveReposRoot("", { home: process.argv[2], clon: process.argv[3], tmp: process.argv[4], env: {}, sinConfig: true });
process.stdout.write(`${r.fuente} ${r.root} ${r.evidencia}`);' "$H16/Infra/harness/scripts/lib/repos-root.js" "$H16" "$H16/Infra/harness" "$R16/tmp"
}
rm -rf "$H16/.claude/projects/-Users-dev-product-a"
got="$(root_of)"
[ "$got" = "sin-raiz null undefined" ] \
  && ok "T16f sin sesión en el producto, el clon viejo de las skills al lado del arnés no convierte a su carpeta en la raíz: sin raíz" \
  || bad "T16f esperaba «sin-raiz null undefined», dio «${got}»"
# (espejo) un producto de verdad al lado del arnés sí: vecino, y la evidencia lo cuenta a él solo
repo "$H16/Infra/ProductoB" "$PRODUCT"
got="$(root_of)"
[ "$got" = "vecino $H16/Infra 1" ] \
  && ok "T16f (espejo) con un producto al lado del arnés, la raíz es esa carpeta y la evidencia cuenta al producto, no al clon de las skills" \
  || bad "T16f (espejo) esperaba «vecino $H16/Infra 1», dio «${got}»"

# T16g · la referencia de «el arnés» le pregunta dónde están las skills a
# scripts/lib/skills-dir.js; un `catch` que tragara CUALQUIER error de esa pregunta y siguiera con `~/.claude/agent-skills`
# haría que, con `TYCON_SKILLS_DIR` puesta y un skills-dir.js que está y no carga, la referencia saliera de lo instalado en
# vez de la variable —un clon suelto con el remoto viejo pasaría a ser «del arnés», y el de la variable dejaría de
# serlo— con código 0 y sin una línea. Y skills-dir.js TIRA cuando su vecina canonical-path.js está y no carga:
# ese aviso tampoco puede perderse acá (sin variable la respuesta coincide, porque lo instalado suma
# siempre; el error igual tiene que verse). El valor por defecto es sólo para la copia que viaja SIN skills-dir.js.
ask_at() { # $1=HOME $2=lib $3=ruta [$4=TYCON_SKILLS_DIR] → deja la respuesta en ASK_OUT, el código en ASK_RC y stderr en ASK_ERR
  local err="$BASE/t16/ask-err.txt"
  if [ -n "${4:-}" ]; then
    ASK_OUT="$(env -u TYCON_HARNESS_IDENTITIES HOME="$1" TYCON_SKILLS_DIR="$4" node -e 'const l=require(process.argv[1]); const j=l.juzgarRuta(process.argv[2]); process.stdout.write(j.arnes+" "+j.por)' "$2" "$3" 2>"$err")"; ASK_RC=$?
  else
    ASK_OUT="$(env -u TYCON_HARNESS_IDENTITIES -u TYCON_SKILLS_DIR HOME="$1" node -e 'const l=require(process.argv[1]); const j=l.juzgarRuta(process.argv[2]); process.stdout.write(j.arnes+" "+j.por)' "$2" "$3" 2>"$err")"; ASK_RC=$?
  fi
  ASK_ERR="$(cat "$err")"
}
expect_throw() { # $1=nombre $2=texto que stderr tiene que traer — sobre el último ask_at
  if [ "$ASK_RC" -ne 0 ] && [ -z "$ASK_OUT" ] && printf '%s' "$ASK_ERR" | grep -qF -- "$2"; then ok "$1"
  else bad "${1} — esperaba un error que nombre «${2}» y ninguna respuesta; dio rc=${ASK_RC}, respuesta «${ASK_OUT}»"; fi
}
expect_answer() { # $1=nombre $2=esperado — sobre el último ask_at: esa respuesta, código 0 y stderr vacío
  if [ "$ASK_RC" -eq 0 ] && [ "$ASK_OUT" = "$2" ] && [ -z "$ASK_ERR" ]; then ok "$1"
  else bad "${1} — esperaba «${2}» con código 0 y sin avisos; dio rc=${ASK_RC}, «${ASK_OUT}», stderr «${ASK_ERR}»"; fi
}
G16="$BASE/t16/g"
repo "$G16/home/.claude/agent-skills" "$SKILLS"                                   # lo instalado, con el remoto viejo
THIRD="${ARNES%/tycon-claude-guides/_git/tycon-claude-guides}/OtherSkills/_git/OtherSkills"
repo "$G16/other-skills" "$THIRD"; mkdir -p "$G16/other-skills/skills"            # adonde apunta la variable

# (control) el clon sano: con la variable, la referencia es la de la variable y no la de lo instalado
own_clone "$G16/sane" "$ARNES" unified
ask_at "$G16/home" "$G16/sane/scripts/lib/harness-repo.js" "$BASE/t16/old-skills-elsewhere" "$G16/other-skills"
expect_answer "T16g (control) clon sano, con la variable: el remoto viejo suelto NO es del arnés" "false remoto"
ask_at "$G16/home" "$G16/sane/scripts/lib/harness-repo.js" "$G16/other-skills" "$G16/other-skills"
expect_answer "T16g (control) …y el repo adonde apunta la variable SÍ" "true remoto"

# 🔴 skills-dir.js ESTÁ y rompe al cargarse: no se lee como «no está»
own_clone "$G16/broken-rule" "$ARNES" unified
printf '%s\n' 'throw new Error("skills-dir rota a proposito");' > "$G16/broken-rule/scripts/lib/skills-dir.js"
ask_at "$G16/home" "$G16/broken-rule/scripts/lib/harness-repo.js" "$BASE/t16/old-skills-elsewhere" "$G16/other-skills"
expect_throw "T16g 🔴 skills-dir.js presente y rota, con la variable: el error sale (antes: «true remoto», la referencia de lo instalado, callado)" "skills-dir rota a proposito"
ask_at "$G16/home" "$G16/broken-rule/scripts/lib/harness-repo.js" "$G16/other-skills" "$G16/other-skills"
expect_throw "T16g 🔴 …y el repo de la variable no pasa a «no es del arnés» en silencio" "skills-dir rota a proposito"

# 🔴 la vecina canonical-path.js ESTÁ y un require suyo no existe: skills-dir.js tira, y acá no se tapa
own_clone "$G16/broken-neighbor" "$ARNES" unified
printf '\n%s\n' 'require("./moved-away-helper.js");' >> "$G16/broken-neighbor/scripts/lib/canonical-path.js"
ask_at "$G16/home" "$G16/broken-neighbor/scripts/lib/harness-repo.js" "$BASE/t16/product"
expect_throw "T16g 🔴 canonical-path.js presente y rota, sin variable: el error sale y nombra el archivo que falta (antes: código 0, callado)" "moved-away-helper.js"
# (espejo) con la variable no hace falta saber si el clon es unido: la vecina rota no se carga y la respuesta es la sana
ask_at "$G16/home" "$G16/broken-neighbor/scripts/lib/harness-repo.js" "$BASE/t16/old-skills-elsewhere" "$G16/other-skills"
expect_answer "T16g (espejo) vecina rota CON la variable: contesta como el clon sano" "false remoto"

# (espejo) la copia que viaja SIN skills-dir.js: lo de siempre, ~/.claude/agent-skills, sin error
own_clone "$G16/no-rule" "$ARNES" unified
rm "$G16/no-rule/scripts/lib/skills-dir.js"
ask_at "$G16/home" "$G16/no-rule/scripts/lib/harness-repo.js" "$BASE/t16/old-skills-elsewhere"
expect_answer "T16g (espejo) sin skills-dir.js al lado: la referencia suma lo instalado, como siempre" "true remoto"
ask_at "$G16/home" "$G16/no-rule/scripts/lib/harness-repo.js" "$BASE/t16/product"
expect_answer "T16g (espejo) …y un producto sigue sin ser del arnés" "false remoto"

# T16h · la búsqueda de la raíz de repos (repos-root.js)
# también le pregunta a skills-dir.js dónde están las skills, para excluir ese clon, y no puede tragar el error como los otros dos lectores.
# Con la regla rota, una raíz tranquila con código 0 y sin una línea escondería el error.
root_at() { # $1=HOME $2=lib → la salida en ROOT_OUT, el código en ROOT_RC y stderr en ROOT_ERR
  local err="$BASE/t16/root-err.txt"
  ROOT_OUT="$(env -u TYCON_REPOS_ROOT -u TYCON_SKILLS_DIR HOME="$1" node "$2" 2>"$err")"; ROOT_RC=$?
  ROOT_ERR="$(cat "$err")"
}
for c in sane broken-rule broken-neighbor no-rule; do   # la búsqueda de la raíz y el lector de configuración que carga
  cp "$TCG/scripts/lib/repos-root.js" "$TCG/scripts/lib/tycon-config.js" "$G16/$c/scripts/lib/" || bad "T16h no pude copiar las bibliotecas a $c"
done
root_at "$G16/home" "$G16/sane/scripts/lib/repos-root.js"
if [ "$ROOT_RC" -eq 0 ] && [ -z "$ROOT_ERR" ]; then ok "T16h (control) clon sano: la raíz de repos contesta con código 0 y sin avisos"
else bad "T16h (control) esperaba código 0 y sin avisos; dio rc=${ROOT_RC}, stderr «${ROOT_ERR}»"; fi
root_at "$G16/home" "$G16/broken-rule/scripts/lib/repos-root.js"
if [ "$ROOT_RC" -ne 0 ] && printf '%s' "$ROOT_ERR" | grep -qF -- "skills-dir rota a proposito"; then ok "T16h 🔴 skills-dir.js presente y rota: la raíz de repos NO contesta en verde, el error sale"
else bad "T16h 🔴 esperaba un error que nombre la regla rota; dio rc=${ROOT_RC}, salida «${ROOT_OUT}», stderr «${ROOT_ERR}»"; fi
root_at "$G16/home" "$G16/broken-neighbor/scripts/lib/repos-root.js"
if [ "$ROOT_RC" -ne 0 ] && printf '%s' "$ROOT_ERR" | grep -qF -- "moved-away-helper.js"; then ok "T16h 🔴 canonical-path.js presente y rota: el error sale y nombra el archivo que falta"
else bad "T16h 🔴 esperaba un error que nombre moved-away-helper.js; dio rc=${ROOT_RC}, salida «${ROOT_OUT}», stderr «${ROOT_ERR}»"; fi
root_at "$G16/home" "$G16/no-rule/scripts/lib/repos-root.js"
if [ "$ROOT_RC" -eq 0 ] && [ -z "$ROOT_ERR" ]; then ok "T16h (espejo) sin skills-dir.js al lado: contesta como siempre, excluyendo lo instalado"
else bad "T16h (espejo) esperaba código 0 y sin avisos; dio rc=${ROOT_RC}, stderr «${ROOT_ERR}»"; fi

# ── T21: el repo público (GitHub) y el de mantenimiento (Azure DevOps) son «del arnés» ──────
# HarnessRepo_PublicCloneAndMaintainersAreHarness_ProductIsNot. Quien mantiene escribe en el público y lo
# interno vive en el repo de mantenimiento: los dos se trabajan como el arnés (sin story ni pipeline de producto). Su
# identidad no se escribe en el código: la declara el clon que corre —en el interno, el nombre público y el de
# mantenimiento en scripts/publishing/public-repos.json; en la copia, los remotos públicos en
# scripts/setup/public-remotes.json—. Nombres inventados (acme): la prueba no depende de la organización de verdad.
T21="$BASE/t21"
T21_INTERNAL='https://dev.azure.com/acme/harness/_git/acme-harness-internal'
T21_PUBLIC='https://github.com/acme/acme-harness'
T21_MAINT='https://dev.azure.com/acme/harness/_git/harness-maintainers'
mkdir -p "$T21/home"
own_clone "$T21/internal" "$T21_INTERNAL" split
mkdir -p "$T21/internal/scripts/publishing"
printf '{ "org": "acme", "repo": "acme-harness", "maintainers": "%s" }\n' "$T21_MAINT" > "$T21/internal/scripts/publishing/public-repos.json"
repo "$T21/public-clone" 'git@github.com:Acme/acme-harness.git'
repo "$T21/maintainers-clone" "https://${URL_USER}@dev.azure.com/acme/harness/_git/harness-maintainers"
repo "$T21/product" 'https://dev.azure.com/acme/Producto/_git/backend'
repo "$T21/public-lookalike" 'https://github.com/acme/acme-harness-site'
L21="$T21/internal/scripts/lib/harness-repo.js"
expect_at "T21 el clon del repo público (GitHub), declarado junto al interno → es del arnés" "$T21/home" "$L21" "$T21/public-clone" "true remoto"
expect_at "T21b el clon del repo de mantenimiento (Azure DevOps), declarado → es del arnés" "$T21/home" "$L21" "$T21/maintainers-clone" "true remoto"
expect_at "T21c un repo de producto → no" "$T21/home" "$L21" "$T21/product" "false remoto"
expect_at "T21d un repo que sólo se parece al público → no (nunca por substring)" "$T21/home" "$L21" "$T21/public-lookalike" "false remoto"
# la copia pública no trae public-repos.json: el público lo declara public-remotes.json, con el nombre ya puesto
own_clone "$T21/copy" "$T21_PUBLIC" split
mkdir -p "$T21/copy/scripts/setup"
printf '{ "remotes": ["%s"] }\n' "$T21_PUBLIC" > "$T21/copy/scripts/setup/public-remotes.json"
repo "$T21/fork-of-copy" 'https://github.com/acme/acme-harness.git'
own_clone "$T21/copy-alone" 'https://github.com/someone-else/fork' split
mkdir -p "$T21/copy-alone/scripts/setup"
printf '{ "remotes": ["%s"] }\n' "$T21_PUBLIC" > "$T21/copy-alone/scripts/setup/public-remotes.json"
expect_at "T21e un clon de la copia que corre desde otro remoto reconoce al público por public-remotes.json" "$T21/home" "$T21/copy-alone/scripts/lib/harness-repo.js" "$T21/fork-of-copy" "true remoto"
# sin la declaración, el público no es del arnés: la prueba falla si se saca la lectura (control del mutante)
own_clone "$T21/undeclared" "$T21_INTERNAL" split
expect_at "T21f (control) sin nada declarado, el clon del público NO es del arnés" "$T21/home" "$T21/undeclared/scripts/lib/harness-repo.js" "$T21/public-clone" "false remoto"
expect_at "T21g (control) …ni el de mantenimiento" "$T21/home" "$T21/undeclared/scripts/lib/harness-repo.js" "$T21/maintainers-clone" "false remoto"
# una declaración ilegible no suma nada (la duda va hacia más control) y la CLI lo dice
own_clone "$T21/broken" "$T21_INTERNAL" split
mkdir -p "$T21/broken/scripts/publishing"
printf '{ "org": "acme", ' > "$T21/broken/scripts/publishing/public-repos.json"
expect_at "T21h una declaración ilegible no suma: el público sigue sin ser del arnés" "$T21/home" "$T21/broken/scripts/lib/harness-repo.js" "$T21/public-clone" "false remoto"
expect_at "T21i …y el interno sigue siéndolo por su propio remoto" "$T21/home" "$T21/broken/scripts/lib/harness-repo.js" "$T21/internal" "true remoto"
CLI21="$(env -u TYCON_HARNESS_IDENTITIES -u TYCON_SKILLS_DIR HOME="$T21/home" node "$T21/broken/scripts/lib/harness-repo.js" "$T21/public-clone")"
if printf '%s' "$CLI21" | grep -q 'public-repos.json'; then ok "T21j la CLI dice qué declaración no pudo leer"
else bad "T21j la CLI no nombra la declaración ilegible: «${CLI21}»"; fi
# sin identidad propia legible (el clon sin origin, sin agent-skills), lo declarado NO arma una referencia: decide la
# carpeta y se dice, como siempre (sumar lo declarado taparía ese respaldo)
mkdir -p "$T21/noorigin/scripts/lib" "$T21/noorigin/scripts/publishing"
for f in $LIBS; do cp "$TCG/scripts/lib/$f" "$T21/noorigin/scripts/lib/"; done
printf '{ "org": "acme", "repo": "acme-harness", "maintainers": "%s" }\n' "$T21_MAINT" > "$T21/noorigin/scripts/publishing/public-repos.json"
expect_at "T21l sin origin propio, con declaraciones al lado: la carpeta decide y se dice" "$T21/home" "$T21/noorigin/scripts/lib/harness-repo.js" "$BASE/otro/tycon-claude-guides" "true carpeta-sin-identidad-propia"
expect_at "T21m …y el clon del público no se cuela por la declaración" "$T21/home" "$T21/noorigin/scripts/lib/harness-repo.js" "$T21/public-clone" "false carpeta-sin-identidad-propia"
# las identidades inyectadas siguen mandando (las pruebas y quien las fije): lo declarado no se suma encima
got21="$(env -u TYCON_SKILLS_DIR HOME="$T21/home" TYCON_HARNESS_IDENTITIES="$T21_INTERNAL" node -e 'const l=require(process.argv[1]); const j=l.juzgarRuta(process.argv[2]); process.stdout.write(j.arnes+" "+j.por)' "$L21" "$T21/public-clone")"
[ "$got21" = "false remoto" ] && ok "T21k con identidades inyectadas, lo declarado no se suma" || bad "T21k esperaba «false remoto», dio «${got21}»"

# ── T78: el clon de mantenimiento se reconoce desde la MÁQUINA ───────────────────
# `MaintainerMachine_FromPublicClone_MaintainersCloneIsHarness_MergeModeFound` (la mitad del merge: merge-pr.test.js)
# Quien mantiene trabaja en un clon del PÚBLICO, que no trae public-repos.json: la dirección del
# repo de mantenimiento no la declara el árbol. La declara la máquina (`paths.maintainers` de ~/.tycon/config.json):
# cuenta el `origin` de ESE clon. Y vale también cuando el arnés que corre no tiene `origin` propio (una versión
# instalada no es un clon): sin esto, la referencia queda vacía y decide el nombre de la carpeta.
T78="$BASE/t78"
T78_PUBLIC='https://github.com/acme/acme-harness'
T78_MAINT='https://dev.azure.com/acme/harness/_git/acme-harness-internal'
machine() { # $1=HOME $2=contenido de ~/.tycon/config.json
  mkdir -p "$1/.tycon"; printf '%s\n' "$2" > "$1/.tycon/config.json"
}
with_home_lib() { # $1=árbol → le suma tycon-home.js, como lo trae toda copia del arnés
  mkdir -p "$1/scripts/setup/harness"; cp "$TCG/scripts/setup/harness/tycon-home.js" "$1/scripts/setup/harness/" || bad "T78 no pude copiar tycon-home.js"
}
judge78() { # $1=HOME $2=lib $3=ruta [$4.. variables] → "true|false por", sin nada del ambiente que diga otra cosa
  local home="$1" lib="$2" target="$3"; shift 3
  env -u TYCON_HARNESS_IDENTITIES -u TYCON_SKILLS_DIR -u TYCON_HOME -u GIT_DIR -u GIT_WORK_TREE HOME="$home" "$@" node -e 'const l=require(process.argv[1]); const j=l.juzgarRuta(process.argv[2]); process.stdout.write(j.arnes+" "+j.por)' "$lib" "$target"
}
expect78() { # $1=nombre $2=HOME $3=lib $4=ruta $5=esperado [$6.. variables]
  local name="$1" home="$2" lib="$3" target="$4" want="$5"; shift 5
  local got; got="$(judge78 "$home" "$lib" "$target" "$@")"
  [ "$got" = "$want" ] && ok "$name" || bad "${name} — esperaba «${want}», dio «${got}»"
}
cli78() { # $1=HOME $2=lib $3=ruta → la salida de la orden a mano
  env -u TYCON_HARNESS_IDENTITIES -u TYCON_SKILLS_DIR -u TYCON_HOME -u GIT_DIR -u GIT_WORK_TREE HOME="$1" node "$2" "$3"
}
# el clon del público de juguete: su `origin` es el público, trae la biblioteca y tycon-home.js, y NADA de lo privado
own_clone "$T78/public-clone" "$T78_PUBLIC" split; with_home_lib "$T78/public-clone"
L78="$T78/public-clone/scripts/lib/harness-repo.js"
[ ! -e "$T78/public-clone/scripts/publishing/public-repos.json" ] && [ ! -e "$T78/public-clone/.tycon" ] || bad "T78 el clon del público de juguete trae algo privado"
repo "$T78/work/internal" "https://${URL_USER}@dev.azure.com/acme/harness/_git/acme-harness-internal"   # el clon de mantenimiento
repo "$T78/tmp/tcg-descartable" "$T78_MAINT"          # otro clon del mismo repo, en una carpeta que no se llama como nada
repo "$T78/product" 'https://dev.azure.com/acme/Producto/_git/backend'
repo "$T78/other/agent-skills" 'https://dev.azure.com/acme/Producto/_git/frontend'   # un producto en una carpeta con nombre del arnés
machine "$T78/home" "{ \"paths\": { \"maintainers\": \"$T78/work/internal\" } }"
mkdir -p "$T78/home-plain"

expect78 "T78 desde un clon del público, el clon de mantenimiento que declara la máquina → es del arnés" "$T78/home" "$L78" "$T78/work/internal" "true remoto"
expect78 "T78b …y cualquier otro clon de ese repo, esté en la carpeta que esté" "$T78/home" "$L78" "$T78/tmp/tcg-descartable" "true remoto"
expect78 "T78c …un repo de producto sigue sin serlo" "$T78/home" "$L78" "$T78/product" "false remoto"
expect78 "T78d (control) sin la declaración de la máquina, el de mantenimiento NO es del arnés" "$T78/home-plain" "$L78" "$T78/work/internal" "false remoto"

# el arnés INSTALADO: una carpeta que no es un clon (sin `origin`), con lo que la copia trae
T78_INST="$T78/installed/harness"
mkdir -p "$T78_INST/scripts/lib" "$T78_INST/scripts/setup"
for f in $LIBS; do cp "$TCG/scripts/lib/$f" "$T78_INST/scripts/lib/"; done
with_home_lib "$T78_INST"
printf '{ "remotes": ["%s"] }\n' "$T78_PUBLIC" > "$T78_INST/scripts/setup/public-remotes.json"
LI78="$T78_INST/scripts/lib/harness-repo.js"
repo "$T78/somewhere/copy-of-public" 'git@github.com:Acme/acme-harness.git'
expect78 "T78e el arnés instalado (sin origin propio) + la máquina: el clon de mantenimiento se reconoce por su remoto" "$T78/home" "$LI78" "$T78/tmp/tcg-descartable" "true remoto"
expect78 "T78f …y con esa referencia, el clon del público que la copia declara también" "$T78/home" "$LI78" "$T78/somewhere/copy-of-public" "true remoto"
expect78 "T78g …un producto en una carpeta con nombre del arnés deja de colarse por la carpeta" "$T78/home" "$LI78" "$T78/other/agent-skills" "false remoto"
expect78 "T78h (control) el arnés instalado SIN la declaración de la máquina: decide la carpeta y se dice, como siempre" "$T78/home-plain" "$LI78" "$T78/tmp/tcg-descartable" "false carpeta-sin-identidad-propia"

# una copia SUELTA de la biblioteca (el banco, un laboratorio), sin tycon-home.js al lado: no lee la configuración de la máquina
own_clone "$T78/loose" "$T78_PUBLIC" split
expect78 "T78i sin tycon-home.js al lado no hay declaración de máquina" "$T78/home" "$T78/loose/scripts/lib/harness-repo.js" "$T78/work/internal" "false remoto"

# …con un tycon-home.js ANTERIOR a la clave (no trae `maintainersClone`): no hay declaración, y no es un problema
own_clone "$T78/old-home" "$T78_PUBLIC" split; mkdir -p "$T78/old-home/scripts/setup/harness"
printf "'use strict';\nmodule.exports = { ownPaths: () => ({}) };\n" > "$T78/old-home/scripts/setup/harness/tycon-home.js"
expect78 "T78i2 un tycon-home.js anterior a la clave: no hay declaración de máquina" "$T78/home" "$T78/old-home/scripts/lib/harness-repo.js" "$T78/work/internal" "false remoto"
out78="$(cli78 "$T78/home" "$T78/old-home/scripts/lib/harness-repo.js" "$T78/work/internal")"
printf '%s' "$out78" | grep -q '"declaracion_de_maquina"' && bad "T78i3 con un tycon-home.js anterior a la clave la orden a mano inventa una declaración: «${out78}»" || ok "T78i3 …y la orden a mano no dice nada de una declaración que no puede leer"
# …con un tycon-home.js cuya lectura de la clave TIRA: no suma, no se cae, y se dice (no se lee como «no declara nada»).
# (Un tycon-home.js que directamente no carga tira en las otras bibliotecas que lo piden, a propósito: no es este caso.)
own_clone "$T78/broken-home" "$T78_PUBLIC" split; mkdir -p "$T78/broken-home/scripts/setup/harness"
printf "'use strict';\nmodule.exports = Object.assign({}, require(%s), { maintainersClone() { throw new Error('roto a propósito'); } });\n" "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$TCG/scripts/setup/harness/tycon-home.js")" > "$T78/broken-home/scripts/setup/harness/tycon-home.js"
expect78 "T78i4 una lectura de la clave que tira: no suma y no se cae" "$T78/home" "$T78/broken-home/scripts/lib/harness-repo.js" "$T78/work/internal" "false remoto"
out78="$(cli78 "$T78/home" "$T78/broken-home/scripts/lib/harness-repo.js" "$T78/work/internal")"
printf '%s' "$out78" | grep -q '"declaracion_de_maquina"' && printf '%s' "$out78" | grep -q 'no pude leer lo que declara la máquina' \
  && ok "T78i5 …y la orden a mano dice que no pudo leer lo que declara la máquina" || bad "T78i5 un tycon-home.js que no carga quedó callado: «${out78}»"

# declarada y rota: no suma nada, y la orden a mano lo NOMBRA
machine "$T78/home-gone" "{ \"paths\": { \"maintainers\": \"$T78/no-such-clone\" } }"
expect78 "T78j la carpeta declarada no está → no suma" "$T78/home-gone" "$L78" "$T78/work/internal" "false remoto"
out78="$(cli78 "$T78/home-gone" "$L78" "$T78/work/internal")"
printf '%s' "$out78" | grep -q '"declaracion_de_maquina"' && printf '%s' "$out78" | grep -q 'paths.maintainers' && ok "T78k la orden a mano nombra la declaración que no sirve" || bad "T78k la orden a mano no nombra la declaración rota: «${out78}»"
# …la carpeta declarada NO es la raíz de un repo (una subcarpeta de un producto): git subiría al repo de arriba
mkdir -p "$T78/product/inside"
machine "$T78/home-inside" "{ \"paths\": { \"maintainers\": \"$T78/product/inside\" } }"
expect78 "T78l una carpeta declarada que no es la raíz de su repo no suma: el producto de arriba NO pasa a ser del arnés" "$T78/home-inside" "$L78" "$T78/product" "false remoto"
# …una configuración que no se deja leer
machine "$T78/home-broken" '{ "paths": '
expect78 "T78m una configuración de máquina ilegible no suma" "$T78/home-broken" "$L78" "$T78/work/internal" "false remoto"
out78="$(cli78 "$T78/home-broken" "$L78" "$T78/work/internal")"
printf '%s' "$out78" | grep -q '"declaracion_de_maquina"' && ok "T78n …y la orden a mano lo dice" || bad "T78n la orden a mano calla una configuración ilegible: «${out78}»"
# …y TYCON_HOME mal puesta (relativa): tampoco suma, y se dice
got78="$(judge78 "$T78/home" "$L78" "$T78/work/internal" TYCON_HOME=relativa)"
[ "$got78" = "false remoto" ] && ok "T78o con TYCON_HOME inválida no suma (y no se cae)" || bad "T78o esperaba «false remoto», dio «${got78}»"
# la orden a mano, cuando sirve, dice de dónde salió
out78="$(cli78 "$T78/home" "$L78" "$T78/work/internal")"
printf '%s' "$out78" | grep -q 'dev.azure.com/acme/harness/acme-harness-internal' && printf '%s' "$out78" | grep -q '"declaracion_de_maquina"' && ok "T78p la orden a mano muestra la identidad que sumó la máquina" || bad "T78p «${out78}»"

# las identidades inyectadas siguen mandando: la declaración de la máquina no se suma encima
got78="$(judge78 "$T78/home" "$L78" "$T78/work/internal" TYCON_HARNESS_IDENTITIES="$T78_PUBLIC")"
[ "$got78" = "false remoto" ] && ok "T78q con identidades inyectadas, lo que declara la máquina no se suma" || bad "T78q esperaba «false remoto», dio «${got78}»"

# un clon de un clon (el de mantenimiento con `origin` local) se sigue hasta el remoto de verdad
git clone --quiet "$T78/work/internal" "$T78/work/clone-of-internal" 2>/dev/null || bad "T78 no pude clonar el clon"
machine "$T78/home-chain" "{ \"paths\": { \"maintainers\": \"$T78/work/clone-of-internal\" } }"
expect78 "T78r el clon declarado con origin local se sigue hasta su remoto" "$T78/home-chain" "$L78" "$T78/tmp/tcg-descartable" "true remoto"

# cuál de los repos del arnés es el PÚBLICO (lo usa merge-pr.js: la configuración del merge de un clon del público sale
# del clon de mantenimiento, y de ningún otro repo «del arnés»): lo dice lo que el árbol declara, nunca la máquina
pub78() { # $1=HOME $2=lib $3=url → true|false
  env -u TYCON_HARNESS_IDENTITIES -u TYCON_SKILLS_DIR -u TYCON_HOME -u GIT_DIR -u GIT_WORK_TREE HOME="$1" node -e 'const l=require(process.argv[1]); process.stdout.write(String(l.esPublicoDeclarado(l.identidadRemoto(process.argv[2]))))' "$2" "$3"
}
[ "$(pub78 "$T78/home" "$LI78" 'git@github.com:Acme/acme-harness.git')" = true ] && ok "T78u el público que la copia declara (public-remotes.json) es «el público declarado»" || bad "T78u el público declarado por la copia no se reconoce"
[ "$(pub78 "$T78/home" "$LI78" "$T78_MAINT")" = false ] && ok "T78v el de mantenimiento, que declara la máquina, NO es el público" || bad "T78v el repo de mantenimiento salió como público"
[ "$(pub78 "$T78/home" "$LI78" 'https://github.com/acme/acme-harness-site')" = false ] && ok "T78w un repo que sólo se le parece, tampoco" || bad "T78w un parecido salió como público"
[ "$(pub78 "$T21/home" "$L21" 'https://github.com/acme/acme-harness')" = true ] && [ "$(pub78 "$T21/home" "$L21" "$T21_MAINT")" = false ] \
  && ok "T78x en el interno (public-repos.json): el org/repo de GitHub es el público; su «maintainers», no" || bad "T78x public-repos.json: el público o el de mantenimiento mal clasificados"

# la ruta declarada con OTRAS MAYÚSCULAS que la carpeta del disco: en un disco que no
# las distingue —el de la Mac por defecto, el de Windows— es la misma carpeta, `harness.js config set` la guarda como se
# tipeó, y git contesta con la caja de verdad. Comparada sin corregir la caja, la declaración saldría «no es la raíz de un
# clon de git»: no sumaría, y el motivo sería falso. (En un disco que sí las distingue, la otra caja es otra carpeta: no se mide.)
mkdir -p "$T78/CaseProbe"
if [ -d "$T78/caseprobe" ]; then
  repo "$T78/work/Internal-Caja" 'https://dev.azure.com/acme/harness/_git/acme-harness-internal'
  machine "$T78/home-case" "{ \"paths\": { \"maintainers\": \"$T78/work/internal-caja\" } }"
  expect78 "T78case la carpeta declarada con otras mayúsculas (disco que no las distingue) suma igual" "$T78/home-case" "$L78" "$T78/tmp/tcg-descartable" "true remoto"
  out78="$(cli78 "$T78/home-case" "$L78" "$T78/tmp/tcg-descartable")"
  printf '%s' "$out78" | grep -q '"problema"' && bad "T78case2 la orden a mano informa un problema que no hay: «${out78}»" || ok "T78case2 …y la orden a mano no informa ningún problema"
else
  ok "T78case NO MEDIDO: este disco distingue mayúsculas (la otra caja es otra carpeta)"
fi
# un git que no contesta no es «no es un clon»: el motivo dice lo que pasó (cazador de fallos silenciosos)
mkdir -p "$T78/slowbin"
printf '#!/bin/sh\nsleep 8\n' > "$T78/slowbin/git"; chmod +x "$T78/slowbin/git"
out78="$(env -u TYCON_HARNESS_IDENTITIES -u TYCON_SKILLS_DIR -u TYCON_HOME -u GIT_DIR -u GIT_WORK_TREE HOME="$T78/home" PATH="$T78/slowbin:$PATH" node -e 'const l=require(process.argv[1]); process.stdout.write(JSON.stringify(l.deLaMaquina()))' "$L78")"
printf '%s' "$out78" | grep -q 'git no contest' && ! printf '%s' "$out78" | grep -q 'no es la raíz' \
  && ok "T78slow con un git que no contesta, el motivo es «git no contestó», no «no es la raíz de un clon»" || bad "T78slow el motivo de un git colgado es falso: «${out78}»"

# 🔴 Lo que esa declaración CAMBIA en la máquina: los tres controles que excluyen a
# «los repos del arnés» le preguntan a ESTE reconocedor, así que en un clon descartable del repo del arnés —donde en una
# máquina con la versión instalada corren— dejan de correr. Se fija acá por los dos lados: (1) cada control sigue
# preguntándole al reconocedor (si alguno pasa a decidir por su cuenta, esto avisa), y (2) la respuesta que reciben para
# un archivo de ese clon, con la pregunta que cada uno hace (por repo o por ruta).
for caller in \
  "scripts/hooks/retro-pending.js:esRepoDelArnes(root)" \
  "scripts/hooks/unpushed-work-notice.js:esRepoDelArnes(root)" \
  "skills/tycon-pipeline/scripts/lib/story-gate-io.js:esRutaDelArnes(filePath)"; do
  f78="${caller%%:*}"; q78="${caller#*:}"
  grep -qF "$q78" "$TCG/$f78" && grep -qF "harness-repo.js" "$TCG/$f78" \
    && ok "T78y ${f78##*/} le sigue preguntando al reconocedor ($q78)" \
    || bad "T78y ${f78##*/} ya no le pregunta al reconocedor ($q78): la exclusión de los repos del arnés cambió de dueño"
done
ask78() { # $1=HOME $2=lib $3=función $4=ruta → true|false
  env -u TYCON_HARNESS_IDENTITIES -u TYCON_SKILLS_DIR -u TYCON_HOME -u GIT_DIR -u GIT_WORK_TREE HOME="$1" node -e 'const l=require(process.argv[1]); process.stdout.write(String(l[process.argv[2]](process.argv[3])))' "$2" "$3" "$4"
}
mkdir -p "$T78/tmp/tcg-descartable/scripts"
[ "$(ask78 "$T78/home" "$LI78" esRepoDelArnes "$T78/tmp/tcg-descartable")" = true ] \
  && [ "$(ask78 "$T78/home" "$LI78" esRutaDelArnes "$T78/tmp/tcg-descartable/scripts/nuevo.js")" = true ] \
  && ok "T78z con la declaración: el registro de retros, el aviso de trabajo sin subir y el portón de carril reciben «es del arnés» en un clon descartable" \
  || bad "T78z con la declaración, un clon descartable del repo del arnés no se reconoce por repo o por ruta"
[ "$(ask78 "$T78/home-plain" "$LI78" esRepoDelArnes "$T78/tmp/tcg-descartable")" = false ] \
  && [ "$(ask78 "$T78/home-plain" "$LI78" esRutaDelArnes "$T78/tmp/tcg-descartable/scripts/nuevo.js")" = false ] \
  && ok "T78z2 (control) sin la declaración, en ese clon los tres controles siguen corriendo, como hoy" \
  || bad "T78z2 sin la declaración, el clon descartable salió «del arnés»"
[ "$(ask78 "$T78/home" "$LI78" esRutaDelArnes "$T78/product/src/x.js")" = false ] \
  && ok "T78z3 …y en un repo de producto el portón de carril sigue pidiendo story o carril" || bad "T78z3 un archivo de un producto salió «del arnés»"

# adentro de un hook de git (GIT_DIR apunta al repo del hook): el reconocedor lee el remoto del repo que le PREGUNTAN.
# Con GIT_DIR puesta, un producto saldría «del arnés» si la referencia fuera el repo del hook.
got78="$(judge78 "$T78/home" "$L78" "$T78/product" GIT_DIR="$T78/public-clone/.git")"
[ "$got78" = "false remoto" ] && ok "T78s con GIT_DIR de otro repo en el ambiente, un producto sigue sin ser del arnés" || bad "T78s esperaba «false remoto», dio «${got78}»"
got78="$(judge78 "$T78/home" "$L78" "$T78/work/internal" GIT_DIR="$T78/product/.git")"
[ "$got78" = "true remoto" ] && ok "T78t …y el clon de mantenimiento se sigue reconociendo desde el hook de otro repo" || bad "T78t esperaba «true remoto», dio «${got78}»"

[ "$FALLAS" -eq 0 ] && { echo "repo-del-arnes: todo verde"; exit 0; }
echo "repo-del-arnes: $FALLAS en rojo"; exit 1
