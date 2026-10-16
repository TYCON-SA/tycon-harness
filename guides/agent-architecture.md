# Arquitectura de Agentes TYCON — Advisors + BMAD

> Guía de referencia para combinar skills BMAD con subagentes custom TYCON en un pipeline HITL.
> Resultado de mesa redonda con 5 agentes BMAD + pre-mortem + red team adversarial.

> **⚠️ Nota importante (2026-04-18)**: el equipo adoptó el **Camino B** — uso informal de advisors sin governance formal. Ver `tasks/todo.md` sección "Items descartados explícitamente". Elementos como Sprint 0 baseline, DRI rotativo con capacity, dashboard obligatorio de 7 métricas, shadow mode y kill switch automático **NO están en vigor**. Los advisors existen, se invocan cuando aportan valor, y se ajustan empíricamente. Las secciones de este documento sobre governance quedan como **referencia** por si el equipo crece y adopta Camino A en el futuro.

---

## TL;DR

El equipo usa BMAD v6.3.0 como framework canónico. Los **advisors** (subagentes custom TYCON) se intercalan con los skills BMAD para aplicar reglas TYCON que BMAD no conoce.

- **Un solo concepto: `ADVISOR`** con dos tags: `phase` y `severity`
- **CRITICAL bloquea merge** (no commit local). WARNING/INFO son advisory puro.
- **5 advisors Core de arranque** (4 de ellos activos en shadow mode hasta tener baseline)
- **Pipeline YAML declarativo por story**: core advisors no excluibles, optional advisors se agregan
- **1 DRI rotativo trimestral** con 10% capacity formal
- **Kill switch**: advisor con `warnings_actioned_ratio < 40%` a 8 semanas se retira

---

## El problema que resuelve

BMAD es framework canónico. Sus 119 skills son genéricos. Pero TYCON tiene reglas que BMAD no conoce:

- Convenciones Bizuit .NET (SafeQueryBuilder, IBackendPlugin, orchestrator pattern)
- Formato Mary+GOLD para stories
- Workflow engram (canonical project names, sync cycle)
- Convenciones de commit (HEREDOC + Co-Authored-By)
- Stack React/TypeScript del equipo

Opciones para aplicar esas reglas:

1. Modificar skills BMAD → **NO** (bloquea auto-update, divergencia con upstream)
2. Meter todo en `CLAUDE.md` de cada proyecto → **NO** (duplica, drifta)
3. Subagentes custom que corren junto a BMAD → **SÍ** (wrappers, team-wide, versionados)

Los advisors son la opción 3.

---

## Concepto único: ADVISOR

Un solo tipo de subagente con dos tags:

### `phase`

Dónde en el workflow corre:

| Phase | Cuándo corre | Ejemplo |
|---|---|---|
| `pre` | Antes de invocar un skill BMAD principal | Validar una story antes de `bmad-dev-story` |
| `during` / `post` | Después de que BMAD produjo output, antes de commit/merge | Revisar código implementado contra convenciones .NET |
| `post-commit` | Después del commit (async, no bloquea nada) | Capturar learnings, trackear warnings ignorados |

### `severity`

Qué autoridad tiene su output:

| Severity | Semántica | Comportamiento |
|---|---|---|
| `CRITICAL` | Violación dura de seguridad / correctitud / invariantes | **Bloquea merge**. Override requiere comentario justificativo en PR + approval de otro dev |
| `WARNING` | Regla importante que puede tener excepciones legítimas | Advisory. Reportado en consolidado, humano decide |
| `INFO` | Información útil, telemetría, sugerencias | No interrumpe. Se consume bajo pedido o en retros |

**El bloqueo es al merge, no al commit local.** Los devs pueden commitear libremente. El CRITICAL se aplica cuando el PR intenta mergear a main.

---

## Los 5 advisors Core de arranque

**NOTA**: todos arrancan en **shadow mode** — corren, loggean, NO muestran output al dev — hasta completar Sprint 0 de baseline (4 semanas). Después de baseline se activan con severity real según data.

