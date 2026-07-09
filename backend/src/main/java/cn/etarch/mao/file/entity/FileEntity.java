package cn.etarch.mao.file.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("file")
public class FileEntity {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String originalName;

    private String storedName;

    private String filePath;

    private Long fileSize;

    private String mimeType;

    private Long uploaderId;

    private Long sessionId;

    /** Logical deletion flag: 0=normal, 1=deleted */
    @TableLogic
    private Integer deleted;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
