# Carga Tus Horas

App web mobile-first para carga de horarios laborales por proyecto, con autenticacion Firebase, aprobacion de miembros y calculo local de horas extra/adicionales (sin Cloud Functions).

## Stack

- React + TypeScript + Vite
- Firebase Auth (Google y mail/clave)
- Firestore (Spark)

## Configuracion

1. Instalar dependencias:

```bash
npm install --cache .npm-cache-local
```

2. Crear variables de entorno (ya se dejo un `.env.example`):

```bash
cp .env.example .env
```

3. Completar credenciales Firebase en `.env`.

4. Levantar entorno local:

```bash
npm run dev
```

## Estado actual por fases

### Fase 1 - Base tecnica y seguridad

- Auth Google + mail/clave.
- Perfil de usuario en `users`.
- Roles base: `SUPERUSER`, `PROJECT_ADMIN`, `MEMBER`.
- Estado de aprobacion: `PENDING` / `APPROVED`.
- Pantalla `Espera a ser aceptado`.
- Reglas Firestore iniciales en `firestore.rules`.

### Fase 2 - Gestion organizativa (base)

- Listado de pendientes para admins.
- Aprobacion de miembros.
- CRUD basico de areas por proyecto.

## Deploy rapido

```bash
npm run deploy
```

Solo hosting:

```bash
npm run deploy:hosting
```

### Fase 3 - Carga de horarios (mobile-first inicial)

- Form: fecha/jornada, hora in, hora out, observaciones.
- Guardado de entradas en `time_entries`.
- Tabla movil de horarios cargados del usuario.

### Fase 4 - Calculo local (alternativa sin CF)

- Calculo de horas trabajadas, extras y nocturnas en cliente.
- Persistencia de `calculationSource = client` y `calculationVersion = v1-client`.

## Proximos pasos sugeridos

- Completar CRUD de proyectos (superuser).
- Configuracion de proyecto editable desde UI.
- Auditoria extendida con exportacion Excel.
- Creacion de liquidaciones filtradas por fechas/jornadas.
- Endurecer reglas para evitar escrituras fuera de esquema.
