# El arnés en un minuto

[English](one-minute.md) · Castellano

**Qué es.** Un ciclo de desarrollo para tu agente de código (Claude Code o Codex). El agente escribe rápido; el arnés
hace que lo haga con método: cada cambio queda escrito antes, se prueba y lo revisan otros agentes. Y hay controles que
frenan, no sólo avisan.

**El primer día, en tres pasos:**

1. **Instalá**, en la terminal: `npx @tyconsa/harness@latest`. Te muestra qué cambia y pregunta una vez.
2. **Abrí tu agente en la carpeta de tu repo y pedí** «creá una historia para …» con lo que quieras hacer. Te la
   muestra con tres preguntas en llano y la escribe con tu «sí».
3. **Decí «implementemos la story».** El arnés lleva al agente paso a paso: el plan, las pruebas, el código, los
   revisores y la prueba en vivo. Al final te deja el mensaje del commit.

**Lo que nunca hace sin vos:** nunca commitea ni sube cambios sin tu permiso, y un plan que no es chico te lo muestra
antes de programar.

**Las palabras del arnés:**

| Palabra | Qué es |
|---|---|
| **historia** | tu pedido escrito, con sus criterios y sus pruebas; el agente la sigue |
| **revisor** | un agente que revisa el cambio antes del commit (seguridad, convenciones, cobertura) |
| **freno** | un control que frena un comando y dice por qué y cómo seguir |
| **ejecución** | una pasada del recorrido de una historia, de la validación al commit |
| **pedido** | el pull request que lleva el cambio a la rama principal |
| **carril** | un arreglo chico sin historia, con el permiso de una persona y un tope de archivos |

Si algo no anda: `/tycon-harness` en Claude Code dice qué falta, sin tocar nada. Todo lo demás está en la
[portada](../README.es.md).
