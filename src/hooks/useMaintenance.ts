import { createContext, useContext } from 'react'
import type { MaintenanceState } from '../services/firestore'

export const MaintenanceContext = createContext<MaintenanceState>({
  enabled: false,
  message: null,
  version: 0,
})

export function useMaintenance(): MaintenanceState {
  return useContext(MaintenanceContext)
}
