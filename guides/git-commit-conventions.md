# Git Commit Conventions — Guía TYCON

Guía única para commits, merges y push en todos los repos TYCON (FRESNO, Ebano, Totora, Pacara y el repo de formularios de la plataforma). Consolida las reglas que viven dispersas en los `CLAUDE.md` de cada repo.

---

## Regla #0 — Autorización explícita (NO COMMIT / NO PUSH sin consentimiento)

**POR NINGÚN MOTIVO ejecutar `git commit` o `git push` sin consentimiento explícito del usuario.**

- NUNCA ejecutar `git commit` automáticamente al terminar de implementar.
- NUNCA ejecutar `git push` sin que el usuario lo pida con esas palabras.
- "Implementá la story X" / "arreglá el bug Y" / "agregá la feature Z" **NO** implica commitear. Implica dejar los archivos modificados y esperar review.
- El usuario pide explícitamente con frases como: "commiteá", "hacé commit", "llevalo a main", "pusheá", "mergeá a main". Sin esas palabras (o equivalentes claros), no se toca el historial git.
- Si tenés dudas de si corresponde commitear, **preguntá antes**. Un commit no solicitado cuesta más revertir que un "¿querés que commitee?" cuesta responder.

---

## Formato de commits — HEREDOC + trailer separado

Usar siempre **HEREDOC** con mensaje multi-línea. El trailer `Co-Authored-By` va **separado por una línea en blanco** del cuerpo — así un pipeline que publica notas de versión no lo captura como parte de la nota.

### Ejemplo literal (copy-paste):

```bash
git commit -m "$(cat <<'EOF'
feat(pedidos): agregar endpoint POST /pedidos/{pedidoId}/despachar

- Nuevo método PedirRetiroAsync en TransporteApiService (HMAC-SHA1 auth)
- DespacharAsync en PedidosService: valida estado Armado, pide el retiro a la API del transporte
- Endpoint mapea 404/409/410/502 según estado de la sesión
- Tests: 4/4 PASS, suite completa 2725/2725 PASS (test-gate del pipeline)

Co-Authored-By: <modelo exacto de la sesión> <noreply@anthropic.com>
EOF
)"
```

### Reglas del HEREDOC

1. Delimitador: `<<'EOF'` con comillas simples — evita expansión de variables/backticks en el mensaje.
2. Primera línea: título corto tipo conventional commit (`feat|fix|refactor|docs|test|chore|perf|style(scope): descripción`). Máximo ~72 caracteres.
3. Línea en blanco, luego cuerpo con bullets describiendo **qué + por qué**.
4. Línea en blanco, luego trailer `Co-Authored-By:` con el modelo exacto que implementó, tal como lo
   informa la sesión (bajo Codex, el modelo gpt que corresponda) — nunca el de un ejemplo.
5. Cerrar con `EOF` y `)"`.

---

## Mensaje descriptivo — los commits son documentación Y release notes

En los repos cuyo pipeline publica los mensajes de commit como notas de versión, los mensajes son **visibles para los clientes**. No son solo historial interno.

### Reglas

- **NUNCA** mensajes genéricos: `"fix"`, `"update"`, `"sync"`, `"trigger rebuild"`, `"wip"`, `"changes"`, `"merge"`.
- **SIEMPRE** lead con **QUÉ** cambió y **POR QUÉ**. El cómo ya está en el diff.
- Aunque el hook rechace, aunque haya merge conflict, aunque estés apurado — **tomarse 5 segundos** para escribir algo descriptivo. El mensaje queda en la release note para siempre.
- Si el commit es puramente para re-trigger de un pipeline, decirlo explícito y describir qué se espera: `chore(ci): re-trigger deploy pipeline tras fix de secret en Azure Vault`.

### Malos vs buenos ejemplos

```text
MAL:  fix: arreglo bug
BIEN: fix(forms): corregir validación de CUIT en PersonaJuridica (aceptaba 10 dígitos)

MAL:  update readme
BIEN: docs(readme): agregar sección de setup local con connection strings de ejemplo

MAL:  trigger rebuild
BIEN: chore(ci): re-trigger pipeline tras rotación de AZURE_DEVOPS_PAT en Key Vault
```

---

