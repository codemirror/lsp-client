import type * as lsp from "vscode-languageserver-protocol"
import {StateField, StateEffect, Extension, RangeSetBuilder} from "@codemirror/state"
import {EditorView, ViewPlugin, ViewUpdate, DecorationSet, Decoration} from "@codemirror/view"
import {LSPPlugin} from "./plugin"
import {toPosition} from "./pos"

const debounceTimeMs: number = 100

const semanticTokensPlugin = ViewPlugin.fromClass(class {
  debounceTimer: number = 0
  pendingRequest: Promise<lsp.SemanticTokens | null> | null = null

  update(update: ViewUpdate): void {
    const plugin = LSPPlugin.get(update.view)
    if (!plugin) return

    if (!plugin.client.config.highlightSemanticTokens) return

    const semanticTokensProvider = plugin.client.serverCapabilities?.semanticTokensProvider
    if (!semanticTokensProvider) return
    if (!semanticTokensProvider.full && !semanticTokensProvider.range)  return

    const state = update.view.state.field(semanticTokensState)
    if (state == null) {
      this.startRequest(plugin, update.view)
      return
    }

    if (!update.docChanged) return

    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.startRequest(plugin, update.view)
    }, debounceTimeMs)
  }

  startRequest(plugin: LSPPlugin, view: EditorView): void {
    if (this.pendingRequest != null) {
      // There is a pending request on an older document state that should
      // be cancelled here.
    }

    plugin.client.sync()

    const supportRangeRequest = !!plugin.client.serverCapabilities?.semanticTokensProvider?.range
    const promise = supportRangeRequest ? 
      plugin.client.request<lsp.SemanticTokensRangeParams, lsp.SemanticTokens | null>("textDocument/semanticTokens/range", {
        textDocument: {uri: plugin.uri},
        range: {
          start: {line: 0, character: 0},
          end: toPosition(view.state.doc, view.state.doc.length),
        },
      })
      : plugin.client.request<lsp.SemanticTokensParams, lsp.SemanticTokens | null>("textDocument/semanticTokens/full", {
        textDocument: {uri: plugin.uri},
      })
    this.pendingRequest = promise
    promise.then((data) => {
      if (this.pendingRequest == promise) {
        this.pendingRequest = null
        this.handleResponse(data, plugin, view)
      }
    }).catch((err) => {
      if (this.pendingRequest == promise) {
        this.pendingRequest = null
      }
      if ("code" in err && (err as lsp.ResponseError).code == -32800 /* RequestCancelled */)
        return
      throw err
    })
  }

  handleResponse(
    semanticTokens: lsp.SemanticTokens | null, 
    plugin: LSPPlugin, 
    view: EditorView,
  ): void {
    if (!semanticTokens) return
    if (semanticTokens.data.length % 5) return

    const semanticTokensProvider = plugin.client.serverCapabilities?.semanticTokensProvider!
    const tokenTypeLegend = semanticTokensProvider.legend.tokenTypes
    const tokenModifierLegend = semanticTokensProvider.legend.tokenModifiers
    
    const builder = new RangeSetBuilder<Decoration>()

    let lineStart = 0
    let line = 0
    let character = 0

    const data = semanticTokens.data
    for (let i = 0; i < data.length; i += 5) {
      const deltaLine = data[i]
      const deltaStartChar = data[i + 1]
      const length = data[i + 2]
      const tokenType = data[i + 3]
      const tokenModifierBitSet = data[i + 4]

      line += deltaLine
      if (deltaLine != 0) {
        lineStart = view.state.doc.line(line + 1).from
        character = 0
      }
      character += deltaStartChar

      let modifiers = []
      let value = tokenModifierBitSet
      let index = 0
      while (value != 0) {
        if (value & 1) {
          modifiers.push(tokenModifierLegend[index])
        }
        value = value >> 1
        index += 1
      }

      const from = lineStart + character
      const to = from + length
      const decoration = plugin.client.config.highlightSemanticTokens!(
        plugin,
        from,
        to,
        tokenTypeLegend[tokenType],
        modifiers,
      )
      builder.add(from, to, decoration)
    }
    view.dispatch({effects: [semanticTokensEffect.of(builder.finish())]})
  }

  destroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
  }
})

const semanticTokensState = StateField.define<DecorationSet | null>({
  create() {
    return null
  },
  update(decorations, tr) {
    for (let e of tr.effects) if (e.is(semanticTokensEffect)) {
      decorations = e.value
    }
    if (decorations && tr.docChanged) {
      return decorations.map(tr.changes)
    }
    return decorations
  },
  provide: f => EditorView.decorations.from(f, set => set ?? Decoration.none),
})

const semanticTokensEffect = StateEffect.define<DecorationSet>({})

export function semanticTokens(): Extension {
  return [
    semanticTokensState,
    semanticTokensPlugin,
  ]
}