### 1. `tycon-story-validator` (pre, WARNING/CRITICAL)

**Qué hace:** antes de invocar `bmad-dev-story` (o cualquier skill BMAD que implemente código), valida la story contra Mary+GOLD:

- Frontmatter completo (epic, story, title, status, sprint, priority, approach, depends_on)
- ACs numerados secuencialmente y agrupados con H3
- Tests tabla presente con nombres PascalCase
- Archivos referenciados en "Que existe hoy" **existen en el codebase** (grep verificable)
- Primera task es salvaguarda de BD/estado

**Severity:**
- `WARNING`: cualquier item del checklist GOLD incompleto
- `CRITICAL`: archivo referenciado en "Que existe hoy" no existe (el dev agent va a alucinar sobre base rota)

**Core advisor**: no excluible del pipeline YAML.

**Lee en runtime:** `~/.claude/tycon-harness/story-format.md`. No hardcodea.

### 2. `tycon-plugin-dotnet-conventions` (during/post, WARNING/CRITICAL)

> Desde el 2026-09-26 este revisor —y los de React y Next.js— **vive en el paquete
> `bizuit`**, no en el código del pipeline: entra al set por su manifiesto. Ver «Paquetes de revisores».

**Qué hace:** audita código .NET de plugins Bizuit contra `guides/bizuit/bizuit-plugin-dotnet.md`.

- SafeQueryBuilder usado (no raw SQL concat)
- Feature-based folder structure
- Orchestrator pattern: Services llaman Services, no Repos directamente
- BizuitUserContext + UserIdResolver (no ClaimsPrincipal)
- Tests xUnit con naming `MethodName_Scenario_ExpectedResult`

**Severity:**
- `CRITICAL`: SQL injection (raw concat de input de usuario), ClaimsPrincipal usado
- `WARNING`: estructura mezclando feature/layer, tests mal nombrados, orchestrator rompiendo patrón

**Core advisor** (solo para proyectos .NET — el YAML lo skipea automáticamente en repos frontend).

**Lee en runtime:** `~/.claude/tycon-harness/guides/bizuit/bizuit-plugin-dotnet.md`.

### 3. `tycon-plugin-tests-coverage` (during/post, WARNING)

**Qué hace:** verifica que los tests cubren los ACs de la story.

- Cada AC debe tener al menos un test que lo verifique
- `dotnet test` corre verde
- Coverage sobre archivos nuevos > 75% (regla de `RULES.md` team)
- Nombres de tests mapean a AC IDs (`AC1_*`, `AC2_*`, etc.)

**Severity:**
- `WARNING`: coverage < 75%, ACs sin test, test fallando

No se promueve a CRITICAL porque hay casos legítimos donde un AC no tiene test unitario (ej: AC de UX que se prueba manual). El humano evalúa.

**Core advisor** para stories con tasks de implementación.

### 4. `tycon-plugin-security-basics` (during/post, CRITICAL)

**Qué hace:** scan de seguridad básica sobre el diff.

- Secretos en código (API keys, passwords, connection strings hardcoded)
- Inputs sin validación en endpoints POST/PUT
- Respuestas con datos sensibles (emails, tokens) sin sanitizar
- Uso de `System.Random` en contexto criptográfico

**Severity:** todos los findings son `CRITICAL` por default. Son cosas que no deberían mergearse nunca sin review explícito.

**Core advisor** para todo commit que toque código ejecutable (backend o frontend).

### 5. `tycon-retrospective-capturer` (post-commit async, INFO)

**Qué hace:** post-merge, async, sin bloquear nada:

- Lee el diff del merge
- Captura decisiones/learnings no documentados en engram
- Correlaciona con warnings que fueron ignorados en stories previas
- Trackea métrica `warnings_actioned_ratio` por advisor
- Health check: si no corrió exitoso en 48h, el hook post-merge lo reporta en el próximo PR

