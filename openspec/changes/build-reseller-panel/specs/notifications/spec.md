# Spec Delta

## Purpose

Entrega por email eventos que requieren atencion operativa, sin incorporar una bandeja de avisos visible en el MVP.

## ADDED Requirements

### Requirement: Canales por evento
El sistema SHALL enviar por email saldo bajo y recarga al Revendedor, emision incierta al Administrador y Revendedor, suspension al Revendedor y fallo de sincronizacion al Administrador. No SHALL mostrar un centro de avisos ni contadores de notificaciones en el MVP.

#### Scenario: Saldo bajo
- **WHEN** el saldo disponible cruza el umbral configurado del revendedor
- **THEN** el sistema envia un email al Revendedor sin duplicarlo en cada corrida

#### Scenario: Orden incierta
- **WHEN** una emision queda en un resultado incierto que requiere verificacion interna
- **THEN** el sistema envia email al Administrador y al Revendedor con un mensaje simple, sin crear una bandeja visible

### Requirement: Entrega email resiliente
El envio email SHALL ejecutarse fuera de la transaccion de negocio, registrar entrega o fallo y reintentarse de forma limitada sin duplicar el evento de negocio.

#### Scenario: Proveedor email no disponible
- **WHEN** falla el envio de una alerta por email
- **THEN** la operacion original permanece confirmada y el fallo queda visible para reintento operativo
