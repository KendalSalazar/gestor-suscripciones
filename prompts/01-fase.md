
## Contexto del proyecto

Estoy construyendo un proyecto de práctica personal: un **sistema de rastreo de suscripciones compartidas** ("subscripciones-compartidas"). El objetivo es llevar el control de suscripciones (Netflix, Spotify, gimnasio, etc.), con recordatorios de pago y detección de anomalías (subidas de precio, pagos faltantes).

### Modos de uso

El sistema soporta dos modalidades bajo el mismo modelo de datos:
- **Modo individual**: un usuario lleva sus propias suscripciones sin compartir con nadie.
- **Modo familia**: varias personas comparten una suscripción y cada una confirma su parte del pago.

Ambos modos se resuelven con el mismo concepto: un `group` (grupo). El modo individual es simplemente un grupo con un solo miembro (el usuario mismo, como owner). Al registrarse, cada usuario obtiene automáticamente un grupo `personal`. Si además crea o se une a un grupo `family`, sus suscripciones familiares viven en ese otro grupo.

### Registro de pagos (nivel semi-automático con confirmación)

No es manual puro ni integración con gateway de pagos real. El flujo es:
1. Un job programado (cron) revisa `next_billing_date` de cada suscripción activa y genera un registro de pago en estado `pending` con el monto esperado.
2. El usuario recibe una notificación y confirma el pago desde el dashboard.
3. Al confirmar, puede aceptar el monto esperado o corregirlo si cambió — si cambió, se marca `price_changed = true` (fuente de detección de anomalías).
4. En modo familia, al generarse el pago se crean automáticamente los `payment_shares` correspondientes a cada miembro activo del grupo, y cada quien confirma su propia parte.
5. Otro job revisa pagos que llevan muchos días en `pending` sin confirmar y genera una notificación de "pago no confirmado".

### Modelo de datos

```
users
  id, email, password_hash, name, created_at

groups
  id, name, type (personal/family), owner_id (FK users), created_at

group_members
  id, group_id (FK), user_id (FK), role (owner/member),
  status (active/invited/removed), joined_at

subscriptions
  id, group_id (FK), name, provider, expected_cost, billing_cycle,
  next_billing_date, active, created_at

payments
  id, subscription_id (FK), expected_amount, actual_amount, expected_date,
  status (pending/confirmed/skipped), price_changed (boolean)

payment_shares
  id, payment_id (FK), user_id (FK), share_amount, share_percentage,
  status (pending/confirmed), confirmed_at

notifications
  id, user_id (FK), subscription_id (FK), type (reminder/anomaly/invite),
  message, sent_at, read_at
```

### Stack técnico

- **Backend**: Node.js + Express + TypeScript, axios para llamadas externas si se requieren
- **Frontend**: Next.js + React (App Router)
- **Autenticación**: JWT (access token corto + refresh token, refresh persistido en tabla `refresh_tokens` y entregado como cookie httpOnly)
- **Logger**: Winston (niveles info/warn/error, transports separados por contexto: auth, payment, job; sin loguear datos sensibles como passwords o montos completos de tarjetas)
- **Base de datos**: PostgreSQL
- **Gestor de paquetes**: pnpm
- **Convenciones**: TypeScript pineado a ^5.7.0, `"module": "commonjs"`, tests co-ubicados dentro de `src/`

### Plan de fases general (ya definido, no lo repitas ni lo cambies)

1. Base del proyecto (setup, Express, Postgres, Winston, migraciones de `users`/`groups`/`group_members`)
2. Autenticación (JWT access+refresh, creación automática del grupo personal al registrarse)
3. Suscripciones (CRUD, permisos por rol, dashboard básico)
4. Pagos y jobs programados (generación de pagos pendientes, confirmación, detección de `price_changed`)
5. Modo familia e invitaciones (flujo de invitación, `payment_shares`, gestión de miembros)
6. Notificaciones y anomalías (job de pagos vencidos, reglas de anomalía, centro de notificaciones)
7. Pulido (manejo de errores, logging completo, tests, documentación del API)

---

## Lo que necesito que hagas

Quiero que generes un **plan detallado en Markdown para la Fase 1 únicamente** (Base del proyecto), listo para dárselo a un modelo de implementación (OpenCode) como guía paso a paso. Crea el archivo gestor-suscripciones\prompts\plan-fases\plan-fase-1.md El plan debe incluir:

1. **Estructura de carpetas completa** del backend (y mención de dónde vivirá el frontend si aplica en esta fase), siguiendo las convenciones ya mencionadas (TypeScript, pnpm, tests co-ubicados en `src/`).
2. **Lista de dependencias exactas** a instalar (dependencias y devDependencies), con su propósito.
3. **Variables de entorno necesarias** (`.env.example`) para esta fase: conexión a Postgres, puerto, secretos de JWT (aunque JWT se implemente en Fase 2, define aquí las env vars si aplica), configuración de Winston.
4. **Configuración de Winston** para esta fase: niveles, formato, transports (consola en dev, archivo en producción), y una nota explícita de qué NO debe loguearse nunca.
5. **Configuración del pool de conexión a Postgres** (pg o el cliente que recomiendes, manejo de errores de conexión).
6. **Migraciones SQL** para las tablas `users`, `groups`, `group_members` (solo estas tres, las demás vienen en fases posteriores), incluyendo tipos de datos, constraints, foreign keys, e índices razonables.
7. **Middleware base de manejo de errores** (estructura, no la lógica de negocio todavía).
8. **Checklist final** de verificación para saber que la Fase 1 está completa antes de pasar a la Fase 2.

No implementes lógica de negocio, autenticación, ni rutas de negocio todavía — esta fase es únicamente la base técnica del proyecto. Sé específico y concreto en cada paso, como si este documento fuera a ser ejecutado por otro modelo sin contexto adicional.