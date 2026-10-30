// Linked DSH packages (e.g. ui-primitives) would otherwise resolve React from the DSH
// checkout's node_modules; at runtime the host supplies one React, so tests dedupe it too.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
})
