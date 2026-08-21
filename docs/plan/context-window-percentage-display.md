# 上下文窗口占比显示技术方案

## 1. 需求背景

当前客户端右侧边栏的上下文显示只显示当前已使用的token数量（如"上下文 12.3k"），没有显示模型的最大窗口限制。用户无法直观了解当前上下文使用占比，难以判断是否需要压缩上下文或清理历史消息。

## 2. 需求描述

### 2.1 功能目标
在右侧边栏的上下文显示中添加占比信息，让用户直观了解当前上下文使用情况。

### 2.2 具体需求
1. **显示格式**：
   - 默认显示：百分比格式（如"上下文 9.6%"）
   - 鼠标悬停：显示详细信息（如"12.3k/128k"）

2. **交互方式**：
   - 纯文本显示，不添加可视化进度条
   - 保持现有context-badge的位置和样式

3. **数据来源**：
   - 后端通过WebSocket `context_window`事件推送已用token数量
   - 前端根据session中的modelId主动查询模型的最大窗口限制
   - 两种方式结合确保数据实时性和准确性

4. **更新时机**：
   - 实时更新，每次收到`context_window`事件时都更新占比

5. **错误处理**：
   - 如果模型没有配置contextWindowTokens（理论上不会发生），回退到当前行为，只显示已用token数量

## 3. 技术选型

### 3.1 前端技术
- **Vue 3 Composition API**：使用现有的`<script setup>`语法
- **TypeScript**：严格类型检查
- **Element Plus**：UI组件库（现有项目已使用）

### 3.2 后端技术
- **Spring Boot**：现有后端框架
- **MyBatis-Plus**：数据库ORM
- **WebSocket**：实时通信

### 3.3 数据存储
- **MySQL**：存储模型配置（contextWindowTokens字段已存在）

## 4. 实现步骤

### 4.1 后端改动

#### 4.1.1 确保模型API返回contextWindowTokens
- 检查`ModelController`的`getModel`方法是否已返回`contextWindowTokens`字段
- 确保`ModelVO`包含`contextWindowTokens`字段

#### 4.1.2 WebSocket事件扩展（可选）
- 当前`context_window`事件只包含`estimated`和`actual`字段
- 可以考虑在事件中添加`maxTokens`字段，但会增加后端复杂度
- **决定**：不修改WebSocket事件格式，由前端主动查询模型信息

### 4.2 前端改动

#### 4.2.1 扩展ContextWindowInfo类型
```typescript
// desktop/src/types/chat.ts
export interface ContextWindowInfo {
  estimated: number
  actual: number
  maxTokens?: number  // 新增：模型最大窗口限制
}
```

#### 4.2.2 创建模型信息查询composable
```typescript
// desktop/src/composables/useModelContext.ts
import { ref, watch, type Ref } from 'vue'
import { api } from '../api'

export function useModelContext(modelId: Ref<number | undefined | null>) {
  const maxTokens = ref<number | null>(null)
  const loading = ref(false)
  let fetchGeneration = 0

  async function fetchModelContext(id: number) {
    if (!id) {
      maxTokens.value = null
      return
    }
    const generation = ++fetchGeneration
    loading.value = true
    try {
      const { data } = await api.get(`/models/${id}`)
      if (generation !== fetchGeneration) return
      maxTokens.value = data?.contextWindowTokens || null
    } catch {
      if (generation !== fetchGeneration) return
      maxTokens.value = null
    } finally {
      if (generation === fetchGeneration) {
        loading.value = false
      }
    }
  }

  watch(modelId, (newId) => {
    if (newId) {
      fetchModelContext(newId)
    } else {
      fetchGeneration++
      maxTokens.value = null
      loading.value = false
    }
  }, { immediate: true })

  return {
    maxTokens,
    loading,
    fetchModelContext
  }
}
```

#### 4.2.3 修改TaskInspector组件
1. 引入新的composable
2. 计算占比百分比
3. 修改contextDisplay的显示逻辑
4. 添加tooltip显示详细信息

### 4.3 样式调整
- 保持现有context-badge的样式
- 添加tooltip样式（使用Element Plus的el-tooltip组件）

## 5. 落地清单

### 5.1 必须实现的功能
1. ✅ 后端模型API已返回contextWindowTokens字段
2. ✅ 前端ContextWindowInfo类型扩展
3. ✅ 创建useModelContext composable查询模型最大窗口限制
4. ✅ 修改TaskInspector组件显示占比百分比
5. ✅ 添加鼠标悬停显示详细信息（分子/分母）
6. ✅ 处理模型没有配置contextWindowTokens的情况（回退到只显示分子）

### 5.2 不实现的功能
1. ❌ 不添加可视化进度条
2. ❌ 不修改WebSocket事件格式
3. ❌ 不显示原始token数值（只显示格式化后的数值）
4. ❌ 不修改context-badge的位置和基本样式

### 5.3 测试验证
1. 验证占比计算正确性
2. 验证鼠标悬停tooltip显示
3. 验证模型没有配置contextWindowTokens时的回退行为
4. 验证实时更新功能

## 6. 风险评估

### 6.1 技术风险
- **低风险**：前端查询模型API可能增加网络请求，但模型信息变化不频繁，可以接受
- **低风险**：tooltip在不同屏幕尺寸下的显示可能需要调整

### 6.2 兼容性风险
- **无风险**：不修改现有API和WebSocket事件格式，完全向后兼容

## 7. 实施计划

### 7.1 开发阶段
1. 前端类型扩展和composable开发（0.5天）
2. TaskInspector组件修改（0.5天）
3. 样式调整和tooltip实现（0.5天）

### 7.2 测试阶段
1. 功能测试（0.5天）
2. 兼容性测试（0.5天）

### 7.3 部署阶段
1. 后端无需改动
2. 前端构建和部署（0.5天）

**总工时**：约2.5天

## 8. 相关文件

### 8.1 需要修改的文件
1. `desktop/src/types/chat.ts` - 扩展ContextWindowInfo类型
2. `desktop/src/composables/useModelContext.ts` - 新建composable
3. `desktop/src/components/task/TaskInspector.vue` - 修改上下文显示逻辑

### 8.2 参考文件
1. `backend/src/main/java/cn/etarch/mao/model/controller/ModelController.java` - 模型API
2. `desktop/src/composables/useStreamWS.ts` - WebSocket事件处理
3. `desktop/src/stores/session.ts` - session store

## 9. 总结

本方案通过前端查询模型配置和WebSocket实时推送相结合的方式，实现了上下文窗口占比的显示功能。方案改动范围小，风险低，完全向后兼容，能够在不修改后端的情况下快速实现需求。