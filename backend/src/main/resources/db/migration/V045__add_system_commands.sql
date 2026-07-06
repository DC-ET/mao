-- 系统预置快捷指令（user_id = 0），所有用户可用，不可编辑或删除

INSERT INTO `user_command` (`user_id`, `name`, `content`)
SELECT 0, 'review', 'Review当前git工作区下未提交的代码，找出本轮变更引入的潜在bug。（不必过于苛刻，确保业务功能正确即可）

你只负责审查代码，不负责修复代码。
如果发现bug不要直接动手修复，而是整理为清单列举出来。'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `user_command` WHERE `user_id` = 0 AND `name` = 'review');

INSERT INTO `user_command` (`user_id`, `name`, `content`)
SELECT 0, 'codebase', '基于当前工作区执行任务或解答问题。'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `user_command` WHERE `user_id` = 0 AND `name` = 'codebase');

INSERT INTO `user_command` (`user_id`, `name`, `content`)
SELECT 0, 'commit_and_push', '检查当前工作区中是否有未提交的代码。
如果有则分析代码，生成完整的中文的commit message 并提交。

最后将本地提交的代码推送到远程仓库。'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `user_command` WHERE `user_id` = 0 AND `name` = 'commit_and_push');

INSERT INTO `user_command` (`user_id`, `name`, `content`)
SELECT 0, 'plan', '请你基于当前工作区的项目代码，结合我的需求帮我整理一份需求实现对应的技术方案文档（包含需求背景、描述、技术选型、实现步骤、落地清单等模块），文档不要写"xxx功能可选"这种模糊表述，写清楚哪些是要做的，哪些是不做的。
如果我对需求描述不够清晰，请你通过 ask_user_questions 工具向我提出进一步的需求确认。
如果这个需求在技术实现方面有多种不同的方案，或者有一些重要的决策点需要明确，也通过 ask_user_questions 工具与我沟通。
最终目标是将方案文档输出为 markdown 文件，暂时不改动代码。

---我的需求如下---

'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `user_command` WHERE `user_id` = 0 AND `name` = 'plan');
