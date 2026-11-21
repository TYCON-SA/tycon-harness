# Reglas para revisores — la sección del CLAUDE.md que el revisor verifica

**Desde el 2026-09-19.** Cada repo de producto declara sus reglas de revisión en una sección
fija de su `CLAUDE.md`:

```markdown
## Reglas para revisores

- Toda operación de base con SafeQueryBuilder; nunca SQL armado por concatenación.
- Las tablas NO llevan prefijo `OC_`.
```

El pipeline la recorta y la pega **al principio del contexto de cada revisor**, marcada como «reglas
a verificar». Es la única vía por la que un revisor del paso 5 ve las reglas propias del repo:
los revisores **no cargan el `CLAUDE.md`** (`omitClaudeMd: true` en su definición).

## Por qué así

Medido sobre copias de los 9 repos de producto, con una violación plantada de una regla que sólo
vivía en su `CLAUDE.md`:

| Cómo le llega la regla al revisor | Detectó | Tokens de revisor |
|---|---|---|
| El `CLAUDE.md` entero (como era antes) | 10 de 20 | 7,2 M |
| Sin `CLAUDE.md` | 5 de 20 | 3,4 M |
| **La sección pegada como reglas a verificar** | **17 de 20** | **3,5 M** |

Con el archivo entero, el revisor **ve** la regla pero no la trata como algo a controlar. Pegada al
principio y marcada, la aplica. Y cuesta la mitad.

## La convención

- **Encabezado exacto**: `## Reglas para revisores` (nivel 2). Va desde ahí hasta el próximo
  encabezado de nivel 1 o 2; los `###` de adentro se conservan (sirven para agrupar).
- **Dónde**: `CLAUDE.md` en la raíz del repo o `.claude/CLAUDE.md`. Si están las dos, se pegan las
  dos, en ese orden, cada una con su fuente.
- **Techo: 4.000 bytes.** Pasado el techo no se corta (una regla a medias es peor que una larga),
  pero el pipeline lo marca (`excede_techo`) y conviene recortar: cada byte se paga en cada revisor
  de cada corrida.
- **Sin credenciales, nunca.** La sección viaja a cada revisor.

## Cómo se escribe una regla que un revisor puede verificar

Una regla sirve si alguien que lee **sólo el diff** puede decir «esto la cumple» o «esto no».

- ✅ «Toda migración nueva nace con su `NNN_Nombre.rollback.sql`.» — se ve en el diff.
- ✅ «`DEMO_Entregas` es inmutable: nunca UPDATE de contenido ni DELETE.» — se ve en el SQL.
- ✅ «Con `IConnectionFactory`, sólo `System.Data.Common`; nunca castear a `SqlConnection`.»
- ❌ «Escribir código limpio.» — no hay nada que mirar.
- ❌ «Correr los tests antes de pushear.» — es del proceso, no del diff (va en otra parte del
  `CLAUDE.md`).
- Nombrar la cosa concreta (tabla, clase, prefijo, archivo) y lo prohibido o lo obligatorio.
- Si la regla tiene una excepción, escribirla al lado: el revisor no la adivina.

## Qué pasa si el repo no tiene la sección

Nada se frena. El pipeline reporta `reglas_revisores.estado` (`ausente`, `vacia`, `sin_claude_md`,
`no_medido`) y el orquestador le avisa al dev en una línea por corrida: *«este repo no tiene «Reglas
para revisores»: los revisores no ven sus reglas propias»*.

## Qué repos la tienen

**Desde el 2026-09-19, todos los repos de producto del equipo con el arnés** (front y back) la
tienen. Un repo nuevo con el arnés nace sin la sección: el pipeline lo avisa en cada corrida.


## El aviso al commitear

`scripts/ci/reviewer-rules.js`, llamado desde el pre-commit global (`git-pre-commit-global.sh`),
mira las líneas **agregadas** a un `CLAUDE.md` que quedaron **fuera** de la sección:

- **Con `TYPESAFE_API_KEY`** en la máquina: un pedido a TypeSafe (tope 5 s) pregunta, línea por línea,
  si es una regla que un revisor debería verificar; avisa las que dan ≥ 0,5. Antes de salir, cada línea
  se **tacha**: credenciales, rutas y correos (`sanear()` de `scripts/metrics/tokens-digest.js`) y los
  nombres de la lista de abajo.
- **Sin llave**, o si TypeSafe no contesta o da error: avisa por toda línea nueva fuera de la sección
  (que no sea vacía ni un título) y dice por qué avisa sin filtrar.
- Si el `CLAUDE.md` no tiene la sección, lo dice una vez.
- **Nunca frena el commit.** Lo que imprime también va tachado. Apagado: `TYCON_REVIEWER_RULES=0`.
- Deja una línea de conteos (sin texto) en `~/.claude/.tycon-pipeline/reviewer-rules.jsonl`.

La llave no se exige: vive en el `~/.zshrc` de la máquina que la tenga.

## Nombres que se tachan antes de mandar

Los términos de categoría `cliente` de la lista de denegación (privada),
con sus reglas: `palabra` (sólo como palabra entera) y `mayusculas` (distingue la caja; si no, no la distingue). Una
sola lista para el freno, el exportador y este tachado: una copia aparte en esta guía se
desfasaba de la otra. Para sumar un nombre, se suma su término a la lista, con su par en la tabla de reemplazos. Sin
la lista —la copia pública no la trae— no se manda nada a TypeSafe y el aviso lo dice.

## Diferencia con Codex

`omitClaudeMd` no existe en Codex: el revisor de Codex sigue cargando su `AGENTS.md`. La sección en el
contexto **sí** llega a los dos (la arma `pipeline.js`). Detalle: `guides/maintaining/codex-divergence-inventory.md`
§«Revisores sin el CLAUDE.md».
