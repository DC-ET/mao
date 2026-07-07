package cn.etarch.mao.auth.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("feishu_oauth_state")
public class FeishuOauthState {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String state;

    private String status;

    private Long userId;

    private String errorMessage;

    private LocalDateTime expiresAt;

    private LocalDateTime consumedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
