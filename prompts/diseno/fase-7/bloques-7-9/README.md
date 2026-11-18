# Fase 7 — Pagos personales y familiares (bloques 7–9)

Implementación visual revisable del 16–17 de noviembre de 2026. El código
mantiene las consultas, reglas, permisos y contratos existentes. La galería
separa capturas con datos leídos de la aplicación de estados producidos por
respuestas simuladas solo en el navegador.

## Capturas con datos reales

Las capturas desktop usan viewport de 1440 px; las móviles, 390 px. Son
capturas de página completa y no implican una prueba en dispositivo físico.

| Contexto | Escritorio | Móvil |
|---|---|---|
| Pagos personales pendientes (cuenta miembro) | [1440 px](personal-pendiente-1440.png) | [390 px](personal-pendiente-390.png) |
| Historial personal (cuenta owner) | [1440 px](personal-historial-1440.png) | [390 px](personal-historial-390.png) |
| Familia, cuenta owner | [1440 px](familia-owner-1440.png) | [390 px](familia-owner-390.png) |
| Familia, cuenta miembro | [1440 px](familia-miembro-1440.png) | [390 px](familia-miembro-390.png) |
| Desglose real del pago de grupo (owner) | [1440 px](reparto-real-owner-1440.png) | [390 px](reparto-real-owner-390.png) |
| Foco de confirmación personal | — | [390 px](foco-confirmacion-personal-390.png) |
| Preferencia del sistema en modo oscuro | — | [390 px](preferencia-oscura-390.png) |

La familia existente ya tenía sus partes confirmadas. Por eso, los escenarios
con parte pendiente que siguen se generaron mediante interceptores de `fetch`
locales al navegador, sin enviar esas escrituras a la API. No son registros de
base de datos ni pruebas de persistencia.

## Estados simulados en el navegador

| Escenario | Captura |
|---|---|
| Pago personal confirmado con importe distinto | [390 px](personal-confirmado-simulado-390.png) |
| Parte propia pendiente como miembro | [1440 px](miembro-pendiente-simulado-1440.png), [390 px](miembro-pendiente-simulado-390.png) |
| Parte propia confirmada como miembro | [390 px](miembro-confirmado-simulado-390.png) |
| Owner, desglose y pago sin parte propia | [1440 px](owner-reparto-simulado-1440.png), [390 px](owner-reparto-simulado-390.png) |
| Fallo de historial de partes y aviso de clasificación segura | [390 px](fallo-historial-sin-clasificacion-simulado-390.png) |

## Comparación y puntos de control

| Vista antes de los bloques | Escritorio | Móvil |
|---|---|---|
| Personal | [1440 px](antes-personal-1440.png) | [390 px](antes-personal-390.png) |
| Familia owner | [1440 px](antes-familia-owner-1440.png) | [390 px](antes-familia-owner-390.png) |
| Familia miembro | [1440 px](antes-familia-miembro-1440.png) | [390 px](antes-familia-miembro-390.png) |

La captura [checkpoint 8 de miembro](checkpoint-8-miembro-1440.png) documenta
la presentación de la parte propia antes de terminar el desglose del bloque 9.
La captura anterior de la confirmación personal
([390 px](personal-confirmacion-390.png)) se conserva para comparar el retorno
de foco añadido después ([390 px](foco-confirmacion-personal-390.png)).

## Qué se comprobó

- Pagos personales: importe inválido sin petición; doble envío limitado a una
  petición; error conserva el borrador; cancelación de omisión no envía; se
  mostraron conflicto y éxito con respuestas interceptadas. El borrador se
  mantuvo al cambiar de vista. Los datos reales se volvieron a cargar al retirar
  el interceptor.
- Parte familiar de miembro: se conservó el límite de su cuota y se rechazó un
  importe superior sin petición; el error mantiene el borrador y el éxito mueve
  la parte al historial. La respuesta simulada mostró la diferencia entre cuota
  propia y total del grupo.
- Parte familiar de owner: se conservó la excepción existente de registrar más
  que su cuota propia; dos envíos rápidos produjeron una sola petición.
- Desglose y pagos sin parte propia: carga, error/reintento, éxito/error,
  conflicto de omisión y ausencia de clasificación cuando falla el historial de
  partes. La sección no afirma que la falta de parte sea un pago asignado al
  usuario.
- Teclado: Tab mostró el foco visible del botón de confirmación; al abrir el
  formulario, el foco pasó al campo de importe, y cancelar lo devolvió al botón.
- Viewports de 360, 390, 768 y 1440 px medidos en los escenarios inspeccionados;
  la preferencia oscura del sistema conserva el ámbito claro de la aplicación.
  La landing mantuvo los mismos SHA-256 que sus capturas de referencia a 1440 y
  390 px.
- `frontend lint`, `tsc --noEmit`, `frontend build` y `git diff --check`
  terminaron correctamente. El `reviewer` hizo revisión estática y no encontró
  regresiones nuevas en el alcance de estos bloques.

La inspección visual de capturas no cubre dispositivos físicos, zoom al 200 % ni
la regresión integral de navegación y teclado; corresponden a los bloques 16 y
17. No se cambiaron importes ni estados reales. Las escrituras de pago y parte
se interceptaron antes de llegar al backend; las lecturas consultaron los datos
existentes. No se iniciaron jobs ni migraciones para esta comprobación.

El navegador y su perfil temporal aislado, sus cookies y el script temporal se
eliminaron después de la comprobación. Los servicios locales de revisión pueden
permanecer disponibles para que el propietario abra el dashboard y revise las
vistas; no forman parte de la app desplegada.
