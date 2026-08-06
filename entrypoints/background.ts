// Keep the existing background module as the single source of truth during the
// UI migration. Its top-level imports synchronously register all Chrome event
// listeners before WXT finishes evaluating this entrypoint.
import '../src/background/service-worker';

export default defineBackground(() => {
  // Registration and bootstrap hooks live in the imported legacy module.
});
