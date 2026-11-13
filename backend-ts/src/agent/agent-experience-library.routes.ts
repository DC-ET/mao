import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import type { AgentService } from './agent.service.js';
import type { ExperienceDocMeta, ExperienceIndexService } from '../harness/experience/experience-index.service.js';

/**
 * Agent 团队经验库管理接口（技术方案 2026-10-24 §4.1；列表能力参数化见 2026-11-13 §4）。
 *
 * 直接操作 <shareDir>/agent-experience/<agentId>/ 下的子文档与索引；
 * 开关（experience_library_enabled）只改标记位，挂载/注入在会话创建与上下文装配点按位判定。
 * enabled=0 时文档接口仍可用——admin 可先整理内容再开启。
 */
export interface AgentExperienceLibraryRouteDeps {
  agentService: AgentService;
  /** 总览端点批量取 Agent 名称与开关（findByIds 含 notDeleted 过滤，软删 Agent 的库归孤儿）。 */
  agentRepository: { findByIds(ids: number[]): Promise<Array<{ id?: number; name: string; experienceLibraryEnabled?: number | null }>> };
  experienceIndexService: ExperienceIndexService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

interface SaveDocRequest {
  fileName?: string | null;
  content?: string | null;
}

/** 排序字段白名单（服务端校验，不校验会透传进比较器）。 */
const SORT_FIELDS = ['fileName', 'title', 'updatedAt', 'sizeBytes', 'lastVerified'] as const;
type SortField = (typeof SORT_FIELDS)[number];
const ORDERS = ['asc', 'desc'] as const;
type SortOrder = (typeof ORDERS)[number];
const GROUP_BY = ['none', 'month', 'keyword'] as const;
type GroupBy = (typeof GROUP_BY)[number];
/** 异常文档筛选（巡检 Agent 沉淀质量）：无 frontmatter = 五字段全空（解析失败回落空值的同口径）；'' = 不过滤。 */
const ABNORMAL = ['', 'no-frontmatter', 'no-title'] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** 每页上限与 facets 条数是响应体规模护栏（单库文档量级 ≤ 数百）。 */
const MAX_PAGE_SIZE = 100;
const KEYWORD_FACET_LIMIT = 50;
const NO_MONTH_GROUP = '未命名';
const NO_KEYWORD_GROUP = '未分类';

/**
 * ISO 时间串 → UTC+8 日期（YYYY-MM-DD）。admin 的更新时间列与 daterange 控件都按固定
 * +08:00 展示/取值（admin utils/datetime），mtime 的 ISO 串是 UTC——直接 slice(0,10) 取
 * UTC 日期会让 +08:00 下 00:00-08:00 修改的文件在日期边界筛错一天。
 */
function beijingDateOf(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  return new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * keywords 拆分：按中英文逗号/顿号/分号切分（frontmatter 解析不强制分隔符，
 * Agent 旁路写入中文标点常见），过滤空串后保序去重（技术方案 2026-11-13 C1）。
 */
function splitKeywords(keywords: string): string[] {
  if (keywords === '') return [];
  const out: string[] = [];
  for (const part of keywords.split(/[\s]*[,，、;；][\s]*/)) {
    const tag = part.trim();
    if (tag !== '' && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function requireIntParam(raw: unknown, name: string, min: number, max: number, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 必须是 ${min}-${max} 的整数`);
  }
  return value;
}

function requireEnumParam<T extends string>(raw: unknown, name: string, allowed: readonly T[], fallback: T): T {
  if (raw == null || raw === '') return fallback;
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 取值必须是 ${allowed.join('/')}`);
  }
  return raw as T;
}

function requireDateParam(raw: unknown, name: string): string {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string' || !DATE_PATTERN.test(raw)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 必须是 YYYY-MM-DD 日期`);
  }
  return raw;
}

function requireSearchParam(raw: unknown, name: string, maxLen: number): string {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 必须是字符串`);
  }
  if (raw.length > maxLen) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 长度不能超过 ${maxLen}`);
  }
  return raw;
}

