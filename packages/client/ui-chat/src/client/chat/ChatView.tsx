// An enclosing `[data-conversation-scroll]` owns scrolling when present;
// otherwise this view owns it. Each row subscribes to one stable node key.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import type {
  ConversationTimelineSnapshot, RenderMessageImages,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { Button, IconChevronDownOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { TurnNavigator } from './TurnNavigator.tsx'
import { mergeTurnRailItems, type TurnRailItem } from './turn-rail-items.ts'
import { formatRunDuration } from './message-chrome.ts'
import css from './ChatView.module.css'

const FOLLOW_THRESHOLD = 24
const CHAT_VIRTUALIZATION_THRESHOLD = 100
const CHAT_VIRTUAL_OVERSCAN_ROWS = 12
const CHAT_VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX = 600
const CHAT_VIRTUAL_ESTIMATED_ROW_HEIGHT_PX = 160
const CHAT_VIRTUAL_LIVE_TAIL_ROWS = 3
const CHAT_SCROLL_RESTORE_TOLERANCE_PX = 1
const SCROLL_SAMPLE_INTERVAL_MS = 500

/** Active column host when present; otherwise the view-local scroller. */
function scrollerOf(from: HTMLElement): HTMLElement {
  return (from.closest('[data-conversation-scroll]')) ?? from
}

interface PagingAnchor {
  /** Stable node/call identity, independent of boundary-spanning group keys. */
  key: string
  /** Row top relative to the scrollport after the latest user scroll. */
  top: number
}

/** Find an already-rendered row without interpolating a selector. */
function anchorElement(list: HTMLElement, key: string): HTMLElement | null {
  for (const row of list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]:not([hidden])')) {
    if (row.dataset.chatAnchorKey === key) return row
  }
  return null
}

/**
 * Turn owning the row at a scrollport line. Scroll frames are hot, so this
 * hit-tests the line first and falls back to one row scan when layout cannot
 * answer (jsdom, pre-paint); neither path queries per navigation item.
 * @param list - the ChatView list element.
 * @param line - viewport y of the reading line.
 * @returns the Turn number, or null when no loaded row covers the line.
 */
function turnAtLine(list: HTMLElement, line: number): number | null {
  const content = list.getBoundingClientRect()
  if (typeof document.elementsFromPoint === 'function' && content.width > 0) {
    for (const element of document.elementsFromPoint(content.left + content.width / 2, line)) {
      const row = element instanceof HTMLElement ? element.closest<HTMLElement>('[data-chat-turn]') : null
      const turn = Number(row?.dataset.chatTurn)
      if (row !== null && list.contains(row) && Number.isSafeInteger(turn)) return turn
    }
  }
  let found: number | null = null
  for (const row of list.querySelectorAll<HTMLElement>('[data-chat-turn]')) {
    if (row.getBoundingClientRect().top > line) break
    const turn = Number(row.dataset.chatTurn)
    if (Number.isSafeInteger(turn)) found = turn
  }
  return found
}

/** Row position in scrollport coordinates (viewport-independent). */
function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/** Select a visible stable node/call identity, falling back only when layout
 * has not exposed a visible box yet. */
function pagingAnchor(list: HTMLElement, scrollport: HTMLElement): HTMLElement | null {
  const viewport = scrollport.getBoundingClientRect()
  const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
  const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom
  // The leading edge preserves nested call identity when it hits a row.
  // Chrome/gap misses use logarithmic layout reads over the ordered flex rows.
  if (typeof document.elementsFromPoint === 'function' && visibleBottom > viewport.top) {
    const content = list.getBoundingClientRect()
    const left = Math.max(viewport.left, content.left)
    const right = Math.min(viewport.right, content.right)
    const x = left + Math.max(0, right - left) / 2
    for (const element of document.elementsFromPoint(x, viewport.top + 1)) {
      const row = element instanceof HTMLElement
        ? element.closest<HTMLElement>('[data-chat-anchor-key]')
        : null
      if (row !== null && list.contains(row)) return row
    }
  }
  const rows = list.querySelectorAll<HTMLElement>(
    '[data-chat-flow-key]:not(:empty):not([hidden])',
  )
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows.item(middle).getBoundingClientRect().bottom > viewport.top) high = middle
    else low = middle + 1
  }
  const row = rows[low]
  return row !== undefined && row.getBoundingClientRect().top < visibleBottom ? row : rows[0] ?? null
}

type ChatScrollPosition = NonNullable<ReturnType<ChatViewSlotProps['chatScroll']['read']>>

/** Capture a reflow-resistant reader position from the current rendered window. */
function scrollPosition(list: HTMLElement, scrollport: HTMLElement): ChatScrollPosition | null {
  const row = pagingAnchor(list, scrollport)
  const anchorKey = row?.dataset.chatAnchorKey
  if (row === null || anchorKey === undefined) return null
  return {
    anchorKey,
    anchorTop: flowTop(row, scrollport),
    scrollTop: scrollport.scrollTop,
  }
}

/** Host/OS refusal text for the file-open dialog; empty throws keep a locale fallback. */
function openFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === '' ? fallback : message
}

/** ProducedFiles opens the session workspace as `.`. */
function isFolderOpenPath(path: string): boolean {
  return path === '.'
}

/**
 * Prompt-RPC identities already rendered by durable material: user/steering
 * node sources plus queue occurrences. A submission echo whose identity
 * appears here is hidden in the same render, so the echo→durable swap is
 * atomic — no duplicate, no gap — regardless of when the echo leaves the
 * session snapshot.
 */
function observedRpcIds(
  order: readonly string[],
  nodes: ChatSnapshot['nodes'],
  queue: readonly { readonly rpcId?: string }[],
): ReadonlySet<string> {
  const observed = new Set<string>()
  for (const key of order) {
    const node = nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue
    const source = (node.data as { readonly source?: unknown }).source as
      | { readonly kind?: unknown; readonly rpcId?: unknown }
      | undefined
    if (source?.kind === 'user' && typeof source.rpcId === 'string') observed.add(source.rpcId)
  }
  for (const item of queue) {
    if (item.rpcId !== undefined) observed.add(item.rpcId)
  }
  return observed
}

