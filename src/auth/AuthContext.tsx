/* eslint-disable react-refresh/only-export-components */

import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth'
import { createContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { auth } from '../firebase'
import { getUserProfile, upsertUserProfile } from '../services/firestore'
import type { UserProfile } from '../types/domain'

interface AuthContextValue {
  user: User | null
  profile: UserProfile | null
  loading: boolean
  signInWithGoogle: () => Promise<void>
  signInWithEmail: (email: string, password: string) => Promise<void>
  signUpWithEmail: (email: string, password: string) => Promise<void>
  signOutUser: () => Promise<void>
  reloadProfile: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser)

      if (!firebaseUser) {
        setProfile(null)
        setLoading(false)
        return
      }

      try {
        const p = await upsertUserProfile({
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName,
        })
        setProfile(p)
      } catch (err) {
        console.error('[AuthContext] upsertUserProfile error:', err)
        // Intentar cargar el perfil si ya fue creado parcialmente
        const fallback = await getUserProfile(firebaseUser.uid).catch(() => null)
        setProfile(fallback)
      } finally {
        setLoading(false)
      }
    })

    return unsubscribe
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      profile,
      loading,
      async signInWithGoogle() {
        await signInWithPopup(auth, new GoogleAuthProvider())
      },
      async signInWithEmail(email: string, password: string) {
        await signInWithEmailAndPassword(auth, email, password)
      },
      async signUpWithEmail(email: string, password: string) {
        try {
          await createUserWithEmailAndPassword(auth, email, password)
        } catch (err) {
          // Si ya existe una cuenta de Auth con ese mail (p. ej. usuario importado
          // que ya tenía Auth creado, o intento previo), intentamos iniciar sesión
          // con la misma contraseña. Esto cubre el caso típico de usuarios
          // importados que recibieron credenciales y eligen "Registrarme".
          const code = (err as { code?: string })?.code
          if (code === 'auth/email-already-in-use') {
            await signInWithEmailAndPassword(auth, email, password)
            return
          }
          throw err
        }
      },
      async signOutUser() {
        await signOut(auth)
      },
      async reloadProfile() {
        if (!user) {
          return
        }
        const next = await getUserProfile(user.uid)
        setProfile(next)
      },
    }),
    [loading, profile, user],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