**Severity:** `INFO` siempre. Nunca emite al dev directamente. Produce el dashboard de métricas que el DRI revisa quincenalmente.

**Core advisor**: no excluible. Es el **único observer** del sistema.

#### Regla de encuadre — advisories de "riesgo futuro"

Antes de fijar la condición de disparo de una advisory a un evento hipotético (ej. *"cuando se agregue un tercer proveedor de mensajería, auditar..."*), **verificar explícitamente si el gap descripto YA es explotable con la topología/config ACTUAL del sistema**. Si es explotable ahora, la advisory debe encuadrarse como riesgo **PRESENTE** (con severidad acorde), no futuro — aunque el fix que la originó haya sido ad-hoc y de alcance acotado.

> **Por qué:** una advisory encuadrada como *"cuando se agregue un TERCER proveedor de mensajería..."* puede describir un gap que ya es explotable con los 2 proveedores vigentes. El encuadre "futuro" retrasa la priorización de un riesgo que es presente, y el gap puede causar un incidente antes de que alguien lo mire.

---

## Paquetes de revisores (2026-09-26)

Los revisores de un **producto** o de un **cliente** no viven en el código del pipeline: viven en
**paquetes**, una carpeta con un `pack.json` que el pipeline carga y anuncia. Hoy hay dos, en
agent-skills (que se actualiza solo en cada máquina — el equipo no instala nada):

| Paquete | Qué trae | Se publica |
|---|---|---|
| `packs/bizuit` | el paquete del stack de TYCON: .NET + React/Next.js sobre Bizuit — las convenciones con que TYCON desarrolla plugins sobre Bizuit: `tycon-plugin-dotnet-conventions`, `-react-`, `-nextjs-` | sí, junto con el núcleo, como paquete opcional y apagado por defecto |
| `packs/clients` _(del repo del equipo; no está en esta copia)_ | el revisor de plugins hermanos (Nimbo, Totora, FRESNO) y el del adaptador de la plataforma de comercio electrónico de un cliente | no |

**Por qué**: para publicar el núcleo hay que sacar esos revisores de `pipeline.js`, y sacarlos a mano
tiene el modo de falla más silencioso del arnés: un revisor que deja de correr no da error, da MENOS
hallazgos. El paquete hace explícito quién decide que corran, y el pipeline lo dice en cada corrida
(`packs` en la salida de `advisors`; `packs: []` se anuncia como «sin paquetes instalados»).

### El manifiesto (`pack.json`)

```json
{
  "name": "bizuit",
  "description": "El paquete del stack de TYCON: .NET + React/Next.js sobre Bizuit. …",
  "guides": ["guides/bizuit/bizuit-plugin-dotnet.md"],
  "reviewers": [
    {
      "agent": "tycon-plugin-dotnet-conventions",
      "group": "base",
      "when": { "any": [
        { "detection": "csModified" },
        { "all": [ { "detection": "pluginCfgModified" }, { "no": { "detection": "tsxModified" } } ] }
      ] },
      "surface": { "paths": ["**/*.cs", "**/*.csproj", "**/plugin.json"] },
      "depth": "standard",
      "prefixes": ["DOTNET"]
    }
  ]
}
```

- **`group`**: `base` y `condicional` entran al set del paso 5; `validacion` entra al paso 1 (con
  `prompt` —placeholders `{story_path}`, `{repo_path}`—, `model` y `note`).
- **`when`** — vocabulario **cerrado**: `all` (y), `any` (o), `no`, `detection` (una bandera de
  `detectStack`: `csModified`, `tsxModified`, `hasNext`, `hasReact`, `pluginCfgModified`,
  `secretCfgModified`, `depChanged`, `shModified`, `codeModified`, `onlyDocs`), `files` (regex sobre
  las rutas del diff) y `added` (`{ pattern, extensions }`: regex sobre las líneas AGREGADAS de los
  archivos con esas extensiones — el mismo criterio que los disparadores del núcleo). Una clave fuera del
  vocabulario o una bandera que no existe hacen **inválido** al manifiesto: nunca se evalúan como falso.