## Rebuild antes de commit — NUNCA commitear código que no compila

**Regla obligatoria: Modificar → Build → Test → Commit.** En ese orden, siempre.

### Backends .NET (FRESNO, Ebano, Totora, Pacara)

```bash
dotnet build                        # 0 errores obligatorio
dotnet test --filter "<TestScope>"  # tests de la feature (scoped)
# La suite completa no va en cada commit a dev: corre en el portón de /tycon-merge-to-main,
# cuando el dev la pide o al cierre del Step 4 del pipeline. Ver test-execution-discipline.md.
```

### Frontends Angular/TS (calden-tablero, FRESNOBZExtForms)

```bash
npm run type-check                  # obligatorio antes de push a main
npm run build:dev                   # verificar que el bundle se genera
# Si pasa → commit. Si falla → arreglar antes de commitear.
```

### Regla dura

- Si `build` tira error → **NO commitear** — arreglar primero.
- Si tests fallan → **NO commitear** — arreglar o excluir con justificación explícita.
- Si ya commiteaste algo que no compila (ej: mergeaste sin build previo), el fix es un **commit nuevo** que arregla, no un amend.

---

## Merges a main — usar la skill `/tycon-merge-to-main`

Los merges a `main` se hacen con la skill `/tycon-merge-to-main`, no con `git merge dev` a mano: la skill genera el changelog detallado que el pipeline del producto puede publicar como nota de versión.

### Correcto

```
Usuario: "llevalo a main"
Agente:  [invoca skill /tycon-merge-to-main]
```

### Incorrecto

```
Usuario: "llevalo a main"
Agente:  git merge dev --no-edit                 ← mensaje genérico, no sirve como release note
Agente:  git merge dev -m "merge dev to main"    ← igual de inútil
```

### Por qué

- La skill corre `git log origin/main..dev --oneline` primero y agrupa los cambios por story/scope.
- Un pipeline que publica notas de versión extrae el **mensaje del merge commit**. Un `--no-edit` o un mensaje genérico deja a los clientes sin visibilidad de qué cambió.
- Siempre `--no-ff` (merge commit explícito) — no fast-forward.

---

## Adónde va un cambio de PIPELINE, y la trampa de medirlo mal (2026-09-04)

**Nadie trabaja directamente sobre `main`.** Un cambio de pipeline no es la excepción: va a `dev`
como todo lo demás y llega a `main` por el pull request de promoción que cada equipo ya usa.

### Por qué no directo a `main`

Un arreglo de pipeline que **entra por su propia rama `ci/<qué-arregla>` directo a `main`** deja a
`dev` atrás. El motivo puede ser real —el arreglo tiene que estar en la construcción siguiente, y la
promoción de `dev` arrastra trabajo ajeno a medio terminar—, pero es una excepción por urgencia, no
un criterio.

**La factura** (medido: 24 arreglos directos en tres días dejaron `dev` entre 42 y 64 commits atrás
de `main`, y entre el 92% y el 94% de esa distancia eran esos commits de CI): la próxima
promoción de `dev` a `main` choca sobre `azure-pipelines.yml`, y una resolución apurada de ese
conflicto **revierte los arreglos sin que nada se ponga rojo** — que es exactamente la clase de falla
silenciosa que esos arreglos existen para cerrar.

### 🔴 La trampa: una rama atrasada no es una rama muerta

Medir `dev` contra `main`, ver decenas de commits de atraso y concluir *"acá el equipo trabaja en
`main`"* es **falso si la medición está contaminada por quien la hace**: el atraso lo puede haber
producido el propio trabajo reciente. La conclusión correcta es la opuesta —`dev` es la rama de
trabajo y hay que ponerla al día—; publicar la otra convierte una excepción de días en la regla
permanente del equipo.

Es la misma forma de error que medir la cola de construcciones en un listado que llega tarde: **antes
de concluir algo de un número, mirá si no lo moviste vos**. Si una rama aparece abandonada, revisá de
quién y de cuándo son los commits que la dejaron atrás:

```bash
git log --format='%ad %an %s' --date=short origin/dev..origin/main | head -20
```

### Lo que se sostiene

