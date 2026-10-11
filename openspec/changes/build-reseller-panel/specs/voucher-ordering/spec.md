# Spec Delta

## Purpose

Coordina ordenes y emision de bonos con limites seguros, entrega minima aprobada y trazabilidad completa ante exito, fallo o incertidumbre.

## ADDED Requirements

### Requirement: Creacion idempotente de ordenes
El sistema SHALL exigir una referencia local unica por orden y SHALL devolver la misma orden ante una repeticion con la misma referencia y datos compatibles.

#### Scenario: Confirmacion repetida
- **WHEN** el cliente repite una solicitud con la misma referencia
- **THEN** el sistema devuelve la orden existente sin reservar ni emitir otra vez

### Requirement: Cantidad permitida
Cada orden SHALL contener entre 1 y 100 bonos de un paquete autorizado para un sitio asignado.

#### Scenario: Lote superior al piloto
- **WHEN** un Revendedor solicita 101 bonos
- **THEN** el sistema rechaza la orden antes de reservar saldo

### Requirement: Secuencia segura de emision
El sistema SHALL validar autorizacion y precio, reservar saldo, iniciar una unica creacion Ruijie, guardar respuesta cruda y bonos normalizados, y capturar solo despues del guardado exitoso.

#### Scenario: Emision completa
- **WHEN** Ruijie devuelve todos los bonos solicitados y se guardan correctamente
- **THEN** la orden queda emitida, la reserva capturada y cada bono vinculado a la orden

#### Scenario: Persistencia local fallida
- **WHEN** Ruijie responde con bonos pero el guardado local no puede confirmarse
- **THEN** la orden queda bloqueada para conciliacion y la creacion no se repite automaticamente

### Requirement: Resultado incierto
Ante timeout, HTTP ambiguo o codigos Ruijie 3, 4, 7 o 25 durante creacion, el sistema SHALL conservar la reserva, marcar la orden para conciliacion y no repetir ciegamente la creacion.

#### Scenario: Timeout durante create
- **WHEN** la respuesta de creacion termina en timeout sin resultado confirmado
- **THEN** la orden queda incierta y no se inicia una segunda creacion

### Requirement: Entrega aprobada del MVP
El sistema SHALL mostrar y permitir copiar codigos emitidos a usuarios autorizados; no SHALL ofrecer ticket imprimible, CSV, QR, email ni WhatsApp.

#### Scenario: Mostrar codigo
- **WHEN** un Revendedor solicita revelar un bono propio emitido
- **THEN** el sistema muestra y permite copiar el codigo, y audita la revelacion

### Requirement: Reembolso restringido
El sistema no SHALL reembolsar bonos emitidos ni revertir capturas; solo SHALL liberar reservas por fallo confirmado o por unidades no emitidas despues de una emision parcial conciliada.

#### Scenario: Solicitud de reembolso de bono emitido
- **WHEN** se solicita devolver saldo por un bono ya emitido
- **THEN** el sistema rechaza la operacion porque Ruijie no garantiza su revocacion
