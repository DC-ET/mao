/**
 * 用户与登录契约。
 * 注意：不含 passwordHash 等敏感/内部字段，仅承载返回给客户端的视图数据。
 */
export interface UserInfoVO {
  id?: number;
  username?: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  authSource?: string;
  permissions?: string[];
  isAdmin?: boolean;
}

export interface LoginVO {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: UserInfoVO;
}