- **Un cambio de pipeline va a `dev`**, y a `main` por la promoción del equipo.
- **Si por urgencia entra directo a `main`, se pone `dev` al día en el mismo movimiento.** No hacerlo
  deja una bomba en el próximo merge, y el que la desactiva mal no se entera.
- **Un pull request por repo con TODOS los cambios pendientes**, no uno por arreglo. Cada pull request
  vuelve a correr el pipeline entero
  para probar lo mismo más una línea: con dos carriles para toda la organización, seis tandas sobre
  cinco repos son la diferencia entre veinte minutos y tres horas.

## Poner `dev` al día

El aviso de arranque `scripts/hooks/dev-behind-main-notice.js` dice cuándo a `dev` le faltan commits de `main`, y le
pide al agente que lo ofrezca. **Sin un sí de la persona no se hace.** Con el sí, en este orden:

1. `git fetch origin` y volver a contar: si ya está al día, decirlo y parar.
2. El árbol de trabajo limpio, o parar y decirlo: no se guarda nada ajeno en un stash.
3. `git switch dev && git pull --ff-only`.
4. `git merge --no-ff origin/main -m "chore: bajar main a dev (queda al día)"`. Con conflicto, `git merge --abort` y
   avisar: no se resuelve sin la persona (el caso típico es el archivo de versión).
5. `git push origin dev`. Si lo rechaza una política o un non-fast-forward, no se fuerza: se ofrece un pull request
   `main → dev`.
6. Volver a la rama en la que estaba la persona.

**Por qué no se automatiza:** mover `origin/dev` mientras alguien trabaja le rebota el push y le arma un conflicto con
el archivo de versión. Ese merge ya no vuelve a versionar los formularios: el detector de cambios no cuenta los merges
(`scripts/ci/forms-to-version.sh`). Poner `dev` al día **no** lleva a `main` el trabajo trabado en `dev`: eso es un
merge a `main` con `/tycon-merge-to-main`, y el aviso lo ofrece aparte.

## Lo que NO hay que hacer — nunca, bajo ninguna circunstancia

### Flags prohibidos

- `--no-verify` → saltea pre-commit hooks. Si un hook falla, **arreglar la causa**, no evadirla.
- `--no-gpg-sign` → saltea firma. Solo si el usuario lo pide explícito por un problema de setup.
- `--no-edit` en merges → genera mensaje genérico, invisible como release note.
- `-i` (interactive) en rebase/add → no hay stdin interactivo en esta sesión.

### Operaciones destructivas

- `git push --force` a `main` o `master` → **nunca**, sin excepción. A `dev` o feature branch solo con consentimiento explícito del usuario.
- `git reset --hard` sobre cambios no pusheados → preguntar primero, puede destruir trabajo.
- `git checkout .` / `git restore .` masivo → mismo criterio.
- `git branch -D` → preguntar antes.

### Amend de commits pusheados

- `git commit --amend` sobre un commit ya pusheado → **nunca**. Reescribe historial remoto y rompe checkouts de otros.
- Si un pre-commit hook falla, el commit **NO ocurrió** — hacer un commit nuevo con el fix, no `--amend` sobre el anterior.
- La regla simple: **siempre commit nuevo**, salvo que el usuario pida amend explícitamente Y el commit no esté pusheado.

### Config de git

- **NUNCA** `git config --global` sin pedido explícito. No tocar `user.email`, `user.name`, signing keys, ni aliases del usuario.

---

## Staging selectivo — repos con working tree "sucio" de base

Algunos repos del equipo tienen, de forma **permanente y esperada**, un working
tree con docenas de archivos modificados / untracked que **NO se commitean**. Son
artefactos locales (output de installers, skills auto-generadas, caches). El commit
SIEMPRE es **selectivo**: `git add` de los archivos puntuales que tocaste, nunca
`git add -A` / `git add .`.

### El clon de skills de una máquina en transición (`~/.claude/agent-skills` como carpeta real)

El arnés es **un solo repo** (las skills viven en `skills/` del mismo clon) y usar el
arnés no necesita clon: en una máquina instalada sin clonar `~/.claude/agent-skills` es un enlace a `~/.tycon/harness` y
esta sección no aplica. Aplica sólo a quien MANTIENE el arnés desde un clon y todavía tiene el clon viejo de skills como
carpeta real (la transición a un solo repo). Es el caso más notorio. Al hacer `git status` ahí vas a ver, **siempre**:

