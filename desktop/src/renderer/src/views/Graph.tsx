import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { animate, AnimatePresence, motion, useMotionValue } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Minus, MousePointerClick, Plus, Scan } from 'lucide-react'
import type { ArchivedNote, ArchivedTerm } from '@shared/types'
import { EmptyState, TermChip } from '../components/ui'
import { dayLabel, timeLabel } from '../lib/format'
import { kindOf, kinds } from '../lib/kinds'
import { smooth } from '../lib/motion'
import type { ArchiveModel } from '../lib/store'
import { NoteDetail } from './Notes'

interface GraphNode extends SimulationNodeDatum {
  id: string
  type: 'term' | 'note'
  term?: ArchivedTerm
  note?: ArchivedNote
  r: number
  order: number
}
interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  id: string
  kind: 'cooccur' | 'mention'
  weight: number
}

const MAX_NOTES = 150
const MIN_ZOOM = 0.25, MAX_ZOOM = 4

function seed(id: string): number {
  let hash = 2166136261
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619)
  return ((hash >>> 0) % 10_000) / 10_000
}

export function GraphView({ archive, search, selectedTerm, selectedNote, onSelectTerm, onSelectNote, onOpenInNotes }: {
  archive: ArchiveModel; search: string; selectedTerm: number | null; selectedNote: string | null
  onSelectTerm: (id: number | null) => void; onSelectNote: (id: string | null) => void; onOpenInNotes: (id: string) => void
}) {
  // The graph draws the most recent notes for responsiveness; Notes searches everything.
  const notes = useMemo(() => archive.notes.slice(0, MAX_NOTES), [archive.notes])
  const terms = useMemo(() => {
    const used = new Set(notes.flatMap((note) => note.terms))
    return archive.terms.filter((term) => used.has(term.id) || notes.length === 0)
  }, [archive.terms, notes])

  const graph = useMemo(() => {
    const termIDs = new Set(terms.map((term) => term.id))
    const nodes: GraphNode[] = [
      ...terms.map((term, order) => ({ id: `t:${term.id}`, type: 'term' as const, term, order, r: 4.5 + Math.min(10, Math.sqrt(term.mentions) * 2.3) })),
      ...notes.map((note, order) => ({ id: `n:${note.id}`, type: 'note' as const, note, order: terms.length + order, r: 4.2 }))
    ]
    const edges: GraphEdge[] = []
    for (const link of archive.links) {
      if (termIDs.has(link.source) && termIDs.has(link.target)) edges.push({ id: `l:${link.source}:${link.target}`, source: `t:${link.source}`, target: `t:${link.target}`, kind: 'cooccur', weight: link.weight })
    }
    for (const note of notes) for (const term of note.terms) {
      if (termIDs.has(term)) edges.push({ id: `m:${note.id}:${term}`, source: `n:${note.id}`, target: `t:${term}`, kind: 'mention', weight: 1 })
    }
    const neighbors = new Map<string, Set<string>>()
    for (const edge of edges) {
      const a = edge.source as string, b = edge.target as string
      if (!neighbors.has(a)) neighbors.set(a, new Set())
      if (!neighbors.has(b)) neighbors.set(b, new Set())
      neighbors.get(a)!.add(b); neighbors.get(b)!.add(a)
    }
    return { nodes, edges, neighbors }
  }, [terms, notes, archive.links])

  if (archive.loaded && graph.nodes.length === 0) {
    return (
      <div className="graph-empty">
        <EmptyState title="Your words will find each other." detail="Mention names, projects and topics while you dictate. Dictait links what you say together, entirely on your Mac." />
      </div>
    )
  }

  return (
    <div className="graph-view">
      <GraphCanvas graph={graph} search={search} selectedTerm={selectedTerm} selectedNote={selectedNote}
        onSelectTerm={onSelectTerm} onSelectNote={onSelectNote} counts={{ notes: notes.length, terms: terms.length, total: archive.notes.length }} />
      <Inspector archive={archive} selectedTerm={selectedTerm} selectedNote={selectedNote}
        onSelectTerm={onSelectTerm} onSelectNote={onSelectNote} onOpenInNotes={onOpenInNotes} />
    </div>
  )
}