/** title/lastVerified 为空的文档不参与值比较，恒排列表末尾（与升降序方向无关）。 */
function isSortValueEmpty(doc: ExperienceDocMeta, sort: SortField): boolean {
  return (sort === 'title' || sort === 'lastVerified') && doc[sort] === '';
}

function compareDocs(a: ExperienceDocMeta, b: ExperienceDocMeta, sort: SortField): number {
  if (sort === 'sizeBytes') return a.sizeBytes - b.sizeBytes;
  // fileName/title 是中文主场景，用 localeCompare；updatedAt（ISO 串）/lastVerified
  // （YYYY-MM-DD）格式固定，字典序即时间序，用普通比较
  if (sort === 'fileName' || sort === 'title') return a[sort].localeCompare(b[sort]);
  if (a[sort] < b[sort]) return -1;
  if (a[sort] > b[sort]) return 1;
  return 0;
}

function sortDocs(docs: ExperienceDocMeta[], sort: SortField, order: SortOrder): ExperienceDocMeta[] {
  const dir = order === 'asc' ? 1 : -1;
  return [...docs].sort((a, b) => {
    const aEmpty = isSortValueEmpty(a, sort);
    const bEmpty = isSortValueEmpty(b, sort);
    if (aEmpty || bEmpty) {
      if (aEmpty && bEmpty) return 0;
      return aEmpty ? 1 : -1;
    }
    return compareDocs(a, b, sort) * dir;
  });
}

function groupKeyOf(doc: ExperienceDocMeta, groupBy: Exclude<GroupBy, 'none'>): string {
  if (groupBy === 'month') {
    // 文件名日期前缀是路标软约定，无前缀的归「未命名」组
    return /^(\d{4}-\d{2})/.exec(doc.fileName)?.[1] ?? NO_MONTH_GROUP;
  }
  return splitKeywords(doc.keywords)[0] ?? NO_KEYWORD_GROUP;
}

function sortGroupCounts(
  counts: Array<{ key: string; count: number }>,
  groupBy: Exclude<GroupBy, 'none'>,
): Array<{ key: string; count: number }> {
  const noGroup = groupBy === 'month' ? NO_MONTH_GROUP : NO_KEYWORD_GROUP;
  return counts.sort((a, b) => {
    if (a.key === noGroup) return 1;
    if (b.key === noGroup) return -1;
    if (groupBy === 'month') return b.key.localeCompare(a.key); // 月份倒序（新经验在前）
    return b.count - a.count || a.key.localeCompare(b.key);
  });
}

