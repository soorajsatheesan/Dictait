import type { Transition } from 'motion/react'

/** Critically damped by default; bounce is reserved for the island, which carries momentum. */
export const snappy: Transition = { type: 'spring', bounce: 0, visualDuration: 0.24 }
export const smooth: Transition = { type: 'spring', bounce: 0, visualDuration: 0.38 }
export const gentle: Transition = { type: 'spring', bounce: 0.12, visualDuration: 0.42 }
export const island: Transition = { type: 'spring', bounce: 0.22, visualDuration: 0.46 }
