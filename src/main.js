/**
 * UA knowledge base mobile app — web entry module (Batch 3 foundation).
 *
 * This module must remain free of network and credential-storage side
 * effects at import time; it only builds the baseline UI state shape.
 * The full UI migration is Batch 5.
 */

export function createAppState() {
  return {
    tab: 'home',
    query: '',
    syncing: false,
    activeRevision: null,
    connection: 'unconfigured',
    documents: [],
    artifacts: [],
  };
}