export function registerAgentExperienceLibraryRoutes(app: FastifyInstance, deps: AgentExperienceLibraryRouteDeps): void {
  const { agentService, agentRepository, experienceIndexService, permissionService } = deps;

  async function requireAgentWrite(request: Parameters<typeof requireUserId>[0]): Promise<number> {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:write');
    return userId;
  }

  /** 校验 Agent 存在并返回其库目录（getAgent 不存在时抛 AGENT_NOT_FOUND）。 */
  async function requireAgentDir(agentId: number): Promise<{ agentDir: string; enabled: boolean }> {
    const agent = await agentService.getAgent(agentId);
    return {
      agentDir: experienceIndexService.dirFor(agentId),
      enabled: (agent.experienceLibraryEnabled ?? 1) === 1,
    };
  }

  function requireDocFileName(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'file 不能为空');
    }
    // basename 约束：拒绝路径分隔符 / .. / 反斜杠（防目录穿越），必须 .md 结尾
    if (raw.includes('/') || raw.includes('\\') || raw.includes('..') || !raw.toLowerCase().endsWith('.md')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'file 必须是 .md 结尾的文件名（不含路径）');
    }
    return raw;
  }

  // 跨库总览：具名静态子路径（Fastify 静态段优先于 :id 参数段，见技术方案 §4.1 注册顺序注记）
  app.get('/v1/agents/experience-library/overview', async (request, reply) => {
    const userId = requireUserId(request);
    // 新增跨库聚合暴露面（单库 → 全部 Agent 库元数据），不继承 GET docs 仅登录的旧口径
    await requirePermission(permissionService, userId, 'agent:read');
    const stats = experienceIndexService.overviewLibraries();
    const agents = await agentRepository.findByIds(stats.map((s) => s.agentId));
    const agentById = new Map(agents.filter((a) => a.id != null).map((a) => [a.id as number, a]));
    const libraries: Array<{ agentId: number; agentName: string; enabled: boolean; docCount: number; totalBytes: number; lastUpdatedAt: string }> = [];
    const orphans: Array<{ agentId: number; docCount: number; totalBytes: number; lastUpdatedAt: string }> = [];
    for (const stat of stats) {
      const agent = agentById.get(stat.agentId);
      if (agent == null) {
        orphans.push({ agentId: stat.agentId, docCount: stat.docCount, totalBytes: stat.totalBytes, lastUpdatedAt: stat.lastUpdatedAt });
        continue;
      }
      libraries.push({
        agentId: stat.agentId,
        agentName: agent.name,
        enabled: (agent.experienceLibraryEnabled ?? 1) === 1,
        docCount: stat.docCount,
        totalBytes: stat.totalBytes,
        lastUpdatedAt: stat.lastUpdatedAt,
      });
    }
    libraries.sort((a, b) => a.agentId - b.agentId);
    orphans.sort((a, b) => a.agentId - b.agentId);
    return sendOk(reply, { libraries, orphans });
  });

  app.patch('/v1/agents/:id/experience-library', async (request, reply) => {
    await requireAgentWrite(request);
    const body = bodyOf<{ enabled?: boolean }>(request);
    if (typeof body.enabled !== 'boolean') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'enabled 必须为布尔值');
    }
    const agent = await agentService.setExperienceLibraryEnabled(pathId(request), body.enabled);
    return sendOk(reply, { enabled: (agent.experienceLibraryEnabled ?? 1) === 1 });
  });

  app.get('/v1/agents/:id/experience-library/docs', async (request, reply) => {
    requireUserId(request);
    const { agentDir, enabled } = await requireAgentDir(pathId(request));
    const q = request.query as Record<string, unknown>;
    const page = requireIntParam(q.page, 'page', 1, 1_000_000, 1);
    const size = requireIntParam(q.size, 'size', 1, MAX_PAGE_SIZE, 20);
    const sort = requireEnumParam(q.sort, 'sort', SORT_FIELDS, 'fileName');
    const order = requireEnumParam(q.order, 'order', ORDERS, 'desc');
    const groupBy = requireEnumParam(q.groupBy, 'groupBy', GROUP_BY, 'none');
    const abnormal = requireEnumParam(q.abnormal, 'abnormal', ABNORMAL, '');
    const keyword = requireSearchParam(q.keyword, 'keyword', 200);
    const tag = requireSearchParam(q.tag, 'tag', 60);
    const verifiedFrom = requireDateParam(q.verifiedFrom, 'verifiedFrom');
    const verifiedTo = requireDateParam(q.verifiedTo, 'verifiedTo');
    const updatedFrom = requireDateParam(q.updatedFrom, 'updatedFrom');
    const updatedTo = requireDateParam(q.updatedTo, 'updatedTo');

    const all = experienceIndexService.listDocs(agentDir);

    // tag facets（全库未过滤口径，供筛选下拉）
    const tagCounts = new Map<string, number>();
    for (const doc of all) {
      for (const t of splitKeywords(doc.keywords)) {
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
    }
    const keywords = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, KEYWORD_FACET_LIMIT)
      .map(([t, count]) => ({ tag: t, count }));

    // 内存过滤（扫描产物本就是全量元数据，无额外 IO）
    let filtered = all;
    const kwLower = keyword.trim().toLowerCase();
    if (kwLower !== '') {
      filtered = filtered.filter((doc) =>
        [doc.fileName, doc.title, doc.keywords, doc.summary, doc.applicable].some((v) => (v ?? '').toLowerCase().includes(kwLower)));
    }
    const tagLower = tag.trim().toLowerCase();
    if (tagLower !== '') {
      filtered = filtered.filter((doc) => splitKeywords(doc.keywords).some((t) => t.toLowerCase() === tagLower));
    }
    // last_verified 为空的文档不命中验证时间筛选（「筛已验证过的」语义）
    if (verifiedFrom !== '') filtered = filtered.filter((doc) => doc.lastVerified !== '' && doc.lastVerified >= verifiedFrom);
    if (verifiedTo !== '') filtered = filtered.filter((doc) => doc.lastVerified !== '' && doc.lastVerified <= verifiedTo);
    if (updatedFrom !== '') filtered = filtered.filter((doc) => beijingDateOf(doc.updatedAt) >= updatedFrom);
    if (updatedTo !== '') filtered = filtered.filter((doc) => beijingDateOf(doc.updatedAt) <= updatedTo);
    if (abnormal === 'no-title') {
      filtered = filtered.filter((doc) => doc.title === '');
    } else if (abnormal === 'no-frontmatter') {
      filtered = filtered.filter((doc) =>
        doc.title === '' && doc.keywords === '' && doc.summary === '' && doc.applicable === '' && doc.lastVerified === '');
    }

    const sorted = sortDocs(filtered, sort, order);
    const total = sorted.length;
    const docs = sorted.slice((page - 1) * size, page * size);

    // 分组计数：过滤后全量口径（组头计数不受分页影响）
    let groupCounts: Array<{ key: string; count: number }> = [];
    if (groupBy !== 'none') {
      const counts = new Map<string, number>();
      for (const doc of filtered) {
        const key = groupKeyOf(doc, groupBy);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      groupCounts = sortGroupCounts([...counts.entries()].map(([key, count]) => ({ key, count })), groupBy);
    }

    return sendOk(reply, { enabled, total, page, size, docs, groupCounts, keywords });
  });

  app.get('/v1/agents/:id/experience-library/index', async (request, reply) => {
    requireUserId(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    return sendOk(reply, experienceIndexService.readIndex(agentDir));
  });

  app.get('/v1/agents/:id/experience-library/docs/content', async (request, reply) => {
    requireUserId(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    const fileName = requireDocFileName((request.query as Record<string, unknown>).file);
    const content = experienceIndexService.readDoc(agentDir, fileName);
    if (content == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `经验文档不存在: ${fileName}`);
    }
    return sendOk(reply, { fileName, content });
  });

  app.put('/v1/agents/:id/experience-library/docs/content', async (request, reply) => {
    await requireAgentWrite(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    const body = bodyOf<SaveDocRequest>(request);
    const fileName = requireDocFileName(body.fileName);
    if (fileName.toLowerCase() === 'index.md') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'INDEX.md 由系统自动生成，不能直接编辑');
    }
    if (body.content == null || typeof body.content !== 'string') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'content 不能为空');
    }
    let bytes: number;
    try {
      bytes = experienceIndexService.writeDoc(agentDir, fileName, body.content);
    } catch (e) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, (e as Error).message);
    }
    return sendOk(reply, { fileName, bytes });
  });

  app.delete('/v1/agents/:id/experience-library/docs', async (request, reply) => {
    await requireAgentWrite(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    const fileName = requireDocFileName((request.query as Record<string, unknown>).file);
    if (fileName.toLowerCase() === 'index.md') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'INDEX.md 由系统自动生成，不能删除');
    }
    try {
      experienceIndexService.deleteDoc(agentDir, fileName);
    } catch (e) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, (e as Error).message);
    }
    return sendOk(reply);
  });

  app.post('/v1/agents/:id/experience-library/index/rebuild', async (request, reply) => {
    await requireAgentWrite(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    experienceIndexService.rebuild(agentDir);
    return sendOk(reply);
  });
}
