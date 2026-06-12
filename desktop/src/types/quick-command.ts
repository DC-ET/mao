export interface QuickCommand {
  type: 'skill' | 'command'
  name: string
  description: string
}

export interface QuickCommandsData {
  skills: QuickCommand[]
  commands: QuickCommand[]
}
