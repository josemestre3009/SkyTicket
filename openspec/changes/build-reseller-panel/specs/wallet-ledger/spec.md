# Spec Delta

## Purpose

Mantiene saldo prepago auditable mediante un ledger inmutable y garantiza que concurrencia, reintentos o fallos no creen dinero ni saldo negativo.

## ADDED Requirements

### Requirement: Dinero entero y sin credito
El sistema SHALL representar COP como pesos enteros, SHALL mantener saldos disponible, reservado y total, y nunca SHALL permitir saldo disponible o total negativo.

#### Scenario: Saldo insuficiente
- **WHEN** una orden requiere mas saldo disponible que el existente
- **THEN** el sistema rechaza la reserva antes de contactar a Ruijie

#### Scenario: Compras concurrentes
- **WHEN** dos compras concurrentes compiten por el mismo saldo
- **THEN** el control atomico permite solo reservas cubiertas y el saldo nunca queda negativo

### Requirement: Ledger inmutable
El sistema SHALL registrar recargas, ajustes, reservas, capturas, liberaciones y reversos como movimientos append-only; una correccion SHALL usar un movimiento compensatorio que referencia el original.

#### Scenario: Correccion de movimiento
- **WHEN** el Administrador corrige una recarga confirmada
- **THEN** el sistema crea un reverso o ajuste auditable sin actualizar ni eliminar el movimiento original

### Requirement: Operaciones monetarias idempotentes
Cada operacion monetaria SHALL exigir una referencia idempotente unica y una repeticion SHALL devolver el resultado previo sin duplicar movimientos.

#### Scenario: Recarga repetida
- **WHEN** se envia dos veces una recarga con la misma referencia
- **THEN** el saldo aumenta exactamente una vez

### Requirement: Evidencia administrativa
Cada recarga o ajuste SHALL registrar revendedor, monto, moneda, tipo, referencia unica, motivo, Administrador, fecha efectiva y evidencia cuando el tipo configurado la requiera.

#### Scenario: Recarga sin motivo
- **WHEN** el Administrador intenta registrar una recarga sin motivo
- **THEN** el sistema rechaza la operacion sin cambiar el saldo

### Requirement: Recarga por correo
El Administrador SHALL poder agregar saldo buscando el correo de un usuario Revendedor. El backend SHALL resolver el revendedor asociado y no SHALL confiar en un `resellerId` enviado por el formulario.

#### Scenario: Correo valido
- **WHEN** el Administrador indica un correo de Revendedor, monto, motivo y referencia idempotente validos
- **THEN** el sistema acredita una sola vez el monedero asociado y registra el movimiento auditable

#### Scenario: Correo no asociado
- **WHEN** el correo no pertenece a un Revendedor activo
- **THEN** el sistema rechaza la recarga sin modificar ningun saldo

### Requirement: Reserva, captura y liberacion
El sistema SHALL reservar al confirmar una orden, capturar una sola vez despues de guardar los bonos emitidos y liberar una reserva vencida o fallida mediante movimiento auditable.

#### Scenario: Emision confirmada
- **WHEN** todos los bonos recibidos de Ruijie quedan guardados localmente
- **THEN** el sistema captura exactamente una vez la reserva de la orden

#### Scenario: Fallo confirmado antes de emitir
- **WHEN** Ruijie confirma que no se emitio ningun bono
- **THEN** el sistema libera la reserva y conserva la trazabilidad

### Requirement: Integridad verificable
El saldo proyectado del monedero SHALL ser reproducible desde el ledger y cualquier diferencia SHALL generar una incidencia sin corregirse silenciosamente.

#### Scenario: Diferencia de proyeccion
- **WHEN** una verificacion detecta que la proyeccion no coincide con la suma del ledger
- **THEN** el sistema bloquea operaciones monetarias afectadas y alerta al Administrador