- **`surface`** (`{ paths, excludePaths }` o `{ always: true }`): qué re-corre al revisor en cada
  vuelta. **`depth`** (`lean` | `standard` | `deep`): la indicación de modelo. **`prefixes`**: los
  de sus reglas en el catálogo. **`needsStory`**: recibe la story completa además del contexto.
- **`siblings`** (opcional, `[{ path, name }]`): los plugins hermanos que el banco de revisores fabrica en
  su corral para el revisor de hermanos.
- **`skills`** y **`agents`** (opcionales): carpetas DEL PAQUETE (relativas a su carpeta, sin salir de ella) con sus
  skills y sus agentes. Una carpeta declarada que no existe es un paquete roto. Un revisor se busca primero en `agents`
  del paquete y después en `agents/` de la raíz; el mismo nombre en los dos lugares es un paquete roto. Las skills y los
  agentes de un paquete se enlazan en la máquina (`~/.claude/skills`, `~/.claude/agents`, `~/.codex/skills`) sólo si la
  organización lo activa, uno por entrada, con las reglas de siempre (lo propio gana y se nombra); si deja de activarlo,
  el aplicador saca sus enlaces y lo dice en una línea. Lector: `scripts/lib/pack-pieces.js`.
- El `name` tiene que coincidir con la carpeta. Un mismo agente puede estar en dos grupos del mismo
  paquete (hermanos: `condicional` y `validacion`), nunca en dos paquetes ni repetido con el núcleo.
- **Las claves estaban antes en castellano.** Un paquete de afuera
  (`TYCON_PACKS_DIR`) escrito con las de antes sigue andando: el cargador y el lector del arnés lo
  traducen al leerlo (el uso queda anotado como cualquier nombre viejo). Una clave vieja y su nueva con
  valores distintos en el mismo objeto es un paquete roto: frena como cualquier otro. Las salidas JSON
  del pipeline (`packs` de `advisors`, `lanzamientos` de `validators`) conservan sus claves de siempre.

### Dónde se buscan y cómo se restringen

- Paquetes: `TYCON_PACKS_DIR`, o `packs/` de agent-skills. Agentes: `TYCON_AGENTS_DIR`, o `agents/`
  (`~/.claude/agents` es un enlace ahí).
- **Sin paquetes** (la carpeta por defecto ausente, o vacía) corre sólo el núcleo: un diff `.cs`
  conserva pruebas y seguridad, más completitud y condicionales genéricos. Es un estado legítimo (una
  máquina sin agent-skills) y se ve en la salida. En cambio, una `TYCON_PACKS_DIR` **definida** que
  apunta a una carpeta inexistente FRENA: es configuración rota, no «sin paquetes». El lector del
  arnés (`installed-packs.js`) sigue el mismo criterio.
- **Qué paquetes están activos lo decide la organización**: `packs.default` de `scripts/lib/tycon-config.js`
  (`all`, todos los instalados; `none`, ninguno; o una lista, `["bizuit", "clients"]`, exactamente ésos — variable
  `TYCON_PACKS_DEFAULT` (la lista, separada por comas) › el perfil del equipo › el archivo de la máquina › `none`). Se
  edita en la pestaña Configuración del sitio, sección «Paquetes», o en el perfil del equipo. En esta clave el perfil
  del equipo gana sobre lo que la máquina eligió al instalar: quien quiera otra cosa en una máquina del equipo usa la
  variable. El perfil del equipo dice `all`: en el equipo no cambia nada; afuera, sin perfil, ningún paquete viene
  activo. Uno de la lista que no está instalado frena nombrando la carpeta donde se buscó. Una configuración rota o un
  arnés que no se encuentra FRENAN como un paquete roto; un arnés que todavía no trae `packs.default` da «todos», como
  antes.
