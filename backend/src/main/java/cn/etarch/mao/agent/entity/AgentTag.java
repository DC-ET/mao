package cn.etarch.mao.agent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

@Data
@TableName("agent_tag")
public class AgentTag {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long agentId;

    private String tag;
}
