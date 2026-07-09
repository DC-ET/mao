package cn.etarch.mao.command.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("user_command")
public class UserCommand {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private String name;

    private String content;

    /** Logical deletion flag: 0=normal, 1=deleted */
    @TableLogic
    private Integer deleted;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