- Un repo puede **achicar** esa lista con `packs: [bizuit]` en `.tycon/advisors.yaml` (`packs: []`: ninguno, a
  propósito), nunca sumar. **Cambio de comportamiento**: con `packs.default none`, un repo que declara un paquete
  instalado ya no lo activa; frena con «activalo en Configuración del sitio, sección Paquetes, o en el perfil del
  equipo». Qué paquetes usa una organización lo decide su configuración, no cada repo. `pipeline.js lint-config` avisa si nombra uno que no está instalado.

### Lo que FRENA (exit 2, nombrando archivo · revisor · motivo)

Manifiesto ilegible · clave fuera del vocabulario · bandera que `detectStack` no produce · agente sin
`.md` en la carpeta de agentes · revisor ya declarado por el núcleo o por otro paquete · paquete que el
repo nombra y no está instalado (dice dónde lo buscó) · paquete que el repo nombra y la organización no
activó (dice dónde se activa) · carpeta `skills`/`agents` declarada que no existe · agente repetido en el paquete y en
la raíz · `TYCON_PACKS_DIR` definida hacia una carpeta
que no existe. Frenan `advisors`, `smart-reloop`, `check-count`
y `validadores`. **Nunca se degrada a «sin ese paquete»**: eso es exactamente la falla que los paquetes
existen para impedir. Cargador: `skills/tycon-pipeline/scripts/lib/packs.js`.

### Quién más lee los manifiestos

Del lado del arnés, `scripts/lib/installed-packs.js` (descubre y parsea, con las claves viejas traducidas; no evalúa condiciones):
`harness-audit.js` exige el agente de cada revisor de cada paquete instalado (y un manifiesto roto es
una falla), e `instinct-draft.js` resuelve el dueño de un prefijo de regla nuevo. Sin paquetes, ninguno
los nombra.

### Equivalencia: el equipo no nota el cambio

Se mide, no se supone: `package-equivalence.js report --base <sha>` corre el `pipeline.js` de
`main` anterior a los paquetes (sacado con `git archive`) y el nuevo con los paquetes, sobre 21 casos
armados (cada rama de la matriz vieja) y los últimos 30 commits de cada repo de la máquina — mismo
set por grupo, misma superficie de vuelta, mismas indicaciones de modelo.
La prueba `tests/package-equivalence.test.js` compara
contra la **foto dorada** de `main` (`tests/fixtures/equivalence-main.json`, con el sha adentro) para
seguir valiendo después del merge. Red: `tests/packs.test.js`, `scripts/tests/installed-packs.test.js`.

**Hueco heredado, a propósito**: un diff `.tsx` + `plugin.json` no suma el revisor .NET (la rama
«sólo frontend» de la matriz vieja no miraba la config). El manifiesto lo reproduce porque la
equivalencia manda; corregirlo es otra story.

## Pipeline HITL con advisors

### Flujo completo para una story típica

```
1. /tycon-create-story → story draft
         ↓
2. [tycon-story-validator]  ← advisor pre, shadow en Sprint 0
         ↓
3. [humano aprueba la story]  ← HITL checkpoint #1
         ↓
4. /bmad-dev-story (plan mode)
         ↓
5. [humano aprueba el plan]  ← HITL checkpoint #2
         ↓
6. [implementación]
         ↓
7. dotnet build / npm run build  ← si falla, aca termina
         ↓
8. [tycon-plugin-dotnet-conventions]  ┐
   [tycon-plugin-tests-coverage]      ├── advisors during/post en paralelo
   [tycon-plugin-security-basics]     ┘
         ↓
9. UN reporte consolidado agregando outputs de los 3
         ↓
10. /bmad-code-review (opcional, puede cruzar con los 3 reports)
         ↓
11. [humano aprueba o pide cambios]  ← HITL checkpoint #3
         ↓
12. commit local (libre)
         ↓
13. push + PR a main
         ↓
14. Merge check: ¿hay CRITICAL sin override? → bloquea merge
         ↓
15. merge
         ↓
16. [tycon-retrospective-capturer]  ← async, no bloquea
         ↓
17. hook post-merge engram-verify
```

