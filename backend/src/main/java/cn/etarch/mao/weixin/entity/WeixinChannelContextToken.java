package cn.etarch.mao.weixin.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("weixin_channel_context_token")
public class WeixinChannelContextToken {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String accountId;

    private String wxUserId;

    private String token;

    @TableLogic
    private Integer deleted;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}