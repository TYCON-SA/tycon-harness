# Solidtime — el registro de horas con la instancia de tu organización

Una integración opcional. Si tu organización eligió Solidtime como herramienta de horas, el arnés abre, mantiene y
cierra una entrada de tiempo en su instancia mientras trabajás con una historia. Ninguna historia se frena por esto: si
falta configurar algo o la instancia no contesta, lo dice en una línea y sigue.

## Qué hace

El núcleo del arnés no sabe de ninguna herramienta de horas. Emite un evento neutro de trabajo
(`scripts/lib/work-signal.js`: empieza, sigue, termina) y lo recibe la integración que eligió la organización. La de
Solidtime (`integrations/solidtime/`) lo traduce a la API de la instancia:

| Evento | Qué hace en Solidtime |
|---|---|
| empieza una historia | lee la entrada que corre; si es de la misma historia la reusa, si es de otra la cierra, y abre una nueva con la descripción `Story <id> — <título>`, la hora en UTC y el proyecto que se llama como la carpeta del repo (si no hay ninguno, sin proyecto: la integración no crea proyectos) |
| sigue el trabajo | anota la última actividad en tu máquina, sin llamar a la instancia |
| termina | cierra la entrada y devuelve los segundos registrados |
| 15 minutos sin actividad | cierra la entrada con el fin en tu última actividad |

Sólo puede haber una entrada abierta por persona: la integración siempre lee la que corre antes de abrir otra.

## Lo que hay que configurar

Son dos cosas, de dos dueños distintos:

1. **La organización elige la herramienta y pone la URL de la instancia** en el perfil del equipo: desde el sitio
   (Configuración → Integraciones → Registro de horas), o en `team-profile.json`:

   ```json
   { "integrations": { "timeTracking": "solidtime", "solidtime": { "url": "https://horas.acme.example" } } }
   ```

   La URL tiene que empezar con `https://` (para probar en tu máquina vale `http://localhost`): el token no viaja en
   claro.

2. **Cada persona guarda su token** una vez, en su máquina:

   ```bash
   node ~/.tycon/harness/scripts/setup/harness.js config set solidtime.token
   ```

   Lo pegás en la terminal y no se muestra. También acepta stdin (`printf '%s' '<token>' | … config set
   solidtime.token`). Nunca va como argumento, porque quedaría en el historial del shell. Se guarda en
   `~/.tycon/secrets/solidtime.json`, y sólo tu usuario puede leer la carpeta y el archivo. `config show` dice si está o
   si falta, nunca el valor. La variable `TYCON_SOLIDTIME_TOKEN` también sirve y le gana al archivo.

   El token sale de tu perfil en la instancia de Solidtime (un token de acceso personal).

## Lo que queda en tu máquina

En `~/.tycon/state/time-tracking/solidtime/`:

- `identity.json`: tu organización y tu miembro en la instancia, para no pedirlos cada vez.
- `sessions/<sesión>.json`: la entrada que abrió cada sesión y su última actividad.
- `errors.jsonl`: cada llamada que falló, con la acción y el código. Nunca el token, la URL ni la respuesta.

## Cuando algo falla

| Aviso | Qué pasa | Qué hacer |
|---|---|---|
| `falta la URL de la instancia` | la organización no la puso | pedirla en el sitio, Configuración → Integraciones |
| `falta tu token` | no está guardado en tu máquina | `harness.js config set solidtime.token` |
| `HTTP 401` | el token venció o no es de esa instancia | crear otro y guardarlo de nuevo |
| `HTTP 422` | la instancia rechazó el pedido | mirar `errors.jsonl` y la versión de la instancia |
| `sin conexión` / `tiempo agotado, 10 s` | la instancia no contesta | la historia sigue; la próxima vez lo vuelve a intentar |
| `integración de horas desconocida` | `timeTracking` dice algo que no es `none` ni una integración instalada | corregir el valor en el perfil |
