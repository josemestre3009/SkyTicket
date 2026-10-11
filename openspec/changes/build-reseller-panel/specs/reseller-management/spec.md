# Spec Delta

## Purpose

Gestiona revendedores, sitios y sus asignaciones autorizadas como base local del aislamiento comercial frente a Ruijie Cloud.

## ADDED Requirements

### Requirement: Alta con acceso asociado
El sistema SHALL crear el revendedor y al menos un usuario de acceso asociado en una unica transaccion, usando email unico y contraseña inicial de al menos 12 caracteres almacenada como hash seguro.

#### Scenario: Alta completa
- **WHEN** el Administrador registra nombre, email, contraseña inicial y umbral de saldo validos
- **THEN** el sistema crea el revendedor `active`, su monedero y su usuario asociado sin exponer la contraseña, permitiendo iniciar sesion inmediatamente

#### Scenario: Email duplicado
- **WHEN** el email ya pertenece a otro usuario
- **THEN** el sistema rechaza el alta y no deja un revendedor huerfano

### Requirement: Acceso para revendedores existentes
El Administrador SHALL poder crear usuarios asociados para un revendedor existente que no este cerrado.

#### Scenario: Revendedor legado sin usuario
- **WHEN** el Administrador registra email y contraseña inicial desde el detalle del revendedor
- **THEN** el sistema crea el usuario asociado sin modificar saldo, sitios ni historial

### Requirement: Ciclo de vida del revendedor
El sistema SHALL permitir al Administrador gestionar revendedores con moneda COP sin centavos en estados `pending`, `active`, `suspended`, `restricted` y `closed`. Solo `active` SHALL emitir; `restricted` SHALL entrar y consultar; `suspended` no SHALL iniciar sesion; `closed` SHALL quedar disponible solo como historial administrativo.

#### Scenario: Suspension de revendedor
- **WHEN** el Administrador suspende un revendedor
- **THEN** el sistema impide nuevas emisiones y conserva historial, saldo y auditoria

#### Scenario: Revendedor restringido
- **WHEN** un revendedor esta `restricted`
- **THEN** sus usuarios pueden consultar datos propios pero no emitir bonos

### Requirement: Eliminacion segura
El Administrador SHALL poder eliminar un revendedor del panel. La eliminacion SHALL cerrar y ocultar el revendedor, revocar sus sesiones y conservar ledger, ordenes, bonos y auditoria.

#### Scenario: Eliminar revendedor
- **WHEN** el Administrador confirma eliminar un revendedor
- **THEN** el revendedor desaparece del listado, pierde acceso inmediatamente y su historial financiero permanece intacto

### Requirement: Asignacion compartida de sitios
El sistema SHALL permitir asignar un sitio a varios revendedores y SHALL mantener cada asignacion como autorizacion independiente.

#### Scenario: Sitio compartido
- **WHEN** el Administrador asigna el mismo sitio a dos revendedores activos
- **THEN** ambos pueden consultar su catalogo autorizado sin acceder a ordenes, saldo o bonos del otro

### Requirement: Identificadores Ruijie controlados
El sistema SHALL resolver localmente cada sitio autorizado hacia region, conexion, tenant y `groupId`; el cliente nunca SHALL seleccionar libremente esos identificadores.

#### Scenario: Solicitud con groupId inyectado
- **WHEN** una solicitud de Revendedor incluye un `groupId` arbitrario
- **THEN** el sistema responde 403 y no llama a Ruijie
