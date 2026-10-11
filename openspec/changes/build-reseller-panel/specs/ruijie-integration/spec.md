# Spec Delta

## Purpose

Encapsula la OpenAPI publica de Ruijie Cloud con autenticacion segura, contratos defensivos y sincronizacion tolerante a inconsistencias documentales.

## ADDED Requirements

### Requirement: Integracion solo desde backend
El sistema SHALL usar exclusivamente la OpenAPI publica Ruijie aprobada por HTTPS desde backend, no SHALL usar `/webproxy/common/api`, y no SHALL exponer credenciales, tokens ni `groupId` libres al navegador.

#### Scenario: Operacion del navegador
- **WHEN** el panel necesita datos o emitir bonos
- **THEN** llama al backend SkyTicket y nunca directamente a Ruijie

### Requirement: Gestion de token
El sistema SHALL reutilizar un token por cuenta y region, tratar el token constante del manual como distinto del `access_token`, y ante codigos 3 o 4 SHALL renovar y repetir como maximo una vez cuando sea seguro.

#### Scenario: Token expirado en consulta
- **WHEN** una consulta devuelve codigo 4
- **THEN** el sistema renueva el token y repite la consulta una sola vez

### Requirement: Normalizacion defensiva
El sistema SHALL conservar respuestas crudas y normalizar campos variables, incluyendo `authProfileId` como string, `expiryTime` string, numero o null, y aliases `codeNo`/`voucherCode`, `comment`/`nameRef` y `limitClients`/`maxClients`.

#### Scenario: Identificador largo
- **WHEN** Ruijie devuelve un `authProfileId` decimal de 32 digitos
- **THEN** el sistema lo conserva exactamente como string sin perdida de precision

### Requirement: Politica de reintentos
El sistema SHALL limitar consultas idempotentes a tres intentos con backoff y jitter, respetar `Retry-After` en HTTP 429 y no reintentar automaticamente errores no recuperables.

#### Scenario: Rate limit
- **WHEN** Ruijie responde HTTP 429 con `Retry-After`
- **THEN** el sistema pospone el siguiente intento al menos el intervalo indicado

### Requirement: Sincronizacion por polling
El sistema SHALL sincronizar redes, paquetes y bonos mediante polling idempotente, con paginacion completa y sin depender de webhooks no documentados.

#### Scenario: Pagina final
- **WHEN** `getList` devuelve una pagina parcial no vacia y el offset sigue por debajo de `count`
- **THEN** el sistema avanza por la cantidad realmente recibida y solicita la siguiente pagina

#### Scenario: Lista vacia o count agotado
- **WHEN** `getList` devuelve una lista vacia o el offset alcanza `count`
- **THEN** el sistema finaliza esa corrida sin duplicar registros por UUID

### Requirement: Inventario remoto de solo lectura
El Administrador SHALL poder sincronizar sitios desde el arbol Ruijie y consultar por sitio los bonos remotos con codigo enmascarado y estados `unused`, `in_use`, `expired` o `unknown`, sin crear bonos ni atribuir bonos externos a un revendedor.

#### Scenario: Consulta de bonos existentes
- **WHEN** el Administrador selecciona un sitio sincronizado
- **THEN** el sistema pagina `getList`, muestra resumen y estados normalizados, y nunca expone codigos completos

### Requirement: Degradacion ante indisponibilidad
El sistema SHALL abrir temporalmente el circuito tras fallos repetidos de Ruijie, evitar tormentas de reintentos, mantener consultas locales y mostrar que la emision no esta disponible.

#### Scenario: Circuito abierto
- **WHEN** la integracion supera el umbral configurado de fallos recuperables
- **THEN** nuevas emisiones fallan antes de reservar saldo mientras historial y datos locales siguen disponibles
