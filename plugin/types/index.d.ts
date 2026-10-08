export type FeathercodeMode = 'build' | 'plan'

declare module 'claude-code' {
  interface PluginState {
    feathercode: { mode: FeathercodeMode; statsVersion: number }
  }
}
