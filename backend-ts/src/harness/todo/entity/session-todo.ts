export interface SessionTodo {
  id?: number;
  sessionId: number;
  content?: string | null;
  description?: string | null;
  activeForm?: string | null;
  status?: string | null;
  sortOrder?: number | null;
  owner?: string | null;
  claimedAt?: string | null;
  blockedBy?: string | null;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}
