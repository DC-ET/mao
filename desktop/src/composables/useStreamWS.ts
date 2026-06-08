import { reduceStreamEvent } from './streamReducer'
import { registerApprovalListeners, registerSkillSyncListener } from './useLocalToolBridge'
import { useWsClient } from './useWsClient'

let reducerRegistered = false

export function useStreamWS() {
  const wsClient = useWsClient()

  if (!reducerRegistered) {
    reducerRegistered = true
    wsClient.onMessage((msg) => reduceStreamEvent(msg, wsClient.send))
    registerSkillSyncListener(wsClient.send)
    registerApprovalListeners()
  }

  return wsClient
}

