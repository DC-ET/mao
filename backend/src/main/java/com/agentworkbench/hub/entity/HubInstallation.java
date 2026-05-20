package com.agentworkbench.hub.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("hub_installation")
public class HubInstallation {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private Long agentId;

    private LocalDateTime installedAt;
}
