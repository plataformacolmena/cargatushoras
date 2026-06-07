# Plan de contingencia: cuota de lecturas Firestore (Spark)

Guardado el 2026-06-02. Estado: **propuesto, sin implementar**.

## Contexto
- 184 usuarios (180 MEMBER + 4 admin), informando jornadas a diario desde hace ~14 días.
- Spark plan: 50.000 lecturas/día. Almacenamiento NO es el cuello (~2.5k–3k docs en `time_entries`).
- Documentos por usuario: 1 en `users` + ~14 (creciendo) en `time_entries`.
- Listeners onSnapshot vivos tras última limpieza: solo 2 (`subscribeToProjects` y `subscribeToMaintenance` unificado en App).

## Mapa de lecturas por sesión MEMBER promedio
1. `upsertUserProfile` → 1 `getDoc(users/{uid})` por cada `onAuthStateChanged`. `src/auth/AuthContext.tsx#L56`.
2. `subscribeToProjects` → 1+ inicial; cada update en `projects` re-emite a TODOS los clientes. `src/services/firestore.ts#L1381` consumido en `src/pages/DashboardPage.tsx#L416`.
3. `subscribeToMaintenance` → 1 por sesión + 1 por toggle. `src/App.tsx#L23`.
4. Cambio de proyecto activo → en paralelo `listProjectAreas` + `getProjectConfig` + `listProjectRoles` + `listSettlements` (~10–40 lecturas). `src/pages/DashboardPage.tsx#L504-L535`.
5. Botón "Refrescar" → `listAllTimeEntries` 90 días filtrado por userId o areaId. Por área: `usuariosArea × días` (400–1000+).
6. Save/edit/delete jornada → `getProjectConfig` + `scheduleRecalculateUserEntries` (debounce 7s) que lee `listMyTimeEntries` 90d + `getProjectConfig` + `getDoc(user)` (~14–90).

## Hotspots admin (4 usuarios pero pesados)
1. `loadUsersPanels` se autodispara al montar admin: `listApprovedUsers` + `listPendingUsers` + `listImportedPlaceholders` ≈ 184–550 lecturas. `src/pages/DashboardPage.tsx#L549-L557`.
2. Estadísticas de horas: `listAllTimeEntries` por rango (~2.500 lecturas/click en 14 días). `src/pages/DashboardPage.tsx#L598`.
3. `listUsersWithoutEntries` = `listProjectUsers` (184) + `listAllTimeEntries` rango. `src/services/firestore.ts#L1833`.
4. `createSettlement` / `archiveSettlement` / `recalcEntries` cargan rango completo cada vez.
5. `listAllProjects` (sin filtro de activos) al entrar a Gestión. `src/services/firestore.ts#L457`.
6. `querySystemLogs` por rango: 1 lectura por log.

## Estimación gruesa diaria
| Actor | Acciones | Lecturas |
|---|---|---|
| 180 MEMBER | login + 1 jornada + 1 refresh + nav proyecto | ~13.800 |
| 4 admin (uso liviano) | sesión + 2 refrescos paneles + stats chicas | ~17.200 |
| 4 admin (uso intensivo) | rangos amplios, auditoría, liquidaciones | 30k–60k solo admins |

Hoy cerca de 30k–35k/día con uso moderado. Crecerá x2–x3 al llegar a 60–90 días de historial.

## Plan priorizado

### Tier 1 — Ahorro grande, cambio chico (atacar primero)
1. **Reducir ventana 90 → 30 días** en MEMBER y `recalculateUserEntries`. Parametrizar por `projectConfig.streakWindowDays`.
   - Archivos: `src/services/firestore.ts#L797`, `src/pages/DashboardPage.tsx#L424`.
   - Ahorro: ~66% por save/edit y por refresh MEMBER. Riesgo bajo.
2. **Refrescar MEMBER por userId, no por areaId.** Vista por área queda solo para admin.
   - Archivo: `src/pages/DashboardPage.tsx#L444-L451`.
   - Ahorro: factor `usuariosArea` (x20–x40 por área).
3. **Cache sessionStorage de datos cuasi-estáticos por proyecto** (`areas`, `roles`, `projectConfig`, `settlements`) con TTL 5–10 min.
   - Ahorro: 10–40 lecturas por navegación × 180 sesiones = 2k–7k/día. Riesgo bajo (ya existe precedente con `workCyclesCacheByProject`).
4. **Lazy `loadUsersPanels`**: solo al entrar a la pestaña Aprobaciones/Usuarios, no al montar.
   - Archivo: `src/pages/DashboardPage.tsx#L560-L562`.
   - Ahorro: ~550 lecturas/navegación admin × varias veces.
5. **Reemplazar `listAllProjects`** por filtrado en cliente sobre el snapshot ya en memoria (o cache + getDocs separado para inactivos).

