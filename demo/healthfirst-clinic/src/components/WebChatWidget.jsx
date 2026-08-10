import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { Icon } from '../icons.jsx'

// GoSumo backend connection. Configure via the demo's Vite env to point the
// widget at a running GoSumo API and a real Web Chat widget (channel account).
//   VITE_GOSUMO_API_URL   e.g. http://localhost:3000
//   VITE_GOSUMO_WIDGET_ID the channel_accounts UUID for this site's web widget
const GOSUMO_API_URL = import.meta.env.VITE_GOSUMO_API_URL || 'http://localhost:3000'
const GOSUMO_WIDGET_ID = import.meta.env.VITE_GOSUMO_WIDGET_ID || ''

const WELCOME = {
  from: 'bot',
  text: 'Hi there! 👋 I’m the HealthFirst AI assistant, powered by GoSumo. How can I help you today?',
}

const QUICK_REPLIES = [
  'Book an appointment',
  'View health packages',
  'Clinic timings',
  'Talk to a doctor',
]

// Simple keyword-based demo responses used as a local fallback when no live
// GoSumo backend response is delivered over the socket.
function botReply(text) {
  const q = text.toLowerCase()
  if (q.includes('book') || q.includes('appointment'))
    return 'I can help you book an appointment! 📅 You can pick a department, doctor and time using the booking form on this page. Would you like me to take you there?'
  if (q.includes('package') || q.includes('price') || q.includes('cost') || q.includes('₹'))
    return 'We offer 3 health packages: Basic Health Check (₹1,499), Comprehensive Care (₹3,999) and Senior Citizen Plus (₹5,999/year). All include lab tests and a doctor consult. Want details on any one?'
  if (q.includes('timing') || q.includes('time') || q.includes('open') || q.includes('hour'))
    return 'We’re open all 7 days from 8:00 AM to 10:00 PM, with 24×7 emergency care. 🏥'
  if (q.includes('doctor') || q.includes('specialist'))
    return 'Our specialists include Dr. Ananya Sharma (Cardiology), Dr. Rajesh Iyer (General Medicine), Dr. Priya Menon (Pediatrics) and Dr. Vikram Reddy (Orthopedics). Who would you like to consult?'
  if (q.includes('location') || q.includes('address') || q.includes('where'))
    return 'You’ll find us at HealthFirst Clinic, 24 MG Road, Indiranagar, Bengaluru 560038. There’s a map in the Contact section below. 📍'
  if (q.includes('report') || q.includes('result'))
    return 'Lab reports are usually ready the same day and are sent directly to your WhatsApp. You can also collect them at our front desk. 📄'
  if (q.includes('hi') || q.includes('hello') || q.includes('hey'))
    return 'Hello! 😊 I can help with appointments, health packages, doctor info and clinic timings. What would you like to know?'
  if (q.includes('thank'))
    return 'You’re most welcome! Wishing you good health. 💚 Is there anything else I can help with?'
  return 'Thanks for your message! A member of our care team will follow up shortly. Meanwhile, I can help you book an appointment, explore health packages, or share our clinic timings. 😊'
}