function runningTurnStartTime(timeline: ConversationTimelineSnapshot): number | null {
  let latest: number | null = null
  for (const turn of timeline.turns.values()) {
    if (turn.status === 'open') latest = turn.start?.time ?? null
  }
  return latest
}

/** Turn-level model activity label retained across first-token, tool, and streaming phases. */
function TurnStatus({ startTime, t }: {
  /** The running turn's logged `turn/start` time; null falls back to mount
   *  time when that boundary is outside the window. */
  startTime: number | null
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}) {
  const [mountedAt] = useState(() => Date.now())
  // Anchored to turn/start so a mid-turn reload keeps the real
  // elapsed time and the final footer's Ran-for label matches this clock.
  const anchor = startTime ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => {
      setElapsedMs(Math.max(0, Date.now() - anchor))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [anchor])
  // Short turns keep the plain label; the clock only appears once the turn
  // has clearly been running for a while.
  const showClock = elapsedMs >= 15_000
  return (
    <div className={css.turnStatus} role="status" aria-live="polite">
      {t('chat.deepDiving')}
      {showClock && (
        <span className={css.turnStatusClock} aria-hidden>
          {formatRunDuration(elapsedMs, t)}
        </span>
      )}
    </div>
  )
}

type ChatNodeListProps = Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey'> & {
  readonly order: readonly string[]
}

const ChatNodeList = memo(function ChatNodeList({ order, ...seatProps }: ChatNodeListProps) {
  return order.map(nodeKey => (
    <ChatNodeSeat key={nodeKey} nodeKey={nodeKey} {...seatProps} />
  ))
})

