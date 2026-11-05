import type { Component } from 'vue'
import {
  Calendar,
  ChatLineRound,
  CirclePlus,
  Connection,
  Delete,
  Document,
  DocumentAdd,
  Download,
  EditPen,
  FolderOpened,
  Link,
  List,
  Monitor,
  Picture,
  Refresh,
  Search,
  Timer,
  Tools,
} from '@element-plus/icons-vue'

/** 工具名 → 图标。工具组头与工具卡片头共用一份：单工具组省掉组头后，
 *  卡片行仍带图标，扫一眼就知道是哪类工具（与 getToolDisplayName 同口径，未知工具回落 Tools）。 */
const TOOL_ICON_MAP: Record<string, Component> = {
  glob_search: FolderOpened,
  grep_search: Search,
  read_file: Document,
  write_file: DocumentAdd,
  edit_file: EditPen,
  shell: Monitor,
  dump_user_messages: Download,
  ask_user_questions: ChatLineRound,
  task_create: CirclePlus,
  task_update: Refresh,
  task_list: List,
  task_delete: Delete,
  delegate: Connection,
  delegate_followup: Connection,
  spawn_subagent: Connection,
  subagent_followup: Connection,
  check_subagent: Search,
  cancel_subagent: Delete,
  wait_subagents: Timer,
  web_search: Search,
  open_web_page: Link,
  generate_image: Picture,
  edit_image: Picture,
  send_wechat_image: Picture,
  send_wechat_file: Document,
  create_scheduled_task: Calendar,
  update_scheduled_task: Timer,
  delete_scheduled_task: Delete,
  list_scheduled_tasks: List,
}

export function getToolIcon(name: string): Component {
  return TOOL_ICON_MAP[name] ?? Tools
}
