# Spec Delta

## Purpose

Controla el acceso al panel y evita que administradores o revendedores operen fuera de los permisos y tenants autorizados.

## ADDED Requirements

### Requirement: Autenticacion y sesiones propias
El sistema SHALL autenticar usuarios con credenciales propias, crear sesiones seguras revocables y bloquear el acceso de usuarios o revendedores suspendidos.

#### Scenario: Inicio de sesion valido
- **WHEN** un usuario activo presenta credenciales validas
- **THEN** el sistema crea una sesion segura asociada a su usuario, rol y revendedor

#### Scenario: Revendedor suspendido
- **WHEN** un usuario perteneciente a un revendedor suspendido intenta iniciar o usar una sesion
- **THEN** el sistema rechaza el acceso y revoca sus sesiones activas

### Requirement: Roles del MVP
El sistema SHALL aplicar los roles Administrador y Revendedor en el backend; solo el Administrador SHALL gestionar revendedores, asignaciones, precios y saldo.

#### Scenario: Operacion administrativa denegada
- **WHEN** un Revendedor intenta acreditar saldo o cambiar precios
- **THEN** el sistema responde con acceso denegado sin modificar datos

### Requirement: Aislamiento de tenant
El sistema SHALL derivar el revendedor autorizado desde la sesion y SHALL rechazar referencias a recursos de otro revendedor antes de cualquier llamada a Ruijie.

#### Scenario: Acceso cruzado por site_id
- **WHEN** un Revendedor solicita un `site_id` no asignado a su tenant
- **THEN** el sistema responde 403, registra el intento y no llama a Ruijie
