# Fase 4 — Pagos y generación programada

## Contexto

Este es un proyecto individual de aprendizaje para registrar suscripciones recurrentes. Las fases 1 a 3 ya aportaron PostgreSQL y migraciones SQL, autenticación, grupos personales, permisos por membresía, CRUD de suscripciones y un dashboard mínimo. El estado real del código tiene prioridad sobre las descripciones históricas de los planes.

La implementación debe avanzar en bloques pequeños. Al terminar cada bloque, explicar qué cambió, por qué, qué conceptos se practicaron y cómo comprobarlo; detenerse antes de pasar al siguiente.

## Objetivo

Registrar cada cobro esperado como un pago pendiente, permitir que el owner confirme cuánto pagó o marque que no se pagó, y señalar cuando el importe confirmado difiere del esperado. Un proceso programado genera los pagos a partir de la próxima fecha de cobro de cada suscripción activa.

El dashboard seguirá trabajando con el grupo personal. Las rutas del backend respetarán la membresía del grupo para poder reutilizarse cuando exista el modo familia.

## Alcance de esta fase

- Migración de pagos y un día de referencia para calcular las fechas recurrentes sin deriva al pasar por meses cortos.
- Generación automática, transaccional e idempotente de pagos pendientes; comando manual para aprender y comprobar el proceso.
- Lectura de pagos del grupo, confirmación y omisión, con validación y permisos.
- Detección exacta de cambio de precio al confirmar: comparar importes NUMERIC en PostgreSQL y conservar el costo esperado original del pago.
- Dashboard mínimo para revisar pendientes e historial, confirmar u omitir, y ajustar explícitamente el costo esperado de la suscripción para futuros pagos.
- Tests pertinentes, documentación del contrato HTTP y comprobación manual por bloques.

## Límites y decisiones

- No integrar pasarelas de pago. La confirmación es una acción del usuario.
- No crear payment_shares, invitaciones ni gestión de grupos familiares: corresponden a la Fase 5.
- No enviar notificaciones ni crear un centro de anomalías: corresponden a la Fase 6. El dashboard mostrará los pagos pendientes y la marca priceChanged.
- No actualizar automáticamente subscriptions.expected_cost al confirmar un importe diferente: un cobro aislado puede variar sin que cambie el precio contratado.
- No borrar historial al eliminar una suscripción. Si tiene pagos, el backend responderá 409 y se podrá desactivar.
- Reutilizar Express 5, Zod, pg, Winston, el middleware de autenticación, la comprobación de membresía, el runner de migraciones, fetch y el manejo actual de dinero y fechas. No añadir una dependencia para la programación: basta un temporizador del proceso y las garantías de PostgreSQL.
- El access token sigue solo en memoria; el refresh token sigue en cookie httpOnly.

## Fuente de implementación

El diseño y el orden de los bloques están en plan-fases/plan-fase-4.md. Antes de cada bloque, comprobar que sus supuestos coinciden con el código. No dar la fase por terminada hasta cumplir su checklist y las verificaciones manuales.
