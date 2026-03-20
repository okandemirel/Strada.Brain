import { describe, expect, it } from 'vitest'
import {
  buildModelSwitchCommand,
} from './useWebSocket'

describe('buildModelSwitchCommand', () => {
  it('preserves slash-delimited model ids for provider workers that use path-style names', () => {
    expect(
      buildModelSwitchCommand('fireworks', 'accounts/fireworks/models/llama4-maverick-instruct-basic'),
    ).toBe('/model fireworks/accounts/fireworks/models/llama4-maverick-instruct-basic')
  })

  it('sanitizes unsafe characters without breaking valid model separators', () => {
    expect(
      buildModelSwitchCommand('together<script>', 'meta-llama/Llama-4-Maverick-17B-128E-Instruct??'),
    ).toBe('/model togetherscript/meta-llama/Llama-4-Maverick-17B-128E-Instruct')
  })
})
