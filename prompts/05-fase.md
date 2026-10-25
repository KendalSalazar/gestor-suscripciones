# Fase 5 — Modo familia, invitaciones y partes de pago

## Contexto

Este es un proyecto individual de aprendizaje para controlar suscripciones y
registrar cobros. Los registros de pago son declaraciones de los usuarios: la
aplicación no mueve dinero ni verifica transacciones con proveedores.

La Fase 4 ya aporta pagos personales, generación programada, confirmación,
omisión y dashboard. Su cierre quedó verificado el 24 de octubre de 2026,
según [el informe correspondiente](../backend/docs/phase-4-verification.md).
La Fase 5 se implementa por bloques; el avance comprobado figura en
[el plan detallado](plan-fases/plan-fase-5.md). Este documento no autoriza
adelantar bloques sin el encargo correspondiente.

## Objetivo

Permitir que un usuario conserve su grupo personal y además cree o se una a
grupos `family`. Cada pago familiar capturará las partes previstas de sus
miembros activos y cada persona confirmará cuánto registró por su propia parte.
El grupo podrá gestionar sus miembros e invitaciones sin perder el historial.

## Alcance

- Crear, listar y renombrar grupos familiares; mantener el grupo personal.
- Listar miembros activos, transferir ownership y permitir salida o expulsión
  cuando no existan partes propias pendientes que dejarían de poder resolverse.
- Invitar por correo destinatario y código de un solo uso compartido manualmente.
  Aceptar exige sesión, correo de cuenta coincidente y posesión del código.
- Repartir cada pago familiar a partes iguales entre los miembros activos,
  incluido el owner, con céntimos exactos y una foto que después no se redistribuye.
- Confirmar partes propias y calcular el estado e importe agregado del pago.
- Elegir grupo en el dashboard y mostrar acciones según la membresía y el rol.
- Conservar los contratos personales y comprobar permisos, concurrencia y navegador.

## Decisiones iniciales del plan

Estas decisiones se revisan al leer el plan antes del primer bloque de código:

1. Reparto igual, sin porcentajes configurables por suscripción en esta fase.
2. Hasta 20 miembros activos por grupo familiar, contando al owner; la aceptación
   comprueba el límite de forma atómica. Las invitaciones no reservan plaza.
3. Invitaciones válidas durante siete días, con secreto opaco guardado solo como
   hash. No dependen de que la cuenta destinataria ya exista al crearlas.
4. El pago familiar se confirma automáticamente cuando todas sus partes están
   confirmadas. Su importe real es la suma exacta de los importes registrados.
5. El owner puede omitir un pago familiar completo únicamente antes de que alguien
   confirme una parte. No puede confirmar la parte de otra persona.
6. Altas y bajas afectan a pagos generados después; no cambian partes existentes.
   La foto se toma al generar, también al recuperar fechas atrasadas.

## Límites

No incluir pasarelas de pago, transferencias de dinero, verificación bancaria,
envío automático de emails, centro de notificaciones, avisos de impago ni reglas
adicionales de anomalías. Las notificaciones corresponden a la Fase 6.

Tampoco incluir reparto ponderado o participantes elegibles por suscripción,
reparto retroactivo, corrección de partes resueltas, cobro en nombre de terceros,
eliminación de grupos, conversión de personal a familiar, traslado de
suscripciones entre grupos ni eliminación de cuentas. Estas funciones no se
añaden como atajos para resolver conflictos del alcance actual.

La identidad sigue siendo la cuenta autenticada. La aplicación actual no verifica
propiedad del correo mediante email; por eso aceptar no puede basarse solo en
declarar un correo: exige también el código que el owner comparte por un canal
elegido por él. No presentar ese mecanismo como verificación bancaria o de email.

## Forma de implementar

Seguir [el plan detallado](plan-fases/plan-fase-5.md), un bloque pequeño por vez.
Antes de cada bloque, explicar comportamiento, motivo, archivos y conceptos.
Después, comunicar las comprobaciones reales y detenerse para lectura o prueba.
Aplicar las skills locales pertinentes y los perfiles de agentes de AGENTS.md,
con un único responsable de escritura por archivo.

No instalar dependencias por adelantado, aplicar migraciones al escribir el plan
ni marcar la Fase 5 como terminada por existir estos documentos.
