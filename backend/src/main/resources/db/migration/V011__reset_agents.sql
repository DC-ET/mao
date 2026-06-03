-- V011: 清理现有Agent数据，初始化运营智能体和数分智能体

-- 设置字符集为UTF-8
SET NAMES utf8mb4;
SET CHARACTER SET utf8mb4;

-- ========== 1. 清理Agent相关数据 ==========

-- 清除Agent关联数据（按外键依赖顺序）
DELETE FROM `agent_mcp_config`;
DELETE FROM `agent_tag`;

-- 清除会话和消息（依赖Agent）
DELETE FROM `session_activity`;
DELETE FROM `message`;
DELETE FROM `session`;

-- 清除Agent工具关联
DELETE FROM `agent_tool`;

-- 最后清除Agent主表
DELETE FROM `agent`;

-- 重置自增ID
ALTER TABLE `agent` AUTO_INCREMENT = 1;
ALTER TABLE `agent_tag` AUTO_INCREMENT = 1;
ALTER TABLE `agent_tool` AUTO_INCREMENT = 1;
ALTER TABLE `session` AUTO_INCREMENT = 1;
ALTER TABLE `message` AUTO_INCREMENT = 1;

-- ========== 2. 插入新Agent数据 ==========

-- 获取admin用户ID（假设为1）
-- 获取默认模型ID（假设为1）

-- 运营智能体
INSERT INTO `agent` (
    `name`,
    `description`,
    `system_prompt`,
    `model_id`,
    `creator_id`,
    `created_at`,
    `updated_at`
) VALUES (
    '运营智能体',
    '专注于运营数据分析、用户增长、活动效果评估的AI助手。能够分析运营指标、生成报表、提供优化建议。',
    '你是一个专业的运营数据分析助手。

## 角色定位
- 专注于运营数据分析和业务洞察
- 擅长用户增长分析、留存分析、转化漏斗分析
- 能够评估活动效果并提供优化建议

## 能力范围
1. 运营指标分析：DAU/MAU、留存率、转化率等
2. 用户行为分析：用户画像、行为路径、活跃度
3. 活动效果评估：ROI、参与度、拉新效果
4. 报表生成：日报、周报、专题分析报告

## 工作方式
- 使用数据查询工具获取数据
- 通过数据分析得出洞察
- 提供可执行的优化建议
- 生成清晰的可视化报表

## 输出规范
- 数据结论需有明确的数据支撑
- 建议需具备可操作性
- 使用图表辅助说明数据趋势',
    3,  -- Access GPT-5.4 模型
    1,
    NOW(),
    NOW()
);

-- 数分智能体
INSERT INTO `agent` (
    `name`,
    `description`,
    `system_prompt`,
    `model_id`,
    `creator_id`,
    `created_at`,
    `updated_at`
) VALUES (
    '数分智能体',
    '专注于数据提取、SQL查询、数据建模的AI助手。能够帮助用户从数据库中提取数据、编写复杂查询、进行数据探索。',
    '你是一个专业的数据分析助手。

## 角色定位
- 专注于数据提取和SQL查询
- 擅长数据建模和数据探索
- 能够将业务需求转化为数据查询

## 能力范围
1. SQL查询编写：复杂查询、多表关联、窗口函数
2. 数据提取：按业务需求从数据库提取数据
3. 数据探索：数据质量检查、异常值检测、分布分析
4. 数据建模：维度建模、指标体系设计

## 工作方式
- 理解业务需求，转化为数据需求
- 编写高效的SQL查询语句
- 验证数据准确性和完整性
- 提供数据字典和说明文档

## 输出规范
- SQL语句需添加必要注释
- 复杂查询需分步骤拆解说明
- 提供查询结果的解读说明
- 标注数据口径和计算逻辑',
    3,  -- Access GPT-5.4 模型
    1,
    NOW(),
    NOW()
);

-- ========== 3. 为Agent添加标签 ==========

-- 运营智能体标签
INSERT INTO `agent_tag` (`agent_id`, `tag`) VALUES
(1, '运营'),
(1, '数据分析'),
(1, '用户增长'),
(1, '活动评估');

-- 数分智能体标签
INSERT INTO `agent_tag` (`agent_id`, `tag`) VALUES
(2, '数据提取'),
(2, 'SQL'),
(2, '数据建模'),
(2, '数据探索');

-- ========== 4. 为Agent配置工具 ==========

-- tool表已废弃（V024），工具通过 ToolRegistry 自动发现，无需 agent_tool 关联

