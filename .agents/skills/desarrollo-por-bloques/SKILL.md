---
name: desarrollo-por-bloques
description: "Implementar o continuar un bloque de los planes de este proyecto, delimitando alcance, coordinando entregas y explicando su comprobación. No se activa para consultas conceptuales aisladas."
---

# Desarrollo por bloques

Usa las reglas de [AGENTS.md](../../../AGENTS.md) y el [plan vigente](../../../prompts/plan-fases/). Las rutas de código siguientes se interpretan desde la raíz del repositorio.

## Delimitar la entrega

- Contrasta el bloque solicitado con el código, los diffs y las comprobaciones disponibles. Un plan existente o una casilla marcada no demuestra que el comportamiento funcione.
- Identifica un resultado observable del bloque, sus archivos y sus dependencias. No adelantes otros bloques para completar un flujo que el plan divide expresamente.
- Explica al propietario qué comportamiento se añadirá y qué concepto aprenderá. Resuelve decisiones rutinarias con el contexto existente; plantea dudas solo cuando afecten realmente al alcance.
- Si el encargo solo pide diseño o explicación, entrega ese resultado sin implementar.

## Implementar y coordinar

- Mantén una entrega pequeña que permita seguir el recorrido de los datos. Conserva los patrones del proyecto y evita reorganizar código por comodidad.
- Esta skill no activa subagentes por sí sola. Si la tarea ya incluye delegación, asigna a cada agente un objetivo, archivos, contrato esperado y evidencia de cierre. Reutiliza los perfiles de .codex/agents/.
- Separa tareas independientes de las que esperan un contrato o una implementación. Mantén un solo responsable por archivo compartido; coordina cambios en app.ts, server.ts y el dashboard.
- Integra los resultados y resuelve discrepancias antes de presentar el bloque como terminado.

## Verificar y enseñar

- Elige comprobaciones que demuestren el comportamiento nuevo y sus riesgos concretos. Respeta los puntos de prueba manual del plan; distingue lo automatizado de lo pendiente de probar por el propietario.
- Reutiliza resultados vigentes y repite comprobaciones solo ante cambios o dudas relevantes.
- Explica el resultado en español: cambio visible, recorrido del código, decisiones y archivos implicados, ejemplo de uso y comprobación real.
- Actualiza únicamente el estado del plan sustentado por evidencia. No marques la fase completa al terminar un bloque.
- Detente después del bloque con una explicación autosuficiente, para que el propietario pueda estudiarlo antes de continuar.
