import type * as Lark from '@larksuiteoapi/node-sdk';

export interface FeishuDocLink {
  type: string;
  token: string;
}

/**
 * 解析飞书云文档链接，提取文档类型与 token。
 * 兼容 access.feishu.cn 与租户子域（xxx.feishu.cn），query 部分（如多维表格 table/view）忽略。
 */
export function parseFeishuDocLink(link: string): FeishuDocLink | null {
  const match = /^https:\/\/[\w-]*\.?feishu\.cn\/(\w+)\/([\w-]+)(\?.*)?$/.exec(link.trim());
  if (match == null) return null;
  return { type: match[1], token: match[2] };
}

/**
 * 读取飞书云文档正文（Markdown）。
 * wiki 链接先通过 get_node 换取底层文档 obj_token；docx/base 直接使用链接 token。
 * 末尾追加引导语，提示 Agent 可继续读取关联文档。
 */
export async function readFeishuDocMarkdown(client: Lark.Client, link: string): Promise<string> {
  const parsed = parseFeishuDocLink(link);
  if (parsed == null) throw new Error(`当前文档链接不是飞书云文档链接，无法读取：【${link}】`);
  let docToken = parsed.token;
  if (parsed.type === 'wiki') {
    docToken = await wikiTokenToObjToken(client, docToken);
  } else if (parsed.type !== 'docx' && parsed.type !== 'base') {
    throw new Error(`当前文档类型【${parsed.type}】暂不支持读取`);
  }
  if (docToken == null || docToken === '') throw new Error(`当前文档链接不是飞书云文档链接，无法读取：【${link}】`);
  const response = await client.request<{ code?: number; msg?: string; data?: { content?: string } }>({
    url: '/open-apis/docs/v1/content',
    method: 'GET',
    params: { doc_token: docToken, doc_type: 'docx', content_type: 'markdown' },
  });
  if (Number(response.code ?? 0) !== 0) {
    throw new Error(`读取云文档失败 > token: ${docToken}, msg: ${JSON.stringify(response)}`);
  }
  return (response.data?.content ?? '') + '\n* 注意：如果以上内容无法解答用户的问题，可以继续读取关联的其他文档。';
}

async function wikiTokenToObjToken(client: Lark.Client, wikiToken: string): Promise<string> {
  const response = await client.request<{ code?: number; data?: { node?: { obj_token?: string } } }>({
    url: '/open-apis/wiki/v2/spaces/get_node',
    method: 'GET',
    params: { token: wikiToken },
  });
  // 转换失败（权限/节点不存在等）降级返回原 token，由后续内容接口给出明确错误。
  if (Number(response.code ?? 0) !== 0) return wikiToken;
  return response.data?.node?.obj_token ?? wikiToken;
}
