---
name: git-workflow
description: Git 工作流规范与最佳实践
---

# Git 工作流规范

## 分支策略

- `main` — 生产分支，始终保持可部署状态
- `develop` — 开发分支，集成各功能分支
- `feature/*` — 功能分支，从 develop 创建
- `hotfix/*` — 紧急修复，从 main 创建

## Commit Message 规范

使用 Conventional Commits 格式：

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Type 类型

- `feat`: 新功能
- `fix`: 修复 bug
- `docs`: 文档变更
- `style`: 代码格式（不影响逻辑）
- `refactor`: 重构
- `perf`: 性能优化
- `test`: 测试相关
- `chore`: 构建/工具变更

## Pull Request 规范

1. PR 标题遵循 Commit Message 格式
2. 描述中说明变更原因和内容
3. 关联相关 Issue
4. 确保 CI 通过后再合并
5. 使用 Squash Merge 保持主分支历史清晰

## 代码审查要点

- 逻辑正确性
- 边界条件处理
- 安全性（SQL 注入、XSS 等）
- 性能影响
- 测试覆盖率
