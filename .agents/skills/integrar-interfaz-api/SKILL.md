---
name: integrar-interfaz-api
description: "Implementar pantallas o formularios Next.js que consumen el backend de este proyecto, con sesión, importes, fechas y estados de carga y error coherentes. No cubre rediseños generales."
---

# Integración de interfaz y API

Lee [AGENTS.md](../../../AGENTS.md), [frontend/AGENTS.md](../../../frontend/AGENTS.md) y el bloque aplicable. Las rutas citadas parten de la raíz.

## Partir del contrato real

- Comprueba frontend/package.json y consulta la documentación local de Next.js indicada por frontend/AGENTS.md antes de modificar APIs del framework.
- Contrasta las rutas y respuestas del backend con sus tipos y documentación en backend/docs/. Si falta una operación, señala la dependencia en lugar de inventar un endpoint o simular una integración terminada.
- Estudia frontend/src/lib/api.ts y session.ts y el flujo existente de la pantalla. Reutiliza api, ApiError y refreshSession.
- El helper api lanza ApiError pero no reintenta automáticamente cada 401. Si el flujo necesita recuperación de sesión, resuélvelo expresamente con el patrón existente y evita bucles de reintento.
- Conserva la coordinación de refreshSession para evitar rotaciones simultáneas del refresh token.

## Implementar el flujo visible

- Define qué muestra la pantalla durante carga, vacío, error y operación en curso. Si conviven listados independientes, evita que el fallo de uno oculte innecesariamente los otros.
- Mantén los importes como strings al editar y enviarlos. Formatea las fechas de calendario sin convertir YYYY-MM-DD de forma que cambie el día por zona horaria.
- Asocia etiquetas y errores a los controles, usa botones semánticos y evita envíos repetidos mientras una acción está pendiente.
- Usa el estado devuelto por la API o vuelve a consultar tras una operación. Explica los conflictos del dominio con las opciones reales disponibles para el usuario.
- Respeta el alcance visual del bloque y reutiliza estilos. La integración de una sección no requiere rediseñar toda la página.

## Verificar la experiencia

- Comprueba tipos y lint con los comandos realmente disponibles en frontend/package.json; no inventes scripts.
- Cuando la tarea requiera navegador, recorre sesión inicial, acción, error pertinente y recarga. Usa únicamente datos de prueba para acciones con efectos.
- Si no hay navegador disponible, presenta los pasos manuales como pendientes, sin afirmar que se ejecutaron.
- Devuelve el recorrido visible, los archivos modificados y el motivo de las decisiones, con explicaciones que permitan al propietario seguir el flujo de datos.
