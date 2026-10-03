import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const SRC = '/private/tmp/claude-1/proj/abc-123/images/1.png'

function stub(on: On) {
  const clock = mock.clock(on)
  // Stands in for the engine's own message row.
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  on('session.id', () => ({ value: 'abc-123' }))
  on('process.run', ($, e) => {
    const [cmd] = e.argv
    const stdout =
      cmd === '/bin/sh' ? `${SRC}\n` : cmd === 'sips' && e.argv.includes('-g') ? 'pixelWidth: 2\n  pixelHeight: 2\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: { base64: PNG } }))
  return clock
}

test('previews a sent image under its message in the transcript', async ($, on) => {
  const clock = stub(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.prompt.submit({ text: 'look [Image #1]', wait: false, origin: { kind: 'composer' } })
  await clock.advance(1)

  const row = await $.ui.mount({
    plugin: 'image-peek',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: 'look [Image #1]', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect(await row.find({ type: 'Image' })).toBeDefined()
  expect(await row.find({ text: 'look [Image #1]' })).toBeDefined()
})

test('leaves messages without images to the engine', async ($, on) => {
  stub(on)
  const row = await $.ui.mount({
    plugin: 'image-peek',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: 'no pictures here', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect(await row.find({ type: 'Image' })).toBeUndefined()
})