### Tier 2 — Cambios medianos, ahorro estructural
6. **Mover `recalculateUserEntries` a Cloud Function** (`onCreate/onUpdate/onDelete` de `time_entries`) con debounce server-side. Lecturas no facturadas al MEMBER y agrupadas por usuario. Requiere Blaze (queda dentro del free tier de funciones).
7. **Precomputar agregados** semanales por usuario/área (`stats/{projectId}/{yyyy-ww}/{userId}`) escritos por CF o por el save. Estadísticas y "sin informar" pasan a leer agregados. Corta 1–2 órdenes de magnitud en consultas admin.
8. **`listUsersWithoutEntries` por agregados** o `getCountFromServer` por usuario/rango (1 lectura facturada por usuario) en lugar de bajar entries crudos.
9. **`querySystemLogs` con default 1 día y paginación obligatoria.**

### Tier 3 — Política y monitoreo (cero código)
10. **Habilitar persistencia offline (IndexedDB)** en `firebase.ts`. Mitiga relecturas en revisitas. Cuidado en mobile/extensiones.
11. **Alertas de cuota en GCP/Firebase Console** a 60% y 85% diaria. Spark no permite cuotas duras pero da margen.
12. **Política operativa admin**: evitar consultas de rango >30 días en horario de carga de MEMBER.

### Red de seguridad: Blaze
- Si Tier 1+2 no alcanza tras crecer historial, Blaze es ~gratis para este volumen (~US$0.06/100k extra). Permite presupuestos y alertas con corte. NO activar antes de Tier 1; la causa es operacional.

## Orden de ataque recomendado
1. Tier 1, items 1 + 2 + 4 → 40–60% de ahorro inmediato sin tocar arquitectura.
2. En paralelo: persistencia offline (3.10) + alertas de cuota (3.11).
3. Si en 1 semana sigue >70% de cuota: agregar item 3 (cache por proyecto) y planear Tier 2 (Cloud Functions + agregados).

## Próximo paso al retomar
Confirmar qué items del Tier 1 se aprueban e iniciar plan ejecutable de implementación.

---

## Estado al 2026-06-07 (revisión)

### Aplicado desde el plan original
- ✅ Tier 1.4 — Lazy `loadUsersPanels` (carga solo al entrar a Users).
- ✅ Tier 3.10 (parcial) — listeners onSnapshot minimizados a 2.
- ✅ Cleanup adicional fuera del plan: borrado de entries archivadas (`archiveSettlement` borra entries del rango). Reduce base de `time_entries` activos a la ventana entre archivos.
- ✅ Hardening parcial: `reminders.read` cerrado a admin/dueño. `time_entries.read`/`settlements.read` mantenidos abiertos por decisión funcional.

### Rechazado / no aplicado
- ❌ Tier 1.2 — Refresh MEMBER por userId: rechazado, MEMBER necesita ver su área.

### Pendientes evaluados pero pospuestos
- ⏸ Tier 1.1 — Ventana 90 → 30 días: pendiente. Sigue en 90.
- ⏸ Tier 1.3 — Cache sessionStorage por proyecto (`areas`/`roles`/`projectConfig`/`settlements`): **revisado el 2026-06-07, decisión = pospuesto** ("en este momento no veo utilidad"). Volver a evaluar si la cuota se aprieta.
- ⏸ Tier 1.5 — Reemplazar `listAllProjects` con cache + filtrado: **pospuesto junto con 1.3**. Ahorro estimado <100 reads/día por sí solo.
- ⏸ Tier 2.6 — Cloud Function recalc: **obsoleto si se aplica plan-calc-cliente**. No retomar a menos que ese plan se descarte.
- ⏸ Tier 2.7-2.8 — Agregados precomputados: parcialmente cubierto por `settlement.lines` enriquecidas (daysWorked, areaId, areaName) ya implementado.
- ⏸ Tier 3.10 — Persistencia offline IndexedDB en `firebase.ts`: 1 línea de código, ahorro real, sin urgencia.
- ⏸ Tier 3.11 — Alertas de cuota en Console: cero código, configurar cuando convenga.

### Plan paralelo más relevante
Refactor para no persistir `calculation` en `time_entries` (calc en cliente). Ahorra ~5000-10000 writes/día (~25-50% del cupo Spark). **Prioridad recomendada > Tier 1.3 + 1.5** porque ataca el hotspot real (recalc tras cada save). Plan vivo en memoria de sesión hasta que se promueva.

### Detalle de Tier 1.3 y 1.5 (referencia rápida al retomar)

**Tier 1.3 — wrapper `cachedFetch` con sessionStorage**
- Colecciones candidatas con TTL sugerido:
  - `project_areas`: 10 min
  - `project_roles`: 10 min
  - `project_configs/{projectId}`: 5 min
  - `settlements` (lista): 2 min
- Invalidar manualmente al crear/editar/borrar.
- Ahorro estimado: 2k-10k reads/día.
- Implementación: `src/lib/cache.ts` nuevo + aplicar en getters + invalidar en handlers de admin.

**Tier 1.5 — `listAllProjects`**
- Opción A: cache 5 min con el wrapper del 1.3.
- Opción B: combinar snapshot de `subscribeToProjects` (activos) + getDocs separado para inactivos en pantalla "Gestión".
- Ahorro: <100 reads/día. Solo vate como yapa del 1.3.