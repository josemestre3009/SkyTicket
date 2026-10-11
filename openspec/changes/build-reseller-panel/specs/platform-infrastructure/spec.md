# Spec Delta

## Purpose

Define un entorno local reproducible y persistente que ejecuta la aplicacion, PostgreSQL, migraciones y trabajos asincronos sin instalar servicios en el host.

## ADDED Requirements

### Requirement: Inicio completo con Docker Compose
El entorno SHALL iniciar aplicacion web/API, PostgreSQL persistente, migraciones controladas y worker mediante `docker compose up --build`.

#### Scenario: Primer inicio local
- **WHEN** existe una configuracion `.env` valida y se ejecuta `docker compose up --build`
- **THEN** la base se inicializa, las migraciones terminan y la aplicacion y worker quedan operativos

### Requirement: Dependencias saludables
PostgreSQL y la aplicacion SHALL publicar healthchecks; migraciones y servicios dependientes SHALL esperar a PostgreSQL saludable antes de iniciar trabajo.

#### Scenario: PostgreSQL aun no disponible
- **WHEN** el contenedor de PostgreSQL todavia no esta saludable
- **THEN** migraciones, aplicacion y worker no procesan solicitudes ni jobs prematuramente

### Requirement: Persistencia y puertos minimos
PostgreSQL SHALL usar un volumen nombrado y Compose SHALL exponer al host unicamente los puertos necesarios para acceder a la aplicacion.

#### Scenario: Recreacion de contenedores
- **WHEN** se eliminan y recrean contenedores sin borrar el volumen nombrado
- **THEN** los datos PostgreSQL permanecen disponibles

### Requirement: Configuracion externa
Los contenedores SHALL leer configuracion desde `.env`; las imagenes no SHALL contener secretos y `.env.example` SHALL documentar variables sin credenciales privadas.

#### Scenario: Inspeccion de imagen
- **WHEN** se construye una imagen usando la configuracion documentada
- **THEN** ninguna credencial del `.env` queda incorporada en sus capas o archivos

### Requirement: Operacion inicial documentada
El proyecto SHALL documentar comandos para migrar y crear el Administrador inicial de forma idempotente.

#### Scenario: Bootstrap repetido
- **WHEN** se ejecuta dos veces el comando de creacion con el mismo `ADMIN_EMAIL`
- **THEN** existe un solo Administrador y la repeticion informa el estado sin duplicarlo

### Requirement: Infraestructura minima
El entorno no SHALL incluir Redis ni servicios auxiliares sin una necesidad concreta aprobada.

#### Scenario: Despliegue del MVP
- **WHEN** se inspecciona la topologia Compose
- **THEN** la coordinacion de jobs utiliza PostgreSQL y no existe un servicio Redis
