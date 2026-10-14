# Plan: Delimitación de Usuarios e Inhabilitación por Proyecto

Fecha: 2026-10-14  
Estado: **Propuesta de Planificación — Para Revisión**

---

## 1. Diagnóstico del Problema Observado

### A. ¿Por qué en un proyecto nuevo aparecen usuarios de otros proyectos?
* Actualmente, la solapa **`Usuarios`** (`mainTab === 'USERS'`) consulta a todos los usuarios de la colección global `/users` (`listApprovedUsers()`) sin aplicar ningún filtro por el proyecto activo (`activeProjectId`).
* Como resultado, cuando un Superusuario o Administrador crea un nuevo proyecto ("Proyecto B") y entra a `Usuarios > Aprobados`, la pantalla le muestra la nómina completa de todos los proyectos históricos de la empresa ("Proyecto A", "Proyecto Antiguo", etc.), en lugar de mostrar una lista vacía como corresponde a un proyecto que recién nace y no tiene miembros asignados aún.

### B. ¿Por qué aparecen como "Inhabilitados"?
* La acción masiva de Superusuario *"Inhabilitar todos los activos"* ejecutó `disabled: true` de forma global en `/users/{uid}` para los usuarios que estaban aprobados en ese momento (pertenecientes al Proyecto A).
* Al abrir el Proyecto B, la pantalla sigue mostrando a esos mismos usuarios del Proyecto A y, lógicamente, todos lucen el badge rojo `Inhabilitado`.

---

## 2. Definición Conceptual: Sistema vs. Proyecto

Para resolver esto de forma limpia y escalable, separamos claramente los dos niveles:

```
┌────────────────────────────────────────────────────────────────────────┐
│ NIVEL SISTEMA (Global / Empresa)                                       │
│ • Identidad de la persona: Padrón de Fichas (/workers con DNI único)   │
│ • Cuenta de acceso: Email / Google Auth (/users/{uid})                 │
│ • Inhabilitación de Sistema (disabled: true): Bloqueo total de la app │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ asignación a
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ NIVEL PROYECTO (Contextual / Específico)                               │
│ • Aprobación en el proyecto: El usuario fue admitido en Proyecto X     │
│ • Asignación: Área y Rol dentro de Proyecto X                          │
│ • Inhabilitación en el proyecto: No puede cargar horas en Proyecto X,  │
│   pero su cuenta sigue viva y puede operar en Proyecto Y               │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Plan de Cambios Propuesto

### Fase 1: Filtro Contextual por Proyecto en la Solapa `Usuarios` (Inmediato)
1. **Filtrar `Aprobados` por `activeProjectId`:**
   * La lista `filteredApprovedUsers` solo mostrará usuarios cuyo `u.projectId === activeProjectId`.
   * **Resultado en proyecto nuevo:** Mostrará **0 usuarios** con un mensaje claro: *"Este proyecto aún no tiene usuarios asignados. Podés aprobar solicitudes pendientes o asignar trabajadores desde el Padrón de Fichas."*
2. **Vista Global para Superusuario:**
   * En la cabecera de `Usuarios > Aprobados`, el Superusuario dispondrá de un selector:
     * `[ Ver solo este proyecto (X usuarios) ]` (por defecto)
     * `[ Ver todos los proyectos de la empresa (Y usuarios) ]`

### Fase 2: Delimitación de las Acciones Masivas al Proyecto Activo
1. **Inhabilitación masiva acotada:**
   * El botón `🚫 Inhabilitar todos los activos` **solo afectará a los usuarios aprobados del proyecto activo actual** (`u.projectId === activeProjectId`).
   * No tocará usuarios de otros proyectos ni creará estados inconsistentes en proyectos nuevos.
2. **Aprobación acotada:**
   * Al aprobar un usuario en la solapa *Pendientes*, se le aprueba y asigna explícitamente al proyecto activo en ese momento.

### Fase 3: Separación Técnica de "Inhabilitación de Proyecto" vs "Inhabilitación de Sistema"
1. **Inhabilitación a nivel de Proyecto (`projectStatus` / `projectDisabled`):**
   * Cuando un administrador o superusuario desactiva a un usuario en un proyecto:
     * El usuario no puede registrar ni editar horas en ese proyecto.
     * En las auditorías y reportes de ese proyecto figura como *Desactivado / Inhabilitado en este proyecto*.
     * **Su cuenta de acceso sigue activa:** No se le bloquea el login a la aplicación (`App.tsx` no lo expulsa). Si el usuario tiene acceso a otro proyecto, puede seguir trabajando en él con total normalidad.
2. **Inhabilitación a nivel de Sistema (`user.disabled`):**
   * Se reserva exclusivamente como una acción extrema de Superusuario para desvincular a alguien de toda la plataforma (ej. expulsión de la empresa).

---

## 4. Matriz de Impacto

| Aspecto | Estado Actual | Con el Nuevo Plan |
| :--- | :--- | :--- |
| **Proyecto nuevo recién creado** | Muestra usuarios de proyectos viejos como inhabilitados | Muestra **0 usuarios** (lista limpia) |
| **Pestaña Aprobados** | Mezcla usuarios de toda la empresa | Muestra únicamente los miembros del proyecto actual |
| **Botón Inhabilitar todos** | Inhabilita a toda la base de datos | Inhabilita **solo a los miembros del proyecto actual** |
| **Efecto de inhabilitar en un proyecto** | El usuario no puede entrar a la app nunca más | El usuario no puede cargar horas en ese proyecto, pero su cuenta sigue activa |
| **Auditorías y liquidaciones** | Sin cambios | Sin cambios (100% preservadas) |

