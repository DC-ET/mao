# mao-skill-bundle v1 格式契约

技能的独立搬运格式。纯文本、隐藏路径段丢弃、路径穿越拒绝、总量不超过 10MB。

```json
{
  "format": "mao-skill-bundle",
  "formatVersion": 1,
  "exportedAt": "2026-10-05T00:00:00Z",
  "skill": { "name": "code-review", "description": "..." },
  "files": { "SKILL.md": "...", "scripts/run.md": "..." },
  "warnings": ["binary file skipped: assets/logo.bin"]
}
```

- `SKILL.md` 必须存在且通过 `validateSkillMd`（frontmatter `name` 为 slug 且与 `skill.name` 一致，`description` 必填）。
- **files 为纯文本**：二进制文件（可执行脚本、图片等）导出即跳过并在 `warnings` 标注。含二进制资产的技能包不完整，导入后需手工补齐。
- 导出：`GET /api/v1/skill-bundles/:name`（系统技能需 `skill:read`；`?owner=<userId>` 导出用户技能，本人即可、他人需 `skill:read`），响应为 bundle JSON 本体 + attachment 头。同一用户有多个目录的 frontmatter 名相同则拒绝导出，并在错误里列出这些目录，不静默取第一个。
- 导入：`POST /api/v1/skill-bundle/import`（`skill:write`，两段式 `confirm=false` 预检 → `confirm=true` 落库），写入**系统技能目录**，同名系统技能 `exists-skip` 不覆盖；`SKILL.md` 缺失/校验失败/frontmatter 不一致/路径穿越/超限以 `action=invalid` 在报告中逐项返回。
- 导入端不识别的 `format` / `formatVersion` 报 `2001 参数校验失败`；`files` 值必须全为字符串。
