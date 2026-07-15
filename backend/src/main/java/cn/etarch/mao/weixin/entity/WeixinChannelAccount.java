package cn.etarch.mao.weixin.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("weixin_channel_account")
public class WeixinChannelAccount {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private String accountId;

    private String payloadJson;

    private String getUpdatesBuf;

    private Integer enabled;

    @TableLogic
    private Integer deleted;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}