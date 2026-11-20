# Fase 8 — Registro de cuentas y página de inicio

## Contexto

Proyecto individual de aprendizaje para controlar suscripciones personales y
familiares. La Fase 7 está cerrada, con aceptación visual y funcional del
propietario registrada en [su plan](plan-fases/plan-fase-7.md). Su lenguaje visual
usa violeta `#CF7FFF`, superficies claras, jerarquía sencilla y formularios
centrados en la tarea.

El backend ya permite crear cuentas mediante `POST /auth/register`: crea en una
transacción el usuario, su grupo personal, su membresía y la primera sesión.
Falta ofrecer ese recorrido desde la interfaz. La página pública `/` conserva
su diseño anterior y solo enlaza a inicio de sesión y dashboard.

## Objetivo

Permitir que una persona conozca la aplicación, cree su cuenta desde el navegador
y llegue a su espacio personal sin usar comandos. Actualizar la página de inicio
para que explique las funciones reales y tenga continuidad con el diseño actual.

## Alcance

- Nueva ruta `/register` con nombre, correo, contraseña y confirmación.
- Validación comprensible, envío único, errores y recuperación del registro.
- Inicio de sesión automático después del registro mediante el contrato existente.
- Enlaces entre inicio, registro e inicio de sesión.
- Página de inicio renovada para escritorio y móvil, con «Crear cuenta» como
  acción principal e «Iniciar sesión» como alternativa visible.
- Conservación de la sesión existente al visitar registro con una cuenta activa.
- Comprobación del recorrido de una cuenta nueva, recarga, salida e inicio de sesión.

## Decisiones y límites

La fase integra el registro existente; no necesita nuevas tablas, migraciones ni
endpoints. Los tokens siguen en memoria y cookie httpOnly. No se guardan
credenciales en almacenamiento del navegador ni se incluyen en URLs o logs.

La portada describe suscripciones, control de pagos, familia y avisos internos.
Los pagos siguen siendo anotaciones: no se prometen cobros, transferencias,
verificación bancaria, emails automáticos ni ahorros calculados. El acceso para
introducir códigos de invitación permanece dentro de Familia.

Quedan fuera recuperación/cambio de contraseña, verificación de correo, OAuth,
perfil, eliminación de cuentas, email/push, nuevas reglas de pagos, despliegue y
rediseño del dashboard. La autorización de esta fase sí permite sustituir la
landing que se preservó durante la Fase 7.

## Forma de trabajar

Seguir el [plan detallado](plan-fases/plan-fase-8.md) por bloques pequeños, con
explicación, resultado observable y comprobación antes de avanzar. Usar
`frontend-designer` y la skill `frontend-design` para la propuesta de las dos
pantallas. Presentar una propuesta concreta y obtener aprobación antes de
implementar el rediseño, según `AGENTS.md`.

Esta entrega prepara la fase. No implementa pantallas, crea cuentas ni declara
sus bloques completados.
