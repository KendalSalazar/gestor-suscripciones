# Guía para agentes de IA

## Propósito

Este repositorio es un proyecto individual para registrar suscripciones (por ejemplo, streaming o gimnasio), controlar sus fechas y costes, y permitir que un grupo comparta una suscripción. Su propósito principal es que su propietario aprenda mientras lo construye.

En cada implementación, sigue el plan de la fase poco a poco: aborda un bloque pequeño por vez, explica qué se va a hacer y por qué, qué archivos intervienen y qué conceptos se practican. Después de cada bloque, resume el cambio y cómo comprobarlo en términos comprensibles antes de avanzar. Evita entregar una implementación grande de una sola vez o añadir abstracciones que dificulten el aprendizaje. Conserva las decisiones de dominio y seguridad documentadas aquí y en los planes.

## Cómo orientarse

Antes de cambiar código:

1. Inspecciona el estado real del repositorio y los archivos relacionados. Los planes describen objetivos y decisiones; no prueban que una funcionalidad ya esté implementada.
2. Lee el plan de fase aplicable en `prompts/plan-fases/`. Los planes 1 a 4 contienen el diseño y los pasos detallados de cada fase.
3. Para contexto original y alcance de una fase, consulta el documento correspondiente en `prompts/01-fase.md` a `prompts/04-fase.md`.
4. Si trabajas en `frontend/`, lee también `frontend/AGENTS.md`. Respeta sus instrucciones sobre la versión de Next.js y consulta la documentación local indicada allí antes de modificar APIs del framework.

No dupliques planes completos en este archivo. Si una decisión detallada no aparece aquí, prevalece el plan de la fase correspondiente, siempre contrastado con el código vigente. Si código y documentación discrepan, señala la discrepancia antes de hacer cambios de alcance amplio.

## Proyecto y arquitectura

- Monorepo pequeño con `backend/` y `frontend/`; no hay `package.json` en la raíz.
- Backend: Node.js, Express 5, TypeScript, PostgreSQL (`pg`), SQL directo, Zod, Winston y pnpm. TypeScript usa CommonJS.
- Frontend: Next.js App Router, React y TypeScript; su implementación de producto debe seguir el plan vigente y las instrucciones locales de `frontend/AGENTS.md`.
- PostgreSQL 16 para desarrollo se define en `docker-compose.yml`.
- El backend escucha en el puerto 3001 y el frontend de desarrollo en el 3000.
- Las migraciones SQL están en `backend/src/db/migrations/`; el runner de `backend/src/db/migrate.ts` las aplica y registra.
- El backend organiza funcionalidades en módulos bajo `backend/src/modules/`. Los tests existentes se ubican junto al código bajo `src/`.

### Estado conocido al iniciar la Fase 4

Las fases 1 a 3 están implementadas: migraciones `001` a `005`, autenticación, CRUD de suscripciones y dashboard personal. La Fase 4 está diseñada en `prompts/plan-fases/plan-fase-4.md`; sus bloques de pagos todavía deben contrastarse con el código antes de marcarlos como completados. Verifica siempre el estado actual del repositorio.

## Dominio

- `users` representa las cuentas.
- `groups` puede ser `personal` o `family`. El modo individual es un grupo personal con el usuario como owner.
- `group_members` relaciona usuarios con grupos y contiene `role` (`owner` o `member`) y `status` (`active`, `invited` o `removed`). El registro crea el grupo personal y su membresía activa de owner.
- Las suscripciones pertenecen a un grupo, no directamente a un usuario. Consulta el plan de Fase 3 para el esquema y las reglas acordadas.
- Pagos y generación programada corresponden a la Fase 4. Partes de pago e invitaciones son de Fase 5; notificaciones y anomalías adicionales son de Fase 6. No adelantes esas funciones.

## Decisiones técnicas y de seguridad

