import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const PLUGIN = 'side-pane'
const PANE = 'side-pane'
const TITLE = 'Side pane'
const UPDATE_TOOL = 'mcp__side-pane__update'
const CLEAR_TOOL = 'mcp__side-pane__clear'

const markdown = atom({ plugin: 'side-pane', key: 'markdown' } as const, '')
const isRestored = atom({ plugin: 'side-pane', key: 'isRestored' } as const, false)
const hasWarned = atom({ plugin: 'side-pane', key: 'hasWarned' } as const, false)
const isDismissed = atom({ plugin: 'side-pane', key: 'isDismissed' } as const, false)

// $.store is shared by every session, so the last content is kept per working
// directory and parallel sessions never overwrite each other's live pane.
type Saved = { markdown: string; savedAt: string }
const storeKey = (cwd: string) => `last:${cwd}`

const instructions = (maxChars: number) =>
  [
    'Fill the side pane the user sees next to the conversation, so they need not scroll back to recall what "option 2" was.',
    '',
    '- Whenever your reply lists options for the user to pick from, or asks them questions they still have to answer, call this tool first with those items, then write the reply.',
    '- Pass the whole pane each time: it replaces what was there. When the user settles some items, keep the ones still open and add any new question you ask.',
    '- Group by context: a heading per project or topic, then its items, numbered the way you number them in the reply. The topic you are on now goes first.',
    '- When the user moves on from a topic and leaves its items unanswered, move them under a last `## On hold` heading, a few words each. Drop an on-hold item when the user says so, or once a few turns pass without anyone coming back to it.',
    `- Keep it short: a few words per item, no explanations, under ${maxChars} characters. Write in the language you are replying in.`,
    `- Call \`${CLEAR_TOOL}\` only when nothing is left open.`,
    '- Do not mention the pane or the tool calls in your reply.',
  ].join('\n')

// The pane splits into list items, each drawn with its own buttons, and the
// runs of other lines (headings, prose) between them.
type Block = { kind: 'text' | 'item'; text: string }
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/

function blocks(body: string): Block[] {
  const out: Block[] = []
  for (const line of body.split('\n')) {
    if (ITEM.test(line)) {
      out.push({ kind: 'item', text: line.trim() })
      continue
    }
    const last = out[out.length - 1]
    if (last?.kind === 'text') last.text += `\n${line}`
    else if (line.trim() !== '') out.push({ kind: 'text', text: line })
  }
  return out.filter(block => block.text.trim() !== '')
}

const NUDGE = `Whenever your reply lists options for the user or asks them questions, call \`${UPDATE_TOOL}\` first, as its description says.`

async function open($: EngineInterface) {
  if (await read($, isDismissed)) return
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) return
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  if (opened.isPlaced || (await read($, hasWarned))) return
  await update($, hasWarned, () => true)
  $.ui.toast('side-pane: no room to open the pane unasked; run /side-pane to show it', {
    timeoutMs: 8000,
  })
}

async function show($: EngineInterface, text: string) {
  await update($, markdown, () => text)
  await update($, isRestored, () => false)
  const cwd = await $.session.cwd()
  if (text === '') await $.store.delete(storeKey(cwd))
  else await $.store.set(storeKey(cwd), { markdown: text, savedAt: new Date().toISOString() })
}