export default function WebChatWidget() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([WELCOME])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const [showQuick, setShowQuick] = useState(true)
  const scrollRef = useRef(null)
  const timers = useRef([])
  const socketRef = useRef(null)
  const sessionIdRef = useRef(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, typing, open])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  // Lazily connect to the GoSumo backend the first time the chat is opened, so a
  // real conversation and messages are created in the GoSumo dashboard. If the
  // backend is unreachable (or no widget id is configured) the widget still
  // works as a local-only demo.
  useEffect(() => {
    if (!open || socketRef.current) return

    let socket
    try {
      socket = io(`${GOSUMO_API_URL}/webchat`, {
        transports: ['websocket'],
        query: { widgetId: GOSUMO_WIDGET_ID },
      })
    } catch {
      return undefined
    }
    socketRef.current = socket

    socket.on('connect', () => {
      socket.emit(
        'chat:init',
        { widgetId: GOSUMO_WIDGET_ID, sessionId: sessionIdRef.current || undefined },
        (ack) => {
          if (ack && ack.sessionId) sessionIdRef.current = ack.sessionId
        },
      )
    })

    // Render assistant responses pushed from the backend (when AI/agent replies
    // are delivered over the socket).
    socket.on('chat:response', (msg) => {
      if (!msg || !msg.text) return
      setTyping(false)
      setMessages((m) => [...m, { from: 'bot', text: msg.text }])
    })

    return () => {
      socket.off()
      socket.disconnect()
      socketRef.current = null
    }
  }, [open])

  const send = (text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setShowQuick(false)
    setMessages((m) => [...m, { from: 'user', text: trimmed }])
    setInput('')
    setTyping(true)

    // Forward the message to GoSumo so it lands in the dashboard as a real
    // inbound message on a conversation.
    const socket = socketRef.current
    const sessionId = sessionIdRef.current
    if (socket && socket.connected && sessionId) {
      socket.emit('chat:message', { sessionId, text: trimmed })
    }

    // Local demo reply keeps the widget responsive even without a live backend.
    const t = setTimeout(() => {
      setTyping(false)
      setMessages((m) => [...m, { from: 'bot', text: botReply(trimmed) }])
    }, 900)
    timers.current.push(t)
  }

  return (
    <>
      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-24 right-4 z-50 flex w-[calc(100vw-2rem)] max-w-sm flex-col overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-slate-200 animate-slide-up sm:right-6">
          {/* Header */}
          <div className="flex items-center gap-3 bg-gradient-to-r from-brand-600 to-sky-600 px-5 py-4 text-white">
            <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-white/15">
              <Icon name="chat" className="h-6 w-6" />
              <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-brand-600 bg-emerald-400" />
            </span>
            <div className="flex-1">
              <p className="font-bold leading-tight">HealthFirst Assistant</p>
              <p className="text-xs text-white/80">Online · typically replies instantly</p>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-full p-1.5 transition hover:bg-white/15"
              aria-label="Close chat"
            >
              <Icon name="close" className="h-5 w-5" />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-4 py-4" style={{ maxHeight: '22rem' }}>
            {messages.map((m, i) => (
              <Bubble key={i} from={m.from} text={m.text} />
            ))}

            {typing && (
              <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-white px-4 py-3 shadow-sm ring-1 ring-slate-100 w-16">
                <Dot delay="0ms" />
                <Dot delay="150ms" />
                <Dot delay="300ms" />
              </div>
            )}

            {showQuick && (
              <div className="flex flex-wrap gap-2 pt-1">
                {QUICK_REPLIES.map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    className="rounded-full border border-brand-200 bg-white px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-600 hover:text-white"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              send(input)
            }}
            className="flex items-center gap-2 border-t border-slate-100 bg-white px-3 py-3"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your message…"
              className="flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm outline-none transition focus:border-brand-400 focus:bg-white focus:ring-2 focus:ring-brand-100"
            />
            <button
              type="submit"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-40"
              disabled={!input.trim()}
              aria-label="Send message"
            >
              <Icon name="send" className="h-5 w-5" />
            </button>
          </form>

          <div className="bg-white pb-3 text-center">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
              <span className="flex h-4 w-4 items-center justify-center rounded bg-gradient-to-br from-brand-500 to-sky-500 text-[8px] font-extrabold text-white">
                GS
              </span>
              Powered by GoSumo AI
            </span>
          </div>
        </div>
      )}

      {/* Floating button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-5 right-4 z-50 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-brand-600 to-sky-600 text-white shadow-xl shadow-brand-600/30 transition hover:scale-105 sm:right-6"
        aria-label={open ? 'Close chat' : 'Open chat'}
      >
        {!open && (
          <span className="absolute inset-0 rounded-full bg-brand-500 animate-pulse-ring" aria-hidden="true" />
        )}
        <span className="relative">
          <Icon name={open ? 'close' : 'chat'} className="h-7 w-7" />
        </span>
        {!open && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[11px] font-bold ring-2 ring-white">
            1
          </span>
        )}
      </button>
    </>
  )
}

function Bubble({ from, text }) {
  const isUser = from === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
          isUser
            ? 'rounded-br-md bg-brand-600 text-white'
            : 'rounded-bl-md bg-white text-slate-700 ring-1 ring-slate-100'
        }`}
      >
        {text}
      </div>
    </div>
  )
}

function Dot({ delay }) {
  return (
    <span
      className="h-2 w-2 animate-bounce rounded-full bg-slate-400"
      style={{ animationDelay: delay }}
    />
  )
}
