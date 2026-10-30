# Step 9 — Push target con retry

**Objetivo**: `git push origin <target>`. Si falla por race condition (otro dev mergeó al mismo tiempo), retry una vez con rebase. Si falla otra vez, abort.

## Acciones

### 9.1 — Push inicial

```bash
git push origin <target>
```

Capturar exit code y output.

### 9.2 — Si falla por non-fast-forward (race condition)

Output típico contiene `non-fast-forward` o `(fetch first)`:

```
❌ Push rechazado — alguien hizo push a `origin/<target>` mientras vos hacías el HITL.

Reintentando con `git pull --rebase`...
```

Ejecutar:
```bash
git pull origin <target> --rebase
```

**Si el pull rebase falla con conflict** → 🚫 ABORT:
```
❌ Conflict durante el rebase post-race. El merge commit quedó local en estado de rebase.

Para resolver:
1. Ejecutá `git rebase --abort` (vuelve al merge original, sin pushear)
2. Re-corré el skill — va a fetchear el último estado de `<target>` y armar un mensaje actualizado

NO voy a resolver conflicts automáticamente.
```

**Si el pull rebase anduvo OK** → reintentar push:

```bash
git push origin <target>
```

### 9.3 — Si el segundo push también falla

🚫 ABORT con mensaje:
```
❌ Push falló dos veces. El estado del repo es:
- Local <target>: rebaseado sobre origin/<target>, con tu merge commit encima
- Remote: alguien sigue pusheando

Recomendación: investigá manualmente con `git status` y `git log origin/<target>..HEAD`.
NO voy a re-intentar — más reintentos automáticos pueden pisar trabajo de otros.
```

### 9.4 — Si el primer push fue exitoso

Capturar el output (típicamente algo tipo `<old_sha>..<new_sha>  <target> -> <target>`).

Pasar al Step 10.

## Edge cases

- **Push falla por branch protection** (el target exige PR): **NO abortar** (desde 2026-08-30 el
  skill sí sabe abrir PRs). Es la señal de que ese repo debería estar en modo `pr` y nadie lo
  declaró. Ofrecer al dev pasar a **step-09b-create-change-request.md** con el mensaje ya aprobado, y sugerir
  que el admin de la organización declare el repo en la configuración de la organización
  (`team-repos.json → merge_suites`, con su pipeline de pruebas completas): con eso el plan del
  paso 0 ve que la rama exige ese pipeline y arranca directo por el pedido. (`merge.mode: pr` en el
  `.tycon/advisors.yaml` del repo todavía anda, pero es la forma vieja.) Un repo protegido cuya
  herramienta no sabe crear PRs deja al equipo sin camino — que es exactamente el modo de falla que
  el modo `pr` vino a evitar.

- **Push falla por auth (token expirado)**: ABORT con instrucción de refrescar credenciales. NO reintentar — más intentos van a fallar igual.

- **Si Step 4 hizo un commit en source branch (engram)**: ese commit ya fue pusheado en Step 4. No hay que volver a pushearlo en Step 9.

## Output del step

```json
{
  "push_succeeded": true,
  "had_race_retry": true|false,
  "remote_target_at": "<new sha>"
}
```

Pasar al Step 10.
