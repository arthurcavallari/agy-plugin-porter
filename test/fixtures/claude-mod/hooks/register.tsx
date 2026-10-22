// UI-mod fixture for the porter's detect-and-report path. The porter must flag
// this module as unported and never copy or run it.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { DeniedCount } from '../types'

const PANE = 'porter-fixture'
const denied = atom({ plugin: 'fixture-claude-mod', key: 'denied' } as const, 0 as DeniedCount)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void $.ui.open({ id: PANE, title: 'Porter fixture' })

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!e.command.includes('porter-fixture-deny')) return next(e)
    await update($, denied, n => n + 1)
    $.ui.status(`porter fixture: denied ${await read($, denied)}`)

    return { deny: `${$.plugin.name}: blocked by fixture policy` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text>PORTER_FIXTURE_MOD_MARKER</Text>
        <Text dimColor>Denied calls: {await read($, denied)}</Text>
      </Box>
    )
  })
}
