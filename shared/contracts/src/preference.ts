/**
 * 用户偏好契约。
 */
export interface WeixinPreferenceVO {
  voiceReply?: boolean;
}

export interface TaskPanelPreferenceState {
  groupOrder: string[];
  collapsedGroups: string[];
}
