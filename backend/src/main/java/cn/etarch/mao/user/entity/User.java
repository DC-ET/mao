package cn.etarch.mao.user.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("user")
public class User {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String username;

    private String displayName;

    private String email;

    private String avatarUrl;

    private String passwordHash;

    private String feishuUserId;

    private Integer status;

    private LocalDateTime lastLoginAt;

    /** Logical deletion flag: 0=normal, 1=deleted */
    @TableLogic
    private Integer deleted;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
