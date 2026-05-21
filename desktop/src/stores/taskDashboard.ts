import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import type { Session } from './session'

export const useTaskDashboardStore = defineStore('taskDashboard', () => {
  const running = ref<Session[]>([])
  const recent = ref<Session[]>([])
  const loading = ref(false)

  async function fetchDashboard() {
    loading.value = true
    try {
      const { data } = await api.get('/sessions/dashboard')
      running.value = data?.running || []
      recent.value = data?.recent || []
    } catch {
      // Fallback: use regular session list
      try {
        const { data } = await api.get('/sessions')
        const all: Session[] = data || []
        running.value = all.filter((s: Session) => s.running)
        recent.value = all.filter((s: Session) => !s.running)
      } catch {
        // ignore
      }
    } finally {
      loading.value = false
    }
  }

  return {
    running,
    recent,
    loading,
    fetchDashboard
  }
})
