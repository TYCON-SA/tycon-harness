# El arnés en un minuto

[English](one-minute.md) · Castellano

**Qué es.** Un ciclo de desarrollo para tu agente de código (Claude Code o Codex). El agente escribe rápido; el arnés
hace que lo haga con método: cada cambio queda escrito antes, se prueba y lo revisan otros agentes. Y hay controles que
frenan, no sólo avisan.

**El primer día, en tres pasos:**

1. **Instalá**, en la terminal: `npx @tyconsa/harness@latest`. Te muestra qué cambia y pregunta una vez. Hace falta
   Node 22 o posterior y tu agente ya instalado (en Windows, PowerShell 7).
2. **Abrí tu agente en la carpeta de tu repo y pedí** «creá una historia para …» con lo que quieras hacer. La arma
   contestando tres preguntas en llano (qué tiene que hacer, cómo se ve que anda y qué no tiene que tocar), te la
   muestra y la escribe con tu «sí».
3. **Decí «implementemos la story».** El arnés lleva al agente paso a paso: el plan, las pruebas, el código, los
   revisores y la prueba en vivo. Al final te deja el mensaje del commit.

**Lo que nunca hace sin vos:** nunca commitea ni sube cambios sin tu permiso, y el plan te lo muestra antes de
programar: en una historia chica lo aprueba solo, en las demás espera tu visto bueno.

**Las palabras del arnés:**

| Palabra | Qué es |
|---|---|
| **historia** | tu pedido escrito, con sus criterios y sus pruebas; el agente la sigue |
| **revisor** | un agente que revisa el cambio antes del commit (seguridad, convenciones, cobertura) |
| **freno** | un control que frena un comando y dice por qué y cómo seguir |
| **ejecución** | una pasada del recorrido de una historia, de la validación al commit |
| **pedido de cambio** | el pull request: la propuesta de un cambio a la rama principal, que alguien aprueba antes de que entre |
| **carril** | por dónde va un cambio: con historia, o como ajuste puntual (un arreglo chico, con el permiso de una persona y un tope de archivos) |

Si algo no anda: `/tycon-harness` en Claude Code dice qué falta, sin tocar nada; desde cualquier terminal,
`node ~/.claude/tycon-harness/scripts/setup/harness.js doctor` hace lo mismo. Todo lo demás está en la
[portada](../README.es.md).
