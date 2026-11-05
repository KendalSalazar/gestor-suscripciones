# Fase 6 — Notificaciones internas y anomalías de los registros

## Contexto

Proyecto individual de aprendizaje para controlar suscripciones personales y
familiares. Los pagos y las partes son declaraciones de las personas usuarias:
la aplicación no mueve dinero ni consulta cuentas bancarias o proveedores.

La Fase 5 quedó cerrada el 27 de octubre de 2026, con implementación, pruebas y
validación manual con dos cuentas registradas en
[su plan](plan-fases/plan-fase-5.md). Hay generación inicial y horaria de pagos,
confirmación personal, partes familiares, invitaciones y gestión de miembros.

## Objetivo

Dar visibilidad a tres hechos del sistema mediante un centro de avisos dentro de
la aplicación: existe un pago por registrar, han pasado siete días desde la
fecha prevista sin confirmación, o el importe registrado difiere del previsto.
Los avisos conservan su historial y cada persona controla cuáles ha leído.

## Alcance

- Persistir avisos por destinatario y pago, con creación y lectura diferenciadas.
- Crear el aviso inicial de forma atómica con los pagos nuevos y sus partes.
- Crear un aviso de diferencia al confirmar un pago personal o completar un pago
  familiar, reutilizando `priceChanged` y la comparación decimal existente.
- Revisar pendientes de siete o más días mediante el ciclo horario existente,
  con lotes, revalidación de estado y protección frente a avisos duplicados.
- Consultar únicamente avisos propios de grupos a los que todavía se pertenece.
- Mostrar un centro `/notifications`, con filtros, páginas y marcado como leído,
  enlazado desde el dashboard sin añadir una cuarta vista a sus tres secciones.
- Comprobar permisos, concurrencia, fechas, precisión y el recorrido real con
  dos cuentas antes del cierre de la fase.

## Decisiones iniciales del plan

1. Canal exclusivamente interno. «Crear aviso» significa guardarlo para verlo en
   la aplicación; no significa enviarlo por correo o entregarlo en otro dispositivo.
2. `payment_due`: owner del grupo personal o cada titular de una parte familiar
   recién generada. `payment_overdue`: esos mismos destinatarios mientras su
   obligación siga pendiente y su membresía siga activa.
3. `amount_changed`: owner personal o owner familiar vigente al cerrar el total.
   Una confirmación parcial no produce por sí sola este aviso.
4. Umbral inicial de siete días naturales desde `payments.expected_date`, usando
   `PAYMENT_TIME_ZONE`. No son siete días desde que se ejecutó el generador.
5. Una notificación por pago, destinatario y tipo. Leerla o repetir un job no
   genera otra copia ni restablece su condición de no leída.
6. Una diferencia puede ser mayor o menor que lo previsto. Se comunica como
   «importe diferente»; no demuestra una subida del proveedor ni un impago real.
7. Los pendientes anteriores a la fase podrán producir avisos de vencimiento.
   No se reconstruyen automáticamente avisos iniciales o diferencias históricas.

Estas decisiones se revisan en el bloque 1. El contrato y los casos concretos
están en [el plan detallado](plan-fases/plan-fase-6.md).

## Límites

Sin email, SMS, push, WebSocket, proveedores externos, envío automático de
invitaciones, avisos anteriores a la fecha del pago, cobros reales o verificación
bancaria. Tampoco preferencias por usuario, reglas configurables, recordatorios
diarios, edición/borrado de avisos, marcado masivo ni detección predictiva.

Conservar los pagos, repartos, permisos, límite del miembro y excepción del owner
de Fase 5. No cambiar automáticamente costes de suscripciones ni corregir pagos
resueltos. El pulido general del proyecto sigue correspondiendo a la Fase 7.

## Forma de implementar

Seguir el plan detallado, un bloque pequeño por entrega. Antes de cada bloque,
explicar comportamiento, archivos, motivo y concepto; después, comunicar las
comprobaciones realizadas y detenerse para lectura o prueba.

Este encargo crea el diseño. No aplica migraciones, instala dependencias, ejecuta
jobs ni implementa funcionalidades de la fase.
