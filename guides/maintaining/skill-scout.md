# skill-scout — buscar primero, crear después

Skill TYCON que se auto-dispara cuando vas a **crear una skill, agent, guide o hook nuevo**. Busca en el catálogo local primero, ranquea matches, y te muestra 3 caminos: usar / extender / crear.

Por qué: las capas duplicadas son "tejido cicatrizal". Skill nueva que duplica algo existing → dos artifacts a medio mantener → conocimiento disperso. Adaptado de [ECC skill-scout](https://github.com/affaan-m/ECC/blob/main/skills/skill-scout/SKILL.md), pero con scope LOCAL solamente (sin búsqueda GitHub/web — el dolor TYCON es duplicar lo de adentro, no ignorar lo de afuera).

## Cuándo se dispara automáticamente

El agente lee la SKILL.md y la activa cuando tu prompt contiene:

- **ES**: "necesito una skill", "crear una skill", "agregar skill", "skill nueva", "hace falta un advisor", "agregar guía", "necesitamos un hook"
- **EN**: "create skill", "add a skill", "new skill", "is there a skill", "build a skill", "make a skill", "add advisor", "new advisor"

Excepciones (NO dispara):

- Si pedís EXPLÍCITO "skipea la búsqueda, sé que no existe" → respeta tu decisión.
- Si estás modificando un archivo concreto que ya nombraste (ej: "editá `~/.claude/agents/tycon-X.md`") → no es creación.
- Si estás en medio de un plan ya aprobado donde se decidió crear algo nuevo → no re-cuestiona.

## Cómo usarlo manual

Si querés invocarlo a propósito (ej: estás dudando si crear algo nuevo):

```
/tycon-skill-scout intent="agregar un advisor que detecte X"
```

O simplemente preguntá: "¿hay una skill TYCON que haga X?"

## Qué busca

4 lugares, en orden:

1. **Skills**: `~/.claude/agent-skills/skills/*/SKILL.md` — todas las skills instaladas (BMAD + TYCON + community).
2. **Agents**: `~/.claude/agents/*.md` — los 26 advisors TYCON.
3. **Guides**: `~/.claude/tycon-harness/guides/*.md` — las guías del equipo.
4. **Hooks + scripts**: `~/.claude/tycon-harness/scripts/**` — los hooks y scripts auxiliares.

Adicional: cruza contra `advisor-rules-catalog.md` para detectar si la regla que querés enforzar ya existe en algún advisor.

## Los 3 caminos que te ofrece

| Camino | Cuándo aplica | Esfuerzo |
|---|---|---|
| **(A) USAR** | El match cubre 90-100% del intent. Existe artefacto invocable. | 0 — invocar lo que ya hay |
| **(B) EXTENDER** | El match cubre 50-90% — falta un sub-caso, una regla, o un trigger. | 5-30 min — editar 1 archivo |
| **(C) CREAR** | Match <50% o no hay match. Justificación obligatoria de por qué (A) y (B) no alcanzan. | 30 min - 2 h — archivo nuevo + integración |

## Casos reales que evita

**Caso 1** — "necesito un advisor que valide que las migraciones no se editan post-commit"

Sin skill-scout: el agente propone crear `migration-immutability-checker`. Una hora después: ya existía `dotnet-hooks.md` Hook 1 que enforza exactamente eso.

Con skill-scout: detecta el Hook 1 + reglas `MIGRATION-C1..C5`, recomienda **(A) USAR** lo que ya hay.

**Caso 2** — "agregar un advisor que detecte uso de SafeQueryBuilder sin parametrizar"

Sin skill-scout: el agente crea `safe-query-builder-checker` nuevo. Termina conviviendo en paralelo con `tycon-plugin-dotnet-conventions` que ya tiene reglas `DOTNET-C2`.

Con skill-scout: detecta `tycon-plugin-dotnet-conventions`, recomienda **(B) EXTENDER** con sub-regla `DOTNET-Cn`.

**Caso 3** — "necesitamos una skill que cierre stories en ADO automáticamente"

Sin skill-scout: el agente crea skill nueva. Termina conviviendo con `tycon-ado-story-wi` que ya hace lifecycle ADO completo.

Con skill-scout: detecta `tycon-ado-story-wi`, recomienda **(A) USAR** + revisar si el cierre automático ya está cubierto en «Cerrar la historia» del pipeline.

## Anti-patterns como dev

- ❌ Saltear el scout cuando el catálogo crece. "Es chiquito, lo hago rápido" termina en duplicación.
- ❌ Crear advisor nuevo si el catálogo de reglas (`advisor-rules-catalog.md`) ya cita una equivalente — la respuesta correcta es EXTENDER el advisor que cita esa regla.
- ❌ Confundir "hay una guide que documenta el patrón" con "está enforzado". A veces necesitás SUMAR enforcement (hook) sobre una guide existing, no crear advisor.

## Para qué NO sirve

- **No es un linter de skills duplicadas**. No corre periódicamente sobre el catálogo. Para auditar el placard entero (qué retirar, qué consolidar): eso lo va a hacer `tycon-skill-stocktake` (próximo item del análisis ECC).
- **No busca en GitHub o web**. Si querés saber qué skills hay en la comunidad: usá ECC `skill-scout` original (`origin: community`). Acá el scope es local TYCON.
- **No reemplaza el juicio del PO/architect**. Una vez que ves los 3 caminos, vos decidís — el scout te muestra opciones, no las elige.

## Limitaciones v1 + roadmap

- **No hay scoring sofisticado**: Grep + filename match + frontmatter description. Sin TF-IDF ni embeddings. Para v1 alcanza.
- **No detecta reglas implícitas en advisors sin frontmatter**: lee solo lo que el frontmatter declara. Si un advisor cubre Y pero su description dice X, queda fuera. v2: indexar el body.
- **No persiste decisiones**: si tomás camino (A) USAR un advisor existing pero después lo cambian, no recuerda la decisión. v2: log a `~/.claude/tycon-skill-decisions.log` para retro.

## Referencias

- Skill: `~/.claude/agent-skills/skills/tycon-skill-scout/SKILL.md`
- Catálogo de reglas (cruzar antes de crear advisor): [`advisor-rules-catalog.md`](../advisor-rules-catalog.md)
- ECC inspiration: [github.com/affaan-m/ECC/blob/main/skills/skill-scout/SKILL.md](https://github.com/affaan-m/ECC/blob/main/skills/skill-scout/SKILL.md)
