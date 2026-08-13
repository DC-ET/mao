export function mapToolToType(toolName: string | null | undefined): string {
  if (toolName == null) {
    return 'TOOL';
  }
  switch (toolName.toLowerCase()) {
    case 'read_file':
      return 'READ';
    case 'write_file':
    case 'edit_file':
      return 'EDIT';
    case 'shell':
      return 'RUN';
    case 'glob':
    case 'list':
      return 'EXPLORE';
    case 'task_create':
    case 'task_update':
    case 'task_delete':
    case 'task_list':
      return 'TASK';
    default:
      return 'TOOL';
  }
}

export const ActivityTypeMapper = { mapToolToType };