### Pipeline YAML declarativo por story

Cada story `.md` puede incluir en su frontmatter un bloque `advisors:` que declara qué optional advisors corren. **Los Core no se listan — siempre corren.**

```yaml
---
epic: 2
story: "2.3"
# ... resto del frontmatter ...
advisors:
  optional:
    - tycon-react-conventions  # agregado para stories que tocan frontend
    - tycon-ac-tracer          # agregado para stories con >5 ACs
---
```

Si no hay bloque `advisors:`, solo corren los Core.

**Los Core son hardcoded en el orchestrator, no en el YAML.** El story-validator falla si el YAML intenta excluir un core (meta-check).

---

## Reporte consolidado

Un solo output por story, no N reportes sueltos:

```markdown
# Story <N.M> — Advisor Report

**Status**: 🟡 2 WARNING, 0 CRITICAL
**Phase**: during/post
**Advisors que corrieron**: 4/4 Core + 0 Optional

---

## 🚨 CRITICAL (0)
_ninguno_

## ⚠️ WARNING (2)

### tycon-plugin-tests-coverage
- AC3 (rate-limiting) no tiene test asociado
- Coverage de `OrderSyncHandler.cs` = 68% (threshold 75%)

### tycon-plugin-dotnet-conventions
- `LineManager.ReleaseLineIfHeldAsync` viola orchestrator pattern (llama directo a repo)

## ℹ️ INFO (3)
_abrir el detalle completo en `.advisors/story-<N.M>-report.md`_

---

**Severity CRITICAL bloquea merge.** WARNING/INFO son advisory — humano decide.
**Tiempo total del pipeline**: 42s
```

---

## Shadow mode (Sprint 0)

**Durante las primeras 4 semanas**, todos los advisors corren en shadow:

- Ejecutan su lógica completa
- Loggean output a `.advisors/shadow-logs/<story-id>-<advisor>.md`
- **NO muestran warnings al dev**
- **NO bloquean merge** aunque detecten CRITICAL

**Propósito**: capturar baseline sin interferir con velocidad del equipo:

- Warnings por story (¿genera ruido o señal?)
- Ratio warnings por severity (¿CRITICAL es raro, WARNING es común?)
- Tiempo que agrega cada advisor al pipeline
- Falsos positivos identificables en post-hoc review

**Criterio de salida de shadow**:

Cada advisor se activa (sale de shadow) cuando:
- DRI revisa manualmente muestra de 20 stories
- Calcula `warnings_actioned_ratio` hipotético (¿si el dev hubiera visto este warning, habría hecho algo?)
- Si ratio > 60% → el advisor se activa
- Si ratio < 40% → el advisor se re-calibra antes de activarse
- Si ratio entre 40-60% → otra semana de shadow

---

## Métricas y dashboard

El retrospective-capturer emite estas métricas (threshold = alerta):

| Métrica | Threshold alerta | Significa |
|---|---|---|
| `advisor_warnings_per_story` (media móvil 4 sem) | > 4 | Ruido, alert fatigue inminente |
| `advisor_warnings_actioned_ratio` | < 50% | El advisor grita y nadie hace caso |
| `advisor_pipeline_runtime_failures` | > 1/sem | Drift de BMAD/engram/guías |
| `retrospective_capturer_last_successful_run` | > 48h | **Canario del sistema. Crítico.** |
| `consolidated_report_open_rate` | < 80% | El reporte no se lee |
| `time_from_report_to_approval` | mediana < 30s | HITL fantasma (rubber-stamping) |
| `advisor_config_local_overrides` | > 1 dev con hook off | Abandono silencioso |
| `advisor_rerun_loop_iterations` (media por story) | > 3 | Stories arrancan menos listas de lo declarado — Step 1 validator subestima gaps |
| `step_8_commit_skipped_rerun` | > 0/mes | **Regla D.i violada — commits con código sin re-auditar. Bug del pipeline.** |

