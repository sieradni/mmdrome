// Pins for the shortcuts-sheet keyboard gate (keyboardHelp.ts, F2): `?` opens
// the sheet, typing into an editor never does, a held modifier never does,
// Esc never does, and an ordinary key never does. The gate is DOM-free (type
// refs only) so the whole matrix runs in Node.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SHORTCUTS_HELP_SHORTCUT,
  isHelperInput,
  shouldOpenShortcuts,
} from '../src/lib/keyboardHelp'

// A non-editor target: as plain an object as will satisfy the signature.
const body = () => ({ tagName: 'DIV', isContentEditable: false, closest: () => null }) as unknown as HTMLElement

const key = (over: Record<string, unknown>) =>
  ({ key: '?', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...over }) as unknown as KeyboardEvent

test('`?` opens the sheet (shift-layout safe: the key itself is `?`)', () => {
  assert.equal(shouldOpenShortcuts(key({ key: '?', shiftKey: true }), body()), true)
  assert.equal(shouldOpenShortcuts(key({ key: '?' }), body()), true)
  assert.equal(SHORTCUTS_HELP_SHORTCUT, '?')
})

test('typing into an editor never opens the sheet', () => {
  const input = { tagName: 'INPUT', isContentEditable: false, closest: () => null } as unknown as HTMLElement
  const textarea = { tagName: 'TEXTAREA', isContentEditable: false, closest: () => null } as unknown as HTMLElement
  const nested = { tagName: 'SPAN', isContentEditable: false, closest: (sel: string) => (sel.includes('input') ? {} : null) } as unknown as HTMLElement
  assert.equal(shouldOpenShortcuts(key({}), input), false)
  assert.equal(shouldOpenShortcuts(key({}), textarea), false)
  assert.equal(shouldOpenShortcuts(key({}), nested), false)
})

test('a held modifier never opens the sheet', () => {
  assert.equal(shouldOpenShortcuts(key({ ctrlKey: true }), body()), false)
  assert.equal(shouldOpenShortcuts(key({ metaKey: true }), body()), false)
  assert.equal(shouldOpenShortcuts(key({ altKey: true }), body()), false)
})

test('Esc never opens the sheet, and neither does an ordinary key', () => {
  assert.equal(shouldOpenShortcuts(key({ key: 'Escape' }), body()), false)
  assert.equal(shouldOpenShortcuts(key({ key: 'a' }), body()), false)
  assert.equal(shouldOpenShortcuts(key({ key: '/' }), body()), false)
})

test('isHelperInput detects editors and null targets', () => {
  assert.equal(isHelperInput(null), false)
  assert.equal(isHelperInput({ tagName: 'DIV', isContentEditable: true } as unknown as HTMLElement), true)
  assert.equal(isHelperInput({ tagName: 'SELECT', isContentEditable: false } as unknown as HTMLElement), true)
  assert.equal(isHelperInput(body()), false)
})
