import { Node, mergeAttributes } from '@tiptap/core'

export interface QuickCommandOptions {
  HTMLAttributes: Record<string, any>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    quickCommand: {
      insertQuickCommand: (attrs: { commandType: 'skill' | 'command'; commandName: string }) => ReturnType
    }
  }
}

export const QuickCommandNode = Node.create<QuickCommandOptions>({
  name: 'quickCommand',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: false,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
    }
  },

  addAttributes() {
    return {
      commandType: {
        default: 'skill',
        parseHTML: (element) => element.getAttribute('data-command-type'),
        renderHTML: (attributes) => ({ 'data-command-type': attributes.commandType }),
      },
      commandName: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-command-name'),
        renderHTML: (attributes) => ({ 'data-command-name': attributes.commandName }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-quick-command]' }]
  },

  renderHTML({ HTMLAttributes }) {
    // addAttributes.renderHTML transforms commandType → data-command-type, etc.
    const type = (HTMLAttributes['data-command-type'] ?? HTMLAttributes.commandType) as string
    const name = (HTMLAttributes['data-command-name'] ?? HTMLAttributes.commandName) as string
    return [
      'span',
      mergeAttributes(
        { 'data-quick-command': '' },
        this.options.HTMLAttributes,
        HTMLAttributes,
        { class: `editor-tag editor-tag-${type}` },
      ),
      name,
    ]
  },

  renderText({ node }) {
    const { commandType, commandName } = node.attrs as { commandType: string; commandName: string }
    return commandType === 'skill'
      ? `\${${commandName}}$`
      : `#{${commandName}}#`
  },

  addCommands() {
    return {
      insertQuickCommand:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs,
          })
        },
    }
  },
})