- Reutiliza los módulos, middleware, logger, manejo de errores, pool y runner de migraciones existentes; no recrees infraestructura sin necesidad demostrada.
- Usa consultas SQL parametrizadas. En consultas de suscripciones, limita siempre por grupo y comprueba la autorización antes de exponer o modificar datos.
- El access token es un JWT corto enviado como `Authorization: Bearer`. El refresh token es opaco, va en cookie `httpOnly` y en la base se conserva su hash; nunca expongas el refresh token en JSON ni registres tokens, cookies, contraseñas, hashes, secretos o `DATABASE_URL`.
- Normaliza el email con `trim().toLowerCase()`. No reveles si una cuenta existe en errores de login.
- Valida entradas con Zod y reutiliza `validate` y `AppError` según los patrones existentes. Mantén el contrato y formato de errores del backend.
- Mantén el acceso a datos y autorización dentro del diseño del módulo. Para Fase 3, el plan especifica autorización por membresía activa en el servicio y permisos de escritura de owner.
- Trata `NUMERIC` de PostgreSQL como decimal string al cruzar la API; no pierdas precisión convirtiéndolo sin criterio a `number`. Las fechas SQL `DATE` deben conservar formato `YYYY-MM-DD` sin desplazamiento horario.
- No añadas ORM ni dependencias nuevas sin que sean imprescindibles y estén justificadas. Comprueba primero el `package.json` del paquete afectado.
- No guardes access tokens en `localStorage`; el diseño del frontend de Fase 3 los mantiene en memoria y usa la cookie para refresh.
- No leas ni expongas archivos `.env`. Usa `.env.example` como referencia y nunca incluyas credenciales reales en documentación, respuestas o logs.

## Forma de trabajar

- Implementa solo el alcance autorizado y la fase solicitada. Mantén los cambios pequeños, comprensibles y alineados con el plan.
- No reemplaces ni reorganices archivos existentes sin una necesidad clara. Revisa primero sus usos y conserva las rutas ya funcionales, en especial `/health` y `/auth`.
- No introduzcas roles, tablas, endpoints o funciones de fases futuras por anticipación.
- Para cambios de frontend, conserva la landing existente salvo que el plan y la tarea indiquen otra cosa; muestra estados de carga, vacío y error cuando corresponda.
- Actualiza documentación cuando cambie un contrato HTTP o una decisión de arquitectura.
- Informa qué cambió y qué verificaciones se ejecutaron. No afirmes que una fase está completa solo porque exista su plan; contrasta su checklist con el código y las verificaciones pertinentes.

## Orquestación con subagentes

- El agente principal tiene autorización permanente para delegar tareas a subagentes cuando aporten valor al trabajo solicitado, sin pedir confirmación en cada ocasión. Puede resolver directamente tareas pequeñas o estrechamente dependientes.
- Usa los perfiles de `.codex/agents/`: `backend` para servidor y persistencia, `frontend` para interfaz e integración y `reviewer` para revisión con evidencia sin editar archivos. Aplica las skills pertinentes de `.agents/skills/` según la tarea, tanto en el principal como en los subagentes.
- Antes de delegar, define objetivo, alcance, archivos asignados, dependencias y resultado esperado. Comparte las instrucciones aplicables, el plan vigente y el contexto necesario; no presupongas memoria de conversaciones anteriores.
- Mantén un único responsable de escritura por archivo y conserva los cambios ajenos. Ejecuta en paralelo solo tareas independientes; una revisión del resultado debe esperar a que la implementación esté disponible.
- La delegación conserva el alcance y los permisos de la tarea original. No autoriza adelantar bloques o fases, aplicar cambios externos ni realizar operaciones adicionales sobre datos. Los subagentes no deben crear otros subagentes por iniciativa propia.
- El principal coordina e integra los resultados, contrasta los hallazgos y comunica brevemente qué se delegó y por qué. Entrega una explicación en español y las comprobaciones reales, manteniendo el objetivo de aprendizaje y la parada después de cada bloque.

## Comandos útiles

Ejecuta los comandos desde la raíz usando `--dir` o desde el paquete correspondiente:

```bash
pnpm --dir backend dev
pnpm --dir backend migrate
pnpm --dir backend typecheck
pnpm --dir backend test
pnpm --dir backend build

pnpm --dir frontend dev
pnpm --dir frontend lint
pnpm --dir frontend build
```

El backend copia las migraciones a `dist/` durante `build`. No hay scripts de raíz para sustituir los comandos por paquete.
