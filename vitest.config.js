import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Vite's Windows realpath shortcut spawns `net use` via
    // child_process.exec (piped stdio), which the DSH sandbox denies
    // with EPERM during config bundling and file resolution.
    // preserveSymlinks bypasses that code path entirely.
    preserveSymlinks: true,
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.js'],
    // worker_threads-based pool; the default 'forks' pool uses
    // named-pipe IPC, which the DSH sandbox denies (EPERM on spawn).
    pool: 'threads',
  },
});