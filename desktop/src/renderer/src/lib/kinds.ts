export const kinds: Record<string, { label: string; color: string }> = {
  person: { label: 'Person', color: 'var(--kind-person)' },
  project: { label: 'Project', color: 'var(--kind-project)' },
  organization: { label: 'Organization', color: 'var(--kind-organization)' },
  technical: { label: 'Technical', color: 'var(--kind-technical)' },
  topic: { label: 'Topic', color: 'var(--kind-topic)' },
  term: { label: 'Term', color: 'var(--kind-term)' }
}

export function kindOf(kind: string): { label: string; color: string } {
  return kinds[kind] ?? kinds.term
}
