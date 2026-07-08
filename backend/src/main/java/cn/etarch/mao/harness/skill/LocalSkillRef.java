package cn.etarch.mao.harness.skill;

import lombok.Data;

/**
 * 桌面客户端本地未上传的 Skill 引用（来自 ~/.agents/skills，仅用于 LOCAL 模式任务）。
 * <p>
 * 由桌面端随 send_message / edit_and_resend 消息上报，仅存活于内存，不落库、不参与 CLOUD 同步。
 */
@Data
public class LocalSkillRef {

    /** Skill 名称（来自 SKILL.md frontmatter） */
    private String name;

    /** Skill 描述（来自 SKILL.md frontmatter） */
    private String description;

    /** 本地目录名（~/.agents/skills/{folderName}），用于拼接 Prompt 中的文件路径 */
    private String folderName;
}
