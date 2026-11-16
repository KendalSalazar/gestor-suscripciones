# Fase 7 — Rediseño y claridad de la aplicación

## Contexto

La Fase 6 está cerrada: notificaciones, pagos personales y familiares,
invitaciones y permisos funcionan y tienen comprobaciones automatizadas y
manuales registradas en [su plan](plan-fases/plan-fase-6.md). El propietario
señala que el frontend resulta confuso, poco organizado y poco atractivo.

## Objetivo

Conseguir que una persona identifique dónde está, en qué espacio trabaja y cuál
es su siguiente acción sin recorrer formularios y secciones que compiten entre
sí. Dar a la aplicación una identidad visual coherente y legible en escritorio
y móvil, conservando los flujos ya comprobados.

## Alcance

- Jerarquía visual, navegación, selector de espacio y vocabulario consistente.
- Suscripciones, pagos personales, partes familiares, miembros e invitaciones.
- Centro de notificaciones, aceptación de códigos y acceso a la aplicación.
- Tipografía, colores, espaciado, controles, estados y accesibilidad.
- Propuesta visual revisable antes de implementar; migración pantalla por
  pantalla y regresión al finalizar cada bloque.

## Límites

Esta fase trabaja sobre el frontend y sus textos. Conserva backend, esquema SQL,
contratos HTTP, sesión, permisos y reglas de dinero y fechas. No añade cobros,
analítica, métricas inventadas, monedas no definidas, nuevas funciones de negocio
ni un cambio de framework. La landing pública se conserva durante esta fase.

Las rutas `/`, `/login`, `/dashboard`, `/invitations` y `/notifications`
seguirán disponibles. El rediseño del dashboard mantiene las vistas
Suscripciones, Pagos y Familia, con Notificaciones como destino independiente.

## Forma de trabajar

Seguir [el plan detallado](plan-fases/plan-fase-7.md), un bloque por entrega.
El perfil `frontend-designer` presenta la propuesta visual y espera la aprobación
del propietario antes de implementar el rediseño, como indica `AGENTS.md`.
Cada bloque explica qué cambia, por qué, qué se aprende y cómo comprobarlo.
Su cierre exige evidencia visual y funcional acorde a su alcance.

Este documento y el plan preparan la fase; su creación no implementa el diseño.
