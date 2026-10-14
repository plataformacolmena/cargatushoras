# Plan: Acciones Masivas y Padrón Transversal de Fichas (Exclusivo Superusuario)

Fecha: 2026-10-14  
Estado: **Planificado - Pendiente de aprobación/ejecución**

---

## 1. Alcance y Requisitos: Acciones Masivas

1. **Inhabilitar todos los usuarios aprobados:**
   * Ubicación: Pestaña `Usuarios` > Sector `Usuarios aprobados`.
   * Permisos: **Exclusivo SUPERUSER** (`currentProfile.role === 'SUPERUSER'`).
   * Acción: Aplica `disabled: true` en bloque a los usuarios aprobados activos.
   * Reglas de exclusión:
     - **Nunca inhabilitar la cuenta del actor** (`u.uid !== profile.uid`).
     - **Nunca inhabilitar a otros Superusuarios** (`u.role !== 'SUPERUSER'`).
     - **Omitir los que ya están inhabilitados** (`!u.disabled`).
   * Integridad: **Ningún registro de jornada se pierde ni se modifica.**

2. **Eliminar todos los usuarios pendientes:**
   * Ubicación: Pestaña `Usuarios` > Sector `Usuarios pendientes de aprobación`.
   * Permisos: **Exclusivo SUPERUSER** (`currentProfile.role === 'SUPERUSER'`).
   * Acción: Borrado físico en Firestore de los documentos en `users/{uid}` con `approvalStatus === 'PENDING'`.
   * Integridad: Los usuarios pendientes no tienen jornadas informadas (las reglas exigen estar aprobado para cargar horas).

---

## 2. Diseño Técnico: Acciones Masivas

### A. Servicios en `src/services/firestore.ts`

```ts
/**
 * Inhabilita masivamente a todos los usuarios aprobados activos,
 * excluyendo al actor y a cualquier SUPERUSER.
 */
export async function disableAllApprovedUsers(
  actor: { uid: string; displayName: string; email?: string | null },
  targetUids: string[],
): Promise<{ disabledCount: number }>

/**
 * Elimina masivamente a los usuarios en estado PENDING.
 * Exclusivo para SUPERUSER.
 */
export async function deleteAllPendingUsers(
  actor: { uid: string; displayName: string; email?: string | null },
  pendingUids: string[],
): Promise<{ deletedCount: number }>
```

* Las escrituras y borrados se ejecutarán en lotes atómicos (`writeBatch(db)`) de hasta 400 documentos por batch.
* Se registrarán eventos de auditoría en `system_logs` (`admin_bulk_disable_users` y `admin_bulk_delete_pending`).

### B. Interfaz de Usuario en `src/pages/DashboardPage.tsx`

1. **Sector Aprobados:**
   * Botón visible únicamente si `canSeeProjectAdmin(currentProfile.role)`:
     `🚫 Inhabilitar todos los activos`
   * Confirmación explícita con conteo exacto de usuarios a inhabilitar.
   * Estado de progreso (`Spinner` y botón deshabilitado).
   * Refresco automático (`loadUsersPanels()`).

2. **Sector Pendientes:**
   * En la cabecera de "Usuarios pendientes de aprobación":
     `🗑️ Eliminar todos los pendientes (X)`
   * Habilitado únicamente si `pendingUsers.length > 0`.
   * Confirmación `window.confirm`: acción destructiva irreversible.
   * Refresco automático.

---

## 3. Padrón Transversal de Fichas (Exclusivo Superusuario)

### A. Principio de No Injerencia y Compatibilidad Total
1. **No altera la planificación previa:** Las acciones masivas de inhabilitación y eliminación siguen operando sobre la colección `/users` sin ninguna modificación.
2. **No modifica el criterio de aprobación de los administradores:**
   * Los `PROJECT_ADMIN` seguirán aprobando y asignando área/rol a sus proyectos de la misma manera en `[ Pendientes ]` y `[ Aprobados ]`.
   * Los administradores no verán la pestaña de Fichas.
3. **No altera las jornadas (`time_entries`):**
   * Las horas trabajadas, auditorías, tarifas y liquidaciones existentes permanecen 100% intactas.

### B. Estructura de la Colección `/workers` en Firestore

Documento: `/workers/{workerId}` donde `workerId` es determinístico por DNI: `worker_${normalizedDni}`.

```ts
export interface WorkerProfile {
  id: string                     // worker_12345678
  idNumber: string               // DNI / Cédula normalizada (clave natural única)
  displayName: string            // Nombre y apellido oficial
  email: string | null           // Email principal
  phone?: string | null          // Teléfono de contacto
  authUid?: string | null        // UID de Google Auth cuando el usuario inicie sesión
  knownUids: string[]            // Array de UIDs históricos vinculados a este trabajador
  status: 'ACTIVE' | 'INACTIVE'  // Estado general en la empresa
  currentAssignment?: {
    projectId: string
    projectName?: string
    areaId?: string
    areaName?: string
    roleId?: string
    roleName?: string
  } | null
  createdAt?: unknown
  updatedAt?: unknown
}
```

### C. Nueva Sub-pestaña en Usuarios (Exclusiva Superuser)

En la barra de navegación de `Usuarios`:
`[ Pendientes ]` `[ Aprobados ]` `[ 📇 Padrón de Fichas (Superuser) ]`

Contenido de la pestaña:
1. **Buscador y Tabla del Padrón:**
   * Columnas: DNI, Nombre, Email, Proyecto/Área actual, Estado, UIDs vinculados.
2. **Herramienta de Normalización Automática desde el Historial:**
   * **Paso 1: Analizar usuarios existentes:**
     - Agrupa usuarios de `/users` por DNI y email.
     - Detecta cuáles tienen DNI listo para convertirse en Ficha y cuáles requieren completar DNI.
   * **Paso 2: Generar Padrón:**
     - Crea las fichas maestras en `/workers` mapeando los `knownUids` con los que se cargaron sus jornadas históricas.
3. **Alta y Edición de Fichas:**
   * Permite al Superusuario registrar fichas de nuevos trabajadores o cambiar asignaciones de proyecto de forma transversal a toda la empresa.

---

## 4. Reglas de Firestore para `/workers`

```rules
match /workers/{workerId} {
  // Lectura para cualquier usuario aprobado del sistema
  allow read: if isApproved();
  // Creación, edición y borrado exclusivo para SUPERUSER
  allow write: if isSuperUser();
}
```

---

## 5. Estrategia de Ejecución Secuencial

1. **Paso 1 (Inmediato):** Implementar los dos botones de Superusuario en Aprobados y Pendientes (Secciones 1 y 2).
2. **Paso 2:** Crear el tipo `WorkerProfile`, las reglas en `firestore.rules` y los servicios en `firestore.ts` (Sección 3).
3. **Paso 3:** Incorporar la sub-pestaña `[ 📇 Padrón de Fichas ]` en `DashboardPage.tsx` con el asistente de escaneo/normalización previa.
