import { useEffect, useRef, useCallback } from 'react'
import type { WSEvent } from '../types'

interface UseWebSocketOptions {
  onEvent: (event: WSEvent) => void
}

export function useWebSocket({ onEvent }: UseWebSocketOptions) {
  const ws = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const backoff = useRef(1000)
  const unmounted = useRef(false)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  const connect = useCallback(() => {
    if (unmounted.current) return
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${location.host}/ws`
    const socket = new WebSocket(url)
    ws.current = socket

    socket.onopen = () => {
      backoff.current = 1000
    }

    socket.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as WSEvent
        onEventRef.current(data)
      } catch {
        // ignore malformed frames
      }
    }

    socket.onclose = () => {
      if (unmounted.current) return
      reconnectTimer.current = setTimeout(() => {
        backoff.current = Math.min(backoff.current * 2, 30000)
        connect()
      }, backoff.current)
    }

    socket.onerror = () => {
      socket.close()
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      unmounted.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      ws.current?.close()
    }
  }, [connect])
}
