# Spec Delta

## Purpose

Protege secretos, codigos de acceso y operaciones financieras mediante cifrado, minimizacion, redaccion y evidencia auditable.

## ADDED Requirements

### Requirement: Proteccion de secretos
El sistema SHALL leer secretos desde configuracion externa, cifrar material sensible persistido, no incluirlo en imagenes y redactar `access_token`, `appid`, `secret`, claves y codigos en logs y errores.

#### Scenario: Error de integracion
- **WHEN** una llamada Ruijie falla y se registra diagnostico
- **THEN** el registro conserva contexto operativo sin credenciales, tokens ni codigos completos

### Requirement: Proteccion de codigos de bono
El sistema SHALL cifrar codigos en reposo, enmascararlos por defecto y revelar el valor completo solo a usuarios autorizados.

#### Scenario: Listado de bonos
- **WHEN** un usuario autorizado abre el historial
- **THEN** ve codigos enmascarados hasta solicitar una revelacion explicita

### Requirement: Auditoria inmutable
El sistema SHALL auditar autenticacion sensible, recargas, ajustes, reversos, precios, permisos, asignaciones, suspension, emision, conciliacion, revelacion de codigos e intentos de acceso cruzado con actor, tenant, accion, entidad, valores antes/despues, motivo, fecha, IP, sesion, ID de correlacion y resultado.

#### Scenario: Cambio de precio
- **WHEN** el Administrador modifica un precio
- **THEN** el sistema registra valores anterior y nuevo sin exponer secretos

### Requirement: Minimizacion de datos
El sistema no SHALL solicitar ni almacenar nombre, telefono o email del huesped; solo SHALL aceptar una referencia o alias opcional no sensible.

#### Scenario: Orden con alias
- **WHEN** el Revendedor agrega una referencia opcional
- **THEN** el sistema la vincula a la orden sin requerir datos personales del huesped

### Requirement: Controles de abuso
El sistema SHALL limitar intentos de autenticacion y operaciones sensibles, validar entradas en el backend y generar alertas ante patrones anormales.

#### Scenario: Intentos repetidos de acceso
- **WHEN** una cuenta supera el umbral configurado de intentos fallidos
- **THEN** el sistema limita temporalmente nuevos intentos y registra el evento

### Requirement: Metricas comerciales sin secretos
El panel administrativo SHALL mostrar agregados financieros y operativos sin exponer codigos de bonos, credenciales ni datos entre tenants. SHALL distinguir ventas emitidas, recargas recibidas y saldo pendiente de revendedores.

#### Scenario: Resumen administrativo
- **WHEN** el Administrador abre el panel
- **THEN** ve ventas emitidas, recargas, saldo circulante, volumen y gasto por revendedor con definiciones claras para el periodo mostrado
