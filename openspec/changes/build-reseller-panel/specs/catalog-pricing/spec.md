# Spec Delta

## Purpose

Ofrece solo paquetes Ruijie autorizados y calcula precios mayoristas reproducibles sin alterar ventas historicas cuando cambie la configuracion.

## ADDED Requirements

### Requirement: Catalogo sincronizado de solo lectura
El sistema SHALL sincronizar sitios y paquetes desde Ruijie y SHALL permitir al Administrador habilitarlos para revendedores; no SHALL crear, editar ni eliminar paquetes en Ruijie.

#### Scenario: Paquete deshabilitado
- **WHEN** un paquete no esta autorizado para un revendedor y sitio
- **THEN** el sistema no lo ofrece ni permite comprarlo

#### Scenario: Sincronizacion completa
- **WHEN** el Administrador solicita sincronizar el catalogo
- **THEN** el sistema actualiza primero los sitios y despues los User Groups de cada sitio como paquetes locales, preservando `userGroupId` y `authProfileId` como texto

### Requirement: Precedencia de precios
El sistema SHALL resolver el precio mayorista vigente en este orden: override revendedor+sitio, override revendedor, override sitio y precio base.

#### Scenario: Override mas especifico
- **WHEN** existen precios en los cuatro niveles para una compra
- **THEN** el sistema aplica el override de revendedor+sitio

### Requirement: Snapshot de venta
La orden SHALL guardar el precio unitario, cantidad, moneda y total resueltos al confirmar; cambios posteriores no SHALL alterar ordenes existentes.

#### Scenario: Precio modificado despues de comprar
- **WHEN** el Administrador cambia un precio tras confirmar una orden
- **THEN** la orden conserva su snapshot y las compras nuevas usan el precio actualizado

### Requirement: Limites comerciales del piloto
El sistema SHALL usar COP sin centavos, no SHALL calcular impuestos y no SHALL almacenar ni imponer el precio cobrado por el revendedor al huesped.

#### Scenario: Confirmacion de compra
- **WHEN** el Revendedor confirma una compra
- **THEN** el total contiene solo precio mayorista por cantidad, sin impuesto ni precio de venta al publico
