// Negative UI-mod fixture: it only decorates assistant messages in the transcript,
// which Antigravity has no render site for. The porter must refuse it, with a reason.
export function register(on) {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { dimColor: true }, 'PORTER_FIXTURE_TRANSCRIPT_MARKER')
  })
}
