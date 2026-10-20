---
name: revisar-cambios
description: "Revisar un diff, bloque o implementación de este proyecto y devolver hallazgos con evidencia. Usar en encargos de revisión; no aplicar correcciones ni iniciar auditorías generales."
---

# Revisión de cambios con evidencia

Usa [AGENTS.md](../../../AGENTS.md), las instrucciones locales y el plan del bloque como criterio. Las rutas citadas parten de la raíz. Esta skill produce una revisión; las correcciones corresponden a un encargo de implementación.

## Delimitar y reunir evidencia

- Identifica qué se revisa: cambios sin commit, un commit, un rango o archivos concretos. Consulta git status y el diff apropiado; incluye archivos nuevos y cambios staged cuando formen parte del encargo.
- Lee el contexto y los consumidores del cambio. Diferencia problemas introducidos por el diff de problemas preexistentes y de decisiones explícitas del plan.
- Mantén solo lectura sobre archivos y datos. No ejecutes migraciones, generación de pagos ni pruebas con efectos desconocidos para demostrar una hipótesis.
- Un resultado de pruebas comunicado por otro agente es evidencia reportada; no lo presentes como una ejecución propia.

## Revisar según el riesgo

- En API, sigue Bearer, validación, membresía, rol y filtro SQL del grupo. Considera tanto el acceso permitido como una consulta que intente cruzar grupos.
- En persistencia, sigue confirmación, rollback, restricciones, repetición y concurrencia. Comprueba importes y fechas en el cruce de base de datos y API.
- En interfaz, sigue sesión, contrato, acción pendiente, error y actualización de datos. Comprueba que la pantalla permita entender el resultado.
- En instrucciones o configuración de agentes y skills, comprueba activación, alcance, referencias existentes y que no conviertan una tarea de lectura en una escritura ni amplíen lo autorizado.
- Pide pruebas adicionales solo para una incertidumbre relevante del cambio. Evita recomendaciones genéricas de cobertura y cambios de estilo sin un problema concreto.

## Entregar hallazgos útiles

- Ordena por impacto. Cada hallazgo debe incluir archivo y línea, condición que lo activa, consecuencia observable y corrección mínima propuesta.
- Fundamenta cada conclusión en código, contrato, documentación o reproducción. Señala las hipótesis que todavía no se pudieron comprobar.
- Si no encuentras errores, dilo con el alcance revisado y sus límites; no declares ausencia absoluta de problemas.
- Separa problemas que requieren corrección de sugerencias opcionales y omite sugerencias que no aporten al encargo.
- Explica en español con ejemplos comprensibles y devuelve la revisión al principal o al usuario, sin aplicar cambios.