- ~50 archivos `skills/bmad-*/SKILL.md` + `bmad-skill-manifest.yaml` **modificados**.
- ~70 carpetas **untracked**: `skills/gds-*`, `skills/wds-*`, `skills/bmad-tea/`,
  `skills/bmad-testarch-*/`, `skills/super`, etc.

Eso es **ruido esperado** — lo genera el installer de BMAD y otras tools al correr.
**NO es trabajo pendiente de commitear.** Ignoralo.

🔴 **Regla**: cuando commitees a `AgentSkills`, hacé `git add` SOLO de los archivos
de la skill concreta que modificaste (ej: `git add skills/tycon-pipeline/SKILL.md
skills/tycon-pipeline/scripts/marker.js`). NUNCA `git add -A` ni `git add .` — te llevarías
las ~50 modificaciones BMAD + ~70 carpetas untracked en un commit gigante que no
es tuyo y ensucia el historial del equipo.

Si dudás de qué incluir: `git status --porcelain` y seleccioná a mano solo lo que
corresponde al cambio que el usuario pidió.

---

## Checklist antes de cada commit

- [ ] ¿El usuario pidió commit explícitamente? (Si no → **detenerse**)
- [ ] ¿`build` pasa con 0 errores?
- [ ] ¿Tests de la feature pasan?
- [ ] Si es el merge a `main`: ¿la suite completa pasó en el portón de `/tycon-merge-to-main`?
- [ ] ¿Mensaje describe QUÉ + POR QUÉ? (no genérico)
- [ ] ¿`Co-Authored-By` separado por línea en blanco?
- [ ] ¿Estoy usando HEREDOC (no `-m "single line"`)?
- [ ] ¿Estoy agregando archivos específicos (no `git add -A` que puede meter `.env` / secrets)?
- [ ] Si es el repo `AgentSkills` → ¿estoy ignorando el ruido esperado (`bmad-*` modificados + `gds-*`/`wds-*` untracked) y commiteando solo mis archivos? (ver "Staging selectivo")

Si alguna respuesta es NO → arreglar antes de ejecutar `git commit`.

## Revisión adversarial OBLIGATORIA para código del arnés (2026-08-23)

**Todo cambio de CÓDIGO en el arnés o `agent-skills` pasa por una ronda adversarial
(`/code-review high`) ANTES del push.** Exención única: documentación pura — y ojo con la trampa
de esa exención: un documento que FUNCIONA como configuración (la tabla de nombres de tools, los
casos del banco, un `advisors.yaml`) es código a estos efectos. La duda se resuelve revisando.

**Medido**: dos rondas consecutivas sobre el
mismo trabajo, ambas con hallazgos confirmados que rompían de verdad:
- La primera, sobre un commit "ya verificado" (selftests y banco en verde): 12 confirmados, uno
  DESTRUCTIVO.
- La segunda, sobre los ARREGLOS de la primera: 14 confirmados, DOS destructivos de nuevo (ambos
  probados ejecutándolos), y **tres hallazgos violaban reglas que la primera acababa de dejar
  escritas en los headers de esos mismos archivos**.

La lección que motiva la regla: la verificación mecánica (selftests, banco, casos con rojo
previo) prueba que el código hace lo que su autor pensó — no encuentra lo que el autor no pensó.
Y las reglas de diseño se re-violan mientras se las redacta: el conocimiento del error no
inmuniza contra re-cometerlo. Ojos frescos adversariales son la única capa que hoy demostró
atrapar esa clase.

**Por qué el pipeline de stories NO necesita esto**: ya lo tiene — los advisors del Step 5 y el
pase adversarial del pipeline son exactamente esta capa. El agujero que esta regla cierra es tocar el
ARNÉS por fuera del pipeline, que es como se trabaja en estos dos repos.

Operativa: la ronda corre de fondo (6-8 min), los hallazgos confirmados se aplican antes del
push, y los arreglos no triviales ameritan su propia ronda (la evidencia de arriba: los arreglos
de una ronda tuvieron sus propios bugs destructivos).
