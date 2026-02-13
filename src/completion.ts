import type * as lsp from "vscode-languageserver-protocol"
import {EditorState, Extension, Facet} from "@codemirror/state"
import {CompletionSource, Completion, CompletionContext, snippet, autocompletion} from "@codemirror/autocomplete"
import {LSPPlugin} from "./plugin"

/// Register the [language server completion
/// source](#lsp-client.serverCompletionSource) as an autocompletion
/// source.
export function serverCompletion(config: {
  /// By default, the completion source that asks the language server
  /// for completions is added as a regular source, in addition to any
  /// other sources. Set this to true to make it replace all
  /// completion sources.
  override?: boolean
  /// Set a custom
  /// [`validFor`](#autocomplete.CompletionResult.validFor) expression
  /// to use in the completion results. By default, the library uses an
  /// expression that accepts word characters, optionally prefixed by
  /// any non-word prefixes found in the results.
  validFor?: RegExp
} = {}): Extension {
  let result: Extension[]
  if (config.override) {
    result = [autocompletion({override: [serverCompletionSource]})]
  } else {
    let data = [{autocomplete: serverCompletionSource}]
    result = [autocompletion(), EditorState.languageData.of(() => data)]
  }
  if (config.validFor) result.push(completionConfig.of({validFor: config.validFor}))
  return result
}

const completionConfig = Facet.define<{validFor: RegExp}, {validFor: RegExp | null}>({
  combine: results => results.length ? results[0] : {validFor: null}
})

function getCompletions(plugin: LSPPlugin, pos: number, context: lsp.CompletionContext, abort?: CompletionContext) {
  if (plugin.client.hasCapability("completionProvider") === false) return Promise.resolve(null)
  plugin.client.sync()
  let params: lsp.CompletionParams = {
    position: plugin.toPosition(pos),
    textDocument: {uri: plugin.uri},
    context
  }
  if (abort) abort.addEventListener("abort", () => plugin.client.cancelRequest(params))
  return plugin.client.request<lsp.CompletionParams, lsp.CompletionItem[] | lsp.CompletionList | null>(
    "textDocument/completion", params)
}

// Look for non-alphanumeric prefixes in the completions, and return a
// regexp that matches them, to use in validFor
function prefixRegexp(items: readonly lsp.CompletionItem[]) {
  let step = Math.ceil(items.length / 50), prefixes: string[] = []
  for (let i = 0; i < items.length; i += step) {
    let item = items[i], text = item.textEdit?.newText || item.textEditText || item.insertText || item.label
    if (!/^\w/.test(text)) {
      let prefix = /^[^\w]*/.exec(text)![0]
      if (prefixes.indexOf(prefix) < 0) prefixes.push(prefix)
    }
  }
  if (!prefixes.length) return /^\w*$/
  return new RegExp("^(?:" + prefixes.map((RegExp as any).escape || (s => s.replace(/[^\w\s]/g, "\\$&"))).join("|") + ")?\\w*$")
}

/// A completion source that requests completions from a language
/// server.
export const serverCompletionSource: CompletionSource = context => {
  const plugin = context.view && LSPPlugin.get(context.view)
  if (!plugin) return null
  let triggerChar = ""
  if (!context.explicit) {
    triggerChar = context.view.state.sliceDoc(context.pos - 1, context.pos)
    let triggers = plugin.client.serverCapabilities?.completionProvider?.triggerCharacters
    if (!/[a-zA-Z_]/.test(triggerChar) && !(triggers && triggers.indexOf(triggerChar) > -1)) return null
  }
  return getCompletions(plugin, context.pos, {
    triggerCharacter: triggerChar,
    triggerKind: context.explicit ? 1 /* Invoked */ : 2 /* TriggerCharacter */
  }, context).then(result => {
    if (!result) return null
    if (Array.isArray(result)) result = {items: result} as lsp.CompletionList
    let {from, to} = completionResultRange(context, result)
    let defaultCommitChars = result.itemDefaults?.commitCharacters
    let config = context.state.facet(completionConfig)

    return {
      from, to,
      options: result.items.map<Completion>(item => {
        let text = item.textEdit?.newText || item.textEditText || item.insertText || item.label
        let option: Completion = {
          label: text,
          type: item.kind && kindToType[item.kind],
        }
        if (item.commitCharacters && item.commitCharacters != defaultCommitChars)
          option.commitCharacters = item.commitCharacters
        if (item.detail) option.detail = item.detail
        if (item.sortText) option.sortText = item.sortText
        if (item.insertTextFormat == 2 /* Snippet */) {
          option.apply = (view, c, from, to) => snippet(text.replace(/\$(\d+)/g, "${$1}"))(view, c, from, to)
          option.label = item.label
        }
        if (item.documentation) option.info = () => renderDocInfo(plugin, item.documentation!)
        return option
      }),
      commitCharacters: defaultCommitChars,
      validFor: config.validFor ?? prefixRegexp(result.items),
      map: (result, changes) => ({...result, from: changes.mapPos(result.from)}),
    }
  }, err => {
    if ("code" in err && (err as lsp.ResponseError).code == -32800 /* RequestCancelled */)
      return null
    throw err
  })
}

function completionResultRange(cx: CompletionContext, result: lsp.CompletionList): {from: number, to: number} {
  if (!result.items.length) return {from: cx.pos, to: cx.pos}
  let defaultRange = result.itemDefaults?.editRange, item0 = result.items[0]
  let range = defaultRange ? ("insert" in defaultRange ? defaultRange.insert : defaultRange)
    : item0.textEdit ? ("range" in item0.textEdit ? item0.textEdit.range : item0.textEdit.insert)
    : null
  if (!range) return cx.state.wordAt(cx.pos) || {from: cx.pos, to: cx.pos}
  let line = cx.state.doc.lineAt(cx.pos)
  return {from: line.from + range.start.character, to: line.from + range.end.character}
}

function renderDocInfo(plugin: LSPPlugin, doc: string | lsp.MarkupContent) {
  let elt = document.createElement("div")
  elt.className = "cm-lsp-documentation cm-lsp-completion-documentation"
  elt.innerHTML = plugin.docToHTML(doc)
  return elt
}

const kindToType: {[kind: number]: string} = {
  1: "text", // Text
  2: "method", // Method
  3: "function", // Function
  4: "class", // Constructor
  5: "property", // Field
  6: "variable", // Variable
  7: "class", // Class
  8: "interface", // Interface
  9: "namespace", // Module
  10: "property", // Property
  11: "keyword", // Unit
  12: "constant", // Value
  13: "constant", // Enum
  14: "keyword", // Keyword
  16: "constant", // Color
  20: "constant", // EnumMember
  21: "constant", // Constant
  22: "class", // Struct
  25: "type" // TypeParameter
}
