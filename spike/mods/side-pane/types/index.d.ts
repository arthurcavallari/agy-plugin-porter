declare module 'claude-code' {
  interface PluginState {
    'side-pane': {
      // What the model last put in the pane.
      markdown: string
      // True when markdown came from an earlier session in this directory.
      isRestored: boolean
      // True once this session told the person the pane could not be placed.
      hasWarned: boolean
      // True once the person closed the pane, so updates stop reopening it.
      isDismissed: boolean
    }
  }
}
