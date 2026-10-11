# Spec Delta

## Purpose

Detecta y resuelve diferencias financieras y operativas sin duplicar emisiones ni ocultar resultados desconocidos de sistemas externos.

## ADDED Requirements

### Requirement: Recuperacion de ordenes estancadas
El sistema SHALL identificar reservas vencidas y ordenes estancadas; solo SHALL liberar saldo cuando pueda confirmar que no hubo emision.

#### Scenario: Orden incierta estancada
- **WHEN** una orden incierta supera su umbral operativo
- **THEN** el sistema la mantiene reservada, alerta al Administrador e inicia conciliacion sin recrear bonos

### Requirement: Conciliacion de bonos
El sistema SHALL comparar bonos locales y Ruijie por UUID y referencias disponibles, detectar faltantes, externos y cambios de estado, y conservar evidencia cruda.

#### Scenario: Bono local ausente en Ruijie
- **WHEN** una corrida no encuentra un bono local dentro de la retencion esperada
- **THEN** el sistema crea una incidencia sin eliminar el bono ni cambiar saldo automaticamente

#### Scenario: Bono externo
- **WHEN** Ruijie contiene un bono no creado por SkyTicket
- **THEN** el sistema lo clasifica como externo y no lo atribuye a un revendedor sin evidencia

### Requirement: Emision parcial
El sistema SHALL tratar `count < quantity` como `needs_reconciliation` sin capturar ni liberar automaticamente. Despues de validar la semantica en sandbox, una resolucion administrativa SHALL poder capturar las unidades confirmadas y liberar las no emitidas conforme a evidencia persistida.

#### Scenario: Menos bonos que cantidad solicitada
- **WHEN** Ruijie confirma menos bonos que los solicitados
- **THEN** el sistema preserva los bonos recibidos y mantiene intacta la reserva hasta una resolucion administrativa basada en evidencia

### Requirement: Resolucion interna auditada
La conciliacion SHALL ejecutarse de forma automatica e interna en el MVP, sin bandeja, listado de casos ni ruta de resolucion visibles en el panel. Cuando se requiera una resolucion, el servicio de conciliacion SHALL registrarla con actor, motivo y evidencia; ninguna resolucion SHALL borrar historia ni provocar captura o reverso duplicado.

#### Scenario: Cierre interno de una incidencia
- **WHEN** se resuelve una incidencia con evidencia Ruijie a traves del servicio de conciliacion
- **THEN** el sistema registra actor, fecha, motivo, evidencia y movimientos compensatorios aplicados, sin exponer una bandeja de casos en el panel

#### Scenario: Sin superficie visible
- **WHEN** un Administrador navega el panel del MVP
- **THEN** no encuentra bandeja, listado de casos ni accion de resolucion de conciliacion
