import { ref } from 'vue'
import { useSessionStore } from '../stores/session'

/// <reference types="vite/client" />

type StreamMessageHandler = (msg: any) => void

let ws: WebSocket | null = null
const connected = ref(false)
const reconnectDelay = ref(1000)
const handlers = new Set<StreamMessageHandler>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastPongAt = 0
const PONG_TIMEOUT_MS = 15_000
let intentionalClose = false
let connectPromise: Promise<void> | null = null
let isReconnecting = false

function emitMessage(msg: any) {
  for (const handler of handlers) handler(msg)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  isReconnecting = true
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, reconnectDelay.value)
  reconnectDelay.value = Math.min(reconnectDelay.value * 2, 30_000)
}

function connect(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return Promise.resolve()
  }
  if (connectPromise) return connectPromise

  const baseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api'
  const wsBase = baseUrl.replace(/^http/, 'ws').replace(/\/api\/v1$/, '/api')
  const token = localStorage.getItem('token')
  if (!token) return Promise.reject(new Error('No token'))

  const sessionStore = useSessionStore()
  const url = `${wsBase}/ws/stream?token=${token}`
  ws = new WebSocket(url)
  intentionalClose = false

  let initialConnect = true

  connectPromise = new Promise<void>((resolve, reject) => {
    ws!.onopen = () => {
      connected.value = true
      reconnectDelay.value = 1000
      connectPromise = null
      initialConnect = false
      isReconnecting = false

      if (sessionStore.activeSessionId) {
        send({ type: 'subscribe', sessionId: Number(sessionStore.activeSessionId) })
      }

      lastPongAt = Date.now()
      heartbeatTimer = setInterval(() => {
        if (ws?.readyState !== WebSocket.OPEN) return
        if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
          ws.close()
          return
        }
        ws.send(JSON.stringify({ type: 'ping' }))
      }, 5_000)

      resolve()
    }

    ws!.onmessage = (event) => {
      let msg: any
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg?.type === 'pong') {
        lastPongAt = Date.now()
      }
      emitMessage(msg)
    }

    ws!.onclose = () => {
      connected.value = false
      stopHeartbeat()
      if (initialConnect && !isReconnecting) {
        initialConnect = false
        connectPromise = null
        reject(new Error('WebSocket connection failed'))
      } else if (!intentionalClose) {
        initialConnect = false
        connectPromise = null
        isReconnecting = false
        scheduleReconnect()
      }
    }

    ws!.onerror = () => {
      // onclose handles reject/reconnect.
    }
  })

  return connectPromise
}

function disconnect() {
  intentionalClose = true
  isReconnecting = false
  stopHeartbeat()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
  connected.value = false
}

function send(msg: any) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  } else {
    console.warn('[ws] send dropped (not open):', msg.type, 'readyState=' + ws?.readyState)
  }
}

function subscribe(sessionId: string | null) {
  if (sessionId) {
    send({ type: 'subscribe', sessionId: Number(sessionId) })
  }
}

function unsubscribe(sessionId: string | null) {
  if (sessionId) {
    send({ type: 'unsubscribe', sessionId: Number(sessionId) })
  }
}

function onMessage(handler: StreamMessageHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

function sendMessage(sessionId: string, content: string, eventId: string, images?: string[]) {
  send({
    type: 'send_message',
    sessionId: Number(sessionId),
    data: { content, eventId, images: images || [] }
  })
}

function sendEditMessage(sessionId: string, content: string, messageId: string, images?: string[]) {
  send({
    type: 'edit_and_resend',
    sessionId: Number(sessionId),
    messageId: Number(messageId),
    content,
    images: images || []
  })
}

function cancel(sessionId: string) {
  send({ type: 'cancel', sessionId: Number(sessionId) })
}

function enqueueMessage(sessionId: string, content: string, eventId: string, images: string[]) {
  send({ type: 'enqueue_message', sessionId: Number(sessionId), data: { content, eventId, images } })
}

function insertMessage(sessionId: string, queueId: string) {
  send({ type: 'insert_message', sessionId: Number(sessionId), data: { queueId } })
}

function deleteQueueMessage(sessionId: string, queueId: string) {
  send({ type: 'delete_queue_message', sessionId: Number(sessionId), data: { queueId } })
}

function reorderQueueMessage(sessionId: string, queueId: string, direction: string) {
  send({ type: 'reorder_queue_message', sessionId: Number(sessionId), data: { queueId, direction } })
}

export function useWsClient() {
  return {
    connected,
    connect,
    disconnect,
    send,
    subscribe,
    unsubscribe,
    onMessage,
    sendMessage,
    sendEditMessage,
    cancel,
    enqueueMessage,
    insertMessage,
    deleteQueueMessage,
    reorderQueueMessage
  }
}