Revisión: **standup quincenal del DRI, 15 min fijos**. No opcional.

---

## Regla de kill switch (anti-zombie)

Un advisor se retira automáticamente si:

- `warnings_actioned_ratio < 40%` sostenido durante 8 semanas consecutivas

**Sin excepciones.** Sin esto, el sistema acumula zombies. Si el equipo cree que el advisor "vale igual", hay que recalibrarlo — no mantenerlo por fe.

---

## Proliferación (regla anti-creep)

**No se agrega un advisor Core sin evidencia del retrospective-capturer que lo justifique.**

Proceso para proponer un advisor nuevo:

1. Mini-story en el sprint: "Advisor X porque el capturer mostró patrón Y en Z stories"
2. Shadow mode 2 sprints obligatorio
3. Review de data: ¿warnings_actioned_ratio > 60%? Sí → activar. No → descartar.

Los **Optional advisors** (los que cada story agrega en su YAML) no siguen este proceso — son experimentales por naturaleza.

---

## Ownership y DRI

### El rol del DRI

Una persona, rotada cada trimestre. Owner de:

- Dashboard de métricas (tabla en §Métricas y dashboard)
- Triage de issues/PRs en el arnés y advisors
- Health check del retrospective-capturer
- Decisiones de shadow → activo → kill
- Review manual mensual de 5 commits random vs lo que el capturer reportó

### Capacity formal

**10% del sprint** (4h/semana) asignado como capacity formal en el sprint plan. No voluntarismo. No "cuando pueda". Si no hay capacity, no hay sistema.

### Checklist quincenal del DRI

- [ ] Dashboard revisado, anomalías registradas
- [ ] Triage de issues nuevos del repo
- [ ] `retrospective_capturer_last_successful_run` < 48h confirmado
- [ ] Revisión manual de 5 stories recientes vs output del capturer
- [ ] Review de `warnings_actioned_ratio` por advisor — marcar candidatos a kill

Si se saltea 2 veces seguidas → escalate al lead del equipo.

---

## Override de CRITICAL

Un CRITICAL bloquea merge. Para hacer override:

1. Comentario justificativo en el PR (no puede ser vacío)
2. Approval de otro dev del equipo
3. El CRITICAL overrideado queda registrado en engram con la justificación
4. El retrospective-capturer trackea frecuencia de overrides — si un CRITICAL se overridea >30% de las veces, el advisor está mal calibrado (promover a WARNING o retirar)

**Patrón esperado**: CRITICAL debería ser raro (ej: < 1 por mes). Si aparecen muchos CRITICALs, el advisor está emitiendo con severity errónea.

---

## Integración con skills BMAD

### Regla dura: no forkear skills BMAD

Los advisors son **wrappers que corren antes/después** de skills BMAD. Nunca modifican el skill en sí. Eso mantiene compatibilidad con upstream.

### Contratos con BMAD

Cada advisor documenta en su SKILL.md qué outputs de BMAD lee:

- Si `bmad-dev-story` cambia su output (v6.4, v7), el advisor puede romperse
- Los tests E2E del pipeline en CI detectan esto antes de que llegue a devs

### Cuándo proponer PR upstream vs subagente custom

| Lógica | Acción |
|---|---|
| Aplica a cualquier proyecto usando BMAD | PR upstream a BMAD-METHOD |
| Específica a TYCON (Bizuit, Mary+GOLD, engram) | Subagente custom en `agents/` |
| Duplica > 60% de un skill BMAD existente | Probablemente querés un config/override, no un subagente |

---

## Onboarding para devs nuevos

Todo dev nuevo al equipo debe:

1. Leer esta guía (`agent-architecture.md`)
2. Leer las 5 guías referenciadas (Mary+GOLD, engram, git, workflow, bizuit-plugin-dotnet)
3. Primera semana: observar 3 pipelines completos antes de intentar uno solo
4. Primer PR: debe ir con un pair del equipo