function GraphCanvas({ graph, search, selectedTerm, selectedNote, onSelectTerm, onSelectNote, counts }: {
  graph: { nodes: GraphNode[]; edges: GraphEdge[]; neighbors: Map<string, Set<string>> }
  search: string; selectedTerm: number | null; selectedNote: string | null
  onSelectTerm: (id: number | null) => void; onSelectNote: (id: string | null) => void
  counts: { notes: number; terms: number; total: number }
}) {
  const container = useRef<HTMLDivElement>(null)
  const layer = useRef<SVGGElement>(null)
  const grid = useRef<SVGPatternElement>(null)
  const simulation = useRef<Simulation<GraphNode, GraphEdge> | null>(null)
  const positions = useRef(new Map<string, { x: number; y: number }>())
  const fitted = useRef(false)
  const [, setFrame] = useState(0)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hovered, setHovered] = useState<string | null>(null)
  const [zoomedIn, setZoomedIn] = useState(false)
  const tx = useMotionValue(0), ty = useMotionValue(0), k = useMotionValue(1)

  // Pan and zoom live in motion values and write the transform directly: no React renders while moving.
  useEffect(() => {
    const update = () => {
      const transform = `translate(${tx.get()} ${ty.get()}) scale(${k.get()})`
      layer.current?.setAttribute('transform', transform)
      grid.current?.setAttribute('patternTransform', transform)
      setZoomedIn(k.get() >= 1.45)
    }
    update()
    const offs = [tx.on('change', update), ty.on('change', update), k.on('change', update)]
    return () => offs.forEach((off) => off())
  }, [tx, ty, k])

  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const fit = useCallback((animated: boolean) => {
    const { width, height } = size
    if (!width || !height || graph.nodes.length === 0) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const node of graph.nodes) {
      minX = Math.min(minX, (node.x ?? 0) - node.r); maxX = Math.max(maxX, (node.x ?? 0) + node.r)
      minY = Math.min(minY, (node.y ?? 0) - node.r); maxY = Math.max(maxY, (node.y ?? 0) + node.r + 16)
    }
    const scale = Math.max(MIN_ZOOM, Math.min(1.6, (width - 120) / Math.max(1, maxX - minX), (height - 140) / Math.max(1, maxY - minY)))
    const targetX = width / 2 - ((minX + maxX) / 2) * scale, targetY = height / 2 - ((minY + maxY) / 2) * scale - 10
    if (animated) {
      void animate(k, scale, smooth); void animate(tx, targetX, smooth); void animate(ty, targetY, smooth)
    } else { k.set(scale); tx.set(targetX); ty.set(targetY) }
  }, [size, graph.nodes, k, tx, ty])

  // A live force layout that settles into place, keeping positions across refreshes.
  useEffect(() => {
    const known = positions.current
    let fresh = 0
    for (const node of graph.nodes) {
      const previous = known.get(node.id)
      if (previous) { node.x = previous.x; node.y = previous.y; continue }
      fresh++
      const angle = seed(node.id) * Math.PI * 2, radius = 40 + seed(node.id + '#') * 160
      node.x = Math.cos(angle) * radius; node.y = Math.sin(angle) * radius
    }
    const sim = forceSimulation<GraphNode>(graph.nodes)
      .force('link', forceLink<GraphNode, GraphEdge>(graph.edges).id((node) => node.id)
        .distance((edge) => (edge.kind === 'mention' ? 36 : 78))
        .strength((edge) => (edge.kind === 'mention' ? 0.65 : Math.min(0.4, 0.1 * edge.weight))))
      .force('charge', forceManyBody<GraphNode>().strength((node) => (node.type === 'term' ? -230 : -50)).distanceMax(460))
      .force('collide', forceCollide<GraphNode>((node) => node.r + (node.type === 'term' ? 12 : 4)))
      .force('x', forceX(0).strength(0.045))
      .force('y', forceY(0).strength(0.065))
      .alphaDecay(0.03)
      .stop()
    // Pre-settle new layouts, then let them breathe into place.
    if (fresh > graph.nodes.length / 3) for (let index = 0; index < 200; index++) sim.tick()
    sim.alpha(fresh ? 0.3 : 0.05)
    sim.on('tick', () => {
      for (const node of graph.nodes) known.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 })
      setFrame((frame) => frame + 1)
    })
    sim.restart()
    simulation.current = sim
    return () => { sim.stop() }
  }, [graph])

  useEffect(() => {
    if (!fitted.current && size.width && graph.nodes.length) { fitted.current = true; fit(false); k.set(k.get() * 0.9); fit(true) }
  }, [size, graph.nodes.length, fit, k])

  // Trackpad: pinch zooms around the pointer, two-finger scroll pans.
  useEffect(() => {
    const element = container.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) {
        const px = event.clientX - rect.left, py = event.clientY - rect.top
        const current = k.get(), next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current * Math.exp(-event.deltaY * 0.01)))
        tx.set(px - (px - tx.get()) * (next / current)); ty.set(py - (py - ty.get()) * (next / current)); k.set(next)
      } else {
        tx.set(tx.get() - event.deltaX); ty.set(ty.get() - event.deltaY)
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [k, tx, ty])

  const zoomBy = (factor: number) => {
    const { width, height } = size
    const current = k.get(), next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current * factor))
    void animate(tx, width / 2 - (width / 2 - tx.get()) * (next / current), smooth)
    void animate(ty, height / 2 - (height / 2 - ty.get()) * (next / current), smooth)
    void animate(k, next, smooth)
  }

  // Background drag pans 1:1 and carries its momentum on release.
  const startPan = (event: React.PointerEvent<SVGRectElement>) => {
    if (event.button !== 0) return
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const startX = event.clientX - tx.get(), startY = event.clientY - ty.get()
    let moved = false
    tx.stop(); ty.stop()
    const move = (next: PointerEvent) => {
      if (Math.abs(next.clientX - startX - tx.get()) + Math.abs(next.clientY - startY - ty.get()) > 2) moved = true
      tx.set(next.clientX - startX); ty.set(next.clientY - startY)
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      if (!moved) { onSelectTerm(null); onSelectNote(null); return }
      void animate(tx, tx.get(), { type: 'inertia', velocity: tx.getVelocity(), power: 0.25, timeConstant: 260 })
      void animate(ty, ty.get(), { type: 'inertia', velocity: ty.getVelocity(), power: 0.25, timeConstant: 260 })
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  // Nodes follow the pointer from where they were grabbed; a short press selects.
  const startDrag = (event: React.PointerEvent<SVGGElement>, node: GraphNode) => {
    if (event.button !== 0) return
    event.stopPropagation()
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const rect = container.current!.getBoundingClientRect()
    const toGraph = (x: number, y: number) => ({ x: (x - rect.left - tx.get()) / k.get(), y: (y - rect.top - ty.get()) / k.get() })
    const grab = toGraph(event.clientX, event.clientY)
    const offsetX = (node.x ?? 0) - grab.x, offsetY = (node.y ?? 0) - grab.y
    const originX = event.clientX, originY = event.clientY
    let dragging = false
    const move = (next: PointerEvent) => {
      if (!dragging && Math.hypot(next.clientX - originX, next.clientY - originY) < 4) return
      if (!dragging) { dragging = true; simulation.current?.alphaTarget(0.25).restart() }
      const point = toGraph(next.clientX, next.clientY)
      node.fx = point.x + offsetX; node.fy = point.y + offsetY
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      node.fx = null; node.fy = null
      simulation.current?.alphaTarget(0)
      if (dragging) return
      if (node.type === 'term') { onSelectTerm(node.term!.id); onSelectNote(null) }
      else { onSelectNote(node.note!.id); onSelectTerm(null) }
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  const selectedID = selectedTerm !== null ? `t:${selectedTerm}` : selectedNote ? `n:${selectedNote}` : null
  const query = search.trim().toLocaleLowerCase()
  const focus = useMemo(() => {
    const center = hovered ?? selectedID
    if (center) return new Set([center, ...(graph.neighbors.get(center) ?? [])])
    if (query) {
      return new Set(graph.nodes.filter((node) => (node.term?.name ?? node.note?.body ?? '').toLocaleLowerCase().includes(query)).map((node) => node.id))
    }
    return null
  }, [hovered, selectedID, query, graph])
  const center = hovered ?? selectedID
  const topTerms = useMemo(() => new Set(graph.nodes.filter((node) => node.type === 'term').slice(0, 14).map((node) => node.id)), [graph.nodes])
  const hoveredNode = hovered ? graph.nodes.find((node) => node.id === hovered) : undefined
  const presentKinds = useMemo(() => {
    const tally = new Map<string, number>()
    for (const node of graph.nodes) {
      if (!node.term) continue
      const kind = kinds[node.term.kind] ? node.term.kind : 'term'
      tally.set(kind, (tally.get(kind) ?? 0) + 1)
    }
    return [...tally].sort((a, b) => b[1] - a[1])
  }, [graph.nodes])

  return (
    <div className="graph" ref={container}>
      <svg className="graph-svg" width={size.width} height={size.height}>
        <defs>
          <pattern ref={grid} id="graph-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" className="graph-grid-dot" />
          </pattern>
          <radialGradient id="graph-vignette" cx="50%" cy="45%" r="70%">
            <stop offset="0.55" className="graph-vignette-clear" />
            <stop offset="1" className="graph-vignette-edge" />
          </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#graph-grid)" className="graph-backdrop" onPointerDown={startPan} />
        <g ref={layer}>
          <g className="graph-edges">
            {graph.edges.map((edge) => {
              const a = edge.source as GraphNode, b = edge.target as GraphNode
              if (typeof a !== 'object' || typeof b !== 'object') return null
              const lit = center !== null && (a.id === center || b.id === center)
              const dim = focus !== null && !(focus.has(a.id) && focus.has(b.id))
              const ax = a.x ?? 0, ay = a.y ?? 0, bx = b.x ?? 0, by = b.y ?? 0
              const path = edge.kind === 'cooccur'
                ? `M${ax},${ay} Q${(ax + bx) / 2 + (by - ay) * 0.14},${(ay + by) / 2 - (bx - ax) * 0.14} ${bx},${by}`
                : `M${ax},${ay} L${bx},${by}`
              return <path key={edge.id} d={path} className={`graph-edge ${edge.kind} ${lit ? 'lit' : ''} ${dim ? 'dim' : ''}`}
                style={edge.kind === 'cooccur' ? { strokeWidth: Math.min(2.6, 0.8 + edge.weight * 0.35) } : undefined} />
            })}
          </g>
          <g className="graph-nodes">
            {graph.nodes.map((node) => {
              const dim = focus !== null && !focus.has(node.id)
              const selected = node.id === selectedID
              const style = { '--i': Math.min(node.order, 60), ...(node.term ? { '--kind': kindOf(node.term.kind).color } : {}) } as React.CSSProperties
              return (
                <g key={node.id} className={`graph-node ${node.type} ${dim ? 'dim' : ''} ${selected ? 'selected' : ''}`} style={style}
                  transform={`translate(${node.x ?? 0} ${node.y ?? 0})`}
                  onPointerDown={(event) => startDrag(event, node)}
                  onPointerEnter={() => setHovered(node.id)} onPointerLeave={() => setHovered((value) => (value === node.id ? null : value))}>
                  <g className="graph-body">
                    {node.type === 'term' ? (
                      <>
                        <circle className="graph-halo" r={node.r + 5} />
                        <circle className="graph-dot" r={node.r} />
                        {selected && <circle className="graph-ring" r={node.r + 4.5} />}
                      </>
                    ) : (
                      <>
                        <rect className="graph-hit" x={-9} y={-9} width={18} height={18} />
                        <rect className="graph-note" x={-3.6} y={-3.6} width={7.2} height={7.2} rx={1.6} transform="rotate(45)" />
                        {selected && <rect className="graph-ring" x={-7} y={-7} width={14} height={14} rx={3} transform="rotate(45)" />}
                      </>
                    )}
                  </g>
                </g>
              )
            })}
          </g>
          <g className="graph-labels">
            {graph.nodes.map((node) => {
              if (node.type !== 'term') return null
              const show = zoomedIn || topTerms.has(node.id) || (focus?.has(node.id) ?? false)
              if (!show) return null
              const dim = focus !== null && !focus.has(node.id)
              return (
                <text key={node.id} x={node.x ?? 0} y={(node.y ?? 0) + node.r + 14}
                  className={`graph-label ${dim ? 'dim' : ''} ${node.id === center ? 'strong' : ''}`}>{node.term!.name}</text>
              )
            })}
          </g>
        </g>
        <rect width="100%" height="100%" fill="url(#graph-vignette)" pointerEvents="none" />
      </svg>

      <AnimatePresence>
        {hoveredNode?.note && (
          <motion.div key={hoveredNode.id} className="graph-tip" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
            style={{ left: (hoveredNode.x ?? 0) * k.get() + tx.get(), top: (hoveredNode.y ?? 0) * k.get() + ty.get() }}>
            <div className="eyebrow">{dayLabel(hoveredNode.note.created)} · {timeLabel(hoveredNode.note.created)}</div>
            <div className="graph-tip-body">{hoveredNode.note.body.slice(0, 140)}{hoveredNode.note.body.length > 140 ? '…' : ''}</div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="graph-legend">
        {presentKinds.map(([kind, count]) => (
          <span key={kind} className="legend-item"><i style={{ background: kindOf(kind).color }} />{kindOf(kind).label}<b>{count}</b></span>
        ))}
        {counts.notes > 0 && <span className="legend-item"><i className="legend-note" />Dictation<b>{counts.notes}</b></span>}
        {counts.total > counts.notes && <span className="legend-more">Showing latest {counts.notes} of {counts.total}</span>}
      </div>
      <div className="graph-controls">
        <button type="button" className="icon-btn" onClick={() => zoomBy(1 / 1.3)} aria-label="Zoom out" title="Zoom out"><Minus size={15} /></button>
        <button type="button" className="icon-btn" onClick={() => fit(true)} aria-label="Fit graph" title="Fit to window"><Scan size={14} /></button>
        <button type="button" className="icon-btn" onClick={() => zoomBy(1.3)} aria-label="Zoom in" title="Zoom in"><Plus size={15} /></button>
      </div>
    </div>
  )
}

function Inspector({ archive, selectedTerm, selectedNote, onSelectTerm, onSelectNote, onOpenInNotes }: {
  archive: ArchiveModel; selectedTerm: number | null; selectedNote: string | null
  onSelectTerm: (id: number | null) => void; onSelectNote: (id: string | null) => void; onOpenInNotes: (id: string) => void
}) {
  const term = selectedTerm !== null ? archive.termsById.get(selectedTerm) : undefined
  const note = selectedNote ? archive.notesById.get(selectedNote) : undefined
  const connected = useMemo(() => (term ? archive.notes.filter((item) => item.terms.includes(term.id)) : []), [term, archive.notes])
  const related = useMemo(() => {
    if (!term) return []
    return archive.links.filter((link) => link.source === term.id || link.target === term.id)
      .sort((a, b) => b.weight - a.weight).slice(0, 10)
      .map((link) => ({ term: archive.termsById.get(link.source === term.id ? link.target : link.source), weight: link.weight }))
      .filter((item): item is { term: ArchivedTerm; weight: number } => Boolean(item.term))
  }, [term, archive.links, archive.termsById])

  return (
    <aside className="inspector">
      <AnimatePresence mode="popLayout" initial={false}>
        {term ? (
          <motion.div key={`t${term.id}`} className="inspector-inner" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={smooth}>
            <div className="inspector-head">
              <div className="eyebrow kind-eyebrow" style={{ '--kind': kindOf(term.kind).color } as React.CSSProperties}><i />{kindOf(term.kind).label}</div>
              <h2 className="display inspector-title">{term.name}</h2>
              <p className="muted">{term.mentions} {term.mentions === 1 ? 'mention' : 'mentions'} · {connected.length} {connected.length === 1 ? 'dictation' : 'dictations'}</p>
            </div>
            {related.length > 0 && (
              <div className="inspector-block">
                <div className="eyebrow">Often said with</div>
                <div className="chips">
                  {related.map(({ term: other, weight }) => (
                    <TermChip key={other.id} name={other.name} color={kindOf(other.kind).color} meta={weight > 1 ? `×${weight}` : undefined} onClick={() => onSelectTerm(other.id)} />
                  ))}
                </div>
              </div>
            )}
            <div className="inspector-block grow">
              <div className="eyebrow">Dictations</div>
              <div className="inspector-notes">
                {connected.map((item) => (
                  <button key={item.id} type="button" className="inspector-note" onClick={() => { onSelectNote(item.id); onSelectTerm(null) }}>
                    <span className="faint mono">{dayLabel(item.created)} · {timeLabel(item.created)}</span>
                    <span className="inspector-note-body">{item.body}</span>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        ) : note ? (
          <motion.div key={`n${note.id}`} className="inspector-inner scroll" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={smooth}>
            <NoteDetail note={note} archive={archive} compact onOpenTerm={(id) => { onSelectTerm(id); onSelectNote(null) }} onOpenInNotes={onOpenInNotes} />
          </motion.div>
        ) : (
          <motion.div key="hint" className="inspector-inner inspector-hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={smooth}>
            <MousePointerClick size={22} strokeWidth={1.6} className="faint" />
            <h3 className="display">Follow a thread</h3>
            <p className="muted">Pick a term to see where you said it and what it travels with. Diamonds are dictations.</p>
            <ul className="hint-list">
              <li><span>Drag</span> a node to untangle</li>
              <li><span>Pinch</span> or scroll to explore</li>
              <li><span>Hover</span> to light up neighbours</li>
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  )
}
