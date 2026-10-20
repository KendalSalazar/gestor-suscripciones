---
name: implementar-api-grupos
description: "Crear o modificar endpoints de recursos pertenecientes a grupos en el backend Express de este proyecto. Cubre contrato HTTP, Zod, membresía y consultas delimitadas por grupo."
---

# API con permisos por grupo

Lee [AGENTS.md](../../../AGENTS.md) y el contrato del bloque en el [plan aplicable](../../../prompts/plan-fases/). Las rutas citadas parten de la raíz.

## Seguir el recorrido existente

1. Define parámetros, query, body, respuesta y errores según el encargo. Determina qué roles y estados de membresía permiten cada operación.
2. Consulta backend/src/app.ts, middleware/validate.ts, middleware/errorHandler.ts y el módulo relacionado bajo backend/src/modules/. Usa sus patrones de montaje, controlador y servicio.
3. En routers anidados con :groupId, conserva los parámetros del padre mediante mergeParams. Monta la ruta detrás de requireAuth antes de notFound.
4. Valida cada ubicación con Zod y validate. En Express 5, deja que validate coloque los datos transformados; no asignes request.query directamente ni añadas conversiones diferentes en el controlador.

## Autorizar y consultar

- Reutiliza getActiveMembership de modules/subscriptions/membership.ts antes de consultar el recurso. Aplica assertOwner solo en las operaciones que el contrato reserve al owner.
- Una membresía invited o removed no equivale a active. Mantén el 403 previsto para grupo ajeno o inexistente, sin revelar su existencia.
- Comprueba además el grupo en el SQL del recurso: conocer un UUID no concede acceso. Cuando el grupo se obtiene mediante una relación, filtra también por esa relación; por ejemplo, payments necesita su suscripción.
- Parametriza entradas y conserva los límites y orden del contrato. Los decimales salen como strings y las fechas DATE como YYYY-MM-DD.
- Para operaciones atómicas o susceptibles a carreras, usa el mismo cliente de transacción en todas las consultas relacionadas y libera sus recursos.

## Comprobar el contrato

- Selecciona los casos pertinentes: entrada inválida, falta de Bearer, owner y member activos, membresía inactiva y usuario de otro grupo. Comprueba por separado la autorización y el filtrado del SQL.
- Comprueba resultado vacío, serialización, orden y límites cuando correspondan. Mantén el formato de AppError y errorHandler; no conviertas errores desconocidos de base de datos en conflictos de dominio.
- Documenta el contrato nuevo o modificado en backend/docs/ cuando corresponda y devuelve ejemplos HTTP sin credenciales reales.
- Una tarea de listado no autoriza añadir resoluciones, notificaciones ni otras rutas del plan.