**Red flag**: si un dev nuevo no pregunta sobre los advisors en su primera semana, significa que no los vio o no los entendió. El DRI debe chequear esto en su primera 1:1.

---

## Anti-patterns a evitar

1. **Advisor que "hace todo"** — un solo advisor con 12 reglas es un linter glorificado. Mejor 3 advisors chicos con responsabilidad clara.
2. **Hardcodear la guía en el advisor** — siempre leer runtime desde el arnés (`~/.claude/tycon-harness/`). Si la guía cambia, el advisor cambia automático.
3. **Proponer un advisor por cada bug de producción** — teatro de seguridad. Si el bug se evita con una línea de código en el sistema, hacelo ahí.
4. **Advisory "suave" sin ningún CRITICAL** — si literalmente nada bloquea, el sistema es decorativo y muere por defecto.
5. **Skills BMAD forked** — te bloquea en v6.3.0. Si necesitás comportamiento distinto, wrapper.
6. **Delegar entendimiento al advisor** — el advisor detecta y reporta. El humano decide. Nunca "el advisor decidió que está bien".
7. **Sin kill switch** — los advisors zombie son lo que mata el sistema. Kill si `warnings_actioned_ratio < 40%` a 8 semanas, sin excepciones.
8. **Agregar un "tycon-azdo-pr-creator" o similar** — `az`/`gh` CLI + un prompt hacen el 90%. Esperá a tener dolor real antes de construir wrappers.

---

## Referencias cruzadas

- [story-format.md](../story-format.md) — Mary+GOLD, leído en runtime por story-validator
- [guides/engram-workflow.md](engram-workflow.md) — usado por retrospective-capturer
- [guides/git-commit-conventions.md](git-commit-conventions.md) — CRITICAL de commits sin autorización
- [guides/workflow-orchestration.md](workflow-orchestration.md) — pipeline, principios, tasks/
- `guides/bizuit/bizuit-plugin-dotnet.md` (viaja con el paquete del stack) — leído en runtime por plugin-dotnet-conventions

---


---

## El pase adversarial (Step 5b) — evidencia observada de qué capa encuentra qué (2026-08-27)

Cuatro corridas en tres repos donde el pase adversarial reproduce-or-refute (Step 5b del
`tycon-pipeline`: hunters que EJECUTAN el código + skeptics que refutan) encontró bugs de
comportamiento que el set completo de advisors single-pass, en una o más iteraciones, no vio:

| Dónde | Qué encontró el 5b | Qué encontraron los advisors single-pass |
|---|---|---|
| un backend .NET | 4 bugs de correctitud | 0 CRITICAL |
| un repo del equipo | bug real | forma/trazabilidad |
| otro producto | bug de trim | forma/trazabilidad |
| el mismo backend, otra corrida | corrimiento de 3h por `ToUniversalTime()` sobre `Kind=Unspecified`, reproducido contra la DB real | 21 invocaciones en 3 iteraciones: sólo forma/trazabilidad |

**Cómo leer esto (y cómo NO leerlo).** Es evidencia observada con sesgo de selección conocido —
las corridas se anotan cuando el 5b encuentra algo; las corridas donde no encuentra nada no dejan
rastro equivalente. NO dice "los advisors single-pass sobran": encuentran la deuda de forma,
trazabilidad y spec que el 5b no busca. Tampoco convierte al 5b en obligatorio universal: cuándo
corre lo decide el gate `deep-review-gate` (risk-class + `deep_review_always_paths`), que ya se
recalibró con estos mismos casos.
Lo que SÍ dice: si una corrida va a recortar capas por costo, el 5b es la última que conviene
recortar — la diferencia práctica entre ambas capas es que una LEE el diff y la otra EJECUTA el
código, y los cuatro bugs de la tabla sólo eran visibles ejecutando.

No se declara al 5b "capa primaria" con "ratio 100% vs 0%": esa formulación
no vale por el sesgo de selección, y porque esa métrica exige juicio
humano (clasificar "bug de comportamiento") en un dashboard determinista.
