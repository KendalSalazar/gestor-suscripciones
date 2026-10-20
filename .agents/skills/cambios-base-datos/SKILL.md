---
name: cambios-base-datos
description: "Crear o modificar migraciones SQL, operaciones transaccionales o pruebas de integración PostgreSQL de este proyecto. Distingue preparar un cambio de aplicarlo a una base real."
---

# Cambios de base de datos

Consulta [AGENTS.md](../../../AGENTS.md), el plan aplicable y el esquema real. Las rutas citadas parten de la raíz. Esta skill conserva el alcance del encargo: un análisis no autoriza escrituras y preparar SQL no implica por sí solo aplicarlo.

## Migraciones

- Revisa backend/src/db/migrations/ y db/migrate.ts antes de elegir nombre y secuencia. El runner registra filenames en schema_migrations y ejecuta cada archivo nuevo dentro de una transacción.
- Añade una migración nueva cuando cambie un esquema ya aplicado; editar un archivo registrado no hará que el runner lo ejecute otra vez.
- Define invariantes mediante FK, UNIQUE y CHECK, además de validarlas en el servicio. Decide qué debe ocurrir con el historial al borrar o desactivar recursos según el plan.
- Para columnas nuevas sobre datos existentes, contempla backfill y compatibilidad con las rutas que todavía insertan o actualizan filas.
- Si aplicar la migración forma parte del encargo autorizado, usa la configuración local existente sin leer ni mostrar .env. Aplícala mediante el runner, repite migrate y comprueba esquema, restricciones y backfill.
- La segunda ejecución sin pendientes demuestra idempotencia del runner; no significa que el SQL pueda ejecutarse arbitrariamente varias veces.

## Transacciones y concurrencia

- Expresa qué cambios deben confirmarse juntos y qué pasa si hay un error entre ellos. Usa un único cliente desde BEGIN hasta COMMIT o ROLLBACK, y libéralo siempre.
- Cuando sea posible repetir o solapar una operación, define su identidad, la restricción única o bloqueo necesario y el resultado esperado al reintentar.
- En procesos de recuperación de atrasos, verifica límites por ejecución y continuidad, además del caso normal.
- Conserva importes NUMERIC sin aritmética binaria de punto flotante y fechas DATE sin conversiones horarias accidentales.

## Evidencia con PostgreSQL

- Para pruebas con escrituras, crea datos exclusivos con UUID y prefijo de prueba; limita lecturas, cambios y limpieza a los identificadores creados por esa prueba.
- Respeta RUN_DB_TESTS=1 para la integración optativa y conserva pnpm test funcional sin Docker. No ejecutes generación global para comprobar fixtures.
- Elige casos según el riesgo: rollback, repetición, concurrencia, captura del importe esperado o conservación del historial. No hagas resets ni limpiezas generales.
- Informa la base objetivo sin credenciales, las operaciones realizadas y los resultados observados. Si no pudiste aplicar o verificar, diferencia claramente el SQL preparado de la comprobación pendiente.
