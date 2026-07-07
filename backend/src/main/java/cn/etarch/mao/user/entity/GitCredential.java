package cn.etarch.mao.user.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("user_git_credential")
public class GitCredential {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private String domain;

    /** AES-encrypted ciphertext */
    private String accessToken;

    private String description;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
