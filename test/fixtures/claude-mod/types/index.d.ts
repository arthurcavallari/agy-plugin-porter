export type DeniedCount = number

declare module 'claude-code' {
  interface PluginState {
    'fixture-claude-mod': { denied: DeniedCount }
  }
}