export const register: Register = (on, options) => {
  const autoOpen = options.autoOpen !== false
  const maxChars = Math.max(200, Number(options.maxChars) || 3000)

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'update',
      description: instructions(maxChars),
      inputSchema: {
        type: 'object',
        properties: {
          markdown: {
            type: 'string',
            description: 'The whole pane as Markdown: headings per context, numbered items.',
          },
        },
        required: ['markdown'],
      },
    })
    await $.tool.register({
      name: 'clear',
      description: 'Empty the side pane once nothing in it is open any more.',
    })
    await $.command.register({
      name: 'side-pane',
      description: 'Show or hide the side pane (`clear` empties it)',
      argumentHint: '[clear]',
      immediate: true,
    })

    // A fresh session starts empty; show the last pane of this directory so a
    // resumed conversation has it back. A hot reload keeps its own state.
    if ((await read($, markdown)) === '') {
      const saved = (await $.store.get(storeKey(e.cwd))) as Saved | undefined
      if (saved?.markdown) {
        await update($, markdown, () => saved.markdown)
        await update($, isRestored, () => true)
      }
    }

    return next(e)
  })

  // The rules ride in the tool's own description, kept out of ToolSearch: a
  // managed plugin may bypass a user plugin's prompt.context and
  // prompt.compose hooks, and a deferred tool shows the model only its name.
  on('tool.describe', { tool: UPDATE_TOOL }, async ($, e, next) => {
    const described = await next(e)

    return { ...described, isDeferred: false }
  })

  // A one-line nudge where the session lets user plugins add context.
  on('prompt.context', async ($, e, next) => {
    const context = await next(e)

    return { ...context, blocks: [...context.blocks, { name: PLUGIN, text: NUDGE }] }
  })

  on('tool.call', { tool: UPDATE_TOOL }, async ($, e) => {
    if (typeof e.markdown !== 'string') return { deny: 'markdown must be a string.' }
    const text = e.markdown.trim()
    const isCut = text.length > maxChars
    await show($, isCut ? text.slice(0, maxChars) : text)
    if (autoOpen && text !== '') await open($)

    return {
      result: isCut
        ? `Side pane updated, cut to ${maxChars} characters. Shorten it next time.`
        : 'Side pane updated.',
    }
  })

  on('tool.call', { tool: CLEAR_TOOL }, async $ => {
    await show($, '')

    return { result: 'Side pane cleared.' }
  })

  // /side-pane toggles: closing it also stops updates reopening it this session.
  // A pane still waiting for room, or behind another tab, counts as hidden.
  on('command.run', { command: 'side-pane' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await show($, '')
      return { text: 'Side pane cleared.' }
    }
    if (arg !== '')
      return { text: 'Usage: /side-pane toggles the pane; /side-pane clear empties it.' }
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE && pane.isPlaced && pane.isShown)) {
      await update($, isDismissed, () => true)
      await $.ui.close({ id: PANE })
      return { text: 'Side pane closed; /side-pane shows it again.' }
    }
    await update($, isDismissed, () => false)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Side pane opened.' }
  })

  // Once the person closes the pane (its close mark, ctrl+x x), updates stop
  // reopening it for this session; /side-pane brings it back.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, isDismissed, () => true)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown, Button } = $.ui.resolve(e)
    const body = await read($, markdown)
    const restored = await read($, isRestored)

    // Desktop draws the pane with no text selection, so each item carries its
    // own copy and quote buttons; the person can still select in a terminal.
    const copy = async (text: string) => {
      const copied = await $.ui.copy({ text, surface: e.surface })
      if (!copied.isCopied) $.ui.toast(`side-pane: could not copy (${copied.reason})`)
    }
    const quote = async (text: string) => {
      const filled = await $.prompt.fill({ text: `> ${text}\n`, mode: 'insert' })
      if (!filled.isFilled) $.ui.toast('side-pane: the prompt box is not taking text right now')
    }

    return (
      <Box flexDirection="column">
        {body.trim() === '' ? (
          <Text dimColor>Nothing open. Claude fills this pane when it asks you to choose.</Text>
        ) : (
          <Box flexDirection="column">
            {restored && <Text dimColor>From an earlier session here</Text>}
            {blocks(body).map((block, i) =>
              block.kind === 'text' ? (
                <Markdown key={`text:${i}`} text={block.text} />
              ) : (
                <Box key={`item:${i}`} flexDirection="row" columnGap={1}>
                  <Box flexGrow={1}>
                    <Markdown text={block.text} />
                  </Box>
                  <Button key={`copy:${i}`} plain dimColor onPress={() => copy(block.text)}>
                    copy
                  </Button>
                  <Button key={`quote:${i}`} plain dimColor onPress={() => quote(block.text)}>
                    quote
                  </Button>
                </Box>
              ),
            )}
            <Box flexDirection="row">
              <Button key="copy-all" plain dimColor onPress={() => copy(body)}>
                copy all
              </Button>
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