/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
export function ChatView({
  useSession, useChat, useChatNode, useChatNodeProcess, useSessions, useStore, actions, renderSlot,
  sessionId, openFile, loadOlder, loadThrough, loadImage, openView, chatScroll, forkAt, fileMentions,
  useTranscriptView, useProjection, t,
}: ChatViewSlotProps) {
  const order = useChat(s => s.order)
  const nodeStore = useChat(s => s.nodes)
  // The rail's items are accumulated in the Chat snapshot, so this selector is
  // both the data and its change signal: the array identity moves only when a
  // Turn enters, leaves, or changes its preview.
  const turnNavigationItems = useChat(s => s.navigation.items())
  // Host-computed whole-log outline; the merge is view-layer only (the
  // conversation snapshot never carries projection values).
  const turnOutline = useProjection('turnOutline')
  const railItems = useMemo(
    () => mergeTurnRailItems(turnNavigationItems, turnOutline),
    [turnNavigationItems, turnOutline],
  )
  const timeline = useChat(s => s.timeline)
  const inbox = useSession(s => s.queue)
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const running = useSession(s => s.running)
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const selectedCallId = useStore(s => s.selection?.callId)
  const compactTranscript = useTranscriptView(mode => mode === 'compact')
  const inspectCall = useCallback((callId: string) => {
    openView('trajectory', callId)
  }, [openView])
  const [fileOpenError, setFileOpenError] = useState<{ path: string; message: string } | null>(null)
  const [fileOpenBusy, setFileOpenBusy] = useState(false)
  // Close/retry must ignore a settlement that started before the latest
  // gesture; otherwise a cancelled in-flight refusal reopens the dialog.
  const fileOpenRequest = useRef(0)

  const requestOpenFile = useCallback((path: string) => {
    const id = ++fileOpenRequest.current
    setFileOpenBusy(true)
    void openFile(path).then(
      () => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError(null)
        setFileOpenBusy(false)
      },
      (error: unknown) => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError({
          path,
          message: openFailureMessage(
            error,
            t(isFolderOpenPath(path) ? 'fileOpen.folderUnknown' : 'fileOpen.unknown'),
          ),
        })
        setFileOpenBusy(false)
      },
    )
  }, [openFile, t])

  const closeFileOpenError = useCallback(() => {
    fileOpenRequest.current += 1
    setFileOpenError(null)
    setFileOpenBusy(false)
  }, [])

  const pendingSteering = useMemo(
    () => inbox.filter(item => item.placement === 'steering'),
    [inbox],
  )
  const pendingSubmissions = useSession(s => s.pendingSubmissions)
  // Submission echoes still awaiting their durable counterpart. `order` is the
  // recompute trigger: durable user material always arrives as an append, and
  // every append replaces the order array.
  const visibleSubmissions = useMemo(() => {
    if (pendingSubmissions.length === 0) return pendingSubmissions
    const observed = observedRpcIds(order, nodeStore, inbox)
    return pendingSubmissions.filter(submission => (
      submission.placement !== 'queued' && !observed.has(submission.requestId)
    ))
  }, [pendingSubmissions, order, nodeStore, inbox])
  const renderMessageImages = useCallback<RenderMessageImages>(
    owner => renderSlot('conversation.message.images', { ...owner, loadImage }),
    [loadImage, renderSlot],
  )
  const runningTurnStart = useMemo(() => runningTurnStartTime(timeline), [timeline])

  const listRef = useRef<HTMLDivElement | null>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const [initialScrollPosition] = useState<ChatScrollPosition | null>(() => chatScroll.read())
  // A saved position starts disarmed; the first layout effect synchronously
  // restores it and normalizes a floor-clamped position back to following.
  const [atBottom, setAtBottom] = useState(() => initialScrollPosition === null)
  // Reflow changes row coordinates without changing the virtual range. This
  // epoch is only for an off-bottom view, so a pinned transcript does not pay
  // for a restore render on every ordinary composer resize.
  const [layoutEpoch, setLayoutEpoch] = useState(0)
  const layoutRestorePendingRef = useRef(false)
  const atBottomRef = useRef(atBottom)
  const scrollSamplePendingRef = useRef(false)
  const [, setScrollSampleTick] = useState(0)
  const [activeTurn, setActiveTurn] = useState<number | null>(
    () => turnNavigationItems.at(-1)?.turn ?? null,
  )
  /** Last position delivered or written on the main thread. */
  const observedTopRef = useRef(0)
  /** Paging anchor: semantic row/position at click, updated by reader scrolls
   * while the request is pending and restored after the prepend lands. */
  const anchorRef = useRef<PagingAnchor | null>(null)
  /** A virtual row can move again as newly mounted heights are measured. */
  const pendingPrependAnchorRef = useRef<PagingAnchor | null>(null)
  /** Keep a saved row mounted until a reader gesture releases authored scroll. */
  const restoreAnchorKeyRef = useRef(initialScrollPosition?.anchorKey ?? null)
  /** One automatic older-page request per newly exposed history boundary. */
  const restorePageRequestRef = useRef<{ key: string; firstSeq: number | null } | null>(null)
  /** Keep a navigation target mounted while an estimated scroll lands on it. */
  const navigationAnchorKeyRef = useRef<string | null>(null)
  /** Unloaded-turn jump in flight: target turn plus its load-through seq. */
  const pendingJumpRef = useRef<{ turn: number; seq: SessionSeq } | null>(null)
  /** Whether the in-flight jump already landed mid-paging (settle then only corrects an untouched landing). */
  const jumpLandedRef = useRef(false)
  const [busyJumpTurn, setBusyJumpTurn] = useState<number | null>(null)
  /** Bumped when a loadThrough completion settles, after its last page's commit. */
  const [jumpSettleTick, setJumpSettleTick] = useState(0)
  /** Window head at the last settle-time repage; an unmoved head falls back instead of repaging forever. */
  const jumpRepageHeadRef = useRef<number | null>(null)
  const firstSeqRef = useRef<number | null>(null)
  const openedRef = useRef(false)
  const lastKeyRef = useRef<string | null>(null)
  const lastSteeringIdRef = useRef<string | null>(null)
  const lastSubmissionIdRef = useRef<string | null>(null)
  /** Flow tip signature — follow-scroll only when this moves, never on a
   *  scroll-driven at-bottom chrome re-render (which would snap inertial
   *  scrolls the rest of the way to the floor). */
  const followSigRef = useRef<string | null>(null)

  const chatVirtualizationEnabled = order.length > CHAT_VIRTUALIZATION_THRESHOLD
  const chatOrderRef = useRef(order)
  chatOrderRef.current = order
  const chatScrollRef = useRef(chatScroll)
  chatScrollRef.current = chatScroll
  const rangeExtractor = useCallback((range: Range): number[] => {
    const indexes = new Set(defaultRangeExtractor(range))
    for (const key of [
      anchorRef.current?.key,
      pendingPrependAnchorRef.current?.key,
      restoreAnchorKeyRef.current,
      navigationAnchorKeyRef.current,
      chatScrollRef.current.read()?.anchorKey,
    ]) {
      if (key === undefined || key === null) continue
      const index = chatOrderRef.current.indexOf(key)
      if (index >= 0) indexes.add(index)
    }
    // Keep the live tail addressable while a reader is scrolled away. The
    // completed assistant can be followed by a turn-tail after settlement, so
    // reserve a tiny suffix rather than only the current last index. This is
    // O(1) extra DOM, not a second rendered history.
    const tailStart = Math.max(0, chatOrderRef.current.length - CHAT_VIRTUAL_LIVE_TAIL_ROWS)
    for (let index = tailStart; index < chatOrderRef.current.length; index += 1) indexes.add(index)
    return [...indexes].sort((left, right) => left - right)
  }, [])
  const getChatScrollElement = useCallback(() => {
    const local = listRef.current
    return local === null ? null : scrollerOf(local)
  }, [])
  const chatVirtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: chatVirtualizationEnabled ? order.length : 0,
    enabled: chatVirtualizationEnabled,
    estimateSize: () => CHAT_VIRTUAL_ESTIMATED_ROW_HEIGHT_PX,
    getItemKey: index => order[index] ?? index,
    getScrollElement: getChatScrollElement,
    initialRect: { width: 0, height: CHAT_VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX },
    initialOffset: () => {
      // A session can cross the threshold while the reader is paging at the
      // head. Preserve the live scroll owner when the virtualizer switches on;
      // use the estimated tail only for a first mount with no DOM offset yet.
      const local = listRef.current
      if (local !== null) return scrollerOf(local).scrollTop
      return Math.max(
        0,
        order.length * CHAT_VIRTUAL_ESTIMATED_ROW_HEIGHT_PX - CHAT_VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX,
      )
    },
    // Chat owns prepend preservation through its semantic row anchor below;
    // a second virtualizer end-anchor would fight that correction when a page
    // adds nodes at the head.
    anchorTo: 'start',
    overscan: CHAT_VIRTUAL_OVERSCAN_ROWS,
    rangeExtractor,
  })
  // This hook is not part of the public options type, but the virtualizer
  // exposes the policy as a mutable instance hook. The semantic prepend ledger
  // owns these transitions: applying the virtualizer's estimate-to-measured
  // correction as well applies the same height change twice and ejects the
  // reader from the saved row. Normal user scrolling retains the default.
  chatVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => (
    anchorRef.current === null &&
    pendingPrependAnchorRef.current === null &&
    restoreAnchorKeyRef.current === null &&
    navigationAnchorKeyRef.current === null
  )
  const chatVirtualItems = chatVirtualizationEnabled
    ? chatVirtualizer.getVirtualItems()
    : []
  const chatVirtualizerIsScrolling = chatVirtualizer.isScrolling
  const chatVirtualTotalSize = chatVirtualizationEnabled
    ? chatVirtualizer.getTotalSize()
    : 0

  const firstKey = order[0]
  const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = order.at(-1) ?? null
  const lastNode = lastKey === null ? undefined : nodeStore.get(lastKey)
  const lastSteeringId = pendingSteering[pendingSteering.length - 1]?.id ?? null
  const lastSubmissionId = visibleSubmissions[visibleSubmissions.length - 1]?.requestId ?? null
  const followSig = `${openState}:${firstSeq}:${lastKey}:${order.length}:${running ? 1 : 0}:${lastSteeringId ?? ''}:${lastSubmissionId ?? ''}`

  const syncActiveTurn = useCallback((): void => {
    if (scrollSamplePendingRef.current) return
    const local = listRef.current
    const first = turnNavigationItems[0]
    if (local === null || first === undefined) {
      setActiveTurn(null)
      return
    }
    const el = scrollerOf(local)
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1) {
      const latest = turnNavigationItems.at(-1)?.turn ?? first.turn
      setActiveTurn(current => current === latest ? current : latest)
      return
    }
    const readingLine = el.getBoundingClientRect().top + Math.min(96, el.clientHeight * 0.2)
    const reading = turnAtLine(local, readingLine)
    // No row reaches the line yet: the flow head still owns the mark. Otherwise
    // the row's Turn may be one the rail does not offer (all its nodes hidden),
    // so the newest offered Turn at or above it owns the mark.
    let next = first.turn
    if (reading !== null) {
      for (const item of turnNavigationItems) {
        if (item.turn > reading) break
        next = item.turn
      }
    }
    setActiveTurn(current => current === next ? current : next)
  }, [turnNavigationItems])

  const activeTurnRef = useRef<(() => void) | null>(null)
  const activeFrameRef = useRef<number | null>(null)
  const scheduleActiveTurn = useCallback((): void => {
    if (activeFrameRef.current !== null) return
    if (typeof requestAnimationFrame === 'undefined') {
      syncActiveTurn()
      return
    }
    activeFrameRef.current = requestAnimationFrame(() => {
      activeFrameRef.current = null
      syncActiveTurn()
    })
  }, [syncActiveTurn])

  useEffect(() => () => {
    if (activeFrameRef.current !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(activeFrameRef.current)
    }
  }, [])

  activeTurnRef.current = scheduleActiveTurn

  useLayoutEffect(() => {
    scheduleActiveTurn()
  }, [scheduleActiveTurn])

  const toBottom = (el: HTMLElement): void => {
    anchorRef.current = null
    restoreAnchorKeyRef.current = null
    navigationAnchorKeyRef.current = null
    // Returning to the live tail supersedes a jump still landing.
    pendingJumpRef.current = null
    setBusyJumpTurn(current => current === null ? current : null)
    el.scrollTop = el.scrollHeight
    observedTopRef.current = el.scrollTop
    atBottomRef.current = true
    setAtBottom(true)
    chatScroll.save(null)
    setActiveTurn(turnNavigationItems.at(-1)?.turn ?? null)
  }

  // Land a row at the reading line and republish scroll-derived state. A
  // latest-ref, so navigateToTurn's identity stays stable for the memoized rail.
  const landOnRowRef = useRef<(local: HTMLElement, el: HTMLElement, row: HTMLElement, turn: number) => void>(
    () => {},
  )
  landOnRowRef.current = (local, el, row, turn) => {
    el.scrollTop += flowTop(row, el) - 24
    observedTopRef.current = el.scrollTop
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    setActiveTurn(turn)
    const position = isAtBottom ? null : scrollPosition(local, el)
    if (isAtBottom) chatScroll.save(null)
    else if (position !== null) chatScroll.save(position)
  }

  /**
   * Land the pending jump once its Turn has a rendered anchor row; false
   * while it must keep waiting. Mid-jump landings (`settle` false) keep the
   * jump armed with the target row as the paging anchor, so later chunks and
   * the load-earlier button's unmount re-land on the same row; the settling
   * call clears the jump.
   */
  const realizePendingJump = (local: HTMLElement, el: HTMLElement, settle: boolean): boolean => {
    const pending = pendingJumpRef.current
    if (pending === null) return true
    const item = railItems.find(candidate => candidate.turn === pending.turn)
    if (item === undefined || item.anchor.kind !== 'loaded') return false
    const row = anchorElement(local, item.anchor.key)
    if (row === null) return false
    if (settle) {
      pendingJumpRef.current = null
      setBusyJumpTurn(null)
      const held = anchorRef.current
      const landedEarlier = jumpLandedRef.current
      jumpLandedRef.current = false
      anchorRef.current = null
      // A reader who moved off an already-landed target mid-jump keeps their
      // place; a first landing, or an untouched one, takes the correction.
      if (!landedEarlier || held?.key === item.anchor.key) {
        landOnRowRef.current(local, el, row, pending.turn)
      }
      return true
    }
    landOnRowRef.current(local, el, row, pending.turn)
    jumpLandedRef.current = true
    anchorRef.current = { key: item.anchor.key, top: flowTop(row, el) }
    return true
  }

  useLayoutEffect(() => {
    if (scrollSamplePendingRef.current) return
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: React attaches the ref before layout effects run. */
    if (local === null) return
    const el = scrollerOf(local)
    // Open completed: jump to the bottom once — unless a scroll position
    // survives from a previous mount (view-tab switch away and back), which
    // is restored instead of snapping the reader back to the floor.
    if (openState === 'open' && !openedRef.current) {
      const saved = initialScrollPosition
      if (saved === null) {
        openedRef.current = true
        toBottom(el)
      } else {
        el.scrollTop = saved.scrollTop
        const row = anchorElement(local, saved.anchorKey)
        if (row === null) {
          const index = chatVirtualizationEnabled ? order.indexOf(saved.anchorKey) : -1
          if (index >= 0) {
            chatVirtualizer.scrollToIndex(index, { behavior: 'auto', align: 'center' })
          } else if (hasMore && !loadingOlder) {
            // A saved reader position can point into a page that is not part
            // of a fresh session open. Pull pages until the semantic row is
            // exposed; restoring to the current tail would lose the user's
            // position on every session/tab round-trip.
            const request = restorePageRequestRef.current
            if (request?.key !== saved.anchorKey || request.firstSeq !== firstSeq) {
              restorePageRequestRef.current = { key: saved.anchorKey, firstSeq }
              loadOlder()
            }
          } else {
            // The saved row may have been removed by a branch or retention
            // policy. A completed open still needs an owner; follow the tail
            // rather than leaving the view permanently in its pre-open state.
            openedRef.current = true
            restoreAnchorKeyRef.current = null
            restorePageRequestRef.current = null
            toBottom(el)
          }
          return
        }
        openedRef.current = true
        restorePageRequestRef.current = null
        el.scrollTop += flowTop(row, el) - saved.anchorTop
        observedTopRef.current = el.scrollTop
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
        atBottomRef.current = isAtBottom
        setAtBottom(isAtBottom)
        const normalized = isAtBottom ? null : scrollPosition(local, el)
        if (isAtBottom) chatScroll.save(null)
        else if (normalized !== null) chatScroll.save(normalized)
      }
      firstSeqRef.current = firstSeq
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      lastSubmissionIdRef.current = lastSubmissionId
      followSigRef.current = followSig
      return
    }
    // Prepend (head seq decreased): preserve the same settled row at the
    // position established by the reader's latest scroll. This excludes
    // unrelated tail/composer growth while the request was in flight.
    if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
      const anchor = anchorRef.current
      anchorRef.current = null
      if (chatVirtualizationEnabled) {
        pendingPrependAnchorRef.current = anchor
      }
      const row = anchorElement(local, anchor.key)
      if (row !== null) {
        const delta = flowTop(row, el) - anchor.top
        el.scrollTop += delta
      }
      observedTopRef.current = el.scrollTop
      // A jump chunk lands here: scroll to the target once its rows exist;
      // until then keep holding the reader's row for the next chunk.
      if (!realizePendingJump(local, el, false) && row !== null) {
        anchorRef.current = { key: anchor.key, top: flowTop(row, el) }
      }
      firstSeqRef.current = firstSeq
      /* v8 ignore next -- ?? arm: a prepend adds nodes, so the flow list here is never empty. */
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      lastSubmissionIdRef.current = lastSubmissionId
      followSigRef.current = followSig
      return
    }
    firstSeqRef.current = firstSeq
    // Own words must be visible: a new trailing user node force-scrolls
    // (send lives in the composer, so arrival is detected here, not armed there).
    const appendedUser = lastKey !== lastKeyRef.current && lastNode?.kind === 'user'
    const appendedSteering = lastSteeringId !== null && lastSteeringId !== lastSteeringIdRef.current
    const appendedSubmission = lastSubmissionId !== null && lastSubmissionId !== lastSubmissionIdRef.current
    const tipMoved = followSigRef.current !== followSig
    lastKeyRef.current = lastKey
    lastSteeringIdRef.current = lastSteeringId
    lastSubmissionIdRef.current = lastSubmissionId
    followSigRef.current = followSig
    // Follow new flow content while pinned; do NOT re-pin on every render
    // merely because atBottomRef is true (scroll threshold → setState → snap).
    if (appendedUser || appendedSteering || appendedSubmission || (tipMoved && atBottomRef.current)) {
      toBottom(el)
      return
    }
    // A jump whose target committed outside the anchored-prepend path (for
    // example after a mid-jump toBottom dropped the held anchor) lands here.
    if (pendingJumpRef.current !== null) realizePendingJump(local, el, false)
  })

  // The first open can run before the virtualizer has committed its estimated
  // flow height. Re-apply the pinned bottom after that height exists and emit
  // the same scroll signal the virtualizer would receive from user input, so
  // its internal range starts at the tail rather than at index zero.
  useLayoutEffect(() => {
    if (!chatVirtualizationEnabled || openState !== 'open' || !openedRef.current || !atBottomRef.current) return
    const local = listRef.current
    if (local === null || chatVirtualTotalSize <= 0) return
    const el = scrollerOf(local)
    const floor = Math.max(0, el.scrollHeight - el.clientHeight)
    if (el.scrollTop >= floor) return
    el.scrollTop = floor
    observedTopRef.current = el.scrollTop
    el.dispatchEvent(new Event('scroll'))
  }, [chatVirtualTotalSize, chatVirtualizationEnabled, openState])

  // Dynamic markdown, tool output, and image rows can revise measurements over
  // several commits after a prepend. Reconcile the semantic anchor against the
  // virtualizer's current range for as long as the reader remains on that
  // page. The ledger is released only by a subsequent reader scroll; a fixed
  // number of "stable" frames is unsafe because content-visibility and late
  // media measurement can revise an already apparently settled total later.
  // The native scroll owner receives each correction and the virtualizer learns
  // the offset through its ordinary scroll observer.
  useLayoutEffect(() => {
    const pending = pendingPrependAnchorRef.current
    if (!chatVirtualizationEnabled || pending === null) return
    const local = listRef.current
    if (local === null) return
    const el = scrollerOf(local)
    const row = anchorElement(local, pending.key)
    if (row === null) return
    const delta = flowTop(row, el) - pending.top
    if (Math.abs(delta) > 0.5) {
      el.scrollTop += delta
      observedTopRef.current = el.scrollTop
    }
  }, [chatVirtualItems, chatVirtualTotalSize, chatVirtualizationEnabled, chatVirtualizer, order])

  // A View can stay resident while another conversation tab is shown. Its
  // scrollport may be remeasured at the tail while hidden, so the mount-only
  // restore above does not run when it becomes visible again. Reconcile the
  // current per-session semantic position whenever the virtual range returns.
  useLayoutEffect(() => {
    if (!chatVirtualizationEnabled || !openedRef.current || atBottomRef.current) return
    const saved = chatScrollRef.current.read()
    if (saved === null) return
    const local = listRef.current
    if (local === null) return
    const el = scrollerOf(local)
    const floor = Math.max(0, el.scrollHeight - el.clientHeight)
    const restoreFromLayout = layoutRestorePendingRef.current
    layoutRestorePendingRef.current = false
    // The virtualizer publishes its range before Chat's passive scroll ledger
    // runs. A reader scroll can therefore render this effect while the saved
    // semantic position still describes the previous frame. Do not restore
    // that stale position over live reader input; the ledger will save the new
    // anchor when the event listener runs. Hidden remeasurement is not marked
    // as scrolling and still takes the resident-restore path below.
    if (
      !restoreFromLayout &&
      chatVirtualizer.isScrolling &&
      anchorRef.current === null &&
      pendingPrependAnchorRef.current === null &&
      Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) >
        CHAT_SCROLL_RESTORE_TOLERANCE_PX
    ) return
    const row = anchorElement(local, saved.anchorKey)
    if (row === null) {
      const index = order.indexOf(saved.anchorKey)
      if (index >= 0) {
        restoreAnchorKeyRef.current = saved.anchorKey
        chatVirtualizer.scrollToIndex(index, { behavior: 'auto', align: 'center' })
      } else if (hasMore && !loadingOlder) {
        const request = restorePageRequestRef.current
        if (request?.key !== saved.anchorKey || request.firstSeq !== firstSeq) {
          restorePageRequestRef.current = { key: saved.anchorKey, firstSeq }
          loadOlder()
        }
      }
      return
    }
    const delta = flowTop(row, el) - saved.anchorTop
    if (Math.abs(delta) > CHAT_SCROLL_RESTORE_TOLERANCE_PX) {
      el.scrollTop += delta
      observedTopRef.current = el.scrollTop
    }
  }, [
    chatVirtualItems,
    chatVirtualizationEnabled,
    chatVirtualizer,
    chatVirtualizerIsScrolling,
    firstSeq,
    hasMore,
    layoutEpoch,
    loadingOlder,
    loadOlder,
    order,
  ])

  useLayoutEffect(() => {
    const local = listRef.current
    const key = navigationAnchorKeyRef.current
    if (local === null || key === null) return
    // Keep the target addressable until the next reader gesture releases the
    // authored-scroll guard. Clearing it as soon as the row mounts lets late
    // virtual measurements look like reader input and overwrite the saved
    // session anchor.
    if (anchorElement(local, key) === null) return
  }, [chatVirtualItems, chatVirtualizationEnabled, chatVirtualizer, chatVirtualizerIsScrolling, order])

  const onScrollRef = useRef(() => {})
  onScrollRef.current = () => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the handler only fires while mounted. */
    if (local === null) return
    const el = scrollerOf(local)
    // `scrollToIndex` is an authored move, but its native scroll event arrives
    // through the same observer as a wheel/touch/keyboard move. Keep that
    // transient geometry out of the per-session semantic ledger; the restore
    // a reader gesture releases the arm after the target row is mounted and corrected.
    if (restoreAnchorKeyRef.current !== null || navigationAnchorKeyRef.current !== null) {
      observedTopRef.current = el.scrollTop
      scheduleActiveTurn()
      return
    }
    // Only reader input may make raw scroll geometry change follow ownership:
    // a delivered position that deviates from the observed-top ledger (every
    // programmatic write records itself there synchronously). This covers
    // wheel, touch, scrollbar, and keyboard alike without naming devices.
    // Browser shrink-clamps land exactly on the floor min and delayed
    // programmatic deliveries land on the ledger itself, so both preserve
    // the current ownership state.
    const floor = Math.max(0, el.scrollHeight - el.clientHeight)
    const movedByReader = Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > 0.5
    // A prepend may need a few layout passes to settle dynamic rows, but a
    // subsequent reader scroll owns the viewport immediately. Do not let a
    // stale semantic correction pull the reader back toward the old anchor.
    if (movedByReader && pendingPrependAnchorRef.current !== null) {
      pendingPrependAnchorRef.current = null
    }
    const isAtBottom = movedByReader
      ? floor - el.scrollTop <= FOLLOW_THRESHOLD + 1
      : atBottomRef.current
    if (!movedByReader && isAtBottom) {
      toBottom(el)
      return
    }
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    const position = isAtBottom ? null : scrollPosition(local, el)
    if (isAtBottom) {
      anchorRef.current = null
    } else if (anchorRef.current !== null && position !== null) {
      anchorRef.current = { key: position.anchorKey, top: position.anchorTop }
    }
    // Continuous save (unmount happens after ref detach, so saving there is
    // too late); pinned-to-bottom clears so a remount keeps following.
    if (isAtBottom) chatScroll.save(null)
    else if (position !== null) chatScroll.save(position)
    observedTopRef.current = el.scrollTop
    scheduleActiveTurn()
  }

  // Raw scroll events only schedule work. Geometry is sampled at most once
  // per interval, with scrollend providing the final sample for a short burst.
  useEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: effect runs after the list node commits. */
    if (local === null) return
    const el = scrollerOf(local)
    let sampleTimer: number | undefined
    const sample = (): void => {
      if (!scrollSamplePendingRef.current) return
      scrollSamplePendingRef.current = false
      if (sampleTimer !== undefined) window.clearTimeout(sampleTimer)
      sampleTimer = undefined
      onScrollRef.current()
      setScrollSampleTick(tick => tick + 1)
    }
    const releaseAuthoredScroll = (): void => {
      restoreAnchorKeyRef.current = null
      navigationAnchorKeyRef.current = null
    }
    const onScroll = (): void => {
      scrollSamplePendingRef.current = true
      sampleTimer ??= window.setTimeout(sample, SCROLL_SAMPLE_INTERVAL_MS)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('scrollend', sample, { passive: true })
    el.addEventListener('wheel', releaseAuthoredScroll, { passive: true })
    el.addEventListener('touchstart', releaseAuthoredScroll, { passive: true })
    el.addEventListener('pointerdown', releaseAuthoredScroll, { passive: true })
    el.addEventListener('keydown', releaseAuthoredScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('scrollend', sample)
      el.removeEventListener('wheel', releaseAuthoredScroll)
      el.removeEventListener('touchstart', releaseAuthoredScroll)
      el.removeEventListener('pointerdown', releaseAuthoredScroll)
      el.removeEventListener('keydown', releaseAuthoredScroll)
      if (sampleTimer !== undefined) window.clearTimeout(sampleTimer)
      scrollSamplePendingRef.current = false
    }
  }, [])

  // The ref starts null and is assigned every render, so the placeholder
  // initializer a function initial value would need never exists.
  const followRef = useRef<(() => void) | null>(null)
  followRef.current = () => {
    if (scrollSamplePendingRef.current) return
    const local = listRef.current
    if (local !== null && atBottomRef.current) {
      const el = scrollerOf(local)
      el.scrollTop = el.scrollHeight
      observedTopRef.current = el.scrollTop
      chatScroll.save(null)
    }
  }
  // Streaming, tool disclosures, and other flow changes resize the column;
  // the sticky composer resizes outside it. This observer owns ChatView's
  // dynamic-height follow decisions and writes only while the reader is pinned.
  useEffect(() => {
    const column = columnRef.current
    const local = listRef.current
    if (column === null || local === null || typeof ResizeObserver === 'undefined') return
    const scrollport = scrollerOf(local)
    const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
    // Flow-height changes (image loads, tool disclosures) move rows across the
    // reading line without a scroll event, so the active mark resyncs here too.
    const observer = new ResizeObserver(() => {
      followRef.current?.()
      if (!atBottomRef.current) {
        layoutRestorePendingRef.current = true
        setLayoutEpoch(epoch => epoch + 1)
      }
      activeTurnRef.current?.()
    })
    observer.observe(column)
    if (composer !== null) observer.observe(composer)
    return () => { observer.disconnect() }
  }, [])

  // A failed/empty page leaves the head unchanged. Once the request leaves
  // its busy state there is no future prepend for the saved anchor to own.
  useEffect(() => {
    if (!loadingOlder) anchorRef.current = null
  }, [loadingOlder])

  // Jump settlement: every loadThrough completion bumps the tick after its
  // last page's commit, and a plain pull's loadingOlder flip re-settles a
  // jump it made wait. A still-pending jump is realized now, held while a
  // plain load-earlier pull owns the pager (its completion retries below),
  // repaged once per head movement, or landed on the nearest rendered Turn
  // at or after the target (failure, exhausted history, or a Turn with no
  // visible row).
  useEffect(() => {
    const pending = pendingJumpRef.current
    const local = listRef.current
    if (pending === null || local === null) return
    const el = scrollerOf(local)
    // The settling landing runs after the load-earlier button's unmount
    // commit, so the target row cannot drift once the jump clears.
    if (realizePendingJump(local, el, true)) return
    const uncovered = firstSeq === null || firstSeq > pending.seq
    if (uncovered && hasMore) {
      // A plain pull owns the pager right now: hold the jump (busy stays)
      // instead of degrading to a wrong landing.
      if (loadingOlder) return
      if (jumpRepageHeadRef.current !== firstSeq) {
        jumpRepageHeadRef.current = firstSeq
        const held = pagingAnchor(local, el)
        if (held !== null && held.dataset.chatAnchorKey !== undefined) {
          anchorRef.current = { key: held.dataset.chatAnchorKey, top: flowTop(held, el) }
        }
        void loadThrough(pending.seq).finally(() => { setJumpSettleTick(tick => tick + 1) })
        return
      }
    }
    for (const row of local.querySelectorAll<HTMLElement>('[data-chat-turn]:not([hidden])')) {
      const turn = Number(row.dataset.chatTurn)
      if (!Number.isSafeInteger(turn) || turn < pending.turn) continue
      landOnRowRef.current(local, el, row, turn)
      break
    }
    pendingJumpRef.current = null
    setBusyJumpTurn(null)
    // Snapshot values are read at settle time; the completion tick is the trigger.
  }, [jumpSettleTick])

  // A jump held while a plain pull owned the pager waits in the effect
  // above; the pull's completion is its retry signal.
  useEffect(() => {
    if (!loadingOlder && pendingJumpRef.current !== null) setJumpSettleTick(tick => tick + 1)
  }, [loadingOlder])

  const loadOlderAnchored = (): void => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the paging button renders inside the list tree. */
    if (local !== null) {
      const el = scrollerOf(local)
      const row = pagingAnchor(local, el)
      if (row !== null && row.dataset.chatAnchorKey !== undefined) {
        anchorRef.current = {
          key: row.dataset.chatAnchorKey,
          top: flowTop(row, el),
        }
      }
    }
    loadOlder()
  }

  // Identity feeds the memoized rail; a fresh closure per render would defeat it.
  const navigateToTurn = useCallback((item: TurnRailItem): void => {
    const local = listRef.current
    if (local === null) return
    const el = scrollerOf(local)
    if (item.anchor.kind === 'unloaded') {
      // Jumping into history is leaving the live tail: release bottom
      // ownership on the click itself, or the pinned-scroll snap (a
      // non-reader scroll delivery during the first prepend's compensation)
      // would call toBottom and cancel the jump.
      atBottomRef.current = false
      setAtBottom(false)
      // Hold the reader's place through the paging chunks; the layout effect
      // lands on the target once its rows commit.
      const held = pagingAnchor(local, el)
      if (held !== null && held.dataset.chatAnchorKey !== undefined) {
        anchorRef.current = { key: held.dataset.chatAnchorKey, top: flowTop(held, el) }
      }
      pendingJumpRef.current = { turn: item.turn, seq: item.anchor.seq }
      jumpRepageHeadRef.current = null
      jumpLandedRef.current = false
      setBusyJumpTurn(item.turn)
      void loadThrough(item.anchor.seq).finally(() => { setJumpSettleTick(tick => tick + 1) })
      return
    }
    // Keep a virtual navigation target mounted until the next reader gesture
    // releases the authored-scroll guard (no-op on the ordinary flow path).
    navigationAnchorKeyRef.current = item.anchor.key
    // A loaded-mark click supersedes any jump still landing, whether its row
    // is already mounted or still has to be scrolled into the virtual window.
    pendingJumpRef.current = null
    setBusyJumpTurn(current => current === null ? current : null)
    const row = anchorElement(local, item.anchor.key)
    if (row === null) {
      const index = chatVirtualizationEnabled ? order.indexOf(item.anchor.key) : -1
      if (index < 0) return
      // The ordinary path jumps directly to the semantic row. Keep the same
      // contract for an offscreen virtual row so the scroll-frame active-turn
      // sampler cannot overwrite aria-current during a long smooth animation.
      chatVirtualizer.scrollToIndex(index, { behavior: 'auto', align: 'center' })
      observedTopRef.current = el.scrollTop
      atBottomRef.current = false
      setAtBottom(false)
      setActiveTurn(item.turn)
      return
    }
    landOnRowRef.current(local, el, row, item.turn)
    // A pending older page still has to compensate the prepended height, so
    // navigation moves that anchor to the new position instead of dropping it.
    const landed = loadingOlder ? pagingAnchor(local, el) : null
    anchorRef.current = landed === null || landed.dataset.chatAnchorKey === undefined
      ? null
      : { key: landed.dataset.chatAnchorKey, top: flowTop(landed, el) }
  }, [chatVirtualizationEnabled, chatVirtualizer, loadThrough, loadingOlder, order])

  const renderChatNode = useCallback((nodeKey: string) => (
    <ChatNodeSeat
      key={nodeKey}
      nodeKey={nodeKey}
      useChatNode={useChatNode}
      useChatNodeProcess={useChatNodeProcess}
      historyIncomplete={hasMore}
      compactTranscript={compactTranscript}
      useStore={useStore}
      actions={actions}
      selectedCallId={selectedCallId}
      cwd={cwd}
      openFile={requestOpenFile}
      inspectCall={inspectCall}
      forkAt={forkAt}
      loadImage={loadImage}
      renderMessageImages={renderMessageImages}
      fileMentions={fileMentions}
      renderSlot={renderSlot}
      t={t}
    />
  ), [
    actions, compactTranscript, cwd, fileMentions, forkAt, hasMore, inspectCall, loadImage,
    renderMessageImages, renderSlot, requestOpenFile, selectedCallId, t, useChatNode,
    useChatNodeProcess, useStore,
  ])

  return (
    <div className={css.root}>
      <div ref={listRef} className={css.scroll}>
        <TurnNavigator
          items={railItems}
          activeTurn={activeTurn}
          busyTurn={busyJumpTurn}
          onNavigate={navigateToTurn}
          t={t}
        />
        <div ref={columnRef} className={css.column} data-chat-flow="">
          {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
          {openState === 'error' && openError !== null && (
            <div className={css.openError}>
              {t('chat.loadError', { message: openError.message, code: openError.code })}
            </div>
          )}
          {hasMore && (
            <div className={css.older}>
              <button type="button" disabled={loadingOlder} onClick={loadOlderAnchored}>
                {loadingOlder ? t('loading') : t('chat.loadOlder')}
              </button>
            </div>
          )}
          {chatVirtualizationEnabled
            ? (
              <div
                className={css.virtualFlow}
                data-chat-virtual-flow=""
                style={{ height: chatVirtualizer.getTotalSize() }}
              >
                {chatVirtualItems.flatMap((item) => {
                  const nodeKey = order[item.index]
                  if (nodeKey === undefined) return []
                  return [
                    <div
                      key={item.key}
                      ref={chatVirtualizer.measureElement}
                      className={css.virtualRow}
                      data-chat-virtual-row=""
                      data-chat-virtual-tail={item.index >= Math.max(0, order.length - CHAT_VIRTUAL_LIVE_TAIL_ROWS) || undefined}
                      data-chat-virtual-leading-gap={item.index > 0 || undefined}
                      data-index={item.index}
                      style={{ transform: `translateY(${String(item.start)}px)` }}
                    >
                      {renderChatNode(nodeKey)}
                    </div>,
                  ]
                })}
              </div>
            )
            : (
              <ChatNodeList
                order={order}
                useChatNode={useChatNode}
                useChatNodeProcess={useChatNodeProcess}
                historyIncomplete={hasMore}
                compactTranscript={compactTranscript}
                useStore={useStore}
                actions={actions}
                selectedCallId={selectedCallId}
                cwd={cwd}
                openFile={requestOpenFile}
                inspectCall={inspectCall}
                forkAt={forkAt}
                loadImage={loadImage}
                renderMessageImages={renderMessageImages}
                fileMentions={fileMentions}
                renderSlot={renderSlot}
                t={t}
              />
            )}
          {/* No pending placeholders: questions (ui-user-questions) and approvals
              (ApprovalPanel) both take over the composer, so a flow card would
              double-render the same wait. */}
          {/* Turn-level loading signal: rides the whole running turn (first-token
              wait, tool execution, streaming) so it never flickers per step. */}
          {running && <TurnStatus startTime={runningTurnStart} t={t} />}
          {pendingSteering.map(item => (
            <PendingSteeringBubble
              key={item.id}
              content={item.content}
              renderMessageImages={renderMessageImages}
              t={t}
            />
          ))}
          {visibleSubmissions.map(submission => (
            <PendingSubmissionBubble
              key={submission.requestId}
              submission={submission}
              renderMessageImages={renderMessageImages}
              t={t}
            />
          ))}
        </div>
        {!atBottom && (
          <div className={css.toBottomSlot}>
            <button
              type="button"
              className={css.toBottom}
              aria-label={t('chat.toBottom')}
              onClick={() => {
                const local = listRef.current
                /* v8 ignore next -- ref-null guard: the button only renders alongside the mounted list. */
                if (local !== null) toBottom(scrollerOf(local))
              }}
            >
              <IconChevronDownOutline14 />
            </button>
          </div>
        )}
      </div>
      {fileOpenError !== null && (
        <FileOpenErrorDialog
          path={fileOpenError.path}
          message={fileOpenError.message}
          busy={fileOpenBusy}
          onClose={closeFileOpenError}
          onRetry={() => { requestOpenFile(fileOpenError.path) }}
          t={t}
        />
      )}
    </div>
  )
}

/** In-page Host open-path refusal: the wire reason plus a retry of the same path. */
function FileOpenErrorDialog({
  path, message, busy, onClose, onRetry, t,
}: {
  path: string
  message: string
  busy: boolean
  onClose: () => void
  onRetry: () => void
  t: ChatViewSlotProps['t']
}) {
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t(isFolderOpenPath(path) ? 'fileOpen.folderTitle' : 'fileOpen.title')}
      description={message}
      footer={(
        <>
          <Button variant="outline" className={css.modalAction} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" className={css.modalAction} disabled={busy} onClick={onRetry}>{t('retry')}</Button>
        </>
      )}
    />
  )
}
